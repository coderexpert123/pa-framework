// pa public-sync — deterministic sync of the public mirror's working directory
// (<repo root>/pa-public by default — nested but independent, own .git/,
// gitignored by the private repo) from THIS repo's private git HEAD. Implements
// plans/2026-08-05-concurrent-session-safety.md §3.4.
//
// The public directory is fully DERIVED: every run resets it to `main`,
// extracts the private repo's committed HEAD tree over it (never the working
// tree — that is what makes "uncommitted private content can't reach public"
// a property of the mechanism instead of a rule someone has to remember),
// and deletes any file the public tree still tracks that private HEAD no
// longer has. Nothing in `privateDir` is ever written.
//
// All git/tar invocations use spawn() with an argv array (never shell:true)
// so paths containing spaces (this repo's own "D:/Personal Assistant") are
// passed through untouched, and windowsHide:true per the 2026-08-05 repo
// rule so these subprocess calls don't flash a console window.

import { spawn } from 'child_process';
import { access, rm } from 'fs/promises';
import { join } from 'path';

// Windows: PATH often puts git-bash's bundled GNU tar (MSYS) ahead of the
// native bsdtar at System32\tar.exe (Windows 10 1803+). MSYS tar cannot
// create a symlink until it can stat the target to determine file-vs-
// directory type — if the target's tar entry hasn't been extracted yet
// (alphabetically later, exactly this repo's own AGENTS.md -> CLAUDE.md), it
// either drops the symlink entry silently or hard-fails the whole extraction
// with exit 2. Native bsdtar creates the symlink unconditionally, matching
// POSIX semantics (a symlink may point at a not-yet-existing target). Pin the
// absolute path so PATH order never matters — found 2026-08-06 the first
// time `pa public-sync` ran for real against this actual repo.
function resolveTarCommand(): string {
  if (process.platform === 'win32') {
    return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  }
  return 'tar';
}

export const ERR_DIRTY_PRIVATE = 2;
export const ERR_NO_TAR = 3;
export const ERR_PUBLIC_NOT_MAIN = 4;

export interface SyncOptions {
  privateDir: string;
  publicDir: string;
  dryRun?: boolean;
}

export interface SyncResult {
  ok: boolean;
  code: number;
  extracted: number;
  pruned: string[];
  publicStatus: string;
  error?: string;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true });
    } catch (err: any) {
      resolve({ code: -1, stdout: '', stderr: String(err?.message ?? err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err: any) => resolve({ code: -1, stdout, stderr: stderr || String(err?.message ?? err) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function splitLines(s: string): string[] {
  return s.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Pipes `git archive --format=tar HEAD` from privateDir directly into `tar -x` inside publicDir. */
function extractHead(privateDir: string, publicDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const archive = spawn('git', ['-C', privateDir, 'archive', '--format=tar', 'HEAD'], { windowsHide: true });
    const extract = spawn(resolveTarCommand(), ['-x', '-C', publicDir], { windowsHide: true });

    let archiveStderr = '';
    let extractStderr = '';
    archive.stderr.on('data', (d) => { archiveStderr += d.toString(); });
    extract.stderr.on('data', (d) => { extractStderr += d.toString(); });
    archive.stdout.pipe(extract.stdin);

    let archiveCode: number | null = null;
    let extractCode: number | null = null;
    let archiveDone = false;
    let extractDone = false;
    let settled = false;

    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    const finish = () => {
      if (!archiveDone || !extractDone || settled) return;
      settled = true;
      if (archiveCode !== 0) reject(new Error(`git archive failed (exit ${archiveCode}): ${archiveStderr.trim()}`));
      else if (extractCode !== 0) reject(new Error(`tar extract failed (exit ${extractCode}): ${extractStderr.trim()}`));
      else resolve();
    };

    archive.on('error', fail);
    extract.on('error', fail);
    archive.on('close', (code) => { archiveCode = code; archiveDone = true; finish(); });
    extract.on('close', (code) => { extractCode = code; extractDone = true; finish(); });
  });
}

export async function syncPublicMirror(opts: SyncOptions): Promise<SyncResult> {
  const { privateDir, publicDir, dryRun = false } = opts;
  const empty = { extracted: 0, pruned: [] as string[], publicStatus: '' };

  // Step 1 — private tree must be clean (readiness check: public-sync extracts
  // HEAD, so a dirty private tree means HEAD doesn't match what's really here).
  const privateStatus = await run('git', ['-C', privateDir, 'status', '--porcelain']);
  if (privateStatus.code !== 0) {
    return { ok: false, code: ERR_DIRTY_PRIVATE, ...empty, error: `git status failed in private repo: ${privateStatus.stderr.trim()}` };
  }
  if (privateStatus.stdout.trim() !== '') {
    return { ok: false, code: ERR_DIRTY_PRIVATE, ...empty, error: `private repo is dirty:\n${privateStatus.stdout}` };
  }

  // Step 2 — tar must be available (Windows 10 1803+ ships bsdtar at System32).
  const tarCommand = resolveTarCommand();
  const tarCheck = await run(tarCommand, ['--version']);
  if (tarCheck.code !== 0) {
    return { ok: false, code: ERR_NO_TAR, ...empty, error: `${tarCommand} --version failed; tar is required (Windows 10 1803+ ships bsdtar at C:\\Windows\\System32\\tar.exe)` };
  }

  // Step 3 — public dir must be an existing repo already on main.
  if (!(await pathExists(join(publicDir, '.git')))) {
    return { ok: false, code: ERR_PUBLIC_NOT_MAIN, ...empty, error: `${publicDir}/.git does not exist` };
  }
  const branchCheck = await run('git', ['-C', publicDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchCheck.stdout.trim();
  if (branchCheck.code !== 0 || branch !== 'main') {
    return { ok: false, code: ERR_PUBLIC_NOT_MAIN, ...empty, error: `public repo is not on main (found: '${branch}')` };
  }

  // Compute the prune set now — needed by both --dry-run and a real run, and
  // reading it here (before any write) is what makes --dry-run side-effect-free.
  const publicTrackedRaw = await run('git', ['-C', publicDir, 'ls-files']);
  const privateHeadRaw = await run('git', ['-C', privateDir, 'ls-tree', '-r', '--name-only', 'HEAD']);
  const publicTracked = splitLines(publicTrackedRaw.stdout);
  const privateHead = new Set(splitLines(privateHeadRaw.stdout));
  const pruned = publicTracked.filter((p) => !privateHead.has(p)).sort();

  if (dryRun) {
    const publicStatusRaw = await run('git', ['-C', publicDir, 'status', '--porcelain']);
    return { ok: true, code: 0, extracted: privateHead.size, pruned, publicStatus: publicStatusRaw.stdout };
  }

  // Step 4 — reset the derived tree.
  await run('git', ['-C', publicDir, 'checkout', '-f', 'main']);
  await run('git', ['-C', publicDir, 'clean', '-fdx']);

  // Step 5 — extract private HEAD onto the now-clean public tree.
  try {
    await extractHead(privateDir, publicDir);
  } catch (err: any) {
    return { ok: false, code: 1, ...empty, error: `extraction failed: ${err?.message ?? err}` };
  }

  // Step 6 — prune files the public tree still tracks but private HEAD no longer has.
  for (const p of pruned) {
    await rm(join(publicDir, p), { force: true });
  }

  // Step 7 — report.
  const publicStatusRaw = await run('git', ['-C', publicDir, 'status', '--porcelain']);
  return { ok: true, code: 0, extracted: privateHead.size, pruned, publicStatus: publicStatusRaw.stdout };
}
