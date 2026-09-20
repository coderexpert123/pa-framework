/**
 * AI-203 turns archiving — thread results merge into `state.turns`.
 *
 * Unit tests for `archiveThreadResult` (lock acquire, load→add→save cycle,
 * best-effort error swallowing, text cap, redaction) + integration tests that
 * drive the REAL executor lifecycle (`executeTopicThread`) with archive seams
 * injected via `ExecuteTopicThreadArgs.archiveSeams` + a race test proving no
 * lost update under a concurrent orchestrator turn.
 *
 * Every integration test drives the REAL executor over the REAL topic-threads
 * store (temp dir via _setStoreDirForTest); only the worker dispatch, the
 * Telegram FYI send, and the archive lock/state ride test seams.
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
  queueThreadInput,
  updateThread,
  cancelRunningThreads,
  _clearThreadsForTest,
  _setStoreDirForTest,
  type ThreadRecord,
} from '../topic-threads.js';
import {
  executeTopicThread,
  archiveThreadResult,
  THREAD_ARCHIVE_TEXT_CHARS,
  TOPIC_THREAD_MAX_ATTEMPTS,
  _resetThreadInterruptsForTest,
  _setActivityPumpIntervalForTest,
  _waitForThreadExecutionsForTest,
  type ArchiveThreadSeams,
  type ExecuteTopicThreadArgs,
  type ThreadDispatchFn,
  type ThreadFyiSender,
  type ThreadTopicContext,
} from '../thread-executor.js';
import type { ConversationState, ConversationTurn } from '../types.js';
import { THREAD_ACTIVITY_THROTTLE_MS } from '../topic-threads.js';
import { waitForDrain } from './test-teardown-guard.js';

const CHAT_ID = -1001234567890;
const THREAD_ID = 5001;
const CTX: ThreadTopicContext = { chatId: CHAT_ID, threadId: THREAD_ID, topicName: 'Test Topic' };
const KEY = `${CHAT_ID}_${THREAD_ID}`;

let home: string;
let storeDir: string;
let workdir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pa-archive-'));
  storeDir = mkdtempSync(join(tmpdir(), 'pa-archive-store-'));
  workdir = mkdtempSync(join(tmpdir(), 'pa-archive-wd-'));
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

// --- helpers ---------------------------------------------------------------

function okResult(output: string, sessionId?: string): CommandResult {
  return { success: true, output, exitCode: 0, ...(sessionId ? { sessionId } : {}) };
}

function failResult(error: string): CommandResult {
  return { success: false, output: '', error, exitCode: 1 };
}

function makeTurn(role: 'user' | 'assistant', text: string): ConversationTurn {
  return { role, text, timestamp: new Date().toISOString() };
}

function makeState(turns: ConversationTurn[] = []): ConversationState {
  return {
    chat_id: CHAT_ID,
    last_update_id: 0,
    thread_id: THREAD_ID,
    turns,
  };
}

function makeArchiveSeams(opts: {
  acquire?: boolean;
  loadStateImpl?: () => Promise<ConversationState>;
  saveStateImpl?: (state: ConversationState) => Promise<void>;
  releaseImpl?: () => Promise<void>;
  acquireDelay?: number;
} = {}): {
  seams: ArchiveThreadSeams;
  calls: {
    acquire: number;
    release: number;
    loadState: number;
    saveState: number;
    savedStates: ConversationState[];
  };
} {
  const calls = {
    acquire: 0,
    release: 0,
    loadState: 0,
    saveState: 0,
    savedStates: [] as ConversationState[],
  };
  const acquireVal = opts.acquire ?? true;
  const seams: ArchiveThreadSeams = {
    bbAcquire: async () => {
      calls.acquire++;
      if (opts.acquireDelay) await new Promise((r) => setTimeout(r, opts.acquireDelay));
      return acquireVal;
    },
    bbRelease: async () => {
      calls.release++;
      if (opts.releaseImpl) await opts.releaseImpl();
    },
    loadState: async () => {
      calls.loadState++;
      if (opts.loadStateImpl) return opts.loadStateImpl();
      return makeState([makeTurn('user', 'hello'), makeTurn('assistant', 'hi there')]);
    },
    saveState: async (state) => {
      calls.saveState++;
      calls.savedStates.push(state);
      if (opts.saveStateImpl) await opts.saveStateImpl(state);
    },
  };
  return { seams, calls };
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
    failVoiceTask: async (taskId) => ({ ok: true, taskId }),
    ...overrides,
  };
}

async function makeThread(title = 'Sweep logs', goal = 'Run the sweep script.'): Promise<ThreadRecord> {
  const created = await createThread(KEY, { title, goal, workdir });
  assert.ok(created.ok, `fixture createThread failed: ${!created.ok ? created.reason : ''}`);
  return created.thread;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// Unit tests — archiveThreadResult
// ===========================================================================

describe('archiveThreadResult (unit)', () => {
  it('U1: lock acquired → turn archived with correct shape', async () => {
    const { seams, calls } = makeArchiveSeams();
    const turn: ConversationTurn = {
      role: 'assistant',
      text: '✅ Thread t-3 done: Sweep logs\n\nAll sweeps complete.',
      timestamp: new Date().toISOString(),
      worker: 'claude',
      thread_id: THREAD_ID,
      thread_ref: 't-3',
    };
    await archiveThreadResult(CHAT_ID, THREAD_ID, turn, seams);

    assert.equal(calls.acquire, 1, 'bbAcquire called once');
    assert.equal(calls.loadState, 1, 'loadState called once');
    assert.equal(calls.saveState, 1, 'saveState called once');
    assert.equal(calls.release, 1, 'bbRelease called once');
    assert.equal(calls.savedStates.length, 1, 'one state saved');
    const saved = calls.savedStates[0];
    assert.equal(saved.turns.length, 3, '2 existing + 1 new turn');
    const newTurn = saved.turns[2];
    assert.equal(newTurn.role, 'assistant');
    assert.equal(newTurn.thread_ref, 't-3');
    assert.ok(newTurn.text.startsWith('✅ Thread t-3 done: Sweep logs\n\n'));
    assert.equal(newTurn.worker, 'claude');
    assert.equal(newTurn.thread_id, THREAD_ID);
  });

  it('U2: lock NOT acquired → skip, no load/save/release', async () => {
    const { seams, calls } = makeArchiveSeams({ acquire: false });
    const turn: ConversationTurn = {
      role: 'assistant',
      text: '✅ Thread t-3 done: Sweep logs\n\nresult',
      timestamp: new Date().toISOString(),
      thread_ref: 't-3',
    };
    await archiveThreadResult(CHAT_ID, THREAD_ID, turn, seams);

    assert.equal(calls.acquire, 1, 'bbAcquire called once');
    assert.equal(calls.loadState, 0, 'loadState NOT called');
    assert.equal(calls.saveState, 0, 'saveState NOT called');
    assert.equal(calls.release, 0, 'bbRelease NOT called');
  });

  it('U3: saveState throws → swallowed, bbRelease still called', async () => {
    const { seams, calls } = makeArchiveSeams({
      saveStateImpl: async () => { throw new Error('disk full'); },
    });
    const turn: ConversationTurn = {
      role: 'assistant',
      text: '✅ Thread t-3 done: Sweep logs\n\nresult',
      timestamp: new Date().toISOString(),
      thread_ref: 't-3',
    };
    await archiveThreadResult(CHAT_ID, THREAD_ID, turn, seams);

    assert.equal(calls.saveState, 1, 'saveState was attempted');
    assert.equal(calls.release, 1, 'bbRelease still called (finally block)');
  });

  it('U4: loadState throws → swallowed, bbRelease still called', async () => {
    const { seams, calls } = makeArchiveSeams({
      loadStateImpl: async () => { throw new Error('read error'); },
    });
    const turn: ConversationTurn = {
      role: 'assistant',
      text: '✅ Thread t-3 done: Sweep logs\n\nresult',
      timestamp: new Date().toISOString(),
      thread_ref: 't-3',
    };
    await archiveThreadResult(CHAT_ID, THREAD_ID, turn, seams);

    assert.equal(calls.loadState, 1, 'loadState was attempted');
    assert.equal(calls.saveState, 0, 'saveState NOT called (loadState threw first)');
    assert.equal(calls.release, 1, 'bbRelease still called (finally block)');
  });

  it('U5: bbRelease throws → swallowed, function returns without throwing', async () => {
    const { seams, calls } = makeArchiveSeams({
      releaseImpl: async () => { throw new Error('release error'); },
    });
    const turn: ConversationTurn = {
      role: 'assistant',
      text: '✅ Thread t-3 done: Sweep logs\n\nresult',
      timestamp: new Date().toISOString(),
      thread_ref: 't-3',
    };
    // Should NOT throw — the .catch(() => {}) on the release swallows it.
    await archiveThreadResult(CHAT_ID, THREAD_ID, turn, seams);

    assert.equal(calls.release, 1, 'bbRelease was called');
    assert.equal(calls.saveState, 1, 'saveState succeeded before release');
  });

  it('U6: failed-thread turn shape is archived verbatim', async () => {
    const { seams, calls } = makeArchiveSeams();
    const turn: ConversationTurn = {
      role: 'assistant',
      text: '❌ Thread t-3 failed: Sweep logs\n\nall workers unavailable',
      timestamp: new Date().toISOString(),
      worker: 'unknown',
      thread_id: THREAD_ID,
      thread_ref: 't-3',
    };
    await archiveThreadResult(CHAT_ID, THREAD_ID, turn, seams);

    assert.equal(calls.saveState, 1);
    const newTurn = calls.savedStates[0].turns[2];
    assert.equal(newTurn.text, '❌ Thread t-3 failed: Sweep logs\n\nall workers unavailable');
    assert.equal(newTurn.thread_ref, 't-3');
    assert.equal(newTurn.worker, 'unknown');
  });

  it('U7: text cap — result portion ≤ THREAD_ARCHIVE_TEXT_CHARS', async () => {
    const { seams, calls } = makeArchiveSeams();
    const longResult = 'x'.repeat(5000);
    const turn: ConversationTurn = {
      role: 'assistant',
      text: `✅ Thread t-3 done: Sweep logs\n\n${longResult.slice(0, THREAD_ARCHIVE_TEXT_CHARS)}`,
      timestamp: new Date().toISOString(),
      thread_ref: 't-3',
    };
    await archiveThreadResult(CHAT_ID, THREAD_ID, turn, seams);

    const newTurn = calls.savedStates[0].turns[2];
    // The result portion (after the header + blank line) must be ≤ cap.
    const header = '✅ Thread t-3 done: Sweep logs\n\n';
    const resultPortion = newTurn.text.slice(header.length);
    assert.ok(resultPortion.length <= THREAD_ARCHIVE_TEXT_CHARS,
      `result portion ${resultPortion.length} chars exceeds cap ${THREAD_ARCHIVE_TEXT_CHARS}`);
    assert.equal(resultPortion.length, THREAD_ARCHIVE_TEXT_CHARS, 'result portion is exactly at the cap');
  });

  it('U8: redaction — addTurn redacts assistant turns (real addTurn)', async () => {
    // The real addTurn is used internally (not injectable). It calls
    // redactSecrets on assistant turns. A Stripe-like token (sk- + 16+ chars)
    // is a generic pattern that redactSecrets always redacts.
    const { seams, calls } = makeArchiveSeams();
    const secretToken = 'sk-1234567890abcdefXYZ';
    const turn: ConversationTurn = {
      role: 'assistant',
      text: `✅ Thread t-3 done: Sweep logs\n\nResult: token=${secretToken}`,
      timestamp: new Date().toISOString(),
      thread_ref: 't-3',
    };
    await archiveThreadResult(CHAT_ID, THREAD_ID, turn, seams);

    const newTurn = calls.savedStates[0].turns[2];
    assert.ok(!newTurn.text.includes(secretToken),
      'secret token must be redacted from the stored turn text');
    assert.ok(newTurn.text.includes('<redacted:'),
      'redacted text must contain a <redacted:...> placeholder');
  });
});

// ===========================================================================
// Integration tests — executeTopicThread lifecycle + archive
// ===========================================================================

describe('archiveThreadResult in executor lifecycle (integration)', () => {
  it('I1: done path archives a turn with thread_ref and result text', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('All sweeps complete.', 'sess-1') }));
    const { seams, calls } = makeArchiveSeams();
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch, { archiveSeams: seams }));

    assert.equal(calls.saveState, 1, 'archive saved once on done path');
    assert.equal(calls.savedStates.length, 1);
    const newTurn = calls.savedStates[0].turns[calls.savedStates[0].turns.length - 1];
    assert.equal(newTurn.role, 'assistant');
    assert.equal(newTurn.thread_ref, 't-1');
    assert.ok(newTurn.text.startsWith('✅ Thread t-1 done: Sweep logs\n\n'));
    assert.ok(newTurn.text.includes('All sweeps complete.'));
    assert.equal(newTurn.worker, 'claude');
    assert.equal(newTurn.thread_id, THREAD_ID);
  });

  it('I2: failed path archives a turn with failed text', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    // Exhaust the 2-attempt ladder with failures.
    const rec = makeDispatchRecorder(async () => ({ worker: 'agy', result: failResult('worker crashed') }));
    const { seams, calls } = makeArchiveSeams();
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch, { archiveSeams: seams }));

    assert.equal(calls.saveState, 1, 'archive saved once on failed path');
    const newTurn = calls.savedStates[0].turns[calls.savedStates[0].turns.length - 1];
    assert.equal(newTurn.role, 'assistant');
    assert.equal(newTurn.thread_ref, 't-1');
    assert.ok(newTurn.text.startsWith('❌ Thread t-1 failed: Sweep logs\n\n'));
    assert.ok(newTurn.text.includes('worker crashed'));
  });

  it('I3: lock contention → skip archive, executor settles normally', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    const rec = makeDispatchRecorder(async () => ({ worker: 'claude', result: okResult('Done.', 'sess-2') }));
    const { seams, calls } = makeArchiveSeams({ acquire: false });
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch, { archiveSeams: seams }));

    // The executor settled (done FYI sent, store written).
    assert.deepEqual(fyi.calls.map((c) => c.kind), ['thread-spawned', 'thread-done']);
    const stored = await getThread(KEY, 't-1');
    assert.equal(stored?.status, 'done');
    // But NO turn was archived.
    assert.equal(calls.saveState, 0, 'saveState NOT called (lock not acquired)');
    assert.equal(calls.loadState, 0, 'loadState NOT called');
  });

  it('I4: archive does not block the pending-input drain', async () => {
    const thread = await makeThread();
    let dispatchCount = 0;
    const rec = makeDispatchRecorder(async () => {
      dispatchCount++;
      // Queue a steer input AFTER the first dispatch completes, so the done
      // path's pending-input drain finds it and auto-resumes (second dispatch).
      if (dispatchCount === 1) {
        await queueThreadInput(KEY, 't-1', 'steer after done');
      }
      return { worker: 'claude', result: okResult(`result ${dispatchCount}`, `sess-${dispatchCount}`) };
    });
    const fyi = makeFyiRecorder();
    const { seams, calls } = makeArchiveSeams({ acquireDelay: 200 });
    await executeTopicThread(makeArgs(thread, fyi, rec.dispatch, { archiveSeams: seams }));

    // The archive happened on each done path (2 dispatches → 2 archives).
    assert.equal(calls.saveState, 2, 'archive saved on each done path');
    // The pending input was drained — a second dispatch happened.
    assert.ok(dispatchCount >= 2, 'pending input drained (auto-resume happened)');
  });

  it('I5: cancelled thread does NOT archive', async () => {
    const thread = await makeThread();
    const fyi = makeFyiRecorder();
    // Cancel the thread before the dispatch completes: the dispatch holds,
    // and we cancel while it's in-flight.
    let resolveDispatch: (val: { worker: string; result: CommandResult }) => void;
    const dispatchPromise = new Promise<{ worker: string; result: CommandResult }>((r) => { resolveDispatch = r; });
    const rec = makeDispatchRecorder(async () => dispatchPromise);
    const { seams, calls } = makeArchiveSeams();
    const execPromise = executeTopicThread(makeArgs(thread, fyi, rec.dispatch, { archiveSeams: seams }));

    // Cancel the thread while the dispatch is in-flight.
    await sleep(50);
    await cancelRunningThreads(KEY);
    // Now let the dispatch complete.
    resolveDispatch!({ worker: 'claude', result: okResult('done', 'sess-1') });
    await execPromise;

    // The ownership gate discards the run — no archive.
    assert.equal(calls.saveState, 0, 'saveState NOT called (cancelled run discarded)');
  });
});

// ===========================================================================
// Race test — no lost update under concurrent orchestrator turn
// ===========================================================================

describe('archiveThreadResult race', () => {
  it('R1: no lost update — orchestrator turn + thread archive both survive', async () => {
    // Simulate: (a) an orchestrator turn adds a turn to state and saves;
    // (b) concurrently, a thread completes and archiveThreadResult acquires
    // the lock AFTER the orchestrator releases it. The final state has BOTH
    // turns — no clobber.
    //
    // The bbAcquire seam blocks (resolves only after the orchestrator's
    // bbRelease), proving the archive waited for the orchestrator to finish.

    let orchestratorReleased = false;
    let archiveAcquired = false;

    // Shared state file (the "disk").
    let diskState: ConversationState = makeState([makeTurn('user', 'original')]);

    // Orchestrator seam: acquires, adds a turn, saves, releases.
    const orchestratorSeams: ArchiveThreadSeams = {
      bbAcquire: async () => { return true; },
      bbRelease: async () => { orchestratorReleased = true; },
      loadState: async () => {
        // Return a copy so the orchestrator's addTurn doesn't mutate diskState yet.
        return { ...diskState, turns: [...diskState.turns] };
      },
      saveState: async (state) => {
        diskState = { ...state, turns: [...state.turns] };
      },
    };

    // Archive seam: blocks until the orchestrator releases, then acquires.
    const archiveSeams: ArchiveThreadSeams = {
      bbAcquire: async () => {
        // Wait for the orchestrator to release.
        for (let i = 0; i < 100; i++) {
          if (orchestratorReleased) { archiveAcquired = true; return true; }
          await sleep(10);
        }
        return false;
      },
      bbRelease: async () => {},
      loadState: async () => {
        // Must see the orchestrator's committed write (diskState has it).
        return { ...diskState, turns: [...diskState.turns] };
      },
      saveState: async (state) => {
        diskState = { ...state, turns: [...state.turns] };
      },
    };

    const threadTurn: ConversationTurn = {
      role: 'assistant',
      text: '✅ Thread t-3 done: Sweep logs\n\nresult text',
      timestamp: new Date().toISOString(),
      worker: 'claude',
      thread_id: THREAD_ID,
      thread_ref: 't-3',
    };

    // Run the orchestrator turn and the archive concurrently.
    const orchestratorTurn = archiveThreadResult(CHAT_ID, THREAD_ID, {
      role: 'assistant',
      text: 'Starting a separate thread to sweep the logs.',
      timestamp: new Date().toISOString(),
      worker: 'claude',
      thread_id: THREAD_ID,
    }, orchestratorSeams);

    const archiveTurn = archiveThreadResult(CHAT_ID, THREAD_ID, threadTurn, archiveSeams);

    await Promise.all([orchestratorTurn, archiveTurn]);

    assert.ok(archiveAcquired, 'archive acquired the lock (after orchestrator released)');
    // The disk state has both turns: the orchestrator's + the thread result.
    assert.ok(diskState.turns.length >= 3,
      `expected ≥3 turns (original + orchestrator + thread), got ${diskState.turns.length}`);
    const orchestratorTexts = diskState.turns.filter((t) => t.text.includes('Starting a separate thread'));
    const threadTexts = diskState.turns.filter((t) => t.thread_ref === 't-3');
    assert.equal(orchestratorTexts.length, 1, 'orchestrator turn survived');
    assert.equal(threadTexts.length, 1, 'thread result turn survived — no clobber');
  });
});
