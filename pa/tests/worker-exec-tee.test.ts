import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { executeWorker } from '../src/workers.js';
import type { WorkerConfig } from '../src/types.js';

/**
 * Timing-free design (2026-08-15, post-integration fix): the original
 * version raced a fixed 100ms sleep against the worker-pids registry while
 * the stub ran — under the FULL suite, test files run concurrently and
 * worker-exec's machine-wide admission slots (PA_MAX_CONCURRENT_WORKERS,
 * AI-096) queue spawns behind other files' workers, so the race was lost
 * suite-only; lengthening the stubs then starved sibling tests' slots.
 * Instead, each stub prints the AGY_TEE_OUT value IT SAW to stdout — the
 * assertion runs on the completed result and never depends on spawn timing.
 */
describe('worker-exec tee wiring (agy)', () => {
  let tempDir: string;
  let origTeeOut: string | undefined;

  beforeEach(async () => {
    origTeeOut = process.env.AGY_TEE_OUT;
    delete process.env.AGY_TEE_OUT;
    tempDir = await createTempPaHome();
    await createTempSecrets(tempDir, '');
  });

  afterEach(async () => {
    if (origTeeOut !== undefined) {
      process.env.AGY_TEE_OUT = origTeeOut;
    } else {
      delete process.env.AGY_TEE_OUT;
    }
    await cleanup(tempDir);
  });

  const ENV_REPORT_STUB = ['-e', 'process.stdout.write("TEE=" + (process.env.AGY_TEE_OUT || "UNSET"))'];

  function makeWorker(name: string, extraEnv?: Record<string, string>) {
    const worker: WorkerConfig = {
      name,
      command: 'node',
      args: [...ENV_REPORT_STUB],
      check: 'echo ok',
      rate_limit_patterns: [],
      priority: 1,
      input_mode: 'arg',
      check_timeout: 5,
    };
    return { worker, opts: extraEnv ? { env: extraEnv } : undefined };
  }

  it('agy spawn sets AGY_TEE_OUT and creates the tee dir; path is contextId-keyed', async () => {
    const { worker, opts } = makeWorker('agy');
    const contextId = 'test-ctx-1';

    const result = await executeWorker(worker, '', {
      timeout: 15,
      idleTimeout: 10,
      resource: 'test-skill',
      contextId,
      ...(opts ?? {}),
    });

    const m = /TEE=(.*)/.exec(result.output ?? '');
    assert.ok(m, `worker should have reported its AGY_TEE_OUT; got: ${JSON.stringify(result.output)}`);
    const reported = m[1].trim();
    assert.notEqual(reported, 'UNSET', 'agy spawn must set AGY_TEE_OUT');
    assert.ok(reported.endsWith(`${contextId}.out`), `tee path should be keyed by contextId: ${reported}`);
    // The tee dir creation is the same code path that builds the path above
    // (registry entries are removed on clean exit, so the durable artifacts
    // are the env the child saw + the created directory).
    assert.ok(existsSync(join(tempDir, 'logs', 'worker-tee')), 'tee directory should exist under PA_HOME');
  });

  it('non-agy spawn does NOT set AGY_TEE_OUT', async () => {
    const { worker } = makeWorker('claude');

    const result = await executeWorker(worker, '', {
      timeout: 15,
      idleTimeout: 10,
      resource: 'test-skill',
    });

    assert.ok(/TEE=UNSET/.test(result.output ?? ''), `claude spawn must NOT set AGY_TEE_OUT; got: ${JSON.stringify(result.output)}`);
  });

  it('AGY_TEE_OUT already set → left alone (no clobber)', async () => {
    const externalPath = join(tmpdir(), 'external-tee.out');
    const { worker, opts } = makeWorker('agy', { AGY_TEE_OUT: externalPath });

    const result = await executeWorker(worker, '', {
      timeout: 15,
      idleTimeout: 10,
      resource: 'test-skill',
      ...(opts ?? {}),
    });

    assert.ok(result.output?.includes(`TEE=${externalPath}`), `pre-set AGY_TEE_OUT must be left alone; got: ${JSON.stringify(result.output)}`);
  });
});
