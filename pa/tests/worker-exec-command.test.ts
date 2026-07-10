import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, chmod } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { executeWorker } from '../src/workers.js';
import type { WorkerConfig } from '../src/types.js';

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  // Write empty secrets.env to prevent real Telegram alerts during tests
  await createTempSecrets(tempDir, '');
  scriptDir = join(tmpdir(), `pa-test-wexec-cmd-${Date.now()}`);
  await mkdir(scriptDir, { recursive: true });
});

afterEach(async () => {
  await cleanup(tempDir);
  const { rm } = await import('fs/promises');
  try { await rm(scriptDir, { recursive: true, force: true }); } catch {}
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

// Writes a stub CLI script named exactly `<baseName>.cmd` (Windows) or
// `<baseName>.cmd` shell script (POSIX, executable bit set) that echoes
// `marker` to stdout. spawn() always runs with shell:true, so both forms
// execute correctly regardless of platform.
async function writeStub(baseName: string, marker: string): Promise<string> {
  const path = join(scriptDir, `${baseName}.cmd`);
  if (process.platform === 'win32') {
    await writeFile(path, `@echo off\r\necho ${marker}\r\n`, 'utf8');
  } else {
    await writeFile(path, `#!/bin/sh\necho ${marker}\n`, 'utf8');
    await chmod(path, 0o755);
  }
  return path;
}

describe('worker-exec command contract (no name-based rewriting)', () => {
  it('spawns worker.command verbatim for a gemini-named worker pointed at a gemini.cmd stub', async () => {
    // Regression guard: worker-exec.ts used to rewrite any worker named
    // "gemini" whose command was "gemini" or ended in "gemini.cmd" to the
    // machine-specific D:/gemini-shim/gemini.cmd, ignoring the configured
    // command entirely. That made the scaffolded default config unusable
    // on every machine except the original maintainer's.
    const stubPath = await writeStub('gemini', 'MARKER_GEMINI_CONTRACT');
    const worker = makeWorker({
      name: 'gemini',
      command: stubPath,
      args: [],
      input_mode: 'arg',
    });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });
    assert.ok(result.output.includes('MARKER_GEMINI_CONTRACT'),
      `Expected stub output, got: ${JSON.stringify(result)}`);
  });

  it('spawns worker.command verbatim for an agy-named worker pointed at an agy.cmd stub', async () => {
    // Same rewrite existed for "agy" -> D:/gemini-shim/agy.cmd.
    const stubPath = await writeStub('agy', 'MARKER_AGY_CONTRACT');
    const worker = makeWorker({
      name: 'agy',
      command: stubPath,
      args: [],
      input_mode: 'arg',
    });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });
    assert.ok(result.output.includes('MARKER_AGY_CONTRACT'),
      `Expected stub output, got: ${JSON.stringify(result)}`);
  });
});
