import type { MaintenanceJob } from '../types.js';

/**
 * Static registry stub for `registry-content-watch` — the real, bound implementation
 * lives in `projects/telegram-bot/src/maintenance-jobs.ts` (`boundRegistryContentWatch`),
 * which needs the bot's live `topicNames` map and cannot run standalone in `pa`. This
 * stub exists only so `pa maintenance list` and the registry (`MAINTENANCE_JOBS`) know
 * the job exists at all — before 2026-08-23 the bot declared it but the pa-side registry
 * never did, so it showed up nowhere `pa maintenance list`/`pa maintenance status` looks.
 * Mirrors `jobs/grounding-check.ts`'s shape exactly (same unbound-stub pattern, same
 * host/cadence/destructive/shedWhenDegraded contract).
 */
export const registryContentWatchJob: MaintenanceJob = {
  name: 'registry-content-watch',
  host: 'bot',
  everyMs: 86_400_000, // daily
  description: 'Daily content invariants for topic descriptions — watches Path-0 pointer (whatsapp-drafts), no Palo Alto hallucination (pa-alerts), routing gate (ekadashi). Non-destructive — reads and alerts only.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run() {
    return { touched: 0, detail: { unbound: true } };
  },
};
