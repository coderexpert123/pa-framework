import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import * as fsSync from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractFinalAssistantText,
  extractTeeResult,
  evaluatePendingDispatch,
  reapOrphanedDispatches,
  isTopicWorkerAliveByRegistry,
  findTeePathByRegistry,
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
import { takeResend, resendKey, _resetResendStoreForTest } from '../resend-store.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pa-reaper-'));
  process.env.PA_HOME = home;
  _resetPendingDispatchesForTest();
  _resetDeliveredCacheForTest();
  _resetRecoveryGateForTest();
  _resetResendStoreForTest();
});

afterEach(() => {
  delete process.env.PA_HOME;
  _resetPendingDispatchesForTest();
  _resetDeliveredCacheForTest();
  _resetRecoveryGateForTest();
  _resetResendStoreForTest();
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

  it('skips a mid-turn narration entry that ALSO contains a tool_use block (2026-07-27 incident)', () => {
    // The crash happened right after the model wrote narration + queued a
    // tool call, before any tool_result or further assistant text landed.
    // That narration must not be harvested as a "final reply".
    const jsonl =
      assistantLine('real text', '2026-07-03T15:01:00Z') +
      line({
        type: 'assistant',
        timestamp: '2026-07-03T15:02:00Z',
        message: { content: [{ type: 'text', text: 'Now let me look at the actual ref command implementation to find the hang.' }, { type: 'tool_use', name: 'Read' }] },
      });
    assert.equal(extractFinalAssistantText(jsonl, T0)?.text, 'real text');
  });

  it('skips [text, tool_use] — tool_use after last text means mid-turn (WPB5 position-aware fix)', () => {
    // A tool_use appearing AFTER the last text block indicates the turn
    // wasn't finished — the model intended to call a tool and continue.
    const jsonl = line({
      type: 'assistant',
      timestamp: '2026-08-17T12:00:00Z',
      message: { content: [{ type: 'text', text: 'Let me check the file.' }, { type: 'tool_use', name: 'Read' }] },
    });
    assert.equal(extractFinalAssistantText(jsonl, T0), null);
  });

  it('delivers text for [tool_use, text] — tool_use before text means completed turn (WPB5 position-aware fix)', () => {
    // A tool_use appearing BEFORE a final text block means the tool call
    // finished and the model then wrote the actual answer.
    const jsonl = line({
      type: 'assistant',
      timestamp: '2026-08-17T12:00:00Z',
      message: { content: [{ type: 'tool_use', name: 'Bash' }, { type: 'text', text: 'The file contains 42 lines.' }] },
    });
    assert.equal(extractFinalAssistantText(jsonl, T0)?.text, 'The file contains 42 lines.');
  });

  it('delivers last text for [text, tool_use, text] — tool_use between texts, final text wins (WPB5 position-aware fix)', () => {
    // A tool_use between text blocks with a final text block means the
    // turn completed after the tool call — harvest the final answer.
    const jsonl = line({
      type: 'assistant',
      timestamp: '2026-08-17T12:00:00Z',
      message: { content: [{ type: 'text', text: 'First thought.' }, { type: 'tool_use', name: 'Read' }, { type: 'text', text: 'Final answer after tool use.' }] },
    });
    assert.equal(extractFinalAssistantText(jsonl, T0)?.text, 'Final answer after tool use.');
  });

  it('skips [text, tool_use] — tool_use after last text means mid-turn', () => {
    // The crash happened right after the model wrote narration + queued a
    // tool call, before any tool_result or further assistant text landed.
    // That narration must not be harvested as a "final reply".
    const jsonl =
      assistantLine('real text', '2026-07-03T15:01:00Z') +
      line({
        type: 'assistant',
        timestamp: '2026-07-03T15:02:00Z',
        message: { content: [{ type: 'text', text: 'Now let me look at the actual ref command implementation to find the hang.' }, { type: 'tool_use', name: 'Read' }] },
      });
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

function makeFakeDeps(cfg: FakeDepsConfig): { deps: ReaperDeps; sent: Array<{ record: PendingDispatch; text: string; replyMarkup?: unknown }> } {
  const sent: Array<{ record: PendingDispatch; text: string; replyMarkup?: unknown }> = [];
  return {
    sent,
    deps: {
      send: async (record, text, replyMarkup) => { sent.push({ record, text, replyMarkup }); return cfg.sendResult ?? true; },
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

  it('death-notice path stores a resend record and passes a resend keyboard (WP-B3)', async () => {
    const rec = makeRecord({ session: undefined });
    await addPendingDispatch(rec);
    const { deps, sent } = makeFakeDeps({});
    const outcome = await evaluatePendingDispatch(rec, deps, FAR_DEADLINE);
    assert.equal(outcome, 'dead');
    assert.equal(sent.length, 1);

    // The resend record was written BEFORE the death notice was sent, keyed by
    // the pending-dispatch's own (chatId, threadId, updateId).
    const stored = await takeResend(resendKey(rec.chatId, rec.threadId, rec.updateId));
    assert.ok(stored, 'resend-store should hold the original message for the Resend button');
    assert.equal(stored?.chatId, rec.chatId);
    assert.equal(stored?.threadId, rec.threadId);
    assert.equal(stored?.updateId, rec.updateId);
    assert.equal(stored?.messageId, rec.messageId);
    assert.equal(stored?.userText, rec.userText);

    // The keyboard passed to send() carries the rs: callback for this dispatch.
    const kb = sent[0].replyMarkup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined;
    assert.ok(kb, 'a resend keyboard should be passed to send()');
    const buttons = kb!.inline_keyboard.flat();
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].callback_data, `rs:${rec.chatId}:${rec.threadId}:${rec.updateId}`);
  });

  it('sends a death notice for an agy session (recovery is claude-family only)', async () => {
    const rec = makeRecord({ session: { session_id: 'g-1', worker: 'agy', started_at: T0 } });
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

  // --------------------------------------------------------------------
  // WP3: worker alive FIRST check (decision tree rewrite)
  // --------------------------------------------------------------------

  it('worker alive + no result yet → waiting (non-recoverable record, no session)', async () => {
    // A codex dispatch (not in CLAUDE_FAMILY) with no tee — the OLD
    // code would have sent a death notice immediately. The new code checks
    // worker alive first and waits.
    const rec = makeRecord({ session: { session_id: 'c-1', worker: 'codex', started_at: T0 } });
    await addPendingDispatch(rec);
    const { deps, sent } = makeFakeDeps({
      workerAlive: true,
      // No transcript (codex has no readable transcript path)
      // No tee
    });
    assert.equal(await evaluatePendingDispatch(rec, deps, FAR_DEADLINE), 'waiting');
    assert.equal(sent.length, 0);
  });

  it('fresh dispatch placeholder (no session, no tee) + worker alive → waiting', async () => {
    const rec = makeRecord({ session: undefined });
    await addPendingDispatch(rec);
    const { deps, sent } = makeFakeDeps({
      workerAlive: true,
    });
    assert.equal(await evaluatePendingDispatch(rec, deps, FAR_DEADLINE), 'waiting');
    assert.equal(sent.length, 0);
  });

  it('codex dispatch + worker dead + no tee → death notice (no recovery source)', async () => {
    const rec = makeRecord({ session: { session_id: 'c-1', worker: 'codex', started_at: T0 } });
    await addPendingDispatch(rec);
    const { deps, sent } = makeFakeDeps({ workerAlive: false });
    assert.equal(await evaluatePendingDispatch(rec, deps, FAR_DEADLINE), 'dead');
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('could not be recovered'));
  });

  // --------------------------------------------------------------------
  // WP3: tee file from pending dispatch (not registry)
  // --------------------------------------------------------------------

  it('reads tee from pending dispatch when worker-pids entry is gone', async () => {
    const rec = makeRecord({ session: { session_id: 'g-1', worker: 'agy', started_at: T0 }, teePath: '/logs/test.out' });
    await addPendingDispatch(rec);
    const { deps, sent } = makeFakeDeps({
      workerAlive: false,
      sendResult: true,
    });
    // Add readFile dep to return tee content
    (deps as any).readFile = async () => '{"event":"result","result":{"status":"SUCCESS","response":"tee reply"}}';
    assert.equal(await evaluatePendingDispatch(rec, deps, FAR_DEADLINE), 'recovered');
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('tee reply'));
  });

  // --------------------------------------------------------------------
  // WP3: native resume re-dispatch
  // --------------------------------------------------------------------

  it('native resume fires when worker dead + no result + session exists', async () => {
    const rec = makeRecord({ session: { session_id: 's-1', worker: 'agy', started_at: T0 } });
    await addPendingDispatch(rec);
    let redispatched = false;
    const { deps, sent } = makeFakeDeps({
      workerAlive: false,
      sendResult: true,
    });
    (deps as any).redispatchWithResume = async () => { redispatched = true; return 're-dispatched output'; };
    assert.equal(await evaluatePendingDispatch(rec, deps, FAR_DEADLINE), 'recovered');
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('re-dispatched'));
    assert.ok(redispatched);
  });

  it('native resume skipped when session has no session_id', async () => {
    const rec = makeRecord({ session: { session_id: '', worker: 'agy', started_at: T0 } });
    await addPendingDispatch(rec);
    let redispatched = false;
    const { deps, sent } = makeFakeDeps({
      workerAlive: false,
      sendResult: true,
    });
    (deps as any).redispatchWithResume = async () => { redispatched = true; return 'output'; };
    // No session_id → skip native resume → death notice
    assert.equal(await evaluatePendingDispatch(rec, deps, FAR_DEADLINE), 'dead');
    assert.ok(!redispatched, 'empty session_id must skip re-dispatch');
  });

  it('re-dispatch attempted, returns null → death notice (not waiting loop)', async () => {
    const rec = makeRecord({ session: { session_id: 's-1', worker: 'claude', started_at: T0 } });
    await addPendingDispatch(rec);
    let redispatched = false;
    const { deps, sent } = makeFakeDeps({
      workerAlive: false,
      sendResult: true,
    });
    (deps as any).redispatchWithResume = async () => { redispatched = true; return null; };
    // Re-dispatch IS attempted (returns null) → falls through to death notice
    const outcome = await evaluatePendingDispatch(rec, deps, FAR_DEADLINE);
    assert.equal(outcome, 'dead');
    assert.ok(redispatched, 'resume was attempted before falling through to death notice');
  });

  it('native resume skipped when no session at all', async () => {
    const rec = makeRecord({ session: undefined });
    await addPendingDispatch(rec);
    let redispatched = false;
    const { deps, sent } = makeFakeDeps({
      workerAlive: false,
      sendResult: true,
    });
    (deps as any).redispatchWithResume = async () => { redispatched = true; return 'output'; };
    assert.equal(await evaluatePendingDispatch(rec, deps, FAR_DEADLINE), 'dead');
    assert.ok(!redispatched);
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

// ---------------------------------------------------------------------------
// extractTeeResult (WP2: NDJSON + plain-text fallback per §0)
// ---------------------------------------------------------------------------

describe('extractTeeResult', () => {
  it('returns the last result event text from NDJSON', () => {
    const ndjson = [
      '{"type":"assistant","content":"first"}',
      '{"type":"result","result":"answer one"}',
      '{"type":"assistant","content":"middle"}',
      '{"type":"result","result":"final answer"}',
    ].join('\n');
    assert.equal(extractTeeResult(ndjson), 'final answer');
  });

  it('returns null on empty input', () => {
    assert.equal(extractTeeResult(''), null);
  });

  it('returns null when no result event exists', () => {
    const ndjson = [
      '{"type":"assistant","content":"text"}',
      '{"type":"tool_result","content":"tool output"}',
    ].join('\n');
    assert.equal(extractTeeResult(ndjson), null);
  });

  it('handles malformed JSON lines gracefully (skips them)', () => {
    const ndjson = [
      'garbage{{{',
      '{"type":"result","result":"valid"}',
      'more garbage',
    ].join('\n');
    assert.equal(extractTeeResult(ndjson), 'valid');
  });

  it('handles mixed events (tool_result, assistant, result) — extracts only result', () => {
    const ndjson = [
      '{"type":"tool_result","content":"tool output"}',
      '{"type":"assistant","content":"assistant spoke"}',
      '{"type":"result","result":"the answer"}',
    ].join('\n');
    assert.equal(extractTeeResult(ndjson), 'the answer');
  });

  it('falls back to plain text when NO line parses as JSON', () => {
    const plainText = 'plain old stdout\nno json here';
    assert.equal(extractTeeResult(plainText), 'plain old stdout\nno json here');
  });

  it('returns null for whitespace-only plain text', () => {
    assert.equal(extractTeeResult('   \n  \n  '), null);
  });

  it('handles NDJSON-without-result → null (falls through to death notice)', () => {
    const ndjson = [
      '{"type":"assistant","content":"something"}',
      '{"type":"tool_result","content":"tool"}',
    ].join('\n');
    assert.equal(extractTeeResult(ndjson), null);
  });

  it('extractTeeResult: agy stream-json event.event shape', () => {
    const ndjson = [
      '{"event":"init","conversation_id":"abc"}',
      '{"event":"result","result":{"status":"SUCCESS","response":"hello"}}',
    ].join('\n');
    assert.equal(extractTeeResult(ndjson), 'hello');
  });

  it('extractTeeResult: agy stream-json with non-SUCCESS status', () => {
    const ndjson = [
      '{"event":"init","conversation_id":"abc"}',
      '{"event":"result","result":{"status":"ERROR","response":"hello"}}',
    ].join('\n');
    assert.equal(extractTeeResult(ndjson), 'hello', 'extracts response regardless of status');
  });

  it('extractTeeResult: agy stream-json with empty response falls through', () => {
    const ndjson = [
      '{"event":"init","conversation_id":"abc"}',
      '{"event":"result","result":{"status":"SUCCESS","response":""}}',
    ].join('\n');
    assert.equal(extractTeeResult(ndjson), null, 'empty response treated as no-result');
  });

  it('extractTeeResult: agy stream-json mixed with event.type lines', () => {
    const ndjson = [
      '{"type":"result","result":"codex reply"}',
      '{"event":"result","result":{"status":"SUCCESS","response":"agy reply"}}',
    ].join('\n');
    assert.equal(extractTeeResult(ndjson), 'agy reply', 'last-writer wins when both shapes match');
  });
});

// ---------------------------------------------------------------------------
// evaluatePendingDispatch — tee-fallback branch (WP2)
// ---------------------------------------------------------------------------

describe('evaluatePendingDispatch — tee-fallback (agy)', () => {
  function makeFakeDepsWithTee(cfg: FakeDepsConfig & { teePath?: string | null; teeContent?: string }): { deps: ReaperDeps; sent: Array<{ record: PendingDispatch; text: string }> } {
    const base = makeFakeDeps(cfg);
    const teeFile = cfg.teePath && cfg.teeContent !== undefined ? cfg.teePath : null;
    const teeContent = cfg.teeContent ?? '';
    return {
      sent: base.sent,
      deps: {
        ...base.deps,
        readTeePath: async () => teeFile,
        readFile: async (path: string) => {
          if (path === teeFile) return teeContent;
          throw new Error('Unexpected readFile path');
        },
      },
    };
  }

  it('agy dispatch + teePath + worker dead + non-empty tee → recovered reply delivered once', async () => {
    const rec = makeRecord({ session: { session_id: 'g-1', worker: 'agy', started_at: T0 } });
    await addPendingDispatch(rec);
    const { deps, sent } = makeFakeDepsWithTee({
      workerAlive: false,
      teePath: 'D:/pa/logs/worker-tee/test.out',
      teeContent: '{"type":"result","result":"agy reply here"}',
    });
    const outcome = await evaluatePendingDispatch(rec, deps, FAR_DEADLINE);
    assert.equal(outcome, 'recovered');
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('Recovered reply'));
    assert.ok(sent[0].text.includes('agy reply here'));
    assert.deepEqual(await listPendingDispatches(), []);
    assert.equal(await wasDelivered(deliveredKey(rec.chatId, rec.threadId, rec.updateId)), true);
  });

  it('agy dispatch + teePath + worker dead + empty tee → death notice', async () => {
    const rec = makeRecord({ session: { session_id: 'g-1', worker: 'agy', started_at: T0 } });
    await addPendingDispatch(rec);
    const { deps, sent } = makeFakeDepsWithTee({
      workerAlive: false,
      teePath: 'D:/pa/logs/worker-tee/empty.out',
      teeContent: '',
    });
    const outcome = await evaluatePendingDispatch(rec, deps, FAR_DEADLINE);
    assert.equal(outcome, 'dead');
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('could not be recovered'));
  });

  it('agy dispatch + teePath + worker still alive → waiting', async () => {
    const rec = makeRecord({ session: { session_id: 'g-1', worker: 'agy', started_at: T0 } });
    await addPendingDispatch(rec);
    const { deps, sent } = makeFakeDepsWithTee({
      workerAlive: true,
      teePath: 'D:/pa/logs/worker-tee/test.out',
      teeContent: 'partial',
    });
    const outcome = await evaluatePendingDispatch(rec, deps, FAR_DEADLINE);
    assert.equal(outcome, 'waiting');
    assert.equal(sent.length, 0);
    assert.equal((await listPendingDispatches()).length, 1);
  });

  it('claude dispatch + no teePath → existing transcript path unchanged', async () => {
    const rec = makeRecord(); // claude session
    await addPendingDispatch(rec);
    const now = Date.now();
    const { deps, sent } = makeFakeDeps({
      workerAlive: false,
      transcript: { content: assistantLine('claude reply', '2026-07-03T15:10:00Z'), mtimeMs: now - TRANSCRIPT_QUIESCENT_MS - 1000 },
      nowMs: now,
    });
    // No readTeePath provided → should skip tee branch and use transcript
    const outcome = await evaluatePendingDispatch(rec, deps, FAR_DEADLINE);
    assert.equal(outcome, 'recovered');
    assert.ok(sent[0].text.includes('claude reply'));
  });

  it('dedup: recovered tee reply is not double-delivered on re-run', async () => {
    const rec = makeRecord({ session: { session_id: 'g-1', worker: 'agy', started_at: T0 } });
    await addPendingDispatch(rec);
    const { deps, sent } = makeFakeDepsWithTee({
      workerAlive: false,
      teePath: 'D:/pa/logs/worker-tee/test.out',
      teeContent: '{"type":"result","result":"agy reply"}',
    });

    // First run → recovered
    const outcome1 = await evaluatePendingDispatch(rec, deps, FAR_DEADLINE);
    assert.equal(outcome1, 'recovered');
    assert.equal(sent.length, 1);

    // Second run → already-delivered (record cleared by first run)
    const outcome2 = await evaluatePendingDispatch(rec, deps, FAR_DEADLINE);
    assert.equal(outcome2, 'already-delivered');
    assert.equal(sent.length, 1, 'no additional send attempted');
  });
});

// ---------------------------------------------------------------------------
// findTeePathByRegistry (WP2)
// ---------------------------------------------------------------------------

describe('findTeePathByRegistry', () => {
  const { mkdirSync, writeFileSync: wf } = fsSync;

  function writeEntry(entry: Record<string, unknown>): void {
    const dir = join(home, 'worker-pids');
    mkdirSync(dir, { recursive: true });
    wf(join(dir, `${entry.pid}.json`), JSON.stringify(entry), 'utf8');
  }

  it('returns teePath when a matching registry entry has one', async () => {
    writeEntry({ pid: 12345, spawnedBy: 1, worker: 'agy', skill: 'topic--100555_9', startedAt: T0, teePath: 'D:/pa/logs/worker-tee/test.out' });
    const rec = makeRecord({ chatId: -100555, threadId: 9 });
    assert.equal(await findTeePathByRegistry(rec), 'D:/pa/logs/worker-tee/test.out');
  });

  it('returns null when no matching entry exists', async () => {
    writeEntry({ pid: 12345, spawnedBy: 1, worker: 'agy', skill: 'topic--999999_9', startedAt: T0, teePath: 'D:/pa/logs/worker-tee/other.out' });
    const rec = makeRecord({ chatId: -100555, threadId: 9 });
    assert.equal(await findTeePathByRegistry(rec), null);
  });

  it('returns null when the matching entry has no teePath', async () => {
    writeEntry({ pid: 12345, spawnedBy: 1, worker: 'claude', skill: 'topic--100555_9', startedAt: T0 });
    const rec = makeRecord({ chatId: -100555, threadId: 9 });
    assert.equal(await findTeePathByRegistry(rec), null);
  });
});
