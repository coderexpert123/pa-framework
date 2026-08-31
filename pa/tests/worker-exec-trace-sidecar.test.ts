import './test-env-guard.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { executeWorker } from '../src/workers.js';
import { turnTracesPath } from '../src/lib/turn-trace.js';
import type { WorkerConfig } from '../src/types.js';

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  await createTempSecrets(tempDir, '');
  scriptDir = join(tmpdir(), `pa-test-trace-sidecar-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// Node stub, not powershell (same rationale as worker-exec-agy-stream.test.ts:
// node spawns deterministically well under a second on every platform).
async function writeNdjsonStub(name: string, lines: string[], opts: { exitCode?: number } = {}): Promise<{ command: string; args: string[] }> {
  const path = join(scriptDir, `${name}.mjs`);
  const content = lines.join('\n') + '\n';
  const exitStmt = opts.exitCode ? `\nprocess.exitCode = ${opts.exitCode};` : '';
  await writeFile(path, `process.stdout.write(${JSON.stringify(content)});${exitStmt}\n`, 'utf8');
  return { command: `"${process.execPath}"`, args: [path] };
}

async function writePlainTextStub(name: string, text: string): Promise<{ command: string; args: string[] }> {
  const path = join(scriptDir, `${name}.mjs`);
  await writeFile(path, `process.stdout.write(${JSON.stringify(text)});\n`, 'utf8');
  return { command: `"${process.execPath}"`, args: [path] };
}

const AGY_TOOL_RUN = [
  '{"event":"init","conversation_id":"tid-1","init":{"model":"gemini-3.7-flash-high"}}',
  '{"event":"step_update","step_update":{"conversation_id":"tid-1","step_index":0,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"D:/repo/file.ts"}}}}',
  '{"event":"step_update","step_update":{"conversation_id":"tid-1","step_index":0,"state":"DONE","step_type":"tool","tool_name":"view_file","duration_seconds":0.2,"tool_info":{"name":"view_file","parameters":{"AbsolutePath":"D:/repo/file.ts"},"output":"1 line"}}}',
  '{"event":"result","result":{"conversation_id":"tid-1","status":"SUCCESS","response":"done","usage":{"input_tokens":10,"output_tokens":2}}}',
];

async function readTraceLines(): Promise<any[]> {
  const content = await readFile(turnTracesPath(), 'utf8');
  return content.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('worker-exec trace sidecar', () => {
  it('a fake agy-dialect worker emitting init + one tool pair + result writes one trace line', async () => {
    const stub = await writeNdjsonStub('agy-tool-run', AGY_TOOL_RUN);
    const worker = makeWorker({ command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10, resource: 'skill-oracle' });

    assert.equal(result.exitCode, 0);
    assert.ok(result.runId && /^[0-9a-f-]{36}$/i.test(result.runId), `expected a uuid runId, got: ${result.runId}`);

    const lines = await readTraceLines();
    assert.equal(lines.length, 1);
    const trace = lines[0];
    assert.equal(trace.origin, 'skill');
    assert.equal(trace.skill, 'oracle');
    assert.equal(trace.worker, 'agy');
    assert.equal(trace.run_id, result.runId);
    assert.equal(trace.exit_code, 0);
    assert.equal(trace.outcome, 'ok');
    assert.equal(trace.parsed, true);
    assert.equal(trace.tool_calls.length, 1);
    assert.equal(trace.tool_calls[0].name, 'view_file');
  });

  it('a bot-origin resource + updateId carries chat_id, thread_id, update_id', async () => {
    const stub = await writeNdjsonStub('agy-bot-run', AGY_TOOL_RUN);
    const worker = makeWorker({ command: stub.command, args: stub.args });

    await executeWorker(worker, 'test prompt', { timeout: 10, resource: 'topic--100123_7822', updateId: 4242 });

    const lines = await readTraceLines();
    assert.equal(lines.length, 1);
    const trace = lines[0];
    assert.equal(trace.origin, 'bot');
    assert.equal(trace.chat_id, -100123);
    assert.equal(trace.thread_id, 7822);
    assert.equal(trace.update_id, 4242);
  });

  it('a worker exiting 1 records outcome:error', async () => {
    const stub = await writeNdjsonStub('agy-exit1', AGY_TOOL_RUN, { exitCode: 1 });
    const worker = makeWorker({ command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10, resource: 'skill-oracle' });

    assert.equal(result.exitCode, 1);
    const lines = await readTraceLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].outcome, 'error');
    assert.ok(result.runId);
  });

  it('the same exit-1 worker with suppressExitAlert:true records outcome:failover', async () => {
    const stub = await writeNdjsonStub('agy-exit1-suppressed', AGY_TOOL_RUN, { exitCode: 1 });
    const worker = makeWorker({ command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10, resource: 'skill-oracle', suppressExitAlert: true });

    assert.equal(result.exitCode, 1);
    const lines = await readTraceLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].outcome, 'failover');
    assert.ok(result.runId);
  });

  it('a non-stream-json plain-text worker writes one line with parsed:false and empty slices', async () => {
    const stub = await writePlainTextStub('plain-text-worker', 'just some plain output, no NDJSON here');
    const worker = makeWorker({ command: stub.command, args: stub.args, output_format: undefined });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10, resource: 'skill-oracle' });

    assert.equal(result.exitCode, 0);
    const lines = await readTraceLines();
    assert.equal(lines.length, 1);
    const trace = lines[0];
    assert.equal(trace.parsed, false);
    assert.deepEqual(trace.tool_calls, []);
    assert.deepEqual(trace.commands, []);
    assert.deepEqual(trace.files, []);
    assert.deepEqual(trace.errors, []);
  });
});
