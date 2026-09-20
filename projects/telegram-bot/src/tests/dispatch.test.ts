/**
 * Unit pins for the extracted dispatch module (AI-173 phase 3).
 *
 * dispatch.ts holds the dispatch/failover cascade moved verbatim out of main.ts;
 * this file pins the pieces no other suite reaches directly:
 * - buildFailoverReasonText's exact user-facing failover strings
 * - maybeDropAgySession's kill-drop rule (agy native-resume)
 * - the main.js re-export surface (the four witness files import the moved
 *   symbols from '../main.js' — identity, not a copy)
 * - dispatchMessage's cancellation exit shape under an armed /stop marker
 * - the ESM guard (no require( in the new module)
 *
 * Isolation strategy mirrors dispatch-error-paths.test.ts: each test file run
 * gets a fresh temp PA_HOME with its own config.yaml/blackboard.json/
 * rate-limit-state.json, and the /stop marker registry is cleared around the
 * cancellation tests so the armed marker cannot leak into other suites.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import type { ConversationState } from '../types.js';
import type { DispatchLane } from '../dispatch.js';
import type { WorkerConfig } from '../../../../pa/dist/src/types.js';
import { rmRetry } from './rm-retry.js';
import { waitForDrain } from './test-teardown-guard.js';

const testRunId = `test-${process.pid}-${Date.now()}`;

let sharedTempDir: string;

before(async () => {
  sharedTempDir = await mkdtemp(join(tmpdir(), 'dispatch-test-'));
  process.env.PA_HOME = sharedTempDir;
  await writeFile(join(sharedTempDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
  await writeFile(join(sharedTempDir, 'rate-limit-state.json'), '{}', 'utf8');
});

after(async () => {
  delete process.env.PA_HOME;
  await rmRetry(sharedTempDir);
});

// Dynamic imports (same pattern as dispatch-error-paths.test.ts)
const { buildFailoverReasonText, maybeDropAgySession, dispatchMessage, runDispatchCascade } = await import('../dispatch.js');
const mainMod = await import('../main.js');
const dispatchMod = await import('../dispatch.js');
const { AGY_NATIVE_RESUME_EXCLUDED_TOPICS } = await import('../session-capture.js');
const { markTopicStopped, _clearStoppedForTest } = await import('../worker-stop.js');

// Fire-and-forget insurance for the raw-send alert path (test-teardown-guard).
afterEach(async () => {
  await waitForDrain();
});

// ---------------------------------------------------------------------------

function makeState(extra: Partial<ConversationState> = {}): ConversationState {
  return { chat_id: 999, thread_id: 0, last_update_id: 0, turns: [], ...extra };
}

/** Write a JSON-format config.yaml (YAML is a superset of JSON — avoids quoting issues).
 *  `extra` merges additional top-level blocks (e.g. model_router) into the config. */
async function writeConfig(dir: string, workers: object[], extra: Record<string, unknown> = {}) {
  const config = {
    workers: workers.map((w: any, i: number) => ({
      name: w.name,
      command: w.command,
      args: w.args,
      input_mode: w.input_mode ?? 'stdin-text',
      output_format: w.output_format ?? 'text',
      check: 'echo ok',
      rate_limit_patterns: w.rate_limit_patterns ?? [],
      priority: w.priority ?? i + 1,
      state_dir: '/nonexistent/path',
      state_pattern: '*.jsonl',
    })),
    ...extra,
  };
  await writeFile(join(dir, 'config.yaml'), JSON.stringify(config), 'utf8');
}

// ---------------------------------------------------------------------------
// D-T1 — buildFailoverReasonText pins
// ---------------------------------------------------------------------------

describe('buildFailoverReasonText pins', () => {
  it('no payload → the plain temporary-failover form', () => {
    assert.equal(buildFailoverReasonText(undefined, 'A', 'B'), 'Temporary failover from A to B.');
  });

  it("kind 'rate-limit' with a classification names the class", () => {
    const payload = { from: 'A', to: 'B', kind: 'rate-limit', reasonText: 'raw', classification: 'quota-exhausted' } as any;
    assert.equal(buildFailoverReasonText(payload, 'A', 'B'), 'Temporary failover from A to B due to quota-exhausted rate limit.');
  });

  it("kind 'rate-limit' without a classification falls back to the bare form", () => {
    const payload = { from: 'A', to: 'B', kind: 'rate-limit', reasonText: 'raw' } as any;
    assert.equal(buildFailoverReasonText(payload, 'A', 'B'), 'Temporary failover from A to B due to rate limit.');
  });

  it('a non-empty reasonText is trimmed and sliced to 120 chars', () => {
    const payload = { from: 'A', to: 'B', kind: 'failure', reasonText: `  ${'x'.repeat(150)}  ` } as any;
    assert.equal(buildFailoverReasonText(payload, 'A', 'B'), `Temporary failover from A to B: ${'x'.repeat(120)}.`);
  });

  it('empty (whitespace) detail → the plain form', () => {
    const payload = { from: 'A', to: 'B', kind: 'failure', reasonText: '   ' } as any;
    assert.equal(buildFailoverReasonText(payload, 'A', 'B'), 'Temporary failover from A to B.');
  });
});

// ---------------------------------------------------------------------------
// D-T2 — maybeDropAgySession pins
// ---------------------------------------------------------------------------

describe('maybeDropAgySession pins', () => {
  const agySession = { session_id: 's-agy', worker: 'agy', started_at: new Date().toISOString() };
  const claudeSession = { session_id: 's-claude', worker: 'claude', started_at: new Date().toISOString() };

  it('a non-agy session passes through untouched', () => {
    assert.equal(maybeDropAgySession(claudeSession, 'topic-999_5001', true), claudeSession);
  });

  it('an agy session with shouldDrop → undefined (kill-drop)', () => {
    assert.equal(maybeDropAgySession(agySession, 'topic-999_5002', true), undefined);
  });

  it('a thread id in AGY_NATIVE_RESUME_EXCLUDED_TOPICS passes through', () => {
    AGY_NATIVE_RESUME_EXCLUDED_TOPICS.add('7777');
    try {
      assert.equal(maybeDropAgySession(agySession, 'topic-999_7777', true), agySession);
    } finally {
      AGY_NATIVE_RESUME_EXCLUDED_TOPICS.delete('7777');
    }
  });

  it('an undefined session passes through', () => {
    assert.equal(maybeDropAgySession(undefined, 'topic-999_5002', true), undefined);
  });
});

// ---------------------------------------------------------------------------
// D-T3 — the main.js re-export surface (A-D4): identity, not a copy
// ---------------------------------------------------------------------------

describe('main.js re-export identity pins', () => {
  it('main.js dispatchMessage === dispatch.js dispatchMessage', () => {
    assert.equal((mainMod as any).dispatchMessage, (dispatchMod as any).dispatchMessage);
  });

  it('main.js tryClassifyAndNotify === dispatch.js tryClassifyAndNotify', () => {
    assert.equal((mainMod as any).tryClassifyAndNotify, (dispatchMod as any).tryClassifyAndNotify);
  });

  it('main.js buildDispatchExtraArgs === dispatch.js buildDispatchExtraArgs', () => {
    assert.equal((mainMod as any).buildDispatchExtraArgs, (dispatchMod as any).buildDispatchExtraArgs);
  });
});

// ---------------------------------------------------------------------------
// D-T4 — dispatchMessage's cancellation exit shape under an armed /stop
// ---------------------------------------------------------------------------

describe('dispatchMessage cancellation exit shape', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dispatch-cancel-test-'));
    process.env.PA_HOME = testDir;
    await writeFile(join(testDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
    await writeFile(join(testDir, 'rate-limit-state.json'), '{}', 'utf8');
    await writeConfig(testDir, [
      { name: 'zclaude', command: 'node', args: ['-e', 'process.exitCode=1'], priority: 1 },
    ]);
    _clearStoppedForTest();
  });

  afterEach(async () => {
    await waitForDrain();
    process.env.PA_HOME = sharedTempDir;
    _clearStoppedForTest();
    await rmRetry(testDir);
  });

  it('a /stop older than the dispatch → empty response, no session, meta null, workerError', async () => {
    const resource = `topic-999_${testRunId}-cancel1`;
    markTopicStopped(resource.replace(/^topic-/, ''), 'stop', 1000);

    const result = await dispatchMessage('hello', undefined, undefined, makeState(), {}, resource, 'zclaude', undefined, undefined, 999 /* older than /stop */);

    assert.deepEqual(
      { response: result.response, session: result.session, meta: result.meta, workerError: result.workerError },
      { response: '', session: undefined, meta: null, workerError: true },
    );
  });

  it('the same exit kill-drops an agy session to undefined', async () => {
    const resource = `topic-999_${testRunId}-cancel2`;
    markTopicStopped(resource.replace(/^topic-/, ''), 'stop', 1000);
    const agySession = { session_id: 's-agy-cancel', worker: 'agy', started_at: new Date().toISOString() };

    const result = await dispatchMessage('hello', undefined, undefined, makeState({ session: agySession }), {}, resource, 'zclaude', undefined, undefined, 999);

    assert.equal(result.response, '');
    assert.equal(result.session, undefined, 'agy session on a non-excluded topic must be kill-dropped on the cancellation exit');
    assert.equal(result.meta, null);
    assert.equal(result.workerError, true);
  });
});

// ---------------------------------------------------------------------------
// WP-3 (2026-09-19, router-as-orchestrator spec §2.3 + M2): the cascade's
// chain pass-through is SURFACE-gated and the worker-pin skip rides the
// deprecate-pins gate. The failover SEAM receives the opts, so the stub is the
// failover-seam proof for both the seam path and the byte-identical direct
// runWithFailover literal that mirrors it.
// ---------------------------------------------------------------------------

describe('runDispatchCascade candidateOrder/ignoreWorkerPin gates (WP-3)', () => {
  let testDir: string;

  /** Orchestrator-style lane: no session, no explicit attempts — the flow goes
   *  straight to the failover step, so the stub captures the exact opts. */
  const lane: DispatchLane = {
    resumeLogModule: 'test',
    executionMode: false,
    classifyFailures: false,
    suppressPrematureAsync: true,
    explicitWorkerAttempts: false,
    applySessionTunables: false,
    failoverPreferredWorker: () => undefined,
    switchBackLog: () => ({ module: 'test', text: 'switch-back' }),
    buildResumed: async () => 'prompt',
    buildFresh: async () => 'prompt',
  };

  const WORKERS = [
    { name: 'agy', command: 'node', args: ['-e', 'process.exitCode=1'] },
    { name: 'claude', command: 'node', args: ['-e', 'process.exitCode=1'] },
  ];

  const cascade = async (args: Record<string, unknown>): Promise<{ opts: any }> => {
    const seen: any[] = [];
    await runDispatchCascade({
      lane, state: makeState(), secrets: {}, resource: `topic-999_${testRunId}-cascade`,
      defaultWorker: 'agy', updateId: 1, userText: 'hello',
      workdir: { dir: testDir, tier: 'bot-cwd' },
      capture: async () => undefined,
      failover: async (_prompt: string, opts: any) => {
        seen.push(opts);
        return { worker: 'claude', result: { success: true, output: 'ok' } as any };
      },
      ...args,
    } as any);
    return { opts: seen[0] };
  };

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dispatch-cascade-test-'));
    process.env.PA_HOME = testDir;
    await writeFile(join(testDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
    await writeFile(join(testDir, 'rate-limit-state.json'), '{}', 'utf8');
  });

  afterEach(async () => {
    await waitForDrain();
    process.env.PA_HOME = sharedTempDir;
    await rmRetry(testDir);
  });

  it('fallback live: the chain is forwarded AND ignoreWorkerPin rides the default-ON deprecate-pins gate', async () => {
    await writeConfig(testDir, WORKERS, { model_router: { enabled: true, surfaces: { fallback: 'live' } } });
    const { opts } = await cascade({ candidateOrder: ['claude', 'agy'], routedTurn: true });
    assert.deepEqual(opts.candidateOrder, ['claude', 'agy']);
    assert.equal(opts.ignoreWorkerPin, true, 'block present + enabled + deprecate_pins absent = deprecated (decision 25 default ON)');
  });

  it('dark-mode twin: surfaces absent -> the failover seam receives NO candidateOrder (byte-identical dispatch)', async () => {
    await writeConfig(testDir, WORKERS, { model_router: { enabled: true } });
    const { opts } = await cascade({ candidateOrder: ['claude', 'agy'], routedTurn: true });
    assert.ok(!('candidateOrder' in opts), 'dark mode forwards nothing at the failover seam (M2)');
    assert.equal(opts.ignoreWorkerPin, true, 'the pin skip is gated by deprecate_pins, independently of the fallback surface');
  });

  it('deprecate_pins: false -> no ignoreWorkerPin even on a routed turn with a live fallback surface', async () => {
    await writeConfig(testDir, WORKERS, { model_router: { enabled: true, deprecate_pins: false, surfaces: { fallback: 'live' } } });
    const { opts } = await cascade({ candidateOrder: ['claude', 'agy'], routedTurn: true });
    assert.deepEqual(opts.candidateOrder, ['claude', 'agy']);
    assert.ok(!('ignoreWorkerPin' in opts), 'explicit flag-off restores the worker_pin reorder');
  });

  it('routedTurn unset (command turn, flag-off turn) -> no ignoreWorkerPin', async () => {
    await writeConfig(testDir, WORKERS, { model_router: { enabled: true, surfaces: { fallback: 'live' } } });
    const { opts } = await cascade({ candidateOrder: ['claude', 'agy'] });
    assert.deepEqual(opts.candidateOrder, ['claude', 'agy']);
    assert.ok(!('ignoreWorkerPin' in opts));
  });

  it('no model_router block at all -> neither field reaches the seam (wave invariant)', async () => {
    await writeConfig(testDir, WORKERS);
    const { opts } = await cascade({ candidateOrder: ['claude', 'agy'], routedTurn: true });
    assert.ok(!('candidateOrder' in opts));
    assert.ok(!('ignoreWorkerPin' in opts));
  });
});

// ---------------------------------------------------------------------------
// Router-metadata wave WP-2 (2026-09-20, decision 31): the cascade's getEnv —
// every attempt site stamps the per-hop PA_WORKER_* provenance (correction 1:
// the human lane previously stamped NOTHING) with the caller's turn-level
// PA_ROUTING_* bag merged after it; the failover arm additionally stamps
// PA_ROUTING_FAILOVERS = failedWorkers.size + onWorkerSwitch invocations (§1.3),
// so the SURVIVING hop records the count.
// ---------------------------------------------------------------------------

describe('runDispatchCascade routing-provenance getEnv (WP-2)', () => {
  let testDir: string;

  /** Human-style lane: explicit attempts ON so the preferred/default execute
   *  sites run; classification off (the count test needs no notify). */
  const lane: DispatchLane = {
    resumeLogModule: 'test',
    executionMode: false,
    classifyFailures: false,
    suppressPrematureAsync: true,
    explicitWorkerAttempts: true,
    applySessionTunables: true,
    failoverPreferredWorker: (state) => state.preferred_worker,
    switchBackLog: () => ({ module: 'test', text: 'switch-back' }),
    buildResumed: async () => 'prompt',
    buildFresh: async () => 'prompt',
  };

  const WORKERS = [
    { name: 'agy', command: 'node', args: ['-e', 'process.exitCode=1'] },
    { name: 'claude', command: 'node', args: ['-e', 'process.exitCode=1'] },
  ];

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dispatch-routing-test-'));
    process.env.PA_HOME = testDir;
    await writeFile(join(testDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
    await writeFile(join(testDir, 'rate-limit-state.json'), '{}', 'utf8');
    await writeConfig(testDir, WORKERS);
  });

  afterEach(async () => {
    await waitForDrain();
    process.env.PA_HOME = sharedTempDir;
    await rmRetry(testDir);
  });

  it('routingEnv merges into the explicit-attempt getEnv AFTER the worker provenance; FAILOVERS never stamps there', async () => {
    const execOpts: any[] = [];
    await runDispatchCascade({
      lane, state: makeState({ preferred_worker: 'agy' }), secrets: {},
      resource: `topic-999_${testRunId}-rout1`, defaultWorker: 'claude', updateId: 1, userText: 'hello',
      workdir: { dir: testDir, tier: 'bot-cwd' },
      routingEnv: { PA_ROUTING_DECISION: 'router', PA_ROUTING_STEER: 'wait', PA_ROUTING_STEER_BY: 'router' },
      execute: async (_w, _p, opts) => {
        execOpts.push(opts);
        return { success: false, output: '', exitCode: 1 } as any;
      },
      capture: async () => undefined,
      failover: async () => ({ worker: 'claude', result: { success: true, output: 'ok' } as any }),
    } as any);
    assert.ok(execOpts.length >= 1, 'the preferred attempt ran the execute seam');
    const env = execOpts[0].getEnv(WORKERS[0]) ?? {};
    assert.equal(env.PA_WORKER_CLI, 'agy', 'the hop identity still stamps first');
    assert.equal(env.PA_ROUTING_DECISION, 'router', 'the turn-level bag rides the SAME getEnv');
    assert.equal(env.PA_ROUTING_STEER, 'wait');
    assert.equal(env.PA_ROUTING_STEER_BY, 'router');
    assert.equal(execOpts[0].getEnv(WORKERS[1]).PA_WORKER_CLI, 'claude', 'per-hop resolution per hop');
    assert.ok(!('PA_ROUTING_FAILOVERS' in env), 'the count is failover-arm-only (an explicit-attempt success stamps NULL)');
  });

  it('failover-count stamp: 1 explicit failure + 1 switch → PA_ROUTING_FAILOVERS === "2" on the surviving hop (R10)', async () => {
    let failoverOptsSeen: any;
    await runDispatchCascade({
      lane, state: makeState({ preferred_worker: 'agy' }), secrets: {},
      resource: `topic-999_${testRunId}-rout2`, defaultWorker: undefined, updateId: 1, userText: 'hello',
      workdir: { dir: testDir, tier: 'bot-cwd' },
      routingEnv: { PA_ROUTING_DECISION: 'ladder' },
      execute: async () => ({ success: false, output: '', exitCode: 1 } as any),
      capture: async () => undefined,
      failover: async (_prompt: string, opts: any) => {
        failoverOptsSeen = opts;
        await opts.onWorkerSwitch({ from: 'agy', to: 'claude', kind: 'unavailable', reasonText: 'check failed' });
        return { worker: 'claude', result: { success: true, output: 'ok' } as any };
      },
    } as any);
    assert.ok(failoverOptsSeen, 'the failover seam ran');
    assert.equal(typeof failoverOptsSeen.getEnv, 'function', 'the failover arm sets getEnv too');
    const env = failoverOptsSeen.getEnv(WORKERS[1]) ?? {};
    assert.equal(env.PA_ROUTING_FAILOVERS, '2', 'failedWorkers.size (1) + onWorkerSwitch invocations (1)');
    assert.equal(env.PA_WORKER_CLI, 'claude');
    assert.equal(env.PA_ROUTING_DECISION, 'ladder');
  });

  it('without routingEnv: PA_WORKER_CLI stamps anyway (correction 1) and NO PA_ROUTING_* key does (fail-open)', async () => {
    const execOpts: any[] = [];
    let failoverOptsSeen: any;
    await runDispatchCascade({
      lane, state: makeState({ preferred_worker: 'agy' }), secrets: {},
      resource: `topic-999_${testRunId}-rout3`, defaultWorker: undefined, updateId: 1, userText: 'hello',
      workdir: { dir: testDir, tier: 'bot-cwd' },
      execute: async (_w, _p, opts) => {
        execOpts.push(opts);
        return { success: false, output: '', exitCode: 1 } as any;
      },
      capture: async () => undefined,
      failover: async (_prompt: string, opts: any) => {
        failoverOptsSeen = opts;
        return { worker: 'claude', result: { success: true, output: 'ok' } as any };
      },
    } as any);
    const preferredEnv = execOpts[0].getEnv(WORKERS[0]) ?? {};
    assert.equal(preferredEnv.PA_WORKER_CLI, 'agy', 'getEnv present even when routingEnv is undefined');
    assert.ok(!('PA_ROUTING_DECISION' in preferredEnv), 'no routing keys on a dark/unrouted turn');
    assert.ok(!('PA_ROUTING_FAILOVERS' in preferredEnv));
    const failoverEnv = failoverOptsSeen.getEnv(WORKERS[1]) ?? {};
    assert.equal(failoverEnv.PA_WORKER_CLI, 'claude');
    assert.ok(!('PA_ROUTING_DECISION' in failoverEnv));
    assert.equal(failoverEnv.PA_ROUTING_FAILOVERS, '1', 'the failed preferred attempt counts (failedWorkers.size), zero switches');
  });
});

// ---------------------------------------------------------------------------
// D-T5 — ESM guard: no require( in the new module
// ---------------------------------------------------------------------------

describe('dispatch.ts ESM guard', () => {
  it('dispatch.ts contains no require(', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', '..', 'src', 'dispatch.ts'), 'utf8');
    assert.ok(!src.includes('require('), 'dispatch.ts must stay ESM-clean — no require(');
  });
});

// ---------------------------------------------------------------------------
// WS3 provenance env (2026-09-18, per-hop revision): buildWorkerProvenanceEnv
// resolution rules — the hop's WorkerConfig arrives directly (RunOptions.getEnv
// hands worker-exec's candidate), so the CLI key ALWAYS stamps the hop that
// actually ran; model/effort resolve from that config and may stay absent
// (ledger NULL → PWA chip fails open); the record's model pin sits in the
// overrides slot (last-wins over the topic tunable_defaults slice).
// ---------------------------------------------------------------------------

describe('buildWorkerProvenanceEnv (WS3)', () => {
  /** Minimal worker fixture: declares BOTH model and effort so a
   *  topicDefaults slice actually resolves. */
  const tuningWorker = (name: string): WorkerConfig =>
    ({
      name,
      tunables: {
        model: { args: ['--model', '{value}'] },
        effort: { args: ['--effort', '{value}'] },
      },
    }) as unknown as WorkerConfig;

  it('the hop worker name always stamps PA_WORKER_CLI; a spec-less worker stamps nothing else', async () => {
    const { buildWorkerProvenanceEnv } = await import('../dispatch.js');
    // No tunables spec ⇒ no model/effort resolution at all (fail-open shape).
    assert.deepEqual(
      buildWorkerProvenanceEnv({ worker: { name: 'agy' } as WorkerConfig, topicDefaults: undefined, recordModel: undefined }),
      { PA_WORKER_CLI: 'agy' },
    );
    // A spec-declaring worker resolves its own fallbacks (KNOWN_CLI_DEFAULT_*)
    // even with no slice and no pin — model stamps, effort does not (agy has
    // no known default effort).
    const env = buildWorkerProvenanceEnv({ worker: tuningWorker('agy'), topicDefaults: undefined, recordModel: undefined });
    assert.equal(env.PA_WORKER_CLI, 'agy');
    assert.equal(env.PA_WORKER_MODEL, 'gemini-3.8-flash-high', 'KNOWN_CLI_DEFAULT_MODELS fallback');
    assert.ok(!('PA_WORKER_EFFORT' in env), 'agy has no KNOWN_CLI_DEFAULT_EFFORTS entry');
  });

  it('a failover hop stamps ITS OWN name — never the first-chosen worker', async () => {
    const { buildWorkerProvenanceEnv } = await import('../dispatch.js');
    // Two hops of one cascade, each evaluated with its own WorkerConfig:
    const first = buildWorkerProvenanceEnv({ worker: tuningWorker('agy'), topicDefaults: undefined, recordModel: undefined });
    const hopped = buildWorkerProvenanceEnv({ worker: tuningWorker('claude'), topicDefaults: undefined, recordModel: undefined });
    assert.equal(first.PA_WORKER_CLI, 'agy');
    assert.equal(hopped.PA_WORKER_CLI, 'claude', 'the failover hop records its own identity');
  });

  it('a topicDefaults slice for a DIFFERENT worker does not leak onto the hop', async () => {
    const { buildWorkerProvenanceEnv } = await import('../dispatch.js');
    const env = buildWorkerProvenanceEnv({
      worker: tuningWorker('claude'),
      topicDefaults: { agy: { model: 'agy-only-model', effort: 'low' } },
      recordModel: undefined,
    });
    assert.equal(env.PA_WORKER_CLI, 'claude');
    // The hop still resolves its OWN spec fallbacks (KNOWN_CLI_DEFAULT_*), so
    // keys may exist — the invariant is that the agy-slice VALUES never stamp.
    assert.notEqual(env.PA_WORKER_MODEL, 'agy-only-model', 'an agy-scoped default must never stamp on the claude hop');
    assert.notEqual(env.PA_WORKER_EFFORT, 'low');
  });

  it('record model pin wins over the topicDefaults slice', async () => {
    const { buildWorkerProvenanceEnv } = await import('../dispatch.js');
    const env = buildWorkerProvenanceEnv({
      worker: tuningWorker('agy'),
      topicDefaults: { agy: { model: 'topic-model', effort: 'high' } },
      recordModel: 'pin-model',
    });
    assert.equal(env.PA_WORKER_CLI, 'agy');
    assert.equal(env.PA_WORKER_MODEL, 'pin-model', 'the overrides slot is last-wins');
    assert.equal(env.PA_WORKER_EFFORT, 'high', 'effort still resolves from the slice');
  });

  it('topicDefaults slice resolves model/effort when no pin exists', async () => {
    const { buildWorkerProvenanceEnv } = await import('../dispatch.js');
    const env = buildWorkerProvenanceEnv({
      worker: tuningWorker('agy'),
      topicDefaults: { agy: { model: 'topic-model', effort: 'high' } },
      recordModel: undefined,
    });
    assert.deepEqual(env, { PA_WORKER_CLI: 'agy', PA_WORKER_MODEL: 'topic-model', PA_WORKER_EFFORT: 'high' });
  });
});
