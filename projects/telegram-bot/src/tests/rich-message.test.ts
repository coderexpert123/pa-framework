// Self-guard: this file's SUT (rich-message.ts) calls telegramFetch, which can send
// real Telegram traffic if PA_HOME/PA_NOTIFY_DISABLED leak in a scoped (no --import
// preload) run. See test-env-guard.js's own header for the incident this prevents.
import './test-env-guard.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RICH_MIN_CHARS,
  shouldUseRichMessage,
  sendRichMessage,
  sendReplyText,
} from '../rich-message.js';
import type { InlineKeyboardMarkup } from '../telegram.js';

// ---------------------------------------------------------------------------
// Fetch mock — routes by URL substring so a single test can stub both the
// /sendRichMessage and /sendMessage endpoints differently in the same call.
// Never touches the network: this is the ONLY fetch implementation installed
// for the duration of each test (restored in afterEach).
// ---------------------------------------------------------------------------

type MockResponse = { ok: boolean; status?: number; bodyJson?: unknown; bodyText?: string };
type Call = { url: string; init?: RequestInit };

function installFetchRouter(route: (url: string) => MockResponse): Call[] {
  const calls: Call[] = [];
  (globalThis as Record<string, unknown>).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = route(url);
    const json = r.bodyJson ?? (r.ok ? { ok: true, result: { message_id: 555 } } : { ok: false, description: 'error' });
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

function countCalls(calls: Call[], endpointSuffix: string): number {
  return calls.filter((c) => c.url.includes(endpointSuffix)).length;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const richOnEnv = { PA_RICH_MESSAGES: '1' } as NodeJS.ProcessEnv;
const richOffEnv = {} as NodeJS.ProcessEnv;

// ---------------------------------------------------------------------------
// shouldUseRichMessage — pure function, no network
// ---------------------------------------------------------------------------

describe('shouldUseRichMessage', () => {
  it('is false when the env flag is unset regardless of length', () => {
    const longText = 'a'.repeat(RICH_MIN_CHARS + 500);
    assert.equal(shouldUseRichMessage(longText, richOffEnv), false);
  });

  it('is false when the env flag is set to something other than "1"', () => {
    const longText = 'a'.repeat(RICH_MIN_CHARS + 500);
    assert.equal(shouldUseRichMessage(longText, { PA_RICH_MESSAGES: 'true' } as NodeJS.ProcessEnv), false);
  });

  it('is true for a body over RICH_MIN_CHARS with the flag on', () => {
    const longText = 'a'.repeat(4000);
    assert.ok(longText.length > RICH_MIN_CHARS);
    assert.equal(shouldUseRichMessage(longText, richOnEnv), true);
  });

  it('is false for a short body under RICH_MIN_CHARS with the flag on and no table', () => {
    assert.equal(shouldUseRichMessage('short plain reply', richOnEnv), false);
  });

  it('is true for a short body containing a markdown table with the flag on', () => {
    const withTable = 'Summary:\n| A | B |\n|---|---|\n| 1 | 2 |\n';
    assert.ok(withTable.length <= RICH_MIN_CHARS);
    assert.equal(shouldUseRichMessage(withTable, richOnEnv), true);
  });

  it('is false for a body containing | but no separator row', () => {
    const pipeNoTable = 'Use a | b to mean "or" in this shell one-liner.\nNo table here.';
    assert.equal(shouldUseRichMessage(pipeNoTable, richOnEnv), false);
  });
});

// ---------------------------------------------------------------------------
// sendRichMessage — fetch mocked
// ---------------------------------------------------------------------------

describe('sendRichMessage', () => {
  it('posts to the sendRichMessage endpoint with the expected body', async () => {
    const calls = installFetchRouter(() => ({ ok: true }));
    const result = await sendRichMessage('tok', 123, 'hello rich', 456, 789);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/sendRichMessage'));
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal(body.chat_id, 123);
    // Live-verified shape (2026-08-24): rich_message.markdown, no text/parse_mode.
    assert.equal(body.rich_message?.markdown, 'hello rich');
    assert.equal(body.text, undefined);
    assert.equal(body.parse_mode, undefined);
    assert.equal(body.message_thread_id, 456);
    assert.equal(body.reply_to_message_id, 789);
    assert.equal(result.ok, true);
  });

  it('returns ok:false with status/error on a non-2xx response, never throws', async () => {
    installFetchRouter(() => ({ ok: false, status: 400, bodyText: 'Bad Request: unknown method' }));
    const result = await sendRichMessage('tok', 123, 'hello');
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.ok(result.error?.includes('unknown method'));
  });

  it('returns ok:false on a network error, never throws', async () => {
    (globalThis as Record<string, unknown>).fetch = async () => {
      throw new Error('network boom');
    };
    const result = await sendRichMessage('tok', 123, 'hello');
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes('network boom'));
  });
});

// ---------------------------------------------------------------------------
// sendReplyText — the one entry point main.ts calls
// ---------------------------------------------------------------------------

describe('sendReplyText', () => {
  it('flag off: one /sendMessage POST and zero /sendRichMessage', async () => {
    const calls = installFetchRouter(() => ({ ok: true }));
    const result = await sendReplyText('tok', 123, 'a short reply', undefined, undefined, richOffEnv);
    assert.equal(countCalls(calls, '/sendRichMessage'), 0);
    assert.equal(countCalls(calls, '/sendMessage'), 1);
    assert.equal(result.delivered, true);
  });

  it('flag on + long text: exactly one /sendRichMessage call', async () => {
    const calls = installFetchRouter(() => ({ ok: true }));
    const longText = 'a'.repeat(RICH_MIN_CHARS + 100);
    const result = await sendReplyText('tok', 123, longText, undefined, undefined, richOnEnv);
    assert.equal(countCalls(calls, '/sendRichMessage'), 1);
    assert.equal(countCalls(calls, '/sendMessage'), 0);
    assert.equal(result.delivered, true);
    assert.equal(result.messageId, null);
  });

  it('flag on + /sendRichMessage returning 400: falls back to /sendMessage, delivered:true', async () => {
    const calls = installFetchRouter((url) => {
      if (url.includes('/sendRichMessage')) return { ok: false, status: 400, bodyText: 'Bad Request' };
      return { ok: true };
    });
    const longText = 'a'.repeat(RICH_MIN_CHARS + 100);
    const result = await sendReplyText('tok', 123, longText, undefined, undefined, richOnEnv);
    assert.equal(countCalls(calls, '/sendRichMessage'), 1);
    assert.equal(countCalls(calls, '/sendMessage'), 1);
    assert.equal(result.delivered, true);
  });

  it('flag on + replyMarkup given: zero /sendRichMessage regardless of text shape', async () => {
    const calls = installFetchRouter(() => ({ ok: true }));
    const longText = 'a'.repeat(RICH_MIN_CHARS + 100);
    const keyboard: InlineKeyboardMarkup = { inline_keyboard: [[{ text: 'OK', callback_data: 'ok' }]] };
    const result = await sendReplyText('tok', 123, longText, undefined, undefined, richOnEnv, keyboard);
    assert.equal(countCalls(calls, '/sendRichMessage'), 0);
    assert.equal(countCalls(calls, '/sendMessage'), 1);
    const body = JSON.parse(calls[0].init!.body as string);
    assert.deepEqual(body.reply_markup, keyboard);
    assert.equal(result.delivered, true);
    assert.equal(result.messageId, 555);
  });

  it('no test in this suite performs a real network call (stub always installed)', async () => {
    const calls = installFetchRouter(() => ({ ok: true }));
    await sendReplyText('tok', 123, 'x', undefined, undefined, richOffEnv);
    assert.ok(calls.length > 0, 'the installed stub must have been invoked, not the real fetch');
  });
});
