/**
 * AI-203 WP-2 — orchestrator module unit tests: §4.4 validators, section
 * renderer, action stripping, §4.6 prompt pins, the executionMode=false parse
 * choice, dispatch validation downgrades + cancellation, and the spawn/steer
 * footer paths. Increment 4: the handlers fire the REAL executor (there is no
 * dispatch seam through fireThreadExecution), so the fire-path tests install a
 * STALLED globalThis.fetch double (see stallFyiSends) — the executor parks at
 * its pickup-FYI send, BEFORE any dispatch, so no real worker spawns, no real
 * network fires, and the store state the handler left is exactly what the
 * assertions read. Full end-to-end behavior (real dispatch settle, queue wake)
 * stays pinned by the processUpdate tests in orchestrator-dispatch.test.ts.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmRetry } from './rm-retry.js';
import { logger } from '../../../../pa/dist/src/lib/log.js';
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
  resolveThreadFyiAnchor,
  handleAnchorSteerReply,
  emitThreadEvent,
  SPAWN_PROMPT_MAX_CHARS,
} = await import('../orchestrator.js');
const { createThread, _clearThreadsForTest, _setStoreDirForTest } = await import('../topic-threads.js');
const { drainVoiceInboxRoutes } = await import('../voice-inbox-bridge.js');

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

  // WP-7 (OD-4): the optional model pin — wider grammar than worker (dots
  // allowed, ≤64), same reject-not-coerce rule; absent ⇒ no `model` key.
  it('T-4: model pin — valid rides, malformed rejects, absent omits the key', () => {
    const ok = validateSpawnThreadAction({ type: 'spawn_thread', title: 't', prompt: 'p', model: 'claude-sonnet-4.6' });
    assert.ok(ok.ok);
    assert.equal(ok.model, 'claude-sonnet-4.6');
    for (const bad of ['bad model!', 'has space', 'x'.repeat(65), 42, {}]) {
      const v = validateSpawnThreadAction({ type: 'spawn_thread', title: 't', prompt: 'p', model: bad as unknown as string });
      assert.ok(!v.ok, `model ${JSON.stringify(bad)} must reject`);
      assert.equal(v.ok ? '' : v.reason, 'model must match /^[a-zA-Z0-9._-]{1,64}$/ when present');
    }
    const none = validateSpawnThreadAction({ type: 'spawn_thread', title: 't', prompt: 'p' });
    assert.ok(none.ok);
    assert.ok(!('model' in none), 'absent model must not produce a model key');
  });
});

describe('validateSteerThreadAction', () => {
  it('T-V1: mode defaults to queue; only the two literals are accepted (increment 4)', () => {
    const running = makeThread({ id: 't-1', n: 1, status: 'running' });
    for (const mode of [undefined, '', 'queue']) {
      const v = validateSteerThreadAction({ type: 'steer_thread', thread_id: 't-1', message: 'm', mode }, [running]);
      assert.ok(v.ok);
      assert.equal(v.mode, 'queue');
    }
    const vInt = validateSteerThreadAction({ type: 'steer_thread', thread_id: 't-1', message: 'm', mode: 'interrupt' }, [running]);
    assert.ok(vInt.ok);
    assert.equal(vInt.mode, 'interrupt');
    for (const bad of ['Interrupt', 'kill', 5]) {
      const vBad = validateSteerThreadAction({ type: 'steer_thread', thread_id: 't-1', message: 'm', mode: bad as unknown as string }, [running]);
      assert.ok(!vBad.ok);
      assert.equal(vBad.ok ? '' : vBad.reason, 'mode must be "queue" or "interrupt"');
    }
  });

  it('T-V2: queued semantics — running and queued-status wait, done starts, cancelled rejects (increment 4)', () => {
    const running = makeThread({ id: 't-1', n: 1, status: 'running' });
    const vRun = validateSteerThreadAction({ type: 'steer_thread', thread_id: 't-1', message: 'go faster' }, [running]);
    assert.ok(vRun.ok);
    assert.equal(vRun.queued, true);
    const parked = makeThread({ id: 't-3', n: 3, status: 'queued' });
    const vParked = validateSteerThreadAction({ type: 'steer_thread', thread_id: 't-3', message: 'm' }, [parked]);
    assert.ok(vParked.ok);
    assert.equal(vParked.queued, true);
    const done = makeThread({ id: 't-2', n: 2, status: 'done', lastResult: 'it worked' });
    const vDone = validateSteerThreadAction({ type: 'steer_thread', thread_id: 't-2', message: 'now extend it' }, [done]);
    assert.ok(vDone.ok);
    assert.equal(vDone.queued, false);
    const cancelled = makeThread({ id: 't-4', n: 4, status: 'cancelled' });
    assert.ok(!validateSteerThreadAction({ type: 'steer_thread', thread_id: 't-4', message: 'm' }, [cancelled]).ok);
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
    assert.ok(s.includes('(+2 older threads omitted)'));
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

  it('T-REN1: a queued record renders the queued branch — bare and with the +k suffix (increment 4)', () => {
    const s = renderThreadsSection([
      makeThread({ id: 't-2', n: 2, title: 'Parked work', status: 'queued' }),
      makeThread({ id: 't-1', n: 1, status: 'queued', pendingInput: ['x'] }),
    ]);
    assert.ok(s.includes('- t-2 — Parked work (queued)'));
    assert.ok(s.includes('- t-1 — Sweep logs (queued, +1 queued)'));
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

  it('AI-234: stripOrchestratorActions preserves suggested_items on the envelope', () => {
    const meta = {
      actions: [
        { type: 'spawn_thread', title: 'T', prompt: 'P' },
        { type: 'watch_job', description: 'd', check: { type: 'file_exists', path: 'C:/x' } },
      ],
      suggested_items: ['Tell me more', 'Yes'],
    };
    const stripped = stripOrchestratorActions(meta as any);
    assert.ok(stripped);
    assert.deepEqual(stripped.actions.map((a) => a.type), ['watch_job']);
    assert.deepEqual(stripped.suggested_items, ['Tell me more', 'Yes'], 'suggested_items must survive stripping');
  });

  it('T-11: isOrchestratorMode is default-ON — keyless topic orchestrates; only explicit false opts out (AI-215)', () => {
    // AI-215: the predicate inverted from `=== true` (opt-in) to `!== false`
    // (default-on, explicit-false opt-out). A keyless topic state (the
    // common case — new branches, freshly created topics, never-touched
    // topics) now routes through the orchestrator lane by default.
    assert.equal(isOrchestratorMode(makeState({ orchestrator_enabled: true })), true, 'explicit opt-in still works');
    assert.equal(isOrchestratorMode(makeState()), true, 'a keyless topic state must default to orchestrator mode');
    assert.equal(isOrchestratorMode(makeState({ orchestrator_enabled: false })), false, 'explicit false is the opt-out');
  });
});

describe('prompt pins (§4.6)', () => {
  it('T-12: fresh prompt carries the frozen sections, metadata ids, no Capabilities', async () => {
    const prompt = await buildOrchestratorPrompt('do the thing', makeState(), [makeThread({ id: 't-1', n: 1 })]);
    assert.ok(prompt.includes('You are the orchestrator for a Telegram forum topic'));
    assert.ok(prompt.includes('## Execution threads'));
    assert.ok(prompt.includes('## Your role'));
    // AI-235 WP-1: the orchestrator lane now carries a plain-language
    // answer-register bullet (the TASK lane already had it in context.ts /
    // task-executor.ts TASK_RULES), and the worked example no longer cites
    // the internal thread id (t-3) in ordinary chat.
    assert.ok(prompt.includes('plain product language'), 'the fresh prompt must carry the plain-language answer-register bullet');
    assert.ok(!prompt.includes('"Spawning a thread to sweep the logs (t-3)"'), 'the old id-citing worked example must be gone');
    assert.ok(prompt.includes('[PA_META]:'));
    assert.ok(prompt.includes(`Chat ID: ${CHAT_ID}`));
    assert.ok(prompt.includes(`Thread ID: ${THREAD_ID}`));
    assert.ok(prompt.includes('- t-1 — Sweep logs (running)'));
    assert.ok(!prompt.includes('## Capabilities'));
    assert.ok(!prompt.includes('## Standing rules'));
    assert.ok(!prompt.includes('## Open items'));
    // Regression pin (2026-09-09 live incident): the fresh prompt must carry
    // the user's actual message. It never did — buildOrchestratorPrompt built
    // topic/threads/role scaffolding but never interpolated its own
    // `userMessage` parameter anywhere, so every fresh (first-turn/unresumable)
    // orchestrator dispatch reached the worker with no user content at all.
    // Voice-inbox route dispatches always land on a topic's first-ever turn,
    // so they hit this every time — the worker replied it saw "just system
    // context", which is exactly what it was given.
    assert.ok(prompt.includes('## Current Message\ndo the thing'), 'the fresh prompt must include the user\'s actual message');
    // The Execution threads heading must appear exactly once — renderThreadsSection
    // already emits it; the fresh template must not prepend a second copy.
    assert.equal(prompt.split('## Execution threads').length - 1, 1, 'the Execution threads heading must not be duplicated');
  });

  it('T-13: fresh prompt renders recall+decisions pointers in spawn-voice (tool-less lane)', async () => {
    const prompt = await buildOrchestratorPrompt('hi', makeState(), []);
    // Orchestrator has NO tools — the pointers delegate retrieval to a spawned
    // thread, never command the orchestrator to run pa itself.
    assert.ok(prompt.includes('Recall: you cannot run commands'), 'recall pointer uses spawn-voice framing');
    assert.ok(prompt.includes('Precedent: you cannot run commands'), 'decisions pointer present in spawn-voice');
    assert.ok(prompt.includes('spawn a thread'), 'pointers delegate through spawned threads');
    assert.ok(prompt.includes(`--thread ${THREAD_ID}`), 'pointers carry the topic thread id');
    assert.ok(
      !prompt.includes('Recall: `pa recall "<terms>"'),
      'the tool-less lane must not get the worker imperative form'
    );
  });

  it('T-13b: declared sources render as a NAMES-ONLY pointer — the tool-less lane never sees the full section', async () => {
    const state = makeState({
      sources: [
        { path: 'D:/somewhere/grounding.md', label: 'grounding doc' },
        { path: 'D:/somewhere/other.md' }, // no label → basename
      ],
    });
    const prompt = await buildOrchestratorPrompt('hi', state, []);
    assert.ok(prompt.includes('Topic sources: grounding doc, other.md'), 'names join on the ## Topic line');
    assert.ok(prompt.includes('grounded questions on them go to a thread'), 'the pointer delegates to a spawned thread');
    assert.ok(!prompt.includes('## Topic sources'), 'the full section must never leak onto this lane');
    // No sources → no pointer at all (absent, not an empty stub).
    const bare = await buildOrchestratorPrompt('hi', makeState(), []);
    assert.ok(!bare.includes('Topic sources:'), 'absent sources render nothing');
  });

  it('T-13c: this lane offers run_skill ⇒ the live skill roster renders between ## Your role and ## PA_META', async () => {
    const { _resetSkillRosterCache } = await import('../context.js');
    _resetSkillRosterCache();
    const skillDir = join(sharedTempDir, 'skills', 'fixture-orch-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'skill.md'), ['---', 'description: "orch fixture capability"', '---', 'Body.'].join('\n'), 'utf8');

    const prompt = await buildOrchestratorPrompt('hi', makeState(), []);
    const rosterIdx = prompt.indexOf('## Skills you can trigger');
    assert.ok(rosterIdx > 0, 'roster section present');
    assert.ok(prompt.includes('[fixture-orch-skill] orch fixture capability'), 'roster line present');
    assert.ok(rosterIdx > prompt.indexOf('## Your role'), 'roster lands after the role bullets');
    assert.ok(rosterIdx < prompt.indexOf('## PA_META'), 'roster lands before ## PA_META');
    _resetSkillRosterCache();
  });

  it('AI-234: fresh prompt teaches suggested_items in the PA_META block', async () => {
    const prompt = await buildOrchestratorPrompt('hi', makeState(), []);
    // The wire example line must include suggested_items in the JSON shape.
    assert.ok(prompt.includes('"suggested_items"'), 'PA_META wire example must show suggested_items');
    // The teaching bullet must explain the contract.
    assert.ok(prompt.includes('- suggested_items:'), 'PA_META block must have a suggested_items bullet');
    assert.ok(prompt.includes('plain product words only'), 'the bullet must say plain product words only');
    assert.ok(prompt.includes('<=40 chars'), 'the bullet must state the 40-char cap');
    assert.ok(prompt.includes('0..4'), 'the bullet must state the 0..4 count');
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

  it('T-PROMPT1: fresh prompt carries the increment-4 mode + park prompt deltas', async () => {
    const prompt = await buildOrchestratorPrompt('do the thing', makeState(), [makeThread({ id: 't-1', n: 1 })]);
    assert.ok(prompt.includes('pick mode per message'));
    assert.ok(prompt.includes('mode "queue"|"interrupt"'));
    assert.ok(prompt.includes('steer_thread{thread_id,message,mode}'));
    assert.ok(prompt.includes('the spawn parks and starts automatically'));
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
    assert.equal(dr.routes.length, 1);
    assert.equal(dr.routes[0].kind, 'spawn');
    assert.deepEqual(dr.routes[0], { kind: 'spawn', title: 'T', prompt: 'P' });
    assert.ok(dr.response.includes('Routing to a spawned thread (t-1).'));
  });

  it('T-16: invalid spawn action downgrades to a rejected line, no route is pushed', async () => {
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
    assert.deepEqual(dr.routes, []);
    assert.ok(dr.response.includes('_(thread spawn rejected: title must be 1..80 chars)_'));
  });

  it('T-FAN1: one envelope with N spawns + N steers routes all of them in envelope order (increment 4)', async () => {
    const created = await createThread(TOPIC_KEY, { title: 'Sweep', goal: 'g', workdir: 'C:/w' });
    assert.ok(created.ok);
    const dr = await dispatchOrchestratorTurn(
      baseArgs({
        failover: async () => ({
          worker: 'test-worker',
          result: okResult(
            'Batch routed.\n\n[PA_META]: {"actions":[' +
              '{"type":"spawn_thread","title":"A","prompt":"pa"},' +
              '{"type":"steer_thread","thread_id":"t-1","message":"go faster","mode":"interrupt"},' +
              '{"type":"spawn_thread","title":"B","prompt":"pb"}]}'
          ),
        }),
      })
    );
    assert.equal(dr.routes.length, 3);
    assert.deepEqual(
      dr.routes.map((r) => r.kind),
      ['spawn', 'steer', 'spawn']
    );
    const steer = dr.routes[1];
    assert.ok(steer.kind === 'steer', 'the middle route is the steer');
    assert.equal(steer.thread.id, 't-1');
    assert.equal(steer.message, 'go faster');
    assert.equal(steer.mode, 'interrupt');
    assert.deepEqual(steer, {
      kind: 'steer',
      thread: created.thread,
      message: 'go faster',
      queued: true,
      mode: 'interrupt',
    });
  });

  it('T-FAN2: an invalid mode between two valid actions rejects in place without breaking the fan-out', async () => {
    const created = await createThread(TOPIC_KEY, { title: 'Sweep', goal: 'g', workdir: 'C:/w' });
    assert.ok(created.ok);
    const dr = await dispatchOrchestratorTurn(
      baseArgs({
        failover: async () => ({
          worker: 'test-worker',
          result: okResult(
            'Batch routed.\n\n[PA_META]: {"actions":[' +
              '{"type":"spawn_thread","title":"A","prompt":"pa"},' +
              '{"type":"steer_thread","thread_id":"t-1","message":"m","mode":"kill"},' +
              '{"type":"spawn_thread","title":"B","prompt":"pb"}]}'
          ),
        }),
      })
    );
    assert.equal(dr.routes.length, 2);
    assert.deepEqual(
      dr.routes.map((r) => r.kind),
      ['spawn', 'spawn']
    );
    assert.ok(dr.response.includes('_(steer rejected: mode must be'), `got: ${dr.response}`);
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
    assert.deepEqual(dr.routes, []);
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

  it('AI-249: an unknown action type warns + footnotes and never routes', async () => {
    const origWarn = logger.warn;
    const warnCalls: Array<[string, string, Record<string, unknown> | undefined]> = [];
    logger.warn = (mod: string, msg: string, ctx?: Record<string, unknown>) => {
      warnCalls.push([mod, msg, ctx]);
      return origWarn.call(logger, mod, msg, ctx);
    };
    try {
      const dr = await dispatchOrchestratorTurn(
        baseArgs({
          failover: async () => ({
            worker: 'test-worker',
            result: okResult('Trying to spawn.\n\n[PA_META]: {"actions":[{"type":"T","title":"X","prompt":"P"}]}'),
          }),
        })
      );
      assert.deepEqual(dr.routes, []);
      assert.ok(dr.response.includes("_(action dropped: unknown type 'T')_"), `got: ${dr.response}`);
      const warnCall = warnCalls.find(([mod, msg]) => mod === 'orchestrator' && msg === 'unknown PA_META action type');
      assert.ok(warnCall, 'an unknown action type must warn, not vanish silently');
      assert.equal(warnCall![2]?.type, 'T');
    } finally {
      logger.warn = origWarn;
    }
  });

  it('AI-249: a known downstream type rides through untouched', async () => {
    const dr = await dispatchOrchestratorTurn(
      baseArgs({
        failover: async () => ({
          worker: 'test-worker',
          result: okResult('Done.\n\n[PA_META]: {"actions":[{"type":"confirm_required"}]}'),
        }),
      })
    );
    assert.ok(!dr.response.includes('action dropped'), `got: ${dr.response}`);
    assert.ok(dr.meta?.actions.some((a) => a.type === 'confirm_required'));
  });

  it('AI-249 parity: the downstream set covers every applyMetaActions type', async () => {
    const { PA_META_DOWNSTREAM_TYPES } = await import('../worker-reply.js');
    for (const t of ['restart_bot', 'kb_note', 'watch_job', 'question', 'confirm_required', 'run_skill', 'retry_with_worker']) {
      assert.ok(PA_META_DOWNSTREAM_TYPES.has(t), `${t} must be in the downstream set`);
    }
    for (const t of ['spawn_thread', 'steer_thread']) {
      assert.ok(!PA_META_DOWNSTREAM_TYPES.has(t), `${t} is orchestrator-handled, not downstream`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-09-09 incident (topic 13052): a spawn_thread envelope was present in a
// worker's reply but was never parsed — the model had echoed an absolute
// Windows path verbatim into the JSON, producing lone backslashes JSON.parse
// rejects. No route was created, no rejection footer reached the operator,
// and the bot log carried no line about it: the whole turn silently
// vanished. These fixtures reproduce the SAME DEFECT CLASS with synthetic
// paths/ids (never the real production text — this suite is public-mirrored).
// ---------------------------------------------------------------------------

describe('dispatchOrchestratorTurn: PA_META parse-failure hardening (2026-09-09 incident, topic 13052)', () => {
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

  function lastThreadFailedEvent(): { ts: string; kind: string; ref: string | null; detail: string } | undefined {
    const path = join(process.env.PA_HOME!, 'topic-events', `${TOPIC_KEY}.jsonl`);
    if (!existsSync(path)) return undefined;
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return [...lines].reverse().find((e) => e.kind === 'thread_failed');
  }

  it('an envelope still unparseable after the repair attempt fails LOUDLY: footer + warn log + thread_failed topic event (never silently vanishes)', async () => {
    const origWarn = logger.warn;
    const warnCalls: Array<[string, string, Record<string, unknown> | undefined]> = [];
    logger.warn = (mod: string, msg: string, ctx?: Record<string, unknown>) => {
      warnCalls.push([mod, msg, ctx]);
      return origWarn.call(logger, mod, msg, ctx);
    };
    try {
      const dr = await dispatchOrchestratorTurn(
        baseArgs({
          failover: async () => ({
            worker: 'test-worker',
            result: okResult(
              'Spawning a thread to handle this (t-1).\n\n[PA_META]: {"actions":[{"type":"spawn_thread","title":"Do the thing","prompt":"Run C:\\synthetic\\project\\script.py and report back."}}]}'
            ),
          }),
        })
      );
      assert.equal(dr.meta, null, 'an unparseable envelope leaves no actions to apply');
      assert.deepEqual(dr.routes, [], 'no route is ever pushed for an envelope that never parsed');
      assert.ok(
        dr.response.includes('_(action envelope could not be parsed:'),
        `expected the loud-failure footer, got: ${dr.response}`
      );
      assert.ok(dr.response.includes('Spawning a thread to handle this (t-1).'), 'narrative text still delivered');

      const warnCall = warnCalls.find(([mod, msg]) => mod === 'orchestrator' && msg.includes('could not be parsed'));
      assert.ok(warnCall, 'the parse failure must be logged at warn, not just console.warn (the 2026-09-09 incident had NO app.log line)');
      assert.ok(typeof warnCall![2]?.refId === 'string' && /^s-[0-9a-f]{12}$/.test(warnCall![2]!.refId as string));
      assert.ok(typeof warnCall![2]?.reason === 'string' && (warnCall![2]!.reason as string).length > 0);
      assert.ok(typeof warnCall![2]?.excerpt === 'string' && (warnCall![2]!.excerpt as string).length > 0);

      const ev = lastThreadFailedEvent();
      assert.ok(ev, 'a thread_failed topic event must be emitted so the failure is visible in /orchestrator status history');
      assert.equal(ev!.ref, warnCall![2]!.refId, 'the topic event correlates to the SAME refId as the warn log (pa ref lookup)');
      assert.ok(ev!.detail.includes('envelope parse failed'), `detail was: ${ev!.detail}`);
    } finally {
      logger.warn = origWarn;
    }
  });

  it('an envelope that parses only after the lone-backslash repair is accepted and noted, never silently applied unlabeled', async () => {
    const dr = await dispatchOrchestratorTurn(
      baseArgs({
        failover: async () => ({
          worker: 'test-worker',
          result: okResult(
            'Spawning a thread to fetch the file (t-1).\n\n[PA_META]: {"actions":[{"type":"spawn_thread","title":"Fetch file","prompt":"Open C:\\synthetic\\logs\\output.txt and read it."}]}'
          ),
        }),
      })
    );
    assert.equal(dr.routes.length, 1);
    assert.equal(dr.routes[0].kind, 'spawn');
    assert.ok(dr.routes[0].kind === 'spawn' && dr.routes[0].prompt === 'Open C:\\synthetic\\logs\\output.txt and read it.');
    assert.ok(
      dr.response.includes('_(action envelope repaired: escaped stray backslashes)_'),
      `expected the repair-noted footer, got: ${dr.response}`
    );
  });

  it('an oversized spawn prompt is truncated to the cap with an explicit footer, never silently rejected', async () => {
    const oversized = 'x'.repeat(SPAWN_PROMPT_MAX_CHARS + 600);
    const dr = await dispatchOrchestratorTurn(
      baseArgs({
        failover: async () => ({
          worker: 'test-worker',
          result: okResult(
            `Spawning a thread (t-1).\n\n[PA_META]: {"actions":[{"type":"spawn_thread","title":"Long job","prompt":"${oversized}"}]}`
          ),
        }),
      })
    );
    assert.equal(dr.routes.length, 1, 'the spawn must still route — a legitimate long instruction is never silently killed');
    assert.ok(dr.routes[0].kind === 'spawn' && dr.routes[0].prompt.length === SPAWN_PROMPT_MAX_CHARS);
    assert.ok(
      dr.response.includes(`_(spawn prompt truncated to ${SPAWN_PROMPT_MAX_CHARS} chars)_`),
      `expected the truncation footer, got: ${dr.response}`
    );
    assert.ok(!dr.response.includes('rejected'), 'a truncated-and-accepted spawn must not also read as rejected');
  });

  it('a rejected spawn (validation failure) logs at warn AND its footer reaches dr.response', async () => {
    const origWarn = logger.warn;
    const warnCalls: Array<[string, string, Record<string, unknown> | undefined]> = [];
    logger.warn = (mod: string, msg: string, ctx?: Record<string, unknown>) => {
      warnCalls.push([mod, msg, ctx]);
      return origWarn.call(logger, mod, msg, ctx);
    };
    try {
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
      assert.deepEqual(dr.routes, []);
      assert.ok(dr.response.includes('_(thread spawn rejected: title must be 1..80 chars)_'));
      const warnCall = warnCalls.find(([mod, msg]) => mod === 'orchestrator' && msg === 'thread spawn rejected');
      assert.ok(warnCall, 'a rejected spawn must be logged at warn, not just silently footnoted');
      assert.equal(warnCall![2]?.reason, 'title must be 1..80 chars');
    } finally {
      logger.warn = origWarn;
    }
  });
});

describe('handleSpawn / handleSteer footer paths (increment 4: queue, park, interrupt)', () => {
  // The handlers fire the REAL executor (there is no dispatch seam through
  // fireThreadExecution). Its FIRST act is the pickup-FYI Telegram send, so a
  // STALLED globalThis.fetch double parks the executor at that await — BEFORE
  // its pendingInput drain and dispatch. PA_NOTIFY_DISABLED=1 (set for every
  // gate run) keeps the REAL fetch suppressed while installed doubles still
  // run (pa telegram-proxy's documented kill-switch contract), so this is
  // capture, not network. The parked exec promise holds no exit-blocking
  // event-loop handle (the WP-H executor-lifetime activity pump is unref'd),
  // so the file still exits cleanly with the executor intentionally unfinished.
  let fyiCalls: Array<{ url: string; text: string }> = [];
  let savedFetch: typeof globalThis.fetch | undefined;
  function stallFyiSends(): void {
    fyiCalls = [];
    savedFetch = globalThis.fetch;
    globalThis.fetch = ((url: unknown, init?: { body?: unknown }) => {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { text?: string }) : {};
      fyiCalls.push({ url: String(url), text: body.text ?? '' });
      return new Promise<Response>(() => {});
    }) as unknown as typeof globalThis.fetch;
  }
  function restoreFetch(): void {
    if (savedFetch) globalThis.fetch = savedFetch;
    savedFetch = undefined;
  }
  // The captured body.text is the SANITIZED MarkdownV2 wire text (sanitizeMdV2
  // escapes e.g. t-1 → t\-1) — strip the escapes before matching.
  function plain(c: { text: string }): string {
    return c.text.replace(/\\/g, '');
  }

  it('T-FOOT1: a full cap parks the spawn with the frozen queued footer; a free slot spawns it', async () => {
    // Distinct per-thread goals: an identical live goal makes the spawn take
    // the AI-232 twin-dedup path ("queued behind …" footer), which is a
    // different feature than the cap-park this test pins.
    for (let i = 1; i <= 10; i++) {
      const r = await createThread(TOPIC_KEY, { title: `w-${i}`, goal: `goal ${i}`, workdir: 'C:/w' });
      assert.ok(r.ok);
    }
    const footer = await handleSpawn({
      topicKey: TOPIC_KEY,
      topicName: 'Test topic',
      spawn: { title: 'eleventh', prompt: 'g' },
      secrets: {},
      token: '',
      workdir: 'C:/w',
    });
    assert.ok(footer.includes('_(Thread t-11 queued — starts when one finishes.)_'), `got: ${footer}`);
    const store = await import('../topic-threads.js');
    const rec = await store.getThread(TOPIC_KEY, 't-11');
    assert.equal(rec?.status, 'queued');

    // Free slot, separate topic key: the create fires the executor, which
    // parks at its pickup FYI (stalled fetch) — the record stays running.
    stallFyiSends();
    try {
      const key2 = `${CHAT_ID}_5002`;
      const footer2 = await handleSpawn({
        topicKey: key2,
        topicName: 'Test topic',
        spawn: { title: 'Sweep logs', prompt: 'g' },
        secrets: {},
        token: '',
        workdir: 'C:/w',
      });
      assert.ok(
        footer2.includes('_(Thread t-1 spawned: Sweep logs — its result arrives in this topic when it finishes.)_'),
        `got: ${footer2}`
      );
      const rec2 = await store.getThread(key2, 't-1');
      assert.equal(rec2?.status, 'running');
      assert.ok(fyiCalls.some((c) => plain(c).startsWith('🧵 Thread t-1 started:')), 'pickup FYI fired');
    } finally {
      restoreFetch();
    }
  });

  it('WP-7: spawn.model rides the validated route onto the stored record; a malformed model rejects the spawn', async () => {
    const store = await import('../topic-threads.js');
    const key3 = `${CHAT_ID}_5003`;
    stallFyiSends();
    try {
      const footer = await handleSpawn({
        topicKey: key3,
        topicName: 'Test topic',
        spawn: { title: 'Sweep', prompt: 'g', model: 'claude-sonnet-4.6' },
        secrets: {},
        token: '',
        workdir: 'C:/w',
      });
      assert.ok(footer.includes('_(Thread t-1 spawned:'), `got: ${footer}`);
      const rec = await store.getThread(key3, 't-1');
      assert.equal(rec?.model, 'claude-sonnet-4.6', 'the validated pin must land on the ThreadRecord');

      const bad = await handleSpawn({
        topicKey: `${CHAT_ID}_5004`,
        topicName: 'Test topic',
        spawn: { title: 'Sweep2', prompt: 'g', model: 'bad model!' },
        secrets: {},
        token: '',
        workdir: 'C:/w',
      });
      assert.ok(bad.includes('_(thread spawn rejected:'), `got: ${bad}`);
      const rejected = await store.getThread(`${CHAT_ID}_5004`, 't-1');
      assert.equal(rejected, undefined, 'a rejected spawn must not create a record');
    } finally {
      restoreFetch();
    }
  });

  it('router-metadata: handleSpawn persists routing on the record; absent when not passed (WP-2)', async () => {
    const store = await import('../topic-threads.js');
    const key5 = `${CHAT_ID}_5005`;
    stallFyiSends();
    try {
      const footer = await handleSpawn({
        topicKey: key5,
        topicName: 'Test topic',
        spawn: { title: 'Routed spawn', prompt: 'g' },
        secrets: {},
        token: '',
        workdir: 'C:/w',
        routing: { decision: 'ladder', steer: 'steer', steerBy: 'operator' },
      });
      assert.ok(footer.includes('_(Thread t-1 spawned:'), `got: ${footer}`);
      const rec = await store.getThread(key5, 't-1');
      assert.deepEqual(rec?.routing, { decision: 'ladder', steer: 'steer', steerBy: 'operator' },
        'the origin turn provenance lands on the ThreadRecord verbatim');

      const key6 = `${CHAT_ID}_5006`;
      await handleSpawn({
        topicKey: key6,
        topicName: 'Test topic',
        spawn: { title: 'Plain spawn', prompt: 'g2' },
        secrets: {},
        token: '',
        workdir: 'C:/w',
      });
      const rec2 = await store.getThread(key6, 't-1');
      assert.equal(rec2?.routing, undefined, 'no routing passed ⇒ no key on the record');
    } finally {
      restoreFetch();
    }
  });

  it('T-FOOT2: interrupt on a RUNNING thread folds, drops the session, bumps runSeq, fires the restart', async () => {
    const store = await import('../topic-threads.js');
    const created = await createThread(TOPIC_KEY, { title: 'Sweep', goal: 'g', workdir: 'C:/w' });
    assert.ok(created.ok);
    await store.updateThread(TOPIC_KEY, 't-1', {
      session: { session_id: 's-1', worker: 'test-worker', started_at: new Date().toISOString() },
    });
    const seeded = await store.getThread(TOPIC_KEY, 't-1');
    assert.ok(seeded, 'seed record present');
    assert.equal(seeded?.runSeq, 0);
    stallFyiSends();
    try {
      const footer = await handleSteer({
        topicKey: TOPIC_KEY,
        topicName: 'Test topic',
        steer: { thread: seeded!, message: 'stop — do it differently', queued: true, mode: 'interrupt' },
        secrets: {},
        token: '',
        workdir: 'C:/w',
      });
      assert.ok(footer.includes('_(Interrupted thread t-1 — restarting with your message.)_'), `got: ${footer}`);
      const rec = await store.getThread(TOPIC_KEY, 't-1');
      // The fold is durable; the executor parked BEFORE its pendingInput drain.
      assert.deepEqual(rec?.pendingInput, ['stop — do it differently']);
      assert.equal(rec?.session, undefined);
      assert.ok((rec?.runSeq ?? 0) >= 1, 'runSeq bumped above the seed');
      assert.ok(fyiCalls.some((c) => plain(c).startsWith('🧵 Thread t-1 started:')), 'restart pickup FYI fired');
    } finally {
      restoreFetch();
    }
  });

  it('T-FOOT3: interrupt on a DONE thread never kills — it routes through the wake path', async () => {
    const store = await import('../topic-threads.js');
    const created = await createThread(TOPIC_KEY, { title: 'Sweep', goal: 'g', workdir: 'C:/w' });
    assert.ok(created.ok);
    await store.updateThread(TOPIC_KEY, 't-1', { status: 'done', lastResult: 'ok' });
    stallFyiSends();
    try {
      const footer = await handleSteer({
        topicKey: TOPIC_KEY,
        topicName: 'Test topic',
        steer: { thread: { ...created.thread, status: 'done' }, message: 'one more pass', queued: false, mode: 'interrupt' },
        secrets: {},
        token: '',
        workdir: 'C:/w',
      });
      assert.ok(footer.includes('_(Routed to thread t-1'), `got: ${footer}`);
      assert.ok(!footer.includes('Interrupted'), 'no interrupt happened on a terminal thread');
      const rec = await store.getThread(TOPIC_KEY, 't-1');
      assert.equal(rec?.status, 'running');
    } finally {
      restoreFetch();
    }
  });

  it('T-FOOT4: a wake parked by the full cap returns the frozen queued footer and parks the record', async () => {
    const store = await import('../topic-threads.js');
    for (let i = 1; i <= 10; i++) {
      const r = await createThread(TOPIC_KEY, { title: `w-${i}`, goal: 'g', workdir: 'C:/w' });
      assert.ok(r.ok);
    }
    // The 11th create parks as queued; flip it done so the steer targets a
    // terminal record (10 running + 1 done — no free slot).
    const parked = await createThread(TOPIC_KEY, { title: 'Old work', goal: 'g', workdir: 'C:/w' });
    assert.ok(parked.ok);
    assert.equal(parked.thread.status, 'queued');
    await store.updateThread(TOPIC_KEY, parked.thread.id, { status: 'done' });
    const footer = await handleSteer({
      topicKey: TOPIC_KEY,
      topicName: 'Test topic',
      steer: { thread: { ...parked.thread, status: 'done' }, message: 'again', queued: false, mode: 'queue' },
      secrets: {},
      token: '',
      workdir: 'C:/w',
    });
    assert.ok(footer.includes('_(Queued for thread t-11 — starts when a thread finishes.)_'), `got: ${footer}`);
    const rec = await store.getThread(TOPIC_KEY, parked.thread.id);
    assert.equal(rec?.status, 'queued');
  });

  it('T-20: steer to a RUNNING thread queues the input and returns the queued footer', async () => {
    const created = await createThread(TOPIC_KEY, { title: 'Sweep', goal: 'g', workdir: 'C:/w' });
    assert.ok(created.ok);
    const footer = await handleSteer({
      topicKey: TOPIC_KEY,
      topicName: 'Test topic',
      steer: { thread: created.thread, message: 'also check stderr', queued: true, mode: 'queue' },
      secrets: {},
      token: '',
      workdir: 'C:/w',
    });
    assert.equal(footer, '\n\n_(Queued for thread t-1 — delivered when its current run finishes.)_');
    const store = await import('../topic-threads.js');
    const rec = await store.getThread(TOPIC_KEY, 't-1');
    assert.deepEqual(rec?.pendingInput, ['also check stderr']);
    // T-B3b: the queued steer emitted thread_steered through the handler to
    // the REAL topic-events jsonl under PA_HOME. The file is SHARED across
    // this file's tests (it lives under PA_HOME, not the per-test store dir),
    // so this test's own write is found as the LAST entry for the ref.
    const raw = readFileSync(join(process.env.PA_HOME!, 'topic-events', `${TOPIC_KEY}.jsonl`), 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as { kind: string; ref: string | null; detail: string });
    const steered = [...lines].reverse().find((e) => e.kind === 'thread_steered' && e.ref === 't-1');
    assert.ok(steered, 'thread_steered event present');
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
      steer: { thread: created.thread, message: 'm', queued: false, mode: 'queue' },
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

describe('thread FYI anchor (AI-203 increment 3)', () => {
  const FOUR_FIRST_LINES = [
    '🧵 Thread t-3 started: Sweep logs',
    '⏳ Thread t-3 hit a snag — retrying automatically: Sweep logs',
    '✅ Thread t-3 done: Sweep logs',
    '❌ Thread t-3 failed: Sweep logs',
  ];

  it('T-O1: resolveThreadFyiAnchor returns t-3 for each of the four FYI first-lines, bare and with the ref footer', () => {
    for (const firstLine of FOUR_FIRST_LINES) {
      assert.equal(resolveThreadFyiAnchor({ reply_to_message: { text: firstLine } }), 't-3', firstLine);
      assert.equal(
        resolveThreadFyiAnchor({ reply_to_message: { text: `${firstLine}\n\n_Ref: s-abcdef123456_` } }),
        't-3',
        firstLine
      );
    }
  });

  it('T-O2: resolveThreadFyiAnchor returns null for non-FYI shapes', () => {
    assert.equal(resolveThreadFyiAnchor({ reply_to_message: { text: 'hello' } }), null);
    assert.equal(
      resolveThreadFyiAnchor({ reply_to_message: { text: `plain first line\n${FOUR_FIRST_LINES[2]}` } }),
      null,
      'the FYI first-line must be FIRST — a second-line match would anchor on quoted bodies'
    );
    assert.equal(
      resolveThreadFyiAnchor({ quote: { text: '✅ Thread t-3 done: Sweep logs' } } as any),
      null,
      'a QUOTE of an FYI is not a direct reply — no reply_to_message, no anchor'
    );
    assert.equal(resolveThreadFyiAnchor({}), null);
  });

  it('T-O3: a reply to a RUNNING thread queues the steer behind the frozen lead', async () => {
    const created = await createThread(TOPIC_KEY, { title: 'Sweep logs', goal: 'g', workdir: 'C:/w' });
    assert.ok(created.ok);
    const reply = await handleAnchorSteerReply({
      topicKey: TOPIC_KEY,
      topicName: 'T',
      thread: created.thread,
      message: 'also check failures',
      secrets: {},
      token: 't',
      workdir: '.',
    });
    assert.ok(reply.includes('➡️ Follow-up for thread t-1 (Sweep logs):'), `got: ${reply}`);
    assert.ok(reply.includes('_(Queued for thread t-1'), `got: ${reply}`);
    const store = await import('../topic-threads.js');
    const rec = await store.getThread(TOPIC_KEY, 't-1');
    assert.deepEqual(rec?.pendingInput, ['also check failures']);
  });

  it('T-O4: a CANCELLED thread rejects with the frozen rejection footer ALONE — no lead line', async () => {
    const store = await import('../topic-threads.js');
    const created = await createThread(TOPIC_KEY, { title: 'Doomed', goal: 'g', workdir: 'C:/w' });
    assert.ok(created.ok);
    await store.updateThread(TOPIC_KEY, 't-1', { status: 'cancelled' });
    const reply = await handleAnchorSteerReply({
      topicKey: TOPIC_KEY,
      topicName: 'T',
      thread: created.thread,
      message: 'm',
      secrets: {},
      token: 't',
      workdir: '.',
    });
    assert.ok(reply.startsWith('_(steer rejected: thread t-1 is cancelled'), `got: ${reply}`);
    assert.ok(!reply.includes('➡️'), 'a rejection renders WITHOUT a lead line');

    const long = await handleAnchorSteerReply({
      topicKey: TOPIC_KEY,
      topicName: 'T',
      thread: created.thread,
      message: 'x'.repeat(4001),
      secrets: {},
      token: 't',
      workdir: '.',
    });
    assert.ok(long.startsWith('_(steer rejected: message must be 1..4000 chars'), `got: ${long.slice(0, 80)}`);
  });
});

// ---------------------------------------------------------------------------
// Voice-inbox route text loss — live-incident reproduction (2026-09-09).
//
// H1 (voice-inbox-bridge.ts's WP-5C drain restructure corrupts the injected
// text) and H2 (dispatch.ts's failover cascade rebuilds the prompt on
// failover) were both ruled out by inspection: drainVoiceInboxRoutes injects
// `entry.text` into `message.text` verbatim, and runDispatchCascade threads
// ONE `args.userText` through every resume/preferred/default/failover attempt
// unchanged. The real cause is upstream of both: every one of the 55 live
// topics the voice-inbox app targets is orchestrator-enabled (all voice-inbox
// tasks land in brand-new topics/threads with no prior session), so every
// voice-inbox dispatch takes dispatchOrchestratorTurn's FRESH path — and
// buildOrchestratorPrompt (orchestrator.ts, the §4.6 "fresh orchestrator
// prompt") never interpolates its own `userMessage` parameter anywhere in the
// template it returns (contrast buildOrchestratorResumedPrompt, which does).
// A worker dispatched on the fresh path — direct or via failover, since
// runDispatchCascade builds buildFresh's prompt ONCE before handing it to
// runWithFailover — receives topic/thread scaffolding and role instructions
// but never the user's actual message: exactly the observed "I didn't
// receive an actual message from you — just system context" reply. This has
// been true since the function's introduction (AI-203 WP-2) — it surfaced
// today because voice-inbox route entries are the one traffic class that
// ALWAYS lands on a topic's first-ever (fresh, unresumable) turn.
// ---------------------------------------------------------------------------
describe('voice-inbox route text loss — root cause repro (buildOrchestratorPrompt drops userMessage)', () => {
  const VOICE_CHAT_ID = -1000000000001;
  const VOICE_THREAD_ID = 7001;
  const ROUTE_TEXT =
    '[Voice task vi-180a05875c9e routed from inbox — reason: idle-topic] Check on the greenhouse irrigation schedule. ' +
    'First run: python D:/Personal Assistant/projects/voice-inbox/scripts/task_telemetry.py start vi-180a05875c9e';

  function writeFailScript(dir: string): string {
    const p = join(dir, 'fail-worker.cjs');
    writeFileSync(p, 'process.exitCode = 1;\n', 'utf8');
    return p.replace(/\\/g, '/');
  }

  /** Reads the full stdin the worker process was handed (the ACTUAL prompt
   *  executeWorker delivers under input_mode:'stdin-text') and dumps it
   *  verbatim to `capturePath` — the exec seam this repro reads its evidence
   *  from. */
  function writeCaptureScript(dir: string, capturePath: string): string {
    const p = join(dir, 'capture-worker.cjs');
    const cp = capturePath.replace(/\\/g, '/');
    writeFileSync(
      p,
      [
        "const fs = require('node:fs');",
        "let d = '';",
        "process.stdin.on('data', c => { d += c; });",
        "process.stdin.on('end', () => {",
        `  fs.writeFileSync(${JSON.stringify(cp)}, d, 'utf8');`,
        "  process.stdout.write('handled');",
        '  process.exitCode = 0;',
        '});',
        '',
      ].join('\n'),
      'utf8'
    );
    return p.replace(/\\/g, '/');
  }

  function writeWorkersConfig(dir: string, workers: Array<{ name: string; script: string; priority: number }>) {
    writeFileSync(
      join(dir, 'config.yaml'),
      JSON.stringify({
        workers: workers.map((w) => ({
          name: w.name,
          command: 'node',
          args: [w.script],
          input_mode: 'stdin-text',
          output_format: 'text',
          check: 'echo ok',
          rate_limit_patterns: [],
          priority: w.priority,
          state_dir: '/nonexistent/path',
          state_pattern: '*.jsonl',
        })),
      }),
      'utf8'
    );
  }

  /** Drains a real route-queue.jsonl line through the PRODUCTION seam
   *  (drainVoiceInboxRoutes) rather than hand-building a TelegramUpdate, and
   *  returns the injected update's message.text — the exact string a live
   *  voice-inbox task dispatch would carry into processUpdate. */
  async function injectedRouteText(scratchDir: string, text: string): Promise<string> {
    const queuePath = join(scratchDir, 'route-queue.jsonl');
    const entry = {
      q_id: 'q-1',
      ts: new Date().toISOString(),
      task_id: 'vi-180a05875c9e',
      tenant_id: 't1',
      chat_id: VOICE_CHAT_ID,
      thread_id: VOICE_THREAD_ID,
      text,
      ref_id: 'r-1',
    };
    writeFileSync(queuePath, `${JSON.stringify(entry)}\n`, 'utf8');
    let captured: any = null;
    const injected = await drainVoiceInboxRoutes({
      queuePath,
      injectFn: (u) => { captured = u; },
      nextId: () => 1,
    });
    assert.equal(injected, 1, 'the fixture entry must actually drain and inject (H1 area)');
    assert.ok(captured, 'injectFn must have been called');
    return (captured as { message: { text: string } }).message.text;
  }

  it('REPRO-DIRECT: a fresh orchestrator dispatch that succeeds on the FIRST worker still must carry the routed text', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'voice-route-direct-'));
    const priorHome = process.env.PA_HOME;
    try {
      const userText = await injectedRouteText(scratch, ROUTE_TEXT);
      assert.equal(userText, ROUTE_TEXT, 'the bridge injects the entry text verbatim — H1 confirmed NOT the cause');

      const capturePath = join(scratch, 'capture.txt');
      writeWorkersConfig(scratch, [{ name: 'solo-worker', script: writeCaptureScript(scratch, capturePath), priority: 1 }]);
      process.env.PA_HOME = scratch;

      const dr = await dispatchOrchestratorTurn({
        userText,
        topicState: makeState({ chat_id: VOICE_CHAT_ID, thread_id: VOICE_THREAD_ID }),
        secrets: {},
        resourceId: `topic-${VOICE_CHAT_ID}_${VOICE_THREAD_ID}`,
        chatId: VOICE_CHAT_ID,
        threadId: VOICE_THREAD_ID,
        defaultWorker: 'solo-worker',
      });
      assert.equal(dr.workerError, undefined, 'the single worker must have succeeded');
      const promptSeenByWorker = readFileSync(capturePath, 'utf8');
      assert.ok(
        promptSeenByWorker.includes(userText),
        `the routed task text never reached the worker's stdin (no failover involved) — worker saw:\n${promptSeenByWorker}`
      );
    } finally {
      process.env.PA_HOME = priorHome;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('REPRO-FAILOVER: a fresh orchestrator dispatch that fails over (agy-style quota fail -> claude-style success) must still carry the routed text', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'voice-route-failover-'));
    const priorHome = process.env.PA_HOME;
    try {
      const userText = await injectedRouteText(scratch, ROUTE_TEXT);

      const capturePath = join(scratch, 'capture.txt');
      writeWorkersConfig(scratch, [
        { name: 'agy', script: writeFailScript(scratch), priority: 1 },
        { name: 'claude', script: writeCaptureScript(scratch, capturePath), priority: 2 },
      ]);
      process.env.PA_HOME = scratch;

      const dr = await dispatchOrchestratorTurn({
        userText,
        topicState: makeState({ chat_id: VOICE_CHAT_ID, thread_id: VOICE_THREAD_ID }),
        secrets: {},
        resourceId: `topic-${VOICE_CHAT_ID}_${VOICE_THREAD_ID}`,
        chatId: VOICE_CHAT_ID,
        threadId: VOICE_THREAD_ID,
        defaultWorker: 'agy',
      });
      assert.equal(dr.dispatchedWorker, 'claude', 'the cascade must actually have failed over to the second worker');
      const promptSeenByWorker = readFileSync(capturePath, 'utf8');
      assert.ok(
        promptSeenByWorker.includes(userText),
        `the routed task text never reached the failover worker's stdin (this IS the live incident) — worker saw:\n${promptSeenByWorker}`
      );
    } finally {
      process.env.PA_HOME = priorHome;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
