import { blackboard } from '../../../blackboard.js';
import type { MaintenanceJob } from '../types.js';

const MINUTE = 60_000;

export const blackboardPurgeJob: MaintenanceJob = {
  name: 'blackboard-purge',
  host: 'pa',
  everyMs: 1 * MINUTE,
  description: 'Purge dead-PID or stale-heartbeat locks from the blackboard.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run() {
    return { touched: await blackboard.purgeStaleLocks() };
  },
};
