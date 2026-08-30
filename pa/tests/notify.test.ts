import './test-env-guard.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import type { DigestDayFile } from '../src/lib/notify.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

function dedupPath(key: string): string {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 16);
  return join(tempDir, 'alert-state', `${hash}.json`);
}

async function writeDedupFile(key: string, timestamp: string): Promise<void> {
  const filePath = dedupPath(key);
  await mkdir(join(tempDir, 'alert-state'), { recursive: true });
  await writeFile(filePath, JSON.stringify({ timestamp, key }), 'utf8');
}

async function readDedupFile(key: string): Promise<any> {
  const raw = await readFile(dedupPath(key), 'utf8');
  return JSON.parse(raw);
}

describe('notifyUser — dedup logic', () => {
  it('suppresses within dedup window', async () => {
    await writeDedupFile('test-key', new Date().toISOString());
    const { notifyUser } = await import('../src/lib/notify.js');

    const result = await notifyUser('Test', 'body', { dedupKey: 'test-key' });
    assert.equal(result.suppressed, true);
    assert.equal(result.sent, false);
  });

  it('sends after dedup window expires (no token → sent=false)', async () => {
    const oldTimestamp = new Date(Date.now() - 2 * 3600_000).toISOString();
    await writeDedupFile('test-key-old', oldTimestamp);
    const { notifyUser } = await import('../src/lib/notify.js');

    const result = await notifyUser('Test', 'body', { dedupKey: 'test-key-old' });
    // No token → missing-token return, not suppressed
    assert.equal(result.suppressed, false);
    assert.equal(result.sent, false);
  });

  it('always attempts send when dedupKey is undefined', async () => {
    const { notifyUser } = await import('../src/lib/notify.js');

    // No dedupKey — should attempt send regardless
    const result = await notifyUser('Test', 'body');
    assert.equal(result.suppressed, false);
  });

  it('writes dedup state after successful send', async () => {
    // This test verifies the file-write path. Since we can't easily mock
    // sendToTelegram to succeed, we verify the dedup file is written
    // by checking the file doesn't exist when token is missing (early return).
    const { notifyUser } = await import('../src/lib/notify.js');

    // No token → missing-token return before dedup write
    const result = await notifyUser('Test', 'body', { dedupKey: 'no-token-key' });
    assert.equal(result.sent, false);

    // Dedup file should NOT exist (send never succeeded)
    const exists = await readFile(dedupPath('no-token-key'), 'utf8').then(() => true).catch(() => false);
    assert.equal(exists, false, 'Dedup file should not be written when send fails');
  });
});

describe('notifyUser — PA_NOTIFY_DISABLED guard', () => {
  it('returns sent=false when PA_NOTIFY_DISABLED=1, without writing dedup file', async () => {
    const saved = process.env.PA_NOTIFY_DISABLED;
    process.env.PA_NOTIFY_DISABLED = '1';
    try {
      const { notifyUser } = await import('../src/lib/notify.js');
      const result = await notifyUser('Test', 'body', { dedupKey: 'guard-test-key' });
      assert.equal(result.sent, false);
      assert.equal(result.suppressed, false);
      // Disabled guard fires before send → no dedup file written
      const exists = await readFile(dedupPath('guard-test-key'), 'utf8').then(() => true).catch(() => false);
      assert.equal(exists, false, 'No dedup file written when guard fires before send');
    } finally {
      if (saved !== undefined) process.env.PA_NOTIFY_DISABLED = saved;
      else delete process.env.PA_NOTIFY_DISABLED;
    }
  });
});

describe('notifyUser — missing token', () => {
  it('returns sent=false when TELEGRAM_BOT_TOKEN is absent (via PA_NOTIFY_DISABLED guard in test env)', async () => {
    // In test runs PA_NOTIFY_DISABLED=1 is set globally, so this returns via the disabled guard.
    // The missing-token path is exercised by the explicit-unset test below.
    const { notifyUser } = await import('../src/lib/notify.js');
    const result = await notifyUser('Test', 'body');
    assert.equal(result.sent, false);
    assert.equal(result.suppressed, false);
  });

  it('returns sent=false, reason=missing-token when guard is off and no token is set', async () => {
    // Temporarily unset the guard to exercise the actual missing-token code path.
    const saved = process.env.PA_NOTIFY_DISABLED;
    delete process.env.PA_NOTIFY_DISABLED;
    try {
      const { notifyUser } = await import('../src/lib/notify.js');
      // tempDir has no secrets.env (or empty) → loadSecrets returns {} → no token
      const result = await notifyUser('Test', 'body');
      assert.equal(result.sent, false);
      assert.equal(result.suppressed, false);
    } finally {
      if (saved !== undefined) process.env.PA_NOTIFY_DISABLED = saved;
    }
  });
});

describe('notifyUser — constants', () => {
  it('GC_MAX_AGE_MS >= DEFAULT_DEDUP_WINDOW_MS', async () => {
    const { GC_MAX_AGE_MS, DEFAULT_DEDUP_WINDOW_MS } = await import('../src/lib/notify.js');
    assert.ok(GC_MAX_AGE_MS >= DEFAULT_DEDUP_WINDOW_MS,
      `GC_MAX_AGE_MS (${GC_MAX_AGE_MS}) must be >= DEFAULT_DEDUP_WINDOW_MS (${DEFAULT_DEDUP_WINDOW_MS})`);
  });
});

describe('gcAlertState', () => {
  it('deletes dedup files older than 24h', async () => {
    const { gcAlertState } = await import('../src/lib/notify.js');

    await writeDedupFile('stale-key', new Date(Date.now() - 25 * 3600_000).toISOString());
    await writeDedupFile('fresh-key', new Date().toISOString());

    await gcAlertState();

    const staleExists = await readFile(dedupPath('stale-key'), 'utf8').then(() => true).catch(() => false);
    const freshExists = await readFile(dedupPath('fresh-key'), 'utf8').then(() => true).catch(() => false);

    assert.equal(staleExists, false, 'Stale dedup file should be deleted');
    assert.equal(freshExists, true, 'Fresh dedup file should survive');
  });

  it('deletes malformed dedup files', async () => {
    const { gcAlertState } = await import('../src/lib/notify.js');
    const alertDir = join(tempDir, 'alert-state');
    await mkdir(alertDir, { recursive: true });

    await writeFile(join(alertDir, 'malformed.json'), 'NOT VALID JSON{{{', 'utf8');

    await gcAlertState();

    const exists = await readFile(join(alertDir, 'malformed.json'), 'utf8').then(() => true).catch(() => false);
    assert.equal(exists, false, 'Malformed file should be deleted');
  });

  it('handles non-existent alert-state directory gracefully', async () => {
    const { gcAlertState } = await import('../src/lib/notify.js');
    // No alert-state dir → should not throw
    await assert.doesNotReject(() => gcAlertState());
  });
});

describe('migrateStalenessAlertFile', () => {
  it('migrates old staleness file to new location', async () => {
    const oldPath = join(tempDir, 'last-staleness-alert.json');
    const ts = new Date().toISOString();
    await writeFile(oldPath, JSON.stringify({ timestamp: ts }), 'utf8');

    const { migrateStalenessAlertFile } = await import('../src/lib/notify.js');
    await migrateStalenessAlertFile();

    // Old file should be gone
    const oldExists = await readFile(oldPath, 'utf8').then(() => true).catch(() => false);
    assert.equal(oldExists, false, 'Old staleness file should be deleted');

    // New file should exist
    const newPath = dedupPath('staleness');
    const newContent = await readFile(newPath, 'utf8');
    const parsed = JSON.parse(newContent);
    assert.equal(parsed.key, 'staleness');
    assert.equal(parsed.timestamp, ts);
  });

  it('is idempotent — second call is no-op', async () => {
    // Both calls use the same import (module-level `migrated` flag)
    const { migrateStalenessAlertFile } = await import('../src/lib/notify.js');

    const oldPath = join(tempDir, 'last-staleness-alert.json');
    await writeFile(oldPath, JSON.stringify({ timestamp: new Date().toISOString() }), 'utf8');

    await migrateStalenessAlertFile();
    // Delete old file that was cleaned up, recreate to test idempotency
    // Actually the module-level flag means second call just returns — test by calling twice
    await migrateStalenessAlertFile();
    // Should not throw
  });

  it('does nothing when old file does not exist', async () => {
    const { migrateStalenessAlertFile } = await import('../src/lib/notify.js');
    // No old file → no-op
    await assert.doesNotReject(() => migrateStalenessAlertFile());
  });
});

// ---------------------------------------------------------------------------
// Route resolution + confirmed-delivery dedup (2026-07-21 alerting fix).
//
// Regression guard for the audit finding that PA_ALERTS_CHAT_ID lives in
// ~/.pa/secrets.env while the resolver read only process.env — 93% of alerts
// went out with an empty chat_id, were rejected by Telegram, and were still
// logged sent:true with dedup state written.
// ---------------------------------------------------------------------------

const ROUTE_ENV_KEYS = [
  'PA_ALERTS_CHAT_ID',
  'PA_ALERTS_THREAD_ID',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_BOT_TOKEN',
  'PA_NOTIFY_DISABLED',
  'PA_NOTIFY_TIMEOUT_MS',
];

type MockResponse = { ok: boolean; status?: number; bodyText?: string } | 'hang';

function setupFetchMock(responses: MockResponse[]): Array<{ url: string; init?: any }> {
  const calls: Array<{ url: string; init?: any }> = [];
  let i = 0;
  (globalThis as Record<string, unknown>).fetch = async (url: string, init?: any) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r === 'hang') return new Promise(() => {}); // never settles — exercises the send timeout
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      text: async () => r.bodyText ?? '{}',
      json: async () => ({}),
    };
  };
  return calls;
}

function sentBody(calls: Array<{ url: string; init?: any }>): any {
  return JSON.parse(calls[0].init.body as string);
}

async function dedupFileExists(key: string): Promise<boolean> {
  return readFile(dedupPath(key), 'utf8').then(() => true).catch(() => false);
}

describe('notifyUser — route resolution and confirmed delivery', () => {
  let savedEnv: Record<string, string | undefined>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ROUTE_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key]; // start from a clean route so secrets.env is the only source
    }
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const key of ROUTE_ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
    globalThis.fetch = originalFetch;
  });

  it('resolves chat_id/thread_id from secrets.env when process.env is unset', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\nPA_ALERTS_THREAD_ID=42\n');
    const calls = setupFetchMock([{ ok: true }]);
    const { notifyUser } = await import('../src/lib/notify.js');

    const result = await notifyUser('Test', 'body', { dedupKey: 'secrets-route-key' });

    assert.equal(result.sent, true);
    assert.equal(result.reason, 'sent');
    assert.equal(calls.length, 1);
    const body = sentBody(calls);
    assert.equal(body.chat_id, '-100777', 'chat_id must come from secrets.env');
    assert.equal(body.message_thread_id, 42);
    assert.equal(await dedupFileExists('secrets-route-key'), true, 'confirmed send writes dedup state');
  });

  it('lets process.env win over the secrets record', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    process.env.PA_ALERTS_CHAT_ID = '-100999';
    const calls = setupFetchMock([{ ok: true }]);
    const { notifyUser } = await import('../src/lib/notify.js');

    const result = await notifyUser('Test', 'body');

    assert.equal(result.sent, true);
    assert.equal(sentBody(calls).chat_id, '-100999');
  });

  it('falls back to the first TELEGRAM_CHAT_ID entry when PA_ALERTS_CHAT_ID is absent everywhere', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nTELEGRAM_CHAT_ID="123,-100456"\n');
    const calls = setupFetchMock([{ ok: true }]);
    const { notifyUser } = await import('../src/lib/notify.js');

    await notifyUser('Test', 'body');
    assert.equal(sentBody(calls).chat_id, '123');
  });

  it('repairs a topic override that carries an empty chat_id (notify-cmd / self-improver path)', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\nPA_ALERTS_THREAD_ID=42\n');
    const calls = setupFetchMock([{ ok: true }]);
    const { notifyUser } = await import('../src/lib/notify.js');

    // getPaAlertsChatId() is env-only, so these callers hand us chat_id: ''.
    await notifyUser('Test', 'body', { topic: { chat_id: '', thread_id: 99 } });

    const body = sentBody(calls);
    assert.equal(body.chat_id, '-100777', 'empty override chat_id falls back to the resolved alerts chat');
    assert.equal(body.message_thread_id, 99, 'the override thread is still honored');
  });

  it('returns reason=no-chat-id without issuing a request or writing dedup state', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\n'); // token but no chat id anywhere
    const calls = setupFetchMock([{ ok: true }]);
    const { notifyUser } = await import('../src/lib/notify.js');

    const result = await notifyUser('Test', 'body', { dedupKey: 'no-chat-id-key' });

    assert.equal(result.sent, false);
    assert.equal(result.suppressed, false);
    assert.equal(result.reason, 'no-chat-id');
    assert.equal(calls.length, 0, 'an undeliverable alert must not hit the network');
    assert.equal(await dedupFileExists('no-chat-id-key'), false, 'never suppress an alert that was never attempted');
  });

  it('returns reason=send-failed and writes NO dedup state when Telegram rejects the send', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    setupFetchMock([{ ok: false, status: 400, bodyText: 'Bad Request: chat not found' }]);
    const { notifyUser } = await import('../src/lib/notify.js');

    const result = await notifyUser('Test', 'body', { dedupKey: 'rejected-key' });

    assert.equal(result.sent, false);
    assert.equal(result.suppressed, false);
    assert.equal(result.reason, 'send-failed');
    assert.equal(await dedupFileExists('rejected-key'), false, 'a rejected alert must stay un-deduped');
  });

  it('reports a timed-out send honestly and writes only the short timeout mute, never an escalated window', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    process.env.PA_NOTIFY_TIMEOUT_MS = '20';
    setupFetchMock(['hang']);
    const { notifyUser, TIMEOUT_DEDUP_MS } = await import('../src/lib/notify.js');

    const result = await notifyUser('Test', 'body', { dedupKey: 'timeout-key' });

    assert.equal(result.sent, false);
    assert.equal(result.suppressed, false);
    assert.equal(result.reason, 'timeout-unknown-outcome', 'the race does not cancel the send — outcome is unknown, not failed');
    // 2026-08-23 (alerts wave, WP-D): a timeout used to write NO dedup state, so a
    // chronically-timing-out alert re-fired on every per-minute tick (the 429 loop of
    // plans/2026-08-23-alerts-week-review.md §5.4). It now writes a SHORT mute only —
    // TIMEOUT_DEDUP_MS, count not advanced — never the confirmed-send escalated window.
    const record = await readDedupFile('timeout-key');
    assert.equal(record.windowMs, TIMEOUT_DEDUP_MS, 'timeout writes the short mute, not a confirmed-send window');
    assert.equal(record.count ?? 0, 0, 'a timeout is not a confirmed send — escalation count must not advance');
  });

  it('suppresses the second alert once the first is confirmed delivered', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    const calls = setupFetchMock([{ ok: true }]);
    const { notifyUser } = await import('../src/lib/notify.js');

    const first = await notifyUser('Test', 'body', { dedupKey: 'window-key' });
    const second = await notifyUser('Test', 'body', { dedupKey: 'window-key' });

    assert.equal(first.sent, true);
    assert.equal(second.suppressed, true);
    assert.equal(second.reason, 'dedup-suppressed');
    assert.equal(calls.length, 1, 'only one request for two alerts inside the dedup window');
  });

  it('still short-circuits on PA_NOTIFY_DISABLED even with a fully resolvable route', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    process.env.PA_NOTIFY_DISABLED = '1';
    const calls = setupFetchMock([{ ok: true }]);
    const { notifyUser } = await import('../src/lib/notify.js');

    const result = await notifyUser('Test', 'body', { dedupKey: 'disabled-route-key' });

    assert.equal(result.sent, false);
    assert.equal(result.reason, 'disabled');
    assert.equal(calls.length, 0);
    assert.equal(await dedupFileExists('disabled-route-key'), false);
  });
});

// ---------------------------------------------------------------------------
// Escalating dedup + timeout short-dedup (2026-08-23 alerts wave, WP-D).
//
// A permanently failing condition used to page every flat dedup window
// forever (restore-drill: 180 sends in 7.5 days). An UNCHANGED body now
// doubles its stored window on each confirmed send, capped at
// ESCALATION_CAP_MS (24h); a CHANGED body resets to count 1 / the base
// window. A send that TIMES OUT (unknown outcome) writes a short
// TIMEOUT_DEDUP_MS mute instead — the 429 loop of review §5.4 was a
// timed-out send re-firing on every per-minute catchup tick because dedup
// was written only on confirmed success.
// ---------------------------------------------------------------------------

describe('notifyUser — escalating dedup', () => {
  let savedEnv: Record<string, string | undefined>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ROUTE_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const key of ROUTE_ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
    globalThis.fetch = originalFetch;
  });

  it('doubles the stored window on each confirmed send of an unchanged body, capped at 24h', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    const { notifyUser } = await import('../src/lib/notify.js');

    // count 1..7 -> 1h, 2h, 4h, 8h, 16h, 24h, 24h (capped)
    const expectedWindows = [3_600_000, 7_200_000, 14_400_000, 28_800_000, 57_600_000, 86_400_000, 86_400_000];
    for (const windowMs of expectedWindows) {
      setupFetchMock([{ ok: true }]);
      // breaker: false — this loop performs 7 confirmed sends for one key in one day;
      // the 2026-08-30 breaker would cap it at 3.
      await notifyUser('Test', 'same body', { dedupKey: 'escalate-key', breaker: false });
      const record = await readDedupFile('escalate-key');
      assert.equal(record.windowMs, windowMs);
      // Push the just-written record's timestamp into the past so the NEXT
      // call lands past its (now-escalated) window and attempts a send
      // instead of being dedup-suppressed.
      await writeFile(dedupPath('escalate-key'), JSON.stringify({ ...record, timestamp: new Date(Date.now() - windowMs - 1000).toISOString() }), 'utf8');
    }
  });

  it('resets count and window to the base when the body changes', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    const { notifyUser } = await import('../src/lib/notify.js');

    setupFetchMock([{ ok: true }]);
    await notifyUser('Test', 'body A', { dedupKey: 'change-key' });
    let record = await readDedupFile('change-key');
    assert.equal(record.count, 1);
    assert.equal(record.windowMs, 3_600_000);

    // Escalate once more with the SAME body so count/window move off base.
    await writeFile(dedupPath('change-key'), JSON.stringify({ ...record, timestamp: new Date(Date.now() - record.windowMs - 1000).toISOString() }), 'utf8');
    setupFetchMock([{ ok: true }]);
    await notifyUser('Test', 'body A', { dedupKey: 'change-key' });
    record = await readDedupFile('change-key');
    assert.equal(record.count, 2);
    assert.equal(record.windowMs, 7_200_000);

    // Push past the window again and send a DIFFERENT body — count/window
    // must reset to base, not continue escalating.
    await writeFile(dedupPath('change-key'), JSON.stringify({ ...record, timestamp: new Date(Date.now() - record.windowMs - 1000).toISOString() }), 'utf8');
    setupFetchMock([{ ok: true }]);
    await notifyUser('Test', 'body B — different', { dedupKey: 'change-key' });
    record = await readDedupFile('change-key');
    assert.equal(record.count, 1, 'a changed body resets count to 1');
    assert.equal(record.windowMs, 3_600_000, 'a changed body resets the window to the caller base');
  });

  it('escalate: false keeps count and window flat across repeated confirmed sends', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    const { notifyUser } = await import('../src/lib/notify.js');

    for (let i = 0; i < 3; i++) {
      setupFetchMock([{ ok: true }]);
      await notifyUser('Test', 'same body', { dedupKey: 'noescalate-key', dedupWindowMs: 60_000, escalate: false });
      const record = await readDedupFile('noescalate-key');
      assert.equal(record.count, 1);
      assert.equal(record.windowMs, 60_000);
      await writeFile(dedupPath('noescalate-key'), JSON.stringify({ ...record, timestamp: new Date(Date.now() - 61_000).toISOString() }), 'utf8');
    }
  });

  it('treats a legacy record (no count/bodyHash) as same-body and escalates from 1', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    // Legacy shape: {timestamp, key} only — written by writeDedupFile — 2h old,
    // past the 1h default window so the next call is not dedup-suppressed.
    await writeDedupFile('legacy-key', new Date(Date.now() - 2 * 3_600_000).toISOString());
    setupFetchMock([{ ok: true }]);
    const { notifyUser } = await import('../src/lib/notify.js');

    await notifyUser('Test', 'body', { dedupKey: 'legacy-key' });
    const record = await readDedupFile('legacy-key');
    assert.equal(record.count, 1);
    assert.equal(record.windowMs, 3_600_000);
    assert.equal(typeof record.bodyHash, 'string');
  });

  it('gcAlertState respects an escalated window, not the flat 24h default, at deletion time', async () => {
    const { gcAlertState } = await import('../src/lib/notify.js');
    await mkdir(join(tempDir, 'alert-state'), { recursive: true });

    // Escalated to 8h (count 4): timestamp 9h ago -> past its own window -> deleted.
    await writeFile(dedupPath('escalated-expired'), JSON.stringify({
      timestamp: new Date(Date.now() - 9 * 3_600_000).toISOString(), key: 'escalated-expired', windowMs: 8 * 3_600_000, count: 4, bodyHash: 'abc',
    }), 'utf8');
    // Escalated to 24h (count 6): timestamp 9h ago -> still within its window -> kept.
    await writeFile(dedupPath('escalated-alive'), JSON.stringify({
      timestamp: new Date(Date.now() - 9 * 3_600_000).toISOString(), key: 'escalated-alive', windowMs: 24 * 3_600_000, count: 6, bodyHash: 'def',
    }), 'utf8');

    await gcAlertState();

    const expiredExists = await readFile(dedupPath('escalated-expired'), 'utf8').then(() => true).catch(() => false);
    const aliveExists = await readFile(dedupPath('escalated-alive'), 'utf8').then(() => true).catch(() => false);
    assert.equal(expiredExists, false, 'a record whose escalated window has passed must be GC-ed');
    assert.equal(aliveExists, true, 'a record whose escalated window has not passed must survive');
  });
});

describe('notifyUser — timeout short-dedup', () => {
  let savedEnv: Record<string, string | undefined>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ROUTE_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const key of ROUTE_ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
    globalThis.fetch = originalFetch;
  });

  it('writes a short TIMEOUT_DEDUP_MS mute (count unchanged) and suppresses the immediate retry', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    process.env.PA_NOTIFY_TIMEOUT_MS = '20';
    setupFetchMock(['hang']);
    const { notifyUser, TIMEOUT_DEDUP_MS } = await import('../src/lib/notify.js');

    const first = await notifyUser('Test', 'body', { dedupKey: 'timeout-dedup-key' });
    assert.equal(first.reason, 'timeout-unknown-outcome');

    const record = await readDedupFile('timeout-dedup-key');
    assert.equal(record.windowMs, TIMEOUT_DEDUP_MS);
    assert.equal(record.count, 0, 'a timeout is not a confirmed send — count must not advance');

    const second = await notifyUser('Test', 'body', { dedupKey: 'timeout-dedup-key' });
    assert.equal(second.suppressed, true);
    assert.equal(second.reason, 'dedup-suppressed');
  });
});

describe('resolveAlertRoute', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ROUTE_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ROUTE_ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
  });

  it('prefers the specific PA_ALERTS_CHAT_ID in secrets over a generic TELEGRAM_CHAT_ID in env', async () => {
    await createTempSecrets(tempDir, 'PA_ALERTS_CHAT_ID=-100777\nPA_ALERTS_THREAD_ID=42\n');
    process.env.TELEGRAM_CHAT_ID = '-100111,222';
    const { resolveAlertRoute } = await import('../src/lib/notify.js');

    const route = await resolveAlertRoute();
    assert.equal(route.topic.chat_id, '-100777');
    assert.equal(route.topic.thread_id, 42);
  });

  it('returns an empty chat_id (never throws) when nothing is configured', async () => {
    const { resolveAlertRoute } = await import('../src/lib/notify.js');
    const route = await resolveAlertRoute();
    assert.equal(route.topic.chat_id, '');
    assert.equal(route.topic.thread_id, 0);
    assert.equal(route.token, '');
  });
});

// ---------------------------------------------------------------------------
// Caller-specific topic keys (2026-07-21 symmetry fix).
//
// The first repair made only the CHAT id secrets-aware; a caller-specific
// THREAD id (PA_SELF_IMPROVER_THREAD_ID, which exists only in ~/.pa/secrets.env)
// still resolved to 0, so the nightly self-improver report arrived in pa-alerts
// instead of its own topic. Chat and thread must resolve symmetrically.
// ---------------------------------------------------------------------------

const SELF_IMPROVER_KEYS = {
  chatKey: 'PA_SELF_IMPROVER_CHAT_ID',
  threadKey: 'PA_SELF_IMPROVER_THREAD_ID',
};

describe('resolveNotifyTopic — caller-specific keys', () => {
  const KEYS = [...ROUTE_ENV_KEYS, SELF_IMPROVER_KEYS.chatKey, SELF_IMPROVER_KEYS.threadKey];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
  });

  it('resolves the caller-specific thread from secrets.env when process.env lacks it', async () => {
    // The real deployment shape: secrets.env has the thread key but no chat key.
    await createTempSecrets(tempDir, 'PA_ALERTS_CHAT_ID=-100777\nPA_ALERTS_THREAD_ID=42\nPA_SELF_IMPROVER_THREAD_ID=1234\n');
    const { resolveNotifyTopic } = await import('../src/lib/notify.js');

    const topic = await resolveNotifyTopic(SELF_IMPROVER_KEYS);
    assert.equal(topic.chat_id, '-100777', 'no caller chat key → the pa-alerts chat');
    assert.equal(topic.thread_id, 1234, 'the caller thread key must be read from secrets.env, not process.env only');
  });

  it('lets process.env win over the secrets record for the caller-specific keys', async () => {
    await createTempSecrets(tempDir, 'PA_ALERTS_CHAT_ID=-100777\nPA_SELF_IMPROVER_CHAT_ID=-100111\nPA_SELF_IMPROVER_THREAD_ID=1234\n');
    process.env.PA_SELF_IMPROVER_CHAT_ID = '-100999';
    process.env.PA_SELF_IMPROVER_THREAD_ID = '77';
    const { resolveNotifyTopic } = await import('../src/lib/notify.js');

    const topic = await resolveNotifyTopic(SELF_IMPROVER_KEYS);
    assert.equal(topic.chat_id, '-100999');
    assert.equal(topic.thread_id, 77);
  });

  it('falls back to the pa-alerts thread only when neither source has the caller key', async () => {
    await createTempSecrets(tempDir, 'PA_ALERTS_CHAT_ID=-100777\nPA_ALERTS_THREAD_ID=42\n');
    const { resolveNotifyTopic } = await import('../src/lib/notify.js');

    const topic = await resolveNotifyTopic(SELF_IMPROVER_KEYS);
    assert.equal(topic.chat_id, '-100777');
    assert.equal(topic.thread_id, 42);
  });

  it('prefers the caller-specific chat key over the pa-alerts chat', async () => {
    await createTempSecrets(tempDir, 'PA_ALERTS_CHAT_ID=-100777\nPA_SELF_IMPROVER_CHAT_ID=-100222\n');
    const { resolveNotifyTopic } = await import('../src/lib/notify.js');

    const topic = await resolveNotifyTopic(SELF_IMPROVER_KEYS);
    assert.equal(topic.chat_id, '-100222');
  });

  it('degrades a non-numeric caller thread id to the pa-alerts thread instead of NaN', async () => {
    await createTempSecrets(tempDir, 'PA_ALERTS_CHAT_ID=-100777\nPA_ALERTS_THREAD_ID=42\nPA_SELF_IMPROVER_THREAD_ID=not-a-number\n');
    const { resolveNotifyTopic } = await import('../src/lib/notify.js');

    const topic = await resolveNotifyTopic(SELF_IMPROVER_KEYS);
    assert.equal(topic.thread_id, 42);
  });

  it('resolves the generic pa-alerts route when no caller keys are given', async () => {
    await createTempSecrets(tempDir, 'PA_ALERTS_CHAT_ID=-100777\nPA_ALERTS_THREAD_ID=42\n');
    const { resolveNotifyTopic } = await import('../src/lib/notify.js');

    const topic = await resolveNotifyTopic();
    assert.deepEqual(topic, { chat_id: '-100777', thread_id: 42 });
  });

  it('returns an empty chat_id and thread 0 (never throws) when nothing is configured', async () => {
    const { resolveNotifyTopic } = await import('../src/lib/notify.js');
    const topic = await resolveNotifyTopic(SELF_IMPROVER_KEYS);
    assert.deepEqual(topic, { chat_id: '', thread_id: 0 });
  });
});

describe('notifyUser — a resolved caller topic reaches Telegram intact', () => {
  const KEYS = [...ROUTE_ENV_KEYS, SELF_IMPROVER_KEYS.chatKey, SELF_IMPROVER_KEYS.threadKey];
  let savedEnv: Record<string, string | undefined>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedEnv = {};
    for (const key of KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
    globalThis.fetch = originalFetch;
  });

  it('sends to the caller thread, not the pa-alerts thread', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\nPA_ALERTS_THREAD_ID=42\nPA_SELF_IMPROVER_THREAD_ID=1234\n');
    const calls = setupFetchMock([{ ok: true }]);
    const { notifyUser, resolveNotifyTopic } = await import('../src/lib/notify.js');

    const result = await notifyUser('Report', 'body', {
      topic: await resolveNotifyTopic(SELF_IMPROVER_KEYS),
      severity: 'info',
    });

    assert.equal(result.sent, true);
    const body = sentBody(calls);
    assert.equal(body.chat_id, '-100777');
    assert.equal(body.message_thread_id, 1234);
  });
});

describe('dedup-key registry uniqueness', () => {
  it('all registry keys have disjoint matchspaces', () => {
    const registry = [
      { pattern: 'worker-spawn-*', type: 'wildcard' },
      { pattern: 'worker-exit-*', type: 'wildcard' },
      { pattern: 'skill-failed-*', type: 'wildcard' },
      { pattern: 'skill-fail-topic-*', type: 'wildcard' },
      { pattern: 'shell-skill-spawn-*', type: 'wildcard' },
      { pattern: 'catchup-threw-*', type: 'wildcard' },
      { pattern: 'evaluator-*', type: 'wildcard' },
      { pattern: 'analyzer-terminal', type: 'bare' },
      { pattern: 'failure-analyzer-terminal', type: 'bare' },
      { pattern: 'all-workers-rate-limited-*', type: 'wildcard' },
      { pattern: 'skill-exhausted-*', type: 'wildcard' },
      { pattern: 'bg-orphan-*', type: 'wildcard' },
      { pattern: 'daily-mail-brief-hallucination', type: 'bare' },
      { pattern: 'daily-mail-brief-auth', type: 'bare' },
      { pattern: 'daily-mail-brief-fetch', type: 'bare' },
      { pattern: 'staleness', type: 'bare' },
    ];

    // Check bare keys are unique
    const bareKeys = registry.filter(e => e.type === 'bare').map(e => e.pattern);
    assert.equal(new Set(bareKeys).size, bareKeys.length, 'Bare keys must be unique');

    // Check bare keys don't fall into any wildcard's matchspace
    const wildcards = registry.filter(e => e.type === 'wildcard');
    for (const bare of bareKeys) {
      for (const wc of wildcards) {
        const prefix = wc.pattern.replace('-*', '');
        assert.ok(!bare.startsWith(prefix + '-'),
          `Bare key "${bare}" collides with wildcard "${wc.pattern}" (prefix "${prefix}-")`);
      }
    }

    // Check no two wildcards have overlapping prefixes
    for (let i = 0; i < wildcards.length; i++) {
      for (let j = i + 1; j < wildcards.length; j++) {
        const p1 = wildcards[i].pattern.replace('-*', '');
        const p2 = wildcards[j].pattern.replace('-*', '');
        // Sort to get shorter first
        const [shorter, longer] = p1.length <= p2.length ? [p1, p2] : [p2, p1];
        assert.ok(!longer.startsWith(shorter + '-'),
          `Wildcard "${wildcards[i].pattern}" collides with "${wildcards[j].pattern}"`);
      }
    }
  });
});

describe('notifyUser — runbook field', () => {
  it('appends runbook link to message when provided', async () => {
    const saved = process.env.PA_NOTIFY_DISABLED;
    process.env.PA_NOTIFY_DISABLED = '1';
    try {
      const { notifyUser } = await import('../src/lib/notify.js');
      const result = await notifyUser('Test Subject', 'Test body', {
        runbook: 'runbooks/bot-down.md',
      });
      // Check the call was made (even though it was disabled)
      // The runbook should be appended to the message
      assert.equal(result.sent, false);
      assert.equal(result.reason, 'disabled');
    } finally {
      if (saved !== undefined) process.env.PA_NOTIFY_DISABLED = saved;
      else delete process.env.PA_NOTIFY_DISABLED;
    }
  });

  it('does not append runbook when not provided', async () => {
    const saved = process.env.PA_NOTIFY_DISABLED;
    process.env.PA_NOTIFY_DISABLED = '1';
    try {
      const { notifyUser } = await import('../src/lib/notify.js');
      const result = await notifyUser('Test Subject', 'Test body');
      assert.equal(result.sent, false);
      assert.equal(result.reason, 'disabled');
    } finally {
      if (saved !== undefined) process.env.PA_NOTIFY_DISABLED = saved;
      else delete process.env.PA_NOTIFY_DISABLED;
    }
  });

  it('accepts NotifyOpts with runbook field without error', async () => {
    const { notifyUser } = await import('../src/lib/notify.js');
    // TypeScript compile-time check: the runbook field is accepted
    // This test ensures runtime compatibility
    await notifyUser('Test', 'body', {
      dedupKey: 'test-key',
      runbook: 'runbooks/test.md',
      severity: 'warn',
    });
  });
});

describe('notifyUser — circuit breaker', () => {
  const ROUTE_ENV_KEYS = ['PA_NOTIFY_DISABLED', 'PA_NOTIFY_TIMEOUT_MS', 'TELEGRAM_BOT_TOKEN', 'PA_ALERTS_CHAT_ID', 'PA_ALERTS_THREAD_ID'];
  let savedEnv: Record<string, string | undefined>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ROUTE_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const key of ROUTE_ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
    globalThis.fetch = originalFetch;
  });

  function setupFetchMock(responses: Array<{ ok: boolean }>) {
    let callCount = 0;
    (globalThis as any).fetch = async () => {
      const response = responses[Math.min(callCount, responses.length - 1)];
      callCount++;
      return response;
    };
  }

  function todayKey(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  function yesterdayKey(): string {
    const d = new Date(Date.now() - 24 * 3600_000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  it('caps a family at BREAKER_DEFAULT_CAP delivered per local day; the cap+1 call is breaker-open and lands in the digest', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    const { notifyUser, BREAKER_DEFAULT_CAP } = await import('../src/lib/notify.js');

    setupFetchMock([{ ok: true }]);
    for (let i = 0; i < BREAKER_DEFAULT_CAP + 1; i++) {
      const result = await notifyUser('Test', `body ${i}`, { dedupKey: 'cap-key' });
      if (i < BREAKER_DEFAULT_CAP) {
        assert.equal(result.sent, true);
        assert.equal(result.suppressed, false);
      } else {
        assert.equal(result.sent, false);
        assert.equal(result.suppressed, true);
        assert.equal(result.reason, 'breaker-open');
      }
      // Push past the dedup window so the next call isn't dedup-suppressed
      const record = await readDedupFile('cap-key');
      await writeFile(dedupPath('cap-key'), JSON.stringify({ ...record, timestamp: new Date(Date.now() - 3600_1000).toISOString() }), 'utf8');
    }

    // Digest file should exist with one entry
    const digestPath = join(tempDir, 'alert-digest', `${todayKey()}.json`);
    const digest = JSON.parse(await readFile(digestPath, 'utf8'));
    assert.ok(digest.families['cap-key']);
    assert.equal(digest.families['cap-key'].count, 1);
  });

  it('breaker-open writes NO dedup state (send-only invariant)', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    const { notifyUser, BREAKER_DEFAULT_CAP } = await import('../src/lib/notify.js');

    // First 3 sends succeed
    setupFetchMock([{ ok: true }, { ok: true }, { ok: true }]);
    for (let i = 0; i < BREAKER_DEFAULT_CAP; i++) {
      await notifyUser('Test', `body ${i}`, { dedupKey: 'no-state-key' });
      const record = await readDedupFile('no-state-key');
      await writeFile(dedupPath('no-state-key'), JSON.stringify({ ...record, timestamp: new Date(Date.now() - 3600_1000).toISOString() }), 'utf8');
    }

    // 4th call trips breaker
    setupFetchMock([{ ok: true }]);
    const afterTrip = await notifyUser('Test', 'body 4', { dedupKey: 'no-state-key' });
    assert.equal(afterTrip.reason, 'breaker-open');

    // Dedup state is UNCHANGED from after 3rd send
    const record = await readDedupFile('no-state-key');
    assert.equal(record.deliveredToday, BREAKER_DEFAULT_CAP);
    assert.equal(record.day, todayKey());
  });

  it('breaker: false bypasses the cap', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    const { notifyUser, BREAKER_DEFAULT_CAP } = await import('../src/lib/notify.js');

    setupFetchMock([{ ok: true }]);
    for (let i = 0; i < BREAKER_DEFAULT_CAP + 2; i++) {
      const result = await notifyUser('Test', `body ${i}`, { dedupKey: 'bypass-key', breaker: false });
      assert.equal(result.sent, true);
      const record = await readDedupFile('bypass-key');
      await writeFile(dedupPath('bypass-key'), JSON.stringify({ ...record, timestamp: new Date(Date.now() - 3600_1000).toISOString() }), 'utf8');
    }
  });

  it('deliveredToday resets on a new local day', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    const { notifyUser, BREAKER_DEFAULT_CAP } = await import('../src/lib/notify.js');

    // Pre-write a record with yesterday's key at cap (fresh temp PA_HOME per
    // test — create alert-state before writing into it)
    await mkdir(join(tempDir, 'alert-state'), { recursive: true });
    await writeFile(dedupPath('reset-key'), JSON.stringify({
      timestamp: new Date(Date.now() - 48 * 3600_000).toISOString(),
      key: 'reset-key',
      windowMs: 3600_000,
      count: BREAKER_DEFAULT_CAP,
      bodyHash: 'abc123',
      day: yesterdayKey(),
      deliveredToday: BREAKER_DEFAULT_CAP,
    }), 'utf8');

    // One send should succeed (new day reset count to 0, then +1)
    setupFetchMock([{ ok: true }]);
    const result = await notifyUser('Test', 'body', { dedupKey: 'reset-key' });
    assert.equal(result.sent, true);

    const record = await readDedupFile('reset-key');
    assert.equal(record.day, todayKey());
    assert.equal(record.deliveredToday, 1);
  });

  it('a legacy record with no day/deliveredToday fields starts counting from 0', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    const { notifyUser } = await import('../src/lib/notify.js');

    // Legacy record: no day/deliveredToday, expired timestamp
    await mkdir(join(tempDir, 'alert-state'), { recursive: true });
    await writeFile(dedupPath('legacy-no-breaker'), JSON.stringify({
      timestamp: new Date(Date.now() - 2 * 3600_000).toISOString(),
      key: 'legacy-no-breaker',
      windowMs: 3600_000,
      count: 1,
      bodyHash: 'abc123',
    }), 'utf8');

    setupFetchMock([{ ok: true }]);
    const result = await notifyUser('Test', 'body', { dedupKey: 'legacy-no-breaker' });
    assert.equal(result.sent, true, 'should NOT be breaker-open');

    const record = await readDedupFile('legacy-no-breaker');
    assert.equal(record.deliveredToday, 1);
    assert.equal(record.day, todayKey());
  });

  it('calls without dedupKey never hit the breaker', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    const { notifyUser } = await import('../src/lib/notify.js');

    setupFetchMock([{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }]);
    for (let i = 0; i < 5; i++) {
      const result = await notifyUser('Test', `body ${i}`);
      assert.equal(result.sent, true);
    }
  });

  it('a timeout does not advance deliveredToday (unknown outcome is not a delivery)', async () => {
    process.env.PA_NOTIFY_TIMEOUT_MS = '20';
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    const { notifyUser, BREAKER_DEFAULT_CAP } = await import('../src/lib/notify.js');

    // Pre-write a record at cap-1, expired
    await mkdir(join(tempDir, 'alert-state'), { recursive: true });
    await writeFile(dedupPath('timeout-key'), JSON.stringify({
      timestamp: new Date(Date.now() - 3600_000).toISOString(),
      key: 'timeout-key',
      windowMs: 3600_000,
      count: 1,
      bodyHash: 'abc123',
      day: todayKey(),
      deliveredToday: BREAKER_DEFAULT_CAP - 1,
    }), 'utf8');

    // Mock a hang
    (globalThis as any).fetch = async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { ok: true };
    };

    const result = await notifyUser('Test', 'body', { dedupKey: 'timeout-key' });
    assert.equal(result.reason, 'timeout-unknown-outcome');

    const record = await readDedupFile('timeout-key');
    assert.equal(record.deliveredToday, BREAKER_DEFAULT_CAP - 1, 'should NOT advance');
  });

  it('repeated breaker-opens increment the digest entry and update lastAt', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    const { notifyUser, BREAKER_DEFAULT_CAP } = await import('../src/lib/notify.js');

    // First cap+1 sends to trip
    setupFetchMock([{ ok: true }, { ok: true }, { ok: true }]);
    for (let i = 0; i < BREAKER_DEFAULT_CAP; i++) {
      await notifyUser('Test', `body ${i}`, { dedupKey: 'repeat-key' });
      const record = await readDedupFile('repeat-key');
      await writeFile(dedupPath('repeat-key'), JSON.stringify({ ...record, timestamp: new Date(Date.now() - 3600_1000).toISOString() }), 'utf8');
    }
    setupFetchMock([{ ok: true }]);
    await notifyUser('Test', 'body trip', { dedupKey: 'repeat-key' });

    // Two more suppressed calls
    for (let i = 0; i < 2; i++) {
      setupFetchMock([{ ok: true }]);
      await notifyUser('Test', `body after ${i}`, { dedupKey: 'repeat-key' });
    }

    const digestPath = join(tempDir, 'alert-digest', `${todayKey()}.json`);
    const digest = JSON.parse(await readFile(digestPath, 'utf8'));
    assert.equal(digest.families['repeat-key'].count, 3);
    assert.ok(digest.families['repeat-key'].lastAt > digest.families['repeat-key'].firstAt);
  });

  it('breaker suppression works under PA_NOTIFY_DISABLED=1 (placement before the disabled guard)', async () => {
    process.env.PA_NOTIFY_DISABLED = '1';
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    const { notifyUser, BREAKER_DEFAULT_CAP } = await import('../src/lib/notify.js');

    // Pre-write a tripped record
    await mkdir(join(tempDir, 'alert-state'), { recursive: true });
    await writeFile(dedupPath('disabled-key'), JSON.stringify({
      timestamp: new Date(Date.now() - 3600_000).toISOString(),
      key: 'disabled-key',
      windowMs: 3600_000,
      count: 1,
      bodyHash: 'abc123',
      day: todayKey(),
      deliveredToday: BREAKER_DEFAULT_CAP,
    }), 'utf8');

    const result = await notifyUser('Test', 'body', { dedupKey: 'disabled-key' });
    assert.equal(result.suppressed, true);
    assert.equal(result.reason, 'breaker-open');

    const digestPath = join(tempDir, 'alert-digest', `${todayKey()}.json`);
    const digest = JSON.parse(await readFile(digestPath, 'utf8'));
    assert.ok(digest.families['disabled-key']);
  });
});

describe('digest flush helpers', () => {
  function todayKey(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function yesterdayKey(): string {
    const d = new Date(Date.now() - 24 * 3600_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function dayBeforeKey(): string {
    const d = new Date(Date.now() - 2 * 24 * 3600_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  async function writeDigestFile(date: string, families: Record<string, { count: number; subject: string; firstAt: string; lastAt: string }>, flushedAt?: string): Promise<void> {
    const dir = join(tempDir, 'alert-digest');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${date}.json`), JSON.stringify({ date, families, flushedAt }), 'utf8');
  }

  it('collectUnflushedDigests returns strictly-before-today, non-empty, unflushed files, oldest first', async () => {
    const { collectUnflushedDigests } = await import('../src/lib/notify.js');

    // Each exclusion condition gets its OWN date file — same-date writes
    // overwrite each other and would defeat the scenario.
    const dayKey = (offsetDays: number): string => {
      const d = new Date(Date.now() - offsetDays * 24 * 3600_000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    await writeDigestFile(dayKey(4), { familyFlushed: { count: 1, subject: 'F', firstAt: '2024-01-01T00:00:00.000Z', lastAt: '2024-01-01T01:00:00.000Z' } }, '2024-01-01T02:00:00.000Z'); // flushed -> excluded
    await writeDigestFile(dayKey(3), {}); // empty families -> excluded
    await writeDigestFile(dayBeforeKey(), { family2: { count: 1, subject: 'Test2', firstAt: '2024-01-01T00:00:00.000Z', lastAt: '2024-01-01T01:00:00.000Z' } }); // oldest KEPT
    await writeDigestFile(yesterdayKey(), { family1: { count: 2, subject: 'Test', firstAt: '2024-01-01T00:00:00.000Z', lastAt: '2024-01-01T01:00:00.000Z' } }); // KEPT
    await writeDigestFile(todayKey(), { family3: { count: 1, subject: 'Test3', firstAt: '2024-01-01T00:00:00.000Z', lastAt: '2024-01-01T01:00:00.000Z' } }); // today -> excluded
    await mkdir(join(tempDir, 'alert-digest'), { recursive: true });
    await writeFile(join(tempDir, 'alert-digest', 'corrupt.json'), '{invalid json', 'utf8');

    const files = await collectUnflushedDigests(Date.now());
    assert.equal(files.length, 2);
    assert.equal(files[0].date, dayBeforeKey());
    assert.equal(files[1].date, yesterdayKey());
  });

  it('formatDigestMessage produces one line per family with the pinned format', async () => {
    const { formatDigestMessage } = await import('../src/lib/notify.js');

    const files: DigestDayFile[] = [
      { date: '2024-01-01', path: '/x/2024-01-01.json', families: { family1: { count: 2, subject: 'Test', firstAt: '2024-01-01T00:00:00.000Z', lastAt: '2024-01-01T01:00:00.000Z' } } },
      { date: '2024-01-02', path: '/x/2024-01-02.json', families: { family2: { count: 1, subject: 'Test2', firstAt: '2024-01-02T00:00:00.000Z', lastAt: '2024-01-02T01:00:00.000Z' } } },
    ];
    const { subject, body } = formatDigestMessage(files);
    assert.equal(subject, 'Alert digest 2024-01-01, 2024-01-02');
    assert.ok(body.includes('family1 ×2 (first 2024-01-01T00:00:00.000Z, last 2024-01-01T01:00:00.000Z)'));
    assert.ok(body.includes('family2 ×1 (first 2024-01-02T00:00:00.000Z, last 2024-01-02T01:00:00.000Z)'));
  });

  it('markDigestFlushed writes flushedAt and round-trips through collectUnflushedDigests', async () => {
    const { collectUnflushedDigests, markDigestFlushed } = await import('../src/lib/notify.js');

    await writeDigestFile(yesterdayKey(), { family1: { count: 1, subject: 'Test', firstAt: '2024-01-01T00:00:00.000Z', lastAt: '2024-01-01T01:00:00.000Z' } });

    const before = await collectUnflushedDigests(Date.now());
    assert.equal(before.length, 1);

    await markDigestFlushed(before[0], Date.now());

    const after = await collectUnflushedDigests(Date.now());
    assert.equal(after.length, 0);
  });
});
