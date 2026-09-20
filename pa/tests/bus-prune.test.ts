import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import {
  sendBusMessage,
  listBusMessages,
  busQueuePath,
  _resetBusQueueForTest,
} from '../src/lib/bus-queue.js';
import { busPruneJob } from '../src/lib/maintenance/jobs/bus-prune.js';
import type { MaintenanceJobContext } from '../src/lib/maintenance/types.js';

let dir: string;

function ctx(now = Date.now()): MaintenanceJobContext {
  return { now, everyMs: 86_400_000 };
}

/** Append a raw envelope with a chosen ts directly to a queue file. */
async function seedEnvelope(address: string, tsIso: string, id = 'bus-old01') {
  const env = { id, from: 'cli@x', to: address, ts: tsIso, hops: 0, body: 'aged mail', hash: 'h' + id };
  await mkdir(dirname(busQueuePath(address)), { recursive: true });
  await writeFile(busQueuePath(address), JSON.stringify(env) + '\n', 'utf8');
  return env;
}

beforeEach(async () => {
  dir = await createTempPaHome();
  _resetBusQueueForTest();
});

afterEach(async () => {
  _resetBusQueueForTest();
  await cleanup(dir);
});

describe('bus-prune', () => {
  it('expires envelopes older than 24h and keeps fresh ones — per-envelope, file survives', async () => {
    // Old envelope seeded first — seedEnvelope writes the file, so a
    // sendBusMessage append must come after or it is overwritten.
    await seedEnvelope('devin:fresh', new Date(Date.now() - 26 * 60 * 60_000).toISOString());
    await sendBusMessage({ from: 'cli@x', to: 'devin:fresh', body: 'new mail' });

    const res = await busPruneJob.run(ctx());
    assert.equal(res.touched, 1, 'one expired envelope removed');
    const remaining = await listBusMessages('devin:fresh');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].body, 'new mail', 'the fresh envelope survives in place');
  });

  it('prunes phantom/unregistered queues nobody reads — the soft-read bound', async () => {
    // No registration, no cursor, nobody will ever read this — the whole
    // point of the job existing.
    await seedEnvelope('claude@repo#1462237725', new Date(Date.now() - 30 * 60 * 60_000).toISOString());

    const res = await busPruneJob.run(ctx());
    assert.equal(res.touched, 1);
    assert.deepEqual(await listBusMessages('claude@repo#1462237725'), []);
  });

  it('a corrupt queue file is skipped, not fatal', async () => {
    const p = busQueuePath('devin:corrupt');
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, '{not json\n', 'utf8');
    await seedEnvelope('devin:ok', new Date(Date.now() - 25 * 60 * 60_000).toISOString());

    const res = await busPruneJob.run(ctx());
    assert.equal(res.touched, 1, 'the valid queue still pruned');
    const { readFile } = await import('fs/promises');
    assert.equal(await readFile(p, 'utf8'), '{not json\n', 'the corrupt file was left byte-identical — skipped, not clobbered');
  });

  it('returns 0 when the queues dir is absent', async () => {
    const res = await busPruneJob.run(ctx());
    assert.equal(res.touched, 0);
  });

  it('reaps a registry row whose host pid is dead — the queue file survives untouched', async () => {
    // 2026-09-17: registry rows are TTL-free — a dead session's address
    // lingered forever and provider@repo sends kept fanning out to it.
    const { spawnSync } = await import('child_process');
    const { registerBusAddress, readBusRegistry } = await import('../src/lib/bus-queue.js');
    const { existsSync } = await import('fs');
    const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid!;
    const addr = 'opencode@repo#111111';
    await registerBusAddress(addr, { capabilities: ['hooks'], worker: 'opencode', pid: deadPid });
    await sendBusMessage({ from: 'cli@x', to: addr, body: 'mail for the dead' });

    const res = await busPruneJob.run(ctx());
    assert.equal(res.touched, 1, 'one dead registry row reaped (fresh envelope untouched)');
    const reg = await readBusRegistry();
    assert.equal(reg[addr], undefined, 'dead-pid row removed from registry.json');
    assert.ok(existsSync(busQueuePath(addr)), 'reaping the row does NOT drop the queue — envelopes still expire on the 24h bound');
  });

  it('keeps live rows: fresh cursor, pid-less, and silent-host entries all survive', async () => {
    const { spawn } = await import('child_process');
    const { registerBusAddress, touchBusCursor, readBusRegistry } = await import('../src/lib/bus-queue.js');
    const silent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      // Fresh cursor on its own address — the live session.
      await registerBusAddress('claude@repo#222222', { capabilities: ['hooks'], worker: 'claude', pid: process.pid });
      await touchBusCursor('claude@repo#222222', 'ev-live');
      // Pid-less row — agy-class / no host resolution: unprovable, kept.
      await registerBusAddress('agy@repo#333333', { capabilities: ['hooks'], worker: 'agy' });
      // Live pid, silent cursor, no OTHER live identity on that pid —
      // ambiguous (wedged or hookless session), kept.
      await registerBusAddress('devin@repo#444444', { capabilities: ['hooks'], worker: 'devin', pid: silent.pid });

      const res = await busPruneJob.run(ctx());
      assert.equal(res.touched, 0, 'no queue envelopes, no reapable rows');
      const reg = await readBusRegistry();
      for (const addr of ['claude@repo#222222', 'agy@repo#333333', 'devin@repo#444444']) {
        assert.ok(reg[addr], `${addr} kept`);
      }
    } finally {
      silent.kill();
    }
  });

  it('reaps a superseded row — live pid hosting a DIFFERENT live identity', async () => {
    // Same spawned-context rule as sweepDeadOwners: the pid outlives the
    // session generation that registered under it; the pid's CURRENT live
    // address proves the old row's generation is gone.
    const { spawnSync } = await import('child_process');
    const { registerBusAddress, touchBusCursor, readBusRegistry, busCursorPath } = await import('../src/lib/bus-queue.js');
    const { writeJsonAtomic } = await import('../src/lib/atomic-write.js');
    const livePid = process.pid;
    const oldGen = 'devin@repo#555555';
    const newGen = 'devin@repo#666666';
    await registerBusAddress(oldGen, { capabilities: ['hooks'], worker: 'devin', pid: livePid });
    await registerBusAddress(newGen, { capabilities: ['hooks'], worker: 'devin', pid: livePid });
    // oldGen's cursor is stale; newGen's is fresh — same pid, superseded.
    await writeJsonAtomic(busCursorPath(oldGen),
      { last_event: 'ev-old', last_event_at: new Date(Date.now() - 60 * 60_000).toISOString(), pid: livePid });
    await touchBusCursor(newGen, 'ev-new');

    const res = await busPruneJob.run(ctx());
    assert.equal(res.touched, 1);
    const reg = await readBusRegistry();
    assert.equal(reg[oldGen], undefined, 'superseded row reaped');
    assert.ok(reg[newGen], 'the live generation on the same pid is kept');

    // Control: a superseded-posture row on a DEAD pid with NO live successor
    // still reaps via the dead-pid arm (belt and suspenders — no false keep).
    const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid!;
    await registerBusAddress('devin@repo#777777', { capabilities: ['hooks'], worker: 'devin', pid: deadPid });
    const res2 = await busPruneJob.run(ctx());
    assert.equal(res2.touched, 1);
    assert.equal((await readBusRegistry())['devin@repo#777777'], undefined);
  });

  it('job declaration: pa host, daily, destructive with a queues target, sheddable', () => {
    assert.equal(busPruneJob.name, 'bus-prune');
    assert.equal(busPruneJob.host, 'pa');
    assert.equal(busPruneJob.everyMs, 86_400_000);
    assert.equal(busPruneJob.destructive, true);
    assert.equal(busPruneJob.shedWhenDegraded, true);
    assert.equal(busPruneJob.targets.length, 1, 'a destructive job must declare a RetentionTarget');
    assert.ok(busPruneJob.targets[0].match.test('claude@repo#1.jsonl'));
    assert.equal(busPruneJob.targets[0].match.test('registry.json'), false);
    assert.ok(busPruneJob.targets[0].note, 'per-envelope selection must be declared in the note');
  });
});
