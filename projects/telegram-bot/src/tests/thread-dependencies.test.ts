/**
 * AI-232 — dependency primitive + dispatch dedup wiring (WP-2).
 *
 * Every test drives the REAL store (topic-threads.ts) and, where the claim
 * funnel's wake behavior is the thing under test, the REAL executor
 * (thread-executor.ts) over a temp PA_HOME/store dir — never hand-built
 * fixtures standing in for the producer. S8 is the load-bearing test: it is
 * the only instrument that can distinguish "wakes on the completion EVENT"
 * from "wakes because a timer/backstop eventually notices the record write".
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CommandResult } from '../../../../pa/dist/src/types.js';
import {
  createThread,
  getThread,
  updateThread,
  cancelOneThread,
  claimThreadStarts,
  _clearThreadsForTest,
  _setStoreDirForTest,
  THREAD_ACTIVITY_THROTTLE_MS,
  type ThreadRecord,
} from '../topic-threads.js';
import {
  executeTopicThread,
  buildThreadPrompt,
  renderUpstreamResults,
  _setActivityPumpIntervalForTest,
  _resetThreadQueueReconcileForTest,
  _resetThreadInterruptsForTest,
  _waitForThreadExecutionsForTest,
  THREAD_RESULT_EXCERPT_CHARS,
  type ThreadFyiSender,
  type ThreadDispatchFn,
  type ThreadTopicContext,
} from '../thread-executor.js';
import { handleSpawn, renderThreadsSection, type HandleSpawnArgs } from '../orchestrator.js';
import { handleOrchestratorCommand } from '../logic.js';
import type { ConversationState } from '../types.js';

const CHAT_ID = -1001234567890; // synthetic fixture family — never a real chat
const THREAD_ID = 5001;
const CTX: ThreadTopicContext = { chatId: CHAT_ID, threadId: THREAD_ID, topicName: 'Test Topic' };
const KEY = `${CHAT_ID}_${THREAD_ID}`;

let home: string;
let storeDir: string;
let workdir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pa-thread-deps-'));
  storeDir = mkdtempSync(join(tmpdir(), 'pa-thread-deps-store-'));
  workdir = mkdtempSync(join(tmpdir(), 'pa-thread-deps-wd-'));
  process.env.PA_HOME = home;
  _setStoreDirForTest(storeDir);
  _setActivityPumpIntervalForTest(THREAD_ACTIVITY_THROTTLE_MS);
  _resetThreadQueueReconcileForTest();
  _resetThreadInterruptsForTest();
});

afterEach(async () => {
  await _waitForThreadExecutionsForTest();
  _setActivityPumpIntervalForTest(THREAD_ACTIVITY_THROTTLE_MS);
  _setStoreDirForTest(undefined);
  _clearThreadsForTest();
  delete process.env.PA_HOME;
  for (const dir of [home, storeDir, workdir]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function okResult(output: string, sessionId?: string): CommandResult {
  return { success: true, output, exitCode: 0, ...(sessionId ? { sessionId } : {}) };
}

function minutesAgoIso(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

/** Seed the store's own on-disk format directly — for bulk/age-sensitive fixtures. */
function seedFile(key: string, records: ThreadRecord[]): void {
  const obj = Object.fromEntries(records.map((r) => [r.id, r]));
  writeFileSync(join(storeDir, `${key}.json`), JSON.stringify(obj, null, 2));
}

function readStoreFile(key: string): Record<string, ThreadRecord> {
  return JSON.parse(readFileSync(join(storeDir, `${key}.json`), 'utf8'));
}

function mkRec(id: string, n: number, status: ThreadRecord['status'], overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id,
    n,
    title: `thread ${n}`,
    goal: `goal ${n}`,
    status,
    createdAt: minutesAgoIso(10),
    updatedAt: minutesAgoIso(10),
    workdir,
    runSeq: 1,
    attempts: 0,
    pendingInput: [],
    ...overrides,
  };
}

/** Read the REAL topic-events jsonl the store/executor emitters wrote under PA_HOME. */
async function readTopicEventsJsonl(): Promise<{ kind: string; ref: string | null; detail: string }[]> {
  try {
    const raw = await readFile(join(home, 'topic-events', `${KEY}.jsonl`), 'utf8');
    return raw
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { kind: string; ref: string | null; detail: string });
  } catch {
    return [];
  }
}

function makeFyiRecorder() {
  const calls: { text: string; kind: string }[] = [];
  const sendFyi: ThreadFyiSender = async (text, kind) => {
    calls.push({ text, kind });
    return 42;
  };
  return { calls, sendFyi };
}

/**
 * Real-dispatch harness (thread-executor.test.ts's writeFakeWorker idiom): a
 * fake worker configured in the test's temp PA_HOME appends every dispatched
 * prompt to a capture file and replies with `output`. Used wherever a REAL
 * fire (executor terminal wake, or handleSpawn's own fireThreadExecution) must
 * settle quickly rather than hitting the real worker cascade.
 */
function writeFakeWorker(output: string): string {
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
    '  process.exitCode = 0;',
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

function makeSpawnArgs(overrides: Partial<HandleSpawnArgs> = {}): HandleSpawnArgs {
  return {
    topicKey: KEY,
    topicName: 'Test Topic',
    spawn: { title: 'Twin', prompt: 'placeholder' },
    secrets: {},
    token: 'test-token',
    workdir,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('S1 — createThread parks on an unmet dependency', () => {
  it('parks as queued and persists dependsOn', async () => {
    const dep = await createThread(KEY, { title: 'Dep', goal: 'dep goal', workdir });
    assert.ok(dep.ok);
    const created = await createThread(KEY, { title: 'Dependent', goal: 'dependent goal', workdir, dependsOn: [dep.ok ? dep.thread.id : ''] });
    assert.ok(created.ok);
    if (!created.ok) return;
    assert.equal(created.thread.status, 'queued');
    assert.deepEqual(created.thread.dependsOn, ['t-1']);
    const onDisk = readStoreFile(KEY);
    assert.deepEqual(onDisk[created.thread.id].dependsOn, ['t-1']);
  });
});

describe('S2 — fail-open sanitation of dependsOn', () => {
  it('keeps only well-formed, existing, de-duplicated ids', async () => {
    const dep = await createThread(KEY, { title: 'Dep', goal: 'dep goal', workdir });
    assert.ok(dep.ok);
    const created = await createThread(KEY, {
      title: 'Dependent', goal: 'dependent goal', workdir,
      dependsOn: ['t-1', 'bogus', 't-1', 't-99'],
    });
    assert.ok(created.ok);
    if (!created.ok) return;
    assert.deepEqual(created.thread.dependsOn, ['t-1']);
  });

  it('never rejects a spawn: all-invalid dependsOn persists none and starts running', async () => {
    const created = await createThread(KEY, {
      title: 'Solo', goal: 'solo goal', workdir,
      dependsOn: ['bogus', 't-99'],
    });
    assert.ok(created.ok);
    if (!created.ok) return;
    assert.equal(created.thread.status, 'running');
    assert.equal(created.thread.dependsOn, undefined);
  });
});

describe('S3 — claim gate', () => {
  it('withholds the dependent while the dependency is unmet, claims it once satisfied', async () => {
    const dep = await createThread(KEY, { title: 'Dep', goal: 'dep goal', workdir }); // running
    assert.ok(dep.ok);
    const created = await createThread(KEY, { title: 'Dependent', goal: 'dependent goal', workdir, dependsOn: ['t-1'] });
    assert.ok(created.ok);
    if (!created.ok || !dep.ok) return;

    let claimed = await claimThreadStarts(KEY);
    assert.deepEqual(claimed, []);
    assert.equal((await getThread(KEY, created.thread.id))?.status, 'queued');

    await updateThread(KEY, dep.thread.id, { status: 'done' });
    claimed = await claimThreadStarts(KEY);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, created.thread.id);
    assert.equal((await getThread(KEY, created.thread.id))?.status, 'running');
  });
});

describe('S4 — cascade on a failed dependency', () => {
  it('cancels the dependent with the frozen error and emits exactly one thread_cancelled', async () => {
    const dep = await createThread(KEY, { title: 'Dep', goal: 'dep goal', workdir });
    assert.ok(dep.ok);
    if (!dep.ok) return;
    await updateThread(KEY, dep.thread.id, { status: 'failed' });
    const created = await createThread(KEY, { title: 'Dependent', goal: 'dependent goal', workdir, dependsOn: [dep.thread.id] });
    assert.ok(created.ok);
    if (!created.ok) return;
    assert.equal(created.thread.status, 'queued');

    const claimed = await claimThreadStarts(KEY);
    assert.deepEqual(claimed, []);

    const after = await getThread(KEY, created.thread.id);
    assert.equal(after?.status, 'cancelled');
    assert.equal(after?.lastError, `dependency ${dep.thread.id} ended failed; cancelled instead of waiting (AI-232)`);

    const events = await readTopicEventsJsonl();
    const cancels = events.filter((e) => e.kind === 'thread_cancelled');
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].ref, created.thread.id);
    assert.equal(cancels[0].detail, `dependency ${dep.thread.id} failed`);
  });
});

describe('S5 — transitive cascade in one pass', () => {
  it('cancels a two-hop chain in a single claimThreadStarts call', async () => {
    const t1 = await createThread(KEY, { title: 'T1', goal: 'g1', workdir });
    assert.ok(t1.ok);
    if (!t1.ok) return;
    await updateThread(KEY, t1.thread.id, { status: 'failed' });
    const t2 = await createThread(KEY, { title: 'T2', goal: 'g2', workdir, dependsOn: [t1.thread.id] });
    assert.ok(t2.ok);
    if (!t2.ok) return;
    const t3 = await createThread(KEY, { title: 'T3', goal: 'g3', workdir, dependsOn: [t2.thread.id] });
    assert.ok(t3.ok);
    if (!t3.ok) return;

    await claimThreadStarts(KEY);

    assert.equal((await getThread(KEY, t2.thread.id))?.status, 'cancelled');
    assert.equal((await getThread(KEY, t3.thread.id))?.status, 'cancelled');
  });
});

describe('S6 — immediate cascade on a single cancel', () => {
  it('cancelOneThread cascades the dependent with no claim/reconcile call', async () => {
    const dep = await createThread(KEY, { title: 'Dep', goal: 'dep goal', workdir }); // running
    assert.ok(dep.ok);
    if (!dep.ok) return;
    const created = await createThread(KEY, { title: 'Dependent', goal: 'dependent goal', workdir, dependsOn: [dep.thread.id] });
    assert.ok(created.ok);
    if (!created.ok) return;

    const flipped = await cancelOneThread(KEY, dep.thread.id);
    assert.equal(flipped, true);

    assert.equal((await getThread(KEY, dep.thread.id))?.status, 'cancelled');
    assert.equal((await getThread(KEY, created.thread.id))?.status, 'cancelled');
  });
});

describe('S7 — prune protection', () => {
  it('never prunes a terminal record still referenced by a live dependsOn', async () => {
    const records: ThreadRecord[] = [];
    for (let n = 1; n <= 19; n++) {
      records.push(mkRec(`t-${n}`, n, 'done'));
    }
    records.push(mkRec('t-20', 20, 'queued', { dependsOn: ['t-1'] }));
    seedFile(KEY, records);

    const created = await createThread(KEY, { title: '21st', goal: 'goal 21', workdir });
    assert.ok(created.ok);

    const onDisk = readStoreFile(KEY);
    assert.ok(onDisk['t-1'], 't-1 is referenced by a live record and must survive the prune');
    assert.equal(Object.keys(onDisk).length, 20, 'store stays capped at 20');
    // Some OTHER terminal record must have been pruned instead of t-1.
    const survivorsTerminal = Object.values(onDisk).filter((r) => r.status === 'done').length;
    assert.equal(survivorsTerminal, 18, 'exactly one terminal (non-referenced) record was pruned');
  });
});

describe('S8 — event-driven wake, not a timer', () => {
  it('a dependent starts inside the same await chain as its dependency\'s terminal transition', async () => {
    writeFakeWorker('B output');
    const t1 = await createThread(KEY, { title: 'A', goal: 'Goal A text.', workdir });
    assert.ok(t1.ok);
    if (!t1.ok) return;
    const t2 = await createThread(KEY, { title: 'B', goal: 'Goal B text.', workdir, dependsOn: [t1.thread.id] });
    assert.ok(t2.ok);
    if (!t2.ok) return;
    assert.equal(t2.thread.status, 'queued');

    const fyi = makeFyiRecorder();
    const dispatch: ThreadDispatchFn = async () => ({ worker: 'claude', result: okResult('A done', 'sess-a1') });

    // REAL executor, no manual claimThreadStarts/reconcileThreadQueues call —
    // the dependent must wake purely off A's terminal wakeQueue() await chain.
    // The status check happens IMMEDIATELY after this await resolves, with no
    // sleep and no drain in between: wakeQueue's claimThreadStarts flips B's
    // status synchronously under the store lock before this promise settles,
    // proving the wake rides the completion event, not a later poll.
    await executeTopicThread({ thread: t1.thread, topicCtx: CTX, secrets: {}, token: 'test-token', sendFyi: fyi.sendFyi, dispatch });

    const afterB = await getThread(KEY, t2.thread.id);
    assert.equal(afterB?.status, 'running', 'B must be running purely from A\'s completion wake — zero sleeps, zero manual claim calls');

    await _waitForThreadExecutionsForTest(); // drain B's fired (real-cascade) dispatch before teardown
  });

  it('negative control: flipping status via updateThread alone does NOT wake the dependent', async () => {
    const t1 = await createThread(KEY, { title: 'C', goal: 'Goal C text.', workdir });
    assert.ok(t1.ok);
    if (!t1.ok) return;
    const t2 = await createThread(KEY, { title: 'D', goal: 'Goal D text.', workdir, dependsOn: [t1.thread.id] });
    assert.ok(t2.ok);
    if (!t2.ok) return;
    assert.equal(t2.thread.status, 'queued');

    // The record write alone — no executor, no wake — must NOT resume the dependent.
    await updateThread(KEY, t1.thread.id, { status: 'done' });

    const afterD = await getThread(KEY, t2.thread.id);
    assert.equal(afterD?.status, 'queued', 'a bare record write must never be mistaken for the wake event');
  });
});

describe('S9 — renderUpstreamResults (pure)', () => {
  it('formats one line per dependency, clamps to THREAD_RESULT_EXCERPT_CHARS, and handles missing results', () => {
    const long = 'x'.repeat(500);
    const out = renderUpstreamResults([
      { id: 't-1', title: 'Sweep logs', status: 'done', lastResult: long },
      { id: 't-4', title: 'Fetch data', status: 'done' },
    ]);
    assert.ok(out.startsWith('## Upstream results'));
    const expectedExcerpt = 'x'.repeat(THREAD_RESULT_EXCERPT_CHARS);
    assert.ok(out.includes(`t-1 — Sweep logs (done): ${expectedExcerpt}`));
    assert.ok(!out.includes('x'.repeat(THREAD_RESULT_EXCERPT_CHARS + 1)));
    assert.ok(out.includes('t-4 — Fetch data (done): (no result recorded)'));
  });

  it('empty list renders nothing', () => {
    assert.equal(renderUpstreamResults([]), '');
  });
});

describe('S10 — prompt composition', () => {
  it('no third argument is byte-identical to an empty-string third argument', async () => {
    const created = await createThread(KEY, { title: 'Plain', goal: 'do the plain thing', workdir });
    assert.ok(created.ok);
    if (!created.ok) return;
    const withoutArg = buildThreadPrompt(created.thread, CTX);
    const withEmpty = buildThreadPrompt(created.thread, CTX, '');
    assert.equal(withoutArg, withEmpty);
  });

  it('a non-empty upstream section appears after the goal and before ## Rules', async () => {
    const created = await createThread(KEY, { title: 'Plain', goal: 'do the plain thing', workdir });
    assert.ok(created.ok);
    if (!created.ok) return;
    const upstream = renderUpstreamResults([{ id: 't-1', title: 'Dep', status: 'done', lastResult: 'result text' }]);
    const prompt = buildThreadPrompt(created.thread, CTX, upstream);
    const goalIdx = prompt.indexOf('do the plain thing');
    const upstreamIdx = prompt.indexOf('## Upstream results');
    const rulesIdx = prompt.indexOf('## Rules');
    assert.ok(goalIdx > -1 && upstreamIdx > goalIdx, 'upstream section must come after the goal');
    assert.ok(rulesIdx > upstreamIdx, 'upstream section must come before ## Rules');
  });
});

describe('S11 — dedup end-to-end through handleSpawn', () => {
  it('an exact-match twin parks the new thread with the frozen footer and event', async () => {
    writeFakeWorker('unused'); // in case the twin path ever fires (it must not)
    const seeded = await createThread(KEY, { title: 'Original', goal: 'Sweep the logs.', workdir });
    assert.ok(seeded.ok);
    if (!seeded.ok) return;

    const footer = await handleSpawn(makeSpawnArgs({ spawn: { title: 'Twin', prompt: '  sweep  THE logs!! ' } }));

    assert.equal(
      footer,
      `\n\n_(Thread t-2 queued behind t-1 (exact goal match) — it starts automatically when t-1 finishes and receives its result. Steer or /stop it if that is wrong.)_`
    );
    const rec = await getThread(KEY, 't-2');
    assert.equal(rec?.status, 'queued');
    assert.deepEqual(rec?.dependsOn, ['t-1']);

    const events = await readTopicEventsJsonl();
    const spawned = events.find((e) => e.kind === 'thread_spawned' && e.ref === 't-2');
    assert.ok(spawned);
    assert.equal(spawned?.detail, 'queued behind t-1 (exact goal match)');
  });
});

describe('S12 — dedup does not block genuinely different work', () => {
  it('a different goal spawns/parks normally with the unchanged footer', async () => {
    writeFakeWorker('B output');
    const seeded = await createThread(KEY, { title: 'Original', goal: 'count the running widgets', workdir });
    assert.ok(seeded.ok);
    if (!seeded.ok) return;

    const footer = await handleSpawn(makeSpawnArgs({ spawn: { title: 'Different', prompt: 'tally the B figures' } }));

    // Read the record's status BEFORE draining the fired (fire-and-forget)
    // execution to completion — handleSpawn's returned footer is decided
    // synchronously from this same state, so this is the honest comparison
    // point (after a full drain the record has already moved to 'done').
    const rec = await getThread(KEY, 't-2');
    assert.equal(rec?.dependsOn, undefined, 'a genuinely different goal must never gain a dependsOn');
    if (rec?.status === 'running') {
      assert.equal(footer, `\n\n_(Thread t-2 spawned: Different — its result arrives in this topic when it finishes.)_`);
    } else {
      assert.equal(rec?.status, 'queued');
      assert.equal(footer, `\n\n_(Thread t-2 queued — starts when one finishes.)_`);
    }

    await _waitForThreadExecutionsForTest(); // drain before teardown
  });
});

describe('S13 — renderer parity', () => {
  it('renderThreadsSection shows the waiting-on suffix only when dependsOn is present', () => {
    const withDeps: ThreadRecord = mkRec('t-2', 2, 'queued', { title: 'Twin', dependsOn: ['t-1'], pendingInput: ['x'] });
    const withoutDeps: ThreadRecord = mkRec('t-2', 2, 'queued', { title: 'Twin', pendingInput: ['x'] });

    const renderedWith = renderThreadsSection([withDeps]);
    assert.ok(renderedWith.includes('- t-2 — Twin (queued, waiting on t-1, +1 queued)'));

    const renderedWithout = renderThreadsSection([withoutDeps]);
    assert.ok(renderedWithout.includes('- t-2 — Twin (queued, +1 queued)'));
    assert.ok(!renderedWithout.includes('waiting on'));
  });

  it('handleOrchestratorCommand appends the waiting-on suffix at the end, only for queued+dependsOn', () => {
    const state: ConversationState = { chat_id: CHAT_ID, last_update_id: 0, thread_id: THREAD_ID, turns: [] };
    const withDeps: ThreadRecord = mkRec('t-2', 2, 'queued', { title: 'Twin', dependsOn: ['t-1'] });
    const withoutDeps: ThreadRecord = mkRec('t-2', 2, 'queued', { title: 'Twin' });

    const withResult = handleOrchestratorCommand('/orchestrator status', state, [withDeps]);
    assert.ok(withResult.response.includes('waiting on t-1'));
    assert.ok(withResult.response.trim().endsWith('waiting on t-1'), 'suffix must be at the end of the line');

    const withoutResult = handleOrchestratorCommand('/orchestrator status', state, [withoutDeps]);
    assert.ok(!withoutResult.response.includes('waiting on'));
  });
});

describe('S14 — handleSpawn honors model-declared depends_on', () => {
  it('a declared dep parks the spawn until the dependency reaches done (no twin involved)', async () => {
    writeFakeWorker('unused'); // a fire must not happen while parked; if one ever did, it settles safely
    const dep = await createThread(KEY, { title: 'Shared', goal: 'the shared subproblem', workdir });
    assert.ok(dep.ok);
    if (!dep.ok) return;

    const footer = await handleSpawn(makeSpawnArgs({
      spawn: { title: 'Dependent', prompt: 'a genuinely different goal', dependsOn: [dep.thread.id] },
    }));

    // No twin (different goal) → the generic queued footer; the park is the
    // declared dependency, not the running cap.
    assert.equal(footer, `\n\n_(Thread t-2 queued — starts when one finishes.)_`);
    const rec = await getThread(KEY, 't-2');
    assert.equal(rec?.status, 'queued');
    assert.deepEqual(rec?.dependsOn, ['t-1']);

    // End-to-end: still parked while t-1 runs; starts once t-1 is done (S3 idiom).
    assert.deepEqual((await claimThreadStarts(KEY)).map((r) => r.id), []);
    await updateThread(KEY, dep.thread.id, { status: 'done' });
    assert.deepEqual((await claimThreadStarts(KEY)).map((r) => r.id), ['t-2']);
    assert.equal((await getThread(KEY, 't-2'))?.status, 'running');
  });

  it('declared ids that match nothing degrade to a plain spawn (store sanitizer)', async () => {
    writeFakeWorker('solo output');
    const footer = await handleSpawn(makeSpawnArgs({
      spawn: { title: 'Solo', prompt: 'solo goal with an unknown dep', dependsOn: ['t-99'] },
    }));

    const rec = await getThread(KEY, 't-1');
    assert.equal(rec?.dependsOn, undefined, 'an id matching no record must not park the spawn');
    if (rec?.status === 'running') {
      assert.equal(footer, `\n\n_(Thread t-1 spawned: Solo — its result arrives in this topic when it finishes.)_`);
    } else {
      assert.equal(rec?.status, 'queued');
      assert.equal(footer, `\n\n_(Thread t-1 queued — starts when one finishes.)_`);
    }
    await _waitForThreadExecutionsForTest(); // drain the fired dispatch before teardown
  });

  it('a declared dep that is already done is kept and does not park the spawn', async () => {
    writeFakeWorker('dependent output');
    const dep = await createThread(KEY, { title: 'First', goal: 'first goal', workdir });
    assert.ok(dep.ok);
    if (!dep.ok) return;
    await updateThread(KEY, dep.thread.id, { status: 'done' });

    const footer = await handleSpawn(makeSpawnArgs({
      spawn: { title: 'Next', prompt: 'depends on finished work', dependsOn: [dep.thread.id] },
    }));
    assert.ok(footer.includes('Thread t-2'));

    const rec = await getThread(KEY, 't-2');
    assert.deepEqual(rec?.dependsOn, ['t-1'], 'a satisfiable declared dep is persisted, not dropped');
    assert.notEqual(rec?.status, 'queued', 'a satisfied dependency must not park the spawn');
    await _waitForThreadExecutionsForTest();
  });
});

describe('S15 — union of the twin dedup and model-declared deps', () => {
  it('a twin PLUS a declared dep unions with the twin first, footer stays the twin footer', async () => {
    writeFakeWorker('unused');
    const twin = await createThread(KEY, { title: 'Original', goal: 'Sweep the logs.', workdir });
    assert.ok(twin.ok);
    if (!twin.ok) return;
    const other = await createThread(KEY, { title: 'Other', goal: 'another prerequisite', workdir });
    assert.ok(other.ok);
    if (!other.ok) return;

    const footer = await handleSpawn(makeSpawnArgs({
      spawn: { title: 'Twin', prompt: '  sweep  THE logs!! ', dependsOn: [other.thread.id] },
    }));

    assert.equal(
      footer,
      `\n\n_(Thread t-3 queued behind t-1 (exact goal match) — it starts automatically when t-1 finishes and receives its result. Steer or /stop it if that is wrong.)_`
    );
    const rec = await getThread(KEY, 't-3');
    assert.equal(rec?.status, 'queued');
    assert.deepEqual(rec?.dependsOn, ['t-1', 't-2'], 'twin first, declared after — no duplicate');
  });

  it('declaring the twin itself does not duplicate the id', async () => {
    writeFakeWorker('unused');
    const seeded = await createThread(KEY, { title: 'Original', goal: 'Sweep the logs.', workdir });
    assert.ok(seeded.ok);
    if (!seeded.ok) return;

    const footer = await handleSpawn(makeSpawnArgs({
      spawn: { title: 'Twin', prompt: '  sweep  THE logs!! ', dependsOn: ['t-1'] },
    }));

    assert.equal(
      footer,
      `\n\n_(Thread t-2 queued behind t-1 (exact goal match) — it starts automatically when t-1 finishes and receives its result. Steer or /stop it if that is wrong.)_`
    );
    const rec = await getThread(KEY, 't-2');
    assert.deepEqual(rec?.dependsOn, ['t-1'], 'declaring the twin itself must not yield t-1 twice');
  });
});
