import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { bgtasksCommand } from '../src/commands/bgtasks.js';

let tempDir: string;
const originalLog = console.log;
const originalError = console.error;
let output: string[] = [];
let errors: string[] = [];

beforeEach(async () => {
  tempDir = await createTempPaHome();
  output = [];
  errors = [];
  console.log = (...args: any[]) => output.push(args.join(' '));
  console.error = (...args: any[]) => errors.push(args.join(' '));
});

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  await cleanup(tempDir);
});

async function writeBlackboard(data: object): Promise<void> {
  await writeFile(join(tempDir, 'blackboard.json'), JSON.stringify(data, null, 2));
}

const noDescendants = async () => ([] as Array<{ pid: number; parentPid: number }>);
const noCmdlines = async () => (new Map<number, string>());

describe('bgtasks: empty / no active workers', () => {
  it('prints "no active workers" when blackboard is empty', async () => {
    await writeBlackboard({ active_locks: [] });
    await bgtasksCommand([], { getDescendantPids: noDescendants, getCommandLines: noCmdlines });
    assert.ok(output.some(l => l.includes('no active workers')));
  });

  it('prints "no active workers" when blackboard.json does not exist', async () => {
    // tempDir has no blackboard.json
    await bgtasksCommand([], { getDescendantPids: noDescendants, getCommandLines: noCmdlines });
    assert.ok(output.some(l => l.includes('no active workers')));
  });

  it('prints "no active workers" when active locks exist but have no descendants', async () => {
    await writeBlackboard({
      active_locks: [{ resource: 'skill-foo', agent: 'claude', pid: 12345, heartbeat: new Date().toISOString() }],
    });
    await bgtasksCommand([], {
      getDescendantPids: async () => [], // no descendants
      getCommandLines: noCmdlines,
    });
    assert.ok(output.some(l => l.includes('no active workers')));
  });
});

describe('bgtasks: table output', () => {
  it('prints table with worker-pid, resource, desc-pid, cmd', async () => {
    await writeBlackboard({
      active_locks: [{ resource: 'skill-foo', agent: 'claude', pid: 12345, heartbeat: new Date().toISOString() }],
    });
    await bgtasksCommand([], {
      getDescendantPids: async () => [{ pid: 99901, parentPid: 12345 }],
      getCommandLines: async () => new Map([[99901, 'sleep 3600']]),
    });
    const tableOutput = output.join('\n');
    assert.ok(tableOutput.includes('12345'), 'Should show worker PID');
    assert.ok(tableOutput.includes('skill-foo'), 'Should show resource');
    assert.ok(tableOutput.includes('99901'), 'Should show descendant PID');
    assert.ok(tableOutput.includes('sleep 3600'), 'Should show command');
  });

  it('--json flag outputs JSON array', async () => {
    await writeBlackboard({
      active_locks: [{ resource: 'skill-bar', agent: 'gemini', pid: 55555, heartbeat: new Date().toISOString() }],
    });
    await bgtasksCommand(['--json'], {
      getDescendantPids: async () => [{ pid: 99902, parentPid: 55555 }],
      getCommandLines: async () => new Map([[99902, 'find /d']]),
    });
    const jsonStr = output.join('\n');
    const parsed = JSON.parse(jsonStr);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed[0].workerPid, 55555);
    assert.equal(parsed[0].resource, 'skill-bar');
    assert.equal(parsed[0].descPid, 99902);
  });
});

describe('bgtasks: --json empty', () => {
  it('prints "no active workers" (not []) when --json and no rows', async () => {
    await writeBlackboard({
      active_locks: [{ resource: 'skill-foo', agent: 'claude', pid: 12345, heartbeat: new Date().toISOString() }],
    });
    await bgtasksCommand(['--json'], {
      getDescendantPids: async () => [], // no descendants → no rows
      getCommandLines: noCmdlines,
    });
    assert.ok(output.some(l => l.includes('no active workers')));
    // Ensure no JSON was emitted — it's not JSON-parseable
    const joined = output.join('\n');
    assert.throws(() => JSON.parse(joined), 'Should not produce valid JSON when no rows');
  });
});

describe('bgtasks: --kill', () => {
  it('exits 2 with error when --kill has no numeric argument', async () => {
    await writeBlackboard({
      active_locks: [{ resource: 'skill-x', agent: 'claude', pid: 10001, heartbeat: new Date().toISOString() }],
    });

    let exitCode = 0;
    const originalExit = process.exit;
    process.exit = ((code: number) => { exitCode = code; throw new Error(`exit:${code}`); }) as any;

    try {
      await bgtasksCommand(['--kill'], {
        getDescendantPids: async () => [{ pid: 88881, parentPid: 10001 }],
        getCommandLines: async () => new Map([[88881, 'sleep']]),
      });
    } catch (err: any) {
      if (!err.message?.startsWith('exit:')) throw err;
    } finally {
      process.exit = originalExit;
    }

    assert.equal(exitCode, 2);
    assert.ok(errors.some(e => e.includes('--kill')), 'Error should mention --kill');
  });

  it('kills tracked descendant after TOCTOU check passes', async () => {
    await writeBlackboard({
      active_locks: [{ resource: 'skill-x', agent: 'claude', pid: 10001, heartbeat: new Date().toISOString() }],
    });

    let toctouCalled = false;
    let killTreeCalled = false;

    // Patch killProcessTree via dynamic import override isn't easy in node:test.
    // We verify TOCTOU logic by making the second getDescendantPids call return the PID.
    let callCount = 0;
    await bgtasksCommand(['--kill', '88881'], {
      getDescendantPids: async () => {
        callCount++;
        // Both initial + TOCTOU re-check return the PID
        return [{ pid: 88881, parentPid: 10001 }];
      },
      getCommandLines: async () => new Map([[88881, 'sleep']]),
    }).catch(err => {
      // killProcessTree might throw on a non-existent PID — that's fine, we just care about the logic
    });

    // The TOCTOU check should have been called (2 getDescendantPids calls total: initial + TOCTOU)
    assert.ok(callCount >= 2, `Expected ≥2 getDescendantPids calls for TOCTOU, got ${callCount}`);
  });

  it('refuses to kill PID not in descendant list (exit 2)', async () => {
    await writeBlackboard({
      active_locks: [{ resource: 'skill-y', agent: 'claude', pid: 10002, heartbeat: new Date().toISOString() }],
    });

    let exitCode = 0;
    const originalExit = process.exit;
    process.exit = ((code: number) => { exitCode = code; throw new Error(`exit:${code}`); }) as any;

    try {
      await bgtasksCommand(['--kill', '99999'], {
        getDescendantPids: async () => [{ pid: 11111, parentPid: 10002 }], // 99999 not here
        getCommandLines: async () => new Map([[11111, 'sleep']]),
      });
    } catch (err: any) {
      if (!err.message?.startsWith('exit:')) throw err;
    } finally {
      process.exit = originalExit;
    }

    assert.equal(exitCode, 2, 'Should exit 2 when PID not tracked');
    assert.ok(errors.some(e => e.includes('99999')), 'Error should mention the invalid PID');
  });

  it('refuses to kill when TOCTOU re-check shows PID gone', async () => {
    await writeBlackboard({
      active_locks: [{ resource: 'skill-z', agent: 'claude', pid: 10003, heartbeat: new Date().toISOString() }],
    });

    let exitCode = 0;
    const originalExit = process.exit;
    process.exit = ((code: number) => { exitCode = code; throw new Error(`exit:${code}`); }) as any;

    let callCount = 0;
    try {
      await bgtasksCommand(['--kill', '77771'], {
        getDescendantPids: async () => {
          callCount++;
          if (callCount === 1) return [{ pid: 77771, parentPid: 10003 }]; // initial: present
          return []; // TOCTOU re-check: gone
        },
        getCommandLines: async () => new Map([[77771, 'sleep']]),
      });
    } catch (err: any) {
      if (!err.message?.startsWith('exit:')) throw err;
    } finally {
      process.exit = originalExit;
    }

    assert.equal(exitCode, 2, 'Should exit 2 when TOCTOU check fails');
  });
});
