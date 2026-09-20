/**
 * Serving-semantics tests for src/system-status.ts (2026-09-13,
 * vi-2d9444e29d52 recurrence): the collector takes 10-25s on a degraded
 * machine, so the endpoint must serve the last good snapshot immediately and
 * refresh in the background (stale-while-revalidate, one in-flight spawn),
 * only awaiting a collection on a cold cache — and surfacing an honest
 * failure once a snapshot is older than MAX_STALE_MS. The runner and clock
 * are injected; no python is spawned from this suite.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSystemStatus,
  __resetSystemStatusForTests,
  __setKeepWarmIntervalMsForTests,
  CACHE_TTL_MS,
  MAX_STALE_MS,
  type SystemStatus,
} from '../system-status.js';

function fakeStatus(n: number): SystemStatus {
  return {
    generated_at: n,
    threads: {
      running_count: n,
      queued_count: 0,
      running: [],
      queued: [],
      by_status: {},
      active_topic_count: 0,
      total_topic_count: 0,
    },
    workers: {
      processes: [],
      alive_count: 0,
      slot_used: 0,
      slot_ceiling: 30,
      slot_ceiling_derived: true,
    },
    health: { bot_pid: null, bot_alive: false, catchup_pid: null, catchup_alive: false },
    system: {
      cpu_percent: 0,
      cpu_count: null,
      mem_total: 0,
      mem_used: 0,
      mem_percent: 0,
      disks: {},
      boot_time: 0,
      uptime_secs: 0,
    },
    assistant_mem_bytes: 0,
    pa_dir_size: { bytes: 0, files: 0, computed_at: n },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('getSystemStatus serving semantics', () => {
  beforeEach(() => __resetSystemStatusForTests());

  it('cold cache awaits the first collection, deduped across concurrent callers', async () => {
    let calls = 0;
    let release!: (v: SystemStatus) => void;
    const run = () =>
      new Promise<SystemStatus>((resolve) => {
        calls++;
        release = resolve;
      });
    const p1 = getSystemStatus('repo', run);
    const p2 = getSystemStatus('repo', run);
    assert.equal(calls, 1, 'concurrent cold callers share one spawn');
    release(fakeStatus(1));
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a, b);
  });

  it('serves the cached snapshot within the TTL without respawning', async () => {
    let calls = 0;
    const data = fakeStatus(1);
    const run = async (): Promise<SystemStatus> => {
      calls++;
      return data;
    };
    const first = await getSystemStatus('repo', run);
    const again = await getSystemStatus('repo', () => {
      throw new Error('must not spawn while fresh');
    });
    assert.equal(again, first);
    assert.equal(calls, 1);
  });

  it('serves stale data immediately while a slow refresh runs in the background', async () => {
    let t = 1_000_000;
    const now = () => t;
    const first = fakeStatus(1);
    const second = fakeStatus(2);
    let calls = 0;
    let release!: () => void;
    const run = () =>
      new Promise<SystemStatus>((resolve) => {
        calls++;
        release = () => resolve(second);
      });

    await getSystemStatus('repo', async () => first, now); // cold collection, instant
    assert.equal(calls, 0, 'instant cold runner was not the deferred one');

    t += CACHE_TTL_MS + 1; // snapshot expired, still young enough to serve
    const served = await getSystemStatus('repo', run, now);
    assert.equal(served, first, 'stale snapshot served without waiting');
    assert.equal(calls, 1, 'a background refresh WAS kicked off');

    release();
    await tick(); // let the refresh land in lastGood
    const fresh = await getSystemStatus('repo', () => {
      throw new Error('must not spawn while fresh');
    }, now);
    assert.equal(fresh, second, 'refreshed snapshot is served on the next call');
  });

  it('beyond MAX_STALE_MS a caller waits for the refresh instead of serving ancient data', async () => {
    let t = 1_000_000;
    const now = () => t;
    const first = fakeStatus(1);
    const second = fakeStatus(2);
    let release!: () => void;
    const run = () =>
      new Promise<SystemStatus>((resolve) => {
        release = () => resolve(second);
      });

    await getSystemStatus('repo', async () => first, now); // cold collection, instant
    t += MAX_STALE_MS + 1;

    const p = getSystemStatus('repo', run, now);
    let resolved = false;
    p.then(() => {
      resolved = true;
    });
    await tick();
    assert.equal(resolved, false, 'call is held for the refresh, not answered from stale');
    release();
    assert.equal(await p, second);
  });

  it('a failed cold collection rejects, and a later call retries', async () => {
    const boom = async (): Promise<SystemStatus> => {
      throw new Error('spawn failed');
    };
    await assert.rejects(getSystemStatus('repo', boom), /spawn failed/);
    const data = fakeStatus(1);
    const ok = await getSystemStatus('repo', async () => data);
    assert.equal(ok, data);
  });
});

describe('keep-warm background refresh', () => {
  beforeEach(() => __resetSystemStatusForTests());

  it('refreshes the snapshot on its timer with no further requests, and reset stops it', async () => {
    __setKeepWarmIntervalMsForTests(5);
    let seq = 0;
    // A clock that jumps past CACHE_TTL_MS on every read models the
    // production relationship (30s tick > 10s TTL): every tick sees a
    // stale snapshot and refreshes.
    let t = 1_000_000;
    const jump = (): number => (t += CACHE_TTL_MS + 1);
    const run = async (): Promise<SystemStatus> => fakeStatus(++seq);

    await getSystemStatus('repo', run, jump); // cold collection (call 1)
    await sleep(60); // ~12 ticks at 5ms
    assert.ok(seq >= 3, `keep-warm spawned repeatedly in the background (seq=${seq})`);

    __resetSystemStatusForTests();
    const stopped = seq;
    await sleep(30);
    assert.equal(seq, stopped, 'reset cleared the timer — no further spawns');
  });
});
