/**
 * Real-process integration tests for killProcessTree's POSIX branch.
 * POSIX-only (process groups / setsid semantics don't exist on Windows,
 * where killProcessTree uses `taskkill /T /F` instead — see process-tree.ts)
 * — self-skips with a reason on win32 rather than asserting anything.
 *
 * Root cause under test: workers are spawned with shell:true and (before
 * this phase) no `detached`, so they are never process-group leaders.
 * `process.kill(-pid, ...)` (negative pid = process group) then throws
 * ESRCH/EPERM instead of killing anything, and the old code swallowed that
 * silently — /stop, /steer, idle-kill, and orphan-reap were all silently
 * broken for any worker whose spawn wasn't detached on Linux/macOS.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { killProcessTree } from '../src/process-tree.js';

const IS_WIN = process.platform === 'win32';
const SKIP_REASON = IS_WIN && 'POSIX-only — Windows uses taskkill /T /F, not process groups';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code !== 'ESRCH'; // ESRCH = dead; EPERM = alive but not ours (shouldn't happen for our own children)
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function waitForPidFile(path: string, timeoutMs = 5000): Promise<number> {
  const ok = await waitUntil(() => existsSync(path) && readFileSync(path, 'utf8').trim().length > 0, timeoutMs);
  if (!ok) throw new Error(`pidfile never appeared: ${path}`);
  return parseInt(readFileSync(path, 'utf8').trim(), 10);
}

/**
 * Spawns a parent shell that backgrounds a `sleep` grandchild, writes the
 * grandchild's PID to `pidFile`, then waits on it — both processes stay
 * alive until killed or the 100s sleep elapses. When `detached` is true the
 * shell (and everything it spawns without its own setsid) becomes its own
 * process group, exercising killProcessTree's group-kill path. When false,
 * the shell shares this test process's group, so `process.kill(-pid, ...)`
 * targets a nonexistent group and throws, forcing the descendant-walk fallback.
 */
function spawnParentWithGrandchild(pidFile: string, detached: boolean): ChildProcess {
  const script = 'sleep 100 & echo $! > "$1"; wait';
  return spawn('sh', ['-c', script, 'proctest', pidFile], { detached, stdio: 'ignore' });
}

let scratchDir: string;
let spawnedPids: number[] = [];

beforeEach(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), 'pa-test-proctree-kill-'));
  spawnedPids = [];
});

afterEach(async () => {
  // Best-effort cleanup in case an assertion failed before the tree was killed.
  for (const pid of spawnedPids) {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  await rm(scratchDir, { recursive: true, force: true });
});

describe('killProcessTree (POSIX process-group semantics)', () => {
  it('detached parent + grandchild: group-kill path terminates both', { skip: SKIP_REASON }, async () => {
    const pidFile = join(scratchDir, 'grandchild.pid');
    const parent = spawnParentWithGrandchild(pidFile, true);
    assert.ok(parent.pid, 'parent should have a pid');
    spawnedPids.push(parent.pid!);

    const grandchildPid = await waitForPidFile(pidFile);
    assert.ok(isAlive(parent.pid!), 'parent should be alive before kill');
    assert.ok(isAlive(grandchildPid), 'grandchild should be alive before kill');

    killProcessTree(parent.pid!);

    assert.ok(await waitUntil(() => !isAlive(parent.pid!)), 'parent should be dead after killProcessTree (group kill)');
    assert.ok(await waitUntil(() => !isAlive(grandchildPid)), 'grandchild should be dead after killProcessTree (group kill)');
  });

  it('non-detached parent: group-kill throws, falls back to descendant walk', { skip: SKIP_REASON }, async () => {
    const pidFile = join(scratchDir, 'grandchild.pid');
    const parent = spawnParentWithGrandchild(pidFile, false);
    assert.ok(parent.pid, 'parent should have a pid');
    spawnedPids.push(parent.pid!);

    const grandchildPid = await waitForPidFile(pidFile);
    assert.ok(isAlive(parent.pid!), 'parent should be alive before kill');
    assert.ok(isAlive(grandchildPid), 'grandchild should be alive before kill');

    killProcessTree(parent.pid!);

    assert.ok(await waitUntil(() => !isAlive(parent.pid!)), 'parent should be dead after killProcessTree (fallback walk)');
    assert.ok(await waitUntil(() => !isAlive(grandchildPid)), 'grandchild should be dead after killProcessTree (fallback walk)');
  });
});
