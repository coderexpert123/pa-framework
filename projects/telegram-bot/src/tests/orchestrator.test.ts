/**
 * AI-203 WP-2 — orchestrator module unit tests: §4.4 validators, section
 * renderer, action stripping, §4.6 prompt pins, the executionMode=false parse
 * choice, dispatch validation downgrades + cancellation, and the store-only
 * spawn/steer footer paths (the executor-fire paths are pinned end-to-end by
 * WP-5's processUpdate tests, T1/T2 — a unit test here would drive the REAL
 * runWithFailover, which no unit test may do).
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmRetry } from './rm-retry.js';
import type { ConversationState, SessionInfo } from '../types.js';
import type { ThreadRecord } from '../topic-threads.js';

let sharedTempDir = '';
let threadsDir = '';

before(async () => {
  sharedTempDir = await mkdtemp(join(tmpdir(), 'orch-test-'));
  process.env.PA_HOME = sharedTempDir;
  threadsDir = join(sharedTempDir, 'topic-threads');
  await writeFile(join(sharedTempDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
  await writeFile(join(sharedTempDir, 'rate-limit-state.json'), '{}', 'utf8');
  // Minimal worker set; these commands are NEVER executed by this file (all
  // dispatch tests run through the injected seams).
  await writeFile(
    join(sharedTempDir, 'config.yaml'),
    JSON.stringify({
      workers: [
        {
          name: 'test-worker',
          command: 'node',
          args: ['-e', 'process.exit(1)'],
          input_mode: 'stdin-text',
          output_format: 'text',
          check: 'echo ok',
          rate_limit_patterns: [],
          priority: 1,
          state_dir: '/nonexistent/path',
          state_pattern: '*.jsonl',
        },
      ],
    }),
    'utf8'
  );
  await mkdir(threadsDir, { recursive: true });
});

after(async () => {
  delete process.env.PA_HOME;
  await rmRetry(sharedTempDir);
});

// Dynamic imports after PA_HOME is set (dispatch-error-paths.test.ts pattern).
const {
  validateSpawnThreadAction,
  validateSteerThreadAction,
  isOrchestratorMode,
  stripOrchestratorActions,
  renderThreadsSection,
  buildOrchestratorPrompt,
  buildOrchestratorResumedPrompt,
  dispatchOrchestratorTurn,
  handleSpawn,
  handleSteer,
  emitThreadEvent,
} = await import('../orchestrator.js');
const { createThread, _clearThreadsForTest, _setStoreDirForTest } = await import('../topic-threads.js');

const CHAT_ID = -1001234567890;
const THREAD_ID = 5001;
const TOPIC_KEY = `${CHAT_ID}_${THREAD_ID}`;

beforeEach(() => {
  // Fresh store DIR per test: the thread store persists to a FILE, so resetting
  // the mutex + dir pointer alone would let one test's records saturate the
  // 2-running cap for the next (T-19 → T-20/T-21 failed exactly this way).
  threadsDir = mkdtempSync(join(tmpdir(), 'orch-th-'));
  _setStoreDirForTest(threadsDir);
  _clearThreadsForTest();
});

afterEach(() => {
  _setStoreDirForTest(undefined);
  rmSync(threadsDir, { recursive: true, force: true });
});

function makeState(extra: Partial<ConversationState> = {}): ConversationState {
  return { chat_id: CHAT_ID, last_update_id: 0, thread_id: THREAD_ID, turns: [], ...extra };
}

let threadSeq = 0;
function makeThread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  const now = new Date().toISOString();
  threadSeq += 1;
  return {
    id: `t-${threadSeq}`,
    n: threadSeq,
    title: 'Sweep logs',
    goal: 'sweep the logs',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    workdir: 'C:/pa-test-workdir',
    runSeq: 0,
    attempts: 0,
    pendingInput: [],
    ...overrides,
  };
}

function okResult(output: string) {
  return { success: true, output, exitCode: 0 } as any;
}

describe('validateSpawnThreadAction', () => {
  it('T-1: ok shape trims title and prompt', () => {
    const v = validateSpawnThreadAction({ type: 'spawn_thread', title: '  Sweep logs  ', prompt: '  do the sweep  ' });
    assert.ok(v.ok);
    assert.equal(v.title, 'Sweep logs');
    assert.equal(v.prompt, 'do the sweep');
  });

  it('T-2: rejects empty and >80 title', () => {
    assert.ok(!validateSpawnThreadAction({ type: 'spawn_thread', title: '   ', prompt: 'p' }).ok);
    assert.ok(!validateSpawnThreadAction({ type: 'spawn_thread', title: 'x'.repeat(81), prompt: 'p' }).ok);
  });

  it('T-3: rejects empty and >4000 prompt', () => {
    assert.ok(!validateSpawnThreadAction({ type: 'spawn_thread', title: 't', prompt: '   ' }).ok);
    assert.ok(!validateSpawnThreadAction({ type: 'spawn_thread', title: 't', prompt: 'y'.repeat(4001) }).ok);
  });
});

describe('validateSteerThreadAction', () => {
  it('T-4: running thread steers with queued true; done thread with queued false', () => {
    const running = makeThread({ id: 't-1', n: 1, status: 'running' });
    const vRun = validateSteerThreadAction({ type: 'steer_thread', thread_id: 't-1', message: 'go faster' }, [running]);
    assert.ok(vRun.ok);
    assert.equal(vRun.queued, true);
    const done = makeThread({ id: 't-2', n: 2, status: 'done', lastResult: 'it worked' });
    const vDone = validateSteerThreadAction({ type: 'steer_thread', thread_id: 't-2', message: 'now extend it' }, [done]);
    assert.ok(vDone.ok);
    assert.equal(vDone.queued, false);
  });

  it('T-5: bad format, unknown id, cancelled, pending-full, message bounds', () => {
    const base = makeThread({ id: 't-1', n: 1 });
    assert.ok(!validateSteerThreadAction({ type: 'steer_thread', thread_id: 't3', message: 'm' }, [base]).ok);
    assert.ok(!validateSteerThreadAction({ type: 'steer_thread', thread_id: 'x-1', message: 'm' }, [base]).ok);
    assert.ok(!validateSteerThreadAction({ type: 'steer_thread', thread_id: 't-9', message: 'm' }, [base]).ok);
    const cancelled = makeThread({ id: 't-2', n: 2, status: 'cancelled' });
    assert.ok(!validateSteerThreadAction({ type: 'steer_thread', thread_id: 't-2', message: 'm' }, [cancelled]).ok);
    const full = makeThread({ id: 't-3', n: 3, pendingInput: ['a', 'b', 'c', 'd', 'e'] });
    assert.ok(!validateSteerThreadAction({ type: 'steer_thread', thread_id: 't-3', message: 'm' }, [full]).ok);
    assert.ok(!validateSteerThreadAction({ type: 'steer_thread', thread_id: 't-1', message: '   ' }, [base]).ok);
    assert.ok(!validateSteerThreadAction({ type: 'steer_thread', thread_id: 't-1', message: 'z'.repeat(4001) }, [base]).ok);
  });
});

describe('renderThreadsSection', () => {
  it('T-6: empty store renders (none yet)', () => {
    const s = renderThreadsSection([]);
    assert.ok(s.startsWith('## Execution threads'));
    assert.ok(s.includes('(none yet)'));
  });

  it('T-7: done excerpt capped at 400 chars, newest first', () => {
    const long = 'a'.repeat(500);
    const threads = [
      makeThread({ id: 't-2', n: 2, status: 'done', lastResult: long }),
      makeThread({ id: 't-1', n: 1, status: 'running' }),
    ];
    const s = renderThreadsSection(threads);
    assert.ok(s.includes('a'.repeat(400)));
    assert.ok(!s.includes('a'.repeat(401)));
    assert.ok(s.indexOf('t-2') < s.indexOf('t-1'));
  });

  it('T-8: >8 rendered collapses with the frozen overflow line', () => {
    const threads: ThreadRecord[] = [];
    for (let i = 1; i <= 10; i++) threads.push(makeThread({ id: `t-${i}`, n: i, status: 'done', lastResult: 'ok' }));
    const s = renderThreadsSection(threads);
    assert.equal((s.match(/^- t-/gm) ?? []).length, 8);
    assert.ok(s.includes('(+2 older threads — pa topic-threads summary omitted)'));
  });

  it('T-9: running with queued input, failed with 80-char error cap, cancelled', () => {
    const threads = [
      makeThread({ id: 't-1', n: 1, status: 'running', pendingInput: ['a', 'b'] }),
      makeThread({ id: 't-2', n: 2, status: 'failed', lastError: 'e'.repeat(120) }),
      makeThread({ id: 't-3', n: 3, status: 'cancelled' }),
    ];
    const s = renderThreadsSection(threads);
    assert.ok(s.includes('- t-1 — Sweep logs (running, +2 queued)'));
    assert.ok(s.includes(`- t-2 — Sweep logs (failed: ${'e'.repeat(80)})`));
    assert.ok(!s.includes('e'.repeat(81)));
    assert.ok(s.includes('- t-3 — Sweep logs (cancelled)'));
  });
});

describe('stripOrchestratorActions', () => {
  it('T-10: removes spawn+steer, keeps watch_job; null-safe', () => {
    const meta = {
      actions: [
        { type: 'spawn_thread', title: 'T', prompt: 'P' },
        { type: 'watch_job', description: 'd', check: { type: 'file_exists', path: 'C:/x' } },
        { type: 'steer_thread', thread_id: 't-1', message: 'm' },
      ],
    };
    const stripped = stripOrchestratorActions(meta as any);
    assert.ok(stripped);
    assert.deepEqual(stripped.actions.map((a) => a.type), ['watch_job']);
    assert.equal(stripOrchestratorActions(null), null);
  });

  it('T-11: isOrchestratorMode gates on === true only', () => {
    assert.equal(isOrchestratorMode(makeState({ orchestrator_enabled: true })), true);
    assert.equal(isOrchestratorMode(makeState()), false);
    assert.equal(isOrchestratorMode(makeState({ orchestrator_enabled: false })), false);
  });
});

describe('prompt pins (§4.6)', () => {
  it('T-12: fresh prompt carries the frozen sections, metadata ids, no Capabilities', async () => {
    const prompt = await buildOrchestratorPrompt('do the thing', makeState(), [makeThread({ id: 't-1', n: 1 })]);
    assert.ok(prompt.includes('You are the orchestrator for a Telegram forum topic'));
    assert.ok(prompt.includes('## Execution threads'));
    assert.ok(prompt.includes('## Your role'));
    assert.ok(prompt.includes('[PA_META]:'));
    assert.ok(prompt.includes(`Chat ID: ${CHAT_ID}`));
    assert.ok(prompt.includes(`Thread ID: ${THREAD_ID}`));
    assert.ok(prompt.includes('- t-1 — Sweep logs (running)'));
    assert.ok(!prompt.includes('## Capabilities'));
    assert.ok(!prompt.includes('## Standing rules'));
    assert.ok(!prompt.includes('## Open items'));
  });

  it('T-13: fresh prompt renders brain+recall pointer lines when present', async () => {
    const prompt = await buildOrchestratorPrompt('hi', makeState(), []);
    assert.ok(prompt.includes('Recall: `pa recall'));
  });

  it('T-14: resumed prompt = buildResumedPrompt shape + threads section + spawn sentence', async () => {
    const prompt = await buildOrchestratorResumedPrompt('yes', undefined, 'the sweep plan', [makeThread()]);
    assert.ok(prompt.startsWith('## Context Update'));
    assert.ok(prompt.includes('## Pending Confirmation'));
    assert.ok(prompt.includes('Emit the spawn_thread action for it now (self-contained prompt).'));
    assert.ok(!prompt.includes('Execute it now.'));
    assert.ok(prompt.includes('## Execution threads'));
    assert.ok(prompt.includes('## Current Message\nyes'));
  });
});

describe('dispatchOrchestratorTurn (seam-driven)', () => {
  function baseArgs(overrides: Record<string, unknown> = {}) {
    return {
      userText: 'route this',
      topicState: makeState(),
      secrets: {},
      resourceId: `topic-${TOPIC_KEY}`,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      defaultWorker: 'test-worker',
      ...overrides,
    };
  }

  it('T-15: executionMode=false pin — pendingDesc turn with a spawn envelope keeps meta', async () => {
    const dr = await dispatchOrchestratorTurn(
      baseArgs({
        pendingDesc: 'the confirmed plan',
        failover: async () => ({
          worker: 'test-worker',
          result: okResult(
            'Routing to a spawned thread (t-1).\n\n[PA_META]: {"actions":[{"type":"spawn_thread","title":"T","prompt":"P"}]}'
          ),
        }),
      })
    );
    assert.ok(dr.meta, 'meta must survive an execution-mode-parse of a confirmed turn');
    assert.deepEqual(dr.meta.actions, []);
    assert.ok(dr.spawn);
    assert.equal(dr.spawn!.title, 'T');
    assert.equal(dr.spawn!.prompt, 'P');
    assert.ok(dr.response.includes('Routing to a spawned thread (t-1).'));
  });

  it('T-16: invalid spawn action downgrades to a rejected line, spawn stays null', async () => {
    const dr = await dispatchOrchestratorTurn(
      baseArgs({
        failover: async () => ({
          worker: 'test-worker',
          result: okResult(
            `Trying to spawn.\n\n[PA_META]: {"actions":[{"type":"spawn_thread","title":"${'X'.repeat(81)}","prompt":"P"}]}`
          ),
        }),
      })
    );
    assert.equal(dr.spawn, null);
    assert.ok(dr.response.includes('_(thread spawn rejected: title must be 1..80 chars)_'));
  });

  it('T-17: cancellation exit returns the empty workerError shape with session unchanged', async () => {
    const sentinel: SessionInfo = { session_id: 's-1', worker: 'test-worker', started_at: new Date().toISOString() };
    const dr = await dispatchOrchestratorTurn(
      baseArgs({ topicState: makeState({ session: sentinel }), isCancelled: () => true })
    );
    assert.equal(dr.response, '');
    assert.equal(dr.workerError, true);
    assert.equal(dr.session, sentinel);
    assert.equal(dr.meta, null);
    assert.equal(dr.spawn, null);
  });

  it('T-18: premature promise WITHOUT an envelope suppresses into the worker-error path', async () => {
    const dr = await dispatchOrchestratorTurn(
      baseArgs({
        failover: async () => ({
          worker: 'test-worker',
          result: okResult('I have launched the sweep and will report back when it completes.'),
        }),
      })
    );
    assert.ok(dr.response.startsWith('⚠️'));
    assert.ok(dr.response.includes('returned an empty response.'));
    assert.equal(dr.workerError, true);
  });
});

describe('handleSpawn / handleSteer footer paths (store-only; no executor fire)', () => {
  it('T-19: running-cap rejection returns the frozen cap footer, no record created', async () => {
    for (const title of ['one', 'two']) {
      const r = await createThread(TOPIC_KEY, { title, goal: 'g', workdir: 'C:/w' });
      assert.ok(r.ok);
    }
    const footer = await handleSpawn({
      topicKey: TOPIC_KEY,
      topicName: 'Test topic',
      spawn: { title: 'third', prompt: 'g' },
      secrets: {},
      token: '',
      workdir: 'C:/w',
    });
    assert.equal(footer, '\n\n_(thread spawn rejected: 2 threads already running — steer one or wait.)_');
    assert.equal(await (await import('../topic-threads.js')).listThreads(TOPIC_KEY).then((l) => l.length), 2);
  });

  it('T-20: steer to a RUNNING thread queues the input and returns the queued footer', async () => {
    const created = await createThread(TOPIC_KEY, { title: 'Sweep', goal: 'g', workdir: 'C:/w' });
    assert.ok(created.ok);
    const footer = await handleSteer({
      topicKey: TOPIC_KEY,
      topicName: 'Test topic',
      steer: { thread: created.thread, message: 'also check stderr', queued: true },
      secrets: {},
      token: '',
      workdir: 'C:/w',
    });
    assert.equal(footer, '\n\n_(Queued for thread t-1 — delivered when its current run finishes.)_');
    const store = await import('../topic-threads.js');
    const rec = await store.getThread(TOPIC_KEY, 't-1');
    assert.deepEqual(rec?.pendingInput, ['also check stderr']);
    // T-B3b: the queued steer emitted thread_steered through the handler to
    // the REAL topic-events jsonl under PA_HOME.
    const raw = readFileSync(join(process.env.PA_HOME!, 'topic-events', `${TOPIC_KEY}.jsonl`), 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as { kind: string; ref: string | null; detail: string });
    const steered = lines.find((e) => e.kind === 'thread_steered');
    assert.ok(steered, 'thread_steered event present');
    assert.equal(steered.ref, 't-1');
    assert.equal(steered.detail, 'queued: Sweep');
  });

  it('T-21: steer to a CANCELLED thread is rejected before any store write', async () => {
    const store = await import('../topic-threads.js');
    const created = await createThread(TOPIC_KEY, { title: 'Doomed', goal: 'g', workdir: 'C:/w' });
    assert.ok(created.ok);
    await store.updateThread(TOPIC_KEY, 't-1', { status: 'cancelled' });
    const footer = await handleSteer({
      topicKey: TOPIC_KEY,
      topicName: 'Test topic',
      steer: { thread: created.thread, message: 'm', queued: false },
      secrets: {},
      token: '',
      workdir: 'C:/w',
    });
    assert.equal(footer, '\n\n_(steer rejected: thread t-1 is cancelled)_');
    const rec = await store.getThread(TOPIC_KEY, 't-1');
    assert.deepEqual(rec?.pendingInput, []);
  });
});

describe('emitThreadEvent (helper unit)', () => {
  it('T-B3a: a well-formed key emits to the real jsonl and returns true; a malformed key returns false and writes nothing', async () => {
    const ok = await emitThreadEvent('-1001234567890_5001', { kind: 'thread_spawned', ref: 't-1', detail: 'Sweep logs' });
    assert.equal(ok, true);
    const raw = readFileSync(join(process.env.PA_HOME!, 'topic-events', '-1001234567890_5001.jsonl'), 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as { kind: string; ref: string | null; detail: string });
    const spawned = lines.find((e) => e.kind === 'thread_spawned' && e.ref === 't-1' && e.detail === 'Sweep logs');
    assert.ok(spawned, 'thread_spawned line landed in the real jsonl');

    const bad = await emitThreadEvent('not-a-key', { kind: 'thread_spawned', ref: 't-2', detail: 'x' });
    assert.equal(bad, false);
    assert.equal(existsSync(join(process.env.PA_HOME!, 'topic-events', 'not-a-key.jsonl')), false);
  });
});
