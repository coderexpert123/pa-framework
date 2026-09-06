import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  addPendingDispatch,
  removePendingDispatch,
  updatePendingDispatch,
  listPendingDispatches,
  absorbHeldDispatchRecords,
  pendingDispatchKey,
  PENDING_DISPATCH_MAX_AGE_MS,
  _resetPendingDispatchesForTest,
  type PendingDispatch,
} from '../pending-dispatches.js';
import { waitForDrain } from './test-teardown-guard.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pa-pending-'));
  process.env.PA_HOME = home;
  _resetPendingDispatchesForTest();
});

afterEach(async () => {
  await waitForDrain();
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
    cwd: 'C:/pa-checkout',
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
    assert.equal(listed[0].cwd, 'C:/pa-checkout');
  });

  // WP1: updatePendingDispatch tests
  it('updatePendingDispatch merges fields into an existing record', async () => {
    const rec = makeRecord();
    const key = pendingDispatchKey(rec.chatId, rec.threadId, rec.updateId);
    await addPendingDispatch(rec);
    await updatePendingDispatch(key, { teePath: '/tee/test.out', workerName: 'agy' });
    _resetPendingDispatchesForTest();
    const listed = await listPendingDispatches();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].teePath, '/tee/test.out');
    assert.equal(listed[0].workerName, 'agy');
    // Original fields preserved
    assert.equal(listed[0].userText, 'go yes on that plan');
    assert.equal(listed[0].session?.session_id, 'abc-123');
  });

  it('updatePendingDispatch is a no-op for a removed record', async () => {
    const rec = makeRecord();
    const key = pendingDispatchKey(rec.chatId, rec.threadId, rec.updateId);
    await addPendingDispatch(rec);
    await removePendingDispatch(key);
    // Should not throw even though record is gone
    await assert.doesNotReject(updatePendingDispatch(key, { teePath: '/tee/test.out', workerName: 'agy' }));
    // Store stays empty
    assert.deepEqual(await listPendingDispatches(), []);
  });

  it('updatePendingDispatch survives cache reset (disk roundtrip)', async () => {
    const rec = makeRecord();
    const key = pendingDispatchKey(rec.chatId, rec.threadId, rec.updateId);
    await addPendingDispatch(rec);
    await updatePendingDispatch(key, { teePath: '/tee/test.out', workerName: 'claude' });
    // Cache reset forces disk reload
    _resetPendingDispatchesForTest();
    const listed = await listPendingDispatches();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].teePath, '/tee/test.out');
    assert.equal(listed[0].workerName, 'claude');
  });

  it('updatePendingDispatch persists the userTextSettled marker through a simulated restart (Edit A shape)', async () => {
    const rec = makeRecord();
    const key = pendingDispatchKey(rec.chatId, rec.threadId, rec.updateId);
    await addPendingDispatch(rec);
    await updatePendingDispatch(key, { userText: '[Voice message] hello', userTextSettled: true });
    _resetPendingDispatchesForTest();
    const listed = await listPendingDispatches();
    assert.equal(listed.length, 1);
    const updated = listed[0];
    assert.equal(updated.userText, '[Voice message] hello');
    assert.equal(updated.userTextSettled, true);
    // Original fields preserved
    assert.equal(updated.cwd, 'C:/pa-checkout');
    assert.equal(updated.session?.session_id, 'abc-123');
  });

  it('backward compat: loading an old on-disk record without new fields still works', async () => {
    // Write a JSON file directly with a record that has no teePath/workerName
    const legacy = makeRecord();
    delete (legacy as any).teePath;
    delete (legacy as any).workerName;
    const key = pendingDispatchKey(legacy.chatId, legacy.threadId, legacy.updateId);
    writeFileSync(join(home, 'telegram-pending-dispatches.json'), JSON.stringify({ [key]: legacy }), 'utf8');
    _resetPendingDispatchesForTest();
    const listed = await listPendingDispatches();
    assert.equal(listed.length, 1);
    // New fields should be undefined, not throw
    assert.equal(listed[0].teePath, undefined);
    assert.equal(listed[0].workerName, undefined);
    // Original fields intact
    assert.equal(listed[0].userText, 'go yes on that plan');
    assert.equal(listed[0].session?.session_id, 'abc-123');
  });
});

// AI-208 WP-4: durable held records (steer/stop drain leaves the transcript on
// disk flagged heldForTopic; the topic's next dispatch absorbs it here).
describe('absorbHeldDispatchRecords', () => {
  it('returns and clears held records in startedAt order', async () => {
    const t0 = new Date(Date.now() - 60_000).toISOString();
    const t1 = new Date(Date.now() - 30_000).toISOString();
    const t2 = new Date(Date.now() - 10_000).toISOString();
    // Enqueue out of startedAt order on purpose — absorption must sort.
    await addPendingDispatch(makeRecord({ updateId: 3, startedAt: t2, userText: 'third', heldForTopic: true, heldAt: t2 }));
    await addPendingDispatch(makeRecord({ updateId: 1, startedAt: t0, userText: 'first', heldForTopic: true, heldAt: t0 }));
    // A held record for a DIFFERENT chat+thread must not be absorbed.
    await addPendingDispatch(makeRecord({ updateId: 9, chatId: -100999, threadId: 5, startedAt: t1, userText: 'other topic', heldForTopic: true, heldAt: t1 }));

    const texts = await absorbHeldDispatchRecords(-100123, 5);
    assert.deepEqual(texts, ['first', 'third']);

    // Consumed exactly once: flags cleared, so a second absorb returns nothing.
    const listed = await listPendingDispatches();
    assert.equal(listed.find((r) => r.updateId === 1)?.heldForTopic, false);
    assert.equal(listed.find((r) => r.updateId === 3)?.heldForTopic, false);
    assert.deepEqual(await absorbHeldDispatchRecords(-100123, 5), []);
  });

  it('non-held records untouched', async () => {
    const t0 = new Date(Date.now() - 60_000).toISOString();
    const t1 = new Date(Date.now() - 30_000).toISOString();
    // Same chat+thread but never held (a normal dispatch record).
    await addPendingDispatch(makeRecord({ updateId: 2, startedAt: t1, userText: 'plain dispatch' }));
    // Held record in another topic, to prove filtering is by chat+thread too.
    await addPendingDispatch(makeRecord({ updateId: 9, chatId: -100999, threadId: 5, startedAt: t0, userText: 'other topic', heldForTopic: true, heldAt: t0 }));

    const texts = await absorbHeldDispatchRecords(-100123, 5);
    assert.deepEqual(texts, []);

    const listed = await listPendingDispatches();
    const plain = listed.find((r) => r.updateId === 2);
    assert.equal(plain?.userText, 'plain dispatch'); // survived untouched
    assert.equal(plain?.heldForTopic, undefined);    // never flagged
    // The other topic's held record is still held, ready for ITS next dispatch.
    assert.equal(listed.find((r) => r.updateId === 9)?.heldForTopic, true);
  });

  it('absorbHeldDispatchRecords skips and consumes records whose updateId is excluded (fix-wave M1)', async () => {
    const t0 = new Date(Date.now() - 60_000).toISOString();
    const t1 = new Date(Date.now() - 30_000).toISOString();
    const t2 = new Date(Date.now() - 10_000).toISOString();
    // updateId 1 was already carried into the prompt by the in-memory
    // absorbHeldEntries half (its HeldItem carried updateId 1) — absorbing its
    // text again here would fold the transcript twice.
    await addPendingDispatch(makeRecord({ updateId: 1, startedAt: t0, userText: 'already in the prompt', heldForTopic: true, heldAt: t0 }));
    await addPendingDispatch(makeRecord({ updateId: 3, startedAt: t2, userText: 'record-only', heldForTopic: true, heldAt: t2 }));

    const texts = await absorbHeldDispatchRecords(-100123, 5, new Set([1]));
    assert.deepEqual(texts, ['record-only'], 'the excluded record emits NO text');

    // Still consumed: both records are unflagged, so a second absorb (no
    // exclusion) cannot resurrect the excluded transcript either.
    const listed = await listPendingDispatches();
    assert.equal(listed.find((r) => r.updateId === 1)?.heldForTopic, false);
    assert.equal(listed.find((r) => r.updateId === 3)?.heldForTopic, false);
    assert.deepEqual(await absorbHeldDispatchRecords(-100123, 5), []);
  });
});
