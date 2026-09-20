/**
 * Thread endpoints (thread lifecycle, schema v14, 2026-09-17) through the
 * socket-free router against a real ledger in a temp dir: the Recent view
 * (GET /conversations?view=recent), the status fields on the detail and share
 * payloads, and the three thread actions — POST /conversations/:id/viewed,
 * /retry and /cancel — plus the per-task cancel of a failed task.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTask,
  getTask,
  listEvents,
  mintConversationShare,
  openLedger,
  transitionTask,
  upsertTenant,
} from '../ledger.js';
import { createRouter, type ApiRequest, type ApiResponse, type RouteDeps } from '../routes.js';
import type { VoiceInboxConfig } from '../config.js';
import { createSession } from '../identity.js';
import { OFFER_SEGMENT_HEAD } from '../bridge-writer.js';

const TENANT = 't-424242';
const HOUR = 60 * 60 * 1000;
const TOPIC = '-1001234567890_2002';

type Row = Record<string, unknown>;

/** Synchronous delay: Windows' Date resolution can land back-to-back writes on
 *  the same millisecond, and reading order is created_at then random task_id. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface Fixture {
  dir: string;
  db: ReturnType<typeof openLedger>;
  deps: RouteDeps;
  handle: ReturnType<typeof createRouter>;
  auth: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-thread-endpoints-'));
  const db = openLedger(join(dir, 'ledger.sqlite'));
  writeFileSync(
    join(dir, 'telegram-topic-names.json'),
    JSON.stringify({ '-1001234567890': { '2002': { name: 'Errands' } } }),
    'utf8'
  );
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
  const tenant = upsertTenant(db, { telegramUserId: 424242, telegramChatId: -1001234567890, displayName: 'Op' });
  const { token } = createSession(db, tenant.tenant_id, 168);
  return {
    dir,
    db,
    deps,
    handle: createRouter(deps),
    auth: `Bearer ${token}`,
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

function req(fx: Fixture, method: string, path: string, body?: unknown, auth: string | null = fx.auth): ApiRequest {
  const url = new URL(path, 'http://127.0.0.1');
  const headers: Record<string, string | string[] | undefined> = {};
  if (auth !== null) headers['authorization'] = auth;
  let buf = Buffer.alloc(0);
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    buf = Buffer.from(JSON.stringify(body), 'utf8');
  }
  return { method, pathname: url.pathname, query: url.searchParams, headers, body: buf };
}

function queueLines(fx: Fixture): Row[] {
  if (!existsSync(fx.deps.routeQueuePath)) return [];
  return readFileSync(fx.deps.routeQueuePath, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Row);
}

/** Shift one task's row and event timestamps `ms` into the past. */
function backdate(fx: Fixture, taskId: string, ms: number): void {
  const shift = (iso: string): string => new Date(Date.parse(iso) - ms).toISOString();
  const row = fx.db.prepare('SELECT created_at, updated_at FROM tasks WHERE task_id = ?').get(taskId) as {
    created_at: string;
    updated_at: string;
  };
  fx.db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE task_id = ?')
    .run(shift(row.created_at), shift(row.updated_at), taskId);
  const events = fx.db.prepare('SELECT event_id, ts FROM events WHERE task_id = ?').all(taskId) as Array<{
    event_id: number;
    ts: string;
  }>;
  for (const e of events) fx.db.prepare('UPDATE events SET ts = ? WHERE event_id = ?').run(shift(e.ts), e.event_id);
}

function doneTask(fx: Fixture, text: string, conversationId?: string): string {
  const task = createTask(fx.db, TENANT, { source: 'text', requestText: text, ...(conversationId ? { conversationId } : {}) });
  transitionTask(fx.db, TENANT, task.task_id, 'routed', { eventKind: 'task.routed', routedTo: TOPIC });
  transitionTask(fx.db, TENANT, task.task_id, 'running', { eventKind: 'task.progress' });
  transitionTask(fx.db, TENANT, task.task_id, 'done', { eventKind: 'task.completed', resultSummary: `answer to ${text}` });
  return task.task_id;
}

function failedTask(fx: Fixture, text: string, conversationId?: string): string {
  const task = createTask(fx.db, TENANT, { source: 'text', requestText: text, ...(conversationId ? { conversationId } : {}) });
  transitionTask(fx.db, TENANT, task.task_id, 'failed', { eventKind: 'task.failed', eventPayload: { reason: 'worker crashed' } });
  return task.task_id;
}

function voiceTask(fx: Fixture, withAudio: boolean): string {
  const task = createTask(fx.db, TENANT, { source: 'voice', requestText: '(voice recording)', initialState: 'transcribing' });
  if (withAudio) {
    mkdirSync(join(fx.deps.filesDir, task.task_id), { recursive: true });
    writeFileSync(join(fx.deps.filesDir, task.task_id, 'audio.webm'), Buffer.alloc(16000, 7));
  }
  return task.task_id;
}

async function detail(fx: Fixture, conversationId: string): Promise<Row> {
  const res = await fx.handle(req(fx, 'GET', `/api/v1/conversations/${conversationId}`));
  assert.equal(res.status, 200);
  return (res.body as { conversation: Row }).conversation;
}

const listRows = (res: ApiResponse): Row[] => (res.body as { conversations: Row[] }).conversations;

describe('GET /conversations?view=recent (v14)', () => {
  it('returns only live and history threads, sorted by status rank then newest update, with no row cap', async () => {
    const fx = makeFixture();
    try {
      const oldViewed = doneTask(fx, 'an old answer already seen');
      backdate(fx, oldViewed, 72 * HOUR);
      fx.db.prepare('INSERT INTO conversation_meta (conversation_id, tenant_id, updated_at, viewed_at) VALUES (?, ?, ?, ?)')
        .run(oldViewed, TENANT, new Date().toISOString(), new Date(Date.now() - 70 * HOUR).toISOString());
      const oldReady = doneTask(fx, 'an old answer never opened');
      backdate(fx, oldReady, 72 * HOUR);
      const running = createTask(fx.db, TENANT, { source: 'text', requestText: 'still working' });
      transitionTask(fx.db, TENANT, running.task_id, 'routed', { eventKind: 'task.routed', routedTo: TOPIC });
      transitionTask(fx.db, TENANT, running.task_id, 'running', { eventKind: 'task.progress' });
      const failed = failedTask(fx, 'this one broke');
      for (let i = 0; i < 101; i++) createTask(fx.db, TENANT, { source: 'text', requestText: `queued ${i}` });

      const res = await fx.handle(req(fx, 'GET', '/api/v1/conversations?view=recent&limit=1'));
      assert.equal(res.status, 200);
      const rows = listRows(res);
      const ids = rows.map((r) => r.conversation_id);
      assert.equal(ids.includes(oldViewed), false, 'a viewed thread past 24 hours belongs to Older conversations');
      assert.equal(rows.length, 101 + 3, 'no row cap: limit=1 is ignored');
      assert.deepEqual(ids.slice(-3), [oldReady, failed, running.task_id]);
      assert.deepEqual(rows.slice(-3).map((r) => r.status), ['ready', 'failed', 'running']);
      assert.ok(rows.slice(0, 101).every((r) => r.status === 'recorded' && r.band === 'live'));
      assert.equal((res.body as { total: number }).total, 105);
    } finally {
      fx.cleanup();
    }
  });

  it('rejects q or offset alongside view=recent, and any other view value', async () => {
    const fx = makeFixture();
    try {
      for (const path of ['/api/v1/conversations?view=recent&q=x', '/api/v1/conversations?view=recent&offset=0']) {
        const res = await fx.handle(req(fx, 'GET', path));
        assert.equal(res.status, 400, path);
        assert.deepEqual(res.body, { ok: false, error: 'view=recent takes no q or offset' });
      }
      const other = await fx.handle(req(fx, 'GET', '/api/v1/conversations?view=older'));
      assert.equal(other.status, 400);
      assert.deepEqual(other.body, { ok: false, error: 'view must be "recent" when present' });
    } finally {
      fx.cleanup();
    }
  });
});

describe('GET /conversations/:id and the share view (v14)', () => {
  it('the detail summary carries the status fields and every task carries retried_by', async () => {
    const fx = makeFixture();
    try {
      const root = failedTask(fx, 'broke');
      const before = await detail(fx, root);
      assert.equal(before.status, 'failed');
      assert.equal(before.band, 'live');
      assert.equal(before.failed_unresolved, 1);
      assert.equal(before.viewed_at, null);
      assert.equal(before.answer_landed_at, null);
      sleepMs(5);
      const retry = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${root}/retry`, {}));
      const newId = (retry.body as { retried: Row[] }).retried[0].new_task_id as string;
      const after = await detail(fx, root);
      assert.equal(after.status, 'recorded');
      assert.equal(after.failed_unresolved, 0);
      const tasks = after.tasks as Row[];
      assert.deepEqual(tasks.map((t) => t.task_id), [root, newId]);
      assert.equal(tasks[0].retried_by, newId);
      assert.equal(tasks[1].retried_by, null);
    } finally {
      fx.cleanup();
    }
  });

  it('the public share view carries no view time and no status fields', async () => {
    const fx = makeFixture();
    try {
      const id = doneTask(fx, 'share me');
      const viewed = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${id}/viewed`, {}));
      assert.equal((viewed.body as { changed: boolean }).changed, true);
      const share = mintConversationShare(fx.db, TENANT, id);
      const res = await fx.handle(req(fx, 'GET', `/api/v1/share/${share.token}`, undefined, null));
      assert.equal(res.status, 200);
      const summary = (res.body as { conversation: { summary: Row } }).conversation.summary;
      for (const key of ['viewed_at', 'status', 'status_rank', 'band', 'answer_landed_at', 'failed_unresolved']) {
        assert.equal(key in summary, false, key);
      }
      assert.equal(summary.state, 'done');
    } finally {
      fx.cleanup();
    }
  });
});

describe('POST /conversations/:id/viewed (v14)', () => {
  it('writes the view once per answer and reports whether it changed', async () => {
    const fx = makeFixture();
    try {
      const id = doneTask(fx, 'the first answer');
      const first = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${id}/viewed`, {}));
      assert.equal(first.status, 200);
      const b1 = first.body as { ok: boolean; changed: boolean; viewed_at: string };
      assert.equal(b1.ok, true);
      assert.equal(b1.changed, true);
      const again = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${id}/viewed`, {}));
      assert.deepEqual(again.body, { ok: true, changed: false, viewed_at: b1.viewed_at });
      assert.equal((await detail(fx, id)).status, 'viewed');
      sleepMs(5);
      doneTask(fx, 'a second answer', id);
      assert.equal((await detail(fx, id)).status, 'ready');
      const third = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${id}/viewed`));
      const b3 = third.body as { changed: boolean; viewed_at: string };
      assert.equal(b3.changed, true);
      assert.ok(b3.viewed_at > b1.viewed_at, `${b3.viewed_at} > ${b1.viewed_at}`);
    } finally {
      fx.cleanup();
    }
  });

  it('honours at only when the thread has no view time, and clamps a future at to now', async () => {
    const fx = makeFixture();
    try {
      const id = doneTask(fx, 'answered');
      backdate(fx, id, HOUR);
      const landed = listEvents(fx.db, TENANT, id).find((e) => e.kind === 'task.completed')?.ts as string;
      const markAt = new Date(Date.parse(landed) + 1000).toISOString();
      const first = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${id}/viewed`, { at: markAt }));
      assert.deepEqual(first.body, { ok: true, changed: true, viewed_at: markAt });
      const ignored = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${id}/viewed`, { at: '2020-01-01T00:00:00.000Z' }));
      assert.deepEqual(ignored.body, { ok: true, changed: false, viewed_at: markAt });
      const stale = doneTask(fx, 'answered too');
      const staleRes = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${stale}/viewed`, { at: '2020-01-01T00:00:00.000Z' }));
      assert.deepEqual(staleRes.body, { ok: true, changed: true, viewed_at: '2020-01-01T00:00:00.000Z' });
      assert.equal((await detail(fx, stale)).status, 'ready', 'a mark older than the answer leaves it Ready');
      const future = doneTask(fx, 'answered with a clock skew');
      const futureRes = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${future}/viewed`, { at: '2999-01-01T00:00:00.000Z' }));
      const viewedAt = (futureRes.body as { viewed_at: string }).viewed_at;
      assert.ok(viewedAt <= new Date().toISOString(), viewedAt);
    } finally {
      fx.cleanup();
    }
  });

  it('rejects a malformed at, 404s another tenant, 405s a GET, and writes nothing for a thread with no answer', async () => {
    const fx = makeFixture();
    try {
      const id = doneTask(fx, 'x');
      const bad = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${id}/viewed`, { at: 'not a date' }));
      assert.equal(bad.status, 400);
      assert.deepEqual(bad.body, { ok: false, error: 'at must be an ISO-8601 timestamp' });
      const stranger = upsertTenant(fx.db, { telegramUserId: 777, telegramChatId: -100777, displayName: 'B' });
      const { token } = createSession(fx.db, stranger.tenant_id, 168);
      const cross = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${id}/viewed`, {}, `Bearer ${token}`));
      assert.equal(cross.status, 404);
      const get = await fx.handle(req(fx, 'GET', `/api/v1/conversations/${id}/viewed`));
      assert.equal(get.status, 405);
      const open = createTask(fx.db, TENANT, { source: 'text', requestText: 'no answer yet' });
      const none = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${open.task_id}/viewed`, {}));
      assert.deepEqual(none.body, { ok: true, changed: false, viewed_at: null });
    } finally {
      fx.cleanup();
    }
  });
});

describe('cross-tenant 404s (v14)', () => {
  it('retry, cancel and detail 404 another tenant and leave the owner\'s tasks untouched', async () => {
    const fx = makeFixture();
    try {
      const root = failedTask(fx, 'broke');
      const stranger = upsertTenant(fx.db, { telegramUserId: 777, telegramChatId: -100777, displayName: 'B' });
      const { token } = createSession(fx.db, stranger.tenant_id, 168);
      const auth = `Bearer ${token}`;
      const detailRes = await fx.handle(req(fx, 'GET', `/api/v1/conversations/${root}`, undefined, auth));
      assert.equal(detailRes.status, 404);
      assert.deepEqual(detailRes.body, { ok: false, error: 'not found' });
      const retryRes = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${root}/retry`, {}, auth));
      assert.equal(retryRes.status, 404);
      assert.deepEqual(retryRes.body, { ok: false, error: 'not found' });
      const cancelRes = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${root}/cancel`, {}, auth));
      assert.equal(cancelRes.status, 404);
      assert.deepEqual(cancelRes.body, { ok: false, error: 'not found' });
      const task = getTask(fx.db, TENANT, root);
      assert.equal(task?.state, 'failed');
      assert.equal(task?.retried_by, null);
    } finally {
      fx.cleanup();
    }
  });
});

describe('POST /conversations/:id/retry (v14)', () => {
  it('creates one retry per unresolved failure in send order and queues each through the create pipeline', async () => {
    const fx = makeFixture();
    try {
      const root = failedTask(fx, 'first request');
      sleepMs(5);
      const second = failedTask(fx, 'second request', root);
      sleepMs(5);
      const res = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${root}/retry`, {}));
      assert.equal(res.status, 200);
      const retried = (res.body as { retried: Row[] }).retried;
      assert.deepEqual(retried.map((r) => r.task_id), [root, second]);
      for (const r of retried) {
        assert.equal(r.outcome, 'retried');
        assert.equal(r.state, 'received');
        assert.equal(r.queued, true);
      }
      const newIds = retried.map((r) => r.new_task_id as string);
      assert.equal(getTask(fx.db, TENANT, newIds[0])?.request_text, 'first request');
      assert.equal(getTask(fx.db, TENANT, newIds[1])?.request_text, 'second request');
      assert.equal(getTask(fx.db, TENANT, newIds[0])?.conversation_id, root);
      assert.equal(getTask(fx.db, TENANT, root)?.retried_by, newIds[0]);
      assert.equal(getTask(fx.db, TENANT, second)?.retried_by, newIds[1]);
      assert.equal(getTask(fx.db, TENANT, root)?.state, 'failed');
      assert.equal(JSON.parse(listEvents(fx.db, TENANT, newIds[0])[0].payload_json).retry_of, root);
      const lines = queueLines(fx);
      assert.deepEqual(lines.map((l) => l.task_id), newIds);
      const text = lines[0].text as string;
      assert.ok(text.includes(`This task continues conversation ${root} — pass --continues ${root} to route_task.py. `), text);
      assert.equal(text.includes(OFFER_SEGMENT_HEAD), false, text);
      assert.equal((await detail(fx, root)).failed_unresolved, 0);
    } finally {
      fx.cleanup();
    }
  });

  it('re-runs transcription for a transcribe_failed recording: a new transcribing task, the audio and attachments copied, the voice inbox entry queued', async () => {
    const fx = makeFixture();
    try {
      const voice = voiceTask(fx, true);
      writeFileSync(join(fx.deps.filesDir, voice, 'photo.png'), Buffer.from('png'));
      writeFileSync(join(fx.deps.filesDir, voice, 'blocker-shot.png'), Buffer.from('shot'));
      transitionTask(fx.db, TENANT, voice, 'transcribe_failed', {
        eventKind: 'task.failed',
        eventPayload: { reason: 'transcription failed', code: 'infra' },
      });
      const res = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${voice}/retry`, {}));
      assert.equal(res.status, 200);
      const [r] = (res.body as { retried: Row[] }).retried;
      assert.equal(r.outcome, 'retried');
      assert.equal(r.state, 'transcribing');
      assert.equal(r.queued, true);
      const newId = r.new_task_id as string;
      const task = getTask(fx.db, TENANT, newId);
      assert.equal(task?.state, 'transcribing');
      assert.equal(task?.source, 'voice');
      assert.equal(task?.request_text, '(voice recording)');
      assert.deepEqual(readdirSync(join(fx.deps.filesDir, newId)).sort(), ['audio.webm', 'photo.png']);
      const text = queueLines(fx)[0].text as string;
      assert.ok(
        text.includes(`A voice recording is saved at ${join(fx.deps.filesDir, newId, 'audio.webm').replace(/\\/g, '/')}. `),
        text
      );
    } finally {
      fx.cleanup();
    }
  });

  it('is 409 when nothing is unresolved, skips a transcribe_failed task with no recording, and never retries too_short', async () => {
    const fx = makeFixture();
    try {
      const done = doneTask(fx, 'fine');
      const nothing = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${done}/retry`, {}));
      assert.equal(nothing.status, 409);
      assert.deepEqual(nothing.body, { ok: false, error: 'nothing to retry' });
      const tooShort = voiceTask(fx, true);
      transitionTask(fx.db, TENANT, tooShort, 'transcribe_failed', {
        eventKind: 'task.failed',
        eventPayload: { reason: 'too short', code: 'too_short' },
      });
      assert.equal((await fx.handle(req(fx, 'POST', `/api/v1/conversations/${tooShort}/retry`, {}))).status, 409);
      const lost = voiceTask(fx, false);
      transitionTask(fx.db, TENANT, lost, 'transcribe_failed', {
        eventKind: 'task.failed',
        eventPayload: { reason: 'audio storage failed' },
      });
      const skipped = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${lost}/retry`, {}));
      assert.equal(skipped.status, 200);
      assert.deepEqual((skipped.body as { retried: Row[] }).retried, [
        { task_id: lost, outcome: 'skipped', reason: 'no recording on file' },
      ]);
      assert.equal(getTask(fx.db, TENANT, lost)?.retried_by, null);
      assert.equal((await fx.handle(req(fx, 'POST', '/api/v1/conversations/vi-000000000000/retry', {}))).status, 404);
    } finally {
      fx.cleanup();
    }
  });
});

describe('POST /conversations/:id/cancel (v14)', () => {
  it('cancels live tasks and unresolved failures, requests a stop only for a live worker, and is idempotent', async () => {
    const fx = makeFixture();
    try {
      const root = failedTask(fx, 'broke');
      sleepMs(5);
      const live = createTask(fx.db, TENANT, { source: 'text', requestText: 'working on it', conversationId: root });
      transitionTask(fx.db, TENANT, live.task_id, 'routed', { eventKind: 'task.routed', routedTo: TOPIC });
      transitionTask(fx.db, TENANT, live.task_id, 'running', { eventKind: 'task.progress' });
      fx.db.prepare('UPDATE tasks SET worker_resource = ?, worker_dispatch_id = ? WHERE task_id = ?')
        .run('topic--1001234567890_2002', 'a1b2c3d4e5f6', live.task_id);
      sleepMs(5);
      const answered = doneTask(fx, 'already answered', root);
      const res = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${root}/cancel`, {}));
      assert.equal(res.status, 200);
      assert.deepEqual((res.body as { tasks: Row[] }).tasks, [
        { task_id: root, outcome: 'cancelled', stop_requested: false },
        { task_id: live.task_id, outcome: 'cancelled', stop_requested: true },
      ]);
      assert.equal(getTask(fx.db, TENANT, root)?.state, 'cancelled');
      assert.equal(getTask(fx.db, TENANT, live.task_id)?.state, 'cancelled');
      assert.equal(getTask(fx.db, TENANT, answered)?.state, 'done');
      const cancels = queueLines(fx).filter((l) => l.kind === 'cancel');
      assert.equal(cancels.length, 1);
      assert.equal(cancels[0].task_id, live.task_id);
      assert.equal(cancels[0].worker_resource, 'topic--1001234567890_2002');
      assert.equal(cancels[0].worker_dispatch_id, 'a1b2c3d4e5f6');
      const again = await fx.handle(req(fx, 'POST', `/api/v1/conversations/${root}/cancel`, {}));
      assert.deepEqual(again.body, { ok: true, tasks: [] });
    } finally {
      fx.cleanup();
    }
  });

  it('POST /tasks/:id/cancel now dismisses a failed task', async () => {
    const fx = makeFixture();
    try {
      const id = failedTask(fx, 'broke');
      const res = await fx.handle(req(fx, 'POST', `/api/v1/tasks/${id}/cancel`));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, state: 'cancelled', stop_requested: false });
      const cancelled = listEvents(fx.db, TENANT, id).filter((e) => e.kind === 'task.cancelled');
      assert.equal(cancelled.length, 1);
      assert.deepEqual(JSON.parse(cancelled[0].payload_json), { by: 'operator' });
    } finally {
      fx.cleanup();
    }
  });

  it('a Failed thread reads Cancelled after the thread cancel, and a retried failure stops counting as Failed', async () => {
    const fx = makeFixture();
    try {
      const a = failedTask(fx, 'broke');
      assert.equal((await detail(fx, a)).status, 'failed');
      await fx.handle(req(fx, 'POST', `/api/v1/conversations/${a}/cancel`, {}));
      const cancelled = await detail(fx, a);
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.band, 'history');
      const b = failedTask(fx, 'broke again');
      await fx.handle(req(fx, 'POST', `/api/v1/conversations/${b}/retry`, {}));
      const retried = await detail(fx, b);
      assert.equal(retried.failed_unresolved, 0);
      assert.equal(retried.status, 'recorded');
    } finally {
      fx.cleanup();
    }
  });
});
