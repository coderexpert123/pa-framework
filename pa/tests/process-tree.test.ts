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
  getChildPids,
  hasChildProcesses,
} from '../src/process-tree.js';
import type { ExecFn } from '../src/process-tree.js';

const IS_WIN = platform() === 'win32';

// ── ExecFn helpers ────────────────────────────────────────────────────────────

/**
 * Build mock stdout for getDescendantPids. On Windows the function issues a
 * PowerShell Get-CimInstance query and expects JSON (now with CommandLine);
 * on POSIX it runs `ps -eo pid=,ppid=` and expects space-delimited rows.
 */
function descendantOutput(rows: Array<[number, number, string?]>): string {
  if (IS_WIN) {
    return JSON.stringify(
      rows.map(([p, pp, cmd]) => ({ ProcessId: p, ParentProcessId: pp, CommandLine: cmd ?? '' }))
    );
  }
  // POSIX: pid,ppid only (CommandLine not available)
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
    const rows: Array<[number, number, string?]> = IS_WIN
      ? [[1, 0, 'init'], [100, 1, 'parent'], [200, 100, 'child'], [300, 200, 'gc1'], [301, 200, 'gc2'], [999, 1, 'unrelated']]
      : [[1, 0], [100, 1], [200, 100], [300, 200], [301, 200], [999, 1]];
    const result = await getDescendantPids(100, mockExec(descendantOutput(rows)));
    const pids = result.map(r => r.pid).sort((a, b) => a - b);
    assert.deepEqual(pids, [200, 300, 301]);
  });

  it('returns empty array when workerPid has no children', async () => {
    const rows: Array<[number, number, string?]> = IS_WIN
      ? [[1, 0, 'init'], [100, 1, 'parent'], [200, 1, 'sibling']]
      : [[1, 0], [100, 1], [200, 1]];
    const result = await getDescendantPids(999, mockExec(descendantOutput(rows)));
    assert.deepEqual(result, []);
  });

  it('does not revisit already-seen PIDs (cycle safety)', async () => {
    // Pathological: PID 200 appears as child of 100, PID 100 appears as child of 200
    const rows: Array<[number, number, string?]> = IS_WIN
      ? [[100, 200, 'a'], [200, 100, 'b']]
      : [[100, 200], [200, 100]];
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
    const rows: Array<[number, number, string?]> = IS_WIN
      ? [[100, 1, 'parent'], [200, 100, 'child'], [300, 200, 'grandchild']]
      : [[100, 1], [200, 100], [300, 200]];
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

// ── getChildPids / hasChildProcesses (snapshot refactor) ─────────────────────

describe('getChildPids', () => {
  it('returns children from snapshot', async () => {
    // Tree: 100 → 200, 201
    const rows: Array<[number, number, string?]> = IS_WIN
      ? [[1, 0, 'init'], [100, 1, 'parent'], [200, 100, 'child1'], [201, 100, 'child2'], [999, 1, 'unrelated']]
      : [[1, 0], [100, 1], [200, 100], [201, 100], [999, 1]];
    const result = await getChildPids(100, mockExec(descendantOutput(rows)));
    assert.deepEqual(result.sort((a, b) => a - b), [200, 201]);
  });

  it('returns empty array when pid has no children', async () => {
    const rows: Array<[number, number, string?]> = IS_WIN
      ? [[1, 0, 'init'], [100, 1, 'parent'], [200, 1, 'sibling']]
      : [[1, 0], [100, 1], [200, 1]];
    const result = await getChildPids(999, mockExec(descendantOutput(rows)));
    assert.deepEqual(result, []);
  });

  it('bypasses cache when custom execFn is injected', async () => {
    const rows: Array<[number, number, string?]> = IS_WIN
      ? [[100, 1, 'parent'], [200, 100, 'child']]
      : [[100, 1], [200, 100]];
    let callCount = 0;
    const countingExec: ExecFn = async (_cmd) => {
      callCount++;
      return { stdout: descendantOutput(rows), stderr: '' };
    };

    // Two calls with injected execFn should make TWO exec calls (cache bypassed)
    await getChildPids(100, countingExec);
    await getChildPids(100, countingExec);
    assert.equal(callCount, 2, 'injected execFn bypasses cache');
  });
});

describe('hasChildProcesses', () => {
  it('returns true when direct children exist (isShell=false)', async () => {
    // Tree: 100 → 200
    const rows: Array<[number, number, string?]> = IS_WIN
      ? [[1, 0, 'init'], [100, 1, 'parent'], [200, 100, 'child']]
      : [[1, 0], [100, 1], [200, 100]];
    const result = await hasChildProcesses(100, false, mockExec(descendantOutput(rows)));
    assert.equal(result, true);
  });

  it('returns false when no children exist', async () => {
    const rows: Array<[number, number, string?]> = IS_WIN
      ? [[1, 0, 'init'], [100, 1, 'parent']]
      : [[1, 0], [100, 1]];
    const result = await hasChildProcesses(100, false, mockExec(descendantOutput(rows)));
    assert.equal(result, false);
  });

  it('with isShell=true: returns true when grandchildren exist (wrapper→child→grandchild)', async () => {
    // Tree: wrapper(100) → child(200) → grandchild(300)
    const rows: Array<[number, number, string?]> = IS_WIN
      ? [[1, 0, 'init'], [100, 1, 'wrapper'], [200, 100, 'child'], [300, 200, 'grandchild']]
      : [[1, 0], [100, 1], [200, 100], [300, 200]];

    let callCount = 0;
    const countingExec: ExecFn = async (_cmd) => {
      callCount++;
      return { stdout: descendantOutput(rows), stderr: '' };
    };

    const result = await hasChildProcesses(100, true, countingExec);
    assert.equal(result, true, 'should detect grandchildren');
    assert.equal(callCount, 1, 'should issue exactly ONE exec call for three-level check');
  });

  it('with isShell=true: returns false when grandchildren do not exist (wrapper→child only)', async () => {
    // Tree: wrapper(100) → child(200) [no grandchildren]
    const rows: Array<[number, number, string?]> = IS_WIN
      ? [[1, 0, 'init'], [100, 1, 'wrapper'], [200, 100, 'child']]
      : [[1, 0], [100, 1], [200, 100]];

    let callCount = 0;
    const countingExec: ExecFn = async (_cmd) => {
      callCount++;
      return { stdout: descendantOutput(rows), stderr: '' };
    };

    const result = await hasChildProcesses(100, true, countingExec);
    assert.equal(result, false, 'should return false when no grandchildren');
    assert.equal(callCount, 1, 'should issue exactly ONE exec call even when result is false');
  });

  it('bypasses cache when custom execFn is injected', async () => {
    const rows: Array<[number, number, string?]> = IS_WIN
      ? [[100, 1, 'parent'], [200, 100, 'child']]
      : [[100, 1], [200, 100]];
    let callCount = 0;
    const countingExec: ExecFn = async (_cmd) => {
      callCount++;
      return { stdout: descendantOutput(rows), stderr: '' };
    };

    // Two calls with injected execFn should make TWO exec calls (cache bypassed)
    await hasChildProcesses(100, false, countingExec);
    await hasChildProcesses(100, false, countingExec);
    assert.equal(callCount, 2, 'injected execFn bypasses cache');
  });
});
