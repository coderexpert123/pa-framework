import type { MaintenanceJob, MaintenanceJobContext } from '../types.js';
import { readdir, stat } from 'fs/promises';
import { platform } from 'os';
import { join, resolve } from 'path';

/**
 * Shared test scratch directory sweeper — removes stale leak artifacts
 * (replay_lock_*, render_lock_*, pytest-of-*) from the shared test scratch dir
 * (PA_TEST_TMP_DIR, default C:/wt/tmp on Windows).
 *
 * Dated evidence (2026-08-28 disk-full incident): Shared Claude-session test scratch accumulates
 * leak artifacts with no retention owner. Files older than 1 hour are safe to delete:
 * - replay_lock_* / render_lock_*: crashed or abandoned session lock files
 * - pytest-of-*: test detritus from incomplete runs
 * Durable session baselines deliberately live under C:/wt/<session>/ and C:/wt/backup/,
 *   outside this match set — pattern allowlist + 1h age floor protects in-flight runs.
 *
 * Ownership class: external-no-retention (Claude-session scratch; no tool owns retention here).
 */
export const sharedTmpSweepJob: MaintenanceJob = {
  name: 'shared-tmp-sweep',
  host: 'pa',
  everyMs: 3_600_000, // hourly
  destructive: true,
  shedWhenDegraded: true,
  description: 'Sweep stale leak artifacts (replay_lock_*, render_lock_*, pytest-of-*) from the shared test scratch dir (PA_TEST_TMP_DIR, default C:/wt/tmp on Windows) — files older than 1h only; never touches anything outside the pattern allowlist. Dated evidence: 2026-08-28 disk-full incident.',
  targets: [
    {
      resolve: () => resolve(process.env.PA_TEST_TMP_DIR || (platform() === 'win32' ? 'C:/wt/tmp' : '/nonexistent-pa-test-tmp')),
      match: /^(replay_lock_|render_lock_|pytest-of-)/,
      maxAgeMs: 3_600_000, // 1 hour
      action: 'delete',
      ownership: 'external-no-retention',
      evidence: 'Shared Claude-session test scratch (2026-08-28 disk-full lesson: leak artifacts accumulate with no owner; durable baselines deliberately live under C:/wt/<session>/ and C:/wt/backup, outside this match set)',
      note: 'other sessions own files here — pattern allowlist + 1h age floor protect in-flight runs'
    }
  ],
  async run(ctx: MaintenanceJobContext): Promise<{ touched: number; detail?: { skipped?: string } }> {
    const target = this.targets[0];
    const scratchDir = target.resolve();

    try {
      const entries = await readdir(scratchDir, { withFileTypes: true });
      let touched = 0;

      for (const entry of entries) {
        // Skip non-matching names
        if (!target.match.test(entry.name)) continue;

        const fullPath = join(scratchDir, entry.name);

        // Get stat to check age and type
        const stats = await stat(fullPath);
        const entryAgeMs = ctx.now - stats.mtimeMs;
        if (entryAgeMs < target.maxAgeMs) continue; // Too young, skip

        if (stats.isDirectory()) {
          // pytest-of-* are directories; remove recursively
          const { rm } = await import('fs/promises');
          await rm(fullPath, { recursive: true, force: true });
          touched++;
        } else {
          // Files: unlink
          const { unlink } = await import('fs/promises');
          await unlink(fullPath);
          touched++;
        }
      }

      return { touched };
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        // Scratch dir doesn't exist yet — normal
        return { touched: 0, detail: { skipped: 'no scratch dir' } };
      }
      throw err;
    }
  }
};
