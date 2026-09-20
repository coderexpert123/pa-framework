import './test-env-guard.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  selectEvalRows,
  summarizeQuestion,
  runTypedRoutingEval,
  EVAL_MIN_SCORED_ROWS,
} from '../src/lib/typesafe-routing-eval.js';
import type { TopicRegistryEntry } from '../src/lib/topic-registry.js';
import type { TypeSafeResult } from '../src/lib/typesafe-client.js';

function createLedgerDb(): {
  db: Database.Database;
  insertTask: Database.Statement;
  insertEvent: Database.Statement;
} {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE tasks (task_id TEXT PRIMARY KEY, tenant_id TEXT, source TEXT, request_text TEXT, transcript TEXT, conversation_id TEXT, feedback_about TEXT, created_at TEXT)`
  );
  db.exec(`CREATE TABLE events (event_id TEXT, tenant_id TEXT, task_id TEXT, kind TEXT, payload_json TEXT, ts TEXT)`);
  const insertTask = db.prepare(
    `INSERT INTO tasks (task_id, tenant_id, source, request_text, transcript, conversation_id, feedback_about, created_at)
     VALUES (@task_id, @tenant_id, @source, @request_text, @transcript, @conversation_id, @feedback_about, @created_at)`
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (event_id, tenant_id, task_id, kind, payload_json, ts)
     VALUES (@event_id, @tenant_id, @task_id, @kind, @payload_json, @ts)`
  );
  return { db, insertTask, insertEvent };
}

function topicEntry(threadId: number, name: string, description?: string): TopicRegistryEntry {
  return {
    chatId: '-100123',
    threadId,
    key: `-100123_${threadId}`,
    name,
    description,
    legacyString: false,
  };
}

function registryFixture(): TopicRegistryEntry[] {
  return [topicEntry(0, 'General'), topicEntry(5, 'Health', 'health topics'), topicEntry(900, 'Inbox')];
}

function tempExistingFile(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const p = join(dir, 'ledger.sqlite3');
  writeFileSync(p, '', 'utf8');
  return p;
}

describe('typesafe-routing-eval', () => {
  it('selectEvalRows keeps LLM-routed rows and counts every skip reason', () => {
    const { db, insertTask, insertEvent } = createLedgerDb();
    insertTask.run({
      task_id: 'te1-a',
      tenant_id: 't1',
      source: 'text',
      request_text: 'my back hurts',
      transcript: null,
      conversation_id: null,
      feedback_about: null,
      created_at: '2026-09-01T00:01:00.000Z',
    });
    insertEvent.run({
      event_id: 'ev-a',
      tenant_id: 't1',
      task_id: 'te1-a',
      kind: 'task.routed',
      payload_json: JSON.stringify({ reason: 'looks like health', routed_to: '-100123_5' }),
      ts: '2026-09-01T00:01:01.000Z',
    });

    insertTask.run({
      task_id: 'te1-b',
      tenant_id: 't1',
      source: 'text',
      request_text: 'no event for this one',
      transcript: null,
      conversation_id: null,
      feedback_about: null,
      created_at: '2026-09-01T00:02:00.000Z',
    });
    // te1-b: no routed event at all -> notRouted

    insertTask.run({
      task_id: 'te1-c',
      tenant_id: 't1',
      source: 'text',
      request_text: 'deterministic case',
      transcript: null,
      conversation_id: null,
      feedback_about: null,
      created_at: '2026-09-01T00:03:00.000Z',
    });
    insertEvent.run({
      event_id: 'ev-c',
      tenant_id: 't1',
      task_id: 'te1-c',
      kind: 'task.routed',
      payload_json: JSON.stringify({
        reason: 'Placed by the deterministic fallback after 9 minutes waiting',
        routed_to: '-100123_0',
      }),
      ts: '2026-09-01T00:03:01.000Z',
    });

    insertTask.run({
      task_id: 'te1-d',
      tenant_id: 't1',
      source: 'voice',
      request_text: '   ',
      transcript: '',
      conversation_id: null,
      feedback_about: null,
      created_at: '2026-09-01T00:04:00.000Z',
    });
    insertEvent.run({
      event_id: 'ev-d',
      tenant_id: 't1',
      task_id: 'te1-d',
      kind: 'task.routed',
      payload_json: JSON.stringify({ reason: 'seems administrative', routed_to: '-100123_0' }),
      ts: '2026-09-01T00:04:01.000Z',
    });

    insertTask.run({
      task_id: 'te1-e',
      tenant_id: 't1',
      source: 'text',
      request_text: 'a financial question',
      transcript: null,
      conversation_id: null,
      feedback_about: null,
      created_at: '2026-09-01T00:05:00.000Z',
    });
    insertEvent.run({
      event_id: 'ev-e',
      tenant_id: 't1',
      task_id: 'te1-e',
      kind: 'task.routed',
      payload_json: JSON.stringify({ reason: 'looks financial', routed_to: '-100123_77' }),
      ts: '2026-09-01T00:05:01.000Z',
    });

    insertTask.run({
      task_id: 'te1-f',
      tenant_id: 't1',
      source: 'text',
      request_text: 'continuing the earlier thread',
      transcript: null,
      conversation_id: null,
      feedback_about: null,
      created_at: '2026-09-01T00:06:00.000Z',
    });
    insertEvent.run({
      event_id: 'ev-f',
      tenant_id: 't1',
      task_id: 'te1-f',
      kind: 'task.routed',
      payload_json: JSON.stringify({
        reason: 'continues an earlier thread',
        routed_to: '-100123_0',
        continues: 'vi-abc123456789',
        conversation_id: 'vi-abc123456789',
      }),
      ts: '2026-09-01T00:06:01.000Z',
    });

    const { rows, skipped } = selectEvalRows(db, {
      sinceIso: '2026-01-01T00:00:00.000Z',
      candidateKeys: new Set(['-100123_0', '-100123_5']),
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(skipped, { notRouted: 1, notLlmRouted: 1, noText: 1, labelNotCandidate: 1 });
    const f = rows.find((r) => r.taskId === 'te1-f');
    assert.equal(f?.labelConversation, 'vi-abc123456789');
    db.close();
  });

  it('the offer holds conversations with a task in the prior 24 hours, never the task itself', () => {
    const { db, insertTask, insertEvent } = createLedgerDb();
    const rawText = 'original   P   task   text  with   lots \n of   whitespace   that   exceeds   sixty   characters   for   sure';
    const expectedSnippet = rawText.replace(/\s+/g, ' ').trim().slice(0, 60);

    insertTask.run({
      task_id: 'task-x',
      tenant_id: 't-2',
      source: 'text',
      request_text: 'need help with X',
      transcript: null,
      conversation_id: null,
      feedback_about: null,
      created_at: '2026-09-10T12:00:00.000Z',
    });
    insertEvent.run({
      event_id: 'ev-x',
      tenant_id: 't-2',
      task_id: 'task-x',
      kind: 'task.routed',
      payload_json: JSON.stringify({ reason: 'seems like a fit', routed_to: '-100123_5' }),
      ts: '2026-09-10T12:00:01.000Z',
    });

    // conversation P root: within the 24h window before X, offered.
    insertTask.run({
      task_id: 'conv-p',
      tenant_id: 't-2',
      source: 'text',
      request_text: rawText,
      transcript: null,
      conversation_id: 'conv-p',
      feedback_about: null,
      created_at: '2026-09-10T02:00:00.000Z',
    });

    // conversation Q root: outside the 24h window before X.
    insertTask.run({
      task_id: 'conv-q',
      tenant_id: 't-2',
      source: 'text',
      request_text: 'q text',
      transcript: null,
      conversation_id: 'conv-q',
      feedback_about: null,
      created_at: '2026-09-09T11:00:00.000Z',
    });

    // X's own conversation: excluded because its conversation_id is X's own task_id.
    insertTask.run({
      task_id: 'task-x-prev',
      tenant_id: 't-2',
      source: 'text',
      request_text: 'x prev',
      transcript: null,
      conversation_id: 'task-x',
      feedback_about: null,
      created_at: '2026-09-10T10:00:00.000Z',
    });

    // A task created after X: excluded by the window bound.
    insertTask.run({
      task_id: 'task-after',
      tenant_id: 't-2',
      source: 'text',
      request_text: 'after',
      transcript: null,
      conversation_id: 'task-after',
      feedback_about: null,
      created_at: '2026-09-10T13:00:00.000Z',
    });

    const opts = { sinceIso: '2020-01-01T00:00:00.000Z', candidateKeys: new Set(['-100123_5']) };
    const { rows } = selectEvalRows(db, opts);
    const x = rows.find((r) => r.taskId === 'task-x');
    assert.ok(x, 'task-x should be kept');
    assert.deepEqual(
      x!.offer.map((o) => o.conversationId),
      ['conv-p']
    );
    assert.equal(x!.offer[0].snippet, expectedSnippet);
    assert.equal(x!.askContinuation, true);

    db.prepare('UPDATE tasks SET feedback_about = ? WHERE task_id = ?').run('spam', 'task-x');
    const { rows: rows2 } = selectEvalRows(db, opts);
    const x2 = rows2.find((r) => r.taskId === 'task-x');
    assert.equal(x2?.askContinuation, false);
    db.close();
  });

  it('summarizeQuestion bands points and recommends the lowest floor meeting the target', () => {
    // 10 points at 0.97 (all correct) + 10 points at 0.85 (5 correct, 5 incorrect).
    const points: Array<{ confidence: number; correct: boolean }> = [
      ...Array.from({ length: 10 }, () => ({ confidence: 0.97, correct: true })),
      ...Array.from({ length: 5 }, () => ({ confidence: 0.85, correct: true })),
      ...Array.from({ length: 5 }, () => ({ confidence: 0.85, correct: false })),
    ];
    const summary = summarizeQuestion(points, 0.9);
    const band95 = summary.bands.find((b) => b.floor === 0.95);
    const band80 = summary.bands.find((b) => b.floor === 0.8);
    assert.deepEqual({ n: band95?.n, agree: band95?.agree }, { n: 10, agree: 10 });
    assert.deepEqual({ n: band80?.n, agree: band80?.agree }, { n: 10, agree: 5 });
    assert.equal(summary.recommended, 0.95);
    const summaryLowTarget = summarizeQuestion(points, 0.7);
    assert.equal(summaryLowTarget.recommended, 0.8);
  });

  it('summarizeQuestion recommends nothing below the minimum row count', () => {
    const points = Array.from({ length: EVAL_MIN_SCORED_ROWS - 1 }, () => ({ confidence: 0.99, correct: true }));
    const summary = summarizeQuestion(points, 0.9);
    assert.equal(summary.recommended, null);
  });

  it('a dry run sends nothing, needs no key and prints the request size', async () => {
    const { db, insertTask, insertEvent } = createLedgerDb();
    insertTask.run({
      task_id: 'te5-1',
      tenant_id: 't5',
      source: 'text',
      request_text: 'quick fixture text for dry run pricing calc',
      transcript: null,
      conversation_id: null,
      feedback_about: null,
      created_at: '2026-09-05T00:00:00.000Z',
    });
    insertEvent.run({
      event_id: 'ev-te5-1',
      tenant_id: 't5',
      task_id: 'te5-1',
      kind: 'task.routed',
      payload_json: JSON.stringify({ reason: 'seems to fit', routed_to: '-100123_5' }),
      ts: '2026-09-05T00:00:01.000Z',
    });
    const lines: string[] = [];
    let askCalls = 0;
    const ledgerPath = tempExistingFile('pa-ts-eval-dry-');
    const code = await runTypedRoutingEval(
      { dryRun: true, sinceIso: '2026-09-01T00:00:00.000Z' },
      {
        print: (l) => lines.push(l),
        ledgerPath,
        openDbFn: () => db,
        readConfigFn: () => ({ keywordTopics: {}, inboxTopic: '-100123_900' }),
        readRegistryFn: () => registryFixture(),
        configuredFn: () => false,
        askFn: async () => {
          askCalls += 1;
          return { ok: false, error: 'no-key', latencyMs: 0, retries: 0 } satisfies TypeSafeResult;
        },
        nowFn: () => Date.parse('2026-09-17T00:00:00.000Z'),
      }
    );
    assert.equal(code, 0);
    assert.equal(askCalls, 0);
    assert.ok(lines.some((l) => l.startsWith('typesafe eval: dry-run, no requests sent; request_chars avg=')));
    db.close();
  });

  it('a real run without a key exits 1 before any request', async () => {
    const { db, insertTask, insertEvent } = createLedgerDb();
    insertTask.run({
      task_id: 'te6-1',
      tenant_id: 't6',
      source: 'text',
      request_text: 'another fixture request',
      transcript: null,
      conversation_id: null,
      feedback_about: null,
      created_at: '2026-09-05T00:00:00.000Z',
    });
    insertEvent.run({
      event_id: 'ev-te6-1',
      tenant_id: 't6',
      task_id: 'te6-1',
      kind: 'task.routed',
      payload_json: JSON.stringify({ reason: 'seems to fit', routed_to: '-100123_5' }),
      ts: '2026-09-05T00:00:01.000Z',
    });
    const lines: string[] = [];
    let askCalls = 0;
    const ledgerPath = tempExistingFile('pa-ts-eval-nokey-');
    const code = await runTypedRoutingEval(
      { dryRun: false, sinceIso: '2026-09-01T00:00:00.000Z' },
      {
        print: (l) => lines.push(l),
        ledgerPath,
        openDbFn: () => db,
        readConfigFn: () => ({ keywordTopics: {}, inboxTopic: '-100123_900' }),
        readRegistryFn: () => registryFixture(),
        configuredFn: () => false,
        askFn: async () => {
          askCalls += 1;
          return { ok: false, error: 'no-key', latencyMs: 0, retries: 0 } satisfies TypeSafeResult;
        },
        nowFn: () => Date.parse('2026-09-17T00:00:00.000Z'),
      }
    );
    assert.equal(code, 1);
    assert.equal(askCalls, 0);
    assert.equal(lines[lines.length - 1], 'typesafe eval: not configured (TYPESAFE_API_KEY unset or circuit breaker open); nothing was sent');
    db.close();
  });

  it('a configured run writes one JSONL line per row and prints both summaries', async () => {
    const { db, insertTask, insertEvent } = createLedgerDb();
    // An earlier task in the same tenant, within 24h, so te7-1/te7-2 get an offer.
    insertTask.run({
      task_id: 'te7-conv',
      tenant_id: 't7',
      source: 'text',
      request_text: 'FIXTURE-TEXT-CONV earlier conversation',
      transcript: null,
      conversation_id: 'te7-conv',
      feedback_about: null,
      created_at: '2026-09-15T09:00:00.000Z',
    });
    insertTask.run({
      task_id: 'te7-1',
      tenant_id: 't7',
      source: 'text',
      request_text: 'FIXTURE-TEXT-ONE please help',
      transcript: null,
      conversation_id: null,
      feedback_about: null,
      created_at: '2026-09-15T10:00:00.000Z',
    });
    insertEvent.run({
      event_id: 'ev-te7-1',
      tenant_id: 't7',
      task_id: 'te7-1',
      kind: 'task.routed',
      payload_json: JSON.stringify({ reason: 'seems to fit', routed_to: '-100123_5' }),
      ts: '2026-09-15T10:00:01.000Z',
    });
    insertTask.run({
      task_id: 'te7-2',
      tenant_id: 't7',
      source: 'text',
      request_text: 'FIXTURE-TEXT-TWO another request',
      transcript: null,
      conversation_id: null,
      feedback_about: null,
      created_at: '2026-09-15T11:00:00.000Z',
    });
    insertEvent.run({
      event_id: 'ev-te7-2',
      tenant_id: 't7',
      task_id: 'te7-2',
      kind: 'task.routed',
      payload_json: JSON.stringify({ reason: 'seems to fit too', routed_to: '-100123_5' }),
      ts: '2026-09-15T11:00:01.000Z',
    });

    const lines: string[] = [];
    const outDir = mkdtempSync(join(tmpdir(), 'pa-ts-eval-out-'));
    const outPath = join(outDir, 'routing-test.jsonl');
    const askStub = async (): Promise<TypeSafeResult> =>
      ({
        ok: true,
        answers: {
          destination: {
            type: 'choice',
            choice: '-100123_5',
            probabilities: { '-100123_5': 0.96, '-100123_0': 0.02, none_of_the_above: 0.02 },
            confidence: 0.96,
          },
          continues: { type: 'choice', choice: 'none', probabilities: { none: 0.97 }, confidence: 0.97 },
        },
        usage: { inputTokens: 10, outputTokens: 2 },
        latencyMs: 5,
        status: 200,
        retries: 0,
      }) satisfies TypeSafeResult;

    const code = await runTypedRoutingEval(
      { dryRun: false, sinceIso: '2026-09-01T00:00:00.000Z', outPath },
      {
        print: (l) => lines.push(l),
        ledgerPath: tempExistingFile('pa-ts-eval-full-'),
        openDbFn: () => db,
        readConfigFn: () => ({ keywordTopics: {}, inboxTopic: '-100123_900' }),
        readRegistryFn: () => registryFixture(),
        configuredFn: () => true,
        askFn: askStub,
        nowFn: () => Date.parse('2026-09-17T00:00:00.000Z'),
      }
    );
    assert.equal(code, 0);
    const content = readFileSync(outPath, 'utf8');
    const fileLines = content.trim().split('\n');
    assert.equal(fileLines.length, 2);
    for (const line of fileLines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.taskId, 'string');
    }
    assert.ok(!content.includes('FIXTURE-TEXT'));
    assert.ok(lines.some((l) => l.startsWith('destination: scored=')));
    assert.ok(lines.some((l) => l.startsWith('continuation: scored=')));
    assert.ok(lines.some((l) => l === `typesafe eval: wrote ${outPath}`));
    db.close();
    rmSync(outDir, { recursive: true, force: true });
  });
});
