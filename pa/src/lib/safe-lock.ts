/**
 * Shared proper-lockfile options that never kill the process (AI-096 item 2).
 *
 * proper-lockfile's default `onCompromised` THROWS from a timer context —
 * an uncaught exception that terminates the process. "Compromised" means the
 * lock's mtime heartbeat missed its stale threshold, which on a starved disk
 * (observed 0.5s/IO, 2026-07-04) happens to perfectly healthy processes. Both
 * 2026-07-03/04 bot crashes were this: the watchdog executing its own process.
 *
 * Policy: log and continue unsynchronized for the remainder of the (short)
 * critical section. Worst case is a rare interleaved write to a small state
 * file — strictly better than process death. `stale` is also raised from the
 * 10s default so a slow-disk mtime touch doesn't trip the threshold at all.
 */
export const SAFE_LOCK_STALE_MS = 30_000;

export function safeLockOptions(
  name: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    stale: SAFE_LOCK_STALE_MS,
    onCompromised: (err: Error) => {
      // console (not lib/log) — log.ts itself locks via these options; avoid recursion.
      console.error(`[safe-lock] ${name}: lock compromised, continuing unsynchronized (was a process-killer pre-AI-096): ${err.message}`);
    },
    ...extra,
  };
}
