/**
 * Clobber sentinel — detects working-tree files reverted to an ancestor of HEAD.
 *
 * Runs the same detection as `pa reconcile --check` (imports detectDrift directly,
 * no CLI shelling). Pages pa-alerts deduped per-file when drift is found. Skips
 * while @build or git-workflow locks are held (mid-commit reconcile reads are racy).
 *
 * Never mutates anything — pure detection + notification only.
 */
import { detectDrift, type DriftFinding } from '../../tree-drift.js';
import { readActive, normalizePath } from '../../reservations.js';
import { notifyUser } from '../../notify.js';
import { log } from '../../log.js';
import type { MaintenanceJob } from '../types.js';

const THIRTY_MINUTES = 30 * 60 * 1000;

/** Checks if the current active reservations include @build or git-workflow locks. */
async function isHeldByConflict(): Promise<boolean> {
  const active = await readActive();

  // Check for @build reservation
  const hasBuildLock = active.some((r) => r.paths.some((p) => p === '@build'));

  // Check for git-workflow exclusive_resource lock
  const hasGitWorkflowLock = active.some((r) =>
    r.paths.some((p) => p === 'exclusive_resource:git-workflow')
  );

  return hasBuildLock || hasGitWorkflowLock;
}

/** Builds a dedup key scoped to the drift finding's file path. */
function dedupKeyForFile(filePath: string): string {
  return `clobber-sentinel:${filePath}`;
}

/** Injectable dependencies for tests (the DI pattern the maintenance jobs use —
 *  ESM module namespaces are read-only, so callers override via deps, not mocks). */
export interface ClobberSentinelDeps {
  readActiveFn?: () => Promise<Array<{ paths: string[] }>>;
  detectDriftFn?: (repoRoot: string) => Promise<DriftFinding[]>;
  notifyFn?: (subject: string, body: string, opts?: Record<string, unknown>) => Promise<{ sent: boolean; suppressed: boolean }>;
}

export async function runClobberSentinel(deps: ClobberSentinelDeps = {}): Promise<{ touched: number; detail: Record<string, unknown> }> {
  const readActiveDep = deps.readActiveFn ?? readActive;
  const detectDriftDep = deps.detectDriftFn ?? detectDrift;
  const notifyDep = deps.notifyFn ?? notifyUser;

  // Skip while @build or git-workflow locks are held — mid-commit reconcile is racy
  const active = await readActiveDep();
  const hasBuildLock = active.some((r) => r.paths.some((p) => p === '@build'));
  const hasGitWorkflowLock = active.some((r) => r.paths.some((p) => p === 'exclusive_resource:git-workflow'));
  if (hasBuildLock || hasGitWorkflowLock) {
    log('info', 'maintenance', 'clobber-sentinel skipped: @build or git-workflow lock held');
    return { touched: 0, detail: { skipped: 'lock-held' } };
  }

  const findings: DriftFinding[] = [];
  try {
    const repoRoot = process.cwd(); // CWD is repo root when maintenance runs
    findings.push(...(await detectDriftDep(repoRoot)));
  } catch (err: any) {
    log('warn', 'maintenance', 'clobber-sentinel detectDrift failed', {
      error: err?.message ?? String(err),
    });
    return { touched: 0, detail: { error: 'detect-failed' } };
  }

  if (findings.length === 0) {
    return { touched: 0, detail: { findings: 0 } };
  }

  // Page pa-alerts deduped per-file (alert-state handles per-file suppression)
  let notified = 0;
  for (const finding of findings) {
    const key = dedupKeyForFile(finding.path);
    const message =
      `**Clobber detected:** \`${finding.path}\`\n\n` +
      `Working tree matches ancestor ${finding.ancestorSha.slice(0, 12)} but HEAD is ${finding.headSha.slice(0, 12)}.\n\n` +
      `This suggests something overwrote the file. Restore with:\n` +
      `\`pa reconcile --restore ${finding.path}\`\n\n` +
      `_Ref: s-${generateRefId()}_`;

    const result = await notifyDep(`Clobber detected: ${finding.path}`, message, {
      dedupKey: key,
      dedupWindowMs: THIRTY_MINUTES,
      severity: 'warn',
    }).catch(() => ({ sent: false, suppressed: false }));

    if (result.sent) notified++;
  }

  log('warn', 'maintenance', `clobber-sentinel detected ${findings.length} clobber(s), notified ${notified}`, {
    files: findings.map((f) => f.path),
  });

  return { touched: notified, detail: { findings: findings.length, notified } };
}

export const clobberSentinelJob: MaintenanceJob = {
  name: 'clobber-sentinel',
  host: 'pa',
  everyMs: THIRTY_MINUTES,
  description: 'Detects tracked files reverted to an ancestor of HEAD and alerts per-file.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [], // Never mutates anything

  async run(ctx) {
    return runClobberSentinel();
  },
};

/** Simple 6-char hex ref ID for alert messages. */
function generateRefId(): string {
  return Math.random().toString(16).slice(2, 8);
}
