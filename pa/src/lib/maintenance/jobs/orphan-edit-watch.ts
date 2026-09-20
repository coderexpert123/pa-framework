import { runOrphanEditWatch } from '../../orphan-watch.js';
import type { MaintenanceJob } from '../types.js';

/**
 * orphan-edit-watch (AI-214, 2026-09-08) — daily operator-gated surface for
 * working-tree files dirty >= 6 h with no active reservation. Detection is
 * surface-only and NEVER auto-commits; the land-as-is commit runs only from
 * the operator's `ow:` button press (`pa orphan land`), which re-checks
 * reservations and the git-workflow lock at press time. Runner-driven via
 * `pa catchup`'s maintenance phase — no bare timer (timer-inventory stays
 * untouched). Kill switch: config.maintenance['orphan-edit-watch'].enabled.
 */
export const orphanEditWatchJob: MaintenanceJob = {
  name: 'orphan-edit-watch',
  host: 'pa',
  everyMs: 24 * 60 * 60 * 1000, // 24h — C5: piggybacks the maintenance phase
  description:
    'Daily disposition ladder for working-tree files dirty >=6h with no active reservation: attribute owners via the orphan ledger and Claude transcript activity, defer live owners, auto-dispatch a completion-agent topic task (finish or land verbatim, pathspec commit, TTL claim held during the attempt) for dead owners, and only after ~48h unresolved alert the operator with land/keep/diff buttons. Never commits itself; the agent and the operator button do.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [], // surface-only; own-state writes are not retention (daily-recon precedent)

  async run(ctx) {
    return runOrphanEditWatch({ now: ctx.now });
  },
};
