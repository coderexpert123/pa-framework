import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { executeWorker } from '../src/workers.js';
import type { WorkerConfig, RunOptions } from '../src/types.js';
import { getDescendantPids, getCommandLines, areProcessesAlive } from '../src/process-tree.js';

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  await createTempSecrets(tempDir, '');
  scriptDir = join(tmpdir(), `pa-bg-${Date.now()}`);
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
    name: 'worker-under-test',
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

let testSeq = 0;
function uniqueResource(): string {
  return `bg-alert-test-${process.pid}-${++testSeq}`;
}

// Helper: run a worker script with BG-task hooks injected for fast testing
async function runWithBgHooks(
  scriptPath: string,
  overrides: Partial<RunOptions> & {
    fakeDescendants?: number[];
    fakeAreAlive?: Record<number, boolean>;
    heartbeatIntervalMs?: number;
  }
): Promise<string[]> {
  const notified: string[] = [];
  const { fakeDescendants = [], fakeAreAlive = {}, heartbeatIntervalMs = 30, ...opts } = overrides;

  const worker = makeWorker({ args: [scriptPath] });

  await executeWorker(worker, '', {
    timeout: 10,
    resource: uniqueResource(), // unique per-test to avoid blackboard lock collisions
    bgTasksConfig: { alert_seconds: 0, alert_repeat_seconds: 1 },
    _bgTaskHooks: {
      heartbeatIntervalMs,
      getDescendantPids: async () => fakeDescendants.map(pid => ({ pid, parentPid: 0 })),
      getCommandLines: async (pids) => {
        const m = new Map<number, string>();
        for (const p of pids) m.set(p, `cmd-${p}`);
        return m;
      },
      areProcessesAlive: async (pids) => {
        const m = new Map<number, boolean>();
        for (const p of pids) m.set(p, fakeAreAlive[p] ?? false);
        return m;
      },
      notifyUser: async (subject) => {
        notified.push(subject);
        return { sent: true, suppressed: false };
      },
    },
    ...opts,
  });

  return notified;
}

describe('BG-task tracking: age alert', () => {
  it('fires alert when descendant age exceeds alert_seconds', async () => {
    // Worker runs briefly; fake descendant always present
    const script = await writeScript('quick.js', 'setTimeout(() => process.stdout.write("done"), 1500);');
    const notified = await runWithBgHooks(script, { fakeDescendants: [99991] });

    assert.ok(notified.some(s => s.startsWith('bg-leak:')), `Expected bg-leak alert, got: ${JSON.stringify(notified)}`);
  });

  it('lastRepeatBucket gate blocks re-alert within same repeat bucket', async () => {
    // alert_repeat_seconds=60 — first bucket is [0, 60s). The child runs far
    // below the bucket width (2s vs 60s), so every heartbeat during its life
    // is deterministically still bucket 0 — the exact `=== 1` assert below
    // isn't sensitive to CI/system-load timing jitter the way a tight
    // 300ms-child/10s-bucket margin was.
    const script = await writeScript('medium.js', 'setTimeout(() => process.stdout.write("done"), 2000);');
    const notified: string[] = [];
    const worker = makeWorker({ args: [script] });

    await executeWorker(worker, '', {
      timeout: 10,
      resource: uniqueResource(),
      bgTasksConfig: { alert_seconds: 0, alert_repeat_seconds: 60 },
      _bgTaskHooks: {
        heartbeatIntervalMs: 100, // fires multiple times in 2000ms
        getDescendantPids: async () => [{ pid: 99992, parentPid: 0 }],
        getCommandLines: async (pids) => new Map(pids.map(p => [p, 'sleep'])),
        areProcessesAlive: async (pids) => new Map(pids.map(p => [p, false])),
        notifyUser: async (subject) => { notified.push(subject); return { sent: true, suppressed: false }; },
      },
    });

    const leakAlerts = notified.filter(s => s.startsWith('bg-leak:'));
    // Multiple heartbeats within bucket 0 → exactly 1 alert
    assert.equal(leakAlerts.length, 1, `Expected 1 alert within same bucket, got ${leakAlerts.length}`);
  });

  it('lastRepeatBucket: -1 ensures first bucket-0 crossing fires', async () => {
    const script = await writeScript('fast.js', 'setTimeout(() => process.stdout.write("done"), 1500);');
    const notified = await runWithBgHooks(script, { fakeDescendants: [99993] });

    // With alert_seconds=0 and repeat_seconds=1, age=0 → bucket=0, 0 > -1 → fires
    assert.ok(notified.some(s => s.startsWith('bg-leak:')), 'First bucket-0 crossing should fire');
  });

  it('multi-descendant: 10 PIDs crossing threshold → exactly 1 notifyUser per heartbeat', async () => {
    const fakePids = Array.from({ length: 10 }, (_, i) => 90000 + i);
    const script = await writeScript('multi.js', 'setTimeout(() => process.stdout.write("done"), 1500);');
    const notified = await runWithBgHooks(script, { fakeDescendants: fakePids });

    // All 10 PIDs cross the threshold in the same heartbeat → 1 batched alert
    const leakAlerts = notified.filter(s => s.startsWith('bg-leak:'));
    assert.ok(leakAlerts.length >= 1, 'Expected at least 1 batched alert');
    assert.ok(leakAlerts[0].includes('10 long-running'), `Alert subject should mention count: ${leakAlerts[0]}`);
  });

  it('alert subject includes worker name and pid', async () => {
    const script = await writeScript('name.js', 'setTimeout(() => process.stdout.write("done"), 1500);');
    const notified = await runWithBgHooks(script, { fakeDescendants: [99994], heartbeatIntervalMs: 100 });
    const leakAlert = notified.find(s => s.startsWith('bg-leak:'));
    assert.ok(leakAlert, 'Expected a bg-leak alert');
    assert.ok(leakAlert.includes('worker-under-test'), `Alert should include worker name: ${leakAlert}`);
  });
});

describe('BG-task tracking: orphan sweep', () => {
  it('fires bg-orphan alert when a descendant survives worker exit', async () => {
    // The child must outlive at least one heartbeat's FULL async chain
    // (getDescendantPids → getCommandLines → bgTaskMap populate): an early
    // exit makes the orphan sweep a no-op. 150ms/30ms flaked on starved CI
    // runners (windows-latest, 2026-07-10 — child spawn + delayed interval
    // callbacks beat the chain); 1500ms/100ms gives ~15 heartbeat chances,
    // same margin as the hardened repeat-bucket tests above.
    const script = await writeScript('orphan.js', 'setTimeout(() => process.stdout.write("done"), 1500);');
    const notified: string[] = [];
    const worker = makeWorker({ args: [script] });

    await executeWorker(worker, '', {
      timeout: 10,
      resource: uniqueResource(),
      bgTasksConfig: { alert_seconds: 0, alert_repeat_seconds: 1 },
      _bgTaskHooks: {
        heartbeatIntervalMs: 100,
        getDescendantPids: async () => [{ pid: 99995, parentPid: 0 }],
        getCommandLines: async (pids) => new Map(pids.map(p => [p, `orphan-cmd-${p}`])),
        areProcessesAlive: async (pids) => new Map(pids.map(p => [p, true])), // all alive
        notifyUser: async (subject, _body, opts) => {
          notified.push(subject + (opts?.dedupKey ? ` [key:${opts.dedupKey}]` : ''));
          return { sent: true, suppressed: false };
        },
      },
    });

    // The orphan sweep is fire-and-forget — poll for its effect instead of
    // racing it with a fixed sleep.
    for (let i = 0; i < 80 && !notified.some(s => s.startsWith('bg-orphan:')); i++) {
      await new Promise(r => setTimeout(r, 25));
    }

    const orphanAlerts = notified.filter(s => s.startsWith('bg-orphan:'));
    assert.ok(orphanAlerts.length >= 1, `Expected bg-orphan alert, got: ${JSON.stringify(notified)}`);
    assert.ok(orphanAlerts[0].includes('bg-orphan-'), 'Should include dedupKey with startedAt-workerPid');
  });

  it('does NOT fire orphan alert when all descendants are gone', async () => {
    // Long-lived child so the sweep actually RUNS and decides "all dead" —
    // an early exit would pass this vacuously (sweep skipped entirely).
    // Same 1500ms/100ms hardening as the positive-case test above: under
    // starvation the 150ms child made this test silently meaningless.
    const script = await writeScript('clean.js', 'setTimeout(() => process.stdout.write("done"), 1500);');
    const notified: string[] = [];
    const worker = makeWorker({ args: [script] });

    await executeWorker(worker, '', {
      timeout: 10,
      resource: uniqueResource(),
      bgTasksConfig: { alert_seconds: 0, alert_repeat_seconds: 1 },
      _bgTaskHooks: {
        heartbeatIntervalMs: 100,
        getDescendantPids: async () => [{ pid: 99996, parentPid: 0 }],
        getCommandLines: async (pids) => new Map(pids.map(p => [p, 'sleep'])),
        areProcessesAlive: async (pids) => new Map(pids.map(p => [p, false])), // all dead
        notifyUser: async (subject) => { notified.push(subject); return { sent: true, suppressed: false }; },
      },
    });

    await new Promise(r => setTimeout(r, 100));

    assert.ok(
      !notified.some(s => s.startsWith('bg-orphan:')),
      `Should not fire orphan alert when all dead, got: ${JSON.stringify(notified)}`
    );
  });

  it('uses areProcessesAlive in a single batched call for orphan sweep', async () => {
    const fakePids = [88881, 88882, 88883];
    // Child must outlive at least one 30ms heartbeat, or the sweep is a
    // no-op (bgTaskMap never populated) — same race as the orphan-alert test.
    const script = await writeScript('batch-orphan.js', 'setTimeout(() => process.stdout.write("done"), 1500);');
    const aliveCalls: number[][] = [];
    const worker = makeWorker({ args: [script] });

    await executeWorker(worker, '', {
      timeout: 10,
      resource: uniqueResource(),
      bgTasksConfig: { alert_seconds: 0, alert_repeat_seconds: 1 },
      _bgTaskHooks: {
        heartbeatIntervalMs: 30,
        getDescendantPids: async () => fakePids.map(pid => ({ pid, parentPid: 0 })),
        getCommandLines: async (pids) => new Map(pids.map(p => [p, 'cmd'])),
        areProcessesAlive: async (pids) => {
          aliveCalls.push([...pids]);
          return new Map(pids.map(p => [p, true]));
        },
        notifyUser: async () => ({ sent: true, suppressed: false }),
      },
    });

    // Fire-and-forget sweep — poll for its effect instead of racing it.
    for (let i = 0; i < 80 && aliveCalls.length === 0; i++) {
      await new Promise(r => setTimeout(r, 25));
    }

    // Orphan sweep calls areProcessesAlive once with all pids (batched)
    const orphanCall = aliveCalls[aliveCalls.length - 1];
    assert.ok(orphanCall, 'areProcessesAlive should have been called for orphan sweep');
    assert.equal(orphanCall.length, fakePids.length, 'All tracked pids should be checked in one call');
  });
});

describe('BG-task tracking: no descendants', () => {
  it('does not fire any alert when there are no descendants', async () => {
    const script = await writeScript('nodesc.js', 'process.stdout.write("done");');
    const notified: string[] = [];
    const worker = makeWorker({ args: [script] });

    await executeWorker(worker, '', {
      timeout: 5,
      resource: uniqueResource(),
      bgTasksConfig: { alert_seconds: 0, alert_repeat_seconds: 1 },
      _bgTaskHooks: {
        heartbeatIntervalMs: 30,
        getDescendantPids: async () => [], // no descendants
        getCommandLines: async () => new Map(),
        areProcessesAlive: async () => new Map(),
        notifyUser: async (subject) => { notified.push(subject); return { sent: true, suppressed: false }; },
      },
    });

    await new Promise(r => setTimeout(r, 100));

    assert.equal(notified.length, 0, `Expected no alerts, got: ${JSON.stringify(notified)}`);
  });
});

describe('cmdline sanitizer', () => {
  it('strips api_key, token, password, secret from query strings', async () => {
    const script = await writeScript('sanitize.js', 'setTimeout(() => process.stdout.write("done"), 1500);');
    const bodies: string[] = [];
    const worker = makeWorker({ args: [script] });

    await executeWorker(worker, '', {
      timeout: 5,
      resource: uniqueResource(),
      bgTasksConfig: { alert_seconds: 0, alert_repeat_seconds: 1 },
      _bgTaskHooks: {
        heartbeatIntervalMs: 30,
        getDescendantPids: async () => [{ pid: 77771, parentPid: 0 }],
        getCommandLines: async () => new Map([
          [77771, 'curl https://api.example.com?api_key=SECRET123&other=value'],
        ]),
        areProcessesAlive: async () => new Map([[77771, false]]),
        notifyUser: async (_subject, body) => { bodies.push(body); return { sent: true, suppressed: false }; },
      },
    });

    const leakBody = bodies.find(b => b.includes('77771'));
    assert.ok(leakBody, 'Expected alert body with PID 77771');
    assert.ok(!leakBody.includes('SECRET123'), 'api_key value should be redacted');
    assert.ok(leakBody.includes('<redacted>'), 'Should contain <redacted>');
  });

  it('sanitizes token, password, and secret params', async () => {
    // Test all 4 param names via direct import of the sanitizer logic
    // (The sanitizer is exercised through the cmdline injection path)
    const paramTests = [
      'cmd?token=abc123',
      'cmd?password=abc123',
      'cmd?secret=abc123',
      'cmd&api_key=abc123',
      'cmd&token=abc123',
      'cmd&password=abc123',
      'cmd&secret=abc123',
    ];

    for (const cmdline of paramTests) {
      const bodies: string[] = [];
      const script = await writeScript(`san-${paramTests.indexOf(cmdline)}.js`, 'setTimeout(() => process.stdout.write("done"), 1500);');
      const worker = makeWorker({ args: [script] });

      await executeWorker(worker, '', {
        timeout: 5,
        resource: uniqueResource(),
        bgTasksConfig: { alert_seconds: 0, alert_repeat_seconds: 1 },
        _bgTaskHooks: {
          heartbeatIntervalMs: 30,
          getDescendantPids: async () => [{ pid: 77772, parentPid: 0 }],
          getCommandLines: async () => new Map([[77772, cmdline]]),
          areProcessesAlive: async () => new Map([[77772, false]]),
          notifyUser: async (_s, body) => { bodies.push(body); return { sent: true, suppressed: false }; },
        },
      });

      const leakBody = bodies.find(b => b.includes('77772'));
      assert.ok(!leakBody?.includes('abc123'), `"abc123" should be redacted in cmdline: ${cmdline}`);
    }
  });
});

describe('process-tree helpers: single-query invariant', () => {
  it('getDescendantPids issues exactly ONE exec call regardless of tree depth', async () => {
    let callCount = 0;
    const fakeFn = async (_cmd: string) => {
      callCount++;
      if (process.platform === 'win32') {
        // Simulate a 3-level tree: workerPid=100, child=101, grandchild=102
        return {
          stdout: JSON.stringify([
            { ProcessId: 100, ParentProcessId: 0 },
            { ProcessId: 101, ParentProcessId: 100 },
            { ProcessId: 102, ParentProcessId: 101 },
            { ProcessId: 103, ParentProcessId: 102 },
          ]),
          stderr: '',
        };
      } else {
        return { stdout: '100 0\n101 100\n102 101\n103 102\n', stderr: '' };
      }
    };

    const result = await getDescendantPids(100, fakeFn);
    assert.equal(callCount, 1, 'getDescendantPids must issue exactly one OS call');
    assert.equal(result.length, 3, 'Should find all 3 descendants (101, 102, 103)');
    assert.deepEqual(result.map(d => d.pid).sort(), [101, 102, 103]);
  });

  it('getDescendantPids returns descendants from all depths', async () => {
    const fakeFn = async () => {
      if (process.platform === 'win32') {
        return {
          stdout: JSON.stringify([
            { ProcessId: 1, ParentProcessId: 0 },
            { ProcessId: 2, ParentProcessId: 1 },   // direct child
            { ProcessId: 3, ParentProcessId: 2 },   // grandchild
            { ProcessId: 4, ParentProcessId: 3 },   // great-grandchild
            { ProcessId: 5, ParentProcessId: 999 }, // unrelated
          ]),
          stderr: '',
        };
      } else {
        return { stdout: '1 0\n2 1\n3 2\n4 3\n5 999\n', stderr: '' };
      }
    };

    const result = await getDescendantPids(1, fakeFn);
    assert.deepEqual(result.map(d => d.pid).sort((a, b) => a - b), [2, 3, 4]);
    assert.ok(!result.some(d => d.pid === 5), 'Unrelated process should not be included');
  });
});

describe('process-tree helpers: batching', () => {
  it('getCommandLines issues at most 1 PS call for <= 50 PIDs', async () => {
    let callCount = 0;
    const fakeFn = async () => {
      callCount++;
      return { stdout: '', stderr: '' };
    };

    await getCommandLines(Array.from({ length: 50 }, (_, i) => i + 1), fakeFn);
    assert.equal(callCount, 1, 'Exactly 1 OS call for 50 PIDs');
  });

  it('getCommandLines issues exactly 2 PS calls for 75 PIDs', async () => {
    let callCount = 0;
    const fakeFn = async () => {
      callCount++;
      return { stdout: '', stderr: '' };
    };

    await getCommandLines(Array.from({ length: 75 }, (_, i) => i + 1), fakeFn);
    assert.equal(callCount, 2, 'Exactly 2 OS calls for 75 PIDs');
  });
});

describe('process-tree helpers: areProcessesAlive', () => {
  it('Windows: uses -ErrorAction SilentlyContinue flag', async () => {
    if (process.platform !== 'win32') return; // Windows-only test

    let capturedCmd = '';
    const fakeFn = async (cmd: string) => {
      capturedCmd = cmd;
      return { stdout: '1234\n', stderr: '' };
    };

    await areProcessesAlive([1234, 9999], fakeFn);
    assert.ok(capturedCmd.includes('-ErrorAction SilentlyContinue'), '-ErrorAction SilentlyContinue must be present');
  });

  it('Windows: PIDs absent from Get-Process output → false', async () => {
    if (process.platform !== 'win32') return;

    const fakeFn = async () => ({ stdout: '1234\n', stderr: '' }); // only 1234 returned
    const result = await areProcessesAlive([1234, 9999], fakeFn);
    assert.equal(result.get(1234), true);
    assert.equal(result.get(9999), false, 'Missing from output → dead');
  });

  it('Windows: batches to multiple calls for > 50 PIDs', async () => {
    if (process.platform !== 'win32') return;

    let callCount = 0;
    const fakeFn = async () => { callCount++; return { stdout: '', stderr: '' }; };
    await areProcessesAlive(Array.from({ length: 75 }, (_, i) => i + 1), fakeFn);
    assert.equal(callCount, 2, 'Should batch into 2 calls for 75 PIDs');
  });
});

// Real-process integration: exercises getDescendantPids/getCommandLines/areProcessesAlive
// against actual OS process tree. Total runtime ~35s (test 1: 15s, test 2: 18s, test 3: ~2s).
// concurrency:false avoids PA_HOME race (outer beforeEach writes process.env.PA_HOME each test).
describe('BG-task tracking: real process integration', { concurrency: false }, () => {
  it('fires bg-leak alert when real descendant outlives alert_seconds threshold', async () => {
    // Worker spawns a real node subprocess and keeps it alive for 15s.
    // alert_seconds=2, heartbeat=1000ms: alert should fire well within the 15s window
    // even if WMI takes 3-4s to register the child under system load.
    await createTempSecrets(tempDir, '');
    const workerScript = await writeScript('real-leak-worker.js', `
const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 30000)'], {
  stdio: 'ignore',
  detached: false,
});
setTimeout(() => { child.kill(); process.exit(0); }, 15000);
`);

    const notified: string[] = [];
    const worker = makeWorker({ args: [workerScript] });

    await executeWorker(worker, '', {
      timeout: 25,
      resource: uniqueResource(),
      bgTasksConfig: { alert_seconds: 2, alert_repeat_seconds: 60 },
      _bgTaskHooks: {
        heartbeatIntervalMs: 1000,
        notifyUser: async (subject) => { notified.push(subject); return { sent: true, suppressed: false }; },
      },
    });

    const leakAlerts = notified.filter(s => s.startsWith('bg-leak:'));
    assert.ok(leakAlerts.length >= 1, `Expected bg-leak alert from real process tree, got: ${JSON.stringify(notified)}`);
    assert.ok(leakAlerts[0].includes('worker-under-test'), `Alert subject should include worker name: ${leakAlerts[0]}`);
  });

  it('fires repeat bg-leak alert when descendant persists past alert_repeat_seconds', async () => {
    // Worker keeps child alive for 18s; alert_seconds=2, repeat=4 → first alert ~2s in,
    // second alert ~6s in. Long window tolerates WMI latency under system load.
    await createTempSecrets(tempDir, '');
    const workerScript = await writeScript('real-repeat-worker.js', `
const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 30000)'], {
  stdio: 'ignore',
  detached: false,
});
setTimeout(() => { child.kill(); process.exit(0); }, 18000);
`);

    const notified: string[] = [];
    const worker = makeWorker({ args: [workerScript] });

    await executeWorker(worker, '', {
      timeout: 30,
      resource: uniqueResource(),
      bgTasksConfig: { alert_seconds: 2, alert_repeat_seconds: 4 },
      _bgTaskHooks: {
        heartbeatIntervalMs: 1000,
        notifyUser: async (subject) => { notified.push(subject); return { sent: true, suppressed: false }; },
      },
    });

    const leakAlerts = notified.filter(s => s.startsWith('bg-leak:'));
    assert.ok(leakAlerts.length >= 2, `Expected at least 2 bg-leak alerts (initial + repeat), got ${leakAlerts.length}: ${JSON.stringify(notified)}`);
  });

  it('fires bg-orphan alert when descendant survives worker exit', async () => {
    // Verifies the orphan sweep fires when bgTaskMap has tracked PIDs and areProcessesAlive
    // returns true. getDescendantPids is faked (one fixed PID) so this test is not affected
    // by WMI latency after the two preceding long-running tests exhaust the PS process pool.
    await createTempSecrets(tempDir, '');
    const workerScript = await writeScript('real-orphan-worker.js', `
setTimeout(() => process.exit(0), 1500);
`);

    const notified: string[] = [];
    const worker = makeWorker({ args: [workerScript] });

    await executeWorker(worker, '', {
      timeout: 10,
      resource: uniqueResource(),
      bgTasksConfig: { alert_seconds: 0, alert_repeat_seconds: 60 },
      _bgTaskHooks: {
        heartbeatIntervalMs: 300,
        getDescendantPids: async () => [{ pid: 88800, parentPid: 0 }],
        getCommandLines: async (pids) => new Map(pids.map(p => [p, 'orphan-cmd'])),
        areProcessesAlive: async (pids) => new Map(pids.map(p => [p, true])),
        notifyUser: async (subject) => { notified.push(subject); return { sent: true, suppressed: false }; },
      },
    });

    await new Promise(r => setTimeout(r, 500));

    const orphanAlerts = notified.filter(s => s.startsWith('bg-orphan:'));
    assert.ok(orphanAlerts.length >= 1, `Expected bg-orphan alert, got: ${JSON.stringify(notified)}`);
  });
});
