/**
 * Live screencast endpoint tests (AI-246, WP-A): the /api/v1/live family —
 * POST .../frame (ingest-token Bearer, cross-tenant), GET .../frame and
 * GET /live/:taskId (paired-device Bearer, tenant-scoped), DELETE
 * /live/:taskId (ingest-token) — plus the in-memory store's replace/TTL/clear
 * semantics, the taskDetail `live` flag, and the never-on-disk invariant
 * (proven failable against a known-bad store that writes to disk).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouter, type ApiRequest, type RouteDeps } from '../routes.js';
import type { VoiceInboxConfig } from '../config.js';
import { createTask, openLedger, upsertTenant, type TaskRow } from '../ledger.js';
import { createSession } from '../identity.js';
import { createScreencastStore, type ScreencastStore } from '../screencast-store.js';

const INGEST_TOKEN = 'screencast-ingest-test-token-9f2b7c';

// --- fixtures -----------------------------------------------------------------

interface FixtureOptions {
  /** null → no token configured (the disabled path); a string overrides. */
  ingestToken?: string | null;
  ttlMs?: number;
  maxBytes?: number;
  now?: () => number;
  sweepMs?: number;
}

interface Fixture {
  dir: string;
  db: ReturnType<typeof openLedger>;
  config: VoiceInboxConfig;
  store: ScreencastStore;
  deps: RouteDeps;
  handle: ReturnType<typeof createRouter>;
  cleanup: () => void;
}

function makeFixture(opts: FixtureOptions = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-screencast-'));
  const db = openLedger(join(dir, 'ledger.sqlite'));
  writeFileSync(
    join(dir, 'telegram-topic-names.json'),
    JSON.stringify({ '-1001234567890': { 1040: { name: 'Inbox', description: '' } } }),
    'utf8'
  );
  const config: VoiceInboxConfig = {
    port: 8787,
    inboxTopic: '-1001234567890_1040',
    sessionTtlHours: 168,
    pairingTtlMinutes: 10,
    minAudioBytes: 8192,
    screencastIngestToken:
      opts.ingestToken === null ? undefined : (opts.ingestToken ?? INGEST_TOKEN),
    screencastFrameTtlSeconds: Math.max(5, Math.ceil((opts.ttlMs ?? 30_000) / 1000)),
    screencastMaxFrameBytes: opts.maxBytes ?? 512 * 1024,
  };
  const store = createScreencastStore({
    ttlMs: opts.ttlMs ?? 30_000,
    maxBytes: opts.maxBytes ?? 512 * 1024,
    now: opts.now,
    sweepMs: opts.sweepMs,
  });
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
    screencastStore: store,
  };
  const prevPaHome = process.env.PA_HOME;
  process.env.PA_HOME = dir;
  return {
    dir,
    db,
    config,
    store,
    deps,
    handle: createRouter(deps),
    cleanup: () => {
      store.stop();
      try {
        db.close();
      } catch {
        /* already closed */
      }
      if (prevPaHome === undefined) {
        delete process.env.PA_HOME;
      } else {
        process.env.PA_HOME = prevPaHome;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Seed a tenant + session directly; returns { tenantId, bearer }. */
function seedSession(
  fx: Fixture,
  telegramUserId: number,
  name: string
): { tenantId: string; bearer: string } {
  const tenant = upsertTenant(fx.db, {
    telegramUserId,
    telegramChatId: -1001234567890,
    displayName: name,
  });
  const { token } = createSession(fx.db, tenant.tenant_id, 168);
  return { tenantId: tenant.tenant_id, bearer: `Bearer ${token}` };
}

function makeTask(fx: Fixture, tenantId: string): TaskRow {
  return createTask(fx.db, tenantId, { source: 'text', requestText: 'watch this page' });
}

interface ReqOptions {
  auth?: string;
  body?: Buffer;
  contentType?: string;
}

function makeReq(method: string, path: string, opts: ReqOptions = {}): ApiRequest {
  const url = new URL(path, 'http://127.0.0.1');
  const headers: Record<string, string | string[] | undefined> = {};
  if (opts.auth) headers['authorization'] = opts.auth;
  if (opts.contentType) headers['content-type'] = opts.contentType;
  return {
    method,
    pathname: url.pathname,
    query: url.searchParams,
    headers,
    body: opts.body ?? Buffer.alloc(0),
    remoteAddress: '203.0.113.9',
  };
}

const ingestAuth = `Bearer ${INGEST_TOKEN}`;

/** Minimal parseable JPEG: SOI + empty APP0 + SOF0 carrying width/height. */
function fakeJpeg(width: number, height: number): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    Buffer.from([0xff, 0xe0, 0x00, 0x02]), // APP0, len 2 (empty)
    Buffer.from([
      0xff, 0xc0, 0x00, 0x11, 0x08, // SOF0, len 17, precision 8
      (height >> 8) & 0xff, height & 0xff,
      (width >> 8) & 0xff, width & 0xff,
      0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]),
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
}

/** Files the task's dir holds — [] whether the dir is absent or empty. */
function taskFileEntries(fx: Fixture, taskId: string): string[] {
  try {
    return readdirSync(join(fx.deps.filesDir, taskId));
  } catch {
    return [];
  }
}

// --- store unit semantics ------------------------------------------------------

describe('createScreencastStore', () => {
  it('replaces the frame, never appends — only the newest survives', () => {
    const store = createScreencastStore({ ttlMs: 30_000, maxBytes: 1024 });
    try {
      assert.ok(store.putFrame('t', Buffer.from('first'), { width: 10, height: 20 }));
      assert.ok(store.putFrame('t', Buffer.from('second')));
      const frame = store.getFrame('t');
      assert.equal(frame?.buf.toString('utf8'), 'second');
      assert.equal(frame?.width, null); // meta not carried over on replace
      assert.equal(frame?.height, null);
    } finally {
      store.stop();
    }
  });

  it('rejects a frame over maxBytes and keeps the prior one', () => {
    const store = createScreencastStore({ ttlMs: 30_000, maxBytes: 8 });
    try {
      assert.ok(store.putFrame('t', Buffer.from('small')));
      assert.equal(store.putFrame('t', Buffer.alloc(9)), false);
      assert.equal(store.getFrame('t')?.buf.toString('utf8'), 'small');
    } finally {
      store.stop();
    }
  });

  it('TTL-evicts on read via the injected clock', () => {
    let nowMs = 1_000_000;
    const store = createScreencastStore({ ttlMs: 1_000, maxBytes: 1024, now: () => nowMs });
    try {
      store.putFrame('t', Buffer.from('x'));
      assert.ok(store.has('t'));
      nowMs += 999;
      assert.ok(store.has('t'));
      nowMs += 1; // exactly ttlMs old → stale
      assert.equal(store.has('t'), false);
      assert.equal(store.getFrame('t'), undefined);
      assert.deepEqual(store.meta('t'), { live: false, ts: null, width: null, height: null });
    } finally {
      store.stop();
    }
  });

  it('the sweeper evicts stale entries without a read', async () => {
    const store = createScreencastStore({ ttlMs: 30, maxBytes: 1024, sweepMs: 10 });
    try {
      store.putFrame('t', Buffer.from('x'));
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(store.has('t'), false);
    } finally {
      store.stop();
    }
  });

  it('meta reports live + ts + dims for a fresh frame; clear drops it', () => {
    let nowMs = 5_000;
    const store = createScreencastStore({ ttlMs: 1_000, maxBytes: 1024, now: () => nowMs });
    try {
      store.putFrame('t', Buffer.from('x'), { width: 800, height: 600 });
      assert.deepEqual(store.meta('t'), { live: true, ts: 5_000, width: 800, height: 600 });
      store.clear('t');
      assert.equal(store.has('t'), false);
      store.clear('t'); // idempotent
    } finally {
      store.stop();
    }
  });
});

// --- POST /api/v1/live/:taskId/frame --------------------------------------------

describe('POST /api/v1/live/:taskId/frame (ingest)', () => {
  it('ingests a JPEG under the ingest token → 200 {ok:true}', async () => {
    const fx = makeFixture();
    try {
      const { tenantId } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const frame = fakeJpeg(768, 1024);
      const res = await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
          auth: ingestAuth,
          body: frame,
          contentType: 'image/jpeg',
        })
      );
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.ok(fx.store.has(task.task_id));
    } finally {
      fx.cleanup();
    }
  });

  it('replaces the stored frame on a second ingest', async () => {
    const fx = makeFixture();
    try {
      const { tenantId } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      for (const [w, h] of [[320, 200], [1024, 768]] as const) {
        const res = await fx.handle(
          makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
            auth: ingestAuth,
            body: fakeJpeg(w, h),
            contentType: 'image/jpeg',
          })
        );
        assert.equal(res.status, 200);
      }
      assert.equal(fx.store.getFrame(task.task_id)?.width, 1024);
    } finally {
      fx.cleanup();
    }
  });

  it('401 on a wrong token, a missing header, and a paired-device session token', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      for (const auth of ['Bearer wrong-token', undefined, bearer]) {
        const res = await fx.handle(
          makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
            ...(auth ? { auth } : {}),
            body: fakeJpeg(4, 4),
            contentType: 'image/jpeg',
          })
        );
        assert.equal(res.status, 401, String(auth));
        assert.deepEqual(res.body, { ok: false, error: 'unauthorized' });
      }
      assert.equal(fx.store.has(task.task_id), false);
    } finally {
      fx.cleanup();
    }
  });

  it('404 on an unknown task id', async () => {
    const fx = makeFixture();
    try {
      const res = await fx.handle(
        makeReq('POST', '/api/v1/live/vi-000000000000/frame', {
          auth: ingestAuth,
          body: fakeJpeg(4, 4),
          contentType: 'image/jpeg',
        })
      );
      assert.equal(res.status, 404);
    } finally {
      fx.cleanup();
    }
  });

  it('is NOT tenant-scoped: the ingest token is the authority (cross-tenant task ok)', async () => {
    const fx = makeFixture();
    try {
      const a = seedSession(fx, 1001, 'A');
      seedSession(fx, 2002, 'B'); // a second tenant exists alongside
      const task = makeTask(fx, a.tenantId);
      const res = await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
          auth: ingestAuth,
          body: fakeJpeg(8, 8),
          contentType: 'image/jpeg',
        })
      );
      assert.equal(res.status, 200);
    } finally {
      fx.cleanup();
    }
  });

  it('413 on a frame over screencast_max_frame_bytes', async () => {
    const fx = makeFixture({ maxBytes: 64 });
    try {
      const { tenantId } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const res = await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
          auth: ingestAuth,
          body: fakeJpeg(200, 200), // ~40B of segments — pad past the cap
          contentType: 'image/jpeg',
        })
      );
      // fakeJpeg is ~30 bytes — under the cap; build a real over-cap body.
      const big = Buffer.concat([fakeJpeg(200, 200), Buffer.alloc(100)]);
      const over = await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
          auth: ingestAuth,
          body: big,
          contentType: 'image/jpeg',
        })
      );
      assert.equal(res.status, 200); // under-cap baseline ingests fine
      assert.equal(over.status, 413);
      assert.deepEqual(fx.store.getFrame(task.task_id)?.buf.equals(fakeJpeg(200, 200)), true);
    } finally {
      fx.cleanup();
    }
  });

  it('503 when no ingest token is configured — the token is never consulted', async () => {
    const fx = makeFixture({ ingestToken: null });
    try {
      const { tenantId } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const res = await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
          auth: ingestAuth,
          body: fakeJpeg(4, 4),
          contentType: 'image/jpeg',
        })
      );
      assert.equal(res.status, 503);
      assert.deepEqual(res.body, { ok: false, error: 'screencast disabled' });
    } finally {
      fx.cleanup();
    }
  });
});

// --- GET /api/v1/live/:taskId/frame ---------------------------------------------

describe('GET /api/v1/live/:taskId/frame (pull)', () => {
  it('returns the newest frame as image/jpeg bytes equal to what was ingested', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const frame = fakeJpeg(768, 1024);
      await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
          auth: ingestAuth,
          body: frame,
          contentType: 'image/jpeg',
        })
      );
      const res = await fx.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}/frame`, { auth: bearer })
      );
      assert.equal(res.status, 200);
      assert.equal(res.buffer?.contentType, 'image/jpeg');
      assert.ok(res.buffer !== undefined && res.buffer.data.equals(frame));
      assert.equal(res.body, null);
    } finally {
      fx.cleanup();
    }
  });

  it('204 when no frame exists; 204 again after the frame goes stale', async () => {
    let nowMs = 1_000_000;
    const fx = makeFixture({ ttlMs: 1_000, now: () => nowMs });
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const empty = await fx.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}/frame`, { auth: bearer })
      );
      assert.equal(empty.status, 204);
      await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
          auth: ingestAuth,
          body: fakeJpeg(4, 4),
          contentType: 'image/jpeg',
        })
      );
      nowMs += 2_000; // past ttlMs
      const stale = await fx.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}/frame`, { auth: bearer })
      );
      assert.equal(stale.status, 204);
    } finally {
      fx.cleanup();
    }
  });

  it('401 without a session; 404 for another tenant\'s task', async () => {
    const fx = makeFixture();
    try {
      const a = seedSession(fx, 1001, 'A');
      const b = seedSession(fx, 2002, 'B');
      const task = makeTask(fx, a.tenantId);
      await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
          auth: ingestAuth,
          body: fakeJpeg(4, 4),
          contentType: 'image/jpeg',
        })
      );
      const noAuth = await fx.handle(makeReq('GET', `/api/v1/live/${task.task_id}/frame`));
      assert.equal(noAuth.status, 401);
      const wrongTenant = await fx.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}/frame`, { auth: b.bearer })
      );
      assert.equal(wrongTenant.status, 404);
      const absent = await fx.handle(
        makeReq('GET', '/api/v1/live/vi-000000000000/frame', { auth: a.bearer })
      );
      assert.equal(absent.status, 404);
    } finally {
      fx.cleanup();
    }
  });
});

// --- GET /api/v1/live/:taskId ----------------------------------------------------

describe('GET /api/v1/live/:taskId (status)', () => {
  it('reports live:false before ingest, then live + ts + parsed dims after', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const before = await fx.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}`, { auth: bearer })
      );
      assert.equal(before.status, 200);
      assert.deepEqual(before.body, { ok: true, live: false, ts: null, width: null, height: null });
      await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
          auth: ingestAuth,
          body: fakeJpeg(768, 1024),
          contentType: 'image/jpeg',
        })
      );
      const after = await fx.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}`, { auth: bearer })
      );
      const body = after.body as Record<string, unknown>;
      assert.equal(body['ok'], true);
      assert.equal(body['live'], true);
      assert.equal(typeof body['ts'], 'number');
      assert.equal(body['width'], 768);
      assert.equal(body['height'], 1024);
    } finally {
      fx.cleanup();
    }
  });

  it('401 without a session; 404 cross-tenant and on an unknown task', async () => {
    const fx = makeFixture();
    try {
      const a = seedSession(fx, 1001, 'A');
      const b = seedSession(fx, 2002, 'B');
      const task = makeTask(fx, a.tenantId);
      assert.equal(
        (await fx.handle(makeReq('GET', `/api/v1/live/${task.task_id}`))).status,
        401
      );
      assert.equal(
        (await fx.handle(makeReq('GET', `/api/v1/live/${task.task_id}`, { auth: b.bearer }))).status,
        404
      );
      assert.equal(
        (await fx.handle(makeReq('GET', '/api/v1/live/vi-000000000000', { auth: a.bearer }))).status,
        404
      );
    } finally {
      fx.cleanup();
    }
  });
});

// --- DELETE /api/v1/live/:taskId --------------------------------------------------

describe('DELETE /api/v1/live/:taskId', () => {
  it('ingest-token DELETE clears the frame → pull 204, status live:false', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
          auth: ingestAuth,
          body: fakeJpeg(4, 4),
          contentType: 'image/jpeg',
        })
      );
      const del = await fx.handle(
        makeReq('DELETE', `/api/v1/live/${task.task_id}`, { auth: ingestAuth })
      );
      assert.equal(del.status, 200);
      assert.deepEqual(del.body, { ok: true });
      assert.equal(fx.store.has(task.task_id), false);
      assert.equal(
        (await fx.handle(makeReq('GET', `/api/v1/live/${task.task_id}/frame`, { auth: bearer }))).status,
        204
      );
    } finally {
      fx.cleanup();
    }
  });

  it('401 on a session token (it is not the ingest token); 503 when disabled', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      assert.equal(
        (await fx.handle(makeReq('DELETE', `/api/v1/live/${task.task_id}`, { auth: bearer }))).status,
        401
      );
    } finally {
      fx.cleanup();
    }
    const off = makeFixture({ ingestToken: null });
    try {
      const { tenantId } = seedSession(off, 1001, 'A');
      const task = makeTask(off, tenantId);
      assert.equal(
        (await off.handle(makeReq('DELETE', `/api/v1/live/${task.task_id}`, { auth: ingestAuth }))).status,
        503
      );
    } finally {
      off.cleanup();
    }
  });

  it('DELETE on an unknown task still clears → 200 (idempotent)', async () => {
    const fx = makeFixture();
    try {
      const res = await fx.handle(
        makeReq('DELETE', '/api/v1/live/vi-000000000000', { auth: ingestAuth })
      );
      assert.equal(res.status, 200);
    } finally {
      fx.cleanup();
    }
  });
});

// --- taskDetail live flag ---------------------------------------------------------

describe('taskDetail live flag', () => {
  it('flips true after ingest and false after clear / TTL eviction', async () => {
    let nowMs = 1_000_000;
    const fx = makeFixture({ ttlMs: 1_000, now: () => nowMs });
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const detail = async () =>
        (await fx.handle(makeReq('GET', `/api/v1/tasks/${task.task_id}`, { auth: bearer })))
          .body as { task: { live: boolean } };
      assert.equal((await detail()).task.live, false);
      await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
          auth: ingestAuth,
          body: fakeJpeg(4, 4),
          contentType: 'image/jpeg',
        })
      );
      assert.equal((await detail()).task.live, true);
      nowMs += 2_000;
      assert.equal((await detail()).task.live, false);
      await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
          auth: ingestAuth,
          body: fakeJpeg(4, 4),
          contentType: 'image/jpeg',
        })
      );
      assert.equal((await detail()).task.live, true);
      await fx.handle(makeReq('DELETE', `/api/v1/live/${task.task_id}`, { auth: ingestAuth }));
      assert.equal((await detail()).task.live, false);
    } finally {
      fx.cleanup();
    }
  });
});

// --- shape guards -----------------------------------------------------------------

describe('live route shape guards', () => {
  it('404 on /live, /live/x/unknown and deep paths; 405 on wrong methods', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      for (const p of ['/api/v1/live', `/api/v1/live/${task.task_id}/nope`, `/api/v1/live/${task.task_id}/frame/extra`]) {
        assert.equal((await fx.handle(makeReq('GET', p, { auth: bearer }))).status, 404, p);
      }
      assert.equal(
        (await fx.handle(makeReq('PUT', `/api/v1/live/${task.task_id}/frame`, { auth: ingestAuth }))).status,
        405
      );
      assert.equal(
        (await fx.handle(makeReq('POST', `/api/v1/live/${task.task_id}`, { auth: ingestAuth }))).status,
        405
      );
      assert.equal(
        (await fx.handle(makeReq('DELETE', `/api/v1/live/${task.task_id}/frame`, { auth: ingestAuth }))).status,
        405
      );
    } finally {
      fx.cleanup();
    }
  });
});

// --- the never-on-disk invariant --------------------------------------------------

describe('frames never touch files/<task_id>/ (the never-on-disk rule)', () => {
  it('a full ingest→pull→clear cycle writes NOTHING under files/<taskId>/', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const post = await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
          auth: ingestAuth,
          body: fakeJpeg(768, 1024),
          contentType: 'image/jpeg',
        })
      );
      assert.equal(post.status, 200);
      const pull = await fx.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}/frame`, { auth: bearer })
      );
      assert.equal(pull.status, 200);
      await fx.handle(makeReq('GET', `/api/v1/live/${task.task_id}`, { auth: bearer }));
      await fx.handle(makeReq('DELETE', `/api/v1/live/${task.task_id}`, { auth: ingestAuth }));
      assert.equal(existsSync(join(fx.deps.filesDir, task.task_id)), false);
      assert.deepEqual(taskFileEntries(fx, task.task_id), []);
    } finally {
      fx.cleanup();
    }
  });

  it('the invariant CAN FAIL: a putFrame that writes to disk trips it (known-bad)', async () => {
    const fx = makeFixture();
    try {
      const { tenantId } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      // Deliberately broken store: persists every frame under files/<taskId>/ —
      // exactly the violation the invariant exists to catch. The router reads
      // deps.screencastStore per request, so the swap takes effect here.
      const bad = createScreencastStore({ ttlMs: 30_000, maxBytes: 512 * 1024 });
      const inner = bad.putFrame.bind(bad);
      bad.putFrame = (taskId, buf, meta) => {
        const dir = join(fx.deps.filesDir, taskId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'frame.jpg'), buf);
        return inner(taskId, buf, meta);
      };
      fx.deps.screencastStore = bad;
      const res = await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
          auth: ingestAuth,
          body: fakeJpeg(4, 4),
          contentType: 'image/jpeg',
        })
      );
      assert.equal(res.status, 200);
      assert.ok(taskFileEntries(fx, task.task_id).includes('frame.jpg'));
      assert.throws(() => assert.deepEqual(taskFileEntries(fx, task.task_id), []));
      bad.stop();
    } finally {
      fx.cleanup();
    }
  });
});
