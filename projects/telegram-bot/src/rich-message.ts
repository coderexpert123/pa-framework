/**
 * Rich Messages (Bot API 10.1/10.2 `sendRichMessage`) — DEAD BY DEFAULT
 * (2026-08-24 buttons program, plans/2026-08-24-buttons-program-SPEC.md P8, §3.6, AI-159).
 *
 * The method is post-cutoff and its client rendering is unverified; the ONLY live call
 * is the orchestrator's integration probe (§7 step 9). Until `PA_RICH_MESSAGES=1` is set
 * in the environment, `shouldUseRichMessage` is always false and `sendReplyText` is a
 * pure pass-through to today's chunked `sendMessage` / `sendMessageWithKeyboard` path.
 * Any non-ok rich result falls back to that path, so enabling the flag can never lose
 * a reply.
 *
 * ORCHESTRATOR SKELETON: signatures FROZEN (with the WP-B1 edit-6 correction —
 * `sendReplyText` returns `{ delivered, messageId }`, not boolean — applied); WP-B4
 * fills the bodies.
 */

import { logger } from '../../../pa/dist/src/lib/log.js';
import { telegramFetch } from '../../../pa/dist/src/lib/telegram-proxy.js';
import { safeResponseText, sendMessage, sendMessageWithKeyboard } from './telegram.js';
import type { InlineKeyboardMarkup } from './telegram.js';

const BASE = 'https://api.telegram.org';

export const RICH_MIN_CHARS = 3500;

// A markdown table row: a line whose only non-trivial content is `|`-delimited cells.
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
// The header/body separator row of a markdown table, e.g. `|---|:--:|`.
const TABLE_SEP_RE = /^\s*\|[-: |]+\|\s*$/;

/** True when PA_RICH_MESSAGES==='1' AND (text.length > RICH_MIN_CHARS OR text contains a
 *  markdown table — a line matching /^\s*\|.*\|\s*$/m followed by a /^\s*\|[-: |]+\|\s*$/m). */
export function shouldUseRichMessage(text: string, env: NodeJS.ProcessEnv): boolean {
  if (env.PA_RICH_MESSAGES !== '1') return false;
  if (text.length > RICH_MIN_CHARS) return true;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (TABLE_ROW_RE.test(lines[i]) && TABLE_SEP_RE.test(lines[i + 1])) return true;
  }
  return false;
}

export interface RichSendResult { ok: boolean; status?: number; error?: string; }

export async function sendRichMessage(
  token: string, chatId: number, text: string, threadId?: number, replyToMessageId?: number,
): Promise<RichSendResult> {
  // Body shape verified LIVE 2026-08-24 22:12 IST (buttons program §7.9): the method
  // rejects `{text, parse_mode}` with 400 "rich message must be non-empty" and accepts
  // `{rich_message: {markdown}}` (HTTP 200, message 11282 in system-events).
  const body: Record<string, unknown> = {
    chat_id: chatId,
    rich_message: { markdown: text },
  };
  if (threadId !== undefined && threadId !== null && threadId !== 0) body.message_thread_id = threadId;
  if (replyToMessageId) body.reply_to_message_id = replyToMessageId;

  try {
    const res = await telegramFetch(`${BASE}/bot${token}/sendRichMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return { ok: true, status: res.status };
    const error = await safeResponseText(res);
    return { ok: false, status: res.status, error };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** The one entry point main.ts calls for a worker reply. Tries rich when
 *  shouldUseRichMessage (and NO replyMarkup is given — a rich send cannot carry a
 *  keyboard and returns messageId null), falls back to sendMessage /
 *  sendMessageWithKeyboard on ANY non-ok result. `messageId` is the first chunk's id
 *  from the normal path (null on failure or after a successful rich send). */
export async function sendReplyText(
  token: string,
  chatId: number,
  text: string,
  replyToMessageId: number | undefined,
  threadId: number | undefined,
  env: NodeJS.ProcessEnv,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<{ delivered: boolean; messageId: number | null }> {
  // A rich send cannot carry a keyboard — refuse the rich path outright whenever
  // replyMarkup is defined, regardless of the flag or text shape.
  if (replyMarkup === undefined && shouldUseRichMessage(text, env)) {
    const result = await sendRichMessage(token, chatId, text, threadId, replyToMessageId);
    if (result.ok) return { delivered: true, messageId: null };
    logger.warn('rich', 'sendRichMessage failed, falling back to sendMessage', {
      status: result.status,
      error: result.error,
    });
  }

  if (replyMarkup !== undefined) {
    const messageId = await sendMessageWithKeyboard(token, chatId, text, replyMarkup, replyToMessageId, threadId);
    return { delivered: messageId !== null, messageId };
  }

  const delivered = await sendMessage(token, chatId, text, replyToMessageId, threadId);
  return { delivered, messageId: null };
}
