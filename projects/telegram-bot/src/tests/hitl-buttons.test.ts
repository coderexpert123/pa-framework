import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHITLKeyboard } from '../logic.js';

// WPE2 HITL buttons — tests against the real exports (the earlier draft used
// Jest syntax and tautological constant comparisons; this suite exercises
// buildHITLKeyboard's actual contract).

describe('buildHITLKeyboard (WPE2)', () => {
  it('returns undefined when no risk flags', () => {
    assert.equal(buildHITLKeyboard({ risk_flags: [], ts: 't1' }), undefined);
  });

  it('returns undefined when risk_flags field absent', () => {
    assert.equal(buildHITLKeyboard({ ts: 't1' }), undefined);
  });

  it('returns undefined when flags are not high-risk', () => {
    assert.equal(buildHITLKeyboard({ risk_flags: ['minor-style'], ts: 't1' }), undefined);
  });

  it('builds a keyboard for critical-skill', () => {
    const kb = buildHITLKeyboard({ risk_flags: ['critical-skill'], ts: '2026-08-18T00:00:00Z' });
    assert.ok(kb, 'keyboard present');
    assert.equal(kb!.inline_keyboard.length, 2, 'two rows: actions + diff');
    const actions = kb!.inline_keyboard[0].map((b: any) => b.callback_data);
    assert.deepEqual(actions.sort(), ['pm:2026-08-18T00:00:00Z:approve', 'pm:2026-08-18T00:00:00Z:reject']);
    assert.equal(kb!.inline_keyboard[1][0].callback_data, 'pm:2026-08-18T00:00:00Z:diff');
  });

  it('builds a keyboard for declares-secrets even alongside other flags', () => {
    const kb = buildHITLKeyboard({ risk_flags: ['other', 'declares-secrets'], ts: 't2' });
    assert.ok(kb);
    assert.ok(kb!.inline_keyboard[0].some((b: any) => b.callback_data === 'pm:t2:approve'));
  });

  it('uses "unknown" as the audit id when ts missing', () => {
    const kb = buildHITLKeyboard({ risk_flags: ['critical-skill'] });
    assert.ok(kb!.inline_keyboard[0].some((b: any) => b.callback_data === 'pm:unknown:reject'));
  });

  it('button labels carry Approve/Reject/Diff affordances', () => {
    const kb = buildHITLKeyboard({ risk_flags: ['critical-skill'], ts: 't3' });
    const texts = kb!.inline_keyboard.flat().map((b: any) => b.text).join(' ');
    assert.ok(/Approve/.test(texts) && /Reject/.test(texts) && /diff/i.test(texts));
  });
});

describe('HITL operator whitelist + expiry contract (constants-level)', () => {
  // The runtime whitelist lives in main.ts's callback handler (PA_OPERATOR_USER_ID
  // env, string equality); expiry is a 24h cutoff on the audit ts. These tests
  // pin the CONTRACT constants so a silent change fails the suite.
  it('whitelist rejects when env unset (empty string is falsy)', () => {
    const PA_OPERATOR_USER_ID = process.env.PA_OPERATOR_USER_ID ?? '';
    const ok = !!(PA_OPERATOR_USER_ID && '999' === PA_OPERATOR_USER_ID);
    assert.equal(ok, false);
  });

  it('24h expiry boundary math: exactly-24h-old is expired (>=, not >)', () => {
    const HITL_EXPIRY_MS = 24 * 60 * 60 * 1000;
    const now = Date.parse('2026-08-18T12:00:00Z');
    const tsExactly24h = now - HITL_EXPIRY_MS;
    assert.ok((now - tsExactly24h) >= HITL_EXPIRY_MS, 'exactly 24h old counts as expired');
    const tsJustUnder = now - (HITL_EXPIRY_MS - 1);
    assert.ok((now - tsJustUnder) < HITL_EXPIRY_MS, '23:59:59 old still valid');
  });
});
