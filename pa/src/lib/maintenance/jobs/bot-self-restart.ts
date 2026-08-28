import type { MaintenanceJob } from '../types.js';

/** Static stub — the real, bound implementation lives in
 *  projects/telegram-bot/src/maintenance-jobs.ts (boundBotSelfRestart), which
 *  needs the bot's own process start time and its live idle signals and cannot
 *  run standalone in pa. This stub exists so `pa maintenance list`/`status` and
 *  MAINTENANCE_JOBS know the job exists. name/host/everyMs/destructive/
 *  shedWhenDegraded must stay identical in both places — asserted by
 *  pa/tests/maintenance-registry.test.ts and the bot's maintenance-jobs.test.ts. */
export const botSelfRestartJob: MaintenanceJob = {
  name: 'bot-self-restart',
  host: 'bot',
  everyMs: 60_000,
  description:
    'Restart the bot (graceful stop sentinel; Task Scheduler relaunches) when dist/.build-stamp is newer than the running process AND the bot is idle. Never an in-process restart. Disabled with PA_BOT_SELF_RESTART=0.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run() {
    return { touched: 0, detail: { unbound: true } };
  },
};
