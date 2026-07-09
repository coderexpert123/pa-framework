import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { reapStaleWorkerPidTmps } from '../src/worker-pids.js';

let tempDir: string;
let originalPaHome: string | undefined;
let pidsDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pa-wpids-tmp-'));
  originalPaHome = process.env.PA_HOME;
  process.env.PA_HOME = tempDir;
  pidsDir = join(tempDir, 'worker-pids');
  await mkdir(pidsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  if (originalPaHome === undefined) delete process.env.PA_HOME;
  else process.env.PA_HOME = originalPaHome;
});

describe('reapStaleWorkerPidTmps', () => {
  it('returns 0 when the worker-pids dir does not exist', async () => {
    await rm(pidsDir, { recursive: true, force: true });
    assert.equal(await reapStaleWorkerPidTmps(), 0);
  });

  it('deletes stale .json.tmp files but leaves fresh .tmp and live .json files', async () => {
    const stale = join(pidsDir, '111.json.tmp');
    const fresh = join(pidsDir, '222.json.tmp');
    const live = join(pidsDir, '333.json');
    await writeFile(stale, '{}', 'utf8');
    await writeFile(fresh, '{}', 'utf8');
    await writeFile(live, '{}', 'utf8');
    // Age the stale tmp 10 minutes back (threshold is 5 min).
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(stale, old, old);

    const removed = await reapStaleWorkerPidTmps();
    assert.equal(removed, 1);
    assert.deepEqual((await readdir(pidsDir)).sort(), ['222.json.tmp', '333.json']);
  });
});
