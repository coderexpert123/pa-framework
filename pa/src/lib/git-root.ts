import { spawn } from 'child_process';
import { existsSync } from 'fs';
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
 * until 2026-08-23 (plans/2026-08-23-alerts-week-review.md §5.2).
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
