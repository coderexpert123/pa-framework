/**
 * In-memory gate blocking a new dispatch into a topic under active
 * orphan-recovery (AI-095 follow-up, deep-recheck 2026-07-08, Phase 1B).
 *
 * `reapOrphanedDispatches` (orphan-reaper.ts) can run for up to 45 minutes at
 * startup, recovering dispatches left behind by a crashed prior instance. If
 * the user sends a follow-up message to the same topic during that window,
 * `processUpdate` would previously dispatch it normally — resuming the SAME
 * `session_id` the orphan is still running (concurrent writes to one
 * transcript), and the reaper's harvest could then deliver the follow-up's
 * own reply a second time, mislabeled "Recovered reply", while the
 * genuinely lost orphan reply is dropped.
 *
 * Single-owner by design: only the reaper marks and clears (see
 * orphan-reaper.ts's per-round clearing + finally() backstop) — `processUpdate`
 * only reads via isTopicRecovering. This is pure in-memory state (dies with
 * the process); a fresh restart begins with nothing marked, and the reaper's
 * own re-derivation from the persisted pending-dispatches store re-marks
 * exactly the topics that still need it — no separate persistence required.
 */

const recovering = new Set<string>();

// Waiter registry for waitForTopicRecovery (seamless-restart-recovery 2026-08-27)
const waiters = new Map<string, Set<(cleared: boolean) => void>>();

export function markTopicRecovering(topicKey: string): void {
  recovering.add(topicKey);
}

export function clearTopicRecovering(topicKey: string): void {
  recovering.delete(topicKey);
  // Resolve all waiters for this topic with true (topic cleared)
  const set = waiters.get(topicKey);
  if (set) {
    const copy = new Set(set);
    for (const resolve of copy) {
      resolve(true);
    }
  }
}

export function isTopicRecovering(topicKey: string): boolean {
  return recovering.has(topicKey);
}

/** Test hook. */
export function _resetRecoveryGateForTest(): void {
  recovering.clear();
  // Resolve all waiters with true, then clear the registry
  for (const set of waiters.values()) {
    for (const resolve of set) {
      resolve(true);
    }
  }
  waiters.clear();
}

/**
 * Wait for a topic to clear recovery status, with a timeout.
 * Returns true if the topic was cleared, false if timeout elapsed while still marked.
 * (seamless-restart-recovery 2026-08-27)
 */
export function waitForTopicRecovery(topicKey: string, timeoutMs: number): Promise<boolean> {
  if (!recovering.has(topicKey)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout;
    const done = (cleared: boolean) => {
      clearTimeout(timer);
      const set = waiters.get(topicKey);
      set?.delete(done);
      if (set && set.size === 0) waiters.delete(topicKey);
      resolve(cleared);
    };
    let set = waiters.get(topicKey);
    if (!set) {
      set = new Set();
      waiters.set(topicKey, set);
    }
    set.add(done);
    timer = setTimeout(() => done(false), timeoutMs);
  });
}
