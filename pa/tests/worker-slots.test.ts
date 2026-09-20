import './test-env-guard.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireWorkerSlot, workerSlotCount, executeWorker } from '../src/worker-exec.js';
import { _setDepsForTest, _resetForTest } from '../src/lib/dynamic-slots.js';
import { getWorkerCooldown, clearRateLimitCache } from '../src/rate-limits.js';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import type { WorkerConfig } from '../src/types.js';

const heldSlots = new Set<string>();
const fakeBb = {
  async acquireLock(resource: string): Promise<boolean> {
    if (heldSlots.has(resource)) return false;
    heldSlots.add(resource);
    return true;
  },
};
const noSleep = async () => {};

beforeEach(() => {
  heldSlots.clear();
  // Legacy suite = kill-switch suite: these exact-count assertions are only
  // machine-independent with dynamic slots off (2026-09-11 dynamic-slots wave).
  process.env.PA_DYNAMIC_SLOTS = '0';
});
afterEach(() => {
  delete process.env.PA_MAX_CONCURRENT_WORKERS;
  delete process.env.PA_DYNAMIC_SLOTS;
  delete process.env.PA_SLOTS_MIN;
});

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

describe('routing priority', () => {
  it('a routing waiter polls every 250ms', async () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = '1';
    heldSlots.add('worker-slot-0');
    const captured: number[] = [];
    const recordingSleep = async (ms: number) => { captured.push(ms); };
    const h = await acquireWorkerSlot('bot', 1, fakeBb as any, recordingSleep, undefined, { priority: 'routing' });
    assert.equal(h, null);
    assert.equal(captured[0], 250);
  });

  it('a normal waiter keeps the 5000ms cadence', async () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = '1';
    heldSlots.add('worker-slot-0');
    const captured: number[] = [];
    const recordingSleep = async (ms: number) => { captured.push(ms); };
    const h = await acquireWorkerSlot('bot', 1, fakeBb as any, recordingSleep);
    assert.equal(h, null);
    assert.equal(captured[0], 5000);
  });
});

describe('dynamic cap integration', () => {
  afterEach(() => _resetForTest());

  it('an unpressured pool scans up to the full ceiling', async () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = '30';
    process.env.PA_SLOTS_MIN = '1';
    delete process.env.PA_DYNAMIC_SLOTS; // override the file-level kill-switch pin: dynamic ON for this test
    _setDepsForTest({ readSample: () => null, cpuCount: () => 12 });

    const attempted: string[] = [];
    const recordingBb = {
      async acquireLock(resource: string): Promise<boolean> {
        attempted.push(resource);
        return false; // never actually acquire — this test only inspects what was attempted
      },
    };
    const h = await acquireWorkerSlot('bot', 1, recordingBb as any, noSleep);
    assert.equal(h, null);
    // The do/while in acquireWorkerSlot can complete more than one full pass
    // within maxWaitMs=1 under load (noSleep returns immediately), so the
    // total attempt count isn't stable — assert reach and bound instead of
    // an exact count, same style as the pre-rewrite ramCap test used.
    assert.ok(attempted.includes('worker-slot-29'), 'an unpressured pool must scan up to the full ceiling');
    assert.ok(
      attempted.every((r) => /^worker-slot-(\d+)$/.test(r) && Number(r.slice('worker-slot-'.length)) < 30),
      'the scan must never attempt a slot beyond the ceiling',
    );
  });

  it('workerSlotCount reports the ceiling when nothing is pressured', () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = '30';
    process.env.PA_SLOTS_MIN = '1';
    delete process.env.PA_DYNAMIC_SLOTS;
    _setDepsForTest({ readSample: () => null, cpuCount: () => 12 });
    assert.equal(workerSlotCount(), 30);
  });
});

describe('derived ceiling wiring', () => {
  afterEach(() => _resetForTest());

  it('workerSlotCount uses the derived ceiling when the env var is unset', () => {
    delete process.env.PA_MAX_CONCURRENT_WORKERS;
    delete process.env.PA_DYNAMIC_SLOTS; // dynamic ON for this test
    _setDepsForTest({ readSample: () => null, cpuCount: () => 12 });
    // clamp(4, 12 cores * 4, 64) = 48
    assert.equal(workerSlotCount(), 48);
  });

  it('workerSlotCount honors an explicit env ceiling verbatim', () => {
    process.env.PA_MAX_CONCURRENT_WORKERS = '7';
    delete process.env.PA_DYNAMIC_SLOTS;
    _setDepsForTest({ readSample: () => null, cpuCount: () => 12 });
    assert.equal(workerSlotCount(), 7);
  });

  it('the kill switch with an unset env var still reports the legacy 3', () => {
    delete process.env.PA_MAX_CONCURRENT_WORKERS;
    process.env.PA_DYNAMIC_SLOTS = '0';
    _setDepsForTest({ readSample: () => null, cpuCount: () => 12 });
    assert.equal(workerSlotCount(), 3);
  });
});

describe('S8 fault cooldown', () => {
  let tempDir: string;

  beforeEach(async () => {
    clearRateLimitCache();
    tempDir = await createTempPaHome();
    await createTempSecrets(tempDir, '');
  });

  afterEach(async () => {
    await cleanup(tempDir);
  });

  it('an error-loop kill leaves a fault cooldown for the worker', async () => {
    // Mirrors worker-exec-agy-error-loop.test.ts's known-bad case: the
    // AGY_ERROR_LOOP_THRESHOLD (2) consecutive error_message step_update
    // events with no usable output in between fires the guard (this stream
    // supplies 3, well past the threshold), which now (S8) must also leave a
    // cooldown row behind so the next dispatch skips this worker instead of
    // re-spawning it to fail the same way.
    const conv = 'worker-slots-s8-cooldown-test';
    const stepUpdate = (index: number, fields: Record<string, unknown>): string =>
      JSON.stringify({
        event: 'step_update',
        step_update: { conversation_id: conv, step_index: index, state: 'DONE', ...fields },
      });
    const lines = [
      JSON.stringify({ event: 'init', conversation_id: conv, init: { model: 'gemini-3.8-flash-high' } }),
      stepUpdate(1, { step_type: 'agent_response', duration_seconds: 1.2 }),
      stepUpdate(2, { step_type: 'error_message', duration_seconds: 0 }),
      stepUpdate(3, { step_type: 'agent_response', duration_seconds: 0.6 }),
      stepUpdate(4, { step_type: 'error_message', duration_seconds: 0 }),
      stepUpdate(5, { step_type: 'agent_response', duration_seconds: 0.9 }),
      stepUpdate(6, { step_type: 'error_message', duration_seconds: 0 }),
    ];
    const scriptPath = join(tmpdir(), `pa-test-worker-slots-s8-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(scriptPath, `process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')})\n`, 'utf8');
    try {
      const worker: WorkerConfig = {
        name: 'agy',
        command: `"${process.execPath}"`,
        args: [scriptPath],
        check: 'echo ok',
        rate_limit_patterns: [],
        priority: 1,
        input_mode: 'stdin-text',
        check_timeout: 5,
        output_format: 'stream-json',
      };

      const result = await executeWorker(worker, 'test prompt', { timeout: 10 });
      assert.equal(result.success, false, 'a run stuck in the error loop must be reported as a failure');

      // recordRateLimit is fired with `void` (fire-and-forget) from
      // killWithMessage, so the cooldown write can still be in flight when
      // executeWorker's own promise resolves — poll instead of asserting
      // immediately.
      const deadline = Date.now() + 5000;
      let cooldown = await getWorkerCooldown('agy');
      while (!cooldown && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        cooldown = await getWorkerCooldown('agy');
      }
      assert.ok(cooldown, 'expected a fault cooldown row for agy to appear');
      assert.equal(cooldown!.reason, '[error-loop] agy-error-loop');
    } finally {
      await rm(scriptPath, { force: true }).catch(() => {});
    }
  });
});
