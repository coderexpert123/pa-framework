import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage, sanitizeMdV2, getUpdates, sendMessage, sendMessageWithId, pinChatMessage, unpinChatMessage, sendTyping, SEND_TYPING_TIMEOUT_MS } from '../telegram.js';

const MAX = 4000;

// ---------------------------------------------------------------------------
// splitMessage — pure function, no network
// ---------------------------------------------------------------------------

describe('splitMessage', () => {
  it('returns single chunk for short text', () => {
    const chunks = splitMessage('hello world');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], 'hello world');
  });

  it('returns single chunk for empty string', () => {
    const chunks = splitMessage('');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], '');
  });

  it('returns single chunk for text exactly at limit', () => {
    const text = 'a'.repeat(MAX);
    const chunks = splitMessage(text);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, MAX);
  });

  it('returns two chunks for text one char over limit with no newlines', () => {
    const text = 'x'.repeat(MAX + 1);
    const chunks = splitMessage(text);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, MAX);
    assert.equal(chunks[1].length, 1);
  });

  it('hard-cuts at MAX when no newline is available', () => {
    const text = 'x'.repeat(MAX + 500);
    const chunks = splitMessage(text);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, MAX);
    assert.equal(chunks[1].length, 500);
  });

  it('splits on double newline boundary within limit', () => {
    const first = 'a'.repeat(3990);
    const second = 'b'.repeat(100);
    const chunks = splitMessage(`${first}\n\n${second}`);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], first);
    assert.equal(chunks[1], second);
  });

  it('falls back to single newline when no double newline within limit', () => {
    const first = 'a'.repeat(3990);
    const second = 'b'.repeat(100);
    const chunks = splitMessage(`${first}\n${second}`);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], first);
    assert.equal(chunks[1], second);
  });

  it('ignores double newline beyond the limit and uses hard cut', () => {
    // \n\n at position 4001, past the MAX window
    const text = 'a'.repeat(4001) + '\n\n' + 'b'.repeat(100);
    const chunks = splitMessage(text);
    // lastIndexOf('\n\n', 4000) finds nothing, falls to hard cut
    assert.ok(chunks.every(c => c.length <= MAX), 'all chunks must be within limit');
    assert.ok(chunks.length >= 2);
  });

  it('double newline exactly at MAX boundary is found and used as split point', () => {
    // \n\n starts at position 3999 (within the lastIndexOf search window of 4000)
    const text = 'a'.repeat(3999) + '\n\n' + 'b'.repeat(100);
    const chunks = splitMessage(text);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], 'a'.repeat(3999));
    assert.equal(chunks[1], 'b'.repeat(100));
  });

  it('prefers double newline over single newline when both present within limit', () => {
    // \n at position 3000, \n\n at position 3999 — both within the MAX=4000 lastIndexOf window
    // Total = 3000+1+998+2+200 = 4201 > 4000, so splitting occurs
    // lastIndexOf('\n\n', 4000) returns 3999 (wins over \n at 3000)
    const text = 'a'.repeat(3000) + '\n' + 'b'.repeat(998) + '\n\n' + 'c'.repeat(200);
    const chunks = splitMessage(text);
    assert.equal(chunks.length, 2);
    // If \n\n was preferred: chunk[1] starts with 'c'
    // If \n was preferred instead: chunk[1] would start with 'b'
    assert.ok(chunks[1].startsWith('c'), `expected 'c' after \\n\\n split, got: ${chunks[1].slice(0, 10)}`);
  });

  it('produces three chunks for very long message with no newlines', () => {
    const text = 'z'.repeat(MAX * 3);
    const chunks = splitMessage(text);
    assert.equal(chunks.length, 3);
    for (const chunk of chunks) {
      assert.equal(chunk.length, MAX);
    }
  });

  it('all chunks are within limit for multi-section message', () => {
    const piece = 'p'.repeat(3800);
    const text = [piece, piece, piece].join('\n\n');
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= MAX, `chunk too long: ${chunk.length}`);
    }
  });

  it('content is fully preserved across chunks (no data loss on \n\n split)', () => {
    const first = 'a'.repeat(3990);
    const second = 'b'.repeat(3990);
    const third = 'c'.repeat(100);
    const chunks = splitMessage(`${first}\n\n${second}\n\n${third}`);
    const rejoined = chunks.join('\n\n');
    assert.ok(rejoined.includes(first));
    assert.ok(rejoined.includes(second));
    assert.ok(rejoined.includes(third));
  });

  it('never produces empty chunks for any input', () => {
    const cases = [
      'a'.repeat(MAX + 1),
      'a'.repeat(MAX * 3),
      'a'.repeat(3999) + '\n\n' + 'b'.repeat(100),
      'a'.repeat(3999) + '\n' + 'b'.repeat(100),
      'a'.repeat(MAX - 1) + '\n\n' + 'b'.repeat(MAX + 1),
    ];
    for (const text of cases) {
      const chunks = splitMessage(text);
      for (const chunk of chunks) {
        assert.ok(chunk.length > 0, `empty chunk in splitMessage("${text.slice(0, 30)}...")`);
      }
    }
  });

  it('does not mutate the input string', () => {
    const original = 'hello\n\nworld'.repeat(1000);
    const copy = original;
    splitMessage(original);
    assert.equal(original, copy);
  });
});

// ---------------------------------------------------------------------------
// sanitizeMdV2 — pure function, no network
// ---------------------------------------------------------------------------

describe('sanitizeMdV2', () => {
  it('escapes plain-text parentheses', () => {
    assert.equal(sanitizeMdV2('hello (world)'), 'hello \\(world\\)');
  });

  it('preserves markdown links unchanged', () => {
    assert.equal(sanitizeMdV2('[click here](https://example.com)'), '[click here](https://example.com)');
  });

  it('escapes parens outside links but preserves links', () => {
    const input = 'see (note) and [docs](https://example.com) for (more)';
    const result = sanitizeMdV2(input);
    assert.ok(result.includes('[docs](https://example.com)'), 'link preserved');
    assert.ok(result.includes('\\(note\\)'), 'plain paren escaped');
    assert.ok(result.includes('\\(more\\)'), 'trailing paren escaped');
  });

  it('escapes square brackets in plain text', () => {
    assert.equal(sanitizeMdV2('see [RFC 1234]'), 'see \\[RFC 1234\\]');
  });

  it('escapes dot, dash, exclamation', () => {
    const result = sanitizeMdV2('v1.2-beta!');
    assert.equal(result, 'v1\\.2\\-beta\\!');
  });

  it('preserves valid _italic_ and ~strikethrough~ spans, does not escape * `', () => {
    const result = sanitizeMdV2('*bold* _italic_ ~strike~ `code`');
    assert.equal(result, '*bold* _italic_ ~strike~ `code`');
  });

  // ~ escaping — bare tildes get escaped; valid ~strikethrough~ spans are preserved
  it('escapes bare ~ used as approximation prefix (real-world: c-1367 bug)', () => {
    assert.equal(sanitizeMdV2('~15 min'), '\\~15 min');
    assert.equal(sanitizeMdV2('~2–3h'), '\\~2–3h');  // en dash (U+2013) is not a MdV2 special char
    assert.equal(sanitizeMdV2('~21 unit tests'), '\\~21 unit tests');
  });

  it('escapes ~ in path prefix outside code span', () => {
    // ~/.pa outside backticks must be escaped; inside backticks it is protected
    assert.equal(sanitizeMdV2('~/.pa/file'), '\\~/\\.pa/file');  // . is a MdV2 special char and gets escaped
  });

  it('preserves valid ~strikethrough~ span', () => {
    assert.equal(sanitizeMdV2('~strikethrough~'), '~strikethrough~');
  });

  it('preserves ~strikethrough~ alongside bare ~ (both on same line)', () => {
    const result = sanitizeMdV2('~done~ and ~15 min left');
    assert.ok(result.startsWith('~done~'), 'valid strikethrough preserved');
    assert.ok(result.includes('\\~15'), 'bare ~ escaped');
  });

  // _ escaping — bare underscores get escaped; valid italic/underline spans are preserved
  it('escapes bare _ in snake_case identifiers', () => {
    assert.equal(sanitizeMdV2('preferred_worker'), 'preferred\\_worker');
  });

  it('escapes trailing _ not part of an italic span', () => {
    assert.equal(sanitizeMdV2('ref_'), 'ref\\_');
  });

  it('escapes _ inside bold when not paired as italic', () => {
    // *g-31a3_ (text)*  — the _ has no matching opening, must be escaped
    const result = sanitizeMdV2('*g\\-31a3_ \\(text\\)*');
    assert.ok(result.includes('\\_'), 'lone _ escaped');
    assert.ok(!result.match(/[^\\]_/), 'no bare unescaped _');
  });

  it('preserves _italic text_ spanning multiple words', () => {
    assert.equal(sanitizeMdV2('_root cause_'), '_root cause_');
  });

  it('preserves __underline__ spans', () => {
    assert.equal(sanitizeMdV2('__underline__'), '__underline__');
  });

  it('escapes parens inside _italic_ span (content not hidden from step 3)', () => {
    // Content inside italic is still processed — parens must be escaped
    const result = sanitizeMdV2('_italic (note)_');
    assert.ok(result.includes('_italic \\(note\\)_'), 'parens inside italic escaped');
  });

  it('real-world: _*bold-italic*_ Telegram nested formatting', () => {
    // formatFailoverMessage uses _*worker* rate limited (cls)_ syntax
    const result = sanitizeMdV2('_*zclaude* rate limited (unknown)_');
    assert.ok(result.startsWith('_*zclaude*'), 'italic+bold preserved');
    assert.ok(result.includes('\\(unknown\\)'), 'parens inside italic escaped');
    assert.ok(result.endsWith('_'), 'closing italic marker preserved');
  });

  it('escapes > character', () => {
    assert.equal(sanitizeMdV2('a > b'), 'a \\> b');
  });

  it('handles multiple links in text', () => {
    const input = '[A](http://a.com) and [B](http://b.com)';
    const result = sanitizeMdV2(input);
    assert.equal(result, '[A](http://a.com) and [B](http://b.com)');
  });

  // Regression for g-c472 (2026-04-28): Gemini emitted a link with `-` and `.`
  // in the text and a `<...>` wrapped URL with spaces. Telegram rejected the
  // message ("Character '-' is reserved..."), causing a plain-text fallback.
  it('escapes - and . inside link text per MdV2 spec', () => {
    const result = sanitizeMdV2('[poll-loop.test.ts](https://x.com)');
    assert.equal(result, '[poll\\-loop\\.test\\.ts](https://x.com)');
  });

  it('strips GitHub-style <...> wrapper from link URL', () => {
    const result = sanitizeMdV2('[file](<https://example.com/path>)');
    assert.equal(result, '[file](https://example.com/path)');
  });

  it('percent-encodes spaces in link URLs (Telegram rejects literal spaces)', () => {
    // `.` inside (url) does NOT need escaping per MdV2 spec (only `\` and `)` do).
    const result = sanitizeMdV2('[doc](<C:/test project/file.md>)');
    assert.equal(result, '[doc](C:/test%20project/file.md)');
  });

  it('full regression: link with - and . in text plus angle-bracketed URL with spaces (g-c472)', () => {
    const input = '[poll-loop-integration-extra.test.ts](</C:/test project/file.ts>)';
    const result = sanitizeMdV2(input);
    assert.equal(
      result,
      '[poll\\-loop\\-integration\\-extra\\.test\\.ts](/C:/test%20project/file.ts)'
    );
  });

  it('escapes ) and \\ inside link URL per MdV2 spec', () => {
    const result = sanitizeMdV2('[x](http://example.com/a\\b)');
    assert.equal(result, '[x](http://example.com/a\\\\b)');
  });

  it('escapes # so ### headers render as literal text', () => {
    assert.equal(sanitizeMdV2('### Header'), '\\#\\#\\# Header');
  });

  it('real-world: parentheses in plain text alongside code and bold', () => {
    const input = '*Root cause* — Gemini (new sessions) used `context.ts` for this';
    const result = sanitizeMdV2(input);
    assert.ok(result.includes('\\(new sessions\\)'), 'parens escaped');
    assert.ok(result.includes('*Root cause*'), 'bold markers preserved');
    assert.ok(result.includes('`context.ts`'), 'code span dot preserved unescaped');
  });

  it('protects code blocks from escaping', () => {
    const input = '```\nconst x = 1.2;\nif (x > 1) return;\n```';
    const result = sanitizeMdV2(input);
    assert.ok(result.includes('1.2'), 'dot preserved in block');
    assert.ok(result.includes('(x > 1)'), 'parens and > preserved in block');
  });

  it('escapes characters outside code but not inside', () => {
    const input = 'Check `file.ts` for (details)!';
    const result = sanitizeMdV2(input);
    assert.equal(result, 'Check `file.ts` for \\(details\\)\\!');
  });

  // backslash handling
  it('escapes a standalone backslash before a non-special char', () => {
    // \U is not a MdV2 special — backslash must be escaped
    assert.equal(sanitizeMdV2('C:\\Users'), 'C:\\\\Users');
  });
  it('escapes backslash even when followed by a MdV2 special char', () => {
    // normalizeMarkdown strips \. before it reaches here, but if it arrives
    // anyway: \ gets doubled to \\, then . gets escaped to \. → result \\\.
    const result = sanitizeMdV2('\\.');
    assert.equal(result, '\\\\\\.'); // \\ (escaped backslash) + \. (escaped dot)
  });
  // Per Telegram MdV2 spec, `\` inside code spans / blocks MUST be escaped to
  // `\\`. Otherwise the lone backslash consumes the following byte (often the
  // closing backtick), breaking the span and producing cascading parse errors.
  // Regression for c-b085 (2026-04-28): a message containing `` `\` `` triggered
  // "Character ')' is reserved" on a paren far downstream.
  it('escapes backslash inside inline code spans (Telegram MdV2 spec)', () => {
    assert.equal(sanitizeMdV2('`C:\\path`'), '`C:\\\\path`');
  });
  it('escapes a lone backslash inside an inline code span', () => {
    assert.equal(sanitizeMdV2('`\\`'), '`\\\\`');
  });
  it('escapes backslash inside code blocks', () => {
    assert.equal(sanitizeMdV2('```\nC:\\Users\n```'), '```\nC:\\\\Users\n```');
  });
  it('escapes single ` inside a code block', () => {
    assert.equal(sanitizeMdV2('```\nfoo`bar\n```'), '```\nfoo\\`bar\n```');
  });

  // Regression for c-6b42 (2026-04-28): Markdown double-backtick spans like
  // `` `text` `` were treated as two adjacent empty single-backtick spans by
  // the bare regex `[^`\n]+`, producing unbalanced backticks and absorbing
  // surrounding plain text into a bogus span. Telegram then rejected later
  // unescaped parens in plain text. Fix collapses them to MdV2 single-backtick
  // form with the inner backtick escaped.
  it('converts CommonMark double-backtick span to MdV2 single-backtick with escaped inner `', () => {
    assert.equal(sanitizeMdV2('`` `x` ``'), '`\\`x\\``');
  });

  // Regression for c-9327 (2026-04-28): plain-text glob patterns like
  // `commands/*` and `*_email_*.txt` left bare * unescaped, producing
  // "Can't find end of Bold entity" parse errors. Mirror the _ / ~ logic:
  // protect valid *bold* spans, escape every other *.
  it('escapes bare * in glob patterns (commands/*, sample_*.jpg)', () => {
    assert.equal(sanitizeMdV2('files: commands/*, sample_*.jpg'), 'files: commands/\\*, sample\\_\\*\\.jpg');
  });

  it('escapes a trailing bare * with no closing partner', () => {
    assert.equal(sanitizeMdV2('see *.txt files'), 'see \\*\\.txt files');
  });

  it('preserves valid *bold* spans alongside bare * elsewhere', () => {
    const result = sanitizeMdV2('*bold* and commands/*');
    assert.ok(result.includes('*bold*'), 'bold span preserved');
    assert.ok(result.includes('commands/\\*'), 'bare * escaped');
  });

  // Regression: escapeMd() in notify-format.ts emits \_ \* \~ \` to mark
  // formatting markers as literal. sanitizeMdV2 must preserve these escapes
  // unchanged — otherwise the trailing X gets re-escaped in step 3 and
  // produces \\X, which Telegram parses as literal \ + raw X, triggering
  // "Can't find end of Bold/Italic entity" parse failures.
  it('preserves intentional \\* escape (from escapeMd) without double-escape', () => {
    assert.equal(sanitizeMdV2('foo\\*bar'), 'foo\\*bar');
  });
  it('preserves intentional \\_ escape (from escapeMd) without double-escape', () => {
    assert.equal(sanitizeMdV2('claude\\_worker'), 'claude\\_worker');
  });
  it('preserves intentional \\~ escape without double-escape', () => {
    assert.equal(sanitizeMdV2('roughly \\~5 min'), 'roughly \\~5 min');
  });

  // Regression for c-160a (2026-04-29): a worker emitted `` `\\_ \\* \\` `` —
  // single-backtick code trying to embed a literal backtick via `\\``, which
  // CommonMark doesn't support. The old regex matched two back-to-back spans
  // with the second absorbing 124 chars of plain text; parens/dots inside that
  // bogus span bypassed escaping and triggered "Character '.' is reserved".
  // Fix: lookbehind/lookahead reject adjacent-backtick matches; orphan
  // backticks get escaped to \` in step 3a.
  it('rejects malformed adjacent code spans and escapes orphan backticks', () => {
    const result = sanitizeMdV2('foo `a\\` `b` end.');
    assert.ok(result.includes('end\\.'), 'plain-text dot escaped, not absorbed into bogus span');
  });

  it('escapes orphan backticks not part of any valid span', () => {
    // Three adjacent backticks with content like `` `\` `` (close)+`` ` `` (orphan)
    // would previously create a fake span absorbing trailing plain text.
    const result = sanitizeMdV2('a `\\` ` b. (c)');
    assert.ok(result.includes('\\.'), 'plain-text dot escaped');
    assert.ok(result.includes('\\(c\\)'), 'plain-text parens escaped');
  });

  it('does not eat surrounding plain text between adjacent double-backtick spans', () => {
    const result = sanitizeMdV2('like `` `\\` `` and `` `)` `` (paren).');
    // Both inner backticks are escaped; the trailing "(paren)." is escaped as plain text.
    assert.ok(result.includes('`\\`\\\\\\`'), 'first double-backtick span flattened');
    assert.ok(result.includes('`\\`)\\``'), 'second double-backtick span flattened');
    assert.ok(result.includes('\\(paren\\)\\.'), 'trailing plain-text parens escaped');
  });
});

// ---------------------------------------------------------------------------
// pipeline: normalizeMarkdown + sanitizeMdV2 (end-to-end)
// ---------------------------------------------------------------------------
import { normalizeMarkdown } from '../logic.js';

describe('pipeline: normalizeMarkdown + sanitizeMdV2', () => {
  function pipeline(text: string): string {
    return sanitizeMdV2(normalizeMarkdown(text));
  }

  it('clean CommonMark with bold and parens', () => {
    const result = pipeline('**Result** is 42 (confirmed).');
    assert.equal(result, '*Result* is 42 \\(confirmed\\)\\.');
  });

  it('pre-escaped worker output normalises then re-escapes correctly', () => {
    // Worker incorrectly emitted \. and \( — normalizeMarkdown strips them,
    // sanitizeMdV2 re-escapes properly.
    const result = pipeline('Version 1\\.0 \\(beta\\) released\\!');
    assert.equal(result, 'Version 1\\.0 \\(beta\\) released\\!');
  });

  it('header with pre-escaped content', () => {
    const result = pipeline('### Results for Q1\\.2025');
    assert.equal(result, '*Results for Q1\\.2025*');
  });

  it('code blocks pass through the entire pipeline unchanged', () => {
    const input = '```\nobj.method(x)\n```';
    assert.equal(pipeline(input), input);
  });

  it('inline code: dot inside code unescaped, dot outside code escaped', () => {
    const input = 'See `file.ts` for details.';
    assert.equal(pipeline(input), 'See `file.ts` for details\\.');
  });

  it('links are preserved through the entire pipeline', () => {
    const result = pipeline('[docs](https://example.com)');
    assert.equal(result, '[docs](https://example.com)');
  });

  it('mixed: bold, parens, code, and link in one message', () => {
    const result = pipeline('**Summary**: see [docs](https://x.com) for (details).');
    assert.equal(result, '*Summary*: see [docs](https://x.com) for \\(details\\)\\.');
  });

  it('real-world: **bold with snake_case** does not cause parse failure', () => {
    // The original bug: **preferred_worker** → *preferred_worker* → Telegram rejects lone _
    const result = pipeline('**Phase 2A (preferred_worker)** skips failed workers.');
    assert.ok(result.includes('preferred\\_worker'), 'underscore escaped inside bold');
    assert.ok(!result.match(/[^\\]_/), 'no unescaped bare _');
  });

  it('real-world: **ref with trailing _** is escaped', () => {
    // Bug: **g-31a3_ (no markdown formatting)** → *g-31a3_ ...*  → Telegram parse fail
    const result = pipeline('**g-31a3_ (no markdown formatting)**');
    assert.ok(result.includes('\\_'), 'trailing _ escaped');
    assert.ok(result.includes('\\('), 'parens escaped');
  });

  it('real-world: bare ~ as approximation prefix causes parse failure (c-1367 bug)', () => {
    // Bug: "~15 min" and "~2–3h" appeared unescaped in bold headers, Telegram rejected message
    const result = pipeline('*Plan A* (single file, ~15 min)\n*Plan B* (6 phases, ~2–3h)');
    assert.ok(result.includes('\\~15'), 'bare ~ before number escaped');
    assert.ok(result.includes('\\~2'), 'bare ~ in duration escaped');
    assert.ok(!result.match(/[^\\`]~/), 'no unescaped bare ~ outside code span');
  });

  it('real-world: ~strikethrough~ preserved while bare ~ is escaped in same message', () => {
    const result = pipeline('~done~ (took ~15 min)');
    assert.ok(result.includes('~done~'), 'valid strikethrough preserved');
    assert.ok(result.includes('\\~15'), 'bare ~ before duration escaped');
  });
});

// ---------------------------------------------------------------------------
// getUpdates — fetch mocked
// ---------------------------------------------------------------------------

type FetchResponse = {
  ok: boolean;
  status?: number;
  bodyText?: string;
  bodyJson?: unknown;
  throwError?: Error;
};

function setupFetchMock(responses: FetchResponse[]): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  (globalThis as Record<string, unknown>).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r.throwError) throw r.throwError;
    const json = r.bodyJson ?? {};
    const text = r.bodyText ?? JSON.stringify(json);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      text: async () => text,
      json: async () => json,
    };
  };
  return calls;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('getUpdates', () => {
  it('returns parsed updates on success', async () => {
    const updates = [{ update_id: 1, message: { text: 'hello' } }];
    setupFetchMock([{ ok: true, bodyJson: { ok: true, result: updates } }]);

    const result = await getUpdates('token', 0);
    assert.equal(result.length, 1);
    assert.equal(result[0].update_id, 1);
  });

  it('returns empty array when no updates', async () => {
    setupFetchMock([{ ok: true, bodyJson: { ok: true, result: [] } }]);
    const result = await getUpdates('token', 0);
    assert.deepEqual(result, []);
  });

  it('includes offset in URL', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: [] } }]);
    await getUpdates('mytoken', 42);
    assert.ok(calls[0].url.includes('offset=42'), `URL missing offset: ${calls[0].url}`);
  });

  it('includes offset=0 in URL (used by first-run drain)', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: [] } }]);
    await getUpdates('mytoken', 0);
    assert.ok(calls[0].url.includes('offset=0'), `URL missing offset=0: ${calls[0].url}`);
  });

  it('includes token in URL', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: [] } }]);
    await getUpdates('mytoken', 0);
    assert.ok(calls[0].url.includes('mytoken'), `URL missing token: ${calls[0].url}`);
  });

  it('hits the getUpdates endpoint', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: [] } }]);
    await getUpdates('mytoken', 0);
    assert.ok(calls[0].url.includes('/getUpdates'), `URL missing endpoint: ${calls[0].url}`);
  });

  it('throws when HTTP response is not ok', async () => {
    setupFetchMock([{ ok: false, status: 401, bodyText: 'Unauthorized' }]);
    await assert.rejects(
      () => getUpdates('token', 0),
      /getUpdates failed/,
    );
  });

  it('throws when response body has ok: false', async () => {
    setupFetchMock([{ ok: true, bodyJson: { ok: false, description: 'Bad request' } }]);
    await assert.rejects(
      () => getUpdates('token', 0),
      /getUpdates not ok/,
    );
  });

  it('includes timeout=0 in URL by default (2-arg call)', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: [] } }]);
    await getUpdates('mytoken', 0);
    assert.ok(calls[0].url.includes('timeout=0'), `URL missing timeout=0: ${calls[0].url}`);
  });

  it('includes custom timeout in URL when specified', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: [] } }]);
    await getUpdates('mytoken', 0, 30);
    assert.ok(calls[0].url.includes('timeout=30'), `URL missing timeout=30: ${calls[0].url}`);
  });

  it('passes AbortSignal to fetch when provided', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: [] } }]);
    const controller = new AbortController();
    await getUpdates('mytoken', 0, 0, controller.signal);
    assert.ok(calls[0].init?.signal === controller.signal, 'signal must be passed to fetch init');
  });

  it('does not pass signal to fetch when not provided', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: [] } }]);
    await getUpdates('mytoken', 0);
    assert.ok(!calls[0].init, 'fetch init must be undefined when no signal provided');
  });

  it('propagates AbortError when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    // Real fetch throws AbortError for pre-aborted signals — mock it the same way
    (globalThis as Record<string, unknown>).fetch = async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        throw err;
      }
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({ ok: true, result: [] }) };
    };

    await assert.rejects(
      () => getUpdates('mytoken', 0, 0, controller.signal),
      (err: any) => err.name === 'AbortError',
      'getUpdates must propagate AbortError from fetch',
    );
  });
});

// ---------------------------------------------------------------------------
// sendMessage — fetch mocked
// ---------------------------------------------------------------------------

describe('sendMessage', () => {
  it('hits the sendMessage endpoint', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    await sendMessage('mytoken', 123, 'hi');
    assert.ok(calls[0].url.includes('/sendMessage'), `URL missing endpoint: ${calls[0].url}`);
  });

  it('sends a single message successfully', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    await sendMessage('token', 123, 'hello');
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.chat_id, 123);
    assert.equal(body.text, 'hello');
    assert.equal(body.parse_mode, 'MarkdownV2');
  });

  it('sends reply_to_message_id on first chunk only', async () => {
    // Force a two-chunk message
    const longText = 'a'.repeat(MAX + 100);
    const calls = setupFetchMock([
      { ok: true, bodyJson: { ok: true } },
      { ok: true, bodyJson: { ok: true } },
    ]);
    await sendMessage('token', 123, longText, 99);

    assert.equal(calls.length, 2);
    const firstBody = JSON.parse(calls[0].init!.body as string);
    const secondBody = JSON.parse(calls[1].init!.body as string);
    assert.equal(firstBody.reply_to_message_id, 99, 'first chunk must include reply_to');
    assert.equal(secondBody.reply_to_message_id, undefined, 'second chunk must not have reply_to');
  });

  it('sends N fetch calls for N chunks', async () => {
    const threeChunks = 'x'.repeat(MAX * 3);
    const calls = setupFetchMock([
      { ok: true, bodyJson: { ok: true } },
      { ok: true, bodyJson: { ok: true } },
      { ok: true, bodyJson: { ok: true } },
    ]);
    await sendMessage('token', 123, threeChunks);
    assert.equal(calls.length, 3);
  });

  it('retries without Markdown parse_mode when server reports parse error', async () => {
    const calls = setupFetchMock([
      { ok: false, status: 400, bodyText: "Bad Request: can't parse entities" },
      { ok: true, bodyJson: { ok: true } },
    ]);
    await sendMessage('token', 123, 'text with *bad markdown');
    assert.equal(calls.length, 2, 'should retry after parse failure');
    const retryBody = JSON.parse(calls[1].init!.body as string);
    assert.equal(retryBody.parse_mode, undefined, 'retry must omit parse_mode');
  });

  it('logs error and does not throw when both attempts fail', async () => {
    setupFetchMock([
      { ok: false, status: 400, bodyText: "can't parse" },
      { ok: false, status: 500, bodyText: 'Internal server error' },
    ]);
    // Must not throw — sendMessage swallows send failures
    await assert.doesNotReject(() => sendMessage('token', 123, 'text'));
  });

  it('logs error and does not throw on non-parse HTTP error', async () => {
    setupFetchMock([{ ok: false, status: 403, bodyText: 'Forbidden' }]);
    await assert.doesNotReject(() => sendMessage('token', 123, 'text'));
  });

  it('trims leading/trailing whitespace from text before splitting', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    await sendMessage('token', 123, '  hello  ');
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.text, 'hello');
  });

  it('sends no request for replyToMessageId=undefined (no second arg effect)', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    await sendMessage('token', 123, 'hi', undefined);
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.reply_to_message_id, undefined);
  });

  it('includes message_thread_id when threadId > 0', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    await sendMessage('token', 123, 'hi', undefined, 456);
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.message_thread_id, 456);
  });

  it('omits message_thread_id when threadId is 0', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    await sendMessage('token', 123, 'hi', undefined, 0);
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.message_thread_id, undefined);
  });

  it('includes message_thread_id on all chunks for multi-chunk messages', async () => {
    const longText = 'a'.repeat(MAX + 100);
    const calls = setupFetchMock([
      { ok: true, bodyJson: { ok: true } },
      { ok: true, bodyJson: { ok: true } },
    ]);
    await sendMessage('token', 123, longText, undefined, 789);
    assert.equal(calls.length, 2);
    const first = JSON.parse(calls[0].init!.body as string);
    const second = JSON.parse(calls[1].init!.body as string);
    assert.equal(first.message_thread_id, 789, 'first chunk must include message_thread_id');
    assert.equal(second.message_thread_id, 789, 'second chunk must include message_thread_id');
  });

  it('returns true when chunk is delivered successfully', async () => {
    setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    const result = await sendMessage('token', 123, 'hello');
    assert.equal(result, true);
  });

  it('returns false when all 3 network retries are exhausted', async () => {
    const netErr = new Error('ECONNRESET');
    setupFetchMock([
      { ok: false, throwError: netErr },
      { ok: false, throwError: netErr },
      { ok: false, throwError: netErr },
    ]);
    const result = await sendMessage('token', 123, 'hello');
    assert.equal(result, false);
  });

  it('returns false on non-parse API error', async () => {
    setupFetchMock([{ ok: false, status: 403, bodyText: 'Forbidden' }]);
    const result = await sendMessage('token', 123, 'hello');
    assert.equal(result, false);
  });

  it('returns true when Markdown fails but plain-text fallback succeeds', async () => {
    setupFetchMock([
      { ok: false, status: 400, bodyText: "can't parse entities" },
      { ok: true, bodyJson: { ok: true } },
    ]);
    const result = await sendMessage('token', 123, 'text with *bad markdown');
    assert.equal(result, true);
  });

  it('returns false when both Markdown and plain-text attempts fail', async () => {
    setupFetchMock([
      { ok: false, status: 400, bodyText: "can't parse entities" },
      { ok: false, status: 500, bodyText: 'Internal server error' },
    ]);
    const result = await sendMessage('token', 123, 'text');
    assert.equal(result, false);
  });

  it('returns false when plain-text fallback throws a network error', async () => {
    const netErr = new Error('ECONNRESET');
    setupFetchMock([
      { ok: false, status: 400, bodyText: "can't parse" },
      { ok: false, throwError: netErr },
    ]);
    const result = await sendMessage('token', 123, 'text');
    assert.equal(result, false);
  });

  it('returns true for multi-chunk when all chunks succeed', async () => {
    const twoChunks = 'x'.repeat(MAX + 100);
    setupFetchMock([
      { ok: true, bodyJson: { ok: true } },
      { ok: true, bodyJson: { ok: true } },
    ]);
    const result = await sendMessage('token', 123, twoChunks);
    assert.equal(result, true);
  });

  it('returns false for multi-chunk when one chunk fails', async () => {
    const twoChunks = 'x'.repeat(MAX + 100);
    setupFetchMock([
      { ok: true, bodyJson: { ok: true } },
      { ok: false, status: 403, bodyText: 'Forbidden' },
    ]);
    const result = await sendMessage('token', 123, twoChunks);
    assert.equal(result, false);
  });

  it('returns true on timeout (optimistic — not retrying avoids duplicate delivery)', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    const calls = setupFetchMock([
      { ok: false, throwError: abortErr },
      { ok: false, throwError: abortErr },
      { ok: false, throwError: abortErr },
    ]);
    const result = await sendMessage('token', 123, 'hi');
    assert.equal(result, true, 'timeout is treated as optimistically delivered');
    assert.equal(calls.length, 1, 'must not retry after timeout');
  });

  it('returns true on TimeoutError (Node.js AbortSignal.timeout variant)', async () => {
    const timeoutErr = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    const calls = setupFetchMock([{ ok: false, throwError: timeoutErr }]);
    const result = await sendMessage('token', 123, 'hi');
    assert.equal(result, true, 'TimeoutError treated as optimistically delivered');
    assert.equal(calls.length, 1, 'must not retry after TimeoutError');
  });

  it('still retries up to 3 times on non-timeout network error (ECONNRESET)', async () => {
    const netErr = new Error('ECONNRESET');
    const calls = setupFetchMock([
      { ok: false, throwError: netErr },
      { ok: false, throwError: netErr },
      { ok: false, throwError: netErr },
    ]);
    const result = await sendMessage('token', 123, 'hi');
    assert.equal(result, false, 'connection errors exhaust retries and return false');
    assert.equal(calls.length, 3, 'must retry 3 times on ECONNRESET');
  });

  it('passes AbortSignal.timeout to each fetch attempt', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    await sendMessage('token', 123, 'hi');
    assert.ok(calls[0].init?.signal instanceof AbortSignal, 'signal must be an AbortSignal');
  });

  it('returns true when markdown fails and plain-text fallback times out (optimistic)', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    setupFetchMock([
      { ok: false, status: 400, bodyText: "can't parse entities" },
      { ok: false, throwError: abortErr },
    ]);
    const result = await sendMessage('token', 123, '**hi**');
    assert.equal(result, true, 'fallback timeout is treated as optimistically delivered');
  });

  it('strips italic markers from ref ID in plain-text fallback', async () => {
    const calls = setupFetchMock([
      { ok: false, status: 400, bodyText: "can't parse entities" },
      { ok: true, bodyJson: { ok: true } },
    ]);
    // Simulate a message that already has a ref ID appended (as appendRefId would produce)
    await sendMessage('token', 123, 'hello world\n\n_Ref: g-ab12_');
    assert.equal(calls.length, 2, 'should retry after parse failure');
    const fallbackBody = JSON.parse(calls[1].init!.body as string);
    assert.ok(fallbackBody.text.includes('Ref: g-ab12'), 'ref ID preserved in fallback text');
    assert.ok(!fallbackBody.text.includes('_Ref:'), 'italic markers stripped in fallback');
    assert.equal(fallbackBody.parse_mode, undefined, 'parse_mode omitted in fallback');
  });

  it('strips italic markers from ref ID even when ref is in its own chunk (no leading \\n\\n)', async () => {
    const calls = setupFetchMock([
      { ok: false, status: 400, bodyText: "can't parse entities" },
      { ok: true, bodyJson: { ok: true } },
    ]);
    // Simulate the edge case where splitMessage puts the ref alone in its own chunk
    await sendMessage('token', 123, '_Ref: g-ab12_');
    assert.equal(calls.length, 2);
    const fallbackBody = JSON.parse(calls[1].init!.body as string);
    assert.ok(fallbackBody.text.includes('Ref: g-ab12'), 'ref ID preserved');
    assert.ok(!fallbackBody.text.includes('_Ref:'), 'italic markers stripped');
  });

  it('strips italic markers from a 12-hex ref ID (post-Phase-3 width) in plain-text fallback', async () => {
    // Pins the {4,} widening of the fallback regex: a mis-widened {12} would
    // break the legacy tests above; a leftover {4} would break this one.
    const calls = setupFetchMock([
      { ok: false, status: 400, bodyText: "can't parse entities" },
      { ok: true, bodyJson: { ok: true } },
    ]);
    await sendMessage('token', 123, 'hello world\n\n_Ref: s-a1b2c3d4e5f6_');
    assert.equal(calls.length, 2, 'should retry after parse failure');
    const fallbackBody = JSON.parse(calls[1].init!.body as string);
    assert.ok(fallbackBody.text.includes('Ref: s-a1b2c3d4e5f6'), '12-hex ref ID preserved in fallback text');
    assert.ok(!fallbackBody.text.includes('_Ref:'), 'italic markers stripped in fallback');
  });
});

// ---------------------------------------------------------------------------
// sendTyping — fetch mocked
// ---------------------------------------------------------------------------

describe('sendTyping', () => {
  it('calls sendChatAction endpoint', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    await sendTyping('token', 123);
    assert.ok(calls[0].url.includes('/sendChatAction'));
  });

  it('sends chat_id and action=typing', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    await sendTyping('token', 123);
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.chat_id, 123);
    assert.equal(body.action, 'typing');
  });

  it('includes message_thread_id when threadId > 0', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    await sendTyping('token', 123, 456);
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.message_thread_id, 456);
  });

  it('omits message_thread_id when threadId is 0 or omitted', async () => {
    for (const threadId of [0, undefined]) {
      const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
      await sendTyping('token', 123, threadId);
      const body = JSON.parse(calls[0].init!.body as string);
      assert.equal(body.message_thread_id, undefined, `threadId=${threadId} should omit field`);
    }
  });

  it('allows at least 10s for the request (AI-095: 3s budget starved typing on slow networks)', () => {
    assert.ok(SEND_TYPING_TIMEOUT_MS >= 10_000, `SEND_TYPING_TIMEOUT_MS=${SEND_TYPING_TIMEOUT_MS}`);
  });

  it('swallows network errors without throwing', async () => {
    globalThis.fetch = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    await assert.doesNotReject(sendTyping('token', 123, 456));
  });
});

// ---------------------------------------------------------------------------
// sendMessageWithId
// ---------------------------------------------------------------------------

describe('sendMessageWithId', () => {
  it('returns message_id on success', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: { message_id: 42 } } }]);
    const id = await sendMessageWithId('token', 123, 'hello');
    assert.equal(id, 42);
    assert.ok(calls[0].url.includes('/sendMessage'));
  });

  it('sends chat_id and text in body', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: { message_id: 1 } } }]);
    await sendMessageWithId('token', 123, 'hello');
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.chat_id, 123);
    assert.equal(body.text, 'hello');
  });

  it('includes message_thread_id when threadId > 0', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: { message_id: 1 } } }]);
    await sendMessageWithId('token', 123, 'hello', 99);
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.message_thread_id, 99);
  });

  it('omits message_thread_id when threadId is 0 or omitted', async () => {
    for (const threadId of [0, undefined] as const) {
      const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: { message_id: 1 } } }]);
      await sendMessageWithId('token', 123, 'hello', threadId);
      const body = JSON.parse(calls[0].init!.body as string);
      assert.equal(body.message_thread_id, undefined);
    }
  });

  it('returns null on API failure', async () => {
    setupFetchMock([{ ok: false, bodyText: 'Bad Request' }]);
    const id = await sendMessageWithId('token', 123, 'hello');
    assert.equal(id, null);
  });

  it('returns null when fetch aborts (timeout)', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    setupFetchMock([{ ok: false, throwError: abortErr }]);
    const id = await sendMessageWithId('token', 123, 'hi');
    assert.equal(id, null);
  });

  it('passes AbortSignal to fetch', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: { message_id: 42 } } }]);
    await sendMessageWithId('token', 123, 'hi');
    assert.ok(calls[0].init?.signal instanceof AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// pinChatMessage / unpinChatMessage
// ---------------------------------------------------------------------------

describe('pinChatMessage', () => {
  it('calls pinChatMessage endpoint with chat_id and message_id', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    await pinChatMessage('token', 123, 456);
    assert.ok(calls[0].url.includes('/pinChatMessage'));
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.chat_id, 123);
    assert.equal(body.message_id, 456);
  });

  it('sets disable_notification to suppress push notifications', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    await pinChatMessage('token', 123, 456);
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.disable_notification, true);
  });

  it('does not throw on API failure', async () => {
    setupFetchMock([{ ok: false, bodyText: 'Bad Request' }]);
    await assert.doesNotReject(() => pinChatMessage('token', 123, 456));
  });

  it('returns true on first-attempt success', async () => {
    const calls = setupFetchMock([{ ok: true }]);
    const result = await pinChatMessage('token', 123, 456);
    assert.equal(result, true);
    assert.equal(calls.length, 1);
  });

  it('retries on API failure and returns true on second attempt', async () => {
    const calls = setupFetchMock([{ ok: false, bodyText: 'Bad Gateway' }, { ok: true }]);
    const result = await pinChatMessage('token', 123, 456);
    assert.equal(result, true);
    assert.equal(calls.length, 2);
  });

  it('returns false after both attempts fail', async () => {
    const calls = setupFetchMock([{ ok: false, bodyText: 'Bad Gateway' }, { ok: false, bodyText: 'Bad Gateway' }]);
    const result = await pinChatMessage('token', 123, 456);
    assert.equal(result, false);
    assert.equal(calls.length, 2);
  });

  it('retries on network error and returns true on second attempt', async () => {
    const netErr = new Error('ECONNRESET');
    const calls = setupFetchMock([{ ok: false, throwError: netErr }, { ok: true }]);
    const result = await pinChatMessage('token', 123, 456);
    assert.equal(result, true);
    assert.equal(calls.length, 2);
  });
});

describe('unpinChatMessage', () => {
  it('calls unpinChatMessage endpoint with chat_id and message_id', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    await unpinChatMessage('token', 123, 456);
    assert.ok(calls[0].url.includes('/unpinChatMessage'));
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.chat_id, 123);
    assert.equal(body.message_id, 456);
  });

  it('does not throw on API failure', async () => {
    setupFetchMock([{ ok: false, bodyText: 'Bad Request' }]);
    await assert.doesNotReject(() => unpinChatMessage('token', 123, 456));
  });
});
