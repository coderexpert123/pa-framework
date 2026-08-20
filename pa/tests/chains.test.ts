/**
 * Tests for sequential workflow chains (WPG5).
 * Uses the executeChain spawnFn injection seam — ESM exports are read-only,
 * so mock.method-on-a-path-string (the draft's approach) is invalid API.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import {
  loadChain,
  executeChain,
  ChainValidationError,
} from '../src/lib/chains.js';

// Test spawn seam: records calls, returns programmed results
function makeSpawnSequencer(results: Array<{ success: boolean; output: string }>) {
  const calls: string[][] = [];
  let i = 0;
  return {
    spawnFn: async (args: string[]) => {
      calls.push(args);
      const r = results[Math.min(i, results.length - 1)];
      i++;
      return r;
    },
    calls,
    attempts: () => i,
  };
}

describe('chains', () => {
  let dir: string;

  before(async () => {
    dir = await createTempPaHome();
    await mkdir(join(dir, 'chains'), { recursive: true });
    process.env.PA_NOTIFY_DISABLED = '1'; // tests never send real notifications
  });

  after(async () => {
    delete process.env.PA_NOTIFY_DISABLED;
    await cleanup(dir);
  });

  describe('schema validation', () => {
    it('accepts a valid minimal chain', async () => {
      const yaml = `
steps:
  - skill: test-skill
`;
      await writeFile(join(dir, 'chains', 'minimal.yaml'), yaml, 'utf8');
      const { def } = await loadChain('minimal');
      assert.equal(def.steps.length, 1);
      assert.equal(def.steps[0].skill, 'test-skill');
      assert.equal(def.steps[0].on_failure, 'stop');
      assert.equal(def.report, 'stdout');
    });

    it('accepts a full-featured chain', async () => {
      const yaml = `
steps:
  - skill: update-brain
    on_failure: notify
  - skill: commit
    args: [--allow-empty]
    retry:
      max: 3
      backoff_s: 10
    on_failure: stop
  - skill: push
report: telegram
`;
      await writeFile(join(dir, 'chains', 'full.yaml'), yaml, 'utf8');
      const { def } = await loadChain('full');
      assert.equal(def.steps.length, 3);
      assert.equal(def.steps[0].skill, 'update-brain');
      assert.equal(def.steps[0].on_failure, 'notify');
      assert.equal(def.steps[1].skill, 'commit');
      assert.deepEqual(def.steps[1].args, ['--allow-empty']);
      assert.equal(def.steps[1].retry?.max, 3);
      assert.equal(def.steps[1].retry?.backoff_s, 10);
      assert.equal(def.report, 'telegram');
    });

    it('rejects unknown top-level fields (including parallel)', async () => {
      const yaml = `
steps:
  - skill: test
unknown_field: value
parallel: true
`;
      await writeFile(join(dir, 'chains', 'bad-top.yaml'), yaml, 'utf8');
      await assert.rejects(
        () => loadChain('bad-top'),
        (err: Error) => {
          assert.match(err.message, /Unknown top-level fields/);
          assert.equal(err.name, 'ChainValidationError');
          return true;
        }
      );
    });

    it('rejects unknown step fields', async () => {
      const yaml = `
steps:
  - skill: test
    unknown_field: value
`;
      await writeFile(join(dir, 'chains', 'bad-step.yaml'), yaml, 'utf8');
      await assert.rejects(
        () => loadChain('bad-step'),
        (err: Error) => err.message.includes('has unknown fields')
      );
    });

    it('rejects missing steps array', async () => {
      const yaml = `
report: stdout
`;
      await writeFile(join(dir, 'chains', 'no-steps.yaml'), yaml, 'utf8');
      await assert.rejects(
        () => loadChain('no-steps'),
        (err: Error) => err.message.includes('must be an array')
      );
    });

    it('rejects empty steps array', async () => {
      const yaml = `
steps: []
`;
      await writeFile(join(dir, 'chains', 'empty-steps.yaml'), yaml, 'utf8');
      await assert.rejects(
        () => loadChain('empty-steps'),
        (err: Error) => err.message.includes('at least one step')
      );
    });

    it('rejects missing skill field', async () => {
      const yaml = `
steps:
  - args: [--foo]
`;
      await writeFile(join(dir, 'chains', 'no-skill.yaml'), yaml, 'utf8');
      await assert.rejects(
        () => loadChain('no-skill'),
        (err: Error) => err.message.includes('non-empty "skill"')
      );
    });

    it('rejects invalid on_failure value', async () => {
      const yaml = `
steps:
  - skill: test
    on_failure: invalid_value
`;
      await writeFile(join(dir, 'chains', 'bad-on-failure.yaml'), yaml, 'utf8');
      await assert.rejects(
        () => loadChain('bad-on-failure'),
        (err: Error) => err.message.includes('on_failure must be one of')
      );
    });

    it('rejects invalid report value', async () => {
      const yaml = `
steps:
  - skill: test
report: invalid
`;
      await writeFile(join(dir, 'chains', 'bad-report.yaml'), yaml, 'utf8');
      await assert.rejects(
        () => loadChain('bad-report'),
        (err: Error) => err.message.includes('"telegram" or "stdout"')
      );
    });

    it('rejects missing chain file', async () => {
      await assert.rejects(
        () => loadChain('nonexistent'),
        (err: Error) => {
          assert.match(err.message, /not found at/);
          return true;
        }
      );
    });
  });

  describe('sequential execution (via spawnFn seam)', () => {
    it('executes steps sequentially', async () => {
      const yaml = `
steps:
  - skill: step-one
  - skill: step-two
  - skill: step-three
report: stdout
`;
      await writeFile(join(dir, 'chains', 'sequential.yaml'), yaml, 'utf8');

      const seq = makeSpawnSequencer([
        { success: true, output: 'A' },
        { success: true, output: 'B' },
        { success: true, output: 'C' },
      ]);
      const result = await executeChain('sequential', { spawnFn: seq.spawnFn });
      assert.equal(result.success, true);
      assert.equal(seq.attempts(), 3);
      const skillNames = seq.calls.map(c => c[1]);
      assert.deepEqual(skillNames, ['step-one', 'step-two', 'step-three']);
    });

    it('stops on failure when on_failure=stop (default)', async () => {
      const yaml = `
steps:
  - skill: step-one
  - skill: failing-step
  - skill: step-three
report: stdout
`;
      await writeFile(join(dir, 'chains', 'stop-on-fail.yaml'), yaml, 'utf8');

      const seq = makeSpawnSequencer([
        { success: true, output: 'A' },
        { success: false, output: 'FAILED' },
        { success: true, output: 'C' }, // should never be called
      ]);
      const result = await executeChain('stop-on-fail', { spawnFn: seq.spawnFn });
      assert.equal(result.success, false);
      assert.equal(seq.attempts(), 2, 'stops after failing step — step-three not reached');
    });

    it('continues on failure when on_failure=continue', async () => {
      const yaml = `
steps:
  - skill: step-one
  - skill: failing-step
    on_failure: continue
  - skill: step-three
report: stdout
`;
      await writeFile(join(dir, 'chains', 'continue-on-fail.yaml'), yaml, 'utf8');

      const seq = makeSpawnSequencer([
        { success: true, output: 'A' },
        { success: false, output: 'FAILED' },
        { success: true, output: 'C' },
      ]);
      const result = await executeChain('continue-on-fail', { spawnFn: seq.spawnFn });
      assert.equal(result.success, false, 'overall failure (one step failed)');
      assert.equal(seq.attempts(), 3, 'all steps executed despite the failure');
    });
  });

  describe('retry with backoff (via spawnFn seam)', () => {
    it('retries until success within max attempts', async () => {
      const yaml = `
steps:
  - skill: flaky-step
    retry:
      max: 3
      backoff_s: 0
report: stdout
`;
      await writeFile(join(dir, 'chains', 'retry-test.yaml'), yaml, 'utf8');

      let attempts = 0;
      const spawnFn = async () => {
        attempts++;
        if (attempts < 3) return { success: false, output: 'temp fail' };
        return { success: true, output: 'ok' };
      };
      const result = await executeChain('retry-test', { spawnFn });
      assert.equal(result.success, true);
      assert.equal(attempts, 3);
    });

    it('stops retrying after max attempts and fails', async () => {
      const yaml = `
steps:
  - skill: always-failing
    retry:
      max: 2
      backoff_s: 0
report: stdout
`;
      await writeFile(join(dir, 'chains', 'retry-exhaust.yaml'), yaml, 'utf8');

      let attempts = 0;
      const spawnFn = async () => {
        attempts++;
        return { success: false, output: 'always fails' };
      };
      const result = await executeChain('retry-exhaust', { spawnFn });
      assert.equal(result.success, false);
      assert.equal(attempts, 2, 'gives up after max attempts');
    });
  });

  describe('report generation', () => {
    it('success report has the chain name and step count', async () => {
      const yaml = `
steps:
  - skill: step-one
  - skill: step-two
report: stdout
`;
      await writeFile(join(dir, 'chains', 'success-report.yaml'), yaml, 'utf8');
      const seq = makeSpawnSequencer([
        { success: true, output: 'A' },
        { success: true, output: 'B' },
      ]);
      const result = await executeChain('success-report', { spawnFn: seq.spawnFn });
      assert.equal(result.success, true);
      assert.ok(result.report.includes('2/2'), `report mentions 2/2: ${result.report}`);
    });

    it('failure report notes the failure', async () => {
      const yaml = `
steps:
  - skill: step-one
  - skill: failing-step
    on_failure: continue
  - skill: step-three
report: stdout
`;
      await writeFile(join(dir, 'chains', 'fail-report.yaml'), yaml, 'utf8');
      const seq = makeSpawnSequencer([
        { success: true, output: 'A' },
        { success: false, output: 'FAILED' },
        { success: true, output: 'C' },
      ]);
      const result = await executeChain('fail-report', { spawnFn: seq.spawnFn });
      assert.equal(result.success, false);
      assert.ok(result.report.includes('2/3') || result.report.includes('1 failed'), `report mentions the failure: ${result.report}`);
    });
  });
});
