/**
 * API route tests (AI-201 WP-B, §12 row B): the §6 endpoint matrix driven
 * through the socket-free router — pinned bodies (401 unauthorized, answered
 * ack), auth middleware, cross-tenant 404s, the answer-privacy rule, and the
 * route-queue wiring on create/reroute.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouter, type ApiRequest, type RouteDeps } from '../routes.js';
import { ConfigError, loadConfig, type VoiceInboxConfig } from '../config.js';
import type { SystemStatus } from '../system-status.js';
import {
  createInputRequest,
  createTask,
  openLedger,
  setConversationMeta,
  transitionTask,
  upsertTenant,
} from '../ledger.js';
import { createSession } from '../identity.js';
import { OFFER_SEGMENT_HEAD } from '../bridge-writer.js';
import { getSubscriptions } from '../web-push-store.js';

// --- fixtures -----------------------------------------------------------------------

interface Fixture {
  dir: string;
  db: ReturnType<typeof openLedger>;
  config: VoiceInboxConfig;
  deps: RouteDeps;
  handle: ReturnType<typeof createRouter>;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-routes-'));
  const db = openLedger(join(dir, 'ledger.sqlite'));
  writeFileSync(
    join(dir, 'telegram-topic-names.json'),
    JSON.stringify({
      '-1001234567890': {
        0: { name: 'General', description: '' },
        1040: { name: 'Inbox', description: '' },
        2002: { name: 'Errands', description: '' },
      },
    }),
    'utf8'
  );
  // No cap knobs set (2026-09-13): the whole suite runs default-unlimited —
  // only tests that set a knob on fx.config exercise enforcement.
  const config: VoiceInboxConfig = {
    port: 8787,
    inboxTopic: '-1001234567890_1040',
    sessionTtlHours: 168,
    pairingTtlMinutes: 10,
    minAudioBytes: 8192,
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
    pushStorageDir: join(dir, 'push-storage'),
  };
  return {
    dir,
    db,
    config,
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

/** Seed a tenant + session directly; returns a Bearer auth header. */
function seedSession(fx: Fixture, telegramUserId: number, chatId: number, name: string): string {
  const tenant = upsertTenant(fx.db, {
    telegramUserId,
    telegramChatId: chatId,
    displayName: name,
  });
  const { token } = createSession(fx.db, tenant.tenant_id, 168);
  return `Bearer ${token}`;
}

/** Synchronous delay — same helper conversations.test.ts carries: Windows'
 * Date resolution can land two back-to-back ledger writes on the same
 * millisecond, making updated_at ordering assertions flaky. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface ReqOptions {
  auth?: string;
  json?: unknown;
  body?: Buffer;
  contentType?: string;
  remoteAddress?: string;
}

function makeReq(fx: Fixture, method: string, path: string, opts: ReqOptions = {}): ApiRequest {
  const url = new URL(path, 'http://127.0.0.1');
  const headers: Record<string, string | string[] | undefined> = {};
  if (opts.auth) headers['authorization'] = opts.auth;
  let body = opts.body;
  if (opts.json !== undefined) {
    body = Buffer.from(JSON.stringify(opts.json), 'utf8');
    headers['content-type'] = 'application/json';
  }
  if (opts.contentType) headers['content-type'] = opts.contentType;
  return {
    method,
    pathname: url.pathname,
    query: url.searchParams,
    headers,
    body: body ?? Buffer.alloc(0),
    remoteAddress: opts.remoteAddress ?? '203.0.113.9',
  };
}

function multipartBody(parts: Array<{ name: string; filename?: string; data: string | Buffer }>): {
  body: Buffer;
  contentType: string;
} {
  const boundary = 'testboundary7351';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${part.name}"` +
      (part.filename ? `; filename="${part.filename}"` : '') +
      `\r\n` +
      (part.filename ? `Content-Type: application/octet-stream\r\n` : '') +
      `\r\n`;
    chunks.push(Buffer.from(head, 'utf8'));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function routeQueueLines(fx: Fixture): Array<Record<string, unknown>> {
  try {
    return readFileSync(fx.deps.routeQueuePath, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** An audio payload safely over the fixture's minAudioBytes floor (8192) —
 * every test that doesn't specifically exercise the AI-223 byte floor uses
 * this so the floor doesn't silently reject them. */
const AMPLE_AUDIO = Buffer.alloc(8200, 0x41); // 8200 'A' bytes

/** POST one multipart voice task; returns its task_id (state transcribing). */
async function createVoiceTask(fx: Fixture, auth: string, filename = 'clip.webm'): Promise<string> {
  const { body, contentType } = multipartBody([
    { name: 'audio', filename, data: AMPLE_AUDIO },
  ]);
  const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
  assert.equal(res.status, 200);
  return (res.body as { task_id: string }).task_id;
}

/** Every task row currently in the ledger (direct read) — used to prove a
 * rejected create left NO row behind. */
function fetchAllTasks(fx: Fixture): unknown[] {
  return fx.db.prepare('SELECT task_id FROM tasks').all();
}

/** The newest task.failed event's payload for a task (direct ledger read). */
function failedEventPayload(fx: Fixture, taskId: string): Record<string, unknown> {
  const row = fx.db
    .prepare("SELECT payload_json FROM events WHERE task_id = ? AND kind = 'task.failed' ORDER BY event_id DESC")
    .get(taskId) as { payload_json: string } | undefined;
  assert.ok(row, `no task.failed event for ${taskId}`);
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

/** Move a task received → routed → running (legal path) and create a request. */
function makeRunningTaskWithRequest(
  fx: Fixture,
  tenantId: string,
  request: unknown
): { taskId: string; requestId: string } {
  const task = createTask(fx.db, tenantId, { source: 'text', requestText: 'do a thing' });
  transitionTask(fx.db, tenantId, task.task_id, 'routed', {
    eventKind: 'task.routed',
    routedTo: '-1001234567890_2002',
    routingReason: 'test',
  });
  transitionTask(fx.db, tenantId, task.task_id, 'running', {
    eventKind: 'task.progress',
    eventPayload: { step: 'starting' },
  });
  const created = createInputRequest(fx.db, tenantId, task.task_id, request);
  return { taskId: task.task_id, requestId: created.request.request_id };
}

// --- suites --------------------------------------------------------------------------

describe('health + auth middleware', () => {
  it('GET /health needs no auth and returns the exact body', async () => {
    const fx = makeFixture();
    try {
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/health'));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, service: 'voice-inbox' });
    } finally {
      fx.cleanup();
    }
  });

  it('every non-health endpoint without a valid Bearer is exactly the pinned 401', async () => {
    const fx = makeFixture();
    try {
      for (const req of [
        makeReq(fx, 'GET', '/api/v1/me'),
        makeReq(fx, 'GET', '/api/v1/me', { auth: 'Bearer garbage' }),
        makeReq(fx, 'GET', '/api/v1/tasks', { auth: 'Basic dXNlcg==' }),
        makeReq(fx, 'POST', '/api/v1/tasks', { json: { text: 'hi' } }),
        makeReq(fx, 'GET', '/api/v1/topics'),
      ]) {
        const res = await fx.handle(req);
        assert.equal(res.status, 401, `${req.method} ${req.pathname}`);
        assert.deepEqual(res.body, { ok: false, error: 'unauthorized' });
      }
    } finally {
      fx.cleanup();
    }
  });

  it('unknown api path is a 404, even authenticated', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/zzz', { auth }));
      assert.equal(res.status, 404);
    } finally {
      fx.cleanup();
    }
  });
});

describe('POST /pair/exchange', () => {
  it('exchanges a valid code once and the token authenticates /me', async () => {
    const fx = makeFixture();
    try {
      writeFileSync(
        fx.deps.pairingCodesPath,
        JSON.stringify([
          {
            code: 'ABCD2345',
            telegram_user_id: 424242,
            telegram_chat_id: -1001234567890,
            first_name: 'Operator',
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          },
        ]),
        'utf8'
      );
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/pair/exchange', { json: { code: 'ABCD2345' } }));
      assert.equal(res.status, 200);
      const body = res.body as { ok: boolean; session_token: string; tenant_id: string };
      assert.equal(body.ok, true);
      assert.equal(body.tenant_id, 't-424242');
      assert.match(body.session_token, /^[A-Za-z0-9_-]{40,}$/);

      const me = await fx.handle(makeReq(fx, 'GET', '/api/v1/me', { auth: `Bearer ${body.session_token}` }));
      assert.equal(me.status, 200);
      assert.deepEqual(me.body, { ok: true, tenant_id: 't-424242', display_name: 'Operator' });

      // Replay → rejected.
      const replay = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/pair/exchange', { json: { code: 'ABCD2345' } })
      );
      assert.equal(replay.status, 401);
      assert.deepEqual(replay.body, { ok: false, error: 'code already used' });
    } finally {
      fx.cleanup();
    }
  });

  it('rate-limits the exchange endpoint at 5/min per remote IP', async () => {
    const fx = makeFixture();
    try {
      writeFileSync(
        fx.deps.pairingCodesPath,
        JSON.stringify([
          {
            code: 'VALID123',
            telegram_user_id: 1,
            telegram_chat_id: -1001,
            first_name: null,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          },
        ]),
        'utf8'
      );
      let lastStatus = 0;
      for (let i = 0; i < 5; i++) {
        const res = await fx.handle(
          makeReq(fx, 'POST', '/api/v1/pair/exchange', { json: { code: `WRONG${i}0` }, remoteAddress: '10.0.0.1' })
        );
        lastStatus = res.status;
      }
      assert.equal(lastStatus, 401); // invalid codes are 401, not rate-limited yet
      const sixth = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/pair/exchange', { json: { code: 'VALID123' }, remoteAddress: '10.0.0.1' })
      );
      assert.equal(sixth.status, 429);
      // A different IP is not penalized.
      const otherIp = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/pair/exchange', { json: { code: 'VALID123' }, remoteAddress: '10.0.0.2' })
      );
      assert.equal(otherIp.status, 200);
    } finally {
      fx.cleanup();
    }
  });
});

describe('POST /tasks (text)', () => {
  it('creates a received task and appends the inbox route entry', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'Book the dentist' } })
      );
      assert.equal(res.status, 200);
      const body = res.body as { ok: boolean; task_id: string; state: string };
      assert.equal(body.ok, true);
      assert.equal(body.state, 'received');
      assert.match(body.task_id, /^vi-[0-9a-f]{12}$/);

      const lines = routeQueueLines(fx);
      assert.equal(lines.length, 1);
      const entry = lines[0] as Record<string, unknown>;
      assert.equal(entry.task_id, body.task_id);
      assert.equal(entry.tenant_id, 't-424242');
      assert.equal(entry.chat_id, -1001234567890);
      assert.equal(entry.thread_id, 1040);
      const text = entry.text as string;
      assert.ok(text.includes(`[Voice inbox task ${body.task_id}] Request: Book the dentist.`), text);
      assert.ok(text.includes('Topics: -1001234567890_0=General'), text);
      assert.ok(text.includes('Do not answer the request here'), text);
    } finally {
      fx.cleanup();
    }
  });

  it('rejects invalid text bodies', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const mk = (json: unknown) => makeReq(fx, 'POST', '/api/v1/tasks', { auth, json });
      assert.equal((await fx.handle(mk({}))).status, 400);
      assert.equal((await fx.handle(mk({ text: '' }))).status, 400);
      // The old hardcoded 4000-char ceiling is OPT-IN since vi-39ab14f84f14:
      // with the knob unset a 4001-char text is accepted (the default-unlimited
      // block covers that); arming it here keeps over-long invalid for this test.
      fx.config.maxTextChars = 4000;
      assert.equal((await fx.handle(mk({ text: 'x'.repeat(4001) }))).status, 400);
      fx.config.maxTextChars = undefined;
      assert.equal((await fx.handle(mk({ text: 42 }))).status, 400);
      const badJson = makeReq(fx, 'POST', '/api/v1/tasks', {
        auth,
        body: Buffer.from('{nope', 'utf8'),
        contentType: 'application/json',
      });
      assert.equal((await fx.handle(badJson)).status, 400);
      assert.equal(routeQueueLines(fx).length, 0);
    } finally {
      fx.cleanup();
    }
  });
});

describe('POST /tasks — continues (D2)', () => {
  it("sets conversation_id to the parent's conversation; response gains conversation_id", async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const parent = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'parent request' } })
      );
      const parentBody = parent.body as { task_id: string; conversation_id: string };
      assert.equal(parentBody.conversation_id, parentBody.task_id); // self-rooted

      const followUp = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', {
          auth,
          json: { text: 'and also this', continues: parentBody.task_id },
        })
      );
      assert.equal(followUp.status, 200);
      const body = followUp.body as { ok: boolean; task_id: string; conversation_id: string };
      assert.equal(body.ok, true);
      assert.equal(body.conversation_id, parentBody.task_id);
      assert.notEqual(body.task_id, parentBody.task_id);
    } finally {
      fx.cleanup();
    }
  });

  it('an unknown continues id is a 404', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'x', continues: 'vi-000000000000' } })
      );
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { ok: false, error: 'not found' });
    } finally {
      fx.cleanup();
    }
  });

  it("another tenant's task id as continues is a 404, not leaked as anything more specific", async () => {
    const fx = makeFixture();
    try {
      const authA = seedSession(fx, 424242, -1001234567890, 'Op');
      const authB = seedSession(fx, 777, -100777, 'Other');
      const otherTask = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth: authB, json: { text: 'B only' } })
      );
      const otherTaskId = (otherTask.body as { task_id: string }).task_id;
      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth: authA, json: { text: 'x', continues: otherTaskId } })
      );
      assert.equal(res.status, 404);
    } finally {
      fx.cleanup();
    }
  });

  it('a terminal (cancelled) parent is ALLOWED on the explicit create path (D2)', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const parent = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'will be cancelled' } })
      );
      const parentId = (parent.body as { task_id: string }).task_id;
      const cancel = await fx.handle(makeReq(fx, 'POST', `/api/v1/tasks/${parentId}/cancel`, { auth }));
      assert.equal(cancel.status, 200);

      const followUp = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', {
          auth,
          json: { text: 'still following up', continues: parentId },
        })
      );
      assert.equal(followUp.status, 200);
      assert.equal((followUp.body as { conversation_id: string }).conversation_id, parentId);
    } finally {
      fx.cleanup();
    }
  });
});

describe('POST /tasks — steer (WP-5 §3.2)', () => {
  function setResource(fx: Fixture, taskId: string, resource: string): void {
    fx.db.prepare('UPDATE tasks SET worker_resource = ? WHERE task_id = ?').run(resource, taskId);
  }

  it('records the mode and answers steer_target:"thread" for a -thN resource', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const parent = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'parent' } }));
      const parentId = (parent.body as { task_id: string }).task_id;
      setResource(fx, parentId, 'topic--1001234567890_2002-th1');

      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', {
          auth,
          json: { text: 'course correction', continues: parentId, steer: 'interrupt' },
        })
      );
      assert.equal(res.status, 200);
      const body = res.body as { ok: boolean; steer_mode: string; steer_target: string };
      assert.equal(body.ok, true);
      assert.equal(body.steer_mode, 'interrupt');
      assert.equal(body.steer_target, 'thread');
    } finally {
      fx.cleanup();
    }
  });

  it('answers steer_target:"topic" for a bare topic-<chat>_<thread> resource', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const parent = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'parent' } }));
      const parentId = (parent.body as { task_id: string }).task_id;
      setResource(fx, parentId, 'topic--1001234567890_2002');

      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', {
          auth,
          json: { text: 'also this', continues: parentId, steer: 'queue' },
        })
      );
      const body = res.body as { steer_mode: string; steer_target: string };
      assert.equal(body.steer_mode, 'queue');
      assert.equal(body.steer_target, 'topic');
    } finally {
      fx.cleanup();
    }
  });

  it('answers steer_target:"none" when the conversation has no worker_resource yet', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const parent = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'parent' } }));
      const parentId = (parent.body as { task_id: string }).task_id;

      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', {
          auth,
          json: { text: 'also this', continues: parentId, steer: 'interrupt' },
        })
      );
      const body = res.body as { steer_mode: string; steer_target: string };
      assert.equal(body.steer_mode, 'interrupt');
      assert.equal(body.steer_target, 'none');
    } finally {
      fx.cleanup();
    }
  });

  it('steer without continues is a 400 with the exact string', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'x', steer: 'interrupt' } })
      );
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { ok: false, error: 'steer requires continues' });
    } finally {
      fx.cleanup();
    }
  });

  it('an invalid steer value is a 400 with the exact string', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const parent = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'parent' } }));
      const parentId = (parent.body as { task_id: string }).task_id;
      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'x', continues: parentId, steer: 'loud' } })
      );
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { ok: false, error: 'steer must be "queue" or "interrupt"' });
    } finally {
      fx.cleanup();
    }
  });

  it('a create with no steer carries neither steer_mode nor steer_target', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'plain' } }));
      assert.equal('steer_mode' in (res.body as object), false);
      assert.equal('steer_target' in (res.body as object), false);
    } finally {
      fx.cleanup();
    }
  });
});

describe('POST /tasks — surface (answer presentation P6, 2026-09-16)', () => {
  /** Read a created task back through the PUBLIC shape — this is the
   *  assertion that `publicTask`'s spread-drop still carries `surface`. A
   *  future rewrite of it into an allowlist fails here, which is the only
   *  place that failure would be visible. */
  async function publicSurface(fx: Fixture, auth: string, taskId: string): Promise<unknown> {
    const detail = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${taskId}`, { auth }));
    assert.equal(detail.status, 200);
    const task = (detail.body as { task: Record<string, unknown> }).task;
    assert.ok('surface' in task, 'publicTask must carry surface through to the client');
    return task.surface;
  }

  it('a JSON create stores the hint and hands it back on the public task', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'asked from a laptop', surface: 'desktop' } })
      );
      assert.equal(res.status, 200);
      const taskId = (res.body as { task_id: string }).task_id;
      assert.equal(await publicSurface(fx, auth, taskId), 'desktop');
    } finally {
      fx.cleanup();
    }
  });

  it('a multipart voice create stores the hint from its own part', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'audio', filename: 'clip.webm', data: AMPLE_AUDIO },
        { name: 'surface', data: 'phone' },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 200);
      const taskId = (res.body as { task_id: string }).task_id;
      assert.equal(await publicSurface(fx, auth, taskId), 'phone');
    } finally {
      fx.cleanup();
    }
  });

  it('an omitted hint stores NULL on both body shapes — never a silent "phone" default', async () => {
    // P6 C3. A default would stamp every non-PWA and every stale-shell task
    // with a layout it never asked for, and would make the NULL path — which
    // every pre-v13 row is on — unreachable and so untestable.
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const json = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'an older shell sends nothing' } })
      );
      assert.equal(await publicSurface(fx, auth, (json.body as { task_id: string }).task_id), null);
      const { body, contentType } = multipartBody([
        { name: 'audio', filename: 'clip.webm', data: AMPLE_AUDIO },
      ]);
      const multi = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(await publicSurface(fx, auth, (multi.body as { task_id: string }).task_id), null);
    } finally {
      fx.cleanup();
    }
  });

  it('rejects any other value with the same 400 on both body shapes', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const expected = { ok: false, error: 'surface must be "phone" or "desktop"' };
      for (const value of ['tablet', 'PHONE', 'Desktop', ' phone']) {
        const res = await fx.handle(
          makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'x', surface: value } })
        );
        assert.equal(res.status, 400, `surface ${JSON.stringify(value)} must be rejected`);
        assert.deepEqual(res.body, expected);
      }
      // A non-string is stringified into the SAME allowlist message, not a
      // separate shape message — one field, one error text.
      const numeric = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'x', surface: 680 } })
      );
      assert.equal(numeric.status, 400);
      assert.deepEqual(numeric.body, expected);
      const { body, contentType } = multipartBody([
        { name: 'audio', filename: 'clip.webm', data: AMPLE_AUDIO },
        { name: 'surface', data: 'tablet' },
      ]);
      const multi = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(multi.status, 400);
      assert.deepEqual(multi.body, expected);
    } finally {
      fx.cleanup();
    }
  });

  it('rejects an array surface value (deep-recheck: JSON.parse can hand the field an array)', async () => {
    // `String(['tablet', 'x'])` joins with a comma, so a multi-element array
    // still lands outside the allowlist and 400s through the same path as
    // any other non-string. (A single-element array, e.g. `['phone']`,
    // stringifies to exactly 'phone' and is accepted — the same coercion
    // `steer` already applies a few lines above this block; not a P6-specific
    // gap, and changing it here would diverge from that established field.)
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'x', surface: ['tablet', 'x'] } })
      );
      assert.equal(res.status, 400, 'an array surface value must be rejected');
      assert.deepEqual(res.body, { ok: false, error: 'surface must be "phone" or "desktop"' });
    } finally {
      fx.cleanup();
    }
  });

  it('rejects surface sent as a multipart FILE part, not a value part', async () => {
    // The strayFilePart guard (routes.ts) only recognizes "audio"/"files" as
    // legitimate file parts — a "surface" part carrying a filename is an
    // unexpected file part and 400s there, before the surface allowlist ever
    // runs. Different error text than the allowlist message; still a 400.
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'audio', filename: 'clip.webm', data: AMPLE_AUDIO },
        { name: 'surface', filename: 'surface.txt', data: 'phone' },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 400, 'a surface sent as a file part must be rejected');
      assert.deepEqual(res.body, { ok: false, error: 'unexpected file part "surface"' });
    } finally {
      fx.cleanup();
    }
  });

  it('a rejected surface creates no task row at all', async () => {
    // The allowlist runs BEFORE createTask, so a bad hint must not leave a
    // half-made task behind — the same rule the attachment caps follow.
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const before = (fx.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'x', surface: 'tablet' } })
      );
      assert.equal(res.status, 400);
      const after = (fx.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
      assert.equal(after, before, 'a rejected create must not insert a row');
    } finally {
      fx.cleanup();
    }
  });
});

describe('POST /tasks — feedback_about (2026-09-13)', () => {
  const SURFACE_LINE =
    "This task arrives from the voice-inbox app (our own PWA, fully ours — long-press menus, custom sheets and inline widgets all possible); design UI answers for that surface, not Telegram's Bot-API constraints.";

  /** Create one root task via the API; optionally seed its conversation_meta
   * title. Returns the root id (== the conversation id). */
  async function seedRoot(fx: Fixture, auth: string, title?: string): Promise<string> {
    const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'root request' } }));
    assert.equal(res.status, 200);
    const rootId = (res.body as { task_id: string }).task_id;
    if (title !== undefined) {
      setConversationMeta(fx.db, 't-424242', rootId, { title }, '2026-09-13T00:00:00.000Z');
    }
    return rootId;
  }

  it('text create with feedback_about renders the conversation framing + surface line and suppresses the open-conversations menu', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const rootId = await seedRoot(fx, auth, 'Dentist booking');

      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', {
          auth,
          json: { text: 'the app booked the wrong day', feedback_about: rootId },
        })
      );
      assert.equal(res.status, 200);
      const body = res.body as { ok: boolean; task_id: string };

      const detail = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${body.task_id}`, { auth }));
      const task = (detail.body as { task: Record<string, unknown> }).task;
      assert.equal(task.feedback_about, rootId);

      const lines = routeQueueLines(fx);
      assert.equal(lines.length, 2);
      const entry = lines[lines.length - 1] as Record<string, unknown>;
      assert.equal(entry.task_id, body.task_id);
      const text = entry.text as string;
      assert.ok(
        text.includes(`(operator feedback about voice-inbox conversation ${rootId}, "Dentist booking")`),
        text
      );
      assert.ok(text.includes(SURFACE_LINE), text);
      assert.equal(text.includes(OFFER_SEGMENT_HEAD), false);
    } finally {
      fx.cleanup();
    }
  });

  it('feedback_about naming a mid-conversation task renders the task-level framing', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const rootId = await seedRoot(fx, auth, 'Dentist booking');
      const child = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'and also this', continues: rootId } })
      );
      const childId = (child.body as { task_id: string }).task_id;

      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', {
          auth,
          json: { text: 'this turn was wrong', feedback_about: childId },
        })
      );
      assert.equal(res.status, 200);
      const lines = routeQueueLines(fx);
      const text = (lines[lines.length - 1] as { text: string }).text;
      assert.ok(
        text.includes(`(operator feedback about voice-inbox task ${childId}, "Dentist booking")`),
        text
      );
    } finally {
      fx.cleanup();
    }
  });

  it('no conversation_meta title renders the no-title framing form', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const rootId = await seedRoot(fx, auth);

      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', {
          auth,
          json: { text: 'feedback, untitled target', feedback_about: rootId },
        })
      );
      assert.equal(res.status, 200);
      const lines = routeQueueLines(fx);
      const text = (lines[lines.length - 1] as { text: string }).text;
      assert.ok(text.includes(`(operator feedback about voice-inbox conversation ${rootId})`), text);
    } finally {
      fx.cleanup();
    }
  });

  it('feedback_about validation: bad shape 400, combination with continues 400, unknown id 404 (exact bodies)', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const rootId = await seedRoot(fx, auth);

      const badShape = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'x', feedback_about: 'nope' } })
      );
      assert.equal(badShape.status, 400);
      assert.deepEqual(badShape.body, {
        ok: false,
        error: 'feedback_about must be a "vi-<12 hex>" task or conversation id',
      });

      const combined = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', {
          auth,
          json: { text: 'x', continues: rootId, feedback_about: rootId },
        })
      );
      assert.equal(combined.status, 400);
      assert.deepEqual(combined.body, { ok: false, error: 'feedback_about cannot be combined with continues' });

      const unknown = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', {
          auth,
          json: { text: 'x', feedback_about: 'vi-000000000000' },
        })
      );
      assert.equal(unknown.status, 404);
      assert.deepEqual(unknown.body, { ok: false, error: 'not found' });
    } finally {
      fx.cleanup();
    }
  });

  it('multipart voice create with a feedback_about part renders the framing in the voice inbox entry', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const rootId = await seedRoot(fx, auth);

      const { body, contentType } = multipartBody([
        { name: 'audio', filename: 'clip.webm', data: AMPLE_AUDIO },
        { name: 'feedback_about', data: rootId },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 200);
      const taskId = (res.body as { task_id: string }).task_id;

      const lines = routeQueueLines(fx);
      const text = (lines[lines.length - 1] as { text: string }).text;
      assert.ok(
        text.includes(
          `[Voice inbox task ${taskId}] (operator feedback about voice-inbox conversation ${rootId}) A voice recording is saved at`
        ),
        text
      );
    } finally {
      fx.cleanup();
    }
  });

  it('normal creates (plain and continues) carry the surface line but no operator-feedback framing', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const rootId = await seedRoot(fx, auth);

      const plain = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'plain request' } })
      );
      assert.equal(plain.status, 200);
      const cont = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'a follow-up', continues: rootId } })
      );
      assert.equal(cont.status, 200);

      const lines = routeQueueLines(fx);
      assert.equal(lines.length, 3);
      for (const entry of lines) {
        const text = (entry as { text: string }).text;
        assert.ok(text.includes(SURFACE_LINE), text);
        assert.equal(text.includes('operator feedback'), false, text);
      }
    } finally {
      fx.cleanup();
    }
  });

  it('rerouting a feedback task carries the framing into the target entry', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const rootId = await seedRoot(fx, auth, 'Dentist booking');
      const created = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', {
          auth,
          json: { text: 'feedback to be rerouted', feedback_about: rootId },
        })
      );
      const taskId = (created.body as { task_id: string }).task_id;

      const res = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/reroute`, {
          auth,
          json: { topic: '-1001234567890_2002' },
        })
      );
      assert.equal(res.status, 200);

      const lines = routeQueueLines(fx);
      assert.equal(lines.length, 3);
      const target = lines[lines.length - 1] as Record<string, unknown>;
      assert.equal(target.thread_id, 2002);
      const text = target.text as string;
      assert.ok(
        text.includes(`[Voice task ${taskId} routed from inbox — reason: operator reroute]`),
        text
      );
      assert.ok(
        text.includes(`(operator feedback about voice-inbox conversation ${rootId}, "Dentist booking")`),
        text
      );
      assert.ok(text.includes(SURFACE_LINE), text);
    } finally {
      fx.cleanup();
    }
  });

  it('t-3 (2026-09-18): a continuation turn inherits the root\'s feedback_about, never overrides an explicit one, and GET /conversations/:id exposes it', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const targetId = await seedRoot(fx, auth, 'Dentist booking');
      const root = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'the app booked the wrong day', feedback_about: targetId } })
      );
      const rootId = (root.body as { task_id: string }).task_id;

      // A plain continuation (no client-supplied feedback_about) inherits it.
      const cont = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'still wrong', continues: rootId } })
      );
      assert.equal(cont.status, 200);
      const contId = (cont.body as { task_id: string }).task_id;
      const contDetail = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${contId}`, { auth }));
      assert.equal((contDetail.body as { task: { feedback_about: string } }).task.feedback_about, targetId);
      const contLines = routeQueueLines(fx);
      assert.ok(
        (contLines[contLines.length - 1] as { text: string }).text.includes(
          `(operator feedback about voice-inbox conversation ${targetId}, "Dentist booking")`
        )
      );

      // GET /conversations/:id exposes feedback_about and the resolved target title.
      const detail = await fx.handle(makeReq(fx, 'GET', `/api/v1/conversations/${rootId}`, { auth }));
      const conv = (detail.body as { conversation: Record<string, unknown> }).conversation;
      assert.equal(conv.feedback_about, targetId);
      assert.deepEqual(conv.feedback, { about: targetId, title: 'Dentist booking', level: 'conversation', conversationId: targetId });

      // publicConversationSummary (the list endpoint) carries the same fields.
      const list = await fx.handle(makeReq(fx, 'GET', '/api/v1/conversations', { auth }));
      const rows = (list.body as { conversations: Array<Record<string, unknown>> }).conversations;
      const row = rows.find((r) => r.conversation_id === rootId);
      assert.ok(row);
      assert.equal(row!.feedback_about, targetId);
      assert.deepEqual(row!.feedback, { about: targetId, title: 'Dentist booking', level: 'conversation', conversationId: targetId });
    } finally {
      fx.cleanup();
    }
  });
});

describe('public task shape (§3.1)', () => {
  it('task rows carry conversation_id and never worker_resource', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const created = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'shape check' } })
      );
      const taskId = (created.body as { task_id: string }).task_id;

      const list = await fx.handle(makeReq(fx, 'GET', '/api/v1/tasks', { auth }));
      const listBody = list.body as { tasks: Array<Record<string, unknown>> };
      const listed = listBody.tasks.find((t) => t.task_id === taskId);
      assert.ok(listed);
      assert.equal(listed!.conversation_id, taskId);
      assert.equal('worker_resource' in listed!, false);
      assert.equal('worker_dispatch_id' in listed!, false);
      assert.equal(listed!.steer_mode, null);

      const detail = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${taskId}`, { auth }));
      const task = (detail.body as { task: Record<string, unknown> }).task;
      assert.equal(task.conversation_id, taskId);
      assert.equal('worker_resource' in task, false);
      assert.equal('worker_dispatch_id' in task, false);
      assert.equal(task.steer_mode, null);
    } finally {
      fx.cleanup();
    }
  });
});

describe('POST /tasks (voice)', () => {
  it('rejects multipart without an audio part', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([{ name: 'notaudio', data: 'zzz' }]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 400);
    } finally {
      fx.cleanup();
    }
  });

  it('rejects an audio upload one byte under min_audio_bytes: 400, no task row, no event', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'audio', filename: 'clip.webm', data: Buffer.alloc(fx.config.minAudioBytes! - 1, 0x41) },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { ok: false, error: 'recording too short' });
      assert.deepEqual(fetchAllTasks(fx), []);
      assert.equal(existsSync(fx.deps.filesDir), false);
      assert.deepEqual(routeQueueLines(fx), []);
    } finally {
      fx.cleanup();
    }
  });

  it('accepts an audio upload at exactly min_audio_bytes (the boundary is inclusive)', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'audio', filename: 'clip.webm', data: Buffer.alloc(fx.config.minAudioBytes!, 0x41) },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 200);
      assert.equal((res.body as { state: string }).state, 'transcribing');
      assert.equal(fetchAllTasks(fx).length, 1);
    } finally {
      fx.cleanup();
    }
  });

  it('creates a transcribing voice task, stores the audio, and queues the read-clean-route entry', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'audio', filename: 'recording.webm', data: AMPLE_AUDIO },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 200);
      const resBody = res.body as { ok: boolean; task_id: string; state: string };
      assert.equal(resBody.ok, true);
      assert.equal(resBody.state, 'transcribing');
      assert.match(resBody.task_id, /^vi-[0-9a-f]{12}$/);
      const taskId = resBody.task_id;

      // Row: transcribing, transcript NULL, request_text is the §1.9 literal.
      const row = fx.db
        .prepare('SELECT state, transcript, request_text FROM tasks WHERE task_id = ?')
        .get(taskId) as { state: string; transcript: string | null; request_text: string };
      assert.equal(row.state, 'transcribing');
      assert.equal(row.transcript, null);
      assert.equal(row.request_text, '(voice recording)');

      // Audio stored under files/<task_id>/audio.webm; no tmp- residue.
      const audioPath = join(fx.deps.filesDir, taskId, 'audio.webm');
      assert.equal(existsSync(audioPath), true);
      assert.deepEqual(readFileSync(audioPath), AMPLE_AUDIO);
      assert.deepEqual(readdirSync(fx.deps.filesDir).filter((n) => n.startsWith('tmp-')), []);

      // Queue entry: the §7 8-key shape + the read-clean-route instruction set.
      const lines = routeQueueLines(fx);
      assert.equal(lines.length, 1);
      const entry = lines[0] as Record<string, unknown>;
      assert.deepEqual(Object.keys(entry), [
        'q_id', 'ts', 'task_id', 'tenant_id', 'chat_id', 'thread_id', 'text', 'ref_id',
      ]);
      assert.equal(entry.task_id, taskId);
      assert.equal(entry.tenant_id, 't-424242');
      assert.equal(entry.chat_id, -1001234567890);
      assert.equal(entry.thread_id, 1040);
      const text = entry.text as string;
      const slashAudio = audioPath.replace(/\\/g, '/');
      assert.ok(
        text.includes(`[Voice inbox task ${taskId}] A voice recording is saved at ${slashAudio}.`),
        text
      );
      assert.ok(
        text.includes(`python "/repo/projects/voice-inbox/scripts/task_request.py" show --task ${taskId} `),
        text
      );
      assert.ok(
        text.includes(
          `python "/repo/projects/voice-inbox/scripts/task_request.py" clean --task ${taskId} --text "<cleaned request>"`
        ),
        text
      );
      assert.ok(
        text.includes(
          `python "/repo/projects/voice-inbox/scripts/route_task.py" --task ${taskId} --topic <chatId>_<threadId> --reason "<one line>"`
        ),
        text
      );
    } finally {
      fx.cleanup();
    }
  });

  it('keeps the task transcribing with an infra marker when the route queue append fails (AI-239)', async () => {
    const fx = makeFixture();
    try {
      // Any append onto a DIRECTORY throws cross-platform (EISDIR/EPERM).
      mkdirSync(fx.deps.routeQueuePath, { recursive: true });
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const taskId = await createVoiceTask(fx, auth);

      const row = fx.db.prepare('SELECT state FROM tasks WHERE task_id = ?').get(taskId) as {
        state: string;
      };
      // AI-239: the audio is on disk and the queue write is pure
      // infrastructure — recoverable by the deterministic fallback, so the
      // task stays transcribing with a non-terminal code:'infra' marker
      // instead of going terminally transcribe_failed.
      assert.equal(row.state, 'transcribing');
      assert.deepEqual(failedEventPayload(fx, taskId), {
        reason: 'route queue write failed',
        code: 'infra',
      });

      // The audio itself is intact — only the queue write failed.
      assert.equal(existsSync(join(fx.deps.filesDir, taskId, 'audio.webm')), true);
    } finally {
      fx.cleanup();
    }
  });

  it('moves the task to transcribe_failed when audio storage fails', async () => {
    const fx = makeFixture();
    try {
      // filesDir pointing UNDER a regular file makes the task-dir mkdir throw
      // (ENOTDIR/EEXIST) deterministically on every platform.
      const blocker = join(fx.dir, 'blocker');
      writeFileSync(blocker, 'a file, not a directory', 'utf8');
      fx.deps.filesDir = join(blocker, 'files');
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const taskId = await createVoiceTask(fx, auth);

      const row = fx.db.prepare('SELECT state FROM tasks WHERE task_id = ?').get(taskId) as {
        state: string;
      };
      assert.equal(row.state, 'transcribe_failed');
      assert.deepEqual(failedEventPayload(fx, taskId), { reason: 'audio storage failed' });

      // No queue file was created.
      assert.equal(existsSync(fx.deps.routeQueuePath), false);
      assert.deepEqual(routeQueueLines(fx), []);
    } finally {
      fx.cleanup();
    }
  });

  it('creates text tasks in received as before', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'plain text request' } })
      );
      assert.equal(res.status, 200);
      const resBody = res.body as { ok: boolean; task_id: string; state: string };
      assert.equal(resBody.state, 'received');
      const row = fx.db
        .prepare('SELECT state, transcript, request_text FROM tasks WHERE task_id = ?')
        .get(resBody.task_id) as { state: string; transcript: string | null; request_text: string };
      assert.equal(row.transcript, null);
      assert.equal(row.request_text, 'plain text request');

      // The inbox entry is the plain text one — no transcribe instructions.
      const lines = routeQueueLines(fx);
      assert.equal(lines.length, 1);
      const text = (lines[0] as { text: string }).text;
      assert.ok(text.includes('Request: plain text request.'), text);
      assert.equal(text.includes('transcribe_voice.py'), false);
      assert.equal(text.includes('task_transcribe.py'), false);
    } finally {
      fx.cleanup();
    }
  });

  it('validates the status filter against the enlarged state list', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const ok = await fx.handle(makeReq(fx, 'GET', '/api/v1/tasks?status=transcribing', { auth }));
      assert.equal(ok.status, 200);
      assert.deepEqual((ok.body as { tasks: unknown[] }).tasks, []);
      const bad = await fx.handle(makeReq(fx, 'GET', '/api/v1/tasks?status=bogus', { auth }));
      assert.equal(bad.status, 400);
    } finally {
      fx.cleanup();
    }
  });

  it('cancels a transcribing task', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const taskId = await createVoiceTask(fx, auth);
      const res = await fx.handle(makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/cancel`, { auth }));
      assert.equal(res.status, 200);
      // A transcribing task was never routed — no worker_resource, so stop_requested is false.
      assert.deepEqual(res.body, { ok: true, state: 'cancelled', stop_requested: false });
    } finally {
      fx.cleanup();
    }
  });

  it('rejects rerouting a transcribing task', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const taskId = await createVoiceTask(fx, auth);
      const res = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/reroute`, {
          auth,
          json: { topic: '-1001234567890_2002' },
        })
      );
      // transcribing → routed is not in the transition table (409 illegal-transition).
      assert.equal(res.status, 409);
      const row = fx.db.prepare('SELECT state FROM tasks WHERE task_id = ?').get(taskId) as {
        state: string;
      };
      assert.equal(row.state, 'transcribing');
    } finally {
      fx.cleanup();
    }
  });
});

describe('GET /tasks list', () => {
  it('lists tenant-scoped tasks with filters and clamped limits', async () => {
    const fx = makeFixture();
    try {
      const authA = seedSession(fx, 424242, -1001234567890, 'Op');
      const authB = seedSession(fx, 777, -100777, 'Other');
      for (const text of ['one', 'two', 'three']) {
        await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth: authA, json: { text } }));
      }
      await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth: authB, json: { text: 'b task' } }));

      const all = await fx.handle(makeReq(fx, 'GET', '/api/v1/tasks', { auth: authA }));
      const allBody = all.body as { tasks: Array<Record<string, unknown>> };
      assert.equal(allBody.tasks.length, 3); // B's task is invisible to A

      const limited = await fx.handle(makeReq(fx, 'GET', '/api/v1/tasks?limit=2', { auth: authA }));
      assert.equal((limited.body as { tasks: unknown[] }).tasks.length, 2);

      const filtered = await fx.handle(
        makeReq(fx, 'GET', '/api/v1/tasks?status=received', { auth: authA })
      );
      assert.equal((filtered.body as { tasks: unknown[] }).tasks.length, 3);

      const badStatus = await fx.handle(
        makeReq(fx, 'GET', '/api/v1/tasks?status=bogus', { auth: authA })
      );
      assert.equal(badStatus.status, 400);
      const badLimit = await fx.handle(
        makeReq(fx, 'GET', '/api/v1/tasks?limit=0', { auth: authA })
      );
      assert.equal(badLimit.status, 400);
    } finally {
      fx.cleanup();
    }
  });
});

describe('GET /tasks/:id + events', () => {
  it('embeds events and public input_requests in the detail', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const created = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'detail me' } })
      );
      const taskId = (created.body as { task_id: string }).task_id;
      const detail = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${taskId}`, { auth }));
      assert.equal(detail.status, 200);
      const body = detail.body as { ok: boolean; task: Record<string, unknown> };
      assert.equal(body.ok, true);
      assert.equal(body.task.task_id, taskId);
      const events = body.task.events as Array<Record<string, unknown>>;
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, 'task.received');
      assert.match(events[0].ref_id as string, /^s-[0-9a-f]{12}$/);
      assert.deepEqual(body.task.input_requests, []);
    } finally {
      fx.cleanup();
    }
  });

  it('serves incremental events after a given event_id', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const created = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'poll me' } })
      );
      const taskId = (created.body as { task_id: string }).task_id;
      const detail = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${taskId}`, { auth }));
      const events = (detail.body as { task: { events: Array<{ event_id: number }> } }).task.events;
      const lastId = events[events.length - 1].event_id;

      const incremental = await fx.handle(
        makeReq(fx, 'GET', `/api/v1/tasks/${taskId}/events?after=${lastId}`, { auth })
      );
      assert.equal((incremental.body as { events: unknown[] }).events.length, 0);

      const badAfter = await fx.handle(
        makeReq(fx, 'GET', `/api/v1/tasks/${taskId}/events?after=abc`, { auth })
      );
      assert.equal(badAfter.status, 400);
    } finally {
      fx.cleanup();
    }
  });
});

describe('GET /tasks/:id/audio', () => {
  it('serves the stored recording while still transcribing, by content type', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const taskId = await createVoiceTask(fx, auth, 'clip.webm');

      const row = fx.db.prepare('SELECT state FROM tasks WHERE task_id = ?').get(taskId) as { state: string };
      assert.equal(row.state, 'transcribing');

      const res = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${taskId}/audio`, { auth }));
      assert.equal(res.status, 200);
      assert.equal(res.body, null);
      assert.deepEqual(res.file, {
        path: join(fx.deps.filesDir, taskId, 'audio.webm'),
        contentType: 'audio/webm',
      });
    } finally {
      fx.cleanup();
    }
  });

  it('serves the same recording once transcription has completed', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const taskId = await createVoiceTask(fx, auth, 'clip.m4a');
      transitionTask(fx.db, 't-424242', taskId, 'received', { eventKind: 'task.transcribed' });

      const res = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${taskId}/audio`, { auth }));
      assert.equal(res.status, 200);
      assert.deepEqual(res.file, {
        path: join(fx.deps.filesDir, taskId, 'audio.m4a'),
        contentType: 'audio/mp4',
      });
    } finally {
      fx.cleanup();
    }
  });

  it('404s for a text task (no recording exists)', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const created = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'no audio here' } })
      );
      const taskId = (created.body as { task_id: string }).task_id;

      const res = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${taskId}/audio`, { auth }));
      assert.equal(res.status, 404);
      assert.equal(res.file, undefined);
    } finally {
      fx.cleanup();
    }
  });

  it('404s a voice task whose file is missing on disk (storage failure)', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const taskId = await createVoiceTask(fx, auth);
      rmSync(join(fx.deps.filesDir, taskId), { recursive: true, force: true });

      const res = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${taskId}/audio`, { auth }));
      assert.equal(res.status, 404);
    } finally {
      fx.cleanup();
    }
  });

  it('404s a cross-tenant id, same as any other task route', async () => {
    const fx = makeFixture();
    try {
      const ownerAuth = seedSession(fx, 424242, -1001234567890, 'Owner');
      const taskId = await createVoiceTask(fx, ownerAuth);
      const strangerAuth = seedSession(fx, 999999, -1009999999999, 'Stranger');

      const res = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${taskId}/audio`, { auth: strangerAuth }));
      assert.equal(res.status, 404);
    } finally {
      fx.cleanup();
    }
  });

  it('401s without a bearer token', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const taskId = await createVoiceTask(fx, auth);

      const res = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${taskId}/audio`));
      assert.equal(res.status, 401);
    } finally {
      fx.cleanup();
    }
  });
});

describe('answer submission', () => {
  it('stores the value as a file + pointer, returns the fixed ack, never echoes', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { taskId, requestId } = makeRunningTaskWithRequest(fx, 't-424242', {
        kind: 'secret',
        prompt: 'What is the API key?',
        params: {},
      });
      // Obviously-synthetic fixture literal (2026-09-20 scrub): no token
      // shape — the public CI secret scanner must never flag this file.
      const SECRET = 'test-synthetic-value-123';
      const res = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/inputs/${requestId}`, {
          auth,
          json: { kind: 'secret', value: SECRET },
        })
      );
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, status: 'answered' });

      // Value file exists; the ledger stores only the pointer.
      const pointerPath = join(fx.deps.answersDir, taskId, `${requestId}.txt`);
      assert.equal(readFileSync(pointerPath, 'utf8'), SECRET);
      const row = fx.db
        .prepare('SELECT answer_pointer, status FROM input_requests WHERE request_id = ?')
        .get(requestId) as { answer_pointer: string; status: string };
      assert.equal(row.status, 'answered');
      assert.equal(row.answer_pointer, pointerPath);

      // Detail response never carries the value or its pointer path.
      const detail = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${taskId}`, { auth }));
      const serialized = JSON.stringify(detail.body);
      assert.equal(serialized.includes(SECRET), false);
      assert.equal(serialized.includes(pointerPath), false);
      const request = (detail.body as { task: { input_requests: Array<Record<string, unknown>> } })
        .task.input_requests[0];
      assert.equal(request.status, 'answered');
      assert.ok(typeof request.answered_at === 'string');

      // Second answer is a 409.
      const again = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/inputs/${requestId}`, {
          auth,
          json: { kind: 'secret', value: 'again' },
        })
      );
      assert.equal(again.status, 409);
    } finally {
      fx.cleanup();
    }
  });

  it('choice answers must exactly match an option', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { taskId, requestId } = makeRunningTaskWithRequest(fx, 't-424242', {
        kind: 'choice',
        prompt: 'Pick one',
        params: { options: ['Option A', 'Option B'] },
      });
      const bad = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/inputs/${requestId}`, {
          auth,
          json: { kind: 'choice', value: 'option a' },
        })
      );
      assert.equal(bad.status, 400);
      const good = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/inputs/${requestId}`, {
          auth,
          json: { kind: 'choice', value: 'Option A' },
        })
      );
      assert.equal(good.status, 200);
      assert.deepEqual(good.body, { ok: true, status: 'answered' });
    } finally {
      fx.cleanup();
    }
  });

  it('file answers are multipart uploads honoring accept + max_bytes', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { taskId, requestId } = makeRunningTaskWithRequest(fx, 't-424242', {
        kind: 'file',
        prompt: 'Upload the PDF',
        params: { accept: ['.pdf'], max_bytes: 10 },
      });
      const wrongExt = multipartBody([{ name: 'file', filename: 'notes.txt', data: 'plain text' }]);
      const rejected = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/inputs/${requestId}`, {
          auth,
          body: wrongExt.body,
          contentType: wrongExt.contentType,
        })
      );
      assert.equal(rejected.status, 400);

      const tooBig = multipartBody([{ name: 'file', filename: 'doc.pdf', data: '12345678901' }]);
      const over = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/inputs/${requestId}`, {
          auth,
          body: tooBig.body,
          contentType: tooBig.contentType,
        })
      );
      assert.equal(over.status, 413);

      const okUpload = multipartBody([{ name: 'file', filename: 'doc.pdf', data: 'PDF-bytes' }]);
      const good = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/inputs/${requestId}`, {
          auth,
          body: okUpload.body,
          contentType: okUpload.contentType,
        })
      );
      assert.equal(good.status, 200);
      assert.deepEqual(good.body, { ok: true, status: 'answered' });
      const stored = readFileSync(join(fx.deps.filesDir, taskId, 'doc.pdf'), 'utf8');
      assert.equal(stored, 'PDF-bytes');
    } finally {
      fx.cleanup();
    }
  });

  it('oauth requests accept no user answer', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { taskId, requestId } = makeRunningTaskWithRequest(fx, 't-424242', {
        kind: 'oauth',
        prompt: 'Grant Google access',
        params: { provider: 'google' },
      });
      const res = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/inputs/${requestId}`, {
          auth,
          json: { kind: 'oauth', value: 'x' },
        })
      );
      assert.equal(res.status, 400);
    } finally {
      fx.cleanup();
    }
  });
});

describe('form answers (schema v9)', () => {
  // The real seven-step questionnaire (SPEC § Fixture, vi-6f1d767dd640) —
  // embedded verbatim; tests never read the scratch file.
  const FORM_SEVEN_STEPS = [
    {
      id: 'q1-telegram-copies',
      title: 'Telegram copies — mail brief & oracle',
      decide: 'Whether thread 29 stops receiving the mail brief and oracle copies after the ~2-week dual-run, making the inbox their primary surface.',
      options: [
        { label: 'Retire both after the dual-run', note: 'The inbox card reads better; the fixed transition window keeps a fallback while trust builds.' },
        { label: 'Retire oracle only, keep mail copy', note: 'Thread 29 keeps the mail brief text + PDF.' },
        { label: 'Keep both permanently', note: 'Inbox becomes the reading/archive surface only.' },
      ],
      preselected: 'Retire both after the dual-run',
    },
    {
      id: 'q2-paging',
      title: 'Which deliveries page you',
      decide: 'Which skill deliveries fire a web-push page and which land quietly in the Ready section for review at leisure.',
      options: [
        { label: 'As proposed', note: 'Page: morning brief, Dashami guide, invoice, portfolio, every failure. Quiet: evening brief, oracle, ekadashi pings.' },
        { label: 'Page every briefing', note: 'Oracle and the evening brief page too.' },
        { label: 'Page only failures + invoice', note: 'Everything else lands quietly.' },
      ],
      preselected: 'As proposed',
    },
    {
      id: 'q3-one-conversation',
      title: 'One conversation per run',
      decide: 'Whether each skill run creates its own conversation, or runs merge into one conversation per day.',
      locked: true,
      answer: 'One conversation per run — decided 2026-09-13 via the tap-through widget (task vi-5f499f8cd330).',
    },
    {
      id: 'q4-portfolio-dm',
      title: 'Portfolio DM duplicate',
      decide: "Whether the portfolio report's direct Telegram DM stops once inbox web push is trusted.",
      options: [
        { label: 'Retire the DM once push is trusted', note: 'One paging surface; inbox plus thread 29 cover reading and record.' },
        { label: 'Keep the DM, retire thread-29 copy', note: 'The DM stays the paging surface instead.' },
        { label: 'Keep all three', note: 'DM + thread 29 + inbox all receive it.' },
      ],
      preselected: 'Retire the DM once push is trusted',
    },
    {
      id: 'q5-invoice-widget',
      title: 'Invoice approval as inbox choices (v2)',
      decide: "Whether Hemir invoice approval becomes approve/reject/edit choices on the invoice card, replacing the Telegram 'Send now' queue.",
      options: [
        { label: 'Build it in v2', note: 'A one-tap widget action; removes a surface switch mid-approval.' },
        { label: 'Keep Telegram approval', note: "Approval stays a typed 'Send now' in the PA topic." },
        { label: 'Decide later', note: 'After inbox-primary proves out.' },
      ],
      preselected: 'Build it in v2',
    },
    {
      id: 'q6-watchdog',
      title: 'Expected-deliverable-missing watchdog (v2)',
      decide: 'Whether a daily check notices a cron skill that declared inbox output but delivered nothing — the silent-death case.',
      options: [
        { label: 'Build in v2, all contract skills', note: 'A ledger scan against declared skills is cheap and closes the silent gap.' },
        { label: 'Rely on per-skill watchdogs', note: 'Coverage only where built (ekadashi today).' },
        { label: 'Cover only the daily skills', note: 'Mail brief and oracle only.' },
      ],
      preselected: 'Build in v2, all contract skills',
    },
    {
      id: 'q7-oracle-defect',
      title: 'Oracle double-delivery defect',
      decide: 'Whether the observed oracle double-run of 2026-09-13 gets its own defect task now, separate from this design.',
      options: [
        { label: 'File its own task now', note: 'An observed same-day defect with a clean reproduction window.' },
        { label: 'Fold into the retirement wave', note: 'Fixed when the thread-29 copies retire.' },
        { label: 'Wait for a recurrence', note: 'The 24h duplicate guard covers the inbox door meanwhile.' },
      ],
      preselected: 'File its own task now',
    },
  ];

  /** One answer entry per NON-locked step (its preselected label). */
  const nonLockedAnswers = (): Record<string, string> => {
    const answers: Record<string, string> = {};
    for (const s of FORM_SEVEN_STEPS) {
      if (s.locked !== true) answers[s.id] = s.preselected as string;
    }
    return answers;
  };

  async function postAnswer(
    fx: ReturnType<typeof makeFixture>,
    auth: string,
    taskId: string,
    requestId: string,
    answers: Record<string, string>
  ) {
    return fx.handle(
      makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/inputs/${requestId}`, {
        auth,
        json: { kind: 'form', answers },
      })
    );
  }

  it('stores the canonical JSON incl. the locked answer in the answer file', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { taskId, requestId } = makeRunningTaskWithRequest(fx, 't-424242', {
        kind: 'form',
        prompt: 'Skill outputs in the inbox — the proposal\'s remaining choices.',
        params: { steps: FORM_SEVEN_STEPS },
      });
      const res = await postAnswer(fx, auth, taskId, requestId, {
        ...nonLockedAnswers(),
        'q3-one-conversation': 'HACKED',
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, status: 'answered' });

      const stored = JSON.parse(
        readFileSync(join(fx.deps.answersDir, taskId, `${requestId}.txt`), 'utf8')
      ) as Record<string, string>;
      assert.deepEqual(Object.keys(stored).sort(), FORM_SEVEN_STEPS.map((s) => s.id).sort());
      assert.equal(stored['q3-one-conversation'], FORM_SEVEN_STEPS[2].answer);
      assert.notEqual(stored['q3-one-conversation'], 'HACKED');

      const again = await postAnswer(fx, auth, taskId, requestId, nonLockedAnswers());
      assert.equal(again.status, 409);
    } finally {
      fx.cleanup();
    }
  });

  it('missing step is a 400 naming the id', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { taskId, requestId } = makeRunningTaskWithRequest(fx, 't-424242', {
        kind: 'form',
        prompt: 'Skill outputs in the inbox — the proposal\'s remaining choices.',
        params: { steps: FORM_SEVEN_STEPS },
      });
      const answers = nonLockedAnswers();
      delete answers['q2-paging'];
      const res = await postAnswer(fx, auth, taskId, requestId, answers);
      assert.equal(res.status, 400);
      const body = res.body as { ok: boolean; error?: string };
      assert.equal(body.ok, false);
      assert.ok(body.error?.includes('q2-paging'));
    } finally {
      fx.cleanup();
    }
  });

  it('free-text is accepted per step', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { taskId, requestId } = makeRunningTaskWithRequest(fx, 't-424242', {
        kind: 'form',
        prompt: 'Skill outputs in the inbox — the proposal\'s remaining choices.',
        params: { steps: FORM_SEVEN_STEPS },
      });
      const res = await postAnswer(fx, auth, taskId, requestId, {
        ...nonLockedAnswers(),
        'q7-oracle-defect': 'file it next week instead, after a second occurrence',
      });
      assert.equal(res.status, 200);
      const stored = JSON.parse(
        readFileSync(join(fx.deps.answersDir, taskId, `${requestId}.txt`), 'utf8')
      ) as Record<string, string>;
      assert.equal(stored['q7-oracle-defect'], 'file it next week instead, after a second occurrence');
    } finally {
      fx.cleanup();
    }
  });

  it('unknown answer key is a 400', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { taskId, requestId } = makeRunningTaskWithRequest(fx, 't-424242', {
        kind: 'form',
        prompt: 'Skill outputs in the inbox — the proposal\'s remaining choices.',
        params: { steps: FORM_SEVEN_STEPS },
      });
      const res = await postAnswer(fx, auth, taskId, requestId, {
        ...nonLockedAnswers(),
        nope: 'x',
      });
      assert.equal(res.status, 400);
      assert.equal((res.body as { ok: boolean }).ok, false);
    } finally {
      fx.cleanup();
    }
  });

  it('oversize answer is a 400', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { taskId, requestId } = makeRunningTaskWithRequest(fx, 't-424242', {
        kind: 'form',
        prompt: 'Skill outputs in the inbox — the proposal\'s remaining choices.',
        params: { steps: FORM_SEVEN_STEPS },
      });
      const res = await postAnswer(fx, auth, taskId, requestId, {
        ...nonLockedAnswers(),
        'q1-telegram-copies': 'x'.repeat(501),
      });
      assert.equal(res.status, 400);
      assert.equal((res.body as { ok: boolean }).ok, false);
    } finally {
      fx.cleanup();
    }
  });
});

describe('cancel + reroute', () => {
  it('cancel writes the state, event and payload; a terminal task cannot re-cancel', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const created = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'cancel me' } })
      );
      const taskId = (created.body as { task_id: string }).task_id;
      const res = await fx.handle(makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/cancel`, { auth }));
      assert.equal(res.status, 200);
      // A freshly received task was never routed — no worker_resource, so stop_requested is false.
      assert.deepEqual(res.body, { ok: true, state: 'cancelled', stop_requested: false });

      const detail = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${taskId}`, { auth }));
      const task = (detail.body as { task: Record<string, unknown> }).task;
      assert.equal(task.state, 'cancelled');
      const events = task.events as Array<Record<string, unknown>>;
      const cancelEvent = events.find((e) => e.kind === 'task.cancelled') as Record<string, unknown>;
      assert.ok(cancelEvent);
      assert.deepEqual(cancelEvent.payload, { by: 'operator' });

      const again = await fx.handle(makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/cancel`, { auth }));
      assert.equal(again.status, 409);
    } finally {
      fx.cleanup();
    }
  });

  it('cancel is stop_requested:false when there is no worker_resource', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const created = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'cancel me, unrouted' } })
      );
      const taskId = (created.body as { task_id: string }).task_id;
      const res = await fx.handle(makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/cancel`, { auth }));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, state: 'cancelled', stop_requested: false });
      assert.deepEqual(
        routeQueueLines(fx).filter((l) => l.kind === 'cancel'),
        []
      );
    } finally {
      fx.cleanup();
    }
  });

  it('cancel is stop_requested:true with a worker_resource + worker_dispatch_id + parseable routed_to; queue gains kind/worker_resource/worker_dispatch_id after ref_id', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const created = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'cancel a running one' } })
      );
      const taskId = (created.body as { task_id: string }).task_id;
      transitionTask(fx.db, 't-424242', taskId, 'routed', {
        eventKind: 'task.routed',
        routedTo: '-1001234567890_2002',
      });
      transitionTask(fx.db, 't-424242', taskId, 'running', { eventKind: 'task.progress' });
      fx.db
        .prepare('UPDATE tasks SET worker_resource = ?, worker_dispatch_id = ? WHERE task_id = ?')
        .run('topic--1001234567890_2002-th1', 'a1b2c3d4e5f6', taskId);

      const res = await fx.handle(makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/cancel`, { auth }));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, state: 'cancelled', stop_requested: true });

      const lines = routeQueueLines(fx);
      const last = lines[lines.length - 1];
      assert.deepEqual(Object.keys(last), [
        'q_id', 'ts', 'task_id', 'tenant_id', 'chat_id', 'thread_id', 'text', 'ref_id', 'kind',
        'worker_resource', 'worker_dispatch_id',
      ]);
      assert.equal(last.kind, 'cancel');
      assert.equal(last.worker_resource, 'topic--1001234567890_2002-th1');
      assert.equal(last.worker_dispatch_id, 'a1b2c3d4e5f6');
      assert.equal(last.task_id, taskId);
      assert.equal(last.chat_id, -1001234567890);
      assert.equal(last.thread_id, 2002);
      assert.ok((last.text as string).includes(`[Voice inbox task ${taskId} cancelled by the operator]`));
    } finally {
      fx.cleanup();
    }
  });

  it('cancel with a worker_resource but NO worker_dispatch_id omits the key (10-key order)', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const created = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'cancel a running one, pre-increment row' } })
      );
      const taskId = (created.body as { task_id: string }).task_id;
      transitionTask(fx.db, 't-424242', taskId, 'routed', {
        eventKind: 'task.routed',
        routedTo: '-1001234567890_2002',
      });
      transitionTask(fx.db, 't-424242', taskId, 'running', { eventKind: 'task.progress' });
      fx.db
        .prepare('UPDATE tasks SET worker_resource = ? WHERE task_id = ?')
        .run('topic--1001234567890_2002-th1', taskId);

      const res = await fx.handle(makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/cancel`, { auth }));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, state: 'cancelled', stop_requested: true });

      const lines = routeQueueLines(fx);
      const last = lines[lines.length - 1];
      assert.deepEqual(Object.keys(last), [
        'q_id', 'ts', 'task_id', 'tenant_id', 'chat_id', 'thread_id', 'text', 'ref_id', 'kind', 'worker_resource',
      ]);
      assert.equal('worker_dispatch_id' in last, false);
    } finally {
      fx.cleanup();
    }
  });

  it('reroute validates the topic, writes task.rerouted + a target route entry', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const created = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'send me elsewhere' } })
      );
      const taskId = (created.body as { task_id: string }).task_id;

      const bad = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/reroute`, {
          auth,
          json: { topic: '-1001234567890_9999' },
        })
      );
      assert.equal(bad.status, 400);
      const malformed = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/reroute`, { auth, json: { topic: 'not-a-key' } })
      );
      assert.equal(malformed.status, 400);

      const res = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/reroute`, {
          auth,
          json: { topic: '-1001234567890_2002' },
        })
      );
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, state: 'routed', routed_to: '-1001234567890_2002' });

      // Route queue: the inbox entry + the target entry for the new topic.
      const lines = routeQueueLines(fx);
      assert.equal(lines.length, 2);
      const target = lines[1] as Record<string, unknown>;
      assert.equal(target.chat_id, -1001234567890);
      assert.equal(target.thread_id, 2002);
      const text = target.text as string;
      assert.ok(
        text.includes(`[Voice task ${taskId} routed from inbox — reason: operator reroute]`),
        text
      );
      assert.ok(text.includes('task_telemetry.py" start'), text);

      const detail = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${taskId}`, { auth }));
      const task = (detail.body as { task: Record<string, unknown> }).task;
      assert.equal(task.state, 'routed');
      assert.equal(task.routed_to, '-1001234567890_2002');
      const events = task.events as Array<Record<string, unknown>>;
      const rerouteEvent = events.find((e) => e.kind === 'task.rerouted') as Record<string, unknown>;
      assert.ok(rerouteEvent);
      assert.equal((rerouteEvent.payload as Record<string, unknown>).to, '-1001234567890_2002');
      assert.match(rerouteEvent.ref_id as string, /^s-[0-9a-f]{12}$/);
    } finally {
      fx.cleanup();
    }
  });
});

describe('cross-tenant isolation', () => {
  it('tenant B gets 404s on every tenant-A task surface', async () => {
    const fx = makeFixture();
    try {
      const authA = seedSession(fx, 424242, -1001234567890, 'Op');
      const authB = seedSession(fx, 777, -100777, 'Other');
      const created = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', { auth: authA, json: { text: 'A only' } })
      );
      const taskId = (created.body as { task_id: string }).task_id;
      const { requestId } = makeRunningTaskWithRequest(fx, 't-424242', {
        kind: 'choice',
        prompt: 'A only',
        params: { options: ['x', 'y'] },
      });

      const surfaces: Array<[string, ApiRequest]> = [
        ['detail', makeReq(fx, 'GET', `/api/v1/tasks/${taskId}`, { auth: authB })],
        ['events', makeReq(fx, 'GET', `/api/v1/tasks/${taskId}/events`, { auth: authB })],
        [
          'answer',
          makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/inputs/${requestId}`, {
            auth: authB,
            json: { kind: 'choice', value: 'x' },
          }),
        ],
        ['cancel', makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/cancel`, { auth: authB })],
        [
          'reroute',
          makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/reroute`, {
            auth: authB,
            json: { topic: '-1001234567890_2002' },
          }),
        ],
      ];
      for (const [name, req] of surfaces) {
        const res = await fx.handle(req);
        assert.equal(res.status, 404, `${name} must be a cross-tenant 404`);
        assert.deepEqual(res.body, { ok: false, error: 'not found' });
      }
    } finally {
      fx.cleanup();
    }
  });
});

describe('GET /topics', () => {
  it('serves the topic list from the shared names file', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/topics', { auth }));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, {
        ok: true,
        topics: [
          { key: '-1001234567890_0', label: 'General' },
          { key: '-1001234567890_1040', label: 'Inbox' },
          { key: '-1001234567890_2002', label: 'Errands' },
        ],
      });
    } finally {
      fx.cleanup();
    }
  });

  it('fails to absent: no names file means an empty topic list, not an error', async () => {
    const fx = makeFixture();
    try {
      rmSync(join(fx.dir, 'telegram-topic-names.json'), { force: true });
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/topics', { auth }));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, topics: [] });
    } finally {
      fx.cleanup();
    }
  });
});

describe('GET /system/status', () => {
  const fixtureStatus: SystemStatus = {
    generated_at: 1234567890,
    threads: {
      running_count: 1,
      queued_count: 0,
      running: [{ topic: '-1001234567890_1040', id: 't1', title: 'test', updatedAt: '2026-09-12T00:00:00Z' }],
      queued: [],
      by_status: { running: 1 },
      active_topic_count: 1,
      total_topic_count: 1,
    },
    workers: {
      processes: [],
      alive_count: 0,
      slot_used: 0,
      slot_ceiling: 8,
      slot_ceiling_derived: true,
    },
    health: { bot_pid: 111, bot_alive: true, catchup_pid: null, catchup_alive: false },
    system: {
      cpu_percent: 12.5,
      cpu_count: 8,
      mem_total: 16_000_000_000,
      mem_used: 8_000_000_000,
      mem_percent: 50,
      disks: { 'C:/': { total: 1, used: 1, free: 0, percent: 100 } },
      boot_time: 1234500000,
      uptime_secs: 67890,
    },
    assistant_mem_bytes: 123456,
    pa_dir_size: { bytes: 789, files: 3, computed_at: 1234567890 },
  };

  it('serves the injected systemStatusFn fixture data with a valid Bearer', async () => {
    const fx = makeFixture();
    try {
      fx.deps.systemStatusFn = async () => fixtureStatus;
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/system/status', { auth }));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, status: fixtureStatus });
    } finally {
      fx.cleanup();
    }
  });

  it('returns the pinned 401 without a valid Bearer', async () => {
    const fx = makeFixture();
    try {
      fx.deps.systemStatusFn = async () => fixtureStatus;
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/system/status'));
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { ok: false, error: 'unauthorized' });
    } finally {
      fx.cleanup();
    }
  });

  it('returns 500 when systemStatusFn throws', async () => {
    const fx = makeFixture();
    try {
      fx.deps.systemStatusFn = async () => {
        throw new Error('boom');
      };
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/system/status', { auth }));
      assert.equal(res.status, 500);
      assert.equal(res.body && typeof res.body === 'object' && (res.body as { ok: unknown }).ok, false);
    } finally {
      fx.cleanup();
    }
  });
});

describe('routes — auth callback and answer resume (auth broker)', () => {
  it('GET reaches the handler without an Authorization header and serves html; POST is rejected', async () => {
    const fx = makeFixture();
    try {
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/auth/callback?state=nope&code=abc'));
      // No auth header was supplied — a 401 here would mean the auth
      // middleware ran before this no-auth branch (C1's routing rule).
      assert.notEqual(res.status, 401);
      assert.equal(typeof res.html, 'string');
      assert.equal(res.body, null);

      const posted = await fx.handle(makeReq(fx, 'POST', '/api/v1/auth/callback?state=nope'));
      assert.equal(posted.status, 405);
    } finally {
      fx.cleanup();
    }
  });

  it('answering a secret request with a live worker queues exactly one steer line (§3.6)', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { taskId, requestId } = makeRunningTaskWithRequest(fx, 't-424242', {
        kind: 'secret',
        prompt: 'What is the API key?',
        params: {},
      });
      fx.db
        .prepare('UPDATE tasks SET worker_resource = ? WHERE task_id = ?')
        .run('topic--1001234567890_2002', taskId);
      const res = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/inputs/${requestId}`, {
          auth,
          json: { kind: 'secret', value: 'sk-live-secret' },
        })
      );
      assert.equal(res.status, 200);
      const lines = routeQueueLines(fx);
      assert.equal(lines.length, 1);
      assert.deepEqual(Object.keys(lines[0]), [
        'q_id', 'ts', 'task_id', 'tenant_id', 'chat_id', 'thread_id', 'text', 'ref_id',
        'kind', 'steer_mode', 'steer_conversation',
      ]);
      assert.equal(lines[0].kind, 'steer');
      assert.equal(lines[0].steer_mode, 'queue');
    } finally {
      fx.cleanup();
    }
  });
});

describe('routes — a submitted secret value never leaves its answer file', () => {
  it('the canary value is absent from every ledger/log/queue surface but present in the answer file', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { taskId, requestId } = makeRunningTaskWithRequest(fx, 't-424242', {
        kind: 'secret',
        prompt: 'What is the API key?',
        params: {},
      });
      fx.db
        .prepare('UPDATE tasks SET worker_resource = ? WHERE task_id = ?')
        .run('topic--1001234567890_2002', taskId);
      const CANARY = 'zqx-CANARY-9f31a7-value';
      const res = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/inputs/${requestId}`, {
          auth,
          json: { kind: 'secret', value: CANARY },
        })
      );
      assert.equal(res.status, 200);

      // Present in the answer file — the control proving the assertions
      // below can actually distinguish "leaked" from "not leaked".
      const pointerPath = join(fx.deps.answersDir, taskId, `${requestId}.txt`);
      assert.equal(readFileSync(pointerPath, 'utf8'), CANARY);

      // Absent from the events table (summary + payload_json).
      const eventRows = fx.db.prepare('SELECT summary, payload_json FROM events').all() as Array<{
        summary: string | null;
        payload_json: string;
      }>;
      assert.ok(eventRows.length > 0, 'expected at least one event row');
      for (const row of eventRows) {
        assert.equal((row.summary ?? '').includes(CANARY), false);
        assert.equal(row.payload_json.includes(CANARY), false);
      }

      // Absent from the input_requests row (params_json, answer_pointer).
      const reqRow = fx.db
        .prepare('SELECT params_json, answer_pointer FROM input_requests WHERE request_id = ?')
        .get(requestId) as { params_json: string; answer_pointer: string };
      assert.equal(reqRow.params_json.includes(CANARY), false);
      assert.equal(reqRow.answer_pointer.includes(CANARY), false);

      // Absent from every line of route-queue.jsonl (a steer line was
      // queued — it must carry only the answer POINTER, never the value).
      const queueLines = routeQueueLines(fx);
      assert.ok(queueLines.length > 0, 'expected at least one route-queue line');
      for (const line of queueLines) {
        assert.equal(JSON.stringify(line).includes(CANARY), false);
      }

      // Absent from every line of logs/requests.log. This suite drives the
      // router directly, not server.ts's HTTP layer (the only place that
      // writes this log via request-log.ts) — the file will not exist here.
      // The assertion still pins the invariant: request-log.ts's format
      // (method, path, status, byte counts only — no bodies, no query
      // values) structurally can never carry a submitted value, so an empty
      // read correctly yields zero offending lines rather than skipping the
      // check outright.
      const logPath = join(fx.dir, 'logs', 'requests.log');
      let logLines: string[] = [];
      try {
        logLines = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.length > 0);
      } catch {
        logLines = [];
      }
      for (const line of logLines) {
        assert.equal(line.includes(CANARY), false);
      }
    } finally {
      fx.cleanup();
    }
  });
});

describe('GET /conversations — too_short flag (AI-223)', () => {
  it('flags only a transcribe_failed conversation whose newest task.failed event carries code:too_short', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const tenantId = 't-424242';

      // A too_short voice failure: transcribing -> transcribe_failed WITH code.
      const tooShortTask = createTask(fx.db, tenantId, {
        source: 'voice', requestText: '(voice recording)', initialState: 'transcribing',
      });
      transitionTask(fx.db, tenantId, tooShortTask.task_id, 'transcribe_failed', {
        eventKind: 'task.failed',
        eventPayload: { reason: 'audio file is 100 bytes, under the 8192-byte floor', code: 'too_short' },
      });

      // A genuine transcription failure: same shape, no code — must still render (§d: proves the flag discriminates, not "hide everything transcribe_failed").
      const realFailTask = createTask(fx.db, tenantId, {
        source: 'voice', requestText: '(voice recording)', initialState: 'transcribing',
      });
      transitionTask(fx.db, tenantId, realFailTask.task_id, 'transcribe_failed', {
        eventKind: 'task.failed',
        eventPayload: { reason: 'transcription failed (network_error): timeout' },
      });

      // An ordinary task — state !== transcribe_failed, must always read false.
      const plainTask = createTask(fx.db, tenantId, { source: 'text', requestText: 'hello' });

      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/conversations?limit=100', { auth }));
      assert.equal(res.status, 200);
      const conversations = (res.body as { conversations: Array<Record<string, unknown>> }).conversations;
      const byId = new Map(conversations.map((c) => [c.conversation_id as string, c]));

      assert.equal(byId.get(tooShortTask.conversation_id)?.too_short, true);
      assert.equal(byId.get(realFailTask.conversation_id)?.too_short, false);
      assert.equal(byId.get(plainTask.conversation_id)?.too_short, false);
    } finally {
      fx.cleanup();
    }
  });
});

describe('GET /conversations?q= — server-side search', () => {
  interface SearchIds { taskA: string; taskB: string; taskC: string }
  /** 3 conversations whose text lives in different fields: taskA in
   * request_text + meta title, taskB in request_text + result_summary,
   * taskC in request_text only. sleepMs(2) between seeds for deterministic
   * MAX(updated_at) ordering. */
  function seedSearch(fx: Fixture, tenantId: string): SearchIds {
    const taskA = createTask(fx.db, tenantId, { source: 'text', requestText: 'file the quarterly report' });
    setConversationMeta(fx.db, tenantId, taskA.task_id, { title: 'Q3 report' }, '2026-09-15T00:00:01.000Z');
    sleepMs(2);
    const taskB = createTask(fx.db, tenantId, { source: 'text', requestText: 'renew passport' });
    transitionTask(fx.db, tenantId, taskB.task_id, 'routed', { eventKind: 'task.routed', routedTo: '-1001234567890_2002' });
    transitionTask(fx.db, tenantId, taskB.task_id, 'running', { eventKind: 'task.progress' });
    transitionTask(fx.db, tenantId, taskB.task_id, 'done', {
      eventKind: 'task.completed',
      resultSummary: 'passport filed at the embassy',
    });
    sleepMs(2);
    const taskC = createTask(fx.db, tenantId, { source: 'text', requestText: 'buy groceries' });
    return { taskA: taskA.task_id, taskB: taskB.task_id, taskC: taskC.task_id };
  }

  function idsOf(res: { body: unknown }): unknown[] {
    return (res.body as { conversations: Array<Record<string, unknown>> }).conversations.map(
      (c) => c.conversation_id
    );
  }

  it('q filters the list and total is the filtered count', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { taskA } = seedSearch(fx, 't-424242');
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/conversations?q=report', { auth }));
      assert.equal(res.status, 200);
      assert.deepEqual(idsOf(res), [taskA]);
      assert.equal((res.body as { total: number }).total, 1);
    } finally {
      fx.cleanup();
    }
  });

  it('ANDs across whitespace-tokenized terms', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { taskA } = seedSearch(fx, 't-424242');
      const res = await fx.handle(
        makeReq(fx, 'GET', '/api/v1/conversations?q=quarterly%20report', { auth })
      );
      assert.equal(res.status, 200);
      assert.deepEqual(idsOf(res), [taskA]);
      assert.equal((res.body as { total: number }).total, 1);
    } finally {
      fx.cleanup();
    }
  });

  it('q matches result_summary', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { taskB } = seedSearch(fx, 't-424242');
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/conversations?q=passport', { auth }));
      assert.equal(res.status, 200);
      assert.deepEqual(idsOf(res), [taskB]);
      assert.equal((res.body as { total: number }).total, 1);
    } finally {
      fx.cleanup();
    }
  });

  it('q matches the meta title through the LEFT JOIN', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { taskA } = seedSearch(fx, 't-424242');
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/conversations?q=Q3', { auth }));
      assert.equal(res.status, 200);
      assert.deepEqual(idsOf(res), [taskA]);
      assert.equal((res.body as { total: number }).total, 1);
    } finally {
      fx.cleanup();
    }
  });

  it('a literal % term never widens the search', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      seedSearch(fx, 't-424242');
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/conversations?q=%25', { auth }));
      assert.equal(res.status, 200);
      assert.deepEqual(idsOf(res), []);
      assert.equal((res.body as { total: number }).total, 0);
    } finally {
      fx.cleanup();
    }
  });

  it('empty q is unfiltered', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      seedSearch(fx, 't-424242');
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/conversations?q=', { auth }));
      assert.equal(res.status, 200);
      assert.equal(idsOf(res).length, 3);
      assert.equal((res.body as { total: number }).total, 3);
    } finally {
      fx.cleanup();
    }
  });

  it('q over 200 characters is 400 with the pinned error body', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      seedSearch(fx, 't-424242');
      const res = await fx.handle(
        makeReq(fx, 'GET', `/api/v1/conversations?q=${'x'.repeat(201)}`, { auth })
      );
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, {
        ok: false,
        error: 'q must be a string of at most 200 characters',
      });
    } finally {
      fx.cleanup();
    }
  });

  it('offset pages the filtered set while total stays the filtered count', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { taskA, taskB } = seedSearch(fx, 't-424242');
      // 'the' matches taskA ('file THE quarterly report') + taskB ('at THE
      // embassy'); taskB's done transition makes it the newer match.
      const res = await fx.handle(
        makeReq(fx, 'GET', '/api/v1/conversations?q=the&limit=1&offset=1', { auth })
      );
      assert.equal(res.status, 200);
      assert.deepEqual(idsOf(res), [taskA]);
      assert.equal((res.body as { total: number }).total, 2);
      const first = await fx.handle(
        makeReq(fx, 'GET', '/api/v1/conversations?q=the&limit=1&offset=0', { auth })
      );
      assert.deepEqual(idsOf(first), [taskB]);
    } finally {
      fx.cleanup();
    }
  });

  it('401 without a valid Bearer', async () => {
    const fx = makeFixture();
    try {
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/conversations?q=report'));
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { ok: false, error: 'unauthorized' });
    } finally {
      fx.cleanup();
    }
  });

  it('validation order: limit first, then offset, then q', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(
        makeReq(fx, 'GET', '/api/v1/conversations?limit=0&q=report', { auth })
      );
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { ok: false, error: 'limit must be a positive integer' });
      const res2 = await fx.handle(
        makeReq(fx, 'GET', `/api/v1/conversations?offset=-1&q=${'x'.repeat(201)}`, { auth })
      );
      assert.equal(res2.status, 400);
      assert.deepEqual(res2.body, { ok: false, error: 'offset must be a non-negative integer' });
    } finally {
      fx.cleanup();
    }
  });

  it('q matches the raw transcript of a voice task whose request text was cleaned', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const voice = createTask(fx.db, 't-424242', {
        source: 'voice',
        requestText: 'renew the car insurance',
        transcript: 'umm so renew the uh car insurance thingy',
      });
      createTask(fx.db, 't-424242', { source: 'text', requestText: 'buy groceries' });
      const raw = await fx.handle(makeReq(fx, 'GET', '/api/v1/conversations?q=thingy', { auth }));
      assert.equal(raw.status, 200);
      assert.deepEqual(idsOf(raw), [voice.task_id]);
      assert.equal((raw.body as { total: number }).total, 1);
      const cleaned = await fx.handle(makeReq(fx, 'GET', '/api/v1/conversations?q=insurance', { auth }));
      assert.equal(cleaned.status, 200);
      assert.deepEqual(idsOf(cleaned), [voice.task_id]);
    } finally {
      fx.cleanup();
    }
  });
});

describe('push routes', () => {
  it('GET vapid-public-key requires auth (pinned 401)', async () => {
    const fx = makeFixture();
    try {
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/push/vapid-public-key'));
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { ok: false, error: 'unauthorized' });
    } finally {
      fx.cleanup();
    }
  });

  it('POST subscribe requires auth (pinned 401)', async () => {
    const fx = makeFixture();
    try {
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/push/subscribe', { json: {} }));
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { ok: false, error: 'unauthorized' });
    } finally {
      fx.cleanup();
    }
  });

  it('POST unsubscribe requires auth (pinned 401)', async () => {
    const fx = makeFixture();
    try {
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/push/unsubscribe', { json: {} }));
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { ok: false, error: 'unauthorized' });
    } finally {
      fx.cleanup();
    }
  });

  it('POST test requires auth (pinned 401) — not exercised authenticated here: it shells out to the real pa CLI', async () => {
    const fx = makeFixture();
    try {
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/push/test', { json: {} }));
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { ok: false, error: 'unauthorized' });
    } finally {
      fx.cleanup();
    }
  });

  it('GET vapid-public-key returns a base64url-ish 65-byte P-256 public key', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/push/vapid-public-key', { auth }));
      assert.equal(res.status, 200);
      const body = res.body as { ok: boolean; publicKey: string };
      assert.equal(body.ok, true);
      assert.match(body.publicKey, /^[A-Za-z0-9_-]+$/);
      const raw = Buffer.from(body.publicKey, 'base64url');
      assert.equal(raw.length, 65);
      assert.equal(raw[0], 0x04);
    } finally {
      fx.cleanup();
    }
  });

  it('GET vapid-public-key wrong method is 405', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/push/vapid-public-key', { auth, json: {} }));
      assert.equal(res.status, 405);
    } finally {
      fx.cleanup();
    }
  });

  it('POST subscribe stores a subscription under the fixture pushStorageDir, scoped to the tenant', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/push/subscribe', {
          auth,
          json: {
            subscription: {
              endpoint: 'https://push.example/xyz',
              keys: { p256dh: 'p256dh-val', auth: 'auth-val' },
            },
            userAgent: 'test-agent/1.0',
          },
        })
      );
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });

      const stored = getSubscriptions(undefined, fx.deps.pushStorageDir);
      assert.equal(stored.length, 1);
      assert.equal(stored[0].endpoint, 'https://push.example/xyz');
      assert.deepEqual(stored[0].keys, { p256dh: 'p256dh-val', auth: 'auth-val' });
      assert.equal(stored[0].userAgent, 'test-agent/1.0');
      assert.equal(stored[0].tenantId, 't-424242');
      assert.ok(stored[0].createdAt);
    } finally {
      fx.cleanup();
    }
  });

  it('POST subscribe 400s on a malformed body (missing keys)', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/push/subscribe', {
          auth,
          json: { subscription: { endpoint: 'https://push.example/xyz' } },
        })
      );
      assert.equal(res.status, 400);
      assert.equal((res.body as { ok: boolean }).ok, false);
    } finally {
      fx.cleanup();
    }
  });

  it('POST subscribe 400s on invalid JSON body', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/push/subscribe', { auth, body: Buffer.from('not json'), contentType: 'application/json' })
      );
      assert.equal(res.status, 400);
    } finally {
      fx.cleanup();
    }
  });

  it('POST unsubscribe removes a stored subscription (idempotent: a second call also returns ok:true)', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      await fx.handle(
        makeReq(fx, 'POST', '/api/v1/push/subscribe', {
          auth,
          json: {
            subscription: {
              endpoint: 'https://push.example/to-remove',
              keys: { p256dh: 'p256dh-val', auth: 'auth-val' },
            },
          },
        })
      );
      assert.equal(getSubscriptions(undefined, fx.deps.pushStorageDir).length, 1);

      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/push/unsubscribe', { auth, json: { endpoint: 'https://push.example/to-remove' } })
      );
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.equal(getSubscriptions(undefined, fx.deps.pushStorageDir).length, 0);

      // Removing again (already gone) is a no-op, not an error — still ok:true.
      const res2 = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/push/unsubscribe', { auth, json: { endpoint: 'https://push.example/to-remove' } })
      );
      assert.equal(res2.status, 200);
      assert.deepEqual(res2.body, { ok: true });
    } finally {
      fx.cleanup();
    }
  });

  it('POST unsubscribe 400s when endpoint is missing', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/push/unsubscribe', { auth, json: {} }));
      assert.equal(res.status, 400);
    } finally {
      fx.cleanup();
    }
  });

  it('unknown push subpath is 404', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/push/nonexistent', { auth }));
      assert.equal(res.status, 404);
    } finally {
      fx.cleanup();
    }
  });
});

describe('conversation sharing (AI-227)', () => {
  it('mints a share via POST /conversations/:id/share', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const task = createTask(fx.db, 't-424242', { source: 'text', requestText: 'plan the trip' });

      const res = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/conversations/${task.conversation_id}/share`, { auth })
      );
      assert.equal(res.status, 200);
      const body = res.body as { ok: boolean; token: string; created_at: string };
      assert.equal(body.ok, true);
      assert.ok(body.token.length > 0);
      assert.ok(body.created_at.length > 0);
    } finally {
      fx.cleanup();
    }
  });

  it('idempotent share creation returns the identical token', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const task = createTask(fx.db, 't-424242', { source: 'text', requestText: 'plan the trip' });

      const first = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/conversations/${task.conversation_id}/share`, { auth })
      );
      const second = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/conversations/${task.conversation_id}/share`, { auth })
      );
      assert.equal((first.body as { token: string }).token, (second.body as { token: string }).token);
    } finally {
      fx.cleanup();
    }
  });

  it('GET /conversations/:id exposes active share state and token', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const task = createTask(fx.db, 't-424242', { source: 'text', requestText: 'plan the trip' });

      const before = await fx.handle(
        makeReq(fx, 'GET', `/api/v1/conversations/${task.conversation_id}`, { auth })
      );
      assert.deepEqual((before.body as { conversation: { share: unknown } }).conversation.share, { active: false });

      const shared = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/conversations/${task.conversation_id}/share`, { auth })
      );
      const token = (shared.body as { token: string }).token;

      const after = await fx.handle(
        makeReq(fx, 'GET', `/api/v1/conversations/${task.conversation_id}`, { auth })
      );
      const share = (after.body as { conversation: { share: { active: boolean; token: string } } }).conversation.share;
      assert.equal(share.active, true);
      assert.equal(share.token, token);
    } finally {
      fx.cleanup();
    }
  });

  it('unshares via POST /conversations/:id/unshare, and calling it again still returns 200', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const task = createTask(fx.db, 't-424242', { source: 'text', requestText: 'plan the trip' });
      await fx.handle(makeReq(fx, 'POST', `/api/v1/conversations/${task.conversation_id}/share`, { auth }));

      const first = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/conversations/${task.conversation_id}/unshare`, { auth })
      );
      assert.equal(first.status, 200);
      assert.deepEqual(first.body, { ok: true, revoked: true });

      const second = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/conversations/${task.conversation_id}/unshare`, { auth })
      );
      assert.equal(second.status, 200);

      const detail = await fx.handle(
        makeReq(fx, 'GET', `/api/v1/conversations/${task.conversation_id}`, { auth })
      );
      assert.deepEqual((detail.body as { conversation: { share: unknown } }).conversation.share, { active: false });
    } finally {
      fx.cleanup();
    }
  });

  it('public GET /api/v1/share/:token returns 200 and sanitized data with no auth header', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const task = createTask(fx.db, 't-424242', { source: 'text', requestText: 'plan the trip' });
      transitionTask(fx.db, 't-424242', task.task_id, 'routed', {
        eventKind: 'task.routed', routedTo: '-1001234567890_1040', routingReason: 'trip topic',
      });
      transitionTask(fx.db, 't-424242', task.task_id, 'done', {
        eventKind: 'task.completed', resultSummary: 'Booked the trip, confirmation XYZ',
      });
      const shared = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/conversations/${task.conversation_id}/share`, { auth })
      );
      const token = (shared.body as { token: string }).token;

      const res = await fx.handle(makeReq(fx, 'GET', `/api/v1/share/${token}`));
      assert.equal(res.status, 200);
      const body = res.body as {
        ok: boolean;
        conversation: {
          summary: Record<string, unknown>;
          turns: Array<Record<string, unknown>>;
        };
      };
      assert.equal(body.ok, true);
      assert.equal(body.conversation.summary['conversation_id'], task.conversation_id);
      assert.equal('routed_to' in body.conversation.summary, false);
      assert.equal('tenant_id' in body.conversation.summary, false);
      assert.equal(body.conversation.turns.length, 1);
      const turn = body.conversation.turns[0];
      assert.equal(turn['request_text'], 'plan the trip');
      assert.equal('tenant_id' in turn, false);
      assert.equal('routed_to' in turn, false);
      assert.equal('routing_reason' in turn, false);
      assert.equal('worker_resource' in turn, false);
      assert.equal('worker_dispatch_id' in turn, false);
      // Schema v16: the router_* metadata columns are routing internals of
      // exactly the class AI-227 drops — the unauthenticated share view
      // never carries any of the seven.
      assert.equal('router_decision' in turn, false);
      assert.equal('router_placement' in turn, false);
      assert.equal('router_target' in turn, false);
      assert.equal('router_steer' in turn, false);
      assert.equal('router_steer_by' in turn, false);
      assert.equal('router_effort_proj' in turn, false);
      assert.equal('router_failovers' in turn, false);
    } finally {
      fx.cleanup();
    }
  });

  it('authenticated turn JSON carries the v16 router_* metadata; the share view drops all seven', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const created = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'plan the trip' } }));
      const taskId = (created.body as { task_id: string }).task_id;
      const convId = (created.body as { conversation_id: string }).conversation_id;
      fx.db
        .prepare(
          `UPDATE tasks SET router_decision = 'router', router_placement = 'diverted',
           router_target = 'vi-0123456789ab', router_steer = 'wait',
           router_steer_by = 'operator', router_effort_proj = 'nearest',
           router_failovers = 1 WHERE task_id = ?`
        )
        .run(taskId);

      // Authenticated surface: the row passes through publicTask's
      // rest-spread, so all seven fields flow.
      const conv = await fx.handle(makeReq(fx, 'GET', `/api/v1/conversations/${convId}`, { auth }));
      assert.equal(conv.status, 200);
      const turn = (conv.body as { conversation: { tasks: Array<Record<string, unknown>> } }).conversation.tasks[0];
      assert.equal(turn['router_decision'], 'router');
      assert.equal(turn['router_placement'], 'diverted');
      assert.equal(turn['router_target'], 'vi-0123456789ab');
      assert.equal(turn['router_steer'], 'wait');
      assert.equal(turn['router_steer_by'], 'operator');
      assert.equal(turn['router_effort_proj'], 'nearest');
      assert.equal(turn['router_failovers'], 1);

      // Unauthenticated share view: all six dropped.
      const minted = await fx.handle(makeReq(fx, 'POST', `/api/v1/conversations/${convId}/share`, { auth, json: {} }));
      const token = (minted.body as { token: string }).token;
      const pub = await fx.handle(makeReq(fx, 'GET', `/api/v1/share/${token}`));
      assert.equal(pub.status, 200);
      const share = (pub.body as { conversation: { turns: Array<Record<string, unknown>> } }).conversation.turns[0];
      assert.equal('router_target' in share, false);
      assert.equal('router_steer_by' in share, false);
      for (const key of ['router_decision', 'router_placement', 'router_target', 'router_steer', 'router_steer_by', 'router_effort_proj', 'router_failovers']) {
        assert.equal(key in share, false, `share view leaked ${key}`);
      }
    } finally {
      fx.cleanup();
    }
  });

  it('unknown or revoked token on the public route returns 404', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const task = createTask(fx.db, 't-424242', { source: 'text', requestText: 'plan the trip' });

      const unknown = await fx.handle(makeReq(fx, 'GET', '/api/v1/share/not-a-real-token'));
      assert.equal(unknown.status, 404);

      const shared = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/conversations/${task.conversation_id}/share`, { auth })
      );
      const token = (shared.body as { token: string }).token;
      await fx.handle(makeReq(fx, 'POST', `/api/v1/conversations/${task.conversation_id}/unshare`, { auth }));

      const revoked = await fx.handle(makeReq(fx, 'GET', `/api/v1/share/${token}`));
      assert.equal(revoked.status, 404);
    } finally {
      fx.cleanup();
    }
  });

  it('cross-tenant isolation: a share token never carries tenant_id, and belongs to only the minting tenant', async () => {
    const fx = makeFixture();
    try {
      const authA = seedSession(fx, 424242, -1001234567890, 'Owner');
      seedSession(fx, 999999, -1009999999999, 'Stranger');
      const task = createTask(fx.db, 't-424242', { source: 'text', requestText: 'A private plan' });

      const shared = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/conversations/${task.conversation_id}/share`, { auth: authA })
      );
      const token = (shared.body as { token: string }).token;

      const res = await fx.handle(makeReq(fx, 'GET', `/api/v1/share/${token}`));
      assert.equal(res.status, 200);
      const raw = JSON.stringify(res.body);
      assert.equal(raw.includes('t-424242'), false);
      assert.equal(raw.includes('tenant_id'), false);
    } finally {
      fx.cleanup();
    }
  });

  it('privacy audit: a pending oauth input request has no prompt and no params in the public payload', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const task = createTask(fx.db, 't-424242', { source: 'text', requestText: 'connect my calendar' });
      transitionTask(fx.db, 't-424242', task.task_id, 'routed', {
        eventKind: 'task.routed', routedTo: '-1001234567890_1040', routingReason: 'calendar topic',
      });
      transitionTask(fx.db, 't-424242', task.task_id, 'running', { eventKind: 'task.progress' });
      const oauthPrompt = 'Sign in with Google to connect your calendar';
      createInputRequest(fx.db, 't-424242', task.task_id, {
        kind: 'oauth',
        prompt: oauthPrompt,
        params: { provider: 'google', user_code: 'ABCD-1234' },
      });

      const shared = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/conversations/${task.conversation_id}/share`, { auth })
      );
      const token = (shared.body as { token: string }).token;

      const res = await fx.handle(makeReq(fx, 'GET', `/api/v1/share/${token}`));
      assert.equal(res.status, 200);
      const body = res.body as { conversation: { turns: Array<{ input_requests: Array<Record<string, unknown>> }> } };
      const requests = body.conversation.turns[0].input_requests;
      assert.equal(requests.length, 1);
      const req = requests[0];
      assert.equal(req['status'], 'pending');
      assert.deepEqual(Object.keys(req).sort(), ['created_at', 'kind', 'request_id', 'status']);
      assert.equal('prompt' in req, false);
      assert.equal('params' in req, false);
      assert.equal(JSON.stringify(req).includes(oauthPrompt), false);
    } finally {
      fx.cleanup();
    }
  });
});

describe('POST /tasks attachments + serving (task attachments, 2026-09-13)', () => {
  it('files-only multipart creates a text task with the (attachments) placeholder, stores files, and carries the segment in the queue entry', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'files', filename: 'shot.png', data: Buffer.from('PNGDATA', 'utf8') },
        { name: 'files', filename: 'note.mp4', data: Buffer.from('MP4DATA', 'utf8') },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 200);
      const { task_id: taskId, state } = res.body as { task_id: string; state: string };
      assert.equal(state, 'received');

      const row = fx.db.prepare('SELECT source, request_text FROM tasks WHERE task_id = ?').get(taskId) as {
        source: string; request_text: string;
      };
      assert.equal(row.source, 'text');
      assert.equal(row.request_text, '(attachments)');

      const lines = routeQueueLines(fx);
      assert.equal(lines.length, 1);
      const text = (lines[0] as { text: string }).text;
      const seg =
        `Attachments (2): ${join(fx.deps.filesDir, taskId, 'shot.png').replace(/\\/g, '/')}; ` +
        `${join(fx.deps.filesDir, taskId, 'note.mp4').replace(/\\/g, '/')}. ` +
        'Open them from disk when the task needs them; audio or video attachments can be transcribed with transcribe_voice.py. ';
      assert.ok(text.includes(seg), text);

      const detail = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${taskId}`, { auth }));
      const task = (detail.body as { task: { attachments: Array<{ name: string; bytes: number }> } }).task;
      assert.deepEqual(task.attachments, [
        { name: 'note.mp4', bytes: 7 },
        { name: 'shot.png', bytes: 7 },
      ]);
    } finally {
      fx.cleanup();
    }
  });

  it('text + files multipart uses the text part as request_text', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'text', data: 'summarize this' },
        { name: 'files', filename: 'doc.txt', data: Buffer.from('hello', 'utf8') },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 200);
      const { task_id: taskId } = res.body as { task_id: string };
      const row = fx.db.prepare('SELECT request_text FROM tasks WHERE task_id = ?').get(taskId) as {
        request_text: string;
      };
      assert.equal(row.request_text, 'summarize this');
    } finally {
      fx.cleanup();
    }
  });

  it('voice + files stores both and renders the segment after the saved-at sentence', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'audio', filename: 'clip.webm', data: AMPLE_AUDIO },
        { name: 'files', filename: 'shot.png', data: Buffer.from('PNGDATA', 'utf8') },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 200);
      const { task_id: taskId } = res.body as { task_id: string };
      assert.ok(existsSync(join(fx.deps.filesDir, taskId, 'audio.webm')));
      assert.ok(existsSync(join(fx.deps.filesDir, taskId, 'shot.png')));
      const text = (routeQueueLines(fx)[0] as { text: string }).text;
      const savedAt = `A voice recording is saved at ${join(fx.deps.filesDir, taskId, 'audio.webm').replace(/\\/g, '/')}. `;
      assert.ok(text.includes(savedAt + 'Attachments (1): '), text);
    } finally {
      fx.cleanup();
    }
  });

  it('a file part with a stray name is a 400 with the exact body — no row, no files', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'screenshot', filename: 'x.png', data: Buffer.from('PNGDATA', 'utf8') },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { ok: false, error: 'unexpected file part "screenshot"' });
      assert.deepEqual(fetchAllTasks(fx), []);
      assert.equal(existsSync(fx.deps.filesDir), false);
    } finally {
      fx.cleanup();
    }
  });

  it('more than max_task_attachments is a 400 with the exact body — no row', async () => {
    const fx = makeFixture();
    try {
      fx.config.maxTaskAttachments = 10; // opt-in: without this, unlimited
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const parts = Array.from({ length: 11 }, (_, i) => ({
        name: 'files', filename: `f${i}.txt`, data: Buffer.from('x', 'utf8'),
      }));
      const { body, contentType } = multipartBody(parts);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { ok: false, error: 'at most 10 attachments per task (max_task_attachments)' });
      assert.deepEqual(fetchAllTasks(fx), []);
    } finally {
      fx.cleanup();
    }
  });

  it('a file over max_upload_mb is a 413 with the exact body — no row', async () => {
    const fx = makeFixture();
    try {
      fx.config.maxUploadMb = 25; // opt-in: without this, unlimited
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'files', filename: 'big.bin', data: Buffer.alloc(25 * 1024 * 1024 + 1, 0x41) },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 413);
      assert.deepEqual(res.body, { ok: false, error: 'attachment "big.bin" exceeds max_upload_mb (25)' });
      assert.deepEqual(fetchAllTasks(fx), []);
    } finally {
      fx.cleanup();
    }
  });

  it('attachments over max_attachment_total_mb (fixture override 1 MB) are a 413 — no row', async () => {
    const fx = makeFixture();
    try {
      fx.config.maxAttachmentTotalMb = 1;
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'files', filename: 'a.bin', data: Buffer.alloc(600 * 1024, 0x41) },
        { name: 'files', filename: 'b.bin', data: Buffer.alloc(600 * 1024, 0x41) },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 413);
      assert.deepEqual(res.body, { ok: false, error: 'attachments exceed max_attachment_total_mb (1)' });
      assert.deepEqual(fetchAllTasks(fx), []);
    } finally {
      fx.cleanup();
    }
  });

  // --- default-unlimited (2026-09-13 uncapped-create): no knobs set, big
  // payloads are accepted. These are the opt-in cap spec's verification gate.

  it('30 attachments of ~1 KB each are accepted with no knobs set', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const parts = Array.from({ length: 30 }, (_, i) => ({
        name: 'files', filename: `f${i}.txt`, data: Buffer.alloc(1024, 0x41),
      }));
      const { body, contentType } = multipartBody(parts);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 200);
      const { task_id: taskId } = res.body as { task_id: string };
      assert.equal(fetchAllTasks(fx).length, 1); // the row exists
      assert.equal(readdirSync(join(fx.deps.filesDir, taskId)).length, 30);
    } finally {
      fx.cleanup();
    }
  });

  it('one 26 MB attachment is accepted with no knobs set', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'files', filename: 'big.bin', data: Buffer.alloc(26 * 1024 * 1024, 7) },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 200);
      const { task_id: taskId } = res.body as { task_id: string };
      const stored = readFileSync(join(fx.deps.filesDir, taskId, 'big.bin'));
      assert.equal(stored.length, 26 * 1024 * 1024);
    } finally {
      fx.cleanup();
    }
  });

  it('three 20 MB attachments (60 MB total) are accepted with no knobs set', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'files', filename: 'a.bin', data: Buffer.alloc(20 * 1024 * 1024, 7) },
        { name: 'files', filename: 'b.bin', data: Buffer.alloc(20 * 1024 * 1024, 7) },
        { name: 'files', filename: 'c.bin', data: Buffer.alloc(20 * 1024 * 1024, 7) },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 200);
      const { task_id: taskId } = res.body as { task_id: string };
      assert.deepEqual(readdirSync(join(fx.deps.filesDir, taskId)).sort(), ['a.bin', 'b.bin', 'c.bin']);
    } finally {
      fx.cleanup();
    }
  });

  it('a 10 000-char JSON text is accepted with no knobs set', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const text = 'a'.repeat(10_000);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text } }));
      assert.equal(res.status, 200);
      const { task_id: taskId } = res.body as { task_id: string };
      const row = fx.db.prepare('SELECT request_text FROM tasks WHERE task_id = ?').get(taskId) as {
        request_text: string;
      };
      assert.equal(row.request_text.length, 10_000);
    } finally {
      fx.cleanup();
    }
  });

  it('a 5 000-char multipart text part + an attachment is accepted with no knobs set', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const text = 'b'.repeat(5_000);
      const { body, contentType } = multipartBody([
        { name: 'text', data: text },
        { name: 'files', filename: 'x.bin', data: Buffer.alloc(1024, 7) },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 200);
      const { task_id: taskId } = res.body as { task_id: string };
      const row = fx.db.prepare('SELECT request_text FROM tasks WHERE task_id = ?').get(taskId) as {
        request_text: string;
      };
      assert.equal(row.request_text, text);
      assert.deepEqual(readdirSync(join(fx.deps.filesDir, taskId)), ['x.bin']);
    } finally {
      fx.cleanup();
    }
  });

  it('an explicit max_text_chars enforces — 101 chars over 100 is a 400 (JSON and multipart)', async () => {
    const fx = makeFixture();
    try {
      fx.config.maxTextChars = 100;
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const long = 'c'.repeat(101);
      const viaJson = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: long } }));
      assert.equal(viaJson.status, 400);
      assert.deepEqual(viaJson.body, { ok: false, error: 'text must be a string of 1..100 chars' });
      const viaMultipart = multipartBody([{ name: 'text', data: long }]);
      const res = await fx.handle(
        makeReq(fx, 'POST', '/api/v1/tasks', {
          auth,
          body: viaMultipart.body,
          contentType: viaMultipart.contentType,
        })
      );
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { ok: false, error: 'text must be a string of 1..100 chars' });
      assert.deepEqual(fetchAllTasks(fx), []);
    } finally {
      fx.cleanup();
    }
  });

  it('names are sanitized (traversal defused) and audio.* is reserved for the recording', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'files', filename: '..\\..\\evil name.png', data: Buffer.from('PNG', 'utf8') },
        { name: 'files', filename: 'audio.webm', data: Buffer.from('not really', 'utf8') },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 200);
      const { task_id: taskId } = res.body as { task_id: string };
      const names = readdirSync(join(fx.deps.filesDir, taskId)).sort();
      assert.deepEqual(names, ['evil_name.png', 'file-audio.webm']);
    } finally {
      fx.cleanup();
    }
  });

  it('colliding names get -2 before the extension', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'files', filename: 'report.pdf', data: Buffer.from('one', 'utf8') },
        { name: 'files', filename: 'report.pdf', data: Buffer.from('two', 'utf8') },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 200);
      const { task_id: taskId } = res.body as { task_id: string };
      assert.deepEqual(readdirSync(join(fx.deps.filesDir, taskId)).sort(), ['report-2.pdf', 'report.pdf']);
    } finally {
      fx.cleanup();
    }
  });

  it('attachment storage failure on a text task moves it VISIBLY to failed with a task.failed event', async () => {
    const fx = makeFixture();
    try {
      writeFileSync(fx.deps.filesDir, 'not a dir'); // mkdirSync(taskDir) must fail
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'files', filename: 'x.txt', data: Buffer.from('x', 'utf8') },
      ]);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      assert.equal(res.status, 200);
      const { task_id: taskId, state } = res.body as { task_id: string; state: string };
      assert.equal(state, 'failed');
      assert.deepEqual(failedEventPayload(fx, taskId), { reason: 'attachment storage failed' });
      const row = fx.db.prepare('SELECT state FROM tasks WHERE task_id = ?').get(taskId) as { state: string };
      assert.equal(row.state, 'failed');
    } finally {
      fx.cleanup();
    }
  });

  it('serving: bytes match, content type by extension, traversal and unknown names are 404s, POST is 405', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      // The stored name is the SANITIZED form ('pic name.png' → 'pic_name.png',
      // per B11/sanitizeUploadName) and the serving contract serves exactly the
      // listed name — so the fetch below uses the stored name.
      const { body, contentType } = multipartBody([
        { name: 'files', filename: 'pic name.png', data: Buffer.from('PNGDATA', 'utf8') },
      ]);
      const created = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      const taskId = (created.body as { task_id: string }).task_id;

      const ok = await fx.handle(
        makeReq(fx, 'GET', `/api/v1/tasks/${taskId}/attachments/${encodeURIComponent('pic_name.png')}`, { auth })
      );
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.file, {
        path: join(fx.deps.filesDir, taskId, 'pic_name.png'),
        contentType: 'image/png',
      });

      const traversal = await fx.handle(
        makeReq(fx, 'GET', `/api/v1/tasks/${taskId}/attachments/..%2F..%2Fledger.sqlite`, { auth })
      );
      assert.equal(traversal.status, 404);
      assert.deepEqual(traversal.body, { ok: false, error: 'not found' });

      const unknown = await fx.handle(makeReq(fx, 'GET', `/api/v1/tasks/${taskId}/attachments/nope.png`, { auth }));
      assert.equal(unknown.status, 404);

      const wrongMethod = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/attachments/pic%20name.png`, { auth, body: Buffer.alloc(0) })
      );
      assert.equal(wrongMethod.status, 405);
    } finally {
      fx.cleanup();
    }
  });

  it('conversation detail carries per-task attachments; the public share view does not', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { body, contentType } = multipartBody([
        { name: 'files', filename: 'a.txt', data: Buffer.from('aaa', 'utf8') },
      ]);
      const created = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, body, contentType }));
      const convId = (created.body as { conversation_id: string }).conversation_id;

      const conv = await fx.handle(makeReq(fx, 'GET', `/api/v1/conversations/${convId}`, { auth }));
      const turns = (conv.body as { conversation: { tasks: Array<{ attachments: unknown }> } }).conversation.tasks;
      assert.deepEqual(turns[0].attachments, [{ name: 'a.txt', bytes: 3 }]);

      const minted = await fx.handle(makeReq(fx, 'POST', `/api/v1/conversations/${convId}/share`, { auth, json: {} }));
      const token = (minted.body as { token: string }).token;
      const pub = await fx.handle(makeReq(fx, 'GET', `/api/v1/share/${token}`));
      assert.equal(pub.status, 200);
      const pubTurns = (pub.body as { conversation: { turns: Array<Record<string, unknown>> } }).conversation.turns;
      assert.equal('attachments' in pubTurns[0], false); // unauthenticated view: no file serving, no list
    } finally {
      fx.cleanup();
    }
  });

  it('reroute on a task with attachment files renders the segment into the target entry', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const created = await fx.handle(makeReq(fx, 'POST', '/api/v1/tasks', { auth, json: { text: 'route me' } }));
      const taskId = (created.body as { task_id: string }).task_id;
      const dir = join(fx.deps.filesDir, taskId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'shot.png'), 'PNG');
      writeFileSync(join(dir, 'audio.webm'), 'not the recording');

      const res = await fx.handle(
        makeReq(fx, 'POST', `/api/v1/tasks/${taskId}/reroute`, { auth, json: { topic: '-1001234567890_2002' } })
      );
      assert.equal(res.status, 200);
      const lines = routeQueueLines(fx);
      const text = (lines[lines.length - 1] as { text: string }).text;
      assert.ok(
        text.includes(
          `Attachments (1): ${join(dir, 'shot.png').replace(/\\/g, '/')}. Open them from disk`
        ),
        text
      );
      assert.equal(text.includes('audio.webm'), false); // audio.* never listed
    } finally {
      fx.cleanup();
    }
  });
});

// --- loadConfig cap knobs (2026-09-13 uncapped-create) ------------------------

describe('loadConfig cap knobs: absent/empty/0 = no limit, valid enforces, junk throws', () => {
  /** Minimal valid config file with the given extra lines in the block. */
  function configYaml(dir: string, extraLines: string[]): string {
    const p = join(dir, 'config.yaml');
    writeFileSync(
      p,
      ['voice_inbox:', '  inbox_topic: "-1001234567890_1040"', ...extraLines].join('\n'),
      'utf8'
    );
    return p;
  }

  function scratchDir(): string {
    return mkdtempSync(join(tmpdir(), 'voice-inbox-loadconfig-'));
  }

  it('max_upload_mb (1..1024): unset, "", whitespace, 0 → undefined; 50 → 50; junk → ConfigError', () => {
    const dir = scratchDir();
    try {
      assert.equal(loadConfig(configYaml(dir, [])).maxUploadMb, undefined);
      assert.equal(loadConfig(configYaml(dir, ['  max_upload_mb: ""'])).maxUploadMb, undefined);
      assert.equal(loadConfig(configYaml(dir, ['  max_upload_mb: "   "'])).maxUploadMb, undefined);
      assert.equal(loadConfig(configYaml(dir, ['  max_upload_mb: 0'])).maxUploadMb, undefined);
      assert.equal(loadConfig(configYaml(dir, ['  max_upload_mb: 50'])).maxUploadMb, 50);
      for (const bad of ['abc', '-1', '1025']) {
        assert.throws(() => loadConfig(configYaml(dir, [`  max_upload_mb: ${bad}`])), ConfigError);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('max_task_attachments (1..100): unset, "", whitespace, 0 → undefined; 10 → 10; junk → ConfigError', () => {
    const dir = scratchDir();
    try {
      assert.equal(loadConfig(configYaml(dir, [])).maxTaskAttachments, undefined);
      assert.equal(loadConfig(configYaml(dir, ['  max_task_attachments: ""'])).maxTaskAttachments, undefined);
      assert.equal(loadConfig(configYaml(dir, ['  max_task_attachments: "   "'])).maxTaskAttachments, undefined);
      assert.equal(loadConfig(configYaml(dir, ['  max_task_attachments: 0'])).maxTaskAttachments, undefined);
      assert.equal(loadConfig(configYaml(dir, ['  max_task_attachments: 10'])).maxTaskAttachments, 10);
      for (const bad of ['abc', '-1', '101']) {
        assert.throws(() => loadConfig(configYaml(dir, [`  max_task_attachments: ${bad}`])), ConfigError);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('max_attachment_total_mb (1..1024): unset, "", whitespace, 0 → undefined; 100 → 100; junk → ConfigError', () => {
    const dir = scratchDir();
    try {
      assert.equal(loadConfig(configYaml(dir, [])).maxAttachmentTotalMb, undefined);
      assert.equal(loadConfig(configYaml(dir, ['  max_attachment_total_mb: ""'])).maxAttachmentTotalMb, undefined);
      assert.equal(loadConfig(configYaml(dir, ['  max_attachment_total_mb: "   "'])).maxAttachmentTotalMb, undefined);
      assert.equal(loadConfig(configYaml(dir, ['  max_attachment_total_mb: 0'])).maxAttachmentTotalMb, undefined);
      assert.equal(loadConfig(configYaml(dir, ['  max_attachment_total_mb: 100'])).maxAttachmentTotalMb, 100);
      for (const bad of ['abc', '-1', '1025']) {
        assert.throws(() => loadConfig(configYaml(dir, [`  max_attachment_total_mb: ${bad}`])), ConfigError);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('max_text_chars (1..1000000): unset, "", whitespace, 0 → undefined; 5000 → 5000; junk → ConfigError', () => {
    const dir = scratchDir();
    try {
      assert.equal(loadConfig(configYaml(dir, [])).maxTextChars, undefined);
      assert.equal(loadConfig(configYaml(dir, ['  max_text_chars: ""'])).maxTextChars, undefined);
      assert.equal(loadConfig(configYaml(dir, ['  max_text_chars: "   "'])).maxTextChars, undefined);
      assert.equal(loadConfig(configYaml(dir, ['  max_text_chars: 0'])).maxTextChars, undefined);
      assert.equal(loadConfig(configYaml(dir, ['  max_text_chars: 5000'])).maxTextChars, 5000);
      for (const bad of ['abc', '-1', '1000001']) {
        assert.throws(() => loadConfig(configYaml(dir, [`  max_text_chars: ${bad}`])), ConfigError);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/v1/kb (vi-19787afc4b2e)', () => {
  /** Fixture dirs under fx.dir + the kbRoots seam, set BEFORE driving
   * fx.handle. NEVER leave kbRoots unset: unset reads the operator's real
   * topic brains and Ecosystem KB — forbidden in tests. */
  function setKbRoots(fx: Fixture): { topicsDir: string; domainsDir: string } {
    const topicsDir = join(fx.dir, 'kb-topics');
    const domainsDir = join(fx.dir, 'kb-domains');
    mkdirSync(topicsDir, { recursive: true });
    mkdirSync(domainsDir, { recursive: true });
    fx.deps.kbRoots = { topicsDir, domainsDir };
    return { topicsDir, domainsDir };
  }

  it('serves parsed topics + domains with a valid Bearer', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      const { topicsDir, domainsDir } = setKbRoots(fx);
      mkdirSync(join(topicsDir, 'topic--1001234567890_2002'), { recursive: true });
      writeFileSync(
        join(topicsDir, 'topic--1001234567890_2002', 'BRAIN.md'),
        [
          '<!-- topic-brain: consolidated=2026-09-12T22:36:09.562323+05:30 covers=x -->',
          '# travel',
          '> Summary: Trip planning notes',
          '',
          '## Itinerary',
          '',
          '- Day 1: arrive',
        ].join('\n'),
        'utf8'
      );
      writeFileSync(
        join(domainsDir, 'Action Items.md'),
        'Open tasks, follow-ups, and commitments from PA conversations.\n\n## Urgent\n\n- [KAI-001] Book physical.\n',
        'utf8'
      );

      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/kb', { auth }));
      assert.equal(res.status, 200);
      const body = res.body as { ok: boolean; kb: { topics: Array<Record<string, unknown>>; domains: Array<Record<string, unknown>> } };
      assert.equal(body.ok, true);
      assert.equal(body.kb.topics.length, 1);
      const topic = body.kb.topics[0] as { title: string; consolidated: string | null; sections: Array<{ heading: string }> };
      assert.equal(topic.title, 'travel');
      assert.equal(topic.consolidated, '2026-09-12T22:36:09.562323+05:30');
      assert.equal(topic.sections[0].heading, 'Itinerary');
      assert.equal(body.kb.domains.length, 1);
      const domain = body.kb.domains[0] as { summary: string | null };
      // Summary fallback: no `> Summary: ` line → first surviving preamble line.
      assert.equal(domain.summary, 'Open tasks, follow-ups, and commitments from PA conversations.');
    } finally {
      fx.cleanup();
    }
  });

  it('is NOT tenant-scoped: any valid session reads the same kb', async () => {
    const fx = makeFixture();
    try {
      const authA = seedSession(fx, 424242, -1001234567890, 'Op A');
      const authB = seedSession(fx, 777, -100777, 'Op B');
      const { topicsDir, domainsDir } = setKbRoots(fx);
      mkdirSync(join(topicsDir, 'topic-a'), { recursive: true });
      writeFileSync(join(topicsDir, 'topic-a', 'BRAIN.md'), '# topic a\n\n> Summary: s\n', 'utf8');
      writeFileSync(join(domainsDir, 'one.md'), '# One\n\nDomain one.\n', 'utf8');

      const resA = await fx.handle(makeReq(fx, 'GET', '/api/v1/kb', { auth: authA }));
      const resB = await fx.handle(makeReq(fx, 'GET', '/api/v1/kb', { auth: authB }));
      assert.equal(resA.status, 200);
      assert.equal(resB.status, 200);
      assert.deepEqual(resB.body, resA.body);
    } finally {
      fx.cleanup();
    }
  });

  it('returns the pinned 401 without a valid Bearer', async () => {
    const fx = makeFixture();
    try {
      setKbRoots(fx);
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/kb'));
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { ok: false, error: 'unauthorized' });
    } finally {
      fx.cleanup();
    }
  });

  it('returns 500 knowledge base unavailable when a read fails', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      // topicsDir points at a REGULAR FILE: existsSync passes, readdirSync
      // throws ENOTDIR → the route's 500, never a stack trace.
      const filePath = join(fx.dir, 'kb-not-a-dir');
      writeFileSync(filePath, 'regular file', 'utf8');
      fx.deps.kbRoots = { topicsDir: filePath, domainsDir: join(fx.dir, 'kb-domains-absent') };
      const res = await fx.handle(makeReq(fx, 'GET', '/api/v1/kb', { auth }));
      assert.equal(res.status, 500);
      assert.deepEqual(res.body, { ok: false, error: 'knowledge base unavailable' });
    } finally {
      fx.cleanup();
    }
  });

  it('405 on non-GET', async () => {
    const fx = makeFixture();
    try {
      const auth = seedSession(fx, 424242, -1001234567890, 'Op');
      setKbRoots(fx);
      const res = await fx.handle(makeReq(fx, 'POST', '/api/v1/kb', { auth, json: {} }));
      assert.equal(res.status, 405);
    } finally {
      fx.cleanup();
    }
  });
});
