/**
 * Tests for pa/src/process-tree.ts.
 * Uses injected ExecFn to avoid spawning real OS processes for the BFS/query paths.
 * Mock output is platform-aware: Windows branch expects PowerShell JSON;
 * POSIX branch expects space-delimited "pid ppid" rows.
 * areProcessesAlive POSIX path tested via real process.kill(pid, 0) calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { platform } from 'os';
import {
  getDescendantPids,
  getCommandLines,
  areProcessesAlive,
} from '../src/process-tree.js';
import type { ExecFn } from '../src/process-tree.js';

const IS_WIN = platform() === 'win32';

// ── ExecFn helpers ────────────────────────────────────────────────────────────

/**
 * Build mock stdout for getDescendantPids. On Windows the function issues a
 * PowerShell Get-CimInstance query and expects JSON; on POSIX it runs
 * `ps -eo pid=,ppid=` and expects space-delimited rows.
 */
function descendantOutput(rows: Array<[number, number]>): string {
  if (IS_WIN) {
    return JSON.stringify(
      rows.map(([p, pp]) => ({ ProcessId: p, ParentProcessId: pp }))
    );
  }
  return rows.map(([p, pp]) => `${p.toString().padStart(6)} ${pp.toString().padStart(6)}`).join('\n') + '\n';
}

/**
 * Build mock stdout for getCommandLines. On Windows the function issues a
 * PowerShell query and expects JSON; on POSIX it runs `ps -o pid=,command= -p …`
 * and expects space-delimited rows.
 */
function commandLinesOutput(entries: Array<[number, string]>): string {
  if (IS_WIN) {
    return JSON.stringify(
      entries.map(([pid, cmd]) => ({ ProcessId: pid, CommandLine: cmd }))
    );
  }
  return entries.map(([pid, cmd]) => `  ${pid} ${cmd}`).join('\n') + '\n';
}

function mockExec(stdout: string): ExecFn {
  return async (_cmd: string) => ({ stdout, stderr: '' });
}

function failExec(code = 'ENOENT'): ExecFn {
  return async (_cmd: string) => {
    const err: any = new Error('spawn ps ENOENT');
    err.code = code;
    throw err;
  };
}

// ── getDescendantPids ─────────────────────────────────────────────────────────

describe('getDescendantPids', () => {
  it('returns all descendants in a 3-level tree', async () => {
    // Tree: 100 → 200 → 300, 301
    const rows: Array<[number, number]> = [
      [1, 0], [100, 1], [200, 100], [300, 200], [301, 200], [999, 1],
    ];
    const result = await getDescendantPids(100, mockExec(descendantOutput(rows)));
    const pids = result.map(r => r.pid).sort((a, b) => a - b);
    assert.deepEqual(pids, [200, 300, 301]);
  });

  it('returns empty array when workerPid has no children', async () => {
    const rows: Array<[number, number]> = [[1, 0], [100, 1], [200, 1]];
    const result = await getDescendantPids(999, mockExec(descendantOutput(rows)));
    assert.deepEqual(result, []);
  });

  it('does not revisit already-seen PIDs (cycle safety)', async () => {
    // Pathological: PID 200 appears as child of 100, PID 100 appears as child of 200
    const rows: Array<[number, number]> = [[100, 200], [200, 100]];
    const result = await getDescendantPids(100, mockExec(descendantOutput(rows)));
    assert.ok(result.length <= 2, `expected ≤2 results, got ${result.length}`);
  });

  it('returns empty array when ps is not available (ENOENT)', async () => {
    const result = await getDescendantPids(1, failExec('ENOENT'));
    assert.deepEqual(result, []);
  });

  it('returns empty array when ps output is empty', async () => {
    const result = await getDescendantPids(100, mockExec(''));
    assert.deepEqual(result, []);
  });

  it('correctly records parentPid in each result entry', async () => {
    const rows: Array<[number, number]> = [[100, 1], [200, 100], [300, 200]];
    const result = await getDescendantPids(100, mockExec(descendantOutput(rows)));
    const entry200 = result.find(r => r.pid === 200);
    const entry300 = result.find(r => r.pid === 300);
    assert.ok(entry200, '200 should be a descendant');
    assert.equal(entry200!.parentPid, 100);
    assert.ok(entry300, '300 should be a descendant');
    assert.equal(entry300!.parentPid, 200);
  });
});

// ── getCommandLines ───────────────────────────────────────────────────────────

describe('getCommandLines', () => {
  it('parses command output correctly', async () => {
    const entries: Array<[number, string]> = [[123, 'node dist/main.js'], [456, 'python3 run_brief.py']];
    const result = await getCommandLines([123, 456], mockExec(commandLinesOutput(entries)));
    assert.equal(result.get(123), 'node dist/main.js');
    assert.equal(result.get(456), 'python3 run_brief.py');
  });

  it('returns empty map for empty pid list', async () => {
    let called = false;
    const mockFn: ExecFn = async (_cmd) => { called = true; return { stdout: '', stderr: '' }; };
    const result = await getCommandLines([], mockFn);
    assert.equal(result.size, 0);
    assert.equal(called, false, 'should not call exec for empty list');
  });

  it('batches at 50 PIDs per call', async () => {
    const pids = Array.from({ length: 110 }, (_, i) => i + 1);
    let callCount = 0;
    const mockFn: ExecFn = async (_cmd) => { callCount++; return { stdout: '', stderr: '' }; };
    await getCommandLines(pids, mockFn);
    assert.equal(callCount, 3, 'should make 3 calls: 50+50+10');
  });

  it('continues on batch exec failure (partial results)', async () => {
    let callCount = 0;
    const entries: Array<[number, string]> = [[51, 'node worker.js']];
    const mockFn: ExecFn = async (_cmd) => {
      callCount++;
      if (callCount === 1) throw new Error('ps failed');
      return { stdout: commandLinesOutput(entries), stderr: '' };
    };
    const pids = Array.from({ length: 51 }, (_, i) => i + 1);
    const result = await getCommandLines(pids, mockFn);
    // First batch failed (PIDs 1-50 absent), second batch succeeded
    assert.equal(result.get(51), 'node worker.js');
    assert.ok(!result.has(1));
  });
});

// ── areProcessesAlive ─────────────────────────────────────────────────────────

describe('areProcessesAlive', () => {
  it('reports the current process as alive', async () => {
    const result = await areProcessesAlive([process.pid]);
    assert.equal(result.get(process.pid), true);
  });

  it('returns empty map for empty pid list without calling exec', async () => {
    let called = false;
    const mockFn: ExecFn = async (_cmd) => { called = true; return { stdout: '', stderr: '' }; };
    const result = await areProcessesAlive([], mockFn);
    assert.equal(result.size, 0);
    assert.equal(called, false);
  });
});
