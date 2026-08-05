import { join } from 'path';
import { paHome } from '../../../paths.js';
import { cleanupOrphanedWorkers } from '../../../worker-pids.js';
import type { MaintenanceJob } from '../types.js';

const MINUTE = 60_000;

export const orphanWorkerReapJob: MaintenanceJob = {
  name: 'orphan-worker-reap',
  host: 'pa',
  everyMs: 1 * MINUTE,
  description: 'Kill workers whose spawning process died, and reap stale worker-pid registration files.',
  destructive: true,
  shedWhenDegraded: true,
  targets: [
    {
      resolve: () => join(paHome(), 'worker-pids'),
      match: /^\d+\.json(\.tmp)?$/,
      maxAgeMs: 5 * MINUTE,
      action: 'delete',
      ownership: 'pa-owned',
      evidence: 'PA writes every worker-pid registration here (worker-pids.ts); sole writer (audit 2026-08-02).',
      note: 'The <pid>.json half is selected by SPAWNER LIVENESS, not by age — maxAgeMs above applies only to <pid>.json.tmp crash artifacts, so the dry-run preview under-reports .json candidates and never over-reports.',
    },
  ],
  async run() {
    return { touched: await cleanupOrphanedWorkers() };
  },
};
