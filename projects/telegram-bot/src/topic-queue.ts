/**
 * Per-topic queue of not-yet-started updates (2026-08-04, steer-queue-context-fold).
 *
 * Mirrors the module-level-state pattern used by worker-stop.ts (`stopped`)
 * and recovery-gate.ts: a plain `Map<string, QueueEntry[]>` keyed by the same
 * topic-key format `main.ts`'s `getUpdateTopicKey()` produces and `topicPending`
 * already uses (`${chatId}_${threadId}`).
 *
 * Purpose: when `/steer` kills the topic's running worker, every OTHER
 * update already queued behind it (arrived while the worker was busy, but
 * whose own `processUpdate` turn hasn't started yet) should be folded into
 * the steer prompt as context instead of either (a) running to completion
 * independently once the kill settles, or (b) being silently dropped. A
 * queued update that is itself a slash-command is left alone — folding a
 * command in as plain text would silently swallow an explicit instruction
 * (e.g. a queued `/reset`).
 *
 * `main.ts` wiring: `registerQueuedUpdate` is called for every text-bearing
 * update as it's chained into `topicPending` (before it starts); `/steer`'s
 * handler calls `drainQueuedText` to cancel and collect everything still
 * queued; each entry's own `topicPending` turn calls `dequeueUpdate` first,
 * then checks `entry.cancelled` to decide whether to skip `processUpdate`.
 */

export interface QueueEntry {
  updateId: number;
  text: string;       // '' for non-text/non-foldable updates (still tracked for ordering)
  isCommand: boolean;  // true if text starts with '/' — never folded, never cancelled
  cancelled: boolean;
}

const queues = new Map<string, QueueEntry[]>();

/** Registers a not-yet-started update for a topic. Call before its dispatch turn begins. */
export function registerQueuedUpdate(topicKey: string, updateId: number, text: string): QueueEntry {
  const entry: QueueEntry = {
    updateId,
    text,
    isCommand: /^\//.test(text.trim()),
    cancelled: false,
  };
  const arr = queues.get(topicKey);
  if (arr) arr.push(entry);
  else queues.set(topicKey, [entry]);
  return entry;
}

/**
 * Removes `entry` from the topic's queue. Call right before the update's own
 * dispatch turn starts (inside the `topicPending` `.then()` callback), BEFORE
 * checking `entry.cancelled`. Deletes the topic's array once it empties, to
 * avoid unbounded map growth across many topics.
 */
export function dequeueUpdate(topicKey: string, entry: QueueEntry): void {
  const arr = queues.get(topicKey);
  if (!arr) return;
  const idx = arr.indexOf(entry);
  if (idx !== -1) arr.splice(idx, 1);
  if (arr.length === 0) queues.delete(topicKey);
}

/**
 * Cancels and collects every non-command queued entry for a topic, in
 * original (arrival) order. Command entries (`isCommand === true`) are left
 * in place, untouched — they still dispatch on their own turn. Returns `[]`
 * (no-op) if the topic has no queued entries.
 */
export function drainQueuedText(topicKey: string): string[] {
  const arr = queues.get(topicKey);
  if (!arr || arr.length === 0) return [];
  const texts: string[] = [];
  const remaining: QueueEntry[] = [];
  for (const entry of arr) {
    if (entry.isCommand) {
      remaining.push(entry);
      continue;
    }
    entry.cancelled = true;
    if (entry.text) texts.push(entry.text);
  }
  if (remaining.length > 0) queues.set(topicKey, remaining);
  else queues.delete(topicKey);
  return texts;
}

/** Test hook. */
export function _clearQueueForTest(): void {
  queues.clear();
}
