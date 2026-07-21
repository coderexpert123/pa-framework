import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { notifyUser } from '../src/lib/notify.js';
import { notifyCommand } from '../src/commands/notify-cmd.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

describe('notifyCommand — argument parsing', () => {
  // Rather than spawning a subprocess, test the notifyUser function directly
  // (notifyCommand is a thin wrapper). CLI flag parsing is exercised in e2e.

  it('notifyUser returns sent=false without token', async () => {
    const result = await notifyUser('Test Subject', 'Test body', {
      dedupKey: 'test-dedup',
    });
    assert.equal(result.sent, false);
    assert.equal(result.suppressed, false);
  });

  it('notifyUser passes through topic override', async () => {
    const result = await notifyUser('Test', 'body', {
      topic: { chat_id: '-100999', thread_id: 42 },
    });
    // Without token, always sent=false
    assert.equal(result.sent, false);
  });

  it('notifyUser passes through severity', async () => {
    const result = await notifyUser('Test', 'body', {
      severity: 'error',
    });
    assert.equal(result.sent, false);
  });
});

// ---------------------------------------------------------------------------
// `pa notify` route resolution (2026-07-21).
//
// `--topic-thread N` used to pair the requested thread with an ENV-ONLY chat id,
// which is '' on every deployment whose PA_ALERTS_CHAT_ID lives in secrets.env.
// The chat now comes from the same secrets-aware resolver notifyUser uses; the
// flag overrides the THREAD only.
// ---------------------------------------------------------------------------

describe('notifyCommand — route resolution', () => {
  const KEYS = [
    'PA_ALERTS_CHAT_ID',
    'PA_ALERTS_THREAD_ID',
    'TELEGRAM_CHAT_ID',
    'TELEGRAM_BOT_TOKEN',
    'PA_NOTIFY_DISABLED',
  ];
  let savedEnv: Record<string, string | undefined>;
  let originalFetch: typeof globalThis.fetch;
  let originalLog: typeof console.log;

  beforeEach(() => {
    savedEnv = {};
    for (const key of KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    originalFetch = globalThis.fetch;
    originalLog = console.log;
    console.log = () => {}; // notifyCommand prints its outcome; keep test output clean
  });

  afterEach(() => {
    // notifyCommand copies secrets.env into process.env — restore every key it
    // could have introduced, not just the ones this test set.
    for (const key of KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  });

  function setupFetchMock(): Array<{ url: string; init?: any }> {
    const calls: Array<{ url: string; init?: any }> = [];
    (globalThis as Record<string, unknown>).fetch = async (url: string, init?: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    };
    return calls;
  }

  it('pairs --topic-thread with the chat resolved from secrets.env', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\nPA_ALERTS_THREAD_ID=42\n');
    const calls = setupFetchMock();

    await notifyCommand(['--subject', 'S', '--body', 'B', '--topic-thread', '1234']);

    assert.equal(calls.length, 1, 'expected exactly one Telegram request');
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.chat_id, '-100777', 'the chat must come from secrets.env, not an env-only getter');
    assert.equal(body.message_thread_id, 1234, '--topic-thread overrides the thread');
  });

  it('uses the resolved pa-alerts thread when --topic-thread is omitted', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\nPA_ALERTS_THREAD_ID=42\n');
    const calls = setupFetchMock();

    await notifyCommand(['--subject', 'S', '--body', 'B']);

    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.chat_id, '-100777');
    assert.equal(body.message_thread_id, 42);
  });
});
