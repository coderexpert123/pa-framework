import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, lstat, symlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { syncPublicMirror, ERR_DIRTY_PRIVATE, ERR_PUBLIC_NOT_MAIN } from '../src/lib/public-sync.js';

// Real throwaway git repos in temp dirs — no mocked git (repo TDD convention,
// mirrors self-improver.test.ts's "rollback: git-revert survives" fixture).
const runShell = promisify(execCb);

async function git(cwd: string, cmd: string): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await runShell(`git ${cmd}`, { cwd });
  return { stdout: String(stdout), stderr: String(stderr) };
}

async function initGitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, 'init -q -b main');
  await git(dir, 'config user.email pa-test@example.com');
  await git(dir, 'config user.name "pa test"');
  await git(dir, 'config commit.gpgsign false');
  await git(dir, 'config core.autocrlf false');
}

async function writeAndCommit(dir: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  await git(dir, 'add -A');
  await git(dir, `commit -q -m "${message}"`);
  const { stdout } = await git(dir, 'rev-parse HEAD');
  return stdout.trim();
}

let privateDir: string;
let publicDir: string;

beforeEach(async () => {
  privateDir = await mkdtemp(join(tmpdir(), 'pa-public-sync-private-'));
  publicDir = await mkdtemp(join(tmpdir(), 'pa-public-sync-public-'));
  await initGitRepo(privateDir);
  await initGitRepo(publicDir);

  // Private: 2 commits, several files, one matching a .gitignore-public-style
  // exclusion marker (extraction is unconditional — .gitignore-public only
  // governs what push-public later stages, not what public-sync extracts).
  await writeAndCommit(privateDir, {
    'README.md': '# hello\n',
    'src/a.ts': 'export const a = 1;\n',
    '.gitignore-public': '*.secret\n',
  }, 'base');
  await writeAndCommit(privateDir, {
    'src/a.ts': 'export const a = 2;\n',
  }, 'update a');

  // Public: independent history — a stale file private no longer has (must be
  // pruned) and a stale README (must be overwritten by private's content).
  await writeAndCommit(publicDir, {
    'README.md': '# stale public readme\n',
    'old.txt': 'should be pruned\n',
  }, 'public base');
});

afterEach(async () => {
  await rm(privateDir, { recursive: true, force: true }).catch(() => {});
  await rm(publicDir, { recursive: true, force: true }).catch(() => {});
});

describe('syncPublicMirror', () => {
  it('exits 2 on a dirty private tree, touching nothing in public', async () => {
    await writeFile(join(privateDir, 'src/a.ts'), 'export const a = 999; // dirty\n', 'utf8');

    const result = await syncPublicMirror({ privateDir, publicDir });

    assert.equal(result.ok, false);
    assert.equal(result.code, ERR_DIRTY_PRIVATE);
    assert.equal(await readFile(join(publicDir, 'old.txt'), 'utf8'), 'should be pruned\n');
    assert.equal(await readFile(join(publicDir, 'README.md'), 'utf8'), '# stale public readme\n');
  });

  it('exits 4 when the public repo is not on main', async () => {
    await git(publicDir, 'checkout -q -b sync/other');

    const result = await syncPublicMirror({ privateDir, publicDir });

    assert.equal(result.ok, false);
    assert.equal(result.code, ERR_PUBLIC_NOT_MAIN);
    assert.equal(await readFile(join(publicDir, 'old.txt'), 'utf8'), 'should be pruned\n');
  });

  it('extracts every private HEAD path into the public dir with identical content', async () => {
    const result = await syncPublicMirror({ privateDir, publicDir });

    assert.equal(result.ok, true);
    assert.equal(result.code, 0);
    assert.equal(await readFile(join(publicDir, 'README.md'), 'utf8'), '# hello\n');
    assert.equal(await readFile(join(publicDir, 'src/a.ts'), 'utf8'), 'export const a = 2;\n');
    assert.equal(await readFile(join(publicDir, '.gitignore-public'), 'utf8'), '*.secret\n');
  });

  it('never lets uncommitted/orphaned-commit private content reach public — only HEAD', async () => {
    // Baseline: public now matches private HEAD (v2).
    const first = await syncPublicMirror({ privateDir, publicDir });
    assert.equal(first.ok, true);
    assert.equal(await readFile(join(publicDir, 'src/a.ts'), 'utf8'), 'export const a = 2;\n');

    // Commit v3, then move HEAD back to v2 with --soft: the working tree/index
    // now hold v3's exact bytes — a real commit, just not the current HEAD.
    await writeAndCommit(privateDir, { 'src/a.ts': 'export const a = 3;\n' }, 'v3');
    await git(privateDir, 'reset --soft HEAD~1');

    const second = await syncPublicMirror({ privateDir, publicDir });

    assert.equal(second.ok, false);
    assert.equal(second.code, ERR_DIRTY_PRIVATE);
    // Public must still show v2 (HEAD's content) — never v3.
    assert.equal(await readFile(join(publicDir, 'src/a.ts'), 'utf8'), 'export const a = 2;\n');
  });

  it('prunes a file tracked publicly but absent from private HEAD, and lists it', async () => {
    const result = await syncPublicMirror({ privateDir, publicDir });

    assert.equal(result.ok, true);
    assert.deepEqual(result.pruned, ['old.txt']);
    await assert.rejects(readFile(join(publicDir, 'old.txt'), 'utf8'));
  });

  it('is idempotent: a second run changes nothing further and reports no prunes', async () => {
    await syncPublicMirror({ privateDir, publicDir });
    // public-sync only ever touches the working tree — staging/committing the
    // result (incl. the prune deletion) is push-public's job (§3.7 step 5).
    // Simulate that hand-off so the second run's `ls-files` reflects it.
    await git(publicDir, 'add -A');
    await git(publicDir, 'commit -q -m sync');
    const readmeAfterFirst = await readFile(join(publicDir, 'README.md'), 'utf8');
    const aAfterFirst = await readFile(join(publicDir, 'src/a.ts'), 'utf8');

    const second = await syncPublicMirror({ privateDir, publicDir });

    assert.equal(second.ok, true);
    assert.deepEqual(second.pruned, []);
    assert.equal(await readFile(join(publicDir, 'README.md'), 'utf8'), readmeAfterFirst);
    assert.equal(await readFile(join(publicDir, 'src/a.ts'), 'utf8'), aAfterFirst);
  });

  it('removes stale untracked junk via clean -fdx but leaves .git/ alone', async () => {
    await writeFile(join(publicDir, 'junk.tmp'), 'leftover from a crashed run\n', 'utf8');
    const gitInternalMarker = join(publicDir, '.git', 'PA_TEST_MARKER');
    await writeFile(gitInternalMarker, 'must survive\n', 'utf8');

    const result = await syncPublicMirror({ privateDir, publicDir });

    assert.equal(result.ok, true);
    await assert.rejects(readFile(join(publicDir, 'junk.tmp'), 'utf8'));
    assert.equal(await readFile(gitInternalMarker, 'utf8'), 'must survive\n');
  });

  it('--dry-run reports the prune set and writes nothing', async () => {
    const beforeStat = await stat(join(publicDir, 'README.md'));
    const beforeContent = await readFile(join(publicDir, 'README.md'), 'utf8');

    const result = await syncPublicMirror({ privateDir, publicDir, dryRun: true });

    assert.equal(result.ok, true);
    assert.deepEqual(result.pruned, ['old.txt']);

    const afterStat = await stat(join(publicDir, 'README.md'));
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(await readFile(join(publicDir, 'README.md'), 'utf8'), beforeContent);
    // old.txt must still be physically present — dry-run must not prune for real.
    assert.equal(await readFile(join(publicDir, 'old.txt'), 'utf8'), 'should be pruned\n');
  });

  it('extracts a tracked symlink whose target sorts AFTER it alphabetically (this repo\'s own AGENTS.md -> CLAUDE.md shape)', async (t) => {
    // Regression: `git archive HEAD | tar -x` on Windows resolved to git-bash's
    // bundled GNU tar (MSYS), which cannot create a symlink until it can stat
    // the target to determine file-vs-directory type — if the target's tar
    // entry hasn't been extracted yet (alphabetically later, as with the real
    // repo's AGENTS.md -> CLAUDE.md), it silently drops the symlink entry
    // entirely and (depending on ordering) can abort the whole extraction with
    // exit 2. Found 2026-08-06 the first time `pa public-sync` ran for real
    // against this actual repo — Wave 1's fixtures never included a tracked
    // symlink, so this was invisible to the original test suite. Windows'
    // native System32 bsdtar handles this correctly; the fix pins that binary.
    try {
      await symlink('z-target.txt', join(privateDir, 'a-link.txt'));
    } catch (e: any) {
      // Windows: creating a symlink needs SeCreateSymbolicLinkPrivilege (admin)
      // or Developer Mode — not guaranteed on every CI runner. This test
      // exercises extraction's handling of a tracked symlink, which is
      // orthogonal to whether *this test* can create one; skip rather than
      // false-fail the suite on an environment that can't.
      t.skip(`cannot create symlinks in this environment: ${e.message}`);
      return;
    }
    await writeFile(join(privateDir, 'z-target.txt'), 'target content\n', 'utf8');
    await git(privateDir, 'add -A');
    await git(privateDir, 'commit -q -m "add symlink + target"');

    const result = await syncPublicMirror({ privateDir, publicDir });

    assert.equal(result.ok, true, result.error);
    const linkStat = await lstat(join(publicDir, 'a-link.txt'));
    assert.ok(linkStat.isSymbolicLink(), 'a-link.txt must be extracted as a real symlink, not dropped or copied');
    assert.equal(await readFile(join(publicDir, 'a-link.txt'), 'utf8'), 'target content\n');
  });

  it('never touches the private repo — status stays empty after a full run', async () => {
    const result = await syncPublicMirror({ privateDir, publicDir });

    assert.equal(result.ok, true);
    const { stdout } = await git(privateDir, 'status --porcelain');
    assert.equal(stdout.trim(), '');
  });
});
