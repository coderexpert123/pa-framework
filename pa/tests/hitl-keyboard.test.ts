import './test-env-guard.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHITLKeyboard, buildDraftKeyboard } from '../src/lib/hitl-keyboard.js';

// WP-P1 (2026-08-24, the buttons-program spec pre-work P5): pa's canonical
// hitl-keyboard.ts is a verbatim move of the bot's projects/telegram-bot/src/logic.ts builder.
// Its output must stay byte-identical to the bot's own — this file and the bot's
// projects/telegram-bot/src/tests/hitl-buttons.test.ts assert the SAME exact callback strings
// for the SAME inputs; that duplication IS the drift alarm the spec calls for (§WP-P1, §7).

describe('buildHITLKeyboard (byte-identical to bot logic.ts, spec P5)', () => {
  it('builds the exact three pm: callback strings for a critical-skill record', () => {
    const kb = buildHITLKeyboard({ risk_flags: ['critical-skill'], ts: '2026-08-18T00:00:00Z' });
    assert.ok(kb, 'keyboard present');
    assert.equal(kb!.inline_keyboard.length, 2, 'two rows: actions + diff');
    const actions = kb!.inline_keyboard[0].map((b) => b.callback_data);
    assert.deepEqual(actions.sort(), ['pm:2026-08-18T00:00:00Z:approve', 'pm:2026-08-18T00:00:00Z:reject']);
    assert.equal(kb!.inline_keyboard[1][0].callback_data, 'pm:2026-08-18T00:00:00Z:diff');
  });

  it('builds a keyboard for declares-secrets even alongside other flags', () => {
    const kb = buildHITLKeyboard({ risk_flags: ['other', 'declares-secrets'], ts: 't2' });
    assert.ok(kb);
    assert.ok(kb!.inline_keyboard[0].some((b) => b.callback_data === 'pm:t2:approve'));
  });

  it('returns undefined when risk_flags is absent', () => {
    assert.equal(buildHITLKeyboard({ ts: 't1' }), undefined);
  });

  it('returns undefined when risk_flags is empty', () => {
    assert.equal(buildHITLKeyboard({ risk_flags: [], ts: 't1' }), undefined);
  });

  it('returns undefined for low-risk flags only', () => {
    assert.equal(buildHITLKeyboard({ risk_flags: ['minor-style'], ts: 't1' }), undefined);
  });

  it("uses 'unknown' as the audit id when ts is missing (mirrors bot behaviour)", () => {
    const kb = buildHITLKeyboard({ risk_flags: ['critical-skill'] });
    assert.ok(kb!.inline_keyboard[0].some((b) => b.callback_data === 'pm:unknown:reject'));
  });
});

describe('buildDraftKeyboard', () => {
  it('emits the exact three dr: callback strings', () => {
    const kb = buildDraftKeyboard('my-draft-1');
    assert.ok(kb, 'keyboard present');
    assert.deepEqual(kb, {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: 'dr:my-draft-1:approve' },
          { text: '❌ Reject', callback_data: 'dr:my-draft-1:reject' },
        ],
        [{ text: '📄 Show', callback_data: 'dr:my-draft-1:show' }],
      ],
    });
  });

  it('accepts a name at exactly the 40-char budget', () => {
    const name = 'a'.repeat(40);
    const kb = buildDraftKeyboard(name);
    assert.ok(kb);
    assert.equal(kb!.inline_keyboard[0][0].callback_data, `dr:${name}:approve`);
  });

  it('returns undefined for a 41-char name (over the 40-char budget)', () => {
    assert.equal(buildDraftKeyboard('a'.repeat(41)), undefined);
  });

  it('returns undefined for a name containing a colon', () => {
    assert.equal(buildDraftKeyboard('bad:name'), undefined);
  });

  it('returns undefined for an empty name', () => {
    assert.equal(buildDraftKeyboard(''), undefined);
  });
});
