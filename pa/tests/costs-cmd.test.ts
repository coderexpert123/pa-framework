import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { unlink, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { costsCommand } from '../src/commands/costs.js';
import type { UsageRecord } from '../src/lib/usage-ledger.js';

// paths.ts has no override hook — set PA_HOME the way every other pa test does.
const TEST_PA_HOME = join(tmpdir(), `pa-test-costs-${process.pid}`);

describe('costs command', () => {
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
      await unlink(join(TEST_PA_HOME, 'logs', 'usage.jsonl'));
    } catch {
      // File doesn't exist, that's ok
    }
  });

  async function writeUsageRecords(records: UsageRecord[]): Promise<void> {
    const usagePath = join(TEST_PA_HOME, 'logs', 'usage.jsonl');
    const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    await writeFile(usagePath, content, 'utf8');
  }

  describe('readUsageLedger', () => {
    it('should return empty array when file does not exist', async () => {
      await costsCommand([]);

      assert.ok(consoleOutput.some(line => line.includes('No usage records found')));
    });

    it('should parse valid usage records', async () => {
      const now = new Date().toISOString();
      const records: UsageRecord[] = [
        {
          ts: now,
          worker: 'agy',
          resource: 'skill1',
          tokensIn: 100,
          tokensOut: 50,
        },
        {
          ts: now,
          worker: 'claude',
          model: 'claude-sonnet-5',
          resource: 'skill2',
          tokensIn: 200,
          tokensOut: 100,
        },
      ];

      await writeUsageRecords(records);
      await costsCommand([]);

      assert.ok(consoleOutput.some(line => line.includes('agy')));
      assert.ok(consoleOutput.some(line => line.includes('claude')));
      assert.ok(consoleOutput.some(line => line.includes('TOTAL')));
    });

    it('should skip malformed lines', async () => {
      const now = new Date().toISOString();
      const content = `${JSON.stringify({ ts: now, worker: 'agy', resource: 'skill1', tokensIn: 100, tokensOut: 50 })}\ninvalid json line\n${JSON.stringify({ ts: now, worker: 'claude', resource: 'skill2', tokensIn: 200, tokensOut: 100 })}\n`;

      const usagePath = join(TEST_PA_HOME, 'logs', 'usage.jsonl');
      await writeFile(usagePath, content, 'utf8');

      await costsCommand([]);

      // Should still process the two valid records
      assert.ok(consoleOutput.some(line => line.includes('agy')));
      assert.ok(consoleOutput.some(line => line.includes('claude')));
    });
  });

  describe('filters', () => {
    it('should filter by week period', async () => {
      const now = new Date();
      const recentDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
      const oldDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago

      const records: UsageRecord[] = [
        {
          ts: recentDate.toISOString(),
          worker: 'agy',
          resource: 'skill1',
          tokensIn: 100,
          tokensOut: 50,
        },
        {
          ts: oldDate.toISOString(),
          worker: 'claude',
          resource: 'skill2',
          tokensIn: 200,
          tokensOut: 100,
        },
      ];

      await writeUsageRecords(records);
      await costsCommand(['--week']);

      assert.ok(consoleOutput.some(line => line.includes('agy')));
      assert.ok(!consoleOutput.some(line => line.includes('claude')));
    });

    it('should filter by month period', async () => {
      const now = new Date();
      const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5);
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);

      const records: UsageRecord[] = [
        {
          ts: thisMonth.toISOString(),
          worker: 'agy',
          resource: 'skill1',
          tokensIn: 100,
          tokensOut: 50,
        },
        {
          ts: lastMonth.toISOString(),
          worker: 'claude',
          resource: 'skill2',
          tokensIn: 200,
          tokensOut: 100,
        },
      ];

      await writeUsageRecords(records);
      await costsCommand(['--month']);

      assert.ok(consoleOutput.some(line => line.includes('agy')));
      assert.ok(!consoleOutput.some(line => line.includes('claude')));
    });

    it('should filter by skill name', async () => {
      const now = new Date().toISOString();
      const records: UsageRecord[] = [
        {
          ts: now,
          worker: 'agy',
          resource: 'skill1',
          tokensIn: 100,
          tokensOut: 50,
        },
        {
          ts: now,
          worker: 'claude',
          resource: 'skill2',
          tokensIn: 200,
          tokensOut: 100,
        },
      ];

      await writeUsageRecords(records);
      await costsCommand(['--skill', 'skill1']);

      assert.ok(consoleOutput.some(line => line.includes('skill1')));
      assert.ok(!consoleOutput.some(line => line.includes('skill2')));
    });

    it('should combine filters', async () => {
      const now = new Date();
      const recentDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      const oldDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

      const records: UsageRecord[] = [
        {
          ts: recentDate.toISOString(),
          worker: 'agy',
          resource: 'skill1',
          tokensIn: 100,
          tokensOut: 50,
        },
        {
          ts: oldDate.toISOString(),
          worker: 'claude',
          resource: 'skill1',
          tokensIn: 200,
          tokensOut: 100,
        },
      ];

      await writeUsageRecords(records);
      await costsCommand(['--week', '--skill', 'skill1']);

      assert.ok(consoleOutput.some(line => line.includes('agy')));
      assert.ok(!consoleOutput.some(line => line.includes('claude')));
    });
  });

  describe('aggregation', () => {
    it('should aggregate records by worker/model/skill', async () => {
      const now = new Date().toISOString();
      const records: UsageRecord[] = [
        {
          ts: now,
          worker: 'agy',
          resource: 'skill1',
          tokensIn: 100,
          tokensOut: 50,
        },
        {
          ts: now,
          worker: 'agy',
          resource: 'skill1',
          tokensIn: 150,
          tokensOut: 75,
        },
        {
          ts: now,
          worker: 'claude',
          resource: 'skill2',
          tokensIn: 200,
          tokensOut: 100,
        },
      ];

      await writeUsageRecords(records);
      await costsCommand([]);

      // Check that agy/skill1 is aggregated (runs: 2, tokensIn: 250, tokensOut: 125)
      const agyLine = consoleOutput.find(line => line.includes('agy') && line.includes('skill1'));
      assert.ok(agyLine);
      assert.ok(agyLine!.includes('2')); // runs
      assert.ok(agyLine!.includes('250')); // tokensIn

      // Check totals
      const totalLine = consoleOutput.find(line => line.includes('TOTAL'));
      assert.ok(totalLine);
      // Total tokens: agy/skill1 (375) + claude/skill2 (300) = 675
      assert.ok(totalLine!.includes('675'));
    });

    it('should handle optional fields (thinking, cache)', async () => {
      const now = new Date().toISOString();
      const records: UsageRecord[] = [
        {
          ts: now,
          worker: 'claude',
          model: 'claude-sonnet-5',
          resource: 'skill1',
          tokensIn: 100,
          tokensOut: 50,
          tokensThinking: 25,
          tokensCacheRead: 10,
        },
      ];

      await writeUsageRecords(records);
      await costsCommand([]);

      assert.ok(consoleOutput.some(line => line.includes('25')));
      assert.ok(consoleOutput.some(line => line.includes('10')));
    });

    it('should sort by total tokens descending', async () => {
      const now = new Date().toISOString();
      const records: UsageRecord[] = [
        {
          ts: now,
          worker: 'agy',
          resource: 'skill1',
          tokensIn: 100,
          tokensOut: 50,
        },
        {
          ts: now,
          worker: 'claude',
          resource: 'skill2',
          tokensIn: 500,
          tokensOut: 250,
        },
        {
          ts: now,
          worker: 'zclaude',
          resource: 'skill3',
          tokensIn: 200,
          tokensOut: 100,
        },
      ];

      await writeUsageRecords(records);
      await costsCommand([]);

      const claudeIndex = consoleOutput.findIndex(line => line.includes('claude'));
      const agyIndex = consoleOutput.findIndex(line => line.includes('agy'));
      const zclaudeIndex = consoleOutput.findIndex(line => line.includes('zclaude'));

      assert.ok(claudeIndex > 0);
      assert.ok(zclaudeIndex > claudeIndex);
      assert.ok(agyIndex > zclaudeIndex);
    });
  });
});
