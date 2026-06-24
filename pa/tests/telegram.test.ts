import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { splitMessage, sendToTelegram } from '../src/telegram.js';
import { flushLog } from '../src/lib/log.js';
import type { TelegramOutput } from '../src/types.js';

type FetchResponse = { ok: boolean; status?: number; bodyText?: string };
function setupFetchMock(responses: FetchResponse[]): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  (globalThis as Record<string, unknown>).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    const text = r.bodyText ?? '{}';
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 400), text: async () => text, json: async () => ({}) };
  };
  return calls;
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe('splitMessage', () => {
  it('returns single chunk when text is within limit', () => {
    const text = 'Hello world';
    assert.deepEqual(splitMessage(text), [text]);
  });

  it('returns single chunk at exactly 4000 chars', () => {
    const text = 'x'.repeat(4000);
    assert.deepEqual(splitMessage(text), [text]);
  });

  it('splits on double-newline boundary', () => {
    const para1 = 'a'.repeat(3000);
    const para2 = 'b'.repeat(3000);
    const text = `${para1}\n\n${para2}`;
    const chunks = splitMessage(text);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], para1);
    assert.equal(chunks[1], para2);
  });

  it('splits on single-newline when no double-newline within limit', () => {
    const line1 = 'a'.repeat(3000);
    const line2 = 'b'.repeat(3000);
    const text = `${line1}\n${line2}`;
    const chunks = splitMessage(text);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], line1);
    assert.equal(chunks[1], line2);
  });

  it('hard-cuts at 4000 when no newline boundary exists', () => {
    const text = 'x'.repeat(5000);
    const chunks = splitMessage(text);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 4000);
    assert.equal(chunks[1].length, 1000);
  });

  it('handles empty string', () => {
    assert.deepEqual(splitMessage(''), ['']);
  });
});

// ---------------------------------------------------------------------------
// sendToTelegram — ref ID appending
// ---------------------------------------------------------------------------

describe('sendToTelegram', () => {
  const cfg: TelegramOutput = { chat_id: '-1001234567', token_secret: 'T' };

  it('appends an italic ref ID to the message text', async () => {
    const calls = setupFetchMock([{ ok: true }]);
    await sendToTelegram('hello', cfg, 'tok');
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init!.body as string);
    assert.match(body.text, /hello\n\n_Ref: s-[0-9a-f]{4}_$/);
  });

  it('uses Markdown parse mode by default', async () => {
    const calls = setupFetchMock([{ ok: true }]);
    await sendToTelegram('hello', cfg, 'tok');
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.parse_mode, 'Markdown');
  });

  it('strips italic markers from ref ID in plain-text fallback', async () => {
    const calls = setupFetchMock([
      { ok: false, status: 400, bodyText: "can't parse entities" },
      { ok: true },
    ]);
    await sendToTelegram('hello', cfg, 'tok');
    assert.equal(calls.length, 2, 'should retry after parse failure');
    const fallback = JSON.parse(calls[1].init!.body as string);
    assert.match(fallback.text, /Ref: s\-[0-9a-f]{4}$/, 'ref ID preserved');
    assert.ok(!fallback.text.includes('_Ref:'), 'italic markers stripped');
    assert.equal(fallback.parse_mode, undefined, 'parse_mode omitted');
  });

  it('does not throw on failure', async () => {
    setupFetchMock([{ ok: false, status: 500, bodyText: 'error' }]);
    await assert.doesNotReject(() => sendToTelegram('hello', cfg, 'tok'));
  });

  it("uses 'Markdown' parse mode when explicitly passed (legacy, body NOT sanitized)", async () => {
    const calls = setupFetchMock([{ ok: true }]);
    await sendToTelegram('node_modules/path with (parens)', cfg, 'tok', 'Markdown');
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.parse_mode, 'Markdown');
    // Body unsanitized — original underscores and parens pass through.
    assert.ok(body.text.includes('node_modules/path with (parens)'), 'body unmodified');
  });

  it('omits parse_mode when parseMode=false (plain text, body NOT sanitized)', async () => {
    const calls = setupFetchMock([{ ok: true }]);
    await sendToTelegram('hello (raw)', cfg, 'tok', false);
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.parse_mode, undefined);
    assert.ok(body.text.includes('hello (raw)'), 'body unmodified');
  });

  it("uses 'MarkdownV2' and sanitizes body, preserving italic Ref trailer with escaped dash", async () => {
    const calls = setupFetchMock([{ ok: true }]);
    await sendToTelegram('node_modules/path (with parens).', cfg, 'tok', 'MarkdownV2');
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.parse_mode, 'MarkdownV2');
    // Body sanitized: `_` escaped, `(` escaped, `.` escaped.
    assert.ok(body.text.includes('node\\_modules/path \\(with parens\\)\\.'), 'body sanitized');
    // Trailer: italic markers RAW, but dash inside refId is escaped to \-
    // (Telegram MdV2 requires `-` escaped even inside italic spans).
    assert.match(body.text, /\n\n_Ref: s\\-[0-9a-f]{4}_$/, 'italic Ref trailer with escaped dash');
  });

  it("MarkdownV2 plain-text fallback: parse error retries without parse_mode and strips italic Ref markers", async () => {
    const calls = setupFetchMock([
      { ok: false, status: 400, bodyText: "can't parse entities" },
      { ok: true },
    ]);
    await sendToTelegram('node_modules/x.txt', cfg, 'tok', 'MarkdownV2');
    assert.equal(calls.length, 2, 'fallback retried');
    const fallback = JSON.parse(calls[1].init!.body as string);
    assert.equal(fallback.parse_mode, undefined, 'parse_mode omitted on retry');
    assert.match(fallback.text, /Ref: s-[0-9a-f]{4}$/, 'ref ID kept (markers stripped)');
    assert.ok(!fallback.text.includes('_Ref:'), 'italic markers stripped');
  });
});

// ---------------------------------------------------------------------------
// sendToTelegram — textPreview in app.log entry (Phase 3)
// ---------------------------------------------------------------------------

describe('sendToTelegram — app.log textPreview', () => {
  const cfg: TelegramOutput = { chat_id: '-1001234567', token_secret: 'T' };
  let tempDir: string;
  let originalPaHome: string | undefined;

  beforeEach(async () => {
    // Drain any pending log appends from prior tests BEFORE switching PA_HOME —
    // the logger resolves its path at write time, so undrained appends would
    // otherwise bleed into this test's fresh tempDir and pollute the read.
    await flushLog();
    tempDir = await mkdtemp(join(tmpdir(), 'pa-telegram-test-'));
    originalPaHome = process.env.PA_HOME;
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    if (originalPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = originalPaHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  async function readLogEntries(): Promise<any[]> {
    await flushLog(); // deterministic — await pending log writes instead of racing a fixed sleep
    const raw = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('happy path: includes textPreview in "skill message sent" entry', async () => {
    setupFetchMock([{ ok: true }]);
    await sendToTelegram('hello world from skill', cfg, 'tok');
    const entries = await readLogEntries();
    const entry = entries.find((e) => e.message === 'skill message sent');
    assert.ok(entry, 'skill message sent entry must exist');
    assert.ok(typeof entry.textPreview === 'string', 'textPreview field must be present');
    assert.ok(entry.textPreview.includes('hello world from skill'));
  });

  it('plain-text fallback: includes textPreview in fallback log entry', async () => {
    setupFetchMock([
      { ok: false, status: 400, bodyText: "can't parse entities" },
      { ok: true },
    ]);
    await sendToTelegram('hello fallback', cfg, 'tok');
    const entries = await readLogEntries();
    const entry = entries.find((e) => e.message === 'skill message sent (plain-text fallback)');
    assert.ok(entry, 'plain-text fallback entry must exist');
    assert.ok(typeof entry.textPreview === 'string', 'textPreview field must be present');
    assert.ok(entry.textPreview.includes('hello fallback'));
  });

  it('truncates textPreview to 500 chars', async () => {
    setupFetchMock([{ ok: true }]);
    await sendToTelegram('x'.repeat(1000), cfg, 'tok');
    const entries = await readLogEntries();
    const entry = entries.find((e) => e.message === 'skill message sent');
    assert.ok(entry);
    assert.equal(entry.textPreview.length, 500);
  });
});
