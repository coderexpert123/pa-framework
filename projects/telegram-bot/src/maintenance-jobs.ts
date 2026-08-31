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
  dlqFlushJob,
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
  /** Telegram bot token — needed by dlq-flush and proxy-pool-refresh. */
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
 * ORDER IS LOAD-BEARING: runDueJobs runs jobs sequentially, and dlq-flush can
 * block for minutes during a Telegram outage (N queued replies x 30s send
 * timeout). It runs LAST so a stalled flush never delays the cheap jobs that
 * share the pass.
 */
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

  const boundDlqFlush: MaintenanceJob = {
    ...dlqFlushJob,
    async run() {
      const r = await flushDlq(deps.token);
      return { touched: r.delivered, detail: { remaining: r.remaining, deduped: r.deduped } };
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
  // is asserted by maintenance-jobs.test.ts. Cheap job runs BEFORE dlq-flush
  // (jobs array order is load-bearing — see the comment above
  // createBotMaintenanceJobs).
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

  const boundRequeueDrain: MaintenanceJob = {
    name: 'requeue-drain',
    description: 'Re-inject parked requeue-ladder dispatches whose backoff has elapsed (seamless restart recovery, 2026-08-27). Request recovery, not housekeeping — never shed under DEGRADED, mirroring dlq-flush.',
    host: 'bot',
    everyMs: 5 * 60_000,
    shedWhenDegraded: false,
    destructive: false,
    targets: [],
    async run() {
      return { touched: await deps.requeueDrain() };
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
    boundRequeueDrain,
    boundBotSelfRestart,
    boundAlertDigest,
    boundDlqFlush,
  ];
}
