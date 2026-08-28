import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, stat, utimes } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { MaintenanceJobContext } from '../src/lib/maintenance/types.js';

// Dynamic import to avoid build-time circular dependency
let sharedTmpSweepJob: typeof import('../src/lib/maintenance/jobs/shared-tmp-sweep.js').sharedTmpSweepJob;

describe('shared-tmp-sweep job', () => {
  const testScratchDir = join(tmpdir(), 'pa-shared-tmp-sweep-test');

  before(async () => {
    // Load the job dynamically
    sharedTmpSweepJob = (await import('../src/lib/maintenance/jobs/shared-tmp-sweep.js')).sharedTmpSweepJob;
    // Create test scratch dir
    await mkdir(testScratchDir, { recursive: true });
  });

  after(async () => {
    // Cleanup test dir
    await rm(testScratchDir, { recursive: true, force: true }).catch(() => {});
  });

  it('deletes old matching files', async () => {
    const now = Date.now();
    const oldFile = join(testScratchDir, 'replay_lock_old.json');
    await writeFile(oldFile, 'test');
    // Set mtime to 2 hours ago
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
    await utimes(oldFile, twoHoursAgo, twoHoursAgo);

    // Override resolve to use test dir
    const originalResolve = sharedTmpSweepJob.targets[0].resolve;
    sharedTmpSweepJob.targets[0].resolve = () => testScratchDir;

    try {
      const ctx: MaintenanceJobContext = { now, everyMs: 3_600_000 };
      const result = await sharedTmpSweepJob.run(ctx);
      assert.equal(result.touched, 1);
      // File should be gone
      await assert.rejects(() => stat(oldFile));
    } finally {
      sharedTmpSweepJob.targets[0].resolve = originalResolve;
    }
  });

  it('preserves young matching files', async () => {
    const now = Date.now();
    const youngFile = join(testScratchDir, 'render_lock_young.json');
    await writeFile(youngFile, 'test');

    const originalResolve = sharedTmpSweepJob.targets[0].resolve;
    sharedTmpSweepJob.targets[0].resolve = () => testScratchDir;

    try {
      const ctx: MaintenanceJobContext = { now, everyMs: 3_600_000 };
      const result = await sharedTmpSweepJob.run(ctx);
      assert.equal(result.touched, 0);
      // File should still exist
      const statResult = await stat(youngFile);
      assert.ok(statResult.isFile());
    } finally {
      sharedTmpSweepJob.targets[0].resolve = originalResolve;
    }
  });

  it('removes old pytest-of-* directories recursively', async () => {
    const now = Date.now();
    const oldDir = join(testScratchDir, 'pytest-of-old');
    const nestedFile = join(oldDir, 'nested.txt');
    await mkdir(oldDir, { recursive: true });
    await writeFile(nestedFile, 'test');
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
    await utimes(oldDir, twoHoursAgo, twoHoursAgo);
    await utimes(nestedFile, twoHoursAgo, twoHoursAgo);

    const originalResolve = sharedTmpSweepJob.targets[0].resolve;
    sharedTmpSweepJob.targets[0].resolve = () => testScratchDir;

    try {
      const ctx: MaintenanceJobContext = { now, everyMs: 3_600_000 };
      const result = await sharedTmpSweepJob.run(ctx);
      assert.equal(result.touched, 1);
      // Directory should be gone
      await assert.rejects(() => stat(oldDir));
    } finally {
      sharedTmpSweepJob.targets[0].resolve = originalResolve;
    }
  });

  it('skips non-matching files entirely', async () => {
    const now = Date.now();
    const otherFile = join(testScratchDir, 'should-not-delete.json');
    await writeFile(otherFile, 'test');
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
    await utimes(otherFile, twoHoursAgo, twoHoursAgo);

    const originalResolve = sharedTmpSweepJob.targets[0].resolve;
    sharedTmpSweepJob.targets[0].resolve = () => testScratchDir;

    try {
      const ctx: MaintenanceJobContext = { now, everyMs: 3_600_000 };
      const result = await sharedTmpSweepJob.run(ctx);
      assert.equal(result.touched, 0);
      // File should still exist
      const statResult = await stat(otherFile);
      assert.ok(statResult.isFile());
    } finally {
      sharedTmpSweepJob.targets[0].resolve = originalResolve;
    }
  });

  it('handles missing scratch dir gracefully (ENOENT)', async () => {
    const now = Date.now();
    const nonExistentDir = join(tmpdir(), 'pa-does-not-exist-' + now);
    // Temporarily override the target resolve
    const originalResolve = sharedTmpSweepJob.targets[0].resolve;
    sharedTmpSweepJob.targets[0].resolve = () => nonExistentDir;

    try {
      const ctx: MaintenanceJobContext = { now, everyMs: 3_600_000 };
      const result = await sharedTmpSweepJob.run(ctx);
      assert.equal(result.touched, 0);
      assert.equal(result.detail?.skipped, 'no scratch dir');
    } finally {
      sharedTmpSweepJob.targets[0].resolve = originalResolve;
    }
  });

  it('respects PA_TEST_TMP_DIR override', async () => {
    const now = Date.now();
    const customDir = join(tmpdir(), 'pa-custom-override-' + now);
    await mkdir(customDir, { recursive: true });
    const oldFile = join(customDir, 'replay_lock_custom.json');
    await writeFile(oldFile, 'test');
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
    await utimes(oldFile, twoHoursAgo, twoHoursAgo);

    const originalResolve = sharedTmpSweepJob.targets[0].resolve;
    sharedTmpSweepJob.targets[0].resolve = () => customDir;

    try {
      const ctx: MaintenanceJobContext = { now, everyMs: 3_600_000 };
      const result = await sharedTmpSweepJob.run(ctx);
      assert.equal(result.touched, 1);
      await assert.rejects(() => stat(oldFile));
    } finally {
      sharedTmpSweepJob.targets[0].resolve = originalResolve;
      await rm(customDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('handles mix of old and young files correctly', async () => {
    const now = Date.now();
    const old1 = join(testScratchDir, 'replay_lock_old1.json');
    const old2 = join(testScratchDir, 'pytest-of-old-dir');
    const young1 = join(testScratchDir, 'render_lock_young.json');
    const nonMatch = join(testScratchDir, 'other.json');

    await writeFile(old1, 'old');
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
    await utimes(old1, twoHoursAgo, twoHoursAgo);

    await mkdir(old2, { recursive: true });
    await writeFile(join(old2, 'file.txt'), 'old dir');
    await utimes(old2, twoHoursAgo, twoHoursAgo);
    await utimes(join(old2, 'file.txt'), twoHoursAgo, twoHoursAgo);

    await writeFile(young1, 'young');
    await writeFile(nonMatch, 'no match');
    await utimes(nonMatch, twoHoursAgo, twoHoursAgo);

    const originalResolve = sharedTmpSweepJob.targets[0].resolve;
    sharedTmpSweepJob.targets[0].resolve = () => testScratchDir;

    try {
      const ctx: MaintenanceJobContext = { now, everyMs: 3_600_000 };

      const result = await sharedTmpSweepJob.run(ctx);
      assert.equal(result.touched, 2); // old1 and old2 deleted

      // Verify deletions
      await assert.rejects(() => stat(old1));
      await assert.rejects(() => stat(old2));

      // Verify preservation
      await stat(young1);
      await stat(nonMatch);
    } finally {
      sharedTmpSweepJob.targets[0].resolve = originalResolve;
    }
  });
});
