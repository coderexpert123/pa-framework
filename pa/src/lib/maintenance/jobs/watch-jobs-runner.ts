import type { MaintenanceJob } from '../types.js';
import { runWatchTick, watchJobsPath, TERMINAL_RETENTION_MS } from '../../watch-jobs.js';

export const watchJobsRunnerJob: MaintenanceJob = {
  name: 'watch-jobs-runner',
  host: 'pa',
  everyMs: 60_000,
  description:
    'Evaluate registered async watch jobs (AI-170), report every terminal outcome to the chat/thread that registered it, and row-prune terminal records older than 14 days.',
  destructive: true,
  shedWhenDegraded: false,   // the report IS the deliverable — an async completion the user was
                             // explicitly promised. Checks are stat-cheap and bounded
                             // (<=10 per tick, 256 KB tail reads).
  targets: [
    {
      resolve: () => watchJobsPath(),
      match: /^watch-jobs\.json$/,
      maxAgeMs: TERMINAL_RETENTION_MS,
      action: 'delete',
      ownership: 'pa-owned',
      evidence:
        "PA's own async-watch registry (lib/watch-jobs.ts); sole writer. Rows are bounded by their " +
        'own deadlineAt and pruned 14 days after reaching a terminal status — AI-170, 2026-08-31, ' +
        'the internal async-watch spec.',
      note:
        'Row-level expiry, not whole-file deletion: each watch carries its own terminalAt; the ' +
        'runner drops only terminal rows older than 14 days and rewrites the file in place. The ' +
        'target resolves to the file itself (not a directory), so the generic dry-run previewer ' +
        "reports existence only — mirrors jobs/reservation-gc.ts's first target, which has the same shape.",
    },
  ],
  async run(ctx) {
    const r = await runWatchTick({ now: ctx.now });
    return {
      touched: r.reported + r.expired + r.failed + r.forced + r.pruned,
      detail: { ...r },
    };
  },
};
