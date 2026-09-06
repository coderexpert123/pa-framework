import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  addPendingDispatch,
  listPendingDispatches,
  absorbHeldDispatchRecords,
  _resetPendingDispatchesForTest,
  type PendingDispatch,
} from '../pending-dispatches.js';
import {
  reapOrphanedDispatches,
  type ReaperDeps,
} from '../orphan-reaper.js';
import { _clearQueueForTest, _clearHeldForTest, registerQueuedUpdate } from '../topic-queue.js';
import { compileBatchFold } from '../batch-uptake.js';
import { _clearStoppedForTest } from '../worker-stop.js';
import { waitForDrain } from './test-teardown-guard.js';
import { runPollLoop, _setExitForTest } from '../main.js';
import type { ConversationState } from '../types.js';

_setExitForTest(() => {});

function makeState(chatId = 123, lastUpdateId = -1): ConversationState {
  return { chat_id: chatId, last_update_id: lastUpdateId, thread_id: 0, turns: [] };
}

const fastSleep = async (_ms: number): Promise<void> => {};

describe('steer-voice-recovery (AI-208 WP-2 / WP-4)', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-steer-recovery-'));
    process.env.PA_HOME = tempDir;
    _resetPendingDispatchesForTest();
    _clearQueueForTest();
    _clearHeldForTest();
    _clearStoppedForTest();
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    _resetPendingDispatchesForTest();
    _clearQueueForTest();
    _clearHeldForTest();
    _clearStoppedForTest();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('AI-209 lifecycle: a drain-target entry folded into a batch is CONSUMED — the head record recovers it', async () => {
    // Takeover #4 (2026-09-06): the previous shape enqueued msg1+msg2 in ONE
    // getUpdates batch to an IDLE topic and expected them to fold. That is
    // deterministically impossible and spec-compliant NOT to happen: the poll
    // loop registers msg1 and chains its turn, and the loop's own saveState
    // yield lets msg1's ENTIRE turn (compile included) run before msg2 is
    // registered — the compile peeks an empty queue (`peeked batch count 0`)
    // and msg1 dispatches alone. SPEC §2.5's trigger is ≥2 eligible entries
    // QUEUED at a natural drain; a same-batch follower on an idle topic is not
    // that. The corrected shape makes the pair GENUINELY queue: an initial
    // warmup turn is held in flight by the slow fake worker, THEN msg1+msg2
    // arrive, so msg2 sits in the queue when msg1's turn compiles (the same
    // precondition the passing e2e T1 in batch-uptake-dispatch.test.ts sets).
    //
    // The old /stop leg rode on that impossible same-batch setup; it is kept
    // here with real teeth: the /stop lands DURING the combined turn, so it
    // must hold the WHOLE combined text for the next dispatch (SPEC §2.5 row
    // "/steer or /stop during a combined turn"), asserted via the next
    // dispatch's captured prompt.
    //
    // SPEC §2.4 lifecycle asserted:
    //  - "Confirm → materialize": the compile flips the follower record to
    //    heldForTopic (unit half below — the flip and the seam's removal run
    //    in ONE microtask chain, so a timer-based poller can only observe the
    //    REMOVAL; see batch-uptake-dispatch.test.ts T7/T7b for the split).
    //  - "Materialize → reply delivered": mid-turn the follower record is
    //    REMOVED at proven materialization and the head's live record ALONE
    //    carries the combined prompt + foldedFrom provenance.
    // Every assertion is affirmative and fail-capable: a no-fold regression
    // leaves msg2's own record live mid-turn, no header in any prompt, and
    // QUEUEDMSG absent from the head's userText.
    const capturePath = join(tempDir, 'prompt-capture.txt');
    const startedFlag = join(tempDir, 'worker-started.flag');
    const workerScript = join(tempDir, 'echo-worker-recovery.cjs');
    await writeFile(workerScript, [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(startedFlag)}, 'up');`,
      "let d = '';",
      "process.stdin.on('data', c => { d += c; });",
      "process.stdin.on('end', async () => {",
      `  fs.appendFileSync(${JSON.stringify(capturePath)}, 'GOTPROMPTSTART' + d + 'GOTPROMPTEND');`,
      "  const hold = (d.includes('WARMUP_RECOVERY') || d.includes('[Batched:')) ? 2500 : 0;",
      "  if (hold) { await new Promise(r => setTimeout(r, hold)); }",
      "  process.stdout.write('GOTPROMPTSTART' + d + 'GOTPROMPTEND');",
      '  process.exit(0);',
      '});',
    ].join('\n'), 'utf8');

    const posixWorker = workerScript.replace(/\\/g, '/');
    await writeFile(join(tempDir, 'config.yaml'), `
workers:
  - name: claude
    input_mode: stdin-text
    command: node
    args: ["${posixWorker}"]
    check: node -e "process.exit(0)"
topic_defaults:
  "123_0": "claude"
`, 'utf8');

    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    await writeFile(topicStateFile, JSON.stringify({ chat_id: 123, thread_id: 0, turns: [] }), 'utf8');

    // --- Unit half: the §2.4 "Confirm → materialize" hold, against the REAL
    // compiler + REAL store (isolated PA_HOME so the e2e store below starts
    // clean). Deterministic where the e2e poller cannot be.
    const unitDir = await mkdtemp(join(tmpdir(), 'tgbot-steer-recovery-unit-'));
    process.env.PA_HOME = unitDir;
    _resetPendingDispatchesForTest();
    try {
      const followerEntry = registerQueuedUpdate('123_0', 2, 'QUEUEDMSG', undefined, 102);
      await addPendingDispatch({
        updateId: 2, chatId: 123, threadId: 0, messageId: 102,
        userText: 'QUEUEDMSG', startedAt: new Date().toISOString(),
      });
      const plan = await compileBatchFold({
        topicKey: '123_0', chatId: 123, threadId: 0,
        head: { updateId: 1, messageId: 101, text: 'FIRSTMSG' },
      });
      assert.ok(plan, 'a queued follower must compile into a fold plan');
      assert.ok(followerEntry.cancelled, 'the follower entry was confirmed (consumed from the queue)');
      assert.ok(plan.combinedText.includes('FIRSTMSG') && plan.combinedText.includes('QUEUEDMSG'), `the plan carries both texts. Got: ${plan.combinedText}`);
      const heldRec = (await listPendingDispatches()).find(r => r.updateId === 2);
      assert.equal(heldRec?.heldForTopic, true, `the follower record must be under the crash-window hold. Rec: ${JSON.stringify(heldRec)}`);
      assert.ok(heldRec?.heldAt && !Number.isNaN(Date.parse(heldRec.heldAt)), 'heldAt is a valid ISO timestamp');
    } finally {
      process.env.PA_HOME = tempDir;
      _resetPendingDispatchesForTest();
      _clearQueueForTest();
      _clearHeldForTest();
      await rm(unitDir, { recursive: true, force: true }).catch(() => {});
    }

    // --- E2E half: warmup holds the topic → msg1+msg2 arrive (msg2 genuinely
    // QUEUED behind the in-flight turn) → the fold consumes it → /stop mid-turn
    // holds the whole combined text → the next dispatch recovers it.
    const controller = new AbortController();
    const state = makeState(123, -1);

    const warmupMsg = { update_id: 9, message: { message_id: 100, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'WARMUP_RECOVERY_900' } };
    const msg1 = { update_id: 1, message: { message_id: 101, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'FIRSTMSG' } };
    const msg2 = { update_id: 2, message: { message_id: 102, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'QUEUEDMSG' } };
    const stopMsg = { update_id: 3, message: { message_id: 103, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: '/stop' } };
    const afterStopMsg = { update_id: 4, message: { message_id: 104, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'AFTERSTOPMSG_904' } };

    const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const empty = { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
    const okTrue = { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    const asBatch = (updates: unknown[]) => {
      const batch = { ok: true, result: updates };
      return { ok: true, status: 200, text: async () => JSON.stringify(batch), json: async () => batch };
    };
    const capturedBlock = (needle: string): string | undefined => {
      try {
        return readFileSync(capturePath, 'utf8').split('GOTPROMPTEND').find((b) => b.includes(needle));
      } catch {
        return undefined;
      }
    };

    let delivered = 0;
    let stashed: PendingDispatch[] | undefined;
    let dispatchStartedAt = 0;
    let stopReplySeen = false;
    const sentTexts: string[] = [];
    const startedAt = Date.now();
    const SCENARIO_DEADLINE_MS = 30000;
    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
      const u = url as string;
      if (u.includes('getUpdates')) {
        if (Date.now() - startedAt > SCENARIO_DEADLINE_MS) {
          controller.abort();
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
        }
        // Poll the REAL store: the combined head's record materializes with the
        // combined userText + foldedFrom while its worker holds 2500ms, so this
        // is the mid-turn crash-window snapshot. Once observed it is frozen.
        if (delivered >= 2 && !stashed) {
          const records = await listPendingDispatches();
          const headRec = records.find(r => r.updateId === 1);
          if (headRec?.foldedFrom?.length) stashed = records;
        }
        if (delivered === 0) {
          delivered = 1;
          return asBatch([warmupMsg]);
        }
        if (delivered === 1 && capturedBlock('WARMUP_RECOVERY_900')) {
          delivered = 2;
          return asBatch([msg1, msg2]);
        }
        if (delivered === 2 && stashed && dispatchStartedAt > 0
            && Date.now() - dispatchStartedAt >= 600 && existsSync(startedFlag)) {
          // The fold is proven; /stop must now hit the LIVE combined turn.
          delivered = 3;
          return asBatch([stopMsg]);
        }
        if (delivered === 3 && stopReplySeen) {
          delivered = 4;
          return asBatch([afterStopMsg]);
        }
        if (capturedBlock('AFTERSTOPMSG_904')) {
          controller.abort();
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
        }
        await realSleep(20);
        return empty;
      }
      if (u.includes('sendChatAction')) {
        dispatchStartedAt = Date.now();
        return okTrue;
      }
      if (u.includes('sendMessage')) {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.text) {
          sentTexts.push(String(body.text));
          if (String(body.text).includes('Stopped')) stopReplySeen = true;
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 900 } }), json: async () => ({ ok: true, result: { message_id: 900 } }) };
      }
      return okTrue;
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    // §2.4 "Materialize → reply delivered": mid-turn the follower record is
    // CONSUMED and the head record ALONE recovers the whole batch.
    assert.ok(stashed, `the combined turn must have been observed mid-turn (worker holds 2500ms on a [Batched: prompt). Deadline exceeded after ${Date.now() - startedAt}ms`);
    const rec2 = stashed!.find(r => r.updateId === 2);
    assert.ok(!rec2, `the folded follower's record must be CONSUMED at proven materialization. Store: ${JSON.stringify(stashed!.map(r => ({ updateId: r.updateId, userText: r.userText.slice(0, 80), heldForTopic: r.heldForTopic })))}`);
    const headRec = stashed!.find(r => r.updateId === 1);
    assert.ok(headRec, `the head record must be live mid-turn. Store updateIds: ${JSON.stringify(stashed!.map(r => r.updateId))}`);
    assert.ok(headRec.userText.includes('[Batched: 2 messages, in the order they were sent]'), `the head record carries the combined prompt. Got: ${headRec.userText}`);
    assert.ok(headRec.userText.includes('FIRSTMSG') && headRec.userText.includes('QUEUEDMSG'), `the fold is recoverable via the head record alone (both texts present). Got: ${headRec.userText}`);
    assert.deepEqual(headRec.foldedFrom, [{ updateId: 2, messageId: 102 }], `the head carries foldedFrom provenance. Got: ${JSON.stringify(headRec.foldedFrom)}`);
    assert.ok(!headRec.heldForTopic, 'the head is a live dispatch record, not a held one');

    // The REAL combined prompt the worker received (frozen header + both texts
    // in send order — a fold without its header is a silent-fold defect).
    const combinedBlock = capturedBlock('[Batched:');
    assert.ok(combinedBlock, `a combined prompt must have been captured. Capture: ${capturePath}`);
    const combinedPrompt = combinedBlock!.slice(combinedBlock!.indexOf('GOTPROMPTSTART') + 'GOTPROMPTSTART'.length);
    assert.ok(combinedPrompt.includes('FIRSTMSG') && combinedPrompt.includes('QUEUEDMSG'), `both texts reached the combined prompt. Prompt: ${combinedPrompt}`);
    assert.ok(combinedPrompt.indexOf('FIRSTMSG') < combinedPrompt.indexOf('QUEUEDMSG'), `send order preserved. Prompt: ${combinedPrompt}`);
    assert.equal(combinedPrompt.split('[msg ').length - 1, 2, `exactly two [msg <id>] labels. Prompt: ${combinedPrompt}`);

    // The /stop leg: it hit the LIVE combined turn, so the WHOLE combined text
    // was held and the next dispatch recovered the ENTIRE batch — QUEUEDMSG
    // arrives inside the absorbed held text, never as a separate lane.
    assert.ok(stopReplySeen, `the /stop produced its local reply. Sent: ${JSON.stringify(sentTexts)}`);
    const afterStopBlock = capturedBlock('AFTERSTOPMSG_904');
    assert.ok(afterStopBlock, `the post-stop dispatch must have been captured. Capture: ${capturePath}`);
    const afterStopPrompt = afterStopBlock!.slice(afterStopBlock!.indexOf('GOTPROMPTSTART') + 'GOTPROMPTSTART'.length);
    assert.ok(afterStopPrompt.includes('AFTERSTOPMSG_904'), `the post-stop message dispatched. Prompt: ${afterStopPrompt}`);
    assert.ok(afterStopPrompt.includes('FIRSTMSG') && afterStopPrompt.includes('QUEUEDMSG'), `the stop held the WHOLE combined text — the next dispatch recovers the whole batch. Prompt: ${afterStopPrompt}`);

    // Nothing left re-dispatchable: both turns were delivered, so neither
    // record survives in the store.
    let finalRecs = await listPendingDispatches();
    for (let i = 0; i < 50 && finalRecs.some(r => r.updateId === 1 || r.updateId === 2); i++) {
      await realSleep(100);
      finalRecs = await listPendingDispatches();
    }
    assert.ok(!finalRecs.some(r => r.updateId === 1 || r.updateId === 2), `nothing may remain re-dispatchable. Store: ${JSON.stringify(finalRecs.map(r => ({ updateId: r.updateId, userText: r.userText.slice(0, 80), heldForTopic: r.heldForTopic })))}`);
  });

  it('next dispatch in the topic absorbs held records into its prompt', async () => {
    // The worker captures the prompt it receives to a file — the worker reply
    // itself takes the rich-message path, which the fetch mock does not record.
    const capturePath = join(tempDir, 'prompt-capture.txt');
    const workerScript = join(tempDir, 'echo-worker.cjs');
    await writeFile(workerScript, [
      "const fs = require('node:fs');",
      "let d = '';",
      "process.stdin.on('data', c => { d += c; });",
      "process.stdin.on('end', () => {",
      `  fs.appendFileSync(${JSON.stringify(capturePath)}, 'GOTPROMPTSTART' + d + 'GOTPROMPTEND');`,
      "  process.exit(0);",
      '});',
    ].join('\n'), 'utf8');

    const posixWorker = workerScript.replace(/\\/g, '/');
    await writeFile(join(tempDir, 'config.yaml'), `
workers:
  - name: claude
    input_mode: stdin-text
    command: node
    args: ["${posixWorker}"]
    check: node -e "process.exit(0)"
topic_defaults:
  "123_0": "claude"
`, 'utf8');

    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    await writeFile(topicStateFile, JSON.stringify({ chat_id: 123, thread_id: 0, turns: [] }), 'utf8');

    // Seed a held pending-dispatch record on disk
    await addPendingDispatch({
      updateId: 10,
      chatId: 123,
      threadId: 0,
      messageId: 10,
      userText: 'HELD_RECOVERY_TRANSCRIPT',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      heldForTopic: true,
      heldAt: new Date().toISOString(),
    });

    const controller = new AbortController();
    const state = makeState(123, -1);
    const freshMsg = { update_id: 11, message: { message_id: 11, chat: { id: 123, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'FRESH_USER_MESSAGE' } };

    let getUpdatesCallCount = 0;
    const sentTexts: string[] = [];

    (globalThis as Record<string, unknown>).fetch = async (url: string, opts?: { body?: string }) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          const batch = { ok: true, result: [freshMsg] };
          return { ok: true, status: 200, text: async () => JSON.stringify(batch), json: async () => batch };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if ((url as string).includes('sendMessage')) {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.text) sentTexts.push(body.text);
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 999 } }), json: async () => ({ ok: true, result: { message_id: 999 } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: true }), json: async () => ({ ok: true, result: true }) };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(capturePath, 'utf8');
    const start = raw.lastIndexOf('GOTPROMPTSTART');
    const end = raw.lastIndexOf('GOTPROMPTEND');
    assert.ok(start !== -1 && end !== -1, `worker must have dispatched. Capture: ${raw}`);
    const combinedReply = raw.slice(start + 'GOTPROMPTSTART'.length, end);
    assert.ok(combinedReply.includes('HELD_RECOVERY_TRANSCRIPT'), 'prompt must absorb held record userText');
    assert.ok(combinedReply.includes('FRESH_USER_MESSAGE'), 'prompt must include fresh user message');

    const records = await listPendingDispatches();
    const rec10 = records.find(r => r.updateId === 10);
    assert.ok(rec10, 'record 10 should still be in store');
    assert.equal(rec10.heldForTopic, false, 'held record must be marked heldForTopic: false once absorbed');
  });

  it('startup reaper treats heldForTopic as held, not dead (no death notice)', async () => {
    const rec: PendingDispatch = {
      updateId: 77,
      chatId: -100555,
      threadId: 9,
      messageId: 777,
      userText: 'held note without session',
      startedAt: new Date(Date.now() - 60000).toISOString(),
      session: undefined,
      heldForTopic: true,
      heldAt: new Date().toISOString(),
    };
    await addPendingDispatch(rec);

    const sent: Array<{ record: PendingDispatch; text: string }> = [];
    const requeued: PendingDispatch[] = [];
    const deps: ReaperDeps = {
      send: async (r, text) => {
        sent.push({ record: r, text });
        return true;
      },
      readTranscript: async () => null,
      isTopicWorkerAlive: async () => false,
      now: () => Date.now(),
    };
    (deps as any).requeueUpdate = (r: PendingDispatch) => requeued.push(r);

    await reapOrphanedDispatches('test-token', {
      deps,
      maxWaitMs: 50,
      pollMs: 10,
    });

    assert.equal(sent.length, 0, 'heldForTopic record must produce no death notice');
    assert.equal(requeued.length, 0, 'heldForTopic record must produce no requeue');

    const listed = await listPendingDispatches();
    const found = listed.find(r => r.updateId === 77);
    assert.ok(found, 'record must remain on disk');
    assert.equal(found.heldForTopic, true, 'record must remain heldForTopic: true');
  });
});
