import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterSecretsForShell, isNoOutputSentinel } from '../src/commands/run.js';

describe('filterSecretsForShell', () => {
  it('returns only declared keys', () => {
    const result = filterSecretsForShell(
      { KEY_A: 'a', KEY_B: 'b', KEY_C: 'c' },
      ['KEY_A', 'KEY_C'],
    );
    assert.deepEqual(result, { KEY_A: 'a', KEY_C: 'c' });
  });

  it('returns empty object when no secrets declared (undefined)', () => {
    const result = filterSecretsForShell({ KEY_A: 'a', KEY_B: 'b' }, undefined);
    assert.deepEqual(result, {});
  });

  it('silently skips keys not present in allSecrets', () => {
    const result = filterSecretsForShell(
      { KEY_A: 'a' },
      ['KEY_A', 'KEY_MISSING'],
    );
    assert.deepEqual(result, { KEY_A: 'a' });
  });

  it('returns empty object for empty declared array', () => {
    const result = filterSecretsForShell({ KEY_A: 'a', KEY_B: 'b' }, []);
    assert.deepEqual(result, {});
  });

  it('returns empty object when allSecrets is empty', () => {
    const result = filterSecretsForShell({}, ['KEY_A']);
    assert.deepEqual(result, {});
  });
});

describe('isNoOutputSentinel', () => {
  it('returns true for bare NO_OUTPUT', () => {
    assert.equal(isNoOutputSentinel('NO_OUTPUT'), true);
  });

  it('returns true for NO_OUTPUT with leading/trailing whitespace', () => {
    assert.equal(isNoOutputSentinel('  NO_OUTPUT  '), true);
    assert.equal(isNoOutputSentinel('\nNO_OUTPUT\n'), true);
  });

  it('returns true when Gemini emits preamble before NO_OUTPUT (the real bug)', () => {
    const geminiOutput = [
      "Inspecting ~/.pa/rate-limit-unparseable.jsonl and summarizing entries from the last 65 minutes.",
      "I'm parsing the JSONL directly so I can return either the exact NO_OUTPUT sentinel or a report.",
      'NO_OUTPUT',
    ].join('\n');
    assert.equal(isNoOutputSentinel(geminiOutput), true);
  });

  it('returns true when worker chatter is collapsed onto the same line as NO_OUTPUT', () => {
    const collapsedOutput =
      'Checking the specified `rate-limit-unparseable.jsonl` file and filtering to entries from the last 65 minutes.NO_OUTPUT';
    assert.equal(isNoOutputSentinel(collapsedOutput), true);
  });

  it('returns false for actual content', () => {
    assert.equal(isNoOutputSentinel('Worker gemini hit rate limit: 429'), false);
  });

  it('returns false when NO_OUTPUT appears mid-output but not at the end', () => {
    assert.equal(isNoOutputSentinel('NO_OUTPUT\nsome actual content below'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isNoOutputSentinel(''), false);
  });
});
