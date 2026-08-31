import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sendToTelegram } from '../src/telegram.js';
import { notifyUser } from '../src/lib/notify.js';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import type { TelegramOutput } from '../src/types.js';

// WP-P1 (2026-08-24, plans/2026-08-24-buttons-program-SPEC.md): collateral tests for pre-work
// P3 (pa/src/telegram.ts sendToTelegram's 5th positional replyMarkup) and P4
// (pa/src/lib/notify.ts NotifyOpts.replyMarkup) — both FROZEN files, owned by the orchestrator;
// this file only asserts their behaviour.

type FetchResponse = { ok: boolean; status?: number; bodyText?: string };
function setupFetchMock(responses: FetchResponse[]): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  (globalThis as Record<string, unknown>).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    const text = r.bodyText ?? '{}';
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 400), text: async () => text, json: async () => ({}) };
  };
  return calls;
}

let originalFetch: typeof globalThis.fetch;
let originalNotifyDisabled: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalNotifyDisabled = process.env.PA_NOTIFY_DISABLED;
  // Unset the suite-wide default (test-env-setup.ts sets it to '1' globally): notifyUser's own
  // early-return guard checks this BEFORE ever calling sendToTelegram, so leaving it set would
  // make the notifyUser tests below assert nothing real. Never a real host either way — fetch
  // is always the stub installed per-test.
  delete process.env.PA_NOTIFY_DISABLED;
  // Keep any wedged-send race in notifyUser fast; the stub below always resolves synchronously
  // so this never actually engages, but pins the ceiling low regardless of a real host.
  process.env.PA_NOTIFY_TIMEOUT_MS = '200';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalNotifyDisabled === undefined) delete process.env.PA_NOTIFY_DISABLED;
  else process.env.PA_NOTIFY_DISABLED = originalNotifyDisabled;
  delete process.env.PA_NOTIFY_TIMEOUT_MS;
});

describe('sendToTelegram — replyMarkup placement (pre-work P3)', () => {
  const cfg: TelegramOutput = { chat_id: '-1001234567', token_secret: 'T' };
  const keyboard = { inline_keyboard: [[{ text: 'A', callback_data: 'x' }]] };

  it('puts reply_markup on the LAST chunk only for a 9000-char body', async () => {
    const calls = setupFetchMock([{ ok: true }, { ok: true }, { ok: true }]);
    await sendToTelegram('x'.repeat(9000), cfg, 'tok', 'Markdown', keyboard);
    assert.equal(calls.length, 3, 'a 9000-char body plus ref trailer hard-cuts into exactly 3 chunks');
    for (let idx = 0; idx < calls.length - 1; idx++) {
      const body = JSON.parse(calls[idx].init!.body as string);
      assert.equal('reply_markup' in body, false, `chunk ${idx} must not carry reply_markup`);
    }
    const lastBody = JSON.parse(calls[calls.length - 1].init!.body as string);
    assert.deepEqual(lastBody.reply_markup, keyboard, 'only the last chunk carries the keyboard');
  });

  it('omits the reply_markup key entirely when not passed', async () => {
    const calls = setupFetchMock([{ ok: true }]);
    await sendToTelegram('hello', cfg, 'tok');
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal('reply_markup' in body, false, 'key must be absent, not merely undefined-valued');
  });

  it('carries reply_markup into the plain-text parse-failure fallback body', async () => {
    const calls = setupFetchMock([
      { ok: false, status: 400, bodyText: "can't parse entities" },
      { ok: true },
    ]);
    await sendToTelegram('hello', cfg, 'tok', 'Markdown', keyboard);
    assert.equal(calls.length, 2, 'parse failure retried as plain text');
    const fallback = JSON.parse(calls[1].init!.body as string);
    assert.deepEqual(fallback.reply_markup, keyboard, 'keyboard survives the fallback retry');
  });
});

describe('notifyUser — forwards opts.replyMarkup (pre-work P4)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempPaHome();
    await createTempSecrets(
      tempDir,
      ['TELEGRAM_BOT_TOKEN=test-token', 'TELEGRAM_CHAT_ID=-100999'].join('\n')
    );
  });

  afterEach(async () => {
    await cleanup(tempDir);
  });

  it('forwards replyMarkup to sendToTelegram as the 5th positional argument', async () => {
    const calls = setupFetchMock([{ ok: true }]);
    const keyboard = { inline_keyboard: [[{ text: 'Approve', callback_data: 'pm:t1:approve' }]] };
    const result = await notifyUser('Subject', 'Body', { replyMarkup: keyboard });
    assert.equal(result.sent, true, `expected sent, got ${JSON.stringify(result)}`);
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init!.body as string);
    assert.deepEqual(body.reply_markup, keyboard);
  });

  it('omits reply_markup when opts.replyMarkup is not passed (byte-identical to pre-buttons behaviour)', async () => {
    const calls = setupFetchMock([{ ok: true }]);
    const result = await notifyUser('Subject2', 'Body2');
    assert.equal(result.sent, true, `expected sent, got ${JSON.stringify(result)}`);
    const body = JSON.parse(calls[0].init!.body as string);
    assert.equal('reply_markup' in body, false);
  });
});
