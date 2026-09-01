import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { appendFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runPollLoop, _setExitForTest } from '../main.js';
import type { ConversationState } from '../types.js';
import { rmRetry } from './rm-retry.js';
import { waitForDrain } from './test-teardown-guard.js';

// Root cause of this file registering ZERO tests under `node --test` (dark
// since ~2026-08-28, fixed 2026-09-01): each awaited runPollLoop() below runs
// its loop to completion and hits the real process.exit(0), killing this
// file's isolated test subprocess before its TAP output reaches the parent.
// See the matching comment in poll-loop.test.ts for the full mechanism.
_setExitForTest(() => {});

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
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('/default <worker> edits the existing pinned card in place and stamps default_changed', async () => {
    const configPath = join(tempDir, 'config.yaml');
    await writeFile(configPath, `
workers:
  - name: claude
    command: node
    args: ["-e", "process.stdout.write('ok')"]
    check: node -e "process.exit(0)"
  - name: agy
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
                text: '/default agy',
              },
            }] }),
            json: async () => ({ ok: true, result: [{
              update_id: 1,
              message: {
                message_id: 10,
                chat: { id: 123, type: 'private' },
                date: Math.floor(Date.now() / 1000),
                text: '/default agy',
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

    const editCalls = fetchLog.filter(u => u.includes('editMessageText'));
    const unpinCalls = fetchLog.filter(u => u.includes('unpinChatMessage'));
    const pinCalls = fetchLog.filter(u => u.includes('pinChatMessage'));

    // refreshPinnedStatusCardInPlace (main.ts) always tries editMessageText first when a
    // pinned_status_message_id already exists, falling back to unpin+send+pin only if the
    // edit fails — it never fails here (mock always returns ok:true), so both the ambient
    // startup model-expiry sweep's own refresh AND /default's refresh edit message 100
    // in place; neither unpin/pin/fresh-send ever fires.
    assert.ok(editCalls.some(c => c.includes('Topic Status')), 'should edit the existing status card in place');
    assert.equal(unpinCalls.length, 0, 'edit-in-place must never unpin the existing card');
    assert.equal(pinCalls.length, 0, 'edit-in-place must never pin a new card');

    const saved = JSON.parse(await readFile(topicStateFile, 'utf8')) as ConversationState;
    assert.equal(saved.model_status?.current_worker, 'agy');
    assert.equal(saved.model_status?.reason_code, 'default_changed');
    assert.equal(saved.pinned_status_message_id, 100, 'edit-in-place keeps the same pinned message id');
  });

  it('/reset refreshes pin with reason reset', async () => {
    const configPath = join(tempDir, 'config.yaml');
    await writeFile(configPath, 'workers: [{name: "claude", command: "node", args: ["-e", ""], check: "node -e \\"process.exit(0)\\""}]', 'utf8');

    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    const topicState = {
      chat_id: 123,
      thread_id: 0,
      turns: [{ role: 'user', text: 'hello' }],
      preferred_worker: 'agy',
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
        current_worker: 'agy',
        default_worker: 'claude',
        reason_code: 'failover',
        reason_text: 'Temporary failover',
        changed_at: new Date().toISOString()
      },
      pinned_worker: 'agy',
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

    // MODEL_STATUS_REASON_TEXT.recovery (logic.ts) reads "configured agent" — the
    // worker/agent terminology shift landed after this assertion was written ("worker").
    const hasRecovery = fetchLog.some(c => c.includes('Reason: Recovered to the configured agent'));
    if (!hasRecovery) {
      console.log('Fetch Log:', fetchLog);
    }
    assert.ok(hasRecovery, 'status card should show recovery reason');
    const saved = JSON.parse(await readFile(topicStateFile, 'utf8')) as ConversationState;
    assert.equal(saved.model_status?.reason_code, 'recovery');
    assert.equal(saved.model_status?.current_worker, 'claude');
  });


  // --- Worker tunables wired through the real poll loop ---------------------
  // The cascade/parse/render layers are unit-tested in tunables-commands.test.ts;
  // what these two prove is the PROCESSMESSAGE WIRING: that /effort is
  // intercepted as a local command (no worker dispatch) and that its result is
  // persisted to topic state.

  async function runOneUpdate(text: string, fetchLog: string[]): Promise<void> {
    const controller = new AbortController();
    const state = makeState(123, -1);
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      fetchLog.push(url + (opts?.body ? ' ' + opts.body : ''));
      if (url.includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          const payload = { ok: true, result: [{
            update_id: 1,
            message: { message_id: 10, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text },
          }] };
          return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
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
  }

  it('/effort <value> is handled locally and persisted as a session override', async () => {
    // A worker that would FAIL if it were ever dispatched — proving the command
    // never reaches a worker.
    await writeFile(join(tempDir, 'config.yaml'), `
workers:
  - name: agy
    command: node
    args: ["-e", "process.exit(3)"]
    check: node -e "process.exit(0)"
    tunables:
      effort:
        args: ["--effort", "{value}"]
        values: [low, medium, high]
topic_defaults:
  "123_0": "agy"
`, 'utf8');

    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    await writeFile(topicStateFile, JSON.stringify({ chat_id: 123, thread_id: 0, turns: [] }), 'utf8');

    const fetchLog: string[] = [];
    await runOneUpdate('/effort high', fetchLog);

    const sent = fetchLog.filter((u) => u.includes('sendMessage'));
    assert.ok(sent.some((c) => c.includes('--effort') && c.includes('high')), 'reply should confirm the value and the args it produces');

    const saved = JSON.parse(await readFile(topicStateFile, 'utf8')) as ConversationState;
    assert.equal(saved.tunable_overrides?.['agy']?.['effort'], 'high');
    assert.ok(saved.tunable_overrides_set_at?.['agy:effort'], 'the set-at stamp drives IST-day expiry');
    assert.equal(saved.tunable_defaults, undefined, 'session tier only — /default writes the topic tier');
  });

  it('/effort on a worker that declares no effort is rejected with what it DOES support', async () => {
    await writeFile(join(tempDir, 'config.yaml'), `
workers:
  - name: agy
    command: node
    args: ["-e", "process.exit(3)"]
    check: node -e "process.exit(0)"
    tunables:
      model:
        args: ["--model", "{value}"]
topic_defaults:
  "123_0": "agy"
`, 'utf8');

    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    await writeFile(topicStateFile, JSON.stringify({ chat_id: 123, thread_id: 0, turns: [] }), 'utf8');

    const fetchLog: string[] = [];
    await runOneUpdate('/effort high', fetchLog);

    const sent = fetchLog.filter((u) => u.includes('sendMessage'));
    assert.ok(sent.some((c) => c.includes('no setting called') && c.includes('model')), 'reply should name what agy supports');

    const saved = JSON.parse(await readFile(topicStateFile, 'utf8')) as ConversationState;
    assert.equal(saved.tunable_overrides, undefined, 'a rejected knob stores nothing');
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

  it('/model <value> updates the pinned status card with Model', async () => {
    await writeFile(join(tempDir, 'config.yaml'), `
workers:
  - name: agy
    command: node
    args: ["-e", "process.exit(0)"]
    check: node -e "process.exit(0)"
    tunables:
      model:
        args: ["--model", "{value}"]
topic_defaults:
  "123_0": "agy"
`, 'utf8');

    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    await writeFile(topicStateFile, JSON.stringify({
      chat_id: 123,
      thread_id: 0,
      turns: [],
      pinned_status_message_id: 100,
    }), 'utf8');

    const fetchLog: string[] = [];
    await runOneUpdate('/model gemini-3.7-flash-high', fetchLog);

    // Should edit the pinned message text with Model: gemini-3.7-flash-high. The
    // pre-existing topic-state file has no model_status, so the ambient startup
    // model-expiry sweep also edits this same pin (modelStatusNeedsRefresh sees no
    // previous snapshot) ahead of the /model command's own edit — search all edit
    // calls rather than assuming index 0 is the command's own.
    const editCalls = fetchLog.filter(u => u.includes('editMessageText'));
    assert.ok(editCalls.length > 0, 'must call editMessageText to refresh pinned card');
    // The pin's editMessageText body carries the model name through TWO escaping
    // layers: renderStatusCard's raw text is sanitizeMdV2'd (every `-`/`.` gets a
    // literal backslash) before it becomes the request body's `text` field, then
    // JSON.stringify(body) doubles each of THOSE backslashes for the wire. Stripping
    // every backslash (regardless of how many piled up) recovers the plain substring
    // without having to model either escaping layer exactly.
    const deEscaped = (s: string) => s.replace(/\\/g, '');
    assert.ok(editCalls.some(u => deEscaped(u).includes('gemini-3.7-flash-high')), 'edited card must contain the new model');
  });

  it('/agent <name> switches agent and remembers per-agent model across switches', async () => {
    // This test issues 4 sequential runOneUpdate calls, each hardcoding update_id: 1
    // (see runOneUpdate above) — the persistent delivered-store dedup guard (main.ts,
    // "Bypass the persistent dedup under the test flag" comment) would otherwise treat
    // calls 2-4 as re-sends of an already-delivered update and skip their replies/pin
    // edits entirely. PA_NOTIFY_DISABLED=1 is the documented escape hatch for exactly
    // this pattern.
    process.env.PA_NOTIFY_DISABLED = '1';
    try {
    await writeFile(join(tempDir, 'config.yaml'), `
workers:
  - name: agy
    command: node
    args: ["-e", "process.exit(0)"]
    check: node -e "process.exit(0)"
    tunables:
      model:
        args: ["--model", "{value}"]
  - name: claude
    command: node
    args: ["-e", "process.exit(0)"]
    check: node -e "process.exit(0)"
    tunables:
      model:
        args: ["--model", "{value}"]
        default: "opusplan"
topic_defaults:
  "123_0": "claude"
`, 'utf8');

    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    await writeFile(topicStateFile, JSON.stringify({
      chat_id: 123,
      thread_id: 0,
      turns: [],
      pinned_status_message_id: 100,
    }), 'utf8');

    // 1. Switch to agy
    const fetchLog1: string[] = [];
    await runOneUpdate('/agent agy', fetchLog1);

    // 2. Set model on agy to gemini-3.7-flash-high
    const fetchLog2: string[] = [];
    await runOneUpdate('/model gemini-3.7-flash-high', fetchLog2);

    // 3. Switch to claude
    const fetchLog3: string[] = [];
    await runOneUpdate('/agent claude', fetchLog3);

    // Check state has both
    const stateMid = JSON.parse(await readFile(topicStateFile, 'utf8'));
    assert.equal(stateMid.tunable_overrides?.agy?.model, 'gemini-3.7-flash-high');

    // 4. Switch back to agy
    const fetchLog4: string[] = [];
    await runOneUpdate('/agent agy', fetchLog4);

    // The status card for agy must restore gemini-3.7-flash-high. sendMessage/
    // editMessageText bodies are MarkdownV2-sanitized before they hit the wire
    // (every '-'/'.' gets a literal backslash) — strip backslashes before matching,
    // same fix as the /model pinned-card escaping issue elsewhere in this wave.
    const pinCardEdits = fetchLog4.filter(u => u.includes('editMessageText') || u.includes('sendMessage'));
    assert.ok(pinCardEdits.some(u => u.replace(/\\/g, '').includes('gemini-3.7-flash-high')), 'status card must reflect remembered model');
    } finally {
      delete process.env.PA_NOTIFY_DISABLED;
    }
  });
});
