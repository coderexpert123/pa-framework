/**
 * The bot's declared maintenance jobs (AI-100 Wave 2 / AI-108 static registry integration).
 * See pa/src/lib/maintenance/types.ts for the MaintenanceJob contract this satisfies.
 */
import { statSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { MaintenanceJob } from '../../../pa/dist/src/lib/maintenance/types.js';
import { notifyUser } from '../../../pa/dist/src/lib/notify.js';
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
import type { TopicNameMap } from './topic-names.js';
import { isSuspiciousDescription } from './grounding-check.js';
import { listPendingDispatches } from './pending-dispatches.js';
import { listTopicStateRefs } from './conversation.js';
import { shouldSelfRestart, shouldWarnStaleCode } from './self-restart.js';
import { refreshDashboardIfBootstrapped } from './dashboard.js';
import {
  botLogRotationCheckJob,
  modelOverrideSweepJob,
  deliveredStoreCompactJob,
  proxyPoolRefreshJob,
  dlqFlushJob,
  groundingCheckJob,
} from '../../../pa/dist/src/lib/maintenance/jobs/index.js';
import { botSelfRestartJob } from '../../../pa/dist/src/lib/maintenance/jobs/bot-self-restart.js';
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
const REGISTRY_CONTENT_INVARIANTS = [
  {
    topicKey: 'whatsapp-drafts',
    threadId: 9855,
    test: (desc: string | undefined) => desc?.includes('INSTRUCTIONS.md') ?? false,
    label: 'Path-0 pointer',
  },
  {
    topicKey: 'pa-alerts',
    threadId: 3376,
    test: (desc: string | undefined) => !desc?.includes('Palo Alto'),
    label: 'no hallucinated gloss',
  },
  {
    topicKey: 'ekadashi',
    threadId: 7822,
    test: (desc: string | undefined) => desc?.includes('Sources.md') ?? false,
    label: 'deterministic routing gate',
  },
] as const;

export interface RegistryContentViolation {
  topicKey: string;
  threadId: number;
  invariantLabel: string;
  description: string | undefined;
}

/**
 * Pure check function for registry content invariants.
 * Returns a list of violations (empty if all pass). Exported for tests.
 */
export function checkRegistryContentInvariants(topicNames: TopicNameMap): RegistryContentViolation[] {
  const violations: RegistryContentViolation[] = [];
  for (const inv of REGISTRY_CONTENT_INVARIANTS) {
    let found = false;
    for (const [chatId, threads] of topicNames.entries()) {
      const entry = threads.get(inv.threadId);
      if (entry && entry.name === inv.topicKey) {
        found = true;
        if (!inv.test(entry.description)) {
          violations.push({
            topicKey: inv.topicKey,
            threadId: inv.threadId,
            invariantLabel: inv.label,
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
    description: 'Daily content invariants for topic descriptions — watches Path-0 pointer (whatsapp-drafts), no Palo Alto hallucination (pa-alerts), routing gate (ekadashi). Non-destructive — reads and alerts only.',
    host: 'bot',
    everyMs: 86_400_000, // daily
    shedWhenDegraded: true,
    destructive: false,
    targets: [], // non-destructive — reads and alerts only
    async run() {
      const violations = checkRegistryContentInvariants(deps.topicNames);
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

      let pendingActions = 0;
      for (const ref of await listTopicStateRefs()) {
        try {
          const raw = await readFile(ref.path, 'utf8');
          const parsed = JSON.parse(raw) as { pending_action?: unknown };
          if (parsed.pending_action) pendingActions++;
        } catch {
          // a parse failure counts as 0 for that file.
        }
      }

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
        logger.warn('bot', 'self-restart: dist stamp has been newer than this process for 30+ minutes but the bot has never gone idle', { stampMtimeMs, procStartMs, firstSeenNewerStampMs });
        await notifyUser(
          'Bot running stale code',
          `dist stamp has been newer than this running process for 30+ minutes, but the bot has never gone idle long enough to self-restart (last reason: ${d.reason}). stampMtimeMs=${stampMtimeMs}, procStartMs=${procStartMs}.`,
          { dedupKey: 'bot-stale-code', severity: 'warn', escalate: false },
        ).catch(() => {});
        return { touched: 0, detail: { reason: d.reason, stale: true } };
      }

      return { touched: 0, detail: { reason: d.reason } };
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
    boundDlqFlush,
  ];
}
