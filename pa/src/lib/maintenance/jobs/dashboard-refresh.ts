import type { MaintenanceJob } from '../types.js';

/**
 * Static registry stub for `dashboard-refresh` — the real, bound implementation
 * lives in `projects/telegram-bot/src/maintenance-jobs.ts` (`boundDashboardRefresh`),
 * which needs the bot's live `telegram.ts` `editMessageText` and the dashboard's state
 * file at `~/.pa/telegram-dashboard.json`. This stub exists only so `pa maintenance list`
 * and the registry (`MAINTENANCE_JOBS`) know the job exists at all — before 2026-08-28,
 * the dashboard refreshed only at startup and on the since-removed sleep-inhibit toggle,
 * with no recurring cadence. Mirrors `jobs/registry-content-watch.ts'` shape exactly (same unbound-stub
 * pattern, same host/cadence/destructive/shedWhenDegraded contract).
 */
export const dashboardRefreshJob: MaintenanceJob = {
  name: 'dashboard-refresh',
  host: 'bot',
  everyMs: 1_800_000, // 30 minutes
  description: 'Re-render the system-dashboard pinned message and update ~/.pa/telegram-dashboard.json. Non-destructive — reads, edits, re-pins. Skips when the dashboard was never bootstrapped (no chat_id/message_id state).',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run() {
    return { touched: 0, detail: { unbound: true } };
  },
};
