/**
 * AI-209 WP-3 — batched uptake at the natural-drain seam, driven END-TO-END
 * through the real runPollLoop (steer-voice-fold.test.ts harness pattern:
 * fake capture worker appending its stdin prompt to a file, phase-driven fetch
 * mock, PA_VOICE_TRANSCRIBE_SCRIPT stub; runOne/pollFor idioms from
 * orchestrator-dispatch.test.ts).
 *
 * Affirmative gates (SPEC §7): a fold WITHOUT its frozen header in the captured
 * prompt is a silent-fold defect; a lone message that grows a header is a
 * defect; the withheld spoken command must still produce its own status reply.
 *
 * T7 note: the compile's heldForTopic flip and the seam's record removal run in
 * ONE microtask chain, so a timer-based poller cannot deterministically observe
 * the flip mid-turn. T7 asserts the deterministic mid-turn LIFECYCLE (head
 * materialized with foldedFrom, follower record consumed — nothing left for the
 * reaper), and T7b drives the REAL compileBatchFold over the REAL store to
 * assert the hold itself (the unit-level counterpart of WP-2's T6).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Readable } from 'node:stream';
import { runPollLoop, _setExitForTest } from '../main.js';
import {
  _resetPendingDispatchesForTest,
  addPendingDispatch,
  listPendingDispatches,
  type PendingDispatch,
} from '../pending-dispatches.js';
import { _clearQueueForTest, registerQueuedUpdate } from '../topic-queue.js';
import { _clearStoppedForTest } from '../worker-stop.js';
import { _resetDeliveredCacheForTest } from '../delivered-store.js';
import { compileBatchFold } from '../batch-uptake.js';
import { waitForDrain } from './test-teardown-guard.js';
import { rmRetry } from './rm-retry.js';
import type { ConversationState } from '../types.js';

_setExitForTest(() => {});

const CHAT_ID = -1001234567890;
const THREAD_ID = 5001;
const TOPIC_KEY = `${CHAT_ID}_${THREAD_ID}`;
const REPLY_BODY = 'REPLY_BODY_OK_77';
const SCENARIO_DEADLINE_MS = 30000;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The capture worker: appends its full stdin prompt to the capture file at
 * stdin end (BEFORE any hold, so an in-flight turn is observable), then holds
 * 2500ms for prompts that are a warmup head or a combined batch (keeping the
 * turn in flight so queued arrivals / mid-turn store reads land inside it),
 * then replies with a fixed short body. A fixed reply keeps the reply-path
 * assertions countable: one `_Ref:` reply per TURN, never per message.
 */
async function writeDispatchFixture(tempDir: string): Promise<{ capturePath: string; startedFlag: string }> {
  const transcribeStub = join(tempDir, 'transcribe_stub.py');
  await writeFile(
    transcribeStub,
    [
      "import sys",
      "arg = ' '.join(sys.argv)",
      "if 'sixfollow' in arg:",
      "    print('{\"ok\": true, \"text\": \"SIX_VOICE_TRANSCRIPT_424\", \"engine\": \"whisper_local\", \"truncated\": false}')",
      "elif 'tenfollow' in arg:",
      "    print('{\"ok\": true, \"text\": \"/status\", \"engine\": \"whisper_local\", \"truncated\": false}')",
      "else:",
      "    print('{\"ok\": true, \"text\": \"UNEXPECTED_VOICE_TRANSCRIPT\", \"engine\": \"whisper_local\", \"truncated\": false}')",
      "",
    ].join('\n'),
    'utf8',
  );
  process.env.PA_VOICE_TRANSCRIBE_SCRIPT = transcribeStub;

  const capturePath = join(tempDir, 'prompt-capture.txt');
  const startedFlag = join(tempDir, 'worker-started.flag');
  const workerScript = join(tempDir, 'capture-worker.cjs');
  await writeFile(
    workerScript,
    [
      "const fs = require('node:fs');",
      `  fs.writeFileSync(${JSON.stringify(startedFlag)}, 'up');`,
      "let d = '';",
      "process.stdin.on('data', c => { d += c; });",
      "process.stdin.on('end', async () => {",
      `  fs.appendFileSync(${JSON.stringify(capturePath)}, 'GOTPROMPTSTART' + d + 'GOTPROMPTEND');`,
      "  const hold = (d.includes('WARMUP') || d.includes('[Batched:') || d.includes('You are the orchestrator')) ? 2500 : 0;",
      "  if (hold) { await new Promise(r => setTimeout(r, hold)); }",
      `  process.stdout.write(${JSON.stringify(REPLY_BODY)});`,
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

  await writeFile(join(tempDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
  await writeFile(join(tempDir, 'rate-limit-state.json'), '{}', 'utf8');
  return { capturePath, startedFlag };
}

async function seedTopicState(tempDir: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(tempDir, `telegram-bot-topic-${TOPIC_KEY}.json`),
    JSON.stringify({ chat_id: CHAT_ID, thread_id: THREAD_ID, turns: [], ...extra }),
    'utf8',
  );
}

function textUpdate(updateId: number, messageId: number, text: string): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: CHAT_ID, type: 'supergroup' },
      message_thread_id: THREAD_ID,
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

function steerUpdate(updateId: number, messageId: number, text: string, replyToMessageId: number): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: CHAT_ID, type: 'supergroup' },
      message_thread_id: THREAD_ID,
      date: Math.floor(Date.now() / 1000),
      text,
      reply_to_message: { message_id: replyToMessageId },
    },
  };
}

/** A plain text update that REPLIES to another message (AI-203 inc 3): the
 *  reply_to_message carries only the id — no FYI text — so the anchor misses
 *  and the W4 shapes are what the test exercises. */
function replyShapeUpdate(updateId: number, messageId: number, text: string, replyToMessageId: number): unknown {
  const base = textUpdate(updateId, messageId, text) as { message: Record<string, unknown> };
  base.message.reply_to_message = { message_id: replyToMessageId };
  return base;
}

function voiceUpdate(updateId: number, messageId: number, fileId: string, fuid: string): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: CHAT_ID, type: 'supergroup' },
      message_thread_id: THREAD_ID,
      date: Math.floor(Date.now() / 1000),
      voice: { file_id: fileId, file_unique_id: fuid, duration: 9 },
    },
  };
}

function captureBlocks(capturePath: string): string[] {
  try {
    return readFileSync(capturePath, 'utf8')
      .split('GOTPROMPTEND')
      .filter((b) => b.includes('GOTPROMPTSTART'));
  } catch {
    return [];
  }
}

function blockContaining(capturePath: string, needle: string): string | undefined {
  return captureBlocks(capturePath).find((b) => b.includes(needle));
}

/** The prompt text inside the first capture block carrying `needle`. */
function promptIn(capturePath: string, needle: string): string {
  const block = blockContaining(capturePath, needle);
  assert.ok(block, `a captured prompt containing "${needle}" must exist`);
  return block.slice(block.indexOf('GOTPROMPTSTART') + 'GOTPROMPTSTART'.length);
}

/** Fix-wave B1: the topic-status system pin ALSO carries a `_Ref:` footer, so a
 *  bare `_Ref:` count overcounts by one per pin and reads as an "extra
 *  dispatch". Count CAPTURE-WORKER replies only — and match the body on the
 *  UNESCAPED text (the wire form escapes `_` in REPLY_BODY_OK_77). */
const workerReplies = (sent: string[]): string[] =>
  sent.filter((t) => t.includes('_Ref:') && plain(t).includes(REPLY_BODY));

/** Fix-wave A1: send bodies are MarkdownV2-escaped (`\(`, `\_`) — strip the
 *  escapes so matchers target the logical text the bot composed. */
function plain(text: string): string {
  return text.replace(/\\/g, '');
}

interface ScenarioPhase {
  updates: unknown[];
  /** Condition polled (20ms) before this phase is delivered. */
  proceed?: () => boolean | Promise<boolean>;
}

/** Live dispatch signal the mock keeps updated (sendChatAction = a dispatch started). */
interface DispatchSignal { dispatchStartedAt: number }

/**
 * Phase-driven Telegram mock + one runPollLoop run. Phase 0 delivers
 * immediately; each later phase waits for its `proceed`; after the last phase,
 * `abortWhen` ends the loop. A hard deadline aborts a stuck scenario so a
 * regression fails its assertions instead of hanging the gate.
 */
async function runScenario(
  phases: ScenarioPhase[],
  abortWhen: (() => boolean | Promise<boolean>) | undefined,
  sentTexts: string[],
  signal: DispatchSignal,
): Promise<void> {
  const controller = new AbortController();
  const state: ConversationState = { chat_id: CHAT_ID, last_update_id: -1, thread_id: THREAD_ID, turns: [] };
  const savedFetch = (globalThis as Record<string, unknown>).fetch;
  let call = 0;
  const startedAt = Date.now();
  const empty = { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
  const okTrue = { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
  (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
    const u = url as string;
    if (u.includes('getUpdates')) {
      if (Date.now() - startedAt > SCENARIO_DEADLINE_MS) {
        controller.abort();
      } else if (call < phases.length) {
        const phase = phases[call];
        if (phase.proceed ? await phase.proceed() : true) {
          call++;
          const batch = { ok: true, result: phase.updates };
          return { ok: true, status: 200, text: async () => JSON.stringify(batch), json: async () => batch };
        }
      } else if (abortWhen && await abortWhen()) {
        controller.abort();
      }
      await realSleep(20);
      return empty;
    }
    if (u.includes('sendChatAction')) {
      signal.dispatchStartedAt = Date.now();
      return okTrue;
    }
    if (u.includes('sendMessage')) {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (body.text) sentTexts.push(body.text);
      const sent = { ok: true, result: { message_id: 900 + sentTexts.length } };
      return { ok: true, status: 200, text: async () => JSON.stringify(sent), json: async () => sent };
    }
    if (u.includes('/getFile?file_id=')) {
      const fid = decodeURIComponent(u.split('file_id=')[1] ?? 'unknown');
      const fp = { ok: true, result: { file_path: `mock/${fid}.oga` } };
      return { ok: true, status: 200, text: async () => JSON.stringify(fp), json: async () => fp };
    }
    if (u.includes('/file/bot')) {
      return { ok: true, status: 200, body: Readable.from(Buffer.from('fake-ogg-audio')), text: async () => '', json: async () => ({}) };
    }
    return okTrue;
  };
  try {
    await runPollLoop('token', [CHAT_ID], state, {}, controller.signal, async () => {});
  } finally {
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  }
}

describe('batch-uptake dispatch seam (AI-209 WP-3, end-to-end)', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = (globalThis as Record<string, unknown>).fetch;
  const savedScriptEnv = process.env.PA_VOICE_TRANSCRIBE_SCRIPT;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-batch-dispatch-'));
    process.env.PA_HOME = tempDir;
    _resetPendingDispatchesForTest();
    _clearQueueForTest();
    _clearStoppedForTest();
    _resetDeliveredCacheForTest();
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    if (savedScriptEnv !== undefined) {
      process.env.PA_VOICE_TRANSCRIBE_SCRIPT = savedScriptEnv;
    } else {
      delete process.env.PA_VOICE_TRANSCRIBE_SCRIPT;
    }
    (globalThis as Record<string, unknown>).fetch = savedFetch;
    _resetPendingDispatchesForTest();
    _clearQueueForTest();
    _clearStoppedForTest();
    _resetDeliveredCacheForTest();
    if (tempDir) await rmRetry(tempDir);
    tempDir = '';
  });

  it('T1: two queued plain messages fold into ONE combined dispatch (header + labels + one reply)', async () => {
    const { capturePath } = await writeDispatchFixture(tempDir);
    await seedTopicState(tempDir);

    const sent: string[] = [];
    await runScenario(
      [
        { updates: [textUpdate(1, 101, 'WARMUP_ONE_111')] },
        {
          updates: [textUpdate(2, 102, 'SECOND_QUEUED_BRAVO'), textUpdate(3, 103, 'THIRD_QUEUED_CHARLIE')],
          proceed: () => blockContaining(capturePath, 'WARMUP_ONE_111') !== undefined,
        },
      ],
      () => blockContaining(capturePath, '[Batched:') !== undefined && workerReplies(sent).length >= 2,
      sent,
      { dispatchStartedAt: 0 },
    );

    // Affirmative (SPEC §7): the literal frozen header MUST be in the captured prompt.
    const prompt = promptIn(capturePath, '[Batched: 2 messages, in the order they were sent]');
    assert.equal(prompt.split('[msg ').length - 1, 2, `exactly two [msg <id>] labels. Prompt: ${prompt}`);
    const iB = prompt.indexOf('SECOND_QUEUED_BRAVO');
    const iC = prompt.indexOf('THIRD_QUEUED_CHARLIE');
    assert.ok(iB !== -1 && iC !== -1, `both texts must be in the batched prompt. Prompt: ${prompt}`);
    assert.ok(iB < iC, `send order must be preserved (head ${iB} < follower ${iC}). Prompt: ${prompt}`);

    // 3 messages, exactly 2 capture-worker replies — ONE turn for the batch, not
    // one per message (the topic-status pin also carries _Ref: and is excluded).
    assert.equal(workerReplies(sent).length, 2, `exactly one reply per turn (warmup + batched); got ${workerReplies(sent).length}: ${JSON.stringify(sent)}`);

    // Both follower records are consumed — nothing left in the pending store.
    const recs = await listPendingDispatches();
    assert.ok(!recs.some((r) => r.updateId === 2 || r.updateId === 3), `follower records must be absent: ${JSON.stringify(recs.map((r) => r.updateId))}`);
  });

  it('T2: the head record carries foldedFrom (the folded follower, with both ids) mid-turn', async () => {
    const { capturePath } = await writeDispatchFixture(tempDir);
    await seedTopicState(tempDir);

    let stashed: PendingDispatch | undefined;
    const sent: string[] = [];
    await runScenario(
      [
        { updates: [textUpdate(11, 111, 'WARMUP_TWO_222')] },
        {
          updates: [textUpdate(12, 112, 'TWO_HEAD_223'), textUpdate(13, 113, 'TWO_TAIL_224')],
          proceed: () => blockContaining(capturePath, 'WARMUP_TWO_222') !== undefined,
        },
      ],
      async () => {
        if (stashed) return true;
        const recs = await listPendingDispatches();
        const head = recs.find((r) => r.updateId === 12);
        if (head?.foldedFrom?.length) {
          stashed = head;
          return true;
        }
        return false;
      },
      sent,
      { dispatchStartedAt: 0 },
    );

    // The combined turn is in flight (worker holds 2500ms on a [Batched: prompt),
    // so this record is the LIVE mid-turn dispatch record, not a post-hoc one.
    assert.ok(stashed, 'the batched head record must be live mid-turn');
    assert.ok(stashed!.userText.includes('[Batched: 2 messages'), `the head record userText is the combined prompt. Got: ${stashed!.userText}`);
    // Fix-wave B2: SPEC §4.1 freezes foldedFrom as "followers only, fold order" —
    // the head's provenance IS this record (its userText carries the combined
    // prompt); including the head's own id here would also make the seam's
    // consume step delete the live head record. Update 12 is the HEAD (its turn
    // started after the warmup drained, with 13 queued behind it), 13 the only
    // folded follower — so the plan carries exactly [{13, 113}].
    assert.deepEqual(
      stashed!.foldedFrom,
      [{ updateId: 13, messageId: 113 }],
      `foldedFrom must carry the folded follower (followers only, SPEC §4.1) with both ids. Got: ${JSON.stringify(stashed!.foldedFrom)}`,
    );
  });

  it('T3: a single queued message dispatches byte-identically — no header, no [msg label', async () => {
    const { capturePath } = await writeDispatchFixture(tempDir);
    await seedTopicState(tempDir);

    const sent: string[] = [];
    await runScenario(
      [
        { updates: [textUpdate(21, 211, 'WARMUP_THREE_333')] },
        {
          updates: [textUpdate(22, 212, 'SINGLE_QUEUED_DELTA')],
          proceed: () => blockContaining(capturePath, 'WARMUP_THREE_333') !== undefined,
        },
      ],
      () => blockContaining(capturePath, 'SINGLE_QUEUED_DELTA') !== undefined && workerReplies(sent).length >= 2,
      sent,
      { dispatchStartedAt: 0 },
    );

    const prompt = promptIn(capturePath, 'SINGLE_QUEUED_DELTA');
    assert.ok(!prompt.includes('[Batched'), `a lone message must NEVER grow a batch header. Prompt: ${prompt}`);
    assert.ok(!prompt.includes('[msg '), `a lone message must NEVER grow a [msg <id>] label. Prompt: ${prompt}`);
    // Byte-equality pin: the message text reaches the prompt exactly once, bare —
    // the pre-change prompt had exactly this one occurrence and no scaffolding.
    assert.equal(prompt.split('SINGLE_QUEUED_DELTA').length - 1, 1, `the message text appears exactly once. Prompt: ${prompt}`);
    // Fix-wave B1: count capture-worker replies (the _Ref:-bearing topic-status
    // pin is system traffic, not a dispatch).
    assert.equal(workerReplies(sent).length, 2, `one reply per turn, no extra dispatches. Sent: ${JSON.stringify(sent)}`);
  });

  it('T4: a queued slash-command bounds the batch, then produces its own local reply', async () => {
    const { capturePath } = await writeDispatchFixture(tempDir);
    await seedTopicState(tempDir);

    const sent: string[] = [];
    await runScenario(
      [
        { updates: [textUpdate(31, 311, 'WARMUP_FOUR_444')] },
        {
          updates: [
            textUpdate(32, 312, 'FOUR_HEAD_445'),
            textUpdate(33, 313, 'FOUR_FOLDED_446'),
            textUpdate(34, 314, '/status'),
            textUpdate(35, 315, 'FOUR_TAIL_447'),
          ],
          proceed: () => blockContaining(capturePath, 'WARMUP_FOUR_444') !== undefined,
        },
      ],
      () => blockContaining(capturePath, 'FOUR_TAIL_447') !== undefined && sent.some((t) => t.includes('Topic Status')),
      sent,
      { dispatchStartedAt: 0 },
    );

    const prompt = promptIn(capturePath, '[Batched: 2 messages, in the order they were sent]');
    assert.ok(prompt.includes('FOUR_HEAD_445') && prompt.includes('FOUR_FOLDED_446'), `batch = head + first follower. Prompt: ${prompt}`);
    assert.ok(!prompt.includes('FOUR_TAIL_447'), 'the entry behind the command must NOT be folded');
    assert.ok(!prompt.includes('/status'), 'the command must NOT be folded as text');
    const tailPrompt = promptIn(capturePath, 'FOUR_TAIL_447');
    assert.ok(!tailPrompt.includes('[Batched'), 'the tail dispatches alone afterwards');
    assert.ok(sent.some((t) => t.includes('Topic Status')), `the /status command produced its own local reply. Sent: ${JSON.stringify(sent)}`);
  });

  it('T5: an arrival DURING the combined turn is absent from it and dispatches next', async () => {
    const { capturePath } = await writeDispatchFixture(tempDir);
    await seedTopicState(tempDir);

    const sent: string[] = [];
    await runScenario(
      [
        { updates: [textUpdate(41, 411, 'WARMUP_FIVE_551')] },
        {
          updates: [textUpdate(42, 412, 'FIVE_HEAD_552'), textUpdate(43, 413, 'FIVE_FOLDED_553')],
          proceed: () => blockContaining(capturePath, 'WARMUP_FIVE_551') !== undefined,
        },
        {
          updates: [textUpdate(44, 414, 'FIVE_LATE_554')],
          proceed: () => blockContaining(capturePath, '[Batched:') !== undefined,
        },
      ],
      () => blockContaining(capturePath, 'FIVE_LATE_554') !== undefined,
      sent,
      { dispatchStartedAt: 0 },
    );

    const prompt = promptIn(capturePath, '[Batched: 2 messages, in the order they were sent]');
    assert.ok(prompt.includes('FIVE_HEAD_552') && prompt.includes('FIVE_FOLDED_553'), 'the batch carries its compile-time snapshot');
    assert.ok(!prompt.includes('FIVE_LATE_554'), 'a mid-turn arrival must NOT be in the combined prompt');
    const latePrompt = promptIn(capturePath, 'FIVE_LATE_554');
    assert.ok(!latePrompt.includes('[Batched'), 'the late arrival dispatches on its own next turn');
  });

  it('T6: a queued voice note folds its transcript, indexes the audio, and echoes (batched)', async () => {
    const { capturePath } = await writeDispatchFixture(tempDir);
    await seedTopicState(tempDir);

    const sent: string[] = [];
    await runScenario(
      [
        { updates: [textUpdate(51, 511, 'WARMUP_SIX_661')] },
        {
          updates: [textUpdate(52, 512, 'SIX_HEAD_662'), voiceUpdate(53, 513, 'sixfollow_fid', 'sixfollow_fuid')],
          proceed: () => blockContaining(capturePath, 'WARMUP_SIX_661') !== undefined,
        },
      ],
      () =>
        blockContaining(capturePath, 'SIX_VOICE_TRANSCRIPT_424') !== undefined &&
        sent.some((t) => plain(t).includes('Heard (batched):')),
      sent,
      { dispatchStartedAt: 0 },
    );

    const prompt = promptIn(capturePath, '[Batched: 2 messages, in the order they were sent]');
    assert.ok(prompt.includes('SIX_VOICE_TRANSCRIPT_424'), `the voice follower's transcript must be in the combined prompt. Prompt: ${prompt}`);
    // Fix-wave A1: the echo goes over the wire MarkdownV2-escaped (`\(`, `\_`),
    // so match the UNESCAPED text — and pin the full frozen §4.4 label with its
    // single colon. Still affirmative: no echo sent ⇒ `.some` is false ⇒ red.
    const echo = sent.find((t) => plain(t).includes('Heard (batched):'));
    assert.ok(echo !== undefined && plain(echo).includes('SIX_VOICE_TRANSCRIPT_424'), `a batched echo per transcript was sent. Sent: ${JSON.stringify(sent)}`);
    assert.ok(echo === undefined || !plain(echo).includes('Heard (batched)::'), `the echo label must be single-colon (SPEC §4.4). Echo: ${plain(echo ?? '')}`);

    const indexPath = join(tempDir, 'attachments', String(CHAT_ID), 'audio-index.json');
    assert.ok(existsSync(indexPath), 'the durable audio index must exist');
    const index = readFileSync(indexPath, 'utf8');
    assert.ok(index.includes('sixfollow_fuid'), `the audio index must have a row for the folded note. Index: ${index}`);
  });

  it('T7: mid-turn the batch left NOTHING re-dispatchable (head materialized, followers consumed)', async () => {
    const { capturePath } = await writeDispatchFixture(tempDir);
    await seedTopicState(tempDir);

    let stashed: { recs: PendingDispatch[] } | undefined;
    const sent: string[] = [];
    await runScenario(
      [
        { updates: [textUpdate(91, 911, 'WARMUP_SEVEN_777')] },
        {
          updates: [textUpdate(92, 912, 'SEVEN_HEAD_778'), textUpdate(93, 913, 'SEVEN_TAIL_779')],
          proceed: () => blockContaining(capturePath, 'WARMUP_SEVEN_777') !== undefined,
        },
      ],
      async () => {
        if (stashed) return true;
        const recs = await listPendingDispatches();
        const head = recs.find((r) => r.updateId === 92);
        if (head?.foldedFrom?.length) {
          stashed = { recs };
          return true;
        }
        return false;
      },
      sent,
      { dispatchStartedAt: 0 },
    );

    assert.ok(stashed, 'the batched turn must have been observed mid-turn (worker holds 2500ms)');
    const live = stashed!.recs.filter((r) => r.updateId === 92 || r.updateId === 93);
    assert.equal(live.length, 1, `exactly the head record may be live mid-turn; got: ${JSON.stringify(live.map((r) => r.updateId))}`);
    assert.equal(live[0].updateId, 92);
    assert.ok(live[0].userText.includes('[Batched: 2 messages'), 'the head record recovers the whole batch');
    assert.ok(!live[0].heldForTopic, 'the head is a normal dispatch, not a held record');
  });

  it('T7b: the compile marks folded followers heldForTopic + heldAt on the durable record', async () => {
    // The mid-turn flip itself sits inside one microtask chain (compile step 7 →
    // seam removal), so it is asserted here against the REAL compiler + REAL
    // store — the deterministic half of the crash-window hold (WP-2 T6's e2e twin).
    const f1 = registerQueuedUpdate(TOPIC_KEY, 95, 'SEVEN_FOLLOWER_A_781', undefined, 951);
    const f2 = registerQueuedUpdate(TOPIC_KEY, 96, 'SEVEN_FOLLOWER_B_782', undefined, 952);
    await addPendingDispatch({ updateId: 95, chatId: CHAT_ID, threadId: THREAD_ID, messageId: 951, userText: 'SEVEN_FOLLOWER_A_781', startedAt: new Date().toISOString() });
    await addPendingDispatch({ updateId: 96, chatId: CHAT_ID, threadId: THREAD_ID, messageId: 952, userText: 'SEVEN_FOLLOWER_B_782', startedAt: new Date().toISOString() });

    const plan = await compileBatchFold({
      topicKey: TOPIC_KEY, chatId: CHAT_ID, threadId: THREAD_ID,
      head: { updateId: 94, messageId: 950, text: 'SEVEN_HEAD_TEXT_780' },
    });
    assert.ok(plan, 'a two-follower compile must produce a plan');
    assert.ok(f1.cancelled && f2.cancelled, 'both followers were confirmed (consumed from the queue)');

    const recs = await listPendingDispatches();
    const r95 = recs.find((r) => r.updateId === 95);
    const r96 = recs.find((r) => r.updateId === 96);
    assert.equal(r95?.heldForTopic, true, `follower A record must be under the crash-window hold. Rec: ${JSON.stringify(r95)}`);
    assert.equal(r96?.heldForTopic, true, `follower B record must be under the crash-window hold. Rec: ${JSON.stringify(r96)}`);
    assert.ok(r95?.heldAt && !Number.isNaN(Date.parse(r95.heldAt)), 'heldAt is a valid ISO timestamp');
  });

  it('T8: /steer while entries are queued wins — its prompt folds them, no batch header', async () => {
    const { capturePath, startedFlag } = await writeDispatchFixture(tempDir);
    await seedTopicState(tempDir);

    const sent: string[] = [];
    const steerSig: DispatchSignal = { dispatchStartedAt: 0 };
    await runScenario(
      [
        { updates: [textUpdate(61, 611, 'WARMUP_EIGHT_888')] },
        {
          updates: [
            textUpdate(62, 612, 'EIGHT_FOLDED_TEXT_889'),
            steerUpdate(63, 613, '/steer EIGHT_STEER_PROMPT_890', 611),
          ],
          // The steer's kill needs a verifiably LIVE worker (pid registry grace),
          // exactly the steer-voice-fold harness condition.
          proceed: () =>
            steerSig.dispatchStartedAt > 0 &&
            Date.now() - steerSig.dispatchStartedAt >= 500 &&
            existsSync(startedFlag),
        },
      ],
      () => blockContaining(capturePath, 'EIGHT_STEER_PROMPT_890') !== undefined,
      sent,
      steerSig,
    );

    const steeredPrompt = promptIn(capturePath, 'EIGHT_STEER_PROMPT_890');
    assert.ok(steeredPrompt.includes('EIGHT_FOLDED_TEXT_889'), `the steer prompt must contain the queued text. Prompt: ${steeredPrompt}`);
    assert.ok(!captureBlocks(capturePath).some((b) => b.includes('[Batched')), 'the steer fold must NOT produce a batch header');
  });

  it('T9: an orchestrator-mode topic batches through the SAME seam (shared lane coverage)', async () => {
    // Fix-wave T9 amendment (2026-09-06): the original assertions waited for
    // '[Batched:' in a CAPTURED PROMPT — unreachable, because the orchestrator
    // lane's FRESH prompt (buildOrchestratorPrompt, shipped AI-203 shape)
    // carries routing instructions only and never interpolates the user text,
    // so the proceed gate itself could never fire and no second turn ever ran.
    // The shared-seam proof therefore targets the LANE-INDEPENDENT surface the
    // seam and E3 actually write: the dispatch-record lifecycle, identical to
    // T7's but on the orchestrator lane (the combined userText + foldedFrom on
    // the head record, follower consumed at proven materialization).
    const { capturePath } = await writeDispatchFixture(tempDir);
    await seedTopicState(tempDir, { orchestrator_enabled: true });

    let stashed: PendingDispatch[] | undefined;
    const sent: string[] = [];
    await runScenario(
      [
        { updates: [textUpdate(71, 711, 'WARMUP_NINE_999')] },
        {
          updates: [textUpdate(72, 712, 'NINE_HEAD_998'), textUpdate(73, 713, 'NINE_TAIL_997')],
          proceed: () => blockContaining(capturePath, 'You are the orchestrator') !== undefined,
        },
      ],
      async () => {
        if (stashed) return true;
        const recs = await listPendingDispatches();
        const head = recs.find((r) => r.updateId === 72);
        if (head?.foldedFrom?.length) {
          stashed = recs;
          return true;
        }
        return false;
      },
      sent,
      { dispatchStartedAt: 0 },
    );

    assert.ok(stashed, 'the orchestrator-lane batched turn must be observed mid-turn (worker holds 2500ms on the orchestrator prompt)');
    const head = stashed!.find((r) => r.updateId === 72);
    assert.ok(head, `the orchestrator head record must be live mid-turn. Store updateIds: ${JSON.stringify(stashed!.map((r) => r.updateId))}`);
    assert.ok(head.userText.includes('[Batched: 2 messages'), `the orchestrator lane's turn received the combined text. Got: ${head.userText}`);
    assert.ok(head.userText.includes('NINE_HEAD_998') && head.userText.includes('NINE_TAIL_997'), `the whole batch reached the orchestrator lane. Got: ${head.userText}`);
    assert.deepEqual(head.foldedFrom, [{ updateId: 73, messageId: 713 }], `foldedFrom on the orchestrator lane. Got: ${JSON.stringify(head.foldedFrom)}`);
    assert.ok(!stashed!.some((r) => r.updateId === 73), 'the folded follower was consumed on the orchestrator lane too');
  });

  it('T10: a queued voice note whose transcript is a slash-command is withheld, then yields its own status reply', async () => {
    const { capturePath } = await writeDispatchFixture(tempDir);
    await seedTopicState(tempDir);

    const sent: string[] = [];
    await runScenario(
      [
        { updates: [textUpdate(81, 811, 'WARMUP_TEN_101')] },
        {
          updates: [textUpdate(82, 812, 'TEN_HEAD_102'), voiceUpdate(83, 813, 'tenfollow_fid', 'tenfollow_fuid')],
          proceed: () => blockContaining(capturePath, 'WARMUP_TEN_101') !== undefined,
        },
      ],
      () =>
        blockContaining(capturePath, 'TEN_HEAD_102') !== undefined &&
        sent.some((t) => t.includes('Topic Status')),
      sent,
      { dispatchStartedAt: 0 },
    );

    // Withheld ⇒ the head dispatches ALONE: no header, and the spoken command
    // never entered ANY prompt.
    const headPrompt = promptIn(capturePath, 'TEN_HEAD_102');
    assert.ok(!headPrompt.includes('[Batched'), `a fully-withheld fold must leave the head alone. Prompt: ${headPrompt}`);
    assert.ok(!captureBlocks(capturePath).some((b) => b.includes('/status')), 'the spoken command must never be folded as text into any prompt');
    // The withheld note's own later turn yields the status reply — nothing dropped.
    assert.ok(sent.some((t) => t.includes('Topic Status')), `the withheld note must still produce its own /status reply. Sent: ${JSON.stringify(sent)}`);
  });

  it('T-BD1 (W4 head gate, AI-203 inc 3): a reply-shaped head dispatches ALONE; the follower stays queued for its own turn', async () => {
    const { capturePath } = await writeDispatchFixture(tempDir);
    await seedTopicState(tempDir);

    const sent: string[] = [];
    await runScenario(
      [
        { updates: [textUpdate(111, 1011, 'WARMUP_ELEVEN_111')] },
        {
          updates: [
            replyShapeUpdate(112, 1012, 'ELEVEN_REPLY_HEAD_112', 1011),
            textUpdate(113, 1013, 'ELEVEN_QUEUED_TAIL_113'),
          ],
          proceed: () => blockContaining(capturePath, 'WARMUP_ELEVEN_111') !== undefined,
        },
      ],
      () =>
        blockContaining(capturePath, 'ELEVEN_REPLY_HEAD_112') !== undefined &&
        blockContaining(capturePath, 'ELEVEN_QUEUED_TAIL_113') !== undefined,
      sent,
      { dispatchStartedAt: 0 },
    );

    // The reply-shaped head NEVER compiles: its prompt carries its own text with
    // no batch header, and the follower's text is absent from it.
    const headPrompt = promptIn(capturePath, 'ELEVEN_REPLY_HEAD_112');
    assert.ok(!headPrompt.includes('[Batched'), `a reply-shaped head must never fold. Prompt: ${headPrompt}`);
    assert.ok(!headPrompt.includes('ELEVEN_QUEUED_TAIL_113'), 'the follower must not ride the head dispatch');
    // The follower remained queued and got its own later turn, alone.
    const tailPrompt = promptIn(capturePath, 'ELEVEN_QUEUED_TAIL_113');
    assert.ok(!tailPrompt.includes('[Batched'), `the queued follower dispatches alone afterwards. Prompt: ${tailPrompt}`);
    assert.ok(!tailPrompt.includes('ELEVEN_REPLY_HEAD_112'), 'each message dispatches with its OWN text');
  });

  it('T-BD2 (W4 follower e2e, AI-203 inc 3): a reply-shaped follower is withheld from the fold, then dispatches alone with its own text', async () => {
    const { capturePath } = await writeDispatchFixture(tempDir);
    await seedTopicState(tempDir);

    const sent: string[] = [];
    await runScenario(
      [
        { updates: [textUpdate(121, 1021, 'WARMUP_TWELVE_121')] },
        {
          updates: [
            textUpdate(122, 1022, 'TWELVE_HEAD_122'),
            replyShapeUpdate(123, 1023, 'TWELVE_REPLY_FOLLOWER_123', 1021),
            textUpdate(124, 1024, 'TWELVE_TAIL_124'),
          ],
          proceed: () => blockContaining(capturePath, 'WARMUP_TWELVE_121') !== undefined,
        },
      ],
      () =>
        blockContaining(capturePath, '[Batched: 2 messages, in the order they were sent]') !== undefined &&
        blockContaining(capturePath, 'TWELVE_REPLY_FOLLOWER_123') !== undefined,
      sent,
      { dispatchStartedAt: 0 },
    );

    // The fold RAN — head + plain tail combined (affirmative header) — with the
    // reply-shaped follower WITHHELD from it.
    const batchPrompt = promptIn(capturePath, '[Batched: 2 messages, in the order they were sent]');
    assert.ok(batchPrompt.includes('TWELVE_HEAD_122') && batchPrompt.includes('TWELVE_TAIL_124'), `the plain pair folded. Prompt: ${batchPrompt}`);
    assert.ok(!batchPrompt.includes('TWELVE_REPLY_FOLLOWER_123'), 'the reply-shaped follower must be withheld from the fold');
    // The withheld follower reached processUpdate with its own update intact —
    // its own turn, own text, no batch header, never re-texted by a compile.
    const ownPrompt = promptIn(capturePath, 'TWELVE_REPLY_FOLLOWER_123');
    assert.ok(!ownPrompt.includes('[Batched'), `the reply-shaped follower dispatches alone with its reply_to_message intact. Prompt: ${ownPrompt}`);
    assert.ok(ownPrompt.includes('TWELVE_REPLY_FOLLOWER_123'), 'its own text reached the dispatch unchanged');
  });
});
