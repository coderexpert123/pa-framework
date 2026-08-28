import type { MaintenanceJob } from '../types.js';
import { runRecallEngine } from '../../../commands/recall.js';

/**
 * Incremental recall index refresh. Non-destructive: `recall.sqlite` is
 * derived data, fully rebuildable with `pa recall --rebuild` (recall-store.ts
 * §C2: a foreign/missing schema version is rebuilt, never migrated or failed
 * on). Throwing on `ok:false` is deliberate — the runner records `failed` and
 * the AI-098-style backoff ladder paces retries instead of hammering the
 * store every 10 minutes.
 *
 * Spec: plans/2026-08-24-recall-traces-wave-SPEC.md §3.4 (WP-D), step 9.
 */
export const recallIndexJob: MaintenanceJob = {
  name: 'recall-index',
  host: 'pa',
  everyMs: 10 * 60_000,
  description:
    'Incrementally refresh ~/.pa/recall.sqlite (FTS5) from conversation-history.jsonl + rotated shards, turn-traces.jsonl, topic brains, the Ecosystem KB, review-digest-pending.jsonl, and ~/.pa/decisions.sqlite (AI-164 decision rows, indexed by rowid watermark). Non-destructive: the DB is derived and rebuildable with `pa recall --rebuild`.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run() {
    const r = await runRecallEngine('index');
    if (r.ok !== true) throw new Error(String(r.error ?? 'recall index failed'));
    const ix = (r.indexed ?? {}) as Record<string, number>;
    return { touched: (ix.added ?? 0) + (ix.updated ?? 0) + (ix.deleted ?? 0), detail: { indexed: ix } };
  },
};
