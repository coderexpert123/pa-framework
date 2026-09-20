/**
 * daily-recon — topic-task handover Wave 2, WP-C (AI-189 unification clause).
 * SPEC §3.3, the WAVE2 spec (2026-09-02).
 *
 * ONE end-of-day reconciliation job per family; future reconciliation phases
 * join HERE as phases, they never spawn sibling jobs (the registry admission
 * rule in docs/maintenance-jobs.md). Phase 1 — the orphan sweep — is the only
 * phase this wave.
 *
 * Phase 1 (~20:45 IST): `git status --porcelain` dirty/untracked paths are
 * attributed — orphan ledger first (~/.pa/orphan-ledger.jsonl, newest record
 * per path wins; a null-owner record is as good as no record), then the
 * topic-ownership registry (~/.pa/topic-ownership-registry.json) for
 * unrecorded paths via its `owned` prefixes — and filed as land-or-discard
 * topic tasks to the owning topic; still-unattributed paths route to the
 * registry catch-all row (`role: "catch-all"`), falling back to
 * `topics.support` when set.
 * Paths under an active reservation are skipped; the whole tick stands down
 * while a git-workflow/@build/catchup lock is held (those holders churn the
 * tree themselves — the clobber-sentinel idiom). NEVER mutates the tree
 * (coordination Rule 9): push readiness is reported by update-brain's
 * per-owner snapshot, never acted on here.
 *
 * Time gates: internally windowed to 20:40-21:10 IST (inclusive bounds; the
 * declared 15-minute cadence merely paces the checks), once per IST day. The
 * once-per-day marker is this job's own ~/.pa/daily-recon.json `ran_at` —
 * the maintenance ledger does NOT persist run detail (MaintenanceJobState
 * has no detail field; runner.ts only logs it), so the SPEC's
 * "ledger detail.lastDate" premise is realized on the file the SPEC has the
 * job write anyway. Field deviation reported 2026-09-02 (WP-C).
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { defaultGitRunner, type GitRunner } from '../../tree-drift.js';
import { parsePorcelainPaths } from '../../git-status.js';
import { pathsOverlap, readActive } from '../../reservations.js';
import { repoRootFromModule } from '../../git-root.js';
import { blackboard } from '../../../blackboard.js';
import { BUILD_LOCK_RESOURCE } from '../../build-lock.js';
import { hasTreeChurnLock } from '../../orphan-watch.js';
import { appendTask } from '../../topic-tasks.js';
import { readOrphanLedger, type OrphanLedgerRecord } from '../../orphan-ledger.js';
import {
  TOPIC_KEY_RE,
  loadTopicOwnershipRegistry,
  resolveCatchAll,
  resolveOwnerForPath,
  resolveRoutingTarget,
  type TopicOwnershipRegistry,
} from '../../topic-ownership.js';
import { toIST } from '../../../ist.js';
import { paHome } from '../../../paths.js';
import { log } from '../../log.js';
import { writeJsonAtomic } from '../../atomic-write.js';
import type { MaintenanceJob, MaintenanceJobResult } from '../types.js';

const WINDOW_START_MIN = 20 * 60 + 40; // 20:40 IST
const WINDOW_END_MIN = 21 * 60 + 10; // 21:10 IST
/** Per-task prompt cap — appendTask's validator rejects longer prompts. */
const MAX_PROMPT_CHARS = 500;
const MAX_PATHS_PER_PROMPT = 6;

export interface DailyReconState {
  ran_at: string;
  groups: Array<{ owner: string; paths_n: number; filed: boolean; source: 'ledger' | 'registry' }>;
  unknown_n: number;
  /** Valid row count of the registry this pass loaded — provenance for the
   *  live verification (the registry-fed loader actually executed). */
  registry_rows: number;
  /** The loaded registry's catch-all key, or null when it has none. */
  catch_all: string | null;
}

export function dailyReconStatePath(): string {
  return join(paHome(), 'daily-recon.json');
}

/** Injectable dependencies for tests (the DI pattern the maintenance jobs
 *  use — ESM module namespaces are read-only, so callers override via deps,
 *  not mocks). */
export interface DailyReconDeps {
  now?: number;
  gitRunner?: GitRunner;
  readActiveFn?: () => Promise<Array<{ paths: string[] }>>;
  getActiveLocksFn?: () => Promise<Array<{ resource: string; pid?: number }>>;
  readLedgerFn?: (limit?: number) => Promise<OrphanLedgerRecord[]>;
  appendTaskFn?: typeof appendTask;
  repoRootFn?: () => Promise<string>;
  loadSupportTopicFn?: () => Promise<string | undefined>;
  loadRegistryFn?: () => Promise<TopicOwnershipRegistry>;
}

function istParts(nowMs: number): { minutes: number; date: string } {
  const ist = toIST(new Date(nowMs));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return {
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
    date: `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`,
  };
}

function istDateOf(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return istParts(t).date;
}

async function readReconState(): Promise<DailyReconState | null> {
  try {
    const raw = await readFile(dailyReconStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DailyReconState>;
    if (parsed && typeof parsed.ran_at === 'string') return parsed as DailyReconState;
    return null;
  } catch {
    return null;
  }
}

/** Registry catch-all first, then config `topics.support` — the single
 *  routing seam the bot's `/debug` and raw-send alert consume via pa dist. */
export async function loadSupportTopic(): Promise<string | undefined> {
  return resolveRoutingTarget();
}

/**
 * The land-or-discard task prompt: up to 6 paths, space-joined, single line.
 * The path list truncates FIRST to satisfy the 500-char cap (SPEC §3.3
 * step 4); a single path so long the line still overflows gets a hard trim
 * by the final guard, because throwing the whole group away would hide it.
 */
export function buildLandOrDiscardPrompt(paths: string[]): string {
  const render = (ps: string[]): string =>
    `Decide whether to commit or discard your pending changes in: ${ps.join(' ')}. ` +
    'Run `git diff -- <path>` to review. Reply with your decision as a task answer.';
  let listed = paths.slice(0, MAX_PATHS_PER_PROMPT);
  while (listed.length > 1 && render(listed).length > MAX_PROMPT_CHARS) {
    listed = listed.slice(0, -1);
  }
  const prompt = render(listed);
  return prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt;
}

export async function runDailyRecon(deps: DailyReconDeps = {}): Promise<MaintenanceJobResult> {
  const now = deps.now ?? Date.now();
  const gitRunnerDep = deps.gitRunner ?? defaultGitRunner;
  const readActiveDep = deps.readActiveFn ?? readActive;
  const getActiveLocksDep = deps.getActiveLocksFn ?? (() => blackboard.getActiveLocks());
  const readLedgerDep = deps.readLedgerFn ?? readOrphanLedger;
  const appendTaskDep = deps.appendTaskFn ?? appendTask;
  const repoRootDep = deps.repoRootFn ?? (() => repoRootFromModule(__filename));
  const loadSupportTopicDep = deps.loadSupportTopicFn ?? loadSupportTopic;
  const loadRegistryDep = deps.loadRegistryFn ?? loadTopicOwnershipRegistry;

  const { minutes, date } = istParts(now);
  if (minutes < WINDOW_START_MIN || minutes > WINDOW_END_MIN) {
    return { touched: 0, detail: { skipped: 'outside-window', istMinute: minutes } };
  }

  const prior = await readReconState();
  if (prior && istDateOf(prior.ran_at) === date) {
    return { touched: 0, detail: { skipped: 'already-ran', lastDate: date } };
  }

  // Stand the whole tick down while a tree-churn holder is live (clobber
  // -sentinel's skip idiom): a git-workflow/public-sync exclusive lock, the
  // @build gate, or any FOREIGN catchup tick. Reservation-covered PATHS are
  // skipped per-path below instead. Shares orphan-watch's hasTreeChurnLock
  // (verbatim in shape, now fixed there) rather than a second inline copy —
  // this job is invoked in-process from `runDueJobs` inside `pa catchup`'s
  // OWN lock region, so an unfixed check here would see that same lock and
  // self-skip every tick forever, exactly as it did for 6 days.
  const active = await readActiveDep();
  const hasGuardLock = await hasTreeChurnLock(getActiveLocksDep);
  const hasBuildReservation = active.some((r) => r.paths.some((p) => p === BUILD_LOCK_RESOURCE));
  if (hasGuardLock || hasBuildReservation) {
    log('info', 'daily-recon', 'skipped: a git-workflow/@build/catchup holder is live');
    return { touched: 0, detail: { skipped: 'lock-held' } };
  }

  // Phase 1 — orphan sweep.
  const repoRoot = await repoRootDep();
  const statusRes = await gitRunnerDep(repoRoot, ['status', '--porcelain']);
  if (statusRes.code !== 0) {
    throw new Error(`git status failed (exit ${statusRes.code}): ${statusRes.stderr.toString('utf8').trim()}`);
  }
  const dirtyPaths = [...new Set(parsePorcelainPaths(statusRes.stdout.toString('utf8')))];

  const survivors = dirtyPaths.filter(
    (p) => !active.some((r) => r.paths.some((rp) => pathsOverlap(p, rp))),
  );

  // Group survivors by owner: the LATEST ledger record naming the path wins
  // (the ledger reads newest-last, so later assignment overwrites). A record
  // with no owner_topic is as good as no record — the topic-ownership
  // registry gets the next look, and only still-unmatched paths reach the
  // unknown lane (adjudication A: ledger = who MADE the change, registry =
  // who OWNS the area).
  const ledger = await readLedgerDep();
  const ownerByPath = new Map<string, string | null>();
  for (const rec of ledger) {
    for (const p of rec.paths) ownerByPath.set(p, rec.owner_topic);
  }
  const registry = await loadRegistryDep();
  const groups = new Map<string, { paths: string[]; source: 'ledger' | 'registry' }>();
  const unknown: string[] = [];
  for (const p of survivors) {
    const owner = ownerByPath.get(p);
    if (owner) {
      const g = groups.get(owner);
      if (g) g.paths.push(p);
      else groups.set(owner, { paths: [p], source: 'ledger' });
    } else {
      const regOwner = resolveOwnerForPath(registry, p);
      if (regOwner) {
        const g = groups.get(regOwner);
        if (g) g.paths.push(p);
        else groups.set(regOwner, { paths: [p], source: 'registry' });
      } else {
        unknown.push(p);
      }
    }
  }

  const filedGroups: Array<{ owner: string; paths_n: number; filed: boolean; source: 'ledger' | 'registry' }> = [];
  for (const [owner, { paths, source }] of groups) {
    const m = TOPIC_KEY_RE.exec(owner);
    if (!m) {
      log('warn', 'daily-recon', 'ledger owner_topic is not a topic key; group skipped', { owner });
      filedGroups.push({ owner, paths_n: paths.length, filed: false, source });
      continue;
    }
    const chatId = Number(m[1]);
    const threadId = Number(m[2]);
    try {
      await appendTaskDep(chatId, threadId, {
        title: `Land or discard: ${paths.length} file(s)`,
        prompt: buildLandOrDiscardPrompt(paths),
        createdBy: 'session:daily-recon',
      });
      filedGroups.push({ owner, paths_n: paths.length, filed: true, source });
    } catch (err) {
      log('warn', 'daily-recon', 'land-or-discard task rejected; group skipped', {
        owner,
        error: String(err),
      });
      filedGroups.push({ owner, paths_n: paths.length, filed: false, source });
    }
  }

  if (unknown.length > 0) {
    const support = await loadSupportTopicDep();
    const m = support ? TOPIC_KEY_RE.exec(support) : null;
    if (support && m) {
      try {
        await appendTaskDep(Number(m[1]), Number(m[2]), {
          title: `Land or discard: ${unknown.length} file(s)`,
          prompt: buildLandOrDiscardPrompt(unknown),
          createdBy: 'session:daily-recon',
        });
      } catch (err) {
        log('warn', 'daily-recon', 'support-topic land-or-discard task rejected', {
          owner: support,
          error: String(err),
        });
      }
    } else {
      // No catch-all registry row and unset or malformed topics.support —
      // skip filing, one WARN, no alert (the deploy sets one of the two;
      // an alert loop here would be noise).
      log('warn', 'daily-recon', 'unknown-owner dirty paths found but no catch-all registry row and topics.support is unset or invalid; not filed', {
        unknown_n: unknown.length,
      });
    }
  }

  const catchAll = resolveCatchAll(registry);
  const state: DailyReconState = {
    ran_at: new Date(now).toISOString(),
    groups: filedGroups,
    unknown_n: unknown.length,
    registry_rows: registry.size,
    catch_all: catchAll ?? null,
  };
  await writeJsonAtomic(dailyReconStatePath(), state).catch((err) => {
    log('warn', 'daily-recon', 'daily-recon.json write failed', { error: String(err) });
  });

  return {
    touched: groups.size,
    detail: {
      lastDate: date,
      groups: filedGroups.length,
      unknown_n: unknown.length,
      registry_rows: registry.size,
      catch_all: catchAll ?? null,
    },
  };
}

export const dailyReconJob: MaintenanceJob = {
  name: 'daily-recon',
  host: 'pa',
  everyMs: 15 * 60 * 1000,
  description:
    'End-of-day reconciliation family host; phase 1 sweeps dirty/untracked paths, attributes them via the orphan ledger first and the topic-ownership registry second, and files land-or-discard tasks to owning topics (still-unattributed paths route to the registry catch-all, then topics.support).',
  destructive: false,
  shedWhenDegraded: true,
  targets: [], // read-only sweep — never mutates the tree (coordination Rule 9)

  async run(ctx) {
    return runDailyRecon({ now: ctx.now });
  },
};
