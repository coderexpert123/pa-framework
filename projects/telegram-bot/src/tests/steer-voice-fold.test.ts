import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Readable } from 'node:stream';
import {
  registerQueuedUpdate,
  drainQueuedEntries,
  snapshotDrained,
  addHeldEntry,
  absorbHeldEntries,
  _clearQueueForTest,
  _clearHeldForTest,
  _setLoggerForTest,
} from '../topic-queue.js';
import { _clearStoppedForTest } from '../worker-stop.js';
import { _resetPendingDispatchesForTest } from '../pending-dispatches.js';
import { runAttachmentStage } from '../attachment-stage.js';
import type { AttachmentStageInput } from '../attachment-stage.js';
import { userTextFromVoiceResult } from '../voice-prefetch.js';
import { waitForDrain } from './test-teardown-guard.js';
import { runPollLoop, _setExitForTest } from '../main.js';
import type { ConversationState } from '../types.js';

_setExitForTest(() => {});

function makeState(chatId = -1001234567890, lastUpdateId = -1, threadId = 5001): ConversationState {
  return { chat_id: chatId, last_update_id: lastUpdateId, thread_id: threadId, turns: [] };
}

const fastSleep = async (_ms: number): Promise<void> => {};

function baseAttachmentInput(overrides: Partial<AttachmentStageInput> = {}): AttachmentStageInput {
  return {
    msg: {},
    update: {},
    userText: '',
    token: 'test-token',
    chatId: -1001234567890,
    threadId: 5001,
    messageId: 101,
    repoRoot: '/repo',
    runtimeEnv: {} as NodeJS.ProcessEnv,
    transcription: undefined,
    ...overrides,
  };
}

/**
 * Writes the transcription stub, echo worker, config and topic state used by the
 * end-to-end fold cases, and points PA_VOICE_TRANSCRIBE_SCRIPT at the stub.
 * The worker APPENDS every prompt it receives to a capture file (assertions read
 * the exact stdin instead of depending on the reply path) and sleeps before
 * replying, so the /steer's kill lands while voice1's worker is still RUNNING —
 * the A6 in-flight flush needs a killed live worker. Returns the capture path.
 */
async function writeFoldFixtureFiles(tempDir: string): Promise<string> {
  const pythonStub = join(tempDir, 'transcribe_stub.py');
  await writeFile(
    pythonStub,
    [
      "import sys",
      "arg = ' '.join(sys.argv)",
      "if 'voice1' in arg:",
      "    print('{\"ok\": true, \"text\": \"VOICE_ONE_TRANSCRIPT_281\", \"engine\": \"whisper_local\", \"truncated\": false}')",
      "else:",
      "    print('{\"ok\": true, \"text\": \"VOICE_TWO_TRANSCRIPT_173\", \"engine\": \"whisper_local\", \"truncated\": false}')",
      "",
    ].join('\n'),
    'utf8',
  );
  process.env.PA_VOICE_TRANSCRIBE_SCRIPT = pythonStub;

  const capturePath = join(tempDir, 'prompt-capture.txt');
  const startedFlag = join(tempDir, 'worker-started.flag');
  const workerScript = join(tempDir, 'echo-worker.cjs');
  await writeFile(
    workerScript,
    [
      "const fs = require('node:fs');",
      `  fs.writeFileSync(${JSON.stringify(startedFlag)}, 'up');`,
      "let d = '';",
      "process.stdin.on('data', c => { d += c; });",
      "process.stdin.on('end', async () => {",
      `  fs.appendFileSync(${JSON.stringify(capturePath)}, 'GOTPROMPTSTART' + d + 'GOTPROMPTEND');`,
      "  await new Promise(r => setTimeout(r, 3000));",
      "  process.stdout.write('GOTPROMPTSTART' + d + 'GOTPROMPTEND');",
      '  process.exit(0);',
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
 * The captured worker prompt that contains the drained voice2 transcript — i.e.
 * the STEERED dispatch's stdin. Earlier blocks belong to voice1's own dispatch
 * and to its post-kill failover respawn, so "last block" is not a stable
 * identifier; the folded prompt is the one carrying the drained transcript.
 */
function readFoldedWorkerPrompt(capturePath: string): string {
  const raw = readFileSync(capturePath, 'utf8');
  const blocks = raw.split('GOTPROMPTEND').filter(b => b.includes('GOTPROMPTSTART'));
  const folded = blocks.find(b => b.includes('VOICE_TWO_TRANSCRIPT'));
  assert.ok(folded, `steered prompt must have been dispatched. Capture blocks: ${blocks.length}`);
  const start = folded.indexOf('GOTPROMPTSTART');
  return folded.slice(start + 'GOTPROMPTSTART'.length);
}

/** True once the STEERED dispatch's prompt (carrying the drained transcript) has
 *  been captured — a plain two-block check is not enough, because voice1's
 *  killed worker triggers a failover respawn that also appends a block. */
function foldedPromptDispatched(capturePath: string): boolean {
  try {
    const raw = readFileSync(capturePath, 'utf8');
    if (raw.split('GOTPROMPTEND').length - 1 < 2) return false;
    const last = 'GOTPROMPTSTART' + raw.slice(raw.lastIndexOf('GOTPROMPTSTART'));
    return last.includes('VOICE_TWO_TRANSCRIPT');
  } catch {
    return false;
  }
}

/** True once TWO prompt blocks are captured (killed dispatch + steered dispatch). */
function captureComplete(capturePath: string): boolean {
  try {
    return readFileSync(capturePath, 'utf8').split('GOTPROMPTEND').length - 1 >= 2;
  } catch {
    return false;
  }
}


const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Phase-driven Telegram mock for the end-to-end fold cases:
 *  phase 0 → batch 1 (voice1 alone, dispatches);
 *  after voice1's dispatch started (+ grace so the worker is live when the steer
 *    kills it) → batch 2 (queued voice2 + the /steer);
 *  after the steered worker's prompt echo arrived → abort the poll loop.
 *
 * Empty poll responses resolve through a REAL setTimeout — with the test
 * fastSleep, a synchronous empty response spins the poll loop in pure
 * microtasks and starves the event loop, so the in-flight dispatch's fs/timer
 * continuations (blackboard proper-lockfile) never run and the scenario
 * deadlocks (observed 2026-09-06).
 */
function makeFoldPhaseFetchMock(
  controller: AbortController,
  sentTexts: string[],
  capturePath: string,
  startedFlag: string,
  firstBatch: unknown[],
  secondBatch: unknown[],
): (url: string, opts?: { body?: string }) => Promise<unknown> {
  let phase = 0;
  let dispatchStartedAt = 0;
  const empty = { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
  const batchResponse = (result: unknown[]) => {
    const batch = { ok: true, result };
    return { ok: true, status: 200, text: async () => JSON.stringify(batch), json: async () => batch };
  };
  return async (url: string, opts?: { body?: string }) => {
    const u = url as string;
    if (u.includes('getUpdates')) {
      if (phase === 0) {
        phase = 1;
        return batchResponse(firstBatch);
      }
      // Deliver the steer only once voice1's worker is verifiably ALIVE (its
      // started-flag is on disk) and the pid had time to reach the worker-pids
      // registry — otherwise the kill is a no-op and the A6 flush never fires.
      if (phase === 1 && dispatchStartedAt > 0 && Date.now() - dispatchStartedAt >= 300 && existsSync(startedFlag)) {
        phase = 2;
        return batchResponse(secondBatch);
      }
      if (phase === 2 && foldedPromptDispatched(capturePath)) {
        controller.abort();
      }
      await realSleep(20);
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
      const filePath = u.includes('voice1') ? 'mock/voice1.oga' : 'mock/voice2.oga';
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { file_path: filePath } }), json: async () => ({ ok: true, result: { file_path: filePath } }) };
    }
    if (u.includes('/file/bot')) {
      return {
        ok: true,
        status: 200,
        body: Readable.from(Buffer.from('fake-ogg-audio')),
        text: async () => '',
        json: async () => ({}),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
  };
}

describe('steer-voice-fold (AI-208 WP-2)', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;
  const savedScriptEnv = process.env.PA_VOICE_TRANSCRIBE_SCRIPT;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-steer-fold-'));
    process.env.PA_HOME = tempDir;
    _resetPendingDispatchesForTest();
    _clearQueueForTest();
    _clearHeldForTest();
    _clearStoppedForTest();
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
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

  it('regression AI-208: voice1 in-flight + voice2 queued+prefetched + bare /steer REPLY to voice1 → prompt contains BOTH transcripts', async () => {
    const capturePath = await writeFoldFixtureFiles(tempDir);
    const startedFlag = join(tempDir, 'worker-started.flag');

    const controller = new AbortController();
    const state = makeState(-1001234567890, -1, 5001);

    const msg1 = {
      update_id: 1,
      message: {
        message_id: 101,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        voice: { file_id: 'voice1_fid', file_unique_id: 'voice1_fuid', duration: 21 },
      },
    };
    const msg2 = {
      update_id: 2,
      message: {
        message_id: 102,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        voice: { file_id: 'voice2_fid', file_unique_id: 'voice2_fuid', duration: 13 },
      },
    };
    const steerMsg = {
      update_id: 3,
      message: {
        message_id: 103,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        text: '/steer',
        reply_to_message: { message_id: 101 },
      },
    };

    const sentTexts: string[] = [];
    (globalThis as Record<string, unknown>).fetch = makeFoldPhaseFetchMock(controller, sentTexts, capturePath, startedFlag, [msg1], [msg2, steerMsg]);

    await runPollLoop('token', [-1001234567890], state, {}, controller.signal, fastSleep);

    const prompt = readFoldedWorkerPrompt(capturePath);
    assert.ok(
      prompt.includes('VOICE_ONE_TRANSCRIPT') && prompt.includes('281'),
      'prompt must contain voice1 transcript',
    );
    assert.ok(
      prompt.includes('VOICE_TWO_TRANSCRIPT') && prompt.includes('173'),
      'prompt must contain voice2 transcript',
    );
    // B1 regression: both transcripts SUCCEEDED, so no failure line may appear —
    // the round-1 regex gate corrupted successful transcripts into failure lines.
    assert.ok(
      !prompt.includes('transcription failed'),
      `successful transcripts must not be rewritten as failures. Prompt: ${prompt}`,
    );
    // B1 regression (side-channel masking hole): voice2's transcript folds EXACTLY
    // once — the drain snapshot and the M1 record-absorb exclusion must not both
    // emit it into the same prompt.
    const voice2Count = prompt.split('VOICE_TWO_TRANSCRIPT_173').length - 1;
    assert.equal(voice2Count, 1, `voice2 transcript must appear exactly once, got ${voice2Count}. Prompt: ${prompt}`);
  });

  it('folded voice emits an echo per drained transcript', async () => {
    const foldedItems = [
      {
        text: 'first drained transcript',
        media: { file_id: 'fid-1', file_unique_id: 'fuid-1', duration: 7 },
        kind: 'voice',
        messageId: 101,
      },
      {
        text: 'second drained transcript',
        media: { file_id: 'fid-2', file_unique_id: 'fuid-2', duration: 9 },
        kind: 'voice',
        messageId: 102,
      },
    ];

    const echoes: string[] = [];
    const deps: any = {
      sendMessageFn: async (_token: string, _chatId: number, text: string) => {
        echoes.push(text);
        return true;
      },
      audioRoot: () => tempDir,
      recordAudio: async () => {},
      markAudio: async () => {},
      now: () => new Date(),
    };

    await runAttachmentStage(
      baseAttachmentInput({ update: { __foldedVoice: foldedItems } as any }),
      deps,
    );

    assert.equal(echoes.length, 2, 'emits an echo per drained transcript');
    assert.ok(echoes[0].includes('🎙 Heard (steered):'), 'echo 1 must have (steered) label');
    assert.ok(echoes[0].includes('first drained transcript'), 'echo 1 must contain text');
    assert.ok(echoes[1].includes('🎙 Heard (steered):'), 'echo 2 must have (steered) label');
    assert.ok(echoes[1].includes('second drained transcript'), 'echo 2 must contain text');
  });

  it('folded voice records an audio-index entry (durable /retranscribe)', async () => {
    const foldedItems = [
      {
        text: 'voice transcript for indexing',
        media: { file_id: 'fid-3', file_unique_id: 'fuid-3', duration: 11 },
        kind: 'voice',
        messageId: 201,
      },
    ];

    const recorded: any[] = [];
    const marked: any[] = [];
    const deps: any = {
      send: async () => true,
      audioRoot: () => tempDir,
      recordAudio: async (_root: string, _chatId: number, entry: any) => {
        recorded.push(entry);
      },
      markAudio: async (_root: string, _chatId: number, fuid: string, status: string, extra?: any) => {
        marked.push({ fuid, status, extra });
      },
      now: () => new Date(),
    };

    await runAttachmentStage(
      baseAttachmentInput({ update: { __foldedVoice: foldedItems } as any }),
      deps,
    );

    assert.equal(recorded.length, 1, 'records audio entry for folded voice');
    assert.equal(recorded[0].messageId, 201);
    assert.equal(recorded[0].kind, 'voice');
    assert.deepEqual(recorded[0].media, { file_id: 'fid-3', file_unique_id: 'fuid-3', duration: 11 });

    assert.equal(marked.length, 1, 'marks audio entry ok');
    assert.equal(marked[0].fuid, 'fuid-3');
    assert.equal(marked[0].status, 'ok');
  });

  it('drained entry whose voice promise rejects folds its failure placeholder, never [Voice message]', async () => {
    const e = registerQueuedUpdate('123_0', 401, '[Voice message]');
    e.voice = {
      promise: Promise.reject(new Error('transcription engine failed')),
      descriptor: { kind: 'voice' },
      media: { file_id: 'f', file_unique_id: 'fu', duration: 7 },
      kind: 'voice',
    };

    // What the fold will push: the production formatter's failure shape. B1 moved
    // the rejection formatting INTO snapshotDrained, so no caller-side conversion
    // exists (or is allowed) any more.
    const expectedFailureText = userTextFromVoiceResult(
      { ok: false, reason: 'transcribe-failed', message: 'Transcription failed' },
      { kind: 'voice' },
    );

    const drained = snapshotDrained([e]);
    assert.equal(drained.length, 1);

    const text = await drained[0].textPromise;
    assert.notEqual(text, '[Voice message]', 'must never fold the bare placeholder');
    assert.equal(text, expectedFailureText, 'snapshotDrained must format the rejection itself');
    assert.ok(text.includes('transcription failed'), 'must fold failure placeholder');
    assert.ok(text.startsWith('[Voice message — transcription failed:'), 'matches failure format');
  });

  it('steer whose fold is skipped holds drained transcripts and logs a warning (S1 path)', async () => {
    // The E4 safety net is inline in runPollLoop's `.finally()` and the fold-miss
    // state is not reachable in-process (a steer entry is a command, so no later
    // drain can cancel it), so per M4 this drives the SAME production primitives
    // the net calls — snapshotDrained → addHeldEntry → absorbHeldEntries — with no
    // re-implemented fold, combine or finally logic. The warn line itself is
    // emitted by main.ts (verified at the integration gate, not here).
    const e = registerQueuedUpdate('123_0', 501, '[Voice message]');
    e.voice = {
      promise: Promise.resolve({
        ok: true,
        text: 'DRAINED_UNCONSUMED_TRANSCRIPT',
        engine: 'whisper_local',
        mode: 'spawn',
        audioPath: '/fake/audio.oga',
        elapsedMs: 100,
        truncated: false,
      }),
      descriptor: { kind: 'voice' },
      media: { file_id: 'f5', file_unique_id: 'fu5', duration: 9 },
      kind: 'voice',
    };

    const drained = snapshotDrained([e]);
    for (const d of drained) {
      addHeldEntry('123_0', await d.textPromise);
    }

    const held = await absorbHeldEntries('123_0');
    assert.deepEqual(
      held,
      [{ text: '[Voice message] DRAINED_UNCONSUMED_TRANSCRIPT' }],
      'unconsumed transcript was held (production absorb output shape)',
    );
  });

  it('zero-drain steer logs drained 0 entry(ies)', () => {
    const logs: any[] = [];
    _setLoggerForTest({
      info: (mod, msg, ctx) => {
        logs.push({ mod, msg, ctx });
      },
    });

    const entries = drainQueuedEntries('empty_topic_key_0', 'steer');
    assert.equal(entries.length, 0);

    const zeroLog = logs.find(l => l.mod === 'steer-drain' && l.msg.includes('drained 0 entry(ies)'));
    assert.ok(zeroLog, 'zero-drain must log drained 0 entry(ies)');
    assert.equal(zeroLog.ctx?.count, 0);
    assert.equal(zeroLog.ctx?.reason, 'steer');
  });

  it('A6 held text does not displace drained transcripts (order: held first, then drained, then prompt)', async () => {
    // Driven end-to-end through runPollLoop (M4: the combine is no longer
    // re-implemented in-file): voice1 is in-flight and killed by the steer (its
    // text lands in the held list via the A6 in-flight flush), voice2 is queued +
    // prefetched (drained snapshot), and the steer prompt is the steer's own text.
    const capturePath = await writeFoldFixtureFiles(tempDir);
    const startedFlag = join(tempDir, 'worker-started.flag');

    const controller = new AbortController();
    const state = makeState(-1001234567890, -1, 5001);

    const msg1 = {
      update_id: 1,
      message: {
        message_id: 101,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        voice: { file_id: 'voice1_fid', file_unique_id: 'voice1_fuid', duration: 21 },
      },
    };
    const msg2 = {
      update_id: 2,
      message: {
        message_id: 102,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        voice: { file_id: 'voice2_fid', file_unique_id: 'voice2_fuid', duration: 13 },
      },
    };
    const steerMsg = {
      update_id: 3,
      message: {
        message_id: 103,
        chat: { id: -1001234567890, type: 'supergroup' },
        message_thread_id: 5001,
        date: Math.floor(Date.now() / 1000),
        text: '/steer FINAL_STEER_PROMPT_TEXT',
        reply_to_message: { message_id: 101 },
      },
    };

    const sentTexts: string[] = [];
    (globalThis as Record<string, unknown>).fetch = makeFoldPhaseFetchMock(controller, sentTexts, capturePath, startedFlag, [msg1], [msg2, steerMsg]);

    await runPollLoop('token', [-1001234567890], state, {}, controller.signal, fastSleep);

    const prompt = readFoldedWorkerPrompt(capturePath);
    const idxHeld = prompt.indexOf('VOICE_ONE_TRANSCRIPT_281');
    const idxDrained = prompt.indexOf('VOICE_TWO_TRANSCRIPT_173');
    const idxPrompt = prompt.indexOf('FINAL_STEER_PROMPT_TEXT');

    assert.ok(idxHeld !== -1, 'held (A6) voice1 transcript must be in the combined prompt');
    assert.ok(idxDrained !== -1, 'drained voice2 transcript must be in the combined prompt');
    assert.ok(idxPrompt !== -1, 'steer prompt must be in the combined prompt');
    assert.ok(
      idxHeld < idxDrained && idxDrained < idxPrompt,
      `order must be held first (${idxHeld}), then drained (${idxDrained}), then prompt (${idxPrompt})`,
    );
  });
});
