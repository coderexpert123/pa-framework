import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempPaHome, createTempConfig, createTempSecrets, cleanup } from './helpers.js';
import { checkWorker, executeWorker, isRateLimited, runWithFailover, readStateTail, clearRateLimitCache } from '../src/workers.js';
import type { WorkerConfig } from '../src/types.js';
import { notifyUser } from '../src/lib/notify.js';

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  clearRateLimitCache();
  // Create a temp dir for helper scripts to avoid shell escaping issues
  scriptDir = join(tmpdir(), `pa-test-scripts-${Date.now()}`);
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

// Write a small node script to a file (avoids -e shell escaping on Windows)
async function writeScript(name: string, code: string): Promise<string> {
  const path = join(scriptDir, name);
  await writeFile(path, code, 'utf8');
  return path;
}

describe('checkWorker', () => {
  it('returns true for valid command', async () => {
    const result = await checkWorker(makeWorker({ check: 'echo ok' }));
    assert.equal(result, true);
  });

  it('returns false for invalid command', async () => {
    const result = await checkWorker(makeWorker({ check: 'nonexistent_command_xyz_123' }));
    assert.equal(result, false);
  });

  it('passes environment variables to check command', async () => {
    const script = await writeScript('env.js', 'if (process.env.TEST_VAR === "ok") process.exit(0); else process.exit(1);');
    const result = await checkWorker(makeWorker({
      check: `node "${script}"`,
    }), { TEST_VAR: 'ok' });
    assert.equal(result, true);
  });

  it('returns false when command times out', async () => {
    const script = await writeScript('slow.js', 'setTimeout(()=>{}, 60000);');
    const result = await checkWorker(makeWorker({
      check: `node "${script}"`,
      check_timeout: 1,
    }));
    assert.equal(result, false);
  });
});

describe('executeWorker', () => {
  it('captures stdout from command', async () => {
    const script = await writeScript('stdout.js', 'process.stdout.write("hello output");');
    const worker = makeWorker({
      command: 'node',
      args: [script],
    });
    const result = await executeWorker(worker, 'unused', { timeout: 10 });
    assert.equal(result.success, true);
    assert.ok(result.output.includes('hello output'));
  });

  it('captures stderr', async () => {
    const script = await writeScript('stderr.js', 'process.stderr.write("err msg");');
    const worker = makeWorker({
      command: 'node',
      args: [script],
    });
    const result = await executeWorker(worker, 'unused', { timeout: 10 });
    assert.ok(result.error?.includes('err msg'));
  });

  it('returns success=false for non-zero exit', async () => {
    const script = await writeScript('fail.js', 'process.exit(1);');
    const worker = makeWorker({
      command: 'node',
      args: [script],
    });
    const result = await executeWorker(worker, 'unused', { timeout: 10 });
    assert.equal(result.success, false);
    assert.equal(result.exitCode, 1);
  });

  it('kills on idle timeout', async () => {
    // Use ping with a long count — it produces no stdout (on Windows, ping to
    // a non-routable address hangs silently), and the heartbeat won't find
    // the node subprocess since we run ping directly.
    // Alternatively: use a worker with no state_dir to disable heartbeat extensions.
    const script = await writeScript('hang.js', 'setTimeout(()=>{}, 60000);');
    const worker = makeWorker({
      command: 'node',
      args: [script],
      // No state_dir — disables state file heartbeat
      state_dir: undefined,
    });
    const start = Date.now();
    // idleTimeout = 3s, but heartbeat checks every 30s detect child processes.
    // The checkAndMaybeKill will still find child processes via hasChildProcesses.
    // To truly test idle kill, we need a very short timeout that fires before
    // the 30s heartbeat interval.
    const result = await executeWorker(worker, 'unused', { timeout: 10, idleTimeout: 3 });
    const elapsed = Date.now() - start;
    assert.equal(result.success, false);
    // Should have been killed by max timeout (10s) at most
    assert.ok(elapsed < 15000, `Should have killed within 10s, took ${elapsed}ms`);
  });

  it('kills on idle timeout with stuck agent state', async () => {
    const stateDir = join(tempDir, 'state-stuck');
    await mkdir(stateDir, { recursive: true });
    
    // Create a stuck state file (Gemini format: ends with ?)
    const stateFile = join(stateDir, 'session.json');
    await writeFile(stateFile, JSON.stringify({
      messages: [
        { type: 'user', content: 'hello' },
        { type: 'gemini', content: 'How can I help you?' } 
      ]
    }), 'utf8');

    const script = await writeScript('hang-stuck.js', 'setTimeout(()=>{}, 60000);');
    const worker = makeWorker({
      command: 'node',
      args: [script],
      state_dir: stateDir,
      state_pattern: 'session.json'
    });

    const result = await executeWorker(worker, 'unused', { timeout: 10, idleTimeout: 2 });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('asking a question'), `Expected stuck message, got: ${result.error}`);
  });

  it('extends idle timeout if agent is working (pending tool)', async () => {
    const stateDir = join(tempDir, 'state-alive');
    await mkdir(stateDir, { recursive: true });
    
    // Create an alive state file (Claude JSONL format: pending tool_use)
    const stateFile = join(stateDir, 'session.jsonl');
    await writeFile(stateFile, JSON.stringify({ type: 'tool_use', name: 'long_tool' }) + '\n', 'utf8');

    const script = await writeScript('hang-alive.js', 'setTimeout(()=>{}, 60000);');
    const worker = makeWorker({
      command: 'node',
      args: [script],
      state_dir: stateDir,
      state_pattern: 'session.jsonl'
    });

    // Start execution with short idle timeout
    const start = Date.now();
    const resultPromise = executeWorker(worker, 'unused', { timeout: 5, idleTimeout: 2 });
    
    // After 3 seconds, update the state file to keep it alive (Rule 4: recent activity)
    setTimeout(async () => {
      await writeFile(stateFile, 
        JSON.stringify({ type: 'tool_use', name: 'long_tool' }) + '\n' +
        JSON.stringify({ type: 'assistant', content: 'still working' }) + '\n', 
      'utf8');
    }, 3000);

    const result = await resultPromise;
    const elapsed = Date.now() - start;

    // Should eventually hit MAX timeout (5s) because it kept extending idle
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('exceeded max timeout'), `Expected max timeout, got: ${result.error}`);
    assert.ok(elapsed >= 4500, `Should have lasted at least 4.5s, took ${elapsed}ms`);
  });

  it('stdin-json mode sends prompt via stdin', async () => {
    const script = await writeScript('stdin.js', `
      let d = '';
      process.stdin.on('data', c => d += c);
      process.stdin.on('end', () => {
        const m = JSON.parse(d);
        process.stdout.write(m.message.content);
      });
    `);
    const worker = makeWorker({
      command: 'node',
      args: [script],
      input_mode: 'stdin-json',
    });
    const result = await executeWorker(worker, 'test prompt via stdin', { timeout: 10 });
    assert.equal(result.success, true);
    assert.ok(result.output.includes('test prompt via stdin'));
  });

  it('NDJSON parsing extracts result event', async () => {
    const lines = [
      JSON.stringify({ type: 'system', message: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }),
      JSON.stringify({ type: 'result', result: 'final answer' }),
    ];
    const script = await writeScript('ndjson.js', `
      const lines = ${JSON.stringify(lines)};
      for (const line of lines) {
        process.stdout.write(line + '\\n');
      }
    `);
    const worker = makeWorker({
      command: 'node',
      args: [script],
      output_format: 'stream-json',
    });
    const result = await executeWorker(worker, 'unused', { timeout: 10 });
    assert.equal(result.success, true);
    assert.equal(result.output, 'final answer');
  });

  it('NDJSON parsing captures sessionId from assistant event', async () => {
    const sessionId = 'e0912e78-2c5b-4359-89a9-c0aa7915a346';
    const lines = [
      JSON.stringify({ type: 'assistant', sessionId, message: { content: [{ type: 'text', text: 'hello' }] } }),
      JSON.stringify({ type: 'result', result: 'hello' }),
    ];
    const script = await writeScript('session-id.js', `
      const lines = ${JSON.stringify(lines)};
      for (const line of lines) {
        process.stdout.write(line + '\\n');
      }
    `);
    const worker = makeWorker({
      command: 'node',
      args: [script],
      output_format: 'stream-json',
    });
    const result = await executeWorker(worker, 'unused', { timeout: 10 });
    assert.equal(result.sessionId, sessionId);
  });

  it('sessionId is undefined when not present in NDJSON events', async () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'no session' }] } }),
      JSON.stringify({ type: 'result', result: 'no session' }),
    ];
    const script = await writeScript('no-session.js', `
      const lines = ${JSON.stringify(lines)};
      for (const line of lines) {
        process.stdout.write(line + '\\n');
      }
    `);
    const worker = makeWorker({
      command: 'node',
      args: [script],
      output_format: 'stream-json',
    });
    const result = await executeWorker(worker, 'unused', { timeout: 10 });
    assert.equal(result.sessionId, undefined);
  });

  it('sessionId is undefined for non-stream-json output', async () => {
    const script = await writeScript('plain.js', 'process.stdout.write("plain output");');
    const worker = makeWorker({
      command: 'node',
      args: [script],
      // no output_format — plain text mode
    });
    const result = await executeWorker(worker, 'unused', { timeout: 10 });
    assert.equal(result.sessionId, undefined);
  });

  it('extraArgs are passed to worker without error (stdin-json mode)', async () => {
    // --no-warnings is a valid node flag — verifies extraArgs prepend without breaking execution
    const script = await writeScript('extra-noop.js', `
      let d = ''; process.stdin.on('data', c => d += c);
      process.stdin.on('end', () => process.stdout.write('ok'));
    `);
    const worker = makeWorker({
      command: 'node',
      args: [script],
      input_mode: 'stdin-json',
    });
    const result = await executeWorker(worker, 'test', { timeout: 10, extraArgs: ['--no-warnings'] });
    assert.equal(result.success, true);
    assert.equal(result.output, 'ok');
  });

  it('extraArgs change command behavior when a different valid flag is used (arg mode)', async () => {
    // With no extraArgs: runs the script and outputs 'running'
    // With extraArgs ['arg1']: the script echoes its args including 'arg1'
    const script = await writeScript('extra-arg-mode.js', 'process.stdout.write("running " + process.argv.slice(2).join(" "));');
    const worker = makeWorker({
      command: 'node',
      args: [script],
      input_mode: 'arg',
    });
    const withoutExtra = await executeWorker(worker, 'unused', { timeout: 10 });
    const withExtra = await executeWorker(worker, 'unused', { timeout: 10, extraArgs: ['flag1'] });

    assert.ok(withoutExtra.output.includes('running'));
    assert.ok(withExtra.output.includes('flag1'));
  });

  it('stdin-text mode sends prompt as plain text to stdin', async () => {
    const script = await writeScript('stdin-text.js', `
      let d = '';
      process.stdin.on('data', c => d += c);
      process.stdin.on('end', () => process.stdout.write('received:' + d.trim()));
    `);
    const worker = makeWorker({
      command: 'node',
      args: [script],
      input_mode: 'stdin-text',
    });
    const result = await executeWorker(worker, 'hello world', { timeout: 10 });
    assert.equal(result.success, true);
    assert.equal(result.output, 'received:hello world');
  });

  it('handles args with spaces in path on Windows shell spawn', async () => {
    const script = await writeScript('echo-args.js', `
      let d = '';
      process.stdin.on('data', c => d += c);
      process.stdin.on('end', () => process.stdout.write(JSON.stringify(process.argv)));
    `);
    const fakeProjectPath = 'C:/fake project/with spaces';
    const worker = makeWorker({
      command: 'node',
      args: [script, '-C', fakeProjectPath, '-'],
      input_mode: 'stdin-text',
    });
    const result = await executeWorker(worker, 'test prompt', { timeout: 10 });
    assert.equal(result.success, true);
    const parsed = JSON.parse(result.output.trim());
    assert.ok(parsed.includes('-C'));
    assert.ok(parsed.includes(fakeProjectPath));
    assert.ok(parsed.includes('-'));
  });

  it('Gemini-style NDJSON: captures session_id from init event', async () => {
    const sessionId = '1bd4d6b1-4c41-4ca3-b8a0-9912b246d62a';
    const lines = [
      JSON.stringify({ type: 'init', session_id: sessionId, model: 'gemini-3' }),
      JSON.stringify({ type: 'message', role: 'user', content: 'say hello' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'HELLO', delta: true }),
      JSON.stringify({ type: 'result', status: 'success', stats: {} }),
    ];
    const script = await writeScript('gemini-stream.js', `
      const lines = ${JSON.stringify(lines)};
      lines.forEach(l => process.stdout.write(l + '\\n'));
    `);
    const worker = makeWorker({
      command: 'node',
      args: [script],
      input_mode: 'stdin-text',
      output_format: 'stream-json',
    });
    const result = await executeWorker(worker, 'unused', { timeout: 10 });
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.output, 'HELLO');
  });

  it('Gemini-style NDJSON: discards content before last tool_result for gemini worker', async () => {
    const lines = [
      JSON.stringify({ type: 'init', session_id: 'abc-123', model: 'gemini-3' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: '**Planning** I will search for this.', delta: true }),
      JSON.stringify({ type: 'tool_use', tool_name: 'google_web_search', tool_id: 't1', parameters: { query: 'weather' } }),
      JSON.stringify({ type: 'tool_result', tool_id: 't1', status: 'success', output: '26 degrees' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'It is currently 26°C in Bangalore.', delta: true }),
      JSON.stringify({ type: 'result', status: 'success', stats: {} }),
    ];
    const script = await writeScript('gemini-tool-boundary.js', `
      const lines = ${JSON.stringify(lines)};
      lines.forEach(l => process.stdout.write(l + '\\n'));
    `);
    const worker = makeWorker({
      name: 'gemini',
      command: 'node',
      args: [script],
      input_mode: 'stdin-text',
      output_format: 'stream-json',
    });
    const result = await executeWorker(worker, 'unused', { timeout: 10 });
    assert.equal(result.output, 'It is currently 26°C in Bangalore.');
  });

  it('Gemini-style NDJSON: does not discard content for non-gemini workers', async () => {
    const lines = [
      JSON.stringify({ type: 'message', role: 'assistant', content: 'planning text', delta: true }),
      JSON.stringify({ type: 'tool_result', tool_id: 't1', status: 'success', output: 'result' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: ' final answer', delta: true }),
      JSON.stringify({ type: 'result', status: 'success', stats: {} }),
    ];
    const script = await writeScript('non-gemini-tool.js', `
      const lines = ${JSON.stringify(lines)};
      lines.forEach(l => process.stdout.write(l + '\\n'));
    `);
    const worker = makeWorker({
      name: 'claude',
      command: 'node',
      args: [script],
      input_mode: 'stdin-text',
      output_format: 'stream-json',
    });
    const result = await executeWorker(worker, 'unused', { timeout: 10 });
    assert.equal(result.output, 'planning text final answer');
  });

  it('Gemini-style NDJSON: preserves full output when no tool_result present', async () => {
    const lines = [
      JSON.stringify({ type: 'init', session_id: 'abc-123', model: 'gemini-3' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'Direct answer with no tool use.', delta: true }),
      JSON.stringify({ type: 'result', status: 'success', stats: {} }),
    ];
    const script = await writeScript('gemini-no-tool.js', `
      const lines = ${JSON.stringify(lines)};
      lines.forEach(l => process.stdout.write(l + '\\n'));
    `);
    const worker = makeWorker({
      name: 'gemini',
      command: 'node',
      args: [script],
      input_mode: 'stdin-text',
      output_format: 'stream-json',
    });
    const result = await executeWorker(worker, 'unused', { timeout: 10 });
    assert.equal(result.output, 'Direct answer with no tool use.');
  });

  it('Gemini-style NDJSON: accumulates multi-chunk assistant content', async () => {
    const lines = [
      JSON.stringify({ type: 'init', session_id: 'abc-123', model: 'gemini-3' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'Hello ', delta: true }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'world', delta: true }),
      JSON.stringify({ type: 'result', status: 'success', stats: {} }),
    ];
    const script = await writeScript('gemini-chunks.js', `
      const lines = ${JSON.stringify(lines)};
      lines.forEach(l => process.stdout.write(l + '\\n'));
    `);
    const worker = makeWorker({
      command: 'node',
      args: [script],
      input_mode: 'stdin-text',
      output_format: 'stream-json',
    });
    const result = await executeWorker(worker, 'unused', { timeout: 10 });
    assert.equal(result.output, 'Hello world');
  });

  it('injects PA_BOT_PID into worker env', async () => {
    const script = await writeScript('botpid.js',
      'process.stdout.write(process.env.PA_BOT_PID || "MISSING");');
    const worker = makeWorker({ command: 'node', args: [script] });
    const result = await executeWorker(worker, 'unused', { timeout: 10 });
    assert.equal(result.success, true);
    assert.equal(result.output.trim(), String(process.pid));
  });

  it('does not let caller override PA_BOT_PID via options.env', async () => {
    const script = await writeScript('botpid-override.js',
      'process.stdout.write(process.env.PA_BOT_PID || "MISSING");');
    const worker = makeWorker({ command: 'node', args: [script] });
    const result = await executeWorker(worker, 'unused', { timeout: 10, env: { PA_BOT_PID: '99999' } });
    assert.equal(result.output.trim(), String(process.pid));
  });
});

describe('isRateLimited', () => {
  it('matches patterns case-insensitively', () => {
    const worker = makeWorker({ rate_limit_patterns: ['rate limit'] });
    const result = { success: false, output: '', error: 'RATE LIMIT exceeded', exitCode: 1 };
    const rl = isRateLimited(worker, result);
    assert.equal(rl.hit, true);
    assert.equal(rl.pattern, 'rate limit');
    assert.ok(rl.snippet?.toLowerCase().includes('rate limit'));
  });

  it('matches in output text', () => {
    const worker = makeWorker({ rate_limit_patterns: ['quota'] });
    const result = { success: false, output: 'Error: quota exceeded', error: '', exitCode: 1 };
    const rl = isRateLimited(worker, result);
    assert.equal(rl.hit, true);
    assert.equal(rl.pattern, 'quota');
    assert.ok(rl.snippet?.includes('quota'));
  });

  it('returns hit=false when no match', () => {
    const worker = makeWorker({ rate_limit_patterns: ['rate limit'] });
    const result = { success: false, output: '', error: 'syntax error', exitCode: 1 };
    assert.equal(isRateLimited(worker, result).hit, false);
  });

  it('returns hit=false with empty patterns', () => {
    const worker = makeWorker({ rate_limit_patterns: [] });
    const result = { success: false, output: 'rate limit', error: '', exitCode: 1 };
    assert.equal(isRateLimited(worker, result).hit, false);
  });

  it('for codex: only scans error field, NOT output (false-positive protection)', () => {
    const worker = makeWorker({ name: 'codex', rate_limit_patterns: ['hit your usage limit'] });
    // Agent text accidentally contains the phrase + non-zero exit (e.g., transient crash)
    const result = {
      success: false,
      output: "Here's how to handle when users hit your usage limit in an API.",
      error: '',
      exitCode: 1,
    };
    assert.equal(isRateLimited(worker, result).hit, false,
      'codex rate-limit check must not scan agent output');
  });

  it('for codex: matches when pattern is in error field (stream error event)', () => {
    const worker = makeWorker({ name: 'codex', rate_limit_patterns: ['hit your usage limit'] });
    const result = {
      success: false,
      output: '',
      error: "You've hit your usage limit. Upgrade to Plus.",
      exitCode: 1,
    };
    const rl = isRateLimited(worker, result);
    assert.equal(rl.hit, true);
    assert.equal(rl.pattern, 'hit your usage limit');
  });

  it('for gemini: only scans error field, NOT output (same as codex)', () => {
    // gemini errors come from stderr (Google API errors), not agent output
    const worker = makeWorker({ name: 'gemini', rate_limit_patterns: ['RESOURCE_EXHAUSTED'] });
    // pattern in output only → must NOT match
    const inOutput = { success: false, output: 'RESOURCE_EXHAUSTED in agent text', error: '', exitCode: 1 };
    assert.equal(isRateLimited(worker, inOutput).hit, false,
      'gemini rate-limit check must not scan agent output');
    // pattern in error → must match
    const inError = { success: false, output: '', error: 'RESOURCE_EXHAUSTED', exitCode: 1 };
    assert.equal(isRateLimited(worker, inError).hit, true);
  });

  it('for unknown/custom workers: scans both output and error', () => {
    const worker = makeWorker({ name: 'custom', rate_limit_patterns: ['rate limit'] });
    const result = { success: false, output: 'rate limit hit', error: '', exitCode: 1 };
    assert.equal(isRateLimited(worker, result).hit, true);
  });

  it('snippet is a window around the match', () => {
    const worker = makeWorker({ rate_limit_patterns: ['429'] });
    const longOutput = 'x'.repeat(200) + ' got 429 error from api ' + 'y'.repeat(200);
    const result = { success: false, output: longOutput, error: '', exitCode: 1 };
    const rl = isRateLimited(worker, result);
    assert.equal(rl.hit, true);
    assert.equal(rl.pattern, '429');
    assert.ok(rl.snippet!.length < 150, `snippet should be ~120 chars, got ${rl.snippet!.length}`);
    assert.ok(rl.snippet!.includes('429'));
  });
});

describe('runWithFailover', () => {
  it('uses first available worker on success', async () => {
    const script = await writeScript('ok.js', 'process.stdout.write("from w1");');
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [script], check: 'echo ok', priority: 1 },
    ]);
    const { result, worker } = await runWithFailover('unused', { timeout: 10 });
    assert.equal(result.success, true);
    assert.equal(worker, 'w1');
    assert.ok(result.output.includes('from w1'));
  });

  it('skips unavailable workers', async () => {
    const script = await writeScript('fallback.js', 'process.stdout.write("fallback ok");');
    await createTempConfig(tempDir, [
      { name: 'bad', command: 'echo', args: ['x'], check: 'nonexistent_cmd_xyz', priority: 1 },
      { name: 'good', command: 'node', args: [script], check: 'echo ok', priority: 2 },
    ]);
    const { result, worker } = await runWithFailover('unused', { timeout: 10 });
    assert.equal(result.success, true);
    assert.equal(worker, 'good');
  });

  it('falls over on rate limit to next worker', async () => {
    const limitScript = await writeScript('limited.js', 'process.stderr.write("rate limit exceeded"); process.exit(1);');
    const backupScript = await writeScript('backup.js', 'process.stdout.write("backup ok");');
    await createTempConfig(tempDir, [
      {
        name: 'limited',
        command: 'node',
        args: [limitScript],
        check: 'echo ok',
        priority: 1,
        rate_limit_patterns: ['rate limit'],
      },
      {
        name: 'backup',
        command: 'node',
        args: [backupScript],
        check: 'echo ok',
        priority: 2,
      },
    ]);
    const { result, worker } = await runWithFailover('unused', { timeout: 10 });
    assert.equal(result.success, true);
    assert.equal(worker, 'backup');
  });

  it('stops on real error without trying next when noFallback is true', async () => {
    const brokenScript = await writeScript('broken.js', 'process.stderr.write("syntax error"); process.exit(1);');
    const backupScript = await writeScript('backup2.js', 'process.stdout.write("should not reach");');
    await createTempConfig(tempDir, [
      {
        name: 'broken',
        command: 'node',
        args: [brokenScript],
        check: 'echo ok',
        priority: 1,
        rate_limit_patterns: ['rate limit'],
      },
      {
        name: 'backup',
        command: 'node',
        args: [backupScript],
        check: 'echo ok',
        priority: 2,
      },
    ]);
    const { result, worker } = await runWithFailover('unused', { timeout: 10, noFallback: true });
    assert.equal(result.success, false);
    assert.equal(worker, 'broken');
  });

  it('continues to next worker on plain failure by default', async () => {
    const brokenScript = await writeScript('broken-default.js', 'process.stderr.write("syntax error"); process.exit(1);');
    const backupScript = await writeScript('backup-default.js', 'process.stdout.write("backup ok");');
    await createTempConfig(tempDir, [
      {
        name: 'broken',
        command: 'node',
        args: [brokenScript],
        check: 'echo ok',
        priority: 1,
        rate_limit_patterns: ['rate limit'],
      },
      {
        name: 'backup',
        command: 'node',
        args: [backupScript],
        check: 'echo ok',
        priority: 2,
      },
    ]);
    const { result, worker } = await runWithFailover('unused', { timeout: 10 });
    assert.equal(result.success, true);
    assert.equal(worker, 'backup');
  });

  it('returns failure when all workers exhausted', async () => {
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'echo', args: ['x'], check: 'nonexistent_cmd_xyz', priority: 1 },
    ]);
    const { result, worker } = await runWithFailover('unused', { timeout: 10 });
    assert.equal(result.success, false);
    assert.equal(worker, 'none');
    assert.ok(result.error?.includes('No workers available'));
  });

  it('skips excluded workers', async () => {
    const script1 = await writeScript('excluded.js', 'process.stdout.write("should not run");');
    const script2 = await writeScript('included.js', 'process.stdout.write("included ok");');
    await createTempConfig(tempDir, [
      { name: 'excluded_w', command: 'node', args: [script1], check: 'echo ok', priority: 1 },
      { name: 'included_w', command: 'node', args: [script2], check: 'echo ok', priority: 2 },
    ]);
    const { result, worker } = await runWithFailover('unused', {
      timeout: 10,
      excludeWorkers: new Set(['excluded_w']),
    });
    assert.equal(result.success, true);
    assert.equal(worker, 'included_w');
    assert.ok(result.output.includes('included ok'));
  });

  it('exhaustion: emits notify when all workers fail', async () => {
    const brokenScript = await writeScript('exhaust-broken.js', 'process.stderr.write("fail"); process.exit(1);');
    const brokenScript2 = await writeScript('exhaust-broken2.js', 'process.stderr.write("fail2"); process.exit(1);');
    await createTempSecrets(tempDir, '');
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [brokenScript], check: 'echo ok', priority: 1, rate_limit_patterns: [] },
      { name: 'w2', command: 'node', args: [brokenScript2], check: 'echo ok', priority: 2, rate_limit_patterns: [] },
    ]);
    const { result, worker } = await runWithFailover('unused', { timeout: 10, resource: 'skill-test-exhaustion' });
    assert.equal(result.success, false);
    assert.equal(result.alreadyAlertedPaSupport, true);
  });

  it('noFallback: true does not emit exhaustion notify', async () => {
    const brokenScript = await writeScript('nofb-broken.js', 'process.stderr.write("fail"); process.exit(1);');
    await createTempSecrets(tempDir, '');
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [brokenScript], check: 'echo ok', priority: 1, rate_limit_patterns: [] },
    ]);
    const { result } = await runWithFailover('unused', { timeout: 10, noFallback: true, resource: 'skill-test-nofb' });
    assert.equal(result.success, false);
    assert.equal(result.alreadyAlertedPaSupport, undefined);
  });

  it('priorAttempts propagates into exhaustion tracking', async () => {
    const brokenScript = await writeScript('prior-broken.js', 'process.stderr.write("fail"); process.exit(1);');
    await createTempSecrets(tempDir, '');
    await createTempConfig(tempDir, [
      { name: 'w2', command: 'node', args: [brokenScript], check: 'echo ok', priority: 1, rate_limit_patterns: [] },
    ]);
    const { result } = await runWithFailover('unused', {
      timeout: 10,
      resource: 'skill-test-prior',
      priorAttempts: ['w1'],
      excludeWorkers: new Set(['w1']),
    });
    assert.equal(result.success, false);
    assert.equal(result.alreadyAlertedPaSupport, true);
  });

  it('rate-limit-wall: emits notify when all candidates are cooling', async () => {
    await createTempSecrets(tempDir, '');
    await createTempConfig(tempDir, [
      { name: 'cooling_w', command: 'echo', args: ['x'], check: 'echo ok', priority: 1, rate_limit_patterns: [] },
    ]);
    // Manually write a cooldown state
    const { join: pathJoin } = await import('path');
    const rateLimitFile = pathJoin(tempDir, 'rate-limit-state.json');
    const { writeFile: wf } = await import('fs/promises');
    await wf(rateLimitFile, JSON.stringify({
      cooling_w: { cooldown_until: new Date(Date.now() + 60000).toISOString(), last_event: new Date().toISOString(), reason: 'test' },
    }), 'utf8');
    const { result } = await runWithFailover('unused', {
      timeout: 10,
      resource: 'skill-test-wall',
    });
    assert.equal(result.success, false);
    assert.equal(result.alreadyAlertedPaSupport, true);
  });

  it('empty pool: no alert, just a warning log', async () => {
    await createTempSecrets(tempDir, '');
    await createTempConfig(tempDir, [
      { name: 'only_w', command: 'echo', args: ['x'], check: 'echo ok', priority: 1, rate_limit_patterns: [] },
    ]);
    const { result } = await runWithFailover('unused', {
      timeout: 10,
      resource: 'skill-test-empty',
      excludeWorkers: new Set(['only_w']),
    });
    assert.equal(result.success, false);
    // No exhaustion alert because no workers were attempted and none are cooling
    assert.equal(result.alreadyAlertedPaSupport, undefined);
  });
});

describe('readStateTail', () => {
  it('returns content of a state file', async () => {
    const stateDir = join(tempDir, 'state-read');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'session.json'), 'hello state content', 'utf8');
    const content = await readStateTail(stateDir, '*.json');
    assert.equal(content, 'hello state content');
  });

  it('returns last 32KB when file is larger', async () => {
    const stateDir = join(tempDir, 'state-large');
    await mkdir(stateDir, { recursive: true });
    // Write 64KB + a marker at the end
    const chunk = 'x'.repeat(32768);
    await writeFile(join(stateDir, 'session.json'), chunk + chunk + 'END_MARKER', 'utf8');
    const content = await readStateTail(stateDir, '*.json');
    assert.ok(content?.endsWith('END_MARKER'));
    // Should NOT include the first chunk
    assert.ok((content?.length ?? 0) <= 32768 + 'END_MARKER'.length);
  });

  it('returns null when directory has no matching files', async () => {
    const stateDir = join(tempDir, 'state-empty');
    await mkdir(stateDir, { recursive: true });
    const content = await readStateTail(stateDir, '*.json');
    assert.equal(content, null);
  });

  it('returns null when directory does not exist', async () => {
    const content = await readStateTail(join(tempDir, 'nonexistent'), '*.json');
    assert.equal(content, null);
  });
});

describe('LLM evaluator', () => {
  it('kills worker and returns summary when evaluator says kill', async () => {
    const stateDir = join(tempDir, 'state-eval-kill');
    await mkdir(stateDir, { recursive: true });
    // A state file with alive-looking content (so heuristic says "alive" or "unknown")
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({
      messages: [{ type: 'gemini', content: 'thinking...' }]
    }), 'utf8');

    // Evaluator script: outputs a kill verdict
    const evalScript = await writeScript('evaluator-kill.js',
      'process.stdout.write(JSON.stringify({verdict:"kill",summary:"The agent was looping on completion messages.",reason:"semantic loop detected"}));'
    );

    // Hanging worker script
    const workerScript = await writeScript('hang-eval.js', 'setTimeout(()=>{}, 60000);');

    await createTempConfig(tempDir, [
      { name: 'worker-under-test', command: 'node', args: [workerScript], check: 'echo ok', priority: 1 },
      { name: 'evaluator', command: 'node', args: [evalScript], check: 'echo ok', priority: 2 },
    ], { evaluator: { worker: 'evaluator', timeout: 10 } });

    const worker = makeWorker({
      name: 'worker-under-test',
      command: 'node',
      args: [workerScript],
      state_dir: stateDir,
      state_pattern: 'session.json',
    });

    const result = await executeWorker(worker, 'unused', { timeout: 15, idleTimeout: 2 });
    assert.equal(result.success, false);
    assert.ok(result.evaluatorSummary?.includes('looping on completion'), `Expected evaluator summary, got: ${result.evaluatorSummary}`);
    assert.ok(result.error?.includes('LLM evaluator'), `Expected evaluator reason in error, got: ${result.error}`);
  });

  it('extends timeout when evaluator says extend', async () => {
    const stateDir = join(tempDir, 'state-eval-extend');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({
      messages: [{ type: 'gemini', content: 'still working' }]
    }), 'utf8');

    // Evaluator script: outputs an extend verdict
    const evalScript = await writeScript('evaluator-extend.js',
      'process.stdout.write(JSON.stringify({verdict:"extend",summary:"The agent is processing tool results.",reason:"active tool chain"}));'
    );

    const workerScript = await writeScript('hang-eval-extend.js', 'setTimeout(()=>{}, 60000);');

    await createTempConfig(tempDir, [
      { name: 'worker-under-test', command: 'node', args: [workerScript], check: 'echo ok', priority: 1 },
      { name: 'evaluator', command: 'node', args: [evalScript], check: 'echo ok', priority: 2 },
    ], { evaluator: { worker: 'evaluator', timeout: 10 } });

    const worker = makeWorker({
      name: 'worker-under-test',
      command: 'node',
      args: [workerScript],
      state_dir: stateDir,
      state_pattern: 'session.json',
    });

    const start = Date.now();
    const result = await executeWorker(worker, 'unused', { timeout: 8, idleTimeout: 2 });
    const elapsed = Date.now() - start;

    // Should hit MAX timeout (not idle timeout) because evaluator kept extending.
    // With maxExtensions=2 cap, the kill message now says "absolute timeout exceeded after N extensions".
    assert.equal(result.success, false);
    const isMaxTimeout = result.error?.includes('exceeded max timeout') || result.error?.includes('absolute timeout exceeded');
    assert.ok(isMaxTimeout, `Expected max timeout error, got: ${result.error}`);
    assert.ok(elapsed >= 7000, `Should have lasted at least 7s, took ${elapsed}ms`);
  });

  it('skips LLM evaluation when isEvaluator is true', async () => {
    const stateDir = join(tempDir, 'state-eval-skip');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({
      messages: [{ type: 'gemini', content: 'thinking...' }]
    }), 'utf8');

    // Evaluator script that would output kill if called (but shouldn't be called)
    const evalScript = await writeScript('evaluator-noop.js',
      'process.stdout.write(JSON.stringify({verdict:"kill",summary:"Should not be called.",reason:"recursion"}));'
    );

    const workerScript = await writeScript('hang-eval-skip.js', 'setTimeout(()=>{}, 60000);');

    await createTempConfig(tempDir, [
      { name: 'worker-under-test', command: 'node', args: [workerScript], check: 'echo ok', priority: 1 },
      { name: 'evaluator', command: 'node', args: [evalScript], check: 'echo ok', priority: 2 },
    ], { evaluator: { worker: 'evaluator', timeout: 10 } });

    const worker = makeWorker({
      name: 'worker-under-test',
      command: 'node',
      args: [workerScript],
      state_dir: stateDir,
      state_pattern: 'session.json',
    });

    // With isEvaluator: true, the LLM evaluator path is skipped
    // The state heuristic says "alive" (recent content), so it should keep extending
    // until the max timeout
    const start = Date.now();
    const result = await executeWorker(worker, 'unused', { timeout: 6, idleTimeout: 2, isEvaluator: true });
    const elapsed = Date.now() - start;

    assert.equal(result.success, false);
    // Should hit max timeout, NOT kill with evaluator summary
    assert.ok(!result.output.includes('Should not be called'), `Evaluator should not have been called, got output: ${result.output}`);
    assert.ok(result.error?.includes('exceeded max timeout'), `Expected max timeout, got: ${result.error}`);
    assert.ok(elapsed >= 5000, `Should have lasted at least 5s, took ${elapsed}ms`);
  });

  it('falls back to kill when evaluator returns unparseable output', async () => {
    const stateDir = join(tempDir, 'state-eval-bad');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({
      messages: [{ type: 'gemini', content: 'thinking...' }]
    }), 'utf8');

    // Evaluator that outputs garbage
    const evalScript = await writeScript('evaluator-bad.js',
      'process.stdout.write("not valid json at all");'
    );

    const workerScript = await writeScript('hang-eval-bad.js', 'setTimeout(()=>{}, 60000);');

    await createTempConfig(tempDir, [
      { name: 'worker-under-test', command: 'node', args: [workerScript], check: 'echo ok', priority: 1 },
      { name: 'evaluator', command: 'node', args: [evalScript], check: 'echo ok', priority: 2 },
    ], { evaluator: { worker: 'evaluator', timeout: 10 } });

    const worker = makeWorker({
      name: 'worker-under-test',
      command: 'node',
      args: [workerScript],
      state_dir: stateDir,
      state_pattern: 'session.json',
    });

    // Evaluator fails → falls back to heuristic "alive" → keeps extending → hits max timeout
    const result = await executeWorker(worker, 'unused', { timeout: 8, idleTimeout: 2 });
    assert.equal(result.success, false);
    // Should NOT have the evaluator summary (evaluator failed)
    assert.ok(!result.output.includes('Should not be called'));
  });
});
