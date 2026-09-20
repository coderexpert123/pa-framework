/**
 * pa catchup --loop (2026-09-10 launch-cadence wave).
 *
 * A0's invariant is the thing every case here ultimately protects: `default`
 * and `reminders` are two INDEPENDENT lanes, each with its own in-flight
 * flag, driven off one timer — never a serial tick that runs one then the
 * other. See root scheduler.ts:172 / commands/catchup.ts:48 for why the two
 * lanes must never share a blackboard row.
 *
 * Dynamic imports throughout (not static), same reason as catchup.test.ts:
 * the Blackboard singleton and catchupLoopLockPath() must not resolve PA_HOME
 * before createTempPaHome() sets it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink, stat, mkdir, writeFile } from 'fs/promises';
import { readFileSync, statSync, existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createTempPaHome, createTempConfig, createTempSkill, cleanup } from './helpers.js';
import { writeLog } from '../src/logger.js';
import { flushLog } from '../src/lib/log.js';
import type { RunMeta } from '../src/types.js';

let dir: string;

/** No-op signal surface — every case drives shutdown explicitly via
 *  handle.stop(), so none of these tests needs (or should register) a real
 *  process-level SIGINT/SIGTERM/SIGBREAK handler. */
const NOOP_SIGNALS = { on: () => {}, off: () => {} };

const runnerPath = () => join(dir, 'marker-writer.cjs');
const blockingRunnerPath = () => join(dir, 'blocking-marker-writer.cjs');
const delayedRunnerPath = () => join(dir, 'delayed-marker-writer.cjs');
const markerPath = (name: string) => join(dir, 'markers', `${name}.txt`);

async function readMarker(name: string): Promise<string | null> {
  return readFile(markerPath(name), 'utf8').catch(() => null);
}

function readMarkerSync(name: string): string | null {
  try { return readFileSync(markerPath(name), 'utf8'); } catch { return null; }
}

const fwd = (p: string) => p.replace(/\\/g, '/');

async function createMarkerSkill(name: string, topic: string): Promise<void> {
  await createTempSkill(dir, name, [
    '---',
    'cron: "0 0 1 1 *"',
    `topic: ${topic}`,
    `cmd: "node \\"${fwd(runnerPath())}\\" \\"${fwd(markerPath(name))}\\" ${name}"`,
    'timeout: 60',
    '---',
    `Marker skill ${name} — appends one line per execution.`,
  ].join('\n'));
}

/** S7 fixture: blocks (polling for `releaseFile` to appear) before appending
 *  its marker line, then exits NON-ZERO on purpose — a run this fixture
 *  produces is never a recorded SUCCESS (logger.ts's getLastSuccessfulRun),
 *  so the skill stays "overdue" forever regardless of how many times it is
 *  dispatched. That is deliberate: it isolates the fact under test (does the
 *  fire-and-forget dispatch loop's own `activeSkillRuns` bookkeeping skip a
 *  still-running skill and re-admit it once its promise settles) from the
 *  scheduler's separate "is this cron occurrence still due" question, which
 *  a real annual cron would only satisfy once naturally. AI-098's ladder rung
 *  0 (no delay after a single failure) keeps the fixture immediately
 *  re-dispatchable after it settles. */
async function createBlockingSkill(name: string, topic: string, releaseFile: string): Promise<void> {
  await createTempSkill(dir, name, [
    '---',
    'cron: "0 0 1 1 *"',
    `topic: ${topic}`,
    `cmd: "node \\"${fwd(blockingRunnerPath())}\\" \\"${fwd(markerPath(name))}\\" ${name} \\"${fwd(releaseFile)}\\""`,
    'timeout: 120',
    '---',
    `Blocking marker skill ${name} — appends its marker line once released, then fails on purpose.`,
  ].join('\n'));
}

/** S7 fixture: appends its marker line after `delayMs`, then exits 0 (a real
 *  success) — used to prove the one-shot path still awaits a dispatched
 *  skill to completion (a real elapsed-time floor, not just "the file
 *  eventually appears"). */
async function createDelayedMarkerSkill(name: string, topic: string, delayMs: number): Promise<void> {
  await createTempSkill(dir, name, [
    '---',
    'cron: "0 0 1 1 *"',
    `topic: ${topic}`,
    `cmd: "node \\"${fwd(delayedRunnerPath())}\\" \\"${fwd(markerPath(name))}\\" ${name} ${delayMs}"`,
    'timeout: 60',
    '---',
    `Delayed marker skill ${name} — appends one line after ${delayMs}ms.`,
  ].join('\n'));
}

function errorMeta(timestamp: string): RunMeta {
  return { worker: 'shell', status: 'error', exitCode: 1, duration: 10, timestamp };
}

/** Seed `count` consecutive failed runs ending at `lastAttemptAtMs` (one per
 *  minute, oldest first) — mirrors catchup-backoff-integration.test.ts. */
async function seedFailures(name: string, count: number, lastAttemptAtMs: number): Promise<void> {
  for (let i = count - 1; i >= 0; i--) {
    await writeLog(name, 'seeded failure', errorMeta(new Date(lastAttemptAtMs - i * 60_000).toISOString()));
  }
}

interface AppLogEntry {
  level?: string;
  module?: string;
  message?: string;
  [key: string]: unknown;
}

async function readAppLog(): Promise<AppLogEntry[]> {
  await flushLog();
  const raw = await readFile(join(dir, 'app.log.jsonl'), 'utf8').catch(() => '');
  const entries: AppLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line) as AppLogEntry); } catch { /* skip torn line */ }
  }
  return entries;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, pollMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  assert.ok(predicate(), `condition not met within ${timeoutMs}ms`);
}

before(async () => {
  dir = await createTempPaHome();
  await createTempConfig(dir, [
    { name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e "0"' },
  ]);
  await mkdir(join(dir, 'markers'), { recursive: true });
  await writeFile(
    runnerPath(),
    'const fs = require("fs");\n' +
    'const [, , markerFile, label] = process.argv;\n' +
    'fs.appendFileSync(markerFile, label + "\\n");\n',
    'utf8',
  );
  await writeFile(
    blockingRunnerPath(),
    'const fs = require("fs");\n' +
    'const [, , markerFile, label, releaseFile] = process.argv;\n' +
    'function poll() {\n' +
    '  if (fs.existsSync(releaseFile)) {\n' +
    '    fs.appendFileSync(markerFile, label + "\\n");\n' +
    '    process.exitCode = 1;\n' + // never a recorded success — see createBlockingSkill's doc comment
    '    return;\n' +
    '  }\n' +
    '  setTimeout(poll, 20);\n' +
    '}\n' +
    'poll();\n',
    'utf8',
  );
  await writeFile(
    delayedRunnerPath(),
    'const fs = require("fs");\n' +
    'const [, , markerFile, label, delayMs] = process.argv;\n' +
    'setTimeout(() => fs.appendFileSync(markerFile, label + "\\n"), Number(delayMs));\n',
    'utf8',
  );
});

after(async () => {
  await cleanup(dir);
});

describe('pa catchup --loop (2026-09-10 launch-cadence wave)', () => {
  it('a second loop refuses to start while the first holds catchup:loop', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const { startCatchupLoop, catchupLoopLockPath, CATCHUP_LOOP_LOCK } = await import('../src/commands/catchup.js');

    // process.ppid is always alive and always ≠ process.pid — Windows-safe.
    const foreignPid = process.ppid;
    const acquired = await blackboard.acquireLock(CATCHUP_LOOP_LOCK, 'someone-else', foreignPid, 1000);
    assert.equal(acquired, true, 'setup: foreign PID must acquire catchup:loop');

    try {
      const handle = await startCatchupLoop({ tickFn: async () => {}, signals: NOOP_SIGNALS });
      const exit = await handle.done;
      assert.equal(exit, 'not-acquired');
      assert.equal(handle.timer, null);

      const rows = await blackboard.getActiveLocks();
      const foreignRows = rows.filter((l) => l.resource === CATCHUP_LOOP_LOCK && l.pid === foreignPid);
      assert.equal(foreignRows.length, 1, 'the foreign row must be untouched');

      await assert.rejects(() => stat(catchupLoopLockPath()), 'no PID file should have been written');
    } finally {
      await blackboard.releaseLock(CATCHUP_LOOP_LOCK, 'someone-else');
    }
  });

  it('lanes run independently: a slow default lane never delays reminders', async () => {
    const { startCatchupLoop } = await import('../src/commands/catchup.js');

    const remindersTicks: number[] = [];
    let defaultCallCount = 0;
    let releaseDefault: (() => void) | undefined;
    const defaultBlocked = new Promise<void>((resolve) => { releaseDefault = resolve; });

    const tickFn = async (lane: string): Promise<void> => {
      if (lane === 'default') {
        defaultCallCount++;
        await defaultBlocked;
        return;
      }
      if (lane === 'reminders') {
        remindersTicks.push(Date.now());
        return;
      }
      // 'maintenance' — not under test in this case; resolve immediately.
    };

    const handle = await startCatchupLoop({ tickFn, intervalMs: 30, signals: NOOP_SIGNALS });
    try {
      await waitFor(() => remindersTicks.length >= 3, 5000);
      assert.equal(defaultCallCount, 1, 'the default lane must still be in its first, unresolved tick');
    } finally {
      releaseDefault?.();
      handle.stop();
      await handle.done;
    }
  });

  it('a lane tick still in flight is skipped, not queued', async () => {
    const { startCatchupLoop } = await import('../src/commands/catchup.js');

    let defaultCallCount = 0;
    let releaseDefault: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { releaseDefault = resolve; });

    const tickFn = async (lane: string): Promise<void> => {
      if (lane === 'default') {
        defaultCallCount++;
        await blocked;
      }
    };

    const handle = await startCatchupLoop({ tickFn, intervalMs: 30, signals: NOOP_SIGNALS });
    try {
      // Let at least four intervals elapse while the first default call is unresolved.
      await new Promise((r) => setTimeout(r, 30 * 4 + 100));
      assert.equal(defaultCallCount, 1, 'a lane tick still in flight must be skipped, never queued');
    } finally {
      releaseDefault?.();
      handle.stop();
      await handle.done;
    }
  });

  it("CATCHUP_LOOP_LANES names exactly the three independent lanes", async () => {
    const { CATCHUP_LOOP_LANES } = await import('../src/commands/catchup.js');
    assert.deepEqual([...CATCHUP_LOOP_LANES], ['default', 'reminders', 'maintenance']);
  });

  it('the maintenance lane ticks independently: a never-resolving default lane does not delay it (S6)', async () => {
    const { startCatchupLoop } = await import('../src/commands/catchup.js');

    const maintenanceTicks: number[] = [];
    let defaultCallCount = 0;

    const tickFn = async (lane: string): Promise<void> => {
      if (lane === 'default') {
        defaultCallCount++;
        // Never resolves — simulates a wedged skill in the default lane.
        await new Promise<void>(() => {});
        return;
      }
      if (lane === 'maintenance') {
        maintenanceTicks.push(Date.now());
        return;
      }
      // 'reminders' — not under test in this case; resolve immediately.
    };

    const handle = await startCatchupLoop({ tickFn, intervalMs: 30, signals: NOOP_SIGNALS });
    try {
      await waitFor(() => maintenanceTicks.length >= 3, 5000);
      assert.equal(defaultCallCount, 1, 'the default lane must still be stuck in its first, unresolved tick');
    } finally {
      handle.stop();
      await handle.done;
    }
  });

  it('a blocked maintenance tick is skipped, not queued', async () => {
    const { startCatchupLoop } = await import('../src/commands/catchup.js');

    let maintenanceCallCount = 0;
    let releaseMaintenance: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { releaseMaintenance = resolve; });

    const tickFn = async (lane: string): Promise<void> => {
      if (lane === 'maintenance') {
        maintenanceCallCount++;
        await blocked;
      }
    };

    const handle = await startCatchupLoop({ tickFn, intervalMs: 30, signals: NOOP_SIGNALS });
    try {
      // Let at least four intervals elapse while the first maintenance call is unresolved.
      await new Promise((r) => setTimeout(r, 30 * 4 + 100));
      assert.equal(maintenanceCallCount, 1, 'a blocked maintenance tick must be skipped, never queued');
    } finally {
      releaseMaintenance?.();
      handle.stop();
      await handle.done;
    }
  });

  it("the lane timer is ref'd", async () => {
    const { startCatchupLoop } = await import('../src/commands/catchup.js');

    const handle = await startCatchupLoop({ tickFn: async () => {}, intervalMs: 5000, signals: NOOP_SIGNALS });
    try {
      assert.equal(handle.timer?.hasRef(), true, "the lane timer must be ref'd — it is the loop's only reason to stay alive");
    } finally {
      handle.stop();
      await handle.done;
    }
  });

  it("onLost('purged') shuts the loop down and resolves", async () => {
    const { startCatchupLoop, catchupLoopLockPath } = await import('../src/commands/catchup.js');

    const originalRenewMs = process.env.PA_LOCK_RENEW_INTERVAL_MS;
    process.env.PA_LOCK_RENEW_INTERVAL_MS = '20';
    try {
      let released = false;
      const client = {
        acquireLock: async () => true,
        releaseLock: async () => { released = true; },
        renewHeartbeat: async () => 'row-absent' as const,
        peekLockRow: async () => null,
      };

      const handle = await startCatchupLoop({
        tickFn: async () => {},
        intervalMs: 5000,
        blackboardClient: client as any,
        signals: NOOP_SIGNALS,
      });

      const exit = await handle.done;
      assert.equal(exit, 'lock-lost-purged');
      assert.equal(released, true, 'releaseLock must have been called on the injected client');
      await assert.rejects(() => stat(catchupLoopLockPath()), 'PID file must be removed once the loop shuts down');
    } finally {
      if (originalRenewMs === undefined) delete process.env.PA_LOCK_RENEW_INTERVAL_MS;
      else process.env.PA_LOCK_RENEW_INTERVAL_MS = originalRenewMs;
    }
  });

  it('the PID file holds the bare pid, is re-asserted when deleted, and is removed on shutdown', async () => {
    const { startCatchupLoop, catchupLoopLockPath } = await import('../src/commands/catchup.js');

    const handle = await startCatchupLoop({ tickFn: async () => {}, intervalMs: 30, signals: NOOP_SIGNALS });
    try {
      const lockPath = catchupLoopLockPath();
      const initial = await readFile(lockPath, 'utf8');
      assert.equal(initial, String(process.pid), 'PID file must hold the bare pid, no newline');

      await unlink(lockPath);

      let restored = '';
      await waitFor(() => {
        try {
          restored = readFileSync(lockPath, 'utf8');
          return restored.length > 0;
        } catch {
          return false;
        }
      }, 3000);
      assert.equal(restored, String(process.pid), 'the PID file must be restored byte-identically on the next tick');
    } finally {
      handle.stop();
      await handle.done;
      await assert.rejects(() => stat(catchupLoopLockPath()), 'PID file must be removed on shutdown');
    }
  });

  // 2026-09-12 stuck-loop incident: PidIsLiveNode (S1) only proves the PID is
  // a live node.exe, not that its event loop is still turning — a frozen-but-
  // alive loop ran silently for 7.5h because nothing external could tell the
  // two apart. The PID file's mtime is the fix: it must advance every tick
  // even though its bytes never change, so the VBS/cron watchdogs can read
  // staleness as "wedged" without asking the process anything.
  it('the PID file mtime advances every tick even though its content is unchanged (heartbeat)', async () => {
    const { startCatchupLoop, catchupLoopLockPath } = await import('../src/commands/catchup.js');

    const handle = await startCatchupLoop({ tickFn: async () => {}, intervalMs: 30, signals: NOOP_SIGNALS });
    try {
      const lockPath = catchupLoopLockPath();
      const initialStat = await stat(lockPath);
      const initialContent = await readFile(lockPath, 'utf8');

      await waitFor(() => {
        try {
          return statSync(lockPath).mtimeMs > initialStat.mtimeMs;
        } catch {
          return false;
        }
      }, 3000);

      const laterContent = await readFile(lockPath, 'utf8');
      assert.equal(laterContent, initialContent, 'content must stay the bare pid — only mtime should move');
      assert.equal(laterContent, String(process.pid));
    } finally {
      handle.stop();
      await handle.done;
    }
  });

  it('every lane progress file is stamped at loop start and advances every tick', async () => {
    const { startCatchupLoop } = await import('../src/commands/catchup.js');
    const { catchupLanesDir } = await import('../src/lib/catchup-contract.js');

    const handle = await startCatchupLoop({ tickFn: async () => {}, intervalMs: 30, signals: NOOP_SIGNALS });
    try {
      const lanesDir = catchupLanesDir();
      const mtimes: Record<string, number> = {};
      for (const lane of ['default', 'reminders', 'maintenance']) {
        const p = join(lanesDir, lane);
        await waitFor(() => existsSync(p), 2000);
        const content = readFileSync(p, 'utf8');
        assert.match(content, /^\d{4}-\d{2}-\d{2}T[^|]+\|(default|reminders|maintenance)\|[a-z-]+\|/);
        mtimes[lane] = statSync(p).mtimeMs;
      }
      await waitFor(
        () => ['default', 'reminders', 'maintenance'].every(
          (lane) => statSync(join(lanesDir, lane)).mtimeMs > mtimes[lane]!,
        ),
        3000,
      );
    } finally {
      handle.stop();
      await handle.done;
    }
  });

  it('a wedged lane stops advancing its progress file while the heartbeat and the other lanes advance', async () => {
    const { startCatchupLoop, catchupLoopLockPath } = await import('../src/commands/catchup.js');
    const { catchupLanesDir } = await import('../src/lib/catchup-contract.js');

    let releaseReminders: (() => void) | undefined;
    const remindersBlocked = new Promise<void>((resolve) => { releaseReminders = resolve; });

    const tickFn = async (lane: string, onProgress: (phase: string, detail?: string) => void): Promise<void> => {
      if (lane === 'reminders') {
        onProgress('lock-acquired', 'catchup:topic:reminders');
        await remindersBlocked;
      }
    };

    const handle = await startCatchupLoop({ tickFn, intervalMs: 30, signals: NOOP_SIGNALS });
    try {
      const lanesDir = catchupLanesDir();
      const remindersPath = join(lanesDir, 'reminders');
      const defaultPath = join(lanesDir, 'default');
      const lockPath = catchupLoopLockPath();

      await new Promise((r) => setTimeout(r, 150));
      const remindersMtime0 = statSync(remindersPath).mtimeMs;
      const remindersContent0 = readFileSync(remindersPath, 'utf8');
      const defaultMtime0 = statSync(defaultPath).mtimeMs;
      const lockMtime0 = statSync(lockPath).mtimeMs;

      await new Promise((r) => setTimeout(r, 300));

      assert.equal(statSync(remindersPath).mtimeMs, remindersMtime0, 'the wedged reminders lane file must not advance');
      assert.match(remindersContent0, /\|reminders\|lock-acquired\|/);
      assert.ok(statSync(defaultPath).mtimeMs > defaultMtime0, 'the default lane file must keep advancing');
      assert.ok(statSync(lockPath).mtimeMs > lockMtime0, 'the PID-file heartbeat must keep advancing');
    } finally {
      releaseReminders?.();
      handle.stop();
      await handle.done;
    }
  });

  it('a progress callback from a superseded tick is ignored', async () => {
    const { startCatchupLoop } = await import('../src/commands/catchup.js');
    const { catchupLanesDir } = await import('../src/lib/catchup-contract.js');

    let captured: ((phase: string, detail?: string) => void) | undefined;
    const tickFn = async (lane: string, onProgress: (phase: string, detail?: string) => void): Promise<void> => {
      if (lane === 'maintenance' && !captured) {
        captured = onProgress;
      }
    };

    const handle = await startCatchupLoop({ tickFn, intervalMs: 30, signals: NOOP_SIGNALS });
    try {
      await waitFor(() => captured !== undefined, 2000);
      await new Promise((r) => setTimeout(r, 150));
      const maintenancePath = join(catchupLanesDir(), 'maintenance');
      captured!('stale-phase', 'x');
      const content = readFileSync(maintenancePath, 'utf8');
      assert.ok(!content.includes('|stale-phase|'), 'a superseded tick\'s progress callback must be ignored');
    } finally {
      handle.stop();
      await handle.done;
    }
  });

  it('the drill-wedge file wedges exactly the named lane once and is consumed', { timeout: 60_000 }, async () => {
    const { startCatchupLoop } = await import('../src/commands/catchup.js');
    const { catchupLanesDir, catchupDrillWedgePath } = await import('../src/lib/catchup-contract.js');

    writeFileSync(catchupDrillWedgePath(), 'reminders', 'utf8');

    const callCounts: Record<string, number> = { default: 0, reminders: 0, maintenance: 0 };
    const tickFn = async (lane: string): Promise<void> => {
      callCounts[lane] = (callCounts[lane] ?? 0) + 1;
    };

    const handle = await startCatchupLoop({ tickFn, intervalMs: 30, signals: NOOP_SIGNALS });
    try {
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(!existsSync(catchupDrillWedgePath()), 'the drill-wedge file must be consumed');
      const remindersContent = readFileSync(join(catchupLanesDir(), 'reminders'), 'utf8');
      assert.match(remindersContent, /\|reminders\|drill-wedge\|/);
      assert.equal(callCounts.reminders, 0, 'the wedged lane\'s tickFn must never be called');
      assert.ok(callCounts.default >= 3, 'the default lane must keep ticking normally');
    } finally {
      handle.stop();
      await handle.done;
    }
  });

  it('a store stall shuts the loop down: marker written, lock released, PID file removed, exit code 4', { timeout: 20_000 }, async () => {
    const { startCatchupLoop, catchupLoopLockPath } = await import('../src/commands/catchup.js');
    const { catchupStallMarkerPath } = await import('../src/lib/catchup-contract.js');
    const { withBoundedQueue } = await import('../src/lib/stall.js');
    const { blackboard } = await import('../src/blackboard.js');

    const exits: number[] = [];
    const handle = await startCatchupLoop({
      tickFn: async () => {},
      intervalMs: 5000,
      exit: (code) => { exits.push(code); },
      signals: NOOP_SIGNALS,
    });

    void withBoundedQueue('catchup-loop-test-stall', () => new Promise<void>(() => {}), { store: 'test-store', target: 'hung.json', maxWaitMs: 50 });
    await withBoundedQueue('catchup-loop-test-stall', async () => {}, { store: 'test-store', target: 'hung.json', maxWaitMs: 50 });

    const exit = await handle.done;
    assert.equal(exit, 'store-stall');
    assert.deepEqual(exits, [4]);

    const markerPath = catchupStallMarkerPath();
    const markerContent = readFileSync(markerPath, 'utf8');
    assert.equal(markerContent, 'store stall: test-store (hung.json)');

    await assert.rejects(() => stat(catchupLoopLockPath()));

    const rows = await blackboard.getActiveLocks();
    assert.equal(
      rows.some((l) => l.resource === 'catchup:loop' && l.pid === process.pid),
      false,
    );

    unlinkSync(markerPath);
  });

  it('runCatchupTick reports lock-acquired, overdue-scan and dispatch-loop for an empty topic', async () => {
    const { runCatchupTick } = await import('../src/commands/catchup.js');
    const phases: string[] = [];
    await runCatchupTick('clw-empty-topic', { dispatchOnly: true, onProgress: (p) => phases.push(p) });
    assert.deepEqual(phases, ['lock-acquired', 'overdue-scan', 'dispatch-loop']);
  });

  it('failure backoff is unchanged across two in-process ticks', async () => {
    const { runCatchupTick, runMaintenanceTick } = await import('../src/commands/catchup.js');

    await createMarkerSkill('loop-backoff-skill', 'default');
    // 2 consecutive failures → ladder rung 30m; last attempt 5 min ago → still
    // mid-backoff, so a fresh process would defer, not run.
    const lastAttemptAtMs = Date.now() - 5 * 60_000;
    await seedFailures('loop-backoff-skill', 2, lastAttemptAtMs);

    await runCatchupTick('default');
    await runCatchupTick('default');

    assert.equal(
      await readMarker('loop-backoff-skill'),
      null,
      'a mid-backoff skill must not run on either in-process tick',
    );

    const entries = await readAppLog();
    const deferLogs = entries.filter(
      (e) => e.module === 'catchup' && e.skill === 'loop-backoff-skill' && String(e.message).includes('deferred'),
    );
    assert.equal(deferLogs.length, 2, 'both in-process ticks must independently compute the defer decision — no caching');
    assert.equal(
      deferLogs[0]!.retryAt,
      deferLogs[1]!.retryAt,
      'both ticks must compute the same retryAt a fresh one-shot process would',
    );

    // C1: a topic-scoped tick — every lane of the loop included — no longer
    // runs the declared-maintenance pass; that pass moved to its own lane
    // (runMaintenanceTick, lock `catchup:maintenance`).
    const statePath = join(dir, 'maintenance-state.json');
    assert.equal(
      await readFile(statePath, 'utf8').catch(() => null),
      null,
      'two topic-scoped runCatchupTick(\'default\') calls must not create the maintenance ledger',
    );

    const maintPhases: string[] = [];
    await runMaintenanceTick((phase) => { maintPhases.push(phase); });
    assert.ok(
      await readFile(statePath, 'utf8').catch(() => null),
      'runMaintenanceTick() must run the declared-maintenance pass and create the ledger',
    );
    assert.equal(maintPhases[0], 'lock-acquired');
    assert.equal(maintPhases[1], 'maintenance');
    assert.equal(
      maintPhases.filter((p) => p === 'job-decision').length,
      (await import('../src/lib/maintenance/registry.js')).jobsForHost('pa').length,
    );
  });

  it('the loop path contains no process.exit', async () => {
    const { repoRootFromModule } = await import('../src/lib/git-root.js');
    const repoRoot = await repoRootFromModule(__filename);
    const src = await readFile(join(repoRoot, 'pa', 'src', 'commands', 'catchup.ts'), 'utf8');

    // Scoped to the loop section, not the whole file: the pre-existing
    // one-shot budget-exceeded path calls exitFn(), whose PRODUCTION default
    // (defaultExitFn) is itself `process.exit(code)` — that is outside the
    // loop path this guard exists to protect and predates this wave.
    const marker = '// pa catchup --loop (2026-09-10 launch-cadence wave)';
    const loopSectionStart = src.indexOf(marker);
    assert.ok(loopSectionStart >= 0, 'the loop section marker must be present (source drifted?)');
    const loopSection = src.slice(loopSectionStart);

    const matches = loopSection.match(/process\.exit\(/g) ?? [];
    assert.equal(
      matches.length,
      0,
      'the catchup loop path must never call process.exit() directly — a leaked call here darkens every node --test file that reaches it',
    );

    // C4: the maintenance lane races the same budget as the one-shot path,
    // but on expiry it must log+notify+release and RETURN — never exitFn(),
    // whose production default is process.exit() and would tear down every
    // other lane's in-flight dispatch.
    const exitFnMatches = loopSection.match(/\bexitFn\(/g) ?? [];
    assert.equal(
      exitFnMatches.length,
      0,
      'the catchup loop path must never call exitFn() — a budget-exceeded maintenance tick must log, notify, release its lock and return, not exit the process',
    );

    // (a) loopExit is called exactly once, and only after resolveDone('store-stall').
    const loopExitMatches = [...loopSection.matchAll(/\bloopExit\(/g)];
    assert.equal(loopExitMatches.length, 1, 'loopExit must be called exactly once in the loop section');
    const resolveDoneIdx = loopSection.indexOf("resolveDone('store-stall')");
    assert.ok(resolveDoneIdx >= 0, "resolveDone('store-stall') must be present");
    assert.ok(loopExitMatches[0]!.index! > resolveDoneIdx, "loopExit must be called after resolveDone('store-stall')");

    // (b) defaultLoopExit is defined above the loop section.
    const defaultLoopExitIdx = src.indexOf('const defaultLoopExit');
    assert.ok(defaultLoopExitIdx >= 0, 'defaultLoopExit must be defined');
    assert.ok(defaultLoopExitIdx < loopSectionStart, 'defaultLoopExit must be defined above the loop section');

    // (c) runMaintenanceTick's own body never calls loopExit/exitFn/process.exit.
    const maintStart = src.indexOf('export async function runMaintenanceTick');
    const lockPathStart = src.indexOf('export function catchupLoopLockPath');
    assert.ok(maintStart >= 0 && lockPathStart >= 0 && maintStart < lockPathStart);
    const maintSlice = src.slice(maintStart, lockPathStart);
    assert.ok(!/loopExit\(/.test(maintSlice));
    assert.ok(!/exitFn\(/.test(maintSlice));
    assert.ok(!/process\.exit\(/.test(maintSlice));
  });

  describe('S7: fire-and-forget skill dispatch (2026-09-11)', () => {
    before(async () => {
      // Pin the concurrency limit explicitly (fix, 2026-09-12): this suite's
      // whole point is dispatching a SECOND skill while a first is still
      // running, which needs at least 2 free admission slots. Left to the
      // dynamic default, `workerSlotCount()` measures REAL live machine
      // pressure (CPU/disk/memory) — on a shared box also running other
      // sessions' builds/tests it was observed throttling to 1, at which
      // point the pre-existing, unrelated global concurrency-admission gate
      // (not S7's own activeSkillRuns mechanism) correctly makes the second
      // skill wait for a free slot behind the first — a confound this suite
      // must not depend on live system load to avoid.
      await createTempConfig(dir, [
        { name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e "0"' },
      ], { concurrency_limit: 8 });
    });

    it("a long fake skill in flight does not delay a second due skill's dispatch on the next tick", async () => {
      const { runCatchupTick } = await import('../src/commands/catchup.js');
      const release = join(dir, 'markers', 'wp3-release-1.flag');
      await createBlockingSkill('wp3-long-1', 'wp3-topic-1', release);

      await runCatchupTick('wp3-topic-1', { dispatchOnly: true });
      // Structural proof, not a wall-clock bound (a shared/loaded machine's
      // absolute timing is not reliable evidence either way): the skill can
      // only ever complete once released, so its marker being absent proves
      // the tick did not wait for it.
      assert.equal(readMarkerSync('wp3-long-1'), null, 'the blocking skill must still be running, unreleased');

      // A second, distinct skill becomes due in the same topic.
      await createMarkerSkill('wp3-quick-1', 'wp3-topic-1');

      await runCatchupTick('wp3-topic-1', { dispatchOnly: true });

      // wp3-long-1 is NEVER released during this window, so if the second
      // skill were somehow stuck behind it, this would time out — a
      // deterministic pass/fail, not a race against wall-clock.
      await waitFor(() => readMarkerSync('wp3-quick-1') !== null, 5000);

      // Clean up: release the blocking skill and let it finish.
      await writeFile(release, 'go', 'utf8');
      await waitFor(() => readMarkerSync('wp3-long-1') !== null, 5000);
      await new Promise((r) => setTimeout(r, 200));
    });

    it('the same skill, due again while still running, is skipped, then runs on the first tick after it completes', async () => {
      const { runCatchupTick } = await import('../src/commands/catchup.js');
      const release = join(dir, 'markers', 'wp3-release-2.flag');
      await createBlockingSkill('wp3-long-2', 'wp3-topic-2', release);

      await runCatchupTick('wp3-topic-2', { dispatchOnly: true }); // dispatches, stays blocked
      await runCatchupTick('wp3-topic-2', { dispatchOnly: true }); // must SKIP, not re-dispatch

      const entriesAfterSkip = await readAppLog();
      const skipLogs = entriesAfterSkip.filter(
        (e) => e.module === 'catchup' && e.skill === 'wp3-long-2'
          && String(e.message).includes("still running — skipped this tick"),
      );
      assert.equal(skipLogs.length, 1, 'the second tick must log the frozen E12 skip line exactly once, not re-dispatch');
      assert.equal(skipLogs[0]!.level, 'info', 'well within budget, the skip must log at info, not warn');

      // Release it: the fixture appends its marker and fails on purpose (never
      // a recorded success), so it stays overdue and — per AI-098 ladder rung
      // 0 — is immediately re-dispatchable once activeSkillRuns clears it.
      await writeFile(release, 'go', 'utf8');
      await waitFor(() => (readMarkerSync('wp3-long-2')?.split('\n').filter(Boolean).length ?? 0) >= 1, 5000);
      // Let the dispatched promise's own .finally actually clear activeSkillRuns.
      await new Promise((r) => setTimeout(r, 300));

      await runCatchupTick('wp3-topic-2', { dispatchOnly: true }); // must re-dispatch, not skip
      await waitFor(() => (readMarkerSync('wp3-long-2')?.split('\n').filter(Boolean).length ?? 0) >= 2, 5000);
    });

    it('runCatchupTick(lane, { dispatchOnly: true }) resolves well inside the fake skill\'s own duration', async () => {
      const { runCatchupTick } = await import('../src/commands/catchup.js');
      const release = join(dir, 'markers', 'wp3-release-3.flag');
      await createBlockingSkill('wp3-long-3', 'wp3-topic-3', release);

      await runCatchupTick('wp3-topic-3', { dispatchOnly: true });
      // Structural proof, not a wall-clock bound: the skill can only ever
      // complete once released (never done here before this check), so its
      // marker being absent proves the tick returned without waiting for it
      // — true regardless of how loaded the machine is.
      assert.equal(readMarkerSync('wp3-long-3'), null, 'the skill must still be running (blocked) after the tick already returned');

      await writeFile(release, 'go', 'utf8');
      await waitFor(() => readMarkerSync('wp3-long-3') !== null, 5000);
    });

    it('the one-shot path is unchanged: catchupCommand({ topic }) still awaits the skill to completion', async () => {
      const { catchupCommand } = await import('../src/commands/catchup.js');
      await createDelayedMarkerSkill('wp3-oneshot', 'wp3-topic-4', 400);

      const start = Date.now();
      await catchupCommand({ topic: 'wp3-topic-4' });
      const elapsed = Date.now() - start;

      assert.ok(elapsed >= 400, 'catchupCommand must still await the dispatched skill to completion, not return early (the same contract topic-partitioning.test.ts relies on)');
      assert.equal(await readMarker('wp3-oneshot'), 'wp3-oneshot\n', 'the skill must have completed by the time catchupCommand resolves');
    });

    it('C22: a skill still running past PA_CATCHUP_BUDGET_MS escalates to warn with ageMs and notifies once', async () => {
      const { runCatchupTick, _setExitForTest } = await import('../src/commands/catchup.js');
      const release = join(dir, 'markers', 'wp3-release-5.flag');
      await createBlockingSkill('wp3-stuck', 'wp3-topic-5', release);

      const originalBudget = process.env.PA_CATCHUP_BUDGET_MS;
      // 5s, not "a few hundred ms": comfortably clears the pre-existing ~1s
      // per-dispatch stagger sleep inside the SAME tick that dispatches the
      // skill (plus real subprocess-spawn variance on a shared/loaded
      // machine), so the outer per-tick wall-clock budget race (which
      // shares this same knob) does not itself fire mid-dispatch.
      // _setExitForTest is still installed as a defensive backstop
      // regardless.
      process.env.PA_CATCHUP_BUDGET_MS = '5000';
      const exitCalls: Array<number | undefined> = [];
      _setExitForTest((code) => { exitCalls.push(code); });
      try {
        await runCatchupTick('wp3-topic-5', { dispatchOnly: true }); // dispatches, stays blocked
        await new Promise((r) => setTimeout(r, 6000)); // now older than the 5000ms budget

        await runCatchupTick('wp3-topic-5', { dispatchOnly: true }); // must escalate to warn

        const entries = await readAppLog();
        const warnSkips = entries.filter(
          (e) => e.module === 'catchup' && e.skill === 'wp3-stuck'
            && String(e.message).includes('still running — skipped this tick'),
        );
        assert.equal(warnSkips.length, 1, 'the past-budget skip must be logged exactly once so far');
        assert.equal(warnSkips[0]!.level, 'warn', 'past the budget, the skip must escalate to warn');
        assert.ok(
          typeof warnSkips[0]!.ageMs === 'number' && (warnSkips[0]!.ageMs as number) >= 5000,
          'the warn log must carry an ageMs field at least the budget',
        );

        let sawNotify = false;
        for (let i = 0; i < 50 && !sawNotify; i++) {
          const notifyEntries = await readAppLog();
          sawNotify = notifyEntries.some(
            (e) => e.module === 'notify' && e.message === 'attempting' && String(e.subject).includes('wp3-stuck'),
          );
          if (!sawNotify) await new Promise((r) => setTimeout(r, 50));
        }
        assert.ok(sawNotify, 'the stuck-skill notify must fire (fire-and-forget, so polled rather than read once)');
      } finally {
        if (originalBudget === undefined) delete process.env.PA_CATCHUP_BUDGET_MS;
        else process.env.PA_CATCHUP_BUDGET_MS = originalBudget;
        _setExitForTest(null);
        assert.equal(exitCalls.length, 0, 'this case must never actually hit the exit path — it only proves the per-skill age escalation');

        await writeFile(release, 'go', 'utf8');
        await waitFor(() => readMarkerSync('wp3-stuck') !== null, 5000);
      }
    });
  });
});
