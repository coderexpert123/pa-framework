import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { appendFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runPollLoop } from '../main.js';
import type { ConversationState } from '../types.js';
import { rmRetry } from './rm-retry.js';

// Instant sleep for tests — no real waiting
const fastSleep = async (_ms: number): Promise<void> => {};

function makeState(chatId = 123, lastUpdateId = -1): ConversationState {
  return { chat_id: chatId, last_update_id: lastUpdateId, thread_id: 0, turns: [] };
}

describe('runPollLoop: Integration Extra (Phase 4 Task 3)', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-extra-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('/default <worker> posts fresh pinned card', async () => {
    const configPath = join(tempDir, 'config.yaml');
    await writeFile(configPath, `
workers:
  - name: claude
    command: node
    args: ["-e", "process.stdout.write('ok')"]
    check: node -e "process.exit(0)"
  - name: gemini
    command: node
    args: ["-e", "process.stdout.write('ok')"]
    check: node -e "process.exit(0)"
topic_defaults:
  "123_0": "claude"
`, 'utf8');

    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    const topicState = {
      chat_id: 123,
      thread_id: 0,
      turns: [],
      pinned_status_message_id: 100
    };
    await writeFile(topicStateFile, JSON.stringify(topicState), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);
    let getUpdatesCount = 0;
    const fetchLog: string[] = [];

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      fetchLog.push(url + (opts?.body ? ' ' + opts.body : ''));
      if (url.includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [{
              update_id: 1,
              message: {
                message_id: 10,
                chat: { id: 123, type: 'private' },
                date: Math.floor(Date.now() / 1000),
                text: '/default gemini',
              },
            }] }),
            json: async () => ({ ok: true, result: [{
              update_id: 1,
              message: {
                message_id: 10,
                chat: { id: 123, type: 'private' },
                date: Math.floor(Date.now() / 1000),
                text: '/default gemini',
              },
            }] }),
          };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if (url.includes('sendMessage')) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 200 } }),
          json: async () => ({ ok: true, result: { message_id: 200 } }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const sendMessageCalls = fetchLog.filter(u => u.includes('sendMessage'));
    const unpinCalls = fetchLog.filter(u => u.includes('unpinChatMessage'));
    const pinCalls = fetchLog.filter(u => u.includes('pinChatMessage'));

    assert.ok(sendMessageCalls.some(c => c.includes('Topic Status')), 'should send status card');
    assert.ok(unpinCalls.some(c => c.includes('100')), 'should unpin old card');
    assert.ok(pinCalls.some(c => c.includes('200')), 'should pin new card');

    const saved = JSON.parse(await readFile(topicStateFile, 'utf8')) as ConversationState;
    assert.equal(saved.model_status?.current_worker, 'gemini');
    assert.equal(saved.model_status?.reason_code, 'default_changed');
    assert.equal(saved.pinned_status_message_id, 200);
  });

  it('/reset refreshes pin with reason reset', async () => {
    const configPath = join(tempDir, 'config.yaml');
    await writeFile(configPath, 'workers: [{name: "claude", command: "node", args: ["-e", ""], check: "node -e \\"process.exit(0)\\""}]', 'utf8');

    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    const topicState = {
      chat_id: 123,
      thread_id: 0,
      turns: [{ role: 'user', text: 'hello' }],
      preferred_worker: 'gemini',
      pinned_status_message_id: 100
    };
    await writeFile(topicStateFile, JSON.stringify(topicState), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);
    let getUpdatesCount = 0;
    const fetchLog: string[] = [];

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      fetchLog.push(url + (opts?.body ? ' ' + opts.body : ''));
      if (url.includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [{
              update_id: 1,
              message: { message_id: 10, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/reset' },
            }] }),
            json: async () => ({ ok: true, result: [{
              update_id: 1,
              message: { message_id: 10, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/reset' },
            }] }),
          };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if (url.includes('sendMessage')) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 200 } }),
          json: async () => ({ ok: true, result: { message_id: 200 } }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    assert.ok(fetchLog.some(c => c.includes('Reason: Topic reset')), 'status card should show reset reason');
    const saved = JSON.parse(await readFile(topicStateFile, 'utf8')) as ConversationState;
    // We expect 1 turn: the assistant's "Conversation and session cleared" reply.
    assert.equal(saved.turns.length, 1, 'should have 1 assistant turn');
    assert.equal(saved.turns[0].role, 'assistant');
    assert.equal(saved.preferred_worker, undefined, 'preferred_worker should be cleared');
    assert.equal(saved.model_status?.reason_code, 'reset');
  });

  it('/keepawake preserves the Reason line in edited pin', async () => {
    // This test checks if /keepawake edits the existing pin and keeps the Reason line.
    const configPath = join(tempDir, 'config.yaml');
    await writeFile(configPath, 'workers: [{name: "claude", command: "node", args: ["-e", ""], check: "node -e \\"process.exit(0)\\""}]', 'utf8');

    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    const topicState = {
      chat_id: 123,
      thread_id: 0,
      turns: [],
      model_status: {
        current_worker: 'claude',
        default_worker: 'claude',
        reason_code: 'user_override',
        reason_text: 'Temporary user override until IST midnight.',
        changed_at: new Date().toISOString()
      },
      pinned_status_message_id: 100
    };
    await writeFile(topicStateFile, JSON.stringify(topicState), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);
    let getUpdatesCount = 0;
    const fetchLog: string[] = [];
    const debugFile = join(tempDir, 'debug-fetch.log');
    if (existsSync(debugFile)) unlinkSync(debugFile);

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      const entry = url + (opts?.body ? ' ' + opts.body : '');
      fetchLog.push(entry);
      appendFileSync(debugFile, entry + '\n', 'utf8');
      if (url.includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [{
              update_id: 1,
              message: { message_id: 10, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/keepawake' },
            }] }),
            json: async () => ({ ok: true, result: [{
              update_id: 1,
              message: { message_id: 10, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/keepawake' },
            }] }),
          };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if (url.includes('sendMessage')) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 200 } }),
          json: async () => ({ ok: true, result: { message_id: 200 } }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    // Need to simulate keepawake.ts toggling.
    const keepAwakeFile = join(tempDir, 'telegram-keepawake.json');
    // Initialize as off
    await writeFile(keepAwakeFile, JSON.stringify({ active: false }), 'utf8');

    await runPollLoop('token', [123], state, { TELEGRAM_CHAT_ID: '123' }, controller.signal, fastSleep);

    const editCalls = fetchLog.filter(u => u.includes('editMessageText'));
    const debugLog = readFileSync(debugFile, 'utf8');
    assert.ok(editCalls.length >= 1, 'should edit the existing pin. Fetch Log: ' + debugLog);
    assert.ok(editCalls[0].includes('Temporary user override'), 'should preserve Reason line');
    assert.ok(editCalls[0].includes('awake: on'), 'should show Keep-awake: on');
  });

  it('recovery-after-failover posts a recovery card', async () => {
    const configPath = join(tempDir, 'config.yaml');
    // Succeed script
    const succeedScript = join(tempDir, 'recovery-succeed.mjs');
    await writeFile(succeedScript, 'process.stdout.write("ok"); process.exit(0);\n', 'utf8');

    await writeFile(configPath, `
workers:
  - name: claude
    command: node
    args: ["${succeedScript.replace(/\\/g, '/')}"]
    check: node -e "process.exit(0)"
topic_defaults:
  "123_0": "claude"
`, 'utf8');

    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    const topicState = {
      chat_id: 123,
      thread_id: 0,
      turns: [],
      model_status: {
        current_worker: 'gemini',
        default_worker: 'claude',
        reason_code: 'failover',
        reason_text: 'Temporary failover',
        changed_at: new Date().toISOString()
      },
      pinned_worker: 'gemini',
      pinned_status_message_id: 100
    };
    await writeFile(topicStateFile, JSON.stringify(topicState), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);
    let getUpdatesCount = 0;
    const fetchLog: string[] = [];

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      fetchLog.push(url + (opts?.body ? ' ' + opts.body : ''));
      if (url.includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [{
              update_id: 1,
              message: { message_id: 10, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'hello' },
            }] }),
            json: async () => ({ ok: true, result: [{
              update_id: 1,
              message: { message_id: 10, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'hello' },
            }] }),
          };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if (url.includes('sendMessage')) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 200 } }),
          json: async () => ({ ok: true, result: { message_id: 200 } }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const hasRecovery = fetchLog.some(c => c.includes('Reason: Recovered to the configured worker'));
    if (!hasRecovery) {
      console.log('Fetch Log:', fetchLog);
    }
    assert.ok(hasRecovery, 'status card should show recovery reason');
    const saved = JSON.parse(await readFile(topicStateFile, 'utf8')) as ConversationState;
    assert.equal(saved.model_status?.reason_code, 'recovery');
    assert.equal(saved.model_status?.current_worker, 'claude');
  });


  it('idle steady-state sweep updates hydrated status', async () => {
    // This test checks if the idle sweep (run via a timer in real bot, but we'll mock the time)
    // correctly hydrates status and syncs it.
    // The previous tests only checked the midnight reset.
    // Here we'll check that a topic without model_status gets one during sweep.
    const configPath = join(tempDir, 'config.yaml');
    await writeFile(configPath, `
workers:
  - name: claude
    command: node
    args: ["-e", ""]
    check: node -e "process.exit(0)"
topic_defaults:
  "123_0": "claude"
`, 'utf8');

    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    const topicState = {
      chat_id: 123,
      thread_id: 0,
      turns: [],
      // No model_status
      pinned_worker: 'claude'
    };
    await writeFile(topicStateFile, JSON.stringify(topicState), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);
    
    // To trigger sweep in runPollLoop, we need to wait for MODEL_SWEEP_INTERVAL_MS.
    // But runPollLoop in the test uses fastSleep.
    // Let's look at how sweep is triggered in main.ts.
    // It's in the poll loop.
    
    let getUpdatesCount = 0;
    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if (url.includes('getUpdates')) {
        getUpdatesCount++;
        // On second poll, we've supposedly passed the sweep interval if we mock Date.now
        if (getUpdatesCount === 2) {
          controller.abort();
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    const originalDateNow = Date.now;
    let now = Date.now();
    Date.now = () => now;

    try {
      // First poll
      // (Wait for runPollLoop to call Date.now once or twice)
      
      const pollPromise = runPollLoop('token', [123], state, {}, controller.signal, async (ms) => {
        now += 65000; // Advance time past MODEL_SWEEP_INTERVAL_MS (60s)
        await fastSleep(ms);
      });
      
      await pollPromise;
    } finally {
      Date.now = originalDateNow;
    }

    const saved = JSON.parse(await readFile(topicStateFile, 'utf8')) as ConversationState;
    assert.ok(saved.model_status, 'should have hydrated model_status');
    assert.equal(saved.model_status?.current_worker, 'claude');
    assert.equal(saved.model_status?.reason_code, 'default_active');
  });
});
