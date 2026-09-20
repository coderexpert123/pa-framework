import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import {
  sendBusMessage,
  deliverBusMessage,
  sessionBusAddress,
  listBusMessages,
  peekBusMessage,
  busCursorPath,
  readBusCursor,
  registerBusAddress,
  touchBusCursor,
  _resetBusQueueForTest,
} from '../src/lib/bus-queue.js';
import {
  runBusDrain,
  busDrainJob,
  addressFromQueueFilename,
} from '../src/lib/maintenance/jobs/bus-drain.js';
import type { CommandResult, PaConfig, RunOptions, WorkerConfig } from '../src/types.js';
import type { MaintenanceJobContext } from '../src/lib/maintenance/types.js';

let dir: string;

const WORKER: WorkerConfig = {
  name: 'testworker',
  command: 'testworker',
  args: ['{prompt_file}'],
  check: 'testworker --version',
  rate_limit_patterns: [],
  priority: 1,
};

function configWith(...workers: WorkerConfig[]): PaConfig {
  return { workers } as unknown as PaConfig;
}

function ctx(now = Date.now()): MaintenanceJobContext {
  return { now, everyMs: 60_000 };
}

interface SpawnCall {
  worker: WorkerConfig;
  prompt: string;
  options: RunOptions;
}

/** An executeFn stand-in recording calls; outcome flips per `succeed`. */
function spawnSpy(succeed: boolean): { fn: (w: WorkerConfig, p: string, o: RunOptions) => Promise<CommandResult>; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const fn = async (worker: WorkerConfig, prompt: string, options: RunOptions): Promise<CommandResult> => {
    calls.push({ worker, prompt, options });
    return succeed
      ? { success: true, output: 'done', exitCode: 0 }
      : { success: false, output: '', error: 'spawn exploded', exitCode: 1 };
  };
  return { fn, calls };
}

function drainDeps(executeFn: (w: WorkerConfig, p: string, o: RunOptions) => Promise<CommandResult>) {
  return {
    executeFn,
    loadConfigFn: async () => configWith(WORKER),
    repoRootFn: async () => 'D:/repo-stub',
  };
}

beforeEach(async () => {
  dir = await createTempPaHome();
  _resetBusQueueForTest();
});

afterEach(async () => {
  _resetBusQueueForTest();
  await cleanup(dir);
});

describe('bus-drain', () => {
  it('addressFromQueueFilename decodes the filename encoding and rejects non-addresses', () => {
    assert.equal(addressFromQueueFilename('devin+task-1.jsonl'), 'devin:task-1');
    assert.equal(addressFromQueueFilename('topic+13052.jsonl'), 'topic:13052');
    assert.equal(addressFromQueueFilename('claude@example.com.jsonl'), 'claude@example.com');
    assert.equal(addressFromQueueFilename('claude@repo#1.jsonl'), 'claude@repo#1');
    // Sidecar files are not queues.
    assert.equal(addressFromQueueFilename('devin+b.cursor.json'), null);
    assert.equal(addressFromQueueFilename('registry.json'), null);
    // A stem with no separator decodes to an invalid address (no @ or :) → skipped.
    assert.equal(addressFromQueueFilename('a_b_c.jsonl'), null);
    // An address with underscores in the task-id survives the round-trip.
    assert.equal(addressFromQueueFilename('devin+my_task.jsonl'), 'devin:my_task');
  });

  it('skips a registered address whose live arm has a fresh cursor', async () => {
    await registerBusAddress('devin:live1', { capabilities: ['hooks'], worker: 'testworker' });
    await sendBusMessage({ from: 'cli@a', to: 'devin:live1', body: 'hello live arm' });
    await touchBusCursor('devin:live1', 'inbox', 4242); // fresh — stamps now

    const spy = spawnSpy(true);
    const res = await runBusDrain(ctx(), drainDeps(spy.fn));

    assert.equal(spy.calls.length, 0, 'a live-armed address must not be spawned for');
    assert.equal(res.touched, 0);
    assert.equal(res.detail?.skipped && (res.detail.skipped as Record<string, string>)['devin:live1'], 'live-arm');
    assert.equal((await listBusMessages('devin:live1')).length, 1, 'message stays queued for the live arm');
  });

  it('a fresh hook-event cursor also suppresses the spawn (headed session actively firing)', async () => {
    await registerBusAddress('devin:live2', { capabilities: ['hooks'], worker: 'testworker' });
    await sendBusMessage({ from: 'cli@a', to: 'devin:live2', body: 'hook arm alive' });
    await touchBusCursor('devin:live2', 'hook', 4242); // fresh — stamps now

    const spy = spawnSpy(true);
    const res = await runBusDrain(ctx(), drainDeps(spy.fn));

    assert.equal(spy.calls.length, 0, 'a hook-touched address must not be spawned for');
    assert.equal(res.detail?.skipped && (res.detail.skipped as Record<string, string>)['devin:live2'], 'live-arm');
    assert.equal((await listBusMessages('devin:live2')).length, 1, 'message stays queued for the hook arm');
  });

  it('spawns the registered worker for an offline address and acks on success', async () => {
    await registerBusAddress('devin:off1', { capabilities: ['hooks'], worker: 'testworker' });
    await sendBusMessage({ from: 'cli@a', to: 'devin:off1', body: 'do the thing' });
    // Stale cursor (>5 min) — live caps alone do not suppress the drain.
    await mkdir(dirname(busCursorPath('devin:off1')), { recursive: true });
    await writeFile(
      busCursorPath('devin:off1'),
      JSON.stringify({ last_event: 'inbox', last_event_at: new Date(Date.now() - 10 * 60_000).toISOString(), pid: 9999 }),
      'utf8',
    );

    const spy = spawnSpy(true);
    const res = await runBusDrain(ctx(), drainDeps(spy.fn));

    assert.equal(spy.calls.length, 1, 'one spawn for the offline address');
    const call = spy.calls[0];
    assert.equal(call.worker.name, 'testworker');
    assert.equal(call.options.resource, 'bus-devin:off1');
    assert.equal(call.options.agentName, 'testworker');
    assert.equal(call.options.cwd, 'D:/repo-stub');
    assert.equal(call.options.env?.PA_BUS_ADDRESS, 'devin:off1', 'spawned worker gets PA_BUS_ADDRESS so whoami returns its bus address');
    assert.ok(call.prompt.includes('do the thing'), 'prompt carries the envelope body');
    assert.ok(call.prompt.includes('devin:off1'), 'prompt names the identity/address');
    assert.ok(call.prompt.includes('UNTRUSTED'), 'prompt carries the untrusted-input warning');
    assert.ok(call.prompt.includes('pa bus send'), 'prompt names the reply path');

    assert.equal(res.touched, 1);
    assert.deepEqual(await listBusMessages('devin:off1'), [], 'acked on success — queue empty');
    const cursor = await readBusCursor('devin:off1');
    assert.equal(cursor?.last_event, 'spawn');
    assert.equal(cursor?.pid, process.pid);
  });

  it('peek+ack, not pop: a failed spawn leaves the envelope queued for the next tick', async () => {
    await registerBusAddress('devin:flaky', { capabilities: [], worker: 'testworker' });
    await sendBusMessage({ from: 'cli@a', to: 'devin:flaky', body: 'retry me' });

    const failing = spawnSpy(false);
    const res1 = await runBusDrain(ctx(), drainDeps(failing.fn));
    assert.equal(failing.calls.length, 1);
    assert.equal(res1.touched, 0, 'failure acks nothing');
    assert.equal((res1.detail?.failed as Record<string, string>)['devin:flaky'], 'spawn exploded');
    const still = await peekBusMessage('devin:flaky');
    assert.equal(still?.body, 'retry me', 'envelope was peeked, never popped — retry next tick');

    const succeeding = spawnSpy(true);
    const res2 = await runBusDrain(ctx(), drainDeps(succeeding.fn));
    assert.equal(succeeding.calls.length, 1);
    assert.equal(res2.touched, 1);
    assert.deepEqual(await listBusMessages('devin:flaky'), [], 'acked only after the successful retry');
  });

  it('leaves an unregistered queue file untouched and reports the skip', async () => {
    await sendBusMessage({ from: 'cli@a', to: 'devin:ghost', body: 'nobody home' });

    const spy = spawnSpy(true);
    const res = await runBusDrain(ctx(), drainDeps(spy.fn));

    assert.equal(spy.calls.length, 0);
    assert.equal(res.touched, 0);
    assert.equal((res.detail?.skipped as Record<string, string>)['devin:ghost'], 'no-spawn-profile');
    assert.equal((await listBusMessages('devin:ghost')).length, 1, 'unclaimed mail is not discarded');
  });

  it('forwards a base-queue message to live discriminated children instead of spawning', async () => {
    // A message landed on claude@repo while nobody was live; sessions then
    // came online. The drain delivers it to their hook arms — no worker spawn.
    const child1 = sessionBusAddress('claude@repo', 'sess-1');
    const child2 = sessionBusAddress('claude@repo', 'sess-2');
    await registerBusAddress(child1, { capabilities: ['hooks'], worker: 'testworker' });
    await registerBusAddress(child2, { capabilities: ['hooks'], worker: 'testworker' });
    await touchBusCursor(child1, 'hook', 111);
    await touchBusCursor(child2, 'hook', 222);
    await sendBusMessage({ from: 'devin@repo#9', to: 'claude@repo', body: 'parked while offline' });

    const spy = spawnSpy(true);
    const res = await runBusDrain(ctx(), drainDeps(spy.fn));

    assert.equal(spy.calls.length, 0, 'live sessions make the spawn unnecessary');
    assert.equal(res.touched, 1);
    for (const child of [child1, child2]) {
      const msgs = await listBusMessages(child);
      assert.equal(msgs.length, 1, `${child} got the forwarded envelope`);
      assert.equal(msgs[0].body, 'parked while offline');
      assert.equal(msgs[0].from, 'devin@repo#9', 'original sender preserved for replies');
      assert.equal(msgs[0].hops, 1, 'forward counts as a hop');
    }
    assert.deepEqual(await listBusMessages('claude@repo'), [], 'base envelope acked after forward');
  });

  it('a base queue with only STALE children falls through to the normal spawn path', async () => {
    const staleChild = sessionBusAddress('claude@repo', 'sess-stale');
    await registerBusAddress(staleChild, { capabilities: ['hooks'], worker: 'testworker' });
    await mkdir(dirname(busCursorPath(staleChild)), { recursive: true });
    await writeFile(
      busCursorPath(staleChild),
      JSON.stringify({ last_event: 'hook', last_event_at: new Date(Date.now() - 10 * 60_000).toISOString(), pid: 1 }),
      'utf8',
    );
    await registerBusAddress('claude@repo', { capabilities: ['hooks'], worker: 'testworker' });
    await sendBusMessage({ from: 'devin@repo#9', to: 'claude@repo', body: 'nobody live' });

    const spy = spawnSpy(true);
    const res = await runBusDrain(ctx(), drainDeps(spy.fn));

    assert.equal(spy.calls.length, 1, 'stale children do not suppress the spawn arm');
    assert.equal(res.touched, 1);
    assert.equal(spy.calls[0].options.env?.PA_BUS_ADDRESS, 'claude@repo');
  });

  it('deliverBusMessage live-fan-out means a fresh base queue never forms when sessions are live', async () => {
    const child = sessionBusAddress('agy@repo', 'sess-live');
    await registerBusAddress(child, { capabilities: ['hooks'], worker: 'testworker' });
    await touchBusCursor(child, 'hook', 999);

    const res = await deliverBusMessage({ from: 'cli@a', to: 'agy@repo', body: 'while live' });
    assert.deepEqual(res.delivered, [child]);

    const spy = spawnSpy(true);
    const drain = await runBusDrain(ctx(), drainDeps(spy.fn));
    assert.equal(spy.calls.length, 0, 'nothing reached the base queue → nothing to drain/spawn');
    assert.equal(drain.touched, 0);
  });

  it('job declaration: pa host, 60s cadence, non-destructive, sheddable, no targets', () => {
    assert.equal(busDrainJob.name, 'bus-drain');
    assert.equal(busDrainJob.host, 'pa');
    assert.equal(busDrainJob.everyMs, 60_000);
    assert.equal(busDrainJob.destructive, false);
    assert.equal(busDrainJob.shedWhenDegraded, true);
    assert.deepEqual(busDrainJob.targets, []);
  });

  it('batches up to 5 same-address envelopes into one spawn with per-id acks', async () => {
    await registerBusAddress('devin:batch', { capabilities: [], worker: 'testworker' });
    for (let i = 1; i <= 7; i++) {
      await sendBusMessage({ from: 'cli@a', to: 'devin:batch', body: `batch body ${i}` });
    }
    const before = await listBusMessages('devin:batch');
    assert.equal(before.length, 7);

    const spy = spawnSpy(true);
    const res = await runBusDrain(ctx(), drainDeps(spy.fn));

    assert.equal(spy.calls.length, 1, 'one spawn carries the batch — never one spawn per envelope');
    const prompt = spy.calls[0].prompt;
    for (const env of before.slice(0, 5)) {
      assert.ok(prompt.includes(env.id), `prompt carries id ${env.id}`);
      assert.ok(prompt.includes(`--reply-to "${env.id}"`), `prompt carries a per-id reply-to for ${env.id}`);
    }
    assert.ok(prompt.includes('message 1 of 5'));
    assert.ok(prompt.includes('message 5 of 5'));
    assert.equal(res.touched, 5);
    const rest = await listBusMessages('devin:batch');
    assert.equal(rest.length, 2, 'the remainder stays queued for the next pass');
    assert.deepEqual(
      rest.map((e) => e.id),
      before.slice(5).map((e) => e.id),
      'the oldest five were acked, in order',
    );
  });

  it('a failing batch spawn acks nothing — all stay queued', async () => {
    await registerBusAddress('devin:batchfail', { capabilities: [], worker: 'testworker' });
    for (let i = 1; i <= 7; i++) {
      await sendBusMessage({ from: 'cli@a', to: 'devin:batchfail', body: `fail body ${i}` });
    }

    const failing = spawnSpy(false);
    const res = await runBusDrain(ctx(), drainDeps(failing.fn));

    assert.equal(failing.calls.length, 1);
    assert.equal(res.touched, 0, 'failure acks nothing');
    assert.equal((res.detail?.failed as Record<string, string>)['devin:batchfail'], 'spawn exploded');
    assert.equal((await listBusMessages('devin:batchfail')).length, 7, 'all stay queued for the next tick');
  });

  it('an over-budget body carries the verbatim truncation marker, never the full body', async () => {
    await registerBusAddress('devin:bigbody', { capabilities: [], worker: 'testworker' });
    const big = 'x'.repeat(3000);
    await sendBusMessage({ from: 'cli@a', to: 'devin:bigbody', body: big });

    const spy = spawnSpy(true);
    const res = await runBusDrain(ctx(), drainDeps(spy.fn));

    assert.equal(spy.calls.length, 1);
    const prompt = spy.calls[0].prompt;
    assert.ok(
      prompt.includes('… [TRUNCATED — pa bus inbox devin:bigbody prints the full body]'),
      'verbatim truncation marker present',
    );
    assert.equal(prompt.includes(big), false, 'the full body is absent from the prompt');
    assert.equal(res.touched, 1);
  });
});
