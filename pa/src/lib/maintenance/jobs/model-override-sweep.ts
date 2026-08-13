import type { MaintenanceJob } from '../types.js';

export const modelOverrideSweepJob: MaintenanceJob = {
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
    return { touched: 0, detail: { unbound: true } };
  },
};
