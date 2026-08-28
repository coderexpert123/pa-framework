/**
 * Pure decision logic for the bot's self-restart maintenance job
 * (`bot-self-restart`, projects/telegram-bot/src/maintenance-jobs.ts). No I/O
 * here — the bound job in maintenance-jobs.ts gathers every input from
 * durable state (dist stamp mtimes, the reservation store, pending
 * dispatches, blackboard locks, per-topic pending_action flags) and calls
 * these two functions. Kept pure and side-effect-free so they can be unit
 * tested exhaustively without a temp PA_HOME.
 *
 * Restarting the bot in-process is never an option: the only mechanism is
 * writing the same stop sentinel `pa bot stop` uses (see
 * boundBotLogRotationCheck in maintenance-jobs.ts for the precedent) so the
 * existing graceful-shutdown path finishes the current poll iteration and
 * Task Scheduler relaunches the process on newer dist code.
 */

export const SELF_RESTART_GRACE_MS = 60_000;
export const SELF_RESTART_STALE_WARN_MS = 30 * 60_000;

export interface SelfRestartInputs {
  /** Date.now() - process.uptime()*1000, computed by the caller. */
  procStartMs: number;
  /** Newest of pa/dist/.build-stamp and bot dist/.build-stamp; null when
   *  neither exists. */
  stampMtimeMs: number | null;
  nowMs: number;
  /** An active reservation whose paths include '@build'. */
  buildLockHeld: boolean;
  /** listPendingDispatches().length. */
  inFlightWorkers: number;
  /** Count of topic states carrying a truthy pending_action. */
  pendingActions: number;
  /** Blackboard locks named topic-* held by THIS pid. */
  topicLocksHeld: number;
  graceMs?: number;
  /** PA_BOT_SELF_RESTART === '0'. */
  disabled?: boolean;
}

export type SelfRestartReason =
  | 'disabled'
  | 'no-stamp'
  | 'stamp-older'
  | 'within-grace'
  | 'build-lock-held'
  | 'busy'
  | 'stamp-newer-and-idle';

export interface SelfRestartDecision {
  restart: boolean;
  reason: SelfRestartReason;
  stampIsNewer: boolean;
}

/** Pure. Evaluation order is exact and must not be reordered. */
export function shouldSelfRestart(i: SelfRestartInputs): SelfRestartDecision {
  const graceMs = i.graceMs ?? SELF_RESTART_GRACE_MS;

  if (i.disabled) {
    return { restart: false, reason: 'disabled', stampIsNewer: false };
  }
  if (i.stampMtimeMs === null) {
    return { restart: false, reason: 'no-stamp', stampIsNewer: false };
  }
  if (i.stampMtimeMs <= i.procStartMs) {
    return { restart: false, reason: 'stamp-older', stampIsNewer: false };
  }
  if (i.nowMs - i.stampMtimeMs < graceMs) {
    return { restart: false, reason: 'within-grace', stampIsNewer: true };
  }
  if (i.buildLockHeld) {
    return { restart: false, reason: 'build-lock-held', stampIsNewer: true };
  }
  if (i.inFlightWorkers > 0 || i.pendingActions > 0 || i.topicLocksHeld > 0) {
    return { restart: false, reason: 'busy', stampIsNewer: true };
  }
  return { restart: true, reason: 'stamp-newer-and-idle', stampIsNewer: true };
}

/** Pure. "Stamp newer but never idle" watchdog (D5.4). */
export function shouldWarnStaleCode(a: {
  firstSeenNewerStampMs: number | null;
  nowMs: number;
  staleWarnMs?: number;
}): boolean {
  const staleWarnMs = a.staleWarnMs ?? SELF_RESTART_STALE_WARN_MS;
  return a.firstSeenNewerStampMs !== null && a.nowMs - a.firstSeenNewerStampMs >= staleWarnMs;
}
