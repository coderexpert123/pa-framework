import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDurationMs, parseMaintenance } from '../src/config.js';

describe('parseDurationMs', () => {
  it('parses valid durations', () => {
    assert.equal(parseDurationMs('30s'), 30_000);
    assert.equal(parseDurationMs('5m'), 300_000);
    assert.equal(parseDurationMs('6h'), 21_600_000);
    assert.equal(parseDurationMs('7d'), 604_800_000);
    assert.equal(parseDurationMs('250ms'), 250);
  });

  it('rejects a bare integer and other invalid input', () => {
    for (const bad of ['6', 'abc', '', null, -1, '0s']) {
      assert.equal(parseDurationMs(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe('parseMaintenance', () => {
  it('parses a well-formed block', () => {
    const result = parseMaintenance({ 'session-gc': { enabled: false, every: '6h' } });
    assert.deepEqual(result, { 'session-gc': { enabled: false, everyMs: 21_600_000 } });
  });

  it('returns undefined for a non-mapping top-level value', () => {
    assert.equal(parseMaintenance('nope'), undefined);
  });

  it('returns undefined when every entry is malformed', () => {
    assert.equal(parseMaintenance({ x: 'nope' }), undefined);
  });

  it('warn-and-skips a bad "every" without throwing, dropping the whole entry', () => {
    assert.doesNotThrow(() => {
      const result = parseMaintenance({ x: { every: 'banana' } });
      assert.equal(result?.x, undefined);
    });
  });

  it('drops a bad "enabled" but keeps a good "every"', () => {
    const result = parseMaintenance({ x: { enabled: 'yes', every: '1h' } });
    assert.deepEqual(result, { x: { everyMs: 3_600_000 } });
  });

  it('returns undefined when the input is undefined', () => {
    assert.equal(parseMaintenance(undefined), undefined);
  });
});
