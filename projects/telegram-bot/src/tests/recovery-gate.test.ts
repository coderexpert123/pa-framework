import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  markTopicRecovering,
  clearTopicRecovering,
  isTopicRecovering,
  _resetRecoveryGateForTest,
  waitForTopicRecovery,
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

  it('waitForTopicRecovery resolves true immediately for an unmarked topic', async () => {
    const result = await waitForTopicRecovery('never_marked', 5000);
    assert.equal(result, true);
  });

  it('waitForTopicRecovery resolves true when the topic is cleared (waiter registry)', async () => {
    markTopicRecovering('123_0');
    const promise = waitForTopicRecovery('123_0', 5000);
    // Clear after a short delay to ensure the waiter is registered
    await new Promise(r => setTimeout(r, 20));
    clearTopicRecovering('123_0');
    const result = await promise;
    assert.equal(result, true);
  });

  it('waitForTopicRecovery resolves false on timeout while still marked', async () => {
    markTopicRecovering('123_0');
    const result = await waitForTopicRecovery('123_0', 150);
    assert.equal(result, false);
    _resetRecoveryGateForTest();
  });

  it('clear resolves ALL waiters for the topic and only that topic', async () => {
    markTopicRecovering('123_0');
    markTopicRecovering('456_1');
    const p1 = waitForTopicRecovery('123_0', 5000);
    const p2 = waitForTopicRecovery('123_0', 5000);
    const p3 = waitForTopicRecovery('456_1', 5000);
    // Clear 123_0 after a short delay to ensure waiters are registered
    await new Promise(r => setTimeout(r, 20));
    clearTopicRecovering('123_0');
    assert.equal(await p1, true);
    assert.equal(await p2, true);
    // 456_1 should still be waiting (timeout)
    assert.equal(await p3, false);
  });

  it('a timed-out waiter is removed from the registry (no leak, no late resolve)', async () => {
    markTopicRecovering('123_0');
    const promise = waitForTopicRecovery('123_0', 200);
    // Wait for timeout
    const result = await promise;
    assert.equal(result, false);
    // Clear after timeout - should not resolve anything (waiter already removed)
    clearTopicRecovering('123_0');
    // Verify by marking again and waiting - should also timeout
    markTopicRecovering('123_0');
    const result2 = await waitForTopicRecovery('123_0', 150);
    assert.equal(result2, false, 'second wait should also timeout (no late resolve from first)');
    _resetRecoveryGateForTest();
  });
});
