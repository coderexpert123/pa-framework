import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdir, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  DEFAULT_MODEL_PRICING,
  parseModelPricing,
  loadModelPricing,
  priceKeyFor,
  estimateRecordCostUsd,
  type ModelPricingTable,
} from '../src/lib/model-pricing.js';

const TEST_PA_HOME = join(tmpdir(), `pa-test-pricing-${process.pid}`);

describe('model-pricing', () => {
  beforeEach(async () => {
    await mkdir(TEST_PA_HOME, { recursive: true });
    process.env.PA_HOME = TEST_PA_HOME;
  });

  describe('parseModelPricing', () => {
    it('should parse valid pricing entries', () => {
      const raw = {
        'gemini-3.7-flash': { input: 0.75, output: 3.75, cache_read: 0.075 },
        'claude-sonnet-5': { input: 2, output: 10 },
      };

      const result = parseModelPricing(raw);

      assert.strictEqual(Object.keys(result).length, 2);
      assert.strictEqual(result['gemini-3.7-flash'].input, 0.75);
      assert.strictEqual(result['gemini-3.7-flash'].output, 3.75);
      assert.strictEqual(result['gemini-3.7-flash'].cacheRead, 0.075);
      assert.strictEqual(result['claude-sonnet-5'].input, 2);
      assert.strictEqual(result['claude-sonnet-5'].output, 10);
      assert.strictEqual(result['claude-sonnet-5'].cacheRead, undefined);
    });

    it('should skip entries with negative values', () => {
      const raw = {
        'good': { input: 0.75, output: 3.75 },
        'bad-input': { input: -1, output: 3.75 },
        'bad-output': { input: 0.75, output: -1 },
      };

      const result = parseModelPricing(raw);

      assert.strictEqual(Object.keys(result).length, 1);
      assert.ok(result['good']);
      assert.ok(!result['bad-input']);
      assert.ok(!result['bad-output']);
    });

    it('should skip entries with non-numeric values', () => {
      const raw = {
        'good': { input: 0.75, output: 3.75 },
        'bad-input': { input: 'not-a-number', output: 3.75 },
        'bad-output': { input: 0.75, output: NaN },
        'infinite': { input: 0.75, output: Infinity },
      };

      const result = parseModelPricing(raw);

      assert.strictEqual(Object.keys(result).length, 1);
      assert.ok(result['good']);
      assert.ok(!result['bad-input']);
      assert.ok(!result['bad-output']);
      assert.ok(!result['infinite']);
    });

    it('should skip entries where value is not an object', () => {
      const raw = {
        'good': { input: 0.75, output: 3.75 },
        'bad-string': 'string-value',
        'bad-null': null,
        'bad-array': [1, 2, 3],
      };

      const result = parseModelPricing(raw);

      assert.strictEqual(Object.keys(result).length, 1);
      assert.ok(result['good']);
      assert.ok(!result['bad-string']);
      assert.ok(!result['bad-null']);
      assert.ok(!result['bad-array']);
    });

    it('should skip entries with invalid cache_read', () => {
      const raw = {
        'good': { input: 0.75, output: 3.75, cache_read: 0.075 },
        'bad-cache': { input: 0.75, output: 3.75, cache_read: 'invalid' },
        'negative-cache': { input: 0.75, output: 3.75, cache_read: -0.1 },
      };

      const result = parseModelPricing(raw);

      assert.strictEqual(Object.keys(result).length, 1);
      assert.ok(result['good']);
      assert.ok(!result['bad-cache']);
      assert.ok(!result['negative-cache']);
    });

    it('should return empty object for null/undefined/raw non-object', () => {
      assert.strictEqual(Object.keys(parseModelPricing(null)).length, 0);
      assert.strictEqual(Object.keys(parseModelPricing(undefined)).length, 0);
      assert.strictEqual(Object.keys(parseModelPricing('string')).length, 0);
      assert.strictEqual(Object.keys(parseModelPricing(123)).length, 0);
    });

    it('should treat cache_read as optional', () => {
      const raw = {
        'with-cache': { input: 0.75, output: 3.75, cache_read: 0.075 },
        'without-cache': { input: 0.75, output: 3.75 },
      };

      const result = parseModelPricing(raw);

      assert.strictEqual(result['with-cache'].cacheRead, 0.075);
      assert.strictEqual(result['without-cache'].cacheRead, undefined);
    });
  });

  describe('priceKeyFor', () => {
    it('should return trimmed model when present and non-empty', () => {
      assert.strictEqual(priceKeyFor('agy', 'gemini-3.7-flash'), 'gemini-3.7-flash');
      assert.strictEqual(priceKeyFor('agy', '  gemini-3.7-flash  '), 'gemini-3.7-flash');
    });

    it('should return worker when model is empty', () => {
      assert.strictEqual(priceKeyFor('agy', ''), 'agy');
      assert.strictEqual(priceKeyFor('agy', '   '), 'agy');
    });

    it('should return worker when model is undefined', () => {
      assert.strictEqual(priceKeyFor('agy'), 'agy');
      assert.strictEqual(priceKeyFor('claude', undefined), 'claude');
    });

    it('should use model precedence over worker', () => {
      assert.strictEqual(priceKeyFor('agy', 'claude-sonnet-5'), 'claude-sonnet-5');
    });
  });

  describe('estimateRecordCostUsd', () => {
    it('should calculate cost correctly with all fields', () => {
      const table: ModelPricingTable = {
        'test-model': { input: 0.75, output: 3.75, cacheRead: 0.075 },
      };

      const record = {
        worker: 'agy',
        model: 'test-model',
        tokensIn: 100000,
        tokensOut: 10000,
        tokensThinking: 5000,
        tokensCacheRead: 200000,
      };

      // Hand-computed: (100000*0.75 + (10000+5000)*3.75 + 200000*0.075) / 1e6
      // = (75000 + 56250 + 15000) / 1e6 = 0.14625
      const result = estimateRecordCostUsd(record, table);

      assert.strictEqual(result, 0.14625);
    });

    it('should use output rate for thinking tokens', () => {
      const table: ModelPricingTable = {
        'test-model': { input: 1.0, output: 5.0 },
      };

      const record = {
        worker: 'agy',
        model: 'test-model',
        tokensIn: 100000,
        tokensOut: 10000,
        tokensThinking: 10000,
      };

      // (100000*1.0 + (10000+10000)*5.0) / 1e6 = (100000 + 100000) / 1e6 = 0.20
      const result = estimateRecordCostUsd(record, table);

      assert.strictEqual(result, 0.20);
    });

    it('should default cacheRead to 0 when omitted', () => {
      const table: ModelPricingTable = {
        'test-model': { input: 1.0, output: 5.0 },
      };

      const record = {
        worker: 'agy',
        model: 'test-model',
        tokensIn: 100000,
        tokensOut: 0,
        tokensCacheRead: 1000000,
      };

      // (100000*1.0 + 0*5.0 + 1000000*0) / 1e6 = 0.10
      const result = estimateRecordCostUsd(record, table);

      assert.strictEqual(result, 0.10);
    });

    it('should return null for unknown pricing key', () => {
      const table: ModelPricingTable = {
        'known-model': { input: 0.75, output: 3.75 },
      };

      const record = {
        worker: 'unknown-worker',
        model: 'unknown-model',
        tokensIn: 100000,
        tokensOut: 10000,
      };

      const result = estimateRecordCostUsd(record, table);

      assert.strictEqual(result, null);
    });

    it('should fall back to worker key when model is absent', () => {
      const table: ModelPricingTable = {
        'agy': { input: 0.75, output: 3.75 },
      };

      const record = {
        worker: 'agy',
        tokensIn: 100000,
        tokensOut: 10000,
      };

      // (100000*0.75 + 10000*3.75) / 1e6 = 0.1125
      const result = estimateRecordCostUsd(record, table);

      assert.strictEqual(result, 0.1125);
    });

    it('should handle zero tokens', () => {
      const table: ModelPricingTable = {
        'test-model': { input: 0.75, output: 3.75 },
      };

      const record = {
        worker: 'agy',
        model: 'test-model',
        tokensIn: 0,
        tokensOut: 0,
        tokensThinking: 0,
        tokensCacheRead: 0,
      };

      const result = estimateRecordCostUsd(record, table);

      assert.strictEqual(result, 0);
    });

    it('should round to 6 decimal places', () => {
      const table: ModelPricingTable = {
        'test-model': { input: 1, output: 1 },
      };

      const record = {
        worker: 'agy',
        model: 'test-model',
        tokensIn: 1,
        tokensOut: 1,
      };

      const result = estimateRecordCostUsd(record, table);

      assert.strictEqual(result, 0.000002); // 2/1e6 rounded to 6dp
    });
  });

  describe('loadModelPricing', () => {
    it('should return defaults when config.yaml does not exist', async () => {
      const result = await loadModelPricing();

      assert.ok(result['agy']);
      assert.ok(result['claude-opus-4-6']);
      assert.ok(result['gemini-3.7-flash']);
      assert.ok(result['glm-5.3']);
    });

    it('should merge config overrides over defaults', async () => {
      const configPath = join(TEST_PA_HOME, 'config.yaml');
      const yaml = await import('yaml');
      const configContent = yaml.stringify({
        model_pricing: {
          'custom-model': { input: 1.5, output: 5.0, cache_read: 0.15 },
          'agy': { input: 0.50, output: 2.50 }, // Override built-in
        },
      });
      await writeFile(configPath, configContent, 'utf8');

      const result = await loadModelPricing();

      // Should have built-ins
      assert.ok(result['claude-opus-4-6']);
      assert.ok(result['gemini-3.7-flash']);
      // Should have custom entry
      assert.strictEqual(result['custom-model'].input, 1.5);
      // Should override built-in agy
      assert.strictEqual(result['agy'].input, 0.50);
      assert.strictEqual(result['agy'].output, 2.50);
    });

    it('should return defaults on malformed config.yaml', async () => {
      const configPath = join(TEST_PA_HOME, 'config.yaml');
      await writeFile(configPath, 'not valid yaml: {[}', 'utf8');

      const result = await loadModelPricing();

      assert.ok(result['agy']);
      assert.ok(result['claude-opus-4-6']);
    });

    it('should return defaults when model_pricing section is missing', async () => {
      const configPath = join(TEST_PA_HOME, 'config.yaml');
      const yaml = await import('yaml');
      await writeFile(configPath, yaml.stringify({ some_other_key: 'value' }), 'utf8');

      const result = await loadModelPricing();

      assert.ok(result['agy']);
      assert.ok(result['claude-opus-4-6']);
    });
  });

  describe('DEFAULT_MODEL_PRICING', () => {
    it('should contain all required entries', () => {
      // Worker fallbacks
      assert.ok(DEFAULT_MODEL_PRICING['agy']);
      assert.ok(DEFAULT_MODEL_PRICING['zclaude']);

      // Anthropic models
      assert.ok(DEFAULT_MODEL_PRICING['claude-opus-4-6']);
      assert.ok(DEFAULT_MODEL_PRICING['claude-sonnet-4-6']);
      assert.ok(DEFAULT_MODEL_PRICING['claude-sonnet-5']);
      assert.ok(DEFAULT_MODEL_PRICING['claude-haiku-4-5']);

      // Gemini models
      assert.ok(DEFAULT_MODEL_PRICING['gemini-3.7-flash']);
      assert.ok(DEFAULT_MODEL_PRICING['gemini-3.6-flash']);
      assert.ok(DEFAULT_MODEL_PRICING['gemini-3.5-flash']);
      assert.ok(DEFAULT_MODEL_PRICING['gemini-3.5-flash-lite']);
      assert.ok(DEFAULT_MODEL_PRICING['gemini-2.5-flash']);
      assert.ok(DEFAULT_MODEL_PRICING['gemini-2.5-flash-lite']);

      // GLM models
      assert.ok(DEFAULT_MODEL_PRICING['glm-5.3']);
      assert.ok(DEFAULT_MODEL_PRICING['glm-5.2']);
      assert.ok(DEFAULT_MODEL_PRICING['glm-5.1']);
      assert.ok(DEFAULT_MODEL_PRICING['glm-5']);
      assert.ok(DEFAULT_MODEL_PRICING['glm-4.7']);
    });

    it('should have valid pricing structure for all entries', () => {
      for (const [key, price] of Object.entries(DEFAULT_MODEL_PRICING)) {
        assert.ok(typeof price.input === 'number' && price.input >= 0, `${key} has invalid input`);
        assert.ok(typeof price.output === 'number' && price.output >= 0, `${key} has invalid output`);
        if (price.cacheRead !== undefined) {
          assert.ok(typeof price.cacheRead === 'number' && price.cacheRead >= 0, `${key} has invalid cacheRead`);
        }
      }
    });

    it('should match spec values for agy worker', () => {
      const agyPrice = DEFAULT_MODEL_PRICING['agy'];
      assert.strictEqual(agyPrice.input, 0.75);
      assert.strictEqual(agyPrice.output, 3.75);
      assert.strictEqual(agyPrice.cacheRead, 0.075);
    });

    it('should match spec values for zclaude worker', () => {
      const zclaudePrice = DEFAULT_MODEL_PRICING['zclaude'];
      assert.strictEqual(zclaudePrice.input, 1.40);
      assert.strictEqual(zclaudePrice.output, 4.40);
      assert.strictEqual(zclaudePrice.cacheRead, 0.26);
    });
  });
});
