/**
 * Tests for the golden-task eval gate (Wave H WPH1).
 * Tests formatEvalDetail (pure function) and the eval-gate result shape.
 * The subprocess-dependent runEvalGate is covered by the integration gate.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatEvalDetail, type EvalGateResult } from '../src/lib/eval-gate.js';

describe('eval-gate', () => {
  describe('formatEvalDetail', () => {
    it('formats mixed results', () => {
      const result: EvalGateResult = {
        pass: 2,
        fail: 1,
        skipped: 3,
        tasks: []
      };
      const detail = formatEvalDetail(result);
      assert.ok(detail.includes('2 passed'));
      assert.ok(detail.includes('1 failed'));
      assert.ok(detail.includes('3 skipped'));
    });

    it('formats all-pass results', () => {
      const result: EvalGateResult = { pass: 5, fail: 0, skipped: 0, tasks: [] };
      const detail = formatEvalDetail(result);
      assert.ok(detail.includes('5 passed'));
      assert.ok(!detail.includes('failed'));
    });

    it('formats empty results as no-tasks', () => {
      const result: EvalGateResult = { pass: 0, fail: 0, skipped: 0, tasks: [] };
      const detail = formatEvalDetail(result);
      assert.ok(detail.includes('no tasks'));
    });
  });

  describe('runEvalGate shape', () => {
    it('returns the expected result shape on script-not-found (fail-soft)', async () => {
      const { runEvalGate } = await import('../src/lib/eval-gate.js');
      // With a nonexistent script path (or missing PA_HOME), the gate
      // fails soft and returns empty counts — never throws.
      const result = await runEvalGate({ skillName: 'test', fullEval: false });
      assert.equal(typeof result.pass, 'number');
      assert.equal(typeof result.fail, 'number');
      assert.equal(typeof result.skipped, 'number');
      assert.ok(Array.isArray(result.tasks));
    });
  });
});
