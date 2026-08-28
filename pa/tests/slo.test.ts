/**
 * Tests for SLO-lite error budget tracking
 */

import { mkdirSync, writeFileSync, unlinkSync, existsSync, rmdirSync } from 'fs';
import { join } from 'path';
import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { generateMonthlyReport, formatReportTable, loadServiceDefinitions, SLOReport, generateSkillOutcomes, formatSkillOutcomesTable } from '../src/lib/slo.js';
import { createTempPaHome, cleanup } from './helpers.js';
import { recordDecision, recordReaction, markRepliedForThread, decisionsDbPath, DECISIONS_SCHEMA_SQL } from '../src/lib/decisions.js';
import Database from 'better-sqlite3';

const TEST_DIR = join(process.env.TMP || '/tmp', 'slo-test');

function setupTestDir(): void {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
}

function teardownTestDir(): void {
  if (existsSync(TEST_DIR)) {
    // Cleanup handled by individual tests
  }
}

describe('SLO Library', () => {
  before(() => {
    setupTestDir();
  });

  after(() => {
    teardownTestDir();
  });

  test('loadServiceDefinitions returns defaults when file missing', () => {
    const defs = loadServiceDefinitions('/nonexistent/path/slo.yaml');
    assert.ok(Array.isArray(defs));
    assert.strictEqual(defs.length, 3);
    assert.strictEqual(defs[0].name, 'bot-reply-delivery');
    assert.strictEqual(defs[1].name, 'daily-mail-brief');
    assert.strictEqual(defs[2].name, 'catchup-heartbeat');
  });

  test('loadServiceDefinitions parses valid YAML', () => {
    const yamlPath = join(TEST_DIR, 'slo.yaml');
    const yamlContent = `
services:
  - name: test-service
    target: 99.9
    targetHuman: "99.9%"
    period: month
    eventSources:
      - test-source
    description: Test service
`;
    writeFileSync(yamlPath, yamlContent, 'utf-8');

    const defs = loadServiceDefinitions(yamlPath);
    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].name, 'test-service');
    assert.strictEqual(defs[0].target, 99.9);

    unlinkSync(yamlPath);
  });

  test('generateMonthlyReport with no data returns zero events', () => {
    const month = new Date(2026, 7, 1); // August 2026
    const reports = generateMonthlyReport(month);

    assert.ok(Array.isArray(reports));
    assert.strictEqual(reports.length, 3);

    for (const report of reports) {
      assert.strictEqual(report.totalEvents, 0);
      // Zero events ⇒ 0% of the error budget used ⇒ 100% remaining
      // (relative-budget semantics, C3 — matches the live report rendering)
      assert.strictEqual(report.errorBudgetRemaining, 100);
      // C3 fix: services with missing data sources now get status 'unknown'
      if (report.missingData.length > 0) {
        assert.strictEqual(report.status, 'unknown');
      } else {
        assert.strictEqual(report.status, 'ok');
      }
    }
  });

  test('generateMonthlyReport computes budget correctly for zero-miss service', () => {
    const month = new Date(2026, 7, 1);

    // Create the mail-brief source the report actually reads:
    // <PA_HOME>/daily-mail-brief/latest.json with a misses[] entry
    const briefDir = join(TEST_DIR, 'daily-mail-brief');
    mkdirSync(briefDir, { recursive: true });
    const receiptsPath = join(briefDir, 'latest.json');
    writeFileSync(receiptsPath, JSON.stringify({
      misses: [{ timestamp: '2026-08-15T10:00:00Z', window: '19:00 IST' }]
    }), 'utf-8');

    const oldHome = process.env.PA_HOME;
    process.env.PA_HOME = TEST_DIR;

    try {
      const reports = generateMonthlyReport(month);
      const dailyBriefReport = reports.find(r => r.service === 'daily-mail-brief');

      assert.ok(dailyBriefReport);
      assert.strictEqual(dailyBriefReport.totalEvents, 1);
      // One miss of ~62 monthly windows ⇒ small budget use, service still ok
      // (relative-budget semantics: used% = events/windows; exhausted only
      // past the target's allowed-failure share — see the live report math)
      assert.ok(dailyBriefReport.errorBudgetRemaining > 0 && dailyBriefReport.errorBudgetRemaining < 100, `remaining=${dailyBriefReport.errorBudgetRemaining}`);
      assert.strictEqual(dailyBriefReport.status, 'ok');
    } finally {
      process.env.PA_HOME = oldHome;
      unlinkSync(receiptsPath);
    }
  });

  test('generateMonthlyReport computes budget correctly for percentage target', () => {
    const month = new Date(2026, 7, 1);

    // Create mock DLQ with 5 expiry events
    const dlqPath = join(TEST_DIR, 'telegram-dlq.jsonl');
    const dlqEvents = [];
    for (let i = 0; i < 5; i++) {
      dlqEvents.push(JSON.stringify({
        timestamp: `2026-08-${10 + i}T12:00:00Z`,
        reason: 'ttl-expiry'
      }));
    }
    writeFileSync(dlqPath, dlqEvents.join('\n'), 'utf-8');

    const oldHome = process.env.PA_HOME;
    process.env.PA_HOME = TEST_DIR;

    try {
      const reports = generateMonthlyReport(month);
      const botReport = reports.find(r => r.service === 'bot-reply-delivery');

      assert.ok(botReport);
      assert.strictEqual(botReport.totalEvents, 5);
      assert.ok(botReport.errorBudgetUsed >= 0);
      assert.ok(botReport.errorBudgetRemaining <= 100);
    } finally {
      process.env.PA_HOME = oldHome;
      unlinkSync(dlqPath);
    }
  });

  test('generateMonthlyReport filters by month correctly', () => {
    const month = new Date(2026, 7, 1); // August 2026

    // Create DLQ with events in July and August
    const dlqPath = join(TEST_DIR, 'telegram-dlq.jsonl');
    const dlqEvents = [
      JSON.stringify({ timestamp: '2026-07-15T12:00:00Z', reason: 'july-event' }),
      JSON.stringify({ timestamp: '2026-08-15T12:00:00Z', reason: 'august-event' }),
      JSON.stringify({ timestamp: '2026-09-15T12:00:00Z', reason: 'september-event' }),
    ];
    writeFileSync(dlqPath, dlqEvents.join('\n'), 'utf-8');

    const oldHome = process.env.PA_HOME;
    process.env.PA_HOME = TEST_DIR;

    try {
      const reports = generateMonthlyReport(month);
      const botReport = reports.find(r => r.service === 'bot-reply-delivery');

      assert.ok(botReport);
      assert.strictEqual(botReport.totalEvents, 1); // Only August event
      assert.strictEqual(botReport.eventBreakdown['dlq-expiry'], 1);
    } finally {
      process.env.PA_HOME = oldHome;
      unlinkSync(dlqPath);
    }
  });

  test('generateMonthlyReport handles malformed log lines gracefully', () => {
    const month = new Date(2026, 7, 1);

    const dlqPath = join(TEST_DIR, 'telegram-dlq.jsonl');
    const dlqEvents = [
      JSON.stringify({ timestamp: '2026-08-15T12:00:00Z', reason: 'valid-event' }),
      'not json at all',
      '{"invalid": json}',
      '',
      JSON.stringify({ timestamp: '2026-08-16T12:00:00Z', reason: 'another-valid' }),
    ];
    writeFileSync(dlqPath, dlqEvents.join('\n'), 'utf-8');

    const oldHome = process.env.PA_HOME;
    process.env.PA_HOME = TEST_DIR;

    try {
      const reports = generateMonthlyReport(month);
      const botReport = reports.find(r => r.service === 'bot-reply-delivery');

      assert.ok(botReport);
      assert.strictEqual(botReport.totalEvents, 2); // Only valid events
    } finally {
      process.env.PA_HOME = oldHome;
      unlinkSync(dlqPath);
    }
  });

  test('generateMonthlyReport reports missing data sources', () => {
    const month = new Date(2026, 7, 1);

    const oldHome = process.env.PA_HOME;
    process.env.PA_HOME = TEST_DIR;

    try {
      const reports = generateMonthlyReport(month);

      // All services should have missing data since no log files exist
      for (const report of reports) {
        if (report.totalEvents === 0) {
          // Should have missing data sources listed
          assert.ok(report.missingData.length > 0 || report.service === 'bot-reply-delivery');
        }
      }
    } finally {
      process.env.PA_HOME = oldHome;
    }
  });

  test('formatReportTable produces readable output', () => {
    const month = new Date(2026, 7, 1);
    const reports = generateMonthlyReport(month);
    const table = formatReportTable(reports);

    assert.ok(table.includes('SLO Report'));
    assert.ok(table.includes('Service'));
    assert.ok(table.includes('Target'));
    assert.ok(table.includes('Events'));
    assert.ok(table.includes('Status'));

    for (const report of reports) {
      assert.ok(table.includes(report.service));
    }
  });

  test('formatReportTable shows event breakdown when events exist', () => {
    const month = new Date(2026, 7, 1);

    const dlqPath = join(TEST_DIR, 'telegram-dlq.jsonl');
    writeFileSync(dlqPath, JSON.stringify({
      timestamp: '2026-08-15T12:00:00Z',
      reason: 'test-expiry'
    }), 'utf-8');

    const oldHome = process.env.PA_HOME;
    process.env.PA_HOME = TEST_DIR;

    try {
      const reports = generateMonthlyReport(month);
      const table = formatReportTable(reports);

      assert.ok(table.includes('Event Breakdown'));
      assert.ok(table.includes('dlq-expiry'));
    } finally {
      process.env.PA_HOME = oldHome;
      unlinkSync(dlqPath);
    }
  });

  test('formatReportTable shows warnings for missing data', () => {
    const month = new Date(2026, 7, 1);

    const oldHome = process.env.PA_HOME;
    process.env.PA_HOME = TEST_DIR;

    try {
      const reports = generateMonthlyReport(month);
      const table = formatReportTable(reports);

      // Should show warnings for services with missing data
      const hasWarning = reports.some(r =>
        r.missingData.length > 0 && table.includes(`missing data sources`)
      );
      assert.ok(hasWarning || reports.every(r => r.missingData.length === 0));
    } finally {
      process.env.PA_HOME = oldHome;
    }
  });

  describe('generateSkillOutcomes', () => {
    let tempHome: string;

    beforeEach(async () => {
      tempHome = await createTempPaHome();
      process.env.PA_HOME = tempHome;
    });

    afterEach(async () => {
      await cleanup(tempHome);
      delete process.env.PA_HOME;
    });

    test('returns null when DB is absent', () => {
      // No DB created
      const outcomes = generateSkillOutcomes();
      assert.strictEqual(outcomes, null);
    });

    test('returns null when DB is empty (schema only)', () => {
      const dbPath = decisionsDbPath();
      const db = new Database(dbPath);
      db.exec(DECISIONS_SCHEMA_SQL);
      db.close();

      const outcomes = generateSkillOutcomes();
      assert.strictEqual(outcomes, null);
    });

    test('computes universe from all-time skills', () => {
      // Record decisions for two skills
      recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-e',
        request_excerpt: 'Request',
        decision: 'Decision',
        rationale: 'Rationale',
      });

      recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-f',
        request_excerpt: 'Request',
        decision: 'Decision',
        rationale: 'Rationale',
      });

      const outcomes = generateSkillOutcomes(); // Use current time, not captured nowMs
      assert.ok(outcomes);
      assert.strictEqual(outcomes.skills.length, 2);
      assert.strictEqual(outcomes.inWindow, 2);

      // Skills should be sorted alphabetically
      assert.strictEqual(outcomes.skills[0].skill, 'synthetic-skill-e');
      assert.strictEqual(outcomes.skills[1].skill, 'synthetic-skill-f');
    });

    test('zero-window skill gets actedOnRate: null', () => {
      const nowMs = Date.now(); // Capture time BEFORE writing decisions for this test

      // Record a decision for skill A
      recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-g',
        request_excerpt: 'Request',
        decision: 'Decision',
        rationale: 'Rationale',
      });

      // Create skill B with an old decision (outside 30d window)
      const oldResult = recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-h',
        request_excerpt: 'Old request',
        decision: 'Old decision',
        rationale: 'Old rationale',
      });

      const dbPath = decisionsDbPath();
      const db = new Database(dbPath);
      const oldTs = new Date(nowMs - 40 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('UPDATE decisions SET ts = ?, updated_at = ? WHERE decision_id = ?').run(oldTs, oldTs, oldResult.decisionId);
      db.close();

      const outcomes = generateSkillOutcomes(nowMs); // Use captured time since we manually set old timestamp
      assert.ok(outcomes);

      // Skill H should have total: 0, actedOnRate: null
      const skillH = outcomes.skills.find(s => s.skill === 'synthetic-skill-h');
      assert.ok(skillH);
      assert.strictEqual(skillH.total, 0);
      assert.strictEqual(skillH.actedOnRate, null);
    });

    test('computes acted_on = (approved + replied) / total correctly', () => {
      const nowMs = Date.now(); // Capture time for markRepliedForThread

      // Create decisions with various outcomes
      const approved = recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-i',
        request_excerpt: 'Request',
        decision: 'Decision',
        rationale: 'Rationale',
        chat_id: -1009999999999,
        message_id: 1,
      });
      recordReaction(-1009999999999, 1, '👍');

      const replied = recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-i',
        request_excerpt: 'Request',
        decision: 'Decision',
        rationale: 'Rationale',
        thread_id: 4242,
        chat_id: -1009999999999,
      });
      markRepliedForThread(-1009999999999, 4242, nowMs);

      const pending = recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-i',
        request_excerpt: 'Request',
        decision: 'Decision',
        rationale: 'Rationale',
      });

      const outcomes = generateSkillOutcomes(); // Use current time
      assert.ok(outcomes);

      const skillI = outcomes.skills.find(s => s.skill === 'synthetic-skill-i');
      assert.ok(skillI);
      assert.strictEqual(skillI.total, 3);
      assert.strictEqual(skillI.approved, 1);
      assert.strictEqual(skillI.replied, 1);
      assert.strictEqual(skillI.pending, 1);

      // acted_on = (1 + 1) / 3 = 2/3 = 66.666...%
      assert.ok(skillI.actedOnRate !== null);
      const rate = Math.round(skillI.actedOnRate * 100);
      assert.strictEqual(rate, 67);
    });

    test('counts inWindow correctly', () => {
      // Two skills in window, one outside
      recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-j',
        request_excerpt: 'Request',
        decision: 'Decision',
        rationale: 'Rationale',
      });

      recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-k',
        request_excerpt: 'Request',
        decision: 'Decision',
        rationale: 'Rationale',
      });

      const outcomes = generateSkillOutcomes(); // Use current time
      assert.ok(outcomes);
      assert.strictEqual(outcomes.inWindow, 2);
    });
  });

  describe('formatSkillOutcomesTable', () => {
    test('contains frozen strings: header, "no decision data", summary', () => {
      const report = {
        generatedAt: '2026-08-28T00:00:00.000Z',
        windowDays: 30 as const,
        skills: [
          {
            skill: 'synthetic-skill-l',
            total: 0,
            approved: 0,
            rejected: 0,
            replied: 0,
            pending: 0,
            other_reaction: 0,
            actedOnRate: null,
          },
        ],
        inWindow: 0,
      };

      const table = formatSkillOutcomesTable(report);

      assert.ok(table.includes('Per-skill outcome SLOs (acted_on = approved+replied, trailing 30d)'));
      assert.ok(table.includes('no decision data'));
      assert.ok(table.includes('(1 skills with decision rows all-time; 0 with rows in window)'));
    });

    test('renders acted_on percentage correctly', () => {
      const report = {
        generatedAt: '2026-08-28T00:00:00.000Z',
        windowDays: 30 as const,
        skills: [
          {
            skill: 'synthetic-skill-m',
            total: 3,
            approved: 1,
            rejected: 1,
            replied: 1,
            pending: 0,
            other_reaction: 0,
            actedOnRate: 0.6666666666666666,
          },
        ],
        inWindow: 1,
      };

      const table = formatSkillOutcomesTable(report);

      // Should render as 67%
      assert.ok(table.includes('67%'));
      assert.ok(table.includes('synthetic-skill-m'));
    });
  });

  describe('C3 fix: unknown status for missing data', () => {
    test('service with absent source file gets status: unknown', () => {
      const month = new Date(2026, 7, 1); // August 2026

      // Create PA_HOME but DO NOT create any source files
      const oldHome = process.env.PA_HOME;
      process.env.PA_HOME = TEST_DIR;

      try {
        const reports = generateMonthlyReport(month);

        // All services should have missingData and status 'unknown'
        for (const report of reports) {
          // The C3 fix: missingData.length > 0 ⇒ status = 'unknown'
          if (report.missingData.length > 0) {
            assert.strictEqual(report.status, 'unknown');
          }
        }
      } finally {
        process.env.PA_HOME = oldHome;
      }
    });

    test('service with valid data gets status NOT unknown', () => {
      const month = new Date(2026, 7, 1);

      // Present-but-clean source: latest.json exists with zero misses
      const briefDir = join(TEST_DIR, 'daily-mail-brief');
      mkdirSync(briefDir, { recursive: true });
      const receiptsPath = join(briefDir, 'latest.json');
      writeFileSync(receiptsPath, JSON.stringify({ misses: [] }), 'utf-8');

      const oldHome = process.env.PA_HOME;
      process.env.PA_HOME = TEST_DIR;

      try {
        const reports = generateMonthlyReport(month);
        const dailyBriefReport = reports.find(r => r.service === 'daily-mail-brief');

        assert.ok(dailyBriefReport);
        // With valid data, status should NOT be 'unknown'
        assert.notStrictEqual(dailyBriefReport.status, 'unknown');
      } finally {
        process.env.PA_HOME = oldHome;
        unlinkSync(receiptsPath);
      }
    });
  });
});
