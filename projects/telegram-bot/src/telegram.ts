import { createWriteStream } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { logger } from '../../../pa/dist/src/lib/log.js';
import type { TelegramUpdate } from './types.js';

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

export async function getUpdates(token: string, offset: number, timeout: number = 0, signal?: AbortSignal): Promise<TelegramUpdate[]> {
  const url = `${BASE}/bot${token}/getUpdates?offset=${offset}&timeout=${timeout}`;
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`getUpdates failed: ${res.status} ${await res.text()}`);
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

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  replyToMessageId?: number,
  threadId?: number
): Promise<boolean> {
  const chunks = splitMessage(text.trim());
  let allDelivered = true;

  for (const chunk of chunks) {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: sanitizeMdV2(chunk),
      parse_mode: 'MarkdownV2',
    };
    if (threadId !== undefined && threadId !== null && threadId !== 0) body.message_thread_id = threadId;
  // all chunks need it for forum topics
    if (replyToMessageId) {
      body.reply_to_message_id = replyToMessageId;
      replyToMessageId = undefined; // Only reply on the first chunk
    }

    // Retry up to 3 times on transient connection errors (e.g. ECONNRESET).
    // On timeout (AbortError/TimeoutError) we break immediately without retrying:
    // after 30s Telegram has almost certainly processed the request, so retrying
    // would produce a duplicate message. Treat as optimistically delivered.
    let res: Response | undefined;
    let timedOut = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 1000 * attempt));
      try {
        res = await fetch(`${BASE}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        break;
      } catch (err) {
        const name = (err as any)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          logger.warn('telegram', 'sendMessage timeout — not retrying to avoid duplicate delivery', { attempt: attempt + 1 });
          timedOut = true;
          break;
        }
        if (attempt < 2) {
          console.warn(`[sendMessage] network error, retrying (${attempt + 1}/3): ${(err as Error).message}`);
        } else {
          console.error('[sendMessage] network error after 3 attempts:', err);
        }
      }
    }
    if (!res) {
      if (!timedOut) allDelivered = false;
      continue;
    }

    // Fallback: if Markdown parse fails, retry as plain text
    if (!res.ok) {
      const errorText = await res.text();
      if (errorText.includes('parse')) {
        logger.warn('telegram', 'MarkdownV2 parse failed — falling back to plain text', {
          error: errorText,
          chunkPreview: chunk.slice(0, 200),
        });
        delete body.parse_mode;
        // Strip italic markers from ref ID so it shows as "Ref: xxx" not "_Ref: xxx_" in plain text.
        // The optional (\n\n)? handles the edge case where splitMessage puts the ref into its own
        // chunk, trimming the leading newlines.
        body.text = chunk.replace(/((?:\n\n)?)_Ref: ([a-z]+-[0-9a-f]{4})_$/, '$1Ref: $2');
        try {
          res = await fetch(`${BASE}/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) {
            allDelivered = false;
            console.error(`sendMessage failed: ${res.status} ${await res.text()}`);
          }
        } catch (err) {
          const name = (err as any)?.name;
          if (name === 'TimeoutError' || name === 'AbortError') {
            logger.warn('telegram', 'sendMessage plain-text fallback timeout — not retrying to avoid duplicate delivery', {});
          } else {
            allDelivered = false;
            console.error('[sendMessage] plain-text fallback network error:', err);
          }
        }
      } else {
        allDelivered = false;
        console.error(`sendMessage failed: ${res.status} ${errorText}`);
      }
    }
  }

  return allDelivered;
}

/**
 * Like sendMessage but returns the message_id of the sent message (first chunk only).
 * Used when the caller needs to pin the message afterwards.
 */
export async function sendMessageWithId(
  token: string,
  chatId: number,
  text: string,
  threadId?: number
): Promise<number | null> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: sanitizeMdV2(text.trim()),
    parse_mode: 'MarkdownV2',
  };
  if (threadId !== undefined && threadId !== null && threadId !== 0) body.message_thread_id = threadId;

  try {
    const res = await fetch(`${BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(`sendMessageWithId failed: ${res.status} ${await res.text()}`);
      return null;
    }
    const data = await res.json() as { ok: boolean; result: { message_id: number } };
    return data.ok ? data.result.message_id : null;
  } catch (err) {
    console.error('sendMessageWithId network error:', err);
    return null;
  }
}

export async function editMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string
): Promise<boolean> {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text: sanitizeMdV2(text.trim()),
    parse_mode: 'MarkdownV2',
  };

  try {
    const res = await fetch(`${BASE}/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const errorText = await res.text();
      // If Markdown fails, retry as plain text (same as sendMessage)
      if (errorText.includes('parse')) {
        delete (body as any).parse_mode;
        body.text = text.trim();
        const res2 = await fetch(`${BASE}/bot${token}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        return res2.ok;
      }
      console.error(`editMessageText failed: ${res.status} ${errorText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('editMessageText network error:', err);
    return false;
  }
}

export async function pinChatMessage(
  token: string,
  chatId: number,
  messageId: number
): Promise<boolean> {
  const body = JSON.stringify({ chat_id: chatId, message_id: messageId, disable_notification: true });
  const opts = { method: 'POST' as const, headers: { 'Content-Type': 'application/json' }, body };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`${BASE}/bot${token}/pinChatMessage`, opts);
      if (res.ok) return true;
      console.error(`pinChatMessage failed (attempt ${attempt + 1}): ${res.status} ${await res.text()}`);
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
    const res = await fetch(`${BASE}/bot${token}/unpinChatMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    if (!res.ok) console.error(`unpinChatMessage failed: ${res.status} ${await res.text()}`);
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
  const res = await fetch(`${BASE}/bot${token}/createForumTopic`, {
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
    const res = await fetch(`${BASE}/bot${token}/deleteForumTopic`, {
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

export async function sendTyping(token: string, chatId: number, threadId?: number): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, action: 'typing' };
  if (threadId !== undefined && threadId !== null && threadId !== 0) body.message_thread_id = threadId;

  await fetch(`${BASE}/bot${token}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  }).catch((err) => { console.error('sendTyping error:', err); });
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
    const res = await fetch(`${BASE}/bot${token}/setMessageReaction`, {
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
    const res = await fetch(`${BASE}/bot${token}/getFile?file_id=${fileId}`);
    if (!res.ok) {
      console.error(`getFile failed: ${res.status} ${await res.text()}`);
      return false;
    }
    const data = await res.json() as { ok: boolean; result: { file_path: string } };
    if (!data.ok || !data.result.file_path) return false;

    // 2. Download file from file_path
    const fileUrl = `${BASE}/file/bot${token}/${data.result.file_path}`;
    const fileRes = await fetch(fileUrl);
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
    const res = await fetch(`${BASE}/bot${token}/setMyCommands`, {
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
