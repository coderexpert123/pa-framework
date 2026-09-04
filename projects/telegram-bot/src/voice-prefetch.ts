/**
 * voice-prefetch.ts
 *
 * Fire-and-forget prefetch of voice transcription results. Stores promises
 * keyed by `${topicKey}|${updateId}`, enabling /stop and /steer to hold
 * formatted transcripts without blocking the poll loop.
 *
 * Part of the voice-prefetch + stop/steer flush wave (2026-08-15).
 * Spec: internal design record for this wave (2026-08-15).
 */

import { transcribeVoiceMessage, formatTranscriptUserText, formatFailedTranscriptUserText } from './voice.js';
import type { VoiceResult, AudioAttachmentKind, VoiceDeps, TelegramAudioLike } from './voice.js';

export interface VoicePrefetchDescriptor {
  kind: AudioAttachmentKind;
  caption?: string;
  forwardedFrom?: string;
  messageDate?: string;
}

interface PrefetchKey {
  topicKey: string;
  updateId: number;
}

function prefetchKey({ topicKey, updateId }: PrefetchKey): string {
  return `${topicKey}|${updateId}`;
}

const prefetchMap = new Map<string, Promise<VoiceResult>>();

/**
 * Fire-and-forget. Stores the promise in an internal map keyed
 * `${topicKey}|${updateId}`. Never throws. Duplicate call overwrites
 * (same file_unique_id dest).
 *
 * Internal contract: catches any error from transcribeVoiceMessage and
 * resolves to a failure VoiceResult instead of rejecting.
 */
export function startPrefetch(
  topicKey: string,
  updateId: number,
  token: string,
  chatId: number,
  media: TelegramAudioLike,
  deps: VoiceDeps,
  kind: AudioAttachmentKind,
  descriptor: VoicePrefetchDescriptor,
): void {
  const key = prefetchKey({ topicKey, updateId });

  const promise = (async (): Promise<VoiceResult> => {
    try {
      return await transcribeVoiceMessage(token, chatId, media, deps, kind);
    } catch (error) {
      // Never throw: resolve to a failure VoiceResult
      return {
        ok: false,
        reason: 'transcribe-failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  })();

  prefetchMap.set(key, promise);
}

/**
 * Returns the stored promise, or undefined if no prefetch exists.
 * Does NOT consume the entry (promise remains in map for later lookup).
 */
export function lookupPrefetch(
  topicKey: string,
  updateId: number,
): Promise<VoiceResult> | undefined {
  const key = prefetchKey({ topicKey, updateId });
  return prefetchMap.get(key);
}

/**
 * Returns the stored promise AND deletes the map entry (one-time consume).
 * Returns undefined if no prefetch exists.
 */
export function consumePrefetch(
  topicKey: string,
  updateId: number,
): Promise<VoiceResult> | undefined {
  const key = prefetchKey({ topicKey, updateId });
  const promise = prefetchMap.get(key);
  if (promise !== undefined) {
    prefetchMap.delete(key);
  }
  return promise;
}

/**
 * Deletes the map entry without awaiting. Used for cancelled/flushed entries.
 * No-op if key doesn't exist.
 */
export function clearPrefetch(topicKey: string, updateId: number): void {
  const key = prefetchKey({ topicKey, updateId });
  prefetchMap.delete(key);
}

/**
 * Shared formatter: produces the exact same text the turn path and fold path use,
 * so they cannot drift. Delegates to voice.ts's formatTranscriptUserText /
 * formatFailedTranscriptUserText internally.
 */
export function userTextFromVoiceResult(
  vr: VoiceResult,
  descriptor: VoicePrefetchDescriptor,
): string {
  if (vr.ok) {
    return formatTranscriptUserText(vr.text, {
      truncated: vr.truncated,
      caption: descriptor.caption,
      kind: descriptor.kind,
      speakers: vr.speakers,
      forwardedFrom: descriptor.forwardedFrom,
    });
  } else {
    return formatFailedTranscriptUserText(descriptor.kind, vr.reason, {
      caption: descriptor.caption,
    });
  }
}

/** Test hook: clears all prefetch entries. */
export function _clearPrefetchForTest(): void {
  prefetchMap.clear();
}
