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
import { logger } from '../../../pa/dist/src/lib/log.js';

/** Minimal structural logger so tests can inject a fake via `_setLoggerForTest` (AI-208 E2). */
type TopicQueueLogger = {
  info: (module: string, message: string, ctx?: Record<string, unknown>) => void;
};
let log: TopicQueueLogger = logger;

export type HeldItem =
  | string
  | { promise: Promise<VoiceResult>; descriptor: VoicePrefetchDescriptor; updateId?: number }
  | { text: string; updateId?: number };

/** Shared audio media identity (AI-208 fix-wave m4): the subset of a Telegram
 *  voice/audio/video_note attachment that the fold echo and the durable audio
 *  index need. `duration` is REQUIRED because `recordAudioMessage`'s media type
 *  (voice.ts `TelegramAudioLike`) requires it — the fold path always holds the
 *  real attachment object, so nothing has to fabricate a value. */
export interface AudioMediaIdentity {
  file_id: string;
  file_unique_id: string;
  duration: number;
}

export interface SteerFoldContext {
  /** Drained entries carrying voice promises. The normalizer awaits them. */
  drainedEntries: QueueEntry[];
  /** Drain-time transcript snapshots (fix-wave M3). Required so the compiler
   *  — not an `as any` cast — checks the safety net's precondition. */
  drained: DrainedTranscript[];
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
    /** Telegram audio identity, for the echo and /retranscribe (AI-208 E1). */
    media: AudioMediaIdentity;
    kind: 'voice' | 'audio' | 'video_note';
  };
  /** Set by the steer handler for voice-steer entries (D1). */
  steerContext?: SteerFoldContext;
  /** Telegram message_id, set at register (AI-209). Lets the batch compile
   *  label blocks and write provenance without a listPendingDispatches
   *  round-trip. */
  messageId?: number;
}

const queues = new Map<string, QueueEntry[]>();

/**
 * Registers a not-yet-started update for a topic. Call before its dispatch turn begins.
 *
 * @param isCommandOverride When provided, it wins over the regex derivation.
 * @param messageId Telegram message_id, when available (AI-209); set on the
 *   entry when provided, left undefined otherwise.
 */
export function registerQueuedUpdate(
  topicKey: string,
  updateId: number,
  text: string,
  isCommandOverride?: boolean,
  messageId?: number,
): QueueEntry {
  const entry: QueueEntry = {
    updateId,
    text,
    isCommand: isCommandOverride ?? /^\//.test(text.trim()),
    cancelled: false,
  };
  if (messageId !== undefined) entry.messageId = messageId;
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
 * Leading run of non-command entries, arrival order; stops at the first
 * command. Mutates NOTHING (AI-209 batched uptake) — the caller inspects the
 * run, partitions it into fold/withhold, and confirms only the fold set.
 * Returns [] for absent topics, empty arrays, and a queue whose head is a
 * command. Every peek is logged, including the zero case (AI-208 E2 evidence
 * convention) — a `peeked batch` line with `count: 0` is the proof a natural
 * drain considered batching and found nothing eligible.
 */
export function peekQueuedBatch(topicKey: string): QueueEntry[] {
  const arr = queues.get(topicKey);
  const result: QueueEntry[] = [];
  if (arr) {
    for (const entry of arr) {
      if (entry.isCommand) break;
      result.push(entry);
    }
  }
  log.info('batch-uptake', 'peeked batch', { topicKey, count: result.length });
  return result;
}

/**
 * Cancels and removes exactly the given entries (identity compare via
 * `indexOf`), leaving the command boundary and any withheld entries in place
 * (AI-209 batched uptake). Deletes the topic's array once it empties, matching
 * `dequeueUpdate`'s map-hygiene convention. One INFO line per confirmed entry.
 */
export function confirmQueuedBatch(topicKey: string, entries: QueueEntry[]): void {
  const arr = queues.get(topicKey);
  if (!arr) return;
  for (const entry of entries) {
    const idx = arr.indexOf(entry);
    if (idx === -1) continue;
    arr.splice(idx, 1);
    entry.cancelled = true;
    log.info('batch-uptake', 'confirmed batch entry', {
      topicKey,
      updateId: entry.updateId,
      hasVoice: !!entry.voice,
    });
  }
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
 *
 * Every drain is logged, including the zero case (AI-208 E2) — an absent
 * `drained 0 entry(ies)` line is the evidence that a steer found nothing
 * queued, which is how a dropped transcript gets distinguished from one
 * that was never queued at all.
 */
export function drainQueuedEntries(topicKey: string, reason?: string): QueueEntry[] {
  const arr = queues.get(topicKey);
  const result: QueueEntry[] = [];
  if (arr && arr.length > 0) {
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
  }
  for (const entry of result) {
    log.info('steer-drain', 'drained queued entry', {
      topicKey,
      reason,
      updateId: entry.updateId,
      hasVoice: !!entry.voice,
      textLen: entry.text.length,
      cancelled: true,
    });
  }
  log.info('steer-drain', `drained ${result.length} entry(ies)`, { topicKey, reason, count: result.length });
  return result;
}

/**
 * A drain-time transcript whose source is frozen: the promise is captured now,
 * so a later `cancelled` mutation or a lost `voice` attach cannot degrade it
 * into a `[Voice message]` placeholder in the steer fold (AI-208 E3).
 */
export interface DrainedTranscript {
  updateId: number;
  textPromise: Promise<string>;
}

/**
 * Freezes each entry's transcript source at drain time. Voice entries resolve
 * through their own prefetch promise (falling back to the pre-transcription
 * placeholder text if it rejects); text entries resolve verbatim.
 */
export function snapshotDrained(entries: QueueEntry[]): DrainedTranscript[] {
  return entries.map((entry) => ({
    updateId: entry.updateId,
    textPromise: entry.voice
      ? entry.voice.promise
          .then(vr => userTextFromVoiceResult(vr, entry.voice!.descriptor))
          // Fix-wave B1: format the rejection HERE — the bare placeholder text
          // this catch used to return is a success shape and is forbidden in a
          // fold by WP-2 case 4.
          .catch(() => userTextFromVoiceResult(
            { ok: false, reason: 'transcribe-failed', message: 'Transcription failed' },
            entry.voice!.descriptor,
          ))
      : Promise.resolve(entry.text),
  }));
}

// --- Held entries (new) ---

const held = new Map<string, HeldItem[]>();

/**
 * Appends a formatted text or promise to the topic's held list (in-memory only).
 * Logged (AI-208 E4): a held entry is the "explicitly held" state requirement 1
 * asks for, so it must leave a trace.
 */
export function addHeldEntry(topicKey: string, item: HeldItem): void {
  const arr = held.get(topicKey);
  if (arr) arr.push(item);
  else held.set(topicKey, [item]);
  log.info('steer-hold', 'held entry', {
    topicKey,
    chars: typeof item === 'string' ? item.length : 'text' in item ? item.text.length : 0,
    isPromise: typeof item !== 'string' && !('text' in item),
  });
}

/**
 * Returns and clears the topic's held entries. Returns [] if absent.
 * Awaits promise items in list order and formats them as strings.
 *
 * Fix-wave M1: each result carries the source item's `updateId` when the hold
 * site provided one, so main.ts's normalizer can dedup the in-memory absorb
 * against the durable `absorbHeldDispatchRecords` half by updateId (string
 * items carry `undefined`; text-object holds — the FX-A addendum — carry
 * theirs, closing the /stop-held-text double-emit gap).
 */
export async function absorbHeldEntries(
  topicKey: string,
): Promise<Array<{ text: string; updateId?: number }>> {
  const arr = held.get(topicKey);
  if (!arr || arr.length === 0) return [];

  held.delete(topicKey);

  const result: Array<{ text: string; updateId?: number }> = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      result.push({ text: item });
    } else if ('text' in item) {
      result.push(item.updateId !== undefined ? { text: item.text, updateId: item.updateId } : { text: item.text });
    } else {
      // Promise<VoiceResult> item: await it and format
      let text: string;
      try {
        const vr = await item.promise;
        text = userTextFromVoiceResult(vr, item.descriptor);
      } catch {
        // If promise rejects, format a failure placeholder
        text = userTextFromVoiceResult(
          { ok: false, reason: 'transcribe-failed', message: 'Promise rejected' },
          item.descriptor
        );
      }
      result.push(item.updateId !== undefined ? { text, updateId: item.updateId } : { text });
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

/** Test hook: injects a fake logger (pass null to restore the real one). */
export function _setLoggerForTest(fake: TopicQueueLogger | null): void {
  log = fake ?? logger;
}
