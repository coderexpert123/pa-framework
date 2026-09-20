/**
 * bus-prune — expire bus-queue envelopes past the retention bound.
 *
 * Since soft-read inboxes (2026-09-17, operator directive) a `pa bus inbox`
 * read marks a `readBy` receipt instead of deleting — an accidental foreign
 * read can no longer destroy the owner's mail. The consequence: NOTHING else
 * removes an envelope short of explicit pop/ack, so this job is the only
 * bound — every queue, including phantom/unregistered addresses nobody ever
 * reads, expires at 24h / 200 entries, once per day.
 */
import { readdir } from 'fs/promises';
import { join } from 'path';
import { paHome } from '../../../paths.js';
import { pruneBusQueue, reapBusRegistry } from '../../bus-queue.js';
import { addressFromQueueFilename } from './bus-drain.js';
import type { MaintenanceJob, MaintenanceJobResult } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const busPruneJob: MaintenanceJob = {
  name: 'bus-prune',
  host: 'pa',
  everyMs: DAY_MS,
  description:
    'Expire ~/.pa/queues/*.jsonl envelopes past the 24h/200-entry bound — soft-read inboxes never delete on read, so this is the only expiry. Covers phantom/unregistered queues nobody reads.',
  destructive: true,
  shedWhenDegraded: true,
  targets: [
    {
      resolve: () => join(paHome(), 'queues'),
      match: /\.jsonl$/,
      maxAgeMs: DAY_MS,
      action: 'delete',
      ownership: 'pa-owned',
      evidence:
        "PA's own inter-agent bus queues — PA is the sole writer. Soft-read readBy receipts (2026-09-17) mean reads no longer remove envelopes; this job is the only expiry bound, and also reaps phantom-address queues.",
      note: 'Selection is PER-ENVELOPE inside each queue file: expired JSONL lines are removed in place and the file is kept. The file-level dry-run preview (by mtime) therefore understates what is removed.',
    },
  ],
  async run(): Promise<MaintenanceJobResult> {
    let pruned = 0;
    let files: string[] = [];
    try {
      files = await readdir(join(paHome(), 'queues'));
    } catch {
      return { touched: 0 }; // no queues dir — nothing to prune
    }
    for (const file of files) {
      const address = addressFromQueueFilename(file);
      if (!address) continue;
      try {
        pruned += (await pruneBusQueue(address)).pruned;
      } catch {
        // a corrupt queue file is not this job's problem — skip it
      }
    }
    // Registry hygiene (2026-09-17): registry rows are TTL-free, so dead
    // sessions' addresses lingered forever — sends to provider@repo fanned
    // out to dead addresses and reused pids could mis-resolve. Reap rows
    // whose host pid is dead (or superseded by a different live identity on
    // the same pid); queue files are untouched — the envelope bound above
    // still expires them.
    let reaped = 0;
    try {
      reaped = (await reapBusRegistry()).reaped.length;
    } catch {
      // registry unreadable — not this job's problem
    }
    return { touched: pruned + reaped };
  },
};
