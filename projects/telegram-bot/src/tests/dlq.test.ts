import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { appendDlq, loadDlq, clearDlq, writeDlq, flushDlq, DLQ_MAX_AGE_MS, type DlqEntry } from '../dlq.js';

function makeEntry(overrides: Partial<DlqEntry> = {}): DlqEntry {
  return {
    chatId: 123,
    threadId: 0,
    replyToMessageId: undefined,
    text: 'hello',
    timestamp: new Date().toISOString(),
    updateId: 1,
    ...overrides,
  };
}

let tempDir: string;
let originalFetch: typeof globalThis.fetch;
let originalPaHome: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dlq-test-'));
  process.env.PA_HOME = tempDir;
  originalFetch = globalThis.fetch;
  originalPaHome = process.env.PA_HOME;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  if (originalPaHome === undefined) {
    delete process.env.PA_HOME;
  } else {
    process.env.PA_HOME = originalPaHome;
  }
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// appendDlq
// ---------------------------------------------------------------------------

describe('appendDlq', () => {
  it('creates file if missing and writes valid JSON line', async () => {
    const entry = makeEntry();
    await appendDlq(entry);
    const raw = await readFile(join(tempDir, 'telegram-dlq.jsonl'), 'utf8');
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.chatId, entry.chatId);
    assert.equal(parsed.text, entry.text);
  });

  it('appends to existing file (second entry on second line)', async () => {
    const entry1 = makeEntry({ text: 'first', updateId: 1 });
    const entry2 = makeEntry({ text: 'second', updateId: 2 });
    await appendDlq(entry1);
    await appendDlq(entry2);
    const raw = await readFile(join(tempDir, 'telegram-dlq.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).text, 'first');
    assert.equal(JSON.parse(lines[1]).text, 'second');
  });

  it('round-trips refId field through appendDlq → loadDlq', async () => {
    const entry = makeEntry({ refId: 'c-a59a' });
    await appendDlq(entry);
    const loaded = await loadDlq();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].refId, 'c-a59a');
  });
});

// ---------------------------------------------------------------------------
// loadDlq
// ---------------------------------------------------------------------------

describe('loadDlq', () => {
  it('returns parsed entries from file', async () => {
    const entry = makeEntry({ text: 'test msg' });
    await appendDlq(entry);
    const entries = await loadDlq();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, 'test msg');
  });

  it('returns empty array for missing file', async () => {
    const entries = await loadDlq();
    assert.deepEqual(entries, []);
  });

  it('filters out entries with timestamp older than DLQ_MAX_AGE_MS', async () => {
    const oldTs = new Date(Date.now() - DLQ_MAX_AGE_MS - 1).toISOString();
    const oldEntry = makeEntry({ timestamp: oldTs, text: 'old' });
    const freshEntry = makeEntry({ text: 'fresh' });
    await appendDlq(oldEntry);
    await appendDlq(freshEntry);
    const entries = await loadDlq();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, 'fresh');
  });

  it('entry just under DLQ_MAX_AGE_MS old is NOT filtered (boundary)', async () => {
    // Use 1s inside boundary to avoid timing slippage during test execution
    const nearBoundaryTs = new Date(Date.now() - (DLQ_MAX_AGE_MS - 1000)).toISOString();
    const entry = makeEntry({ timestamp: nearBoundaryTs });
    await appendDlq(entry);
    const entries = await loadDlq();
    assert.equal(entries.length, 1);
  });

  it('skips corrupt/unparseable JSON lines without throwing', async () => {
    const { appendFile } = await import('fs/promises');
    const path = join(tempDir, 'telegram-dlq.jsonl');
    const good = makeEntry({ text: 'good' });
    await appendFile(path, 'not-valid-json\n', 'utf8');
    await appendFile(path, JSON.stringify(good) + '\n', 'utf8');
    const entries = await loadDlq();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, 'good');
  });
});

// ---------------------------------------------------------------------------
// clearDlq
// ---------------------------------------------------------------------------

describe('clearDlq', () => {
  it('removes the file', async () => {
    await appendDlq(makeEntry());
    await clearDlq();
    await assert.rejects(
      () => readFile(join(tempDir, 'telegram-dlq.jsonl'), 'utf8'),
      /ENOENT/,
    );
  });

  it('does not throw when file does not exist', async () => {
    await assert.doesNotReject(() => clearDlq());
  });
});

// ---------------------------------------------------------------------------
// writeDlq
// ---------------------------------------------------------------------------

describe('writeDlq', () => {
  it('writes entries atomically (file contains all entries after call)', async () => {
    const entries = [makeEntry({ text: 'a', updateId: 1 }), makeEntry({ text: 'b', updateId: 2 })];
    await writeDlq(entries);
    const loaded = await loadDlq();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].text, 'a');
    assert.equal(loaded[1].text, 'b');
  });

  it('replaces existing file content (not append)', async () => {
    await appendDlq(makeEntry({ text: 'old', updateId: 0 }));
    await writeDlq([makeEntry({ text: 'new', updateId: 1 })]);
    const loaded = await loadDlq();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].text, 'new');
  });

  it('writeDlq([]) produces a file that loadDlq parses as empty', async () => {
    // Safety invariant: if clearDlq() throws after a full flush, the atomically
    // written empty file must produce no entries on reload (no duplicates).
    await appendDlq(makeEntry({ text: 'existing', updateId: 1 }));
    await writeDlq([]);
    const loaded = await loadDlq();
    assert.equal(loaded.length, 0);
  });
});

// ---------------------------------------------------------------------------
// flushDlq
// ---------------------------------------------------------------------------

describe('flushDlq', () => {
  function setupFetch(ok: boolean) {
    (globalThis as Record<string, unknown>).fetch = async () => ({
      ok,
      status: ok ? 200 : 400,
      text: async () => ok ? '{}' : 'Bad Request',
      json: async () => ({ ok }),
    });
  }

  it('delivers entries via sendMessage and clears DLQ file on full success', async () => {
    setupFetch(true);
    await appendDlq(makeEntry({ text: 'msg1', updateId: 1 }));
    await appendDlq(makeEntry({ text: 'msg2', updateId: 2 }));
    const result = await flushDlq('token');
    assert.equal(result.delivered, 2);
    assert.equal(result.remaining, 0);
    // File should be gone
    await assert.rejects(
      () => readFile(join(tempDir, 'telegram-dlq.jsonl'), 'utf8'),
      /ENOENT/,
    );
  });

  it('retains entries that fail to send, calls writeDlq with remaining', async () => {
    setupFetch(false);
    await appendDlq(makeEntry({ text: 'msg1', updateId: 1 }));
    await appendDlq(makeEntry({ text: 'msg2', updateId: 2 }));
    const result = await flushDlq('token');
    assert.equal(result.delivered, 0);
    assert.equal(result.remaining, 2);
    // File should still exist with both entries
    const loaded = await loadDlq();
    assert.equal(loaded.length, 2);
  });

  it('handles empty DLQ gracefully (no fetch calls, no error)', async () => {
    let fetchCalled = false;
    (globalThis as Record<string, unknown>).fetch = async () => { fetchCalled = true; return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }; };
    const result = await flushDlq('token');
    assert.equal(result.delivered, 0);
    assert.equal(result.remaining, 0);
    assert.equal(fetchCalled, false);
  });

  it('returns correct { delivered, remaining } counts when partial success', async () => {
    let callCount = 0;
    (globalThis as Record<string, unknown>).fetch = async () => {
      callCount++;
      const ok = callCount === 1; // first succeeds, second fails
      return { ok, status: ok ? 200 : 400, text: async () => ok ? '{}' : 'Forbidden', json: async () => ({ ok }) };
    };
    await appendDlq(makeEntry({ text: 'first', updateId: 1 }));
    await appendDlq(makeEntry({ text: 'second', updateId: 2 }));
    const result = await flushDlq('token');
    assert.equal(result.delivered, 1);
    assert.equal(result.remaining, 1);
  });
});
