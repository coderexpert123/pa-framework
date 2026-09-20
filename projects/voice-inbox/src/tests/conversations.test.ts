/**
 * Conversation tests (2026-09-08 voice-inbox redesign, WP-1, §5.2 E14):
 * the three ledger.ts readers (listConversationTasks / listConversations /
 * listOpenConversations — the v14 24-hour offer, status words, snippet rules,
 * excludeConversationId, plus listRecentConversations) and the two
 * HTTP endpoints (§3.4/§3.5) through the socket-free router: tenant
 * isolation and the §3.6 telegram_link derivation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  conversationWorkerResource,
  countConversations,
  createInputRequest,
  createTask,
  getConversationMeta,
  listConversationTasks,
  listConversations,
  listConversationsPage,
  listOpenConversations,
  listRecentConversations,
  openLedger,
  setConversationMeta,
  setConversationViewed,
  transitionTask,
  upsertTenant,
} from '../ledger.js';
import { createRouter, type ApiRequest, type RouteDeps } from '../routes.js';
import type { VoiceInboxConfig } from '../config.js';
import { createSession } from '../identity.js';

/** Synchronous delay (Windows' Date resolution is coarse enough that two
 * back-to-back ledger writes can otherwise land on the same millisecond,
 * making created_at/updated_at ordering assertions flaky). */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// --- ledger-level fixture ----------------------------------------------------

interface LedgerFixture {
  db: ReturnType<typeof openLedger>;
  dir: string;
  cleanup: () => void;
}

const T_A = 't-111';
const T_B = 't-222';

function makeLedger(): LedgerFixture {
  const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-conversations-'));
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

function routeAndRun(f: LedgerFixture, taskId: string, tenantId = T_A, topic = '-1001234567890_2002'): void {
  transitionTask(f.db, tenantId, taskId, 'routed', { eventKind: 'task.routed', routedTo: topic });
  transitionTask(f.db, tenantId, taskId, 'running', { eventKind: 'task.progress' });
}

describe('listConversationTasks', () => {
  it('returns only one conversation, ascending by created_at then task_id, tenant-scoped', () => {
    const f = makeLedger();
    try {
      const root = createTask(f.db, T_A, { source: 'text', requestText: 'root request' });
      sleepMs(5);
      const follow1 = createTask(f.db, T_A, {
        source: 'text',
        requestText: 'follow 1',
        conversationId: root.task_id,
      });
      sleepMs(5);
      const follow2 = createTask(f.db, T_A, {
        source: 'text',
        requestText: 'follow 2',
        conversationId: root.task_id,
      });
      const other = createTask(f.db, T_A, { source: 'text', requestText: 'unrelated' });

      const tasks = listConversationTasks(f.db, T_A, root.task_id);
      assert.deepEqual(tasks.map((t) => t.task_id), [root.task_id, follow1.task_id, follow2.task_id]);
      assert.ok(!tasks.some((t) => t.task_id === other.task_id));

      // Tenant-scoped like every other reader.
      assert.deepEqual(listConversationTasks(f.db, T_B, root.task_id), []);
    } finally {
      f.cleanup();
    }
  });
});

describe('listConversations', () => {
  it('groups by conversation, orders newest first, and rolls up non-null fields', () => {
    const f = makeLedger();
    try {
      // convo2 is created FIRST so convo1's later activity is unambiguously
      // the more recent `updated_at` — avoids depending on tie-breaking.
      const convo2Root = createTask(f.db, T_A, { source: 'text', requestText: 'convo 2 root' });
      sleepMs(10);

      const convo1Root = createTask(f.db, T_A, { source: 'text', requestText: 'convo 1 root' });
      routeAndRun(f, convo1Root.task_id);
      const { request } = createInputRequest(f.db, T_A, convo1Root.task_id, {
        kind: 'confirm',
        prompt: 'Proceed?',
        params: {},
      });
      sleepMs(5);
      const convo1Follow = createTask(f.db, T_A, {
        source: 'text',
        requestText: 'convo 1 follow-up',
        conversationId: convo1Root.task_id,
      });
      routeAndRun(f, convo1Follow.task_id);
      transitionTask(f.db, T_A, convo1Follow.task_id, 'done', {
        eventKind: 'task.completed',
        resultSummary: 'convo 1 answer',
      });

      const summaries = listConversations(f.db, T_A);
      assert.equal(summaries.length, 2);

      const convo1 = summaries.find((s) => s.conversation_id === convo1Root.task_id);
      const convo2 = summaries.find((s) => s.conversation_id === convo2Root.task_id);
      assert.ok(convo1 && convo2);
      // Newest first: convo1's last activity (the `done` transition) is more
      // recent than convo2's one-time creation.
      assert.deepEqual(summaries.map((s) => s.conversation_id), [convo1Root.task_id, convo2Root.task_id]);

      assert.equal(convo1!.task_count, 2);
      assert.equal(convo1!.request_text, 'convo 1 root'); // the ROOT task's text
      assert.equal(convo1!.latest_request_text, 'convo 1 follow-up');
      assert.equal(convo1!.result_summary, 'convo 1 answer');
      assert.equal(convo1!.state, 'done');
      assert.equal(convo1!.routed_to, '-1001234567890_2002');
      assert.equal(convo1!.latest_task_id, convo1Follow.task_id);
      assert.equal(convo1!.pending_input_count, 1); // the confirm request is still pending
      assert.ok(request.request_id.startsWith('ir-'));

      assert.equal(convo2!.task_count, 1);
      assert.equal(convo2!.request_text, 'convo 2 root');
      assert.equal(convo2!.latest_request_text, 'convo 2 root');
      assert.equal(convo2!.result_summary, null);
      assert.equal(convo2!.routed_to, null);
      assert.equal(convo2!.pending_input_count, 0);

      assert.deepEqual(listConversations(f.db, T_B), []);
    } finally {
      f.cleanup();
    }
  });

  it('clamps to the requested limit', () => {
    const f = makeLedger();
    try {
      for (let i = 0; i < 3; i++) {
        createTask(f.db, T_A, { source: 'text', requestText: `t${i}` });
        sleepMs(2);
      }
      assert.equal(listConversations(f.db, T_A, { limit: 2 }).length, 2);
      assert.equal(listConversations(f.db, T_A).length, 3);
    } finally {
      f.cleanup();
    }
  });
});

describe('listOpenConversations (v14 router offer)', () => {
  /** Raw UPDATE — the ledger never exposes a "backdate this task" writer, and
   * these tests need one to simulate a conversation that went stale. */
  function setUpdatedAt(f: LedgerFixture, taskId: string, iso: string): void {
    f.db.prepare('UPDATE tasks SET updated_at = ? WHERE task_id = ?').run(iso, taskId);
  }

  it('offers every thread updated in the last 24 hours whatever its status, newest first, honoring excludeConversationId', () => {
    const f = makeLedger();
    try {
      const open1 = createTask(f.db, T_A, { source: 'text', requestText: 'open one' });
      sleepMs(5);
      const done = createTask(f.db, T_A, { source: 'text', requestText: 'a finished one' });
      routeAndRun(f, done.task_id);
      transitionTask(f.db, T_A, done.task_id, 'done', { eventKind: 'task.completed' });
      sleepMs(5);
      const cancelled = createTask(f.db, T_A, { source: 'text', requestText: 'a cancelled one' });
      transitionTask(f.db, T_A, cancelled.task_id, 'cancelled', { eventKind: 'task.cancelled' });
      sleepMs(5);
      const open2 = createTask(f.db, T_A, { source: 'text', requestText: 'open two, newest' });

      const open = listOpenConversations(f.db, T_A);
      assert.deepEqual(open.map((c) => c.conversationId), [open2.task_id, cancelled.task_id, done.task_id, open1.task_id]);
      assert.ok(open.find((c) => c.conversationId === done.task_id)?.snippet.endsWith(' [Ready]'));
      assert.ok(open.find((c) => c.conversationId === cancelled.task_id)?.snippet.endsWith(' [Cancelled]'));
      const excluded = listOpenConversations(f.db, T_A, { excludeConversationId: open2.task_id });
      assert.deepEqual(excluded.map((c) => c.conversationId), [cancelled.task_id, done.task_id, open1.task_id]);
      assert.deepEqual(listOpenConversations(f.db, T_B), []);
    } finally {
      f.cleanup();
    }
  });

  it('has no count cap', () => {
    const f = makeLedger();
    try {
      for (let i = 0; i < 12; i++) {
        createTask(f.db, T_A, { source: 'text', requestText: `open ${i}` });
        sleepMs(2);
      }
      assert.equal(listOpenConversations(f.db, T_A).length, 12);
    } finally {
      f.cleanup();
    }
  });

  it('builds the snippet: collapse whitespace, drop ";", trim, cap at 60 chars, then recency and the status word', () => {
    const f = makeLedger();
    try {
      const now = new Date('2026-09-12T12:00:00.000Z');
      const messy = createTask(f.db, T_A, { source: 'text', requestText: '  Please   file the   report;   thanks  ' });
      setUpdatedAt(f, messy.task_id, '2026-09-12T11:59:00.000Z'); // 1 minute before `now`
      const long = createTask(f.db, T_A, { source: 'text', requestText: 'x'.repeat(80) });
      setUpdatedAt(f, long.task_id, now.toISOString());

      const open = listOpenConversations(f.db, T_A, { now });
      assert.equal(open.find((c) => c.conversationId === messy.task_id)?.snippet, 'Please file the report thanks (updated 1 minute ago) [Recorded]');
      assert.equal(open.find((c) => c.conversationId === long.task_id)?.snippet, `${'x'.repeat(60)} (updated moments ago) [Recorded]`);
    } finally {
      f.cleanup();
    }
  });

  it('a still-transcribing voice task renders an honest placeholder, not the raw "(voice recording)" text, plus recency and its word', () => {
    const f = makeLedger();
    try {
      const now = new Date('2026-09-12T12:00:00.000Z');
      const stillTranscribing = createTask(f.db, T_A, { source: 'voice', requestText: '(voice recording)', initialState: 'transcribing' });
      setUpdatedAt(f, stillTranscribing.task_id, '2026-09-12T11:59:46.000Z'); // 14s before `now`
      const open = listOpenConversations(f.db, T_A, { now });
      assert.equal(
        open.find((c) => c.conversationId === stillTranscribing.task_id)?.snippet,
        '(voice message still transcribing) (updated moments ago) [Transcribing]'
      );
    } finally {
      f.cleanup();
    }
  });

  it('excludes any thread whose last update is older than 24 hours, even a live one', () => {
    const f = makeLedger();
    try {
      const now = new Date('2026-09-12T12:00:00.000Z');
      const stale = createTask(f.db, T_A, { source: 'text', requestText: 'a stale open thread' });
      setUpdatedAt(f, stale.task_id, '2026-09-11T11:59:59.000Z'); // 24h + 1s old
      const fresh = createTask(f.db, T_A, { source: 'text', requestText: 'a fresh open thread' });
      setUpdatedAt(f, fresh.task_id, '2026-09-12T11:00:00.000Z');
      assert.deepEqual(listOpenConversations(f.db, T_A, { now }).map((c) => c.conversationId), [fresh.task_id]);
    } finally {
      f.cleanup();
    }
  });

  it('keeps a thread exactly at the 24-hour boundary, using the now seam deterministically', () => {
    const f = makeLedger();
    try {
      const now = new Date('2026-09-12T12:00:00.000Z');
      const justInside = createTask(f.db, T_A, { source: 'text', requestText: 'just inside the window' });
      setUpdatedAt(f, justInside.task_id, '2026-09-11T12:00:00.001Z'); // 1ms inside 24h
      assert.deepEqual(listOpenConversations(f.db, T_A, { now }).map((c) => c.conversationId), [justInside.task_id]);
    } finally {
      f.cleanup();
    }
  });

  it('hides a thread whose only task is a too_short recording', () => {
    const f = makeLedger();
    try {
      const voice = createTask(f.db, T_A, { source: 'voice', requestText: '(voice recording)', initialState: 'transcribing' });
      transitionTask(f.db, T_A, voice.task_id, 'transcribe_failed', {
        eventKind: 'task.failed',
        eventPayload: { reason: 'recording too short', code: 'too_short' },
      });
      const visible = createTask(f.db, T_A, { source: 'text', requestText: 'visible' });
      assert.deepEqual(listOpenConversations(f.db, T_A).map((c) => c.conversationId), [visible.task_id]);
    } finally {
      f.cleanup();
    }
  });

  it('the recency label counts hours past the first hour', () => {
    const f = makeLedger();
    try {
      const now = new Date('2026-09-12T12:00:00.000Z');
      const three = createTask(f.db, T_A, { source: 'text', requestText: 'three hours' });
      setUpdatedAt(f, three.task_id, '2026-09-12T09:00:00.000Z');
      const one = createTask(f.db, T_A, { source: 'text', requestText: 'one hour' });
      setUpdatedAt(f, one.task_id, '2026-09-12T11:00:00.000Z');
      const open = listOpenConversations(f.db, T_A, { now });
      assert.equal(open.find((c) => c.conversationId === three.task_id)?.snippet, 'three hours (updated 3 hours ago) [Recorded]');
      assert.equal(open.find((c) => c.conversationId === one.task_id)?.snippet, 'one hour (updated 1 hour ago) [Recorded]');
    } finally {
      f.cleanup();
    }
  });
});

describe('listRecentConversations (v14 Recent view)', () => {
  const hoursAgo = (now: Date, h: number): string => new Date(now.getTime() - h * 3_600_000).toISOString();
  function answerAt(f: LedgerFixture, text: string, now: Date, completedHoursAgo: number): string {
    const task = createTask(f.db, T_A, { source: 'text', requestText: text });
    routeAndRun(f, task.task_id);
    transitionTask(f.db, T_A, task.task_id, 'done', { eventKind: 'task.completed' });
    f.db.prepare('UPDATE tasks SET updated_at = ? WHERE task_id = ?').run(hoursAgo(now, completedHoursAgo), task.task_id);
    f.db.prepare("UPDATE events SET ts = ? WHERE task_id = ? AND kind = 'task.completed'").run(hoursAgo(now, completedHoursAgo), task.task_id);
    return task.task_id;
  }

  it('keeps an unviewed answer at any age, drops viewed history past 24 hours, and sorts by rank then newest update', () => {
    const f = makeLedger();
    try {
      const now = new Date();
      const oldReady = answerAt(f, 'old unviewed answer', now, 72);
      const oldViewed = answerAt(f, 'old viewed answer', now, 72);
      setConversationViewed(f.db, T_A, oldViewed, { now: new Date(now.getTime() - 71 * 3_600_000) });
      const running = createTask(f.db, T_A, { source: 'text', requestText: 'working' });
      routeAndRun(f, running.task_id);
      const concluded = answerAt(f, 'answered and seen', now, 3);
      setConversationViewed(f.db, T_A, concluded, { now: new Date(now.getTime() - 2 * 3_600_000) });

      const summaries = listRecentConversations(f.db, T_A, { now });
      assert.deepEqual(summaries.map((s) => s.conversation_id), [oldReady, running.task_id, concluded]);
      assert.deepEqual(summaries.map((s) => s.status), ['ready', 'running', 'concluded']);
      assert.deepEqual(summaries.map((s) => s.band), ['live', 'live', 'history']);
    } finally {
      f.cleanup();
    }
  });

  it('summaries carry status, band, viewed_at, answer_landed_at and failed_unresolved', () => {
    const f = makeLedger();
    try {
      const t = createTask(f.db, T_A, { source: 'text', requestText: 'broke' });
      transitionTask(f.db, T_A, t.task_id, 'failed', { eventKind: 'task.failed' });
      const [row] = listRecentConversations(f.db, T_A);
      assert.equal(row.status, 'failed');
      assert.equal(row.status_rank, 4);
      assert.equal(row.band, 'live');
      assert.equal(row.viewed_at, null);
      assert.equal(row.answer_landed_at, null);
      assert.equal(row.failed_unresolved, 1);
      const [listed] = listConversations(f.db, T_A);
      assert.equal(listed.status, 'failed');
      assert.equal(listed.failed_unresolved, 1);
    } finally {
      f.cleanup();
    }
  });

  it('a conversation summary updated_at is the newest update across its tasks', () => {
    const f = makeLedger();
    try {
      const root = createTask(f.db, T_A, { source: 'text', requestText: 'root' });
      routeAndRun(f, root.task_id);
      sleepMs(5);
      const follow = createTask(f.db, T_A, { source: 'text', requestText: 'follow-up', conversationId: root.task_id });
      sleepMs(5);
      transitionTask(f.db, T_A, root.task_id, 'done', { eventKind: 'task.completed' });
      const rootUpdated = (f.db.prepare('SELECT updated_at FROM tasks WHERE task_id = ?').get(root.task_id) as { updated_at: string }).updated_at;
      const [row] = listConversations(f.db, T_A);
      assert.equal(row.latest_task_id, follow.task_id);
      assert.equal(row.updated_at, rootUpdated);
    } finally {
      f.cleanup();
    }
  });
});

describe('conversationWorkerResource', () => {
  /** Raw UPDATE — worker_resource is only ever written by task_telemetry.py
   * in production; tests set it directly the same way routes.test.ts does. */
  function setResource(f: LedgerFixture, taskId: string, resource: string | null): void {
    f.db.prepare('UPDATE tasks SET worker_resource = ? WHERE task_id = ?').run(resource, taskId);
  }

  it('null for a conversation with no tasks at all', () => {
    const f = makeLedger();
    try {
      assert.equal(conversationWorkerResource(f.db, T_A, 'vi-000000000000'), null);
    } finally {
      f.cleanup();
    }
  });

  it('null when every task in the conversation has an empty resource', () => {
    const f = makeLedger();
    try {
      const root = createTask(f.db, T_A, { source: 'text', requestText: 'root' });
      const follow = createTask(f.db, T_A, {
        source: 'text',
        requestText: 'follow',
        conversationId: root.task_id,
      });
      setResource(f, follow.task_id, '');
      assert.equal(conversationWorkerResource(f.db, T_A, root.task_id), null);
    } finally {
      f.cleanup();
    }
  });

  it('picks the resource of the NEWEST task by updated_at', () => {
    const f = makeLedger();
    try {
      const root = createTask(f.db, T_A, { source: 'text', requestText: 'root' });
      setResource(f, root.task_id, 'topic--1001234567890_2002');
      sleepMs(5);
      const follow = createTask(f.db, T_A, {
        source: 'text',
        requestText: 'follow',
        conversationId: root.task_id,
      });
      setResource(f, follow.task_id, 'topic--1001234567890_2002-th1');
      assert.equal(conversationWorkerResource(f.db, T_A, root.task_id), 'topic--1001234567890_2002-th1');
    } finally {
      f.cleanup();
    }
  });

  it('returns a resource from a done task — D4 is state-agnostic', () => {
    const f = makeLedger();
    try {
      const task = createTask(f.db, T_A, { source: 'text', requestText: 'finished' });
      routeAndRun(f, task.task_id);
      setResource(f, task.task_id, 'topic--1001234567890_2002-th1');
      transitionTask(f.db, T_A, task.task_id, 'done', { eventKind: 'task.completed' });
      assert.equal(conversationWorkerResource(f.db, T_A, task.task_id), 'topic--1001234567890_2002-th1');
    } finally {
      f.cleanup();
    }
  });

  it('is tenant-scoped', () => {
    const f = makeLedger();
    try {
      const task = createTask(f.db, T_A, { source: 'text', requestText: 'tenant A task' });
      setResource(f, task.task_id, 'topic--1001234567890_2002');
      assert.equal(conversationWorkerResource(f.db, T_B, task.task_id), null);
      assert.equal(conversationWorkerResource(f.db, T_A, task.task_id), 'topic--1001234567890_2002');
    } finally {
      f.cleanup();
    }
  });

  it('returns a bare topic resource verbatim', () => {
    const f = makeLedger();
    try {
      const task = createTask(f.db, T_A, { source: 'text', requestText: 'bare topic' });
      setResource(f, task.task_id, 'topic--1001234567890_2002');
      assert.equal(conversationWorkerResource(f.db, T_A, task.task_id), 'topic--1001234567890_2002');
    } finally {
      f.cleanup();
    }
  });
});

// --- HTTP endpoints (§3.4/§3.5) -----------------------------------------------

interface RouterFixture {
  dir: string;
  db: ReturnType<typeof openLedger>;
  handle: ReturnType<typeof createRouter>;
  deps: RouteDeps;
  cleanup: () => void;
}

function makeRouterFixture(): RouterFixture {
  const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-conversations-http-'));
  const db = openLedger(join(dir, 'ledger.sqlite'));
  writeFileSync(join(dir, 'telegram-topic-names.json'), JSON.stringify({}), 'utf8');
  const config: VoiceInboxConfig = {
    port: 8787,
    inboxTopic: '-1001234567890_1040',
    sessionTtlHours: 168,
    pairingTtlMinutes: 10,
  };
  const deps: RouteDeps = {
    db,
    config,
    repoRoot: '/repo',
    pairingCodesPath: join(dir, 'pairing-codes.json'),
    routeQueuePath: join(dir, 'route-queue.jsonl'),
    topicNamesPath: join(dir, 'telegram-topic-names.json'),
    answersDir: join(dir, 'answers'),
    filesDir: join(dir, 'files'),
  };
  return {
    dir,
    db,
    deps,
    handle: createRouter(deps),
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

function seedSession(fx: RouterFixture, telegramUserId: number, chatId: number): string {
  const tenant = upsertTenant(fx.db, { telegramUserId, telegramChatId: chatId, displayName: 'Op' });
  const { token } = createSession(fx.db, tenant.tenant_id, 168);
  return `Bearer ${token}`;
}

function makeReq(method: string, path: string, auth?: string): ApiRequest {
  const url = new URL(path, 'http://127.0.0.1');
  const headers: Record<string, string | string[] | undefined> = {};
  if (auth) headers['authorization'] = auth;
  return { method, pathname: url.pathname, query: url.searchParams, headers, body: Buffer.alloc(0) };
}

describe('GET /conversations', () => {
  it('lists tenant-scoped summaries with a derived telegram_link, never worker_resource', async () => {
    const fx = makeRouterFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890);
      const task = createTask(fx.db, 't-424242', { source: 'text', requestText: 'link me' });
      transitionTask(fx.db, 't-424242', task.task_id, 'routed', {
        eventKind: 'task.routed',
        routedTo: '-1001234567890_13052',
      });

      const res = await fx.handle(makeReq('GET', '/api/v1/conversations', auth));
      assert.equal(res.status, 200);
      const body = res.body as { ok: boolean; conversations: Array<Record<string, unknown>> };
      assert.equal(body.ok, true);
      assert.equal(body.conversations.length, 1);
      const summary = body.conversations[0];
      assert.equal(summary.conversation_id, task.task_id);
      assert.equal(summary.telegram_link, 'https://t.me/c/1234567890/13052');
      assert.equal('worker_resource' in summary, false);
    } finally {
      fx.cleanup();
    }
  });

  it('telegram_link is null for a non -100… chat or an unrouted task', async () => {
    const fx = makeRouterFixture();
    try {
      const auth = seedSession(fx, 5, 555);
      const routed = createTask(fx.db, 't-5', { source: 'text', requestText: 'small group' });
      transitionTask(fx.db, 't-5', routed.task_id, 'routed', { eventKind: 'task.routed', routedTo: '555_9' });
      const unrouted = createTask(fx.db, 't-5', { source: 'text', requestText: 'never routed' });

      const res = await fx.handle(makeReq('GET', '/api/v1/conversations', auth));
      const body = res.body as { conversations: Array<Record<string, unknown>> };
      const links = new Map(body.conversations.map((c) => [c.conversation_id, c.telegram_link]));
      assert.equal(links.get(routed.task_id), null);
      assert.equal(links.get(unrouted.task_id), null);
    } finally {
      fx.cleanup();
    }
  });
});

describe('GET /conversations/:id', () => {
  it('returns the full task list in reading order and 404s a cross-tenant id', async () => {
    const fx = makeRouterFixture();
    try {
      const authA = seedSession(fx, 424242, -1001234567890);
      const authB = seedSession(fx, 777, -100777);
      const root = createTask(fx.db, 't-424242', { source: 'text', requestText: 'root' });
      // sleepMs: reading-order assertion below needs created_at to differ —
      // see the sleepMs doc comment (Windows' Date resolution can otherwise
      // land two back-to-back writes in the same millisecond, and the
      // task_id tie-break is random hex, so a collision made this test flaky
      // under full-suite load though it passed reliably alone).
      sleepMs(5);
      const follow = createTask(fx.db, 't-424242', {
        source: 'text',
        requestText: 'follow-up',
        conversationId: root.task_id,
      });

      const res = await fx.handle(makeReq('GET', `/api/v1/conversations/${root.task_id}`, authA));
      assert.equal(res.status, 200);
      const body = res.body as { ok: boolean; conversation: Record<string, unknown> };
      assert.equal(body.ok, true);
      const conv = body.conversation;
      assert.equal(conv.conversation_id, root.task_id);
      assert.equal(conv.task_count, 2);
      const tasks = conv.tasks as Array<Record<string, unknown>>;
      assert.deepEqual(tasks.map((t) => t.task_id), [root.task_id, follow.task_id]);
      // Each element is the same public shape GET /tasks/:id returns.
      assert.ok(Array.isArray(tasks[0].events));
      assert.ok(Array.isArray(tasks[0].input_requests));
      assert.equal('worker_resource' in tasks[0], false);

      const crossTenant = await fx.handle(
        makeReq('GET', `/api/v1/conversations/${root.task_id}`, authB)
      );
      assert.equal(crossTenant.status, 404);
      assert.deepEqual(crossTenant.body, { ok: false, error: 'not found' });

      const unknown = await fx.handle(makeReq('GET', '/api/v1/conversations/vi-000000000000', authA));
      assert.equal(unknown.status, 404);
    } finally {
      fx.cleanup();
    }
  });
});

describe('conversation summary lines — stored, never derived (AI-222)', () => {
  it('setConversationMeta: partial upsert leaves omitted fields untouched, null clears, values clamp', () => {
    const f = makeLedger();
    try {
      const conversationId = 'vi-conv-0000001';
      setConversationMeta(f.db, T_A, conversationId, { title: 'Renew passport' }, '2026-09-10T00:00:00.000Z');
      // Title-only write leaves recap untouched (still absent/null).
      let meta = getConversationMeta(f.db, T_A, conversationId);
      assert.equal(meta?.title, 'Renew passport');
      assert.equal(meta?.recap, null);
      assert.equal(meta?.next_action, null);

      setConversationMeta(f.db, T_A, conversationId,
        { recap: 'Filing the passport renewal.', next_action: 'Confirm the mailing address' },
        '2026-09-10T00:01:00.000Z');
      meta = getConversationMeta(f.db, T_A, conversationId);
      assert.equal(meta?.title, 'Renew passport'); // untouched by the second call
      assert.equal(meta?.recap, 'Filing the passport renewal.');
      assert.equal(meta?.next_action, 'Confirm the mailing address');

      // next_action: null clears.
      setConversationMeta(f.db, T_A, conversationId, { next_action: null }, '2026-09-10T00:02:00.000Z');
      meta = getConversationMeta(f.db, T_A, conversationId);
      assert.equal(meta?.next_action, null);
      assert.equal(meta?.recap, 'Filing the passport renewal.'); // still untouched

      // Over-length values clamp, never reject.
      const conversationId2 = 'vi-conv-0000002';
      setConversationMeta(f.db, T_A, conversationId2, {
        title: 'x'.repeat(61),
        recap: 'y'.repeat(401),
      }, '2026-09-10T00:03:00.000Z');
      const meta2 = getConversationMeta(f.db, T_A, conversationId2);
      assert.equal(meta2!.title!.length, 60);
      assert.equal(meta2!.recap!.length, 400);
    } finally {
      f.cleanup();
    }
  });

  it('titleIfAbsent does not overwrite a stored title, but does write when none is stored (T4)', () => {
    const f = makeLedger();
    try {
      const conversationId = 'vi-conv-0000003';
      setConversationMeta(f.db, T_A, conversationId, { title: 'Worker-chosen title' }, '2026-09-10T00:00:00.000Z');
      // The failing case: a routing worker's initial-only write must NOT
      // overwrite a title a working worker already chose.
      setConversationMeta(f.db, T_A, conversationId, { title: 'Routing worker guess' },
        '2026-09-10T00:01:00.000Z', { titleIfAbsent: true });
      assert.equal(getConversationMeta(f.db, T_A, conversationId)?.title, 'Worker-chosen title');

      // The discriminating control: the SAME call DOES write when no title is
      // stored yet — a check that could not fail would prove nothing.
      const conversationId2 = 'vi-conv-0000004';
      setConversationMeta(f.db, T_A, conversationId2, { title: 'First title seen' },
        '2026-09-10T00:00:00.000Z', { titleIfAbsent: true });
      assert.equal(getConversationMeta(f.db, T_A, conversationId2)?.title, 'First title seen');
    } finally {
      f.cleanup();
    }
  });

  it('listConversations returns the stored meta for one conversation and null for one with none — the server never derives', () => {
    const f = makeLedger();
    try {
      const withMeta = createTask(f.db, T_A, { source: 'text', requestText: 'file the Q3 report' });
      setConversationMeta(f.db, T_A, withMeta.task_id, {
        title: 'Q3 report', recap: 'Filed and under review.', next_action: 'Await sign-off',
      }, '2026-09-10T00:00:00.000Z');
      sleepMs(5);
      const withoutMeta = createTask(f.db, T_A, { source: 'text', requestText: 'a request with no meta row' });

      const summaries = listConversations(f.db, T_A);
      const withMetaSummary = summaries.find((s) => s.conversation_id === withMeta.task_id);
      const withoutMetaSummary = summaries.find((s) => s.conversation_id === withoutMeta.task_id);
      assert.ok(withMetaSummary && withoutMetaSummary);
      assert.equal(withMetaSummary!.title, 'Q3 report');
      assert.equal(withMetaSummary!.recap, 'Filed and under review.');
      assert.equal(withMetaSummary!.next_action, 'Await sign-off');

      // The control proving the server never derives: no meta row means
      // null on all three, and specifically NOT the raw request_text.
      assert.equal(withoutMetaSummary!.title, null);
      assert.equal(withoutMetaSummary!.recap, null);
      assert.equal(withoutMetaSummary!.next_action, null);
      assert.notEqual(withoutMetaSummary!.title, 'a request with no meta row');
    } finally {
      f.cleanup();
    }
  });

  it('GET /conversations and GET /conversations/:id agree on the three fields for the same conversation', async () => {
    const fx = makeRouterFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890);
      const task = createTask(fx.db, 't-424242', { source: 'text', requestText: 'summarize lines' });
      setConversationMeta(fx.db, 't-424242', task.task_id, {
        title: 'Summarize lines', recap: 'Working on it.', next_action: 'Nothing yet',
      }, '2026-09-10T00:00:00.000Z');

      const listRes = await fx.handle(makeReq('GET', '/api/v1/conversations', auth));
      const listBody = listRes.body as { conversations: Array<Record<string, unknown>> };
      const listRow = listBody.conversations.find((c) => c.conversation_id === task.task_id);
      assert.ok(listRow);

      const detailRes = await fx.handle(makeReq('GET', `/api/v1/conversations/${task.task_id}`, auth));
      const detailBody = detailRes.body as { conversation: Record<string, unknown> };

      assert.equal(listRow!.title, 'Summarize lines');
      assert.equal(listRow!.recap, 'Working on it.');
      assert.equal(listRow!.next_action, 'Nothing yet');
      assert.equal(detailBody.conversation.title, listRow!.title);
      assert.equal(detailBody.conversation.recap, listRow!.recap);
      assert.equal(detailBody.conversation.next_action, listRow!.next_action);
    } finally {
      fx.cleanup();
    }
  });
});

// --- paging across the 500-task window boundary (vi-19787afc4b2e) ------------

interface ConvIds {
  conversationId: string;
  /** Root first, follow-ups after — ascending creation order. */
  taskIds: string[];
}

describe('countConversations + listConversationsPage (vi-19787afc4b2e)', () => {
  /** The boundary fixture: on T_A create 27 conversations IN ORDER — conv 0
   * (oldest) with 2 tasks, convs 1..25 with 20 tasks each, conv 26 (newest)
   * with 1 task: 503 tasks total. sleepMs(2) between conversations so
   * MAX(updated_at) ordering is deterministic; none needed within one.
   * `runningRoots` indexes conversations whose root is transitioned to
   * `running` INLINE, at its own creation position — after that
   * conversation's tasks exist, before the next one's do — so the bump
   * lands inside the conversation's own ordering slot instead of making it
   * the tenant's newest conversation. */
  function makeBoundaryLedger(
    runningRoots: number[] = []
  ): { f: ReturnType<typeof makeLedger>; convs: ConvIds[] } {
    const f = makeLedger();
    const convs: ConvIds[] = [];
    // conv 0: oldest, 2 tasks.
    const root0 = createTask(f.db, T_A, { source: 'text', requestText: 'conv 0 root' });
    sleepMs(2); // separate created_at — a tie would let the random task_id
    // ASC tiebreak flip which of the two reads as the newest task.
    const follow0 = createTask(f.db, T_A, {
      source: 'text',
      requestText: 'conv 0 follow',
      conversationId: root0.task_id,
    });
    convs.push({ conversationId: root0.task_id, taskIds: [root0.task_id, follow0.task_id] });
    if (runningRoots.includes(0)) {
      transitionTask(f.db, T_A, root0.task_id, 'running', { eventKind: 'task.progress' });
    }
    for (let c = 1; c <= 26; c++) {
      sleepMs(2);
      const root = createTask(f.db, T_A, { source: 'text', requestText: `conv ${c} root` });
      const taskIds = [root.task_id];
      const extra = c <= 25 ? 19 : 0; // convs 1..25: 20 tasks each; conv 26: 1
      for (let i = 0; i < extra; i++) {
        taskIds.push(
          createTask(f.db, T_A, {
            source: 'text',
            requestText: `conv ${c} follow ${i}`,
            conversationId: root.task_id,
          }).task_id
        );
      }
      if (runningRoots.includes(c)) {
        transitionTask(f.db, T_A, root.task_id, 'running', { eventKind: 'task.progress' });
      }
      convs.push({ conversationId: root.task_id, taskIds });
    }
    return { f, convs };
  }

  it('countConversations counts every conversation, not the 500-task window', () => {
    const { f, convs } = makeBoundaryLedger();
    try {
      assert.equal(convs.length, 27);
      assert.equal(countConversations(f.db, T_A), 27);
      // THE boundary fact: conv 0's 2 tasks both fall outside the window, so
      // the windowed reader never sees that conversation at all.
      assert.equal(listConversations(f.db, T_A).length, 26);
    } finally {
      f.cleanup();
    }
  });

  it('pages return distinct correct pages in (updated_at DESC, conversation_id DESC) order', () => {
    const { f, convs } = makeBoundaryLedger();
    try {
      const newestFirst = [...convs].reverse().map((c) => c.conversationId);
      const page1 = listConversationsPage(f.db, T_A, { limit: 20, offset: 0 });
      assert.deepEqual(page1.map((r) => r.conversation_id), newestFirst.slice(0, 20)); // conv26..conv7
      const page2 = listConversationsPage(f.db, T_A, { limit: 20, offset: 20 });
      assert.deepEqual(page2.map((r) => r.conversation_id), newestFirst.slice(20)); // conv6..conv0 (7)
      const union = new Set([...page1, ...page2].map((r) => r.conversation_id));
      assert.equal(union.size, 27); // disjoint and covers all 27
      for (const c of convs) assert.ok(union.has(c.conversationId));
    } finally {
      f.cleanup();
    }
  });

  it('page entries summarize from FULL task lists at any depth', () => {
    const { f, convs } = makeBoundaryLedger();
    try {
      const page2 = listConversationsPage(f.db, T_A, { limit: 20, offset: 20 });
      const conv0 = page2.find((r) => r.conversation_id === convs[0].conversationId);
      assert.ok(conv0);
      // The window path never sees conv 0 at all; the paged path summarizes
      // from its FULL task list.
      assert.equal(conv0!.task_count, 2);
      assert.equal(conv0!.latest_task_id, convs[0].taskIds[1]); // its newest task
      assert.equal(conv0!.request_text, 'conv 0 root'); // the ROOT task's text
    } finally {
      f.cleanup();
    }
  });

  it('pending_input_count and meta land on paged rows', () => {
    // conv 3's root transitions to `running` INLINE in the fixture (at its
    // creation position): createInputRequest moves its task to
    // awaiting_input — legal from running, never from a fresh `received`
    // root. Both the transition and the input request bump conv 3's
    // updated_at, so conv 3 RE-SORTS to the newest conversation by the time
    // the pages are read — the test finds its row on whichever page holds
    // it (page 1 after the plant) instead of assuming its fixture position.
    const { f, convs } = makeBoundaryLedger([3]);
    try {
      const conv3 = convs[3];
      createInputRequest(f.db, T_A, conv3.taskIds[0], {
        kind: 'confirm',
        prompt: 'Proceed with conv 3?',
        params: {},
      });
      setConversationMeta(f.db, T_A, conv3.conversationId, { title: 'Conv three title' },
        '2026-09-10T00:00:00.000Z');
      const pages = [
        listConversationsPage(f.db, T_A, { limit: 20, offset: 0 }),
        listConversationsPage(f.db, T_A, { limit: 20, offset: 20 }),
      ];
      const row = pages.flat().find((r) => r.conversation_id === conv3.conversationId);
      assert.ok(row, 'conv 3 missing from both pages');
      assert.equal(row!.pending_input_count, 1);
      assert.equal(row!.title, 'Conv three title');
    } finally {
      f.cleanup();
    }
  });

  it('offset beyond the end yields an empty page', () => {
    const { f } = makeBoundaryLedger();
    try {
      assert.deepEqual(listConversationsPage(f.db, T_A, { limit: 20, offset: 27 }), []);
    } finally {
      f.cleanup();
    }
  });

  it('tenant-scoped', () => {
    const { f, convs } = makeBoundaryLedger();
    try {
      const bRoot = createTask(f.db, T_B, { source: 'text', requestText: 'tenant B only' });
      assert.equal(countConversations(f.db, T_B), 1);
      assert.equal(countConversations(f.db, T_A), 27); // unaffected
      const bPage = listConversationsPage(f.db, T_B, { limit: 20, offset: 0 });
      assert.deepEqual(bPage.map((r) => r.conversation_id), [bRoot.task_id]);
      // Beyond T_B's one conversation: empty — T_A's ids are unreachable.
      assert.deepEqual(listConversationsPage(f.db, T_B, { limit: 20, offset: 1 }), []);
      assert.ok(!bPage.some((r) => convs.some((c) => c.conversationId === r.conversation_id)));
    } finally {
      f.cleanup();
    }
  });
});

describe('countConversations + listConversationsPage with q', () => {
  /** The q fixture: 3 conversations on T_A whose text lives in different
   * fields — convA in request_text ('the') + meta title, convB in
   * request_text + result_summary, convC in request_text + meta recap.
   * sleepMs(2) between seeds so MAX(updated_at) ordering is deterministic. */
  function seedSearchLedger(f: LedgerFixture): { convA: string; convB: string; convC: string } {
    const convA = createTask(f.db, T_A, { source: 'text', requestText: 'file the quarterly report' });
    setConversationMeta(f.db, T_A, convA.task_id, { title: 'Q3 report' }, '2026-09-15T00:00:01.000Z');
    sleepMs(2);
    const convB = createTask(f.db, T_A, { source: 'text', requestText: 'renew passport' });
    routeAndRun(f, convB.task_id);
    transitionTask(f.db, T_A, convB.task_id, 'done', {
      eventKind: 'task.completed',
      resultSummary: 'passport filed at the embassy',
    });
    sleepMs(2);
    const convC = createTask(f.db, T_A, { source: 'text', requestText: 'buy groceries' });
    setConversationMeta(f.db, T_A, convC.task_id, { recap: 'weekly shopping list' }, '2026-09-15T00:00:03.000Z');
    return { convA: convA.task_id, convB: convB.task_id, convC: convC.task_id };
  }

  it('ANDs across whitespace-tokenized terms', () => {
    const f = makeLedger();
    try {
      const { convA } = seedSearchLedger(f);
      // 'quarterly' + 'report' both live in convA's request_text only.
      assert.deepEqual(
        listConversationsPage(f.db, T_A, { q: 'quarterly report' }).map((r) => r.conversation_id),
        [convA]
      );
      assert.equal(countConversations(f.db, T_A, 'quarterly report'), 1);
    } finally {
      f.cleanup();
    }
  });

  it('ORs each term across request_text and result_summary', () => {
    const f = makeLedger();
    try {
      const { convB } = seedSearchLedger(f);
      assert.deepEqual(
        listConversationsPage(f.db, T_A, { q: 'passport' }).map((r) => r.conversation_id),
        [convB]
      );
      assert.equal(countConversations(f.db, T_A, 'passport'), 1);
    } finally {
      f.cleanup();
    }
  });

  it('matches conversation_meta fields through the LEFT JOIN', () => {
    const f = makeLedger();
    try {
      const { convC } = seedSearchLedger(f);
      // 'shopping' lives ONLY in convC's meta recap — a conversation whose
      // task text never mentions it still surfaces.
      assert.deepEqual(
        listConversationsPage(f.db, T_A, { q: 'shopping' }).map((r) => r.conversation_id),
        [convC]
      );
      assert.equal(countConversations(f.db, T_A, 'shopping'), 1);
    } finally {
      f.cleanup();
    }
  });

  it('escapes LIKE wildcards so % and _ are literals that never widen', () => {
    const f = makeLedger();
    try {
      seedSearchLedger(f);
      assert.deepEqual(listConversationsPage(f.db, T_A, { q: '%' }), []);
      assert.equal(countConversations(f.db, T_A, '%'), 0);
      assert.deepEqual(listConversationsPage(f.db, T_A, { q: '_' }), []);
      assert.equal(countConversations(f.db, T_A, '_'), 0);
    } finally {
      f.cleanup();
    }
  });

  it('empty q is unfiltered', () => {
    const f = makeLedger();
    try {
      const { convA, convB, convC } = seedSearchLedger(f);
      const ids = listConversationsPage(f.db, T_A, { q: '' }).map((r) => r.conversation_id);
      assert.equal(ids.length, 3);
      for (const id of [convA, convB, convC]) assert.ok(ids.includes(id));
      assert.equal(countConversations(f.db, T_A, ''), 3);
    } finally {
      f.cleanup();
    }
  });

  it('filtered total is the filtered count, not the tenant count', () => {
    const f = makeLedger();
    try {
      const { convA } = seedSearchLedger(f);
      // 'the' matches convA ('file THE quarterly report') + convB ('at THE
      // embassy') — convC's 'buy groceries' has none.
      assert.equal(countConversations(f.db, T_A, 'the'), 2);
      const page = listConversationsPage(f.db, T_A, { q: 'the', limit: 1, offset: 0 });
      assert.equal(page.length, 1);
      assert.equal(countConversations(f.db, T_A, 'the'), 2); // count ignores limit
      // Substring pin: 'repo' lands INSIDE 'report' — proves likeTerm's %
      // wrap makes a contains-match; an exact-match LIKE returns [].
      assert.deepEqual(
        listConversationsPage(f.db, T_A, { q: 'repo' }).map((r) => r.conversation_id),
        [convA]
      );
      assert.equal(countConversations(f.db, T_A, 'repo'), 1);
    } finally {
      f.cleanup();
    }
  });

  it('offset + q page the filtered set', () => {
    const f = makeLedger();
    try {
      const { convA, convB } = seedSearchLedger(f);
      // Order is MAX(updated_at) DESC: convB (transitioned to done after
      // convA's creation) is the FIRST 'the' match, convA the second.
      const page1 = listConversationsPage(f.db, T_A, { q: 'the', limit: 1, offset: 0 });
      const page2 = listConversationsPage(f.db, T_A, { q: 'the', limit: 1, offset: 1 });
      assert.equal(page1.length, 1);
      assert.equal(page2.length, 1);
      assert.equal(page1[0].conversation_id, convB);
      assert.equal(page2[0].conversation_id, convA);
      assert.equal(countConversations(f.db, T_A, 'the'), 2); // page and count agree
    } finally {
      f.cleanup();
    }
  });

  it('q is tenant-scoped', () => {
    const f = makeLedger();
    try {
      seedSearchLedger(f);
      assert.deepEqual(listConversationsPage(f.db, T_B, { q: 'report' }), []);
      assert.equal(countConversations(f.db, T_B, 'report'), 0);
    } finally {
      f.cleanup();
    }
  });
});

describe('GET /conversations offset + total (vi-19787afc4b2e)', () => {
  /** Seed `n` distinct single-task conversations on the router fixture's
   * tenant, staggered by sleepMs(2) so newest-first order is deterministic. */
  function seedConversations(fx: RouterFixture, tenantId: string, n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      if (i > 0) sleepMs(2);
      ids.push(createTask(fx.db, tenantId, { source: 'text', requestText: `conv ${i}` }).task_id);
    }
    return ids;
  }

  it('returns total with the default list', async () => {
    const fx = makeRouterFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890);
      seedConversations(fx, 't-424242', 3);
      const res = await fx.handle(makeReq('GET', '/api/v1/conversations?limit=5', auth));
      assert.equal(res.status, 200);
      const body = res.body as { ok: boolean; conversations: unknown[]; total: number };
      assert.equal(body.ok, true);
      assert.equal(body.total, 3);
      assert.ok(Array.isArray(body.conversations));
      assert.equal(body.conversations.length, 3);
    } finally {
      fx.cleanup();
    }
  });

  it('offset pages the route and offset=0 matches the absent-offset path', async () => {
    const fx = makeRouterFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890);
      seedConversations(fx, 't-424242', 8);
      const absent = await fx.handle(makeReq('GET', '/api/v1/conversations?limit=5', auth));
      const off0 = await fx.handle(makeReq('GET', '/api/v1/conversations?limit=5&offset=0', auth));
      const off5 = await fx.handle(makeReq('GET', '/api/v1/conversations?limit=5&offset=5', auth));
      assert.equal(absent.status, 200);
      assert.equal(off0.status, 200);
      assert.equal(off5.status, 200);
      const absentBody = absent.body as { conversations: unknown[]; total: number };
      const off0Body = off0.body as { conversations: unknown[]; total: number };
      const off5Body = off5.body as { conversations: unknown[]; total: number };
      assert.deepEqual(off0Body.conversations, absentBody.conversations);
      assert.equal(off0Body.total, 8);
      assert.equal(off5Body.total, 8);
      assert.equal(off5Body.conversations.length, 3); // the remaining 3
      // The two pages do not overlap and together cover all 8.
      const firstIds = new Set((absentBody.conversations as Array<Record<string, unknown>>).map((c) => c.conversation_id));
      for (const row of off5Body.conversations as Array<Record<string, unknown>>) {
        assert.ok(!firstIds.has(row.conversation_id));
      }
      assert.equal(firstIds.size + off5Body.conversations.length, 8);
    } finally {
      fx.cleanup();
    }
  });

  it('invalid offset is 400 with the exact error body', async () => {
    const fx = makeRouterFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890);
      for (const bad of ['offset=-1', 'offset=abc', 'offset=1.5']) {
        const res = await fx.handle(makeReq('GET', `/api/v1/conversations?${bad}`, auth));
        assert.equal(res.status, 400, bad);
        assert.deepEqual(res.body, { ok: false, error: 'offset must be a non-negative integer' }, bad);
      }
    } finally {
      fx.cleanup();
    }
  });

  it('invalid limit still wins its own 400', async () => {
    const fx = makeRouterFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890);
      const res = await fx.handle(makeReq('GET', '/api/v1/conversations?limit=0&offset=2', auth));
      assert.equal(res.status, 400); // validation order: limit first, then offset
      assert.deepEqual(res.body, { ok: false, error: 'limit must be a positive integer' });
    } finally {
      fx.cleanup();
    }
  });

  it('401 without a valid Bearer', async () => {
    const fx = makeRouterFixture();
    try {
      const res = await fx.handle(makeReq('GET', '/api/v1/conversations?offset=0'));
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { ok: false, error: 'unauthorized' });
    } finally {
      fx.cleanup();
    }
  });
});
