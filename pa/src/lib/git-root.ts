import { spawn } from 'child_process';

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
