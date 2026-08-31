import type { MaintenanceJob } from '../types.js';

/** Static stub — the real, bound implementation lives in
 *  projects/telegram-bot/src/maintenance-jobs.ts (boundAlertDigest), which
 *  calls notifyUser and cannot run standalone in pa. This stub exists so
 *  `pa maintenance list`/`status` and MAINTENANCE_JOBS know the job exists.
 *  Mirrors jobs/registry-content-watch.ts's shape exactly (same unbound-stub
 *  pattern, same host/cadence/destructive/shedWhenDegraded contract).
 *  name/host/everyMs/destructive/shedWhenDegraded must stay identical in both
 *  places — asserted by pa/tests/maintenance-registry.test.ts and the bot's
 *  maintenance-jobs.test.ts. */
export const alertDigestJob: MaintenanceJob = {
  name: 'alert-digest',
  host: 'bot',
  everyMs: 86_400_000, // daily
  description:
    'Daily flush of the alert circuit-breaker digest (~/.pa/alert-digest/<date>.json): one combined message per day for breaker-suppressed alerts. Non-destructive — reads, sends, marks flushed.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run() {
    return { touched: 0, detail: { unbound: true } };
  },
};
