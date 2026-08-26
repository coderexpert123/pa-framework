import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { executeWorker, selectKillTargets } from '../src/workers.js';
import { isProcessAlive } from '../src/worker-pids.js';
import type { WorkerConfig } from '../src/types.js';

describe('selectKillTargets (pure)', () => {
  it('root alive + descendants alive: all returned, root-first', () => {
    const alive = (pid: number) => [1, 2, 3].includes(pid);
    assert.deepEqual(selectKillTargets(1, [2, 3], alive), [1, 2, 3]);
  });

  it('root dead, descendant alive: descendant still returned (the actual AI-112 bug)', () => {
    const alive = (pid: number) => pid === 2;
    assert.deepEqual(selectKillTargets(1, [2], alive), [2]);
  });

  it('all dead: empty array', () => {
    const alive = () => false;
    assert.deepEqual(selectKillTargets(1, [2, 3], alive), []);
  });

  it('undefined root: empty array regardless of descendants', () => {
    const alive = () => true;
    assert.deepEqual(selectKillTargets(undefined, [2, 3], alive), []);
  });

  it('dedupes root/descendant overlap', () => {
    const alive = () => true;
    assert.deepEqual(selectKillTargets(1, [1, 2, 2], alive), [1, 2]);
  });
});

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  await createTempSecrets(tempDir, '');
  scriptDir = join(tmpdir(), `pa-kill-tree-${Date.now()}`);
  await mkdir(scriptDir, { recursive: true });
});

afterEach(async () => {
  await cleanup(tempDir);
  const { rm } = await import('fs/promises');
  try { await rm(scriptDir, { recursive: true, force: true }); } catch {}
});

async function writeScript(name: string, code: string): Promise<string> {
  const path = join(scriptDir, name);
  await writeFile(path, code, 'utf8');
  return path;
}

function makeWorker(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    name: 'kill-tree-worker',
    command: 'node',
    args: ['{prompt}'],
    check: 'echo ok',
    rate_limit_patterns: [],
    priority: 1,
    input_mode: 'arg',
    check_timeout: 5,
    ...overrides,
  };
}

describe('AI-112: kill reaches tracked descendants, not just the wrapper', { concurrency: false }, () => {
  it('idle-timeout kill terminates a real detached "CLI child" the wrapper never directly owns', async () => {
    // Stand-in for the real CLI child that outlived its wrapper (2026-07-04
    // failure mode this whole registry exists for): a genuinely separate OS
    // process, not a child of the worker wrapper we're about to spawn.
    const standIn = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(standIn.pid && isProcessAlive(standIn.pid), 'stand-in must be running before the dispatch starts');

      // The wrapper itself: a real node process that produces no output and
      // has no real OS children, so it hits the idle-timeout kill path
      // deterministically (no stateDir → only the process-tree check runs,
      // and this process has none) rather than needing the evaluator.
      const script = await writeScript('hang.js', 'setInterval(() => {}, 1000);');
      const worker = makeWorker({ args: [script] });

      const result = await executeWorker(worker, '', {
        timeout: 10,
        idleTimeout: 0.5, // 500ms
        resource: `kill-tree-${process.pid}`,
        _bgTaskHooks: {
          heartbeatIntervalMs: 50, // several ticks land before the 500ms idle timeout
          getDescendantPids: async () => (standIn.pid ? [{ pid: standIn.pid, parentPid: 0 }] : []),
          getCommandLines: async (pids) => new Map(pids.map((p) => [p, 'stand-in'])),
          areProcessesAlive: async (pids) => new Map(pids.map((p) => [p, false])),
          notifyUser: async () => ({ sent: true, suppressed: false }),
        },
      });

      assert.equal(result.success, false, 'idle-timeout kill must report failure');
      assert.match(result.error ?? '', /idle timeout/);

      // killProcessTree is fire-and-forget — poll until the stand-in actually dies.
      // On pre-fix code this poll exhausts the deadline: the kill helpers only
      // ever touched child.pid (the wrapper), never bgTaskMap's tracked pids.
      const deadline = Date.now() + 5000;
      while (isProcessAlive(standIn.pid!) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(isProcessAlive(standIn.pid!), false, 'tracked descendant must be killed, not just the wrapper');
    } finally {
      try { standIn.kill('SIGKILL'); } catch { /* already dead — expected */ }
    }
  });
});
