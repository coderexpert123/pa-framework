import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  markTopicRecovering,
  clearTopicRecovering,
  isTopicRecovering,
  _resetRecoveryGateForTest,
} from '../recovery-gate.js';

beforeEach(() => { _resetRecoveryGateForTest(); });
afterEach(() => { _resetRecoveryGateForTest(); });

describe('recovery-gate', () => {
  it('mark → is → clear round-trip', () => {
    assert.equal(isTopicRecovering('123_0'), false);
    markTopicRecovering('123_0');
    assert.equal(isTopicRecovering('123_0'), true);
    clearTopicRecovering('123_0');
    assert.equal(isTopicRecovering('123_0'), false);
  });

  it('an unmarked topic reports false', () => {
    assert.equal(isTopicRecovering('never_marked'), false);
  });

  it('clearing an unmarked key is a no-op (does not throw, does not affect others)', () => {
    markTopicRecovering('123_0');
    assert.doesNotThrow(() => clearTopicRecovering('999_0'));
    assert.equal(isTopicRecovering('123_0'), true, 'unrelated clear must not affect a different topic');
  });

  it('independent keys do not interfere with each other', () => {
    markTopicRecovering('123_0');
    markTopicRecovering('456_1');
    assert.equal(isTopicRecovering('123_0'), true);
    assert.equal(isTopicRecovering('456_1'), true);
    clearTopicRecovering('123_0');
    assert.equal(isTopicRecovering('123_0'), false);
    assert.equal(isTopicRecovering('456_1'), true, 'clearing one topic must not clear another');
  });
});
