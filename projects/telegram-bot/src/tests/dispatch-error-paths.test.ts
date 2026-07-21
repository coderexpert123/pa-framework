/**
 * Tests for the dispatch error-path changes:
 * - tryClassifyAndNotify tri-state outcomes
 * - dispatchMessage falls over to the next worker on non-rate-limit failures
 *   (previously this early-returned an error instead of cascading, the way
 *   skill runs already do via runWithFailover)
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
const { markTopicStopped, _clearStoppedForTest } = await import('../worker-stop.js');

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
      check: 'echo ok',
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
// dispatchMessage failover-cascade paths
// ---------------------------------------------------------------------------

describe('dispatchMessage non-rate-limit failover cascade', () => {
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

  it('default zclaude non-rate-limit failure falls over to gemini', async () => {
    await writeConfig(testDir, [
      { name: 'zclaude', command: 'node', args: ['-e', 'process.exitCode=1'], priority: 1 },
      { name: 'gemini', command: 'node', args: ['-e', "process.stdout.write('gemini took over'); process.exitCode=0"], priority: 2 },
    ]);

    const resource = `topic-999_${testRunId}-1`;
    const result = await dispatchMessage('hello', undefined, undefined, makeState(), {}, resource, 'zclaude');

    assert.equal(result.dispatchedWorker, 'gemini');
    assert.ok(result.response.includes('gemini took over'));
    assert.equal(result.workerError, undefined);
  });

  it('default gemini non-rate-limit (empty rate_limit_patterns) falls over to zclaude', async () => {
    await writeConfig(testDir, [
      { name: 'zclaude', command: 'node', args: ['-e', "process.stdout.write('zclaude took over'); process.exitCode=0"], priority: 1 },
      { name: 'gemini', command: 'node', args: ['-e', 'process.exitCode=1'], priority: 2, rate_limit_patterns: [] },
    ]);

    const resource = `topic-999_${testRunId}-2`;
    const result = await dispatchMessage('hello', undefined, undefined, makeState(), {}, resource, 'gemini');

    assert.equal(result.dispatchedWorker, 'zclaude');
    assert.ok(result.response.includes('zclaude took over'));
    assert.equal(result.workerError, undefined);
  });

  it('empty response (success=true, empty output) returns workerError:true with empty-response text', async () => {
    await writeConfig(testDir, [
      { name: 'zclaude', command: 'node', args: ['-e', 'process.exitCode=0'], priority: 1 },
      { name: 'gemini', command: 'node', args: ['-e', 'process.exitCode=1'], priority: 2 },
    ]);

    const resource = `topic-999_${testRunId}-3`;
    const result = await dispatchMessage('hello', undefined, undefined, makeState(), {}, resource, 'zclaude');

    assert.equal(result.workerError, true);
    assert.ok(result.response.includes('returned an empty response'));
    assert.equal(result.dispatchedWorker, undefined);
  });

  it('all workers failing exhausts the cascade and clears the stale session', async () => {
    // Both configured workers fail (non-rate-limit) -> falls through preferred/default
    // attempts into the full runWithFailover cascade -> exhausted. workerError is true
    // (the dispatch genuinely failed end to end) and dispatchedWorker is undefined
    // (the last-tried worker never actually succeeded, so it must not be reported as
    // "dispatched" — otherwise the caller would pin the status card to a broken worker).
    // The original session is dropped rather than kept, matching the pre-existing
    // behavior of a rate-limit-triggered cascade exhaustion (this code path is now
    // shared by both failure kinds).
    // Uses zclaude+claude (not gemini/agy): those two resolve sessionId straight from
    // CommandResult with no fallback, whereas gemini/agy fall back to scanning the
    // real local session directory on disk even after a failure, which would leak an
    // unrelated real session id into this assertion.
    await writeConfig(testDir, [
      { name: 'zclaude', command: 'node', args: ['-e', 'process.exitCode=1'], priority: 1 },
      { name: 'claude', command: 'node', args: ['-e', 'process.exitCode=1'], priority: 2 },
    ]);

    const originalSession = { session_id: 'keep-this', worker: 'zclaude', started_at: new Date().toISOString() };
    const resource = `topic-999_${testRunId}-4`;
    const result = await dispatchMessage('hello', undefined, undefined, makeState({ session: originalSession }), {}, resource, 'zclaude');

    assert.equal(result.workerError, true);
    assert.equal(result.dispatchedWorker, undefined);
    assert.equal(result.session, undefined);
    assert.ok(result.response.length > 0, 'still returns a user-facing failure message, not a crash/blank');
  });

  it('preferred zclaude non-rate-limit falls over to default gemini', async () => {
    await writeConfig(testDir, [
      { name: 'zclaude', command: 'node', args: ['-e', 'process.exitCode=1'], priority: 1 },
      { name: 'gemini', command: 'node', args: ['-e', "process.stdout.write('gemini fallback'); process.exitCode=0"], priority: 2 },
    ]);

    const resource = `topic-999_${testRunId}-5`;
    const result = await dispatchMessage('hello', undefined, undefined, makeState({ preferred_worker: 'zclaude' }), {}, resource, 'gemini');

    assert.equal(result.dispatchedWorker, 'gemini');
    assert.ok(result.response.includes('gemini fallback'));
    assert.equal(result.workerError, undefined);
  });

  it('rate-limit path preserved: rateLimitedWorker set, workerError reflects overall failure', async () => {
    // gemini with RESOURCE_EXHAUSTED in stderr → isRateLimited.hit=true → classifyRateLimit
    // → { minutes: 2, ... } → rate-limit path → rateLimitedWorker set → falls to runWithFailover.
    // zclaude (the only fallback) fails too, non-rate-limit → cascade exhausted →
    // buildWorkerResponse returns a generic error string, and workerError is true
    // because the dispatch genuinely failed end to end despite rateLimitedWorker
    // having been recorded along the way.
    await writeConfig(testDir, [
      { name: 'zclaude', command: 'node', args: ['-e', 'process.exitCode=1'], priority: 1 },
      {
        name: 'gemini',
        command: 'node',
        // Embedded-double-quote form: the inner JS string uses double quotes
        // instead of single, so POSIX's quoteArg (which wraps this whole arg
        // in single quotes) has nothing to escape — the old single-quoted
        // form needed the '\'' escape dance, which the old fixture only
        // survived on ubuntu by accident (a shell parse-error message that
        // happened to still contain "RESOURCE_EXHAUSTED" and exit non-zero).
        args: ['-e', 'process.stderr.write("RESOURCE_EXHAUSTED quota");process.exitCode=1'],
        priority: 2,
        rate_limit_patterns: ['RESOURCE_EXHAUSTED'],
      },
    ]);

    const resource = `topic-999_${testRunId}-6`;
    const result = await dispatchMessage('hello', undefined, undefined, makeState(), {}, resource, 'gemini');

    assert.equal(result.workerError, true);
    assert.equal(result.dispatchedWorker, undefined);
    assert.equal(result.rateLimitedWorker, 'gemini');
  });
});

// ---------------------------------------------------------------------------
// AI-092: /stop marker aborts fresh/failover spawns for CANCELLED dispatches only
// ---------------------------------------------------------------------------

describe('dispatchMessage stop-marker guard', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dispatch-stop-test-'));
    process.env.PA_HOME = testDir;
    await writeFile(join(testDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
    await writeFile(join(testDir, 'rate-limit-state.json'), '{}', 'utf8');
    _clearStoppedForTest();
  });

  afterEach(async () => {
    process.env.PA_HOME = sharedTempDir;
    _clearStoppedForTest();
    await rmRetry(testDir);
  });

  it('aborts (empty response, no spawn) when the dispatch is older than the /stop', async () => {
    await writeConfig(testDir, [
      { name: 'zclaude', command: 'node', args: ['-e', 'process.exitCode=1'], priority: 1 },
    ]);
    const resource = `topic-999_${testRunId}-stop1`;
    markTopicStopped(resource.replace(/^topic-/, ''), 'stop', 1000);

    const result = await dispatchMessage('hello', undefined, undefined, makeState(), {}, resource, 'zclaude', undefined, undefined, 999 /* older than /stop */);

    assert.equal(result.workerError, true);
    assert.equal(result.response, '', 'aborted before any spawn — no worker-error text');
    assert.equal(result.dispatchedWorker, undefined);
  });

  it('does NOT abort a dispatch newer than the /stop (user\'s next message)', async () => {
    await writeConfig(testDir, [
      { name: 'zclaude', command: 'node', args: ['-e', 'process.exitCode=1'], priority: 1 },
      { name: 'gemini', command: 'node', args: ['-e', "process.stdout.write('gemini reply'); process.exitCode=0"], priority: 2 },
    ]);
    const resource = `topic-999_${testRunId}-stop2`;
    markTopicStopped(resource.replace(/^topic-/, ''), 'stop', 1000);

    const result = await dispatchMessage('hello', undefined, undefined, makeState(), {}, resource, 'zclaude', undefined, undefined, 1001 /* newer than /stop */);

    assert.equal(result.dispatchedWorker, 'gemini', 'spawn actually happened, zclaude failed, cascaded to gemini instead of aborting');
    assert.ok(result.response.includes('gemini reply'));
  });
});
