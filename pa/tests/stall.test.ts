import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'fs/promises';
import { createTempPaHome, cleanup } from './helpers.js';
import {
  withBoundedQueue,
  onStall,
  setStallHost,
  readStoreWaitMaxMs,
  stallRecordsPath,
  STALL_RECORDS_MAX_BYTES,
  _resetStallStateForTest,
  type StallRecord,
} from '../src/lib/stall.js';
import { log, flushLog, APP_LOG_QUEUE_KEY } from '../src/lib/log.js';
import { updateJobState, readLedger, maintenanceStateQueueKey, maintenanceStatePath } from '../src/lib/maintenance/state.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tmpHome: string;

describe('lib/stall bounded queues and stall records', { concurrency: 1 }, () => {
  beforeEach(async () => {
    tmpHome = await createTempPaHome();
  });

  afterEach(async () => {
    _resetStallStateForTest();
    await cleanup(tmpHome);
  });

  it('a hung predecessor detaches the successor after maxWaitMs and writes exactly one stall record', { timeout: 15_000 }, async () => {
    void withBoundedQueue('k1', () => new Promise<void>(() => {}), { store: 'test-store', target: 'hung.json', maxWaitMs: 100 });
    const result = await withBoundedQueue('k1', async () => 'ran', { store: 'test-store', target: 'hung.json', maxWaitMs: 100 });
    assert.equal(result, 'ran');
    const lines = (await readFile(stallRecordsPath(), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    const record: StallRecord = JSON.parse(lines[0]);
    assert.equal(record.store, 'test-store');
    assert.equal(record.target, 'hung.json');
    assert.equal(record.pid, process.pid);
    assert.equal(record.maxWaitMs, 100);
    assert.ok(record.waitedMs >= 90);
    assert.match(record.refId, /^s-[0-9a-f]{12}$/);
  });

  it('a successor behind a still-waiting predecessor detaches at the bound, not after the predecessor starts (AI-315)', { timeout: 15_000 }, async () => {
    // Chain: E1 hung head, E2 also never settles. Pre-AI-315 the third
    // caller awaited E2's `started` promise unbounded — E2 only starts after
    // E1's bound expires (~250ms), and E3 then waited E2's bound past that
    // (~500ms total). Chained, each link multiplied the bound, so a pass of
    // ~25 skip-writes could wait minutes per job and starve the list tail.
    // Now the bound runs from the PREDECESSOR's enqueue, so E3 detaches at
    // ~250ms.
    void withBoundedQueue('kchain', () => new Promise<void>(() => {}), { store: 'test-store', target: 'c1', maxWaitMs: 250 });
    void withBoundedQueue('kchain', () => new Promise<void>(() => {}), { store: 'test-store', target: 'c2', maxWaitMs: 250 });
    const t0 = Date.now();
    const result = await withBoundedQueue('kchain', async () => 'done', { store: 'test-store', target: 'c3', maxWaitMs: 250 });
    const elapsed = Date.now() - t0;
    assert.equal(result, 'done');
    assert.ok(
      elapsed < 420,
      `expected detach near one bound (~250ms), got ${elapsed}ms — the unbounded started-await chains to ~2×maxWaitMs`,
    );
  });

  it('a slow but progressing queue records no stall', { timeout: 15_000 }, async () => {
    const order: number[] = [];
    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      const idx = i;
      tasks.push(
        withBoundedQueue('k2', async () => {
          await sleep(60);
          order.push(idx);
        }, { store: 'test-store', target: 'k2', maxWaitMs: 100 }),
      );
    }
    await Promise.all(tasks);
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
    await assert.rejects(readFile(stallRecordsPath(), 'utf8'));
  });

  it('a settled queue runs in FIFO order', { timeout: 15_000 }, async () => {
    const order: number[] = [];
    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      const idx = i;
      tasks.push(
        withBoundedQueue('k3', async () => {
          await sleep(10 - idx);
          order.push(idx);
        }, { store: 'test-store', target: 'k3', maxWaitMs: 1000 }),
      );
    }
    await Promise.all(tasks);
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('a rejected predecessor neither blocks nor rejects its successor', { timeout: 15_000 }, async () => {
    const first = withBoundedQueue('k4', async () => {
      throw new Error('boom');
    }, { store: 'test-store', target: 'k4', maxWaitMs: 1000 });
    await assert.rejects(first, /boom/);
    const second = await withBoundedQueue('k4', async () => 'ok', { store: 'test-store', target: 'k4', maxWaitMs: 1000 });
    assert.equal(second, 'ok');
  });

  it('onStall listeners receive the record; an unsubscribed listener does not; a throwing listener does not stop the successor', { timeout: 15_000 }, async () => {
    const aRecords: StallRecord[] = [];
    const bRecords: StallRecord[] = [];
    const unsubA = onStall((r) => aRecords.push(r));
    const unsubB = onStall((r) => bRecords.push(r));
    onStall(() => {
      throw new Error('listener boom');
    });
    unsubB();
    void withBoundedQueue('k5', () => new Promise<void>(() => {}), { store: 'test-store', target: 'k5', maxWaitMs: 100 });
    const result = await withBoundedQueue('k5', async () => 'resolved', { store: 'test-store', target: 'k5', maxWaitMs: 100 });
    assert.equal(result, 'resolved');
    assert.equal(aRecords.length, 1);
    assert.equal(aRecords[0].store, 'test-store');
    assert.equal(bRecords.length, 0);
    unsubA();
  });

  it('readStoreWaitMaxMs honours PA_STORE_WAIT_MAX_MS and falls back to 180000', () => {
    const original = process.env.PA_STORE_WAIT_MAX_MS;
    try {
      delete process.env.PA_STORE_WAIT_MAX_MS;
      assert.equal(readStoreWaitMaxMs(), 180000);
      process.env.PA_STORE_WAIT_MAX_MS = '250';
      assert.equal(readStoreWaitMaxMs(), 250);
      process.env.PA_STORE_WAIT_MAX_MS = '0';
      assert.equal(readStoreWaitMaxMs(), 180000);
      process.env.PA_STORE_WAIT_MAX_MS = 'abc';
      assert.equal(readStoreWaitMaxMs(), 180000);
    } finally {
      if (original === undefined) delete process.env.PA_STORE_WAIT_MAX_MS;
      else process.env.PA_STORE_WAIT_MAX_MS = original;
    }
  });

  it('records are not appended once stall-records.jsonl reaches STALL_RECORDS_MAX_BYTES', { timeout: 15_000 }, async () => {
    await writeFile(stallRecordsPath(), 'x'.repeat(STALL_RECORDS_MAX_BYTES), 'utf8');
    void withBoundedQueue('k7', () => new Promise<void>(() => {}), { store: 'test-store', target: 'k7', maxWaitMs: 100 });
    const result = await withBoundedQueue('k7', async () => 'ok', { store: 'test-store', target: 'k7', maxWaitMs: 100 });
    assert.equal(result, 'ok');
    const { size } = await import('fs/promises').then((fs) => fs.stat(stallRecordsPath()));
    assert.equal(size, STALL_RECORDS_MAX_BYTES);
  });

  it('setStallHost labels records', { timeout: 15_000 }, async () => {
    setStallHost('catchup-loop');
    void withBoundedQueue('k8', () => new Promise<void>(() => {}), { store: 'test-store', target: 'k8', maxWaitMs: 100 });
    await withBoundedQueue('k8', async () => 'ok', { store: 'test-store', target: 'k8', maxWaitMs: 100 });
    const lines = (await readFile(stallRecordsPath(), 'utf8')).trim().split('\n');
    const record: StallRecord = JSON.parse(lines[0]);
    assert.equal(record.host, 'catchup-loop');
  });

  it('log() still lands its line when the app-log queue is wedged, and the stall names store app-log', { timeout: 15_000 }, async () => {
    const original = process.env.PA_STORE_WAIT_MAX_MS;
    process.env.PA_STORE_WAIT_MAX_MS = '100';
    try {
      void withBoundedQueue(APP_LOG_QUEUE_KEY, () => new Promise<void>(() => {}), { store: 'app-log', target: 'wedge', maxWaitMs: 100 });
      log('info', 'stall-test', 'after the wedge');
      await flushLog();
      const lines = (await readFile(`${tmpHome}/app.log.jsonl`, 'utf8')).trim().split('\n');
      const entries = lines.map((l) => JSON.parse(l));
      assert.ok(entries.some((e) => e.message === 'after the wedge'));
      const stallLines = (await readFile(stallRecordsPath(), 'utf8')).trim().split('\n');
      assert.equal(stallLines.length, 1);
      const record: StallRecord = JSON.parse(stallLines[0]);
      assert.equal(record.store, 'app-log');
    } finally {
      if (original === undefined) delete process.env.PA_STORE_WAIT_MAX_MS;
      else process.env.PA_STORE_WAIT_MAX_MS = original;
    }
  });

  it('updateJobState completes when the ledger queue is wedged, and the stall names store maintenance-state', { timeout: 15_000 }, async () => {
    const original = process.env.PA_STORE_WAIT_MAX_MS;
    void withBoundedQueue(maintenanceStateQueueKey(maintenanceStatePath()), () => new Promise<void>(() => {}), { store: 'maintenance-state', target: 'maintenance-state.json', maxWaitMs: 100 });
    process.env.PA_STORE_WAIT_MAX_MS = '100';
    try {
      await updateJobState('stall-probe', (p) => ({ ...p, lastSkipAt: '2026-09-16T00:00:00.000Z' } as typeof p));
      const ledger = await readLedger();
      assert.equal(ledger.jobs['stall-probe'].lastSkipAt, '2026-09-16T00:00:00.000Z');
      const lines = (await readFile(stallRecordsPath(), 'utf8')).trim().split('\n');
      assert.equal(lines.length, 1);
      const record: StallRecord = JSON.parse(lines[0]);
      assert.equal(record.store, 'maintenance-state');
      assert.equal(record.target, 'maintenance-state.json');
    } finally {
      if (original === undefined) delete process.env.PA_STORE_WAIT_MAX_MS;
      else process.env.PA_STORE_WAIT_MAX_MS = original;
    }
  });
});
