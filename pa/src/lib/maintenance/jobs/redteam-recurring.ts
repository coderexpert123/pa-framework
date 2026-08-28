import { exec } from 'child_process';
import { join } from 'path';
import { promisify } from 'util';
import { log } from '../../log.js';
import { notifyUser } from '../../notify.js';
import { repoRootFromModule } from '../../git-root.js';
import type { MaintenanceJob } from '../types.js';

const execAsync = promisify(exec);

/** Injectable dependencies for tests (the DI pattern the maintenance jobs use —
 *  ESM module namespaces are read-only, so callers override via deps, not mocks). */
export interface RedteamRecurringDeps {
  execFn?: typeof execAsync;
  repoRootFn?: () => Promise<string>;
}

export async function runRedteamRecurring(deps: RedteamRecurringDeps = {}): Promise<{ touched: number; detail: Record<string, unknown> }> {
  const execDep = deps.execFn ?? execAsync;
  const repoRootDep = deps.repoRootFn ?? (() => repoRootFromModule(__filename));

  // Note: the old expression (`${process.env.PA_HOME ?? process.cwd()}/../../pa/scripts/...`)
  // was wrong even WITH PA_HOME set: it resolves under the PA_HOME parent,
  // not the repo's pa/scripts (2026-08-23 alerts wave).
  const scriptPath = join(await repoRootDep(), 'pa/scripts/redteam_injection.py');

  log('info', 'maintenance', 'Running redteam injection regression test', { scriptPath });

  try {
    const { stdout, stderr } = await execDep(`python "${scriptPath}"`, {
      timeout: 60_000, // 1 minute timeout
      env: { ...process.env },
    });

    // Combine stdout and stderr for logging
    const output = stdout + stderr;

    // Check exit code from output (script prints status)
    if (stdout.includes('❌ REGRESSION') || stdout.includes('Failed:') && !stdout.includes('Failed: 0')) {
      const msg = `🚨 Redteam regression test failed\n\n${output}`;
      log('error', 'maintenance', 'redteam test failed', { output });
      await notifyUser(
        'Redteam Regression Failed',
        msg,
        { dedupKey: 'redteam-regression', severity: 'error' },
      ).catch(() => {});
      return { touched: 1, detail: { status: 'failed', output } };
    }

    log('info', 'maintenance', 'redteam test passed', { output });
    return { touched: 0, detail: { status: 'passed', output } };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const msg = `🚨 Redteam regression test crashed\n\n${errorMsg}`;
    log('error', 'maintenance', 'redteam test crashed', { error: errorMsg });
    await notifyUser(
      'Redteam Regression Crashed',
      msg,
      { dedupKey: 'redteam-regression-crash', severity: 'error' },
    ).catch(() => {});
    return { touched: 1, detail: { status: 'crashed', error: errorMsg } };
  }
}

/** Monthly redteam injection regression test (proposal #13, Wave G). */
export const redteamRecurringJob: MaintenanceJob = {
  name: 'redteam-recurring',
  host: 'pa',
  everyMs: 30 * 24 * 60 * 60 * 1000, // 30 days (monthly)
  description: 'Run prompt-injection redteam regression tests against deterministic defense layers (credential redaction, PA_META protected-skill gate). Pages on failure.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run(ctx) {
    return runRedteamRecurring();
  },
};
