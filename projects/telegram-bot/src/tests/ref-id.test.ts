import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeRefId, appendRefId, appendRefIdAndLog } from '../ref-id.js';
import { flushLog } from '../../../../pa/dist/src/lib/log.js';
import { rmRetry } from './rm-retry.js';

describe('makeRefId', { concurrency: 1 }, () => {
  it('returns s-xxxx format by default', () => {
    const id = makeRefId();
    assert.match(id, /^s-[0-9a-f]{4}$/);
  });

  it('uses the given prefix verbatim', () => {
    const id = makeRefId('z');
    assert.match(id, /^z-[0-9a-f]{4}$/);
  });

  it('uses multi-char prefix verbatim (callers must pass single char if desired)', () => {
    const id = makeRefId('zclaude');
    assert.match(id, /^zclaude-[0-9a-f]{4}$/);
  });

  it('produces different values on successive calls (randomness)', () => {
    const a = makeRefId();
    const b = makeRefId();
    // Extremely low probability of collision (1/65536); retry once to be safe
    const c = makeRefId();
    assert.ok(a !== b || a !== c, 'makeRefId should produce unique values');
  });
});

describe('appendRefId', { concurrency: 1 }, () => {
  it('appends ref ID with default s prefix', () => {
    const result = appendRefId('hello');
    assert.match(result, /^hello\n\n_Ref: s-[0-9a-f]{4}_$/);
  });

  it('trims leading and trailing whitespace from input', () => {
    const result = appendRefId('  hello  ');
    assert.ok(result.startsWith('hello'), 'result must start with trimmed content');
    assert.ok(!result.startsWith(' '), 'result must not have leading whitespace');
  });

  it('uses supplied prefix', () => {
    const result = appendRefId('hello', 'c');
    assert.match(result, /^hello\n\n_Ref: c-[0-9a-f]{4}_$/);
  });
});

describe('appendRefIdAndLog', { concurrency: 1 }, () => {
  let tempDir: string;
  let originalPaHome: string | undefined;

  beforeEach(async () => {
    await flushLog(); // drain pending appends before switching PA_HOME so they don't bleed into tempDir
    tempDir = await mkdtemp(join(tmpdir(), 'refid-log-test-'));
    originalPaHome = process.env.PA_HOME;
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await flushLog(); // drain fire-and-forget appendRefIdAndLog writes to tempDir before removing it
    if (originalPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = originalPaHome;
    await rmRetry(tempDir);
  });

  async function readLogEntries(): Promise<any[]> {
    await flushLog(); // deterministic — await pending log writes instead of a racy fixed sleep
    const raw = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('returns text with ref appended (default s- prefix)', () => {
    const result = appendRefIdAndLog('hello', { kind: 'pin', chatId: 1, threadId: 2 });
    assert.match(result, /^hello\n\n_Ref: s-[0-9a-f]{4}_$/);
  });

  it('logs an app.log entry with module=bot, message="system message sent", and full context', async () => {
    appendRefIdAndLog('hello world', { kind: 'pin', chatId: 42, threadId: 7 });
    const entries = await readLogEntries();
    const entry = entries.find((e) => e.message === 'system message sent');
    assert.ok(entry, 'system message sent entry must exist');
    assert.equal(entry.module, 'bot');
    assert.equal(entry.kind, 'pin');
    assert.equal(entry.chatId, 42);
    assert.equal(entry.threadId, 7);
    assert.equal(entry.textPreview, 'hello world');
    assert.match(entry.refId, /^s-[0-9a-f]{4}$/);
  });

  it('truncates textPreview to 500 chars', async () => {
    const long = 'x'.repeat(800);
    appendRefIdAndLog(long, { kind: 'failover', chatId: 1 });
    const entries = await readLogEntries();
    const entry = entries.find((e) => e.message === 'system message sent');
    assert.ok(entry);
    assert.equal(entry.textPreview.length, 500);
  });

  it('honours every RefKind value', async () => {
    const kinds = ['pin', 'help', 'branch', 'lock_busy', 'failover', 'system'] as const;
    for (const kind of kinds) {
      appendRefIdAndLog(`msg-${kind}`, { kind, chatId: 1 });
    }
    const entries = await readLogEntries();
    const seen = entries.filter((e) => e.message === 'system message sent').map((e) => e.kind);
    for (const kind of kinds) assert.ok(seen.includes(kind), `kind=${kind} must appear in log`);
  });
});
