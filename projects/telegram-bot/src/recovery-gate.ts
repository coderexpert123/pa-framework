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

export function markTopicRecovering(topicKey: string): void {
  recovering.add(topicKey);
}

export function clearTopicRecovering(topicKey: string): void {
  recovering.delete(topicKey);
}

export function isTopicRecovering(topicKey: string): boolean {
  return recovering.has(topicKey);
}

/** Test hook. */
export function _resetRecoveryGateForTest(): void {
  recovering.clear();
}
