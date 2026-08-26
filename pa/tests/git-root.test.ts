import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { resolveRepoRoot, repoRootFromModule, walkUpToRepoRoot } from '../src/lib/git-root.js';

// Real throwaway git repos in temp dirs — no mocked git (repo convention).

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pa-git-root-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(dir, 'root-file.txt'), 'x', 'utf8');
  git(dir, ['add', 'root-file.txt']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

describe('resolveRepoRoot', () => {
  it('resolves to the repo root when invoked FROM the repo root', async () => {
    const dir = await initRepo();
    try {
      const root = await resolveRepoRoot(dir);
      // git may report the temp dir under a different (e.g. resolved-symlink) casing/
      // form on Windows/macOS — compare git's own idea of root against itself, which
      // is exactly what production code compares against too.
      const expected = git(dir, ['rev-parse', '--show-toplevel']).trim();
      assert.equal(root, expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves to the SAME repo root when invoked from a nested subdirectory — the exact bug this exists to prevent', async () => {
    const dir = await initRepo();
    try {
      const sub = join(dir, 'pa', 'deeper');
      await mkdir(sub, { recursive: true });

      const rootFromRoot = await resolveRepoRoot(dir);
      const rootFromSub = await resolveRepoRoot(sub);

      assert.equal(rootFromSub, rootFromRoot, 'repo root must not depend on cwd depth');
      // The specific failure mode this fixes: naively using cwd as repoRoot and
      // joining a git-relative path onto it produces a doubled, non-existent path.
      assert.notEqual(rootFromSub, sub, 'must not just echo back the subdirectory (the process.cwd() bug)');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects when cwd is not inside any git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pa-git-root-notrepo-'));
    try {
      await assert.rejects(() => resolveRepoRoot(dir), /not a git repository|show-toplevel/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('repoRootFromModule', () => {
  it('returns the repo root when called with this test module\'s own __filename (pa/ is CommonJS; import.meta is unavailable)', async () => {
    const startDir = dirname(__filename);
    const expected = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startDir,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();

    const root = await repoRootFromModule(__filename);
    assert.equal(root, expected);
  });

  it('memoises per module URL — a second call does not re-spawn git (proven by deleting the backing repo between calls)', async () => {
    const dir = await initRepo();
    const fakeModuleUrl = pathToFileURL(join(dir, 'fake-module.js')).href;
    try {
      const expected = git(dir, ['rev-parse', '--show-toplevel']).trim();
      const first = await repoRootFromModule(fakeModuleUrl);
      assert.equal(first, expected);

      // Remove the backing repo entirely. A non-memoised second call would
      // now either reject (no .git found) or walk up to some unrelated
      // ancestor — the cache must short-circuit before either happens.
      await rm(dir, { recursive: true, force: true });

      const second = await repoRootFromModule(fakeModuleUrl);
      assert.equal(second, first, 'cached value must survive the repo disappearing');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('walkUpToRepoRoot', () => {
  it('finds the root from a nested dist-like path', async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), 'pa-walkup-'));
    try {
      const nested = join(fakeRoot, 'pa', 'dist', 'tests');
      await mkdir(nested, { recursive: true });
      await writeFile(join(fakeRoot, 'pa', 'package.json'), '{}', 'utf8');

      const root = walkUpToRepoRoot(nested);
      assert.equal(root, fakeRoot);
    } finally {
      await rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it('throws with a clear message when no repo root exists above the start dir', () => {
    assert.throws(
      () => walkUpToRepoRoot('C:\\'),
      /no repo root above/
    );
  });
});
