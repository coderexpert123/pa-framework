import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { validateRegistry } from '../src/lib/maintenance/policy.js';
import { paHome } from '../src/paths.js';
import type { DispatchWindow, CloseResult } from '../src/lib/worker-edit-audit.js';

// Tests use the runWorkerEditAuditSweep(deps) DI seam — ESM module namespaces
// are read-only, so dependencies are injected rather than mocked (the pattern
// the maintenance jobs' tests follow, e.g. tests/clobber-sentinel.test.ts).
// A window's `closeWindowFn` is always injected here — the REAL closeWindow
// would shell real `git status` against this repo's live tree and could send
// a real notify; the sweeper's own unit tests must never do either.

function fixtureWindow(overrides: Partial<DispatchWindow> = {}): DispatchWindow {
  return {
    id: 'w-aaaaaaaaaaaa',
    resource: 'topic-1_1',
    worker: null,
    startedAt: Date.now(),
    botPid: 11111,
    before: { headSha: 'sha-1', entries: {} },
    reservedAtStart: [],
    ...overrides,
  };
}

async function writeWindowFile(dir: string, win: DispatchWindow): Promise<void> {
  const windowDir = join(dir, 'worker-edit-audit');
  await mkdir(windowDir, { recursive: true });
  await writeFile(join(windowDir, `${win.id}.json`), JSON.stringify(win), 'utf8');
}

async function listWindowFilesOnDisk(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, 'worker-edit-audit'))).filter((f) => f.startsWith('w-'));
  } catch {
    return [];
  }
}

describe('worker-edit-audit-sweep', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    delete process.env.PA_WORKER_EDIT_WINDOW_MAX_MS;
    await cleanup(dir);
  });

  it('returns touched: 0 with no windows open', async () => {
    const { runWorkerEditAuditSweep } = await import('../src/lib/maintenance/jobs/worker-edit-audit-sweep.js');
    const result = await runWorkerEditAuditSweep({
      listOpenWindowsFn: async () => [],
      closeWindowFn: async () => { throw new Error('must not be called'); },
      areProcessesAliveFn: async () => { throw new Error('must not be called'); },
    });
    assert.deepEqual(result, { touched: 0 });
  });

  it('closes a window whose botPid is dead on the first pass', async () => {
    const { runWorkerEditAuditSweep } = await import('../src/lib/maintenance/jobs/worker-edit-audit-sweep.js');
    const win = fixtureWindow({ botPid: 22222, startedAt: Date.now() });
    let closeCalls = 0;

    const result = await runWorkerEditAuditSweep({
      listOpenWindowsFn: async () => [win],
      closeWindowFn: async (w) => { closeCalls++; assert.equal(w.id, win.id); return { findings: [], notified: false, concurrentWindows: 0 }; },
      areProcessesAliveFn: async (pids) => new Map(pids.map((p) => [p, false])), // dead
    });

    assert.equal(closeCalls, 1);
    assert.equal(result.touched, 1);
    assert.deepEqual(result.detail, { open: 1, closed: 1, notified: 0 });
  });

  it('leaves a window alone when its botPid is alive and younger than PA_WORKER_EDIT_WINDOW_MAX_MS — touched: 0, file still present', async () => {
    const win = fixtureWindow({ id: 'w-bbbbbbbbbbbb', botPid: 33333, startedAt: Date.now() - 1000 });
    await writeWindowFile(dir, win);

    const { listOpenWindows } = await import('../src/lib/worker-edit-audit.js');
    const { runWorkerEditAuditSweep } = await import('../src/lib/maintenance/jobs/worker-edit-audit-sweep.js');

    let closeCalls = 0;
    const result = await runWorkerEditAuditSweep({
      listOpenWindowsFn: listOpenWindows, // real — reads the disk file just written
      closeWindowFn: async () => { closeCalls++; return { findings: [], notified: false, concurrentWindows: 0 }; },
      areProcessesAliveFn: async (pids) => new Map(pids.map((p) => [p, true])), // alive
      now: Date.now(),
    });

    assert.equal(closeCalls, 0);
    assert.equal(result.touched, 0);
    assert.deepEqual(await listWindowFilesOnDisk(dir), ['w-bbbbbbbbbbbb.json']);
  });

  it('closes the same window once its age exceeds PA_WORKER_EDIT_WINDOW_MAX_MS while still alive', async () => {
    const { runWorkerEditAuditSweep } = await import('../src/lib/maintenance/jobs/worker-edit-audit-sweep.js');
    const startedAt = Date.now();
    const win = fixtureWindow({ id: 'w-cccccccccccc', botPid: 44444, startedAt });
    let closeCalls = 0;

    // Younger than the 2h default — left alone.
    const early = await runWorkerEditAuditSweep({
      listOpenWindowsFn: async () => [win],
      closeWindowFn: async () => { closeCalls++; return { findings: [], notified: false, concurrentWindows: 0 }; },
      areProcessesAliveFn: async (pids) => new Map(pids.map((p) => [p, true])),
      now: startedAt + 1000,
    });
    assert.equal(early.touched, 0);
    assert.equal(closeCalls, 0);

    // Past PA_WORKER_EDIT_WINDOW_MAX_MS (2h default) while still alive — closed.
    const late = await runWorkerEditAuditSweep({
      listOpenWindowsFn: async () => [win],
      closeWindowFn: async () => { closeCalls++; return { findings: [], notified: false, concurrentWindows: 0 }; },
      areProcessesAliveFn: async (pids) => new Map(pids.map((p) => [p, true])),
      now: startedAt + 7_200_001,
    });
    assert.equal(late.touched, 1);
    assert.equal(closeCalls, 1);
  });

  it('respects a custom PA_WORKER_EDIT_WINDOW_MAX_MS', async () => {
    process.env.PA_WORKER_EDIT_WINDOW_MAX_MS = '1000';
    const { runWorkerEditAuditSweep } = await import('../src/lib/maintenance/jobs/worker-edit-audit-sweep.js');
    const startedAt = Date.now();
    const win = fixtureWindow({ botPid: 55555, startedAt });

    const result = await runWorkerEditAuditSweep({
      listOpenWindowsFn: async () => [win],
      closeWindowFn: async () => ({ findings: [], notified: false, concurrentWindows: 0 }),
      areProcessesAliveFn: async (pids) => new Map(pids.map((p) => [p, true])),
      now: startedAt + 1001,
    });
    assert.equal(result.touched, 1);
  });

  it('calls areProcessesAlive exactly once for a pass with three windows across two PIDs', async () => {
    const { runWorkerEditAuditSweep } = await import('../src/lib/maintenance/jobs/worker-edit-audit-sweep.js');
    const w1 = fixtureWindow({ id: 'w-100000000001', botPid: 100 });
    const w2 = fixtureWindow({ id: 'w-100000000002', botPid: 100 });
    const w3 = fixtureWindow({ id: 'w-100000000003', botPid: 200 });

    let aliveCalls = 0;
    let capturedPids: number[] = [];
    const result = await runWorkerEditAuditSweep({
      listOpenWindowsFn: async () => [w1, w2, w3],
      closeWindowFn: async () => ({ findings: [], notified: false, concurrentWindows: 0 }),
      areProcessesAliveFn: async (pids) => {
        aliveCalls++;
        capturedPids = pids;
        return new Map(pids.map((p) => [p, false]));
      },
    });

    assert.equal(aliveCalls, 1, 'areProcessesAlive must be called exactly once per pass, not once per window');
    assert.deepEqual(capturedPids.slice().sort(), [100, 200]);
    assert.equal(result.touched, 3);
  });

  it('a closeWindow that rejects for one window does not prevent the others from closing', async () => {
    const { runWorkerEditAuditSweep } = await import('../src/lib/maintenance/jobs/worker-edit-audit-sweep.js');
    const w1 = fixtureWindow({ id: 'w-200000000001', botPid: 300 });
    const w2 = fixtureWindow({ id: 'w-200000000002', botPid: 301 });
    const w3 = fixtureWindow({ id: 'w-200000000003', botPid: 302 });

    const closedIds: string[] = [];
    const result = await runWorkerEditAuditSweep({
      listOpenWindowsFn: async () => [w1, w2, w3],
      closeWindowFn: async (w): Promise<CloseResult> => {
        if (w.id === w2.id) throw new Error('simulated closeWindow failure');
        closedIds.push(w.id);
        return { findings: [], notified: false, concurrentWindows: 0 };
      },
      areProcessesAliveFn: async (pids) => new Map(pids.map((p) => [p, false])),
    });

    assert.deepEqual(closedIds.sort(), [w1.id, w3.id].sort());
    assert.equal(result.touched, 2, 'the failing window must not be counted, but must not block the others either');
  });

  it('counts a notified close in the detail.notified tally', async () => {
    const { runWorkerEditAuditSweep } = await import('../src/lib/maintenance/jobs/worker-edit-audit-sweep.js');
    const win = fixtureWindow({ botPid: 400 });

    const result = await runWorkerEditAuditSweep({
      listOpenWindowsFn: async () => [win],
      closeWindowFn: async () => ({ findings: [{ path: 'a.ts', kind: 'modified' }], notified: true, concurrentWindows: 0 }),
      areProcessesAliveFn: async (pids) => new Map(pids.map((p) => [p, false])),
    });

    assert.equal(result.touched, 1);
    assert.deepEqual(result.detail, { open: 1, closed: 1, notified: 1 });
  });

  describe('workerEditAuditSweepJob declaration', () => {
    it('passes validateRegistry and resolves its target under paHome()', async () => {
      const { workerEditAuditSweepJob } = await import('../src/lib/maintenance/jobs/worker-edit-audit-sweep.js');
      assert.doesNotThrow(() => validateRegistry([workerEditAuditSweepJob]));

      assert.equal(workerEditAuditSweepJob.name, 'worker-edit-audit-sweep');
      assert.equal(workerEditAuditSweepJob.host, 'pa');
      assert.equal(workerEditAuditSweepJob.everyMs, 15 * 60 * 1000);
      assert.equal(workerEditAuditSweepJob.destructive, true);
      assert.equal(workerEditAuditSweepJob.shedWhenDegraded, true);
      assert.equal(workerEditAuditSweepJob.targets.length, 1);

      const target = workerEditAuditSweepJob.targets[0];
      assert.equal(target.resolve(), join(paHome(), 'worker-edit-audit'));
      assert.ok(target.match.test('w-aaaaaaaaaaaa.json'));
      assert.ok(target.match.test('alert-count.json'));
      assert.equal(target.match.test('other.json'), false);
      assert.ok(target.note, 'liveness-based selection must be declared in the target note');
    });
  });
});
