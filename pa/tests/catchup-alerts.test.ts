import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, cleanup } from './helpers.js';
import { writeLog } from '../src/logger.js';
import type { RunMeta } from '../src/types.js';

function makeMeta(status: RunMeta['status'], offsetMs: number): RunMeta {
  return {
    worker: 'zclaude',
    status,
    exitCode: status === 'success' ? 0 : 1,
    duration: 100,
    timestamp: new Date(Date.now() - offsetMs).toISOString(),
  };
}

describe('getLastSuccessfulRun', () => {
  let dir: string;

  before(async () => {
    dir = await createTempPaHome();
  });

  after(async () => {
    await cleanup(dir);
  });

  it('returns the most recent success, skipping errors', async () => {
    const { getLastSuccessfulRun } = await import('../src/logger.js');

    // Write 3 logs: newest error, then success, then oldest error
    const errorNew = makeMeta('error', 1000);
    const success = makeMeta('success', 2000);
    const errorOld = makeMeta('error', 3000);

    // Write in chronological order (oldest first) — readLogs returns newest first
    await writeLog('test-skill', 'output-old-error', errorOld);
    await writeLog('test-skill', 'output-success', success);
    await writeLog('test-skill', 'output-new-error', errorNew);

    const result = await getLastSuccessfulRun('test-skill');
    assert.ok(result !== null, 'should find a successful run');
    assert.equal(result.status, 'success');
  });

  it('returns null when all logs are errors', async () => {
    const { getLastSuccessfulRun } = await import('../src/logger.js');

    await writeLog('error-only-skill', 'output', makeMeta('error', 1000));
    await writeLog('error-only-skill', 'output', makeMeta('error', 2000));

    const result = await getLastSuccessfulRun('error-only-skill');
    assert.equal(result, null);
  });

  it('returns null when no logs exist', async () => {
    const { getLastSuccessfulRun } = await import('../src/logger.js');
    const result = await getLastSuccessfulRun('nonexistent-skill');
    assert.equal(result, null);
  });
});
