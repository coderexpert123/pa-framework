/**
 * Integration tests for at-least-once delivery and session carry-off.
 *
 * Unlike unit tests (which use wrong chat_id to bypass processUpdate internals),
 * these tests use an allowed chat_id so processUpdate runs the full path:
 * security check → loadTopicState → addTurn → reaction → typing → dispatchMessage
 * (fails gracefully — no CLI) → error response → sendMessage → saveTopicState.
 *
 * This exercises the cross-cutting flow: runPollLoop → processUpdate →
 * saveTopicState + saveState working together.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runPollLoop } from '../main.js';
import { loadTopicState, saveTopicState, loadState } from '../conversation.js';
import type { ConversationState, SessionInfo } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fastSleep = async (_ms: number): Promise<void> => {};

function makeUpdate(updateId: number, chatId: number, text: string, threadId?: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: threadId ? 'supergroup' : 'private' },
      ...(threadId ? { message_thread_id: threadId } : {}),
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

/**
 * URL-routing fetch mock. Routes by Telegram method name in the URL so it
 * handles concurrent calls (reaction + typing + sendMessage) without caring
 * about sequence order.
 *
 * Returns a restore function and a calls log.
 */
function setupFlexibleFetch(
  controller: AbortController,
  batches: object[][]   // each entry is one poll's result; last batch triggers abort
): { calls: string[]; restore: () => void } {
  const savedFetch = globalThis.fetch;
  const calls: string[] = [];
  let batchIndex = 0;

  (globalThis as Record<string, unknown>).fetch = async (url: string) => {
    const u = url as string;
    calls.push(u);

    if (u.includes('getUpdates')) {
      const result = batches[batchIndex] ?? [];
      if (batchIndex >= batches.length - 1) controller.abort();
      batchIndex++;
      return ok({ ok: true, result });
    }

    if (u.includes('sendMessage')) {
      return ok({ ok: true, result: { message_id: 999 } });
    }

    // setMessageReaction, sendTyping, setChatAction, etc.
    return ok({ ok: true, result: true });
  };

  return {
    calls,
    restore: () => { (globalThis as Record<string, unknown>).fetch = savedFetch; },
  };
}

function ok(json: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(json),
    json: async () => json,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('integration: at-least-once delivery', { concurrency: 1 }, () => {
  let tempDir: string;
  let restore: (() => void) | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-integ-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    restore?.();
    restore = undefined;
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('processes allowed-chat message end-to-end: user turn saved, offset advanced', async () => {
    // Verifies the full processUpdate path runs and both state files are written.
    // dispatchMessage fails (no CLI in test env) — caught gracefully, error response sent.
    const chatId = 456;
    const controller = new AbortController();
    ({ restore } = setupFlexibleFetch(controller, [
      [makeUpdate(10, chatId, 'hello world')],  // first poll
      [],                                        // second poll → abort
    ]));

    const state: ConversationState = { chat_id: chatId, last_update_id: -1, thread_id: 0, turns: [] };
    await runPollLoop('token', [chatId], state, {}, controller.signal, fastSleep);

    // Global state: offset must have advanced to 10
    const global = await loadState(chatId);
    assert.equal(global.last_update_id, 10, 'offset must advance after full processing cycle');

    // Topic state: user turn must be saved
    const topic = await loadTopicState(chatId, 0);
    assert.ok(topic.turns.length >= 1, 'topic state must have at least the user turn');
    assert.equal(topic.turns[0].role, 'user');
    assert.equal(topic.turns[0].text, 'hello world');
  });

  it('re-delivers message after crash: full cycle completes on retry', async () => {
    // Simulates: bot received update 10, crashed before ack (last_update_id stayed at -1).
    // On restart, Telegram re-delivers update 10 — it must be fully processed and ack'd.
    //
    // Note: this tests re-delivery semantics (offset not advanced → Telegram re-sends),
    // not mid-write file corruption. The "crash" is modelled by resetting last_update_id
    // to -1 on the second run — equivalent to the bot restarting with no saved offset.
    const chatId = 456;

    // Run "crashed instance": processes update 10, saves topic state, advances offset.
    // (This represents the state the system is in: the message was processed but we
    //  pretend the ack was lost by manually resetting last_update_id below.)
    const controller1 = new AbortController();
    ({ restore } = setupFlexibleFetch(controller1, [
      [makeUpdate(10, chatId, 'first send')],
      [],
    ]));
    const state1: ConversationState = { chat_id: chatId, last_update_id: -1, thread_id: 0, turns: [] };
    await runPollLoop('token', [chatId], state1, {}, controller1.signal, fastSleep);
    restore();

    const topicAfterCrash = await loadTopicState(chatId, 0);
    const turnCountAfterCrash = topicAfterCrash.turns.length;
    assert.ok(turnCountAfterCrash >= 1, 'first processing must have saved turns');

    // Simulate crash before ack: start fresh state with last_update_id=-1
    const controller2 = new AbortController();
    ({ restore } = setupFlexibleFetch(controller2, [
      [makeUpdate(10, chatId, 'first send')],  // same update re-delivered
      [],
    ]));
    const state2: ConversationState = { chat_id: chatId, last_update_id: -1, thread_id: 0, turns: [] };
    await runPollLoop('token', [chatId], state2, {}, controller2.signal, fastSleep);

    // After retry: offset must be advanced
    const globalAfterRetry = await loadState(chatId);
    assert.equal(globalAfterRetry.last_update_id, 10, 'offset must advance after retry');

    // Topic state: the re-delivered message was processed — more turns than before
    const topicAfterRetry = await loadTopicState(chatId, 0);
    assert.ok(
      topicAfterRetry.turns.length > turnCountAfterCrash,
      'retry must add another round of turns to topic state'
    );
  });

  it('concurrent updates in same batch: both processed, offset advances to batch max', async () => {
    // Two updates for different topics arrive in the same batch. Both must be
    // processed concurrently (blackboard handles serialization per-topic), and
    // the offset must advance to the max of the batch (update_id 11).
    const chatId = 456;
    const controller = new AbortController();
    ({ restore } = setupFlexibleFetch(controller, [
      [
        makeUpdate(10, chatId, 'topic 0 message'),          // thread 0
        makeUpdate(11, chatId, 'topic 2 message', 2),       // thread 2
      ],
      [],
    ]));

    const state: ConversationState = { chat_id: chatId, last_update_id: -1, thread_id: 0, turns: [] };
    await runPollLoop('token', [chatId], state, {}, controller.signal, fastSleep);

    // Offset must advance to 11 (batch max), not 10
    const global = await loadState(chatId);
    assert.equal(global.last_update_id, 11, 'offset must advance to batch max (11)');

    // Both topics must have user turns saved
    const topic0 = await loadTopicState(chatId, 0);
    const topic2 = await loadTopicState(chatId, 2);
    assert.ok(topic0.turns.some(t => t.text === 'topic 0 message'), 'topic 0 must have its turn');
    assert.ok(topic2.turns.some(t => t.text === 'topic 2 message'), 'topic 2 must have its turn');
  });

  it('session preserved in topic state after failed dispatch (carry-off building block)', async () => {
    // If a session exists from a previous message and the current dispatch fails,
    // the pre-existing session must survive in topic state. On the next retry, this
    // session will be used for --resume, carrying off from the prior worker context.
    const chatId = 456;
    const threadId = 5;

    // Pre-populate topic state with a session from a previous successful message
    const existingSession: SessionInfo = {
      session_id: 'carry-off-session-xyz',
      worker: 'gemini',
      started_at: new Date().toISOString(),
    };
    const existing = await loadTopicState(chatId, threadId);
    existing.session = existingSession;
    await saveTopicState(existing);

    // Run bot: new message in the same topic — dispatch will fail (no CLI)
    const controller = new AbortController();
    const update = makeUpdate(20, chatId, 'follow-up', threadId);
    ({ restore } = setupFlexibleFetch(controller, [[update], []]));

    const state: ConversationState = { chat_id: chatId, last_update_id: -1, thread_id: 0, turns: [] };
    await runPollLoop('token', [chatId], state, {}, controller.signal, fastSleep);

    // Session must survive — not wiped by the failed dispatch
    const topicAfter = await loadTopicState(chatId, threadId);
    assert.equal(
      topicAfter.session?.session_id,
      'carry-off-session-xyz',
      'pre-existing session must be preserved after failed dispatch'
    );
    // User turn must also be saved
    assert.ok(
      topicAfter.turns.some(t => t.role === 'user' && t.text === 'follow-up'),
      'user turn must be saved despite failed dispatch'
    );
  });
});
