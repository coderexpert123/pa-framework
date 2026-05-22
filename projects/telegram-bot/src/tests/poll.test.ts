import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeBackoff, computePollOffset, BACKOFF_STEP_MS, MAX_BACKOFF_MS } from '../poll.js';

// ---------------------------------------------------------------------------
// computeBackoff
// ---------------------------------------------------------------------------

describe('computeBackoff', () => {
  it('returns 0 for 0 consecutive errors', () => {
    assert.equal(computeBackoff(0), 0);
  });

  it('returns BACKOFF_STEP_MS for 1 error', () => {
    assert.equal(computeBackoff(1), BACKOFF_STEP_MS);
  });

  it('returns 2 * BACKOFF_STEP_MS for 2 errors', () => {
    assert.equal(computeBackoff(2), 2 * BACKOFF_STEP_MS);
  });

  it('returns 3 * BACKOFF_STEP_MS for 3 errors', () => {
    assert.equal(computeBackoff(3), 3 * BACKOFF_STEP_MS);
  });

  it('caps at MAX_BACKOFF_MS when errors * step exceeds max', () => {
    const errorsNeededToExceed = Math.ceil(MAX_BACKOFF_MS / BACKOFF_STEP_MS) + 1;
    assert.equal(computeBackoff(errorsNeededToExceed), MAX_BACKOFF_MS);
  });

  it('caps at MAX_BACKOFF_MS for large error counts (e.g. 100)', () => {
    assert.equal(computeBackoff(100), MAX_BACKOFF_MS);
  });

  it('returns 0 for negative input (guard against caller bugs)', () => {
    assert.equal(computeBackoff(-1), 0);
  });

  it('returns exact MAX_BACKOFF_MS when errors * step equals max', () => {
    const exactErrors = MAX_BACKOFF_MS / BACKOFF_STEP_MS;
    assert.equal(computeBackoff(exactErrors), MAX_BACKOFF_MS);
  });
});

// ---------------------------------------------------------------------------
// computePollOffset
// ---------------------------------------------------------------------------

describe('computePollOffset', () => {
  it('returns 0 for -1 (drain-complete, no prior messages sentinel)', () => {
    assert.equal(computePollOffset(-1), 0);
  });

  it('returns 0 for any negative value', () => {
    assert.equal(computePollOffset(-999), 0);
    assert.equal(computePollOffset(-2), 0);
  });

  it('returns 1 for lastUpdateId 0 (first real update processed)', () => {
    assert.equal(computePollOffset(0), 1);
  });

  it('returns N+1 for positive N', () => {
    assert.equal(computePollOffset(42), 43);
    assert.equal(computePollOffset(1), 2);
    assert.equal(computePollOffset(999), 1000);
  });
});
