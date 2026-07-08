import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDegraded,
  isDegraded,
  _setDegradedForTest,
  ENTER_LAG_MS,
  ENTER_FS_MS,
  EXIT_LAG_MS,
  EXIT_FS_MS,
} from '../health.js';

afterEach(() => _setDegradedForTest(false));

describe('computeDegraded', () => {
  it('healthy stays healthy under normal readings', () => {
    assert.equal(computeDegraded(false, 10, 50), false);
  });

  it('enters degraded on event-loop lag alone', () => {
    assert.equal(computeDegraded(false, ENTER_LAG_MS, 0), true);
  });

  it('enters degraded on fs latency alone', () => {
    assert.equal(computeDegraded(false, 0, ENTER_FS_MS), true);
  });

  it('stays healthy just under both thresholds', () => {
    assert.equal(computeDegraded(false, ENTER_LAG_MS - 1, ENTER_FS_MS - 1), false);
  });

  it('hysteresis: does NOT exit until both drop below the exit thresholds', () => {
    // Below enter thresholds but above exit thresholds → still degraded
    assert.equal(computeDegraded(true, EXIT_LAG_MS + 1, 0), true);
    assert.equal(computeDegraded(true, 0, EXIT_FS_MS + 1), true);
    // Both at/below exit thresholds → recover
    assert.equal(computeDegraded(true, EXIT_LAG_MS, EXIT_FS_MS), false);
  });

  it('exit thresholds are strictly tighter than entry (hysteresis is real)', () => {
    assert.ok(EXIT_LAG_MS < ENTER_LAG_MS && EXIT_FS_MS < ENTER_FS_MS);
  });
});

describe('isDegraded flag', () => {
  it('reflects the test hook', () => {
    assert.equal(isDegraded(), false);
    _setDegradedForTest(true);
    assert.equal(isDegraded(), true);
  });
});
