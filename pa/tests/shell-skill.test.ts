import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir as osTmpdir } from 'os';
import { filterSecretsForShell, isNoOutputSentinel, shellSkillExtraEnv, normalizeCollectedText, runCommand } from '../src/commands/run.js';
import { createTempPaHome, createTempConfig, createTempSkill, createTempSecrets, cleanup } from './helpers.js';

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

  it('returns true when agy emits preamble before NO_OUTPUT (the real bug)', () => {
    const agyOutput = [
      "Inspecting ~/.pa/rate-limit-unparseable.jsonl and summarizing entries from the last 65 minutes.",
      "I'm parsing the JSONL directly so I can return either the exact NO_OUTPUT sentinel or a report.",
      'NO_OUTPUT',
    ].join('\n');
    assert.equal(isNoOutputSentinel(agyOutput), true);
  });

  it('returns true when worker chatter is collapsed onto the same line as NO_OUTPUT', () => {
    const collapsedOutput =
      'Checking the specified `rate-limit-unparseable.jsonl` file and filtering to entries from the last 65 minutes.NO_OUTPUT';
    assert.equal(isNoOutputSentinel(collapsedOutput), true);
  });

  it('returns false for actual content', () => {
    assert.equal(isNoOutputSentinel('Worker agy hit rate limit: 429'), false);
  });

  it('returns false when NO_OUTPUT appears mid-output but not at the end', () => {
    assert.equal(isNoOutputSentinel('NO_OUTPUT\nsome actual content below'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isNoOutputSentinel(''), false);
  });
});

describe('shellSkillExtraEnv (AI-193)', () => {
  it('sets PYTHONUTF8 for a plain python command', () => {
    assert.deepEqual(shellSkillExtraEnv('python scripts/daily_digest.py'), { PYTHONUTF8: '1' });
  });

  it('sets PYTHONUTF8 for versioned and .exe variants', () => {
    assert.deepEqual(shellSkillExtraEnv('python3 run_brief.py'), { PYTHONUTF8: '1' });
    assert.deepEqual(shellSkillExtraEnv('python3.13 run_brief.py'), { PYTHONUTF8: '1' });
    assert.deepEqual(shellSkillExtraEnv('python.exe run_brief.py'), { PYTHONUTF8: '1' });
  });

  it('sets PYTHONUTF8 when the cmd string is quoted', () => {
    assert.deepEqual(shellSkillExtraEnv('"python C:/pa-checkout/pa/scripts/daily_digest.py"'), { PYTHONUTF8: '1' });
  });

  it('returns empty env for non-python commands', () => {
    assert.deepEqual(shellSkillExtraEnv('node dist/src/self-improver.js'), {});
    assert.deepEqual(shellSkillExtraEnv('powershell.exe -NoProfile -File C:\\x\\y.ps1'), {});
  });

  it('matches python only at the command position, not as an argument', () => {
    assert.deepEqual(shellSkillExtraEnv('node check.py --parser python'), {});
  });
});

describe('normalizeCollectedText (AI-193)', () => {
  it('collapses CRLF to LF', () => {
    assert.equal(normalizeCollectedText('line one\r\nline two\r\n'), 'line one\nline two\n');
  });

  it('leaves lone CR untouched', () => {
    assert.equal(normalizeCollectedText('a\rb'), 'a\rb');
  });

  it('collapses a CRLF split across collection chunks (why normalization runs once at close)', () => {
    const chunkA = 'first line\r';
    const chunkB = '\nsecond line';
    assert.equal(normalizeCollectedText(chunkA + chunkB), 'first line\nsecond line');
  });
});

describe('runCommand — python skill stdout collection (AI-193)', () => {
  let tempDir: string;
  let scriptDir: string;

  // Probe once: bare `python` is Windows/this-machine shaped; macOS CI only
  // ships python3. Skip the subprocess test when neither resolves. Single
  // command STRING on purpose — with shell:true an args array lets cmd.exe
  // mangle the quotes/parens and every probe fails, skipping the real test.
  const pyCmd = (() => {
    for (const candidate of ['python', 'python3']) {
      const probe = spawnSync(`${candidate} -c "print(1)"`, { shell: true, encoding: 'utf8' });
      if (probe.status === 0) return candidate;
    }
    return null;
  })();

  beforeEach(async () => {
    tempDir = await createTempPaHome();
    await createTempSecrets(tempDir, '');
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: ['-e', 'process.exit(1)'], check: 'echo ok', priority: 1, rate_limit_patterns: [] },
    ]);
    scriptDir = join(osTmpdir(), `pa-test-shell-skill-enc-${Date.now()}`);
    await mkdir(scriptDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanup(tempDir);
    await rm(scriptDir, { recursive: true, force: true }).catch(() => {});
  });

  it('decodes non-ASCII python output correctly and normalizes CRLF', { skip: pyCmd === null }, async () => {
    // Real producer: python text mode. Pre-fix this emitted cp1252 (Windows
    // machine codepage) and CRLF; the runner's UTF-8 collection turned the
    // em-dash into U+FFFD. The fixture asserts the round trip end-to-end
    // through runCommand's real spawn + collection path.
    const scriptPath = join(scriptDir, 'emit_nonascii.py');
    await writeFile(scriptPath, [
      'print("Archive digest \\u2014 stage one")',
      'print("middle dot \\u00b7 done")',
    ].join('\n'), 'utf8');

    await createTempSkill(tempDir, 'enc-fixture', [
      '---',
      `cmd: ${pyCmd} "${scriptPath}"`,
      'timeout: 60',
      '---',
      'prompt',
    ].join('\n'));

    const result = await runCommand('enc-fixture');
    assert.equal(result.success, true);
    assert.ok(result.output, 'expected non-empty output');
    assert.ok(!result.output.includes('\uFFFD'), `U+FFFD in output: ${JSON.stringify(result.output)}`);
    assert.ok(result.output.includes('\u2014'), `em-dash missing: ${JSON.stringify(result.output)}`);
    assert.ok(result.output.includes('\u00b7'), `middle dot missing: ${JSON.stringify(result.output)}`);
    assert.ok(!result.output.includes('\r'), `CR in output: ${JSON.stringify(result.output)}`);
    // The two printed lines arrive as two LF-separated lines.
    const lines = result.output.split('\n');
    assert.equal(lines.length, 2, `expected 2 lines, got ${lines.length}: ${JSON.stringify(result.output)}`);
  });
});
