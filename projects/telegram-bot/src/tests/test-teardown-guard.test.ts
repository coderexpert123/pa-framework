// AI-172 fix#1: proves the teardown guard's latch actually HOLDS. Before this
// file, trackPendingWork had zero call sites — the latch counter was always 0,
// so every `await waitForDrain()` in afterEach hooks was a guaranteed no-op and
// the guard was inert by construction. These tests pin the counter semantics
// the hooks rely on: a tracked fake async op delays waitForDrain() resolution
// until released; the drain fires only when the LAST tracked op releases.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { trackPendingWork, waitForDrain, _resetTeardownGuardForTest } from './test-teardown-guard.js';

const yieldTick = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  _resetTeardownGuardForTest();
});

describe('test-teardown-guard latch (AI-172 fix#1)', () => {
  it('waitForDrain resolves immediately when nothing is tracked', async () => {
    await waitForDrain(); // must not hang
  });

  it('a tracked async op holds waitForDrain until it releases', async () => {
    const [release] = trackPendingWork(1);
    let drained = false;
    const drainedPromise = waitForDrain().then(() => { drained = true; });

    await yieldTick();
    assert.equal(drained, false, 'drain must NOT resolve while tracked work is pending');

    release();
    await yieldTick();
    assert.equal(drained, true, 'drain must resolve once the tracked op releases');
    await drainedPromise;
  });

  it('the latch holds across a real fake-async op: drain resolves only after the op settles', async () => {
    const [release] = trackPendingWork(1);
    const op = (async () => {
      await new Promise<void>((r) => setTimeout(r, 30));
      release();
    })();
    let drained = false;
    const drainedPromise = waitForDrain().then(() => { drained = true; });

    await Promise.race([op, new Promise<void>((r) => setTimeout(r, 5))]);
    assert.equal(drained, false, 'drain must still be held while the op is mid-flight');

    await op;
    await drainedPromise;
    assert.equal(drained, true, 'drain resolves only after the op settles and releases');
  });

  it('multiple tracked ops: drain fires only when the LAST one releases', async () => {
    const releases = trackPendingWork(2);
    let drained = false;
    const drainedPromise = waitForDrain().then(() => { drained = true; });

    releases[0]();
    await yieldTick();
    assert.equal(drained, false, 'one of two ops still pending — drain must stay held');

    releases[1]();
    await yieldTick();
    assert.equal(drained, true, 'all released — drain resolves');
    await drainedPromise;
  });

  it('a reset while a waiter is parked orphans that waiter (documented hazard)', async () => {
    // Not behavior to build on — this pins the known shape so a future change
    // that relies on reset-resolving waiters notices it changed something.
    const [release] = trackPendingWork(1);
    let drained = false;
    const drainedPromise = waitForDrain().then(() => { drained = true; });

    _resetTeardownGuardForTest();
    release(); // counter hits 0, but the stored resolver is gone — no resolve
    await yieldTick();
    assert.equal(drained, false, 'reset orphaned the parked waiter (documented hazard)');
  });
});
