import './test-env-guard.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFile, mkdir, rm } from 'fs/promises';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { executeWorker } from '../src/workers.js';
import type { WorkerConfig } from '../src/types.js';

/**
 * ai246 WP-E regression pin (2026-09-15): a devin (plain-text) worker's stdout
 * carried a UTF-8 em-dash inside a PA_META JSON string. The spawn read loop
 * decoded every chunk with its own data.toString(), so a multi-byte char
 * split across two pipe reads came back as U+FFFD fragments — and in the
 * observed incident (worker-tee 7a540c2e-…, sessions s-14d49f503df2 /
 * s-f9f29aaf7ada) the mangled bytes terminated the JSON string early and
 * JSON.parse dropped a spawn_thread action silently. The decode now runs
 * through StringDecoder, which holds a trailing partial sequence until the
 * rest of the bytes arrive.
 *
 * The stub below forces the split deterministically: it writes the em-dash's
 * first two bytes (E2 80) in one flush, sleeps, then writes the last byte
 * (0x94) plus the remainder — two OS-level chunks guaranteed.
 */
describe('worker-exec stdout encoding (byte path)', () => {
  let tempDir: string;
  let scriptDir: string;

  beforeEach(async () => {
    tempDir = await createTempPaHome();
    await createTempSecrets(tempDir, '');
    scriptDir = join(tmpdir(), `pa-test-wexec-enc-${Date.now()}`);
    await mkdir(scriptDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanup(tempDir);
    await rm(scriptDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeWorker(scriptPath: string): WorkerConfig {
    return {
      name: 'devin',
      command: 'node',
      args: [scriptPath],
      check: 'echo ok',
      rate_limit_patterns: [],
      priority: 5,
      input_mode: 'arg',
      output_format: 'plain-text',
      check_timeout: 5,
    };
  }

  it('a multi-byte char split across stdout chunks round-trips — PA_META JSON with an em-dash parses intact', async () => {
    const stub = [
      "const b = Buffer.from('prelude\\n[PA_META]: {\"actions\":[{\"type\":\"spawn_thread\",\"title\":\"conflict — screencast\"}]}\\n', 'utf8');",
      'const i = b.indexOf(0xE2);', // first byte of the em-dash sequence
      'process.stdout.write(b.subarray(0, i + 2));', // through E2 80 — mid-char
      'setTimeout(() => { process.stdout.write(b.subarray(i + 2)); }, 60);', // 0x94 + rest
    ].join('\n');
    const scriptPath = join(scriptDir, 'split-emdash.js');
    await writeFile(scriptPath, stub, 'utf8');

    const result = await executeWorker(makeWorker(scriptPath), 'test prompt', {
      timeout: 15,
      idleTimeout: 10,
      resource: 'test-skill',
    });

    assert.ok(result.output.includes('conflict — screencast'),
      `em-dash must survive the pipe byte path intact; got: ${JSON.stringify(result.output)}`);
    assert.ok(!result.output.includes('�'),
      `no U+FFFD replacement chars may appear; got: ${JSON.stringify(result.output)}`);

    // The envelope the orchestrator lane would feed parseMetadata must parse.
    const metaLine = result.output.split('\n').find((l) => l.startsWith('[PA_META]:'));
    assert.ok(metaLine, 'PA_META envelope line present');
    const parsed = JSON.parse(metaLine!.slice('[PA_META]:'.length).trim()) as { actions: { type: string }[] };
    assert.equal(parsed.actions[0]?.type, 'spawn_thread', 'the spawn_thread action survives the byte path');
  });

  it('an unsplit multi-byte char still round-trips (control)', async () => {
    const stub = "process.stdout.write('[PA_META]: {\"actions\":[{\"type\":\"spawn_thread\",\"title\":\"a — b\"}]}\\n');";
    const scriptPath = join(scriptDir, 'plain-emdash.js');
    await writeFile(scriptPath, stub, 'utf8');

    const result = await executeWorker(makeWorker(scriptPath), 'test prompt', {
      timeout: 15,
      idleTimeout: 10,
      resource: 'test-skill',
    });

    assert.ok(result.output.includes('a — b'), `got: ${JSON.stringify(result.output)}`);
  });
});
