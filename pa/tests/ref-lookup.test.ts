import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { lookupRefId } from '../src/lib/ref-lookup.js';

let tempDir: string;
let originalPaHome: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pa-ref-lookup-test-'));
  originalPaHome = process.env.PA_HOME;
  process.env.PA_HOME = tempDir;
});

afterEach(async () => {
  if (originalPaHome === undefined) delete process.env.PA_HOME;
  else process.env.PA_HOME = originalPaHome;
  await rm(tempDir, { recursive: true, force: true });
});

async function writeConversationHistory(entries: any[]): Promise<void> {
  const path = join(tempDir, 'conversation-history.jsonl');
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(path, content, 'utf8');
}

async function writeAppLog(entries: any[]): Promise<void> {
  const path = join(tempDir, 'app.log.jsonl');
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(path, content, 'utf8');
}

/**
 * Write a conversation-history.jsonl big enough to actually exercise
 * tailLines()'s byte-seek branch (startByte > 0), not just its final
 * slice(-maxLines) line-window trim. tailLines' bytesToRead for
 * scanConversationHistory is TAIL_LINES(10_000) * 1500 * 2 = ~28.6 MiB — a
 * naive fixture of >10,000 small lines stays far under that and never
 * exercises the seek offset or the partial-first-line-drop logic. This
 * writes 60 entries padded to ~600KB each (~34MB total, safely over the
 * ~28.6MB window) so a real seek happens.
 */
async function writeLargeConversationHistory(
  entryCount: number,
  paddingBytes: number,
  overrides: (i: number) => Record<string, unknown>
): Promise<void> {
  const path = join(tempDir, 'conversation-history.jsonl');
  const pad = 'x'.repeat(paddingBytes);
  const lines: string[] = [];
  for (let i = 0; i < entryCount; i++) {
    lines.push(JSON.stringify({
      role: 'assistant', text: pad, timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
      worker: 'claude', session_id: `sess-${i}`, thread_id: 1,
      ...overrides(i),
    }));
  }
  await writeFile(path, lines.join('\n') + '\n', 'utf8');
}

describe('lookupRefId — conversation-history matches', () => {
  it('returns kind=turn with full text when refId found in conversation-history.jsonl', async () => {
    await writeConversationHistory([
      { role: 'user', text: 'q', timestamp: '2026-04-28T10:00:00Z', message_id: 1, thread_id: 100 },
      { role: 'assistant', text: 'long answer here', timestamp: '2026-04-28T10:00:01Z', worker: 'claude', session_id: 'sess-1', thread_id: 100, refId: 'c-a59a' },
    ]);

    const result = await lookupRefId('c-a59a');
    assert.ok(result);
    assert.equal(result.kind, 'turn');
    assert.equal(result.refId, 'c-a59a');
    assert.equal(result.text, 'long answer here');
    assert.equal(result.worker, 'claude');
    assert.equal(result.sessionId, 'sess-1');
    assert.equal(result.threadId, 100);
    assert.equal(result.source, 'conversation-history');
  });

  it('skips entries without matching refId field', async () => {
    await writeConversationHistory([
      { role: 'assistant', text: 'no refId here', timestamp: '2026-04-28T10:00:00Z' },
      { role: 'assistant', text: 'matching one', timestamp: '2026-04-28T10:00:01Z', refId: 'c-aaaa' },
    ]);

    const result = await lookupRefId('c-aaaa');
    assert.ok(result);
    assert.equal(result.text, 'matching one');
  });
});

describe('lookupRefId — app.log fallback', () => {
  it('returns kind=turn for "message sent" entry', async () => {
    await writeAppLog([
      { timestamp: '2026-04-28T10:00:00Z', level: 'info', module: 'bot', message: 'message sent', refId: 'c-1234', worker: 'claude', session_id: 'sess-2', chatId: -100, threadId: 50, messageId: 5 },
    ]);

    const result = await lookupRefId('c-1234');
    assert.ok(result);
    assert.equal(result.kind, 'turn');
    assert.equal(result.worker, 'claude');
    assert.equal(result.chatId, -100);
    assert.equal(result.source, 'app-log');
    // Pre-Phase-2 'message sent' entries have no text; field is undefined.
    assert.equal(result.text, undefined);
  });

  it('returns kind=pin for "system message sent" with kind=pin', async () => {
    await writeAppLog([
      { timestamp: '2026-04-28T10:00:00Z', level: 'info', module: 'bot', message: 'system message sent', refId: 's-pin1', kind: 'pin', chatId: -100, threadId: 0, textPreview: 'pinned status card' },
    ]);

    const result = await lookupRefId('s-pin1');
    assert.ok(result);
    assert.equal(result.kind, 'pin');
    assert.equal(result.text, 'pinned status card');
  });

  it('returns kind=branch for "system message sent" with kind=branch', async () => {
    await writeAppLog([
      { timestamp: '2026-04-28T10:00:00Z', level: 'info', module: 'bot', message: 'system message sent', refId: 's-br01', kind: 'branch', chatId: -100, threadId: 999, textPreview: 'Branch of *parent*' },
    ]);

    const result = await lookupRefId('s-br01');
    assert.ok(result);
    assert.equal(result.kind, 'branch');
  });

  it('returns kind=skill_alert for "skill message sent"', async () => {
    await writeAppLog([
      { timestamp: '2026-04-28T10:00:00Z', level: 'info', module: 'telegram', message: 'skill message sent', refId: 's-9999', chatId: -100, threadId: 3376, chunkIndex: 0, textPreview: 'bg-leak warning' },
    ]);

    const result = await lookupRefId('s-9999');
    assert.ok(result);
    assert.equal(result.kind, 'skill_alert');
    assert.equal(result.text, 'bg-leak warning');
  });

  it('returns kind=skill_alert for plain-text fallback variant', async () => {
    await writeAppLog([
      { timestamp: '2026-04-28T10:00:00Z', level: 'info', module: 'telegram', message: 'skill message sent (plain-text fallback)', refId: 's-fb01', chatId: -100, threadId: 3376, textPreview: 'fallback msg' },
    ]);

    const result = await lookupRefId('s-fb01');
    assert.ok(result);
    assert.equal(result.kind, 'skill_alert');
    assert.equal(result.text, 'fallback msg');
  });

  it('ignores log entries with mismatched message types even if refId matches', async () => {
    await writeAppLog([
      { timestamp: '2026-04-28T10:00:00Z', level: 'info', module: 'bot', message: 'something else', refId: 's-zzzz', chatId: -100 },
    ]);

    const result = await lookupRefId('s-zzzz');
    assert.equal(result, null);
  });
});

describe('lookupRefId — preference + missing files', () => {
  it('prefers conversation-history match over app.log when both have the refId', async () => {
    await writeConversationHistory([
      { role: 'assistant', text: 'from-history', timestamp: '2026-04-28T10:00:01Z', worker: 'claude', refId: 'c-both' },
    ]);
    await writeAppLog([
      { timestamp: '2026-04-28T10:00:01Z', level: 'info', module: 'bot', message: 'message sent', refId: 'c-both', worker: 'claude' },
    ]);

    const result = await lookupRefId('c-both');
    assert.ok(result);
    assert.equal(result.source, 'conversation-history');
    assert.equal(result.text, 'from-history');
  });

  it('returns null when refId not found anywhere', async () => {
    await writeConversationHistory([
      { role: 'assistant', text: 'other', timestamp: '2026-04-28T10:00:00Z', refId: 'c-other' },
    ]);
    await writeAppLog([
      { timestamp: '2026-04-28T10:00:00Z', level: 'info', module: 'bot', message: 'message sent', refId: 's-other' },
    ]);

    const result = await lookupRefId('c-missing');
    assert.equal(result, null);
  });

  it('returns null when neither file exists', async () => {
    const result = await lookupRefId('c-anything');
    assert.equal(result, null);
  });

  it('falls through to app.log when conversation-history.jsonl is absent', async () => {
    await writeAppLog([
      { timestamp: '2026-04-28T10:00:00Z', level: 'info', module: 'bot', message: 'system message sent', refId: 's-only', kind: 'help', chatId: -100, textPreview: 'help text' },
    ]);

    const result = await lookupRefId('s-only');
    assert.ok(result);
    assert.equal(result.source, 'app-log');
    assert.equal(result.kind, 'help');
  });

  it('handles malformed JSON lines gracefully', async () => {
    const path = join(tempDir, 'conversation-history.jsonl');
    await writeFile(path, '{ malformed }\n{"role":"assistant","text":"valid","timestamp":"x","refId":"c-good"}\n', 'utf8');

    const result = await lookupRefId('c-good');
    assert.ok(result);
    assert.equal(result.text, 'valid');
  });
});

describe('lookupRefId — tail-window byte-seek boundary (scanConversationHistory)', () => {
  // These exercise tailLines()'s actual seek branch (startByte > 0) — a file
  // large enough that scanConversationHistory can no longer read it whole,
  // matching the change from a full readFile() to a byte-seeked tail read.
  const PADDING_BYTES = 600_000; // ~600KB per entry
  const ENTRY_COUNT = 60; // ~34-36MB total, safely over the ~28.6MB seek window

  it('does NOT find a refId written near the start of a file bigger than the tail-seek window', async () => {
    await writeLargeConversationHistory(ENTRY_COUNT, PADDING_BYTES, (i) => (
      i === 0 ? { refId: 'c-toooldtofind' } : {}
    ));

    const result = await lookupRefId('c-toooldtofind');
    assert.equal(result, null, 'an entry near byte offset 0 must fall outside the seeked tail window');
  });

  it('DOES find a refId written near the end of a file bigger than the tail-seek window', async () => {
    await writeLargeConversationHistory(ENTRY_COUNT, PADDING_BYTES, (i) => (
      i === ENTRY_COUNT - 1 ? { refId: 'c-recentenough' } : {}
    ));

    const result = await lookupRefId('c-recentenough');
    assert.ok(result, 'an entry near the end of the file must be found within the seeked tail window');
    assert.equal(result.source, 'conversation-history');
  });

  it('does not false-match or crash on the (possibly truncated) first line after the seek point', async () => {
    // The entry immediately after the calculated seek offset may have its
    // first line dropped by tailLines() (a mid-line seek can land inside an
    // existing line). Plant a target a few entries further in — well clear
    // of that boundary — and confirm no crash and no false match anywhere
    // in between.
    await writeLargeConversationHistory(ENTRY_COUNT, PADDING_BYTES, (i) => (
      i === ENTRY_COUNT - 5 ? { refId: 'c-nearboundary' } : {}
    ));

    const result = await lookupRefId('c-nearboundary');
    assert.ok(result, 'a target well within the tail window must still be found without crashing');
    assert.equal(result.source, 'conversation-history');
  });
});

describe('lookupRefId — ambiguity-detection warning', () => {
  let warnCalls: string[];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    warnCalls = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnCalls.push(args.join(' ')); };
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it('warns and still returns the newest match when the same refId has DIFFERENT messageIds (genuine collision)', async () => {
    await writeAppLog([
      { timestamp: '2026-01-01T00:00:00Z', message: 'system message sent', refId: 's-amb1', messageId: 100, kind: 'system', textPreview: 'older, unrelated message' },
      { timestamp: '2026-01-02T00:00:00Z', message: 'system message sent', refId: 's-amb1', messageId: 200, kind: 'system', textPreview: 'newer, unrelated message' },
    ]);

    const result = await lookupRefId('s-amb1');
    assert.ok(result);
    assert.equal(result.text, 'newer, unrelated message', 'still returns the newest match — warning is additive, not a behavior change');
    assert.equal(warnCalls.length, 1, 'exactly one ambiguity warning');
    assert.match(warnCalls[0], /refId_ambiguous/);
  });

  it('does NOT warn when the same refId has the same messageId (intentional reuse of one recurring message)', async () => {
    await writeAppLog([
      { timestamp: '2026-01-01T00:00:00Z', message: 'system message sent', refId: 's-reuse1', messageId: 3368, kind: 'system', textPreview: 'pin edit 1' },
      { timestamp: '2026-01-02T00:00:00Z', message: 'system message sent', refId: 's-reuse1', messageId: 3368, kind: 'system', textPreview: 'pin edit 2 (newest)' },
    ]);

    const result = await lookupRefId('s-reuse1');
    assert.ok(result);
    assert.equal(result.text, 'pin edit 2 (newest)');
    assert.equal(warnCalls.length, 0, 'same-messageId repeats (e.g. coding-dirs pin refresh) must not false-positive');
  });

  it('finds a genuine ambiguity buried behind many legitimate same-messageId repeats', async () => {
    await writeAppLog([
      { timestamp: '2026-01-01T00:00:00Z', message: 'system message sent', refId: 's-buried', messageId: 999, kind: 'system', textPreview: 'unrelated older message' },
      { timestamp: '2026-01-02T00:00:00Z', message: 'system message sent', refId: 's-buried', messageId: 3368, kind: 'system', textPreview: 'pin edit 1' },
      { timestamp: '2026-01-03T00:00:00Z', message: 'system message sent', refId: 's-buried', messageId: 3368, kind: 'system', textPreview: 'pin edit 2' },
      { timestamp: '2026-01-04T00:00:00Z', message: 'system message sent', refId: 's-buried', messageId: 3368, kind: 'system', textPreview: 'pin edit 3 (newest)' },
    ]);

    const result = await lookupRefId('s-buried');
    assert.ok(result);
    assert.equal(result.text, 'pin edit 3 (newest)');
    // Must not stop scanning after the first (matching) subsequent occurrence —
    // the genuinely differing one is two entries further back.
    assert.equal(warnCalls.length, 1, 'must still detect the older genuinely-differing entry past several legitimate repeats');
  });

  it('defaults to warning when messageId is missing on either side (conservative — most mint sites do not thread it yet)', async () => {
    await writeConversationHistory([
      { role: 'assistant', text: 'older reply, no message_id', timestamp: '2026-01-01T10:00:00Z', refId: 'c-nomid', thread_id: 1 },
      { role: 'assistant', text: 'newer reply, no message_id', timestamp: '2026-01-02T10:00:00Z', refId: 'c-nomid', thread_id: 1 },
    ]);

    const result = await lookupRefId('c-nomid');
    assert.ok(result);
    assert.equal(result.text, 'newer reply, no message_id');
    assert.equal(warnCalls.length, 1, 'missing messageId on both sides must default to warning, not silent suppression');
  });

  it('does not warn on a single, non-ambiguous match', async () => {
    await writeAppLog([
      { timestamp: '2026-01-01T00:00:00Z', message: 'system message sent', refId: 's-unique', messageId: 1, kind: 'system', textPreview: 'only one' },
    ]);

    const result = await lookupRefId('s-unique');
    assert.ok(result);
    assert.equal(warnCalls.length, 0);
  });

  it('never warns for wide (12-hex, post-widening) refIds — a repeat is the same logical send by construction', async () => {
    // Multi-chat fan-out: same refId, differing messageIds, no suppression
    // heuristic would match — but the 2^48 space makes a genuine collision
    // within the window impossible, so detection is skipped entirely.
    await writeAppLog([
      { timestamp: '2026-01-01T00:00:00Z', message: 'skill message sent', refId: 's-a1b2c3d4e5f6', messageId: 100, chatId: -100, textPreview: 'sent to group' },
      { timestamp: '2026-01-01T00:00:01Z', message: 'skill message sent', refId: 's-a1b2c3d4e5f6', messageId: 200, chatId: 555, textPreview: 'sent to DM' },
    ]);

    const result = await lookupRefId('s-a1b2c3d4e5f6');
    assert.ok(result);
    assert.equal(result.text, 'sent to DM', 'still returns the newest match');
    assert.equal(warnCalls.length, 0, 'wide refIds must never trigger the ambiguity warning');
  });

  it('never warns for wide-ref multi-chunk sends that log no messageId at all', async () => {
    await writeAppLog([
      { timestamp: '2026-01-01T00:00:00Z', message: 'skill message sent', refId: 's-0123456789ab', chunkIndex: 0, textPreview: 'chunk one' },
      { timestamp: '2026-01-01T00:00:01Z', message: 'skill message sent', refId: 's-0123456789ab', chunkIndex: 1, textPreview: 'chunk two' },
    ]);

    const result = await lookupRefId('s-0123456789ab');
    assert.ok(result);
    assert.equal(warnCalls.length, 0);
  });

  it('conversation-history: suppresses when both occurrences share the same defined message_id', async () => {
    await writeConversationHistory([
      { role: 'assistant', text: 'archived once', timestamp: '2026-01-01T10:00:00Z', refId: 'c-old1', message_id: 42, thread_id: 1 },
      { role: 'assistant', text: 'archived again (newest)', timestamp: '2026-01-02T10:00:00Z', refId: 'c-old1', message_id: 42, thread_id: 1 },
    ]);

    const result = await lookupRefId('c-old1');
    assert.ok(result);
    assert.equal(result.text, 'archived again (newest)');
    assert.equal(result.messageId, 42, 'snake_case message_id mapped through to the record');
    assert.equal(warnCalls.length, 0, 'same defined message_id = same logical message, no warn');
  });

  it('conversation-history: suppresses byte-identical duplicate turns (crash re-archive / merge copies)', async () => {
    await writeConversationHistory([
      { role: 'assistant', text: 'the exact same reply', timestamp: '2026-01-01T10:00:00Z', refId: 'c-dup1', thread_id: 1 },
      { role: 'assistant', text: 'the exact same reply', timestamp: '2026-01-02T10:00:00Z', refId: 'c-dup1', thread_id: 2 },
    ]);

    const result = await lookupRefId('c-dup1');
    assert.ok(result);
    assert.equal(warnCalls.length, 0, 'identical text = same logical turn duplicated, no warn');
  });

  it('warns at most ONCE per lookup even with several distinct colliding entries', async () => {
    await writeAppLog([
      { timestamp: '2026-01-01T00:00:00Z', message: 'system message sent', refId: 's-amb2', messageId: 1, kind: 'system', textPreview: 'first' },
      { timestamp: '2026-01-02T00:00:00Z', message: 'system message sent', refId: 's-amb2', messageId: 2, kind: 'system', textPreview: 'second' },
      { timestamp: '2026-01-03T00:00:00Z', message: 'system message sent', refId: 's-amb2', messageId: 3, kind: 'system', textPreview: 'third (newest)' },
    ]);

    const result = await lookupRefId('s-amb2');
    assert.ok(result);
    assert.equal(result.text, 'third (newest)');
    assert.equal(warnCalls.length, 1, 'warnings are deduped to one per lookup');
  });
});
