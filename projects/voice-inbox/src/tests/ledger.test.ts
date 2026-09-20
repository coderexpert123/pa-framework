/**
 * Ledger tests (AI-201 WP-A): schema migration, id formats, the FULL task
 * state-machine matrix (every illegal transition rejected, state untouched),
 * tenant isolation (tenant B never reads or writes tenant A), and the input
 * request lifecycle including the answer-pointer rule (the ledger never
 * stores an answer value).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LedgerError,
  TASK_STATES,
  TASK_TRANSITIONS,
  answerInputRequest,
  appendEvent,
  createInputRequest,
  createTask,
  getActiveConversationShare,
  getConversationMeta,
  getTask,
  getTenant,
  getTenantByTelegramUser,
  getInputRequest,
  LEDGER_SCHEMA_SQL,
  listEvents,
  listInputRequests,
  listTasks,
  makeRefId,
  mintConversationShare,
  mintRequestId,
  mintTaskId,
  openLedger,
  resolveConversationShareToken,
  revokeConversationShare,
  setConversationMeta,
  setConversationViewed,
  setTaskMessageId,
  summarizeConversationById,
  tenantIdForTelegramUser,
  transitionTask,
  upsertTenant,
  type TaskState,
} from '../ledger.js';
import { TASK_EVENT_KINDS } from '../contracts.js';
import type { TaskEventKind } from '../contracts.js';

const T_A = tenantIdForTelegramUser(111);
const T_B = tenantIdForTelegramUser(222);

/** A minimal valid request body, reused across suites. */
const VALID_REQUEST = { kind: 'secret', prompt: 'API key?', params: {} };

/** The paired event kind for each target state (§3 state-machine table).
 * `received` is a transition target since schema v2: the transcription
 * write-back lands there carrying `task.transcribed` (§1.3). */
const KIND_FOR_TARGET: Record<TaskState, TaskEventKind> = {
  received: 'task.transcribed',
  transcribing: 'task.transcribed',
  routed: 'task.routed',
  running: 'task.progress',
  awaiting_input: 'task.input_needed',
  transcribe_failed: 'task.failed',
  done: 'task.completed',
  failed: 'task.failed',
  cancelled: 'task.cancelled',
};

/** Canonical path from `received` to each state, using only legal moves.
 * `transcribing`/`transcribe_failed` are INSERT-only entry points — no
 * transition targets `transcribing`, so `driveTo` below seeds them
 * directly instead of walking PATH_TO. */
const PATH_TO: Record<TaskState, TaskState[]> = {
  received: [],
  transcribing: [],
  routed: ['routed'],
  running: ['routed', 'running'],
  awaiting_input: ['routed', 'running', 'awaiting_input'],
  transcribe_failed: [],
  done: ['routed', 'running', 'done'],
  failed: ['failed'],
  cancelled: ['cancelled'],
};

/** Create a task already at `transcribing` (the voice INSERT path). */
function seedTranscribing(fixture: LedgerFixture, tenantId: string): string {
  return createTask(fixture.db, tenantId, {
    source: 'voice',
    initialState: 'transcribing',
    requestText: '(voice recording)',
  }).task_id;
}

/** Drive a task to `from` using only legal moves (INSERT for the transcribing
 * family, transitions for everything else). */
function driveTo(fixture: LedgerFixture, tenantId: string, from: TaskState): string {
  if (from === 'transcribing' || from === 'transcribe_failed') {
    const taskId = seedTranscribing(fixture, tenantId);
    if (from === 'transcribe_failed') {
      transitionTask(fixture.db, tenantId, taskId, 'transcribe_failed', {
        eventKind: 'task.failed',
        eventPayload: { reason: 'test seed' },
      });
    }
    return taskId;
  }
  const taskId = freshTask(fixture, tenantId);
  for (const step of PATH_TO[from]) {
    transitionTask(fixture.db, tenantId, taskId, step as TaskState, { eventKind: KIND_FOR_TARGET[step] });
  }
  return taskId;
}

interface LedgerFixture {
  db: ReturnType<typeof openLedger>;
  dir: string;
  cleanup: () => void;
}

function makeLedger(): LedgerFixture {
  const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-ledger-'));
  const db = openLedger(join(dir, 'ledger.sqlite'));
  upsertTenant(db, { telegramUserId: 111, telegramChatId: -100111, displayName: 'Tenant A' });
  upsertTenant(db, { telegramUserId: 222, telegramChatId: -100222, displayName: 'Tenant B' });
  return {
    db,
    dir,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function freshTask(fixture: LedgerFixture, tenantId: string, text = 'please summarize the report'): string {
  return createTask(fixture.db, tenantId, { source: 'text', requestText: text }).task_id;
}

function throwsLedger(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof LedgerError && err.code === code);
}

describe('openLedger — schema v4 migration', () => {
  it('creates all tables and indexes with user_version = 16 and WAL', () => {
    const f = makeLedger();
    try {
      assert.equal(f.db.pragma('user_version', { simple: true }), 16);
      assert.equal(String(f.db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
      const names = new Set(
        (f.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as { name: string }[])
          .map((r) => r.name)
      );
      for (const expected of [
        'tenants',
        'tasks',
        'input_requests',
        'events',
        'sessions',
        'pairing_codes',
        'conversation_meta',
        'conversation_shares',
        'tasks_tenant_created',
        'inputs_task_status',
        'events_task_ts',
        'conversation_shares_lookup',
      ]) {
        assert.ok(names.has(expected), `missing table/index ${expected}`);
      }
      // C10 column-order pin (covering the v3/v4 columns, the v15
      // provenance tail and the v16 routing-metadata tail), on a FRESHLY
      // created ledger.
      const columns = (f.db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
      assert.deepEqual(
        columns.slice(-21),
        ['conversation_id', 'worker_resource', 'worker_dispatch_id', 'steer_mode', 'feedback_about', 'result_short', 'suggested_items', 'tg_message_id', 'result_structured', 'surface', 'retried_by', 'worker_cli', 'worker_model', 'worker_effort', 'router_decision', 'router_placement', 'router_target', 'router_steer', 'router_steer_by', 'router_effort_proj', 'router_failovers']
      );
    } finally {
      f.cleanup();
    }
  });

  it('re-opening is idempotent: user_version stays 16 and data survives', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      f.db.close();
      const reopened = openLedger(join(f.dir, 'ledger.sqlite'));
      assert.equal(reopened.pragma('user_version', { simple: true }), 16);
      assert.ok(getTask(reopened, T_A, taskId));
      reopened.close();
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe('schema v16 — routing metadata columns', () => {
  const ROUTER_COLUMNS = [
    'router_decision',
    'router_placement',
    'router_target',
    'router_steer',
    'router_steer_by',
    'router_effort_proj',
    'router_failovers',
  ];

  it('fresh LEDGER_SCHEMA_SQL carries all seven router_* columns on tasks, after worker_effort', () => {
    const tasksBody = LEDGER_SCHEMA_SQL.slice(
      LEDGER_SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS tasks'),
      LEDGER_SCHEMA_SQL.indexOf('CREATE INDEX IF NOT EXISTS tasks_tenant_created')
    );
    for (const col of ROUTER_COLUMNS) {
      assert.ok(new RegExp(`\\b${col}\\s+(TEXT|INTEGER)`).test(tasksBody), `LEDGER_SCHEMA_SQL missing ${col}`);
    }
    assert.ok(
      tasksBody.indexOf('router_decision') > tasksBody.indexOf('worker_effort'),
      'v16 columns must sit after the v15 provenance tail'
    );
  });

  it('migrates a hand-built v15 file: seven router_* columns added, user_version 16, old rows read NULL, idempotent on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-ledger-v15-'));
    const dbPath = join(dir, 'ledger.sqlite');
    {
      const v15 = new Database(dbPath);
      v15.pragma('busy_timeout = 3000');
      // The v15-era schema: the current tasks table minus the six v16 columns.
      v15.exec(`CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id INTEGER NOT NULL,
  display_name     TEXT,
  created_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  source         TEXT NOT NULL CHECK (source IN ('voice','text')),
  transcript     TEXT,
  request_text   TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('received','transcribing','routed','running','awaiting_input','transcribe_failed','done','failed','cancelled')),
  routed_to      TEXT,
  routing_reason TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  worker_resource TEXT,
  worker_dispatch_id TEXT,
  steer_mode      TEXT,
  feedback_about  TEXT,
  result_short    TEXT,
  suggested_items TEXT,
  tg_message_id   INTEGER,
  result_structured TEXT,
  surface        TEXT,
  retried_by     TEXT,
  worker_cli      TEXT,
  worker_model    TEXT,
  worker_effort   TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('task.received','task.routed','task.progress','task.input_needed',
                  'task.input_received','task.result_ready','task.completed',
                  'task.failed','task.cancelled','task.rerouted','task.transcribed')),
  summary      TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts           TEXT NOT NULL
);`);
      v15.pragma('user_version = 15');
      v15.prepare(
        `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
         VALUES ('t-1515', 1515, -1001515, 'Tenant V15', '2026-09-01T00:00:00.000Z')`
      ).run();
      v15.prepare(
        `INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text, state, created_at, updated_at)
         VALUES ('vi-000000000015', 't-1515', 'text', NULL, 'v15 request', 'done', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`
      ).run();
      v15.close();
    }
    const db = openLedger(dbPath);
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 16);
      const columnNames = (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
      const columns = new Set(columnNames);
      for (const col of ROUTER_COLUMNS) {
        assert.ok(columns.has(col), `missing ${col}`);
      }
      // Migrated tail matches a fresh ledger's column tail, in order.
      assert.deepEqual(
        columnNames.slice(-7),
        ['router_decision', 'router_placement', 'router_target', 'router_steer', 'router_steer_by', 'router_effort_proj', 'router_failovers']
      );
      // Old rows read NULL — fail-open for every pre-v16 consumer.
      const task = getTask(db, 't-1515', 'vi-000000000015');
      assert.ok(task);
      assert.equal(task.router_decision, null);
      assert.equal(task.router_placement, null);
      assert.equal(task.router_target, null);
      assert.equal(task.router_steer, null);
      assert.equal(task.router_steer_by, null);
      assert.equal(task.router_effort_proj, null);
      assert.equal(task.router_failovers, null);
    } finally {
      db.close();
    }
    const reopened = openLedger(dbPath);
    try {
      assert.equal(reopened.pragma('user_version', { simple: true }), 16);
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('schema v4', () => {
  it('fresh open accepts transcribing / transcribe_failed / task.transcribed rows', () => {
    const f = makeLedger();
    try {
      const taskId = seedTranscribing(f, T_A);
      assert.equal(getTask(f.db, T_A, taskId)?.state, 'transcribing');
      appendEvent(f.db, T_A, taskId, 'task.transcribed', { payload: { chars: 5 } });
      const { task } = transitionTask(f.db, T_A, taskId, 'transcribe_failed', {
        eventKind: 'task.failed',
        eventPayload: { reason: 'no engine' },
      });
      assert.equal(task.state, 'transcribe_failed');
    } finally {
      f.cleanup();
    }
  });

  it('rebuilds a v1 ledger to v3: rows and event ids survive, new events continue at max+1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-ledger-v1-'));
    const dbPath = join(dir, 'ledger.sqlite');
    const KNOWN_EVENT_ID = 500;
    {
      const v1 = new Database(dbPath);
      v1.pragma('busy_timeout = 3000');
      v1.exec(`CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id INTEGER NOT NULL,
  display_name     TEXT,
  created_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  source         TEXT NOT NULL CHECK (source IN ('voice','text')),
  transcript     TEXT,
  request_text   TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('received','routed','running','awaiting_input','done','failed','cancelled')),
  routed_to      TEXT,
  routing_reason TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('task.received','task.routed','task.progress','task.input_needed',
                  'task.input_received','task.result_ready','task.completed',
                  'task.failed','task.cancelled','task.rerouted')),
  summary      TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts           TEXT NOT NULL
);`);
      v1.pragma('user_version = 1');
      v1.prepare(
        `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
         VALUES ('t-111', 111, -100111, 'Tenant A', '2026-09-01T00:00:00.000Z')`
      ).run();
      v1.prepare(
        `INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text, state, created_at, updated_at)
         VALUES ('vi-000000000001', 't-111', 'voice', NULL, 'old request', 'received', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`
      ).run();
      v1.prepare(
        `INSERT INTO events (event_id, tenant_id, task_id, ref_id, kind, summary, payload_json, ts)
         VALUES (?, 't-111', 'vi-000000000001', 's-000000000001', 'task.received', NULL, '{}', '2026-09-01T00:00:00.000Z')`
      ).run(KNOWN_EVENT_ID);
      v1.close();
    }
    const db = openLedger(dbPath);
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 16);
      const task = getTask(db, 't-111', 'vi-000000000001');
      assert.ok(task);
      assert.equal(task.state, 'received');
      // v3 backfill: a legacy row with no conversation_id is self-rooted.
      assert.equal(task.conversation_id, 'vi-000000000001');
      assert.equal(task.worker_resource, null);
      // v4 additive columns: a pre-v4 row was never recorded as a steer and
      // never captured a dispatch identity, and NULL says exactly that.
      assert.equal(task.worker_dispatch_id, null);
      assert.equal(task.steer_mode, null);
      const events = listEvents(db, 't-111', 'vi-000000000001');
      assert.equal(events.length, 1);
      assert.equal(events[0].event_id, KNOWN_EVENT_ID);
      const fresh = appendEvent(db, 't-111', 'vi-000000000001', 'task.result_ready', {});
      assert.equal(fresh.event_id, KNOWN_EVENT_ID + 1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates a hand-built v2 file (no v3 columns) and backfills conversation_id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-ledger-v2-'));
    const dbPath = join(dir, 'ledger.sqlite');
    {
      const v2 = new Database(dbPath);
      v2.pragma('busy_timeout = 3000');
      // The current LEDGER_SCHEMA_SQL's tasks table, minus the two v3 columns.
      v2.exec(`CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id INTEGER NOT NULL,
  display_name     TEXT,
  created_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  source         TEXT NOT NULL CHECK (source IN ('voice','text')),
  transcript     TEXT,
  request_text   TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('received','transcribing','routed','running','awaiting_input','transcribe_failed','done','failed','cancelled')),
  routed_to      TEXT,
  routing_reason TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('task.received','task.routed','task.progress','task.input_needed',
                  'task.input_received','task.result_ready','task.completed',
                  'task.failed','task.cancelled','task.rerouted','task.transcribed')),
  summary      TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts           TEXT NOT NULL
);`);
      v2.pragma('user_version = 2');
      v2.prepare(
        `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
         VALUES ('t-222', 222, -100222, 'Tenant B', '2026-09-01T00:00:00.000Z')`
      ).run();
      v2.prepare(
        `INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text, state, created_at, updated_at)
         VALUES ('vi-000000000002', 't-222', 'text', NULL, 'v2 request', 'received', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`
      ).run();
      v2.close();
    }
    const db = openLedger(dbPath);
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 16);
      const columnNames = (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
      const columns = new Set(columnNames);
      assert.ok(columns.has('conversation_id'));
      assert.ok(columns.has('worker_resource'));
      assert.ok(columns.has('worker_dispatch_id'));
      assert.ok(columns.has('steer_mode'));
      assert.ok(columns.has('worker_cli'));
      assert.ok(columns.has('worker_model'));
      assert.ok(columns.has('worker_effort'));
      // C10 column-order pin (covering the v3/v4 columns, the v15
      // provenance tail and the v16 routing-metadata tail), on a MIGRATED
      // ledger.
      assert.deepEqual(
        columnNames.slice(-21),
        ['conversation_id', 'worker_resource', 'worker_dispatch_id', 'steer_mode', 'feedback_about', 'result_short', 'suggested_items', 'tg_message_id', 'result_structured', 'surface', 'retried_by', 'worker_cli', 'worker_model', 'worker_effort', 'router_decision', 'router_placement', 'router_target', 'router_steer', 'router_steer_by', 'router_effort_proj', 'router_failovers']
      );
      const task = getTask(db, 't-222', 'vi-000000000002');
      assert.ok(task);
      assert.equal(task.conversation_id, 'vi-000000000002');
      assert.equal(task.worker_resource, null);
      assert.equal(task.worker_dispatch_id, null);
      assert.equal(task.steer_mode, null);
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE conversation_id = ''").get() as { n: number }).n,
        0
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates a hand-built v3 file (no v4 columns) to v4: legacy row NULL in both new columns, idempotent on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-ledger-v3-'));
    const dbPath = join(dir, 'ledger.sqlite');
    {
      // The current LEDGER_SCHEMA_SQL's tasks table, minus the two v4 columns
      // (i.e. the actual v3 shape: conversation_id + worker_resource present).
      const v3 = new Database(dbPath);
      v3.pragma('busy_timeout = 3000');
      v3.exec(`CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id INTEGER NOT NULL,
  display_name     TEXT,
  created_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  source         TEXT NOT NULL CHECK (source IN ('voice','text')),
  transcript     TEXT,
  request_text   TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('received','transcribing','routed','running','awaiting_input','transcribe_failed','done','failed','cancelled')),
  routed_to      TEXT,
  routing_reason TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  worker_resource TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('task.received','task.routed','task.progress','task.input_needed',
                  'task.input_received','task.result_ready','task.completed',
                  'task.failed','task.cancelled','task.rerouted','task.transcribed')),
  summary      TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts           TEXT NOT NULL
);`);
      v3.pragma('user_version = 3');
      v3.prepare(
        `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
         VALUES ('t-333', 333, -100333, 'Tenant C', '2026-09-01T00:00:00.000Z')`
      ).run();
      v3.prepare(
        `INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text, state, created_at, updated_at, conversation_id, worker_resource)
         VALUES ('vi-000000000003', 't-333', 'text', NULL, 'v3 request', 'received', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'vi-000000000003', NULL)`
      ).run();
      v3.close();
    }
    const db = openLedger(dbPath);
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 16);
      const task = getTask(db, 't-333', 'vi-000000000003');
      assert.ok(task);
      assert.equal(task.worker_dispatch_id, null);
      assert.equal(task.steer_mode, null);
      // Second open is a no-op: same user_version, same row.
      db.close();
      const reopened = openLedger(dbPath);
      assert.equal(reopened.pragma('user_version', { simple: true }), 16);
      assert.deepEqual(getTask(reopened, 't-333', 'vi-000000000003'), task);
      reopened.close();
    } finally {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a second openLedger on the same file is a no-op (idempotent v3 migration)', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      const before = getTask(f.db, T_A, taskId);
      f.db.close();
      const reopened = openLedger(join(f.dir, 'ledger.sqlite'));
      assert.equal(reopened.pragma('user_version', { simple: true }), 16);
      const after = getTask(reopened, T_A, taskId);
      assert.deepEqual(after, before);
      assert.equal(
        (reopened.prepare("SELECT COUNT(*) AS n FROM tasks WHERE conversation_id = ''").get() as { n: number }).n,
        0
      );
      reopened.close();
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('createTask self-roots conversation_id by default and honors an explicit conversationId', () => {
    const f = makeLedger();
    try {
      const selfRooted = createTask(f.db, T_A, { source: 'text', requestText: 'self rooted' });
      assert.equal(selfRooted.conversation_id, selfRooted.task_id);
      assert.equal(selfRooted.worker_resource, null);

      const followUp = createTask(f.db, T_A, {
        source: 'text',
        requestText: 'a follow-up',
        conversationId: selfRooted.task_id,
      });
      assert.equal(followUp.conversation_id, selfRooted.task_id);
      assert.notEqual(followUp.task_id, selfRooted.task_id);

      throwsLedger(
        () => createTask(f.db, T_A, { source: 'text', requestText: 'x', conversationId: '' }),
        'invalid-input'
      );

      assert.equal(
        (f.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE conversation_id = ''").get() as { n: number }).n,
        0
      );
    } finally {
      f.cleanup();
    }
  });

  it('does not demote a newer user_version (16 stays 16)', () => {
    // Bumped 13 -> 14 with the P6 schema bump, 14 -> 15 with the v14 thread-lifecycle bump, 15 -> 16 with the v15 answer-provenance bump.
    // At 13 this assertion still
    // PASSED, but for the wrong reason: setUserVersion returns early on
    // `13 >= LEDGER_SCHEMA_VERSION`, so the never-demote branch was never
    // reached. A check that cannot distinguish the good state from the bad
    // one is worse than no check. Whoever bumps the schema next bumps this.
    const f = makeLedger();
    try {
      f.db.pragma('user_version = 16');
      f.db.close();
      const reopened = openLedger(join(f.dir, 'ledger.sqlite'));
      assert.equal(reopened.pragma('user_version', { simple: true }), 16);
      reopened.close();
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe('openLedger — schema v5 conversation_meta migration (AI-222)', () => {
  it('creates conversation_meta on a hand-built v4 file, bumps user_version, and preserves v3/v4 columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-ledger-v4-'));
    const dbPath = join(dir, 'ledger.sqlite');
    {
      // The current LEDGER_SCHEMA_SQL's tasks table (i.e. the actual v4
      // shape: all four v3/v4 columns present), minus conversation_meta.
      const v4 = new Database(dbPath);
      v4.pragma('busy_timeout = 3000');
      v4.exec(`CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id INTEGER NOT NULL,
  display_name     TEXT,
  created_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  source         TEXT NOT NULL CHECK (source IN ('voice','text')),
  transcript     TEXT,
  request_text   TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('received','transcribing','routed','running','awaiting_input','transcribe_failed','done','failed','cancelled')),
  routed_to      TEXT,
  routing_reason TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  worker_resource TEXT,
  worker_dispatch_id TEXT,
  steer_mode      TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('task.received','task.routed','task.progress','task.input_needed',
                  'task.input_received','task.result_ready','task.completed',
                  'task.failed','task.cancelled','task.rerouted','task.transcribed')),
  summary      TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts           TEXT NOT NULL
);`);
      v4.pragma('user_version = 4');
      v4.prepare(
        `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
         VALUES ('t-444', 444, -100444, 'Tenant D', '2026-09-01T00:00:00.000Z')`
      ).run();
      v4.prepare(
        `INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text, state, created_at, updated_at, conversation_id, worker_resource, worker_dispatch_id, steer_mode)
         VALUES ('vi-000000000004', 't-444', 'text', NULL, 'v4 request', 'received', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'vi-000000000004', NULL, NULL, NULL)`
      ).run();
      // Known-bad control: conversation_meta must not exist on this v4 file —
      // proves the post-open assertion below is not vacuous.
      assert.equal((v4.pragma('table_info(conversation_meta)') as unknown[]).length, 0);
      v4.close();
    }
    const db = openLedger(dbPath);
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 16);
      const columns = (
        db.pragma('table_info(conversation_meta)') as Array<{ name: string }>
      ).map((c) => c.name);
      assert.deepEqual(columns, [
        'conversation_id', 'tenant_id', 'title', 'recap', 'next_action', 'updated_at', 'viewed_at',
      ]);
      const task = getTask(db, 't-444', 'vi-000000000004');
      assert.ok(task);
      assert.equal(task.conversation_id, 'vi-000000000004');
      assert.equal(task.worker_resource, null);
      assert.equal(task.worker_dispatch_id, null);
      assert.equal(task.steer_mode, null);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a written meta row survives close+reopen, with user_version and table_info unchanged', () => {
    const f = makeLedger();
    try {
      const before = (
        f.db.pragma('table_info(conversation_meta)') as Array<{ name: string }>
      ).map((c) => c.name);
      setConversationMeta(f.db, T_A, 'vi-conv-0000001', { title: 'Renew passport' }, '2026-09-10T00:00:00.000Z');
      f.db.close();
      const reopened = openLedger(join(f.dir, 'ledger.sqlite'));
      assert.equal(reopened.pragma('user_version', { simple: true }), 16);
      const after = (
        reopened.pragma('table_info(conversation_meta)') as Array<{ name: string }>
      ).map((c) => c.name);
      assert.deepEqual(after, before);
      // The written row must have survived: this is the assertion that fails
      // if anyone writes CREATE TABLE without IF NOT EXISTS, or adds a DROP.
      const meta = getConversationMeta(reopened, T_A, 'vi-conv-0000001');
      assert.equal(meta?.title, 'Renew passport');
      reopened.close();
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe('openLedger — schema v7 feedback_about migration', () => {
  it('adds feedback_about to a hand-built v6 file, bumps user_version, keeps the seeded row readable, idempotent on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-ledger-v6-'));
    const dbPath = join(dir, 'ledger.sqlite');
    {
      // TODAY's (pre-v7) tasks table: all four v3/v4 columns, NO feedback_about.
      const v6 = new Database(dbPath);
      v6.pragma('busy_timeout = 3000');
      v6.exec(`CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id INTEGER NOT NULL,
  display_name     TEXT,
  created_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  source         TEXT NOT NULL CHECK (source IN ('voice','text')),
  transcript     TEXT,
  request_text   TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('received','transcribing','routed','running','awaiting_input','transcribe_failed','done','failed','cancelled')),
  routed_to      TEXT,
  routing_reason TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  worker_resource TEXT,
  worker_dispatch_id TEXT,
  steer_mode      TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('task.received','task.routed','task.progress','task.input_needed',
                  'task.input_received','task.result_ready','task.completed',
                  'task.failed','task.cancelled','task.rerouted','task.transcribed')),
  summary      TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts           TEXT NOT NULL
);`);
      v6.pragma('user_version = 6');
      v6.prepare(
        `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
         VALUES ('t-666', 666, -100666, 'Tenant F', '2026-09-01T00:00:00.000Z')`
      ).run();
      v6.prepare(
        `INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text, state, created_at, updated_at, conversation_id, worker_resource, worker_dispatch_id, steer_mode)
         VALUES ('vi-000000000006', 't-666', 'text', NULL, 'v6 request', 'received', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'vi-000000000006', NULL, NULL, NULL)`
      ).run();
      // Known-bad control: the column must not exist on this v6 file —
      // proves the post-open assertion below is not vacuous.
      const v6Columns = (v6.pragma('table_info(tasks)') as Array<{ name: string }>).map(
        (c) => c.name
      );
      assert.equal(v6Columns.includes('feedback_about'), false);
      v6.close();
    }
    const db = openLedger(dbPath);
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 16);
      const columnNames = (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
      assert.equal(columnNames.includes('feedback_about'), true);
      assert.equal(columnNames.includes('result_short'), true);
      assert.equal(columnNames.includes('suggested_items'), true);
      const task = getTask(db, 't-666', 'vi-000000000006');
      assert.ok(task);
      assert.equal(task.conversation_id, 'vi-000000000006');
      assert.equal(task.feedback_about, null);
      // Reopen is idempotent: version and column stay.
      db.close();
      const reopened = openLedger(dbPath);
      assert.equal(reopened.pragma('user_version', { simple: true }), 16);
      const reopenedColumns = (
        reopened.pragma('table_info(tasks)') as Array<{ name: string }>
      ).map((c) => c.name);
      assert.equal(reopenedColumns[reopenedColumns.length - 1], 'router_failovers');
      reopened.close();
    } finally {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('createTask stores feedbackAbout, returns it on the row, and rejects a malformed id', () => {
    const f = makeLedger();
    try {
      const task = createTask(f.db, T_A, {
        source: 'text',
        requestText: 'the caption is too long',
        feedbackAbout: 'vi-abcdef123456',
      });
      assert.equal(task.feedback_about, 'vi-abcdef123456');
      const reread = getTask(f.db, T_A, task.task_id);
      assert.equal(reread?.feedback_about, 'vi-abcdef123456');

      throwsLedger(
        () => createTask(f.db, T_A, { source: 'text', requestText: 'x', feedbackAbout: 'nope' }),
        'invalid-input'
      );
    } finally {
      f.cleanup();
    }
  });
});

describe('openLedger — schema v8 result_short migration', () => {
  it('adds result_short to a hand-built v7 file, bumps user_version, keeps the seeded row readable, idempotent on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-ledger-v7-'));
    const dbPath = join(dir, 'ledger.sqlite');
    {
      // TODAY's (pre-v8) tasks table: all four v3/v4 columns plus feedback_about,
      // NO result_short.
      const v7 = new Database(dbPath);
      v7.pragma('busy_timeout = 3000');
      v7.exec(`CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id INTEGER NOT NULL,
  display_name     TEXT,
  created_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  source         TEXT NOT NULL CHECK (source IN ('voice','text')),
  transcript     TEXT,
  request_text   TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('received','transcribing','routed','running','awaiting_input','transcribe_failed','done','failed','cancelled')),
  routed_to      TEXT,
  routing_reason TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  worker_resource TEXT,
  worker_dispatch_id TEXT,
  steer_mode      TEXT,
  feedback_about  TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('task.received','task.routed','task.progress','task.input_needed',
                  'task.input_received','task.result_ready','task.completed',
                  'task.failed','task.cancelled','task.rerouted','task.transcribed')),
  summary      TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts           TEXT NOT NULL
);`);
      v7.pragma('user_version = 7');
      v7.prepare(
        `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
         VALUES ('t-777', 777, -100777, 'Tenant G', '2026-09-01T00:00:00.000Z')`
      ).run();
      v7.prepare(
        `INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text, state, created_at, updated_at, conversation_id, worker_resource, worker_dispatch_id, steer_mode, feedback_about)
         VALUES ('vi-000000000007', 't-777', 'text', NULL, 'v7 request', 'received', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'vi-000000000007', NULL, NULL, NULL, NULL)`
      ).run();
      // Known-bad control: the column must not exist on this v7 file —
      // proves the post-open assertion below is not vacuous.
      const v7Columns = (v7.pragma('table_info(tasks)') as Array<{ name: string }>).map(
        (c) => c.name
      );
      assert.equal(v7Columns.includes('result_short'), false);
      v7.close();
    }
    const db = openLedger(dbPath);
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 16);
      const columnNames = (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
      assert.equal(columnNames.includes('result_short'), true);
      assert.equal(columnNames[columnNames.length - 1], 'router_failovers');
      const task = getTask(db, 't-777', 'vi-000000000007');
      assert.ok(task);
      assert.equal(task.conversation_id, 'vi-000000000007');
      assert.equal(task.result_short, null);
      assert.equal(task.suggested_items, null);
      // Reopen is idempotent: version and column count stay.
      const columnCount = columnNames.length;
      db.close();
      const reopened = openLedger(dbPath);
      assert.equal(reopened.pragma('user_version', { simple: true }), 16);
      const reopenedColumns = (
        reopened.pragma('table_info(tasks)') as Array<{ name: string }>
      ).map((c) => c.name);
      assert.equal(reopenedColumns.length, columnCount);
      reopened.close();
    } finally {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('openLedger — schema v9 form-kind rebuild', () => {
  /** The TEN input_requests columns, in schema order. */
  const INPUT_COLUMNS = [
    'request_id', 'task_id', 'tenant_id', 'kind', 'prompt', 'params_json',
    'status', 'answer_pointer', 'created_at', 'answered_at',
  ];

  function buildV8Fixture(dbPath: string): void {
    const v8 = new Database(dbPath);
    v8.pragma('busy_timeout = 3000');
    // TODAY's (pre-v9) schema text: the input_requests kind CHECK WITHOUT
    // 'form', the tasks table at its full v8 shape.
    v8.exec(`CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id INTEGER NOT NULL,
  display_name     TEXT,
  created_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  source         TEXT NOT NULL CHECK (source IN ('voice','text')),
  transcript     TEXT,
  request_text   TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('received','transcribing','routed','running','awaiting_input','transcribe_failed','done','failed','cancelled')),
  routed_to      TEXT,
  routing_reason TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  worker_resource TEXT,
  worker_dispatch_id TEXT,
  steer_mode      TEXT,
  feedback_about  TEXT,
  result_short    TEXT
);
CREATE TABLE IF NOT EXISTS input_requests (
  request_id     TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(task_id),
  tenant_id      TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('secret','text','choice','oauth','file','confirm')),
  prompt         TEXT NOT NULL,
  params_json    TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL CHECK (status IN
                   ('pending','answered','expired','cancelled')),
  answer_pointer TEXT,
  created_at     TEXT NOT NULL,
  answered_at    TEXT
);
CREATE INDEX IF NOT EXISTS inputs_task_status ON input_requests(task_id, status);`);
    v8.pragma('user_version = 8');
    v8.prepare(
      `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
       VALUES ('t-999', 999, -100999, 'Tenant V9', '2026-09-01T00:00:00.000Z')`
    ).run();
    v8.prepare(
      `INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text, state, created_at, updated_at, conversation_id, worker_resource, worker_dispatch_id, steer_mode, feedback_about, result_short)
       VALUES ('vi-000000000009', 't-999', 'text', NULL, 'v9 request', 'awaiting_input', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'vi-000000000009', NULL, NULL, NULL, NULL, NULL)`
    ).run();
    // Three rows populating ALL TEN columns across the status family.
    v8.prepare(
      `INSERT INTO input_requests (request_id, task_id, tenant_id, kind, prompt, params_json, status, answer_pointer, created_at, answered_at)
       VALUES ('ir-000000000001', 'vi-000000000009', 't-999', 'secret', 'API key?', '{}', 'pending', NULL, '2026-09-01T00:00:01.000Z', NULL)`
    ).run();
    v8.prepare(
      `INSERT INTO input_requests (request_id, task_id, tenant_id, kind, prompt, params_json, status, answer_pointer, created_at, answered_at)
       VALUES ('ir-000000000002', 'vi-000000000009', 't-999', 'choice', 'Pick one?', '{"options":["a","b"]}', 'answered', '~/.pa/voice-inbox/answers/vi-000000000009/ir-000000000002.txt', '2026-09-01T00:00:02.000Z', '2026-09-01T00:05:02.000Z')`
    ).run();
    v8.prepare(
      `INSERT INTO input_requests (request_id, task_id, tenant_id, kind, prompt, params_json, status, answer_pointer, created_at, answered_at)
       VALUES ('ir-000000000003', 'vi-000000000009', 't-999', 'confirm', 'Proceed?', '{}', 'expired', NULL, '2026-09-01T00:00:03.000Z', NULL)`
    ).run();
    // KNOWN-BAD CONTROL: the old CHECK must reject 'form' — proves the
    // post-open positive assertion below is not vacuous.
    assert.throws(() =>
      v8.prepare(
        `INSERT INTO input_requests (request_id, task_id, tenant_id, kind, prompt, params_json, status, created_at)
         VALUES ('ir-000000000004', 'vi-000000000009', 't-999', 'form', 'p', '{}', 'pending', '2026-09-01T00:00:04.000Z')`
      ).run()
    );
    v8.close();
  }

  it('rebuilds input_requests: form admitted, junk still rejected, all rows and columns preserved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-ledger-v8-'));
    const dbPath = join(dir, 'ledger.sqlite');
    buildV8Fixture(dbPath);
    const db = openLedger(dbPath);
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 16);
      // Positive: the widened CHECK admits a pending form row (then removed).
      db.prepare(
        `INSERT INTO input_requests (request_id, task_id, tenant_id, kind, prompt, params_json, status, created_at)
         VALUES ('ir-000000000004', 'vi-000000000009', 't-999', 'form', 'p', '{}', 'pending', '2026-09-01T00:00:04.000Z')`
      ).run();
      db.prepare("DELETE FROM input_requests WHERE request_id = 'ir-000000000004'").run();
      // Negative: junk kinds still reject.
      assert.throws(() =>
        db.prepare(
          `INSERT INTO input_requests (request_id, task_id, tenant_id, kind, prompt, params_json, status, created_at)
           VALUES ('ir-000000000005', 'vi-000000000009', 't-999', 'nope', 'p', '{}', 'pending', '2026-09-01T00:00:05.000Z')`
        ).run()
      );
      // Every seeded row survives with ALL TEN columns intact.
      const rows = db.prepare(
        'SELECT * FROM input_requests ORDER BY request_id'
      ).all() as Array<Record<string, unknown>>;
      assert.deepEqual(rows, [
        {
          request_id: 'ir-000000000001',
          task_id: 'vi-000000000009',
          tenant_id: 't-999',
          kind: 'secret',
          prompt: 'API key?',
          params_json: '{}',
          status: 'pending',
          answer_pointer: null,
          created_at: '2026-09-01T00:00:01.000Z',
          answered_at: null,
        },
        {
          request_id: 'ir-000000000002',
          task_id: 'vi-000000000009',
          tenant_id: 't-999',
          kind: 'choice',
          prompt: 'Pick one?',
          params_json: '{"options":["a","b"]}',
          status: 'answered',
          answer_pointer: '~/.pa/voice-inbox/answers/vi-000000000009/ir-000000000002.txt',
          created_at: '2026-09-01T00:00:02.000Z',
          answered_at: '2026-09-01T00:05:02.000Z',
        },
        {
          request_id: 'ir-000000000003',
          task_id: 'vi-000000000009',
          tenant_id: 't-999',
          kind: 'confirm',
          prompt: 'Proceed?',
          params_json: '{}',
          status: 'expired',
          answer_pointer: null,
          created_at: '2026-09-01T00:00:03.000Z',
          answered_at: null,
        },
      ]);
      // Column names and order match the schema's ten columns.
      const columns = (db.pragma('table_info(input_requests)') as Array<{ name: string }>).map((c) => c.name);
      assert.deepEqual(columns, INPUT_COLUMNS);
      // The index a DROP TABLE removed is recreated by openLedger's second
      // schema exec.
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'inputs_task_status'"
      ).all() as Array<{ name: string }>;
      assert.equal(indexes.length, 1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reopen is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-ledger-v8b-'));
    const dbPath = join(dir, 'ledger.sqlite');
    buildV8Fixture(dbPath);
    const db = openLedger(dbPath);
    try {
      db.close();
      const reopened = openLedger(dbPath);
      assert.equal(reopened.pragma('user_version', { simple: true }), 16);
      const rows = reopened.prepare('SELECT COUNT(*) AS n FROM input_requests').get() as { n: number };
      assert.equal(rows.n, 3);
      const columns = (reopened.pragma('table_info(input_requests)') as Array<{ name: string }>).map((c) => c.name);
      assert.deepEqual(columns, INPUT_COLUMNS);
      reopened.close();
    } finally {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('openLedger — schema v10 suggested_items migration (AI-234)', () => {
  it('adds suggested_items to a hand-built v9 file, bumps user_version, keeps the seeded row readable, idempotent on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-ledger-v9-'));
    const dbPath = join(dir, 'ledger.sqlite');
    {
      // TODAY's (pre-v10) tasks table: full v9 shape with result_short but
      // NO suggested_items.
      const v9 = new Database(dbPath);
      v9.pragma('busy_timeout = 3000');
      v9.exec(`CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id INTEGER NOT NULL,
  display_name     TEXT,
  created_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  source         TEXT NOT NULL CHECK (source IN ('voice','text')),
  transcript     TEXT,
  request_text   TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('received','transcribing','routed','running','awaiting_input','transcribe_failed','done','failed','cancelled')),
  routed_to      TEXT,
  routing_reason TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  worker_resource TEXT,
  worker_dispatch_id TEXT,
  steer_mode      TEXT,
  feedback_about  TEXT,
  result_short    TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('task.received','task.routed','task.progress','task.input_needed',
                  'task.input_received','task.result_ready','task.completed',
                  'task.failed','task.cancelled','task.rerouted','task.transcribed')),
  summary      TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts           TEXT NOT NULL
);`);
      v9.pragma('user_version = 9');
      v9.prepare(
        `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
         VALUES ('t-aaa', 111, -100111, 'Tenant V10', '2026-09-01T00:00:00.000Z')`
      ).run();
      v9.prepare(
        `INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text, state, created_at, updated_at, conversation_id, worker_resource, worker_dispatch_id, steer_mode, feedback_about, result_short)
         VALUES ('vi-000000000010', 't-aaa', 'text', NULL, 'v10 request', 'running', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'vi-000000000010', NULL, NULL, NULL, NULL, NULL)`
      ).run();
      // Known-bad control: the column must not exist on this v9 file.
      const v9Columns = (v9.pragma('table_info(tasks)') as Array<{ name: string }>).map(
        (c) => c.name
      );
      assert.equal(v9Columns.includes('suggested_items'), false);
      v9.close();
    }
    const db = openLedger(dbPath);
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 16);
      const columnNames = (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
      assert.equal(columnNames.includes('suggested_items'), true);
      assert.equal(columnNames[columnNames.length - 1], 'router_failovers');
      const task = getTask(db, 't-aaa', 'vi-000000000010');
      assert.ok(task);
      assert.equal(task.conversation_id, 'vi-000000000010');
      assert.equal(task.suggested_items, null);
      // Reopen is idempotent: version and column count stay.
      const columnCount = columnNames.length;
      db.close();
      const reopened = openLedger(dbPath);
      assert.equal(reopened.pragma('user_version', { simple: true }), 16);
      const reopenedColumns = (
        reopened.pragma('table_info(tasks)') as Array<{ name: string }>
      ).map((c) => c.name);
      assert.equal(reopenedColumns.length, columnCount);
      assert.equal(reopenedColumns[reopenedColumns.length - 1], 'router_failovers');
      reopened.close();
    } finally {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('openLedger — schema v11 tg_message_id migration (AI-218)', () => {
  it('adds tg_message_id to a hand-built v10 file, bumps user_version, keeps the seeded row readable, idempotent on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-ledger-v10-'));
    const dbPath = join(dir, 'ledger.sqlite');
    {
      // TODAY's (pre-v11) tasks table: full v10 shape with suggested_items but
      // NO tg_message_id.
      const v10 = new Database(dbPath);
      v10.pragma('busy_timeout = 3000');
      v10.exec(`CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id INTEGER NOT NULL,
  display_name     TEXT,
  created_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  source         TEXT NOT NULL CHECK (source IN ('voice','text')),
  transcript     TEXT,
  request_text   TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('received','transcribing','routed','running','awaiting_input','transcribe_failed','done','failed','cancelled')),
  routed_to      TEXT,
  routing_reason TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  worker_resource TEXT,
  worker_dispatch_id TEXT,
  steer_mode      TEXT,
  feedback_about  TEXT,
  result_short    TEXT,
  suggested_items TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('task.received','task.routed','task.progress','task.input_needed',
                  'task.input_received','task.result_ready','task.completed',
                  'task.failed','task.cancelled','task.rerouted','task.transcribed')),
  summary      TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts           TEXT NOT NULL
);`);
      v10.pragma('user_version = 10');
      v10.prepare(
        `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
         VALUES ('t-bbb', 222, -100222, 'Tenant V11', '2026-09-14T00:00:00.000Z')`
      ).run();
      v10.prepare(
        `INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text, state, created_at, updated_at, conversation_id, worker_resource, worker_dispatch_id, steer_mode, feedback_about, result_short, suggested_items)
         VALUES ('vi-000000000011', 't-bbb', 'voice', NULL, 'v11 request', 'done', '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z', 'vi-000000000011', NULL, NULL, NULL, NULL, NULL, NULL)`
      ).run();
      // Known-bad control: the column must not exist on this v10 file.
      const v10Columns = (v10.pragma('table_info(tasks)') as Array<{ name: string }>).map(
        (c) => c.name
      );
      assert.equal(v10Columns.includes('tg_message_id'), false);
      v10.close();
    }
    const db = openLedger(dbPath);
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 16);
      const columnNames = (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
      assert.equal(columnNames.includes('tg_message_id'), true);
      assert.equal(columnNames[columnNames.length - 1], 'router_failovers');
      const task = getTask(db, 't-bbb', 'vi-000000000011');
      assert.ok(task);
      assert.equal(task.conversation_id, 'vi-000000000011');
      assert.equal(task.tg_message_id, null);
      // Reopen is idempotent: version and column count stay.
      const columnCount = columnNames.length;
      db.close();
      const reopened = openLedger(dbPath);
      assert.equal(reopened.pragma('user_version', { simple: true }), 16);
      const reopenedColumns = (
        reopened.pragma('table_info(tasks)') as Array<{ name: string }>
      ).map((c) => c.name);
      assert.equal(reopenedColumns.length, columnCount);
      assert.equal(reopenedColumns[reopenedColumns.length - 1], 'router_failovers');
      reopened.close();
    } finally {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('openLedger — schema v12 result_structured migration', () => {
  it('adds result_structured to a hand-built v11 file, bumps user_version, keeps the seeded row readable, idempotent on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-ledger-v11-'));
    const dbPath = join(dir, 'ledger.sqlite');
    {
      // TODAY's (pre-v12) tasks table: full v11 shape with tg_message_id but
      // NO result_structured.
      const v11 = new Database(dbPath);
      v11.pragma('busy_timeout = 3000');
      v11.exec(`CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id INTEGER NOT NULL,
  display_name     TEXT,
  created_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  source         TEXT NOT NULL CHECK (source IN ('voice','text')),
  transcript     TEXT,
  request_text   TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('received','transcribing','routed','running','awaiting_input','transcribe_failed','done','failed','cancelled')),
  routed_to      TEXT,
  routing_reason TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  worker_resource TEXT,
  worker_dispatch_id TEXT,
  steer_mode      TEXT,
  feedback_about  TEXT,
  result_short    TEXT,
  suggested_items TEXT,
  tg_message_id   INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('task.received','task.routed','task.progress','task.input_needed',
                  'task.input_received','task.result_ready','task.completed',
                  'task.failed','task.cancelled','task.rerouted','task.transcribed')),
  summary      TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts           TEXT NOT NULL
);`);
      v11.pragma('user_version = 11');
      v11.prepare(
        `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
         VALUES ('t-ccc', 333, -100333, 'Tenant V12', '2026-09-15T00:00:00.000Z')`
      ).run();
      v11.prepare(
        `INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text, state, created_at, updated_at, conversation_id, worker_resource, worker_dispatch_id, steer_mode, feedback_about, result_short, suggested_items, tg_message_id)
         VALUES ('vi-000000000012', 't-ccc', 'text', NULL, 'v12 request', 'done', '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z', 'vi-000000000012', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`
      ).run();
      // Known-bad control: the column must not exist on this v11 file.
      const v11Columns = (v11.pragma('table_info(tasks)') as Array<{ name: string }>).map(
        (c) => c.name
      );
      assert.equal(v11Columns.includes('result_structured'), false);
      v11.close();
    }
    const db = openLedger(dbPath);
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 16);
      const columnNames = (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
      assert.equal(columnNames.includes('result_structured'), true);
      assert.equal(columnNames[columnNames.length - 1], 'router_failovers');
      const task = getTask(db, 't-ccc', 'vi-000000000012');
      assert.ok(task);
      assert.equal(task.conversation_id, 'vi-000000000012');
      assert.equal(task.result_structured, null);
      // Reopen is idempotent: version and column count stay.
      const columnCount = columnNames.length;
      db.close();
      const reopened = openLedger(dbPath);
      assert.equal(reopened.pragma('user_version', { simple: true }), 16);
      const reopenedColumns = (
        reopened.pragma('table_info(tasks)') as Array<{ name: string }>
      ).map((c) => c.name);
      assert.equal(reopenedColumns.length, columnCount);
      assert.equal(reopenedColumns[reopenedColumns.length - 1], 'router_failovers');
      reopened.close();
    } finally {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('setTaskMessageId (AI-218)', () => {
  it('writes tg_message_id on a task and reads it back; rejects an unknown task and a non-integer id', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      const before = getTask(f.db, T_A, taskId);
      assert.ok(before);
      assert.equal(before!.tg_message_id, null);
      const updated = setTaskMessageId(f.db, T_A, taskId, 4242);
      assert.equal(updated.tg_message_id, 4242);
      const reread = getTask(f.db, T_A, taskId);
      assert.ok(reread);
      assert.equal(reread!.tg_message_id, 4242);
      // Tenant scoping: tenant B cannot set tenant A's task.
      assert.throws(
        () => setTaskMessageId(f.db, T_B, taskId, 99),
        (err: unknown) => err instanceof LedgerError && err.code === 'task-not-found'
      );
      // A non-integer message_id is rejected.
      assert.throws(
        () => setTaskMessageId(f.db, T_A, taskId, 1.5 as number),
        (err: unknown) => err instanceof LedgerError && err.code === 'invalid-input'
      );
      // An unknown task id is rejected.
      assert.throws(
        () => setTaskMessageId(f.db, T_A, 'vi-deadbeefdead', 1),
        (err: unknown) => err instanceof LedgerError && err.code === 'task-not-found'
      );
    } finally {
      f.cleanup();
    }
  });
});

describe('transcribing state machine', () => {
  it('moves transcribing → received with task.transcribed and transcribing → transcribe_failed with task.failed', () => {
    const f = makeLedger();
    try {
      const okId = seedTranscribing(f, T_A);
      const { task, event } = transitionTask(f.db, T_A, okId, 'received', {
        eventKind: 'task.transcribed',
      });
      assert.equal(task.state, 'received');
      assert.equal(event.kind, 'task.transcribed');

      const failId = seedTranscribing(f, T_A);
      const failed = transitionTask(f.db, T_A, failId, 'transcribe_failed', {
        eventKind: 'task.failed',
        eventPayload: { reason: 'no engine' },
      });
      assert.equal(failed.task.state, 'transcribe_failed');
      assert.equal(failed.event.kind, 'task.failed');
    } finally {
      f.cleanup();
    }
  });

  it('refuses transcribing → routed/done/failed, leaving the state untouched', () => {
    const f = makeLedger();
    try {
      const taskId = seedTranscribing(f, T_A);
      for (const to of ['routed', 'done', 'failed'] as const) {
        throwsLedger(
          () => transitionTask(f.db, T_A, taskId, to, { eventKind: KIND_FOR_TARGET[to] }),
          'illegal-transition'
        );
      }
      assert.equal(getTask(f.db, T_A, taskId)?.state, 'transcribing');
    } finally {
      f.cleanup();
    }
  });

  it('transcribe_failed leaves only by the operator cancel — every other target throws', () => {
    // v14 (B5): failed / transcribe_failed gained exactly one outgoing edge,
    // ->cancelled (the operator's dismissal through the API) — the ONLY state
    // this exhaustive loop must now accept; TASK_TRANSITIONS.transcribe_failed
    // itself is pinned at ['cancelled'] by the state-machine test above.
    const f = makeLedger();
    try {
      const taskId = seedTranscribing(f, T_A);
      transitionTask(f.db, T_A, taskId, 'transcribe_failed', {
        eventKind: 'task.failed',
        eventPayload: { reason: 'no engine' },
      });
      for (const to of TASK_STATES) {
        if (to === 'cancelled') continue;
        throwsLedger(
          () => transitionTask(f.db, T_A, taskId, to, { eventKind: KIND_FOR_TARGET[to] }),
          'illegal-transition'
        );
      }
      assert.equal(getTask(f.db, T_A, taskId)?.state, 'transcribe_failed');
      transitionTask(f.db, T_A, taskId, 'cancelled', { eventKind: 'task.cancelled' });
      assert.equal(getTask(f.db, T_A, taskId)?.state, 'cancelled');
    } finally {
      f.cleanup();
    }
  });

  it('accepts only task.transcribed on a transition to received', () => {
    const f = makeLedger();
    try {
      const taskId = seedTranscribing(f, T_A);
      for (const kind of TASK_EVENT_KINDS) {
        if (kind === 'task.transcribed') continue;
        throwsLedger(
          () => transitionTask(f.db, T_A, taskId, 'received', { eventKind: kind }),
          'illegal-transition'
        );
      }
      assert.equal(getTask(f.db, T_A, taskId)?.state, 'transcribing');
      transitionTask(f.db, T_A, taskId, 'received', { eventKind: 'task.transcribed' });
      assert.equal(getTask(f.db, T_A, taskId)?.state, 'received');
    } finally {
      f.cleanup();
    }
  });
});

describe('id formats', () => {
  it('mints vi-/ir-/s- ids with 12 hex chars, unique across mints', () => {
    assert.match(mintTaskId(), /^vi-[0-9a-f]{12}$/);
    assert.match(mintRequestId(), /^ir-[0-9a-f]{12}$/);
    assert.match(makeRefId(), /^s-[0-9a-f]{12}$/);
    assert.equal(tenantIdForTelegramUser(12345), 't-12345');
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(mintTaskId());
    assert.equal(seen.size, 100);
  });
});

describe('tenants', () => {
  it('upserts, then reads back by tenant id and telegram user id', () => {
    const f = makeLedger();
    try {
      const row = getTenant(f.db, T_A);
      assert.ok(row);
      assert.equal(row.telegram_user_id, 111);
      assert.match(row.created_at, /Z$/);
      const byUser = getTenantByTelegramUser(f.db, 111);
      assert.equal(byUser?.tenant_id, T_A);
      assert.equal(getTenantByTelegramUser(f.db, 999999), undefined);
    } finally {
      f.cleanup();
    }
  });

  it('re-exchange updates chat id without changing the tenant id', () => {
    const f = makeLedger();
    try {
      upsertTenant(f.db, { telegramUserId: 111, telegramChatId: -100111, displayName: 'Tenant A' });
      upsertTenant(f.db, { telegramUserId: 111, telegramChatId: -100333 });
      const row = getTenant(f.db, T_A);
      assert.equal(row?.telegram_chat_id, -100333);
      // COALESCE keeps the earlier display name when the update omits one.
      assert.equal(row?.display_name, 'Tenant A');
    } finally {
      f.cleanup();
    }
  });
});

describe('task creation', () => {
  it('creates a received text task with a task.received event', () => {
    const f = makeLedger();
    try {
      const task = createTask(f.db, T_A, { source: 'text', requestText: 'book the flight' });
      assert.match(task.task_id, /^vi-[0-9a-f]{12}$/);
      assert.equal(task.state, 'received');
      assert.equal(task.source, 'text');
      assert.equal(task.transcript, null);
      assert.equal(task.tenant_id, T_A);
      assert.match(task.created_at, /Z$/);
      const events = listEvents(f.db, T_A, task.task_id);
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, 'task.received');
      assert.match(events[0].ref_id, /^s-[0-9a-f]{12}$/);
      assert.deepEqual(JSON.parse(events[0].payload_json), { source: 'text', chars: 'book the flight'.length });
    } finally {
      f.cleanup();
    }
  });

  it('creates a voice task carrying its transcript', () => {
    const f = makeLedger();
    try {
      const task = createTask(f.db, T_A, { source: 'voice', transcript: 'summarize', requestText: 'summarize' });
      assert.equal(task.source, 'voice');
      assert.equal(task.transcript, 'summarize');
    } finally {
      f.cleanup();
    }
  });

  it('rejects invalid create input', () => {
    const f = makeLedger();
    try {
      throwsLedger(() => createTask(f.db, T_A, { source: 'fax' as unknown as 'text', requestText: 'x' }), 'invalid-input');
      throwsLedger(() => createTask(f.db, T_A, { source: 'text', requestText: '' }), 'invalid-input');
      throwsLedger(
        () => createTask(f.db, T_A, { source: 'text', requestText: 'x', initialState: 'received' as unknown as 'transcribing' }),
        'invalid-input'
      );
    } finally {
      f.cleanup();
    }
  });

  it('a fresh createTask row has steer_mode and worker_dispatch_id null by default', () => {
    const f = makeLedger();
    try {
      const task = createTask(f.db, T_A, { source: 'text', requestText: 'plain task' });
      assert.equal(task.steer_mode, null);
      assert.equal(task.worker_dispatch_id, null);
    } finally {
      f.cleanup();
    }
  });

  it('createTask with steerMode stores it', () => {
    const f = makeLedger();
    try {
      const task = createTask(f.db, T_A, { source: 'text', requestText: 'a follow-up', steerMode: 'interrupt' });
      assert.equal(task.steer_mode, 'interrupt');
      assert.equal(task.worker_dispatch_id, null); // never written at creation — only task_telemetry.py writes it
    } finally {
      f.cleanup();
    }
  });

  it('rejects an invalid steerMode', () => {
    const f = makeLedger();
    try {
      throwsLedger(
        () => createTask(f.db, T_A, { source: 'text', requestText: 'x', steerMode: 'loud' as unknown as 'interrupt' }),
        'invalid-input'
      );
    } finally {
      f.cleanup();
    }
  });
});

describe('tenant isolation — tenant B never touches tenant A', () => {
  it('hides tasks, events, and requests across tenants', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      transitionTask(f.db, T_A, taskId, 'routed', { eventKind: 'task.routed', routedTo: '-100123_1040' });
      transitionTask(f.db, T_A, taskId, 'running', { eventKind: 'task.progress' });
      const { request } = createInputRequest(f.db, T_A, taskId, {
        kind: 'secret',
        prompt: 'API key?',
        params: {},
      });

      assert.equal(getTask(f.db, T_B, taskId), undefined);
      assert.deepEqual(listTasks(f.db, T_B), []);
      assert.deepEqual(listEvents(f.db, T_B, taskId), []);
      assert.equal(getInputRequest(f.db, T_B, taskId, request.request_id), undefined);
      assert.deepEqual(listInputRequests(f.db, T_B, taskId), []);

      throwsLedger(() => transitionTask(f.db, T_B, taskId, 'done', { eventKind: 'task.completed' }), 'task-not-found');
      throwsLedger(() => appendEvent(f.db, T_B, taskId, 'task.result_ready', { payload: { preview: 'x' } }), 'task-not-found');
      throwsLedger(() => createInputRequest(f.db, T_B, taskId, VALID_REQUEST), 'task-not-found');
      throwsLedger(
        () => answerInputRequest(f.db, T_B, taskId, request.request_id, { answerPointer: '/tmp/a.txt' }),
        'request-not-found'
      );

      // A's data is intact and unchanged after all of B's failed attempts.
      assert.equal(getTask(f.db, T_A, taskId)?.state, 'awaiting_input');
      assert.ok(getInputRequest(f.db, T_A, taskId, request.request_id));
    } finally {
      f.cleanup();
    }
  });
});

describe('task state machine — the full transition matrix', () => {
  it('TASK_TRANSITIONS covers every state; done and cancelled are terminal; a failure can only be cancelled', () => {
    for (const state of TASK_STATES) {
      assert.ok(Array.isArray(TASK_TRANSITIONS[state]), `no transition row for ${state}`);
    }
    for (const terminal of ['done', 'cancelled'] as const) {
      assert.deepEqual([...TASK_TRANSITIONS[terminal]], [], `${terminal} must be terminal`);
    }
    for (const failure of ['transcribe_failed', 'failed'] as const) {
      assert.deepEqual([...TASK_TRANSITIONS[failure]], ['cancelled'], `${failure} leaves only by the operator's cancel`);
    }
    assert.equal(TASK_TRANSITIONS.awaiting_input.includes('done'), false, 'closing an asking task dropped its question');
  });

  it('accepts every legal (from, to) pair and rejects every illegal one with state untouched', () => {
    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        const f = makeLedger();
        try {
          const taskId = driveTo(f, T_A, from);
          const before = getTask(f.db, T_A, taskId)?.state;
          assert.equal(before, from, `drive to ${from} failed`);
          const legal = TASK_TRANSITIONS[from].includes(to);
          if (legal) {
            const { task } = transitionTask(f.db, T_A, taskId, to as TaskState, {
              eventKind: KIND_FOR_TARGET[to],
            });
            assert.equal(task.state, to, `expected ${from} -> ${to} to succeed`);
          } else {
            throwsLedger(
              () => transitionTask(f.db, T_A, taskId, to as TaskState, { eventKind: KIND_FOR_TARGET[to] }),
              'illegal-transition'
            );
            assert.equal(getTask(f.db, T_A, taskId)?.state, from, `illegal ${from} -> ${to} must not write`);
          }
        } finally {
          f.cleanup();
        }
      }
    }
  });

  it('rejects event kinds that may not accompany a target state', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      throwsLedger(
        () => transitionTask(f.db, T_A, taskId, 'routed', { eventKind: 'task.completed' }),
        'illegal-transition'
      );
      // received -> routed with the right kind succeeds.
      transitionTask(f.db, T_A, taskId, 'routed', {
        eventKind: 'task.routed',
        routedTo: '-100123_1040',
        routingReason: 'needs the travel topic',
      });
      const task = getTask(f.db, T_A, taskId);
      assert.equal(task?.state, 'routed');
      assert.equal(task?.routed_to, '-100123_1040');
      assert.equal(task?.routing_reason, 'needs the travel topic');
    } finally {
      f.cleanup();
    }
  });

  // The matrix test above already drives every (from, to) pair straight off
  // TASK_TRANSITIONS/KIND_FOR_TARGET, so received -> running is already
  // exercised there once the table allows it. This is a small, focused
  // confirmation of the specific transcribed-while-worker-already-progressing
  // shortcut (D5): a task.progress event on a `received` task now succeeds.
  it('received -> running succeeds via a task.progress event (transcribed shortcut)', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      const { task } = transitionTask(f.db, T_A, taskId, 'running', { eventKind: 'task.progress' });
      assert.equal(task.state, 'running');
    } finally {
      f.cleanup();
    }
  });
});

describe('transitionTask — entering routed clears worker identity (2026-09-12 orphan fix)', () => {
  function claimAsWorker(fixture: LedgerFixture, tenantId: string, taskId: string): void {
    fixture.db
      .prepare('UPDATE tasks SET worker_resource = ?, worker_dispatch_id = ? WHERE task_id = ?')
      .run('topic--1_1-th9', 'dispatch-1234567890ab', taskId);
  }

  it('a running to routed transition clears worker_resource and worker_dispatch_id', () => {
    const f = makeLedger();
    try {
      const taskId = driveTo(f, T_A, 'running');
      claimAsWorker(f, T_A, taskId);
      transitionTask(f.db, T_A, taskId, 'routed', { eventKind: 'task.rerouted' });
      const task = getTask(f.db, T_A, taskId);
      assert.equal(task?.state, 'routed');
      assert.equal(task?.worker_resource, null);
      assert.equal(task?.worker_dispatch_id, null);
    } finally {
      f.cleanup();
    }
  });

  it('every legal transition into routed lands with cleared worker identity', () => {
    for (const from of ['received', 'routed', 'running', 'awaiting_input'] as const) {
      const f = makeLedger();
      try {
        const taskId = driveTo(f, T_A, from);
        claimAsWorker(f, T_A, taskId);
        transitionTask(f.db, T_A, taskId, 'routed', { eventKind: KIND_FOR_TARGET.routed });
        const task = getTask(f.db, T_A, taskId);
        assert.equal(task?.state, 'routed', `from ${from}: expected routed`);
        assert.equal(task?.worker_resource, null, `from ${from}: worker_resource must clear`);
        assert.equal(task?.worker_dispatch_id, null, `from ${from}: worker_dispatch_id must clear`);
      } finally {
        f.cleanup();
      }
    }
  });

  it('non-routed transitions keep worker identity as history', () => {
    const f = makeLedger();
    try {
      // running -> awaiting_input keeps the claim (the worker is mid-ask).
      const askId = driveTo(f, T_A, 'running');
      claimAsWorker(f, T_A, askId);
      transitionTask(f.db, T_A, askId, 'awaiting_input', { eventKind: 'task.input_needed' });
      const asked = getTask(f.db, T_A, askId);
      assert.equal(asked?.worker_resource, 'topic--1_1-th9');
      assert.equal(asked?.worker_dispatch_id, 'dispatch-1234567890ab');

      // running -> done keeps the claim as history (a terminal sibling must
      // never block the fallback's replay of a later routed sibling).
      const doneId = driveTo(f, T_A, 'running');
      claimAsWorker(f, T_A, doneId);
      transitionTask(f.db, T_A, doneId, 'done', { eventKind: 'task.completed' });
      const done = getTask(f.db, T_A, doneId);
      assert.equal(done?.worker_resource, 'topic--1_1-th9');
      assert.equal(done?.worker_dispatch_id, 'dispatch-1234567890ab');
    } finally {
      f.cleanup();
    }
  });
});

describe('input request lifecycle', () => {
  it('creates only on a running task, per the state machine', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      throwsLedger(() => createInputRequest(f.db, T_A, taskId, VALID_REQUEST), 'illegal-transition');
      transitionTask(f.db, T_A, taskId, 'routed', { eventKind: 'task.routed', routedTo: '-100123_1040' });
      throwsLedger(() => createInputRequest(f.db, T_A, taskId, VALID_REQUEST), 'illegal-transition');
      transitionTask(f.db, T_A, taskId, 'running', { eventKind: 'task.progress' });
      const { request, task } = createInputRequest(f.db, T_A, taskId, {
        kind: 'choice',
        prompt: 'Which hotel?',
        params: { options: ['A', 'B'] },
      });
      assert.match(request.request_id, /^ir-[0-9a-f]{12}$/);
      assert.equal(request.status, 'pending');
      assert.equal(request.kind, 'choice');
      assert.deepEqual(JSON.parse(request.params_json), { options: ['A', 'B'] });
      assert.equal(request.answer_pointer, null);
      assert.equal(task.state, 'awaiting_input');
      const needed = listEvents(f.db, T_A, taskId).at(-1);
      assert.equal(needed?.kind, 'task.input_needed');
      assert.deepEqual(JSON.parse(needed?.payload_json ?? '{}'), { request_id: request.request_id, kind: 'choice' });
    } finally {
      f.cleanup();
    }
  });

  it('rejects a hostile request body through the same validator', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      transitionTask(f.db, T_A, taskId, 'routed', { eventKind: 'task.routed', routedTo: '-100123_1040' });
      transitionTask(f.db, T_A, taskId, 'running', { eventKind: 'task.progress' });
      throwsLedger(
        () => createInputRequest(f.db, T_A, taskId, { kind: 'oauth', prompt: 'p', params: { provider: 'google', auth_url: 'https://evil.example' } }),
        'invalid-input'
      );
      throwsLedger(
        () => createInputRequest(f.db, T_A, taskId, { kind: 'nope', prompt: 'p', params: {} }),
        'invalid-input'
      );
    } finally {
      f.cleanup();
    }
  });

  it('answers once, stores only a pointer, and returns the task to running', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      transitionTask(f.db, T_A, taskId, 'routed', { eventKind: 'task.routed', routedTo: '-100123_1040' });
      transitionTask(f.db, T_A, taskId, 'running', { eventKind: 'task.progress' });
      const { request } = createInputRequest(f.db, T_A, taskId, VALID_REQUEST);

      const secretValue = 'sk-live-top-secret-value';
      const answersDir = join(f.dir, 'answers');
      mkdirSync(answersDir, { recursive: true });
      writeFileSync(join(answersDir, `${request.request_id}.txt`), secretValue, 'utf8');
      const pointer = join(answersDir, `${request.request_id}.txt`);

      const { request: answered, task } = answerInputRequest(f.db, T_A, taskId, request.request_id, {
        answerPointer: pointer,
      });
      assert.equal(answered.status, 'answered');
      assert.equal(answered.answer_pointer, pointer);
      assert.match(answered.answered_at ?? '', /Z$/);
      assert.equal(task.state, 'running');
      const received = listEvents(f.db, T_A, taskId).at(-1);
      assert.equal(received?.kind, 'task.input_received');
      assert.deepEqual(JSON.parse(received?.payload_json ?? '{}'), { request_id: request.request_id, kind: 'secret' });

      // The ledger never holds the value — only the pointer.
      assert.ok(!JSON.stringify(answered).includes(secretValue));
      const rowJson = JSON.stringify(
        f.db.prepare('SELECT * FROM input_requests').all()
      );
      assert.ok(!rowJson.includes(secretValue));

      throwsLedger(
        () => answerInputRequest(f.db, T_A, taskId, request.request_id, { answerPointer: pointer }),
        'request-already-answered'
      );
    } finally {
      f.cleanup();
    }
  });

  it('refuses an answer while the task is not awaiting_input', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      transitionTask(f.db, T_A, taskId, 'routed', { eventKind: 'task.routed', routedTo: '-100123_1040' });
      transitionTask(f.db, T_A, taskId, 'running', { eventKind: 'task.progress' });
      const { request } = createInputRequest(f.db, T_A, taskId, VALID_REQUEST);
      // Operator cancels while the request is pending; a late answer must
      // bounce. The cancel transition itself closes the request out (see the
      // "closes a pending request..." test below), so this now fails the
      // earlier already-answered check rather than the state-transition one.
      transitionTask(f.db, T_A, taskId, 'cancelled', { eventKind: 'task.cancelled' });
      throwsLedger(
        () => answerInputRequest(f.db, T_A, taskId, request.request_id, { answerPointer: '/tmp/x.txt' }),
        'request-already-answered'
      );
    } finally {
      f.cleanup();
    }
  });

  it('closes a pending request instead of leaving it stale when the task is cancelled out from under it', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      transitionTask(f.db, T_A, taskId, 'routed', { eventKind: 'task.routed', routedTo: '-100123_1040' });
      transitionTask(f.db, T_A, taskId, 'running', { eventKind: 'task.progress' });
      const { request } = createInputRequest(f.db, T_A, taskId, VALID_REQUEST);
      transitionTask(f.db, T_A, taskId, 'cancelled', { eventKind: 'task.cancelled' });
      const after = getInputRequest(f.db, T_A, taskId, request.request_id);
      // Before this fix the row stayed 'pending' forever — nothing else ever
      // closes it out — which is what made the conversation list keep
      // reporting "needs you" for a task the operator had already cancelled.
      assert.equal(after?.status, 'cancelled');
      assert.notEqual(after?.answered_at, null);
      assert.equal(listInputRequests(f.db, T_A, taskId, { status: 'pending' }).length, 0);
    } finally {
      f.cleanup();
    }
  });

  it('expires a pending request when the task is rerouted out from under it', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      transitionTask(f.db, T_A, taskId, 'routed', { eventKind: 'task.routed', routedTo: '-100123_1040' });
      transitionTask(f.db, T_A, taskId, 'running', { eventKind: 'task.progress' });
      const { request } = createInputRequest(f.db, T_A, taskId, VALID_REQUEST);
      transitionTask(f.db, T_A, taskId, 'routed', {
        eventKind: 'task.rerouted',
        routedTo: '-100999_2',
        eventPayload: { from: '-100123_1040', to: '-100999_2', reason: 'operator reroute' },
      });
      const after = getInputRequest(f.db, T_A, taskId, request.request_id);
      assert.equal(after?.status, 'expired');
      assert.equal(listInputRequests(f.db, T_A, taskId, { status: 'pending' }).length, 0);
    } finally {
      f.cleanup();
    }
  });

  it('filters by status and hides cross-tenant rows', () => {
    const f = makeLedger();
    try {
      // One request per task: a task holds awaiting_input while its request is
      // pending, so a second createInputRequest on the same task is (correctly)
      // an illegal transition.
      const task1 = freshTask(f, T_A);
      transitionTask(f.db, T_A, task1, 'routed', { eventKind: 'task.routed', routedTo: '-100123_1040' });
      transitionTask(f.db, T_A, task1, 'running', { eventKind: 'task.progress' });
      const a = createInputRequest(f.db, T_A, task1, VALID_REQUEST);
      answerInputRequest(f.db, T_A, task1, a.request.request_id, { answerPointer: '/tmp/a.txt' });

      const task2 = freshTask(f, T_A);
      transitionTask(f.db, T_A, task2, 'routed', { eventKind: 'task.routed', routedTo: '-100123_1040' });
      transitionTask(f.db, T_A, task2, 'running', { eventKind: 'task.progress' });
      createInputRequest(f.db, T_A, task2, { kind: 'confirm', prompt: 'Proceed?', params: {} });

      assert.equal(listInputRequests(f.db, T_A, task1, { status: 'answered' }).length, 1);
      assert.equal(listInputRequests(f.db, T_A, task1, { status: 'pending' }).length, 0);
      assert.equal(listInputRequests(f.db, T_A, task2, { status: 'pending' }).length, 1);
      assert.deepEqual(listInputRequests(f.db, T_B, task1), []);
    } finally {
      f.cleanup();
    }
  });
});

describe('events', () => {
  it('appendEvent writes without a state change and validates the kind', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      transitionTask(f.db, T_A, taskId, 'routed', { eventKind: 'task.routed', routedTo: '-100123_1040' });
      transitionTask(f.db, T_A, taskId, 'running', { eventKind: 'task.progress' });
      const event = appendEvent(f.db, T_A, taskId, 'task.result_ready', { payload: { preview: 'half done' } });
      assert.match(event.ref_id, /^s-[0-9a-f]{12}$/);
      assert.equal(getTask(f.db, T_A, taskId)?.state, 'running');
      throwsLedger(() => appendEvent(f.db, T_A, taskId, 'task.unknown' as unknown as TaskEventKind, {}), 'invalid-input');
    } finally {
      f.cleanup();
    }
  });

  it('listEvents(afterEventId) returns only strictly newer rows, ascending', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      const all = listEvents(f.db, T_A, taskId);
      assert.equal(all.length, 1);
      appendEvent(f.db, T_A, taskId, 'task.result_ready', {});
      appendEvent(f.db, T_A, taskId, 'task.result_ready', {});
      assert.equal(listEvents(f.db, T_A, taskId).length, 3);
      const afterFirst = listEvents(f.db, T_A, taskId, { afterEventId: all[0].event_id });
      assert.equal(afterFirst.length, 2);
      assert.ok(afterFirst[0].event_id > all[0].event_id);
      assert.deepEqual(listEvents(f.db, T_B, taskId), []);
    } finally {
      f.cleanup();
    }
  });
});

describe('listTasks', () => {
  it('orders newest-first, filters by state, and honors limit', () => {
    const f = makeLedger();
    try {
      const first = freshTask(f, T_A, 'one');
      freshTask(f, T_A, 'two');
      const third = freshTask(f, T_A, 'three');
      transitionTask(f.db, T_A, third, 'cancelled', { eventKind: 'task.cancelled' });

      const all = listTasks(f.db, T_A);
      assert.equal(all.length, 3);
      for (let i = 1; i < all.length; i++) {
        assert.ok(all[i - 1].created_at >= all[i].created_at, 'must be created_at DESC');
      }
      assert.deepEqual(listTasks(f.db, T_A, { status: 'cancelled' }).map((t) => t.task_id), [third]);
      assert.equal(listTasks(f.db, T_A, { limit: 2 }).length, 2);
      assert.ok(all.some((t) => t.task_id === first));
      assert.deepEqual(listTasks(f.db, T_B), []);
    } finally {
      f.cleanup();
    }
  });
});

describe('happy path end-to-end (received → done)', () => {
  it('walks the whole §3 state machine and records result_summary', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      transitionTask(f.db, T_A, taskId, 'routed', {
        eventKind: 'task.routed',
        routedTo: '-100123_1040',
        routingReason: 'travel topic',
      });
      transitionTask(f.db, T_A, taskId, 'running', { eventKind: 'task.progress', eventSummary: 'starting' });
      const { request } = createInputRequest(f.db, T_A, taskId, {
        kind: 'confirm',
        prompt: 'Book economy?',
        params: {},
      });
      answerInputRequest(f.db, T_A, taskId, request.request_id, { answerPointer: '/tmp/c.txt' });
      const kinds = listEvents(f.db, T_A, taskId).map((e) => e.kind);
      assert.deepEqual(kinds, [
        'task.received',
        'task.routed',
        'task.progress',
        'task.input_needed',
        'task.input_received',
      ]);
      const { task } = transitionTask(f.db, T_A, taskId, 'done', {
        eventKind: 'task.completed',
        resultSummary: 'Booked economy, confirmation ABC123',
      });
      assert.equal(task.state, 'done');
      assert.equal(task.result_summary, 'Booked economy, confirmation ABC123');
      assert.equal(task.routed_to, '-100123_1040');
    } finally {
      f.cleanup();
    }
  });
});

describe('conversation shares (AI-227, schema v6)', () => {
  it('mints an active share for an existing conversation', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      const share = mintConversationShare(f.db, T_A, taskId);
      assert.equal(share.tenant_id, T_A);
      assert.equal(share.conversation_id, taskId);
      assert.equal(share.revoked_at, null);
      assert.ok(share.token.length > 0);
      assert.deepEqual(getActiveConversationShare(f.db, T_A, taskId), share);
    } finally {
      f.cleanup();
    }
  });

  it('throws task-not-found when the conversation does not exist for the tenant', () => {
    const f = makeLedger();
    try {
      throwsLedger(() => mintConversationShare(f.db, T_A, 'vi-doesnotexist'), 'task-not-found');
      // Cross-tenant: a real conversation under T_B is still not-found for T_A.
      const otherTask = freshTask(f, T_B);
      throwsLedger(() => mintConversationShare(f.db, T_A, otherTask), 'task-not-found');
    } finally {
      f.cleanup();
    }
  });

  it('idempotent minting: a second mint while one is active returns the identical token', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      const first = mintConversationShare(f.db, T_A, taskId);
      const second = mintConversationShare(f.db, T_A, taskId);
      assert.deepEqual(second, first);
    } finally {
      f.cleanup();
    }
  });

  it('revocation sets revoked_at and renders the token unresolvable', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      const share = mintConversationShare(f.db, T_A, taskId);
      assert.ok(resolveConversationShareToken(f.db, share.token));
      const revoked = revokeConversationShare(f.db, T_A, taskId);
      assert.equal(revoked, true);
      assert.equal(resolveConversationShareToken(f.db, share.token), null);
      assert.equal(getActiveConversationShare(f.db, T_A, taskId), null);
    } finally {
      f.cleanup();
    }
  });

  it('revocation with nothing active returns false without error', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      assert.equal(revokeConversationShare(f.db, T_A, taskId), false);
      mintConversationShare(f.db, T_A, taskId);
      revokeConversationShare(f.db, T_A, taskId);
      // Already revoked — a second revoke call is a no-op, not an error.
      assert.equal(revokeConversationShare(f.db, T_A, taskId), false);
    } finally {
      f.cleanup();
    }
  });

  it('minting after revocation mints a new, distinct token', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      const first = mintConversationShare(f.db, T_A, taskId);
      revokeConversationShare(f.db, T_A, taskId);
      const second = mintConversationShare(f.db, T_A, taskId);
      assert.notEqual(second.token, first.token);
      assert.equal(second.revoked_at, null);
      assert.equal(resolveConversationShareToken(f.db, first.token), null);
      assert.deepEqual(resolveConversationShareToken(f.db, second.token), {
        tenant_id: T_A,
        conversation_id: taskId,
      });
    } finally {
      f.cleanup();
    }
  });

  it('resolves a valid token, and returns null for an unknown or revoked token', () => {
    const f = makeLedger();
    try {
      const taskId = freshTask(f, T_A);
      const share = mintConversationShare(f.db, T_A, taskId);
      assert.deepEqual(resolveConversationShareToken(f.db, share.token), {
        tenant_id: T_A,
        conversation_id: taskId,
      });
      assert.equal(resolveConversationShareToken(f.db, 'not-a-real-token'), null);
      revokeConversationShare(f.db, T_A, taskId);
      assert.equal(resolveConversationShareToken(f.db, share.token), null);
    } finally {
      f.cleanup();
    }
  });
});

describe('openLedger — schema v13 surface migration', () => {
  it('adds surface to a hand-built v12 file, bumps user_version, keeps the seeded row readable, idempotent on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-ledger-v12-'));
    const dbPath = join(dir, 'ledger.sqlite');
    {
      // TODAY's (pre-v13) tasks table: full v12 shape with result_structured
      // but NO surface.
      const v12 = new Database(dbPath);
      v12.pragma('busy_timeout = 3000');
      v12.exec(`CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id INTEGER NOT NULL,
  display_name     TEXT,
  created_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  source         TEXT NOT NULL CHECK (source IN ('voice','text')),
  transcript     TEXT,
  request_text   TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('received','transcribing','routed','running','awaiting_input','transcribe_failed','done','failed','cancelled')),
  routed_to      TEXT,
  routing_reason TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  worker_resource TEXT,
  worker_dispatch_id TEXT,
  steer_mode      TEXT,
  feedback_about  TEXT,
  result_short    TEXT,
  suggested_items TEXT,
  tg_message_id   INTEGER,
  result_structured TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('task.received','task.routed','task.progress','task.input_needed',
                  'task.input_received','task.result_ready','task.completed',
                  'task.failed','task.cancelled','task.rerouted','task.transcribed')),
  summary      TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts           TEXT NOT NULL
);`);
      v12.pragma('user_version = 12');
      v12.prepare(
        `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
         VALUES ('t-ddd', 444, -100444, 'Tenant V13', '2026-09-16T00:00:00.000Z')`
      ).run();
      v12.prepare(
        `INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text, state, created_at, updated_at, conversation_id, worker_resource, worker_dispatch_id, steer_mode, feedback_about, result_short, suggested_items, tg_message_id, result_structured)
         VALUES ('vi-000000000013', 't-ddd', 'text', NULL, 'v13 request', 'done', '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z', 'vi-000000000013', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`
      ).run();
      // Known-bad control: the column must not exist on this v12 file.
      const v12Columns = (v12.pragma('table_info(tasks)') as Array<{ name: string }>).map(
        (c) => c.name
      );
      assert.equal(v12Columns.includes('surface'), false);
      v12.close();
    }
    const db = openLedger(dbPath);
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 16);
      const columnNames = (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
      assert.equal(columnNames.includes('surface'), true);
      assert.equal(columnNames[columnNames.length - 1], 'router_failovers');
      const task = getTask(db, 't-ddd', 'vi-000000000013');
      assert.ok(task);
      assert.equal(task.conversation_id, 'vi-000000000013');
      assert.equal(task.request_text, 'v13 request');
      // THE regression this test exists for: a pre-v13 row reads NULL, which
      // the PWA renders exactly as it did before P6 (no layout class at all).
      assert.equal(task.surface, null);
      assert.equal(task.result_structured, null);
      // Reopen is idempotent: version and column count stay.
      const columnCount = columnNames.length;
      db.close();
      const reopened = openLedger(dbPath);
      assert.equal(reopened.pragma('user_version', { simple: true }), 16);
      const reopenedColumns = (
        reopened.pragma('table_info(tasks)') as Array<{ name: string }>
      ).map((c) => c.name);
      assert.equal(reopenedColumns.length, columnCount);
      assert.equal(reopenedColumns[reopenedColumns.length - 1], 'router_failovers');
      reopened.close();
    } finally {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('createTask stores an explicit surface and rejects anything else', () => {
    const f = makeLedger();
    try {
      const phone = createTask(f.db, T_A, { source: 'voice', requestText: 'from the phone', surface: 'phone' });
      assert.equal(phone.surface, 'phone');
      const desktop = createTask(f.db, T_A, { source: 'text', requestText: 'from the desk', surface: 'desktop' });
      assert.equal(desktop.surface, 'desktop');
      // Omitted is NULL — never a silent 'phone' default (P6 C3).
      const none = createTask(f.db, T_A, { source: 'text', requestText: 'no hint' });
      assert.equal(none.surface, null);
      throwsLedger(
        () => createTask(f.db, T_A, { source: 'text', requestText: 'bad hint', surface: 'tablet' as 'phone' }),
        'invalid-input'
      );
    } finally {
      f.cleanup();
    }
  });
});

describe('openLedger — schema v14 thread-lifecycle migration', () => {
  /** A v13 file: today's pre-v14 tasks table (surface, no retried_by) and a
   *  v5 conversation_meta (no viewed_at). */
  function buildV13(dbPath: string): InstanceType<typeof Database> {
    const v13 = new Database(dbPath);
    v13.pragma('busy_timeout = 3000');
    v13.exec(`CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id INTEGER NOT NULL,
  display_name     TEXT,
  created_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  source         TEXT NOT NULL CHECK (source IN ('voice','text')),
  transcript     TEXT,
  request_text   TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('received','transcribing','routed','running','awaiting_input','transcribe_failed','done','failed','cancelled')),
  routed_to      TEXT,
  routing_reason TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  worker_resource TEXT,
  worker_dispatch_id TEXT,
  steer_mode      TEXT,
  feedback_about  TEXT,
  result_short    TEXT,
  suggested_items TEXT,
  tg_message_id   INTEGER,
  result_structured TEXT,
  surface        TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('task.received','task.routed','task.progress','task.input_needed',
                  'task.input_received','task.result_ready','task.completed',
                  'task.failed','task.cancelled','task.rerouted','task.transcribed')),
  summary      TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts           TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_meta (
  conversation_id TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  title           TEXT,
  recap           TEXT,
  next_action     TEXT,
  updated_at      TEXT NOT NULL
);`);
    v13.pragma('user_version = 13');
    v13.prepare(
      `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
       VALUES ('t-eee', 555, -100555, 'Tenant V14', '2026-09-01T00:00:00.000Z')`
    ).run();
    return v13;
  }

  it('adds retried_by and viewed_at to a hand-built v13 file, bumps user_version to 16, idempotent on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-ledger-v13-'));
    const dbPath = join(dir, 'ledger.sqlite');
    const stamp = new Date().toISOString();
    {
      const v13 = buildV13(dbPath);
      v13.prepare(
        `INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text, state, created_at, updated_at, conversation_id)
         VALUES ('vi-000000000014', 't-eee', 'text', NULL, 'v14 request', 'received', ?, ?, 'vi-000000000014')`
      ).run(stamp, stamp);
      // Known-bad controls: neither column exists on this v13 file.
      const taskColumns = (v13.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
      const metaColumns = (v13.pragma('table_info(conversation_meta)') as Array<{ name: string }>).map((c) => c.name);
      assert.equal(taskColumns.includes('retried_by'), false);
      assert.equal(metaColumns.includes('viewed_at'), false);
      v13.close();
    }
    const db = openLedger(dbPath);
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 16);
      const taskColumns = (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
      const metaColumns = (db.pragma('table_info(conversation_meta)') as Array<{ name: string }>).map((c) => c.name);
      assert.equal(taskColumns[taskColumns.length - 1], 'router_failovers');
      assert.equal(metaColumns[metaColumns.length - 1], 'viewed_at');
      assert.equal(getTask(db, 't-eee', 'vi-000000000014')?.retried_by, null);
      db.close();
      const reopened = openLedger(dbPath);
      assert.equal(reopened.pragma('user_version', { simple: true }), 16);
      assert.equal((reopened.pragma('table_info(tasks)') as unknown[]).length, taskColumns.length);
      assert.equal((reopened.pragma('table_info(conversation_meta)') as unknown[]).length, metaColumns.length);
      reopened.close();
    } finally {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the v14 migration stamps viewed_at on threads with a done task last updated over 24 hours ago, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-ledger-v13-stamp-'));
    const dbPath = join(dir, 'ledger.sqlite');
    const nowMs = Date.now();
    const iso = (hoursAgo: number): string => new Date(nowMs - hoursAgo * 3_600_000).toISOString();
    {
      const v13 = buildV13(dbPath);
      const insertTask = v13.prepare(
        `INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text, state, created_at, updated_at, conversation_id)
         VALUES (?, 't-eee', 'text', NULL, 'request', ?, ?, ?, ?)`
      );
      const insertEvent = v13.prepare(
        `INSERT INTO events (tenant_id, task_id, ref_id, kind, summary, payload_json, ts)
         VALUES ('t-eee', ?, 's-000000000000', ?, NULL, '{}', ?)`
      );
      // Old answered thread: completed 72 h ago, a later metadata bump at 71 h.
      insertTask.run('vi-00000000a001', 'done', iso(73), iso(71), 'vi-00000000a001');
      insertEvent.run('vi-00000000a001', 'task.completed', iso(72));
      // Recent answered thread: stays unviewed (Ready).
      insertTask.run('vi-00000000b001', 'done', iso(3), iso(2), 'vi-00000000b001');
      insertEvent.run('vi-00000000b001', 'task.completed', iso(2));
      // Old failure-only thread: nothing to view.
      insertTask.run('vi-00000000c001', 'failed', iso(80), iso(80), 'vi-00000000c001');
      v13.close();
    }
    const db = openLedger(dbPath);
    try {
      assert.equal(getConversationMeta(db, 't-eee', 'vi-00000000a001')?.viewed_at, iso(72));
      assert.equal(getConversationMeta(db, 't-eee', 'vi-00000000b001')?.viewed_at ?? null, null);
      assert.equal(getConversationMeta(db, 't-eee', 'vi-00000000c001')?.viewed_at ?? null, null);
      // Once: an old answered thread written after the v14 bump is not stamped on reopen.
      db.prepare(
        `INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text, state, created_at, updated_at, conversation_id)
         VALUES ('vi-00000000d001', 't-eee', 'text', NULL, 'request', 'done', ?, ?, 'vi-00000000d001')`
      ).run(iso(90), iso(90));
      db.close();
      const reopened = openLedger(dbPath);
      assert.equal(getConversationMeta(reopened, 't-eee', 'vi-00000000d001')?.viewed_at ?? null, null);
      reopened.close();
    } finally {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('task state machine — v14 edges', () => {
  it('awaiting_input -> done is refused and the pending ask stays pending', () => {
    const f = makeLedger();
    try {
      const taskId = driveTo(f, T_A, 'running');
      const { request } = createInputRequest(f.db, T_A, taskId, VALID_REQUEST);
      throwsLedger(() => transitionTask(f.db, T_A, taskId, 'done', { eventKind: 'task.completed' }), 'illegal-transition');
      assert.equal(getTask(f.db, T_A, taskId)?.state, 'awaiting_input');
      assert.equal(getInputRequest(f.db, T_A, taskId, request.request_id)?.status, 'pending');
      assert.equal(listEvents(f.db, T_A, taskId).some((e) => e.kind === 'task.completed'), false);
    } finally {
      f.cleanup();
    }
  });
});

describe('createTask — the v14 retry link', () => {
  const taskCount = (f: LedgerFixture): number =>
    (f.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;

  it('createTask with retryOf stamps retried_by in the same transaction and records retry_of', () => {
    const f = makeLedger();
    try {
      const failedId = driveTo(f, T_A, 'failed');
      const retry = createTask(f.db, T_A, { source: 'text', requestText: 'try again', conversationId: failedId, retryOf: failedId });
      assert.equal(getTask(f.db, T_A, failedId)?.retried_by, retry.task_id);
      assert.equal(getTask(f.db, T_A, failedId)?.state, 'failed');
      assert.equal(retry.retried_by, null);
      const received = listEvents(f.db, T_A, retry.task_id)[0];
      assert.equal(received.kind, 'task.received');
      assert.deepEqual(JSON.parse(received.payload_json), { source: 'text', chars: 'try again'.length, retry_of: failedId });
      const plain = createTask(f.db, T_A, { source: 'text', requestText: 'no retry' });
      assert.deepEqual(JSON.parse(listEvents(f.db, T_A, plain.task_id)[0].payload_json), { source: 'text', chars: 'no retry'.length });
    } finally {
      f.cleanup();
    }
  });

  it('createTask with retryOf refuses a task that is not an unresolved failure and writes nothing', () => {
    const f = makeLedger();
    try {
      const doneId = driveTo(f, T_A, 'done');
      const before = taskCount(f);
      throwsLedger(() => createTask(f.db, T_A, { source: 'text', requestText: 'retry a done task', retryOf: doneId }), 'illegal-transition');
      assert.equal(taskCount(f), before, 'a refused retry leaves no task row behind');
      const failedId = driveTo(f, T_A, 'failed');
      createTask(f.db, T_A, { source: 'text', requestText: 'first retry', retryOf: failedId });
      const afterFirst = taskCount(f);
      throwsLedger(() => createTask(f.db, T_A, { source: 'text', requestText: 'second retry', retryOf: failedId }), 'illegal-transition');
      assert.equal(taskCount(f), afterFirst);
      const otherTenantFailure = driveTo(f, T_A, 'failed');
      throwsLedger(() => createTask(f.db, T_B, { source: 'text', requestText: 'cross tenant', retryOf: otherTenantFailure }), 'illegal-transition');
      throwsLedger(() => createTask(f.db, T_A, { source: 'text', requestText: 'bad id', retryOf: 'nope' }), 'invalid-input');
    } finally {
      f.cleanup();
    }
  });
});

describe('setConversationViewed — the v14 server view time', () => {
  function answer(f: LedgerFixture, conversationId?: string): string {
    const taskId = createTask(f.db, T_A, { source: 'text', requestText: 'question', ...(conversationId ? { conversationId } : {}) }).task_id;
    for (const step of ['routed', 'running', 'done'] as const) {
      transitionTask(f.db, T_A, taskId, step, { eventKind: KIND_FOR_TARGET[step] });
    }
    return taskId;
  }
  function backdateCompletion(f: LedgerFixture, taskId: string, hoursAgo: number): string {
    const ts = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    f.db.prepare("UPDATE events SET ts = ? WHERE task_id = ? AND kind = 'task.completed'").run(ts, taskId);
    return ts;
  }

  it('setConversationViewed writes once per answer, never restarts on re-open, and reopens for a new answer', () => {
    const f = makeLedger();
    try {
      const root = answer(f);
      backdateCompletion(f, root, 2);
      const viewedAt = new Date(Date.now() - 3_600_000);
      assert.deepEqual(setConversationViewed(f.db, T_A, root, { now: viewedAt }), { changed: true, viewed_at: viewedAt.toISOString() });
      assert.deepEqual(setConversationViewed(f.db, T_A, root, { now: new Date() }), { changed: false, viewed_at: viewedAt.toISOString() });
      answer(f, root); // a second answer lands now, after the view
      const later = new Date(Date.now() + 1000);
      assert.deepEqual(setConversationViewed(f.db, T_A, root, { now: later }), { changed: true, viewed_at: later.toISOString() });
      const open = createTask(f.db, T_A, { source: 'text', requestText: 'still open' }).task_id;
      assert.deepEqual(setConversationViewed(f.db, T_A, open, { now: new Date() }), { changed: false, viewed_at: null });
      throwsLedger(() => setConversationViewed(f.db, T_B, root, { now: new Date() }), 'task-not-found');
    } finally {
      f.cleanup();
    }
  });

  it('setConversationViewed honours an explicit at only when no view time exists', () => {
    const f = makeLedger();
    try {
      const root = answer(f);
      const markAt = new Date(Date.now() + 1000).toISOString();
      assert.deepEqual(
        setConversationViewed(f.db, T_A, root, { at: markAt, now: new Date(Date.now() + 5000) }),
        { changed: true, viewed_at: markAt }
      );
      const root2 = answer(f);
      const staleAt = '2020-01-01T00:00:00.000Z';
      assert.deepEqual(setConversationViewed(f.db, T_A, root2, { at: staleAt, now: new Date() }), { changed: true, viewed_at: staleAt });
      const nowLater = new Date(Date.now() + 2000);
      assert.deepEqual(
        setConversationViewed(f.db, T_A, root2, { at: '2021-01-01T00:00:00.000Z', now: nowLater }),
        { changed: true, viewed_at: nowLater.toISOString() },
        'a view time exists, so at is ignored and now is written'
      );
    } finally {
      f.cleanup();
    }
  });

  it('a tg_message_id write after the view does not make the thread Ready again', () => {
    const f = makeLedger();
    try {
      const root = answer(f);
      const landedAt = backdateCompletion(f, root, 2);
      setConversationViewed(f.db, T_A, root, { now: new Date(Date.now() - 30 * 60_000) });
      setTaskMessageId(f.db, T_A, root, 4242); // bumps updated_at to now, after the view
      const summary = summarizeConversationById(f.db, T_A, root, new Date());
      assert.equal(summary?.answer_landed_at, landedAt);
      assert.equal(summary?.status, 'viewed');
    } finally {
      f.cleanup();
    }
  });
});
