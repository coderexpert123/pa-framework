/**
 * AI-203 WP-5 — orchestrator dispatch wiring, driven end-to-end through the
 * real poll loop (processUpdate): a `node -e` fake worker configured in the
 * test's own PA_HOME config.yaml, fetch mocked at the Telegram boundary, and
 * the thread store read through its real module (dispatch-error-paths.test.ts
 * harness pattern; runOneUpdate shape from poll-loop.test.ts).
 *
 * These fire the paths WP-2's seam tests could not reach:
 * - T1/T4  spawn: store record + executor fire + frozen footer; the ack WITH
 *          its envelope is never suppressed by the AI-202 guard (meta !== null).
 * - T2     steer of a done thread: input queued, executor wakes it (running +
 *          runSeq bump), frozen footer.
 * - T3     a promise WITHOUT an envelope is suppressed into the worker-error
 *          path (AI-202 composes) — never delivered as the answer.
 * - T5     the 10-running cap parks the 11th spawn as 'queued' with its
 *          frozen footer (no rejection — increment 4); no executor fire.
 * - T-INT  a mode:"interrupt" steer restarts the running thread with the
 *          fold consumed and the dead session dropped (killed=0 here — the
 *          store + footer are the pin, the real kill is unit-pinned in
 *          worker-stop.test.ts).
 * - T-WAKE the poll-tick reconcile drain revives a queued thread once a
 *          slot is free and runs it to done (restart backstop).
 * - T-CANCEL /stop cancels running AND queued threads (truthful count).
 * - T6     /stop cancels running threads (count in the reply) and the
 *          executor's ownership gate discards the result — no done FYI.
 * - T7     /orchestrator on: mode armed, role-boundary session clear.
 * - T8     non-orchestrator regression: the same envelope behaves exactly as
 *          today and touches no thread store.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ConversationState } from '../types.js';
import { rmRetry } from './rm-retry.js';
import { waitForDrain } from './test-teardown-guard.js';

const CHAT_ID = -1001234567890;

let sharedTempDir = '';
let currentTestDir = '';
let threadSeq = 5000;

before(async () => {
  sharedTempDir = await mkdtemp(join(tmpdir(), 'orch-dispatch-'));
  process.env.PA_HOME = sharedTempDir;
  await writeFile(join(sharedTempDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
  await writeFile(join(sharedTempDir, 'rate-limit-state.json'), '{}', 'utf8');
});

after(async () => {
  delete process.env.PA_HOME;
  await rmRetry(sharedTempDir);
});

// Dynamic imports after PA_HOME is set (dispatch-error-paths pattern).
// This file drives runPollLoop to its NATURAL exit in every case, and the
// loop's end-of-run hook is the real process.exit(0) unless neutered — the
// exact dark-file mechanism that silenced poll-loop.test.ts (subprocess dies
// before its TAP reaches the runner; poll-loop.test.ts's header comment).
// Neuter once at load, for the life of this subprocess.
const { runPollLoop, _setExitForTest } = await import('../main.js');
_setExitForTest(() => {});
const { createThread, getThread, listThreads, updateThread } = await import('../topic-threads.js');
const { _waitForThreadExecutionsForTest, _resetThreadQueueReconcileForTest } = await import('../thread-executor.js');
const { _clearStoppedForTest } = await import('../worker-stop.js');
const { _resetPendingDispatchesForTest } = await import('../pending-dispatches.js');
const { _resetDeliveredCacheForTest } = await import('../delivered-store.js');
const { _resetRecoveryGateForTest } = await import('../recovery-gate.js');
const { _resetResendStoreForTest } = await import('../resend-store.js');
const { _clearQueueForTest } = await import('../topic-queue.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Send bodies are MdV2-escaped (`\_`, `\(`) — strip the escapes so assertions
 *  target the logical text the bot composed. */
function plain(text: string): string {
  return text.replace(/\\/g, '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The worker's stdout travels base64-wrapped (makeWorkerScript idiom from
 *  premature-async-reply-dispatch.test.ts): envelope JSON is full of double
 *  quotes and \n escapes, which the Windows spawn path's quoting silently
 *  mangles — b64 output is [A-Za-z0-9+/=] only and survives every shell. */
function workerScript(output: string, opts: { holdMs?: number } = {}): string {
  const b64 = Buffer.from(output, 'utf8').toString('base64');
  const write = `process.stdout.write(Buffer.from('${b64}', 'base64').toString('utf8'));`;
  return opts.holdMs
    ? `${write} setTimeout(() => process.exit(0), ${opts.holdMs});`
    : `${write} process.exitCode = 0;`;
}

async function writeWorker(dir: string, script: string): Promise<void> {
  await writeFile(join(dir, 'config.yaml'), JSON.stringify({
    workers: [{
      name: 'fake',
      command: 'node',
      args: ['-e', script],
      input_mode: 'stdin-text',
      output_format: 'text',
      check: 'echo ok',
      rate_limit_patterns: [],
      priority: 1,
      state_dir: '/nonexistent/path',
      state_pattern: '*.jsonl',
    }],
  }), 'utf8');
}

/** Capture variant (batch-uptake-dispatch.test.ts idiom): every dispatched
 *  prompt is appended GOTPROMPTSTART…GOTPROMPTEND to a file, so a test counts
 *  turns and pins the presence/absence of prompt scaffolding. The script is a
 *  .cjs FILE, never an inline multi-line `-e` (the Windows spawn path's
 *  quoting mangles embedded newlines — the same hazard workerScript's b64
 *  wrap exists for); the output is still base64-wrapped. */
async function writeCaptureWorker(dir: string, output: string, opts: { holdMs?: number } = {}): Promise<string> {
  const capturePath = join(dir, 'prompt-capture.txt');
  const workerScriptPath = join(dir, 'capture-worker.cjs');
  const b64 = Buffer.from(output, 'utf8').toString('base64');
  await writeFile(workerScriptPath, [
    "const fs = require('node:fs');",
    "let d = '';",
    "process.stdin.on('data', c => { d += c; });",
    "process.stdin.on('end', () => {",
    `  fs.appendFileSync(${JSON.stringify(capturePath)}, 'GOTPROMPTSTART' + d + 'GOTPROMPTEND');`,
    `  process.stdout.write(Buffer.from(${JSON.stringify(b64)}, 'base64').toString('utf8'));`,
    opts.holdMs ? `  setTimeout(() => process.exit(0), ${opts.holdMs});` : '  process.exitCode = 0;',
    '});',
    '',
  ].join('\n'), 'utf8');
  const posixWorker = workerScriptPath.replace(/\\/g, '/');
  await writeFile(join(dir, 'config.yaml'), JSON.stringify({
    workers: [{
      name: 'fake',
      command: 'node',
      args: [posixWorker],
      input_mode: 'stdin-text',
      output_format: 'text',
      check: 'echo ok',
      rate_limit_patterns: [],
      priority: 1,
      state_dir: '/nonexistent/path',
      state_pattern: '*.jsonl',
    }],
  }), 'utf8');
  return capturePath;
}

function captureBlocks(capturePath: string): string[] {
  try {
    return readFileSync(capturePath, 'utf8')
      .split('GOTPROMPTEND')
      .filter((b) => b.includes('GOTPROMPTSTART'));
  } catch {
    return [];
  }
}

async function seedTopicState(threadId: number, extra: Record<string, unknown> = {}): Promise<string> {
  const topicKey = `${CHAT_ID}_${threadId}`;
  await writeFile(
    join(process.env.PA_HOME!, `telegram-bot-topic-${topicKey}.json`),
    JSON.stringify({ chat_id: CHAT_ID, thread_id: threadId, turns: [], ...extra }),
    'utf8'
  );
  return topicKey;
}

async function readTopicState(threadId: number): Promise<any> {
  return JSON.parse(await readFile(join(process.env.PA_HOME!, `telegram-bot-topic-${CHAT_ID}_${threadId}.json`), 'utf8'));
}

interface OneUpdate { update_id: number; text: string; replyTo?: { message_id: number; text?: string } }

/** Feed updates through the real poll loop; collect every sendMessage body.
 *  Accepts either a flat update list (one getUpdates batch) or explicit
 *  per-call batches (T6's spawn-then-/stop sequence). The mock stays installed
 *  until afterEach so thread FYIs sent after the loop exits (the executor lane
 *  is fire-and-forget) still land in the captured list. `replyTo` puts a
 *  reply_to_message on the message (AI-203 increment 3 anchor cases). */
async function runOne(
  batches: OneUpdate[] | OneUpdate[][],
  threadId: number,
  opts: { gate?: (call: number) => Promise<void> } = {},
): Promise<string[]> {
  const perCall: OneUpdate[][] = Array.isArray(batches[0])
    ? (batches as unknown as OneUpdate[][])
    : [batches as unknown as OneUpdate[]];
  const controller = new AbortController();
  const state: ConversationState = { chat_id: CHAT_ID, last_update_id: -1, thread_id: threadId, turns: [] };
  const sentTexts: string[] = [];
  let call = 0;
  (globalThis as Record<string, unknown>).fetch = async (url: string, init?: { body?: string }) => {
    const u = url as string;
    if (u.includes('getUpdates')) {
      if (opts.gate) await opts.gate(call);
      const batch = perCall[Math.min(call, perCall.length - 1)];
      call++;
      if (call >= perCall.length) controller.abort();
      const updates = batch.map((b) => ({
        update_id: b.update_id,
        message: {
          message_id: 100 + b.update_id,
          chat: { id: CHAT_ID, type: 'supergroup' },
          message_thread_id: threadId,
          date: Math.floor(Date.now() / 1000),
          text: b.text,
          ...(b.replyTo ? { reply_to_message: b.replyTo } : {}),
        },
      }));
      const body = { ok: true, result: updates };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    }
    if (u.includes('sendMessage') && init?.body) {
      sentTexts.push(JSON.parse(init.body).text ?? '');
    }
    const ok = { ok: true, result: { message_id: 999 } };
    return { ok: true, status: 200, text: async () => JSON.stringify(ok), json: async () => ok };
  };
  // fetch is restored by afterEach (never here — late FYIs need the mock).
  await runPollLoop('token', [CHAT_ID], state, {}, controller.signal, async () => {});
  return sentTexts;
}

/** Poll until `pred` holds (or the deadline passes) and return its last value. */
async function pollFor<T>(pred: () => Promise<T> | T, deadlineMs = 20000, stepMs = 50): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  let value = await pred();
  while (!value && Date.now() < deadline) {
    await sleep(stepMs);
    value = await pred();
  }
  return value;
}

const SPAWN_ACK = 'Spawning a thread to sweep the logs (t-3).';
const SPAWN_ENVELOPE = `${SPAWN_ACK}\n\n[PA_META]: {"actions":[{"type":"spawn_thread","title":"Sweep logs","prompt":"Run the sweep script and report counts."}]}`;
const STEER_ACK = 'Routing your message to thread t-1 now.';
const STEER_ENVELOPE = `${STEER_ACK}\n\n[PA_META]: {"actions":[{"type":"steer_thread","thread_id":"t-1","message":"now also check the stderr logs"}]}`;
const PROMISE_ONLY = 'I have launched the sweep and will report back when it completes.';
const INTERRUPT_ACK = 'Killing that run — redoing it with the new scope now.';
const INTERRUPT_ENVELOPE = `${INTERRUPT_ACK}\n\n[PA_META]: {"actions":[{"type":"steer_thread","thread_id":"t-1","message":"redo it for the failures log instead","mode":"interrupt"}]}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('orchestrator dispatch wiring (AI-203 WP-5, end-to-end)', () => {
  let threadId = 0;
  let topicKey = '';
  const savedFetch = (globalThis as Record<string, unknown>).fetch;

  beforeEach(async () => {
    currentTestDir = await mkdtemp(join(sharedTempDir, 'case-'));
    process.env.PA_HOME = currentTestDir;
    threadId = ++threadSeq;
    topicKey = `${CHAT_ID}_${threadId}`;
  });

  afterEach(async () => {
    // Let any in-flight thread execution settle BEFORE the temp dir vanishes
    // (its store writes and FYIs are best-effort, not latched into the drain).
    await _waitForThreadExecutionsForTest().catch(() => {});
    await waitForDrain();
    (globalThis as Record<string, unknown>).fetch = savedFetch;
    // The reconcile drain's 60 s throttle is module state — reset it per test
    // so T-WAKE's poll-tick backstop is live in every test's own window.
    _resetThreadQueueReconcileForTest();
    _clearStoppedForTest();
    _resetPendingDispatchesForTest();
    _resetDeliveredCacheForTest();
    _resetRecoveryGateForTest();
    _resetResendStoreForTest();
    _clearQueueForTest();
    process.env.PA_HOME = sharedTempDir;
    if (currentTestDir) await rmRetry(currentTestDir);
    currentTestDir = '';
  });

  it('T1: spawn — footer, store record, pickup + done FYIs (executor seam fired)', async () => {
    await seedTopicState(threadId, { orchestrator_enabled: true });
    // Output flushes immediately; the process HOLDS so the record is still
    // `running` when the reply lands (no race on the status assert).
    await writeWorker(currentTestDir, workerScript(SPAWN_ENVELOPE, { holdMs: 1500 }));

    const sent = await runOne([{ update_id: 1, text: 'sweep the logs please' }], threadId);
    const L = () => sent.map(plain);

    // T1 affirmatives: the ack sentence AND the frozen spawn footer in ONE reply.
    const reply = L().find((t) => t.includes(SPAWN_ACK));
    assert.ok(reply, `the orchestrator ack must be delivered; got: ${JSON.stringify(L())}`);
    assert.ok(reply.includes('_(Thread t-1 spawned: Sweep logs'), `footer missing from: ${reply}`);

    // The store record exists and is running (the executor owns it now).
    const rec = await getThread(topicKey, 't-1');
    assert.ok(rec, 'thread record t-1 must exist in the store');
    assert.equal(rec!.status, 'running');

    // The thread-dispatch seam actually fired: pickup FYI, then the done FYI.
    const pickedUp = await pollFor(() => L().some((t) => t.includes('🧵 Thread t-1 started: Sweep logs')));
    assert.ok(pickedUp, 'pickup FYI must arrive once the executor fires');
    const done = await pollFor(() => L().some((t) => t.includes('✅ Thread t-1 done: Sweep logs')));
    assert.ok(done, 'completion FYI must arrive when the thread run settles');
  });

  it('T4: the ack WITH its envelope is never suppressed by the AI-202 guard', async () => {
    await seedTopicState(threadId, { orchestrator_enabled: true });
    await writeWorker(currentTestDir, workerScript(SPAWN_ENVELOPE));

    const sent = await runOne([{ update_id: 1, text: 'sweep the logs please' }], threadId);
    const L = () => sent.map(plain);

    assert.ok(L().some((t) => t.includes(SPAWN_ACK)), 'the full promise-shaped sentence must be delivered (meta !== null bypass)');
    assert.ok(!L().some((t) => t.includes('returned an empty response')), 'an ack carrying its envelope must never be blanked into the worker-error path');
  });

  it('T2: steer of a done thread queues, wakes the executor (running + runSeq bump)', async () => {
    await seedTopicState(threadId, { orchestrator_enabled: true });
    const created = await createThread(topicKey, { title: 'Sweep logs', goal: 'sweep the logs', workdir: currentTestDir });
    assert.ok(created.ok);
    await updateThread(topicKey, 't-1', { status: 'done', lastResult: 'it worked' });
    await writeWorker(currentTestDir, workerScript(STEER_ENVELOPE, { holdMs: 1200 }));

    const sent = await runOne([{ update_id: 1, text: 'now also check the stderr logs' }], threadId);
    const L = () => sent.map(plain);

    const reply = L().find((t) => t.includes('Routing your message to thread t-1 now.'));
    assert.ok(reply, `steer ack must be delivered; got: ${JSON.stringify(L())}`);
    assert.ok(reply.includes('_(Routed to thread t-1'), `footer missing from: ${reply}`);

    // The executor woke the done thread: input drained, runSeq bumped, and the
    // record shows the resumed run. `running` is a TRANSIENT the observer can
    // miss entirely on a fast host: the whole resumed lifecycle (pickup FYI,
    // dispatch, the 1.2 s worker hold, completion) can close before runOne
    // returns and this poller's first read (seen on CI-linux, where the
    // completion FYI landed while the poll loop was still tearing down; the
    // pin card mid-window even showed "Threads: 1 running"). The settled
    // end-state is therefore accepted as the SAME evidence: runSeq is bumped
    // by the executor's dispatch loop alone and lastResult only by its
    // completion write, so a done record whose seeded result ('it worked',
    // line ~314) was overwritten proves the executor ran the thread to
    // completion.
    const woke = await pollFor(async () => {
      const rec = await getThread(topicKey, 't-1');
      if (!rec || rec.runSeq < 1 || rec.pendingInput.length > 0) return false;
      return rec.status === 'running' || (rec.status === 'done' && rec.lastResult !== 'it worked');
    });
    assert.ok(woke, 'the executor must resume the thread: running, runSeq bumped, input drained');
  });

  it('T3: a promise WITHOUT an envelope is suppressed into the worker-error path', async () => {
    await seedTopicState(threadId, { orchestrator_enabled: true });
    await writeWorker(currentTestDir, workerScript(PROMISE_ONLY));

    const sent = await runOne([{ update_id: 1, text: 'did you start it?' }], threadId);
    const L = () => sent.map(plain);

    assert.ok(!L().some((t) => t.includes('I have launched the sweep')), 'the false promise must NOT be delivered as the answer');
    const err = L().find((t) => t.startsWith('⚠️'));
    assert.ok(err, `a worker-error reply must be sent instead; got: ${JSON.stringify(L())}`);
    assert.ok(err.includes('returned an empty response'));
    assert.equal(await listThreads(topicKey).then((l) => l.length), 0, 'no thread may spawn from a suppressed turn');
  });

  it('T5: the 10-running cap parks the spawn as queued with its frozen footer; no executor fire', async () => {
    await seedTopicState(threadId, { orchestrator_enabled: true });
    for (let i = 1; i <= 10; i++) {
      const seeded = await createThread(topicKey, { title: `r${i}`, goal: 'g', workdir: currentTestDir });
      assert.ok(seeded.ok);
    }
    const capturePath = await writeCaptureWorker(currentTestDir, SPAWN_ENVELOPE);

    const sent = await runOne([{ update_id: 1, text: 'spawn another one' }], threadId);
    const L = () => sent.map(plain);

    const reply = L().find((t) => t.includes(SPAWN_ACK));
    assert.ok(reply, 'the ack must still be delivered');
    assert.ok(reply.includes('_(Thread t-11 queued — starts when one finishes.)_'), `parked footer missing from: ${reply}`);
    const parked = await getThread(topicKey, 't-11');
    assert.equal(parked?.status, 'queued', 'the 11th spawn must be parked as queued, not rejected');
    assert.equal(await listThreads(topicKey).then((l) => l.length), 11, 'no rejection — the record exists');
    assert.equal(
      captureBlocks(capturePath).length,
      1,
      'only the orchestrator turn may dispatch — no 11th executor fire'
    );
  });

  it('T-INT: a mode:"interrupt" steer restarts the running thread with the fold consumed', async () => {
    await seedTopicState(threadId, { orchestrator_enabled: true });
    const created = await createThread(topicKey, { title: 'Sweep logs', goal: 'sweep the logs', workdir: currentTestDir });
    assert.ok(created.ok); // createThread seeds status 'running'
    await updateThread(topicKey, 't-1', {
      session: { session_id: 's-int', worker: 'fake', started_at: new Date().toISOString() },
    });
    await writeWorker(currentTestDir, workerScript(INTERRUPT_ENVELOPE));

    const sent = await runOne([{ update_id: 1, text: 'no — redo it for the failures log instead' }], threadId);
    const L = () => sent.map(plain);

    const reply = L().find((t) => t.includes('_(Interrupted thread t-1 — restarting with your message.)_'));
    assert.ok(reply, `interrupt footer missing from: ${JSON.stringify(L())}`);

    // The restart consumed the fold as its first turn and the kill-drop
    // cleared the dead session. killed=0 is expected here (no registered
    // pids) — the real kill is unit-pinned in worker-stop.test.ts; the
    // STORE and FOOTER are the pin, never the kill.
    await _waitForThreadExecutionsForTest();
    const rec = await getThread(topicKey, 't-1');
    assert.deepEqual(rec?.pendingInput, [], 'the restart must consume the folded message');
    assert.equal(rec?.session, undefined, 'the interrupt must drop the dead session');
  });

  it('T-WAKE: the poll-tick reconcile drain revives a queued thread and runs it to done', async () => {
    await seedTopicState(threadId, { orchestrator_enabled: true });
    const a = await createThread(topicKey, { title: 'Thread A', goal: 'count the running widgets', workdir: currentTestDir });
    const b = await createThread(topicKey, { title: 'Thread B', goal: 'tally the B figures', workdir: currentTestDir });
    assert.ok(a.ok && b.ok);
    await updateThread(topicKey, 't-2', { status: 'queued' }); // parked; the drain must revive it
    const capturePath = await writeCaptureWorker(currentTestDir, 'WAKE_TURN_BODY');

    const sent = await runOne([{ update_id: 1, text: 'status check' }], threadId);
    const L = () => sent.map(plain);

    const drained = await pollFor(async () => (await getThread(topicKey, 't-2'))?.status === 'done');
    assert.ok(drained, `the drain must start the queued thread and run it to done; t-2=${JSON.stringify(await getThread(topicKey, 't-2'))}`);
    assert.ok(
      captureBlocks(capturePath).some((b) => b.includes('tally the B figures')),
      'the capture list must show B goal text (its dispatch happened)'
    );
    assert.ok(L().some((t) => t.includes('✅ Thread t-2 done: Thread B')), 'the completion FYI must arrive');
  });

  it('T6: /stop cancels the running thread (truthful count) and the runSeq gate discards its result', async () => {
    await seedTopicState(threadId, { orchestrator_enabled: true });
    // Holds long enough for /stop to land mid-run; the executor must then
    // discard the result silently (no done FYI, record stays cancelled).
    await writeWorker(currentTestDir, workerScript(SPAWN_ENVELOPE, { holdMs: 2500 }));

    // The poll loop does NOT await one update's processing before polling
    // again, so the /stop batch must be HELD until the thread record exists
    // mid-run — otherwise the stop lands before the spawn and (correctly,
    // AI-092) kills the in-flight orchestrator turn instead.
    const sent = await runOne([
      [{ update_id: 1, text: 'sweep the logs please' }],
      [{ update_id: 2, text: '/stop' }],
    ], threadId, {
      gate: async (call) => {
        if (call !== 1) return;
        await pollFor(async () => (await getThread(topicKey, 't-1').catch(() => undefined))?.status === 'running');
      },
    });
    const L = () => sent.map(plain);

    const stopReply = L().find((t) => t.includes('cancelled 1 thread(s)'));
    assert.ok(stopReply, `the stop reply must state the cancelled-thread count; got: ${JSON.stringify(L())}`);
    assert.ok(stopReply.includes('their results will be discarded'));

    // Let the executor settle, then prove the gate: no completion FYI ever came.
    await _waitForThreadExecutionsForTest();
    assert.ok(!L().some((t) => t.includes('✅ Thread t-1 done')), 'a cancelled thread must never post its result');
    const rec = await getThread(topicKey, 't-1');
    assert.equal(rec?.status, 'cancelled');
  });

  it('T-CANCEL: /stop cancels running AND queued threads (truthful count)', async () => {
    await seedTopicState(threadId, { orchestrator_enabled: true });
    const first = await createThread(topicKey, { title: 'one', goal: 'g', workdir: currentTestDir });
    const second = await createThread(topicKey, { title: 'two', goal: 'g', workdir: currentTestDir });
    assert.ok(first.ok && second.ok);
    await updateThread(topicKey, 't-2', { status: 'queued' });
    // Holds long enough that a drain-fired t-2 cannot settle before /stop
    // lands — parked or mid-run, both states must be caught by the cancel.
    await writeWorker(currentTestDir, workerScript('busy', { holdMs: 2500 }));

    const sent = await runOne([{ update_id: 1, text: '/stop' }], threadId);
    const L = () => sent.map(plain);

    const stopReply = L().find((t) => t.includes('cancelled 2 thread(s)'));
    assert.ok(stopReply, `the stop reply must count running + queued; got: ${JSON.stringify(L())}`);
    assert.ok(stopReply.includes('their results will be discarded'));
    await _waitForThreadExecutionsForTest();
    const one = await getThread(topicKey, 't-1');
    const two = await getThread(topicKey, 't-2');
    assert.equal(one?.status, 'cancelled');
    assert.equal(two?.status, 'cancelled');
    assert.ok(!L().some((t) => t.includes('✅ Thread t-1 done')), 'a cancelled thread must never post its result');
    assert.ok(!L().some((t) => t.includes('✅ Thread t-2 done')), 'a cancelled thread must never post its result');
  });

  it('T7: /orchestrator on arms the mode and clears the session (role boundary)', async () => {
    await seedTopicState(threadId, {
      session: { session_id: 's-orch', worker: 'fake', started_at: new Date().toISOString() },
    });
    await writeWorker(currentTestDir, 'process.exitCode = 0;');

    const sent = await runOne([{ update_id: 1, text: '/orchestrator on' }], threadId);
    const L = () => sent.map(plain);

    assert.ok(L().some((t) => t.includes('🧭 Orchestrator mode ON')), `expected the frozen ON reply; got: ${JSON.stringify(L())}`);
    const state = await readTopicState(threadId);
    assert.equal(state.orchestrator_enabled, true);
    assert.equal(state.session, undefined, 'the role switch must clear the topic session');
  });

  it('T8: non-orchestrator regression — the same envelope behaves exactly as today', async () => {
    await seedTopicState(threadId);
    await writeWorker(currentTestDir, workerScript(SPAWN_ENVELOPE));

    const sent = await runOne([{ update_id: 1, text: 'sweep the logs please' }], threadId);
    const L = () => sent.map(plain);

    assert.ok(L().some((t) => t.includes(SPAWN_ACK)), 'the cleaned reply is delivered as today');
    assert.ok(!L().some((t) => t.includes('Thread t-1 spawned')), 'no thread footer on the human lane');
    assert.equal(await listThreads(topicKey).then((l) => l.length), 0, 'no thread store file may be created for a non-orchestrator topic');
  });

  // --- AI-203 increment 3: the reply-to-FYI anchor steer (T-A1..T-A6) ---
  // All assertions are on the DELIVERED reply text and the STORE — never on
  // module internals.

  it('T-A1: a reply to a done FYI steers the thread directly — lead, routed footer, real executor drain', async () => {
    // T7's mechanism: the topic is armed through the loop, not by seeding.
    await writeCaptureWorker(currentTestDir, 'ANCHOR_ACK_BODY_A1');
    const created = await createThread(topicKey, { title: 'Sweep logs', goal: 'sweep the logs', workdir: currentTestDir });
    assert.ok(created.ok);
    await updateThread(topicKey, 't-1', { status: 'done', lastResult: 'counts: 42' });

    const sent = await runOne([
      [{ update_id: 1, text: '/orchestrator on' }],
      [{
        update_id: 2,
        text: 'also check the failures log',
        replyTo: { message_id: 555, text: '✅ Thread t-1 done: Sweep logs\n\n<result text>\n\n_Ref: s-000000000000_' },
      }],
    ], threadId);
    const L = () => sent.map(plain);

    // Affirmative: the frozen lead + the frozen routed footer in ONE reply — an
    // anchor that silently fell through to a normal orchestrator turn (no lead)
    // is a DEFECT, not a pass.
    const reply = L().find((t) => t.includes('➡️ Follow-up for thread t-1 (Sweep logs):'));
    assert.ok(reply, `the anchor lead must be delivered; got: ${JSON.stringify(L())}`);
    assert.ok(reply.includes('_(Routed to thread t-1'), `routed footer missing from: ${reply}`);

    // The routed fire consumed the steer through the REAL executor path: the
    // thread ran again and drained its input. The thread's OWN routed dispatch
    // also invokes the fake worker asynchronously, so the capture list is not
    // the pin here — the store state after the drain is.
    await _waitForThreadExecutionsForTest();
    const rec = await getThread(topicKey, 't-1');
    assert.equal(rec?.status, 'done');
    assert.deepEqual(rec?.pendingInput, []);

    // The ack path ran NO worker: the archived assistant turn must carry
    // worker 'local' — a fallback-chain worker name here lies in the
    // conversation archive and defeats the closeWindow null sentinel.
    const ackTurn = (await readTopicState(threadId)).turns
      .find((t: any) => t.role === 'assistant' && t.text.includes('➡️ Follow-up for thread t-1'));
    assert.ok(ackTurn, `the anchor ack turn is archived; turns: ${JSON.stringify((await readTopicState(threadId)).turns)}`);
    assert.equal(ackTurn.worker, 'local', 'the ack turn must not fake a worker');
  });

  it('T-A2: a reply to an FYI of a RUNNING thread queues the input behind the frozen lead', async () => {
    await seedTopicState(threadId, { orchestrator_enabled: true });
    await writeCaptureWorker(currentTestDir, 'ANCHOR_ACK_BODY_A2');
    const created = await createThread(topicKey, { title: 'Sweep logs', goal: 'sweep the logs', workdir: currentTestDir });
    assert.ok(created.ok); // createThread seeds status 'running'

    const sent = await runOne([{
      update_id: 1,
      text: 'also check the failures log',
      replyTo: { message_id: 555, text: '✅ Thread t-1 done: Sweep logs\n\n<result text>\n\n_Ref: s-000000000000_' },
    }], threadId);
    const L = () => sent.map(plain);

    const reply = L().find((t) => t.includes('➡️ Follow-up for thread t-1 (Sweep logs):'));
    assert.ok(reply, `the anchor lead must be delivered; got: ${JSON.stringify(L())}`);
    assert.ok(reply.includes('_(Queued for thread t-1'), `queued footer missing from: ${reply}`);
    const rec = await getThread(topicKey, 't-1');
    assert.deepEqual(rec?.pendingInput, ['also check the failures log']);
  });

  it('T-A3: a reply to a PLAIN message is a normal orchestrator turn — no anchor lead', async () => {
    await seedTopicState(threadId, { orchestrator_enabled: true });
    const capturePath = await writeCaptureWorker(currentTestDir, 'PLAIN_TURN_BODY_A3');

    const sent = await runOne([{
      update_id: 1,
      text: 'what did that note mean?',
      replyTo: { message_id: 556, text: 'earlier note' },
    }], threadId);
    const L = () => sent.map(plain);

    assert.ok(!L().some((t) => t.includes('➡️')), `no anchor lead on a plain reply; got: ${JSON.stringify(L())}`);
    assert.ok(L().some((t) => t.includes('PLAIN_TURN_BODY_A3')), 'the normal orchestrator turn ran and its reply was delivered');
    assert.equal(captureBlocks(capturePath).length, 1, 'the fake worker dispatched exactly once (the orchestrator turn)');
  });

  it('T-A4: an armed pending_action outranks the anchor — the reply is the confirmation turn', async () => {
    await seedTopicState(threadId, {
      orchestrator_enabled: true,
      // confirm-gate.test.ts fixture shape, set on the topic state directly.
      pending_action: { description: 'spawn the sweep thread', proposed_at: new Date().toISOString() },
    });
    await writeCaptureWorker(currentTestDir, 'CONFIRM_TURN_BODY_A4');
    const created = await createThread(topicKey, { title: 'Sweep logs', goal: 'sweep the logs', workdir: currentTestDir });
    assert.ok(created.ok);
    await updateThread(topicKey, 't-1', { status: 'done', lastResult: 'counts: 42' });

    const sent = await runOne([{
      update_id: 1,
      text: 'also check the failures log',
      replyTo: { message_id: 555, text: '✅ Thread t-1 done: Sweep logs\n\n<result text>\n\n_Ref: s-000000000000_' },
    }], threadId);
    const L = () => sent.map(plain);

    assert.ok(!L().some((t) => t.includes('➡️ Follow-up for thread')), `pending_action must outrank the anchor; got: ${JSON.stringify(L())}`);
    assert.ok(L().some((t) => t.includes('CONFIRM_TURN_BODY_A4')), 'the normal orchestrator turn ran');
    const rec = await getThread(topicKey, 't-1');
    assert.deepEqual(rec?.pendingInput, [], 'nothing was steered into the thread');
  });

  it('T-A5: an FYI-shaped reply naming an ABSENT thread dispatches normally — no anchor lead', async () => {
    await seedTopicState(threadId, { orchestrator_enabled: true });
    await writeCaptureWorker(currentTestDir, 'ABSENT_THREAD_BODY_A5');

    const sent = await runOne([{
      update_id: 1,
      text: 'also check the failures log',
      replyTo: { message_id: 555, text: '✅ Thread t-99 done: Sweep logs\n\n<result text>\n\n_Ref: s-000000000000_' },
    }], threadId);
    const L = () => sent.map(plain);

    assert.ok(!L().some((t) => t.includes('➡️')), `no anchor lead for an absent thread; got: ${JSON.stringify(L())}`);
    assert.ok(L().some((t) => t.includes('ABSENT_THREAD_BODY_A5')), 'the normal orchestrator turn ran');
  });

  it('T-A6: a reply-shaped head + a queued plain follower — head anchors alone, follower takes its own turn', async () => {
    await seedTopicState(threadId, { orchestrator_enabled: true });
    const capturePath = await writeCaptureWorker(currentTestDir, 'ORCH_TURN_BODY_A6', { holdMs: 2500 });
    const created = await createThread(topicKey, { title: 'Sweep logs', goal: 'sweep the logs', workdir: currentTestDir });
    assert.ok(created.ok);
    await updateThread(topicKey, 't-1', { status: 'done', lastResult: 'counts: 42' });

    const sent = await runOne([
      [{ update_id: 1, text: 'WARMUP_A6 hold this turn' }],
      [
        {
          update_id: 2,
          text: 'also check the failures log',
          replyTo: { message_id: 555, text: '✅ Thread t-1 done: Sweep logs\n\n<result text>\n\n_Ref: s-000000000000_' },
        },
        { update_id: 3, text: 'plain follower message' },
      ],
    ], threadId, {
      gate: async (call) => {
        if (call !== 1) return;
        // Hold the [head, follower] batch until the warmup turn is verifiably
        // IN FLIGHT, so the head's turn-start compile sees a genuinely queued
        // follower (an idle-topic same-batch pair never queues).
        await pollFor(() => captureBlocks(capturePath).length >= 1);
      },
    });

    const L = () => sent.map(plain);
    const lead = await pollFor(() => L().some((t) => t.includes('➡️ Follow-up for thread t-1 (Sweep logs):')));
    assert.ok(lead, `the head's anchor steer must fire; got: ${JSON.stringify(L())}`);

    // The follower stayed queued and took its OWN turn: exactly two
    // orchestrator-lane dispatches (warmup + follower) — the head never
    // dispatched and never folded — and no prompt carries batch scaffolding.
    await _waitForThreadExecutionsForTest();
    const settled = await pollFor(() => {
      const blocks = captureBlocks(capturePath);
      const orchestratorTurns = blocks.filter((b) => b.includes('You are the orchestrator'));
      return orchestratorTurns.length >= 2 && blocks.every((b) => !b.includes('[Batched:'));
    });
    assert.ok(settled, 'the follower turn must settle without batch scaffolding');
    const blocks = captureBlocks(capturePath);
    assert.equal(
      blocks.filter((b) => b.includes('You are the orchestrator')).length,
      2,
      `exactly the warmup + the follower's own turn may dispatch; got: ${blocks.length} block(s)`
    );
    assert.ok(blocks.every((b) => !b.includes('[Batched:')), `no prompt may carry batch scaffolding: ${JSON.stringify(blocks.map((b) => b.slice(0, 120)))}`);
  });
});
