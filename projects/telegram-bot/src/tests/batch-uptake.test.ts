/**
 * batch-uptake.test.ts — AI-209 WP-2 (2026-09-06).
 *
 * Drives the REAL compileBatchFold over the REAL queue primitives
 * (topic-queue.ts) and the REAL pending-dispatch store, under a temp PA_HOME
 * (the steer-voice-fold.test.ts harness pattern). No runPollLoop here — the
 * seam wiring is WP-3's. Warn-log assertions read the JSONL the real logger
 * wrote under the temp PA_HOME (batch-uptake.ts takes no injectable logger).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  registerQueuedUpdate,
  peekQueuedBatch,
  _clearQueueForTest,
} from '../topic-queue.js';
import type { VoiceResult } from '../voice.js';
import {
  addPendingDispatch,
  listPendingDispatches,
  pendingDispatchKey,
  _resetPendingDispatchesForTest,
} from '../pending-dispatches.js';
import { flushLog } from '../../../../pa/dist/src/lib/log.js';
import { waitForDrain } from './test-teardown-guard.js';
import { compileBatchFold } from '../batch-uptake.js';

const TOPIC = '123_0';
const CHAT_ID = 123;
const THREAD_ID = 0;

interface LogRow {
  timestamp: string;
  level: string;
  module: string;
  message: string;
  [k: string]: unknown;
}

async function readLogRows(tempDir: string): Promise<LogRow[]> {
  let raw = '';
  try {
    raw = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as LogRow;
      } catch {
        return null;
      }
    })
    .filter((r): r is LogRow => r !== null);
}

function okVoice(text: string): Extract<VoiceResult, { ok: true }> {
  return {
    ok: true,
    text,
    engine: 'whisper_local',
    mode: 'spawn',
    audioPath: '/fake/batch.oga',
    elapsedMs: 10,
    truncated: false,
  };
}

function makeInput(headOverrides: Partial<{ updateId: number; messageId: number; text: string }> = {}) {
  return {
    topicKey: TOPIC,
    chatId: CHAT_ID,
    threadId: THREAD_ID,
    head: { updateId: 1, messageId: 11, text: 'a', ...headOverrides },
  };
}

describe('batch-uptake (AI-209 WP-2)', { concurrency: 1 }, () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-batch-uptake-'));
    process.env.PA_HOME = tempDir;
    _resetPendingDispatchesForTest();
    _clearQueueForTest();
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    _resetPendingDispatchesForTest();
    _clearQueueForTest();
  });

  it('T1: empty peeked run ⇒ null, queue untouched', async () => {
    // Case 1 — nothing queued at all.
    assert.equal(await compileBatchFold(makeInput()), null);

    // Case 2 — a queued COMMAND bounds the peek to an empty run; it must stay
    // queued and un-cancelled (nothing mutated anywhere). peek never reports
    // commands, so the observable is: null plan, un-cancelled entry, and the
    // peek run still empty on re-peek.
    const cmd = registerQueuedUpdate(TOPIC, 9, '/status', undefined, 99);
    assert.equal(await compileBatchFold(makeInput()), null);
    assert.equal(cmd.cancelled, false);
    assert.deepEqual(peekQueuedBatch(TOPIC).map((e) => e.updateId), [],
      'the command still bounds the run after a no-op compile');
  });

  it('T2: two-entry fold — header, blocks, foldedFrom in send order', async () => {
    registerQueuedUpdate(TOPIC, 2, 'b', undefined, 12);

    const plan = await compileBatchFold(makeInput());
    assert.ok(plan, 'plan must exist for head + one follower');
    const expected = '[Batched: 2 messages, in the order they were sent]\n\n[msg 11]\na\n\n[msg 12]\nb';
    assert.ok(plan.combinedText.startsWith('[Batched: 2 messages, in the order they were sent]'));
    assert.equal(plan.combinedText, expected);
    assert.deepEqual(plan.blocks, [
      { updateId: 1, messageId: 11, text: 'a' },
      { updateId: 2, messageId: 12, text: 'b' },
    ]);
    assert.deepEqual(plan.foldedFrom, [{ updateId: 2, messageId: 12 }]);
    assert.deepEqual(plan.withheldIds, []);
    // Confirm consumed the follower.
    assert.deepEqual(peekQueuedBatch(TOPIC).map((e) => e.updateId), []);
  });

  it('T3: slash-initial head (G4) ⇒ null, queue untouched', async () => {
    const follower = registerQueuedUpdate(TOPIC, 2, 'b', undefined, 12);

    const plan = await compileBatchFold(makeInput({ text: '/model agy' }));
    assert.equal(plan, null);
    assert.equal(follower.cancelled, false);
    assert.deepEqual(peekQueuedBatch(TOPIC).map((e) => e.updateId), [2]);
  });

  it('T4 (F7): command-initial follower withheld (W1) — real voice raw transcript + non-voice resolved text', async () => {
    // VOICE case (F7 amendment): the prefetch resolves ok to a raw "/status".
    // Its resolved text is the LABEL-WRAPPED "[Voice message] /status", which
    // must NOT be the anchor — the discriminator reads the raw transcript, so
    // the note is withheld either way. Registered with text '[Voice message]'
    // (non-command) exactly as main.ts enqueues it.
    const spoken = registerQueuedUpdate(TOPIC, 2, '[Voice message]', undefined, 12);
    spoken.voice = {
      promise: Promise.resolve(okVoice('/status')),
      descriptor: { kind: 'voice' },
      media: { file_id: 'wf', file_unique_id: 'wu', duration: 6 },
      kind: 'voice',
    };
    // NON-VOICE case: W1 anchors on the RESOLVED text, so the follower is
    // registered with isCommandOverride: false — a slash-initial enqueue text
    // would otherwise derive isCommand: true and bound the batch before the
    // partition ever sees it (that bound is WP-1's peek rule, not W1).
    const slash = registerQueuedUpdate(TOPIC, 3, '/reset', false, 13);
    const plain = registerQueuedUpdate(TOPIC, 4, 'c', undefined, 14);

    const plan = await compileBatchFold(makeInput());
    assert.ok(plan, 'the plain follower still folds, so a plan exists');
    assert.deepEqual(plan.withheldIds, [2, 3]);
    assert.deepEqual(plan.foldedFrom, [{ updateId: 4, messageId: 14 }]);
    assert.equal(plan.blocks.length, 2, 'head + one folded follower only');
    assert.ok(!plan.combinedText.includes('/status'), 'spoken command must not fold');
    assert.ok(!plan.combinedText.includes('Voice message'), 'label-wrapped form must not fold either');
    assert.ok(!plan.combinedText.includes('/reset'), 'non-voice slash text must not fold');
    assert.ok(plan.combinedText.includes('c'));
    // Withheld entries: still queued, NOT cancelled — they dispatch on their own turns.
    assert.equal(spoken.cancelled, false);
    assert.equal(slash.cancelled, false);
    assert.deepEqual(peekQueuedBatch(TOPIC).map((e) => e.updateId), [2, 3]);

    await flushLog();
    const rows = await readLogRows(tempDir);
    for (const id of [2, 3]) {
      const warn = rows.find((r) => r.level === 'warn' && r.module === 'batch-uptake'
        && r.message === 'withheld slash text from batch' && r.updateId === id);
      assert.ok(warn, `withheld slash text must warn-log for updateId ${id}`);
    }
  });

  it('T5: voice follower resolves through the prefetch promise and carries via batch', async () => {
    const entry = registerQueuedUpdate(TOPIC, 2, '[Voice message]', undefined, 12);
    entry.voice = {
      promise: Promise.resolve(okVoice('BATCH_VOICE_TRANSCRIPT')),
      descriptor: { kind: 'voice' },
      media: { file_id: 'bf', file_unique_id: 'bu', duration: 8 },
      kind: 'voice',
    };

    const plan = await compileBatchFold(makeInput());
    assert.ok(plan);
    assert.equal(plan.foldedVoice.length, 1);
    const [item] = plan.foldedVoice;
    assert.equal(item.via, 'batch');
    assert.equal(item.kind, 'voice');
    assert.deepEqual(item.media, { file_id: 'bf', file_unique_id: 'bu', duration: 8 });
    assert.equal(item.messageId, 12);
    assert.equal(item.text, '[Voice message] BATCH_VOICE_TRANSCRIPT',
      'folded text is the RESOLVED transcript, not the placeholder');
    assert.ok(plan.combinedText.includes('[msg 12]\n[Voice message] BATCH_VOICE_TRANSCRIPT'));
    assert.deepEqual(plan.foldedFrom, [{ updateId: 2, messageId: 12 }]);

    // F7 failure path: a REJECTED prefetch is never a command — its
    // failure-marker text folds exactly as the steer fold does.
    const failed = registerQueuedUpdate(TOPIC, 3, '[Voice message]', undefined, 13);
    failed.voice = {
      promise: Promise.reject(new Error('transcription engine failed')),
      descriptor: { kind: 'voice' },
      media: { file_id: 'ff', file_unique_id: 'fu2', duration: 4 },
      kind: 'voice',
    };
    const plan2 = await compileBatchFold(makeInput());
    assert.ok(plan2);
    assert.deepEqual(plan2.withheldIds, [], 'a failed prefetch must not be withheld as a command');
    assert.ok(plan2.foldedFrom.some((f) => f.updateId === 3), 'the failed note still folds');
    const failedText = plan2.blocks.find((b) => b.updateId === 3)!.text;
    assert.ok(failedText.includes('transcription failed'), `failure marker folded: ${failedText}`);
  });

  it('T6: crash-window hold — folded follower record flips to heldForTopic in the store', async () => {
    registerQueuedUpdate(TOPIC, 2, 'b', undefined, 12);
    await addPendingDispatch({
      updateId: 2,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      messageId: 12,
      userText: 'b',
      startedAt: new Date().toISOString(),
    });

    const plan = await compileBatchFold(makeInput());
    assert.ok(plan);

    const records = await listPendingDispatches();
    const rec = records.find((r) => r.updateId === 2 && r.chatId === CHAT_ID && r.threadId === THREAD_ID);
    assert.ok(rec, 'follower record must survive the compile');
    assert.equal(rec.heldForTopic, true);
    assert.ok(rec.heldAt, 'heldAt must be stamped');
    assert.equal(typeof new Date(rec.heldAt!).getTime(), 'number');
    assert.ok(Number.isFinite(new Date(rec.heldAt!).getTime()));
  });

  it('T7: single follower withheld ⇒ null — no confirm, no record write', async () => {
    // Non-command construction, same reason as T4 (W1 fires on resolved text).
    registerQueuedUpdate(TOPIC, 2, '/reset', false, 12);
    await addPendingDispatch({
      updateId: 2,
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      messageId: 12,
      userText: '/reset',
      startedAt: new Date().toISOString(),
    });

    const plan = await compileBatchFold(makeInput());
    assert.equal(plan, null, 'empty fold set ⇒ null');

    // No confirm: the entry is still queued and not cancelled.
    assert.deepEqual(peekQueuedBatch(TOPIC).map((e) => e.updateId), [2]);
    // No record write: the seeded record is untouched.
    const rec = (await listPendingDispatches()).find((r) => r.updateId === 2);
    assert.ok(rec);
    assert.equal(rec.heldForTopic, undefined);
    assert.equal(rec.heldAt, undefined);
  });

  it('T8: W2 — bare media placeholder withheld; captioned label folds as caption text', async () => {
    const bare = registerQueuedUpdate(TOPIC, 2, '[Photo]', undefined, 12);
    const captioned = registerQueuedUpdate(TOPIC, 3, '[Photo] look at this', undefined, 13);

    const plan = await compileBatchFold(makeInput());
    assert.ok(plan);
    assert.deepEqual(plan.withheldIds, [2]);
    assert.deepEqual(plan.foldedFrom, [{ updateId: 3, messageId: 13 }]);
    assert.equal(bare.cancelled, false, 'bare placeholder stays queued for its own turn');
    assert.ok(plan.combinedText.includes('[msg 13]\n[Photo] look at this'),
      'captioned label folds as its caption text');
    assert.ok(!plan.combinedText.includes('[msg 12]'), 'withheld entry must not appear');
  });

  it('T9: follower without messageId — block has no [msg line, foldedFrom carries updateId only', async () => {
    registerQueuedUpdate(TOPIC, 2, 'b');

    const plan = await compileBatchFold(makeInput());
    assert.ok(plan);
    const expected = '[Batched: 2 messages, in the order they were sent]\n\n[msg 11]\na\n\nb';
    assert.equal(plan.combinedText, expected, 'unlabelled block renders as bare text');
    assert.deepEqual(plan.foldedFrom, [{ updateId: 2 }]);
  });

  it('T-B1 (W4, AI-203 inc 3): a reply-shaped follower is withheld and stays queued for its own turn', async () => {
    const replyEntry = registerQueuedUpdate(TOPIC, 2, 'also check failures', undefined, 12, 41);
    const plain = registerQueuedUpdate(TOPIC, 3, 'plain follower', undefined, 13);

    const plan = await compileBatchFold(makeInput());
    assert.ok(plan, 'the plain follower still folds, so a plan exists');
    assert.deepEqual(plan.withheldIds, [2], 'the reply-shaped entry is withheld (W4)');
    assert.deepEqual(plan.foldedFrom, [{ updateId: 3, messageId: 13 }], 'the reply entry is NOT in the fold set');
    assert.ok(!plan.combinedText.includes('[msg 12]'), 'the reply text must not ride the combined text');
    assert.equal(replyEntry.cancelled, false, 'the reply entry stays queued, un-cancelled');
    assert.equal(plain.cancelled, true, 'the folded follower was confirmed');
    assert.deepEqual(
      peekQueuedBatch(TOPIC).map((e) => e.updateId),
      [2],
      'the reply-shaped entry STAYS queued per peekQueuedBatch after the compile'
    );
  });
});
