/**
 * Orphaned-edit watch + AUTOMATED DISPOSITION LADDER (AI-214 v2, 2026-09-08).
 * The operator directive removed the human from the resolution loop:
 *
 *   lane 1 — attributed owner ALIVE (transcript mtime within 15 min) or an
 *            active reservation covers the path → defer, no alert, no action.
 *   lane 2 — attributed owner DEAD or unattributed → auto-dispatch a
 *            completion-agent topic task (finish or land verbatim,
 *            pathspec-scoped) AFTER claiming the paths with a TTL so the
 *            agent's own edits never fire AI-175 alerts (C12).
 *   lane 3 — still unresolved ~48 h after firstSeenAt → ONLY THEN the
 *            operator alert with land/keep/diff buttons (last resort).
 *
 * The job itself NEVER commits; the agent and the operator button do. Land
 * re-checks every guard at press time.
 *
 * CommonJS module (pa/ has no "type":"module") — __filename, never the ESM
 * meta-url form (the 2026-08-23 live outage).
 */
import { createHash, randomBytes } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { defaultGitRunner, type GitRunner } from './tree-drift.js';
import { pathsOverlap, readActive, claim as claimReservation, type ClaimOptions, type ClaimResult } from './reservations.js';
import { repoRootFromModule } from './git-root.js';
import { blackboard } from '../blackboard.js';
import { exclusiveLockKey } from '../commands/run.js';
import { BUILD_LOCK_RESOURCE } from './build-lock.js';
import { readOrphanLedger, type OrphanLedgerRecord } from './orphan-ledger.js';
import { loadTopicOwnershipRegistry, resolveOwnerForPath, resolveRoutingTarget, type TopicOwnershipRegistry } from './topic-ownership.js';
import { TOPIC_KEY_RE } from './topic-ownership.js';
import { appendTask, validateTaskPrompt } from './topic-tasks.js';
import { notifyUser } from './notify.js';
import { log } from './log.js';
import { writeJsonAtomic } from './atomic-write.js';
import { paHome } from '../paths.js';
import { snapshotTree, type TreeSnapshot } from './worker-edit-audit.js';
import { OW_RE } from './callback-grammar.js';
import { scanTranscriptsForPaths, attributePath, type ScanTranscriptsResult, type Attribution } from './orphan-attribution.js';
import type { MaintenanceJobResult } from './maintenance/types.js';

// ---- Constants (frozen — the AI-214 v2 spec §1.1; module-level, test-pinned) ----

/** mtime stability gate: a dirty path younger than this is still being worked. */
export const ORPHAN_MIN_AGE_MS = 6 * 60 * 60 * 1000;
/** keep-dirty TTL (lane-3 button). */
export const SNOOZE_MS = 24 * 60 * 60 * 1000;
/** lane 3 fires when now - firstSeenAt reaches this (C14: 2 × DAY). */
export const ALERT_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
/** TTL of the pre-dispatch agent claim (C12). */
export const AGENT_CLAIM_TTL_MS = 4 * 60 * 60 * 1000;
/** Max paths per completion-agent task (C13). */
export const AGENT_PATHS_CAP = 4;
/** Max gids processed per run; the rest are counted + logged, never thrown. */
export const GROUP_CAP = 10;
/** Diff-action truncation cap. */
export const DIFF_MAX_CHARS = 3200;
/** Row prune: snooze expired + this long. */
export const STORE_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

/** Session label of the job's own agent claim (C12). */
export const AGENT_CLAIM_SESSION = 'orphan-edit-watch';

/** Max path lines shown in the alert body before the "and N more" line. */
const MAX_BODY_PATH_LINES = 15;

// ---- Store (~/.pa/orphan-watch.json, version 2) ----

export interface OrphanAgentRecord {
  dispatchedAt: number;
  topicKey: string;
  taskIds: string[];
}

export interface OrphanWatchRow {
  paths: string[];
  firstSeenAt: number;
  lastAlertedAt: number;
  snoozedUntil: number;
  landedAt: number;
  landedSha: string;
  alertRef: string;
  /** Set only after every sub-task append succeeded (C13). */
  agent: OrphanAgentRecord | null;
}

export interface OrphanWatchStore {
  version: 2;
  groups: Record<string, OrphanWatchRow>;
}

export function emptyOrphanStore(): OrphanWatchStore {
  return { version: 2, groups: {} };
}

export function orphanStorePath(): string {
  return join(paHome(), 'orphan-watch.json');
}

/**
 * Fail-to-empty store reader (the orphan-ledger reader pattern): an absent
 * file is the normal first-run case (silent empty), a corrupt/unparseable or
 * wrong-version one degrades to empty with ONE warn-once per process.
 */
let warnedCorruptStore = false;

export async function readOrphanStore(): Promise<OrphanWatchStore> {
  let raw: string;
  try {
    raw = await readFile(orphanStorePath(), 'utf8');
  } catch {
    return emptyOrphanStore(); // absent — the normal first-run case
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OrphanWatchStore>;
    if (parsed && parsed.version === 2 && parsed.groups && typeof parsed.groups === 'object') {
      return parsed as OrphanWatchStore;
    }
    warnedCorruptStoreLog();
    return emptyOrphanStore();
  } catch {
    warnedCorruptStoreLog();
    return emptyOrphanStore();
  }
}

function warnedCorruptStoreLog(): void {
  if (warnedCorruptStore) return;
  warnedCorruptStore = true;
  log('warn', 'orphan-watch', 'orphan-watch store corrupt or not version:2; continuing with an empty store (warn-once per process)', {
    path: orphanStorePath(),
  });
}

/** Atomic store write (writeJsonAtomic). Throws on failure. */
export async function writeOrphanStore(store: OrphanWatchStore): Promise<void> {
  await writeJsonAtomic(orphanStorePath(), store);
}

// ---- gid + keyboard + prompts ----

/** `sha1(sorted normalized paths joined "\n").slice(0,12)` — the same
 *  derivation shape as worker-edit-audit's findingsDedupKey. Stable across
 *  runs, so re-alerts and button presses resolve the same group. */
export function orphanGid(paths: string[]): string {
  const normalized = paths.map((p) => p.replace(/\\/g, '/')).sort();
  return createHash('sha1').update(normalized.join('\n')).digest('hex').slice(0, 12);
}

/**
 * The `ow:` keyboard for a gid (lane-3 buttons). Pure. Returns undefined when
 * the gid does not satisfy the grammar's own regex (the mc: precedent — the
 * emitter must not emit data the parser would refuse).
 */
export function orphanKeyboard(
  gid: string,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined {
  if (!OW_RE.test(`ow:${gid}:l`)) return undefined;
  return {
    inline_keyboard: [
      [
        { text: '📥 Land as-is', callback_data: `ow:${gid}:l` },
        { text: '💤 Keep dirty 24h', callback_data: `ow:${gid}:k` },
      ],
      [{ text: '📄 Show diff', callback_data: `ow:${gid}:d` }],
    ],
  };
}

// ---- Alert body (pure) ----

/** Per-path diff summary. Tracked paths carry added/removed line counts from
 *  `git diff --numstat` (null = binary); untracked paths carry `bytes` from
 *  the snapshot instead. */
export type NumstatByPath = Map<string, { added: number | null; removed: number | null; bytes?: number }>;

/** The inputs buildOrphanBody needs beyond the numstat map. */
export interface OrphanAlertGroup {
  gid: string;
  paths: string[];
  /** The lane-2 dispatch record, when one exists — rendered into the body's
   *  "completion agent was dispatched" line; never dispatched reads
   *  differently (C14's impossible-dispatch case). */
  agent: OrphanAgentRecord | null;
  /** ref-ID for the body's `_Ref:` footer. */
  ref: string;
}

export function buildOrphanBody(group: OrphanAlertGroup, numstatByPath: NumstatByPath): string {
  const lines: string[] = ['**Orphaned working-tree edits need your decision**'];
  if (group.agent) {
    lines.push(
      `A completion agent was dispatched ${new Date(group.agent.dispatchedAt).toISOString()}, topic ${group.agent.topicKey} and the paths are still dirty after 48h — it declined or could not complete them.`,
    );
  } else {
    lines.push('No completion agent could be dispatched (no resolvable topic) and the paths are still dirty after 48h.');
  }
  const shown = group.paths.slice(0, MAX_BODY_PATH_LINES);
  for (const p of shown) {
    const ns = numstatByPath.get(p);
    if (ns && ns.bytes !== undefined) {
      lines.push(`${p}  (new file, ${ns.bytes} bytes)`);
    } else if (ns && (ns.added === null || ns.removed === null)) {
      lines.push(`${p}  (binary)`);
    } else if (ns) {
      lines.push(`${p}  (+${ns.added ?? 0}/-${ns.removed ?? 0})`);
    } else {
      lines.push(`${p}  (new file, size unknown)`);
    }
  }
  if (group.paths.length > shown.length) {
    lines.push(`  …and ${group.paths.length - shown.length} more`);
  }
  lines.push('Stable ≥6h, no active reservation.');
  lines.push('Land as-is commits verbatim. Keep dirty snoozes this family 24h.');
  lines.push('', `_Ref: ${group.ref}_`);
  return lines.join('\n');
}

/** The §1.5 completion-agent prompt for one task's paths, EXACT text, paths
 *  space-joined at both `<paths>` slots. Pure. Throws the validator's error
 *  when even the single-path render overflows (a render overflow is a
 *  build-time test failure for real path shapes, never a runtime surprise —
 *  C13). */
export function buildAgentPrompt(paths: string[]): string {
  const joined = paths.map((p) => p.replace(/\\/g, '/')).join(' ');
  const prompt =
    `Orphan completion agent: decide + finish or land verbatim these dirty edits (no live owner): ${joined}. ` +
    'If a transcript under the Claude projects dir names them, read it for intent. ' +
    `Unambiguous and small: finish. Else: git add ${joined} then git commit -m "chore: land orphaned working-tree edits (completion agent)". ` +
    'Never delete, never touch other paths, never push/stash/reset/clean. Report what you did and why.';
  const check = validateTaskPrompt(prompt);
  if (!check.ok) throw new Error(`completion-agent prompt render rejected: ${check.error}`);
  return prompt;
}

/**
 * Greedy dispatch splitter (C13): longest prefix of the remaining paths with
 * count ≤ AGENT_PATHS_CAP whose FULL RENDER still validates. A path that
 * overflows a 4-path render starts the next chunk — "drops to 3 paths for
 * that task" — and no path is ever stranded. Throws when even one path
 * cannot render.
 */
export function splitForDispatch(paths: string[]): string[][] {
  const chunks: string[][] = [];
  let rest = [...paths];
  while (rest.length > 0) {
    let take = Math.min(rest.length, AGENT_PATHS_CAP);
    while (take > 1) {
      try {
        buildAgentPrompt(rest.slice(0, take));
        break;
      } catch {
        take--;
      }
    }
    buildAgentPrompt(rest.slice(0, take)); // single path must render, or the gid is undispatchable
    chunks.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  return chunks;
}

// ---- Deps (daily-recon's DailyReconDeps DI pattern) ----

/**
 * Deliberately narrower than notify.ts's own (unexported) NotifyOpts —
 * referencing those directly via `typeof notifyUser` in this EXPORTED
 * interface would make tsc's declaration emit fail ("has or is using private
 * name"), since neither type is exported from notify.ts and this module does
 * not own that file. The real `notifyUser` is structurally assignable to this
 * narrower shape (worker-edit-audit's documented workaround).
 */
export interface OrphanNotifyOpts {
  dedupKey?: string;
  dedupWindowMs?: number;
  severity?: 'info' | 'warn' | 'error';
  escalate?: boolean;
  replyMarkup?: Record<string, unknown>;
  breaker?: boolean;
}

export type OrphanNotifyFn = (subject: string, body: string, opts?: OrphanNotifyOpts) => Promise<unknown>;

export interface SnapshotDeps {
  gitRunner?: GitRunner;
  statFn?: (absPath: string) => Promise<{ mtimeMs: number; size: number }>;
}

export interface OrphanWatchDeps {
  now?: number;
  gitRunner?: GitRunner;
  readActiveFn?: () => Promise<Array<{ paths: string[]; session: string }>>;
  getActiveLocksFn?: () => Promise<Array<{ resource: string }>>;
  repoRootFn?: () => Promise<string>;
  notifyFn?: OrphanNotifyFn;
  /** Defaults to worker-edit-audit's snapshotTree. */
  snapshotFn?: (repoRoot: string, opts?: SnapshotDeps) => Promise<TreeSnapshot>;
  readStoreFn?: () => Promise<OrphanWatchStore>;
  writeStoreFn?: (store: OrphanWatchStore) => Promise<void>;
  /** C12 — the pre-dispatch TTL claim. Defaults to reservations.claim. */
  claimFn?: (opts: ClaimOptions) => Promise<ClaimResult>;
  /** C11 — the executor-lane task filing. Defaults to topic-tasks.appendTask. */
  appendTaskFn?: typeof appendTask;
  readLedgerFn?: (limit?: number) => Promise<OrphanLedgerRecord[]>;
  loadRegistryFn?: () => Promise<TopicOwnershipRegistry>;
  /** Catch-all → topics.support (C11 routing's last step). */
  loadSupportTopicFn?: () => Promise<string | undefined>;
  /** Defaults to the real transcript scan (§1.8). */
  scanTranscriptsFn?: (repoRoot: string, paths: string[]) => Promise<ScanTranscriptsResult>;
}

export type OrphanLandDeps = OrphanWatchDeps;

/** True when any tree-churn holder is live: a git-workflow/public-sync
 *  exclusive lock, the @build gate, or any catchup tick HELD BY A FOREIGN
 *  PROCESS. daily-recon's hasGuardLock block, verbatim in shape (the
 *  clobber-sentinel idiom).
 *
 *  A `catchup`/`catchup:*` row whose pid is THIS process is the caller's own
 *  tick lock, not a foreign holder — every pa-host job invoked in-process
 *  from `runDueJobs` inside `pa catchup`'s lock region always saw that same
 *  lock and self-skipped forever (daily-recon's ledger: 6 days, zero real
 *  runs). `selfPid` defaults to `process.pid` and is a parameter so tests
 *  never depend on the real one. git-workflow/git-public-workflow/@build
 *  rows are unaffected — those are always genuinely foreign holders on this
 *  path and must still stand the job down regardless of pid. */
export async function hasTreeChurnLock(
  getActiveLocksFn: () => Promise<Array<{ resource: string; pid?: number }>>,
  selfPid: number = process.pid,
): Promise<boolean> {
  const locks = await getActiveLocksFn();
  const held = new Set(locks.map((l) => l.resource));
  if (
    held.has(exclusiveLockKey('git-workflow')) ||
    held.has(exclusiveLockKey('git-public-workflow')) ||
    held.has(BUILD_LOCK_RESOURCE)
  ) {
    return true;
  }
  return locks.some((l) => (l.resource === 'catchup' || l.resource.startsWith('catchup:')) && l.pid !== selfPid);
}

/** Narrow lock check for the land guard and the lane-2 pre-dispatch guard:
 *  only the git-workflow exclusive lock held by another process blocks. */
async function hasGitWorkflowLock(getActiveLocksFn: () => Promise<Array<{ resource: string }>>): Promise<boolean> {
  const locks = await getActiveLocksFn();
  return locks.some((l) => l.resource === exclusiveLockKey('git-workflow'));
}

// ---- Detection + ladder ----

function refId(): string {
  return `s-${randomBytes(6).toString('hex')}`;
}

/**
 * One disposition pass (§1.9). Flow: lock stand-down → snapshot → age filter
 * (mtimeMs===0 excluded, counted) → reservation paths out (lane 1, silent) →
 * transcript scan + attributePath → group by gid → per gid ≤ GROUP_CAP:
 * alive-owner defer / lane-3 alert at ALERT_AFTER_MS / lane-2 dispatch →
 * prune. Never commits anything on this cadence.
 */
export async function runOrphanEditWatch(deps: OrphanWatchDeps = {}): Promise<MaintenanceJobResult> {
  const now = deps.now ?? Date.now();
  const gitRunnerDep = deps.gitRunner ?? defaultGitRunner;
  const readActiveDep = deps.readActiveFn ?? readActive;
  const getActiveLocksDep = deps.getActiveLocksFn ?? (() => blackboard.getActiveLocks());
  const repoRootDep = deps.repoRootFn ?? (() => repoRootFromModule(__filename));
  const notifyDep = deps.notifyFn ?? notifyUser;
  const snapshotDep = deps.snapshotFn ?? snapshotTree;
  const readStoreDep = deps.readStoreFn ?? readOrphanStore;
  const writeStoreDep = deps.writeStoreFn ?? writeOrphanStore;
  const claimDep = deps.claimFn ?? claimReservation;
  const appendTaskDep = deps.appendTaskFn ?? appendTask;
  const readLedgerDep = deps.readLedgerFn ?? readOrphanLedger;
  const loadRegistryDep = deps.loadRegistryFn ?? loadTopicOwnershipRegistry;
  const loadSupportTopicDep = deps.loadSupportTopicFn ?? resolveRoutingTarget;
  const scanTranscriptsDep = deps.scanTranscriptsFn ?? scanTranscriptsForPaths;

  const skipped = { lockHeld: 0, noTopic: 0, budget: 0 };

  // 1. Lock stand-down (daily-recon's skip idiom): the holders below churn
  // the tree themselves — a pass mid-churn would mislabel their paths.
  if (await hasTreeChurnLock(getActiveLocksDep)) {
    log('info', 'orphan-watch', 'skipped: a git-workflow/@build/catchup holder is live');
    skipped.lockHeld++;
    return { touched: 0, detail: { groups: 0, deferredAlive: 0, dispatched: 0, alerted: 0, skipped, overflow: 0 } };
  }

  // 2. Snapshot + age gate.
  const repoRoot = await repoRootDep();
  const snap = await snapshotDep(repoRoot, { gitRunner: gitRunnerDep });
  let statFailed = 0;
  const aged = Object.keys(snap.entries).filter((p) => {
    const mtimeMs = snap.entries[p]?.mtimeMs ?? 0;
    if (mtimeMs === 0) {
      statFailed++;
      return false;
    }
    return now - mtimeMs >= ORPHAN_MIN_AGE_MS;
  });

  // Reservation-overlapping paths drop silently (lane 1 — a live claim is a
  // live claim; no liveness check needed).
  const active = await readActiveDep();
  const candidates = aged.filter(
    (p) => !active.some((r) => r.paths.some((rp) => pathsOverlap(p, rp))),
  );

  // 3. Transcript scan (only when candidates exist — zero cost on a clean
  // tree) + per-candidate attribution.
  const scan = candidates.length > 0 ? await scanTranscriptsDep(repoRoot, candidates) : null;
  if (scan?.budgetExhausted) skipped.budget++;
  const attrByPath = new Map<string, Attribution>();
  for (const p of candidates) {
    attrByPath.set(
      p,
      attributePath({
        path: p,
        pathMtimeMs: snap.entries[p]?.mtimeMs ?? 0,
        now,
        activeReservations: active,
        transcriptHits: scan?.hitsByPath.get(p) ?? [],
      }),
    );
  }

  // Prune (§1.2) BEFORE grouping/ladder: a row whose snooze expired +7d ago,
  // or whose paths all went clean, is stale bookkeeping. Running the ladder
  // first would dereference rows prune just deleted (the spec's §1.9 places
  // prune last — that order crashes against its own step-3 upsert; reported).
  const store = await readStoreDep();
  const dirtySet = new Set(Object.keys(snap.entries));
  let pruned = 0;
  for (const [gid, row] of Object.entries(store.groups)) {
    const allClean = row.paths.every((p) => !dirtySet.has(p));
    const pruneByAge = row.snoozedUntil > 0 && row.snoozedUntil + STORE_PRUNE_MS < now;
    if (allClean || pruneByAge) {
      delete store.groups[gid];
      pruned++;
    }
  }

  // Group by gid; store upsert keeps the row's firstSeenAt.
  const pathsByGid = new Map<string, string[]>();
  // A path joins the first store row that tracks it; row-less paths batch
  // into ONE new family per run (keeps gids stable for dedup/escalation).
  const claimed = new Set<string>();
  for (const [gid, row] of Object.entries(store.groups)) {
    const members = row.paths.filter((p) => candidates.includes(p) && !claimed.has(p));
    if (members.length === 0) continue;
    for (const p of members) claimed.add(p);
    pathsByGid.set(gid, members);
  }
  const fresh = candidates.filter((p) => !claimed.has(p));
  if (fresh.length > 0) {
    pathsByGid.set(orphanGid(fresh), fresh);
  }
  for (const [gid, paths] of pathsByGid) {
    if (!store.groups[gid]) {
      store.groups[gid] = {
        paths,
        firstSeenAt: now,
        lastAlertedAt: 0,
        snoozedUntil: 0,
        landedAt: 0,
        landedSha: '',
        alertRef: '',
        agent: null,
      };
    }
  }

  // 4. Per gid, ≤ GROUP_CAP.
  let deferredAlive = 0;
  let dispatched = 0;
  let alerted = 0;
  let overflow = 0;

  const ledger = candidates.length > 0 ? await readLedgerDep() : [];
  const registry = candidates.length > 0 ? await loadRegistryDep() : new Map();
  const candidatesList = [...pathsByGid.entries()]
    .map(([gid, paths]) => ({ gid, paths, row: store.groups[gid] }))
    .sort((a, b) => (a.row?.firstSeenAt ?? now) - (b.row?.firstSeenAt ?? now) || (a.gid < b.gid ? -1 : 1));

  for (const cand of candidatesList) {
    if (cand.row.snoozedUntil > now) continue; // snoozed — defer silently
    if (alerted + dispatched >= GROUP_CAP) {
      overflow++;
      continue;
    }

    const attrs = cand.paths.map((p) => attrByPath.get(p)!);
    // Lane 1: every path owned by an ALIVE owner → defer, no alert, no task.
    if (attrs.length > 0 && attrs.every((a) => a.status === 'owned' && a.alive)) {
      deferredAlive++;
      continue;
    }

    if (now - cand.row.firstSeenAt >= ALERT_AFTER_MS) {
      // Lane 3: the operator alert (last resort).
      const numstat = await readNumstat(gitRunnerDep, repoRoot, cand.paths, snap);
      const ref = refId();
      const body = buildOrphanBody({ gid: cand.gid, paths: cand.paths, agent: cand.row.agent, ref }, numstat);
      try {
        await notifyDep(`Orphaned working-tree edits unresolved: ${cand.paths.length} path(s)`, body, {
          dedupKey: `orphan-edit:${cand.gid}`,
          severity: 'warn',
          replyMarkup: orphanKeyboard(cand.gid),
        });
      } catch (err) {
        log('warn', 'orphan-watch', 'lane-3 notify failed; skipping its store update', {
          refId: ref,
          gid: cand.gid,
          error: String(err),
        });
        continue;
      }
      alerted++;
      cand.row.lastAlertedAt = now;
      cand.row.alertRef = ref;
      continue;
    }

    // Lane 2: the completion-agent dispatch (once per gid).
    if (cand.row.agent !== null) continue; // already dispatched — defer
    if (await hasGitWorkflowLock(getActiveLocksDep)) continue; // guard: lock free

    const topicKey = await resolveTopicKey(cand.paths, ledger, registry, loadSupportTopicDep);
    if (!topicKey) {
      skipped.noTopic++;
      continue; // ages to lane 3 (C14 covers the impossible-dispatch case)
    }

    const claimRes = await claimDep({
      paths: cand.paths,
      session: AGENT_CLAIM_SESSION,
      note: 'completion agent dispatched',
      ttlMinutes: AGENT_CLAIM_TTL_MS / 60_000,
      now,
    });
    if (!claimRes.ok) continue; // claimed elsewhere mid-run — next cycle reads lane 1

    let taskIds: string[] = [];
    try {
      const m = TOPIC_KEY_RE.exec(topicKey);
      if (!m) throw new Error(`unparseable topic key ${topicKey}`);
      const chatId = Number(m[1]);
      const threadId = Number(m[2]);
      for (const chunk of splitForDispatch(cand.paths)) {
        const res = await appendTaskDep(chatId, threadId, {
          title: `Complete orphaned edits: ${chunk.length} file(s)`,
          prompt: buildAgentPrompt(chunk),
          createdBy: 'session:orphan-edit-watch',
        });
        taskIds.push(res.id);
      }
    } catch (err) {
      log('warn', 'orphan-watch', 'completion-agent task filing failed; claims expire harmlessly (4h TTL)', {
        gid: cand.gid,
        topicKey,
        error: String(err),
      });
      continue;
    }

    cand.row.agent = { dispatchedAt: now, topicKey, taskIds };
    dispatched++;
  }

  if (alerted > 0 || dispatched > 0 || pruned > 0) {
    await writeStoreDep(store);
  }

  return {
    touched: dispatched + alerted,
    detail: { groups: candidatesList.length, deferredAlive, dispatched, alerted, skipped, overflow, statFailed },
  };
}

/** Newest ledger record naming any of the group's paths with a topic key
 *  wins; then the registry; then catch-all → topics.support. Null = no
 *  resolvable topic (skip dispatch, age to lane 3). */
async function resolveTopicKey(
  paths: string[],
  ledger: OrphanLedgerRecord[],
  registry: TopicOwnershipRegistry,
  loadSupportTopicFn: () => Promise<string | undefined>,
): Promise<string | null> {
  // readOrphanLedger returns its window OLDEST-first (append order preserved
  // by slice(-n)) — a naive first-match `for...of` would silently pick the
  // OLDEST matching record instead of the newest, the opposite of this
  // function's own contract. Track the max-`ts` match instead.
  let newest: OrphanLedgerRecord | null = null;
  for (const rec of ledger) {
    if (!rec.owner_topic || !rec.paths.some((p) => paths.includes(p))) continue;
    if (!newest || Date.parse(rec.ts) > Date.parse(newest.ts)) newest = rec;
  }
  if (newest) return newest.owner_topic;
  for (const p of paths) {
    const owner = resolveOwnerForPath(registry, p);
    if (owner) return owner;
  }
  const support = await loadSupportTopicFn();
  return support ?? null;
}

/** Per-path diff summary for the alert body: `git diff --numstat -- <tracked
 *  paths>` (cosmetic — a failed numstat degrades to absent entries, never a
 *  throw), plus snapshot sizes for untracked paths. */
async function readNumstat(
  gitRunner: GitRunner,
  repoRoot: string,
  paths: string[],
  snap: TreeSnapshot,
): Promise<NumstatByPath> {
  const out: NumstatByPath = new Map();
  for (const p of paths) {
    if (snap.entries[p]?.xy === '??') {
      const size = snap.entries[p]?.size ?? -1;
      out.set(p, { added: null, removed: null, bytes: size >= 0 ? size : undefined });
    }
  }
  const tracked = paths.filter((p) => snap.entries[p]?.xy !== '??');
  if (tracked.length === 0) return out;
  const res = await gitRunner(repoRoot, ['diff', '--numstat', '--', ...tracked]);
  if (res.code !== 0) return out;
  for (const line of res.stdout.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    out.set(m[3], {
      added: m[1] === '-' ? null : Number(m[1]),
      removed: m[2] === '-' ? null : Number(m[2]),
    });
  }
  return out;
}

// ---- Disposition (land / keep / diff) ----

export type OrphanAction = 'land' | 'keep' | 'diff';

/**
 * A refusal is an Error whose message is a stable token the CLI maps to
 * exit 1 + stderr: 'unknown-gid' | 'reserved:<session>' | 'lock-held' | 'clean'.
 */
export async function landOrphanGroup(
  action: OrphanAction,
  gid: string,
  deps: OrphanLandDeps = {},
): Promise<{ ok: true; sha?: string; skipped: string[] }> {
  const now = deps.now ?? Date.now();
  const gitRunnerDep = deps.gitRunner ?? defaultGitRunner;
  const readActiveDep = deps.readActiveFn ?? readActive;
  const getActiveLocksDep = deps.getActiveLocksFn ?? (() => blackboard.getActiveLocks());
  const repoRootDep = deps.repoRootFn ?? (() => repoRootFromModule(__filename));
  const notifyDep = deps.notifyFn ?? notifyUser;
  const snapshotDep = deps.snapshotFn ?? snapshotTree;
  const readStoreDep = deps.readStoreFn ?? readOrphanStore;
  const writeStoreDep = deps.writeStoreFn ?? writeOrphanStore;

  const store = await readStoreDep();
  const row = store.groups[gid];
  if (!row) {
    throw new Error('unknown-gid');
  }

  if (action === 'keep') {
    row.snoozedUntil = now + SNOOZE_MS;
    await writeStoreDep(store);
    log('info', 'orphan-watch', 'orphan group snoozed 24h (operator keep-dirty)', { gid });
    return { ok: true, skipped: [] };
  }

  if (action === 'diff') {
    const repoRoot = await repoRootDep();
    const diffRes = await gitRunnerDep(repoRoot, ['diff', 'HEAD', '--', ...row.paths]);
    if (diffRes.code !== 0) {
      throw new Error(`git diff failed (exit ${diffRes.code}): ${diffRes.stderr.toString('utf8').trim()}`);
    }
    let body = diffRes.stdout.toString('utf8');
    // Untracked paths never appear in `git diff HEAD` — note them explicitly.
    const snap = await snapshotDep(repoRoot, { gitRunner: gitRunnerDep });
    for (const p of row.paths) {
      if (snap.entries[p]?.xy === '??') {
        const size = snap.entries[p]?.size ?? -1;
        body += `\n${p} — new file, ${size >= 0 ? `${size} bytes` : 'size unknown'}\n`;
      }
    }
    if (body.length > DIFF_MAX_CHARS) {
      body =
        body.slice(0, DIFF_MAX_CHARS) +
        `\n…truncated at ${DIFF_MAX_CHARS} chars — run \`git diff HEAD -- ${row.paths.join(' ')}\` for the full patch`;
    }
    const ref = refId();
    await notifyDep(`Orphaned edits diff: ${gid}`, body.length > 0 ? body : '(no diff)', {
      dedupKey: `orphan-edit-diff:${gid}`,
      severity: 'info',
      escalate: false,
    });
    return { ok: true, skipped: [] };
  }

  // action === 'land' — the only tree-mutating path. Every guard re-runs at
  // press time (the job's OWN agent claim refuses an early land press,
  // correctly — a live claim is a live claim).
  const active = await readActiveDep();
  const covering = active.find((r) => r.paths.some((rp) => row.paths.some((p) => pathsOverlap(p, rp))));
  if (covering) {
    throw new Error(`reserved:${covering.session}`);
  }
  if (await hasGitWorkflowLock(getActiveLocksDep)) {
    throw new Error('lock-held');
  }

  const repoRoot = await repoRootDep();
  const snap = await snapshotDep(repoRoot, { gitRunner: gitRunnerDep });
  const stillDirty = row.paths.filter((p) => snap.entries[p] !== undefined);
  const skipped = row.paths.filter((p) => snap.entries[p] === undefined);
  if (stillDirty.length === 0) {
    throw new Error('clean');
  }

  const untracked = stillDirty.filter((p) => snap.entries[p]?.xy === '??');
  if (untracked.length > 0) {
    // Pathspec commit does not auto-stage untracked paths — add them first.
    const addRes = await gitRunnerDep(repoRoot, ['add', '--', ...untracked]);
    if (addRes.code !== 0) {
      throw new Error(`git add failed (exit ${addRes.code}): ${addRes.stderr.toString('utf8').trim()}`);
    }
  }

  const message =
    `chore: land orphaned working-tree edits (${gid})\n\n` +
    stillDirty.join('\n') +
    `\n\nThese edits sat uncommitted with no active reservation and no live owner\n` +
    `(stable >=6h); landed verbatim from the orphan-edit alert for preservation.\n\n` +
    `Co-Authored-By: Claude Code <noreply@anthropic.com>\n`;
  const commitRes = await gitRunnerDep(repoRoot, ['commit', '-m', message, '--', ...row.paths]);
  if (commitRes.code !== 0) {
    throw new Error(`git commit failed (exit ${commitRes.code}): ${commitRes.stderr.toString('utf8').trim()}`);
  }

  const verify = await gitRunnerDep(repoRoot, ['status', '--porcelain', '--', ...row.paths]);
  if (verify.code !== 0 || verify.stdout.toString('utf8').trim() !== '') {
    throw new Error(
      `post-commit verify failed: paths still dirty after land: ${verify.stdout.toString('utf8').trim()}`,
    );
  }
  const shaRes = await gitRunnerDep(repoRoot, ['rev-parse', '--short', 'HEAD']);
  const sha = shaRes.code === 0 ? shaRes.stdout.toString('utf8').trim() : '';

  row.landedAt = now;
  row.landedSha = sha;
  await writeStoreDep(store);

  const ref = refId();
  const skippedLine = skipped.length > 0 ? `\nSkipped (already clean): ${skipped.join(', ')}` : '';
  try {
    await notifyDep(`Orphaned edits landed: ${gid}`, `Landed at \`${sha}\`.${skippedLine}\n\n_Ref: ${ref}_`, {
      dedupKey: `orphan-edit-outcome:${gid}`,
      severity: 'info',
      escalate: false,
    });
  } catch (err) {
    log('warn', 'orphan-watch', 'land outcome notify failed (the land itself succeeded)', {
      refId: ref,
      gid,
      error: String(err),
    });
  }

  return { ok: true, sha, skipped };
}
