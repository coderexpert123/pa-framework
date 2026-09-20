import './test-env-guard.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCeiling, effectiveSlotCount, noteQuotaBurst, _resetForTest, _setDepsForTest, _governorForTest } from '../src/lib/dynamic-slots.js';
import type { PressureSample } from '../src/lib/pressure-sample.js';

function clean(sampledAtMs: number): PressureSample {
  return { physFreeMb: 5000, cpuPct: 10, diskQueue: 0, sampledAtMs };
}
function pressuredPhys(sampledAtMs: number): PressureSample {
  return { physFreeMb: 100, cpuPct: 10, diskQueue: 0, sampledAtMs };
}
function pressuredCpu(sampledAtMs: number): PressureSample {
  return { physFreeMb: 5000, cpuPct: 95, diskQueue: 0, sampledAtMs };
}
function pressuredDisk(sampledAtMs: number): PressureSample {
  return { physFreeMb: 5000, cpuPct: 10, diskQueue: 9, sampledAtMs };
}

beforeEach(() => {
  _resetForTest();
  // Hard structural guard: no test in this file may reach the real sampler,
  // which spawns PowerShell and would make results machine-dependent.
  _setDepsForTest({ readSample: () => null, cpuCount: () => 12 });
  // The operator's Windows User env carries PA_SLOTS_MIN and PA_MAX_CONCURRENT_WORKERS,
  // which every locally spawned process inherits and DEPLOYMENT_ENV_SCRUB does not
  // strip. Delete them so the file is hermetic.
  for (const k of ['PA_DYNAMIC_SLOTS','PA_SLOTS_MIN','PA_MAX_CONCURRENT_WORKERS','PA_SLOTS_PHYSICAL_BRAKE_MB','PA_SLOTS_CPU_BRAKE_PCT','PA_SLOTS_DISK_QUEUE_BRAKE']) delete process.env[k];
});
afterEach(() => {
  _resetForTest();
  for (const k of ['PA_DYNAMIC_SLOTS','PA_SLOTS_MIN','PA_MAX_CONCURRENT_WORKERS','PA_SLOTS_PHYSICAL_BRAKE_MB','PA_SLOTS_CPU_BRAKE_PCT','PA_SLOTS_DISK_QUEUE_BRAKE']) delete process.env[k];
});

describe('resolveCeiling', () => {
  it('an explicit env value wins verbatim', () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = '17';
    _setDepsForTest({ cpuCount: () => 12 });
    assert.deepEqual(resolveCeiling(), { ceiling: 17, origin: 'env' });
  });

  it('a non-positive env value is honored and means disabled', () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = '0';
    assert.deepEqual(resolveCeiling(), { ceiling: 0, origin: 'env' });
    process.env.PA_MAX_CONCURRENT_WORKERS = '-5';
    assert.deepEqual(resolveCeiling(), { ceiling: -5, origin: 'env' });
  });

  it('unset derives from cores, clamped to at least 4', () => {
    delete process.env.PA_MAX_CONCURRENT_WORKERS;
    _setDepsForTest({ cpuCount: () => 1 });
    assert.deepEqual(resolveCeiling(), { ceiling: 4, origin: 'derived' });
  });

  it('unset derives from cores, clamped to at most 64', () => {
    delete process.env.PA_MAX_CONCURRENT_WORKERS;
    _setDepsForTest({ cpuCount: () => 64 });
    assert.deepEqual(resolveCeiling(), { ceiling: 64, origin: 'derived' });
  });

  it('unset with the kill switch on returns the legacy static 3', () => {
    delete process.env.PA_MAX_CONCURRENT_WORKERS;
    process.env.PA_DYNAMIC_SLOTS = '0';
    _setDepsForTest({ cpuCount: () => 12 });
    assert.deepEqual(resolveCeiling(), { ceiling: 3, origin: 'legacy' });
  });

  it('garbage env falls through to the derived ceiling', () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = 'nonsense';
    _setDepsForTest({ cpuCount: () => 12 });
    assert.deepEqual(resolveCeiling(), { ceiling: 48, origin: 'derived' });
  });
});

describe('no pressure means the ceiling', () => {
  it('with no sample at all the effective count is the ceiling', () => {
    _setDepsForTest({ readSample: () => null });
    assert.equal(effectiveSlotCount(48), 48);
  });

  it('a clean sample leaves the effective count at the ceiling', () => {
    _setDepsForTest({ readSample: () => clean(1) });
    assert.equal(effectiveSlotCount(48), 48);
  });

  it('off-win32 behavior (a null sample) never restricts', () => {
    // readPressureSampleCached itself returns null off win32; from the
    // governor's point of view that is indistinguishable from "no sample".
    _setDepsForTest({ readSample: () => null });
    assert.equal(effectiveSlotCount(48), 48);
  });

  it('the kill switch returns the ceiling and never reads a sample', () => {
    process.env.PA_DYNAMIC_SLOTS = '0';
    let calls = 0;
    _setDepsForTest({ readSample: () => { calls++; return pressuredPhys(1); } });
    assert.equal(effectiveSlotCount(48), 48);
    assert.equal(calls, 0);
  });
});

describe('pressure cuts a quarter', () => {
  it('the first pressured sample cuts a quarter, rounded up', () => {
    let s: PressureSample | null = pressuredPhys(1);
    _setDepsForTest({ readSample: () => s });
    // 48 / 4 = 12 -> 48 - 12 = 36
    assert.equal(effectiveSlotCount(48), 36);
  });

  it('a cut is at least one slot', () => {
    let s: PressureSample | null = pressuredPhys(1);
    _setDepsForTest({ readSample: () => s });
    // ceiling 4: cut = max(1, ceil(4/4)) = 1 -> 3
    assert.equal(effectiveSlotCount(4), 3);
  });

  it('consecutive pressured samples cut again', () => {
    let s: PressureSample | null = pressuredPhys(1);
    _setDepsForTest({ readSample: () => s });
    assert.equal(effectiveSlotCount(48), 36);
    s = pressuredPhys(2);
    // 36 / 4 = 9 -> 36 - 9 = 27
    assert.equal(effectiveSlotCount(48), 27);
  });

  it('a cut never goes below the floor', () => {
    process.env.PA_SLOTS_MIN = '5';
    let s: PressureSample | null = pressuredPhys(1);
    _setDepsForTest({ readSample: () => s });
    assert.equal(effectiveSlotCount(6), 5); // 6 - ceil(6/4)=2 -> 4, floored to 5
  });

  it('low free physical alone trips pressure', () => {
    _setDepsForTest({ readSample: () => pressuredPhys(1) });
    assert.equal(effectiveSlotCount(48), 36);
  });

  it('high cpu alone trips pressure', () => {
    _setDepsForTest({ readSample: () => pressuredCpu(1) });
    assert.equal(effectiveSlotCount(48), 36);
  });

  it('a long disk queue alone trips pressure', () => {
    _setDepsForTest({ readSample: () => pressuredDisk(1) });
    assert.equal(effectiveSlotCount(48), 36);
  });
});

describe('pressure inputs can be disabled or absent', () => {
  it('each brake knob set to 0 disables only that input', () => {
    process.env.PA_SLOTS_PHYSICAL_BRAKE_MB = '0';
    _setDepsForTest({ readSample: () => pressuredPhys(1) });
    assert.equal(effectiveSlotCount(48), 48, 'physical brake disabled: not pressured');
    delete process.env.PA_SLOTS_PHYSICAL_BRAKE_MB;

    _resetForTest();
    _setDepsForTest({ readSample: () => null, cpuCount: () => 12 });
    process.env.PA_SLOTS_CPU_BRAKE_PCT = '0';
    _setDepsForTest({ readSample: () => pressuredCpu(1) });
    assert.equal(effectiveSlotCount(48), 48, 'cpu brake disabled: not pressured');
    delete process.env.PA_SLOTS_CPU_BRAKE_PCT;

    _resetForTest();
    _setDepsForTest({ readSample: () => null, cpuCount: () => 12 });
    process.env.PA_SLOTS_DISK_QUEUE_BRAKE = '0';
    _setDepsForTest({ readSample: () => pressuredDisk(1) });
    assert.equal(effectiveSlotCount(48), 48, 'disk queue brake disabled: not pressured');
  });

  it('a null field is never evaluated', () => {
    const sample: PressureSample = { physFreeMb: null, cpuPct: 95, diskQueue: 0, sampledAtMs: 1 };
    _setDepsForTest({ readSample: () => sample });
    // cpuPct 95 >= default 90 still trips pressure via the CPU input.
    assert.equal(effectiveSlotCount(48), 36);
  });

  it('a sample with all fields null is not pressured', () => {
    const sample: PressureSample = { physFreeMb: null, cpuPct: null, diskQueue: null, sampledAtMs: 1 };
    _setDepsForTest({ readSample: () => sample });
    assert.equal(effectiveSlotCount(48), 48);
  });

  it('pressure is evaluated at most once per distinct sample', () => {
    const s = pressuredPhys(1);
    _setDepsForTest({ readSample: () => s });
    assert.equal(effectiveSlotCount(48), 36);
    assert.equal(effectiveSlotCount(48), 36, 'the same sample changes nothing on a second call');
    assert.equal(effectiveSlotCount(48), 36);
  });
});

describe('recovery', () => {
  it('one clean sample does not recover', () => {
    _setDepsForTest({ readSample: () => pressuredPhys(1) });
    assert.equal(effectiveSlotCount(48), 36);
    _setDepsForTest({ readSample: () => clean(2) });
    assert.equal(effectiveSlotCount(48), 36);
  });

  it('two clean samples return the pool to lastCut minus one', () => {
    _setDepsForTest({ readSample: () => pressuredPhys(1) });
    assert.equal(effectiveSlotCount(48), 36); // lastCut = 48
    _setDepsForTest({ readSample: () => clean(2) });
    assert.equal(effectiveSlotCount(48), 36); // 1st clean: no recovery yet
    _setDepsForTest({ readSample: () => clean(3) });
    assert.equal(effectiveSlotCount(48), 47); // 2nd clean: lastCut(48) - 1
  });

  it('each further clean sample raises by a quarter', () => {
    _setDepsForTest({ readSample: () => pressuredPhys(1) });
    effectiveSlotCount(48); // -> 36, lastCut = 48
    _setDepsForTest({ readSample: () => clean(2) });
    effectiveSlotCount(48); // 1 clean
    _setDepsForTest({ readSample: () => clean(3) });
    assert.equal(effectiveSlotCount(48), 47); // 2 clean: 48-1=47
    _setDepsForTest({ readSample: () => clean(4) });
    // 47 + ceil(47/4)=12 -> 59, capped nowhere yet since ceiling handling below
    assert.equal(effectiveSlotCount(48), 48, 'reaches/overshoots the ceiling and is clamped to it');
  });

  it('reaching the ceiling ends the episode and clears the state', () => {
    _setDepsForTest({ readSample: () => pressuredPhys(1) });
    effectiveSlotCount(48);
    _setDepsForTest({ readSample: () => clean(2) });
    effectiveSlotCount(48);
    _setDepsForTest({ readSample: () => clean(3) });
    effectiveSlotCount(48); // 47
    _setDepsForTest({ readSample: () => clean(4) });
    assert.equal(effectiveSlotCount(48), 48);
    const g = _governorForTest();
    assert.equal(g.episodeActive, false);
    assert.equal(g.lastCut, null);
    assert.equal(g.cleanCount, 0);
    assert.equal(g.currentEffective, 48);
  });

  it('a new pressured sample during recovery cuts again from the current effective', () => {
    _setDepsForTest({ readSample: () => pressuredPhys(1) });
    effectiveSlotCount(48); // -> 36, lastCut = 48
    _setDepsForTest({ readSample: () => clean(2) });
    effectiveSlotCount(48); // 1 clean, still 36
    _setDepsForTest({ readSample: () => clean(3) });
    assert.equal(effectiveSlotCount(48), 47); // 2 clean: recovers to 47
    _setDepsForTest({ readSample: () => pressuredPhys(4) });
    // cuts again from the CURRENT effective (47), not from the ceiling or lastCut.
    // ceil(47/4) = 12 -> 47 - 12 = 35
    assert.equal(effectiveSlotCount(48), 35);
  });

  it('recovery never exceeds the ceiling', () => {
    _setDepsForTest({ readSample: () => pressuredPhys(1) });
    assert.equal(effectiveSlotCount(6), 4); // cut: 6 - ceil(6/4)=2 -> 4, lastCut = 6
    _setDepsForTest({ readSample: () => clean(2) });
    effectiveSlotCount(6); // 1 clean
    _setDepsForTest({ readSample: () => clean(3) });
    assert.equal(effectiveSlotCount(6), 5); // 2 clean: lastCut(6)-1=5, recovering
    _setDepsForTest({ readSample: () => clean(4) });
    // raw step 5 + ceil(5/4)=2 -> 7, which overshoots the ceiling(6) and must clamp to it
    assert.equal(effectiveSlotCount(6), 6);
  });
});

describe('log lines', () => {
  // Every test in this describe injects a fake, monotonically-advancing clock
  // stepping well past LOG_MIN_INTERVAL_MS (60s) between calls. Without it,
  // the real Date.now() barely moves within one test and the rate limit
  // would silently suppress the very lines these tests assert on.
  it('a cut logs the pressured line with all three sensor values', () => {
    const logs: string[] = [];
    _setDepsForTest({ readSample: () => pressuredDisk(1), log: (msg) => logs.push(msg), clock: () => 0 });
    effectiveSlotCount(48);
    assert.equal(logs.length, 1);
    assert.equal(logs[0], 'dynamic-slots: effective 36/48 (pressured: physFreeMB 5000, cpu 10%, diskQ 9)');
  });

  it('a null sensor renders as n a in the pressured line', () => {
    const logs: string[] = [];
    const sample: PressureSample = { physFreeMb: null, cpuPct: 95, diskQueue: null, sampledAtMs: 1 };
    _setDepsForTest({ readSample: () => sample, log: (msg) => logs.push(msg), clock: () => 0 });
    effectiveSlotCount(48);
    assert.equal(logs.length, 1);
    assert.equal(logs[0], 'dynamic-slots: effective 36/48 (pressured: physFreeMB n/a, cpu 95%, diskQ n/a)');
  });

  it('a recovery raise logs the recovering line', () => {
    const logs: string[] = [];
    let now = 0;
    _setDepsForTest({ readSample: () => pressuredPhys(1), log: (msg) => logs.push(msg), clock: () => now });
    effectiveSlotCount(48); // logs the cut
    now += 100000;
    _setDepsForTest({ readSample: () => clean(2) });
    effectiveSlotCount(48); // 1 clean: no log (no state transition line yet)
    now += 100000;
    _setDepsForTest({ readSample: () => clean(3) });
    effectiveSlotCount(48); // 2 clean: recovers to 47, still under ceiling(48)
    assert.equal(logs.length, 2);
    assert.equal(logs[1], 'dynamic-slots: effective 47/48 (recovering)');
  });

  it('ending an episode logs the clear line', () => {
    const logs: string[] = [];
    let now = 0;
    _setDepsForTest({ readSample: () => pressuredPhys(1), log: (msg) => logs.push(msg), clock: () => now });
    effectiveSlotCount(48); // cut: 36
    now += 100000;
    _setDepsForTest({ readSample: () => clean(2) });
    effectiveSlotCount(48); // 1 clean
    now += 100000;
    _setDepsForTest({ readSample: () => clean(3) });
    effectiveSlotCount(48); // 2 clean: 47 (recovering)
    now += 100000;
    _setDepsForTest({ readSample: () => clean(4) });
    effectiveSlotCount(48); // reaches ceiling: clear
    assert.equal(logs.length, 3);
    assert.equal(logs[2], 'dynamic-slots: effective 48/48 (clear)');
  });
});

describe('quota burst shed (noteQuotaBurst)', () => {
  it('a burst event cuts a quarter of the current pool', () => {
    noteQuotaBurst();
    assert.equal(effectiveSlotCount(48), 36); // 48 - ceil(48/4) = 36
    const g = _governorForTest();
    assert.equal(g.episodeActive, true);
    assert.equal(g.lastCut, 48);
    assert.equal(g.cleanCount, 0);
  });

  it('each further burst event cuts again from the current pool', () => {
    noteQuotaBurst();
    assert.equal(effectiveSlotCount(48), 36);
    noteQuotaBurst(); // from the CURRENT 36: 36 - 9 = 27
    assert.equal(effectiveSlotCount(48), 27);
  });

  it('clean samples climb back on the existing recovery rule', () => {
    noteQuotaBurst(); // 48 -> 36, lastCut = 48
    assert.equal(effectiveSlotCount(48), 36);
    _setDepsForTest({ readSample: () => clean(1) });
    assert.equal(effectiveSlotCount(48), 36); // 1st clean: no recovery yet
    _setDepsForTest({ readSample: () => clean(2) });
    assert.equal(effectiveSlotCount(48), 47); // 2nd clean: lastCut(48) - 1
    _setDepsForTest({ readSample: () => clean(3) });
    assert.equal(effectiveSlotCount(48), 48, 'climbs past the ceiling and is clamped, ending the episode');
    const g = _governorForTest();
    assert.equal(g.episodeActive, false);
    assert.equal(g.lastCut, null);
  });

  it('a burst during recovery cuts from the current effective and restarts recovery', () => {
    _setDepsForTest({ readSample: () => pressuredPhys(1) });
    effectiveSlotCount(48); // -> 36, lastCut = 48
    _setDepsForTest({ readSample: () => clean(2) });
    effectiveSlotCount(48); // 1 clean
    _setDepsForTest({ readSample: () => clean(3) });
    effectiveSlotCount(48); // 47, recovering
    noteQuotaBurst(); // from the CURRENT 47: 47 - ceil(47/4)=12 -> 35
    assert.equal(effectiveSlotCount(48), 35);
    assert.equal(_governorForTest().cleanCount, 0, 'the burst restarts the clean-sample count');
  });

  it('a burst never sheds below 2, even with a lower env floor', () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = '2';
    process.env.PA_SLOTS_MIN = '1';
    noteQuotaBurst(); // ceiling 2: raw cut 2-1=1, backstopped to the burst floor 2
    assert.equal(effectiveSlotCount(2), 2);
    assert.equal(_governorForTest().episodeActive, true, 'the shed still happened');
  });

  it('the kill switch makes a burst a no-op', () => {
    process.env.PA_DYNAMIC_SLOTS = '0';
    noteQuotaBurst();
    assert.equal(_governorForTest().episodeActive, false);
    assert.equal(effectiveSlotCount(48), 48);
  });

  it('a disabled (<= 0) ceiling makes a burst a no-op', () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = '0';
    noteQuotaBurst();
    assert.equal(_governorForTest().episodeActive, false);
    assert.equal(effectiveSlotCount(0), 0);
  });

  it('a pressured sample after a burst cuts again from the burst level', () => {
    noteQuotaBurst(); // 48 -> 36
    assert.equal(effectiveSlotCount(48), 36);
    _setDepsForTest({ readSample: () => pressuredPhys(2) });
    assert.equal(effectiveSlotCount(48), 27); // 36 - 9
  });
});

describe('effectiveSlotCount (surviving legacy)', () => {
  it('kill switch returns the static ceiling untouched and never reads metrics', () => {
    process.env.PA_DYNAMIC_SLOTS = '0';
    let calls = 0;
    _setDepsForTest({ readSample: () => { calls++; return clean(1); } });
    assert.equal(effectiveSlotCount(5), 5);
    assert.equal(calls, 0);
  });

  it('ceiling <= 0 passes through without touching metrics', () => {
    delete process.env.PA_DYNAMIC_SLOTS;
    let calls = 0;
    _setDepsForTest({ readSample: () => { calls++; return clean(1); } });
    assert.equal(effectiveSlotCount(0), 0);
    assert.equal(effectiveSlotCount(-3), -3);
    assert.equal(calls, 0);
  });

  it('floor never exceeds the ceiling', () => {
    process.env.PA_SLOTS_MIN = '10';
    _setDepsForTest({ readSample: () => null });
    assert.equal(effectiveSlotCount(2), 2); // floor(10) clamped down to the ceiling(2)
  });
});
