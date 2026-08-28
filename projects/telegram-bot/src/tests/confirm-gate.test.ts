import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { consumeConfirmation, resolveConfirmation } from '../logic.js';
import type { ConversationState } from '../types.js';

// consumeConfirmation / resolveConfirmation (2026-08-24 buttons program, WP-B0,
// plans/2026-08-24-buttons-program-SPEC.md correction 3 + §3.1 R2).
//
// consumeConfirmation is the fix for a real bug: resolveConfirmation's own comment
// ("Leave pending_action intact — main.ts clears it before dispatch") was never true —
// main.ts never cleared it, so a second "yes" (typed, tapped, or 👍'd) inside the 5-min
// TTL re-ran the same confirmed action. WP-B1 wires consumeConfirmation into main.ts;
// this file only proves the pure logic.

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return { chat_id: 1, last_update_id: 0, thread_id: 0, turns: [], ...overrides };
}

function withPending(description: string, ageMs = 0): ConversationState {
  const state = makeState();
  state.pending_action = {
    description,
    proposed_at: new Date(Date.now() - ageMs).toISOString(),
  };
  return state;
}

describe('consumeConfirmation', () => {
  it('returns the description and clears pending_action', () => {
    const state = withPending('send email');
    const desc = consumeConfirmation(state);
    assert.equal(desc, 'send email');
    assert.equal(state.pending_action, undefined);
  });

  it('a second call on the same (now-cleared) state returns undefined', () => {
    const state = withPending('run skill');
    const first = consumeConfirmation(state);
    assert.equal(first, 'run skill');
    const second = consumeConfirmation(state);
    assert.equal(second, undefined);
    assert.equal(state.pending_action, undefined);
  });

  it('returns undefined when there was never a pending_action', () => {
    const state = makeState();
    assert.equal(consumeConfirmation(state), undefined);
    assert.equal(state.pending_action, undefined);
  });

  it('preserves the message_id anchor only via the return value — the field itself is gone after consuming', () => {
    const state = withPending('archive emails');
    state.pending_action!.message_id = 4242;
    const desc = consumeConfirmation(state);
    assert.equal(desc, 'archive emails');
    assert.equal(state.pending_action, undefined, 'the whole pending_action, message_id included, is cleared');
  });
});

describe('resolveConfirmation unchanged behaviour (regression guard for WP-B0 edits)', () => {
  it('"no" skips worker, returns Cancelled., and clears pending_action', () => {
    const state = withPending('send email');
    const result = resolveConfirmation(state, 'no');
    assert.equal(result.skipWorker, true);
    assert.equal(result.response, 'Cancelled.');
    assert.equal(state.pending_action, undefined);
  });

  it('"yes" does NOT skip worker, returns an empty response, and leaves pending_action set at that point (consumeConfirmation is the caller\'s job)', () => {
    const state = withPending('run skill');
    const result = resolveConfirmation(state, 'yes');
    assert.equal(result.skipWorker, false);
    assert.equal(result.response, '');
    assert.ok(state.pending_action, 'pending_action must still be set immediately after resolveConfirmation — main.ts calls consumeConfirmation next');
    assert.equal(state.pending_action!.description, 'run skill');
  });

  it('a 30-char unrelated message clears pending_action and does not skip the worker', () => {
    const state = withPending('archive old newsletters');
    const unrelated = 'actually can you check the weather'.slice(0, 30);
    assert.equal(unrelated.length, 30);
    const result = resolveConfirmation(state, unrelated);
    assert.equal(result.skipWorker, false);
    assert.equal(result.response, '');
    assert.equal(state.pending_action, undefined);
  });
});
