/**
 * Thread-executor lane tests (AI-203 WP-4).
 *
 * Every test drives the REAL executor over the REAL topic-threads store (temp
 * dir via _setStoreDirForTest); only the worker dispatch and the Telegram FYI
 * send ride test seams. PA_NOTIFY_DISABLED is set by the suite runner; no test
 * here touches the network.
 */

import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CommandResult, RunOptions, WorkerConfig } from '../../../../pa/dist/src/types.js';
import {
  createThread,
  getThread,
  queueThreadInput,
  updateThread,
  touchThread,
  cancelRunningThreads,
  claimThreadStarts,
  THREAD_ACTIVITY_THROTTLE_MS,
  _clearThreadsForTest,
  _setStoreDirForTest,
  type ThreadRecord,
} from '../topic-threads.js';
import {
  executeTopicThread,
  buildThreadPrompt,
  buildThreadResumedTurnPrompt,
  signalThreadInterrupt,
  reconcileThreadQueues,
  wakeWallParkedOnCooldownExpiry,
  failVoiceTaskInLedger,
  completeVoiceTaskInLedger,
  TOPIC_THREAD_MAX_ATTEMPTS,
  THREAD_PARK_LADDER_MINUTES,
  THREAD_PARK_VALVE,
  THREAD_VOICE_CLOSE_GRACE_MS,
  THREAD_VOICE_EMPTY_RESULT_NOTE,
  THREAD_VOICE_REFUSED_RESULT_NOTE,
  THREAD_ROUTE_RETRY_SWEEP_MAX_AGE_MS,
  _resetThreadQueueReconcileForTest,
  _resetThreadInterruptsForTest,
  _setActivityPumpIntervalForTest,
  _setLastReconcileAtForTest,
  _setPumpTouchFnForTest,
  _waitForThreadExecutionsForTest,
  type AskMirrorFn,
  type ExecuteTopicThreadArgs,
  type ThreadDispatchFn,
  type ThreadFyiSender,
  type ThreadTopicContext,
  type VoiceCompleteFn,
  type VoiceFailFn,
  type VoiceRouteRetryFn,
  type VoiceRouteRetryResult,
} from '../thread-executor.js';
import { NO_WORKERS_AVAILABLE_ERROR } from '../../../../pa/dist/src/workers.js';
import { flushLog } from '../../../../pa/dist/src/lib/log.js';
import { capPromptForWidget, type AskMirrorInput, type MirrorChild, type MirrorDeps, type MirrorSpawnFn } from '../voice-input-mirror.js';
import { THREAD_FYI_ANCHOR_PATTERN } from '../orchestrator.js';
import { cwdToClaudeProjectDir } from '../session.js';
import { waitForDrain } from './test-teardown-guard.js';

const CHAT_ID = -1001234567890; // synthetic fixture family — never a real chat
const THREAD_ID = 5001;
const CTX: ThreadTopicContext = { chatId: CHAT_ID, threadId: THREAD_ID, topicName: 'Test Topic' };
const KEY = `${CHAT_ID}_${THREAD_ID}`;

let home: string;
let storeDir: string;
let workdir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pa-thread-exec-'));
  storeDir = mkdtempSync(join(tmpdir(), 'pa-thread-store-'));
  workdir = mkdtempSync(join(tmpdir(), 'pa-thread-wd-'));
  process.env.PA_HOME = home;
  _setStoreDirForTest(storeDir);
  _setActivityPumpIntervalForTest(THREAD_ACTIVITY_THROTTLE_MS);
  _resetThreadQueueReconcileForTest();
  _resetThreadInterruptsForTest();
});

afterEach(async () => {
  await waitForDrain();
  // Drain queued app.log appends while PA_HOME still exists — entries are pinned
  // to their enqueue-time home, so rm'ing first strands them on lock-retry
  // behind the serial appendQueue and starves the next test's waitForLog.
  await flushLog();
  _setActivityPumpIntervalForTest(THREAD_ACTIVITY_THROTTLE_MS);
  _setPumpTouchFnForTest(touchThread);
  _setLastReconcileAtForTest(0);
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

/** Read the REAL topic-events jsonl the executor's emitters wrote under PA_HOME. */
async function readTopicEventsJsonl(): Promise<{ kind: string; ref: string | null; detail: string }[]> {
  const raw = await readFile(join(home, 'topic-events', `${KEY}.jsonl`), 'utf8');
  return raw
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { kind: string; ref: string | null; detail: string });
}

async function makeThread(title = 'Sweep logs', goal = 'Run the sweep script.'): Promise<ThreadRecord> {
  const created = await createThread(KEY, { title, goal, workdir });
  assert.ok(created.ok, `fixture createThread failed: ${!created.ok ? created.reason : ''}`);
  return created.thread;
}

function makeFyiRecorder() {
  const calls: { text: string; kind: string }[] = [];
  const sendFyi: ThreadFyiSender = async (text, kind) => {
    calls.push({ text, kind });
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
    // Voice-ledger seam stub mimics the REAL dominant production path so any
    // test that reaches a terminal with a voice-stamped record stays
    // deterministic and spawns no real python at the temp PA_HOME: on a
    // terminal failure the task fails with the thread (ok). Success closes
    // nothing here anymore (2026-09-13 race fix) — the closure lives in the
    // reconcile's late sweep, whose seams ride ThreadQueueReconcileDeps, not
    // these args. Tests that study the failure seam inject recorders via
    // overrides.
    failVoiceTask: async (taskId) => ({ ok: true, taskId }),
    // Routing retry seam stub (2026-09-16): skipped, the dominant production
    // outcome — tests that study the retry inject a recorder via overrides.
    retryVoiceRouting: async (taskId) => ({ outcome: 'skipped', taskId, reason: 'test stub' }),
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Real-dispatch harness (orchestrator-dispatch.test.ts capture-worker idiom)
 * for executions fired by the PRODUCTION wake/reconcile paths — fireClaimedThreads
 * calls executeTopicThread with no seams, so its dispatches ride the REAL
 * runWithFailover. A fake worker configured in the test's temp PA_HOME appends
 * every dispatched prompt (GOTPROMPTSTART…GOTPROMPTEND) to a capture file and
 * holds `holdMs` before replying, so a fired record stays 'running' while the
 * test asserts. Returns the capture file path.
 */
function writeFakeWorker(output: string, opts: { holdMs?: number } = {}): string {
  const capturePath = join(home, 'prompt-capture.txt');
  const workerPath = join(home, 'capture-worker.cjs');
  const b64 = Buffer.from(output, 'utf8').toString('base64');
  writeFileSync(workerPath, [
    "const fs = require('node:fs');",
    "let d = '';",
    "process.stdin.on('data', c => { d += c; });",
    "process.stdin.on('end', () => {",
    `  fs.appendFileSync(${JSON.stringify(capturePath)}, 'GOTPROMPTSTART' + d + 'GOTPROMPTEND');`,
    `  process.stdout.write(Buffer.from(${JSON.stringify(b64)}, 'base64').toString('utf8'));`,
    opts.holdMs ? `  setTimeout(() => process.exit(0), ${opts.holdMs});` : '  process.exitCode = 0;',
    '});',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(home, 'config.yaml'), JSON.stringify({
    workers: [{
      name: 'fake',
      command: 'node',
      args: [workerPath.replace(/\\/g, '/')],
      input_mode: 'stdin-text',
      output_format: 'text',
      check: 'echo ok',
      rate_limit_patterns: [],
      priority: 1,
      state_dir: '/nonexistent/path',
      state_pattern: '*.jsonl',
    }],
  }), 'utf8');
  return capturePath;
}

/** Read the REAL app.log.jsonl the ref-id/logger seams wrote under PA_HOME. */
async function readAppLog(): Promise<string> {
  try {
    return await readFile(join(home, 'app.log.jsonl'), 'utf8');
  } catch {
    return ''; // not created yet
  }
}

/** Poll the app log until it contains `needle` (logger appends are async — a
 *  single immediate read races the flush). Returns the last read content. */
async function waitForLog(needle: string): Promise<string> {
  let log = '';
  for (let i = 0; i < 30; i++) {
    log = await readAppLog();
    if (log.includes(needle)) return log;
    await sleep(100);
  }
  return log;
}

// ---------------------------------------------------------------------------

describe('buildThreadPrompt (spec §4.6 frozen skeleton)', () => {
  it('carries the frozen headings, the topic line, the attempt line, TASK_RULES and the goal', async () => {
    const thread = await makeThread('Sweep logs', 'Run the sweep script and report counts.');
    const prompt = buildThreadPrompt(thread, CTX);
    assert.ok(prompt.startsWith('You are executing a spawned thread for topic "Test Topic" (-1001234567890_5001).'));
    assert.ok(prompt.includes('Thread: t-1 — Sweep logs'));
    assert.ok(prompt.includes('Attempt 1/2. This conversation is your own; later messages in this thread resume it.'));
    assert.ok(prompt.includes('## Your task\nRun the sweep script and report counts.'));
    assert.ok(prompt.includes('## Rules'));
    // TASK_RULES imported from task-executor, never restated: its telegram-output
    // bullet must be present verbatim.
    assert.ok(prompt.includes('Telegram output: write standard Markdown'));
    assert.ok(prompt.includes('Never run `git commit`, `git push`, `git stash`'));
  });

  it('resumed turn uses the ## Context Update shape with the thread header and joined inputs', async () => {
    const thread = await makeThread();
    const prompt = buildThreadResumedTurnPrompt(thread, 'steer one\n\nsteer two');
    assert.ok(prompt.startsWith('## Context Update\nToday is '));
    assert.ok(prompt.includes('. Current time (IST): '));
    assert.ok(prompt.includes('## Thread t-1 — Sweep logs'));
    assert.ok(prompt.includes('## Current Message\nsteer one\n\nsteer two'));
  });

  it('ctx.pointers + ctx.sources + ctx.reservations render between the task block and ## Rules, in that order', async () => {
    const thread = await makeThread('Sweep logs', 'Run the sweep script and report counts.');
    const ctx: ThreadTopicContext = {
      ...CTX,
      pointers: 'Topic brain: /x/BRAIN.md (freshness unknown) — durable per-topic knowledge.\nRecall: `pa recall "<terms>" --thread 5001 --json` searches this topic\'s full history.',
      sources: '## Topic sources\n### grounding.md\n```\nfile body\n```',
      reservations: '## Live reservations\n- Active reservations right now: none.',
    };
    const prompt = buildThreadPrompt(thread, ctx);
    const taskIdx = prompt.indexOf('## Your task');
    const pointersIdx = prompt.indexOf('Topic brain: /x/BRAIN.md');
    const sourcesIdx = prompt.indexOf('## Topic sources');
    const reservationsIdx = prompt.indexOf('## Live reservations');
    const rulesIdx = prompt.indexOf('## Rules');
    assert.ok(taskIdx >= 0 && pointersIdx > taskIdx, 'pointers land after the task block');
    assert.ok(sourcesIdx > pointersIdx, 'sources follow the pointer lines');
    assert.ok(reservationsIdx > sourcesIdx, 'reservations follow the sources section');
    assert.ok(reservationsIdx < rulesIdx, 'dynamic sections land before ## Rules');
    // One blank line of separation on each side.
    assert.ok(prompt.includes('report counts.\n\nTopic brain:'), 'task block separated by one blank line');
    assert.ok(prompt.includes('none.\n\n## Rules'), 'reservations separated from ## Rules by one blank line');
  });

  it('absent pointers/sources/reservations leave the skeleton byte-identical (intra-run)', async () => {
    const thread = await makeThread('Sweep logs', 'Run the sweep script and report counts.');
    const bare = buildThreadPrompt(thread, CTX);
    const withUndefined = buildThreadPrompt(thread, { ...CTX, pointers: undefined, sources: undefined, reservations: undefined });
    assert.equal(withUndefined, bare, 'undefined fields must render the frozen skeleton');
  });

  it('a fresh dispatch renders the real ## Topic sources from the topic state file (one inline + one missing)', async () => {
    const realFile = join(home, 'real-source.md');
    writeFileSync(realFile, 'grounding body', 'utf8');
    writeFileSync(join(home, `telegram-bot-topic-${KEY}.json`), JSON.stringify({
      chat_id: CHAT_ID, thread_id: THREAD_ID, turns: [],
      sources: [{ path: realFile, label: 'real-src' }, { path: join(home, 'gone.md'), label: 'gone-src' }],
    }), 'utf8');
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('done.') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    assert.equal(rec.calls.length, 1);
    const prompt = rec.calls[0].prompt;
    const sourcesIdx = prompt.indexOf('## Topic sources');
    assert.ok(sourcesIdx > prompt.indexOf('## Your task'), 'sources land inside the insert region');
    assert.ok(sourcesIdx < prompt.indexOf('## Rules'), 'sources precede ## Rules');
    assert.ok(prompt.includes('grounding body'), 'the inline-able source content renders');
    assert.ok(prompt.includes('gone'), 'the missing source renders as a named line, never silence');
  });
});

describe('executeTopicThread happy path', () => {
  it('posts pickup + done FYIs, records done with lastResult and the captured session', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('All sweeps complete.', 'sess-1') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    assert.deepEqual(fyi.calls.map((c) => c.kind), ['thread-spawned', 'thread-done']);
    assert.ok(fyi.calls[1].text.startsWith('✅ Thread t-1 done: Sweep logs\n\nAll sweeps complete.'));
    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.status, 'done');
    assert.equal(stored?.lastResult, 'All sweeps complete.');
    assert.equal(stored?.session?.session_id, 'sess-1');
    assert.equal(stored?.session?.worker, 'claude');
    // Frozen dispatch shape: non-topic resource, cascade default, non-empty required.
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].opts.resource, 'topic--1001234567890_5001-th1');
    assert.equal(rec.calls[0].opts.requireNonEmptyOutput, true);
    assert.equal(rec.calls[0].opts.preferredWorker, undefined);
    assert.equal(typeof rec.calls[0].opts.isCancelled, 'function');
    // T-B2a: the strip reaches the dispatch seam (undefined here would mean a
    // silently unwired suppression).
    assert.deepEqual(rec.calls[0].opts.stripArgs, ['--append-system-prompt-file']);
    // T-B2b: the done path emitted to the REAL topic-events jsonl under PA_HOME.
    const events = await readTopicEventsJsonl();
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'thread_completed');
    assert.equal(events[0].ref, 't-1');
    assert.equal(events[0].detail, 'Sweep logs');

    // Increment 3: the done FYI teaches the reply-to-continue gesture, and the
    // anchor pattern in orchestrator.ts must match the REAL texts this module
    // sends (first-line drift would silently kill the anchor steer).
    const capturedPickup = fyi.calls[0].text;
    const capturedDone = fyi.calls[1].text;
    assert.ok(capturedDone.endsWith('_(Reply to this message to continue the thread.)_'));
    assert.ok(THREAD_FYI_ANCHOR_PATTERN.test(capturedPickup));
    assert.ok(THREAD_FYI_ANCHOR_PATTERN.test(capturedDone));
  });
});

describe('premature async reply rides the 2-attempt ladder', () => {
  it('retries once then fails with the failed FYI and NO done FYI', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const premature = 'Launched the sweep and will report back when it finishes.';
    let n = 0;
    const rec = makeDispatchRecorder(async () => {
      n++;
      return { worker: 'agy', result: okResult(premature) };
    });
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    assert.equal(n, 2);
    assert.deepEqual(fyi.calls.map((c) => c.kind), ['thread-spawned', 'thread-retry', 'thread-failed']);
    assert.ok(fyi.calls[1].text.startsWith('⏳ Thread t-1 hit a snag — retrying automatically: Sweep logs'));
    assert.ok(fyi.calls[2].text.startsWith('❌ Thread t-1 failed: Sweep logs'));
    assert.ok(fyi.calls[2].text.includes('premature async reply'));
    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.status, 'failed');
    assert.equal(stored?.attempts, 2);
    assert.ok((stored?.lastError ?? '').includes('premature'));
    // The retry is a NEW dispatch start with the prompt rebuilt (Attempt 2/2).
    assert.ok(rec.calls[1].prompt.includes('Attempt 2/2.'));
    // T-B2c: the fail-at-cap path emitted thread_failed to the real jsonl
    // (detail is the redacted reason, capped at 200 by the event writer).
    const events = await readTopicEventsJsonl();
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'thread_failed');
    assert.equal(events[0].ref, 't-1');
    assert.ok(events[0].detail.includes('premature'));
  });

  it('T-B2d: first attempt premature, second succeeds ⇒ NO thread_failed event, exactly one thread_completed', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const premature = 'Launched the sweep and will report back when it finishes.';
    let n = 0;
    const rec = makeDispatchRecorder(async () => {
      n++;
      if (n === 1) return { worker: 'agy', result: okResult(premature) };
      return { worker: 'claude', result: okResult('sweep finished clean', 'sess-7') };
    });
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    assert.equal(n, 2);
    assert.deepEqual(fyi.calls.map((c) => c.kind), ['thread-spawned', 'thread-retry', 'thread-done']);
    const events = await readTopicEventsJsonl();
    assert.equal(events.filter((e) => e.kind === 'thread_failed').length, 0);
    assert.equal(events.filter((e) => e.kind === 'thread_completed').length, 1);
  });
});

describe('PA_META in thread output', () => {
  it('watch_job registers (the lane promised it); run_skill still gets the unavailable notice', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const watchPath = join(home, 'landing.txt').replace(/\\/g, '/');
    const output = `Done.\n\n[PA_META]: {"actions":[{"type":"watch_job","description":"landing file","check":{"type":"file_exists","path":"${watchPath}"}},{"type":"run_skill","skill":"commit"}]}`;
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(output, 'sess-2') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    const done = fyi.calls.find((c) => c.kind === 'thread-done');
    assert.ok(done, 'done FYI posted');
    assert.ok(done.text.includes('_(Watch registered: w-'), 'registered watch id rides the completion text');
    assert.ok(done.text.includes("_(action 'run_skill' is not available on the thread lane)_"), 'unsupported types still get the loud notice');
    assert.ok(!done.text.includes("action 'watch_job' is not available"), 'watch_job is no longer rejected as unavailable');
    assert.ok(!done.text.includes('[PA_META]'));
    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.lastResult, 'Done.');
    // The watch actually landed in the store (not just a claimed registration).
    const watches = JSON.parse(await readFile(join(home, 'watch-jobs.json'), 'utf8'));
    assert.equal(watches.watches.length, 1);
    assert.equal(watches.watches[0].description, 'landing file');
  });

  it('a malformed watch_job check comes back as a rejection, never a silent drop', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const output = 'Done.\n\n[PA_META]: {"actions":[{"type":"watch_job","description":"w","check":{"type":"bogus"}}]}';
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(output, 'sess-3') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    const done = fyi.calls.find((c) => c.kind === 'thread-done');
    assert.ok(done, 'done FYI posted');
    assert.ok(done.text.includes('_(watch_job rejected:'), 'malformed check produces the rejection notice');
    assert.ok(done.text.includes('unknown check type'), 'the validation reason is surfaced');
  });
});

// Ask mirroring (button parity, 2026-09-11): question/confirm_required on a
// voice-stamped record mirror a widget into the voice-inbox app via the
// injected mirrorAsk seam; the mirror is awaited BEFORE the done FYI so the
// footer rides the same text.
describe('voice-inbox ask mirroring (button parity)', () => {
  const VOICE_TASK = 'vi-1234567890ab'; // synthetic fixture id family, never a real task

  async function makeVoiceThread(): Promise<ThreadRecord> {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { voiceTaskIds: [VOICE_TASK] });
    return (await getThread(KEY, thread.id))!;
  }

  function makeMirrorRecorder(impl: AskMirrorFn) {
    const calls: AskMirrorInput[] = [];
    const mirrorAsk: AskMirrorFn = async (input) => {
      calls.push(input);
      return impl(input);
    };
    return { calls, mirrorAsk };
  }

  const okMirror: AskMirrorFn = async (input) => ({
    ok: true,
    taskId: input.taskIds[0],
    requestId: 'ir-abc123def456',
  });

  it('question on a voice-stamped record mirrors a choice widget and appends the footer, with no unavailable notice', async () => {
    const thread = await makeVoiceThread();
    const fyi = makeFyiRecorder();
    const mirror = makeMirrorRecorder(okMirror);
    const output = 'Done.\n\n[PA_META]: {"actions":[{"type":"question","text":"Which window?","options":["Morning","Evening"]}]}';
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(output, 'sess-m1') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch, { mirrorAsk: mirror.mirrorAsk }));

    assert.deepEqual(mirror.calls, [
      { taskIds: [VOICE_TASK], kind: 'choice', prompt: 'Which window?', options: ['Morning', 'Evening'] },
    ]);
    const done = fyi.calls.find((c) => c.kind === 'thread-done');
    assert.ok(done, 'done FYI posted');
    assert.ok(done.text.includes('\n\n_(Also asked in your Voice Inbox app.)_\n\n'));
    assert.ok(!done.text.includes("_(action 'question' is not available on the thread lane)_"));
    assert.ok(!done.text.includes('[PA_META]'));
    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.status, 'done');
  });

  it('confirm_required mirrors a confirm widget over the sentence-stripped, capped response', async () => {
    const thread = await makeVoiceThread();
    const fyi = makeFyiRecorder();
    const mirror = makeMirrorRecorder(okMirror);
    const body = `Plan armed: delete the stray branch. ${'y'.repeat(600)} Reply *yes* to confirm or *no* to cancel.`;
    const output = `${body}\n\n[PA_META]: {"actions":[{"type":"confirm_required"}]}`;
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(output, 'sess-m2') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch, { mirrorAsk: mirror.mirrorAsk }));

    assert.equal(mirror.calls.length, 1);
    assert.deepEqual(mirror.calls[0].taskIds, [VOICE_TASK]);
    assert.equal(mirror.calls[0].kind, 'confirm');
    assert.equal(mirror.calls[0].options, undefined);
    // `response` is the redacted `cleaned` text with the Telegram-side confirm
    // sentence stripped and the widget 500-char clamp applied.
    assert.equal(mirror.calls[0].prompt, capPromptForWidget(`Plan armed: delete the stray branch. ${'y'.repeat(600)}`));
    assert.ok(mirror.calls[0].prompt.length <= 500);
    const done = fyi.calls.find((c) => c.kind === 'thread-done');
    assert.ok(done);
    assert.ok(done.text.includes('_(Also asked in your Voice Inbox app.)_'));
    assert.ok(!done.text.includes("_(action 'confirm_required' is not available on the thread lane)_"));
  });

  it('a NON-voice record sets a pendingQuestion and sends a question FYI (WP-2 parity), never calls the mirror', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const mirror = makeMirrorRecorder(okMirror);
    const output = 'Done.\n\n[PA_META]: {"actions":[{"type":"question","text":"Which window?","options":["Morning","Evening"]}]}';
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(output, 'sess-m3') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch, { mirrorAsk: mirror.mirrorAsk }));

    // No voice stamp ⇒ the mirror is never called (unchanged).
    assert.equal(mirror.calls.length, 0, 'no voice stamp, no mirror');
    // AI-203 WP-2: a non-voice question now sets pendingQuestion and sends a
    // question FYI with rq: option buttons (previously the unavailable notice).
    const stored = await getThread(KEY, thread.id);
    assert.deepEqual(stored?.pendingQuestion, { text: 'Which window?', options: ['Morning', 'Evening'] });
    const qFyi = fyi.calls.find((c) => c.kind === 'thread-question');
    assert.ok(qFyi, 'a thread-question FYI is sent for non-voice questions');
    assert.ok(qFyi!.text.startsWith(`❓ Thread ${thread.id} asks: Which window?`));
    // The done FYI carries the result and NO unavailable notice for question.
    const done = fyi.calls.find((c) => c.kind === 'thread-done');
    assert.ok(done);
    assert.ok(!done.text.includes("_(action 'question' is not available on the thread lane)_"));
    assert.ok(!done.text.includes('Voice Inbox'));
  });

  it('an awaiting_input mirror error logs info and suppresses BOTH the notice and the footer', async () => {
    const thread = await makeVoiceThread();
    const fyi = makeFyiRecorder();
    const mirror = makeMirrorRecorder(async (input) => ({
      ok: false,
      taskId: input.taskIds[0],
      error: `task ${VOICE_TASK} is awaiting_input; input requests are created from running`,
    }));
    const output = 'Done.\n\n[PA_META]: {"actions":[{"type":"question","text":"Which window?","options":["Morning","Evening"]}]}';
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(output, 'sess-m4') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch, { mirrorAsk: mirror.mirrorAsk }));

    const done = fyi.calls.find((c) => c.kind === 'thread-done');
    assert.ok(done);
    assert.ok(!done.text.includes("_(action 'question' is not available"), 'the worker already asked in the app — no stale notice');
    assert.ok(!done.text.includes('Voice Inbox app.'), 'no footer either: the widget came from the worker, not the mirror');
    assert.ok(!done.text.includes('could not reach the Voice Inbox app'));
    const log = await waitForLog('task already awaiting_input');
    assert.ok(log.includes('mirror skipped'));
  });

  it('any other mirror error becomes a reach-failure notice', async () => {
    const thread = await makeVoiceThread();
    const fyi = makeFyiRecorder();
    const mirror = makeMirrorRecorder(async (input) => ({ ok: false, taskId: input.taskIds[0], error: 'spawn blew up' }));
    const output = 'Done.\n\n[PA_META]: {"actions":[{"type":"question","text":"Which window?","options":["Morning","Evening"]}]}';
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(output, 'sess-m5') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch, { mirrorAsk: mirror.mirrorAsk }));

    const done = fyi.calls.find((c) => c.kind === 'thread-done');
    assert.ok(done);
    assert.ok(done.text.includes('_(could not reach the Voice Inbox app: spawn blew up)_'));
    assert.ok(!done.text.includes('_(Also asked in your Voice Inbox app.)_'));
  });

  it('a `task …` mirror error is a ledger rejection: declined notice, not a reach failure', async () => {
    const thread = await makeVoiceThread();
    const fyi = makeFyiRecorder();
    const mirror = makeMirrorRecorder(async (input) => ({
      ok: false,
      taskId: input.taskIds[0],
      error: 'task vi-t3 is done; a progress event is valid from routed or running',
    }));
    const output = 'Done.\n\n[PA_META]: {"actions":[{"type":"question","text":"Which window?","options":["Morning","Evening"]}]}';
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(output, 'sess-m7') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch, { mirrorAsk: mirror.mirrorAsk }));

    const done = fyi.calls.find((c) => c.kind === 'thread-done');
    assert.ok(done);
    assert.ok(done.text.includes('_(the Voice Inbox app declined the ask: task vi-t3 is done'));
    assert.ok(!done.text.includes('could not reach'));
  });

  it('an invalid question shape rejects with a notice and no mirror call', async () => {
    const thread = await makeVoiceThread();
    const fyi = makeFyiRecorder();
    const mirror = makeMirrorRecorder(okMirror);
    const output = 'Done.\n\n[PA_META]: {"actions":['
      + '{"type":"question","text":"Too many options?","options":["a","b","c","d","e"]},'
      + '{"type":"question","text":"","options":["ok"]}'
      + ']}';
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(output, 'sess-m6') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch, { mirrorAsk: mirror.mirrorAsk }));

    assert.equal(mirror.calls.length, 0, 'invalid shapes never reach the mirror');
    const done = fyi.calls.find((c) => c.kind === 'thread-done');
    assert.ok(done);
    assert.ok(done.text.includes("_(question rejected: options must be 1..4 strings of 1..40 chars)_"));
    assert.ok(done.text.includes("_(question rejected: text must be 1..500 chars)_"));
    assert.ok(!done.text.includes('Voice Inbox app.'));
  });
});

describe('AI-255 B4: taskId reservation lifecycle', () => {
  it('dispatch env carries PA_TASK_ID=<thread id>; the terminal settle releases taskId-tagged claims', async () => {
    const { claim, readActive } = await import('../../../../pa/dist/src/lib/reservations.js');
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('done.') }));
    await claim({ paths: ['pa/src/thread-scope.ts'], session: 'w', note: 'x', taskId: thread.id });

    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    // PA_TASK_ID rides getEnv, not opts.env — runWithFailover's per-hop
    // secret_allowlist filter drops every non-allowlisted static-env key.
    assert.equal(rec.calls[0].opts.getEnv?.({ name: 'claude' } as WorkerConfig)?.PA_TASK_ID, thread.id,
      'the thread id must ride the per-hop dispatch env');
    // The release is fire-and-forget off the settle finally — poll the store.
    const deadline = Date.now() + 3000;
    let gone = false;
    while (Date.now() < deadline) {
      if (!(await readActive()).some((r) => r.taskId === thread.id)) { gone = true; break; }
      await sleep(40);
    }
    assert.ok(gone, 'a terminal settle must release taskId-tagged reservations');
  });

  it('a record cancelled mid-flight is terminal — its taskId claims release', async () => {
    const { claim, readActive } = await import('../../../../pa/dist/src/lib/reservations.js');
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => {
      await cancelRunningThreads(KEY);
      return { worker: 'claude', result: okResult('late result') };
    });
    await claim({ paths: ['pa/src/thread-cancel.ts'], session: 'w', note: 'x', taskId: thread.id });

    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    const deadline = Date.now() + 3000;
    let gone = false;
    while (Date.now() < deadline) {
      if (!(await readActive()).some((r) => r.taskId === thread.id)) { gone = true; break; }
      await sleep(40);
    }
    assert.ok(gone, 'cancelled is terminal — its claims must release');
  });

  it('a superseded executor whose record is still RUNNING keeps the claims — the replacement owns them', async () => {
    const { claim, readActive } = await import('../../../../pa/dist/src/lib/reservations.js');
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => {
      // A newer runSeq takes over mid-flight; the record stays running.
      await updateThread(KEY, 't-1', { runSeq: 99 });
      return { worker: 'claude', result: okResult('stale result') };
    });
    await claim({ paths: ['pa/src/thread-supersede.ts'], session: 'w', note: 'x', taskId: thread.id });

    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    await sleep(150);
    const still = await readActive();
    assert.ok(
      still.some((r) => r.taskId === thread.id),
      'a discarded stale executor must NOT release claims the still-running replacement relies on'
    );
  });
});

describe('runSeq ownership gate', () => {
  it('a record cancelled mid-flight discards the result: no FYI, no store write', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => {
      // /stop's cancellation lands while the run is in flight.
      await cancelRunningThreads(KEY);
      return { worker: 'claude', result: okResult('late result the operator will never see', 'sess-9') };
    });
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    assert.deepEqual(fyi.calls.map((c) => c.kind), ['thread-spawned']);
    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.status, 'cancelled');
    assert.equal(stored?.lastResult, undefined);
    assert.equal(stored?.session, undefined);
  });
});

describe('resume vs fresh on a resumed turn', () => {
  it('valid session: dispatch receives the resume args and the resumed prompt', async () => {
    const priorHome = process.env.HOME;
    const priorProfile = process.env.USERPROFILE;
    const fakeHome = mkdtempSync(join(tmpdir(), 'pa-thread-home-'));
    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      const projDir = join(fakeHome, '.claude', 'projects', cwdToClaudeProjectDir(workdir));
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, 'sess-ok.jsonl'), '{}\n', 'utf8');

      const thread = await makeThread();
      // Seed the record with a VALID session: fresh start_at, transcript file
      // present at <fakeHome>/.claude/projects/<proj-dir>/sess-ok.jsonl.
      await updateThread(KEY, 't-1', {
        session: { session_id: 'sess-ok', worker: 'claude', started_at: new Date().toISOString() },
      });
      await queueThreadInput(KEY, 't-1', 'continue please');
      const fyi = makeFyiRecorder();
      const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('resumed ok', 'sess-2') }));
      await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

      assert.equal(rec.calls.length, 1);
      // vi-2638f25056ba (2026-09-11): resume args ride getExtraArgs so ONLY the
      // session's own worker receives them — a static extraArgs would be applied
      // to EVERY failover hop by runWithFailover and spawn-fail foreign CLIs.
      assert.equal(rec.calls[0].opts.extraArgs, undefined, 'static extraArgs must stay empty; resume args ride getExtraArgs');
      assert.deepEqual(rec.calls[0].opts.getExtraArgs?.({ name: 'claude' } as WorkerConfig), ['--resume', 'sess-ok']);
      assert.equal(rec.calls[0].opts.getExtraArgs?.({ name: 'agy' } as WorkerConfig), undefined);
      assert.equal(rec.calls[0].opts.agentName, 'claude');
      assert.ok(rec.calls[0].prompt.includes('## Thread t-1 — Sweep logs'));
      assert.ok(rec.calls[0].prompt.includes('## Current Message\ncontinue please'));
      assert.ok(!rec.calls[0].prompt.includes('## Your task'));
      const stored = await getThread(KEY, 't-1');
      assert.equal(stored?.status, 'done');
      assert.equal(stored?.session?.session_id, 'sess-2');
    } finally {
      if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
      if (priorProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorProfile;
      try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    }
  });

  it('known-bad case (vi-2638f25056ba): an agy session hands --conversation to agy only, never the fallback workers', async () => {
    // The 2026-09-11 incident: a thread resumed from an agy-captured session
    // passed static extraArgs ['--conversation', <id>] into runWithFailover,
    // which applies them to EVERY hop — when agy failed, zclaude and claude
    // both spawn-failed on the unknown option and the whole chain exhausted.
    const priorHome = process.env.HOME;
    const priorProfile = process.env.USERPROFILE;
    const fakeHome = mkdtempSync(join(tmpdir(), 'pa-thread-home-'));
    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      // agy session validity = a .pb (or .db) conversation file under
      // <home>/.gemini/antigravity-cli/conversations (session.ts sessionFileExists).
      const agyDir = join(fakeHome, '.gemini', 'antigravity-cli', 'conversations');
      mkdirSync(agyDir, { recursive: true });
      writeFileSync(join(agyDir, 'agy-sess-1.pb'), '{}\n', 'utf8');

      const thread = await makeThread();
      await updateThread(KEY, 't-1', {
        session: { session_id: 'agy-sess-1', worker: 'agy', started_at: new Date().toISOString() },
      });
      await queueThreadInput(KEY, 't-1', 'continue please');
      const fyi = makeFyiRecorder();
      const rec = makeDispatchRecorder(async () => ({ worker: 'agy', result: okResult('resumed ok', 'agy-sess-2') }));
      await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

      assert.equal(rec.calls.length, 1);
      assert.deepEqual(rec.calls[0].opts.getExtraArgs?.({ name: 'agy' } as WorkerConfig), ['--conversation', 'agy-sess-1']);
      // The exact spawn-failures from the incident log: the fallback CLIs must
      // receive NO resume args at all (fresh dispatch), not a foreign flag.
      assert.equal(rec.calls[0].opts.getExtraArgs?.({ name: 'zclaude' } as WorkerConfig), undefined);
      assert.equal(rec.calls[0].opts.getExtraArgs?.({ name: 'claude' } as WorkerConfig), undefined);
      assert.equal(rec.calls[0].opts.getExtraArgs?.({ name: 'codex' } as WorkerConfig), undefined);
      assert.equal(rec.calls[0].opts.extraArgs, undefined);
    } finally {
      if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
      if (priorProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorProfile;
      try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    }
  });

  it('invalid session: fresh prompt on goal with the ## Prior result excerpt and no resume args', async () => {
    const thread = await makeThread();
    // Seed a done record with lastResult + an INVALID (missing-file) session:
    // 'sess-missing.jsonl' exists under no homedir.
    await updateThread(KEY, 't-1', {
      status: 'done',
      lastResult: 'All prior work summarized.',
      session: { session_id: 'sess-missing', worker: 'claude', started_at: new Date().toISOString() },
    });
    await queueThreadInput(KEY, 't-1', 'continue please');
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('fresh fallback ok', 'sess-3') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].opts.extraArgs, undefined);
    assert.ok(rec.calls[0].prompt.includes('## Your task\nRun the sweep script.'));
    assert.ok(rec.calls[0].prompt.includes('## Prior result\nAll prior work summarized.'));
    assert.ok(rec.calls[0].prompt.includes('## Current Message\ncontinue please'));
    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.status, 'done');
  });
});

describe('pending-input drain', () => {
  it('inputs queued during a run are joined into ONE auto-resume', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    let n = 0;
    const rec = makeDispatchRecorder(async () => {
      n++;
      if (n === 1) {
        // Both steers land while run 1 is in flight; they must drain as ONE
        // auto-resume with the inputs joined.
        await queueThreadInput(KEY, 't-1', 'first steer');
        await queueThreadInput(KEY, 't-1', 'second steer');
      }
      return { worker: 'claude', result: okResult('first run done', 'sess-4') };
    });
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    assert.equal(rec.calls.length, 2);
    assert.ok(rec.calls[0].prompt.includes('## Your task\nRun the sweep script.'));
    assert.ok(rec.calls[1].prompt.includes('## Current Message\nfirst steer\n\nsecond steer'));
    assert.deepEqual(fyi.calls.map((c) => c.kind), ['thread-spawned', 'thread-done', 'thread-done']);
    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.status, 'done');
    assert.deepEqual(stored?.pendingInput, []);
  });

  it('T-WAKE2: drain-cap parks the record as queued; the next wake restarts a fresh chain (chunk bound)', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    // Seed the pending queue to its cap (5); a 6th is rejected by the store.
    for (let i = 1; i <= 5; i++) {
      const queued = await queueThreadInput(KEY, 't-1', `seed ${i}`);
      assert.ok(queued.ok);
    }
    const sixth = await queueThreadInput(KEY, 't-1', 'seed 6');
    assert.ok(!sixth.ok, 'store caps pendingInput at 5');

    // Fill every running slot so the cap path's own wake CANNOT re-claim the
    // just-parked record — this is what lets the test observe it resting at
    // 'queued' (with a free slot the park is transient: the claim immediately
    // flips it back to running and fires a restart).
    for (let i = 2; i <= 10; i++) {
      const holder = await createThread(KEY, { title: `Holder ${i}`, goal: 'hold', workdir });
      assert.ok(holder.ok);
    }
    const parkedEleventh = await createThread(KEY, { title: 'Eleventh', goal: 'hold', workdir });
    assert.ok(parkedEleventh.ok);
    assert.equal(parkedEleventh.thread.status, 'queued', 'the 11th create parks (cap 10)');
    await updateThread(KEY, parkedEleventh.thread.id, { status: 'running' });

    let n = 0;
    const rec = makeDispatchRecorder(async () => {
      n++;
      await queueThreadInput(KEY, 't-1', `more ${n}`);
      return { worker: 'claude', result: okResult(`run ${n}`, `sess-n${n}`) };
    });
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    // 1 fresh dispatch + MAX_AUTO_RESUMES_PER_CHAIN (5) resumed turns, then the
    // chain STOPS with the input queued during the last run still pending —
    // and the record is PARKED as queued (not done), warn logged.
    assert.equal(n, 6);
    assert.equal(fyi.calls.filter((c) => c.kind === 'thread-done').length, 6);
    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.status, 'queued');
    assert.deepEqual(stored?.pendingInput, ['more 6']);
    const log = await waitForLog('record parked as queued for the next wake');
    assert.ok(log.includes('auto-resume cap reached'), 'the cap warn is logged');
    assert.ok(log.includes('record parked as queued for the next wake'));

    // Free a slot and wake: the FIFO claim restarts the record and the fresh
    // chain consumes the whole ≤5 backlog as ONE joined turn.
    await updateThread(KEY, 't-2', { status: 'done' });
    for (let i = 7; i <= 10; i++) {
      const queued = await queueThreadInput(KEY, 't-1', `more ${i}`);
      assert.ok(queued.ok, `backlog fill ${i} accepted`);
    }
    const claimed = await claimThreadStarts(KEY);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, 't-1');
    assert.equal(claimed[0].status, 'running');

    const fyi2 = makeFyiRecorder();
    const rec2 = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('restart done', 'sess-r1') }));
    await executeTopicThread(makeArgs(claimed[0], fyi2, rec2.dispatch));

    assert.equal(rec2.calls.length, 1, 'the restart is ONE fresh chain');
    assert.ok(rec2.calls[0].prompt.includes('## Current Message\nmore 6\n\nmore 7\n\nmore 8\n\nmore 9\n\nmore 10'));
    const final = await getThread(KEY, 't-1');
    assert.equal(final?.status, 'done');
    assert.deepEqual(final?.pendingInput, []);
  });
});

describe('activity pump', () => {
  it('touches updatedAt while the run is in flight (real store throttle observed)', { timeout: 60_000 }, async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    // The store's write throttle is a fixed 10s and bumpRunSeq re-stamps
    // updatedAt at dispatch start, so the pump's first EFFECTFUL heartbeat can
    // only land on a run longer than THREAD_ACTIVITY_THROTTLE_MS — this test
    // pays that cost in real time (a store-side throttle seam would shrink it).
    _setActivityPumpIntervalForTest(500);
    const preRun = (await getThread(KEY, 't-1'))?.updatedAt ?? '';
    const rec = makeDispatchRecorder(async () => {
      await new Promise((resolve) => setTimeout(resolve, 11_000));
      return { worker: 'claude', result: okResult('slow run done', 'sess-5') };
    });
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.status, 'done');
    assert.ok(stored?.updatedAt, 'record still present');
    assert.ok(Date.parse(stored!.updatedAt!) > Date.parse(preRun), 'pump heartbeat advanced updatedAt past the dispatch-start stamp');
    assert.ok(Date.now() - Date.parse(stored!.updatedAt!) < 10_000, 'heartbeat landed late in the run, not at its start');
  });
});

// WP-H heartbeat hardening (t-3 class, 2026-09-13): the pump must span the
// executor's whole settle (not just the dispatch await), fail LOUD after 5
// consecutive touch failures, and the reconcile drain must log starvation.
describe('WP-H heartbeat hardening (t-3 class)', () => {
  it('pump survives the post-dispatch phase: a heartbeat lands while the done FYI is still in flight', { timeout: 60_000 }, async () => {
    const thread = await makeThread();
    _setActivityPumpIntervalForTest(200);
    let releaseDoneFyi: () => void = () => {};
    const doneFyiGate = new Promise<void>((resolve) => { releaseDoneFyi = resolve; });
    let preFyiStamp = '';
    const fyi = makeFyiRecorder();
    const slowSendFyi: ThreadFyiSender = async (text, kind) => {
      const msgId = await fyi.sendFyi(text, kind);
      if (kind === 'thread-done') {
        // The done write stamped updatedAt just before this send: that stamp
        // is the pre-window baseline. Hold the send past the store's 10s
        // touch throttle, so only a pump tick (or a heartbeat bracket) can
        // advance it while the executor is still mid-settle.
        preFyiStamp = (await getThread(KEY, thread.id))?.updatedAt ?? '';
        await doneFyiGate;
      }
      return msgId;
    };
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('fast run', 'sess-h1') }));
    const exec = executeTopicThread(makeArgs(thread, { sendFyi: slowSendFyi }, rec.dispatch));

    // Poll DURING the gated FYI: updatedAt must advance past the pre-window
    // stamp while the executor has NOT settled (the pre-WP-H code cleared the
    // pump at dispatch settle, so nothing could advance it here).
    let advanced = false;
    for (let i = 0; i < 150 && !advanced; i++) {
      await sleep(100);
      const cur = (await getThread(KEY, thread.id))?.updatedAt ?? '';
      if (preFyiStamp && Date.parse(cur) > Date.parse(preFyiStamp)) advanced = true;
    }
    releaseDoneFyi();
    await exec;

    assert.ok(preFyiStamp, 'pre-window stamp captured at done-FYI entry');
    assert.ok(advanced, 'a heartbeat landed during the post-dispatch FYI window (executor-lifetime pump)');
    assert.equal((await getThread(KEY, thread.id))?.status, 'done');
  });

  it('fail-loud pump: 5 consecutive touch failures warn ONCE; a success resets the counter', { timeout: 30_000 }, async () => {
    const thread = await makeThread();
    _setActivityPumpIntervalForTest(40);
    let failing = true;
    _setPumpTouchFnForTest(async () => {
      if (failing) throw new Error('injected touch failure');
    });
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const rec = makeDispatchRecorder(async () => {
        await gate;
        return { worker: 'claude', result: okResult('gated', 'sess-h2') };
      });
      const exec = executeTopicThread(makeArgs(thread, makeFyiRecorder(), rec.dispatch));

      // Batch 1: the 5th consecutive failure trips EXACTLY ONE warn carrying
      // the failure count (a warn-every-tick implementation would exceed 1).
      const log1 = await waitForLog('activity pump failing');
      const warns1 = log1.trim().split('\n').filter((l) => l.includes('activity pump failing'));
      assert.equal(warns1.length, 1, `exactly one warn at the 5th consecutive failure; got ${warns1.length}`);
      assert.ok(warns1[0].includes('"failures":5'), `warn carries the failure count: ${warns1[0]}`);

      // Reset: a successful tick clears the counter — no new warns while green.
      const countWarns = async (): Promise<number> =>
        (await readAppLog()).split('\n').filter((l) => l.includes('activity pump failing')).length;
      failing = false;
      await sleep(200);
      assert.equal(await countWarns(), 1, 'a successful tick warns nothing');

      // Batch 2: 5 MORE failures after the reset re-arm the threshold — a
      // never-reset counter would stay silent forever.
      failing = true;
      let warns = await countWarns();
      for (let i = 0; i < 50 && warns < 2; i++) {
        await sleep(100);
        warns = await countWarns();
      }
      assert.equal(warns, 2, 'the reset re-arms the threshold: exactly one more warn after 5 more failures');

      release();
      await exec;
    } finally {
      _setPumpTouchFnForTest(touchThread);
    }
  });

  it('reconcile starvation: a pass >5 min late warns once; an on-time pass stays silent', async () => {
    _setLastReconcileAtForTest(Date.now() - 6 * 60_000);
    assert.equal(await reconcileThreadQueues({ secrets: {}, token: 'test-token', topicNameFromKey: () => 'Test Topic' }), 0);
    const log = await waitForLog('reconcile pass starved');
    const warns = log.trim().split('\n').filter((l) => l.includes('reconcile pass starved'));
    assert.equal(warns.length, 1, 'exactly one starvation warn for the late pass');

    // Control — the check must be able to fail: an on-time pass adds nothing.
    _setLastReconcileAtForTest(Date.now() - 20_000);
    await reconcileThreadQueues({ secrets: {}, token: 'test-token', topicNameFromKey: () => 'Test Topic' });
    const logAfter = await readAppLog();
    assert.equal(
      logAfter.split('\n').filter((l) => l.includes('reconcile pass starved')).length,
      1,
      'an on-time pass logs no starvation warn',
    );
  });
});

describe('interrupt signal (increment 4)', () => {
  it('T-SIG1: isCancelled is true ONLY for a signal naming the captured runSeq', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const resource = `topic-${KEY}-th${thread.n}`;
    const rec = makeDispatchRecorder(async (prompt, opts) => {
      const cur = await getThread(KEY, 't-1');
      const capturedSeq = cur!.runSeq;
      assert.equal(opts.isCancelled?.(), false, 'no signal ⇒ false');
      signalThreadInterrupt(resource, capturedSeq + 100);
      assert.equal(opts.isCancelled?.(), false, 'a different runSeq ⇒ false (later runs are immune)');
      signalThreadInterrupt(resource, capturedSeq);
      assert.equal(opts.isCancelled?.(), true, 'the captured runSeq ⇒ the dying cascade aborts');
      return { worker: 'claude', result: okResult('settled') };
    });
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    assert.equal(rec.calls.length, 1);
    assert.equal((await getThread(KEY, 't-1'))?.status, 'done');
  });

  it('T-SIG2: a newer run’s capture deletes the stale signal entry (lazy cleanup)', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const resource = `topic-${KEY}-th${thread.n}`;
    let seenCancelled: boolean | undefined;
    let n = 0;
    const rec = makeDispatchRecorder(async (prompt, opts) => {
      n++;
      if (n === 1) {
        const cur = await getThread(KEY, 't-1');
        signalThreadInterrupt(resource, cur!.runSeq); // signal for the CURRENT run
        return { worker: 'claude', result: okResult('run one') };
      }
      seenCancelled = opts.isCancelled?.();
      return { worker: 'claude', result: okResult('run two') };
    });
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    // A second execution on the SAME resource: its capture must find the stale
    // entry (run 1's seq) and delete it — the new run is never cancelled.
    await queueThreadInput(KEY, 't-1', 'second turn');
    const fresh = await getThread(KEY, 't-1');
    await executeTopicThread(makeArgs(fresh!, fyi, rec.dispatch));

    assert.equal(seenCancelled, false, 'the new run superseded (and deleted) the stale entry');
    assert.equal((await getThread(KEY, 't-1'))?.status, 'done');
  });
});

describe('terminal queue wake (increment 4)', () => {
  it('T-WAKE1: A settles done → B claimed from the queue, fired on the REAL cascade, settles done', { timeout: 120_000 }, async () => {
    const capturePath = writeFakeWorker('B output');
    const threadA = await makeThread('A', 'Goal A text.');
    const createdB = await createThread(KEY, { title: 'B', goal: 'Goal B text.', workdir });
    assert.ok(createdB.ok);
    await updateThread(KEY, createdB.thread.id, { status: 'queued' });

    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseA = resolve; });
    const fyi = makeFyiRecorder();
    const recA = makeDispatchRecorder(async () => {
      await gate; // A's run hangs until the test releases it
      return { worker: 'claude', result: okResult('A done', 'sess-a1') };
    });
    const execA = executeTopicThread(makeArgs(threadA, fyi, recA.dispatch));
    for (let i = 0; i < 150 && recA.calls.length === 0; i++) await sleep(20);
    assert.equal(recA.calls.length, 1, 'A reached its dispatch seam');
    assert.equal((await getThread(KEY, createdB.thread.id))?.status, 'queued', 'no wake while A runs');

    releaseA();
    await execA; // A settles — its wakeQueue await included
    await _waitForThreadExecutionsForTest(); // B's FIRED executor settles

    const storedB = await getThread(KEY, createdB.thread.id);
    assert.equal(storedB?.status, 'done');
    assert.equal(storedB?.lastResult, 'B output');
    // B's dispatch was FIRED: its goal reached the REAL cascade's worker.
    const captured = await readFile(capturePath, 'utf8');
    assert.ok(captured.includes('Goal B text.'));
    assert.ok(!captured.includes('Goal A text.'), 'A rode the seam, never the fake worker');
    // B's pickup FYI went through the REAL sender path (ref-id log evidence).
    const log = await waitForLog(`Thread ${createdB.thread.id} started: B`);
    assert.ok(log.includes(`Thread ${createdB.thread.id} started: B`));
  });
});

describe('reconcile drain (increment 4)', () => {
  it('T-REC1: claims and fires queued records across ALL stores, throttled to one pass per interval', { timeout: 120_000 }, async () => {
    const capturePath = writeFakeWorker('reconciled output', { holdMs: 1500 });
    const first = await makeThread('Reconcile me', 'Backlog goal text.');
    await updateThread(KEY, first.id, { status: 'queued' });

    const fired1 = await reconcileThreadQueues({ secrets: {}, token: 'test-token', topicNameFromKey: () => 'Test Topic' });
    assert.equal(fired1, 1);
    assert.equal((await getThread(KEY, first.id))?.status, 'running');

    // A second queued record inside the throttle window is NOT served.
    const second = await makeThread('Second queued', 'Second goal.');
    await updateThread(KEY, second.id, { status: 'queued' });
    assert.equal(await reconcileThreadQueues({ secrets: {}, token: 'test-token', topicNameFromKey: () => 'Test Topic' }), 0);
    assert.equal((await getThread(KEY, second.id))?.status, 'queued');

    // After the throttle resets, the parked record is revived.
    _resetThreadQueueReconcileForTest();
    assert.equal(await reconcileThreadQueues({ secrets: {}, token: 'test-token', topicNameFromKey: () => 'Test Topic' }), 1);

    // Both fired dispatches reached the REAL cascade (worker prompt capture).
    await _waitForThreadExecutionsForTest();
    const captured = await readFile(capturePath, 'utf8');
    assert.ok(captured.includes('Backlog goal text.'));
    assert.ok(captured.includes('Second goal.'));
  });

  it('T-REC2: absent store dir ⇒ 0, no throw', async () => {
    _resetThreadQueueReconcileForTest();
    _setStoreDirForTest(join(home, 'no-such-store-dir'));
    try {
      assert.equal(await reconcileThreadQueues({ secrets: {}, token: 'test-token', topicNameFromKey: () => '' }), 0);
    } finally {
      _setStoreDirForTest(storeDir);
    }
  });
});

// Dynamic-slots wave (2026-09-11): voice-routed threads dispatch at the fast
// (250ms) worker-slot polling cadence via RunOptions.slotPriority, read from
// the freshly-fetched store record (rec.voiceTaskIds), not the args-captured
// thread. Non-voice spawned threads stay unset (normal cadence).
describe('dynamic-slots wave: bot routing mark (2026-09-11)', () => {
  it('voice-routed threads dispatch with slotPriority routing', async () => {
    const created = await makeThread();
    await updateThread(KEY, created.id, { voiceTaskIds: ['vi-test'] });
    const voiceThread = (await getThread(KEY, created.id))!;
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('Done.', 'sess-slot1') }));
    await executeTopicThread(makeArgs(voiceThread, fyi, rec.dispatch));

    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].opts.slotPriority, 'routing');
  });

  it('non-voice threads dispatch without a slotPriority', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('Done.', 'sess-slot2') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].opts.slotPriority, undefined);
  });
});

// ---------------------------------------------------------------------------

/** Wall dispatch seam (SPEC §6.2): the zero-attempt exhaustion result exactly as
 *  pa's runWithFailover cascade produces it (NO_WORKERS_AVAILABLE_ERROR by
 *  exact equality — a re-typed literal here would silently decouple from WP-A). */
function wallResult(): CommandResult {
  return { success: false, output: '', error: NO_WORKERS_AVAILABLE_ERROR, exitCode: -1 };
}

describe('wall-park (2026-09-12)', () => {
  /** Captured by T-PARK-C1 for T-PARK-C8's anchor non-match pin. */
  let parkFyiText: string | undefined;

  it('T-PARK-C1: a wall outcome parks — queued, attempts unchanged, one park FYI, no failed event', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'agy', result: wallResult() }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.status, 'queued');
    assert.equal(stored?.attempts, 0, 'a park is NOT an attempt');
    assert.equal(stored?.unavailableParks, 1);
    const delta = Date.parse(stored!.parkedUntil!) - Date.now();
    const expected = THREAD_PARK_LADDER_MINUTES[0] * 60_000;
    assert.ok(delta >= expected - 60_000 && delta <= expected + 60_000, `parkedUntil delta ${delta}ms not ~${expected}ms`);
    assert.equal(stored?.lastError, NO_WORKERS_AVAILABLE_ERROR);
    assert.deepEqual(fyi.calls.map((c) => c.kind), ['thread-spawned', 'thread-parked']);
    assert.equal(rec.calls.length, 1, 'the park path returns — no ladder dispatch');
    let events: { kind: string }[] = [];
    try { events = await readTopicEventsJsonl(); } catch { /* no events written — trivially none failed */ }
    assert.equal(events.filter((e) => e.kind === 'thread_failed').length, 0);
    parkFyiText = fyi.calls[1].text;
  });

  it('T-PARK-C2: exactly one park FYI per episode; ladder delays climb 5→15→30', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'agy', result: wallResult() }));
    let cur = thread;

    await executeTopicThread(makeArgs(cur, fyi, rec.dispatch));
    const after1 = await getThread(KEY, cur.id);
    assert.equal(after1?.unavailableParks, 1);
    const d1 = Date.parse(after1!.parkedUntil!) - Date.now();
    assert.ok(d1 >= 4 * 60_000 && d1 <= 6 * 60_000);

    cur = (await getThread(KEY, cur.id))!;
    await updateThread(KEY, cur.id, { parkedUntil: new Date(Date.now() - 1000).toISOString() });
    await executeTopicThread(makeArgs(cur, fyi, rec.dispatch));
    const after2 = await getThread(KEY, cur.id);
    assert.equal(after2?.unavailableParks, 2);
    const d2 = Date.parse(after2!.parkedUntil!) - Date.now();
    assert.ok(d2 >= 14 * 60_000 && d2 <= 16 * 60_000);

    cur = (await getThread(KEY, cur.id))!;
    await updateThread(KEY, cur.id, { parkedUntil: new Date(Date.now() - 1000).toISOString() });
    await executeTopicThread(makeArgs(cur, fyi, rec.dispatch));
    const after3 = await getThread(KEY, cur.id);
    assert.equal(after3?.unavailableParks, 3);
    const d3 = Date.parse(after3!.parkedUntil!) - Date.now();
    assert.ok(d3 >= 29 * 60_000 && d3 <= 31 * 60_000);

    assert.equal(fyi.calls.filter((c) => c.kind === 'thread-parked').length, 1, 'one park FYI per EPISODE, not per park');
  });

  it('T-PARK-C3: the valve — after THREAD_PARK_VALVE parks the next wall outcome fails directly (ruling A)', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'agy', result: wallResult() }));
    let cur = thread;
    for (let i = 1; i <= THREAD_PARK_VALVE; i++) {
      if (i >= 2) await updateThread(KEY, cur.id, { parkedUntil: new Date(Date.now() - 1000).toISOString() });
      await executeTopicThread(makeArgs(cur, fyi, rec.dispatch));
      cur = (await getThread(KEY, cur.id))!;
    }
    assert.equal(cur.unavailableParks, THREAD_PARK_VALVE);
    assert.equal(cur.status, 'queued');

    await executeTopicThread(makeArgs(cur, fyi, rec.dispatch));
    const final = await getThread(KEY, cur.id);
    assert.equal(final?.status, 'failed');
    assert.equal(final?.attempts, 1);
    // Ruling A (2026-09-13): the valve terminal fails DIRECTLY and preserves the
    // episode's park count — only a real attempt resets unavailableParks.
    assert.equal(final?.unavailableParks, THREAD_PARK_VALVE, 'the valve terminal preserves the park count');
    assert.ok((final?.lastError ?? '').includes(String(THREAD_PARK_VALVE)), `lastError should name the park count: ${final?.lastError}`);
    assert.ok((final?.lastError ?? '').includes('parked'));
    assert.equal(fyi.calls.filter((c) => c.kind === 'thread-parked').length, 1);
    assert.equal(fyi.calls[fyi.calls.length - 1].kind, 'thread-failed');
    const events = await readTopicEventsJsonl();
    assert.equal(events.filter((e) => e.kind === 'thread_failed').length, 1);
  });

  it('T-PARK-C4: a NEAR-miss error string is not a wall — the normal 2-attempt ladder runs', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'agy', result: { success: false, output: '', error: 'No workers available suddenly', exitCode: 1 } }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    assert.equal(rec.calls.length, 2, 'the ladder dispatched a second attempt');
    assert.deepEqual(fyi.calls.map((c) => c.kind), ['thread-spawned', 'thread-retry', 'thread-failed']);
    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.status, 'failed');
    assert.equal(stored?.attempts, 2);
    assert.equal(fyi.calls.filter((c) => c.kind === 'thread-parked').length, 0);
  });

  it('T-PARK-C5: a wall outcome at max attempts still parks (availability is not a goal failure)', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { attempts: TOPIC_THREAD_MAX_ATTEMPTS });
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'agy', result: wallResult() }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.status, 'queued');
    assert.equal(stored?.attempts, TOPIC_THREAD_MAX_ATTEMPTS, 'attempts untouched by a park');
    assert.ok(fyi.calls.some((c) => c.kind === 'thread-parked'));
  });

  it('T-PARK-C6: a non-wall failure after parks runs the normal ladder and resets the counter', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    let n = 0;
    const rec = makeDispatchRecorder(async () => {
      n++;
      if (n === 1) return { worker: 'agy', result: wallResult() }; // invocation 1 parks
      if (n === 2) return { worker: 'agy', result: { success: false, output: '', error: 'boom', exitCode: 1 } }; // non-wall retry
      return { worker: 'claude', result: okResult('recovered', 'sess-p6') }; // attempt 2 succeeds
    });
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));
    assert.equal((await getThread(KEY, 't-1'))?.unavailableParks, 1, 'wall invocation parked once');

    await updateThread(KEY, 't-1', { parkedUntil: new Date(Date.now() - 1000).toISOString() });
    await executeTopicThread(makeArgs((await getThread(KEY, 't-1'))!, fyi, rec.dispatch));

    assert.ok(fyi.calls.some((c) => c.kind === 'thread-retry'), 'the non-wall failure rode the normal retry FYI');
    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.attempts, 1);
    assert.equal(stored?.unavailableParks, 0, 'the retry patch reset the park counter');
  });

  it('T-PARK-C7: the done patch resets the park counter', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const wall = makeDispatchRecorder(async () => ({ worker: 'agy', result: wallResult() }));
    await executeTopicThread(makeArgs(thread, fyi, wall.dispatch));
    await updateThread(KEY, 't-1', { parkedUntil: new Date(Date.now() - 1000).toISOString() });

    const ok = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('done now', 'sess-p7') }));
    await executeTopicThread(makeArgs((await getThread(KEY, 't-1'))!, fyi, ok.dispatch));

    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.status, 'done');
    assert.equal(stored?.unavailableParks, 0);
  });

  it('T-PARK-C8: the park FYI is deliberately not anchor-steerable (pattern NOT widened)', async () => {
    assert.ok(parkFyiText, 'T-PARK-C1 must have run and captured the park FYI');
    assert.equal(THREAD_FYI_ANCHOR_PATTERN.exec(parkFyiText!), null);
  });
});

// Cross-resume addendum (2026-09-12): claude and zclaude share one session store
// and one resume format — verified live by probe, 2026-09-12 — so a captured
// claude session hands its --resume args to its zclaude sibling (and vice versa);
// agy (--conversation) and codex stay strictly own-worker (the 2026-09-11
// static-extraArgs chain-exhaustion incident).
describe('claude↔zclaude cross-resume (2026-09-12)', () => {
  it('a claude-captured session hands resume args to zclaude but never to agy/codex', async () => {
    const priorHome = process.env.HOME;
    const priorProfile = process.env.USERPROFILE;
    const fakeHome = mkdtempSync(join(tmpdir(), 'pa-thread-home-'));
    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      const projDir = join(fakeHome, '.claude', 'projects', cwdToClaudeProjectDir(workdir));
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, 'sess-xr.jsonl'), '{}\n', 'utf8');

      const thread = await makeThread();
      await updateThread(KEY, 't-1', {
        session: { session_id: 'sess-xr', worker: 'claude', started_at: new Date().toISOString() },
      });
      await queueThreadInput(KEY, 't-1', 'continue please');
      const fyi = makeFyiRecorder();
      const rec = makeDispatchRecorder(async () => ({ worker: 'zclaude', result: okResult('resumed under the sibling', 'sess-xr2') }));
      await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

      assert.equal(rec.calls.length, 1);
      assert.equal(rec.calls[0].opts.extraArgs, undefined, 'resume args ride getExtraArgs, never static extraArgs');
      assert.deepEqual(rec.calls[0].opts.getExtraArgs?.({ name: 'claude' } as WorkerConfig), ['--resume', 'sess-xr']);
      assert.deepEqual(rec.calls[0].opts.getExtraArgs?.({ name: 'zclaude' } as WorkerConfig), ['--resume', 'sess-xr'], 'the resume-compatible sibling receives the args');
      assert.equal(rec.calls[0].opts.getExtraArgs?.({ name: 'agy' } as WorkerConfig), undefined);
      assert.equal(rec.calls[0].opts.getExtraArgs?.({ name: 'codex' } as WorkerConfig), undefined);
      assert.equal(rec.calls[0].opts.agentName, 'claude');
      const stored = await getThread(KEY, 't-1');
      assert.equal(stored?.status, 'done');
    } finally {
      if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
      if (priorProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorProfile;
      try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    }
  });
});

// Wall-park valve pin (operator directive 2026-09-13): the constant is the one
// number every consumer reads, and the constant-referencing tests above adapt
// free to ANY value — this pin is what makes "surface sooner" (6, not 24) a
// tested fact instead of an accident that survives a silent revert.
describe('wall-park valve 6 (operator directive 2026-09-13)', () => {
  it('the valve constant is pinned at 6 parks (was 24)', () => {
    assert.equal(THREAD_PARK_VALVE, 6);
  });
});

// Cooldown-expiry event (operator directive 2026-09-13): a pa ledger entry
// whose cooldown end has passed IS "model back" — the tick evicts it (once-only
// by construction: eviction is the fired marker) and rewinds every wall-parked
// parkedUntil to now, so the same tick's reconcile re-claims immediately. The
// cooldown read and eviction are injected seams; the wake is the REAL
// wakeWallParked store pass over the REAL temp-dir store.
describe('cooldown-expiry event wakes wall-parked threads (2026-09-13)', () => {
  /** Wall-park-shaped fixture: queued, park counter set, future stamp. */
  async function makeWallParked(): Promise<ThreadRecord> {
    const thread = await makeThread('Park me', 'Wait for a worker.');
    await updateThread(KEY, thread.id, {
      status: 'queued',
      unavailableParks: 2,
      parkedUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    return (await getThread(KEY, thread.id))!;
  }

  it('T-WAKE-1: a passed cooldown entry evicts and wakes the wall-parked record (parkedUntil → now)', async () => {
    const rec = await makeWallParked();
    const before = Date.parse(rec.parkedUntil!);
    const evicted: string[] = [];
    const woken = await wakeWallParkedOnCooldownExpiry({
      readCooldownStatus: async () => ({ agy: { cooldown_until: new Date(Date.now() - 1_000).toISOString() } }),
      evictCooldown: async (w) => { evicted.push(w); return true; },
    });

    assert.equal(woken, 1);
    assert.deepEqual(evicted, ['agy']);
    const after = (await getThread(KEY, rec.id))!;
    const rewound = Date.parse(after.parkedUntil!);
    assert.ok(rewound < before, 'the future stamp must be rewound');
    assert.ok(Math.abs(rewound - Date.now()) < 10_000, `parkedUntil ${after.parkedUntil} is not ~now`);
  });

  it('T-WAKE-2: nothing has passed — no eviction, no wake, stamp untouched', async () => {
    const rec = await makeWallParked();
    let evictCalls = 0;
    const woken = await wakeWallParkedOnCooldownExpiry({
      readCooldownStatus: async () => ({}),
      evictCooldown: async () => { evictCalls++; return true; },
    });

    assert.equal(woken, 0);
    assert.equal(evictCalls, 0);
    const after = (await getThread(KEY, rec.id))!;
    assert.equal(after.parkedUntil, rec.parkedUntil, 'the stamp must be untouched');
  });

  it('T-WAKE-3: a fresh (future) cooldown touches nothing', async () => {
    const rec = await makeWallParked();
    let evictCalls = 0;
    const woken = await wakeWallParkedOnCooldownExpiry({
      readCooldownStatus: async () => ({ agy: { cooldown_until: new Date(Date.now() + 30 * 60_000).toISOString() } }),
      evictCooldown: async () => { evictCalls++; return true; },
    });

    assert.equal(woken, 0);
    assert.equal(evictCalls, 0);
    const after = (await getThread(KEY, rec.id))!;
    assert.equal(after.parkedUntil, rec.parkedUntil);
  });

  it('T-WAKE-4: once-only — the second tick with no new expiry does nothing', async () => {
    await makeWallParked();
    // Mutable ledger mimicking the real one: eviction REMOVES the entry.
    const ledger: Record<string, { cooldown_until: string }> = {
      agy: { cooldown_until: new Date(Date.now() - 1_000).toISOString() },
    };
    const evicted: string[] = [];
    const evict = async (w: string) => { evicted.push(w); delete ledger[w]; return true; };

    const first = await wakeWallParkedOnCooldownExpiry({
      readCooldownStatus: async () => ({ ...ledger }),
      evictCooldown: evict,
    });
    const second = await wakeWallParkedOnCooldownExpiry({
      readCooldownStatus: async () => ({ ...ledger }),
      evictCooldown: evict,
    });

    assert.equal(first, 1);
    assert.equal(second, 0, 'an evicted entry cannot re-fire');
    assert.deepEqual(evicted, ['agy'], 'exactly one eviction across both ticks');
  });
});

// Terminal-failure surfacing (2026-09-13): a terminal `failed` write on a
// voice-stamped record also marks the carried voice tasks failed in the
// voice-inbox ledger via the injected failVoiceTask seam (the ask-mirror
// idiom); the footer/notice rides the failed FYI; retries and parks never
// surface; non-voice records never call the seam.
describe('terminal failure surfaced to the voice-inbox ledger (2026-09-13)', () => {
  const VOICE_TASK = 'vi-fail0000001'; // synthetic fixture id family, never a real task

  function makeFailRecorder(impl: VoiceFailFn) {
    const calls: { taskId: string; reason: string }[] = [];
    const failVoiceTask: VoiceFailFn = async (taskId, reason) => {
      calls.push({ taskId, reason });
      return impl(taskId, reason);
    };
    return { calls, failVoiceTask };
  }

  const okFail: VoiceFailFn = async (taskId) => ({ ok: true, taskId });

  it('T-SURF-1: the ladder-exhausted terminal marks the voice task failed; retries never surface', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { voiceTaskIds: [VOICE_TASK] });
    const fyi = makeFyiRecorder();
    const fail = makeFailRecorder(okFail);
    let n = 0;
    const rec = makeDispatchRecorder(async () => {
      n++;
      return { worker: 'agy', result: { success: false, output: '', error: `boom ${n}`, exitCode: 1 } };
    });
    await executeTopicThread(makeArgs((await getThread(KEY, thread.id))!, fyi, rec.dispatch, { failVoiceTask: fail.failVoiceTask }));

    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.status, 'failed');
    assert.equal(stored?.attempts, 2, 'the ladder exhausted first');
    assert.equal(fail.calls.length, 1, 'ONE ledger call at the terminal — the retry wrote none');
    assert.equal(fail.calls[0].taskId, VOICE_TASK);
    assert.equal(fail.calls[0].reason, stored?.lastError, 'the ledger reason is the same redacted reason the store got');
    const failed = fyi.calls.find((c) => c.kind === 'thread-failed');
    assert.ok(failed, 'failed FYI posted');
    assert.ok(failed.text.includes(`_(Marked failed in your Voice Inbox app: ${VOICE_TASK}.)_`));
  });

  it('T-SURF-2: the valve terminal on a voice-stamped record surfaces; parks never do', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { voiceTaskIds: [VOICE_TASK] });
    const fyi = makeFyiRecorder();
    const fail = makeFailRecorder(okFail);
    const rec = makeDispatchRecorder(async () => ({ worker: 'agy', result: wallResult() }));
    let cur = (await getThread(KEY, thread.id))!;
    for (let i = 1; i <= THREAD_PARK_VALVE; i++) {
      if (i >= 2) await updateThread(KEY, cur.id, { parkedUntil: new Date(Date.now() - 1000).toISOString() });
      await executeTopicThread(makeArgs(cur, fyi, rec.dispatch, { failVoiceTask: fail.failVoiceTask }));
      cur = (await getThread(KEY, cur.id))!;
    }
    assert.equal(cur.status, 'queued', 'the parks parked');
    assert.equal(fail.calls.length, 0, 'a park is NOT terminal — no ledger call');

    await executeTopicThread(makeArgs(cur, fyi, rec.dispatch, { failVoiceTask: fail.failVoiceTask }));
    const final = await getThread(KEY, cur.id);
    assert.equal(final?.status, 'failed');
    assert.equal(fail.calls.length, 1, 'the VALVE terminal surfaced exactly once');
    assert.ok(fail.calls[0].reason.includes('parked'), `the reason names the parks: ${fail.calls[0].reason}`);
    const failed = fyi.calls.find((c) => c.kind === 'thread-failed');
    assert.ok(failed?.text.includes(`_(Marked failed in your Voice Inbox app: ${VOICE_TASK}.)_`));
  });

  it('T-SURF-3: a non-voice record never calls the seam and the failed FYI stays unchanged', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { attempts: TOPIC_THREAD_MAX_ATTEMPTS });
    const fyi = makeFyiRecorder();
    const fail = makeFailRecorder(okFail);
    const rec = makeDispatchRecorder(async () => ({ worker: 'agy', result: { success: false, output: '', error: 'boom', exitCode: 1 } }));
    await executeTopicThread(makeArgs((await getThread(KEY, thread.id))!, fyi, rec.dispatch, { failVoiceTask: fail.failVoiceTask }));

    assert.equal((await getThread(KEY, 't-1'))?.status, 'failed');
    assert.equal(fail.calls.length, 0, 'no voice stamp, no ledger call');
    const failed = fyi.calls.find((c) => c.kind === 'thread-failed');
    assert.ok(failed);
    assert.ok(!failed.text.includes('Voice Inbox'), 'no footer, no notice');
  });

  it('T-SURF-4: every carried task id is marked; the footer names them all', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { voiceTaskIds: ['vi-a000000001', 'vi-b000000002'] });
    await updateThread(KEY, thread.id, { attempts: TOPIC_THREAD_MAX_ATTEMPTS });
    const fyi = makeFyiRecorder();
    const fail = makeFailRecorder(okFail);
    const rec = makeDispatchRecorder(async () => ({ worker: 'agy', result: { success: false, output: '', error: 'boom', exitCode: 1 } }));
    await executeTopicThread(makeArgs((await getThread(KEY, thread.id))!, fyi, rec.dispatch, { failVoiceTask: fail.failVoiceTask }));

    assert.deepEqual(fail.calls.map((c) => c.taskId), ['vi-a000000001', 'vi-b000000002']);
    const failed = fyi.calls.find((c) => c.kind === 'thread-failed');
    assert.ok(failed?.text.includes('_(Marked failed in your Voice Inbox app: vi-a000000001, vi-b000000002.)_'));
  });

  it('T-SURF-5: a `task …` rejection is a declined notice, not a reach failure', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { voiceTaskIds: [VOICE_TASK] });
    await updateThread(KEY, thread.id, { attempts: TOPIC_THREAD_MAX_ATTEMPTS });
    const fyi = makeFyiRecorder();
    const fail = makeFailRecorder(async (taskId) => ({
      ok: false,
      taskId,
      error: `task ${VOICE_TASK} is done; it cannot fail (terminal)`,
    }));
    const rec = makeDispatchRecorder(async () => ({ worker: 'agy', result: { success: false, output: '', error: 'boom', exitCode: 1 } }));
    await executeTopicThread(makeArgs((await getThread(KEY, thread.id))!, fyi, rec.dispatch, { failVoiceTask: fail.failVoiceTask }));

    const failed = fyi.calls.find((c) => c.kind === 'thread-failed');
    assert.ok(failed);
    assert.ok(failed.text.includes(`_(the Voice Inbox app declined the failure mark for ${VOICE_TASK}: task ${VOICE_TASK} is done`));
    assert.ok(!failed.text.includes('could not reach'));
    assert.ok(!failed.text.includes('Marked failed in your Voice Inbox'));
  });

  it('T-SURF-6: any other seam error is a reach-failure notice', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { voiceTaskIds: [VOICE_TASK] });
    await updateThread(KEY, thread.id, { attempts: TOPIC_THREAD_MAX_ATTEMPTS });
    const fyi = makeFyiRecorder();
    const fail = makeFailRecorder(async (taskId) => ({ ok: false, taskId, error: 'spawn blew up' }));
    const rec = makeDispatchRecorder(async () => ({ worker: 'agy', result: { success: false, output: '', error: 'boom', exitCode: 1 } }));
    await executeTopicThread(makeArgs((await getThread(KEY, thread.id))!, fyi, rec.dispatch, { failVoiceTask: fail.failVoiceTask }));

    const failed = fyi.calls.find((c) => c.kind === 'thread-failed');
    assert.ok(failed);
    assert.ok(failed.text.includes(`_(could not reach the Voice Inbox app to mark ${VOICE_TASK} failed: spawn blew up)_`));
    assert.ok(!failed.text.includes('Marked failed in your Voice Inbox'));
  });
});

// The REAL ledger spawn (failVoiceTaskInLedger) under a fake child — the same
// seam shape the mirror module's tests use, pinning the invocation contract
// (verb, flags) and the classification-reachable close-handler behavior.
describe('failVoiceTaskInLedger (spawn seam)', () => {
  type FakeBehavior = { closeCode?: number; stdout?: string; stderr?: string; error?: Error; hold?: boolean };

  function makeChild(behavior: FakeBehavior) {
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    const on = (ev: string, l: (...a: unknown[]) => void) => {
      const arr = listeners.get(ev) ?? [];
      arr.push(l);
      listeners.set(ev, arr);
    };
    const child = {
      stdout: { on: (ev: string, l: (...a: unknown[]) => void) => on(`stdout:${ev}`, l) },
      stderr: { on: (ev: string, l: (...a: unknown[]) => void) => on(`stderr:${ev}`, l) },
      on,
      kill: () => {},
    };
    // The impl attaches its listeners synchronously inside the promise
    // executor, so a microtask later every listener is present.
    queueMicrotask(() => {
      if (behavior.stdout) for (const l of listeners.get('stdout:data') ?? []) l(behavior.stdout);
      if (behavior.stderr) for (const l of listeners.get('stderr:data') ?? []) l(behavior.stderr);
      if (behavior.error) {
        for (const l of listeners.get('error') ?? []) l(behavior.error);
        return;
      }
      if (!behavior.hold) for (const l of listeners.get('close') ?? []) l(behavior.closeCode ?? 0);
    });
    // The generic (…args: unknown[]) listener shape is not structurally a
    // MirrorChild — the cast is the fixture boundary, the same way the mirror
    // module's own fake-spawn tests type their fixtures.
    return child as unknown as MirrorChild;
  }

  const baseDeps = (child: MirrorChild): MirrorDeps => ({
    pythonCmd: 'python3',
    scriptPath: 'C:/fake/task_telemetry.py',
    spawnFn: (() => child) as MirrorSpawnFn,
  });

  it('an ok emit resolves success', async () => {
    const child = makeChild({ closeCode: 0, stdout: '{"ok": true, "task_id": "vi-x", "task_state": "failed"}\n' });
    const r = await failVoiceTaskInLedger('vi-x', 'reason', baseDeps(child));
    assert.deepEqual(r, { ok: true, taskId: 'vi-x' });
  });

  it('the fail() JSON on a non-zero exit IS the error text — the `task …` rejection classification stays reachable', async () => {
    const child = makeChild({ closeCode: 1, stdout: '{"ok": false, "error": "task vi-x is done; it cannot fail (terminal)"}\n' });
    const r = await failVoiceTaskInLedger('vi-x', 'reason', baseDeps(child));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'task vi-x is done; it cannot fail (terminal)');
    assert.ok(r.error!.startsWith('task '), 'the executor classifies this as a declined notice, not a reach failure');
  });

  it('a spawn error and a bare non-zero exit are reach failures', async () => {
    const boom = makeChild({ error: new Error('spawn blew up') });
    const r1 = await failVoiceTaskInLedger('vi-x', 'reason', baseDeps(boom));
    assert.equal(r1.ok, false);
    assert.equal(r1.error, 'spawn blew up');

    const silent = makeChild({ closeCode: 1, stderr: 'traceback tail' });
    const r2 = await failVoiceTaskInLedger('vi-x', 'reason', baseDeps(silent));
    assert.equal(r2.ok, false);
    assert.ok(r2.error!.startsWith('task_telemetry.py exited 1'), `got: ${r2.error}`);
  });

  it('a hung child is killed at the timeout', async () => {
    const child = makeChild({ hold: true });
    const r = await failVoiceTaskInLedger('vi-x', 'reason', { ...baseDeps(child), timeoutMs: 30 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'timeout');
  });

  it('the spawn args carry the telemetry verb, task id and reason', async () => {
    const seen: { cmd: string; args: string[] }[] = [];
    const child = makeChild({ closeCode: 0, stdout: '{"ok": true}' });
    const spawnFn: MirrorSpawnFn = (cmd, args) => {
      seen.push({ cmd, args: [...args] });
      return child;
    };
    await failVoiceTaskInLedger('vi-x', 'some reason', { pythonCmd: 'py', scriptPath: 't.py', spawnFn });
    assert.deepEqual(seen, [{ cmd: 'py', args: ['t.py', '--event', 'task.failed', '--task', 'vi-x', '--reason', 'some reason'] }]);
  });

  it('the completion verb spawns task_complete.py with the task id and summary', async () => {
    const seen: { cmd: string; args: string[] }[] = [];
    const child = makeChild({ closeCode: 0, stdout: '{"ok": true, "state": "done"}' });
    const spawnFn: MirrorSpawnFn = (cmd, args) => {
      seen.push({ cmd, args: [...args] });
      return child;
    };
    await completeVoiceTaskInLedger('vi-x', 'plain-language result', { pythonCmd: 'py', scriptPath: 'c.py', spawnFn });
    assert.deepEqual(seen, [{ cmd: 'py', args: ['c.py', '--task', 'vi-x', '--summary', 'plain-language result'] }]);
  });
});

// Voice-task closure on thread success (2026-09-13 addendum): a completing
// thread closes its still-open voice tasks through the ledger's completion
// verb (worker-initiated closure is the norm but not guaranteed — two 33-hour
// casualties had to be dispositioned by hand). makeArgs already stubs the
// dominant path (worker closed it first → `illegal task state transition:`
// skip); these tests inject recorders to study the other outcomes.
describe('voice-task closure: late sweep after a 180s grace (2026-09-13 race fix)', () => {
  const VOICE_TASK = 'vi-close0000001'; // synthetic fixture id family, never a real task

  function makeCloseRecorder(impl: VoiceCompleteFn) {
    const calls: { taskId: string; summary: string }[] = [];
    const completeVoiceTask: VoiceCompleteFn = async (taskId, summary) => {
      calls.push({ taskId, summary });
      return impl(taskId, summary);
    };
    return { calls, completeVoiceTask };
  }

  function makeTerminalRecorder(terminal: string[] = []) {
    const reads: string[][] = [];
    const readTerminalVoiceTaskIds = (ids: readonly string[]) => {
      reads.push([...ids]);
      return new Set(terminal);
    };
    return { reads, readTerminalVoiceTaskIds };
  }

  function makeStateRecorder(states: Record<string, { state: string; routedTo: string | null }> = {}) {
    const reads: string[][] = [];
    const readVoiceTaskStates = (ids: readonly string[]) => {
      reads.push([...ids]);
      const map = new Map<string, { state: string; routedTo: string | null }>();
      for (const id of ids) { const st = states[id]; if (st) map.set(id, st); }
      return map;
    };
    return { reads, readVoiceTaskStates };
  }

  /** Direct store edit — updateThread re-stamps updatedAt on every write, so
   *  the settle time can only be backdated behind its back. */
  async function backdateSettle(threadId: string, ageMs: number): Promise<void> {
    const storeFile = join(storeDir, `${KEY}.json`);
    const raw = JSON.parse(await readFile(storeFile, 'utf8')) as Record<string, ThreadRecord>;
    raw[threadId].updatedAt = new Date(Date.now() - ageMs).toISOString();
    writeFileSync(storeFile, JSON.stringify(raw, null, 2), 'utf8');
  }

  /** Drain the executor's fire-and-forget withHeartbeat touches (thread-executor.ts's
   *  `touchThread` before/after brackets) before `backdateSettle` writes behind the
   *  store's back: each touch is a no-op while updatedAt is within the store's
   *  activity throttle, so once a few consecutive reads see the SAME updatedAt
   *  nothing is left in flight that could reload a stale (pre-backdate) copy and
   *  re-persist it as "now" after the raw write — which reopened the grace window
   *  the backdate exists to close and made T-RETRY-9 pass whether or not the sweep's
   *  in-flight guard itself was even reached (2026-09-16). */
  async function waitForNoPendingTouch(threadId: string): Promise<void> {
    let prev = '';
    let stableTicks = 0;
    while (stableTicks < 3) {
      const cur = (await getThread(KEY, threadId))?.updatedAt ?? '';
      if (cur !== '' && cur === prev) stableTicks++;
      else stableTicks = 0;
      prev = cur;
      await sleep(20);
    }
  }

  const RETRY_TASK = 'vi-d79c0000e001'; // synthetic fixture id family, never a real task
  const WAITING = "I've scheduled a fallback check and am now waiting for the background transcription task to finish.";
  const RETRY_MESSAGE = 'Routing retry for voice inbox task vi-d79c0000e001. Run route_task.py now.';

  /** Routing-retry seam recorder: the n-th call returns outcomes[n] (default
   *  `skipped`, the dominant production outcome). */
  function makeRetryRecorder(outcomes: Array<VoiceRouteRetryResult['outcome']> = []) {
    const calls: Array<[string, string]> = [];
    const retryVoiceRouting: VoiceRouteRetryFn = async (taskId, topicKey) => {
      calls.push([taskId, topicKey]);
      const outcome = outcomes[calls.length - 1] ?? 'skipped';
      if (outcome === 'returned') return { outcome, taskId, message: RETRY_MESSAGE };
      if (outcome === 'error') return { outcome, taskId, error: 'ledger read failed: SQLITE_BUSY' };
      return { outcome: 'skipped', taskId, reason: 'already routed' };
    };
    return { calls, retryVoiceRouting };
  }

  function sweepDeps(close: ReturnType<typeof makeCloseRecorder>, term: ReturnType<typeof makeTerminalRecorder>, state: ReturnType<typeof makeStateRecorder> = makeStateRecorder()) {
    return {
      secrets: {} as Record<string, string>,
      token: 'test-token',
      topicNameFromKey: () => 'Test Topic',
      completeVoiceTask: close.completeVoiceTask,
      readTerminalVoiceTaskIds: term.readTerminalVoiceTaskIds,
      readVoiceTaskStates: state.readVoiceTaskStates,
      retryVoiceRouting: makeRetryRecorder().retryVoiceRouting,
      readRouteRetryPending: () => new Set<string>(),
    };
  }

  // 2026-09-16 routing retry (vi-d79c09c5eb37): an inbox routing thread
  // settled done with its task never routed (running, worker identity
  // stamped, routed_to NULL). The task is sent back to the same thread once,
  // immediately; a retry that also ends unrouted is the pa fallback's to place.
  it('T-RETRY-1: a routing thread that settles with its task never routed is sent back once, and its next turn carries the retry message (vi-d79c09c5eb37 shape)', async () => {
    const thread = await makeThread('Transcribe+route vi-d79c0000e001', 'First transcribe it, then route it.');
    await updateThread(KEY, thread.id, { voiceTaskIds: [RETRY_TASK] });
    const fyi = makeFyiRecorder();
    let n = 0;
    const rec = makeDispatchRecorder(async () => {
      n++;
      return { worker: 'claude', result: okResult(n === 1 ? WAITING : 'Routed to the accounting topic.') };
    });
    const retry = makeRetryRecorder(['returned', 'skipped']);
    await executeTopicThread(makeArgs((await getThread(KEY, thread.id))!, fyi, rec.dispatch, { retryVoiceRouting: retry.retryVoiceRouting }));

    assert.equal(rec.calls.length, 2, 'exactly one retry turn');
    assert.ok(rec.calls[1].prompt.includes(`## Current Message\n${RETRY_MESSAGE}`), 'the retry turn delivers the retry message');
    assert.deepEqual(retry.calls, [[RETRY_TASK, KEY], [RETRY_TASK, KEY]], 'asked at both settles; the second finds the task routed');
    assert.deepEqual(fyi.calls.map((c) => c.kind), ['thread-spawned', 'thread-done', 'thread-done'], 'no new message kinds, only the existing thread notices');
    const stored = await getThread(KEY, thread.id);
    assert.equal(stored?.status, 'done');
    assert.deepEqual(stored?.pendingInput, []);
    const log = await waitForLog('sent back to its routing thread once');
    assert.ok(log.includes(RETRY_TASK));
  });

  it('T-RETRY-2: a settle whose task is already routed or terminal queues nothing — one dispatch only', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { voiceTaskIds: [RETRY_TASK] });
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('Routed to the accounting topic.') }));
    const retry = makeRetryRecorder(['skipped']);
    await executeTopicThread(makeArgs((await getThread(KEY, thread.id))!, makeFyiRecorder(), rec.dispatch, { retryVoiceRouting: retry.retryVoiceRouting }));

    assert.equal(rec.calls.length, 1);
    assert.deepEqual(retry.calls, [[RETRY_TASK, KEY]]);
    assert.deepEqual((await getThread(KEY, thread.id))?.pendingInput, []);
  });

  it('T-RETRY-3: a repair error is logged and queues nothing', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { voiceTaskIds: [RETRY_TASK] });
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(WAITING) }));
    const retry = makeRetryRecorder(['error']);
    await executeTopicThread(makeArgs((await getThread(KEY, thread.id))!, makeFyiRecorder(), rec.dispatch, { retryVoiceRouting: retry.retryVoiceRouting }));

    assert.equal(rec.calls.length, 1);
    const log = await waitForLog(`routing retry could not return ${RETRY_TASK}`);
    assert.ok(log.includes('SQLITE_BUSY'));
  });

  it('T-RETRY-4: a task another live thread of this topic carries is never sent back by this record', async () => {
    const other = await makeThread('Other router', 'Other goal.');
    await updateThread(KEY, other.id, { status: 'running', voiceTaskIds: [RETRY_TASK] });
    const thread = await makeThread('This router', 'This goal.');
    await updateThread(KEY, thread.id, { voiceTaskIds: [RETRY_TASK] });
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(WAITING) }));
    const retry = makeRetryRecorder(['returned']);
    await executeTopicThread(makeArgs((await getThread(KEY, thread.id))!, makeFyiRecorder(), rec.dispatch, { retryVoiceRouting: retry.retryVoiceRouting }));

    assert.deepEqual(retry.calls, [], 'the live carrier owns the routing');
    assert.equal(rec.calls.length, 1);
  });

  it('T-RETRY-5: a record with no voice tasks never asks for a routing retry', async () => {
    const thread = await makeThread();
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('All sweeps complete.') }));
    const retry = makeRetryRecorder(['returned']);
    await executeTopicThread(makeArgs(thread, makeFyiRecorder(), rec.dispatch, { retryVoiceRouting: retry.retryVoiceRouting }));

    assert.deepEqual(retry.calls, []);
    assert.equal(rec.calls.length, 1);
  });

  it('T-RETRY-6: a failed run never asks for a routing retry', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { voiceTaskIds: [RETRY_TASK] });
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: { success: false, output: '', error: 'boom', exitCode: 1 } }));
    const retry = makeRetryRecorder(['returned']);
    await executeTopicThread(makeArgs((await getThread(KEY, thread.id))!, makeFyiRecorder(), rec.dispatch, { retryVoiceRouting: retry.retryVoiceRouting }));

    assert.equal((await getThread(KEY, thread.id))?.status, 'failed');
    assert.deepEqual(retry.calls, []);
  });

  it('T-RETRY-7: after a restart the reconcile sweep sends a settled never-routed task back and wakes its thread', { timeout: 120_000 }, async () => {
    const capturePath = writeFakeWorker('Routed to the accounting topic.');
    const thread = await makeThread('Route vi-d79c0000e001', 'Route the voice task.');
    await updateThread(KEY, thread.id, { status: 'done', lastResult: WAITING, voiceTaskIds: [RETRY_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const retry = makeRetryRecorder(['returned']);
    await reconcileThreadQueues({
      ...sweepDeps(close, makeTerminalRecorder(), makeStateRecorder({ [RETRY_TASK]: { state: 'running', routedTo: null } })),
      retryVoiceRouting: retry.retryVoiceRouting,
    });

    assert.deepEqual(retry.calls, [[RETRY_TASK, KEY]]);
    assert.deepEqual(close.calls, [], 'the thread reply is never the answer');
    await _waitForThreadExecutionsForTest();
    const captured = await readFile(capturePath, 'utf8');
    assert.ok(captured.includes(RETRY_MESSAGE), 'the woken turn carries the retry message');
    const stored = await getThread(KEY, thread.id);
    assert.equal(stored?.status, 'done');
    assert.deepEqual(stored?.pendingInput, []);
  });

  it('T-RETRY-8: a task the retry returned to THIS topic that is still unrouted is never closed with the reply', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: WAITING, voiceTaskIds: [RETRY_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const retry = makeRetryRecorder();
    await reconcileThreadQueues({
      ...sweepDeps(close, makeTerminalRecorder(), makeStateRecorder({ [RETRY_TASK]: { state: 'routed', routedTo: KEY } })),
      retryVoiceRouting: retry.retryVoiceRouting,
      readRouteRetryPending: () => new Set([RETRY_TASK]),
    });

    assert.deepEqual(close.calls, []);
    assert.deepEqual(retry.calls, [], 'a routed task is never retried again');
    const log = await waitForLog('routing retry ended unrouted');
    assert.ok(log.includes('closure deferred'));
  });

  it('T-RETRY-9: the sweep never wakes a done record whose executor is still finishing its settle', async () => {
    writeFakeWorker('noop'); // a mutation that wakes the record must never reach a real worker
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { voiceTaskIds: [RETRY_TASK] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const atDone = new Promise<void>((resolve) => { reached = resolve; });
    const sendFyi: ThreadFyiSender = async (_text, kind) => {
      if (kind === 'thread-done') { reached(); await gate; }
      return 42;
    };
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(WAITING) }));
    const exec = executeTopicThread(makeArgs((await getThread(KEY, thread.id))!, { sendFyi }, rec.dispatch));
    await atDone;
    const sweepRetry = makeRetryRecorder(['returned']);
    try {
      // Drain the pending 'thread-done' before-touch (and any earlier
      // withHeartbeat touches from the settle-time retry / status write)
      // before backdating: a touch still in flight would reload the
      // pre-backdate stamp, see it as fresh, and no-op harmlessly — but one
      // that loads AFTER the raw backdateSettle write sees a >180s-stale
      // stamp and re-touches it to "now", undoing the backdate and skipping
      // the record on the sweep's EARLIER grace check, never reaching the
      // in-flight guard this test exists to prove.
      await waitForNoPendingTouch(thread.id);
      await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
      await reconcileThreadQueues({
        ...sweepDeps(makeCloseRecorder(async (taskId) => ({ ok: true, taskId })), makeTerminalRecorder(), makeStateRecorder({ [RETRY_TASK]: { state: 'running', routedTo: null } })),
        retryVoiceRouting: sweepRetry.retryVoiceRouting,
      });
      assert.deepEqual(sweepRetry.calls, [], 'an in-flight executor owns its own retry');
    } finally {
      release();
      await exec;
    }
    assert.equal(rec.calls.length, 1);
  });

  it('T-RETRY-10: the sweep never revives a record that settled more than an hour ago', async () => {
    writeFakeWorker('noop'); // a mutation that wakes the record must never reach a real worker
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: WAITING, voiceTaskIds: [RETRY_TASK] });
    await backdateSettle(thread.id, THREAD_ROUTE_RETRY_SWEEP_MAX_AGE_MS + 60_000);
    const retry = makeRetryRecorder(['returned']);
    await reconcileThreadQueues({
      ...sweepDeps(makeCloseRecorder(async (taskId) => ({ ok: true, taskId })), makeTerminalRecorder(), makeStateRecorder({ [RETRY_TASK]: { state: 'running', routedTo: null } })),
      retryVoiceRouting: retry.retryVoiceRouting,
    });

    assert.deepEqual(retry.calls, []);
  });

  it('T-RETRY-11: a settled task still transcribing is not retried yet, and is retried once it is transcribed', async () => {
    writeFakeWorker('noop'); // the second pass wakes the record; never reach a real worker
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: WAITING, voiceTaskIds: [RETRY_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const retry = makeRetryRecorder(['returned']);
    await reconcileThreadQueues({
      ...sweepDeps(close, makeTerminalRecorder(), makeStateRecorder({ [RETRY_TASK]: { state: 'transcribing', routedTo: null } })),
      retryVoiceRouting: retry.retryVoiceRouting,
    });
    assert.deepEqual(retry.calls, [], 'no retry is spent while the transcript does not exist');
    assert.deepEqual(close.calls, []);

    _resetThreadQueueReconcileForTest();
    await reconcileThreadQueues({
      ...sweepDeps(close, makeTerminalRecorder(), makeStateRecorder({ [RETRY_TASK]: { state: 'received', routedTo: null } })),
      retryVoiceRouting: retry.retryVoiceRouting,
    });
    assert.deepEqual(retry.calls, [[RETRY_TASK, KEY]], 'the one retry is still available after transcription');
    await _waitForThreadExecutionsForTest();
  });

  it('T-CLOSE-1: a completing voice-stamped thread closes NOTHING at settle — no footer, no closure seam at all', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { voiceTaskIds: [VOICE_TASK] });
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('All sweeps complete.', 'sess-cl1') }));
    await executeTopicThread(makeArgs((await getThread(KEY, thread.id))!, fyi, rec.dispatch));

    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.status, 'done');
    const done = fyi.calls.find((c) => c.kind === 'thread-done');
    assert.ok(done, 'done FYI posted');
    assert.ok(!done.text.includes('Marked done in your Voice Inbox'), 'the executor no longer closes at settle');
  });

  it('T-SWEEP-1: a fresh done record is left alone — the 180s grace has not passed', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: 'Final result text.', voiceTaskIds: [VOICE_TASK] });
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const term = makeTerminalRecorder();
    await reconcileThreadQueues(sweepDeps(close, term));
    assert.deepEqual(close.calls, [], 'closure does not run at settle — the worker owns the grace window');
    assert.deepEqual(term.reads, [], 'no ledger read inside the grace either');
  });

  it('T-SWEEP-2: past the grace, still-open tasks close with the FULL lastResult — never capped (vi-d935e5e13537)', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: 'R'.repeat(300), voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const term = makeTerminalRecorder();
    await reconcileThreadQueues(sweepDeps(close, term));
    assert.deepEqual(close.calls, [{ taskId: VOICE_TASK, summary: 'R'.repeat(300) }],
      'the sweep stores the thread reply verbatim — no slicing, no ellipsis');
  });

  it('T-SWEEP-2b: a >4000-char lastResult also closes verbatim — the old record-side cut is gone', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: 'L'.repeat(5000), voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const term = makeTerminalRecorder();
    await reconcileThreadQueues(sweepDeps(close, term));
    assert.equal(close.calls[0]?.summary?.length, 5000);
    assert.ok(!close.calls[0]?.summary?.includes('…'));
  });

  it('T-SWEEP-3: tasks the ledger already shows terminal are skipped — the sweep stands down', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: 'Final result text.', voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const term = makeTerminalRecorder([VOICE_TASK]);
    await reconcileThreadQueues(sweepDeps(close, term));
    assert.deepEqual(term.reads, [[VOICE_TASK]], 'the terminal read happened');
    assert.deepEqual(close.calls, [], 'the worker closed it first — nothing to do');
  });

  it('T-SWEEP-4: a done record without voiceTaskIds is untouched — not even a ledger read', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: 'Final result text.' });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const term = makeTerminalRecorder();
    await reconcileThreadQueues(sweepDeps(close, term));
    assert.deepEqual(term.reads, [], 'no carried tasks → no terminal read');
    assert.deepEqual(close.calls, []);
  });

  it('T-SWEEP-5: an already-closed refusal from the verb is a silent logged skip, never a throw', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: 'Final result text.', voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({
      ok: false,
      taskId,
      error: `illegal task state transition: done -> done (task ${taskId} is done)`,
    }));
    const term = makeTerminalRecorder();
    await reconcileThreadQueues(sweepDeps(close, term));
    assert.equal(close.calls.length, 1, 'the stale terminal read said open, so the close was attempted');
    const log = await waitForLog('late sweep skipped');
    assert.ok(log.includes('already closed'), 'the skip is logged, never silent-silent');
  });

  it('T-SWEEP-6: a reach failure is logged and never blocks the reconcile pass', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: 'Final result text.', voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: false, taskId, error: 'spawn blew up' }));
    const term = makeTerminalRecorder();
    const fired = await reconcileThreadQueues(sweepDeps(close, term));
    assert.equal(fired, 0, 'the pass resolves normally');
    assert.equal(close.calls.length, 1);
    const log = await waitForLog('late sweep');
    assert.ok(log.includes('could not reach the Voice Inbox app to close'), 'one notice attempt, logged');
  });

  it('T-SWEEP-7: an empty-result done thread closes its open carried tasks with the honest note — never hangs open forever', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: '   ', voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const term = makeTerminalRecorder();
    await reconcileThreadQueues(sweepDeps(close, term));
    assert.deepEqual(close.calls, [{ taskId: VOICE_TASK, summary: THREAD_VOICE_EMPTY_RESULT_NOTE }],
      'the asker\'s card ends truthfully, not with a hang or a receipt');
  });

  it('T-SWEEP-8: an empty-result done thread inside the grace is left alone like any other', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: '', voiceTaskIds: [VOICE_TASK] });
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const term = makeTerminalRecorder();
    await reconcileThreadQueues(sweepDeps(close, term));
    assert.deepEqual(close.calls, [], 'no closure inside the grace window');
    assert.deepEqual(term.reads, [], 'no ledger read inside the grace either');
  });

  // ai246 WP-E (2026-09-15): the production loop this pins — the sweep passed
  // a routing-receipt lastResult verbatim, task_complete.py's summary-shape
  // guard refused it (parser.error → exit 2, logged as 'exited 2: usage: …'),
  // and every reconcile re-sent the identical string without ever closing
  // vi-7cc698aca65a / vi-5255fad01127. The call site must retry once with the
  // guard-safe honest note so a refused summary can't wedge the task open.
  it('T-SWEEP-9: a summary-shape refusal (exited 2) retries once with the honest note — the task still closes', async () => {
    const thread = await makeThread();
    const receipt = 'Command output (exit 0):\n\n```json\n{"ok": true, "task_id": "vi-x"}\n```';
    await updateThread(KEY, thread.id, { status: 'done', lastResult: receipt, voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const refused = 'task_complete.py exited 2: usage: task_complete.py [-h] --task TASK --summary SUMMARY';
    const close = makeCloseRecorder(async (taskId, summary) =>
      summary === receipt
        ? { ok: false, taskId, error: refused }
        : { ok: true, taskId });
    const term = makeTerminalRecorder();
    // A running task routed to THIS key pins the refusal-retry path as the
    // destination's own close — a never-routed (routedTo null) fixture now
    // defers (T-SWEEP-19), and a routed-foreign fixture is T-SWEEP-12/14's job.
    const state = makeStateRecorder({ [VOICE_TASK]: { state: 'running', routedTo: KEY } });
    await reconcileThreadQueues(sweepDeps(close, term, state));
    assert.deepEqual(close.calls, [
      { taskId: VOICE_TASK, summary: receipt },
      { taskId: VOICE_TASK, summary: THREAD_VOICE_REFUSED_RESULT_NOTE },
    ], 'verbatim reply first, then exactly one guard-safe retry');
  });

  it('T-SWEEP-10: a non-refusal failure does NOT retry — reach failures keep their single warn', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: 'Final result text.', voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: false, taskId, error: 'timeout' }));
    const term = makeTerminalRecorder();
    const state = makeStateRecorder({ [VOICE_TASK]: { state: 'running', routedTo: KEY } });
    await reconcileThreadQueues(sweepDeps(close, term, state));
    assert.equal(close.calls.length, 1, 'a timeout is a reach failure — no second attempt with a different summary');
  });

  it('T-SWEEP-11: the refused-result note itself passes task_complete.py summary guards (shape pin)', async () => {
    // The note must never trip the same guards it falls back from: no receipt
    // verb prefix, no Command output / exit 0 / {"ok" markers, no literal NEXT
    // ACTIONS line, no duplicate-close phrasing. Pinned against the script's
    // own regexes so a wording edit can't silently reintroduce the loop.
    const note = THREAD_VOICE_REFUSED_RESULT_NOTE;
    assert.ok(!/^\s*(?:routed\b|done\.\s*task\b|transcribed\s+and\s+routed\b)/i.test(note), 'no receipt verb prefix');
    assert.ok(!/Command output|exit 0|\{"ok"/i.test(note), 'no command-output markers');
    assert.ok(!note.split(/\r?\n/).some((l) => l.trim() === 'NEXT ACTIONS'), 'no bare NEXT ACTIONS line');
    assert.ok(!/\bcloses?\s+out\s+(?:an?\s+|the\s+)?(?:duplicate|stale)\b|\bstale\s+duplicate\b|\bduplicate\s+(?:of|ledger|entry|dispatch|task|note|request|ask|route)\b|\balready\s+(?:been\s+)?(?:transcribed|routed|under\s?way)\b|\bstale\s+ledger\b/i.test(note),
      'no duplicate-close phrasing');
  });

  it('T-SWEEP-12: a task routed to another topic is left to the destination — no close attempted', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: 'Final result text.', voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const term = makeTerminalRecorder();
    const state = makeStateRecorder({ [VOICE_TASK]: { state: 'routed', routedTo: 'OTHER_CHAT_OTHER_THREAD' } });
    await reconcileThreadQueues(sweepDeps(close, term, state));
    assert.deepEqual(close.calls, [], 'the destination topic owns the closure — this sweep defers');
    const log = await waitForLog('routed to another topic');
    assert.ok(log.includes('closure deferred'), 'the deferral is logged, never silent');
  });

  it('T-SWEEP-13: a task routed to THIS topic still closes', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: 'Final result text.', voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const term = makeTerminalRecorder();
    const state = makeStateRecorder({ [VOICE_TASK]: { state: 'routed', routedTo: KEY } });
    await reconcileThreadQueues(sweepDeps(close, term, state));
    assert.deepEqual(close.calls, [{ taskId: VOICE_TASK, summary: 'Final result text.' }],
      'routed to this key = this record owns the closure');
  });

  it('T-SWEEP-14: a refused summary on a still-routed task skips the honest-note retry', async () => {
    const thread = await makeThread();
    const receipt = 'Command output (exit 0):\n\n```json\n{"ok": true, "task_id": "vi-x"}\n```';
    await updateThread(KEY, thread.id, { status: 'done', lastResult: receipt, voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const refused = 'task_complete.py exited 2: usage: task_complete.py [-h] --task TASK --summary SUMMARY';
    const close = makeCloseRecorder(async (taskId, summary) =>
      summary === receipt
        ? { ok: false, taskId, error: refused }
        : { ok: true, taskId });
    const term = makeTerminalRecorder();
    const state = makeStateRecorder({ [VOICE_TASK]: { state: 'routed', routedTo: KEY } });
    await reconcileThreadQueues(sweepDeps(close, term, state));
    await flushLog(); // deterministic — await pending log writes instead of a racy fixed sleep
    const log = await readAppLog();
    assert.equal(close.calls.length, 1, 'verbatim attempt only — a routed task has no answer yet, the note would lie');
    assert.ok(log.includes('refused summary on a routed task'), 'the deferral is logged, never silent');
    assert.ok(!log.includes('could not reach the Voice Inbox app to close'),
      'a deliberate defer must not be mislogged as a reach failure — the refusal text that rides back is a marker, not an error');
  });

  it('T-SWEEP-15: a live sibling carrier defers closure', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: 'Final result text.', voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    // Second record in the SAME store, still live. Status `running`, never
    // `queued` — a queued record would be claimed and fired by this same
    // reconcile pass before the sweep even walks.
    const live = await makeThread('Live carrier', 'Still-running sibling work.');
    await updateThread(KEY, live.id, { status: 'running', voiceTaskIds: [VOICE_TASK] });
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const term = makeTerminalRecorder();
    await reconcileThreadQueues(sweepDeps(close, term));
    assert.deepEqual(close.calls, [], 'a live record still carries the task — its own settle owns the closure');
    const log = await waitForLog('carried by a live thread');
    assert.ok(log.includes('closure deferred'), 'the deferral is logged, never silent');
  });

  // 2026-09-16 routed-ownership fix: the old `state === 'routed'` condition
  // stopped deferring the moment the destination worker started (state
  // flips to 'running'/'awaiting_input'), so the routing thread raced ahead
  // and closed the task with its own routing-receipt reply. Ownership is set
  // by `routedTo`, not by the task's transient state.
  it('T-SWEEP-16: a task routed elsewhere but now `running` is still deferred — not just `routed`', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: 'Final result text.', voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const term = makeTerminalRecorder();
    const state = makeStateRecorder({ [VOICE_TASK]: { state: 'running', routedTo: 'OTHER_CHAT_OTHER_THREAD' } });
    await reconcileThreadQueues(sweepDeps(close, term, state));
    assert.deepEqual(close.calls, [], 'the destination is already working — this record must not race ahead of it');
    const log = await waitForLog('routed to another topic');
    assert.ok(log.includes('closure deferred'), 'the deferral is logged, never silent');
  });

  it('T-SWEEP-17: a task routed elsewhere and now `awaiting_input` is still deferred', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: 'Final result text.', voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const term = makeTerminalRecorder();
    const state = makeStateRecorder({ [VOICE_TASK]: { state: 'awaiting_input', routedTo: 'OTHER_CHAT_OTHER_THREAD' } });
    await reconcileThreadQueues(sweepDeps(close, term, state));
    assert.deepEqual(close.calls, [], 'the destination is asking a question — this record must not close underneath it');
  });

  it('T-SWEEP-18: routed to THIS key, and a sibling task absent from the state map — both still close (regression)', async () => {
    const VOICE_TASK_ROUTED_HERE = 'vi-close0000002';
    const VOICE_TASK_UNKNOWN = 'vi-close0000003';
    const thread = await makeThread();
    await updateThread(KEY, thread.id, {
      status: 'done',
      lastResult: 'Final result text.',
      voiceTaskIds: [VOICE_TASK_ROUTED_HERE, VOICE_TASK_UNKNOWN],
    });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const term = makeTerminalRecorder();
    // No entry for VOICE_TASK_UNKNOWN — absent from the map = no routing
    // knowledge = close proceeds (fail-open), exactly as before this fix.
    const state = makeStateRecorder({ [VOICE_TASK_ROUTED_HERE]: { state: 'routed', routedTo: KEY } });
    await reconcileThreadQueues(sweepDeps(close, term, state));
    const closedIds = close.calls.map((c) => c.taskId).sort();
    assert.deepEqual(closedIds, [VOICE_TASK_ROUTED_HERE, VOICE_TASK_UNKNOWN].sort(),
      'routedTo === key and a row absent from the map both still close today');
  });

  // 2026-09-16 never-routed fix (vi-d79c09c5eb37): an inbox routing thread
  // progressed its task (running, worker identity stamped) and settled done
  // without ever calling route_task.py, so routed_to stayed NULL, and this
  // sweep closed the task with the thread's waiting sentence. The operator's
  // instruction was lost. A never-routed task is the pa fallback's to place.
  it('T-SWEEP-19: a never-routed running task is never closed with the routing thread reply, through placement to the destination close (vi-d79c09c5eb37 shape)', async () => {
    const waiting = "I've scheduled a fallback check and am now waiting for the background transcription task to finish.";
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: waiting, voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const neverRouted = makeStateRecorder({ [VOICE_TASK]: { state: 'running', routedTo: null } });
    await reconcileThreadQueues(sweepDeps(close, makeTerminalRecorder(), neverRouted));
    _resetThreadQueueReconcileForTest();
    await reconcileThreadQueues(sweepDeps(close, makeTerminalRecorder(), neverRouted));
    assert.deepEqual(close.calls, [], 'a never-routed task is never closed with the routing thread reply, on any pass');
    const log = await waitForLog('never routed');
    assert.ok(log.includes('closure deferred'), 'the deferral is logged, never silent');
    // The fallback placed it in another topic: the destination owns the close.
    _resetThreadQueueReconcileForTest();
    await reconcileThreadQueues(sweepDeps(close, makeTerminalRecorder(),
      makeStateRecorder({ [VOICE_TASK]: { state: 'routed', routedTo: 'OTHER_CHAT_OTHER_THREAD' } })));
    assert.deepEqual(close.calls, [], 'once placed elsewhere, this record still never closes it');
    // The destination closed it: terminal, nothing left to do.
    _resetThreadQueueReconcileForTest();
    const term = makeTerminalRecorder([VOICE_TASK]);
    await reconcileThreadQueues(sweepDeps(close, term, makeStateRecorder()));
    assert.deepEqual(term.reads, [[VOICE_TASK]], 'the terminal read happened');
    assert.deepEqual(close.calls, [], 'the destination answer stands');
  });

  it('T-SWEEP-20: a never-routed received task is deferred too, the fallback received arm owns it', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: 'Routing now.', voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const state = makeStateRecorder({ [VOICE_TASK]: { state: 'received', routedTo: null } });
    await reconcileThreadQueues(sweepDeps(close, makeTerminalRecorder(), state));
    assert.deepEqual(close.calls, [], 'no routing happened, so no reply can be the answer');
  });

  // 2026-09-16 awaiting-input guard: the executor writes done BEFORE it
  // mirrors a question/confirm ask, so a destination record settles while
  // its own task waits on the operator. task_complete.py cancels every
  // pending ask in the conversation, so a close here would erase the question.
  it('T-SWEEP-21: a task routed to THIS topic and awaiting the operator answer is deferred, never closed under its pending ask', async () => {
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { status: 'done', lastResult: 'Shall I book the 9am slot?', voiceTaskIds: [VOICE_TASK] });
    await backdateSettle(thread.id, THREAD_VOICE_CLOSE_GRACE_MS + 1000);
    const close = makeCloseRecorder(async (taskId) => ({ ok: true, taskId }));
    const state = makeStateRecorder({ [VOICE_TASK]: { state: 'awaiting_input', routedTo: KEY } });
    await reconcileThreadQueues(sweepDeps(close, makeTerminalRecorder(), state));
    assert.deepEqual(close.calls, [], 'the pending ask survives; the answer resumes the worker');
    const log = await waitForLog('awaiting the operator answer');
    assert.ok(log.includes('closure deferred'), 'the deferral is logged, never silent');
  });
});

describe('WP-7 topic-tier tunables on the thread lane (OD-4)', () => {
  // A worker stub must DECLARE the model spec — resolveTunables iterates
  // worker.tunables; a bare {name} has no spec to expand args through.
  const modelWorker = (name: string): WorkerConfig =>
    ({ name, tunables: { model: { args: ['--model', '{value}'] } } }) as unknown as WorkerConfig;

  function seedTunables(defaults: Record<string, Record<string, string>>) {
    writeFileSync(join(home, `telegram-bot-topic-${KEY}.json`), JSON.stringify({
      chat_id: CHAT_ID, thread_id: THREAD_ID, turns: [], tunable_defaults: defaults,
    }), 'utf8');
  }

  it('tunable_defaults reach the dispatch per-worker: claude gets --model, the codex hop does not', async () => {
    seedTunables({ claude: { model: 'sonnet-x' } });
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('done.') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    assert.equal(rec.calls.length, 1);
    assert.deepEqual(rec.calls[0].opts.getExtraArgs?.(modelWorker('claude')), ['--model', 'sonnet-x']);
    // Per-worker slice (the 2026-09-11 exhaustion class): a claude default must
    // never leak onto a foreign hop.
    assert.equal(rec.calls[0].opts.getExtraArgs?.(modelWorker('codex')), undefined);
    assert.equal(rec.calls[0].opts.getExtraArgs?.(modelWorker('agy')), undefined);
  });

  it('a record-level model pin beats the topic default (overrides slot, last-wins)', async () => {
    seedTunables({ claude: { model: 'sonnet-x' } });
    const thread = await makeThread();
    await updateThread(KEY, thread.id, { model: 'flash-y' });
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('done.') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    assert.equal(rec.calls.length, 1);
    assert.deepEqual(rec.calls[0].opts.getExtraArgs?.(modelWorker('claude')), ['--model', 'flash-y']);
  });

  it('neither set => the getExtraArgs key is absent (byte-identical RunOptions pin)', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('done.') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    assert.equal(rec.calls.length, 1);
    assert.ok(!('getExtraArgs' in rec.calls[0].opts), 'no tunables and no pin => the key must not exist at all');
  });

  it('resume args stay worker-gated while tunable slices apply per-hop (composition)', async () => {
    const priorHome = process.env.HOME;
    const priorProfile = process.env.USERPROFILE;
    const fakeHome = mkdtempSync(join(tmpdir(), 'pa-thread-home-'));
    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      const projDir = join(fakeHome, '.claude', 'projects', cwdToClaudeProjectDir(workdir));
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, 'sess-ok.jsonl'), '{}\n', 'utf8');

      // claude + zclaude each get their own model default; agy/codex get none.
      seedTunables({ claude: { model: 'sonnet-x' }, zclaude: { model: 'z-model' } });
      const thread = await makeThread();
      await updateThread(KEY, thread.id, {
        session: { session_id: 'sess-ok', worker: 'claude', started_at: new Date().toISOString() },
      });
      await queueThreadInput(KEY, thread.id, 'continue please');
      const fyi = makeFyiRecorder();
      const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('resumed', 'sess-2') }));
      await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

      assert.equal(rec.calls.length, 1);
      const opts = rec.calls[0].opts;
      // Resume args are baseArgs (first); the worker's own tunable slice appends.
      assert.deepEqual(opts.getExtraArgs?.(modelWorker('claude')),
        ['--resume', 'sess-ok', '--model', 'sonnet-x']);
      // The RESUME_COMPATIBLE sibling gets resume args + ITS OWN slice.
      assert.deepEqual(opts.getExtraArgs?.(modelWorker('zclaude')),
        ['--resume', 'sess-ok', '--model', 'z-model']);
      // Non-compatible workers get neither resume args nor a foreign slice.
      assert.equal(opts.getExtraArgs?.(modelWorker('agy')), undefined);
      assert.equal(opts.getExtraArgs?.(modelWorker('codex')), undefined);
    } finally {
      if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
      if (priorProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorProfile;
      try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// WS3 provenance env (2026-09-18, per-hop revision): the thread dispatch's
// getEnv hook stamps what task_telemetry.py records into the ledger's
// worker_cli/worker_model/worker_effort columns — evaluated per failover hop
// with that hop's WorkerConfig, so the recorded worker is the one that ran.
// ---------------------------------------------------------------------------

describe('WS3 provenance env on the thread lane', () => {
  const tuningWorker = (name: string): WorkerConfig =>
    ({
      name,
      tunables: {
        model: { args: ['--model', '{value}'] },
        effort: { args: ['--effort', '{value}'] },
      },
    }) as unknown as WorkerConfig;

  it('getEnv stamps PA_TASK_ID + per-hop identity; the record model pin wins; static env keeps only secrets', async () => {
    const thread = await makeThread('Provenance thread');
    // The lifecycle RE-READS the record from the store before building the
    // dispatch opts — the pins must live in the STORE, not only on the local
    // fixture object.
    await updateThread(KEY, thread.id, { worker: 'agy', model: 'pin-model' });
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'agy', result: okResult('done') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch, {
      secrets: { SECRET_ONE: 'value-one' },
    }));
    assert.equal(rec.calls.length, 1);
    // Static env carries ONLY secrets — every non-secret key (PA_TASK_ID, the
    // provenance stamp) rides the per-hop hook because runWithFailover's
    // secret_allowlist filter drops non-allowlisted static-env keys.
    assert.deepEqual(rec.calls[0].opts.env, { SECRET_ONE: 'value-one' },
      'only the secrets bag stays static; PA_TASK_ID + provenance moved to getEnv');
    const getEnv = rec.calls[0].opts.getEnv;
    assert.equal(typeof getEnv, 'function', 'the per-hop env hook must be set');
    const firstHop = getEnv!(tuningWorker('agy')) ?? {};
    const failoverHop = getEnv!(tuningWorker('claude')) ?? {};
    assert.equal(firstHop.PA_TASK_ID, thread.id, 'the AI-255 B4 tag rides getEnv — the allowlist filter drops it from static env');
    assert.equal(firstHop.PA_WORKER_CLI, 'agy');
    assert.equal(firstHop.PA_WORKER_MODEL, 'pin-model', 'the record model pin rides the overrides slot');
    assert.equal(failoverHop.PA_WORKER_CLI, 'claude', 'a failover hop stamps ITS OWN identity');
    assert.equal(failoverHop.PA_TASK_ID, thread.id);
    assert.notEqual(failoverHop.PA_WORKER_CLI, firstHop.PA_WORKER_CLI);
  });

  it('a topic tunable_default slice reaches the getEnv stamp for its own worker only', async () => {
    writeFileSync(join(home, `telegram-bot-topic-${KEY}.json`), JSON.stringify({
      chat_id: CHAT_ID, thread_id: THREAD_ID, turns: [],
      tunable_defaults: { agy: { model: 'topic-model', effort: 'high' } },
    }));
    const thread = await makeThread('Slice thread');
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'agy', result: okResult('done') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));
    const getEnv = rec.calls[0].opts.getEnv;
    assert.equal(typeof getEnv, 'function');
    const agyStamp = getEnv!(tuningWorker('agy')) ?? {};
    assert.equal(agyStamp.PA_WORKER_CLI, 'agy');
    assert.equal(agyStamp.PA_WORKER_MODEL, 'topic-model', 'the agy-scoped default stamps on the agy hop');
    assert.equal(agyStamp.PA_WORKER_EFFORT, 'high');
    const codexStamp = getEnv!(tuningWorker('codex')) ?? {};
    assert.equal(codexStamp.PA_WORKER_CLI, 'codex');
    assert.notEqual(codexStamp.PA_WORKER_MODEL, 'topic-model', 'a foreign slice never leaks onto another hop');
  });

  it('router-metadata: rec.routing reaches getEnv; an old record without it stamps NO PA_ROUTING_* key (fail-open)', async () => {
    // Persisted on the record at spawn time (never a closure): a queued/parked
    // thread may start minutes after the origin turn.
    const routed = await createThread(KEY, {
      title: 'Routing thread', goal: 'Run the sweep script.', workdir,
      routing: { decision: 'router', placement: 'diverted', target: 'vi-0123456789ab', steer: 'wait', steerBy: 'router', effortProj: 'applied' },
    });
    assert.ok(routed.ok);
    const rec1 = makeDispatchRecorder(async () => ({ worker: 'agy', result: okResult('done') }));
    await executeTopicThread(makeArgs(routed.thread, makeFyiRecorder(), rec1.dispatch));
    const routedEnv = rec1.calls[0].opts.getEnv?.(tuningWorker('agy')) ?? {};
    assert.equal(routedEnv.PA_ROUTING_DECISION, 'router');
    assert.equal(routedEnv.PA_ROUTING_PLACEMENT, 'diverted');
    assert.equal(routedEnv.PA_ROUTING_TARGET, 'vi-0123456789ab');
    assert.equal(routedEnv.PA_ROUTING_STEER, 'wait');
    assert.equal(routedEnv.PA_ROUTING_STEER_BY, 'router');
    assert.equal(routedEnv.PA_ROUTING_EFFORT_PROJ, 'applied');
    assert.ok(!('PA_ROUTING_FAILOVERS' in routedEnv), 'the count is cascade-owned; the thread builder never stamps it');

    const plain = await makeThread('Plain thread');
    const rec2 = makeDispatchRecorder(async () => ({ worker: 'agy', result: okResult('done') }));
    await executeTopicThread(makeArgs(plain, makeFyiRecorder(), rec2.dispatch));
    const plainEnv = rec2.calls[0].opts.getEnv?.(tuningWorker('agy')) ?? {};
    assert.equal(plainEnv.PA_WORKER_CLI, 'agy', 'the worker provenance still stamps');
    for (const key of Object.keys(plainEnv)) {
      assert.ok(!key.startsWith('PA_ROUTING_'), `old-record dispatch must stamp no routing key, got ${key}`);
    }
  });
});
