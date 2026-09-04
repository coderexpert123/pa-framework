// Topic-task handover Wave 2 (SPEC §3.1 A.3, plans/2026-09-02-topic-handover-WAVE2-SPEC.md):
// the REWRITTEN executor-lane drainDueTopicTasks (claims → pickup FYI → fire-and-forget
// executeTopicTask) + the kb-cascade question attach and the per-turn pending_question
// cluster wiring. MUST stay first — sandboxes PA_HOME against real side effects
// (test-env-guard contract).
import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { _setExitForTest, drainDueTopicTasks, runPollLoop } from '../main.js';
import { loadTopicState, saveTopicState } from '../conversation.js';
import {
  appendTask,
  claimNextTask,
  answerTask,
  parkTask,
  listRunningTasks,
  listTasks,
  taskRunningPath,
  TOPIC_TASK_SLOTS,
  _resetTopicTasksForTest,
  type RunningTask,
} from '../../../../pa/dist/src/lib/topic-tasks.js';
import { readTopicEvents } from '../../../../pa/dist/src/lib/topic-events.js';
import { flushLog } from '../../../../pa/dist/src/lib/log.js';
import { _waitForTaskExecutionsForTest, type ExecuteTopicTaskArgs } from '../task-executor.js';
import { waitForDrain } from './test-teardown-guard.js';

// Integration-style cases below await runPollLoop() to completion — without this
// no-op the loop's terminal process.exit(0) kills this file's test subprocess
// before TAP flushes and the file reads back DARK (AI-171 root cause).
_setExitForTest(() => {});

const CHAT_ID = -1001234567890;
const THREAD_ID = 5001;
const FOREIGN_CHAT_ID = -1009999999999;

/** REAL producer (appendTask) seeded under the temp PA_HOME. */
async function seedTask(chatId: number, threadId: number, title: string, prompt: string): Promise<string> {
  const { id } = await appendTask(chatId, threadId, { title, prompt, createdBy: 'cli' });
  return id;
}

/** Claim through the REAL store so the running record is a genuine producer output
 *  (the drain reads the same files this writes). */
async function claimReal(chatId: number, threadId: number, title: string, prompt: string): Promise<string> {
  await appendTask(chatId, threadId, { title, prompt, createdBy: 'cli' });
  const claimed = await claimNextTask(chatId, threadId);
  assert.ok(claimed, 'fixture claim must succeed');
  return claimed.id;
}

/** Hand-written queue file — for records a VALID producer can never create
 *  (the whole point of the drain-time validation defense). */
async function writeRawQueue(chatId: number, threadId: number, records: unknown[]): Promise<void> {
  const path = join(process.env.PA_HOME!, 'topic-tasks', `${chatId}_${threadId}.json`);
  await mkdir(join(process.env.PA_HOME!, 'topic-tasks'), { recursive: true });
  await writeFile(path, JSON.stringify(records, null, 2), 'utf8');
}

async function readRawQueue(chatId: number, threadId: number): Promise<unknown[]> {
  const raw = await readFile(join(process.env.PA_HOME!, 'topic-tasks', `${chatId}_${threadId}.json`), 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

/** Backdate a running record's started_at (stale-demotion fixtures) — raw write while
 *  no other store op is in flight, exactly like the real atomic write leaves it. */
async function backdateStartedAt(chatId: number, threadId: number, id: string, minutesAgo: number): Promise<void> {
  const path = join(process.env.PA_HOME!, 'topic-tasks', `${chatId}_${threadId}.running.json`);
  const records = JSON.parse(await readFile(path, 'utf8'));
  const rec = records.find((r: any) => r.id === id);
  assert.ok(rec, 'fixture record must exist');
  rec.started_at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  await writeFile(path, JSON.stringify(records, null, 2), 'utf8');
}

/** Hand-written running record — for states a real producer cannot create (every
 *  slot occupied without spending TOPIC_TASK_SLOTS real claims). Mirrors the
 *  pa-side fixture (pa/tests/topic-tasks.test.ts) retimed by 2846ef4. */
async function writeRawRunning(chatId: number, threadId: number, records: RunningTask[]): Promise<void> {
  await mkdir(join(process.env.PA_HOME!, 'topic-tasks'), { recursive: true });
  await writeFile(taskRunningPath(chatId, threadId), JSON.stringify(records, null, 2), 'utf8');
}

function makeRunningRecord(overrides: Partial<RunningTask>): RunningTask {
  return {
    id: `tt-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    title: 'seeded',
    prompt: 'seeded prompt',
    created_at: new Date().toISOString(),
    created_by: 'cli',
    content_hash: 'deadbeefdeadbeef',
    status: 'running',
    slot: 0,
    started_at: new Date().toISOString(),
    micro_thread: [],
    fyi_message_ids: [],
    question: null,
    attempts: 1,
    ...overrides,
  };
}

describe('drainDueTopicTasks (executor lane)', () => {
  let tempDir: string;
  let originalPaHome: string | undefined;

  beforeEach(async () => {
    await flushLog(); // drain pending appends before switching PA_HOME
    tempDir = await mkdtemp(join(tmpdir(), 'topic-tasks-drain-'));
    originalPaHome = process.env.PA_HOME;
    process.env.PA_HOME = tempDir;
    _resetTopicTasksForTest();
  });

  afterEach(async () => {
    _resetTopicTasksForTest();
    await flushLog();
    await waitForDrain();
    if (originalPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = originalPaHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  async function readLogEntries(): Promise<any[]> {
    await flushLog();
    const raw = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  type ExecReceipt = { args: ExecuteTopicTaskArgs; queueAtDispatch: unknown[] };
  function makeExecute(): { execute: (args: ExecuteTopicTaskArgs) => Promise<void>; receipts: ExecReceipt[] } {
    const receipts: ExecReceipt[] = [];
    return {
      receipts,
      execute: (args) => {
        // SYNCHRONOUS queue snapshot: the drain fires executions fire-and-forget,
        // so any await here lets the NEXT claim pop a record before this capture
        // runs (same race the Wave-1 persist test dodged with readFileSync).
        const path = join(process.env.PA_HOME!, 'topic-tasks', `${args.topicCtx.chatId}_${args.topicCtx.threadId}.json`);
        let queueAtDispatch: unknown[] = [];
        try {
          const parsed = JSON.parse(readFileSync(path, 'utf8'));
          if (Array.isArray(parsed)) queueAtDispatch = parsed;
        } catch {
          /* queue file may legitimately be absent at dispatch time */
        }
        receipts.push({ args, queueAtDispatch });
        return Promise.resolve();
      },
    };
  }

  it('absent topic-tasks store is a no-op (returns 0)', async () => {
    const claimed = await drainDueTopicTasks(new Set([CHAT_ID]));
    assert.equal(claimed, 0);
  });

  it('drain claims at most two tasks per tick', async () => {
    await seedTask(CHAT_ID, THREAD_ID, 'a', 'do a');
    await seedTask(CHAT_ID, THREAD_ID, 'b', 'do b');
    await seedTask(CHAT_ID, THREAD_ID, 'c', 'do c');
    await seedTask(CHAT_ID, 5101, 'other topic task', 'do the other thing');
    const { execute, receipts } = makeExecute();
    const claimed = await drainDueTopicTasks(new Set([CHAT_ID]), { execute });
    assert.equal(claimed, 2, 'TOPIC_TASK_TICK_CAP = 2 GLOBAL per drain tick');
    await _waitForTaskExecutionsForTest();
    assert.equal(receipts.length, 2);
    // The unclaimed remainders stay queued for the next tick (one here, one in the
    // second topic — the cap is global, so WHICH topic wins the two claims follows
    // enumeration order and is not asserted).
    const leftHere = await readRawQueue(CHAT_ID, THREAD_ID);
    const leftOther = await readRawQueue(CHAT_ID, 5101);
    assert.equal(leftHere.length + leftOther.length, 2, 'the unclaimed tasks stay queued, never dropped');
  });

  it('drain pops none when slots busy', async () => {
    // The slot ceiling is now an unreachable backstop (operator directive
    // 2026-09-03), not a governor — real concurrency is paced by the bot's
    // global tick cap + worker pool. This test still proves the backstop
    // mechanism itself works: fill every slot the constant allows (whatever
    // it is) and confirm the drain claims nothing.
    const filler: RunningTask[] = Array.from({ length: TOPIC_TASK_SLOTS }, (_, i) =>
      makeRunningRecord({
        id: `tt-full${String(i).padStart(4, '0')}`,
        slot: i,
        status: i % 2 === 0 ? 'running' : 'parked',
      }),
    );
    await writeRawRunning(CHAT_ID, THREAD_ID, filler);
    await seedTask(CHAT_ID, THREAD_ID, 'queued behind full slots', 'waits');
    const { execute, receipts } = makeExecute();
    const claimed = await drainDueTopicTasks(new Set([CHAT_ID]), { execute });
    assert.equal(claimed, 0, 'every slot occupied — nothing claims');
    assert.equal(receipts.length, 0);
    assert.equal((await readRawQueue(CHAT_ID, THREAD_ID)).length, 1, 'the queued task is left untouched');
    const running = await listRunningTasks(CHAT_ID, THREAD_ID);
    const expectedRunning = filler.filter((r) => r.status === 'running').length;
    assert.equal(running.filter((r) => r.status === 'running').length, expectedRunning, 'the filler running records are undisturbed');
  });

  it('persist-before-dispatch: the claim is durable before the executor fires', async () => {
    await seedTask(CHAT_ID, THREAD_ID, 'first task', 'do the first thing');
    await seedTask(CHAT_ID, THREAD_ID, 'second task', 'do the second thing');
    await seedTask(CHAT_ID, THREAD_ID, 'third task', 'do the third thing');
    const { execute, receipts } = makeExecute();
    const claimed = await drainDueTopicTasks(new Set([CHAT_ID]), { execute });
    assert.equal(claimed, 2, 'the GLOBAL tick cap binds: two claims, the third waits for the next tick');
    await _waitForTaskExecutionsForTest();
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].queueAtDispatch.length, 2, 'after claim 1 the two remainders were already persisted');
    assert.equal((receipts[0].queueAtDispatch[0] as any).title, 'second task');
    assert.equal(receipts[1].queueAtDispatch.length, 1, 'after claim 2 the last remainder was already persisted');
    assert.equal((receipts[1].queueAtDispatch[0] as any).title, 'third task');
    const running = await listRunningTasks(CHAT_ID, THREAD_ID);
    assert.equal(running.length, 2, 'both claims sit in the running store');
    assert.ok(running.every((r) => r.status === 'running'));
    assert.equal((await readRawQueue(CHAT_ID, THREAD_ID)).length, 1, 'the third task stays queued');
  });

  it('pickup FYI carries queue depth line', async () => {
    await seedTask(CHAT_ID, THREAD_ID, 'first task', 'do the first thing');
    await seedTask(CHAT_ID, THREAD_ID, 'second task', 'do the second thing');
    const sends: Array<{ chatId: number; threadId: number; text: string; kind: string }> = [];
    await drainDueTopicTasks(new Set([CHAT_ID]), {
      sendFyi: async (chatId, threadId, text, kind) => {
        sends.push({ chatId, threadId, text, kind });
        return 4242;
      },
      execute: async () => {}, // never let the real executor spawn a worker in a test
    });
    const pickup = sends.find((s) => s.kind === 'task-pickup');
    assert.ok(pickup, 'a pickup FYI must be sent');
    assert.equal(pickup.text, '📌 Picked up: first task (+1 queued)', 'queue depth rides the frozen line');
    // The FYI's message id became a tier-1 anchor.
    const running = await listRunningTasks(CHAT_ID, THREAD_ID);
    assert.ok(running.some((r) => r.fyi_message_ids.includes(4242)), 'pickup message id recorded as an anchor');
  });

  it('invalid prompt WARN + failTask — the record never lingers holding a slot', async () => {
    // appendTask (the valid producer) rejects multiline prompts — this record can
    // only exist via a producer bug or hand edit, which is exactly what the
    // drain-time validation defends against.
    await writeRawQueue(CHAT_ID, THREAD_ID, [{
      id: 'tt-badinput0001', kind: 'task', title: 'bad record', prompt: 'line one\nline two',
      created_at: new Date().toISOString(), created_by: 'cli', content_hash: 'deadbeefdeadbeef',
    }]);
    const { execute, receipts } = makeExecute();
    const claimed = await drainDueTopicTasks(new Set([CHAT_ID]), { execute });
    assert.equal(claimed, 0);
    assert.equal(receipts.length, 0);
    assert.deepEqual(await readRawQueue(CHAT_ID, THREAD_ID), [], 'the record left the queue');
    assert.deepEqual(await listRunningTasks(CHAT_ID, THREAD_ID), [], 'and was NOT parked in the running store either');
    const entries = await readLogEntries();
    const warn = entries.find((e) => e.module === 'topic-task' && e.level === 'warn');
    assert.ok(warn, 'a topic-task WARN must be logged');
    assert.match(warn.message, /rejected at drain time/);
    assert.equal(warn.id, 'tt-badinput0001');
  });

  it('foreign chat records are skipped before claiming, never consumed', async () => {
    await seedTask(FOREIGN_CHAT_ID, THREAD_ID, 'foreign task', 'should never dispatch');
    const { execute, receipts } = makeExecute();
    const claimed = await drainDueTopicTasks(new Set([CHAT_ID]), { execute });
    assert.equal(claimed, 0);
    assert.equal(receipts.length, 0);
    assert.equal((await readRawQueue(FOREIGN_CHAT_ID, THREAD_ID)).length, 1, 'foreign records stay queued (never claimed)');
    const entries = await readLogEntries();
    const warn = entries.find((e) => e.module === 'topic-task' && e.level === 'warn');
    assert.ok(warn, 'a topic-task WARN must be logged');
    assert.match(warn.message, /is not an allowed chat/);
  });

  it('no age-based drop: a long-ago-queued task still claims (created_at never gates the drain)', async () => {
    const id = await seedTask(CHAT_ID, THREAD_ID, 'stale task', 'queued long ago');
    // Backdate created_at AFTER the real producer wrote the record.
    const path = join(process.env.PA_HOME!, 'topic-tasks', `${CHAT_ID}_${THREAD_ID}.json`);
    const records = JSON.parse(await readFile(path, 'utf8'));
    records[0].created_at = '2026-08-01T04:00:00.000Z';
    await writeFile(path, JSON.stringify(records, null, 2), 'utf8');
    const { execute, receipts } = makeExecute();
    const claimed = await drainDueTopicTasks(new Set([CHAT_ID]), { execute });
    assert.equal(claimed, 1);
    await _waitForTaskExecutionsForTest();
    assert.equal(receipts[0].args.task.id, id);
  });

  it('no real executor ever fires without the execute seam in this file', async () => {
    // Guard rail for the tests above: every claim-carrying case passes an execute
    // double; the real executeTopicTask (worker spawn path) must only be exercised
    // in task-executor.test.ts through its dispatch seam.
    await seedTask(CHAT_ID, THREAD_ID, 'default execute probe', 'the prompt text');
    const realDispatch = await drainDueTopicTasks(new Set([CHAT_ID]), {
      execute: async () => { throw new Error('real executor reached from drain test'); },
    });
    assert.equal(realDispatch, 1);
    await _waitForTaskExecutionsForTest();
  });

  it('task_started event on a fresh claim', async () => {
    const id = await seedTask(CHAT_ID, THREAD_ID, 'audited task', 'the prompt text');
    const { execute } = makeExecute();
    await drainDueTopicTasks(new Set([CHAT_ID]), { execute });
    const events = await readTopicEvents(CHAT_ID, THREAD_ID);
    const started = events.filter((e) => e.kind === 'task_started' && e.ref === id);
    assert.equal(started.length, 1, 'exactly one task_started event for this task id');
    assert.equal(started[0].detail, 'audited task');
  });

  it('task_resumed event when a ready record is promoted (attempts > 1)', async () => {
    const id = await claimReal(CHAT_ID, THREAD_ID, 'to be answered', 'the prompt text');
    // Real consumer path: park on a question, then an answer flips the PARKED
    // record to ready (answers to RUNNING records no longer resume — the
    // double-dispatch guard keeps an in-flight dispatch in control).
    await parkTask(CHAT_ID, THREAD_ID, id, { text: 'A or B?', options: ['A', 'B'] });
    const answered = await answerTask(CHAT_ID, THREAD_ID, id, 'the option text');
    assert.ok(answered);
    assert.equal(answered.status, 'ready');
    const { execute, receipts } = makeExecute();
    await drainDueTopicTasks(new Set([CHAT_ID]), { execute });
    await _waitForTaskExecutionsForTest();
    assert.equal(receipts.length, 1, 'the ready record is claimed (resume precedence)');
    assert.equal(receipts[0].args.task.id, id);
    assert.equal(receipts[0].args.task.attempts, 2, 'promotion bumps attempts — the drain labels it a resume');
    const events = await readTopicEvents(CHAT_ID, THREAD_ID);
    const resumed = events.filter((e) => e.kind === 'task_resumed' && e.ref === id);
    assert.equal(resumed.length, 1, 'task_resumed, not task_started');
  });

  it('stale demotion runs for EVERY enumerated topic at drain start, claim cap or not', async () => {
    // Topic A wins both global claims this tick (its demoted stale record is
    // resumed first, then a filler); topics B and C win none — B's stale crashed
    // dispatch must STILL be demoted (queue file deleted, so B is enumerated via
    // its .running.json alone), and C's FRESH record must survive the sweep.
    const idA = await claimReal(CHAT_ID, THREAD_ID, 'a running stale', 'stale in A');
    await backdateStartedAt(CHAT_ID, THREAD_ID, idA, 31);
    const idB = await claimReal(CHAT_ID, 5101, 'b running stale', 'stale in B');
    await backdateStartedAt(CHAT_ID, 5101, idB, 31);
    await unlink(join(process.env.PA_HOME!, 'topic-tasks', `${CHAT_ID}_5101.json`));
    const freshId = await claimReal(CHAT_ID, 5102, 'fresh', 'claimed before the drain, same minute');
    await seedTask(CHAT_ID, THREAD_ID, 'fill 1', 'claim filler one');
    await seedTask(CHAT_ID, THREAD_ID, 'fill 2', 'claim filler two');
    const { execute, receipts } = makeExecute();
    const claimed = await drainDueTopicTasks(new Set([CHAT_ID]), { execute });
    assert.equal(claimed, 2, 'topic A wins the whole tick cap');
    await _waitForTaskExecutionsForTest();
    assert.ok(receipts.every((r) => r.args.topicCtx.threadId === THREAD_ID), 'topics B and C won no claim');
    const recA = (await listRunningTasks(CHAT_ID, THREAD_ID)).find((r) => r.id === idA);
    const recB = (await listRunningTasks(CHAT_ID, 5101)).find((r) => r.id === idB);
    const recFresh = (await listRunningTasks(CHAT_ID, 5102)).find((r) => r.id === freshId);
    assert.ok(recA && recB && recFresh, 'all three records still exist');
    assert.equal(recA.attempts, 2, 'A stale record was demoted to ready, then promoted as a RESUME (attempts bumped)');
    assert.equal(recB.status, 'ready', 'B stale record demoted although topic B won NO claim this tick');
    assert.equal(recFresh.status, 'running', 'a fresh record is not demoted by the sweep');
  });

  it('fires the executor NOT awaited — the tick returns while execution is pending', async () => {
    await seedTask(CHAT_ID, THREAD_ID, 'slow task', 'takes a while');
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let executions = 0;
    const execute = async (): Promise<void> => {
      executions += 1;
      await gate;
    };
    const drained = drainDueTopicTasks(new Set([CHAT_ID]), { execute });
    const tickResult = await drained;
    assert.equal(tickResult, 1, 'the tick resolves while the execution is still gated');
    assert.equal(executions, 1, 'the executor fired exactly once');
    release();
    await _waitForTaskExecutionsForTest();
    assert.ok('executions drained');
  });

  it('corrupt running store is WARN + skipped, job never crashes', async () => {
    const path = join(process.env.PA_HOME!, 'topic-tasks', `${CHAT_ID}_${THREAD_ID}.running.json`);
    await mkdir(join(process.env.PA_HOME!, 'topic-tasks'), { recursive: true });
    await writeFile(path, '{not json', 'utf8');
    const { execute, receipts } = makeExecute();
    const claimed = await drainDueTopicTasks(new Set([CHAT_ID]), { execute });
    assert.equal(claimed, 0);
    assert.equal(receipts.length, 0);
    const entries = await readLogEntries();
    const warn = entries.find((e) => e.module === 'topic-task' && e.level === 'warn');
    assert.ok(warn, 'a topic-task WARN must be logged');
    assert.match(warn.message, /unreadable/);
  });

  it('executor context carries topic name, secrets and a topic-home workdir', async () => {
    await seedTask(CHAT_ID, THREAD_ID, 'context probe', 'the prompt text');
    const { execute, receipts } = makeExecute();
    await drainDueTopicTasks(new Set([CHAT_ID]), {
      topicNames: new Map([[String(CHAT_ID), new Map([[THREAD_ID, { name: 'Handover Sandbox' }]])]]) as any,
      execute,
    });
    await _waitForTaskExecutionsForTest();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].args.topicCtx.topicName, 'Handover Sandbox');
    assert.ok(receipts[0].args.workdir.dir.includes(String(THREAD_ID)), 'workdir is topic-scoped');
    const queued = await listTasks(CHAT_ID, THREAD_ID);
    assert.equal(queued.length, 0, 'nothing left behind');
  });
});

// ---------------------------------------------------------------------------
// Integration-style: the kb cascade + per-turn pending_question cluster, driven
// through runPollLoop → processUpdate with a fetch double (integration.test.ts
// harness). /help is a skip-worker turn: the dispatch is never attempted, so
// workerErrored stays false and the reply-send kb cascade is what the asserts
// observe.
// ---------------------------------------------------------------------------

const fastSleep = async (_ms: number): Promise<void> => {};

function makeUpdate(updateId: number, chatId: number, text: string, threadId?: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: threadId ? 'supergroup' : 'private' },
      ...(threadId ? { message_thread_id: threadId } : {}),
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

function ok(json: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(json),
    json: async () => json,
  };
}

function setupFetch(
  controller: AbortController,
  batches: object[][]
): { sends: any[]; restore: () => void } {
  const savedFetch = globalThis.fetch;
  const sends: any[] = [];
  let batchIndex = 0;
  (globalThis as Record<string, unknown>).fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('getUpdates')) {
      const result = batches[batchIndex] ?? [];
      if (batchIndex >= batches.length - 1) controller.abort();
      batchIndex++;
      return ok({ ok: true, result });
    }
    if (u.includes('sendMessage')) {
      let body: any = {};
      try { body = JSON.parse(String(init?.body ?? '{}')); } catch { /* keep {} */ }
      sends.push(body);
      return ok({ ok: true, result: { message_id: 999 } });
    }
    return ok({ ok: true, result: true });
  }) as typeof fetch;
  return { sends, restore: () => { (globalThis as Record<string, unknown>).fetch = savedFetch; } };
}

function keyboardsOf(body: any): Array<Array<{ text: string; callback_data: string }>> {
  const rm = body?.reply_markup;
  const kb = typeof rm === 'string' ? JSON.parse(rm) : rm;
  return kb?.inline_keyboard ?? [];
}

async function armQuestion(chatId: number, threadId: number): Promise<void> {
  const topic = await loadTopicState(chatId, threadId);
  topic.pending_question = {
    text: 'Prefer A or B?',
    options: ['Option A', 'Option B'],
    task_id: 'tt-abc123def456',
    asked_at: new Date().toISOString(),
  };
  await saveTopicState(topic);
}

describe('kb cascade + pending_question wiring (processUpdate, /help skip-worker turn)', () => {
  let tempDir: string;
  let originalPaHome: string | undefined;
  let restore: (() => void) | undefined;

  beforeEach(async () => {
    await flushLog();
    tempDir = await mkdtemp(join(tmpdir(), 'topic-task-kb-'));
    originalPaHome = process.env.PA_HOME;
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    restore?.();
    restore = undefined;
    await flushLog();
    await waitForDrain();
    if (originalPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = originalPaHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  async function runHelpTurn(text = '/help'): Promise<any[]> {
    const controller = new AbortController();
    const { sends, restore: r } = setupFetch(controller, [
      [makeUpdate(10, CHAT_ID, text, THREAD_ID)],
      [],
    ]);
    restore = r;
    const state = { chat_id: CHAT_ID, last_update_id: -1, thread_id: 0, turns: [] };
    await runPollLoop('token', [CHAT_ID], state, {}, controller.signal, fastSleep);
    return sends;
  }

  /** The /help reply body specifically — the pinned status card send ALSO carries
   *  a keyboard of its own, so "any send with a keyboard" is not a usable filter. */
  function helpReply(sends: any[]): any {
    const replies = sends.filter((s) => typeof s.text === 'string' && s.text.includes('Available Commands'));
    assert.equal(replies.length, 1, 'exactly one /help reply expected');
    return replies[0];
  }

  it('question keyboard attaches when no pending action', async () => {
    await armQuestion(CHAT_ID, THREAD_ID);
    const sends = await runHelpTurn();
    const reply = helpReply(sends);
    const kb = keyboardsOf(reply);
    assert.deepEqual(kb, [
      [{ text: 'Option A', callback_data: 'q:0' }],
      [{ text: 'Option B', callback_data: 'q:1' }],
    ], 'one button per row, label = option text verbatim, data q:<idx>');
    assert.equal(reply.message_thread_id, THREAD_ID);
  });

  it('pending action keyboard wins', async () => {
    await armQuestion(CHAT_ID, THREAD_ID);
    const topic = await loadTopicState(CHAT_ID, THREAD_ID);
    topic.pending_action = { description: 'do the thing', proposed_at: new Date().toISOString() };
    await saveTopicState(topic);
    const sends = await runHelpTurn();
    const flat = keyboardsOf(helpReply(sends)).flat().map((b) => b.callback_data);
    assert.ok(flat.every((d) => d.startsWith('cf:')), 'confirm keyboard attached');
    assert.ok(!flat.some((d) => d.startsWith('q:')), 'question keyboard must NOT displace a confirm ask');
    // The question was NOT anchored (its keyboard never rendered) — it must stay
    // armless-anchored so a LATER reply can still carry it.
    const after = await loadTopicState(CHAT_ID, THREAD_ID);
    assert.equal(after.pending_question?.message_id, undefined);
  });

  it('pending_question message_id set on send', async () => {
    await armQuestion(CHAT_ID, THREAD_ID);
    await runHelpTurn();
    const after = await loadTopicState(CHAT_ID, THREAD_ID);
    assert.equal(after.pending_question?.message_id, 999, 'anchored to the mocked reply message_id');
  });

  it('question_asked event written on attach', async () => {
    await armQuestion(CHAT_ID, THREAD_ID);
    await runHelpTurn();
    const events = await readTopicEvents(CHAT_ID, THREAD_ID);
    const asked = events.filter((e) => e.kind === 'question_asked');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].ref, 'tt-abc123def456', 'ref = the question task_id');
    assert.equal(asked[0].detail, 'Prefer A or B?');
  });

  it('typed answer matching an option clears pending_question through the per-turn cluster', async () => {
    // The q: press itself cannot clear the question (loadTopicState hands the
    // handler a COPY) — the injected option-text turn clears it HERE. This test
    // drives that exact synthetic-turn shape as a plain message.
    await armQuestion(CHAT_ID, THREAD_ID);
    await runHelpTurn('Option A');
    const after = await loadTopicState(CHAT_ID, THREAD_ID);
    assert.equal(after.pending_question, undefined, 'the matched answer consumed the question and persisted the clear');
  });

  it('non-matching turn leaves pending_question armed and unanchored', async () => {
    await armQuestion(CHAT_ID, THREAD_ID);
    // A plain non-matching message dispatches (fails gracefully — no CLI in the
    // test env), so workerErrored is true and the FAILover keyboard attaches; the
    // question must stay armed for a later reply to render it.
    await runHelpTurn('something unrelated entirely');
    const after = await loadTopicState(CHAT_ID, THREAD_ID);
    assert.ok(after.pending_question, 'question stays armed');
    assert.equal(after.pending_question?.text, 'Prefer A or B?');
    assert.equal(after.pending_question?.message_id, undefined, 'never anchored to a keyboard-less (failover) reply');
  });
});
