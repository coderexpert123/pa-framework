import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, stat } from 'fs/promises';
import { join } from 'path';
import Database from 'better-sqlite3';
import { createTempPaHome, cleanup } from './helpers.js';
import {
  voiceInboxTerminalTaskIds,
  voiceInboxTaskStates,
  voiceInboxTaskRequests,
  voiceInboxLedgerPath,
  VOICE_INBOX_TERMINAL_STATES,
  voiceInboxConversationState,
  voiceInboxAnsweredSecretRequests,
  voiceInboxRunningWithDispatch,
  voiceInboxInputRequestAuthUrl,
} from '../src/lib/voice-inbox-ledger.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

function ledgerDir(): string {
  return join(tempDir, 'voice-inbox');
}

/** Build a minimal fixture ledger with a `tasks` table, closing the handle
 *  before returning — a still-open handle on Windows turns the afterEach
 *  rm() into a silent no-op (EBUSY), which would let a stale fixture leak
 *  into the next test instead of failing loudly. */
async function buildLedger(rows: Array<{ task_id: string; state: string }>): Promise<void> {
  await mkdir(ledgerDir(), { recursive: true });
  const db = new Database(voiceInboxLedgerPath());
  try {
    db.exec('CREATE TABLE tasks (task_id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO tasks (task_id, state) VALUES (?, ?)');
    for (const row of rows) insert.run(row.task_id, row.state);
  } finally {
    db.close();
  }
}

interface ConversationRow {
  task_id: string;
  conversation_id: string;
  state: string;
  worker_resource?: string | null;
  worker_dispatch_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** Build a v4-shaped fixture ledger (`worker_dispatch_id` column present) for
 *  voiceInboxConversationState tests. Closes the handle before returning —
 *  same Windows-EBUSY rationale as buildLedger above. */
async function buildConversationLedger(rows: ConversationRow[]): Promise<void> {
  await mkdir(ledgerDir(), { recursive: true });
  const db = new Database(voiceInboxLedgerPath());
  try {
    db.exec(`CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      state TEXT NOT NULL,
      worker_resource TEXT,
      worker_dispatch_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    const insert = db.prepare(
      `INSERT INTO tasks (task_id, conversation_id, state, worker_resource, worker_dispatch_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(
        row.task_id,
        row.conversation_id,
        row.state,
        row.worker_resource ?? null,
        row.worker_dispatch_id ?? null,
        row.created_at,
        row.updated_at
      );
    }
  } finally {
    db.close();
  }
}

/** Build a v3-shaped fixture ledger — no `worker_dispatch_id` column at all —
 *  to prove voiceInboxConversationState fails open against a pre-v4 ledger. */
async function buildV3ConversationLedger(rows: Omit<ConversationRow, 'worker_dispatch_id'>[]): Promise<void> {
  await mkdir(ledgerDir(), { recursive: true });
  const db = new Database(voiceInboxLedgerPath());
  try {
    db.exec(`CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      state TEXT NOT NULL,
      worker_resource TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    const insert = db.prepare(
      `INSERT INTO tasks (task_id, conversation_id, state, worker_resource, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(row.task_id, row.conversation_id, row.state, row.worker_resource ?? null, row.created_at, row.updated_at);
    }
  } finally {
    db.close();
  }
}

interface DispatchTaskRow {
  task_id: string;
  tenant_id: string;
  conversation_id: string;
  state: string;
  routed_to?: string | null;
  request_text: string;
  worker_dispatch_id?: string | null;
  updated_at: string;
}

/** Minimal fixture for voiceInboxRunningWithDispatch — a `tasks` table
 *  carrying only the columns that selector reads. `conversation_id` is
 *  `NOT NULL` here, matching the real schema's `NOT NULL DEFAULT ''`
 *  (projects/voice-inbox/src/ledger.ts's LEDGER_SCHEMA_SQL) — this selector
 *  now reads it too (E34, AI-conversation-context WP-3 follow-up). Closes
 *  the handle before returning (same Windows-EBUSY rationale as the other
 *  builders above). */
async function buildDispatchLedger(rows: DispatchTaskRow[]): Promise<void> {
  await mkdir(ledgerDir(), { recursive: true });
  const db = new Database(voiceInboxLedgerPath());
  try {
    db.exec(`CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      state TEXT NOT NULL,
      routed_to TEXT,
      request_text TEXT NOT NULL,
      worker_dispatch_id TEXT,
      updated_at TEXT NOT NULL
    )`);
    const insert = db.prepare(
      `INSERT INTO tasks (task_id, tenant_id, conversation_id, state, routed_to, request_text, worker_dispatch_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(
        row.task_id,
        row.tenant_id,
        row.conversation_id,
        row.state,
        row.routed_to ?? null,
        row.request_text,
        row.worker_dispatch_id ?? null,
        row.updated_at
      );
    }
  } finally {
    db.close();
  }
}

interface AnsweredRequestRow {
  request_id: string;
  task_id: string;
  kind: string;
  status: string;
  answer_pointer?: string | null;
  answered_at?: string | null;
}

/** Minimal fixture for voiceInboxAnsweredSecretRequests — an `input_requests`
 *  table carrying only the columns that selector reads. */
async function buildAnsweredRequestsLedger(rows: AnsweredRequestRow[]): Promise<void> {
  await mkdir(ledgerDir(), { recursive: true });
  const db = new Database(voiceInboxLedgerPath());
  try {
    db.exec(`CREATE TABLE input_requests (
      request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      answer_pointer TEXT,
      answered_at TEXT
    )`);
    const insert = db.prepare(
      `INSERT INTO input_requests (request_id, task_id, kind, status, answer_pointer, answered_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(row.request_id, row.task_id, row.kind, row.status, row.answer_pointer ?? null, row.answered_at ?? null);
    }
  } finally {
    db.close();
  }
}

describe('voiceInboxLedgerPath', () => {
  it('resolves under paHome()/voice-inbox/ledger.sqlite', () => {
    assert.equal(voiceInboxLedgerPath(), join(tempDir, 'voice-inbox', 'ledger.sqlite'));
  });
});

describe('VOICE_INBOX_TERMINAL_STATES', () => {
  it('is exactly the four terminal states', () => {
    assert.deepEqual(
      [...VOICE_INBOX_TERMINAL_STATES].sort(),
      ['cancelled', 'done', 'failed', 'transcribe_failed']
    );
  });
});

describe('voiceInboxTerminalTaskIds', () => {
  it('returns an empty set, never throws, on empty input', () => {
    assert.deepEqual(voiceInboxTerminalTaskIds([]), new Set());
  });

  it('returns an empty set, never throws, when the ledger file is missing', () => {
    const result = voiceInboxTerminalTaskIds(['vi-000000000001']);
    assert.deepEqual(result, new Set());
  });

  it('returns only the terminal ids among the four terminal states plus running', async () => {
    await buildLedger([
      { task_id: 'vi-000000000001', state: 'done' },
      { task_id: 'vi-000000000002', state: 'failed' },
      { task_id: 'vi-000000000003', state: 'cancelled' },
      { task_id: 'vi-000000000004', state: 'transcribe_failed' },
      { task_id: 'vi-000000000005', state: 'running' },
    ]);
    const result = voiceInboxTerminalTaskIds([
      'vi-000000000001',
      'vi-000000000002',
      'vi-000000000003',
      'vi-000000000004',
      'vi-000000000005',
    ]);
    assert.deepEqual(
      result,
      new Set(['vi-000000000001', 'vi-000000000002', 'vi-000000000003', 'vi-000000000004'])
    );
  });

  it('drops malformed ids before they ever reach sqlite', async () => {
    await buildLedger([{ task_id: 'vi-000000000001', state: 'done' }]);
    const result = voiceInboxTerminalTaskIds([
      'vi-000000000001', // valid, terminal
      'not-a-task-id', // malformed: wrong shape entirely
      'vi-shortid', // malformed: not 12 hex chars
      'VI-000000000002', // malformed: wrong case
      'vi-00000000000g', // malformed: non-hex trailing char
    ]);
    assert.deepEqual(result, new Set(['vi-000000000001']));
  });

  it('returns an empty set, never throws, for a schema-less file', async () => {
    await mkdir(ledgerDir(), { recursive: true });
    const db = new Database(voiceInboxLedgerPath());
    db.close(); // a valid, empty sqlite file with no tables at all
    const result = voiceInboxTerminalTaskIds(['vi-000000000001']);
    assert.deepEqual(result, new Set());
  });

  it('opens read-only: the ledger file mtime is unchanged after a call', async () => {
    await buildLedger([{ task_id: 'vi-000000000001', state: 'done' }]);
    const path = voiceInboxLedgerPath();
    const before = (await stat(path)).mtimeMs;
    const result = voiceInboxTerminalTaskIds(['vi-000000000001']);
    assert.deepEqual(result, new Set(['vi-000000000001']));
    const after = (await stat(path)).mtimeMs;
    assert.equal(after, before);
  });
});

/** Minimal fixture for voiceInboxTaskStates — a `tasks` table carrying only
 *  the columns that reader selects (`buildLedger` has no `routed_to` column).
 *  Closes the handle before returning — same Windows-EBUSY rationale as the
 *  other builders above. */
async function buildStateLedger(rows: Array<{ task_id: string; state: string; routed_to?: string | null }>): Promise<void> {
  await mkdir(ledgerDir(), { recursive: true });
  const db = new Database(voiceInboxLedgerPath());
  try {
    db.exec('CREATE TABLE tasks (task_id TEXT PRIMARY KEY, state TEXT NOT NULL, routed_to TEXT)');
    const insert = db.prepare('INSERT INTO tasks (task_id, state, routed_to) VALUES (?, ?, ?)');
    for (const row of rows) insert.run(row.task_id, row.state, row.routed_to ?? null);
  } finally {
    db.close();
  }
}

describe('voiceInboxTaskStates', () => {
  it('returns an empty map, never throws, on empty input', () => {
    assert.deepEqual(voiceInboxTaskStates([]), new Map());
  });

  it('returns an empty map, never throws, when the ledger file is missing', () => {
    const result = voiceInboxTaskStates(['vi-000000000001']);
    assert.deepEqual(result, new Map());
  });

  it('returns {state, routedTo} for matching ids; a well-formed id with no row is ABSENT, never null-valued', async () => {
    await buildStateLedger([
      { task_id: 'vi-000000000001', state: 'routed', routed_to: '-1001234567890_2002' },
      { task_id: 'vi-000000000002', state: 'running' },
    ]);
    const result = voiceInboxTaskStates([
      'vi-000000000001',
      'vi-000000000002',
      'vi-000000000003', // well-formed but no ledger row — must be absent
    ]);
    assert.deepEqual(result.get('vi-000000000001'), { state: 'routed', routedTo: '-1001234567890_2002' });
    assert.deepEqual(result.get('vi-000000000002'), { state: 'running', routedTo: null });
    assert.ok(!result.has('vi-000000000003'), 'unknown ids are absent from the map, not null-valued');
    assert.equal(result.size, 2);
  });

  it('drops malformed ids before they ever reach sqlite', async () => {
    await buildStateLedger([{ task_id: 'vi-000000000001', state: 'routed', routed_to: '-1001234567890_2002' }]);
    const result = voiceInboxTaskStates([
      'vi-000000000001', // valid
      'not-a-task-id', // malformed: wrong shape entirely
      'vi-00000000000g', // malformed: non-hex trailing char
      'VI-000000000002', // malformed: wrong case
    ]);
    assert.equal(result.size, 1);
    assert.deepEqual(result.get('vi-000000000001'), { state: 'routed', routedTo: '-1001234567890_2002' });
  });

  it('returns an empty map, never throws, for a schema-less file', async () => {
    await mkdir(ledgerDir(), { recursive: true });
    const db = new Database(voiceInboxLedgerPath());
    db.close(); // a valid, empty sqlite file with no tables at all
    const result = voiceInboxTaskStates(['vi-000000000001']);
    assert.deepEqual(result, new Map());
  });

  it('opens read-only: the ledger file mtime is unchanged after a call', async () => {
    await buildStateLedger([{ task_id: 'vi-000000000001', state: 'done', routed_to: null }]);
    const path = voiceInboxLedgerPath();
    const before = (await stat(path)).mtimeMs;
    const result = voiceInboxTaskStates(['vi-000000000001']);
    assert.deepEqual(result.get('vi-000000000001'), { state: 'done', routedTo: null });
    const after = (await stat(path)).mtimeMs;
    assert.equal(after, before);
  });
});

describe('voiceInboxTaskRequests', () => {
  /** Minimal request-shaped fixture ledger; closes the handle before returning
   *  (same Windows-EBUSY rationale as buildLedger). */
  async function buildRequestLedger(
    rows: Array<{ task_id: string; source: string; request_text: string; transcript: string | null }>,
  ): Promise<void> {
    await mkdir(ledgerDir(), { recursive: true });
    const db = new Database(voiceInboxLedgerPath());
    try {
      db.exec('CREATE TABLE tasks (task_id TEXT PRIMARY KEY, source TEXT NOT NULL, request_text TEXT NOT NULL, transcript TEXT)');
      const insert = db.prepare('INSERT INTO tasks (task_id, source, request_text, transcript) VALUES (?, ?, ?, ?)');
      for (const row of rows) insert.run(row.task_id, row.source, row.request_text, row.transcript);
    } finally {
      db.close();
    }
  }

  it('returns an empty map, never throws, on empty input', () => {
    assert.deepEqual(voiceInboxTaskRequests([]), new Map());
  });

  it('returns an empty map, never throws, when the ledger file is missing', () => {
    assert.deepEqual(voiceInboxTaskRequests(['vi-000000000001']), new Map());
  });

  it('returns {source, requestText, transcript} per row; an unknown well-formed id is ABSENT', async () => {
    await buildRequestLedger([
      { task_id: 'vi-000000000001', source: 'text', request_text: 'remind me to call the bank', transcript: null },
      { task_id: 'vi-000000000002', source: 'voice', request_text: 'cleaned words', transcript: 'um the raw words' },
    ]);
    const result = voiceInboxTaskRequests(['vi-000000000001', 'vi-000000000002', 'vi-000000000003']);
    assert.deepEqual(result.get('vi-000000000001'), { source: 'text', requestText: 'remind me to call the bank', transcript: null });
    assert.deepEqual(result.get('vi-000000000002'), { source: 'voice', requestText: 'cleaned words', transcript: 'um the raw words' });
    assert.ok(!result.has('vi-000000000003'));
    assert.equal(result.size, 2);
  });

  it('drops malformed ids before they ever reach sqlite', async () => {
    await buildRequestLedger([{ task_id: 'vi-000000000001', source: 'text', request_text: 'hello', transcript: null }]);
    const result = voiceInboxTaskRequests(['vi-000000000001', 'not-a-task-id', 'VI-000000000002']);
    assert.equal(result.size, 1);
  });

  it('returns an empty map, never throws, for a schema-less file', async () => {
    await mkdir(ledgerDir(), { recursive: true });
    new Database(voiceInboxLedgerPath()).close();
    assert.deepEqual(voiceInboxTaskRequests(['vi-000000000001']), new Map());
  });

  it('opens read-only: the ledger file mtime is unchanged after a call', async () => {
    await buildRequestLedger([{ task_id: 'vi-000000000001', source: 'text', request_text: 'hello', transcript: null }]);
    const before = (await stat(voiceInboxLedgerPath())).mtimeMs;
    assert.equal(voiceInboxTaskRequests(['vi-000000000001']).size, 1);
    assert.equal((await stat(voiceInboxLedgerPath())).mtimeMs, before);
  });
});

describe('voiceInboxConversationState', () => {
  const EMPTY_STATE = {
    workerResource: null,
    workerDispatchId: null,
    originTaskId: null,
    taskIds: [],
  };

  it('returns the empty state, never throws, when the ledger file is missing', () => {
    const result = voiceInboxConversationState('vi-000000000001');
    assert.deepEqual(result, EMPTY_STATE);
  });

  it('returns the empty state and never opens the file for a malformed conversation id', async () => {
    // No ledger file or directory created at all: if the implementation ever
    // stopped short-circuiting on the id shape and tried to open the
    // database, `fileMustExist: true` would throw — the fail-open catch would
    // still mask that, so this test's real job is to prove the *shape* check
    // (VALID_TASK_ID_RE) runs before any Database() call, per E-B3's rule.
    const result = voiceInboxConversationState('not-a-conversation-id');
    assert.deepEqual(result, EMPTY_STATE);
  });

  it('returns the newest resource, its dispatch id, its task id, and all ids newest-first', async () => {
    await buildConversationLedger([
      {
        task_id: 'vi-000000000001',
        conversation_id: 'vi-0000000000c1',
        state: 'routed',
        worker_resource: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        task_id: 'vi-000000000002',
        conversation_id: 'vi-0000000000c1',
        state: 'running',
        worker_resource: 'topic--100_5-th1',
        worker_dispatch_id: 'aaaaaaaaaaaa',
        created_at: '2026-01-01T00:00:01.000Z',
        updated_at: '2026-01-01T00:00:01.000Z',
      },
      {
        task_id: 'vi-000000000003',
        conversation_id: 'vi-0000000000c1',
        state: 'done',
        worker_resource: 'topic--100_5-th2',
        worker_dispatch_id: 'bbbbbbbbbbbb',
        created_at: '2026-01-01T00:00:02.000Z',
        updated_at: '2026-01-01T00:00:02.000Z',
      },
    ]);
    const result = voiceInboxConversationState('vi-0000000000c1');
    assert.deepEqual(result, {
      workerResource: 'topic--100_5-th2',
      workerDispatchId: 'bbbbbbbbbbbb',
      originTaskId: 'vi-000000000003',
      taskIds: ['vi-000000000003', 'vi-000000000002', 'vi-000000000001'],
    });
  });

  it('returns nulls with the conversation ids when every task has an empty resource', async () => {
    await buildConversationLedger([
      {
        task_id: 'vi-000000000004',
        conversation_id: 'vi-0000000000c2',
        state: 'routed',
        worker_resource: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        task_id: 'vi-000000000005',
        conversation_id: 'vi-0000000000c2',
        state: 'routed',
        worker_resource: '',
        created_at: '2026-01-01T00:00:01.000Z',
        updated_at: '2026-01-01T00:00:01.000Z',
      },
    ]);
    const result = voiceInboxConversationState('vi-0000000000c2');
    assert.deepEqual(result, {
      workerResource: null,
      workerDispatchId: null,
      originTaskId: null,
      taskIds: ['vi-000000000005', 'vi-000000000004'],
    });
  });

  it('returns the empty state, never throws, against a v3-shaped ledger with no worker_dispatch_id column', async () => {
    await buildV3ConversationLedger([
      {
        task_id: 'vi-000000000006',
        conversation_id: 'vi-0000000000c3',
        state: 'running',
        worker_resource: 'topic--100_5',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const result = voiceInboxConversationState('vi-0000000000c3');
    assert.deepEqual(result, EMPTY_STATE);
  });
});

describe('voice-inbox-ledger — answered secrets and dead-dispatch selectors', () => {
  it('voiceInboxAnsweredSecretRequests: returns an empty array, never throws, when the ledger file is missing', () => {
    assert.deepEqual(voiceInboxAnsweredSecretRequests('2026-01-01T00:00:00.000Z'), []);
  });

  it('voiceInboxAnsweredSecretRequests: returns an empty array, never throws, for a schema-less file', async () => {
    await mkdir(ledgerDir(), { recursive: true });
    const db = new Database(voiceInboxLedgerPath());
    db.close(); // a valid, empty sqlite file with no tables at all
    assert.deepEqual(voiceInboxAnsweredSecretRequests('2026-01-01T00:00:00.000Z'), []);
  });

  it('voiceInboxAnsweredSecretRequests: excludes non-secret kinds, unanswered rows, and rows answered after the cutoff', async () => {
    await buildAnsweredRequestsLedger([
      {
        request_id: 'ir-000000000001',
        task_id: 'vi-000000000101',
        kind: 'secret',
        status: 'answered',
        answer_pointer: '/tmp/p1.txt',
        answered_at: '2026-01-01T00:00:00.000Z',
      },
      {
        // Wrong kind — must be excluded even though otherwise eligible.
        request_id: 'ir-000000000002',
        task_id: 'vi-000000000102',
        kind: 'text',
        status: 'answered',
        answer_pointer: '/tmp/p2.txt',
        answered_at: '2026-01-01T00:00:00.000Z',
      },
      {
        // Right kind, not yet answered — must be excluded.
        request_id: 'ir-000000000003',
        task_id: 'vi-000000000103',
        kind: 'secret',
        status: 'pending',
        answer_pointer: null,
        answered_at: null,
      },
      {
        // Right kind and status, but answered AFTER the cutoff — excluded.
        request_id: 'ir-000000000004',
        task_id: 'vi-000000000104',
        kind: 'secret',
        status: 'answered',
        answer_pointer: '/tmp/p4.txt',
        answered_at: '2026-02-01T00:00:00.000Z',
      },
    ]);
    const result = voiceInboxAnsweredSecretRequests('2026-01-15T00:00:00.000Z');
    assert.deepEqual(result.map((r) => r.request_id), ['ir-000000000001']);
    assert.equal(result[0].answer_pointer, '/tmp/p1.txt');
  });

  it('voiceInboxRunningWithDispatch: returns an empty array, never throws, when the ledger file is missing', () => {
    assert.deepEqual(voiceInboxRunningWithDispatch('2026-01-01T00:00:00.000Z'), []);
  });

  it('voiceInboxRunningWithDispatch: returns an empty array, never throws, for a schema-less file', async () => {
    await mkdir(ledgerDir(), { recursive: true });
    const db = new Database(voiceInboxLedgerPath());
    db.close(); // a valid, empty sqlite file with no tables at all
    assert.deepEqual(voiceInboxRunningWithDispatch('2026-01-01T00:00:00.000Z'), []);
  });

  it('voiceInboxRunningWithDispatch: excludes NULL and empty worker_dispatch_id, and non-running states', async () => {
    await buildDispatchLedger([
      {
        task_id: 'vi-000000000201',
        tenant_id: 't-1',
        conversation_id: 'vi-0000000002c1',
        state: 'running',
        routed_to: '-1009999999999_5',
        request_text: 'a live dispatch',
        worker_dispatch_id: 'dispatch-aaaa',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        // NULL worker_dispatch_id — the C4 control: never a standing auth task.
        task_id: 'vi-000000000202',
        tenant_id: 't-1',
        conversation_id: 'vi-000000000202',
        state: 'running',
        routed_to: '-1009999999999_5',
        request_text: 'a standing auth task',
        worker_dispatch_id: null,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        // Empty-string worker_dispatch_id — same exclusion as NULL.
        task_id: 'vi-000000000203',
        tenant_id: 't-1',
        conversation_id: 'vi-000000000203',
        state: 'running',
        routed_to: '-1009999999999_5',
        request_text: 'an empty-string dispatch id',
        worker_dispatch_id: '',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        // Non-running state, otherwise eligible — must be excluded.
        task_id: 'vi-000000000204',
        tenant_id: 't-1',
        conversation_id: 'vi-000000000204',
        state: 'routed',
        routed_to: '-1009999999999_5',
        request_text: 'not running yet',
        worker_dispatch_id: 'dispatch-bbbb',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const result = voiceInboxRunningWithDispatch('2026-01-15T00:00:00.000Z');
    assert.deepEqual(result.map((r) => r.task_id), ['vi-000000000201']);
    assert.equal(result[0].worker_dispatch_id, 'dispatch-aaaa');
    // E34: the selector now carries conversation_id — a same-value control
    // (vi-000000000202/203/204 all use their own task_id as conversation_id)
    // would silently pass even if the column read the wrong value, so this
    // fixture deliberately roots vi-000000000201 in a DIFFERENT conversation
    // id than its own task_id.
    assert.equal(result[0].conversation_id, 'vi-0000000002c1');
  });
});

/** Minimal fixture for voiceInboxInputRequestAuthUrl — an `input_requests`
 *  table carrying only `request_id` + `params_json`, the columns that
 *  selector reads. */
async function buildAuthUrlLedger(rows: Array<{ request_id: string; params_json: string }>): Promise<void> {
  await mkdir(ledgerDir(), { recursive: true });
  const db = new Database(voiceInboxLedgerPath());
  try {
    db.exec('CREATE TABLE input_requests (request_id TEXT PRIMARY KEY, params_json TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO input_requests (request_id, params_json) VALUES (?, ?)');
    for (const row of rows) insert.run(row.request_id, row.params_json);
  } finally {
    db.close();
  }
}

describe('voiceInboxInputRequestAuthUrl (auth broker, deep-recheck 2026-09-10)', () => {
  const REQUEST_ID = 'ir-0123456789ab';
  const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y';

  it('returns null, never throws, for a malformed request id (never reaches sqlite)', () => {
    assert.equal(voiceInboxInputRequestAuthUrl('not-a-request-id'), null);
  });

  it('returns null, never throws, when the ledger file is missing', () => {
    assert.equal(voiceInboxInputRequestAuthUrl(REQUEST_ID), null);
  });

  it('returns null, never throws, for a schema-less file', async () => {
    await mkdir(ledgerDir(), { recursive: true });
    const db = new Database(voiceInboxLedgerPath());
    db.close(); // a valid, empty sqlite file with no tables at all
    assert.equal(voiceInboxInputRequestAuthUrl(REQUEST_ID), null);
  });

  it('returns null when no row matches the request id', async () => {
    await buildAuthUrlLedger([{ request_id: 'ir-999999999999', params_json: JSON.stringify({ auth_url: AUTH_URL }) }]);
    assert.equal(voiceInboxInputRequestAuthUrl(REQUEST_ID), null);
  });

  it('returns null when params_json is torn (unparseable)', async () => {
    await buildAuthUrlLedger([{ request_id: REQUEST_ID, params_json: '{not json' }]);
    assert.equal(voiceInboxInputRequestAuthUrl(REQUEST_ID), null);
  });

  it('returns null when auth_url is absent or not a string', async () => {
    await buildAuthUrlLedger([{ request_id: REQUEST_ID, params_json: JSON.stringify({ provider: 'google' }) }]);
    assert.equal(voiceInboxInputRequestAuthUrl(REQUEST_ID), null);
  });

  it('returns null when auth_url does not start with https:// — the same gate the PWA applies', async () => {
    await buildAuthUrlLedger([
      { request_id: REQUEST_ID, params_json: JSON.stringify({ auth_url: 'javascript:alert(1)' }) },
    ]);
    assert.equal(voiceInboxInputRequestAuthUrl(REQUEST_ID), null);
  });

  it('returns the auth_url from params_json for a real oauth row', async () => {
    await buildAuthUrlLedger([{ request_id: REQUEST_ID, params_json: JSON.stringify({ provider: 'google', auth_url: AUTH_URL }) }]);
    assert.equal(voiceInboxInputRequestAuthUrl(REQUEST_ID), AUTH_URL);
  });
});
