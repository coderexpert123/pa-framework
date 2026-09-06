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
const { buildFailoverReasonText, maybeDropAgySession, dispatchMessage } = await import('../dispatch.js');
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
// D-T5 — ESM guard: no require( in the new module
// ---------------------------------------------------------------------------

describe('dispatch.ts ESM guard', () => {
  it('dispatch.ts contains no require(', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', '..', 'src', 'dispatch.ts'), 'utf8');
    assert.ok(!src.includes('require('), 'dispatch.ts must stay ESM-clean — no require(');
  });
});
