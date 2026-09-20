/**
 * Voice-inbox tenant-scoped task ledger (AI-201).
 *
 * better-sqlite3, WAL + busy_timeout 3000 — the decisions.sqlite precedent.
 * The SQL block below IS the schema contract: the python worker scripts open
 * this same file and their sync test pins them byte-for-byte to THIS text —
 * edit only with that in mind. Schema v2 (AI-213) added the transcribing /
 * transcribe_failed states and the task.transcribed event kind; SQLite
 * cannot ALTER a CHECK, so openLedger rebuilds the two CHECK-bearing tables
 * inside ONE transaction when a v1 file is opened (migrateLegacyChecks below
 * — gated on `user_version` and a sqlite_master marker, so it is idempotent
 * and a torn migration cannot exist), and the `user_version` write is
 * CONDITIONAL: it fires only when the current value is lower, because an
 * unconditional write would demote a future v3 database back to v2 on every
 * open. Schema v3 adds `conversation_id` and `worker_resource` — two plain
 * additive columns that touch no CHECK constraint, so a straight `ALTER
 * TABLE ADD COLUMN` (migrateAddV3Columns below) is the whole migration; the
 * heavy v1→v2 CHECK-rebuild pattern above is deliberately NOT the model for
 * an additive change like this one. A future additive column repeats v3's
 * pattern; a future CHECK-list change repeats v2's rebuild-and-conditional-
 * bump pattern instead. Schema v4 adds steer_mode and worker_dispatch_id by
 * exactly that pattern. Schema v5 (AI-222) adds a third migration pattern: a
 * NEW table (`conversation_meta`), which `CREATE TABLE IF NOT EXISTS` inside
 * openLedger's existing double `db.exec(LEDGER_SCHEMA_SQL)` call applies with
 * no migration function at all — unlike v2's CHECK rebuild and v3/v4's
 * additive columns, a new table needs neither a rebuild nor an ALTER. Schema
 * v6 (AI-227) repeats v5's new-table pattern exactly: `conversation_shares`.
*  Schema v7 (feedback long-press, 2026-09-13) repeats v4's additive-column
 *  pattern exactly: `tasks.feedback_about`. Schema v14 (thread lifecycle,
 *  2026-09-17) repeats it for `tasks.retried_by` and
 *  `conversation_meta.viewed_at`, plus one data step: stampPreV14Views.
 *  Schema v15 (answer provenance, 2026-09-18) repeats the additive pattern
 *  exactly for `tasks.worker_cli`, `tasks.worker_model` and
 *  `tasks.worker_effort` — the provenance a dispatching session stamps into
 *  the worker's env at spawn, written by the worker at each task.progress;
 *  NULL on every pre-v15 row and on any task whose runs never stamped.
 *
 * Two invariants this module owns:
 *  1. The task state machine — the transition table below is the ONLY gate a
 *     state change passes; illegal transitions throw and leave state
 *     untouched (checked inside the same transaction as the write).
 *  2. Tenant scoping — every query that touches tenant data takes tenant_id
 *     as a parameter and filters on it. There is no un-scoped accessor for
 *     tasks/input_requests/events. (The sessions and pairing_codes tables
 *     have no tenant_id column by design — their lookup keys are hashes; the
 *     identity layer that reads them is a later work package.)
 */

import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  EVENT_SUMMARY_MAX,
  INPUT_KINDS,
  isTaskEventKind,
  validateInputRequest,
  type InputKind,
  type TaskEventKind,
} from './contracts.js';
import {
  deriveThreadStatus,
  isUnresolvedFailure,
  RECENT_WINDOW_MS,
  THREAD_STATUS_WORDS,
  VIEWED_WINDOW_MS,
  type ThreadBand,
  type ThreadStatusToken,
} from './thread-status.js';

export const LEDGER_SCHEMA_VERSION = 16;

// --- Schema v3 — the contract; byte-synced by the python worker tests --------
// Do not reformat, re-indent, or "clean up" the SQL below: its exact text is
// an assertion target.

export const LEDGER_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT PRIMARY KEY,           -- 't-<telegram_user_id>'
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id INTEGER NOT NULL,
  display_name     TEXT,
  created_at       TEXT NOT NULL               -- ISO-8601 Z
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,             -- 'vi-<12 hex>'
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  source         TEXT NOT NULL CHECK (source IN ('voice','text')),
  transcript     TEXT,                         -- voice only; text tasks NULL
  request_text   TEXT NOT NULL,                -- what the operator asked (text or transcript)
  state          TEXT NOT NULL CHECK (state IN
                   ('received','transcribing','routed','running','awaiting_input','transcribe_failed','done','failed','cancelled')),
  routed_to      TEXT,                         -- '<chatId>_<threadId>' topic key
  routing_reason TEXT,
  result_summary TEXT,                         -- filled by task_complete.py
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '', -- v3: the conversation's root task_id; createTask always sets it
  worker_resource TEXT,                     -- v3: PA_WORKER_RESOURCE of the worker executing this task
  worker_dispatch_id TEXT,                  -- v4: PA_WORKER_DISPATCH_ID — identifies the DISPATCH, not the lane
  steer_mode      TEXT,                     -- v4: 'queue' | 'interrupt' when this task was recorded as a steer
  feedback_about  TEXT,                     -- v7: 'vi-<12 hex>' conversation or task this feedback is about; set only via POST /tasks, NULL otherwise
  result_short    TEXT,                     -- v8: worker-written standalone short summary (the card's IN SHORT lead); NEVER capped or trimmed
  suggested_items TEXT,                     -- v10: AI-234 worker-written quick-reply chip labels (JSON array); plain product language only
  tg_message_id   INTEGER,                  -- v11: AI-218 Telegram message_id of the FYI reply the bot posted to the topic; the deep-link anchor (NULL until the bot captures it post-send)
  result_structured TEXT,                    -- v12: worker-written structured answer data (JSON); NULL when absent, falls back to markdown
  surface        TEXT,                       -- v13: 'phone' | 'desktop' — the viewport class the question was asked FROM, captured once at creation; NULL on every pre-v13 row and on any client that omits it. A layout preference only, never a content gate
  retried_by     TEXT,                       -- v14: the retry task created from this failed task (Retry in the app); NULL while unresolved. Set only by createTask in the same transaction that creates the retry
  worker_cli      TEXT,                      -- v15: the worker CLI that ran this task (e.g. 'zclaude'); NULL on pre-v15 rows and runs that never stamped progress
  worker_model    TEXT,                      -- v15: the resolved model string for that run; NULL until the worker stamps identity
  worker_effort   TEXT,                      -- v15: the resolved effort tier for that run; NULL when unset or uninstrumented
  router_decision TEXT,                      -- v16: PA_ROUTING_DECISION ('router' | 'ladder' | 'command') — who picked the serving turn's worker; NULL when uninstrumented
  router_placement TEXT,                     -- v16: PA_ROUTING_PLACEMENT ('continued-here' | 'diverted' | 'new-conversation' | 'split'); NULL = no placement fact for the serving turn
  router_target   TEXT,                      -- v16: PA_ROUTING_TARGET — the ORIGIN conversation id ('vi-<12 hex>') on a placed turn's destination leg; ids only, never turn text
  router_steer    TEXT,                      -- v16: PA_ROUTING_STEER ('steer' | 'wait'); NULL when the turn did not interact with a running task
  router_steer_by TEXT,                      -- v16: PA_ROUTING_STEER_BY ('router' | 'operator') — who made the steer/wait call; stamped only alongside router_steer
  router_effort_proj TEXT,                   -- v16: PA_ROUTING_EFFORT_PROJ ('applied' | 'nearest' | 'recategorize'); NULL when no effort projection applied
  router_failovers INTEGER                    -- v16: PA_ROUTING_FAILOVERS — dispatches that failed before the serving hop; NULL when absent (uninstrumented, or first attempt served)
);
CREATE INDEX IF NOT EXISTS tasks_tenant_created ON tasks(tenant_id, created_at DESC);
CREATE TABLE IF NOT EXISTS input_requests (
  request_id     TEXT PRIMARY KEY,             -- 'ir-<12 hex>'
  task_id        TEXT NOT NULL REFERENCES tasks(task_id),
  tenant_id      TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('secret','text','choice','oauth','file','confirm','form')),
  prompt         TEXT NOT NULL,                -- model-written copy, 1..500 chars
  params_json    TEXT NOT NULL DEFAULT '{}',   -- per-kind params (§4); NEVER an answer value
  status         TEXT NOT NULL CHECK (status IN
                   ('pending','answered','expired','cancelled')),
  answer_pointer TEXT,                         -- path under ~/.pa/voice-inbox/ ; never the value
  created_at     TEXT NOT NULL,
  answered_at    TEXT
);
CREATE INDEX IF NOT EXISTS inputs_task_status ON input_requests(task_id, status);
CREATE TABLE IF NOT EXISTS events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  ref_id       TEXT NOT NULL,                  -- 's-<12 hex>', minted by the writer
  kind         TEXT NOT NULL CHECK (kind IN
                 ('task.received','task.routed','task.progress','task.input_needed',
                  'task.input_received','task.result_ready','task.completed',
                  'task.failed','task.cancelled','task.rerouted','task.transcribed')),
  summary      TEXT,                           -- model-phrased plain language, ≤200 chars
  payload_json TEXT NOT NULL DEFAULT '{}',     -- structured facts, redacted, never secrets
  ts           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task_ts ON events(task_id, event_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,               -- sha256 hex of the bearer token
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash        TEXT PRIMARY KEY,           -- sha256 hex of the 8-char code
  telegram_user_id INTEGER NOT NULL,
  telegram_chat_id INTEGER NOT NULL,
  first_name       TEXT,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,              -- +10 min
  consumed_at      TEXT
);
CREATE TABLE IF NOT EXISTS conversation_meta (
  conversation_id TEXT PRIMARY KEY,           -- v5: the conversation's root task_id ('vi-<12 hex>')
  tenant_id       TEXT NOT NULL,
  title           TEXT,                       -- v5: worker-set noun phrase, <=60 chars; NULL means the client derives one
  recap           TEXT,                       -- v5: worker-set state sentences, <=400 chars; NULL means the client derives one
  next_action     TEXT,                       -- v5: worker-set action line, <=200 chars; NULL means none
  updated_at      TEXT NOT NULL,
  viewed_at       TEXT                        -- v14: ISO Z time the operator first viewed the current answer; NULL = never viewed. Written only by POST /conversations/:id/viewed and the v14 migration
);
CREATE INDEX IF NOT EXISTS conversation_meta_tenant ON conversation_meta(tenant_id);
CREATE TABLE IF NOT EXISTS conversation_shares (
  token           TEXT PRIMARY KEY,           -- base64url(randomBytes(32)); stored raw by deliberate design (read-only passive grant, not account auth)
  tenant_id       TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  revoked_at      TEXT
);
CREATE INDEX IF NOT EXISTS conversation_shares_lookup
  ON conversation_shares(tenant_id, conversation_id, revoked_at);`;

// --- LIKE search helpers (archive `q` filter, 2026-09-15) ----------------------

/** Escapes LIKE wildcard characters for use with ESCAPE '!'.
 *  `%` → `!%`, `_` → `!_`, `!` → `!!`. */
function escapeLike(s: string): string {
  return s.replace(/[%_!]/g, '!$&');
}

/** Wraps an escaped term as a LIKE contains-pattern: `%term%`. */
function likeTerm(term: string): string {
  return '%' + escapeLike(term) + '%';
}

// --- Ids and timestamps ------------------------------------------------------

/** `vi-<12 hex>` — minted by the TS writer (API task creation). */
export function mintTaskId(): string {
  return `vi-${randomBytes(6).toString('hex')}`;
}

/** `ir-<12 hex>` — input request id. */
export function mintRequestId(): string {
  return `ir-${randomBytes(6).toString('hex')}`;
}

/** `s-<12 hex>` — the ref-ID every event carries (minted by its writer). */
export function makeRefId(): string {
  return `s-${randomBytes(6).toString('hex')}`;
}

/** Tenant id derived from the Telegram user id: `t-<telegram_user_id>`. */
export function tenantIdForTelegramUser(telegramUserId: number | string): string {
  return `t-${telegramUserId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// --- Errors ------------------------------------------------------------------

export type LedgerErrorCode =
  | 'tenant-not-found'
  | 'task-not-found'
  | 'request-not-found'
  | 'request-already-answered'
  | 'illegal-transition'
  | 'invalid-input';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

// --- Task state machine (§3) --------------------------------------------------

export const TASK_STATES = [
  'received',
  'transcribing',
  'routed',
  'running',
  'awaiting_input',
  'transcribe_failed',
  'done',
  'failed',
  'cancelled',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/**
 * Legal task-state transitions. The spec pins the sources it pins ("from
 * routed", "from running"); the unpinned rows are encoded as: `→routed`
 * (reroute) from every non-terminal state — the reroute-while-in-flight case
 * the spec's risk register describes; `→failed`/`→cancelled` from every other
 * non-terminal state and `→done` from routed and running — a worker may finish
 * or fail from an active stage and the operator may cancel any live task.
 *
 * v14 (thread lifecycle, 2026-09-17): `awaiting_input → done` is gone — closing
 * an asking task dropped the operator's question. A worker withdraws the ask
 * (task_input.py cancel → running) or waits for the answer, then completes.
 * done and cancelled are terminal. failed and transcribe_failed have exactly
 * one outgoing edge, `→cancelled`: the operator's dismissal through the API
 * (no worker script writes `cancelled`), so nothing ever resumes a failure — a
 * Retry creates a NEW task (createTask `retryOf`) and the failure stays history.
 *
 * The transcribing stage is the deliberate exception set: it has exactly two
 * outcomes plus operator cancel — transcript written (`→received`) or
 * transcription failed (`→transcribe_failed`, the failure state of THIS
 * stage). `→routed` is excluded (route_task.py refuses it anyway; a reroute
 * mid-transcription would desync audio + queue), `→done`/`→failed` are
 * excluded (a task cannot finish or fail generically before its request text
 * exists). A `transcribe_failed` recording never resumes either: its Retry is a
 * new `transcribing` task carrying the same audio.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  // 'running' is the transcribed-while-worker-already-progressing shortcut:
  // a task.progress event can move a `received` task straight to `running`.
  received: ['routed', 'running', 'failed', 'cancelled'],
  transcribing: ['received', 'transcribe_failed', 'cancelled'],
  routed: ['routed', 'running', 'done', 'failed', 'cancelled'],
  running: ['routed', 'awaiting_input', 'done', 'failed', 'cancelled'],
  awaiting_input: ['routed', 'running', 'failed', 'cancelled'],
  transcribe_failed: ['cancelled'],
  done: [],
  failed: ['cancelled'],
  cancelled: [],
};

/**
 * Which event kind may accompany a transition to each target state (§3's
 * state-machine table: every writer writes the state and its paired event in
 * one place). `→routed` accepts both the first routing and a reroute.
 */
const TRANSITION_EVENT_KINDS: Readonly<Record<TaskState, readonly TaskEventKind[]>> = {
  // INSERT still writes task.received directly at creation; the →received
  // transition (transcription write-back) carries task.transcribed.
  received: ['task.transcribed'],
  transcribing: ['task.transcribed'],
  routed: ['task.routed', 'task.rerouted'],
  running: ['task.progress', 'task.input_received'],
  awaiting_input: ['task.input_needed'],
  transcribe_failed: ['task.failed'],
  done: ['task.completed'],
  failed: ['task.failed'],
  cancelled: ['task.cancelled'],
};

function assertTransition(from: TaskState, to: TaskState): void {
  const allowed = TASK_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new LedgerError('illegal-transition', `illegal task state transition: ${from} -> ${to}`);
  }
}

// --- Open / migrate ------------------------------------------------------------

// --- v1 → v2 migration (AI-213) ------------------------------------------------
// SQLite cannot ALTER a CHECK: each CHECK-bearing table is rebuilt (create →
// copy → drop → rename) inside ONE transaction, so a torn migration cannot
// exist. Each rebuild is gated on its own marker being absent from the
// table's sqlite_master.sql, so the pair is a no-op once either new
// vocabulary has landed and on any database already at user_version >=
// LEDGER_SCHEMA_VERSION (the guard in migrateLegacyChecks below compares
// against the constant, not a hardcoded number — it stays correct as the
// version rises).

/** v1 → v2 rebuild of `tasks` (marker: 'transcribing'). */
const TASKS_V2_REBUILD_SQL = `-- tasks rebuild (marker: 'transcribing')
CREATE TABLE tasks_v2_rebuild (
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
INSERT INTO tasks_v2_rebuild
  (task_id, tenant_id, source, transcript, request_text, state, routed_to, routing_reason, result_summary, created_at, updated_at)
SELECT task_id, tenant_id, source, transcript, request_text, state, routed_to, routing_reason, result_summary, created_at, updated_at
  FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_v2_rebuild RENAME TO tasks;`;

/** v1 → v2 rebuild of `events` (marker: 'task.transcribed'). */
const EVENTS_V2_REBUILD_SQL = `-- events rebuild (marker: 'task.transcribed')
CREATE TABLE events_v2_rebuild (
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
INSERT INTO events_v2_rebuild (event_id, tenant_id, task_id, ref_id, kind, summary, payload_json, ts)
SELECT event_id, tenant_id, task_id, ref_id, kind, summary, payload_json, ts FROM events;
DROP TABLE events;
ALTER TABLE events_v2_rebuild RENAME TO events;`;

function getUserVersion(db: Database.Database): number {
  return Number(db.pragma('user_version', { simple: true }));
}

/**
 * Rebuild the CHECK-bearing tables of a pre-v2 database (no-op on
 * user_version >= LEDGER_SCHEMA_VERSION, or when both markers are already
 * present — true of every v2+ database, so this is a harmless re-check on a
 * v2 database being additionally migrated to v3).
 */
function migrateLegacyChecks(db: Database.Database): void {
  if (getUserVersion(db) >= LEDGER_SCHEMA_VERSION) return;
  const tableSql = (name: string): string | undefined =>
    ((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
      | { sql: string | null }
      | undefined)?.sql ?? undefined);
  const tasksSql = tableSql('tasks');
  const eventsSql = tableSql('events');
  const rebuildTasks = tasksSql !== undefined && !tasksSql.includes('transcribing');
  const rebuildEvents = eventsSql !== undefined && !eventsSql.includes('task.transcribed');
  if (!rebuildTasks && !rebuildEvents) return;
  // SQLite DDL is transactional — both rebuilds land together or not at all.
  db.transaction(() => {
    if (rebuildTasks) db.exec(TASKS_V2_REBUILD_SQL);
    if (rebuildEvents) db.exec(EVENTS_V2_REBUILD_SQL);
  })();
}

/** Write `user_version` only when the current value is lower — never demote. */
function setUserVersion(db: Database.Database): void {
  if (getUserVersion(db) >= LEDGER_SCHEMA_VERSION) return;
  db.pragma(`user_version = ${LEDGER_SCHEMA_VERSION}`);
}

/**
 * v2 → v3: two additive columns. Neither changes a CHECK, so a plain ALTER
 * TABLE ADD COLUMN works and the heavy v1→v2 rebuild is deliberately NOT the
 * model here. Idempotency is its own PRAGMA table_info probe (the CHECK-body
 * marker trick migrateLegacyChecks uses cannot see an additive column).
 * SQLite refuses a NOT NULL ADD COLUMN without a non-null default, so
 * conversation_id carries DEFAULT '' in the fresh schema too — the created
 * and migrated shapes stay identical. The backfill runs unconditionally: it is
 * cheap, idempotent, and also repairs a row that somehow reached ''.
 */
function migrateAddV3Columns(db: Database.Database): void {
  const columns = new Set(
    (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name)
  );
  if (!columns.has('conversation_id')) {
    db.exec("ALTER TABLE tasks ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has('worker_resource')) {
    db.exec('ALTER TABLE tasks ADD COLUMN worker_resource TEXT');
  }
  db.prepare("UPDATE tasks SET conversation_id = task_id WHERE conversation_id = ''").run();
}

/**
 * v3 → v4: two additive, nullable columns. Same pattern as v3 (its own
 * PRAGMA table_info probe for idempotency; the CHECK-body marker trick
 * migrateLegacyChecks uses cannot see an additive column). Nullable, so no
 * DEFAULT is needed and no backfill is owed: a task created before v4 was
 * never recorded as a steer and its dispatch identity was never captured,
 * and NULL says exactly that. ORDER MATTERS — worker_dispatch_id is added
 * first so a migrated ledger's column order matches LEDGER_SCHEMA_SQL's.
 */
function migrateAddV4Columns(db: Database.Database): void {
  const columns = new Set(
    (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name)
  );
  if (!columns.has('worker_dispatch_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN worker_dispatch_id TEXT');
  }
  if (!columns.has('steer_mode')) {
    db.exec('ALTER TABLE tasks ADD COLUMN steer_mode TEXT');
  }
}

/**
 * v6 → v7: one additive, nullable column (the v3/v4 pattern: its own PRAGMA
 * table_info probe; nullable so no DEFAULT and no backfill — a task created
 * before v7 was never feedback, and NULL says exactly that).
 */
function migrateAddV7Column(db: Database.Database): void {
  const columns = new Set(
    (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name)
  );
  if (!columns.has('feedback_about')) {
    db.exec('ALTER TABLE tasks ADD COLUMN feedback_about TEXT');
  }
}

/**
 * v7 → v8: one additive, nullable column (the v3/v4/v7 pattern: its own
 * PRAGMA table_info probe; nullable so no DEFAULT and no backfill — a task
 * completed before v8 has no stored short summary, and NULL says exactly
 * that; the PWA falls back to its uncapped deterministic lead for those
 * rows). result_short is NEVER clamped or trimmed by any writer — the
 * uncapped-short contract is the reason this column exists.
 */
function migrateAddV8Column(db: Database.Database): void {
  const columns = new Set(
    (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name)
  );
  if (!columns.has('result_short')) {
    db.exec('ALTER TABLE tasks ADD COLUMN result_short TEXT');
  }
}

/**
 * v9 → v10: one additive, nullable column (the v3/v4/v7/v8 pattern: its own
 * PRAGMA table_info probe; nullable so no DEFAULT and no backfill — a task
 * completed before v10 has no stored chips, and NULL says exactly that; the
 * PWA renders no chip row when the column is NULL or empty). suggested_items
 * stores a JSON array of plain-language chip labels the worker emitted in
 * the same task_complete.py call as the answer (AI-234).
 */
function migrateAddV10Column(db: Database.Database): void {
  const columns = new Set(
    (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name)
  );
  if (!columns.has('suggested_items')) {
    db.exec('ALTER TABLE tasks ADD COLUMN suggested_items TEXT');
  }
}

/**
 * v10 → v11: one additive, nullable column (the v3/v4/v7/v8/v10 pattern: its
 * own PRAGMA table_info probe; nullable so no DEFAULT and no backfill — a task
 * whose FYI reply has not been sent yet, or one the bot never reaches, has no
 * captured Telegram message_id, and NULL says exactly that). `tg_message_id`
 * is the Telegram message_id of the FYI reply the bot posted to the routed
 * topic; the voice-inbox deep link appends `/<tg_message_id>` to navigate
 * straight to that message (AI-218). The bot captures it from the
 * `sendMessage` response at the reply-send site and writes it back via
 * scripts/task_set_message_id.py.
 *
 * DEFERRED display path (routes.ts — BLOCKED this wave, another active session
 * owns it): `telegramLink()` at routes.ts:152-159 currently builds
 * `https://t.me/c/${chatStr.slice(4)}/${target.threadId}` with the comment
 * "no message anchor this wave — follow-up F1". The deferred change appends
 * `/${row.tg_message_id}` when the task row carries a non-null tg_message_id:
 *
 *   function telegramLink(routedTo: string | null, tgMessageId: number | null): string | null {
 *     if (routedTo === null) return null;
 *     const target = splitTopicKey(routedTo);
 *     if (!target) return null;
 *     const chatStr = String(target.chatId);
 *     if (!chatStr.startsWith('-100')) return null;
 *     const base = `https://t.me/c/${chatStr.slice(4)}/${target.threadId}`;
 *     return tgMessageId ? `${base}/${tgMessageId}` : base;
 *   }
 *
 * and every call site passes the task row's `tg_message_id` as the second
 * argument. The "no message anchor" comment is retired with this change.
 */
function migrateAddV11Column(db: Database.Database): void {
  const columns = new Set(
    (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name)
  );
  if (!columns.has('tg_message_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN tg_message_id INTEGER');
  }
}

/**
 * v11 → v12: one additive, nullable column (the v3/v4/v7/v8/v10/v11 pattern:
 * its own PRAGMA table_info probe; nullable so no DEFAULT and no backfill — a
 * task completed before v12 has no structured answer data, and NULL says
 * exactly that; the PWA falls back to markdown for those rows).
 * result_structured stores a JSON string the worker emitted via
 * task_complete.py --structured; the PWA's presentation layer reads it to
 * choose a renderer (comparison, listing, guide, form-set, summary), falling
 * back to markdown when absent or unparseable.
 */
function migrateAddV12Column(db: Database.Database): void {
  const columns = new Set(
    (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name)
  );
  if (!columns.has('result_structured')) {
    db.exec('ALTER TABLE tasks ADD COLUMN result_structured TEXT');
  }
}

/**
 * v12 → v13: one additive, nullable column (the v3/v4/v7/v8/v10/v11/v12
 * pattern: its own PRAGMA table_info probe; nullable so no DEFAULT and no
 * backfill). `surface` is the viewport class of the device the question was
 * asked FROM — 'phone' or 'desktop', decided once by the PWA at creation
 * time and never recomputed. NULL is the honest value for every task created
 * before v13 and for any client that does not send the hint, and NULL renders
 * exactly as it did pre-P6: the PWA adds no layout class and the CSS media
 * query alone decides. The column is a LAYOUT PREFERENCE and never a content
 * gate (SPEC §6.3) — the same information is on the row whatever it says.
 */
function migrateAddV13Column(db: Database.Database): void {
  const columns = new Set(
    (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name)
  );
  if (!columns.has('surface')) {
    db.exec('ALTER TABLE tasks ADD COLUMN surface TEXT');
  }
}

/**
 * v13 → v14: two additive, nullable columns on two tables (the v3/v4/v7…v13
 * pattern: their own PRAGMA table_info probes, no DEFAULT, no backfill).
 * `tasks.retried_by` is NULL until the operator retries a failure;
 * `conversation_meta.viewed_at` is NULL until the operator views an answer
 * (stampPreV14Views below is the one data step). ORDER MATTERS for the
 * column-order pins: each is the LAST column of its table.
 */
function migrateAddV14Columns(db: Database.Database): void {
  const taskColumns = new Set(
    (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name)
  );
  if (!taskColumns.has('retried_by')) {
    db.exec('ALTER TABLE tasks ADD COLUMN retried_by TEXT');
  }
  const metaColumns = new Set(
    (db.pragma('table_info(conversation_meta)') as Array<{ name: string }>).map((c) => c.name)
  );
  if (!metaColumns.has('viewed_at')) {
    db.exec('ALTER TABLE conversation_meta ADD COLUMN viewed_at TEXT');
  }
}

/**
 * v14 → v15: three additive, nullable columns on `tasks` (the v3/v4/v7…v14
 * pattern: own PRAGMA table_info probe, no DEFAULT, no backfill). They hold
 * the answer's provenance — CLI, resolved model and effort — stamped by the
 * dispatching session's env and written by the worker at each task.progress.
 * NULL says exactly that the row predates v15 or never stamped. ORDER MATTERS:
 * added in the same order as LEDGER_SCHEMA_SQL so a migrated ledger's column
 * tail matches a fresh one.
 */
function migrateAddV15Provenance(db: Database.Database): void {
  const columns = new Set(
    (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name)
  );
  if (!columns.has('worker_cli')) {
    db.exec('ALTER TABLE tasks ADD COLUMN worker_cli TEXT');
  }
  if (!columns.has('worker_model')) {
    db.exec('ALTER TABLE tasks ADD COLUMN worker_model TEXT');
  }
  if (!columns.has('worker_effort')) {
    db.exec('ALTER TABLE tasks ADD COLUMN worker_effort TEXT');
  }
}

/**
 * v15 → v16: six additive, nullable columns on `tasks` (the v3/v4/…/v15
 * pattern: own PRAGMA table_info probe, no DEFAULT, no backfill). They hold
 * the serving turn's routing metadata — who picked the worker, any placement
 * carry, steer/wait, effort projection and the count of dispatches that
 * failed before the serving hop — stamped via the PA_ROUTING_* env keys and
 * written by task_telemetry.py at each task.progress in the SAME UPDATE as
 * the worker_* provenance. NULL says exactly that the row predates v16 or
 * never stamped. ORDER MATTERS: added in the same order as LEDGER_SCHEMA_SQL
 * so a migrated ledger's column tail matches a fresh one.
 */
function migrateAddV16RoutingMetadata(db: Database.Database): void {
  const columns = new Set(
    (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name)
  );
  if (!columns.has('router_decision')) {
    db.exec('ALTER TABLE tasks ADD COLUMN router_decision TEXT');
  }
  if (!columns.has('router_placement')) {
    db.exec('ALTER TABLE tasks ADD COLUMN router_placement TEXT');
  }
  if (!columns.has('router_target')) {
    db.exec('ALTER TABLE tasks ADD COLUMN router_target TEXT');
  }
  if (!columns.has('router_steer')) {
    db.exec('ALTER TABLE tasks ADD COLUMN router_steer TEXT');
  }
  if (!columns.has('router_steer_by')) {
    db.exec('ALTER TABLE tasks ADD COLUMN router_steer_by TEXT');
  }
  if (!columns.has('router_effort_proj')) {
    db.exec('ALTER TABLE tasks ADD COLUMN router_effort_proj TEXT');
  }
  if (!columns.has('router_failovers')) {
    db.exec('ALTER TABLE tasks ADD COLUMN router_failovers INTEGER');
  }
}

/**
 * v13 → v14 data step, run ONCE (only while user_version < 14, before the
 * bump) — operator decision D2, 2026-09-17. Every thread holding a done task
 * whose last update is more than RECENT_WINDOW_MS (24 h) before migration gets
 * conversation_meta.viewed_at = its newest done task's answer-landed time, so
 * pre-wave history enters Older conversations instead of surfacing as Ready
 * rows; the phone uploads its own read marks for the recent rest. A thread
 * that already has a view time is left alone, and conversation_meta.updated_at
 * is written only when this step inserts the row.
 */
function stampPreV14Views(db: Database.Database, now: Date): void {
  if (getUserVersion(db) >= 14) return;
  const cutoffIso = new Date(now.getTime() - RECENT_WINDOW_MS).toISOString();
  const insertedAt = now.toISOString();
  db.transaction(() => {
    const threads = db
      .prepare(
        `SELECT tenant_id, conversation_id FROM tasks
         GROUP BY tenant_id, conversation_id
         HAVING SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) > 0 AND MAX(updated_at) < ?`
      )
      .all(cutoffIso) as Array<{ tenant_id: string; conversation_id: string }>;
    for (const thread of threads) {
      const done = db
        .prepare(
          `SELECT task_id, updated_at FROM tasks
           WHERE tenant_id = ? AND conversation_id = ? AND state = 'done'
           ORDER BY created_at DESC, task_id DESC LIMIT 1`
        )
        .get(thread.tenant_id, thread.conversation_id) as { task_id: string; updated_at: string };
      const landedAt =
        taskStatusInputsFor(db, thread.tenant_id, [done.task_id]).get(done.task_id)?.completed_at ?? done.updated_at;
      db.prepare(
        `INSERT OR IGNORE INTO conversation_meta (conversation_id, tenant_id, updated_at)
         VALUES (?, ?, ?)`
      ).run(thread.conversation_id, thread.tenant_id, insertedAt);
      db.prepare(
        `UPDATE conversation_meta SET viewed_at = ?
         WHERE conversation_id = ? AND tenant_id = ? AND viewed_at IS NULL`
      ).run(landedAt, thread.conversation_id, thread.tenant_id);
    }
  })();
}

/**
 * v8 → v9: the input_requests kind CHECK gains 'form'. SQLite cannot ALTER a
 * CHECK, so the table is rebuilt (create → copy → drop → rename) inside ONE
 * transaction — the v1→v2 rebuild pattern, marker-gated on the new
 * vocabulary's presence in sqlite_master.sql. The INSERT…SELECT carries ALL
 * TEN current columns (the v2 template copies only v1-era columns and must
 * NOT be copied verbatim). The dropped inputs_task_status index is recreated
 * by openLedger's second schema exec. No foreign_keys pragma is enabled, so
 * the DROP/RENAME cannot trip FK enforcement.
 */
const INPUTS_V9_REBUILD_SQL = `-- input_requests rebuild (marker: 'form')
CREATE TABLE input_requests_v9_rebuild (
  request_id     TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(task_id),
  tenant_id      TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('secret','text','choice','oauth','file','confirm','form')),
  prompt         TEXT NOT NULL,
  params_json    TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL CHECK (status IN
                   ('pending','answered','expired','cancelled')),
  answer_pointer TEXT,
  created_at     TEXT NOT NULL,
  answered_at    TEXT
);
INSERT INTO input_requests_v9_rebuild
  (request_id, task_id, tenant_id, kind, prompt, params_json, status, answer_pointer, created_at, answered_at)
SELECT request_id, task_id, tenant_id, kind, prompt, params_json, status, answer_pointer, created_at, answered_at
  FROM input_requests;
DROP TABLE input_requests;
ALTER TABLE input_requests_v9_rebuild RENAME TO input_requests;`;

function migrateV9InputChecks(db: Database.Database): void {
  if (getUserVersion(db) >= LEDGER_SCHEMA_VERSION) return;
  const inputsSql = ((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get('input_requests') as
    | { sql: string | null }
    | undefined)?.sql ?? undefined);
  if (inputsSql === undefined || inputsSql.includes("'form'")) return;
  // SQLite DDL is transactional — a torn rebuild cannot exist.
  db.transaction(() => {
    db.exec(INPUTS_V9_REBUILD_SQL);
  })();
}

/**
 * Open (creating if absent) the ledger with the production pragmas, apply
 * the schema (fresh databases are born v3), run the v1→v2 rebuild migration
 * and the v2→v3 additive-column migration, re-apply the schema to recreate
 * the indexes the DROP TABLEs removed, then bump `user_version` only when it
 * is lower. Called on every server start and by `--check`.
 */
export function openLedger(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 3000');
  db.pragma('journal_mode = WAL');
  db.exec(LEDGER_SCHEMA_SQL);
  migrateLegacyChecks(db);
  migrateAddV3Columns(db);
  migrateAddV4Columns(db);
  migrateAddV7Column(db);
  migrateAddV8Column(db);
  migrateAddV10Column(db);
  migrateAddV11Column(db);
  migrateAddV12Column(db);
  migrateAddV13Column(db);
  migrateAddV14Columns(db);
  migrateAddV15Provenance(db);
  migrateAddV16RoutingMetadata(db);
  migrateV9InputChecks(db);
  db.exec(LEDGER_SCHEMA_SQL);
  stampPreV14Views(db, new Date());
  setUserVersion(db);
  return db;
}

// --- Row shapes -----------------------------------------------------------------

export interface TenantRow {
  tenant_id: string;
  telegram_user_id: number;
  telegram_chat_id: number;
  display_name: string | null;
  created_at: string;
}

export interface TaskRow {
  task_id: string;
  tenant_id: string;
  source: 'voice' | 'text';
  transcript: string | null;
  request_text: string;
  state: TaskState;
  routed_to: string | null;
  routing_reason: string | null;
  result_summary: string | null;
  created_at: string;
  updated_at: string;
  conversation_id: string;
  worker_resource: string | null;
  worker_dispatch_id: string | null;
  steer_mode: 'queue' | 'interrupt' | null;
  feedback_about: string | null;
  result_short: string | null;
  suggested_items: string | null;
  tg_message_id: number | null;
  result_structured: string | null;
  surface: 'phone' | 'desktop' | null;
  retried_by: string | null;
  worker_cli: string | null;
  worker_model: string | null;
  worker_effort: string | null;
  router_decision: string | null;
  router_placement: string | null;
  router_target: string | null;
  router_steer: string | null;
  router_steer_by: string | null;
  router_effort_proj: string | null;
  router_failovers: number | null;
}

export type InputRequestStatus = 'pending' | 'answered' | 'expired' | 'cancelled';

export interface InputRequestRow {
  request_id: string;
  task_id: string;
  tenant_id: string;
  kind: InputKind;
  prompt: string;
  params_json: string;
  status: InputRequestStatus;
  answer_pointer: string | null;
  created_at: string;
  answered_at: string | null;
}

export interface LedgerEventRow {
  event_id: number;
  tenant_id: string;
  task_id: string;
  ref_id: string;
  kind: TaskEventKind;
  summary: string | null;
  payload_json: string;
  ts: string;
}

function toEventRow(raw: unknown): LedgerEventRow {
  return raw as LedgerEventRow;
}

// --- Tenants ---------------------------------------------------------------------

export interface UpsertTenantInput {
  telegramUserId: number;
  telegramChatId: number;
  displayName?: string;
}

export function upsertTenant(db: Database.Database, input: UpsertTenantInput): TenantRow {
  const tenantId = tenantIdForTelegramUser(input.telegramUserId);
  db.prepare(
    `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       telegram_chat_id = excluded.telegram_chat_id,
       display_name = COALESCE(excluded.display_name, display_name)`
  ).run(tenantId, input.telegramUserId, input.telegramChatId, input.displayName ?? null, nowIso());
  return getTenant(db, tenantId) as TenantRow;
}

export function getTenant(db: Database.Database, tenantId: string): TenantRow | undefined {
  return db.prepare('SELECT * FROM tenants WHERE tenant_id = ?').get(tenantId) as
    | TenantRow
    | undefined;
}

/** Bootstrap lookup (pairing exchange): no tenant_id exists yet, so this is
 * keyed on the tenants table's own UNIQUE column, not on tenant data. */
export function getTenantByTelegramUser(
  db: Database.Database,
  telegramUserId: number
): TenantRow | undefined {
  return db.prepare('SELECT * FROM tenants WHERE telegram_user_id = ?').get(telegramUserId) as
    | TenantRow
    | undefined;
}

// --- Tasks ------------------------------------------------------------------------

export interface CreateTaskInput {
  source: 'voice' | 'text';
  /** Voice only; text tasks store NULL. */
  transcript?: string;
  requestText: string;
  /** Non-default INSERT-time state. Default 'received'; 'transcribing' is the
   * only legal non-default value (a voice upload waits for its transcript). */
  initialState?: 'transcribing';
  /** The conversation this task joins. Defaults to the task's own id (a
   * self-rooted conversation). */
  conversationId?: string;
  /** Recorded when the operator made this recording as a steer into the
   * conversation it continues. Read at routing time by route_task.py. */
  steerMode?: 'queue' | 'interrupt';
  /** Operator feedback marker: the conversation or task this task is about.
   * Client-supplied at POST /tasks only (never model-writable); read at
   * injection time by the framing render. */
  feedbackAbout?: string;
  /** P6: the viewport class the question was asked from, as the client saw
   * it at creation time. Client-supplied at POST /tasks only. Omit it and the
   * row stores NULL, which is what every pre-v13 row carries and what the PWA
   * reads as "no preference — let the media query decide". */
  surface?: 'phone' | 'desktop';
  /** v14 thread Retry: the failed task this new task retries. The failed
   * row's retried_by is stamped in the SAME transaction as this INSERT, only
   * while it is still an unresolved failure (else the whole create is
   * refused), and the new task's task.received payload records retry_of.
   * Server-only (routes.ts thread retry). */
  retryOf?: string;
}

export function createTask(db: Database.Database, tenantId: string, input: CreateTaskInput): TaskRow {
  if (input.source !== 'voice' && input.source !== 'text') {
    throw new LedgerError('invalid-input', 'source must be "voice" or "text"');
  }
  if (typeof input.requestText !== 'string' || input.requestText.length < 1) {
    throw new LedgerError('invalid-input', 'requestText must be a non-empty string');
  }
  if (input.source === 'voice' && input.transcript !== undefined &&
    typeof input.transcript !== 'string') {
    throw new LedgerError('invalid-input', 'transcript must be a string when present');
  }
  if (input.initialState !== undefined && input.initialState !== 'transcribing') {
    throw new LedgerError('invalid-input', 'initialState must be "transcribing" when present');
  }
  if (input.conversationId !== undefined && (typeof input.conversationId !== 'string' || input.conversationId.length < 1)) {
    throw new LedgerError('invalid-input', 'conversationId must be a non-empty string when present');
  }
  if (input.steerMode !== undefined && input.steerMode !== 'queue' && input.steerMode !== 'interrupt') {
    throw new LedgerError('invalid-input', 'steerMode must be "queue" or "interrupt" when present');
  }
  if (input.feedbackAbout !== undefined && !/^vi-[0-9a-f]{12}$/.test(input.feedbackAbout)) {
    throw new LedgerError('invalid-input', 'feedbackAbout must be a "vi-<12 hex>" task or conversation id');
  }
  if (input.surface !== undefined && input.surface !== 'phone' && input.surface !== 'desktop') {
    throw new LedgerError('invalid-input', 'surface must be "phone" or "desktop" when present');
  }
  if (input.retryOf !== undefined && !/^vi-[0-9a-f]{12}$/.test(input.retryOf)) {
    throw new LedgerError('invalid-input', 'retryOf must be a "vi-<12 hex>" task id');
  }
  const taskId = mintTaskId();
  const ts = nowIso();
  const initialState = input.initialState ?? 'received';
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text, state, created_at, updated_at, conversation_id, steer_mode, feedback_about, surface)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(taskId, tenantId, input.source, input.transcript ?? null, input.requestText,
      initialState, ts, ts, input.conversationId ?? taskId, input.steerMode ?? null, input.feedbackAbout ?? null,
      input.surface ?? null);
    if (input.retryOf !== undefined) {
      // v14 Retry: the failed row points at its retry in the SAME transaction
      // as the INSERT, and only while it is still an unresolved failure — a
      // concurrent second Retry, or a task that is not a failure, refuses the
      // whole create (nothing is written).
      const stamped = db
        .prepare(
          `UPDATE tasks SET retried_by = ?
           WHERE task_id = ? AND tenant_id = ? AND retried_by IS NULL
             AND state IN ('failed', 'transcribe_failed')`
        )
        .run(taskId, input.retryOf, tenantId);
      if (stamped.changes !== 1) {
        throw new LedgerError('illegal-transition', `task ${input.retryOf} is not an unresolved failure; nothing to retry`);
      }
    }
    insertEvent(db, tenantId, taskId, 'task.received', {
      payload: input.retryOf === undefined
        ? { source: input.source, chars: input.requestText.length }
        : { source: input.source, chars: input.requestText.length, retry_of: input.retryOf },
    });
  });
  tx();
  return getTask(db, tenantId, taskId) as TaskRow;
}

/** Tenant-scoped: a task is only visible through its own tenant. */
export function getTask(db: Database.Database, tenantId: string, taskId: string): TaskRow | undefined {
  return db
    .prepare('SELECT * FROM tasks WHERE task_id = ? AND tenant_id = ?')
    .get(taskId, tenantId) as TaskRow | undefined;
}

/**
 * Record the Telegram `message_id` of the FYI reply the bot posted to the
 * routed topic (AI-218). Tenant-scoped. A missing task throws
 * `task-not-found`; a non-integer message_id throws `invalid-input`. The
 * write is a plain column update (no state transition, no event) — the
 * message_id is display plumbing for the deep link, not task lifecycle. The
 * bot-side capture path calls scripts/task_set_message_id.py, which runs this
 * same UPDATE directly against the SQLite file; this TS accessor is the
 * tested twin a future API endpoint could expose.
 */
export function setTaskMessageId(
  db: Database.Database,
  tenantId: string,
  taskId: string,
  messageId: number
): TaskRow {
  if (!Number.isInteger(messageId)) {
    throw new LedgerError('invalid-input', 'messageId must be an integer');
  }
  const ts = nowIso();
  const result = db
    .prepare('UPDATE tasks SET tg_message_id = ?, updated_at = ? WHERE task_id = ? AND tenant_id = ?')
    .run(messageId, ts, taskId, tenantId);
  if (result.changes === 0) {
    throw new LedgerError('task-not-found', `task not found: ${taskId}`);
  }
  return getTask(db, tenantId, taskId) as TaskRow;
}

export interface ListTasksOptions {
  status?: TaskState;
  limit?: number;
}

export function listTasks(
  db: Database.Database,
  tenantId: string,
  options: ListTasksOptions = {}
): TaskRow[] {
  const limit = options.limit ?? 100;
  const rows = options.status
    ? db
      .prepare(
        'SELECT * FROM tasks WHERE tenant_id = ? AND state = ? ORDER BY created_at DESC, task_id DESC LIMIT ?'
      )
      .all(tenantId, options.status, limit)
    : db
      .prepare('SELECT * FROM tasks WHERE tenant_id = ? ORDER BY created_at DESC, task_id DESC LIMIT ?')
      .all(tenantId, limit);
  return rows as TaskRow[];
}

// --- Conversations ----------------------------------------------------------------
// A conversation is the set of tasks sharing one conversation_id (the root
// task's own id by default). "Newest task" throughout this section means
// `(created_at DESC, task_id DESC)` — the same ordering `listTasks` already
// returns rows in, so grouping preserves per-conversation newest-first order
// with no extra sort. No new SQL grouping and no new index (C9): this reads
// listTasks(limit 500) and groups in TypeScript.

export interface ConversationSummaryRow {
  conversation_id: string;
  task_count: number;
  request_text: string;
  latest_request_text: string;
  result_summary: string | null;
  state: TaskState;
  routed_to: string | null;
  created_at: string;
  updated_at: string;
  latest_task_id: string;
  pending_input_count: number;
  title: string | null;
  recap: string | null;
  next_action: string | null;
  latest_step: string | null;
  /** v14 thread status (thread-status.ts); null = hidden. */
  status: ThreadStatusToken | null;
  status_rank: number | null;
  band: ThreadBand | null;
  /** v14 server view time of the thread's current answer; null = never viewed. */
  viewed_at: string | null;
  /** v14 the newest done task's completion time; null = no answer yet. */
  answer_landed_at: string | null;
  /** v14 failed / transcribe_failed tasks not retried and not too_short. */
  failed_unresolved: number;
  /** t-3 (2026-09-18): the conversation ROOT task's feedback_about — a
   *  'vi-<12 hex>' task/conversation id, or null. Client-writable only at
   *  conversation creation (routes.ts rejects feedback_about combined with
   *  continues); every continuation turn inherits the root's value at
   *  createTask time (routes.ts), so this stays the one value for the whole
   *  thread rather than degrading to null once the root scrolls out of view. */
  feedback_about: string | null;
}

// --- Conversation summary lines (AI-222) ------------------------------------
// Worker-set title/recap/next_action, stored in `conversation_meta`. The
// server stores and returns these values; it NEVER derives them — the PWA
// owns the whole client-side fallback (see public/app.js's conversationLines,
// and CONTRACTS.md's "Conversation summary lines" section).

export const CONVERSATION_TITLE_MAX = 60;
export const CONVERSATION_RECAP_MAX = 400;
export const CONVERSATION_NEXT_ACTION_MAX = 200;

export interface ConversationMetaRow {
  conversation_id: string;
  tenant_id: string;
  title: string | null;
  recap: string | null;
  next_action: string | null;
  updated_at: string;
  viewed_at: string | null;
}

export interface ConversationMetaPatch {
  title?: string;
  recap?: string;
  next_action?: string | null; // null clears
}

export function getConversationMeta(
  db: Database.Database,
  tenantId: string,
  conversationId: string
): ConversationMetaRow | undefined {
  return db
    .prepare('SELECT * FROM conversation_meta WHERE conversation_id = ? AND tenant_id = ?')
    .get(conversationId, tenantId) as ConversationMetaRow | undefined;
}

/** Every meta row for one tenant, keyed by conversation_id — ONE query, folded
 *  onto listConversations' existing grouping exactly like pendingCounts. */
export function listConversationMeta(
  db: Database.Database,
  tenantId: string
): Map<string, ConversationMetaRow> {
  const rows = db
    .prepare('SELECT * FROM conversation_meta WHERE tenant_id = ?')
    .all(tenantId) as ConversationMetaRow[];
  const map = new Map<string, ConversationMetaRow>();
  for (const row of rows) map.set(row.conversation_id, row);
  return map;
}

/**
 * Partial upsert (D3 of the AI-222 spec). Present keys write (clamped);
 * absent keys are untouched. `next_action: null` clears it. `titleIfAbsent:
 * true` makes `title` write only when no title is stored yet (D4) — the
 * routing worker's title is an INITIAL title and must never overwrite one a
 * working worker already chose.
 */
export function setConversationMeta(
  db: Database.Database,
  tenantId: string,
  conversationId: string,
  patch: ConversationMetaPatch,
  nowIso: string,
  options: { titleIfAbsent?: boolean } = {}
): void {
  db.prepare(
    `INSERT OR IGNORE INTO conversation_meta (conversation_id, tenant_id, updated_at)
     VALUES (?, ?, ?)`
  ).run(conversationId, tenantId, nowIso);
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push(options.titleIfAbsent ? 'title = COALESCE(title, ?)' : 'title = ?');
    params.push(patch.title.trim().slice(0, CONVERSATION_TITLE_MAX));
  }
  if (patch.recap !== undefined) {
    sets.push('recap = ?');
    params.push(patch.recap.trim().slice(0, CONVERSATION_RECAP_MAX));
  }
  if (patch.next_action !== undefined) {
    sets.push('next_action = ?');
    params.push(
      patch.next_action === null
        ? null
        : patch.next_action.trim().slice(0, CONVERSATION_NEXT_ACTION_MAX) || null
    );
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(nowIso);
  params.push(conversationId);
  db.prepare(
    `UPDATE conversation_meta SET ${sets.join(', ')} WHERE conversation_id = ?`
  ).run(...params);
}

/** Group rows by conversation_id, preserving each row's relative order
 * (callers pass rows already sorted `created_at DESC, task_id DESC`, so the
 * first entry of each group is that conversation's newest task). */
function groupByConversation(rows: readonly TaskRow[]): Map<string, TaskRow[]> {
  const groups = new Map<string, TaskRow[]>();
  for (const row of rows) {
    const existing = groups.get(row.conversation_id);
    if (existing) existing.push(row);
    else groups.set(row.conversation_id, [row]);
  }
  return groups;
}

/** First non-null value of `field` scanning newest-to-oldest. */
function firstNonNull(rows: readonly TaskRow[], field: 'result_summary' | 'routed_to'): string | null {
  for (const row of rows) {
    if (row[field] !== null) return row[field];
  }
  return null;
}

/** The root task of a conversation: the task whose task_id === conversationId;
 * falls back to the oldest task when the root itself is not present. */
function rootTask(conversationId: string, rows: readonly TaskRow[]): TaskRow {
  return rows.find((r) => r.task_id === conversationId) ?? rows[rows.length - 1];
}

/** Exported for routes.ts's conversation-detail endpoint, which computes an
 * exact (uncapped) task list via listConversationTasks and needs the same
 * summarization rules `listConversations` uses internally — reusing this
 * avoids a second hand-written copy of the newest/oldest/root logic above.
 * v14: `updated_at` is the newest update across the thread's tasks, and the
 * status fields come from deriveThreadStatus. `statusInputs` (per task:
 * newest completion time, newest failure code — taskStatusInputsFor) and
 * `now` default to "none" and the real clock. */
export function summarizeConversation(
  conversationId: string,
  rows: readonly TaskRow[],
  pendingInputCount: number,
  meta: ConversationMetaRow | undefined,
  statusInputs: ReadonlyMap<string, TaskStatusInput> = new Map(),
  now: Date = new Date()
): ConversationSummaryRow {
  const newest = rows[0];
  const oldest = rows[rows.length - 1];
  const root = rootTask(conversationId, rows);
  let lastUpdate = newest.updated_at;
  for (const row of rows) {
    if (row.updated_at > lastUpdate) lastUpdate = row.updated_at;
  }
  const viewedAt = meta?.viewed_at ?? null;
  // t-3 (2026-09-18): conversation_meta.next_action is the worker's own
  // "you still have to do X" note (task_complete.py --next, written from a
  // NEXT ACTIONS block's first You step) — its presence IS the LLM-response
  // signal that the operator must act, so it drives needs_you the same way
  // deriveThreadStatus already reads viewedAt/pendingInputCount.
  const nextActionPending = (meta?.next_action ?? null) !== null;
  const derived = deriveThreadStatus(
    rows.map((row) => ({
      task_id: row.task_id,
      state: row.state,
      created_at: row.created_at,
      updated_at: row.updated_at,
      retried_by: row.retried_by ?? null,
      failure_code: statusInputs.get(row.task_id)?.failure_code ?? null,
      completed_at: statusInputs.get(row.task_id)?.completed_at ?? null,
    })),
    viewedAt,
    pendingInputCount,
    now,
    nextActionPending
  );
  return {
    conversation_id: conversationId,
    task_count: rows.length,
    request_text: root.request_text,
    latest_request_text: newest.request_text,
    result_summary: firstNonNull(rows, 'result_summary'),
    state: newest.state,
    routed_to: firstNonNull(rows, 'routed_to'),
    created_at: oldest.created_at,
    updated_at: lastUpdate,
    latest_task_id: newest.task_id,
    pending_input_count: pendingInputCount,
    title: meta?.title ?? null,
    recap: meta?.recap ?? null,
    next_action: meta?.next_action ?? null,
    latest_step: null,
    status: derived.status,
    status_rank: derived.status_rank,
    band: derived.band,
    viewed_at: viewedAt,
    answer_landed_at: derived.answer_landed_at,
    failed_unresolved: derived.failed_unresolved,
    feedback_about: root.feedback_about ?? null,
  };
}

/** Every task of one conversation, reading order (`created_at ASC, task_id
 * ASC`) IS the conversation — tenant-scoped like every other reader here. */
export function listConversationTasks(
  db: Database.Database,
  tenantId: string,
  conversationId: string
): TaskRow[] {
  return db
    .prepare(
      'SELECT * FROM tasks WHERE tenant_id = ? AND conversation_id = ? ORDER BY created_at ASC, task_id ASC'
    )
    .all(tenantId, conversationId) as TaskRow[];
}

export interface ListConversationsOptions {
  limit?: number;
  /** v14: the status clock — defaults to the real clock. */
  now?: Date;
}

/** One summary row per conversation, newest first by `(updated_at DESC,
 * conversation_id DESC)`. `pending_input_count` is computed from one
 * tenant-scoped input_requests query, folded onto the same grouping. */
export function listConversations(
  db: Database.Database,
  tenantId: string,
  options: ListConversationsOptions = {}
): ConversationSummaryRow[] {
  const limit = options.limit ?? 100;
  const now = options.now ?? new Date();
  const rows = listTasks(db, tenantId, { limit: 500 });
  const groups = groupByConversation(rows);
  const taskToConversation = new Map<string, string>();
  for (const row of rows) taskToConversation.set(row.task_id, row.conversation_id);
  const pendingCounts = new Map<string, number>();
  const pendingRows = db
    .prepare("SELECT task_id FROM input_requests WHERE tenant_id = ? AND status = 'pending'")
    .all(tenantId) as Array<{ task_id: string }>;
  for (const { task_id: taskId } of pendingRows) {
    const conversationId = taskToConversation.get(taskId);
    if (conversationId === undefined) continue;
    pendingCounts.set(conversationId, (pendingCounts.get(conversationId) ?? 0) + 1);
  }
  const metas = listConversationMeta(db, tenantId);
  const statusInputs = taskStatusInputsFor(db, tenantId, rows.map((row) => row.task_id));
  const summaries = [...groups.entries()].map(([conversationId, groupRows]) =>
    summarizeConversation(
      conversationId,
      groupRows,
      pendingCounts.get(conversationId) ?? 0,
      metas.get(conversationId),
      statusInputs,
      now
    )
  );
  summaries.sort((a, b) => {
    if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? -1 : 1;
    return a.conversation_id > b.conversation_id ? -1 : 1;
  });
  const sliced = summaries.slice(0, limit);
  const taskIds = sliced.map((row) => row.latest_task_id);
  const stepByTaskId = latestStepsFor(db, tenantId, taskIds);
  return sliced.map((row) => ({
    ...row,
    latest_step: stepByTaskId.get(row.latest_task_id) ?? null,
  }));
}

/** Search-term filter shared by countConversations and listConversationsPage:
 * whitespace-tokenized terms, AND across terms, each term a LIKE-OR across
 * tasks.request_text, tasks.transcript, tasks.result_summary, conversation_meta.title and
 * conversation_meta.recap — all contains-match (likeTerm's `%` wrap) under
 * ESCAPE '!' so literal `%`/`_`/`!` never widen a search. Returns the AND-
 * clauses and their params, or null when q is absent/whitespace-only
 * (unfiltered). Callers add the LEFT JOIN on conversation_meta — a
 * conversation may have no meta row, so NULL meta fields simply don't match. */
function conversationSearchFilter(q: string | null | undefined): {
  andClauses: string;
  params: string[];
} | null {
  const terms = (q ?? '').split(/\s+/).filter((t) => t.length > 0).map(likeTerm);
  if (terms.length === 0) return null;
  const orClause =
    `(tasks.request_text LIKE ? ESCAPE '!'
     OR tasks.transcript LIKE ? ESCAPE '!'
     OR tasks.result_summary LIKE ? ESCAPE '!'
     OR conversation_meta.title LIKE ? ESCAPE '!'
     OR conversation_meta.recap LIKE ? ESCAPE '!')`;
  return {
    andClauses: terms.map(() => `AND ${orClause}`).join('\n  '),
    params: terms.flatMap((t) => [t, t, t, t, t]),
  };
}

/** Total conversations for the tenant — the same universe (every
 * conversation_id on the tenant's tasks) the paged reader below walks, and
 * the `total` GET /conversations always returns (vi-19787afc4b2e). With `q`
 * the count is the FILTERED universe (archive search, 2026-09-15). */
export function countConversations(
  db: Database.Database,
  tenantId: string,
  q?: string | null
): number {
  const filter = conversationSearchFilter(q);
  if (filter === null) {
    const row = db
      .prepare('SELECT COUNT(DISTINCT conversation_id) AS n FROM tasks WHERE tenant_id = ?')
      .get(tenantId) as { n: number };
    return row.n;
  }
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT tasks.conversation_id) AS n
       FROM tasks
       LEFT JOIN conversation_meta
         ON conversation_meta.conversation_id = tasks.conversation_id
        AND conversation_meta.tenant_id = tasks.tenant_id
       WHERE tasks.tenant_id = ?
       ${filter.andClauses}`
    )
    .get(tenantId, ...filter.params) as { n: number };
  return row.n;
}

export interface ListConversationsPageOptions {
  limit?: number;
  offset?: number;
  q?: string | null;
  /** v14: the status clock — defaults to the real clock. */
  now?: Date;
}

/**
 * One page of conversation summaries, newest first by `(MAX(updated_at) DESC,
 * conversation_id DESC)` — the same ordering rule listConversations applies in
 * TypeScript, here expressed in SQL so OFFSET can page it. Page identities
 * come from ONE grouped query; each page entry is then summarized from its
 * FULL task list (listConversationTasks + summarizeConversation) — correct at
 * any depth, where listConversations' 500-task grouping window cannot express
 * an offset honestly (why this reader exists, vi-19787afc4b2e). No
 * `conversation_id <> ''` guard: the column is always written explicitly
 * (CONTRACTS.md), and omitting it keeps this query's universe identical to
 * listConversations'.
 */
export function listConversationsPage(
  db: Database.Database,
  tenantId: string,
  options: ListConversationsPageOptions = {}
): ConversationSummaryRow[] {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  const q = options.q ?? null;
  const filter = conversationSearchFilter(q);
  const pageIds = (
    filter === null
      ? (db
          .prepare(
            `SELECT conversation_id FROM tasks
             WHERE tenant_id = ?
             GROUP BY conversation_id
             ORDER BY MAX(updated_at) DESC, conversation_id DESC
             LIMIT ? OFFSET ?`
          )
          .all(tenantId, limit, offset) as Array<{ conversation_id: string }>)
      : (db
          .prepare(
            `SELECT tasks.conversation_id
             FROM tasks
             LEFT JOIN conversation_meta
               ON conversation_meta.conversation_id = tasks.conversation_id
              AND conversation_meta.tenant_id = tasks.tenant_id
             WHERE tasks.tenant_id = ?
             ${filter.andClauses}
             GROUP BY tasks.conversation_id
             ORDER BY MAX(tasks.updated_at) DESC, tasks.conversation_id DESC
             LIMIT ? OFFSET ?`
          )
          .all(tenantId, ...filter.params, limit, offset) as Array<{ conversation_id: string }>)
  ).map((row) => row.conversation_id);
  if (pageIds.length === 0) return [];
  // Pending counts: ONE page-scoped join instead of N per-conversation scans.
  const placeholders = pageIds.map(() => '?').join(',');
  const pendingRows = db
    .prepare(
      `SELECT t.conversation_id AS cid, COUNT(*) AS n
       FROM input_requests r
       JOIN tasks t ON t.task_id = r.task_id AND t.tenant_id = r.tenant_id
       WHERE r.tenant_id = ? AND r.status = 'pending'
         AND t.conversation_id IN (${placeholders})
       GROUP BY t.conversation_id`
    )
    .all(tenantId, ...pageIds) as Array<{ cid: string; n: number }>;
  const pendingCounts = new Map<string, number>();
  for (const row of pendingRows) pendingCounts.set(row.cid, row.n);
  const metas = listConversationMeta(db, tenantId);
  const now = options.now ?? new Date();
  const tasksByConversation = new Map<string, TaskRow[]>(
    pageIds.map((conversationId) => [conversationId, listConversationTasks(db, tenantId, conversationId)])
  );
  const statusInputs = taskStatusInputsFor(
    db,
    tenantId,
    [...tasksByConversation.values()].flat().map((task) => task.task_id)
  );
  const summaries = pageIds.map((conversationId) => {
    const tasksAsc = tasksByConversation.get(conversationId) ?? [];
    return summarizeConversation(
      conversationId,
      [...tasksAsc].reverse(),
      pendingCounts.get(conversationId) ?? 0,
      metas.get(conversationId),
      statusInputs,
      now
    );
  });
  const stepByTaskId = latestStepsFor(db, tenantId, summaries.map((row) => row.latest_task_id));
  return summaries.map((row) => ({
    ...row,
    latest_step: stepByTaskId.get(row.latest_task_id) ?? null,
  }));
}

/** latest_step enrichment shared by listConversations and
 * listConversationsPage — one copy of the newest-task.progress-per-
 * conversation rule. Keys are the given latest_task_ids; absent → null. */
function latestStepsFor(
  db: Database.Database,
  tenantId: string,
  latestTaskIds: string[]
): Map<string, string | null> {
  const stepByTaskId = new Map<string, string | null>();
  if (latestTaskIds.length === 0) return stepByTaskId;
  const placeholders = latestTaskIds.map(() => '?').join(',');
  // Newest-first so the first row seen per task_id is its max(event_id) —
  // avoids a correlated subquery for the same result.
  const stepRows = db
    .prepare(
      `SELECT task_id, payload_json FROM events
       WHERE tenant_id = ? AND kind = 'task.progress' AND task_id IN (${placeholders})
       ORDER BY event_id DESC`
    )
    .all(tenantId, ...latestTaskIds) as Array<{ task_id: string; payload_json: string }>;
  for (const { task_id: taskId, payload_json: payloadJson } of stepRows) {
    if (stepByTaskId.has(taskId)) continue;
    let step: string | null = null;
    try {
      const parsed = JSON.parse(payloadJson) as { step?: unknown };
      step = typeof parsed.step === 'string' ? parsed.step : null;
    } catch {
      step = null;
    }
    stepByTaskId.set(taskId, step);
  }
  return stepByTaskId;
}

/** Per-task inputs the thread-status rule reads from events (v14): the
 *  newest task.completed event time and the newest task.failed event's
 *  payload `code`. */
export interface TaskStatusInput {
  failure_code: string | null;
  completed_at: string | null;
}

const STATUS_INPUT_CHUNK = 400;

/** One query per 400 task ids, newest event last (event_id ASC), so the last
 *  row seen per kind wins. Tasks with neither event are absent from the map. */
export function taskStatusInputsFor(
  db: Database.Database,
  tenantId: string,
  taskIds: readonly string[]
): Map<string, TaskStatusInput> {
  const inputs = new Map<string, TaskStatusInput>();
  for (let i = 0; i < taskIds.length; i += STATUS_INPUT_CHUNK) {
    const chunk = taskIds.slice(i, i + STATUS_INPUT_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const events = db
      .prepare(
        `SELECT task_id, kind, payload_json, ts FROM events
         WHERE tenant_id = ? AND kind IN ('task.completed', 'task.failed') AND task_id IN (${placeholders})
         ORDER BY event_id ASC`
      )
      .all(tenantId, ...chunk) as Array<{ task_id: string; kind: string; payload_json: string; ts: string }>;
    for (const event of events) {
      const input = inputs.get(event.task_id) ?? { failure_code: null, completed_at: null };
      if (event.kind === 'task.completed') {
        input.completed_at = event.ts;
      } else {
        let code: string | null = null;
        try {
          const parsed: unknown = JSON.parse(event.payload_json);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const value = (parsed as Record<string, unknown>)['code'];
            code = typeof value === 'string' ? value : null;
          }
        } catch {
          code = null;
        }
        input.failure_code = code;
      }
      inputs.set(event.task_id, input);
    }
  }
  return inputs;
}

/** One conversation's summary from its FULL task list — the detail endpoint's
 *  and the share view's reader (v14). undefined when the conversation has no
 *  task under this tenant. */
export function summarizeConversationById(
  db: Database.Database,
  tenantId: string,
  conversationId: string,
  now: Date = new Date()
): ConversationSummaryRow | undefined {
  const tasksAsc = listConversationTasks(db, tenantId, conversationId);
  if (tasksAsc.length === 0) return undefined;
  const taskIds = new Set(tasksAsc.map((task) => task.task_id));
  const pendingRows = db
    .prepare("SELECT task_id FROM input_requests WHERE tenant_id = ? AND status = 'pending'")
    .all(tenantId) as Array<{ task_id: string }>;
  const pendingInputCount = pendingRows.filter((row) => taskIds.has(row.task_id)).length;
  return summarizeConversation(
    conversationId,
    [...tasksAsc].reverse(),
    pendingInputCount,
    getConversationMeta(db, tenantId, conversationId),
    taskStatusInputsFor(db, tenantId, [...taskIds]),
    now
  );
}

/** Candidate superset for the Recent view: a thread updated within 24 h, one
 *  with a live task, an unretried failure or a pending ask, a thread with a
 *  done task that was never viewed or was viewed within the hour, or one
 *  whose done task was updated or completed after its view. The status rule
 *  then decides. Named parameters: @tenant, @recentCutoff, @viewedCutoff. */
const RECENT_CANDIDATES_SQL = `WITH conv AS (
  SELECT conversation_id AS cid,
         MAX(updated_at) AS last_update,
         SUM(CASE WHEN state IN ('received','transcribing','routed','running','awaiting_input') THEN 1 ELSE 0 END) AS live_n,
         SUM(CASE WHEN state IN ('failed','transcribe_failed') AND retried_by IS NULL THEN 1 ELSE 0 END) AS failed_n,
         SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) AS done_n
  FROM tasks
  WHERE tenant_id = @tenant
  GROUP BY conversation_id
)
SELECT conv.cid AS conversation_id
FROM conv
LEFT JOIN conversation_meta m ON m.conversation_id = conv.cid AND m.tenant_id = @tenant
WHERE conv.last_update >= @recentCutoff
   OR conv.live_n > 0
   OR conv.failed_n > 0
   OR (conv.done_n > 0 AND (m.viewed_at IS NULL OR m.viewed_at >= @viewedCutoff))
   OR (conv.done_n > 0 AND EXISTS (
        SELECT 1 FROM tasks d
        WHERE d.tenant_id = @tenant AND d.conversation_id = conv.cid AND d.state = 'done'
          AND (d.updated_at > m.viewed_at OR EXISTS (
            SELECT 1 FROM events e
            WHERE e.tenant_id = @tenant AND e.task_id = d.task_id
              AND e.kind = 'task.completed' AND e.ts > m.viewed_at))))
   OR conv.cid IN (
        SELECT t.conversation_id FROM input_requests r
        JOIN tasks t ON t.task_id = r.task_id AND t.tenant_id = r.tenant_id
        WHERE r.tenant_id = @tenant AND r.status = 'pending')`;

export interface ListRecentConversationsOptions {
  /** The windows' and the status rule's clock — defaults to the real clock. */
  now?: Date;
}

/**
 * The Recent view (v14): every thread whose status band is live or history,
 * sorted by status rank, then newest update, then conversation_id — with NO
 * row cap, so an unviewed answer of any age is never lost to a limit.
 * RECENT_CANDIDATES_SQL selects a superset; each candidate is summarized from
 * its full task list and the band decides.
 */
export function listRecentConversations(
  db: Database.Database,
  tenantId: string,
  options: ListRecentConversationsOptions = {}
): ConversationSummaryRow[] {
  const now = options.now ?? new Date();
  const candidates = db
    .prepare(RECENT_CANDIDATES_SQL)
    .all({
      tenant: tenantId,
      recentCutoff: new Date(now.getTime() - RECENT_WINDOW_MS).toISOString(),
      viewedCutoff: new Date(now.getTime() - VIEWED_WINDOW_MS).toISOString(),
    }) as Array<{ conversation_id: string }>;
  if (candidates.length === 0) return [];
  const tasksByConversation = new Map<string, TaskRow[]>();
  const conversationByTask = new Map<string, string>();
  for (const { conversation_id: conversationId } of candidates) {
    const tasksAsc = listConversationTasks(db, tenantId, conversationId);
    tasksByConversation.set(conversationId, tasksAsc);
    for (const task of tasksAsc) conversationByTask.set(task.task_id, conversationId);
  }
  const pendingCounts = new Map<string, number>();
  const pendingRows = db
    .prepare("SELECT task_id FROM input_requests WHERE tenant_id = ? AND status = 'pending'")
    .all(tenantId) as Array<{ task_id: string }>;
  for (const { task_id: taskId } of pendingRows) {
    const conversationId = conversationByTask.get(taskId);
    if (conversationId === undefined) continue;
    pendingCounts.set(conversationId, (pendingCounts.get(conversationId) ?? 0) + 1);
  }
  const metas = listConversationMeta(db, tenantId);
  const statusInputs = taskStatusInputsFor(db, tenantId, [...conversationByTask.keys()]);
  const summaries: ConversationSummaryRow[] = [];
  for (const [conversationId, tasksAsc] of tasksByConversation) {
    if (tasksAsc.length === 0) continue;
    const summary = summarizeConversation(
      conversationId,
      [...tasksAsc].reverse(),
      pendingCounts.get(conversationId) ?? 0,
      metas.get(conversationId),
      statusInputs,
      now
    );
    if (summary.band === 'live' || summary.band === 'history') summaries.push(summary);
  }
  summaries.sort((a, b) => {
    const rankA = a.status_rank ?? Number.MAX_SAFE_INTEGER;
    const rankB = b.status_rank ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? -1 : 1;
    return a.conversation_id > b.conversation_id ? -1 : 1;
  });
  const stepByTaskId = latestStepsFor(db, tenantId, summaries.map((row) => row.latest_task_id));
  return summaries.map((row) => ({
    ...row,
    latest_step: stepByTaskId.get(row.latest_task_id) ?? null,
  }));
}

export interface ListOpenConversationsOptions {
  excludeConversationId?: string;
  /** Test seam for the 24-hour window and the status — defaults to the real clock. */
  now?: Date;
}

export interface OpenConversationRef {
  conversationId: string;
  snippet: string;
}

/** The placeholder `request_text` a voice task carries from creation until
 * transcription completes (routes.ts's createTaskHandler). Exported so the
 * two places that need to recognize "no real content yet" — this file and
 * routes.ts's own write of the placeholder — share one literal instead of
 * two hand-copies drifting apart. */
export const VOICE_TRANSCRIBING_PLACEHOLDER = '(voice recording)';

/** request_text for a files-only task (no audio, no text): honest about
 * carrying only attachments. Exported beside VOICE_TRANSCRIBING_PLACEHOLDER
 * so routes.ts's write and the tests assert one literal. */
export const ATTACHMENTS_PLACEHOLDER = '(attachments)';

/** Build the worker-facing snippet: collapse whitespace, drop `;` (the
 * segment's own field separator), trim, cap at 60 chars. A root task that has
 * not been transcribed yet still carries the literal
 * VOICE_TRANSCRIBING_PLACEHOLDER as its request_text, so the snippet swaps it
 * for an honest label rather than surfacing it verbatim (surfacing it gave the
 * routing worker a snippet indistinguishable from "no information", which is
 * why two voice notes 14 seconds apart (vi-6cb5faaf1b74) failed to link). */
function buildSnippet(requestText: string): string {
  if (requestText === VOICE_TRANSCRIBING_PLACEHOLDER) {
    return '(voice message still transcribing)';
  }
  return requestText.replace(/\s+/g, ' ').replace(/;/g, '').trim().slice(0, 60);
}

/** Human recency label ("moments ago" / "N minute(s) ago") appended to every
 * open-conversation snippet. A still-transcribing candidate has no content
 * signal at all (see buildSnippet above), so recency is often the ONLY signal
 * the routing worker gets that a brand-new voice note continues one sent
 * moments earlier — folding it into every entry (not just placeholder ones)
 * keeps the format uniform and gives the worker the same "how recent" context
 * for ordinary snippets too. */
function formatAge(updatedAt: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - Date.parse(updatedAt));
  if (ms < 60_000) return 'moments ago';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

/**
 * The router offer (v14): EVERY thread whose newest update is within
 * RECENT_WINDOW_MS (24 h), whatever its status — no state filter, no count
 * cap — minus hidden threads (no status) and `excludeConversationId`, newest
 * update first. Each snippet is `<root request, 60 chars> (updated <age>)
 * [<status word>]`, so the router knows what it would be joining. The
 * character budget and the Cancelled / when-unsure rules live with the text
 * in bridge-writer.ts; route_task.py's refusal to merge into a cancelled
 * thread stays the enforcement.
 */
export function listOpenConversations(
  db: Database.Database,
  tenantId: string,
  options: ListOpenConversationsOptions = {}
): OpenConversationRef[] {
  const now = options.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - RECENT_WINDOW_MS).toISOString();
  const offered = listRecentConversations(db, tenantId, { now }).filter(
    (row) =>
      row.status !== null &&
      row.updated_at >= cutoffIso &&
      (options.excludeConversationId === undefined || row.conversation_id !== options.excludeConversationId)
  );
  offered.sort((a, b) => {
    if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? -1 : 1;
    return a.conversation_id > b.conversation_id ? -1 : 1;
  });
  return offered.map((row) => ({
    conversationId: row.conversation_id,
    snippet: `${buildSnippet(row.request_text)} (updated ${formatAge(row.updated_at, now)}) [${THREAD_STATUS_WORDS[row.status as ThreadStatusToken]}]`,
  }));
}

/** D4 of the WP-5 spec: the worker resource of the conversation's newest task
 * that has one, whatever that task's state — a finished conversation is still
 * steerable (handleSteer's wake path). NON-OPERATIVE: this exists only to
 * label the create response's snapshot. The operative copy the bot acts on is
 * voiceInboxConversationState in pa/src/lib/voice-inbox-ledger.ts; drift
 * between the two is cosmetic because this one decides nothing. */
export function conversationWorkerResource(
  db: Database.Database,
  tenantId: string,
  conversationId: string
): string | null {
  const row = db
    .prepare(
      `SELECT worker_resource FROM tasks
       WHERE tenant_id = ? AND conversation_id = ? AND worker_resource IS NOT NULL AND worker_resource != ''
       ORDER BY updated_at DESC, task_id DESC LIMIT 1`
    )
    .get(tenantId, conversationId) as { worker_resource: string } | undefined;
  return row ? row.worker_resource.trim() : null;
}

export interface SetConversationViewedInput {
  /** The one-time read-mark upload's time (ISO Z), honoured only when the
   *  thread has no view time at all. */
  at?: string;
  now: Date;
}

export interface ConversationViewedResult {
  changed: boolean;
  viewed_at: string | null;
}

/**
 * Record the operator's view of a thread's CURRENT answer (v14). Writes only
 * when the thread is unviewed for that answer — no view time, or one earlier
 * than the newest done task's answer-landed time — so a re-open never
 * restarts the Viewed window and a new answer makes the thread writable
 * again. `at` is honoured only when the thread has no view time; otherwise the
 * write uses `now`. A thread with no done task has nothing to view and writes
 * nothing. Throws task-not-found when the conversation has no task under this
 * tenant. conversation_meta.updated_at is written only on the row's INSERT.
 */
export function setConversationViewed(
  db: Database.Database,
  tenantId: string,
  conversationId: string,
  input: SetConversationViewedInput
): ConversationViewedResult {
  let result: ConversationViewedResult = { changed: false, viewed_at: null };
  const tx = db.transaction(() => {
    const tasksAsc = listConversationTasks(db, tenantId, conversationId);
    if (tasksAsc.length === 0) throw new LedgerError('task-not-found', 'conversation not found');
    const current = getConversationMeta(db, tenantId, conversationId)?.viewed_at ?? null;
    const done = [...tasksAsc].reverse().find((task) => task.state === 'done');
    if (done === undefined) {
      result = { changed: false, viewed_at: current };
      return;
    }
    const landedAt =
      taskStatusInputsFor(db, tenantId, [done.task_id]).get(done.task_id)?.completed_at ?? done.updated_at;
    if (current !== null && Date.parse(current) >= Date.parse(landedAt)) {
      result = { changed: false, viewed_at: current };
      return;
    }
    const value = current === null && input.at !== undefined ? input.at : input.now.toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO conversation_meta (conversation_id, tenant_id, updated_at)
       VALUES (?, ?, ?)`
    ).run(conversationId, tenantId, input.now.toISOString());
    db.prepare(
      'UPDATE conversation_meta SET viewed_at = ? WHERE conversation_id = ? AND tenant_id = ?'
    ).run(value, conversationId, tenantId);
    result = { changed: true, viewed_at: value };
  });
  tx();
  return result;
}

const LIVE_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'received',
  'transcribing',
  'routed',
  'running',
  'awaiting_input',
]);

function isUnresolvedFailureRow(task: TaskRow, inputs: ReadonlyMap<string, TaskStatusInput>): boolean {
  return isUnresolvedFailure({
    state: task.state,
    retried_by: task.retried_by ?? null,
    failure_code: inputs.get(task.task_id)?.failure_code ?? null,
  });
}

/** The thread's unresolved failures (v14 Retry) — failed / transcribe_failed,
 *  not retried, never too_short — OLDEST first, so their retries keep the
 *  operator's send order. null when the conversation has no task. */
export function listRetryableFailures(
  db: Database.Database,
  tenantId: string,
  conversationId: string
): TaskRow[] | null {
  const tasksAsc = listConversationTasks(db, tenantId, conversationId);
  if (tasksAsc.length === 0) return null;
  const inputs = taskStatusInputsFor(db, tenantId, tasksAsc.map((task) => task.task_id));
  return tasksAsc.filter((task) => isUnresolvedFailureRow(task, inputs));
}

/** Every task a thread cancel moves to cancelled (v14): live tasks plus
 *  unresolved failures, oldest first. null when the conversation has no task. */
export function listCancellableTasks(
  db: Database.Database,
  tenantId: string,
  conversationId: string
): TaskRow[] | null {
  const tasksAsc = listConversationTasks(db, tenantId, conversationId);
  if (tasksAsc.length === 0) return null;
  const inputs = taskStatusInputsFor(db, tenantId, tasksAsc.map((task) => task.task_id));
  return tasksAsc.filter((task) => LIVE_TASK_STATES.has(task.state) || isUnresolvedFailureRow(task, inputs));
}

// --- Conversation shares (AI-227, schema v6) --------------------------------
// A public, read-only, no-expiry share link for one conversation. One active
// (revoked_at IS NULL) row per (tenant_id, conversation_id) at a time — minting
// while one is already active is idempotent (returns the existing row rather
// than minting a second), and revoking never deletes the row (an audit trail
// of every token ever issued for the conversation).

export interface ConversationShare {
  token: string;
  tenant_id: string;
  conversation_id: string;
  created_at: string;
  revoked_at: string | null;
}

/**
 * Mint (or return the existing) active share for a conversation. Throws
 * `LedgerError('task-not-found')` when no task exists for this tenant with
 * this conversation_id — the same not-found the route layer already maps to
 * 404 for every other conversation-scoped call.
 */
export function mintConversationShare(
  db: Database.Database,
  tenantId: string,
  conversationId: string
): ConversationShare {
  const existing = getActiveConversationShare(db, tenantId, conversationId);
  if (existing) return existing;
  const hasTask = db
    .prepare('SELECT 1 FROM tasks WHERE tenant_id = ? AND conversation_id = ? LIMIT 1')
    .get(tenantId, conversationId);
  if (!hasTask) {
    throw new LedgerError('task-not-found', 'conversation not found');
  }
  const token = randomBytes(32).toString('base64url');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO conversation_shares (token, tenant_id, conversation_id, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(token, tenantId, conversationId, ts);
  return { token, tenant_id: tenantId, conversation_id: conversationId, created_at: ts, revoked_at: null };
}

/** The one active share for this conversation, or null if none. */
export function getActiveConversationShare(
  db: Database.Database,
  tenantId: string,
  conversationId: string
): ConversationShare | null {
  const row = db
    .prepare(
      `SELECT * FROM conversation_shares
       WHERE tenant_id = ? AND conversation_id = ? AND revoked_at IS NULL`
    )
    .get(tenantId, conversationId) as ConversationShare | undefined;
  return row ?? null;
}

/**
 * Revoke the active share for a conversation, if any. Never deletes the row
 * — `revoked_at` is set instead, so the token becomes unresolvable but its
 * audit trail remains. Returns `true` only when a row was actually updated
 * (an already-revoked or never-shared conversation returns `false` with no
 * error).
 */
export function revokeConversationShare(
  db: Database.Database,
  tenantId: string,
  conversationId: string
): boolean {
  const result = db
    .prepare(
      `UPDATE conversation_shares SET revoked_at = ?
       WHERE tenant_id = ? AND conversation_id = ? AND revoked_at IS NULL`
    )
    .run(nowIso(), tenantId, conversationId);
  return result.changes > 0;
}

/**
 * Resolve a public share token to its (tenant_id, conversation_id) — the
 * ONLY entry point the unauthenticated `/api/v1/share/:token` route uses.
 * Returns null for an unknown OR a revoked token — both are indistinguishable
 * 404s to the public viewer.
 */
export function resolveConversationShareToken(
  db: Database.Database,
  token: string
): { tenant_id: string; conversation_id: string } | null {
  const row = db
    .prepare(
      `SELECT tenant_id, conversation_id FROM conversation_shares
       WHERE token = ? AND revoked_at IS NULL`
    )
    .get(token) as { tenant_id: string; conversation_id: string } | undefined;
  return row ?? null;
}

export interface TransitionInput {
  /** Required — every state change writes its paired event (§3). */
  eventKind: TaskEventKind;
  eventSummary?: string;
  eventPayload?: Record<string, unknown>;
  routedTo?: string;
  routingReason?: string;
  resultSummary?: string;
}

export interface TransitionResult {
  task: TaskRow;
  event: LedgerEventRow;
}

/**
 * Apply one state-machine transition and write its paired event atomically.
 * Throws LedgerError('task-not-found') when the task does not exist under
 * this tenant, LedgerError('illegal-transition') when the move is not in the
 * table — in both cases nothing is written.
 */
export function transitionTask(
  db: Database.Database,
  tenantId: string,
  taskId: string,
  toState: TaskState,
  input: TransitionInput
): TransitionResult {
  const allowedKinds = TRANSITION_EVENT_KINDS[toState];
  if (!allowedKinds.includes(input.eventKind)) {
    throw new LedgerError(
      'illegal-transition',
      `event kind ${input.eventKind} may not accompany a transition to ${toState}`
    );
  }
  const ts = nowIso();
  let event: LedgerEventRow | undefined;
  // The state read + transition check happen INSIDE the transaction: the
  // python worker scripts write this same file concurrently, so a check made
  // outside could validate against a stale state and let an illegal
  // transition land.
  const tx = db.transaction(() => {
    const task = getTask(db, tenantId, taskId);
    if (!task) throw new LedgerError('task-not-found', `task ${taskId} not found for tenant`);
    assertTransition(task.state, toState);
    // A task can leave awaiting_input by a route OTHER than answerInputRequest
    // (operator cancel, reroute, or a direct done/failed) — 'running' is the
    // only target that path itself produces. Any pending input_requests row
    // left behind would otherwise sit at status='pending' forever (nothing
    // else ever closes it), permanently misreporting the conversation as
    // needing the operator's response after the operator has already moved
    // it on.
    if (task.state === 'awaiting_input' && toState !== 'running') {
      db.prepare(
        `UPDATE input_requests SET status = ?, answered_at = ?
         WHERE task_id = ? AND tenant_id = ? AND status = 'pending'`
      ).run(toState === 'cancelled' ? 'cancelled' : 'expired', ts, taskId, tenantId);
    }
    db.prepare(
      `UPDATE tasks
       SET state = ?,
           routed_to = COALESCE(?, routed_to),
           routing_reason = COALESCE(?, routing_reason),
           result_summary = COALESCE(?, result_summary),
           updated_at = ?
       WHERE task_id = ? AND tenant_id = ?`
    ).run(toState, input.routedTo ?? null, input.routingReason ?? null,
      input.resultSummary ?? null, ts, taskId, tenantId);
    // Entering `routed` means "unclaimed, waiting for pickup" in EVERY legal
    // transition into it (received/routed/running/awaiting_input -> routed).
    // A dead worker's identity left on a routed row is meaningless by
    // definition and is exactly what orphans the task: the fallback job's
    // stale-routed scan only considers rows with NO worker_resource, so a
    // replayed task that keeps a dead worker's identity matches no scan and
    // nothing ever retries it (2026-09-12 dispatch-reliability incident, task
    // vi-c1f51a157e11: replayed at 10:03, silent until 11:05). Scoped to
    // `routed` ONLY: terminal states keep identity as history (a terminal
    // sibling must never block a replay) and a fresh pickup re-records it on
    // the first task.progress. Runs inside the same transaction — the clear
    // and the state change land together or not at all.
    if (toState === 'routed') {
      db.prepare(
        `UPDATE tasks SET worker_resource = NULL, worker_dispatch_id = NULL
         WHERE task_id = ? AND tenant_id = ?`
      ).run(taskId, tenantId);
    }
    event = insertEvent(db, tenantId, taskId, input.eventKind, {
      summary: input.eventSummary,
      payload: input.eventPayload,
    });
  });
  tx();
  return { task: getTask(db, tenantId, taskId) as TaskRow, event: event as LedgerEventRow };
}

// --- Events -------------------------------------------------------------------------

interface AppendEventInput {
  summary?: string;
  payload?: Record<string, unknown>;
}

/** Shared insert (caller owns the transaction when one is open). */
function insertEvent(
  db: Database.Database,
  tenantId: string,
  taskId: string,
  kind: TaskEventKind,
  input: AppendEventInput = {}
): LedgerEventRow {
  if (!isTaskEventKind(kind)) {
    throw new LedgerError('invalid-input', `unknown event kind: ${String(kind)}`);
  }
  const refId = makeRefId();
  const summary = input.summary === undefined ? null : input.summary.slice(0, EVENT_SUMMARY_MAX);
  const payloadJson = JSON.stringify(input.payload ?? {});
  const result = db
    .prepare(
      `INSERT INTO events (tenant_id, task_id, ref_id, kind, summary, payload_json, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(tenantId, taskId, refId, kind, summary, payloadJson, nowIso());
  const rowId = Number(result.lastInsertRowid);
  return toEventRow(
    db.prepare('SELECT * FROM events WHERE event_id = ?').get(rowId)
  );
}

/**
 * Append a non-transitional event (e.g. `task.result_ready`, or `task.progress`
 * while already running). Throws when the task does not exist under this
 * tenant or the kind is outside the vocabulary.
 */
export function appendEvent(
  db: Database.Database,
  tenantId: string,
  taskId: string,
  kind: TaskEventKind,
  input: AppendEventInput = {}
): LedgerEventRow {
  const task = getTask(db, tenantId, taskId);
  if (!task) throw new LedgerError('task-not-found', `task ${taskId} not found for tenant`);
  return insertEvent(db, tenantId, taskId, kind, input);
}

export interface ListEventsOptions {
  /** Incremental poll (§6 `GET /tasks/:id/events?after=`): only rows with a
   * strictly greater event_id. */
  afterEventId?: number;
}

export function listEvents(
  db: Database.Database,
  tenantId: string,
  taskId: string,
  options: ListEventsOptions = {}
): LedgerEventRow[] {
  const after = options.afterEventId;
  const rows =
    after === undefined
      ? db
        .prepare('SELECT * FROM events WHERE tenant_id = ? AND task_id = ? ORDER BY event_id ASC')
        .all(tenantId, taskId)
      : db
        .prepare(
          'SELECT * FROM events WHERE tenant_id = ? AND task_id = ? AND event_id > ? ORDER BY event_id ASC'
        )
        .all(tenantId, taskId, after);
  return rows.map(toEventRow);
}

// --- Input requests -------------------------------------------------------------------

export interface CreatedInputRequest {
  request: InputRequestRow;
  task: TaskRow;
  event: LedgerEventRow;
}

/**
 * Create a widget input request on a running task: validates against the §4
 * widget contract, moves the task running → awaiting_input, and writes the
 * paired `task.input_needed` event — one transaction. The TS-side validator is
 * the same table the python `task_input.py` enforces.
 */
export function createInputRequest(
  db: Database.Database,
  tenantId: string,
  taskId: string,
  input: unknown
): CreatedInputRequest {
  const validated = validateInputRequest(input);
  if (!validated.ok) {
    throw new LedgerError('invalid-input', `invalid input request: ${validated.error}`);
  }
  const request = validated.value;
  const requestId = mintRequestId();
  const ts = nowIso();
  let event: LedgerEventRow | undefined;
  // Read + transition check inside the transaction (concurrent python writers).
  const tx = db.transaction(() => {
    const task = getTask(db, tenantId, taskId);
    if (!task) throw new LedgerError('task-not-found', `task ${taskId} not found for tenant`);
    assertTransition(task.state, 'awaiting_input'); // legal only from running (§3)
    db.prepare(
      `INSERT INTO input_requests
         (request_id, task_id, tenant_id, kind, prompt, params_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(requestId, taskId, tenantId, request.kind, request.prompt,
      JSON.stringify(request.params), ts);
    db.prepare(
      `UPDATE tasks SET state = 'awaiting_input', updated_at = ?
       WHERE task_id = ? AND tenant_id = ?`
    ).run(ts, taskId, tenantId);
    event = insertEvent(db, tenantId, taskId, 'task.input_needed', {
      payload: { request_id: requestId, kind: request.kind },
    });
  });
  tx();
  return {
    request: getInputRequest(db, tenantId, taskId, requestId) as InputRequestRow,
    task: getTask(db, tenantId, taskId) as TaskRow,
    event: event as LedgerEventRow,
  };
}

export function getInputRequest(
  db: Database.Database,
  tenantId: string,
  taskId: string,
  requestId: string
): InputRequestRow | undefined {
  return db
    .prepare(
      'SELECT * FROM input_requests WHERE request_id = ? AND task_id = ? AND tenant_id = ?'
    )
    .get(requestId, taskId, tenantId) as InputRequestRow | undefined;
}

export interface ListInputRequestsOptions {
  status?: InputRequestStatus;
}

export function listInputRequests(
  db: Database.Database,
  tenantId: string,
  taskId: string,
  options: ListInputRequestsOptions = {}
): InputRequestRow[] {
  const rows = options.status
    ? db
      .prepare(
        'SELECT * FROM input_requests WHERE tenant_id = ? AND task_id = ? AND status = ? ORDER BY created_at ASC'
      )
      .all(tenantId, taskId, options.status)
    : db
      .prepare('SELECT * FROM input_requests WHERE tenant_id = ? AND task_id = ? ORDER BY created_at ASC')
      .all(tenantId, taskId);
  return rows as InputRequestRow[];
}

export interface AnsweredInputRequest {
  request: InputRequestRow;
  task: TaskRow;
  event: LedgerEventRow;
}

/**
 * Record an answer: the ledger stores ONLY the pointer to the stored answer
 * file (never the value), marks the request answered, moves the task
 * awaiting_input → running, and writes the paired `task.input_received`
 * event — one transaction.
 */
export function answerInputRequest(
  db: Database.Database,
  tenantId: string,
  taskId: string,
  requestId: string,
  input: { answerPointer: string; answeredAt?: string }
): AnsweredInputRequest {
  const ts = input.answeredAt ?? nowIso();
  let event: LedgerEventRow | undefined;
  // Read + status/transition checks inside the transaction (concurrent python
  // writers); everything rolls back together on any rejection.
  const tx = db.transaction(() => {
    const request = getInputRequest(db, tenantId, taskId, requestId);
    if (!request) {
      throw new LedgerError('request-not-found', `input request ${requestId} not found for tenant`);
    }
    if (request.status !== 'pending') {
      throw new LedgerError(
        'request-already-answered',
        `input request ${requestId} is ${request.status}, not pending`
      );
    }
    const task = getTask(db, tenantId, taskId);
    if (!task) throw new LedgerError('task-not-found', `task ${taskId} not found for tenant`);
    assertTransition(task.state, 'running'); // legal only from awaiting_input (§3)
    db.prepare(
      `UPDATE input_requests
       SET status = 'answered', answer_pointer = ?, answered_at = ?
       WHERE request_id = ? AND task_id = ? AND tenant_id = ?`
    ).run(input.answerPointer, ts, requestId, taskId, tenantId);
    db.prepare(
      `UPDATE tasks SET state = 'running', updated_at = ? WHERE task_id = ? AND tenant_id = ?`
    ).run(ts, taskId, tenantId);
    event = insertEvent(db, tenantId, taskId, 'task.input_received', {
      payload: { request_id: requestId, kind: request.kind },
    });
  });
  tx();
  return {
    request: getInputRequest(db, tenantId, taskId, requestId) as InputRequestRow,
    task: getTask(db, tenantId, taskId) as TaskRow,
    event: event as LedgerEventRow,
  };
}

// Re-exported so consumers of the ledger get the whole widget vocabulary from
// one import site alongside the state machine.
export { INPUT_KINDS };
export type { InputKind, TaskEventKind };
