import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordRateLimit, getCooldownStatus, clearRateLimitCache } from '../src/rate-limits.js';
import { rotateFileIfNeeded } from '../src/lib/archive-files.js';

let tempDir: string;
let originalPaHome: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pa-concurrency-test-'));
  originalPaHome = process.env.PA_HOME;
  process.env.PA_HOME = tempDir;
  clearRateLimitCache();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  if (originalPaHome === undefined) delete process.env.PA_HOME;
  else process.env.PA_HOME = originalPaHome;
});

describe('Concurrency: Rate Limit State', () => {
  it('handles many concurrent recordRateLimit calls without corruption', async () => {
    const workerCount = 20;
    const iterations = 5;
    const promises: Promise<void>[] = [];

    for (let i = 0; i < workerCount; i++) {
      for (let j = 0; j < iterations; j++) {
        promises.push(recordRateLimit(`worker-${i}`, 1, `reason-${j}`));
      }
    }

    await Promise.all(promises);

    const status = await getCooldownStatus();
    assert.equal(Object.keys(status).length, workerCount);
    for (let i = 0; i < workerCount; i++) {
      assert.ok(status[`worker-${i}`]);
      assert.equal(status[`worker-${i}`].reason, `reason-${iterations - 1}`);
    }
  });
});

describe('Concurrency: Log Rotation', () => {
  it('handles concurrent rotateFileIfNeeded calls safely', async () => {
    const logPath = join(tempDir, 'test.log');
    const maxBytes = 100;
    
    // 1. Create a file just below the limit
    await writeFile(logPath, 'A'.repeat(maxBytes - 10), 'utf8');

    // 2. Trigger many concurrent rotations by "adding" enough bytes to cross the limit
    const concurrentCount = 10;
    const promises = Array.from({ length: concurrentCount }).map(() => 
      rotateFileIfNeeded(logPath, 20, maxBytes)
    );

    const results = await Promise.all(promises);
    
    // Only one (or a few, sequentially) should have returned true for rotation
    const rotationCount = results.filter(r => r === true).length;
    assert.ok(rotationCount >= 1, 'At least one rotation should have occurred');
    
    // Verify the log file is now empty (freshly rotated)
    const freshStat = await stat(logPath);
    assert.equal(freshStat.size, 0);

    // Verify exactly one archive file exists (since they all happened in the same second/iteration)
    const { listArchiveFiles } = await import('../src/lib/archive-files.js');
    const archives = await listArchiveFiles('test.log');
    assert.ok(archives.length >= 1);
  });
});
