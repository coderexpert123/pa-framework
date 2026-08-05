import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readLedger,
  updateJobState,
  migrateLastLearnState,
  maintenanceStatePath,
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
