// steer-exec.test.ts — WP-4 (router-as-orchestrator 2026-09-19, spec §4.2/§4.3).
//
// Covers the EXTRACTED /steer mechanics (executeSteer) and the router-steer
// path's fold (materializeSteerPrompt), plus the §4.3 per-turn double-fire
// guard map. The /steer regression trio (steer-text-safety / steer-voice-fold
// / steer-voice-recovery) drives the SAME code end-to-end through
// runPollLoop and proves the extraction changed no behavior; this file pins
// the unit contracts both call sites depend on:
//   - the kill goes through the PID-captured stopTopicWorkers seam (chatId +
//     threadId coordinates resolved against the worker-pids registry — never
//     an image-name kill; if a future edit kills by name, the seam call
//     count below drops to 0 and these tests fail);
//   - the router-steer fold composes held + drained + prompt with the SAME
//     '\n\n' join rule the /steer text-only path applies to the message text;
//   - the guard drops only the SAME turn's steered thread ids.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  executeSteer,
  materializeSteerPrompt,
  markRouterSteered,
  takeRouterSteered,
  STEER_ALREADY_ROUTED_FOOTER,
  _clearRouterSteerGuardForTest,
} from '../steer-exec.js';
import { registerQueuedUpdate, addHeldEntry, _clearQueueForTest, _clearHeldForTest } from '../topic-queue.js';
import { isTopicStopped, _clearStoppedForTest } from '../worker-stop.js';
import { addPendingDispatch, listPendingDispatches, _resetPendingDispatchesForTest } from '../pending-dispatches.js';
import { _clearPrefetchForTest } from '../voice-prefetch.js';
import { waitForDrain } from './test-teardown-guard.js';
import type { SteerFoldContext } from '../topic-queue.js';

const TOPIC_KEY = '123_0';
const PREFETCH_DEPS = { repoRoot: '/tmp', env: {} as NodeJS.ProcessEnv };

function makeCtx(drained: Array<{ updateId: number; text: string }>, steerPrompt?: string): SteerFoldContext {
  return {
    drainedEntries: drained.map((d) => ({
      updateId: d.updateId,
      text: d.text,
      isCommand: false,
      cancelled: false,
    })),
    drained: drained.map((d) => ({ updateId: d.updateId, textPromise: Promise.resolve(d.text) })),
    ...(steerPrompt !== undefined ? { steerPrompt } : {}),
  };
}

describe('steer-exec (WP-4: router-as-orchestrator §4.2/§4.3)', { concurrency: 1 }, () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-steer-exec-'));
    process.env.PA_HOME = tempDir;
    _resetPendingDispatchesForTest();
    _clearQueueForTest();
    _clearHeldForTest();
    _clearStoppedForTest();
    _clearPrefetchForTest();
    _clearRouterSteerGuardForTest();
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    _resetPendingDispatchesForTest();
    _clearQueueForTest();
    _clearHeldForTest();
    _clearStoppedForTest();
    _clearPrefetchForTest();
    _clearRouterSteerGuardForTest();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('executeSteer — router-steer path (no message)', () => {
    it('kills via the PID-captured seam, drains queued entries, marks the topic stopped scoped to OLDER updates', async () => {
      registerQueuedUpdate(TOPIC_KEY, 11, 'queued one');
      registerQueuedUpdate(TOPIC_KEY, 12, 'queued two');
      const stopCalls: Array<[number, number]> = [];
      const outcome = await executeSteer({
        topicKey: TOPIC_KEY,
        chatId: 123,
        threadId: 0,
        updateId: 100,
        steerPrompt: 'the correction text',
        prefetchDeps: PREFETCH_DEPS,
        token: 'token',
        stopTopicWorkersFn: async (chatId, threadId) => { stopCalls.push([chatId, threadId]); return 1; },
      });
      // PID-captured kill seam: exactly one stop call, topic coordinates only.
      assert.deepEqual(stopCalls, [[123, 0]]);
      // Drain picked up both queued entries in arrival order.
      assert.deepEqual(outcome.steerContext.drained.map((d) => d.updateId), [11, 12]);
      assert.deepEqual(await Promise.all(outcome.steerContext.drained.map((d) => d.textPromise)), ['queued one', 'queued two']);
      assert.equal(outcome.steerContext.steerPrompt, 'the correction text');
      // The stop marker scopes to dispatches OLDER than the steering update.
      assert.equal(isTopicStopped(TOPIC_KEY, 99), true, 'the killed in-flight run must be suppressed');
      assert.equal(isTopicStopped(TOPIC_KEY, 100), false, 'the current turn itself must NOT be suppressed');
      assert.equal(isTopicStopped(TOPIC_KEY, 101), false);
      // Nothing was sent: the kill succeeded.
      void outcome;
    });

    it('sends the truthful "nothing was running" notice on a 0-kill, replying to the steering message', async () => {
      const sends: Array<{ text: string; replyTo?: number }> = [];
      await executeSteer({
        topicKey: TOPIC_KEY,
        chatId: 123,
        threadId: 0,
        updateId: 100,
        messageId: 555,
        steerPrompt: 'the correction text',
        prefetchDeps: PREFETCH_DEPS,
        token: 'token',
        stopTopicWorkersFn: async () => 0,
        sendMessageFn: async (_t, _c, text, replyToMessageId) => {
          sends.push({ text, replyTo: replyToMessageId });
          return true;
        },
      });
      assert.equal(sends.length, 1);
      // appendRefIdAndLog runs BEFORE the injected send seam (same as prod):
      // the text is the notice + the mandatory ref-ID footer.
      assert.ok(
        sends[0].text.startsWith('Nothing was running — dispatching your prompt as a new message.'),
        `unexpected notice text: ${sends[0].text}`,
      );
      assert.match(sends[0].text, /_Ref: s-[0-9a-f]{12}_/);
      assert.equal(sends[0].replyTo, 555);
    });

    it('never touches the side map or the message text on the router path (fold is the caller\'s)', async () => {
      registerQueuedUpdate(TOPIC_KEY, 11, 'queued one');
      const sideMap = new Map<number, SteerFoldContext>();
      const outcome = await executeSteer({
        topicKey: TOPIC_KEY,
        chatId: 123,
        threadId: 0,
        updateId: 100,
        steerPrompt: 'the correction text',
        prefetchDeps: PREFETCH_DEPS,
        token: 'token',
        steerContexts: sideMap,
        stopTopicWorkersFn: async () => 1,
      });
      assert.equal(sideMap.size, 0, 'no msg passed — the /steer handoff must not run');
      assert.equal(outcome.steerContext.drained.length, 1);
    });
  });

  describe('executeSteer — /steer path (deferred handoff)', () => {
    it('text-only steer: rewrites the message text to drained+prompt and stores the context in the side map', async () => {
      registerQueuedUpdate(TOPIC_KEY, 11, 'queued one');
      registerQueuedUpdate(TOPIC_KEY, 12, 'queued two');
      const sideMap = new Map<number, SteerFoldContext>();
      const msg: { text?: string; caption?: string } = { text: '/steer fix it' };
      await executeSteer({
        topicKey: TOPIC_KEY,
        chatId: 123,
        threadId: 0,
        updateId: 100,
        steerPrompt: 'fix it',
        msg: msg as never,
        inFlight: new Set(),
        steerContexts: sideMap,
        prefetchDeps: PREFETCH_DEPS,
        token: 'token',
        stopTopicWorkersFn: async () => 1,
      });
      assert.equal(msg.text, 'queued one\n\nqueued two\n\nfix it');
      const ctx = sideMap.get(100);
      assert.ok(ctx, 'steerContext stored for the enqueue normalizer');
      assert.equal(ctx.drained.length, 2);
      assert.equal(ctx.steerPrompt, 'fix it');
    });

    it('bare /steer (no prompt) with an empty drain: text-only concat of nothing (verbatim pre-extraction behavior)', async () => {
      const sideMap = new Map<number, SteerFoldContext>();
      const msg: { text?: string; caption?: string } = { text: '/steer' };
      const outcome = await executeSteer({
        topicKey: TOPIC_KEY,
        chatId: 123,
        threadId: 0,
        updateId: 100,
        msg: msg as never,
        inFlight: new Set(),
        steerContexts: sideMap,
        prefetchDeps: PREFETCH_DEPS,
        token: 'token',
        stopTopicWorkersFn: async () => 1,
      });
      assert.equal(outcome.hasVoice, false);
      assert.equal(msg.text, '', 'text-only bare steer: parts.join of an empty drain');
      const ctx = sideMap.get(100);
      assert.ok(ctx);
      assert.equal(ctx.steerPrompt, undefined);
      // The VOICE branch (hasVoice keeps the original text — AI-208) is pinned
      // end-to-end by steer-voice-fold.test.ts through runPollLoop.
    });
  });

  describe('materializeSteerPrompt — the router-steer fold', () => {
    it('composes held + drained + prompt with the same join rule as the /steer text path', async () => {
      addHeldEntry(TOPIC_KEY, { text: 'held text', updateId: 99 });
      const mat = await materializeSteerPrompt(
        makeCtx([{ updateId: 11, text: 'drained one' }, { updateId: 12, text: 'drained two' }], 'the correction text'),
        TOPIC_KEY, 123, 0,
      );
      assert.equal(mat.text, 'held text\n\ndrained one\n\ndrained two\n\nthe correction text');
      assert.deepEqual(mat.foldedVoice, []);
    });

    it('voice-bearing drained entries become foldedVoice with the pending record\'s messageId', async () => {
      await addPendingDispatch({
        chatId: 123, threadId: 0, updateId: 11,
        userText: 'placeholder', userTextSettled: false, placeholderText: 'placeholder',
        delivered: false, createdAt: new Date().toISOString(), messageId: 42,
      } as never);
      const ctx = makeCtx([{ updateId: 11, text: 'transcribed words' }], 'the correction text');
      (ctx.drainedEntries[0] as { voice?: unknown }).voice = {
        media: { file_unique_id: 'fx1' },
        kind: 'voice',
      };
      const mat = await materializeSteerPrompt(ctx, TOPIC_KEY, 123, 0);
      assert.equal(mat.text, 'transcribed words\n\nthe correction text');
      assert.equal(mat.foldedVoice.length, 1);
      assert.equal(mat.foldedVoice[0].text, 'transcribed words');
      assert.equal(mat.foldedVoice[0].messageId, 42);
    });

    it('consumes drained records at proven delivery (M1 rule 3)', async () => {
      await addPendingDispatch({
        chatId: 123, threadId: 0, updateId: 11,
        userText: 'drained one', userTextSettled: true, placeholderText: 'placeholder',
        delivered: false, createdAt: new Date().toISOString(),
      } as never);
      await materializeSteerPrompt(makeCtx([{ updateId: 11, text: 'drained one' }], 'fix'), TOPIC_KEY, 123, 0);
      const remaining = await listPendingDispatches();
      assert.equal(remaining.find((r) => r.updateId === 11), undefined, 'drained record must not be re-absorbed');
    });
  });

  describe('§4.3 double-fire guard', () => {
    it('drops the SAME turn\'s steered thread and passes a different-thread steer', () => {
      markRouterSteered(TOPIC_KEY, 100, ['t-7']);
      const sameTurn = takeRouterSteered(TOPIC_KEY, 100);
      assert.ok(sameTurn, 'guard written by the router-steer path');
      assert.ok(sameTurn.has('t-7'), 'the steered target is dropped');
      assert.equal(takeRouterSteered(TOPIC_KEY, 100), undefined, 'read-and-clear — per-turn lifetime');
      assert.equal(takeRouterSteered(TOPIC_KEY, 101), undefined, 'a different turn was never guarded');
      // A different thread id on the same turn passes (guard holds only t-7).
      markRouterSteered(TOPIC_KEY, 102, ['t-9']);
      const turn = takeRouterSteered(TOPIC_KEY, 102);
      assert.ok(turn);
      assert.equal(turn.has('t-7'), false, 'different-thread steers pass the guard');
      assert.equal(turn.has('t-9'), true);
    });

    it('freezes the §4.3 footer byte-exactly', () => {
      assert.equal(STEER_ALREADY_ROUTED_FOOTER, '\n\n_(steer already applied by routing)_');
    });
  });
});
