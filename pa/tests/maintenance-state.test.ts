import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readLedger,
  updateJobState,
  migrateLastLearnState,
  maintenanceStatePath,
  renameWithRetry,
} from '../src/lib/maintenance/state.js';

let tempDir: string;
let originalPaHome: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pa-maintenance-state-'));
  originalPaHome = process.env.PA_HOME;
  process.env.PA_HOME = tempDir;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  if (originalPaHome === undefined) delete process.env.PA_HOME;
  else process.env.PA_HOME = originalPaHome;
});

describe('readLedger', () => {
  it('missing file yields empty default', async () => {
    assert.deepEqual(await readLedger(), { version: 1, jobs: {} });
  });

  it('corrupt file yields empty default, no throw', async () => {
    await writeFile(maintenanceStatePath(), '{{{', 'utf8');
    assert.deepEqual(await readLedger(), { version: 1, jobs: {} });
  });
});

describe('updateJobState', () => {
  it('round-trips a write through readLedger', async () => {
    await updateJobState('x', (p) => ({ ...p, lastOutcome: 'ran', lastTouched: 3 }));
    const ledger = await readLedger();
    assert.equal(ledger.jobs['x'].lastOutcome, 'ran');
    assert.equal(ledger.jobs['x'].lastTouched, 3);
    assert.equal(typeof ledger.jobs['x'].firstSeenAt, 'string');
    assert.ok(!isNaN(new Date(ledger.jobs['x'].firstSeenAt).getTime()));
  });

  it('preserves firstSeenAt across a second update', async () => {
    await updateJobState('x', (p) => ({ ...p, lastOutcome: 'ran' }));
    const first = (await readLedger()).jobs['x'].firstSeenAt;
    await updateJobState('x', (p) => ({ ...p, lastOutcome: 'failed' }));
    const second = (await readLedger()).jobs['x'].firstSeenAt;
    assert.equal(second, first);
  });

  it('atomic write leaves no tmp residue', async () => {
    await updateJobState('x', (p) => ({ ...p, lastOutcome: 'ran' }));
    const entries = await readdir(process.env.PA_HOME!);
    assert.ok(!entries.some((e) => e.includes('maintenance-state.json.') && e.endsWith('.tmp')));
  });

  it('concurrent writers to distinct jobs all persist', async () => {
    await Promise.all(
      [...Array(10)].map((_, i) => updateJobState(`j${i}`, (p) => ({ ...p, lastTouched: i }))),
    );
    const ledger = await readLedger();
    for (let i = 0; i < 10; i++) {
      assert.equal(ledger.jobs[`j${i}`].lastTouched, i);
    }
  });

  it('concurrent writers to the same job all apply (in-process mutex)', async () => {
    await Promise.all(
      [...Array(10)].map(() => updateJobState('same', (p) => ({ ...p, consecutiveFailures: p.consecutiveFailures + 1 }))),
    );
    const ledger = await readLedger();
    assert.equal(ledger.jobs['same'].consecutiveFailures, 10);
  });
});

describe('lastAttemptAt (2026-08-23 alerts wave)', () => {
  it('round-trips through updateJobState/readLedger', async () => {
    const iso = new Date().toISOString();
    await updateJobState('y', (p) => ({ ...p, lastAttemptAt: iso }));
    const ledger = await readLedger();
    assert.equal(ledger.jobs['y'].lastAttemptAt, iso);
  });

  it('a ledger row written before this change (no lastAttemptAt) reads back as undefined without throwing', async () => {
    const legacyRow = {
      firstSeenAt: new Date().toISOString(),
      lastRunAt: new Date().toISOString(),
      lastOutcome: 'ran',
      consecutiveFailures: 0,
      consecutiveSkips: 0,
    };
    await writeFile(
      maintenanceStatePath(),
      JSON.stringify({ version: 1, jobs: { 'legacy-job': legacyRow } }),
      'utf8',
    );
    const ledger = await readLedger();
    assert.equal(ledger.jobs['legacy-job'].lastAttemptAt, undefined);
  });
});

describe('migrateLastLearnState', () => {
  it('migrates a legacy last-learn.json into the ledger and deletes the file', async () => {
    const legacyPath = join(process.env.PA_HOME!, 'last-learn.json');
    const isoThreeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(legacyPath, JSON.stringify({ last_run: isoThreeDaysAgo }), 'utf8');

    const migrated = await migrateLastLearnState();
    assert.equal(migrated, true);

    const ledger = await readLedger();
    assert.equal(ledger.jobs['weekly-learn'].lastRunAt, isoThreeDaysAgo);
    assert.equal(existsSync(legacyPath), false);
  });

  it('second call is a no-op', async () => {
    const legacyPath = join(process.env.PA_HOME!, 'last-learn.json');
    const iso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(legacyPath, JSON.stringify({ last_run: iso }), 'utf8');
    await migrateLastLearnState();

    const second = await migrateLastLearnState();
    assert.equal(second, false);

    const ledger = await readLedger();
    assert.equal(ledger.jobs['weekly-learn'].lastRunAt, iso);
  });

  it('no legacy file present → returns false, creates no ledger entry', async () => {
    const migrated = await migrateLastLearnState();
    assert.equal(migrated, false);
    const ledger = await readLedger();
    assert.equal(ledger.jobs['weekly-learn'], undefined);
  });
});

// ---------------------------------------------------------------------------
// renameWithRetry (AI-150)
// ---------------------------------------------------------------------------

describe('renameWithRetry', () => {
  let tempDir: string;
  let originalPaHome: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pa-rename-retry-'));
    originalPaHome = process.env.PA_HOME;
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    if (originalPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = originalPaHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('succeeds on first attempt when rename works', async () => {
    const tmpPath = join(tempDir, 'tmp.txt');
    const targetPath = join(tempDir, 'target.txt');
    await writeFile(tmpPath, 'content', 'utf8');

    let callCount = 0;
    const mockRename = async (a: string, b: string): Promise<void> => {
      callCount++;
      await rename(a, b);
    };

    await renameWithRetry(tmpPath, targetPath, {}, mockRename);
    assert.equal(callCount, 1, 'should call rename once');
    assert.ok(existsSync(targetPath), 'target should exist');
  });

  it('retries EPERM errors up to attempts before giving up', async () => {
    const tmpPath = join(tempDir, 'tmp.txt');
    const targetPath = join(tempDir, 'target.txt');
    await writeFile(tmpPath, 'content', 'utf8');

    let callCount = 0;
    const mockRename = async (a: string, b: string): Promise<void> => {
      callCount++;
      if (callCount < 3) {
        const err: any = new Error('EPERM');
        err.code = 'EPERM';
        throw err;
      }
      await rename(a, b);
    };

    await renameWithRetry(tmpPath, targetPath, { attempts: 5, baseDelayMs: 10, jitterMs: 0 }, mockRename);
    assert.equal(callCount, 3, 'should retry EPERM then succeed');
    assert.ok(existsSync(targetPath), 'target should exist after retries');
  });

  it('rethrows EACCES errors immediately (only EPERM/EACCES retry)', async () => {
    const tmpPath = join(tempDir, 'tmp.txt');
    const targetPath = join(tempDir, 'target.txt');
    await writeFile(tmpPath, 'content', 'utf8');

    let callCount = 0;
    const mockRename = async (a: string, b: string): Promise<void> => {
      callCount++;
      if (callCount === 1) {
        const err: any = new Error('EACCES');
        err.code = 'EACCES';
        throw err;
      }
      await rename(a, b);
    };

    await renameWithRetry(tmpPath, targetPath, { attempts: 3, baseDelayMs: 10, jitterMs: 0 }, mockRename);
    assert.equal(callCount, 2, 'should retry EACCES then succeed');
    assert.ok(existsSync(targetPath), 'target should exist after retries');
  });

  it('rethrows non-permission errors immediately', async () => {
    const tmpPath = join(tempDir, 'tmp.txt');
    const targetPath = join(tempDir, 'target.txt');
    await writeFile(tmpPath, 'content', 'utf8');

    let callCount = 0;
    const mockRename = async (a: string, b: string): Promise<void> => {
      callCount++;
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    };

    await assert.rejects(
      () => renameWithRetry(tmpPath, targetPath, { attempts: 5, baseDelayMs: 10, jitterMs: 0 }, mockRename),
      (err: any) => err.code === 'ENOENT',
      'should rethrow ENOENT immediately',
    );
    assert.equal(callCount, 1, 'should not retry non-permission errors');
  });

  it('rejects after exhausting all retry attempts', async () => {
    const tmpPath = join(tempDir, 'tmp.txt');
    const targetPath = join(tempDir, 'target.txt');
    await writeFile(tmpPath, 'content', 'utf8');

    let callCount = 0;
    const mockRename = async (): Promise<void> => {
      callCount++;
      const err: any = new Error('EPERM');
      err.code = 'EPERM';
      throw err;
    };

    await assert.rejects(
      () => renameWithRetry(tmpPath, targetPath, { attempts: 3, baseDelayMs: 10, jitterMs: 0 }, mockRename),
      (err: any) => err.code === 'EPERM',
      'should reject with EPERM after all attempts',
    );
    assert.equal(callCount, 3, 'should attempt exactly 3 times');
  });

  it('uses exponential backoff with jitter', async () => {
    const tmpPath = join(tempDir, 'tmp.txt');
    const targetPath = join(tempDir, 'target.txt');
    await writeFile(tmpPath, 'content', 'utf8');

    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (cb: () => void, ms: number) => {
      delays.push(ms);
      setImmediate(cb);
      return {} as any;
    };

    let callCount = 0;
    const mockRename = async (): Promise<void> => {
      callCount++;
      if (callCount < 4) {
        const err: any = new Error('EPERM');
        err.code = 'EPERM';
        throw err;
      }
      await rename(tmpPath, targetPath);
    };

    await renameWithRetry(tmpPath, targetPath, { attempts: 5, baseDelayMs: 50, jitterMs: 0 }, mockRename);

    (globalThis as any).setTimeout = originalSetTimeout;

    assert.equal(callCount, 4, 'should retry 3 times then succeed');
    // With baseDelayMs=50, jitterMs=0: delays should be 50*2^(attempt-1)
    // Attempt 1: 50*2^0 = 50
    // Attempt 2: 50*2^1 = 100
    // Attempt 3: 50*2^2 = 200
    assert.deepEqual(delays, [50, 100, 200], 'should use exponential backoff');
  });

  it('jitterMs=0 produces deterministic delays for tests', async () => {
    const tmpPath = join(tempDir, 'tmp.txt');
    const targetPath = join(tempDir, 'target.txt');
    await writeFile(tmpPath, 'content', 'utf8');

    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (cb: () => void, ms: number) => {
      delays.push(ms);
      setImmediate(cb);
      return {} as any;
    };

    let callCount = 0;
    const mockRename = async (): Promise<void> => {
      callCount++;
      if (callCount === 1) {
        const err: any = new Error('EPERM');
        err.code = 'EPERM';
        throw err;
      }
      await rename(tmpPath, targetPath);
    };

    await renameWithRetry(tmpPath, targetPath, { attempts: 2, baseDelayMs: 50, jitterMs: 0 }, mockRename);

    (globalThis as any).setTimeout = originalSetTimeout;

    assert.deepEqual(delays, [50], 'jitterMs=0 should produce exact baseDelay');
  });
});
