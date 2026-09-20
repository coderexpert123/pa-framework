/**
 * Live screencast INPUT endpoint tests (AI-246 v2, WP-F): POST
 * /api/v1/live/:taskId/input (paired-device Bearer, tenant-scoped), GET
 * /api/v1/live/:taskId/input?since=<seq> (ingest-token long-poll), the
 * in-memory input store's seq/overflow/drain/rate/clear semantics, the
 * DELETE-side input clear, and the never-on-disk invariant (proven
 * failable against a known-bad disk-writing store — same pattern as the
 * v1 frame store test).
 *
 * Auth split under test: POST input answers ONLY a paired-device session
 * (an ingest token is refused), GET input answers ONLY the ingest token
 * (a paired-device session is refused).
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
import {
  createScreencastInputStore,
  type ScreencastInputCommand,
  type ScreencastInputStore,
} from '../screencast-input-store.js';

const INGEST_TOKEN = 'screencast-ingest-test-token-9f2b7c';

// --- fixtures -----------------------------------------------------------------

interface FixtureOptions {
  /** null → no token configured (the disabled ingest path); a string overrides. */
  ingestToken?: string | null;
  /** false → screencast_input_enabled:false (the disabled input path). */
  inputEnabled?: boolean;
  /** true → screencastInputStore omitted from RouteDeps (the disabled shape). */
  noInputStore?: boolean;
  maxQueue?: number;
  maxText?: number;
  maxUrl?: number;
  ratePerSec?: number;
  now?: () => number;
}

interface Fixture {
  dir: string;
  db: ReturnType<typeof openLedger>;
  config: VoiceInboxConfig;
  frameStore: ScreencastStore;
  inputStore: ScreencastInputStore | undefined;
  deps: RouteDeps;
  handle: ReturnType<typeof createRouter>;
  cleanup: () => void;
}

function makeFixture(opts: FixtureOptions = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-screencast-input-'));
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
    screencastFrameTtlSeconds: 30,
    screencastMaxFrameBytes: 512 * 1024,
    screencastInputEnabled: opts.inputEnabled ?? true,
    screencastInputMaxQueue: opts.maxQueue ?? 64,
    screencastInputMaxText: opts.maxText ?? 4096,
    screencastInputMaxUrl: opts.maxUrl ?? 2048,
    screencastInputRatePerSec: opts.ratePerSec ?? 20,
  };
  const frameStore = createScreencastStore({ ttlMs: 30_000, maxBytes: 512 * 1024 });
  const inputStore = createScreencastInputStore({
    maxQueuePerTask: opts.maxQueue ?? 64,
    maxTextLen: opts.maxText ?? 4096,
    maxUrlLen: opts.maxUrl ?? 2048,
    rateLimitPerSec: opts.ratePerSec ?? 20,
    now: opts.now,
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
    screencastStore: frameStore,
    ...(opts.noInputStore === true ? {} : { screencastInputStore: inputStore }),
  };
  const prevPaHome = process.env.PA_HOME;
  process.env.PA_HOME = dir;
  return {
    dir,
    db,
    config,
    frameStore,
    inputStore: opts.noInputStore === true ? undefined : inputStore,
    deps,
    handle: createRouter(deps),
    cleanup: () => {
      inputStore.stop();
      frameStore.stop();
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
  return createTask(fx.db, tenantId, { source: 'text', requestText: 'drive this page' });
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

function jsonBody(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

const tap: ScreencastInputCommand = { type: 'tap', x: 100, y: 200 };

/** Minimal parseable JPEG: SOI + empty APP0 + SOF0 carrying width/height
 *  (same construction as the v1 screencast tests). */
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

describe('createScreencastInputStore', () => {
  const make = (over: Partial<Parameters<typeof createScreencastInputStore>[0]> = {}) =>
    createScreencastInputStore({
      maxQueuePerTask: 8,
      maxTextLen: 16,
      maxUrlLen: 32,
      rateLimitPerSec: 100,
      ...over,
    });

  it('assigns a per-task monotonic seq starting at 1', () => {
    const store = make();
    try {
      assert.equal(store.enqueue('a', tap), 1);
      assert.equal(store.enqueue('a', tap), 2);
      assert.equal(store.enqueue('b', tap), 1); // per-task, not global
      assert.equal(store.enqueue('a', tap), 3);
    } finally {
      store.stop();
    }
  });

  it('drops the OLDEST command on overflow — the queue never rejects for fullness', () => {
    const store = make({ maxQueuePerTask: 3 });
    try {
      for (let i = 0; i < 5; i++) {
        const seq = store.enqueue('t', { type: 'key', key: `k${i}` });
        assert.equal(typeof seq, 'number');
      }
      const drained = store.drainSince('t', 0);
      assert.deepEqual(drained.cmds.map((c) => c.seq), [3, 4, 5]); // 1 and 2 dropped
      assert.equal(drained.maxSeq, 5);
    } finally {
      store.stop();
    }
  });

  it('drainSince returns only newer commands and REMOVES them (drained, not peeked)', () => {
    const store = make();
    try {
      store.enqueue('t', tap);
      store.enqueue('t', { type: 'scroll', x: 1, y: 1, deltaX: 0, deltaY: 40 });
      store.enqueue('t', { type: 'back' });
      const first = store.drainSince('t', 1);
      assert.deepEqual(first.cmds.map((c) => c.seq), [2, 3]);
      assert.equal(first.cmds[0]?.type, 'scroll');
      assert.equal(first.maxSeq, 3);
      // A re-drain of the same cursor sees nothing — consumed is consumed.
      const again = store.drainSince('t', 1);
      assert.deepEqual(again.cmds, []);
      assert.equal(again.maxSeq, 3);
      // But seq 1 was never drained (the first drain asked since=1): it is
      // still queued BELOW the cursor, so a fresh since=0 consumer can still
      // recover it.
      assert.deepEqual(
        store.drainSince('t', 0).cmds.map((c) => c.seq),
        [1]
      );
      // An unknown task drains empty with maxSeq 0.
      assert.deepEqual(store.drainSince('never-seen', 0), { cmds: [], maxSeq: 0 });
    } finally {
      store.stop();
    }
  });

  it('drainSinceWait resolves the moment a command lands', async () => {
    const store = make();
    try {
      const pending = store.drainSinceWait('t', 0, 5_000);
      store.enqueue('t', tap);
      const drained = await pending;
      assert.ok(drained !== null);
      assert.deepEqual(drained.cmds.map((c) => c.seq), [1]);
      assert.equal(drained.maxSeq, 1);
    } finally {
      store.stop();
    }
  });

  it('drainSinceWait answers null on timeout and honors the since cursor', async () => {
    const store = make();
    try {
      store.enqueue('t', tap); // seq 1
      assert.equal(await store.drainSinceWait('t', 1, 30), null); // nothing newer than 1
      // The skipped seq-1 command is still queued below that cursor — a
      // since=0 poll drains it immediately, then the well is dry.
      const recovered = await store.drainSinceWait('t', 0, 0);
      assert.deepEqual(recovered?.cmds.map((c) => c.seq), [1]);
      assert.equal(await store.drainSinceWait('t', 0, 0), null);
    } finally {
      store.stop();
    }
  });

  it('rate-limits per task inside the sliding 1 s window (injected clock)', () => {
    let nowMs = 1_000_000;
    const store = make({ rateLimitPerSec: 2, now: () => nowMs });
    try {
      assert.equal(store.enqueue('t', tap), 1);
      assert.equal(store.enqueue('t', tap), 2);
      assert.equal(store.enqueue('t', tap), 'rate-limited'); // third inside 1 s
      assert.equal(store.enqueue('other', tap), 1); // limit is PER TASK
      nowMs += 1_001;
      assert.equal(store.enqueue('t', tap), 3); // window slid — accepted again
    } finally {
      store.stop();
    }
  });

  it('rejects over-length text/url at the store edge (defense in depth)', () => {
    const store = make({ maxTextLen: 4, maxUrlLen: 8 });
    try {
      assert.equal(store.enqueue('t', { type: 'type', text: 'abcde' }), 'invalid');
      assert.equal(store.enqueue('t', { type: 'navigate', url: 'https://x.co' }), 'invalid');
      assert.equal(store.enqueue('t', { type: 'type', text: 'abcd' }), 1);
    } finally {
      store.stop();
    }
  });

  it('clear drops queued commands but keeps seq monotonic; resolves waiters null', async () => {
    const store = make();
    try {
      store.enqueue('t', tap); // seq 1
      store.enqueue('t', tap); // seq 2
      store.clear('t');
      assert.deepEqual(store.drainSince('t', 0).cmds, []);
      assert.equal(store.enqueue('t', tap), 3); // seq did NOT reset
      const pending = store.drainSinceWait('t', 3, 5_000);
      store.clear('t');
      assert.equal(await pending, null);
      store.clear('never-seen'); // idempotent on an unknown task
    } finally {
      store.stop();
    }
  });

  it('stop resolves every pending waiter with null', async () => {
    const store = make();
    const a = store.drainSinceWait('t', 0, 60_000);
    const b = store.drainSinceWait('u', 0, 60_000);
    store.stop();
    assert.equal(await a, null);
    assert.equal(await b, null);
  });

  it('lastInputAt stamps each ACCEPTED enqueue, survives clear, and drops on stop', () => {
    let nowMs = 1_700_000_000_000;
    const store = make({ now: () => nowMs, rateLimitPerSec: 1 });
    try {
      assert.equal(store.lastInputAt('t'), null); // never enqueued
      assert.equal(store.enqueue('t', tap), 1);
      assert.equal(store.lastInputAt('t'), 1_700_000_000_000);
      nowMs += 100;
      // A REJECTED enqueue (rate-limited) must not move the record — the
      // spec sets it only when the return value is a seq number.
      assert.equal(store.enqueue('t', tap), 'rate-limited');
      assert.equal(store.lastInputAt('t'), 1_700_000_000_000);
      // clear() drains the queue but the input record outlives it (same rule
      // as the seq counter) — the resume signal must still fire.
      store.clear('t');
      assert.equal(store.lastInputAt('t'), 1_700_000_000_000);
      // The next accepted enqueue re-stamps it.
      nowMs += 1_000;
      assert.equal(store.enqueue('t', tap), 2);
      assert.equal(store.lastInputAt('t'), 1_700_000_001_100);
    } finally {
      store.stop();
    }
    assert.equal(store.lastInputAt('t'), null); // stop() forgets all state
  });
});

// --- POST /api/v1/live/:taskId/input ---------------------------------------------

describe('POST /api/v1/live/:taskId/input (operator enqueue)', () => {
  it('enqueues a valid command → 200 {ok:true, seq} with a rising seq', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const first = await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
          auth: bearer,
          body: jsonBody(tap),
          contentType: 'application/json',
        })
      );
      assert.equal(first.status, 200);
      assert.deepEqual(first.body, { ok: true, seq: 1 });
      const second = await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
          auth: bearer,
          body: jsonBody({ type: 'type', text: 'hello' }),
          contentType: 'application/json',
        })
      );
      assert.equal(second.status, 200);
      assert.deepEqual(second.body, { ok: true, seq: 2 });
    } finally {
      fx.cleanup();
    }
  });

  it('401 without a session — and the INGEST token is refused here (auth split)', async () => {
    const fx = makeFixture();
    try {
      const { tenantId } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      for (const auth of [undefined, 'Bearer wrong-token', ingestAuth]) {
        const res = await fx.handle(
          makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
            ...(auth ? { auth } : {}),
            body: jsonBody(tap),
            contentType: 'application/json',
          })
        );
        assert.equal(res.status, 401, String(auth));
        assert.deepEqual(res.body, { ok: false, error: 'unauthorized' });
      }
      // Nothing reached the queue.
      assert.deepEqual(fx.inputStore?.drainSince(task.task_id, 0).cmds, []);
    } finally {
      fx.cleanup();
    }
  });

  it('404 on an unknown task and on another tenant\'s task', async () => {
    const fx = makeFixture();
    try {
      const a = seedSession(fx, 1001, 'A');
      const b = seedSession(fx, 2002, 'B');
      const task = makeTask(fx, a.tenantId);
      const unknown = await fx.handle(
        makeReq('POST', '/api/v1/live/vi-000000000000/input', {
          auth: a.bearer,
          body: jsonBody(tap),
          contentType: 'application/json',
        })
      );
      assert.equal(unknown.status, 404);
      const crossTenant = await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
          auth: b.bearer,
          body: jsonBody(tap),
          contentType: 'application/json',
        })
      );
      assert.equal(crossTenant.status, 404);
    } finally {
      fx.cleanup();
    }
  });

  it('400 on every off-shape command the validator owns', async () => {
    const fx = makeFixture({ maxText: 8, maxUrl: 32 });
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const post = (cmd: unknown) =>
        fx.handle(
          makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
            auth: bearer,
            body: jsonBody(cmd),
            contentType: 'application/json',
          })
        );
      const cases: Array<[unknown, string]> = [
        [{}, 'no type'],
        [{ type: 'kick' }, 'unknown type'],
        [{ type: 'tap' }, 'missing coords'],
        [{ type: 'tap', x: -1, y: 5 }, 'negative coord'],
        [{ type: 'tap', x: 1, y: 5000 }, 'over 4096 bound'],
        [{ type: 'tap', x: 'a', y: 1 }, 'non-number coord'],
        [{ type: 'scroll', x: 1, y: 1, deltaX: 0 }, 'missing deltaY'],
        [{ type: 'longpress', x: 1, y: 1, durationMs: 0 }, 'duration under 1'],
        [{ type: 'pinch', x: 1, y: 1, scaleFactor: 0 }, 'scaleFactor 0'],
        [{ type: 'type', text: '' }, 'empty text'],
        [{ type: 'type', text: '123456789' }, 'text over max'],
        [{ type: 'key' }, 'missing key'],
        [{ type: 'key', key: 'Enter', modifiers: 'ctrl' }, 'modifiers not array'],
        [{ type: 'navigate' }, 'missing url'],
        [{ type: 'navigate', url: 'javascript:alert(1)' }, 'bad scheme'],
        [{ type: 'navigate', url: 'file:///etc/passwd' }, 'file scheme'],
        [{ type: 'navigate', url: `https://${'a'.repeat(64)}.com` }, 'url over max'],
      ];
      for (const [cmd, label] of cases) {
        const res = await post(cmd);
        assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.body)}`);
      }
      // Non-JSON and non-object bodies are 400s too.
      assert.equal(
        (
          await fx.handle(
            makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
              auth: bearer,
              body: Buffer.from('not json', 'utf8'),
            })
          )
        ).status,
        400
      );
      assert.equal((await post([1, 2, 3])).status, 400);
    } finally {
      fx.cleanup();
    }
  });

  it('accepts every command type in the allowed set', async () => {
    const fx = makeFixture({ ratePerSec: 100 });
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const cmds: ScreencastInputCommand[] = [
        { type: 'tap', x: 1, y: 2 },
        { type: 'doubletap', x: 3, y: 4 },
        { type: 'longpress', x: 5, y: 6, durationMs: 800 },
        { type: 'scroll', x: 7, y: 8, deltaX: 0, deltaY: -240 },
        { type: 'pinch', x: 9, y: 10, scaleFactor: 1.5 },
        { type: 'type', text: 'hi there' },
        { type: 'key', key: 'Enter', code: 'Enter', modifiers: ['Control'] },
        { type: 'navigate', url: 'https://example.com/' },
        { type: 'navigate', url: 'data:text/html,<b>x</b>' },
        { type: 'back' },
        { type: 'forward' },
        { type: 'reload' },
      ];
      for (let i = 0; i < cmds.length; i++) {
        const res = await fx.handle(
          makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
            auth: bearer,
            body: jsonBody(cmds[i]),
            contentType: 'application/json',
          })
        );
        assert.equal(res.status, 200, `cmd ${i}: ${JSON.stringify(res.body)}`);
        assert.deepEqual(res.body, { ok: true, seq: i + 1 });
      }
      // The queue holds them normalized — stray fields never made it in.
      const drained = fx.inputStore?.drainSince(task.task_id, 0);
      assert.equal(drained?.cmds.length, cmds.length);
      assert.equal(drained?.cmds[2]?.durationMs, 800);
      assert.equal(drained?.cmds[8]?.url, 'data:text/html,<b>x</b>');
    } finally {
      fx.cleanup();
    }
  });

  it('bounds coords by the live frame dims when known, else 4096', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const post = (x: number, y: number) =>
        fx.handle(
          makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
            auth: bearer,
            body: jsonBody({ type: 'tap', x, y }),
            contentType: 'application/json',
          })
        );
      assert.equal((await post(4096, 4096)).status, 200); // no frame → 4096 cap
      assert.equal((await post(4097, 1)).status, 400);
      // Ingest a 100×50 frame → the bound tightens to the real page dims.
      await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/frame`, {
          auth: ingestAuth,
          body: fakeJpeg(100, 50),
          contentType: 'image/jpeg',
        })
      );
      assert.equal((await post(101, 10)).status, 400); // x over page width
      assert.equal((await post(50, 51)).status, 400); // y over page height
      assert.equal((await post(100, 50)).status, 200); // exactly on the bound
    } finally {
      fx.cleanup();
    }
  });

  it('413 once the per-task per-second rate budget overflows', async () => {
    const fx = makeFixture({ ratePerSec: 3 });
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const post = () =>
        fx.handle(
          makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
            auth: bearer,
            body: jsonBody(tap),
            contentType: 'application/json',
          })
        );
      assert.equal((await post()).status, 200);
      assert.equal((await post()).status, 200);
      assert.equal((await post()).status, 200);
      const over = await post();
      assert.equal(over.status, 413);
    } finally {
      fx.cleanup();
    }
  });

  it('503 when screencast_input_enabled is false, and when the store is absent', async () => {
    const off = makeFixture({ inputEnabled: false });
    try {
      const { tenantId, bearer } = seedSession(off, 1001, 'A');
      const task = makeTask(off, tenantId);
      const res = await off.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
          auth: bearer,
          body: jsonBody(tap),
          contentType: 'application/json',
        })
      );
      assert.equal(res.status, 503);
      assert.deepEqual(res.body, { ok: false, error: 'screencast input disabled' });
    } finally {
      off.cleanup();
    }
    const absent = makeFixture({ noInputStore: true });
    try {
      const { tenantId, bearer } = seedSession(absent, 1001, 'A');
      const task = makeTask(absent, tenantId);
      const res = await absent.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
          auth: bearer,
          body: jsonBody(tap),
          contentType: 'application/json',
        })
      );
      assert.equal(res.status, 503);
    } finally {
      absent.cleanup();
    }
  });
});

// --- GET /api/v1/live/:taskId/input ----------------------------------------------

describe('GET /api/v1/live/:taskId/input (bridge long-poll)', () => {
  const post = (fx: Fixture, bearer: string, taskId: string, cmd: unknown) =>
    fx.handle(
      makeReq('POST', `/api/v1/live/${taskId}/input`, {
        auth: bearer,
        body: jsonBody(cmd),
        contentType: 'application/json',
      })
    );

  it('drains queued commands as {cmds, maxSeq} — each carrying its seq', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      await post(fx, bearer, task.task_id, tap);
      await post(fx, bearer, task.task_id, { type: 'type', text: 'abc' });
      const res = await fx.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}/input?since=0&wait_ms=0`, {
          auth: ingestAuth,
        })
      );
      assert.equal(res.status, 200);
      const body = res.body as { ok: boolean; cmds: Array<Record<string, unknown>>; maxSeq: number };
      assert.equal(body.ok, true);
      assert.equal(body.maxSeq, 2);
      assert.deepEqual(
        body.cmds.map((c) => c['seq']),
        [1, 2]
      );
      assert.equal(body.cmds[0]?.['type'], 'tap');
      assert.equal(body.cmds[1]?.['text'], 'abc');
      // Drained is drained — the next poll sees nothing.
      const again = await fx.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}/input?since=0&wait_ms=0`, {
          auth: ingestAuth,
        })
      );
      assert.equal(again.status, 204);
    } finally {
      fx.cleanup();
    }
  });

  it('honors the since cursor: only newer commands are returned', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      await post(fx, bearer, task.task_id, tap); // seq 1
      await post(fx, bearer, task.task_id, tap); // seq 2
      const res = await fx.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}/input?since=1&wait_ms=0`, {
          auth: ingestAuth,
        })
      );
      assert.equal(res.status, 200);
      const body = res.body as { cmds: Array<Record<string, unknown>>; maxSeq: number };
      assert.deepEqual(
        body.cmds.map((c) => c['seq']),
        [2]
      );
    } finally {
      fx.cleanup();
    }
  });

  it('204 when nothing arrives inside the wait window; since defaults to 0', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const empty = await fx.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}/input?wait_ms=50`, { auth: ingestAuth })
      );
      assert.equal(empty.status, 204);
      assert.equal(empty.body, null);
      // No `since` at all → defaults to 0 and drains what is there.
      await post(fx, bearer, task.task_id, tap);
      const defaulted = await fx.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}/input?wait_ms=50`, { auth: ingestAuth })
      );
      assert.equal(defaulted.status, 200);
    } finally {
      fx.cleanup();
    }
  });

  it('long-polls: a POST landing mid-wait wakes the poll with the command', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const poll = fx.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}/input?since=0&wait_ms=5000`, {
          auth: ingestAuth,
        })
      );
      await post(fx, bearer, task.task_id, { type: 'key', key: 'Escape' });
      const res = await poll; // resolves on the enqueue, NOT on the 5 s timer
      assert.equal(res.status, 200);
      const body = res.body as { cmds: Array<Record<string, unknown>>; maxSeq: number };
      assert.equal(body.cmds[0]?.['key'], 'Escape');
      assert.equal(body.maxSeq, 1);
    } finally {
      fx.cleanup();
    }
  });

  it('401 on a paired-device session token (auth split), a bad token, and no header', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      for (const auth of [bearer, 'Bearer wrong-token', undefined]) {
        const res = await fx.handle(
          makeReq('GET', `/api/v1/live/${task.task_id}/input?wait_ms=0`, {
            ...(auth ? { auth } : {}),
          })
        );
        assert.equal(res.status, 401, String(auth));
        assert.deepEqual(res.body, { ok: false, error: 'unauthorized' });
      }
    } finally {
      fx.cleanup();
    }
  });

  it('404 on an unknown task id (ingest token is the authority — cross-tenant ok)', async () => {
    const fx = makeFixture();
    try {
      const a = seedSession(fx, 1001, 'A');
      const b = seedSession(fx, 2002, 'B');
      const taskB = makeTask(fx, b.tenantId);
      assert.equal(
        (
          await fx.handle(
            makeReq('GET', '/api/v1/live/vi-000000000000/input?wait_ms=0', { auth: ingestAuth })
          )
        ).status,
        404
      );
      // NOT tenant-scoped, by design: the shared ingest token drains any
      // tenant's task — the bridge carries no session (same rule as ingest).
      await post(fx, b.bearer, taskB.task_id, tap);
      const cross = await fx.handle(
        makeReq('GET', `/api/v1/live/${taskB.task_id}/input?wait_ms=0`, { auth: ingestAuth })
      );
      assert.equal(cross.status, 200);
      void a;
    } finally {
      fx.cleanup();
    }
  });

  it('400 on a malformed since / wait_ms', async () => {
    const fx = makeFixture();
    try {
      const { tenantId } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      for (const q of ['since=abc', 'since=-1', 'since=1.5', 'wait_ms=-4']) {
        const res = await fx.handle(
          makeReq('GET', `/api/v1/live/${task.task_id}/input?${q}`, { auth: ingestAuth })
        );
        assert.equal(res.status, 400, q);
      }
    } finally {
      fx.cleanup();
    }
  });

  it('503 when disabled — before auth is even consulted', async () => {
    const off = makeFixture({ inputEnabled: false });
    try {
      const { tenantId } = seedSession(off, 1001, 'A');
      const task = makeTask(off, tenantId);
      const res = await off.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}/input?wait_ms=0`, { auth: ingestAuth })
      );
      assert.equal(res.status, 503);
      assert.deepEqual(res.body, { ok: false, error: 'screencast input disabled' });
      const absent = await off.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}/input?wait_ms=0`)
      );
      assert.equal(absent.status, 503); // no token at all still 503s first
    } finally {
      off.cleanup();
    }
    const absentStore = makeFixture({ noInputStore: true });
    try {
      const { tenantId } = seedSession(absentStore, 1001, 'A');
      const task = makeTask(absentStore, tenantId);
      const res = await absentStore.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}/input?wait_ms=0`, { auth: ingestAuth })
      );
      assert.equal(res.status, 503);
    } finally {
      absentStore.cleanup();
    }
  });
});

// --- DELETE clears the input queue too -------------------------------------------

describe('DELETE /api/v1/live/:taskId clears pending input', () => {
  it('queued commands do not outlive the bridge; seq stays monotonic', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
          auth: bearer,
          body: jsonBody(tap),
          contentType: 'application/json',
        })
      );
      const del = await fx.handle(
        makeReq('DELETE', `/api/v1/live/${task.task_id}`, { auth: ingestAuth })
      );
      assert.equal(del.status, 200);
      const drained = await fx.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}/input?wait_ms=0`, { auth: ingestAuth })
      );
      assert.equal(drained.status, 204); // nothing survived the clear
      // And the seq counter survived: the next enqueue continues, not resets.
      const after = await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
          auth: bearer,
          body: jsonBody(tap),
          contentType: 'application/json',
        })
      );
      assert.deepEqual(after.body, { ok: true, seq: 2 });
    } finally {
      fx.cleanup();
    }
  });
});

// --- the never-on-disk invariant -------------------------------------------------

describe('input commands never touch files/<task_id>/ (the never-on-disk rule)', () => {
  it('a full POST→poll→clear cycle writes NOTHING under files/<taskId>/', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const post = await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
          auth: bearer,
          body: jsonBody(tap),
          contentType: 'application/json',
        })
      );
      assert.equal(post.status, 200);
      const poll = await fx.handle(
        makeReq('GET', `/api/v1/live/${task.task_id}/input?wait_ms=0`, { auth: ingestAuth })
      );
      assert.equal(poll.status, 200);
      await fx.handle(makeReq('DELETE', `/api/v1/live/${task.task_id}`, { auth: ingestAuth }));
      assert.equal(existsSync(join(fx.deps.filesDir, task.task_id)), false);
      assert.deepEqual(taskFileEntries(fx, task.task_id), []);
    } finally {
      fx.cleanup();
    }
  });

  it('the invariant CAN FAIL: an enqueue that writes to disk trips it (known-bad)', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      // Deliberately broken store: persists every command under
      // files/<taskId>/ — exactly the violation the invariant exists to
      // catch. The router reads deps.screencastInputStore per request, so
      // the swap takes effect here.
      const bad = createScreencastInputStore({
        maxQueuePerTask: 64,
        maxTextLen: 4096,
        maxUrlLen: 2048,
        rateLimitPerSec: 20,
      });
      const inner = bad.enqueue.bind(bad);
      bad.enqueue = (taskId, cmd) => {
        const dir = join(fx.deps.filesDir, taskId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `input-${Date.now()}.json`), JSON.stringify(cmd));
        return inner(taskId, cmd);
      };
      fx.deps.screencastInputStore = bad;
      const res = await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
          auth: bearer,
          body: jsonBody(tap),
          contentType: 'application/json',
        })
      );
      assert.equal(res.status, 200);
      assert.ok(taskFileEntries(fx, task.task_id).length > 0);
      assert.throws(() => assert.deepEqual(taskFileEntries(fx, task.task_id), []));
      bad.stop();
    } finally {
      fx.cleanup();
    }
  });
});

// --- operator_input_at surface (AI-246 v2 WP-J) ---------------------------------

describe('operator_input_at (task detail + live status)', () => {
  it('appears on both surfaces only after the first accepted input POST', async () => {
    const inputAt = 1_700_000_000_000;
    const fx = makeFixture({ now: () => inputAt });
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      const detail = () =>
        fx.handle(makeReq('GET', `/api/v1/tasks/${task.task_id}`, { auth: bearer }));
      const status = () =>
        fx.handle(makeReq('GET', `/api/v1/live/${task.task_id}`, { auth: bearer }));
      // Before any operator input the key is ABSENT on both surfaces — not
      // null, omitted entirely.
      const dBefore = (await detail()).body as { task: Record<string, unknown> };
      assert.equal('operator_input_at' in dBefore.task, false);
      const sBefore = (await status()).body as Record<string, unknown>;
      assert.equal('operator_input_at' in sBefore, false);
      const post = await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
          auth: bearer,
          body: jsonBody(tap),
          contentType: 'application/json',
        })
      );
      assert.equal(post.status, 200);
      const dAfter = (await detail()).body as { task: Record<string, unknown> };
      assert.equal(dAfter.task['operator_input_at'], inputAt);
      const sAfter = (await status()).body as Record<string, unknown>;
      assert.equal(sAfter['operator_input_at'], inputAt);
    } finally {
      fx.cleanup();
    }
  });
});

// --- the fullscreen gate (SPEC gate 4) -----------------------------------------

describe('fullscreen gating (SPEC gate 4)', () => {
  // The invariant "NO input POST is sent when the pane is not fullscreen" is
  // enforced CLIENT-SIDE, in the PWA: app.js's postInput() is the single
  // funnel every command exits through and it refuses to fire while
  // liveInput.on is false, and the input listeners that produce commands are
  // attached only while the pane is fullscreen. The server has no window into
  // the PWA's fullscreen state — by design it accepts every authenticated
  // in-shape command, so this file pins only the server half of the contract:
  // the endpoint is up and takes the command. The client half lives in
  // screencast-live-pane.test.ts, whose vm smoke asserts no fetch leaves the
  // PWA while liveInput.on is false (and that exiting fullscreen detaches the
  // listeners); the end-to-end half was verified live in the R4 smoke.
  it('the server accepts a well-formed command unconditionally — fullscreen state never reaches it', async () => {
    const fx = makeFixture();
    try {
      const { tenantId, bearer } = seedSession(fx, 1001, 'A');
      const task = makeTask(fx, tenantId);
      // No frame stream exists at all — the task was never live. If the
      // server knew or cared about the pane's fullscreen state it would have
      // to refuse here; it does not, because gating is the PWA's job.
      const res = await fx.handle(
        makeReq('POST', `/api/v1/live/${task.task_id}/input`, {
          auth: bearer,
          body: jsonBody(tap),
          contentType: 'application/json',
        })
      );
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, seq: 1 });
    } finally {
      fx.cleanup();
    }
  });
});
