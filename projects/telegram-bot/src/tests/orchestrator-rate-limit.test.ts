/**
 * AI-173 phase 3 — THE GAIN pin: a rate-limited ORCHESTRATOR turn now runs
 * tryClassifyAndNotify (the lane's classifyFailures: true over dispatch.ts's
 * shared runDispatchCascade), stamping pa's rate-limit ledger and firing the
 * failover notify exactly like a human-lane turn. The gain changes ONLY the
 * failure path: a successful turn, and a known worker with no rate-limit
 * evidence, must behave exactly as before.
 *
 * Harness note (read before "simplifying" this): the classification fires ONLY
 * on a failed resume attempt, and the resume attempt runs only for a VALID
 * session. session.ts's sessionFileExists() recognizes claude/zclaude/codex/agy
 * sessions only — an unknown worker name can never pass the validity gate, so
 * the classified worker here is a REAL 'claude' session made valid the
 * thread-executor.test.ts way: a per-test fake HOME/USERPROFILE with the
 * transcript file seeded at
 * <fakeHome>/.claude/projects/<cwdToClaudeProjectDir(workdir)>/<sessionId>.jsonl,
 * and the rate-limit evidence seeded as a retry-exhausted 429 api_error line in
 * the claude worker's state_dir (pa's rate-limits-classifiers.test.ts fixture
 * shape: "Usage limit reached for 5 hour." → minutes 300).
 * Isolation: per-test temp PA_HOME (fresh rate-limit-state.json each case);
 * 'test-worker-rl' appears only as the unknown-name failover TARGET; no real
 * claude/agy cooldown state is ever touched.
 */
import './test-env-guard.js';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmRetry } from './rm-retry.js';
import { waitForDrain } from './test-teardown-guard.js';
import type { ConversationState } from '../types.js';
import type { OrchestratorTurnArgs } from '../orchestrator.js';

const CHAT_ID = -1001234567890;
const THREAD_ID = 5002;
const TOPIC_KEY = `${CHAT_ID}_${THREAD_ID}`;

let sharedTempDir = '';

before(async () => {
  sharedTempDir = await mkdtemp(join(tmpdir(), 'orch-rl-test-'));
  process.env.PA_HOME = sharedTempDir;
});

after(async () => {
  delete process.env.PA_HOME;
  await rmRetry(sharedTempDir);
});

// Dynamic imports after PA_HOME is set (dispatch-error-paths.test.ts pattern).
const { dispatchOrchestratorTurn } = await import('../orchestrator.js');
const { cwdToClaudeProjectDir } = await import('../session.js');
const { clearRateLimitCache, NO_WORKERS_AVAILABLE_ERROR } = await import('../../../../pa/dist/src/workers.js');

/** One retry-exhausted 429 api_error line — pa's classifier reads exactly this
 *  shape (type:system + subtype:api_error + error.status 429) and extracts the
 *  cooldown from the message text ("for 5 hour" → 300 minutes). */
function rateLimitEvidenceLine(): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'api_error',
    error: { status: 429, error: { error: { message: 'Usage limit reached for 5 hour.' } } },
    retryAttempt: 10,
    maxRetries: 10,
    timestamp: new Date().toISOString(),
  });
}

function makeState(extra: Partial<ConversationState> = {}): ConversationState {
  return {
    chat_id: CHAT_ID,
    thread_id: THREAD_ID,
    last_update_id: 0,
    turns: [],
    session: { session_id: 's-1', worker: 'claude', started_at: new Date().toISOString() },
    ...extra,
  };
}

describe('orchestrator lane rate-limit gain (AI-173 phase 3)', () => {
  let testDir = '';
  let workdir = '';
  let evidenceDir = '';
  let fakeHome = '';
  let priorHome: string | undefined;
  let priorProfile: string | undefined;

  beforeEach(async () => {
    testDir = await mkdtemp(join(sharedTempDir, 'case-'));
    process.env.PA_HOME = testDir;
    await writeFile(join(testDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
    await writeFile(join(testDir, 'rate-limit-state.json'), '{}', 'utf8');
    await writeFile(
      join(testDir, 'config.yaml'),
      JSON.stringify({
        workers: [
          {
            // The session's worker: state_dir points at this test's evidence
            // dir so the claude classifier reads ONLY fixtures written here.
            name: 'claude',
            command: 'node',
            args: ['-e', 'process.exitCode=1'],
            input_mode: 'stdin-text',
            output_format: 'text',
            check: 'echo ok',
            rate_limit_patterns: [],
            priority: 1,
            state_dir: join(testDir, 'rl-evidence'),
            state_pattern: '*.jsonl',
          },
          {
            // Unknown-name worker: failover target only, never a session owner.
            name: 'test-worker-rl',
            command: 'node',
            args: ['-e', 'process.exitCode=1'],
            input_mode: 'stdin-text',
            output_format: 'text',
            check: 'echo ok',
            rate_limit_patterns: [],
            priority: 2,
            state_dir: '/nonexistent/path',
            state_pattern: '*.jsonl',
          },
        ],
      }),
      'utf8'
    );
    // Fake home + seeded transcript: makes the seeded claude session VALID
    // (thread-executor.test.ts precedent), so the cascade's resume attempt
    // actually runs and its failure reaches the classification.
    priorHome = process.env.HOME;
    priorProfile = process.env.USERPROFILE;
    fakeHome = mkdtempSync(join(tmpdir(), 'orch-rl-home-'));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    workdir = join(testDir, 'topic-wd');
    const projDir = join(fakeHome, '.claude', 'projects', cwdToClaudeProjectDir(workdir));
    await mkdir(projDir, { recursive: true });
    writeFileSync(join(projDir, 's-1.jsonl'), '{}\n', 'utf8');
    // The classifier's evidence dir: EMPTY by default (the no-evidence case
    // seeds nothing); the rate-limit cases write s-1.jsonl into it.
    evidenceDir = join(testDir, 'rl-evidence');
    await mkdir(evidenceDir, { recursive: true });
  });

  afterEach(async () => {
    await waitForDrain();
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorProfile;
    process.env.PA_HOME = sharedTempDir;
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    await rmRetry(testDir);
    testDir = '';
  });

  /** baseArgs: defaultWorker === the session's worker so the AI-030
   *  switch-back holds the session (isOptimal) and the resume attempt runs. */
  function baseArgs(overrides: Partial<OrchestratorTurnArgs> = {}): OrchestratorTurnArgs {
    return {
      userText: 'route this',
      topicState: makeState(),
      secrets: {},
      resourceId: `topic-${TOPIC_KEY}`,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      defaultWorker: 'claude',
      workdir: { dir: workdir, tier: 'bot-cwd' },
      capture: async () => undefined,
      ...overrides,
    };
  }

  function failExecute(calls: { prompt: string; opts: any }[]) {
    return async (_worker: unknown, prompt: string, opts: any) => {
      calls.push({ prompt, opts });
      return { success: false, output: '', error: 'boom', exitCode: 1 } as any;
    };
  }

  function okFailover(calls: { prompt: string; opts: any }[]) {
    return async (prompt: string, opts: any) => {
      calls.push({ prompt, opts });
      return { worker: 'test-worker-rl', result: { success: true, output: 'failover took over', exitCode: 0 } as any };
    };
  }

  async function readLedger(): Promise<Record<string, unknown>> {
    const raw = await readFile(join(process.env.PA_HOME!, 'rate-limit-state.json'), 'utf8');
    return JSON.parse(raw);
  }

  it('OR-T1: THE GAIN — a failed orchestrator attempt classifies and stamps the ledger', async () => {
    writeFileSync(join(evidenceDir, 's-1.jsonl'), rateLimitEvidenceLine(), 'utf8');
    const executeCalls: { prompt: string; opts: any }[] = [];
    const failoverCalls: { prompt: string; opts: any }[] = [];

    const dr = await dispatchOrchestratorTurn(baseArgs({
      execute: failExecute(executeCalls),
      failover: okFailover(failoverCalls),
    }));

    // The resume attempt actually ran, on the seeded session's worker, with
    // buildResumeArgs extraArgs ONLY (applySessionTunables stays false).
    assert.equal(executeCalls.length, 1, 'the valid seeded session must drive a resume attempt');
    assert.equal(executeCalls[0].opts.agentName, 'claude');
    assert.deepEqual(executeCalls[0].opts.extraArgs, ['--resume', 's-1']);

    // AFFIRMATIVE gain pins: the classification surfaced on the turn result
    // AND the ledger gained the entry. A run where the ledger did NOT gain it
    // is a defect (silent fallback), not a pass.
    assert.equal(dr.rateLimitedWorker, 'claude');
    const ledger = await readLedger();
    assert.ok(ledger['claude'], `the ledger must gain a claude entry; got: ${JSON.stringify(ledger)}`);

    // The cascade still continued to the fresh/failover leg after the
    // classification (behavior preserved).
    assert.equal(failoverCalls.length, 1);
    assert.equal(dr.dispatchedWorker, 'test-worker-rl');
  });

  it('OR-T2: the gain fires onNotify with exactly one rate-limit payload', async () => {
    writeFileSync(join(evidenceDir, 's-1.jsonl'), rateLimitEvidenceLine(), 'utf8');
    const payloads: any[] = [];
    const executeCalls: { prompt: string; opts: any }[] = [];

    const dr = await dispatchOrchestratorTurn(baseArgs({
      execute: failExecute(executeCalls),
      failover: okFailover([]),
      onNotify: async (payload: any) => { payloads.push(payload); },
    }));

    assert.equal(payloads.length, 1, `exactly one classify notify expected; got: ${JSON.stringify(payloads)}`);
    assert.equal(payloads[0].kind, 'rate-limit');
    assert.equal(payloads[0].from, 'claude');
    assert.ok(payloads[0].minutes >= 1, 'the payload must carry a real cooldown, not the transient no-op');
    assert.equal(dr.rateLimitedWorker, 'claude');
  });

  it('OR-T3: tri-state preserved — a known worker with NO rate-limit evidence does not classify', async () => {
    // evidenceDir stays EMPTY: the claude classifier finds no session evidence
    // → not-rate-limit → no ledger write, no notify.
    const payloads: any[] = [];
    const executeCalls: { prompt: string; opts: any }[] = [];

    const dr = await dispatchOrchestratorTurn(baseArgs({
      execute: failExecute(executeCalls),
      failover: okFailover([]),
      onNotify: async (payload: any) => { payloads.push(payload); },
    }));

    assert.equal(executeCalls.length, 1, 'the resume attempt still ran');
    assert.equal(dr.rateLimitedWorker, undefined, 'no evidence → no rate-limit classification');
    assert.deepEqual(await readLedger(), {}, 'the ledger must be untouched');
    assert.deepEqual(payloads, [], 'no classify notify may fire without evidence');
  });

  it('OR-T4: success path unaffected — no classification, resume result kept', async () => {
    const executeCalls: { prompt: string; opts: any }[] = [];
    const failoverCalls: { prompt: string; opts: any }[] = [];

    const dr = await dispatchOrchestratorTurn(baseArgs({
      execute: async (_worker: unknown, prompt: string, opts: any) => {
        executeCalls.push({ prompt, opts });
        return { success: true, output: 'orchestrator reply', exitCode: 0 } as any;
      },
      failover: okFailover(failoverCalls),
    }));

    assert.equal(executeCalls.length, 1, 'the resume attempt ran and succeeded');
    assert.equal(failoverCalls.length, 0, 'a successful resume must not fall through to failover');
    assert.equal(dr.rateLimitedWorker, undefined, 'the gain changes ONLY the failure path');
    assert.equal(dr.dispatchedWorker, 'claude');
    assert.equal(dr.workerError, undefined);
    assert.equal(dr.session?.session_id, 's-1', 'a resumed turn keeps the session');
    assert.ok(dr.response.includes('orchestrator reply'));
    assert.deepEqual(await readLedger(), {}, 'no ledger write on success');
    assert.equal(existsSync(join(evidenceDir, 's-1.jsonl')), false, 'no evidence was seeded in this case');
  });

  it('OR-T5: the failover\'s rate-limit verdict surfaces as rateLimitedWorker', async () => {
    // session: undefined → straight to the failover leg. The seam fires the
    // exact payload runWithFailover emits on a rate-limit hop; the cascade's
    // onWorkerSwitch wrapper must observe that verdict itself (nothing else
    // classifies on this leg — there is no second tryClassifyAndNotify).
    const dr = await dispatchOrchestratorTurn(baseArgs({
      topicState: makeState({ session: undefined }),
      failover: async (_prompt: string, opts: any) => {
        await opts.onWorkerSwitch?.({ from: 'test-worker-rl', to: null, kind: 'rate-limit', reasonText: 'usage limit', minutes: 300, classification: 'usage-limit', source: 'session' });
        return { worker: 'test-worker-rl', result: { success: false, output: '', error: 'exhausted', exitCode: 1 } as any };
      },
    }));

    assert.equal(dr.rateLimitedWorker, 'test-worker-rl');
    assert.equal(dr.workerError, true);
  });

  it('OR-T6: a non-rate-limit verdict leaves rateLimitedWorker undefined', async () => {
    // Control that can fail: identical seam, but the hop verdict is a plain
    // failure — the wrapper must NOT seed rateLimitedWorker from it.
    const dr = await dispatchOrchestratorTurn(baseArgs({
      topicState: makeState({ session: undefined }),
      failover: async (_prompt: string, opts: any) => {
        await opts.onWorkerSwitch?.({ from: 'test-worker-rl', to: null, kind: 'failure', reasonText: 'usage limit', minutes: 300, classification: 'usage-limit', source: 'session' });
        return { worker: 'test-worker-rl', result: { success: false, output: '', error: 'exhausted', exitCode: 1 } as any };
      },
    }));

    assert.equal(dr.rateLimitedWorker, undefined);
  });

  it('OR-T7: a zero-attempt all-cooling failover seeds rateLimitedWorker', async () => {
    // The "all workers rate-limited" dead-end: the failover returns
    // NO_WORKERS_AVAILABLE_ERROR having made ZERO attempts, so nothing was
    // classified and no verdict fires. Seed a future cooldown for BOTH config
    // workers — the clause must seed the ladder from the cooldown state,
    // picking the first cooling candidate in config order ('claude').
    const now = new Date();
    const entry = { cooldown_until: new Date(now.getTime() + 3_600_000).toISOString(), last_event: now.toISOString(), reason: 'usage limit' };
    writeFileSync(
      join(testDir, 'rate-limit-state.json'),
      JSON.stringify({ claude: entry, 'test-worker-rl': { ...entry } }),
      'utf8'
    );
    // The mtime-keyed cache can otherwise serve the pre-write {} on a coarse clock.
    clearRateLimitCache();

    const dr = await dispatchOrchestratorTurn(baseArgs({
      topicState: makeState({ session: undefined }),
      failover: async () => ({
        worker: 'none',
        result: { success: false, output: '', error: NO_WORKERS_AVAILABLE_ERROR, exitCode: -1 } as any,
      }),
    }));

    assert.equal(dr.rateLimitedWorker, 'claude');
  });
});
