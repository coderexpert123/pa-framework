import './test-env-guard.js';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CpuInfo } from 'node:os';
import {
  parsePressureSample,
  readPressureSampleCached,
  _setDepsForTest,
  _resetForTest,
  _cacheForTest,
  type ExecFn,
} from '../src/lib/pressure-sample.js';

// Disk queue is the only field left in the WMI leg's JSON (2026-09-13);
// RAM/CPU now come from Node and never appear in this payload.
const GOLDEN = '{"CurrentDiskQueueLength":1}\n';

// The disk-queue refresh is asynchronous (execFn(...).then(...).catch(...).finally(...)),
// so a triggering read needs several microtask turns to flush before the
// cache reflects it.
async function flush(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

// A single fake core whose times sum to `total` ticks, `idle` of them idle.
// computeCpuPct sums idle/total across all cores, so one core is enough to
// drive a deterministic delta.
function cpuInfo(idle: number, total: number): CpuInfo[] {
  return [{ model: 'test', speed: 0, times: { idle, user: total - idle, nice: 0, sys: 0, irq: 0 } }];
}

beforeEach(() => _resetForTest());

describe('parsePressureSample', () => {
  it('parses the disk-queue-only shape (RAM/CPU no longer come from WMI)', () => {
    const s = parsePressureSample(GOLDEN, 1000);
    assert.deepEqual(s, { physFreeMb: null, cpuPct: null, diskQueue: 1, sampledAtMs: 1000 });
  });

  it('unwraps a single-element array', () => {
    const s = parsePressureSample('[{"CurrentDiskQueueLength":1}]', 1000);
    assert.deepEqual(s, { physFreeMb: null, cpuPct: null, diskQueue: 1, sampledAtMs: 1000 });
  });

  it('returns null on empty stdout', () => {
    assert.equal(parsePressureSample('', 1000), null);
    assert.equal(parsePressureSample('   \n', 1000), null);
  });

  it('returns null on non-JSON garbage', () => {
    assert.equal(parsePressureSample('not json {{{', 1000), null);
  });

  it('keeps a missing or unparseable diskQueue field null instead of zero', () => {
    const missing = parsePressureSample('{}', 1000);
    assert.deepEqual(missing, { physFreeMb: null, cpuPct: null, diskQueue: null, sampledAtMs: 1000 });

    const explicitNull = parsePressureSample('{"CurrentDiskQueueLength":null}', 1000);
    assert.deepEqual(explicitNull, { physFreeMb: null, cpuPct: null, diskQueue: null, sampledAtMs: 1000 });
  });

  it('accepts a digits-only string field and rejects a non-digit string', () => {
    const s = parsePressureSample('{"CurrentDiskQueueLength":"3"}', 1000);
    assert.deepEqual(s, { physFreeMb: null, cpuPct: null, diskQueue: 3, sampledAtMs: 1000 });

    const bad = parsePressureSample('{"CurrentDiskQueueLength":"abc"}', 1000);
    assert.deepEqual(bad, { physFreeMb: null, cpuPct: null, diskQueue: null, sampledAtMs: 1000 });
  });
});

describe('readPressureSampleCached', () => {
  it('returns a live sample on the first call (cpuPct null pending history) and fires exactly one refresh', () => {
    let calls = 0;
    const exec: ExecFn = () => { calls++; return new Promise(() => { /* never resolves */ }); };
    _setDepsForTest({
      platform: () => 'win32',
      exec,
      freemem: () => 4 * 1024 * 1024 * 1024,
      cpus: () => cpuInfo(900, 1000),
    });
    const s = readPressureSampleCached();
    assert.notEqual(s, null);
    assert.equal(s?.physFreeMb, 4096, 'physFreeMb is live from Node on the very first call');
    assert.equal(s?.cpuPct, null, 'no prior tick snapshot to diff against yet');
    assert.equal(s?.diskQueue, null, 'the WMI refresh has not resolved yet');
    assert.equal(calls, 1);
  });

  it('serves the cached sample without spawning or recomputing again inside the 60s TTL', async () => {
    let now = 0;
    let calls = 0;
    const exec: ExecFn = async () => { calls++; return { stdout: GOLDEN, stderr: '' }; };
    _setDepsForTest({
      platform: () => 'win32',
      clock: () => now,
      exec,
      freemem: () => 4 * 1024 * 1024 * 1024,
      cpus: () => cpuInfo(900, 1000),
    });

    const seed = readPressureSampleCached(); // fires the disk-queue refresh
    assert.equal(seed?.diskQueue, null, 'diskQueue not resolved yet');
    await flush();
    const first = readPressureSampleCached(); // same TTL tick, now reflects the resolved diskQueue
    assert.equal(first?.diskQueue, 1);
    assert.equal(calls, 1);

    now = 59999; // still inside the 60s TTL from sampledAtMs 0
    const second = readPressureSampleCached();
    assert.equal(calls, 1, 'no re-spawn before the TTL elapses');
    assert.deepEqual(second, first, 'no recompute before the TTL elapses either');
  });

  it('fires a second refresh once the TTL has elapsed', async () => {
    let now = 0;
    let calls = 0;
    const exec: ExecFn = async () => { calls++; return { stdout: GOLDEN, stderr: '' }; };
    _setDepsForTest({
      platform: () => 'win32',
      clock: () => now,
      exec,
      freemem: () => 4 * 1024 * 1024 * 1024,
      cpus: () => cpuInfo(900, 1000),
    });

    readPressureSampleCached();
    await flush();
    const first = readPressureSampleCached();
    assert.equal(calls, 1);

    now = 60000; // TTL elapsed (sampledAtMs was 0)
    const stale = readPressureSampleCached();
    assert.equal(calls, 2, 'a second refresh fires once the TTL elapses');
    assert.equal(stale?.diskQueue, first?.diskQueue, 'diskQueue carried forward while the new refresh is pending');
  });

  it('computes CPU busy % from the tick delta between TTL ticks (golden 50%, F5)', () => {
    let now = 0;
    let cpuCall = 0;
    const cpuSeq = [cpuInfo(900, 1000), cpuInfo(950, 1100)];
    const exec: ExecFn = async () => ({ stdout: GOLDEN, stderr: '' });
    _setDepsForTest({
      platform: () => 'win32',
      clock: () => now,
      exec,
      freemem: () => 4 * 1024 * 1024 * 1024,
      cpus: () => cpuSeq[Math.min(cpuCall++, cpuSeq.length - 1)],
    });

    const first = readPressureSampleCached();
    assert.equal(first?.cpuPct, null, 'first-ever sample has no prior tick snapshot to diff against');

    now = 60000; // TTL elapsed -> second Node-native tick
    const second = readPressureSampleCached();
    assert.equal(second?.cpuPct, 50, 'idle 900->950 of total 1000->1100 is 50% busy');
  });

  it('does not spawn a second time while a refresh is in flight', () => {
    let calls = 0;
    const exec: ExecFn = () => { calls++; return new Promise(() => { /* never resolves */ }); };
    _setDepsForTest({ platform: () => 'win32', exec });

    readPressureSampleCached();
    readPressureSampleCached();
    readPressureSampleCached();
    assert.equal(calls, 1, 'the in-flight guard allows at most one outstanding spawn');
  });

  it('keeps the previous diskQueue when a refresh fails, but physFreeMb and cpuPct stay live', async () => {
    let now = 0;
    const good: ExecFn = async () => ({ stdout: GOLDEN, stderr: '' });
    _setDepsForTest({
      platform: () => 'win32',
      clock: () => now,
      exec: good,
      freemem: () => 4 * 1024 * 1024 * 1024,
      cpus: () => cpuInfo(900, 1000),
    });

    readPressureSampleCached();
    await flush();
    const first = readPressureSampleCached();
    assert.equal(first?.diskQueue, 1);

    now = 60000; // TTL elapsed, trigger a refresh that will fail
    const failing: ExecFn = async () => { throw new Error('exec failed'); };
    _setDepsForTest({ exec: failing, cpus: () => cpuInfo(950, 1100) });
    const afterFailure = readPressureSampleCached();
    assert.equal(afterFailure?.diskQueue, 1, 'a failed refresh keeps the previous diskQueue value');
    assert.equal(afterFailure?.physFreeMb, 4096, 'physFreeMb stays live from Node despite the WMI failure');
    assert.equal(afterFailure?.cpuPct, 50, 'cpuPct stays live from Node despite the WMI failure');
    await flush(); // let the rejection settle so it never surfaces as an unhandled rejection
  });

  it('a failing/timeout exec leaves diskQueue null but physFreeMb and cpuPct populate live (F5)', async () => {
    let now = 0;
    let cpuCall = 0;
    const cpuSeq = [cpuInfo(900, 1000), cpuInfo(950, 1100)];
    const failing: ExecFn = async () => { throw new Error('timeout'); };
    _setDepsForTest({
      platform: () => 'win32',
      clock: () => now,
      exec: failing,
      freemem: () => 4 * 1024 * 1024 * 1024,
      cpus: () => cpuSeq[Math.min(cpuCall++, cpuSeq.length - 1)],
    });

    readPressureSampleCached(); // first tick: seeds cpu history; the WMI leg never succeeds
    await flush();

    now = 60000; // second tick: exec fails again, but cpuPct now has a delta to compute
    const second = readPressureSampleCached();
    assert.equal(second?.diskQueue, null, 'the WMI leg never succeeded, so there is nothing to carry forward');
    assert.equal(second?.physFreeMb, 4096, 'physFreeMb is live from Node, unaffected by the WMI failure');
    assert.equal(second?.cpuPct, 50, 'cpuPct is live from Node, unaffected by the WMI failure');
    await flush();
  });

  it('off win32: physFree/cpu stay live from Node, diskQueue stays null, and it never spawns', () => {
    let calls = 0;
    const exec: ExecFn = () => { calls++; return new Promise(() => { /* never resolves */ }); };
    _setDepsForTest({ platform: () => 'linux', exec, freemem: () => 4 * 1024 * 1024 * 1024, cpus: () => cpuInfo(900, 1000) });
    const s = readPressureSampleCached();
    assert.notEqual(s, null);
    assert.equal(s?.physFreeMb, 4096);
    assert.equal(s?.diskQueue, null);
    assert.equal(calls, 0);
  });

  it('_resetForTest clears the cache, the in-flight flag, and the cpu tick history', () => {
    let calls1 = 0;
    const pending: ExecFn = () => { calls1++; return new Promise(() => { /* never resolves */ }); };
    _setDepsForTest({
      platform: () => 'win32',
      exec: pending,
      freemem: () => 4 * 1024 * 1024 * 1024,
      cpus: () => cpuInfo(900, 1000),
    });
    const before = readPressureSampleCached(); // fires a refresh that never resolves; in-flight stays true
    assert.equal(calls1, 1);
    assert.equal(before?.cpuPct, null, 'first-ever sample: no tick history yet');

    _resetForTest();
    assert.equal(_cacheForTest(), null);

    let calls2 = 0;
    const pending2: ExecFn = () => { calls2++; return new Promise(() => { /* never resolves */ }); };
    _setDepsForTest({
      platform: () => 'win32',
      exec: pending2,
      freemem: () => 4 * 1024 * 1024 * 1024,
      cpus: () => cpuInfo(950, 1100),
    });
    const result = readPressureSampleCached();
    assert.notEqual(result, null, 'a live sample is produced immediately after reset');
    assert.equal(result?.cpuPct, null, 'the cpu tick history was cleared by the reset, so this reads as a first sample again');
    assert.equal(calls2, 1, 'the in-flight flag was cleared by the reset, so a new refresh can fire');
  });
});
