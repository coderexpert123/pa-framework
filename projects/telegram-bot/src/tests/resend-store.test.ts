import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  putResend,
  takeResend,
  resendKey,
  RESEND_MAX_AGE_MS,
  _resetResendStoreForTest,
  type ResendRecord,
} from '../resend-store.js';
import { waitForDrain } from './test-teardown-guard.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pa-resend-'));
  process.env.PA_HOME = home;
  _resetResendStoreForTest();
});

afterEach(async () => {
  await waitForDrain();
  delete process.env.PA_HOME;
  _resetResendStoreForTest();
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

function makeRecord(overrides: Partial<ResendRecord> = {}): ResendRecord {
  return {
    chatId: -100555,
    threadId: 9,
    updateId: 42,
    messageId: 321,
    userText: 'please run the thing',
    storedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('resendKey', () => {
  it('is stable and unique per update', () => {
    assert.equal(resendKey(-1, 2, 3), resendKey(-1, 2, 3));
    assert.notEqual(resendKey(-1, 2, 3), resendKey(-1, 2, 4));
  });
});

describe('resend store', () => {
  it('put → take returns the record', async () => {
    const rec = makeRecord();
    await putResend(rec);
    const key = resendKey(rec.chatId, rec.threadId, rec.updateId);
    const got = await takeResend(key);
    assert.deepEqual(got, rec);
  });

  it('a second take returns null', async () => {
    const rec = makeRecord();
    await putResend(rec);
    const key = resendKey(rec.chatId, rec.threadId, rec.updateId);
    await takeResend(key);
    assert.equal(await takeResend(key), null);
  });

  it('taking an unknown key returns null', async () => {
    assert.equal(await takeResend('nope:0:0'), null);
  });

  it('a record with storedAt 25h old is not returned', async () => {
    const stale = makeRecord({ storedAt: new Date(Date.now() - RESEND_MAX_AGE_MS - 60_000).toISOString() });
    const key = resendKey(stale.chatId, stale.threadId, stale.updateId);
    // Write directly (bypassing putResend, which would stamp a fresh storedAt)
    // in the same on-disk shape putResend produces: a map keyed by resendKey.
    writeFileSync(join(home, 'telegram-resend.json'), JSON.stringify({ [key]: stale }), 'utf8');
    _resetResendStoreForTest();
    assert.equal(await takeResend(key), null);
  });

  it('a corrupt file yields an empty store', async () => {
    writeFileSync(join(home, 'telegram-resend.json'), 'not-json{{{', 'utf8');
    _resetResendStoreForTest();
    assert.equal(await takeResend('anything:0:0'), null);
    // Store still usable afterwards (corrupt file doesn't wedge the module).
    const rec = makeRecord({ updateId: 99 });
    await putResend(rec);
    const key = resendKey(rec.chatId, rec.threadId, rec.updateId);
    assert.deepEqual(await takeResend(key), rec);
  });

  it('two concurrent putResend calls both survive', async () => {
    const recA = makeRecord({ updateId: 1, userText: 'first' });
    const recB = makeRecord({ updateId: 2, userText: 'second' });
    await Promise.all([putResend(recA), putResend(recB)]);
    assert.deepEqual(await takeResend(resendKey(recA.chatId, recA.threadId, recA.updateId)), recA);
    assert.deepEqual(await takeResend(resendKey(recB.chatId, recB.threadId, recB.updateId)), recB);
  });

  it('survives a simulated restart (cache reset re-reads file)', async () => {
    const rec = makeRecord();
    await putResend(rec);
    _resetResendStoreForTest();
    const key = resendKey(rec.chatId, rec.threadId, rec.updateId);
    assert.deepEqual(await takeResend(key), rec);
  });
});
