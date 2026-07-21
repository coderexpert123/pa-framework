import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'fs/promises';
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
  scriptDir = join(tmpdir(), `pa-test-wexec-trim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

/**
 * Write a stub CLI that replays a fixed NDJSON event stream on stdout, the way a
 * `--output-format stream-json` worker does. `trailingNewline: false` leaves the
 * final event without its newline so it is parsed by the close-handler's
 * trailing-buffer flush instead of the per-line loop (both paths track the
 * gemini tool boundary, so both need coverage).
 */
async function writeStreamScript(
  name: string,
  events: unknown[],
  opts: { trailingNewline?: boolean } = {},
): Promise<string> {
  const trailingNewline = opts.trailingNewline !== false;
  const lines = events.map((e) => JSON.stringify(e) + '\n');
  if (!trailingNewline && lines.length > 0) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/\n$/, '');
  }
  const path = join(scriptDir, name);
  await writeFile(path, `process.stdout.write(${JSON.stringify(lines.join(''))});\n`, 'utf8');
  return path;
}

/** Gemini assistant-text event: { type: 'message', role: 'assistant', content: '...' } */
function assistant(text: string) {
  return { type: 'message', role: 'assistant', content: text };
}

const toolResult = { type: 'tool_result', tool: 'read_file' };

async function runStream(
  scriptName: string,
  events: unknown[],
  workerOverrides: Partial<WorkerConfig> = {},
  opts: { trailingNewline?: boolean } = {},
) {
  const script = await writeStreamScript(scriptName, events, opts);
  const worker = makeWorker({
    name: 'gemini',
    command: 'node',
    args: [script],
    input_mode: 'arg',
    output_format: 'stream-json',
    ...workerOverrides,
  });
  return executeWorker(worker, 'test prompt', { timeout: 15, resource: `skill-${scriptName}` });
}

describe('worker-exec gemini tool-boundary trim', () => {
  it('keeps the pre-trim output when the last stream event is a tool_result (never empties stdout)', async () => {
    // The defect: lastToolBoundary is reset to stdout.length after EVERY tool_result,
    // so a run ending on a tool call leaves boundary === stdout.length and the raw
    // slice returns ''. Since run.ts now scores empty stdout from a telegram_output
    // skill as a hard failure, three such correct-but-emptied runs park the skill via
    // the AI-098 backoff. Losing the trim is strictly better than losing the output.
    const result = await runStream('last-event-tool.js', [
      assistant('SEGMENT_ONE '),
      toolResult,
      assistant('SEGMENT_TWO'),
      toolResult,
    ]);

    assert.equal(result.success, true);
    assert.ok(result.output.includes('SEGMENT_TWO'),
      `Output was emptied by the trim: ${JSON.stringify(result.output)}`);
    assert.ok(result.output.includes('SEGMENT_ONE'),
      `Expected the untrimmed stdout to survive, got: ${JSON.stringify(result.output)}`);
  });

  it('still trims intermediate narration when assistant text follows the last tool_result', async () => {
    // Regression guard for the trim's actual purpose — this must fail if the trim is
    // ever weakened into a no-op.
    const result = await runStream('text-after-tool.js', [
      assistant('PLANNING_NARRATION '),
      toolResult,
      assistant('FINAL_ANSWER'),
    ]);

    assert.equal(result.success, true);
    assert.equal(result.output, 'FINAL_ANSWER');
    assert.ok(!result.output.includes('PLANNING_NARRATION'),
      `Intermediate narration should have been trimmed, got: ${JSON.stringify(result.output)}`);
  });

  it('falls back to the untrimmed output when only whitespace follows the last tool_result', async () => {
    // Whitespace-only is indistinguishable from empty to every downstream consumer
    // (they all compare on trimmed output), so it takes the same fallback.
    const result = await runStream('whitespace-after-tool.js', [
      assistant('REAL_CONTENT'),
      toolResult,
      assistant('  \n  '),
    ]);

    assert.equal(result.success, true);
    assert.ok(result.output.includes('REAL_CONTENT'),
      `Whitespace-only trim should have fallen back, got: ${JSON.stringify(result.output)}`);
  });

  it('applies the same guard when the final tool_result arrives in the trailing buffer', async () => {
    // The close handler re-implements the boundary tracking for a final event with no
    // terminating newline; the guard covers that path too.
    const result = await runStream('trailing-buffer-tool.js', [
      assistant('SEGMENT_ONE '),
      toolResult,
      assistant('SEGMENT_TWO'),
      toolResult,
    ], {}, { trailingNewline: false });

    assert.equal(result.success, true);
    assert.ok(result.output.includes('SEGMENT_TWO'),
      `Output was emptied by the trim: ${JSON.stringify(result.output)}`);
  });

  it('trims for the agy worker exactly as for gemini, and never empties it either', async () => {
    const trimmed = await runStream('agy-text-after-tool.js', [
      assistant('PLANNING_NARRATION '),
      toolResult,
      assistant('FINAL_ANSWER'),
    ], { name: 'agy' });
    assert.equal(trimmed.output, 'FINAL_ANSWER');

    const guarded = await runStream('agy-last-event-tool.js', [
      assistant('FULL_OUTPUT'),
      toolResult,
    ], { name: 'agy' });
    assert.ok(guarded.output.includes('FULL_OUTPUT'),
      `agy output was emptied by the trim: ${JSON.stringify(guarded.output)}`);
  });

  it('never trims a non-gemini worker', async () => {
    // Boundary tracking is gemini/agy-only; a claude-named worker keeps everything.
    const result = await runStream('non-gemini.js', [
      assistant('SEGMENT_ONE '),
      toolResult,
      assistant('SEGMENT_TWO'),
      toolResult,
    ], { name: 'claude' });

    assert.equal(result.success, true);
    assert.equal(result.output, 'SEGMENT_ONE SEGMENT_TWO');
  });

  it('leaves output untouched when the boundary is still 0 (tool_result before any text)', async () => {
    const result = await runStream('boundary-zero.js', [
      toolResult,
      assistant('SEGMENT_ONE '),
      assistant('SEGMENT_TWO'),
    ]);

    assert.equal(result.success, true);
    assert.equal(result.output, 'SEGMENT_ONE SEGMENT_TWO');
  });

  it('leaves output untouched when the stream contains no tool_result at all', async () => {
    const result = await runStream('no-tool.js', [
      assistant('ONLY_'),
      assistant('SEGMENT'),
    ]);

    assert.equal(result.success, true);
    assert.equal(result.output, 'ONLY_SEGMENT');
  });
});
