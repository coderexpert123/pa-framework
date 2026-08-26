import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { resetRedactCache } from '../src/lib/redact.js';
import {
  parseRecallArgs,
  buildSourcesConfig,
  runRecallEngine,
  recallCommand,
} from '../src/commands/recall.js';
import { recallIndexJob } from '../src/lib/maintenance/jobs/recall-index.js';

let dir: string;
let savedKbPath: string | undefined;

beforeEach(async () => {
  dir = await createTempPaHome();
  savedKbPath = process.env.PA_KB_SOURCES_PATH;
  delete process.env.PA_KB_SOURCES_PATH;
  resetRedactCache();
});

afterEach(async () => {
  if (savedKbPath === undefined) delete process.env.PA_KB_SOURCES_PATH;
  else process.env.PA_KB_SOURCES_PATH = savedKbPath;
  resetRedactCache();
  await cleanup(dir);
});

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  return {
    logs,
    errors,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

describe('parseRecallArgs', () => {
  it('captures a positional query', () => {
    const opts = parseRecallArgs(['ekadashi']);
    assert.equal(opts.query, 'ekadashi');
  });

  it('joins multiple positional tokens with a space', () => {
    const opts = parseRecallArgs(['ekadashi', 'fasting', 'timing']);
    assert.equal(opts.query, 'ekadashi fasting timing');
  });

  it('parses every flag', () => {
    const opts = parseRecallArgs([
      'q',
      '--thread', '7822',
      '--source', 'trace',
      '--role', 'user',
      '--since', '2026-01-01',
      '--until', '2026-02-01',
      '--limit', '5',
      '--json',
      '--reindex',
      '--rebuild',
    ]);
    assert.deepEqual(opts, {
      query: 'q',
      thread: 7822,
      source: 'trace',
      role: 'user',
      since: '2026-01-01',
      until: '2026-02-01',
      limit: 5,
      json: true,
      reindex: true,
      rebuild: true,
    });
  });

  it('throws on a non-numeric --limit', () => {
    assert.throws(() => parseRecallArgs(['q', '--limit', 'abc']));
  });

  it('throws on a non-numeric --thread', () => {
    assert.throws(() => parseRecallArgs(['q', '--thread', 'abc']));
  });

  it('throws on an unrecognized flag', () => {
    assert.throws(() => parseRecallArgs(['q', '--bogus']));
  });

  it('throws on an invalid --role value', () => {
    assert.throws(() => parseRecallArgs(['q', '--role', 'system']));
  });

  it('accepts --json and --rebuild together with no query', () => {
    const opts = parseRecallArgs(['--json', '--rebuild']);
    assert.equal(opts.query, '');
    assert.equal(opts.json, true);
    assert.equal(opts.rebuild, true);
  });
});

describe('buildSourcesConfig', () => {
  it('kb is null when no PA_KB_SOURCES_PATH is set anywhere', async () => {
    const sources = await buildSourcesConfig(undefined);
    assert.equal(sources.kb, null);
  });

  it('kb.dir is the dirname of an explicit sources path', async () => {
    const sources = await buildSourcesConfig('D:/x/Ecosystem KB/Sources.md');
    assert.equal(normalize(sources.kb!.dir), normalize('D:/x/Ecosystem KB'));
  });

  it('kb.dir falls back to PA_KB_SOURCES_PATH when no arg is given', async () => {
    process.env.PA_KB_SOURCES_PATH = 'D:/y/Ecosystem KB/Sources.md';
    try {
      const sources = await buildSourcesConfig(undefined);
      assert.equal(normalize(sources.kb!.dir), normalize('D:/y/Ecosystem KB'));
    } finally {
      delete process.env.PA_KB_SOURCES_PATH;
    }
  });

  it('conversation/traces/topicBrains/reviewDigest are all derived under PA_HOME', async () => {
    const sources = await buildSourcesConfig(undefined);
    assert.equal(sources.conversation!.live, join(dir, 'conversation-history.jsonl'));
    assert.equal(sources.traces!.live, join(dir, 'turn-traces.jsonl'));
    assert.equal(sources.topicBrains!.dir, join(dir, 'topic-brains'));
    assert.equal(sources.reviewDigest!.path, join(dir, 'review-digest-pending.jsonl'));
  });
});

describe('runRecallEngine', () => {
  it('index against a real temp PA_HOME with one synthetic conversation line, then query finds it', async () => {
    const convPath = join(dir, 'conversation-history.jsonl');
    writeFileSync(
      convPath,
      JSON.stringify({
        role: 'user',
        timestamp: '2026-08-20T16:32:00.000Z',
        thread_id: 7822,
        text: 'the next distinctivewombat fast is on Thursday',
      }) + '\n',
      'utf8',
    );

    const indexResult = await runRecallEngine('index');
    assert.equal(indexResult.ok, true);
    const indexed = indexResult.indexed as { added: number };
    assert.equal(indexed.added, 1);

    const queryResult = await runRecallEngine('query', { query: 'distinctivewombat' } as any);
    assert.equal(queryResult.ok, true);
    const hits = queryResult.hits as unknown[];
    assert.equal(hits.length, 1);
  });

  it('resolves {ok:false, error} — never rejects — when the store throws', async () => {
    // recall.sqlite as a directory makes `new Database(path)` throw on open.
    mkdirSync(join(dir, 'recall.sqlite'), { recursive: true });
    const result = await runRecallEngine('index');
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
  });
});

describe('recallCommand', () => {
  it('prints exactly one JSON line for --json and returns 0', async () => {
    const cap = captureConsole();
    let code: number;
    try {
      code = await recallCommand(['nonexistent-term-xyz', '--json']);
    } finally {
      cap.restore();
    }
    assert.equal(code, 0);
    assert.equal(cap.logs.length, 1);
    assert.equal(cap.logs[0].includes('\n'), false);
    const parsed = JSON.parse(cap.logs[0]);
    assert.equal(parsed.ok, true);
  });

  it('a secret planted in secrets.env and echoed via a doc field comes out redacted', async () => {
    await createTempSecrets(dir, 'MY_LEAKED_TOKEN=abcdefgh12345678\n');
    resetRedactCache();

    const convPath = join(dir, 'conversation-history.jsonl');
    writeFileSync(
      convPath,
      JSON.stringify({
        role: 'user',
        timestamp: '2026-08-20T16:32:00.000Z',
        thread_id: 1,
        text: 'a searchableleaktoken turn',
        // `worker` is copied verbatim into ref_json by recall-store.ts and is
        // NOT redacted at index time (only title/text are) — this is exactly
        // the gap R3 requires the CLI-level redaction pass to close.
        worker: 'abcdefgh12345678',
      }) + '\n',
      'utf8',
    );

    const cap = captureConsole();
    let code: number;
    try {
      code = await recallCommand(['searchableleaktoken', '--json']);
    } finally {
      cap.restore();
    }
    assert.equal(code, 0);
    const parsed = JSON.parse(cap.logs[0]);
    assert.equal(parsed.hits.length, 1);
    assert.equal(parsed.hits[0].ref.worker, '<redacted:MY_LEAKED_TOKEN>');
    assert.ok(!cap.logs[0].includes('abcdefgh12345678'));
  });

  it('rejects with usage on an unknown flag (exit 2, no stack trace)', async () => {
    const cap = captureConsole();
    let code: number;
    try {
      code = await recallCommand(['--bogus']);
    } finally {
      cap.restore();
    }
    assert.equal(code, 2);
    assert.ok(cap.errors.some((l) => l.startsWith('Usage: pa recall')));
    assert.ok(!cap.errors.some((l) => l.includes('at ')), 'no stack trace in usage output');
  });

  it('rejects with usage when no query and no --reindex/--rebuild', async () => {
    const cap = captureConsole();
    let code: number;
    try {
      code = await recallCommand([]);
    } finally {
      cap.restore();
    }
    assert.equal(code, 2);
  });
});

describe('recallIndexJob', () => {
  it('declares the frozen metadata', () => {
    assert.equal(recallIndexJob.name, 'recall-index');
    assert.equal(recallIndexJob.host, 'pa');
    assert.equal(recallIndexJob.everyMs, 600_000);
    assert.equal(recallIndexJob.destructive, false);
    assert.deepEqual(recallIndexJob.targets, []);
  });

  it('run() rejects when the engine reports ok:false', async () => {
    // Force runRecallEngine to fail the same way as the runRecallEngine test
    // above: recall.sqlite as a directory makes the store throw on open.
    mkdirSync(join(dir, 'recall.sqlite'), { recursive: true });
    await assert.rejects(() => recallIndexJob.run({ now: Date.now(), everyMs: 600_000 }));
  });
});
