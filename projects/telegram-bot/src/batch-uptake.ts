/**
 * batch-uptake.ts — AI-209 batched uptake (2026-09-06).
 *
 * Compiles the leading run of a topic's queue into ONE combined prompt at a
 * natural drain. Called once per turn-start from runPollLoop's callback
 * (immediately after the held-absorb step, before processUpdate) — see
 * plans/2026-09-06-ai209-batch-uptake-SPEC.md §2.2 for the frozen algorithm.
 *
 * Contract: the caller passes the head (the update whose turn is starting —
 * already dequeued, so peekQueuedBatch sees only the followers still queued).
 * The compile is staged so a crash at any point loses nothing:
 *
 *   peek (mutates nothing) → resolve transcripts → partition fold/withhold →
 *   confirm (cancel + remove exactly the fold set) → mark each folded
 *   follower's durable record heldForTopic → return the plan.
 *
 * A withheld entry is left queued and untouched — it dispatches on its own
 * later turn, byte-identically to today. If the fold set is empty the compile
 * returns null with nothing mutated anywhere. Any throw propagates to the
 * call site, which logs and dispatches the head alone.
 */

import {
  peekQueuedBatch,
  confirmQueuedBatch,
  snapshotDrained,
  type QueueEntry,
  type AudioMediaIdentity,
} from './topic-queue.js';
import { updatePendingDispatch, pendingDispatchKey } from './pending-dispatches.js';
import type { AudioAttachmentKind } from './voice.js';
import { logger } from '../../../pa/dist/src/lib/log.js';

/** Exact-label set of placeholderDispatchText's labels (main.ts:1170-1176).
 *  Exact match ⇒ no caption. Drift obligation: re-verify the label set at build
 *  time (SPEC §9 grep G2). */
const BARE_MEDIA_LABELS = ['[Voice message]', '[Audio file]', '[Video note]', '[Photo]', '[Document]', '[Video]'];

/** True only when `text` IS a bare media label, whole string — a captioned
 *  "[Photo] look at this" is foldable caption text, not a placeholder (SPEC §2.2 W2). */
function isBareMediaPlaceholder(text: string): boolean {
  return BARE_MEDIA_LABELS.includes(text);
}

export interface BatchFoldBlock {
  updateId: number;
  messageId?: number;
  text: string;
}

export interface BatchFoldPlan {
  combinedText: string;
  /** head first, then followers — send order */
  blocks: BatchFoldBlock[];
  foldedVoice: Array<{ text: string; media: AudioMediaIdentity; kind: AudioAttachmentKind; messageId?: number; via: 'batch' }>;
  /** followers only, fold order */
  foldedFrom: Array<{ updateId: number; messageId?: number }>;
  withheldIds: number[];
}

export interface BatchFoldInput {
  topicKey: string;
  chatId: number;
  threadId: number;
  /** The update whose turn is starting. Its text is post held-absorb, i.e. it
   *  already contains any held context (the absorb step runs before this compile). */
  head: { updateId: number; messageId?: number; text: string };
}

/**
 * Compile the topic's leading queued run into one combined prompt (SPEC §2.2).
 * Returns null — with NOTHING mutated — whenever today's single-message
 * behavior must stand: a slash-initial head (G4), an empty peeked run, or a
 * run whose every entry is withheld (empty fold set).
 */
export async function compileBatchFold(input: BatchFoldInput): Promise<BatchFoldPlan | null> {
  const { topicKey, chatId, threadId, head } = input;

  // Step 1 — G4: the head's own resolved text must not be slash-initial. Every
  // command interception in this bot is ^-anchored on the turn text; a batch
  // header in front of a command would defeat it. Prefix test, not single-token
  // (covers `/model agy`).
  if (/^\//.test(head.text.trim())) return null;

  // Step 2 — peek: leading run of non-command entries, arrival order. A queued
  // command bounds the batch. Mutates nothing.
  const peeked = peekQueuedBatch(topicKey);
  if (peeked.length === 0) return null;

  // Step 3 — resolve: freeze each transcript source, then await in peek order
  // (voice entries resolve through their own prefetch promise, including the
  // failure-marker fallback; text entries resolve verbatim).
  const texts = await Promise.all(snapshotDrained(peeked).map((d) => d.textPromise));

  // Step 4 — partition each peeked entry, in order.
  const foldEntries: QueueEntry[] = [];
  const foldTexts: string[] = [];
  const withheldIds: number[] = [];
  for (let i = 0; i < peeked.length; i++) {
    const entry = peeked[i];
    const text = texts[i];
    // W3 (fix-wave B3, 2026-09-06) — a queued /steer's OWN entry owns its turn:
    // the steer fold materializes there, so folding this entry would cancel the
    // steer (its callback early-returns on `cancelled` and the drained
    // transcripts never dispatch — SPEC §2.5's "steer wins" row). Normally the
    // steer entry is slash-initial (peek's isCommand boundary stops on it), but
    // the text-only steer handler rewrites the message text to the drained
    // texts + prompt BEFORE registration, so the entry can arrive here
    // non-command. Withhold it — left queued, untouched — exactly like W1/W2.
    if (entry.steerContext) {
      withheldIds.push(entry.updateId);
      logger.warn('batch-uptake', 'withheld steer entry from batch', { topicKey, updateId: entry.updateId });
      continue;
    }
    // W4 (AI-203 increment 3) — a reply-shaped entry carries the thread-FYI
    // anchor; folding it would lose the reply shape the anchor resolves from,
    // and letting a reply-shaped HEAD fold would steer its thread with the
    // whole combined text. Withheld — dispatches alone, byte-identically.
    if (entry.replyToMessageId !== undefined) {
      withheldIds.push(entry.updateId);
      logger.warn('batch-uptake', 'withheld reply anchor from batch', { topicKey, updateId: entry.updateId });
      continue;
    }
    // W1 (F7 amendment, 2026-09-06) — a command-initial entry must never fold
    // as plain text; the anchor depends on entry kind. A VOICE entry's resolved
    // text is label-prefixed by userTextFromVoiceResult (so "[Voice message]
    // /status" would never match), so the SAME /^\/ prefix test runs on the RAW
    // transcript read from the entry's own prefetch promise; a rejected or
    // failed prefetch is never a command and folds its failure-marker text
    // exactly as the steer fold does. A NON-voice entry anchors on the resolved
    // text. Prefix test, not single-token (covers "/model agy").
    if (entry.voice) {
      let vr: Awaited<NonNullable<QueueEntry['voice']>['promise']> | undefined;
      try {
        vr = await entry.voice.promise;
      } catch {
        vr = undefined; // rejection ⇒ not a command; fold the failure marker
      }
      if (vr?.ok && /^\//.test(vr.text.trim())) {
        withheldIds.push(entry.updateId);
        logger.warn('batch-uptake', 'withheld slash text from batch', { topicKey, updateId: entry.updateId });
        continue;
      }
    } else if (/^\//.test(text.trim())) {
      withheldIds.push(entry.updateId);
      logger.warn('batch-uptake', 'withheld slash text from batch', { topicKey, updateId: entry.updateId });
      continue;
    }
    // W2 — a voiceless bare media placeholder has no foldable content: its file
    // is materialized only by the attachment stage on its own turn.
    if (!entry.voice && isBareMediaPlaceholder(entry.text)) {
      withheldIds.push(entry.updateId);
      logger.warn('batch-uptake', 'withheld media placeholder from batch', { topicKey, updateId: entry.updateId });
      continue;
    }
    foldEntries.push(entry);
    foldTexts.push(text);
  }

  // Step 5 — empty fold set ⇒ null. The peek never mutated; the entries still
  // sit in the queue in arrival order.
  if (foldEntries.length === 0) return null;

  // Step 6 — confirm: cancel + remove exactly the fold set. The command
  // boundary and withheld entries stay queued.
  confirmQueuedBatch(topicKey, foldEntries);

  // Step 7 — crash-window hold: cover the window from compile to delivery in
  // the DURABLE record, so the reaper skips the folded followers (no death
  // notice, no requeue) and the next dispatch absorbs them instead.
  await Promise.all(foldEntries.map((entry) =>
    updatePendingDispatch(pendingDispatchKey(chatId, threadId, entry.updateId), {
      heldForTopic: true,
      heldAt: new Date().toISOString(),
    })));

  // Step 8 — build the plan and log it.
  const headBlock: BatchFoldBlock = { updateId: head.updateId, text: head.text };
  if (head.messageId !== undefined) headBlock.messageId = head.messageId;

  const followerBlocks: BatchFoldBlock[] = foldEntries.map((entry, i) => {
    const block: BatchFoldBlock = { updateId: entry.updateId, text: foldTexts[i] };
    if (entry.messageId !== undefined) block.messageId = entry.messageId;
    return block;
  });
  const blocks = [headBlock, ...followerBlocks];

  const foldedVoice: BatchFoldPlan['foldedVoice'] = [];
  const foldedFrom: BatchFoldPlan['foldedFrom'] = [];
  foldEntries.forEach((entry, i) => {
    const from: { updateId: number; messageId?: number } = { updateId: entry.updateId };
    if (entry.messageId !== undefined) from.messageId = entry.messageId;
    foldedFrom.push(from);
    if (entry.voice) {
      const item: BatchFoldPlan['foldedVoice'][number] = {
        text: foldTexts[i],
        media: entry.voice.media,
        kind: entry.voice.kind,
        via: 'batch',
      };
      if (entry.messageId !== undefined) item.messageId = entry.messageId;
      foldedVoice.push(item);
    }
  });

  // §2.3 (frozen): header, blank line, then blocks joined by blank lines; each
  // block is `[msg <message_id>]` + newline + text, or bare text when the
  // entry carries no messageId (never fabricate an id).
  const rendered = blocks.map((b) => (b.messageId !== undefined ? `[msg ${b.messageId}]\n${b.text}` : b.text));
  const combinedText = `[Batched: ${blocks.length} messages, in the order they were sent]\n\n${rendered.join('\n\n')}`;

  logger.info('batch-uptake', 'compiled batch', {
    topicKey,
    head: head.updateId,
    folded: foldEntries.length,
    withheld: withheldIds,
  });

  return { combinedText, blocks, foldedVoice, foldedFrom, withheldIds };
}
