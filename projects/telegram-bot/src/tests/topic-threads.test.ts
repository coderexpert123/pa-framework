import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createThread,
  listThreads,
  getThread,
  queueThreadInput,
  takePendingInput,
  bumpRunSeq,
  updateThread,
  cancelRunningThreads,
  activeThreadCount,
  _clearThreadsForTest,
  _setStoreDirForTest,
  MAX_RUNNING_THREADS_PER_TOPIC,
  type ThreadRecord,
} from '../topic-threads.js';
import { waitForDrain } from './test-teardown-guard.js';

let home: string;
const KEY = '-1001234567890_5001'; // synthetic fixture id family, never real chat/thread ids

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

  it('enforces the 2-running cap and frees a slot when one finishes', async () => {
    const a = await createThread(KEY, { title: 'A', goal: 'g', workdir: 'C:/pa-checkout' });
    const b = await createThread(KEY, { title: 'B', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(a.ok && b.ok);
    const third = await createThread(KEY, { title: 'C', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(!third.ok);
    if (third.ok) return;
    assert.ok(third.reason.includes(`${MAX_RUNNING_THREADS_PER_TOPIC} threads already running`));
    assert.equal(await activeThreadCount(KEY), 2);
    await updateThread(KEY, 't-1', { status: 'done' });
    const fourth = await createThread(KEY, { title: 'D', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(fourth.ok);
    if (!fourth.ok) return;
    assert.equal(fourth.thread.id, 't-3');
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

describe('lazy stale demotion on read', () => {
  it('demotes a running record stale past 30m to failed with an interrupted error', async () => {
    seedFile(KEY, [mkRec('t-1', 1, 'running', 31)]);
    const threads = await listThreads(KEY);
    assert.equal(threads.length, 1);
    assert.equal(threads[0].status, 'failed');
    assert.ok(threads[0].lastError?.includes('interrupted'));
    // Demotion persists, so the running cap frees up for the next spawn.
    const raw = JSON.parse(readFileSync(join(home, `${KEY}.json`), 'utf8')) as Record<string, ThreadRecord>;
    assert.equal(raw['t-1'].status, 'failed');
    const fresh = await createThread(KEY, { title: 'After wedge', goal: 'g', workdir: 'C:/pa-checkout' });
    assert.ok(fresh.ok);
  });

  it('leaves fresh running records alone', async () => {
    seedFile(KEY, [mkRec('t-1', 1, 'running', 5)]);
    const threads = await listThreads(KEY);
    assert.equal(threads[0].status, 'running');
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
