import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat, utimes } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { Readable } from 'node:stream';
import { runPollLoop, extractReplyContext, generateDescriptionSuggestion, isValidDescriptionOutput, parseDescriptionLLMOutput, postDescriptionSuggestion, requeueSyntheticUpdate, _setExitForTest } from '../main.js';
import { loadBranches, type BranchIndex } from '../topic-names.js';
import { _setDegradedForTest } from '../health.js';
import { _resetDlqMutexForTest } from '../dlq.js';
import type { ConversationState } from '../types.js';
import { rmRetry } from './rm-retry.js';
import { trackPendingWork, waitForDrain } from './test-teardown-guard.js';
import { listPendingDispatches, pendingDispatchKey, _resetPendingDispatchesForTest } from '../pending-dispatches.js';
import { markTopicRecovering, clearTopicRecovering, _resetRecoveryGateForTest } from '../recovery-gate.js';
import { _clearQueueForTest } from '../topic-queue.js';
import { blackboard } from '../../../../pa/dist/src/blackboard.js';

// Root cause of this file registering ZERO tests under `node --test` (dark
// since ~2026-08-28, fixed 2026-09-01): `node --test` isolates each test file
// into its own subprocess, and dozens of tests below `await runPollLoop(...)`
// to completion — driving the loop to its natural exit, which unconditionally
// called the real `process.exit(0)`. That killed this file's subprocess
// before node:test's own TAP output for it reached the parent, so the whole
// file read back as an empty shell. Neutralize it for the life of this
// subprocess (never shared with another file, so no restore is needed).
_setExitForTest(() => {});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type FetchResponse = {
  ok: boolean;
  status?: number;
  bodyText?: string;
  bodyJson?: unknown;
};

/**
 * Sets up a fetch mock that exhausts responses in order, then aborts the given
 * controller after all responses have been consumed. Returns a list of call URLs.
 */
function setupFetchMock(
  responses: FetchResponse[],
  controller?: AbortController
): Array<{ url: string }> {
  const calls: Array<{ url: string }> = [];
  let i = 0;

  (globalThis as Record<string, unknown>).fetch = async (url: string) => {
    calls.push({ url });
    const r = responses[Math.min(i++, responses.length - 1)];

    // Abort after all planned responses have been used
    if (i >= responses.length && controller) {
      controller.abort();
    }

    const json = r.bodyJson ?? {};
    const text = r.bodyText ?? JSON.stringify(json);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      text: async () => text,
      json: async () => json,
    };
  };

  return calls;
}

function emptyUpdatesResponse(): FetchResponse {
  return { ok: true, bodyJson: { ok: true, result: [] } };
}

function makeState(chatId = 123, lastUpdateId = -1): ConversationState {
  return { chat_id: chatId, last_update_id: lastUpdateId, thread_id: 0, turns: [] };
}

// Instant sleep for tests — no real waiting
const fastSleep = async (_ms: number): Promise<void> => {};

// ---------------------------------------------------------------------------
// Signal: exits immediately
// ---------------------------------------------------------------------------

describe('runPollLoop: signal control', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-signal-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await waitForDrain();
    _resetDlqMutexForTest(); // an aborted loop can leave the module mutex held (dlq.ts:78) — same class as cardKeyboardIndex
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('exits immediately when signal is already aborted before first poll', async () => {
    const controller = new AbortController();
    controller.abort();
    const calls = setupFetchMock([], controller);

    await runPollLoop('token', [123], makeState(), {}, controller.signal, fastSleep);

    assert.equal(calls.length, 0, 'fetch must not be called when signal is pre-aborted');
  });
});

// ---------------------------------------------------------------------------
// Polling behaviour
// ---------------------------------------------------------------------------

describe('runPollLoop: polling', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-polling-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('polls with LONG_POLL_TIMEOUT (timeout=30) in URL', async () => {
    const controller = new AbortController();
    const calls = setupFetchMock([emptyUpdatesResponse()], controller);

    await runPollLoop('mytoken', [123], makeState(), {}, controller.signal, fastSleep);

    assert.ok(calls.length >= 1, 'must have made at least one fetch call');
    assert.ok(calls[0].url.includes('timeout=30'), `URL must contain timeout=30, got: ${calls[0].url}`);
  });

  it('includes correct offset in poll URL', async () => {
    const controller = new AbortController();
    const state = makeState(123, 10); // last_update_id=10 → next offset=11
    const calls = setupFetchMock([emptyUpdatesResponse()], controller);

    await runPollLoop('mytoken', [123], state, {}, controller.signal, fastSleep);

    assert.ok(calls[0].url.includes('offset=11'), `URL must contain offset=11, got: ${calls[0].url}`);
  });

  it('uses offset=0 when last_update_id is -1 (drain-complete sentinel)', async () => {
    const controller = new AbortController();
    const state = makeState(123, -1);
    const calls = setupFetchMock([emptyUpdatesResponse()], controller);

    await runPollLoop('mytoken', [123], state, {}, controller.signal, fastSleep);

    assert.ok(calls[0].url.includes('offset=0'), `URL must contain offset=0, got: ${calls[0].url}`);
  });

  it('loops and polls again after empty response', async () => {
    const controller = new AbortController();
    const calls = setupFetchMock([
      emptyUpdatesResponse(),
      emptyUpdatesResponse(),
    ], controller);

    await runPollLoop('token', [123], makeState(), {}, controller.signal, fastSleep);

    assert.ok(calls.length >= 2, `expected 2+ fetch calls, got ${calls.length}`);
  });

  it('uses offset N+1 on the next poll after receiving update with id N', async () => {
    const controller = new AbortController();
    const state = makeState(123, -1); // offset starts at 0
    const update = {
      update_id: 99,
      message: {
        message_id: 1,
        chat: { id: 9999, type: 'private' }, // wrong chat_id → skips dispatch
        date: Math.floor(Date.now() / 1000),
        text: 'hello',
      },
    };

    const calls = setupFetchMock([
      { ok: true, bodyJson: { ok: true, result: [update] } }, // first poll: returns update 99
      emptyUpdatesResponse(),                                  // second poll: abort
    ], controller);

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    assert.ok(calls.length >= 2, `expected 2+ fetch calls, got ${calls.length}`);
    assert.ok(calls[0].url.includes('offset=0'), `first poll should use offset=0, got: ${calls[0].url}`);
    assert.ok(calls[1].url.includes('offset=100'), `second poll should use offset=100 (99+1), got: ${calls[1].url}`);
  });
});

// ---------------------------------------------------------------------------
// Deferred acknowledgement
// ---------------------------------------------------------------------------

describe('runPollLoop: deferred acknowledgement', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-ack-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('persists last_update_id after all updates are processed', async () => {
    const controller = new AbortController();
    const state = makeState(123, -1);
    const update = {
      update_id: 99,
      message: {
        message_id: 1,
        chat: { id: 9999, type: 'private' }, // wrong chat_id → skips dispatch
        date: Math.floor(Date.now() / 1000),
        text: 'hello',
      },
    };

    setupFetchMock([
      { ok: true, bodyJson: { ok: true, result: [update] } },
    ], controller);

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const raw = await readFile(join(tempDir, 'telegram-bot-state.json'), 'utf8');
    const saved = JSON.parse(raw) as ConversationState;
    assert.equal(saved.last_update_id, 99);
  });

  it('does not advance last_update_id when no updates arrive', async () => {
    const controller = new AbortController();
    const state = makeState(123, 5); // existing last_update_id

    setupFetchMock([emptyUpdatesResponse()], controller);

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    try {
      const raw = await readFile(join(tempDir, 'telegram-bot-state.json'), 'utf8');
      const saved = JSON.parse(raw) as ConversationState;
      assert.equal(saved.last_update_id, 5, 'last_update_id must not change on empty poll');
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
      // If file doesn't exist, it means it wasn't written, which is also correct
      // since last_update_id didn't change.
    }
  });
});

// ---------------------------------------------------------------------------
// Error recovery
// ---------------------------------------------------------------------------

describe('runPollLoop: error recovery', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-err-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('continues looping after a single getUpdates failure', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    let attempt = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      calls.push(url as string);
      attempt++;
      if (attempt === 1) throw new Error('Network failure');
      controller.abort();
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, result: [] }),
        json: async () => ({ ok: true, result: [] }),
      };
    };

    await runPollLoop('token', [123], makeState(), {}, controller.signal, fastSleep);

    assert.equal(calls.length, 2, 'must have retried after the failure');
  });

  it('applies backoff between retries (verifies sleepFn is called with correct ms)', async () => {
    const controller = new AbortController();
    const sleepCalls: number[] = [];
    const trackingSleep = async (ms: number) => { sleepCalls.push(ms); };

    let attempt = 0;
    (globalThis as Record<string, unknown>).fetch = async () => {
      attempt++;
      if (attempt <= 2) throw new Error('fail');
      controller.abort();
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, result: [] }),
        json: async () => ({ ok: true, result: [] }),
      };
    };

    await runPollLoop('token', [123], makeState(), {}, controller.signal, trackingSleep);

    // After error 1: backoff=5000ms; after error 2: backoff=10000ms
    assert.equal(sleepCalls.length, 2, 'sleep must be called once per error');
    assert.equal(sleepCalls[0], 5000, 'first backoff must be 5000ms');
    assert.equal(sleepCalls[1], 10000, 'second backoff must be 10000ms');
  });

  it('resets consecutive error count after a successful poll', async () => {
    const controller = new AbortController();
    const sleepCalls: number[] = [];
    const trackingSleep = async (ms: number) => { sleepCalls.push(ms); };

    let attempt = 0;
    (globalThis as Record<string, unknown>).fetch = async () => {
      attempt++;
      if (attempt === 1) throw new Error('fail once');
      if (attempt === 2) {
        // Success — resets consecutiveErrors to 0
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }
      if (attempt === 3) throw new Error('fail again');
      // 4th call: succeed and abort
      controller.abort();
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, result: [] }),
        json: async () => ({ ok: true, result: [] }),
      };
    };

    await runPollLoop('token', [123], makeState(), {}, controller.signal, trackingSleep);

    // Error 1: backoff 5000ms; error 3 (after reset): backoff 5000ms again (not 10000ms)
    assert.equal(sleepCalls.length, 2);
    assert.equal(sleepCalls[0], 5000, 'first error backoff = 5000ms');
    assert.equal(sleepCalls[1], 5000, 'second error after reset should also be 5000ms (counter reset)');
  });
});

// ---------------------------------------------------------------------------
// At-least-once delivery
// ---------------------------------------------------------------------------

describe('runPollLoop: at-least-once delivery', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-atleastonce-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('re-delivers updates when offset was not advanced (crash simulation)', async () => {
    // Simulates bot that crashed before ack: state has last_update_id=-1 (never advanced).
    // Telegram re-delivers update 99. After processing, offset advances to 99.
    // Next poll uses offset=100 — proving the ack happened only after processing.
    const controller = new AbortController();
    const state = makeState(123, -1);
    const update = {
      update_id: 99,
      message: {
        message_id: 1,
        chat: { id: 9999, type: 'private' }, // wrong chat_id → instant processUpdate return
        date: Math.floor(Date.now() / 1000),
        text: 'hello',
      },
    };

    const calls = setupFetchMock([
      { ok: true, bodyJson: { ok: true, result: [update] } }, // re-delivered update 99
      emptyUpdatesResponse(),                                  // second poll → abort
    ], controller);

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    assert.ok(calls.length >= 2);
    assert.ok(calls[1].url.includes('offset=100'), `second poll should use offset=100, got: ${calls[1].url}`);
  });

  it('advances offset to batch max when multiple updates arrive', async () => {
    const controller = new AbortController();
    const state = makeState(123, -1);
    const makeUpdate = (id: number) => ({
      update_id: id,
      message: {
        message_id: id,
        chat: { id: 9999, type: 'private' }, // wrong chat_id → instant return
        date: Math.floor(Date.now() / 1000),
        text: 'hi',
      },
    });

    const calls = setupFetchMock([
      { ok: true, bodyJson: { ok: true, result: [makeUpdate(99), makeUpdate(100)] } },
      emptyUpdatesResponse(),
    ], controller);

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    assert.ok(calls.length >= 2);
    assert.ok(calls[1].url.includes('offset=101'), `second poll should use offset=101, got: ${calls[1].url}`);

    const raw = await readFile(join(tempDir, 'telegram-bot-state.json'), 'utf8');
    const saved = JSON.parse(raw) as ConversationState;
    assert.equal(saved.last_update_id, 100, 'last_update_id must be 100 (batch max)');
  });

  it('offset still advances when update has no text (skip path)', async () => {
    // processUpdate returns immediately at `if (!msg?.text) return`
    const controller = new AbortController();
    const state = makeState(123, -1);
    const update = {
      update_id: 99,
      message: {
        message_id: 1,
        chat: { id: 123, type: 'private' }, // allowed chat, but no text
        date: Math.floor(Date.now() / 1000),
        // text intentionally absent
      },
    };

    const calls = setupFetchMock([
      { ok: true, bodyJson: { ok: true, result: [update] } },
      emptyUpdatesResponse(),
    ], controller);

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    assert.ok(calls.length >= 2);
    assert.ok(calls[1].url.includes('offset=100'), `second poll should use offset=100, got: ${calls[1].url}`);
  });

});

// ---------------------------------------------------------------------------
// Graceful shutdown: sentinel file
// ---------------------------------------------------------------------------

describe('runPollLoop: graceful shutdown', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-shutdown-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('exits when sentinel file is detected at top of loop', async () => {
    const controller = new AbortController();
    const state = makeState();
    const sentinelPath = join(tempDir, 'telegram-bot.stop');
    let fetchCallCount = 0;

    (globalThis as Record<string, unknown>).fetch = async () => {
      fetchCallCount++;
      // Write sentinel after the first getUpdates call so next iteration detects it
      await writeFile(sentinelPath, 'stop', 'utf8');
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: [] }),
        json: async () => ({ ok: true, result: [] }),
      };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep, sentinelPath);

    assert.equal(fetchCallCount, 1, 'should stop after exactly one poll (sentinel found on next iteration)');
    assert.ok(!controller.signal.aborted, 'AbortController must not be aborted — sentinel drove the shutdown');
  });

  it('exits immediately when sentinel already exists before first poll', async () => {
    const controller = new AbortController();
    const state = makeState();
    const sentinelPath = join(tempDir, 'telegram-bot.stop');
    await writeFile(sentinelPath, 'stop', 'utf8');
    let fetchCallCount = 0;

    (globalThis as Record<string, unknown>).fetch = async () => {
      fetchCallCount++;
      controller.abort();
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: [] }),
        json: async () => ({ ok: true, result: [] }),
      };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep, sentinelPath);

    assert.equal(fetchCallCount, 0, 'fetch must not be called when sentinel already exists');
  });

  it('does not count AbortError as a consecutive error (no backoff on graceful abort)', async () => {
    const controller = new AbortController();
    const sleepCalls: number[] = [];
    const trackingSleep = async (ms: number) => { sleepCalls.push(ms); };

    (globalThis as Record<string, unknown>).fetch = async () => {
      controller.abort();
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    };

    await runPollLoop('token', [123], makeState(), {}, controller.signal, trackingSleep);

    assert.equal(sleepCalls.length, 0, 'AbortError must not trigger backoff sleep');
  });
});

// ---------------------------------------------------------------------------
// Parallel processing: cross-topic concurrency
// ---------------------------------------------------------------------------

describe('runPollLoop: parallel processing', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-parallel-'));
    process.env.PA_HOME = tempDir;
    // /default calls saveTopicDefault() which reads config.yaml; without it
    // processUpdate throws ENOENT (swallowed by the loop) and never sends.
    await writeFile(join(tempDir, 'config.yaml'), JSON.stringify({ workers: [{ name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e 0' }] }), 'utf8');
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('poll continues immediately — second getUpdates fires before sendMessage resolves', async () => {
    // Verifies non-blocking design: after receiving a batch, the loop immediately
    // fetches the next batch without waiting for processUpdate to complete.
    // Uses /default (skipWorker=true path) to reach sendMessage without LLM dispatch.
    const controller = new AbortController();
    const state = makeState(123, -1);

    const update = {
      update_id: 99,
      message: {
        message_id: 1,
        chat: { id: 123, type: 'private' }, // allowed chat
        date: Math.floor(Date.now() / 1000),
        text: '/default',
      },
    };

    const urlOrder: string[] = [];
    let getUpdatesCallCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      urlOrder.push(url as string);

      if ((url as string).includes('getUpdates')) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [update] }),
            json: async () => ({ ok: true, result: [update] }),
          };
        }
        // Second getUpdates: abort (loop exits, drain begins) and return empty
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }

      // setMessageReaction, sendMessage, setWebhook, etc.
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const getUpdatesIndices = urlOrder
      .map((u, i) => u.includes('getUpdates') ? i : -1)
      .filter(i => i >= 0);
    const sendMessageIndex = urlOrder.findIndex(u => u.includes('sendMessage'));

    assert.ok(getUpdatesIndices.length >= 2, `expected 2+ getUpdates calls, got ${getUpdatesIndices.length}`);
    assert.ok(sendMessageIndex >= 0, 'sendMessage must have been called');
    assert.ok(
      getUpdatesIndices[1] < sendMessageIndex,
      `second getUpdates (call order ${getUpdatesIndices[1]}) must precede sendMessage (call order ${sendMessageIndex}); full order: ${urlOrder.map(u => u.split('/').pop()?.split('?')[0]).join(', ')}`
    );
  });

  it('graceful shutdown drains in-flight processUpdate before returning', async () => {
    // Verifies that runPollLoop waits for in-flight processUpdate calls to complete
    // before returning, even after the abort signal fires.
    const controller = new AbortController();
    const state = makeState(123, -1);

    const update = {
      update_id: 99,
      message: {
        message_id: 1,
        chat: { id: 123, type: 'private' }, // allowed chat
        date: Math.floor(Date.now() / 1000),
        text: '/model claude',
      },
    };

    // Deferred promise that controls when sendMessage resolves
    let releaseSendMessage!: () => void;
    const sendMessageGate = new Promise<void>(resolve => { releaseSendMessage = resolve; });

    let getUpdatesCallCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [update] }),
            json: async () => ({ ok: true, result: [update] }),
          };
        }
        // Second getUpdates: abort → loop exits into drain phase
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }

      if ((url as string).includes('sendMessage')) {
        // Block until the test releases — keeps processUpdate in flight
        await sendMessageGate;
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 2 } }),
          json: async () => ({ ok: true, result: { message_id: 2 } }),
        };
      }

      // setMessageReaction etc.
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    let loopDone = false;
    const loopPromise = runPollLoop('token', [123], state, {}, controller.signal, fastSleep)
      .then(() => { loopDone = true; });

    // Yield enough event-loop cycles for the loop to abort, enter drain phase,
    // and for processUpdate to reach the blocked sendMessage call.
    // Each setImmediate yields one poll+check cycle, allowing I/O callbacks to fire.
    for (let i = 0; i < 10; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    assert.equal(loopDone, false, 'runPollLoop must not return while processUpdate is in flight (blocked at sendMessage)');

    // Release sendMessage — processUpdate can now complete
    releaseSendMessage();

    await loopPromise;
    assert.equal(loopDone, true, 'runPollLoop must return after processUpdate completes');
  });

  it('uses timeout=0 in getUpdates URL when updates are in-flight', async () => {
    // Verifies that the poll loop switches to short-poll (timeout=0) when
    // processUpdate is in flight, to avoid holding a long-lived connection
    // that would contend with sendTyping calls.
    const controller = new AbortController();
    const state = makeState(123, -1);

    const update = {
      update_id: 99,
      message: {
        message_id: 1,
        chat: { id: 123, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/model claude',
      },
    };

    // sendMessage gate: keeps processUpdate in flight so the second getUpdates
    // fires while inFlight.size > 0
    let releaseSendMessage!: () => void;
    const sendMessageGate = new Promise<void>(resolve => { releaseSendMessage = resolve; });

    const getUpdatesUrls: string[] = [];
    let getUpdatesCallCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesUrls.push(url as string);
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [update] }),
            json: async () => ({ ok: true, result: [update] }),
          };
        }
        // Second getUpdates fires while sendMessage is still blocked → abort
        controller.abort();
        releaseSendMessage();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }

      if ((url as string).includes('sendMessage')) {
        await sendMessageGate;
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 2 } }),
          json: async () => ({ ok: true, result: { message_id: 2 } }),
        };
      }

      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    assert.ok(getUpdatesUrls.length >= 2, `expected 2+ getUpdates calls, got ${getUpdatesUrls.length}`);
    assert.ok(
      getUpdatesUrls[0].includes('timeout=30'),
      `first getUpdates (idle) must use timeout=30; got: ${getUpdatesUrls[0]}`
    );
    assert.ok(
      getUpdatesUrls[1].includes('timeout=0'),
      `second getUpdates (in-flight) must use timeout=0; got: ${getUpdatesUrls[1]}`
    );
  });

  it('sleeps 500ms after empty short-poll when in-flight', async () => {
    // Verifies that when getUpdates returns empty during active processing,
    // the loop sleeps 500ms before the next short-poll (avoids hammering Telegram).
    const controller = new AbortController();
    const state = makeState(123, -1);

    const update = {
      update_id: 99,
      message: {
        message_id: 1,
        chat: { id: 123, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/model claude',
      },
    };

    let releaseSendMessage!: () => void;
    const sendMessageGate = new Promise<void>(resolve => { releaseSendMessage = resolve; });

    const sleepCalls: number[] = [];
    const trackingSleep = async (ms: number): Promise<void> => { sleepCalls.push(ms); };

    let getUpdatesCallCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          // First call: returns the update, triggers processUpdate
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [update] }),
            json: async () => ({ ok: true, result: [update] }),
          };
        }
        if (getUpdatesCallCount === 2) {
          // Second call: empty — should trigger 500ms sleep
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [] }),
            json: async () => ({ ok: true, result: [] }),
          };
        }
        // Third call: abort and release sendMessage
        controller.abort();
        releaseSendMessage();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }

      if ((url as string).includes('sendMessage')) {
        await sendMessageGate;
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 2 } }),
          json: async () => ({ ok: true, result: { message_id: 2 } }),
        };
      }

      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, trackingSleep);

    assert.ok(
      sleepCalls.includes(500),
      `expected a 500ms sleep call when in-flight + empty response; got sleepCalls=${JSON.stringify(sleepCalls)}`
    );
  });
});

// ---------------------------------------------------------------------------
// Model expiry: pin expiry notification
// ---------------------------------------------------------------------------

describe('runPollLoop: model expiry sweep', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-expiry-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('pins a midnight-reset status card during the startup sweep without an inbound message', async () => {
    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const topicState = {
      chat_id: 123,
      thread_id: 0,
      turns: [],
      preferred_worker: 'agy',
      preferred_worker_set_at: yesterday,
      pinned_status_message_id: 42,
    };
    await writeFile(topicStateFile, JSON.stringify(topicState), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);

    const calledUrls: string[] = [];
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      calledUrls.push(url as string);

      if ((url as string).includes('getUpdates')) {
        getUpdatesCount++;
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }

      // sendMessage returns a message_id so pinChatMessage can be called
      if ((url as string).includes('sendMessage')) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 99 } }),
          json: async () => ({ ok: true, result: { message_id: 99 } }),
        };
      }

      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    // A pin already exists (pinned_status_message_id: 42), so refreshPinnedStatusCardInPlace
    // edits it in place rather than unpin+repin — deliberate since the 2026-08-25 "bp-retry"
    // fix (main.ts, refreshPinnedStatusCardInPlace) that stopped stranding users mid-navigation
    // through a control-card submenu on the same message id. unpin/pin only fire when there is
    // no existing pin (covered separately by the AI-026 failover test).
    const editCalls = calledUrls.filter(u => u.includes('/editMessageText'));
    const unpinCalls = calledUrls.filter(u => u.includes('unpinChatMessage'));
    const pinCalls = calledUrls.filter(u => u.includes('/pinChatMessage'));

    assert.strictEqual(editCalls.length, 1, 'should edit the existing pin in place with the midnight-reset status');
    assert.strictEqual(unpinCalls.length, 0, 'an in-place edit must not unpin the existing indicator');
    assert.strictEqual(pinCalls.length, 0, 'an in-place edit must not create a new pin');

    const saved = JSON.parse(await readFile(topicStateFile, 'utf8')) as ConversationState;
    assert.equal(saved.preferred_worker, undefined);
    assert.equal(saved.model_status?.reason_code, 'midnight_reset');
    assert.deepEqual(saved.turns, []);
  });

  it('skips topic-state files whose chatId is not in the configured allow-list', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const allowedFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    const foreignFile = join(tempDir, 'telegram-bot-topic-999_5.json');
    const allowedState = {
      chat_id: 123, thread_id: 0, turns: [],
      preferred_worker: 'agy', preferred_worker_set_at: yesterday,
    };
    const foreignState = {
      chat_id: 999, thread_id: 5, turns: [],
      preferred_worker: 'agy', preferred_worker_set_at: yesterday,
    };
    await writeFile(allowedFile, JSON.stringify(allowedState), 'utf8');
    await writeFile(foreignFile, JSON.stringify(foreignState), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);
    const sendMessageBodies: string[] = [];

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      if ((url as string).includes('getUpdates')) {
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }
      if ((url as string).includes('sendMessage')) {
        if (opts?.body) sendMessageBodies.push(String(opts.body));
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 50 } }),
          json: async () => ({ ok: true, result: { message_id: 50 } }),
        };
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    // Only the allowed topic should have its preferred_worker cleared
    const savedAllowed = JSON.parse(await readFile(allowedFile, 'utf8')) as ConversationState;
    const savedForeign = JSON.parse(await readFile(foreignFile, 'utf8')) as ConversationState;
    assert.equal(savedAllowed.preferred_worker, undefined, 'allowed topic resets');
    assert.equal(savedForeign.preferred_worker, 'agy', 'foreign topic untouched');
    // No sendMessage should target chat 999
    assert.ok(!sendMessageBodies.some((b) => b.includes('"chat_id":999')), 'no sendMessage to foreign chat');
  });

  it('continues sweeping other topics when one topic-state file is corrupt', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const corruptFile = join(tempDir, 'telegram-bot-topic-123_1.json');
    const validFile = join(tempDir, 'telegram-bot-topic-123_2.json');
    const validState = {
      chat_id: 123, thread_id: 2, turns: [],
      preferred_worker: 'agy', preferred_worker_set_at: yesterday,
    };
    await writeFile(corruptFile, '{ "chat_id": 123, "thread_id": 1, broken json', 'utf8');
    await writeFile(validFile, JSON.stringify(validState), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }
      if ((url as string).includes('sendMessage')) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 60 } }),
          json: async () => ({ ok: true, result: { message_id: 60 } }),
        };
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const savedValid = JSON.parse(await readFile(validFile, 'utf8')) as ConversationState;
    assert.equal(savedValid.preferred_worker, undefined, 'valid topic still processed despite corrupt sibling');
    assert.equal(savedValid.model_status?.reason_code, 'midnight_reset');
  });

  it('skips a topic idle beyond TOPIC_SWEEP_STALE_MS (7 days) — its expired override is left untouched — while a fresh topic in the same sweep is still processed normally', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const freshFile = join(tempDir, 'telegram-bot-topic-123_1.json');
    const staleFile = join(tempDir, 'telegram-bot-topic-123_2.json');
    const sharedState = {
      chat_id: 123, thread_id: 0, turns: [],
      preferred_worker: 'agy', preferred_worker_set_at: yesterday,
    };
    await writeFile(freshFile, JSON.stringify({ ...sharedState, thread_id: 1 }), 'utf8');
    await writeFile(staleFile, JSON.stringify({ ...sharedState, thread_id: 2 }), 'utf8');

    // Backdate ONLY the stale file's mtime past the 7-day threshold. The
    // fresh file keeps its just-written (now) mtime.
    const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(staleFile, longAgo, longAgo);

    const controller = new AbortController();
    const state = makeState(123, -1);

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }
      if ((url as string).includes('sendMessage')) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 70 } }),
          json: async () => ({ ok: true, result: { message_id: 70 } }),
        };
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const savedFresh = JSON.parse(await readFile(freshFile, 'utf8')) as ConversationState;
    const savedStale = JSON.parse(await readFile(staleFile, 'utf8')) as ConversationState;

    assert.equal(savedFresh.preferred_worker, undefined, 'fresh topic still gets its expired override cleared');
    assert.equal(savedFresh.model_status?.reason_code, 'midnight_reset');

    assert.equal(savedStale.preferred_worker, 'agy', 'stale topic is skipped — override left untouched by the sweep');
    assert.equal(savedStale.preferred_worker_set_at, yesterday, 'stale topic file is not rewritten at all');
    assert.equal(savedStale.model_status, undefined, 'sweep never even loaded/hydrated the stale topic');
  });
});

// ---------------------------------------------------------------------------
// Dynamic Pinned Message Updates (AI-026)
// ---------------------------------------------------------------------------

describe('runPollLoop: dynamic pin update on failover (AI-026)', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-failover-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('posts and pins a fresh status card on failover even when no pin exists yet', async () => {
    // Use agy as the first worker because its rate-limit classifier uses text matching
    // (looks for "429" in stderr), so we can trigger it reliably without JSONL session files.
    const configPath = join(tempDir, 'config.yaml');
    // Write helper scripts to temp dir to avoid shell quoting complexity
    const failScript = join(tempDir, 'fail-worker.mjs');
    const succeedScript = join(tempDir, 'succeed-worker.mjs');
    await writeFile(failScript, 'process.stderr.write("RESOURCE_EXHAUSTED"); process.exit(1);\n', 'utf8');
    await writeFile(succeedScript, 'process.stdout.write("zclaude response"); process.exit(0);\n', 'utf8');

    await writeFile(configPath, `
workers:
  - name: agy
    command: node
    args: ["${failScript.replace(/\\/g, '/')}"]
    check: node -e "process.exit(0)"
    rate_limit_patterns: ["RESOURCE_EXHAUSTED"]
  - name: zclaude
    command: node
    args: ["${succeedScript.replace(/\\/g, '/')}"]
    check: node -e "process.exit(0)"
topic_defaults:
  "123_0": "agy"
`);

    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    const topicState = {
      chat_id: 123,
      thread_id: 0,
      turns: [],
    };
    await writeFile(topicStateFile, JSON.stringify(topicState), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);

    const update1 = {
      update_id: 1,
      message: { message_id: 10, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'hello' },
    };

    let getUpdatesCount = 0;
    const fetchLog: string[] = [];

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      fetchLog.push(url + (opts?.body ? ' ' + opts.body : ''));
      if (url.includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [update1] }), json: async () => ({ ok: true, result: [update1] }) };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if (url.includes('sendMessage')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 55 } }),
          json: async () => ({ ok: true, result: { message_id: 55 } }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const editPinCalls = fetchLog.filter(u => u.includes('/editMessageText'));
    const pinCalls = fetchLog.filter(u => u.includes('/pinChatMessage'));
    assert.strictEqual(editPinCalls.length, 0, 'failover should not edit an existing pin in place');
    assert.strictEqual(pinCalls.length, 1, 'failover should create and pin a fresh status card');
    assert.ok(fetchLog.some((entry) => entry.includes('Topic Status') && entry.includes('Temporary failover')), 'status card should mention the failover reason');

    const saved = JSON.parse(await readFile(topicStateFile, 'utf8')) as ConversationState;
    assert.equal(saved.model_status?.current_worker, 'zclaude');
    assert.equal(saved.model_status?.reason_code, 'failover');
    assert.ok(typeof saved.pinned_status_message_id === 'number');
    assert.ok(saved.turns.every((turn) => !turn.text.startsWith('📌')), 'status cards must stay out of conversation history');
  });
});

describe('runPollLoop: /model status cards', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-model-card-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('treats /model <effective-default> as a default-selection status update without creating an override', async () => {
    const configPath = join(tempDir, 'config.yaml');
    await writeFile(configPath, `
workers:
  - name: claude
    command: node
    args: ["-e", "process.stdout.write('ok')"]
    check: node -e "process.exit(0)"
    rate_limit_patterns: []
  - name: agy
    command: node
    args: ["-e", "process.stdout.write('ok')"]
    check: node -e "process.exit(0)"
    rate_limit_patterns: []
topic_defaults:
  "123_0": "claude"
`, 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
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
                text: '/model claude',
              },
            }] }),
            json: async () => ({ ok: true, result: [{
              update_id: 1,
              message: {
                message_id: 10,
                chat: { id: 123, type: 'private' },
                date: Math.floor(Date.now() / 1000),
                text: '/model claude',
              },
            }] }),
          };
        }
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: { message_id: 77 } }),
        json: async () => ({ ok: true, result: { message_id: 77 } }),
      };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const saved = JSON.parse(await readFile(join(tempDir, 'telegram-bot-topic-123_0.json'), 'utf8')) as ConversationState;
    assert.equal(saved.preferred_worker, undefined);
    assert.equal(saved.preferred_worker_set_at, undefined);
    assert.equal(saved.model_status?.reason_code, 'user_selected_default');
    // Local commands DO get their reply recorded as an assistant turn (same convention
    // proven elsewhere, e.g. the historical-question test's "2 seeded + 1 assistant
    // reply" count) — this test originally asserted only 1 turn (the user command),
    // which never matched real behavior; fixed to the actual, correct 2-turn shape.
    assert.equal(saved.turns.length, 2, 'user command + its local assistant confirmation should remain in topic history');
    assert.equal(saved.turns[0].text, '/model claude');
    assert.equal(saved.turns[1].role, 'assistant');
    assert.ok(saved.turns.every((turn) => !turn.text.startsWith('📌')), 'status cards must stay out of conversation history');
  });
});


describe('runPollLoop: DLQ', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-dlq-'));
    process.env.PA_HOME = tempDir;
    await writeFile(join(tempDir, 'config.yaml'), JSON.stringify({ workers: [{ name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e 0' }] }), 'utf8');
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  /** URL-aware fetch: sendMessage fails with Forbidden; everything else succeeds. */
  function setupUrlAwareFetch(controller: AbortController): void {
    let getUpdatesCount = 0;
    // Use /reset: it sets a text `response` that goes through the reply path
    // (so a failed send is DLQ'd). /default only updates the pinned card, which
    // is not DLQ-able, so it can't exercise the reply-failure → DLQ path.
    const update = {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 123, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/reset',
      },
    };

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [update] }),
            json: async () => ({ ok: true, result: [update] }),
          };
        }
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }

      if ((url as string).includes('sendMessage')) {
        return {
          ok: false, status: 400,
          text: async () => 'Forbidden',
          json: async () => ({ ok: false }),
        };
      }

      // setMessageReaction, sendChatAction, etc.
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };
  }

  it('writes to DLQ when sendMessage fails', async () => {
    const controller = new AbortController();
    setupUrlAwareFetch(controller);

    await runPollLoop('token', [123], makeState(), {}, controller.signal, fastSleep);

    const dlqPath = join(tempDir, 'telegram-dlq.jsonl');
    const raw = await readFile(dlqPath, 'utf8');
    const entry = JSON.parse(raw.trim());
    assert.equal(entry.chatId, 123);
    assert.ok(typeof entry.text === 'string' && entry.text.length > 0, 'DLQ entry must have text');
    assert.equal(entry.updateId, 1);
  });

  it('does not write to DLQ when sendMessage succeeds', async () => {
    const controller = new AbortController();
    const update = {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 123, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/default',
      },
    };

    let getUpdatesCount = 0;
    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [update] }),
            json: async () => ({ ok: true, result: [update] }),
          };
        }
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } }),
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      };
    };

    await runPollLoop('token', [123], makeState(), {}, controller.signal, fastSleep);

    const dlqPath = join(tempDir, 'telegram-dlq.jsonl');
    await assert.rejects(
      () => stat(dlqPath),
      /ENOENT/,
      'DLQ file must not exist when sendMessage succeeds',
    );
  });

  it('does not addTurn when sendMessage fails', async () => {
    const controller = new AbortController();
    setupUrlAwareFetch(controller);

    await runPollLoop('token', [123], makeState(), {}, controller.signal, fastSleep);

    // Topic state file should have no assistant turns
    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    let topicState: { turns?: Array<{ role: string }> } = {};
    try {
      const raw = await readFile(topicStateFile, 'utf8');
      topicState = JSON.parse(raw);
    } catch {
      // File may not exist if no turns were written — that's fine
    }
    const assistantTurns = (topicState.turns ?? []).filter(t => t.role === 'assistant');
    assert.equal(assistantTurns.length, 0, 'no assistant turn must be recorded when sendMessage fails');
  });
});

// ---------------------------------------------------------------------------
// restart_bot: sentinel ordering regression
// ---------------------------------------------------------------------------
// Note: Testing the ordering invariant (sentinel written AFTER sendMessage)
// requires mocking dispatchMessage, which spawns real pa worker processes and
// cannot be intercepted via fetch. The ordering is enforced by source structure
// in main.ts (sentinel write follows saveTopicState which follows sendMessage).
// The applyMetaActions contract (restartBot=true when restart_bot action fires)
// is covered by logic.test.ts. This block covers the regression: normal message
// paths must never write the sentinel.
// ---------------------------------------------------------------------------

describe('runPollLoop: restart_bot sentinel', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-sentinel-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('does not write sentinel for normal /model switch (no restart_bot action)', async () => {
    // /model switch is handled by handleModelSwitch (skipWorker=true) and never
    // produces a PA_META restart_bot action. Sentinel must not be written.
    const controller = new AbortController();
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
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
                text: '/model claude',
              },
            }]}),
            json: async () => ({ ok: true, result: [] }),
          };
        }
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }
      // sendMessage, sendChatAction, setMessageReaction, pinChatMessage, etc.
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } }),
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      };
    };

    await runPollLoop('token', [123], makeState(), {}, controller.signal, fastSleep);

    const sentinelPath = join(tempDir, 'telegram-bot.stop');
    await assert.rejects(
      () => stat(sentinelPath),
      /ENOENT/,
      'sentinel must not be written for non-restart_bot paths',
    );
  });
});

// ---------------------------------------------------------------------------
// processUpdate error handling: rejections caught, poll loop continues
// ---------------------------------------------------------------------------

describe('runPollLoop: processUpdate error handling', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;
  const savedPaHome = process.env.PA_HOME;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-errors-'));
  });

  afterEach(async () => {
    process.env.PA_HOME = savedPaHome;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('processUpdate rejection is caught — poll loop continues and does not throw', async () => {
    // Force processUpdate to reject by pointing PA_HOME at a non-existent path.
    // blackboard.acquireLock → ensureFile → writeFile throws ENOENT because the
    // directory does not exist. This rejection escapes processUpdate's inner
    // try/catch (which only wraps dispatchMessage). Without the .catch() on the
    // promise in the poll loop, this would surface as an unhandled rejection.
    process.env.PA_HOME = join(tempDir, 'does-not-exist');

    const controller = new AbortController();
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          // Return one real message from an allowed chat
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [{
              update_id: 200,
              message: {
                message_id: 1,
                chat: { id: 123, type: 'private' },
                date: Math.floor(Date.now() / 1000),
                text: 'hello',
              },
            }]}),
            json: async () => ({ ok: true, result: [] }),
          };
        }
        // Second poll: abort so the loop exits cleanly
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    // Use tempDir (valid path) for the state file; PA_HOME is what blackboard uses
    const state = makeState(123, -1);
    // Must not throw — rejection is caught and logged by the .catch() handler
    await assert.doesNotReject(
      () => runPollLoop('token', [123], state, {}, controller.signal, fastSleep),
    );
    assert.ok(getUpdatesCount >= 2, 'poll loop must have continued after the rejected processUpdate');
  });

  it('setMessageReaction failure does not reject processUpdate', async () => {
    // Use a valid PA_HOME so blackboard works normally; only fail the reaction call.
    process.env.PA_HOME = tempDir;
    const controller = new AbortController();
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      // Fail specifically the setMessageReaction call
      if ((url as string).includes('setMessageReaction')) {
        return {
          ok: false, status: 500,
          text: async () => '{"ok":false,"description":"Bad Request"}',
          json: async () => ({ ok: false }),
        };
      }
      if ((url as string).includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [{
              update_id: 201,
              message: {
                message_id: 2,
                chat: { id: 456, type: 'private' }, // NOT in allowed list — processUpdate returns early after reaction
                date: Math.floor(Date.now() / 1000),
                text: 'ping',
              },
            }]}),
            json: async () => ({ ok: true, result: [] }),
          };
        }
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    const state = makeState(456, -1);
    await assert.doesNotReject(
      () => runPollLoop('token', [456], state, {}, controller.signal, fastSleep),
    );
  });
});

// ---------------------------------------------------------------------------
// extractReplyContext: partial quote > full reply text > caption
// ---------------------------------------------------------------------------

describe('extractReplyContext', { concurrency: 1 }, () => {
  it('returns undefined when no reply or quote', () => {
    assert.equal(extractReplyContext({}), undefined);
  });

  it('returns full reply text when no quote', () => {
    assert.equal(
      extractReplyContext({ reply_to_message: { text: 'full message' } }),
      'full message',
    );
  });

  it('returns caption when reply has no text', () => {
    assert.equal(
      extractReplyContext({ reply_to_message: { caption: 'photo caption' } }),
      'photo caption',
    );
  });

  it('prefers partial quote over full reply text', () => {
    assert.equal(
      extractReplyContext({
        quote: { text: 'partial selection' },
        reply_to_message: { text: 'full message' },
      }),
      'partial selection',
    );
  });

  it('prefers partial quote over reply caption', () => {
    assert.equal(
      extractReplyContext({
        quote: { text: 'highlighted bit' },
        reply_to_message: { caption: 'photo caption' },
      }),
      'highlighted bit',
    );
  });

  it('falls back to reply text when quote text is empty string', () => {
    assert.equal(
      extractReplyContext({
        quote: { text: '' },
        reply_to_message: { text: 'full message' },
      }),
      'full message',
    );
  });
});

// ---------------------------------------------------------------------------
// B4: pending description approval flow (processUpdate integration)
// ---------------------------------------------------------------------------

describe('runPollLoop: B4 pending description approval', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-b4-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  async function runB4(text: string, topicStateData: object): Promise<{ fetchLog: string[] }> {
    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    await writeFile(topicStateFile, JSON.stringify(topicStateData), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);
    const update = {
      update_id: 1,
      message: { message_id: 10, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text },
    };

    const fetchLog: string[] = [];
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
      fetchLog.push(url + (opts?.body ? ' ' + opts.body : ''));
      if ((url as string).includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [update] }), json: async () => ({ ok: true, result: [update] }) };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 99 } }), json: async () => ({ ok: true, result: { message_id: 99 } }) };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);
    return { fetchLog };
  }

  it('yes + pd.text → sends "Description set." and clears pendingDescription', async () => {
    const expiresAt = Date.now() + 30 * 60 * 1000;
    const { fetchLog } = await runB4('yes', {
      chat_id: 123, thread_id: 0, turns: [],
      pendingDescription: { text: 'Discussions about daily-briefings', proposedAt: new Date().toISOString(), expiresAt },
    });
    const sendCalls = fetchLog.filter(u => u.includes('sendMessage'));
    assert.ok(sendCalls.length > 0, 'sendMessage must have been called');
    assert.ok(sendCalls.some(b => b.includes('Description set')), 'response must confirm description was set');
    const raw = await readFile(join(tempDir, 'telegram-bot-topic-123_0.json'), 'utf8');
    const saved = JSON.parse(raw);
    assert.equal(saved.pendingDescription, undefined, 'pendingDescription must be cleared after yes');
  });

  it('yes + empty pd.text → sends prompt to type description and keeps pendingDescription', async () => {
    const expiresAt = Date.now() + 30 * 60 * 1000;
    const { fetchLog } = await runB4('yes', {
      chat_id: 123, thread_id: 0, turns: [],
      pendingDescription: { text: '', proposedAt: new Date().toISOString(), expiresAt },
    });
    const sendCalls = fetchLog.filter(u => u.includes('sendMessage'));
    assert.ok(sendCalls.some(b => b.includes('type the description')), 'must prompt user to type description');
    const raw = await readFile(join(tempDir, 'telegram-bot-topic-123_0.json'), 'utf8');
    const saved = JSON.parse(raw);
    assert.ok(saved.pendingDescription, 'pendingDescription must be kept so next long message is captured');
  });

  it('long reply when pd.text is empty → saves user text as description', async () => {
    const expiresAt = Date.now() + 30 * 60 * 1000;
    const userDescription = 'Research notes and links for the data-platform project partnership';
    const { fetchLog } = await runB4(userDescription, {
      chat_id: 123, thread_id: 0, turns: [],
      pendingDescription: { text: '', proposedAt: new Date().toISOString(), expiresAt },
    });
    const sendCalls = fetchLog.filter(u => u.includes('sendMessage'));
    assert.ok(sendCalls.some(b => b.includes('Description set')), 'must confirm description was set');
    const raw = await readFile(join(tempDir, 'telegram-bot-topic-123_0.json'), 'utf8');
    const saved = JSON.parse(raw);
    assert.equal(saved.pendingDescription, undefined, 'pendingDescription must be cleared');
  });

  it('no → sends "OK, skipped." and clears pendingDescription', async () => {
    const expiresAt = Date.now() + 30 * 60 * 1000;
    const { fetchLog } = await runB4('no', {
      chat_id: 123, thread_id: 0, turns: [],
      pendingDescription: { text: 'some suggestion', proposedAt: new Date().toISOString(), expiresAt },
    });
    const sendCalls = fetchLog.filter(u => u.includes('sendMessage'));
    assert.ok(sendCalls.some(b => b.includes('OK, skipped')), 'must respond with OK skipped');
    const raw = await readFile(join(tempDir, 'telegram-bot-topic-123_0.json'), 'utf8');
    const saved = JSON.parse(raw);
    assert.equal(saved.pendingDescription, undefined, 'pendingDescription must be cleared after no');
  });
});

// ---------------------------------------------------------------------------
// runPollLoop: branch/merge commands
// ---------------------------------------------------------------------------

describe('runPollLoop: branch/merge commands', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-branch-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  async function runBranchCmd(
    text: string,
    opts: {
      threadId?: number;
      topicStateData?: object;
      topicNamesData?: object;
      branchIndexData?: object;
    } = {}
  ): Promise<{ fetchLog: Array<{ url: string; body: string }> }> {
    const threadId = opts.threadId ?? 0;
    const topicStateFile = join(tempDir, `telegram-bot-topic-123_${threadId}.json`);
    if (opts.topicStateData) {
      await writeFile(topicStateFile, JSON.stringify(opts.topicStateData), 'utf8');
    }
    if (opts.topicNamesData) {
      await writeFile(join(tempDir, 'telegram-topic-names.json'), JSON.stringify(opts.topicNamesData), 'utf8');
    }
    if (opts.branchIndexData) {
      await writeFile(join(tempDir, 'topic-branches.json'), JSON.stringify(opts.branchIndexData), 'utf8');
    }

    const controller = new AbortController();
    const state = makeState(123, -1);
    const update = {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text,
        message_thread_id: threadId || undefined,
      },
    };

    const fetchLog: Array<{ url: string; body: string }> = [];
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
      fetchLog.push({ url, body: opts?.body ?? '' });
      if ((url as string).includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [update] }), json: async () => ({ ok: true, result: [update] }) };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if ((url as string).includes('createForumTopic')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_thread_id: 999 } }), json: async () => ({ ok: true, result: { message_thread_id: 999 } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 99 } }), json: async () => ({ ok: true, result: { message_id: 99 } }) };
    };

    // Load branch index from pre-seeded file so the in-memory index matches
    const branchIndex = await loadBranches();

    const topicNames = opts.topicNamesData
      ? (() => {
          const m = new Map<string, Map<number, { name: string; description?: string }>>();
          for (const [cid, threads] of Object.entries(opts.topicNamesData as Record<string, Record<string, string | { name: string; description?: string }>>)) {
            const inner = new Map<number, { name: string; description?: string }>();
            for (const [tid, entry] of Object.entries(threads)) {
              // 2026-09-01 dark-file recheck: entry can be a plain name string OR
              // an already-shaped {name, description} object (tests seeding a
              // parent description). Re-wrapping the object case as `{ name:
              // entry }` nested the whole object under `.name`, so getTopicName()
              // returned an object where callers expect a string — reproduced the
              // `(parentName || "parent").replace is not a function` crash below.
              inner.set(parseInt(tid, 10), typeof entry === 'string' ? { name: entry } : entry);
            }
            m.set(cid, inner);
          }
          return m;
        })()
      : new Map();

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep, undefined, topicNames, branchIndex);
    return { fetchLog };
  }

  it('/branch auto-creates topic, registers name, links as child', async () => {
    const { fetchLog } = await runBranchCmd('/branch api-refactor', {
      topicNamesData: { '123': { '0': 'General' } },
    });
    // Must call createForumTopic
    const createCalls = fetchLog.filter(e => e.url.includes('createForumTopic'));
    assert.ok(createCalls.length > 0, 'createForumTopic must have been called');
    assert.ok(createCalls[0].body.includes('api'), 'topic name must be in createForumTopic body');

    // Must send confirmation in the new topic (thread 999)
    const sendCalls = fetchLog.filter(e => e.url.includes('sendMessage'));
    assert.ok(sendCalls.length >= 2, 'sendMessage must be called at least twice (new topic + parent topic)');
    // One sendMessage should target thread 999 (the new topic)
    const newTopicMsg = sendCalls.find(e => e.body.includes('999'));
    assert.ok(newTopicMsg, 'must send message to new topic thread');
    // Another sendMessage should confirm creation in the parent topic
    const parentMsg = sendCalls.find(e => !e.body.includes('999'));
    assert.ok(parentMsg, 'must send confirmation to parent topic');

    // Verify topic state was written with ancestry
    const raw = await readFile(join(tempDir, 'telegram-bot-topic-123_999.json'), 'utf8');
    const saved = JSON.parse(raw);
    assert.ok(saved.ancestry, 'ancestry must be set on branch topic state');
    assert.equal(saved.ancestry.branchName, 'api-refactor');
    assert.equal(saved.ancestry.parentThreadId, 0);

    // Verify topic-branches.json was written
    const branchesRaw = await readFile(join(tempDir, 'topic-branches.json'), 'utf8');
    const branches = JSON.parse(branchesRaw);
    assert.ok(branches['123']?.['999'], 'branch entry must exist in topic-branches.json');
  });

  it('/branch with prompt auto-creates topic, records user turn, and auto-sets description', async () => {
    const { fetchLog } = await runBranchCmd('/branch auth-migration refactor auth endpoints to use JWT tokens', {
      topicNamesData: { '123': { '0': { name: 'General', description: 'General channel' } } },
    });
    const createCalls = fetchLog.filter(e => e.url.includes('createForumTopic'));
    assert.ok(createCalls.length > 0, 'createForumTopic must have been called');

    const raw = await readFile(join(tempDir, 'telegram-bot-topic-123_999.json'), 'utf8');
    const saved = JSON.parse(raw);
    assert.ok(saved.ancestry, 'ancestry must be set on branch topic state');
    assert.equal(saved.ancestry.branchName, 'auth-migration');
    // Prompt should be added as a user turn
    const userTurn = saved.turns.find((t: any) => t.role === 'user');
    assert.ok(userTurn, 'user prompt turn must be recorded');
    assert.equal(userTurn.text, 'refactor auth endpoints to use JWT tokens');

    // Topic description should be saved in telegram-topic-names.json
    const namesRaw = await readFile(join(tempDir, 'telegram-topic-names.json'), 'utf8');
    const topicMap = JSON.parse(namesRaw);
    assert.ok(topicMap['123']?.['999']?.description, 'branch description must be auto-set');
    assert.ok(topicMap['123']['999'].description.includes('JWT') || topicMap['123']['999'].description.includes('auth-migration'), 'description must reflect branch name or prompt');
  });

  it('/child-of valid-parent links topic and writes ancestry + topic-branches.json', async () => {
    // Pre-write parent topic state (thread 100) with some turns
    const parentState = {
      chat_id: 123, thread_id: 100, turns: [
        { role: 'user', text: 'parent turn 1', timestamp: new Date().toISOString() },
      ],
    };
    await writeFile(join(tempDir, 'telegram-bot-topic-123_100.json'), JSON.stringify(parentState), 'utf8');

    const { fetchLog } = await runBranchCmd('/child-of valid-parent', {
      threadId: 200,
      topicStateData: { chat_id: 123, thread_id: 200, turns: [] },
      topicNamesData: { '123': { '100': 'valid-parent', '200': 'feature-x' } },
    });

    const sendCalls = fetchLog.filter(e => e.url.includes('sendMessage'));
    assert.ok(sendCalls.length > 0, 'sendMessage must have been called');
    // Two pre-existing topic-state files (parent thread 100 + this thread 200) each get an
    // ambient startup model-expiry-sweep pin refresh (runExpiredModelOverrideSweep touches
    // every topic missing model_status, per modelStatusNeedsRefresh) before the /child-of
    // reply itself is sent — so the reply is not necessarily sendCalls[0]. hyphens are
    // escaped by sanitizeMdV2; check for unhyphenated parts.
    assert.ok(sendCalls.some(c => c.body.includes('Linked') || c.body.includes('branch')), 'response must confirm parent link');

    // Verify topic state has ancestry set
    const raw = await readFile(join(tempDir, 'telegram-bot-topic-123_200.json'), 'utf8');
    const saved = JSON.parse(raw);
    assert.ok(saved.ancestry, 'ancestry must be set on branch topic state');
    assert.equal(saved.ancestry.parentThreadId, 100);
    assert.equal(saved.ancestry.branchName, 'feature-x');

    // Verify topic-branches.json was written
    const branchesRaw = await readFile(join(tempDir, 'topic-branches.json'), 'utf8');
    const branches = JSON.parse(branchesRaw);
    assert.ok(branches['123']?.['200'], 'branch entry must exist in topic-branches.json');
    assert.equal(branches['123']['200'].parentThreadId, 100);
  });

  it('/merge on linked branch copies turns to parent and sets mergedAt', async () => {
    // Pre-write branch topic state with ancestry + turns
    const branchState = {
      chat_id: 123, thread_id: 200,
      ancestry: { parentChatId: 123, parentThreadId: 100, branchName: 'feature-x' },
      turns: [
        { role: 'assistant', text: '[Branch of: valid-parent]', timestamp: new Date().toISOString(), worker: 'local' },
        { role: 'user', text: 'branch work turn', timestamp: new Date().toISOString() },
        { role: 'assistant', text: 'branch response', timestamp: new Date().toISOString(), worker: 'zclaude' },
      ],
    };
    await writeFile(join(tempDir, 'telegram-bot-topic-123_200.json'), JSON.stringify(branchState), 'utf8');

    // Pre-write parent topic state
    const parentState = { chat_id: 123, thread_id: 100, turns: [] };
    await writeFile(join(tempDir, 'telegram-bot-topic-123_100.json'), JSON.stringify(parentState), 'utf8');

    // Pre-write branch index
    const branchIndex = { '123': { '200': { parentThreadId: 100, branchName: 'feature-x', createdAt: new Date().toISOString() } } };
    await writeFile(join(tempDir, 'topic-branches.json'), JSON.stringify(branchIndex), 'utf8');

    const { fetchLog } = await runBranchCmd('/merge', {
      threadId: 200,
      topicNamesData: { '123': { '100': 'valid-parent', '200': 'feature-x' } },
      branchIndexData: branchIndex,
    });

    const sendCalls = fetchLog.filter(e => e.url.includes('sendMessage'));
    assert.ok(sendCalls.length > 0, 'sendMessage must have been called');
    // Same ambient startup sweep as the /child-of test above: the two pre-existing topics
    // (branch thread 200 + parent thread 100) each get a pin refresh before the /merge
    // reply, so the reply is not necessarily sendCalls[0].
    assert.ok(sendCalls.some(c => c.body.includes('valid-parent') || c.body.includes('Merged')), 'response must mention merge');

    // Verify parent state received branch turns
    const parentRaw = await readFile(join(tempDir, 'telegram-bot-topic-123_100.json'), 'utf8');
    const savedParent = JSON.parse(parentRaw);
    assert.ok(savedParent.turns.some((t: { text: string }) => t.text.startsWith('[Merge from:')), 'parent must have Merge marker turn');
    assert.ok(savedParent.turns.some((t: { text: string }) => t.text === 'branch work turn'), 'parent must have branch turns');

    // Verify branch state has mergedAt
    const branchRaw = await readFile(join(tempDir, 'telegram-bot-topic-123_200.json'), 'utf8');
    const savedBranch = JSON.parse(branchRaw);
    assert.ok(savedBranch.ancestry?.mergedAt, 'branch ancestry must have mergedAt set');

    // Verify topic-branches.json entry was removed
    const branchesRaw = await readFile(join(tempDir, 'topic-branches.json'), 'utf8');
    const branches = JSON.parse(branchesRaw);
    assert.equal(Object.keys(branches).length, 0, 'topic-branches.json must be empty after merge');
  });

  it('/merge on unlinked topic responds with "No parent branch"', async () => {
    const { fetchLog } = await runBranchCmd('/merge', {
      topicStateData: { chat_id: 123, thread_id: 0, turns: [] },
    });
    const sendCalls = fetchLog.filter(e => e.url.includes('sendMessage'));
    assert.ok(sendCalls.length > 0, 'sendMessage must have been called');
    assert.ok(sendCalls[0].body.includes('No parent branch'), 'must explain no parent branch');
  });
});

// ---------------------------------------------------------------------------
// generateDescriptionSuggestion
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-topic serialization
// ---------------------------------------------------------------------------

describe('runPollLoop: per-topic serialization', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-serial-'));
    process.env.PA_HOME = tempDir;
    // /default reads config.yaml (saveTopicDefault) — seed it so processUpdate
    // reaches the pinned-card sendMessage instead of throwing ENOENT.
    await writeFile(join(tempDir, 'config.yaml'), JSON.stringify({ workers: [{ name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e 0' }] }), 'utf8');
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('same-topic updates: second processUpdate does not start until first completes', async () => {
    // 2026-09-01 dark-file recheck → un-skipped 2026-09-02 (AI-171 batch): the
    // serialization assertion this test exists for (sendMessageCountAtGate===1,
    // update2 must not start while update1 is gated) always passed. The trailing
    // count is 3, not 2: runPollLoop's test-mode in-flight drain (main.ts) lets a
    // third, previously-abandoned ambient send (pin/sweep family) complete after
    // the gate — the documented trade-off of draining at loop exit. Serialization
    // itself is unchanged.
    // Verifies that per-topic serialization (topicPending chain) prevents the
    // second message from starting while the first is still in-flight.
    // Strategy: gate the first sendMessage reply; confirm that at gate time,
    // the second sendMessage has NOT been called yet (update2 hasn't started).
    const controller = new AbortController();
    const state = makeState(123, -1);

    // Both updates target the same topic (chatId=123, threadId=0 → key '123_0')
    const update1 = {
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 123, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/default',
      },
    };
    const update2 = {
      update_id: 2,
      message: {
        message_id: 2,
        chat: { id: 123, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/default',
      },
    };

    let sendMessageCallCount = 0;
    let sendMessageCountAtGate = -1;
    let resolveGate!: () => void;
    const gate = new Promise<void>(resolve => { resolveGate = resolve; });
    let gateUsed = false;
    let getUpdatesCallCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          // Return both updates in the same batch
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [update1, update2] }),
            json: async () => ({ ok: true, result: [update1, update2] }),
          };
        }
        // Subsequent polls: abort so loop exits and drains
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }

      if ((url as string).includes('sendMessage')) {
        sendMessageCallCount++;
        if (!gateUsed) {
          gateUsed = true;
          // Yield to the event loop: any concurrent update2 work can run here.
          // With correct serialization, update2 won't have started yet.
          await new Promise(r => setTimeout(r, 20));
          sendMessageCountAtGate = sendMessageCallCount;
          // Block until the test releases the gate
          await gate;
        }
      }

      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: { message_id: 999 } }),
        json: async () => ({ ok: true, result: { message_id: 999 } }),
      };
    };

    // Start the loop without awaiting — we need to interact with it
    const loopDone = runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    // Wait DETERMINISTICALLY for update1 to reach the gate (a fixed sleep
    // flaked under full-suite CPU load: the assert could fire before the
    // first sendMessage even started, reading the -1 sentinel). Poll for the
    // at-gate snapshot instead, up to 10s.
    for (let i = 0; i < 500 && sendMessageCountAtGate === -1; i++) {
      await new Promise(r => setTimeout(r, 20));
    }

    try {
      // With per-topic serialization: update2 has NOT started, so only 1 sendMessage fired
      assert.equal(
        sendMessageCountAtGate,
        1,
        `expected sendMessageCountAtGate=1 (update2 must not have started while update1 is in-flight), got ${sendMessageCountAtGate}`
      );
    } finally {
      // ALWAYS release the gate and drain the loop — an assertion failure
      // that abandons them leaks a zombie poll loop holding the topic-123
      // blackboard lock (with live heartbeats), which then starves every
      // later suite using chatId 123 into 60s lock-waits and cancellations.
      resolveGate();
      await loopDone;
    }

    // 3, not 2 — see the dated comment at the top of this test: the test-mode
    // in-flight drain completes one extra ambient send after the gate.
    assert.equal(sendMessageCallCount, 3, 'both dispatch replies plus one drained ambient send must fire after serialization completes');
  });
});

// ---------------------------------------------------------------------------
// AI-113: the per-topic blackboard lock acquired at the top of processUpdate
// used to be heartbeated once and never again — any dispatch that outlived
// PA_HEARTBEAT_STALE_MS (10 min default) had its lock purged out from under
// it. startLockRenewal (pa/src/blackboard.ts) now keeps that specific
// (resource, 'telegram-bot', contextId) row's heartbeat fresh for the
// lifetime of the dispatch. This test shrinks the TTL and renewal cadence via
// env so it doesn't need to wait out the real 10-minute default.
//
// harvestWindowMs (AI-114) is deliberately NOT asserted here: the real worker
// dispatch path (dispatchMessage → executeWorker) spawns real pa worker
// processes and isn't interceptable via the fetch mock this suite uses (see
// the "restart_bot sentinel" block's note above) — the /default command used
// below takes a skip-worker shortcut that never reaches executeWorker at all.
// Not cheap to assert with this harness; the pa-side tests cover that
// harvestWindowMs → harvestUntil stamping directly.
// ---------------------------------------------------------------------------

describe('runPollLoop: topic lock survives long dispatch (AI-113)', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;
  const savedHeartbeatMs = process.env.PA_HEARTBEAT_STALE_MS;
  const savedRenewIntervalMs = process.env.PA_LOCK_RENEW_INTERVAL_MS;
  const savedGraceMs = process.env.PA_HEARTBEAT_GRACE_MS;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-lock-renew-'));
    process.env.PA_HOME = tempDir;
    // Both startLockRenewal and blackboard.acquireLock read these envs fresh
    // on every call, so shrinking them here (before the loop starts) is
    // enough — no need to wait out the real 10-minute/60-second defaults.
    // 2026-09-01 dark-file recheck: widened from 300/100ms — at those margins
    // this test flaked when run as part of the full 27-suite file (passed
    // isolated, failed in-file), most likely renewal ticks getting delayed by
    // event-loop/timer pressure left over from the ~17 preceding describes in
    // the same process. 1500/200ms keeps the real wait well under a second
    // while giving the 100ms-cadence renewer (now every 200ms) a much wider
    // margin to have ticked several times before the assertion.
    process.env.PA_HEARTBEAT_STALE_MS = '1500';
    process.env.PA_LOCK_RENEW_INTERVAL_MS = '200';
    // A same-day, concurrently-landing fix (pa/src/blackboard.ts classifyLock)
    // added an alive-holder grace window on top of PA_HEARTBEAT_STALE_MS — this
    // test times the bare staleness boundary (no unrenewed row should EVER
    // count as fresh past STALE_MS), so pin grace to 0 to keep exercising the
    // boundary it was written for, matching the precedent set in
    // pa/tests/blackboard.test.ts.
    process.env.PA_HEARTBEAT_GRACE_MS = '0';
    await writeFile(join(tempDir, 'config.yaml'), JSON.stringify({ workers: [{ name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e 0' }] }), 'utf8');
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    if (savedHeartbeatMs === undefined) delete process.env.PA_HEARTBEAT_STALE_MS; else process.env.PA_HEARTBEAT_STALE_MS = savedHeartbeatMs;
    if (savedRenewIntervalMs === undefined) delete process.env.PA_LOCK_RENEW_INTERVAL_MS; else process.env.PA_LOCK_RENEW_INTERVAL_MS = savedRenewIntervalMs;
    if (savedGraceMs === undefined) delete process.env.PA_HEARTBEAT_GRACE_MS; else process.env.PA_HEARTBEAT_GRACE_MS = savedGraceMs;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  // 2026-09-01 dark-file recheck → un-skipped 2026-09-02 (AI-171 batch): passed
  // in isolation but failed in-file ('foreignAcquired' true, expected false).
  // Root cause is test isolation, not the bot: this file's describes share one
  // process and one PA_HOME, and a lock-renewal interval left running past an
  // EARLIER describe's loop exit (the neutered _setExitForTest exit never kills
  // intervals the way production's real process.exit does) kept touching the
  // shared default resource row 'topic-123_0'. Frozen fix: this describe now
  // runs under its OWN topic key — thread 990001, resource 'topic-123_990001' —
  // which no other describe in the file uses, so stranded renewals can never
  // freshen this row. The GRACE_MS=0 pin and widened TTL margins above are
  // unchanged; the production renewal-interval lifecycle is NOT touched here.
  it('a dispatch held in-flight past the (shrunk) heartbeat TTL keeps the topic lock row alive', async () => {
    const controller = new AbortController();
    const state = makeState(123, -1);
    // Unique topic key for this describe (see the un-skip comment above):
    // message_thread_id 990001 → resource row 'topic-123_990001'.
    const resourceId = 'topic-123_990001';

    const update1 = {
      update_id: 1,
      message: { message_id: 1, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/default', message_thread_id: 990001 },
    };

    let sendMessageCallCount = 0;
    let resolveGate!: () => void;
    const gate = new Promise<void>(resolve => { resolveGate = resolve; });
    let gateUsed = false;
    let getUpdatesCallCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [update1] }),
            json: async () => ({ ok: true, result: [update1] }),
          };
        }
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }

      if ((url as string).includes('sendMessage')) {
        sendMessageCallCount++;
        if (!gateUsed) {
          gateUsed = true;
          // Held open by the test until it has finished probing the lock.
          await gate;
        }
      }

      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: { message_id: 999 } }),
        json: async () => ({ ok: true, result: { message_id: 999 } }),
      };
    };

    const loopDone = runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    // Wait deterministically for the dispatch to reach the gate (lock now
    // held, renewal started), up to 10s.
    for (let i = 0; i < 500 && !gateUsed; i++) {
      await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(gateUsed, 'dispatch must have reached the gate (lock acquired) within the wait window');

    try {
      // Real wall-clock wait, well past 2.5x the shrunk TTL (1500ms) — long
      // enough for an un-renewed lock to have gone stale under the pre-fix
      // code, and for the 200ms-cadence renewer to have ticked several times
      // under the fix.
      await new Promise(r => setTimeout(r, 4000));

      // The actual regression check: a foreign acquirer on the same resource
      // must still be blocked. acquireLock purges stale rows as part of this
      // very call, so if the real lock's heartbeat had gone stale (no
      // renewal), this would instead succeed.
      const foreignAcquired = await blackboard.acquireLock(resourceId, 'foreign-agent', 999999, 100, 'foreign-context');
      assert.equal(foreignAcquired, false, 'topic lock row must still be held (unpurged) after outlasting the shrunk heartbeat TTL — AI-113 regression');
    } finally {
      resolveGate();
      await loopDone;
    }

    // After the loop drains and releases its own lock, a foreign acquirer
    // succeeds — confirms the earlier block wasn't just a permanently-stuck lock.
    const foreignAcquiredAfter = await blackboard.acquireLock(resourceId, 'foreign-agent', 999999, 2000, 'foreign-context-2');
    assert.equal(foreignAcquiredAfter, true, 'lock must be released once the dispatch completes');
    await blackboard.releaseLock(resourceId, 'foreign-agent', 'foreign-context-2');
  });
});

// ---------------------------------------------------------------------------
// AI-095 follow-up (deep-recheck 2026-07-08, Phase 1A): enqueue-time
// pending-dispatch placeholder, written before an update's own processUpdate
// call — closes the crash window where a queued same-topic update existed
// only in the in-memory topicPending chain.
// ---------------------------------------------------------------------------

describe('runPollLoop: enqueue-time dispatch persistence', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;
  const savedPaHome = process.env.PA_HOME;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-enqueue-'));
    process.env.PA_HOME = tempDir;
    _resetPendingDispatchesForTest();
    await writeFile(join(tempDir, 'config.yaml'), JSON.stringify({ workers: [{ name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e 0' }] }), 'utf8');
  });

  afterEach(async () => {
    process.env.PA_HOME = savedPaHome;
    _resetPendingDispatchesForTest();
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('a pending-dispatch record for update #2 exists on disk while update #1 is still gated', async () => {
    // 2026-09-01 dark-file recheck: intermittent — see the poll note inside the
    // gate below (AI-171 batch, 2026-09-02) for why a bounded poll replaces the
    // original read-once assertion.
    // Same shape as the per-topic-serialization test: two same-topic updates,
    // gate update #1's sendMessage so update #2's own processUpdate never
    // starts. If the record only appeared once update #2's own dispatch
    // began, it would still be absent here — proving it was written at
    // ENQUEUE time (in the poll loop, before either update's processUpdate
    // runs), not deferred until each update's own turn.
    const controller = new AbortController();
    const state = makeState(123, -1);
    const update1 = { update_id: 1, message: { message_id: 1, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/default' } };
    const update2 = { update_id: 2, message: { message_id: 2, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/default' } };

    let resolveGate!: () => void;
    const gate = new Promise<void>(resolve => { resolveGate = resolve; });
    let gateUsed = false;
    let getUpdatesCallCount = 0;
    let recordSeenAtGate: unknown;

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [update1, update2] }), json: async () => ({ ok: true, result: [update1, update2] }) };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if ((url as string).includes('sendMessage') && !gateUsed) {
        gateUsed = true;
        // update #2's placeholder must already be on disk right now — its own
        // processUpdate hasn't started (update #1 is holding the gate).
        // AI-171 batch (2026-09-02): the dark-file recheck's skip diagnosed an
        // intermittent failure here. The enqueue-time write IS awaited before
        // chaining (main.ts), but the original read-once assert assumed update
        // #1's first sendMessage arrives AFTER update #2's enqueue write
        // completes — an ordering one batch never guarantees (the loop's
        // enqueue block for #2 and #1's chained processUpdate progress
        // concurrently), so cold-cache timing could read a half-landed write.
        // Poll bounded instead: update #2's own processUpdate can NEVER run
        // while update #1 holds this gate (per-topic serialization), so any
        // record appearing within the poll window is still proof it was
        // written at ENQUEUE time, not at its own turn — the discriminator is
        // unchanged. A true regression still fails here, after the ~10s cap.
        for (let i = 0; i < 500 && !recordSeenAtGate; i++) {
          const listed = await listPendingDispatches();
          recordSeenAtGate = listed.find(r => r.updateId === 2);
          if (!recordSeenAtGate) await new Promise(r => setTimeout(r, 20));
        }
        await gate;
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 999 } }), json: async () => ({ ok: true, result: { message_id: 999 } }) };
    };

    const loopDone = runPollLoop('token', [123], state, {}, controller.signal, fastSleep);
    for (let i = 0; i < 500 && !gateUsed; i++) await new Promise(r => setTimeout(r, 20));
    try {
      assert.ok(recordSeenAtGate, 'update #2 should already have a pending-dispatch placeholder while update #1 is still gated');
      assert.equal((recordSeenAtGate as { cwd?: string }).cwd, undefined, 'the enqueue-time placeholder has no cwd yet');
    } finally {
      resolveGate();
      await loopDone;
    }
  });

  it('the placeholder is removed after a skip-worker command completes, with no full record ever written', async () => {
    const controller = new AbortController();
    const state = makeState(123, -1);
    let getUpdatesCallCount = 0;
    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [{ update_id: 10, message: { message_id: 1, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/reset' } }] }), json: async () => ({ ok: true, result: [] }) };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 999 } }), json: async () => ({ ok: true, result: { message_id: 999 } }) };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);
    assert.deepEqual(await listPendingDispatches(), [], 'no leftover placeholder after a skip-worker command settles');
  });

  it('no placeholder is written for a disallowed chat or a text-less message', async () => {
    const controller = new AbortController();
    const state = makeState(123, -1);
    let getUpdatesCallCount = 0;
    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [
              { update_id: 20, message: { message_id: 1, chat: { id: 999999, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'hello' } }, // disallowed chat
              { update_id: 21, message: { message_id: 2, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000) } }, // no text/caption
            ] }),
            json: async () => ({ ok: true, result: [] }),
          };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 999 } }), json: async () => ({ ok: true, result: { message_id: 999 } }) };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);
    assert.deepEqual(await listPendingDispatches(), [], 'neither update should have produced a placeholder');
  });

  it('a processUpdate rejection does not crash the poll loop, and the new .finally() cleanup path is itself failure-safe', async () => {
    // Force processUpdate to reject via the same technique as the existing
    // "processUpdate error handling" suite (PA_HOME pointed at a non-existent
    // path breaks conversation-state I/O, which is unguarded by any catch —
    // the rejection escapes processUpdate). Note this ALSO breaks the
    // enqueue-time placeholder write itself (same live-PA_HOME dependency),
    // so this test cannot observe "written, then removed" directly — what it
    // proves is the narrower but still real property the new code needs: the
    // added enqueue-write + .finally()-cleanup logic does not turn an
    // already-tolerated processUpdate rejection into a NEW unhandled
    // rejection or a hang, even when its own disk operations are ALSO
    // failing. (The "written, then removed on throw" property is exercised
    // implicitly by test (a) and (b) above under a working PA_HOME — nothing
    // in the removal path is throw-conditional, so there is no separate
    // code path that only runs on the throw branch.)
    process.env.PA_HOME = join(tempDir, 'does-not-exist');
    _resetPendingDispatchesForTest();
    const controller = new AbortController();
    const state = makeState(123, -1);
    let getUpdatesCallCount = 0;
    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [{ update_id: 30, message: { message_id: 1, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'hello' } }] }), json: async () => ({ ok: true, result: [] }) };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    await assert.doesNotReject(() => runPollLoop('token', [123], state, {}, controller.signal, fastSleep));
    assert.ok(getUpdatesCallCount >= 2, 'poll loop must have continued after the rejected processUpdate');
  });
});

// ---------------------------------------------------------------------------
// 2026-08-04 steer-queue-context-fold: /steer folds every not-yet-started
// update still queued behind the one it kills into the steer prompt, instead
// of letting them dispatch independently once the kill settles (or dropping
// them). See plans/2026-08-04-steer-queue-context-fold.md.
// ---------------------------------------------------------------------------

describe('runPollLoop: /steer folds queued messages into context', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-steer-fold-'));
    process.env.PA_HOME = tempDir;
    _resetPendingDispatchesForTest();
    _clearQueueForTest();
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    _resetPendingDispatchesForTest();
    _clearQueueForTest();
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('msg1 in-flight + msg2/msg3 queued + queued /reset + /steer: msg2/msg3 fold into one combined dispatch, /reset still runs on its own', async function() {
    // The "worker" reads the full prompt off stdin and echoes it back wrapped
    // in GOTPROMPTSTART/GOTPROMPTEND markers — lets the test read back
    // exactly what dispatchMessage sent as `## Current Message`, in order,
    // without guessing at prompt-template formatting.
    const workerScript = join(tempDir, 'echo-worker.mjs');
    await writeFile(workerScript, [
      "let d = '';",
      "process.stdin.on('data', c => { d += c; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write('GOTPROMPTSTART' + d + 'GOTPROMPTEND');",
      '  process.exit(0);',
      '});',
    ].join('\n'), 'utf8');

    await writeFile(join(tempDir, 'config.yaml'), `
workers:
  - name: claude
    input_mode: stdin-text
    command: node
    args: ["${workerScript.replace(/\\/g, '/')}"]
    check: node -e "process.exit(0)"
topic_defaults:
  "123_0": "claude"
`, 'utf8');

    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    await writeFile(topicStateFile, JSON.stringify({ chat_id: 123, thread_id: 0, turns: [] }), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);

    const msg1 = { update_id: 1, message: { message_id: 1, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'SEEDMESSAGEONE' } };
    const msg2 = { update_id: 2, message: { message_id: 2, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'QUEUEDTWO' } };
    const msg3 = { update_id: 3, message: { message_id: 3, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'QUEUEDTHREE' } };
    const queuedReset = { update_id: 4, message: { message_id: 4, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/reset' } };
    const steerMsg = { update_id: 5, message: { message_id: 5, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/steer STEERPROMPT' } };

    let getUpdatesCallCount = 0;
    const sentTexts: string[] = [];

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          const batch = { ok: true, result: [msg1, msg2, msg3, queuedReset, steerMsg] };
          return { ok: true, status: 200, text: async () => JSON.stringify(batch), json: async () => batch };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if ((url as string).includes('sendMessage')) {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        const text: string = body.text ?? '';
        sentTexts.push(text);
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 900 + sentTexts.length } }), json: async () => ({ ok: true, result: { message_id: 900 + sentTexts.length } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    // The echoed prompt overflows Telegram's 4096-char send limit, so the
    // reply arrives as sequential CHUNKS — only the first carries the
    // GOTPROMPTSTART marker. Reassemble the FULL reply by joining every
    // sent text from the marker chunk onward (the chunks of one reply are
    // consecutive; no other message can interleave inside one send call).
    const firstChunkIdx = sentTexts.findIndex(t => t.includes('GOTPROMPTSTART'));
    const gotPromptReplies = firstChunkIdx === -1 ? [] : [sentTexts.slice(firstChunkIdx).join('')];
    // A11: Re-baselined — exactly ONE worker dispatch (the steer's combined turn).
    // msg1's in-flight turn is cancelled at flush-check (killed=0), its text
    // folds into held via A6, and the steer absorbs it at normalizer time via A7.
    // Note: msg1 never reaches dispatchMessage because the flush-check (A8) returns
    // early when the topic is stopped, so there's no gate mechanism needed.
    assert.equal(gotPromptReplies.length, 1, `expected exactly 1 worker dispatch (the steer's combined turn) — msg1 cancelled at flush-check, msg2/msg3 folded. Got: ${JSON.stringify(sentTexts)}`);

    const combined = gotPromptReplies[0];
    // The echoed prompt includes the topic's conversation HISTORY plus the
    // "*Current Message*" section (rendered header — italics marker, not ##).
    // msg1's text legitimately appears in BOTH (archived at receipt per
    // AI-095, then folded into the current message via A6+A7) — so slice the
    // current-message section for the fold assertions, and leave the history
    // copy out of the duplication guard.
    const currentSection = combined.slice(combined.indexOf('*Current Message*'));
    const idxOne = currentSection.indexOf('SEEDMESSAGEONE');
    const idxTwo = currentSection.indexOf('QUEUEDTWO');
    const idxThree = currentSection.indexOf('QUEUEDTHREE');
    const idxSteer = currentSection.indexOf('STEERPROMPT');
    assert.ok(idxOne !== -1, 'combined dispatch must contain msg1 text (via held from A6)');
    assert.ok(idxTwo !== -1, 'combined dispatch must contain msg2 text');
    assert.ok(idxThree !== -1, 'combined dispatch must contain msg3 text');
    assert.ok(idxSteer !== -1, 'combined dispatch must contain the steer prompt');
    assert.ok(idxOne < idxTwo && idxTwo < idxThree && idxThree < idxSteer, `combined text must be msg1, then msg2, then msg3, then the steer prompt, in that order — got indices ${idxOne}, ${idxTwo}, ${idxThree}, ${idxSteer}`);
    // A9 regression guard: no duplicate SEEDMESSAGEONE in the CURRENT MESSAGE
    // (a real double-fold — e.g. flush-check AND A6 both adding, or the
    // steer drain cancelling + folding itself — would show 2+ here). Exactly
    // one occurrence in history is expected and fine.
    const occurrences = (currentSection.match(/SEEDMESSAGEONE/g) || []).length;
    assert.equal(occurrences, 1, `SEEDMESSAGEONE must appear exactly once in the current message (A9 double-fold guard). Got ${occurrences} occurrences.`);

    // The queued /reset must NOT have been folded — it still runs in its own
    // turn, producing its usual local reply. AI-171 phase B: the dark-file recheck's
    // skip diagnosed this as real drift, but the A8 fix (commands never hold at the
    // flush-check) IS working — /reset runs on its own turn correctly (its own pin
    // refresh + confirmation both appear in sentTexts). The test itself was checking
    // the wrong string: main.ts's RESET_PATTERN handler never reads
    // handleResetCommand's own `.response` field (logic.ts's "Conversation and
    // session cleared" text) — it builds its own reply via
    // renderSessionExpiryMessage(prevDescriptor, nextDescriptor, 'cleared'), which
    // reads "Session overrides cleared: <prev> → <next>."
    assert.ok(sentTexts.some(t => t.includes('Session overrides cleared')), `queued /reset must still dispatch on its own turn. Got: ${JSON.stringify(sentTexts)}`);

    // No leaked enqueue-time pending-dispatch placeholders — the .finally()
    // cleanup (inFlight.delete / topicPending tail cleanup / removePendingDispatch)
    // must have run for every entry, including the two cancelled/folded ones.
    assert.deepEqual(await listPendingDispatches(), [], 'no leftover pending-dispatch placeholders after the loop settles');
  });

  it('bare /steer without prompt folds queued messages into combined dispatch without extra prompt text', async function() {
    const workerScript = join(tempDir, 'echo-worker2.mjs');
    await writeFile(workerScript, [
      "let d = '';",
      "process.stdin.on('data', c => { d += c; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write('GOTPROMPTSTART' + d + 'GOTPROMPTEND');",
      '  process.exit(0);',
      '});',
    ].join('\n'), 'utf8');

    await writeFile(join(tempDir, 'config.yaml'), `
workers:
  - name: claude
    input_mode: stdin-text
    command: node
    args: ["${workerScript.replace(/\\/g, '/')}"]
    check: node -e "process.exit(0)"
topic_defaults:
  "123_0": "claude"
`, 'utf8');

    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    await writeFile(topicStateFile, JSON.stringify({ chat_id: 123, thread_id: 0, turns: [] }), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);

    const msg1 = { update_id: 1, message: { message_id: 1, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'FIRSTMSG' } };
    const msg2 = { update_id: 2, message: { message_id: 2, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'SECONDMSG' } };
    const steerMsg = { update_id: 3, message: { message_id: 3, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/steer' } };

    let getUpdatesCallCount = 0;
    const sentTexts: string[] = [];

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          const batch = { ok: true, result: [msg1, msg2, steerMsg] };
          return { ok: true, status: 200, text: async () => JSON.stringify(batch), json: async () => batch };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if ((url as string).includes('sendMessage')) {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        const text: string = body.text ?? '';
        sentTexts.push(text);
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 900 + sentTexts.length } }), json: async () => ({ ok: true, result: { message_id: 900 + sentTexts.length } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const firstChunkIdx = sentTexts.findIndex(t => t.includes('GOTPROMPTSTART'));
    const gotPromptReplies = firstChunkIdx === -1 ? [] : [sentTexts.slice(firstChunkIdx).join('')];
    assert.equal(gotPromptReplies.length, 1, `expected exactly 1 worker dispatch for bare steer. Got: ${JSON.stringify(sentTexts)}`);

    const combined = gotPromptReplies[0];
    const currentSection = combined.slice(combined.indexOf('*Current Message*'));
    assert.ok(currentSection.includes('FIRSTMSG'), 'combined dispatch must contain msg1 text');
    assert.ok(currentSection.includes('SECONDMSG'), 'combined dispatch must contain msg2 text');
    assert.ok(!currentSection.includes('/steer'), 'combined dispatch must not contain raw /steer string');
  });

  it('regression: a single queued message behind an in-flight one still dispatches normally (no /steer involved)', async () => {
    // Guards against the fold logic breaking the plain, no-steer case.
    await writeFile(join(tempDir, 'config.yaml'), JSON.stringify({ workers: [{ name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e 0' }] }), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);
    const update1 = { update_id: 1, message: { message_id: 1, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/default' } };
    const update2 = { update_id: 2, message: { message_id: 2, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/default' } };

    let sendMessageCallCount = 0;
    let getUpdatesCallCount = 0;
    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [update1, update2] }), json: async () => ({ ok: true, result: [update1, update2] }) };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if ((url as string).includes('sendMessage')) sendMessageCallCount++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 999 } }), json: async () => ({ ok: true, result: { message_id: 999 } }) };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);
    // 3, not 2: this topic has no seeded topic-state file, so update1's /default is
    // the topic's first-ever local command — its own refreshPinnedStatusCardInPlace
    // call finds no pinned_status_message_id yet and creates a FRESH pin via
    // sendMessage (family-2 pattern: an ambient/first-run pin creation adds a send
    // old counts don't expect), on top of each /default's own confirmation reply.
    // update2's own pin refresh reuses editMessageText (pin already exists), so it
    // contributes no extra sendMessage call — 1 pin creation + 2 confirmations = 3.
    assert.equal(sendMessageCallCount, 3, 'both queued updates must still dispatch independently when no /steer is involved');
  });
});

// ---------------------------------------------------------------------------
// AI-095 follow-up (deep-recheck 2026-07-08, Phase 1B): recovery gate blocks
// a new dispatch into a topic under active orphan-recovery.
// ---------------------------------------------------------------------------

describe('runPollLoop: recovery gate', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-gate-'));
    process.env.PA_HOME = tempDir;
    _resetPendingDispatchesForTest();
    _resetRecoveryGateForTest();
    await writeFile(join(tempDir, 'config.yaml'), JSON.stringify({ workers: [{ name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e 0' }] }), 'utf8');
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    _resetPendingDispatchesForTest();
    _resetRecoveryGateForTest();
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  async function runOneUpdate(text: string, chatId = 123): Promise<string[]> {
    const controller = new AbortController();
    const state = makeState(chatId, -1);
    const sentTexts: string[] = [];
    let getUpdatesCallCount = 0;
    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          const batch = { ok: true, result: [{ update_id: 1, message: { message_id: 1, chat: { id: chatId, type: 'private' }, date: Math.floor(Date.now() / 1000), text } }] };
          // getUpdates() reads res.json(), not res.text() — both must carry the real batch.
          return { ok: true, status: 200, text: async () => JSON.stringify(batch), json: async () => batch };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if ((url as string).includes('sendMessage') && opts?.body) {
        const body = JSON.parse(opts.body);
        sentTexts.push(body.text ?? '');
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 999 } }), json: async () => ({ ok: true, result: { message_id: 999 } }) };
    };
    await runPollLoop('token', [chatId], state, {}, controller.signal, fastSleep);
    return sentTexts;
  }

  it('a plain worker message to a topic marked recovering WAITS for the clear, then dispatches (queue-not-bounce)', async () => {
    process.env.PA_RECOVERY_WAIT_MS = '5000';
    markTopicRecovering('123_0');
    const clearTimer = setTimeout(() => clearTopicRecovering('123_0'), 50);
    try {
      const sent = await runOneUpdate('hello there');
      assert.ok(!sent.some(t => t.includes('Still recovering')), `the deferral notice is gone (2026-08-27 seamless-restart-recovery); got: ${JSON.stringify(sent)}`);
      assert.ok(sent.length > 0, 'the worker reply must be sent after the clear');
      assert.deepEqual(await listPendingDispatches(), [], 'the dispatch lifecycle must complete normally');
    } finally {
      clearTimeout(clearTimer);
      delete process.env.PA_RECOVERY_WAIT_MS;
    }
  });

  it('a stale recovery gate (never cleared) times out and dispatches anyway', async () => {
    process.env.PA_RECOVERY_WAIT_MS = '50';
    markTopicRecovering('123_0');
    try {
      const sent = await runOneUpdate('hello there');
      assert.ok(!sent.some(t => t.includes('Still recovering')), `no deferral text; got: ${JSON.stringify(sent)}`);
      assert.ok(sent.length > 0, 'the dispatch must proceed past the stale gate');
    } finally {
      delete process.env.PA_RECOVERY_WAIT_MS;
    }
  });

  it('requeueSyntheticUpdate injects a shape-complete synthetic that dispatches through the normal path exactly once', async () => {
    // AI-171 phase B: the dark-file recheck's skip diagnosed "requeued dispatch failed
    // below cap" as real drift in the requeue path, but the requeue-park decision
    // (main.ts, `parkedNow = ... && workerErrored && ...`) only fires when the DISPATCH
    // itself reports an error — and this describe's shared beforeEach config.yaml gives
    // 'claude' a worker script (`node -e '0'`) that produces EMPTY stdout, which the
    // dispatch pipeline treats as a worker failure. Tests 1/2 in this describe never
    // noticed because a failed dispatch still sends SOME reply either way (satisfying
    // their `sent.length > 0`-only checks) — this is the first test that needs the
    // dispatch to actually SUCCEED. Override with a worker that writes real output.
    await writeFile(join(tempDir, 'config.yaml'), JSON.stringify({ workers: [{ name: 'claude', command: 'node', args: ['-e', 'process.stdout.write("ok")'], check: 'node -e 0' }] }), 'utf8');
    // The "V1 guard" this test protects (requeue must not DUPLICATE the user turn)
    // only means something if the turn already exists, exactly as it would at real
    // "first receipt" before the crash that triggered the requeue. Seed that turn —
    // without it, main.ts's own by-design skip (`if (__requeueCount === undefined)`
    // before addTurn, "already archived at first receipt") correctly leaves the
    // turn absent, and the original assertion of exactly 1 was unreachable by
    // construction, not because of any drift in the requeue path.
    await writeFile(join(tempDir, 'telegram-bot-topic-123_0.json'), JSON.stringify({
      chat_id: 123,
      thread_id: 0,
      turns: [{ role: 'user', text: 'do the thing', timestamp: new Date().toISOString(), message_id: 321 }],
    }), 'utf8');
    requeueSyntheticUpdate({ updateId: 7, chatId: 123, threadId: 0, messageId: 321, userText: 'do the thing', startedAt: new Date().toISOString(), requeueCount: 1 });
    const controller = new AbortController();
    const state = makeState(123, -1);
    const sentTexts: string[] = [];
    let getUpdatesCallCount = 0;
    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          // EMPTY real batch — only the injected synthetic may be processed.
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if ((url as string).includes('sendMessage') && opts?.body) {
        sentTexts.push(JSON.parse(opts.body).text ?? '');
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 999 } }), json: async () => ({ ok: true, result: { message_id: 999 } }) };
    };
    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);
    assert.ok(sentTexts.length > 0, 'the requeued request must dispatch and reply');
    // V1 guard: the user turn was archived at first receipt — the synthetic must
    // not duplicate it in the rolling window. (Filename fixed: the real convention
    // is `telegram-bot-topic-<chatId>_<threadId>.json`, conversation.ts's
    // getTopicPath — this test had the wrong prefix, "telegram-bot-state-".)
    const saved = JSON.parse(await readFile(join(process.env.PA_HOME!, 'telegram-bot-topic-123_0.json'), 'utf8')) as { turns: Array<{ role: string; message_id?: number }> };
    assert.equal(saved.turns.filter((t) => t.role === 'user' && t.message_id === 321).length, 1, 'exactly one user turn for the original message');
    assert.deepEqual(await listPendingDispatches(), [], 'the requeued record must complete its lifecycle');
    // Buttons-program invariant (R1/R4): a synthetic update_id must never reach
    // the offset — with an empty real batch it stays at the seeded value.
    assert.equal(state.last_update_id, -1, 'synthetic update_id never advances last_update_id');
  });

  it('a skip-worker command to a topic marked recovering still executes its own logic, not the deferral', async () => {
    markTopicRecovering('123_0');
    const sent = await runOneUpdate('/reset');
    assert.ok(sent.length > 0, 'expected a response');
    assert.ok(!sent.some(t => t.includes('Still recovering')), `the recovery gate must never override a resolved skip-worker response, got: ${JSON.stringify(sent)}`);
  });

  it('a plain worker message to a topic that is NOT marked recovering dispatches normally (gate is inert)', async () => {
    const sent = await runOneUpdate('hello there', 456);
    assert.ok(!sent.some(t => t.includes('Still recovering')), `gate must be inert when nothing is marked, got: ${JSON.stringify(sent)}`);
  });
});

// ---------------------------------------------------------------------------
// P1 maintenance tick wiring (deep-recheck P1-5/TQ-1)
// ---------------------------------------------------------------------------

describe('runPollLoop: maintenance tick', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;
  const originalDateNow = Date.now;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-maint-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    Date.now = originalDateNow;
    _setDegradedForTest(false);
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('the 5-min tick fires in steady state and delivers a queued DLQ entry', async () => {
    // NOTE: deliberately does NOT advance the clock 6h to also exercise the
    // session-GC tick — cleanupExpiredSessions() operates on the REAL homedir
    // (~/.claude, ~/.gemini), and triggering it from a test would delete real
    // expired session files as a side effect. The gating logic is identical
    // in shape; this covers the shared wiring plus the flush effect.
    const dlqEntry = {
      chatId: 123, threadId: 0, text: 'queued reply from outage',
      timestamp: new Date().toISOString(), updateId: 424242,
    };
    await writeFile(join(tempDir, 'telegram-dlq.jsonl'), JSON.stringify(dlqEntry) + '\n', 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);
    const sentBodies: string[] = [];
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCount++;
        // Advance past MAINTENANCE_INTERVAL_MS (5 min) between iterations so
        // the tick's gate opens on the SECOND loop pass, not the first
        // (nextMaintenanceAt is seeded one interval out at loop entry).
        now += 6 * 60 * 1000;
        if (getUpdatesCount >= 2) controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if ((url as string).includes('sendMessage')) {
        if (opts?.body) sentBodies.push(String(opts.body));
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 77 } }), json: async () => ({ ok: true, result: { message_id: 77 } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    let now = originalDateNow();
    Date.now = () => now;
    try {
      await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);
    } finally {
      Date.now = originalDateNow;
    }

    // The tick's flushDlq is fire-and-forget — wait for its LAST effect (the
    // DLQ rewrite/clear happens after sendMessage + markDelivered), not just
    // the first (the send), so the file assertion below can't race the flush.
    for (let i = 0; i < 40; i++) {
      const raw = await readFile(join(tempDir, 'telegram-dlq.jsonl'), 'utf8').catch(() => '');
      if (raw.trim() === '') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(sentBodies.some((b) => b.includes('queued reply from outage')),
      'maintenance tick must retry and deliver the queued DLQ entry in steady state (not only at startup)');
    const dlqRaw = await readFile(join(tempDir, 'telegram-dlq.jsonl'), 'utf8').catch(() => '');
    assert.equal(dlqRaw.trim(), '', 'delivered entry removed from the DLQ');
  });

  it('the DLQ flush fires even while DEGRADED (it is reply delivery, not sheddable housekeeping)', async () => {
    // Pins the 4cb6d67 behavioral fix: reverting the tick's gate back to
    // `if (!isDegraded() && ...)` must fail this test.
    _setDegradedForTest(true);
    const dlqEntry = {
      chatId: 123, threadId: 0, text: 'queued reply under degradation',
      timestamp: new Date().toISOString(), updateId: 424244,
    };
    await writeFile(join(tempDir, 'telegram-dlq.jsonl'), JSON.stringify(dlqEntry) + '\n', 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);
    const sentBodies: string[] = [];
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCount++;
        now += 6 * 60 * 1000;
        if (getUpdatesCount >= 2) controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if ((url as string).includes('sendMessage')) {
        if (opts?.body) sentBodies.push(String(opts.body));
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 79 } }), json: async () => ({ ok: true, result: { message_id: 79 } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    let now = originalDateNow();
    Date.now = () => now;
    try {
      await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);
    } finally {
      Date.now = originalDateNow;
    }
    for (let i = 0; i < 40; i++) {
      const raw = await readFile(join(tempDir, 'telegram-dlq.jsonl'), 'utf8').catch(() => '');
      if (raw.trim() === '') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(sentBodies.some((b) => b.includes('queued reply under degradation')),
      'DLQ flush must NOT be shed under DEGRADED — queued replies would silently expire at the 24h TTL');
  });

  it('does not fire the tick before the interval elapses', async () => {
    const dlqEntry = {
      chatId: 123, threadId: 0, text: 'must not send yet',
      timestamp: new Date().toISOString(), updateId: 424243,
    };
    await writeFile(join(tempDir, 'telegram-dlq.jsonl'), JSON.stringify(dlqEntry) + '\n', 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);
    const sentBodies: string[] = [];
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCount++;
        // Clock does NOT advance — the seeded-one-interval-out gate stays shut.
        if (getUpdatesCount >= 3) controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if ((url as string).includes('sendMessage')) {
        if (opts?.body) sentBodies.push(String(opts.body));
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 78 } }), json: async () => ({ ok: true, result: { message_id: 78 } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    let now = originalDateNow();
    Date.now = () => now;
    try {
      await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);
    } finally {
      Date.now = originalDateNow;
    }
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(!sentBodies.some((b) => b.includes('must not send yet')),
      'tick must not fire before MAINTENANCE_INTERVAL_MS elapses');
    const dlqRaw = await readFile(join(tempDir, 'telegram-dlq.jsonl'), 'utf8');
    assert.ok(dlqRaw.includes('must not send yet'), 'entry still queued');
  });
});

describe('generateDescriptionSuggestion', () => {
  it('generates suggestion for name with 4+ non-numeric chars', () => {
    assert.equal(generateDescriptionSuggestion('daily-briefings'), 'Discussions about daily-briefings');
  });

  it('lowercases the name', () => {
    assert.equal(generateDescriptionSuggestion('Feature-Requests'), 'Discussions about feature-requests');
  });

  it('returns empty string for short name (under 4 non-numeric chars)', () => {
    assert.equal(generateDescriptionSuggestion('ab'), '');
  });

  it('returns empty string for numeric-only name', () => {
    assert.equal(generateDescriptionSuggestion('12345'), '');
  });

  it('returns suggestion when name has exactly 4 non-numeric chars', () => {
    const result = generateDescriptionSuggestion('test');
    assert.equal(result, 'Discussions about test');
  });

  it('handles name with mixed numbers and letters meeting threshold', () => {
    // '1abc2' starts with '1' (numeric), so /^[^0-9]{4,}/ does not match
    assert.equal(generateDescriptionSuggestion('1abc2'), '');
  });

  it('returns empty string for empty string input', () => {
    assert.equal(generateDescriptionSuggestion(''), '');
  });
});

// ---------------------------------------------------------------------------
// isValidDescriptionOutput
// ---------------------------------------------------------------------------

describe('isValidDescriptionOutput', () => {
  it('accepts a normal description', () => {
    assert.equal(isValidDescriptionOutput('Debugging the codex worker, codex-specific issues, and failover routing considerations.'), true);
  });

  it('accepts a short description', () => {
    assert.equal(isValidDescriptionOutput('Travel planning and itinerary queries.'), true);
  });

  it('rejects conversational "What can I help"', () => {
    assert.equal(isValidDescriptionOutput('What can I help you with today?'), false);
  });

  it('rejects conversational "got cut off"', () => {
    assert.equal(isValidDescriptionOutput('It looks like your message got cut off. What can I help you with?'), false);
  });

  it('rejects conversational "How can I assist"', () => {
    assert.equal(isValidDescriptionOutput('How can I assist you further?'), false);
  });

  it('rejects conversational "I\'d be happy"', () => {
    assert.equal(isValidDescriptionOutput("I'd be happy to help with that!"), false);
  });

  it('rejects conversational "Let me know how"', () => {
    assert.equal(isValidDescriptionOutput('Let me know how else I can help.'), false);
  });

  it('rejects output exceeding 160 chars', () => {
    const long = 'A'.repeat(161);
    assert.equal(isValidDescriptionOutput(long), false);
  });

  it('accepts output at exactly 160 chars', () => {
    const exact = 'A'.repeat(160);
    assert.equal(isValidDescriptionOutput(exact), true);
  });

  it('pattern matching is case-insensitive', () => {
    assert.equal(isValidDescriptionOutput('WHAT CAN I HELP YOU WITH?'), false);
  });
});

// ---------------------------------------------------------------------------
// parseDescriptionLLMOutput
// ---------------------------------------------------------------------------

describe('parseDescriptionLLMOutput', () => {
  it('returns confident result for a valid description', () => {
    const result = parseDescriptionLLMOutput('Discussions about fitness tracking and workout logging.');
    assert.deepEqual(result, { description: 'Discussions about fitness tracking and workout logging.', confident: true });
  });

  it('strips surrounding double quotes and returns confident', () => {
    const result = parseDescriptionLLMOutput('"Discussions about fitness tracking."');
    assert.deepEqual(result, { description: 'Discussions about fitness tracking.', confident: true });
  });

  it('returns not-confident for uppercase UNKNOWN', () => {
    assert.deepEqual(parseDescriptionLLMOutput('UNKNOWN'), { description: '', confident: false });
  });

  it('returns not-confident for lowercase unknown', () => {
    assert.deepEqual(parseDescriptionLLMOutput('unknown'), { description: '', confident: false });
  });

  it('returns not-confident for UNKNOWN. (trailing period)', () => {
    assert.deepEqual(parseDescriptionLLMOutput('UNKNOWN.'), { description: '', confident: false });
  });

  it('returns not-confident for UNKNOWN! (trailing exclamation)', () => {
    assert.deepEqual(parseDescriptionLLMOutput('UNKNOWN!'), { description: '', confident: false });
  });

  it('returns not-confident for UNKNOWN? (trailing question mark)', () => {
    assert.deepEqual(parseDescriptionLLMOutput('UNKNOWN?'), { description: '', confident: false });
  });

  it('strips surrounding single quotes and returns confident', () => {
    const result = parseDescriptionLLMOutput("'Discussions about fitness tracking.'");
    assert.deepEqual(result, { description: 'Discussions about fitness tracking.', confident: true });
  });

  it('trims internal whitespace left after quote stripping', () => {
    const result = parseDescriptionLLMOutput('"Discussions about fitness tracking. "');
    assert.deepEqual(result, { description: 'Discussions about fitness tracking.', confident: true });
  });

  it('returns not-confident when err is passed', () => {
    assert.deepEqual(parseDescriptionLLMOutput('', new Error('execFile failed')), { description: '', confident: false });
  });

  it('returns not-confident for empty stdout', () => {
    assert.deepEqual(parseDescriptionLLMOutput(''), { description: '', confident: false });
  });

  it('returns not-confident for whitespace-only stdout', () => {
    assert.deepEqual(parseDescriptionLLMOutput('   '), { description: '', confident: false });
  });

  it('returns not-confident for conversational filler', () => {
    assert.deepEqual(parseDescriptionLLMOutput("I'd be happy to help with that!"), { description: '', confident: false });
  });

  it('returns not-confident for output exceeding 160 chars', () => {
    const long = 'A'.repeat(161);
    assert.deepEqual(parseDescriptionLLMOutput(long), { description: '', confident: false });
  });
});

// ---------------------------------------------------------------------------
// Branch ancestry race: forum_topic_created handler
// ---------------------------------------------------------------------------

describe('runPollLoop: branch ancestry race condition', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-ancestry-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('branch topic: forum_topic_created skips description and preserves ancestry', async () => {
    // Verify that when /branch creates a forum topic, the forum_topic_created service
    // message does NOT overwrite ancestry or post a description prompt.
    //
    // Gate design: createForumTopic mock calls gateResolve(), which schedules
    // the second getUpdates continuation (MT1) before /branch continuation (MT2).
    // MT1 runs first but only causes getUpdates to resolve (scheduling MT3).
    // MT2 (branchCreatedTopicKeys.add) was already queued before MT3, so add()
    // always executes before the second batch starts processing.
    const controller = new AbortController();
    const state = makeState(123, -1);
    let getUpdatesCount = 0;
    let gateResolve!: () => void;
    const gate = new Promise<void>(r => { gateResolve = r; });

    const branchUpdate = {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: '/branch test-race',
        message_thread_id: undefined as number | undefined,
      },
    };
    const ftcUpdate = {
      update_id: 2,
      message: {
        message_id: 11,
        chat: { id: 123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        message_thread_id: 999,
        forum_topic_created: { name: 'test-race', icon_color: 0 },
      },
    };

    const fetchLog: Array<{ url: string; body: string }> = [];

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
      fetchLog.push({ url, body: opts?.body ?? '' });
      if ((url as string).includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [branchUpdate] }), json: async () => ({ ok: true, result: [branchUpdate] }) };
        }
        if (getUpdatesCount === 2) {
          await gate; // wait until createForumTopic has resolved (and add() has run)
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [ftcUpdate] }), json: async () => ({ ok: true, result: [ftcUpdate] }) };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if ((url as string).includes('createForumTopic')) {
        gateResolve(); // unblock second getUpdates AFTER add() is scheduled
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_thread_id: 999 } }), json: async () => ({ ok: true, result: { message_thread_id: 999 } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 99 } }), json: async () => ({ ok: true, result: { message_id: 99 } }) };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    // Must NOT post a duplicate description prompt to thread 999 from forum_topic_created
    const promptMsgs = fetchLog.filter(e =>
      e.url.includes('sendMessage') &&
      e.body.includes('"message_thread_id":999') &&
      (e.body.includes('What\\\'s it for') || e.body.includes("What's it for") || e.body.includes('Reply *yes*'))
    );
    assert.equal(promptMsgs.length, 0, 'must not post description prompt to branch topic');

    // State for thread 999 must have ancestry (written by /branch handler)
    const raw = await readFile(join(tempDir, 'telegram-bot-topic-123_999.json'), 'utf8');
    const saved = JSON.parse(raw);
    assert.ok(saved.ancestry, 'ancestry must be set on branch topic state');
    assert.equal(saved.ancestry.branchName, 'test-race');
  });

  it('manual topic: forum_topic_created auto-sets description and sends announcement', async () => {
    // Verify that for a non-branch topic, forum_topic_created auto-sets the
    // topic description and posts an announcement.
    const controller = new AbortController();
    const state = makeState(123, -1);
    let getUpdatesCount = 0;

    const ftcUpdate = {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        message_thread_id: 888,
        forum_topic_created: { name: 'new-manual-topic', icon_color: 0 },
      },
    };

    const fetchLog: Array<{ url: string; body: string }> = [];

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
      fetchLog.push({ url, body: opts?.body ?? '' });
      if ((url as string).includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [ftcUpdate] }), json: async () => ({ ok: true, result: [ftcUpdate] }) };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 99 } }), json: async () => ({ ok: true, result: { message_id: 99 } }) };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    // Must send a description announcement to thread 888
    const descMsgs = fetchLog.filter(e =>
      e.url.includes('sendMessage') &&
      e.body.includes('"message_thread_id":888') &&
      e.body.includes('Description set')
    );
    assert.ok(descMsgs.length > 0, 'must send description announcement to manual topic');

    // Must generate and pin the topic status card by default
    const pinCalls = fetchLog.filter(e => e.url.includes('pinChatMessage'));
    assert.ok(pinCalls.length > 0, 'must pin status card on manual topic creation');

    const topicStateRaw = await readFile(join(tempDir, 'telegram-bot-topic-123_888.json'), 'utf8');
    const topicState = JSON.parse(topicStateRaw);
    assert.ok(topicState.pinned_status_message_id, 'pinned_status_message_id must be set');

    // Description must be persisted to telegram-topic-names.json
    const namesRaw = await readFile(join(tempDir, 'telegram-topic-names.json'), 'utf8');
    const topicMap = JSON.parse(namesRaw);
    assert.ok(topicMap['123']?.['888']?.description, 'description must be auto-set in topic names');
  });

  it('postDescriptionSuggestion re-read preserves pre-existing ancestry', async () => {
    // Tests Phase 2 independently: if /branch already wrote ancestry to the state
    // file, postDescriptionSuggestion must not clobber it.
    const stateFile = join(tempDir, 'telegram-bot-topic-123_999.json');
    await writeFile(stateFile, JSON.stringify({
      chat_id: 123,
      thread_id: 999,
      turns: [],
      ancestry: { parentChatId: 123, parentThreadId: 0, branchName: 'test' },
    }), 'utf8');

    // Stub sendMessage so postDescriptionSuggestion doesn't need a real token
    (globalThis as Record<string, unknown>).fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } }),
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    });

    await postDescriptionSuggestion('token', 123, 999, 'AI topic', 'test');

    const raw = await readFile(stateFile, 'utf8');
    const saved = JSON.parse(raw);
    assert.ok(saved.ancestry, 'ancestry must be preserved after postDescriptionSuggestion');
    assert.ok(saved.pendingDescription, 'pendingDescription must be added');
    assert.equal(saved.pendingDescription.text, 'AI topic');
  });
});

// ---------------------------------------------------------------------------
// runPollLoop: local command routing (/new, /code, /status, /skills, /help)
// ---------------------------------------------------------------------------

describe('runPollLoop: local command routing (/new, /code, /status, /skills, /help)', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-cmds-'));
    process.env.PA_HOME = tempDir;
    await writeFile(join(tempDir, 'config.yaml'), JSON.stringify({
      workers: [{
        name: 'claude',
        command: 'node',
        args: ['-e', 'process.stdout.write("worker reply")'],
        check: 'node -e "process.exit(0)"',
        rate_limit_patterns: [],
      }],
    }), 'utf8');
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('handles bare /new locally: clears session and context, replies without worker dispatch', async () => {
    const stateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    await writeFile(stateFile, JSON.stringify({
      chat_id: 123,
      thread_id: 0,
      session: { session_id: 'old-session-123', worker: 'claude', started_at: new Date().toISOString() },
      turns: [{ role: 'user', text: 'previous text', timestamp: new Date().toISOString() }],
    }), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);
    const sentMessages: string[] = [];
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      const urlStr = url as string;
      if (urlStr.includes('getUpdates')) {
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
                text: '/new',
              },
            }] }),
            json: async () => ({ ok: true, result: [{
              update_id: 1,
              message: {
                message_id: 10,
                chat: { id: 123, type: 'private' },
                date: Math.floor(Date.now() / 1000),
                text: '/new',
              },
            }] }),
          };
        }
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }

      if (urlStr.includes('sendMessage')) {
        const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {};
        if (body.text) sentMessages.push(body.text);
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 100 } }),
          json: async () => ({ ok: true, result: { message_id: 100 } }),
        };
      }

      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    // The pre-existing topic-state file (written above, before runPollLoop starts) has no
    // model_status, so the ambient startup model-expiry-sweep sends an extra pin-card
    // refresh (a genuine sendMessage with body.text) ahead of the /new reply itself.
    assert.equal(sentMessages.length, 2, `expected the sweep's pin refresh plus the /new reply; got ${JSON.stringify(sentMessages)}`);
    assert.ok(sentMessages.some(m => m.includes('Context cleared and ready for a fresh session')));

    const saved = JSON.parse(await readFile(stateFile, 'utf8')) as ConversationState;
    assert.equal(saved.session, undefined);
  });

  it('handles /new <instruction>: clears context and dispatches instruction', async () => {
    const stateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    await writeFile(stateFile, JSON.stringify({
      chat_id: 123,
      thread_id: 0,
      session: { session_id: 'old-session-123', worker: 'claude', started_at: new Date().toISOString() },
      turns: [{ role: 'user', text: 'previous text', timestamp: new Date().toISOString() }],
    }), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);
    const sentMessages: string[] = [];
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      const urlStr = url as string;
      if (urlStr.includes('getUpdates')) {
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
                text: '/new solve the problem',
              },
            }] }),
            json: async () => ({ ok: true, result: [{
              update_id: 1,
              message: {
                message_id: 10,
                chat: { id: 123, type: 'private' },
                date: Math.floor(Date.now() / 1000),
                text: '/new solve the problem',
              },
            }] }),
          };
        }
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }

      if (urlStr.includes('sendMessage')) {
        const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {};
        if (body.text) sentMessages.push(body.text);
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 100 } }),
          json: async () => ({ ok: true, result: { message_id: 100 } }),
        };
      }

      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    // Same ambient startup sweep as the bare /new test above (this test also pre-writes a
    // topic-state file for thread 0 with no model_status).
    assert.equal(sentMessages.length, 2, `expected the sweep's pin refresh plus the dispatched reply; got ${JSON.stringify(sentMessages)}`);
    assert.ok(sentMessages.some(m => m.includes('worker reply')));
  });

  it('handles /new replying to a message with Ref ID: seeds historical turns', async () => {
    // 1. Seed app.log.jsonl with ref mapping
    const appLogFile = join(tempDir, 'app.log.jsonl');
    await writeFile(appLogFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      module: 'bot',
      message: 'message sent',
      refId: 's-seed1234',
      session_id: 'hist-session-999',
    }) + '\n', 'utf8');

    // 2. Seed conversation-history.jsonl with historical turns
    const archiveFile = join(tempDir, 'conversation-history.jsonl');
    await writeFile(archiveFile, JSON.stringify({
      role: 'user',
      text: 'historical question',
      timestamp: new Date().toISOString(),
      thread_id: 0,
      session_id: 'hist-session-999',
    }) + '\n' + JSON.stringify({
      role: 'assistant',
      text: 'historical answer',
      timestamp: new Date().toISOString(),
      thread_id: 0,
      session_id: 'hist-session-999',
    }) + '\n', 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);
    const sentMessages: string[] = [];
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      const urlStr = url as string;
      if (urlStr.includes('getUpdates')) {
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
                text: '/new',
                reply_to_message: {
                  message_id: 5,
                  text: 'Here is your previous response\n\n_Ref: s-seed1234_',
                },
              },
            }] }),
            json: async () => ({ ok: true, result: [{
              update_id: 1,
              message: {
                message_id: 10,
                chat: { id: 123, type: 'private' },
                date: Math.floor(Date.now() / 1000),
                text: '/new',
                reply_to_message: {
                  message_id: 5,
                  text: 'Here is your previous response\n\n_Ref: s-seed1234_',
                },
              },
            }] }),
          };
        }
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }

      if (urlStr.includes('sendMessage')) {
        const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {};
        if (body.text) sentMessages.push(body.text);
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 100 } }),
          json: async () => ({ ok: true, result: { message_id: 100 } }),
        };
      }

      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].includes('seeded with 2 turn'));

    const stateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    const saved = JSON.parse(await readFile(stateFile, 'utf8')) as ConversationState;
    assert.equal(saved.session, undefined);
    assert.equal(saved.turns.length, 3); // 2 seeded + 1 assistant reply
    assert.equal(saved.turns[0].text, 'historical question');
  });

  it('handles /code commands: show, set valid dir, reject invalid dir, reset', async () => {
    const controller = new AbortController();
    const state = makeState(123, -1);
    const sentMessages: string[] = [];
    let getUpdatesCount = 0;

    const updates = [
      { update_id: 1, message: { message_id: 10, chat: { id: 123, type: 'private' }, date: 1, text: '/code' } },
      { update_id: 2, message: { message_id: 11, chat: { id: 123, type: 'private' }, date: 2, text: `/code "${tempDir}"` } },
      { update_id: 3, message: { message_id: 12, chat: { id: 123, type: 'private' }, date: 3, text: '/code /invalid/dir/nonexistent/123' } },
      { update_id: 4, message: { message_id: 13, chat: { id: 123, type: 'private' }, date: 4, text: '/code reset' } },
    ];

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      const urlStr = url as string;
      if (urlStr.includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount <= updates.length) {
          const item = updates[getUpdatesCount - 1];
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [item] }),
            json: async () => ({ ok: true, result: [item] }),
          };
        }
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }

      if (urlStr.includes('sendMessage')) {
        const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {};
        if (body.text) sentMessages.push(body.text);
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 100 } }),
          json: async () => ({ ok: true, result: { message_id: 100 } }),
        };
      }

      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    assert.equal(sentMessages.length, 4);
    assert.ok(sentMessages[0].includes('Current working directory:'));
    assert.ok(sentMessages[1].includes('Working directory set to:'));
    assert.ok(sentMessages[2].includes('Directory not found:'));
    assert.ok(sentMessages[3].includes('Cleared folder scope'));
  });

  it('handles /status, /skills, /help read-only commands locally', async () => {
    const controller = new AbortController();
    const state = makeState(123, -1);
    const sentMessages: string[] = [];
    let getUpdatesCount = 0;

    const updates = [
      { update_id: 1, message: { message_id: 10, chat: { id: 123, type: 'private' }, date: 1, text: '/status' } },
      { update_id: 2, message: { message_id: 11, chat: { id: 123, type: 'private' }, date: 2, text: '/skills' } },
      { update_id: 3, message: { message_id: 12, chat: { id: 123, type: 'private' }, date: 3, text: '/help' } },
    ];

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      const urlStr = url as string;
      if (urlStr.includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount <= updates.length) {
          const item = updates[getUpdatesCount - 1];
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [item] }),
            json: async () => ({ ok: true, result: [item] }),
          };
        }
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        };
      }

      if (urlStr.includes('sendMessage')) {
        const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {};
        if (body.text) sentMessages.push(body.text);
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 100 } }),
          json: async () => ({ ok: true, result: { message_id: 100 } }),
        };
      }

      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    assert.equal(sentMessages.length, 3);
    assert.ok(sentMessages[0].includes('📌 Topic Status'));
    assert.ok(sentMessages[1].includes('*Scheduled Skills*'));
    assert.ok(sentMessages[2].includes('*Available Commands*'));
  });

  it('/claims spawns the real pa CLI via execPaCommand and returns its actual output (AI-171 phase B: require()-in-ESM regression)', async () => {
    // execPaCommand/execPaRef (main.ts) used to call `require('node:child_process')` /
    // `require('node:path')` inline — this package is ESM ("type":"module"), so `require`
    // is undefined at runtime. The call threw, was swallowed by execPaCommand's own
    // try/catch, and silently degraded to "Error: require is not defined" for every
    // /health, /claims, and /ref reply (and, via the same `require('node:path')` pattern
    // in the document/photo attachment branch, every doc/photo upload since 2026-08-18).
    // Fixed by converting to top-level ESM imports. This test exercises the REAL /claims
    // code path end to end (no mocking of execFileSync — matches this file's existing
    // convention of letting real subprocesses run, e.g. generateDescriptionWithLLM's own
    // unmocked execFile calls elsewhere in this suite) so a regression back to `require`
    // fails loudly here instead of degrading silently again.
    const controller = new AbortController();
    const state = makeState(123, -1);
    const sentMessages: string[] = [];
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      const urlStr = url as string;
      if (urlStr.includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ok: true, result: [{
              update_id: 1,
              message: { message_id: 10, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/claims' },
            }] }),
            json: async () => ({ ok: true, result: [{
              update_id: 1,
              message: { message_id: 10, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/claims' },
            }] }),
          };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if (urlStr.includes('sendMessage')) {
        const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {};
        if (body.text) sentMessages.push(body.text);
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 100 } }), json: async () => ({ ok: true, result: { message_id: 100 } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    assert.equal(sentMessages.length, 1, `expected exactly one reply to /claims. Got: ${JSON.stringify(sentMessages)}`);
    assert.ok(!sentMessages[0].includes('require is not defined'), `execPaCommand must not fail with the ESM require bug; got: ${sentMessages[0]}`);
    // In THIS test harness, execFileSync's `cwd` (BOT_CWD, frozen at module-import time to
    // whatever process.cwd() was when this test file's node subprocess started) is the bot
    // package directory, not the repo root — scripts/run-tests.mjs deliberately spawns
    // test files with cwd: botRoot. Production sidesteps this the same way an earlier,
    // already-fixed BOT_CWD bug was sidestepped: run-bot-hidden.vbs sets
    // WshShell.CurrentDirectory to the repo root before node ever starts, so
    // 'pa/dist/bin/pa.js' resolves correctly there. It can't resolve from inside this test
    // process, so the assertion this test CAN make is narrower but still proves the fix:
    // Node's own module-resolution error ("Cannot find module") can only be reached if
    // execFileSync (the top-level ESM import) actually ran and spawned a real subprocess —
    // a still-broken `require('node:child_process')` would throw a ReferenceError before
    // execFileSync is ever called, never getting this far.
    assert.match(sentMessages[0], /Cannot find module|Active reservations/i, `expected execFileSync to have actually run (either resolving the real pa CLI, or failing with Node's own module-resolution error — never a require ReferenceError); got: ${sentMessages[0]}`);
  });

  it('a document attachment downloads successfully via the top-level `dirname` import (AI-171 phase B: require()-in-ESM regression)', async () => {
    // The document/photo attachment branch (main.ts, "WPE3" comment) used to call
    // `require('node:path')` inline to get `dirname` for the parent-directory mkdir before
    // download — same ESM-require bug as execPaCommand above, but silently degrading every
    // doc/photo upload to "[Attachment X failed to download — see pa-alerts log.]" since
    // 2026-08-18 (caught by the same try/catch that hides the ReferenceError). Unlike
    // execPaCommand, this path never shells out to the real pa CLI — downloadFile
    // (telegram.ts) is a pure fetch + Node stream pipeline, so it's fully mockable per this
    // suite's existing voice-attachment convention (Readable.from a fake body) with no
    // BOT_CWD/cwd caveat needed.
    await writeFile(join(tempDir, 'config.yaml'), JSON.stringify({ workers: [{ name: 'claude', command: 'node', args: ['-e', 'process.stdout.write("ok")'], check: 'node -e 0' }] }), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);
    const sentMessages: string[] = [];
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      const urlStr = url as string;
      if (urlStr.includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          const payload = { ok: true, result: [{
            update_id: 1,
            message: {
              message_id: 10,
              chat: { id: 123, type: 'private' },
              date: Math.floor(Date.now() / 1000),
              document: { file_id: 'FILE123', file_unique_id: 'UNIQ123', file_name: 'report.pdf' },
            },
          }] };
          return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if (urlStr.includes('/getFile?file_id=')) {
        const payload = { ok: true, result: { file_path: 'documents/report.pdf' } };
        return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
      }
      if (urlStr.includes('/file/bot')) {
        return { ok: true, status: 200, body: Readable.from(Buffer.from('fake-pdf-bytes')), text: async () => '', json: async () => ({}) };
      }
      if (urlStr.includes('sendMessage')) {
        const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {};
        if (body.text) sentMessages.push(body.text);
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 100 } }), json: async () => ({ ok: true, result: { message_id: 100 } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const saved = JSON.parse(await readFile(join(tempDir, 'telegram-bot-topic-123_0.json'), 'utf8')) as ConversationState;
    const archivedText = saved.turns.find((t) => t.role === 'user')?.text ?? '';
    assert.ok(!archivedText.includes('failed to download'), `attachment download must succeed, not silently degrade via the ESM require bug; got: ${archivedText}`);
    // destPath is named by file_unique_id, not the original filename (voiceAttachmentPath) —
    // real observed value: "[Attachment: report.pdf at .../attachments/123/<date>/UNIQ123.pdf]".
    assert.match(archivedText, /\[Attachment: report\.pdf at .*UNIQ123\.pdf\]/, `expected the success-path attachment line; got: ${archivedText}`);
  });

  it('/update_brain in hard-exempt topic returns refusal without dispatching', async () => {
    const topicKey = '-1001234567890_29';
    const stateFile = join(tempDir, `telegram-bot-topic${topicKey}.json`);
    await writeFile(stateFile, JSON.stringify({
      chat_id: -1001234567890,
      thread_id: 29,
      turns: [],
    }), 'utf8');
    // AI-171 phase B: the dark-file recheck's skip diagnosed "expected 1 refusal, got 0"
    // as possible drift in the exemption check itself, but getTopicExemptions()
    // (topic-brains.ts) reads $PA_HOME/topic-brains/EXEMPT.json and returns an EMPTY map
    // whenever that file is missing (never throws) — this test never wrote the fixture at
    // all, so the topic was never actually exempt and fell through to the 'stage' path.
    // The exemption-check code itself is correct; the test fixture was the bug.
    await mkdir(join(tempDir, 'topic-brains'), { recursive: true });
    await writeFile(join(tempDir, 'topic-brains', 'EXEMPT.json'), JSON.stringify({ [topicKey]: 'output-only' }), 'utf8');

    const controller = new AbortController();
    const state = makeState(-1001234567890, -1);
    const sentMessages: string[] = [];
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      const urlStr = url as string;
      if (urlStr.includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          const payload = { ok: true, result: [{
            update_id: 1,
            message: {
              message_id: 10,
              chat: { id: -1001234567890, type: 'supergroup' },
              message_thread_id: 29,
              date: 1719602000,
              text: '/update_brain',
            },
          }]};
          // AI-171 phase B: this mock was missing `json()` — getUpdates() (telegram.ts)
          // calls res.json(), which threw on a plain object without that method, so the
          // update was silently dropped inside runPollLoop's per-iteration try/catch
          // before ever reaching the /update_brain handler. That, not a real handler
          // regression, is why the dark-file recheck observed 0 sends.
          return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload } as Response;
        }
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        } as Response;
      }

      if (urlStr.includes('sendMessage')) {
        const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {};
        if (body.text) sentMessages.push(body.text);
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 100 } }),
          json: async () => ({ ok: true, result: { message_id: 100 } }),
        } as Response;
      }

      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      } as Response;
    };

    await runPollLoop('token', [-1001234567890], state, {}, controller.signal, fastSleep);

    assert.equal(sentMessages.length, 1);
    // sendMessage MarkdownV2-sanitizes the response before it reaches the wire, so the
    // literal reply carries backslash escapes before '-' and '.' (e.g. "output\-only\).").
    // Strip them before matching, same fix as the /model pinned-card escaping issue.
    assert.match(sentMessages[0].replace(/\\/g, ''), /🚫.*exempt from topic brains.*output-only/);
  });

  it('/update_brain stages learnings for non-exempt topics (rewrites userText and dispatches)', async () => {
    // AI-171 phase B: the dark-file recheck's skip diagnosed "expected 1 dispatch, got 0"
    // as drift in the staging/dispatch flow, but this test's own dispatch-verification
    // mechanism was broken from the start — worker dispatch is a spawned subprocess
    // (pa's executeWorker, via `command`/`args` in config.yaml), never an HTTP call, so
    // the `urlStr.includes('executeWorker') || urlStr.includes('claude')` fetch branch
    // could never fire. Rewritten to the proven echo-worker pattern already used
    // elsewhere in this file (see the queue/fold describe above): a stdin-text worker
    // that echoes the exact prompt it received, verified via its reply once it comes
    // back through sendMessage. Also: getEffectiveDefaultWorker needs this topic's own
    // topic_defaults entry — the shared beforeEach's config.yaml has no entry for THIS
    // topicKey, so this test needs its own config.yaml (overriding the shared one).
    // Also: with no topic-brains/<topicKey>/BRAIN.md fixture seeded, getTopicBrainInfo
    // returns null, so main.ts STRIPS the whole "<BRAIN_PATH_ABS>" sentence rather than
    // substituting into it (see main.ts's /update_brain block) — the original test's
    // assertion that the dispatched instruction contains the literal placeholder was
    // never reachable either.
    const topicKey = '-1001234567890_8306';
    const stateFile = join(tempDir, `telegram-bot-topic${topicKey}.json`);
    await writeFile(stateFile, JSON.stringify({
      chat_id: -1001234567890,
      thread_id: 8306,
      turns: [],
    }), 'utf8');

    const workerScript = join(tempDir, 'echo-worker.mjs');
    await writeFile(workerScript, [
      "let d = '';",
      "process.stdin.on('data', c => { d += c; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write('GOTPROMPTSTART' + d + 'GOTPROMPTEND');",
      '  process.exit(0);',
      '});',
    ].join('\n'), 'utf8');

    await writeFile(join(tempDir, 'config.yaml'), `
workers:
  - name: claude
    input_mode: stdin-text
    command: node
    args: ["${workerScript.replace(/\\/g, '/')}"]
    check: node -e "process.exit(0)"
topic_defaults:
  "${topicKey}": "claude"
`, 'utf8');

    const controller = new AbortController();
    const state = makeState(-1001234567890, -1);
    const sentMessages: string[] = [];
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      const urlStr = url as string;
      if (urlStr.includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          const payload = { ok: true, result: [{
            update_id: 1,
            message: {
              message_id: 10,
              chat: { id: -1001234567890, type: 'supergroup' },
              message_thread_id: 8306,
              date: 1719602000,
              text: '/update_brain',
            },
          }]};
          return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload } as Response;
        }
        controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: [] }),
          json: async () => ({ ok: true, result: [] }),
        } as Response;
      }

      if (urlStr.includes('sendMessage')) {
        const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {};
        if (body.text) sentMessages.push(body.text);
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 100 } }),
          json: async () => ({ ok: true, result: { message_id: 100 } }),
        } as Response;
      }

      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      } as Response;
    };

    await runPollLoop('token', [-1001234567890], state, {}, controller.signal, fastSleep);

    // handleUpdateBrainCommand's 'stage' response text is never read by main.ts (only
    // the 'refusal' branch sends its response — a dead field on the 'stage' variant,
    // same class of unused wiring as logic.ts's handleModelSwitch; flagged, not fixed
    // here). Two real sends happen for a brand-new topic: the pinned status card
    // (first-ever message in this topic) and the dispatched worker's echoed reply —
    // which is itself split across multiple sendMessage calls by Telegram's chunking,
    // since the real dispatch prompt includes the full system-prompt/capabilities
    // boilerplate. Concatenate the non-pin sends to recover the whole echoed prompt.
    const pinMsgs = sentMessages.filter((m) => m.includes('Topic Status'));
    const echoedPrompt = sentMessages.filter((m) => !m.includes('Topic Status')).join('');
    assert.equal(pinMsgs.length, 1, 'a brand-new topic should get exactly one pinned status card');
    assert.match(echoedPrompt, /GOTPROMPTSTART[\s\S]*GOTPROMPTEND/, 'reply must be the echoed dispatch prompt');
    // handleUpdateBrainCommand's `instruction` field (what actually gets dispatched) opens
    // with "Capture this topic's durable learnings" — distinct from its `response` field
    // ("Capture this topic's learnings for its topic brain", the dead-and-unsent text above).
    assert.match(echoedPrompt, /Capture this topic's durable learnings/, 'dispatched prompt must be the rewritten instruction');
    assert.ok(!echoedPrompt.includes('<BRAIN_PATH_ABS>'), 'placeholder must be stripped, not left literal, when no topic brain exists');
  });
});

// ---------------------------------------------------------------------------
// AI-190 (2026-09-03): /debug intercepts pre-dispatch — operator-only, files a
// topic-task to pa-support with the target's ref-ID as the debug handle, and
// never dispatches a worker in the asking topic.
// ---------------------------------------------------------------------------

describe('runPollLoop: /debug interception (AI-190)', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-debug-'));
    process.env.PA_HOME = tempDir;
    // The support topic is config-only since the frozen fallback was removed
    // (AI-190 follow-up): the operator subtest files into `topics.support`, and
    // the non-operator one must get PAST the config check to reach the operator
    // gate. Key is single-quoted so YAML parses it as a string, not a number.
    await writeFile(
      join(tempDir, 'config.yaml'),
      "topics:\n  support: '-1001234567890_5001'\n",
      'utf8'
    );
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  function debugUpdates(fromId: number): Array<{ ok: boolean; bodyJson: unknown }> {
    const update = {
      update_id: 1,
      message: {
        message_id: 20,
        from: { id: fromId, first_name: 'Operator' },
        chat: { id: 123, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/debug',
        reply_to_message: {
          message_id: 19,
          from: { id: 777000, is_bot: true, first_name: 'PA' },
          chat: { id: 123, type: 'private' },
          date: Math.floor(Date.now() / 1000) - 60,
          text: 'Worker reply body\n\n_Ref: s-1a2b3c4d5e6f_',
        },
      },
    };
    return [
      { ok: true, bodyJson: { ok: true, result: [update] } },
      { ok: true, bodyJson: { ok: true, result: [] } },
    ];
  }

  it('the operator filing a /debug reply gets exactly one local confirmation, a queued support task, and NO worker dispatch', async () => {
    const controller = new AbortController();
    const state = makeState(123, -1);
    const sentMessages: string[] = [];
    let step = 0;
    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      const urlStr = url as string;
      if (urlStr.includes('getUpdates')) {
        const responses = debugUpdates(42); // the operator
        const item = responses[Math.min(step++, responses.length - 1)];
        if (step >= responses.length) controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify(item.bodyJson),
          json: async () => item.bodyJson,
        };
      }
      if (urlStr.includes('sendMessage')) {
        const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {};
        if (body.text) sentMessages.push(body.text);
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 100 } }),
          json: async () => ({ ok: true, result: { message_id: 100 } }),
        };
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    await runPollLoop('token', [123], state, { PA_OPERATOR_USER_ID: '42' }, controller.signal, fastSleep);

    assert.equal(sentMessages.length, 1, `exactly one local reply, no worker dispatch. Got: ${JSON.stringify(sentMessages)}`);
    // Captured send bodies are MdV2-escaped — strip backslashes before substring asserts.
    const confirmation = sentMessages[0].replace(/\\/g, '');
    assert.ok(confirmation.includes('Debug task tt-'), `confirmation must carry the task id: ${confirmation}`);
    assert.ok(confirmation.includes('s-1a2b3c4d5e6f'), 'confirmation must carry the debug handle');

    // The task really landed on the pa-support queue (fallback key; no config.yaml here).
    const queue = JSON.parse(await readFile(join(tempDir, 'topic-tasks', '-1001234567890_5001.json'), 'utf8')) as Array<{ title: string; prompt: string; created_by: string }>;
    assert.equal(queue.length, 1);
    assert.ok(queue[0].prompt.includes('pa ref s-1a2b3c4d5e6f'), 'the ref-ID rides the prompt as the debug handle');
    assert.ok(queue[0].prompt.includes('question action'), 'the executor contract rides the prompt');
    assert.equal(queue[0].created_by, 'operator');
  });

  it('a non-operator /debug is refused locally and files nothing', async () => {
    const controller = new AbortController();
    const state = makeState(123, -1);
    const sentMessages: string[] = [];
    let step = 0;
    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: any) => {
      const urlStr = url as string;
      if (urlStr.includes('getUpdates')) {
        const responses = debugUpdates(999); // NOT the operator
        const item = responses[Math.min(step++, responses.length - 1)];
        if (step >= responses.length) controller.abort();
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify(item.bodyJson),
          json: async () => item.bodyJson,
        };
      }
      if (urlStr.includes('sendMessage')) {
        const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {};
        if (body.text) sentMessages.push(body.text);
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 100 } }),
          json: async () => ({ ok: true, result: { message_id: 100 } }),
        };
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, result: true }),
        json: async () => ({ ok: true, result: true }),
      };
    };

    await runPollLoop('token', [123], state, { PA_OPERATOR_USER_ID: '42' }, controller.signal, fastSleep);

    assert.equal(sentMessages.length, 1, 'exactly the refusal reply, nothing else');
    const refusal = sentMessages[0].replace(/\\/g, '');
    assert.ok(refusal.includes('operator-only'), `refusal text expected: ${refusal}`);
    const exists = await stat(join(tempDir, 'topic-tasks', '-1001234567890_5001.json')).then(() => true, () => false);
    assert.equal(exists, false, 'no queue file may be created for a non-operator');
  });
});
