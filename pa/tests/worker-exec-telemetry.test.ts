// Model-router telemetry hook tests (2026-09-18, plans/2026-09-18-model-router-SPEC.md WP-G).
// Proves the worker-exec exit-path hook: ONE telemetry line per SUCCESSFUL
// stream-json dispatch while a `model_router` block exists (spec §8.2), with
// worker/model/latency/usage and NO turn text; nothing on failure paths and
// nothing when the block is absent (spec §0.7: absent block = zero behavior,
// zero logging). Real producer over real consumer: a real executeWorker run
// against a real NDJSON stream stub, gated by a temp PA_HOME.

import './test-env-guard.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { executeWorker } from '../src/workers.js';
import type { WorkerConfig } from '../src/types.js';

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  await createTempSecrets(tempDir, '');
  scriptDir = join(tmpdir(), `pa-test-worker-telemetry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(scriptDir, { recursive: true });
});

afterEach(async () => {
  await cleanup(tempDir);
  await rm(scriptDir, { recursive: true, force: true }).catch(() => {});
});

function makeWorker(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    name: 'agy',
    command: process.platform === 'win32' ? 'cmd.exe' : 'sh',
    args: process.platform === 'win32' ? ['/d', '/c', 'type'] : ['-c', 'cat'],
    check: 'echo ok',
    rate_limit_patterns: [],
    priority: 1,
    input_mode: 'stdin-text',
    check_timeout: 5,
    output_format: 'stream-json',
    ...overrides,
  };
}

// Real Node process emitting the agy stream-json dialect: init carries the
// model, result carries usage — exactly the shapes trace/usage capture read.
async function writeNdjsonStub(name: string, lines: string[], exitCode = 0): Promise<{ command: string; args: string[] }> {
  const path = join(scriptDir, `${name}.mjs`);
  const content = lines.join('\n') + '\n';
  await writeFile(
    path,
    `process.stdout.write(${JSON.stringify(content)});\nprocess.exit(${exitCode});\n`,
    'utf8',
  );
  return { command: `"${process.execPath}"`, args: [path] };
}

const INIT_LINE = '{"event":"init","conversation_id":"t","init":{"model":"gemini-3.7-flash-low"}}';
const RESULT_LINE = '{"event":"result","status":"SUCCESS","result":{"text":"ok","usage":{"input_tokens":11,"output_tokens":7}}}';

const MIN_CONFIG = [
  'workers:',
  '  - name: agy',
  '    command: "echo"',
  '    args: ["ok"]',
  '    check: "echo ok"',
  'model_router:',
  '  enabled: false',
].join('\n');

const NO_BLOCK_CONFIG = MIN_CONFIG.replace('\nmodel_router:\n  enabled: false', '');

async function seedConfig(yaml: string): Promise<void> {
  await writeFile(join(tempDir, 'config.yaml'), yaml + '\n', 'utf8');
}

async function readTelemetryLines(): Promise<string[]> {
  try {
    const raw = await readFile(join(tempDir, 'model-router-telemetry.jsonl'), 'utf8');
    return raw.split('\n').filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

// The hook is fire-and-forget — poll until the line lands or give up.
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

describe('worker-exec model-router telemetry hook', () => {
  it('successful stream-json dispatch with model_router block: ONE line with worker/model/duration/usage, no turn text', async () => {
    await seedConfig(MIN_CONFIG);
    const stub = await writeNdjsonStub('ok', [INIT_LINE, RESULT_LINE]);
    const worker = makeWorker({ ...stub });
    const result = await executeWorker(worker, 'test prompt', { timeout: 15 });
    assert.equal(result.success, true, `dispatch should succeed: ${result.error ?? ''}`);

    const got = await waitFor(async () => (await readTelemetryLines()).length > 0);
    assert.ok(got, 'telemetry line never landed');
    const lines = await readTelemetryLines();
    assert.equal(lines.length, 1, `expected exactly one telemetry line, got ${lines.length}`);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.worker, 'agy');
    assert.equal(rec.model, 'gemini-3.7-flash-low');
    assert.equal(typeof rec.at, 'string');
    assert.equal(typeof rec.durationMs, 'number');
    assert.ok(rec.durationMs >= 0);
    assert.equal(rec.inputTokens, 11);
    assert.equal(rec.outputTokens, 7);
    // No-turn-text probe (spec §14.4): the line carries no user-text substring.
    assert.ok(!lines[0].includes('test prompt'), 'telemetry line must not carry turn text');
  });

  it('no model_router block: NO telemetry line (zero behavior, zero logging)', async () => {
    await seedConfig(NO_BLOCK_CONFIG);
    const stub = await writeNdjsonStub('ok-noblock', [INIT_LINE, RESULT_LINE]);
    const worker = makeWorker({ ...stub });
    await executeWorker(worker, 'test prompt', { timeout: 15 });
    await new Promise((r) => setTimeout(r, 800));
    assert.deepEqual(await readTelemetryLines(), [], 'no telemetry without a model_router block');
  });

  it('failed dispatch (non-zero exit): NO telemetry line even with the block present', async () => {
    await seedConfig(MIN_CONFIG);
    const stub = await writeNdjsonStub('fail', [INIT_LINE, RESULT_LINE], 3);
    const worker = makeWorker({ ...stub });
    const result = await executeWorker(worker, 'test prompt', { timeout: 15 });
    assert.equal(result.success, false);
    await new Promise((r) => setTimeout(r, 800));
    assert.deepEqual(await readTelemetryLines(), [], 'no telemetry on failure paths');
  });
});
