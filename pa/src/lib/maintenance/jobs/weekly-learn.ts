import { learnCommand } from '../../../commands/learn.js';
import type { MaintenanceJob } from '../types.js';

const DAY = 24 * 60 * 60 * 1000;

export const weeklyLearnJob: MaintenanceJob = {
  name: 'weekly-learn',
  host: 'pa',
  everyMs: 7 * DAY,
  description: 'Analyze the past 14 days of conversations & skill execution failures and propose skill drafts.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run() {
    await learnCommand();
    return { touched: 1 };
  },
};
