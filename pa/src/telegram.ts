import { randomBytes } from 'crypto';
import type { TelegramOutput } from './types.js';
import { log } from './lib/log.js';
import { sanitizeMdV2 } from './lib/mdv2.js';

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
 * Send text to a Telegram chat/thread using the given bot token.
 * Never throws — logs errors only.
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
): Promise<void> {
  const refId = `s-${randomBytes(2).toString('hex')}`;
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
      const res = await fetch(`${BASE}/bot${token}/sendMessage`, {
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
          body.text = (body.text as string).replace(/((?:\n\n)?)_Ref: ([a-z]+)\\?-([0-9a-f]{4})_$/, '$1Ref: $2-$3');
          try {
            const res2 = await fetch(`${BASE}/bot${token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            if (!res2.ok) {
              console.error(`[pa/telegram] sendToTelegram failed (plain-text fallback): ${res2.status} ${await res2.text()}`);
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
          }
        } else {
          console.error(`[pa/telegram] sendToTelegram failed: ${res.status} ${errorText}`);
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
    }
  }
}
