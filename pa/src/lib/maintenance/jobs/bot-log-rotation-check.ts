import type { MaintenanceJob } from '../types.js';

export const botLogRotationCheckJob: MaintenanceJob = {
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
  async run() {
    return { touched: 0, detail: { unbound: true } };
  },
};
