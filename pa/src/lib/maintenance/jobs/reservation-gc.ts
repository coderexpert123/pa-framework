import { readdir, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { gcExpired, reservationsPath, MAX_TTL_MINUTES } from '../../reservations.js';
import type { MaintenanceJob } from '../types.js';
import { paHome } from '../../../paths.js';

// Imported, not redefined: a local copy would silently drift from reservations.ts's
// own clamp if that value ever changed, making this job's GC threshold wrong with
// nothing to catch it (found in a 2026-08-06 deep-recheck).
const MINUTE = 60_000;
const MAX_TTL_MS = MAX_TTL_MINUTES * MINUTE;

async function cleanStaleTmpFiles(nowMs: number): Promise<number> {
  const dir = paHome();
  let cleaned = 0;
  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      if (name.endsWith('.tmp')) {
        const fullPath = join(dir, name);
        try {
          const s = await stat(fullPath);
          if (s.isFile() && nowMs - s.mtimeMs > 3_600_000) {
            await unlink(fullPath);
            cleaned++;
          }
        } catch {}
      }
    }
  } catch {}
  return cleaned;
}

export const reservationGcJob: MaintenanceJob = {
  name: 'reservation-gc',
  host: 'pa',
  everyMs: 5 * MINUTE,
  description: 'Garbage-collect expired file/logical-resource reservations and stale ~/.pa/*.tmp atomic write artifacts.',
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
        'the multi-session coordination protocol (2026-08-05 internal plan).',
      note:
        'Row-level expiry, not whole-file deletion: each reservation carries its own ' +
        'expiresAt; gcExpired() drops only expired rows and rewrites the file in place. ' +
        'The target resolves to the file itself (not a directory it lives in), so the ' +
        'generic dry-run previewer reports existence only — mirrors the session-gc job\'s ' +
        'codex sqlite target, which has the same shape.',
    },
    {
      resolve: () => paHome(),
      match: /\.tmp$/,
      maxAgeMs: 3_600_000,
      action: 'delete',
      ownership: 'pa-owned',
      evidence:
        'Stale temporary files created during atomic writes in ~/.pa/ (e.g. maintenance-state.json.*.tmp). ' +
        'Unlinked when older than 1 hour.',
    },
  ],
  async run(ctx) {
    const expiredReservations = await gcExpired(ctx.now);
    const cleanedTmpFiles = await cleanStaleTmpFiles(ctx.now);
    return { touched: expiredReservations + cleanedTmpFiles, detail: { expiredReservations, cleanedTmpFiles } };
  },
};
