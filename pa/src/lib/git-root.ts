import { spawn } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * `git status --porcelain` and `git rev-list`/`git cat-file` always return paths
 * relative to the repo ROOT, regardless of the invoking process's cwd (verified
 * empirically against this repo's git — running from a subdirectory does not
 * change the paths). Any code that joins those paths back onto a filesystem
 * location (`join(repoRoot, relPath)`) must resolve the TRUE root via
 * `git rev-parse --show-toplevel`, never `process.cwd()` — otherwise, invoked
 * from a subdirectory (e.g. `cd pa && node dist/bin/pa.js reconcile --check`,
 * the standard workflow in every skill in this repo), the join produces a
 * doubled, non-existent path, every `fs.stat`/`fs.readFile` on it throws, and
 * whatever caught that exception silently reports "nothing found" — a false
 * negative in exactly the tools meant to catch real drift. Found 2026-08-05
 * during independent verification of `pa reconcile`/`pa claims`.
 */
export async function resolveRepoRoot(cwd: string = process.cwd()): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('close', (code) => {
      if (code === 0 && out.trim()) {
        // git always emits forward slashes here, even on Windows; normalize
        // nothing further so callers' own join()s behave consistently.
        resolve(out.trim());
      } else {
        reject(new Error(`git rev-parse --show-toplevel failed (exit ${code}): ${err.trim() || 'not a git repository'}`));
      }
    });
    child.on('error', (e) => reject(e));
  });
}

const repoRootCache = new Map<string, string>();

/**
 * Repo root resolved from the CALLING MODULE's own location — never
 * process.cwd(). Task Scheduler launches `pa catchup` with cwd
 * C:\Windows\System32 (schtasks "Start In: N/A"), so every cwd-relative path
 * in a maintenance job resolved into System32 and ENOENT'd: restore-drill
 * accumulated 11,228 consecutive failures and 180 sent alerts, and
 * clobber-sentinel reported green while detecting nothing, from 2026-08-17
 * until 2026-08-23 (the alerts-week review §5.2).
 * resolveRepoRoot()'s DEFAULT argument is process.cwd(), i.e. the bug itself —
 * always call this instead from module scope: repoRootFromModule(__filename).
 * (pa/ compiles to CommonJS — tsconfig module Node16, no "type":"module" — so
 * `import.meta.url` is NOT available here: tsc still EMITS a file containing the
 * literal `import.meta`, Node then auto-detects that one file as ESM and the whole
 * CLI dies at startup with "exports is not defined" — live incident 2026-08-23.
 * Accepts either a filesystem path (__filename) or a file:// URL for callers that
 * genuinely run as ESM.)
 * Memoised per module path: the callers run on 1-minute-to-monthly cadences and
 * a git spawn per tick is pure waste.
 */
export async function repoRootFromModule(modulePathOrUrl: string): Promise<string> {
  const cached = repoRootCache.get(modulePathOrUrl);
  if (cached) return cached;
  const modulePath = modulePathOrUrl.startsWith('file:') ? fileURLToPath(modulePathOrUrl) : modulePathOrUrl;
  const startDir = dirname(modulePath);
  let root: string;
  try {
    root = await resolveRepoRoot(startDir);
  } catch {
    root = walkUpToRepoRoot(startDir);
  }
  repoRootCache.set(modulePathOrUrl, root);
  return root;
}

/** Fallback for a checkout with no .git (extracted tarball, CI export): walk up
 *  until a directory contains pa/package.json. Layout-independent, so it does
 *  not silently break when the dist tree gains or loses a level. */
export function walkUpToRepoRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'pa', 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`repoRootFromModule: no repo root above ${startDir} (no .git, no pa/package.json)`);
}

/**
 * `git rev-parse --git-common-dir` resolved to an absolute, normalized-for-
 * comparison path — the shared object store two worktrees of ONE repo have in
 * common (a linked worktree's own .git dir differs; its common dir is the main
 * checkout's). Output can be repo-relative (`.git` from the main tree), so it
 * is resolved against the probe cwd, then realpath'd: on macOS TMPDIR is a
 * `/var` symlink to `/private/var`, and on Windows a TMPDIR path can carry
 * the 8.3 short name (`RUNNER~1`) while git's own --show-toplevel emits the
 * long form — either way the two sides never string-equal without
 * canonicalization (CI fail 2026-09-20, macOS + Windows
 * `resolveWorkerTreeRoot` subtests). `.native` is required on win32: the
 * default libuv fastpath resolves symlinks but leaves 8.3 names unexpanded,
 * and its `\\?\` prefix is stripped back off for comparison. Case-folded on
 * win32. Null outside a repo or without git — callers treat it as "no
 * worktree relationship provable".
 */
async function gitCommonDir(cwd: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0 || !out.trim()) return resolvePromise(null);
      let p = resolve(cwd, out.trim()).replace(/[\\/]+$/, '');
      try {
        p = realpathSync.native(p).replace(/^\\\\\?\\/, '');
      } catch { /* keep the unresolved form */ }
      if (process.platform === 'win32') p = p.toLowerCase();
      resolvePromise(p);
    });
    child.on('error', () => resolvePromise(null));
  });
}

/**
 * The working tree a spawned worker should run in: the skill's declared `cwd:`
 * by default — or the CALLER's toplevel when the caller invoked `pa run` from
 * inside a linked worktree of that same repo. Equal --git-common-dir means the
 * same object store, i.e. the same repository with a different checked-out
 * branch: the caller's pending files live THERE, not in the declared path.
 * Without this, `pa run commit` invoked from a worktree spawned its worker at
 * the frontmatter's hardcoded main checkout and reported "nothing to commit —
 * byte-identical to HEAD" over files that were modified in the caller's tree
 * (observed 2026-09-18, AI-315's commit run).
 *
 * Callers outside any repo (bot/scheduler cwd, C:\Windows\System32) and callers
 * inside a DIFFERENT repo — including nested repos like pa-public/ — fall back
 * to the declared cwd: the override only ever redirects within one repo's
 * worktree family, never across repositories. A skill with no declared cwd
 * already inherits the caller's cwd at spawn, so it returns the caller cwd
 * unchanged.
 */
export async function resolveWorkerTreeRoot(
  declaredCwd: string | undefined,
  callerCwd: string = process.cwd(),
): Promise<string> {
  if (!declaredCwd) return callerCwd;
  const declaredCommon = await gitCommonDir(declaredCwd);
  if (!declaredCommon) return declaredCwd;
  let callerTop: string;
  try {
    callerTop = await resolveRepoRoot(callerCwd);
  } catch {
    return declaredCwd;
  }
  const callerCommon = await gitCommonDir(callerTop);
  return callerCommon === declaredCommon ? callerTop : declaredCwd;
}
