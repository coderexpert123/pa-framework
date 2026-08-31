import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { appendDlq, loadDlq, clearDlq, writeDlq, flushDlq, DLQ_MAX_AGE_MS, QUARANTINE_THRESHOLD, type DlqEntry } from '../dlq.js';
import { markDelivered, deliveredKey, _resetDeliveredCacheForTest } from '../delivered-store.js';

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
  _resetDeliveredCacheForTest(); // delivered-store is module-global; isolate per test
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

  it('skips an entry already marked delivered (idempotent — no duplicate send)', async () => {
    let sendCount = 0;
    (globalThis as Record<string, unknown>).fetch = async () => { sendCount++; return { ok: true, status: 200, text: async () => '{}', json: async () => ({ ok: true }) }; };
    await appendDlq(makeEntry({ text: 'already-sent', chatId: 555, threadId: 7, updateId: 42 }));
    // Simulate: this reply was confirmed delivered in a prior run.
    await markDelivered(deliveredKey(555, 7, 42));
    const result = await flushDlq('token');
    assert.equal(sendCount, 0, 'must not re-send an already-delivered entry');
    assert.equal(result.deduped, 1);
    assert.equal(result.delivered, 0);
    assert.equal(result.remaining, 0);
  });

  it('marks delivered on success so a re-flush (post-crash) does not resend', async () => {
    let sendCount = 0;
    (globalThis as Record<string, unknown>).fetch = async () => { sendCount++; return { ok: true, status: 200, text: async () => '{}', json: async () => ({ ok: true }) }; };
    const entry = makeEntry({ text: 'deliver-once', chatId: 1, threadId: 0, updateId: 99 });
    await appendDlq(entry);
    await flushDlq('token'); // delivers + marks delivered
    assert.equal(sendCount, 1);
    // Simulate the entry lingering (crash before queue trim) and re-flushing.
    await appendDlq(entry);
    const result = await flushDlq('token');
    assert.equal(sendCount, 1, 're-flush must not resend an already-delivered entry');
    assert.equal(result.deduped, 1);
  });
});

// ---------------------------------------------------------------------------
// Quarantine behavior
// ---------------------------------------------------------------------------

describe('quarantine', () => {
  it('increments attempts on each failed flush', async () => {
    (globalThis as Record<string, unknown>).fetch = async () => ({ ok: false, status: 400, text: async () => 'Bad Request', json: async () => ({ ok: false }) });
    const entry = makeEntry({ text: 'failing message', updateId: 1 });
    await appendDlq(entry);

    await flushDlq('token'); // attempts becomes 1
    let loaded = await loadDlq();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].attempts, 1);

    await flushDlq('token'); // attempts becomes 2
    loaded = await loadDlq();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].attempts, 2);
  });

  it('quarantines entry after QUARANTINE_THRESHOLD failed attempts', async () => {
    (globalThis as Record<string, unknown>).fetch = async () => ({ ok: false, status: 400, text: async () => 'Bad Request', json: async () => ({ ok: false }) });
    const entry = makeEntry({ text: 'chronically failing', updateId: 2, refId: 's-abc123' });
    await appendDlq(entry);

    // Fail QUARANTINE_THRESHOLD times
    for (let i = 0; i < QUARANTINE_THRESHOLD; i++) {
      await flushDlq('token');
    }

    const loaded = await loadDlq();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].quarantined, true);
    assert.equal(loaded[0].attempts, QUARANTINE_THRESHOLD);
  });

  it('stops retrying quarantined entries', async () => {
    let sendCount = 0;
    (globalThis as Record<string, unknown>).fetch = async () => { sendCount++; return { ok: false, status: 400, text: async () => 'Bad Request', json: async () => ({ ok: false }) }; };
    const entry = makeEntry({ text: 'quarantined entry', updateId: 3 });
    await appendDlq(entry);

    // Quarantine the entry
    for (let i = 0; i < QUARANTINE_THRESHOLD; i++) {
      await flushDlq('token');
    }
    const sendCountAtQuarantine = sendCount;

    // Try flushing again - should NOT attempt send
    await flushDlq('token');
    assert.equal(sendCount, sendCountAtQuarantine, 'quarantined entry must not be retried');
  });

  it('sends quarantine alert once when entry is quarantined', async () => {
    // Routing mock: DELIVERY sends keep failing (drives attempts up to the
    // quarantine threshold) but the ALERT send to the pa-alerts chat succeeds —
    // the dedup file is only written after a SUCCESSFUL alert, by design.
    (globalThis as Record<string, unknown>).fetch = async (_url: unknown, init: { body?: string } | undefined) => {
      const body = init?.body ?? '';
      const isAlert = typeof body === 'string' && (body.includes('"chat_id":123') || body.includes('"chat_id":"123"'));
      return isAlert
        ? { ok: true, status: 200, text: async () => '{"ok":true}', json: async () => ({ ok: true }) }
        : { ok: false, status: 400, text: async () => 'Bad Request', json: async () => ({ ok: false }) };
    };
    const entry = makeEntry({ chatId: -100999, text: 'alert test message', updateId: 4, refId: 's-alert123' });
    await appendDlq(entry);

    // Set required env vars for alert to run
    process.env.PA_ALERTS_CHAT_ID = '123';
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    // Create quarantine-alerts directory
    const alertDir = join(tempDir, 'quarantine-alerts');
    await mkdir(alertDir, { recursive: true });

    // Quarantine the entry (will attempt to send alert)
    for (let i = 0; i < QUARANTINE_THRESHOLD; i++) {
      await flushDlq('token');
    }

    // Verify the alert dedup file was created (prevents duplicate alerts)
    const alertFiles = await readFile(join(alertDir, 's-alert123.json'), 'utf8').catch(() => null);
    assert.ok(alertFiles, 'quarantine alert dedup file should be created');
  });

  it('quarantine alert carries a dq:replay keyboard and the DLQ index in its body (WP-B3)', async () => {
    let alertBody: string | undefined;
    (globalThis as Record<string, unknown>).fetch = async (_url: unknown, init: { body?: string } | undefined) => {
      const body = init?.body ?? '';
      const isAlert = typeof body === 'string' && (body.includes('"chat_id":123') || body.includes('"chat_id":"123"'));
      if (isAlert) alertBody = body;
      return isAlert
        ? { ok: true, status: 200, text: async () => '{"ok":true}', json: async () => ({ ok: true }) }
        : { ok: false, status: 400, text: async () => 'Bad Request', json: async () => ({ ok: false }) };
    };
    const entry = makeEntry({ chatId: -100888, text: 'alert index test', updateId: 9, refId: 's-idxtest' });
    await appendDlq(entry);

    process.env.PA_ALERTS_CHAT_ID = '123';
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const alertDir = join(tempDir, 'quarantine-alerts');
    await mkdir(alertDir, { recursive: true });

    // This is the only entry in the DLQ, so it quarantines at index 0.
    for (let i = 0; i < QUARANTINE_THRESHOLD; i++) {
      await flushDlq('token');
    }

    assert.ok(alertBody, 'quarantine alert should have been sent');
    const parsed = JSON.parse(alertBody!);
    assert.ok(String(parsed.text).includes('DLQ index: 0'), 'alert body should name the DLQ index');
    assert.ok(parsed.reply_markup, 'alert should carry a reply_markup');
    assert.ok(JSON.stringify(parsed.reply_markup).includes('dq:replay:0'), 'keyboard should carry dq:replay:<index>');
  });

  it('quarantined entries persist beyond TTL for operator action', async () => {
    const veryOldTimestamp = new Date(Date.now() - DLQ_MAX_AGE_MS - 100000).toISOString();
    const oldQuarantinedEntry = makeEntry({ text: 'old quarantined', timestamp: veryOldTimestamp, updateId: 5, attempts: 5, quarantined: true });
    const oldNormalEntry = makeEntry({ text: 'old normal', timestamp: veryOldTimestamp, updateId: 6 });

    await appendDlq(oldQuarantinedEntry);
    await appendDlq(oldNormalEntry);

    const loaded = await loadDlq();
    assert.equal(loaded.length, 1, 'only quarantined entry should remain (normal entry expired)');
    assert.equal(loaded[0].text, 'old quarantined');
    assert.equal(loaded[0].quarantined, true);
  });

  it('non-quarantined entries are still filtered by TTL', async () => {
    const veryOldTimestamp = new Date(Date.now() - DLQ_MAX_AGE_MS - 100000).toISOString();
    const oldEntry = makeEntry({ text: 'old entry', timestamp: veryOldTimestamp, updateId: 7 });
    const freshEntry = makeEntry({ text: 'fresh entry', updateId: 8 });

    await appendDlq(oldEntry);
    await appendDlq(freshEntry);

    const loaded = await loadDlq();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].text, 'fresh entry');
  });
});
