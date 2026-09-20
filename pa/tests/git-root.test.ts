import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { resolveRepoRoot, repoRootFromModule, resolveWorkerTreeRoot, walkUpToRepoRoot } from '../src/lib/git-root.js';

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

describe('resolveWorkerTreeRoot', () => {
  // The AI-320 contract: a skill's declared `cwd:` is the default worker tree,
  // but a caller inside a LINKED WORKTREE of that same repo (equal
  // --git-common-dir) must get the caller's own toplevel — their pending files
  // live there, not in the declared checkout.

  it('returns the caller\'s worktree toplevel when invoked from a linked worktree of the declared repo', async () => {
    const dir = await initRepo();
    const wt = join(await mkdtemp(join(tmpdir(), 'pa-wt-')), 'linked');
    try {
      git(dir, ['worktree', 'add', '-b', 'wt-branch', wt]);
      const callerTop = git(wt, ['rev-parse', '--show-toplevel']).trim();

      const resolved = await resolveWorkerTreeRoot(dir, wt);
      assert.equal(resolved, callerTop,
        'linked worktree of the same repo must win over the declared main checkout');
      // Sanity: the two trees share one object store but are different dirs.
      assert.notEqual(callerTop, git(dir, ['rev-parse', '--show-toplevel']).trim());
    } finally {
      git(dir, ['worktree', 'remove', '--force', wt]);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns the declared tree\'s toplevel when the caller sits inside it — including a nested subdirectory', async () => {
    const dir = await initRepo();
    try {
      const sub = join(dir, 'pa', 'deeper');
      await mkdir(sub, { recursive: true });
      const expected = git(dir, ['rev-parse', '--show-toplevel']).trim();

      const resolved = await resolveWorkerTreeRoot(dir, sub);
      assert.equal(resolved, expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the declared cwd when the caller is inside a DIFFERENT repo', async () => {
    const dir = await initRepo();
    const foreign = await initRepo();
    try {
      const resolved = await resolveWorkerTreeRoot(dir, foreign);
      assert.equal(resolved, dir,
        'a foreign repo must never redirect the worker — different --git-common-dir');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(foreign, { recursive: true, force: true });
    }
  });

  it('keeps the declared cwd when the caller is inside a NESTED repo under the declared tree (pa-public shape)', async () => {
    const dir = await initRepo();
    try {
      const nested = join(dir, 'pa-public');
      await mkdir(nested, { recursive: true });
      git(nested, ['init', '-q', '-b', 'main']);
      git(nested, ['config', 'user.email', 'test@example.com']);
      git(nested, ['config', 'user.name', 'Test']);
      await writeFile(join(nested, 'f.txt'), 'x', 'utf8');
      git(nested, ['add', 'f.txt']);
      git(nested, ['commit', '-q', '-m', 'init']);

      const resolved = await resolveWorkerTreeRoot(dir, nested);
      assert.equal(resolved, dir,
        'a nested independent repo has its own common dir — not a worktree of the parent');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the declared cwd when the caller is not inside any git repository', async () => {
    const dir = await initRepo();
    const nowhere = await mkdtemp(join(tmpdir(), 'pa-git-root-notrepo-'));
    try {
      const resolved = await resolveWorkerTreeRoot(dir, nowhere);
      assert.equal(resolved, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(nowhere, { recursive: true, force: true });
    }
  });

  it('keeps the declared cwd untouched when the declared cwd is not itself a repo', async () => {
    const dir = await initRepo();
    const notARepo = await mkdtemp(join(tmpdir(), 'pa-git-root-declared-'));
    try {
      const resolved = await resolveWorkerTreeRoot(notARepo, dir);
      assert.equal(resolved, notARepo,
        'a non-repo declared cwd (e.g. ${PA_HOME} skills) passes through verbatim');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(notARepo, { recursive: true, force: true });
    }
  });

  it('returns the caller cwd when the skill declares no cwd — spawn already inherits it', async () => {
    const resolved = await resolveWorkerTreeRoot(undefined, join(tmpdir(), 'anywhere'));
    assert.equal(resolved, join(tmpdir(), 'anywhere'));
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

  it('throws with a clear message when no repo root exists above the start dir', async () => {
    // The "system temp is outside any repo" assumption is FALSE on this
    // deployment: run-tests.mjs redirects the child's TMP/TEMP to C:\wt\tmp,
    // and C:\wt\pa\package.json (a live pa checkout used as scratch) sits two
    // levels above it — so a flat temp dir's walk-up found "repo root" C:\wt
    // and returned instead of throwing (2026-09-14). No real path's ancestor
    // chain is test-controlled, so instead make the start dir DEEPER than the
    // function's 12-level walk bound: every directory it can inspect is one
    // this test created, which is provably repo-free on any machine.
    const repoFreeDir = await mkdtemp(join(tmpdir(), 'pa-git-root-notrepo-'));
    try {
      // 13 nested dirs > the 12-iteration cap: the walk checks the start dir
      // plus 11 ancestors — all inside this controlled subtree, none of which
      // can contain pa/package.json regardless of what lives further up.
      const deep = join(repoFreeDir, ...Array.from({ length: 13 }, () => 'd'));
      await mkdir(deep, { recursive: true });
      assert.throws(
        () => walkUpToRepoRoot(deep),
        /no repo root above/
      );
    } finally {
      await rm(repoFreeDir, { recursive: true, force: true });
    }
  });
});
