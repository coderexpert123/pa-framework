import { exec } from 'child_process';
import { promisify } from 'util';
import type { MaintenanceJob } from '../types.js';

const execAsync = promisify(exec);

const MONTH = 30 * 24 * 60 * 60 * 1000;

export const restoreDrillJob: MaintenanceJob = {
  name: 'restore-drill',
  host: 'pa',
  everyMs: MONTH,
  description: 'Monthly restore drill: verify backup integrity by downloading and decrypting the newest secrets backup to a temp directory, validating file formats, and recording duration. Never touches live ~/.pa.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run(ctx) {
    const started = Date.now();
    const { stdout, stderr } = await execAsync(
      'python pa/scripts/run_restore_drill.py --verify-only',
      { cwd: process.cwd() }
    );
    const duration = Date.now() - started;

    // Parse output to determine success/failure
    const success = stdout.includes('✅ Restore drill passed') ||
                    !stderr.includes('Restore drill failed');

    return {
      touched: success ? 1 : 0,
      detail: {
        durationMs: duration,
        output: stdout,
        error: stderr || undefined,
      },
    };
  },
};
