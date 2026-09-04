/**
 * `@build` lock — acquired and released around the build/test gate.
 *
 * This is the ONLY implementation of `@build` acquisition. `pa/scripts/run-tests.mjs`,
 * `pa/scripts/build.mjs`, `projects/telegram-bot/scripts/run-tests.mjs`,
 * `projects/telegram-bot/scripts/build.mjs`, and `pa/src/code-fixer.ts`'s verification
 * gate all route through `withBuildLock` here — never a second, parallel acquisition
 * path. The `.mjs` runners/compilers load the COMPILED form of this module via
 * `createRequire` (this package is CommonJS) rather than reimplementing the policy.
 *
 * Reservations are advisory (see reservations.ts), so on wait-exhaustion (AI-174,
 * 2026-09-01) the holder's PID is parsed from its session label and checked once for
 * liveness (PID exists AND its process start time predates the reservation's claimedAt
 * — a PID-reuse guard, since Windows recycles PIDs aggressively). A DEAD holder is
 * TAKEN OVER: its stale reservation is force-released and re-claimed, and `fn()` runs
 * WITH the lock held, exactly like the normal happy path. Proceeding unlocked instead
 * would leave the dead row standing, so a second waiter behind the same dead holder
 * would also fail open and run CONCURRENTLY with the first — the exact hazard this
 * fix exists to prevent. `withBuildLock` only ever proceeds UNLOCKED for a genuinely
 * uncertain case: no parseable PID in the label (legacy), a liveness-check failure, or
 * the reservation store itself being unavailable — never steal on uncertainty. An
 * ALIVE holder means real concurrent gates on a machine that cannot tolerate them
 * (2026-08-15 hard-hang RCA) — the wait extends up to a hard cap of 45 minutes total
 * (`BUILD_LOCK_HARD_CAP_MS`), then `withBuildLock` throws instead of proceeding
 * unlocked. `PA_BUILD_LOCK=0` remains the unconditional escape hatch for scoped runs.
 *
 * `PA_BUILD_LOCK_HELD` re-entrancy exists because a nested `npm run build` / `npm test`
 * inside a lock-holding parent (e.g. code-fixer's verification gate spawning `npm run
 * build` as a child) would otherwise deadlock against its own parent: the child would
 * claim under a different session label, collide with the parent's reservation, poll
 * for the full wait window, and only then fail open. Setting `PA_BUILD_LOCK_HELD` in
 * the environment for the duration of `fn()` — inherited by any child process — makes
 * every nested acquisition attempt return immediately instead.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { exec as execCb } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { paHome } from '../paths.js';
import { claim, release, type Reservation, type ClaimResult } from './reservations.js';

export const BUILD_LOCK_RESOURCE = '@build';
export const BUILD_LOCK_HELD_ENV = 'PA_BUILD_LOCK_HELD';
export const BUILD_LOCK_DISABLE_ENV = 'PA_BUILD_LOCK';
export const BUILD_LOCK_TTL_MINUTES = 30;
export const BUILD_LOCK_WAIT_MS = 900_000;
export const BUILD_LOCK_POLL_MS = 5_000;
/** Hard cap on TOTAL wait time (from the original call, not from wait-exhaustion)
 * once an ALIVE holder has been confirmed at the BUILD_LOCK_WAIT_MS mark. Past this,
 * withBuildLock fails CLOSED instead of proceeding unlocked. Deliberately a constant,
 * not an env knob — PA_BUILD_LOCK=0 is the one sanctioned bypass (AI-174). */
export const BUILD_LOCK_HARD_CAP_MS = 45 * 60_000;

export interface BuildLockOptions {
  ttlMinutes?: number;
  waitMs?: number;
  pollMs?: number;
  /** Test-only override of BUILD_LOCK_HARD_CAP_MS. Not exposed as an env var. */
  hardCapMs?: number;
  notice?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  claimFn?: typeof claim;
  releaseFn?: typeof release;
  /** Test-only override of the holder-liveness check run once at wait-exhaustion. */
  checkHolderAliveFn?: HolderAliveFn;
}

/** True iff PA_BUILD_LOCK is set to exactly '0' — the scoped-run bypass. */
export function buildLockDisabled(): boolean {
  return process.env[BUILD_LOCK_DISABLE_ENV] === '0';
}

/** Session label an npm script claims under: `npm-<pkg>-<pid>`. */
export function buildLockLabel(pkg: 'pa' | 'bot'): string {
  return `npm-${pkg}-${process.pid}`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const execAsync = promisify(execCb);
// Hidden + time-capped, same pattern as process-tree.ts's execHidden: a saturated
// WMI/CIM can hang forever with exec's default (no) timeout. This check runs at
// most once per withBuildLock call (at wait-exhaustion), never on a poll path.
function execHidden(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(cmd, { windowsHide: true, timeout: 15_000, killSignal: 'SIGKILL' });
}

/**
 * Extract the trailing PID from a session label. Every current withBuildLock caller's
 * label ends in `-<pid>`: `buildLockLabel()` produces `npm-<pkg>-<pid>` for the npm
 * scripts, and code-fixer.ts's own inline label is `code-fixer-<pid>` — both match this
 * generic pattern, so no caller needs to change its label shape. Returns null for a
 * label with no trailing numeric segment (legacy fallback path).
 */
export function parseHolderPid(label: string | undefined | null): number | null {
  if (!label) return null;
  const m = /-(\d+)$/.exec(label);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Injectable: given a PID, return its process start time in ms since epoch, or
 * null if the PID cannot be found / its start time cannot be determined. */
export type HolderStartTimeFn = (pid: number) => Promise<number | null>;

async function defaultHolderStartTimeMs(pid: number): Promise<number | null> {
  try {
    if (platform() === 'win32') {
      const { stdout } = await execHidden(
        `powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToString('o')"`
      );
      const raw = stdout.trim();
      if (!raw) return null;
      const t = new Date(raw).getTime();
      return Number.isNaN(t) ? null : t;
    }
    // POSIX: etimes = elapsed seconds since the process started — avoids parsing
    // `ps`'s locale-dependent `lstart` date format.
    const { stdout } = await execHidden(`ps -o etimes= -p ${pid}`);
    const raw = stdout.trim();
    if (!raw) return null;
    const etimesSec = parseInt(raw, 10);
    if (Number.isNaN(etimesSec)) return null;
    return Date.now() - etimesSec * 1000;
  } catch {
    return null;
  }
}

/** Injectable: true iff the process `pid` is still running AND is the SAME process
 * that claimed the reservation (i.e. it started at or before `claimedAtMs`). */
export type HolderAliveFn = (pid: number, claimedAtMs: number) => Promise<boolean>;

/**
 * Default liveness check for the wait-exhaustion PID-reuse guard: a PID that exists
 * but started AFTER `claimedAtMs` has been recycled by a newer, unrelated process
 * since the original holder exited (Windows reuses PIDs aggressively) — that counts
 * as dead, not alive, or a recycled PID would make a dead holder look alive and turn
 * fail-open into a spurious fail-closed wait. The `startTimeFn` param exists so tests
 * can exercise this comparison without touching the real OS.
 */
export async function isHolderAlive(
  pid: number,
  claimedAtMs: number,
  startTimeFn: HolderStartTimeFn = defaultHolderStartTimeMs
): Promise<boolean> {
  const startedAt = await startTimeFn(pid);
  if (startedAt === null) return false;
  return startedAt <= claimedAtMs;
}

/**
 * Runs `fn` with the `@build` reservation held, when possible. No-ops (runs `fn`
 * directly, no reservation touched) when: PA_BUILD_LOCK === '0'; PA_BUILD_LOCK_HELD is
 * already a non-empty string (re-entrancy — a parent already holds the lock); or
 * `paHome()` does not exist as a directory (fresh-clone/CI bootstrap, before the first
 * `pa/dist` exists). Any error probing `paHome()` is treated the same as "does not
 * exist". Any throw from `claimFn` is treated as "reservation store unavailable" and
 * also falls through to running `fn()` unlocked.
 *
 * On wait-exhaustion (BUILD_LOCK_WAIT_MS elapsed with no acquisition), the holder's PID
 * is parsed from its session label and checked once for liveness (AI-174). A DEAD
 * holder is TAKEN OVER: its stale reservation is force-released, re-claimed, and `fn()`
 * runs WITH the lock held (the normal happy path below). Only a label with no
 * parseable PID, or a liveness-check failure (uncertain — never steal), still proceeds
 * UNLOCKED. An ALIVE holder extends the wait up to BUILD_LOCK_HARD_CAP_MS total, then
 * this function THROWS instead of proceeding unlocked — the caller (an npm script or
 * code-fixer's gate) is expected to let that propagate as a non-zero exit.
 */
export async function withBuildLock<T>(
  label: string,
  fn: () => Promise<T>,
  opts: BuildLockOptions = {}
): Promise<T> {
  if (buildLockDisabled()) return await fn();
  if ((process.env[BUILD_LOCK_HELD_ENV] ?? '') !== '') return await fn();

  try {
    const home = paHome();
    if (!existsSync(home) || !statSync(home).isDirectory()) return await fn();
  } catch {
    return await fn();
  }

  const ttlMinutes = opts.ttlMinutes ?? BUILD_LOCK_TTL_MINUTES;
  const waitMs = opts.waitMs ?? BUILD_LOCK_WAIT_MS;
  const pollMs = opts.pollMs ?? BUILD_LOCK_POLL_MS;
  const hardCapMs = opts.hardCapMs ?? BUILD_LOCK_HARD_CAP_MS;
  const notice = opts.notice ?? ((line: string) => console.error(line));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const claimFn = opts.claimFn ?? claim;
  const releaseFn = opts.releaseFn ?? release;
  const checkHolderAliveFn = opts.checkHolderAliveFn ?? isHolderAlive;

  const waitStart = now();
  const deadline = waitStart + waitMs;
  const hardDeadline = waitStart + hardCapMs;
  let reservation: Reservation | undefined;
  let warnedWaiting = false;
  let lastConflictHolder: Reservation | undefined;
  // One-shot gate: the liveness check (and whatever it decides) runs ONCE at
  // wait-exhaustion, never re-run on a later poll (AI-174).
  let deadlineHandled = false;
  // Set once we've crossed into "post-deadline" territory for a holder we did NOT
  // fail open for — an alive holder we're waiting out, or a dead holder whose
  // takeover we just attempted (in case that retry itself races against another
  // waiter). From here on the hard cap applies even if a takeover retry conflicts.
  let extendedWait = false;

  for (;;) {
    let result: ClaimResult;
    try {
      result = await claimFn({
        paths: [BUILD_LOCK_RESOURCE],
        session: label,
        note: 'build/test gate',
        ttlMinutes,
      });
    } catch {
      notice('[build-lock] reservation store unavailable — proceeding without the lock.');
      return await fn();
    }

    if (result.ok && result.reservation) {
      reservation = result.reservation;
      break;
    }

    const holder = result.conflicts?.[0];
    lastConflictHolder = holder;
    if (!warnedWaiting) {
      warnedWaiting = true;
      notice(
        `[build-lock] waiting for @build (held by "${holder?.session}": ${holder?.note}) — up to ${Math.round(waitMs / 1000)}s…`
      );
    }

    await sleep(pollMs);
    const nowMs = now();

    if (!deadlineHandled && nowMs >= deadline) {
      deadlineHandled = true;
      const holderId = lastConflictHolder?.id;
      const holderSession = lastConflictHolder?.session;
      const pid = parseHolderPid(holderSession);
      const claimedAtMs = lastConflictHolder ? new Date(lastConflictHolder.claimedAt).getTime() : NaN;

      if (pid === null || !Number.isFinite(claimedAtMs)) {
        notice(
          `[build-lock] could not acquire @build after ${Math.round(waitMs / 1000)}s (held by "${holderSession}", no PID in session label — legacy behavior) — proceeding WITHOUT the lock.`
        );
        return await fn();
      }

      let alive: boolean;
      try {
        alive = await checkHolderAliveFn(pid, claimedAtMs);
      } catch {
        // Uncertain whether the holder is alive — never steal on uncertainty.
        notice(
          `[build-lock] liveness check failed for holder "${holderSession}" — proceeding WITHOUT the lock.`
        );
        return await fn();
      }

      if (alive) {
        extendedWait = true;
        notice(
          `[build-lock] holder "${holderSession}" is still alive — continuing to wait for @build, up to ${Math.round(hardCapMs / 60_000)} min total…`
        );
      } else {
        // Dead holder: release its stale row and take over, rather than proceeding
        // unlocked. Proceeding unlocked would leave the dead row standing, so a
        // second waiter behind the same dead holder would ALSO fail open and run
        // CONCURRENTLY with the first — the exact hazard AI-174 exists to prevent.
        // Taking over means we hold a live row and everyone else serializes behind
        // it properly.
        notice(
          `[build-lock] holder "${holderSession}" is dead — releasing its @build reservation and taking over.`
        );
        if (holderId) {
          await releaseFn({ id: holderId, force: true, ownerSession: holderSession, bySession: label }).catch(() => {});
        }
        // Safety net: if the takeover retry below races against another waiter and
        // conflicts with a freshly (legitimately) claimed reservation, that new
        // holder is alive by construction — keep respecting the hard cap from here
        // on rather than re-entering this branch (it is one-shot).
        extendedWait = true;
        continue;
      }
    }

    if (extendedWait && nowMs >= hardDeadline) {
      throw new Error(
        `[build-lock] @build still held by "${lastConflictHolder?.session}" after ${Math.round(hardCapMs / 60_000)} minutes — refusing to run without the lock. Run "pa claims" to inspect the holder, or set PA_BUILD_LOCK=0 to bypass this lock for a scoped run.`
      );
    }
  }

  const prev = process.env[BUILD_LOCK_HELD_ENV];
  process.env[BUILD_LOCK_HELD_ENV] = reservation.id;

  const heldReservation = reservation;
  const makeSignalHandler = (code: number) => () => {
    releaseFn({ id: heldReservation.id, bySession: label })
      .catch(() => {})
      .finally(() => process.exit(code));
  };
  const sigintHandler = makeSignalHandler(130);
  const sigtermHandler = makeSignalHandler(143);
  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);

  try {
    return await fn();
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
    if (prev === undefined) {
      delete process.env[BUILD_LOCK_HELD_ENV];
    } else {
      process.env[BUILD_LOCK_HELD_ENV] = prev;
    }
    await releaseFn({ id: heldReservation.id, bySession: label }).catch(() => {});
  }
}

// ---- AI-180: dist-identity guard ----

/** Escape hatch for the dist-identity guard (build.mjs's own runs and any
 * deliberate stale-dist test run): warn-and-continue instead of refusing. */
export const ALLOW_STALE_DIST_ENV = 'PA_ALLOW_STALE_DIST';

export interface DistFreshOptions {
  /** Which package's compiled output to verify. */
  pkg: 'pa' | 'bot';
  /** The REPO root the runner already computed for its loadBuildLock — the
   * stamp, the src roots and the `git rev-parse` all resolve under it. */
  repoRoot: string;
  /** Test-only override of the HEAD lookup. Returns the short sha, or null
   * when HEAD cannot be determined (not a git checkout / git failure). */
  revParseFn?: (repoRoot: string) => Promise<string | null>;
}

type DistStaleReason = 'stamp-missing' | 'no-head' | 'sha-mismatch' | 'src-newer';

interface BuildStamp {
  builtAt?: unknown;
  sha?: unknown;
  pkg?: unknown;
}

function distStale(reason: DistStaleReason, message: string): Error {
  const err = new Error(message) as Error & { code?: string; reason?: DistStaleReason };
  err.code = 'DIST_STALE';
  err.reason = reason;
  return err;
}

async function defaultRevParseShortHead(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git rev-parse --short HEAD', {
      cwd: repoRoot,
      windowsHide: true,
      timeout: 15_000,
      killSignal: 'SIGKILL',
    });
    const sha = stdout.trim();
    return sha ? sha : null;
  } catch {
    return null;
  }
}

/** Package layout the runners and compilers already agree on: dist output and
 * the src roots whose mtimes must never outrun the build stamp. */
function distLayout(pkg: 'pa' | 'bot', repoRoot: string): { distDir: string; srcRoots: string[] } {
  if (pkg === 'bot') {
    return {
      distDir: join(repoRoot, 'projects', 'telegram-bot', 'dist'),
      srcRoots: [join(repoRoot, 'projects', 'telegram-bot', 'src')],
    };
  }
  return {
    distDir: join(repoRoot, 'pa', 'dist'),
    srcRoots: [join(repoRoot, 'pa', 'bin'), join(repoRoot, 'pa', 'src'), join(repoRoot, 'pa', 'tests')],
  };
}

/** First regular file under any of `roots` whose mtime is strictly newer than
 * `cutoffMs` (up to `limit` names, for the refusal message). Missing roots are
 * skipped (a fresh clone has no src yet — nothing can be newer). */
function newerFilesUnder(roots: string[], cutoffMs: number, limit: number): string[] {
  const found: string[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const rel of names) {
      const full = join(root, rel);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile() || st.mtimeMs <= cutoffMs) continue;
      found.push(join(root, rel));
      if (found.length >= limit) return found;
    }
  }
  return found;
}

/**
 * AI-180: refuse to run tests against a dist that does not belong to this
 * checkout. Three independent identity failures refuse, FAIL-CLOSED:
 *   1. the package's `dist/.build-stamp` is missing/unreadable (never built,
 *      or written by something that does not stamp);
 *   2. `git rev-parse --short HEAD` at `repoRoot` cannot be determined;
 *   3. the stamp's sha differs from HEAD (dist predates the last commit);
 *   4. any src mtime under the package's compiled roots (pa bin/src/tests,
 *      bot src) is strictly newer than the stamp's builtAt (src edited since
 *      the last build).
 * One-line Error naming stamp sha/builtAt vs HEAD. Resolves (possibly after a
 * warning) when the dist is fresh or PA_ALLOW_STALE_DIST=1. NO auto-build —
 * the caller rebuilds; there is deliberately no holder-liveness check at
 * grant time (see this file's header — liveness lives in withBuildLock's
 * wait-exhaustion takeover only).
 */
export async function assertDistFresh(opts: DistFreshOptions): Promise<void> {
  const { distDir, srcRoots } = distLayout(opts.pkg, opts.repoRoot);
  const allowStale = process.env[ALLOW_STALE_DIST_ENV] === '1';

  const refuse = (reason: DistStaleReason, detail: string): void => {
    const message = `DIST STALE (${opts.pkg}): ${detail} — rebuild (npm run build) or set ${ALLOW_STALE_DIST_ENV}=1 to proceed anyway.`;
    if (allowStale) {
      console.error(`[build-lock] WARNING: ${message}`);
      return;
    }
    throw distStale(reason, message);
  };

  let stamp: BuildStamp;
  let stampRaw = '';
  try {
    stampRaw = readFileSync(join(distDir, '.build-stamp'), 'utf8');
  } catch {
    /* handled below */
  }
  try {
    stamp = JSON.parse(stampRaw) as BuildStamp;
  } catch {
    stamp = {};
  }
  const builtAtMs = Date.parse(String(stamp.builtAt ?? ''));
  if (!stampRaw.trim() || Number.isNaN(builtAtMs)) {
    refuse('stamp-missing', `no readable .build-stamp under ${distDir} (never built here, or written without one)`);
    return;
  }

  const headSha = await (opts.revParseFn ?? defaultRevParseShortHead)(opts.repoRoot);
  if (!headSha) {
    refuse('no-head', `cannot verify HEAD (git rev-parse failed at ${opts.repoRoot}); stamp built from ${String(stamp.sha)} at ${stamp.builtAt}`);
    return;
  }

  const stampSha = String(stamp.sha ?? '');
  if (stampSha !== headSha) {
    refuse('sha-mismatch', `built from ${stampSha} at ${stamp.builtAt}, but HEAD is ${headSha}`);
    return;
  }

  const newer = newerFilesUnder(srcRoots, builtAtMs, 4);
  if (newer.length > 0) {
    const shown = newer.map((p) => p.split(/[\\/]/).slice(-2).join('/')).join(', ');
    refuse(
      'src-newer',
      `src changed after the ${stamp.builtAt} build of ${stampSha} (e.g. ${shown}) — the dist does not contain it`
    );
    return;
  }
}
