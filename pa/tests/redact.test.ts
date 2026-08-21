/**
 * Tests for redact.ts
 *
 * Tests secret redaction from logs and outputs.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { redactSecrets, resetRedactCache } from '../src/lib/redact.js';

const TEST_PA_HOME = join(tmpdir(), `pa-test-redact-${process.pid}`);

describe('redactSecrets', () => {
  beforeEach(() => {
    // Clean up any existing test directory
    if (existsSync(TEST_PA_HOME)) {
      rmSync(TEST_PA_HOME, { recursive: true, force: true });
    }
    mkdirSync(TEST_PA_HOME, { recursive: true });
    process.env.PA_HOME = TEST_PA_HOME;
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(TEST_PA_HOME)) {
      rmSync(TEST_PA_HOME, { recursive: true, force: true });
    }
    delete process.env.PA_HOME;
    resetRedactCache(); // Clear cache so secrets.env from one test don't bleed into the next
  });

  describe('literal secret redaction', () => {
    it('should redact secret values from strings', () => {
      const secretsPath = join(TEST_PA_HOME, 'secrets.env');
      writeFileSync(secretsPath, `
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqrstuvwxyz
SHORT=value
      `.trim());

      // Clear the cache so new secrets are loaded
      resetRedactCache();

      const input = 'Bot token is 1234567890:ABCdefGHIjklMNOpqrsTUVwxyz and key is sk-1234567890abcdefghijklmnopqrstuvwxyz';
      const result = redactSecrets(input);
      assert.equal(result, 'Bot token is <redacted:TELEGRAM_BOT_TOKEN> and key is <redacted:OPENAI_API_KEY>');
    });

    it('should only redact values >= 8 characters', () => {
      const secretsPath = join(TEST_PA_HOME, 'secrets.env');
      writeFileSync(secretsPath, `
LONG_SECRET=12345678
SHORT=abc
      `.trim());

      resetRedactCache();

      const input = 'Values: 12345678 and abc';
      const result = redactSecrets(input);
      assert.equal(result, 'Values: <redacted:LONG_SECRET> and abc');
    });

    it('should redact secrets sorted longest-first to prevent overlaps', () => {
      const secretsPath = join(TEST_PA_HOME, 'secrets.env');
      writeFileSync(secretsPath, `
SECRET_1=12345678901234567890
SECRET_2=1234567890
      `.trim());

      resetRedactCache();

      const input = 'Token: 12345678901234567890 other: 1234567890';
      const result = redactSecrets(input);
      assert.equal(result, 'Token: <redacted:SECRET_1> other: <redacted:SECRET_2>');
    });

    it('should handle empty secrets.env gracefully', () => {
      const secretsPath = join(TEST_PA_HOME, 'secrets.env');
      writeFileSync(secretsPath, '');

      resetRedactCache();

      const input = 'No secrets here';
      const result = redactSecrets(input);
      assert.equal(result, 'No secrets here');
    });

    it('should handle missing secrets.env gracefully', () => {
      resetRedactCache();

      const input = 'No secrets file';
      const result = redactSecrets(input);
      assert.equal(result, 'No secrets file');
    });

    it('should handle quoted values in secrets.env', () => {
      const secretsPath = join(TEST_PA_HOME, 'secrets.env');
      writeFileSync(secretsPath, `
DOUBLE_QUOTED="1234567890abcdef"
SINGLE_QUOTED='1234567890abcdef'
      `.trim());

      resetRedactCache();

      const input = 'Token: 1234567890abcdef';
      const result = redactSecrets(input);
      assert.equal(result, 'Token: <redacted:DOUBLE_QUOTED>');
    });
  });

  describe('generic shape pattern redaction', () => {
    it('should redact Stripe-like tokens (sk- prefix)', () => {
      const input = 'Stripe key: ' + ['sk', '-1234567890abcdefghijklmnop'].join('');
      const result = redactSecrets(input);
      assert.equal(result, 'Stripe key: <redacted:token>');
    });

    it('should redact Slack tokens (xoxb/xoxa/xoxp/xoxs/xoxr)', () => {
      const input = 'Slack bot: ' + ['xoxb', '-1234567890-1234567890abcdef'].join('');
      const result = redactSecrets(input);
      assert.equal(result, 'Slack bot: <redacted:token>');
    });

    it('should redact Google tokens (AIza prefix)', () => {
      const input = 'Google token: ' + ['AIza', '1234567890abcdefghijklmnopqrstuvwxyz'].join('');
      const result = redactSecrets(input);
      assert.equal(result, 'Google token: <redacted:token>');
    });

    it('should redact GitHub tokens (ghp/gho/ghu/ghs/ghr prefix)', () => {
      const input = 'GitHub pat: ' + ['ghp', '_1234567890abcdefghijklmnopqrstuvwxyz123456'].join('');
      const result = redactSecrets(input);
      assert.equal(result, 'GitHub pat: <redacted:token>');
    });

    it('should redact Bearer tokens', () => {
      const input = 'Authorization: ' + ['Bearer', ' 1234567890abcdefghijklmnopqrstuvwxyz1234567890ab'].join('');
      const result = redactSecrets(input);
      assert.equal(result, 'Authorization: <redacted:token>');
    });

    it('should not redact short tokens below minimum length', () => {
      const input = 'Short: sk-12345';
      const result = redactSecrets(input);
      assert.equal(result, 'Short: sk-12345');
    });
  });

  describe('object redaction', () => {
    it('should recursively redact string values in nested objects', () => {
      const secretsPath = join(TEST_PA_HOME, 'secrets.env');
      writeFileSync(secretsPath, 'SECRET=1234567890abcdef');

      resetRedactCache();

      const input = {
        message: 'The secret is 1234567890abcdef',
        nested: {
          key: 'Also contains 1234567890abcdef here',
        },
        number: 42,
      };

      const result = redactSecrets(input as Record<string, unknown>);
      assert.deepEqual((result as Record<string, unknown>).message, 'The secret is <redacted:SECRET>');
      assert.deepEqual((result as Record<string, unknown>).nested, {
        key: 'Also contains <redacted:SECRET> here',
      });
      assert.equal((result as Record<string, unknown>).number, 42);
    });

    it('should redact values in arrays', () => {
      const secretsPath = join(TEST_PA_HOME, 'secrets.env');
      writeFileSync(secretsPath, 'TOKEN=sk-1234567890abcdefghijklmnop');

      resetRedactCache();

      const input = {
        items: ['Token: sk-1234567890abcdefghijklmnop', 'Another: sk-1234567890abcdefghijklmnop'],
      };

      const result = redactSecrets(input as Record<string, unknown>);
      assert.deepEqual((result as Record<string, unknown>).items, [
        'Token: <redacted:TOKEN>',
        'Another: <redacted:TOKEN>',
      ]);
    });

    it('should not redact short common words', () => {
      const input = {
        message: 'The password is password123 and secret is secret',
        count: 3,
      };

      const result = redactSecrets(input as Record<string, unknown>);
      assert.equal((result as Record<string, unknown>).message, 'The password is password123 and secret is secret');
      assert.equal((result as Record<string, unknown>).count, 3);
    });
  });

  describe('zero false positives', () => {
    it('should not redact ordinary prose with common words', () => {
      const input = 'The quick brown fox jumps over the lazy dog. The secret is safe.';
      const result = redactSecrets(input);
      assert.equal(result, input);
    });

    it('should not redact URLs with legitimate structure', () => {
      const input = 'Visit https://example.com/path/to/resource';
      const result = redactSecrets(input);
      assert.equal(result, input);
    });

    it('should not redact valid email addresses', () => {
      const input = 'Contact user@example.com for support';
      const result = redactSecrets(input);
      assert.equal(result, input);
    });

    it('should not redact short identifiers (< 8 chars)', () => {
      const input = 'ID: abc12345 (7 chars) is safe';
      const result = redactSecrets(input);
      assert.equal(result, input);
    });
  });
});
