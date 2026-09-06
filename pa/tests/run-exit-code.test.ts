// AI-179 WP-2 (2026-09-03): `pa run` must exit non-zero when a run fails.
// Pure unit tests over exitCodeForCommandResult + source pins guarding the wire
// at both ends (bin/pa.ts's dispatch site; chains.ts's spawnPa success seam).
// Tests compile to dist/tests (CJS) — source pins resolve .ts via __dirname.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { exitCodeForCommandResult } from '../src/commands/run.js';
import type { CommandResult } from '../src/types.js';

// Defensive, matches run.test.ts's module-scope convention: nothing in this file
// should ever reach a real Telegram send (handleSkillResult isn't exercised here,
// but run.js's module side effects must not be able to either).
process.env.PA_NOTIFY_DISABLED = '1';

/** Fixture builder: CommandResult with required fields only where the test cares. */
function result(overrides: Partial<CommandResult>): CommandResult {
  return { output: '', exitCode: null, ...overrides } as CommandResult;
}

describe('exitCodeForCommandResult (AI-179 WP-2)', () => {
  it('T1: success maps to 0', () => {
    assert.equal(exitCodeForCommandResult(result({ success: true, exitCode: 0 })), 0);
    assert.equal(exitCodeForCommandResult(result({ success: true, exitCode: 3 })), 0);
    assert.equal(exitCodeForCommandResult(result({ success: true, exitCode: null })), 0);
  });

  it('T2: failure with exitCode -1 (lock-busy skip) maps to 1', () => {
    assert.equal(exitCodeForCommandResult(result({ success: false, exitCode: -1 })), 1);
  });

  it('T3: failure with exitCode 2 keeps that code', () => {
    assert.equal(exitCodeForCommandResult(result({ success: false, exitCode: 2 })), 2);
  });

  it('T4: failure with null/undefined exitCode maps to 1', () => {
    assert.equal(exitCodeForCommandResult(result({ success: false, exitCode: null })), 1);
    // JS callers / torn objects can omit the field entirely (type says `number | null`)
    const torn = { success: false, output: '' } as unknown as CommandResult;
    assert.equal(exitCodeForCommandResult(torn), 1);
    // Out of the 1..255 window: 0 kept by a failed result, and >255 codes (e.g. a
    // Windows errorlevel 9009) cannot be represented, so both collapse to 1.
    assert.equal(exitCodeForCommandResult(result({ success: false, exitCode: 0 })), 1);
    assert.equal(exitCodeForCommandResult(result({ success: false, exitCode: 9009 })), 1);
  });

  it('T5: a lock-lost downgraded result shape maps to non-zero', () => {
    // Shape run.ts's downgrade block builds: worker result spread, success flipped to
    // false, error set — the worker's own exitCode (often 0) survives the spread.
    const downgraded = result({
      success: false,
      exitCode: 0,
      error: 'Lock lost (purged) mid-run — skill-exclusive:git-workflow was purged while this run held it; another process may have committed concurrently. Treat this run\'s tree mutations as unverified.',
    });
    assert.equal(exitCodeForCommandResult(downgraded), 1);
    assert.notEqual(exitCodeForCommandResult(downgraded), 0);
  });

  it('T6 source pin: bin/pa.ts case \'run\' wires the result to process.exitCode', async () => {
    // Silent-site drift guard: the import alone would pass; the WIRE is the
    // assignment inside the case block. Resolve the .ts source from dist/tests.
    const src = await readFile(join(__dirname, '..', '..', 'bin', 'pa.ts'), 'utf8');
    const caseStart = src.indexOf("case 'run':");
    assert.ok(caseStart !== -1, "bin/pa.ts must keep a `case 'run':` dispatch");
    const caseEnd = src.indexOf("case 'list':", caseStart);
    assert.ok(caseEnd !== -1, 'expected the case block to be delimited by case \'list\'');
    const block = src.slice(caseStart, caseEnd);
    assert.ok(
      block.includes('process.exitCode = exitCodeForCommandResult(result)'),
      "case 'run' must assign process.exitCode from exitCodeForCommandResult(result) — the CommandResult must not be discarded again",
    );
    assert.ok(
      src.includes("import { runCommand, exitCodeForCommandResult } from '../src/commands/run.js';"),
      'bin/pa.ts must import exitCodeForCommandResult from run.js',
    );
  });

  it('T7 source pin: chains.ts spawnPa keys success on the process exit code (the seam on_failure now sees)', async () => {
    // chains.ts is deliberately UNEDITED in WP-2 (spec §4): the exit-code change
    // repairs it for free — spawnPa's `success: code === 0` is the consumer that
    // starts seeing real skill failures now that `pa run` exits non-zero. This pin
    // fails if the seam moves, forcing whoever changes it to re-check inheritance.
    const src = await readFile(join(__dirname, '..', '..', 'src', 'lib', 'chains.ts'), 'utf8');
    const spawnPaStart = src.indexOf('function spawnPa');
    assert.ok(spawnPaStart !== -1, 'chains.ts must keep a spawnPa function');
    const seam = src.indexOf('success: code === 0');
    assert.ok(seam !== -1, 'spawnPa must resolve success from the child process exit code');
    assert.ok(seam > spawnPaStart, 'the success seam must live inside spawnPa (after its declaration)');
  });
});
