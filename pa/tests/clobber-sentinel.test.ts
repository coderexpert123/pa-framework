import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clobberSentinelJob, runClobberSentinel } from '../src/lib/maintenance/jobs/clobber-sentinel.js';
import type { DriftFinding } from '../src/lib/tree-drift.js';

// Tests use the runClobberSentinel(deps) DI seam — ESM module namespaces are
// read-only, so dependencies are injected rather than mocked (the pattern the
// maintenance jobs' tests follow since the P2-19/P2-16 injection rework).

function finding(path: string): DriftFinding {
  return {
    path,
    kind: 'reverted-to-ancestor',
    ancestorSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    blobSha: 'c'.repeat(40),
  };
}

describe('clobber-sentinel job', () => {
  it('has the correct job metadata', () => {
    assert.equal(clobberSentinelJob.name, 'clobber-sentinel');
    assert.equal(clobberSentinelJob.host, 'pa');
    assert.equal(clobberSentinelJob.everyMs, 30 * 60 * 1000); // 30 minutes
    assert.equal(clobberSentinelJob.destructive, false);
    assert.equal(clobberSentinelJob.shedWhenDegraded, true);
    assert.deepEqual(clobberSentinelJob.targets, []);
  });

  it('skips when @build reservation is held', async () => {
    const result = await runClobberSentinel({
      readActiveFn: async () => [{ paths: ['@build'] }],
      detectDriftFn: async () => { throw new Error('must not be called'); },
    });
    assert.equal(result.touched, 0);
    assert.deepEqual(result.detail, { skipped: 'lock-held' });
  });

  it('skips when git-workflow exclusive_resource lock is held', async () => {
    const result = await runClobberSentinel({
      readActiveFn: async () => [{ paths: ['exclusive_resource:git-workflow'] }],
      detectDriftFn: async () => { throw new Error('must not be called'); },
    });
    assert.equal(result.touched, 0);
    assert.deepEqual(result.detail, { skipped: 'lock-held' });
  });

  it('proceeds when no conflicting locks are held', async () => {
    const result = await runClobberSentinel({
      readActiveFn: async () => [],
      detectDriftFn: async () => [],
    });
    assert.equal(result.touched, 0);
    assert.deepEqual(result.detail, { findings: 0 });
  });

  it('returns error detail when detectDrift fails', async () => {
    const result = await runClobberSentinel({
      readActiveFn: async () => [],
      detectDriftFn: async () => { throw new Error('git status failed'); },
    });
    assert.equal(result.touched, 0);
    assert.deepEqual(result.detail, { error: 'detect-failed' });
  });

  it('notifies per-file when drift findings exist', async () => {
    const notifyCalls: Array<{ subject: string; body: string; opts?: Record<string, unknown> }> = [];
    const result = await runClobberSentinel({
      readActiveFn: async () => [],
      detectDriftFn: async () => [finding('pa/src/foo.ts'), finding('pa/src/bar.ts')],
      notifyFn: async (subject, body, opts) => {
        notifyCalls.push({ subject, body, opts });
        return { sent: true, suppressed: false };
      },
    });

    assert.equal(result.touched, 2);
    assert.equal(result.detail.findings, 2);
    assert.equal(result.detail.notified, 2);

    assert.equal(notifyCalls.length, 2);
    assert.equal(notifyCalls[0].opts?.dedupKey, 'clobber-sentinel:pa/src/foo.ts');
    assert.equal(notifyCalls[1].opts?.dedupKey, 'clobber-sentinel:pa/src/bar.ts');
    assert.equal(notifyCalls[0].opts?.severity, 'warn');
    assert.equal(notifyCalls[0].opts?.dedupWindowMs, 30 * 60 * 1000);

    assert.ok(notifyCalls[0].subject.includes('Clobber detected: pa/src/foo.ts'));
    assert.ok(notifyCalls[0].body.includes('pa/src/foo.ts'));
    assert.ok(notifyCalls[0].body.includes('matches ancestor aaaaaa'));
    assert.ok(notifyCalls[0].body.includes('HEAD is bbbbbb'));
    assert.ok(notifyCalls[0].body.includes('pa reconcile --restore pa/src/foo.ts'));
  });

  it('counts only successful notifications when some fail', async () => {
    let callCount = 0;
    const result = await runClobberSentinel({
      readActiveFn: async () => [],
      detectDriftFn: async () => [finding('pa/src/a.ts'), finding('pa/src/b.ts'), finding('pa/src/c.ts')],
      notifyFn: async () => {
        callCount++;
        return callCount === 2 ? { sent: false, suppressed: false } : { sent: true, suppressed: false };
      },
    });

    assert.equal(result.touched, 2); // Only successful sends count
    assert.equal(result.detail.findings, 3);
    assert.equal(result.detail.notified, 2);
  });

  it('uses correct dedup key format for file paths', async () => {
    let capturedKey: string | undefined;
    await runClobberSentinel({
      readActiveFn: async () => [],
      detectDriftFn: async () => [finding('projects/telegram-bot/src/main.ts')],
      notifyFn: async (_subject, _body, opts) => {
        capturedKey = opts?.dedupKey as string;
        return { sent: true, suppressed: false };
      },
    });
    assert.equal(capturedKey, 'clobber-sentinel:projects/telegram-bot/src/main.ts');
  });
});
