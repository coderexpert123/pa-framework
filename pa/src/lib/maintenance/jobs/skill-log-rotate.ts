import { readdir } from 'fs/promises';
import { logsDir } from '../../../paths.js';
import { rotateLogs } from '../../../logger.js';
import type { MaintenanceJob } from '../types.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const skillLogRotateJob: MaintenanceJob = {
  name: 'skill-log-rotate',
  host: 'pa',
  everyMs: 1 * HOUR,
  description: "Rotate (delete) each skill's per-run execution logs older than 7 days, or whose .log exceeds 10MB.",
  destructive: true,
  shedWhenDegraded: true,
  targets: [
    {
      resolve: () => logsDir(),
      match: /\.(log|meta)$/,
      maxAgeMs: 7 * DAY,
      action: 'delete',
      ownership: 'pa-owned',
      evidence: "PA's own per-skill execution logs (~/.pa/logs/<skill>/); PA is the sole writer (audit 2026-08-02).",
      note: 'rotateLogs also deletes a pair whose .log exceeds 10MB regardless of age, and sweeps stranded latest.json.*.tmp files >1h old. Preview shows the age-based candidates only, and only at the top level (real candidates live one directory deeper, per skill).',
    },
  ],
  async run() {
    const entries = await readdir(logsDir(), { withFileTypes: true }).catch(() => []);
    let sum = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const result = await rotateLogs(entry.name).catch(() => ({ deletedCount: 0 }));
      sum += result.deletedCount;
    }
    return { touched: sum };
  },
};
