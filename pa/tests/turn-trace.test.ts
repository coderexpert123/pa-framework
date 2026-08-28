import './test-env-guard.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { resetRedactCache } from '../src/lib/redact.js';
import {
  TRACE_CAPS,
  TraceCollector,
  appendTurnTrace,
  classifyOrigin,
  classifyOutcome,
  parseBotResource,
  skillFromResource,
  turnTracesPath,
  type TurnTraceV1,
} from '../src/lib/turn-trace.js';

describe('classifyOrigin', () => {
  it('topic- prefix -> bot', () => {
    assert.equal(classifyOrigin('topic--1001234567890_12345'), 'bot');
  });
  it('skill- prefix -> skill', () => {
    assert.equal(classifyOrigin('skill-oracle'), 'skill');
  });
  it('self-improver prefix -> self-improver', () => {
    assert.equal(classifyOrigin('self-improver-code-fix-x'), 'self-improver');
  });
  it('undefined -> other', () => {
    assert.equal(classifyOrigin(undefined), 'other');
  });
  it('unrecognized string -> other', () => {
    assert.equal(classifyOrigin('whatever'), 'other');
  });
});

describe('parseBotResource', () => {
  it('parses a topic resource with a negative chatId', () => {
    assert.deepEqual(parseBotResource('topic--1001234567890_12345'), { chatId: -1001234567890, threadId: 12345 });
  });
  it('parses a topic resource with a positive chatId', () => {
    assert.deepEqual(parseBotResource('topic-555_0'), { chatId: 555, threadId: 0 });
  });
  it('returns undefined for a non-topic resource', () => {
    assert.equal(parseBotResource('skill-oracle'), undefined);
  });
  it('returns undefined for undefined', () => {
    assert.equal(parseBotResource(undefined), undefined);
  });
});

describe('skillFromResource', () => {
  it('extracts the skill name', () => {
    assert.equal(skillFromResource('skill-oracle'), 'oracle');
  });
  it('extracts a hyphenated skill name (greedy group)', () => {
    assert.equal(skillFromResource('skill-daily-mail-brief'), 'daily-mail-brief');
  });
  it('returns undefined for a non-skill resource', () => {
    assert.equal(skillFromResource('topic-1_2'), undefined);
  });
  it('returns undefined for undefined', () => {
    assert.equal(skillFromResource(undefined), undefined);
  });
});

describe('classifyOutcome', () => {
  it('exit 0 -> ok', () => {
    assert.equal(classifyOutcome({ exitCode: 0, cancelled: false, suppressExitAlert: false }), 'ok');
  });
  it('exit 0 wins over cancelled (precedence)', () => {
    assert.equal(classifyOutcome({ exitCode: 0, cancelled: true, suppressExitAlert: false }), 'ok');
  });
  it('cancelled -> killed', () => {
    assert.equal(classifyOutcome({ exitCode: 1, cancelled: true, suppressExitAlert: false }), 'killed');
  });
  it('cancelled wins over a timeout-shaped error (precedence)', () => {
    assert.equal(
      classifyOutcome({ exitCode: 1, cancelled: true, suppressExitAlert: false, error: 'Killed: exceeded max timeout of 3600s' }),
      'killed',
    );
  });
  it('timeout-shaped error -> timeout', () => {
    assert.equal(
      classifyOutcome({ exitCode: 1, cancelled: false, suppressExitAlert: false, error: 'Killed: no activity for 300s (idle timeout)' }),
      'timeout',
    );
  });
  it('absolute-timeout-shaped error -> timeout', () => {
    assert.equal(
      classifyOutcome({ exitCode: 1, cancelled: false, suppressExitAlert: false, error: 'Killed: absolute timeout exceeded after 2 extensions' }),
      'timeout',
    );
  });
  it('suppressExitAlert -> failover', () => {
    assert.equal(classifyOutcome({ exitCode: 1, cancelled: false, suppressExitAlert: true }), 'failover');
  });
  it('timeout wins over suppressExitAlert (precedence)', () => {
    assert.equal(
      classifyOutcome({ exitCode: 1, cancelled: false, suppressExitAlert: true, error: 'Killed: no activity for 300s (idle timeout)' }),
      'timeout',
    );
  });
  it('otherwise -> error', () => {
    assert.equal(classifyOutcome({ exitCode: 1, cancelled: false, suppressExitAlert: false, error: 'boom' }), 'error');
  });
  it('null exit code, nothing else set -> error', () => {
    assert.equal(classifyOutcome({ exitCode: null, cancelled: false, suppressExitAlert: false }), 'error');
  });
});

describe('TraceCollector — agy dialect', () => {
  it('a tool ACTIVE->DONE pair produces one tool_call with ms, and populates files', () => {
    const collector = new TraceCollector({ isAgyDialect: true });
    const path = 'C:\\Temp\\pa-prompt-1fe4.txt';
    collector.observe({
      event: 'step_update',
      step_update: {
        conversation_id: '8c25e432-x', step_index: 3, state: 'ACTIVE',
        step_type: 'tool', tool_name: 'view_file',
        tool_info: { name: 'view_file', parameters: { AbsolutePath: path } },
      },
    });
    collector.observe({
      event: 'step_update',
      step_update: {
        conversation_id: '8c25e432-x', step_index: 3, state: 'DONE',
        step_type: 'tool', tool_name: 'view_file', duration_seconds: 0.1700997,
        tool_info: { name: 'view_file', parameters: { AbsolutePath: path }, output: '119 lines, 6646 bytes' },
      },
    });

    assert.equal(collector.parsed, true);
    const h = collector.harvest();
    assert.equal(h.tool_calls.length, 1);
    assert.deepEqual(h.tool_calls[0], { n: 1, name: 'view_file', arg: path, ok: true, ms: 170 });
    assert.deepEqual(h.files, [path]);
  });

  it('an ERROR grep_search step marks the call not-ok and records the error message', () => {
    const collector = new TraceCollector({ isAgyDialect: true });
    collector.observe({
      event: 'step_update',
      step_update: {
        step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'grep_search',
        tool_info: { name: 'grep_search', parameters: { Query: 'foo', SearchPath: 'D:/repo' } },
      },
    });
    collector.observe({
      event: 'step_update',
      step_update: {
        step_index: 1, state: 'ERROR', step_type: 'tool', tool_name: 'grep_search',
        tool_info: {
          name: 'grep_search', parameters: { Query: 'foo', SearchPath: 'D:/repo' },
          error: { type: 'TOOL_ERROR', message: 'exec: "grep": executable file not found in %PATH%' },
        },
      },
    });

    const h = collector.harvest();
    assert.equal(h.tool_calls.length, 1);
    assert.equal(h.tool_calls[0].ok, false);
    assert.deepEqual(h.errors, ['exec: "grep": executable file not found in %PATH%']);
  });

  it('run_command populates commands with CommandLine, and arg is the same string', () => {
    const collector = new TraceCollector({ isAgyDialect: true });
    collector.observe({
      event: 'step_update',
      step_update: {
        step_index: 5, state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 1.2,
        tool_info: { name: 'run_command', parameters: { CommandLine: 'npm run build' }, output: 'ok' },
      },
    });

    const h = collector.harvest();
    assert.deepEqual(h.commands, ['npm run build']);
    assert.equal(h.tool_calls[0].arg, 'npm run build');
  });

  it('init sets model; result sets tokens from usage', () => {
    const collector = new TraceCollector({ isAgyDialect: true });
    collector.observe({ event: 'init', conversation_id: 'x', init: { model: 'gemini-3.7-flash-high', cwd: 'D:/repo', tools: [] } });
    collector.observe({
      event: 'result',
      result: { conversation_id: 'x', status: 'SUCCESS', response: 'ok', usage: { input_tokens: 100, output_tokens: 20 } },
    });

    assert.equal(collector.model, 'gemini-3.7-flash-high');
    assert.deepEqual(collector.tokens, { in: 100, out: 20 });
    assert.equal(collector.parsed, true);
  });
});

describe('TraceCollector — claude-family dialect', () => {
  it('tool_use + tool_result(is_error:true) marks the call not-ok and captures the error text', () => {
    const collector = new TraceCollector({ isAgyDialect: false });
    collector.observe({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] },
    });
    collector.observe({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'command failed', is_error: true }] },
    });

    const h = collector.harvest();
    assert.equal(h.tool_calls.length, 1);
    assert.equal(h.tool_calls[0].ok, false);
    assert.deepEqual(h.commands, ['npm test']);
    assert.deepEqual(h.errors, ['command failed']);
    assert.equal(collector.parsed, true);
  });

  it('a Read tool_use populates files', () => {
    const collector = new TraceCollector({ isAgyDialect: false });
    collector.observe({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'D:/repo/src/index.ts' } }] },
    });

    const h = collector.harvest();
    assert.deepEqual(h.files, ['D:/repo/src/index.ts']);
  });
});

describe('TraceCollector — codex-shaped events match neither branch', () => {
  it('item.completed and thread.started leave parsed false and every slice empty (agy dialect)', () => {
    const collector = new TraceCollector({ isAgyDialect: true });
    collector.observe({ type: 'thread.started', thread_id: 'abc' });
    collector.observe({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } });

    assert.equal(collector.parsed, false);
    const h = collector.harvest();
    assert.deepEqual(h.tool_calls, []);
    assert.deepEqual(h.commands, []);
    assert.deepEqual(h.files, []);
    assert.deepEqual(h.errors, []);
    assert.equal(h.truncated, false);
  });

  it('item.completed and thread.started leave parsed false and every slice empty (claude dialect)', () => {
    const collector = new TraceCollector({ isAgyDialect: false });
    collector.observe({ type: 'thread.started', thread_id: 'abc' });
    collector.observe({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } });

    assert.equal(collector.parsed, false);
    const h = collector.harvest();
    assert.deepEqual(h.tool_calls, []);
    assert.deepEqual(h.commands, []);
    assert.deepEqual(h.files, []);
    assert.deepEqual(h.errors, []);
  });
});

describe('TraceCollector — caps', () => {
  it('250 tool_calls -> 200 kept, truncated === true', () => {
    const collector = new TraceCollector({ isAgyDialect: true });
    for (let i = 0; i < 250; i++) {
      collector.observe({
        event: 'step_update',
        step_update: {
          step_index: i, state: 'DONE', step_type: 'tool', tool_name: 'view_file', duration_seconds: 0.01,
          tool_info: { name: 'view_file', parameters: { AbsolutePath: `D:/f${i}.ts` } },
        },
      });
    }
    const h = collector.harvest();
    assert.equal(h.tool_calls.length, TRACE_CAPS.toolCalls);
    assert.equal(h.truncated, true);
  });

  it('a 5,000-char CommandLine truncates both the arg and the commands entry to 200 chars, truncated === true', () => {
    const collector = new TraceCollector({ isAgyDialect: true });
    const longCmd = 'x'.repeat(5000);
    collector.observe({
      event: 'step_update',
      step_update: {
        step_index: 0, state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 1,
        tool_info: { name: 'run_command', parameters: { CommandLine: longCmd } },
      },
    });
    const h = collector.harvest();
    assert.equal(h.tool_calls[0].arg.length, TRACE_CAPS.arg);
    assert.equal(h.commands[0].length, TRACE_CAPS.arg);
    assert.equal(h.truncated, true);
  });

  it('9 errors -> 5 kept', () => {
    const collector = new TraceCollector({ isAgyDialect: true });
    for (let i = 0; i < 9; i++) {
      collector.observe({
        event: 'step_update',
        step_update: {
          step_index: i, state: 'ERROR', step_type: 'tool', tool_name: 'run_command',
          tool_info: { name: 'run_command', parameters: { CommandLine: `cmd${i}` }, error: { message: `err${i}` } },
        },
      });
    }
    const h = collector.harvest();
    assert.equal(h.errors.length, TRACE_CAPS.errors);
    assert.equal(h.truncated, true);
  });
});

function baseTrace(overrides: Partial<TurnTraceV1> = {}): TurnTraceV1 {
  return {
    v: 1,
    run_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    ts_start: '2026-08-24T00:00:00.000Z',
    ts_end: '2026-08-24T00:00:01.000Z',
    duration_ms: 1000,
    origin: 'skill',
    worker: 'agy',
    exit_code: 0,
    outcome: 'ok',
    parsed: true,
    tool_calls: [],
    commands: [],
    files: [],
    errors: [],
    retries: 0,
    bytes_out: 0,
    truncated: false,
    ...overrides,
  };
}

describe('appendTurnTrace', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempPaHome();
    resetRedactCache(); // secrets.env from one test/file must not bleed into the next via the module cache
  });

  afterEach(async () => {
    await cleanup(tempDir);
    resetRedactCache();
  });

  it('writes exactly one JSON line that round-trips through JSON.parse', async () => {
    await appendTurnTrace(baseTrace());
    const content = await readFile(turnTracesPath(), 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.run_id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(parsed.v, 1);
  });

  it('redacts a secret value planted in secrets.env', async () => {
    await createTempSecrets(tempDir, 'MY_TOKEN=abcdefgh12345678\n');
    await appendTurnTrace(baseTrace({ commands: ['curl -H "Authorization: abcdefgh12345678"'] }));
    const content = await readFile(turnTracesPath(), 'utf8');
    assert.ok(content.includes('<redacted:'), `expected redaction marker, got: ${content}`);
    assert.ok(!content.includes('abcdefgh12345678'));
  });

  it('resolves (does not reject) when PA_HOME points at a path that cannot be created', async () => {
    const filePath = join(tempDir, 'not-a-directory.txt');
    await writeFile(filePath, 'x', 'utf8');
    process.env.PA_HOME = filePath; // a FILE, not a directory — mkdir(dirname(...)) will fail underneath it
    await assert.doesNotReject(() => appendTurnTrace(baseTrace()));
  });
});
