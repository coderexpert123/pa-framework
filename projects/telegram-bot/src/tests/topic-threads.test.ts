import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  createThread,
  listThreads,
  getThread,
  queueThreadInput,
  takePendingInput,
  bumpRunSeq,
  updateThread,
  cancelRunningThreads,
  cancelOneThread,
  claimThreadStarts,
  listStoreKeys,
  activeThreadCount,
  countThreads,
  settleOrphanedThread,
  restartParkFields,
  _clearThreadsForTest,
  _setStoreDirForTest,
  MAX_RUNNING_THREADS_PER_TOPIC,
  MAX_THREADS_PER_TOPIC,
  type ThreadRecord,
} from '../topic-threads.js';
import { waitForDrain } from './test-teardown-guard.js';

let home: string;
const KEY = '-1001234567890_5001'; // synthetic fixture id family, never real chat/thread ids
const __dirname = dirname(fileURLToPath(import.meta.url)); // ESM: no native __dirname

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pa-topic-threads-'));
  // Temp PA_HOME is REQUIRED now: cancelRunningThreads emits topic events to
  // $PA_HOME/topic-events/, and this file only used to set the store dir —
  // without it those emissions would write the REAL ~/.pa/topic-events/.
  process.env.PA_HOME = join(home, 'pa-home');
  mkdirSync(join(home, 'pa-home'), { recursive: true });
  _setStoreDirForTest(home);
  _clearThreadsForTest();
});

afterEach(async () => {
  await waitForDrain();
  _setStoreDirForTest(undefined);
  _clearThreadsForTest();
  delete process.env.PA_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* temp dir best-effort */ }
});

/** Seed the store's own on-disk format directly — for bulk/age-sensitive fixtures. */
function seedFile(key: string, records: ThreadRecord[]): void {
  const obj = Object.fromEntries(records.map((r) => [r.id, r]));
  writeFileSync(join(home, `${key}.json`), JSON.stringify(obj, null, 2));
}

function minutesAgoIso(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

function mkRec(id: string, n: number, status: ThreadRecord['status'], ageMin = 10): ThreadRecord {
  return {
    id,
    n,
    title: `thread ${n}`,
    goal: `goal ${n}`,
    status,
    createdAt: minutesAgoIso(ageMin),
    updatedAt: minutesAgoIso(ageMin),
    workdir: 'C:/pa-checkout',
    runSeq: 1,
    attempts: 0,
    pendingInput: [],
  };
}

describe('createThread', () => {
  it('assigns monotonic per-topic ids and persists under the store dir', async () => {
    const first = await createThread(KEY, { title: 'Sweep logs', goal: 'Run the sweep script.', workdir: 'C:/pa-checkout' });
    const second = await createThread(KEY, { title: 'Fetch data', goal: 'Download the CSV.', workdir: 'C:/pa-checkout' });
    assert.ok(first.ok && second.ok);
    if (!first.ok || !second.ok) return;
    assert.equal(first.thread.id, 't-1');
    assert.equal(second.thread.id, 't-2');
    assert.equal(first.thread.status, 'running');
    assert.equal(first.thread.runSeq, 0);
    assert.equal(first.thread.attempts, 0);
    assert.deepEqual(first.thread.pendingInput, []);
    const raw = JSON.parse(readFileSync(join(home, `${KEY}.json`), 'utf8')) as Record<string, ThreadRecord>;
    assert.equal(Object.keys(raw).length, 2);
    assert.equal(raw['t-1'].title, 'Sweep logs');
    assert.equal(raw['t-2'].goal, 'Download the CSV.');
  });

  it('T-cap: parks the overflow create as queued instead of rejecting (increment 4)', async () => {
    for (let i = 0; i < MAX_RUNNING_THREADS_PER_TOPIC; i++) {
      const r = await createThread(KEY, { title: `T${i}`, goal: 'g', workdir: 'C:/pa-checkout' });
      assert.ok(r.ok, `create ${i} should succeed`);
      if (!r.ok) return;
      assert.equal(r.thread.status, 'running');
    }
    assert.equal(await activeThreadCount(KEY), MAX_RUNNING_THREADS_PER_TOPIC);
    const eleventh = await createThread(KEY, { title: 'Overflow', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(eleventh.ok); // "no rejections, ever" — the cap parks, it does not reject
    if (!eleventh.ok) return;
    assert.equal(eleventh.thread.id, `t-${MAX_RUNNING_THREADS_PER_TOPIC + 1}`);
    assert.equal(eleventh.thread.status, 'queued');
    assert.equal(await activeThreadCount(KEY), MAX_RUNNING_THREADS_PER_TOPIC); // queued never counts as running
  });

  it('prunes the oldest terminal record past 20 and never prunes a running one', async () => {
    const seeded: ThreadRecord[] = [mkRec('t-1', 1, 'running', 60)];
    for (let n = 2; n <= 20; n++) seeded.push(mkRec(`t-${n}`, n, 'done', 60 - n));
    seedFile(KEY, seeded);
    const next = await createThread(KEY, { title: 'One more', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(next.ok);
    if (!next.ok) return;
    assert.equal(next.thread.id, 't-21'); // max(n)+1 over surviving records
    const raw = JSON.parse(readFileSync(join(home, `${KEY}.json`), 'utf8')) as Record<string, ThreadRecord>;
    assert.equal(Object.keys(raw).length, 20);
    assert.ok(!raw['t-2']); // oldest terminal (lowest n among done) dropped
    assert.equal(raw['t-1'].status, 'running'); // running is never pruned, even though oldest
  });

  it('T-prune: queued and running records are never pruned; the store may exceed 20 with no terminal victim', async () => {
    // 10 running + 5 queued + 6 terminal: the create prunes only the two
    // lowest-n terminal records to get back to 20.
    const seeded: ThreadRecord[] = [];
    for (let n = 1; n <= 10; n++) seeded.push(mkRec(`t-${n}`, n, 'running', 60));
    for (let n = 11; n <= 15; n++) seeded.push(mkRec(`t-${n}`, n, 'queued', 60));
    for (let n = 16; n <= 21; n++) seeded.push(mkRec(`t-${n}`, n, 'done', 60 - n));
    seedFile(KEY, seeded);
    const next = await createThread(KEY, { title: 'One more', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(next.ok);
    if (!next.ok) return;
    assert.equal(next.thread.status, 'queued'); // cap full — parks
    const raw = JSON.parse(readFileSync(join(home, `${KEY}.json`), 'utf8')) as Record<string, ThreadRecord>;
    assert.equal(Object.keys(raw).length, 20);
    for (let n = 1; n <= 10; n++) assert.equal(raw[`t-${n}`]?.status, 'running'); // never pruned
    for (let n = 11; n <= 15; n++) assert.equal(raw[`t-${n}`]?.status, 'queued'); // never pruned
    assert.ok(!raw['t-16'] && !raw['t-17']); // the only pruned records are terminal
    assert.ok(raw['t-18'] && raw['t-21'] && raw['t-22']);

    // No terminal victim anywhere: the store is allowed to exceed 20 rather
    // than delete waiting work.
    const allLive: ThreadRecord[] = [];
    for (let n = 1; n <= 10; n++) allLive.push(mkRec(`t-${n}`, n, 'running', 60));
    for (let n = 11; n <= 21; n++) allLive.push(mkRec(`t-${n}`, n, 'queued', 60));
    seedFile(KEY, allLive);
    const parked = await createThread(KEY, { title: 'Parked', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(parked.ok); // no throw
    if (!parked.ok) return;
    assert.equal(parked.thread.status, 'queued');
    const raw2 = JSON.parse(readFileSync(join(home, `${KEY}.json`), 'utf8')) as Record<string, ThreadRecord>;
    assert.equal(Object.keys(raw2).length, 22); // 21 live + 1 parked, oversize by design
    for (let n = 11; n <= 21; n++) assert.equal(raw2[`t-${n}`]?.status, 'queued'); // queued survived
  });
});

// Ask-mirroring stamp (button parity, 2026-09-11): createThread persists a
// sanitized voiceTaskIds array; invalid entries fail open (dropped + logged),
// never a spawn rejection.
describe('voiceTaskIds (ask-mirroring stamp)', () => {
  it('persists valid ids onto the record and into the store file', async () => {
    const r = await createThread(KEY, {
      title: 'T', goal: 'g', workdir: 'C:/pa-checkout',
      voiceTaskIds: ['vi-1234567890ab', 'vi-abcdefabcdef'],
    });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.thread.voiceTaskIds, ['vi-1234567890ab', 'vi-abcdefabcdef']);
    const raw = JSON.parse(readFileSync(join(home, `${KEY}.json`), 'utf8')) as Record<string, ThreadRecord>;
    assert.deepEqual(raw['t-1'].voiceTaskIds, ['vi-1234567890ab', 'vi-abcdefabcdef']);
  });

  it('omits the field entirely when no ids are passed (old stores and spawns stay clean)', async () => {
    const r = await createThread(KEY, { title: 'T', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.thread.voiceTaskIds, undefined);
  });

  it('drops malformed ids and duplicates silently (fail-open), keeping only valid ones', async () => {
    const r = await createThread(KEY, {
      title: 'T', goal: 'g', workdir: 'C:/pa-checkout',
      voiceTaskIds: [
        'vi-1234567890ab',   // valid
        'vi-ZZZZZZZZZZZZ',   // bad hex
        'vi-123',            // wrong length
        'task-1234567890ab', // wrong prefix
        'vi-1234567890ab',   // duplicate of the valid one
        42 as unknown as string, // wrong type
      ],
    });
    assert.ok(r.ok, 'a malformed stamp never rejects the spawn');
    if (!r.ok) return;
    assert.deepEqual(r.thread.voiceTaskIds, ['vi-1234567890ab']);
  });

  it('caps the stamp at 5 ids', async () => {
    const six: string[] = [];
    for (let i = 0; i < 6; i++) six.push(`vi-${i.toString(16).padStart(12, '0')}`);
    const r = await createThread(KEY, { title: 'T', goal: 'g', workdir: 'C:/pa-checkout', voiceTaskIds: six });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.thread.voiceTaskIds?.length, 5);
  });

  it('an all-invalid stamp persists no voiceTaskIds field at all', async () => {
    const r = await createThread(KEY, { title: 'T', goal: 'g', workdir: 'C:/pa-checkout', voiceTaskIds: ['nope', 'vi-xyz'] });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.thread.voiceTaskIds, undefined);
    const raw = JSON.parse(readFileSync(join(home, `${KEY}.json`), 'utf8')) as Record<string, ThreadRecord>;
    assert.ok(!('voiceTaskIds' in raw['t-1']));
  });
});

describe('claimThreadStarts (increment 4 FIFO claim)', () => {
  it('T-claim-1: a full cap claims nothing — queued records stay queued', async () => {
    for (let i = 0; i < MAX_RUNNING_THREADS_PER_TOPIC + 2; i++) {
      const r = await createThread(KEY, { title: `T${i}`, goal: 'g', workdir: 'C:/pa-checkout' });
      assert.ok(r.ok);
      if (!r.ok) return;
    }
    assert.deepEqual(await claimThreadStarts(KEY), []);
    assert.equal((await getThread(KEY, 't-11'))?.status, 'queued');
    assert.equal((await getThread(KEY, 't-12'))?.status, 'queued');
  });

  it('T-claim-2: freed slots claim exactly the queued records, lowest-n first, with fresh updatedAt', async () => {
    for (let i = 0; i < MAX_RUNNING_THREADS_PER_TOPIC + 2; i++) {
      await createThread(KEY, { title: `T${i}`, goal: 'g', workdir: 'C:/pa-checkout' });
    }
    // Free 3 slots (t-1..t-3 done); 2 queued ≤ 3 free — both start.
    await updateThread(KEY, 't-1', { status: 'done' });
    await updateThread(KEY, 't-2', { status: 'done' });
    await updateThread(KEY, 't-3', { status: 'done' });
    const before = await getThread(KEY, 't-11');
    const claimed = await claimThreadStarts(KEY);
    assert.deepEqual(claimed.map((r) => r.id), ['t-11', 't-12']); // lowest-n first
    assert.ok(claimed.every((r) => r.status === 'running'));
    assert.ok(before && claimed.every((r) => new Date(r.updatedAt).getTime() >= new Date(before.updatedAt).getTime()));
    // The flip is persisted, not just returned.
    assert.equal((await getThread(KEY, 't-11'))?.status, 'running');
    assert.equal((await getThread(KEY, 't-12'))?.status, 'running');
    assert.equal(await activeThreadCount(KEY), MAX_RUNNING_THREADS_PER_TOPIC - 3 + 2);
  });

  it('T-claim-3: one free slot claims exactly the lowest-n queued record', async () => {
    for (let i = 0; i < MAX_RUNNING_THREADS_PER_TOPIC + 3; i++) {
      await createThread(KEY, { title: `T${i}`, goal: 'g', workdir: 'C:/pa-checkout' });
    }
    await updateThread(KEY, 't-1', { status: 'done' }); // exactly one free slot
    const claimed = await claimThreadStarts(KEY);
    assert.deepEqual(claimed.map((r) => r.id), ['t-11']);
    assert.equal((await getThread(KEY, 't-12'))?.status, 'queued');
    assert.equal((await getThread(KEY, 't-13'))?.status, 'queued');
  });

  it('T-claim-4: done/failed records with pendingInput are not claimable — only explicit queued status is', async () => {
    await createThread(KEY, { title: 'Done', goal: 'g', workdir: 'C:/pa-checkout' });
    await createThread(KEY, { title: 'Failed', goal: 'g', workdir: 'C:/pa-checkout' });
    await createThread(KEY, { title: 'Parked', goal: 'g', workdir: 'C:/pa-checkout' });
    await updateThread(KEY, 't-1', { status: 'done' });
    await updateThread(KEY, 't-2', { status: 'failed' });
    await queueThreadInput(KEY, 't-1', 'wake me?');
    await queueThreadInput(KEY, 't-2', 'wake me too?');
    await updateThread(KEY, 't-3', { status: 'queued' }); // park-before-claim (handleSteer's contract)
    const claimed = await claimThreadStarts(KEY);
    assert.deepEqual(claimed.map((r) => r.id), ['t-3']);
    assert.equal((await getThread(KEY, 't-1'))?.status, 'done');
    assert.equal((await getThread(KEY, 't-2'))?.status, 'failed');
    assert.equal((await getThread(KEY, 't-1'))?.pendingInput.length, 1); // pendingInput alone never makes a record startable
  });
});

describe('queueThreadInput', () => {
  it('appends up to 5 and rejects the 6th', async () => {
    await createThread(KEY, { title: 'T', goal: 'g', workdir: 'C:/pa-checkout' });
    for (let i = 1; i <= 5; i++) {
      const r = await queueThreadInput(KEY, 't-1', `msg ${i}`);
      assert.ok(r.ok, `queue ${i} should succeed`);
    }
    const rec = await getThread(KEY, 't-1');
    assert.equal(rec?.pendingInput.length, 5);
    assert.equal(rec?.pendingInput[0], 'msg 1');
    const sixth = await queueThreadInput(KEY, 't-1', 'one too many');
    assert.ok(!sixth.ok);
    if (sixth.ok) return;
    assert.ok(sixth.reason.includes('5'));
  });

  it('rejects an unknown thread id', async () => {
    const r = await queueThreadInput(KEY, 't-99', 'hello');
    assert.ok(!r.ok);
  });

  it('does not flip a terminal thread back to running (executor owns status)', async () => {
    await createThread(KEY, { title: 'T', goal: 'g', workdir: 'C:/pa-checkout' });
    await updateThread(KEY, 't-1', { status: 'done' });
    const r = await queueThreadInput(KEY, 't-1', 'continue please');
    assert.ok(r.ok);
    const rec = await getThread(KEY, 't-1');
    assert.equal(rec?.status, 'done');
    assert.equal(rec?.pendingInput.length, 1);
  });
});

describe('updateThread / bumpRunSeq', () => {
  it('merges the patch and stamps updatedAt', async () => {
    await createThread(KEY, { title: 'T', goal: 'g', workdir: 'C:/pa-checkout' });
    const before = await getThread(KEY, 't-1');
    await updateThread(KEY, 't-1', { status: 'done', lastResult: 'counts: 42', attempts: 1 });
    const after = await getThread(KEY, 't-1');
    assert.equal(after?.status, 'done');
    assert.equal(after?.lastResult, 'counts: 42');
    assert.equal(after?.attempts, 1);
    assert.equal(after?.title, 'T'); // untouched fields survive the shallow merge
    assert.ok(new Date(after!.updatedAt).getTime() >= new Date(before!.updatedAt).getTime());
  });

  it('bumpRunSeq increments, stamps, and returns the new value', async () => {
    await createThread(KEY, { title: 'T', goal: 'g', workdir: 'C:/pa-checkout' });
    const first = await bumpRunSeq(KEY, 't-1');
    const second = await bumpRunSeq(KEY, 't-1');
    assert.equal(first, 1);
    assert.equal(second, 2);
    const rec = await getThread(KEY, 't-1');
    assert.equal(rec?.runSeq, 2);
  });

  it('is a no-op for an unknown thread id', async () => {
    assert.equal(await bumpRunSeq(KEY, 't-99'), undefined);
    await updateThread(KEY, 't-99', { status: 'done' }); // must not throw
  });
});

describe('lazy stale demotion requeues on restart (WP-G, 2026-09-13)', () => {
  it('requeues a running record stale past 30m with a restart-parked error and a ~5-minute park stamp', async () => {
    const before = Date.now();
    seedFile(KEY, [mkRec('t-1', 1, 'running', 31)]);
    const threads = await listThreads(KEY);
    assert.equal(threads.length, 1);
    assert.equal(threads[0].status, 'queued');
    assert.ok(threads[0].lastError?.includes('restart-parked'));
    assert.ok(threads[0].lastError?.includes('auto-requeued'));
    // One gentle cycle: the park stamp lands ~5 minutes in the future (the
    // window also rules out the wall-park ladder's 15/30/60-minute values).
    const parked = Date.parse(threads[0].parkedUntil!);
    assert.ok(parked >= before + 4 * 60_000 && parked <= Date.now() + 6 * 60_000,
      `parkedUntil ${threads[0].parkedUntil} should be ~5m future`);
    // updatedAt bumped — the requeued record is not itself stale on the next read.
    assert.ok(Date.parse(threads[0].updatedAt) >= before);
    // The requeue persists, so the running cap still frees up for the next spawn.
    const raw = JSON.parse(readFileSync(join(home, `${KEY}.json`), 'utf8')) as Record<string, ThreadRecord>;
    assert.equal(raw['t-1'].status, 'queued');
    assert.ok(raw['t-1'].parkedUntil);
    const fresh = await createThread(KEY, { title: 'After wedge', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(fresh.ok);
  });

  it('leaves fresh running records alone', async () => {
    seedFile(KEY, [mkRec('t-1', 1, 'running', 5)]);
    const threads = await listThreads(KEY);
    assert.equal(threads[0].status, 'running');
  });

  it('the demote pass itself does not re-claim — the fresh park stamp blocks the same claimThreadStarts pass', async () => {
    seedFile(KEY, [mkRec('t-1', 1, 'running', 31)]);
    const claimed = await claimThreadStarts(KEY);
    assert.deepEqual(claimed, []); // demoted to queued, but parkedUntil is future this pass
    const rec = await getThread(KEY, 't-1');
    assert.equal(rec?.status, 'queued');
    assert.ok(rec?.parkedUntil);
  });

  it('a later claim pass after the park stamp passes re-claims the requeued thread', async () => {
    seedFile(KEY, [mkRec('t-1', 1, 'running', 31)]);
    assert.deepEqual(await claimThreadStarts(KEY), []); // demoted + parked this pass
    assert.equal((await getThread(KEY, 't-1'))?.status, 'queued');
    // Backdate the stamp (the 5-minute grace elapsing) — the next pass claims.
    await updateThread(KEY, 't-1', { parkedUntil: new Date(Date.now() - 60_000).toISOString() });
    const claimed = await claimThreadStarts(KEY);
    assert.deepEqual(claimed.map((r) => r.id), ['t-1']);
    assert.equal((await getThread(KEY, 't-1'))?.status, 'running');
  });

  it('T-demote: stale queued and cancelled records are NOT touched by demotion — no executor, no pump; revival is the drain\'s job (increment 4)', async () => {
    const stopErr = 'operator stopped it';
    const stamp = new Date(Date.now() + 60 * 60_000).toISOString();
    seedFile(KEY, [
      mkRec('t-1', 1, 'queued', 31),
      { ...mkRec('t-2', 2, 'cancelled', 31), lastError: stopErr, parkedUntil: stamp },
      mkRec('t-3', 3, 'running', 31),
    ]);
    const threads = await listThreads(KEY);
    const queued = threads.find((t) => t.id === 't-1');
    const cancelled = threads.find((t) => t.id === 't-2');
    const requeued = threads.find((t) => t.id === 't-3');
    assert.equal(queued?.status, 'queued'); // healthy waiting work stays queued
    assert.ok(!queued?.lastError);
    assert.ok(!queued?.parkedUntil);
    assert.equal(cancelled?.status, 'cancelled'); // terminal stays terminal
    assert.equal(cancelled?.lastError, stopErr); // demotion wrote nothing to it
    assert.equal(cancelled?.parkedUntil, stamp);
    assert.equal(requeued?.status, 'queued'); // the running one still requeues
    const raw = JSON.parse(readFileSync(join(home, `${KEY}.json`), 'utf8')) as Record<string, ThreadRecord>;
    assert.equal(raw['t-1'].status, 'queued');
    assert.equal(raw['t-2'].status, 'cancelled');
    assert.equal(raw['t-3'].status, 'queued');
  });
});

describe('cancelRunningThreads', () => {
  it('flips exactly the running ones and returns the count', async () => {
    seedFile(KEY, [mkRec('t-1', 1, 'running'), mkRec('t-2', 2, 'running'), mkRec('t-3', 3, 'done')]);
    const count = await cancelRunningThreads(KEY);
    assert.equal(count, 2);
    const raw = JSON.parse(readFileSync(join(home, `${KEY}.json`), 'utf8')) as Record<string, ThreadRecord>;
    assert.equal(raw['t-1'].status, 'cancelled');
    assert.equal(raw['t-2'].status, 'cancelled');
    assert.equal(raw['t-3'].status, 'done');
    assert.equal(await activeThreadCount(KEY), 0);
    assert.equal(await cancelRunningThreads(KEY), 0); // second pass: nothing left running
  });

  it('T-cancel: queued records flip too but emit no topic event (increment 4)', async () => {
    await createThread(KEY, { title: 'A', goal: 'g', workdir: 'C:/pa-checkout' });
    await createThread(KEY, { title: 'B', goal: 'g', workdir: 'C:/pa-checkout' });
    await createThread(KEY, { title: 'Parked', goal: 'g', workdir: 'C:/pa-checkout' });
    await updateThread(KEY, 't-3', { status: 'queued' });
    const count = await cancelRunningThreads(KEY);
    assert.equal(count, 3);
    const raw = JSON.parse(readFileSync(join(home, `${KEY}.json`), 'utf8')) as Record<string, ThreadRecord>;
    assert.equal(raw['t-1'].status, 'cancelled');
    assert.equal(raw['t-2'].status, 'cancelled');
    assert.equal(raw['t-3'].status, 'cancelled');
    // Exactly the two records that were RUNNING emitted; the queued record
    // never started, so no event for it.
    const events = readFileSync(join(process.env.PA_HOME!, 'topic-events', `${KEY}.jsonl`), 'utf8');
    const lines = events.trim().split('\n').map((l) => JSON.parse(l) as { kind: string });
    assert.equal(lines.length, 2);
    assert.ok(lines.every((e) => e.kind === 'thread_cancelled'));
    assert.equal(await cancelRunningThreads(KEY), 0); // second pass: nothing left running or queued
  });
});

describe('cancelOneThread (per-task cancel path, AI-214 backend redesign)', () => {
  it('flips only the named record while a sibling running record stays running (blast-radius pin)', async () => {
    seedFile(KEY, [mkRec('t-1', 1, 'running'), mkRec('t-2', 2, 'running')]);
    assert.equal(await cancelOneThread(KEY, 't-1'), true);
    const raw = JSON.parse(readFileSync(join(home, `${KEY}.json`), 'utf8')) as Record<string, ThreadRecord>;
    assert.equal(raw['t-1'].status, 'cancelled');
    assert.equal(raw['t-2'].status, 'running', 'the sibling must never be touched by a per-task cancel');
  });

  it('returns false for an unknown thread id and writes nothing', async () => {
    seedFile(KEY, [mkRec('t-1', 1, 'running')]);
    assert.equal(await cancelOneThread(KEY, 't-99'), false);
    const raw = JSON.parse(readFileSync(join(home, `${KEY}.json`), 'utf8')) as Record<string, ThreadRecord>;
    assert.equal(raw['t-1'].status, 'running');
  });

  it('returns false for an already-terminal (done) record and does not flip it', async () => {
    seedFile(KEY, [mkRec('t-1', 1, 'done')]);
    assert.equal(await cancelOneThread(KEY, 't-1'), false);
    const raw = JSON.parse(readFileSync(join(home, `${KEY}.json`), 'utf8')) as Record<string, ThreadRecord>;
    assert.equal(raw['t-1'].status, 'done');
  });

  it('emits thread_cancelled for a running record that was flipped', async () => {
    seedFile(KEY, [mkRec('t-1', 1, 'running')]);
    assert.equal(await cancelOneThread(KEY, 't-1'), true);
    const events = readFileSync(join(process.env.PA_HOME!, 'topic-events', `${KEY}.jsonl`), 'utf8');
    const lines = events.trim().split('\n').map((l) => JSON.parse(l) as { kind: string; ref: string; detail: string });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, 'thread_cancelled');
    assert.equal(lines[0].ref, 't-1');
    assert.equal(lines[0].detail, 'thread 1');
  });

  it('flips a queued record but emits no topic event for it', async () => {
    seedFile(KEY, [mkRec('t-1', 1, 'queued')]);
    assert.equal(await cancelOneThread(KEY, 't-1'), true);
    const raw = JSON.parse(readFileSync(join(home, `${KEY}.json`), 'utf8')) as Record<string, ThreadRecord>;
    assert.equal(raw['t-1'].status, 'cancelled');
    assert.equal(existsSync(join(process.env.PA_HOME!, 'topic-events', `${KEY}.jsonl`)), false, 'a queued record never started, so no event fires');
  });
});

describe('concurrent writes (mutex proof)', () => {
  it('persists 100 concurrent updateThread calls without loss or tearing', async () => {
    await createThread(KEY, { title: 'T', goal: 'g', workdir: 'C:/pa-checkout' });
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => updateThread(KEY, 't-1', { lastResult: `r${i}` })),
    );
    const raw = JSON.parse(readFileSync(join(home, `${KEY}.json`), 'utf8')) as Record<string, ThreadRecord>;
    assert.equal(Object.keys(raw).length, 1);
    assert.match(raw['t-1'].lastResult ?? '', /^r\d+$/); // one of the 100 — file intact, not torn
    assert.equal(raw['t-1'].title, 'T'); // every other field survived every merge
  });

  it('never loses a bump under 100 concurrent bumpRunSeq calls', async () => {
    await createThread(KEY, { title: 'T', goal: 'g', workdir: 'C:/pa-checkout' });
    const results = await Promise.all(
      Array.from({ length: 100 }, () => bumpRunSeq(KEY, 't-1')),
    );
    const sorted = results.filter((r): r is number => r !== undefined).sort((a, b) => a - b);
    assert.deepEqual(sorted, Array.from({ length: 100 }, (_, i) => i + 1)); // 1..100, no duplicates
    const rec = await getThread(KEY, 't-1');
    assert.equal(rec?.runSeq, 100);
  });
});

describe('corrupt store file', () => {
  it('fails to empty with no throw, and recovers on the next write', async () => {
    writeFileSync(join(home, `${KEY}.json`), '{ this is not json');
    assert.deepEqual(await listThreads(KEY), []);
    assert.equal(await getThread(KEY, 't-1'), undefined);
    assert.equal(await activeThreadCount(KEY), 0);
    const fresh = await createThread(KEY, { title: 'Recovery', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(fresh.ok);
    if (!fresh.ok) return;
    assert.equal(fresh.thread.id, 't-1'); // corrupt content is unknowable; ids restart
  });
});

// Increment-2 (2026-09-06): atomic takePendingInput + per-flip cancel emission.
describe('takePendingInput (atomic take)', () => {
  it('T-B1a: returns and clears the queued inputs; a second take is empty', async () => {
    const created = await createThread(KEY, { title: 'T', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(created.ok);
    await queueThreadInput(KEY, 't-1', 'first');
    await queueThreadInput(KEY, 't-1', 'second');
    assert.deepEqual(await takePendingInput(KEY, 't-1'), ['first', 'second']);
    assert.deepEqual((await getThread(KEY, 't-1'))?.pendingInput, []);
    assert.deepEqual(await takePendingInput(KEY, 't-1'), []);
  });

  it('T-B1b: two concurrent takers partition the inputs — nothing lost, nothing duplicated', async () => {
    const created = await createThread(KEY, { title: 'T', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(created.ok);
    await queueThreadInput(KEY, 't-1', 'alpha');
    await queueThreadInput(KEY, 't-1', 'beta');
    const [a, b] = await Promise.all([takePendingInput(KEY, 't-1'), takePendingInput(KEY, 't-1')]);
    assert.deepEqual([...a, ...b].sort(), ['alpha', 'beta'].sort());
    assert.deepEqual((await getThread(KEY, 't-1'))?.pendingInput, []);
  });

  it('T-B1c: a take racing a queue serializes under the key lock — no lost update', async () => {
    const created = await createThread(KEY, { title: 'T', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(created.ok);
    await queueThreadInput(KEY, 't-1', 'one');
    await queueThreadInput(KEY, 't-1', 'two');
    const [taken] = await Promise.all([
      takePendingInput(KEY, 't-1'),
      queueThreadInput(KEY, 't-1', 'third'),
    ]);
    const rec = await getThread(KEY, 't-1');
    assert.deepEqual([...taken, ...(rec?.pendingInput ?? [])].sort(), ['one', 'third', 'two'].sort());
  });

  it('T-B1d: unknown thread id takes [] with no throw', async () => {
    assert.deepEqual(await takePendingInput(KEY, 't-99'), []);
  });

  it('T-B1e: cancelRunningThreads emits one topic event per flipped thread to the real jsonl', async () => {
    const one = await createThread(KEY, { title: 'Sweep logs', goal: 'g', workdir: 'C:/pa-checkout' });
    const two = await createThread(KEY, { title: 'Research', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(one.ok && two.ok);
    const k = await cancelRunningThreads(KEY);
    assert.equal(k, 2);
    const raw = readFileSync(join(process.env.PA_HOME!, 'topic-events', `${KEY}.jsonl`), 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as { kind: string; ref: string | null; detail: string });
    assert.equal(lines.length, 2);
    assert.ok(lines.every((e) => e.kind === 'thread_cancelled'));
    assert.deepEqual(lines.map((e) => e.ref), ['t-1', 't-2']);
    assert.deepEqual(lines.map((e) => e.detail), ['Sweep logs', 'Research']);
  });

  it('T-B1f: no running threads ⇒ cancel returns 0 and writes no topic-events file', async () => {
    const k = await cancelRunningThreads(KEY);
    assert.equal(k, 0);
    assert.equal(existsSync(join(process.env.PA_HOME!, 'topic-events', `${KEY}.jsonl`)), false);
  });
});

describe('countThreads (AI-203 increment 3)', () => {
  it('T-S1: tallies one topic by status across createThread + updateThread', async () => {
    // Each thread is moved to its terminal status before the next one is
    // created so the running tally ends at exactly one; the two queued
    // records are parked explicitly via updateThread (createThread only
    // parks past the cap — increment 4).
    const r1 = await createThread(KEY, { title: 'Running', goal: 'g', workdir: 'C:/pa-checkout' });
    const d1 = await createThread(KEY, { title: 'Done 1', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(r1.ok && d1.ok);
    await updateThread(KEY, d1.thread.id, { status: 'done' });
    const d2 = await createThread(KEY, { title: 'Done 2', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(d2.ok);
    await updateThread(KEY, d2.thread.id, { status: 'done' });
    const f1 = await createThread(KEY, { title: 'Failed', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(f1.ok);
    await updateThread(KEY, f1.thread.id, { status: 'failed' });
    const c1 = await createThread(KEY, { title: 'Cancelled', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(c1.ok);
    await updateThread(KEY, c1.thread.id, { status: 'cancelled' });
    const q1 = await createThread(KEY, { title: 'Queued 1', goal: 'g', workdir: 'C:/pa-checkout' });
    const q2 = await createThread(KEY, { title: 'Queued 2', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(q1.ok && q2.ok);
    await updateThread(KEY, q1.thread.id, { status: 'queued' });
    await updateThread(KEY, q2.thread.id, { status: 'queued' });
    assert.deepEqual(await countThreads(KEY), { running: 1, queued: 2, done: 2, failed: 1, cancelled: 1 });
  });

  it('T-S2: unknown key tallies an all-zero five-field shape without throwing, and the read requeues a 31-min-stale running record', async () => {
    assert.deepEqual(await countThreads('unknown_0'), { running: 0, queued: 0, done: 0, failed: 0, cancelled: 0 });
    seedFile(KEY, [mkRec('t-1', 1, 'running', 31)]);
    const counts = await countThreads(KEY);
    assert.deepEqual(counts, { running: 0, queued: 1, done: 0, failed: 0, cancelled: 0 });
    const rec = await getThread(KEY, 't-1');
    assert.equal(rec?.status, 'queued');
  });
});

describe('listStoreKeys (increment 4)', () => {
  it('T-keys: returns seeded keys sans .json; absent dir ⇒ [] with no throw', async () => {
    await createThread(KEY, { title: 'T', goal: 'g', workdir: 'C:/pa-checkout' });
    await createThread('999_42', { title: 'Other', goal: 'g', workdir: 'C:/pa-checkout' }); // synthetic fixture id family
    assert.deepEqual((await listStoreKeys()).sort(), ['999_42', '-1001234567890_5001'].sort());
    // Absent store dir: ENOENT is swallowed to [] — never a throw.
    _setStoreDirForTest(join(home, 'no-such-dir'));
    assert.deepEqual(await listStoreKeys(), []);
    // A non-dir store path also fails safe ([]).
    writeFileSync(join(home, 'not-a-dir'), 'x');
    _setStoreDirForTest(join(home, 'not-a-dir'));
    assert.deepEqual(await listStoreKeys(), []);
  });
});

// Wall-park claim gate (2026-09-12): claimThreadStarts skips a queued record
// whose parkedUntil stamp is in the future; absent/past/unparseable stamps are
// claimable, and the stamp is inert on non-queued records (its only reader is
// the queued-claim filter).
describe('wall-park claim gate (2026-09-12)', () => {
  it('T-PARK-B1: a future stamp blocks the claim — the record stays queued', async () => {
    seedFile(KEY, [{ ...mkRec('t-9', 9, 'queued'), parkedUntil: new Date(Date.now() + 60 * 60_000).toISOString(), unavailableParks: 3 }]);
    assert.deepEqual(await claimThreadStarts(KEY), []);
    assert.equal((await getThread(KEY, 't-9'))?.status, 'queued');
  });

  it('T-PARK-B2: a past stamp claims — the record flips to running', async () => {
    seedFile(KEY, [{ ...mkRec('t-9', 9, 'queued'), parkedUntil: new Date(Date.now() - 60_000).toISOString() }]);
    const claimed = await claimThreadStarts(KEY);
    assert.deepEqual(claimed.map((r) => r.id), ['t-9']);
    assert.equal((await getThread(KEY, 't-9'))?.status, 'running');
  });

  it('T-PARK-B3: an absent stamp claims (back-compat with old stores)', async () => {
    seedFile(KEY, [mkRec('t-9', 9, 'queued')]);
    assert.deepEqual((await claimThreadStarts(KEY)).map((r) => r.id), ['t-9']);
  });

  it('T-PARK-B4: an unparseable stamp fails open — claimed (NaN is never > nowMs)', async () => {
    seedFile(KEY, [{ ...mkRec('t-9', 9, 'queued'), parkedUntil: 'not-a-timestamp' }]);
    assert.deepEqual((await claimThreadStarts(KEY)).map((r) => r.id), ['t-9']);
  });

  it('T-PARK-B5: round-trips via updateThread, and a seeded record carrying the fields loads them verbatim', async () => {
    const created = await createThread(KEY, { title: 'T', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(created.ok);
    if (!created.ok) return;
    const iso = new Date(Date.now() + 5 * 60_000).toISOString();
    await updateThread(KEY, created.thread.id, { parkedUntil: iso, unavailableParks: 7 });
    const rec = await getThread(KEY, created.thread.id);
    assert.equal(rec?.parkedUntil, iso);
    assert.equal(rec?.unavailableParks, 7);
    seedFile(KEY, [{ ...mkRec('t-9', 9, 'queued'), parkedUntil: iso, unavailableParks: 3 }]);
    const seeded = await getThread(KEY, 't-9');
    assert.equal(seeded?.parkedUntil, iso);
    assert.equal(seeded?.unavailableParks, 3);
  });

  it('T-PARK-B6: a stale stamp is inert on non-queued records — done keeps its future stamp untouched', async () => {
    const futureStamp = new Date(Date.now() + 60 * 60_000).toISOString();
    seedFile(KEY, [
      { ...mkRec('t-1', 1, 'done'), parkedUntil: futureStamp },
      mkRec('t-2', 2, 'queued'),
    ]);
    const claimed = await claimThreadStarts(KEY);
    assert.deepEqual(claimed.map((r) => r.id), ['t-2']);
    const done = await getThread(KEY, 't-1');
    assert.equal(done?.status, 'done');
    assert.equal(done?.parkedUntil, futureStamp); // stamp untouched — code never clears it
  });
});

describe('per-topic thread caps env-tunable (machine-profile scaling)', () => {
  // The caps are parsed ONCE at module load, so overrides are proven in a fresh
  // child process against the same compiled module the bot process loads.
  const modulePath = join(__dirname, '..', 'topic-threads.js');
  const probe =
    `const m = await import(${JSON.stringify(pathToFileURL(modulePath).href)});` +
    `console.log(JSON.stringify([m.MAX_RUNNING_THREADS_PER_TOPIC, m.MAX_THREADS_PER_TOPIC]));` +
    `process.exit(0);`;
  const probeCaps = (extra: Record<string, string>) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ...extra },
    });

  it('pins defaults 10/20 when neither override is set', () => {
    const res = probeCaps({ PA_MAX_RUNNING_THREADS_PER_TOPIC: '', PA_MAX_THREADS_PER_TOPIC: '' });
    assert.equal(res.status, 0, `child failed: ${res.stderr}`);
    assert.deepEqual(JSON.parse(res.stdout.trim()), [10, 20]);
    // The in-process module exports the same constants by name for every
    // existing consumer (tests below loop against the imported symbols).
    assert.equal(MAX_RUNNING_THREADS_PER_TOPIC, 10);
    assert.equal(MAX_THREADS_PER_TOPIC, 20);
  });

  it('honors PA_MAX_RUNNING_THREADS_PER_TOPIC / PA_MAX_THREADS_PER_TOPIC overrides', () => {
    const res = probeCaps({ PA_MAX_RUNNING_THREADS_PER_TOPIC: '7', PA_MAX_THREADS_PER_TOPIC: '33' });
    assert.equal(res.status, 0, `child failed: ${res.stderr}`);
    assert.deepEqual(JSON.parse(res.stdout.trim()), [7, 33]);
  });

  it('falls back to defaults on garbage (non-numeric, zero)', () => {
    const res = probeCaps({ PA_MAX_RUNNING_THREADS_PER_TOPIC: 'abc', PA_MAX_THREADS_PER_TOPIC: '0' });
    assert.equal(res.status, 0, `child failed: ${res.stderr}`);
    assert.deepEqual(JSON.parse(res.stdout.trim()), [10, 20]);
  });
});

describe('settleOrphanedThread — conditional settle (AI-228)', () => {
  const fileRaw = () => readFileSync(join(home, `${KEY}.json`), 'utf8');

  it('flips a running + matching-runSeq record and persists the patch shape', async () => {
    const rec = mkRec('t-1', 1, 'running', 5);
    rec.runSeq = 3;
    rec.lastError = 'restart-parked: earlier episode — auto-requeued';
    rec.parkedUntil = new Date(Date.now() - 60_000).toISOString(); // stale, past
    seedFile(KEY, [rec]);
    const before = Date.now();
    const wrote = await settleOrphanedThread(KEY, 't-1', 3, {
      status: 'done',
      lastResult: 'the harvested answer',
      lastError: undefined,
      parkedUntil: undefined,
      unavailableParks: 0,
    });
    assert.equal(wrote, true);
    const after = await getThread(KEY, 't-1');
    assert.equal(after?.status, 'done');
    assert.equal(after?.lastResult, 'the harvested answer');
    // Terminal hygiene: a previous episode's stale park/error fields are cleared.
    assert.equal(after?.lastError, undefined);
    assert.equal(after?.parkedUntil, undefined);
    assert.ok(Date.parse(after!.updatedAt) >= before, 'updatedAt bumps on a write');
    // Persisted to disk, not just the in-memory map.
    const raw = JSON.parse(fileRaw()) as Record<string, ThreadRecord>;
    assert.equal(raw['t-1'].status, 'done');
    assert.equal(raw['t-1'].lastResult, 'the harvested answer');
    assert.equal(raw['t-1'].parkedUntil, undefined);
  });

  it('carries the shared restart-park demote shape (queued + restart-parked + ~5m stamp), preserving attempts/parks/pendingInput', async () => {
    const rec = mkRec('t-1', 1, 'running', 5);
    rec.runSeq = 2;
    rec.attempts = 1;
    rec.unavailableParks = 3;
    rec.pendingInput = ['steer me later'];
    seedFile(KEY, [rec]);
    const before = Date.now();
    const wrote = await settleOrphanedThread(KEY, 't-1', 2, restartParkFields(before, 'bot restarted mid-run'));
    assert.equal(wrote, true);
    const after = await getThread(KEY, 't-1');
    assert.equal(after?.status, 'queued');
    assert.equal(after?.lastError, 'restart-parked: bot restarted mid-run — auto-requeued');
    const parked = Date.parse(after!.parkedUntil!);
    assert.ok(parked >= before + 4 * 60_000 && parked <= Date.now() + 6 * 60_000,
      `parkedUntil ${after?.parkedUntil} should be ~5m future`);
    // A crash is not an attempt outcome — counters and queued steer input untouched.
    assert.equal(after?.attempts, 1);
    assert.equal(after?.unavailableParks, 3);
    assert.deepEqual(after?.pendingInput, ['steer me later']);
    // The parked record is NOT claimable this pass (the stamp gate), and the
    // next pass after the stamp re-claims it — the reclaim is the funnel's.
    assert.deepEqual(await claimThreadStarts(KEY), []);
    await updateThread(KEY, 't-1', { parkedUntil: new Date(Date.now() - 60_000).toISOString() });
    assert.deepEqual((await claimThreadStarts(KEY)).map((r) => r.id), ['t-1']);
  });

  it('no-op on a terminal record — returns false, file unchanged', async () => {
    seedFile(KEY, [mkRec('t-1', 1, 'done', 5)]);
    const beforeFile = fileRaw();
    assert.equal(await settleOrphanedThread(KEY, 't-1', 1, { status: 'queued' }), false);
    assert.equal(fileRaw(), beforeFile);
  });

  it('no-op on a queued record — returns false, file unchanged', async () => {
    seedFile(KEY, [mkRec('t-1', 1, 'queued', 5)]);
    const beforeFile = fileRaw();
    assert.equal(await settleOrphanedThread(KEY, 't-1', 1, { status: 'done' }), false);
    assert.equal(fileRaw(), beforeFile);
  });

  it('no-op on a runSeq mismatch (a new owner claimed it) — returns false, file unchanged', async () => {
    const rec = mkRec('t-1', 1, 'running', 5);
    rec.runSeq = 4; // advanced past the adopted runSeq
    seedFile(KEY, [rec]);
    const beforeFile = fileRaw();
    assert.equal(await settleOrphanedThread(KEY, 't-1', 3, { status: 'done' }), false);
    assert.equal(fileRaw(), beforeFile);
    assert.equal((await getThread(KEY, 't-1'))?.status, 'running'); // never clobbered
  });

  it('no-op on a missing record — returns false, no file written', async () => {
    assert.equal(await settleOrphanedThread(KEY, 't-99', 1, { status: 'done' }), false);
    assert.equal(existsSync(join(home, `${KEY}.json`)), false);
  });
});

// Router-metadata wave WP-2 (2026-09-20): ThreadRecord.routing — the origin
// turn's provenance persisted at createThread time (ids/enum words only) so
// the thread executor stamps PA_ROUTING_* into every dispatch's getEnv.
describe('createThread routing field (WP-2)', () => {
  it('persists routing and round-trips it through the store', async () => {
    const routing = {
      decision: 'router' as const,
      placement: 'diverted' as const,
      target: 'vi-0123456789ab',
      steer: 'wait' as const,
      steerBy: 'router' as const,
      effortProj: 'nearest' as const,
    };
    const r = await createThread(KEY, { title: 'Routed spawn', goal: 'g', workdir: 'C:/pa-checkout', routing });
    assert.ok(r.ok);
    assert.deepEqual(r.thread.routing, routing, 'the create result carries it verbatim');
    const back = await getThread(KEY, r.thread.id);
    assert.deepEqual(back?.routing, routing, 'the store round-trips it (a queued/parked thread starts minutes later)');
  });

  it('no routing passed ⇒ no key on the record (additive — old stores load fine)', async () => {
    const r = await createThread(KEY, { title: 'Plain spawn', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(r.ok);
    assert.ok(!('routing' in r.thread), 'the key must be absent, not undefined-valued');
    const back = await getThread(KEY, r.thread.id);
    assert.ok(back);
    assert.equal(back!.routing, undefined);
  });
});
