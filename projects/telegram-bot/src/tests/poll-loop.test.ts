import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runPollLoop, extractReplyContext, generateDescriptionSuggestion, isValidDescriptionOutput, parseDescriptionLLMOutput, postDescriptionSuggestion } from '../main.js';
import { loadBranches, type BranchIndex } from '../topic-names.js';
import type { ConversationState } from '../types.js';

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
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
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
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
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
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
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
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
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
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
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
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
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
  });

  afterEach(async () => {
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
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
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('pins a midnight-reset status card during the startup sweep without an inbound message', async () => {
    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const topicState = {
      chat_id: 123,
      thread_id: 0,
      turns: [],
      preferred_worker: 'gemini',
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

    const unpinCalls = calledUrls.filter(u => u.includes('unpinChatMessage'));
    const pinCalls = calledUrls.filter(u => u.includes('/pinChatMessage'));

    assert.strictEqual(unpinCalls.length, 1, 'should unpin the old model indicator');
    assert.strictEqual(pinCalls.length, 1, 'should pin the midnight-reset status card');

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
      preferred_worker: 'gemini', preferred_worker_set_at: yesterday,
    };
    const foreignState = {
      chat_id: 999, thread_id: 5, turns: [],
      preferred_worker: 'gemini', preferred_worker_set_at: yesterday,
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
    assert.equal(savedForeign.preferred_worker, 'gemini', 'foreign topic untouched');
    // No sendMessage should target chat 999
    assert.ok(!sendMessageBodies.some((b) => b.includes('"chat_id":999')), 'no sendMessage to foreign chat');
  });

  it('continues sweeping other topics when one topic-state file is corrupt', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const corruptFile = join(tempDir, 'telegram-bot-topic-123_1.json');
    const validFile = join(tempDir, 'telegram-bot-topic-123_2.json');
    const validState = {
      chat_id: 123, thread_id: 2, turns: [],
      preferred_worker: 'gemini', preferred_worker_set_at: yesterday,
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
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('posts and pins a fresh status card on failover even when no pin exists yet', async () => {
    // Use gemini as the first worker because its rate-limit classifier uses text matching
    // (looks for "429" in stderr), so we can trigger it reliably without JSONL session files.
    const configPath = join(tempDir, 'config.yaml');
    // Write helper scripts to temp dir to avoid shell quoting complexity
    const failScript = join(tempDir, 'fail-worker.mjs');
    const succeedScript = join(tempDir, 'succeed-worker.mjs');
    await writeFile(failScript, 'process.stderr.write("RESOURCE_EXHAUSTED"); process.exit(1);\n', 'utf8');
    await writeFile(succeedScript, 'process.stdout.write("zclaude response"); process.exit(0);\n', 'utf8');

    await writeFile(configPath, `
workers:
  - name: gemini
    command: node
    args: ["${failScript.replace(/\\/g, '/')}"]
    check: node -e "process.exit(0)"
    rate_limit_patterns: ["RESOURCE_EXHAUSTED"]
  - name: zclaude
    command: node
    args: ["${succeedScript.replace(/\\/g, '/')}"]
    check: node -e "process.exit(0)"
topic_defaults:
  "123_0": "gemini"
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
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
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
  - name: gemini
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
    assert.equal(saved.turns.length, 1, 'only the user command should remain in topic history');
    assert.equal(saved.turns[0].text, '/model claude');
    assert.ok(saved.turns.every((turn) => !turn.text.startsWith('📌')), 'status cards must stay out of conversation history');
  });
});


describe('runPollLoop: DLQ', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-dlq-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  /** URL-aware fetch: sendMessage fails with Forbidden; everything else succeeds. */
  function setupUrlAwareFetch(controller: AbortController): void {
    let getUpdatesCount = 0;
    const update = {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 123, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/default',
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
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
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
    await rm(tempDir, { recursive: true, force: true });
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
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
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
    const userDescription = 'Research notes and links for the Interloom project partnership';
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
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
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
          const m = new Map<string, Map<number, { name: string }>>();
          for (const [cid, threads] of Object.entries(opts.topicNamesData as Record<string, Record<string, string>>)) {
            const inner = new Map<number, { name: string }>();
            for (const [tid, name] of Object.entries(threads)) {
              inner.set(parseInt(tid, 10), { name });
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
    // hyphens are escaped by sanitizeMdV2; check for unhyphenated parts
    assert.ok(sendCalls[0].body.includes('Linked') || sendCalls[0].body.includes('branch'), 'response must confirm parent link');

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
    assert.ok(sendCalls[0].body.includes('valid-parent') || sendCalls[0].body.includes('Merged'), 'response must mention merge');

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
  });

  afterEach(async () => {
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('same-topic updates: second processUpdate does not start until first completes', async () => {
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

    // Allow the loop to process the first batch and reach the sendMessage gate
    await new Promise(r => setTimeout(r, 150));

    // With per-topic serialization: update2 has NOT started, so only 1 sendMessage fired
    assert.equal(
      sendMessageCountAtGate,
      1,
      `expected sendMessageCountAtGate=1 (update2 must not have started while update1 is in-flight), got ${sendMessageCountAtGate}`
    );

    // Release the gate — update1 finishes, then update2 runs
    resolveGate();
    await loopDone;

    assert.equal(sendMessageCallCount, 2, 'both sendMessages must fire after serialization completes');
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
    assert.equal(isValidDescriptionOutput('Debugging the Gemini worker, Gemini-specific issues, and failover routing considerations.'), true);
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
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
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

    // Must NOT post description to thread 999
    const descMsgs = fetchLog.filter(e =>
      e.url.includes('sendMessage') &&
      e.body.includes('"message_thread_id":999') &&
      (e.body.includes('description') || e.body.includes("for?"))
    );
    assert.equal(descMsgs.length, 0, 'must not post description to branch topic');

    // State for thread 999 must have ancestry (written by /branch handler)
    const raw = await readFile(join(tempDir, 'telegram-bot-topic-123_999.json'), 'utf8');
    const saved = JSON.parse(raw);
    assert.ok(saved.ancestry, 'ancestry must be set on branch topic state');
    assert.equal(saved.ancestry.branchName, 'test-race');
  });

  it('manual topic: forum_topic_created posts description prompt', async () => {
    // Verify that for a non-branch topic, forum_topic_created still posts the
    // "What's it for?" prompt (generateDescriptionWithLLM fails in tests →
    // confident:false → open-ended prompt is sent).
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

    // Must send a description prompt to thread 888
    const descMsgs = fetchLog.filter(e =>
      e.url.includes('sendMessage') &&
      e.body.includes('"message_thread_id":888')
    );
    assert.ok(descMsgs.length > 0, 'must send description prompt to manual topic');
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
