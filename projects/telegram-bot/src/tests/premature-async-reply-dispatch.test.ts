import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ConversationState } from '../types.js';
import type { ReaperDeps } from '../orphan-reaper.js';
import type { PendingDispatch } from '../pending-dispatches.js';
import { rmRetry } from './rm-retry.js';
import { waitForDrain } from './test-teardown-guard.js';

const testRunId = `test-prem-async-${process.pid}-${Date.now()}`;
let sharedTempDir: string;

before(async () => {
  sharedTempDir = await mkdtemp(join(tmpdir(), 'prem-async-dispatch-'));
  process.env.PA_HOME = sharedTempDir;
  await writeFile(join(sharedTempDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
  await writeFile(join(sharedTempDir, 'rate-limit-state.json'), '{}', 'utf8');
});

after(async () => {
  delete process.env.PA_HOME;
  await rmRetry(sharedTempDir);
});

const { dispatchMessage } = await import('../main.js');
const { _clearStoppedForTest } = await import('../worker-stop.js');
const { evaluatePendingDispatch, TRANSCRIPT_QUIESCENT_MS } = await import('../orphan-reaper.js');
const { addPendingDispatch, _resetPendingDispatchesForTest } = await import('../pending-dispatches.js');
const { _resetDeliveredCacheForTest } = await import('../delivered-store.js');
const { _resetRecoveryGateForTest } = await import('../recovery-gate.js');
const { _resetResendStoreForTest } = await import('../resend-store.js');

function makeState(extra: Partial<ConversationState> = {}): ConversationState {
  return { chat_id: 999, thread_id: 1, last_update_id: 0, turns: [], ...extra };
}

function makeWorkerScript(output: string, exitCode = 0): string[] {
  const b64 = Buffer.from(output, 'utf8').toString('base64');
  return ['-e', `process.stdout.write(Buffer.from('${b64}', 'base64').toString('utf8')); process.exitCode = ${exitCode};`];
}

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

describe('premature-async-reply-dispatch (AI-202)', () => {
  let testDir: string;
  let testCount = 0;

  beforeEach(async () => {
    testCount++;
    testDir = await mkdtemp(join(sharedTempDir, `case-${testCount}-`));
    process.env.PA_HOME = testDir;
    await writeFile(join(testDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
    await writeFile(join(testDir, 'rate-limit-state.json'), '{}', 'utf8');
    _clearStoppedForTest();
    _resetPendingDispatchesForTest();
    _resetDeliveredCacheForTest();
    _resetRecoveryGateForTest();
    _resetResendStoreForTest();
  });

  afterEach(async () => {
    await waitForDrain();
    _clearStoppedForTest();
    _resetPendingDispatchesForTest();
    _resetDeliveredCacheForTest();
    _resetRecoveryGateForTest();
    _resetResendStoreForTest();
    await rmRetry(testDir);
  });

  it('1. REPRO: fake worker prints incident promise text and exits 0 -> suppressed to workerError empty response', async () => {
    const incidentPromise = 'I have launched the git log check and will review the output once it completes.';
    await writeConfig(testDir, [
      {
        name: 'agy',
        command: 'node',
        args: makeWorkerScript(incidentPromise, 0),
        priority: 1,
      },
    ]);

    const resource = `topic-999_${testRunId}-repro`;
    const result = await dispatchMessage('run git log check', undefined, undefined, makeState(), {}, resource, 'agy');

    assert.equal(result.workerError, true);
    assert.equal(result.meta, null);
    assert.ok(result.response.startsWith('⚠️'), `response must start with ⚠️ but was: ${result.response}`);
    assert.ok(result.response.includes('returned an empty response'), `response must mention empty response but was: ${result.response}`);
    assert.equal(result.response.includes('I have launched'), false, 'promise text must NOT be delivered');
  });

  it('2. Control: fake worker prints promise + legitimate sentence and path (>240 chars, C:/) -> delivered normally', async () => {
    const legitimateText = 'I have launched the git log check and will review the output once it completes. All preliminary repository integrity checks have passed successfully. The detailed commit trace has been saved to C:/pa-checkout/logs/git-log-audit.log for operator inspection. Total 128 commits analyzed.';
    assert.ok(legitimateText.length > 240);
    assert.ok(legitimateText.includes('C:/'));

    await writeConfig(testDir, [
      {
        name: 'agy',
        command: 'node',
        args: makeWorkerScript(legitimateText, 0),
        priority: 1,
      },
    ]);

    const resource = `topic-999_${testRunId}-ctrl`;
    const result = await dispatchMessage('run check', undefined, undefined, makeState(), {}, resource, 'agy');

    assert.equal(result.workerError, undefined);
    assert.ok(result.response.includes('C:/pa-checkout/logs/git-log-audit.log'));
    assert.ok(result.response.includes('Total 128 commits analyzed.'));
  });

  it('3. watch_job survives: fake worker prints promise + valid watch_job PA_META -> meta !== null, delivered', async () => {
    const outputWithMeta = 'I have launched the git log check and will review the output once it completes.\n[PA_META]: {"actions":[{"type":"watch_job","description":"git log check finished","check":{"type":"file_exists","path":"C:/pa-checkout/logs/check.done"},"deadline_minutes":60}]}';

    await writeConfig(testDir, [
      {
        name: 'agy',
        command: 'node',
        args: makeWorkerScript(outputWithMeta, 0),
        priority: 1,
      },
    ]);

    const resource = `topic-999_${testRunId}-watch`;
    const result = await dispatchMessage('check git log', undefined, undefined, makeState(), {}, resource, 'agy');

    assert.equal(result.workerError, undefined);
    assert.notEqual(result.meta, null);
    assert.ok(result.response.includes('I have launched the git log check'));
    assert.equal(result.meta?.actions?.[0]?.type, 'watch_job');
    assert.equal(result.meta?.actions?.[0]?.description, 'git log check finished');
  });

  it('4. Reaper fall-through: harvest source with incident promise is NOT sent, evaluation falls through', async () => {
    const incidentPromise = 'I have launched the git log check and will review the output once it completes.';
    const T0 = '2026-07-03T15:00:00.000Z';
    const rec: PendingDispatch = {
      updateId: 77,
      chatId: -100555,
      threadId: 9,
      messageId: 321,
      userText: 'check the repo status',
      startedAt: T0,
      cwd: 'C:/pa-checkout',
      session: { session_id: 'sess-claude-1', worker: 'claude', started_at: T0 },
    };
    await addPendingDispatch(rec);

    const sent: Array<{ record: PendingDispatch; text: string; replyMarkup?: unknown }> = [];
    const deps: ReaperDeps = {
      send: async (record, text, replyMarkup) => {
        sent.push({ record, text, replyMarkup });
        return true;
      },
      readTranscript: async () => ({
        content: JSON.stringify({
          type: 'assistant',
          timestamp: '2026-07-03T15:10:00Z',
          message: { content: [{ type: 'text', text: incidentPromise }] },
        }) + '\n',
        mtimeMs: Date.now() - TRANSCRIPT_QUIESCENT_MS - 1000,
      }),
      isTopicWorkerAlive: async () => false,
      now: () => Date.now(),
    };

    // Deadline in the past -> expired
    const expiredDeadline = Date.now() - 1000;
    const outcome = await evaluatePendingDispatch(rec, deps, expiredDeadline);

    // Assert the promise text was never delivered to the user via deps.send
    const deliveredPromise = sent.find((s) => s.text.includes(incidentPromise));
    assert.equal(deliveredPromise, undefined, 'Reaper must not send the premature promise text');
    // Evaluation fell through to death notice
    assert.equal(outcome, 'dead');
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes("couldn't be completed"));
  });

  it('5. Confirmation-mode untouched: pending description in scope -> promise text delivered unchanged', async () => {
    const incidentPromise = 'I have launched the git log check and will review the output once it completes.';
    await writeConfig(testDir, [
      {
        name: 'agy',
        command: 'node',
        args: makeWorkerScript(incidentPromise, 0),
        priority: 1,
      },
    ]);

    const resource = `topic-999_${testRunId}-confirm`;
    // Pass pendingDesc='Execute git log inspect' -> confirmation mode
    const result = await dispatchMessage('yes', undefined, 'Execute git log inspect', makeState(), {}, resource, 'agy');

    assert.equal(result.workerError, undefined);
    assert.ok(result.response.includes(incidentPromise), 'confirmation mode must deliver output unchanged');
  });
});
