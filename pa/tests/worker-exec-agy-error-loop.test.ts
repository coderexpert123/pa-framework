import './test-env-guard.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { executeWorker } from '../src/workers.js';
import { isNarrationOnly } from '../src/worker-exec.js';
import type { WorkerConfig } from '../src/types.js';

/**
 * 2026-09-10 incident: an agy dispatch alternated `agent_response`/
 * `error_message` step_update events — each `agent_response` carrying an
 * empty `text_delta` — for 11+ minutes without ever exiting, holding the
 * only worker slot and starving `pa catchup` for 38 minutes. worker-exec.ts
 * now kills a run after AGY_ERROR_LOOP_THRESHOLD (2, lowered from 3 — Oracle,
 * 2026-09-17: a 3rd occurrence just burned time budget on a worker already
 * shown to be looping) consecutive `error_message` steps with no usable
 * output in between, and separately
 * fires a wall-clock guard when a run produces no usable output at all for
 * PA_AGY_NO_PROGRESS_TIMEOUT_MS (catches a silent variant the step counter
 * can't see). vi-2638f25056ba (2026-09-11): the wall-clock fire escalates
 * through the check-before-kill ladder instead of killing outright — a run
 * that is merely slow-but-alive (the starved-D: pattern) gets extended,
 * bounded by NO_PROGRESS_MAX_EXTENDS. These tests prove both checks can
 * actually FAIL (fire on a real bad case) and don't false-positive on a
 * run that is genuinely recovering between errors.
 */

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  await createTempSecrets(tempDir, '');
  scriptDir = join(tmpdir(), `pa-test-agy-error-loop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// Same stub convention as worker-exec-agy-stream.test.ts: a real Node process
// (not a shell builtin) so timing is deterministic across platforms.
async function writeNdjsonStub(name: string, lines: string[]): Promise<{ command: string; args: string[] }> {
  const path = join(scriptDir, `${name}.mjs`);
  const content = lines.join('\n') + '\n';
  await writeFile(path, `process.stdout.write(${JSON.stringify(content)})\n`, 'utf8');
  return { command: `"${process.execPath}"`, args: [path] };
}

// A stub that emits a handful of lines and then keeps the process alive
// (never exits on its own) so the wall-clock no-progress guard — not the
// process's natural exit — is what has to end the test. Holds one live child
// so the idle/no-progress ladder's process-tree check finds a running tool
// (grandchild of the shell wrapper) and answers "alive" instead of falling
// through to the no-signal kill.
async function writeHangingStub(name: string, lines: string[]): Promise<{ command: string; args: string[] }> {
  const path = join(scriptDir, `${name}.mjs`);
  const content = `import { spawn } from 'node:child_process';\n`
    + `spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });\n`
    + `process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')});\n`
    + `setInterval(() => {}, 1000);\n`;
  await writeFile(path, content, 'utf8');
  return { command: `"${process.execPath}"`, args: [path] };
}

const CONV = 'error-loop-test';

function stepUpdate(index: number, fields: Record<string, unknown>): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: CONV, step_index: index, state: 'DONE', ...fields },
  });
}

describe('worker-exec agy error-loop / no-progress guard (2026-09-10 incident)', () => {
  it('known-bad case: kills a run stuck alternating empty agent_response / error_message steps', async () => {
    // Mirrors the real production shape exactly: agent_response steps with no
    // text_delta at all (nothing usable) alternating with error_message steps,
    // never reaching a result event. Threshold is 2 consecutive error_message
    // steps with no usable output in between — this stream supplies 4, so if
    // the guard did nothing this stub would just run to completion (the
    // "known-bad" case a check must be shown to catch, not just a shape that
    // happens to also pass).
    const lines = [
      JSON.stringify({ event: 'init', conversation_id: CONV, init: { model: 'gemini-3.8-flash-high' } }),
      stepUpdate(1, { step_type: 'agent_response', duration_seconds: 1.2 }),
      stepUpdate(2, { step_type: 'error_message', duration_seconds: 0 }),
      stepUpdate(3, { step_type: 'agent_response', duration_seconds: 0.6 }),
      stepUpdate(4, { step_type: 'error_message', duration_seconds: 0 }),
      // These would never be reached if the guard fires correctly at step 4
      // (the 2nd consecutive error_message with nothing usable in between).
      stepUpdate(5, { step_type: 'agent_response', duration_seconds: 0.9 }),
      stepUpdate(6, { step_type: 'error_message', duration_seconds: 0 }),
      stepUpdate(7, { step_type: 'agent_response', duration_seconds: 0.8 }),
      stepUpdate(8, { step_type: 'error_message', duration_seconds: 0 }),
    ];
    const stub = await writeNdjsonStub('agy-error-loop', lines);
    const worker = makeWorker({ command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });

    assert.equal(result.success, false, 'a run stuck in the error loop must be reported as a failure');
    assert.match(result.error ?? '', /agy-error-loop/, `expected a greppable agy-error-loop reason, got: ${result.error}`);
    assert.match(result.error ?? '', /2 consecutive error_message/);
    assert.match(result.error ?? '', /worker: agy/, `expected the failure record to name the worker, got: ${result.error}`);
  });

  it('negative twin: does NOT fire when error_message steps are separated by real usable output', async () => {
    // Four error_message steps total — more than the threshold if counted
    // without resetting — but each one is preceded by a real agent_response
    // text_delta, which must reset the counter every time. Proves the
    // discriminator is "no usable output", not a raw error_message count.
    const lines = [
      JSON.stringify({ event: 'init', conversation_id: CONV, init: { model: 'gemini-3.8-flash-high' } }),
      stepUpdate(1, { step_type: 'agent_response', text_delta: 'progress 1\n', duration_seconds: 1.0 }),
      stepUpdate(2, { step_type: 'error_message', duration_seconds: 0 }),
      stepUpdate(3, { step_type: 'agent_response', text_delta: 'progress 2\n', duration_seconds: 0.8 }),
      stepUpdate(4, { step_type: 'error_message', duration_seconds: 0 }),
      stepUpdate(5, { step_type: 'agent_response', text_delta: 'progress 3\n', duration_seconds: 0.7 }),
      stepUpdate(6, { step_type: 'error_message', duration_seconds: 0 }),
      stepUpdate(7, { step_type: 'agent_response', text_delta: 'progress 4\n', duration_seconds: 0.5 }),
      stepUpdate(8, { step_type: 'error_message', duration_seconds: 0 }),
      stepUpdate(9, { step_type: 'agent_response', text_delta: 'done\n', duration_seconds: 0.4 }),
      JSON.stringify({
        event: 'result',
        result: { conversation_id: CONV, status: 'SUCCESS', response: 'done\n', duration_seconds: 5.4, num_turns: 1 },
      }),
    ];
    const stub = await writeNdjsonStub('agy-self-heal', lines);
    const worker = makeWorker({ command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });

    assert.equal(result.success, true, 'a run that recovers between error_message steps must not be killed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'done\n');
  });

  it('known-bad case: wall-clock no-progress guard kills a run that keeps streaming with zero usable output', async () => {
    const prevEnv = process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS;
    process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS = '200'; // deterministic, no real-world wait
    try {
      // No error_message steps at all — only benign "tool" steps with no
      // text_delta, forever. The error-loop counter above would never fire on
      // this shape; only the wall-clock guard can catch it, which is exactly
      // why it exists as a SEPARATE check. vi-2638f25056ba (2026-09-11): the
      // fire is no longer a summary kill — it escalates through the
      // check-before-kill ladder (no state_dir here → process-tree check
      // finds the stub alive → extend), so the kill lands only when
      // NO_PROGRESS_MAX_EXTENDS extensions have found the run still silent.
      const lines = [
        JSON.stringify({ event: 'init', conversation_id: CONV, init: { model: 'gemini-3.8-flash-high' } }),
        stepUpdate(1, { step_type: 'tool', tool_name: 'run_command', duration_seconds: 0.5 }),
      ];
      const stub = await writeHangingStub('agy-no-progress', lines);
      const worker = makeWorker({ command: stub.command, args: stub.args });

      const result = await executeWorker(worker, 'test prompt', {
        timeout: 10,
        idleTimeout: 8, // well above the 200ms no-progress window so idle timeout can't mask it
      });

      assert.equal(result.success, false);
      assert.match(result.error ?? '', /agy-no-progress/, `expected a greppable agy-no-progress reason, got: ${result.error}`);
      assert.match(result.error ?? '', /3 liveness extensions/, `expected the NO_PROGRESS_MAX_EXTENDS cap in the reason, got: ${result.error}`);
    } finally {
      if (prevEnv === undefined) delete process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS;
      else process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS = prevEnv;
    }
  });

  it('negative twin (vi-2638f25056ba): a slow-but-alive run that produces usable output inside an extension survives', async () => {
    // The 2026-09-11 starvation pattern: agy working through a slow disk goes
    // past the no-progress window with no *usable* output yet. The old guard
    // killed it outright (7 such kills in one day, each followed by a full
    // re-run); the new ladder extends once and the run finishes on its own.
    const prevEnv = process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS;
    process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS = '200';
    try {
      const path = join(scriptDir, 'agy-slow-but-alive.mjs');
      const early = [
        JSON.stringify({ event: 'init', conversation_id: CONV, init: { model: 'gemini-3.8-flash-high' } }),
        stepUpdate(1, { step_type: 'tool', tool_name: 'run_command', duration_seconds: 0.5 }),
      ];
      const late = [
        stepUpdate(2, { step_type: 'agent_response', text_delta: 'late answer\n', duration_seconds: 0.4 }),
        JSON.stringify({
          event: 'result',
          result: { conversation_id: CONV, status: 'SUCCESS', response: 'late answer\n', duration_seconds: 0.5, num_turns: 1 },
        }),
      ];
      // Emit the silent step, stay quiet past the 200ms window (forcing one
      // extension via the live child the process-tree check finds), then
      // produce usable output and finish. The child self-terminates quickly so
      // the test leaves nothing running after the parent exits.
      const content = `import { spawn } from 'node:child_process';\n`
        + `spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: 'ignore' });\n`
        + `process.stdout.write(${JSON.stringify(early.join('\n') + '\n')});\n`
        + `setTimeout(() => {\n  process.stdout.write(${JSON.stringify(late.join('\n') + '\n')});\n  process.exit(0);\n}, 350);\n`;
      await writeFile(path, content, 'utf8');
      const worker = makeWorker({ command: `"${process.execPath}"`, args: [path] });

      const result = await executeWorker(worker, 'test prompt', {
        timeout: 10,
        idleTimeout: 8,
      });

      assert.equal(result.success, true, `a run that finished inside its first extension must not be killed; got: ${result.error}`);
      assert.doesNotMatch(result.error ?? '', /agy-no-progress/);
      assert.match(result.output, /late answer/);
    } finally {
      if (prevEnv === undefined) delete process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS;
      else process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS = prevEnv;
    }
  });

  it('negative twin: the no-progress guard does not fire on a non-agy worker even if it hangs quietly', async () => {
    // Scopes the wall-clock guard to isAgyStreamWorker — a hanging non-agy
    // worker must be caught by the pre-existing idle timer, not this guard
    // (which would otherwise need to invent a "usable output" definition for
    // dialects it doesn't understand).
    const prevEnv = process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS;
    process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS = '200';
    try {
      const path = join(scriptDir, 'plain-hang.mjs');
      await writeFile(path, 'setInterval(() => {}, 1000);\n', 'utf8');
      const worker = makeWorker({
        name: 'codex',
        command: `"${process.execPath}"`,
        args: [path],
        output_format: undefined,
      });

      const result = await executeWorker(worker, 'test prompt', {
        timeout: 10,
        idleTimeout: 0.5, // 500ms — must be what actually kills this, not the 200ms agy-only guard
      });

      assert.equal(result.success, false);
      assert.doesNotMatch(result.error ?? '', /agy-no-progress/);
      assert.match(result.error ?? '', /idle timeout/);
    } finally {
      if (prevEnv === undefined) delete process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS;
      else process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS = prevEnv;
    }
  });
});

describe('narration-spin guard (P8, 2026-09-18): narration-only text_deltas are not usable output', () => {
  const NARRATION_LINES = [
    'Waiting for the command to finish.',
    'Stand by while the tool runs.',
    'Polling for the result.',
    'Checking back — 47%',
    'Still running — the step is in progress.',
    'Waiting for X to finish.',
  ];

  it('pure-unit: every observed narration shape classifies narration-only', () => {
    for (const line of NARRATION_LINES) {
      assert.equal(isNarrationOnly(line), true, `expected narration-only: ${line}`);
    }
    assert.equal(isNarrationOnly(NARRATION_LINES.join('\n')), true);
    assert.equal(isNarrationOnly(`  ${NARRATION_LINES[0]}\r\n\t${NARRATION_LINES[2]}  `), true, 'trims each line before matching');
  });

  it('pure-unit: substantive or empty text is never narration-only', () => {
    for (const line of ['progress 1', 'Committed abc123 ("subj")', 'Found 3 files', '✅ done', '', '   ']) {
      assert.equal(isNarrationOnly(line), false, `expected NOT narration-only: ${JSON.stringify(line)}`);
    }
    assert.equal(
      isNarrationOnly(`Waiting for the command to finish.\nFound 3 files.`),
      false,
      'one substantive line makes the whole delta usable',
    );
  });

  it('pure-unit: tightened checking-pattern — bare checking phrases narrate, substantive tails do not', () => {
    // The checking pattern anchors the keyword phrase to end-of-line, allowing
    // only whitespace/punctuation/digits after it — a substantive tail
    // ("… — 3 files need cleanup") carries content and is NOT narration.
    for (const line of ['Checking status.', 'Checking back.', 'Checking on — 47%']) {
      assert.equal(isNarrationOnly(line), true, `expected narration-only: ${line}`);
    }
    for (const line of [
      'Checking on disk usage — 3 files need cleanup.',
      'Checking status of build 47: found errors.',
      'Checking back on status.',
      'Checking on it.',
    ]) {
      assert.equal(isNarrationOnly(line), false, `expected NOT narration-only: ${line}`);
    }
  });

  it('known-bad case: an error/narration alternation still trips the error-loop counter', async () => {
    // The 668 s incident shape: agent_response steps carrying narration
    // ("waiting for X") instead of empty text_deltas. Pre-fix this reset the
    // usable-output test on every delta and the run never died; with
    // isNarrationOnly the counter must treat them as no output.
    const lines = [
      JSON.stringify({ event: 'init', conversation_id: CONV, init: { model: 'gemini-3.8-flash-high' } }),
      stepUpdate(1, { step_type: 'agent_response', text_delta: 'I am waiting for X to finish.', duration_seconds: 1.0 }),
      stepUpdate(2, { step_type: 'error_message', duration_seconds: 0 }),
      stepUpdate(3, { step_type: 'agent_response', text_delta: 'I am waiting for X to finish.', duration_seconds: 0.8 }),
      stepUpdate(4, { step_type: 'error_message', duration_seconds: 0 }),
      // Never reached if the guard fires at the 2nd consecutive error_message.
      stepUpdate(5, { step_type: 'agent_response', text_delta: 'Still running.', duration_seconds: 0.9 }),
      JSON.stringify({
        event: 'result',
        result: { conversation_id: CONV, status: 'SUCCESS', response: 'done\n', duration_seconds: 6.0, num_turns: 1 },
      }),
    ];
    const stub = await writeNdjsonStub('agy-narration-error-loop', lines);
    const worker = makeWorker({ command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });

    assert.equal(result.success, false, 'a narration/error alternation must still be judged spinning');
    assert.match(result.error ?? '', /agy-error-loop/);
    assert.match(result.error ?? '', /2 consecutive error_message/);
  });

  it('negative twin: narration steps followed by real usable output run to SUCCESS with output kept', async () => {
    const lines = [
      JSON.stringify({ event: 'init', conversation_id: CONV, init: { model: 'gemini-3.8-flash-high' } }),
      stepUpdate(1, { step_type: 'agent_response', text_delta: 'Waiting for the command to finish.', duration_seconds: 1.0 }),
      stepUpdate(2, { step_type: 'agent_response', text_delta: 'Polling for the result.', duration_seconds: 0.8 }),
      stepUpdate(3, { step_type: 'agent_response', text_delta: 'Committed abc123 ("subject line").\n', duration_seconds: 0.6 }),
      JSON.stringify({
        event: 'result',
        result: { conversation_id: CONV, status: 'SUCCESS', response: 'Committed abc123 ("subject line").\n', duration_seconds: 3.0, num_turns: 2 },
      }),
    ];
    const stub = await writeNdjsonStub('agy-narration-then-real', lines);
    const worker = makeWorker({ command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });

    assert.equal(result.success, true, `a run that delivers substance after narration must survive; got: ${result.error}`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'Committed abc123 ("subject line").\n');
  });

  it('known-bad case: a run emitting ONLY recurring narration deltas dies on the no-progress guard, not the absolute timeout', async () => {
    // Discriminating fixture: narration deltas arrive RECURRINGLY, so without
    // the narration exclusion each one resets the no-progress timer forever and
    // the run survives to the absolute timeout; with it, the wall-clock guard
    // fires early (the ladder's extend-vs-kill choice — live child => extend,
    // NO_PROGRESS_MAX_EXTENDS cap — is already proven by the zero-delta wall-
    // clock twin above on the identical mechanism). The `agy-no-progress`
    // marker is the discriminator: a broken exclusion ends the run with
    // "exceeded max timeout" instead. The ladder's own latency is load-
    // dependent — each live-child extension runs process-tree queries whose
    // cost on a contended machine (WMI snapshots, seconds each) dwarfs the
    // 200ms window — so NO wall-clock bound is asserted: a fixed bound proved
    // to be the flake (got 6905ms vs a 5000ms cap on a loaded box, 2026-09-20,
    // with the guard demonstrably firing).
    const prevEnv = process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS;
    process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS = '200';
    try {
      const path = join(scriptDir, 'agy-narration-spin.mjs');
      const first = [
        JSON.stringify({ event: 'init', conversation_id: CONV, init: { model: 'gemini-3.8-flash-high' } }),
        stepUpdate(1, { step_type: 'agent_response', text_delta: 'Waiting for X to finish.', duration_seconds: 0.5 }),
      ];
      const recurring = stepUpdate(2, { step_type: 'agent_response', text_delta: 'Still waiting for X.', duration_seconds: 0.1 });
      const content = `import { spawn } from 'node:child_process';\n`
        + `spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });\n`
        + `process.stdout.write(${JSON.stringify(first.join('\n') + '\n')});\n`
        + `setInterval(() => { process.stdout.write(${JSON.stringify(recurring + '\n')}); }, 50);\n`;
      await writeFile(path, content, 'utf8');
      const worker = makeWorker({ command: `"${process.execPath}"`, args: [path] });

      const result = await executeWorker(worker, 'test prompt', {
        timeout: 10,
        idleTimeout: 8, // well above the 200ms no-progress window so idle timeout can't mask it
      });

      assert.equal(result.success, false);
      assert.match(result.error ?? '', /agy-no-progress/, `expected a greppable agy-no-progress reason, got: ${result.error}`);
    } finally {
      if (prevEnv === undefined) delete process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS;
      else process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS = prevEnv;
    }
  });
});
