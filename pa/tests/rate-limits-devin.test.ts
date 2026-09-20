import './test-env-guard.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';

const PA_HOME = join(tmpdir(), `rate-limits-devin-test-${process.pid}`);
process.env.PA_HOME = PA_HOME;
process.env.PA_NOTIFY_DISABLED = '1';

import { classifyDevinError } from '../src/rate-limits-devin.js';
import { DEFAULT_COOLDOWN_MINUTES } from '../src/rate-limits.js';

describe('classifyDevinError', () => {
  it('returns null for empty or unrelated stderr', () => {
    assert.equal(classifyDevinError(''), null);
    assert.equal(classifyDevinError('some random error'), null);
    assert.equal(classifyDevinError('build succeeded with warnings'), null);
  });

  it('classifies "retry after N minutes" as quota-per-minute', () => {
    const result = classifyDevinError('Rate limit exceeded, please retry after 2 minutes');
    assert.ok(result);
    assert.equal(result!.classification, 'quota-per-minute');
    assert.equal(result!.minutes, 2);
    assert.equal(result!.source, 'devin-text');
  });

  it('classifies "retry in N min" as quota-per-minute', () => {
    const result = classifyDevinError('Rate limited — retry in 5 min');
    assert.ok(result);
    assert.equal(result!.classification, 'quota-per-minute');
    assert.equal(result!.minutes, 5);
  });

  it('classifies "retry after N seconds" as quota-per-minute (rounded up)', () => {
    const result = classifyDevinError('Rate limit hit, retry after 90 seconds');
    assert.ok(result);
    assert.equal(result!.classification, 'quota-per-minute');
    assert.equal(result!.minutes, 2);
  });

  it('classifies "retry after 30s" as 1 minute', () => {
    const result = classifyDevinError('Too many requests. Retry after 30s');
    assert.ok(result);
    assert.equal(result!.classification, 'quota-per-minute');
    assert.equal(result!.minutes, 1);
  });

  it('classifies bare "quota exceeded" as unknown with default cooldown', () => {
    const result = classifyDevinError('quota exceeded');
    assert.ok(result);
    assert.equal(result!.classification, 'unknown');
    assert.equal(result!.minutes, DEFAULT_COOLDOWN_MINUTES);
    assert.equal(result!.source, 'devin-text');
  });

  it('classifies account-exhausted messages as account-exhausted (360 min)', () => {
    const result = classifyDevinError('Insufficient balance or out of credits');
    assert.ok(result);
    assert.equal(result!.classification, 'account-exhausted');
    assert.equal(result!.minutes, 360);
    assert.equal(result!.source, 'devin-text');
  });

  it('classifies bare "rate limit" as unknown with default cooldown', () => {
    const result = classifyDevinError('rate limit: try again later');
    assert.ok(result);
    assert.equal(result!.classification, 'unknown');
    assert.equal(result!.minutes, DEFAULT_COOLDOWN_MINUTES);
    assert.equal(result!.source, 'devin-text');
  });

  it('classifies HTTP 429 as unknown with default cooldown', () => {
    const result = classifyDevinError('429 Too Many Requests');
    assert.ok(result);
    assert.equal(result!.classification, 'unknown');
    assert.equal(result!.minutes, DEFAULT_COOLDOWN_MINUTES);
    assert.equal(result!.source, 'devin-text');
  });

  it('classifies usage limit as unknown with default cooldown', () => {
    const result = classifyDevinError('usage limit reached for this session');
    assert.ok(result);
    assert.equal(result!.classification, 'unknown');
    assert.equal(result!.minutes, DEFAULT_COOLDOWN_MINUTES);
  });
});
