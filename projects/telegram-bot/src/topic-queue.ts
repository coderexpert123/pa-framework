/**
 * Per-topic queue of not-yet-started updates (2026-08-04, steer-queue-context-fold;
 * extended 2026-08-15 for voice prefetch + held entries).
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
 * Voice prefetch extension (2026-08-15): QueueEntry now carries an optional
 * `voice` field with the prefetch promise and descriptor, enabling non-blocking
 * transcription await before the update's turn starts.
 *
 * `main.ts` wiring: `registerQueuedUpdate` is called for every text-bearing
 * update as it's chained into `topicPending` (before it starts); `/steer`'s
 * handler calls `drainQueuedText` to cancel and collect everything still
 * queued; each entry's own `topicPending` turn calls `dequeueUpdate` first,
 * then checks `entry.cancelled` to decide whether to skip `processUpdate`.
 */

import type { VoicePrefetchDescriptor } from './voice-prefetch.js';
import type { VoiceResult } from './voice.js';
import { userTextFromVoiceResult } from './voice-prefetch.js';

export type HeldItem = string | { promise: Promise<VoiceResult>; descriptor: VoicePrefetchDescriptor };

export interface SteerFoldContext {
  /** Drained entries carrying voice promises. The normalizer awaits them. */
  drainedEntries: QueueEntry[];
  /** The steer instruction (from /steer prompt arg or caption), if any. */
  steerPrompt?: string;
}

export interface QueueEntry {
  updateId: number;
  text: string;       // '' for non-text/non-foldable updates (still tracked for ordering)
  isCommand: boolean;  // true if text starts with '/' — never folded, never cancelled
  cancelled: boolean;
  /** Voice prefetch state, if this entry has audio and was prefetched. */
  voice?: {
    promise: Promise<VoiceResult>;
    descriptor: VoicePrefetchDescriptor;
  };
  /** Set by the steer handler for voice-steer entries (D1). */
  steerContext?: SteerFoldContext;
}

const queues = new Map<string, QueueEntry[]>();

/**
 * Registers a not-yet-started update for a topic. Call before its dispatch turn begins.
 *
 * @param isCommandOverride When provided, it wins over the regex derivation.
 */
export function registerQueuedUpdate(
  topicKey: string,
  updateId: number,
  text: string,
  isCommandOverride?: boolean,
): QueueEntry {
  const entry: QueueEntry = {
    updateId,
    text,
    isCommand: isCommandOverride ?? /^\//.test(text.trim()),
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
  const entries = drainQueuedEntries(topicKey);
  const texts: string[] = [];
  for (const entry of entries) {
    if (entry.text) texts.push(entry.text);
  }
  return texts;
}

/**
 * Cancels and returns full QueueEntry objects (with voice promises) for
 * non-command entries, in arrival order. Command entries left in place.
 * Returns [] for absent/empty topic.
 */
export function drainQueuedEntries(topicKey: string): QueueEntry[] {
  const arr = queues.get(topicKey);
  if (!arr || arr.length === 0) return [];
  const result: QueueEntry[] = [];
  const remaining: QueueEntry[] = [];
  for (const entry of arr) {
    if (entry.isCommand) {
      remaining.push(entry);
      continue;
    }
    entry.cancelled = true;
    result.push(entry);
  }
  if (remaining.length > 0) queues.set(topicKey, remaining);
  else queues.delete(topicKey);
  return result;
}

// --- Held entries (new) ---

const held = new Map<string, HeldItem[]>();

/**
 * Appends a formatted text or promise to the topic's held list (in-memory only).
 */
export function addHeldEntry(topicKey: string, item: HeldItem): void {
  const arr = held.get(topicKey);
  if (arr) arr.push(item);
  else held.set(topicKey, [item]);
}

/**
 * Returns and clears the topic's held entries. Returns [] if absent.
 * Awaits promise items in list order and formats them as strings.
 */
export async function absorbHeldEntries(topicKey: string): Promise<string[]> {
  const arr = held.get(topicKey);
  if (!arr || arr.length === 0) return [];

  held.delete(topicKey);

  const result: string[] = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      result.push(item);
    } else {
      // Promise<VoiceResult> item: await it and format
      try {
        const vr = await item.promise;
        result.push(userTextFromVoiceResult(vr, item.descriptor));
      } catch {
        // If promise rejects, format a failure placeholder
        result.push(userTextFromVoiceResult(
          { ok: false, reason: 'transcribe-failed', message: 'Promise rejected' },
          item.descriptor
        ));
      }
    }
  }
  return result;
}

/** Test hook. */
export function _clearQueueForTest(): void {
  queues.clear();
}

/** Test hook: clears held entries. */
export function _clearHeldForTest(): void {
  held.clear();
}
