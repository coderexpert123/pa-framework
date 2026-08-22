import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { executeWorker } from '../src/workers.js';
import type { WorkerConfig } from '../src/types.js';

// Fixture data from scratch/agy-stream-json-fixtures.jsonl (inlined to avoid gitignore dependency)
const AGY_FIXTURE_RUN1 = [
  '{"event":"init","conversation_id":"9b2b429c-9579-47e9-8c95-477e4a0cbebb","init":{"model":"gemini-3.7-flash-low","cwd":"D:/repo","tools":["ask_permission","ask_question","browser_click_element","browser_drag_pixel_to_pixel","browser_get_dom","browser_get_network_request","browser_input","browser_list_network_requests","browser_mouse_down","browser_mouse_up","browser_move_mouse","browser_press_key","browser_refresh_page","browser_resize_window","browser_scroll","browser_scroll_dom","browser_select_option","browser_subagent","call_mcp_tool","capture_browser_console_logs","capture_browser_screenshot","click_browser_pixel","command_status","define_subagent","delete_knowledge","execute_browser_javascript","find_by_name","finish","generate_image","grep_search","invoke_subagent","list_browser_pages","list_dir","list_permissions","list_resources","manage_inbox","manage_subagents","manage_task","multi_replace_file_content","notebook_edit","notebook_execution","open_browser_url","read_browser_page","read_resource","read_url_content","replace_file_content","run_command","schedule","search_web","sed_file_content","send_command_input","send_message","view_file","wait","wait_5_seconds","write_to_file"],"permission_mode":"always-proceed"}}',
  '{"event":"step_update","step_update":{"conversation_id":"9b2b429c-9579-47e9-8c95-477e4a0cbebb","step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"conversation_id":"9b2b429c-9579-47e9-8c95-477e4a0cbebb","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"ok\\n","duration_seconds":1.614421,"usage":{"input_tokens":20537,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":20538}}}',
  '{"event":"result","result":{"conversation_id":"9b2b429c-9579-47e9-8c95-477e4a0cbebb","status":"SUCCESS","response":"ok\\n","duration_seconds":3.1579471,"num_turns":1,"usage":{"input_tokens":20634,"output_tokens":5,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":20639}}}',
];

const AGY_FIXTURE_RUN2 = [
  '{"event":"step_update","step_update":{"conversation_id":"9b2b429c-9579-47e9-8c95-477e4a0cbebb","step_index":6,"state":"DONE","step_type":"agent_response","text_delta":"ok\\n","duration_seconds":1.8557079,"usage":{"input_tokens":4467,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":16296,"total_tokens":4468}}}',
  '{"event":"result","result":{"conversation_id":"9b2b429c-9579-47e9-8c95-477e4a0cbebb","status":"SUCCESS","response":"ok\\n","duration_seconds":65.1529793,"num_turns":2,"usage":{"input_tokens":25101,"output_tokens":6,"thinking_tokens":0,"cache_read_tokens":16296,"total_tokens":25107}}}',
];

const AGY_INIT_ONLY = [
  '{"event":"init","conversation_id":"9b2b429c-9579-47e9-8c95-477e4a0cbebb","init":{"model":"gemini-3.7-flash-low","cwd":"D:/repo","tools":["ask_permission"],"permission_mode":"always-proceed"}}',
];

const AGY_INIT_AND_STEP_UPDATE = [
  '{"event":"init","conversation_id":"9b2b429c-9579-47e9-8c95-477e4a0cbebb","init":{"model":"gemini-3.7-flash-low"}}',
  '{"event":"step_update","step_update":{"conversation_id":"9b2b429c-9579-47e9-8c95-477e4a0cbebb","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"fallback response\\n"}}',
];

const AGY_ERROR_RESULT = [
  '{"event":"init","conversation_id":"test-id","init":{"model":"gemini-3.7-flash-low"}}',
  '{"event":"result","result":{"conversation_id":"test-id","status":"ERROR","response":"API quota exceeded"}}',
];

const CLAUDE_EVENT_STREAM = [
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hello from claude"}]}}',
];

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  await createTempSecrets(tempDir, '');
  scriptDir = join(tmpdir(), `pa-test-agy-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// Stub that emits NDJSON lines to stdout. Node stub, not powershell: the old
// powershell.exe stub was the flake source (startup time under full-suite load
// raced the worker timeout — 2026-08-17); node spawns in well under a second
// on every platform, deterministically.
async function writeNdjsonStub(name: string, lines: string[], opts: { noTrailingNewline?: boolean } = {}): Promise<{ command: string; args: string[] }> {
  const path = join(scriptDir, `${name}.mjs`);
  const content = lines.join('\n') + (opts.noTrailingNewline ? '' : '\n');
  await writeFile(path, `process.stdout.write(${JSON.stringify(content)})\n`, 'utf8');
  // Quote the node path: on this deployment it lives under "D:\Program Files",
  // and the worker spawn goes through a shell that splits unquoted spaced paths.
  return { command: `"${process.execPath}"`, args: [path] };
}

describe('worker-exec agy stream-json parsing', () => {
  it('agy stream-json captures conversation_id from init event', async () => {
    const stub = await writeNdjsonStub('agy-init', AGY_FIXTURE_RUN1);
    const worker = makeWorker({ command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });

    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, '9b2b429c-9579-47e9-8c95-477e4a0cbebb');
  });

  it('agy stream-json extracts response from result event', async () => {
    const stub = await writeNdjsonStub('agy-full', AGY_FIXTURE_RUN1);
    const worker = makeWorker({ command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'ok\n');
  });

  it('agy stream-json captures conversation_id from result event (belt-and-suspenders)', async () => {
    const stub = await writeNdjsonStub('agy-result-only', [AGY_FIXTURE_RUN2[1]]);
    const worker = makeWorker({ command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });

    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, '9b2b429c-9579-47e9-8c95-477e4a0cbebb');
  });

  it('agy stream-json fallback: accumulates text_delta when no result event', async () => {
    const stub = await writeNdjsonStub('agy-fallback', AGY_INIT_AND_STEP_UPDATE);
    const worker = makeWorker({ command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'fallback response\n');
  });

  it('agy stream-json: empty output on malformed stream (no result, no text_delta)', async () => {
    const stub = await writeNdjsonStub('agy-malformed', AGY_INIT_ONLY);
    const worker = makeWorker({ command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, '');
  });

  it('agy stream-json: captures error text from non-SUCCESS result', async () => {
    const stub = await writeNdjsonStub('agy-error', AGY_ERROR_RESULT);
    const worker = makeWorker({ command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });

    assert.equal(result.exitCode, 0);
    assert.ok(result.error && result.error.includes('API quota exceeded'), `Expected error to contain 'API quota exceeded', got: ${result.error}`);
  });

  it('agy stream-json: trailing buffer flush captures result event', async () => {
    // Events WITHOUT a terminating newline must still be parsed — the fixture
    // deliberately omits the final newline so the trailing-buffer flush path runs.
    const stub = await writeNdjsonStub('agy-trailing', AGY_FIXTURE_RUN1, { noTrailingNewline: true });
    const worker = makeWorker({ command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'ok\n');
    assert.equal(result.sessionId, '9b2b429c-9579-47e9-8c95-477e4a0cbebb');
  });

  it('agy stream-json: does not interfere with claude/codex/gemini event parsing', async () => {
    const stub = await writeNdjsonStub('claude-stream', CLAUDE_EVENT_STREAM);
    const worker = makeWorker({
      name: 'claude',
      command: stub.command,
      args: stub.args,
      output_format: 'stream-json',
    });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'hello from claude');
  });

  // agyc is the same agy.exe binary with a pinned non-gemini model — it emits
  // the identical event dialect. Regression guard for the 2026-08-21 incident:
  // parsing was gated on the literal name 'agy', so every agyc reply was
  // discarded (exit 0, output '', "silent no-op" — three failed commit runs).
  it('agyc stream-json: same dialect as agy, response extracted from result event', async () => {
    const stub = await writeNdjsonStub('agyc-full', AGY_FIXTURE_RUN1);
    const worker = makeWorker({ name: 'agyc', command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'ok\n');
    assert.equal(result.sessionId, '9b2b429c-9579-47e9-8c95-477e4a0cbebb');
  });

  it('agyc stream-json: text_delta fallback accumulates when no result event', async () => {
    const stub = await writeNdjsonStub('agyc-fallback', AGY_INIT_AND_STEP_UPDATE);
    const worker = makeWorker({ name: 'agyc', command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'fallback response\n');
  });

  it('agyc stream-json: captures error text from non-SUCCESS result', async () => {
    const stub = await writeNdjsonStub('agyc-error', AGY_ERROR_RESULT);
    const worker = makeWorker({ name: 'agyc', command: stub.command, args: stub.args });

    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });

    assert.equal(result.exitCode, 0);
    assert.ok(result.error && result.error.includes('API quota exceeded'), `Expected error to contain 'API quota exceeded', got: ${result.error}`);
  });
});
