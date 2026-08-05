import { homedir, platform } from 'os';
import { join, resolve as resolvePath } from 'path';
import { paHome } from '../../paths.js';
import type { MaintenanceJob, RetentionTarget } from './types.js';

export interface PolicyRoot {
  resolve: () => string;
  evidence: string;
}

/**
 * Roots a RetentionTarget is allowed to resolve under. Checked AFTER
 * FORBIDDEN_ROOTS — a forbidden hit always wins even if a path happens to
 * also fall under something listed here.
 */
export const ALLOWED_ROOTS: PolicyRoot[] = [
  {
    resolve: () => paHome(),
    evidence:
      "PA's own runtime state (~/.pa). PA created it and is the sole writer — " +
      'logs/, archive/, alert-state/, worker-pids/, blackboard.json, ' +
      'maintenance-state.json (audit 2026-08-02).',
  },
  {
    resolve: () => join(homedir(), '.gemini', 'antigravity-cli', 'conversations'),
    evidence:
      'Antigravity CLI (agy) resumable-conversation files. agy ships NO ' +
      'retention policy of its own, so PA prunes them at GC_RETENTION_MS (30d) ' +
      '— audit 2026-08-02, plans/2026-08-02-session-gc-scope-to-pa-spawned.md. ' +
      'Scoped to conversations/ only: ~/.gemini/antigravity and ' +
      'antigravity-browser-profile are app state, not transcripts, and are ' +
      'deliberately out of scope.',
  },
  {
    resolve: () => join(homedir(), '.codex'),
    evidence:
      'Codex CLI thread store (state_5.sqlite). Codex ships NO retention ' +
      'policy of its own; PA marks threads archived (never deletes rows) at ' +
      'GC_RETENTION_MS (30d) — audit 2026-08-02.',
  },
];

/**
 * Roots PA must never touch, regardless of any ALLOWED_ROOTS match. Checked
 * FIRST — a forbidden hit always wins. Each entry is here because the owning
 * tool self-manages its own retention, so PA has no legitimate reason to
 * write here at all.
 */
export const FORBIDDEN_ROOTS: PolicyRoot[] = [
  {
    resolve: () => join(homedir(), '.claude'),
    evidence:
      'Claude Code self-manages transcript retention (cleanupPeriodDays, 30d). ' +
      "PA deleted 248 of the operator's REAL interactive transcripts under " +
      '~/.claude/projects/<hash>/*.jsonl across 9 GC runs on 2026-08-02 ' +
      '(removed cleanupClaudeSessions, commit b2cf18c). PA has no way to ' +
      "distinguish its own spawned worker transcripts from the operator's own " +
      'sessions, so it must never touch this tree.',
  },
  {
    resolve: () => join(homedir(), '.gemini', 'tmp'),
    evidence:
      "Gemini CLI's own session store (~/.gemini/tmp/<projectDir>/chats/, both " +
      'the top-level session-*.json(l) layout and the UUID-subdirectory ' +
      'layout). Gemini CLI self-manages retention via sessionRetention.maxAge ' +
      '(30d). This is the exact tree the removed cleanupGeminiSessions() ' +
      'walked — see git show b2cf18c^:projects/telegram-bot/src/session.ts. ' +
      'DELIBERATELY PATH-PRECISE, NOT a blanket ~/.gemini: ' +
      '~/.gemini/antigravity-cli/conversations is an ALLOWED root and must ' +
      'stay reachable. Do not widen this entry.',
  },
];

/**
 * True when `target` is `root` itself or lies beneath it. Windows-safe:
 * path.resolve()s both, case-folds on win32, and requires a separator
 * boundary so "~/.gemini/tmpfoo" is NOT under "~/.gemini/tmp".
 */
export function isUnderRoot(target: string, root: string): boolean {
  const norm = (p: string) => {
    const r = resolvePath(p);
    return platform() === 'win32' ? r.replace(/\\/g, '/').toLowerCase() : r;
  };
  const t = norm(target);
  const r = norm(root).replace(/\/+$/, '');
  return t === r || t.startsWith(r + '/');
}

function resolveAllowedRoots(): { root: PolicyRoot; resolvedPath: string }[] {
  return ALLOWED_ROOTS.map((root) => ({ root, resolvedPath: root.resolve() }));
}

function resolveForbiddenRoots(): { root: PolicyRoot; resolvedPath: string }[] {
  return FORBIDDEN_ROOTS.map((root) => ({ root, resolvedPath: root.resolve() }));
}

/**
 * Throws on the first violation, naming the job, target index, resolved path
 * and rule. Never returns a partial result — fail-closed by construction.
 */
export function validateRegistry(jobs: MaintenanceJob[]): void {
  const seenNames = new Set<string>();

  for (const job of jobs) {
    const fail = (rule: string): never => {
      throw new Error(`[maintenance] invalid job '${job.name}': ${rule}`);
    };
    const failTarget = (index: number, resolvedPath: string, rule: string): never => {
      throw new Error(`[maintenance] invalid job '${job.name}' target[${index}] (${resolvedPath}): ${rule}`);
    };

    if (!/^[a-z0-9][a-z0-9-]*$/.test(job.name)) {
      fail("name must match /^[a-z0-9][a-z0-9-]*$/ (it is used as a config key, a CLI argument and a notify dedup key)");
    }

    if (seenNames.has(job.name)) {
      fail('duplicate job name');
    }
    seenNames.add(job.name);

    if (job.host !== 'pa' && job.host !== 'bot') {
      fail("host must be 'pa' or 'bot'");
    }

    const resolvedEveryMs = typeof job.everyMs === 'function' ? job.everyMs() : job.everyMs;
    if (!Number.isFinite(resolvedEveryMs) || resolvedEveryMs <= 0) {
      fail(`everyMs must resolve to a finite positive number of milliseconds (got ${resolvedEveryMs})`);
    }

    if (job.destructive === true && job.targets.length === 0) {
      fail('a destructive job must declare at least one RetentionTarget');
    }

    const allowedRoots = resolveAllowedRoots();
    const forbiddenRoots = resolveForbiddenRoots();

    job.targets.forEach((target, index) => {
      if (!target.evidence || !target.evidence.trim()) {
        failTarget(index, '<unresolved>', 'evidence must be a non-empty dated justification');
      }

      if (!Number.isFinite(target.maxAgeMs) || target.maxAgeMs <= 0) {
        failTarget(index, '<unresolved>', 'maxAgeMs must be a finite positive number of milliseconds');
      }

      let resolvedPath!: string;
      try {
        resolvedPath = target.resolve();
      } catch {
        failTarget(index, '<unresolved>', 'resolve() must return an absolute path');
      }
      if (resolvedPath !== resolvePath(resolvedPath)) {
        failTarget(index, resolvedPath, 'resolve() must return an absolute path');
      }

      const forbiddenHit = forbiddenRoots.find(({ resolvedPath: r }) => isUnderRoot(resolvedPath, r));
      if (forbiddenHit) {
        failTarget(
          index,
          resolvedPath,
          `resolves under a FORBIDDEN root (${forbiddenHit.resolvedPath}): ${forbiddenHit.root.evidence}`,
        );
      }

      const allowedHit = allowedRoots.some(({ resolvedPath: r }) => isUnderRoot(resolvedPath, r));
      if (!allowedHit) {
        const list = allowedRoots.map(({ resolvedPath: r }) => r).join(', ');
        failTarget(index, resolvedPath, `resolves outside every ALLOWED root (${list})`);
      }
    });
  }
}

/** Exposed for `pa maintenance list` and for tests. */
export function describeTarget(t: RetentionTarget): {
  resolvedPath: string;
  match: string;
  maxAgeMs: number;
  action: string;
  ownership: string;
  evidence: string;
  note?: string;
} {
  return {
    resolvedPath: t.resolve(),
    match: t.match.toString(),
    maxAgeMs: t.maxAgeMs,
    action: t.action,
    ownership: t.ownership,
    evidence: t.evidence,
    ...(t.note !== undefined ? { note: t.note } : {}),
  };
}
