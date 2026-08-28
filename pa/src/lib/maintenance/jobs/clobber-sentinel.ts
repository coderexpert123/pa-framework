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
import { readActive } from '../../reservations.js';
import { notifyUser } from '../../notify.js';
import { log } from '../../log.js';
import { repoRootFromModule } from '../../git-root.js';
import { blackboard } from '../../../blackboard.js';
import { exclusiveLockKey } from '../../../commands/run.js';
import { randomBytes } from 'crypto';
import type { MaintenanceJob } from '../types.js';

const THIRTY_MINUTES = 30 * 60 * 1000;

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
  repoRootFn?: () => Promise<string>;
  getActiveLocksFn?: () => Promise<Array<{ resource: string }>>;
}

export async function runClobberSentinel(deps: ClobberSentinelDeps = {}): Promise<{ touched: number; detail: Record<string, unknown> }> {
  const readActiveDep = deps.readActiveFn ?? readActive;
  const detectDriftDep = deps.detectDriftFn ?? detectDrift;
  const notifyDep = deps.notifyFn ?? notifyUser;
  const repoRootDep = deps.repoRootFn ?? (() => repoRootFromModule(__filename));
  const getActiveLocksDep = deps.getActiveLocksFn ?? (() => blackboard.getActiveLocks());

  // Skip while @build or a git-workflow blackboard lock is held — mid-commit reconcile is racy
  const active = await readActiveDep();
  const hasBuildLock = active.some((r) => r.paths.some((p) => p === '@build'));
  const activeLocks = await getActiveLocksDep();
  const heldKeys = new Set(activeLocks.map((l) => l.resource));
  const hasGitLock = heldKeys.has(exclusiveLockKey('git-workflow'))
                  || heldKeys.has(exclusiveLockKey('git-public-workflow'));
  if (hasBuildLock || hasGitLock) {
    log('info', 'maintenance', 'clobber-sentinel skipped: @build reservation or a git-workflow blackboard lock is held');
    return { touched: 0, detail: { skipped: 'lock-held' } };
  }

  const findings: DriftFinding[] = [];
  try {
    const repoRoot = await repoRootDep();
    findings.push(...(await detectDriftDep(repoRoot)));
  } catch (err: any) {
    // A tamper-detection control that reports green while doing nothing is
    // worse than one that pages: clobber-sentinel was silently a no-op from
    // 2026-08-17 (49 "detectDrift failed" warn lines in a single 17 h shard,
    // plans/2026-08-23-alerts-wave-SPEC.md §5.2). Page + rethrow so the
    // runner records `failed` and WP-B's failure-backoff ladder paces retries
    // instead of the job quietly returning a green result every tick.
    log('error', 'maintenance', 'clobber-sentinel detectDrift failed', {
      error: err?.message ?? String(err),
    });
    await notifyDep(
      'clobber-sentinel cannot run',
      `detectDrift threw: ${err?.message ?? String(err)}\n\n` +
      `Tamper detection is DOWN — clobber-sentinel is not checking for reverted files until this is fixed.`,
      { dedupKey: 'clobber-sentinel-detect-failed', severity: 'error' }
    ).catch(() => {});
    throw err;
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

/** 12-char hex ref ID for alert messages — matches the repo-wide `s-XXXXXXXXXXXX` convention. */
function generateRefId(): string {
  return randomBytes(6).toString('hex');
}
