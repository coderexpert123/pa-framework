import { join } from 'path';
import { paHome } from '../../../paths.js';
import { PRUNABLE_ARCHIVE_SUFFIXES, DEFAULT_ARCHIVE_RETENTION, pruneArchive } from '../../archive-files.js';
import type { MaintenanceJob } from '../types.js';

const DAY = 24 * 60 * 60 * 1000;

const match = new RegExp('(' + PRUNABLE_ARCHIVE_SUFFIXES.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$');

export const archivePruneJob: MaintenanceJob = {
  name: 'archive-prune',
  host: 'pa',
  everyMs: 1 * 60 * 60 * 1000,
  description: "Delete rotated ~/.pa/archive/ shards past retention (age, then a total-bytes backstop); rotated conversation-history shards are permanent and excluded.",
  destructive: true,
  shedWhenDegraded: true,
  targets: [
    {
      resolve: () => join(paHome(), 'archive'),
      match,
      maxAgeMs: DEFAULT_ARCHIVE_RETENTION.maxAgeDays * DAY,
      action: 'delete',
      ownership: 'pa-owned',
      evidence: "PA's own rotated archive shards (~/.pa/archive/); PA is the sole writer (audit 2026-08-02). PRUNABLE_ARCHIVE_SUFFIXES is an explicit ALLOWLIST — rotated conversation-history shards are PERMANENT and excluded from both the age loop and the byte cap. Includes rotated turn-traces.jsonl shards from 2026-08-24 (deterministic per-run trace sidecar, AI-161) — derived debugging data, prunable at 90 days.",
      note: 'Also applies a 500MB oldest-first byte-cap backstop over prunable files only; the preview shows the age-based candidates only.',
    },
  ],
  async run() {
    return { touched: await pruneArchive() };
  },
};
