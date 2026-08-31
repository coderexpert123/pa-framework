import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { runRestoreDrill } from '../src/lib/maintenance/jobs/restore-drill.js';
import { runRedteamRecurring } from '../src/lib/maintenance/jobs/redteam-recurring.js';

// Task Scheduler launches `pa catchup` with cwd C:\Windows\System32 — any
// cwd-relative path built by a maintenance job silently resolves there
// (2026-08-23 alerts-week-review §5.2: restore-drill accumulated 11,228
// consecutive failures this way). These jobs must instead build an ABSOLUTE
// script path under the module-anchored repo root (never process.cwd()).
//
// git-root.ts's resolveRepoRoot() always emits forward slashes, even on
// Windows — mirrored here so the fake repo root looks like a real one.
const FAKE_REPO_ROOT = 'D:/fake/repo/root';

describe('runRestoreDrill — module-anchored repo root', () => {
  it('builds an absolute script path under the injected repo root and passes cwd: repoRoot', async () => {
    let capturedCmd: string | undefined;
    let capturedOpts: any;
    const result = await runRestoreDrill({
      repoRootFn: async () => FAKE_REPO_ROOT,
      execFn: (async (cmd: string, opts?: any) => {
        capturedCmd = cmd;
        capturedOpts = opts;
        return { stdout: '✅ Restore drill passed', stderr: '' };
      }) as any,
    });

    const expectedScriptPath = join(FAKE_REPO_ROOT, 'pa/scripts/run_restore_drill.py');
    assert.ok(capturedCmd, 'execFn must have been called');
    assert.equal(capturedCmd, `python "${expectedScriptPath}" --verify-only`);
    assert.ok(!capturedCmd!.includes('..'), `command must not contain a relative ".." segment, got: ${capturedCmd}`);
    assert.equal(capturedOpts?.cwd, FAKE_REPO_ROOT, 'exec must run with cwd set to the injected repo root');
    assert.equal(result.touched, 1);
  });
});

describe('runRedteamRecurring — module-anchored repo root', () => {
  it('builds an absolute script path under the injected repo root (no ".." segments)', async () => {
    let capturedCmd: string | undefined;
    const result = await runRedteamRecurring({
      repoRootFn: async () => FAKE_REPO_ROOT,
      execFn: (async (cmd: string) => {
        capturedCmd = cmd;
        return { stdout: 'Failed: 0', stderr: '' };
      }) as any,
    });

    const expectedScriptPath = join(FAKE_REPO_ROOT, 'pa/scripts/redteam_injection.py');
    assert.ok(capturedCmd, 'execFn must have been called');
    assert.equal(capturedCmd, `python "${expectedScriptPath}"`);
    assert.ok(!capturedCmd!.includes('..'), `command must not contain a relative ".." segment, got: ${capturedCmd}`);
    // Unlike restore-drill, redteam-recurring's exec call was not given a cwd
    // option by the spec's WP-A step 6 (only the scriptPath computation and
    // the repoRootFn DI seam were in scope) — so no cwd assertion here.
    assert.equal(result.touched, 0);
  });
});
