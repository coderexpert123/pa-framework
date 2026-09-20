/**
 * AI-203 WP-3 tests: `rq:` callback grammar + handler.
 *
 * Four concerns under test (SPEC §5.2 WP-3):
 *  1. parseCallbackData('rq:<threadN>:<idx>') — the pa-side grammar parses the
 *     new prefix; index 0-3 only; non-numeric threadN ⇒ null.
 *  2. buildThreadQuestionKeyboard(threadN, options) — one button per option,
 *     callback_data `rq:<threadN>:<idx>`.
 *  3. Full callback flow: a `done` thread seeded with a pendingQuestion; an
 *     `rq:` press ⇒ pendingQuestion cleared, pendingInput holds the option
 *     text, the record returns to `running` (claimThreadStarts), the reply
 *     carries `✅ Answered: <option> — routed to thread t-<n>`.
 *  4. Gate guard: an `rq:` press with NO pendingQuestion ⇒ graceful
 *     `question already answered or expired` reply, no store write.
 *
 * The handler drives the REAL topic-threads store (temp dir via
 * _setStoreDirForTest); only the Telegram send (fetch) and the executor wake
 * (fireClaimedThreads) ride test seams — fireClaimedThreads fires real
 * execution, so it is stubbed to a recorder. PA_NOTIFY_DISABLED is set by the
 * suite runner.
 */

import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseCallbackData } from '../../../../pa/dist/src/lib/callback-grammar.js';
import {
  buildThreadQuestionKeyboard,
  handleCallbackQuery,
  type CallbackDeps,
} from '../callbacks.js';
import {
  createThread,
  getThread,
  updateThread,
  setPendingQuestion,
  takePendingQuestion,
  _clearThreadsForTest,
  _setStoreDirForTest,
  type ThreadRecord,
} from '../topic-threads.js';
import type { CallbackQuery, ConversationState, TelegramUser } from '../types.js';

const CHAT_ID = -1001234567890; // synthetic fixture family — never a real chat
const THREAD_ID = 5001;
const KEY = `${CHAT_ID}_${THREAD_ID}`;

let home: string;
let storeDir: string;
let workdir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pa-wp3-'));
  storeDir = mkdtempSync(join(tmpdir(), 'pa-wp3-store-'));
  workdir = mkdtempSync(join(tmpdir(), 'pa-wp3-wd-'));
  process.env.PA_HOME = home;
  _setStoreDirForTest(storeDir);
});

afterEach(async () => {
  _setStoreDirForTest(undefined);
  _clearThreadsForTest();
  delete process.env.PA_HOME;
  for (const dir of [home, storeDir, workdir]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// --- Pure grammar + keyboard builder (no store) ----------------------------

describe('parseCallbackData — rq: prefix (AI-203 WP-3)', () => {
  it('parses rq:<threadN>:<index> into the rq shape', () => {
    const parsed = parseCallbackData('rq:3:1');
    assert.deepEqual(parsed, { prefix: 'rq', threadN: 3, index: 1, raw: 'rq:3:1' });
  });

  it('parses index 0 and 3 (the 0-3 range)', () => {
    assert.deepEqual(parseCallbackData('rq:7:0'), { prefix: 'rq', threadN: 7, index: 0, raw: 'rq:7:0' });
    assert.deepEqual(parseCallbackData('rq:7:3'), { prefix: 'rq', threadN: 7, index: 3, raw: 'rq:7:3' });
  });

  it('rejects index 4 (only 0-3 — options are capped at 4)', () => {
    assert.equal(parseCallbackData('rq:3:4'), null);
  });

  it('rejects a non-numeric threadN', () => {
    assert.equal(parseCallbackData('rq:abc:1'), null);
  });

  it('rejects a missing index', () => {
    assert.equal(parseCallbackData('rq:3'), null);
    assert.equal(parseCallbackData('rq:3:'), null);
  });

  it('is chat-gated (not operator-gated)', async () => {
    const { gateFor } = await import('../../../../pa/dist/src/lib/callback-grammar.js');
    const parsed = parseCallbackData('rq:1:0');
    assert.ok(parsed);
    assert.equal(gateFor(parsed!), 'chat');
  });
});

describe('buildThreadQuestionKeyboard (AI-203 WP-3)', () => {
  it('builds one button per option with rq:<threadN>:<idx> callback data', () => {
    const kb = buildThreadQuestionKeyboard(3, ['Yes', 'No']);
    assert.equal(kb.inline_keyboard.length, 2);
    assert.equal(kb.inline_keyboard[0][0].text, 'Yes');
    assert.equal(kb.inline_keyboard[0][0].callback_data, 'rq:3:0');
    assert.equal(kb.inline_keyboard[1][0].text, 'No');
    assert.equal(kb.inline_keyboard[1][0].callback_data, 'rq:3:1');
  });

  it('matches the executor inline twin shape (rq:<n>:<idx>)', async () => {
    // The executor builds its own inline twin (thread-executor.ts); this pins
    // that the two builders agree on the callback_data format.
    const { buildThreadQuestionKeyboard: executorBuilder } = await import('../thread-executor.js');
    const a = buildThreadQuestionKeyboard(5, ['A', 'B', 'C']);
    const b = executorBuilder(5, ['A', 'B', 'C']);
    assert.deepEqual(a, b);
  });
});

// --- Full callback flow (real store, stubbed Telegram + wake) --------------

interface RecordedCall { url: string; body: any }

function stubFetch(): { calls: RecordedCall[]; restore: () => void } {
  const saved = globalThis.fetch;
  const calls: RecordedCall[] = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    let body: any = undefined;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = init?.body; }
    calls.push({ url, body });
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ ok: true, result: {} }),
      json: async () => ({ ok: true, result: { message_id: 999 } }),
    };
  };
  return { calls, restore: () => { (globalThis as any).fetch = saved; } };
}

function makeCb(data: string, chatId = CHAT_ID, threadId = THREAD_ID): CallbackQuery {
  const from: TelegramUser = { id: 1, first_name: 'Tester' };
  return {
    id: 'cbq-1',
    from,
    message: {
      message_id: 100,
      chat: { id: chatId, type: 'supergroup' },
      date: Math.floor(Date.now() / 1000),
      text: '❓ Thread t-1 asks: which?',
      message_thread_id: threadId,
    },
    data,
  };
}

function makeDeps(overrides: Partial<CallbackDeps> = {}): CallbackDeps {
  const state: ConversationState = { chat_id: CHAT_ID, last_update_id: 0, thread_id: THREAD_ID, turns: [] };
  const deps: CallbackDeps = {
    token: 'tok',
    secrets: {},
    runtimeEnv: process.env,
    botCwd: process.cwd(),
    injectUpdate: () => {},
    spawnReauthLink: () => '🔐 link',
    loadTopicState: async () => state,
    loadRunningTasks: async () => [],
    listWorkerNames: async () => ['agy', 'claude'],
    observedValues: async () => [],
    declaredValues: async () => [],
    effectiveDefaultWorker: async () => 'agy',
    ...overrides,
  };
  return deps;
}

async function seedDoneThreadWithQuestion(
  options: string[] = ['Yes', 'No'],
  text = 'which?',
): Promise<ThreadRecord> {
  const created = await createThread(KEY, { title: 'Sweep logs', goal: 'Run the sweep script.', workdir });
  assert.ok(created.ok, `fixture createThread failed: ${!created.ok ? created.reason : ''}`);
  const rec = created.thread;
  await updateThread(KEY, rec.id, { status: 'done' });
  const set = await setPendingQuestion(KEY, rec.id, { text, options });
  assert.ok(set, 'fixture setPendingQuestion failed');
  return rec;
}

describe('handleCallbackQuery — rq: branch (AI-203 WP-3)', () => {
  let fetchStub: ReturnType<typeof stubFetch>;

  beforeEach(() => { fetchStub = stubFetch(); });
  afterEach(() => { fetchStub.restore(); });

  it('resolves a pending thread question: clears pendingQuestion, queues the option, returns the thread to running, replies with the frozen ack', async () => {
    const rec = await seedDoneThreadWithQuestion(['Yes', 'No']);
    const fired: { topicKey: string; ids: string[]; topicName: string }[] = [];
    const deps = makeDeps({
      fireClaimedThreads: (topicKey, claimed, opts) => {
        fired.push({ topicKey, ids: claimed.map((c) => c.id), topicName: opts.topicName });
      },
      topicNameFor: () => 'Test Topic',
    });

    const outcome = await handleCallbackQuery(makeCb(`rq:${rec.n}:0`), deps);

    // Outcome + wake: the done thread was parked as 'queued', claimed (→ running),
    // and fireClaimedThreads fired with the right topic key + name.
    assert.equal(outcome, 'rq:answered');
    assert.equal(fired.length, 1);
    assert.equal(fired[0].topicKey, KEY);
    assert.deepEqual(fired[0].ids, [rec.id]);
    assert.equal(fired[0].topicName, 'Test Topic');

    // Store effects: pendingQuestion cleared; pendingInput holds the option text;
    // the record is 'running' again (claimThreadStarts flipped queued→running).
    const after = await getThread(KEY, rec.id);
    assert.ok(after, 'thread record must still exist');
    assert.equal(after!.pendingQuestion, undefined, 'pendingQuestion must be cleared');
    assert.deepEqual(after!.pendingInput, ['Yes'], 'the option text must be queued as pendingInput');
    assert.equal(after!.status, 'running', 'the done thread must return to running');

    // Reply: a sendMessage carrying the frozen ack text. answerCallbackQuery
    // fires first (toast), then the reply message.
    const sendCalls = fetchStub.calls.filter((c) => c.url.includes('sendMessage'));
    const reply = sendCalls.find((c) => typeof c.body?.text === 'string' && c.body.text.includes('Answered:'));
    assert.ok(reply, 'a sendMessage with the ✅ Answered ack must fire');
    // The reply is MarkdownV2-escaped (sendMessage escapes `-`, `.`), so match
    // on the unescaped substrings that survive escaping verbatim.
    assert.match(String(reply!.body.text), /Answered: Yes/);
    assert.match(String(reply!.body.text), /routed to thread t\\?-?1/);
  });

  it('resolves option index 1 (the second option)', async () => {
    const rec = await seedDoneThreadWithQuestion(['Retry', 'Abort']);
    const deps = makeDeps({ fireClaimedThreads: () => {}, topicNameFor: () => '' });
    const outcome = await handleCallbackQuery(makeCb(`rq:${rec.n}:1`), deps);
    assert.equal(outcome, 'rq:answered');
    const after = await getThread(KEY, rec.id);
    assert.deepEqual(after!.pendingInput, ['Abort']);
  });

  it('is idempotent on a stale press (no pendingQuestion): graceful reply, no store write', async () => {
    // Seed a done thread with NO pendingQuestion — simulates a stale button
    // (already answered, or the record was cancelled/never asked).
    const created = await createThread(KEY, { title: 'Sweep logs', goal: 'g', workdir });
    assert.ok(created.ok);
    const rec = created.thread;
    await updateThread(KEY, rec.id, { status: 'done' });
    // Confirm no pendingQuestion is set.
    assert.equal((await getThread(KEY, rec.id))?.pendingQuestion, undefined);

    const deps = makeDeps({ fireClaimedThreads: () => { throw new Error('must not fire on a stale press'); }, topicNameFor: () => '' });
    const outcome = await handleCallbackQuery(makeCb(`rq:${rec.n}:0`), deps);

    assert.equal(outcome, 'rq:gone');
    // answerCallbackQuery carries the graceful show_alert text.
    const answerCalls = fetchStub.calls.filter((c) => c.url.includes('answerCallbackQuery'));
    assert.equal(answerCalls.length, 1);
    assert.equal(answerCalls[0].body.text, 'Question already answered or expired');
    assert.equal(answerCalls[0].body.show_alert, true);
    // No store write: pendingInput stays empty; status stays 'done'.
    const after = await getThread(KEY, rec.id);
    assert.deepEqual(after!.pendingInput, []);
    assert.equal(after!.status, 'done');
  });

  it('rejects an out-of-range option index gracefully (takePendingQuestion clears, but the index is invalid)', async () => {
    // The grammar rejects index 4 at parse time, so this exercises index 0-3
    // against a question with fewer options. takePendingQuestion is the atomic
    // read-and-clear — it fires BEFORE the index check, so the question is
    // consumed even on a bad index. The handler answers 'Invalid option' and
    // does NOT queue input. (This mirrors the q:/qt: precedent: the question
    // is taken, the option resolution is the guard.)
    const rec = await seedDoneThreadWithQuestion(['Only one']);
    const deps = makeDeps({ fireClaimedThreads: () => {}, topicNameFor: () => '' });
    // index 1 against a 1-option question → undefined option.
    const outcome = await handleCallbackQuery(makeCb(`rq:${rec.n}:1`), deps);
    assert.equal(outcome, 'rq:bad');
    const answerCalls = fetchStub.calls.filter((c) => c.url.includes('answerCallbackQuery'));
    assert.equal(answerCalls[0].body.text, 'Invalid option');
    // The question was taken (cleared) but no input queued.
    const after = await getThread(KEY, rec.id);
    assert.equal(after!.pendingQuestion, undefined);
    assert.deepEqual(after!.pendingInput, []);
  });

  it('does not inject a synthetic poll-loop turn (convergence, not injection)', async () => {
    const rec = await seedDoneThreadWithQuestion(['Yes', 'No']);
    const injected: any[] = [];
    const deps = makeDeps({
      injectUpdate: (u) => injected.push(u),
      fireClaimedThreads: () => {},
      topicNameFor: () => '',
    });
    await handleCallbackQuery(makeCb(`rq:${rec.n}:0`), deps);
    // An rq: press answers the THREAD directly (store write + wake); it must
    // NOT inject a synthetic message into the poll loop (unlike cf:/q:).
    assert.equal(injected.length, 0);
  });
});
