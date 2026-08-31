import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOperatorArgsBlock } from '../src/commands/run.js';

test('buildOperatorArgsBlock returns correctly formatted block', () => {
  const sample = 'Focus on the invoice reconciliation section only';
  const result = buildOperatorArgsBlock(sample);

  assert.ok(result.includes('## Operator arguments (this run)'), 'heading line present');
  assert.ok(result.includes('Treat these as if the operator typed them alongside the skill trigger; they scope and constrain this run only.'), 'trailing instruction present');
  assert.ok(result.includes(sample), 'passed text appears verbatim');
});

test('buildOperatorArgsBlock with empty string still builds a block (helper is dumb)', () => {
  const empty = '';
  const result = buildOperatorArgsBlock(empty);

  // Helper does NOT trim — the guard lives in runCommand
  assert.ok(result.includes('## Operator arguments (this run)'), 'heading line present even for empty');
  assert.ok(result.includes('Treat these as if the operator typed them alongside the skill trigger; they scope and constrain this run only.'), 'trailing instruction present');
  assert.ok(result.includes(''), 'empty string included (helper is dumb on purpose)');
});

test('buildOperatorArgsBlock with whitespace string still builds a block (helper is dumb)', () => {
  const whitespace = '   ';
  const result = buildOperatorArgsBlock(whitespace);

  // Helper does NOT trim — the guard lives in runCommand
  assert.ok(result.includes('## Operator arguments (this run)'), 'heading line present');
  assert.ok(result.includes('Treat these as if the operator typed them alongside the skill trigger; they scope and constrain this run only.'), 'trailing instruction present');
  assert.ok(result.includes(whitespace), 'whitespace included verbatim (helper is dumb on purpose)');
});
