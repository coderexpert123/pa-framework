import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WatermarkTracker } from '../watermark.js';

// ---------------------------------------------------------------------------
// Basic operations
// ---------------------------------------------------------------------------

describe('WatermarkTracker: basic operations', { concurrency: 1 }, () => {
  it('initial ackOffset matches constructor arg', () => {
    const wm = new WatermarkTracker(50);
    assert.equal(wm.ackOffset, 50);
    assert.equal(wm.hasPending, false);
    assert.equal(wm.pendingCount, 0);
  });

  it('register adds to pending without changing ackOffset', () => {
    const wm = new WatermarkTracker(50);
    wm.register(51);
    assert.equal(wm.pendingCount, 1);
    assert.equal(wm.hasPending, true);
    assert.equal(wm.ackOffset, 50); // unchanged
  });

  it('complete single update advances ackOffset and returns new value', () => {
    const wm = new WatermarkTracker(50);
    wm.register(51);
    const result = wm.complete(51);
    assert.equal(result, 51);
    assert.equal(wm.ackOffset, 51);
    assert.equal(wm.hasPending, false);
  });

  it('complete returns -1 when ackOffset does not advance (gap exists)', () => {
    const wm = new WatermarkTracker(50);
    wm.register(51);
    wm.register(53); // gap at 52
    // complete(53): pending={51}, new ack = min(51)-1=50. 50 > 50? No → -1
    const result = wm.complete(53);
    assert.equal(result, -1);
    assert.equal(wm.ackOffset, 50); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Contiguous watermark
// ---------------------------------------------------------------------------

describe('WatermarkTracker: contiguous watermark', { concurrency: 1 }, () => {
  it('gap fills: register [51,52,53], complete out-of-order → advances correctly', () => {
    const wm = new WatermarkTracker(50);
    wm.register(51);
    wm.register(52);
    wm.register(53);

    // complete(53): pending={51,52}, new ack=min(51,52)-1=50. 50>50? No → -1
    assert.equal(wm.complete(53), -1);
    assert.equal(wm.ackOffset, 50);

    // complete(51): pending={52}, new ack=min(52)-1=51. 51>50 → return 51
    assert.equal(wm.complete(51), 51);
    assert.equal(wm.ackOffset, 51);

    // complete(52): pending={}, new ack=highWater=53. 53>51 → return 53
    assert.equal(wm.complete(52), 53);
    assert.equal(wm.ackOffset, 53);
  });

  it('cross-batch out-of-order: two batches complete in mixed order', () => {
    const wm = new WatermarkTracker(50);
    // Batch 1: [51,52]
    wm.register(51);
    wm.register(52);
    // Batch 2: [53,54]
    wm.register(53);
    wm.register(54);
    // highWater=54, pending={51,52,53,54}

    // complete(54): pending={51,52,53}, new ack=min(51,52,53)-1=50. 50>50? No → -1
    assert.equal(wm.complete(54), -1);
    // complete(52): pending={51,53}, new ack=min(51,53)-1=50. 50>50? No → -1
    assert.equal(wm.complete(52), -1);
    // complete(51): pending={53}, new ack=min(53)-1=52. 52>50 → return 52
    assert.equal(wm.complete(51), 52);
    assert.equal(wm.ackOffset, 52);

    // complete(53): pending={}, new ack=highWater=54. 54>52 → return 54
    assert.equal(wm.complete(53), 54);
    assert.equal(wm.ackOffset, 54);
  });

  it('sequential register-and-complete cycles work correctly', () => {
    const wm = new WatermarkTracker(-1);
    // Cycle 1
    wm.register(10);
    assert.equal(wm.complete(10), 10);
    assert.equal(wm.ackOffset, 10);
    // Cycle 2
    wm.register(11);
    assert.equal(wm.complete(11), 11);
    assert.equal(wm.ackOffset, 11);
    // Cycle 3: two updates, complete in order
    // complete(12): pending={13}, new ack=min(13)-1=12. 12>11 → return 12
    wm.register(12);
    wm.register(13);
    assert.equal(wm.complete(12), 12);
    assert.equal(wm.ackOffset, 12);
    // complete(13): pending={}, new ack=highWater=13. 13>12 → return 13
    assert.equal(wm.complete(13), 13);
    assert.equal(wm.ackOffset, 13);
  });

  it('negative initial offset (-1 drain sentinel): register 99, complete 99 → ack=99', () => {
    const wm = new WatermarkTracker(-1);
    wm.register(99);
    const result = wm.complete(99);
    assert.equal(result, 99);
    assert.equal(wm.ackOffset, 99);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('WatermarkTracker: edge cases', { concurrency: 1 }, () => {
  it('complete unregistered ID is a no-op: no throw, no ackOffset change', () => {
    const wm = new WatermarkTracker(50);
    wm.register(51);
    const result = wm.complete(999); // never registered
    assert.equal(result, -1);
    assert.equal(wm.ackOffset, 50); // unchanged
    assert.equal(wm.pendingCount, 1); // 51 still pending
  });

  it('large batch: complete first and last only → ack advances to first only', () => {
    const wm = new WatermarkTracker(0);
    for (let i = 1; i <= 10; i++) wm.register(i);

    // complete(1): pending={2..10}, new ack=min(2..10)-1=1. 1>0 → return 1
    assert.equal(wm.complete(1), 1);
    assert.equal(wm.ackOffset, 1);

    // complete(10): pending={2..9}, new ack=min(2..9)-1=1. 1>1? No → -1
    assert.equal(wm.complete(10), -1);
    assert.equal(wm.ackOffset, 1); // blocked by 2-9
  });
});
