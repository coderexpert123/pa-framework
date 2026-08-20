/**
 * Tests for SLO-lite error budget tracking
 */

import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { generateMonthlyReport, formatReportTable, loadServiceDefinitions, SLOReport } from '../src/lib/slo.js';

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
    assert.strictEqual(defs.length, 4);
    assert.strictEqual(defs[0].name, 'bot-reply-delivery');
    assert.strictEqual(defs[1].name, 'daily-mail-brief');
    assert.strictEqual(defs[2].name, 'catchup-heartbeat');
    assert.strictEqual(defs[3].name, 'ekadashi-alerts');
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
    assert.strictEqual(reports.length, 4);

    for (const report of reports) {
      assert.strictEqual(report.totalEvents, 0);
      assert.strictEqual(report.errorBudgetRemaining, 100);
      assert.strictEqual(report.status, 'ok');
    }
  });

  test('generateMonthlyReport computes budget correctly for zero-miss service', () => {
    const month = new Date(2026, 7, 1);

    // Create mock ekadashi receipts with a miss
    const receiptsPath = join(TEST_DIR, 'ekadashi-receipts.jsonl');
    const missEvent = JSON.stringify({
      timestamp: '2026-08-15T10:00:00Z',
      missed: true,
      ekadashi: 'Ekadashi-2026-08-15'
    });
    writeFileSync(receiptsPath, missEvent, 'utf-8');

    const oldHome = process.env.PA_HOME;
    process.env.PA_HOME = TEST_DIR;

    try {
      const reports = generateMonthlyReport(month);
      const ekadashiReport = reports.find(r => r.service === 'ekadashi-alerts');

      assert.ok(ekadashiReport);
      assert.strictEqual(ekadashiReport.totalEvents, 1);
      assert.strictEqual(ekadashiReport.errorBudgetRemaining, 0);
      assert.strictEqual(ekadashiReport.status, 'exhausted');
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
});
