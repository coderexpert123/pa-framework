import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { unlink, mkdir, rmdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { sloReportCommand } from '../src/commands/slo.js';
import { createTempPaHome, cleanup } from './helpers.js';
import { recordDecision, recordReaction, decisionsDbPath, DECISIONS_SCHEMA_SQL } from '../src/lib/decisions.js';
import Database from 'better-sqlite3';

// paths.ts has no override hook — set PA_HOME the way every other pa test does.
const TEST_PA_HOME = join(tmpdir(), `pa-test-slo-${process.pid}`);

describe('slo report command', () => {
  let consoleOutput: string[];
  const originalLog = console.log;

  beforeEach(async () => {
    await mkdir(TEST_PA_HOME, { recursive: true });
    await mkdir(join(TEST_PA_HOME, 'logs'), { recursive: true });
    process.env.PA_HOME = TEST_PA_HOME;

    // Capture console output
    consoleOutput = [];
    console.log = (...args: any[]) => {
      consoleOutput.push(args.join(' '));
    };
  });

  afterEach(async () => {
    console.log = originalLog;
    delete process.env.PA_HOME;

    // Clean up test directory
    try {
      await rmdir(join(TEST_PA_HOME, 'logs'));
    } catch {
      // Directory doesn't exist, that's ok
    }
    try {
      await rmdir(TEST_PA_HOME);
    } catch {
      // Directory doesn't exist, that's ok
    }
  });

  describe('--json flag', () => {
    it('should output pure JSON (no SLO Report header)', async () => {
      await sloReportCommand(['--json']);
      const output = consoleOutput.join('\n');

      // Should parse as JSON
      const parsed = JSON.parse(output);

      // Should NOT include the table header text
      assert.ok(!output.includes('SLO Report'));

      // Should have required top-level fields
      assert.ok(parsed.month);
      assert.ok(parsed.generatedAt);
      assert.ok(Array.isArray(parsed.services));
    });

    it('should have month and generatedAt fields', async () => {
      await sloReportCommand(['--json']);
      const output = consoleOutput.join('\n');
      const parsed = JSON.parse(output);

      // month should be YYYY-MM format
      assert.match(parsed.month, /^\d{4}-\d{2}$/);

      // generatedAt should be ISO 8601
      assert.ok(Date.parse(parsed.generatedAt));
    });

    it('should set month from --month flag', async () => {
      await sloReportCommand(['--month', '2026-08', '--json']);
      const output = consoleOutput.join('\n');
      const parsed = JSON.parse(output);

      assert.strictEqual(parsed.month, '2026-08');
    });

    it('should include service fields in JSON output', async () => {
      await sloReportCommand(['--json']);
      const output = consoleOutput.join('\n');
      const parsed = JSON.parse(output);

      if (parsed.services.length > 0) {
        const service = parsed.services[0];
        assert.ok(service.service);
        assert.ok(service.status);
        assert.ok(service.periodStart);
        assert.ok(Array.isArray(service.missingData));
      }
    });

    it('should include ISO periodStart/periodEnd timestamps', async () => {
      await sloReportCommand(['--json']);
      const output = consoleOutput.join('\n');
      const parsed = JSON.parse(output);

      if (parsed.services.length > 0) {
        const service = parsed.services[0];
        // Should be valid ISO dates
        assert.ok(Date.parse(service.periodStart));
        assert.ok(Date.parse(service.periodEnd));
      }
    });

    it('should emit services with missingData when no data files exist', async () => {
      await sloReportCommand(['--json']);
      const output = consoleOutput.join('\n');
      const parsed = JSON.parse(output);

      // Even with no data, services should be emitted (defaults from config)
      assert.ok(Array.isArray(parsed.services));

      // Each service should have missingData array (populated or empty)
      parsed.services.forEach((service: any) => {
        assert.ok(Array.isArray(service.missingData));
      });
    });
  });

  describe('default table output', () => {
    it('should print table when --json is not specified', async () => {
      await sloReportCommand([]);
      const output = consoleOutput.join('\n');

      // Should include the table header
      assert.ok(output.includes('SLO Report'));

      // Should NOT be JSON
      assert.throws(() => JSON.parse(output));
    });
  });

  describe('skill outcomes integration', () => {
    let tempHome: string;

    beforeEach(async () => {
      tempHome = await createTempPaHome();
      await mkdir(join(tempHome, 'logs'), { recursive: true });
      process.env.PA_HOME = tempHome;
    });

    afterEach(async () => {
      console.log = originalLog;
      delete process.env.PA_HOME;
      await cleanup(tempHome);
    });

    it('--json includes skillOutcomes key (array-or-null)', async () => {
      // Create some decision data
      recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-n',
        request_excerpt: 'Request',
        decision: 'Decision',
        rationale: 'Rationale',
      });

      await sloReportCommand(['--json']);
      const output = consoleOutput.join('\n');
      const parsed = JSON.parse(output);

      // Should have skillOutcomes key
      assert.ok('skillOutcomes' in parsed);

      // When decisions exist, should be an object
      if (parsed.skillOutcomes !== null) {
        assert.ok(typeof parsed.skillOutcomes === 'object');
        assert.ok(Array.isArray(parsed.skillOutcomes.skills));
      }
    });

    it('--json skillOutcomes is null when decisions.sqlite absent or empty', async () => {
      await sloReportCommand(['--json']);
      const output = consoleOutput.join('\n');
      const parsed = JSON.parse(output);

      // Should have skillOutcomes key
      assert.ok('skillOutcomes' in parsed);

      // Should be null when no decisions exist
      assert.strictEqual(parsed.skillOutcomes, null);
    });

    it('text mode prints per-skill header when decisions exist', async () => {
      recordDecision({
        source: 'skill',
        skill: 'synthetic-skill-o',
        request_excerpt: 'Request',
        decision: 'Decision',
        rationale: 'Rationale',
      });

      await sloReportCommand([]);
      const output = consoleOutput.join('\n');

      // Should include the per-skill header
      assert.ok(output.includes('Per-skill outcome SLOs (acted_on = approved+replied, trailing 30d)'));
    });

    it('text mode prints honest-absence line when no decisions', async () => {
      await sloReportCommand([]);
      const output = consoleOutput.join('\n');

      // Should print the honest-absence line
      assert.ok(output.includes('Per-skill outcome SLOs: no decision data (decisions.sqlite absent or empty)'));
    });

    it('existing cases still pass: services key exists regardless of skillOutcomes', async () => {
      await sloReportCommand(['--json']);
      const output = consoleOutput.join('\n');
      const parsed = JSON.parse(output);

      // services should always exist
      assert.ok(Array.isArray(parsed.services));
    });
  });
});
