import './test-env-guard.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectHitlMessages, HITL_MESSAGE_CAP, buildReport, selectFamilyMessages, buildFamilyKeyboard, buildFamilyMessageBody } from '../src/self-improver.js';
import type { ReportEntry } from '../src/self-improver.js';
import type { AlertCensus, CensusFamily } from '../src/lib/alert-census.js';

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

// --- WP-D2 B.4/B.5 (2026-09-02, plans/2026-09-02-topic-handover-WAVE2-SPEC.md §3.4):
// per-family Operator-action / Alert-hygiene messages with the si: mute keyboard.
describe('selectFamilyMessages — WP-D2 per-family sends', () => {
  function family(overrides: Partial<CensusFamily> = {}): CensusFamily {
    return {
      family: 'bg-leak',
      subjectSample: 'sample subject',
      sent: 12,
      suppressed: 0,
      other: 0,
      firstSeen: '2026-08-25T00:00:00.000Z',
      lastSeen: '2026-09-01T00:00:00.000Z',
      ownerKind: 'skill',
      owner: 'beepkart-followup',
      distinctBodies: 1,
      classification: 'repeat-unchanged',
      ...overrides,
    };
  }

  function census(families: CensusFamily[], generatedAt = '2026-09-02T00:00:00.000Z'): AlertCensus {
    return {
      generatedAt,
      windowDays: 7,
      since: '2026-08-26T00:00:00.000Z',
      until: generatedAt,
      totalSent: families.reduce((n, f) => n + f.sent, 0),
      totalSuppressed: 0,
      sentPerDay: {},
      families,
      maskedFailures: [],
      topLine: `${families.length} families`,
    };
  }

  it('operator action families get per-family message with reauth button', () => {
    const oauth = family({
      family: 'google-oauth-invalid_grant',
      classification: 'human-gated',
      ownerStatus: { status: 'error', consecutiveFailures: 5, lastError: 'invalid_grant: Token has been expired or revoked.' },
    });
    const [msg] = selectFamilyMessages(census([oauth]));
    assert.ok(msg);
    assert.equal(msg.section, 'operator-action');
    assert.equal(msg.oauthReauth, true);
    assert.equal(msg.canMute, true);
    assert.equal(msg.ageDays, 8);

    const kb = buildFamilyKeyboard(msg);
    assert.ok(kb);
    assert.deepEqual(kb.inline_keyboard, [[
      { text: '🔐 Reauth', callback_data: 'reauth:google' },
      { text: '🔇 Mute alerts', callback_data: 'si:google-oauth-invalid_grant:m' },
    ]]);
    const body = buildFamilyMessageBody(msg);
    assert.ok(body.includes('google-oauth-invalid_grant'));
    assert.ok(body.includes('8d old'));
    assert.ok(body.includes('invalid_grant'));
    assert.ok(body.includes('pa fix google-oauth-invalid_grant'));
  });

  it('alert hygiene families get mute button', () => {
    const hygiene = family({ family: 'bg-leak', classification: 'repeat-unchanged' });
    const messages = selectFamilyMessages(census([hygiene]));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].section, 'alert-hygiene');
    assert.equal(messages[0].oauthReauth, false, 'hygiene families never get the reauth button');
    const kb = buildFamilyKeyboard(messages[0]);
    assert.ok(kb);
    assert.deepEqual(kb.inline_keyboard, [[
      { text: '🔇 Mute (fix-record)', callback_data: 'si:bg-leak:m' },
    ]]);
  });

  it('alert hygiene prose names pa fix', () => {
    const report = buildReport([], [], 0, 0, census([family({ classification: 'repeat-unchanged', sent: 30, distinctBodies: 2 })]));
    assert.ok(report.includes('mute via button or `pa fix`'));
    assert.ok(!report.includes('escalate / merge'), 'the retired prose must be gone');
  });

  it('a non-OAuth human-gated family gets the mute button but no reauth button', () => {
    const license = family({
      family: 'valid-license-missing',
      classification: 'human-gated',
      bodySample: 'valid license not found — tool disabled',
    });
    const [msg] = selectFamilyMessages(census([license]));
    assert.equal(msg.section, 'operator-action');
    assert.equal(msg.oauthReauth, false);
    assert.deepEqual(buildFamilyKeyboard(msg)?.inline_keyboard, [[
      { text: '🔇 Mute alerts', callback_data: 'si:valid-license-missing:m' },
    ]]);
  });

  it('each section is capped at 3, newest first, suppressed families excluded', () => {
    const families: CensusFamily[] = [];
    for (let i = 0; i < 5; i++) {
      families.push(family({
        family: `hyg-${i}`,
        firstSeen: `2026-08-2${i}T00:00:00.000Z`,
      }));
    }
    for (let i = 0; i < 4; i++) {
      families.push(family({
        family: `gate-${i}`,
        classification: 'human-gated',
        firstSeen: `2026-08-1${i}T00:00:00.000Z`,
      }));
    }
    // suppressed families must never be selected, even newest
    families.push(family({ family: 'gate-newest-but-suppressed', classification: 'human-gated', firstSeen: '2026-09-01T00:00:00.000Z', suppressedBy: 'fix-record' }));
    const messages = selectFamilyMessages(census(families));
    const op = messages.filter((m) => m.section === 'operator-action');
    const hyg = messages.filter((m) => m.section === 'alert-hygiene');
    assert.equal(op.length, 3);
    assert.equal(hyg.length, 3);
    assert.deepEqual(op.map((m) => m.family.family), ['gate-3', 'gate-2', 'gate-1']);
    assert.deepEqual(hyg.map((m) => m.family.family), ['hyg-4', 'hyg-3', 'hyg-2']);
  });

  it('a family outside the si: charset gets no button at all', () => {
    const [msg] = selectFamilyMessages(census([family({ family: 'has space' as CensusFamily['family'] })]));
    assert.equal(msg.canMute, false);
    assert.equal(buildFamilyKeyboard(msg), undefined);
  });

  it('no census means no messages', () => {
    assert.deepEqual(selectFamilyMessages(undefined), []);
  });
});
