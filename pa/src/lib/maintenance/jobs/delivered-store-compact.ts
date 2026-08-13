import { join } from 'path';
import type { MaintenanceJob } from '../types.js';
import { paHome } from '../../../paths.js';

export const DELIVERED_MAX_AGE_MS = 24 * 60 * 60_000;

export const deliveredStoreCompactJob: MaintenanceJob = {
  name: 'delivered-store-compact',
  host: 'bot',
  everyMs: 5 * 60_000,
  description:
    "Drop expired keys from the bot's effectively-once delivery guard " +
    '(~/.pa/telegram-delivered.jsonl) and rewrite the file without them.',
  destructive: true,
  shedWhenDegraded: true,
  targets: [
    {
      resolve: () => join(paHome(), 'telegram-delivered.jsonl'),
      match: /^telegram-delivered\.jsonl$/,
      maxAgeMs: DELIVERED_MAX_AGE_MS,
      action: 'delete',
      ownership: 'pa-owned',
      evidence:
        "The bot's own effectively-once delivery guard (~/.pa/telegram-delivered.jsonl); the " +
        'bot process is the sole writer (audit 2026-08-02). Keys older than 24h are dropped ' +
        'from the map and the file rewritten without them.',
      note: 'A JSONL file, not a directory: expired KEYS inside it are dropped and the file is rewritten in place, so the preview reports existence only.',
    },
  ],
  async run() {
    return { touched: 0, detail: { unbound: true } };
  },
};
