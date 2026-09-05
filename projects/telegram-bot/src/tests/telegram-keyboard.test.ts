// Guard against the real-Telegram/real-log leak (see test-env-guard.js's own header) —
// this file stubs globalThis.fetch directly and calls telegram.ts functions that log via
// pa's logger on failure paths, whose paHome() is resolved fresh on every call.
import './test-env-guard.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendMessageWithKeyboard,
  sendMessageWithKeyboardDetailed,
  isTerminalChatError,
  editMessageText,
  editMessageReplyMarkup,
  sendMessageWithId,
  type InlineKeyboardMarkup,
} from '../telegram.js';

/**
 * Unit tests for the FROZEN pre-work in telegram.ts (P1c-f of the
 * buttons-program design, internal), owned as collateral by WP-B1
 * (spec §4 "Gate", WP-B1 test list). These are the last-chunk-only keyboard
 * attachment, the number|null return shape, and editMessageReplyMarkup.
 */

type FetchResponse = {
  ok: boolean;
  status?: number;
  bodyText?: string;
  bodyJson?: unknown;
  throwError?: Error;
};

function setupFetchMock(responses: FetchResponse[]): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  (globalThis as Record<string, unknown>).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r.throwError) throw r.throwError;
    const json = r.bodyJson ?? {};
    const text = r.bodyText ?? JSON.stringify(json);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      text: async () => text,
      json: async () => json,
    };
  };
  return calls;
}

function bodyOf(call: { init?: RequestInit }): Record<string, unknown> {
  return JSON.parse(call.init!.body as string);
}

const KB: InlineKeyboardMarkup = { inline_keyboard: [[{ text: '✅ Yes', callback_data: 'cf:y' }]] };

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('sendMessageWithKeyboard', () => {
  it('issues 3 POSTs for a 9000-char body and only the LAST carries reply_markup', async () => {
    const text = 'x'.repeat(9000);
    const calls = setupFetchMock([
      { ok: true, bodyJson: { ok: true, result: { message_id: 100 } } },
      { ok: true, bodyJson: { ok: true, result: { message_id: 101 } } },
      { ok: true, bodyJson: { ok: true, result: { message_id: 102 } } },
    ]);
    const id = await sendMessageWithKeyboard('token', 123, text, KB);
    assert.equal(calls.length, 3, `expected 3 chunks, got ${calls.length}`);
    for (let i = 0; i < 2; i++) {
      assert.equal(bodyOf(calls[i]).reply_markup, undefined, `chunk ${i} must not carry reply_markup`);
    }
    assert.deepEqual(bodyOf(calls[2]).reply_markup, KB, 'last chunk must carry reply_markup');
    assert.equal(id, 100, 'returns first chunk message_id');
  });

  it('returns null when the first POST fails', async () => {
    const calls = setupFetchMock([
      { ok: false, bodyText: 'Bad Request' },
      { ok: true, bodyJson: { ok: true, result: { message_id: 101 } } },
      { ok: true, bodyJson: { ok: true, result: { message_id: 102 } } },
    ]);
    const id = await sendMessageWithKeyboard('token', 123, 'x'.repeat(9000), KB);
    assert.equal(calls.length, 3, 'still attempts every chunk');
    assert.equal(id, null, 'any chunk failure makes the whole send return null');
  });

  it('returns null for an empty/whitespace-only body without calling fetch', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: { message_id: 1 } } }]);
    const id = await sendMessageWithKeyboard('token', 123, '   ', KB);
    assert.equal(id, null);
    assert.equal(calls.length, 0);
  });

  it('single-chunk body still carries reply_markup on its one POST', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: { message_id: 55 } } }]);
    const id = await sendMessageWithKeyboard('token', 123, 'hello', KB);
    assert.equal(calls.length, 1);
    assert.deepEqual(bodyOf(calls[0]).reply_markup, KB);
    assert.equal(id, 55);
  });

  it('falls back to plain text on a 400 parse error, keeping reply_markup', async () => {
    const calls = setupFetchMock([
      { ok: false, status: 400, bodyText: 'Bad Request: can\'t parse entities' },
      { ok: true, bodyJson: { ok: true, result: { message_id: 77 } } },
    ]);
    const id = await sendMessageWithKeyboard('token', 123, 'hello *world', KB);
    assert.equal(calls.length, 2, 'first POST fails on parse, second is the plain-text retry');
    assert.equal(bodyOf(calls[1]).parse_mode, undefined, 'fallback retry must drop parse_mode');
    assert.deepEqual(bodyOf(calls[1]).reply_markup, KB, 'fallback retry must keep the keyboard');
    assert.equal(id, 77, 'returns the fallback retry message_id');
  });

  it('returns null on a 400 that is not a parse error, without retrying', async () => {
    const calls = setupFetchMock([{ ok: false, status: 400, bodyText: 'Bad Request: chat not found' }]);
    const id = await sendMessageWithKeyboard('token', 123, 'hello', KB);
    assert.equal(calls.length, 1, 'no fallback retry for a non-parse error');
    assert.equal(id, null);
  });

  // -------------------------------------------------------------------------
  // Reply-target-gone fallback (bp-replyfix): a reply whose target message
  // was deleted (e.g. /auth's delete-then-reply flow) must not dead-letter.
  // -------------------------------------------------------------------------

  it('retries without reply_to_message_id when Telegram reports the reply target is gone, keeping the keyboard', async () => {
    const calls = setupFetchMock([
      { ok: false, status: 400, bodyText: 'Bad Request: message to be replied not found' },
      { ok: true, bodyJson: { ok: true, result: { message_id: 88 } } },
    ]);
    const id = await sendMessageWithKeyboard('token', 123, 'hello', KB, 99);
    assert.equal(calls.length, 2, 'should retry after reply-target-gone failure');
    const firstBody = bodyOf(calls[0]);
    const retryBody = bodyOf(calls[1]);
    assert.equal(firstBody.reply_to_message_id, 99, 'initial attempt still targets the reply');
    assert.equal(retryBody.reply_to_message_id, undefined, 'retry must omit reply_to_message_id');
    assert.equal(retryBody.text, 'hello', 'retry keeps the original text');
    assert.deepEqual(retryBody.reply_markup, KB, 'retry must keep the keyboard');
    assert.equal(id, 88, 'reports success (the fallback retry message_id) once the retry lands');
  });

  it('returns null on an unrelated 400 even when a reply target was set, without retrying', async () => {
    const calls = setupFetchMock([{ ok: false, status: 400, bodyText: 'Bad Request: chat not found' }]);
    const id = await sendMessageWithKeyboard('token', 123, 'hello', KB, 99);
    assert.equal(calls.length, 1, 'no retry for an unrelated error');
    assert.equal(id, null, 'reports failure exactly as before this fix');
  });

  it('terminates after one retry per cause when parse and reply-target errors both occur, without looping', async () => {
    const calls = setupFetchMock([
      { ok: false, status: 400, bodyText: "can't parse entities" },
      { ok: false, status: 400, bodyText: 'Bad Request: message to be replied not found' },
      { ok: false, status: 400, bodyText: 'Bad Request: message to be replied not found' },
    ]);
    const id = await sendMessageWithKeyboard('token', 123, 'hello *world', KB, 99);
    assert.equal(calls.length, 3, 'exactly 2 corrective retries — one per cause — then it stops');
    const finalBody = bodyOf(calls[2]);
    assert.equal(finalBody.parse_mode, undefined, 'final body has no parse_mode');
    assert.equal(finalBody.reply_to_message_id, undefined, 'final body has no reply_to_message_id');
    assert.equal(id, null, 'still-failing final attempt reports failure, not a false success');
  });

  it('a successful first send still passes reply_to_message_id (no unconditional stripping)', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: { message_id: 55 } } }]);
    const id = await sendMessageWithKeyboard('token', 123, 'hello', KB, 99);
    assert.equal(calls.length, 1);
    const body = bodyOf(calls[0]);
    assert.equal(body.reply_to_message_id, 99);
    assert.equal(id, 55);
  });
});

describe('editMessageText — reply_markup passthrough (P1d)', () => {
  it('omits reply_markup when not passed', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    await editMessageText('token', 123, 456, 'hello');
    assert.equal(bodyOf(calls[0]).reply_markup, undefined);
  });

  it('includes reply_markup when passed', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    await editMessageText('token', 123, 456, 'hello', KB);
    assert.deepEqual(bodyOf(calls[0]).reply_markup, KB);
  });

  it('carries reply_markup into the plain-text MarkdownV2-fallback retry body', async () => {
    const calls = setupFetchMock([
      { ok: false, status: 400, bodyText: 'Bad Request: can\'t parse entities' },
      { ok: true, bodyJson: { ok: true } },
    ]);
    const ok = await editMessageText('token', 123, 456, 'hello *world', KB);
    assert.equal(ok, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(bodyOf(calls[1]).reply_markup, KB, 'fallback retry must keep the keyboard');
    assert.equal(bodyOf(calls[1]).parse_mode, undefined, 'fallback retry must drop parse_mode');
  });
});

describe('editMessageReplyMarkup', () => {
  it('with no keyboard posts {chat_id, message_id} only', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    const ok = await editMessageReplyMarkup('token', 123, 456);
    assert.equal(ok, true);
    assert.ok(calls[0].url.includes('/editMessageReplyMarkup'));
    const body = bodyOf(calls[0]);
    assert.deepEqual(Object.keys(body).sort(), ['chat_id', 'message_id']);
    assert.equal(body.chat_id, 123);
    assert.equal(body.message_id, 456);
  });

  it('includes reply_markup when a keyboard is passed', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true } }]);
    await editMessageReplyMarkup('token', 123, 456, KB);
    assert.deepEqual(bodyOf(calls[0]).reply_markup, KB);
  });

  it('"message is not modified" response returns true', async () => {
    setupFetchMock([{ ok: false, status: 400, bodyText: 'Bad Request: message is not modified' }]);
    const ok = await editMessageReplyMarkup('token', 123, 456, KB);
    assert.equal(ok, true);
  });

  it('returns false and never throws on a genuine API failure', async () => {
    setupFetchMock([{ ok: false, status: 400, bodyText: 'Bad Request: chat not found' }]);
    const ok = await editMessageReplyMarkup('token', 123, 456, KB);
    assert.equal(ok, false);
  });

  it('never throws on a network error', async () => {
    setupFetchMock([{ ok: false, throwError: new Error('ECONNRESET') }]);
    await assert.doesNotReject(() => editMessageReplyMarkup('token', 123, 456, KB));
  });
});

describe('sendMessageWithId — reply_markup forwarding', () => {
  it('forwards reply_markup when passed', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: { message_id: 42 } } }]);
    const id = await sendMessageWithId('token', 123, 'hello', undefined, KB);
    assert.equal(id, 42);
    assert.deepEqual(bodyOf(calls[0]).reply_markup, KB);
  });

  it('omits reply_markup when not passed', async () => {
    const calls = setupFetchMock([{ ok: true, bodyJson: { ok: true, result: { message_id: 42 } } }]);
    await sendMessageWithId('token', 123, 'hello');
    assert.equal(bodyOf(calls[0]).reply_markup, undefined);
  });
});

describe('sendMessageWithKeyboardDetailed + isTerminalChatError (AI-186, widened 2026-09-03)', () => {
  it('isTerminalChatError: true for each terminal string at its correct status', () => {
    // 400 family
    assert.equal(isTerminalChatError(400, 'Bad Request: chat not found'), true);
    assert.equal(isTerminalChatError(400, '{"ok":false,"description":"Bad Request: chat not found"}'), true);
    assert.equal(isTerminalChatError(400, 'Bad Request: PEER_ID_INVALID'), true, 'case-insensitive');
    assert.equal(isTerminalChatError(400, 'Bad Request: chat_id_invalid'), true);
    // 403 family
    assert.equal(isTerminalChatError(403, 'Forbidden: chat not found'), true);
    assert.equal(isTerminalChatError(403, 'Forbidden: bot was blocked by the user'), true);
    assert.equal(isTerminalChatError(403, 'Forbidden: user is deactivated'), true);
    assert.equal(isTerminalChatError(403, 'Forbidden: bot was kicked from the group chat'), true);
  });

  it('isTerminalChatError: false for transient, rights-based, unknown, and wrong-status failures', () => {
    assert.equal(isTerminalChatError(429, 'Too Many Requests: retry after 3'), false, '429 is never terminal');
    assert.equal(isTerminalChatError(500, 'Internal Server Error'), false, '5xx is never terminal');
    assert.equal(isTerminalChatError(500, 'Bad Request: chat not found'), false, 'status gate: terminal string at a wrong status');
    assert.equal(isTerminalChatError(400, 'Bad Request: have no rights to send a message to the chat'), false, 'bot rights can be restored by an admin — transient, stays retryable');
    assert.equal(isTerminalChatError(400, "Bad Request: can't parse entities"), false);
    assert.equal(isTerminalChatError(403, 'Forbidden: some other forbidden string'), false, 'unknown 403 strings stay false (fail toward retry, never toward drop)');
    assert.equal(isTerminalChatError(400, 'Bad Request: peer_id_invaild'), false, 'misspelled terminal string is unknown — stays false');
    assert.equal(isTerminalChatError(400, 'Forbidden: bot was blocked by the user'), false, '403 string at 400 is the wrong status gate');
    assert.equal(isTerminalChatError(400, 'Bad Request: message to be replied not found'), false, 'reply-target-gone is a different, recoverable class');
  });

  it('detailed send: single-chunk 400 chat not found → terminalError true, messageId null', async () => {
    const calls = setupFetchMock([{ ok: false, status: 400, bodyText: 'Bad Request: chat not found' }]);
    const r = await sendMessageWithKeyboardDetailed('token', 123, 'hello', KB);
    assert.equal(calls.length, 1, 'no fallback retry for chat-not-found');
    assert.equal(r.messageId, null);
    assert.equal(r.terminalError, true);
  });

  it('detailed send: 500 failure → terminalError false', async () => {
    const calls = setupFetchMock([{ ok: false, status: 500, bodyText: 'Internal Server Error' }]);
    const r = await sendMessageWithKeyboardDetailed('token', 123, 'hello', KB);
    assert.equal(calls.length, 1);
    assert.equal(r.messageId, null);
    assert.equal(r.terminalError, false, '5xx is transient, never terminal');
  });

  it('detailed send: network error → terminalError false', async () => {
    const calls = setupFetchMock([{ ok: false, throwError: new Error('ECONNRESET') }]);
    const r = await sendMessageWithKeyboardDetailed('token', 123, 'hello', KB);
    assert.equal(calls.length, 1);
    assert.equal(r.messageId, null);
    assert.equal(r.terminalError, false, 'network errors are transient');
  });

  it('detailed send: multi-chunk with ALL chunk failures chat-not-found → terminalError true', async () => {
    const text = 'x'.repeat(9000); // 3 chunks
    const calls = setupFetchMock([{ ok: false, status: 400, bodyText: 'Bad Request: chat not found' }]);
    const r = await sendMessageWithKeyboardDetailed('token', 123, text, KB);
    assert.equal(calls.length, 3, 'still attempts every chunk');
    assert.equal(r.messageId, null);
    assert.equal(r.terminalError, true);
  });

  it('detailed send: multi-chunk with a parse failure on chunk 2 → terminalError false', async () => {
    const text = 'x'.repeat(9000); // 3 chunks
    const calls = setupFetchMock([
      { ok: false, status: 400, bodyText: 'Bad Request: chat not found' }, // chunk 1 dies chat-not-found
      { ok: false, status: 400, bodyText: "Bad Request: can't parse entities" }, // chunk 2 phase 0: parse error
      { ok: false, status: 400, bodyText: 'Bad Request: message is too long' }, // chunk 2 plain-text retry fails non-chat-not-found
    ]);
    const r = await sendMessageWithKeyboardDetailed('token', 123, text, KB);
    assert.equal(calls.length, 4, '3 chunks (one attempt each) + 1 parse-fallback retry on chunk 2');
    assert.equal(r.messageId, null);
    assert.equal(r.terminalError, false, 'a parse failure on chunk 2 is not terminal');
  });

  it('detailed send: success passthrough — first chunk messageId, terminalError false', async () => {
    const text = 'y'.repeat(5000); // 2 chunks
    const calls = setupFetchMock([
      { ok: true, bodyJson: { ok: true, result: { message_id: 201 } } },
      { ok: true, bodyJson: { ok: true, result: { message_id: 202 } } },
    ]);
    const r = await sendMessageWithKeyboardDetailed('token', 123, text, KB);
    assert.equal(calls.length, 2);
    assert.equal(r.messageId, 201, 'first chunk message_id passthrough');
    assert.equal(r.terminalError, false);
  });
});
