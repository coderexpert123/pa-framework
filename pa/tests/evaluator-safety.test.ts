import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, createTempConfig, cleanup } from './helpers.js';
import type { WorkerConfig, CommandResult, RunOptions } from '../src/types.js';

// Minimal worker config for the evaluator to find
const WORKER: WorkerConfig = {
  name: 'claude',
  command: 'echo',
  args: ['ok'],
  check: 'echo ok',
  priority: 1,
  rate_limit_patterns: [],
};

function makeExecutor(output: string, success = true) {
  return async (_worker: WorkerConfig, _prompt: string, _opts: RunOptions): Promise<CommandResult> => ({
    success,
    output,
    exitCode: success ? 0 : 1,
  });
}

describe('evaluateWorkerState safety', () => {
  let dir: string;
  let stateDir: string;

  before(async () => {
    dir = await createTempPaHome();
    // Config with evaluator.worker = 'claude', stuckWorkerName will be 'gemini'
    await createTempConfig(dir, [WORKER], { evaluator: { worker: 'claude', timeout: 30 } });
    // State dir with a dummy state file for readStateTail
    stateDir = join(dir, 'state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'state.jsonl'), '{"type":"assistant","message":"working..."}\n', 'utf8');
  });

  after(async () => {
    await cleanup(dir);
  });

  it('returns extend verdict when evaluator returns non-JSON', async () => {
    const { evaluateWorkerState } = await import('../src/worker-evaluator.js');
    const result = await evaluateWorkerState(
      stateDir, '*.jsonl', 'gemini', {},
      makeExecutor('This is markdown text, not JSON at all.'),
    );
    assert.ok(result !== null, 'should return a verdict, not null');
    assert.equal(result!.verdict, 'extend');
    assert.ok(result!.summary.includes('parseable') || result!.summary.includes('not parseable'), 'summary should mention parse failure');
  });

  it('returns extend verdict when evaluator returns invalid verdict value', async () => {
    const { evaluateWorkerState } = await import('../src/worker-evaluator.js');
    const result = await evaluateWorkerState(
      stateDir, '*.jsonl', 'gemini', {},
      makeExecutor('{"verdict":"pause","summary":"thinking","reason":"not done yet"}'),
    );
    assert.ok(result !== null, 'should return a verdict, not null');
    assert.equal(result!.verdict, 'extend');
    assert.ok(result!.summary.includes('invalid verdict') || result!.summary.includes('defaulting'), 'summary should mention invalid verdict');
  });

  it('returns parsed verdict when evaluator returns valid JSON with kill', async () => {
    const { evaluateWorkerState } = await import('../src/worker-evaluator.js');
    const result = await evaluateWorkerState(
      stateDir, '*.jsonl', 'gemini', {},
      makeExecutor('{"verdict":"kill","summary":"agent is looping","reason":"repeating same tool calls"}'),
    );
    assert.ok(result !== null, 'should return a verdict');
    assert.equal(result!.verdict, 'kill');
    assert.equal(result!.summary, 'agent is looping');
    assert.equal(result!.reason, 'repeating same tool calls');
  });

  it('returns parsed verdict when evaluator returns valid JSON with extend', async () => {
    const { evaluateWorkerState } = await import('../src/worker-evaluator.js');
    const result = await evaluateWorkerState(
      stateDir, '*.jsonl', 'gemini', {},
      makeExecutor('{"verdict":"extend","summary":"reading files","reason":"making progress on task"}'),
    );
    assert.ok(result !== null, 'should return a verdict');
    assert.equal(result!.verdict, 'extend');
    assert.equal(result!.summary, 'reading files');
  });

  it('returns null when executor indicates failure', async () => {
    const { evaluateWorkerState } = await import('../src/worker-evaluator.js');
    const result = await evaluateWorkerState(
      stateDir, '*.jsonl', 'gemini', {},
      makeExecutor('', false),
    );
    assert.equal(result, null, 'failed executor should return null');
  });

  it('returns null when no executor provided', async () => {
    const { evaluateWorkerState } = await import('../src/worker-evaluator.js');
    const result = await evaluateWorkerState(stateDir, '*.jsonl', 'gemini', {});
    assert.equal(result, null, 'no executor should return null');
  });

  it('returns null when stuckWorkerName matches evaluator worker (anti-recursion)', async () => {
    const { evaluateWorkerState } = await import('../src/worker-evaluator.js');
    // evaluator.worker = 'claude', stuckWorkerName = 'claude' — should return null to prevent recursion
    const result = await evaluateWorkerState(
      stateDir, '*.jsonl', 'claude', {},
      makeExecutor('{"verdict":"kill","summary":"test","reason":"test"}'),
    );
    assert.equal(result, null, 'self-evaluation guard should return null');
  });

  it('handles JSON wrapped in markdown code fences', async () => {
    const { evaluateWorkerState } = await import('../src/worker-evaluator.js');
    const result = await evaluateWorkerState(
      stateDir, '*.jsonl', 'gemini', {},
      makeExecutor('```json\n{"verdict":"kill","summary":"stuck","reason":"looping"}\n```'),
    );
    assert.ok(result !== null);
    assert.equal(result!.verdict, 'kill');
  });
});
