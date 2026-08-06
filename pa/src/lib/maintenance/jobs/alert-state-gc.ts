import { join } from 'path';
import { paHome } from '../../../paths.js';
import { migrateStalenessAlertFile, gcAlertState, GC_MAX_AGE_MS } from '../../notify.js';
import type { MaintenanceJob } from '../types.js';

const HOUR = 3_600_000;

export const alertStateGcJob: MaintenanceJob = {
  name: 'alert-state-gc',
  host: 'pa',
  everyMs: 1 * HOUR,
  description: "Garbage-collect notifyUser's dedup state files past their per-alert (or default 24h) window.",
  destructive: true,
  shedWhenDegraded: true,
  targets: [
    {
      resolve: () => join(paHome(), 'alert-state'),
      match: /\.json$/,
      maxAgeMs: GC_MAX_AGE_MS,
      action: 'delete',
      ownership: 'pa-owned',
      evidence: "PA's own notifyUser dedup state (lib/notify.ts); sole writer. This job HAS NEVER RUN IN PRODUCTION — it was gated on `!opts.topic` at catchup.ts:77 while both registered Task Scheduler tasks pass --topic, so the directory has accumulated unbounded since it was written. The first run may delete a large backlog; that is correct (audit 2026-08-02).",
      note: 'Each file carries its own windowMs; gcAlertState honours it and falls back to GC_MAX_AGE_MS (24h) for legacy files, so the preview is a lower bound.',
    },
  ],
  async run() {
    await migrateStalenessAlertFile();
    return { touched: await gcAlertState() };
  },
};
