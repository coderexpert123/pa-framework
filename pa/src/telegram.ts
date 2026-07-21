import { randomBytes } from 'crypto';
import type { TelegramOutput } from './types.js';
import { log } from './lib/log.js';
import { sanitizeMdV2 } from './lib/mdv2.js';
import { telegramFetch } from './lib/telegram-proxy.js';

const BASE = 'https://api.telegram.org';
const MAX_MSG_LEN = 4000;

export function splitMessage(text: string): string[] {
  if (text.length <= MAX_MSG_LEN) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_MSG_LEN) {
    let cut = remaining.lastIndexOf('\n\n', MAX_MSG_LEN);
    if (cut === -1) cut = remaining.lastIndexOf('\n', MAX_MSG_LEN);
    if (cut === -1) cut = MAX_MSG_LEN;

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Outcome of a send. Returned (never thrown) so callers — notably
 * `lib/notify.ts` — can tell a delivered message from a rejected one.
 *
 * Before 2026-07-21 this function returned `Promise<void>` and merely
 * console.error'd failures, so `notifyUser` recorded dedup state and logged
 * `sent:true` for messages Telegram had rejected (the audit found 293
 * "400 Bad Request: chat_id is empty" responses and ~97 alerts logged as
 * delivered that never arrived). Do NOT regress this back to `void`.
 */
export type SendResult =
  | { ok: true; chunks: number }
  | {
      ok: false;
      reason: 'http' | 'network' | 'no-chat-id' | 'empty-text';
      status?: number;
      detail?: string;
    };

const DETAIL_MAX_LEN = 300;

function detailOf(err: unknown): string {
  return String((err as { message?: string })?.message ?? err).slice(0, DETAIL_MAX_LEN);
}

function httpFailure(status: number, detail: string): SendResult {
  return { ok: false, reason: 'http', status, detail: detail.slice(0, DETAIL_MAX_LEN) };
}

function networkFailure(err: unknown): SendResult {
  return { ok: false, reason: 'network', detail: detailOf(err) };
}

/**
 * Send text to a Telegram chat/thread using the given bot token.
 * Never throws — logs errors and returns a `SendResult` describing the outcome.
 *
 * @param parseMode Optional parse mode override. Pass `false` for plain-text
 *  (no parse_mode in payload). Pass `'MarkdownV2'` to route through
 *  `sanitizeMdV2` (the body is escaped before the italic `_Ref: <id>_`
 *  trailer is appended raw). Defaults to legacy `'Markdown'`.
 */
export async function sendToTelegram(
  text: string,
  config: TelegramOutput,
  token: string,
  parseMode?: string | false,
): Promise<SendResult> {
  const refId = `s-${randomBytes(6).toString('hex')}`;

  // Preflight guards — both of these produce a guaranteed Telegram 400, so we
  // refuse to issue the HTTP call at all and report the reason to the caller.
  if (!String(config.chat_id || '').trim()) {
    console.error('[pa/telegram] sendToTelegram aborted: chat_id is empty');
    log('error', 'telegram', 'send aborted — empty chat_id', {
      refId,
      threadId: config.thread_id,
    });
    return { ok: false, reason: 'no-chat-id' };
  }
  if (!text || !text.trim()) {
    console.error('[pa/telegram] sendToTelegram aborted: message text is empty');
    log('error', 'telegram', 'send aborted — empty text', {
      refId,
      chatId: config.chat_id,
      threadId: config.thread_id,
    });
    return { ok: false, reason: 'empty-text' };
  }

  // For MarkdownV2 callers, sanitize the body so identifiers (node_modules,
  // snake_case), Windows paths, parens, etc. don't trigger parse failures.
  // The italic `_Ref: <id>_` trailer is appended AFTER sanitize so its markers
  // survive raw and render as italic. Body that happens to literally contain
  // `_Ref: ...` will have its underscores escaped (`\_Ref: ...\_`) which means
  // the fallback regex on line ~75 won't match the body occurrence — only the
  // appended trailer. That's the desired behavior.
  // The `-` inside the refId (e.g. `s-9b43`) MUST be escaped under MdV2 even
  // inside the italic span — Telegram rejects raw `-` everywhere outside code.
  const safeBody = parseMode === 'MarkdownV2' ? sanitizeMdV2(text.trim()) : text.trim();
  const refTrailer = parseMode === 'MarkdownV2' ? `_Ref: ${refId.replace('-', '\\-')}_` : `_Ref: ${refId}_`;
  const textWithRef = `${safeBody}\n\n${refTrailer}`;
  const chunks = splitMessage(textWithRef);

  // First failure wins; remaining chunks are still attempted (unchanged
  // behavior) so a mid-message failure doesn't swallow the rest of the output.
  let failure: SendResult | null = null;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    const body: Record<string, unknown> = {
      chat_id: config.chat_id,
      text: chunk,
      parse_mode: parseMode === false ? undefined : (parseMode ?? 'Markdown'),
    };
    if (config.thread_id !== undefined && config.thread_id !== 0) {
      body.message_thread_id = config.thread_id;
    }

    try {
      const res = await telegramFetch(`${BASE}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorText = await res.text();
        // Fallback: retry as plain text if Markdown parse fails
        if (errorText.includes('parse')) {
          delete body.parse_mode;
          // Strip italic markers from ref ID so it shows as "Ref: xxx" not "_Ref: xxx_" in plain text.
          // The optional (\n\n)? handles the edge case where splitMessage puts the ref into its own chunk.
          // The optional `\\` matches the dash escape for MdV2 (`s\-9b43`) — capture id as
          // prefix + hex separately so output is always clean `Ref: s-9b43` regardless of input form.
          body.text = (body.text as string).replace(/((?:\n\n)?)_Ref: ([a-z]+)\\?-([0-9a-f]{4,})_$/, '$1Ref: $2-$3');
          try {
            const res2 = await telegramFetch(`${BASE}/bot${token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            if (!res2.ok) {
              const errorText2 = await res2.text();
              console.error(`[pa/telegram] sendToTelegram failed (plain-text fallback): ${res2.status} ${errorText2}`);
              log('error', 'telegram', 'send failed (plain-text fallback)', {
                refId,
                chatId: config.chat_id,
                threadId: config.thread_id,
                chunkIndex,
                status: res2.status,
                detail: errorText2.slice(0, DETAIL_MAX_LEN),
              });
              failure ??= httpFailure(res2.status, errorText2);
            } else {
              log('info', 'telegram', 'skill message sent (plain-text fallback)', {
                refId,
                chatId: config.chat_id,
                threadId: config.thread_id,
                chunkIndex,
                textPreview: (body.text as string).slice(0, 500),
              });
            }
          } catch (err) {
            console.error('[pa/telegram] sendToTelegram plain-text fallback error:', err);
            log('error', 'telegram', 'send error (plain-text fallback)', {
              refId,
              chatId: config.chat_id,
              threadId: config.thread_id,
              chunkIndex,
              detail: detailOf(err),
            });
            failure ??= networkFailure(err);
          }
        } else {
          console.error(`[pa/telegram] sendToTelegram failed: ${res.status} ${errorText}`);
          log('error', 'telegram', 'send failed', {
            refId,
            chatId: config.chat_id,
            threadId: config.thread_id,
            chunkIndex,
            status: res.status,
            detail: errorText.slice(0, DETAIL_MAX_LEN),
          });
          failure ??= httpFailure(res.status, errorText);
        }
      } else {
        log('info', 'telegram', 'skill message sent', {
          refId,
          chatId: config.chat_id,
          threadId: config.thread_id,
          chunkIndex,
          textPreview: chunk.slice(0, 500),
        });
      }
    } catch (err) {
      console.error('[pa/telegram] sendToTelegram network error:', err);
      log('error', 'telegram', 'send network error', {
        refId,
        chatId: config.chat_id,
        threadId: config.thread_id,
        chunkIndex,
        detail: detailOf(err),
      });
      failure ??= networkFailure(err);
    }
  }

  return failure ?? { ok: true, chunks: chunks.length };
}
