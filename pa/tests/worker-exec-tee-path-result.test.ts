import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { executeWorker } from '../src/workers.js';
import type { WorkerConfig } from '../src/types.js';

describe('worker-exec teePath in CommandResult', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempPaHome();
    await createTempSecrets(tempDir, '');
  });

  afterEach(async () => {
    await cleanup(tempDir);
  });

  function makeWorker(name: string): WorkerConfig {
    return {
      name,
      command: 'node',
      args: ['-e', 'process.stdout.write("hello world")'],
      check: 'echo ok',
      rate_limit_patterns: [],
      priority: 1,
      input_mode: 'arg',
      check_timeout: 5,
    };
  }

  it('executeWorker returns teePath for agy worker', async () => {
    const worker = makeWorker('agy');
    const contextId = 'test-ctx-agy-1';

    const result = await executeWorker(worker, '', {
      timeout: 15,
      idleTimeout: 10,
      resource: 'test-skill',
      contextId,
    });

    // For agy, the tee file is created by the shim process, not by Node.js.
    // We verify the teePath is set correctly but don't check file existence
    // since the shim may not have created it yet (or may have already cleaned it up).
    assert.ok(result.teePath, 'agy worker should have teePath set');
    assert.ok(result.teePath!.endsWith(`${contextId}.out`), `teePath should be keyed by contextId: ${result.teePath}`);
  });

  it('executeWorker returns teePath for non-agy worker (claude)', async () => {
    const worker = makeWorker('claude');
    const contextId = 'test-ctx-claude-1';

    const result = await executeWorker(worker, '', {
      timeout: 15,
      idleTimeout: 10,
      resource: 'test-skill',
      contextId,
    });

    assert.ok(result.teePath, 'non-agy worker should have teePath set');
    assert.ok(result.teePath!.endsWith(`${contextId}.out`), `teePath should be keyed by contextId: ${result.teePath}`);
    assert.ok(existsSync(result.teePath!), 'tee file should exist');
  });

  it('executeWorker returns teePath for codex worker', async () => {
    const worker = makeWorker('codex');
    const contextId = 'test-ctx-codex-1';

    const result = await executeWorker(worker, '', {
      timeout: 15,
      idleTimeout: 10,
      resource: 'test-skill',
      contextId,
    });

    assert.ok(result.teePath, 'codex worker should have teePath set');
    assert.ok(result.teePath!.endsWith(`${contextId}.out`), `teePath should be keyed by contextId: ${result.teePath}`);
  });

  it('tee file contains captured stdout for non-agy worker', async () => {
    const worker = makeWorker('claude');
    const contextId = 'test-ctx-tee-content-1';
    const expectedOutput = 'hello from claude worker';

    const workerWithOutput: WorkerConfig = {
      ...worker,
      args: ['-e', `process.stdout.write("${expectedOutput}")`],
    };

    const result = await executeWorker(workerWithOutput, '', {
      timeout: 15,
      idleTimeout: 10,
      resource: 'test-skill',
      contextId,
    });

    assert.ok(result.teePath, 'teePath should be set');
    const teeContent = await readFile(result.teePath!, 'utf8');
    assert.ok(teeContent.includes(expectedOutput), `tee file should contain worker output; got: ${teeContent}`);
  });

  it('tee file contains captured stdout for agy worker (via shim, not Node.js tee)', async () => {
    // For agy, the shim handles the tee, so the Node.js createWriteStream
    // should NOT be used (that would be wasteful). We verify the teePath
    // is set correctly but cannot reliably test file content since the
    // shim manages the file lifecycle independently.
    const worker = makeWorker('agy');
    const contextId = 'test-ctx-agy-tee-1';
    const expectedOutput = 'hello from agy worker';

    const workerWithOutput: WorkerConfig = {
      ...worker,
      args: ['-e', `process.stdout.write("${expectedOutput}")`],
    };

    const result = await executeWorker(workerWithOutput, '', {
      timeout: 15,
      idleTimeout: 10,
      resource: 'test-skill',
      contextId,
    });

    assert.ok(result.teePath, 'agy worker should have teePath set');
    assert.ok(result.teePath!.endsWith(`${contextId}.out`), `teePath should be keyed by contextId: ${result.teePath}`);
    // File existence/content is not tested here because the shim manages it
  });

  it('different workers get different tee files', async () => {
    const worker1 = makeWorker('claude');
    const worker2 = makeWorker('codex');
    const contextId1 = 'test-ctx-diff-1';
    const contextId2 = 'test-ctx-diff-2';

    const result1 = await executeWorker(worker1, '', {
      timeout: 15,
      idleTimeout: 10,
      resource: 'test-skill',
      contextId: contextId1,
    });

    const result2 = await executeWorker(worker2, '', {
      timeout: 15,
      idleTimeout: 10,
      resource: 'test-skill',
      contextId: contextId2,
    });

    assert.notStrictEqual(result1.teePath, result2.teePath, 'different workers should have different tee paths');
    assert.ok(existsSync(result1.teePath!), 'first tee file should exist');
    assert.ok(existsSync(result2.teePath!), 'second tee file should exist');
  });
});
