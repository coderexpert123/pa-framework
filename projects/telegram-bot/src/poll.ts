export const LONG_POLL_TIMEOUT = 30;
export const MAX_BACKOFF_MS = 30_000;
export const BACKOFF_STEP_MS = 5_000;

export function computeBackoff(consecutiveErrors: number): number {
  return Math.max(0, Math.min(consecutiveErrors * BACKOFF_STEP_MS, MAX_BACKOFF_MS));
}

export function computePollOffset(lastUpdateId: number): number {
  return lastUpdateId < 0 ? 0 : lastUpdateId + 1;
}
