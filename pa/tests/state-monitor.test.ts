import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, createTempConfig, cleanup } from './helpers.js';
import { flushLog } from '../src/lib/log.js';
import {
  isBinaryStateContent,
  readUsableStateTail,
  readStateTail,
  analyzeAgentState,
} from '../src/state-monitor.js';
import type { WorkerConfig, CommandResult, RunOptions } from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
//
// agy (Antigravity CLI) stores each conversation as a WAL-mode SQLite database
// whose payload columns hold protobuf blobs. pa's state analysis is
// line-oriented JSON, so reading one of these yields NUL bytes and U+FFFD
// replacement characters — which used to flow straight into the LLM
// evaluator's prompt.
// ---------------------------------------------------------------------------

/** A small SQLite-shaped file: magic header survives a whole-file read. */
function sqliteHeaderFile(): Buffer {
  const header = Buffer.from('SQLite format 3\0', 'binary');
  const page = Buffer.alloc(4096); // SQLite pages are mostly NUL
  page.write('\x08\x0f \x03*\xc0\x02', 100, 'binary');
  page.write('sessionID', 200, 'utf8');
  return Buffer.concat([header, page, page]);
}

/** A >32KB SQLite-shaped file: the 32KB TAIL contains no magic, only pages. */
function largeSqliteFile(): Buffer {
  const parts = [Buffer.from('SQLite format 3\0', 'binary')];
  for (let i = 0; i < 16; i++) {
    const page = Buffer.alloc(4096);
    page.write(`trajectory-${i}`, 64, 'utf8');
    page[10] = 0x0f;
    page[11] = 0xc0;
    parts.push(page);
  }
  return Buffer.concat(parts);
}

/** Non-utf8 bytes with no NULs at all — exercises the U+FFFD ratio branch. */
function invalidUtf8File(): Buffer {
  // Bare continuation bytes: every one decodes to U+FFFD.
  return Buffer.from(new Array(2048).fill(0x9f));
}

const PENDING_TOOL_JSONL =
  '{"type":"user","content":"run the tests"}\n' +
  '{"type":"assistant","content":"I will run them"}\n' +
  '{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}\n';

const QUESTION_JSONL =
  '{"type":"user","content":"deploy it"}\n' +
  '{"type":"assistant","content":"Which environment should I deploy to?"}\n';

const GEMINI_SESSION_JSON = JSON.stringify({
  sessionId: 'abc',
  messages: [
    { type: 'user', content: 'summarise the repo' },
    { type: 'gemini', content: 'Here is the summary of the repo.' },
  ],
});

describe('isBinaryStateContent', () => {
  it('flags a whole-file SQLite read by its magic header', () => {
    assert.equal(isBinaryStateContent(sqliteHeaderFile().toString('utf8')), true);
  });

  it('flags a mid-file SQLite tail with no magic header, via NUL bytes', () => {
    const tail = largeSqliteFile().subarray(-32768).toString('utf8');
    assert.ok(!tail.startsWith('SQLite format 3'), 'fixture must not expose the magic header');
    assert.equal(isBinaryStateContent(tail), true);
  });

  it('flags non-utf8 bytes even when no NUL is present', () => {
    const decoded = invalidUtf8File().toString('utf8');
    assert.ok(!decoded.includes('\u0000'), 'fixture must exercise the ratio branch, not the NUL branch');
    assert.equal(isBinaryStateContent(decoded), true);
  });

  it('does NOT flag JSONL transcripts', () => {
    assert.equal(isBinaryStateContent(PENDING_TOOL_JSONL), false);
    assert.equal(isBinaryStateContent(GEMINI_SESSION_JSON), false);
  });

  it('does NOT flag legitimate unicode (emoji, smart quotes, CJK)', () => {
    const text = '{"type":"assistant","content":"Done ✅ — “shipped” こんにちは 🚀"}\n';
    assert.equal(isBinaryStateContent(text), false);
  });

  it('does NOT flag a truncated JSON tail (gemini single-session format)', () => {
    // Tail reads slice mid-token; that is expected and must stay usable.
    const truncated = GEMINI_SESSION_JSON.slice(20);
    assert.equal(isBinaryStateContent(truncated), false);
  });

  it('treats empty content as non-binary', () => {
    assert.equal(isBinaryStateContent(''), false);
  });
});

describe('state-monitor binary state files', () => {
  let dir: string;
  let n = 0;

  before(async () => {
    dir = await createTempPaHome();
  });

  after(async () => {
    await cleanup(dir);
  });

  /** Each case gets its own dir+file so the once-per-file log memo can't hide a miss. */
  async function stateDirWith(name: string, contents: Buffer | string): Promise<string> {
    const stateDir = join(dir, `state-${name}-${n++}`);
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, `${name}.db`), contents);
    return stateDir;
  }

  it('readUsableStateTail reports a binary file instead of returning its bytes', async () => {
    const stateDir = await stateDirWith('sqlite', sqliteHeaderFile());
    const tail = await readUsableStateTail(stateDir, '*.db', 'agy');
    assert.equal(tail.content, null, 'binary bytes must not be handed back');
    assert.equal(tail.problem, 'binary');
    assert.ok(tail.path?.endsWith('.db'));
  });

  it('readUsableStateTail reports a >32KB binary file too', async () => {
    const stateDir = await stateDirWith('sqlite-large', largeSqliteFile());
    const tail = await readUsableStateTail(stateDir, '*.db', 'agy');
    assert.equal(tail.content, null);
    assert.equal(tail.problem, 'binary');
  });

  it('readUsableStateTail does not throw and reports no problem when the dir is missing', async () => {
    const tail = await readUsableStateTail(join(dir, 'nope-does-not-exist'), '*.db', 'agy');
    assert.equal(tail.content, null);
    assert.equal(tail.problem, undefined, 'a missing state dir is not a binary-file problem');
  });

  it('analyzeAgentState skips a binary state file cleanly, without throwing', async () => {
    const stateDir = await stateDirWith('analyze', sqliteHeaderFile());
    await assert.doesNotReject(() => analyzeAgentState(stateDir, '*.db', 'agy'));

    const state = await analyzeAgentState(stateDir, '*.db', 'agy');
    assert.equal(state.verdict, 'unknown');
    assert.equal(state.degraded, 'binary', 'the blind spot must be machine-readable, not inferred');
    assert.ok(
      /binary|not readable text/i.test(state.status),
      `status must say why detection is unavailable, got: ${state.status}`,
    );
    assert.ok(state.status.includes('agy'), 'status must name the worker it is degraded for');
    assert.equal(state.lastEntry, undefined, 'no binary fragment may be carried out in lastEntry');
  });

  it('emits one structured warn line naming the worker, and does not repeat it', async () => {
    const stateDir = await stateDirWith('logged', sqliteHeaderFile());
    await analyzeAgentState(stateDir, '*.db', 'agy');
    await analyzeAgentState(stateDir, '*.db', 'agy');
    await readUsableStateTail(stateDir, '*.db', 'agy');
    await flushLog();

    const raw = await readFile(join(dir, 'app.log.jsonl'), 'utf8');
    const entries = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const hits = entries.filter(
      (e) => e.module === 'state-monitor' && e.problem === 'binary' && String(e.path).includes('logged'),
    );
    assert.equal(hits.length, 1, `expected exactly one log line for this file, got ${hits.length}`);
    assert.equal(hits[0].level, 'warn');
    assert.equal(hits[0].worker, 'agy');
    assert.ok(String(hits[0].message).includes('agy'), 'message must be greppable by worker name');
    assert.equal(hits[0].pattern, '*.db');
    assert.ok(String(hits[0].detail).length > 0, 'a reason must be recorded');
  });

  it('readStateTail itself is unchanged — it still returns raw bytes', async () => {
    // Deliberate: readStateTail is the raw accessor. The gate lives in
    // readUsableStateTail so existing non-LLM callers keep their contract.
    const stateDir = await stateDirWith('raw', sqliteHeaderFile());
    const content = await readStateTail(stateDir, '*.db');
    assert.ok(content !== null && content.length > 0);
  });
});

describe('analyzeAgentState regression on text state files', () => {
  let dir: string;

  before(async () => {
    dir = await createTempPaHome();
  });

  after(async () => {
    await cleanup(dir);
  });

  async function jsonlDir(name: string, contents: string, ext = 'jsonl'): Promise<string> {
    const stateDir = join(dir, `text-${name}`);
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, `session.${ext}`), contents, 'utf8');
    return stateDir;
  }

  it('still detects a pending tool call as alive', async () => {
    const stateDir = await jsonlDir('pending', PENDING_TOOL_JSONL);
    const state = await analyzeAgentState(stateDir, '*.jsonl', 'claude');
    assert.equal(state.verdict, 'alive');
    assert.equal(state.status, 'waiting for tool: Bash');
    assert.equal(state.degraded, undefined);
  });

  it('still detects an unanswerable question as stuck', async () => {
    const stateDir = await jsonlDir('question', QUESTION_JSONL);
    const state = await analyzeAgentState(stateDir, '*.jsonl', 'claude');
    assert.equal(state.verdict, 'stuck');
    assert.ok(state.status.includes('asking a question'));
    assert.equal(state.degraded, undefined);
  });

  it('still parses the gemini single-JSON session format', async () => {
    const stateDir = await jsonlDir('gemini', GEMINI_SESSION_JSON, 'json');
    const state = await analyzeAgentState(stateDir, '*.json', 'gemini');
    assert.equal(state.verdict, 'alive');
    assert.equal(state.status, 'thinking/responding');
    assert.equal(state.degraded, undefined);
  });

  it('still reports a missing state file as unknown WITHOUT marking it degraded', async () => {
    const state = await analyzeAgentState(join(dir, 'absent'), '*.jsonl', 'claude');
    assert.equal(state.verdict, 'unknown');
    assert.equal(state.status, 'no state file found');
    assert.equal(state.degraded, undefined, 'absent != unreadable — a human must be able to tell them apart');
  });

  it('still reports plain non-JSON text as unknown but usable (not degraded)', async () => {
    const stateDir = await jsonlDir('plain', 'just some log text, not JSON at all\n');
    const state = await analyzeAgentState(stateDir, '*.jsonl', 'codex');
    assert.equal(state.verdict, 'unknown');
    assert.equal(state.status, 'no parseable entries');
    assert.equal(state.degraded, undefined);
  });

  it('defaults workerName so two-argument callers keep working', async () => {
    const stateDir = await jsonlDir('twoarg', PENDING_TOOL_JSONL);
    const state = await analyzeAgentState(stateDir, '*.jsonl');
    assert.equal(state.verdict, 'alive');
  });
});

describe('evaluateWorkerState never receives binary state', () => {
  const WORKER: WorkerConfig = {
    name: 'claude',
    command: 'echo',
    args: ['ok'],
    check: 'echo ok',
    priority: 1,
    rate_limit_patterns: [],
  };

  let dir: string;
  let prompts: string[];

  const recordingExecutor = async (
    _worker: WorkerConfig,
    prompt: string,
    _opts: RunOptions,
  ): Promise<CommandResult> => {
    prompts.push(prompt);
    return { success: true, output: '{"verdict":"kill","summary":"s","reason":"r"}', exitCode: 0 };
  };

  before(async () => {
    dir = await createTempPaHome();
    await createTempConfig(dir, [WORKER], { evaluator: { worker: 'claude', timeout: 30 } });
  });

  beforeEach(() => {
    prompts = [];
  });

  after(async () => {
    await cleanup(dir);
  });

  it('returns null and never invokes the evaluator when the state file is binary', async () => {
    const { evaluateWorkerState } = await import('../src/worker-evaluator.js');
    const stateDir = join(dir, 'eval-binary');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'conversation.db'), sqliteHeaderFile());

    const result = await evaluateWorkerState(stateDir, '*.db', 'agy', {}, recordingExecutor);
    assert.equal(result, null, 'no usable state means no verdict');
    assert.equal(prompts.length, 0, 'the evaluator must not be spawned at all for a binary state file');
  });

  it('does not leak binary bytes into any prompt for a >32KB SQLite store', async () => {
    const { evaluateWorkerState } = await import('../src/worker-evaluator.js');
    const stateDir = join(dir, 'eval-binary-large');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'conversation.db'), largeSqliteFile());

    await evaluateWorkerState(stateDir, '*.db', 'agy', {}, recordingExecutor);
    const joined = prompts.join('');
    assert.ok(!joined.includes('\u0000'), 'no NUL byte may appear in an evaluator prompt');
    assert.ok(!joined.includes('�'), 'no replacement character may appear in an evaluator prompt');
    assert.ok(!joined.includes('trajectory-3'), 'no fragment of the binary store may appear in a prompt');
  });

  it('still sends a valid JSONL state tail to the evaluator', async () => {
    const { evaluateWorkerState } = await import('../src/worker-evaluator.js');
    const stateDir = join(dir, 'eval-text');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'session.jsonl'), PENDING_TOOL_JSONL, 'utf8');

    const result = await evaluateWorkerState(stateDir, '*.jsonl', 'gemini', {}, recordingExecutor);
    assert.equal(result?.verdict, 'kill');
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes('run the tests'), 'the text tail must still reach the prompt');
  });
});
