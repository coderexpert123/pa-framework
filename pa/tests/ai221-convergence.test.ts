import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { createTempPaHome, cleanup } from './helpers.js';
import { repoRootFromModule } from '../src/lib/git-root.js';
import { flushLog } from '../src/lib/log.js';
import { voiceInboxLedgerPath } from '../src/lib/voice-inbox-ledger.js';
import {
  runVoiceInboxFallback,
  DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS,
  DEFAULT_SUPERVISION_STALE_MS,
  type VoiceInboxFallbackDeps,
  type VoiceInboxModules,
} from '../src/lib/maintenance/jobs/voice-inbox-fallback.js';

// AI-221 convergence verification (AI-228 builder flagged the missing artifact).
//
// AI-221 (answer-resume) is archived FIXED, but its convergence path is only
// proven piecewise: answer-resume.test.ts proves answerAndResume() queues
// exactly one kind:"steer" route-queue entry (the D4 gate), and
// voice-inbox-fallback.test.ts proves the dead-dispatch scan skips a freshly-
// heartbeated dispatch (running-skipped-supervised). No single test connects
// the two: that an answer arriving on a dispatched task resumes the worker via
// a steer entry AND the fallback's supervision scan goes quiet (no double
// re-injection) in the SAME scenario. This test is that artifact.
//
// The path under test:
//   answer → answerAndResume() writes the answer file + queues one steer
//         → task transitions awaiting_input → running
//         → fallback's dead-dispatch scan sees a fresh executor heartbeat
//         → SKIPS re-injection (running-skipped-supervised)
//         → no task.rerouted event fires (the fallback went quiet)
//
// This test dynamically imports the REAL answerAndResume from voice-inbox's
// compiled dist (same computed-specifier pattern as the fallback job's own
// defaultLoadVoiceInboxModules — a computed specifier skips pa's strict
// tsconfig module resolution at compile time, because voice-inbox ships no
// .d.ts). If voice-inbox is not built (fresh clone, CI), the test is SKIPPED,
// not failed — the convergence artifact is only meaningful where both packages
// are built, and a missing build must never break the pa suite (same policy as
// the fallback test's FIXTURE_SCHEMA_SQL hand-copy comment).

let tempDir: string;
let repoRoot: string;

const CHAT_ID = -1009999999999;
const OTHER_TOPIC = `${CHAT_ID}_555`;
const MINUTE = 60_000;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  repoRoot = await repoRootFromModule(__filename);
});

afterEach(async () => {
  await cleanup(tempDir);
});

// --- fixture schema (hand-copy of voice-inbox ledger schema v8) ---------------
// Same discipline as voice-inbox-fallback.test.ts's FIXTURE_SCHEMA_SQL: a pa
// test must not depend on another package's build artifact for fixture setup.
// Verified current 2026-09-14 against projects/voice-inbox/src/ledger.ts.
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
  conversation_id TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  title           TEXT,
  recap           TEXT,
  next_action     TEXT,
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

function openFixtureLedger(): Database.Database {
  const dbPath = voiceInboxLedgerPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 3000');
  db.pragma('journal_mode = WAL');
  db.exec(FIXTURE_SCHEMA_SQL);
  return db;
}

function iso(msAgo: number, now: number): string {
  return new Date(now - msAgo).toISOString();
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

/** OS-truth readers canned for the test — same shape as the fallback test's
 *  cannedOsReads. Never touches the real OS. */
function cannedOsReads(alivePids: number[] = [], cmdlinePids: number[] = []) {
  return {
    areProcessesAliveFn: async (pids: number[]) =>
      new Map(pids.map((p) => [p, alivePids.includes(p)])),
    findProcessesByCommandLineFn: async (needle: string) =>
      cmdlinePids.map((pid) => ({ pid, cmdline: `python worker --dispatch ${needle}` })),
  };
}

/** Kill-path double — records kills/removals; identical to the fallback test's
 *  killRecorder. In the supervised-skip path neither is called, so the arrays
 *  stay empty (the assertion). */
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

function fakePidEntry(
  dispatchId: string,
  overrides: Partial<{ pid: number; descendants: number[]; heartbeatAt: number }> = {}
) {
  return {
    pid: 12345,
    spawnedBy: 1,
    worker: 'agy',
    skill: `topic-${OTHER_TOPIC}`,
    dispatchId,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A fake VoiceInboxModules that THROWS if the fallback ever tries to replay —
 *  the supervised-skip path must never reach the replay, so this double is the
 *  tripwire. Same pattern as the supervised-dispatch test in
 *  voice-inbox-fallback.test.ts. */
function tripwireModules(): VoiceInboxModules {
  const tripwire = async () => {
    throw new Error('convergence: loadVoiceInboxModules must not be called — a supervised dispatch is never replayed');
  };
  return {
    // @ts-expect-error — tripwire: the fallback must never call this
    ledger: { transitionTask: tripwire, appendEvent: tripwire },
    // @ts-expect-error — tripwire
    bridgeWriter: { appendRouteEntry: tripwire, buildTargetInjectionText: tripwire },
    // @ts-expect-error — tripwire
    briefing: { CONVERSATION_BRIEFING_MIN: 200, buildConversationBriefing: tripwire, briefingBudget: () => 1200, ledgerPathOf: () => 'L' },
  };
}

/** The answerAndResume signature, typed inline so pa's strict tsconfig never
 *  resolves the voice-inbox module at compile time (it ships no .d.ts and is
 *  outside rootDir). Mirrors answer-resume.ts's exported function. */
type AnswerAndResumeFn = (
  db: Database.Database,
  tenantId: string,
  taskId: string,
  requestId: string,
  answer: { kind: 'value'; value: string } | { kind: 'pointer'; pointer: string },
  deps: { routeQueuePath: string; answersDir: string }
) => Promise<{
  request: { status: string; answer_pointer: string | null };
  task: { state: string; conversation_id: string; task_id: string; tenant_id: string };
  steer_queued: boolean;
  steer_skipped_reason?: 'no-routed-to' | 'no-worker-resource' | 'append-failed';
}>;

/** Dynamically import the REAL answerAndResume from voice-inbox's compiled dist.
 *  Computed specifier (a variable, not a string literal) so pa's strict tsconfig
 *  skips module resolution at compile time — voice-inbox ships no .d.ts. Same
 *  pattern as the fallback job's defaultLoadVoiceInboxModules. Returns undefined
 *  when the dist is not built (fresh clone / CI). */
async function tryLoadAnswerAndResume(repoRoot: string): Promise<AnswerAndResumeFn | undefined> {
  const distPath = join(repoRoot, 'projects', 'voice-inbox', 'dist', 'answer-resume.js');
  if (!existsSync(distPath)) return undefined;
  const href = pathToFileURL(distPath).href;
  // Computed specifier — tsc does not resolve this at compile time.
  const mod: Record<string, unknown> = await import(href);
  return mod.answerAndResume as AnswerAndResumeFn;
}

describe('AI-221 convergence — answer-resume steer + fallback supervised-skip in one scenario', () => {
  it('an answer on a dispatched task queues exactly one steer and the fallback goes quiet (no task.rerouted)', async (t) => {
    // --- fixture: a task awaiting_input with the D4 gate satisfied -------
    // routed_to + worker_resource set (the D4 gate for steer queuing) and a
    // worker_dispatch_id (the C4 gate for the fallback's dead-dispatch scan).
    const realNow = Date.now();
    const taskId = 'vi-000000000070';
    const tenantId = 't-ai221-conv';
    const requestId = 'ir-000000000001';
    const dispatchId = 'dispatch-aaaaaaaaaaaa';
    const workerResource = `topic-${OTHER_TOPIC}`;

    const db = openFixtureLedger();
    try {
      db.prepare(
        'INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(tenantId, 50_000, CHAT_ID, 'Op', new Date(realNow).toISOString());

      // The task is in awaiting_input — the state a real task is in when the
      // operator's answer arrives (createInputRequest moved it running →
      // awaiting_input). answerAndResume's answerInputRequest will transition
      // it back to running.
      db.prepare(
        `INSERT INTO tasks
         (task_id, tenant_id, source, transcript, request_text, state, routed_to,
          created_at, updated_at, conversation_id, worker_resource, worker_dispatch_id)
         VALUES (?, ?, 'text', NULL, ?, 'awaiting_input', ?, ?, ?, ?, ?, ?)`
      ).run(
        taskId, tenantId, 'renew the cert', OTHER_TOPIC,
        iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + 60 * MINUTE, realNow),
        iso(DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS + MINUTE, realNow),
        taskId, workerResource, dispatchId
      );

      // A pending secret input request — what answerAndResume will answer.
      db.prepare(
        `INSERT INTO input_requests
         (request_id, task_id, tenant_id, kind, prompt, params_json, status, created_at)
         VALUES (?, ?, ?, 'secret', ?, '{}', 'pending', ?)`
      ).run(requestId, taskId, tenantId, 'API key?', new Date(realNow).toISOString());
    } finally {
      db.close();
    }

    // --- load the real answerAndResume (skip if voice-inbox unbuilt) ------
    const answerAndResume = await tryLoadAnswerAndResume(repoRoot);
    if (answerAndResume === undefined) {
      t.skip('voice-inbox dist not built — convergence test requires both packages');
      return;
    }

    // --- step 1: the answer arrives → answerAndResume --------------------
    const routeQueuePath = join(tempDir, 'voice-inbox', 'route-queue.jsonl');
    const answersDir = join(tempDir, 'voice-inbox', 'answers');
    const answerDb = new Database(voiceInboxLedgerPath(), { fileMustExist: true });
    answerDb.pragma('busy_timeout = 3000');
    answerDb.pragma('journal_mode = WAL');
    try {
      const result = await answerAndResume(
        answerDb,
        tenantId,
        taskId,
        requestId,
        { kind: 'value', value: 'sk-secret-value' },
        { routeQueuePath, answersDir }
      );

      // D4 gate passed → exactly one steer queued.
      assert.equal(result.steer_queued, true);
      assert.equal(result.steer_skipped_reason, undefined);
      // answerInputRequest moved the task awaiting_input → running.
      assert.equal(result.task.state, 'running');
      // The input request is answered.
      assert.equal(result.request.status, 'answered');
      assert.ok(result.request.answer_pointer, 'answer_pointer must be set');

      // The answer file was written (0600 on non-Windows) and holds the value.
      const pointer = result.request.answer_pointer as string;
      assert.equal(readFileSync(pointer, 'utf8'), 'sk-secret-value');
      if (process.platform !== 'win32') {
        assert.equal(statSync(pointer).mode & 0o777, 0o600);
      }
    } finally {
      answerDb.close();
    }

    // Assert: exactly one route-queue entry, and it is the steer.
    const queueAfterAnswer = readRouteQueueLines().filter((l) => l.task_id === taskId);
    assert.equal(queueAfterAnswer.length, 1, 'answerAndResume must queue exactly one entry');
    const steerEntry = queueAfterAnswer[0];
    assert.equal(steerEntry.kind, 'steer');
    assert.equal(steerEntry.steer_mode, 'queue');
    assert.equal(steerEntry.steer_conversation, taskId);
    assert.equal(steerEntry.chat_id, CHAT_ID);
    assert.equal(steerEntry.thread_id, 555);
    assert.equal(steerEntry.task_id, taskId);
    assert.equal(steerEntry.tenant_id, tenantId);

    // The task is now running (answerInputRequest transitioned it).
    assert.equal(readTaskRow(taskId).state, 'running');

    // --- step 2: the fallback's dead-dispatch scan runs ------------------
    // answerAndResume set updated_at to realNow. The fallback's running
    // cutoff is now - DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS (20 min). Use a
    // now 25 min ahead of realNow so the freshly-answered task is stale enough
    // to be selected as a running candidate — the scan WOULD re-inject it if
    // the heartbeat were stale.
    const fallbackNow = realNow + 25 * MINUTE;
    const alive = [12345];
    const kr = killRecorder(alive);
    const { notifyFn, calls } = recordingNotifyFn();

    const fbResult = await runVoiceInboxFallback(
      { now: fallbackNow, everyMs: 300_000 },
      {
        // Fresh executor heartbeat: 30 s old, well within
        // DEFAULT_SUPERVISION_STALE_MS (5 min) — the dispatch is supervised.
        listWorkerPidsFn: async () => [fakePidEntry(dispatchId, { heartbeatAt: fallbackNow - 30_000 })],
        ...cannedOsReads(alive),
        ...kr,
        loadVoiceInboxModules: async () => tripwireModules(),
        notifyFn,
      }
    );

    // --- step 3: assert the fallback went quiet --------------------------
    assert.equal(fbResult.touched, 0, 'a supervised dispatch is never touched');
    assert.equal((fbResult.detail as { running: number }).running, 0);

    // No kill, no registry removal — the supervised-skip path.
    assert.deepEqual(kr.killed, []);
    assert.deepEqual(kr.removed, []);

    // No operator or thread notify.
    assert.equal(calls.length, 0, 'a supervised skip sends no notify');

    // CRITICAL convergence assertion: no task.rerouted event fired.
    // The fallback's replay would have written one (transitionTask with
    // eventKind 'task.rerouted'); the supervised skip wrote nothing.
    const allEvents = readEvents(taskId);
    const reroutedEvents = allEvents.filter((e) => e.kind === 'task.rerouted');
    assert.equal(reroutedEvents.length, 0, 'no task.rerouted event — the fallback went quiet');

    // The only event is the task.input_received from answerAndResume's
    // answerInputRequest — the answer landing, not a re-injection.
    const inputReceivedEvents = allEvents.filter((e) => e.kind === 'task.input_received');
    assert.equal(inputReceivedEvents.length, 1, 'exactly one task.input_received from the answer');

    // The route queue still has exactly one entry — the steer from
    // answerAndResume. The fallback added nothing (no double re-injection).
    const queueAfterFallback = readRouteQueueLines().filter((l) => l.task_id === taskId);
    assert.equal(queueAfterFallback.length, 1, 'no second route-queue entry — no double re-injection');
    assert.equal(queueAfterFallback[0].kind, 'steer', 'the sole entry is still the steer');

    // The task is still running — the supervised run keeps working.
    assert.equal(readTaskRow(taskId).state, 'running');

    // The running-skipped-supervised log line fired (the fallback's
    // dead-dispatch scan saw the fresh heartbeat and skipped).
    await flushLog();
    const appLog = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
    const logLines = appLog
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const skips = logLines.filter(
      (l) => l.module === 'voice-inbox-fallback' && l.action === 'running-skipped-supervised' && l.taskId === taskId
    );
    assert.equal(skips.length, 1, 'expected exactly one running-skipped-supervised log line');
    assert.equal(skips[0].dispatchId, dispatchId);
    assert.equal(skips[0].heartbeatAgeSeconds, 30);
    assert.equal(skips[0].livePids, 1);
  });
});
