import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempPaHome, createTempConfig, cleanup } from './helpers.js';
import { executeWorker, runWithFailover } from '../src/workers.js';
import type { WorkerConfig } from '../src/types.js';

// PA_WORKER_RESOURCE is the worker's own identity (spec 2026-09-08,
// voice-inbox redesign WP-0): it must be byte-identical to the worker-pids
// `skill` key so a cancel can kill exactly the process tree that carried it.
// These tests pin the env-injection side of that identity; the registry
// side (`skill: options.resource || 'unknown'`) is pinned by the
// source-invariant test below, which fails if either expression drifts.
//
// pa/ compiles to CommonJS (no import.meta) — __dirname/__filename are the
// compiled module's own globals. Compiled location is pa/dist/tests/, so
// two '..' segments reach pa/, matching pa/tests/blackboard.test.ts:969's
// precedent for reading a TypeScript SOURCE file (not the compiled dist
// twin) from a running test.

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  scriptDir = join(tmpdir(), `pa-test-scripts-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

async function writeScript(name: string, code: string): Promise<string> {
  const path = join(scriptDir, name);
  await writeFile(path, code, 'utf8');
  return path;
}

// Prints the raw env value with a sentinel for "not present at all", so a
// test can distinguish an injected empty string from a missing key.
const PRINT_RESOURCE_SCRIPT =
  'process.stdout.write(process.env.PA_WORKER_RESOURCE === undefined ? "UNDEFINED" : process.env.PA_WORKER_RESOURCE);';

// Prints PA_WORKER_DISPATCH_ID with the same "not present" sentinel (WP-5 D12).
const PRINT_DISPATCH_ID_SCRIPT =
  'process.stdout.write(process.env.PA_WORKER_DISPATCH_ID === undefined ? "UNDEFINED" : process.env.PA_WORKER_DISPATCH_ID);';

describe('PA_WORKER_RESOURCE env injection (worker-exec.ts)', () => {
  it('injects the resource string into the worker env', async () => {
    const script = await writeScript('resource-basic.js', PRINT_RESOURCE_SCRIPT);
    const worker = makeWorker({ command: 'node', args: [script] });
    const result = await executeWorker(worker, 'unused', { timeout: 10, resource: 'topic--100_5-th3' });
    assert.equal(result.success, true);
    assert.equal(result.output.trim(), 'topic--100_5-th3');
  });

  it('injects an empty string (not a stale inherited value) when no resource is given', async () => {
    const script = await writeScript('resource-none.js', PRINT_RESOURCE_SCRIPT);
    const worker = makeWorker({ command: 'node', args: [script] });
    const priorEnv = process.env.PA_WORKER_RESOURCE;
    process.env.PA_WORKER_RESOURCE = 'stale';
    try {
      const result = await executeWorker(worker, 'unused', { timeout: 10 });
      assert.equal(result.success, true);
      // Empty string, never "UNDEFINED" and never the parent's "stale" value:
      // spreading process.env first, then setting PA_WORKER_RESOURCE
      // unconditionally, is exactly what prevents inheritance here.
      assert.equal(result.output.trim(), '');
    } finally {
      if (priorEnv === undefined) delete process.env.PA_WORKER_RESOURCE;
      else process.env.PA_WORKER_RESOURCE = priorEnv;
    }
  });

  it('does not let caller override PA_WORKER_RESOURCE via options.env', async () => {
    const script = await writeScript('resource-override.js', PRINT_RESOURCE_SCRIPT);
    const worker = makeWorker({ command: 'node', args: [script] });
    const result = await executeWorker(worker, 'unused', {
      timeout: 10,
      resource: 'topic--100_5',
      env: { PA_WORKER_RESOURCE: 'spoofed' },
    });
    assert.equal(result.success, true);
    assert.equal(result.output.trim(), 'topic--100_5');
  });

  it('source-invariant: the env value and the registry key derive from the same expression', async () => {
    const src = await readFile(join(__dirname, '..', '..', 'src', 'worker-exec.ts'), 'utf8');
    assert.ok(
      src.includes("PA_WORKER_RESOURCE: options.resource ?? ''"),
      'expected worker-exec.ts to inject PA_WORKER_RESOURCE: options.resource ?? \'\''
    );
    assert.ok(
      src.includes("skill: options.resource || 'unknown'"),
      'expected worker-exec.ts to register skill: options.resource || \'unknown\' in worker-pids'
    );
    // WP-5 D12: dispatch identity — the env value and the registry field must
    // be derived from the same const, never a separate mint on either side.
    assert.ok(
      src.includes('PA_WORKER_DISPATCH_ID: dispatchId'),
      'expected worker-exec.ts to inject PA_WORKER_DISPATCH_ID: dispatchId'
    );
    assert.ok(
      /addWorkerPid\(\{[\s\S]*?\bdispatchId,/.test(src),
      'expected worker-exec.ts to register dispatchId, inside the addWorkerPid literal'
    );
  });
});

describe('PA_WORKER_DISPATCH_ID env injection (worker-exec.ts, WP-5 D12)', () => {
  it('injects a 12-hex-char dispatch id into the worker env', async () => {
    const script = await writeScript('dispatch-id-basic.js', PRINT_DISPATCH_ID_SCRIPT);
    const worker = makeWorker({ command: 'node', args: [script] });
    const result = await executeWorker(worker, 'unused', { timeout: 10, resource: 'topic--100_5' });
    assert.equal(result.success, true);
    assert.match(result.output.trim(), /^[0-9a-f]{12}$/);
  });

  it('mints a different dispatch id on every successive call', async () => {
    const script = await writeScript('dispatch-id-unique.js', PRINT_DISPATCH_ID_SCRIPT);
    const worker = makeWorker({ command: 'node', args: [script] });
    const first = await executeWorker(worker, 'unused', { timeout: 10, resource: 'topic--100_5' });
    const second = await executeWorker(worker, 'unused', { timeout: 10, resource: 'topic--100_5' });
    assert.equal(first.success, true);
    assert.equal(second.success, true);
    assert.match(first.output.trim(), /^[0-9a-f]{12}$/);
    assert.match(second.output.trim(), /^[0-9a-f]{12}$/);
    assert.notEqual(first.output.trim(), second.output.trim());
  });

  it('does not let caller override PA_WORKER_DISPATCH_ID via options.env', async () => {
    const script = await writeScript('dispatch-id-override.js', PRINT_DISPATCH_ID_SCRIPT);
    const worker = makeWorker({ command: 'node', args: [script] });
    const result = await executeWorker(worker, 'unused', {
      timeout: 10,
      resource: 'topic--100_5',
      env: { PA_WORKER_DISPATCH_ID: 'spoofed' },
    });
    assert.equal(result.success, true);
    assert.notEqual(result.output.trim(), 'spoofed');
    assert.match(result.output.trim(), /^[0-9a-f]{12}$/);
  });
});

describe('RunOptions.getEnv per-hop env hook (worker-exec.ts, WS3 2026-09-18)', () => {
  // The hook mirrors getExtraArgs: evaluated per failover hop with THAT hop's
  // WorkerConfig and merged AFTER options.env inside the per-hop env build, so
  // the hop's own identity wins over any static env value — and lands after
  // runWithFailover's secret_allowlist filtering, so framework-stamped keys
  // (PA_WORKER_CLI/_MODEL/_EFFORT) reach allowlisted workers whose static env
  // is stripped.

  it('injects getEnv output into the spawned worker env', async () => {
    const script = await writeScript(
      'getenv-basic.js',
      'process.stdout.write(process.env.PA_WORKER_CLI === undefined ? "UNDEFINED" : process.env.PA_WORKER_CLI);',
    );
    const worker = makeWorker({ command: 'node', args: [script] });
    const result = await executeWorker(worker, 'unused', {
      timeout: 10,
      getEnv: (w) => ({ PA_WORKER_CLI: `cli-${w.name}` }),
    });
    assert.equal(result.success, true);
    assert.equal(result.output.trim(), 'cli-test');
  });

  it('getEnv output overrides a static env key of the same name', async () => {
    const script = await writeScript(
      'getenv-override.js',
      'process.stdout.write(process.env.PA_WORKER_CLI === undefined ? "UNDEFINED" : process.env.PA_WORKER_CLI);',
    );
    const worker = makeWorker({ command: 'node', args: [script] });
    const result = await executeWorker(worker, 'unused', {
      timeout: 10,
      env: { PA_WORKER_CLI: 'static-first-chosen' },
      getEnv: () => ({ PA_WORKER_CLI: 'per-hop-value' }),
    });
    assert.equal(result.success, true);
    assert.equal(result.output.trim(), 'per-hop-value', 'the hook merges after env — the hop value must win');
  });

  it('each failover hop receives its own getEnv value, past the allowlist filter', async () => {
    const capturePath = join(tempDir, 'hop-env-capture.txt');
    // A failing hop still STAMPS: append the hop's value to a capture file
    // before exiting non-zero, so the failover hop's own stamp is provable.
    const mkStampScript = (marker: string) =>
      `const fs = require('fs'); fs.appendFileSync(${JSON.stringify(capturePath)}, (process.env.PA_WORKER_CLI === undefined ? 'UNDEFINED' : process.env.PA_WORKER_CLI) + '|' + ${JSON.stringify(marker)} + '\\n'); ${marker === 'fail' ? 'process.exit(1);' : 'process.stdout.write("ok");'}`;
    const failScript = await writeScript('getenv-hop-fail.js', mkStampScript('fail'));
    const okScript = await writeScript('getenv-hop-ok.js', mkStampScript('ok'));
    await createTempConfig(tempDir, [
      // secret_allowlist engaged on BOTH workers: static options.env keys that
      // are not allowlisted never reach the child — getEnv's output must,
      // because it merges AFTER the filter inside worker-exec.
      { name: 'hopone', command: 'node', args: [failScript], check: 'echo ok', priority: 1, secret_allowlist: ['UNRELATED_SECRET'] },
      { name: 'hoptwo', command: 'node', args: [okScript], check: 'echo ok', priority: 2, secret_allowlist: ['UNRELATED_SECRET'] },
    ]);
    const { result, worker } = await runWithFailover('unused', {
      timeout: 10,
      env: { PA_WORKER_CLI: 'static-stripped', UNRELATED_SECRET: 's' },
      getEnv: (w) => ({ PA_WORKER_CLI: `stamped-by-${w.name}` }),
    });
    assert.equal(result.success, true);
    assert.equal(worker, 'hoptwo');
    const captured = (await readFile(capturePath, 'utf8')).trim().split('\n');
    assert.deepEqual(captured, ['stamped-by-hopone|fail', 'stamped-by-hoptwo|ok'],
      'hopone must stamp hopone and hoptwo must stamp hoptwo — not the first-chosen worker twice, and never the allowlist-stripped static value');
  });
});
