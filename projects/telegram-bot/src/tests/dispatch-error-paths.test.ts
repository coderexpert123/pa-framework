/**
 * Tests for the dispatch error-path changes:
 * - tryClassifyAndNotify tri-state outcomes
 * - dispatchMessage early-return on non-rate-limit failures
 * - empty-response handling
 * - rate-limit cascade preserved
 *
 * Note: The 'transient' ClassifyOutcome (cls.minutes === 0) is not tested because
 * classifyRateLimit never returns minutes===0 with any real worker classifier —
 * it is a forward-compatibility branch.
 *
 * Isolation strategy:
 * - The rate-limit module has an in-memory cache. To avoid cross-test pollution,
 *   the tryClassifyAndNotify rate-limit test uses a non-standard worker name
 *   ('test-worker-rl') so its cooldown doesn't affect gemini or zclaude checks.
 * - The blackboard singleton uses the real ~/.pa/blackboard.json path regardless
 *   of PA_HOME. Tests use unique resource IDs to avoid lock contention.
 * - Config isolation: each dispatchMessage test writes its own config.yaml
 *   to a fresh PA_HOME temp dir.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ConversationState } from '../types.js';
import { rmRetry } from './rm-retry.js';

const testRunId = `test-${process.pid}-${Date.now()}`;

let sharedTempDir: string;

before(async () => {
  sharedTempDir = await mkdtemp(join(tmpdir(), 'dispatch-error-test-'));
  process.env.PA_HOME = sharedTempDir;
  await writeFile(join(sharedTempDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
  await writeFile(join(sharedTempDir, 'rate-limit-state.json'), '{}', 'utf8');
});

after(async () => {
  delete process.env.PA_HOME;
  await rmRetry(sharedTempDir);
});

// Dynamic imports after PA_HOME is set
const { tryClassifyAndNotify, dispatchMessage } = await import('../main.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<{
  success: boolean;
  output: string;
  error: string | undefined;
  exitCode: number | null;
}> = {}) {
  return { success: false, output: '', error: undefined, exitCode: 1, ...overrides } as any;
}

function makeState(extra: Partial<ConversationState> = {}): ConversationState {
  return { chat_id: 999, thread_id: 0, last_update_id: 0, turns: [], ...extra };
}

/** Write a JSON-format config.yaml (YAML is a superset of JSON — avoids quoting issues). */
async function writeConfig(dir: string, workers: object[]) {
  const config = {
    workers: workers.map((w: any, i: number) => ({
      name: w.name,
      command: w.command,
      args: w.args,
      input_mode: w.input_mode ?? 'stdin-text',
      output_format: w.output_format ?? 'text',
      check: 'cmd /c exit 0',
      rate_limit_patterns: w.rate_limit_patterns ?? [],
      priority: w.priority ?? i + 1,
      state_dir: '/nonexistent/path',
      state_pattern: '*.jsonl',
    })),
  };
  await writeFile(join(dir, 'config.yaml'), JSON.stringify(config), 'utf8');
}

// ---------------------------------------------------------------------------
// tryClassifyAndNotify — direct unit tests
// ---------------------------------------------------------------------------

describe('tryClassifyAndNotify outcomes', () => {
  it('returns not-rate-limit when claude has no session file', async () => {
    const worker = { name: 'claude', state_dir: '/nonexistent', state_pattern: '*.jsonl' };
    const config = { workers: [worker] };
    const result = makeResult({ error: 'Generic API error', exitCode: 1 });

    const outcome = await tryClassifyAndNotify(
      'claude', result as any, 'nonexistent-session-xyz',
      worker, config, makeState(), undefined, undefined,
    );
    assert.equal(outcome.outcome, 'not-rate-limit');
  });

  it('returns rate-limit with nextWorker for an unknown worker (always classified)', async () => {
    // Unknown worker name → classifyRateLimit falls through to default:
    //   { minutes: 2, classification: 'unknown', source: 'default' }
    // This exercises the rate-limit branch without polluting gemini/zclaude cooldowns.
    const worker = { name: 'test-worker-rl', state_dir: '/nonexistent', state_pattern: '*.jsonl' };
    const backupWorker = { name: 'claude', state_dir: '/nonexistent', state_pattern: '*.jsonl' };
    const config = { workers: [backupWorker, worker] };
    const result = makeResult({ error: 'some error', exitCode: 1 });

    const outcome = await tryClassifyAndNotify(
      'test-worker-rl', result as any, undefined,
      worker, config, makeState(), 'claude', undefined,
    );
    assert.equal(outcome.outcome, 'rate-limit');
    assert.ok('nextWorker' in outcome);
  });
});

// ---------------------------------------------------------------------------
// dispatchMessage early-return paths
// ---------------------------------------------------------------------------

describe('dispatchMessage non-rate-limit early-return', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dispatch-test-'));
    process.env.PA_HOME = testDir;
    await writeFile(join(testDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
    await writeFile(join(testDir, 'rate-limit-state.json'), '{}', 'utf8');
  });

  afterEach(async () => {
    process.env.PA_HOME = sharedTempDir;
    await rmRetry(testDir);
  });

  it('default zclaude non-rate-limit failure returns workerError:true', async () => {
    await writeConfig(testDir, [
      { name: 'zclaude', command: 'cmd', args: ['/c', 'exit', '1'], priority: 1 },
      { name: 'gemini', command: 'cmd', args: ['/c', 'exit', '1'], priority: 2 },
    ]);

    const resource = `topic-999_${testRunId}-1`;
    const result = await dispatchMessage('hello', undefined, undefined, makeState(), {}, resource, 'zclaude');

    assert.equal(result.workerError, true);
    assert.ok(result.response.startsWith('⚠️ zclaude failed'));
    assert.equal(result.dispatchedWorker, undefined);
  });

  it('default gemini non-rate-limit (empty rate_limit_patterns) returns workerError:true', async () => {
    await writeConfig(testDir, [
      { name: 'zclaude', command: 'cmd', args: ['/c', 'exit', '1'], priority: 1 },
      { name: 'gemini', command: 'cmd', args: ['/c', 'exit', '1'], priority: 2, rate_limit_patterns: [] },
    ]);

    const resource = `topic-999_${testRunId}-2`;
    const result = await dispatchMessage('hello', undefined, undefined, makeState(), {}, resource, 'gemini');

    assert.equal(result.workerError, true);
    assert.ok(result.response.startsWith('⚠️ gemini failed'));
    assert.equal(result.dispatchedWorker, undefined);
  });

  it('empty response (success=true, empty output) returns workerError:true with empty-response text', async () => {
    await writeConfig(testDir, [
      { name: 'zclaude', command: 'cmd', args: ['/c', 'exit', '0'], priority: 1 },
      { name: 'gemini', command: 'cmd', args: ['/c', 'exit', '1'], priority: 2 },
    ]);

    const resource = `topic-999_${testRunId}-3`;
    const result = await dispatchMessage('hello', undefined, undefined, makeState(), {}, resource, 'zclaude');

    assert.equal(result.workerError, true);
    assert.ok(result.response.includes('returned an empty response'));
    assert.equal(result.dispatchedWorker, undefined);
  });

  it('session is preserved in non-rate-limit early-return', async () => {
    await writeConfig(testDir, [
      { name: 'zclaude', command: 'cmd', args: ['/c', 'exit', '1'], priority: 1 },
      { name: 'gemini', command: 'cmd', args: ['/c', 'exit', '1'], priority: 2 },
    ]);

    const originalSession = { session_id: 'keep-this', worker: 'zclaude', started_at: new Date().toISOString() };
    const resource = `topic-999_${testRunId}-4`;
    const result = await dispatchMessage('hello', undefined, undefined, makeState({ session: originalSession }), {}, resource, 'zclaude');

    assert.equal(result.workerError, true);
    assert.deepEqual(result.session, originalSession);
  });

  it('preferred zclaude non-rate-limit returns workerError:true', async () => {
    await writeConfig(testDir, [
      { name: 'zclaude', command: 'cmd', args: ['/c', 'exit', '1'], priority: 1 },
      { name: 'gemini', command: 'cmd', args: ['/c', 'exit', '1'], priority: 2 },
    ]);

    const resource = `topic-999_${testRunId}-5`;
    const result = await dispatchMessage('hello', undefined, undefined, makeState({ preferred_worker: 'zclaude' }), {}, resource, 'gemini');

    assert.equal(result.workerError, true);
    assert.ok(result.response.startsWith('⚠️ zclaude failed'));
    assert.equal(result.dispatchedWorker, undefined);
  });

  it('rate-limit path preserved: rateLimitedWorker set, no workerError', async () => {
    // gemini with RESOURCE_EXHAUSTED in stderr → isRateLimited.hit=true → classifyRateLimit
    // → { minutes: 2, ... } → rate-limit path → rateLimitedWorker set → falls to runWithFailover.
    // zclaude fails too → buildWorkerResponse returns error string, no workerError.
    await writeConfig(testDir, [
      { name: 'zclaude', command: 'cmd', args: ['/c', 'exit', '1'], priority: 1 },
      {
        name: 'gemini',
        command: 'node',
        args: ['-e', "process.stderr.write('RESOURCE_EXHAUSTED quota');process.exit(1)"],
        priority: 2,
        rate_limit_patterns: ['RESOURCE_EXHAUSTED'],
      },
    ]);

    const resource = `topic-999_${testRunId}-6`;
    const result = await dispatchMessage('hello', undefined, undefined, makeState(), {}, resource, 'gemini');

    assert.equal(result.workerError, undefined);
    assert.equal(result.rateLimitedWorker, 'gemini');
  });
});
