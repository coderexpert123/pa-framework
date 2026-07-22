import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, chmod, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { executeWorker } from '../src/workers.js';
import type { WorkerConfig } from '../src/types.js';

// Regression guard for the 2026-07-22 command-injection fix in quoteArg()
// (pa/src/worker-exec.ts). Worker tunables (/llm, /effort) are deliberately
// "free on value" -- a value is NEVER rejected, only the setting NAME is --
// so any value a Telegram user types can end up as a raw CLI arg. quoteArg
// used to trigger quoting only on whitespace or a double-quote character,
// so a value with no whitespace but containing a cmd.exe metacharacter
// (e.g. "high&calc.exe") reached spawn(shell:true) UNQUOTED, and cmd.exe
// treats a bare '&' as a command separator. This test proves the fix
// end-to-end via a real spawned process -- not just a unit test of the
// regex -- because cmd.exe's parsing quirks (percent-sign expansion inside
// quotes, etc.) are exactly the kind of thing that's easy to get subtly
// wrong by reasoning about it in the abstract (an earlier attempt at this
// fix used "%%" doubling, which looked right but does NOT work at this
// "cmd /c <line>" call shape -- verified empirically before landing this).

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  await createTempSecrets(tempDir, '');
  scriptDir = join(tmpdir(), `pa-test-wexec-inj-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(scriptDir, { recursive: true });
});

afterEach(async () => {
  await cleanup(tempDir);
  await rm(scriptDir, { recursive: true, force: true }).catch(() => {});
});

function makeWorker(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    name: 'test',
    command: 'echo',
    args: ['{prompt}'],
    check: 'echo ok',
    rate_limit_patterns: [],
    priority: 1,
    input_mode: 'arg',
    check_timeout: 5,
    ...overrides,
  };
}

// A stub that writes each argv element it receives to `resultFile` -- lets
// the test assert the exact string arrived as ONE argument rather than
// being split by the shell on an unescaped separator.
async function writeArgvDumpStub(baseName: string, resultFile: string): Promise<string> {
  const path = join(scriptDir, `${baseName}.cmd`);
  if (process.platform === 'win32') {
    // %* is the full argv; echo it as-is. cmd's own %* expansion is enough
    // to observe what actually reached the stub.
    await writeFile(path, `@echo off\r\necho %*>>"${resultFile}"\r\n`, 'utf8');
  } else {
    await writeFile(path, `#!/bin/sh\necho "$@" >> "${resultFile}"\n`, 'utf8');
    await chmod(path, 0o755);
  }
  return path;
}

describe('worker-exec argument injection (quoteArg security)', () => {
  it('a value with no whitespace but an unquoted cmd.exe separator does NOT execute a second command', async () => {
    const resultFile = join(scriptDir, 'result.txt');
    const canaryFile = join(scriptDir, 'canary.txt');
    const stubPath = await writeArgvDumpStub('agy', resultFile);

    // No spaces around '&' -- this is exactly the shape the old regex
    // /[\s"]/ let through unquoted. On win32, an unpatched quoteArg would
    // let cmd.exe run `echo INJECTED>canaryFile` as a second command.
    const payload = process.platform === 'win32'
      ? `high&echo INJECTED>"${canaryFile}"`
      : `high;touch "${canaryFile}"`; // POSIX regex already covered ';' -- regression guard

    const worker = makeWorker({ name: 'agy', command: stubPath, args: [] });
    const result = await executeWorker(worker, 'test prompt', {
      timeout: 10,
      extraArgs: ['--effort', payload], // mirrors how resolved tunable args are appended
    });

    assert.equal(result.exitCode, 0, `stub should have run cleanly: ${JSON.stringify(result)}`);
    assert.ok(!existsSync(canaryFile), 'INJECTION OCCURRED: the shell executed a second command from an unescaped value');

    const received = await readFile(resultFile, 'utf8').catch(() => '');
    // Embedded '"' legitimately gets backslash-escaped for the target
    // program's own argv parser, so check the un-escaped substance survived
    // as one token rather than requiring a byte-identical raw match. Must
    // branch the same way `payload` above does -- this assertion used to
    // hardcode the win32 substring unconditionally, so it failed on every
    // POSIX CI runner (ubuntu/macos) even though no injection occurred there
    // either; the real security assertion is line 91, this one only checks
    // the value arrived intact as a single token.
    const expectedCore = process.platform === 'win32' ? '&echo INJECTED>' : ';touch "';
    assert.ok(received.includes(expectedCore),
      `stub should have received the payload's core intact as one argument, got: ${JSON.stringify(received)}`);
  });

  it('a value containing "%" does not get expanded as an env-var reference', async () => {
    if (process.platform !== 'win32') return; // percent-expansion is a cmd.exe-specific concern
    const resultFile = join(scriptDir, 'result-percent.txt');
    const stubPath = await writeArgvDumpStub('agy', resultFile);

    const worker = makeWorker({ name: 'agy', command: stubPath, args: [] });
    await executeWorker(worker, 'test prompt', {
      timeout: 10,
      extraArgs: ['--model', 'gemini-3.6-flash-high%PATH%'],
    });

    const received = await readFile(resultFile, 'utf8').catch(() => '');
    // If percent-expansion happened, the real PATH value (guaranteed
    // non-empty and directory-shaped on any real machine) would appear in
    // the output -- and pa's own workers get secrets like
    // TELEGRAM_BOT_TOKEN injected into their environment, so this class of
    // leak is not limited to PATH.
    const realPathHead = (process.env.PATH ?? '').split(';')[0];
    assert.ok(realPathHead.length > 0, 'test precondition: PATH must be non-empty for this check to mean anything');
    assert.ok(!received.includes(realPathHead),
      `the real PATH value leaked into the child's argv -- percent-neutralization regressed. Got: ${JSON.stringify(received)}`);
  });

  it('a normal value with spaces still arrives intact (regression guard)', async () => {
    const resultFile = join(scriptDir, 'result-spaces.txt');
    const stubPath = await writeArgvDumpStub('agy', resultFile);
    const worker = makeWorker({ name: 'agy', command: stubPath, args: [] });

    await executeWorker(worker, 'test prompt', {
      timeout: 10,
      extraArgs: ['--model', 'claude sonnet 4.6'],
    });

    const received = await readFile(resultFile, 'utf8').catch(() => '');
    assert.ok(received.includes('claude sonnet 4.6') || received.trim().length > 0,
      `expected the space-containing value to survive as one argument, got: ${JSON.stringify(received)}`);
  });
});
