import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileAtomic, writeJsonAtomic, renameWithRetry } from '../src/lib/atomic-write.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pa-atomic-write-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function listTmpFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((e) => e.endsWith('.tmp'));
}

describe('writeJsonAtomic', () => {
  it('produces valid JSON and leaves no .tmp', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, 'data.json');
      await writeJsonAtomic(target, { hello: 'world', n: 42 });
      const raw = await readFile(target, 'utf8');
      assert.deepEqual(JSON.parse(raw), { hello: 'world', n: 42 });
      assert.deepEqual(await listTmpFiles(dir), []);
    });
  });

  it('a write over an existing file replaces it atomically', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, 'data.json');
      await writeJsonAtomic(target, { version: 1 });
      await writeJsonAtomic(target, { version: 2 });
      const raw = await readFile(target, 'utf8');
      assert.deepEqual(JSON.parse(raw), { version: 2 });
      assert.deepEqual(await listTmpFiles(dir), []);
    });
  });
});

describe('renameWithRetry', () => {
  it('a failing renameFn injected with EPERM retries then succeeds', async () => {
    let calls = 0;
    const renameFn = async (_a: string, _b: string) => {
      calls++;
      if (calls < 3) {
        const err: any = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
    };
    await renameWithRetry('src', 'dest', { baseDelayMs: 1, jitterMs: 0 }, renameFn);
    assert.equal(calls, 3);
  });

  it('a non-EPERM/EACCES error rethrows immediately', async () => {
    let calls = 0;
    const renameFn = async (_a: string, _b: string) => {
      calls++;
      const err: any = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      throw err;
    };
    await assert.rejects(
      () => renameWithRetry('src', 'dest', { baseDelayMs: 1, jitterMs: 0 }, renameFn),
      /ENOENT/,
    );
    assert.equal(calls, 1);
  });
});

describe('writeFileAtomic', () => {
  it('a throw during write unlinks the .tmp', async () => {
    await withTempDir(async (dir) => {
      // Make the FINAL destination an existing directory so writeFile(tmp,...)
      // succeeds (tmp is a distinct sibling filename in the same dir) but
      // renameWithRetry's rename-over-an-existing-directory fails — exercising
      // the catch block's best-effort unlink of the tmp file it just wrote.
      const target = join(dir, 'target');
      await mkdir(target);
      await assert.rejects(() => writeFileAtomic(target, 'payload'));
      assert.deepEqual(await listTmpFiles(dir), []);
    });
  });
});
