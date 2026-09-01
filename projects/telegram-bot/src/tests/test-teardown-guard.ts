/**
 * Test teardown guard — prevents PA_HOME deletion while async work is in-flight.
 *
 * Problem: afterEach hooks that delete process.env.PA_HOME race with async
 * worker dispatches and timers. When PA_HOME is deleted before those complete,
 * late resolves fall back to the real ~/.pa via homedir(), leaking test fixtures.
 *
 * Solution: a simple counter-based latch. Test code calls trackPendingWork(n)
 * before starting async work; the guard blocks teardown until all tracked work
 * completes (waitForDrain() resolves only when the counter hits zero).
 */

let pendingCount = 0;
let drainResolver: (() => void) | null = null;

/**
 * Track n pending async operations. Call before spawning workers, starting timers, etc.
 * Decrements the counter automatically as tracked work completes via the returned release functions.
 */
export function trackPendingWork(n: number): Array<() => void> {
  pendingCount += n;
  const releases: Array<() => void> = [];
  for (let i = 0; i < n; i++) {
    releases.push(() => {
      pendingCount--;
      if (pendingCount === 0 && drainResolver) {
        drainResolver();
        drainResolver = null;
      }
    });
  }
  return releases;
}

/**
 * Wait for all tracked pending work to complete. Call in afterEach before deleting PA_HOME.
 * Returns immediately if no work is pending.
 */
export async function waitForDrain(): Promise<void> {
  if (pendingCount === 0) return;
  return new Promise<void>((resolve) => {
    drainResolver = resolve;
  });
}

/**
 * Reset the guard state (for test isolation only).
 */
export function _resetTeardownGuardForTest(): void {
  pendingCount = 0;
  drainResolver = null;
}
