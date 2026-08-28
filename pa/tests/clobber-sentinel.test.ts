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
      getActiveLocksFn: async () => [],
      detectDriftFn: async () => { throw new Error('must not be called'); },
    });
    assert.equal(result.touched, 0);
    assert.deepEqual(result.detail, { skipped: 'lock-held' });
  });

  it('skips when a skill-exclusive:git-workflow blackboard lock is held', async () => {
    const result = await runClobberSentinel({
      readActiveFn: async () => [],
      getActiveLocksFn: async () => [{ resource: 'skill-exclusive:git-workflow' }],
      detectDriftFn: async () => { throw new Error('must not be called'); },
    });
    assert.equal(result.touched, 0);
    assert.deepEqual(result.detail, { skipped: 'lock-held' });
  });

  it('skips when a skill-exclusive:git-public-workflow blackboard lock is held', async () => {
    const result = await runClobberSentinel({
      readActiveFn: async () => [],
      getActiveLocksFn: async () => [{ resource: 'skill-exclusive:git-public-workflow' }],
      detectDriftFn: async () => { throw new Error('must not be called'); },
    });
    assert.equal(result.touched, 0);
    assert.deepEqual(result.detail, { skipped: 'lock-held' });
  });

  it('REGRESSION (2026-08-23): the old fabricated reservations shape no longer causes a skip — clobber-sentinel checked the WRONG store (reservations.json) for a blackboard-only key from the day it shipped until this fix, so its documented "skip while a commit is in flight" never once fired', async () => {
    let detectDriftCalled = false;
    const result = await runClobberSentinel({
      readActiveFn: async () => [{ paths: ['exclusive_resource:git-workflow'] }],
      getActiveLocksFn: async () => [],
      detectDriftFn: async () => { detectDriftCalled = true; return []; },
    });
    assert.equal(detectDriftCalled, true, 'detectDriftFn must be called — the fabricated reservations-shaped input must fall through, not skip');
    assert.deepEqual(result.detail, { findings: 0 });
  });

  it('proceeds when no conflicting locks are held', async () => {
    const result = await runClobberSentinel({
      readActiveFn: async () => [],
      getActiveLocksFn: async () => [],
      detectDriftFn: async () => [],
    });
    assert.equal(result.touched, 0);
    assert.deepEqual(result.detail, { findings: 0 });
  });

  it('rejects and pages when detectDrift fails — a tamper-detection control that reports green while broken is worse than one that pages', async () => {
    const notifyCalls: Array<{ subject: string; body: string; opts?: Record<string, unknown> }> = [];
    await assert.rejects(
      () => runClobberSentinel({
        readActiveFn: async () => [],
        getActiveLocksFn: async () => [],
        detectDriftFn: async () => { throw new Error('git status failed'); },
        notifyFn: async (subject, body, opts) => {
          notifyCalls.push({ subject, body, opts });
          return { sent: true, suppressed: false };
        },
      }),
      /git status failed/
    );
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].opts?.dedupKey, 'clobber-sentinel-detect-failed');
    assert.equal(notifyCalls[0].opts?.severity, 'error');
  });

  it('passes repoRootFn\'s resolved value into detectDriftFn', async () => {
    let capturedRepoRoot: string | undefined;
    const result = await runClobberSentinel({
      readActiveFn: async () => [],
      getActiveLocksFn: async () => [],
      repoRootFn: async () => '/fake/repo/root',
      detectDriftFn: async (repoRoot) => {
        capturedRepoRoot = repoRoot;
        return [];
      },
    });
    assert.equal(capturedRepoRoot, '/fake/repo/root');
    assert.equal(result.touched, 0);
  });

  it('notifies per-file when drift findings exist', async () => {
    const notifyCalls: Array<{ subject: string; body: string; opts?: Record<string, unknown> }> = [];
    const result = await runClobberSentinel({
      readActiveFn: async () => [],
      getActiveLocksFn: async () => [],
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
      getActiveLocksFn: async () => [],
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
      getActiveLocksFn: async () => [],
      detectDriftFn: async () => [finding('projects/telegram-bot/src/main.ts')],
      notifyFn: async (_subject, _body, opts) => {
        capturedKey = opts?.dedupKey as string;
        return { sent: true, suppressed: false };
      },
    });
    assert.equal(capturedKey, 'clobber-sentinel:projects/telegram-bot/src/main.ts');
  });

  it('refId in a clobber message is 12 hex chars', async () => {
    const notifyCalls: Array<{ subject: string; body: string; opts?: Record<string, unknown> }> = [];
    await runClobberSentinel({
      readActiveFn: async () => [],
      getActiveLocksFn: async () => [],
      detectDriftFn: async () => [finding('pa/src/foo.ts')],
      notifyFn: async (subject, body, opts) => {
        notifyCalls.push({ subject, body, opts });
        return { sent: true, suppressed: false };
      },
    });
    assert.equal(notifyCalls.length, 1);
    const match = notifyCalls[0].body.match(/_Ref: s-([0-9a-f]+)_/);
    assert.ok(match, 'body should contain a _Ref: s-<hex>_ line');
    assert.equal(match![1].length, 12, `ref-ID should be 12 hex chars, got "${match![1]}" (${match![1].length})`);
  });
});
