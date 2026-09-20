import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, createTempConfig, cleanup } from './helpers.js';
import { evaluateWorkerState, evaluatorTimeoutMultiplier } from '../src/worker-evaluator.js';
import { recordRateLimit, clearRateLimitCache } from '../src/rate-limits.js';
import type { WorkerConfig, CommandResult, RunOptions } from '../src/types.js';

const KILL_JSON = '{"verdict":"kill","summary":"agent is looping","reason":"repeating same tool calls"}';

function makeWorker(name: string, priority: number, extra: Record<string, any> = {}): any {
  return {
    name,
    command: 'echo',
    args: ['ok'],
    check: 'echo ok',
    priority,
    rate_limit_patterns: [],
    ...extra,
  };
}

// Priority order mirrors production: agy(1) / agyc(2, manual_only) / zclaude(3) / claude(4).
const CHAIN_WORKERS = [
  makeWorker('agy', 1),
  makeWorker('agyc', 2, { manual_only: true }),
  makeWorker('zclaude', 3),
  makeWorker('claude', 4),
];

interface ChainRecord {
  attempted: string[];
  lastOpts?: RunOptions;
  calls: number;
  // When true, the first attempt fails (empty output) so the chain exercises
  // the fallback path; subsequent attempts return the kill verdict. Uniform
  // success would break after the first worker per the loop's break-on-success.
  failFirstAttempt?: boolean;
}

function makeChainExecutor(rec: ChainRecord) {
  return async (worker: WorkerConfig, _prompt: string, opts: RunOptions): Promise<CommandResult> => {
    rec.attempted.push(worker.name);
    rec.lastOpts = opts;
    rec.calls += 1;
    if (rec.failFirstAttempt && rec.calls === 1) {
      return { success: false, output: '', exitCode: 1 };
    }
    return { success: true, output: KILL_JSON, exitCode: 0 };
  };
}

async function makeStateDir(dir: string): Promise<string> {
  const stateDir = join(dir, 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'state.jsonl'), '{"type":"assistant","message":"working..."}\n', 'utf8');
  return stateDir;
}

describe('evaluateWorkerState chain', () => {
  it('excludes manual_only workers from the automatic chain', async () => {
    const dir = await createTempPaHome();
    try {
      await createTempConfig(dir, CHAIN_WORKERS, { evaluator: { worker: 'agy', timeout: 60 } });
      clearRateLimitCache();
      const stateDir = await makeStateDir(dir);
      const rec: ChainRecord = { attempted: [], calls: 0, failFirstAttempt: true };
      const result = await evaluateWorkerState(stateDir, '*.jsonl', 'agy', {}, makeChainExecutor(rec));
      assert.ok(result !== null && result.verdict === 'kill');
      assert.deepEqual(rec.attempted, ['zclaude', 'claude']);
    } finally {
      await cleanup(dir);
    }
  });

  it('skips a manual_only primary uniformly (no explicit-selection escape in automatic dispatch)', async () => {
    const dir = await createTempPaHome();
    try {
      await createTempConfig(dir, CHAIN_WORKERS, { evaluator: { worker: 'agyc', timeout: 60 } });
      clearRateLimitCache();
      const stateDir = await makeStateDir(dir);
      const rec: ChainRecord = { attempted: [], calls: 0 };
      const result = await evaluateWorkerState(stateDir, '*.jsonl', 'agy', {}, makeChainExecutor(rec));
      assert.ok(result !== null && result.verdict === 'kill');
      assert.ok(!rec.attempted.includes('agyc'), `agyc must never be attempted, got ${JSON.stringify(rec.attempted)}`);
    } finally {
      await cleanup(dir);
    }
  });

  it('honors rate-limit cooldowns in the chain', async () => {
    const dir = await createTempPaHome();
    try {
      await createTempConfig(dir, CHAIN_WORKERS, { evaluator: { worker: 'agy', timeout: 60 } });
      clearRateLimitCache();
      await recordRateLimit('zclaude', 10, 'spec-seed');
      const stateDir = await makeStateDir(dir);
      const rec: ChainRecord = { attempted: [], calls: 0 };
      const result = await evaluateWorkerState(stateDir, '*.jsonl', 'agy', {}, makeChainExecutor(rec));
      assert.ok(result !== null && result.verdict === 'kill');
      assert.ok(!rec.attempted.includes('zclaude'), `cooling zclaude must be skipped, got ${JSON.stringify(rec.attempted)}`);
      assert.deepEqual(rec.attempted, ['claude']);
    } finally {
      clearRateLimitCache();
      await cleanup(dir);
    }
  });

  it('returns null with zero executor calls when the chain is empty', async () => {
    const dir = await createTempPaHome();
    try {
      await createTempConfig(dir, [
        makeWorker('agy', 1, { manual_only: true }),
        makeWorker('agyc', 2, { manual_only: true }),
      ], { evaluator: { worker: 'agy', timeout: 60 } });
      clearRateLimitCache();
      const stateDir = await makeStateDir(dir);
      const rec: ChainRecord = { attempted: [], calls: 0 };
      const result = await evaluateWorkerState(stateDir, '*.jsonl', 'agy', {}, makeChainExecutor(rec));
      assert.equal(result, null);
      assert.equal(rec.calls, 0);
    } finally {
      await cleanup(dir);
    }
  });

  it('never attempts the stuck worker', async () => {
    const dir = await createTempPaHome();
    try {
      await createTempConfig(dir, CHAIN_WORKERS, { evaluator: { worker: 'agy', timeout: 60 } });
      clearRateLimitCache();
      const stateDir = await makeStateDir(dir);
      const rec: ChainRecord = { attempted: [], calls: 0 };
      const result = await evaluateWorkerState(stateDir, '*.jsonl', 'zclaude', {}, makeChainExecutor(rec));
      assert.ok(result !== null && result.verdict === 'kill');
      assert.ok(!rec.attempted.includes('zclaude'), `stuck worker must never be attempted, got ${JSON.stringify(rec.attempted)}`);
    } finally {
      await cleanup(dir);
    }
  });

  it('evaluatorTimeoutMultiplier scales 1x-3x with floor, ceiling, and kill switch', async () => {
    assert.equal(evaluatorTimeoutMultiplier(null), 1);
    assert.equal(
      evaluatorTimeoutMultiplier({ physFreeMb: 4000, cpuPct: 10, diskQueue: 0, sampledAtMs: Date.now() }),
      1,
    );
    assert.equal(
      evaluatorTimeoutMultiplier({ physFreeMb: 100, cpuPct: 10, diskQueue: 0, sampledAtMs: Date.now() }),
      3,
    );
    assert.equal(
      evaluatorTimeoutMultiplier({ physFreeMb: 300, cpuPct: 10, diskQueue: 0, sampledAtMs: Date.now() }),
      2,
    );
    assert.equal(
      evaluatorTimeoutMultiplier({ physFreeMb: 100, cpuPct: 10, diskQueue: 20, sampledAtMs: Date.now() }),
      3,
    );
    assert.equal(
      evaluatorTimeoutMultiplier({ physFreeMb: null, cpuPct: null, diskQueue: null, sampledAtMs: Date.now() }),
      1,
    );
    const saved = process.env.PA_DYNAMIC_SLOTS;
    process.env.PA_DYNAMIC_SLOTS = '0';
    try {
      assert.equal(
        evaluatorTimeoutMultiplier({ physFreeMb: 10, cpuPct: 99, diskQueue: 50, sampledAtMs: Date.now() }),
        1,
      );
    } finally {
      if (saved === undefined) delete process.env.PA_DYNAMIC_SLOTS;
      else process.env.PA_DYNAMIC_SLOTS = saved;
    }
  });

  it('passes lean, floor-valued opts to the executor', async () => {
    const dir = await createTempPaHome();
    const pressure = await import('../src/lib/pressure-sample.js');
    pressure._resetForTest();
    pressure._setDepsForTest({
      platform: () => 'linux',
      freemem: () => 8 * 1024 * 1024 * 1024,
      cpus: () => [{ model: 'test', speed: 1000, times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } } as any],
    });
    try {
      await createTempConfig(dir, CHAIN_WORKERS, { evaluator: { worker: 'agy', timeout: 60 } });
      clearRateLimitCache();
      const stateDir = await makeStateDir(dir);
      const rec: ChainRecord = { attempted: [], calls: 0 };
      const result = await evaluateWorkerState(stateDir, '*.jsonl', 'claude', {}, makeChainExecutor(rec));
      assert.ok(result !== null && result.verdict === 'kill');
      assert.deepEqual(rec.lastOpts?.stripArgs, ['--append-system-prompt-file']);
      assert.equal(rec.lastOpts?.isEvaluator, true);
      assert.equal(rec.lastOpts?.timeout, 60);
      assert.equal(rec.lastOpts?.idleTimeout, 30);
    } finally {
      pressure._resetForTest();
      await cleanup(dir);
    }
  });
});
