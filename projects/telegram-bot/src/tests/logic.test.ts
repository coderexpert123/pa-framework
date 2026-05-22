import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIRMATION_YES,
  CONFIRMATION_NO,
  CONFIRMATION_PATTERN,
  PENDING_ACTION_TTL_MS,
  expirePendingAction,
  resolveConfirmation,
  buildWorkerResponse,
  MODEL_SWITCH_PATTERN,
  handleModelSwitch,
  getModelSwitchTarget,
  expirePreferredWorker,
  DEFAULT_SWITCH_PATTERN,
  handleDefaultQuery,
  CODE_PATTERN,
  parseCodeArgs,
  handleCodeCommand,
  parseMetadata,
  applyMetaActions,
  normalizeMarkdown,
  clearTopicContext,
  handleNewCommand,
  handleResetCommand,
  NEW_PATTERN,
  BRANCH_PATTERN,
  CHILD_OF_PATTERN,
  MERGE_PATTERN,
  handleBranchCommand,
  handleChildOfCommand,
  handleMergeCommand,
  renderStatusCard,
  resolveEffectiveDefaultWorker,
  buildModelStatusSnapshot,
  hydrateModelStatus,
  modelStatusNeedsRefresh,
  type StatusCardArgs,
} from '../logic.js';
import type { PAMeta } from '../types.js';
import type { ConversationState, BranchAncestry } from '../types.js';

function makeState(): ConversationState {
  return { chat_id: 1, last_update_id: 0, thread_id: 0, turns: [] };
}

function withPending(description: string, ageMs = 0): ConversationState {
  const state = makeState();
  state.pending_action = {
    description,
    proposed_at: new Date(Date.now() - ageMs).toISOString(),
  };
  return state;
}

// ---------------------------------------------------------------------------
// CONFIRMATION_YES
// ---------------------------------------------------------------------------

describe('CONFIRMATION_YES', () => {
  // Exact matches
  const matches = ['yes', 'YES', 'Yes', 'yeah', 'Yeah', 'yep', 'confirm', 'do it', 'go ahead', 'ok', 'okay', 'sure'];
  for (const word of matches) {
    it(`matches "${word}"`, () => assert.ok(CONFIRMATION_YES.test(word)));
  }

  it('matches with trailing words (word boundary after keyword)', () => {
    assert.ok(CONFIRMATION_YES.test('yes please'));
    assert.ok(CONFIRMATION_YES.test('ok sounds good'));
    assert.ok(CONFIRMATION_YES.test('sure thing'));
    assert.ok(CONFIRMATION_YES.test('do it now'));
    assert.ok(CONFIRMATION_YES.test('go ahead and do it'));
  });

  it('"okay" matches the "okay" alternative, not "ok" (no partial match)', () => {
    // "okay" should match whole; "ok" followed by "ay" (word char) should NOT match via "ok\b"
    assert.ok(CONFIRMATION_YES.test('okay'));
  });

  it('does not match when keyword is not at start of string', () => {
    assert.ok(!CONFIRMATION_YES.test('not yes'));
    assert.ok(!CONFIRMATION_YES.test('maybe yes'));
    assert.ok(!CONFIRMATION_YES.test('probably okay'));
    assert.ok(!CONFIRMATION_YES.test('i think sure'));
    assert.ok(!CONFIRMATION_YES.test('all ok'));
  });

  it('does not match "going ahead" (not the same as "go ahead")', () => {
    assert.ok(!CONFIRMATION_YES.test('going ahead'));
  });

  it('does not match "doing it" (not the same as "do it")', () => {
    assert.ok(!CONFIRMATION_YES.test('doing it'));
  });

  it('does not match confirmed NO words', () => {
    for (const word of ['no', 'nope', 'cancel', 'never']) {
      assert.ok(!CONFIRMATION_YES.test(word), `"${word}" should not match YES`);
    }
  });

  it('regex is stateless across multiple calls (no lastIndex bug)', () => {
    // Global regexes with /g flag retain lastIndex — our regex should not have this
    assert.ok(CONFIRMATION_YES.test('yes'));
    assert.ok(CONFIRMATION_YES.test('yes'));
    assert.ok(CONFIRMATION_YES.test('yes'));
  });
});

// ---------------------------------------------------------------------------
// CONFIRMATION_NO
// ---------------------------------------------------------------------------

describe('CONFIRMATION_NO', () => {
  const matches = ['no', 'NO', 'No', 'nah', 'nope', 'cancel', 'nevermind', 'never mind', "don't", 'dont', 'stop'];
  for (const word of matches) {
    it(`matches "${word}"`, () => assert.ok(CONFIRMATION_NO.test(word)));
  }

  it('matches with trailing context', () => {
    assert.ok(CONFIRMATION_NO.test('cancel that'));
    assert.ok(CONFIRMATION_NO.test('no thanks'));
    assert.ok(CONFIRMATION_NO.test('stop doing this'));
    assert.ok(CONFIRMATION_NO.test('nope not now'));
  });

  it('does not match when keyword is not at start', () => {
    assert.ok(!CONFIRMATION_NO.test('this is not a cancellation'));
    assert.ok(!CONFIRMATION_NO.test('say no'));
    assert.ok(!CONFIRMATION_NO.test('definitely no'));
  });

  it('does not match confirmed YES words', () => {
    for (const word of ['yes', 'ok', 'sure', 'confirm']) {
      assert.ok(!CONFIRMATION_NO.test(word), `"${word}" should not match NO`);
    }
  });

  it('"nope" does not match "nopeable" (word boundary)', () => {
    assert.ok(!CONFIRMATION_NO.test('nopeable'));
  });

  it('regex is stateless across multiple calls', () => {
    assert.ok(CONFIRMATION_NO.test('no'));
    assert.ok(CONFIRMATION_NO.test('no'));
    assert.ok(CONFIRMATION_NO.test('no'));
  });
});

// ---------------------------------------------------------------------------
// Mutual exclusivity: YES and NO do not cross-fire
// ---------------------------------------------------------------------------

describe('YES/NO mutual exclusivity', () => {
  const yesWords = ['yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'confirm'];
  const noWords = ['no', 'nah', 'nope', 'cancel', 'nevermind', 'stop'];

  for (const word of yesWords) {
    it(`YES word "${word}" does not match CONFIRMATION_NO`, () => {
      assert.ok(!CONFIRMATION_NO.test(word));
    });
  }

  for (const word of noWords) {
    it(`NO word "${word}" does not match CONFIRMATION_YES`, () => {
      assert.ok(!CONFIRMATION_YES.test(word));
    });
  }
});

// ---------------------------------------------------------------------------
// CONFIRMATION_PATTERN
// ---------------------------------------------------------------------------

describe('CONFIRMATION_PATTERN', () => {
  it('matches plain "Reply yes to confirm"', () => {
    assert.ok(CONFIRMATION_PATTERN.test('I will send the email. Reply yes to confirm or no to cancel.'));
  });

  it('matches "Reply *yes* to confirm" with Markdown bold', () => {
    assert.ok(CONFIRMATION_PATTERN.test('Reply *yes* to confirm or *no* to cancel.'));
  });

  it('is case insensitive', () => {
    assert.ok(CONFIRMATION_PATTERN.test('REPLY YES TO CONFIRM'));
    assert.ok(CONFIRMATION_PATTERN.test('reply YES to confirm'));
    assert.ok(CONFIRMATION_PATTERN.test('Reply Yes To Confirm'));
  });

  it('matches when embedded in longer response text', () => {
    const response = `I will archive the 3 newsletters.\n\nReply *yes* to confirm or *no* to cancel.`;
    assert.ok(CONFIRMATION_PATTERN.test(response));
  });

  it('does not match a normal response with no action proposal', () => {
    assert.ok(!CONFIRMATION_PATTERN.test('Here is the summary of your emails.'));
    assert.ok(!CONFIRMATION_PATTERN.test('The fitness sync ran successfully at 8:45 UTC.'));
    assert.ok(!CONFIRMATION_PATTERN.test('Yes, you can confirm this.'));
  });

  it('does not match "reply no to confirm" (wrong word)', () => {
    assert.ok(!CONFIRMATION_PATTERN.test('Reply no to confirm'));
  });
});

// ---------------------------------------------------------------------------
// expirePendingAction
// ---------------------------------------------------------------------------

describe('expirePendingAction', () => {
  it('is a no-op when no pending_action', () => {
    const state = makeState();
    expirePendingAction(state);
    assert.equal(state.pending_action, undefined);
  });

  it('keeps pending_action well within TTL (1 second old)', () => {
    const state = withPending('fresh', 1000);
    expirePendingAction(state);
    assert.ok(state.pending_action);
    assert.equal(state.pending_action!.description, 'fresh');
  });

  it('keeps pending_action just under TTL', () => {
    const state = withPending('almost expired', PENDING_ACTION_TTL_MS - 1);
    expirePendingAction(state);
    assert.ok(state.pending_action, 'should still be present just under TTL');
  });

  it('clears pending_action at exactly the TTL boundary', () => {
    const state = withPending('boundary', PENDING_ACTION_TTL_MS);
    expirePendingAction(state);
    assert.equal(state.pending_action, undefined);
  });

  it('clears pending_action older than TTL by 1 ms', () => {
    const state = withPending('expired', PENDING_ACTION_TTL_MS + 1);
    expirePendingAction(state);
    assert.equal(state.pending_action, undefined);
  });

  it('clears pending_action much older than TTL', () => {
    const state = withPending('very old', PENDING_ACTION_TTL_MS * 24);
    expirePendingAction(state);
    assert.equal(state.pending_action, undefined);
  });

  it('does not mutate other state fields', () => {
    const state = withPending('expired', PENDING_ACTION_TTL_MS + 1000);
    state.last_update_id = 42;
    expirePendingAction(state);
    assert.equal(state.last_update_id, 42);
    assert.equal(state.chat_id, 1);
  });

  it('calling twice on expired state is safe (idempotent)', () => {
    const state = withPending('expired', PENDING_ACTION_TTL_MS + 1000);
    expirePendingAction(state);
    expirePendingAction(state); // second call — pending_action is already undefined
    assert.equal(state.pending_action, undefined);
  });
});

// ---------------------------------------------------------------------------
// resolveConfirmation
// ---------------------------------------------------------------------------

describe('resolveConfirmation', () => {
  it('returns no-op when no pending_action exists', () => {
    const state = makeState();
    const result = resolveConfirmation(state, 'yes');
    assert.equal(result.skipWorker, false);
    assert.equal(result.response, '');
    assert.equal(state.pending_action, undefined);
  });

  it('returns no-op with empty string when no pending_action', () => {
    const state = makeState();
    const result = resolveConfirmation(state, '');
    assert.equal(result.skipWorker, false);
    assert.equal(result.response, '');
  });

  // --- NO path ---

  it('"no" skips worker and returns Cancelled.', () => {
    const state = withPending('send email');
    const result = resolveConfirmation(state, 'no');
    assert.equal(result.skipWorker, true);
    assert.equal(result.response, 'Cancelled.');
    assert.equal(state.pending_action, undefined);
  });

  it('"nope" skips worker', () => {
    const state = withPending('send email');
    const result = resolveConfirmation(state, 'nope');
    assert.equal(result.skipWorker, true);
    assert.equal(result.response, 'Cancelled.');
  });

  it('"cancel" skips worker', () => {
    const state = withPending('run skill');
    const result = resolveConfirmation(state, 'cancel');
    assert.equal(result.skipWorker, true);
    assert.equal(result.response, 'Cancelled.');
  });

  it('"stop" skips worker', () => {
    const state = withPending('delete file');
    const result = resolveConfirmation(state, 'stop');
    assert.equal(result.skipWorker, true);
  });

  it('"nevermind" skips worker', () => {
    const state = withPending('archive emails');
    const result = resolveConfirmation(state, 'nevermind');
    assert.equal(result.skipWorker, true);
  });

  it('NO response always returns exactly "Cancelled."', () => {
    for (const word of ['no', 'nope', 'cancel', 'nevermind', 'stop', 'nah']) {
      const state = withPending('action');
      const { response } = resolveConfirmation(state, word);
      assert.equal(response, 'Cancelled.', `expected "Cancelled." for "${word}"`);
    }
  });

  // --- YES path ---

  it('"yes" does not skip worker', () => {
    const state = withPending('send email');
    const result = resolveConfirmation(state, 'yes');
    assert.equal(result.skipWorker, false);
    assert.equal(result.response, '');
  });

  it('"ok" does not skip worker', () => {
    const state = withPending('run skill');
    const result = resolveConfirmation(state, 'ok');
    assert.equal(result.skipWorker, false);
  });

  it('"sure" does not skip worker', () => {
    const state = withPending('archive emails');
    const result = resolveConfirmation(state, 'sure');
    assert.equal(result.skipWorker, false);
  });

  it('"yes" leaves pending_action intact for caller to clear before dispatch', () => {
    const state = withPending('send email');
    resolveConfirmation(state, 'yes');
    // resolveConfirmation must NOT clear pending on "yes" — main.ts does it before buildPrompt
    assert.ok(state.pending_action, 'pending_action should still be set after "yes"');
    assert.equal(state.pending_action!.description, 'send email');
  });

  it('"yes" response is empty string (no response to send)', () => {
    const state = withPending('send email');
    const result = resolveConfirmation(state, 'yes');
    assert.equal(result.response, '');
  });

  // --- Unrelated message path ---

  it('unrelated message clears pending_action and does not skip worker', () => {
    const state = withPending('send email');
    const result = resolveConfirmation(state, 'what is the weather?');
    assert.equal(result.skipWorker, false);
    assert.equal(result.response, '');
    assert.equal(state.pending_action, undefined);
  });

  it('empty string clears pending_action (treated as unrelated)', () => {
    const state = withPending('action');
    const result = resolveConfirmation(state, '');
    assert.equal(result.skipWorker, false);
    assert.equal(state.pending_action, undefined);
  });

  it('follow-up question after pending clears pending and triggers worker', () => {
    const state = withPending('archive 5 emails');
    const result = resolveConfirmation(state, 'actually, how many emails are there?');
    assert.equal(result.skipWorker, false);
    assert.equal(state.pending_action, undefined);
  });

  // --- State isolation ---

  it('second resolveConfirmation call after cancel returns no-op (no pending_action)', () => {
    const state = withPending('send email');
    resolveConfirmation(state, 'no'); // clears pending
    const second = resolveConfirmation(state, 'no'); // no pending left
    assert.equal(second.skipWorker, false);
    assert.equal(second.response, '');
  });

  it('does not mutate other state fields', () => {
    const state = withPending('action');
    state.last_update_id = 77;
    resolveConfirmation(state, 'no');
    assert.equal(state.last_update_id, 77);
    assert.equal(state.chat_id, 1);
  });

  it('pending_action description is preserved before clearing on NO', () => {
    const desc = 'send invoice to client@example.com';
    const state = withPending(desc);
    resolveConfirmation(state, 'no');
    // description was in state.pending_action.description before clearing
    // after call: pending_action is gone, but we captured it before in desc
    assert.equal(state.pending_action, undefined);
  });

  // --- Length guard ---

  it('long "no" message (> 25 chars) does not cancel — treated as unrelated', () => {
    const state = withPending('send email');
    const result = resolveConfirmation(state, 'no I think we should approach this differently');
    assert.equal(result.skipWorker, false);
    assert.equal(result.response, '');
    assert.equal(state.pending_action, undefined); // cleared as unrelated, not cancelled
  });

  it('long "yes" message (> 25 chars) does not confirm — treated as unrelated', () => {
    const state = withPending('transfer funds');
    const result = resolveConfirmation(state, 'yes I think we should proceed with the transfer plan');
    assert.equal(result.skipWorker, false);
    assert.equal(result.response, '');
    assert.equal(state.pending_action, undefined); // cleared as unrelated
  });

  it('short "no" (≤ 25 chars) still cancels correctly', () => {
    const state = withPending('run skill');
    const result = resolveConfirmation(state, 'no');
    assert.equal(result.skipWorker, true);
    assert.equal(result.response, 'Cancelled.');
    assert.equal(state.pending_action, undefined);
  });
});

// ---------------------------------------------------------------------------
// buildWorkerResponse
// ---------------------------------------------------------------------------

describe('buildWorkerResponse', () => {
  // --- success with output ---

  it('returns trimmed output on success', () => {
    const r = buildWorkerResponse({ success: true, output: 'Hello world' }, 'claude');
    assert.equal(r, 'Hello world');
  });

  it('trims surrounding whitespace from output', () => {
    const r = buildWorkerResponse({ success: true, output: '  hello  \n' }, 'claude');
    assert.equal(r, 'hello');
  });

  it('returns full output including internal newlines', () => {
    const output = 'line1\nline2\nline3';
    const r = buildWorkerResponse({ success: true, output }, 'gemini');
    assert.equal(r, output);
  });

  it('suppresses a collapsed one-line NO_OUTPUT sentinel leak', () => {
    const output =
      'Checking the specified `rate-limit-unparseable.jsonl` file and filtering to entries from the last 65 minutes.NO_OUTPUT';
    const r = buildWorkerResponse({ success: true, output }, 'gemini');
    assert.equal(r, '');
  });

  // --- success with empty output (the previously untested bug path) ---

  it('returns empty string when worker succeeds with empty output', () => {
    const r = buildWorkerResponse({ success: true, output: '' }, 'claude');
    assert.equal(r, '', 'empty output must not be treated as failure');
  });

  it('returns empty string when worker succeeds with whitespace-only output', () => {
    const r = buildWorkerResponse({ success: true, output: '   \n\t  ' }, 'claude');
    assert.equal(r, '', 'whitespace-only output must not be treated as failure');
  });

  it('does not return the failure apology for success+empty (the bug this fixes)', () => {
    const r = buildWorkerResponse({ success: true, output: '' }, 'claude');
    assert.ok(!r.includes("couldn't process"), 'must not show failure message for successful empty response');
  });

  // --- failure ---

  it('returns apology on failure', () => {
    const r = buildWorkerResponse({ success: false, output: '', error: 'rate limited' }, 'claude');
    assert.ok(r.includes("couldn't process"), 'failure must return apology');
    assert.ok(r.includes('rate limited'), 'failure must include error snippet');
  });

  it('appends full error snippet without truncation', () => {
    const longError = 'x'.repeat(300);
    const r = buildWorkerResponse({ success: false, output: '', error: longError }, 'claude');
    const match = r.match(/\((.+)\)$/s);
    assert.ok(match, 'error snippet must be in parentheses');
    assert.equal(match![1], longError);
  });

  it('returns apology without error snippet when error is undefined', () => {
    const r = buildWorkerResponse({ success: false, output: '' }, 'claude');
    assert.ok(r.includes("couldn't process"));
    assert.ok(!r.includes('('), 'no parentheses when no error string');
  });

  it('returns apology without error snippet when error is empty string', () => {
    const r = buildWorkerResponse({ success: false, output: '', error: '' }, 'claude');
    assert.ok(!r.includes('('), 'no parentheses for empty error string');
  });

  it('failure output is non-empty (message is always sent)', () => {
    const r = buildWorkerResponse({ success: false, output: '', error: 'oops' }, 'gemini');
    assert.ok(r.trim().length > 0, 'failure response must be non-empty so a message is sent');
  });

  it('worker name does not appear in the user-facing response', () => {
    const r = buildWorkerResponse({ success: false, output: '', error: 'timeout' }, 'super-secret-worker');
    assert.ok(!r.includes('super-secret-worker'), 'worker name must not leak to user');
  });

  it('returns evaluator summary when killed with evaluatorSummary set', () => {
    const summary = 'The agent searched for weather data but entered a completion loop without producing a final answer.';
    const r = buildWorkerResponse({ success: false, output: '', evaluatorSummary: summary, error: 'Killed: LLM evaluator decided to stop (semantic loop detected)' }, 'gemini');
    assert.equal(r, summary, 'should return evaluator summary instead of generic apology');
    assert.ok(!r.includes("couldn't process"), 'should not include generic apology');
  });

  it('still returns generic apology when killed without evaluatorSummary', () => {
    const r = buildWorkerResponse({ success: false, output: '', error: 'Killed: no activity for 300s (idle timeout)' }, 'gemini');
    assert.ok(r.includes("couldn't process"), 'should still return generic apology when no summary');
  });

  it('does not show partial stdout as user-facing response on kill', () => {
    // Accumulated stdout from a killed worker might be non-empty but incomplete
    const r = buildWorkerResponse({ success: false, output: 'partial incomplete response...', error: 'Killed: no activity for 300s (idle timeout)' }, 'gemini');
    // Without evaluatorSummary, should show apology not the partial output
    assert.ok(r.includes("couldn't process"), 'should not show partial stdout to user');
    assert.ok(!r.includes('partial incomplete'), 'should not leak partial stdout to user');
  });

  // --- cleaning logic ---

  // --- Gemini thought block extraction ---

  it('gemini: returns last thought block content, discarding outer planning text', () => {
    const output = '**Planning** I will now summarize.\n[Thought: true]\nHere is the answer.\n[Thought: false]';
    const r = buildWorkerResponse({ success: true, output }, 'gemini');
    assert.equal(r, 'Here is the answer.');
  });

  it('gemini: returns the LAST thought block when multiple exist', () => {
    const output = '[Thought: true] thinking 1 [Thought: false]\nMid text\n[Thought: true] final answer [Thought: false]\nEnd text';
    const r = buildWorkerResponse({ success: true, output }, 'gemini');
    assert.equal(r, 'final answer');
  });

  it('gemini: falls back to full output (tags stripped) when no thought blocks present', () => {
    const output = 'The planning phase is complete.';
    const r = buildWorkerResponse({ success: true, output }, 'gemini');
    assert.equal(r, 'The planning phase is complete.');
  });

  it('gemini: strips orphaned tags when no complete thought block exists', () => {
    const output = '[Thought: true]\nHello world';
    const r = buildWorkerResponse({ success: true, output }, 'gemini');
    assert.equal(r, 'Hello world');
  });

  it('gemini: ignores empty thought blocks, returns last non-empty one', () => {
    const output = '[Thought: true][Thought: false]\n[Thought: true]\nReal answer\n[Thought: false]';
    const r = buildWorkerResponse({ success: true, output }, 'gemini');
    assert.equal(r, 'Real answer');
  });

  // --- Gemini bold planning header stripping ---

  it('gemini: strips bold planning header + narration from start of output', () => {
    const output = "**Delivering the Comprehensive Strategy** I've completed the report.\nI have created the document.";
    const r = buildWorkerResponse({ success: true, output }, 'gemini');
    assert.equal(r, 'I have created the document.');
  });

  it('gemini: strips multiple consecutive bold planning headers', () => {
    const output = "**Refining** I'm zeroing in...\n**Creating** I'm drafting the content...\nActual answer here.";
    const r = buildWorkerResponse({ success: true, output }, 'gemini');
    assert.equal(r, 'Actual answer here.');
  });

  it('gemini: normalizes **bold** to *bold* in non-narration output', () => {
    const output = '**The Verdict:** UTIs are linked to the same imbalance.';
    const r = buildWorkerResponse({ success: true, output }, 'gemini');
    assert.equal(r, '*The Verdict:* UTIs are linked to the same imbalance.');
  });

  it('gemini: normalizes ### **bold header** to *bold*', () => {
    const output = '### **1. The Leaky Gut Pipeline**\nExplanation here.';
    const r = buildWorkerResponse({ success: true, output }, 'gemini');
    assert.equal(r, '*1. The Leaky Gut Pipeline*\nExplanation here.');
  });

  it('gemini: noise prefix stripping also applies to gemini worker', () => {
    const output = 'Planning...\nHello world';
    const r = buildWorkerResponse({ success: true, output }, 'gemini');
    assert.equal(r, 'Hello world');
  });

  it('gemini: clean direct answer passes through unchanged', () => {
    const output = 'Yes, the timing of her UTIs starting only after the IUI is medically logical.';
    const r = buildWorkerResponse({ success: true, output }, 'gemini');
    assert.equal(r, 'Yes, the timing of her UTIs starting only after the IUI is medically logical.');
  });

  // --- Claude noise prefix stripping (claude worker) ---

  it('claude: removes "Planning..." noise from the start', () => {
    const output = 'Planning...\nHello world';
    const r = buildWorkerResponse({ success: true, output }, 'claude');
    assert.equal(r, 'Hello world');
  });

  it('claude: removes "**Strategy**:" noise from the start', () => {
    const output = '**Strategy**:\nHello world';
    const r = buildWorkerResponse({ success: true, output }, 'claude');
    assert.equal(r, 'Hello world');
  });

  it('claude: removes multi-level bold noise (e.g. ***Research***)', () => {
    const output = '***Research***: Found it.\nHello world';
    const r = buildWorkerResponse({ success: true, output }, 'claude');
    assert.equal(r, 'Found it.\nHello world');
  });

  it('claude: strips <thought> blocks entirely', () => {
    const output = '<thought>internal reasoning</thought>\nHello world';
    const r = buildWorkerResponse({ success: true, output }, 'claude');
    assert.equal(r, 'Hello world');
  });

  it('does not remove noise words if they are part of actual content sentences', () => {
    const output = 'The planning phase is complete.';
    const r = buildWorkerResponse({ success: true, output }, 'claude');
    assert.equal(r, 'The planning phase is complete.');
  });
});

// ---------------------------------------------------------------------------
// MODEL_SWITCH_PATTERN
// ---------------------------------------------------------------------------

describe('MODEL_SWITCH_PATTERN', () => {
  it('matches /model claude', () => assert.ok(MODEL_SWITCH_PATTERN.test('/model claude')));
  it('matches /model gemini', () => assert.ok(MODEL_SWITCH_PATTERN.test('/model gemini')));
  it('matches /model zclaude', () => assert.ok(MODEL_SWITCH_PATTERN.test('/model zclaude')));
  it('matches /model codex', () => assert.ok(MODEL_SWITCH_PATTERN.test('/model codex')));
  it('matches /models claude (plural)', () => assert.ok(MODEL_SWITCH_PATTERN.test('/models claude')));
  it('matches /models gemini (plural)', () => assert.ok(MODEL_SWITCH_PATTERN.test('/models gemini')));
  it('matches /models zclaude (plural)', () => assert.ok(MODEL_SWITCH_PATTERN.test('/models zclaude')));
  it('matches /models codex (plural)', () => assert.ok(MODEL_SWITCH_PATTERN.test('/models codex')));
  it('matches case-insensitively', () => {
    assert.ok(MODEL_SWITCH_PATTERN.test('/model Claude'));
    assert.ok(MODEL_SWITCH_PATTERN.test('/MODEL GEMINI'));
    assert.ok(MODEL_SWITCH_PATTERN.test('/model ZCLAUDE'));
    assert.ok(MODEL_SWITCH_PATTERN.test('/model CODEX'));
  });
  it('does not match /model unknown-worker', () => assert.ok(!MODEL_SWITCH_PATTERN.test('/model gpt4')));
  it('does not match plain text', () => assert.ok(!MODEL_SWITCH_PATTERN.test('use claude please')));
  it('does not match /model with no argument', () => assert.ok(!MODEL_SWITCH_PATTERN.test('/model')));
});

// ---------------------------------------------------------------------------
// getModelSwitchTarget
// ---------------------------------------------------------------------------

describe('getModelSwitchTarget', () => {
  it('returns the normalized worker name for /model', () => {
    assert.equal(getModelSwitchTarget('/model ZCLAUDE'), 'zclaude');
  });

  it('returns undefined for unrelated text', () => {
    assert.equal(getModelSwitchTarget('hello'), undefined);
  });
});

// ---------------------------------------------------------------------------
// handleModelSwitch
// ---------------------------------------------------------------------------

describe('handleModelSwitch', () => {
  it('returns switched=false for non-switch messages', () => {
    const state = makeState();
    const result = handleModelSwitch(state, 'hello');
    assert.equal(result.switched, false);
    assert.equal(result.response, '');
    assert.equal(state.preferred_worker, undefined);
  });

  it('sets preferred_worker to gemini on /model gemini', () => {
    const state = makeState();
    const result = handleModelSwitch(state, '/model gemini');
    assert.equal(result.switched, true);
    assert.equal(state.preferred_worker, 'gemini');
    assert.ok(state.preferred_worker_set_at, 'preferred_worker_set_at should be set');
    assert.ok(result.response.includes('until midnight IST'), 'response should mention expiry');
  });

  it('sets preferred_worker to claude on /model claude', () => {
    const state = makeState();
    const result = handleModelSwitch(state, '/model claude');
    assert.equal(result.switched, true);
    assert.equal(state.preferred_worker, 'claude');
  });

  it('sets preferred_worker to zclaude on /model zclaude', () => {
    const state = makeState();
    const result = handleModelSwitch(state, '/model zclaude');
    assert.equal(result.switched, true);
    assert.equal(state.preferred_worker, 'zclaude');
  });

  it('normalises to lowercase regardless of input case', () => {
    const state = makeState();
    handleModelSwitch(state, '/model Claude');
    assert.equal(state.preferred_worker, 'claude');
  });

  it('clears active session on switch', () => {
    const state = makeState();
    state.session = { session_id: 'abc', worker: 'claude', started_at: new Date().toISOString() };
    handleModelSwitch(state, '/model gemini');
    assert.equal(state.session, undefined);
  });

  it('does not clear session when no switch occurs', () => {
    const state = makeState();
    state.session = { session_id: 'abc', worker: 'claude', started_at: new Date().toISOString() };
    handleModelSwitch(state, 'hello');
    assert.ok(state.session !== undefined);
  });

  it('returns a non-empty confirmation response on switch', () => {
    const state = makeState();
    const result = handleModelSwitch(state, '/model gemini');
    assert.ok(result.response.length > 0);
    assert.ok(result.response.toLowerCase().includes('gemini'));
  });

  it('overwrites an existing preferred_worker', () => {
    const state = makeState();
    state.preferred_worker = 'claude';
    handleModelSwitch(state, '/model gemini');
    assert.equal(state.preferred_worker, 'gemini');
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveDefaultWorker
// ---------------------------------------------------------------------------

describe('resolveEffectiveDefaultWorker', () => {
  it('prefers a configured topic default when that worker exists', () => {
    assert.equal(
      resolveEffectiveDefaultWorker('gemini', [{ name: 'claude' }, { name: 'gemini' }]),
      'gemini',
    );
  });

  it('falls back to priority order when the configured default is absent', () => {
    assert.equal(
      resolveEffectiveDefaultWorker('missing-worker', [{ name: 'zclaude' }, { name: 'gemini' }]),
      'zclaude',
    );
  });
});

// ---------------------------------------------------------------------------
// hydrateModelStatus / modelStatusNeedsRefresh
// ---------------------------------------------------------------------------

describe('hydrateModelStatus', () => {
  it('hydrates legacy preferred_worker state into a user_override snapshot', () => {
    const state = makeState();
    state.preferred_worker = 'gemini';
    state.preferred_worker_set_at = '2026-04-28T10:00:00.000Z';

    const snapshot = hydrateModelStatus(state, 'claude');
    assert.equal(snapshot.current_worker, 'gemini');
    assert.equal(snapshot.default_worker, 'claude');
    assert.equal(snapshot.reason_code, 'user_override');
    assert.equal(snapshot.changed_at, '2026-04-28T10:00:00.000Z');
  });

  it('keeps an existing model_status snapshot while refreshing the default worker', () => {
    const state = makeState();
    state.model_status = buildModelStatusSnapshot({
      currentWorker: 'codex',
      defaultWorker: 'claude',
      reasonCode: 'failover',
      changedAt: '2026-04-28T11:00:00.000Z',
      reasonText: 'Temporary failover from claude to codex.',
    });

    const snapshot = hydrateModelStatus(state, 'gemini');
    assert.equal(snapshot.current_worker, 'codex');
    assert.equal(snapshot.default_worker, 'gemini');
    assert.equal(snapshot.reason_code, 'failover');
    assert.equal(snapshot.reason_text, 'Temporary failover from claude to codex.');
  });
});

describe('modelStatusNeedsRefresh', () => {
  it('detects differences in current worker or reason', () => {
    const previous = buildModelStatusSnapshot({
      currentWorker: 'claude',
      defaultWorker: 'claude',
      reasonCode: 'default_active',
      changedAt: '2026-04-28T11:00:00.000Z',
    });
    const next = buildModelStatusSnapshot({
      currentWorker: 'gemini',
      defaultWorker: 'claude',
      reasonCode: 'failover',
      changedAt: '2026-04-28T11:05:00.000Z',
    });

    assert.equal(modelStatusNeedsRefresh(previous, next), true);
  });
});

// ---------------------------------------------------------------------------
// expirePreferredWorker
// ---------------------------------------------------------------------------

describe('expirePreferredWorker', () => {
  it('no-op when no preferred_worker set', () => {
    const state = makeState();
    const expired = expirePreferredWorker(state);
    assert.equal(expired, false);
    assert.equal(state.preferred_worker, undefined);
  });

  it('no-op when preferred_worker set but no set_at timestamp', () => {
    const state = makeState();
    state.preferred_worker = 'gemini';
    const expired = expirePreferredWorker(state);
    assert.equal(expired, false);
    assert.equal(state.preferred_worker, 'gemini');
  });

  it('no-op when preferred_worker was set today (IST)', () => {
    const state = makeState();
    state.preferred_worker = 'gemini';
    state.preferred_worker_set_at = new Date().toISOString();
    const expired = expirePreferredWorker(state);
    assert.equal(expired, false);
    assert.equal(state.preferred_worker, 'gemini');
  });

  it('clears preferred_worker when set on a previous IST day', () => {
    const state = makeState();
    state.preferred_worker = 'gemini';
    state.session = { session_id: 'abc', worker: 'gemini', started_at: new Date().toISOString() };
    // Simulate set yesterday in IST
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    state.preferred_worker_set_at = yesterday.toISOString();
    const expired = expirePreferredWorker(state);
    assert.equal(expired, true);
    assert.equal(state.preferred_worker, undefined);
    assert.equal(state.preferred_worker_set_at, undefined);
    assert.equal(state.session, undefined);
  });

  it('clears session alongside preferred_worker when expired', () => {
    const state = makeState();
    state.preferred_worker = 'claude';
    state.session = { session_id: 'xyz', worker: 'claude', started_at: new Date().toISOString() };
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    state.preferred_worker_set_at = yesterday.toISOString();
    expirePreferredWorker(state);
    assert.equal(state.session, undefined);
  });
});

// ---------------------------------------------------------------------------
// handleDefaultQuery
// ---------------------------------------------------------------------------

describe('handleDefaultQuery', () => {
  it('matches /default with no argument', () => {
    const result = handleDefaultQuery('/default');
    assert.equal(result.matched, true);
    assert.equal(result.worker, undefined);
  });

  it('matches /default claude', () => {
    const result = handleDefaultQuery('/default claude');
    assert.equal(result.matched, true);
    assert.equal(result.worker, 'claude');
  });

  it('matches /default gemini (case insensitive)', () => {
    const result = handleDefaultQuery('/default GEMINI');
    assert.equal(result.matched, true);
    assert.equal(result.worker, 'gemini');
  });

  it('matches /default zclaude', () => {
    const result = handleDefaultQuery('/default zclaude');
    assert.equal(result.matched, true);
    assert.equal(result.worker, 'zclaude');
  });

  it('matches /default codex', () => {
    const result = handleDefaultQuery('/default codex');
    assert.equal(result.matched, true);
    assert.equal(result.worker, 'codex');
  });

  it('does not match /default invalidmodel', () => {
    const result = handleDefaultQuery('/default invalidmodel');
    assert.equal(result.matched, false);
  });

  it('does not match /default with extra words', () => {
    const result = handleDefaultQuery('/default claude extra');
    assert.equal(result.matched, false);
  });

  it('does not match unrelated messages', () => {
    const result = handleDefaultQuery('hello');
    assert.equal(result.matched, false);
  });
});

// ---------------------------------------------------------------------------
// parseMetadata
// ---------------------------------------------------------------------------

describe('parseMetadata', () => {
  // --- no metadata ---

  it('passthrough when no [PA_META] line present', () => {
    const output = 'Hello, here is your answer.';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, output);
    assert.equal(meta, null);
  });

  it('passthrough for empty string', () => {
    const { cleaned, meta } = parseMetadata('');
    assert.equal(cleaned, '');
    assert.equal(meta, null);
  });

  it('passthrough for multiline output with no metadata', () => {
    const output = 'Line one.\nLine two.\nLine three.';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, output);
    assert.equal(meta, null);
  });

  // --- bracket-less PA_META: (LLM formatting error) ---

  it('strips bracket-less PA_META: line and returns meta=null', () => {
    const output = 'Some response.\nPA_META: {"actions":}';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, 'Some response.');
    assert.equal(meta, null);
  });

  it('strips bracket-less PA_META: with valid-looking JSON', () => {
    const output = 'Text.\nPA_META: {"actions":[{"type":"confirm_required"}]}';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, 'Text.');
    assert.equal(meta, null); // bracket-less variant always yields null meta
  });

  it('does not strip bracket-less PA_META: in the middle of output', () => {
    const output = 'Before.\nPA_META: {"actions":}\nAfter text.';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, output);
    assert.equal(meta, null);
  });

  // --- valid metadata: retry_with_worker ---

  it('parses retry_with_worker action', () => {
    const output = 'I cannot access that path.\n[PA_META]: {"actions":[{"type":"retry_with_worker","worker":"claude","reason":"path_restriction"}]}';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, 'I cannot access that path.');
    assert.ok(meta !== null);
    assert.equal(meta!.actions.length, 1);
    assert.equal(meta!.actions[0].type, 'retry_with_worker');
    assert.equal(meta!.actions[0].worker, 'claude');
    assert.equal(meta!.actions[0].reason, 'path_restriction');
  });

  it('parses retry_with_worker without worker field (new canonical format)', () => {
    const output = 'I cannot access that path.\n[PA_META]: {"actions":[{"type":"retry_with_worker","reason":"path outside workspace"}]}';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, 'I cannot access that path.');
    assert.ok(meta !== null);
    assert.equal(meta!.actions[0].type, 'retry_with_worker');
    assert.equal(meta!.actions[0].worker, undefined);
    assert.equal(meta!.actions[0].reason, 'path outside workspace');
  });

  // --- valid metadata: run_skill ---

  it('parses run_skill action', () => {
    const output = 'Done.\n[PA_META]: {"actions":[{"type":"run_skill","skill":"fitness-sync"}]}';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, 'Done.');
    assert.ok(meta !== null);
    assert.equal(meta!.actions[0].type, 'run_skill');
    assert.equal(meta!.actions[0].skill, 'fitness-sync');
  });

  // --- valid metadata: confirm_required ---

  it('parses confirm_required action', () => {
    const output = 'I will archive 3 emails.\n[PA_META]: {"actions":[{"type":"confirm_required"}]}';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, 'I will archive 3 emails.');
    assert.ok(meta !== null);
    assert.equal(meta!.actions[0].type, 'confirm_required');
  });

  // --- multiple actions ---

  it('parses multiple actions in one envelope', () => {
    const output = 'Response.\n[PA_META]: {"actions":[{"type":"run_skill","skill":"foo"},{"type":"confirm_required"}]}';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, 'Response.');
    assert.ok(meta !== null);
    assert.equal(meta!.actions.length, 2);
  });

  // --- unknown action type ---

  it('parses unknown action types without error (forward compat)', () => {
    const output = 'Text.\n[PA_META]: {"actions":[{"type":"future_action","foo":"bar"}]}';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, 'Text.');
    assert.ok(meta !== null);
    assert.equal(meta!.actions[0].type, 'future_action');
  });

  // --- strips metadata line, preserves body ---

  it('strips only the [PA_META] line, preserves all body text', () => {
    const body = 'First paragraph.\n\nSecond paragraph with details.';
    const output = `${body}\n[PA_META]: {"actions":[{"type":"confirm_required"}]}`;
    const { cleaned } = parseMetadata(output);
    assert.equal(cleaned, body);
  });

  it('handles trailing whitespace after JSON', () => {
    const output = 'Answer.\n[PA_META]: {"actions":[{"type":"confirm_required"}]}   ';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, 'Answer.');
    assert.ok(meta !== null);
  });

  // --- multiline JSON (LLM pretty-prints) ---

  it('parses multiline JSON (pretty-printed by LLM)', () => {
    const output = 'I cannot access that path.\n[PA_META]: {\n  "actions": [{"type": "retry_with_worker", "worker": "claude", "reason": "path_restriction"}]\n}';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, 'I cannot access that path.');
    assert.ok(meta !== null, 'meta must be parsed from multiline JSON');
    assert.equal(meta!.actions[0].type, 'retry_with_worker');
    assert.equal(meta!.actions[0].worker, 'claude');
  });

  it('parses multiline JSON with trailing newline', () => {
    const output = 'Text.\n[PA_META]: {\n  "actions": [{"type": "confirm_required"}]\n}\n';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, 'Text.');
    assert.ok(meta !== null);
    assert.equal(meta!.actions[0].type, 'confirm_required');
  });

  // --- malformed JSON ---

  it('returns meta=null for malformed JSON, cleaned has body without [PA_META] line', () => {
    const output = 'Text.\n[PA_META]: {not valid json}';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(meta, null);
    assert.equal(cleaned, 'Text.');
  });

  it('returns meta=null when actions is not an array', () => {
    const output = 'Text.\n[PA_META]: {"actions":"not-an-array"}';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(meta, null);
    assert.equal(cleaned, 'Text.');
  });

  it('returns meta=null when JSON has no actions field', () => {
    const output = 'Text.\n[PA_META]: {"foo":"bar"}';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(meta, null);
    assert.equal(cleaned, 'Text.');
  });

  // --- trailing CLI artifacts (e.g. </invoke> appended by zclaude runtime) ---

  it('strips [PA_META] and parses meta when followed by trailing </invoke>', () => {
    const output = 'Text.\n[PA_META]: {"actions":[]}\n</invoke>';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, 'Text.');
    assert.deepEqual(meta, { actions: [] });
  });

  it('strips [PA_META] with confirm_required when followed by trailing </invoke>', () => {
    const output = 'Do the thing?\n[PA_META]: {"actions":[{"type":"confirm_required"}]}\n</invoke>';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, 'Do the thing?');
    assert.deepEqual(meta, { actions: [{ type: 'confirm_required' }] });
  });

  it('strips [PA_META] marker when JSON is malformed and trailing artifact present', () => {
    const output = 'Text.\n[PA_META]: {bad json}\n</invoke>';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(cleaned, 'Text.');
    assert.equal(meta, null);
  });

  // --- must be at end of output ---

  it('does not match [PA_META] in the middle of output', () => {
    const output = 'Before.\n[PA_META]: {"actions":[{"type":"confirm_required"}]}\nAfter text here.';
    const { cleaned, meta } = parseMetadata(output);
    assert.equal(meta, null);
    assert.equal(cleaned, output); // passthrough unchanged
  });

  // --- idempotency and safety ---

  it('calling twice on output without metadata is safe', () => {
    const output = 'Normal response.';
    const first = parseMetadata(output);
    const second = parseMetadata(first.cleaned);
    assert.equal(second.cleaned, output);
    assert.equal(second.meta, null);
  });

  it('calling twice on output with metadata strips it cleanly once', () => {
    const output = 'Text.\n[PA_META]: {"actions":[{"type":"confirm_required"}]}';
    const first = parseMetadata(output);
    const second = parseMetadata(first.cleaned);
    // Second call: no metadata line left, passthrough
    assert.equal(second.cleaned, 'Text.');
    assert.equal(second.meta, null);
  });
});

// ---------------------------------------------------------------------------
// parseMetadata — execution mode
// ---------------------------------------------------------------------------

describe('parseMetadata: execution mode', () => {
  it('strips [PA_META] envelope and returns empty actions when executionMode=true', () => {
    const output = 'Sent the email.\n[PA_META]: {"actions":[{"type":"confirm_required"}]}';
    const { cleaned, meta } = parseMetadata(output, true);
    assert.equal(cleaned, 'Sent the email.');
    assert.equal(meta, null, 'actions must be suppressed in execution mode');
  });

  it('parses actions normally when executionMode=false (default)', () => {
    const output = 'Send the email?\n[PA_META]: {"actions":[{"type":"confirm_required"}]}';
    const { cleaned, meta } = parseMetadata(output, false);
    assert.equal(cleaned, 'Send the email?');
    assert.ok(meta !== null, 'meta must be parsed in normal mode');
    assert.equal(meta!.actions[0].type, 'confirm_required');
  });

  it('still strips the envelope text in execution mode (no leak to user)', () => {
    const output = 'Done.\n[PA_META]: {"actions":[{"type":"run_skill","skill":"daily-mail-brief"}]}';
    const { cleaned, meta } = parseMetadata(output, true);
    assert.equal(cleaned, 'Done.');
    assert.equal(meta, null);
    assert.ok(!cleaned.includes('[PA_META]'), '[PA_META] must not leak to user-visible output');
  });

  it('passes through clean output unchanged in execution mode (no marker)', () => {
    const output = 'The file has been updated.';
    const { cleaned, meta } = parseMetadata(output, true);
    assert.equal(cleaned, output);
    assert.equal(meta, null);
  });

  it('handles retry_with_worker suppression in execution mode', () => {
    const output = 'Partial work done.\n[PA_META]: {"actions":[{"type":"retry_with_worker","reason":"path restriction"}]}';
    const { cleaned, meta } = parseMetadata(output, true);
    assert.equal(cleaned, 'Partial work done.');
    assert.equal(meta, null, 'retry_with_worker must also be suppressed in execution mode');
  });
});

// ---------------------------------------------------------------------------
// applyMetaActions
// ---------------------------------------------------------------------------

function meta(actions: PAMeta['actions']): PAMeta {
  return { actions };
}

describe('applyMetaActions', () => {
  // --- null meta (no PA_META in response) ---

  it('returns response unchanged and skillToRun=null when meta is null', () => {
    const state = makeState();
    const { response, skillToRun, restartBot } = applyMetaActions('Hello.', null, state);
    assert.equal(response, 'Hello.');
    assert.equal(skillToRun, null);
    assert.equal(state.pending_action, undefined);
  });

  it('returns response unchanged and skillToRun=null for empty actions array', () => {
    const state = makeState();
    const { response, skillToRun } = applyMetaActions('Hello.', meta([]), state);
    assert.equal(response, 'Hello.');
    assert.equal(skillToRun, null);
  });

  // --- CONFIRMATION_PATTERN (text-based) ---

  it('sets pending_action when response contains "Reply *yes* to confirm"', () => {
    const state = makeState();
    const resp = 'I will send the email. Reply *yes* to confirm or *no* to cancel.';
    const { response } = applyMetaActions(resp, null, state);
    assert.equal(response, resp); // response unchanged
    assert.ok(state.pending_action, 'pending_action must be set');
    assert.equal(state.pending_action!.description, resp);
  });

  it('text-based confirmation does not append extra text', () => {
    const state = makeState();
    const resp = 'I will delete the file. Reply *yes* to confirm or *no* to cancel.';
    const { response } = applyMetaActions(resp, null, state);
    assert.equal(response, resp); // exactly as-is, no extra appended
  });

  // --- confirm_required (metadata-based) ---

  it('confirm_required sets pending_action and appends confirmation prompt', () => {
    const state = makeState();
    const { response } = applyMetaActions('I will archive 3 emails.', meta([{ type: 'confirm_required' }]), state);
    assert.ok(state.pending_action, 'pending_action must be set');
    assert.equal(state.pending_action!.description, 'I will archive 3 emails.');
    assert.ok(response.includes('Reply *yes* to confirm'), 'should append confirmation prompt');
  });

  it('confirm_required does NOT fire when text pattern already set pending_action', () => {
    const state = makeState();
    const resp = 'I will do X. Reply *yes* to confirm or *no* to cancel.';
    const { response, skillToRun, restartBot } = applyMetaActions(resp, meta([{ type: 'confirm_required' }]), state);
    // Text pattern fires first; confirm_required is skipped → no double-append
    assert.equal(response, resp, 'response must not have confirmation appended twice');
  });

  it('confirm_required pending_action description is the response BEFORE the appended prompt', () => {
    const state = makeState();
    const original = 'I will archive emails.';
    applyMetaActions(original, meta([{ type: 'confirm_required' }]), state);
    // description = original text, not original + "Reply *yes*..."
    assert.equal(state.pending_action!.description, original);
  });

  // --- run_skill ---

  it('run_skill returns skillToRun and appends trigger note', () => {
    const state = makeState();
    const { response, skillToRun } = applyMetaActions(
      'Done.',
      meta([{ type: 'run_skill', skill: 'fitness-sync' }]),
      state
    );
    assert.equal(skillToRun, 'fitness-sync');
    assert.ok(response.includes('_(Triggering skill: fitness-sync)_'));
  });

  it('run_skill does not set pending_action', () => {
    const state = makeState();
    applyMetaActions('Done.', meta([{ type: 'run_skill', skill: 'fitness-sync' }]), state);
    assert.equal(state.pending_action, undefined);
  });

  it('run_skill is suppressed when confirm_required also fires', () => {
    const state = makeState();
    const { skillToRun } = applyMetaActions(
      'I will do something.',
      meta([{ type: 'confirm_required' }, { type: 'run_skill', skill: 'fitness-sync' }]),
      state
    );
    // confirm_required sets pending_action → run_skill is skipped
    assert.equal(skillToRun, null, 'run_skill must be suppressed when confirmation is pending');
    assert.ok(state.pending_action, 'confirm_required must still fire');
  });

  it('run_skill is suppressed when text CONFIRMATION_PATTERN also fires', () => {
    const state = makeState();
    const { skillToRun } = applyMetaActions(
      'I will delete files. Reply *yes* to confirm or *no* to cancel.',
      meta([{ type: 'run_skill', skill: 'fitness-sync' }]),
      state
    );
    assert.equal(skillToRun, null);
    assert.ok(state.pending_action);
  });

  // --- skill name validation ---

  it('rejects skill name with special characters (command injection guard)', () => {
    const state = makeState();
    const { skillToRun, response } = applyMetaActions(
      'Done.',
      meta([{ type: 'run_skill', skill: 'foo; rm -rf /' }]),
      state
    );
    assert.equal(skillToRun, null);
    // Response must NOT include the malicious skill name in a trigger note
    assert.ok(!response.includes('_(Triggering skill:'), 'trigger note must not appear for invalid skill');
  });

  it('accepts valid skill names: letters, numbers, hyphens, underscores', () => {
    for (const valid of ['fitness-sync', 'ecosystem_kb', 'skill123', 'ABC-def_0']) {
      const state = makeState();
      const { skillToRun } = applyMetaActions('Done.', meta([{ type: 'run_skill', skill: valid }]), state);
      assert.equal(skillToRun, valid, `"${valid}" should be accepted`);
    }
  });

  // --- unknown action types ---

  it('unknown action types are ignored without error', () => {
    const state = makeState();
    const { response, skillToRun } = applyMetaActions(
      'Response.',
      meta([{ type: 'future_action' }]),
      state
    );
    assert.equal(response, 'Response.');
    assert.equal(skillToRun, null);
    assert.equal(state.pending_action, undefined);
  });

  // --- restart_bot ---

  it('restart_bot returns restartBot=true and appends hint', () => {
    const state = makeState();
    const { response, skillToRun, restartBot } = applyMetaActions(
      'Deployment complete.',
      meta([{ type: 'restart_bot' }]),
      state
    );
    assert.equal(restartBot, true);
    assert.ok(response.includes('_(Restarting bot for deployment...)_'));
    assert.ok(response.startsWith('Deployment complete.'));
  });

  it('restart_bot works alongside confirm_required', () => {
    const state = makeState();
    const { response, restartBot } = applyMetaActions(
      'Ready to update?',
      meta([{ type: 'restart_bot' }, { type: 'confirm_required' }]),
      state
    );
    assert.equal(restartBot, true);
    assert.ok(state.pending_action);
    assert.ok(response.includes('_(Restarting bot for deployment...)_'));
    assert.ok(response.includes('Reply *yes* to confirm'));
  });

  it('restartBot is false by default', () => {
    const state = makeState();
    const { restartBot } = applyMetaActions('Hello.', null, state);
    assert.equal(restartBot, false);
  });

  // --- state isolation ---

  it('does not mutate other state fields', () => {
    const state = makeState();
    state.last_update_id = 42;
    const { response, skillToRun, restartBot } = applyMetaActions('I will send.', meta([{ type: 'confirm_required' }]), state);
    assert.equal(state.last_update_id, 42);
    assert.equal(state.chat_id, 1);
  });
});

// ---------------------------------------------------------------------------
// CODE_PATTERN
// ---------------------------------------------------------------------------

describe('CODE_PATTERN', () => {
  it('matches /code with no args', () => assert.ok(CODE_PATTERN.test('/code')));
  it('matches /code reset', () => assert.ok(CODE_PATTERN.test('/code reset')));
  it('matches /code with a path', () => assert.ok(CODE_PATTERN.test('/code C:/test-repos/project')));
  it('matches /code with path and instruction', () => assert.ok(CODE_PATTERN.test('/code C:/foo fix the bug')));
  it('matches case-insensitively', () => assert.ok(CODE_PATTERN.test('/CODE reset')));
  it('does not match /codeword (word boundary)', () => assert.ok(!CODE_PATTERN.test('/codeword')));
  it('does not match mid-string /code', () => assert.ok(!CODE_PATTERN.test('use /code here')));
});

// ---------------------------------------------------------------------------
// parseCodeArgs
// ---------------------------------------------------------------------------

describe('parseCodeArgs', () => {
  it('splits unquoted path and instruction', () => {
    const { path, rest } = parseCodeArgs('C:/foo fix the bug');
    assert.equal(path, 'C:/foo');
    assert.equal(rest, 'fix the bug');
  });

  it('returns path only when no instruction', () => {
    const { path, rest } = parseCodeArgs('C:/foo');
    assert.equal(path, 'C:/foo');
    assert.equal(rest, '');
  });

  it('handles quoted path with spaces', () => {
    const { path, rest } = parseCodeArgs('"C:/test repos/some project" do something');
    assert.equal(path, 'C:/test repos/some project');
    assert.equal(rest, 'do something');
  });

  it('handles quoted path only (no instruction)', () => {
    const { path, rest } = parseCodeArgs('"C:/test repos/some project"');
    assert.equal(path, 'C:/test repos/some project');
    assert.equal(rest, '');
  });
});

// ---------------------------------------------------------------------------
// handleCodeCommand
// ---------------------------------------------------------------------------

describe('handleCodeCommand', () => {
  // The /code command's default fallback string uses BOT_CWD (env-driven).
  // Tests set both BOT_CWD and PA_REPOS_BASE to known values so the assertions
  // are deterministic regardless of where the test runner is invoked from.
  // Note: REPOS_BASE is read at module load (logic.ts line 140), so changing
  // PA_REPOS_BASE at runtime won't propagate — these tests don't exercise that path.
  const TEST_BOT_CWD = 'C:/test-project';
  let originalBotCwd: string | undefined;
  before(() => {
    originalBotCwd = process.env.BOT_CWD;
    process.env.BOT_CWD = TEST_BOT_CWD;
  });
  after(() => {
    if (originalBotCwd === undefined) delete process.env.BOT_CWD;
    else process.env.BOT_CWD = originalBotCwd;
  });

  // --- no match ---

  it('returns matched:false for non-/code text', () => {
    const state = makeState();
    const result = handleCodeCommand(state, 'hello world');
    assert.equal(result.matched, false);
    assert.equal(result.action, 'none');
  });

  // --- show ---

  it('/code with no args returns action:show with default message', () => {
    const state = makeState();
    const result = handleCodeCommand(state, '/code');
    assert.equal(result.matched, true);
    assert.equal(result.action, 'show');
    assert.match(result.response, new RegExp(TEST_BOT_CWD.replace(/[/\\]/g, '\\$&')));
  });

  it('/code with no args shows current cwd_override when set', () => {
    const state = makeState();
    state.cwd_override = 'C:/test-repos/notes';
    const result = handleCodeCommand(state, '/code');
    assert.equal(result.action, 'show');
    assert.match(result.response, /C:\/test-repos\/notes/);
  });

  // --- reset ---

  it('/code reset clears cwd_override and session', () => {
    const state = makeState();
    state.cwd_override = 'C:/test-repos/notes';
    state.session = { session_id: 'abc', worker: 'claude', started_at: new Date().toISOString() };
    const result = handleCodeCommand(state, '/code reset');
    assert.equal(result.action, 'reset');
    assert.equal(state.cwd_override, undefined);
    assert.equal(state.session, undefined);
    assert.match(result.response, /Cleared/);
  });

  it('/code reset when no override reports already-default', () => {
    const state = makeState();
    const result = handleCodeCommand(state, '/code reset');
    assert.equal(result.action, 'reset');
    assert.match(result.response, /Already/);
    assert.equal(state.cwd_override, undefined);
  });

  it('/code RESET is case-insensitive', () => {
    const state = makeState();
    state.cwd_override = 'C:/foo';
    const result = handleCodeCommand(state, '/code RESET');
    assert.equal(result.action, 'reset');
    assert.equal(state.cwd_override, undefined);
  });

  // --- set ---

  it('/code <path> returns action:set with parsed path', () => {
    const state = makeState();
    const result = handleCodeCommand(state, '/code C:/test-repos/project');
    assert.equal(result.action, 'set');
    assert.equal(result.path, 'C:/test-repos/project');
    assert.equal(result.instruction, undefined);
  });

  it('/code <path> <instruction> returns action:set with path and instruction', () => {
    const state = makeState();
    const result = handleCodeCommand(state, '/code C:/foo fix the login bug');
    assert.equal(result.action, 'set');
    assert.equal(result.path, 'C:/foo');
    assert.equal(result.instruction, 'fix the login bug');
  });

  it('/code set does not mutate state (caller responsibility)', () => {
    const state = makeState();
    handleCodeCommand(state, '/code C:/foo');
    // handleCodeCommand must NOT set cwd_override — only caller (main.ts) should after validation
    assert.equal(state.cwd_override, undefined);
  });

  // --- path resolution ---

  // REPOS_BASE is loaded at module init from process.env.PA_REPOS_BASE.
  // These tests use the live value (or skip if empty).
  const reposBase = process.env.PA_REPOS_BASE || '';

  it('/code short-name resolves under PA_REPOS_BASE', { skip: !reposBase && 'PA_REPOS_BASE not set — short-name resolution disabled' }, () => {
    const state = makeState();
    const result = handleCodeCommand(state, '/code taste-arena');
    assert.equal(result.action, 'set');
    assert.equal(result.path, `${reposBase}/taste-arena`);
  });

  it('/code short-name with instruction resolves and preserves instruction', { skip: !reposBase && 'PA_REPOS_BASE not set' }, () => {
    const state = makeState();
    const result = handleCodeCommand(state, '/code taste-arena fix the tests');
    assert.equal(result.path, `${reposBase}/taste-arena`);
    assert.equal(result.instruction, 'fix the tests');
  });

  it('/code absolute path with spaces must be quoted', () => {
    const state = makeState();
    const result = handleCodeCommand(state, '/code "C:/test repos/some project"');
    assert.equal(result.path, 'C:/test repos/some project');
  });

  it('/code absolute path without spaces is preserved', () => {
    const state = makeState();
    const result = handleCodeCommand(state, '/code C:/test-repos/project');
    assert.equal(result.path, 'C:/test-repos/project');
  });
});

// ---------------------------------------------------------------------------
// normalizeMarkdown
// ---------------------------------------------------------------------------

describe('normalizeMarkdown', () => {
  // bold
  it('converts **bold** to *bold*', () => {
    assert.equal(normalizeMarkdown('**hello**'), '*hello*');
  });
  it('converts multiple **bold** spans in one line', () => {
    assert.equal(normalizeMarkdown('**foo** and **bar**'), '*foo* and *bar*');
  });
  it('leaves *single asterisk* unchanged', () => {
    assert.equal(normalizeMarkdown('*already*'), '*already*');
  });

  // strikethrough
  it('converts ~~strike~~ to ~strike~', () => {
    assert.equal(normalizeMarkdown('~~text~~'), '~text~');
  });

  // headers
  it('converts ### header to *bold*', () => {
    assert.equal(normalizeMarkdown('### My Header'), '*My Header*');
  });
  it('converts ## and # headers', () => {
    assert.equal(normalizeMarkdown('## Sec\n# Top'), '*Sec*\n*Top*');
  });
  it('converts ### **bold header** without double-wrapping', () => {
    assert.equal(normalizeMarkdown('### **Title**'), '*Title*');
  });

  // bullets
  it('converts - bullet to • bullet', () => {
    assert.equal(normalizeMarkdown('- item one'), '• item one');
  });
  it('converts * bullet to • bullet', () => {
    assert.equal(normalizeMarkdown('* item one'), '• item one');
  });
  it('converts indented bullets', () => {
    assert.equal(normalizeMarkdown('  - nested'), '• nested');
  });

  // horizontal rules
  it('strips --- horizontal rules', () => {
    assert.equal(normalizeMarkdown('before\n---\nafter'), 'before\n\nafter');
  });
  it('strips longer ---- rules', () => {
    assert.equal(normalizeMarkdown('a\n-----\nb'), 'a\n\nb');
  });

  // code protection
  it('does not convert **bold** inside code spans', () => {
    assert.equal(normalizeMarkdown('`**not bold**`'), '`**not bold**`');
  });
  it('does not convert headers inside code blocks', () => {
    const input = '```\n### not a header\n```';
    assert.equal(normalizeMarkdown(input), input);
  });
  it('converts outside code span but not inside', () => {
    const result = normalizeMarkdown('**bold** and `**raw**`');
    assert.equal(result, '*bold* and `**raw**`');
  });

  // real-world
  it('real-world Gemini output: **bold** in list item', () => {
    const input = '*   **[AI-022] Folder-Scoped Sessions**: done';
    const result = normalizeMarkdown(input);
    assert.ok(result.includes('*[AI-022] Folder-Scoped Sessions*'), 'bold converted');
    assert.ok(!result.includes('**'), 'no double asterisks remain');
  });
});

describe('normalizeMarkdown: table → code block', () => {
  it('wraps a markdown table in a code block', () => {
    const input = '| A | B |\n|---|---|\n| 1 | 2 |';
    const result = normalizeMarkdown(input);
    assert.ok(result.startsWith('```\n'), 'starts with code fence');
    assert.ok(result.endsWith('\n```'), 'ends with code fence');
    assert.ok(result.includes('| A | B |'), 'header row preserved');
    assert.ok(result.includes('| 1 | 2 |'), 'data row preserved');
  });

  it('does not wrap pipe-only text without a separator row', () => {
    const input = '| just a line |';
    const result = normalizeMarkdown(input);
    assert.ok(!result.startsWith('```'), 'no code fence without separator');
  });

  it('wraps a table with alignment colons in separator', () => {
    const input = '| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | c |';
    const result = normalizeMarkdown(input);
    assert.ok(result.startsWith('```\n'), 'starts with code fence');
    assert.ok(result.includes('|:-----|:------:|------:|'), 'separator row preserved');
  });

  it('preserves surrounding text around a table', () => {
    const input = 'Intro:\n\n| Col |\n|-----|\n| val |\n\nAfter.';
    const result = normalizeMarkdown(input);
    assert.ok(result.includes('Intro:'), 'intro preserved');
    assert.ok(result.includes('After.'), 'trailing text preserved');
    assert.ok(result.includes('```'), 'table wrapped in code block');
  });

  it('does not convert table content inside existing code blocks', () => {
    const input = '```\n| A | B |\n|---|---|\n| 1 | 2 |\n```';
    const result = normalizeMarkdown(input);
    // Should be a single code block, not double-wrapped
    assert.equal((result.match(/```/g) ?? []).length, 2, 'exactly one pair of fences');
  });
});

describe('normalizeMarkdown: table → code block (edge cases)', () => {
  it('handles alignment colons in separator (|:---|:---:|)', () => {
    const input = '| L | C |\n|:---|:---:|\n| v | v |';
    const result = normalizeMarkdown(input);
    assert.ok(result.startsWith('```\n'), 'wrapped in code block');
    assert.ok(result.includes('| L | C |'), 'header preserved');
  });

  it('does not wrap two pipe lines without a separator', () => {
    const input = '| row 1 |\n| row 2 |';
    const result = normalizeMarkdown(input);
    assert.ok(!result.includes('```'), 'no wrapping without separator');
  });
});

describe('buildWorkerResponse: Gemini thought blocks', () => {
  it('calls normalizeMarkdown on extracted thought block content', () => {
    const output = '[Thought: true]\n**Bold result** with _italic_\n[Thought: false]';
    const result = buildWorkerResponse({ success: true, output }, 'gemini');
    assert.ok(result.includes('*Bold result*'), '**bold** converted to *bold*');
    assert.ok(!result.includes('**'), 'no double asterisks remain');
  });

  it('normalizes a table inside a Gemini thought block', () => {
    const table = '| A | B |\n|---|---|\n| 1 | 2 |';
    const output = `[Thought: true]\nHere:\n\n${table}\n[Thought: false]`;
    const result = buildWorkerResponse({ success: true, output }, 'gemini');
    assert.ok(result.includes('```'), 'table wrapped in code block');
    assert.ok(result.includes('| A | B |'), 'table content preserved');
  });
});

describe('normalizeMarkdown: pre-escape stripping', () => {
  it('strips \\. to .', () => {
    assert.equal(normalizeMarkdown('version 1\\.0'), 'version 1.0');
  });
  it('strips \\( and \\) to parens', () => {
    assert.equal(normalizeMarkdown('hello \\(world\\)'), 'hello (world)');
  });
  it('strips \\! to !', () => {
    assert.equal(normalizeMarkdown('wow\\!'), 'wow!');
  });
  it('strips \\- to -', () => {
    assert.equal(normalizeMarkdown('A \\- B'), 'A - B');
  });
  it('strips \\> to >', () => {
    assert.equal(normalizeMarkdown('\\> quoted'), '> quoted');
  });
  it('strips \\[ and \\] in plain text', () => {
    assert.equal(normalizeMarkdown('see \\[note\\]'), 'see [note]');
  });
  it('strips \\= \\+ \\| \\{ \\}', () => {
    assert.equal(normalizeMarkdown('a\\=b \\+c \\|d \\{e\\}'), 'a=b +c |d {e}');
  });
  it('does not strip pre-escapes inside code spans', () => {
    assert.equal(normalizeMarkdown('`1\\.0`'), '`1\\.0`');
  });
  it('does not strip pre-escapes inside code blocks', () => {
    const input = '```\n1\\.0\n```';
    assert.equal(normalizeMarkdown(input), input);
  });
  it('is idempotent on clean CommonMark text', () => {
    assert.equal(normalizeMarkdown('hello (world)'), 'hello (world)');
  });
  it('strips pre-escapes then converts **bold**', () => {
    assert.equal(normalizeMarkdown('**hello\\!**'), '*hello!*');
  });
  it('strips pre-escapes in headers', () => {
    assert.equal(normalizeMarkdown('### Version 1\\.0'), '*Version 1.0*');
  });
  it('strips \\* pre-escape (not treated as bullet)', () => {
    assert.equal(normalizeMarkdown('price \\*before\\* tax'), 'price *before* tax');
  });
  it('strips multiple pre-escapes in one line', () => {
    assert.equal(normalizeMarkdown('v1\\.2\\.3 \\(stable\\)'), 'v1.2.3 (stable)');
  });
});

// ---------------------------------------------------------------------------
// NEW_PATTERN
// ---------------------------------------------------------------------------

describe('NEW_PATTERN', () => {
  it('matches bare /new', () => assert.ok(NEW_PATTERN.test('/new')));
  it('matches /new with instruction', () => assert.ok(NEW_PATTERN.test('/new summarise the plan')));
  it('does not match /newer', () => assert.ok(!NEW_PATTERN.test('/newer')));
  it('does not match /reset', () => assert.ok(!NEW_PATTERN.test('/reset')));
  it('captures instruction', () => {
    const m = NEW_PATTERN.exec('/new do the thing');
    assert.equal(m?.[1], 'do the thing');
  });
  it('captures no instruction for bare /new', () => {
    const m = NEW_PATTERN.exec('/new');
    assert.equal(m?.[1], undefined);
  });
});

// ---------------------------------------------------------------------------
// clearTopicContext
// ---------------------------------------------------------------------------

describe('clearTopicContext', () => {
  it('clears turns, session, pending_action, and pendingDescription', () => {
    const state = makeState();
    state.turns.push({ role: 'user', text: 'hello', timestamp: '2026-01-01T00:00:00Z' });
    state.session = { session_id: 'abc', worker: 'claude', started_at: '2026-01-01T00:00:00Z' };
    state.pending_action = { description: 'do thing', proposed_at: '2026-01-01T00:00:00Z' };
    state.pendingDescription = { text: 'some suggestion', proposedAt: '2026-01-01T00:00:00Z', expiresAt: Date.now() + 99999 };
    clearTopicContext(state);
    assert.equal(state.turns.length, 0);
    assert.equal(state.session, undefined);
    assert.equal(state.pending_action, undefined);
    assert.equal(state.pendingDescription, undefined);
  });

  it('preserves cwd_override and preferred_worker', () => {
    const state = makeState();
    state.cwd_override = 'C:/test-repos/foo';
    state.preferred_worker = 'gemini';
    state.preferred_worker_set_at = '2026-01-01T00:00:00Z';
    clearTopicContext(state);
    assert.equal(state.cwd_override, 'C:/test-repos/foo');
    assert.equal(state.preferred_worker, 'gemini');
  });
});

// ---------------------------------------------------------------------------
// handleNewCommand
// ---------------------------------------------------------------------------

describe('handleNewCommand', () => {
  it('returns matched:false for unrelated text', () => {
    const state = makeState();
    const result = handleNewCommand(state, 'hello there');
    assert.equal(result.matched, false);
  });

  it('matches /new and clears context', () => {
    const state = makeState();
    state.turns.push({ role: 'user', text: 'old turn', timestamp: '2026-01-01T00:00:00Z' });
    state.session = { session_id: 'sess1', worker: 'claude', started_at: '2026-01-01T00:00:00Z' };
    const result = handleNewCommand(state, '/new');
    assert.ok(result.matched);
    assert.equal(result.instruction, undefined);
    assert.equal(state.turns.length, 0);
    assert.equal(state.session, undefined);
  });

  it('extracts instruction from /new <text>', () => {
    const state = makeState();
    const result = handleNewCommand(state, '/new summarise the project');
    assert.ok(result.matched);
    assert.equal(result.instruction, 'summarise the project');
  });

  it('preserves cwd_override after /new', () => {
    const state = makeState();
    state.cwd_override = 'C:/test-repos/project';
    handleNewCommand(state, '/new');
    assert.equal(state.cwd_override, 'C:/test-repos/project');
  });

  it('preserves preferred_worker after /new', () => {
    const state = makeState();
    state.preferred_worker = 'gemini';
    handleNewCommand(state, '/new');
    assert.equal(state.preferred_worker, 'gemini');
  });
});

// ---------------------------------------------------------------------------
// handleResetCommand still clears everything (regression guard)
// ---------------------------------------------------------------------------

describe('handleResetCommand (regression after clearTopicContext refactor)', () => {
  it('clears turns, session, pending_action, preferred_worker, and cwd_override', () => {
    const state = makeState();
    state.turns.push({ role: 'user', text: 'hi', timestamp: '2026-01-01T00:00:00Z' });
    state.session = { session_id: 'x', worker: 'claude', started_at: '2026-01-01T00:00:00Z' };
    state.pending_action = { description: 'do thing', proposed_at: '2026-01-01T00:00:00Z' };
    state.preferred_worker = 'gemini';
    state.cwd_override = 'C:/foo';
    const result = handleResetCommand(state);
    assert.ok(result.matched);
    assert.equal(state.turns.length, 0);
    assert.equal(state.session, undefined);
    assert.equal(state.pending_action, undefined);
    assert.equal(state.preferred_worker, undefined);
    assert.equal(state.cwd_override, undefined);
  });
});

// ---------------------------------------------------------------------------
// BRANCH_PATTERN
// ---------------------------------------------------------------------------

describe('BRANCH_PATTERN', () => {
  it('matches /branch api-refactor', () => assert.ok(BRANCH_PATTERN.test('/branch api-refactor')));
  it('matches /branch my_feat', () => assert.ok(BRANCH_PATTERN.test('/branch my_feat')));
  it('rejects bare /branch', () => assert.ok(!BRANCH_PATTERN.test('/branch')));
});

// ---------------------------------------------------------------------------
// handleBranchCommand
// ---------------------------------------------------------------------------

describe('handleBranchCommand', () => {
  it('returns matched:false for non-branch text', () => {
    const r = handleBranchCommand(makeState(), 'hello world');
    assert.equal(r.matched, false);
  });

  it('returns error for invalid branch name with spaces', () => {
    const r = handleBranchCommand(makeState(), '/branch invalid name');
    assert.equal(r.matched, true);
    assert.ok(r.response.includes('1–50'));
    assert.equal(r.branchName, undefined);
  });

  it('returns matched:true with branchName for valid name', () => {
    const r = handleBranchCommand(makeState(), '/branch api-refactor');
    assert.equal(r.matched, true);
    assert.equal(r.branchName, 'api-refactor');
    assert.equal(r.response, '');
  });

  it('does not mutate state', () => {
    const state = makeState();
    const before = JSON.stringify(state);
    handleBranchCommand(state, '/branch my-branch');
    assert.equal(JSON.stringify(state), before);
  });
});

// ---------------------------------------------------------------------------
// CHILD_OF_PATTERN
// ---------------------------------------------------------------------------

describe('CHILD_OF_PATTERN', () => {
  it('matches /child-of parent-name', () => assert.ok(CHILD_OF_PATTERN.test('/child-of parent-name')));
  it('matches /child_of parent-name', () => assert.ok(CHILD_OF_PATTERN.test('/child_of parent-name')));
  it('rejects bare /child-of', () => assert.ok(!CHILD_OF_PATTERN.test('/child-of')));
});

// ---------------------------------------------------------------------------
// handleChildOfCommand
// ---------------------------------------------------------------------------

describe('handleChildOfCommand', () => {
  it('returns matched:false for non-child-of text', () => {
    const r = handleChildOfCommand(makeState(), 'hello');
    assert.equal(r.matched, false);
  });

  it('returns parentName and empty response for valid command', () => {
    const r = handleChildOfCommand(makeState(), '/child-of general');
    assert.equal(r.matched, true);
    assert.equal(r.parentName, 'general');
    assert.equal(r.response, '');
  });

  it('returns error response when active (un-merged) ancestry already set', () => {
    const state = makeState();
    state.ancestry = { parentChatId: 1, parentThreadId: 100, branchName: 'my-branch' };
    const r = handleChildOfCommand(state, '/child-of general');
    assert.equal(r.matched, true);
    assert.ok(r.response.includes('my-branch'));
    assert.equal(r.parentName, undefined);
  });

  it('allows re-link after merge (mergedAt set)', () => {
    const state = makeState();
    state.ancestry = {
      parentChatId: 1, parentThreadId: 100, branchName: 'my-branch',
      mergedAt: new Date('2026-04-20T10:00:00Z').toISOString(),
    };
    const r = handleChildOfCommand(state, '/child-of new-parent');
    assert.equal(r.matched, true);
    assert.equal(r.parentName, 'new-parent');
    assert.equal(r.response, '');
  });

  it('returns error for whitespace-only parent name', () => {
    const r = handleChildOfCommand(makeState(), '/child-of   ');
    assert.equal(r.matched, true);
    assert.ok(r.response.includes('empty'));
    assert.equal(r.parentName, undefined);
  });

  it('does not mutate state', () => {
    const state = makeState();
    const before = JSON.stringify(state);
    handleChildOfCommand(state, '/child-of general');
    assert.equal(JSON.stringify(state), before);
  });
});

// ---------------------------------------------------------------------------
// MERGE_PATTERN
// ---------------------------------------------------------------------------

describe('MERGE_PATTERN', () => {
  it('matches /merge', () => assert.ok(MERGE_PATTERN.test('/merge')));
  it('rejects /merge with arguments', () => assert.ok(!MERGE_PATTERN.test('/merge foo')));
});

// ---------------------------------------------------------------------------
// handleMergeCommand
// ---------------------------------------------------------------------------

describe('handleMergeCommand', () => {
  it('returns matched:false for non-merge text', () => {
    const r = handleMergeCommand(makeState(), '/mergeX');
    assert.equal(r.matched, false);
  });

  it('returns error when no ancestry set', () => {
    const r = handleMergeCommand(makeState(), '/merge');
    assert.equal(r.matched, true);
    assert.ok(r.response.includes('/child-of'));
  });

  it('returns already-merged message when mergedAt is set', () => {
    const state = makeState();
    state.ancestry = {
      parentChatId: 1, parentThreadId: 100, branchName: 'my-branch',
      mergedAt: new Date('2026-04-20T10:00:00Z').toISOString(),
    };
    const r = handleMergeCommand(state, '/merge');
    assert.equal(r.matched, true);
    assert.ok(r.response.includes('merged at'));
  });

  it('returns matched:true and empty response for valid unmerged ancestry', () => {
    const state = makeState();
    state.ancestry = { parentChatId: 1, parentThreadId: 100, branchName: 'my-branch' };
    const r = handleMergeCommand(state, '/merge');
    assert.equal(r.matched, true);
    assert.equal(r.response, '');
  });
});

// ---------------------------------------------------------------------------
// renderStatusCard
// ---------------------------------------------------------------------------

describe('renderStatusCard', () => {
  it('formats card with default, current, reason, and keep-awake lines', () => {
    const card = renderStatusCard({
      snapshot: buildModelStatusSnapshot({
        currentWorker: 'gemini',
        defaultWorker: 'zclaude',
        reasonCode: 'user_override',
      }),
      keepAwake: { active: true, since: '2026-04-21T07:26:00.000Z' }
    });
    assert.ok(card.includes('Default: zclaude'));
    assert.ok(card.includes('Current: gemini'));
    assert.ok(card.includes('Reason: Temporary user override until IST midnight.'));
    assert.ok(card.includes('Keep-awake: on since 2026-04-21T07:26:00.000Z'));
  });

  it('formats card with keep-awake off', () => {
    const card = renderStatusCard({
      snapshot: buildModelStatusSnapshot({
        defaultWorker: 'claude',
        reasonCode: 'default_active',
      }),
      keepAwake: { active: false }
    });
    assert.ok(card.includes('Current: claude'));
    assert.ok(card.includes('Keep-awake: off'));
  });
});
