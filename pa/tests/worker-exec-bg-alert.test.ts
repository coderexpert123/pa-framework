import './test-env-guard.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { executeWorker, collectBgAlerts, _setOrphanSweepDepsForTest } from '../src/workers.js';
import type { BgEntry } from '../src/workers.js';
import type { WorkerConfig, RunOptions, CommandResult } from '../src/types.js';
import {
  getDescendantPids,
  getCommandLines,
  areProcessesAlive,
  _setRawExecForTest,
  _resetSnapshotCacheForTest,
} from '../src/process-tree.js';
import { blackboard } from '../src/blackboard.js';
import { logger } from '../src/lib/log.js';

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  await createTempSecrets(tempDir, '');
  scriptDir = join(tmpdir(), `pa-bg-${Date.now()}`);
  await mkdir(scriptDir, { recursive: true });
});

afterEach(async () => {
  _setOrphanSweepDepsForTest(null);
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
): Promise<{ notified: string[]; result: CommandResult }> {
  const notified: string[] = [];
  const { fakeDescendants = [], fakeAreAlive = {}, heartbeatIntervalMs = 30, ...opts } = overrides;

  const worker = makeWorker({ args: [scriptPath] });

  const result = await executeWorker(worker, '', {
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

  return { notified, result };
}

describe('BG-task tracking: age alert', () => {
  it('does NOT send a Telegram bg-leak alert when descendant age exceeds alert_seconds (logged only, 2026-08-23)', async () => {
    // Worker runs briefly; fake descendant always present
    const script = await writeScript('quick.js', 'setTimeout(() => process.stdout.write("done"), 1500);');
    const { notified, result } = await runWithBgHooks(script, { fakeDescendants: [99991] });

    assert.ok(!notified.some(s => s.startsWith('bg-leak:')), `Expected no bg-leak Telegram alert, got: ${JSON.stringify(notified)}`);
    assert.ok(result.output.includes('done'), 'worker run should still complete normally');
  });

  it('lastRepeatBucket gate blocks re-alert within same repeat bucket', () => {
    // Re-pointed at collectBgAlerts directly (2026-08-23): bg-leak Telegram
    // alerts are gone (worker-exec.ts logs only now, see worker-exec.ts:576),
    // so the bucket-gating behaviour is verified against collectBgAlerts'
    // return value, not a notifyUser call count. alert_repeat_seconds=60 —
    // first bucket is [0, 60s). The simulated run stays far below the bucket
    // width (2s vs 60s), so every heartbeat during its life is
    // deterministically still bucket 0.
    const bgTaskMap = new Map<number, BgEntry>([
      [99992, { firstSeen: 0, cmdline: 'sleep', lastRepeatBucket: -1 }],
    ]);
    const repeatMs = 60_000;
    let totalAlerts = 0;
    // Simulate ~20 heartbeats across a 2000ms run (100ms apart), same margin
    // as the original executeWorker-based test.
    for (let now = 100; now <= 2000; now += 100) {
      totalAlerts += collectBgAlerts(bgTaskMap, now, 0, repeatMs).length;
    }

    // Multiple heartbeats within bucket 0 → exactly 1 alert
    assert.equal(totalAlerts, 1, `Expected 1 alert within same bucket, got ${totalAlerts}`);
  });

  it('lastRepeatBucket: -1 ensures first bucket-0 crossing fires', () => {
    // Re-pointed at collectBgAlerts directly (2026-08-23) — see note above.
    const bgTaskMap = new Map<number, BgEntry>([
      [99993, { firstSeen: 0, cmdline: 'sleep', lastRepeatBucket: -1 }],
    ]);

    // With alert_seconds=0 and repeat_seconds=1, age=0 → bucket=0, 0 > -1 → fires
    const alerting = collectBgAlerts(bgTaskMap, 1, 0, 1000);
    assert.equal(alerting.length, 1, 'First bucket-0 crossing should fire');
    assert.equal(alerting[0].pid, 99993);
  });

  it('multi-descendant: 10 PIDs crossing threshold → still no Telegram bg-leak alert, run completes', async () => {
    const fakePids = Array.from({ length: 10 }, (_, i) => 90000 + i);
    const script = await writeScript('multi.js', 'setTimeout(() => process.stdout.write("done"), 1500);');
    const { notified, result } = await runWithBgHooks(script, { fakeDescendants: fakePids });

    assert.ok(!notified.some(s => s.startsWith('bg-leak:')), `Expected no bg-leak Telegram alert, got: ${JSON.stringify(notified)}`);
    assert.ok(result.output.includes('done'), 'worker run should still complete normally');
  });

  it('does NOT send a Telegram bg-leak alert (worker name/pid case), run completes', async () => {
    const script = await writeScript('name.js', 'setTimeout(() => process.stdout.write("done"), 1500);');
    const { notified, result } = await runWithBgHooks(script, { fakeDescendants: [99994], heartbeatIntervalMs: 100 });

    assert.ok(!notified.some(s => s.startsWith('bg-leak:')), `Expected no bg-leak Telegram alert, got: ${JSON.stringify(notified)}`);
    assert.ok(result.output.includes('done'), 'worker run should still complete normally');
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
    // AI-328: the sweep verifies survivors before reaping — the fake pid needs
    // a snapshot record whose ancestry ends in-family (parentPid 0 = chain
    // terminates immediately) and whose createdMs is within the run.
    _setOrphanSweepDepsForTest({
      getProcessSnapshot: async () => new Map([[99995, { parentPid: 0, cmdline: 'orphan-cmd', createdMs: Date.now() }]]),
      killProcessTree: () => {},
    });

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

  it('AI-328: reaps verified orphans but skips non-family survivors (phantom/reuse)', async () => {
    const script = await writeScript('reap-orphan.js', 'setTimeout(() => process.stdout.write("done"), 1500);');
    const killed: number[] = [];
    const notified: string[] = [];
    const worker = makeWorker({ args: [script] });
    const NOW = Date.now();

    // Two survivors: 50001 is a real orphan (dead in-family parent 50003 →
    // chain ends in-family); 50002 hangs off live foreign parent 77777
    // (pid-reuse/mis-attribution) and must be skipped — taskkilling it would
    // hit an unrelated process.
    _setOrphanSweepDepsForTest({
      getProcessSnapshot: async () => new Map([
        [50001, { parentPid: 50003, cmdline: 'node mcp-serve', createdMs: NOW }],
        [50002, { parentPid: 77777, cmdline: 'foreign-svc', createdMs: NOW }],
        [77777, { parentPid: 1, cmdline: 'foreign-parent', createdMs: NOW }],
        // 50003 intentionally absent — dead in-family intermediate
      ]),
      killProcessTree: (pid) => { killed.push(pid); },
    });

    await executeWorker(worker, '', {
      timeout: 10,
      resource: uniqueResource(),
      bgTasksConfig: { alert_seconds: 0, alert_repeat_seconds: 1 },
      _bgTaskHooks: {
        heartbeatIntervalMs: 100,
        getDescendantPids: async () => [{ pid: 50001, parentPid: 0 }, { pid: 50002, parentPid: 0 }, { pid: 50003, parentPid: 0 }],
        getCommandLines: async (pids) => new Map(pids.map(p => [p, `cmd-${p}`])),
        areProcessesAlive: async (pids) => new Map(pids.map(p => [p, p !== 50003])), // 50003 already dead
        notifyUser: async (subject) => { notified.push(subject); return { sent: true, suppressed: false }; },
      },
    });

    // Sweep is fire-and-forget — poll for the kill.
    for (let i = 0; i < 80 && !killed.includes(50001); i++) {
      await new Promise(r => setTimeout(r, 25));
    }

    assert.deepEqual(killed, [50001], 'only the verified in-family orphan may be reaped');
    assert.ok(notified.some(s => s.startsWith('bg-orphan:')), `Expected bg-orphan alert for reaped orphan, got: ${JSON.stringify(notified)}`);
  });

  it('AI-328: tracking drops stale-PPID phantoms at insertion (createdMs predates run)', async () => {
    const script = await writeScript('phantom-track.js', 'setTimeout(() => process.stdout.write("done"), 1500);');
    const aliveCalls: number[][] = [];
    const worker = makeWorker({ args: [script] });
    const NOW = Date.now();

    // 50004 is enumerated as a descendant but predates the run by a day —
    // stale-PPID mis-attribution. It must never enter bgTaskMap, so the
    // sweep's areProcessesAlive call never sees it. 50001 is a real member.
    _setOrphanSweepDepsForTest({
      getProcessSnapshot: async () => new Map([
        [50001, { parentPid: 50003, cmdline: 'node mcp-serve', createdMs: NOW }],
        [50004, { parentPid: 999, cmdline: 'phantom-svc', createdMs: NOW - 86_400_000 }],
      ]),
      killProcessTree: () => {},
    });

    await executeWorker(worker, '', {
      timeout: 10,
      resource: uniqueResource(),
      bgTasksConfig: { alert_seconds: 0, alert_repeat_seconds: 1 },
      _bgTaskHooks: {
        heartbeatIntervalMs: 100,
        getDescendantPids: async () => [{ pid: 50001, parentPid: 0 }, { pid: 50004, parentPid: 0 }],
        getCommandLines: async (pids) => new Map(pids.map(p => [p, `cmd-${p}`])),
        areProcessesAlive: async (pids) => { aliveCalls.push([...pids]); return new Map(pids.map(p => [p, true])); },
        notifyUser: async () => ({ sent: true, suppressed: false }),
      },
    });

    for (let i = 0; i < 80 && aliveCalls.length === 0; i++) {
      await new Promise(r => setTimeout(r, 25));
    }

    const allChecked = aliveCalls.flat();
    assert.ok(allChecked.includes(50001), 'real descendant must be tracked');
    assert.ok(!allChecked.includes(50004), `phantom pid must be filtered at tracking, got: ${JSON.stringify(allChecked)}`);
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

// bg-leak alerts are logged only now (2026-08-23, notify removed at
// worker-exec.ts:576 — see spec correction #7) — the notifier is gone, so
// these tests spy on logger.info (the replacement code path) instead of the
// removed notifyUser hook to verify the sanitizer still redacts secrets.
function spyOnLoggerInfo(): { logged: Array<{ module: string; message: string; ctx?: Record<string, unknown> }>; restore: () => void } {
  const original = logger.info;
  const logged: Array<{ module: string; message: string; ctx?: Record<string, unknown> }> = [];
  logger.info = (module: string, message: string, ctx?: Record<string, unknown>) => {
    logged.push({ module, message, ctx });
  };
  return { logged, restore: () => { logger.info = original; } };
}

describe('cmdline sanitizer', () => {
  // The bg-leak log can only fire on the SECOND completed heartbeat tick:
  // the tick that first observes a descendant stamps firstSeen=now, so
  // ageMs=0 fails collectBgAlerts' `ageMs > alertMs` even at alert_seconds=0.
  // The _bgTaskHooks seam does NOT cover the two real-I/O calls inside the
  // tick body, and either alone can eat the whole 1500ms worker window on a
  // loaded box:
  //   1. hasChildProcesses(fresh) — a fresh WMI/Get-CimInstance query (~1.2s
  //      serialized under load; flake seen 2026-09-14). Stubbed via _rawExec.
  //   2. blackboard.updateHeartbeat x2 per tick (resource lock + worker-slot
  //      lock) — real proper-lockfile round-trips on disk; on a starved disk
  //      each can take hundreds of ms, leaving <2 completed ticks and no
  //      bg-leak log (same 'Expected a bg-leak log entry' flake, reproduced
  //      by injecting an 800ms updateHeartbeat delay). Stubbed by patching
  //      the blackboard singleton directly — same wrap/restore pattern as
  //      blackboard.test.ts's updateHeartbeat wrapper.
  // With both legs instant, the second tick lands ~60ms into the 1500ms
  // worker — ~25x margin. Not in runWithBgHooks: that helper predates the
  // log-only path and its tests assert on notifyUser, not the tick clock.
  let savedUpdateHeartbeat: typeof blackboard.updateHeartbeat | null = null;
  function stubTickIo(): void {
    _setRawExecForTest(async () => ({
      stdout: process.platform === 'win32' ? '[]' : '',
      stderr: '',
    }));
    savedUpdateHeartbeat = blackboard.updateHeartbeat;
    (blackboard as any).updateHeartbeat = async () => true;
  }
  function restoreTickIo(): void {
    _setRawExecForTest(null);
    _resetSnapshotCacheForTest();
    if (savedUpdateHeartbeat) {
      (blackboard as any).updateHeartbeat = savedUpdateHeartbeat;
      savedUpdateHeartbeat = null;
    }
  }

  it('strips api_key, token, password, secret from query strings', async () => {
    const script = await writeScript('sanitize.js', 'setTimeout(() => process.stdout.write("done"), 1500);');
    const worker = makeWorker({ args: [script] });
    const spy = spyOnLoggerInfo();
    stubTickIo();

    try {
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
        },
      });
    } finally {
      spy.restore();
      restoreTickIo();
    }

    const bgLeakLog = spy.logged.find(l => l.module === 'worker-exec' && l.message === 'bg-leak');
    assert.ok(bgLeakLog, 'Expected a bg-leak log entry');
    const detail = String(bgLeakLog?.ctx?.detail ?? '');
    assert.ok(detail.includes('77771'), 'Expected log detail with PID 77771');
    assert.ok(!detail.includes('SECRET123'), 'api_key value should be redacted');
    assert.ok(detail.includes('<redacted>'), 'Should contain <redacted>');
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
      const script = await writeScript(`san-${paramTests.indexOf(cmdline)}.js`, 'setTimeout(() => process.stdout.write("done"), 1500);');
      const worker = makeWorker({ args: [script] });
      const spy = spyOnLoggerInfo();
      stubTickIo();

      try {
        await executeWorker(worker, '', {
          timeout: 5,
          resource: uniqueResource(),
          bgTasksConfig: { alert_seconds: 0, alert_repeat_seconds: 1 },
          _bgTaskHooks: {
            heartbeatIntervalMs: 30,
            getDescendantPids: async () => [{ pid: 77772, parentPid: 0 }],
            getCommandLines: async () => new Map([[77772, cmdline]]),
            areProcessesAlive: async () => new Map([[77772, false]]),
          },
        });
      } finally {
        spy.restore();
        restoreTickIo();
      }

      const bgLeakLog = spy.logged.find(l => l.module === 'worker-exec' && l.message === 'bg-leak');
      // Presence asserted too — a missing bg-leak log made `detail` '' and
      // the redaction check below passed vacuously.
      assert.ok(bgLeakLog, `Expected a bg-leak log entry for cmdline: ${cmdline}`);
      const detail = String(bgLeakLog?.ctx?.detail ?? '');
      assert.ok(!detail.includes('abc123'), `"abc123" should be redacted in cmdline: ${cmdline}`);
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
            { ProcessId: 100, ParentProcessId: 0, CommandLine: 'worker' },
            { ProcessId: 101, ParentProcessId: 100, CommandLine: 'child' },
            { ProcessId: 102, ParentProcessId: 101, CommandLine: 'grandchild1' },
            { ProcessId: 103, ParentProcessId: 102, CommandLine: 'grandchild2' },
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
            { ProcessId: 1, ParentProcessId: 0, CommandLine: 'init' },
            { ProcessId: 2, ParentProcessId: 1, CommandLine: 'child' },   // direct child
            { ProcessId: 3, ParentProcessId: 2, CommandLine: 'grandchild' },   // grandchild
            { ProcessId: 4, ParentProcessId: 3, CommandLine: 'greatgrandchild' },   // great-grandchild
            { ProcessId: 5, ParentProcessId: 999, CommandLine: 'unrelated' }, // unrelated
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

  // ── Full heartbeat integration (4th storm variant, 2026-09-12) ──────────────
  // The unit tests above call getDescendantPids directly with an injected
  // ExecFn. These two exercise the REAL heartbeat tick inside executeWorker,
  // where bgGetDescendants (getDescendantPids, real default execHidden path)
  // AND hasChildProcesses (also real, default path) both fire per tick — the
  // invariant that matters in production is that those two calls, made moments
  // apart within one tick, resolve to ONE raw OS query, not two, and that a
  // slow tick body can't stack a second tick on top of itself.
  afterEach(() => {
    _setRawExecForTest(null);
    _resetSnapshotCacheForTest();
  });

  it('a real heartbeat tick performs at most ONE raw snapshot query (bgGetDescendants + hasChildProcesses share the cache)', async () => {
    _resetSnapshotCacheForTest();
    let rawCallCount = 0;
    _setRawExecForTest(async () => {
      rawCallCount++;
      return { stdout: process.platform === 'win32' ? '[]' : '', stderr: '' };
    });

    const script = await writeScript('single-raw-query.js', 'setTimeout(() => process.stdout.write("done"), 250);');
    const worker = makeWorker({ args: [script] });

    await executeWorker(worker, '', {
      timeout: 5,
      resource: uniqueResource(),
      bgTasksConfig: { alert_seconds: 0, alert_repeat_seconds: 1 },
      // No _bgTaskHooks.getDescendantPids/getCommandLines/areProcessesAlive
      // overrides — this deliberately exercises the REAL default-path
      // functions (via bgGetDescendants ?? getDescendantPids) that route
      // through the shared cache under test.
      _bgTaskHooks: { heartbeatIntervalMs: 1000 },
    });

    assert.ok(rawCallCount <= 1, `expected at most one raw exec call for one heartbeat tick, got ${rawCallCount}`);
  });

  it('a tick whose previous body is still pending is skipped (heartbeat re-entrancy guard)', async () => {
    // hasChildProcesses(child.pid!, true, undefined, true) at worker-exec.ts's
    // "Check 1" runs inside the SAME tick body, after bgGetDescendants, and is
    // NOT overridable via _bgTaskHooks — left unmocked it issues a REAL
    // fresh:true OS query (uncontrolled duration), which starves this test of
    // the multiple ticks it needs to observe. Pin it to an instant empty
    // snapshot so the ONLY deliberate slowness is the injected
    // getDescendantPids delay below (found 2026-09-12: real-OS latency here
    // reduced observed ticks to 1, failing the totalCalls >= 2 assertion).
    _resetSnapshotCacheForTest();
    _setRawExecForTest(async () => ({ stdout: process.platform === 'win32' ? '[]' : '', stderr: '' }));

    const script = await writeScript('slow-heartbeat.js', 'setTimeout(() => process.stdout.write("done"), 700);');
    let activeCalls = 0;
    let maxConcurrent = 0;
    let totalCalls = 0;
    const worker = makeWorker({ args: [script] });

    try {
      await executeWorker(worker, '', {
        timeout: 5,
        resource: uniqueResource(),
        bgTasksConfig: { alert_seconds: 0, alert_repeat_seconds: 1 },
        _bgTaskHooks: {
          heartbeatIntervalMs: 30, // much shorter than the fake query's own delay below
          getDescendantPids: async () => {
            totalCalls++;
            activeCalls++;
            maxConcurrent = Math.max(maxConcurrent, activeCalls);
            await new Promise(r => setTimeout(r, 150)); // outlasts several interval periods
            activeCalls--;
            return [];
          },
          getCommandLines: async () => new Map(),
          areProcessesAlive: async () => new Map(),
          notifyUser: async () => ({ sent: true, suppressed: false }),
        },
      });
    } finally {
      _setRawExecForTest(null);
      _resetSnapshotCacheForTest();
    }

    assert.equal(maxConcurrent, 1, 'no two heartbeat tick bodies should run concurrently');
    assert.ok(totalCalls >= 2, `expected the guard to still allow multiple sequential ticks, got ${totalCalls}`);
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
  it('logs a bg-leak entry (no Telegram) when real descendant outlives alert_seconds threshold', async () => {
    // Worker spawns a real node subprocess and keeps it alive for 15s.
    // alert_seconds=2, heartbeat=1000ms: the log entry should appear well
    // within the 15s window even if WMI takes 3-4s to register the child
    // under system load. bg-leak alerts are logged only now (2026-08-23,
    // notify removed at worker-exec.ts:576) — spy on logger.info (the
    // replacement code path) instead of the removed notifyUser hook.
    await createTempSecrets(tempDir, '');
    const workerScript = await writeScript('real-leak-worker.js', `
const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 30000)'], {
  stdio: 'ignore',
  detached: false,
});
setTimeout(() => { child.kill(); process.exit(0); }, 15000);
`);

    const worker = makeWorker({ args: [workerScript] });
    const spy = spyOnLoggerInfo();

    try {
      await executeWorker(worker, '', {
        timeout: 25,
        resource: uniqueResource(),
        bgTasksConfig: { alert_seconds: 2, alert_repeat_seconds: 60 },
        _bgTaskHooks: {
          heartbeatIntervalMs: 1000,
        },
      });
    } finally {
      spy.restore();
    }

    const leakLogs = spy.logged.filter(l => l.module === 'worker-exec' && l.message === 'bg-leak');
    assert.ok(leakLogs.length >= 1, `Expected a bg-leak log entry from real process tree, got: ${JSON.stringify(spy.logged)}`);
    assert.equal(leakLogs[0].ctx?.worker, 'worker-under-test', `Log entry should include worker name: ${JSON.stringify(leakLogs[0])}`);
  });

  it('logs a repeat bg-leak entry (no Telegram) when descendant persists past alert_repeat_seconds', async () => {
    // Worker keeps child alive for 18s; alert_seconds=2, repeat=4 → first
    // log entry ~2s in, second ~6s in. Long window tolerates WMI latency
    // under system load. Re-pointed at logger.info — see note above.
    await createTempSecrets(tempDir, '');
    const workerScript = await writeScript('real-repeat-worker.js', `
const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 30000)'], {
  stdio: 'ignore',
  detached: false,
});
setTimeout(() => { child.kill(); process.exit(0); }, 18000);
`);

    const worker = makeWorker({ args: [workerScript] });
    const spy = spyOnLoggerInfo();

    try {
      await executeWorker(worker, '', {
        timeout: 30,
        resource: uniqueResource(),
        bgTasksConfig: { alert_seconds: 2, alert_repeat_seconds: 4 },
        _bgTaskHooks: {
          heartbeatIntervalMs: 1000,
        },
      });
    } finally {
      spy.restore();
    }

    const leakLogs = spy.logged.filter(l => l.module === 'worker-exec' && l.message === 'bg-leak');
    assert.ok(leakLogs.length >= 2, `Expected at least 2 bg-leak log entries (initial + repeat), got ${leakLogs.length}: ${JSON.stringify(spy.logged)}`);
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

    // AI-328: the sweep verifies survivors before reaping — fake pid needs a
    // snapshot record whose ancestry ends in-family (parentPid 0) with a
    // createdMs inside the run, or it classifies as non-family and is skipped.
    _setOrphanSweepDepsForTest({
      getProcessSnapshot: async () => new Map([[88800, { parentPid: 0, cmdline: 'orphan-cmd', createdMs: Date.now() }]]),
      killProcessTree: () => {},
    });

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
