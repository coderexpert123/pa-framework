import type { MaintenanceJob } from '../types.js';

export const groundingCheckJob: MaintenanceJob = {
  name: 'grounding-check',
  host: 'bot',
  everyMs: 6 * 60 * 60_000, // 6h
  description:
    "Page when a topic's description looks clobbered — the AI-101 failure shape (a voice " +
    "message or a leaked assistant reply silently overwrote the topic's grounding pointer). " +
    'Pattern-based only; does not flag a missing description (a separate, larger, ' +
    'pre-existing gap already handled best-effort by backfillTopicDescriptions) or check ' +
    'content drift against any declared source — there is no per-topic declared-source field ' +
    '(a structured `sources` pointer + live injection was designed but deferred, see the ' +
    'AI-101 plan) so there is nothing to diff; this only catches descriptions that actively ' +
    'look wrong.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run() {
    return { touched: 0, detail: { unbound: true } };
  },
};
