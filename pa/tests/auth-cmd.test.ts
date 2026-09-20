/**
 * `pa auth` CLI tests (auth broker Phase A, 2026-09-10 build spec, WP-D).
 * `authCommand()` is called in-process with an injected `loadVoiceInboxModules`
 * (D10: no pa test ever touches the real projects/voice-inbox/dist) backed by
 * a real in-memory better-sqlite3 database implementing just enough of the
 * ledger's surface (tenants/tasks/input_requests) for these CLI paths.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createTempPaHome, cleanup } from './helpers.js';
import { authCommand, type AuthCommandDeps } from '../src/commands/auth.js';
import { writeRow, type AuthRequestRow } from '../src/lib/auth/store.js';

const SENTINEL_VALUE = 'zqx-CANARY-9f31a7-value';

function splitTopicKey(key: string): { chatId: number; threadId: number } | undefined {
  const m = /^(-?\d+)_(\d+)$/.exec(key);
  if (!m) return undefined;
  return { chatId: Number(m[1]), threadId: Number(m[2]) };
}

/** Minimal fake voice-inbox ledger, backed by a real in-memory sqlite db —
 * just enough surface for the `pa auth` CLI paths under test. */
function openFakeLedger(path: string): any {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (tenant_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      state TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      routed_to TEXT,
      worker_resource TEXT
    );
    CREATE TABLE IF NOT EXISTS input_requests (
      request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT NOT NULL,
      params_json TEXT NOT NULL,
      status TEXT NOT NULL,
      answer_pointer TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT
    );
  `);
  return db;
}

let taskCounter = 0;
let requestCounter = 0;

function fakeLedgerModule() {
  function getTask(db: any, tenantId: string, taskId: string): any {
    return db.prepare('SELECT * FROM tasks WHERE task_id = ? AND tenant_id = ?').get(taskId, tenantId);
  }
  function getInputRequest(db: any, tenantId: string, taskId: string, requestId: string): any {
    return db
      .prepare('SELECT * FROM input_requests WHERE request_id = ? AND task_id = ? AND tenant_id = ?')
      .get(requestId, taskId, tenantId);
  }
  return {
    openLedger: (path: string) => openFakeLedger(path),
    createTask(db: any, tenantId: string, input: any): any {
      const taskId = `vi-task${String(++taskCounter).padStart(6, '0')}`;
      const conversationId = input.conversationId ?? taskId;
      db.prepare('INSERT INTO tasks (task_id, tenant_id, state, conversation_id) VALUES (?,?,?,?)').run(
        taskId,
        tenantId,
        'received',
        conversationId
      );
      return getTask(db, tenantId, taskId);
    },
    getTask,
    transitionTask(db: any, tenantId: string, taskId: string, toState: string, input: any): any {
      db.prepare('UPDATE tasks SET state = ?, routed_to = COALESCE(?, routed_to) WHERE task_id = ? AND tenant_id = ?').run(
        toState,
        input.routedTo ?? null,
        taskId,
        tenantId
      );
      return { task: getTask(db, tenantId, taskId), event: { kind: input.eventKind } };
    },
    createInputRequest(db: any, tenantId: string, taskId: string, input: any): any {
      const requestId = `ir-req${String(++requestCounter).padStart(6, '0')}`;
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO input_requests (request_id, task_id, tenant_id, kind, prompt, params_json, status, created_at) VALUES (?,?,?,?,?,?,?,?)'
      ).run(requestId, taskId, tenantId, input.kind, input.prompt, JSON.stringify(input.params ?? {}), 'pending', now);
      db.prepare("UPDATE tasks SET state = 'awaiting_input' WHERE task_id = ? AND tenant_id = ?").run(taskId, tenantId);
      return {
        request: getInputRequest(db, tenantId, taskId, requestId),
        task: getTask(db, tenantId, taskId),
        event: { kind: 'task.input_needed' },
      };
    },
    getInputRequest,
  };
}

function fakeConfigModule(): any {
  return {
    ledgerPath: () => ':memory:',
    routeQueuePath: () => join(process.env.PA_HOME as string, 'route-queue.jsonl'),
    answersDir: () => join(process.env.PA_HOME as string, 'answers'),
    splitTopicKey,
  };
}

function fakeBridgeWriterModule(): any {
  return {
    buildAnswerPointerText: (input: { requestId: string; answerPointer: string }) =>
      `Answer for ${input.requestId} is at ${input.answerPointer} — read it; never repeat its value in chat.`,
    appendRouteEntry: async () => ({ q_id: 'rq-test', ref_id: 's-test' }),
  };
}

function fakeAnswerResumeModule(): any {
  return {
    answerAndResume: async (db: any, tenantId: string, taskId: string, requestId: string, answer: any, deps: any) => {
      let pointer: string | null = null;
      if (answer.kind === 'value') {
        const dir = join(deps.answersDir, taskId);
        mkdirSync(dir, { recursive: true });
        pointer = join(dir, `${requestId}.txt`);
        writeFileSync(pointer, answer.value, 'utf8');
      } else {
        pointer = answer.pointer;
      }
      db.prepare(
        "UPDATE input_requests SET status = 'answered', answer_pointer = ?, answered_at = ? WHERE request_id = ? AND tenant_id = ?"
      ).run(pointer, new Date().toISOString(), requestId, tenantId);
      db.prepare("UPDATE tasks SET state = 'running' WHERE task_id = ? AND tenant_id = ?").run(taskId, tenantId);
      return { request: {}, task: {}, steer_queued: false };
    },
  };
}

function testDeps(): Partial<AuthCommandDeps> {
  return {
    repoRootFn: async () => '/fake/repo',
    loadVoiceInboxModules: async () => ({
      ledger: fakeLedgerModule(),
      config: fakeConfigModule(),
      bridgeWriter: fakeBridgeWriterModule(),
      answerResume: fakeAnswerResumeModule(),
    }),
  };
}

let dir: string;
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;

function stdinDepsWith(text: string): Partial<AuthCommandDeps> {
  return { readStdin: async () => text };
}

describe('pa auth — subcommands, exit codes, and value silence', () => {
  beforeEach(async () => {
    dir = await createTempPaHome();
    taskCounter = 0;
    requestCounter = 0;
    logs = [];
    errs = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]) => {
      errs.push(args.map(String).join(' '));
    };
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    delete process.env.PA_AUTH_TENANT;
    await cleanup(dir);
  });

  it('rejects an unknown flag with exit 2 and the usage block on stderr', async () => {
    const code = await authCommand(['request', '--bogus', 'x'], testDeps());
    assert.equal(code, 2);
    assert.ok(errs.some((l) => l.includes('Usage:')));
    assert.ok(errs.some((l) => l.includes('Unrecognized option')));
  });

  it('rejects an unknown subcommand with exit 2', async () => {
    const code = await authCommand(['bogus-sub'], testDeps());
    assert.equal(code, 2);
    assert.ok(errs.some((l) => l.includes('Usage:')));
  });

  it('rejects an invalid --shape with exit 2', async () => {
    const code = await authCommand(['request', '--shape', 'S9', '--provider', 'google'], testDeps());
    assert.equal(code, 2);
  });

  it('exits 3 when the tenant cannot be resolved', async () => {
    // Zero tenant rows, no --tenant, no PA_AUTH_TENANT.
    const code = await authCommand(
      ['request', '--shape', 'S4', '--provider', 'some-api', '--prompt', 'enter the key'],
      testDeps()
    );
    assert.equal(code, 3);
    assert.ok(errs.some((l) => l.includes('cannot resolve a tenant')));
  });

  it('a happy request --shape S4 exits 0 and prints one §3.8 JSON line', async () => {
    const code = await authCommand(
      ['request', '--shape', 'S4', '--provider', 'some-api', '--tenant', 't-happy01', '--prompt', 'enter the key', '--json'],
      testDeps()
    );
    assert.equal(code, 0);
    assert.equal(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assert.equal(parsed.ok, true);
    assert.match(parsed.request_id, /^ir-/);
    assert.match(parsed.task_id, /^vi-/);
    assert.equal(parsed.shape, 'S4');
    assert.equal(parsed.provider, 'some-api');
    assert.ok(typeof parsed.expires_at === 'string' && parsed.expires_at.length > 0);
  });

  it('wait on an answered secret request exits 0 with a pointer line, never the sentinel value', async () => {
    // Set up: a task + an already-answered secret input request, plus its
    // broker row (as `pa auth request` would have written it). File-backed
    // (not :memory:) because this test calls authCommand TWICE and each
    // real invocation opens-then-closes its own connection (matching
    // production lifecycle) — an in-memory db would lose its data on the
    // first call's close().
    const deps = testDeps();
    const modules = await (deps.loadVoiceInboxModules as any)('/fake/repo');
    const ledgerFile = join(dir, 'voice-inbox', 'ledger.sqlite');
    mkdirSync(join(dir, 'voice-inbox'), { recursive: true });
    const db = modules.ledger.openLedger(ledgerFile);
    const tenantId = 't-wait0001';
    db.prepare('INSERT INTO tenants (tenant_id) VALUES (?)').run(tenantId);
    const task = modules.ledger.createTask(db, tenantId, { source: 'text', requestText: 'x' });
    const created = modules.ledger.createInputRequest(db, tenantId, task.task_id, {
      kind: 'secret',
      prompt: 'enter the key',
      params: {},
    });
    const answerDir = join(dir, 'voice-inbox', 'answers', task.task_id);
    mkdirSync(answerDir, { recursive: true });
    const pointer = join(answerDir, `${created.request.request_id}.txt`);
    writeFileSync(pointer, SENTINEL_VALUE, 'utf8');
    db.prepare("UPDATE input_requests SET status = 'answered', answer_pointer = ?, answered_at = ? WHERE request_id = ?").run(
      pointer,
      new Date().toISOString(),
      created.request.request_id
    );

    const row: AuthRequestRow = {
      request_id: created.request.request_id,
      task_id: task.task_id,
      tenant_id: tenantId,
      shape: 'S4',
      provider: 'some-api',
      kind: 'secret',
      status: 'pending',
      created_at: created.request.created_at,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      state: null,
      code_verifier: null,
      redirect_uri: null,
      auth_id: null,
      answer_pointer: null,
      delivered_at: null,
    };
    writeRow(row);
    db.close(); // release the setup connection — the command opens its own, exactly as production does

    // Each invocation opens (and closes) its OWN connection to the same
    // on-disk file, exactly like production — required because this test
    // calls authCommand twice.
    const fixedDeps: Partial<AuthCommandDeps> = {
      repoRootFn: async () => '/fake/repo',
      loadVoiceInboxModules: async () => ({
        ledger: modules.ledger,
        config: { ...modules.config, ledgerPath: () => ledgerFile },
        bridgeWriter: modules.bridgeWriter,
        answerResume: modules.answerResume,
      }),
    };

    const code = await authCommand(['wait', created.request.request_id, '--json'], fixedDeps);
    assert.equal(code, 0);
    assert.equal(logs.length, 1);
    assert.ok(logs[0].includes('"pointer"'));
    assert.ok(!logs[0].includes(SENTINEL_VALUE));

    // Known-bad case (value-silence, per the WP-D dispatch note): prove the
    // exact predicate above (`!logs[0].includes(SENTINEL_VALUE)`) is capable
    // of failing — feed it a line that DOES leak the value, the way a buggy
    // `buildAnsweredResult` (one that echoed the file's contents for the
    // `secret` kind instead of just its pointer) would produce.
    const leakedLine = JSON.stringify({ ok: true, status: 'answered', kind: 'secret', value: SENTINEL_VALUE });
    assert.ok(leakedLine.includes(SENTINEL_VALUE));
    assert.equal(!leakedLine.includes(SENTINEL_VALUE), false); // the real assertion's form, on a leaky line, is false

    // Same value-silence property for the human (non-JSON) rendering path,
    // which goes through buildAnswerPointerText (§3.7(b)) instead.
    logs.length = 0;
    const humanCode = await authCommand(['wait', created.request.request_id], fixedDeps);
    assert.equal(humanCode, 0);
    assert.equal(logs.length, 1);
    assert.ok(!logs[0].includes(SENTINEL_VALUE));
    assert.ok(logs[0].includes(created.request.request_id));
  });

  it('wait past --timeout 0 exits 4 with the exact timeout JSON', async () => {
    const deps = testDeps();
    const modules = await (deps.loadVoiceInboxModules as any)('/fake/repo');
    const db = modules.ledger.openLedger(':memory:');
    const tenantId = 't-wait0002';
    db.prepare('INSERT INTO tenants (tenant_id) VALUES (?)').run(tenantId);
    const task = modules.ledger.createTask(db, tenantId, { source: 'text', requestText: 'x' });
    const created = modules.ledger.createInputRequest(db, tenantId, task.task_id, {
      kind: 'secret',
      prompt: 'enter the key',
      params: {},
    });

    const row: AuthRequestRow = {
      request_id: created.request.request_id,
      task_id: task.task_id,
      tenant_id: tenantId,
      shape: 'S4',
      provider: 'some-api',
      kind: 'secret',
      status: 'pending',
      created_at: created.request.created_at,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      state: null,
      code_verifier: null,
      redirect_uri: null,
      auth_id: null,
      answer_pointer: null,
      delivered_at: null,
    };
    writeRow(row);

    const fixedDeps: Partial<AuthCommandDeps> = {
      repoRootFn: async () => '/fake/repo',
      loadVoiceInboxModules: async () => ({
        ledger: { ...modules.ledger, openLedger: () => db },
        config: modules.config,
        bridgeWriter: modules.bridgeWriter,
        answerResume: modules.answerResume,
      }),
    };

    const code = await authCommand(['wait', created.request.request_id, '--timeout', '0', '--json'], fixedDeps);
    assert.equal(code, 4);
    assert.equal(logs.length, 1);
    assert.deepEqual(JSON.parse(logs[0]), { ok: false, status: 'timeout' });
  });

  it('wait on an expired broker row exits 4 with the exact expired JSON', async () => {
    const deps = testDeps();
    const modules = await (deps.loadVoiceInboxModules as any)('/fake/repo');
    const db = modules.ledger.openLedger(':memory:');
    const tenantId = 't-wait0003';
    db.prepare('INSERT INTO tenants (tenant_id) VALUES (?)').run(tenantId);
    const task = modules.ledger.createTask(db, tenantId, { source: 'text', requestText: 'x' });
    const created = modules.ledger.createInputRequest(db, tenantId, task.task_id, {
      kind: 'secret',
      prompt: 'enter the key',
      params: {},
    });

    const row: AuthRequestRow = {
      request_id: created.request.request_id,
      task_id: task.task_id,
      tenant_id: tenantId,
      shape: 'S4',
      provider: 'some-api',
      kind: 'secret',
      status: 'pending',
      created_at: created.request.created_at,
      expires_at: new Date(Date.now() - 1000).toISOString(), // already past
      state: null,
      code_verifier: null,
      redirect_uri: null,
      auth_id: null,
      answer_pointer: null,
      delivered_at: null,
    };
    writeRow(row);

    const fixedDeps: Partial<AuthCommandDeps> = {
      repoRootFn: async () => '/fake/repo',
      loadVoiceInboxModules: async () => ({
        ledger: { ...modules.ledger, openLedger: () => db },
        config: modules.config,
        bridgeWriter: modules.bridgeWriter,
        answerResume: modules.answerResume,
      }),
    };

    const code = await authCommand(['wait', created.request.request_id, '--timeout', '300', '--json'], fixedDeps);
    assert.equal(code, 4);
    assert.equal(logs.length, 1);
    assert.deepEqual(JSON.parse(logs[0]), { ok: false, status: 'expired' });
  });

  it('answer with empty stdin exits 3', async () => {
    const code = await authCommand(
      ['answer', '--request', 'ir-doesnotexist0'],
      { ...testDeps(), ...stdinDepsWith('') }
    );
    assert.equal(code, 3);
    assert.ok(errs.some((l) => l.includes('no value on stdin')));
  });
});
