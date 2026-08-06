import { gcExpired, reservationsPath, MAX_TTL_MINUTES } from '../../reservations.js';
import type { MaintenanceJob } from '../types.js';

// Imported, not redefined: a local copy would silently drift from reservations.ts's
// own clamp if that value ever changed, making this job's GC threshold wrong with
// nothing to catch it (found in a 2026-08-06 deep-recheck).
const MINUTE = 60_000;
const MAX_TTL_MS = MAX_TTL_MINUTES * MINUTE;

export const reservationGcJob: MaintenanceJob = {
  name: 'reservation-gc',
  host: 'pa',
  everyMs: 5 * MINUTE,
  description: 'Garbage-collect expired file/logical-resource reservations from the multi-session coordination registry.',
  destructive: true,
  shedWhenDegraded: true,
  targets: [
    {
      resolve: () => reservationsPath(),
      match: /^reservations\.json$/,
      maxAgeMs: MAX_TTL_MS,
      action: 'delete',
      ownership: 'pa-owned',
      evidence:
        "PA's own multi-session reservation registry (lib/reservations.ts); sole writer. " +
        'Reservations are TTL-bounded (45m default, 240m hard max) — added 2026-08-05 for ' +
        'the multi-session coordination protocol (plans/2026-08-05-concurrent-session-safety.md).',
      note:
        'Row-level expiry, not whole-file deletion: each reservation carries its own ' +
        'expiresAt; gcExpired() drops only expired rows and rewrites the file in place. ' +
        'The target resolves to the file itself (not a directory it lives in), so the ' +
        'generic dry-run previewer reports existence only — mirrors the session-gc job\'s ' +
        'codex sqlite target, which has the same shape.',
    },
  ],
  async run(ctx) {
    return { touched: await gcExpired(ctx.now) };
  },
};
