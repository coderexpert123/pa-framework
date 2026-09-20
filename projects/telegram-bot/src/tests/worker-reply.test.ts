/**
 * Unit pins for the extracted worker-reply module (AI-173 phase 6).
 *
 * worker-reply.ts holds the reply pipeline moved verbatim out of logic.ts:
 * the pending-action/confirmation/question state machine (C5), the PA_META
 * parse/apply + premature-async guard + chip/dependency guards (C6), and the
 * markdown/worker-reply formatting pipeline (C7). This file pins:
 * - the logic.js barrel re-export surface (identity, not a copy)
 * - PA_META_PROTECTED_SKILLS membership (the authorization gate)
 * - parseMetadata parse ladder (plain, lone-backslash repair, no-envelope, executionMode)
 * - applyMetaActions (confirm_required, run_skill protected/allowed)
 * - isPrematureAsyncReply (positive + long-negative)
 * - normalizeMarkdown (basic CommonMark → MarkdownV2)
 * - buildWorkerErrorResponse (error formatting)
 * - sanitizeSuggestedItems (chip plain-language guard)
 *
 * No runPollLoop → no _setExitForTest needed; no real process.exit can fire.
 * PA_NOTIFY_DISABLED=1 via the scoped run env.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationState, PAMeta } from '../types.js';

// Dynamic imports for identity pins + unit tests
const logicMod = await import('../logic.js');
const workerReplyMod = await import('../worker-reply.js');

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return { chat_id: 1, last_update_id: 0, thread_id: 0, turns: [], ...overrides };
}

function meta(actions: PAMeta['actions']): PAMeta {
  return { actions };
}

// ---------------------------------------------------------------------------
// WR-T1 — re-export identity: C5 (barrel pins)
// ---------------------------------------------------------------------------

describe('re-export identity — C5', () => {
  it('logic.js CONFIRMATION_YES === worker-reply.js CONFIRMATION_YES', () => {
    assert.equal(logicMod.CONFIRMATION_YES, workerReplyMod.CONFIRMATION_YES);
  });
  it('logic.js CONFIRMATION_NO === worker-reply.js CONFIRMATION_NO', () => {
    assert.equal(logicMod.CONFIRMATION_NO, workerReplyMod.CONFIRMATION_NO);
  });
  it('logic.js CONFIRMATION_PATTERN === worker-reply.js CONFIRMATION_PATTERN', () => {
    assert.equal(logicMod.CONFIRMATION_PATTERN, workerReplyMod.CONFIRMATION_PATTERN);
  });
  it('logic.js PENDING_ACTION_TTL_MS === worker-reply.js PENDING_ACTION_TTL_MS', () => {
    assert.equal(logicMod.PENDING_ACTION_TTL_MS, workerReplyMod.PENDING_ACTION_TTL_MS);
  });
});

// ---------------------------------------------------------------------------
// WR-T2 — re-export identity: C6 (barrel pins)
// ---------------------------------------------------------------------------

describe('re-export identity — C6', () => {
  it('logic.js isPrematureAsyncReply === worker-reply.js isPrematureAsyncReply', () => {
    assert.equal(logicMod.isPrematureAsyncReply, workerReplyMod.isPrematureAsyncReply);
  });
  it('logic.js parseMetadata === worker-reply.js parseMetadata', () => {
    assert.equal(logicMod.parseMetadata, workerReplyMod.parseMetadata);
  });
  it('logic.js applyMetaActions === worker-reply.js applyMetaActions', () => {
    assert.equal(logicMod.applyMetaActions, workerReplyMod.applyMetaActions);
  });
  it('logic.js sanitizeSuggestedItems === worker-reply.js sanitizeSuggestedItems', () => {
    assert.equal(logicMod.sanitizeSuggestedItems, workerReplyMod.sanitizeSuggestedItems);
  });
  it('logic.js sanitizeSpawnDependsOn === worker-reply.js sanitizeSpawnDependsOn', () => {
    assert.equal(logicMod.sanitizeSpawnDependsOn, workerReplyMod.sanitizeSpawnDependsOn);
  });
  it('logic.js repairLoneBackslashes === worker-reply.js repairLoneBackslashes', () => {
    assert.equal(logicMod.repairLoneBackslashes, workerReplyMod.repairLoneBackslashes);
  });
  it('logic.js PA_META_PROTECTED_SKILLS === worker-reply.js PA_META_PROTECTED_SKILLS', () => {
    assert.equal(logicMod.PA_META_PROTECTED_SKILLS, workerReplyMod.PA_META_PROTECTED_SKILLS);
  });
});

// ---------------------------------------------------------------------------
// WR-T3 — re-export identity: C7 (barrel pins)
// ---------------------------------------------------------------------------

describe('re-export identity — C7', () => {
  it('logic.js normalizeMarkdown === worker-reply.js normalizeMarkdown', () => {
    assert.equal(logicMod.normalizeMarkdown, workerReplyMod.normalizeMarkdown);
  });
  it('logic.js formatWorkerReply === worker-reply.js formatWorkerReply', () => {
    assert.equal(logicMod.formatWorkerReply, workerReplyMod.formatWorkerReply);
  });
  it('logic.js buildWorkerResponse === worker-reply.js buildWorkerResponse', () => {
    assert.equal(logicMod.buildWorkerResponse, workerReplyMod.buildWorkerResponse);
  });
  it('logic.js buildWorkerErrorResponse === worker-reply.js buildWorkerErrorResponse', () => {
    assert.equal(logicMod.buildWorkerErrorResponse, workerReplyMod.buildWorkerErrorResponse);
  });
});

// ---------------------------------------------------------------------------
// WR-T4 — re-export identity: WorkerResult type (structural pin)
// ---------------------------------------------------------------------------

describe('re-export identity — WorkerResult type', () => {
  it('buildWorkerResponse from both modules accepts the same WorkerResult-shaped object', () => {
    const mockResult = { success: true, output: 'test output' };
    const fromLogic = logicMod.buildWorkerResponse(mockResult, 'claude');
    const fromWorkerReply = workerReplyMod.buildWorkerResponse(mockResult, 'claude');
    assert.equal(fromLogic, fromWorkerReply, 'both modules must treat the same object identically');
  });
});

// ---------------------------------------------------------------------------
// WR-T5 — PA_META_PROTECTED_SKILLS membership
// ---------------------------------------------------------------------------

describe('PA_META_PROTECTED_SKILLS membership', () => {
  it('contains the git-workflow family + self-improver', () => {
    assert.ok(workerReplyMod.PA_META_PROTECTED_SKILLS.has('self-improver'));
    assert.ok(workerReplyMod.PA_META_PROTECTED_SKILLS.has('commit'));
    assert.ok(workerReplyMod.PA_META_PROTECTED_SKILLS.has('push'));
    assert.ok(workerReplyMod.PA_META_PROTECTED_SKILLS.has('push-public'));
    assert.ok(workerReplyMod.PA_META_PROTECTED_SKILLS.has('investigate-flagged'));
    assert.ok(workerReplyMod.PA_META_PROTECTED_SKILLS.has('update-brain'));
  });
  it('does NOT contain non-protected skills', () => {
    assert.ok(!workerReplyMod.PA_META_PROTECTED_SKILLS.has('daily-mail-brief'));
    assert.ok(!workerReplyMod.PA_META_PROTECTED_SKILLS.has('travel-butler'));
  });
});

// ---------------------------------------------------------------------------
// WR-T6 — parseMetadata plain parse
// ---------------------------------------------------------------------------

describe('parseMetadata plain parse', () => {
  it('parses a well-formed [PA_META] envelope', () => {
    const input = 'Hello\n[PA_META]: {"actions":[{"type":"restart_bot"}]}';
    const result = workerReplyMod.parseMetadata(input);
    assert.equal(result.cleaned, 'Hello');
    assert.deepEqual(result.meta, { actions: [{ type: 'restart_bot' }] });
    assert.equal(result.parseError, undefined);
    assert.equal(result.repaired, undefined);
  });

  // ai246 WP-E (2026-09-15): a devin worker's PA_META envelope carrying a
  // UTF-8 em-dash inside a JSON string arrived mangled upstream and the action
  // dropped silently. The byte-path fix lives in pa's spawn decode + the devin
  // failover wrapper; this pins the parse side of the round-trip — an
  // em-dash-intact envelope MUST yield its action.
  it('a devin-shaped envelope with an em-dash inside a JSON string returns its spawn_thread action', () => {
    const input = 'Working on it.\n[PA_META]: {"actions":[{"type":"spawn_thread","title":"conflict — screencast","goal":"run it"}]}';
    const result = workerReplyMod.parseMetadata(input);
    assert.equal(result.cleaned, 'Working on it.');
    assert.equal(result.parseError, undefined);
    assert.equal(result.meta?.actions?.[0]?.type, 'spawn_thread');
    assert.equal((result.meta?.actions?.[0] as { title?: string })?.title, 'conflict — screencast');
  });
});

// ---------------------------------------------------------------------------
// WR-T7 — parseMetadata lone-backslash repair
// ---------------------------------------------------------------------------

describe('parseMetadata lone-backslash repair', () => {
  it('parses after repairing a lone backslash in a string literal', () => {
    const input = 'Hello\n[PA_META]: {"actions":[{"type":"restart_bot"}],"path":"D:\\Personal Assistant"}';
    const result = workerReplyMod.parseMetadata(input);
    assert.equal(result.cleaned, 'Hello');
    assert.ok(result.meta, 'meta should parse after repair');
    assert.equal(result.repaired, true);
  });
});

// ---------------------------------------------------------------------------
// WR-T8 — parseMetadata no envelope
// ---------------------------------------------------------------------------

describe('parseMetadata no envelope', () => {
  it('returns text unchanged with null meta when no [PA_META] marker', () => {
    const result = workerReplyMod.parseMetadata('Just text');
    assert.equal(result.cleaned, 'Just text');
    assert.equal(result.meta, null);
  });
});

// ---------------------------------------------------------------------------
// WR-T9 — parseMetadata executionMode
// ---------------------------------------------------------------------------

describe('parseMetadata executionMode', () => {
  it('strips meta when executionMode is true', () => {
    const input = 'Hello\n[PA_META]: {"actions":[{"type":"restart_bot"}]}';
    const result = workerReplyMod.parseMetadata(input, true);
    assert.equal(result.meta, null);
  });
});

// ---------------------------------------------------------------------------
// WR-T10 — applyMetaActions confirm_required
// ---------------------------------------------------------------------------

describe('applyMetaActions confirm_required', () => {
  it('sets pending_action and appends confirmation prompt', () => {
    const state = makeState();
    const { response } = workerReplyMod.applyMetaActions('Done', meta([{ type: 'confirm_required' }]), state);
    assert.ok(state.pending_action, 'pending_action must be set');
    assert.ok(response.endsWith('Reply *yes* to confirm or *no* to cancel.'));
  });
});

// ---------------------------------------------------------------------------
// WR-T11 — applyMetaActions run_skill protected
// ---------------------------------------------------------------------------

describe('applyMetaActions run_skill protected', () => {
  it('blocks a protected skill and returns skillToRun null', () => {
    const state = makeState();
    const { response, skillToRun } = workerReplyMod.applyMetaActions('ok', meta([{ type: 'run_skill', skill: 'commit' }]), state);
    assert.ok(response.includes('Skill trigger blocked: commit requires an explicit command.'));
    assert.equal(skillToRun, null);
  });
});

// ---------------------------------------------------------------------------
// WR-T12 — applyMetaActions run_skill allowed
// ---------------------------------------------------------------------------

describe('applyMetaActions run_skill allowed', () => {
  it('allows a non-protected skill and returns skillToRun', () => {
    const state = makeState();
    const { skillToRun } = workerReplyMod.applyMetaActions('ok', meta([{ type: 'run_skill', skill: 'daily-mail-brief' }]), state);
    assert.equal(skillToRun, 'daily-mail-brief');
  });
});

// ---------------------------------------------------------------------------
// WR-T13 — isPrematureAsyncReply positive
// ---------------------------------------------------------------------------

describe('isPrematureAsyncReply positive', () => {
  it('detects a contentless launched+waiting promise', () => {
    assert.equal(workerReplyMod.isPrematureAsyncReply('I have launched the check and will report back once it completes.'), true);
  });
});

// ---------------------------------------------------------------------------
// WR-T14 — isPrematureAsyncReply negative (long)
// ---------------------------------------------------------------------------

describe('isPrematureAsyncReply negative (long)', () => {
  it('does not suppress a long reply that leads with a promise', () => {
    const longText = 'I have launched the git log check and will review the output once it completes. Here is the detailed analysis of the repository state over the last 30 days, covering all branches and commit activity patterns observed during the review period with specific findings and recommendations for the team to consider.';
    assert.ok(longText.length > 240, 'test text must exceed 240 chars');
    assert.equal(workerReplyMod.isPrematureAsyncReply(longText), false);
  });
});

// ---------------------------------------------------------------------------
// WR-T15 — normalizeMarkdown basic
// ---------------------------------------------------------------------------

describe('normalizeMarkdown basic', () => {
  it('converts CommonMark headers and bold to MarkdownV2', () => {
    assert.equal(
      workerReplyMod.normalizeMarkdown('## Title\n\n**bold** text'),
      '*Title*\n\n*bold* text'
    );
  });
});

// ---------------------------------------------------------------------------
// WR-T16 — buildWorkerErrorResponse
// ---------------------------------------------------------------------------

describe('buildWorkerErrorResponse', () => {
  it('formats a worker failure with exit code and suggested worker', () => {
    const result = workerReplyMod.buildWorkerErrorResponse({ worker: 'claude', exitCode: 1, stderr: 'error here', suggestedWorker: 'agy' });
    assert.ok(result.startsWith('⚠️ claude failed (exit 1).'));
    assert.ok(result.includes('Try again, or switch with /agent agy.'));
  });
});

// ---------------------------------------------------------------------------
// sanitizeSuggestedItems pins (AI-234 chip plain-language guard)
// ---------------------------------------------------------------------------

describe('sanitizeSuggestedItems', () => {
  it('keeps plain-language chips within the cap', () => {
    const result = workerReplyMod.sanitizeSuggestedItems(['Reply yes', 'Reply no', 'Skip for now', 'Try again']);
    assert.equal(result.length, 4);
    assert.deepEqual(result, ['Reply yes', 'Reply no', 'Skip for now', 'Try again']);
  });
  it('drops chips with code symbols (backticks, braces, URLs)', () => {
    const result = workerReplyMod.sanitizeSuggestedItems(['Plain text', '`code`', 'has{braces}', 'http://link', 'normal']);
    assert.ok(result.includes('Plain text'));
    assert.ok(result.includes('normal'));
    assert.ok(!result.includes('`code`'));
    assert.ok(!result.includes('has{braces}'));
    assert.ok(!result.includes('http://link'));
  });
  it('drops chips exceeding the label max length', () => {
    const longLabel = 'A'.repeat(workerReplyMod.SUGGESTED_ITEM_LABEL_MAX + 1);
    const result = workerReplyMod.sanitizeSuggestedItems(['ok', longLabel]);
    assert.deepEqual(result, ['ok']);
  });
  it('caps at SUGGESTED_ITEM_MAX', () => {
    const items = ['one', 'two', 'three', 'four', 'five', 'six'];
    const result = workerReplyMod.sanitizeSuggestedItems(items);
    assert.equal(result.length, workerReplyMod.SUGGESTED_ITEM_MAX);
  });
  it('returns empty array for non-array input', () => {
    assert.deepEqual(workerReplyMod.sanitizeSuggestedItems(undefined), []);
    assert.deepEqual(workerReplyMod.sanitizeSuggestedItems('not an array'), []);
  });
});
