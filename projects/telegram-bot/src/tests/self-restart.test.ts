import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSelfRestart,
  shouldWarnStaleCode,
  SELF_RESTART_GRACE_MS,
  SELF_RESTART_STALE_WARN_MS,
  type SelfRestartInputs,
} from '../self-restart.js';

/** A baseline set of inputs that yields `stamp-newer-and-idle` (restart: true)
 *  so individual tests can override one field at a time to hit a single
 *  earlier branch. graceMs is pinned explicitly so the test is independent
 *  of the exported default's value. */
function baseInputs(overrides: Partial<SelfRestartInputs> = {}): SelfRestartInputs {
  return {
    procStartMs: 1_000,
    stampMtimeMs: 1_001,
    nowMs: 1_001 + SELF_RESTART_GRACE_MS,
    buildLockHeld: false,
    inFlightWorkers: 0,
    pendingActions: 0,
    topicLocksHeld: 0,
    graceMs: SELF_RESTART_GRACE_MS,
    disabled: false,
    ...overrides,
  };
}

describe('shouldSelfRestart', () => {
  it('the baseline case (sanity check) restarts', () => {
    const d = shouldSelfRestart(baseInputs());
    assert.deepEqual(d, { restart: true, reason: 'stamp-newer-and-idle', stampIsNewer: true });
  });

  it('disabled wins over an otherwise-restartable input', () => {
    const d = shouldSelfRestart(baseInputs({ disabled: true }));
    assert.deepEqual(d, { restart: false, reason: 'disabled', stampIsNewer: false });
  });

  it('stampMtimeMs === null -> no-stamp', () => {
    const d = shouldSelfRestart(baseInputs({ stampMtimeMs: null }));
    assert.deepEqual(d, { restart: false, reason: 'no-stamp', stampIsNewer: false });
  });

  it('stampMtimeMs === procStartMs -> stamp-older (the boundary is <=)', () => {
    const d = shouldSelfRestart(baseInputs({ procStartMs: 1_000, stampMtimeMs: 1_000 }));
    assert.deepEqual(d, { restart: false, reason: 'stamp-older', stampIsNewer: false });
  });

  it('stampMtimeMs < procStartMs -> stamp-older', () => {
    const d = shouldSelfRestart(baseInputs({ procStartMs: 1_000, stampMtimeMs: 999 }));
    assert.deepEqual(d, { restart: false, reason: 'stamp-older', stampIsNewer: false });
  });

  it('within-grace at graceMs - 1', () => {
    const d = shouldSelfRestart(
      baseInputs({ procStartMs: 0, stampMtimeMs: 1, nowMs: SELF_RESTART_GRACE_MS }),
    );
    assert.deepEqual(d, { restart: false, reason: 'within-grace', stampIsNewer: true });
  });

  it('restarts at exactly graceMs (grace boundary)', () => {
    const d = shouldSelfRestart(
      baseInputs({ procStartMs: 0, stampMtimeMs: 1, nowMs: 1 + SELF_RESTART_GRACE_MS }),
    );
    assert.deepEqual(d, { restart: true, reason: 'stamp-newer-and-idle', stampIsNewer: true });
  });

  it('build-lock-held wins over busy', () => {
    const d = shouldSelfRestart(baseInputs({ buildLockHeld: true, inFlightWorkers: 3, pendingActions: 2, topicLocksHeld: 1 }));
    assert.deepEqual(d, { restart: false, reason: 'build-lock-held', stampIsNewer: true });
  });

  it('inFlightWorkers > 0 alone blocks as busy', () => {
    const d = shouldSelfRestart(baseInputs({ inFlightWorkers: 1 }));
    assert.deepEqual(d, { restart: false, reason: 'busy', stampIsNewer: true });
  });

  it('pendingActions > 0 alone blocks as busy', () => {
    const d = shouldSelfRestart(baseInputs({ pendingActions: 1 }));
    assert.deepEqual(d, { restart: false, reason: 'busy', stampIsNewer: true });
  });

  it('topicLocksHeld > 0 alone blocks as busy', () => {
    const d = shouldSelfRestart(baseInputs({ topicLocksHeld: 1 }));
    assert.deepEqual(d, { restart: false, reason: 'busy', stampIsNewer: true });
  });

  it('otherwise restarts: stamp-newer-and-idle', () => {
    const d = shouldSelfRestart(baseInputs());
    assert.equal(d.restart, true);
    assert.equal(d.reason, 'stamp-newer-and-idle');
    assert.equal(d.stampIsNewer, true);
  });

  it('stampIsNewer is true for every reason from within-grace onward, false before it', () => {
    const beforeCases: Array<[string, Partial<SelfRestartInputs>]> = [
      ['disabled', { disabled: true }],
      ['no-stamp', { stampMtimeMs: null }],
      ['stamp-older', { procStartMs: 1_000, stampMtimeMs: 1_000 }],
    ];
    for (const [label, overrides] of beforeCases) {
      const d = shouldSelfRestart(baseInputs(overrides));
      assert.equal(d.stampIsNewer, false, `expected stampIsNewer=false for ${label}`);
    }

    const fromWithinGraceCases: Array<[string, Partial<SelfRestartInputs>]> = [
      ['within-grace', { procStartMs: 0, stampMtimeMs: 1, nowMs: SELF_RESTART_GRACE_MS }],
      ['build-lock-held', { buildLockHeld: true }],
      ['busy', { inFlightWorkers: 1 }],
      ['stamp-newer-and-idle', {}],
    ];
    for (const [label, overrides] of fromWithinGraceCases) {
      const d = shouldSelfRestart(baseInputs(overrides));
      assert.equal(d.stampIsNewer, true, `expected stampIsNewer=true for ${label}`);
    }
  });
});

describe('shouldWarnStaleCode', () => {
  it('false when firstSeenNewerStampMs is null', () => {
    assert.equal(shouldWarnStaleCode({ firstSeenNewerStampMs: null, nowMs: 10_000_000 }), false);
  });

  it('false at staleWarnMs - 1', () => {
    assert.equal(
      shouldWarnStaleCode({ firstSeenNewerStampMs: 0, nowMs: SELF_RESTART_STALE_WARN_MS - 1 }),
      false,
    );
  });

  it('true at exactly staleWarnMs', () => {
    assert.equal(
      shouldWarnStaleCode({ firstSeenNewerStampMs: 0, nowMs: SELF_RESTART_STALE_WARN_MS }),
      true,
    );
  });

  it('honors an explicit staleWarnMs override', () => {
    assert.equal(shouldWarnStaleCode({ firstSeenNewerStampMs: 0, nowMs: 999, staleWarnMs: 1000 }), false);
    assert.equal(shouldWarnStaleCode({ firstSeenNewerStampMs: 0, nowMs: 1000, staleWarnMs: 1000 }), true);
  });
});
