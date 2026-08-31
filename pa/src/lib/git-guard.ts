import { spawn } from 'child_process';
import { loadConfig } from '../config.js';
import type { PaConfig } from '../types.js';

export interface GitGuardResult {
  allowed: boolean;
  reason: string;
}

export interface GitGuardOptions {
  /** Directory for the work-tree check (default: process cwd). */
  cwd?: string;
  /** Test-only: replaces config loading. */
  loadConfigFn?: () => Promise<PaConfig>;
  /** Test-only: replaces the `git rev-parse --is-inside-work-tree` probe. */
  isInsideWorkTreeFn?: (cwd: string) => Promise<boolean>;
}

/** `git rev-parse --is-inside-work-tree` — exit 0 AND stdout 'true'. Inside a
 *  bare repo git exits 0 with 'false'; outside a repo it exits 128. Anything
 *  that is not exit-0-'true' means "no" (git-root.ts:20-42 spawn precedent:
 *  windowsHide, piped stdio, never a visible console window). */
async function isInsideWorkTree(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && out.trim() === 'true'));
  });
}

/**
 * Single guard for "may a skill run git on the user's behalf?" —
 * plans/2026-08-31-public-readiness-program.md WP-B. Allowed only when BOTH:
 *   1. config opted in: `git_workflow.enabled` is true, or the block is absent
 *      (legacy configs predate the knob; only an explicit false opts out), and
 *   2. the target directory is inside a git work tree.
 * Consumers: `pa git-guard` CLI (LLM skills), code-fixer's attemptCodeFix,
 * self-improver's git-revert rollback. Never inline this logic elsewhere.
 */
export async function checkGitWorkflowAllowed(opts: GitGuardOptions = {}): Promise<GitGuardResult> {
  let config: PaConfig;
  try {
    config = await (opts.loadConfigFn ?? loadConfig)();
  } catch (err: any) {
    return { allowed: false, reason: `config.yaml unreadable (${err?.message ?? err}) — git treated as not opted in` };
  }
  if (config.git_workflow?.enabled === false) {
    return { allowed: false, reason: 'git_workflow.enabled is false in config.yaml (run-only default) — set git_workflow: { enabled: true } to opt in' };
  }
  const cwd = opts.cwd ?? process.cwd();
  let inside: boolean;
  try {
    inside = await (opts.isInsideWorkTreeFn ?? isInsideWorkTree)(cwd);
  } catch {
    inside = false;
  }
  if (!inside) {
    return { allowed: false, reason: `not inside a git work tree (${cwd})` };
  }
  return { allowed: true, reason: 'opted in (or legacy config) and inside a git work tree' };
}
