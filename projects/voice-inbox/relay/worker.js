// Voice-inbox edge relay — Workers entry + Mailbox Durable Object.
//
// Free-tier budget this design lives inside (verified live 2026-09-07):
// - Workers: 100k req/day, 10 ms CPU/request. All body movement is stream
//   pass-through; only envelope JSON (≤768 KiB raw → ~1.0 MiB base64) is ever
//   materialized — O(envelope), never O(body).
// - Durable Object (SQLite-backed class, free-plan-legal): 100k req/day,
//   13,000 GB-s/day duration. A continuously long-polled singleton accrues
//   0.125 GB × 86,400 s ≈ 10,800 GB-s/day — ~83% of the cap, single
//   occupancy by design (ONE DO per account: idFromName('mailbox')). The
//   KV-style storage API works on SQLite classes; key+value ≤ 2 MB (inline
//   envelopes ≤ ~1.1 MB — ≥45% headroom).
// - Long-poll: 86,400 s / 25 s ≈ 3,456 idle polls/day (~3.5% of the cap).
// - R2: 10 GB-month; 1M Class A (put) + 10M Class B (get) ops/month; egress
//   free. Inline↔R2 cutover at 768 KiB in BOTH directions: static assets and
//   JSON API responses ride the mailbox inline (one hop fewer); uploads and
//   large or unknown-length bodies stream through R2.
//
// At-most-once, by design: a claim is terminal — a claimed item is NEVER
// re-queued. If the poller dies mid-request, the browser gets the 504 at the
// deadline and the user retries. Re-delivery would re-EXECUTE a POST against
// the app (duplicate task creation) to save one visible retry — wrong trade.
// The durable queue lives ONLY in this DO's ctx.storage (strong
// consistency); KV is forbidden on this path.
//
// Testing: pure-logic unit tests over relay/protocol.js (mailbox model,
// header filters, envelopes, base64) + `wrangler deploy --dry-run` compile
// gate + scripts/relay_smoke.mjs real-runtime scenarios. No in-worker test
// framework — it would drag a second test runner into a node:test repo.

import {
  INLINE_BODY_MAX_BYTES,
  MAX_BODY_BYTES,
  POLL_WAIT_MAX_MS,
  R2_KEY_REQ,
  R2_KEY_RESP,
  RESPONSE_META_HEADER,
  SECRET_HEADER,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  classifyInboundBody,
  createMailboxModel,
  decodeResponseEnvelope,
  decodeResponseMeta,
  deadlineFor,
  filterRequestHeaders,
  filterResponseHeaders,
  timingSafeEqualHex,
} from './protocol.js';

const MAILBOX_ID_NAME = 'mailbox';

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function error(status, message) {
  return jsonResponse(status, { ok: false, error: message });
}

// §1.4: both sides of the secret comparison are SHA-256 hashed and the HEX
// DIGESTS are compared with a constant-time comparator — a presented value
// never rides a byte-compare against the live secret.
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

async function secretOk(request, env) {
  const presented = request.headers.get(SECRET_HEADER);
  if (presented === null || presented.length === 0) return false;
  if (typeof env.RELAY_SECRET !== 'string' || env.RELAY_SECRET.length === 0) return false;
  const [presentedHex, secretHex] = await Promise.all([sha256Hex(presented), sha256Hex(env.RELAY_SECRET)]);
  return timingSafeEqualHex(presentedHex, secretHex);
}

function mailboxStub(env) {
  return env.MAILBOX.get(env.MAILBOX.idFromName(MAILBOX_ID_NAME));
}

// The delivered Response: original status, §1.4-filtered headers,
// content-length re-set from the TRUE byte count, body from inline bytes or
// an R2 stream. The R2 branch wraps the stream so the object is deleted when
// the browser has consumed it (ctx.waitUntil keeps the cleanup alive).
async function responseFromEnvelope(env, ctx, envelope) {
  const headers = new Headers(filterResponseHeaders(new Headers(envelope.headers ?? [])));
  const status = envelope.status;
  const body = envelope.body;
  const hasResponseBody = status !== 204 && status !== 304;
  if (body && typeof body.inline_b64 === 'string') {
    const bytes = base64ToBytes(body.inline_b64);
    if (!hasResponseBody) return new Response(null, { status, headers });
    headers.set('content-length', String(bytes.length));
    return new Response(bytes, { status, headers });
  }
  if (body && typeof body.r2_key === 'string') {
    const obj = await env.RELAY_BUCKET.get(body.r2_key);
    if (!obj) throw new Error(`response object missing in R2: ${body.r2_key}`);
    if (!hasResponseBody) {
      ctx.waitUntil(env.RELAY_BUCKET.delete(body.r2_key).then(() => {}, () => {}));
      return new Response(null, { status, headers });
    }
    headers.set('content-length', String(obj.size));
    const { readable, writable } = new TransformStream();
    const cleanup = obj.body
      .pipeTo(writable)
      .catch(() => {})
      .then(() => env.RELAY_BUCKET.delete(body.r2_key).then(() => {}, () => {}));
    ctx.waitUntil(cleanup);
    return new Response(readable, { status, headers });
  }
  return new Response(null, { status, headers });
}

// §1.3 inbound decision, made HERE in the fetch handler — the DO never
// touches body bytes. classifyInboundBody decides: GET/HEAD or content-length
// exactly 0 → bodyless, the envelope parks with NO body key and R2 is never
// touched on the request leg; small known length → buffer inline; otherwise
// (including unknown length) stream to bucket.put("req/<id>.bin",
// request.body). The id is minted FIRST via a control roundtrip so the R2 key
// can carry it; a crash between allocate and park leaves an id gap, which is
// harmless (ids stay strictly monotonic). Known length over MAX_BODY_BYTES →
// 413 without reading the body.
async function handlePark(request, env, ctx, url) {
  const testMode = env.RELAY_TEST_MODE === '1';
  const deadline = deadlineFor(Date.now(), request.headers, testMode);
  const stub = mailboxStub(env);
  const lenHeader = request.headers.get('content-length');
  const knownLen = lenHeader === null ? NaN : Number(lenHeader);
  if (Number.isFinite(knownLen) && knownLen > MAX_BODY_BYTES) return error(413, 'payload too large');
  const bodyKind = classifyInboundBody(request.method, knownLen);
  let bodyField;
  let preallocatedId;
  if (bodyKind.kind === 'none') {
    // Bodyless (GET/HEAD or content-length: 0): no R2 round-trip, and the
    // parked envelope carries NO body key — the poller's fetch of a
    // bodyless method must carry no init.body (undici rejects one).
    bodyField = undefined;
  } else if (bodyKind.kind === 'inline') {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_BODY_BYTES) return error(413, 'payload too large');
    bodyField = bytes.length > 0 ? { inline_b64: bytesToBase64(bytes) } : undefined;
  } else {
    preallocatedId = await allocateId(stub);
    bodyField = { r2_key: `${R2_KEY_REQ}${preallocatedId}.bin` };
    await env.RELAY_BUCKET.put(bodyField.r2_key, request.body);
  }
  const partial = {
    id: preallocatedId,
    method: request.method,
    path: `${url.pathname}${url.search}`,
    headers: filterRequestHeaders(request.headers),
    deadline,
  };
  if (bodyField !== undefined) partial.body = bodyField;
  const resp = await stub.fetch('https://relay-mailbox.internal/park', {
    method: 'POST',
    body: JSON.stringify({ op: 'park', partial }),
  });
  const out = await resp.json();
  if (out.type !== 'delivered') throw new Error('mailbox returned an unexpected park result');
  return await responseFromEnvelope(env, ctx, out.envelope);
}

async function allocateId(stub) {
  const resp = await stub.fetch('https://relay-mailbox.internal/allocate', {
    method: 'POST',
    body: JSON.stringify({ op: 'allocate' }),
  });
  const out = await resp.json();
  if (!Number.isInteger(out.id)) throw new Error('mailbox returned no id');
  return out.id;
}

// §1.2 long-poll claim. wait is clamped to POLL_WAIT_MAX_MS. After a DO
// restart a waiting poll returns 204 immediately and the poller re-polls
// (self-healing) — the catch below is that path, not an error swallower.
async function handleWork(request, env, url) {
  const waitParam = url.searchParams.get('wait');
  let wait = waitParam === null ? 0 : Number.parseInt(waitParam, 10);
  if (!Number.isFinite(wait) || wait < 0) wait = 0;
  wait = Math.min(wait, POLL_WAIT_MAX_MS);
  const stub = mailboxStub(env);
  let resp;
  try {
    resp = await stub.fetch('https://relay-mailbox.internal/claim', {
      method: 'POST',
      body: JSON.stringify({ op: 'claim', wait }),
    });
  } catch (err) {
    console.error('relay: mailbox claim failed (poller will re-poll):', err && err.message ? err.message : err);
    return new Response(null, { status: 204 });
  }
  const out = await resp.json();
  if (out.type === 'envelope') return jsonResponse(200, out.envelope);
  return new Response(null, { status: 204 });
}

// §1.2 /body/<key>: stream the R2 object. Only req/ and resp/ prefixes are
// allowed — anything else (including traversal attempts) is 404.
async function handleBody(request, env, path) {
  let key;
  try {
    key = decodeURIComponent(path.slice('/body/'.length));
  } catch {
    return error(404, 'not found');
  }
  if (!key.startsWith(R2_KEY_REQ) && !key.startsWith(R2_KEY_RESP)) return error(404, 'not found');
  const obj = await env.RELAY_BUCKET.get(key);
  if (!obj) return error(404, 'not found');
  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(obj.size),
    },
  });
}

// §1.2 /resp?id=<id>: JSON envelope body, OR raw stream + x-relay-meta
// (to_r2 → stream request.body into R2; else read the already-small body and
// inline it). Unknown id → 410. The response R2 object is deleted by the
// parked request's post-delivery cleanup (responseFromEnvelope), never here —
// the browser may still be streaming it.
async function handleResp(request, env, url) {
  const id = Number.parseInt(url.searchParams.get('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return error(400, 'bad id');
  const metaHeader = request.headers.get(RESPONSE_META_HEADER);
  let envelope;
  if (metaHeader !== null) {
    let meta;
    try {
      meta = decodeResponseMeta(metaHeader);
    } catch {
      return error(400, 'bad meta');
    }
    if (meta.to_r2) {
      // Buffer first — workerd R2 put() needs a known length; /resp arrives chunked.
      const bytes = new Uint8Array(await request.arrayBuffer());
      const key = `${R2_KEY_RESP}${id}.bin`;
      await env.RELAY_BUCKET.put(key, bytes);
      envelope = { status: meta.status, headers: meta.headers, body: { r2_key: key } };
    } else {
      const bytes = new Uint8Array(await request.arrayBuffer());
      envelope = {
        status: meta.status,
        headers: meta.headers,
        body: bytes.length > 0 ? { inline_b64: bytesToBase64(bytes) } : undefined,
      };
      if (envelope.body === undefined) delete envelope.body;
    }
  } else {
    try {
      envelope = decodeResponseEnvelope(await request.text());
    } catch {
      return error(400, 'bad envelope');
    }
  }
  const stub = mailboxStub(env);
  const resp = await stub.fetch('https://relay-mailbox.internal/deliver', {
    method: 'POST',
    body: JSON.stringify({ op: 'deliver', id, envelope }),
  });
  const out = await resp.json();
  if (out.unknownId) return error(410, 'relay expired');
  return jsonResponse(200, { ok: true });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      console.error('relay: internal error:', err && err.message ? err.message : err);
      return error(500, 'relay internal error');
    }
  },
};

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'GET' && path === '/healthz') return jsonResponse(200, { ok: true });
  if (path === '/work') {
    if (request.method !== 'POST') return error(405, 'method not allowed');
    if (!(await secretOk(request, env))) return error(401, 'unauthorized');
    return await handleWork(request, env, url);
  }
  if (path.startsWith('/body/')) {
    if (request.method !== 'GET') return error(405, 'method not allowed');
    if (!(await secretOk(request, env))) return error(401, 'unauthorized');
    return await handleBody(request, env, path);
  }
  if (path === '/resp') {
    if (request.method !== 'POST') return error(405, 'method not allowed');
    if (!(await secretOk(request, env))) return error(401, 'unauthorized');
    return await handleResp(request, env, url);
  }
  // Catch-all: park → await response → deliver. NO relay secret here — the
  // app's own bearer auth is the gate (same threat model as the quick tunnel).
  return await handlePark(request, env, ctx, url);
}

// Mailbox Durable Object — the single durable queue (SQLite-backed class per
// the wrangler migration). All state in KV-style ctx.storage under the keys
// `seq`, `item:<id>`, `resp:<id>`. The durable-object model in
// relay/protocol.js is a pure state machine; THIS class applies its action
// objects to storage and owns everything in-memory: the parked-browser
// waiter map (item id → resolve) and the FIFO poll queue (/work long-polls).
//
// ops (internal binding fetch, not publicly reachable): allocate, park,
// claim, deliver. Every op runs the model's sweepExpired FIRST (the lazy
// sweep of §1.5), then the operation — one DO event, that exact order.
export class Mailbox {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.model = createMailboxModel();
    this.parkedWaiters = new Map(); // item id → resolve(envelope)
    this.pollQueue = []; // FIFO of {resolve, timer, done}
    ctx.blockConcurrencyWhile(async () => {
      await this.#hydrate();
    });
  }

  // Items survive a DO restart (storage is durable); the in-memory waiters
  // do not. Rebuilding the model view and re-arming the alarm restores the
  // 504-at-deadline guarantee for anything parked before the restart.
  async #hydrate() {
    const seq = await this.ctx.storage.get('seq');
    const items = await this.ctx.storage.list({ prefix: 'item:' });
    const responses = await this.ctx.storage.list({ prefix: 'resp:' });
    this.model.load({
      seq: typeof seq === 'number' ? seq : 0,
      items: [...items.values()],
      responses: [...responses.values()],
    });
    await this.#applySweep(this.model.sweepExpired(Date.now()));
  }

  async fetch(request) {
    const msg = await request.json();
    switch (msg.op) {
      case 'allocate':
        return await this.#opAllocate();
      case 'park':
        return await this.#opPark(msg.partial);
      case 'claim':
        return await this.#opClaim(msg.wait);
      case 'deliver':
        return await this.#opDeliver(msg.id, msg.envelope);
      default:
        return Response.json({ error: 'unknown op' }, { status: 400 });
    }
  }

  async #opAllocate() {
    await this.#applySweep(this.model.sweepExpired(Date.now()));
    const { actions, id } = this.model.allocate(Date.now());
    await this.#apply(actions);
    return Response.json({ id });
  }

  async #opPark(partial) {
    await this.#applySweep(this.model.sweepExpired(Date.now()));
    const actions = this.model.park(Date.now(), partial);
    await this.#apply(actions);
    const itemEntry = actions.persist.find((p) => String(p.key).startsWith('item:'));
    const id = itemEntry.value.id;
    const promise = new Promise((resolve) => this.parkedWaiters.set(id, resolve));
    await this.#dispatchToPoller();
    const envelope = await promise;
    return Response.json({ type: 'delivered', envelope });
  }

  async #opClaim(wait) {
    await this.#applySweep(this.model.sweepExpired(Date.now()));
    const actions = this.model.claim(Date.now());
    await this.#apply(actions);
    const entry = actions.resolve[0];
    if (entry) return Response.json({ type: 'envelope', envelope: entry.statusOrEnvelope });
    if (wait > 0) {
      const result = await new Promise((resolve) => {
        const record = { resolve, timer: null, done: false };
        record.timer = setTimeout(() => {
          if (record.done) return;
          record.done = true;
          const idx = this.pollQueue.indexOf(record);
          if (idx >= 0) this.pollQueue.splice(idx, 1);
          resolve(null);
        }, wait);
        this.pollQueue.push(record);
      });
      if (result) return Response.json({ type: 'envelope', envelope: result });
    }
    return Response.json({ type: 'timeout' });
  }

  async #opDeliver(id, envelope) {
    await this.#applySweep(this.model.sweepExpired(Date.now()));
    const actions = this.model.respond(id, envelope, Date.now());
    await this.#apply(actions);
    const entry = actions.resolve[0];
    if (entry) {
      const waiter = this.parkedWaiters.get(entry.id);
      if (waiter) {
        this.parkedWaiters.delete(entry.id);
        waiter(entry.statusOrEnvelope);
      }
    }
    if (!actions.unknownId) {
      // Request side only — the response object is cleaned up after the
      // browser consumes it (see responseFromEnvelope).
      this.#deleteR2BestEffort([`${R2_KEY_REQ}${id}.bin`]);
    }
    return Response.json({ ok: true, unknownId: actions.unknownId === true });
  }

  // Park resolves the FIFO head: claim the oldest unclaimed item and hand it
  // to the longest-waiting /work poll. A claimed item's browser waiter stays
  // registered — the poller's delivery resolves it.
  async #dispatchToPoller() {
    while (this.pollQueue.length > 0) {
      const claimActions = this.model.claim(Date.now());
      await this.#apply(claimActions);
      const entry = claimActions.resolve[0];
      if (!entry) break;
      const record = this.pollQueue.shift();
      if (record.timer) clearTimeout(record.timer);
      record.done = true;
      record.resolve(entry.statusOrEnvelope);
    }
  }

  async alarm() {
    await this.#applySweep(this.model.sweepExpired(Date.now()));
  }

  // Applies OPERATION actions: storage writes/deletes + alarm arming only.
  // resolve entries are interpreted by the op that produced them.
  async #apply(actions) {
    for (const { key, value } of actions.persist) await this.ctx.storage.put(key, value);
    for (const key of actions.deleteKeys) await this.ctx.storage.delete(key);
    await this.#armAlarm(actions.alarmAt);
  }

  // Applies SWEEP actions: storage + alarm + resolving expired parked
  // waiters with the 504 envelope + best-effort R2 cleanup of deleted keys.
  async #applySweep(actions) {
    const r2Keys = [];
    for (const key of actions.deleteKeys) {
      const itemMatch = key.match(/^item:(\d+)$/);
      if (itemMatch) {
        r2Keys.push(`${R2_KEY_REQ}${itemMatch[1]}.bin`);
        continue;
      }
      const respMatch = key.match(/^resp:(\d+)$/);
      if (respMatch) {
        const rec = await this.ctx.storage.get(key);
        const r2Key = rec && rec.envelope && rec.envelope.body ? rec.envelope.body.r2_key : undefined;
        if (typeof r2Key === 'string') r2Keys.push(r2Key);
      }
    }
    for (const { key, value } of actions.persist) await this.ctx.storage.put(key, value);
    for (const key of actions.deleteKeys) await this.ctx.storage.delete(key);
    await this.#armAlarm(actions.alarmAt);
    for (const { id, statusOrEnvelope } of actions.resolve) {
      const waiter = this.parkedWaiters.get(id);
      if (waiter) {
        this.parkedWaiters.delete(id);
        waiter(statusOrEnvelope);
      }
    }
    this.#deleteR2BestEffort(r2Keys);
  }

  async #armAlarm(alarmAt) {
    if (alarmAt === null || alarmAt === undefined) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || alarmAt < current) await this.ctx.storage.setAlarm(alarmAt);
  }

  #deleteR2BestEffort(keys) {
    if (keys.length === 0 || !this.env || !this.env.RELAY_BUCKET) return;
    const done = Promise.allSettled(keys.map((k) => this.env.RELAY_BUCKET.delete(k))).then(() => {});
    if (typeof this.ctx.waitUntil === 'function') {
      this.ctx.waitUntil(done);
    }
  }
}
