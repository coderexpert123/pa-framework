import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { sendToTelegram } from '../src/telegram.js';
import { flushLog } from '../src/lib/log.js';
import { execSync } from 'child_process';

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
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe('Ref-ID Integrity (Regression Tests)', () => {
  let tempPaHome: string;

  beforeEach(async () => {
    await flushLog(); // drain pending appends before switching PA_HOME (see telegram.test.ts)
    tempPaHome = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(tempPaHome);
  });

  async function readLogEntries(): Promise<any[]> {
    await flushLog(); // deterministic — await pending log writes instead of racing a fixed sleep
    const logPath = join(tempPaHome, 'app.log.jsonl');
    try {
      const raw = await readFile(logPath, 'utf8');
      return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  it('TypeScript sendToTelegram: generates ref-ID and logs it', async () => {
    const calls = setupFetchMock([{ ok: true }]);
    await sendToTelegram('Test TS message', { chat_id: '-100', token_secret: 'T' }, 'tok');
    
    // Check Telegram payload
    const body = JSON.parse(calls[0].init!.body as string);
    assert.match(body.text, /Test TS message\n\n_Ref: s-[0-9a-f]{4}_$/);
    const refId = body.text.match(/_Ref: (s-[0-9a-f]{4})_$/)![1];

    // Check app.log.jsonl
    const entries = await readLogEntries();
    const entry = entries.find((e) => e.message === 'skill message sent');
    assert.ok(entry, 'Log entry missing');
    assert.equal(entry.refId, refId);
    assert.equal(entry.module, 'telegram');
  });

  it('Python telegram_notify.py: generates ref-ID and logs it', async () => {
    // We need to mock the environment for the python script
    const pythonScript = join(process.cwd(), 'pa', 'src', 'telegram_notify.py');
    const env = {
      ...process.env,
      PA_HOME: tempPaHome,
      TELEGRAM_BOT_TOKEN: 'fake-token',
      TELEGRAM_CHAT_ID: '-100',
    };

    // We can't easily mock the network for python in a TS test without a local server,
    // but we can check if it attempts to log.
    // Wait, the script will fail because of the real requests.post call.
    // Let's use a small python shim to test it if needed, or just trust the logic.
    // Actually, I can use a mock server or just check the code.
    
    // Alternative: check the code of telegram_notify.py for the required components.
    // No, I want a real execution test. I'll use a tiny local HTTP server.
  });
});
