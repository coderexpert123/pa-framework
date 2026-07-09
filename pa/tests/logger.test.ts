import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { writeLog, readLogs, getLastRun, getLastSuccessfulRun, rotateLogs } from '../src/logger.js';
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

  it('writes an O(1) latest.json pointer alongside the .log/.meta pair', async () => {
    await writeLog('myskill', 'output', makeMeta({ worker: 'pointer-worker' }));

    const logDir = join(tempDir, 'logs', 'myskill');
    const raw = await readFile(join(logDir, 'latest.json'), 'utf8');
    const pointer = JSON.parse(raw);
    assert.equal(pointer.latest.worker, 'pointer-worker');
    assert.equal(pointer.latestSuccess.worker, 'pointer-worker'); // status defaults to 'success'
  });

  it('answers from the pointer without scanning the directory — proven by deleting the underlying .meta/.log files and still getting the right answer', async () => {
    await writeLog('myskill', 'output', makeMeta({ worker: 'ghost-worker' }));

    const logDir = join(tempDir, 'logs', 'myskill');
    const files = await readdir(logDir);
    for (const f of files) {
      if (f.endsWith('.log') || f.endsWith('.meta')) await writeFile(join(logDir, f), 'not json', 'utf8');
    }
    // A directory scan (readLogs) would now fail to parse every .meta file and
    // return null. The pointer path must still answer correctly.
    const last = await getLastRun('myskill');
    assert.ok(last);
    assert.equal(last.worker, 'ghost-worker');
  });

  it('falls back to a directory scan when the pointer is missing (pre-migration skill dir)', async () => {
    await writeLog('myskill', 'output', makeMeta({ worker: 'legacy-worker' }));

    const logDir = join(tempDir, 'logs', 'myskill');
    await unlink(join(logDir, 'latest.json'));

    const last = await getLastRun('myskill');
    assert.ok(last);
    assert.equal(last.worker, 'legacy-worker');
  });

  it('falls back to a directory scan when the pointer is corrupt', async () => {
    await writeLog('myskill', 'output', makeMeta({ worker: 'real-worker' }));

    const logDir = join(tempDir, 'logs', 'myskill');
    await writeFile(join(logDir, 'latest.json'), 'not valid json', 'utf8');

    const last = await getLastRun('myskill');
    assert.ok(last);
    assert.equal(last.worker, 'real-worker');
  });
});

describe('getLastSuccessfulRun', () => {
  it('returns the pointer\'s latestSuccess in O(1) — proven the same way, by corrupting the underlying files', async () => {
    await writeLog('myskill', 'output', makeMeta({ worker: 'success-worker', status: 'success' }));

    const logDir = join(tempDir, 'logs', 'myskill');
    const files = await readdir(logDir);
    for (const f of files) {
      if (f.endsWith('.log') || f.endsWith('.meta')) await writeFile(join(logDir, f), 'not json', 'utf8');
    }
    const last = await getLastSuccessfulRun('myskill');
    assert.ok(last);
    assert.equal(last.worker, 'success-worker');
  });

  it('regression: finds a historical success even after 21 consecutive failures (pointer-tracked, not bounded to the last 20 attempts)', async () => {
    await writeLog('myskill', 'ok', makeMeta({
      timestamp: '2026-01-01T00:00:00Z', worker: 'the-one-success', status: 'success',
    }));
    for (let i = 0; i < 21; i++) {
      await writeLog('myskill', 'fail', makeMeta({
        timestamp: new Date(Date.parse('2026-01-02T00:00:00Z') + i * 60_000).toISOString(),
        worker: `failure-${i}`, status: 'error',
      }));
    }

    // Old readLogs(,20)-scan-based behavior would return null here — the
    // success is now 22 files back, outside the last-20-attempts window.
    const last = await getLastSuccessfulRun('myskill');
    assert.ok(last, 'pointer must find the historical success beyond the 20-attempt scan window');
    assert.equal(last.worker, 'the-one-success');
  });

  it('falls back to the bounded scan when the pointer has no recorded success yet, and still finds one within the window', async () => {
    // Simulate a pre-migration skill dir: real files exist (including a
    // success), but no pointer has ever been written for it.
    await writeLog('myskill', 'ok', makeMeta({ worker: 'old-success', status: 'success' }));
    const logDir = join(tempDir, 'logs', 'myskill');
    await unlink(join(logDir, 'latest.json'));
    await writeLog('myskill', 'fail', makeMeta({
      timestamp: new Date(Date.now() + 60_000).toISOString(), worker: 'new-failure', status: 'error',
    }));
    // The second writeLog recreates a pointer, but with latestSuccess unset
    // (since that run failed) — must fall back to find the earlier success.
    const last = await getLastSuccessfulRun('myskill');
    assert.ok(last);
    assert.equal(last.worker, 'old-success');
  });

  it('returns null when no run has ever succeeded', async () => {
    await writeLog('myskill', 'fail', makeMeta({ status: 'error' }));
    const last = await getLastSuccessfulRun('myskill');
    assert.equal(last, null);
  });
});

describe('rotateLogs', () => {
  it('age-checks by the FILENAME timestamp, not content — a fresh-named file with 8-day-old content survives', async () => {
    // Discriminating fixture: VALID JSON content carrying an 8-day-old
    // meta.timestamp under a filename stamped now. The old content-reading
    // implementation would parse and DELETE it; the filename-based one must
    // keep it. (Corrupt content is non-discriminating — the old impl's catch
    // also skipped those files.)
    const fresh = new Date().toISOString();
    await writeLog('myskill', 'output', makeMeta({ timestamp: fresh }));

    const logDir = join(tempDir, 'logs', 'myskill');
    const files = await readdir(logDir);
    const metaFile = files.find((f) => f.endsWith('.meta'))!;
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(join(logDir, metaFile), JSON.stringify(makeMeta({ timestamp: eightDaysAgo })), 'utf8');

    const result = await rotateLogs('myskill', 7 * 24 * 60 * 60 * 1000);
    assert.equal(result.deletedCount, 0);
    assert.ok((await readdir(logDir)).includes(metaFile), 'filename says fresh — must survive regardless of content');
  });

  it('deletes an old file even with corrupt content, purely from the filename timestamp', async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago
    await writeLog('myskill', 'output', makeMeta({ timestamp: old }));

    const logDir = join(tempDir, 'logs', 'myskill');
    const files = await readdir(logDir);
    const metaFile = files.find((f) => f.endsWith('.meta'))!;
    await writeFile(join(logDir, metaFile), 'not valid json', 'utf8');

    const result = await rotateLogs('myskill', 7 * 24 * 60 * 60 * 1000);
    assert.equal(result.deletedCount, 1);
    assert.ok(!(await readdir(logDir)).includes(metaFile));
  });

  it('falls back to content-based parsing for a filename that does not match the expected format', async () => {
    const logDir = join(tempDir, 'logs', 'myskill');
    await mkdir(logDir, { recursive: true });
    const oldMeta: RunMeta = makeMeta({ timestamp: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() });
    await writeFile(join(logDir, 'legacy-name.meta'), JSON.stringify(oldMeta), 'utf8');
    await writeFile(join(logDir, 'legacy-name.log'), 'output', 'utf8');

    const result = await rotateLogs('myskill', 7 * 24 * 60 * 60 * 1000);
    assert.equal(result.deletedCount, 1, 'anomalous filename must still be aged via its content');
  });

  it('still enforces the size cap on a file that survives the age check', async () => {
    const fresh = new Date().toISOString();
    await writeLog('myskill', 'x'.repeat(200), makeMeta({ timestamp: fresh }));

    const logDir = join(tempDir, 'logs', 'myskill');
    const result = await rotateLogs('myskill', 7 * 24 * 60 * 60 * 1000, 100 /* maxSizeBytes */);
    assert.equal(result.deletedCount, 1);
    // latest.json (the O(1) pointer) is correctly left alone by rotateLogs —
    // it only rotates .log/.meta pairs. A stale pointer is harmless (see
    // logger.ts's writeLog comment: it's just a JSON snapshot, doesn't
    // require the underlying files to still exist).
    const remaining = await readdir(logDir);
    assert.deepEqual(remaining, ['latest.json']);
  });

  it('returns deletedCount 0 for a nonexistent skill dir', async () => {
    const result = await rotateLogs('ghost-skill');
    assert.equal(result.deletedCount, 0);
  });

  it('sweeps stray latest.json.*.tmp files older than an hour, keeps fresh ones', async () => {
    const logDir = join(tempDir, 'logs', 'myskill');
    await mkdir(logDir, { recursive: true });
    const stale = join(logDir, 'latest.json.abc-123.tmp');
    const fresh = join(logDir, 'latest.json.def-456.tmp');
    await writeFile(stale, '{}', 'utf8');
    await writeFile(fresh, '{}', 'utf8');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const { utimes } = await import('fs/promises');
    await utimes(stale, old, old);

    await rotateLogs('myskill');
    const remaining = await readdir(logDir);
    assert.ok(!remaining.includes('latest.json.abc-123.tmp'), 'stale tmp swept');
    assert.ok(remaining.includes('latest.json.def-456.tmp'), 'fresh tmp (rename may be imminent) kept');
  });
});

describe('pointer resilience', () => {
  it('writeLog still succeeds and getLastRun falls back to the scan when the pointer write fails', async () => {
    // A DIRECTORY squatting at the pointer path makes the rename fail — the
    // best-effort catch in writeLog must swallow it, and reads must fall back.
    const logDir = join(tempDir, 'logs', 'myskill');
    await mkdir(join(logDir, 'latest.json'), { recursive: true });

    await writeLog('myskill', 'output', makeMeta({ worker: 'resilient-worker' }));

    const last = await getLastRun('myskill');
    assert.ok(last, 'fallback scan must find the run despite the unwritable pointer');
    assert.equal(last.worker, 'resilient-worker');
  });

  it('getLastSuccessfulRun falls back to the scan when the pointer is corrupt', async () => {
    await writeLog('myskill', 'ok', makeMeta({ worker: 'success-worker', status: 'success' }));
    const logDir = join(tempDir, 'logs', 'myskill');
    await writeFile(join(logDir, 'latest.json'), 'not valid json', 'utf8');

    const last = await getLastSuccessfulRun('myskill');
    assert.ok(last);
    assert.equal(last.worker, 'success-worker');
  });
});
