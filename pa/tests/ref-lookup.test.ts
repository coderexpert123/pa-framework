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
