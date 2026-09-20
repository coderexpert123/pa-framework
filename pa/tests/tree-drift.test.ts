import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { detectDrift, detectRangeDrift, mergeAgainstHead, restoreFromHead, defaultGitRunner } from '../src/lib/tree-drift.js';
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
  // Matches public-sync.test.ts's fixture convention. Without this, Windows git
  // rewrites LF to CRLF on any git-mediated write (checkout, etc.) — didn't matter
  // for this file's pre-existing tests (they only ever compare direct writeFile/
  // readFile round-trips, never git checkout), but restoreFromHead's tests do a
  // real `git checkout HEAD --`, which silently reflowed line endings and produced
  // 'v1\r\n' !== 'v1\n' — found adding that coverage in a 2026-08-06 deep-recheck.
  git(dir, ['config', 'core.autocrlf', 'false']);
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

  it('catches a live reversion on a NON-ASCII path — porcelain C-quoting must decode, not leave escapes (2026-09-18 verifier finding)', async () => {
    const dir = await initRepo();
    try {
      const name = 'फ़ाइल.txt';
      const shaV0 = await commitFile(dir, name, 'v0\n', 'v0');
      await commitFile(dir, name, 'v1\n', 'v1');
      await writeFile(join(dir, name), 'v0\n'); // uncommitted live reversion

      const findings = await detectDrift(dir);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].path, name);
      assert.equal(findings[0].ancestorSha, shaV0);
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

  it('throws rather than silently reporting "clean" when `git status` itself fails', async () => {
    const dir = await initRepo();
    try {
      await commitFile(dir, 'a.txt', 'v1\n', 'add a');
      const failingRunner: GitRunner = async (repoRoot, args, input) => {
        if (args[0] === 'status') {
          return { stdout: Buffer.alloc(0), stderr: Buffer.from('fatal: not a git repository'), code: 128 };
        }
        return defaultGitRunner(repoRoot, args, input);
      };
      await assert.rejects(
        () => detectDrift(dir, { gitRunner: failingRunner }),
        /git status failed \(exit 128\)/
      );
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('throws rather than silently skipping a file when `git rev-list` fails for it', async () => {
    const dir = await initRepo();
    try {
      await commitFile(dir, 'a.txt', 'v1\n', 'add a');
      await writeFile(join(dir, 'a.txt'), 'v2\n'); // modified — becomes a drift candidate
      const failingRunner: GitRunner = async (repoRoot, args, input) => {
        if (args[0] === 'rev-list') {
          return { stdout: Buffer.alloc(0), stderr: Buffer.from('fatal: bad revision'), code: 128 };
        }
        return defaultGitRunner(repoRoot, args, input);
      };
      await assert.rejects(
        () => detectDrift(dir, { gitRunner: failingRunner }),
        /git rev-list failed for a\.txt \(exit 128\)/
      );
    } finally {
      await cleanupRepo(dir);
    }
  });
});

describe('detectRangeDrift', () => {
  it('reports exactly one finding with ancestorSha = the v0 commit when the range reverts to older-than-base content', async () => {
    const dir = await initRepo();
    try {
      const shaV0 = await commitFile(dir, 'a.txt', 'v0\n', 'v0');
      await commitFile(dir, 'a.txt', 'v1\n', 'v1');
      git(dir, ['branch', 'base']);
      await commitFile(dir, 'a.txt', 'v2\n', 'v2');
      await commitFile(dir, 'a.txt', 'v0\n', 'revert to v0');

      const result = await detectRangeDrift(dir, 'base');
      assert.equal(result.baseSha, git(dir, ['rev-parse', 'base']).trim());
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].path, 'a.txt');
      assert.equal(result.findings[0].kind, 'reverted-to-ancestor');
      assert.equal(result.findings[0].ancestorSha, shaV0);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('reports nothing when the range reverts to base content itself (HEAD==base ships nothing reverted)', async () => {
    const dir = await initRepo();
    try {
      await commitFile(dir, 'a.txt', 'v0\n', 'v0');
      await commitFile(dir, 'a.txt', 'v1\n', 'v1');
      git(dir, ['branch', 'base']);
      await commitFile(dir, 'a.txt', 'v2\n', 'v2');
      await commitFile(dir, 'a.txt', 'v1\n', 'revert to v1 (= base content)');

      const result = await detectRangeDrift(dir, 'base');
      assert.deepEqual(result.findings, []);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('reports nothing for a forward-only range (no ancestor match)', async () => {
    const dir = await initRepo();
    try {
      await commitFile(dir, 'a.txt', 'v0\n', 'v0');
      await commitFile(dir, 'a.txt', 'v1\n', 'v1');
      git(dir, ['branch', 'base']);
      await commitFile(dir, 'a.txt', 'v2 brand new\n', 'forward');

      const result = await detectRangeDrift(dir, 'base');
      assert.deepEqual(result.findings, []);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('reports nothing for a file newly added in the range', async () => {
    const dir = await initRepo();
    try {
      await commitFile(dir, 'a.txt', 'v1\n', 'v1');
      git(dir, ['branch', 'base']);
      await commitFile(dir, 'b.txt', 'new file\n', 'add b');

      const result = await detectRangeDrift(dir, 'base');
      assert.deepEqual(result.findings, []);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('reports nothing for a file deleted in the range', async () => {
    const dir = await initRepo();
    try {
      await commitFile(dir, 'a.txt', 'v1\n', 'v1');
      await commitFile(dir, 'b.txt', 'b-v1\n', 'add b');
      git(dir, ['branch', 'base']);
      git(dir, ['rm', '-q', 'b.txt']);
      git(dir, ['commit', '-q', '-m', 'delete b']);

      const result = await detectRangeDrift(dir, 'base');
      assert.deepEqual(result.findings, []);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('misses an old reversion at maxCommits 3 but catches it at 50 (bounded scan)', async () => {
    const dir = await initRepo();
    try {
      const shaOld = await commitFile(dir, 'a.txt', 'v-old\n', 'old');
      for (let i = 0; i < 5; i++) {
        await commitFile(dir, 'a.txt', `v${i}\n`, `v${i}`);
      }
      git(dir, ['branch', 'base']);
      await commitFile(dir, 'a.txt', 'v-new\n', 'new');
      await commitFile(dir, 'a.txt', 'v-old\n', 'revert to old');

      const narrow = await detectRangeDrift(dir, 'base', { maxCommits: 3 });
      assert.deepEqual(narrow.findings, []);

      // Sanity: the same fixture DOES get flagged with a wide-enough window.
      const wide = await detectRangeDrift(dir, 'base', { maxCommits: 50 });
      assert.equal(wide.findings.length, 1);
      assert.equal(wide.findings[0].ancestorSha, shaOld);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('issues exactly 2 + 2 per-range-path + 1 per-rename git calls (merge-base + diff + rev-list/cat-file per path, extra rev-list per rename)', async () => {
    const dir = await initRepo();
    try {
      const paths = ['a.txt', 'b.txt', 'c.txt'];
      for (const p of paths) {
        await commitFile(dir, p, `${p}-v1\n`, `${p} v1`);
      }
      await commitFile(dir, 'd.txt', 'd-v1\n', 'd v1');
      git(dir, ['branch', 'base']);
      for (const p of paths) {
        await commitFile(dir, p, `${p}-v2\n`, `${p} v2`);
      }
      git(dir, ['mv', 'd.txt', 'e.txt']); // pure rename → R100 entry
      git(dir, ['commit', '-q', '-m', 'rename d to e']);

      let callCount = 0;
      const countingRunner: GitRunner = async (repoRoot, args, input) => {
        callCount++;
        return defaultGitRunner(repoRoot, args, input);
      };

      const result = await detectRangeDrift(dir, 'base', { gitRunner: countingRunner });
      assert.deepEqual(result.findings, []);
      const rangePaths = 4; // a.txt, b.txt, c.txt modified + e.txt (rename new name)
      const renames = 1;
      assert.equal(callCount, 2 + 2 * rangePaths + renames);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('throws fail-closed when merge-base cannot resolve the ref', async () => {
    const dir = await initRepo();
    try {
      await commitFile(dir, 'a.txt', 'v1\n', 'v1');
      await assert.rejects(
        () => detectRangeDrift(dir, 'no-such-ref'),
        /git merge-base failed \(no-such-ref\)/
      );
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('throws fail-closed when the batched cat-file call fails — a broken batch read must never scan clean (2026-09-18 verifier finding)', async () => {
    const dir = await initRepo();
    try {
      await commitFile(dir, 'a.txt', 'v1\n', 'v1');
      git(dir, ['branch', 'base']);
      await commitFile(dir, 'a.txt', 'v2\n', 'v2'); // a range path exists so cat-file IS invoked

      const failingRunner: GitRunner = async (repoRoot, args, input) => {
        if (args[0] === 'cat-file') {
          return { stdout: Buffer.from(''), stderr: Buffer.from('simulated cat-file failure'), code: 128 };
        }
        return defaultGitRunner(repoRoot, args, input);
      };
      await assert.rejects(
        () => detectRangeDrift(dir, 'base', { gitRunner: failingRunner }),
        /git cat-file failed/
      );
      // And the same failure does NOT degrade into a clean scan on the live
      // path either — needs a dirty file so a candidate reaches checkFileDrift.
      await writeFile(join(dir, 'a.txt'), 'live edit\n');
      await assert.rejects(
        () => detectDrift(dir, { gitRunner: failingRunner }),
        /git cat-file failed/
      );
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('catches a reversion on a NON-ASCII path — the -z range diff must not C-quote it into invisibility (2026-09-18 verifier finding)', async () => {
    const dir = await initRepo();
    try {
      const name = 'फ़ाइल.txt'; // C-quoted by core.quotepath in every un-flagged git listing
      const shaV0 = await commitFile(dir, name, 'v0\n', 'v0');
      await commitFile(dir, name, 'v1\n', 'v1');
      git(dir, ['branch', 'base']);
      await commitFile(dir, name, 'v2\n', 'v2');
      await commitFile(dir, name, 'v0\n', 'revert to v0');

      const result = await detectRangeDrift(dir, 'base');
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].path, name);
      assert.equal(result.findings[0].ancestorSha, shaV0);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('catches a rename+revert evasion: `git mv a→b` plus reverting content to a pre-base ancestor (name-only diff read this as delete+add — clean)', async () => {
    const dir = await initRepo();
    try {
      const v0 = 'line1\nline2\nline3\nversion0\n';
      const v1 = 'line1\nline2\nline3\nversion1\n';
      const shaV0 = await commitFile(dir, 'a.txt', v0, 'v0');
      await commitFile(dir, 'a.txt', v1, 'v1');
      git(dir, ['branch', 'base']);
      git(dir, ['mv', 'a.txt', 'b.txt']);
      await writeFile(join(dir, 'b.txt'), v0); // revert under the new name
      git(dir, ['add', 'b.txt']);
      git(dir, ['commit', '-q', '-m', 'rename a to b + revert to v0']);

      const result = await detectRangeDrift(dir, 'base');
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].path, 'b.txt');
      assert.equal(result.findings[0].kind, 'reverted-to-ancestor');
      assert.equal(result.findings[0].ancestorSha, shaV0);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('reports nothing when a renamed file is edited FORWARD (content carried forward, not reverted)', async () => {
    const dir = await initRepo();
    try {
      const v0 = 'line1\nline2\nline3\nversion0\n';
      const v1 = 'line1\nline2\nline3\nversion1\n';
      const v2 = 'line1\nline2\nline3\nversion2-forward\n';
      await commitFile(dir, 'a.txt', v0, 'v0');
      await commitFile(dir, 'a.txt', v1, 'v1');
      git(dir, ['branch', 'base']);
      git(dir, ['mv', 'a.txt', 'b.txt']);
      await writeFile(join(dir, 'b.txt'), v2);
      git(dir, ['add', 'b.txt']);
      git(dir, ['commit', '-q', '-m', 'rename a to b + forward edit']);

      const result = await detectRangeDrift(dir, 'base');
      assert.deepEqual(result.findings, []);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('reports nothing for a PURE rename (R100, content carried forward byte-identical) — the old-name base check keeps clean renames out of the findings', async () => {
    const dir = await initRepo();
    try {
      const v1 = 'line1\nline2\nline3\nversion1\n';
      await commitFile(dir, 'a.txt', v1, 'v1');
      git(dir, ['branch', 'base']);
      git(dir, ['mv', 'a.txt', 'b.txt']);
      git(dir, ['commit', '-q', '-m', 'pure rename a to b']);

      const result = await detectRangeDrift(dir, 'base');
      assert.deepEqual(result.findings, []);
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('pins git -M behavior on a copy-without-deletion: a new file holding an OLDER blob of a surviving source reports A, not C — and scans clean', async () => {
    const dir = await initRepo();
    try {
      const shaOld = await commitFile(dir, 'a.txt', 'alpha\nbeta\ngamma\nOLD\n', 'older');
      await commitFile(dir, 'a.txt', 'alpha\nbeta\ngamma\nNEW\n', 'current');
      git(dir, ['branch', 'base']);
      const olderContent = git(dir, ['show', `${shaOld}:a.txt`]);
      await commitFile(dir, 'b.txt', olderContent, 'add b = older a content');

      // Pin: `-M` (verified against `git diff --name-status -z -M` on this fixture)
      // reports the add as 'A' — copy detection only compares against the source's
      // CURRENT blob, and a.txt survives at HEAD so nothing pairs as R or C. This
      // copy-of-older-content-under-new-name evasion remains a documented edge.
      const nameStatus = git(dir, ['diff', '--name-status', '-z', '-M', 'base', 'HEAD', '--']);
      assert.equal(nameStatus, 'A\0b.txt\0');

      const result = await detectRangeDrift(dir, 'base');
      assert.deepEqual(result.findings, []);
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

  it('rejects a path-traversal argument rather than reading outside the repo (2026-08-06 deep-recheck finding)', async () => {
    const dir = await initRepo();
    try {
      await commitFile(dir, 'a.txt', 'v1\n', 'add a');
      // Escapes `dir` entirely — this is a DIRECT readFile(join(repoRoot, relPath)),
      // not git-mediated, so nothing but explicit validation stops it reaching a real
      // file outside the repo (e.g. a sibling directory's secrets).
      await assert.rejects(
        () => mergeAgainstHead(dir, '../../../../etc/passwd'),
        /escapes the repo root/
      );
      await assert.rejects(
        () => mergeAgainstHead(dir, 'C:/Windows/System32/config/SAM'),
        /must be repo-relative, not absolute/
      );
    } finally {
      await cleanupRepo(dir);
    }
  });
});

describe('restoreFromHead', () => {
  it('restores a modified file to HEAD\'s exact content', async () => {
    const dir = await initRepo();
    try {
      await commitFile(dir, 'a.txt', 'v1\n', 'add a');
      await writeFile(join(dir, 'a.txt'), 'locally modified\n');

      const result = await restoreFromHead(dir, 'a.txt');

      assert.equal(result.code, 0);
      const onDisk = await readFile(join(dir, 'a.txt'), 'utf8');
      assert.equal(onDisk, 'v1\n');
    } finally {
      await cleanupRepo(dir);
    }
  });

  it('rejects a path-traversal argument rather than checking out outside the repo (2026-08-06 deep-recheck finding)', async () => {
    const dir = await initRepo();
    try {
      await commitFile(dir, 'a.txt', 'v1\n', 'add a');
      await assert.rejects(
        () => restoreFromHead(dir, '../../../../etc/passwd'),
        /escapes the repo root/
      );
    } finally {
      await cleanupRepo(dir);
    }
  });
});
