import type { MaintenanceJob } from '../types.js';

export const groundingCheckJob: MaintenanceJob = {
  name: 'grounding-check',
  host: 'bot',
  everyMs: 6 * 60 * 60_000, // 6h
  description:
    "Page when a topic's description looks clobbered — the AI-101 failure shape — and when " +
    "a topic's declared /sources file is missing or unreadable at check time. Bound " +
    'implementation: projects/telegram-bot/src/maintenance-jobs.ts (boundGroundingCheck). ' +
    'Pattern-based on descriptions only; does not diff source CONTENT, just ' +
    'existence/readability.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run() {
    return { touched: 0, detail: { unbound: true } };
  },
};
