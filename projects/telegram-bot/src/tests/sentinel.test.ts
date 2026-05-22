import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSentinel } from '../sentinel.js';

describe('parseSentinel', () => {
  it('parses stop JSON', () => {
    const result = parseSentinel('{"mode":"stop","ts":1234}');
    assert.deepEqual(result, { mode: 'stop', ts: 1234 });
  });

  it('parses restart JSON', () => {
    const result = parseSentinel('{"mode":"restart","ts":5678}');
    assert.deepEqual(result, { mode: 'restart', ts: 5678 });
  });

  it('handles legacy numeric payload as stop', () => {
    const result = parseSentinel('1746000000000');
    assert.deepEqual(result, { mode: 'stop', ts: 1746000000000 });
  });

  it('returns default for garbage input', () => {
    const result = parseSentinel('garbage');
    assert.deepEqual(result, { mode: 'stop', ts: 0 });
  });

  it('returns default for unknown mode', () => {
    const result = parseSentinel('{"mode":"unknown","ts":0}');
    assert.deepEqual(result, { mode: 'stop', ts: 0 });
  });

  it('uses ts=0 when ts field is missing from valid mode JSON', () => {
    const result = parseSentinel('{"mode":"restart"}');
    assert.deepEqual(result, { mode: 'restart', ts: 0 });
  });
});
