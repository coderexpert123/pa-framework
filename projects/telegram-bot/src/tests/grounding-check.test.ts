import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSuspiciousDescription } from '../grounding-check.js';

describe('isSuspiciousDescription', () => {
  it('undefined is not suspicious (missing description is a separate, handled gap)', () => {
    assert.equal(isSuspiciousDescription(undefined), false);
  });

  it('empty string is not suspicious', () => {
    assert.equal(isSuspiciousDescription(''), false);
    assert.equal(isSuspiciousDescription('   '), false);
  });

  it('a normal curated description is not suspicious', () => {
    assert.equal(isSuspiciousDescription('Marathon training plans, workout schedules, and race prep.'), false);
  });

  it('flags a description ending in a question mark', () => {
    assert.equal(isSuspiciousDescription('What were you trying to say?'), true);
  });

  it('flags a voice-message-clobbered description (2026-08-05 ekadashi incident)', () => {
    assert.equal(isSuspiciousDescription('[Voice message] So, what do I need to do for today?'), true);
  });

  it('flags an [Audio file] / [Video note] clobber the same way', () => {
    assert.equal(isSuspiciousDescription('[Audio file] transcript text'), true);
    assert.equal(isSuspiciousDescription('[Video note] transcript text'), true);
  });

  it('flags a leaked "Description set." confirmation reply', () => {
    assert.equal(isSuspiciousDescription('Description set.'), true);
  });

  it('flags a leaked assistant clarifying reply (thread 2839 incident)', () => {
    assert.equal(isSuspiciousDescription('It looks like your message might have been cut short. What were you trying to say?'), true);
  });

  it('is case-insensitive on the prefix patterns', () => {
    assert.equal(isSuspiciousDescription('DESCRIPTION SET.'), true);
    assert.equal(isSuspiciousDescription('it Looks Like something went wrong.'), true);
  });

  it('flags a leaked attachment marker', () => {
    assert.equal(isSuspiciousDescription("what's this saying?\n\n[ATTACHMENT: C:\\path\\to\\file.jpg"), true);
  });

  it('does not flag a description that merely contains a question mark mid-sentence', () => {
    assert.equal(isSuspiciousDescription('Weather queries (e.g. "is it raining?") and nearby-place lookups.'), false);
  });

  it('does not flag a description that happens to start with a similar-but-different word', () => {
    assert.equal(isSuspiciousDescription('Descriptions of accounting workflows and reconciliation.'), false);
  });
});
