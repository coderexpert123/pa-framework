import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, unlink } from 'fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Readable } from 'node:stream';
import {
  absorbHeldEntries,
  _clearQueueForTest,
  _clearHeldForTest,
  _setLoggerForTest,
} from '../topic-queue.js';
import { markTopicStopped, _clearStoppedForTest } from '../worker-stop.js';
import { _resetPendingDispatchesForTest } from '../pending-dispatches.js';
import { logger } from '../../../../pa/dist/src/lib/log.js';
import { listWorkerPids } from '../../../../pa/dist/src/worker-pids.js';
import { waitForDrain } from './test-teardown-guard.js';
import { runPollLoop, _setExitForTest, placeholderDispatchText } from '../main.js';
import type { ConversationState } from '../types.js';

_setExitForTest(() => {});

function makeState(chatId = -1001234567890, lastUpdateId = -1, threadId = 5001): ConversationState {
  return { chat_id: chatId, last_update_id: lastUpdateId, thread_id: threadId, turns: [] };
}

const fastSleep = async (_ms: number): Promise<void> => {};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Fixture files for the end-to-end /stop hold cases. The echo worker reads its
 * stdin, sleeps, then replies — so a /stop arriving after the dispatch started
 * deterministically kills a RUNNING worker (the A6 in-flight flush needs the
 * worker to have been alive).
 */
async function writeStopFixtureFiles(tempDir: string): Promise<string> {
  const pythonStub = join(tempDir, 'transcribe_stub.py');
  await writeFile(
    pythonStub,
    [
      "import sys",
      "print('{\"ok\": true, \"text\": \"QUEUED_VOICE_THIRD_TRANSCRIPT\", \"engine\": \"whisper_local\", \"truncated\": false}')",
      "",
    ].join('\n'),
    'utf8',
  );
  process.env.PA_VOICE_TRANSCRIBE_SCRIPT = pythonStub;

  const capturePath = join(tempDir, 'prompt-capture.txt');
  const workerScript = join(tempDir, 'echo-worker.cjs');
  await writeFile(
    workerScript,
    [
      "const fs = require('node:fs');",
      "let d = '';",
      "process.stdin.on('data', c => { d += c; });",
      "process.stdin.on('end', async () => {",
      `  fs.appendFileSync(${JSON.stringify(capturePath)}, 'GOTPROMPTSTART' + d + 'GOTPROMPTEND');`,
      "  await new Promise(r => setTimeout(r, 1500));",
      "  process.stdout.write('GOTPROMPTSTART' + d + 'GOTPROMPTEND');",
      "  process.exit(0);",
      '});',
    ].join('\n'),
    'utf8',
  );

  const posixWorker = workerScript.replace(/\\/g, '/');
  await writeFile(
    join(tempDir, 'config.yaml'),
    `
workers:
  - name: claude
    input_mode: stdin-text
    command: node
    args: ["${posixWorker}"]
    check: node -e "process.exit(0)"
topic_defaults:
  "-1001234567890_5001": "claude"
`,
    'utf8',
  );

  const topicStateFile = join(tempDir, 'telegram-bot-topic--1001234567890_5001.json');
  await writeFile(topicStateFile, JSON.stringify({ chat_id: -1001234567890, thread_id: 5001, turns: [] }), 'utf8');
  return capturePath;
}

/**
 * The LAST captured worker prompt — the probe dispatch's stdin (earlier blocks
 * are the killed first dispatch's). Isolated from echo/ack messages.
 */
function readLastWorkerPrompt(capturePath: string): string {
  const raw = readFileSync(capturePath, 'utf8');
  const start = raw.lastIndexOf('GOTPROMPTSTART');
  const end = raw.lastIndexOf('GOTPROMPTEND');
  assert.ok(start !== -1 && end !== -1, `worker must have been dispatched. Capture: ${raw}`);
  return raw.slice(start + 'GOTPROMPTSTART'.length, end);
}

/** Count of complete prompt blocks captured so far. */
function countCaptureBlocks(capturePath: string): number {
  try {
    return readFileSync(capturePath, 'utf8').split('GOTPROMPTEND').length - 1;
  } catch {
    return 0;
  }
}

/** True once TWO prompt blocks are captured (killed dispatch + probe dispatch). */
function captureComplete(capturePath: string): boolean {
  return countCaptureBlocks(capturePath) >= 2;
}

/** Hard wall-clock ceiling for the WHOLE mock, checked on every getUpdates
 * call regardless of phase — a stuck phase 1 (registration never appears),
 * phase 2 (ack never sent) or phase 3 (capture never completes) all abort
 * and report a clear error instead of spinning `runPollLoop`'s
 * `while (!signal.aborted)` loop forever. Generous on purpose — this must
 * never be the thing that makes the test flaky; a real stall past this is a
 * genuine defect, reported via a clear error rather than a silent hang. */
const MOCK_HARD_TIMEOUT_MS = 15_000;

/**
 * Phase-driven Telegram mock for the /stop scenarios:
 *  phase 0 → first batch (the message whose dispatch gets killed);
 *  after the dispatch's first sendChatAction, once the killed dispatch's
 *    worker has actually REGISTERED in pa's worker-pids registry (the same
 *    registry /stop's stopTopicWorkers snapshots to find something to kill)
 *    → second batch (queued entries + /stop);
 *  after the stop ack was sent → third batch (the next dispatch's probe message);
 *  after the probe's worker echo arrived → abort the poll loop.
 *
 * Registration readiness (not a wall-clock guess): sendChatAction fires from
 * sendTyping() BEFORE the worker is spawned and registered by addWorkerPid
 * (pa/src/worker-exec.ts) — a fixed post-sendChatAction delay is a race
 * against however long that spawn+registration actually takes on this host
 * under this load, and can fire before the entry exists (killed=0, ack reads
 * "Held N" instead of "Stopped … and held N", S1's first assertion fails
 * non-deterministically). Polling listWorkerPids() (pa's own registry, same
 * PA_HOME as the code under test) for the killed dispatch's topic resource is
 * the actual signal /stop depends on, so it can't be ready-but-still-fail.
 *
 * Every empty poll response resolves through a REAL setTimeout: with the test
 * fastSleep, a synchronous empty response makes the poll loop spin in pure
 * microtasks, which starves the event loop — in-flight turns' fs/timer
 * continuations (blackboard proper-lockfile, dispatch spawns) never run and the
 * scenario deadlocks (observed 2026-09-06: processUpdate stuck inside
 * blackboard.acquireLock for the whole 600s gate timeout).
 */
function makeStopFetchMock(
  controller: AbortController,
  sentTexts: string[],
  capturePath: string,
  firstBatch: unknown[],
  secondBatch: unknown[],
  thirdBatch: unknown[],
  topicKey: string,
): { fetch: (url: string, opts?: { body?: string }) => Promise<unknown>; timeoutError: () => Error | null } {
  let phase = 0;
  let dispatchStartedAt = 0;
  let stallError: Error | null = null;
  const mockCreatedAt = Date.now();
  const empty = { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
  const batchResponse = (result: unknown[]) => {
    const batch = { ok: true, result };
    return { ok: true, status: 200, text: async () => JSON.stringify(batch), json: async () => batch };
  };
  const fetchFn = async (url: string, opts?: { body?: string }) => {
    const u = url as string;
    if (u.includes('getUpdates')) {
      if (stallError === null && Date.now() - mockCreatedAt >= MOCK_HARD_TIMEOUT_MS) {
        stallError = new Error(
          `makeStopFetchMock stalled in phase ${phase} (topicKey="${topicKey}") — no terminal condition reached within ${MOCK_HARD_TIMEOUT_MS}ms`,
        );
        controller.abort();
        return empty;
      }
      if (phase === 0) {
        phase = 1;
        return batchResponse(firstBatch);
      }
      if (phase === 1 && dispatchStartedAt > 0) {
        const entries = await listWorkerPids();
        // Gate on the worker's FIRST captured block, not registration alone:
        // a slow runner (ubuntu CI, deterministic stall 2026-09-20) delivers
        // /stop's kill before the echo worker finishes booting and drains its
        // stdin — block 1 never exists and phase 3's two-block wait hangs.
        // Block 1 in the capture file is the strictly stronger readiness:
        // spawned, registered, stdin consumed, and inside its 1500ms tail
        // window — i.e. still killable when the /stop batch lands.
        if (entries.some((e) => e.skill === topicKey) && countCaptureBlocks(capturePath) >= 1) {
          phase = 2;
          return batchResponse(secondBatch);
        }
      }
      if (phase === 2 && sentTexts.some(t => t.includes('⏹'))) {
        phase = 3;
        return batchResponse(thirdBatch);
      }
      if (phase === 3 && captureComplete(capturePath)) {
        controller.abort();
      }
      await sleep(20);
      return empty;
    }
    if (u.includes('sendChatAction')) {
      dispatchStartedAt = Date.now();
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    }
    if (u.includes('sendMessage')) {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (body.text) sentTexts.push(body.text);
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 900 + sentTexts.length } }), json: async () => ({ ok: true, result: { message_id: 900 + sentTexts.length } }) };
    }
    if (u.includes('/getFile?file_id=')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { file_path: 'mock/voice.oga' } }), json: async () => ({ ok: true, result: { file_path: 'mock/voice.oga' } }) };
    }
    if (u.includes('/file/bot')) {
      return { ok: true, status: 200, body: Readable.from(Buffer.from('fake-ogg-audio')), text: async () => '', json: async () => ({}) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
  };
  return { fetch: fetchFn, timeoutError: () => stallError };
}

describe('steer-text-safety (AI-208 WP-5)', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;
  const savedHome = process.env.PA_HOME;
  const savedScriptEnv = process.env.PA_VOICE_TRANSCRIBE_SCRIPT;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-steer-text-'));
    process.env.PA_HOME = tempDir;
    _resetPendingDispatchesForTest();
    _clearQueueForTest();
    _clearHeldForTest();
    _clearStoppedForTest();
  });

  afterEach(async () => {
    await waitForDrain();
    if (savedHome !== undefined) {
      process.env.PA_HOME = savedHome;
    } else {
      delete process.env.PA_HOME;
    }
    if (savedScriptEnv !== undefined) {
      process.env.PA_VOICE_TRANSCRIBE_SCRIPT = savedScriptEnv;
    } else {
      delete process.env.PA_VOICE_TRANSCRIBE_SCRIPT;
    }
    _resetPendingDispatchesForTest();
    _clearQueueForTest();
    _clearHeldForTest();
    _clearStoppedForTest();
    _setLoggerForTest(null);
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('thrown-error stop holds the interrupted text (S2) — no generic-unavailable drop', async () => {
    const workerScript = join(tempDir, 'echo-worker.mjs');
    await writeFile(
      workerScript,
      "process.stdout.write('reply'); process.exit(0);",
      'utf8',
    );
    const posixWorker = workerScript.replace(/\\/g, '/');
    const configFile = join(tempDir, 'config.yaml');
    await writeFile(
      configFile,
      `
workers:
  - name: claude
    input_mode: stdin-text
    command: node
    args: ["${posixWorker}"]
    check: node -e "process.exit(0)"
topic_defaults:
  "-1001234567890_5001": "claude"
`,
      'utf8',
    );

    const topicStateFile = join(tempDir, 'telegram-bot-topic--1001234567890_5001.json');
    await writeFile(topicStateFile, JSON.stringify({ chat_id: -1001234567890, thread_id: 5001, turns: [] }), 'utf8');

    const controller = new AbortController();
    const state = makeState(-1001234567890, -1, 5001);

    const msg1 = {
      update_id: 1,
      message: {
        message_id: 101,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        text: 'INTERRUPTED_DISPATCH_TEXT_123',
      },
    };

    const warnings: Array<{ mod: string; msg: string; ctx?: any }> = [];
    const origWarn = logger.warn;
    logger.warn = (mod: string, msg: string, ctx?: any) => {
      warnings.push({ mod, msg, ctx });
      origWarn.call(logger, mod, msg, ctx);
    };

    let getUpdatesCount = 0;
    const sentTexts: string[] = [];

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
      const u = url as string;
      if (u.includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          const batch = { ok: true, result: [msg1] };
          return { ok: true, status: 200, text: async () => JSON.stringify(batch), json: async () => batch };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if (u.includes('sendChatAction')) {
        // Once dispatch has started (past the enqueue-time flush check), simulate
        // a stop landing mid-dispatch and cause dispatchMessage to throw.
        markTopicStopped('-1001234567890_5001', 'stop', 2);
        await unlink(configFile).catch(() => {});
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
      }
      if (u.includes('sendMessage')) {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.text) sentTexts.push(body.text);
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 900 + sentTexts.length } }), json: async () => ({ ok: true, result: { message_id: 900 + sentTexts.length } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    try {
      await runPollLoop('token', [-1001234567890], state, {}, controller.signal, fastSleep);

      const cleanSent = sentTexts.join('\n').replace(/\\/g, '');
      assert.ok(cleanSent.includes('⏹ Stopped.'), `must send Stopped message, got: ${cleanSent}`);
      assert.ok(!cleanSent.includes('Service temporarily unavailable'), 'must NOT send generic unavailable message');

      const held = await absorbHeldEntries('-1001234567890_5001');
      assert.deepEqual(held, [{ text: 'INTERRUPTED_DISPATCH_TEXT_123', updateId: 1 }], 'interrupted text must be held in topic-queue (with updateId — FX-A addendum: the S2 hold dedups against the durable record half)');

      const stopWarn = warnings.find(w => w.mod === 'worker-stop' && w.msg.includes('interrupted dispatch text held after thrown error'));
      assert.ok(stopWarn, 'must log worker-stop warning for interrupted dispatch text');
      assert.equal(stopWarn.ctx?.topicKey, '-1001234567890_5001');
      assert.equal(stopWarn.ctx?.chars, 'INTERRUPTED_DISPATCH_TEXT_123'.length);
    } finally {
      logger.warn = origWarn;
    }
  });

  it('/stop with [text, voice, text] holds all three in arrival order, no inline await (S1)', { timeout: 25_000 }, async () => {
    // M4: driven through the REAL /stop handler (runPollLoop) — the in-file
    // re-implementation of the drain-to-held loop is deleted. The killed first
    // message contributes the A6-held text; the two queued entries and the voice
    // note are held by the /stop drain itself, in arrival order, without inline
    // awaits (the stop ack below is sent BEFORE the voice prefetch resolves).
    const capturePath = await writeStopFixtureFiles(tempDir);

    const controller = new AbortController();
    const state = makeState(-1001234567890, -1, 5001);

    const msg1 = {
      update_id: 1,
      message: {
        message_id: 101,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        text: 'KILLED_TEXT_FIRST',
      },
    };
    const msg2 = {
      update_id: 2,
      message: {
        message_id: 102,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        text: 'QUEUED_TEXT_SECOND',
      },
    };
    const msg3 = {
      update_id: 3,
      message: {
        message_id: 103,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        voice: { file_id: 'v3_fid', file_unique_id: 'v3_fuid', duration: 12 },
      },
    };
    const stopMsg = {
      update_id: 4,
      message: {
        message_id: 104,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        text: '/stop',
      },
    };
    const probeMsg = {
      update_id: 5,
      message: {
        message_id: 105,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        text: 'NEXT_DISPATCH_PROBE',
      },
    };

    const sentTexts: string[] = [];
    const mock = makeStopFetchMock(
      controller,
      sentTexts,
      capturePath,
      [msg1],
      [msg2, msg3, stopMsg],
      [probeMsg],
      'topic--1001234567890_5001',
    );
    (globalThis as Record<string, unknown>).fetch = mock.fetch;

    await runPollLoop('token', [-1001234567890], state, {}, controller.signal, fastSleep);
    const timeoutError = mock.timeoutError();
    if (timeoutError) throw timeoutError;

    const cleanSent = sentTexts.join('\n').replace(/\\/g, '');
    assert.ok(cleanSent.includes('held 2 queued message(s)'), `stop ack must count the synchronously held entries, got: ${cleanSent}`);

    // The probe dispatch's prompt: held entries first (arrival order), then the
    // probe's own text. KILLED_TEXT_FIRST is present via the A6 flush, but its
    // position depends on when the killed worker's error surfaces, so it is
    // asserted for presence only.
    const prompt = readLastWorkerPrompt(capturePath);
    const iT1 = prompt.indexOf('KILLED_TEXT_FIRST');
    const iT2 = prompt.indexOf('QUEUED_TEXT_SECOND');
    const iV = prompt.indexOf('QUEUED_VOICE_THIRD_TRANSCRIPT');
    const iProbe = prompt.indexOf('NEXT_DISPATCH_PROBE');
    assert.ok(iT1 !== -1, 'A6-held text of the killed dispatch must be in the next prompt');
    assert.ok(iT2 !== -1 && iV !== -1 && iProbe !== -1, `all held texts and the probe must be in the prompt. Prompt: ${prompt}`);
    assert.ok(
      iT2 < iV && iV < iProbe,
      `queued entries must be absorbed in arrival order: text (${iT2}) then voice (${iV}) then probe (${iProbe})`,
    );
  });

  it('/stop → next dispatch: each held text appears exactly once in that prompt (M1: in-memory held + record absorb deduped)', { timeout: 25_000 }, async () => {
    // M1 regression: a /stop-held entry lives in BOTH the in-memory held list and
    // (flagged heldForTopic by E6) the durable pending-dispatch store. The
    // normalizer must dedup the two routes by updateId so each held text is
    // absorbed exactly once.
    const capturePath = await writeStopFixtureFiles(tempDir);

    const controller = new AbortController();
    const state = makeState(-1001234567890, -1, 5001);

    const msg1 = {
      update_id: 1,
      message: {
        message_id: 201,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        text: 'M1_KILLED_TEXT_FIRST',
      },
    };
    const msg2 = {
      update_id: 2,
      message: {
        message_id: 202,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        text: 'M1_QUEUED_TEXT_SECOND',
      },
    };
    const msg3 = {
      update_id: 3,
      message: {
        message_id: 203,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        voice: { file_id: 'm1v_fid', file_unique_id: 'm1v_fuid', duration: 8 },
      },
    };
    const stopMsg = {
      update_id: 4,
      message: {
        message_id: 204,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        text: '/stop',
      },
    };
    const probeMsg = {
      update_id: 5,
      message: {
        message_id: 205,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        text: 'M1_NEXT_DISPATCH_PROBE',
      },
    };

    const sentTexts: string[] = [];
    const mock = makeStopFetchMock(
      controller,
      sentTexts,
      capturePath,
      [msg1],
      [msg2, msg3, stopMsg],
      [probeMsg],
      'topic--1001234567890_5001',
    );
    (globalThis as Record<string, unknown>).fetch = mock.fetch;

    await runPollLoop('token', [-1001234567890], state, {}, controller.signal, fastSleep);
    const timeoutError = mock.timeoutError();
    if (timeoutError) throw timeoutError;

    const prompt = readLastWorkerPrompt(capturePath);
    const textCount = prompt.split('M1_QUEUED_TEXT_SECOND').length - 1;
    const voiceCount = prompt.split('QUEUED_VOICE_THIRD_TRANSCRIPT').length - 1;
    assert.equal(textCount, 1, `held text must appear exactly once (in-memory hold + durable record deduped), got ${textCount}. Prompt: ${prompt}`);
    assert.equal(voiceCount, 1, `held voice transcript must appear exactly once, got ${voiceCount}. Prompt: ${prompt}`);
    assert.ok(prompt.includes('M1_NEXT_DISPATCH_PROBE'), 'probe message must be in the prompt');
  });

  it('captionless photo steered → labeled [Photo] line in the prompt, not dropped (S5)', async () => {
    // Unit verification of placeholderDispatchText labeling
    assert.equal(placeholderDispatchText({ photo: [{ file_id: 'ph1' }] }), '[Photo]');
    assert.equal(placeholderDispatchText({ photo: [{ file_id: 'ph1' }], caption: 'dog' }), '[Photo] dog');
    assert.equal(placeholderDispatchText({ document: { file_id: 'doc1' } }), '[Document]');
    assert.equal(placeholderDispatchText({ document: { file_id: 'doc1' }, caption: 'sheet.pdf' }), '[Document] sheet.pdf');
    assert.equal(placeholderDispatchText({ video: { file_id: 'vid1' } }), '[Video]');
    assert.equal(placeholderDispatchText({ video: { file_id: 'vid1' }, caption: 'clip.mp4' }), '[Video] clip.mp4');
    assert.equal(placeholderDispatchText({ voice: { duration: 5 } }), '[Voice message]');
    assert.equal(placeholderDispatchText({ audio: { duration: 5 } }), '[Audio file]');
    assert.equal(placeholderDispatchText({ video_note: { duration: 5 } }), '[Video note]');
    assert.equal(placeholderDispatchText({ text: 'plain text' }), 'plain text');
    assert.equal(placeholderDispatchText({}), '');

    // End-to-end verification via runPollLoop. The worker captures the prompt it
    // receives to a file — the worker reply itself takes the rich-message path,
    // which this mock does not record.
    const capturePath = join(tempDir, 'prompt-capture.txt');
    const workerScript = join(tempDir, 'echo-worker.cjs');
    await writeFile(
      workerScript,
      [
        "const fs = require('node:fs');",
        "let d = '';",
        "process.stdin.on('data', c => { d += c; });",
        "process.stdin.on('end', () => {",
        `  fs.appendFileSync(${JSON.stringify(capturePath)}, 'GOTPROMPTSTART' + d + 'GOTPROMPTEND');`,
        "  process.exit(0);",
        '});',
      ].join('\n'),
      'utf8',
    );
    const posixWorker = workerScript.replace(/\\/g, '/');
    await writeFile(
      join(tempDir, 'config.yaml'),
      `
workers:
  - name: claude
    input_mode: stdin-text
    command: node
    args: ["${posixWorker}"]
    check: node -e "process.exit(0)"
topic_defaults:
  "-1001234567890_5001": "claude"
`,
      'utf8',
    );

    const topicStateFile = join(tempDir, 'telegram-bot-topic--1001234567890_5001.json');
    await writeFile(topicStateFile, JSON.stringify({ chat_id: -1001234567890, thread_id: 5001, turns: [] }), 'utf8');

    const controller = new AbortController();
    const state = makeState(-1001234567890, -1, 5001);

    const msg1 = {
      update_id: 1,
      message: {
        message_id: 101,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        text: 'first active message',
      },
    };
    const photoMsg = {
      update_id: 2,
      message: {
        message_id: 102,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'photo_fid_1', file_unique_id: 'photo_fuid_1' }],
      },
    };
    const steerMsg = {
      update_id: 3,
      message: {
        message_id: 103,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        text: '/steer describe this image please',
        reply_to_message: { message_id: 101 },
      },
    };

    let getUpdatesCount = 0;
    const sentTexts: string[] = [];

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
      const u = url as string;
      if (u.includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          const batch = { ok: true, result: [msg1, photoMsg, steerMsg] };
          return { ok: true, status: 200, text: async () => JSON.stringify(batch), json: async () => batch };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if (u.includes('sendMessage')) {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.text) sentTexts.push(body.text);
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 900 + sentTexts.length } }), json: async () => ({ ok: true, result: { message_id: 900 + sentTexts.length } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    await runPollLoop('token', [-1001234567890], state, {}, controller.signal, fastSleep);

    const prompt = readLastWorkerPrompt(capturePath);
    const cleanPrompt = prompt.replace(/\\/g, '');
    assert.ok(cleanPrompt.includes('[Photo]'), `prompt must contain labeled [Photo] line, got: ${cleanPrompt}`);
    assert.ok(cleanPrompt.includes('describe this image please'), `prompt must contain steer instruction, got: ${cleanPrompt}`);
  });

  it("non-stop thrown error keeps today's behaviour (no hold)", async () => {
    const workerScript = join(tempDir, 'echo-worker.mjs');
    await writeFile(
      workerScript,
      "process.stdout.write('reply'); process.exit(0);",
      'utf8',
    );
    const posixWorker = workerScript.replace(/\\/g, '/');
    const configFile = join(tempDir, 'config.yaml');
    await writeFile(
      configFile,
      `
workers:
  - name: claude
    input_mode: stdin-text
    command: node
    args: ["${posixWorker}"]
    check: node -e "process.exit(0)"
topic_defaults:
  "-1001234567890_5001": "claude"
`,
      'utf8',
    );

    const topicStateFile = join(tempDir, 'telegram-bot-topic--1001234567890_5001.json');
    await writeFile(topicStateFile, JSON.stringify({ chat_id: -1001234567890, thread_id: 5001, turns: [] }), 'utf8');

    const controller = new AbortController();
    const state = makeState(-1001234567890, -1, 5001);

    const msg1 = {
      update_id: 1,
      message: {
        message_id: 101,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        text: 'NON_STOP_DISPATCH_TEXT_456',
      },
    };

    let getUpdatesCount = 0;
    const sentTexts: string[] = [];

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
      const u = url as string;
      if (u.includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          const batch = { ok: true, result: [msg1] };
          return { ok: true, status: 200, text: async () => JSON.stringify(batch), json: async () => batch };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if (u.includes('sendChatAction')) {
        // Once dispatch has started, cause dispatchMessage to throw WITHOUT marking topic stopped
        await unlink(configFile).catch(() => {});
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
      }
      if (u.includes('sendMessage')) {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.text) sentTexts.push(body.text);
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 900 + sentTexts.length } }), json: async () => ({ ok: true, result: { message_id: 900 + sentTexts.length } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    await runPollLoop('token', [-1001234567890], state, {}, controller.signal, fastSleep);

    const cleanSent = sentTexts.join('\n').replace(/\\/g, '');
    assert.ok(cleanSent.includes('Service temporarily unavailable'), `must send generic unavailable message, got: ${cleanSent}`);
    assert.ok(!cleanSent.includes('⏹ Stopped.'), 'must NOT send Stopped message');

    const held = await absorbHeldEntries('-1001234567890_5001');
    assert.deepEqual(held, [], 'no text must be held on non-stop thrown error');
  });
});
