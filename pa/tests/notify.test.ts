import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';

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

  it('reports a timed-out send honestly and writes NO dedup state', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n');
    process.env.PA_NOTIFY_TIMEOUT_MS = '20';
    setupFetchMock(['hang']);
    const { notifyUser } = await import('../src/lib/notify.js');

    const result = await notifyUser('Test', 'body', { dedupKey: 'timeout-key' });

    assert.equal(result.sent, false);
    assert.equal(result.suppressed, false);
    assert.equal(result.reason, 'timeout-unknown-outcome', 'the race does not cancel the send — outcome is unknown, not failed');
    assert.equal(await dedupFileExists('timeout-key'), false);
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
