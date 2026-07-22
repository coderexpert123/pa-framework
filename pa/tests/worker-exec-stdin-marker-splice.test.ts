import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, chmod, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { executeWorker } from '../src/workers.js';
import type { WorkerConfig } from '../src/types.js';

// Regression guard for the 2026-07-22 fix to the "insert extraArgs before the
// trailing stdin marker '-'" splice in worker-exec.ts.
//
// Codex's live config.yaml args end in a bare '-' (its stdin marker). The
// splice used to only fire when extraArgs[0] === 'resume', so a FRESH
// (non-resume) dispatch carrying only tunable args (e.g. buildDispatchExtraArgs
// resolving `-c model_reasoning_effort=high` from a topic's /effort setting)
// fell into the plain-append branch and landed AFTER the trailing '-' --
// a position codex does not accept args in, so tunables silently did nothing
// (or broke the dispatch) on every non-resume message. The fix generalizes
// the condition to fire whenever extraArgs is non-empty and worker.args ends
// in a bare '-', regardless of what extraArgs[0] is.

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  await createTempSecrets(tempDir, '');
  scriptDir = join(tmpdir(), `pa-test-wexec-stdin-splice-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    input_mode: 'stdin-text',
    check_timeout: 5,
    ...overrides,
  };
}

// A stub that writes the full argv it received to `resultFile`, one dump per
// invocation. Mirrors the pattern in worker-exec-arg-injection.test.ts.
async function writeArgvDumpStub(baseName: string, resultFile: string): Promise<string> {
  const path = join(scriptDir, `${baseName}.cmd`);
  if (process.platform === 'win32') {
    await writeFile(path, `@echo off\r\necho %*>>"${resultFile}"\r\n`, 'utf8');
  } else {
    await writeFile(path, `#!/bin/sh\necho "$@" >> "${resultFile}"\n`, 'utf8');
    await chmod(path, 0o755);
  }
  return path;
}

describe('worker-exec stdin-marker splice (codex trailing "-")', () => {
  it('a FRESH (non-resume) dispatch with tunable-only extraArgs lands them BEFORE the trailing "-"', async () => {
    const resultFile = join(scriptDir, 'result-fresh.txt');
    const stubPath = await writeArgvDumpStub('codex', resultFile);

    // Shape mirrors the live codex config.yaml: [..., '-C', 'D:/Personal Assistant', '-']
    const worker = makeWorker({
      name: 'codex',
      command: stubPath,
      args: ['exec', '-C', 'D:/Personal Assistant', '-'],
      input_mode: 'stdin-text',
    });

    const result = await executeWorker(worker, 'test prompt', {
      timeout: 10,
      // Fresh dispatch: buildDispatchExtraArgs with no baseArgs -- extraArgs[0]
      // is a tunable flag, NOT the literal string 'resume'.
      extraArgs: ['-c', 'model_reasoning_effort=high'],
    });

    assert.equal(result.exitCode, 0, `stub should have run cleanly: ${JSON.stringify(result)}`);
    const received = (await readFile(resultFile, 'utf8').catch(() => '')).trim();
    assert.ok(received.length > 0, 'expected the stub to have received some argv');

    // The tunable flag must appear, and the trailing marker '-' must still be
    // the LAST token -- not swallowed, not preceded by nothing.
    const tunableIdx = received.indexOf('model_reasoning_effort=high');
    assert.ok(tunableIdx >= 0, `expected the tunable value to reach the stub, got: ${JSON.stringify(received)}`);

    // Split on whitespace (tokens may be quoted) and check the last non-empty
    // token is exactly '-' (possibly quoted), with the tunable tokens before it.
    const tokens = received.split(/\s+/).filter((t) => t.length > 0);
    const lastToken = tokens[tokens.length - 1].replace(/^"|"$/g, '');
    assert.equal(lastToken, '-', `expected trailing stdin marker '-' to remain last, got tokens: ${JSON.stringify(tokens)}`);

    const lastTokenIdx = received.lastIndexOf(tokens[tokens.length - 1]);
    assert.ok(tunableIdx < lastTokenIdx,
      `expected tunable args before the trailing '-' marker, got: ${JSON.stringify(received)}`);
  });

  it('regression: an EXISTING resume dispatch (extraArgs[0] === "resume") still splices before the trailing "-"', async () => {
    const resultFile = join(scriptDir, 'result-resume.txt');
    const stubPath = await writeArgvDumpStub('codex', resultFile);

    const worker = makeWorker({
      name: 'codex',
      command: stubPath,
      args: ['exec', '-C', 'D:/Personal Assistant', '-'],
      input_mode: 'stdin-text',
    });

    // Mirrors buildDispatchExtraArgs(state, worker, buildResumeArgs(session)):
    // baseArgs (resume + session id) followed by resolved tunable args.
    const result = await executeWorker(worker, 'test prompt', {
      timeout: 10,
      extraArgs: ['resume', 'session-abc123', '-c', 'model_reasoning_effort=high'],
    });

    assert.equal(result.exitCode, 0, `stub should have run cleanly: ${JSON.stringify(result)}`);
    const received = (await readFile(resultFile, 'utf8').catch(() => '')).trim();

    const resumeIdx = received.indexOf('resume');
    const tunableIdx = received.indexOf('model_reasoning_effort=high');
    assert.ok(resumeIdx >= 0 && tunableIdx >= 0, `expected both resume and tunable args to reach the stub, got: ${JSON.stringify(received)}`);

    const tokens = received.split(/\s+/).filter((t) => t.length > 0);
    const lastToken = tokens[tokens.length - 1].replace(/^"|"$/g, '');
    assert.equal(lastToken, '-', `expected trailing stdin marker '-' to remain last, got tokens: ${JSON.stringify(tokens)}`);

    const lastTokenIdx = received.lastIndexOf(tokens[tokens.length - 1]);
    assert.ok(resumeIdx < lastTokenIdx && tunableIdx < lastTokenIdx,
      `expected resume+tunable args before the trailing '-' marker, got: ${JSON.stringify(received)}`);
  });

  it('regression: a non-codex-shaped stdin worker (args NOT ending in "-") is unaffected -- extraArgs simply appended', async () => {
    const resultFile = join(scriptDir, 'result-nonstdin-marker.txt');
    const stubPath = await writeArgvDumpStub('claudefamily', resultFile);

    // e.g. claude/zclaude-shaped args: no trailing bare '-'.
    const worker = makeWorker({
      name: 'zclaude',
      command: stubPath,
      args: ['--print', '--output-format', 'stream-json'],
      input_mode: 'stdin-json',
    });

    const result = await executeWorker(worker, 'test prompt', {
      timeout: 10,
      extraArgs: ['--model', 'opus'],
    });

    assert.equal(result.exitCode, 0, `stub should have run cleanly: ${JSON.stringify(result)}`);
    const received = (await readFile(resultFile, 'utf8').catch(() => '')).trim();

    const tokens = received.split(/\s+/).filter((t) => t.length > 0);
    // Plain append: worker.args followed by extraArgs, unchanged from before this fix.
    assert.deepEqual(
      tokens.map((t) => t.replace(/^"|"$/g, '')),
      ['--print', '--output-format', 'stream-json', '--model', 'opus'],
      `expected plain append order for a non-'-'-terminated worker, got: ${JSON.stringify(received)}`,
    );
  });
});
