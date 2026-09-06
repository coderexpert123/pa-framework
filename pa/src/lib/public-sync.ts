// pa public-sync — deterministic sync of the public mirror's working directory
// (<repo root>/pa-public by default — nested but independent, own .git/,
// gitignored by the private repo) from THIS repo's private git HEAD. Implements
// the 2026-08-05 concurrent-session-safety design (§3.4).
//
// The public directory is fully DERIVED: every run resets it to `main`,
// extracts the private repo's committed HEAD tree over it (never the working
// tree — that is what makes "uncommitted private content can't reach public"
// a property of the mechanism instead of a rule someone has to remember),
// FILTERED through the public boundary (HEAD paths the public repo's own
// ignore rules exclude are counted and never written), and deletes any file
// the public tree still tracks that private HEAD no longer has. Nothing in
// `privateDir` is ever written.
//
// All git/tar invocations use spawn() with an argv array (never shell:true)
// so paths containing spaces are passed through untouched, and windowsHide:true
// per the 2026-08-05 repo
// rule so these subprocess calls don't flash a console window.

import { spawn } from 'child_process';
import { access, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { log } from './log.js';

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
  /** HEAD paths the public boundary excluded — counted, never written. */
  skipped: number;
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

import { resolvePythonCommand } from './python.js';

/**
 * Returns the subset of `paths` that the public repo's ignore rules exclude —
 * evaluated with `git check-ignore --stdin -z` inside publicDir itself, the
 * same oracle push-public's staging step uses (the mirror's core.excludesfile
 * is wired to the public boundary file, so one rule file governs staging AND
 * extraction). git exits 0 when at least one path is ignored and 1 when none
 * is; any other exit is an error (thrown — the caller fails the sync with it).
 */
async function computeSkippedPaths(publicDir: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const NUL = String.fromCharCode(0);
  const res = await new Promise<RunResult>((resolve) => {
    const child = spawn('git', ['-C', publicDir, 'check-ignore', '--stdin', '-z'], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err: any) => resolve({ code: -1, stdout, stderr: stderr || String(err?.message ?? err) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin?.end(paths.join(NUL) + NUL);
  });
  if (res.code !== 0 && res.code !== 1) {
    throw new Error(`git check-ignore failed (exit ${res.code}): ${res.stderr.trim()}`);
  }
  return new Set(res.stdout.split(NUL).map((p) => p.trim()).filter(Boolean));
}

/**
 * Pipes `git archive --format=tar HEAD` from privateDir into tar extraction in
 * publicDir. Tar members named in `skipPaths` are never written; returns the
 * number actually skipped, as reported by the extractor itself.
 */
async function extractHead(privateDir: string, publicDir: string, skipPaths: Set<string>): Promise<number> {
  // The skip list rides to the extractor as a NUL-separated list — NUL is the
  // one byte a path can never contain, so the member-name match stays exact.
  // Windows argv cannot carry NUL bytes, so the list goes via a one-shot temp
  // file (the extractor's only input side channel; the RESULT is
  // temp-file-free — it comes back as the extractor's last stdout line).
  let skipDir: string | undefined;
  try {
    const NUL = String.fromCharCode(0);
    let skipListArgs: string[] = [];
    if (skipPaths.size > 0) {
      skipDir = await mkdtemp(join(tmpdir(), 'pa-public-sync-skip-'));
      const skipListFile = join(skipDir, 'skip-list.txt');
      // `git archive` also emits a DIRECTORY member for every parent of an
      // extracted file. Directory members are never in the check-ignore set —
      // that lists files only — so an unexpanded list lets them extract as
      // empty directory husks of skipped trees (found 2026-09-04: pa-public
      // carried empty plans/ and projects/fitness-data-sync/ husks after a
      // sync whose file skips all worked). Expand the list with each skipped
      // path's ancestors, SLASH-LESS: the python extractor's TarInfo strips
      // the trailing slash from directory member names (tar(1) -t display
      // keeps it — not the form Python iterates), so the list is normalized
      // slash-less and the extractor compares the stripped member name. Nested
      // public files still extract (tar auto-creates parents), and the
      // extractor never counts directory members toward the SKIPPED total
      // (privateHead counts blobs only).
      const withDirMembers = new Set(skipPaths);
      for (const p of skipPaths) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) {
          withDirMembers.add(parts.slice(0, i).join('/'));
        }
      }
      await writeFile(skipListFile, [...withDirMembers].join(NUL) + NUL, 'utf8');
      skipListArgs = [skipListFile];
    }

    return await new Promise<number>((resolve, reject) => {
      const archive = spawn('git', ['-C', privateDir, 'archive', '--format=tar', 'HEAD'], { windowsHide: true });

      // Windows: CreateSymbolicLinkW fails without Developer Mode / Admin (common in standard user sessions).
      // Python tarfile extracts regular files and falls back to writing symlink target content as text files
      // on OSError (matching git's core.symlinks=false Windows behavior).
      const pythonCmd = resolvePythonCommand();
      const pythonScript = [
        'import sys, tarfile, os',
        'target = sys.argv[1]',
        'skipped = 0',
        'skip = set()',
        'if len(sys.argv) > 2:',
        '    with open(sys.argv[2], "rb") as fh:',
        '        skip = set(p for p in fh.read().decode("utf-8").split(chr(0)) if p)',
        'with tarfile.open(fileobj=sys.stdin.buffer, mode="r|*") as tar:',
        '    for member in tar:',
        '        name = member.name',
        '        if name.endswith("/"):',
        '            name = name[:-1]',
        '        if name in skip:',
        '            if not member.isdir():',
        '                skipped += 1',
        '            if member.isfile():',
        '                fh = tar.extractfile(member)',
        '                while fh and fh.read(65536):',
        '                    pass',
        '            continue',
        '        dest_path = os.path.join(target, member.name)',
        '        if member.issym() or member.islnk():',
        '            os.makedirs(os.path.dirname(dest_path), exist_ok=True)',
        '            try:',
        '                if os.path.lexists(dest_path):',
        '                    os.remove(dest_path)',
        '                os.symlink(member.linkname, dest_path)',
        '            except OSError:',
        '                with open(dest_path, "w", encoding="utf-8") as f:',
        '                    f.write(member.linkname)',
        '        else:',
        '            try:',
        '                tar.extract(member, path=target, filter="tar")',
        '            except TypeError:',
        '                tar.extract(member, path=target)',
        'print("SKIPPED %d" % skipped)',
      ].join('\n');

      const extract = spawn(pythonCmd, ['-c', pythonScript, publicDir, ...skipListArgs], { windowsHide: true });

      let archiveStderr = '';
      let extractStdout = '';
      let extractStderr = '';
      archive.stderr.on('data', (d) => { archiveStderr += d.toString(); });
      extract.stdout.on('data', (d) => { extractStdout += d.toString(); });
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
        else {
          const lastLine = (extractStdout.trim().split('\n').pop() ?? '').trim();
          const m = /^SKIPPED (\d+)$/.exec(lastLine);
          if (!m) reject(new Error(`tar extract did not report a SKIPPED count (last stdout line: '${lastLine.slice(0, 120)}')`));
          else resolve(parseInt(m[1], 10));
        }
      };

      archive.on('error', fail);
      extract.on('error', fail);
      archive.on('close', (code) => { archiveCode = code; archiveDone = true; finish(); });
      extract.on('close', (code) => { extractCode = code; extractDone = true; finish(); });
    });
  } finally {
    if (skipDir) {
      await rm(skipDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function syncPublicMirror(opts: SyncOptions): Promise<SyncResult> {
  const { privateDir, publicDir, dryRun = false } = opts;
  const empty = { extracted: 0, skipped: 0, pruned: [] as string[], publicStatus: '' };

  // Step 1 — private tree must be clean (readiness check: public-sync extracts
  // HEAD, so a dirty private tree means HEAD doesn't match what's really here).
  const privateStatus = await run('git', ['-C', privateDir, 'status', '--porcelain']);
  if (privateStatus.code !== 0) {
    return { ok: false, code: ERR_DIRTY_PRIVATE, ...empty, error: `git status failed in private repo: ${privateStatus.stderr.trim()}` };
  }
  if (privateStatus.stdout.trim() !== '') {
    // A dirty private tree is an expected multi-session state, not a page
    // (2026-08-23): it fired on 5 of 7 days, 3 of those from manual
    // commit-and-push runs whose own Step-4 wrap-up already reports it
    // (the 2026-08-23 alerts-week-review decision, §5.4). Log only.
    log('warn', 'public-sync', 'blocked: private tree has uncommitted changes', {
      status: privateStatus.stdout.trim().slice(0, 500),
    });
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

  // Compute the skip set the same way — the HEAD paths the public boundary
  // excludes, decided by the public repo's own ignore rules. Read-only, so
  // --dry-run stays side-effect-free while still reporting the skip count.
  let skippedPaths: Set<string>;
  try {
    skippedPaths = await computeSkippedPaths(publicDir, [...privateHead].sort());
  } catch (err: any) {
    return { ok: false, code: 1, ...empty, error: `check-ignore failed: ${err?.message ?? err}` };
  }

  if (dryRun) {
    const publicStatusRaw = await run('git', ['-C', publicDir, 'status', '--porcelain']);
    return { ok: true, code: 0, extracted: privateHead.size - skippedPaths.size, skipped: skippedPaths.size, pruned, publicStatus: publicStatusRaw.stdout };
  }

  // Step 4 — reset the derived tree.
  await run('git', ['-C', publicDir, 'checkout', '-f', 'main']);
  await run('git', ['-C', publicDir, 'clean', '-fdx']);

  // Step 5 — extract private HEAD onto the now-clean public tree, minus every
  // path the boundary excludes (those are counted, never written).
  let skipped = 0;
  try {
    skipped = await extractHead(privateDir, publicDir, skippedPaths);
  } catch (err: any) {
    return { ok: false, code: 1, ...empty, error: `extraction failed: ${err?.message ?? err}` };
  }

  // Step 6 — prune files the public tree still tracks but private HEAD no longer has.
  for (const p of pruned) {
    await rm(join(publicDir, p), { force: true });
  }

  // Step 7 — report.
  const publicStatusRaw = await run('git', ['-C', publicDir, 'status', '--porcelain']);
  const extracted = privateHead.size - skipped;
  log('info', 'public-sync', `sync complete: extracted=${extracted} skipped=${skipped} pruned=${pruned.length}`);
  return { ok: true, code: 0, extracted, skipped, pruned, publicStatus: publicStatusRaw.stdout };
}
