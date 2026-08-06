/**
 * Reply-context resolution (hardened plan: "federated-booping-hammock" (Claude Code plan-mode session), WP5).
 *
 * `extractReplyContext` is moved here verbatim from main.ts (byte-for-byte
 * behaviorally identical — main.ts re-exports it once WP6 lands, so
 * poll-loop.test.ts's existing cases need zero edits). `resolveReplyContext`
 * is the new entry point: it upgrades reply-to-voice (and reply-to-any-media)
 * resolution by consulting the in-memory topic-turn window and, failing
 * that, a narrow live-archive fallback, before falling through to today's
 * reply_to_message.text/.caption behavior and finally a media-stub.
 */

import type { ConversationState, ConversationTurn } from './types.js';
import { findArchivedTurnByMessageId } from './conversation.js';
import { isDegraded } from './health.js';

// Exported for unit testing. Signature intentionally unchanged from the
// original main.ts version so callers (and poll-loop.test.ts) keep compiling
// structurally once WP6 re-exports from here.
export function extractReplyContext(msg: { quote?: { text: string }; reply_to_message?: { text?: string; caption?: string } }): string | undefined {
  return msg.quote?.text || msg.reply_to_message?.text || msg.reply_to_message?.caption;
}

/** Duck-typed subset of the media fields a replied-to message may carry.
 * Deliberately NOT imported from types.ts (audio/video_note land there in
 * WP6) — a real TelegramMessage satisfies this structurally once those
 * fields exist. */
export interface RepliedMediaLike {
  voice?: { duration?: number };
  audio?: { duration?: number; file_name?: string };
  video_note?: { duration?: number };
  photo?: unknown[];
  document?: { file_name?: string };
}

/** One-line stub for a voice/audio/video_note/photo/document reply that
 * produced nothing from steps 1–4 of resolveReplyContext (e.g. replying to a
 * *failed* note, or one that predates this fix). Better than the silent
 * `undefined` this bot returned before. */
export function describeRepliedMedia(replyMsg: RepliedMediaLike | undefined): string | undefined {
  if (!replyMsg) return undefined;

  if (replyMsg.voice) {
    const suffix = typeof replyMsg.voice.duration === 'number' ? `, ${replyMsg.voice.duration}s` : '';
    return `[Voice message${suffix} — transcript not available in this bot's history]`;
  }
  if (replyMsg.audio) {
    const suffix = typeof replyMsg.audio.duration === 'number' ? `, ${replyMsg.audio.duration}s` : '';
    const name = replyMsg.audio.file_name ? `: ${replyMsg.audio.file_name}` : '';
    return `[Audio file${name}${suffix} — transcript not available in this bot's history]`;
  }
  if (replyMsg.video_note) {
    const suffix = typeof replyMsg.video_note.duration === 'number' ? `, ${replyMsg.video_note.duration}s` : '';
    return `[Video note${suffix} — transcript not available in this bot's history]`;
  }
  if (replyMsg.photo) {
    return `[Photo — no caption available in this bot's history]`;
  }
  if (replyMsg.document) {
    const name = replyMsg.document.file_name ? `: ${replyMsg.document.file_name}` : '';
    return `[Document${name} — not available in this bot's history]`;
  }

  return undefined;
}

export interface ReplyContextMessage {
  quote?: { text: string };
  reply_to_message?: {
    message_id?: number;
    text?: string;
    caption?: string;
  } & RepliedMediaLike;
}

export interface ResolveReplyContextDeps {
  /** Defaults to health.ts's isDegraded. Gates the archive fallback (step 3)
   * only — this is enrichment, not delivery, matching the existing AI-096
   * load-shedding posture. */
  degraded?: () => boolean;
  /** Defaults to conversation.ts's findArchivedTurnByMessageId. Injectable
   * for tests so they don't need a real archive file on disk. */
  archiveLookup?: (threadId: number, messageId: number) => Promise<string | null>;
}

function findLastUserTurnByMessageId(turns: ConversationTurn[], messageId: number): ConversationTurn | undefined {
  // Deliberately NOT Array.prototype.findLast — this repo's tsconfig target
  // is ES2022 (no "lib" override), which does not include the ES2023
  // findLast type declarations.
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role === 'user' && turn.message_id === messageId) return turn;
  }
  return undefined;
}

async function defaultArchiveLookup(threadId: number, messageId: number): Promise<string | null> {
  const turn = await findArchivedTurnByMessageId(threadId, messageId);
  return turn?.text ?? null;
}

/**
 * Resolution order (plan §WP5):
 *   1. msg.quote?.text (explicit user selection) — unchanged, wins first.
 *   2. The most recent user turn in topicState.turns whose message_id
 *      matches reply_to_message.message_id — returned verbatim. Assistant
 *      turns carry no message_id today, so this naturally never matches a
 *      bot reply and falls through to (4) with zero special-casing.
 *   3. A narrow archive fallback (findArchivedTurnByMessageId) for a note
 *      that's aged out of the topic-state window — only the LIVE
 *      conversation-history.jsonl, only when steps 1–2 found nothing, only
 *      when not degraded.
 *   4. reply_to_message.text || .caption — today's only behavior.
 *   5. describeRepliedMedia stub.
 *   6. undefined.
 *
 * Security note: ranking step 2 above step 4 means a reply to a redacted
 * /auth message resolves the *redacted* archived text, never the live OAuth
 * code still sitting in reply_to_message.text — see the dedicated test.
 */
export async function resolveReplyContext(
  msg: ReplyContextMessage,
  topicState: ConversationState,
  deps: ResolveReplyContextDeps = {}
): Promise<string | undefined> {
  if (msg.quote?.text) return msg.quote.text;

  const replyMsg = msg.reply_to_message;
  const replyId = replyMsg?.message_id;

  if (replyId !== undefined) {
    const turn = findLastUserTurnByMessageId(topicState.turns, replyId);
    if (turn) return turn.text;

    const degraded = deps.degraded ?? isDegraded;
    if (!degraded()) {
      const archiveLookup = deps.archiveLookup ?? defaultArchiveLookup;
      try {
        const archived = await archiveLookup(topicState.thread_id, replyId);
        if (archived) return archived;
      } catch {
        // Enrichment only — never let an archive-lookup fault block the
        // fallback chain below.
      }
    }
  }

  if (replyMsg?.text || replyMsg?.caption) return replyMsg.text || replyMsg.caption;

  return describeRepliedMedia(replyMsg);
}
