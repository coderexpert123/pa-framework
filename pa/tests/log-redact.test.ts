// pii-scan:ignore-start
/**
 * Tests for log.ts redaction integration
 *
 * Tests that secrets in context values are redacted before logging.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { log, flushLog, resetLogWriteFailureCountForTests } from '../src/lib/log.js';
import { resetRedactCache } from '../src/lib/redact.js';

const TEST_PA_HOME = join(tmpdir(), `pa-test-log-redact-${process.pid}`);

describe('log.ts redaction', () => {
  beforeEach(() => {
    // Clean up any existing test directory
    if (existsSync(TEST_PA_HOME)) {
      rmSync(TEST_PA_HOME, { recursive: true, force: true });
    }
    mkdirSync(TEST_PA_HOME, { recursive: true });
    process.env.PA_HOME = TEST_PA_HOME;
    // Each test writes its own secrets.env — drop the redaction module's
    // cached patterns or later tests redact against the FIRST test's secrets.
    resetRedactCache();
    resetLogWriteFailureCountForTests();
  });

  afterEach(async () => {
    // Flush any pending log writes
    await flushLog();
    // Clean up test directory
    if (existsSync(TEST_PA_HOME)) {
      rmSync(TEST_PA_HOME, { recursive: true, force: true });
    }
    delete process.env.PA_HOME;
  });

  it('should redact secrets in context values before logging', async () => {
    const secretsPath = join(TEST_PA_HOME, 'secrets.env');
    writeFileSync(secretsPath, `
API_KEY=sk-1234567890abcdefghijklmnop
TOKEN=xyz9876543211234567890abcdefghij
    `.trim());

    log('info', 'test-module', 'Test message', {
      apiKey: 'sk-1234567890abcdefghijklmnop',
      userToken: 'xyz9876543211234567890abcdefghij',
      normalText: 'This should not be redacted',
    });

    await flushLog();

    const logPath = join(TEST_PA_HOME, 'app.log.jsonl');
    const logContent = readFileSync(logPath, 'utf8');
    const logEntry = JSON.parse(logContent.trim());

    assert.equal(logEntry.apiKey, '<redacted:API_KEY>');
    assert.equal(logEntry.userToken, '<redacted:TOKEN>');
    assert.equal(logEntry.normalText, 'This should not be redacted');
  });

  it('should redact nested object context values', async () => {
    const secretsPath = join(TEST_PA_HOME, 'secrets.env');
    writeFileSync(secretsPath, 'SECRET=supersecret12345678');

    log('info', 'test-module', 'Nested test', {
      config: {
        apiKey: 'supersecret12345678',
        nested: {
          token: 'supersecret12345678',
        },
      },
      normal: 'unchanged',
    });

    await flushLog();

    const logPath = join(TEST_PA_HOME, 'app.log.jsonl');
    const logContent = readFileSync(logPath, 'utf8');
    const logEntry = JSON.parse(logContent.trim());

    assert.equal(logEntry.config.apiKey, '<redacted:SECRET>');
    assert.equal(logEntry.config.nested.token, '<redacted:SECRET>');
    assert.equal(logEntry.normal, 'unchanged');
  });

  it('should redact array elements in context', async () => {
    const secretsPath = join(TEST_PA_HOME, 'secrets.env');
    writeFileSync(secretsPath, 'KEY=abcdef1234567890abcdef12');

    log('info', 'test-module', 'Array test', {
      items: ['Value: abcdef1234567890abcdef12', 'Another: abcdef1234567890abcdef12'],
      normal: 'safe',
    });

    await flushLog();

    const logPath = join(TEST_PA_HOME, 'app.log.jsonl');
    const logContent = readFileSync(logPath, 'utf8');
    const logEntry = JSON.parse(logContent.trim());

    assert.deepEqual(logEntry.items, ['Value: <redacted:KEY>', 'Another: <redacted:KEY>']);
    assert.equal(logEntry.normal, 'safe');
  });

  it('should apply generic shape patterns to context values', async () => {
    log('info', 'test-module', 'Shape patterns test', {
      stripeKey: 'sk-1234567890abcdefghijklmnop',
      githubToken: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz123456',
      normalText: 'No secrets here',
    });

    await flushLog();

    const logPath = join(TEST_PA_HOME, 'app.log.jsonl');
    const logContent = readFileSync(logPath, 'utf8');
    const logEntry = JSON.parse(logContent.trim());

    assert.equal(logEntry.stripeKey, '<redacted:token>');
    assert.equal(logEntry.githubToken, '<redacted:token>');
    assert.equal(logEntry.normalText, 'No secrets here');
  });

  it('should not redact short common words in context', async () => {
    log('info', 'test-module', 'Common words test', {
      message: 'The password is password and the secret is secret',
      data: { text: 'short word abc123' },
    });

    await flushLog();

    const logPath = join(TEST_PA_HOME, 'app.log.jsonl');
    const logContent = readFileSync(logPath, 'utf8');
    const logEntry = JSON.parse(logContent.trim());

    assert.equal(logEntry.message, 'The password is password and the secret is secret');
    assert.equal(logEntry.data.text, 'short word abc123');
  });
});
// pii-scan:ignore-end
