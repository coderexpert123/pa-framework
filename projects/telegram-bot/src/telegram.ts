import { createWriteStream } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { telegramFetch } from '../../../pa/dist/src/lib/telegram-proxy.js';
import type { TelegramUpdate } from './types.js';

const BASE = 'https://api.telegram.org';
const MAX_MSG_LEN = 4000;

export function splitMessage(text: string): string[] {
  if (text.length <= MAX_MSG_LEN) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_MSG_LEN) {
    let cut = remaining.lastIndexOf('\n\n', MAX_MSG_LEN);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', MAX_MSG_LEN);
    if (cut <= 0) cut = MAX_MSG_LEN;

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export async function safeResponseText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<unable to read response text>';
  }
}

/**
 * Extract retry_after from a 429 response, defensively.
 * Returns undefined if parsing fails, otherwise returns the retry_after value.
 */
async function parseRetryAfter(res: Response, errorText: string): Promise<number | undefined> {
  if (res.status !== 429) return undefined;
  try {
    const data = JSON.parse(errorText);
    const retryAfter = data?.parameters?.retry_after;
    if (typeof retryAfter === 'number' && retryAfter > 0) {
      return retryAfter;
    }
  } catch {
    // JSON parse failed or structure not as expected
  }
  return undefined;
}

/**
 * True when a 400 error means the message we tried to reply to no longer
 * exists (e.g. deleted after being sent, as with /auth's delete-then-reply
 * flow — a reply targeting a since-deleted message dead-letters otherwise).
 * Telegram's wording varies by API version, so match loosely rather than on
 * one exact string.
 */
function isReplyTargetGoneError(status: number, errorText: string): boolean {
  if (status !== 400) return false;
  const lower = errorText.toLowerCase();
  return lower.includes('message to be replied') || (lower.includes('reply') && lower.includes('not found'));
}

/**
 * True when a failed send is permanently unroutable — retrying can never
 * succeed. Callers use this to classify a failure as terminal (AI-186's
 * keyboard send; AI-172's dlq.ts drop; widened from 'chat not found'-only to
 * the full set by operator decision 2026-09-03).
 *
 * Terminal classes (permanent, and why):
 * - 'chat not found' (400/403) — the chat does not exist or the bot cannot
 *   address it; no retry changes that.
 * - 'peer_id_invalid' / 'chat_id_invalid' (400) — the peer reference is
 *   permanently invalid for this bot.
 * - 'bot was blocked by the user' (403) — only the user can unblock; a human
 *   cannot make a blocked recipient receive.
 * - 'user is deactivated' (403) — the recipient account no longer exists.
 * - 'bot was kicked from' (403) — the bot is out of the chat until re-added.
 *
 * Deliberately NOT terminal (exclusions):
 * - 'have no rights to send a message' — an admin can restore the bot's
 *   rights, so this is transient; keep retrying.
 * - group-migration errors — the chat continues under a new id, so the
 *   conversation is not dead.
 * - Unknown strings stay false by design: fail toward retry, never toward
 *   drop.
 */
export function isTerminalChatError(status: number, errorText: string): boolean {
  const lower = errorText.toLowerCase();
  if (status === 400) {
    return (
      lower.includes('chat not found') ||
      lower.includes('peer_id_invalid') ||
      lower.includes('chat_id_invalid')
    );
  }
  if (status === 403) {
    return (
      lower.includes('chat not found') ||
      lower.includes('bot was blocked by the user') ||
      lower.includes('user is deactivated') ||
      lower.includes('bot was kicked from')
    );
  }
  return false;
}

/**
 * POST a sendMessage body with the existing 429/5xx retry-with-backoff
 * behavior, shared by sendMessage's initial attempt and its corrective
 * retries (MarkdownV2 fallback, reply-target fallback — see sendMessage).
 * A non-retryable status (e.g. 400) is returned as-is for the caller to
 * inspect; its body is read at most once here (only on the 429/5xx branch),
 * so callers must read `res`'s body themselves for any other status.
 */
async function postSendMessageWithRetries(
  token: string,
  body: Record<string, unknown>,
  logLabel: string
): Promise<{ res: Response | undefined; timedOut: boolean }> {
  let res: Response | undefined;
  let timedOut = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 1000 * attempt));
    try {
      res = await telegramFetch(`${BASE}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      if (res.ok) break;

      if (res.status === 429 || res.status >= 500) {
        const errorText = await safeResponseText(res);
        if (attempt < 2) {
          logger.warn('telegram', `[${logLabel}] HTTP ${res.status}, retrying (${attempt + 1}/3)`, { error: errorText });
          // AI-149: honor retry_after on 429, with cap at 60s + 1s margin
          if (res.status === 429) {
            const retryAfter = await parseRetryAfter(res, errorText);
            if (retryAfter !== undefined) {
              const delayMs = Math.min(retryAfter + 1, 61) * 1000; // cap at 60s + 1s margin
              logger.warn('telegram', `[${logLabel}] 429 rate limit, waiting ${retryAfter}s (capped at 60s) before retry`, { retryAfter });
              await new Promise<void>((r) => setTimeout(r, delayMs));
              continue;
            }
          }
          // For 5xx or unparsable 429, use immediate retry (existing behavior)
          continue;
        }
        console.error(`[${logLabel}] HTTP ${res.status} error after 3 attempts: ${errorText}`);
        break;
      }

      // Non-retryable status (e.g. 400) — stop here, caller reads the body.
      break;
    } catch (err) {
      const name = (err as any)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        logger.warn('telegram', `[${logLabel}] timeout — not retrying to avoid duplicate delivery`, { attempt: attempt + 1 });
        timedOut = true;
        break;
      }
      if (attempt < 2) {
        console.warn(`[${logLabel}] network error, retrying (${attempt + 1}/3): ${(err as Error).message}`);
      } else {
        console.error(`[${logLabel}] network error after 3 attempts:`, err);
      }
    }
  }

  return { res, timedOut };
}

// Sticky server-side: Telegram remembers the last list passed, so the FULL list
// must go on every call. Dropping message_reaction here silently disables the
// reaction-approval path (AI-159, plans/2026-08-24-buttons-program-SPEC.md P1).
export const ALLOWED_UPDATES = ['message', 'callback_query', 'message_reaction'] as const;

export async function getUpdates(token: string, offset: number, timeout: number = 0, signal?: AbortSignal): Promise<TelegramUpdate[]> {
  const url = `${BASE}/bot${token}/getUpdates?offset=${offset}&timeout=${timeout}&allowed_updates=${encodeURIComponent(JSON.stringify(ALLOWED_UPDATES))}`;
  const res = await telegramFetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`getUpdates failed: ${res.status} ${await safeResponseText(res)}`);
  const data = await res.json() as { ok: boolean; result: TelegramUpdate[] };
  if (!data.ok) throw new Error(`getUpdates not ok`);
  return data.result;
}

/**
 * Escapes characters for Telegram MarkdownV2 while preserving the formatting syntax
 * we explicitly allow: *bold*, _italic_, __underline__, ~strikethrough~, `code`, ```blocks```, and [links].
 * Bare _ not part of a valid _italic_ / __underline__ span is escaped to \_ to prevent
 * parse failures from unmatched italic markers (e.g. snake_case identifiers).
 */
export function sanitizeMdV2(text: string): string {
  // 1. Protect code spans and blocks first — never escape content inside them.
  // Telegram MarkdownV2 has no double-backtick code span syntax (CommonMark's
  // `` `text` `` for embedding literal backticks). We collapse those into
  // single-backtick MdV2 spans with the inner backtick escaped. Per MdV2 spec,
  // `\` and ` inside any code span/block must be escaped to `\\` and `` \` ``.
  // Lookbehind/lookahead reject malformed adjacent backticks: e.g. when a
  // worker writes `` `\\_ \\* \\` `` (single-backtick code trying to escape a
  // literal backtick — CommonMark doesn't allow escapes in single-backtick
  // spans). Without this guard the regex matches two spans back-to-back, and
  // the second absorbs surrounding plain text whose parens/dots then bypass
  // step 3 and trigger "Character X is reserved" on output. Failed matches
  // leave bare backticks; step 3a escapes them so Telegram doesn't try to
  // parse them as span markers.
  const codeChunks: string[] = [];
  let out = text.replace(/```[\s\S]*?```|(?<!`)``[^\n]+?``(?!`)|(?<!`)`[^`\n]+`(?!`)/g, (match) => {
    let processed: string;
    if (match.startsWith('```')) {
      const inner = match.slice(3, -3);
      const escaped = inner.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
      processed = '```' + escaped + '```';
    } else if (match.startsWith('``')) {
      // CommonMark: surrounding single space is stripped if both sides have one
      // and content is non-blank — flatten any internal backticks via escape.
      let inner = match.slice(2, -2);
      if (inner.startsWith(' ') && inner.endsWith(' ') && inner.trim().length > 0) {
        inner = inner.slice(1, -1);
      }
      const escaped = inner.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
      processed = '`' + escaped + '`';
    } else {
      const inner = match.slice(1, -1);
      const escaped = inner.replace(/\\/g, '\\\\');
      processed = '`' + escaped + '`';
    }
    codeChunks.push(processed);
    return `\x00CODE${codeChunks.length - 1}\x00`;
  });

  // 2. Protect markdown links [text](url). Per Telegram MarkdownV2 spec:
  //   - Inside [text]: same escaping rules as regular text — `-`, `.`, `(`, etc.
  //     must be backslash-escaped, otherwise Telegram rejects the message.
  //   - Inside (url): only `\` and `)` need escaping. Strip GitHub-style <url>
  //     wrappers (Telegram doesn't recognize them), and percent-encode spaces
  //     (Telegram rejects literal spaces in URLs).
  // The reassembled link is stored verbatim in `links[]` and restored after
  // step 3, bypassing the global escape pass.
  const links: string[] = [];
  out = out.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_match, linkText: string, linkUrl: string) => {
    const escapedText = linkText.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
    let cleanUrl = linkUrl.trim();
    if (cleanUrl.startsWith('<') && cleanUrl.endsWith('>')) cleanUrl = cleanUrl.slice(1, -1);
    cleanUrl = cleanUrl.replace(/\\/g, '\\\\').replace(/\)/g, '\\)').replace(/ /g, '%20');
    links.push(`[${escapedText}](${cleanUrl})`);
    return `\x00LINK${links.length - 1}\x00`;
  });

  // 2b. Escape content backslashes (e.g. Windows file paths like C:\Users).
  // After normalizeMarkdown strips pre-escapes, remaining backslashes are content.
  // Negative lookahead preserves intentional MarkdownV2 escapes produced by
  // escapeMd() (\_  \*  \`  \~) — doubling those would break Telegram formatting.
  // Step 3 uses a matching lookbehind so it ALSO leaves \X alone, preventing
  // \\X over-escape (which Telegram would parse as literal \ + raw X opener).
  // Must run before steps 2c/2d/2e/3 so we don't double-escape our own output.
  out = out.replace(/\\(?![_*~`])/g, '\\\\');

  // 2c. Protect the _ markers of valid _italic_ and __underline__ spans before step 3
  // escapes _. IMPORTANT: only the _ markers are replaced with placeholders — the span
  // content stays in the text so step 3 can still escape parens, dots, etc. inside it.
  // Bare _ (e.g. in snake_case identifiers) are not matched and get escaped in step 3.
  // __underline__ first — double-underscore must be matched before single.
  out = out.replace(/__([^\s_][^_\n]*[^\s_]|[^\s_])__/g, '\x00ULOPEN\x00$1\x00ULCLOSE\x00');
  // _italic_ — content must not start or end with whitespace or underscore.
  out = out.replace(/_([^\s_][^_\n]*[^\s_]|[^\s_])_/g, '\x00IOPEN\x00$1\x00ICLOSE\x00');

  // 2d. Protect the ~ markers of valid ~strikethrough~ spans before step 3 escapes ~.
  // Bare ~ (e.g. ~15 min, ~/.pa/path, ~21 tests) are not matched and get escaped in step 3.
  out = out.replace(/~([^\s~][^~\n]*[^\s~]|[^\s~])~/g, '\x00SOPEN\x00$1\x00SCLOSE\x00');

  // 2e. Protect the * markers of valid *bold* spans before step 3 escapes *.
  // Tight word-boundary rule: opener must be preceded by start-of-string /
  // whitespace / open-punctuation / formatting-marker; closer must be followed
  // by end-of-string / whitespace / close-punctuation / formatting-marker.
  // \x00 is included so bold inside an already-protected _italic_/~strike~ span
  // (e.g. `_*zclaude*_`) is still recognised — by this point the surrounding
  // `_` / `~` chars have been replaced with `\x00…\x00` placeholders. This
  // prevents glob patterns like `commands/*, photos_*.jpg` from being
  // mis-paired as bold while preserving normal usage; bare * fall through to
  // step 3 and get escaped (otherwise Telegram reports "Can't find end of
  // Bold entity" on unclosed *).
  out = out.replace(
    /(^|[\s([{«"'_~\x00])\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*(?=$|[\s.,;:!?)\]}»"'\-_~\x00])/g,
    '$1\x00BOPEN\x00$2\x00BCLOSE\x00'
  );

  // 3a. Escape MdV2 specials that escapeMd() does NOT produce as `\X` —
  // these are always escaped, regardless of preceding `\` (a `\` before `.` /
  // `(` / etc. came from step 2b doubling a literal backslash, not from an
  // escapeMd-style escape sequence).
  out = out.replace(/([.!\-+=|{}#()\[\]>])/g, '\\$1');

  // 3b. Escape _ ~ * ` BUT preserve intentional `\X` escapes (from escapeMd
  // and from step 1's malformed-code-span fallback). Without the lookbehind,
  // `\*` from escapeMd becomes `\\*` and orphan ` becomes `\\\`` — both of
  // which Telegram parses as literal `\` + raw entity opener and triggers
  // "Can't find end of Bold/Code entity". Bare ones (not preceded by `\`)
  // get escaped as before. ` is included so orphan backticks from malformed
  // worker output (e.g. `\\\\` ` patterns) don't trigger raw code-span parse.
  out = out.replace(/(?<!\\)([_~*`])/g, '\\$1');

  // 4. Restore links.
  out = out.replace(/\x00LINK(\d+)\x00/g, (_, i) => links[+i]);

  // 5. Restore code spans/blocks.
  out = out.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeChunks[+i]);

  // 6. Restore italic/underline/strikethrough/bold markers.
  out = out.replace(/\x00IOPEN\x00/g, '_').replace(/\x00ICLOSE\x00/g, '_');
  out = out.replace(/\x00ULOPEN\x00/g, '__').replace(/\x00ULCLOSE\x00/g, '__');
  out = out.replace(/\x00SOPEN\x00/g, '~').replace(/\x00SCLOSE\x00/g, '~');
  out = out.replace(/\x00BOPEN\x00/g, '*').replace(/\x00BCLOSE\x00/g, '*');

  return out;
}

export interface SendMessageResult {
  ok: boolean;
  // Meaningful only when ok === false: the HTTP status and body text of the
  // LAST failed attempt across all chunks/phases (a success leaves whatever a
  // pre-fallback failure set, so read them only on the failure path). A
  // timed-out chunk — treated as possibly-delivered — leaves both undefined.
  lastStatus?: number;
  lastErrorText?: string;
}

async function sendChunksWithDetails(
  token: string,
  chatId: number,
  text: string,
  replyToMessageId?: number,
  threadId?: number
): Promise<SendMessageResult> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true };

  const chunks = splitMessage(trimmed);
  let allDelivered = true;
  let lastStatus: number | undefined;
  let lastErrorText: string | undefined;

  for (const chunk of chunks) {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: sanitizeMdV2(chunk),
      parse_mode: 'MarkdownV2',
    };
    if (threadId !== undefined && threadId !== null && threadId !== 0) body.message_thread_id = threadId;
    let hasReplyTarget = false;
    if (replyToMessageId) {
      body.reply_to_message_id = replyToMessageId;
      hasReplyTarget = true;
      replyToMessageId = undefined; // Only reply on the first chunk
    }

    let res: Response | undefined;
    let timedOut = false;
    let parseModeStripped = false;
    let replyTargetStripped = false;

    // At most 3 phases per chunk: the initial attempt, plus at most one
    // corrective retry for each of the two known causes (MarkdownV2 parse
    // failure, reply-target message deleted — e.g. /auth's delete-then-reply
    // flow). Each corrective retry flips exactly one of the two `*Stripped`
    // flags from false to true and re-entry is gated on that flag still
    // being false, so the loop always terminates within 3 iterations no
    // matter which cause Telegram reports first.
    for (let phase = 0; phase < 3; phase++) {
      const label = phase === 0 ? 'sendMessage' : 'sendMessage fallback';
      const attempt = await postSendMessageWithRetries(token, body, label);
      res = attempt.res;
      timedOut = attempt.timedOut;

      if (!res || res.ok) break;

      const errorText = await safeResponseText(res);
      lastStatus = res.status;
      lastErrorText = errorText;

      // Fallback: if Markdown parse fails, retry as plain text.
      if (!parseModeStripped && res.status === 400 && errorText.includes('parse')) {
        logger.warn('telegram', 'MarkdownV2 parse failed — falling back to plain text', {
          error: errorText,
          chunkPreview: chunk.slice(0, 200),
        });
        delete body.parse_mode;
        body.text = chunk.replace(/((?:\n\n)?)_Ref: ([a-z]+-[0-9a-f]{4,})_$/, '$1Ref: $2');
        parseModeStripped = true;
        continue;
      }

      // Fallback: if the reply target message no longer exists (e.g. deleted
      // right after send, as with /auth's delete-then-reply flow), retry
      // once without reply_to_message_id instead of dead-lettering the send.
      if (hasReplyTarget && !replyTargetStripped && isReplyTargetGoneError(res.status, errorText)) {
        logger.warn('telegram', 'reply target message no longer exists — retrying without reply_to_message_id', {
          chatId,
          threadId,
          error: errorText,
        });
        delete body.reply_to_message_id;
        replyTargetStripped = true;
        continue;
      }

      console.error(`sendMessage failed: ${res.status} ${errorText}`);
      break;
    }

    if (!res) {
      if (!timedOut) allDelivered = false;
      continue;
    }
    if (!res.ok && !timedOut) allDelivered = false;
  }

  return { ok: allDelivered, lastStatus, lastErrorText };
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  replyToMessageId?: number,
  threadId?: number
): Promise<boolean> {
  return (await sendChunksWithDetails(token, chatId, text, replyToMessageId, threadId)).ok;
}

/**
 * Like sendMessage but returns details of the last failed attempt so the
 * caller can classify the failure — the DLQ flush uses this to DROP entries
 * whose chat is terminal-unroutable (isTerminalChatError) instead of
 * quarantine-cycling them (AI-172 fix#2). Delivery semantics are sendMessage's
 * exactly: same MarkdownV2 / reply-target fallbacks, same 429/5xx retry core,
 * same timed-out-is-possibly-delivered rule.
 */
export async function sendMessageWithDetails(
  token: string,
  chatId: number,
  text: string,
  replyToMessageId?: number,
  threadId?: number
): Promise<SendMessageResult> {
  return sendChunksWithDetails(token, chatId, text, replyToMessageId, threadId);
}

/**
 * Like sendMessage but returns the message_id of the sent message (first chunk only).
 * Used when the caller needs to pin the message afterwards.
 *
 * NO MarkdownV2 -> plain-text fallback (unlike `sendMessage` / `sendMessageWithKeyboard`):
 * a parse-mode 400 here just fails. A new caller sending user- or worker-generated text
 * (not a fixed, known-safe template) must go through `sendMessage` or
 * `sendMessageWithKeyboard` instead, or port the fallback here first (bp-fix 2026-08-24 —
 * this exact gap cost two work packages a day earlier).
 */
export async function sendMessageWithId(
  token: string,
  chatId: number,
  text: string,
  threadId?: number,
  replyMarkup?: InlineKeyboardMarkup
): Promise<number | null> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: sanitizeMdV2(text.trim()),
    parse_mode: 'MarkdownV2',
  };
  if (threadId !== undefined && threadId !== null && threadId !== 0) body.message_thread_id = threadId;
  if (replyMarkup !== undefined) body.reply_markup = replyMarkup;

  try {
    const res = await telegramFetch(`${BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(`sendMessageWithId failed: ${res.status} ${await safeResponseText(res)}`);
      return null;
    }
    const data = await res.json().catch(() => null) as { ok?: boolean; result?: { message_id: number } } | null;
    return data?.ok ? (data.result?.message_id ?? null) : null;
  } catch (err) {
    console.error('sendMessageWithId network error:', err);
    return null;
  }
}

export async function editMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
  opts?: { rawMarkdown?: boolean }
): Promise<boolean> {
  // Telegram DROPS the keyboard when `reply_markup` is omitted from an edit —
  // passing `undefined` here is how a card refresh removes its buttons, and every
  // refresh of a message that must KEEP its buttons has to pass them again
  // (plans/2026-08-24-buttons-program-SPEC.md P1d / §8 R3). The plain-text retry
  // below reuses this same `body` object, so the keyboard survives the fallback.
  //
  // Rationale for rawMarkdown: round-tripped cb.message.text from a callback query
  // is already MarkdownV2 source; re-sanitizing double-escapes entities (\* → \\*)
  // and visibly corrupts the message.
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text: opts?.rawMarkdown ? text.trim() : sanitizeMdV2(text.trim()),
    parse_mode: 'MarkdownV2',
  };
  if (replyMarkup !== undefined) body.reply_markup = replyMarkup;

  try {
    const res = await telegramFetch(`${BASE}/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const errorText = await safeResponseText(res);
      if (errorText.includes('message is not modified')) {
        return true;
      }
      // If Markdown fails, retry as plain text (same as sendMessage)
      if (errorText.includes('parse')) {
        delete (body as any).parse_mode;
        body.text = text.trim();
        const res2 = await telegramFetch(`${BASE}/bot${token}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res2.ok) return false;
        const result = await res2.json() as { ok: boolean };
        return result.ok;
      }
      console.error(`editMessageText failed: ${res.status} ${errorText}`);
      return false;
    }
    const result = await res.json() as { ok: boolean };
    return result.ok;
  } catch (err) {
    console.error('editMessageText network error:', err);
    return false;
  }
}

export async function pinChatMessage(
  token: string,
  chatId: number,
  messageId: number,
  disableNotification: boolean = true
): Promise<boolean> {
  const body = JSON.stringify({ chat_id: chatId, message_id: messageId, disable_notification: disableNotification });
  const opts = { method: 'POST' as const, headers: { 'Content-Type': 'application/json' }, body };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 1000));
    try {
      const res = await telegramFetch(`${BASE}/bot${token}/pinChatMessage`, opts);
      if (res.ok) return true;
      console.error(`pinChatMessage failed (attempt ${attempt + 1}): ${res.status} ${await safeResponseText(res)}`);
    } catch (err) {
      console.error(`pinChatMessage network error (attempt ${attempt + 1}):`, err);
    }
  }
  return false;
}

export async function unpinChatMessage(
  token: string,
  chatId: number,
  messageId: number
): Promise<void> {
  try {
    const res = await telegramFetch(`${BASE}/bot${token}/unpinChatMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    if (!res.ok) console.error(`unpinChatMessage failed: ${res.status} ${await safeResponseText(res)}`);
  } catch (err) {
    console.error('unpinChatMessage network error:', err);
  }
}

export async function createForumTopic(
  token: string,
  chatId: number,
  name: string
): Promise<number> {
  const body = JSON.stringify({ chat_id: chatId, name });
  const res = await telegramFetch(`${BASE}/bot${token}/createForumTopic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`createForumTopic failed: ${res.status} ${errorText}`);
  }
  const data = await res.json() as { ok: boolean; result: { message_thread_id: number } };
  if (!data.ok) throw new Error(`createForumTopic not ok`);
  return data.result.message_thread_id;
}

export async function deleteForumTopic(
  token: string,
  chatId: number,
  threadId: number
): Promise<boolean> {
  try {
    const res = await telegramFetch(`${BASE}/bot${token}/deleteForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_thread_id: threadId }),
    });
    return res.ok;
  } catch (err) {
    console.error('deleteForumTopic network error:', err);
    return false;
  }
}

// sendChatAction needs headroom: measured api.telegram.org latency from this
// network swings 0.6s–15s+ (AI-095). A 3s budget silently killed every typing
// indicator (327 swallowed timeouts) while sends succeeded on their 30s budget.
export const SEND_TYPING_TIMEOUT_MS = 15_000;
// Failures are throttled into the structured log (typing fires every ~4s during
// a dispatch — one line per minute is enough to make degradation queryable).
const SEND_TYPING_LOG_INTERVAL_MS = 60_000;
let lastTypingErrorLoggedAt = 0;

export async function sendTyping(token: string, chatId: number, threadId?: number): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, action: 'typing' };
  if (threadId !== undefined && threadId !== null && threadId !== 0) body.message_thread_id = threadId;

  await telegramFetch(`${BASE}/bot${token}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TYPING_TIMEOUT_MS),
  }).catch((err) => {
    const now = Date.now();
    if (now - lastTypingErrorLoggedAt >= SEND_TYPING_LOG_INTERVAL_MS) {
      lastTypingErrorLoggedAt = now;
      logger.warn('telegram', 'sendTyping failed', { chatId, threadId, error: String(err) });
    }
  });
}

export async function setMessageReaction(
  token: string,
  chatId: number,
  messageId: number,
  emoji: string
): Promise<void> {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji }],
  };

  try {
    // Telegram rejects literal 4-byte UTF-8 emoji — needs surrogate-pair escape form.
    // JSON.stringify emits literal chars; replace surrogate pairs with \uXXXX\uXXXX.
    const bodyStr = JSON.stringify(body).replace(
      /[\uD800-\uDBFF][\uDC00-\uDFFF]/g,
      (m) => `\\u${m.charCodeAt(0).toString(16)}\\u${m.charCodeAt(1).toString(16)}`,
    );
    const res = await telegramFetch(`${BASE}/bot${token}/setMessageReaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr,
    });
    if (!res.ok) {
      console.error(`setMessageReaction failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error('setMessageReaction network error:', err);
  }
}

/**
 * Downloads a file from Telegram and saves it to a local path.
 */
export async function downloadFile(token: string, fileId: string, destPath: string): Promise<boolean> {
  try {
    // 1. Get file path from fileId
    const res = await telegramFetch(`${BASE}/bot${token}/getFile?file_id=${fileId}`);
    if (!res.ok) {
      console.error(`getFile failed: ${res.status} ${await res.text()}`);
      return false;
    }
    const data = await res.json() as { ok: boolean; result: { file_path: string } };
    if (!data.ok || !data.result.file_path) return false;

    // 2. Download file from file_path
    const fileUrl = `${BASE}/file/bot${token}/${data.result.file_path}`;
    const fileRes = await telegramFetch(fileUrl);
    if (!fileRes.ok || !fileRes.body) {
      console.error(`File download failed: ${fileRes.status}`);
      return false;
    }

    // 3. Save to disk
    await pipeline(fileRes.body as any, createWriteStream(destPath));
    return true;
  } catch (err) {
    console.error('downloadFile error:', err);
    return false;
  }
}

export async function setMyCommands(token: string, commands: any[]): Promise<boolean> {
  try {
    const res = await telegramFetch(`${BASE}/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    if (!res.ok) {
      console.error(`setMyCommands failed: ${res.status} ${await res.text()}`);
      return false;
    }
    const data = await res.json() as { ok: boolean };
    return data.ok;
  } catch (err) {
    console.error('setMyCommands network error:', err);
    return false;
  }
}

export async function deleteMessage(token: string, chatId: number, messageId: number): Promise<boolean> {
  try {
    const res = await telegramFetch(`${BASE}/bot${token}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    return res.ok;
  } catch (err) {
    logger.warn('telegram', `deleteMessage error: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Inline keyboard button types for HITL approve/reject/diff interactions
 */
export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  copy_text?: { text: string };
  /** Bot API 9.4 button styles. Unknown values are ignored by older clients. */
  style?: 'primary' | 'success' | 'danger';
}

export interface InlineKeyboardRow {
  inline_keyboard: InlineKeyboardButton[];
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/**
 * Same contract as `sendMessageWithKeyboard`, plus `terminalError`: true only
 * when at least one chunk failed AND every failed chunk's final failure was a
 * 400 "chat not found" (AI-186) — a send that can never succeed on retry.
 */
export async function sendMessageWithKeyboardDetailed(
  token: string,
  chatId: number,
  text: string,
  keyboard: InlineKeyboardMarkup,
  replyToMessageId?: number,
  threadId?: number
): Promise<{ messageId: number | null; terminalError: boolean }> {
  // 2026-08-24 (buttons program, P1f): the keyboard goes on the LAST chunk only
  // (Telegram allows one keyboard per message; the press must land on the message
  // the reader finishes on), and the return value is the FIRST chunk's message_id
  // (null on any failure) — mirroring sendMessageWithId — so a caller can anchor
  // `pending_action.message_id` / a later editMessageReplyMarkup on it.
  const trimmed = text.trim();
  if (!trimmed) return { messageId: null, terminalError: false };

  const chunks = splitMessage(trimmed);
  let firstMessageId: number | null = null;
  let anyFailed = false;
  let allFailuresChatNotFound = true;

  for (let i = 0; i < chunks.length; i++) {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: sanitizeMdV2(chunks[i]),
      parse_mode: 'MarkdownV2',
    };
    if (i === chunks.length - 1) body.reply_markup = keyboard;
    if (threadId !== undefined && threadId !== null && threadId !== 0) body.message_thread_id = threadId;
    let hasReplyTarget = false;
    if (replyToMessageId) {
      body.reply_to_message_id = replyToMessageId;
      hasReplyTarget = true;
      replyToMessageId = undefined; // Only reply on the first chunk
    }

    let parseModeStripped = false;
    let replyTargetStripped = false;
    let succeeded = false;
    let chunkChatNotFound = false;

    // At most 3 attempts per chunk: the initial send, plus at most one
    // corrective retry for each of the two known causes (MarkdownV2 parse
    // failure, reply-target message deleted). Same termination argument as
    // sendMessage: each retry flips one `*Stripped` flag false->true and
    // re-entry is gated on that flag, so this always terminates within 3
    // attempts regardless of which cause Telegram reports first.
    for (let phase = 0; phase < 3; phase++) {
      try {
        const res = await telegramFetch(`${BASE}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });

        if (res.ok) {
          const data = await res.json().catch(() => null) as { ok?: boolean; result?: { message_id: number } } | null;
          if (i === 0) firstMessageId = data?.ok ? (data.result?.message_id ?? null) : null;
          succeeded = true;
          break;
        }

        const errorText = await safeResponseText(res);

        // If Markdown fails, retry as plain text (same as sendMessage/editMessageText),
        // keeping reply_markup (already set on the last chunk's body) intact.
        if (!parseModeStripped && res.status === 400 && errorText.includes('parse')) {
          delete (body as any).parse_mode;
          // Same ref-marker de-italicisation as sendMessage's fallback: without MdV2
          // the surrounding underscores would render literally.
          body.text = chunks[i].replace(/((?:\n\n)?)_Ref: ([a-z]+-[0-9a-f]{4,})_$/, '$1Ref: $2');
          parseModeStripped = true;
          continue;
        }

        // If the reply target message no longer exists (e.g. deleted right
        // after send, as with /auth's delete-then-reply flow), retry once
        // without reply_to_message_id instead of dead-lettering the send.
        if (hasReplyTarget && !replyTargetStripped && isReplyTargetGoneError(res.status, errorText)) {
          logger.warn('telegram', 'reply target message no longer exists — retrying without reply_to_message_id', {
            chatId,
            threadId,
            error: errorText,
          });
          delete body.reply_to_message_id;
          replyTargetStripped = true;
          continue;
        }

        console.error(`sendMessageWithKeyboard failed: ${res.status} ${errorText} (chatId=${chatId}, threadId=${threadId})`);
        if (isTerminalChatError(res.status, errorText)) chunkChatNotFound = true;
        break;
      } catch (err) {
        console.error(`sendMessageWithKeyboard network error: (chatId=${chatId}, threadId=${threadId})`, err);
        break;
      }
    }

    if (!succeeded) {
      anyFailed = true;
      if (!chunkChatNotFound) allFailuresChatNotFound = false;
    }
  }

  return { messageId: anyFailed ? null : firstMessageId, terminalError: anyFailed && allFailuresChatNotFound };
}

/**
 * Send a message with inline keyboard markup for HITL interactions.
 * Used for self-improver risk-flagged alerts with approve/reject/diff buttons.
 */
export async function sendMessageWithKeyboard(
  token: string,
  chatId: number,
  text: string,
  keyboard: InlineKeyboardMarkup,
  replyToMessageId?: number,
  threadId?: number
): Promise<number | null> {
  return (await sendMessageWithKeyboardDetailed(token, chatId, text, keyboard, replyToMessageId, threadId)).messageId;
}

/**
 * Replace (or remove, when `replyMarkup` is undefined) the inline keyboard of an
 * existing message without touching its text — the post-press "disable the button"
 * step every handler performs (design rule 2). `message is not modified` counts as
 * success; never throws.
 */
export async function editMessageReplyMarkup(
  token: string,
  chatId: number,
  messageId: number,
  replyMarkup?: InlineKeyboardMarkup
): Promise<boolean> {
  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId };
  if (replyMarkup !== undefined) body.reply_markup = replyMarkup;
  try {
    const res = await telegramFetch(`${BASE}/bot${token}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return true;
    const errorText = await safeResponseText(res);
    if (errorText.includes('message is not modified')) return true;
    console.error(`editMessageReplyMarkup failed: ${res.status} ${errorText}`);
    return false;
  } catch (err) {
    console.error('editMessageReplyMarkup network error:', err);
    return false;
  }
}

/**
 * Answer a callback query from an inline keyboard button press.
 * Optionally shows a toast notification to the user.
 */
export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
  showAlert: boolean = false
): Promise<boolean> {
  try {
    const body: Record<string, unknown> = {
      callback_query_id: callbackQueryId,
    };
    if (text) {
      body.text = text;
      body.show_alert = showAlert;
    }
    const res = await telegramFetch(`${BASE}/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch (err) {
    logger.warn('telegram', `answerCallbackQuery error: ${(err as Error).message}`);
    return false;
  }
}
