// Effort-projection tests (spec WP-B, 0.1.5). The known-bad probe: a
// knobless worker (agyc) + an S5 need must yield the EXPLICIT
// 'recategorize' outcome, never a silent downgrade.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { projectEffort, DEFAULT_EFFORT_PROJECTION } from '../src/lib/model-router/effort-projection.js';
import type { EffortScore } from '../src/types.js';
import type { ProjectionOutcome } from '../src/lib/model-router/effort-projection.js';

function appliedValue(score: EffortScore, worker: string, cfg?: Record<string, any>): string {
  const got = projectEffort(score, worker, cfg as any);
  assert.equal(got.applied, true, `expected applied for ${worker} S${score}`);
  return (got as { value: string }).value;
}

function outcomeOf(score: EffortScore, worker: string, cfg?: Record<string, any>): { outcome: string; detail: string } {
  const got = projectEffort(score, worker, cfg as any);
  assert.equal(got.applied, false, `expected explicit non-application for ${worker} S${score}`);
  return got as { outcome: string; detail: string };
}

describe('model-router effort projection', () => {
  it('codex maps S1..S5 onto minimal/low/medium/high', () => {
    assert.equal(appliedValue(1, 'codex'), 'minimal');
    assert.equal(appliedValue(2, 'codex'), 'low');
    assert.equal(appliedValue(3, 'codex'), 'medium');
    assert.equal(appliedValue(4, 'codex'), 'medium');
    assert.equal(appliedValue(5, 'codex'), 'high');
  });

  it('zclaude/claude/kgclaude map S5 to max and S1 to low', () => {
    for (const w of ['zclaude', 'claude', 'kgclaude']) {
      assert.equal(appliedValue(5, w), 'max');
      assert.equal(appliedValue(1, w), 'low');
    }
  });

  it('knobless worker (agyc) + S5 -> EXPLICIT recategorize (known-bad probe)', () => {
    const got = outcomeOf(5, 'agyc');
    assert.equal(got.outcome, 'recategorize');
    assert.ok(got.detail.length > 0);
  });

  it('devin and agy are also tunable-none (explicit recategorize)', () => {
    assert.equal(outcomeOf(4, 'devin').outcome, 'recategorize');
    assert.equal(outcomeOf(4, 'agy').outcome, 'recategorize');
  });

  it('an unknown worker -> explicit nearest', () => {
    const got = outcomeOf(5, 'worker-x');
    assert.equal(got.outcome, 'nearest');
    assert.ok(got.detail.length > 0);
  });

  it('a config override wins over the default map', () => {
    assert.equal(appliedValue(3, 'codex', { codex: { tunable: 'effort', map: { 3: 'custom' } } }), 'custom');
  });

  it('config override can mark a worker knobless', () => {
    assert.equal(outcomeOf(5, 'codex', { codex: { tunable: 'none' } }).outcome, 'recategorize');
  });

  it('defaults table shape: effort workers have maps, knobless do not', () => {
    assert.equal(DEFAULT_EFFORT_PROJECTION.zclaude.tunable, 'effort');
    assert.equal(DEFAULT_EFFORT_PROJECTION.agyc.tunable, 'none');
  });
});
