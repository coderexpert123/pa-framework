/**
 * The bot's declared maintenance jobs (AI-100 Wave 2 / AI-108 static registry integration).
 * See pa/src/lib/maintenance/types.ts for the MaintenanceJob contract this satisfies.
 */
import { statSync, writeFileSync } from 'fs';
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
import type { TopicNameMap } from './topic-names.js';
import { isSuspiciousDescription } from './grounding-check.js';
import {
  botLogRotationCheckJob,
  modelOverrideSweepJob,
  deliveredStoreCompactJob,
  proxyPoolRefreshJob,
  dlqFlushJob,
  groundingCheckJob,
} from '../../../pa/dist/src/lib/maintenance/jobs/index.js';

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

  return [
    boundBotLogRotationCheck,
    boundModelOverrideSweep,
    boundDeliveredStoreCompact,
    boundProxyPoolRefresh,
    boundGroundingCheck,
    boundDlqFlush,
  ];
}
