/**
 * Tests for logic.ts redaction integration
 *
 * Tests that buildWorkerResponse applies redaction to final output.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildWorkerResponse } from '../logic.js';
import { resetRedactCache } from '../../../../pa/dist/src/lib/redact.js';

const TEST_PA_HOME = join(tmpdir(), `pa-test-logic-redact-${process.pid}`);

describe('logic.ts redaction', () => {
  beforeEach(() => {
    // Reset redaction cache before each test
    resetRedactCache();
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
  });

  it('should redact secrets from agy worker output', () => {
    const secretsPath = join(TEST_PA_HOME, 'secrets.env');
    writeFileSync(secretsPath, 'BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz');

    const result = {
      success: true,
      output: '[Thought: true]\nThinking...\n[Thought: false]\nThe bot token is 1234567890:ABCdefGHIjklMNOpqrsTUVwxyz',
    };

    const response = buildWorkerResponse(result, 'agy');
    assert.equal(response, 'The bot token is <redacted:BOT_TOKEN>');
  });

  it('should redact secrets from claude worker output', () => {
    const secretsPath = join(TEST_PA_HOME, 'secrets.env');
    writeFileSync(secretsPath, 'API_KEY=sk-1234567890abcdefghijklmnop');

    const result = {
      success: true,
      output: '<thought>Planning...</thought>\nResponse with API key sk-1234567890abcdefghijklmnop',
    };

    const response = buildWorkerResponse(result, 'claude');
    assert.equal(response, 'Response with API key <redacted:API_KEY>');
  });

  it('should apply generic shape patterns to worker output', () => {
    const result = {
      success: true,
      output: 'Stripe key: sk-live_1234567890abcdefghijklmnop and GitHub token: ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    };

    const response = buildWorkerResponse(result, 'claude');
    assert.equal(response, 'Stripe key: <redacted:token> and GitHub token: <redacted:token>');
  });

  it('should not redact ordinary prose', () => {
    const result = {
      success: true,
      output: 'The quick brown fox jumps over the lazy dog. Email support@example.com for help.',
    };

    const response = buildWorkerResponse(result, 'claude');
    assert.equal(response, 'The quick brown fox jumps over the lazy dog. Email support@example.com for help.');
  });

  it('should handle empty output gracefully', () => {
    const result = {
      success: true,
      output: '',
    };

    const response = buildWorkerResponse(result, 'claude');
    assert.equal(response, '');
  });

  it('should preserve error handling', () => {
    const result = {
      success: false,
      output: '',
      error: 'Worker failed',
    };

    const response = buildWorkerResponse(result, 'claude');
    assert.equal(response, 'Sorry, I couldn\'t process that. (Worker failed)');
  });

  it('should redact secrets from evaluatorSummary', () => {
    const secretsPath = join(TEST_PA_HOME, 'secrets.env');
    writeFileSync(secretsPath, 'SECRET=supersecret12345678');

    const result = {
      success: false,
      output: '',
      evaluatorSummary: 'Analysis revealed secret: supersecret12345678',
    };

    const response = buildWorkerResponse(result, 'claude');
    assert.equal(response, 'Analysis revealed secret: <redacted:SECRET>');
  });

  it('should normalize markdown before redaction', () => {
    const secretsPath = join(TEST_PA_HOME, 'secrets.env');
    writeFileSync(secretsPath, 'TOKEN=abcdef1234567890');

    const result = {
      success: true,
      output: '**Bold** with token abcdef1234567890 and *italic* text',
    };

    const response = buildWorkerResponse(result, 'claude');
    // Markdown normalization happens first (**bold** becomes *bold*), then redaction
    assert.ok(response.includes('*Bold*'));
    assert.ok(response.includes('<redacted:TOKEN>'));
  });
});
