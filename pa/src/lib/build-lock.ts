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
 * It FAILS OPEN by design: reservations are advisory (see reservations.ts), and a
 * stale 30-minute reservation from a killed process must never brick every build on
 * the machine. If the wait deadline passes without acquiring, `withBuildLock` prints a
 * notice and runs `fn()` anyway — it never throws and never changes the exit code on
 * account of the lock.
 *
 * `PA_BUILD_LOCK_HELD` re-entrancy exists because a nested `npm run build` / `npm test`
 * inside a lock-holding parent (e.g. code-fixer's verification gate spawning `npm run
 * build` as a child) would otherwise deadlock against its own parent: the child would
 * claim under a different session label, collide with the parent's reservation, poll
 * for the full wait window, and only then fail open. Setting `PA_BUILD_LOCK_HELD` in
 * the environment for the duration of `fn()` — inherited by any child process — makes
 * every nested acquisition attempt return immediately instead.
 */

import { existsSync, statSync } from 'node:fs';
import { paHome } from '../paths.js';
import { claim, release, type Reservation, type ClaimResult } from './reservations.js';

export const BUILD_LOCK_RESOURCE = '@build';
export const BUILD_LOCK_HELD_ENV = 'PA_BUILD_LOCK_HELD';
export const BUILD_LOCK_DISABLE_ENV = 'PA_BUILD_LOCK';
export const BUILD_LOCK_TTL_MINUTES = 30;
export const BUILD_LOCK_WAIT_MS = 900_000;
export const BUILD_LOCK_POLL_MS = 5_000;

export interface BuildLockOptions {
  ttlMinutes?: number;
  waitMs?: number;
  pollMs?: number;
  notice?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  claimFn?: typeof claim;
  releaseFn?: typeof release;
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

/**
 * Runs `fn` with the `@build` reservation held, when possible. No-ops (runs `fn`
 * directly, no reservation touched) when: PA_BUILD_LOCK === '0'; PA_BUILD_LOCK_HELD is
 * already a non-empty string (re-entrancy — a parent already holds the lock); or
 * `paHome()` does not exist as a directory (fresh-clone/CI bootstrap, before the first
 * `pa/dist` exists). Any error probing `paHome()` is treated the same as "does not
 * exist". Any throw from `claimFn` is treated as "reservation store unavailable" and
 * also falls through to running `fn()` unlocked.
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
  const notice = opts.notice ?? ((line: string) => console.error(line));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const claimFn = opts.claimFn ?? claim;
  const releaseFn = opts.releaseFn ?? release;

  const deadline = now() + waitMs;
  let reservation: Reservation | undefined;
  let warnedWaiting = false;
  let lastConflictHolder: Reservation | undefined;

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

    if (now() >= deadline) {
      notice(
        `[build-lock] could not acquire @build after ${Math.round(waitMs / 1000)}s (held by "${lastConflictHolder?.session}") — proceeding WITHOUT the lock.`
      );
      return await fn();
    }
  }

  const prev = process.env[BUILD_LOCK_HELD_ENV];
  process.env[BUILD_LOCK_HELD_ENV] = reservation.id;

  const heldReservation = reservation;
  const makeSignalHandler = (code: number) => () => {
    releaseFn({ id: heldReservation.id })
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
    await releaseFn({ id: heldReservation.id }).catch(() => {});
  }
}
