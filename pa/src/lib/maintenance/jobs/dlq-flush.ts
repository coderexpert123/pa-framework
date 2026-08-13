import { join } from 'path';
import type { MaintenanceJob } from '../types.js';
import { paHome } from '../../../paths.js';

export const DLQ_MAX_AGE_MS = 24 * 60 * 60_000;

export const dlqFlushJob: MaintenanceJob = {
  name: 'dlq-flush',
  host: 'bot',
  everyMs: 5 * 60_000,
  description:
    'Retry delivery of queued replies in ~/.pa/telegram-dlq.jsonl. This IS reply delivery, ' +
    'not housekeeping — shedding it for >24h would let queued replies hit the DLQ TTL and ' +
    "silently expire. It's network-bound, not the disk pressure DEGRADED signals, with an " +
    'ENOENT fast-path when the queue is empty.',
  destructive: true,
  shedWhenDegraded: false,
  targets: [
    {
      resolve: () => join(paHome(), 'telegram-dlq.jsonl'),
      match: /^telegram-dlq\.jsonl$/,
      maxAgeMs: DLQ_MAX_AGE_MS,
      action: 'delete',
      ownership: 'pa-owned',
      evidence:
        "The bot's own dead-letter queue of unsent replies (~/.pa/telegram-dlq.jsonl); the " +
        'bot process is the sole writer (audit 2026-08-02). Entries past the 24h TTL are ' +
        'dropped when the queue is rewritten after a flush.',
      note: 'A JSONL file, not a directory: expired ENTRIES inside it are dropped on flush and the file rewritten (or unlinked when empty), so the preview reports existence only.',
    },
  ],
  async run() {
    return { touched: 0, detail: { unbound: true } };
  },
};
