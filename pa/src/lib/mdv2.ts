// Ported from `projects/telegram-bot/src/telegram.ts` (commit 59100c1).
// The conversation bot is the canonical source — its 839-test suite is the
// spec. Replay any future fix landing there into this file.

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
  // prevents glob patterns like `commands/*, sample_*.jpg` from being
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
