/**
 * enqueue-normalizer.ts — AI-173 phase 4 (2026-09-06).
 *
 * Behavior-preserving extraction of the poll-loop enqueue normalizer out of
 * main.ts: enqueueUpdateForDispatch (the AI-095 enqueue-time placeholder
 * write, the A5 __skipVoice producer, topic-queue registration, the
 * steer-context attach and the arrival-time voice prefetch), settleVoicePrefetch
 * (the turn-start voice-result settle) and flushCheckAndAbsorbHeld (the /stop
 * flush-check and the held-absorb combine). isAcceptableUpdate and
 * placeholderDispatchText — the one shared accept/placeholder-text pair — moved
 * with them; main.ts imports the first and re-exports the second for its
 * existing importers. main.ts stays the composition root — nothing imports
 * main.ts from here, and the import graph is strictly leafward.
 * Spec: the AI-173 phase 4 design (2026-09-06, internal).
 */

import {
  registerQueuedUpdate, addHeldEntry, absorbHeldEntries,
  type QueueEntry, type SteerFoldContext,
} from './topic-queue.js';
import { addPendingDispatch, updatePendingDispatch, pendingDispatchKey, absorbHeldDispatchRecords } from './pending-dispatches.js';
import { isTopicStopped } from './worker-stop.js';
import { extractAudioAttachment, type AudioAttachmentKind, type VoiceResult } from './voice.js';
import {
  startPrefetch, lookupPrefetch, userTextFromVoiceResult, clearPrefetch,
  type VoicePrefetchDescriptor,
} from './voice-prefetch.js';
import { describeForwardOrigin } from './logic.js';
import { logger } from '../../../pa/dist/src/lib/log.js';

export interface EnqueueInput {
  update: any;                                    // the raw Telegram update
  allowedChatIds: Set<number>;
  topicKey: string;                               // getUpdateTopicKey's output, computed by the caller
  steerContexts: Map<number, SteerFoldContext>;   // the batch-loop side map (main.ts owns it)
}
export interface EnqueueDeps {
  token: string;                                  // startPrefetch's token
  repoRoot: string;                               // BOT_CWD — becomes VoiceDeps.repoRoot
  env: NodeJS.ProcessEnv;                         // { ...process.env, ...secrets } — cloud keys live in secrets
  transcription?: any;                            // config.transcription, read once at poll-loop start (A4)
}
export interface EnqueueResult {
  enqKey: string | undefined;                     // pendingDispatchKey, set iff the update was accepted
  queueEntry: QueueEntry | undefined;             // the registered entry, iff accepted
}
export interface NormalizeInput {
  update: any;
  queueEntry: QueueEntry | undefined;
  topicKey: string;
}

/**
 * Shared by processUpdate's own guard AND the poll loop's enqueue-time
 * pending-dispatch placeholder write (AI-095 follow-up, deep-recheck
 * 2026-07-08, Phase 1A) — kept as ONE predicate so the two checks can't
 * silently drift apart over time (e.g. if the allowed-chat logic later
 * grows a nuance, updating only one copy would reopen the "no placeholder
 * for a disallowed chat" gap).
 */
export function isAcceptableUpdate(update: any, allowedChatIds: Set<number>): boolean {
  const msg = update?.message;
  if (!msg) return false;
  // WPE3 (2026-08-18): documents and photos join the accepted set — they route
  // through the same dated-attachment substrate as voice. Disallowed TYPES are
  // accepted here then rejected with a polite local reply in the handler (the
  // placeholder/pending-dispatch record must be written at receipt for crash
  // recovery regardless of whether the type is processable).
  if (!msg.text && !msg.caption && !msg.voice && !msg.audio && !msg.video_note
      && !msg.document && !msg.photo) return false;
  if (!allowedChatIds.has(msg.chat?.id)) return false;
  return true;
}

/** Same shape isAcceptableUpdate/processUpdate agree on for the real archived
 * text (hardened plan WP6 item 3): a voice/audio/video_note marker wins over
 * a caption, matching formatTranscriptUserText's own precedence, rather than
 * the caption winning as the placeholder previously did. Kept next to
 * isAcceptableUpdate, for the same reason that predicate is — so the
 * two checks can't silently drift apart. An audio-mime document is left as a
 * plain caption dispatch here too — the "not transcribed" hint text only
 * exists on the real (post-transcription-attempt) path, not the placeholder. */
export function placeholderDispatchText(msg: any): string {
  const kind: AudioAttachmentKind | undefined = msg.voice ? 'voice' : msg.audio ? 'audio' : msg.video_note ? 'video_note' : undefined;
  let label: string | undefined;
  if (kind) {
    label = kind === 'voice' ? '[Voice message]' : kind === 'audio' ? '[Audio file]' : '[Video note]';
  } else if (msg.photo) {
    label = '[Photo]';
  } else if (msg.document) {
    label = '[Document]';
  } else if (msg.video) {
    label = '[Video]';
  }
  if (label) {
    return msg.caption ? `${label} ${msg.caption}`.trim() : label;
  }
  return (msg.text || msg.caption || '').trim();
}

export async function enqueueUpdateForDispatch(input: EnqueueInput, deps: EnqueueDeps): Promise<EnqueueResult> {
  const { update, allowedChatIds, topicKey, steerContexts } = input;
  // AI-095 follow-up (deep-recheck 2026-07-08, Phase 1A): persist a
  // minimal placeholder record for this update BEFORE it's chained
  // into topicPending — a same-topic update queued behind a
  // still-running predecessor previously existed only in this
  // in-memory chain until its OWN processUpdate reached the
  // dispatch-time addPendingDispatch call (which can be minutes
  // later), and the poll offset covering it is confirmed to
  // Telegram (below) well before that. A crash in that window lost
  // the update with zero trace. Awaited here, synchronously within
  // the loop, so it is guaranteed on disk before saveState(state).
  let enqKey: string | undefined;
  let queueEntry: QueueEntry | undefined;
  if (isAcceptableUpdate(update, allowedChatIds) && update.message) {
    const m = update.message;
    const eChatId = m.chat.id;
    const eThreadId = m.message_thread_id ?? 0;
    const userText = placeholderDispatchText(m);
    enqKey = pendingDispatchKey(eChatId, eThreadId, update.update_id);
    // E8/A5: Compute isCommandOverride from caption for voice/audio/video notes.
    // Command-captioned media skips transcription entirely.
    const hasAudio = !!(m.voice || m.audio || m.video_note);
    let isCommandOverride: boolean | undefined = undefined;
    let skipVoice = false;
    if (hasAudio && m.caption) {
      const captionTrimmed = (m.caption ?? '').trim();
      if (/^\//.test(captionTrimmed)) {
        isCommandOverride = true;
        skipVoice = true; // A5: __skipVoice for command-captioned media
      }
    }
    // A4: Start prefetch for non-command audio-bearing messages.
    // transcription config is hoisted at poll loop level. DEFERRED to
    // after the enqueue-time placeholder write below: the AI-095
    // invariant tests gate on the first /getFile (the prefetch's
    // download) and must observe the placeholder already persisted —
    // trace-before-spawned-work is also the crash-window-safe order.
    let voiceField: QueueEntry['voice'] = undefined;
    // A5: Store __skipVoice on update for processUpdate to check.
    if (skipVoice) {
      (update as any).__skipVoice = true;
    }
    // Registered BEFORE addPendingDispatch/chaining so a /steer arriving
    // later in this same batch (processed further down this same loop)
    // can already see this update as "queued" and fold it in — see
    // topic-queue.ts.
    // AI-209: the message_id rides the queue entry so the batch compile
    // can label `[msg <id>]` blocks and write foldedFrom provenance
    // (SPEC §1/§4.1 - the entry field is dead without this argument).
    queueEntry = registerQueuedUpdate(topicKey, update.update_id, userText, isCommandOverride, m.message_id, m.reply_to_message?.message_id);
    // Attach steerContext from the side map if present.
    const steerCtx = steerContexts.get(update.update_id);
    if (steerCtx) {
      queueEntry.steerContext = steerCtx;
    }
    // B6: Hoist extractAudioAttachment for voiceFileId and reuse later.
    const eAudio = hasAudio ? extractAudioAttachment(m) : undefined;
    await addPendingDispatch({
      updateId: update.update_id,
      chatId: eChatId,
      threadId: eThreadId,
      messageId: m.message_id,
      userText,
      startedAt: new Date().toISOString(),
      ...(eAudio ? { voiceFileId: eAudio.media.file_id } : {}),
      ...((update as any).__requeueCount !== undefined
        ? { requeueCount: (update as any).__requeueCount as number } : {}),
      // Deliberately no cwd/session — those aren't known until
      // topicState loads inside processUpdate. The dispatch-time
      // addPendingDispatch call (same key) overwrites this with the
      // full record; if a crash strands this placeholder as the
      // only record, the reaper sends a death notice quoting the
      // user's own raw text back to them.
    }).catch((err) => logger.warn('dispatch', 'failed to persist enqueue-time placeholder', { error: String(err) }));
    // A4 (post-placeholder): start the prefetch and attach the voice
    // field. env must include SECRETS (cloud API keys live there) —
    // process.env alone would silently strand prefetch on the local
    // engine (loopRuntimeEnv is built once at poll-loop start).
    if (hasAudio && !skipVoice) {
      const media = eAudio;
      if (media) {
        const descriptor: VoicePrefetchDescriptor = {
          kind: media.kind,
          caption: m.caption,
          forwardedFrom: describeForwardOrigin(m),
          messageDate: new Date(m.date * 1000).toISOString(),
        };
        const callDeps = { repoRoot: deps.repoRoot, env: deps.env, transcription: deps.transcription, threadId: eThreadId };
        startPrefetch(topicKey, update.update_id, deps.token, eChatId, media.media, callDeps, media.kind, descriptor);
        const prefetch = lookupPrefetch(topicKey, update.update_id);
        if (prefetch) {
          voiceField = { promise: prefetch, descriptor, media: media.media, kind: media.kind };
        }
        if (voiceField) {
          const vf = voiceField;
          queueEntry.voice = vf;
          // Edit A (2026-08-27 voice-transcript-backfill spec): when the
          // arrival-time prefetch settles, merge the formatted text into
          // the enqueue-time placeholder record. updatePendingDispatch
          // merges (never clobbers cwd/session/teePath) and no-ops once
          // the record is removed (turn cleanup in the .finally() below,
          // or the reaper's finish()). Fires only post-settle, strictly
          // AFTER the awaited placeholder write above — the AI-095
          // placeholder-before-spawned-work order is untouched.
          const backfillKey = enqKey;
          vf.promise
            .then((vr) => {
              if (!backfillKey) return;
              return updatePendingDispatch(backfillKey, {
                userText: userTextFromVoiceResult(vr, vf.descriptor),
                userTextSettled: true,
              });
            })
            .catch((err) => logger.warn('dispatch', 'transcript backfill failed', { error: String(err) }));
        }
      }
    }
  }
  return { enqKey, queueEntry };
}

export async function settleVoicePrefetch(update: any, queueEntry: QueueEntry | undefined): Promise<void> {
  if (queueEntry?.voice) {
    try {
      const vr = await queueEntry.voice.promise;
      (update as any).__voiceResult = vr;
    } catch {
      // Should never happen (startPrefetch catches), but defensive.
    }
  }
}

export async function flushCheckAndAbsorbHeld(input: NormalizeInput): Promise<boolean> {
  const { update, queueEntry, topicKey } = input;
  // --- Flush-check (step C.2, A8) ---
  if (isTopicStopped(topicKey, update.update_id)) {
    const vr = (update as any).__voiceResult as VoiceResult | undefined;
    const desc = queueEntry?.voice?.descriptor;
    if (!queueEntry?.isCommand) {
      const text = vr && desc
        ? userTextFromVoiceResult(vr, desc)
        : queueEntry?.text ?? placeholderDispatchText(update.message);
      addHeldEntry(topicKey, { text, updateId: update.update_id });
      if (queueEntry?.voice) clearPrefetch(topicKey, queueEntry.updateId);
      return false; // Do NOT run processUpdate
    }
    // A8: Commands never hold and always proceed to processUpdate.
    // Still clean up prefetch if any.
    if (queueEntry?.voice) clearPrefetch(topicKey, queueEntry.updateId);
  }
  // --- Held absorb (step C.3, A2) ---
  if (!queueEntry?.isCommand) {
    const held = await absorbHeldEntries(topicKey);
    // M1 rule 1: records whose updateId the in-memory absorb just
    // delivered are consumed WITHOUT emitting — a /stop-held transcript
    // reaches the next prompt exactly once.
    const coveredIds = new Set<number>();
    for (const h of held) {
      if (h.updateId !== undefined) coveredIds.add(h.updateId);
    }
    const sChatId = update.message?.chat.id;
    const sThreadId = update.message?.message_thread_id ?? 0;
    const durableHeld = sChatId !== undefined ? await absorbHeldDispatchRecords(sChatId, sThreadId, coveredIds) : [];
    const allHeld = [...held.map(h => h.text), ...durableHeld];
    if (allHeld.length > 0) {
      let ownText: string;
      const vr = (update as any).__voiceResult as VoiceResult | undefined;
      if (vr && queueEntry?.voice?.descriptor) {
        ownText = userTextFromVoiceResult(vr, queueEntry.voice.descriptor);
        (update as any).__heldAbsorbed = true; // D2
      } else if (update.message) {
        ownText = (update.message.text || update.message.caption || '').trim();
      } else {
        ownText = '';
      }
      if (update.message) {
        update.message = { ...update.message, text: [...allHeld, ...(ownText ? [ownText] : [])].join('\n\n') };
      }
    }
  }
  return true;
}
