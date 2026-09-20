import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'path';
import Database from 'better-sqlite3';
import { createTempPaHome, cleanup } from './helpers.js';
import { readTurnContext } from '../src/lib/model-router/context-reader.js';

let tempDir: string;

const CAPS = { context_max_chars: 2000 };

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

/** Create a voice-inbox ledger fixture with the schema-v15 tasks shape
 *  (`worker_cli` present, per `projects/voice-inbox/src/ledger.ts` v15). */
function makeLedger(rows: Array<{ request_text: string; created_at: string; conversation_id: string; worker_cli?: string | null }>): string {
  const dir = join(tempDir, 'voice-inbox');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'ledger.sqlite');
  const db = new Database(path);
  db.exec(`CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    request_text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    conversation_id TEXT NOT NULL DEFAULT '',
    worker_cli TEXT
  )`);
  const ins = db.prepare('INSERT INTO tasks (task_id, request_text, created_at, conversation_id, worker_cli) VALUES (?, ?, ?, ?, ?)');
  rows.forEach((r, i) =>
    ins.run(`vi-${i.toString(16).padStart(12, '0')}`, r.request_text, r.created_at, r.conversation_id, r.worker_cli ?? null),
  );
  db.close();
  return path;
}

/** Pre-v15 ledger (NO worker_cli column) — the known-bad fixture for the
 *  fail-open proof (2026-09-09 rule): the reader's SELECT names worker_cli,
 *  so this shape must take the failure path, never a silent partial read. */
function makePreV15Ledger(rows: Array<{ request_text: string; created_at: string; conversation_id: string }>): string {
  const dir = join(tempDir, 'voice-inbox');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'ledger.sqlite');
  const db = new Database(path);
  db.exec(`CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    request_text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    conversation_id TEXT NOT NULL DEFAULT ''
  )`);
  const ins = db.prepare('INSERT INTO tasks (task_id, request_text, created_at, conversation_id) VALUES (?, ?, ?, ?)');
  rows.forEach((r, i) => ins.run(`vi-${i.toString(16).padStart(12, '0')}`, r.request_text, r.created_at, r.conversation_id));
  db.close();
  return path;
}

describe('readTurnContext — telegram store', () => {
  it('returns turns for the matching thread only, newest-first', () => {
    const archive = join(tempDir, 'archive.jsonl');
    writeFileSync(
      archive,
      [
        // Real archive turns carry `timestamp` (accepted; preferred over `at`).
        JSON.stringify({ role: 'user', text: 'hello', timestamp: '2026-09-18T08:00:00Z', thread_id: 5 }),
        JSON.stringify({ role: 'assistant', text: 'hi there', timestamp: '2026-09-18T08:01:00Z', thread_id: 5 }),
        JSON.stringify({ role: 'user', text: 'other thread', timestamp: '2026-09-18T08:02:00Z', thread_id: 7 }),
        JSON.stringify({ role: 'system', text: 'not a turn role', timestamp: '2026-09-18T08:03:00Z', thread_id: 5 }),
      ].join('\n') + '\n',
    );
    const ctx = readTurnContext('telegram', '5', CAPS, { telegramPath: () => archive });
    assert.ok(ctx);
    assert.deepEqual(
      ctx.priorTurns.map((t) => [t.role, t.text]),
      [
        ['assistant', 'hi there'],
        ['user', 'hello'],
      ],
    );
    // timestamp read into `at`
    assert.equal(ctx.priorTurns[0].at, '2026-09-18T08:01:00Z');
  });

  it('per-turn text truncated to 400 chars', () => {
    const archive = join(tempDir, 'archive.jsonl');
    writeFileSync(archive, JSON.stringify({ role: 'user', text: 'x'.repeat(1000), at: '2026-09-18T08:00:00Z', thread_id: 1 }) + '\n');
    const ctx = readTurnContext('telegram', '1', CAPS, { telegramPath: () => archive });
    assert.ok(ctx);
    assert.equal(ctx.priorTurns[0].text.length, 400);
  });

  it('digest capped to context_max_chars, oldest dropped first', () => {
    const archive = join(tempDir, 'archive.jsonl');
    // 6 turns x 400 chars = 2400 > 2000: one drop reaches the cap exactly.
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) {
      lines.push(JSON.stringify({ role: 'user', text: `t${i}`.padEnd(400, '.'), at: '', thread_id: 3 }));
    }
    writeFileSync(archive, lines.join('\n') + '\n');
    const ctx = readTurnContext('telegram', '3', CAPS, { telegramPath: () => archive });
    assert.ok(ctx);
    assert.equal(ctx.priorTurns.length, 5);
    assert.equal(ctx.priorTurns.at(-1)!.text, 't1'.padEnd(400, '.'));
    assert.equal(ctx.priorTurns[0].text, 't5'.padEnd(400, '.'));
    assert.ok(ctx.priorTurns.reduce((s, t) => s + t.text.length, 0) <= 2000);
  });

  it('missing archive file -> undefined (fail-open)', () => {
    const ctx = readTurnContext('telegram', '9', CAPS, { telegramPath: () => join(tempDir, 'nope.jsonl') });
    assert.equal(ctx, undefined);
  });

  it('malformed lines skipped; non-numeric key -> undefined', () => {
    const archive = join(tempDir, 'archive.jsonl');
    writeFileSync(
      archive,
      'not json\n' + JSON.stringify({ role: 'user', text: 'kept', at: '', thread_id: 2 }) + '\n',
    );
    const ok = readTurnContext('telegram', '2', CAPS, { telegramPath: () => archive });
    assert.ok(ok);
    assert.equal(ok.priorTurns.length, 1);
    const bad = readTurnContext('telegram', 'abc', CAPS, { telegramPath: () => archive });
    assert.equal(bad, undefined);
  });

  it('READ-ONLY: archive mtime + sha unchanged after readTurnContext', () => {
    const archive = join(tempDir, 'archive.jsonl');
    const body = JSON.stringify({ role: 'user', text: 'readonly', at: '', thread_id: 11 }) + '\n';
    writeFileSync(archive, body);
    const before = {
      sha: createHash('sha256').update(statSync(archive).mtimeMs + body).digest('hex'),
      mtime: statSync(archive).mtimeMs,
    };
    readTurnContext('telegram', '11', CAPS, { telegramPath: () => archive });
    const after = statSync(archive);
    assert.equal(after.mtimeMs, before.mtime);
    assert.equal(createHash('sha256').update(after.mtimeMs + body).digest('hex'), before.sha);
  });

  it('incumbentWorker = the worker field on the NEWEST matching line (last wins, no early break)', () => {
    const archive = join(tempDir, 'archive.jsonl');
    writeFileSync(
      archive,
      [
        JSON.stringify({ role: 'user', text: 'q1', timestamp: '2026-09-18T08:00:00Z', thread_id: 5 }),
        JSON.stringify({ role: 'assistant', text: 'a1', timestamp: '2026-09-18T08:01:00Z', thread_id: 5, worker: 'agy' }),
        JSON.stringify({ role: 'user', text: 'q2', timestamp: '2026-09-18T08:02:00Z', thread_id: 5 }),
        // Lines without a worker field do NOT clear the incumbent.
        JSON.stringify({ role: 'assistant', text: 'a2', timestamp: '2026-09-18T08:03:00Z', thread_id: 5, worker: 'codex' }),
        // Other threads are ignored even when they carry a worker.
        JSON.stringify({ role: 'assistant', text: 'other', timestamp: '2026-09-18T08:04:00Z', thread_id: 7, worker: 'claude' }),
        // An EMPTY worker field is not an incumbent — the last non-empty wins.
        JSON.stringify({ role: 'assistant', text: 'a3', timestamp: '2026-09-18T08:05:00Z', thread_id: 5, worker: '' }),
        // The incumbent read is role-agnostic (spec: newest matching line
        // carrying a worker field) — even a non-turn-role line counts.
        JSON.stringify({ role: 'system', text: 'meta', timestamp: '2026-09-18T08:06:00Z', thread_id: 5, worker: 'devin' }),
      ].join('\n') + '\n',
    );
    const ctx = readTurnContext('telegram', '5', CAPS, { telegramPath: () => archive });
    assert.ok(ctx);
    assert.equal(ctx.incumbentWorker, 'devin');
  });

  it('no worker field anywhere -> incumbentWorker stays undefined', () => {
    const archive = join(tempDir, 'archive.jsonl');
    writeFileSync(archive, JSON.stringify({ role: 'user', text: 'hi', at: '', thread_id: 4 }) + '\n');
    const ctx = readTurnContext('telegram', '4', CAPS, { telegramPath: () => archive });
    assert.ok(ctx);
    assert.equal(ctx.incumbentWorker, undefined);
  });
});

describe('readTurnContext — voice-inbox store', () => {
  it('returns request_text rows by conversation_id, newest-first', () => {
    makeLedger([
      { request_text: 'first ask', created_at: '2026-09-18T08:00:00Z', conversation_id: 'vi-a' },
      { request_text: 'second ask', created_at: '2026-09-18T08:05:00Z', conversation_id: 'vi-a' },
      { request_text: 'other conv', created_at: '2026-09-18T08:06:00Z', conversation_id: 'vi-b' },
    ]);
    const ctx = readTurnContext('voice-inbox', 'vi-a', CAPS);
    assert.ok(ctx);
    assert.deepEqual(
      ctx.priorTurns.map((t) => t.text),
      ['second ask', 'first ask'],
    );
  });

  it('READ-ONLY: ledger fixture mtime + sha unchanged after readTurnContext', () => {
    const path = makeLedger([
      { request_text: 'do not touch me', created_at: '2026-09-18T08:00:00Z', conversation_id: 'vi-ro' },
    ]);
    const readNow = () => readFileSync(path);
    const beforeSha = createHash('sha256').update(readNow()).digest('hex');
    const beforeMtime = statSync(path).mtimeMs;
    readTurnContext('voice-inbox', 'vi-ro', CAPS);
    const after = statSync(path);
    assert.equal(after.mtimeMs, beforeMtime);
    assert.equal(createHash('sha256').update(readNow()).digest('hex'), beforeSha);
  });

  it('missing ledger -> undefined (fail-open, fileMustExist)', () => {
    mkdirSync(join(tempDir, 'voice-inbox'), { recursive: true });
    const ctx = readTurnContext('voice-inbox', 'vi-x', CAPS);
    assert.equal(ctx, undefined);
  });

  it('caps digest to context_max_chars, oldest dropped first', () => {
    makeLedger([
      { request_text: 'a'.repeat(400), created_at: '2026-09-18T08:00:00Z', conversation_id: 'vi-cap' },
      { request_text: 'b'.repeat(400), created_at: '2026-09-18T08:01:00Z', conversation_id: 'vi-cap' },
      { request_text: 'c'.repeat(400), created_at: '2026-09-18T08:02:00Z', conversation_id: 'vi-cap' },
      { request_text: 'd'.repeat(400), created_at: '2026-09-18T08:03:00Z', conversation_id: 'vi-cap' },
      { request_text: 'e'.repeat(400), created_at: '2026-09-18T08:04:00Z', conversation_id: 'vi-cap' },
      { request_text: 'f'.repeat(400), created_at: '2026-09-18T08:05:00Z', conversation_id: 'vi-cap' },
    ]);
    const ctx = readTurnContext('voice-inbox', 'vi-cap', CAPS);
    assert.ok(ctx);
    assert.equal(ctx.priorTurns.length, 5);
    assert.ok(ctx.priorTurns.reduce((s, t) => s + t.text.length, 0) <= 2000);
    assert.equal(ctx.priorTurns[0].text, 'f'.repeat(400));
    assert.equal(ctx.priorTurns.at(-1)!.text, 'b'.repeat(400));
  });

  it('uses deps.openSqlite seam', () => {
    makeLedger([
      { request_text: 'seam check', created_at: '2026-09-18T08:00:00Z', conversation_id: 'vi-s' },
    ]);
    let openedWith: string | undefined;
    const ctx = readTurnContext('voice-inbox', 'vi-s', CAPS, {
      openSqlite: (p) => {
        openedWith = p;
        return new Database(p, { readonly: true, fileMustExist: true });
      },
    });
    assert.ok(ctx);
    assert.equal(ctx.priorTurns[0].text, 'seam check');
    assert.ok(openedWith!.endsWith(join('voice-inbox', 'ledger.sqlite')));
  });

  it('incumbentWorker = the NEWEST non-empty worker_cli (v15, spec correction 1)', () => {
    makeLedger([
      // Newest-first in SQL; the first CARRYING row wins and rows without a
      // worker_cli do not clear it.
      { request_text: 'newest, empty worker', created_at: '2026-09-18T08:30:00Z', conversation_id: 'vi-inc', worker_cli: '' },
      { request_text: 'carries codex', created_at: '2026-09-18T08:20:00Z', conversation_id: 'vi-inc', worker_cli: 'codex' },
      { request_text: 'null worker', created_at: '2026-09-18T08:10:00Z', conversation_id: 'vi-inc', worker_cli: null },
      { request_text: 'carries agy', created_at: '2026-09-18T08:00:00Z', conversation_id: 'vi-inc', worker_cli: 'agy' },
    ]);
    const ctx = readTurnContext('voice-inbox', 'vi-inc', CAPS);
    assert.ok(ctx);
    assert.equal(ctx.incumbentWorker, 'codex');
  });

  it('no worker_cli anywhere -> incumbentWorker stays undefined', () => {
    makeLedger([
      { request_text: 'plain', created_at: '2026-09-18T08:00:00Z', conversation_id: 'vi-noinc' },
    ]);
    const ctx = readTurnContext('voice-inbox', 'vi-noinc', CAPS);
    assert.ok(ctx);
    assert.equal(ctx.incumbentWorker, undefined);
  });

  it('pre-v15 ledger (no worker_cli column) -> undefined, fail-open not a crash', () => {
    // Known-bad fixture first proven to FAIL the query (2026-09-09 rule): the
    // same fixture shape WITH the column returns values (tested above), so the
    // reader discriminates the two shapes rather than answering identically.
    makePreV15Ledger([
      { request_text: 'old shape', created_at: '2026-09-18T08:00:00Z', conversation_id: 'vi-v14' },
    ]);
    const ctx = readTurnContext('voice-inbox', 'vi-v14', CAPS);
    assert.equal(ctx, undefined);
  });
});
