/**
 * Thread-executor lane tests (AI-203 WP-4).
 *
 * Every test drives the REAL executor over the REAL topic-threads store (temp
 * dir via _setStoreDirForTest); only the worker dispatch and the Telegram FYI
 * send ride test seams. PA_NOTIFY_DISABLED is set by the suite runner; no test
 * here touches the network.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CommandResult, RunOptions } from '../../../../pa/dist/src/types.js';
import {
  createThread,
  getThread,
  queueThreadInput,
  updateThread,
  cancelRunningThreads,
  THREAD_ACTIVITY_THROTTLE_MS,
  _clearThreadsForTest,
  _setStoreDirForTest,
  type ThreadRecord,
} from '../topic-threads.js';
import {
  executeTopicThread,
  buildThreadPrompt,
  buildThreadResumedTurnPrompt,
  _setActivityPumpIntervalForTest,
  type ExecuteTopicThreadArgs,
  type ThreadDispatchFn,
  type ThreadFyiSender,
  type ThreadTopicContext,
} from '../thread-executor.js';
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
    workdir: { dir: workdir },
    sendFyi: fyi.sendFyi,
    dispatch,
    ...overrides,
  };
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
  it('strips the envelope and appends one unavailable-action notice per action', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const output = 'Done.\n\n[PA_META]: {"actions":[{"type":"watch_job","description":"w"},{"type":"run_skill","skill":"commit"}]}';
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult(output, 'sess-2') }));
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    const done = fyi.calls.find((c) => c.kind === 'thread-done');
    assert.ok(done, 'done FYI posted');
    assert.ok(done.text.includes("_(action 'watch_job' is not available on the thread lane)_"));
    assert.ok(done.text.includes("_(action 'run_skill' is not available on the thread lane)_"));
    assert.ok(!done.text.includes('[PA_META]'));
    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.lastResult, 'Done.');
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
      assert.deepEqual(rec.calls[0].opts.extraArgs, ['--resume', 'sess-ok']);
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

  it('auto-resume cap stops the chain with inputs left queued', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    // Seed the pending queue to its cap (5); a 6th is rejected by the store.
    for (let i = 1; i <= 5; i++) {
      const queued = await queueThreadInput(KEY, 't-1', `seed ${i}`);
      assert.ok(queued.ok);
    }
    const sixth = await queueThreadInput(KEY, 't-1', 'seed 6');
    assert.ok(!sixth.ok, 'store caps pendingInput at 5');

    let n = 0;
    const rec = makeDispatchRecorder(async () => {
      n++;
      await queueThreadInput(KEY, 't-1', `more ${n}`);
      return { worker: 'claude', result: okResult(`run ${n}`, `sess-n${n}`) };
    });
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch));

    // 1 fresh dispatch + MAX_AUTO_RESUMES_PER_CHAIN (5) resumed turns, then the
    // chain STOPS with the input queued during the last run still pending.
    assert.equal(n, 6);
    assert.equal(fyi.calls.filter((c) => c.kind === 'thread-done').length, 6);
    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.status, 'done');
    assert.deepEqual(stored?.pendingInput, ['more 6']);
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
