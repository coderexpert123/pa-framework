import { readdir, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { paHome } from '../../../paths.js';
import type { MaintenanceJob } from '../types.js';

const DAY = 24 * 60 * 60 * 1000;
const RETENTION_MS = DAY;

const WORKER_TEE_FILE_RE = /\.out$/;

function workerTeeDir(): string {
  return join(paHome(), 'logs', 'worker-tee');
}

/**
 * Delete worker tee-capture files older than cutoffMs. Single-level directory
 * (no nesting). Exported for testing.
 */
export async function cleanupExpiredTeeFiles(
  cutoffMs: number,
  root: string = workerTeeDir(),
): Promise<number> {
  let deleted = 0;
  let files: string[];
  try {
    files = await readdir(root);
  } catch {
    return 0;
  }
  for (const file of files) {
    if (!WORKER_TEE_FILE_RE.test(file)) continue;
    const filePath = join(root, file);
    try {
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs < cutoffMs) {
        await unlink(filePath);
        deleted++;
      }
    } catch {
      // vanished between readdir and stat/unlink — skip
    }
  }
  return deleted;
}

export const workerTeeGcJob: MaintenanceJob = {
  name: 'worker-tee-gc',
  host: 'pa',
  everyMs: DAY,
  description: 'Delete worker stdout tee-capture files older than 24 hours. These are safety-net copies of agy stdout captured by the shim-chain tee helper; the reply is either delivered normally or recovered by the orphan reaper within the harvest window. After 24h they are debug-only.',
  destructive: true,
  shedWhenDegraded: true,
  targets: [
    {
      resolve: workerTeeDir,
      match: WORKER_TEE_FILE_RE,
      maxAgeMs: RETENTION_MS,
      action: 'delete',
      ownership: 'pa-owned',
      evidence: 'pa/src/worker-exec.ts writes these via the tee helper (plans/2026-08-15-agy-tee-recovery.md); they are runtime state with no long-term value after recovery or normal delivery.',
    },
  ],
  async run(ctx) {
    return { touched: await cleanupExpiredTeeFiles(ctx.now - RETENTION_MS) };
  },
};
