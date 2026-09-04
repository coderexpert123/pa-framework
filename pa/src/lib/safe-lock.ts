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
 *
 * AI-177: callers whose critical section must not run unsynchronized (a
 * read-modify-write store, e.g. reservations) can opt into `compromisedPolicy:
 * 'fail'`. That policy NEVER throws from onCompromised — proper-lockfile
 * invokes it inside an mtime-update timer callback, and a throw there is an
 * uncaught exception that kills the process (the exact AI-096 crash class).
 * Instead the default fail handler tags the error and logs loudly; a caller
 * that wants a real rejection passes its own `onCompromised` in `extra`
 * (routing the tagged error to its promise) — see reservations.ts's mutate.
 */
export const SAFE_LOCK_STALE_MS = 30_000;

export type CompromisedPolicy = 'continue' | 'fail';

export interface SafeLockPolicy {
  /** 'continue' (default) preserves the log-and-continue behavior every
   * existing caller relies on; 'fail' is for callers that route the compromise
   * to their own error path. */
  compromisedPolicy?: CompromisedPolicy;
}

export function safeLockOptions(
  name: string,
  extra?: Record<string, unknown>,
  policy: SafeLockPolicy = {},
): Record<string, unknown> {
  const fail = policy.compromisedPolicy === 'fail';
  return {
    stale: SAFE_LOCK_STALE_MS,
    onCompromised: (err: Error) => {
      // console (not lib/log) — log.ts itself locks via these options; avoid recursion.
      if (fail) {
        (err as Error & { compromised?: boolean }).compromised = true;
        console.error(`[safe-lock] ${name}: lock compromised (fail-policy): ${err.message}`);
        return;
      }
      console.error(`[safe-lock] ${name}: lock compromised, continuing unsynchronized (was a process-killer pre-AI-096): ${err.message}`);
    },
    ...extra,
  };
}
