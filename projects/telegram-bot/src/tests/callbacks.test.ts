import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  parseCallbackData,
  gateFor,
  buildConfirmKeyboard,
  buildControlCardKeyboard,
  buildAgentPickerKeyboard,
  buildValuePickerKeyboard,
  buildFailoverKeyboard,
  buildRunNowKeyboard,
  buildQuestionKeyboard,
  buildSuggestKeyboard,
  buildResendKeyboard,
  buildDlqReplayKeyboard,
  syntheticTextFor,
  buildSyntheticUpdate,
  nextSyntheticUpdateId,
  handleCallbackQuery,
  handleMessageReaction,
  rememberConfirmMessage,
  currentCardKeyboard,
  _resetCardKeyboardIndexForTest,
  _setSpawnForTest,
  _restoreSpawnForTest,
  type CallbackDeps,
  type ParsedCallback,
} from '../callbacks.js';
import { editMessageText } from '../telegram.js';
import { _resetResendStoreForTest, putResend } from '../resend-store.js';
import type { CallbackQuery, ConversationState, MessageReactionUpdated, TelegramUser } from '../types.js';
import { waitForDrain } from './test-teardown-guard.js';
import {
  appendTask,
  claimNextTask,
  listRunningTasks,
  parkTask,
  _resetTopicTasksForTest,
} from '../../../../pa/dist/src/lib/topic-tasks.js';

const CHAT_ID = -1001234567890;
const THREAD_ID = 5001;

// ---------------------------------------------------------------------------
// parseCallbackData — one valid example per §3.2 row, plus the invalid list.
// ---------------------------------------------------------------------------

describe('parseCallbackData — valid examples (one per §3.2 row)', () => {
  it('reauth:google (no skill)', () => {
    const p = parseCallbackData('reauth:google');
    assert.deepEqual(p, { prefix: 'reauth', provider: 'google', skill: undefined, raw: 'reauth:google' });
  });

  it('reauth:google:<skill>', () => {
    const p = parseCallbackData('reauth:google:daily-mail-brief');
    assert.equal(p?.prefix, 'reauth');
    assert.equal((p as any).skill, 'daily-mail-brief');
  });

  it('cf:y / cf:n', () => {
    assert.deepEqual(parseCallbackData('cf:y'), { prefix: 'cf', answer: 'y', raw: 'cf:y' });
    assert.deepEqual(parseCallbackData('cf:n'), { prefix: 'cf', answer: 'n', raw: 'cf:n' });
  });

  it('cc:menu (and the other 8 simple cc actions)', () => {
    for (const action of ['menu', 'agent', 'model', 'effort', 'back', 'new', 'stop', 'submit', 'discard']) {
      const p = parseCallbackData(`cc:${action}`);
      assert.deepEqual(p, { prefix: 'cc', action, raw: `cc:${action}` });
    }
  });

  it('cc:submit / cc:discard parse as simple actions; extra segments are rejected (AI-210)', () => {
    assert.deepEqual(parseCallbackData('cc:submit'), { prefix: 'cc', action: 'submit', raw: 'cc:submit' });
    assert.deepEqual(parseCallbackData('cc:discard'), { prefix: 'cc', action: 'discard', raw: 'cc:discard' });
    assert.equal(parseCallbackData('cc:submit:x'), null);
    assert.equal(parseCallbackData('cc:discard:y'), null);
  });

  it('cc:set:agent|model|effort:<value>', () => {
    assert.deepEqual(parseCallbackData('cc:set:agent:agy'), { prefix: 'cc', action: 'set', setting: 'agent', value: 'agy', raw: 'cc:set:agent:agy' });
    assert.deepEqual(parseCallbackData('cc:set:model:opus'), { prefix: 'cc', action: 'set', setting: 'model', value: 'opus', raw: 'cc:set:model:opus' });
    assert.deepEqual(parseCallbackData('cc:set:effort:high'), { prefix: 'cc', action: 'set', setting: 'effort', value: 'high', raw: 'cc:set:effort:high' });
  });

  it('wf:retry / wf:switch:<worker> / wf:revert:<worker>', () => {
    assert.deepEqual(parseCallbackData('wf:retry'), { prefix: 'wf', action: 'retry', raw: 'wf:retry' });
    assert.deepEqual(parseCallbackData('wf:switch:agy'), { prefix: 'wf', action: 'switch', worker: 'agy', raw: 'wf:switch:agy' });
    assert.deepEqual(parseCallbackData('wf:revert:claude'), { prefix: 'wf', action: 'revert', worker: 'claude', raw: 'wf:revert:claude' });
  });

  it('pm:<auditId>:approve|reject|diff — including a colon-bearing ISO timestamp id', () => {
    // Regression case: main.ts's old inline regex (`[^:]+`) could never match an id
    // containing a colon, even though real audit ids are ISO timestamps
    // (buildHITLKeyboard's own doc example is '2026-08-18T00:00:00Z'). This parser
    // resolves it correctly via greedy-with-backtrack against the fixed action suffix.
    const p = parseCallbackData('pm:2026-08-18T00:00:00Z:approve');
    assert.deepEqual(p, { prefix: 'pm', auditId: '2026-08-18T00:00:00Z', action: 'approve', raw: 'pm:2026-08-18T00:00:00Z:approve' });
  });

  it('dr:<name>:approve|reject|show', () => {
    assert.deepEqual(parseCallbackData('dr:my-draft:show'), { prefix: 'dr', draft: 'my-draft', action: 'show', raw: 'dr:my-draft:show' });
  });

  it('sk:run:<skill>[:c] / sk:job:<job>[:c]', () => {
    assert.deepEqual(parseCallbackData('sk:run:daily-mail-brief'), { prefix: 'sk', kind: 'run', name: 'daily-mail-brief', confirmed: false, raw: 'sk:run:daily-mail-brief' });
    assert.deepEqual(parseCallbackData('sk:job:dlq-flush:c'), { prefix: 'sk', kind: 'job', name: 'dlq-flush', confirmed: true, raw: 'sk:job:dlq-flush:c' });
  });

  it('rm:done / rm:1h / rm:tmrw', () => {
    assert.deepEqual(parseCallbackData('rm:done'), { prefix: 'rm', action: 'done', raw: 'rm:done' });
    assert.deepEqual(parseCallbackData('rm:1h'), { prefix: 'rm', action: '1h', raw: 'rm:1h' });
    assert.deepEqual(parseCallbackData('rm:tmrw'), { prefix: 'rm', action: 'tmrw', raw: 'rm:tmrw' });
  });

  it('mc:<conflictId>:a|r|x', () => {
    const p = parseCallbackData('mc:cf-20260818120000-001:a');
    assert.deepEqual(p, { prefix: 'mc', conflictId: 'cf-20260818120000-001', action: 'a', raw: 'mc:cf-20260818120000-001:a' });
  });

  it('rs:<chatId>:<threadId>:<updateId> — negative supergroup chat id', () => {
    const p = parseCallbackData('rs:-1001234567890:7822:1700000000123');
    assert.deepEqual(p, { prefix: 'rs', chatId: -1001234567890, threadId: 7822, updateId: 1700000000123, raw: 'rs:-1001234567890:7822:1700000000123' });
  });

  it('dq:replay:<index>[:c]', () => {
    assert.deepEqual(parseCallbackData('dq:replay:3'), { prefix: 'dq', index: 3, confirmed: false, raw: 'dq:replay:3' });
    assert.deepEqual(parseCallbackData('dq:replay:12:c'), { prefix: 'dq', index: 12, confirmed: true, raw: 'dq:replay:12:c' });
  });

  it('q:<0-3> — PA_META question option press (index resolves against pending_question)', () => {
    for (let i = 0; i <= 3; i++) {
      assert.deepEqual(parseCallbackData(`q:${i}`), { prefix: 'q', index: i, raw: `q:${i}` });
    }
    assert.equal(parseCallbackData('q:4'), null, 'options cap at 4');
    assert.equal(gateFor(parseCallbackData('q:0')!), 'chat', 'q: is chat-gated like cf:');
  });
});

describe('parseCallbackData — invalid / null cases', () => {
  it('undefined and empty string', () => {
    assert.equal(parseCallbackData(undefined), null);
    assert.equal(parseCallbackData(''), null);
  });

  it('reauth skill over the 50-byte cap (14 + 51 = 65 bytes)', () => {
    assert.equal(parseCallbackData('reauth:google:' + 'a'.repeat(51)), null);
  });

  it('cf:maybe — not y or n', () => {
    assert.equal(parseCallbackData('cf:maybe'), null);
  });

  it('cc:set:model value over the 40-byte cap', () => {
    assert.equal(parseCallbackData('cc:set:model:' + 'x'.repeat(41)), null);
  });

  it('sk:run:push parses fine — the protected-skill refusal is in the handler, not the parser', () => {
    assert.deepEqual(parseCallbackData('sk:run:push'), { prefix: 'sk', kind: 'run', name: 'push', confirmed: false, raw: 'sk:run:push' });
  });

  it('a bare 65-byte string with no recognised prefix', () => {
    assert.equal(parseCallbackData('x'.repeat(65)), null);
  });

  it('pm:abc — no action segment', () => {
    assert.equal(parseCallbackData('pm:abc'), null);
  });
});

// ---------------------------------------------------------------------------
// gateFor
// ---------------------------------------------------------------------------

describe('gateFor', () => {
  const cases: Array<[string, 'chat' | 'operator']> = [
    ['reauth:google', 'chat'],
    ['cf:y', 'chat'],
    ['cc:menu', 'chat'],
    ['cc:submit', 'chat'],
    ['cc:discard', 'chat'],
    ['wf:retry', 'chat'],
    ['rm:done', 'chat'],
    ['pm:t1:approve', 'operator'],
    ['dr:d1:approve', 'operator'],
    ['sk:run:push', 'operator'],
    ['mc:cf-1:a', 'operator'],
    ['rs:1:0:2', 'operator'],
    ['dq:replay:1', 'operator'],
  ];
  for (const [data, expected] of cases) {
    it(`${data} -> ${expected}`, () => {
      const parsed = parseCallbackData(data);
      assert.ok(parsed, `expected ${data} to parse`);
      assert.equal(gateFor(parsed!), expected);
    });
  }
});

// ---------------------------------------------------------------------------
// nextSyntheticUpdateId
// ---------------------------------------------------------------------------

describe('nextSyntheticUpdateId', () => {
  it('is strictly increasing across 3 calls and always above any plausible Telegram update_id', () => {
    const a = nextSyntheticUpdateId();
    const b = nextSyntheticUpdateId();
    const c = nextSyntheticUpdateId();
    assert.ok(a < b, `${a} < ${b}`);
    assert.ok(b < c, `${b} < ${c}`);
    for (const id of [a, b, c]) assert.ok(id > 4_000_000_000, `${id} > 4e9`);
  });
});

// ---------------------------------------------------------------------------
// buildSyntheticUpdate
// ---------------------------------------------------------------------------

describe('buildSyntheticUpdate', () => {
  it('sets __synthetic, copies chat/thread/from, and puts the text on message.text', () => {
    const from = { id: 9, first_name: 'Op', username: 'op' };
    const upd = buildSyntheticUpdate({
      updateId: 4_100_000_000,
      chatId: 555,
      threadId: 777,
      messageId: 42,
      from,
      text: 'hello',
      via: 'button',
    });
    assert.equal((upd as any).__synthetic, 'button');
    assert.equal(upd.update_id, 4_100_000_000);
    assert.equal(upd.message?.chat.id, 555);
    assert.equal(upd.message?.message_thread_id, 777);
    assert.equal(upd.message?.message_id, 42);
    assert.deepEqual(upd.message?.from, from);
    assert.equal(upd.message?.text, 'hello');
  });

  it('via:"reaction" is carried through', () => {
    const upd = buildSyntheticUpdate({
      updateId: 4_100_000_001,
      chatId: 1,
      threadId: 0,
      messageId: 1,
      from: { id: 1, first_name: 'U' },
      text: 'yes',
      via: 'reaction',
    });
    assert.equal((upd as any).__synthetic, 'reaction');
  });
});

// ---------------------------------------------------------------------------
// syntheticTextFor
// ---------------------------------------------------------------------------

describe('syntheticTextFor', () => {
  it('cf:y -> yes, cf:n -> no', () => {
    assert.equal(syntheticTextFor({ prefix: 'cf', answer: 'y', raw: 'cf:y' }), 'yes');
    assert.equal(syntheticTextFor({ prefix: 'cf', answer: 'n', raw: 'cf:n' }), 'no');
  });

  it('cc:set:agent|model|effort synthesize the matching slash command', () => {
    assert.equal(syntheticTextFor({ prefix: 'cc', action: 'set', setting: 'agent', value: 'agy', raw: '' }), '/agent agy');
    assert.equal(syntheticTextFor({ prefix: 'cc', action: 'set', setting: 'model', value: 'x', raw: '' }), '/model x');
    assert.equal(syntheticTextFor({ prefix: 'cc', action: 'set', setting: 'effort', value: 'high', raw: '' }), '/effort high');
  });

  it('cc:new -> /new, cc:stop -> /stop', () => {
    assert.equal(syntheticTextFor({ prefix: 'cc', action: 'new', raw: 'cc:new' }), '/new');
    assert.equal(syntheticTextFor({ prefix: 'cc', action: 'stop', raw: 'cc:stop' }), '/stop');
  });

  it('null for menu-navigation and in-process-only prefixes', () => {
    assert.equal(syntheticTextFor({ prefix: 'cc', action: 'menu', raw: 'cc:menu' }), null);
    assert.equal(syntheticTextFor({ prefix: 'cc', action: 'back', raw: 'cc:back' }), null);
    assert.equal(syntheticTextFor({ prefix: 'pm', auditId: 't', action: 'approve', raw: '' }), null);
    assert.equal(syntheticTextFor({ prefix: 'dr', draft: 'd', action: 'approve', raw: '' }), null);
    assert.equal(syntheticTextFor({ prefix: 'sk', kind: 'run', name: 'x', confirmed: false, raw: '' }), null);
    assert.equal(syntheticTextFor({ prefix: 'mc', conflictId: 'c', action: 'a', raw: '' }), null);
    assert.equal(syntheticTextFor({ prefix: 'dq', index: 1, confirmed: false, raw: '' }), null);
  });

  it('cc:submit / cc:discard synthesize nothing (AI-210: submit injects from the recorded staged selection)', () => {
    assert.equal(syntheticTextFor({ prefix: 'cc', action: 'submit', raw: 'cc:submit' }), null);
    assert.equal(syntheticTextFor({ prefix: 'cc', action: 'discard', raw: 'cc:discard' }), null);
  });
});

// ---------------------------------------------------------------------------
// Keyboard builders — byte budget + shape
// ---------------------------------------------------------------------------

function allButtons(kb: { inline_keyboard: Array<Array<{ callback_data?: string }>> } | undefined): string[] {
  if (!kb) return [];
  return kb.inline_keyboard.flat().map((b) => b.callback_data).filter((d): d is string => !!d);
}

describe('keyboard builders stay within the 64-byte callback_data budget', () => {
  it('buildConfirmKeyboard', () => {
    for (const d of allButtons(buildConfirmKeyboard())) assert.ok(Buffer.byteLength(d) <= 64, d);
  });
  it('buildControlCardKeyboard', () => {
    for (const d of allButtons(buildControlCardKeyboard())) assert.ok(Buffer.byteLength(d) <= 64, d);
  });
  it('buildAgentPickerKeyboard with a 16-char worker name (the cap)', () => {
    const worker = 'w'.repeat(16);
    for (const d of allButtons(buildAgentPickerKeyboard([worker], worker))) assert.ok(Buffer.byteLength(d) <= 64, d);
  });
  it('buildValuePickerKeyboard(model) with a 40-char value (the cap)', () => {
    const value = 'v'.repeat(40);
    for (const d of allButtons(buildValuePickerKeyboard('model', [value], value))) assert.ok(Buffer.byteLength(d) <= 64, d);
  });
  it('buildValuePickerKeyboard(effort) with a 16-char value (the cap)', () => {
    const value = 'e'.repeat(16);
    for (const d of allButtons(buildValuePickerKeyboard('effort', [value]))) assert.ok(Buffer.byteLength(d) <= 64, d);
  });
  it('buildFailoverKeyboard with 16-char worker names', () => {
    const kb = buildFailoverKeyboard({ next: 'n'.repeat(16), previous: 'p'.repeat(16) });
    for (const d of allButtons(kb)) assert.ok(Buffer.byteLength(d) <= 64, d);
  });
  it('buildRunNowKeyboard with a 40-char name (the cap), confirmed and unconfirmed', () => {
    const name = 'a' + '-'.repeat(39); // 40 chars, matches SK_NAME_RE
    for (const confirmed of [false, true]) {
      const kb = buildRunNowKeyboard('job', name, confirmed);
      for (const d of allButtons(kb)) assert.ok(Buffer.byteLength(d) <= 64, d);
    }
  });
  it('question keyboard buttons all ≤64 bytes', () => {
    // buildReminderKeyboard was DELETED (2026-09-02, SPEC §1.3 — dead code; the live
    // rm: producer is the Python dict in projects/reminders/process_reminders.py).
    const kb = buildQuestionKeyboard(['A — faster', 'B — safer', 'C', 'D — none of these']);
    assert.equal(kb.inline_keyboard.length, 4, 'one button per row');
    for (const d of allButtons(kb)) assert.ok(Buffer.byteLength(d) <= 64, d);
    assert.deepEqual(allButtons(kb), ['q:0', 'q:1', 'q:2', 'q:3']);
    // Labels are the option text verbatim — no emoji prefixes, no truncation.
    assert.equal(kb.inline_keyboard[0][0].text, 'A — faster');
  });
  it('buildResendKeyboard with worst-case-length ids', () => {
    const kb = buildResendKeyboard(-1001234567890123, 9999999999, 4999999999999);
    if (kb) for (const d of allButtons(kb)) assert.ok(Buffer.byteLength(d) <= 64, d);
  });
  it('buildDlqReplayKeyboard with a 4-digit index (the cap), confirmed and unconfirmed', () => {
    for (const confirmed of [false, true]) {
      const kb = buildDlqReplayKeyboard(9999, confirmed);
      for (const d of allButtons(kb)) assert.ok(Buffer.byteLength(d) <= 64, d);
    }
  });
});

// AI-234 (SPEC §3a): buildSuggestKeyboard — one button per chip, one row per
// chip, callback_data is sr:<idx>, label is the chip text verbatim.
describe('buildSuggestKeyboard (AI-234)', () => {
  it('one row per chip, callback_data sr:<idx>, label = chip text', () => {
    const items = ['Tell me more', 'Yes', 'No', 'Maybe later'];
    const kb = buildSuggestKeyboard(items);
    assert.equal(kb.inline_keyboard.length, 4, 'one row per chip');
    for (let i = 0; i < items.length; i++) {
      assert.equal(kb.inline_keyboard[i].length, 1, `row ${i} has exactly one button`);
      assert.equal(kb.inline_keyboard[i][0].text, items[i], `row ${i} label is chip text`);
      assert.equal(kb.inline_keyboard[i][0].callback_data, `sr:${i}`, `row ${i} callback_data is sr:${i}`);
    }
  });

  it('all callback_data ≤64 bytes (index is tiny)', () => {
    const kb = buildSuggestKeyboard(['A', 'B', 'C', 'D']);
    for (const d of allButtons(kb)) assert.ok(Buffer.byteLength(d) <= 64, d);
  });

  it('empty items → empty keyboard', () => {
    const kb = buildSuggestKeyboard([]);
    assert.equal(kb.inline_keyboard.length, 0);
  });

  it('single chip → single row', () => {
    const kb = buildSuggestKeyboard(['Go ahead']);
    assert.equal(kb.inline_keyboard.length, 1);
    assert.equal(kb.inline_keyboard[0][0].callback_data, 'sr:0');
    assert.equal(kb.inline_keyboard[0][0].text, 'Go ahead');
  });
});

describe('buildValuePickerKeyboard', () => {
  it('drops an over-long value and always ends with the Submit/Discard row', () => {
    const kb = buildValuePickerKeyboard('model', ['ok', 'x'.repeat(41)], 'ok');
    const buttons = allButtons(kb);
    assert.ok(buttons.includes('cc:set:model:ok'));
    assert.ok(!buttons.some((d) => d.startsWith('cc:set:model:x')), 'the over-long value must be dropped');
    const lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    assert.equal(lastRow.length, 2);
    assert.equal(lastRow[0].callback_data, 'cc:submit');
    assert.equal(lastRow[1].callback_data, 'cc:discard');
  });

  it('lays out 1 per row for 6 or fewer values', () => {
    const values = ['a', 'b', 'c', 'd', 'e', 'clear'];
    const kb = buildValuePickerKeyboard('model', values);
    const dataRows = kb.inline_keyboard.slice(0, -1);
    assert.equal(dataRows.length, values.length);
    for (const row of dataRows) assert.equal(row.length, 1);
    const lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    assert.equal(lastRow.length, 2);
    assert.equal(lastRow[0].callback_data, 'cc:submit');
    assert.equal(lastRow[1].callback_data, 'cc:discard');
  });

  it('lays out 2 per row once more than 6 values survive, preserving order, Submit/Discard row last', () => {
    const values = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'clear']; // 8 values
    const kb = buildValuePickerKeyboard('model', values);
    const dataRows = kb.inline_keyboard.slice(0, -1);
    assert.equal(dataRows.length, 4); // ceil(8/2)
    for (const row of dataRows) assert.equal(row.length, 2);
    const flatData = dataRows.flat().map((b) => b.callback_data);
    assert.deepEqual(flatData, values.map((v) => `cc:set:model:${v}`), 'declared order must be preserved across rows');
    const lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    assert.equal(lastRow.length, 2);
    assert.equal(lastRow[0].callback_data, 'cc:submit');
    assert.equal(lastRow[1].callback_data, 'cc:discard');
  });
});

// AI-210 (2026-09-06): both pickers end with [✅ Submit][↩ Discard] instead of ◀ Back.
describe('AI-210 — both pickers end with the Submit/Discard row', () => {
  it('buildAgentPickerKeyboard ends with Submit/Discard and no cc:back remains', () => {
    const kb = buildAgentPickerKeyboard(['agy', 'claude'], 'agy');
    const lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    assert.deepEqual(lastRow, [
      { text: '✅ Submit', callback_data: 'cc:submit' },
      { text: '↩ Discard', callback_data: 'cc:discard' },
    ]);
    assert.ok(!allButtons(kb).includes('cc:back'));
  });

  it('buildValuePickerKeyboard ends with Submit/Discard and no cc:back remains', () => {
    const kb = buildValuePickerKeyboard('model', ['m1'], 'm1');
    const lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    assert.deepEqual(lastRow, [
      { text: '✅ Submit', callback_data: 'cc:submit' },
      { text: '↩ Discard', callback_data: 'cc:discard' },
    ]);
    assert.ok(!allButtons(kb).includes('cc:back'));
  });
});

describe('buildRunNowKeyboard', () => {
  it("buildRunNowKeyboard('run', 'push', false) returns undefined — 'push' is protected", () => {
    assert.equal(buildRunNowKeyboard('run', 'push', false), undefined);
  });

  it('a job named the same as a protected skill is NOT refused — protection only applies to kind:run', () => {
    assert.ok(buildRunNowKeyboard('job', 'push', false) !== undefined);
  });
});

// ---------------------------------------------------------------------------
// handleCallbackQuery / handleMessageReaction — real logic against stubbed
// network + deps. PA_HOME is a fresh temp dir per test so listSkills() (a REAL
// pa/dist function, not a mock) sees a controlled fixture instead of the live
// ~/.pa/skills — this drives the real producer (listSkills) rather than a hand-built
// fixture standing in for it.
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  body: any;
}

function stubFetch(): { calls: RecordedCall[]; restore: () => void } {
  const saved = globalThis.fetch;
  const calls: RecordedCall[] = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    let body: any = undefined;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = init?.body;
    }
    calls.push({ url, body });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: {} }),
      json: async () => ({ ok: true, result: { message_id: 999 } }),
    };
  };
  return {
    calls,
    restore: () => {
      (globalThis as any).fetch = saved;
    },
  };
}

function makeCb(data: string | undefined, overrides: Partial<CallbackQuery> = {}): CallbackQuery {
  const from: TelegramUser = { id: 1, first_name: 'Tester' };
  return {
    id: 'cbq-1',
    from,
    message: {
      message_id: 100,
      chat: { id: 555, type: 'supergroup' },
      date: Math.floor(Date.now() / 1000),
      text: 'card',
      message_thread_id: 0,
    },
    data,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CallbackDeps> = {}): CallbackDeps & { injected: any[] } {
  const injected: any[] = [];
  const state: ConversationState = { chat_id: 555, last_update_id: 0, thread_id: 0, turns: [] };
  const deps: CallbackDeps & { injected: any[] } = {
    token: 'tok',
    secrets: {},
    runtimeEnv: process.env,
    botCwd: process.cwd(),
    injectUpdate: (u) => injected.push(u),
    spawnReauthLink: () => '🔐 link',
    loadTopicState: async () => state,
    loadRunningTasks: async () => [],
    listWorkerNames: async () => ['agy', 'claude'],
    observedValues: async () => [],
    declaredValues: async () => [],
    effectiveDefaultWorker: async () => 'agy',
    injected,
    ...overrides,
  };
  return deps;
}

describe('handleCallbackQuery', () => {
  let fetchStub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    fetchStub = stubFetch();
  });

  afterEach(() => {
    fetchStub.restore();
    _restoreSpawnForTest();
    // Picker-opening tests record submenus under the shared fixture key
    // (chat 555, message 100); empty the index so a recording never leaks into
    // a later test's ackSelection keyboard re-attach (AI-192).
    _resetCardKeyboardIndexForTest();
  });

  it('an unparsed data string answers once and injects nothing', async () => {
    const deps = makeDeps();
    const outcome = await handleCallbackQuery(makeCb('not-a-real-callback!!'), deps);
    assert.equal(outcome, 'unparsed');
    assert.equal(deps.injected.length, 0);
    const answerCalls = fetchStub.calls.filter((c) => c.url.includes('answerCallbackQuery'));
    assert.equal(answerCalls.length, 1);
    assert.equal(answerCalls[0].body.text, 'Unknown button');
  });

  it('an operator-gated callback with no PA_OPERATOR_USER_ID answers with show_alert and injects nothing', async () => {
    const deps = makeDeps({ secrets: {} });
    const outcome = await handleCallbackQuery(makeCb('pm:t1:approve'), deps);
    assert.equal(outcome, 'no-operator-id');
    assert.equal(deps.injected.length, 0);
    const answerCalls = fetchStub.calls.filter((c) => c.url.includes('answerCallbackQuery'));
    assert.equal(answerCalls.length, 1);
    assert.equal(answerCalls[0].body.show_alert, true);
  });

  it('an operator-gated callback from the wrong user is refused even when PA_OPERATOR_USER_ID is set', async () => {
    const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '999' } });
    const outcome = await handleCallbackQuery(makeCb('pm:t1:approve', { from: { id: 1, first_name: 'Not-operator' } }), deps);
    assert.equal(outcome, 'unauthorized');
    assert.equal(deps.injected.length, 0);
  });

  it('cf:y injects exactly one update whose message.text === "yes"', async () => {
    const deps = makeDeps();
    const outcome = await handleCallbackQuery(makeCb('cf:y'), deps);
    assert.equal(outcome, 'cf:y');
    assert.equal(deps.injected.length, 1);
    assert.equal(deps.injected[0].message.text, 'yes');
    assert.equal((deps.injected[0] as any).__synthetic, 'button');
  });

  it('cf:n injects exactly one update whose message.text === "no"', async () => {
    const deps = makeDeps();
    await handleCallbackQuery(makeCb('cf:n'), deps);
    assert.equal(deps.injected.length, 1);
    assert.equal(deps.injected[0].message.text, 'no');
  });

  describe('q: — PA_META question press (2026-09-02, handover Wave 1 SPEC §3.3)', () => {
    function stateWithQuestion(overrides: Partial<ConversationState['pending_question']> = {}): ConversationState {
      return {
        chat_id: 555,
        last_update_id: 0,
        thread_id: 0,
        turns: [],
        pending_question: {
          text: 'Prefer A or B?',
          options: ['A — faster', 'B — safer'],
          asked_at: new Date().toISOString(),
          ...overrides,
        },
      };
    }

    it('q: press injects the option text as a synthetic turn', async () => {
      const deps = makeDeps({ loadTopicState: async () => stateWithQuestion() });
      const outcome = await handleCallbackQuery(makeCb('q:1'), deps);
      assert.equal(outcome, 'q:answered');
      assert.equal(deps.injected.length, 1, 'exactly one synthetic turn');
      assert.equal(deps.injected[0].message.text, 'B — safer', 'the option text verbatim');
      assert.equal((deps.injected[0] as any).__synthetic, 'button');
      assert.equal(deps.injected[0].message.chat.id, 555);
    });

    it('q: press appends question_answered event', async () => {
      const deps = makeDeps({
        loadTopicState: async () =>
          stateWithQuestion({ task_id: 'tt-abc123' }),
      });
      await handleCallbackQuery(makeCb('q:0'), deps);
      const eventsPath = join(process.env.PA_HOME!, 'topic-events', '555_0.jsonl');
      const raw = await readFile(eventsPath, 'utf8');
      const events = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      // The event file accumulates across the process (the earlier q:1 press in the
      // inject test appended its own row) — match THIS press by its full predicate
      // instead of find()-ing the first question_answered row.
      const ev = events.find(
        (e: any) => e.kind === 'question_answered' && e.detail === 'A — faster' && e.ref === 'tt-abc123',
      );
      assert.ok(ev, 'question_answered event for this press (detail A — faster, ref tt-abc123) must be appended');
    });

    it('q: gone when no pending question', async () => {
      const deps = makeDeps(); // default fixture state has no pending_question
      const outcome = await handleCallbackQuery(makeCb('q:0'), deps);
      assert.equal(outcome, 'q:gone');
      assert.equal(deps.injected.length, 0);
      const answerCalls = fetchStub.calls.filter((c) => c.url.includes('answerCallbackQuery'));
      assert.equal(answerCalls.length, 1);
      assert.equal(answerCalls[0].body.text, 'Question no longer active');
    });

    it('q: index out of bounds answers with an alert and injects nothing', async () => {
      const deps = makeDeps({ loadTopicState: async () => stateWithQuestion() });
      const outcome = await handleCallbackQuery(makeCb('q:3'), deps); // only 2 options
      assert.equal(outcome, 'q:bad');
      assert.equal(deps.injected.length, 0);
    });
  });

  describe('sr: — AI-234 quick-reply chip press', () => {
    function stateWithSuggestions(items: string[]): ConversationState {
      return {
        chat_id: 555,
        last_update_id: 0,
        thread_id: 0,
        turns: [],
        pending_suggestions: { items, message_id: 200 },
      };
    }

    it('sr: press injects the chip text as a synthetic turn', async () => {
      const deps = makeDeps({
        loadTopicState: async () => stateWithSuggestions(['Tell me more', 'Yes']),
      });
      const outcome = await handleCallbackQuery(makeCb('sr:0'), deps);
      assert.equal(outcome, 'sr:answered');
      assert.equal(deps.injected.length, 1, 'exactly one synthetic turn');
      assert.equal(deps.injected[0].message.text, 'Tell me more', 'the chip text verbatim');
      assert.equal((deps.injected[0] as any).__synthetic, 'button');
      assert.equal(deps.injected[0].message.chat.id, 555);
    });

    it('sr:1 injects the second chip', async () => {
      const deps = makeDeps({
        loadTopicState: async () => stateWithSuggestions(['Tell me more', 'Yes']),
      });
      const outcome = await handleCallbackQuery(makeCb('sr:1'), deps);
      assert.equal(outcome, 'sr:answered');
      assert.equal(deps.injected[0].message.text, 'Yes');
    });

    it('sr: gone when no pending suggestions', async () => {
      const deps = makeDeps(); // default fixture state has no pending_suggestions
      const outcome = await handleCallbackQuery(makeCb('sr:0'), deps);
      assert.equal(outcome, 'sr:gone');
      assert.equal(deps.injected.length, 0);
    });

    it('sr: index out of bounds answers with an alert and injects nothing', async () => {
      const deps = makeDeps({
        loadTopicState: async () => stateWithSuggestions(['Only one']),
      });
      const outcome = await handleCallbackQuery(makeCb('sr:5'), deps);
      assert.equal(outcome, 'sr:bad');
      assert.equal(deps.injected.length, 0);
    });
  });

  describe('qt: — task-lane question press (2026-09-02, handover Wave 2 SPEC §3.1 A.3)', () => {
    // Fresh PA_HOME per test: _resetTopicTasksForTest only clears the module
    // mutex — store FILES persist, and this file shares one PA_HOME.
    let tempDir: string;
    let originalPaHome: string | undefined;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'callbacks-qt-'));
      originalPaHome = process.env.PA_HOME;
      process.env.PA_HOME = tempDir;
      _resetTopicTasksForTest();
    });

    afterEach(async () => {
      _resetTopicTasksForTest();
      if (originalPaHome === undefined) delete process.env.PA_HOME;
      else process.env.PA_HOME = originalPaHome;
      await rm(tempDir, { recursive: true, force: true });
    });

    /** The press must arrive from the SAME chat/thread the store was seeded under —
     *  handleCallbackQuery derives (chatId, threadId) from cb.message. */
    function taskCb(data: string): CallbackQuery {
      return makeCb(data, {
        message: {
          message_id: 100,
          chat: { id: CHAT_ID, type: 'supergroup' },
          date: Math.floor(Date.now() / 1000),
          text: 'card',
          message_thread_id: THREAD_ID,
        },
      });
    }

    /** REAL producer chain in the sandboxed PA_HOME: queue → claim → park with a
     *  question, exactly as the executor's parkOnQuestion leaves the record. */
    async function seedParkedTask(question?: { text: string; options: string[] }): Promise<string> {
      await appendTask(CHAT_ID, THREAD_ID, { title: 'needs a pick', prompt: 'the prompt text', createdBy: 'cli' });
      const claimed = await claimNextTask(CHAT_ID, THREAD_ID);
      assert.ok(claimed);
      if (question) await parkTask(CHAT_ID, THREAD_ID, claimed.id, question);
      return claimed.id;
    }

    it('qt press answers task and writes question_answered event', async () => {
      const taskId = await seedParkedTask({ text: 'Pick one', options: ['A — faster', 'B — safer'] });
      const deps = makeDeps({ loadRunningTasks: async () => listRunningTasks(CHAT_ID, THREAD_ID) });
      const outcome = await handleCallbackQuery(taskCb(`qt:${taskId}:1`), deps);
      assert.equal(outcome, 'qt:answered');
      assert.equal(deps.injected.length, 0, 'CONVERGENCE, not injection — no synthetic turn');
      const [record] = await listRunningTasks(CHAT_ID, THREAD_ID);
      assert.equal(record.status, 'ready', 'the answer parked the record for the next drain tick');
      assert.ok(
        record.micro_thread.some((t) => t.role === 'user' && t.text === 'B — safer'),
        'the option text landed in the task micro_thread'
      );
      const eventsPath = join(process.env.PA_HOME!, 'topic-events', `${CHAT_ID}_${THREAD_ID}.jsonl`);
      const raw = await readFile(eventsPath, 'utf8');
      const events = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const ev = events.find((e: any) => e.kind === 'question_answered' && e.ref === taskId && e.detail === 'B — safer');
      assert.ok(ev, 'question_answered event with the task id as ref and the option text as detail');
    });

    it('qt gone when no question', async () => {
      const deps = makeDeps({ loadRunningTasks: async () => listRunningTasks(CHAT_ID, THREAD_ID) });
      // (a) no such task at all
      assert.equal(await handleCallbackQuery(taskCb('qt:tt-000000000000:0'), deps), 'qt:gone');
      // (b) the task exists but carries no question (running, never parked)
      const runningId = await seedParkedTask();
      assert.equal(await handleCallbackQuery(taskCb(`qt:${runningId}:0`), deps), 'qt:gone');
      const [record] = await listRunningTasks(CHAT_ID, THREAD_ID);
      assert.equal(record.status, 'running', 'a gone press never disturbs the record');
      const answerCalls = fetchStub.calls.filter((c) => c.url.includes('answerCallbackQuery'));
      assert.equal(answerCalls.length, 2);
      assert.equal(answerCalls[0].body.text, 'Task question no longer active');
    });

    it('qt index out of bounds answers with an alert and leaves the record parked', async () => {
      const taskId = await seedParkedTask({ text: 'Pick one', options: ['A — faster', 'B — safer'] });
      const deps = makeDeps({ loadRunningTasks: async () => listRunningTasks(CHAT_ID, THREAD_ID) });
      const outcome = await handleCallbackQuery(taskCb(`qt:${taskId}:3`), deps); // only 2 options
      assert.equal(outcome, 'qt:bad');
      assert.equal(deps.injected.length, 0);
      const [record] = await listRunningTasks(CHAT_ID, THREAD_ID);
      assert.equal(record.status, 'parked', 'a bad press never answers the task');
      assert.equal(record.micro_thread.length, 0);
    });
  });

  describe('cc:model / cc:effort — value picker source (declared over hardcoded default)', () => {
    function stateWithWorker(worker: string): ConversationState {
      return { chat_id: 555, last_update_id: 0, thread_id: 0, turns: [], preferred_worker: worker };
    }

    it('cc:model with a worker declaring 11 models shows every declared model, in declared order, 2 per row', async () => {
      const declared = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11'];
      const deps = makeDeps({
        loadTopicState: async () => stateWithWorker('agy'),
        declaredValues: async (w, s) => (w === 'agy' && s === 'model' ? declared : []),
        observedValues: async () => [],
      });
      const outcome = await handleCallbackQuery(makeCb('cc:model'), deps);
      assert.equal(outcome, 'cc:model');
      const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
      assert.equal(editCalls.length, 1);
      const buttons = allButtons(editCalls[0].body.reply_markup);
      for (const m of declared) assert.ok(buttons.includes(`cc:set:model:${m}`), `missing ${m}`);
      assert.ok(buttons.includes('cc:set:model:clear'));
      // declared order preserved, clear last (before the back row, which is separate)
      const dataRows = editCalls[0].body.reply_markup.inline_keyboard.slice(0, -1);
      const flat = dataRows.flat().map((b: any) => b.callback_data);
      assert.deepEqual(flat, [...declared, 'clear'].map((v) => `cc:set:model:${v}`));
      for (const row of dataRows) assert.ok(row.length <= 2, '2 per row once > 6 values');
      const lastRow = editCalls[0].body.reply_markup.inline_keyboard.slice(-1)[0];
      assert.equal(lastRow.length, 2);
      assert.equal(lastRow[0].callback_data, 'cc:submit');
      assert.equal(lastRow[1].callback_data, 'cc:discard');
    });

    it('an observed value already in the declared list is not duplicated; an observed-only value appears after declared', async () => {
      const declared = ['opus', 'sonnet'];
      const deps = makeDeps({
        loadTopicState: async () => stateWithWorker('claude'),
        declaredValues: async () => declared,
        observedValues: async () => ['Opus', 'haiku-legacy'], // case-insensitive dup of 'opus' + a novel one
      });
      const outcome = await handleCallbackQuery(makeCb('cc:model'), deps);
      assert.equal(outcome, 'cc:model');
      const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
      const buttons = allButtons(editCalls[0].body.reply_markup).filter((d) => d.startsWith('cc:set:'));
      assert.deepEqual(
        buttons,
        ['opus', 'sonnet', 'haiku-legacy', 'clear'].map((v) => `cc:set:model:${v}`),
        'declared values first, then observed-only, deduped case-insensitively, then clear'
      );
    });

    it('a worker with no declared values falls back to the known default + observed + clear, 1 per row', async () => {
      const deps = makeDeps({
        loadTopicState: async () => stateWithWorker('unknown-worker'),
        declaredValues: async () => [],
        observedValues: async () => ['seen-once'],
      });
      const outcome = await handleCallbackQuery(makeCb('cc:effort'), deps);
      assert.equal(outcome, 'cc:effort');
      const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
      const buttons = allButtons(editCalls[0].body.reply_markup).filter((d) => d.startsWith('cc:set:'));
      // 'unknown-worker' has no KNOWN_CLI_DEFAULT_EFFORTS entry either, so this is just observed + clear.
      assert.deepEqual(buttons, ['cc:set:effort:seen-once', 'cc:set:effort:clear']);
      const dataRows = editCalls[0].body.reply_markup.inline_keyboard.slice(0, -1);
      for (const row of dataRows) assert.equal(row.length, 1, '6 or fewer values stay 1 per row');
    });

    it('every callback_data in the picker stays within the 64-byte budget', async () => {
      const declared = Array.from({ length: 11 }, (_, i) => `claude-opus-4-6-thinking-variant-${i}`);
      const deps = makeDeps({
        loadTopicState: async () => stateWithWorker('agy'),
        declaredValues: async () => declared,
        observedValues: async () => [],
      });
      await handleCallbackQuery(makeCb('cc:model'), deps);
      const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
      const buttons = allButtons(editCalls[0].body.reply_markup);
      for (const d of buttons) assert.ok(Buffer.byteLength(d) <= 64, d);
    });
  });

  describe('sk:run:reminders — two-step confirm against a real listSkills() fixture', () => {
    let paHome: string;
    let savedPaHome: string | undefined;

    beforeEach(async () => {
      paHome = await mkdtemp(join(tmpdir(), 'tgbot-cb-pahome-'));
      await mkdir(join(paHome, 'skills', 'reminders'), { recursive: true });
      await writeFile(join(paHome, 'skills', 'reminders', 'skill.md'), 'Send reminders.', 'utf8');
      savedPaHome = process.env.PA_HOME;
      process.env.PA_HOME = paHome;
    });

    afterEach(async () => {
      await waitForDrain();
      if (savedPaHome === undefined) delete process.env.PA_HOME;
      else process.env.PA_HOME = savedPaHome;
      await rm(paHome, { recursive: true, force: true });
    });

    it('first tap (unconfirmed) injects nothing and rewrites the keyboard to the confirm state', async () => {
      const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '1' } });
      const outcome = await handleCallbackQuery(makeCb('sk:run:reminders'), deps);
      assert.equal(outcome, 'sk:run:unconfirmed');
      assert.equal(deps.injected.length, 0);
      const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
      assert.equal(editCalls.length, 1);
      assert.ok(editCalls[0].body.reply_markup, 'the confirm-state keyboard must be attached, not removed');
      const data = editCalls[0].body.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
      assert.ok(data.includes('sk:run:reminders:c'));
    });

    it('the second tap (:c) spawns exactly once and removes the keyboard', async () => {
      const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
      _setSpawnForTest(((cmd: string, args: string[]) => {
        spawnCalls.push({ cmd, args });
        const child = { on: () => child, unref: () => {} }; return child as any;
      }) as any);

      const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '1' } });
      const outcome = await handleCallbackQuery(makeCb('sk:run:reminders:c'), deps);
      assert.equal(outcome, 'sk:run:started');
      assert.equal(spawnCalls.length, 1);
      assert.equal(spawnCalls[0].cmd, 'pa');
      assert.deepEqual(spawnCalls[0].args, ['run', 'reminders']);
      const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageText'));
      assert.equal(editCalls.length, 1);
      assert.equal(editCalls[0].body.reply_markup, undefined, 'a terminal action removes the keyboard entirely');
    });

    it('a protected skill (push) is refused even when confirmed, and never spawns', async () => {
      const spawnCalls: unknown[] = [];
      _setSpawnForTest(((..._args: unknown[]) => {
        spawnCalls.push(_args);
        const child = { on: () => child, unref: () => {} }; return child as any;
      }) as any);
      const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '1' } });
      const outcome = await handleCallbackQuery(makeCb('sk:run:push:c'), deps);
      assert.equal(outcome, 'sk:protected');
      assert.equal(spawnCalls.length, 0);
    });
  });

  describe('WP-D2 pa-side prefixes — ru/si/ch/wt (2026-09-02, SPEC §3.4)', () => {
    let paHome: string;
    let savedPaHome: string | undefined;

    beforeEach(async () => {
      paHome = await mkdtemp(join(tmpdir(), 'tgbot-cb-wpd2-'));
      await mkdir(join(paHome, 'chains'), { recursive: true });
      await writeFile(join(paHome, 'chains', 'nightly-sync.yaml'), 'steps: []\n', 'utf8');
      savedPaHome = process.env.PA_HOME;
      process.env.PA_HOME = paHome;
    });

    afterEach(async () => {
      await waitForDrain();
      if (savedPaHome === undefined) delete process.env.PA_HOME;
      else process.env.PA_HOME = savedPaHome;
      await rm(paHome, { recursive: true, force: true });
    });

    it('ru press spawns pa rules accept', async () => {
      const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
      _setSpawnForTest(((cmd: string, args: string[]) => {
        spawnCalls.push({ cmd, args });
        const child = { on: () => child, unref: () => {} }; return child as any;
      }) as any);
      const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '1' } });
      const outcome = await handleCallbackQuery(makeCb('ru:rule-feedback-1:a'), deps);
      assert.equal(outcome, 'ru:accepted');
      assert.equal(spawnCalls.length, 1);
      assert.equal(spawnCalls[0].cmd, 'pa');
      assert.deepEqual(spawnCalls[0].args, ['rules', 'accept', 'rule-feedback-1']);

      const reject = await handleCallbackQuery(makeCb('ru:rule-feedback-1:x'), deps);
      assert.equal(reject, 'ru:rejected');
      assert.deepEqual(spawnCalls[1].args, ['rules', 'supersede', 'rule-feedback-1', '--reason', 'rejected via weekly-digest button']);
    });

    it('si mute requires two taps', async () => {
      const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
      _setSpawnForTest(((cmd: string, args: string[]) => {
        spawnCalls.push({ cmd, args });
        const child = { on: () => child, unref: () => {} }; return child as any;
      }) as any);
      const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '1' } });

      const first = await handleCallbackQuery(makeCb('si:bg-leak:m'), deps);
      assert.equal(first, 'si:unconfirmed');
      assert.equal(spawnCalls.length, 0, 'no spawn until confirmed');
      const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
      assert.equal(editCalls.length, 1);
      const data = editCalls[0].body.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
      assert.ok(data.includes('si:bg-leak:m:c'), 'first tap rewrites to the confirm-state keyboard');

      const second = await handleCallbackQuery(makeCb('si:bg-leak:m:c'), deps);
      assert.equal(second, 'si:muted');
      assert.equal(spawnCalls.length, 1);
      assert.deepEqual(spawnCalls[0].args, ['fix', 'bg-leak', '--note', 'muted from nightly report button']);
    });

    it('ch press spawns pa chain run for known chain', async () => {
      const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
      _setSpawnForTest(((cmd: string, args: string[]) => {
        spawnCalls.push({ cmd, args });
        const child = { on: () => child, unref: () => {} }; return child as any;
      }) as any);
      const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '1' } });

      const first = await handleCallbackQuery(makeCb('ch:r:nightly-sync'), deps);
      assert.equal(first, 'ch:unconfirmed');
      assert.equal(spawnCalls.length, 0);

      const second = await handleCallbackQuery(makeCb('ch:r:nightly-sync:c'), deps);
      assert.equal(second, 'ch:started');
      assert.equal(spawnCalls.length, 1);
      assert.equal(spawnCalls[0].cmd, 'pa');
      assert.deepEqual(spawnCalls[0].args, ['chain', 'run', 'nightly-sync']);
    });

    it('ch unknown chain refused', async () => {
      const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
      _setSpawnForTest(((cmd: string, args: string[]) => {
        spawnCalls.push({ cmd, args });
        const child = { on: () => child, unref: () => {} }; return child as any;
      }) as any);
      const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '1' } });
      const outcome = await handleCallbackQuery(makeCb('ch:r:removed-chain:c'), deps);
      assert.equal(outcome, 'ch:unknown');
      assert.equal(spawnCalls.length, 0, 'an unknown chain never spawns');
      const answerCalls = fetchStub.calls.filter((c) => c.url.includes('answerCallbackQuery'));
      assert.ok(answerCalls.some((c) => c.body.show_alert === true));
    });

    it('wt press spawns pa watch re-register', async () => {
      const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
      _setSpawnForTest(((cmd: string, args: string[]) => {
        spawnCalls.push({ cmd, args });
        const child = { on: () => child, unref: () => {} }; return child as any;
      }) as any);
      const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '1' } });
      const outcome = await handleCallbackQuery(makeCb('wt:w-0123abcd:r'), deps);
      assert.equal(outcome, 'wt:re-registered');
      assert.equal(spawnCalls.length, 1);
      assert.equal(spawnCalls[0].cmd, 'pa');
      assert.deepEqual(spawnCalls[0].args, ['watch', 're-register', 'w-0123abcd']);
    });
  });

  describe('ow: — orphan-edit disposition (AI-214 WP-B)', () => {
    it('press spawns pa orphan <sub> <gid> with cwd=botCwd and toasts per action', async () => {
      const spawnCalls: Array<{ cmd: string; args: string[]; opts: any }> = [];
      _setSpawnForTest(((cmd: string, args: string[], opts: any) => {
        spawnCalls.push({ cmd, args, opts });
        const child = { on: () => child, unref: () => {} }; return child as any;
      }) as any);
      const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '1' } });

      const land = await handleCallbackQuery(makeCb('ow:0123abcd4567:l'), deps);
      assert.equal(land, 'ow:l');
      assert.equal(spawnCalls.length, 1);
      assert.equal(spawnCalls[0].cmd, 'pa');
      assert.deepEqual(spawnCalls[0].args, ['orphan', 'land', '0123abcd4567']);
      assert.equal(spawnCalls[0].opts.cwd, deps.botCwd);
      let answerCalls = fetchStub.calls.filter((c) => c.url.includes('answerCallbackQuery'));
      assert.equal(answerCalls.length, 1);
      assert.equal(answerCalls[0].body.text, '📥 Landing…');

      const keep = await handleCallbackQuery(makeCb('ow:0123abcd4567:k'), deps);
      assert.equal(keep, 'ow:k');
      assert.deepEqual(spawnCalls[1].args, ['orphan', 'keep', '0123abcd4567']);
      answerCalls = fetchStub.calls.filter((c) => c.url.includes('answerCallbackQuery'));
      assert.equal(answerCalls[1].body.text, '💤 Keeping dirty 24h');

      const diff = await handleCallbackQuery(makeCb('ow:0123abcd4567:d'), deps);
      assert.equal(diff, 'ow:d');
      assert.deepEqual(spawnCalls[2].args, ['orphan', 'diff', '0123abcd4567']);
      answerCalls = fetchStub.calls.filter((c) => c.url.includes('answerCallbackQuery'));
      assert.equal(answerCalls[2].body.text, '📄 Showing diff');
    });

    it('fire-and-forget: unref with ONE error listener — a spawn failure logs, never dies silent (WB-304)', async () => {
      let unrefCalled = false;
      const listenerNames: string[] = [];
      // on() must be chainable — real children return themselves from .on().
      const mockChild = {
        unref: () => {
          unrefCalled = true;
        },
        on: (ev: string) => {
          listenerNames.push(ev);
          return mockChild;
        },
        once: (ev: string) => {
          listenerNames.push(ev);
          return mockChild;
        },
      };
      _setSpawnForTest((() => mockChild as any) as any);
      const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '1' } });
      const outcome = await handleCallbackQuery(makeCb('ow:0123abcd4567:l'), deps);
      assert.equal(outcome, 'ow:l');
      assert.equal(unrefCalled, true, 'child detached from the event loop');
      assert.deepEqual(listenerNames, ['error'], 'exactly the spawn-error listener — a spawn failure logs, never silent (WB-304)');
      const answerCalls = fetchStub.calls.filter((c) => c.url.includes('answerCallbackQuery'));
      assert.equal(answerCalls.length, 1, 'the press is still answered');
    });
  });

  describe('auth: — opens the pending link (auth broker Phase A)', () => {
    it('a resolvable request sends the URL byte-identical via sendPlainMessage (no parse_mode)', async () => {
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc-def_ghi&state=xyz';
      const deps = makeDeps({ authRequestUrl: async () => url });
      const outcome = await handleCallbackQuery(makeCb('auth:google:ir-0123456789ab'), deps);
      assert.equal(outcome, 'auth:opened');
      const answerCalls = fetchStub.calls.filter((c) => c.url.includes('answerCallbackQuery'));
      assert.equal(answerCalls.length, 1);
      assert.equal(answerCalls[0].body.text, '🔐 Opening the authorization link…');
      const sendCalls = fetchStub.calls.filter((c) => c.url.includes('/sendMessage'));
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].body.text, url, 'the URL must round-trip byte-identical');
      assert.equal('parse_mode' in sendCalls[0].body, false, 'no parse_mode key — sendPlainMessage, not sendMessage');
    });

    it('an unresolvable request answers the callback and sends nothing', async () => {
      const deps = makeDeps({ authRequestUrl: async () => null });
      const outcome = await handleCallbackQuery(makeCb('auth:google:ir-0123456789ab'), deps);
      assert.equal(outcome, 'auth:unresolved');
      const answerCalls = fetchStub.calls.filter((c) => c.url.includes('answerCallbackQuery'));
      assert.equal(answerCalls.length, 1, 'the press is still answered');
      const sendCalls = fetchStub.calls.filter((c) => c.url.includes('/sendMessage'));
      assert.equal(sendCalls.length, 0, 'nothing sent when the link cannot be resolved');
    });
  });

  describe('auth: — the REAL default reader against a realistic fixture (deep-recheck 2026-09-10)', () => {
    // The two tests above only ever exercise the INJECTED authRequestUrl seam
    // — never defaultAuthRequestUrl itself. That let a real bug ship: the
    // §3.3 broker row (`~/.pa/auth/requests/<id>.json`) NEVER carries
    // `auth_url` — neither real writer's AuthRequestRow shape
    // (`pa/src/lib/auth/store.ts`, `projects/voice-inbox/src/auth-providers.ts`)
    // has that field. `auth_url` is minted into the LEDGER's
    // `input_requests.params_json` by oauth-mint.ts / `pa auth request --url`.
    // defaultAuthRequestUrl used to read the broker-row file and therefore
    // always resolved null in production. Fixed via
    // `voiceInboxInputRequestAuthUrl` in `pa/src/lib/voice-inbox-ledger.ts`.
    let paHome: string;
    let savedPaHome: string | undefined;
    let Database: any;

    const REQUEST_ID = 'ir-0123456789ab';
    const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc-def&state=xyz';

    beforeEach(async () => {
      savedPaHome = process.env.PA_HOME;
      paHome = await mkdtemp(join(tmpdir(), 'tgbot-auth-url-'));
      process.env.PA_HOME = paHome;
      const require = createRequire(import.meta.url);
      // Load better-sqlite3 from pa/node_modules (relative to dist/tests/) —
      // same idiom as the "Decision capture" describe block below.
      Database = require(join(fileURLToPath(import.meta.url), '../../../../../pa/node_modules/better-sqlite3'));
    });

    afterEach(async () => {
      if (savedPaHome === undefined) delete process.env.PA_HOME;
      else process.env.PA_HOME = savedPaHome;
      await rm(paHome, { recursive: true, force: true });
    });

    /** Builds the REALISTIC on-disk state: the ledger's `input_requests` row
     *  carries `auth_url` in `params_json` (the only real writer), and the
     *  §3.3 broker-row file also exists, exactly as both real writers shape
     *  it — WITHOUT an `auth_url` field. */
    async function buildRealisticFixture(): Promise<void> {
      const ledgerDir = join(paHome, 'voice-inbox');
      await mkdir(ledgerDir, { recursive: true });
      const db = new Database(join(ledgerDir, 'ledger.sqlite'));
      try {
        db.exec('CREATE TABLE input_requests (request_id TEXT PRIMARY KEY, params_json TEXT NOT NULL)');
        db.prepare('INSERT INTO input_requests (request_id, params_json) VALUES (?, ?)').run(
          REQUEST_ID,
          JSON.stringify({ provider: 'google', auth_url: AUTH_URL })
        );
      } finally {
        db.close();
      }
      const requestsDir = join(paHome, 'auth', 'requests');
      await mkdir(requestsDir, { recursive: true });
      await writeFile(
        join(requestsDir, `${REQUEST_ID}.json`),
        JSON.stringify({
          request_id: REQUEST_ID, task_id: 'vi-0123456789ab', tenant_id: 't-1', shape: 'S1',
          provider: 'google', kind: 'oauth', status: 'pending',
          created_at: '2026-09-10T00:00:00.000Z', expires_at: '2026-09-10T12:00:00.000Z',
          state: null, code_verifier: null, redirect_uri: null, auth_id: null,
          answer_pointer: null, delivered_at: null,
        }),
        'utf8'
      );
    }

    it('resolves auth_url from the LEDGER and sends it, with no authRequestUrl override', async () => {
      await buildRealisticFixture();
      const fetchStub = stubFetch();
      try {
        const deps = makeDeps(); // no authRequestUrl override — exercises the real defaultAuthRequestUrl
        const outcome = await handleCallbackQuery(makeCb(`auth:google:${REQUEST_ID}`), deps);
        assert.equal(outcome, 'auth:opened');
        const sendCalls = fetchStub.calls.filter((c) => c.url.includes('/sendMessage'));
        assert.equal(sendCalls.length, 1, 'the real reader must resolve the URL and send it');
        assert.equal(sendCalls[0].body.text, AUTH_URL);
      } finally {
        fetchStub.restore();
      }
    });

    it('proves the OLD file-based reader would have failed on this exact realistic fixture', async () => {
      await buildRealisticFixture();
      // The pre-fix logic, verbatim: read the broker-row FILE and look for
      // `auth_url` there. Against the real §3.3 shape (no auth_url field
      // ever written by either real writer), this always resolves null —
      // the bug this fix closes.
      const oldReaderResult = await (async () => {
        try {
          const raw = await readFile(join(paHome, 'auth', 'requests', `${REQUEST_ID}.json`), 'utf8');
          const parsed = JSON.parse(raw) as { auth_url?: unknown };
          return typeof parsed.auth_url === 'string' && parsed.auth_url.startsWith('https://')
            ? parsed.auth_url
            : null;
        } catch {
          return null;
        }
      })();
      assert.equal(oldReaderResult, null, 'the old file-based reader never finds auth_url on a realistic fixture');
    });
  });

  describe('rs: resend', () => {
    beforeEach(() => {
      _resetResendStoreForTest();
    });

    it('a valid resend key injects the stored userText and removes the keyboard', async () => {
      let paHome: string | undefined;
      // resend-store resolves PA_HOME lazily too — reuse the ambient env if already set
      // by an outer test, otherwise create one so putResend has somewhere durable to write.
      const needsOwnHome = !process.env.PA_HOME;
      let ownHome: string | undefined;
      if (needsOwnHome) {
        ownHome = await mkdtemp(join(tmpdir(), 'tgbot-cb-resend-'));
        process.env.PA_HOME = ownHome;
        _resetResendStoreForTest();
      }
      try {
        await putResend({ chatId: 555, threadId: 0, updateId: 42, messageId: 10, userText: 'please retry this', storedAt: new Date().toISOString() });
        const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '1' } });
        const outcome = await handleCallbackQuery(makeCb('rs:555:0:42'), deps);
        assert.equal(outcome, 'rs:resent');
        assert.equal(deps.injected.length, 1);
        assert.equal(deps.injected[0].message.text, 'please retry this');
      } finally {
        if (needsOwnHome) {
          delete process.env.PA_HOME;
          if (ownHome) await rm(ownHome, { recursive: true, force: true });
          _resetResendStoreForTest();
        }
      }
    });

    it('an already-consumed / unknown resend key answers with show_alert and injects nothing', async () => {
      const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '1' } });
      const outcome = await handleCallbackQuery(makeCb('rs:1:0:999999999999'), deps);
      assert.equal(outcome, 'rs:expired');
      assert.equal(deps.injected.length, 0);
    });

    it('a placeholder-userText record is refused with rs:untranscribed — nothing injected, keyboard removed', async () => {
      let paHome: string | undefined;
      const needsOwnHome = !process.env.PA_HOME;
      let ownHome: string | undefined;
      if (needsOwnHome) {
        ownHome = await mkdtemp(join(tmpdir(), 'tgbot-cb-resend-'));
        process.env.PA_HOME = ownHome;
        _resetResendStoreForTest();
      }
      try {
        await putResend({ chatId: 556, threadId: 0, updateId: 43, messageId: 11, userText: '[Voice message]', storedAt: new Date().toISOString() });
        const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '1' } });
        const outcome = await handleCallbackQuery(makeCb('rs:556:0:43'), deps);
        assert.equal(outcome, 'rs:untranscribed');
        assert.equal(deps.injected.length, 0, 'nothing injected for placeholder-userText refusal');
        const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageText'));
        assert.equal(editCalls.length, 1, 'exactly one editMessageText call to remove keyboard');
        assert.equal((editCalls[0].body as { reply_markup?: unknown }).reply_markup, undefined, 'keyboard removed (reply_markup set to undefined)');
      } finally {
        if (needsOwnHome) {
          delete process.env.PA_HOME;
          if (ownHome) await rm(ownHome, { recursive: true, force: true });
          _resetResendStoreForTest();
        }
      }
    });

    it('a userTextSettled record resends its transcript normally (marker bypasses the guard)', async () => {
      let paHome: string | undefined;
      const needsOwnHome = !process.env.PA_HOME;
      let ownHome: string | undefined;
      if (needsOwnHome) {
        ownHome = await mkdtemp(join(tmpdir(), 'tgbot-cb-resend-'));
        process.env.PA_HOME = ownHome;
        _resetResendStoreForTest();
      }
      try {
        await putResend({ chatId: 557, threadId: 0, updateId: 44, messageId: 12, userText: '[Voice message] hello there', userTextSettled: true, storedAt: new Date().toISOString() });
        const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '1' } });
        const outcome = await handleCallbackQuery(makeCb('rs:557:0:44'), deps);
        assert.equal(outcome, 'rs:resent', 'settled transcript resends normally (not rs:untranscribed)');
        assert.equal(deps.injected.length, 1);
        assert.equal(deps.injected[0].message.text, '[Voice message] hello there');
      } finally {
        if (needsOwnHome) {
          delete process.env.PA_HOME;
          if (ownHome) await rm(ownHome, { recursive: true, force: true });
          _resetResendStoreForTest();
        }
      }
    });
  });

  // bp-retry (2026-08-25): wf:retry used to always pick the topic's most-recent user
  // turn, which can have moved on to an unrelated message by the time a stale
  // failover card is tapped. The failover notice is sent as a reply to the message
  // that failed (main.ts's sendMessageWithKeyboard passes the failed message_id as
  // reply_to_message_id), so the press carries its own anchor — match on it.
  describe('wf:retry — reply-anchored turn resolution (bp-retry)', () => {
    function stateWithTurns(turns: ConversationState['turns']): ConversationState {
      return { chat_id: 555, last_update_id: 0, thread_id: 0, turns };
    }

    it('reply_to_message.message_id matching an OLDER user turn injects that turn\'s text, not the newest', async () => {
      const state = stateWithTurns([
        { role: 'user', text: 'older message A (this failed)', timestamp: new Date().toISOString(), message_id: 10 },
        { role: 'assistant', text: 'failover notice', timestamp: new Date().toISOString() },
        { role: 'user', text: 'newer unrelated message B', timestamp: new Date().toISOString(), message_id: 30 },
      ]);
      const deps = makeDeps({ loadTopicState: async () => state });
      const cb = makeCb('wf:retry', {
        message: {
          message_id: 40, // the failover notice itself
          chat: { id: 555, type: 'supergroup' },
          date: Math.floor(Date.now() / 1000),
          text: 'failover card',
          message_thread_id: 0,
          reply_to_message: { message_id: 10, chat: { id: 555, type: 'supergroup' }, date: 0 },
        },
      });
      const outcome = await handleCallbackQuery(cb, deps);
      assert.equal(outcome, 'wf:retry');
      assert.equal(deps.injected.length, 1);
      assert.equal(deps.injected[0].message.text, 'older message A (this failed)');
    });

    it('no reply_to_message falls back to the newest user turn (legacy behaviour preserved)', async () => {
      const state = stateWithTurns([
        { role: 'user', text: 'older message A', timestamp: new Date().toISOString(), message_id: 10 },
        { role: 'user', text: 'newest message B', timestamp: new Date().toISOString(), message_id: 30 },
      ]);
      const deps = makeDeps({ loadTopicState: async () => state });
      const cb = makeCb('wf:retry', {
        message: {
          message_id: 40,
          chat: { id: 555, type: 'supergroup' },
          date: Math.floor(Date.now() / 1000),
          text: 'failover card (legacy, no reply_to_message)',
          message_thread_id: 0,
        },
      });
      const outcome = await handleCallbackQuery(cb, deps);
      assert.equal(outcome, 'wf:retry');
      assert.equal(deps.injected.length, 1);
      assert.equal(deps.injected[0].message.text, 'newest message B');
    });

    it('a reply_to_message anchor that matches no turn (aged out of the window) refuses instead of resending the wrong message', async () => {
      const state = stateWithTurns([
        { role: 'user', text: 'newest message B', timestamp: new Date().toISOString(), message_id: 30 },
      ]);
      const deps = makeDeps({ loadTopicState: async () => state });
      const cb = makeCb('wf:retry', {
        message: {
          message_id: 40,
          chat: { id: 555, type: 'supergroup' },
          date: Math.floor(Date.now() / 1000),
          text: 'failover card',
          message_thread_id: 0,
          reply_to_message: { message_id: 999, chat: { id: 555, type: 'supergroup' }, date: 0 }, // not in state.turns
        },
      });
      const outcome = await handleCallbackQuery(cb, deps);
      assert.equal(outcome, 'wf:retry:anchor-not-found');
      assert.equal(deps.injected.length, 0, 'must NOT silently resend an unrelated turn');
    });
  });

  // bp-retry (2026-08-25): cc:agent/cc:model/cc:effort used to terminate the worker
  // cascade on '' when a topic had neither preferred_worker nor a hydrated
  // model_status (fresh/never-hydrated topic, legacy state file), collapsing the
  // picker to a single 'clear' button while typed /model showed the full declared
  // list. Mirror the canonical cascade via the new effectiveDefaultWorker fallback.
  describe('cc:agent / cc:model — effective-default worker fallback (bp-retry)', () => {
    it('cc:model on a state with no preferred_worker and no model_status still shows the declared list for the effective default worker', async () => {
      const state: ConversationState = { chat_id: 555, last_update_id: 0, thread_id: 0, turns: [] };
      const deps = makeDeps({
        loadTopicState: async () => state,
        effectiveDefaultWorker: async () => 'agy',
        declaredValues: async (w, s) => (w === 'agy' && s === 'model' ? ['m1', 'm2'] : []),
        observedValues: async () => [],
      });
      const outcome = await handleCallbackQuery(makeCb('cc:model'), deps);
      assert.equal(outcome, 'cc:model');
      const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
      assert.equal(editCalls.length, 1);
      const buttons = allButtons(editCalls[0].body.reply_markup).filter((d) => d.startsWith('cc:set:'));
      assert.deepEqual(buttons, ['cc:set:model:m1', 'cc:set:model:m2', 'cc:set:model:clear'], 'must show the declared list, not collapse to just clear');
    });

    it('cc:agent on a state with no preferred_worker and no model_status marks the effective default as current', async () => {
      const state: ConversationState = { chat_id: 555, last_update_id: 0, thread_id: 0, turns: [] };
      const deps = makeDeps({
        loadTopicState: async () => state,
        listWorkerNames: async () => ['agy', 'claude'],
        effectiveDefaultWorker: async () => 'agy',
      });
      const outcome = await handleCallbackQuery(makeCb('cc:agent'), deps);
      assert.equal(outcome, 'cc:agent');
      const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
      const marked = editCalls[0].body.reply_markup.inline_keyboard.flat().find((b: any) => b.text.startsWith('•'));
      assert.equal(marked?.text, '• agy', 'the effective default worker must be marked current, not left unmarked');
    });
  });

  // bp-retry (2026-08-25): refreshPinnedStatusCardInPlace (main.ts) is driven by a
  // periodic cross-topic sweep and used to unconditionally rewrite the pinned card's
  // keyboard back to the top-level menu — even mid-navigation through a cc:agent/
  // cc:model/cc:effort submenu on the same message id. currentCardKeyboard is the
  // accessor that lets the sweep re-apply the submenu instead, while it's fresh.
  describe('currentCardKeyboard — submenu strand protection (bp-retry)', () => {
    function makeCardCb(data: string, chatId: number, messageId: number): CallbackQuery {
      return makeCb(data, {
        message: {
          message_id: messageId,
          chat: { id: chatId, type: 'supergroup' },
          date: Math.floor(Date.now() / 1000),
          text: 'card',
          message_thread_id: 0,
        },
      });
    }

    it('a recorded submenu is returned by currentCardKeyboard while fresh', async () => {
      const chatId = 70001;
      const messageId = 100;
      const deps = makeDeps({ loadTopicState: async () => ({ chat_id: chatId, last_update_id: 0, thread_id: 0, turns: [], preferred_worker: 'agy' }) });
      await handleCallbackQuery(makeCardCb('cc:model', chatId, messageId), deps);
      const kb = currentCardKeyboard(chatId, messageId);
      assert.ok(kb, 'submenu keyboard must be recorded');
      const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
      assert.deepEqual(kb, editCalls[0].body.reply_markup, 'recorded keyboard must match what was actually rendered');
    });

    it('cc:back clears the recorded submenu', async () => {
      const chatId = 70002;
      const messageId = 100;
      const deps = makeDeps({ loadTopicState: async () => ({ chat_id: chatId, last_update_id: 0, thread_id: 0, turns: [], preferred_worker: 'agy' }) });
      await handleCallbackQuery(makeCardCb('cc:model', chatId, messageId), deps);
      assert.ok(currentCardKeyboard(chatId, messageId), 'precondition: submenu recorded');
      await handleCallbackQuery(makeCardCb('cc:back', chatId, messageId), deps);
      assert.equal(currentCardKeyboard(chatId, messageId), undefined, 'cc:back must clear the recorded submenu');
    });

    it('a recorded submenu older than 2 minutes is no longer returned (clock injected, no sleep)', async () => {
      const chatId = 70003;
      const messageId = 100;
      const deps = makeDeps({ loadTopicState: async () => ({ chat_id: chatId, last_update_id: 0, thread_id: 0, turns: [], preferred_worker: 'agy' }) });
      await handleCallbackQuery(makeCardCb('cc:effort', chatId, messageId), deps);
      assert.ok(currentCardKeyboard(chatId, messageId), 'fresh: still returned right after recording (real clock)');
      // Inject a "now" well past the 2-minute freshness window — generously margined
      // above the actual recording instant so this can never flake on real-clock skew
      // between capturing a timestamp and the recording call actually running.
      const wellPastFreshWindow = Date.now() + 2 * 60 * 1000 + 5000;
      assert.equal(currentCardKeyboard(chatId, messageId, wellPastFreshWindow), undefined, 'stale: must not be returned past the 2-minute freshness window');
    });
  });

  // ---------------------------------------------------------------------------
  // Button-ack tests (2026-08-28 spec WP4)
  // ---------------------------------------------------------------------------

  describe('Button-ack — terminal branches call editMessageText with acknowledgment', () => {
    it('cf:y calls editMessageText with "✅ Selected: Yes" and strips keyboard', async () => {
      const deps = makeDeps();
      const outcome = await handleCallbackQuery(makeCb('cf:y'), deps);
      assert.equal(outcome, 'cf:y');
      const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageText'));
      assert.equal(editCalls.length, 1);
      assert.ok(editCalls[0].body.text.includes('✅ Selected: Yes'), 'text must contain acknowledgment');
      assert.equal(editCalls[0].body.reply_markup, undefined, 'keyboard must be stripped');
    });

    it('wf:retry calls editMessageText with "✅ Selected: Retry last message"', async () => {
      const state = { chat_id: 555, last_update_id: 0, thread_id: 0, turns: [{ role: 'user' as const, text: 'old message', timestamp: new Date().toISOString(), message_id: 10 }] };
      const deps = makeDeps({ loadTopicState: async () => state });
      const cb = makeCb('wf:retry', {
        message: {
          message_id: 40,
          chat: { id: 555, type: 'supergroup' },
          date: Math.floor(Date.now() / 1000),
          text: 'failover card',
          message_thread_id: 0,
          reply_to_message: { message_id: 10, chat: { id: 555, type: 'supergroup' }, date: 0 },
        },
      });
      const outcome = await handleCallbackQuery(cb, deps);
      assert.equal(outcome, 'wf:retry');
      const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageText'));
      assert.equal(editCalls.length, 1);
      assert.ok(editCalls[0].body.text.includes('✅ Selected: Retry last message'));
      assert.equal(editCalls[0].body.reply_markup, undefined);
    });

    it('rm:1h calls editMessageText with "✅ Selected: Snoozed 1 h"', async () => {
      const deps = makeDeps();
      const outcome = await handleCallbackQuery(makeCb('rm:1h', {
        message: {
          message_id: 12345,
          chat: { id: -1009999999999, type: 'supergroup' },
          date: Math.floor(Date.now() / 1000),
          text: 'Reminder: call the clinic',
          message_thread_id: 4242,
        },
      }), deps);
      assert.equal(outcome, 'rm:1h');
      const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageText'));
      assert.equal(editCalls.length, 1);
      assert.ok(editCalls[0].body.text.includes('✅ Selected: Snoozed 1 h'));
      assert.equal(editCalls[0].body.reply_markup, undefined);
    });

    it('mc:a calls editMessageText with "✅ Selected: Accept"', async () => {
      const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '1' } });
      const outcome = await handleCallbackQuery(makeCb('mc:cf-20260818120000-001:a'), deps);
      assert.equal(outcome, 'mc:a');
      const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageText'));
      assert.equal(editCalls.length, 1);
      assert.ok(editCalls[0].body.text.includes('✅ Selected: Accept'));
      assert.equal(editCalls[0].body.reply_markup, undefined);
    });

  });

  describe('Button-ack — keyboard-swap branches do NOT call editMessageText', () => {
    it('cc:agent submenu calls editMessageReplyMarkup with keyboard, not editMessageText', async () => {
      const deps = makeDeps();
      const outcome = await handleCallbackQuery(makeCb('cc:agent'), deps);
      assert.equal(outcome, 'cc:agent');
      const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageText'));
      assert.equal(editCalls.length, 0, 'editMessageText must not be called for keyboard swap');
      const markupCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
      assert.equal(markupCalls.length, 1);
      assert.ok(markupCalls[0].body.reply_markup, 'keyboard must be present');
    });

    it('sk unconfirmed calls editMessageReplyMarkup with keyboard, not editMessageText', async () => {
      let paHome: string;
      let savedPaHome: string | undefined;
      paHome = await mkdtemp(join(tmpdir(), 'tgbot-cb-pahome-'));
      await mkdir(join(paHome, 'skills', 'reminders'), { recursive: true });
      await writeFile(join(paHome, 'skills', 'reminders', 'skill.md'), 'Send reminders.', 'utf8');
      savedPaHome = process.env.PA_HOME;
      process.env.PA_HOME = paHome;
      try {
        const deps = makeDeps({ secrets: { PA_OPERATOR_USER_ID: '1' } });
        const outcome = await handleCallbackQuery(makeCb('sk:run:reminders'), deps);
        assert.equal(outcome, 'sk:run:unconfirmed');
        const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageText'));
        assert.equal(editCalls.length, 0, 'editMessageText must not be called for keyboard swap');
        const markupCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
        assert.equal(markupCalls.length, 1);
        assert.ok(markupCalls[0].body.reply_markup, 'keyboard must be present');
      } finally {
        if (savedPaHome === undefined) delete process.env.PA_HOME;
        else process.env.PA_HOME = savedPaHome;
        await rm(paHome, { recursive: true, force: true });
      }
    });
  });

  // Removed dq:replay test - requires mocking DLQ functions which are not injected through CallbackDeps
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// AI-192 (2026-09-03): cc: pickers keep the card's keyboard. ackSelection's
// editMessageText strips keyboards unless reply_markup is re-passed, so a
// recorded (fresh) submenu is re-attached; cc: presses add NO selected-value
// echo (the pin just reflects the new state when the synthetic command's card
// refresh lands); in-thread prefixes keep their echo.
// ---------------------------------------------------------------------------

describe('AI-192 — control-card keyboard survives presses', () => {
  let fetchStub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    fetchStub = stubFetch();
    _resetCardKeyboardIndexForTest();
  });

  afterEach(() => {
    fetchStub.restore();
    _restoreSpawnForTest();
    _resetCardKeyboardIndexForTest();
  });

  it('a pin edit (ackSelection) re-attaches the ACTIVE submenu keyboard recorded on that message', async () => {
    const deps = makeDeps();
    // Open the agent picker on message 100 — this records it as the active submenu.
    await handleCallbackQuery(makeCb('cc:agent'), deps);
    const pickerCall = fetchStub.calls.find((c) => c.url.includes('editMessageReplyMarkup'))!;
    assert.ok(pickerCall, 'cc:agent must render the picker in place');
    const pickerData = pickerCall.body.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);

    // An in-thread press (cf:) acks by editing the SAME message — the recorded
    // submenu must ride the edit instead of being stripped.
    await handleCallbackQuery(makeCb('cf:y'), deps);
    const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageText'));
    const ackEdit = editCalls.find((c) => String(c.body.text).includes('✅ Selected: Yes'));
    assert.ok(ackEdit, 'cf: keeps its selected-value echo');
    assert.deepEqual(
      ackEdit.body.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data),
      pickerData,
      'the ack edit must re-attach the recorded submenu keyboard'
    );
  });

  it('an in-thread press with NO recorded submenu strips the keyboard as always', async () => {
    const deps = makeDeps();
    await handleCallbackQuery(makeCb('cf:y'), deps);
    const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageText'));
    assert.equal(editCalls.length, 1);
    assert.ok(String(editCalls[0].body.text).includes('✅ Selected: Yes'), 'echo unchanged for in-thread buttons');
    assert.equal(editCalls[0].body.reply_markup, undefined, 'no submenu recorded → keyboard strips');
  });

  it('a cc: set press STAGES: no injection, re-renders with ▸, records the selection', async () => {
    const deps = makeDeps();
    // Open the picker first (records the submenu), then press a value.
    await handleCallbackQuery(makeCb('cc:agent'), deps);
    fetchStub.calls.length = 0; // keep the assertions scoped to the set press

    const outcome = await handleCallbackQuery(makeCb('cc:set:agent:agy'), deps);
    assert.equal(outcome, 'cc:set:agent');

    const echoEdits = fetchStub.calls.filter(
      (c) => c.url.includes('editMessageText') && String(c.body.text).includes('✅ Selected')
    );
    assert.equal(echoEdits.length, 0, 'the selected-value echo is suppressed for cc: presses');

    // The toast carries the feedback — and names the confirmation step.
    const toast = fetchStub.calls.find((c) => c.url.includes('answerCallbackQuery'));
    assert.equal(toast?.body.text, 'Agent → agy · Submit to apply');

    // NOTHING is injected — the press only stages.
    assert.equal(deps.injected.length, 0);

    // The same picker re-renders with the tapped value staged (▸).
    const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
    assert.equal(editCalls.length, 1);
    const buttons = editCalls[0].body.reply_markup.inline_keyboard.flat();
    const staged = buttons.find((b: any) => b.callback_data === 'cc:set:agent:agy');
    assert.ok(staged, 'the tapped value is still on the keyboard');
    assert.equal(staged.text, '▸ agy');

    // The selection is recorded on the card keyboard index (Submit will read it).
    const recorded = currentCardKeyboard(555, 100);
    assert.ok(recorded, 'the staged picker is recorded');
    assert.ok(
      recorded!.inline_keyboard.flat().some((b) => b.callback_data === 'cc:set:agent:agy'),
      'the recorded keyboard includes the staged value'
    );
  });

  it('a cc: new press adds no echo and still injects /new', async () => {
    const deps = makeDeps();
    const outcome = await handleCallbackQuery(makeCb('cc:new'), deps);
    assert.equal(outcome, 'cc:new');
    const echoEdits = fetchStub.calls.filter(
      (c) => c.url.includes('editMessageText') && String(c.body.text).includes('✅ Selected')
    );
    assert.equal(echoEdits.length, 0);
    assert.equal(deps.injected.length, 1);
    assert.equal(deps.injected[0].message.text, '/new');
    const toast = fetchStub.calls.find((c) => c.url.includes('answerCallbackQuery'));
    assert.equal(toast?.body.text, 'New topic');
  });
});

// ---------------------------------------------------------------------------
// AI-210 (2026-09-06) — picker stage-then-apply: a cc:set press stages (▸, no
// injection), cc:submit injects EXACTLY the typed command the press used to inject,
// cc:discard reverts. The staged selection lives in the in-memory card keyboard
// index; tests that depend on their own recorded entry use the 7000x chat family.
// ---------------------------------------------------------------------------

describe('AI-210 — picker stage-then-apply (cc:submit / cc:discard)', () => {
  let fetchStub: ReturnType<typeof stubFetch>;

  function makeCardCb(data: string, chatId: number, messageId: number): CallbackQuery {
    return makeCb(data, {
      message: {
        message_id: messageId,
        chat: { id: chatId, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: 'card',
        message_thread_id: 0,
      },
    });
  }

  /** Opens the picker (bare record) then stages one value, both on 555/100. */
  async function stageSelection(
    deps: CallbackDeps & { injected: any[] },
    setting: 'agent' | 'model',
    value: string
  ): Promise<void> {
    await handleCallbackQuery(makeCb(`cc:${setting}`), deps);
    await handleCallbackQuery(makeCb(`cc:set:${setting}:${value}`), deps);
  }

  function lastReplyMarkup(): any {
    const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
    return editCalls[editCalls.length - 1]?.body.reply_markup;
  }

  function toastText(): string | undefined {
    return fetchStub.calls.find((c) => c.url.includes('answerCallbackQuery'))?.body.text;
  }

  function topLevelData(markup: any): string[] {
    return markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  }

  const TOP_LEVEL_DATA = ['cc:agent', 'cc:model', 'cc:effort', 'cc:new', 'cc:stop'];

  beforeEach(() => {
    fetchStub = stubFetch();
    _resetCardKeyboardIndexForTest();
  });

  afterEach(() => {
    fetchStub.restore();
    _resetCardKeyboardIndexForTest();
  });

  it('cc:submit applies the staged selection — injects exactly the typed command', async () => {
    const deps = makeDeps({
      loadTopicState: async () => ({ chat_id: 555, last_update_id: 0, thread_id: 0, turns: [], preferred_worker: 'agy' }),
      declaredValues: async (w, s) => (w === 'agy' && s === 'model' ? ['m1', 'm2'] : []),
      observedValues: async () => [],
    });
    await stageSelection(deps, 'model', 'm2');
    fetchStub.calls.length = 0; // scope the assertions to the submit press

    const outcome = await handleCallbackQuery(makeCb('cc:submit'), deps);
    assert.equal(outcome, 'cc:submit');
    assert.equal(deps.injected.length, 1);
    const expected = syntheticTextFor({ prefix: 'cc', action: 'set', setting: 'model', value: 'm2', raw: '' });
    assert.equal(deps.injected[0].message.text, '/model m2');
    assert.equal(deps.injected[0].message.text, expected, 'byte-identity with the typed command');
    assert.equal(toastText(), 'Applying model → m2…');
    const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
    assert.equal(editCalls.length, 1);
    assert.deepEqual(topLevelData(editCalls[0].body.reply_markup), TOP_LEVEL_DATA, 'top-level control card restored');
    assert.equal(currentCardKeyboard(555, 100), undefined, 'entry cleared after submit');
  });

  it('cc:submit with no staged selection answers "No change" and injects nothing', async () => {
    const deps = makeDeps();
    const outcome = await handleCallbackQuery(makeCardCb('cc:submit', 70004, 100), deps);
    assert.equal(outcome, 'cc:submit:no-change');
    assert.equal(deps.injected.length, 0);
    assert.equal(toastText(), 'No change');
    const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
    assert.equal(editCalls.length, 1);
    assert.deepEqual(topLevelData(editCalls[0].body.reply_markup), TOP_LEVEL_DATA);
    assert.equal(currentCardKeyboard(70004, 100), undefined);
  });

  it('cc:discard with a staged selection discards it — nothing injected', async () => {
    const deps = makeDeps({
      loadTopicState: async () => ({ chat_id: 555, last_update_id: 0, thread_id: 0, turns: [], preferred_worker: 'agy' }),
      declaredValues: async (w, s) => (w === 'agy' && s === 'model' ? ['m1', 'm2'] : []),
      observedValues: async () => [],
    });
    await stageSelection(deps, 'model', 'm2');
    fetchStub.calls.length = 0;

    const outcome = await handleCallbackQuery(makeCb('cc:discard'), deps);
    assert.equal(outcome, 'cc:discard');
    assert.equal(deps.injected.length, 0);
    assert.equal(toastText(), 'Discarded — model unchanged');
    const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
    assert.equal(editCalls.length, 1);
    assert.deepEqual(topLevelData(editCalls[0].body.reply_markup), TOP_LEVEL_DATA, 'top-level control card restored');
    assert.equal(currentCardKeyboard(555, 100), undefined);
  });

  it('cc:discard with no staged selection still answers and restores the top-level card', async () => {
    const deps = makeDeps();
    const outcome = await handleCallbackQuery(makeCardCb('cc:discard', 70007, 100), deps);
    assert.equal(outcome, 'cc:discard');
    assert.equal(deps.injected.length, 0);
    assert.equal(toastText(), 'Discarded');
    const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
    assert.deepEqual(topLevelData(editCalls[0].body.reply_markup), TOP_LEVEL_DATA);
  });

  it('a staged selection keeps the entry fresh for 10 minutes and records the staged keyboard', async () => {
    const chatId = 70005;
    const deps = makeDeps({
      loadTopicState: async () => ({ chat_id: chatId, last_update_id: 0, thread_id: 0, turns: [], preferred_worker: 'agy' }),
      declaredValues: async (w, s) => (w === 'agy' && s === 'model' ? ['m1', 'm2'] : []),
      observedValues: async () => [],
    });
    await handleCallbackQuery(makeCardCb('cc:model', chatId, 100), deps);
    await handleCallbackQuery(makeCardCb('cc:set:model:m2', chatId, 100), deps);
    assert.deepEqual(currentCardKeyboard(chatId, 100), lastReplyMarkup(), 'recorded keyboard === rendered keyboard');
    assert.ok(currentCardKeyboard(chatId, 100, Date.now() + 3 * 60 * 1000), '+3 min: fresh (10-min staged window)');
    assert.equal(currentCardKeyboard(chatId, 100, Date.now() + 11 * 60 * 1000), undefined, '+11 min: dropped');
  });

  it('a bare submenu keeps the 2-minute window', async () => {
    const chatId = 70006;
    const deps = makeDeps({
      loadTopicState: async () => ({ chat_id: chatId, last_update_id: 0, thread_id: 0, turns: [], preferred_worker: 'agy' }),
    });
    await handleCallbackQuery(makeCardCb('cc:agent', chatId, 100), deps);
    assert.ok(currentCardKeyboard(chatId, 100), 'fresh: still returned');
    assert.equal(currentCardKeyboard(chatId, 100, Date.now() + 3 * 60 * 1000), undefined, '+3 min: dropped (2-min bare window)');
  });

  it('a second tap replaces the staged selection; submit applies the latest', async () => {
    const chatId = 70008;
    const deps = makeDeps({
      loadTopicState: async () => ({ chat_id: chatId, last_update_id: 0, thread_id: 0, turns: [], preferred_worker: 'agy' }),
      declaredValues: async (w, s) => (w === 'agy' && s === 'model' ? ['m1', 'm2', 'm3'] : []),
      observedValues: async () => [],
    });
    await handleCallbackQuery(makeCardCb('cc:model', chatId, 100), deps);
    await handleCallbackQuery(makeCardCb('cc:set:model:m2', chatId, 100), deps);
    await handleCallbackQuery(makeCardCb('cc:set:model:m3', chatId, 100), deps);
    const rendered = lastReplyMarkup().inline_keyboard.flat();
    assert.ok(rendered.some((b: any) => b.text === '▸ m3'), 'the latest tap is staged');
    assert.ok(!rendered.some((b: any) => b.text === '▸ m2'), 'the earlier tap is replaced');
    fetchStub.calls.length = 0;

    const outcome = await handleCallbackQuery(makeCardCb('cc:submit', chatId, 100), deps);
    assert.equal(outcome, 'cc:submit');
    assert.equal(deps.injected.length, 1);
    assert.equal(deps.injected[0].message.text, '/model m3');
    assert.equal(toastText(), 'Applying model → m3…');
  });

  it('staging the applied value marks it staged (▸ wins over •)', async () => {
    const chatId = 70009;
    const deps = makeDeps({
      loadTopicState: async () => ({ chat_id: chatId, last_update_id: 0, thread_id: 0, turns: [] }),
      listWorkerNames: async () => ['agy', 'claude'],
      effectiveDefaultWorker: async () => 'agy',
    });
    await handleCallbackQuery(makeCardCb('cc:agent', chatId, 100), deps);
    const openRendered = lastReplyMarkup().inline_keyboard.flat();
    assert.ok(openRendered.some((b: any) => b.text === '• agy'), 'precondition: applied value rendered with •');
    await handleCallbackQuery(makeCardCb('cc:set:agent:agy', chatId, 100), deps);
    const staged = lastReplyMarkup().inline_keyboard.flat();
    assert.ok(staged.some((b: any) => b.text === '▸ agy'), 'staged wins');
    assert.ok(!staged.some((b: any) => b.text === '• agy'), 'no • remains for the staged value');
  });

  it('an unrelated cf: ack re-attaches the staged picker keyboard', async () => {
    const deps = makeDeps();
    await handleCallbackQuery(makeCb('cc:agent'), deps); // open the picker (555/100)
    await handleCallbackQuery(makeCb('cc:set:agent:agy'), deps); // stage
    fetchStub.calls.length = 0;

    await handleCallbackQuery(makeCb('cf:y'), deps);
    const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageText'));
    assert.equal(editCalls.length, 1);
    const buttons = editCalls[0].body.reply_markup.inline_keyboard.flat();
    assert.ok(
      buttons.some((b: any) => b.callback_data === 'cc:set:agent:agy' && b.text === '▸ agy'),
      'the staged picker survives the ack'
    );
  });

  it('legacy cc:back still works after staging — nothing injected, top-level restored', async () => {
    const deps = makeDeps({
      loadTopicState: async () => ({ chat_id: 555, last_update_id: 0, thread_id: 0, turns: [], preferred_worker: 'agy' }),
      declaredValues: async (w, s) => (w === 'agy' && s === 'model' ? ['m1', 'm2'] : []),
      observedValues: async () => [],
    });
    await stageSelection(deps, 'model', 'm2');
    fetchStub.calls.length = 0;

    const outcome = await handleCallbackQuery(makeCb('cc:back'), deps);
    assert.equal(outcome, 'cc:back');
    assert.equal(deps.injected.length, 0);
    const editCalls = fetchStub.calls.filter((c) => c.url.includes('editMessageReplyMarkup'));
    assert.equal(editCalls.length, 1);
    assert.deepEqual(topLevelData(editCalls[0].body.reply_markup), TOP_LEVEL_DATA, 'top-level control card restored');
    assert.equal(currentCardKeyboard(555, 100), undefined);
  });
});

// ---------------------------------------------------------------------------
// handleMessageReaction
// ---------------------------------------------------------------------------

function makeReaction(overrides: Partial<MessageReactionUpdated> = {}): MessageReactionUpdated {
  return {
    chat: { id: 555, type: 'private' },
    message_id: 10,
    user: { id: 1, first_name: 'Tester' },
    date: Math.floor(Date.now() / 1000),
    old_reaction: [],
    new_reaction: [{ type: 'emoji', emoji: '👍' }],
    ...overrides,
  };
}

describe('handleMessageReaction', () => {
  it('a 👍 ADD on the pending message injects "yes"', async () => {
    const state: ConversationState = {
      chat_id: 555,
      last_update_id: 0,
      thread_id: 0,
      turns: [],
      pending_action: { description: 'x', proposed_at: new Date().toISOString(), message_id: 10 },
    };
    const fetchStub = stubFetch();
    try {
      const deps = makeDeps({ loadTopicState: async () => state });
      const outcome = await handleMessageReaction(makeReaction(), deps);
      assert.equal(outcome, 'reaction:yes');
      assert.equal(deps.injected.length, 1);
      assert.equal(deps.injected[0].message.text, 'yes');
      assert.equal((deps.injected[0] as any).__synthetic, 'reaction');
    } finally {
      fetchStub.restore();
    }
  });

  it('a 👍 REMOVAL (old_reaction non-empty, new_reaction empty) injects nothing', async () => {
    const state: ConversationState = {
      chat_id: 555,
      last_update_id: 0,
      thread_id: 0,
      turns: [],
      pending_action: { description: 'x', proposed_at: new Date().toISOString(), message_id: 10 },
    };
    const deps = makeDeps({ loadTopicState: async () => state });
    const outcome = await handleMessageReaction(makeReaction({ old_reaction: [{ type: 'emoji', emoji: '👍' }], new_reaction: [] }), deps);
    assert.equal(outcome, 'ignored');
    assert.equal(deps.injected.length, 0);
  });

  it('a 👍 on a DIFFERENT message id injects nothing', async () => {
    const state: ConversationState = {
      chat_id: 555,
      last_update_id: 0,
      thread_id: 0,
      turns: [],
      pending_action: { description: 'x', proposed_at: new Date().toISOString(), message_id: 10 },
    };
    const deps = makeDeps({ loadTopicState: async () => state });
    const outcome = await handleMessageReaction(makeReaction({ message_id: 999 }), deps);
    assert.equal(outcome, 'ignored');
    assert.equal(deps.injected.length, 0);
  });

  it('a non-approval emoji (🎉) injects nothing', async () => {
    const state: ConversationState = {
      chat_id: 555,
      last_update_id: 0,
      thread_id: 0,
      turns: [],
      pending_action: { description: 'x', proposed_at: new Date().toISOString(), message_id: 10 },
    };
    const deps = makeDeps({ loadTopicState: async () => state });
    const outcome = await handleMessageReaction(makeReaction({ new_reaction: [{ type: 'emoji', emoji: '🎉' }] }), deps);
    assert.equal(outcome, 'ignored');
    assert.equal(deps.injected.length, 0);
  });

  it('👎 add is treated as a valid rejection reaction, injecting "no"', async () => {
    const state: ConversationState = {
      chat_id: 555,
      last_update_id: 0,
      thread_id: 0,
      turns: [],
      pending_action: { description: 'x', proposed_at: new Date().toISOString(), message_id: 10 },
    };
    const deps = makeDeps({ loadTopicState: async () => state });
    const outcome = await handleMessageReaction(makeReaction({ new_reaction: [{ type: 'emoji', emoji: '👎' }] }), deps);
    assert.equal(outcome, 'reaction:no');
    assert.equal(deps.injected[0].message.text, 'no');
  });

  it('resolves the thread via rememberConfirmMessage for a reaction outside thread 0', async () => {
    rememberConfirmMessage(555, 555, 42);
    const state: ConversationState = {
      chat_id: 555,
      last_update_id: 0,
      thread_id: 42,
      turns: [],
      pending_action: { description: 'x', proposed_at: new Date().toISOString(), message_id: 555 },
    };
    const loadTopicStateCalls: Array<{ chatId: number; threadId: number }> = [];
    const deps = makeDeps({
      loadTopicState: async (chatId: number, threadId: number) => {
        loadTopicStateCalls.push({ chatId, threadId });
        return state;
      },
    });
    const outcome = await handleMessageReaction(makeReaction({ message_id: 555 }), deps);
    assert.equal(outcome, 'reaction:yes');
    assert.equal(loadTopicStateCalls.length, 1);
    assert.equal(loadTopicStateCalls[0].threadId, 42, 'must resolve the remembered thread, not default to 0');
    assert.equal(deps.injected.length, 1);
    assert.equal(deps.injected[0].message.text, 'yes');
    assert.equal(deps.injected[0].message.message_thread_id, 42);
  });
});

// ---------------------------------------------------------------------------
// Decision capture (AI-164 WP-D)
// ---------------------------------------------------------------------------

describe('Decision capture — rm: buttons record judgment calls', () => {
  let paHome: string | undefined;
  let savedPaHome: string | undefined;
  let Database: any;

  beforeEach(async () => {
    savedPaHome = process.env.PA_HOME;
    paHome = await mkdtemp(join(tmpdir(), 'tgbot-decision-'));
    process.env.PA_HOME = paHome;
    const require = createRequire(import.meta.url);
    // Load better-sqlite3 from pa/node_modules (relative to dist/tests/)
    // dist/tests/ -> dist/ -> telegram-bot/ -> projects/ -> worktree root -> pa/node_modules
    Database = require(join(fileURLToPath(import.meta.url), '../../../../../pa/node_modules/better-sqlite3'));
  });

  afterEach(async () => {
    if (savedPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = savedPaHome;
    if (paHome) await rm(paHome, { recursive: true, force: true });
  });

  function makeRmCb(action: 'done' | '1h' | 'tmrw', messageText: string): CallbackQuery {
    return makeCb(`rm:${action}`, {
      message: {
        message_id: 12345,
        chat: { id: -1009999999999, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: `Reminder: ${messageText}`,
        message_thread_id: 4242,
      },
      from: { id: 1, first_name: 'TestUser' },
    });
  }

  it('rm:1h press records a decision row with snoozed 1 h', async () => {
    const fetchStub = stubFetch();
    try {
      const deps = makeDeps();
      const outcome = await handleCallbackQuery(makeRmCb('1h', 'call the clinic'), deps);
      assert.equal(outcome, 'rm:1h');
      assert.equal(fetchStub.calls.filter((c) => c.url.includes('answerCallbackQuery')).length, 1, 'acks the press');

      const dbPath = join(paHome!, 'decisions.sqlite');
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare('SELECT decision_id, source, skill, decision, request_excerpt, chat_id, message_id, thread_id FROM decisions').all() as any[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].source, 'bot');
      assert.equal(rows[0].skill, 'reminders');
      assert.equal(rows[0].decision, 'snoozed 1 h');
      assert.match(rows[0].request_excerpt, /call the clinic/);
      assert.equal(rows[0].chat_id, -1009999999999);
      assert.equal(rows[0].message_id, 12345);
      assert.equal(rows[0].thread_id, 4242);
      db.close();
    } finally {
      fetchStub.restore();
    }
  });

  it('rm:done press records a decision row with dismissed (done)', async () => {
    const fetchStub = stubFetch();
    try {
      const deps = makeDeps();
      const outcome = await handleCallbackQuery(makeRmCb('done', 'pay bill'), deps);
      assert.equal(outcome, 'rm:done');
      const answerCalls = fetchStub.calls.filter((c) => c.url.includes('answerCallbackQuery'));
      assert.equal(answerCalls.length, 1);
      assert.match(answerCalls[0].body.text, /✅ Done/);

      const dbPath = join(paHome!, 'decisions.sqlite');
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare('SELECT decision, request_excerpt FROM decisions').all() as any[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].decision, 'dismissed (done)');
      assert.match(rows[0].request_excerpt, /pay bill/);
      db.close();
    } finally {
      fetchStub.restore();
    }
  });

  it('rm:tmrw press records a decision row with snoozed to tomorrow', async () => {
    const fetchStub = stubFetch();
    try {
      const deps = makeDeps();
      await handleCallbackQuery(makeRmCb('tmrw', 'dentist appointment'), deps);

      const dbPath = join(paHome!, 'decisions.sqlite');
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare('SELECT decision FROM decisions').all() as any[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].decision, 'snoozed to tomorrow 09:00 IST');
      db.close();
    } finally {
      fetchStub.restore();
    }
  });
});

describe('Decision capture — reaction updates decision rows', () => {
  let paHome: string | undefined;
  let savedPaHome: string | undefined;
  let Database: any;
  let paHomeCounter = 0;

  beforeEach(async () => {
    savedPaHome = process.env.PA_HOME;
    paHome = await mkdtemp(join(tmpdir(), `tgbot-reaction-dec-${paHomeCounter++}-`));
    process.env.PA_HOME = paHome;
    const require = createRequire(import.meta.url);
    // Load better-sqlite3 from pa/node_modules (relative to dist/tests/)
    Database = require(join(fileURLToPath(import.meta.url), '../../../../../pa/node_modules/better-sqlite3'));
  });

  afterEach(async () => {
    if (savedPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = savedPaHome;
    if (paHome) await rm(paHome, { recursive: true, force: true });
  });

  it('👍 on a message with TWO decision rows updates both (matched=2)', async () => {
    const fetchStub = stubFetch();
    let db: any;
    try {
      const dbPath = join(paHome!, 'decisions.sqlite');
      db = new Database(dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS decisions (
          decision_id TEXT PRIMARY KEY,
          refId TEXT,
          session_id TEXT,
          thread_id INTEGER,
          source TEXT NOT NULL CHECK (source IN ('skill','bot')),
          skill TEXT,
          request_excerpt TEXT NOT NULL,
          context_refs TEXT,
          decision TEXT NOT NULL,
          rationale TEXT NOT NULL,
          alternatives TEXT,
          outcome TEXT,
          reaction TEXT,
          chat_id INTEGER,
          message_id INTEGER,
          ts TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const stmt = db.prepare(`
        INSERT INTO decisions (decision_id, source, skill, request_excerpt, decision, rationale, chat_id, message_id, thread_id, ts, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // Use makeReaction defaults: chat_id=555, message_id=10
      stmt.run('d-test1', 'bot', 'reminders', 'test reminder 1', 'snoozed 1 h', 'test rationale', 555, 10, 4242, new Date().toISOString(), new Date().toISOString());
      stmt.run('d-test2', 'bot', 'reminders', 'test reminder 2', 'snoozed to tomorrow', 'test rationale', 555, 10, 4242, new Date().toISOString(), new Date().toISOString());
      db.close();

      const deps = makeDeps();
      const outcome = await handleMessageReaction(makeReaction(), deps);
      assert.equal(outcome, 'ignored', 'no pending_action, so returns ignored');

      const verifyDb = new Database(dbPath, { readonly: true });
      const rows = verifyDb.prepare('SELECT reaction, outcome FROM decisions WHERE chat_id = ? AND message_id = ?').all(555, 10) as any[];
      assert.equal(rows.length, 2);
      assert.equal(rows[0].reaction, '👍');
      assert.equal(rows[0].outcome, 'approved');
      assert.equal(rows[1].reaction, '👍');
      assert.equal(rows[1].outcome, 'approved');
      verifyDb.close();
    } finally {
      if (db) db.close();
      fetchStub.restore();
    }
  });

  it('👎 on an ordinary message (no decision rows) creates no row, returns ignored', async () => {
    const fetchStub = stubFetch();
    try {
      const deps = makeDeps();
      const outcome = await handleMessageReaction(makeReaction({ new_reaction: [{ type: 'emoji', emoji: '👎' }] }), deps);
      assert.equal(outcome, 'ignored');

      // Since no decision rows exist, the DB might not exist or be empty
      // If it exists from a previous test, it should have 0 rows for this chat/message
      const dbPath = join(paHome!, 'decisions.sqlite');
      const exists = existsSync(dbPath);
      if (exists) {
        const verifyDb = new Database(dbPath, { readonly: true });
        const count = verifyDb.prepare('SELECT COUNT(*) as c FROM decisions').get() as { c: number };
        verifyDb.close();
        assert.equal(count.c, 0, 'no rows in DB (DB may exist but should be empty for this test)');
      }
    } finally {
      fetchStub.restore();
    }
  });
});
