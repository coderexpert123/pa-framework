import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import * as fsSync from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractFinalAssistantText,
  evaluatePendingDispatch,
  reapOrphanedDispatches,
  isTopicWorkerAliveByRegistry,
  TRANSCRIPT_QUIESCENT_MS,
  type ReaperDeps,
} from '../orphan-reaper.js';
import {
  addPendingDispatch,
  listPendingDispatches,
  _resetPendingDispatchesForTest,
  type PendingDispatch,
} from '../pending-dispatches.js';
import { deliveredKey, wasDelivered, markDelivered, _resetDeliveredCacheForTest } from '../delivered-store.js';
import { isTopicRecovering, _resetRecoveryGateForTest } from '../recovery-gate.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pa-reaper-'));
  process.env.PA_HOME = home;
  _resetPendingDispatchesForTest();
  _resetDeliveredCacheForTest();
  _resetRecoveryGateForTest();
});

afterEach(() => {
  delete process.env.PA_HOME;
  _resetPendingDispatchesForTest();
  _resetDeliveredCacheForTest();
  _resetRecoveryGateForTest();
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// extractFinalAssistantText
// ---------------------------------------------------------------------------

const T0 = '2026-07-03T15:00:00.000Z';

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}
function assistantLine(text: string, ts: string, extraBlocks: unknown[] = []): string {
  return line({ type: 'assistant', timestamp: ts, message: { content: [...extraBlocks, { type: 'text', text }] } });
}

describe('extractFinalAssistantText', () => {
  it('returns the LAST assistant text after the cutoff', () => {
    const jsonl =
      assistantLine('early', '2026-07-03T15:01:00Z') +
      line({ type: 'user', timestamp: '2026-07-03T15:02:00Z', message: { content: 'follow-up' } }) +
      assistantLine('final answer', '2026-07-03T15:03:00Z');
    const r = extractFinalAssistantText(jsonl, T0);
    assert.equal(r?.text, 'final answer');
  });

  it('ignores assistant entries at or before the cutoff', () => {
    const jsonl = assistantLine('old reply', '2026-07-03T14:59:00Z') + assistantLine('at cutoff', T0);
    assert.equal(extractFinalAssistantText(jsonl, T0), null);
  });

  it('skips tool_use-only assistant entries', () => {
    const jsonl =
      assistantLine('real text', '2026-07-03T15:01:00Z') +
      line({ type: 'assistant', timestamp: '2026-07-03T15:02:00Z', message: { content: [{ type: 'tool_use', name: 'Bash' }] } });
    assert.equal(extractFinalAssistantText(jsonl, T0)?.text, 'real text');
  });

  it('joins multiple text blocks and handles string content', () => {
    const jsonl =
      line({ type: 'assistant', timestamp: '2026-07-03T15:01:00Z', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }) +
      line({ type: 'assistant', timestamp: '2026-07-03T15:02:00Z', message: { content: 'plain string reply' } });
    assert.equal(extractFinalAssistantText(jsonl, T0)?.text, 'plain string reply');
  });

  it('survives malformed lines and non-assistant types', () => {
    const jsonl = 'garbage{{{\n' + line({ type: 'summary' }) + assistantLine('ok', '2026-07-03T15:01:00Z') + '\n';
    assert.equal(extractFinalAssistantText(jsonl, T0)?.text, 'ok');
  });

  it('returns null on an empty transcript', () => {
    assert.equal(extractFinalAssistantText('', T0), null);
  });
});

// ---------------------------------------------------------------------------
// evaluatePendingDispatch — injected deps
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<PendingDispatch> = {}): PendingDispatch {
  return {
    updateId: 7,
    chatId: -100555,
    threadId: 9,
    messageId: 321,
    userText: 'do the thing',
    startedAt: T0,
    cwd: 'D:/Personal Assistant',
    session: { session_id: 'sess-1', worker: 'claude', started_at: T0 },
    ...overrides,
  };
}

interface FakeDepsConfig {
  transcript?: { content: string; mtimeMs: number } | null;
  workerAlive?: boolean;
  nowMs?: number;
  sendResult?: boolean;
}

function makeFakeDeps(cfg: FakeDepsConfig): { deps: ReaperDeps; sent: Array<{ record: PendingDispatch; text: string }> } {
  const sent: Array<{ record: PendingDispatch; text: string }> = [];
  return {
    sent,
    deps: {
      send: async (record, text) => { sent.push({ record, text }); return cfg.sendResult ?? true; },
      readTranscript: async () => cfg.transcript ?? null,
      isTopicWorkerAlive: async () => cfg.workerAlive ?? false,
      now: () => cfg.nowMs ?? Date.now(),
    },
  };
}

const FAR_DEADLINE = Date.now() + 60 * 60 * 1000;

describe('evaluatePendingDispatch', () => {
  it('drops a record whose reply was already delivered (no send)', async () => {
    const rec = makeRecord();
    await addPendingDispatch(rec);
    await markDelivered(deliveredKey(rec.chatId, rec.threadId, rec.updateId));
    const { deps, sent } = makeFakeDeps({});
    const outcome = await evaluatePendingDispatch(rec, deps, FAR_DEADLINE);
    assert.equal(outcome, 'already-delivered');
    assert.equal(sent.length, 0);
    assert.deepEqual(await listPendingDispatches(), []);
  });

  it('sends a death notice for a non-recoverable dispatch (no session)', async () => {
    const rec = makeRecord({ session: undefined });
    await addPendingDispatch(rec);
    const { deps, sent } = makeFakeDeps({});
    const outcome = await evaluatePendingDispatch(rec, deps, FAR_DEADLINE);
    assert.equal(outcome, 'dead');
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('could not be recovered'));
    assert.ok(sent[0].text.includes('do the thing'), 'notice quotes the lost message');
    assert.deepEqual(await listPendingDispatches(), []);
    assert.equal(await wasDelivered(deliveredKey(rec.chatId, rec.threadId, rec.updateId)), true);
  });

  it('sends a death notice for a gemini session (recovery is claude-family only)', async () => {
    const rec = makeRecord({ session: { session_id: 'g-1', worker: 'gemini', started_at: T0 } });
    await addPendingDispatch(rec);
    const { deps, sent } = makeFakeDeps({});
    assert.equal(await evaluatePendingDispatch(rec, deps, FAR_DEADLINE), 'dead');
    assert.equal(sent.length, 1);
  });

  it('waits while the orphan worker is still alive', async () => {
    const rec = makeRecord();
    await addPendingDispatch(rec);
    const now = Date.now();
    const { deps, sent } = makeFakeDeps({
      workerAlive: true,
      transcript: { content: assistantLine('done!', '2026-07-03T15:10:00Z'), mtimeMs: now - TRANSCRIPT_QUIESCENT_MS - 1000 },
      nowMs: now,
    });
    assert.equal(await evaluatePendingDispatch(rec, deps, FAR_DEADLINE), 'waiting');
    assert.equal(sent.length, 0);
    assert.equal((await listPendingDispatches()).length, 1);
  });

  it('waits while the transcript is still being written (not quiescent)', async () => {
    const rec = makeRecord();
    await addPendingDispatch(rec);
    const now = Date.now();
    const { deps } = makeFakeDeps({
      workerAlive: false,
      transcript: { content: assistantLine('done!', '2026-07-03T15:10:00Z'), mtimeMs: now - 5000 },
      nowMs: now,
    });
    assert.equal(await evaluatePendingDispatch(rec, deps, FAR_DEADLINE), 'waiting');
  });

  it('recovers and delivers the final reply from a quiescent transcript', async () => {
    const rec = makeRecord();
    await addPendingDispatch(rec);
    const now = Date.now();
    const { deps, sent } = makeFakeDeps({
      workerAlive: false,
      transcript: { content: assistantLine('here is your answer', '2026-07-03T15:10:00Z'), mtimeMs: now - TRANSCRIPT_QUIESCENT_MS - 1000 },
      nowMs: now,
    });
    const outcome = await evaluatePendingDispatch(rec, deps, FAR_DEADLINE);
    assert.equal(outcome, 'recovered');
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('Recovered reply'));
    assert.ok(sent[0].text.includes('here is your answer'));
    assert.deepEqual(await listPendingDispatches(), []);
    assert.equal(await wasDelivered(deliveredKey(rec.chatId, rec.threadId, rec.updateId)), true);
  });

  it('strips a PA_META envelope from the recovered reply', async () => {
    const rec = makeRecord();
    await addPendingDispatch(rec);
    const now = Date.now();
    const replyWithMeta = 'the answer\n[PA_META]: {"actions":[{"type":"run_skill","skill":"reminders"}]}';
    const { deps, sent } = makeFakeDeps({
      workerAlive: false,
      transcript: { content: assistantLine(replyWithMeta, '2026-07-03T15:10:00Z'), mtimeMs: now - TRANSCRIPT_QUIESCENT_MS - 1000 },
      nowMs: now,
    });
    assert.equal(await evaluatePendingDispatch(rec, deps, FAR_DEADLINE), 'recovered');
    assert.ok(sent[0].text.includes('the answer'));
    assert.ok(!sent[0].text.includes('PA_META'), 'meta envelope stripped, never executed');
  });

  it('gives up with a death notice once the deadline passes and nothing is recoverable', async () => {
    const rec = makeRecord();
    await addPendingDispatch(rec);
    const now = Date.now();
    const { deps, sent } = makeFakeDeps({ workerAlive: false, transcript: null, nowMs: now });
    const outcome = await evaluatePendingDispatch(rec, deps, now - 1); // deadline already passed
    assert.equal(outcome, 'dead');
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('could not be recovered'));
  });

  it('past the deadline, a completed transcript is still recovered (no quiescence wait)', async () => {
    const rec = makeRecord();
    await addPendingDispatch(rec);
    const now = Date.now();
    const { deps, sent } = makeFakeDeps({
      workerAlive: false,
      transcript: { content: assistantLine('late but done', '2026-07-03T15:10:00Z'), mtimeMs: now - 1000 },
      nowMs: now,
    });
    const outcome = await evaluatePendingDispatch(rec, deps, now - 1);
    assert.equal(outcome, 'recovered');
    assert.ok(sent[0].text.includes('late but done'));
  });

  it('keeps the record when the recovered send fails (retry next poll)', async () => {
    const rec = makeRecord();
    await addPendingDispatch(rec);
    const now = Date.now();
    const { deps } = makeFakeDeps({
      workerAlive: false,
      transcript: { content: assistantLine('answer', '2026-07-03T15:10:00Z'), mtimeMs: now - TRANSCRIPT_QUIESCENT_MS - 1000 },
      nowMs: now,
      sendResult: false,
    });
    assert.equal(await evaluatePendingDispatch(rec, deps, FAR_DEADLINE), 'waiting');
    assert.equal((await listPendingDispatches()).length, 1);
    assert.equal(await wasDelivered(deliveredKey(rec.chatId, rec.threadId, rec.updateId)), false);
  });

  it('keeps the record when the DEATH-NOTICE send fails (a failed notice must not settle as delivered)', async () => {
    const rec = makeRecord({ session: undefined }); // non-recoverable → death-notice path
    await addPendingDispatch(rec);
    const { deps, sent } = makeFakeDeps({ sendResult: false });
    assert.equal(await evaluatePendingDispatch(rec, deps, FAR_DEADLINE), 'waiting',
      'failed notice retries next poll instead of finishing');
    assert.equal(sent.length, 1, 'the notice send was attempted');
    assert.equal((await listPendingDispatches()).length, 1, 'record stays on disk for retry / next restart');
    assert.equal(await wasDelivered(deliveredKey(rec.chatId, rec.threadId, rec.updateId)), false,
      'must not be marked delivered — that would foreclose recovery forever');
  });
});

// ---------------------------------------------------------------------------
// isTopicWorkerAliveByRegistry — wrapper-dead / descendant-alive gap
// ---------------------------------------------------------------------------

describe('isTopicWorkerAliveByRegistry', () => {
  const { mkdirSync, writeFileSync: wf } = fsSync;

  function writeEntry(entry: Record<string, unknown>): void {
    const dir = join(home, 'worker-pids');
    mkdirSync(dir, { recursive: true });
    wf(join(dir, `${entry.pid}.json`), JSON.stringify(entry), 'utf8');
  }

  it('false when no registry entry matches the topic', async () => {
    assert.equal(await isTopicWorkerAliveByRegistry(makeRecord()), false);
  });

  it('true when the registered wrapper pid is alive', async () => {
    writeEntry({ pid: process.pid, spawnedBy: 1, worker: 'claude', skill: 'topic--100555_9', startedAt: T0 });
    assert.equal(await isTopicWorkerAliveByRegistry(makeRecord()), true);
  });

  it('true when the wrapper is dead but a descendant is alive (2026-07-04 gap)', async () => {
    writeEntry({ pid: 999998, spawnedBy: 1, worker: 'claude', skill: 'topic--100555_9', startedAt: T0, descendants: [999997, process.pid] });
    assert.equal(await isTopicWorkerAliveByRegistry(makeRecord()), true);
  });

  it('false when wrapper and all descendants are dead', async () => {
    writeEntry({ pid: 999998, spawnedBy: 1, worker: 'claude', skill: 'topic--100555_9', startedAt: T0, descendants: [999997, 999996] });
    assert.equal(await isTopicWorkerAliveByRegistry(makeRecord()), false);
  });
});

// ---------------------------------------------------------------------------
// reapOrphanedDispatches — loop orchestration
// ---------------------------------------------------------------------------

describe('reapOrphanedDispatches', () => {
  it('returns immediately when nothing is pending', async () => {
    let slept = 0;
    await reapOrphanedDispatches('token', {
      deps: makeFakeDeps({}).deps,
      sleep: async () => { slept++; },
    });
    assert.equal(slept, 0);
  });

  it('polls a waiting record until it completes, then delivers', async () => {
    const rec = makeRecord();
    await addPendingDispatch(rec);
    const sent: string[] = [];
    let polls = 0;
    const now = Date.now();
    const deps: ReaperDeps = {
      send: async (_r, text) => { sent.push(text); return true; },
      // Worker "finishes" after two polls; transcript then quiescent.
      isTopicWorkerAlive: async () => polls < 2,
      readTranscript: async () => ({
        content: assistantLine('finished after wait', '2026-07-03T15:20:00Z'),
        mtimeMs: now - TRANSCRIPT_QUIESCENT_MS - 1000,
      }),
      now: () => now,
    };
    await reapOrphanedDispatches('token', { deps, pollMs: 1, sleep: async () => { polls++; } });
    assert.equal(sent.length, 1);
    assert.ok(sent[0].includes('finished after wait'));
    assert.deepEqual(await listPendingDispatches(), []);
  });

  it('keeps the typing indicator alive for topics still being recovered', async () => {
    const rec = makeRecord();
    await addPendingDispatch(rec);
    let typing = 0;
    let polls = 0;
    const now = Date.now();
    const deps: ReaperDeps = {
      send: async () => true,
      isTopicWorkerAlive: async () => polls < 2, // waits two passes
      readTranscript: async () => ({
        content: assistantLine('done', '2026-07-03T15:20:00Z'),
        mtimeMs: now - TRANSCRIPT_QUIESCENT_MS - 1000,
      }),
      now: () => now,
      sendTyping: async () => { typing++; },
    };
    await reapOrphanedDispatches('token', { deps, pollMs: 1, sleep: async () => { polls++; } });
    assert.ok(typing >= 2, `typing refreshed while waiting (got ${typing})`);
  });

  it('settles everything with death notices when the deadline expires', async () => {
    await addPendingDispatch(makeRecord({ updateId: 1 }));
    await addPendingDispatch(makeRecord({ updateId: 2, session: undefined }));
    const sent: string[] = [];
    let fakeNow = Date.now();
    const deps: ReaperDeps = {
      send: async (_r, text) => { sent.push(text); return true; },
      isTopicWorkerAlive: async () => true, // never finishes
      readTranscript: async () => null,
      now: () => fakeNow,
    };
    await reapOrphanedDispatches('token', {
      deps,
      maxWaitMs: 10_000,
      pollMs: 1,
      sleep: async () => { fakeNow += 60_000; }, // each poll jumps past the deadline
    });
    assert.equal(sent.length, 2);
    assert.ok(sent.every((t) => t.includes('could not be recovered')));
    assert.deepEqual(await listPendingDispatches(), []);
  });
});

// ---------------------------------------------------------------------------
// recovery-gate lifecycle (AI-095 follow-up, deep-recheck 2026-07-08, Phase 1B)
// ---------------------------------------------------------------------------

describe('reapOrphanedDispatches — recovery gate lifecycle', () => {
  it('marks the topic while a record is in-flight and clears it once settled', async () => {
    const rec = makeRecord();
    await addPendingDispatch(rec);
    let polls = 0;
    const now = Date.now();
    const deps: ReaperDeps = {
      send: async () => true,
      isTopicWorkerAlive: async () => polls < 2,
      readTranscript: async () => ({ content: assistantLine('finished after wait', '2026-07-03T15:20:00Z'), mtimeMs: now - TRANSCRIPT_QUIESCENT_MS - 1000 }),
      now: () => now,
    };
    let sawMarkedMidFlight = false;
    await reapOrphanedDispatches('token', {
      deps, pollMs: 1,
      sleep: async () => { polls++; sawMarkedMidFlight = sawMarkedMidFlight || isTopicRecovering('-100555_9'); },
    });
    assert.ok(sawMarkedMidFlight, 'topic should have been marked while the record was still in flight');
    assert.equal(isTopicRecovering('-100555_9'), false, 'topic cleared once the record settled');
  });

  it('clears on the give-up-at-deadline path even when nothing ever settles', async () => {
    await addPendingDispatch(makeRecord({ updateId: 1, chatId: -100555, threadId: 9 }));
    let fakeNow = Date.now();
    const deps: ReaperDeps = {
      send: async () => false, // every send fails — the record never settles
      isTopicWorkerAlive: async () => true,
      readTranscript: async () => null,
      now: () => fakeNow,
    };
    await reapOrphanedDispatches('token', {
      deps, maxWaitMs: 10_000, pollMs: 1,
      sleep: async () => { fakeNow += 60_000; },
    });
    assert.equal(isTopicRecovering('-100555_9'), false, 'the finally() backstop must clear the gate even though the record itself stays unsettled');
    assert.equal((await listPendingDispatches()).length, 1, 'the unsettled record itself stays on disk for the next restart');
  });

  it('clears even when evaluation throws on every attempt', async () => {
    await addPendingDispatch(makeRecord({ updateId: 1, chatId: -100555, threadId: 9 }));
    let fakeNow = Date.now();
    const deps: ReaperDeps = {
      send: async () => { throw new Error('boom'); },
      isTopicWorkerAlive: async () => { throw new Error('boom'); },
      readTranscript: async () => { throw new Error('boom'); },
      now: () => fakeNow,
    };
    await reapOrphanedDispatches('token', {
      deps, maxWaitMs: 10_000, pollMs: 1,
      sleep: async () => { fakeNow += 60_000; },
    });
    assert.equal(isTopicRecovering('-100555_9'), false, 'gate must clear even when every evaluation attempt throws');
  });

  it('marks nothing when the pending-dispatch store is empty', async () => {
    await reapOrphanedDispatches('token', { deps: makeFakeDeps({}).deps, sleep: async () => {} });
    assert.equal(isTopicRecovering('-100555_9'), false);
  });

  it('two DIFFERENT topics: the fast-settling one clears after round 1, the slow one stays marked', async () => {
    const fast = makeRecord({ updateId: 1, chatId: -100555, threadId: 9, session: undefined }); // non-recoverable → settles round 1
    const slow = makeRecord({ updateId: 2, chatId: -100777, threadId: 9 }); // different topic, settles later
    await addPendingDispatch(fast);
    await addPendingDispatch(slow);
    const now = Date.now();
    let slowPolls = 0;
    const deps: ReaperDeps = {
      send: async () => true,
      isTopicWorkerAlive: async (r) => r.chatId === -100777 && slowPolls < 3,
      readTranscript: async (r) => r.chatId === -100777
        ? { content: assistantLine('slow done', '2026-07-03T15:20:00Z'), mtimeMs: now - TRANSCRIPT_QUIESCENT_MS - 1000 }
        : null,
      now: () => now,
    };
    let sawFastClearedAfterRound1 = false;
    let sawSlowStillMarkedAfterRound1 = false;
    await reapOrphanedDispatches('token', {
      deps, pollMs: 1,
      sleep: async () => {
        slowPolls++;
        if (slowPolls === 1) {
          sawFastClearedAfterRound1 = !isTopicRecovering('-100555_9');
          sawSlowStillMarkedAfterRound1 = isTopicRecovering('-100777_9');
        }
      },
    });
    assert.ok(sawFastClearedAfterRound1, 'the fast topic must clear after round 1 — well before the whole call resolves — not wait on the unrelated slow topic');
    assert.ok(sawSlowStillMarkedAfterRound1, 'the slow topic must still be marked after round 1 (it has not settled yet)');
    assert.equal(isTopicRecovering('-100555_9'), false);
    assert.equal(isTopicRecovering('-100777_9'), false, 'cleared by the time the whole call resolves');
  });

  it('two records sharing ONE topic: the gate stays marked until BOTH settle — never clears prematurely', async () => {
    const rec1 = makeRecord({ updateId: 1, chatId: -100555, threadId: 9, session: undefined }); // settles round 1
    const rec2 = makeRecord({ updateId: 2, chatId: -100555, threadId: 9 }); // SAME topic, settles later
    await addPendingDispatch(rec1);
    await addPendingDispatch(rec2);
    const now = Date.now();
    let rec2Polls = 0;
    const deps: ReaperDeps = {
      send: async () => true,
      isTopicWorkerAlive: async (r) => r.updateId === 2 && rec2Polls < 2,
      readTranscript: async (r) => r.updateId === 2
        ? { content: assistantLine('rec2 done', '2026-07-03T15:20:00Z'), mtimeMs: now - TRANSCRIPT_QUIESCENT_MS - 1000 }
        : null,
      now: () => now,
    };
    let sawStillMarkedAfterRound1 = false;
    await reapOrphanedDispatches('token', {
      deps, pollMs: 1,
      sleep: async () => {
        rec2Polls++;
        if (rec2Polls === 1) sawStillMarkedAfterRound1 = isTopicRecovering('-100555_9');
      },
    });
    assert.ok(sawStillMarkedAfterRound1, 'the topic must stay marked after round 1 — rec1 settled but rec2 (same topic) is still pending. A naive per-individual-record-mid-loop implementation would have cleared it prematurely here.');
    assert.equal(isTopicRecovering('-100555_9'), false, 'cleared once BOTH records for the topic have settled');
  });
});
