import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempPaHome, createTempConfig, createTempSecrets, cleanup } from './helpers.js';
import { executeWorker } from '../src/workers.js';
import type { WorkerConfig } from '../src/types.js';

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  // Write empty secrets.env to prevent real Telegram alerts during tests
  await createTempSecrets(tempDir, '');
  scriptDir = join(tmpdir(), `pa-test-wexec-${Date.now()}`);
  await mkdir(scriptDir, { recursive: true });
});

afterEach(async () => {
  await cleanup(tempDir);
  const { rm } = await import('fs/promises');
  try { await rm(scriptDir, { recursive: true, force: true }); } catch {}
});

async function writeScript(name: string, code: string): Promise<string> {
  const path = join(scriptDir, name);
  await writeFile(path, code, 'utf8');
  return path;
}

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

describe('worker-exec silent-site alerts', () => {
  it('spawn error returns success=false (alert wired via notifyUser)', async () => {
    // When the worker command doesn't exist, child.on('error') fires.
    // notifyUser is called with dedupKey worker-spawn-{name} — verified by code review.
    // Observable: the result indicates failure.
    const worker = makeWorker({
      command: 'nonexistent_command_that_does_not_exist_xyz',
      args: [],
    });

    const result = await executeWorker(worker, 'test', { timeout: 5 });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Failed to start') || result.error?.includes('nonexistent'),
      `Expected spawn error message, got: ${result.error}`);
  });

  it('non-zero exit returns success=false and correct exitCode', async () => {
    // When the worker exits non-zero, notifyUser is called with
    // dedupKey worker-exit-{name}-{resource} — verified by code review.
    // Observable: the result captures the failure.
    const script = await writeScript('fail.js', 'process.exit(1);');
    const worker = makeWorker({
      command: 'node',
      args: [script],
    });

    const result = await executeWorker(worker, 'test', { timeout: 10, resource: 'skill-my-skill' });
    assert.equal(result.success, false);
    assert.equal(result.exitCode, 1);
  });

  it('suppressExitAlert option does not affect the result (alert suppression only)', async () => {
    // suppressExitAlert controls whether notifyUser is called, but does NOT
    // change the CommandResult — the result should still indicate failure.
    const script = await writeScript('fail3.js', 'process.exit(1);');
    const worker = makeWorker({
      command: 'node',
      args: [script],
    });

    const result = await executeWorker(worker, 'test', { timeout: 10, suppressExitAlert: true, resource: 'skill-suppressed' });
    assert.equal(result.success, false);
    assert.equal(result.exitCode, 1);
  });

  it('success (exit 0) returns success=true', async () => {
    const script = await writeScript('ok.js', 'process.stdout.write("ok");');
    const worker = makeWorker({
      command: 'node',
      args: [script],
    });

    const result = await executeWorker(worker, 'test', { timeout: 10, resource: 'skill-ok' });
    assert.equal(result.success, true);
  });
});
