import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { writeLog, readLogs, getLastRun } from '../src/logger.js';
import type { RunMeta } from '../src/types.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

function makeMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    worker: 'test-worker',
    status: 'success',
    exitCode: 0,
    duration: 1234,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('writeLog', () => {
  it('creates .log and .meta files', async () => {
    const meta = makeMeta();
    await writeLog('myskill', 'output text', meta);

    const logDir = join(tempDir, 'logs', 'myskill');
    const files = await readdir(logDir);
    const logFiles = files.filter((f) => f.endsWith('.log'));
    const metaFiles = files.filter((f) => f.endsWith('.meta'));
    assert.equal(logFiles.length, 1);
    assert.equal(metaFiles.length, 1);
  });

  it('meta file contains valid JSON with all fields', async () => {
    const meta = makeMeta({ worker: 'claude', status: 'error', error: 'boom' });
    await writeLog('myskill', 'output', meta);

    const logDir = join(tempDir, 'logs', 'myskill');
    const files = await readdir(logDir);
    const metaFile = files.find((f) => f.endsWith('.meta'))!;
    const content = await readFile(join(logDir, metaFile), 'utf8');
    const parsed = JSON.parse(content);
    assert.equal(parsed.worker, 'claude');
    assert.equal(parsed.status, 'error');
    assert.equal(parsed.error, 'boom');
    assert.equal(parsed.duration, 1234);
  });

  it('log files have nonce in filename', async () => {
    await writeLog('myskill', 'output', makeMeta());

    const files = await readdir(join(tempDir, 'logs', 'myskill'));
    const logFile = files.find((f) => f.endsWith('.log'))!;
    // Format: YYYYMMDD-HHMMSS-hexhex.log
    assert.match(logFile, /^\d{8}-\d{6}-[a-f0-9]{6}\.log$/);
  });

  it('two writes in same second produce different files', async () => {
    const now = new Date().toISOString();
    await writeLog('myskill', 'first', makeMeta({ timestamp: now }));
    await writeLog('myskill', 'second', makeMeta({ timestamp: now }));

    const files = await readdir(join(tempDir, 'logs', 'myskill'));
    const logFiles = files.filter((f) => f.endsWith('.log'));
    assert.equal(logFiles.length, 2, 'Should have 2 distinct log files');
  });
});

describe('readLogs', () => {
  it('returns entries sorted newest first', async () => {
    const t1 = '2026-01-01T10:00:00.000Z';
    const t2 = '2026-01-02T10:00:00.000Z';
    const t3 = '2026-01-03T10:00:00.000Z';
    await writeLog('myskill', 'old', makeMeta({ timestamp: t1 }));
    await writeLog('myskill', 'mid', makeMeta({ timestamp: t2 }));
    await writeLog('myskill', 'new', makeMeta({ timestamp: t3 }));

    const logs = await readLogs('myskill', 10);
    assert.equal(logs.length, 3);
    // Newest first (sorted by filename descending)
    assert.equal(new Date(logs[0].meta.timestamp).getDate(), 3);
    assert.equal(new Date(logs[2].meta.timestamp).getDate(), 1);
  });

  it('respects count parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await writeLog('myskill', `run ${i}`, makeMeta({
        timestamp: new Date(Date.now() + i * 86400000).toISOString(),
      }));
    }
    const logs = await readLogs('myskill', 2);
    assert.equal(logs.length, 2);
  });

  it('returns empty for nonexistent skill', async () => {
    const logs = await readLogs('ghost-skill');
    assert.deepEqual(logs, []);
  });
});

describe('getLastRun', () => {
  it('returns most recent meta', async () => {
    await writeLog('myskill', 'old', makeMeta({ timestamp: '2026-01-01T00:00:00Z', worker: 'old-worker' }));
    await writeLog('myskill', 'new', makeMeta({ timestamp: '2026-06-01T00:00:00Z', worker: 'new-worker' }));

    const last = await getLastRun('myskill');
    assert.ok(last);
    assert.equal(last.worker, 'new-worker');
  });

  it('returns null when no logs', async () => {
    const last = await getLastRun('nonexistent');
    assert.equal(last, null);
  });
});
