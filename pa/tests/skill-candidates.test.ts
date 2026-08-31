import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'fs/promises';
import {
  loadAnalyzerState,
  saveAnalyzerState,
  loadCandidates,
  saveCandidates,
  upsertCandidate,
  eligibleCandidates,
  analyzerStatePath,
  skillCandidatesPath,
  ANALYZER_STATE_VERSION,
  SKILL_CANDIDATES_VERSION,
  SKILL_CANDIDATE_MIN_DAYS,
  SKILL_CANDIDATE_REPROPOSE_MS,
} from '../src/lib/skill-candidates.js';
import type { SkillCandidate, SkillCandidateLedger, CandidateTurnRef } from '../src/lib/skill-candidates.js';
import { createTempPaHome, cleanup } from './helpers.js';

function makeRef(overrides: Partial<CandidateTurnRef> = {}): CandidateTurnRef {
  return { thread_id: 100, message_id: 1, ts: '2026-08-01T09:00:00.000Z', ...overrides };
}

function emptyLedger(): SkillCandidateLedger {
  return { version: SKILL_CANDIDATES_VERSION, candidates: {} };
}

describe('skill-candidates', () => {
  let dir: string;

  before(async () => {
    dir = await createTempPaHome();
  });

  after(async () => {
    await cleanup(dir);
  });

  describe('upsertCandidate', () => {
    it('creates a new candidate on the first hit', () => {
      const ledger = upsertCandidate(emptyLedger(), {
        key: 'email-summary',
        intent: 'summarize unread emails',
        ref: makeRef(),
      });
      const c = ledger.candidates['email-summary'];
      assert.ok(c);
      assert.equal(c.count, 1);
      assert.deepEqual(c.days, ['2026-08-01']);
      assert.equal(c.turn_refs.length, 1);
      assert.equal(c.first_seen, '2026-08-01T09:00:00.000Z');
      assert.equal(c.last_seen, '2026-08-01T09:00:00.000Z');
      assert.equal(c.origin, 'analyzer');
      assert.equal(c.proposed_at, null);
      assert.equal(c.draft_id, null);
    });

    it('increments count on a repeat hit', () => {
      let ledger = upsertCandidate(emptyLedger(), { key: 'k', intent: 'i', ref: makeRef() });
      ledger = upsertCandidate(ledger, { key: 'k', intent: 'i', ref: makeRef({ ts: '2026-08-02T09:00:00.000Z', message_id: 2 }) });
      assert.equal(ledger.candidates['k'].count, 2);
    });

    it('unions days without duplicating a same-day hit', () => {
      let ledger = upsertCandidate(emptyLedger(), { key: 'k', intent: 'i', ref: makeRef({ ts: '2026-08-01T09:00:00.000Z' }) });
      ledger = upsertCandidate(ledger, { key: 'k', intent: 'i', ref: makeRef({ ts: '2026-08-01T15:00:00.000Z', message_id: 2 }) });
      assert.deepEqual(ledger.candidates['k'].days, ['2026-08-01']);
      assert.equal(ledger.candidates['k'].count, 2);

      ledger = upsertCandidate(ledger, { key: 'k', intent: 'i', ref: makeRef({ ts: '2026-08-02T09:00:00.000Z', message_id: 3 }) });
      assert.deepEqual(ledger.candidates['k'].days, ['2026-08-01', '2026-08-02']);
    });

    it('caps turn_refs at 20, keeping the newest', () => {
      let ledger = emptyLedger();
      for (let i = 1; i <= 25; i++) {
        ledger = upsertCandidate(ledger, {
          key: 'k',
          intent: 'i',
          ref: makeRef({ ts: `2026-08-${String(i).padStart(2, '0')}T09:00:00.000Z`, message_id: i }),
        });
      }
      const refs = ledger.candidates['k'].turn_refs;
      assert.equal(refs.length, 20);
      // Newest kept: message_ids 6..25 survive, 1..5 were evicted.
      assert.equal(refs[0].message_id, 6);
      assert.equal(refs[refs.length - 1].message_id, 25);
    });

    it('preserves first_seen across repeat hits', () => {
      let ledger = upsertCandidate(emptyLedger(), { key: 'k', intent: 'i', ref: makeRef({ ts: '2026-08-01T09:00:00.000Z' }) });
      ledger = upsertCandidate(ledger, { key: 'k', intent: 'i', ref: makeRef({ ts: '2026-08-05T09:00:00.000Z', message_id: 2 }) });
      assert.equal(ledger.candidates['k'].first_seen, '2026-08-01T09:00:00.000Z');
      assert.equal(ledger.candidates['k'].last_seen, '2026-08-05T09:00:00.000Z');
    });
  });

  describe('eligibleCandidates', () => {
    function candidateWith(overrides: Partial<SkillCandidate>): SkillCandidate {
      return {
        key: 'k', intent: 'i', count: 1, days: ['2026-08-01', '2026-08-02', '2026-08-03'],
        turn_refs: [], first_seen: '2026-08-01T00:00:00.000Z', last_seen: '2026-08-03T00:00:00.000Z',
        origin: 'analyzer', proposed_at: null, draft_id: null,
        ...overrides,
      };
    }

    it('excludes a candidate with fewer than SKILL_CANDIDATE_MIN_DAYS distinct days', () => {
      const ledger: SkillCandidateLedger = {
        version: SKILL_CANDIDATES_VERSION,
        candidates: { k: candidateWith({ days: ['2026-08-01', '2026-08-02'] }) },
      };
      assert.equal(ledger.candidates['k'].days.length < SKILL_CANDIDATE_MIN_DAYS, true);
      const result = eligibleCandidates(ledger, { nowMs: Date.parse('2026-08-10T00:00:00.000Z'), existingSkillNames: [], existingDraftNames: [] });
      assert.deepEqual(result, []);
    });

    it('excludes a candidate with a draft_id', () => {
      const ledger: SkillCandidateLedger = { version: SKILL_CANDIDATES_VERSION, candidates: { k: candidateWith({ draft_id: 'some-draft' }) } };
      const result = eligibleCandidates(ledger, { nowMs: Date.parse('2026-08-10T00:00:00.000Z'), existingSkillNames: [], existingDraftNames: [] });
      assert.deepEqual(result, []);
    });

    it('excludes a key proposed 13 days ago and includes one proposed 15 days ago', () => {
      const now = Date.parse('2026-08-24T00:00:00.000Z');
      const ledger: SkillCandidateLedger = {
        version: SKILL_CANDIDATES_VERSION,
        candidates: {
          'recent-proposal': candidateWith({ key: 'recent-proposal', proposed_at: new Date(now - 13 * 24 * 60 * 60 * 1000).toISOString() }),
          'old-proposal': candidateWith({ key: 'old-proposal', proposed_at: new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString() }),
        },
      };
      const result = eligibleCandidates(ledger, { nowMs: now, existingSkillNames: [], existingDraftNames: [] });
      const keys = result.map((c) => c.key);
      assert.ok(!keys.includes('recent-proposal'));
      assert.ok(keys.includes('old-proposal'));
      assert.equal(SKILL_CANDIDATE_REPROPOSE_MS, 14 * 24 * 60 * 60_000);
    });

    it('excludes a key matching an existing skill or draft name, case-insensitively', () => {
      const ledger: SkillCandidateLedger = {
        version: SKILL_CANDIDATES_VERSION,
        candidates: {
          'daily-mail-brief': candidateWith({ key: 'daily-mail-brief' }),
          'my-draft': candidateWith({ key: 'my-draft' }),
          'fresh-key': candidateWith({ key: 'fresh-key' }),
        },
      };
      const result = eligibleCandidates(ledger, {
        nowMs: Date.parse('2026-08-10T00:00:00.000Z'),
        existingSkillNames: ['Daily-Mail-Brief'],
        existingDraftNames: ['MY-DRAFT'],
      });
      const keys = result.map((c) => c.key);
      assert.deepEqual(keys, ['fresh-key']);
    });

    it('sorts eligible candidates most-recent-first', () => {
      const ledger: SkillCandidateLedger = {
        version: SKILL_CANDIDATES_VERSION,
        candidates: {
          older: candidateWith({ key: 'older', last_seen: '2026-08-01T00:00:00.000Z' }),
          newer: candidateWith({ key: 'newer', last_seen: '2026-08-05T00:00:00.000Z' }),
        },
      };
      const result = eligibleCandidates(ledger, { nowMs: Date.parse('2026-08-10T00:00:00.000Z'), existingSkillNames: [], existingDraftNames: [] });
      assert.deepEqual(result.map((c) => c.key), ['newer', 'older']);
    });
  });

  describe('load/save round-trip', () => {
    it('loadAnalyzerState/saveAnalyzerState round-trips under a temp PA_HOME', async () => {
      const state = { version: ANALYZER_STATE_VERSION, covers_through: '2026-08-01T00:00:00.000Z', last_run_at: '2026-08-02T00:00:00.000Z', backfilled: true };
      await saveAnalyzerState(state);
      const loaded = await loadAnalyzerState();
      assert.deepEqual(loaded, state);
    });

    it('loadCandidates/saveCandidates round-trips under a temp PA_HOME', async () => {
      const ledger = upsertCandidate(emptyLedger(), { key: 'k', intent: 'i', ref: makeRef() });
      await saveCandidates(ledger);
      const loaded = await loadCandidates();
      assert.deepEqual(loaded, ledger);
    });

    it('a torn analyzer-state.json loads as a fresh default without throwing', async () => {
      await writeFile(analyzerStatePath(), '{not json', 'utf8');
      const state = await loadAnalyzerState();
      assert.deepEqual(state, { version: ANALYZER_STATE_VERSION, covers_through: null, last_run_at: null, backfilled: false });
    });

    it('a torn skill-candidates.json loads as a fresh default without throwing', async () => {
      await writeFile(skillCandidatesPath(), '{not json', 'utf8');
      const ledger = await loadCandidates();
      assert.deepEqual(ledger, { version: SKILL_CANDIDATES_VERSION, candidates: {} });
    });

    it('an absent analyzer-state.json loads as a fresh default without throwing', async () => {
      const missingDir = dir + '-missing-analyzer-state';
      const origHome = process.env.PA_HOME;
      try {
        process.env.PA_HOME = missingDir;
        const state = await loadAnalyzerState();
        assert.deepEqual(state, { version: ANALYZER_STATE_VERSION, covers_through: null, last_run_at: null, backfilled: false });
      } finally {
        process.env.PA_HOME = origHome;
      }
    });

    it('saveAnalyzerState/saveCandidates write real files on disk', async () => {
      await saveAnalyzerState({ version: ANALYZER_STATE_VERSION, covers_through: null, last_run_at: null, backfilled: false });
      const raw = await readFile(analyzerStatePath(), 'utf8');
      assert.ok(JSON.parse(raw));
    });
  });
});
