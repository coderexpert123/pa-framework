import { randomBytes } from 'crypto';
import type { TelegramOutput } from './types.js';
import { log } from './lib/log.js';
import { sanitizeMdV2, normalizeMarkdown } from './lib/mdv2.js';
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
 * Parse Telegram 429 retry_after from response body.
 * Returns the seconds to wait (capped at 60), or null if unparseable.
 * AI-149: honors Telegram's rate-limit signal instead of blind retries.
 */
function parseRetryAfter(body: string): number | null {
  try {
    const parsed = JSON.parse(body);
    const raw = parsed?.parameters?.retry_after;
    if (typeof raw === 'number') {
      return Math.min(raw, 60); // cap at 60s
    }
  } catch {
    // JSON parse fails → treat as unparseable
  }
  return null;
}

/**
 * Sleep for N milliseconds. Mirrors the pattern in lib/notify.ts.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
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
 *
 * Ref handling: a fresh `s-` ref is minted and appended UNLESS the text
 * already ends with a caller-stamped `_Ref: <prefix>-<hex>_` trailer — that
 * id is reused verbatim (extracted before sanitization, re-appended raw), so
 * a message never carries two refs and its delivery log row keys under the
 * caller's id.
 */
export async function sendToTelegram(
  text: string,
  config: TelegramOutput,
  token: string,
  parseMode?: string | false,
  /** Inline keyboard attached to the LAST chunk only (one keyboard per message;
   *  the press must land where the reader finishes). Carried into the plain-text
   *  fallback because that path mutates the same `body` (2026-08-24 buttons program, P3). */
  replyMarkup?: Record<string, unknown>,
): Promise<SendResult> {
  // AI-184 (2026-09-03): the send body is the OPERATOR'S OWN CHAT — alerts, the
  // `pa notify` command and every skill's telegram_output deliver here — so the
  // text is deliberately NOT redacted on this path. Redacting here scrubbed the
  // operator's name out of their own chat and corrupted name-bearing outbound
  // drafts in transit (wa.me prefill text). The scrub lives on the log side:
  // every context logged below (textPreview, detail) redacts inside the logger
  // (lib/log.ts), which is the surviving seam — the name reaches the operator's
  // eyes, never the logs.
  const trimmedInput = text.trim();

  // Ref reuse (2026-08-26): callers may stamp their own ref trailer — catchup's
  // lock-lost alert mints and logs its refId in the body BEFORE notifyUser
  // runs, and this send used to append a SECOND trailer, so the delivered
  // message carried two refs while the delivery row keyed under an id nobody
  // quoted. A TRAILING `_Ref: <prefix>-<hex>_` on the send text is now
  // extracted before sanitization and reused: the message carries exactly one
  // ref, and every log row below (send, 429 retries, failures, aborts) keys
  // under the caller's id, so `pa ref` resolves origin AND delivery. A
  // mid-text `_Ref:` occurrence is NOT a trailer — quoted refs stay quoted.
  const stampedRef = /_Ref: ([a-z]+)-([0-9a-f]{4,16})_\s*$/.exec(trimmedInput);
  const refId = stampedRef ? `${stampedRef[1]}-${stampedRef[2]}` : `s-${randomBytes(6).toString('hex')}`;
  const bodyCore = stampedRef ? trimmedInput.slice(0, stampedRef.index).trimEnd() : trimmedInput;

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
  if (!bodyCore) {
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
  // survive raw and render as italic. A trailing caller-stamped ref was
  // already extracted above (bodyCore), so sanitize never touches the trailer
  // that gets re-appended; a MID-BODY `_Ref: ...` occurrence still has its
  // underscores escaped (`\_Ref: ...\_`), so the fallback regex below matches
  // only the appended trailer. That's the desired behavior.
  // The `-` inside the refId (e.g. `s-9b43`) MUST be escaped under MdV2 even
  // inside the italic span — Telegram rejects raw `-` everywhere outside code.
  const safeBody = parseMode === 'MarkdownV2' ? sanitizeMdV2(normalizeMarkdown(bodyCore)) : bodyCore;
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
    if (replyMarkup !== undefined && chunkIndex === chunks.length - 1) {
      body.reply_markup = replyMarkup;
    }

    let attempt = 0;
    const maxAttempts = 3; // AI-149: up to 3 total attempts for 429 retries
    let chunkFailure: SendResult | null = null;

    while (attempt < maxAttempts && !chunkFailure) {
      attempt++;
      try {
        const res = await telegramFetch(`${BASE}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errorText = await res.text();

          // AI-149: 429 rate limit — honor retry_after, do NOT fall back to plain text
          if (res.status === 429) {
            const retryAfter = parseRetryAfter(errorText);
            if (retryAfter !== null && attempt < maxAttempts) {
              const waitMs = (retryAfter + 1) * 1000; // +1s margin, convert to ms
              console.error(`[pa/telegram] 429 rate limit, waiting ${retryAfter + 1}s before retry ${attempt + 1}/${maxAttempts}`);
              log('warn', 'telegram', '429 rate limit, retrying', {
                refId,
                chatId: config.chat_id,
                threadId: config.thread_id,
                chunkIndex,
                attempt,
                retryAfter,
                waitMs,
              });
              await sleep(waitMs);
              continue; // retry SAME payload (no parse-mode fallback)
            }
            // Unparseable retry_after or final attempt — treat as normal http failure
            console.error(`[pa/telegram] 429 rate limit, cannot retry (unparseable or final attempt)`);
            chunkFailure = httpFailure(res.status, errorText);
            break;
          }

          // Fallback: retry as plain text if Markdown parse fails (NOT for 429)
          if (errorText.includes('parse')) {
            delete body.parse_mode;
            // Strip italic markers from ref ID so it shows as "Ref: xxx" not "_Ref: xxx_" in plain text.
            // The optional (\n\n)? handles the edge case where splitMessage puts the ref into its own chunk.
            // The optional `\\` matches the dash escape for MdV2 (`s\-9b43`) — capture id as
            // prefix + hex separately so output is always clean `Ref: s-9b43` regardless of input form.
            body.text = (body.text as string).replace(/((?:\n\n)?)_Ref: ([a-z]+)\\?-([0-9a-f]{4,})_$/, '$1Ref: $2-$3');

            // AI-149: plain-text fallback also needs 429 retry handling
            let fallbackAttempt = 0;
            const maxFallbackAttempts = 3;
            let fallbackSucceeded = false;

            while (fallbackAttempt < maxFallbackAttempts && !fallbackSucceeded && !chunkFailure) {
              fallbackAttempt++;
              try {
                const res2 = await telegramFetch(`${BASE}/bot${token}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body),
                });
                if (!res2.ok) {
                  const errorText2 = await res2.text();
                  // AI-149: 429 on fallback — retry with same plain-text payload
                  if (res2.status === 429) {
                    const retryAfter = parseRetryAfter(errorText2);
                    if (retryAfter !== null && fallbackAttempt < maxFallbackAttempts) {
                      const waitMs = (retryAfter + 1) * 1000;
                      console.error(`[pa/telegram] 429 rate limit on plain-text fallback, waiting ${retryAfter + 1}s`);
                      await sleep(waitMs);
                      continue; // retry same plain-text payload
                    }
                    // Unparseable or final attempt — fail
                    console.error(`[pa/telegram] 429 rate limit on plain-text fallback, cannot retry`);
                    chunkFailure = httpFailure(res2.status, errorText2);
                    break;
                  }
                  // Other non-429 error on fallback — fail immediately
                  console.error(`[pa/telegram] sendToTelegram failed (plain-text fallback): ${res2.status} ${errorText2}`);
                  log('error', 'telegram', 'send failed (plain-text fallback)', {
                    refId,
                    chatId: config.chat_id,
                    threadId: config.thread_id,
                    chunkIndex,
                    status: res2.status,
                    detail: errorText2.slice(0, DETAIL_MAX_LEN),
                  });
                  chunkFailure = httpFailure(res2.status, errorText2);
                } else {
                  log('info', 'telegram', 'skill message sent (plain-text fallback)', {
                    refId,
                    chatId: config.chat_id,
                    threadId: config.thread_id,
                    chunkIndex,
                    textPreview: (body.text as string).slice(0, 500),
                  });
                  fallbackSucceeded = true;
                  break; // AI-149: exit retry loop on success
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
                chunkFailure = networkFailure(err);
              }
            }
            // AI-149: if fallback succeeded, exit main retry loop
            if (fallbackSucceeded) {
              break;
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
            chunkFailure = httpFailure(res.status, errorText);
          }
        } else {
          // Success — log and exit retry loop
          log('info', 'telegram', 'skill message sent', {
            refId,
            chatId: config.chat_id,
            threadId: config.thread_id,
            chunkIndex,
            textPreview: chunk.slice(0, 500),
          });
          break; // AI-149: exit retry loop on success
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
        // AI-149: network errors keep current no-retry semantics — record and break
        chunkFailure = networkFailure(err);
      }
    }

    failure ??= chunkFailure;
  }

  return failure ?? { ok: true, chunks: chunks.length };
}
