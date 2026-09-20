import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'fs/promises';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import osMod = require('os');

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

describe('nonpaged-pool-watch (2026-09-10 launch-cadence wave)', () => {
  let mod: typeof import('../src/lib/maintenance/jobs/nonpaged-pool-watch.js');
  let paHomeDir: string;
  const origPaHome = process.env.PA_HOME;

  before(async () => {
    mod = await import('../src/lib/maintenance/jobs/nonpaged-pool-watch.js');
    paHomeDir = mkdtempSync(join(tmpdir(), 'pa-poolwatch-home-'));
    process.env.PA_HOME = paHomeDir;
  });

  after(() => {
    if (origPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = origPaHome;
    rmSync(paHomeDir, { recursive: true, force: true });
  });

  type PoolState = import('../src/lib/maintenance/jobs/nonpaged-pool-watch.js').PoolState;
  type PoolSample = import('../src/lib/maintenance/jobs/nonpaged-pool-watch.js').PoolSample;

  function sample(totalNonpagedBytes: number, top: PoolSample['top'] = []): PoolSample {
    return {
      totalNonpagedBytes,
      totalPagedBytes: 0,
      tagCount: top.length,
      top,
    };
  }

  function deps(overrides: {
    sample: PoolSample;
    readState?: PoolState | null;
  }): { d: any; notifyCalls: { subject: string; body: string; opts: any }[]; saved: { current: PoolState | null } } {
    const notifyCalls: { subject: string; body: string; opts: any }[] = [];
    const saved: { current: PoolState | null } = { current: null };
    const d: any = {
      sampleFn: async () => overrides.sample,
      notifyFn: async (subject: string, body: string, opts: any) => {
        notifyCalls.push({ subject, body, opts });
        return { sent: true, suppressed: false };
      },
      readStateFn: async () => (overrides.readState === undefined ? null : overrides.readState),
      writeStateFn: async (s: PoolState) => {
        saved.current = s;
      },
    };
    return { d, notifyCalls, saved };
  }

  const T0 = 1_700_000_000_000;
  const ctx = (now = T0) => ({ now, everyMs: 900_000 });

  it('declaration: observe-only shape, 15m cadence, pa host, no targets', () => {
    const job = mod.nonpagedPoolWatchJob;
    assert.equal(job.name, 'nonpaged-pool-watch');
    assert.equal(job.host, 'pa');
    assert.equal(job.everyMs, 15 * 60_000);
    assert.equal(job.destructive, false);
    assert.equal(job.shedWhenDegraded, true);
    assert.deepEqual(job.targets, []);
  });

  it('1. below both thresholds, no baseline: no alert, baseline written', async () => {
    const { d, notifyCalls, saved } = deps({
      sample: sample(1 * GB, [{ tag: 'NtFC', nonpagedBytes: 1 * GB, nonpagedAllocs: 10, nonpagedFrees: 5 }]),
    });
    const result = await mod.runNonpagedPoolWatch(ctx(), d);
    assert.equal(result.touched, 0);
    assert.equal(notifyCalls.length, 0);
    assert.equal(saved.current?.wasAlerting, false);
    assert.equal(saved.current?.baselineBytes, 1 * GB);
    assert.equal(saved.current?.totalBytes, 1 * GB);
  });

  it('2. crossing the absolute floor fires exactly one alert with dedupKey nonpaged-pool', async () => {
    const { d, notifyCalls, saved } = deps({
      sample: sample(4 * GB, [{ tag: 'NtFC', nonpagedBytes: 4 * GB, nonpagedAllocs: 10, nonpagedFrees: 5 }]),
    });
    const result = await mod.runNonpagedPoolWatch(ctx(), d);
    assert.equal(result.touched, 1);
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].opts.dedupKey, 'nonpaged-pool');
    assert.equal(notifyCalls[0].opts.severity, 'warn');
    assert.equal(notifyCalls[0].opts.escalate, false);
    assert.match(notifyCalls[0].body, /Total: 4\.0 GB \(floor 3\.0 GB\)/);
    assert.match(notifyCalls[0].body, /growth: no baseline yet/);
    assert.equal(saved.current?.wasAlerting, true);
  });

  it('3. still above the floor on the next pass fires NOTHING (transition gate)', async () => {
    const tick1 = deps({ sample: sample(4 * GB) });
    const r1 = await mod.runNonpagedPoolWatch(ctx(T0), tick1.d);
    assert.equal(r1.touched, 1);

    const tick2 = deps({ sample: sample(5 * GB), readState: tick1.saved.current! });
    const r2 = await mod.runNonpagedPoolWatch(ctx(T0 + 20 * 60_000), tick2.d);
    assert.equal(r2.touched, 0);
    assert.equal(tick2.notifyCalls.length, 0);
    assert.equal(tick2.saved.current?.wasAlerting, true);
  });

  it('4. dropping below the floor re-arms, and a later crossing fires again', async () => {
    const alerting = deps({ sample: sample(4 * GB) });
    const r1 = await mod.runNonpagedPoolWatch(ctx(T0), alerting.d);
    assert.equal(r1.touched, 1);

    const drop = deps({ sample: sample(1 * GB), readState: alerting.saved.current! });
    const r2 = await mod.runNonpagedPoolWatch(ctx(T0 + 60_000), drop.d);
    assert.equal(r2.touched, 0);
    assert.equal(drop.saved.current?.wasAlerting, false);

    const reCross = deps({ sample: sample(4 * GB), readState: drop.saved.current! });
    const r3 = await mod.runNonpagedPoolWatch(ctx(T0 + 120_000), reCross.d);
    assert.equal(r3.touched, 1, 're-crossing after recovery must alert again');
    assert.equal(reCross.notifyCalls.length, 1);
  });

  it('5. growth alone crosses: total under the floor but climbing past the rate fires one alert', async () => {
    const baseline = deps({ sample: sample(1 * GB) });
    const r1 = await mod.runNonpagedPoolWatch(ctx(T0), baseline.d);
    assert.equal(r1.touched, 0);

    // 50 MiB over 20 minutes = 150 MiB/h, above the 100 MiB/h default growth
    // knob, while the total (1 GB + 50 MiB) stays far under the 3 GiB floor.
    const grown = deps({ sample: sample(1 * GB + 50 * MB), readState: baseline.saved.current! });
    const r2 = await mod.runNonpagedPoolWatch(ctx(T0 + 20 * 60_000), grown.d);
    assert.equal(r2.touched, 1);
    assert.equal(grown.notifyCalls.length, 1);
    assert.match(grown.notifyCalls[0].body, /Growth: \+150\.0 MB\/h over the last 20 min/);
    assert.equal(r2.detail!.alerting, true);
  });

  it('6. a window SHORTER than the minimum evaluates no growth and carries the baseline forward', async () => {
    const baseline = deps({ sample: sample(1 * GB) });
    const r1 = await mod.runNonpagedPoolWatch(ctx(T0), baseline.d);
    assert.equal(r1.touched, 0);
    const baselineState = baseline.saved.current!;

    // 2 minutes < the 10-minute default PA_POOL_NONPAGED_MIN_WINDOW_MS.
    const tooSoon = deps({ sample: sample(1 * GB + 500 * MB), readState: baselineState });
    const r2 = await mod.runNonpagedPoolWatch(ctx(T0 + 2 * 60_000), tooSoon.d);
    assert.equal(r2.touched, 0, 'still under the floor and growth is undefined this early');
    assert.equal(r2.detail!.growth, undefined);
    assert.equal(tooSoon.saved.current?.baselineAt, baselineState.baselineAt);
    assert.equal(tooSoon.saved.current?.baselineBytes, baselineState.baselineBytes);
  });

  it('7. 2.5 GiB fires the EARLY family; a reboot drop re-arms it and a re-cross fires again', async () => {
    // 2.5 GiB sits above the 1.5 GiB early floor but below the 3 GiB main
    // floor, with no baseline (so no growth): the early family fires.
    const high = deps({ sample: sample(2.5 * GB) });
    const r1 = await mod.runNonpagedPoolWatch(ctx(T0), high.d);
    assert.equal(r1.touched, 1);
    assert.equal(high.notifyCalls.length, 1);
    assert.equal(high.notifyCalls[0].opts.dedupKey, 'nonpaged-pool-early');
    const highState = high.saved.current!;
    assert.equal(highState.baselineBytes, 2.5 * GB);
    assert.equal(highState.wasEarlyAlerting, true);

    // A reboot: total drops far below the stored baseline, well inside the
    // minimum window — the reset must NOT wait for the window.
    const rebooted = deps({ sample: sample(200 * MB), readState: highState });
    const r2 = await mod.runNonpagedPoolWatch(ctx(T0 + 30_000), rebooted.d);
    assert.equal(r2.touched, 0);
    assert.equal(r2.detail!.growth, undefined);
    assert.equal(rebooted.saved.current?.baselineBytes, 200 * MB);
    assert.notEqual(rebooted.saved.current?.baselineAt, highState.baselineAt);
    assert.equal(rebooted.saved.current?.wasEarlyAlerting, false);

    // Re-crossing the early floor after the drop fires the early family again.
    const reCross = deps({ sample: sample(2.0 * GB), readState: rebooted.saved.current! });
    const r3 = await mod.runNonpagedPoolWatch(ctx(T0 + 120_000), reCross.d);
    assert.equal(r3.touched, 1, 're-crossing the early floor after recovery must alert again');
    assert.equal(reCross.notifyCalls.length, 1);
    assert.equal(reCross.notifyCalls[0].opts.dedupKey, 'nonpaged-pool-early');
    assert.equal(reCross.saved.current?.wasEarlyAlerting, true);
  });

  it('8. the body names the top tag with its GB figure', async () => {
    const { d, notifyCalls } = deps({
      sample: sample(3.5 * GB, [{ tag: 'NtFC', nonpagedBytes: 3.5 * GB, nonpagedAllocs: 900, nonpagedFrees: 100 }]),
    });
    const result = await mod.runNonpagedPoolWatch(ctx(), d);
    assert.equal(result.touched, 1);
    assert.match(notifyCalls[0].body, /NtFC\s+3\.5 GB/);
  });

  it('9. a rejecting sampleFn, and one resolving unparseable output, both make the job REJECT', async () => {
    const rejecting = deps({ sample: sample(1 * GB) });
    rejecting.d.sampleFn = async () => {
      throw new Error('spawn failed');
    };
    await assert.rejects(() => mod.runNonpagedPoolWatch(ctx(), rejecting.d), /spawn failed/);
    assert.equal(rejecting.notifyCalls.length, 0);

    const garbage = deps({ sample: sample(1 * GB) });
    garbage.d.sampleFn = async () => ({ garbage: true }) as any;
    await assert.rejects(
      () => mod.runNonpagedPoolWatch(ctx(), garbage.d),
      /invalid PoolSample/,
      'unparseable/garbage sample data must reject, never resolve with touched: 0',
    );
    assert.equal(garbage.notifyCalls.length, 0);
  });

  it("10. platform() !== 'win32' returns the skip result without ever calling a sampler", async () => {
    const originalPlatform = osMod.platform;
    (osMod as any).platform = () => 'linux';
    try {
      const result = await mod.runNonpagedPoolWatch(ctx());
      assert.deepEqual(result, { touched: 0, detail: { skipped: 'non-win32' } });
    } finally {
      (osMod as any).platform = originalPlatform;
    }
  });

  it('11. corrupt state on disk reads as "was not alerting" and the next crossing still fires', async () => {
    const statePath = mod.nonpagedPoolStatePath();
    assert.ok(statePath.startsWith(paHomeDir), 'state path lives under PA_HOME');
    await writeFile(statePath, '{ not valid json');

    const { d, notifyCalls } = deps({ sample: sample(4 * GB) });
    delete d.readStateFn;
    delete d.writeStateFn;
    const result = await mod.runNonpagedPoolWatch(ctx(), d);
    assert.equal(result.touched, 1, 'corrupt state must read as "was not alerting", so the crossing still fires');
    assert.equal(notifyCalls.length, 1);

    const written = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(written.wasAlerting, true);
    assert.equal(written.totalBytes, 4 * GB);
  });

  it('12. env knobs are read per pass (PA_POOL_NONPAGED_ALERT_BYTES)', async () => {
    const saved = process.env.PA_POOL_NONPAGED_ALERT_BYTES;
    try {
      process.env.PA_POOL_NONPAGED_ALERT_BYTES = String(2 * GB);
      // 2.5 GB sits BELOW the built-in 3 GiB default but ABOVE the 2 GiB knob:
      // the default would stay silent here, so an alert proves the knob was read.
      const first = deps({ sample: sample(2.5 * GB) });
      const r1 = await mod.runNonpagedPoolWatch(ctx(T0), first.d);
      assert.equal(r1.touched, 1);
      assert.equal(r1.detail!.alertBytes, 2 * GB);

      process.env.PA_POOL_NONPAGED_ALERT_BYTES = String(3 * GB);
      const second = deps({ sample: sample(2.5 * GB), readState: first.saved.current! });
      const r2 = await mod.runNonpagedPoolWatch(ctx(T0 + 60_000), second.d);
      assert.equal(r2.touched, 0, 'same 2.5 GB reading must NOT alert once the knob reverts to the 3 GiB default');
      assert.equal(r2.detail!.alertBytes, 3 * GB);
    } finally {
      if (saved === undefined) delete process.env.PA_POOL_NONPAGED_ALERT_BYTES;
      else process.env.PA_POOL_NONPAGED_ALERT_BYTES = saved;
    }
  });

  it('13. per-tag rate pairs with the latest sample, not the baseline, when the baseline was carried forward', async () => {
    // Three ticks, constructed so "elapsed since prev.lastSampleAt" (reading
    // a, what the code does) and "elapsed since prev.baselineAt" (reading b)
    // DIVERGE, so a rate line pairing with the wrong one is caught, not just
    // one that happens to agree with both:
    //   tick1 (T0):        baseline set, lastSampleAt = T0.
    //   tick2 (T0+2min):   window (2min) < the 10min default minimum, so the
    //                      baseline is carried forward UNCHANGED (baselineAt
    //                      stays T0) while lastSampleAt still advances to
    //                      T0+2min every pass, regardless of the baseline
    //                      branch -- this is the gap between the two readings.
    //   tick3 (T0+20min):  crosses the absolute floor and alerts. Its
    //                      per-tag rate must divide by the 18-minute gap
    //                      since tick2's lastSampleAt (reading a), not the
    //                      20-minute gap since tick1's baselineAt (reading b).
    const tick1 = deps({
      sample: sample(1 * GB, [{ tag: 'NtFC', nonpagedBytes: 500 * MB, nonpagedAllocs: 10, nonpagedFrees: 5 }]),
    });
    const r1 = await mod.runNonpagedPoolWatch(ctx(T0), tick1.d);
    assert.equal(r1.touched, 0);

    const tick2 = deps({
      sample: sample(1.2 * GB, [{ tag: 'NtFC', nonpagedBytes: 600 * MB, nonpagedAllocs: 10, nonpagedFrees: 5 }]),
      readState: tick1.saved.current!,
    });
    const r2 = await mod.runNonpagedPoolWatch(ctx(T0 + 2 * 60_000), tick2.d);
    assert.equal(r2.touched, 0, 'still under the floor, and growth is undefined inside the minimum window');
    assert.equal(tick2.saved.current?.baselineAt, tick1.saved.current?.baselineAt, 'baseline carried forward unchanged');
    assert.notEqual(tick2.saved.current?.lastSampleAt, tick1.saved.current?.lastSampleAt, 'lastSampleAt still advances');

    const tick3 = deps({
      sample: sample(4 * GB, [{ tag: 'NtFC', nonpagedBytes: 900 * MB, nonpagedAllocs: 10, nonpagedFrees: 5 }]),
      readState: tick2.saved.current!,
    });
    const r3 = await mod.runNonpagedPoolWatch(ctx(T0 + 20 * 60_000), tick3.d);
    assert.equal(r3.touched, 1);
    assert.equal(tick3.notifyCalls.length, 1);
    // Reading (a): (900MB - 600MB) / (18 min / 60) = +1000.0 MB/h.
    // Reading (b) would instead divide by the 20-minute baseline gap and
    // print +900.0 MB/h -- asserting the exact figure below fails under (b).
    assert.match(
      tick3.notifyCalls[0].body,
      /NtFC\s+0\.9 GB\s+\(\+1000\.0 MB\/h\)/,
      `expected the rate paired with the latest sample (18min gap, +1000.0 MB/h), got:\n${tick3.notifyCalls[0].body}`,
    );
    assert.doesNotMatch(tick3.notifyCalls[0].body, /\+900\.0 MB\/h/, 'must not pair the rate with the baseline sample instead');
  });

  it('14. the early floor is inclusive: exactly 1610612736 (1.5 GiB) fires the early family', async () => {
    const { d, notifyCalls, saved } = deps({ sample: sample(1610612736) });
    const result = await mod.runNonpagedPoolWatch(ctx(T0), d);
    assert.equal(result.touched, 1);
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].opts.dedupKey, 'nonpaged-pool-early');
    assert.equal(notifyCalls[0].opts.severity, 'warn');
    assert.equal(notifyCalls[0].opts.escalate, false);
    assert.match(notifyCalls[0].body, /early-warning 1\.5 GB; floor 3\.0 GB/);
    assert.equal(saved.current?.wasEarlyAlerting, true);
    assert.equal(saved.current?.wasAlerting, false);
  });

  it('15. env knob PA_POOL_NONPAGED_EARLY_BYTES is read per pass', async () => {
    const savedEnv = process.env.PA_POOL_NONPAGED_EARLY_BYTES;
    try {
      process.env.PA_POOL_NONPAGED_EARLY_BYTES = String(2 * GB);
      // 1.8 GiB sits ABOVE the built-in 1.5 GiB early default but BELOW the
      // 2 GiB knob: the default would fire here, so silence proves the knob.
      const { d, notifyCalls } = deps({ sample: sample(1.8 * GB) });
      const result = await mod.runNonpagedPoolWatch(ctx(T0), d);
      assert.equal(result.touched, 0);
      assert.equal(notifyCalls.length, 0);
      assert.equal(result.detail!.earlyBytes, 2 * GB);
    } finally {
      if (savedEnv === undefined) delete process.env.PA_POOL_NONPAGED_EARLY_BYTES;
      else process.env.PA_POOL_NONPAGED_EARLY_BYTES = savedEnv;
    }
  });

  it('16. growth under the early floor stays main-only (dedupKey nonpaged-pool)', async () => {
    const baseline = deps({ sample: sample(1 * GB) });
    const r1 = await mod.runNonpagedPoolWatch(ctx(T0), baseline.d);
    assert.equal(r1.touched, 0);

    // 50 MiB over 20 minutes = 150 MiB/h, above the 100 MiB/h default growth
    // knob, while the total (1 GB + 50 MiB ≈ 1.05 GiB) stays under the
    // 1.5 GiB early floor: only the main family may fire.
    const grown = deps({ sample: sample(1 * GB + 50 * MB), readState: baseline.saved.current! });
    const r2 = await mod.runNonpagedPoolWatch(ctx(T0 + 20 * 60_000), grown.d);
    assert.equal(r2.touched, 1);
    assert.equal(grown.notifyCalls.length, 1);
    assert.equal(grown.notifyCalls[0].opts.dedupKey, 'nonpaged-pool');
    assert.equal(r2.detail!.earlyAlerting, false);
    assert.equal(r2.detail!.earlyAlerted, false);
  });
});
