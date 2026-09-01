/**
 * Decision traces helper tests (AI-164).
 *
 * Tests the TS twin (pa/src/lib/decisions.ts) for:
 * - Schema and FTS
 * - Caps enforcement
 * - Immutability surface
 * - Redaction
 * - Reaction and replied precedence
 * - never-throws guarantee
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { createTempPaHome, cleanup, createTempSecrets } from './helpers.js';
import {
  recordDecision,
  attachDecisionMessage,
  recordReaction,
  markRepliedForThread,
  decisionsDbPath,
  DECISIONS_SCHEMA_SQL,
  decisionStatsBySkill,
  type SkillDecisionStats,
} from '../src/lib/decisions.js';

describe('decisions.ts', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(tempHome);
  });

  function openDbDirect(): Database.Database {
    const dbPath = decisionsDbPath();
    return new Database(dbPath, { readonly: true });
  }

  describe('recordDecision', () => {
    it('inserts a row with valid decision_id format', () => {
      const result = recordDecision({
        source: 'skill',
        skill: 'test-skill',
        request_excerpt: 'Test request',
        decision: 'Test decision',
        rationale: 'Test rationale',
      });

      assert.strictEqual(result.ok, true);
      assert.match(result.decisionId as string, /^d-\d{12}-[0-9a-f]{12}$/);

      const db = openDbDirect();
      const row = db.prepare('SELECT * FROM decisions WHERE decision_id = ?').get(result.decisionId) as any;
      assert(row);
      assert.strictEqual(row.source, 'skill');
      assert.strictEqual(row.skill, 'test-skill');
      assert.strictEqual(row.request_excerpt, 'Test request');
      assert.strictEqual(row.decision, 'Test decision');
      assert.strictEqual(row.rationale, 'Test rationale');
      assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.strictEqual(row.ts, row.updated_at);
      db.close();
    });

    it('creates FTS row', () => {
      const result = recordDecision({
        source: 'bot',
        skill: 'reminders',
        request_excerpt: 'Reminder text',
        decision: 'snoozed 1 h',
        rationale: 'User deferred',
      });

      assert.strictEqual(result.ok, true);

      const db = openDbDirect();
      const ftsCount = db.prepare('SELECT count(*) as c FROM decisions_fts').get() as { c: number };
      assert.strictEqual(ftsCount.c, 1);
      db.close();
    });

    it('enforces caps: request_excerpt 200, decision 500, rationale 1000', () => {
      const longText = 'a'.repeat(1200);
      const result = recordDecision({
        source: 'skill',
        request_excerpt: longText,
        decision: longText,
        rationale: longText,
      });

      assert.strictEqual(result.ok, true);

      const db = openDbDirect();
      const row = db.prepare('SELECT request_excerpt, decision, rationale FROM decisions WHERE decision_id = ?').get(result.decisionId) as any;
      assert.strictEqual(row.request_excerpt.length, 200);
      assert.strictEqual(row.decision.length, 500);
      assert.strictEqual(row.rationale.length, 1000);
      db.close();
    });

    it('enforces alternatives cap: 8 max, each 200 chars', () => {
      const alts = Array.from({ length: 12 }, (_, i) => `Alternative ${i} ${'a'.repeat(250)}`);
      const result = recordDecision({
        source: 'skill',
        request_excerpt: 'Test',
        decision: 'Test',
        rationale: 'Test',
        alternatives: alts,
      });

      assert.strictEqual(result.ok, true);

      const db = openDbDirect();
      const row = db.prepare('SELECT alternatives FROM decisions WHERE decision_id = ?').get(result.decisionId) as any;
      const parsed = JSON.parse(row.alternatives);
      assert.strictEqual(parsed.length, 8);
      for (const alt of parsed) {
        assert.strictEqual(alt.length, 200);
      }
      db.close();
    });

    it('rejects invalid source', () => {
      const result = recordDecision({
        source: 'invalid' as any,
        request_excerpt: 'Test',
        decision: 'Test',
        rationale: 'Test',
      });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'invalid row: source must be skill or bot');
    });

    it('rejects empty required fields after trim', () => {
      const result = recordDecision({
        source: 'skill',
        request_excerpt: '   ',
        decision: 'Test',
        rationale: 'Test',
      });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'invalid row: request_excerpt, decision, and rationale are required');
    });

    it('redacts secrets from decision fields', async () => {
      await createTempSecrets(tempHome, 'TEST_SECRET=verysecretkey123\n');
      // Reset redact cache so it picks up the new secrets
      const { resetRedactCache } = await import('../src/lib/redact.js');
      resetRedactCache();

      const result = recordDecision({
        source: 'skill',
        request_excerpt: 'Request with verysecretkey123',
        decision: 'Decision',
        rationale: 'Rationale with verysecretkey123',
        alternatives: ['Alt with verysecretkey123'],
      });

      assert.strictEqual(result.ok, true);

      const db = openDbDirect();
      const row = db.prepare('SELECT request_excerpt, rationale, alternatives FROM decisions WHERE decision_id = ?').get(result.decisionId) as any;
      assert.match(row.request_excerpt, /<redacted:TEST_SECRET>/);
      assert.match(row.rationale, /<redacted:TEST_SECRET>/);
      const alts = JSON.parse(row.alternatives);
      assert.match(alts[0], /<redacted:TEST_SECRET>/);
      db.close();
    });
  });

  describe('attachDecisionMessage', () => {
    it('fills NULLs once', () => {
      const result = recordDecision({
        source: 'bot',
        skill: 'reminders',
        request_excerpt: 'Test',
        decision: 'Test',
        rationale: 'Test',
      });

      const attach1 = attachDecisionMessage(result.decisionId as string, -1009999999999, 12345);
      assert.strictEqual(attach1.ok, true);
      assert.strictEqual(attach1.matched, 1);

      const db = openDbDirect();
      const row = db.prepare('SELECT chat_id, message_id FROM decisions WHERE decision_id = ?').get(result.decisionId) as any;
      assert.strictEqual(row.chat_id, -1009999999999);
      assert.strictEqual(row.message_id, 12345);

      const attach2 = attachDecisionMessage(result.decisionId as string, -1009999999998, 12346);
      assert.strictEqual(attach2.ok, true);
      assert.strictEqual(attach2.matched, 0);

      const row2 = db.prepare('SELECT chat_id, message_id FROM decisions WHERE decision_id = ?').get(result.decisionId) as any;
      assert.strictEqual(row2.chat_id, -1009999999999);
      assert.strictEqual(row2.message_id, 12345);
      db.close();
    });
  });

  describe('recordReaction', () => {
    it('sets outcome=approved for 👍', async () => {
      const result = recordDecision({
        source: 'bot',
        skill: 'reminders',
        request_excerpt: 'Test',
        decision: 'Test',
        rationale: 'Test',
        chat_id: -1009999999999,
        message_id: 12345,
      });

      // Small delay to ensure timestamp advances
      await new Promise(resolve => setTimeout(resolve, 10));

      const react = recordReaction(-1009999999999, 12345, '👍');
      assert.strictEqual(react.ok, true);
      assert.strictEqual(react.matched, 1);

      const db = openDbDirect();
      const row = db.prepare('SELECT reaction, outcome, updated_at, ts FROM decisions WHERE decision_id = ?').get(result.decisionId) as any;
      assert.strictEqual(row.reaction, '👍');
      assert.strictEqual(row.outcome, 'approved');
      assert.ok(row.updated_at > row.ts, `updated_at (${row.updated_at}) should be > ts (${row.ts})`);
      db.close();
    });

    it('sets outcome=rejected for 👎', () => {
      const result = recordDecision({
        source: 'bot',
        skill: 'reminders',
        request_excerpt: 'Test',
        decision: 'Test',
        rationale: 'Test',
        chat_id: -1009999999999,
        message_id: 12345,
      });

      const react = recordReaction(-1009999999999, 12345, '👎');
      assert.strictEqual(react.ok, true);
      assert.strictEqual(react.matched, 1);

      const db = openDbDirect();
      const row = db.prepare('SELECT reaction, outcome FROM decisions WHERE decision_id = ?').get(result.decisionId) as any;
      assert.strictEqual(row.reaction, '👎');
      assert.strictEqual(row.outcome, 'rejected');
      db.close();
    });

    it('fills reaction only for non-approval emoji', () => {
      const result = recordDecision({
        source: 'bot',
        skill: 'reminders',
        request_excerpt: 'Test',
        decision: 'Test',
        rationale: 'Test',
        chat_id: -1009999999999,
        message_id: 12345,
      });

      const react = recordReaction(-1009999999999, 12345, '❤️');
      assert.strictEqual(react.ok, true);
      assert.strictEqual(react.matched, 1);

      const db = openDbDirect();
      const row = db.prepare('SELECT reaction, outcome FROM decisions WHERE decision_id = ?').get(result.decisionId) as any;
      assert.strictEqual(row.reaction, '❤️');
      assert.strictEqual(row.outcome, null);
      db.close();
    });

    it('non-approval emoji does NOT wipe existing outcome', () => {
      const result = recordDecision({
        source: 'bot',
        skill: 'reminders',
        request_excerpt: 'Test',
        decision: 'Test',
        rationale: 'Test',
        chat_id: -1009999999999,
        message_id: 12346,
      });

      // Seed outcome='replied' via raw SQL
      const dbPath = decisionsDbPath();
      const db = new Database(dbPath);
      db.prepare('UPDATE decisions SET outcome = ? WHERE decision_id = ?').run('replied', result.decisionId);
      db.close();

      // Now apply a non-approval reaction
      const react = recordReaction(-1009999999999, 12346, '❤️');
      assert.strictEqual(react.ok, true);
      assert.strictEqual(react.matched, 1);

      const db2 = openDbDirect();
      const row = db2.prepare('SELECT reaction, outcome FROM decisions WHERE decision_id = ?').get(result.decisionId) as any;
      assert.strictEqual(row.reaction, '❤️');
      assert.strictEqual(row.outcome, 'replied', 'outcome should remain "replied" after non-approval emoji');
      db2.close();
    });

    it('returns matched:0 for no match', () => {
      const react = recordReaction(-1009999999999, 999999, '👍');
      assert.strictEqual(react.ok, true);
      assert.strictEqual(react.matched, 0);
    });

    it('non-approval emoji does NOT wipe an existing outcome (❤️ on a replied row)', () => {
      const result = recordDecision({
        source: 'bot',
        skill: 'reminders',
        request_excerpt: 'Test',
        decision: 'Test',
        rationale: 'Test',
        thread_id: 4242,
        chat_id: -1009999999999,
        message_id: 12346,
      });

      // Mark as replied (weak signal), then react with a non-approval emoji
      markRepliedForThread(-1009999999999, 4242, Date.now());
      const react = recordReaction(-1009999999999, 12346, '❤️');
      assert.strictEqual(react.ok, true);
      assert.strictEqual(react.matched, 1);

      const db = openDbDirect();
      const row = db.prepare('SELECT outcome, reaction FROM decisions WHERE decision_id = ?').get(result.decisionId) as any;
      // §2.3 item 3: any emoji other than 👍/👎 fills reaction ONLY — the
      // existing 'replied' outcome must survive (the outcome-wipe regression).
      assert.strictEqual(row.outcome, 'replied');
      assert.strictEqual(row.reaction, '❤️');
      db.close();
    });

    it('strong overwrites weak: 👎 replaces replied', () => {
      const result = recordDecision({
        source: 'bot',
        skill: 'reminders',
        request_excerpt: 'Test',
        decision: 'Test',
        rationale: 'Test',
        thread_id: 4242,
        chat_id: -1009999999999,
        message_id: 12345,
      });

      // Mark as replied (weak signal)
      markRepliedForThread(-1009999999999, 4242, Date.now());

      // Now 👎 (strong signal)
      const react = recordReaction(-1009999999999, 12345, '👎');
      assert.strictEqual(react.ok, true);
      assert.strictEqual(react.matched, 1);

      const db = openDbDirect();
      const row = db.prepare('SELECT outcome, reaction FROM decisions WHERE decision_id = ?').get(result.decisionId) as any;
      assert.strictEqual(row.outcome, 'rejected');
      assert.strictEqual(row.reaction, '👎');
      db.close();
    });

    it('markRepliedForThread does NOT downgrade a row with reaction', () => {
      const result = recordDecision({
        source: 'bot',
        skill: 'reminders',
        request_excerpt: 'Test',
        decision: 'Test',
        rationale: 'Test',
        thread_id: 4242,
        chat_id: -1009999999999,
        message_id: 12345,
      });

      // Add reaction
      recordReaction(-1009999999999, 12345, '❤️');

      // Try to mark as replied
      const replied = markRepliedForThread(-1009999999999, 4242, Date.now());
      assert.strictEqual(replied.ok, true);
      // This row should be skipped (reaction is not null)
      assert.strictEqual(replied.matched, 0);

      const db = openDbDirect();
      const row = db.prepare('SELECT outcome, reaction FROM decisions WHERE decision_id = ?').get(result.decisionId) as any;
      assert.strictEqual(row.reaction, '❤️');
      assert.strictEqual(row.outcome, null);
      db.close();
    });

    it('multi-row reaction: two rows sharing (chat_id, message_id) both fill', () => {
      const result1 = recordDecision({
        source: 'bot',
        skill: 'reminders',
        request_excerpt: 'Test1',
        decision: 'Test1',
        rationale: 'Test1',
        chat_id: -1009999999999,
        message_id: 12345,
      });

      const result2 = recordDecision({
        source: 'bot',
        skill: 'reminders',
        request_excerpt: 'Test2',
        decision: 'Test2',
        rationale: 'Test2',
        chat_id: -1009999999999,
        message_id: 12345,
      });

      const react = recordReaction(-1009999999999, 12345, '👍');
      assert.strictEqual(react.ok, true);
      assert.strictEqual(react.matched, 2);

      const db = openDbDirect();
      const row1 = db.prepare('SELECT outcome FROM decisions WHERE decision_id = ?').get(result1.decisionId) as any;
      const row2 = db.prepare('SELECT outcome FROM decisions WHERE decision_id = ?').get(result2.decisionId) as any;
      assert.strictEqual(row1.outcome, 'approved');
      assert.strictEqual(row2.outcome, 'approved');
      db.close();
    });
  });

  describe('markRepliedForThread', () => {
    it('fills outcome=replied for NULL-outcome row in same thread within 24h', () => {
      const nowMs = Date.now();
      const result = recordDecision({
        source: 'bot',
        skill: 'reminders',
        request_excerpt: 'Test',
        decision: 'Test',
        rationale: 'Test',
        thread_id: 4242,
        chat_id: -1009999999999,
      });

      const replied = markRepliedForThread(-1009999999999, 4242, nowMs);
      assert.strictEqual(replied.ok, true);
      assert.strictEqual(replied.matched, 1);

      const db = openDbDirect();
      const row = db.prepare('SELECT outcome FROM decisions WHERE decision_id = ?').get(result.decisionId) as any;
      assert.strictEqual(row.outcome, 'replied');
      db.close();
    });

    it('skips 25h-old row', () => {
      const nowMs = Date.now();
      const oldTs = new Date(nowMs - 25 * 60 * 60 * 1000).toISOString();

      const result = recordDecision({
        source: 'bot',
        skill: 'reminders',
        request_excerpt: 'Test',
        decision: 'Test',
        rationale: 'Test',
        thread_id: 4242,
        chat_id: -1009999999999,
      });

      // Manually update ts to be old
      const dbPath = decisionsDbPath();
      const db = new Database(dbPath);
      db.prepare('UPDATE decisions SET ts = ?, updated_at = ? WHERE decision_id = ?').run(oldTs, oldTs, result.decisionId);
      db.close();

      const replied = markRepliedForThread(-1009999999999, 4242, nowMs);
      assert.strictEqual(replied.ok, true);
      assert.strictEqual(replied.matched, 0);
    });

    it('skips row with different chat_id', () => {
      const result = recordDecision({
        source: 'bot',
        skill: 'reminders',
        request_excerpt: 'Test',
        decision: 'Test',
        rationale: 'Test',
        thread_id: 4242,
        chat_id: -1009999999998,
      });

      const replied = markRepliedForThread(-1009999999999, 4242, Date.now());
      assert.strictEqual(replied.ok, true);
      assert.strictEqual(replied.matched, 0);
    });

    it('fills row whose chat_id is NULL but thread_id matches', () => {
      const result = recordDecision({
        source: 'bot',
        skill: 'reminders',
        request_excerpt: 'Test',
        decision: 'Test',
        rationale: 'Test',
        thread_id: 4242,
      });

      const replied = markRepliedForThread(-1009999999999, 4242, Date.now());
      assert.strictEqual(replied.ok, true);
      assert.strictEqual(replied.matched, 1);

      const db = openDbDirect();
      const row = db.prepare('SELECT outcome FROM decisions WHERE decision_id = ?').get(result.decisionId) as any;
      assert.strictEqual(row.outcome, 'replied');
      db.close();
    });
  });

  describe('immutability surface', () => {
    it('exports no function that can alter decision text fields', async () => {
      const decisions = await import('../src/lib/decisions.js');
      const exports = Object.keys(decisions).filter(k => k !== '__esModule' && k !== 'default');

      const allowed = [
        'DECISIONS_SCHEMA_SQL',
        'attachDecisionMessage',
        'decisionStatsBySkill',
        'decisionsDbPath',
        'markRepliedForThread',
        'recordDecision',
        'recordReaction',
      ];

      const sorted = exports.sort();
      const sortedAllowed = allowed.sort();
      assert.deepStrictEqual(sorted, sortedAllowed);
    });
  });

  describe('never-throws guarantee', () => {
    it('returns {ok:false} when DB cannot be created', () => {
      // Create a file where the directory should be
      const badPath = join(tempHome, 'decisions.sqlite');
      // Write to the file to make it exist
      const fs = require('fs');
      fs.writeFileSync(badPath, 'not a directory');

      const result = recordDecision({
        source: 'skill',
        request_excerpt: 'Test',
        decision: 'Test',
        rationale: 'Test',
      });

      assert.strictEqual(result.ok, false);
      assert.ok(result.error !== undefined); // Error message should be present

      // Clean up (may fail if locked, that's ok for this test)
      try {
        fs.unlinkSync(badPath);
      } catch {}
    });
  });

  describe('decisionStatsBySkill', () => {
    it('filters by window: T−40d row excluded from 30d window, included all-time', () => {
      const nowMs = Date.now();
      const oldTs = new Date(nowMs - 40 * 24 * 60 * 60 * 1000).toISOString();

      // Record a decision 40 days ago
      const oldResult = recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-a',
        request_excerpt: 'Old request',
        decision: 'Old decision',
        rationale: 'Old rationale',
      });

      // Manually update ts to be old
      const dbPath = decisionsDbPath();
      const db = new Database(dbPath);
      db.prepare('UPDATE decisions SET ts = ?, updated_at = ? WHERE decision_id = ?').run(oldTs, oldTs, oldResult.decisionId);
      db.close();

      // Record a decision in the window
      recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-a',
        request_excerpt: 'Recent request',
        decision: 'Recent decision',
        rationale: 'Recent rationale',
      });

      // 30d window should include only the recent row
      const windowStart = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
      // Open-ended `to` (defaults to now, computed AFTER the rows exist) — a pinned
      // windowEnd captured before the row was minted excludes it by milliseconds.
      const windowStats = decisionStatsBySkill(windowStart);

      assert.ok(windowStats);
      assert.strictEqual(windowStats.size, 1);
      const stats = windowStats.get('synthetic-skill-a');
      assert.ok(stats);
      assert.strictEqual(stats.total, 1);

      // All-time should include both rows (open end — computed after rows exist)
      const allTimeStats = decisionStatsBySkill('1970-01-01T00:00:00.000Z');
      assert.ok(allTimeStats);
      assert.strictEqual(allTimeStats.size, 1);
      const allTimeSkill = allTimeStats.get('synthetic-skill-a');
      assert.ok(allTimeSkill);
      assert.strictEqual(allTimeSkill.total, 2);
    });

    it('groups by skill with correct counts across outcomes', () => {
      const nowMs = Date.now();

      // Record an approved decision
      const approvedResult = recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-b',
        request_excerpt: 'Approved request',
        decision: 'Approved decision',
        rationale: 'Approved rationale',
        chat_id: -1009999999999,
        message_id: 1,
      });
      recordReaction(-1009999999999, 1, '👍');

      // Record a rejected decision
      const rejectedResult = recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-b',
        request_excerpt: 'Rejected request',
        decision: 'Rejected decision',
        rationale: 'Rejected rationale',
        chat_id: -1009999999999,
        message_id: 2,
      });
      recordReaction(-1009999999999, 2, '👎');

      // Record a replied decision
      const repliedResult = recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-c',
        request_excerpt: 'Replied request',
        decision: 'Replied decision',
        rationale: 'Replied rationale',
        thread_id: 4242,
        chat_id: -1009999999999,
      });
      markRepliedForThread(-1009999999999, 4242, nowMs);

      // Record a pending decision (no outcome, no reaction)
      recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-b',
        request_excerpt: 'Pending request',
        decision: 'Pending decision',
        rationale: 'Pending rationale',
      });

      // Record a non-approval reaction (❤️) ⇒ other_reaction: 1, pending: 1
      const reactionResult = recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-b',
        request_excerpt: 'Reaction request',
        decision: 'Reaction decision',
        rationale: 'Reaction rationale',
        chat_id: -1009999999999,
        message_id: 3,
      });
      recordReaction(-1009999999999, 3, '❤️');

      const windowStart = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
      // Open end — rows minted after nowMs must be inside the window (same
      // millisecond-boundary class as the window-filter test above).
      const stats = decisionStatsBySkill(windowStart);

      assert.ok(stats);
      assert.strictEqual(stats.size, 2);

      // Check synthetic-skill-b: 4 rows (approved, rejected, pending, other_reaction)
      const skillB = stats.get('synthetic-skill-b');
      assert.ok(skillB);
      assert.strictEqual(skillB.skill, 'synthetic-skill-b');
      assert.strictEqual(skillB.total, 4);
      assert.strictEqual(skillB.approved, 1);
      assert.strictEqual(skillB.rejected, 1);
      assert.strictEqual(skillB.replied, 0);
      assert.strictEqual(skillB.pending, 2); // one pending + one other_reaction (still pending)
      assert.strictEqual(skillB.other_reaction, 1); // the ❤️ reaction

      // Check synthetic-skill-c: 1 row (replied)
      const skillC = stats.get('synthetic-skill-c');
      assert.ok(skillC);
      assert.strictEqual(skillC.total, 1);
      assert.strictEqual(skillC.approved, 0);
      assert.strictEqual(skillC.rejected, 0);
      assert.strictEqual(skillC.replied, 1);
      assert.strictEqual(skillC.pending, 0);
      assert.strictEqual(skillC.other_reaction, 0);
    });

    it('excludes NULL-skill rows', () => {
      const nowMs = Date.now();

      // Record a decision with skill
      recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-d',
        request_excerpt: 'With skill',
        decision: 'Decision',
        rationale: 'Rationale',
      });

      // Record a decision without skill (source-only row)
      const noSkillResult = recordDecision({
        source: 'bot',
        request_excerpt: 'No skill',
        decision: 'Decision',
        rationale: 'Rationale',
      });

      // Manually set skill to NULL (bypassing the API's default)
      const dbPath = decisionsDbPath();
      const db = new Database(dbPath);
      db.prepare('UPDATE decisions SET skill = NULL WHERE decision_id = ?').run(noSkillResult.decisionId);
      db.close();

      const windowStart = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
      // Open end (same millisecond-boundary class as the window-filter test above):
      // a windowEnd pinned to the pre-write nowMs excludes rows minted milliseconds
      // later — green locally (same-ms writes), 0 !== 1 on CI (CI run 33464035427).
      const stats = decisionStatsBySkill(windowStart);

      assert.ok(stats);
      assert.strictEqual(stats.size, 1);
      assert.ok(stats.has('synthetic-skill-d'));

      // Verify no null-skill entry exists (cannot use .has(null) - type mismatch)
      // Instead, verify the single entry is the expected one
      const onlySkill = Array.from(stats.keys())[0];
      assert.strictEqual(onlySkill, 'synthetic-skill-d');
    });

    it('returns null for corrupt DB file and never throws', () => {
      const dbPath = decisionsDbPath();
      const fs = require('fs');

      // Write garbage to the DB file
      fs.writeFileSync(dbPath, 'not a sqlite database', 'utf-8');

      const stats = decisionStatsBySkill('1970-01-01T00:00:00.000Z');
      assert.strictEqual(stats, null);
    });

    it('returns empty Map (NOT null) for empty DB with schema', () => {
      // Create a fresh DB with schema but no rows
      const dbPath = decisionsDbPath();
      const fs = require('fs');

      // Remove existing DB
      try {
        fs.unlinkSync(dbPath);
      } catch {}

      // Create fresh DB with schema
      const db = new Database(dbPath);
      db.exec(DECISIONS_SCHEMA_SQL);
      db.close();

      const stats = decisionStatsBySkill('1970-01-01T00:00:00.000Z');
      assert.ok(stats !== null);
      assert.strictEqual(stats.size, 0);
    });
  });
});
