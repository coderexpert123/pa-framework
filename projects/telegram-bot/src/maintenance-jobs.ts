/**
 * The bot's declared maintenance jobs (AI-100 Wave 2 / AI-108 static registry integration).
 * See pa/src/lib/maintenance/types.ts for the MaintenanceJob contract this satisfies.
 */
import { statSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { MaintenanceJob } from '../../../pa/dist/src/lib/maintenance/types.js';
import { notifyUser, collectUnflushedDigests, formatDigestMessage, markDigestFlushed } from '../../../pa/dist/src/lib/notify.js';
import { flushDlq } from './dlq.js';
import { compactDelivered } from './delivered-store.js';
import { paHome } from '../../../pa/dist/src/paths.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { RUNTIME_ARCHIVE_MAX_BYTES } from '../../../pa/dist/src/lib/archive-files.js';
import {
  runScheduledPoolRefresh,
} from '../../../pa/dist/src/lib/telegram-proxy.js';
import { repoRootFromModule } from '../../../pa/dist/src/lib/git-root.js';
import { readActive } from '../../../pa/dist/src/lib/reservations.js';
import { blackboard } from '../../../pa/dist/src/blackboard.js';
import { warnOnce } from './lib/warn-once.js';
import { loadRegistryContentRules, type RegistryContentRule } from './registry-content-rules.js';
import type { TopicNameMap } from './topic-names.js';
import { isSuspiciousDescription } from './grounding-check.js';
import { listPendingDispatches } from './pending-dispatches.js';
import { listTopicStateRefs } from './conversation.js';
import { shouldSelfRestart, shouldWarnStaleCode, formatRestartBlockers, formatDurationCompact } from './self-restart.js';
import { refreshDashboardIfBootstrapped } from './dashboard.js';
import { writeFileAtomic } from '../../../pa/dist/src/lib/atomic-write.js';
import { PENDING_ACTION_TTL_MS } from './logic.js';
import {
  botLogRotationCheckJob,
  modelOverrideSweepJob,
  deliveredStoreCompactJob,
  proxyPoolRefreshJob,
  groundingCheckJob,
} from '../../../pa/dist/src/lib/maintenance/jobs/index.js';
import { botSelfRestartJob } from '../../../pa/dist/src/lib/maintenance/jobs/bot-self-restart.js';
import { alertDigestJob } from '../../../pa/dist/src/lib/maintenance/jobs/alert-digest.js';
import { loadJobState, updateJobState } from '../../../pa/dist/src/lib/maintenance/state.js';

// Module-level (not durable): the first pass where the dist stamp is newer
// than this process but the bot has never gone idle long enough to restart.
// A bot restart clears it implicitly (fresh process, fresh module state) —
// that is the correct semantics, and it adds no timer (C13).
let firstSeenNewerStampMs: number | null = null;

// ─── Registry Content Watch Invariants ─────────────────────────────────────────────

/**
 * Content invariants for topic-name descriptions.
 * Each invariant asserts a required condition for a specific topic's description.
 * Future migrations add lines in one place (this array) — extensible.
 */
export interface RegistryContentViolation {
  topicKey: string;
  threadId: number;
  invariantLabel: string;
  description: string | undefined;
}

/**
 * Pure check function for registry content invariants.
 * Returns a list of violations (empty if all pass). Exported for tests.
 *
 * @param rules - Declarative rules loaded from registry-content-rules.json
 * @param topicNames - Current topic registry
 */
export function checkRegistryContentInvariants(
  rules: RegistryContentRule[],
  topicNames: TopicNameMap
): RegistryContentViolation[] {
  const violations: RegistryContentViolation[] = [];
  for (const rule of rules) {
    let found = false;
    for (const [chatId, threads] of topicNames.entries()) {
      const entry = threads.get(rule.thread_id);
      if (entry && entry.name === rule.topic_key) {
        found = true;
        const desc = entry.description || '';

        // Evaluate declarative predicates
        let passes = true;
        if (rule.require_contains && !desc.includes(rule.require_contains)) {
          passes = false;
        }
        if (rule.forbid_contains && desc.includes(rule.forbid_contains)) {
          passes = false;
        }

        if (!passes) {
          violations.push({
            topicKey: rule.topic_key,
            threadId: rule.thread_id,
            invariantLabel: rule.label,
            description: entry.description,
          });
        }
        break;
      }
    }
    // If topic not found, we can't test it — skip (don't alert on missing topics,
    // only on present-but-violating ones)
  }
  return violations;
}

export interface BotMaintenanceDeps {
  /** Telegram bot token — needed by the queue-drain dlq source and proxy-pool-refresh. */
  token: string;
  /** Allowed chat ids — needed by model-override-sweep. */
  chatIds: number[];
  /** Stop-sentinel path. When undefined, bot-log-rotation-check is a no-op
   *  (runPollLoop is called without one in many tests). */
  sentinelPath?: string;
  /**
   * Injected, NOT imported: runExpiredModelOverrideSweep lives in main.ts and
   * depends on main.ts-local helpers, so importing it here would create an
   * import cycle. Returns the number of topic-state files rewritten.
   */
  runModelSweep: (token: string, chatIds: number[]) => Promise<number>;
  /** Live topic registry — same Map instance runPollLoop uses, so the job
   *  always sees current state with no extra load of its own (AI-101). */
  topicNames: TopicNameMap;
  /** Injected (runModelSweep precedent — avoids a main.ts import cycle):
   *  drain due parked requeues; returns the number re-injected. */
  requeueDrain: () => Promise<number>;
  /** Injected (requeueDrain precedent): drain queued executable reminder
   *  payloads (AI-185) into the dispatch pipeline; returns the number
   *  injected. Lives in main.ts — it needs runPollLoop's allowedChatIds and
   *  the synthetic-update injector. */
  reminderResumeDrain: () => Promise<number>;
  /** Injected (reminderResumeDrain precedent): drain queued topic tasks
   *  (topic-task handover Wave 1, SPEC §3.6) into the dispatch pipeline; one
   *  task per topic per tick; returns the number injected. Lives in main.ts —
   *  it needs runPollLoop's allowedChatIds and the synthetic-update injector. */
  topicTaskDrain: () => Promise<number>;
  /**
   * Registry content rules loaded from ~/.pa/registry-content-rules.json.
   * Injected for testability (default: loadRegistryContentRules()).
   */
  rules?: RegistryContentRule[];
}

/**
 * Binds runtime execution closures (token, chatIds, sentinelPath) to the statically
 * declared bot-host jobs in the pa maintenance registry (AI-108).
 *
 * ORDER IS LOAD-BEARING: runDueJobs runs jobs sequentially. The dlq queue can
 * block for minutes during a Telegram outage (N queued replies x 30s send
 * timeout) — it is the LAST SOURCE inside queue-drain's pass so a stalled
 * flush never delays the cheap injectors sharing the job (the pre-consolidation
 * job-array constraint, now per-source).
 */

// ─── Queue-drain family (AI-189 unification, Wave-2 SPEC §3.2) ─────────────

/**
 * The whole queue-drain family is ONE job with registered SOURCES (spec §3.2).
 * A new queue-shaped drain joins HERE as a source — the registry admission
 * rule (docs/maintenance-jobs.md) forbids a sibling job without first proving
 * this shape doesn't cover it. Each source keeps its own cadence, cold-start
 * policy and documented semantics.
 */
export type DrainSourceName = 'requeue' | 'reminder-resume' | 'topic-task' | 'dlq';

export interface DrainSourceSpec {
  name: DrainSourceName;
  /** Per-source cadence inside the job's 60s pass (the family minimum). */
  everyMs: number;
  /** Cold-start seeding: the source reads as "just ran" at job creation, so it
   *  waits one full interval after a bot restart instead of firing on the
   *  first tick (the per-source successor of the pre-consolidation job-level
   *  cold-start list). The three non-drain seeded jobs (delivered-store-compact,
   *  proxy-pool-refresh, dashboard-refresh) stay in main.ts's job-level list. */
  coldStartSeed: boolean;
  /** Documented attributes, asserted by maintenance-jobs.test.ts and rendered
   *  in docs/maintenance-jobs.md's source table:
   *  ['pop-first','persist-before-inject','no-age-drop'] for the three
   *  injectors; ['entry-idempotent','send-before-mark'] for dlq. */
  semantics: readonly string[];
}

/** Frozen per-source attributes (spec §3.2). The run fns are bound per-deps in
 *  createBotMaintenanceJobs; dlq is LAST — see the order comment above. */
export const DRAIN_SOURCE_SPECS: readonly DrainSourceSpec[] = [
  { name: 'requeue', everyMs: 300_000, coldStartSeed: true, semantics: ['pop-first', 'persist-before-inject', 'no-age-drop'] },
  { name: 'reminder-resume', everyMs: 60_000, coldStartSeed: false, semantics: ['pop-first', 'persist-before-inject', 'no-age-drop'] },
  { name: 'topic-task', everyMs: 60_000, coldStartSeed: false, semantics: ['pop-first', 'persist-before-inject', 'no-age-drop'] },
  { name: 'dlq', everyMs: 300_000, coldStartSeed: true, semantics: ['entry-idempotent', 'send-before-mark'] },
];

/**
 * Watchdog for stuck maintenance jobs (P2-3 fix). Detects and clears in-flight markers
 * that are older than 10x the job's everyMs interval, which indicates the job's
 * runner process died or the promise never settled.
 */
export async function watchdogStaleJobs(jobs: MaintenanceJob[]): Promise<void> {
  const MINUTES = 60 * 1000;
  for (const job of jobs) {
    try {
      // Resolve everyMs (can be number or function)
      const resolvedEveryMs = typeof job.everyMs === 'function' ? job.everyMs() : job.everyMs;
      // Skip jobs without a defined cadence or those not eligible for watchdog
      if (!resolvedEveryMs || resolvedEveryMs <= 0) continue;

      const state = await loadJobState(job.name);
      if (!state.inFlight) continue;

      const elapsed = Date.now() - new Date(state.inFlightSince || '').getTime();
      const maxAge = 10 * resolvedEveryMs;

      if (elapsed > maxAge) {
        logger.warn('maintenance-watchdog', `clearing stale in-flight marker for job ${job.name}`, {
          jobName: job.name,
          inFlightSince: state.inFlightSince,
          elapsed,
          maxAge,
        });
        await updateJobState(job.name, (prev) => ({ ...prev, inFlight: false, inFlightSince: null }));
      }
    } catch (err) {
      // Watchdog failures must not crash the bot; log and continue
      logger.warn('maintenance-watchdog', `watchdog check failed for job ${job.name}`, { error: String(err) });
    }
  }
}

/**
 * Zombie-confirmations fix (2026-08-30 SPEC): sweep expired pending_action
 * records from topic-state files, then return how many FRESH ones remain.
 * One pass per file: read, sweep if expired, count if fresh — so the caller's
 * count always sees post-sweep state. Malformed/missing proposed_at counts as
 * expired (conservative toward restarting — deliberate divergence from
 * expirePendingAction's NaN-keeps behavior, SPEC §1.6). Parse/read failures
 * keep the job's existing counts-as-0 behavior and never write. The mtime
 * guard (SPEC §1.5) prevents reverting a concurrent saveTopicState (which
 * writes new turns too) that lands between our read and write.
 */
export interface PendingActionSweepResult {
  /** Fresh (within-TTL) pending_action records remaining after the sweep. */
  fresh: number;
  /** Age of the OLDEST fresh record in ms; null when fresh === 0. Feeds the
   *  stale-code watchdog's blocker text (2026-08-30 SPEC). */
  oldestFreshAgeMs: number | null;
}

export async function sweepExpiredPendingActions(nowMs: number): Promise<PendingActionSweepResult> {
  let fresh = 0;
  let oldestFreshAgeMs: number | null = null;
  for (const ref of await listTopicStateRefs()) {
    try {
      const mtimeBeforeMs = statSync(ref.path).mtimeMs;
      const parsed = JSON.parse(await readFile(ref.path, 'utf8')) as {
        pending_action?: { proposed_at?: unknown };
      };
      const pa = parsed.pending_action;
      if (!pa) continue;
      const t = typeof pa.proposed_at === 'string' ? new Date(pa.proposed_at).getTime() : NaN;
      if (Number.isFinite(t) && nowMs - t < PENDING_ACTION_TTL_MS) {
        fresh++;
        const ageMs = nowMs - t;
        if (oldestFreshAgeMs === null || ageMs > oldestFreshAgeMs) oldestFreshAgeMs = ageMs;
        continue; // fresh — NEVER touch
      }
      if (statSync(ref.path).mtimeMs !== mtimeBeforeMs) {
        // Concurrent writer landed mid-sweep; leave it for the next tick.
        logger.info('bot', 'self-restart sweep: skipped, file changed mid-sweep', { path: ref.path });
        continue;
      }
      delete parsed.pending_action;
      await writeFileAtomic(ref.path, JSON.stringify(parsed, null, 2));
      logger.info('bot', 'self-restart sweep: cleared expired pending_action', {
        path: ref.path,
        proposed_at: typeof pa.proposed_at === 'string' ? pa.proposed_at : null,
      });
    } catch {
      // unreadable/unparseable file: counts as 0, never written (existing gather behavior).
    }
  }
  return { fresh, oldestFreshAgeMs };
}

export function createBotMaintenanceJobs(deps: BotMaintenanceDeps): MaintenanceJob[] {
  const boundBotLogRotationCheck: MaintenanceJob = {
    ...botLogRotationCheckJob,
    async run(ctx) {
      const logPath = join(paHome(), 'logs', 'telegram-bot.log');
      let oversized = false;
      let sizeBytes = 0;
      try {
        const s = statSync(logPath);
        sizeBytes = s.size;
        if (s.size > RUNTIME_ARCHIVE_MAX_BYTES) {
          logger.info('bot', `log file exceeded limit (${(s.size / 1024 / 1024).toFixed(1)}MB) — triggering self-restart for rotation`);
          oversized = true;
        }
      } catch {
        // No log file yet — nothing to rotate.
      }
      if (!oversized || deps.sentinelPath === undefined) return { touched: 0 };
      writeFileSync(deps.sentinelPath, String(ctx.now));
      return { touched: 1, detail: { sizeBytes } };
    },
  };

  const boundModelOverrideSweep: MaintenanceJob = {
    ...modelOverrideSweepJob,
    async run() {
      return { touched: await deps.runModelSweep(deps.token, deps.chatIds) };
    },
  };

  const boundDeliveredStoreCompact: MaintenanceJob = {
    ...deliveredStoreCompactJob,
    async run() {
      return { touched: await compactDelivered() };
    },
  };

  const boundProxyPoolRefresh: MaintenanceJob = {
    ...proxyPoolRefreshJob,
    async run() {
      return { touched: await runScheduledPoolRefresh(deps.token) };
    },
  };

  const boundGroundingCheck: MaintenanceJob = {
    ...groundingCheckJob,
    async run() {
      const suspicious: Array<{ chatId: string; threadId: number; name: string; description: string }> = [];
      for (const [chatId, threads] of deps.topicNames.entries()) {
        for (const [threadId, entry] of threads.entries()) {
          if (isSuspiciousDescription(entry.description)) {
            suspicious.push({ chatId, threadId, name: entry.name, description: entry.description! });
          }
        }
      }
      if (suspicious.length > 0) {
        const body = suspicious
          .map((s) => `${s.name} (${s.chatId}/${s.threadId}): "${s.description.slice(0, 120)}"`)
          .join('\n');
        logger.warn('maintenance', `${suspicious.length} topic(s) with a suspicious description`, { suspicious });
        await notifyUser('Suspicious Topic Description(s)', body, {
          dedupKey: 'grounding-check',
          severity: 'warn',
        }).catch(() => {});
      }
      return { touched: suspicious.length, detail: { suspicious } };
    },
  };

  // A static stub now exists in pa/src/lib/maintenance/jobs/registry-content-watch.ts
  // (for `pa maintenance list`, which cannot run the bot's bound closure). The two must
  // keep the same `name`, `everyMs`, `host`, `destructive` and `shedWhenDegraded` — asserted
  // by pa/tests/maintenance-registry.test.ts and this file's own maintenance-jobs.test.ts.
  const boundRegistryContentWatch: MaintenanceJob = {
    name: 'registry-content-watch',
    description: 'Daily content invariants for topic descriptions, per rules in ~/.pa/registry-content-rules.json (default: none). Non-destructive — reads and alerts only.',
    host: 'bot',
    everyMs: 86_400_000, // daily
    shedWhenDegraded: true,
    destructive: false,
    targets: [], // non-destructive — reads and alerts only
    async run() {
      const rules = deps.rules || loadRegistryContentRules();
      const violations = checkRegistryContentInvariants(rules, deps.topicNames);
      if (violations.length > 0) {
        const body = violations
          .map((v) => `${v.topicKey} (${v.threadId}): failed invariant "${v.invariantLabel}" — description: "${v.description?.slice(0, 120) ?? '(empty)'}"`)
          .join('\n');
        logger.warn('maintenance', `${violations.length} registry content invariant violation(s)`, { violations });
        await notifyUser('Registry Content Invariant Violation(s)', `${body}\n\nRestore source: §C1 table in plans/2026-08-21-brain-migration-SPEC.md`, {
          dedupKey: 'registry-content-watch',
          severity: 'warn',
        }).catch(() => {});
      }
      return { touched: violations.length, detail: { violations } };
    },
  };

  const boundBotSelfRestart: MaintenanceJob = {
    ...botSelfRestartJob,
    async run(ctx) {
      if (deps.sentinelPath === undefined) {
        return { touched: 0, detail: { reason: 'no-sentinel' } };
      }

      const repoRoot = await repoRootFromModule(import.meta.url);
      const stampPaths = [
        join(repoRoot, 'pa', 'dist', '.build-stamp'),
        join(repoRoot, 'projects', 'telegram-bot', 'dist', '.build-stamp'),
      ];
      let stampMtimeMs: number | null = null;
      for (const p of stampPaths) {
        try {
          const m = statSync(p).mtimeMs;
          if (stampMtimeMs === null || m > stampMtimeMs) stampMtimeMs = m;
        } catch {
          // stamp not present at this path — contributes nothing.
        }
      }

      const procStartMs = Date.now() - Math.round(process.uptime() * 1000);
      const buildLockHeld = (await readActive()).some((r) => r.paths.includes('@build'));
      const inFlightWorkers = (await listPendingDispatches()).length;
      const topicLocksHeld = (await blackboard.getActiveLocks()).filter(
        (l) => l.pid === process.pid && l.resource.startsWith('topic-'),
      ).length;

      // TTL-aware (2026-08-30 SPEC): sweep expired pending_action records first,
      // then count what is fresh — a zombie can no longer pin the restart gate
      // at 'busy' forever.
      const { fresh: pendingActions, oldestFreshAgeMs: oldestPendingActionAgeMs } =
        await sweepExpiredPendingActions(ctx.now);

      const disabled = process.env.PA_BOT_SELF_RESTART === '0';

      const d = shouldSelfRestart({
        procStartMs,
        stampMtimeMs,
        nowMs: ctx.now,
        buildLockHeld,
        inFlightWorkers,
        pendingActions,
        topicLocksHeld,
        disabled,
      });

      if (d.stampIsNewer && !d.restart) {
        if (firstSeenNewerStampMs === null) firstSeenNewerStampMs = ctx.now;
      } else {
        firstSeenNewerStampMs = null;
      }

      if (d.restart) {
        logger.info('bot', 'self-restart: dist stamp is newer than this process and the bot is idle — writing stop sentinel', { stampMtimeMs, procStartMs });
        await notifyUser(
          'Bot self-restart',
          `dist stamp (${stampMtimeMs !== null ? new Date(stampMtimeMs).toISOString() : 'unknown'}) is newer than this process's start (${new Date(procStartMs).toISOString()}) and the bot is idle. Writing the stop sentinel — Task Scheduler will relaunch it on the newer build.`,
          { dedupKey: 'bot-self-restart', severity: 'info', escalate: false },
        ).catch(() => {});
        writeFileSync(deps.sentinelPath, String(ctx.now));
        return { touched: 1, detail: { reason: d.reason, stampMtimeMs } };
      }

      if (shouldWarnStaleCode({ firstSeenNewerStampMs, nowMs: ctx.now })) {
        const staleMs = firstSeenNewerStampMs !== null ? ctx.now - firstSeenNewerStampMs : 0;
        const blockers = formatRestartBlockers({
          procStartMs,
          stampMtimeMs,
          nowMs: ctx.now,
          buildLockHeld,
          inFlightWorkers,
          pendingActions,
          topicLocksHeld,
          oldestPendingActionAgeMs,
        });
        logger.warn('bot', 'self-restart: dist stamp has been newer than this process for 30+ minutes but the bot has never gone idle long enough to self-restart', { stampMtimeMs, procStartMs, firstSeenNewerStampMs, staleMs, blockers });
        await notifyUser(
          'Bot running stale code',
          `dist stamp has been newer than this running process for ${formatDurationCompact(staleMs)}, but the bot has never gone idle long enough to self-restart. Still blocked by: ${blockers || 'nothing observable'}. (last reason: ${d.reason}). stampMtimeMs=${stampMtimeMs}, procStartMs=${procStartMs}.`,
          { dedupKey: 'bot-stale-code', severity: 'warn' },
        ).catch(() => {});
        return { touched: 0, detail: { reason: d.reason, stale: true, blockers } };
      }

      return { touched: 0, detail: { reason: d.reason } };
    },
  };

  // Parity with the pa-side stub (pa/src/lib/maintenance/jobs/alert-digest.ts)
  // is asserted by maintenance-jobs.test.ts. alert-digest is LAST in the array
  // (queue-drain's spec) — the pre-consolidation "cheap before dlq" rationale
  // now lives per-source inside queue-drain.
  const boundAlertDigest: MaintenanceJob = {
    ...alertDigestJob,
    async run(ctx) {
      const files = await collectUnflushedDigests(ctx.now);
      if (files.length === 0) return { touched: 0 };
      const dates = files.map((f) => f.date).join(',');
      const { subject, body } = formatDigestMessage(files);
      const r = await notifyUser(subject, body, {
        dedupKey: `alert-digest-${dates}`,
        severity: 'info',
        breaker: false,
      }).catch(() => ({ sent: false, suppressed: false }));
      // Mark flushed ONLY on sent || suppressed (SPEC §1.14): suppressed
      // proves an earlier attempt with the same per-date key delivered;
      // anything else (disabled/token/chat/send-failed/timeout) retries on
      // the next daily run instead of silently losing the digest.
      if (r.sent || r.suppressed) {
        for (const f of files) {
          await markDigestFlushed(f, ctx.now).catch(() => {});
        }
      }
      return { touched: r.sent ? files.length : 0, detail: { dates: files.map((f) => f.date), sent: r.sent } };
    },
  };

  // ─── queue-drain: the consolidated drain family (AI-189, SPEC §3.2) ──────
  //
  // ONE job for requeue + reminder-resume + topic-task + dlq. Per-source
  // lastRunAtMs lives in a closure Map seeded per coldStartSeed at creation:
  // MaintenanceJobState has no detail field and the runner never persists
  // run() detail (SPEC §3.2's ledger anchor is impossible — the same defect
  // WP-C hit for daily-recon's once-per-day stamp), and the spec explicitly
  // blesses stamp loss as harmless ("dlq idempotency makes one extra flush
  // harmless"). A bot restart therefore re-seeds from this registry — exactly
  // the pre-consolidation cold-start behavior.
  const drainSourceLastRunMs = new Map<DrainSourceName, number>();
  const drainCreatedMs = Date.now();
  for (const spec of DRAIN_SOURCE_SPECS) {
    if (spec.coldStartSeed) drainSourceLastRunMs.set(spec.name, drainCreatedMs);
  }

  // The per-source run fns — "the existing injected dep fn, unchanged" for the
  // three injectors; dlq keeps its flushDlq body (its remaining/deduped detail
  // rides the log line: the DrainSource shape carries a count only).
  const drainSourceRunners: Record<DrainSourceName, () => Promise<number>> = {
    requeue: () => deps.requeueDrain(),
    'reminder-resume': () => deps.reminderResumeDrain(),
    'topic-task': () => deps.topicTaskDrain(),
    dlq: async () => {
      const r = await flushDlq(deps.token);
      if (r.delivered > 0 || r.remaining > 0) {
        logger.info('maintenance', `queue-drain/dlq: delivered ${r.delivered}, remaining ${r.remaining}, deduped ${r.deduped}`);
      }
      return r.delivered;
    },
  };

  const boundQueueDrain: MaintenanceJob = {
    name: 'queue-drain',
    description: 'Consolidated queue-drain family (AI-189): registered sources requeue (5m, cold-start-seeded), reminder-resume (60s), topic-task (60s) and dlq (5m, cold-start-seeded) run on their own cadences inside one pass — pop-first, persist-before-inject, no age drop (dlq: entry-idempotent, send-before-mark). Request recovery, not housekeeping — never shed under DEGRADED.',
    host: 'bot',
    everyMs: 60_000, // the family minimum
    shedWhenDegraded: false,
    destructive: false,
    targets: [],
    async run(ctx) {
      let touched = 0;
      const sources: Partial<Record<DrainSourceName, number>> = {};
      for (const spec of DRAIN_SOURCE_SPECS) {
        const last = drainSourceLastRunMs.get(spec.name);
        if (last !== undefined && ctx.now - last < spec.everyMs) continue;
        // Stamp BEFORE the run: a source that throws waits out its own cadence
        // before retrying instead of re-failing every 60s tick (per-source
        // failures are invisible to the runner's job-level backoff ladder).
        drainSourceLastRunMs.set(spec.name, ctx.now);
        try {
          const n = await drainSourceRunners[spec.name]();
          sources[spec.name] = n;
          touched += n;
        } catch (err) {
          // Per-source isolation (SPEC §3.2): one failed source is logged and
          // skipped, never fails the job — the others still run this pass.
          logger.warn('maintenance', `queue-drain source '${spec.name}' failed (isolated; other sources still ran)`, { source: spec.name, error: String(err) });
        }
      }
      return { touched, detail: { sources } };
    },
  };

  const boundDashboardRefresh: MaintenanceJob = {
    name: 'dashboard-refresh',
    description: 'Re-render the system-dashboard pinned message and update ~/.pa/telegram-dashboard.json. Non-destructive — reads, edits, re-pins. Skips when the dashboard was never bootstrapped (no chat_id/message_id state).',
    host: 'bot',
    everyMs: 1_800_000, // 30 minutes
    shedWhenDegraded: true,
    destructive: false,
    targets: [],
    async run() {
      await refreshDashboardIfBootstrapped(deps.token);
      return { touched: 1 };
    },
  };

  return [
    boundBotLogRotationCheck,
    boundModelOverrideSweep,
    boundDeliveredStoreCompact,
    boundProxyPoolRefresh,
    boundGroundingCheck,
    boundRegistryContentWatch,
    boundDashboardRefresh,
    boundQueueDrain,
    boundBotSelfRestart,
    boundAlertDigest,
  ];
}
