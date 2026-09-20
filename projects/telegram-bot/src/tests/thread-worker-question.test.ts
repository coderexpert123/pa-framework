/**
 * AI-203 WP-2 tests: thread store worker pin + executor wiring + non-voice
 * question parity.
 *
 * Two concerns under test:
 *  1. Item 4 (worker pin): a thread with `worker: 'zclaude'` ⇒ the dispatch
 *     seam receives `preferredWorker: 'zclaude'`; a thread with no worker ⇒
 *     opts have no `preferredWorker` key (cascade default).
 *  2. Item 2 (question parity): a NON-voice thread whose output carries a
 *     `question` action ⇒ setPendingQuestion called, a question FYI sent with
 *     `rq:<n>:<idx>` option buttons, the done FYI still carries the result.
 *     A VOICE thread keeps the existing mirror path (no pendingQuestion).
 *     Shape validation rejects text >500 / options >4. takePendingQuestion
 *     returns-and-clears (second take is undefined).
 *
 * Every test drives the REAL executor over the REAL topic-threads store (temp
 * dir via _setStoreDirForTest); only the worker dispatch and the Telegram FYI
 * send ride test seams. PA_NOTIFY_DISABLED is set by the suite runner.
 */

import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CommandResult, RunOptions } from '../../../../pa/dist/src/types.js';
import {
  createThread,
  getThread,
  updateThread,
  setPendingQuestion,
  takePendingQuestion,
  THREAD_ACTIVITY_THROTTLE_MS,
  _clearThreadsForTest,
  _setStoreDirForTest,
  type ThreadRecord,
} from '../topic-threads.js';
import {
  executeTopicThread,
  buildThreadQuestionKeyboard,
  _setActivityPumpIntervalForTest,
  _resetThreadInterruptsForTest,
  type AskMirrorFn,
  type ExecuteTopicThreadArgs,
  type ThreadDispatchFn,
  type ThreadFyiSender,
  type ThreadTopicContext,
} from '../thread-executor.js';
import type { InlineKeyboardMarkup } from '../telegram.js';
import { waitForDrain } from './test-teardown-guard.js';

const CHAT_ID = -1001234567890; // synthetic fixture family — never a real chat
const THREAD_ID = 5001;
const CTX: ThreadTopicContext = { chatId: CHAT_ID, threadId: THREAD_ID, topicName: 'Test Topic' };
const KEY = `${CHAT_ID}_${THREAD_ID}`;
const VOICE_TASK = 'vi-2638f25056ba';

let home: string;
let storeDir: string;
let workdir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pa-wp2-'));
  storeDir = mkdtempSync(join(tmpdir(), 'pa-wp2-store-'));
  workdir = mkdtempSync(join(tmpdir(), 'pa-wp2-wd-'));
  process.env.PA_HOME = home;
  _setStoreDirForTest(storeDir);
  _setActivityPumpIntervalForTest(THREAD_ACTIVITY_THROTTLE_MS);
  _resetThreadInterruptsForTest();
});

afterEach(async () => {
  await waitForDrain();
  _setActivityPumpIntervalForTest(THREAD_ACTIVITY_THROTTLE_MS);
  _setStoreDirForTest(undefined);
  _clearThreadsForTest();
  delete process.env.PA_HOME;
  for (const dir of [home, storeDir, workdir]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function okResult(output: string, sessionId?: string): CommandResult {
  return { success: true, output, exitCode: 0, ...(sessionId ? { sessionId } : {}) };
}

async function makeThread(opts: { title?: string; goal?: string; worker?: string } = {}): Promise<ThreadRecord> {
  const created = await createThread(KEY, {
    title: opts.title ?? 'Sweep logs',
    goal: opts.goal ?? 'Run the sweep script.',
    workdir,
    ...(opts.worker ? { worker: opts.worker } : {}),
  });
  assert.ok(created.ok, `fixture createThread failed: ${!created.ok ? created.reason : ''}`);
  return created.thread;
}

function makeFyiRecorder() {
  const calls: { text: string; kind: string; replyMarkup?: InlineKeyboardMarkup }[] = [];
  const sendFyi: ThreadFyiSender = async (text, kind, replyMarkup) => {
    calls.push({ text, kind, replyMarkup });
    return 42;
  };
  return { calls, sendFyi };
}

function makeDispatchRecorder(impl: ThreadDispatchFn) {
  const calls: { prompt: string; opts: RunOptions }[] = [];
  const dispatch: ThreadDispatchFn = async (prompt, opts) => {
    calls.push({ prompt, opts });
    return impl(prompt, opts);
  };
  return { calls, dispatch };
}

function makeArgs(
  thread: ThreadRecord,
  fyi: { sendFyi: ThreadFyiSender },
  dispatch: ThreadDispatchFn,
  overrides: Partial<ExecuteTopicThreadArgs> = {}
): ExecuteTopicThreadArgs {
  return {
    thread,
    topicCtx: CTX,
    secrets: {},
    token: 'test-token',
    sendFyi: fyi.sendFyi,
    dispatch,
    failVoiceTask: async (taskId) => ({ ok: true, taskId }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Item 4: per-thread worker pin
// ---------------------------------------------------------------------------

describe('worker pin (item 4)', () => {
  it('a pinned thread dispatches with preferredWorker set to the pin', async () => {
    const thread = await makeThread({ worker: 'zclaude' });
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'zclaude', result: okResult('Done.', 'sess-1') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].opts.preferredWorker, 'zclaude');
    // The pin is also stored on the record.
    const stored = await getThread(KEY, thread.id);
    assert.equal(stored?.worker, 'zclaude');
  });

  it('a thread with no worker dispatches with preferredWorker absent (cascade default)', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('Done.', 'sess-2') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].opts.preferredWorker, undefined);
    assert.ok(!('preferredWorker' in rec.calls[0].opts), 'preferredWorker key must be absent');
    const stored = await getThread(KEY, thread.id);
    assert.equal(stored?.worker, undefined);
  });
});

// ---------------------------------------------------------------------------
// Item 2: non-voice thread question parity
// ---------------------------------------------------------------------------

describe('non-voice thread question (item 2)', () => {
  it('sets pendingQuestion and sends a question FYI with rq: option buttons', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const output = 'Done.\n\n[PA_META]: {"actions":[{"type":"question","text":"Which window?","options":["Morning","Evening"]}]}';
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(output, 'sess-q1') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    // pendingQuestion is set on the record.
    const stored = await getThread(KEY, thread.id);
    assert.deepEqual(stored?.pendingQuestion, { text: 'Which window?', options: ['Morning', 'Evening'] });

    // A question FYI was sent with the ❓ prefix and option buttons.
    const qFyi = fyi.calls.find((c) => c.kind === 'thread-question');
    assert.ok(qFyi, 'a thread-question FYI was sent');
    assert.ok(qFyi!.text.startsWith(`❓ Thread ${thread.id} asks: Which window?`));
    assert.ok(qFyi!.replyMarkup, 'question FYI carries a reply keyboard');
    const keyboard = qFyi!.replyMarkup!;
    assert.equal(keyboard.inline_keyboard.length, 2);
    assert.equal(keyboard.inline_keyboard[0][0].callback_data, `rq:${thread.n}:0`);
    assert.equal(keyboard.inline_keyboard[0][0].text, 'Morning');
    assert.equal(keyboard.inline_keyboard[1][0].callback_data, `rq:${thread.n}:1`);
    assert.equal(keyboard.inline_keyboard[1][0].text, 'Evening');

    // The done FYI still carries the result.
    const doneFyi = fyi.calls.find((c) => c.kind === 'thread-done');
    assert.ok(doneFyi, 'a thread-done FYI was sent');
    assert.ok(doneFyi!.text.includes('Done.'));
    // The done FYI also carries the question buttons (co-occurrence).
    assert.ok(doneFyi!.replyMarkup, 'done FYI carries the question keyboard too');
  });

  it('a voice-stamped thread keeps the mirror path (no pendingQuestion)', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { voiceTaskIds: [VOICE_TASK] });
    const fyi = makeFyiRecorder();
    const output = 'Done.\n\n[PA_META]: {"actions":[{"type":"question","text":"Which window?","options":["Morning","Evening"]}]}';
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(output, 'sess-q2') }));

    const mirrorCalls: unknown[] = [];
    const mirrorAsk: AskMirrorFn = async (input) => {
      mirrorCalls.push(input);
      return { ok: true, taskId: VOICE_TASK };
    };
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch, { mirrorAsk }));

    // No pendingQuestion on the record (voice path, unchanged).
    const stored = await getThread(KEY, thread.id);
    assert.equal(stored?.pendingQuestion, undefined);

    // The mirror was called (voice path).
    assert.equal(mirrorCalls.length, 1);

    // No thread-question FYI (the voice path mirrors, not buttons).
    const qFyi = fyi.calls.find((c) => c.kind === 'thread-question');
    assert.equal(qFyi, undefined);

    // The done FYI carries the mirror footer.
    const doneFyi = fyi.calls.find((c) => c.kind === 'thread-done');
    assert.ok(doneFyi);
    assert.ok(doneFyi!.text.includes('Also asked in your Voice Inbox app'));
  });

  it('rejects text >500 chars (no pendingQuestion)', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const longText = 'x'.repeat(501);
    const output = `Done.\n\n[PA_META]: {"actions":[{"type":"question","text":"${longText}","options":["A","B"]}]}`;
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(output, 'sess-q3') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    const stored = await getThread(KEY, thread.id);
    assert.equal(stored?.pendingQuestion, undefined);
    // No question FYI sent.
    const qFyi = fyi.calls.find((c) => c.kind === 'thread-question');
    assert.equal(qFyi, undefined);
    // The done FYI carries the rejection notice.
    const doneFyi = fyi.calls.find((c) => c.kind === 'thread-done');
    assert.ok(doneFyi);
    assert.ok(doneFyi!.text.includes('question rejected'));
  });

  it('rejects options >4 (no pendingQuestion)', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const output = 'Done.\n\n[PA_META]: {"actions":[{"type":"question","text":"Pick one","options":["A","B","C","D","E"]}]}';
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(output, 'sess-q4') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    const stored = await getThread(KEY, thread.id);
    assert.equal(stored?.pendingQuestion, undefined);
    const qFyi = fyi.calls.find((c) => c.kind === 'thread-question');
    assert.equal(qFyi, undefined);
    const doneFyi = fyi.calls.find((c) => c.kind === 'thread-done');
    assert.ok(doneFyi);
    assert.ok(doneFyi!.text.includes('question rejected'));
  });
});

// ---------------------------------------------------------------------------
// setPendingQuestion / takePendingQuestion store API
// ---------------------------------------------------------------------------

describe('setPendingQuestion / takePendingQuestion store API', () => {
  it('take returns the question and clears it; a second take returns undefined', async () => {
    const thread = await makeThread();
    // createThread starts as 'running' (under the cap).
    assert.equal(thread.status, 'running');

    const question = { text: 'Which scope?', options: ['Full', 'Partial'] };
    const set = await setPendingQuestion(KEY, thread.id, question);
    assert.equal(set, true);

    const stored = await getThread(KEY, thread.id);
    assert.deepEqual(stored?.pendingQuestion, question);

    const taken = await takePendingQuestion(KEY, thread.id);
    assert.deepEqual(taken, question);

    // Cleared on the record.
    const after = await getThread(KEY, thread.id);
    assert.equal(after?.pendingQuestion, undefined);

    // Second take is undefined.
    const taken2 = await takePendingQuestion(KEY, thread.id);
    assert.equal(taken2, undefined);
  });

  it('setPendingQuestion returns false on a cancelled record', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'cancelled' });
    const set = await setPendingQuestion(KEY, thread.id, { text: 'Q?', options: ['A'] });
    assert.equal(set, false);
    const stored = await getThread(KEY, thread.id);
    assert.equal(stored?.pendingQuestion, undefined);
  });

  it('setPendingQuestion returns false on an unknown thread', async () => {
    const set = await setPendingQuestion(KEY, 't-999', { text: 'Q?', options: ['A'] });
    assert.equal(set, false);
  });

  it('setPendingQuestion succeeds on a done record', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done' });
    const set = await setPendingQuestion(KEY, thread.id, { text: 'Q?', options: ['A'] });
    assert.equal(set, true);
    const stored = await getThread(KEY, thread.id);
    assert.deepEqual(stored?.pendingQuestion, { text: 'Q?', options: ['A'] });
  });
});

// ---------------------------------------------------------------------------
// buildThreadQuestionKeyboard (inline builder)
// ---------------------------------------------------------------------------

describe('buildThreadQuestionKeyboard', () => {
  it('renders one button per option with rq:<n>:<idx> callback data', () => {
    const kb = buildThreadQuestionKeyboard(3, ['Yes', 'No', 'Maybe']);
    assert.equal(kb.inline_keyboard.length, 3);
    assert.equal(kb.inline_keyboard[0][0].text, 'Yes');
    assert.equal(kb.inline_keyboard[0][0].callback_data, 'rq:3:0');
    assert.equal(kb.inline_keyboard[1][0].text, 'No');
    assert.equal(kb.inline_keyboard[1][0].callback_data, 'rq:3:1');
    assert.equal(kb.inline_keyboard[2][0].text, 'Maybe');
    assert.equal(kb.inline_keyboard[2][0].callback_data, 'rq:3:2');
  });

  it('callback_data stays well under the 64-byte Telegram limit', () => {
    const kb = buildThreadQuestionKeyboard(999999, ['A']);
    const firstRow = kb.inline_keyboard[0];
    assert.ok(firstRow, 'keyboard has at least one row');
    const firstBtn = firstRow[0];
    assert.ok(firstBtn, 'first row has at least one button');
    assert.ok(firstBtn.callback_data, 'button has callback_data');
    assert.ok(firstBtn.callback_data.length <= 64);
  });
});
