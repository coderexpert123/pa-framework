import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { unlink, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { appendUsage, extractUsageFromEvent, getUsageParseFailures, resetUsageParseFailures, type UsageRecord } from '../src/lib/usage-ledger.js';

// paths.ts has no override hook — set PA_HOME the way every other pa test does.
const TEST_PA_HOME = join(tmpdir(), `pa-test-usage-${process.pid}`);

describe('usage-ledger', () => {
  beforeEach(async () => {
    await mkdir(TEST_PA_HOME, { recursive: true });
    process.env.PA_HOME = TEST_PA_HOME;
    resetUsageParseFailures();
  });

  afterEach(async () => {
    delete process.env.PA_HOME;
    // Clean up test directory
    try {
      await unlink(join(TEST_PA_HOME, 'logs', 'usage.jsonl'));
    } catch {
      // File doesn't exist, that's ok
    }
  });

  describe('appendUsage', () => {
    it('should append a usage record to the ledger', async () => {
      const record: UsageRecord = {
        ts: '2026-08-17T12:00:00.000Z',
        worker: 'agy',
        resource: 'test-skill',
        tokensIn: 100,
        tokensOut: 50,
      };

      await appendUsage(record);

      const usagePath = join(TEST_PA_HOME, 'logs', 'usage.jsonl');
      const content = await readFile(usagePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);

      assert.strictEqual(lines.length, 1);
      const parsed = JSON.parse(lines[0]) as UsageRecord;
      assert.strictEqual(parsed.ts, record.ts);
      assert.strictEqual(parsed.worker, record.worker);
      assert.strictEqual(parsed.resource, record.resource);
      assert.strictEqual(parsed.tokensIn, record.tokensIn);
      assert.strictEqual(parsed.tokensOut, record.tokensOut);
    });

    it('should append multiple records', async () => {
      const record1: UsageRecord = {
        ts: '2026-08-17T12:00:00.000Z',
        worker: 'agy',
        resource: 'skill1',
        tokensIn: 100,
        tokensOut: 50,
      };

      const record2: UsageRecord = {
        ts: '2026-08-17T12:01:00.000Z',
        worker: 'claude',
        model: 'claude-sonnet-5',
        resource: 'skill2',
        tokensIn: 200,
        tokensOut: 100,
        tokensThinking: 30,
      };

      await appendUsage(record1);
      await appendUsage(record2);

      const usagePath = join(TEST_PA_HOME, 'logs', 'usage.jsonl');
      const content = await readFile(usagePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);

      assert.strictEqual(lines.length, 2);
    });

    it('should include optional fields', async () => {
      const record: UsageRecord = {
        ts: '2026-08-17T12:00:00.000Z',
        worker: 'claude',
        model: 'claude-sonnet-5',
        resource: 'test-skill',
        tokensIn: 100,
        tokensOut: 50,
        tokensThinking: 25,
        tokensCacheRead: 10,
        estCostUsd: 0.05,
      };

      await appendUsage(record);

      const usagePath = join(TEST_PA_HOME, 'logs', 'usage.jsonl');
      const content = await readFile(usagePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);

      assert.strictEqual(lines.length, 1);
      const parsed = JSON.parse(lines[0]) as UsageRecord;
      assert.strictEqual(parsed.tokensThinking, 25);
      assert.strictEqual(parsed.tokensCacheRead, 10);
      assert.strictEqual(parsed.estCostUsd, 0.05);
    });
  });

  describe('extractUsageFromEvent', () => {
    it('should extract usage from agy event with usage field', () => {
      const event = {
        event: 'result',
        result: {
          response: 'test output',
        },
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
      };

      const usage = extractUsageFromEvent(event, 'agy');

      assert.strictEqual(usage?.tokensIn, 100);
      assert.strictEqual(usage?.tokensOut, 50);
    });

    it('should extract usage from agy event with nested usage in result', () => {
      const event = {
        event: 'result',
        result: {
          response: 'test output',
          usage: {
            input_tokens: 150,
            output_tokens: 75,
          },
        },
      };

      const usage = extractUsageFromEvent(event, 'agy');

      assert.strictEqual(usage?.tokensIn, 150);
      assert.strictEqual(usage?.tokensOut, 75);
    });

    it('should extract usage from claude event', () => {
      const event = {
        type: 'message',
        role: 'assistant',
        message: {
          content: [{ type: 'text', text: 'test' }],
          usage: {
            input_tokens: 200,
            output_tokens: 100,
            cache_read_tokens: 30,
          },
        },
      };

      const usage = extractUsageFromEvent(event, 'claude');

      assert.strictEqual(usage?.tokensIn, 200);
      assert.strictEqual(usage?.tokensOut, 100);
      assert.strictEqual(usage?.tokensCacheRead, 30);
    });

    it('should extract usage with thinking tokens', () => {
      const event = {
        type: 'result',
        result: 'test output',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          thinking_tokens: 25,
        },
      };

      const usage = extractUsageFromEvent(event, 'claude');

      assert.strictEqual(usage?.tokensIn, 100);
      assert.strictEqual(usage?.tokensOut, 50);
      assert.strictEqual(usage?.tokensThinking, 25);
    });

    it('should return undefined when no usage data present', () => {
      const event = {
        type: 'message',
        role: 'assistant',
        message: {
          content: [{ type: 'text', text: 'test' }],
        },
      };

      const usage = extractUsageFromEvent(event, 'claude');

      assert.strictEqual(usage, undefined);
    });

    it('should return undefined when usage has zero tokens', () => {
      const event = {
        type: 'result',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      };

      const usage = extractUsageFromEvent(event, 'claude');

      assert.strictEqual(usage, undefined);
    });

    it('should handle alternative field names', () => {
      const event = {
        usage: {
          prompt_tokens: 120,
          completion_tokens: 60,
        },
      };

      const usage = extractUsageFromEvent(event, 'codex');

      assert.strictEqual(usage?.tokensIn, 120);
      assert.strictEqual(usage?.tokensOut, 60);
    });

    it('should count parse failures', () => {
      // Trigger a parse error with malformed event
      extractUsageFromEvent(null, 'claude');
      extractUsageFromEvent(undefined, 'claude');

      assert.strictEqual(getUsageParseFailures(), 2);
    });
  });
});
