import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { createTempPaHome, cleanup } from './helpers.js';
import { repoRootFromModule } from '../src/lib/git-root.js';
import { flushLog } from '../src/lib/log.js';
import { voiceInboxLedgerPath } from '../src/lib/voice-inbox-ledger.js';
import {
  runVoiceInboxFallback,
  selectStuckTasks,
  resolveTarget,
  resolveTargetDetailed,
  wordOverlap,
  readFallbackAppConfig,
  DEFAULT_TRANSCRIBING_STALE_MS,
  DEFAULT_RECEIVED_STALE_MS,
  DEFAULT_ROUTED_STALE_MS,
  DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS,
  NEVER_ROUTED_FAILED_REASON,
  DEFAULT_MIN_AUDIO_BYTES,
  DEFAULT_TRANSCRIBE_INFRA_MAX_ATTEMPTS,
  DEFAULT_TRANSCRIBE_INFRA_WINDOW_MS,
  freshestSupervisionAgeMs,
  voiceInboxFallbackJob,
  type TranscribeEnvelope,
  type VoiceInboxFallbackDeps,
  type VoiceInboxModules,
} from '../src/lib/maintenance/jobs/voice-inbox-fallback.js';
import {
  transcribeVoiceInboxTask,
  acquireTranscribeClaim,
  defaultRunScript,
  findAudioFile,
  fileSize,
} from '../src/lib/voice-inbox-transcribe.js';
import {
  buildVoiceRouteRetryMessage,
  returnVoiceTaskForRouting,
  voiceInboxRouteRetryPendingIds,
  VOICE_ROUTE_RETRY_REASON,
  VOICE_ROUTE_RETRY_REQUEST_MAX_CHARS,
} from '../src/lib/voice-inbox-route-retry.js';

let tempDir: string;
let repoRoot: string;

// Fixture topology: one chat, inbox topic at thread 42, general-knowledge at
// thread 0 (the deterministic default target), and an unrelated topic at
// thread 555 that a task is already routed to (the stale-routed scenario).
const CHAT_ID = -1009999999999;
const INBOX_TOPIC = `${CHAT_ID}_42`;
const GENERAL_KNOWLEDGE_TOPIC = `${CHAT_ID}_0`;
const OTHER_TOPIC = `${CHAT_ID}_555`;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  repoRoot = await repoRootFromModule(__filename);
});

afterEach(async () => {
  await cleanup(tempDir);
});

function iso(msAgo: number, now: number): string {
  return new Date(now - msAgo).toISOString();
}

function writeConfigYaml(): void {
  writeFileSync(
    join(tempDir, 'config.yaml'),
    `voice_inbox:\n  inbox_topic: "${INBOX_TOPIC}"\n`,
    'utf8'
  );
}

function writeTopicsJson(): void {
  writeFileSync(
    join(tempDir, 'telegram-topic-names.json'),
    JSON.stringify({
      [String(CHAT_ID)]: {
        '0': { name: 'general-knowledge', description: 'default topic' },
      },
    }),
    'utf8'
  );
}

/**
 * A pa unit test must not depend on another package's build artifact: this
 * used to dynamically `import()` voice-inbox's compiled dist/ledger.js to
 * build the fixture schema, which made every test in this file fail in a
 * clean worktree/CI where projects/voice-inbox is never built (fixed
 * 2026-09-09, AI-214 follow-up F-A gate fix — the fallback job's own
 * production code keeps the equivalent dynamic import behind the injectable
 * `loadVoiceInboxModules` seam; see the "fails open" test below).
 *
 * FIXTURE_SCHEMA_SQL is a hand-copy of
 * projects/voice-inbox/src/ledger.ts's `LEDGER_SCHEMA_SQL` (schema v8,
 * verified current 2026-09-13) — READ, never imported. If that schema
 * changes, this copy must move with it in the same wave (same discipline as
 * the buildTargetInjectionText / EXPECTED_TARGET_TEXT triple-copy documented
 * in projects/voice-inbox/CLAUDE.md). The copy drifted once: the feedback
 * long-press wave (schema v7/v8, feedback_about + result_short +
 * conversation_shares) landed without bumping it, and every received-route
 * test here failed with route_task.py KeyError 'feedback_about' until this
 * copy caught up.
 */
const FIXTURE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS tenants (
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
CREATE INDEX IF NOT EXISTS tasks_tenant_created ON tasks(tenant_id, created_at DESC);
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
CREATE INDEX IF NOT EXISTS inputs_task_status ON input_requests(task_id, status);
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
CREATE INDEX IF NOT EXISTS events_task_ts ON events(task_id, event_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash        TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL,
  telegram_chat_id INTEGER NOT NULL,
  first_name       TEXT,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  consumed_at      TEXT
);
CREATE TABLE IF NOT EXISTS conversation_meta (
  conversation_id TEXT PRIMARY KEY,           -- v5: the conversation's root task_id ('vi-<12 hex>')
  tenant_id       TEXT NOT NULL,
  title           TEXT,                       -- v5: worker-set noun phrase, <=60 chars; NULL means the client derives one
  recap           TEXT,                       -- v5: worker-set state sentences, <=400 chars; NULL means the client derives one
  next_action     TEXT,                       -- v5: worker-set action line, <=200 chars; NULL means none
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_meta_tenant ON conversation_meta(tenant_id);
CREATE TABLE IF NOT EXISTS conversation_shares (
  token           TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  revoked_at      TEXT
);
CREATE INDEX IF NOT EXISTS conversation_shares_lookup
  ON conversation_shares(tenant_id, conversation_id, revoked_at);`;

/** Opens (creating if needed) a real ledger.sqlite fixture built directly
 *  with better-sqlite3 — same WAL/busy_timeout convention as the app's own
 *  openLedger, schema applied from FIXTURE_SCHEMA_SQL above. Caller closes
 *  the handle before any subprocess touches the same file. */
function openFixtureLedger(): Database.Database {
  const dbPath = voiceInboxLedgerPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 3000');
  db.pragma('journal_mode = WAL');
  db.exec(FIXTURE_SCHEMA_SQL);
  return db;
}

/**
 * Fakes for the two voice-inbox-package accessors `handleStaleRouted`
 * dynamically imports via the job's own injectable `loadVoiceInboxModules`
 * seam (never the real dist/ledger.js + dist/bridge-writer.js). Writes real
 * rows into the real db handle / queue file the job hands it, so the
 * assertions still read back genuine state — only the two functions'
 * INTERNAL behaviour is faked; voice-inbox's own test suite owns proving
 * that transitionTask/appendRouteEntry are correct.
 */
function fakeVoiceInboxModules(): VoiceInboxModules {
  return {
    ledger: {
      transitionTask(db, tenantId, taskId, toState, input) {
        const ts = new Date().toISOString();
        db.prepare(
          `UPDATE tasks SET state = ?, routed_to = COALESCE(?, routed_to),
           routing_reason = COALESCE(?, routing_reason), updated_at = ?
           WHERE task_id = ? AND tenant_id = ?`
        ).run(toState, input.routedTo ?? null, input.routingReason ?? null, ts, taskId, tenantId);
        const refId = `s-${randomBytes(6).toString('hex')}`;
        db.prepare(
          `INSERT INTO events (tenant_id, task_id, ref_id, kind, summary, payload_json, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(tenantId, taskId, refId, input.eventKind, null, JSON.stringify(input.eventPayload ?? {}), ts);
        const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
        const event = db.prepare('SELECT * FROM events WHERE ref_id = ?').get(refId);
        return { task, event };
      },
      appendEvent(db, tenantId, taskId, kind, input) {
        const refId = `s-${randomBytes(6).toString('hex')}`;
        const ts = new Date().toISOString();
        db.prepare(
          `INSERT INTO events (tenant_id, task_id, ref_id, kind, summary, payload_json, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(tenantId, taskId, refId, kind, input.summary ?? null, JSON.stringify(input.payload ?? {}), ts);
        return db.prepare('SELECT * FROM events WHERE ref_id = ?').get(refId);
      },
    },
    bridgeWriter: {
      async appendRouteEntry(queuePath, input) {
        mkdirSync(dirname(queuePath), { recursive: true });
        const entry = {
          q_id: `rq-${randomBytes(6).toString('hex')}`,
          ts: new Date().toISOString(),
          task_id: input.taskId,
          tenant_id: input.tenantId,
          chat_id: input.chatId,
          thread_id: input.threadId,
          text: input.text,
          ref_id: `s-${randomBytes(6).toString('hex')}`,
        };
        writeFileSync(queuePath, `${JSON.stringify(entry)}\n`, { flag: 'a' });
        return { q_id: entry.q_id, ref_id: entry.ref_id };
      },
      buildTargetInjectionText(input) {
        return `[Voice task ${input.taskId} routed from inbox — reason: ${input.reason}] ${input.conversationBriefing ?? ''}${input.requestText}.`;
      },
    },
    briefing: {
      CONVERSATION_BRIEFING_MIN: 200,
      buildConversationBriefing() {
        return 'BRIEFING\n';
      },
      briefingBudget() {
        return 1200;
      },
      ledgerPathOf() {
        return 'L';
      },
    },
  };
}

interface FixtureTask {
  task_id: string;
  tenant_id: string;
  source: 'voice' | 'text';
  transcript: string | null;
  request_text: string;
  state: string;
  routed_to?: string | null;
  created_at: string;
  updated_at: string;
}

// Module-level tenant sequence: telegram_user_id is UNIQUE across the whole
// tenants table, and buildFixtureLedger may be called more than once per test
// (e.g. two single-tenant calls building a killed pair + a dead pair). A
// per-call index would collide both calls on 10_000, silently dropping the
// second tenant via INSERT OR IGNORE and FK-failing its task inserts.
let tenantUserIdSeq = 10_000;

async function buildFixtureLedger(tasks: FixtureTask[]): Promise<void> {
  const db = openFixtureLedger();
  try {
    const tenantIds = [...new Set(tasks.map((t) => t.tenant_id))];
    const insertTenant = db.prepare(
      'INSERT OR IGNORE INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    tenantIds.forEach((tenantId) => {
      insertTenant.run(tenantId, tenantUserIdSeq++, CHAT_ID, null, new Date().toISOString());
    });

    const insertTask = db.prepare(
      `INSERT INTO tasks
       (task_id, tenant_id, source, transcript, request_text, state, routed_to, created_at, updated_at, conversation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const t of tasks) {
      insertTask.run(
        t.task_id,
        t.tenant_id,
        t.source,
        t.transcript,
        t.request_text,
        t.state,
        t.routed_to ?? null,
        t.created_at,
        t.updated_at,
        t.task_id // self-rooted conversation, matching createTask's default
      );
    }
  } finally {
    db.close();
  }
}

function writeAudioFile(taskId: string, bytes: number): void {
  const dir = join(tempDir, 'voice-inbox', 'files', taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'audio.webm'), Buffer.alloc(bytes, 1));
}

/** OS-truth readers canned for one test: `alivePids` answers the dead-dispatch
 *  decision's prong 1 (registry pids against the OS), `cmdlinePids` becomes
 *  prong 2's command-line scan hits. Module-scope: used by the dead-dispatch
 *  AND the stuck-placement-alert describes. Never touches the real OS. */
function cannedOsReads(alivePids: number[] = [], cmdlinePids: number[] = []) {
  return {
    areProcessesAliveFn: async (pids: number[]) =>
      new Map(pids.map((p) => [p, alivePids.includes(p)])),
    findProcessesByCommandLineFn: async (needle: string) =>
      cmdlinePids.map((pid) => ({ pid, cmdline: `python worker --dispatch ${needle}` })),
  };
}

/** Kill-path doubles for t-32: records kills/removals; a "successful" kill
 *  removes the pid from the given live sets so a later areProcessesAliveFn
 *  recheck genuinely sees it dead (a static canned map would make every
 *  recheck vacuously report a survivor — the inert-check trap). */
function killRecorder(...liveSets: number[][]) {
  const killed: number[] = [];
  const removed: number[] = [];
  return {
    killProcessFn: (pid: number) => {
      killed.push(pid);
      for (const set of liveSets) {
        const i = set.indexOf(pid);
        if (i >= 0) set.splice(i, 1);
      }
    },
    removeWorkerPidFn: async (pid: number) => {
      removed.push(pid);
    },
    killed,
    removed,
  };
}

function readTaskRow(taskId: string): any {
  const db = new Database(voiceInboxLedgerPath(), { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
  } finally {
    db.close();
  }
}

function readEvents(taskId: string): any[] {
  const db = new Database(voiceInboxLedgerPath(), { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY event_id ASC').all(taskId);
  } finally {
    db.close();
  }
}

function readRouteQueueLines(): any[] {
  const path = join(tempDir, 'voice-inbox', 'route-queue.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** Seeds N prior task.rerouted events for one task — the replay counter the
 *  stuck-placement threshold reads. Direct-SQL seeding is this file's
 *  established idiom (claimTask/setDispatchId below do the same for columns). */
function seedRerouteEvents(taskId: string, tenantId: string, count: number): void {
  if (count <= 0) return;
  const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
  try {
    const insert = db.prepare(
      `INSERT INTO events (tenant_id, task_id, ref_id, kind, summary, payload_json, ts)
       VALUES (?, ?, ?, 'task.rerouted', NULL, '{}', ?)`
    );
    for (let i = 0; i < count; i += 1) {
      insert.run(tenantId, taskId, `s-${randomBytes(6).toString('hex')}`, new Date().toISOString());
    }
  } finally {
    db.close();
  }
}

/** Seeds N prior NON-TERMINAL infra-attempt markers — task.failed events with
 *  payload code 'infra' on a still-transcribing task (AI-239). Same direct-SQL
 *  idiom as seedRerouteEvents. */
function seedInfraMarkerEvents(taskId: string, tenantId: string, count: number, tsMs?: number): void {
  if (count <= 0) return;
  const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
  try {
    const insert = db.prepare(
      `INSERT INTO events (tenant_id, task_id, ref_id, kind, summary, payload_json, ts)
       VALUES (?, ?, ?, 'task.failed', NULL, ?, ?)`
    );
    for (let i = 0; i < count; i += 1) {
      insert.run(
        tenantId,
        taskId,
        `s-${randomBytes(6).toString('hex')}`,
        JSON.stringify({ reason: `transcription failed (other): attempt ${i + 1}`, code: 'infra' }),
        new Date(tsMs ?? Date.now()).toISOString()
      );
    }
  } finally {
    db.close();
  }
}

/** A notifyFn double recording every call. Typed through the job's own deps
 *  interface (notify.ts does not export NotifyOpts) so the spy's parameters
 *  stay signature-compatible under strict mode. */
function recordingNotifyFn(): {
  notifyFn: NonNullable<VoiceInboxFallbackDeps['notifyFn']>;
  calls: Array<{ subject: string; body: string; dedupKey?: string; severity?: string }>;
} {
  const calls: Array<{ subject: string; body: string; dedupKey?: string; severity?: string }> = [];
  const notifyFn: NonNullable<VoiceInboxFallbackDeps['notifyFn']> = async (subject, body, opts) => {
    calls.push({ subject, body, dedupKey: opts?.dedupKey, severity: opts?.severity });
    return { sent: true, suppressed: false };
  };
  return { notifyFn, calls };
}

describe('voice-inbox-fallback: pure helpers', () => {
  it('wordOverlap: identical short phrases score 1', () => {
    assert.equal(wordOverlap('how does this work', 'how does this work'), 1);
  });

  it('wordOverlap: disjoint phrases score 0', () => {
    assert.equal(wordOverlap('what time is it', 'reset my password please'), 0);
  });

  it('resolveTarget: keyword table wins over the default', () => {
    const cfg = { inboxTopic: INBOX_TOPIC, keywordTopics: { invoice: OTHER_TOPIC } };
    assert.equal(resolveTarget('please find my invoice from march', cfg), OTHER_TOPIC);
  });

  it('resolveTarget: falls back to <inboxChat>_0 with an empty keyword table', () => {
    const cfg = { inboxTopic: INBOX_TOPIC, keywordTopics: {} };
    assert.equal(resolveTarget('anything at all', cfg), GENERAL_KNOWLEDGE_TOPIC);
  });

  it('readFallbackAppConfig: empty/missing config.yaml yields no inbox topic and an empty table', () => {
    const cfg = readFallbackAppConfig();
    assert.deepEqual(cfg, { keywordTopics: {} });
  });
});

describe('voice-inbox-fallback: registry shape', () => {
  it('is non-destructive with no retention targets and never sheds', () => {
    assert.equal(voiceInboxFallbackJob.host, 'pa');
    assert.equal(voiceInboxFallbackJob.destructive, false);
    assert.deepEqual(voiceInboxFallbackJob.targets, []);
    assert.equal(voiceInboxFallbackJob.shedWhenDegraded, false);
  });
});

describe('voice-inbox-fallback: job run', () => {
  it('places a sub-floor transcribing task as transcribe_failed WITHOUT ever calling the transcribe seam', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000001',
        tenant_id: 't-tiny',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
      },
    ]);
    writeAudioFile('vi-000000000001', 100); // well under the 8 KB floor

    let transcribeCalls = 0;
    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      { transcribeFn: async (): Promise<TranscribeEnvelope> => { transcribeCalls += 1; return { ok: true, text: 'unused' }; } }
    );

    assert.equal(transcribeCalls, 0, 'the size floor must short-circuit before the transcribe seam is ever invoked');
    assert.equal(result.touched, 1);
    const row = readTaskRow('vi-000000000001');
    assert.equal(row.state, 'transcribe_failed');
    const events = readEvents('vi-000000000001');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.failed');
    const payload = JSON.parse(events[0].payload_json);
    assert.match(payload.reason, /8192-byte floor/);
    assert.match(payload.reason, /deterministic fallback/);
    assert.equal(payload.code, 'too_short'); // AI-223: sub-floor is coded so the PWA hides it
  });

  it('AI-223: an empty transcript is coded too_short, a genuine transcription error is NOT', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000005',
        tenant_id: 't-empty',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
      },
      {
        task_id: 'vi-000000000006',
        tenant_id: 't-realerr',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
      },
    ]);
    // Both well over the 8 KB floor — the code must come from the transcribe
    // outcome, not the byte-floor branch, for this test to mean anything.
    writeAudioFile('vi-000000000005', DEFAULT_MIN_AUDIO_BYTES + 5000);
    writeAudioFile('vi-000000000006', DEFAULT_MIN_AUDIO_BYTES + 5000);

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        transcribeFn: async (audioPath): Promise<TranscribeEnvelope> => {
          if (audioPath.includes('vi-000000000005')) return { ok: true, text: '   ' }; // empty after trim
          return { ok: false, error_code: 'network_error', error: 'timeout' };
        },
      }
    );

    assert.equal(result.touched, 2);

    const emptyEvents = readEvents('vi-000000000005');
    assert.equal(emptyEvents.length, 1);
    const emptyPayload = JSON.parse(emptyEvents[0].payload_json);
    assert.match(emptyPayload.reason, /empty transcript/);
    assert.equal(emptyPayload.code, 'too_short');

    const realErrEvents = readEvents('vi-000000000006');
    assert.equal(realErrEvents.length, 1);
    const realErrPayload = JSON.parse(realErrEvents[0].payload_json);
    assert.match(realErrPayload.reason, /transcription failed/);
    // AI-239: an infra-class failure is a NON-TERMINAL marker — the event
    // carries code 'infra' (never too_short — that is the audio-unusable code)
    // and the task stays transcribing for the next tick's retry.
    assert.equal(realErrPayload.code, 'infra', 'an infra-class error is coded infra, not too_short');
    assert.equal(readTaskRow('vi-000000000006').state, 'transcribing');
  });

  it('AI-239: at the infra-attempt cap the task goes terminal transcribe_failed with code infra and the operator is paged — WITHOUT calling the transcribe seam', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000008',
        tenant_id: 't-infra-cap',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
      },
    ]);
    writeAudioFile('vi-000000000008', DEFAULT_MIN_AUDIO_BYTES + 5000);
    seedInfraMarkerEvents('vi-000000000008', 't-infra-cap', DEFAULT_TRANSCRIBE_INFRA_MAX_ATTEMPTS);
    const { notifyFn, calls } = recordingNotifyFn();

    let transcribeCalls = 0;
    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn,
        transcribeFn: async (): Promise<TranscribeEnvelope> => {
          transcribeCalls += 1;
          return { ok: false, error_code: 'other', error: 'should never be reached' };
        },
      }
    );

    assert.equal(transcribeCalls, 0, 'the bound check runs BEFORE the transcribe seam — no API burn past the cap');
    assert.equal(result.touched, 1);
    assert.equal(readTaskRow('vi-000000000008').state, 'transcribe_failed');
    const events = readEvents('vi-000000000008');
    assert.equal(events.length, DEFAULT_TRANSCRIBE_INFRA_MAX_ATTEMPTS + 1);
    const terminal = JSON.parse(events[events.length - 1].payload_json);
    assert.equal(terminal.code, 'infra');
    assert.match(terminal.reason, /giving up/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dedupKey, 'voice-inbox-transcribe-failed:vi-000000000008');
    assert.equal(calls[0].severity, 'warn');
  });

  it('AI-239: a task older than the infra window WITH a recorded marker goes terminal — but a virgin over-age task still gets one real attempt', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000009',
        tenant_id: 't-infra-old',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBE_INFRA_WINDOW_MS + 10 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBE_INFRA_WINDOW_MS + 10 * 60_000, now),
      },
      {
        task_id: 'vi-00000000000a',
        tenant_id: 't-virgin-old',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBE_INFRA_WINDOW_MS + 10 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBE_INFRA_WINDOW_MS + 10 * 60_000, now),
      },
    ]);
    writeAudioFile('vi-000000000009', DEFAULT_MIN_AUDIO_BYTES + 5000);
    writeAudioFile('vi-00000000000a', DEFAULT_MIN_AUDIO_BYTES + 5000);
    // One recorded marker turns "old" into "retry saga" for the age bound;
    // the virgin task has none — it must still get its first attempt.
    seedInfraMarkerEvents('vi-000000000009', 't-infra-old', 1);
    const { notifyFn, calls } = recordingNotifyFn();

    const transcribed: string[] = [];
    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn,
        transcribeFn: async (audioPath): Promise<TranscribeEnvelope> => {
          transcribed.push(audioPath);
          return { ok: false, error_code: 'other', error: 'still down' };
        },
      }
    );

    // The aged task with a recorded marker is terminal — no seam call.
    assert.equal(readTaskRow('vi-000000000009').state, 'transcribe_failed');
    const events9 = readEvents('vi-000000000009');
    assert.equal(events9.length, 2);
    assert.equal(JSON.parse(events9[1].payload_json).code, 'infra');
    // The virgin over-age task is NOT failed outright — it got one real
    // attempt, which recorded a marker and left it transcribing for the next
    // tick's terminal bound.
    assert.equal(transcribed.length, 1);
    assert.ok(transcribed[0].includes('vi-00000000000a'), transcribed[0]);
    assert.equal(readTaskRow('vi-00000000000a').state, 'transcribing');
    const eventsA = readEvents('vi-00000000000a');
    assert.equal(eventsA.length, 1);
    assert.equal(JSON.parse(eventsA[0].payload_json).code, 'infra');
    assert.equal(result.touched, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dedupKey, 'voice-inbox-transcribe-failed:vi-000000000009');
  });

  it('AI-239: audio-side envelope codes (oversize, missing-file) stay terminal immediately — no marker, no retry', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-00000000000b',
        tenant_id: 't-oversize',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
      },
      {
        task_id: 'vi-00000000000c',
        tenant_id: 't-missing',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
      },
    ]);
    writeAudioFile('vi-00000000000b', DEFAULT_MIN_AUDIO_BYTES + 5000);
    writeAudioFile('vi-00000000000c', DEFAULT_MIN_AUDIO_BYTES + 5000);
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn,
        transcribeFn: async (audioPath): Promise<TranscribeEnvelope> => ({
          ok: false,
          error_code: audioPath.includes('vi-00000000000b') ? 'oversize' : 'missing-file',
          error: 'audio-side failure',
        }),
      }
    );

    assert.equal(result.touched, 2);
    for (const taskId of ['vi-00000000000b', 'vi-00000000000c']) {
      assert.equal(readTaskRow(taskId).state, 'transcribe_failed');
      const events = readEvents(taskId);
      assert.equal(events.length, 1);
      const payload = JSON.parse(events[0].payload_json);
      assert.match(payload.reason, /transcription failed/);
      assert.equal('code' in payload, false, 'audio-side failures carry no code — they surface like any terminal failure');
    }
    assert.equal(calls.length, 0, 'terminal audio-side failures are not paged — they were never retried');
  });

  it('AI-239: a marker that cannot be written (voice-inbox dist missing) leaves a young task transcribing but terminalizes an over-age one — the count bound can never engage', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-00000000000d',
        tenant_id: 't-nodist',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
      },
      {
        task_id: 'vi-00000000000e',
        tenant_id: 't-nodist-old',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBE_INFRA_WINDOW_MS + 10 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBE_INFRA_WINDOW_MS + 10 * 60_000, now),
      },
    ]);
    writeAudioFile('vi-00000000000d', DEFAULT_MIN_AUDIO_BYTES + 5000);
    writeAudioFile('vi-00000000000e', DEFAULT_MIN_AUDIO_BYTES + 5000);
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        loadVoiceInboxModules: async () => {
          throw new Error('Cannot find module dist/ledger.js');
        },
        notifyFn,
        transcribeFn: async (): Promise<TranscribeEnvelope> => ({
          ok: false,
          error_code: 'no-engine',
          error: 'no transcription key configured',
        }),
      }
    );

    // Young task: nothing durable landed — the marker write failed open.
    assert.equal(readTaskRow('vi-00000000000d').state, 'transcribing');
    assert.equal(readEvents('vi-00000000000d').length, 0);
    // Over-age task: the marker channel is broken so the count bound can never
    // engage — the unwritten-and-over-age path terminalizes via the script.
    assert.equal(readTaskRow('vi-00000000000e').state, 'transcribe_failed');
    const eventsE = readEvents('vi-00000000000e');
    assert.equal(eventsE.length, 1);
    assert.equal(JSON.parse(eventsE[0].payload_json).code, 'infra');
    assert.match(JSON.parse(eventsE[0].payload_json).reason, /could not be recorded/);
    assert.equal(result.touched, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dedupKey, 'voice-inbox-transcribe-failed:vi-00000000000e');
  });

  it('places a real transcribing task as received via the mocked transcribe seam', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000002',
        tenant_id: 't-real',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
      },
    ]);
    writeAudioFile('vi-000000000002', DEFAULT_MIN_AUDIO_BYTES + 5000);

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        transcribeFn: async (audioPath): Promise<TranscribeEnvelope> => {
          assert.match(audioPath, /vi-000000000002/);
          return { ok: true, text: 'the shop closes at nine', engine: 'groq' };
        },
      }
    );

    assert.equal(result.touched, 1);
    const row = readTaskRow('vi-000000000002');
    assert.equal(row.state, 'received');
    assert.equal(row.transcript, 'the shop closes at nine');
    assert.equal(row.request_text, 'the shop closes at nine');
    const events = readEvents('vi-000000000002');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.transcribed');
    const payload = JSON.parse(events[0].payload_json);
    assert.equal(payload.engine, 'groq');
  });

  it('routes a stuck received task to the deterministic general-knowledge target', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000003',
        tenant_id: 't-received',
        source: 'text',
        transcript: null,
        request_text: 'will it rain tomorrow',
        state: 'received',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 20 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 20 * 60_000, now),
      },
    ]);

    const result = await runVoiceInboxFallback({ now, everyMs: 300_000 });

    assert.equal(result.touched, 1);
    const row = readTaskRow('vi-000000000003');
    assert.equal(row.state, 'routed');
    assert.equal(row.routed_to, GENERAL_KNOWLEDGE_TOPIC);
    const events = readEvents('vi-000000000003');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.routed');
    const payload = JSON.parse(events[0].payload_json);
    assert.match(payload.reason, /deterministic fallback/);
    const queued = readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000003');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].thread_id, 0);
  });

  // Negative twin of the merge behaviour: shares SOME topic words with a very
  // recent same-tenant task ("what", "time", "the"), but the word-set Jaccard
  // similarity is 3/9 ≈ 0.33 — below CONTINUES_WORD_OVERLAP_MIN (0.6) — so the
  // two tasks must NOT merge, even though the 3-minute creation-gap gate alone
  // would allow it. Proves the overlap threshold is actually enforced, not
  // just the time gap.
  it('does NOT merge a recent same-tenant task that shares some words but falls under the 0.6 overlap threshold', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    const staleTaskAgeMs = DEFAULT_TRANSCRIBING_STALE_MS + 26 * 60_000;
    await buildFixtureLedger([
      {
        // The stuck task the fallback will route.
        task_id: 'vi-00000000000a',
        tenant_id: 't-negative-continues',
        source: 'text',
        transcript: null,
        request_text: 'what time is the meeting tomorrow',
        state: 'received',
        created_at: iso(staleTaskAgeMs, now),
        updated_at: iso(staleTaskAgeMs, now),
      },
      {
        // A non-terminal, same-tenant task created 1 minute later (well
        // within the 3-minute window) — the only thing that should block
        // the merge is the word-overlap gate.
        task_id: 'vi-00000000000b',
        tenant_id: 't-negative-continues',
        source: 'text',
        transcript: null,
        request_text: 'what time does the pharmacy close',
        state: 'running',
        created_at: iso(staleTaskAgeMs - 60_000, now),
        updated_at: iso(staleTaskAgeMs - 60_000, now),
      },
    ]);

    // Sanity-check the fixture actually sits under the threshold before
    // trusting the integration assertion below.
    assert.ok(
      wordOverlap('what time is the meeting tomorrow', 'what time does the pharmacy close') < 0.6
    );

    const result = await runVoiceInboxFallback({ now, everyMs: 300_000 });

    assert.equal(result.touched, 1);
    const row = readTaskRow('vi-00000000000a');
    assert.equal(row.state, 'routed');
    // Self-rooted conversation is UNCHANGED — no merge happened.
    assert.equal(row.conversation_id, 'vi-00000000000a');
    const events = readEvents('vi-00000000000a');
    assert.equal(events.length, 1);
    const payload = JSON.parse(events[0].payload_json);
    assert.equal(payload.continues, undefined, 'route_task.py must not have received --continues');
  });

  it('does not clobber a task a live worker already routed between the scan and the write (race guard, vi-6cb5faaf1b74)', async () => {
    // Live incident this reproduces: selectStuckTasks snapshots a `received`
    // task, but the real (LLM) inbox worker routes it for real before this
    // job gets around to calling route_task.py — route_task.py's own state
    // gate would still accept the call (it allows re-routing FROM 'routed'
    // too, for the legitimate stale-routed replay), so without a live re-check
    // the fallback silently overwrites the worker's correct routing with its
    // own generic keyword-table default (observed: vi-7d9f91d0e907, routed by
    // an LLM worker to a specific topic, then re-routed by this job to
    // general-knowledge 5 seconds later).
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    const LIVE_WORKER_TOPIC = `${CHAT_ID}_10525`;
    await buildFixtureLedger([
      {
        task_id: 'vi-00000000000c',
        tenant_id: 't-race-guard',
        source: 'text',
        transcript: null,
        request_text: 'a request the fallback should not re-route',
        state: 'received',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 20 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 20 * 60_000, now),
      },
    ]);

    // repoRootFn runs after selectStuckTasks's snapshot and before the
    // per-task actions — exactly the race window — so mutating the row here
    // simulates the live worker's write landing inside that window.
    const realRepoRoot = await repoRootFromModule(__filename);
    const repoRootFn = async (): Promise<string> => {
      const db = openFixtureLedger();
      try {
        db.prepare('UPDATE tasks SET state = ?, routed_to = ? WHERE task_id = ?')
          .run('routed', LIVE_WORKER_TOPIC, 'vi-00000000000c');
      } finally {
        db.close();
      }
      return realRepoRoot;
    };

    const result = await runVoiceInboxFallback({ now, everyMs: 300_000 }, { repoRootFn });

    assert.equal((result.detail as { received: number }).received, 0, 'the fallback must not count this as a placement it made');
    const row = readTaskRow('vi-00000000000c');
    assert.equal(row.state, 'routed');
    assert.equal(row.routed_to, LIVE_WORKER_TOPIC, "must keep the live worker's routing, not overwrite it");
    const events = readEvents('vi-00000000000c');
    assert.equal(events.length, 0, 'no task.routed event from the fallback — it never called route_task.py');
  });

  it('replays a stale routed task via transitionTask + appendRouteEntry, never hand-building the line', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000004',
        tenant_id: 't-stale-routed',
        source: 'text',
        transcript: null,
        request_text: 'reminder about the electricity bill',
        state: 'routed',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_ROUTED_STALE_MS + 5 * 60_000, now),
      },
    ]);

    // Fakes for the two voice-inbox-package accessors the job dynamically
    // imports in production (see fakeVoiceInboxModules above) — this proves
    // the JOB's own orchestration (opens the real ledger fixture for write,
    // passes the right args, closes it, appends the real queue file) without
    // depending on projects/voice-inbox/dist being built. transitionTask's
    // and appendRouteEntry's actual internal behaviour is voice-inbox's own
    // test suite's responsibility (src/tests/ledger.test.ts, bridge-writer),
    // not this pa-side seam test's.
    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      { loadVoiceInboxModules: async () => fakeVoiceInboxModules() }
    );

    assert.equal(result.touched, 1);
    const row = readTaskRow('vi-000000000004');
    assert.equal(row.state, 'routed');
    assert.equal(row.routed_to, OTHER_TOPIC);
    // updated_at must have moved forward — this IS the idempotency signal for
    // the next tick (see the job's stale-routed staleness re-check).
    assert.ok(Date.parse(row.updated_at) > now - 60_000);
    const events = readEvents('vi-000000000004');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.rerouted');
    const queued = readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000004');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].chat_id, CHAT_ID);
    assert.equal(queued[0].thread_id, 555);
    assert.match(queued[0].text, /routed from inbox — reason: Placed by the deterministic fallback/);
  });

  it('leaves a fresh task completely untouched', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000005',
        tenant_id: 't-fresh',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(0, now),
        updated_at: iso(0, now),
      },
    ]);

    const before = readTaskRow('vi-000000000005');
    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      { transcribeFn: async (): Promise<TranscribeEnvelope> => { throw new Error('must not be called'); } }
    );

    assert.equal(result.touched, 0);
    const after = readTaskRow('vi-000000000005');
    assert.deepEqual(after, before);
    assert.deepEqual(readEvents('vi-000000000005'), []);
  });

  it('selectStuckTasks excludes tasks that carry a worker_resource', async () => {
    const now = Date.now();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000006',
        tenant_id: 't-claimed',
        source: 'text',
        transcript: null,
        request_text: 'in progress elsewhere',
        state: 'received',
        created_at: iso(DEFAULT_RECEIVED_STALE_MS + 60_000, now),
        updated_at: iso(DEFAULT_RECEIVED_STALE_MS + 60_000, now),
      },
    ]);
    // Claim it exactly like a real worker's task_telemetry.py progress call would.
    const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
    db.prepare("UPDATE tasks SET worker_resource = 'topic--1_1' WHERE task_id = ?").run('vi-000000000006');
    db.close();

    const rows = selectStuckTasks(voiceInboxLedgerPath(), now, DEFAULT_TRANSCRIBING_STALE_MS, DEFAULT_ROUTED_STALE_MS, DEFAULT_RECEIVED_STALE_MS);
    assert.deepEqual(rows, []);
  });

  it('is disabled entirely by PA_VOICE_INBOX_FALLBACK=0', async () => {
    const now = Date.now();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000007',
        tenant_id: 't-disabled',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 60_000, now),
      },
    ]);
    const prev = process.env.PA_VOICE_INBOX_FALLBACK;
    process.env.PA_VOICE_INBOX_FALLBACK = '0';
    try {
      const result = await runVoiceInboxFallback({ now, everyMs: 300_000 });
      assert.equal(result.touched, 0);
      assert.equal(readTaskRow('vi-000000000007').state, 'transcribing');
    } finally {
      if (prev === undefined) delete process.env.PA_VOICE_INBOX_FALLBACK;
      else process.env.PA_VOICE_INBOX_FALLBACK = prev;
    }
  });

  it('fails open when the voice-inbox package is not built: skips the stale-routed replay and logs one warn line naming the missing module', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000008',
        tenant_id: 't-package-missing',
        source: 'text',
        transcript: null,
        request_text: 'reminder about renewing the passport',
        state: 'routed',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_ROUTED_STALE_MS + 5 * 60_000, now),
      },
    ]);
    const before = readTaskRow('vi-000000000008');

    // Simulates a fresh clone / CI where projects/voice-inbox has never been
    // built — the same ERR_MODULE_NOT_FOUND shape Node throws for a missing
    // dynamic import(), naming the real path so the log line's content is
    // provably "the missing module", not a synthetic label.
    const missingModulePath = join(repoRoot, 'projects', 'voice-inbox', 'dist', 'ledger.js');
    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        loadVoiceInboxModules: async () => {
          throw new Error(`Cannot find module '${missingModulePath}'`);
        },
      }
    );

    assert.equal(result.touched, 0);
    assert.deepEqual(result.detail, { transcribing: 0, received: 0, routed: 0, running: 0 });
    const after = readTaskRow('vi-000000000008');
    assert.deepEqual(after, before, 'a failed module load must leave the task row completely untouched');
    assert.deepEqual(readEvents('vi-000000000008'), []);
    assert.deepEqual(readRouteQueueLines(), []);

    await flushLog();
    const appLog = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
    const lines = appLog
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const warnLines = lines.filter(
      (l) => l.level === 'warn' && l.module === 'voice-inbox-fallback' && l.taskId === 'vi-000000000008'
    );
    assert.equal(warnLines.length, 1, 'expected exactly one warn line for the failed-import skip');
    assert.match(warnLines[0].refId, /^s-[0-9a-f]{12}$/);
    assert.match(
      String(warnLines[0].error ?? ''),
      /voice-inbox[\\/]dist[\\/]ledger\.js/,
      'the warn line must name the missing module'
    );
  });

  it('skips a transcribing task whose transcription claim is held elsewhere without calling the transcribe seam', async () => {
    const now = Date.now();
    await buildFixtureLedger([
      {
        task_id: 'vi-0000000000c3',
        tenant_id: 't-claim-busy',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
      },
    ]);
    writeAudioFile('vi-0000000000c3', DEFAULT_MIN_AUDIO_BYTES + 5000);

    let transcribeCalls = 0;
    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        claimFn: async () => null,
        transcribeFn: async (): Promise<TranscribeEnvelope> => {
          transcribeCalls += 1;
          return { ok: true, text: 'unused' };
        },
      }
    );

    assert.equal(transcribeCalls, 0);
    assert.equal(result.touched, 0);
    assert.equal(readTaskRow('vi-0000000000c3').state, 'transcribing');
    assert.equal(readEvents('vi-0000000000c3').length, 0);
  });

  it('does not retry an infra-marked task before its retry backoff elapses', async () => {
    const now = Date.now();
    await buildFixtureLedger([
      {
        task_id: 'vi-0000000000c7',
        tenant_id: 't-infra-backoff-wait',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
      },
    ]);
    writeAudioFile('vi-0000000000c7', DEFAULT_MIN_AUDIO_BYTES + 5000);
    seedInfraMarkerEvents('vi-0000000000c7', 't-infra-backoff-wait', 1);

    let transcribeCalls = 0;
    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        transcribeFn: async (): Promise<TranscribeEnvelope> => {
          transcribeCalls += 1;
          return { ok: false, error_code: 'other', error: 'still down' };
        },
      }
    );

    assert.equal(transcribeCalls, 0);
    assert.equal(result.touched, 0);
    assert.equal(readEvents('vi-0000000000c7').length, 1);
  });

  it('retries an infra-marked task once its retry backoff has elapsed', async () => {
    const now = Date.now();
    await buildFixtureLedger([
      {
        task_id: 'vi-0000000000c8',
        tenant_id: 't-infra-backoff-elapsed',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
      },
    ]);
    writeAudioFile('vi-0000000000c8', DEFAULT_MIN_AUDIO_BYTES + 5000);
    seedInfraMarkerEvents('vi-0000000000c8', 't-infra-backoff-elapsed', 1, now - 3 * 60_000);

    let transcribeCalls = 0;
    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        transcribeFn: async (): Promise<TranscribeEnvelope> => {
          transcribeCalls += 1;
          return { ok: false, error_code: 'other', error: 'still down' };
        },
      }
    );

    assert.equal(transcribeCalls, 1);
    assert.equal(result.touched, 1);
    const events = readEvents('vi-0000000000c8');
    assert.equal(events.length, 2);
    const newest = JSON.parse(events[events.length - 1].payload_json);
    assert.equal(newest.code, 'infra');
    assert.equal(readTaskRow('vi-0000000000c8').state, 'transcribing');
  });

  it('releases the transcription claim after the attempt', async () => {
    const now = Date.now();
    await buildFixtureLedger([
      {
        task_id: 'vi-0000000000c9',
        tenant_id: 't-claim-release',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
      },
    ]);
    writeAudioFile('vi-0000000000c9', DEFAULT_MIN_AUDIO_BYTES + 5000);

    const acquired: boolean[] = [];
    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        transcribeFn: async (): Promise<TranscribeEnvelope> => ({ ok: true, text: 'claim release check', engine: 'groq' }),
        claimFn: async (id: string) => {
          const c = await acquireTranscribeClaim(id);
          acquired.push(c !== null);
          return c;
        },
      }
    );

    assert.deepEqual(acquired, [true]);
    assert.equal(result.touched, 1);
    assert.equal(readTaskRow('vi-0000000000c9').state, 'received');
    const blackboardData = JSON.parse(readFileSync(join(tempDir, 'blackboard.json'), 'utf8'));
    assert.ok(
      !blackboardData.active_locks.some((l: any) => String(l.resource ?? '').startsWith('voice-inbox-transcribe:')),
      'the transcription claim must be released after the attempt'
    );
  });

  it('does not transcribe a task that left transcribing before the claimed attempt began', async () => {
    const now = Date.now();
    await buildFixtureLedger([
      {
        task_id: 'vi-0000000000d1',
        tenant_id: 't-raced-away',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 4 * 60_000, now),
      },
    ]);
    writeAudioFile('vi-0000000000d1', DEFAULT_MIN_AUDIO_BYTES + 5000);

    let transcribeCalls = 0;
    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        transcribeFn: async (): Promise<TranscribeEnvelope> => {
          transcribeCalls += 1;
          return { ok: true, text: 'unused' };
        },
        claimFn: async () => {
          const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
          try {
            db.prepare(
              `UPDATE tasks SET state = 'received', transcript = 'done elsewhere', request_text = 'done elsewhere' WHERE task_id = ?`
            ).run('vi-0000000000d1');
          } finally {
            db.close();
          }
          return { release: async () => {} };
        },
      }
    );

    assert.equal(transcribeCalls, 0);
    assert.equal(result.touched, 0);
    assert.equal(readEvents('vi-0000000000d1').length, 0);
  });

  it('asserts the transcribing and received default staleness values by name', () => {
    // WP-F (2026-09-16): the transcribing arm dropped to 2 min now that
    // WP-3a and WP-4 are both live and verified; the received arm stays at
    // 6 min (A1/D6) so deterministic routing never races the LLM routing
    // worker any earlier than before.
    assert.equal(DEFAULT_TRANSCRIBING_STALE_MS, 120_000);
    assert.equal(DEFAULT_RECEIVED_STALE_MS, 360_000);
  });

  it('selectStuckTasks applies the transcribing and received thresholds independently', async () => {
    // WP-F: DEFAULT_TRANSCRIBING_STALE_MS (2 min) and DEFAULT_RECEIVED_STALE_MS
    // (6 min) now differ for real, so this test drives selectStuckTasks with
    // the actual defaults rather than injected stand-in values.
    const injectedTranscribingStaleMs = DEFAULT_TRANSCRIBING_STALE_MS;
    const injectedReceivedStaleMs = DEFAULT_RECEIVED_STALE_MS;
    const now = Date.now();
    await buildFixtureLedger([
      {
        task_id: 'vi-0000000000d2',
        tenant_id: 't-thresholds-t1',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(3 * 60_000, now),
        updated_at: iso(3 * 60_000, now),
      },
      {
        task_id: 'vi-0000000000d3',
        tenant_id: 't-thresholds-r1',
        source: 'text',
        transcript: null,
        request_text: 'recently received',
        state: 'received',
        created_at: iso(3 * 60_000, now),
        updated_at: iso(3 * 60_000, now),
      },
      {
        task_id: 'vi-0000000000d4',
        tenant_id: 't-thresholds-r2',
        source: 'text',
        transcript: null,
        request_text: 'stale received',
        state: 'received',
        created_at: iso(7 * 60_000, now),
        updated_at: iso(7 * 60_000, now),
      },
    ]);

    const rows = selectStuckTasks(
      voiceInboxLedgerPath(),
      now,
      injectedTranscribingStaleMs,
      DEFAULT_ROUTED_STALE_MS,
      injectedReceivedStaleMs
    );
    assert.deepEqual(
      rows.map((r) => r.task_id).sort(),
      ['vi-0000000000d2', 'vi-0000000000d4'].sort()
    );
  });

  it('the drain caller writes the deterministic-transcription reason suffix, never the fallback one', async () => {
    const now = Date.now();
    await buildFixtureLedger([
      {
        task_id: 'vi-0000000000d5',
        tenant_id: 't-drain-suffix',
        source: 'voice',
        transcript: null,
        request_text: '(voice recording)',
        state: 'transcribing',
        created_at: iso(10_000, now),
        updated_at: iso(10_000, now),
      },
    ]);
    writeAudioFile('vi-0000000000d5', 100);
    const { notifyFn } = recordingNotifyFn();

    const outcome = await transcribeVoiceInboxTask(
      { task_id: 'vi-0000000000d5', tenant_id: 't-drain-suffix', created_at: iso(10_000, now) },
      {
        caller: 'voice-inbox-transcribe-drain',
        now,
        repoRoot,
        ledgerPath: voiceInboxLedgerPath(),
        infraMaxAttempts: 4,
        infraWindowMs: 45 * 60_000,
      },
      {
        runScript: defaultRunScript,
        transcribeFn: async () => {
          throw new Error('must not be called');
        },
        loadSecretsFn: async () => ({}),
        findAudioFileFn: findAudioFile,
        fileSizeFn: fileSize,
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn,
        claimFn: async () => ({ release: async () => {} }),
      }
    );

    assert.equal(outcome.kind, 'failed-terminal');
    assert.equal(outcome.acted, true);
    const events = readEvents('vi-0000000000d5');
    assert.equal(events.length, 1);
    const payload = JSON.parse(events[0].payload_json);
    assert.match(payload.reason, /deterministic transcription/);
    assert.doesNotMatch(payload.reason, /deterministic fallback/);
    assert.equal(payload.code, 'too_short');
  });
});

// 2026-09-11 double-routing incident (conversation vi-1415efecbf6b): a worker
// claims ONE task row of a conversation but works the WHOLE conversation (the
// th1 worker completed all three open tasks of that conversation at once), so
// an unclaimed sibling left in `routed` still matched the stale-routed scan's
// per-task `worker_resource IS NULL` gate and was re-routed three times in one
// hour, double-delivering into a topic the conversation's worker was already
// handling. The stale-routed scan now also requires that NO task of the same
// conversation carries a worker_resource — matching conversationWorkerResource's
// "whatever that task's state" reading (worker_resource survives completion),
// so a conversation claimed once is never re-injected by the fallback.
// Early-stage placement (transcribing/received) is deliberately NOT guarded:
// those are first placements, and suppressing them would strand a genuinely
// new note recorded into a busy conversation.
describe('voice-inbox-fallback — conversation-claim guard on the stale-routed reroute', () => {
  function setConversationId(taskId: string, conversationId: string): void {
    const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
    try {
      db.prepare('UPDATE tasks SET conversation_id = ? WHERE task_id = ?').run(conversationId, taskId);
    } finally {
      db.close();
    }
  }

  function claimTask(taskId: string, workerResource: string): void {
    const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
    try {
      db.prepare('UPDATE tasks SET worker_resource = ? WHERE task_id = ?').run(workerResource, taskId);
    } finally {
      db.close();
    }
  }

  // The incident shape, distilled: sibling A done+claimed (worker_resource
  // retained after completion, exactly like the real rows), sibling B routed,
  // stale, unclaimed. Fixed gate (2026-09-11): only a LIVE sibling —
  // worker_resource set AND state running/awaiting_input — blocks the
  // reroute; a sibling whose worker_resource survives past a terminal state
  // (done here) must not. The original per-task gate: B is "stuck" ->
  // reroute x3 regardless of siblings. The first conversation-claim gate
  // (b379243, superseded same day): ANY worker_resource in the conversation,
  // any state, blocks B — that is what starved conversation
  // vi-35a4487d5c04 for 2+ hours once its only sibling had finished.
  it('stale-routed replay ignores done siblings — only running/awaiting_input siblings block re-injection', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      // Conversation with a DONE sibling: worker_resource is retained after
      // completion, but the sibling is no longer live — must NOT block.
      {
        task_id: 'vi-000000000030',
        tenant_id: 't-conv-claim-done',
        source: 'text',
        transcript: null,
        request_text: 'the unclaimed routed sibling (done conversation)',
        state: 'routed',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_ROUTED_STALE_MS + 5 * 60_000, now),
      },
      {
        task_id: 'vi-000000000031',
        tenant_id: 't-conv-claim-done',
        source: 'text',
        transcript: null,
        request_text: 'the claimed sibling, now done',
        state: 'done',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
      },
      // Conversation with a RUNNING sibling: still live — must block.
      {
        task_id: 'vi-000000000037',
        tenant_id: 't-conv-claim-running',
        source: 'text',
        transcript: null,
        request_text: 'the unclaimed routed sibling (running conversation)',
        state: 'routed',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_ROUTED_STALE_MS + 5 * 60_000, now),
      },
      {
        task_id: 'vi-000000000038',
        tenant_id: 't-conv-claim-running',
        source: 'text',
        transcript: null,
        request_text: 'the claimed sibling, still running',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
      },
    ]);
    // Join each sibling into its routed task's conversation, then claim it
    // exactly like a real worker's task_telemetry.py progress call would.
    setConversationId('vi-000000000031', 'vi-000000000030');
    claimTask('vi-000000000031', 'topic--1009999999999_555-th1');
    setConversationId('vi-000000000038', 'vi-000000000037');
    claimTask('vi-000000000038', 'topic--1009999999999_555-th2');

    const rows = selectStuckTasks(voiceInboxLedgerPath(), now, DEFAULT_TRANSCRIBING_STALE_MS, DEFAULT_ROUTED_STALE_MS, DEFAULT_RECEIVED_STALE_MS);
    assert.ok(
      rows.some((r) => r.task_id === 'vi-000000000030'),
      'a routed task whose only same-conversation sibling is DONE must still be selected for replay'
    );
    assert.equal(
      rows.filter((r) => r.task_id === 'vi-000000000037').length,
      0,
      'a routed task whose same-conversation sibling is RUNNING must not be selected for replay'
    );

    // fakes, not the throwing variant: a wrongly-blocked or wrongly-allowed
    // row would show up as a mismatched event/queue-line count below.
    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      { loadVoiceInboxModules: async () => fakeVoiceInboxModules() }
    );
    assert.equal(result.touched, 1);

    const doneCaseEvents = readEvents('vi-000000000030');
    assert.equal(doneCaseEvents.length, 1);
    assert.equal(doneCaseEvents[0].kind, 'task.rerouted');
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000030').length, 1);

    assert.deepEqual(readEvents('vi-000000000037'), []);
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000037').length, 0);
  });

  // Control twin: identical shape except the conversation sibling is NOT
  // claimed (and an unrelated claimed task sits in a DIFFERENT conversation)
  // — the task must still be selected and rerouted, proving the guard keys on
  // a same-conversation claim, not on the sibling's existence or on any claim
  // anywhere in the tenant.
  it('still selects and reroutes the same shaped task when no same-conversation sibling is claimed', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000032',
        tenant_id: 't-conv-unclaimed',
        source: 'text',
        transcript: null,
        request_text: 'the unclaimed routed sibling',
        state: 'routed',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_ROUTED_STALE_MS + 5 * 60_000, now),
      },
      {
        task_id: 'vi-000000000033',
        tenant_id: 't-conv-unclaimed',
        source: 'text',
        transcript: null,
        request_text: 'the sibling, done but never claimed',
        state: 'done',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
      },
      {
        task_id: 'vi-000000000034',
        tenant_id: 't-conv-unclaimed',
        source: 'text',
        transcript: null,
        request_text: 'claimed task of an unrelated conversation',
        state: 'done',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
      },
    ]);
    setConversationId('vi-000000000033', 'vi-000000000032');
    // vi-000000000034 keeps its self-rooted conversation; claim it there.
    claimTask('vi-000000000034', 'topic--1009999999999_555');

    const rows = selectStuckTasks(voiceInboxLedgerPath(), now, DEFAULT_TRANSCRIBING_STALE_MS, DEFAULT_ROUTED_STALE_MS, DEFAULT_RECEIVED_STALE_MS);
    assert.ok(
      rows.some((r) => r.task_id === 'vi-000000000032'),
      'a stale routed task with no same-conversation claim must still be selected'
    );

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      { loadVoiceInboxModules: async () => fakeVoiceInboxModules() }
    );
    assert.equal(result.touched, 1);
    const events = readEvents('vi-000000000032');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.rerouted');
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000032').length, 1);
  });

  // Scope pin: only the reroute is guarded. A stale `received` task recorded
  // into a live conversation (a steer note) must still be routed — placement
  // of a genuinely new note never waits on the conversation's worker.
  it('still places a stale received sibling in a claimed conversation (early-stage placement is unguarded)', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000035',
        tenant_id: 't-steer-guard',
        source: 'text',
        transcript: null,
        request_text: 'new steer note awaiting routing',
        state: 'received',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 20 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 20 * 60_000, now),
      },
      {
        task_id: 'vi-000000000036',
        tenant_id: 't-steer-guard',
        source: 'text',
        transcript: null,
        request_text: 'the claimed sibling, still running',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 25 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 25 * 60_000, now),
      },
    ]);
    setConversationId('vi-000000000035', 'vi-000000000036');
    claimTask('vi-000000000036', 'topic--1009999999999_555-th1');

    const result = await runVoiceInboxFallback({ now, everyMs: 300_000 });

    assert.equal(result.touched, 1);
    const row = readTaskRow('vi-000000000035');
    assert.equal(row.state, 'routed');
    assert.equal(row.routed_to, GENERAL_KNOWLEDGE_TOPIC);
  });
});

describe('voice-inbox-fallback — dead-dispatch running tasks (AI-221)', () => {
  function setDispatchId(taskId: string, dispatchId: string | null): void {
    const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
    try {
      db.prepare('UPDATE tasks SET worker_dispatch_id = ? WHERE task_id = ?').run(dispatchId, taskId);
    } finally {
      db.close();
    }
  }

  function fakePidEntry(dispatchId: string, overrides: Partial<{ pid: number; descendants: number[] }> = {}) {
    return {
      pid: 12345,
      spawnedBy: 1,
      worker: 'agy',
      skill: 'topic--1009999999999_555',
      dispatchId,
      startedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('replays exactly once a running task 21 minutes stale whose dispatch id is absent from listWorkerPidsFn', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000010',
        tenant_id: 't-dead-dispatch',
        source: 'text',
        transcript: null,
        request_text: 'finish setting up the printer',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      },
    ]);
    setDispatchId('vi-000000000010', 'dispatch-aaaaaaaaaaaa');

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [],
        ...cannedOsReads(),
        killProcessFn: () => {},
        removeWorkerPidFn: async () => {},
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn: async () => ({ sent: true, suppressed: false }),
      }
    );

    assert.equal(result.touched, 1);
    assert.equal((result.detail as { running: number }).running, 1);
    const row = readTaskRow('vi-000000000010');
    assert.equal(row.state, 'routed');
    assert.equal(row.routed_to, OTHER_TOPIC);
    const events = readEvents('vi-000000000010');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.rerouted');
    const queued = readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000010');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].chat_id, CHAT_ID);
    assert.equal(queued[0].thread_id, 555);
  });

  it('kills a registered, OS-alive but 20-min-silent dispatch through its registry pid, then replays (t-31 fixture, t-32 policy)', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000011',
        tenant_id: 't-live-dispatch',
        source: 'text',
        transcript: null,
        request_text: 'finish setting up the printer',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      },
    ]);
    setDispatchId('vi-000000000011', 'dispatch-bbbbbbbbbbbb');
    const alive = [12345];
    const kr = killRecorder(alive); // pass the SAME array cannedOsReads sees
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [fakePidEntry('dispatch-bbbbbbbbbbbb')],
        ...cannedOsReads(alive),
        ...kr,
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn,
      }
    );

    assert.equal(result.touched, 1);
    const row = readTaskRow('vi-000000000011');
    assert.equal(row.state, 'routed');
    const events = readEvents('vi-000000000011');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.rerouted');
    const queued = readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000011');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].chat_id, CHAT_ID);
    assert.equal(queued[0].thread_id, 555);
    assert.deepEqual(kr.killed, [12345]);
    assert.deepEqual(kr.removed, [12345]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].severity, 'warn');
    assert.equal(calls[0].dedupKey, 'voice-inbox-redispatch:vi-000000000011:dispatch-bbbbbbbbbbbb');
    assert.match(String(calls[0].body), /killed for not heartbeating/);
    assert.match(String(calls[0].body), /task_telemetry\.py/);
  });

  it('REPLAYS a registered dispatch whose pid is dead on the machine — the stale-registry lie must not keep a task unserved (t-31, the old bug)', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000015',
        tenant_id: 't-stale-registry',
        source: 'text',
        transcript: null,
        request_text: 'finish setting up the printer',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      },
    ]);
    // The registry STILL carries this dispatch (e.g. a bot restart left the
    // entry behind) but the OS says its pid is gone — the pre-t-31 code
    // trusted the registry here and skipped the replay forever.
    setDispatchId('vi-000000000015', 'dispatch-aaaaaaaaaaaa');

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [fakePidEntry('dispatch-aaaaaaaaaaaa')],
        ...cannedOsReads([], []), // pid 12345 NOT alive, no cmdline hits
        killProcessFn: () => {},
        removeWorkerPidFn: async () => {},
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn: async () => ({ sent: true, suppressed: false }),
      }
    );

    assert.equal(result.touched, 1);
    assert.equal((result.detail as { running: number }).running, 1);
    const row = readTaskRow('vi-000000000015');
    assert.equal(row.state, 'routed');
    assert.equal(readEvents('vi-000000000015').length, 1);
  });

  it('kills an unregistered-but-cmdline-alive dispatch through the scan-prong pids, then replays (t-31 prong 2 fixture, t-32 policy)', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000016',
        tenant_id: 't-unregistered-alive',
        source: 'text',
        transcript: null,
        request_text: 'finish setting up the printer',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      },
    ]);
    setDispatchId('vi-000000000016', 'dispatch-bbbbbbbbbbbb');
    const cmdline = [4242];
    const kr = killRecorder(cmdline);
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [],
        ...cannedOsReads([], cmdline),
        ...kr,
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn,
      }
    );

    assert.equal(result.touched, 1);
    assert.equal(readEvents('vi-000000000016').length, 1);
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000016').length, 1);
    assert.deepEqual(kr.killed, [4242]);
    assert.deepEqual(kr.removed, []); // no matching registry entries to remove
    assert.equal(calls.length, 1);
    assert.equal(calls[0].severity, 'warn');
  });

  it('kills a dispatch alive on a recorded DESCENDANT pid alone — dead wrapper pid is not killed (t-31 prong 1 fixture, t-32 policy)', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000017',
        tenant_id: 't-descendant-alive',
        source: 'text',
        transcript: null,
        request_text: 'finish setting up the printer',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      },
    ]);
    setDispatchId('vi-000000000017', 'dispatch-cccccccccccc');
    const alive = [6001]; // wrapper 5000 dead, descendant 6001 alive
    const kr = killRecorder(alive);
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [
          fakePidEntry('dispatch-cccccccccccc', { pid: 5000, descendants: [6001] }),
        ],
        ...cannedOsReads(alive),
        ...kr,
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn,
      }
    );

    assert.deepEqual(kr.killed, [6001]); // NOT 5000 — a dead pid is never a kill target
    assert.deepEqual(kr.removed, [5000]); // the matched entry's pid
    assert.equal(result.touched, 1);
    assert.equal(readEvents('vi-000000000017').length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].severity, 'warn');
  });

  it('leaves a running task with a NULL worker_dispatch_id untouched (the C4 control)', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        // worker_dispatch_id is left NULL by buildFixtureLedger's insert —
        // exactly like a standing auth-broker task created by `pa auth
        // request` without ever going through task_telemetry.py start (D3).
        // This is the assertion that fails if the selector is written as
        // BACKLOG.md:39 originally worded it (any `running` task, no
        // dispatch-id clause).
        task_id: 'vi-000000000012',
        tenant_id: 't-standing-auth',
        source: 'text',
        transcript: null,
        request_text: 'auth broker standing conversation',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      },
    ]);
    const before = readTaskRow('vi-000000000012');

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [],
        loadVoiceInboxModules: async () => {
          throw new Error('must not be called — no dispatch id means nothing to re-dispatch');
        },
      }
    );

    assert.equal(result.touched, 0);
    const after = readTaskRow('vi-000000000012');
    assert.deepEqual(after, before);
    assert.deepEqual(readEvents('vi-000000000012'), []);
  });

  it('leaves a running task 19 minutes stale untouched', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000013',
        tenant_id: 't-almost-stale',
        source: 'text',
        transcript: null,
        request_text: 'finish setting up the printer',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS - 60_000, now),
      },
    ]);
    setDispatchId('vi-000000000013', 'dispatch-cccccccccccc');
    const before = readTaskRow('vi-000000000013');

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [],
        loadVoiceInboxModules: async () => {
          throw new Error('must not be called — not stale enough yet');
        },
      }
    );

    assert.equal(result.touched, 0);
    const after = readTaskRow('vi-000000000013');
    assert.deepEqual(after, before);
    assert.deepEqual(readEvents('vi-000000000013'), []);
  });

  // E34 (AI-conversation-context WP-3 follow-up): RunningDispatchRow now
  // selects conversation_id, so a dead-dispatch replay's briefing computation
  // no longer throws-and-skips on every run. Proven red-then-green: with
  // voiceInboxRunningWithDispatch's SELECT/interface reverted to omit
  // conversation_id (the pre-fix shape), this test fails because the
  // briefing-skipped path fires and the queued text carries no briefing;
  // restored, it passes.
  it('threads the conversation briefing into a dead-dispatch replay (E34)', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000014',
        tenant_id: 't-dead-dispatch-briefing',
        source: 'text',
        transcript: null,
        request_text: 'reminder about renewing the passport',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      },
    ]);
    setDispatchId('vi-000000000014', 'dispatch-dddddddddddd');

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [],
        ...cannedOsReads(),
        killProcessFn: () => {},
        removeWorkerPidFn: async () => {},
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn: async () => ({ sent: true, suppressed: false }),
      }
    );

    assert.equal(result.touched, 1);
    const queued = readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000014');
    assert.equal(queued.length, 1);
    const text = queued[0].text as string;
    const marker = '] ';
    const idx = text.indexOf(marker);
    assert.ok(idx >= 0, 'expected the routing header close bracket in the injection text');
    const afterHeader = text.slice(idx + marker.length);
    assert.ok(
      afterHeader.startsWith('BRIEFING\n'),
      `expected the briefing immediately after "] ", got: ${afterHeader.slice(0, 40)}`
    );

    await flushLog();
    const appLog = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
    const lines = appLog
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const skipLines = lines.filter(
      (l) => l.module === 'voice-inbox-fallback' && l.action === 'briefing-skipped' && l.taskId === 'vi-000000000014'
    );
    assert.equal(skipLines.length, 0, 'the briefing must not be skipped now that conversation_id is selected');
  });
});

describe('voice-inbox-fallback — never-routed running tasks (2026-09-16, vi-d79c09c5eb37)', () => {
  function setDispatchId(taskId: string, dispatchId: string | null): void {
    const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
    try {
      db.prepare('UPDATE tasks SET worker_dispatch_id = ? WHERE task_id = ?').run(dispatchId, taskId);
    } finally {
      db.close();
    }
  }

  /** The live shape: an inbox routing run stamped its dispatch while moving the
   *  task to running, then settled without route_task.py (routed_to NULL). */
  function neverRoutedTask(taskId: string, requestText: string, now: number): FixtureTask {
    return {
      task_id: taskId,
      tenant_id: `t-never-routed-${taskId.slice(-2)}`,
      source: 'voice',
      transcript: requestText,
      request_text: requestText,
      state: 'running',
      routed_to: null,
      created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 25 * 60_000, now),
      updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
    };
  }

  function deadDispatchDeps(notifyFn: NonNullable<VoiceInboxFallbackDeps['notifyFn']>): VoiceInboxFallbackDeps {
    return {
      listWorkerPidsFn: async () => [],
      ...cannedOsReads(),
      killProcessFn: () => {},
      removeWorkerPidFn: async () => {},
      loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
      notifyFn,
    };
  }

  it('NR-1: places a never-routed running task with a dead dispatch in the default target once, as a first routing', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([neverRoutedTask('vi-0000000000e1', 'remind me to call the plumber on monday', now)]);
    setDispatchId('vi-0000000000e1', 'dispatch-e1e1e1e1e1e1');
    const notify = recordingNotifyFn();

    const result = await runVoiceInboxFallback({ now, everyMs: 300_000 }, deadDispatchDeps(notify.notifyFn));

    assert.equal(result.touched, 1);
    assert.equal((result.detail as { running: number }).running, 1);
    const row = readTaskRow('vi-0000000000e1');
    assert.equal(row.state, 'routed');
    assert.equal(row.routed_to, GENERAL_KNOWLEDGE_TOPIC);
    const events = readEvents('vi-0000000000e1');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.routed', 'a first routing, never a reroute');
    const payload = JSON.parse(events[0].payload_json);
    assert.equal(payload.routed_to, GENERAL_KNOWLEDGE_TOPIC);
    assert.ok(
      payload.reason.startsWith('Placed by the deterministic fallback: the inbox run stopped '),
      `reason was: ${payload.reason}`
    );
    const queued = readRouteQueueLines().filter((l) => l.task_id === 'vi-0000000000e1');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].chat_id, CHAT_ID);
    assert.equal(queued[0].thread_id, 0);
    assert.deepEqual(notify.calls, [], 'a first placement sends no re-dispatch line and no page');
  });

  it('NR-2: a keyword match places the never-routed task in that keyword topic', async () => {
    const now = Date.now();
    writeConfigYamlWithKeywords();
    writeTopicsJsonWithOther();
    await buildFixtureLedger([neverRoutedTask('vi-0000000000e2', 'pay the electricity invoice before friday', now)]);
    setDispatchId('vi-0000000000e2', 'dispatch-e2e2e2e2e2e2');
    const notify = recordingNotifyFn();

    const result = await runVoiceInboxFallback({ now, everyMs: 300_000 }, deadDispatchDeps(notify.notifyFn));

    assert.equal(result.touched, 1);
    const row = readTaskRow('vi-0000000000e2');
    assert.equal(row.state, 'routed');
    assert.equal(row.routed_to, OTHER_TOPIC);
    const queued = readRouteQueueLines().filter((l) => l.task_id === 'vi-0000000000e2');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].thread_id, 555);
  });

  it('NR-3: a second pass never places the same task again', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([neverRoutedTask('vi-0000000000e3', 'remind me to renew the car insurance', now)]);
    setDispatchId('vi-0000000000e3', 'dispatch-e3e3e3e3e3e3');
    const notify = recordingNotifyFn();

    await runVoiceInboxFallback({ now, everyMs: 300_000 }, deadDispatchDeps(notify.notifyFn));
    const second = await runVoiceInboxFallback({ now, everyMs: 300_000 }, deadDispatchDeps(notify.notifyFn));

    assert.equal(second.touched, 0);
    assert.equal(readEvents('vi-0000000000e3').length, 1);
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-0000000000e3').length, 1);
  });

  it('NR-4: with no deterministic target the never-routed task fails honestly with one page', async () => {
    const now = Date.now();
    writeFileSync(join(tempDir, 'config.yaml'), 'voice_inbox:\n  port: 8787\n', 'utf8');
    writeTopicsJson();
    await buildFixtureLedger([neverRoutedTask('vi-0000000000e4', 'remind me to water the plants', now)]);
    setDispatchId('vi-0000000000e4', 'dispatch-e4e4e4e4e4e4');
    const notify = recordingNotifyFn();
    const savedOverride = process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC;
    delete process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC;
    try {
      const result = await runVoiceInboxFallback({ now, everyMs: 300_000 }, deadDispatchDeps(notify.notifyFn));
      assert.equal(result.touched, 1);
    } finally {
      if (savedOverride === undefined) delete process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC;
      else process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC = savedOverride;
    }
    const row = readTaskRow('vi-0000000000e4');
    assert.equal(row.state, 'failed');
    const events = readEvents('vi-0000000000e4');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.failed');
    assert.equal(JSON.parse(events[0].payload_json).reason, NEVER_ROUTED_FAILED_REASON);
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-0000000000e4').length, 0);
    assert.equal(notify.calls.length, 1);
    assert.equal(notify.calls[0].dedupKey, 'voice-inbox-never-routed-failed:vi-0000000000e4');
    assert.equal(notify.calls[0].severity, 'warn');
  });

  it('NR-5: a never-routed task routed by someone else between the scan and the write is left alone', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([neverRoutedTask('vi-0000000000e5', 'remind me to book the dentist', now)]);
    setDispatchId('vi-0000000000e5', 'dispatch-e5e5e5e5e5e5');
    const notify = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        ...deadDispatchDeps(notify.notifyFn),
        // The scan->write race, materialized: the operator's reroute lands after
        // the scan selected the task but before this job's write.
        loadVoiceInboxModules: async () => {
          const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
          try {
            db.prepare('UPDATE tasks SET routed_to = ? WHERE task_id = ?').run(OTHER_TOPIC, 'vi-0000000000e5');
          } finally {
            db.close();
          }
          return fakeVoiceInboxModules();
        },
      }
    );

    assert.equal(result.touched, 0);
    const row = readTaskRow('vi-0000000000e5');
    assert.equal(row.state, 'running');
    assert.equal(row.routed_to, OTHER_TOPIC, 'the other writer routing stands');
    assert.equal(readEvents('vi-0000000000e5').length, 0);
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-0000000000e5').length, 0);
  });
});

describe('voice-inbox route retry (2026-09-16, vi-d79c09c5eb37)', () => {
  function setColumns(taskId: string, cols: Record<string, string | null>): void {
    const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
    try {
      for (const [col, value] of Object.entries(cols)) {
        db.prepare(`UPDATE tasks SET ${col} = ? WHERE task_id = ?`).run(value, taskId);
      }
    } finally {
      db.close();
    }
  }

  function fixtureTask(taskId: string, state: string, now: number, extra: Partial<FixtureTask> = {}): FixtureTask {
    return {
      task_id: taskId,
      tenant_id: `t-route-retry-${taskId.slice(-2)}`,
      source: 'voice',
      transcript: 'resend the breakdown email and the six invoices to the new address',
      request_text: 'resend the breakdown email and the six invoices to the new address',
      state,
      routed_to: null,
      created_at: iso(30 * 60_000, now),
      updated_at: iso(60_000, now),
      ...extra,
    };
  }

  function retryDeps() {
    return { repoRoot, loadVoiceInboxModules: async () => fakeVoiceInboxModules() };
  }

  function placementDeps(
    notifyFn: NonNullable<VoiceInboxFallbackDeps['notifyFn']>,
    loadVoiceInboxModules: NonNullable<VoiceInboxFallbackDeps['loadVoiceInboxModules']> = async () => fakeVoiceInboxModules()
  ): VoiceInboxFallbackDeps {
    return {
      listWorkerPidsFn: async () => [],
      ...cannedOsReads(),
      killProcessFn: () => {},
      removeWorkerPidFn: async () => {},
      loadVoiceInboxModules,
      notifyFn,
    };
  }

  it('RR-1: returns a never-routed running task to the settling topic once, as a legal routing (vi-d79c09c5eb37 shape)', async () => {
    const now = Date.now();
    await buildFixtureLedger([fixtureTask('vi-0000000000f1', 'running', now)]);
    setColumns('vi-0000000000f1', { worker_resource: 'topic--1009999999999_42-th347', worker_dispatch_id: '99bab794afa0' });

    const result = await returnVoiceTaskForRouting('vi-0000000000f1', INBOX_TOPIC, retryDeps());

    assert.equal(result.outcome, 'returned');
    const row = readTaskRow('vi-0000000000f1');
    assert.equal(row.state, 'routed');
    assert.equal(row.routed_to, INBOX_TOPIC);
    assert.equal(row.routing_reason, VOICE_ROUTE_RETRY_REASON);
    const events = readEvents('vi-0000000000f1');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.routed');
    assert.deepEqual(JSON.parse(events[0].payload_json), { routed_to: INBOX_TOPIC, reason: VOICE_ROUTE_RETRY_REASON });
    assert.equal(readRouteQueueLines().length, 0, 'no route-queue line: the retry rides the thread, not the queue');
    assert.ok(voiceInboxRouteRetryPendingIds(['vi-0000000000f1']).has('vi-0000000000f1'));
    assert.ok(result.outcome === 'returned');
    assert.ok(result.message.includes('vi-0000000000f1'));
    assert.ok(result.message.includes('route_task.py'));
    assert.ok(result.message.includes('Do not run task_telemetry.py'));
    assert.ok(result.message.includes('resend the breakdown email'));
    assert.ok(!/\[Voice(?: inbox)? task vi-/.test(result.message), 'never shaped like an injection header');
  });

  it('RR-2: a second call finds the task routed and changes nothing', async () => {
    const now = Date.now();
    await buildFixtureLedger([fixtureTask('vi-0000000000f2', 'running', now)]);
    await returnVoiceTaskForRouting('vi-0000000000f2', INBOX_TOPIC, retryDeps());

    const second = await returnVoiceTaskForRouting('vi-0000000000f2', INBOX_TOPIC, retryDeps());

    assert.deepEqual(second, { outcome: 'skipped', taskId: 'vi-0000000000f2', reason: 'already routed' });
    assert.equal(readEvents('vi-0000000000f2').length, 1);
  });

  it('RR-3: a never-routed received task is returned too', async () => {
    const now = Date.now();
    await buildFixtureLedger([fixtureTask('vi-0000000000f3', 'received', now)]);

    const result = await returnVoiceTaskForRouting('vi-0000000000f3', INBOX_TOPIC, retryDeps());

    assert.equal(result.outcome, 'returned');
    assert.equal(readTaskRow('vi-0000000000f3').state, 'routed');
    assert.equal(readTaskRow('vi-0000000000f3').routed_to, INBOX_TOPIC);
  });

  it('RR-4: transcribing, awaiting_input, terminal and routed-elsewhere tasks are never returned', async () => {
    const now = Date.now();
    const cases: Array<[string, string, string | null]> = [
      ['vi-0000000000f4', 'transcribing', null],
      ['vi-0000000000f5', 'awaiting_input', null],
      ['vi-0000000000f6', 'done', null],
      ['vi-0000000000f7', 'failed', null],
      ['vi-0000000000f8', 'running', OTHER_TOPIC],
    ];
    await buildFixtureLedger(cases.map(([id, state, routedTo]) => fixtureTask(id, state, now, { routed_to: routedTo })));
    for (const [id, state, routedTo] of cases) {
      const result = await returnVoiceTaskForRouting(id, INBOX_TOPIC, retryDeps());
      assert.equal(result.outcome, 'skipped', `${id} (${state})`);
      const row = readTaskRow(id);
      assert.equal(row.state, state);
      assert.equal(row.routed_to, routedTo);
      assert.equal(readEvents(id).length, 0);
    }
  });

  it('RR-5: a routing that lands between the pre-check and the write wins', async () => {
    const now = Date.now();
    await buildFixtureLedger([fixtureTask('vi-0000000000f9', 'running', now)]);

    const result = await returnVoiceTaskForRouting('vi-0000000000f9', INBOX_TOPIC, {
      repoRoot,
      // The race, materialized: a late route lands after the read-only
      // pre-check but before the write transaction.
      loadVoiceInboxModules: async () => {
        const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
        try {
          db.prepare('UPDATE tasks SET routed_to = ? WHERE task_id = ?').run(OTHER_TOPIC, 'vi-0000000000f9');
        } finally {
          db.close();
        }
        return fakeVoiceInboxModules();
      },
    });

    assert.deepEqual(result, { outcome: 'skipped', taskId: 'vi-0000000000f9', reason: 'already routed' });
    assert.equal(readTaskRow('vi-0000000000f9').routed_to, OTHER_TOPIC, 'the other routing stands');
    assert.equal(readEvents('vi-0000000000f9').length, 0);
  });

  it('RR-6: the retry message stays inside the 4000-char steer limit for any request length', () => {
    const message = buildVoiceRouteRetryMessage({
      taskId: 'vi-0000000000fa',
      topicKey: INBOX_TOPIC,
      requestText: 'x'.repeat(10_000),
      repoRoot,
      topicNamesPath: join(tempDir, 'telegram-topic-names.json'),
    });
    assert.ok(message.length <= 4000, `length ${message.length}`);
    assert.ok(message.includes(`${'x'.repeat(VOICE_ROUTE_RETRY_REQUEST_MAX_CHARS)}…`));
    assert.ok(!message.includes('x'.repeat(VOICE_ROUTE_RETRY_REQUEST_MAX_CHARS + 1)));
    assert.ok(message.includes(`default topic ${GENERAL_KNOWLEDGE_TOPIC}`), 'the default topic is thread 0 of the routing chat');
    assert.ok(message.includes('task_request.py clean'), 'the cleanup step is named so it is skipped, never a blocker');
  });

  it('RR-9: a task re-sent while still transcribing keeps its one retry, and gets it once transcribed', async () => {
    const now = Date.now();
    await buildFixtureLedger([fixtureTask('vi-0000000000ec', 'transcribing', now)]);

    const early = await returnVoiceTaskForRouting('vi-0000000000ec', INBOX_TOPIC, retryDeps());

    assert.deepEqual(early, { outcome: 'skipped', taskId: 'vi-0000000000ec', reason: 'state transcribing' });
    assert.equal(readTaskRow('vi-0000000000ec').routed_to, null, 'nothing spent: routed_to is still empty');
    assert.equal(readEvents('vi-0000000000ec').length, 0);
    assert.equal(voiceInboxRouteRetryPendingIds(['vi-0000000000ec']).size, 0);

    setColumns('vi-0000000000ec', { state: 'received' }); // the transcript landed

    const later = await returnVoiceTaskForRouting('vi-0000000000ec', INBOX_TOPIC, retryDeps());

    assert.equal(later.outcome, 'returned');
    assert.equal(readTaskRow('vi-0000000000ec').routing_reason, VOICE_ROUTE_RETRY_REASON);
    assert.equal(readEvents('vi-0000000000ec').length, 1);
  });

  it('RR-7: no ledger, a malformed task id or a malformed topic key is a silent skip', async () => {
    assert.equal((await returnVoiceTaskForRouting('vi-0000000000fb', INBOX_TOPIC, retryDeps())).outcome, 'skipped');
    assert.equal((await returnVoiceTaskForRouting('not-a-task', INBOX_TOPIC, retryDeps())).outcome, 'skipped');
    assert.equal((await returnVoiceTaskForRouting('vi-0000000000fb', 'inbox', retryDeps())).outcome, 'skipped');
  });

  it('RR-8: the retry-pending reader returns only non-terminal tasks carrying the retry reason', async () => {
    const now = Date.now();
    await buildFixtureLedger([
      fixtureTask('vi-0000000000fc', 'routed', now, { routed_to: INBOX_TOPIC }),
      fixtureTask('vi-0000000000fd', 'running', now, { routed_to: INBOX_TOPIC }),
      fixtureTask('vi-0000000000fe', 'done', now, { routed_to: INBOX_TOPIC }),
      fixtureTask('vi-0000000000ff', 'routed', now, { routed_to: INBOX_TOPIC }),
    ]);
    for (const id of ['vi-0000000000fc', 'vi-0000000000fd', 'vi-0000000000fe']) {
      setColumns(id, { routing_reason: VOICE_ROUTE_RETRY_REASON });
    }
    setColumns('vi-0000000000ff', { routing_reason: 'Accounting correspondence' });

    const pending = voiceInboxRouteRetryPendingIds([
      'vi-0000000000fc',
      'vi-0000000000fd',
      'vi-0000000000fe',
      'vi-0000000000ff',
      'vi-000000000100',
    ]);

    assert.deepEqual([...pending].sort(), ['vi-0000000000fc', 'vi-0000000000fd']);
  });

  it('RB-1: a returned task still routed to the inbox 20 minutes later is placed, never replayed into the inbox', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      fixtureTask('vi-0000000000e6', 'routed', now, {
        routed_to: INBOX_TOPIC,
        created_at: iso(DEFAULT_ROUTED_STALE_MS + 30 * 60_000, now),
        updated_at: iso(DEFAULT_ROUTED_STALE_MS + 60_000, now),
      }),
    ]);
    setColumns('vi-0000000000e6', { routing_reason: VOICE_ROUTE_RETRY_REASON });
    const notify = recordingNotifyFn();

    const result = await runVoiceInboxFallback({ now, everyMs: 300_000 }, placementDeps(notify.notifyFn));

    assert.equal(result.touched, 1);
    const row = readTaskRow('vi-0000000000e6');
    assert.equal(row.state, 'routed');
    assert.equal(row.routed_to, GENERAL_KNOWLEDGE_TOPIC);
    const events = readEvents('vi-0000000000e6');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.rerouted');
    const payload = JSON.parse(events[0].payload_json);
    assert.equal(payload.from, INBOX_TOPIC);
    assert.equal(payload.to, GENERAL_KNOWLEDGE_TOPIC);
    assert.ok(
      payload.reason.startsWith('Placed by the deterministic fallback: the inbox run stopped '),
      `reason was: ${payload.reason}`
    );
    const queued = readRouteQueueLines().filter((l) => l.task_id === 'vi-0000000000e6');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].thread_id, 0);
    assert.deepEqual(notify.calls, []);
    assert.equal(voiceInboxRouteRetryPendingIds(['vi-0000000000e6']).size, 0, 'the placement ends the retry shape');
  });

  it('RB-2: a returned task whose retry run died mid-run is placed from the dead-dispatch arm', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      fixtureTask('vi-0000000000e7', 'running', now, {
        routed_to: INBOX_TOPIC,
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      }),
    ]);
    setColumns('vi-0000000000e7', { routing_reason: VOICE_ROUTE_RETRY_REASON, worker_dispatch_id: 'dispatch-e7e7e7e7e7e7' });
    const notify = recordingNotifyFn();

    const result = await runVoiceInboxFallback({ now, everyMs: 300_000 }, placementDeps(notify.notifyFn));

    assert.equal(result.touched, 1);
    const row = readTaskRow('vi-0000000000e7');
    assert.equal(row.state, 'routed');
    assert.equal(row.routed_to, GENERAL_KNOWLEDGE_TOPIC);
    const events = readEvents('vi-0000000000e7');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.rerouted');
    assert.equal(JSON.parse(events[0].payload_json).from, INBOX_TOPIC);
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-0000000000e7').length, 1);
    assert.deepEqual(notify.calls, [], 'a placement sends no re-dispatch line');
  });

  it('RB-3: a stale routed task with an ordinary reason still replays to its own topic', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      fixtureTask('vi-0000000000e8', 'routed', now, {
        routed_to: INBOX_TOPIC,
        created_at: iso(DEFAULT_ROUTED_STALE_MS + 30 * 60_000, now),
        updated_at: iso(DEFAULT_ROUTED_STALE_MS + 60_000, now),
      }),
    ]);
    setColumns('vi-0000000000e8', { routing_reason: 'Accounting correspondence' });
    const notify = recordingNotifyFn();

    const result = await runVoiceInboxFallback({ now, everyMs: 300_000 }, placementDeps(notify.notifyFn));

    assert.equal(result.touched, 1);
    assert.equal(readTaskRow('vi-0000000000e8').routed_to, INBOX_TOPIC);
    const events = readEvents('vi-0000000000e8');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.rerouted');
    assert.deepEqual(
      [JSON.parse(events[0].payload_json).from, JSON.parse(events[0].payload_json).to],
      [INBOX_TOPIC, INBOX_TOPIC]
    );
    const queued = readRouteQueueLines().filter((l) => l.task_id === 'vi-0000000000e8');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].thread_id, 42);
  });

  it('RB-4: a returned task with no deterministic target fails honestly with one page', async () => {
    const now = Date.now();
    writeFileSync(join(tempDir, 'config.yaml'), 'voice_inbox:\n  port: 8787\n', 'utf8');
    writeTopicsJson();
    await buildFixtureLedger([
      fixtureTask('vi-0000000000e9', 'running', now, {
        routed_to: INBOX_TOPIC,
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      }),
    ]);
    setColumns('vi-0000000000e9', { routing_reason: VOICE_ROUTE_RETRY_REASON, worker_dispatch_id: 'dispatch-e9e9e9e9e9e9' });
    const notify = recordingNotifyFn();
    const savedOverride = process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC;
    delete process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC;
    try {
      const result = await runVoiceInboxFallback({ now, everyMs: 300_000 }, placementDeps(notify.notifyFn));
      assert.equal(result.touched, 1);
    } finally {
      if (savedOverride === undefined) delete process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC;
      else process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC = savedOverride;
    }

    assert.equal(readTaskRow('vi-0000000000e9').state, 'failed');
    const events = readEvents('vi-0000000000e9');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.failed');
    assert.equal(JSON.parse(events[0].payload_json).reason, NEVER_ROUTED_FAILED_REASON);
    assert.equal(notify.calls.length, 1);
    assert.equal(notify.calls[0].dedupKey, 'voice-inbox-never-routed-failed:vi-0000000000e9');
  });

  it('RB-5: a returned task a worker picked up since the scan is left alone', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      fixtureTask('vi-0000000000ea', 'routed', now, {
        routed_to: INBOX_TOPIC,
        created_at: iso(DEFAULT_ROUTED_STALE_MS + 30 * 60_000, now),
        updated_at: iso(DEFAULT_ROUTED_STALE_MS + 60_000, now),
      }),
    ]);
    setColumns('vi-0000000000ea', { routing_reason: VOICE_ROUTE_RETRY_REASON });
    const notify = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      placementDeps(notify.notifyFn, async () => {
        const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
        try {
          db.prepare("UPDATE tasks SET state = 'running' WHERE task_id = ?").run('vi-0000000000ea');
        } finally {
          db.close();
        }
        return fakeVoiceInboxModules();
      })
    );

    assert.equal(result.touched, 0);
    const row = readTaskRow('vi-0000000000ea');
    assert.equal(row.state, 'running');
    assert.equal(row.routed_to, INBOX_TOPIC);
    assert.equal(readEvents('vi-0000000000ea').length, 0);
  });

  it('RB-6: a returned task whose routing reason changed since the scan is left alone', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      fixtureTask('vi-0000000000eb', 'running', now, {
        routed_to: INBOX_TOPIC,
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      }),
    ]);
    setColumns('vi-0000000000eb', { routing_reason: VOICE_ROUTE_RETRY_REASON, worker_dispatch_id: 'dispatch-ebebebebebeb' });
    const notify = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      placementDeps(notify.notifyFn, async () => {
        const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
        try {
          db.prepare('UPDATE tasks SET routing_reason = ? WHERE task_id = ?').run('Accounting correspondence', 'vi-0000000000eb');
        } finally {
          db.close();
        }
        return fakeVoiceInboxModules();
      })
    );

    assert.equal(result.touched, 0);
    assert.equal(readTaskRow('vi-0000000000eb').routed_to, INBOX_TOPIC);
    assert.equal(readEvents('vi-0000000000eb').length, 0);
  });
});

describe('voice-inbox-fallback — kill-before-replay, dedupe, thread-notify (t-32)', () => {
  function setDispatchId(taskId: string, dispatchId: string | null): void {
    const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
    try {
      db.prepare('UPDATE tasks SET worker_dispatch_id = ? WHERE task_id = ?').run(dispatchId, taskId);
    } finally {
      db.close();
    }
  }

  function fakePidEntry(dispatchId: string, overrides: Partial<{ pid: number; descendants: number[] }> = {}) {
    return {
      pid: 12345,
      spawnedBy: 1,
      worker: 'agy',
      skill: 'topic--1009999999999_555',
      dispatchId,
      startedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('never redoes a task that reached a terminal state between the scan and the write (running-skip-terminal)', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000050',
        tenant_id: 't-dedupe-terminal',
        source: 'text',
        transcript: null,
        request_text: 'finish setting up the printer',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      },
    ]);
    setDispatchId('vi-000000000050', 'dispatch-ffffffffffff');
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [],
        ...cannedOsReads(),
        killProcessFn: () => {},
        removeWorkerPidFn: async () => {},
        loadVoiceInboxModules: async () => {
          // The scan→write race, materialized: by the time handleDeadDispatch
          // opens its write handle, the task has already finished through its
          // own worker's late telemetry.
          const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
          try {
            db.prepare("UPDATE tasks SET state = 'done' WHERE task_id = 'vi-000000000050'").run();
          } finally {
            db.close();
          }
          return fakeVoiceInboxModules();
        },
        notifyFn,
      }
    );

    assert.equal(result.touched, 0);
    assert.deepEqual(readEvents('vi-000000000050'), []);
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000050').length, 0);
    assert.equal(calls.length, 0, 'a terminal skip sends NO thread line (D7)');

    await flushLog();
    const appLog = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
    const lines = appLog
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const skipLines = lines.filter(
      (l) => l.module === 'voice-inbox-fallback' && l.action === 'running-skip-terminal' && l.taskId === 'vi-000000000050'
    );
    assert.equal(skipLines.length, 1);
    assert.equal(skipLines[0].state, 'done');
  });

  it('aborts the pass when a kill target survives — no replay, registry evidence kept for the next pass (kill-incomplete)', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000011',
        tenant_id: 't-kill-incomplete',
        source: 'text',
        transcript: null,
        request_text: 'finish setting up the printer',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      },
    ]);
    setDispatchId('vi-000000000011', 'dispatch-bbbbbbbbbbbb');
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [fakePidEntry('dispatch-bbbbbbbbbbbb')],
        ...cannedOsReads([12345]),
        killProcessFn: () => {}, // a no-op kill — the pid stays in the alive set
        removeWorkerPidFn: async () => {
          throw new Error('must not be called on an incomplete kill');
        },
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn,
      }
    );

    assert.equal(result.touched, 0);
    assert.deepEqual(readEvents('vi-000000000011'), []);
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000011').length, 0);
    assert.equal(calls.length, 0, 'no thread line when the pass aborts');

    await flushLog();
    const appLog = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
    const lines = appLog
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const killStart = lines.filter(
      (l) => l.module === 'voice-inbox-fallback' && l.action === 'kill-before-replay' && l.taskId === 'vi-000000000011'
    );
    assert.equal(killStart.length, 1);
    assert.equal(typeof killStart[0].heartbeatAgeMinutes, 'number');
    assert.ok(killStart[0].heartbeatAgeMinutes >= 21);
    assert.deepEqual(killStart[0].killTargets, [12345]);
    const incomplete = lines.filter(
      (l) => l.module === 'voice-inbox-fallback' && l.action === 'kill-incomplete' && l.taskId === 'vi-000000000011'
    );
    assert.equal(incomplete.length, 1);
    assert.deepEqual(incomplete[0].survivors, [12345]);
  });

  it("a dead-dispatch replay sends one info system line to the target thread (never a route-queue entry)", async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000051',
        tenant_id: 't-thread-notify-dead',
        source: 'text',
        transcript: null,
        request_text: 'finish setting up the printer',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      },
    ]);
    setDispatchId('vi-000000000051', 'dispatch-aaaaaaaaaaaa');
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [],
        ...cannedOsReads(),
        killProcessFn: () => {},
        removeWorkerPidFn: async () => {},
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn,
      }
    );

    assert.equal(result.touched, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].severity, 'info');
    assert.equal(calls[0].subject, 'Worker missing, re-dispatching task: vi-000000000051');
    assert.match(String(calls[0].body), /No live worker process was found for this task's dispatch for \d+ minutes/);
    assert.match(String(calls[0].body), /task_telemetry\.py/);
    assert.equal(calls[0].dedupKey, 'voice-inbox-redispatch:vi-000000000051:dispatch-aaaaaaaaaaaa');
    // Exactly ONE route-queue line: the replay injection. The notify is NOT a
    // queue entry (that would spawn a worker).
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000051').length, 1);
  });

  it("one candidate's kill failure never stops the batch", async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000052',
        tenant_id: 't-batch-kill-a',
        source: 'text',
        transcript: null,
        request_text: 'finish setting up the printer',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      },
      {
        task_id: 'vi-000000000053',
        tenant_id: 't-batch-kill-b',
        source: 'text',
        transcript: null,
        request_text: 'finish setting up the printer',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      },
    ]);
    setDispatchId('vi-000000000052', 'dispatch-aaaaaaaaaaaa'); // A: entry pid 9001 alive
    setDispatchId('vi-000000000053', 'dispatch-bbbbbbbbbbbb'); // B: no entries
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [fakePidEntry('dispatch-aaaaaaaaaaaa', { pid: 9001 })],
        ...cannedOsReads([9001]),
        killProcessFn: (pid: number) => {
          if (pid === 9001) throw new Error('taskkill refused');
        },
        removeWorkerPidFn: async () => {},
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn,
      }
    );

    assert.equal(result.touched, 1, 'B replays; A aborts its own pass only');
    // A: kill failed → survivor → kill-incomplete, no replay.
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000052').length, 0);
    await flushLog();
    const appLog = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
    const lines = appLog
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const incomplete = lines.filter(
      (l) => l.module === 'voice-inbox-fallback' && l.action === 'kill-incomplete' && l.taskId === 'vi-000000000052'
    );
    assert.equal(incomplete.length, 1);
    assert.deepEqual(incomplete[0].survivors, [9001]);
    // B: dead path → full replay + info notify.
    assert.equal(readEvents('vi-000000000053').length, 1);
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000053').length, 1);
    const bNotifies = calls.filter((c) => c.dedupKey === 'voice-inbox-redispatch:vi-000000000053:dispatch-bbbbbbbbbbbb');
    assert.equal(bNotifies.length, 1);
    assert.equal(bNotifies[0].severity, 'info');
  });

  it('a stranger dispatch sharing only the topic resource string is never killed (dispatch-id equality, D12 mirror)', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000054',
        tenant_id: 't-stranger-dispatch',
        source: 'text',
        transcript: null,
        request_text: 'finish setting up the printer',
        state: 'running',
        routed_to: OTHER_TOPIC, // same resource string as the stranger's skill
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      },
    ]);
    setDispatchId('vi-000000000054', 'dispatch-aaaaaaaaaaaa');
    // The registry holds ONLY a stranger dispatch whose default skill IS
    // OTHER_TOPIC's resource string — a resource match must never kill it.
    const alive = [7777];
    const kr = killRecorder(alive);
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [fakePidEntry('dispatch-zzzzzzzzzzzz', { pid: 7777 })],
        ...cannedOsReads(alive),
        ...kr,
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn,
      }
    );

    assert.deepEqual(kr.killed, []);
    assert.deepEqual(kr.removed, []);
    assert.equal(result.touched, 1, "the task's own dispatch has no live evidence → dead path replays");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].severity, 'info');
  });

  it('a throwing notifyFn never blocks the kill+replay path', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000011',
        tenant_id: 't-notify-throw-kill',
        source: 'text',
        transcript: null,
        request_text: 'finish setting up the printer',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      },
    ]);
    setDispatchId('vi-000000000011', 'dispatch-bbbbbbbbbbbb');
    const alive = [12345];
    const kr = killRecorder(alive);

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [fakePidEntry('dispatch-bbbbbbbbbbbb')],
        ...cannedOsReads(alive),
        ...kr,
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn: async () => {
          throw new Error('synthetic notify failure');
        },
      }
    );

    assert.equal(result.touched, 1, 'a notify failure must never block the kill+replay');
    assert.equal(readEvents('vi-000000000011').length, 1);
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000011').length, 1);

    await flushLog();
    const appLog = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
    const lines = appLog
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const failed = lines.filter(
      (l) =>
        l.level === 'warn' &&
        l.module === 'voice-inbox-fallback' &&
        l.action === 'redispatch-notify-failed' &&
        l.taskId === 'vi-000000000011'
    );
    assert.equal(failed.length, 1, 'expected exactly one redispatch-notify-failed warn line');
    assert.match(String(failed[0].error ?? ''), /synthetic notify failure/);
  });
});

// AI-221 (2026-09-14, task vi-7790f35108f8): a live dispatch whose executor
// heartbeat (the worker-pids entry file's mtime) is FRESH is supervised — the
// executor's own idle/no-progress/evaluator/absolute-timeout ladder owns hang
// recovery, so the fallback must neither kill nor replay it. A missing or
// stale heartbeat falls back to the pre-change kill/replay behavior, which is
// exactly why every pre-existing test above (entries without heartbeatAt)
// stays green unchanged.
describe('voice-inbox-fallback — supervised-dispatch skip (AI-221 heartbeat)', () => {
  const MINUTE = 60_000;

  function setDispatchId(taskId: string, dispatchId: string | null): void {
    const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
    try {
      db.prepare('UPDATE tasks SET worker_dispatch_id = ? WHERE task_id = ?').run(dispatchId, taskId);
    } finally {
      db.close();
    }
  }

  function fakePidEntry(
    dispatchId: string,
    overrides: Partial<{ pid: number; descendants: number[]; heartbeatAt: number }> = {}
  ) {
    return {
      pid: 12345,
      spawnedBy: 1,
      worker: 'agy',
      skill: 'topic--1009999999999_555',
      dispatchId,
      startedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  // Same 21-min-stale running fixture the dead-dispatch describes use —
  // stale enough that the pre-change job always killed/replayed it.
  async function buildStaleRunningTask(taskId: string, tenantId: string, dispatchId: string, now: number): Promise<void> {
    await buildFixtureLedger([
      {
        task_id: taskId,
        tenant_id: tenantId,
        source: 'text',
        transcript: null,
        request_text: 'finish setting up the printer',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      },
    ]);
    setDispatchId(taskId, dispatchId);
  }

  it('skips kill+replay for a live dispatch with a fresh executor heartbeat (incident shape: 21-min ledger staleness, 30-s heartbeat)', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildStaleRunningTask('vi-000000000060', 't-supervised-skip', 'dispatch-bbbbbbbbbbbb', now);
    const alive = [12345];
    const kr = killRecorder(alive);
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [fakePidEntry('dispatch-bbbbbbbbbbbb', { heartbeatAt: now - 30_000 })],
        ...cannedOsReads(alive),
        ...kr,
        loadVoiceInboxModules: async () => {
          throw new Error('must not be called — a supervised dispatch is never replayed');
        },
        notifyFn,
      }
    );

    assert.equal(result.touched, 0);
    assert.equal((result.detail as { running: number }).running, 0);
    assert.deepEqual(kr.killed, []);
    assert.deepEqual(kr.removed, []);
    assert.equal(calls.length, 0, 'a supervised skip sends no operator or thread notify');
    assert.deepEqual(readEvents('vi-000000000060'), []);
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000060').length, 0);
    assert.equal(readTaskRow('vi-000000000060').state, 'running', 'the supervised run keeps working');

    await flushLog();
    const appLog = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
    const lines = appLog
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const skips = lines.filter(
      (l) => l.module === 'voice-inbox-fallback' && l.action === 'running-skipped-supervised' && l.taskId === 'vi-000000000060'
    );
    assert.equal(skips.length, 1);
    assert.equal(skips[0].dispatchId, 'dispatch-bbbbbbbbbbbb');
    assert.equal(skips[0].heartbeatAgeSeconds, 30);
    assert.equal(skips[0].livePids, 1);
  });

  it('known-bad: a stale heartbeat (20 min) does NOT block kill-before-replay — the guard can fail', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildStaleRunningTask('vi-000000000061', 't-supervised-stale', 'dispatch-bbbbbbbbbbbb', now);
    const alive = [12345];
    const kr = killRecorder(alive);
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [fakePidEntry('dispatch-bbbbbbbbbbbb', { heartbeatAt: now - 20 * MINUTE })],
        ...cannedOsReads(alive),
        ...kr,
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn,
      }
    );

    // Kill-before-replay + running-reroute fire exactly as before the change.
    assert.equal(result.touched, 1);
    assert.equal((result.detail as { running: number }).running, 1);
    assert.deepEqual(kr.killed, [12345], 'every alive target is killed');
    assert.deepEqual(kr.removed, [12345], 'the registry entry is removed after the clean kill');
    assert.equal(readEvents('vi-000000000061').length, 1);
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000061').length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].severity, 'warn');
  });

  it('a pre-change registry entry with no heartbeatAt is treated stale — kill+replay unchanged (conservative default)', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildStaleRunningTask('vi-000000000062', 't-supervised-no-field', 'dispatch-bbbbbbbbbbbb', now);
    const alive = [12345];
    const kr = killRecorder(alive);

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        // fakePidEntry with no heartbeatAt override = a pre-change entry file.
        listWorkerPidsFn: async () => [fakePidEntry('dispatch-bbbbbbbbbbbb')],
        ...cannedOsReads(alive),
        ...kr,
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn: async () => ({ sent: true, suppressed: false }),
      }
    );

    assert.equal(result.touched, 1);
    assert.deepEqual(kr.killed, [12345]);
    assert.deepEqual(kr.removed, [12345]);
    assert.equal(readEvents('vi-000000000062').length, 1);
  });

  it('dead dispatch (no registry entry, nothing alive) still replays and the reroute reason says "no live worker process"', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildStaleRunningTask('vi-000000000063', 't-supervised-dead', 'dispatch-aaaaaaaaaaaa', now);

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [],
        ...cannedOsReads(),
        killProcessFn: () => {},
        removeWorkerPidFn: async () => {},
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn: async () => ({ sent: true, suppressed: false }),
      }
    );

    assert.equal(result.touched, 1);
    assert.equal((result.detail as { running: number }).running, 1);
    const events = readEvents('vi-000000000063');
    assert.equal(events.length, 1);
    const payload = JSON.parse(events[0].payload_json);
    assert.match(String(payload.reason), /no live worker process/);
  });

  it('reason strings split on the kill path: killed replays say "killed", dead replays say "no live worker process"', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildStaleRunningTask('vi-000000000064', 't-reason-killed', 'dispatch-bbbbbbbbbbbb', now);
    await buildStaleRunningTask('vi-000000000065', 't-reason-dead', 'dispatch-aaaaaaaaaaaa', now);
    const alive = [12345];
    const kr = killRecorder(alive);

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [fakePidEntry('dispatch-bbbbbbbbbbbb', { heartbeatAt: now - 20 * MINUTE })],
        ...cannedOsReads(alive),
        ...kr,
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn: async () => ({ sent: true, suppressed: false }),
      }
    );

    assert.equal(result.touched, 2, 'both tasks replay');
    const killedPayload = JSON.parse(readEvents('vi-000000000064')[0].payload_json);
    assert.match(String(killedPayload.reason), /worker processes were killed/);
    assert.match(String(killedPayload.reason), /no live supervising executor/);
    // The trailing guidance is byte-identical on both branches.
    assert.match(String(killedPayload.reason), /never gate the decision in chat$/);
    const deadPayload = JSON.parse(readEvents('vi-000000000065')[0].payload_json);
    assert.match(String(deadPayload.reason), /no live worker process/);
    assert.match(String(deadPayload.reason), /never gate the decision in chat$/);
  });

  it('freshestSupervisionAgeMs: freshest entry wins, other dispatch ids ignored, nothing eligible → undefined', () => {
    const now = 1_000_000_000;
    const entries = [
      fakePidEntry('dispatch-bbbbbbbbbbbb', { pid: 1, heartbeatAt: now - 10 * MINUTE }), // stale
      fakePidEntry('dispatch-bbbbbbbbbbbb', { pid: 2, heartbeatAt: now - 30_000 }), // fresh — wins
      fakePidEntry('dispatch-zzzzzzzzzzzz', { pid: 3, heartbeatAt: now - 1 }), // other dispatch — ignored
      fakePidEntry('dispatch-bbbbbbbbbbbb', { pid: 4 }), // no heartbeatAt — contributes nothing
    ];
    assert.equal(freshestSupervisionAgeMs('dispatch-bbbbbbbbbbbb', entries, now), 30_000);
    assert.equal(freshestSupervisionAgeMs('dispatch-oooooooooooo', entries, now), undefined);
    assert.equal(freshestSupervisionAgeMs('dispatch-bbbbbbbbbbbb', [], now), undefined);
  });
});

describe('voice-inbox fallback — conversation briefing reaches the replayed entry', () => {
  it('threads the conversation briefing between the routing header and the request text', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000020',
        tenant_id: 't-briefing-stale',
        source: 'text',
        transcript: null,
        request_text: 'reminder about renewing the passport',
        state: 'routed',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_ROUTED_STALE_MS + 5 * 60_000, now),
      },
    ]);

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      { loadVoiceInboxModules: async () => fakeVoiceInboxModules() }
    );

    assert.equal(result.touched, 1);
    const queued = readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000020');
    assert.equal(queued.length, 1);
    const text = queued[0].text as string;
    const marker = '] ';
    const idx = text.indexOf(marker);
    assert.ok(idx >= 0, 'expected the routing header close bracket in the injection text');
    const afterHeader = text.slice(idx + marker.length);
    assert.ok(
      afterHeader.startsWith('BRIEFING\n'),
      `expected the briefing immediately after "] ", got: ${afterHeader.slice(0, 40)}`
    );
    assert.ok(
      afterHeader.slice('BRIEFING\n'.length).startsWith('reminder about renewing the passport'),
      'expected the request text immediately after the briefing'
    );
  });

  it('logs briefing-skipped and still appends the replay when buildConversationBriefing throws', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000021',
        tenant_id: 't-briefing-throws',
        source: 'text',
        transcript: null,
        request_text: 'reminder about the annual checkup',
        state: 'routed',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_ROUTED_STALE_MS + 5 * 60_000, now),
      },
    ]);

    const throwingModules: VoiceInboxModules = {
      ...fakeVoiceInboxModules(),
      briefing: {
        CONVERSATION_BRIEFING_MIN: 200,
        buildConversationBriefing() {
          throw new Error('synthetic briefing failure');
        },
        briefingBudget() {
          return 1200;
        },
        ledgerPathOf() {
          return 'L';
        },
      },
    };

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      { loadVoiceInboxModules: async () => throwingModules }
    );

    assert.equal(result.touched, 1);
    const row = readTaskRow('vi-000000000021');
    assert.equal(row.state, 'routed');
    const queued = readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000021');
    assert.equal(queued.length, 1);
    assert.doesNotMatch(queued[0].text as string, /BRIEFING/);

    await flushLog();
    const appLog = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
    const lines = appLog
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const skipLines = lines.filter(
      (l) => l.module === 'voice-inbox-fallback' && l.action === 'briefing-skipped' && l.taskId === 'vi-000000000021'
    );
    assert.equal(skipLines.length, 1, 'expected exactly one briefing-skipped log line');
    assert.match(String(skipLines[0].error ?? ''), /synthetic briefing failure/);
  });
});

describe('voice-inbox-fallback — stuck-placement alert (bounded-noise reroute threshold)', () => {
  async function buildStaleRoutedTask(taskId: string, tenantId: string, now: number): Promise<void> {
    await buildFixtureLedger([
      {
        task_id: taskId,
        tenant_id: tenantId,
        source: 'text',
        transcript: null,
        request_text: 'reminder about renewing the passport',
        state: 'routed',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_ROUTED_STALE_MS + 5 * 60_000, now),
      },
    ]);
  }

  it('below the reroute-alert threshold no notification fires and the replay still proceeds', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildStaleRoutedTask('vi-000000000040', 't-stuck-below', now);
    seedRerouteEvents('vi-000000000040', 't-stuck-below', 2); // one under the default of 3
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      { loadVoiceInboxModules: async () => fakeVoiceInboxModules(), notifyFn }
    );

    assert.equal(result.touched, 1);
    assert.equal(calls.length, 0, '2 prior re-routes are under the default threshold of 3');
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000040').length, 1);
    assert.equal(readEvents('vi-000000000040').length, 3); // 2 seeded + 1 new
  });

  it('at the reroute-alert threshold the operator is notified once and the replay still proceeds', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildStaleRoutedTask('vi-000000000041', 't-stuck-at', now);
    seedRerouteEvents('vi-000000000041', 't-stuck-at', 3);
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      { loadVoiceInboxModules: async () => fakeVoiceInboxModules(), notifyFn }
    );

    assert.equal(result.touched, 1, 'the alert must never gate the replay');
    assert.equal(calls.length, 1);
    assert.equal(String(calls[0].subject), 'Voice-inbox task stuck: vi-000000000041');
    assert.equal(calls[0].dedupKey, 'voice-inbox-stuck:vi-000000000041');
    assert.equal(calls[0].severity, 'warn');
    const body = String(calls[0].body);
    assert.match(body, /Re-routed 3 times by the deterministic fallback/);
    assert.match(body, /age 80 min\)\./); // created_at is DEFAULT_ROUTED_STALE_MS + 60 min ago
    assert.match(body, new RegExp(`Target topic: ${OTHER_TOPIC}`));
    assert.match(body, /Request: reminder about renewing the passport/);
    assert.match(body, /Re-injecting now; if this keeps repeating, check worker fleet health\./);
    assert.equal(readTaskRow('vi-000000000041').state, 'routed');
    assert.equal(readEvents('vi-000000000041').length, 4); // 3 seeded + 1 new
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000041').length, 1);
  });

  it('a throwing notifyFn never blocks the replay', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildStaleRoutedTask('vi-000000000042', 't-stuck-throw', now);
    seedRerouteEvents('vi-000000000042', 't-stuck-throw', 3);

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn: async () => {
          throw new Error('synthetic notify failure');
        },
      }
    );

    assert.equal(result.touched, 1, 'an alert failure must not stop the placement replay');
    assert.equal(readEvents('vi-000000000042').length, 4);
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000042').length, 1);

    await flushLog();
    const appLog = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
    const lines = appLog
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const warnLines = lines.filter(
      (l) => l.level === 'warn' && l.module === 'voice-inbox-fallback' && l.taskId === 'vi-000000000042'
    );
    assert.equal(warnLines.length, 1, 'expected exactly one stuck-alert-failed warn line');
    assert.equal(warnLines[0].action, 'stuck-alert-failed');
    assert.match(String(warnLines[0].error ?? ''), /synthetic notify failure/);
  });

  it('PA_VOICE_INBOX_FALLBACK_REROUTE_ALERT_AFTER=0 disables the alert entirely', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildStaleRoutedTask('vi-000000000043', 't-stuck-disabled', now);
    seedRerouteEvents('vi-000000000043', 't-stuck-disabled', 5);
    const { notifyFn, calls } = recordingNotifyFn();
    const prev = process.env.PA_VOICE_INBOX_FALLBACK_REROUTE_ALERT_AFTER;
    process.env.PA_VOICE_INBOX_FALLBACK_REROUTE_ALERT_AFTER = '0';
    try {
      const result = await runVoiceInboxFallback(
        { now, everyMs: 300_000 },
        { loadVoiceInboxModules: async () => fakeVoiceInboxModules(), notifyFn }
      );
      assert.equal(result.touched, 1, 'the replay continues with the alert disabled');
      assert.equal(calls.length, 0);
    } finally {
      if (prev === undefined) delete process.env.PA_VOICE_INBOX_FALLBACK_REROUTE_ALERT_AFTER;
      else process.env.PA_VOICE_INBOX_FALLBACK_REROUTE_ALERT_AFTER = prev;
    }
  });

  it('the dead-dispatch replay alerts at the threshold too', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000044',
        tenant_id: 't-stuck-dead-dispatch',
        source: 'text',
        transcript: null,
        request_text: 'finish setting up the printer',
        state: 'running',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60_000, now),
      },
    ]);
    const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
    try {
      db.prepare('UPDATE tasks SET worker_dispatch_id = ? WHERE task_id = ?').run('dispatch-eeeeeeeeeeee', 'vi-000000000044');
    } finally {
      db.close();
    }
    seedRerouteEvents('vi-000000000044', 't-stuck-dead-dispatch', 3);
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      {
        listWorkerPidsFn: async () => [],
        ...cannedOsReads(),
        loadVoiceInboxModules: async () => fakeVoiceInboxModules(),
        notifyFn,
      }
    );

    assert.equal((result.detail as { running: number }).running, 1);
    // t-32 fix 3: the replay now ALSO sends the thread line. Order is pinned:
    // stuck alert first (E6c placement), thread line second.
    assert.equal(calls.length, 2);
    assert.equal(calls[0].dedupKey, 'voice-inbox-stuck:vi-000000000044');
    assert.equal(calls[0].severity, 'warn');
    assert.match(String(calls[0].body), /Re-routed 3 times by the deterministic fallback/);
    assert.match(String(calls[0].body), /age \d+ min\)\./);
    assert.equal(calls[1].severity, 'info');
    assert.equal(calls[1].dedupKey, 'voice-inbox-redispatch:vi-000000000044:dispatch-eeeeeeeeeeee');
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000044').length, 1);
  });

  it('the reroute count is per task, not global', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildStaleRoutedTask('vi-000000000045', 't-stuck-pair', now);
    seedRerouteEvents('vi-000000000045', 't-stuck-pair', 3);
    await buildStaleRoutedTask('vi-000000000046', 't-stuck-pair', now); // same tenant, 0 events
    seedRerouteEvents('vi-000000000046', 't-stuck-pair', 0);
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      { loadVoiceInboxModules: async () => fakeVoiceInboxModules(), notifyFn }
    );

    assert.equal(result.touched, 2, 'both tasks replay');
    assert.equal(calls.length, 1, 'only the task past its own threshold alerts');
    assert.equal(calls[0].dedupKey, 'voice-inbox-stuck:vi-000000000045');
  });

  it('a legacy routed row still carrying a dead worker identity is replayed (pre-fix orphan heal)', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-000000000047',
        tenant_id: 't-stuck-legacy',
        source: 'text',
        transcript: null,
        request_text: 'legacy orphan shape with stale worker identity',
        state: 'routed',
        routed_to: OTHER_TOPIC,
        created_at: iso(DEFAULT_ROUTED_STALE_MS + 60 * 60_000, now),
        updated_at: iso(DEFAULT_ROUTED_STALE_MS + 5 * 60_000, now),
      },
    ]);
    const db = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
    try {
      db.prepare('UPDATE tasks SET worker_resource = ?, worker_dispatch_id = ? WHERE task_id = ?')
        .run('topic--1_1-th1', 'dispatch-94b0d6a78296', 'vi-000000000047');
    } finally {
      db.close();
    }
    const { notifyFn, calls } = recordingNotifyFn();

    const result = await runVoiceInboxFallback(
      { now, everyMs: 300_000 },
      { loadVoiceInboxModules: async () => fakeVoiceInboxModules(), notifyFn }
    );

    assert.equal(result.touched, 1, 'the legacy orphan must be selected and replayed');
    assert.equal(calls.length, 0, 'zero prior rerouted events - under the alert threshold');
    assert.equal(readRouteQueueLines().filter((l) => l.task_id === 'vi-000000000047').length, 1);
    assert.equal(readEvents('vi-000000000047').length, 1); // the replay's task.rerouted
  });
});

// ---------------------------------------------------------------------------
// Route-stage topic creation (operator feature, 2026-09-14): the received
// arm passes --create-topic to route_task.py when the task fit NO keyword
// bucket and the target is the generic general-knowledge bucket. The python
// side owns formation/fallback mechanics (test_worker_scripts.py); these
// tests own the pa-side DECISION — which calls carry the flag and which must
// not — driving the REAL route_task.py subprocess against a local API stub.
// ---------------------------------------------------------------------------

interface StubRequest {
  path: string;
  body: Record<string, unknown>;
}

/** Local createForumTopic stub; production never sets VOICE_INBOX_TELEGRAM_API_BASE. */
async function startStubTelegram(response: unknown): Promise<{
  url: string;
  requests: StubRequest[];
  close: () => Promise<void>;
}> {
  const requests: StubRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      requests.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : {} });
      const data = Buffer.from(JSON.stringify(response));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': data.length });
      res.end(data);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Points the real route_task.py subprocess at the stub for the duration of
 *  `fn`, restoring the caller's environment after. */
async function withCreationEnv<T>(stubUrl: string, fn: () => Promise<T>): Promise<T> {
  const saved = {
    base: process.env.VOICE_INBOX_TELEGRAM_API_BASE,
    token: process.env.TELEGRAM_BOT_TOKEN,
  };
  process.env.VOICE_INBOX_TELEGRAM_API_BASE = stubUrl;
  process.env.TELEGRAM_BOT_TOKEN = '12345:testtoken';
  try {
    return await fn();
  } finally {
    if (saved.base === undefined) delete process.env.VOICE_INBOX_TELEGRAM_API_BASE;
    else process.env.VOICE_INBOX_TELEGRAM_API_BASE = saved.base;
    if (saved.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = saved.token;
  }
}

function writeConfigYamlWithKeywords(): void {
  writeFileSync(
    join(tempDir, 'config.yaml'),
    `voice_inbox:\n  inbox_topic: "${INBOX_TOPIC}"\n` +
      `voice_inbox_fallback:\n  keyword_topics:\n    invoice: "${OTHER_TOPIC}"\n`,
    'utf8'
  );
}

/** The shared fixture registers thread 0 only; route_task.py resolves the
 *  target topic against the registry, so tests routing to OTHER_TOPIC must
 *  register thread 555 too. */
function writeTopicsJsonWithOther(): void {
  writeFileSync(
    join(tempDir, 'telegram-topic-names.json'),
    JSON.stringify({
      [String(CHAT_ID)]: {
        '0': { name: 'general-knowledge', description: 'default topic' },
        '555': { name: 'invoices', description: 'invoice tasks' },
      },
    }),
    'utf8'
  );
}

function readTopicsJson(): Record<string, Record<string, { name?: string }>> {
  return JSON.parse(readFileSync(join(tempDir, 'telegram-topic-names.json'), 'utf8'));
}

describe('voice-inbox-fallback: route-stage topic creation wiring', () => {
  it('resolveTargetDetailed: records the basis the creation decision reads', () => {
    const cfg = { inboxTopic: INBOX_TOPIC, keywordTopics: { invoice: OTHER_TOPIC } };
    delete process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC;
    assert.deepEqual(resolveTargetDetailed('please find my invoice from march', cfg), {
      topic: OTHER_TOPIC,
      basis: 'keyword',
    });
    assert.deepEqual(resolveTargetDetailed('anything at all', cfg), {
      topic: GENERAL_KNOWLEDGE_TOPIC,
      basis: 'general-knowledge',
    });
    process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC = OTHER_TOPIC;
    try {
      assert.deepEqual(resolveTargetDetailed('anything at all', cfg), {
        topic: OTHER_TOPIC,
        basis: 'override',
      });
    } finally {
      delete process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC;
    }
  });

  it('forms a topic when no bucket fits and routes the task there', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    await buildFixtureLedger([
      {
        task_id: 'vi-0000000000c1',
        tenant_id: 't-create',
        source: 'text',
        transcript: null,
        request_text: 'research solar inverter prices',
        state: 'received',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 20 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 20 * 60_000, now),
      },
    ]);
    const stub = await startStubTelegram({ ok: true, result: { message_thread_id: 777 } });
    try {
      await withCreationEnv(stub.url, async () => {
        const result = await runVoiceInboxFallback({ now, everyMs: 300_000 });
        assert.equal(result.touched, 1);
      });

      assert.equal(stub.requests.length, 1, 'exactly one createForumTopic call');
      assert.match(stub.requests[0].path, /\/bot12345:testtoken\/createForumTopic$/);
      assert.deepEqual(stub.requests[0].body, {
        chat_id: CHAT_ID,
        name: 'Research Solar Inverter Prices',
      });

      const row = readTaskRow('vi-0000000000c1');
      assert.equal(row.state, 'routed');
      assert.equal(row.routed_to, `${CHAT_ID}_777`);
      assert.equal(row.routing_reason, 'formed Research Solar Inverter Prices: no existing topic matched by name');
      assert.equal(
        readRouteQueueLines().filter((l) => l.task_id === 'vi-0000000000c1')[0].thread_id,
        777
      );
      const registry = readTopicsJson();
      assert.deepEqual(registry[String(CHAT_ID)]['777'], {
        name: 'Research Solar Inverter Prices',
        description: 'research solar inverter prices',
      });
    } finally {
      await stub.close();
    }
  });

  it('does not create when a keyword bucket fits', async () => {
    const now = Date.now();
    writeConfigYamlWithKeywords();
    writeTopicsJsonWithOther();
    await buildFixtureLedger([
      {
        task_id: 'vi-0000000000c2',
        tenant_id: 't-create-fit',
        source: 'text',
        transcript: null,
        request_text: 'please find my invoice from march',
        state: 'received',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 20 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 20 * 60_000, now),
      },
    ]);
    const stub = await startStubTelegram({ ok: true, result: { message_thread_id: 777 } });
    try {
      await withCreationEnv(stub.url, async () => {
        const result = await runVoiceInboxFallback({ now, everyMs: 300_000 });
        assert.equal(result.touched, 1);
      });
      assert.equal(stub.requests.length, 0, 'a keyword fit must never mint a topic');
      const row = readTaskRow('vi-0000000000c2');
      assert.equal(row.routed_to, OTHER_TOPIC);
      assert.ok(!existsSync(join(tempDir, 'voice-inbox', 'topics-created.json')));
    } finally {
      await stub.close();
    }
  });

  it('suppresses creation when the task merges into an existing conversation', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJson();
    const staleAgeMs = DEFAULT_TRANSCRIBING_STALE_MS + 26 * 60_000;
    await buildFixtureLedger([
      {
        task_id: 'vi-0000000000c4',
        tenant_id: 't-create-merge',
        source: 'text',
        transcript: null,
        request_text: 'summarize the board meeting notes',
        state: 'received',
        created_at: iso(staleAgeMs, now),
        updated_at: iso(staleAgeMs, now),
      },
      {
        task_id: 'vi-0000000000c5',
        tenant_id: 't-create-merge',
        source: 'text',
        transcript: null,
        request_text: 'summarize the board meeting notes today',
        state: 'running',
        created_at: iso(staleAgeMs - 60_000, now),
        updated_at: iso(staleAgeMs - 60_000, now),
      },
    ]);
    assert.ok(
      wordOverlap('summarize the board meeting notes', 'summarize the board meeting notes today') >= 0.6
    );
    const stub = await startStubTelegram({ ok: true, result: { message_thread_id: 777 } });
    try {
      await withCreationEnv(stub.url, async () => {
        const result = await runVoiceInboxFallback({ now, everyMs: 300_000 });
        assert.equal(result.touched, 1);
      });
      assert.equal(stub.requests.length, 0, 'a merged task must never mint a topic');
      const payload = JSON.parse(readEvents('vi-0000000000c4')[0].payload_json);
      assert.equal(payload.continues, 'vi-0000000000c5');
      assert.equal(payload.routed_to, GENERAL_KNOWLEDGE_TOPIC);
    } finally {
      await stub.close();
    }
  });

  it('suppresses creation when the operator pinned an explicit default topic', async () => {
    const now = Date.now();
    writeConfigYaml();
    writeTopicsJsonWithOther();
    await buildFixtureLedger([
      {
        task_id: 'vi-0000000000c6',
        tenant_id: 't-create-pin',
        source: 'text',
        transcript: null,
        request_text: 'research solar inverter prices',
        state: 'received',
        created_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 20 * 60_000, now),
        updated_at: iso(DEFAULT_TRANSCRIBING_STALE_MS + 20 * 60_000, now),
      },
    ]);
    const savedOverride = process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC;
    process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC = OTHER_TOPIC;
    const stub = await startStubTelegram({ ok: true, result: { message_thread_id: 777 } });
    try {
      await withCreationEnv(stub.url, async () => {
        const result = await runVoiceInboxFallback({ now, everyMs: 300_000 });
        assert.equal(result.touched, 1);
      });
      assert.equal(stub.requests.length, 0, 'an explicit operator bucket suppresses creation');
      assert.equal(readTaskRow('vi-0000000000c6').routed_to, OTHER_TOPIC);
    } finally {
      await stub.close();
      if (savedOverride === undefined) delete process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC;
      else process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC = savedOverride;
    }
  });
});
