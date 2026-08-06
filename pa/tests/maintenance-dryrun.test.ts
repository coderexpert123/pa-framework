import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir, stat, utimes } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { previewJob } from '../src/lib/maintenance/runner.js';
import { paHome } from '../src/paths.js';
import { maintenanceStatePath } from '../src/lib/maintenance/state.js';
import type { MaintenanceJob } from '../src/lib/maintenance/types.js';

let tempDir: string;
let originalPaHome: string | undefined;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pa-maintenance-dryrun-'));
  originalPaHome = process.env.PA_HOME;
  process.env.PA_HOME = tempDir;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  if (originalPaHome === undefined) delete process.env.PA_HOME;
  else process.env.PA_HOME = originalPaHome;
});

async function ageFile(path: string, ageDays: number): Promise<void> {
  const t = new Date(Date.now() - ageDays * DAY);
  await utimes(path, t, t);
}

function makeJob(overrides: Partial<MaintenanceJob> & { name: string }): MaintenanceJob {
  return {
    host: 'pa',
    everyMs: 60_000,
    description: 'test job',
    destructive: false,
    shedWhenDegraded: true,
    targets: [],
    run: async () => ({ touched: 0 }),
    ...overrides,
  };
}

describe('previewJob', () => {
  it('only matched, aged-out files become candidates', async () => {
    const archiveDir = join(paHome(), 'archive');
    await mkdir(archiveDir, { recursive: true });
    await writeFile(join(archiveDir, 'x-app.log.jsonl'), 'old', 'utf8');
    await ageFile(join(archiveDir, 'x-app.log.jsonl'), 200);
    await writeFile(join(archiveDir, 'y-app.log.jsonl'), 'recent', 'utf8');
    await ageFile(join(archiveDir, 'y-app.log.jsonl'), 1);
    await writeFile(join(archiveDir, 'z-conversation-history.jsonl'), 'old-but-not-matched', 'utf8');
    await ageFile(join(archiveDir, 'z-conversation-history.jsonl'), 200);

    const job = makeJob({
      name: 'archive-prune-preview',
      destructive: true,
      targets: [{
        resolve: () => archiveDir,
        match: /-app\.log\.jsonl$/,
        maxAgeMs: 90 * DAY,
        action: 'delete',
        ownership: 'pa-owned',
        evidence: 'test (2026-08-02)',
      }],
    });

    const previews = await previewJob(job);
    assert.equal(previews.length, 1);
    assert.equal(previews[0].candidates.length, 1);
    assert.equal(basename(previews[0].candidates[0]), 'x-app.log.jsonl');
  });

  it('writes nothing: directory listing and file stats are unchanged, no ledger file created', async () => {
    const archiveDir = join(paHome(), 'archive');
    await mkdir(archiveDir, { recursive: true });
    const filePath = join(archiveDir, 'old-app.log.jsonl');
    await writeFile(filePath, 'content', 'utf8');
    await ageFile(filePath, 200);

    const beforeEntries = (await readdir(archiveDir)).sort();
    const beforeStat = await stat(filePath);

    const job = makeJob({
      name: 'no-write-preview',
      destructive: true,
      targets: [{
        resolve: () => archiveDir,
        match: /-app\.log\.jsonl$/,
        maxAgeMs: 90 * DAY,
        action: 'delete',
        ownership: 'pa-owned',
        evidence: 'test (2026-08-02)',
      }],
    });

    await previewJob(job);

    const afterEntries = (await readdir(archiveDir)).sort();
    const afterStat = await stat(filePath);
    assert.deepEqual(afterEntries, beforeEntries);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStat.size, beforeStat.size);
    assert.equal(existsSync(maintenanceStatePath()), false);
  });

  it('missing directory → exists:false, candidates:[], no throw', async () => {
    const job = makeJob({
      name: 'missing-dir-preview',
      destructive: true,
      targets: [{
        resolve: () => join(paHome(), 'does-not-exist'),
        match: /.*/,
        maxAgeMs: 90 * DAY,
        action: 'delete',
        ownership: 'pa-owned',
        evidence: 'test (2026-08-02)',
      }],
    });

    const previews = await previewJob(job);
    assert.equal(previews[0].exists, false);
    assert.deepEqual(previews[0].candidates, []);
  });

  it('non-directory target → exists:true, candidates:[], note explains it is not enumerable', async () => {
    const filePath = join(paHome(), 'state.sqlite');
    await mkdir(paHome(), { recursive: true });
    await writeFile(filePath, 'x', 'utf8');

    const job = makeJob({
      name: 'file-target-preview',
      destructive: true,
      targets: [{
        resolve: () => filePath,
        match: /.*/,
        maxAgeMs: 90 * DAY,
        action: 'archive',
        ownership: 'external-no-retention',
        evidence: 'test (2026-08-02)',
      }],
    });

    const previews = await previewJob(job);
    assert.equal(previews[0].exists, true);
    assert.deepEqual(previews[0].candidates, []);
    assert.match(previews[0].note ?? '', /not enumerable/);
  });

  it('no targets → returns an empty array', async () => {
    const job = makeJob({ name: 'no-targets-preview', targets: [] });
    assert.deepEqual(await previewJob(job), []);
  });

  it('never invokes job.run()', async () => {
    let ranFlag = false;
    const job = makeJob({
      name: 'never-runs-preview',
      destructive: true,
      run: async () => { ranFlag = true; return { touched: 0 }; },
      targets: [{
        resolve: () => join(paHome(), 'archive'),
        match: /.*/,
        maxAgeMs: 90 * DAY,
        action: 'delete',
        ownership: 'pa-owned',
        evidence: 'test (2026-08-02)',
      }],
    });

    await previewJob(job);
    assert.equal(ranFlag, false);
  });
});
