import './test-env-guard.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  buildLabelerPreamble,
  createClaudeLabelerRunner,
  emptyJudgeSkipCounts,
  estimateTypeSafeInputTokens,
  finalizeCandidates,
  historyCandidates,
  judgeRowId,
  labelerArgs,
  labelerEnv,
  labelerRubricVersion,
  labelRows,
  ledgerCandidates,
  LABELER_JSON_SCHEMA,
  normalizeForDedup,
  parseLabelerOutput,
  readLabelCache,
  runJudgeEval,
  selectJudgeSample,
  type JudgeCandidate,
  type JudgeEvalRow,
  type LabelerCallResult,
} from '../src/lib/typesafe-judge-eval.js';
import { REQUEST_CLASS_QUESTION } from '../src/lib/routing-policy.js';
import { renderTypeSafeCriterion, type TypeSafeRequest, type TypeSafeResult } from '../src/lib/typesafe-client.js';

const identity = (text: string): string => text;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function userLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ role: 'user', timestamp: '2026-09-05T10:00:00.000Z', thread_id: 5, ...fields });
}

function rowsFrom(candidates: JudgeCandidate[]): JudgeEvalRow[] {
  return finalizeCandidates(candidates, emptyJudgeSkipCounts(), identity);
}

function labelerStdout(labels: Array<{ id: string; label: string; reason: string }>): string {
  return JSON.stringify({ type: 'result', is_error: false, structured_output: { labels } });
}

function recordsOf(prompt: string): Array<{ id: string; text: string }> {
  const marker = 'Records (JSON):\n';
  return JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length)) as Array<{ id: string; text: string }>;
}

function choiceResult(choice: string, confidence: number): TypeSafeResult {
  return {
    ok: true,
    answers: {
      request_class: {
        type: 'choice',
        choice,
        probabilities: { code: choice === 'code' ? confidence : 1 - confidence, general: choice === 'general' ? confidence : 1 - confidence },
        confidence,
      },
    },
    usage: { inputTokens: 1, outputTokens: 1 },
    latencyMs: 1,
    status: 200,
    retries: 0,
  };
}

describe('typesafe-judge-eval', () => {
  it('historyCandidates keeps operator requests and counts every skip reason', () => {
    const content = [
      JSON.stringify({ role: 'assistant', text: 'done, fixed it', timestamp: '2026-09-05T10:00:00.000Z' }),
      userLine({ text: 'please fix the crash in the parser module' }),
      userLine({ text: '/status', via: 'button' }),
      userLine({ text: '[Voice inbox task vi-0123456789ab] route this request', via: 'route' }),
      userLine({ text: '/status now please' }),
      userLine({ text: '   ' }),
      userLine({ text: 'an old request about the garden', timestamp: '2026-01-01T00:00:00.000Z' }),
      'not json',
      userLine({ text: '[Voice message] remind me to buy milk tomorrow', thread_id: 7 }),
      '',
    ].join('\n');
    const skipped = emptyJudgeSkipCounts();
    const out = historyCandidates(content, { sinceIso: '2026-09-01T00:00:00.000Z' }, skipped);
    assert.deepEqual(
      out.map((c) => [c.source, c.stratum, c.text]),
      [
        ['history', 'history:5', 'please fix the crash in the parser module'],
        ['history', 'history:7', '[Voice message] remind me to buy milk tomorrow'],
      ]
    );
    assert.deepEqual(skipped, { outsideWindow: 1, synthetic: 2, command: 1, noText: 1, short: 0, duplicate: 0, malformed: 1 });
  });

  it('ledgerCandidates reads voice-inbox requests with the bot text rule', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE tasks (task_id TEXT PRIMARY KEY, source TEXT, request_text TEXT, transcript TEXT, created_at TEXT)');
    const insert = db.prepare('INSERT INTO tasks (task_id, source, request_text, transcript, created_at) VALUES (?, ?, ?, ?, ?)');
    insert.run('vi-000000000001', 'voice', 'cleaned request words here', 'um raw words here', '2026-09-10T01:00:00.000Z');
    insert.run('vi-000000000002', 'voice', '(voice recording)', null, '2026-09-10T02:00:00.000Z');
    insert.run('vi-000000000003', 'text', 'typed request words', null, '2026-09-10T03:00:00.000Z');
    insert.run('vi-000000000004', 'text', 'too early request words', null, '2026-08-01T03:00:00.000Z');
    const skipped = emptyJudgeSkipCounts();
    const out = ledgerCandidates(db, { sinceIso: '2026-09-01T00:00:00.000Z' }, skipped);
    db.close();
    assert.deepEqual(
      out.map((c) => [c.source, c.stratum, c.text]),
      [
        ['voice-inbox', 'voice-inbox', 'cleaned request words here'],
        ['voice-inbox', 'voice-inbox', 'typed request words'],
      ]
    );
    assert.equal(skipped.noText, 1);
    assert.equal(skipped.outsideWindow, 1);
  });

  it('finalizeCandidates drops short and duplicate rows, redacts and caps text', () => {
    const skipped = emptyJudgeSkipCounts();
    const long = `write a long request ${'x'.repeat(5000)}`;
    const rows = finalizeCandidates(
      [
        { source: 'voice-inbox', stratum: 'voice-inbox', createdAt: '2026-09-03T00:00:00.000Z', text: '[Voice message] fix the crash   in the parser' },
        { source: 'history', stratum: 'history:1', createdAt: '2026-09-01T00:00:00.000Z', text: 'ok thanks' },
        { source: 'history', stratum: 'history:1', createdAt: '2026-09-02T00:00:00.000Z', text: 'Fix the Crash in the parser' },
        { source: 'history', stratum: 'history:2', createdAt: '2026-09-04T00:00:00.000Z', text: 'rotate the key sk-ABCDEFGHIJ in the vault' },
        { source: 'history', stratum: 'history:2', createdAt: '2026-09-05T00:00:00.000Z', text: long },
      ],
      skipped,
      (text) => text.replace(/sk-[A-Z]+/g, '<redacted:token>')
    );
    assert.equal(rows.length, 3);
    assert.equal(skipped.short, 1);
    assert.equal(skipped.duplicate, 1);
    assert.equal(rows[0].text, 'Fix the Crash in the parser');
    assert.equal(rows[0].source, 'history');
    assert.equal(rows[0].id, judgeRowId(normalizeForDedup('[Voice message] fix the crash   in the parser')));
    assert.equal(rows[1].text, 'rotate the key <redacted:token> in the vault');
    assert.equal(rows[2].text.length, 4000);
    for (const r of rows) assert.match(r.id, /^r-[0-9a-f]{12}$/);
  });

  it('selectJudgeSample is deterministic, mixes topics and reserves a third for voice-inbox', () => {
    const candidates: JudgeCandidate[] = [];
    const add = (source: 'history' | 'voice-inbox', stratum: string, count: number): void => {
      for (let i = 0; i < count; i++) {
        candidates.push({ source, stratum, createdAt: '2026-09-05T00:00:00.000Z', text: `request ${stratum} number ${i} about something` });
      }
    };
    add('voice-inbox', 'voice-inbox', 30);
    add('history', 'history:a', 40);
    add('history', 'history:b', 5);
    add('history', 'history:c', 5);
    const rows = rowsFrom(candidates);
    const sample = selectJudgeSample(rows, 30);
    const count = (stratum: string): number => sample.filter((r) => r.stratum === stratum).length;
    assert.equal(sample.length, 30);
    assert.equal(count('voice-inbox'), 10);
    assert.deepEqual([count('history:a'), count('history:b'), count('history:c')], [10, 5, 5]);
    assert.deepEqual(
      selectJudgeSample([...rows].reverse(), 30).map((r) => r.id),
      sample.map((r) => r.id)
    );
    const keys = sample.map((r) => r.orderKey);
    assert.deepEqual(keys, [...keys].sort());
    const fourVoice = selectJudgeSample([...rows.filter((r) => r.source === 'voice-inbox').slice(0, 4), ...rows.filter((r) => r.source === 'history')], 30);
    assert.equal(fourVoice.filter((r) => r.source === 'voice-inbox').length, 4);
    assert.equal(fourVoice.length, 30);
  });

  it('parseLabelerOutput accepts structured_output or a JSON result and drops bad entries', () => {
    const batch = new Set(['r-1', 'r-2', 'r-3']);
    const a = parseLabelerOutput(
      labelerStdout([
        { id: 'r-1', label: 'code', reason: 'asks for a fix' },
        { id: 'r-2', label: 'maybe', reason: 'x' },
        { id: 'r-9', label: 'general', reason: 'x' },
        { id: 'r-3', label: 'general', reason: 'a' },
        { id: 'r-3', label: 'code', reason: 'b' },
      ]),
      batch
    );
    assert.deepEqual([...a.entries()], [['r-1', { label: 'code', reason: 'asks for a fix' }]]);
    const b = parseLabelerOutput(
      JSON.stringify({ is_error: false, result: '```json\n{"labels":[{"id":"r-2","label":"unclear","reason":"fragment"}]}\n```' }),
      batch
    );
    assert.deepEqual([...b.entries()], [['r-2', { label: 'unclear', reason: 'fragment' }]]);
    assert.equal(parseLabelerOutput(JSON.stringify({ is_error: true, result: 'boom' }), batch).size, 0);
    assert.equal(parseLabelerOutput('not json', batch).size, 0);
  });

  it('readLabelCache ignores other rubric versions and torn lines', () => {
    const dir = tempDir('je-cache-');
    const path = join(dir, 'judge-labels.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({ id: 'r-1', label: 'code', rubric: 'X', reason: '', model: 'opus', labeledAt: '', source: 'history', text: 't' }),
        JSON.stringify({ id: 'r-2', label: 'general', rubric: 'Y', reason: '', model: 'opus', labeledAt: '', source: 'history', text: 't' }),
        'garbage',
        JSON.stringify({ id: 'r-3', label: 'bogus', rubric: 'X', reason: '', model: 'opus', labeledAt: '', source: 'history', text: 't' }),
        '',
      ].join('\n'),
      'utf8'
    );
    assert.deepEqual([...readLabelCache(path, 'X').keys()], ['r-1']);
    assert.equal(readLabelCache(join(dir, 'missing.jsonl'), 'X').size, 0);
  });

  it('labelRows uses the cache, retries missing ids once and caches new labels', async () => {
    const dir = tempDir('je-label-');
    const cachePath = join(dir, 'judge-labels.jsonl');
    const rows = rowsFrom([
      { source: 'history', stratum: 'history:1', createdAt: '2026-09-01T00:00:00.000Z', text: 'first request about the build' },
      { source: 'history', stratum: 'history:1', createdAt: '2026-09-02T00:00:00.000Z', text: 'second request about groceries' },
      { source: 'history', stratum: 'history:1', createdAt: '2026-09-03T00:00:00.000Z', text: 'third request about something vague' },
    ]);
    const cache = new Map([
      [rows[0].id, { id: rows[0].id, label: 'code' as const, reason: '', rubric: 'R', model: 'opus', labeledAt: '', source: 'history' as const, text: rows[0].text }],
    ]);
    const prompts: string[] = [];
    const outcome = await labelRows(rows, {
      cache,
      cachePath,
      rubric: 'R',
      nowIso: () => '2026-09-17T00:00:00.000Z',
      runner: async (prompt: string): Promise<LabelerCallResult> => {
        prompts.push(prompt);
        if (prompts.length === 1) return { ok: true, stdout: labelerStdout([{ id: rows[1].id, label: 'general', reason: 'shopping' }]) };
        return { ok: true, stdout: labelerStdout([{ id: rows[2].id, label: 'unclear', reason: 'vague' }]) };
      },
    });
    assert.equal(outcome.calls, 2);
    assert.equal(outcome.cached, 1);
    assert.equal(outcome.labeledNow, 2);
    assert.equal(outcome.labelErrors, 0);
    assert.equal(outcome.stopped, false);
    assert.deepEqual([...outcome.labels.entries()].sort(), [[rows[0].id, 'code'], [rows[1].id, 'general'], [rows[2].id, 'unclear']].sort());
    assert.deepEqual(recordsOf(prompts[0]).map((r) => r.id), [rows[1].id, rows[2].id]);
    assert.deepEqual(recordsOf(prompts[1]).map((r) => r.id), [rows[2].id]);
    const cachedLines = readFileSync(cachePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(cachedLines.map((l) => [l.id, l.label, l.rubric, l.text]), [
      [rows[1].id, 'general', 'R', rows[1].text],
      [rows[2].id, 'unclear', 'R', rows[2].text],
    ]);
  });

  it('labelRows stops after two batches with no valid labels and never caches a failure', async () => {
    const dir = tempDir('je-stop-');
    const cachePath = join(dir, 'judge-labels.jsonl');
    const rows = rowsFrom(
      Array.from({ length: 45 }, (_, i) => ({
        source: 'history' as const,
        stratum: 'history:1',
        createdAt: '2026-09-01T00:00:00.000Z',
        text: `request number ${i} for the labeler`,
      }))
    );
    let calls = 0;
    const outcome = await labelRows(rows, {
      cache: new Map(),
      cachePath,
      rubric: 'R',
      nowIso: () => '2026-09-17T00:00:00.000Z',
      runner: async (): Promise<LabelerCallResult> => {
        calls += 1;
        return { ok: false, error: 'exit 1: not logged in' };
      },
    });
    assert.equal(calls, 4);
    assert.equal(outcome.calls, 4);
    assert.equal(outcome.stopped, true);
    assert.equal(outcome.labelErrors, 45);
    assert.equal(outcome.lastError, 'exit 1: not logged in');
    assert.equal(existsSync(cachePath), false);
  });

  it('the labeler invocation carries the rubric and schema without the TypeSafe key or a proxy base url', () => {
    assert.deepEqual(labelerArgs(), [
      '-p',
      '--model',
      'opus',
      '--effort',
      'high',
      '--output-format',
      'json',
      '--json-schema',
      LABELER_JSON_SCHEMA,
      '--tools',
      '',
      '--safe-mode',
      '--no-session-persistence',
    ]);
    assert.deepEqual(
      labelerEnv({
        PATH: 'p',
        HOME: 'h',
        TYPESAFE_API_KEY: 'k',
        TYPESAFE_BASE_URL: 'b',
        ANTHROPIC_BASE_URL: 'u',
        ANTHROPIC_AUTH_TOKEN: 't',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm',
        CLAUDECODE: '1',
      }),
      { PATH: 'p', HOME: 'h' }
    );
    const preamble = buildLabelerPreamble();
    assert.ok(preamble.includes(renderTypeSafeCriterion(REQUEST_CLASS_QUESTION.criteria.code)));
    assert.ok(preamble.includes(renderTypeSafeCriterion(REQUEST_CLASS_QUESTION.criteria.general)));
    const schema = JSON.parse(LABELER_JSON_SCHEMA) as { properties: { labels: { items: { properties: { label: { enum: string[] } } } } } };
    assert.deepEqual(schema.properties.labels.items.properties.label.enum, ['code', 'general', 'unclear']);
    assert.match(labelerRubricVersion(), /^[0-9a-f]{12}$/);
  });

  it('createClaudeLabelerRunner returns stdout on exit 0, an error on a non-zero exit and on a timeout', async () => {
    const cwd = tempDir('je-runner-');
    const echo = createClaudeLabelerRunner(process.execPath, cwd, 20_000, [
      '-e',
      'let s="";process.stdin.on("data",(d)=>{s+=d;});process.stdin.on("end",()=>{process.stdout.write(s.toUpperCase());});',
    ]);
    assert.deepEqual(await echo('abc'), { ok: true, stdout: 'ABC' });
    const failing = createClaudeLabelerRunner(process.execPath, cwd, 20_000, ['-e', 'process.stderr.write("bad thing");process.exit(3);']);
    assert.deepEqual(await failing('abc'), { ok: false, error: 'exit 3: bad thing' });
    const hanging = createClaudeLabelerRunner(process.execPath, cwd, 300, ['-e', 'setTimeout(()=>{},10000);']);
    assert.deepEqual(await hanging('abc'), { ok: false, error: 'timeout after 300 ms' });
  });

  it('a dry run sends nothing, needs no key or config and prints the cost estimate', async () => {
    const dir = tempDir('je-dry-');
    const historyPath = join(dir, 'conversation-history.jsonl');
    const texts = [
      'please refactor the parser module today',
      'remind me to call the bank at four',
      'what should I cook for dinner tonight',
      'maybe we should talk about it later on',
    ];
    writeFileSync(historyPath, texts.map((text) => userLine({ text })).join('\n'), 'utf8');
    const rubric = labelerRubricVersion();
    const unclearId = judgeRowId(normalizeForDedup(texts[3]));
    writeFileSync(
      join(dir, 'judge-labels.jsonl'),
      `${JSON.stringify({ id: unclearId, label: 'unclear', reason: '', rubric, model: 'opus', labeledAt: '', source: 'history', text: texts[3] })}\n`,
      'utf8'
    );
    const lines: string[] = [];
    let askCalls = 0;
    let runnerCalls = 0;
    let configCalls = 0;
    const code = await runJudgeEval(
      { limit: 150, agy: 10, dryRun: true, labelsOnly: false },
      {
        print: (line) => lines.push(line),
        historyPath,
        ledgerPath: join(dir, 'no-ledger.sqlite'),
        evalDir: dir,
        redactFn: identity,
        configuredFn: () => false,
        askFn: async () => {
          askCalls += 1;
          return { ok: false, error: 'no-key', latencyMs: 0, retries: 0 };
        },
        labelerRunner: async () => {
          runnerCalls += 1;
          return { ok: false, error: 'unused' };
        },
        loadConfigFn: async () => {
          configCalls += 1;
          throw new Error('unused');
        },
      }
    );
    assert.equal(code, 0);
    assert.equal(askCalls + runnerCalls + configCalls, 0);
    assert.ok(lines[0].startsWith('typesafe judge-eval: rows=4 history=4 voice-inbox=0 eligible=4 since=all until=now skipped'), lines[0]);
    const tokens = texts.slice(0, 3).reduce((sum, t) => sum + estimateTypeSafeInputTokens(t), 0);
    assert.equal(
      lines[1],
      `typesafe judge-eval: dry-run, nothing sent; rubric=${rubric} labels cached=1 (unclear=1) to_label=3 labeler_calls=1 typesafe_calls_max=3 est_typesafe_input_tokens=${tokens} agy_calls_max=3`
    );
  });

  it('a scoring run without a key exits 1 before labelling or any request', async () => {
    const dir = tempDir('je-nokey-');
    const historyPath = join(dir, 'conversation-history.jsonl');
    writeFileSync(historyPath, userLine({ text: 'please refactor the parser module today' }), 'utf8');
    const lines: string[] = [];
    let askCalls = 0;
    let runnerCalls = 0;
    const code = await runJudgeEval(
      { limit: 150, agy: 10, dryRun: false, labelsOnly: false },
      {
        print: (line) => lines.push(line),
        historyPath,
        ledgerPath: join(dir, 'no-ledger.sqlite'),
        evalDir: dir,
        redactFn: identity,
        configuredFn: () => false,
        askFn: async () => {
          askCalls += 1;
          return { ok: false, error: 'no-key', latencyMs: 0, retries: 0 };
        },
        labelerRunner: async () => {
          runnerCalls += 1;
          return { ok: false, error: 'unused' };
        },
        loadConfigFn: async () => ({ policy: { enabled: true }, claudeCommand: 'claude' }),
      }
    );
    assert.equal(code, 1);
    assert.equal(askCalls, 0);
    assert.equal(runnerCalls, 0);
    assert.equal(lines[lines.length - 1], 'typesafe judge-eval: not configured (TYPESAFE_API_KEY unset or circuit breaker open); nothing was sent');
  });

  it('a configured run scores typesafe, the ladder, the regex and the agy subsample', async () => {
    const dir = tempDir('je-run-');
    const historyPath = join(dir, 'conversation-history.jsonl');
    const outPath = join(dir, 'out', 'judge.jsonl');
    const labelsByText: Record<string, string> = {
      'please refactor the parser module today': 'code',
      'remind me to call the bank at four': 'general',
      'what should I cook for dinner tonight': 'general',
      'maybe we should talk about it later on': 'unclear',
    };
    writeFileSync(historyPath, Object.keys(labelsByText).map((text) => userLine({ text })).join('\n'), 'utf8');
    const purposes: string[] = [];
    const agyOptions: Array<{ model: string; timeoutMs: number; command?: string }> = [];
    const lines: string[] = [];
    const code = await runJudgeEval(
      { limit: 150, agy: 3, dryRun: false, labelsOnly: false, outPath },
      {
        print: (line) => lines.push(line),
        historyPath,
        ledgerPath: join(dir, 'no-ledger.sqlite'),
        evalDir: dir,
        redactFn: identity,
        configuredFn: () => true,
        loadConfigFn: async () => ({ policy: { enabled: true, judge: 'agy', judge_model: 'm', judge_timeout_ms: 5 }, claudeCommand: 'claude' }),
        labelerRunner: async (prompt: string) => ({
          ok: true,
          stdout: labelerStdout(recordsOf(prompt).map((r) => ({ id: r.id, label: labelsByText[r.text], reason: 'fixture' }))),
        }),
        askFn: async (request: TypeSafeRequest, opts: { purpose: string }) => {
          purposes.push(opts.purpose);
          const text = (request.state as { request: string }).request;
          if (text.startsWith('please refactor')) return choiceResult('code', 0.97);
          if (text.startsWith('remind me')) return choiceResult('code', 0.6);
          return { ok: false, error: 'timeout', latencyMs: 4000, retries: 0 };
        },
        agyFn: async (text: string, options: { model: string; timeoutMs: number; command?: string }) => {
          agyOptions.push(options);
          return text.startsWith('please refactor') ? 'code' : undefined;
        },
      }
    );
    assert.equal(code, 0, lines.join('\n'));
    const expected = [
      'labels: code=1 general=2 unclear=1 label_error=0 cached=0 labeled_now=4 labeler_calls=1',
      'typesafe: band 0.95-1.00 n=1 agree=100%',
      'typesafe: band 0.90-0.95 n=0 agree=0%',
      'typesafe: band 0.80-0.90 n=0 agree=0%',
      'typesafe: band 0.70-0.80 n=0 agree=0%',
      'typesafe: band 0.50-0.70 n=1 agree=0%',
      'typesafe: band 0.00-0.50 n=0 agree=0%',
      'typesafe: scored=2 recommended_threshold=none target=90%',
      'typesafe: agree=50% (1/2) unavailable=1 label->judge code->code=1 code->general=0 general->code=1 general->general=0',
      'typesafe_ladder: agree=67% (2/3) label->judge code->code=1 code->general=0 general->code=1 general->general=1',
      'regex: agree=100% (3/3) label->judge code->code=1 code->general=0 general->code=0 general->general=2',
      'agy_subsample: rows=3 agy agree=100% unavailable=2 typesafe agree=50% regex agree=100%',
      `typesafe judge-eval: wrote ${outPath}`,
    ];
    assert.deepEqual(lines.slice(1), expected);
    assert.deepEqual(purposes, ['typesafe-judge-eval', 'typesafe-judge-eval', 'typesafe-judge-eval']);
    assert.deepEqual(agyOptions.map((o) => [o.model, o.timeoutMs]), [['m', 5], ['m', 5], ['m', 5]]);
    const out = readFileSync(outPath, 'utf8');
    const outLines = out.trim().split('\n');
    assert.equal(outLines.length, 3);
    for (const l of outLines) assert.match(String((JSON.parse(l) as { id: unknown }).id), /^r-[0-9a-f]{12}$/);
    for (const text of Object.keys(labelsByText)) assert.equal(out.includes(text), false);
    assert.equal(readFileSync(join(dir, 'judge-labels.jsonl'), 'utf8').trim().split('\n').length, 4);
  });
});
