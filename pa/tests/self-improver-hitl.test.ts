import './test-env-guard.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectHitlMessages, HITL_MESSAGE_CAP } from '../src/self-improver.js';
import type { ReportEntry } from '../src/self-improver.js';

// WP-P1 (2026-08-24, plans/2026-08-24-buttons-program-SPEC.md §WP-P1): unit tests for the
// selection logic behind the self-improver's post-report HITL keyboard sends. `main()` itself
// is not exercised here (it drives real notifyUser sends and the whole nightly pipeline) —
// selectHitlMessages is a pure, exported helper extracted specifically so this logic is
// testable without running main(), per the spec's own fallback instruction.

function applied(overrides: Partial<ReportEntry> = {}): ReportEntry {
  return {
    name: 'fix-a',
    sourceType: 'failure',
    outcome: 'applied-fix',
    reason: 'elevated failure rate',
    riskFlags: ['critical-skill'],
    ts: '2026-08-24T01:00:00.000Z',
    ...overrides,
  };
}

describe('selectHitlMessages — risk-flagged applied changes', () => {
  it('selects an applied-fix entry with a high-risk flag and a known ts', () => {
    const entry = applied();
    const { messages, totalEligible } = selectHitlMessages([entry]);
    assert.equal(totalEligible, 1);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, 'risk-flagged');
    assert.equal(messages[0].entry, entry);
  });

  it('selects approved-new-skill and applied-code-fix outcomes too', () => {
    const e1 = applied({ name: 'new-skill', outcome: 'approved-new-skill', riskFlags: ['declares-secrets'] });
    const e2 = applied({ name: 'code-fix', outcome: 'applied-code-fix', riskFlags: ['critical-skill'] });
    const { messages } = selectHitlMessages([e1, e2]);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map((m) => m.entry.name).sort(), ['code-fix', 'new-skill']);
  });

  it('excludes an entry with no risk flags', () => {
    const entry = applied({ riskFlags: [] });
    assert.deepEqual(selectHitlMessages([entry]), { messages: [], totalEligible: 0 });
  });

  it('excludes an entry whose risk flags are all low-risk', () => {
    const entry = applied({ riskFlags: ['minor-style'] });
    assert.deepEqual(selectHitlMessages([entry]), { messages: [], totalEligible: 0 });
  });

  it('excludes an entry missing riskFlags entirely', () => {
    const entry = applied({ riskFlags: undefined });
    assert.deepEqual(selectHitlMessages([entry]), { messages: [], totalEligible: 0 });
  });

  it('excludes a risk-flagged entry with no ts — never invents an audit id', () => {
    const entry = applied({ ts: undefined });
    assert.deepEqual(selectHitlMessages([entry]), { messages: [], totalEligible: 0 });
  });

  it('excludes a non-applied outcome (e.g. blocked-protected) even with risk flags', () => {
    const entry = applied({ outcome: 'blocked-protected' });
    assert.deepEqual(selectHitlMessages([entry]), { messages: [], totalEligible: 0 });
  });

  it('excludes skipped/auto-rejected/code-fix-skipped outcomes', () => {
    const outcomes: ReportEntry['outcome'][] = [
      'skipped-cooldown',
      'skipped-duplicate-pending',
      'auto-rejected-cmd-target',
      'code-fix-reverted',
      'code-fix-skipped-limit-reached',
    ];
    for (const outcome of outcomes) {
      const entry = applied({ outcome });
      assert.deepEqual(selectHitlMessages([entry]), { messages: [], totalEligible: 0 }, `outcome=${outcome}`);
    }
  });
});

describe('selectHitlMessages — pending drafts', () => {
  function pending(overrides: Partial<ReportEntry> = {}): ReportEntry {
    return {
      name: 'draft-b',
      sourceType: 'conversation',
      outcome: 'validation-failed-pending',
      reason: 'dry run did not succeed',
      ...overrides,
    };
  }

  it('selects a pending draft with a valid callback-safe name', () => {
    const entry = pending();
    const { messages, totalEligible } = selectHitlMessages([entry]);
    assert.equal(totalEligible, 1);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, 'pending-draft');
    assert.equal(messages[0].entry, entry);
  });

  it('excludes a pending draft whose name is over the 40-char callback budget', () => {
    const entry = pending({ name: 'a'.repeat(41) });
    assert.deepEqual(selectHitlMessages([entry]), { messages: [], totalEligible: 0 });
  });

  it('excludes a pending draft whose name contains a colon (breaks the dr: grammar)', () => {
    const entry = pending({ name: 'bad:name' });
    assert.deepEqual(selectHitlMessages([entry]), { messages: [], totalEligible: 0 });
  });

  it('does not require risk flags or a ts — validation-failed-pending entries carry neither', () => {
    const entry = pending({ riskFlags: undefined, ts: undefined });
    const { messages } = selectHitlMessages([entry]);
    assert.equal(messages.length, 1);
  });
});

describe('selectHitlMessages — combined ordering and cap', () => {
  it('orders risk-flagged messages before pending-draft messages', () => {
    const draft = { name: 'draft-x', sourceType: 'conversation' as const, outcome: 'validation-failed-pending' as const, reason: 'r' };
    const risky = applied({ name: 'risky-x' });
    const { messages } = selectHitlMessages([draft, risky]); // input order: draft first
    assert.deepEqual(messages.map((m) => m.kind), ['risk-flagged', 'pending-draft']);
  });

  it(`caps the combined total at HITL_MESSAGE_CAP (${HITL_MESSAGE_CAP}) and reports totalEligible honestly`, () => {
    const entries: ReportEntry[] = [];
    for (let i = 0; i < HITL_MESSAGE_CAP + 3; i++) {
      entries.push(applied({ name: `risky-${i}`, ts: `2026-08-24T01:00:${String(i).padStart(2, '0')}.000Z` }));
    }
    const { messages, totalEligible } = selectHitlMessages(entries);
    assert.equal(totalEligible, HITL_MESSAGE_CAP + 3);
    assert.equal(messages.length, HITL_MESSAGE_CAP);
  });

  it('the cap is shared across both kinds, not applied per kind', () => {
    const entries: ReportEntry[] = [];
    for (let i = 0; i < HITL_MESSAGE_CAP; i++) {
      entries.push(applied({ name: `risky-${i}`, ts: `2026-08-24T01:00:${String(i).padStart(2, '0')}.000Z` }));
    }
    entries.push({ name: 'draft-overflow', sourceType: 'conversation', outcome: 'validation-failed-pending', reason: 'r' });
    const { messages, totalEligible } = selectHitlMessages(entries);
    assert.equal(totalEligible, HITL_MESSAGE_CAP + 1);
    assert.equal(messages.length, HITL_MESSAGE_CAP);
    assert.ok(messages.every((m) => m.kind === 'risk-flagged'), 'the draft is pushed out by the cap since risk-flagged entries are ordered first');
  });

  it('returns an empty selection for an empty entries array', () => {
    assert.deepEqual(selectHitlMessages([]), { messages: [], totalEligible: 0 });
  });
});
