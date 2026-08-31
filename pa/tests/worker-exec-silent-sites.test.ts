import './test-env-guard.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempPaHome, createTempConfig, createTempSecrets, cleanup } from './helpers.js';
import { executeWorker } from '../src/workers.js';
import { flushLog } from '../src/lib/log.js';
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

  it('stdin-mode worker with a command that fails to exec does not crash on EPIPE', async () => {
    // Regression for a real CI-only crash: spawn() always uses shell:true, so a
    // command the shell can't find (Linux: "sh: 1: <cmd>: not found", exit 127)
    // still spawns the shell process successfully — child.on('error') never fires.
    // The shell then exits near-instantly, closing stdin, and our synchronous
    // child.stdin.write() can race that close and throw an uncaught EPIPE.
    // Windows's cmd.exe shell doesn't reliably hit this race (which is exactly
    // why this went undetected for weeks on a Windows dev machine and only
    // surfaced on the Ubuntu CI runner) — the assertion below is what matters
    // everywhere: executeWorker must resolve, never throw/crash the process,
    // regardless of whether this particular run happened to hit the race.
    const worker = makeWorker({
      command: 'nonexistent_command_that_does_not_exist_xyz',
      args: [],
      input_mode: 'stdin-text',
    });

    const result = await executeWorker(worker, 'test', { timeout: 5 });
    assert.equal(result.success, false);
  });

  it('a failed pid registration still lets the dispatch succeed, and logs a module:worker-pids warn row (AI-112)', async () => {
    // Force addWorkerPid to fail: pre-create a FILE at the path where the
    // worker-pids directory should be, so mkdir(dir, { recursive: true })
    // rejects with ENOTDIR instead of creating it.
    await writeFile(join(tempDir, 'worker-pids'), 'not-a-directory', 'utf8');

    const script = await writeScript('ok-despite-pidfail.js', 'process.stdout.write("ok");');
    const worker = makeWorker({ command: 'node', args: [script] });

    const result = await executeWorker(worker, 'test', { timeout: 10, resource: 'skill-pidfail' });
    assert.equal(result.success, true, 'dispatch must still succeed even though pid registration failed');

    await flushLog();
    const raw = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
    const rows = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const warnRow = rows.find((r) => r.module === 'worker-pids' && r.message === 'Failed to register worker pid');
    assert.ok(warnRow, `Expected a worker-pids warn row, got modules/messages: ${JSON.stringify(rows.map((r) => `${r.module}:${r.message}`))}`);
  });

  it('harvestWindowMs stamps a parseable, in-range harvestUntil onto the registry entry (AI-114)', async () => {
    const script = await writeScript('slow-harvest.js', 'setTimeout(() => process.stdout.write("done"), 400);');
    const worker = makeWorker({ command: 'node', args: [script] });
    const harvestWindowMs = 5 * 60_000;
    const before = Date.now();

    const runPromise = executeWorker(worker, 'test', {
      timeout: 10, resource: 'skill-harvest-set', harvestWindowMs,
    });

    let entry: { skill?: string; harvestUntil?: string } | undefined;
    const pollDeadline = Date.now() + 2000;
    while (!entry && Date.now() < pollDeadline) {
      const files = await readdir(join(tempDir, 'worker-pids')).catch(() => [] as string[]);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const raw = await readFile(join(tempDir, 'worker-pids', f), 'utf8').catch(() => null);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed.skill === 'skill-harvest-set') entry = parsed;
      }
      if (!entry) await new Promise((r) => setTimeout(r, 20));
    }
    await runPromise;

    assert.ok(entry, 'expected to observe the registered pid entry mid-run');
    assert.ok(entry!.harvestUntil, 'harvestUntil must be stamped when harvestWindowMs is set');
    const parsedTime = Date.parse(entry!.harvestUntil!);
    assert.ok(!Number.isNaN(parsedTime), 'harvestUntil must be a parseable date');
    assert.ok(
      parsedTime >= before + harvestWindowMs - 2000 && parsedTime <= before + harvestWindowMs + 5000,
      `harvestUntil (${entry!.harvestUntil}) should be ~${harvestWindowMs}ms after dispatch start`
    );
  });

  it('harvestWindowMs unset → no harvestUntil stamped (regression guard for `pa run`)', async () => {
    const script = await writeScript('slow-no-harvest.js', 'setTimeout(() => process.stdout.write("done"), 400);');
    const worker = makeWorker({ command: 'node', args: [script] });

    const runPromise = executeWorker(worker, 'test', { timeout: 10, resource: 'skill-harvest-unset' });

    let entry: { skill?: string; harvestUntil?: string } | undefined;
    const pollDeadline = Date.now() + 2000;
    while (!entry && Date.now() < pollDeadline) {
      const files = await readdir(join(tempDir, 'worker-pids')).catch(() => [] as string[]);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const raw = await readFile(join(tempDir, 'worker-pids', f), 'utf8').catch(() => null);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed.skill === 'skill-harvest-unset') entry = parsed;
      }
      if (!entry) await new Promise((r) => setTimeout(r, 20));
    }
    await runPromise;

    assert.ok(entry, 'expected to observe the registered pid entry mid-run');
    assert.equal(entry!.harvestUntil, undefined, 'harvestUntil must be absent when harvestWindowMs is not set');
  });
});
