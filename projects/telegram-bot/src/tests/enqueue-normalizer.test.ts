/**
 * enqueue-normalizer.test.ts — AI-173 phase 4 (2026-09-06).
 *
 * Unit tests against the extracted enqueue normalizer. No runPollLoop
 * involved, so no _setExitForTest needed; every shape here starts NO
 * prefetch (a prefetch-bearing shape would hit real Telegram — the
 * prefetch-starting path is e2e-covered by the unchanged voice-poll-loop
 * witness). Spec: the AI-173 phase 4 design (2026-09-06, internal) §6.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { waitForDrain } from './test-teardown-guard.js';
import {
  enqueueUpdateForDispatch, settleVoicePrefetch, flushCheckAndAbsorbHeld,
  isAcceptableUpdate, placeholderDispatchText,
} from '../enqueue-normalizer.js';
import {
  _clearQueueForTest, _clearHeldForTest, addHeldEntry, absorbHeldEntries,
} from '../topic-queue.js';
import { markTopicStopped, _clearStoppedForTest } from '../worker-stop.js';
import { listPendingDispatches, _resetPendingDispatchesForTest, pendingDispatchKey } from '../pending-dispatches.js';
import type { QueueEntry } from '../topic-queue.js';
import type { VoiceResult } from '../voice.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'enqueue-normalizer-'));
  process.env.PA_HOME = tempDir;
});

afterEach(async () => {
  await waitForDrain();
  _clearQueueForTest();
  _clearHeldForTest();
  _clearStoppedForTest();
  _resetPendingDispatchesForTest();
  delete process.env.PA_HOME;
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

const CHAT_ID = -1001234;
const THREAD_ID = 7;
const KEY = `${CHAT_ID}_${THREAD_ID}`;
const ALLOWED = new Set([CHAT_ID]);

function msg(overrides: Record<string, unknown> = {}): any {
  return {
    message_id: 42,
    chat: { id: CHAT_ID },
    message_thread_id: THREAD_ID,
    date: 1767225600,
    ...overrides,
  };
}

const VOICE = { file_id: 'v1', file_unique_id: 'u1', duration: 2 };
const DESC = { kind: 'voice' as const, caption: undefined, forwardedFrom: undefined, messageDate: '2026-01-01T00:00:00.000Z' };

function okVr(text: string): VoiceResult {
  return { ok: true, text, engine: 'test', mode: 'spawn', audioPath: 'a.ogg', elapsedMs: 5, truncated: false };
}

function voiceEntry(updateId: number, promise: Promise<VoiceResult>): QueueEntry {
  return { updateId, text: '', isCommand: false, cancelled: false, voice: { promise, descriptor: DESC, media: { file_id: 'v1', file_unique_id: 'u1', duration: 2 }, kind: 'voice' } };
}

function plainEntry(updateId: number, text: string, isCommand = false): QueueEntry {
  return { updateId, text, isCommand, cancelled: false };
}

describe('enqueue-normalizer', () => {
  it('EN-T1: main.js re-exports the SAME placeholderDispatchText function object', async () => {
    const main = await import('../main.js');
    const mod = await import('../enqueue-normalizer.js');
    assert.equal(main.placeholderDispatchText, mod.placeholderDispatchText);
  });

  it('EN-T1: photo label smoke', () => {
    assert.equal(placeholderDispatchText({ photo: [{ file_id: 'p' }] }), '[Photo]');
  });

  it('EN-T2: rejects a message-less update', () => {
    assert.equal(isAcceptableUpdate({ update_id: 1 }, ALLOWED), false);
  });

  it('EN-T2: rejects a disallowed chat', () => {
    assert.equal(isAcceptableUpdate({ message: msg({ text: 'hi', chat: { id: -999999 } }) }, ALLOWED), false);
  });

  it('EN-T2: accepts text, caption, voice, document, photo (the WPE3 set)', () => {
    assert.equal(isAcceptableUpdate({ message: msg({ text: 'hi' }) }, ALLOWED), true);
    assert.equal(isAcceptableUpdate({ message: msg({ caption: 'cap' }) }, ALLOWED), true);
    assert.equal(isAcceptableUpdate({ message: msg({ voice: VOICE }) }, ALLOWED), true);
    assert.equal(isAcceptableUpdate({ message: msg({ document: { file_id: 'd1', file_name: 'x.txt' } }) }, ALLOWED), true);
    assert.equal(isAcceptableUpdate({ message: msg({ photo: [{ file_id: 'p1' }] }) }, ALLOWED), true);
  });

  it('EN-T2: rejects an empty no-media message', () => {
    assert.equal(isAcceptableUpdate({ message: msg() }, ALLOWED), false);
  });

  it('EN-T3: placeholderDispatchText unit pins', () => {
    assert.equal(placeholderDispatchText({ voice: VOICE }), '[Voice message]');
    assert.equal(placeholderDispatchText({ audio: { file_id: 'a1', file_unique_id: 'u2', duration: 3 } }), '[Audio file]');
    assert.equal(placeholderDispatchText({ video_note: VOICE }), '[Video note]');
    assert.equal(placeholderDispatchText({ voice: VOICE, caption: '/status' }), '[Voice message] /status');
    assert.equal(placeholderDispatchText({ photo: [{ file_id: 'p' }], caption: 'a photo' }), '[Photo] a photo');
    assert.equal(placeholderDispatchText({ text: '  plain text  ' }), 'plain text');
  });

  it('EN-T4: command-captioned media — A5 __skipVoice producer, no prefetch (AFFIRMATIVE)', async () => {
    const update: any = { update_id: 5001, message: msg({ voice: VOICE, caption: '/status' }) };
    const res = await enqueueUpdateForDispatch(
      { update, allowedChatIds: ALLOWED, topicKey: KEY, steerContexts: new Map() },
      { token: 'tok', repoRoot: '/repo', env: {} as NodeJS.ProcessEnv },
    );
    assert.equal(res.queueEntry?.isCommand, true);
    assert.equal((update as any).__skipVoice, true);
    assert.equal(res.queueEntry?.voice, undefined);
    assert.equal(res.queueEntry?.messageId, 42);
    assert.equal(res.enqKey, pendingDispatchKey(CHAT_ID, THREAD_ID, 5001));
    const rec = (await listPendingDispatches()).find(r => r.updateId === 5001);
    assert.equal(rec?.userText, '[Voice message] /status');
  });

  it('EN-T5: plain text — no __skipVoice, non-command, placeholder record is the text', async () => {
    const update: any = { update_id: 5002, message: msg({ text: 'hello world' }) };
    const res = await enqueueUpdateForDispatch(
      { update, allowedChatIds: ALLOWED, topicKey: KEY, steerContexts: new Map() },
      { token: 'tok', repoRoot: '/repo', env: {} as NodeJS.ProcessEnv },
    );
    assert.equal((update as any).__skipVoice, undefined);
    assert.equal(res.queueEntry?.isCommand, false);
    assert.equal(res.queueEntry?.text, 'hello world');
    const rec = (await listPendingDispatches()).find(r => r.updateId === 5002);
    assert.equal(rec?.userText, 'hello world');
    assert.equal(rec?.voiceFileId, undefined);
  });

  it('EN-T5: uncaptioned document — [Document] placeholder, no voiceFileId', async () => {
    const update: any = { update_id: 5003, message: msg({ document: { file_id: 'd1', file_name: 'notes.txt' } }) };
    const res = await enqueueUpdateForDispatch(
      { update, allowedChatIds: ALLOWED, topicKey: KEY, steerContexts: new Map() },
      { token: 'tok', repoRoot: '/repo', env: {} as NodeJS.ProcessEnv },
    );
    assert.equal((update as any).__skipVoice, undefined);
    assert.equal(res.queueEntry?.isCommand, false);
    const rec = (await listPendingDispatches()).find(r => r.updateId === 5003);
    assert.equal(rec?.userText, '[Document]');
    assert.equal(rec?.voiceFileId, undefined);
  });

  it('EN register-args (AI-203 inc 3): a reply update registers replyToMessageId; a non-reply leaves it undefined', async () => {
    const reply: any = { update_id: 5004, message: msg({ text: 'also check failures', reply_to_message: { message_id: 41 } }) };
    const replyRes = await enqueueUpdateForDispatch(
      { update: reply, allowedChatIds: ALLOWED, topicKey: KEY, steerContexts: new Map() },
      { token: 'tok', repoRoot: '/repo', env: {} as NodeJS.ProcessEnv },
    );
    assert.equal(replyRes.queueEntry?.replyToMessageId, 41);
    assert.equal(replyRes.queueEntry?.messageId, 42);

    const nonReply: any = { update_id: 5005, message: msg({ text: 'plain' }) };
    const nonReplyRes = await enqueueUpdateForDispatch(
      { update: nonReply, allowedChatIds: ALLOWED, topicKey: KEY, steerContexts: new Map() },
      { token: 'tok', repoRoot: '/repo', env: {} as NodeJS.ProcessEnv },
    );
    assert.equal(nonReplyRes.queueEntry?.replyToMessageId, undefined);
  });

  it('EN-T6: resolved voice promise sets __voiceResult', async () => {
    const vr = okVr('transcribed words');
    const update: any = { update_id: 6001, message: msg({ voice: VOICE }) };
    await settleVoicePrefetch(update, voiceEntry(6001, Promise.resolve(vr)));
    assert.equal((update as any).__voiceResult, vr);
  });

  it('EN-T6: rejected promise is absorbed defensively — __voiceResult stays undefined', async () => {
    const update: any = { update_id: 6002, message: msg({ voice: VOICE }) };
    await settleVoicePrefetch(update, voiceEntry(6002, Promise.reject(new Error('boom'))));
    assert.equal((update as any).__voiceResult, undefined);
  });

  it('EN-T6: no voice field — no-op', async () => {
    const update: any = { update_id: 6003, message: msg({ text: 'hi' }) };
    await settleVoicePrefetch(update, plainEntry(6003, 'hi'));
    assert.equal((update as any).__voiceResult, undefined);
  });

  it('EN-T7: stop-held update returns FALSE and holds the entry (AFFIRMATIVE)', async () => {
    markTopicStopped(KEY, 'stop', 1000);
    const update: any = { update_id: 999, message: msg({ text: 'held candidate' }) };
    assert.equal(await flushCheckAndAbsorbHeld({ update, queueEntry: plainEntry(999, 'held candidate'), topicKey: KEY }), false);
    const held = await absorbHeldEntries(KEY);
    assert.ok(held.some(h => h.text === 'held candidate'));
  });

  it('EN-T7: a command entry under the same marker proceeds (returns true)', async () => {
    markTopicStopped(KEY, 'stop', 1000);
    const update: any = { update_id: 998, message: msg({ text: '/ping' }) };
    assert.equal(await flushCheckAndAbsorbHeld({ update, queueEntry: plainEntry(998, '/ping', true), topicKey: KEY }), true);
  });

  it('EN-T7: no stop marker — returns true', async () => {
    _clearStoppedForTest();
    const update: any = { update_id: 997, message: msg({ text: 'normal' }) };
    assert.equal(await flushCheckAndAbsorbHeld({ update, queueEntry: plainEntry(997, 'normal'), topicKey: KEY }), true);
  });

  it('EN-T8: held absorb D2 — held text prepends the transcript-formatted own text (AFFIRMATIVE)', async () => {
    addHeldEntry(KEY, { text: 'held note', updateId: 1 });
    const vr = okVr('hello world');
    const update: any = { update_id: 8001, message: msg({ voice: VOICE }) };
    (update as any).__voiceResult = vr;
    assert.equal(await flushCheckAndAbsorbHeld({ update, queueEntry: voiceEntry(8001, Promise.resolve(vr)), topicKey: KEY }), true);
    assert.equal((update as any).__heldAbsorbed, true);
    assert.ok((update.message.text as string).startsWith('held note'));
    assert.ok((update.message.text as string).includes('[Voice message] hello world'));
  });

  it('EN-T8: a command entry never absorbs held — message untouched', async () => {
    addHeldEntry(KEY, { text: 'held again', updateId: 2 });
    const update: any = { update_id: 8002, message: msg({ text: '/cmd' }) };
    assert.equal(await flushCheckAndAbsorbHeld({ update, queueEntry: plainEntry(8002, '/cmd', true), topicKey: KEY }), true);
    assert.equal((update as any).__heldAbsorbed, undefined);
    assert.equal(update.message.text, '/cmd');
    const stillHeld = await absorbHeldEntries(KEY);
    assert.ok(stillHeld.some(h => h.text === 'held again'));
  });
});
