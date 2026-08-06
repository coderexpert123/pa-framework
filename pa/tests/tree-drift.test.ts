import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { detectDrift, mergeAgainstHead, defaultGitRunner } from '../src/lib/tree-drift.js';
import type { GitRunner } from '../src/lib/tree-drift.js';

// ---------------------------------------------------------------------------
// Real throwaway git repos in temp dirs — no mocked git anywhere in this file
// (repo convention: mocks are not acceptable for anything git-critical). Every
// fixture below is built by actually invoking `git`.
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pa-tree-drift-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

/** Writes `relPath` with `content` and commits it. Returns the new commit's full sha. */
async function commitFile(dir: string, relPath: string, content: string | Buffer, message: string): Promise<string> {
  const abs = join(dir, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  git(dir, ['add', relPath]);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

async function cleanupRepo(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

describe('detectDrift', () => {
  it('reports nothing when the working tree matches HEAD', async () => {
    const dir = await initRepo();
    try {
      await commitFile(dir, 'a.txt', 'v1\n', 'add a');
      const findings = await detectDrift(dir);
      assert.deepEqual(findings, []);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('reports exactly one reverted-to-ancestor finding when the working tree is restored to an exact ancestor\'s bytes', async () => {
    const dir = await initRepo();
    try {
      const shaA = await commitFile(dir, 'a.txt', 'v1\n', 'v1');
      await commitFile(dir, 'a.txt', 'v2\n', 'v2');

      // Simulate the clobber: working tree reverted to A's exact bytes, HEAD stays at B.
      await writeFile(join(dir, 'a.txt'), 'v1\n');

      const findings = await detectDrift(dir);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].path, 'a.txt');
      assert.equal(findings[0].kind, 'reverted-to-ancestor');
      assert.equal(findings[0].ancestorSha, shaA);
      assert.notEqual(findings[0].headSha, shaA);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('does not report a file with genuinely new, uncommitted content (no false positives)', async () => {
    const dir = await initRepo();
    try {
      await commitFile(dir, 'a.txt', 'v1\n', 'v1');
      await commitFile(dir, 'a.txt', 'v2\n', 'v2');
      await writeFile(join(dir, 'a.txt'), 'brand new content never committed anywhere\n');

      const findings = await detectDrift(dir);
      assert.deepEqual(findings, []);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('ignores an untracked file without crashing', async () => {
    const dir = await initRepo();
    try {
      await commitFile(dir, 'a.txt', 'v1\n', 'v1');
      await writeFile(join(dir, 'untracked.txt'), 'nobody committed this\n');

      const findings = await detectDrift(dir);
      assert.deepEqual(findings, []);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('ignores a deleted tracked file without crashing', async () => {
    const dir = await initRepo();
    try {
      await commitFile(dir, 'a.txt', 'v1\n', 'v1');
      await rm(join(dir, 'a.txt'));

      const findings = await detectDrift(dir);
      assert.deepEqual(findings, []);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('reports exactly one finding when one file is reverted to an ancestor and a sibling file is genuinely edited', async () => {
    const dir = await initRepo();
    try {
      const shaA = await commitFile(dir, 'a.txt', 'v1\n', 'v1');
      await commitFile(dir, 'a.txt', 'v2\n', 'v2');
      await commitFile(dir, 'b.txt', 'b-v1\n', 'b v1');

      await writeFile(join(dir, 'a.txt'), 'v1\n'); // reverted to ancestor
      await writeFile(join(dir, 'b.txt'), 'b-v2 genuinely new\n'); // normal edit

      const findings = await detectDrift(dir);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].path, 'a.txt');
      assert.equal(findings[0].ancestorSha, shaA);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('does not report a reversion older than maxCommits (bounded scan)', async () => {
    const dir = await initRepo();
    try {
      const shaOld = await commitFile(dir, 'a.txt', 'v-old\n', 'old');
      for (let i = 0; i < 5; i++) {
        await commitFile(dir, 'a.txt', `v${i}\n`, `v${i}`);
      }
      await writeFile(join(dir, 'a.txt'), 'v-old\n');

      const findings = await detectDrift(dir, { maxCommits: 3 });
      assert.deepEqual(findings, []);

      // Sanity: the same fixture DOES get flagged with a wide-enough window.
      const findingsWide = await detectDrift(dir, { maxCommits: 50 });
      assert.equal(findingsWide.length, 1);
      assert.equal(findingsWide[0].ancestorSha, shaOld);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('detects a reverted binary blob via hash comparison, no text decoding', async () => {
    const dir = await initRepo();
    try {
      const bufA = Buffer.from([0, 1, 2, 3, 255, 254, 253, 10, 13, 0, 9, 200]);
      const bufB = Buffer.from([9, 9, 9, 8, 8, 8, 7, 7, 7, 6, 6, 6]);
      const shaA = await commitFile(dir, 'blob.bin', bufA, 'binary v1');
      await commitFile(dir, 'blob.bin', bufB, 'binary v2');

      await writeFile(join(dir, 'blob.bin'), bufA);

      const findings = await detectDrift(dir);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].path, 'blob.bin');
      assert.equal(findings[0].ancestorSha, shaA);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('issues at most ~3 git subprocess calls per modified file (batch-check, not per-commit rev-parse)', async () => {
    const dir = await initRepo();
    try {
      const paths = ['a.txt', 'b.txt', 'c.txt'];
      for (const p of paths) {
        await commitFile(dir, p, `${p}-v1\n`, `${p} v1`);
        await commitFile(dir, p, `${p}-v2\n`, `${p} v2`);
        await writeFile(join(dir, p), `${p}-v1\n`); // reverted — forces a full ancestor scan
      }

      let callCount = 0;
      const countingRunner: GitRunner = async (repoRoot, args, input) => {
        callCount++;
        return defaultGitRunner(repoRoot, args, input);
      };

      const findings = await detectDrift(dir, { gitRunner: countingRunner });
      assert.equal(findings.length, 3);

      // One `git status --porcelain` call up front, not counted per-file.
      const perFileCalls = (callCount - 1) / paths.length;
      assert.ok(perFileCalls <= 3, `expected <=3 git calls per modified file, got ${perFileCalls} (total ${callCount} for ${paths.length} files)`);
    } finally {
      await cleanupRepo(dir);
    }
  });
});

describe('mergeAgainstHead', () => {
  it('writes ours/base/theirs/result under scratch/reconcile-*/, returns merge-file\'s exit code, and leaves the working tree byte-unchanged', async () => {
    const dir = await initRepo();
    try {
      const base = 'line1\nline2\nline3\n';
      const theirs = 'line1\nHEAD-line2\nline3\n';
      const ours = 'line1\nWORKING-line2\nline3\n';

      await commitFile(dir, 'conflict.txt', base, 'base');
      await commitFile(dir, 'conflict.txt', theirs, 'head change');
      await writeFile(join(dir, 'conflict.txt'), ours); // uncommitted local edit, conflicts with HEAD's edit

      const result = await mergeAgainstHead(dir, 'conflict.txt');

      assert.equal(result.path, 'conflict.txt');
      assert.match(result.outputDir, /reconcile-/);
      assert.ok(result.outputDir.startsWith(join(dir, 'scratch')));

      const oursOnDisk = await readFile(result.oursPath, 'utf8');
      const baseOnDisk = await readFile(result.basePath, 'utf8');
      const theirsOnDisk = await readFile(result.theirsPath, 'utf8');
      assert.equal(oursOnDisk, ours);
      assert.equal(baseOnDisk, base);
      assert.equal(theirsOnDisk, theirs);

      // Same line changed on both sides relative to base — a genuine conflict.
      assert.ok(result.conflictCount > 0, `expected a conflict, got conflictCount=${result.conflictCount}`);
      const resultOnDisk = await readFile(result.resultPath, 'utf8');
      assert.match(resultOnDisk, /<<<<<<</);

      // The real working-tree file must never be touched.
      const workingTreeContent = await readFile(join(dir, 'conflict.txt'), 'utf8');
      assert.equal(workingTreeContent, ours);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('produces a clean merge (conflictCount 0) when only one side changed relative to base', async () => {
    const dir = await initRepo();
    try {
      const base = 'line1\nline2\nline3\n';
      const theirs = 'line1\nHEAD-line2\nline3\n';

      await commitFile(dir, 'clean.txt', base, 'base');
      await commitFile(dir, 'clean.txt', theirs, 'head change');
      // Working tree left identical to base (no local edit) — merges cleanly onto theirs.
      await writeFile(join(dir, 'clean.txt'), base);

      const result = await mergeAgainstHead(dir, 'clean.txt');
      assert.equal(result.conflictCount, 0);
      const resultOnDisk = await readFile(result.resultPath, 'utf8');
      assert.equal(resultOnDisk, theirs);
    } finally {
      await cleanupRepo(dir);
    }
  });
});
