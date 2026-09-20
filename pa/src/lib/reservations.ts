/**
 * Multi-session coordination — explicit path/logical-resource reservations.
 *
 * Reuses blackboard.ts's PATTERN (file-backed JSON + proper-lockfile), not
 * its store: blackboard's liveness model is "the holding PID is alive",
 * which was wrong for the original claims — a `pa claim` invocation is a
 * short-lived process that exits within a second, so a PID-liveness check
 * would drop the reservation instantly. Reservations use an expiresAt TTL
 * instead. (AI-255 B4: `pa claim` now resolves and stores the SESSION pid —
 * the long-lived ancestor process, not its own — so reservation-gc CAN
 * dead-owner sweep rows that carry `pid`; rows without one remain TTL-only.)
 *
 * Advisory only (Git LFS / Perforce / SVN precedent: mandatory locking's
 * dominant real-world failure is the abandoned lock, not the contended
 * one). See the 2026-08-05 multi-session safety plan §4.5.
 */

import { randomBytes } from 'crypto';
import { dirname, join } from 'path';
import fs from 'fs-extra';
import lockfile from 'proper-lockfile';
import { paHome } from '../paths.js';
import { safeLockOptions } from './safe-lock.js';
import { log } from './log.js';
import { writeJsonAtomic } from './atomic-write.js';
import { withBoundedQueue } from './stall.js';
import { isProcessAlive } from '../worker-pids.js';

export interface Reservation {
  id: string;          // "r-" + 8 hex
  paths: string[];     // normalized repo-relative, forward slashes; or "@<logical>"
  session: string;     // human label, e.g. "claude-voice-refactor"
  note: string;        // what the session is doing — shown to whoever collides
  claimedAt: string;   // ISO 8601 UTC
  expiresAt: string;   // ISO 8601 UTC
  /** 'planned' rows declare intent without blocking (AI-255 B2): a work
   * package's fileset can be disclosed before a builder dispatches — the
   * "pending WPs held the real overlaps" incident ran blind because claims
   * only showed IN-FLIGHT work. Never counted as a claim conflict; a
   * same-session claim that fully covers a planned row's paths absorbs it. */
  kind?: 'planned';
  /** The claimant's bus address (provider@repo#n) — makes a claim answerable:
   *  collide with it and you know exactly where to send a message. */
  bus?: string;
  /** Owning process id when known (hook-registered session pid, worker pid).
   *  Lets the GC sweep reservations whose owner died before the TTL ran out. */
  pid?: number;
  /** PA_WORKER_DISPATCH_ID of the dispatch that claimed this — the
   *  worker-exec done() funnel auto-releases on dispatch settlement. */
  dispatchId?: string;
  /** Bot task/thread id whose executor claimed this — terminal transitions
   *  release it (AI-255 B4: reservations outliving their work). */
  taskId?: string;
}

export interface ReleasedReservation {
  id: string;
  paths: string[];
  session: string;
  note: string;
  claimedAt: string;   // ISO 8601 UTC — when the reservation was originally claimed.
  releasedAt: string;  // ISO 8601 UTC — when it was released.
  // AI-255: why the row left — 'released' is a deliberate release (manual or
  // lifecycle auto-release); 'dead-owner' means reservation-gc swept it
  // because the recorded owner pid no longer exists. Absent on rows written
  // before this field existed — treat as 'released'.
  reason?: 'released' | 'dead-owner';
}

export interface ReservationStore {
  reservations: Reservation[];
  /** Release ledger — entries older than RELEASE_LEDGER_TTL_MS are pruned. */
  released?: ReleasedReservation[];
}

/** Fresh ref-ID for a deferred or direct reservation log line. */
function newRefId(): string {
  return `s-${randomBytes(6).toString('hex')}`;
}

export interface ClaimOptions {
  paths: string[];
  session: string;
  note: string;
  /** Minutes, default 45, clamped to the 240-minute hard max. */
  ttlMinutes?: number;
  /** Claim over a conflict anyway; the conflict is still logged with a ref-ID. */
  force?: boolean;
  /** 'planned' — declare the fileset without blocking (see Reservation.kind). */
  kind?: 'planned';
  /** Claimant's bus address — auto-filled from PA_BUS_ADDRESS by the CLI. */
  bus?: string;
  /** Owning pid — enables the GC dead-owner sweep. */
  pid?: number;
  /** Owning dispatch — auto-filled from PA_WORKER_DISPATCH_ID by the CLI. */
  dispatchId?: string;
  /** Owning bot task/thread id — terminal executor transitions release it. */
  taskId?: string;
  /** Injectable clock for tests. Defaults to Date.now(). */
  now?: number;
}

export interface ClaimResult {
  ok: boolean;
  reservation?: Reservation;
  conflicts?: Reservation[];
  /** Other sessions' PLANNED rows overlapping the claim — advisory only,
   *  never blocks. The CLI prints them as "planned by" warnings. */
  plannedConflicts?: Reservation[];
}

export interface ReleaseOptions {
  /** Release exactly this reservation. Takes priority over `session` if both are set. */
  id?: string;
  /** Release every reservation held by this session. */
  session?: string;
  /** Release every reservation carrying this dispatch id (worker settlement). */
  dispatchId?: string;
  /** Release every reservation carrying this task id (bot terminal transition). */
  taskId?: string;
  /** Logging-only: marks this release as a forced override of another session's ownership. */
  force?: boolean;
  /** Logging-only: the session that owned the reservation being force-released. */
  ownerSession?: string;
  /** Logging-only: the session performing the forced release. */
  bySession?: string;
  /** Injectable clock for tests. Defaults to Date.now(). */
  now?: number;
}

export const DEFAULT_TTL_MINUTES = 45;
export const MAX_TTL_MINUTES = 240;
/** How long a release-ledger entry survives before it is pruned (6h). */
export const RELEASE_LEDGER_TTL_MS = 6 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

export function reservationsPath(): string {
  return join(paHome(), 'reservations.json');
}

/**
 * Normalize a claim path: backslashes to forward slashes, strip a leading
 * `./` and trailing `/`, reject absolute paths and `..` escapes. A path
 * starting with `@` is a logical resource (e.g. "@build") and is returned
 * unchanged — it can never collide with a filesystem path.
 */
export function normalizePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('reservation path must be a non-empty string');
  }

  if (input.startsWith('@')) {
    if (input.length < 2) {
      throw new Error(`invalid logical resource: "${input}"`);
    }
    return input;
  }

  let p = input.replace(/\\/g, '/');
  p = p.replace(/^(\.\/)+/, '');
  p = p.replace(/\/+$/, '');

  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
    throw new Error(`reservation path must be repo-relative, not absolute: "${input}"`);
  }

  if (p.split('/').some((segment) => segment === '..')) {
    throw new Error(`reservation path escapes the repo root: "${input}"`);
  }

  if (p === '' || p === '.') {
    throw new Error(`reservation path must not be empty: "${input}"`);
  }

  return p;
}

/**
 * Two normalized paths overlap iff one is the other, or one is a path
 * prefix of the other at a `/` boundary. Deliberately NOT a raw
 * string-prefix check: "pa/src/a.ts" vs "pa/src/ab.ts" must be false.
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return b.startsWith(a + '/') || a.startsWith(b + '/');
}

function clampTtlMinutes(ttlMinutes: number | undefined): number {
  const v = ttlMinutes ?? DEFAULT_TTL_MINUTES;
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_TTL_MINUTES;
  return Math.min(v, MAX_TTL_MINUTES);
}

async function ensureFile(path: string): Promise<void> {
  let exists = await fs.pathExists(path);
  if (exists) {
    try {
      const stats = await fs.stat(path);
      if (stats.size === 0) exists = false;
    } catch {
      exists = false;
    }
  }

  if (!exists) {
    await fs.ensureDir(dirname(path));
    try {
      await fs.writeJson(path, { reservations: [] }, { flag: 'wx' });
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

async function readStore(path: string): Promise<ReservationStore> {
  try {
    const data = await fs.readJson(path);
    if (!data || !Array.isArray(data.reservations)) return { reservations: [] };
    return data;
  } catch (err) {
    // Direct (not deferred) — a read-side recovery decision, not a mutate-outcome
    // claim; it fires for the read-only callers too, which never go through mutate.
    log('error', 'reservations', 'store unreadable — resetting to empty', {
      refId: `s-${randomBytes(6).toString('hex')}`,
      path,
      error: String(err),
    });
    return { reservations: [] };
  }
}

/** One log line a mutate fn wants written, returned as DATA instead of being
 * logged in place (AI-177): mutate flushes them only AFTER writeJsonAtomic has
 * succeeded, still inside the lock. A "claim granted" line can therefore never
 * precede a store write that failed. */
interface DeferredLog {
  level: 'info' | 'warn' | 'error';
  message: string;
  context: Record<string, unknown>;
}

interface MutateResult<T> {
  result: T;
  logEntries: DeferredLog[];
}

/** Marks an error routed out of onCompromised so the retry can tell a lock
 * compromise apart from any other failure. */
type TaggedErr = Error & { compromised?: boolean };

/** Settle time before the single compromise retry (AI-177). */
export const COMPROMISE_RETRY_DELAY_MS = 1_000;

/**
 * Read-modify-write a fresh copy of the store under the file lock. `fn`
 * mutates `store` in place (or reassigns `store.reservations`) and returns its
 * outcome PLUS its log lines as data ({@link MutateResult}) — `fn` itself must
 * have no side effects, so that (a) the grant/deny log can be flushed only
 * after the store write has committed (AI-177), and (b) the compromise retry
 * below can safely re-run `fn` against a freshly-read store.
 * Whatever `fn` returns as `result` becomes the lock's result. The store is
 * always written back, even when `fn` reports a logical failure (e.g. a
 * conflict) — this keeps the write unconditional and the accept/reject
 * decision purely in `fn`.
 *
 * The file lock is acquired under `compromisedPolicy: 'fail'`: a lock the
 * heartbeat judged compromised REJECTS this mutate (after one retry, below)
 * instead of silently continuing unsynchronized — a read-modify-write store
 * must not write unsynchronized. The rejection routing is deliberately NOT a
 * throw from onCompromised: proper-lockfile invokes it inside an mtime-update
 * timer callback, where a throw is an uncaught exception that kills the
 * process (the AI-096 crash class).
 *
 * In-process calls are additionally serialized through `withBoundedQueue` (lib/stall.ts) before
 * ever touching proper-lockfile (the same bounded queue log.ts uses).
 * proper-lockfile's own retry/backoff is built for cross-process contention
 * (~1s-then-exponential) and is far too slow for N same-process calls
 * racing the same mkdir-based lock — that races each other into ELOCKED and
 * pays a multi-second backoff instead of just waiting their turn.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mutate<T>(fn: (store: ReservationStore) => MutateResult<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const path = reservationsPath();
    await ensureFile(path);

    const attempt = (): Promise<T> =>
      new Promise<T>((resolveAttempt, rejectAttempt) => {
        const opts = safeLockOptions(
          'reservations',
          {
            retries: 5,
            onCompromised: (err: Error) => {
              // Route the compromise to THIS attempt's rejection. Never throw
              // from here — timer context (see safe-lock.ts's header, AI-096).
              (err as TaggedErr).compromised = true;
              rejectAttempt(err);
            },
          },
          { compromisedPolicy: 'fail' }
        );
        lockfile
          .lock(path, opts)
          .then(async (release) => {
            try {
              const store = await readStore(path);
              // fn is side-effect-free (its log lines come back as data), so a
              // compromise retry can safely re-run it against a fresh read.
              const { result, logEntries } = fn(store);
              await writeJsonAtomic(path, store, { spaces: 2 });
              // AI-177: flush the decision lines ONLY after the store write has
              // committed — still inside the lock, so a reader cannot observe the
              // new store state ahead of its "granted"/"denied" log line either.
              for (const entry of logEntries) {
                log(entry.level, 'reservations', entry.message, entry.context);
              }
              return result;
            } finally {
              // Cleanup only: the store write above has already committed (or the
              // section already failed), so a failing unlock must not turn a
              // settled outcome into a rejection ('fail' policy makes release
              // able to surface a compromise here).
              try {
                await release();
              } catch {
                /* cleanup-only */
              }
            }
          })
          .then(resolveAttempt, rejectAttempt);
      });

    try {
      return await attempt();
    } catch (err) {
      if ((err as TaggedErr)?.compromised !== true) throw err;
      // Compromised lock (heartbeat missed its stale threshold): settle briefly —
      // the competing writer's own heartbeat usually re-touches or exits — and
      // retry ONCE against a freshly-read store. A second compromise rethrows.
      await sleep(COMPROMISE_RETRY_DELAY_MS);
      return await attempt();
    }
  };

  return withBoundedQueue('reservations', run, { store: 'reservations', target: 'reservations.json' });
}

/** Live reservations EXCLUDING planned rows — this is the blocking set:
 *  what `pa claims`, the commit gate, and prompt renderers must treat as
 *  held work. A planned row declares intent only. */
export async function readActive(now: number = Date.now()): Promise<Reservation[]> {
  const path = reservationsPath();
  await ensureFile(path);
  const store = await readStore(path);
  return store.reservations.filter(
    (r) => new Date(r.expiresAt).getTime() > now && r.kind !== 'planned'
  );
}

/** Live planned rows — declared-but-unclaimed intent. Read by `pa claims`
 *  (own section) and by claim()'s soft planned-overlap warning. */
export async function readPlanned(now: number = Date.now()): Promise<Reservation[]> {
  const path = reservationsPath();
  await ensureFile(path);
  const store = await readStore(path);
  return store.reservations.filter(
    (r) => new Date(r.expiresAt).getTime() > now && r.kind === 'planned'
  );
}

export async function claim(opts: ClaimOptions): Promise<ClaimResult> {
  const now = opts.now ?? Date.now();
  const paths = opts.paths.map(normalizePath);
  const ttlMinutes = clampTtlMinutes(opts.ttlMinutes);

  return mutate((store): MutateResult<ClaimResult> => {
    const logEntries: DeferredLog[] = [];
    const active = store.reservations.filter((r) => new Date(r.expiresAt).getTime() > now);
    const overlaps = (r: Reservation): boolean =>
      paths.some((p) => r.paths.some((rp) => pathsOverlap(p, rp)));
    // Planned rows never block — they surface as advisory plannedConflicts so
    // the claimer learns the fileset was already scoped by another session.
    const conflicts = active.filter(
      (r) => r.kind !== 'planned' && r.session !== opts.session && overlaps(r)
    );
    const plannedConflicts = active.filter(
      (r) => r.kind === 'planned' && r.session !== opts.session && overlaps(r)
    );

    if (conflicts.length > 0 && !opts.force) {
      logEntries.push({
        level: 'warn',
        message: 'claim denied',
        context: {
          refId: newRefId(),
          session: opts.session,
          paths,
          conflicts: conflicts.map((c) => ({ id: c.id, session: c.session })),
        },
      });
      return { result: { ok: false, conflicts, plannedConflicts }, logEntries };
    }

    const reservation: Reservation = {
      id: `r-${randomBytes(4).toString('hex')}`,
      paths,
      session: opts.session,
      note: opts.note,
      claimedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMinutes * MINUTE_MS).toISOString(),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.bus ? { bus: opts.bus } : {}),
      ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
      ...(opts.dispatchId ? { dispatchId: opts.dispatchId } : {}),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
    };
    store.reservations.push(reservation);

    // A non-planned claim by the same session that FULLY covers one of its
    // own planned rows' paths absorbs it — the claim itself is now the
    // disclosure; the planned row would only shadow it. Coverage means
    // containment (claimed path is the planned path or its parent), not
    // either-direction overlap — a narrower claim must not absorb a broader
    // planned row and silently drop the uncovered intent.
    if (opts.kind !== 'planned') {
      const coveredBy = (plannedPath: string): boolean =>
        paths.some((p) => plannedPath === p || plannedPath.startsWith(p + '/'));
      store.reservations = store.reservations.filter((r) => {
        if (r === reservation || r.kind !== 'planned' || r.session !== opts.session) return true;
        return !r.paths.every(coveredBy);
      });
    }

    const forced = conflicts.length > 0 && !!opts.force;

    if (forced) {
      logEntries.push({
        level: 'warn',
        message: 'force-claim over active conflict',
        context: {
          refId: newRefId(),
          session: opts.session,
          newReservationId: reservation.id,
          paths,
          conflicts: conflicts.map((c) => ({ id: c.id, session: c.session, note: c.note })),
        },
      });
    }

    logEntries.push({
      level: 'info',
      message: 'claim granted',
      context: {
        refId: newRefId(),
        id: reservation.id,
        session: opts.session,
        paths,
        ttlMinutes,
        forced,
      },
    });

    return { result: { ok: true, reservation, plannedConflicts }, logEntries };
  });
}

/** Extend an existing reservation's expiresAt. Leaves claimedAt and id unchanged.
 * When `opts.session` is given it must match the row's owning session — a renewal
 * by anyone else is refused with null (AI-177: a renew is a WRITE to another
 * session's coordination row; the id alone is not an ownership proof). */
export async function renew(
  id: string,
  opts?: { ttlMinutes?: number; now?: number; session?: string }
): Promise<Reservation | null> {
  const now = opts?.now ?? Date.now();
  const ttlMinutes = clampTtlMinutes(opts?.ttlMinutes);

  return mutate((store) => {
    const logEntries: DeferredLog[] = [];
    const entry = store.reservations.find((r) => r.id === id);
    if (!entry) return { result: null, logEntries };

    if (opts?.session !== undefined && entry.session !== opts.session) {
      logEntries.push({
        level: 'warn',
        message: 'renew denied (owner mismatch)',
        context: {
          refId: newRefId(),
          id: entry.id,
          ownerSession: entry.session,
          requestedBy: opts.session,
        },
      });
      return { result: null, logEntries };
    }

    entry.expiresAt = new Date(now + ttlMinutes * MINUTE_MS).toISOString();
    logEntries.push({
      level: 'info',
      message: 'reservation renewed',
      context: {
        refId: newRefId(),
        id: entry.id,
        expiresAt: entry.expiresAt,
        renewedBy: opts?.session,
      },
    });
    return { result: entry, logEntries };
  });
}

export async function release(opts: ReleaseOptions): Promise<{ released: number }> {
  const result = await mutate((store) => {
    const now = opts.now ?? Date.now();
    const isMatch = (r: Reservation): boolean => {
      if (opts.id !== undefined) return r.id === opts.id;
      if (opts.dispatchId !== undefined) return r.dispatchId === opts.dispatchId;
      if (opts.taskId !== undefined) return r.taskId === opts.taskId;
      if (opts.session !== undefined) return r.session === opts.session;
      return false;
    };

    const before = store.reservations.length;
    const removed = store.reservations.filter(isMatch);
    store.reservations = store.reservations.filter((r) => !isMatch(r));

    if (removed.length > 0) {
      const releasedAt = new Date(now).toISOString();
      const newEntries: ReleasedReservation[] = removed.map((r) => ({
        id: r.id,
        paths: r.paths,
        session: r.session,
        note: r.note,
        claimedAt: r.claimedAt,
        releasedAt,
        reason: 'released',
      }));
      store.released = [...(store.released ?? []), ...newEntries];
    }

    const cutoff = now - RELEASE_LEDGER_TTL_MS;
    store.released = (store.released ?? []).filter((e) => new Date(e.releasedAt).getTime() > cutoff);

    return { result: { released: before - store.reservations.length }, logEntries: [] };
  });

  if (result.released > 0) {
    log('info', 'reservations', 'reservation released', {
      refId: newRefId(),
      id: opts.id,
      session: opts.session,
      dispatchId: opts.dispatchId,
      taskId: opts.taskId,
      // AI-177: who performed the release — the normal single-owner case leaves
      // this undefined; forced takeovers print the releasing session, keeping
      // every release greppable in app.log.jsonl.
      bySession: opts.bySession,
      releasedCount: result.released,
    });
    if (opts.force) {
      log('warn', 'reservations', "forced release of another session's reservation", {
        refId: newRefId(),
        id: opts.id,
        owner: opts.ownerSession,
        releasedBy: opts.bySession,
      });
    }
  }

  return result;
}

/** Drop every reservation whose expiresAt has passed. Returns the count removed. */
export async function gcExpired(now: number = Date.now()): Promise<number> {
  const removed = await mutate((store) => {
    const before = store.reservations.length;
    store.reservations = store.reservations.filter((r) => new Date(r.expiresAt).getTime() > now);
    const cutoff = now - RELEASE_LEDGER_TTL_MS;
    store.released = (store.released ?? []).filter((e) => new Date(e.releasedAt).getTime() > cutoff);
    return { result: before - store.reservations.length, logEntries: [] };
  });

  if (removed > 0) {
    log('info', 'reservations', 'reservations gc-expired', {
      refId: `s-${randomBytes(6).toString('hex')}`,
      removed,
    });
  }

  return removed;
}

/**
 * AI-255 B4: drop reservations whose recorded owner pid no longer exists.
 * Called by reservation-gc on its 5-minute cadence — not a hot path, so a
 * per-row signal-0 check needs no process snapshot.
 *
 * Fail-safe directions, all deliberate:
 *  - rows WITHOUT `pid` are skipped: absence of an owner marker is not
 *    evidence of death (older rows, manual CLI claims outside a session).
 *  - a pid REUSED by an unrelated process reads as alive and the row simply
 *    survives to TTL — we never strip live work's guard on a false positive.
 *  - AI-260 conjunct: a dead pid ALONE is not proof of a dead owner — the
 *    recorded pid can be a pre-restart host while the session lives on under
 *    the same bus address. A FRESH bus cursor on the row's `bus` vetoes the
 *    sweep (the hooks are still firing under a new pid). Rows whose bus has
 *    no cursor — or a stale one — shed as before. (A session re-incarnated
 *    under a NEW address is indistinguishable from a dead one; the TTL stays
 *    the bound for that hole.)
 *  - 2026-09-17 conjunct: a LIVE pid is not proof either — spawned contexts
 *    (subagents, `pa run --session` workers) and restarted session
 *    generations claim under their own bus identity, then end while the
 *    host pid lives on. When the SAME pid hosts a DIFFERENT bus address
 *    that is still firing a fresh cursor, the claimant's identity is
 *    provably superseded and the row sheds. A pid hosting nothing live
 *    (silent host, unregistered-provider sessions like agy) stays
 *    ambiguous → kept; the TTL bounds it.
 */
export async function sweepDeadOwners(now: number = Date.now()): Promise<number> {
  // Cursor freshness is async — compute the sweep set BEFORE the synchronous
  // mutate so the check runs outside the store lock.
  const path = reservationsPath();
  await ensureFile(path);
  const store = await readStore(path);
  const { readBusCursor, readBusRegistry, BUS_CURSOR_FRESH_MS } = await import('./bus-queue.js');
  const cursorFresh = (c: { last_event_at?: string } | null): boolean =>
    !!c?.last_event_at && now - Date.parse(c.last_event_at) < BUS_CURSOR_FRESH_MS;
  const registry = await readBusRegistry();
  const sweepableIds = new Set<string>();
  for (const r of store.reservations) {
    if (r.pid === undefined) continue;
    const cursor = r.bus ? await readBusCursor(r.bus).catch(() => null) : null;
    if (cursorFresh(cursor)) continue; // AI-260 veto — the claimant still fires
    if (!isProcessAlive(r.pid)) {
      sweepableIds.add(r.id);
      continue;
    }
    // Live pid, silent claimant: superseded only if this pid now hosts a
    // DIFFERENT live identity. `r.bus` itself still fresh was already kept
    // above; unregistered-host rows fall through to TTL.
    if (!r.bus) continue;
    for (const [addr, e] of Object.entries(registry)) {
      if (e.pid !== r.pid || addr === r.bus) continue;
      if (cursorFresh(await readBusCursor(addr).catch(() => null))) {
        sweepableIds.add(r.id);
        break;
      }
    }
  }
  if (sweepableIds.size === 0) return 0;

  const removed = await mutate((store) => {
    const dead = store.reservations.filter((r) => sweepableIds.has(r.id));
    if (dead.length === 0) return { result: 0, logEntries: [] };
    const deadIds = new Set(dead.map((r) => r.id));
    store.reservations = store.reservations.filter((r) => !deadIds.has(r.id));
    const releasedAt = new Date(now).toISOString();
    store.released = [
      ...(store.released ?? []),
      ...dead.map((r) => ({
        id: r.id,
        paths: r.paths,
        session: r.session,
        note: r.note,
        claimedAt: r.claimedAt,
        releasedAt,
        reason: 'dead-owner' as const,
      })),
    ];
    const cutoff = now - RELEASE_LEDGER_TTL_MS;
    store.released = store.released.filter((e) => new Date(e.releasedAt).getTime() > cutoff);
    return { result: dead.length, logEntries: [] };
  });

  if (removed > 0) {
    log('info', 'reservations', 'reservations dead-owner swept', {
      refId: `s-${randomBytes(6).toString('hex')}`,
      removed,
    });
  }
  return removed;
}

/**
 * Reservations released at or after `sinceMs`, still inside the release-ledger TTL.
 * A read, not a mutate — does not touch the file lock or the mutate queue.
 */
export async function readReleasedSince(
  sinceMs: number,
  now: number = Date.now()
): Promise<ReleasedReservation[]> {
  const path = reservationsPath();
  await ensureFile(path);
  const store = await readStore(path);
  const cutoff = now - RELEASE_LEDGER_TTL_MS;
  return (store.released ?? []).filter((e) => {
    const t = new Date(e.releasedAt).getTime();
    return t >= sinceMs && t > cutoff;
  });
}
