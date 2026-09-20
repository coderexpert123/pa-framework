/**
 * brain-sweep — the deterministic update-brain pre-update snapshot (AI-214,
 * 2026-09-08; closes AI-189's REMAINDER PENDING clause by moving per-owner
 * grouping from the skill's LLM-executed prose into pa code — the incident
 * proved prose execution unreliable).
 *
 * Managed set: dirty paths equal to `CLAUDE.md` or `BACKLOG.md`, or under
 * `inventory/` or `backlog/open-` (exact + prefix-with-boundary —
 * `backlog/open.md` and `backlog/opener.md` never match;
 * `backlog/programs-*`/`completed-*` stay unmanaged, deliberate scope).
 * BACKLOG.md joined 2026-09-12 as the sole-writer safety net for legacy
 * hand-edits (backlog-fragments drain spec, D5 layer 3); section files
 * joined 2026-09-18 as the sole-writer safety net's new surface (AI-316).
 *
 * Semantics (C3 — the behavior change): attributed managed paths are
 * committed per owner group; UNATTRIBUTED managed paths are DEFERRED and
 * alerted, NEVER committed (the live skill's old commit-the-unattributed
 * prose with `--allow-empty` was exactly the silent-empty-commit path of the
 * incident). Held reasons, in order: an active reservation whose session is
 * not 'update-brain' overlapping the path (`reservation-held:<session>`),
 * then mtime age < RECENT_MS (`recently-edited`), then — only when
 * `--skill-held-lock` was NOT passed (C6/C7) — every still-committable path
 * becomes `lock-held` while any tree-churn holder is live (the update-brain
 * skill's own `pa run` holds the git-workflow lock, so the skill path passes
 * the flag; a standalone invocation without it self-refuses every commit).
 *
 * Git failure ⇒ throw (the CLI exits 1; the skill aborts with its ⚠️
 * message). CommonJS module — __filename, never the ESM meta-url form.
 */
import { createHash, randomBytes } from 'crypto';
import { defaultGitRunner, type GitRunner } from './tree-drift.js';
import { repoRootFromModule } from './git-root.js';
import { pathsOverlap, readActive } from './reservations.js';
import { blackboard } from '../blackboard.js';
import { readOrphanLedger, type OrphanLedgerRecord } from './orphan-ledger.js';
import { loadTopicOwnershipRegistry, resolveOwnerForPath, type TopicOwnershipRegistry } from './topic-ownership.js';
import { toIST } from '../ist.js';
import { log } from './log.js';
import { snapshotTree, type TreeSnapshot } from './worker-edit-audit.js';
import { hasTreeChurnLock, type OrphanNotifyFn } from './orphan-watch.js';
import { notifyUser } from './notify.js';

/** brain-sweep's "recently-edited" window (the AI-214 spec §1.1). */
export const RECENT_MS = 15 * 60 * 1000;

/** A managed path is CLAUDE.md or BACKLOG.md itself, or anything under
 *  inventory/ or matching the backlog/open- prefix — segment boundary rule,
 *  never a bare string prefix (`inventory-x/y`, `docs/BACKLOG.md` and
 *  `backlog/opener.md` never match; `backlog/programs-*`/`completed-*` stay
 *  unmanaged, deliberate scope). */
export function isManagedBrainPath(p: string): boolean {
  return (
    p === 'CLAUDE.md' ||
    p === 'BACKLOG.md' ||
    p.startsWith('inventory/') ||
    p.startsWith('backlog/open-')
  );
}

export interface DeferredPath {
  path: string;
  reason: string; // 'unattributed' | 'reservation-held:<session>' | 'recently-edited' | 'lock-held'
}

export interface CommittedGroup {
  label: string;
  paths: string[];
}

export interface BrainSweepResult {
  committed: CommittedGroup[];
  deferred: DeferredPath[];
  alertSent: boolean;
  refId: string;
}

export interface BrainSweepDeps {
  now?: number;
  gitRunner?: GitRunner;
  readActiveFn?: () => Promise<Array<{ paths: string[]; session: string }>>;
  getActiveLocksFn?: () => Promise<Array<{ resource: string }>>;
  repoRootFn?: () => Promise<string>;
  notifyFn?: OrphanNotifyFn;
  readLedgerFn?: (limit?: number) => Promise<OrphanLedgerRecord[]>;
  loadRegistryFn?: () => Promise<TopicOwnershipRegistry>;
  snapshotFn?: (repoRoot: string, opts?: { gitRunner?: GitRunner }) => Promise<TreeSnapshot>;
  /** C7 — the update-brain skill's own `pa run` holds the git-workflow
   *  exclusive lock; the skill path MUST pass this so the sweep does not
   *  self-refuse. Standalone invocations omit it (C6 applies). */
  skillHeldLock?: boolean;
}

function refId(): string {
  return `s-${randomBytes(6).toString('hex')}`;
}

function istDateOf(nowMs: number): string {
  const ist = toIST(new Date(nowMs));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}

/** `update-brain-deferral:<sha1(sorted "<reason>:<path>" lines).slice(0,12)`
 *  — content-hashed by the deferral set; no PIDs/counts/ids. */
export function brainSweepDeferralDedupKey(deferred: DeferredPath[]): string {
  const lines = deferred.map((d) => `${d.reason}:${d.path}`).sort();
  const hash = createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 12);
  return `update-brain-deferral:${hash}`;
}

export function buildBrainSweepAlertBody(deferred: DeferredPath[], ref: string): string {
  const lines = deferred.map((d) => `${d.path} — ${d.reason}`);
  lines.push(
    '',
    'Unattributed paths are never auto-committed; the nightly orphan-edit watch dispatches a completion agent for paths stable ≥6h.',
    '',
    `_Ref: ${ref}_`,
  );
  return lines.join('\n');
}

/**
 * One sweep pass. Returns the JSON object the skill formats into its Telegram
 * report. Throws on git failure — the caller (skill) aborts.
 */
export async function runBrainSweep(deps: BrainSweepDeps = {}): Promise<BrainSweepResult> {
  const now = deps.now ?? Date.now();
  const gitRunnerDep = deps.gitRunner ?? defaultGitRunner;
  const readActiveDep = deps.readActiveFn ?? readActive;
  const getActiveLocksDep = deps.getActiveLocksFn ?? (() => blackboard.getActiveLocks());
  const repoRootDep = deps.repoRootFn ?? (() => repoRootFromModule(__filename));
  const notifyDep = deps.notifyFn ?? notifyUser;
  const readLedgerDep = deps.readLedgerFn ?? readOrphanLedger;
  const loadRegistryDep = deps.loadRegistryFn ?? loadTopicOwnershipRegistry;
  const snapshotDep = deps.snapshotFn ?? snapshotTree;

  const ref = refId();
  const repoRoot = await repoRootDep();
  const snap = await snapshotDep(repoRoot, { gitRunner: gitRunnerDep });

  const managed = Object.keys(snap.entries).filter(isManagedBrainPath);
  const deferred: DeferredPath[] = [];
  const committed: CommittedGroup[] = [];
  if (managed.length === 0) {
    return { committed, deferred, alertSent: false, refId: ref };
  }

  const active = await readActiveDep();
  const lockGateActive = !deps.skillHeldLock && (await hasTreeChurnLock(getActiveLocksDep));

  const committable: string[] = [];
  for (const p of managed) {
    const covering = active.find((r) => r.paths.some((rp) => pathsOverlap(p, rp)));
    if (covering && covering.session !== 'update-brain') {
      deferred.push({ path: p, reason: `reservation-held:${covering.session}` });
      continue;
    }
    const mtimeMs = snap.entries[p]?.mtimeMs ?? 0;
    if (mtimeMs !== 0 && now - mtimeMs < RECENT_MS) {
      deferred.push({ path: p, reason: 'recently-edited' });
      continue;
    }
    committable.push(p);
  }

  let labelByPath: Map<string, string>;
  if (lockGateActive) {
    // C6/C7: standalone sweep with a tree-churn holder live — every
    // still-committable path defers as lock-held; nothing is committed.
    labelByPath = new Map();
    for (const p of committable) deferred.push({ path: p, reason: 'lock-held' });
  } else {
    // Attribution: orphan ledger first (newest record per path wins — the
    // ledger reads newest-LAST, so later assignment overwrites), a record
    // with neither owner field being as good as no record; then the
    // topic-ownership registry; still-unmatched = unattributed (DEFERRED).
    const ledger = await readLedgerDep();
    const recByPath = new Map<string, OrphanLedgerRecord>();
    for (const rec of ledger) {
      for (const p of rec.paths) recByPath.set(p, rec);
    }
    const registry = await loadRegistryDep();
    labelByPath = new Map();
    for (const p of committable) {
      const rec = recByPath.get(p);
      if (rec && rec.owner_session) {
        labelByPath.set(p, rec.owner_session);
        continue;
      }
      if (rec && rec.owner_topic) {
        labelByPath.set(p, `topic ${rec.owner_topic}`);
        continue;
      }
      const regOwner = resolveOwnerForPath(registry, p);
      if (regOwner) {
        labelByPath.set(p, `topic ${regOwner}`);
        continue;
      }
      deferred.push({ path: p, reason: 'unattributed' });
    }
  }

  // Per-owner groups, sorted by label; paths sorted for a deterministic diff.
  const groups = new Map<string, string[]>();
  for (const [p, label] of labelByPath) {
    const g = groups.get(label);
    if (g) g.push(p);
    else groups.set(label, [p]);
  }
  const sortedLabels = [...groups.keys()].sort((a, b) => (a < b ? -1 : 1));

  for (const label of sortedLabels) {
    const paths = (groups.get(label) ?? []).sort();
    // A group with nothing left to commit is simply not committed (C3 —
    // never --allow-empty).
    const status = await gitRunnerDep(repoRoot, ['status', '--porcelain', '--', ...paths]);
    if (status.code !== 0) {
      throw new Error(`git status failed (exit ${status.code}): ${status.stderr.toString('utf8').trim()}`);
    }
    if (status.stdout.toString('utf8').trim() === '') continue;

    const add = await gitRunnerDep(repoRoot, ['add', '--', ...paths]);
    if (add.code !== 0) {
      throw new Error(`git add failed (exit ${add.code}): ${add.stderr.toString('utf8').trim()}`);
    }
    const message = `update-brain: pre-update snapshot ${istDateOf(now)} — ${label}`;
    const commit = await gitRunnerDep(repoRoot, ['commit', '-m', message, '--', ...paths]);
    if (commit.code !== 0) {
      throw new Error(`git commit failed (exit ${commit.code}): ${commit.stderr.toString('utf8').trim()}`);
    }
    committed.push({ label, paths });
  }

  let alertSent = false;
  if (deferred.length > 0) {
    try {
      await notifyDep(
        `update-brain sweep deferred ${deferred.length} path(s)`,
        buildBrainSweepAlertBody(deferred, ref),
        { dedupKey: brainSweepDeferralDedupKey(deferred), severity: 'warn' },
      );
      alertSent = true;
    } catch (err) {
      // The sweep itself succeeded; a failed alert must not abort the skill.
      log('warn', 'brain-sweep', 'deferral alert failed; sweep result still returned', {
        refId: ref,
        error: String(err),
      });
    }
  }

  return { committed, deferred, alertSent, refId: ref };
}
