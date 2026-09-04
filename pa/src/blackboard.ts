import { join } from 'path';
import { randomBytes } from 'crypto';
import fs from 'fs-extra';
import lockfile from 'proper-lockfile';
import { paHome } from './paths.js';
import { safeLockOptions } from './lib/safe-lock.js';
import { log } from './lib/log.js';
import { writeJsonAtomic } from './lib/atomic-write.js';

export interface LockEntry {
  resource: string;
  agent: string;
  pid: number;
  heartbeat: string;
  contextId?: string;  // per-call execution context UUID; allows same-context nested re-entrancy
}

export interface BlackboardData {
  active_locks: LockEntry[];
}

const HEARTBEAT_STALE_MS = 10 * 60 * 1000; // 10 minutes (default)

// Bounded grace window added AFTER heartbeatStaleMs() before an ALIVE holder's
// row is actually evicted (2026-09-01, followup-defects Defect 1). Before this,
// staleness alone evicted a row regardless of liveness — a holder whose PID was
// still alive and working (renewal merely delayed by real contention: the
// shared blackboard.json file serializes EVERY concurrent heartbeat source —
// bot topic locks, catchup, skill runs — through one proper-lockfile lock, and
// a single acquireLock() from a completely different caller could then steal
// the resource in the same atomic write the instant staleMs was crossed) had
// its lock purged and immediately handed to a racing acquirer, then aborted
// mid-run when its own updateHeartbeat found its row gone ("Lock lost mid-run
// ... Reason: purged" — three real skill deaths on 2026-08-31, one on an idle
// machine). A dead PID still purges immediately; only an alive-but-stale
// holder gets this grace, and grace never opens a double-occupancy window
// (see classifyLock: a graced row stays IN activeLocks, so it still blocks any
// competing acquireLock for the same resource — see blackboard.test.ts).
const HEARTBEAT_GRACE_MS_DEFAULT = 3 * 60 * 1000; // 3 minutes

/**
 * Reads the stale-lock TTL fresh on every call from PA_HEARTBEAT_STALE_MS
 * (falls back to the 10-minute default) — so tests can shrink it instead of
 * waiting 10 real minutes, and an operator can tune it without a rebuild.
 */
function heartbeatStaleMs(): number {
  const raw = process.env.PA_HEARTBEAT_STALE_MS;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return HEARTBEAT_STALE_MS;
}

/** Same override pattern as heartbeatStaleMs() — PA_HEARTBEAT_GRACE_MS, tests
 *  shrink it; 0 is a valid override (no grace, restores pre-fix behaviour). */
function heartbeatGraceMs(): number {
  const raw = process.env.PA_HEARTBEAT_GRACE_MS;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return HEARTBEAT_GRACE_MS_DEFAULT;
}

// AI-179 (2026-09-03): outer retry ladder for heartbeat renewals. Delays
// BETWEEN attempts after the immediate first attempt, so the default
// "1000,5000,15000" is 4 attempts spanning ~21s — plus each attempt's own
// inner renameWithRetry (~0.85s), for ≈22s of total EPERM exposure. Read
// fresh per call, same pattern as heartbeatStaleMs(). Comma-separated
// integers ≥0; anything invalid or absent falls back to the default whole.
const HEARTBEAT_WRITE_RETRY_MS_DEFAULT = '1000,5000,15000';

function heartbeatWriteRetryDelaysMs(): number[] {
  const raw = process.env.PA_HEARTBEAT_WRITE_RETRY_MS;
  const source = raw && raw.trim() ? raw : HEARTBEAT_WRITE_RETRY_MS_DEFAULT;
  const parts = source.split(',').map((s) => s.trim());
  const usable = parts.length > 0 && parts.every((p) => /^\d+$/.test(p));
  return (usable ? parts : HEARTBEAT_WRITE_RETRY_MS_DEFAULT.split(',')).map((p) => parseInt(p, 10));
}

/**
 * Outcome of one full renewal attempt ladder (AI-179, 2026-09-03):
 * - `'updated'` — the row was found and its heartbeat written.
 * - `'row-absent'` — the store read fine but the row is genuinely gone.
 *   Never retried: no ladder can resurrect it.
 * - `'write-failed'` — the renewal could not complete (lock acquisition,
 *   store read, or atomic write threw through the whole ladder). Says
 *   NOTHING about whether the row still exists; callers must verify with
 *   {@link Blackboard.peekLockRow} before treating a loss as real.
 */
export type HeartbeatRenewOutcome = 'updated' | 'row-absent' | 'write-failed';

type LockDisposition = 'alive' | 'grace' | 'evict-dead' | 'evict-expired';

/**
 * Single decision point for whether a lock row still counts as held. Used by
 * acquireLock's purge, getActiveLocks, and purgeStaleLocks — previously each
 * had its own (subtly different) staleness check, which meant a row could be
 * "active" by one call's reckoning and "gone" by another's. Decision matrix:
 * dead PID -> evict now; alive + fresh -> alive; alive + stale but within
 * grace -> grace (still counts as held, blocks competing acquires, logged
 * once); alive + stale past grace -> evict.
 */
function classifyLock(lock: LockEntry, nowMs: number): LockDisposition {
  if (!isPidAlive(lock.pid)) return 'evict-dead';
  const age = nowMs - new Date(lock.heartbeat).getTime();
  const staleMs = heartbeatStaleMs();
  if (age <= staleMs) return 'alive';
  if (age <= staleMs + heartbeatGraceMs()) return 'grace';
  return 'evict-expired';
}

function envMs(varName: string): number | undefined {
  const raw = process.env[varName];
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function getBlackboardPath(): string {
  return join(paHome(), 'blackboard.json');
}

/**
 * Check if a PID is still alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // ESRCH means the process doesn't exist
    return err.code === 'EPERM'; // If we don't have permission, it's alive
  }
}

export class Blackboard {
  // Resolved fresh on every access rather than cached at construction: PA_HOME
  // can change within a single process (test suites with multiple temp-home
  // cycles; PA_HOME env overrides), and a cached path would silently keep
  // operating against a stale, possibly-deleted directory.
  private get path(): string {
    return getBlackboardPath();
  }

  // Dedupes the "entering grace" log line to once per (resource, heartbeat)
  // pair — the heartbeat value is frozen for the whole grace window (that's
  // WHY it's stale), so this key naturally logs exactly once per stale event,
  // never once per purge-check tick. Unbounded only in proportion to how many
  // distinct resources actually go stale over this process's lifetime, which
  // in practice is rare; not worth GC'ing for a long-lived CLI invocation.
  private graceLogged = new Set<string>();

  private logGraceOnce(lock: LockEntry, nowMs: number): void {
    const key = `${lock.resource}|${lock.heartbeat}`;
    if (this.graceLogged.has(key)) return;
    this.graceLogged.add(key);
    const age = nowMs - new Date(lock.heartbeat).getTime();
    console.log(`[blackboard] Stale heartbeat, holder alive — grace period: ${lock.resource} (age:${Math.round(age / 1000)}s, pid:${lock.pid})`);
  }

  private async ensureFile(): Promise<void> {
    let exists = await fs.pathExists(this.path);
    if (exists) {
      try {
        const stats = await fs.stat(this.path);
        if (stats.size === 0) exists = false;
      } catch {
        exists = false;
      }
    }

    if (!exists) {
      await fs.ensureDir(paHome());
      try {
        await fs.writeJson(this.path, { active_locks: [] }, { flag: 'wx' });
      } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  }

  private async readData(): Promise<BlackboardData> {
    try {
      return await fs.readJson(this.path);
    } catch (err) {
      const refId = `s-${randomBytes(6).toString('hex')}`;
      log('error', 'blackboard', 'store unreadable — resetting to empty', { refId, path: this.path, error: String(err) });
      return { active_locks: [] };
    }
  }

  /**
   * Acquire a lock on a resource.
   * If the resource is already locked, it waits unless the lock is stale.
   *
   * contextId (5th param, optional): a UUID generated per processUpdate call.
   * When provided, re-entrancy is only allowed for the same contextId (same
   * execution flow). Two concurrent same-topic handlers with different contextIds
   * and the same PID will correctly block each other.
   * Legacy callers that omit contextId preserve existing same-PID re-entrancy.
   */
  async acquireLock(
    resource: string,
    agent: string,
    pid: number,
    timeoutMs: number = 60000,
    contextId?: string
  ): Promise<boolean> {
    await this.ensureFile();
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      // Use proper-lockfile to ensure atomic access to blackboard.json
      let release: (() => Promise<void>) | undefined;
      try {
        release = await lockfile.lock(this.path, safeLockOptions('blackboard', { retries: 5 }));

        const data = await this.readData();
        const now = new Date();
        const nowMs = now.getTime();

        // Purge dead-PID or grace-expired-stale locks first. An alive PID
        // whose heartbeat is merely stale (not yet past grace) is KEPT — it
        // still counts as held and still blocks a competing acquire below,
        // which is what makes grace safe against double-occupancy: the row
        // never disappears from activeLocks until it is genuinely dead or its
        // grace has fully elapsed, so there is never a window where two
        // holders can both believe they hold the same resource.
        let purgedAny = false;
        const activeLocks = data.active_locks.filter((lock) => {
          const disposition = classifyLock(lock, nowMs);
          if (disposition === 'evict-dead') {
            console.log(`[blackboard] Purging dead PID lock: ${lock.resource} (pid:${lock.pid})`);
            purgedAny = true;
            return false;
          }
          if (disposition === 'evict-expired') {
            const heartbeatAge = nowMs - new Date(lock.heartbeat).getTime();
            console.log(`[blackboard] Purging stale heartbeat lock (grace expired): ${lock.resource} (age:${Math.round(heartbeatAge / 1000)}s, pid:${lock.pid} alive)`);
            purgedAny = true;
            return false;
          }
          if (disposition === 'grace') {
            this.logGraceOnce(lock, nowMs);
          }
          return true;
        });

        // Persist any eviction immediately, regardless of whether THIS call's
        // own requested resource ends up contended below. Before this fix, a
        // purge decision computed here was only ever written to disk in the
        // no-conflict success branch further down — when the caller's own
        // resource stayed contended, the loop released the file lock and
        // retried after 1s WITHOUT writing, so an unrelated stale row got
        // recomputed and re-logged every retry (observed: "[blackboard]
        // Purging stale heartbeat lock..." repeating at ~1 Hz for 650+s,
        // never actually removing the row) instead of being purged once.
        if (purgedAny) {
          await writeJsonAtomic(this.path, { active_locks: activeLocks }, { spaces: 2 });
        }

        // Re-entrance check:
        // - Different PID → always block (another process holds the lock)
        // - Same PID, no contextId on either side → allow (legacy callers)
        // - Same PID, same contextId → allow (nested re-entrancy within the same flow)
        // - Same PID, different contextId → block (two concurrent same-topic handlers)
        const existing = activeLocks.find((l) => {
          if (l.resource !== resource) return false;
          if (l.pid !== pid) return true;                      // different process → block
          if (!contextId || !l.contextId) return false;        // no contextId on either side → allow (legacy)
          return l.contextId !== contextId;                    // same PID, different context → block
        });
        if (existing) {
          // Already locked by a conflicting holder
          await release();
          release = undefined;
          // Wait and retry
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        // Drop any same-PID, same-resource, same-agent, same-contextId duplicate
        // so we don't accumulate rows on re-acquisition.
        const nextLocks = activeLocks.filter(
          (l) => !(l.resource === resource && l.pid === pid && l.agent === agent && l.contextId === contextId)
        );

        nextLocks.push({
          resource,
          agent,
          pid,
          heartbeat: now.toISOString(),
          ...(contextId !== undefined ? { contextId } : {}),
        });

        await writeJsonAtomic(this.path, { active_locks: nextLocks }, { spaces: 2 });
        return true;
      } catch (err) {
        console.error('[blackboard] acquireLock error:', err);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } finally {
        if (release) await release();
      }
    }

    return false;
  }

  /**
   * Release a lock.
   *
   * contextId (3rd param, optional):
   * - Omitted → remove ALL entries for resource+agent (legacy behaviour; correct
   *   for `pa catchup` / `pa purge-locks` which don't use contextId).
   * - Provided → remove only the entry whose contextId matches, leaving any
   *   other concurrent entries untouched.
   *
   * opts.pid (4th param, optional, D4 — additive): when given, only rows whose
   * pid matches are removed too. Omitting it preserves every existing caller's
   * behaviour unchanged (matches on resource+agent+contextId only).
   */
  async releaseLock(resource: string, agent: string, contextId?: string, opts?: { pid?: number }): Promise<void> {
    await this.ensureFile();
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.path, safeLockOptions('blackboard', { retries: 5 }));
      const data = await this.readData();
      const activeLocks = data.active_locks.filter(
        (l) => !(
          l.resource === resource &&
          l.agent === agent &&
          (!contextId || l.contextId === contextId) &&
          (opts?.pid === undefined || l.pid === opts.pid)
        )
      );
      await writeJsonAtomic(this.path, { active_locks: activeLocks }, { spaces: 2 });
    } catch (err) {
      console.error('[blackboard] releaseLock error:', err);
    } finally {
      if (release) await release();
    }
  }

  /**
   * Renew an existing lock row's heartbeat, reporting the FULL outcome as a
   * tri-state (AI-179, 2026-09-03). The pre-AI-179 `updateHeartbeat` boolean
   * returned `false` both for "row genuinely absent" and for "gave up after
   * write errors" — a transient EPERM on the atomic-replace rename (any
   * Windows process holding blackboard.json open without FILE_SHARE_DELETE:
   * Defender, Search indexer, backup agents) was therefore indistinguishable
   * from a real purge, and startLockRenewal aborted healthy runs with
   * onLost('purged').
   *
   * Attempt ladder: 1 immediate attempt + 1 retry per delay in
   * PA_HEARTBEAT_WRITE_RETRY_MS (default 1s/5s/15s → 4 attempts spanning
   * ~21s + per-attempt inner rename retries). Every concurrent heartbeat
   * source in the system serializes through this ONE proper-lockfile lock on
   * one shared file, so acquisition hiccups are expected, not exceptional —
   * the ladder adds outer seconds instead of aborting on the first blip.
   *
   * The read here is deliberately NOT this.readData(): readData's catch
   * swallows a torn/unreadable store into `{ active_locks: [] }`, which would
   * read as "row absent" and manufacture a phantom 'row-absent' (and thence
   * onLost) out of a plain read failure. A read throw is retryable, not a
   * verdict.
   */
  async renewHeartbeat(resource: string, agent: string, contextId?: string): Promise<HeartbeatRenewOutcome> {
    await this.ensureFile();
    const delays = heartbeatWriteRetryDelaysMs();
    const start = Date.now();
    let lastErr: unknown;
    const attempts = delays.length + 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await lockfile.lock(this.path, safeLockOptions('blackboard', { retries: 5 }));
        // Own read, not readData() — see docstring.
        const data: BlackboardData = await fs.readJson(this.path);
        const entry = data.active_locks.find(
          (l) => l.resource === resource && l.agent === agent && (!contextId || l.contextId === contextId)
        );
        if (!entry) {
          // Row genuinely absent — not a lock-acquisition failure, don't
          // retry: no ladder can resurrect it.
          return 'row-absent';
        }
        entry.heartbeat = new Date().toISOString();
        await writeJsonAtomic(this.path, data, { spaces: 2 });
        return 'updated';
      } catch (err) {
        lastErr = err;
      } finally {
        if (release) await release();
      }
      if (attempt <= delays.length) {
        await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      }
    }
    console.warn(
      `[blackboard] renewHeartbeat: giving up for ${resource}/${agent} after ${attempts} attempts ` +
      `(${Date.now() - start}ms elapsed, target ${this.path}): ` +
      `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
    );
    return 'write-failed';
  }

  /**
   * Read-only row verification for renewal loss-detection (AI-179): does the
   * (resource, agent[, contextId]) row exist right now? No proper-lockfile
   * acquisition — unlocked reads are safe because every writer replaces the
   * file by atomic rename, so a concurrent reader sees old-or-new, both valid
   * JSON. Raw presence only — no staleness classification. Any read failure
   * (torn/unreadable/missing store) → 'unreadable': callers must treat that
   * as NOT proof of absence, never as a purge.
   */
  async peekLockRow(resource: string, agent: string, contextId?: string): Promise<LockEntry | null | 'unreadable'> {
    try {
      const data: BlackboardData = await fs.readJson(this.path);
      return data.active_locks.find(
        (l) => l.resource === resource && l.agent === agent && (!contextId || l.contextId === contextId)
      ) ?? null;
    } catch {
      return 'unreadable';
    }
  }

  /**
   * Update the heartbeat for an existing lock.
   *
   * Boolean compatibility wrapper (AI-179, 2026-09-03) over renewHeartbeat's
   * tri-state: true ⇔ 'updated'. Every pre-existing caller keeps compiling
   * and behaving — worker-exec's informational heartbeats (:197, :592, :594)
   * keep the boolean; every test fake keeps passing. Note the residual
   * ambiguity this shape cannot escape: `false` still means "row-absent OR
   * write-failed", which is exactly the AI-179 conflation — renewal-driven
   * callers must use renewHeartbeat + peekLockRow instead (startLockRenewal
   * does).
   *
   * contextId (3rd param, optional): when provided, updates only the matching
   * entry. When omitted, updates the first matching resource+agent entry
   * (legacy behaviour — safe once the concurrent-hold bug is fixed).
   */
  async updateHeartbeat(resource: string, agent: string, contextId?: string): Promise<boolean> {
    return (await this.renewHeartbeat(resource, agent, contextId)) === 'updated';
  }

  /**
   * Return all active (non-evicted) locks without modifying the file. A
   * grace-window row counts as active here too (it still legitimately holds
   * the resource) — consistency with acquireLock's purge classification
   * matters because catchup.ts's isLockLost() checkpoint reads this list to
   * decide whether ITS OWN row is still valid; before this fix it used a
   * plain staleness check with no grace, so it could declare itself "lost"
   * purely from raw heartbeat age even when nothing had actually purged it.
   */
  async getActiveLocks(): Promise<LockEntry[]> {
    await this.ensureFile();
    const data = await this.readData();
    const nowMs = Date.now();
    return data.active_locks.filter((lock) => {
      const disposition = classifyLock(lock, nowMs);
      return disposition === 'alive' || disposition === 'grace';
    });
  }

  /**
   * Purge all dead or stale locks.
   */
  async purgeStaleLocks(): Promise<number> {
    await this.ensureFile();
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.path, safeLockOptions('blackboard', { retries: 5 }));
      const data = await this.readData();
      const before = data.active_locks.length;
      const nowMs = Date.now();
      const activeLocks = data.active_locks.filter((lock) => {
        const disposition = classifyLock(lock, nowMs);
        if (disposition === 'grace') this.logGraceOnce(lock, nowMs);
        return disposition === 'alive' || disposition === 'grace';
      });
      await writeJsonAtomic(this.path, { active_locks: activeLocks }, { spaces: 2 });
      return before - activeLocks.length;
    } catch (err) {
      console.error('[blackboard] purgeStaleLocks error:', err);
      return 0;
    } finally {
      if (release) await release();
    }
  }
}

export const blackboard = new Blackboard();

export interface LockRenewalOptions {
  /** Renewal tick cadence. Default 60s, or PA_LOCK_RENEW_INTERVAL_MS. */
  intervalMs?: number;
  /** Cap on total renewal lifetime — after this, stop renewing and fire
   * onLost('expired') once. Default 6h, or PA_LOCK_RENEW_MAX_MS. This is what
   * keeps a truly-hung dispatch from holding the lock forever: an async hang
   * with a healthy event loop would otherwise renew indefinitely (a
   * wedged/dead event loop already stops renewing on its own, since
   * setInterval can't fire). */
  maxMs?: number;
  onLost?: (reason: 'expired' | 'purged') => void;
  /** Renew through this client instead of the module-singleton `blackboard`
   * (C13) — callers that inject a fake/BlackboardLockClient for their own
   * acquire/release (code-fixer.ts, self-improver.ts) must renew through the
   * SAME client, or their tests' fakes silently start hitting the real
   * blackboard singleton the moment they migrate onto this helper. Two
   * shapes: the tri-state pair (renewHeartbeat + peekLockRow) that the real
   * singleton exposes, or the legacy boolean-only { updateHeartbeat } shape
   * every pre-AI-179 fake still uses (mapped by the fallback path below). */
  client?: Pick<Blackboard, 'updateHeartbeat'> | Pick<Blackboard, 'renewHeartbeat' | 'peekLockRow'>;
}

/**
 * Keeps a single (resource, agent, contextId) lock row's heartbeat fresh for
 * the lifetime of a long-running holder, via setInterval → renewHeartbeat —
 * the same hand-rolled pattern already used twice in this codebase
 * (pa/src/commands/catchup.ts, pa/src/code-fixer.ts), generalized into a
 * reusable helper. AI-113: without this, any single dispatch running past
 * HEARTBEAT_STALE_MS (10 min default) has its lock purged out from under it by
 * the next acquireLock call, even though the holder is alive and working.
 * AI-179 (2026-09-03): a renewal tick can no longer abort a healthy run on a
 * transient write failure — the tri-state outcome decides, and onLost('purged')
 * fires only on a VERIFIED absent row (see the tick body below).
 */
export function startLockRenewal(
  resource: string,
  agent: string,
  contextId: string | undefined,
  opts?: LockRenewalOptions
): { stop: () => void } {
  const intervalMs = opts?.intervalMs ?? envMs('PA_LOCK_RENEW_INTERVAL_MS') ?? 60_000;
  const maxMs = opts?.maxMs ?? envMs('PA_LOCK_RENEW_MAX_MS') ?? 6 * 60 * 60 * 1000;
  const onLost = opts?.onLost;
  const client = opts?.client ?? blackboard;
  const start = Date.now();
  let stopped = false;
  let inFlight = false;
  let lostFired = false;

  const fireLostOnce = (reason: 'expired' | 'purged') => {
    if (lostFired) return;
    lostFired = true;
    onLost?.(reason);
  };

  const runRenewalAttempt = async (): Promise<void> => {
    if ('renewHeartbeat' in client) {
      // Tri-state path (AI-179): the module singleton always lands here.
      const outcome = await client.renewHeartbeat(resource, agent, contextId);
      if (outcome === 'updated') return;
      if (outcome === 'row-absent') {
        // Row already purged (e.g. a competing holder acquired it, or it went
        // stale before this renewer's first tick) — latched, never re-acquire,
        // a legitimate new holder may already exist. Keep ticking harmlessly.
        if (!stopped) fireLostOnce('purged');
        return;
      }
      // outcome === 'write-failed' — never fire onLost on the write failure
      // alone: this is exactly the transient-EPERM class that produced the
      // phantom purges. Verify the row before conceding anything.
      if (typeof client.peekLockRow !== 'function') {
        // Tri-state client without verification — skip, next tick retries.
        return;
      }
      const row = await client.peekLockRow(resource, agent, contextId);
      if (row === null) {
        // Write AND row gone = a real loss — detect it now, not next tick.
        if (!stopped) fireLostOnce('purged');
        return;
      }
      // Row present, or store unreadable (not proven absent): the lock is not
      // lost. Warn and let the next tick retry the ladder.
      console.warn(
        `[blackboard] startLockRenewal: ${resource}/${agent} heartbeat write failed but row ` +
        `${row === 'unreadable' ? 'unreadable (not proven absent)' : 'verified present'} — retrying next tick`
      );
      return;
    }
    // Legacy fallback: boolean-only client (pre-AI-179 injected fakes).
    // true → 'updated', false → 'row-absent' — the historical conflation,
    // preserved deliberately for injected fakes only; production callers
    // (module singleton) always take the tri-state path above.
    const refreshed = await client.updateHeartbeat(resource, agent, contextId);
    if (!refreshed && !stopped) fireLostOnce('purged');
  };

  const tick = () => {
    if (stopped) return;
    // The maxMs cap must be checked on EVERY tick, unconditionally — never
    // gated behind the overlap guard below. A slow renewal (real fs lock
    // contention, or the AI-179 write-retry ladder) could otherwise leave
    // inFlight true across several tick callbacks, silently delaying the cap
    // past its deadline and defeating the one thing it exists for: freeing a
    // truly-hung holder.
    if (Date.now() - start >= maxMs) {
      stopped = true;
      clearInterval(timer);
      fireLostOnce('expired');
      return;
    }
    if (inFlight) return; // overlap guard: skip the UPDATE if the previous hasn't settled
    inFlight = true;
    runRenewalAttempt()
      .catch(() => {})
      .finally(() => { inFlight = false; });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
