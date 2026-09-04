import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'fs/promises';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const KB = 1024;

describe('c-disk-floor-watchdog job', () => {
  let mod: typeof import('../src/lib/maintenance/jobs/c-disk-floor-watchdog.js');
  let paHomeDir: string;
  let scanDir: string;
  const origPaHome = process.env.PA_HOME;

  before(async () => {
    mod = await import('../src/lib/maintenance/jobs/c-disk-floor-watchdog.js');
    paHomeDir = mkdtempSync(join(tmpdir(), 'pa-cdisk-home-'));
    process.env.PA_HOME = paHomeDir;
    scanDir = mkdtempSync(join(tmpdir(), 'pa-cdisk-scan-'));
  });

  after(() => {
    if (origPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = origPaHome;
    rmSync(paHomeDir, { recursive: true, force: true });
    rmSync(scanDir, { recursive: true, force: true });
  });

  interface FloorState {
    wasBelow: boolean;
    lastCheckedAt: string;
    freeBytes?: number;
    lastAlertedAt?: string;
  }

  function deps(overrides: {
    freeBytes: number;
    readState?: FloorState | null;
    scanRoot?: string;
    scanBudgetMs?: number;
  }): { d: any; notifyCalls: { subject: string; body: string; opts: any }[]; saved: { current: FloorState | null } } {
    const notifyCalls: { subject: string; body: string; opts: any }[] = [];
    const saved: { current: FloorState | null } = { current: null };
    const d: any = {
      execFn: async () => ({ stdout: `${overrides.freeBytes}\r\n`, stderr: '' }),
      notifyFn: async (subject: string, body: string, opts: any) => {
        notifyCalls.push({ subject, body, opts });
        return { sent: true, suppressed: false };
      },
      readStateFn: async () => (overrides.readState === undefined ? null : overrides.readState),
      writeStateFn: async (s: FloorState) => {
        saved.current = s;
      },
      ...(overrides.scanRoot !== undefined ? { scanRoot: overrides.scanRoot } : {}),
      ...(overrides.scanBudgetMs !== undefined ? { scanBudgetMs: overrides.scanBudgetMs } : {}),
    };
    return { d, notifyCalls, saved };
  }

  const ctx = () => ({ now: 1_700_000_000_000, everyMs: 1_800_000 });

  it('declaration: observe-only shape, 30m cadence, pa host, no targets', () => {
    const job = mod.cDiskFloorWatchdogJob;
    assert.equal(job.name, 'c-disk-floor-watchdog');
    assert.equal(job.host, 'pa');
    assert.equal(job.everyMs, 1_800_000);
    assert.equal(job.destructive, false);
    assert.equal(job.shedWhenDegraded, true);
    assert.deepEqual(job.targets, []);
  });

  it('fires on the above-to-below crossing; alert carries floor, consumers, dedup opts', async () => {
    const a = join(scanDir, 'big-a');
    const b = join(scanDir, 'small-b');
    for (const dir of [a, b]) await mkdir(dir, { recursive: true });
    await writeFile(join(a, 'f.bin'), Buffer.alloc(6 * MB));
    await writeFile(join(b, 'f.bin'), Buffer.alloc(6 * KB));

    const { d, notifyCalls, saved } = deps({ freeBytes: 1_900_000_000, scanRoot: scanDir });
    const result = await mod.runCDiskFloorWatchdog(ctx(), d);

    assert.equal(result.touched, 1);
    assert.equal(result.detail!.below, true);
    assert.equal(result.detail!.wasBelow, false);
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].opts.dedupKey, 'c-disk-floor');
    assert.equal(notifyCalls[0].opts.escalate, false);
    assert.equal(notifyCalls[0].opts.severity, 'warn');
    assert.match(notifyCalls[0].body, /Free: 1\.8 GB \(floor 5\.0 GB\)/);
    const orderA = notifyCalls[0].body.indexOf('big-a');
    const orderB = notifyCalls[0].body.indexOf('small-b');
    assert.ok(orderA >= 0 && orderB > orderA, 'consumers listed largest-first');
    assert.equal(saved.current?.wasBelow, true);
    assert.equal(saved.current?.freeBytes, 1_900_000_000);
  });

  it('stays silent while the breach persists (wasBelow suppresses the re-page)', async () => {
    const { d, notifyCalls, saved } = deps({
      freeBytes: 2 * GB,
      readState: { wasBelow: true, lastCheckedAt: '2026-09-03T00:00:00.000Z' },
    });
    const result = await mod.runCDiskFloorWatchdog(ctx(), d);
    assert.equal(result.touched, 0);
    assert.equal(result.detail!.alerted, false);
    assert.equal(notifyCalls.length, 0);
    assert.equal(saved.current?.wasBelow, true, 'state re-stamped so the gate survives restarts');
  });

  it('re-arms above the floor and fires again on the NEXT crossing', async () => {
    const tick1 = deps({
      freeBytes: 9 * GB,
      readState: { wasBelow: true, lastCheckedAt: '2026-09-03T00:00:00.000Z' },
    });
    const r1 = await mod.runCDiskFloorWatchdog(ctx(), tick1.d);
    assert.equal(r1.touched, 0);
    assert.equal(tick1.saved.current?.wasBelow, false);

    const tick2 = deps({ freeBytes: 3 * GB, readState: tick1.saved.current! });
    const r2 = await mod.runCDiskFloorWatchdog(ctx(), tick2.d);
    assert.equal(r2.touched, 1, 'a re-crossing after recovery must alert again');
    assert.equal(tick2.notifyCalls.length, 1);
  });

  it('above the floor with no prior state: silent, state says above', async () => {
    const { d, notifyCalls, saved } = deps({ freeBytes: 40 * GB });
    const result = await mod.runCDiskFloorWatchdog(ctx(), d);
    assert.equal(result.touched, 0);
    assert.equal(notifyCalls.length, 0);
    assert.equal(saved.current?.wasBelow, false);
  });

  it('state write failure is non-fatal to the pass', async () => {
    const { d, notifyCalls } = deps({ freeBytes: 1 * GB });
    d.writeStateFn = async () => {
      throw new Error('write refused');
    };
    const result = await mod.runCDiskFloorWatchdog(ctx(), d);
    assert.equal(result.touched, 1);
    assert.equal(notifyCalls.length, 1);
  });

  it('free-space query failure throws (runner records failed; AI-098 backoff paces retries)', async () => {
    const { d, notifyCalls } = deps({ freeBytes: 40 * GB });
    d.execFn = async () => {
      throw new Error('spawn failed');
    };
    await assert.rejects(() => mod.runCDiskFloorWatchdog(ctx(), d), /free-space query failed/);
    assert.equal(notifyCalls.length, 0);
  });

  it('unparseable free-space output throws (no silent blind ticks)', async () => {
    const { d } = deps({ freeBytes: 40 * GB });
    d.execFn = async () => ({ stdout: 'Free (GB)\n---------\n', stderr: '' });
    await assert.rejects(() => mod.runCDiskFloorWatchdog(ctx(), d), /unparseable free-space output/);
  });

  it('consumer scan skips junctions/symlinks (worktree junctions must not be followed)', async () => {
    const a = join(scanDir, 'link-target');
    await mkdir(a, { recursive: true });
    await writeFile(join(a, 'f.bin'), Buffer.alloc(6 * MB));
    const link = join(scanDir, 'z-link');
    try {
      await symlink(a, link, 'junction');
    } catch {
      return; // platform denies junction creation — skip on this leg
    }
    const { d, notifyCalls } = deps({ freeBytes: 1 * GB, scanRoot: scanDir });
    await mod.runCDiskFloorWatchdog(ctx(), d);
    assert.equal(notifyCalls[0].body.includes('z-link'), false, 'junction must not appear as a consumer');
  });

  it('consumer scan: budget exhausted falls back to a manual-sweep line', async () => {
    const a = join(scanDir, 'budget-a');
    await mkdir(a, { recursive: true });
    await writeFile(join(a, 'f.bin'), Buffer.alloc(1024));

    const { d, notifyCalls } = deps({ freeBytes: 1 * GB, scanRoot: scanDir, scanBudgetMs: -1 });
    const result = await mod.runCDiskFloorWatchdog(ctx(), d);
    assert.equal(result.touched, 1);
    assert.match(notifyCalls[0].body, /sweep .* manually/);
  });

  it('parseFreeBytes tolerates CR/LF and rejects header text', () => {
    assert.equal(mod.parseFreeBytes('12345\r\n'), 12345);
    assert.equal(mod.parseFreeBytes('  987654321\n'), 987654321);
    assert.ok(Number.isNaN(mod.parseFreeBytes('Free (GB)\n')));
    assert.ok(Number.isNaN(mod.parseFreeBytes('')), 'empty stdout must throw, never read as 0');
  });

  it('default state functions round-trip through PA_HOME (durable across fresh processes)', async () => {
    const statePath = mod.cDiskFloorStatePath();
    assert.ok(statePath.startsWith(paHomeDir), 'state path lives under PA_HOME');
    await writeFile(statePath, JSON.stringify({ wasBelow: true, lastCheckedAt: '2026-09-03T00:00:00.000Z' }));
    const { d, notifyCalls } = deps({ freeBytes: GB });
    delete d.readStateFn;
    delete d.writeStateFn;
    const result = await mod.runCDiskFloorWatchdog(ctx(), d);
    assert.equal(result.touched, 0, 'durable wasBelow must suppress the re-page');
    assert.equal(notifyCalls.length, 0);
    const written = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(written.wasBelow, true);
    assert.equal(written.freeBytes, GB);
  });

  it('PA_CDISK_FLOOR_BYTES overrides the 5 GiB default (knob read per pass)', async () => {
    const saved = process.env.PA_CDISK_FLOOR_BYTES;
    process.env.PA_CDISK_FLOOR_BYTES = String(2 * GB);
    try {
      // 3 GB sits BELOW the built-in 5 GiB floor but ABOVE the knob floor: the
      // default would alert here, so silence proves the knob was actually read.
      const { d, notifyCalls, saved: state } = deps({ freeBytes: 3 * GB });
      const result = await mod.runCDiskFloorWatchdog(ctx(), d);
      assert.equal(result.touched, 0);
      assert.equal(result.detail!.below, false);
      assert.equal(result.detail!.floorBytes, 2 * GB);
      assert.equal(notifyCalls.length, 0);
      assert.equal(state.current?.wasBelow, false);
    } finally {
      if (saved === undefined) delete process.env.PA_CDISK_FLOOR_BYTES;
      else process.env.PA_CDISK_FLOOR_BYTES = saved;
    }
  });

  it('PA_CDISK_SCAN_ROOT names the consumers when no scanRoot dep is injected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pa-cdisk-envroot-'));
    try {
      const child = join(root, 'envknob-a');
      await mkdir(child, { recursive: true });
      await writeFile(join(child, 'f.bin'), Buffer.alloc(2 * KB));
      const saved = process.env.PA_CDISK_SCAN_ROOT;
      process.env.PA_CDISK_SCAN_ROOT = root;
      try {
        const { d, notifyCalls } = deps({ freeBytes: 1 * GB });
        await mod.runCDiskFloorWatchdog(ctx(), d);
        assert.equal(notifyCalls.length, 1);
        assert.ok(
          notifyCalls[0].body.includes('envknob-a'),
          'consumer listing must come from the env-knob scan root',
        );
      } finally {
        if (saved === undefined) delete process.env.PA_CDISK_SCAN_ROOT;
        else process.env.PA_CDISK_SCAN_ROOT = saved;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PA_CDISK_SCAN_BUDGET_MS exhausts the scan when no scanBudgetMs dep is injected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pa-cdisk-envbudget-'));
    try {
      const child = join(root, 'budget-env');
      await mkdir(child, { recursive: true });
      await writeFile(join(child, 'f.bin'), Buffer.alloc(1024));
      const saved = process.env.PA_CDISK_SCAN_BUDGET_MS;
      process.env.PA_CDISK_SCAN_BUDGET_MS = '-1';
      try {
        const { d, notifyCalls } = deps({ freeBytes: 1 * GB, scanRoot: root });
        await mod.runCDiskFloorWatchdog(ctx(), d);
        assert.equal(notifyCalls.length, 1);
        assert.match(notifyCalls[0].body, /sweep .* manually/);
      } finally {
        if (saved === undefined) delete process.env.PA_CDISK_SCAN_BUDGET_MS;
        else process.env.PA_CDISK_SCAN_BUDGET_MS = saved;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
