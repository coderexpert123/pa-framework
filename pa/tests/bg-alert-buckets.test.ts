import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectBgAlerts } from '../src/workers.js';
import type { BgEntry } from '../src/workers.js';

function makeMap(entries: Record<number, BgEntry>): Map<number, BgEntry> {
  return new Map(Object.entries(entries).map(([pid, e]) => [Number(pid), e]));
}

describe('collectBgAlerts (deterministic bucket/repeat-gate unit tests)', () => {
  it('fires on first crossing of the alert threshold (lastRepeatBucket -1 → bucket 0)', () => {
    const map = makeMap({ 100: { firstSeen: 0, lastRepeatBucket: -1 } });
    const alerts = collectBgAlerts(map, /* now */ 15_000, /* alertMs */ 10_000, /* repeatMs */ 60_000);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].pid, 100);
    assert.equal(alerts[0].ageSec, 15);
    assert.equal(map.get(100)!.lastRepeatBucket, 0, 'bucket should advance to 0');
  });

  it('does not fire before the alert threshold is crossed', () => {
    const map = makeMap({ 100: { firstSeen: 0, lastRepeatBucket: -1 } });
    const alerts = collectBgAlerts(map, /* now */ 5_000, /* alertMs */ 10_000, /* repeatMs */ 60_000);
    assert.equal(alerts.length, 0);
    assert.equal(map.get(100)!.lastRepeatBucket, -1, 'bucket should not advance below threshold');
  });

  it('suppresses a repeat within the same bucket', () => {
    // Already alerted at bucket 0 (age 15s, alertMs=10s, repeatMs=60s → bucket 0).
    const map = makeMap({ 100: { firstSeen: 0, lastRepeatBucket: 0 } });
    const alerts = collectBgAlerts(map, /* now */ 45_000, /* alertMs */ 10_000, /* repeatMs */ 60_000);
    assert.equal(alerts.length, 0, 'still within bucket 0 (age 45s / repeatMs 60s = bucket 0)');
    assert.equal(map.get(100)!.lastRepeatBucket, 0);
  });

  it('re-fires once the bucket advances', () => {
    const map = makeMap({ 100: { firstSeen: 0, lastRepeatBucket: 0 } });
    const alerts = collectBgAlerts(map, /* now */ 65_000, /* alertMs */ 10_000, /* repeatMs */ 60_000);
    assert.equal(alerts.length, 1, 'age 65s / repeatMs 60s = bucket 1, advanced from 0');
    assert.equal(map.get(100)!.lastRepeatBucket, 1);
  });

  it('never fires for an entry that never crosses the threshold', () => {
    const map = makeMap({ 100: { firstSeen: 0, lastRepeatBucket: -1 } });
    // Simulate several heartbeats, all below alertMs.
    for (const now of [1000, 3000, 6000, 9999]) {
      const alerts = collectBgAlerts(map, now, /* alertMs */ 10_000, /* repeatMs */ 60_000);
      assert.equal(alerts.length, 0, `should not fire at now=${now}`);
    }
    assert.equal(map.get(100)!.lastRepeatBucket, -1);
  });

  it('batches multiple PIDs crossing in the same heartbeat', () => {
    const map = makeMap({
      100: { firstSeen: 0, lastRepeatBucket: -1 },
      200: { firstSeen: 0, lastRepeatBucket: -1 },
      300: { firstSeen: 5_000, lastRepeatBucket: -1 }, // started later, hasn't crossed yet
    });
    const alerts = collectBgAlerts(map, /* now */ 15_000, /* alertMs */ 10_000, /* repeatMs */ 60_000);
    const pids = alerts.map(a => a.pid).sort();
    assert.deepEqual(pids, [100, 200], 'pid 300 (age 10s) has not yet crossed the 10s threshold');
  });

  it('carries the cmdline through, defaulting to "(unknown)" when absent', () => {
    const map = makeMap({
      100: { firstSeen: 0, lastRepeatBucket: -1, cmdline: 'node long-running.js' },
      200: { firstSeen: 0, lastRepeatBucket: -1 },
    });
    const alerts = collectBgAlerts(map, 15_000, 10_000, 60_000);
    const byPid = new Map(alerts.map(a => [a.pid, a.cmdline]));
    assert.equal(byPid.get(100), 'node long-running.js');
    assert.equal(byPid.get(200), '(unknown)');
  });
});
