import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  addPendingDispatch,
  removePendingDispatch,
  listPendingDispatches,
  pendingDispatchKey,
  PENDING_DISPATCH_MAX_AGE_MS,
  _resetPendingDispatchesForTest,
  type PendingDispatch,
} from '../pending-dispatches.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pa-pending-'));
  process.env.PA_HOME = home;
  _resetPendingDispatchesForTest();
});

afterEach(() => {
  delete process.env.PA_HOME;
  _resetPendingDispatchesForTest();
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

function makeRecord(overrides: Partial<PendingDispatch> = {}): PendingDispatch {
  return {
    updateId: 42,
    chatId: -100123,
    threadId: 5,
    messageId: 900,
    userText: 'go yes on that plan',
    startedAt: new Date().toISOString(),
    cwd: 'D:/Personal Assistant',
    session: { session_id: 'abc-123', worker: 'claude', started_at: new Date().toISOString() },
    ...overrides,
  };
}

describe('pendingDispatchKey', () => {
  it('is stable and unique per update', () => {
    assert.equal(pendingDispatchKey(-1, 2, 3), pendingDispatchKey(-1, 2, 3));
    assert.notEqual(pendingDispatchKey(-1, 2, 3), pendingDispatchKey(-1, 2, 4));
  });
});

describe('pending-dispatches store', () => {
  it('starts empty', async () => {
    assert.deepEqual(await listPendingDispatches(), []);
  });

  it('add → list → remove roundtrip', async () => {
    const rec = makeRecord();
    await addPendingDispatch(rec);
    const listed = await listPendingDispatches();
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], rec);
    await removePendingDispatch(pendingDispatchKey(rec.chatId, rec.threadId, rec.updateId));
    assert.deepEqual(await listPendingDispatches(), []);
  });

  it('survives a simulated restart (cache reset re-reads file)', async () => {
    const rec = makeRecord();
    await addPendingDispatch(rec);
    _resetPendingDispatchesForTest();
    const listed = await listPendingDispatches();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].userText, 'go yes on that plan');
  });

  it('keeps records for distinct updates independently', async () => {
    await addPendingDispatch(makeRecord({ updateId: 1 }));
    await addPendingDispatch(makeRecord({ updateId: 2, userText: 'second' }));
    assert.equal((await listPendingDispatches()).length, 2);
    await removePendingDispatch(pendingDispatchKey(-100123, 5, 1));
    const left = await listPendingDispatches();
    assert.equal(left.length, 1);
    assert.equal(left[0].updateId, 2);
  });

  it('drops records older than the TTL on load', async () => {
    const stale = makeRecord({ startedAt: new Date(Date.now() - PENDING_DISPATCH_MAX_AGE_MS - 60_000).toISOString() });
    const key = pendingDispatchKey(stale.chatId, stale.threadId, stale.updateId);
    writeFileSync(join(home, 'telegram-pending-dispatches.json'), JSON.stringify({ [key]: stale }), 'utf8');
    _resetPendingDispatchesForTest();
    assert.deepEqual(await listPendingDispatches(), []);
  });

  it('tolerates a corrupt store file (starts empty, then overwrites cleanly)', async () => {
    writeFileSync(join(home, 'telegram-pending-dispatches.json'), 'not-json{{{', 'utf8');
    _resetPendingDispatchesForTest();
    assert.deepEqual(await listPendingDispatches(), []);
    await addPendingDispatch(makeRecord());
    const raw = readFileSync(join(home, 'telegram-pending-dispatches.json'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));
  });

  it('removing an unknown key is a no-op', async () => {
    await assert.doesNotReject(removePendingDispatch('nope:0:0'));
  });

  // AI-095 follow-up (deep-recheck 2026-07-08, Phase 1A): the enqueue-time
  // placeholder has neither cwd nor session — cwd is optional in the type
  // specifically to allow this shape.
  it('accepts and round-trips a placeholder with no cwd/session', async () => {
    const placeholder: PendingDispatch = {
      updateId: 7, chatId: -100999, threadId: 0, messageId: 12,
      userText: 'do the thing', startedAt: new Date().toISOString(),
    };
    await addPendingDispatch(placeholder);
    const listed = await listPendingDispatches();
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], placeholder);
    assert.equal(listed[0].cwd, undefined);
    assert.equal(listed[0].session, undefined);
  });

  it('a legacy on-disk record with cwd still loads unchanged (backward compat)', async () => {
    const legacy = makeRecord(); // has cwd set, matching the pre-optional shape
    await addPendingDispatch(legacy);
    _resetPendingDispatchesForTest();
    const listed = await listPendingDispatches();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].cwd, 'D:/Personal Assistant');
  });
});
