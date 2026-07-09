import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pruneArchive } from '../src/lib/archive-files.js';

let tempDir: string;
let originalPaHome: string | undefined;
let archiveDir: string;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pa-archive-prune-'));
  originalPaHome = process.env.PA_HOME;
  process.env.PA_HOME = tempDir;
  archiveDir = join(tempDir, 'archive');
  await mkdir(archiveDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  if (originalPaHome === undefined) delete process.env.PA_HOME;
  else process.env.PA_HOME = originalPaHome;
});

async function makeArchive(name: string, sizeBytes: number, ageDays: number): Promise<void> {
  const p = join(archiveDir, name);
  await writeFile(p, 'x'.repeat(sizeBytes), 'utf8');
  const t = new Date(Date.now() - ageDays * DAY);
  await utimes(p, t, t);
}

describe('pruneArchive', () => {
  it('returns 0 when the archive dir does not exist', async () => {
    await rm(archiveDir, { recursive: true, force: true });
    assert.equal(await pruneArchive(), 0);
  });

  it('deletes prunable archives older than maxAgeDays and keeps newer ones', async () => {
    await makeArchive('2026-01-01-000000-app.log.jsonl', 100, 200); // old
    await makeArchive('2026-06-01-000000-app.log.jsonl', 100, 10);  // recent
    const removed = await pruneArchive({ maxAgeDays: 90, maxTotalBytes: 999_999_999 });
    assert.equal(removed, 1);
    assert.deepEqual(await readdir(archiveDir), ['2026-06-01-000000-app.log.jsonl']);
  });

  it('applies the total-bytes backstop oldest-first (prunable files only)', async () => {
    await makeArchive('a-app.log.jsonl', 100, 5); // oldest
    await makeArchive('b-app.log.jsonl', 100, 3);
    await makeArchive('c-telegram-bot.log', 100, 1); // newest, prunable
    // 300 bytes total, cap 150 → delete the two oldest (a, b), keep c.
    const removed = await pruneArchive({ maxAgeDays: 3650, maxTotalBytes: 150 });
    assert.equal(removed, 2);
    assert.deepEqual((await readdir(archiveDir)).sort(), ['c-telegram-bot.log']);
  });

  it('keeps everything when under both limits', async () => {
    await makeArchive('x-app.log.jsonl', 50, 1);
    await makeArchive('y-app.log.jsonl', 50, 2);
    const removed = await pruneArchive({ maxAgeDays: 90, maxTotalBytes: 999_999 });
    assert.equal(removed, 0);
    assert.equal((await readdir(archiveDir)).length, 2);
  });

  it('NEVER deletes conversation-history shards — permanent per CLAUDE.md — from either loop', async () => {
    // Ancient AND enormous: would fail both the age check and the byte cap if
    // it were prunable. Both loops must skip it entirely.
    await makeArchive('2026-01-01-000000-conversation-history.jsonl', 5000, 400);
    await makeArchive('conv-2026-05-01.jsonl', 5000, 400); // TROUBLESHOOTING.md manual-park name
    await makeArchive('old-app.log.jsonl', 100, 400);      // prunable control
    const removed = await pruneArchive({ maxAgeDays: 90, maxTotalBytes: 150 });
    assert.equal(removed, 1, 'only the prunable control file is deleted');
    assert.deepEqual((await readdir(archiveDir)).sort(), [
      '2026-01-01-000000-conversation-history.jsonl',
      'conv-2026-05-01.jsonl',
    ]);
  });

  it('conversation shards do not count toward the byte cap', async () => {
    // A huge permanent file must not cause prunable files to be sacrificed.
    await makeArchive('big-conversation-history.jsonl', 10_000, 1);
    await makeArchive('small-app.log.jsonl', 100, 1);
    const removed = await pruneArchive({ maxAgeDays: 3650, maxTotalBytes: 5_000 });
    assert.equal(removed, 0, 'prunable total (100B) is under the cap; permanent bytes are ignored');
    assert.equal((await readdir(archiveDir)).length, 2);
  });

  it('fails safe: unknown-named files are kept forever', async () => {
    await makeArchive('mystery-export.bin', 100, 400);
    const removed = await pruneArchive({ maxAgeDays: 90, maxTotalBytes: 10 });
    assert.equal(removed, 0);
    assert.deepEqual(await readdir(archiveDir), ['mystery-export.bin']);
  });

  it('does not over-delete newer shards when an unlink fails in the byte-cap loop', async () => {
    // Injected unlink fails for the oldest file (Windows fs.unlink clears the
    // read-only attribute and retries, so a real EPERM can't be staged via
    // the filesystem — hence the test hook). The loop must account for the
    // stuck file's bytes anyway and NOT compensate by deleting the newest.
    await makeArchive('a-app.log.jsonl', 100, 5); // oldest — unlink will fail
    await makeArchive('b-app.log.jsonl', 100, 3);
    await makeArchive('c-app.log.jsonl', 100, 1); // newest — must survive
    const { unlink } = await import('fs/promises');
    const failingUnlink = async (path: string) => {
      if (path.endsWith('a-app.log.jsonl')) throw Object.assign(new Error('EBUSY: locked'), { code: 'EBUSY' });
      await unlink(path);
    };

    // 300 bytes, cap 150 → intent: delete a (fails) + b (succeeds); c survives.
    const removed = await pruneArchive({ maxAgeDays: 3650, maxTotalBytes: 150 }, failingUnlink);
    assert.equal(removed, 1, 'only b actually deleted');
    const remaining = (await readdir(archiveDir)).sort();
    assert.ok(remaining.includes('c-app.log.jsonl'), 'newest shard must NOT be sacrificed for the stuck file');
    assert.ok(remaining.includes('a-app.log.jsonl'), 'stuck file remains (unlink failed)');
    assert.ok(!remaining.includes('b-app.log.jsonl'));
  });
});
