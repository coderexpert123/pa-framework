/**
 * WP7 (plan: plans/2026-08-04-telegram-voice-transcription.md) — end-to-end
 * poll-loop coverage for the voice-note wiring in main.ts. A new file rather
 * than an addition to poll-loop.test.ts (2400+ lines, owned by other
 * packages) per the plan's own file-ownership split.
 *
 * Harness conventions copied from poll-loop.test.ts: setupFetchMock-style
 * URL-aware fetch mocking, makeState(), AbortController-driven loop exit,
 * fastSleep, mkdtemp + PA_HOME, rmRetry cleanup.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { Readable } from 'stream';
import { runPollLoop } from '../main.js';
import type { ConversationState } from '../types.js';
import { rmRetry } from './rm-retry.js';
import { listPendingDispatches, _resetPendingDispatchesForTest } from '../pending-dispatches.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeState(chatId = 123, lastUpdateId = -1): ConversationState {
  return { chat_id: chatId, last_update_id: lastUpdateId, thread_id: 0, turns: [] } as any;
}

// Instant sleep for tests — no real waiting between poll iterations.
const fastSleep = async (_ms: number): Promise<void> => {};

// sendMessage runs every reply through sanitizeMdV2 (backslash-escapes
// MarkdownV2 specials: . ! - + = | { } # ( ) [ ] > _ ~ * `) before JSON-
// encoding it into the request body. Substring assertions on a captured
// fetch body must strip those escapes first, or a literal match on text
// containing e.g. "[Voice message]" or "console.groq.com" spuriously fails.
function unescapedBody(body: unknown): string {
  return String(body ?? '').replace(/\\+/g, '');
}

function jsonResponse(obj: unknown) {
  const text = JSON.stringify(obj);
  return { ok: true, status: 200, text: async () => text, json: async () => obj };
}

function voiceUpdate(updateId: number, opts: { messageId?: number; fileId?: string; duration?: number } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: opts.messageId ?? updateId,
      chat: { id: 123, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      voice: {
        file_id: opts.fileId ?? `voice-file-${updateId}`,
        file_unique_id: `voice-uniq-${updateId}`,
        duration: opts.duration ?? 5,
      },
    },
  };
}

function textUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 123, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

/**
 * URL-aware fetch mock covering the calls a voice-note update triggers:
 * getUpdates (batched), getFile (voice metadata), the raw /file/bot download
 * (needs a real Readable body for telegram.ts's stream pipeline), and a
 * catch-all ok:true for sendMessage / sendChatAction / setMessageReaction /
 * pinChatMessage / etc. `onCall` lets a test intercept a specific request
 * (e.g. to gate on the enqueue-time placeholder having landed) before it
 * responds.
 */
function setupVoiceFetchMock(opts: {
  batches: any[][];
  controller: AbortController;
  onCall?: (url: string, init: any) => Promise<void> | void;
}): Array<{ url: string; body?: string }> {
  const calls: Array<{ url: string; body?: string }> = [];
  let batchIndex = 0;

  (globalThis as Record<string, unknown>).fetch = async (url: string, init?: any) => {
    calls.push({ url, body: init?.body });
    if (opts.onCall) await opts.onCall(url, init);

    if (url.includes('getUpdates')) {
      const batch = opts.batches[batchIndex] ?? [];
      batchIndex++;
      if (batchIndex >= opts.batches.length) opts.controller.abort();
      return jsonResponse({ ok: true, result: batch });
    }
    if (url.includes('/getFile?file_id=')) {
      return jsonResponse({ ok: true, result: { file_path: 'voice/note.oga' } });
    }
    if (url.includes('/file/bot')) {
      return { ok: true, status: 200, body: Readable.from(Buffer.from('fake-ogg-bytes')), text: async () => '', json: async () => ({}) };
    }
    return jsonResponse({ ok: true, result: { message_id: 900 + calls.length } });
  };

  return calls;
}

async function writeEchoWorkerConfig(tempDir: string, extraYaml = ''): Promise<string> {
  const scriptPath = join(tempDir, 'echo-worker.mjs');
  await writeFile(
    scriptPath,
    "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);" +
      "process.stdin.on('end',()=>{process.stdout.write('WORKER_ECHO:'+d);process.exit(0);});\n",
    'utf8',
  );
  const posixScriptPath = scriptPath.replace(/\\/g, '/');
  await writeFile(
    join(tempDir, 'config.yaml'),
    `
workers:
  - name: claude
    command: node
    args: ["${posixScriptPath}"]
    check: node -e "process.exit(0)"
    input_mode: stdin-text
topic_defaults:
  "123_0": "claude"
${extraYaml}
`,
    'utf8',
  );
  return scriptPath;
}

async function writePythonStub(tempDir: string, name: string, body: string): Promise<string> {
  const p = join(tempDir, name);
  await writeFile(p, body, 'utf8');
  return p;
}

const SUCCESS_STUB = `print('{"ok": true, "text": "hello there", "engine": "whisper_local", "truncated": false}')\n`;
const TRUNCATED_STUB = `print('{"ok": true, "text": "hello there", "engine": "whisper_local", "truncated": true}')\n`;
const NO_ENGINE_STUB = `import sys\nprint('{"ok": false, "error_code": "no-engine", "error": "no engine configured"}')\nsys.exit(1)\n`;

// ---------------------------------------------------------------------------

describe('runPollLoop: voice notes', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'PA_VOICE_TRANSCRIBE_SCRIPT',
    'PA_VOICE_WORKER_SCRIPT',
    'PA_VOICE_WORKER_START_TIMEOUT_MS',
    'PA_VOICE_MAX_DURATION_S',
  ];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-voice-'));
    process.env.PA_HOME = tempDir;
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    _resetPendingDispatchesForTest();
  });

  afterEach(async () => {
    delete process.env.PA_HOME;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    _resetPendingDispatchesForTest();
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  // -------------------------------------------------------------------
  // Cases 1-2: isAcceptableUpdate now accepts voice; enqueue placeholder
  // -------------------------------------------------------------------

  it('case 1: a voice-only update is accepted and an enqueue-time pending-dispatch record is written', async () => {
    process.env.PA_VOICE_TRANSCRIBE_SCRIPT = join(tempDir, 'does-not-exist.py');
    const controller = new AbortController();
    const state = makeState(123, -1);
    const update = voiceUpdate(1);

    let gateHit = false;
    let recordAtGate: any;
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => { resolveGate = r; });

    setupVoiceFetchMock({
      batches: [[update], []],
      controller,
      onCall: async (url) => {
        if (url.includes('/getFile?file_id=') && !gateHit) {
          gateHit = true;
          const listed = await listPendingDispatches();
          recordAtGate = listed.find((r) => r.updateId === 1);
          await gate;
        }
      },
    });

    const loopDone = runPollLoop('token', [123], state, {}, controller.signal, fastSleep);
    for (let i = 0; i < 500 && !gateHit; i++) await new Promise((r) => setTimeout(r, 20));
    try {
      assert.ok(recordAtGate, 'a pending-dispatch placeholder should exist for the voice update before transcription completes');
    } finally {
      resolveGate();
      await loopDone;
    }
  });

  it('case 2: the enqueue-time placeholder userText is "[Voice message]", not empty', async () => {
    process.env.PA_VOICE_TRANSCRIBE_SCRIPT = join(tempDir, 'does-not-exist.py');
    const controller = new AbortController();
    const state = makeState(123, -1);
    const update = voiceUpdate(2);

    let gateHit = false;
    let recordAtGate: any;
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => { resolveGate = r; });

    setupVoiceFetchMock({
      batches: [[update], []],
      controller,
      onCall: async (url) => {
        if (url.includes('/getFile?file_id=') && !gateHit) {
          gateHit = true;
          const listed = await listPendingDispatches();
          recordAtGate = listed.find((r) => r.updateId === 2);
          await gate;
        }
      },
    });

    const loopDone = runPollLoop('token', [123], state, {}, controller.signal, fastSleep);
    for (let i = 0; i < 500 && !gateHit; i++) await new Promise((r) => setTimeout(r, 20));
    try {
      assert.ok(recordAtGate, 'placeholder should exist');
      assert.equal(recordAtGate.userText, '[Voice message]');
    } finally {
      resolveGate();
      await loopDone;
    }
  });

  // -------------------------------------------------------------------
  // Case 3: still-rejected shape (regression guard on the widened predicate)
  // -------------------------------------------------------------------

  it('case 3: a text-less, voice-less update is still rejected', async () => {
    const controller = new AbortController();
    const state = makeState(123, -1);
    const junk = {
      update_id: 3,
      message: { message_id: 3, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000) },
    };
    setupVoiceFetchMock({ batches: [[junk], []], controller });

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);
    assert.deepEqual(await listPendingDispatches(), [], 'no placeholder for a message with no text, caption, or voice');
  });

  // -------------------------------------------------------------------
  // Cases 4-6: failure path — user-visible error, no dispatch, no leaked
  // pending record, lock released
  // -------------------------------------------------------------------

  it('case 4: failure path sends a user-visible message and does not dispatch', async () => {
    process.env.PA_VOICE_TRANSCRIBE_SCRIPT = join(tempDir, 'does-not-exist.py');
    const controller = new AbortController();
    const state = makeState(123, -1);
    const update = voiceUpdate(4);
    const calls = setupVoiceFetchMock({ batches: [[update], []], controller });

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const sendCalls = calls.filter((c) => c.url.includes('/sendMessage'));
    assert.equal(sendCalls.length, 1, 'exactly one sendMessage for the failure notice');
    const body = unescapedBody(sendCalls[0].body);
    assert.ok(body.includes('🎙'), 'failure message should carry the 🎙 marker');
    assert.ok(/Ref:/.test(body), 'failure message should carry a Ref: line');
    assert.ok(!body.includes('WORKER_ECHO:'), 'no worker dispatch should have happened');
  });

  it('case 5: no pending-dispatch record survives the failure path', async () => {
    process.env.PA_VOICE_TRANSCRIBE_SCRIPT = join(tempDir, 'does-not-exist.py');
    const controller = new AbortController();
    const state = makeState(123, -1);
    const update = voiceUpdate(5);
    setupVoiceFetchMock({ batches: [[update], []], controller });

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);
    assert.deepEqual(await listPendingDispatches(), [], 'the poll loop .finally() must remove the placeholder even on the early-return failure path');
  });

  it('case 6: the topic lock is released on the failure path — a second update to the same topic is processed normally', async () => {
    process.env.PA_VOICE_TRANSCRIBE_SCRIPT = join(tempDir, 'does-not-exist.py');
    await writeEchoWorkerConfig(tempDir);
    const controller = new AbortController();
    const state = makeState(123, -1);
    const update1 = voiceUpdate(6, { messageId: 6 });
    const update2 = textUpdate(7, 'hello');
    const calls = setupVoiceFetchMock({ batches: [[update1, update2], []], controller });

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const sendCalls = calls.filter((c) => c.url.includes('/sendMessage'));
    assert.ok(
      !sendCalls.some((c) => unescapedBody(c.body).includes('Processing is delayed')),
      'the second same-topic update must not hit the lock-busy branch',
    );
    assert.ok(
      sendCalls.some((c) => unescapedBody(c.body).includes('WORKER_ECHO:')),
      'the second update should have dispatched normally',
    );
  });

  // -------------------------------------------------------------------
  // Case 7: the transcript reaches both the dispatcher and the archive
  // -------------------------------------------------------------------

  it('case 7: the transcript is what reaches the dispatcher and the archive', async () => {
    const scriptPath = await writePythonStub(tempDir, 'success_stub.py', SUCCESS_STUB);
    process.env.PA_VOICE_TRANSCRIBE_SCRIPT = scriptPath;
    await writeEchoWorkerConfig(tempDir);
    const controller = new AbortController();
    const state = makeState(123, -1);
    const update = voiceUpdate(8, { messageId: 8 });
    const calls = setupVoiceFetchMock({ batches: [[update], []], controller });

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const sendCalls = calls.filter((c) => c.url.includes('/sendMessage'));
    assert.ok(
      sendCalls.some((c) => unescapedBody(c.body).includes('[Voice message] hello there')),
      'the dispatched prompt (echoed by the worker) should contain the transcript',
    );

    const topicState = JSON.parse(await readFile(join(tempDir, 'telegram-bot-topic-123_0.json'), 'utf8'));
    const userTurn = topicState.turns.find((t: any) => t.role === 'user');
    assert.ok(userTurn, 'a user turn should have been archived');
    assert.ok(userTurn.text.includes('[Voice message] hello there'), 'the archived user turn should contain the transcript');
  });

  // -------------------------------------------------------------------
  // Case 8: persistent worker_mode falls back to spawn when unreachable
  // -------------------------------------------------------------------

  it('case 8: transcription.worker_mode "persistent" with no reachable worker still completes via the spawn fallback', async () => {
    const scriptPath = await writePythonStub(tempDir, 'success_stub.py', SUCCESS_STUB);
    process.env.PA_VOICE_TRANSCRIBE_SCRIPT = scriptPath;
    process.env.PA_VOICE_WORKER_SCRIPT = join(tempDir, 'no-such-worker.py');
    process.env.PA_VOICE_WORKER_START_TIMEOUT_MS = '300';
    await writeEchoWorkerConfig(tempDir, 'transcription:\n  worker_mode: persistent\n');
    const controller = new AbortController();
    const state = makeState(123, -1);
    const update = voiceUpdate(9, { messageId: 9 });
    const calls = setupVoiceFetchMock({ batches: [[update], []], controller });

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const sendCalls = calls.filter((c) => c.url.includes('/sendMessage'));
    assert.ok(
      sendCalls.some((c) => unescapedBody(c.body).includes('[Voice message] hello there')),
      'an unreachable persistent worker must fall back to spawn mode and still transcribe',
    );
  });

  // -------------------------------------------------------------------
  // Case 9: fresh-install first-run experience (D10)
  // -------------------------------------------------------------------

  it('case 9: the fresh-install (no-engine) path produces the setup message, end to end', async () => {
    const scriptPath = await writePythonStub(tempDir, 'no_engine_stub.py', NO_ENGINE_STUB);
    process.env.PA_VOICE_TRANSCRIBE_SCRIPT = scriptPath;
    const controller = new AbortController();
    const state = makeState(123, -1);
    const update = voiceUpdate(10, { messageId: 10 });
    const calls = setupVoiceFetchMock({ batches: [[update], []], controller });

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const sendCalls = calls.filter((c) => c.url.includes('/sendMessage'));
    assert.equal(sendCalls.length, 1);
    const body = unescapedBody(sendCalls[0].body);
    assert.ok(body.includes('console.groq.com/keys'), 'no-engine message should point at the 60-second Groq recipe');
    assert.ok(!body.includes('Transcription failed:'), 'no-engine must not fall through to the generic transcribe-failed message');
  });

  // -------------------------------------------------------------------
  // Case 10: long-note truncation is visible end to end (D11)
  // -------------------------------------------------------------------

  it('case 10: a truncated transcript reaches the archive with the cut-off notice, end to end', async () => {
    const scriptPath = await writePythonStub(tempDir, 'truncated_stub.py', TRUNCATED_STUB);
    process.env.PA_VOICE_TRANSCRIBE_SCRIPT = scriptPath;
    await writeEchoWorkerConfig(tempDir);
    const controller = new AbortController();
    const state = makeState(123, -1);
    const update = voiceUpdate(11, { messageId: 11 });
    const calls = setupVoiceFetchMock({ batches: [[update], []], controller });

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const sendCalls = calls.filter((c) => c.url.includes('/sendMessage'));
    assert.ok(
      sendCalls.some((c) => unescapedBody(c.body).includes('cut off at the length limit')),
      'the dispatched prompt (echoed by the worker) should carry the truncation notice',
    );

    const topicState = JSON.parse(await readFile(join(tempDir, 'telegram-bot-topic-123_0.json'), 'utf8'));
    const userTurn = topicState.turns.find((t: any) => t.role === 'user');
    assert.ok(userTurn, 'a user turn should have been archived');
    assert.ok(userTurn.text.includes('cut off at the length limit'), 'the archived turn should carry the truncation notice');
  });
});
