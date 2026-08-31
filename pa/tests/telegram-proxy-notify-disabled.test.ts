import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, cleanup } from './helpers.js';
import {
  telegramFetch,
  telegramFetchSuppressedCount,
  resetTelegramFetchSuppressedCount,
} from '../src/lib/telegram-proxy.js';

// WP-D / D13 (AI-156, 2026-08-23): PA_NOTIFY_DISABLED must be a REAL kill
// switch. Before this wave, telegramFetch()'s "test mode" branch called real
// fetch() — so the ~21 telegramFetch call sites in the two telegram.ts
// modules could send for real whenever PA_HOME leaked to the real ~/.pa (two
// production incidents, 2026-08-17/18). This test proves the synthetic
// short-circuit: zero network calls, ever, under the flag. Proven via the
// exported suppressed-call counter plus a sub-500ms wall-clock bound —
// deliberately NOT by mocking undici, which telegram-proxy-refresh.test.ts's
// own history records as having failed at setup in this repo.
//
// D13 AMENDMENT (2026-08-23, same day): the original unconditional synthetic
// form broke every existing test that installs a fetch double on
// globalThis.fetch and asserts on the call (pa/tests/telegram.test.ts's
// sendToTelegram suite, telegram-redact.test.ts, and the bot's mirrors) —
// those tests relied on PA_NOTIFY_DISABLED's OLD pass-through-to-fetch
// behaviour to observe sendToTelegram's real request-building logic against
// a safe, mocked fetch. The fix: only the REAL fetch is blocked. A test
// double installed on globalThis.fetch is, by definition, not the network,
// so it passes through untouched and is not suppressed. See
// pa/src/lib/telegram-proxy.ts's realFetch()/__PA_REAL_FETCH__.

describe('telegramFetch — PA_NOTIFY_DISABLED=1 is a true no-op', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempPaHome();
    process.env.PA_NOTIFY_DISABLED = '1';
    resetTelegramFetchSuppressedCount();
  });

  afterEach(async () => {
    await cleanup(tempDir);
  });

  it('returns a synthetic 200 {ok:true,result:{}} without ever dialling out', async () => {
    const before = telegramFetchSuppressedCount();
    const start = Date.now();
    const res = await telegramFetch('https://api.telegram.org/botFAKE:REALLOOKINGTOKEN12345/sendMessage', {
      method: 'POST',
      body: JSON.stringify({ chat_id: '123', text: 'test' }),
    });
    const elapsedMs = Date.now() - start;

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, result: {} });

    // Real fetch to a fake bot token would fail or hang for well over 500ms
    // (DNS + TLS + a 404/401 round-trip, or a timeout). A sub-500ms return is
    // proof this never touched the network.
    assert.ok(elapsedMs < 500, `expected a synthetic same-process return, took ${elapsedMs}ms`);
  });

  it('increments telegramFetchSuppressedCount() by exactly 1 per call', async () => {
    const before = telegramFetchSuppressedCount();
    await telegramFetch('https://api.telegram.org/botFAKE:TOKEN/getMe');
    assert.equal(telegramFetchSuppressedCount(), before + 1);

    await telegramFetch('https://api.telegram.org/botFAKE:TOKEN/getMe');
    assert.equal(telegramFetchSuppressedCount(), before + 2);
  });

  it('resetTelegramFetchSuppressedCount() zeroes the counter', async () => {
    await telegramFetch('https://api.telegram.org/botFAKE:TOKEN/getMe');
    assert.ok(telegramFetchSuppressedCount() > 0);
    resetTelegramFetchSuppressedCount();
    assert.equal(telegramFetchSuppressedCount(), 0);
  });

  it('the content-type header on the synthetic response is application/json', async () => {
    const res = await telegramFetch('https://api.telegram.org/botFAKE:TOKEN/sendMessage');
    assert.equal(res.headers.get('content-type'), 'application/json');
  });

  it('a mocked globalThis.fetch is called exactly once and is NOT suppressed (a test double is not the network)', async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = mock.fn(async (_url: unknown, _init: unknown) => new Response(JSON.stringify({ ok: true, result: {} })));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    try {
      const before = telegramFetchSuppressedCount();
      const url = 'https://api.telegram.org/botFAKE:TOKEN/sendMessage';
      const init = { method: 'POST', body: JSON.stringify({ chat_id: '1', text: 'hi' }) };

      const res = await telegramFetch(url, init);

      assert.equal(mockFetch.mock.calls.length, 1, 'the mocked fetch must be called exactly once');
      assert.equal(mockFetch.mock.calls[0].arguments[0], url);
      assert.equal(mockFetch.mock.calls[0].arguments[1], init);
      assert.equal(
        telegramFetchSuppressedCount(),
        before,
        'a mocked fetch is not the real network — the suppressed counter must not move',
      );

      const body = await res.json();
      assert.deepEqual(body, { ok: true, result: {} });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('after restoring globalThis.fetch to the real one, telegramFetch is synthetic again', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const mockFetch = mock.fn(async () => new Response(JSON.stringify({ ok: true, result: {} })));
      globalThis.fetch = mockFetch as unknown as typeof fetch;
      await telegramFetch('https://api.telegram.org/botFAKE:TOKEN/getMe');
      assert.equal(mockFetch.mock.calls.length, 1, 'sanity: the mock was reached while installed');

      globalThis.fetch = originalFetch; // restore to the real fetch

      const before = telegramFetchSuppressedCount();
      const res = await telegramFetch('https://api.telegram.org/botFAKE:TOKEN/getMe');
      assert.equal(
        telegramFetchSuppressedCount(),
        before + 1,
        'once fetch is back to the real one, the kill switch must suppress again',
      );
      const body = await res.json();
      assert.deepEqual(body, { ok: true, result: {} });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
