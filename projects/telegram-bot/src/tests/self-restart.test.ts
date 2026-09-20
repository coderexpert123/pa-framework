import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSelfRestart,
  shouldWarnStaleCode,
  formatDurationCompact,
  formatRestartBlockers,
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
    pollLoopInFlight: 0,
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

  it('pollLoopInFlight > 0 alone blocks as busy (all other durable signals zero)', () => {
    const d = shouldSelfRestart(baseInputs({ pollLoopInFlight: 1 }));
    assert.deepEqual(d, { restart: false, reason: 'busy', stampIsNewer: true });
  });

  it('pollLoopInFlight === 0 with every other signal zero still restarts (guards against an always-busy check)', () => {
    const d = shouldSelfRestart(baseInputs({ pollLoopInFlight: 0 }));
    assert.deepEqual(d, { restart: true, reason: 'stamp-newer-and-idle', stampIsNewer: true });
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
      ['busy (pollLoopInFlight)', { pollLoopInFlight: 1 }],
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

describe('formatDurationCompact', () => {
  it('renders minutes under an hour: 42m', () => {
    assert.equal(formatDurationCompact(42 * 60_000), '42m');
  });

  it('renders hours with zero-padded minutes: 65m -> 1h 05m', () => {
    assert.equal(formatDurationCompact(65 * 60_000), '1h 05m');
  });

  it('clamps negative input to 0m (clock skew)', () => {
    assert.equal(formatDurationCompact(-1000), '0m');
  });
});

describe('formatRestartBlockers', () => {
  it('empty string when nothing blocks', () => {
    assert.equal(formatRestartBlockers(baseInputs()), '');
  });

  it('build lock alone: "@build reservation held"', () => {
    const result = formatRestartBlockers(baseInputs({ buildLockHeld: true }));
    assert.equal(result, '@build reservation held');
  });

  it('each busy input alone lists exactly its own clause', () => {
    assert.equal(formatRestartBlockers(baseInputs({ inFlightWorkers: 2 })), 'in-flight workers×2');
    assert.equal(formatRestartBlockers(baseInputs({ topicLocksHeld: 1 })), 'topic locks×1 (this pid)');
    assert.equal(formatRestartBlockers(baseInputs({ pendingActions: 3 })), 'pending_action×3');
    assert.equal(formatRestartBlockers(baseInputs({ pollLoopInFlight: 4 })), 'in-flight turns×4');
  });

  it('pending_action includes the oldest age when provided', () => {
    const result = formatRestartBlockers(baseInputs({ pendingActions: 1, oldestPendingActionAgeMs: 3_600_000 }));
    assert.equal(result, 'pending_action×1 (oldest 1h 00m)');
  });

  it('null / undefined / negative oldestPendingActionAgeMs omits the age text', () => {
    assert.equal(formatRestartBlockers(baseInputs({ pendingActions: 1, oldestPendingActionAgeMs: null })), 'pending_action×1');
    assert.equal(formatRestartBlockers(baseInputs({ pendingActions: 1, oldestPendingActionAgeMs: undefined })), 'pending_action×1');
    assert.equal(formatRestartBlockers(baseInputs({ pendingActions: 1, oldestPendingActionAgeMs: -1000 })), 'pending_action×1');
  });

  it('all blockers together join in the pinned order', () => {
    const result = formatRestartBlockers(baseInputs({
      buildLockHeld: true,
      inFlightWorkers: 1,
      pendingActions: 2,
      oldestPendingActionAgeMs: 5 * 60_000,
      topicLocksHeld: 1,
      pollLoopInFlight: 2,
    }));
    assert.equal(result, '@build reservation held, in-flight workers×1, pending_action×2 (oldest 5m), topic locks×1 (this pid), in-flight turns×2');
  });
});
