import { exec } from 'child_process';
import { join } from 'path';
import { promisify } from 'util';
import { repoRootFromModule } from '../../git-root.js';
import type { MaintenanceJob } from '../types.js';

const execAsync = promisify(exec);

const MONTH = 30 * 24 * 60 * 60 * 1000;

/** Injectable dependencies for tests (the DI pattern the maintenance jobs use —
 *  ESM module namespaces are read-only, so callers override via deps, not mocks). */
export interface RestoreDrillDeps {
  execFn?: typeof execAsync;
  repoRootFn?: () => Promise<string>;
}

export async function runRestoreDrill(deps: RestoreDrillDeps = {}): Promise<{ touched: number; detail: Record<string, unknown> }> {
  const execDep = deps.execFn ?? execAsync;
  const repoRootDep = deps.repoRootFn ?? (() => repoRootFromModule(__filename));

  const started = Date.now();
  const repoRoot = await repoRootDep();
  const { stdout, stderr } = await execDep(
    `python "${join(repoRoot, 'pa/scripts/run_restore_drill.py')}" --verify-only`,
    { cwd: repoRoot }
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
}

export const restoreDrillJob: MaintenanceJob = {
  name: 'restore-drill',
  host: 'pa',
  everyMs: MONTH,
  description: 'Monthly restore drill: verify backup integrity by downloading and decrypting the newest secrets backup to a temp directory, validating file formats, and recording duration. Never touches live ~/.pa.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run(ctx) {
    return runRestoreDrill();
  },
};
