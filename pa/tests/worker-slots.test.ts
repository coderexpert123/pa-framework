import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { acquireWorkerSlot, workerSlotCount } from '../src/worker-exec.js';

const heldSlots = new Set<string>();
const fakeBb = {
  async acquireLock(resource: string): Promise<boolean> {
    if (heldSlots.has(resource)) return false;
    heldSlots.add(resource);
    return true;
  },
};
const noSleep = async () => {};

beforeEach(() => heldSlots.clear());
afterEach(() => delete process.env.PA_MAX_CONCURRENT_WORKERS);

describe('workerSlotCount', () => {
  it('defaults to 3', () => {
    delete process.env.PA_MAX_CONCURRENT_WORKERS;
    assert.equal(workerSlotCount(), 3);
  });
  it('honors the env var', () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = '5';
    assert.equal(workerSlotCount(), 5);
  });
  it('falls back to 3 on garbage', () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = 'lots';
    assert.equal(workerSlotCount(), 3);
  });
});

describe('acquireWorkerSlot', () => {
  it("returns 'disabled' when the limit is <= 0", async () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = '0';
    assert.equal(await acquireWorkerSlot('bot', 1000, fakeBb as any, noSleep), 'disabled');
  });

  it('acquires the first free slot', async () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = '2';
    const h = await acquireWorkerSlot('bot', 1000, fakeBb as any, noSleep);
    assert.ok(h !== null && h !== 'disabled');
    assert.equal(h.slot, 'worker-slot-0');
    assert.ok(h.ctx.length > 0, 'fresh contextId per acquisition');
  });

  it('skips busy slots and takes the next free one', async () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = '2';
    heldSlots.add('worker-slot-0');
    const h = await acquireWorkerSlot('bot', 1000, fakeBb as any, noSleep);
    assert.ok(h !== null && h !== 'disabled');
    assert.equal(h.slot, 'worker-slot-1');
  });

  it('returns null when every slot stays busy past the deadline', async () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = '2';
    heldSlots.add('worker-slot-0');
    heldSlots.add('worker-slot-1');
    const start = Date.now();
    const h = await acquireWorkerSlot('bot', 1, fakeBb as any, noSleep);
    assert.equal(h, null);
    assert.ok(Date.now() - start < 5000, 'no real sleeping with injected sleep');
  });

  it('retries after a sleep and wins a freed slot', async () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = '1';
    heldSlots.add('worker-slot-0');
    let sleeps = 0;
    const freeingSleep = async () => { sleeps++; heldSlots.delete('worker-slot-0'); };
    const h = await acquireWorkerSlot('bot', 60_000, fakeBb as any, freeingSleep);
    assert.ok(h !== null && h !== 'disabled');
    assert.equal(sleeps, 1);
  });

  it('two acquisitions get distinct slots and distinct contexts', async () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = '2';
    const a = await acquireWorkerSlot('bot', 1000, fakeBb as any, noSleep);
    const b = await acquireWorkerSlot('bot', 1000, fakeBb as any, noSleep);
    assert.ok(a !== null && a !== 'disabled' && b !== null && b !== 'disabled');
    assert.notEqual(a.slot, b.slot);
    assert.notEqual(a.ctx, b.ctx);
  });
});
