/**
 * The bot's declared maintenance jobs (AI-100 Wave 2). See
 * pa/src/lib/maintenance/types.ts for the MaintenanceJob contract this
 * satisfies.
 */
import { statSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { MaintenanceJob } from '../../../pa/dist/src/lib/maintenance/types.js';
import { notifyUser } from '../../../pa/dist/src/lib/notify.js';
import { flushDlq, DLQ_MAX_AGE_MS } from './dlq.js';
import { compactDelivered, DELIVERED_MAX_AGE_MS } from './delivered-store.js';
import { paHome } from '../../../pa/dist/src/paths.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { RUNTIME_ARCHIVE_MAX_BYTES } from '../../../pa/dist/src/lib/archive-files.js';
import {
  runScheduledPoolRefresh,
  proxyRefreshIntervalMs,
} from '../../../pa/dist/src/lib/telegram-proxy.js';
import type { TopicNameMap } from './topic-names.js';
import { isSuspiciousDescription } from './grounding-check.js';

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
 * Constructed per bot process because these close over runtime values
 * (token, chatIds, sentinelPath) that do not exist until main() has loaded
 * secrets — which is why they cannot live in pa's static MAINTENANCE_JOBS
 * array.
 *
 * ORDER IS LOAD-BEARING: runDueJobs runs jobs sequentially, and dlq-flush can
 * block for minutes during a Telegram outage (N queued replies x 30s send
 * timeout). It runs LAST so a stalled flush never delays the cheap jobs that
 * share the pass.
 */
export function createBotMaintenanceJobs(deps: BotMaintenanceDeps): MaintenanceJob[] {
  const botLogRotationCheck: MaintenanceJob = {
    name: 'bot-log-rotation-check',
    host: 'bot',
    everyMs: 10 * 60_000,
    description:
      'Restart the bot (via the stop sentinel) when ~/.pa/logs/telegram-bot.log exceeds ' +
      'RUNTIME_ARCHIVE_MAX_BYTES. The bot holds the file open through shell redirection, so ' +
      'only a launcher can rotate it — the restart is what lets run-bot.ps1/.sh/.vbs move the ' +
      'shard into ~/.pa/archive/, where archive-prune governs retention.',
    destructive: false,
    shedWhenDegraded: true,
    targets: [],
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

  const modelOverrideSweep: MaintenanceJob = {
    name: 'model-override-sweep',
    host: 'bot',
    everyMs: 60_000,
    description:
      'Expire IST-day-scoped per-topic preferred_worker and tunable overrides across all ' +
      'topic-state files, refreshing the pinned status card when one expires.',
    destructive: false,
    shedWhenDegraded: true,
    targets: [],
    async run() {
      return { touched: await deps.runModelSweep(deps.token, deps.chatIds) };
    },
  };

  const deliveredStoreCompact: MaintenanceJob = {
    name: 'delivered-store-compact',
    host: 'bot',
    everyMs: 5 * 60_000,
    description:
      "Drop expired keys from the bot's effectively-once delivery guard " +
      '(~/.pa/telegram-delivered.jsonl) and rewrite the file without them.',
    destructive: true,
    shedWhenDegraded: true,
    targets: [
      {
        resolve: () => join(paHome(), 'telegram-delivered.jsonl'),
        match: /^telegram-delivered\.jsonl$/,
        maxAgeMs: DELIVERED_MAX_AGE_MS,
        action: 'delete',
        ownership: 'pa-owned',
        evidence:
          "The bot's own effectively-once delivery guard (~/.pa/telegram-delivered.jsonl); " +
          'the bot process is the sole writer (audit 2026-08-02). Keys older than 24h are ' +
          'dropped from the map and the file rewritten without them.',
        note: 'A JSONL file, not a directory: expired KEYS inside it are dropped and the file is rewritten in place, so the preview reports existence only.',
      },
    ],
    async run() {
      return { touched: await compactDelivered() };
    },
  };

  const proxyPoolRefresh: MaintenanceJob = {
    name: 'proxy-pool-refresh',
    host: 'bot',
    everyMs: () => proxyRefreshIntervalMs(),
    description:
      'Re-scan TELEGRAM_PROXY_SOURCE_URL and rewrite the healthy SOCKS5 pool at ' +
      '~/.pa/telegram-proxies.json. No-op unless a source is configured AND the direct route ' +
      'is currently blocked — a working direct route costs zero proxy scans. Not shed under ' +
      'DEGRADED: it only does work while Telegram is unreachable directly, and shedding the ' +
      'thing that restores connectivity during an outage would be self-defeating (matches the ' +
      "existing behavior — no degraded gate exists on today's equivalent timer).",
    destructive: false,
    shedWhenDegraded: false,
    targets: [],
    async run() {
      return { touched: await runScheduledPoolRefresh(deps.token) };
    },
  };

  const dlqFlush: MaintenanceJob = {
    name: 'dlq-flush',
    host: 'bot',
    everyMs: 5 * 60_000,
    description:
      'Retry delivery of queued replies in ~/.pa/telegram-dlq.jsonl. This IS reply delivery, ' +
      'not housekeeping — shedding it for >24h would let queued replies hit the DLQ TTL and ' +
      "silently expire. It's network-bound, not the disk pressure DEGRADED signals, with an " +
      'ENOENT fast-path when the queue is empty.',
    destructive: true,
    shedWhenDegraded: false,
    targets: [
      {
        resolve: () => join(paHome(), 'telegram-dlq.jsonl'),
        match: /^telegram-dlq\.jsonl$/,
        maxAgeMs: DLQ_MAX_AGE_MS,
        action: 'delete',
        ownership: 'pa-owned',
        evidence:
          "The bot's own dead-letter queue of unsent replies (~/.pa/telegram-dlq.jsonl); the " +
          'bot process is the sole writer (audit 2026-08-02). Entries past the 24h TTL are ' +
          'dropped when the queue is rewritten after a flush.',
        note: 'A JSONL file, not a directory: expired ENTRIES inside it are dropped on flush and the file rewritten (or unlinked when empty), so the preview reports existence only.',
      },
    ],
    async run() {
      const r = await flushDlq(deps.token);
      return { touched: r.delivered, detail: { remaining: r.remaining, deduped: r.deduped } };
    },
  };

  const groundingCheck: MaintenanceJob = {
    name: 'grounding-check',
    host: 'bot',
    everyMs: 6 * 60 * 60_000, // 6h
    description:
      "Page when a topic's description looks clobbered — the AI-101 failure shape (a voice " +
      "message or a leaked assistant reply silently overwrote the topic's grounding pointer). " +
      'Pattern-based only; does not flag a missing description (a separate, larger, ' +
      'pre-existing gap already handled best-effort by backfillTopicDescriptions) or check ' +
      'content drift against any declared source — there is no per-topic declared-source field ' +
      "(a structured `sources` pointer + live injection was designed but deferred, see the " +
      'AI-101 plan) so there is nothing to diff; this only catches descriptions that actively ' +
      'look wrong.',
    destructive: false,
    shedWhenDegraded: true,
    targets: [],
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

  return [botLogRotationCheck, modelOverrideSweep, deliveredStoreCompact, proxyPoolRefresh, groundingCheck, dlqFlush];
}
