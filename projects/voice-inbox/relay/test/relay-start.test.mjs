/**
 * relay-start.test.mjs — behavioral harness for scripts/relay_start.ps1
 * (relay-poller pile-up fix, 2026-09-10). See this project's CLAUDE.md
 * "Known gap" note (now corrected to "fixed") for the diagnosed mechanism:
 * relay_start.ps1's Start-Process was fire-and-forget (no -Wait), so the
 * window between "a poller is starting" and "a poller holds the lock" was
 * open for as long as node's own cold start took — a slow cold start let the
 * NEXT launch see no lock yet and start a second poller.
 *
 * relay_start.ps1 is a static .ps1 file, not a JS function like
 * relay_setup.mjs's buildRelayPollerLauncherVbs — there is no pure seam to
 * unit-test, so this runs the REAL script twice via a temp PA_HOME and a
 * fake "scripts/relay_poller.mjs" stand-in (a tiny script that just marks
 * that it started, then sleeps — simulating a slow/never-registering cold
 * start within the test's observation window) and counts how many actually
 * started. Windows-only: relay_start.ps1 is a PowerShell launcher (this
 * package is not in the public CI matrix — checked .github/workflows/ci.yml
 * — so a Windows-only real-process test here does not cost cross-platform
 * coverage).
 *
 * Machine rule: this file is plain .mjs registered as a real node:test suite
 * (the dark-file detector fails a zero-test file) — see § Node tests in
 * ~/.claude/machine-notes.md and the repo's scoped-run convention
 * (`PA_BUILD_LOCK=0 npm test -- relay-start.test.mjs`).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY_START_PS1 = fileURLToPath(new URL('../../scripts/relay_start.ps1', import.meta.url));
const isWindows = process.platform === 'win32';

// The fake poller sleeps far longer than two sequential launcher invocations
// take, so both invocations are guaranteed to observe the same "still cold
// starting" state today's code fails on.
const SLEEP_MS = 5000;

function fakePollerSource(markerDir) {
  return [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    `writeFileSync(join(${JSON.stringify(markerDir)}, process.pid + '.alive'), '');`,
    `setTimeout(() => process.exit(0), ${SLEEP_MS});`,
    '',
  ].join('\n');
}

function setupProjectDir(markerDir) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-start-proj-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'relay_poller.mjs'), fakePollerSource(markerDir), 'utf8');
  return dir;
}

function setupPaHome() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-start-pahome-'));
  writeFileSync(join(dir, 'secrets.env'), 'VOICE_INBOX_RELAY_SECRET=test-secret\n', 'utf8');
  return dir;
}

// relay_start.ps1 launches node with -WorkingDirectory projectDir, so a fake
// poller still sleeping pins projectDir as its cwd — Windows refuses to
// rmdir a directory that is a live process's cwd. Kill exactly the PIDs this
// test itself observed starting (read back from their own marker filename,
// never by image name) so cleanup does not have to wait out the full sleep.
function killMarkedPollers(markerDir) {
  let markers = [];
  try {
    markers = readdirSync(markerDir).filter((f) => f.endsWith('.alive'));
  } catch {
    return;
  }
  for (const m of markers) {
    const pid = parseInt(m, 10);
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid);
      } catch {
        // already gone — fine
      }
    }
  }
}

// rmSync can still race the OS releasing the handle right after a kill —
// retry briefly rather than failing the test on that unrelated timing.
async function rmSyncWithRetry(path, attempts = 10, delayMs = 200) {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// Runs relay_start.ps1 once to completion (the launcher itself always
// returns almost immediately — Start-Process is fire-and-forget — so
// awaiting this resolves before the spawned node has necessarily done
// anything, which is exactly the race window under test).
function runLauncher(projectDir, paHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RELAY_START_PS1, '-ProjectDir', projectDir],
      { env: { ...process.env, PA_HOME: paHome }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
}

test(
  'relay_start.ps1: a second launch right after the first does not pile up a second poller',
  { skip: isWindows ? false : 'Windows-only PowerShell launcher' },
  async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'relay-start-markers-'));
    const projectDir = setupProjectDir(markerDir);
    const paHome = setupPaHome();
    try {
      // Sequential, not concurrent: each launcher invocation itself returns
      // almost instantly (Start-Process is fire-and-forget), so awaiting the
      // first before firing the second is the faithful analogue of two
      // consecutive scheduler ticks — the fake poller from the first launch
      // is still "cold starting" (sleeping, having registered nothing of its
      // own) when the second launch's pre-check runs.
      const first = await runLauncher(projectDir, paHome);
      assert.equal(first.code, 0, `first launch failed: ${first.stderr}`);
      const second = await runLauncher(projectDir, paHome);
      assert.equal(second.code, 0, `second launch failed: ${second.stderr}`);

      // Give the freshly-spawned node process(es) a brief moment to execute
      // their first line and write their marker file.
      await new Promise((r) => setTimeout(r, 500));
      const started = readdirSync(markerDir).filter((f) => f.endsWith('.alive'));
      assert.equal(
        started.length,
        1,
        `expected exactly one poller to have started, found ${started.length}: ${started.join(', ')}`
      );
    } finally {
      killMarkedPollers(markerDir);
      await rmSyncWithRetry(projectDir);
      rmSync(paHome, { recursive: true, force: true });
      rmSync(markerDir, { recursive: true, force: true });
    }
  }
);
