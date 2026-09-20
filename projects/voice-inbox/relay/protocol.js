// Voice-inbox edge relay — protocol core (pure module).
//
// Runs unchanged in workerd (relay/worker.js) and node:test
// (relay/test/protocol.test.mjs): ECMAScript builtins plus the web-standard
// TextEncoder/TextDecoder only — no Workers APIs, no Node-only APIs. Per the
// frozen contract this file is the ONE source for constants, header rules,
// envelope codecs, base64, and the pure mailbox model; worker.js and the
// home poller import from here instead of re-deriving any of it.

// §1.1 constants — one source.
export const POLL_WAIT_MAX_MS = 25000; // intent: long-poll wait ≤25 s
export const REQUEST_DEADLINE_MS = 55000; // parked request dies 55 s after park → 504 to the browser
export const INLINE_BODY_MAX_BYTES = 786432; // 768 KiB raw; base64 ≈ 1.0 MiB; envelope ≤ ~1.1 MB < 2 MB DO cap
export const MAX_BODY_BYTES = 26214400; // 25 MiB — mirrors the app's max_upload_mb default; over → 413
export const R2_KEY_REQ = 'req/'; // req/<id>.bin
export const R2_KEY_RESP = 'resp/'; // resp/<id>.bin
export const SECRET_HEADER = 'x-relay-secret';
// §1.3 raw /resp form: the meta header NAME is part of the wire contract, so
// it lives here next to the codec that fills it (poller sets, worker reads).
export const RESPONSE_META_HEADER = 'x-relay-meta';

// §1.4 header rules. Names are lowercase; values preserved verbatim; order
// not significant; repeated names collapse last-wins via Headers iteration.
// RESP = REQ minus `host`, plus a defensive `content-encoding` drop (the home
// server never compresses — a stale value would corrupt interpretation).
const HOP_BY_HOP_BASE = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
];
export const HOP_BY_HOP_REQ = [...HOP_BY_HOP_BASE, 'host', 'content-length', 'accept-encoding'];
export const HOP_BY_HOP_RESP = [...HOP_BY_HOP_BASE, 'content-length', 'accept-encoding', 'content-encoding'];

// The localhost leg is pinned to identity encoding (deterministic guard: the
// home server never compresses, so negotiating gzip would only add a codec to
// strip). The poller merges this list into every home request.
export const LOCAL_REQUEST_OVERRIDES = [['accept-encoding', 'identity']];

// Test-only deadline clamp header (§3 WP-R2 smoke design). Honored ONLY when
// the caller passes testMode:true; never present in production traffic.
export const TEST_DEADLINE_HEADER = 'x-relay-deadline-ms';

export function filterRequestHeaders(headers) {
  return filterHeaders(headers, new Set(HOP_BY_HOP_REQ));
}

export function filterResponseHeaders(headers) {
  return filterHeaders(headers, new Set(HOP_BY_HOP_RESP));
}

function filterHeaders(headers, drop) {
  const out = [];
  for (const [name, value] of headers) {
    const lower = String(name).toLowerCase();
    if (drop.has(lower)) continue;
    out.push([lower, value]);
  }
  return out;
}

// Hand-rolled base64: workerd has no Buffer and btoa is not binary-safe.
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < B64_ALPHABET.length; i++) B64_LOOKUP[B64_ALPHABET.charCodeAt(i)] = i;

export function bytesToBase64(bytes) {
  const n = bytes.length;
  const parts = [];
  // Chunk size is a multiple of 3 so each chunk encodes independently —
  // padding appears only at the very end of the very last chunk.
  const CHUNK = 3 * 8192;
  for (let start = 0; start < n; start += CHUNK) {
    const end = Math.min(start + CHUNK, n);
    const codes = [];
    let i = start;
    for (; i + 2 < end; i += 3) {
      const b0 = bytes[i];
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      codes.push(
        B64_ALPHABET.charCodeAt(b0 >> 2),
        B64_ALPHABET.charCodeAt(((b0 & 3) << 4) | (b1 >> 4)),
        B64_ALPHABET.charCodeAt(((b1 & 15) << 2) | (b2 >> 6)),
        B64_ALPHABET.charCodeAt(b2 & 63)
      );
    }
    const rem = end - i;
    if (rem === 1) {
      const b0 = bytes[i];
      codes.push(B64_ALPHABET.charCodeAt(b0 >> 2), B64_ALPHABET.charCodeAt((b0 & 3) << 4), 61, 61);
    } else if (rem === 2) {
      const b0 = bytes[i];
      const b1 = bytes[i + 1];
      codes.push(
        B64_ALPHABET.charCodeAt(b0 >> 2),
        B64_ALPHABET.charCodeAt(((b0 & 3) << 4) | (b1 >> 4)),
        B64_ALPHABET.charCodeAt((b1 & 15) << 2),
        61
      );
    }
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join('');
}

export function base64ToBytes(text) {
  const out = [];
  let buffer = 0;
  let bits = 0;
  let padSeen = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 61) {
      // '='
      padSeen = true;
      continue;
    }
    if (padSeen) throw new Error('base64: data after padding');
    if (code > 127) throw new Error('base64: invalid character');
    const v = B64_LOOKUP[code];
    if (v < 0) throw new Error('base64: invalid character');
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

// Constant-time comparison of two hex strings: the loop always runs over the
// longer input and never exits early on a differing character. A length
// mismatch returns false (the diff is pre-seeded) while still scanning.
export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

// §1.3 envelope shapes — byte-pinned field names. `body` is exactly one of
// {"inline_b64": "<base64>"} or {"r2_key": "<key>"}; an absent body key means
// no body (GET/HEAD).
function isHeaderPairs(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (pair) =>
        Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string'
    )
  );
}

function normalizeBodyField(body, what) {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'object' || Array.isArray(body)) throw new Error(`${what}: body must be an object`);
  const keys = Object.keys(body);
  const hasInline = keys.includes('inline_b64');
  const hasR2 = keys.includes('r2_key');
  if (hasInline === hasR2) throw new Error(`${what}: body must be exactly one of inline_b64 or r2_key`);
  if (keys.length !== 1) throw new Error(`${what}: body carries unknown keys`);
  const key = hasInline ? 'inline_b64' : 'r2_key';
  if (typeof body[key] !== 'string' || body[key].length === 0) {
    throw new Error(`${what}: body.${key} must be a non-empty string`);
  }
  return body;
}

export function encodeRequestEnvelope(envelope) {
  const out = {
    id: envelope.id,
    method: envelope.method,
    path: envelope.path,
    headers: envelope.headers,
    deadline: envelope.deadline,
    claimed: envelope.claimed,
  };
  const body = normalizeBodyField(envelope.body, 'request envelope');
  if (body !== undefined) out.body = body;
  return JSON.stringify(out);
}

export function decodeRequestEnvelope(text) {
  const parsed = typeof text === 'string' ? JSON.parse(text) : text;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request envelope: not an object');
  }
  if (!Number.isInteger(parsed.id)) throw new Error('request envelope: id must be an integer');
  if (typeof parsed.method !== 'string') throw new Error('request envelope: method must be a string');
  if (typeof parsed.path !== 'string') throw new Error('request envelope: path must be a string');
  if (!isHeaderPairs(parsed.headers)) throw new Error('request envelope: headers must be [name, value] pairs');
  if (typeof parsed.deadline !== 'number') throw new Error('request envelope: deadline must be a number');
  if (typeof parsed.claimed !== 'boolean') throw new Error('request envelope: claimed must be a boolean');
  const envelope = {
    id: parsed.id,
    method: parsed.method,
    path: parsed.path,
    headers: parsed.headers,
    deadline: parsed.deadline,
    claimed: parsed.claimed,
  };
  const body = normalizeBodyField(parsed.body, 'request envelope');
  if (body !== undefined) envelope.body = body;
  return envelope;
}

export function encodeResponseEnvelope(envelope) {
  const out = {
    status: envelope.status,
    headers: envelope.headers,
  };
  const body = normalizeBodyField(envelope.body, 'response envelope');
  if (body !== undefined) out.body = body;
  return JSON.stringify(out);
}

export function decodeResponseEnvelope(text) {
  const parsed = typeof text === 'string' ? JSON.parse(text) : text;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('response envelope: not an object');
  }
  if (!Number.isInteger(parsed.status)) throw new Error('response envelope: status must be an integer');
  if (!isHeaderPairs(parsed.headers)) throw new Error('response envelope: headers must be [name, value] pairs');
  const envelope = {
    status: parsed.status,
    headers: parsed.headers,
  };
  const body = normalizeBodyField(parsed.body, 'response envelope');
  if (body !== undefined) envelope.body = body;
  return envelope;
}

export function requestBodyKind(envelope) {
  if (!envelope || typeof envelope !== 'object') return 'none';
  const body = envelope.body;
  if (!body || typeof body !== 'object') return 'none';
  if (typeof body.inline_b64 === 'string') return 'inline';
  if (typeof body.r2_key === 'string') return 'r2';
  return 'none';
}

// §1.3 inbound body decision for the park path — pure so workerd and
// node:test pin the same rule. GET/HEAD are bodyless by definition and a
// content-length of exactly 0 carries no bytes; either parks an envelope with
// NO body key and never touches R2 (a bodyless fetch must carry no init.body,
// or undici rejects it). A body-bearing method with an unknown/non-finite
// length streams (request.body); a small known length buffers inline.
// Negative lengths are malformed → treated as unknown (stream).
export function classifyInboundBody(method, contentLength) {
  const m = typeof method === 'string' ? method.toUpperCase() : '';
  if (m === 'GET' || m === 'HEAD') return { kind: 'none' };
  const len = Number.isFinite(contentLength) ? contentLength : NaN;
  if (!Number.isFinite(len) || len < 0) return { kind: 'stream' };
  if (len === 0) return { kind: 'none' };
  if (len <= INLINE_BODY_MAX_BYTES) return { kind: 'inline' };
  return { kind: 'stream' };
}

// §1.3 raw /resp form: x-relay-meta carries base64url(JSON {status, headers,
// to_r2}); the raw bytes ride the request body. The poller encodes, the
// worker decodes — both directions live here so the contract has one source.
export function encodeResponseMeta(meta) {
  const json = JSON.stringify({ status: meta.status, headers: meta.headers, to_r2: meta.to_r2 });
  const b64 = bytesToBase64(new TextEncoder().encode(json));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeResponseMeta(value) {
  const b64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const json = new TextDecoder().decode(base64ToBytes(padded));
  const parsed = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('relay meta: not an object');
  if (!Number.isInteger(parsed.status)) throw new Error('relay meta: status must be an integer');
  if (!isHeaderPairs(parsed.headers)) throw new Error('relay meta: headers must be [name, value] pairs');
  if (typeof parsed.to_r2 !== 'boolean') throw new Error('relay meta: to_r2 must be a boolean');
  return { status: parsed.status, headers: parsed.headers, to_r2: parsed.to_r2 };
}

// Deadline for a parked request. Default: now + REQUEST_DEADLINE_MS. The
// test-only clamp header can only SHORTEN the deadline, and only when the
// caller explicitly passes testMode:true (smoke config [vars] only).
export function deadlineFor(now, headers, testMode = false) {
  if (!testMode || headers === null || headers === undefined) return now + REQUEST_DEADLINE_MS;
  let raw = null;
  if (typeof headers.get === 'function') {
    raw = headers.get(TEST_DEADLINE_HEADER);
  } else {
    for (const [name, value] of headers) {
      if (String(name).toLowerCase() === TEST_DEADLINE_HEADER) raw = value;
    }
  }
  if (typeof raw !== 'string') return now + REQUEST_DEADLINE_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return now + REQUEST_DEADLINE_MS;
  return now + Math.min(parsed, REQUEST_DEADLINE_MS);
}

// §1.5 mailbox model — pure state machine over in-memory arrays. Each method
// returns an actions object {persist:[{key,value}], deleteKeys:[],
// resolve:[{id, statusOrEnvelope}], alarmAt} for the CALLER (worker.js) to
// apply to ctx.storage; the model never touches storage itself, so the tests
// need no DO runtime.
//
// resolve-entry semantics by producer:
//   sweepExpired → 504 response envelopes for expired parked requests
//                  (the worker resolves the parked browser waiter);
//   claim        → at most one request envelope, the /work caller's answer;
//   respond      → the delivered response envelope (resolves the parked
//                  browser waiter).
// The lazy sweep of §1.5 ("Park: lazy sweep → ...") is composed at the call
// site: worker.js runs sweepExpired(now) then the operation, in that order,
// inside one DO event — the observable sequence matches the contract while
// each call's resolve entries keep unambiguous producers.

const RESPONSE_ORPHAN_GRACE_MS = 60000; // resp:<id> orphans swept at deadline + 60 s
const EXPIRED_BODY_TEXT = '{"ok":false,"error":"relay deadline exceeded"}';
const EXPIRED_BODY_B64 = bytesToBase64(new TextEncoder().encode(EXPIRED_BODY_TEXT));

function expiredResponseEnvelope() {
  return {
    status: 504,
    headers: [['content-type', 'application/json']],
    body: { inline_b64: EXPIRED_BODY_B64 },
  };
}

const itemKeyOf = (id) => `item:${id}`;
const respKeyOf = (id) => `resp:${id}`;

export function createMailboxModel() {
  let seq = 0;
  const items = []; // live request envelopes, kept sorted by id (FIFO order)
  const responses = new Map(); // id -> {id, deadline, envelope}

  function alarmAt() {
    let min = null;
    for (const it of items) if (min === null || it.deadline < min) min = it.deadline;
    return min;
  }

  function emptyActions() {
    return { persist: [], deleteKeys: [], resolve: [], alarmAt: null };
  }

  // Items expire STRICTLY past their deadline: exactly-at is NOT expired.
  function sweepActions(now) {
    const actions = emptyActions();
    for (const it of items) {
      if (it.deadline < now) {
        actions.deleteKeys.push(itemKeyOf(it.id));
        if (responses.has(it.id)) {
          actions.deleteKeys.push(respKeyOf(it.id));
          responses.delete(it.id);
        }
        actions.resolve.push({ id: it.id, statusOrEnvelope: expiredResponseEnvelope() });
      }
    }
    if (actions.resolve.length > 0) {
      const expired = new Set(actions.resolve.map((r) => r.id));
      for (let i = items.length - 1; i >= 0; i--) {
        if (expired.has(items[i].id)) items.splice(i, 1);
      }
    }
    // resp:<id> orphans (DO restarted before delivery completed) age out at
    // their stored deadline + 60 s. The stored deadline is why the wrapper
    // record carries it: the §1.3 wire envelope is unchanged.
    for (const [id, rec] of responses) {
      if (rec.deadline + RESPONSE_ORPHAN_GRACE_MS < now) {
        actions.deleteKeys.push(respKeyOf(id));
        responses.delete(id);
      }
    }
    actions.alarmAt = alarmAt();
    return actions;
  }

  function park(now, partial) {
    const actions = emptyActions();
    const id = partial.id !== undefined ? partial.id : seq + 1;
    if (partial.id !== undefined && items.some((it) => it.id === id)) {
      throw new Error(`mailbox model: item:${id} already exists`);
    }
    const envelope = {
      id,
      method: partial.method,
      path: partial.path,
      headers: partial.headers,
      deadline: partial.deadline,
      claimed: false,
    };
    if (partial.body !== undefined && partial.body !== null) envelope.body = partial.body;
    if (partial.id === undefined) {
      seq = id;
      actions.persist.push({ key: 'seq', value: seq });
    }
    items.push(envelope);
    items.sort((a, b) => a.id - b.id);
    actions.persist.push({ key: itemKeyOf(id), value: envelope });
    actions.alarmAt = alarmAt();
    return actions;
  }

  // Two-phase park for large bodies: the worker must know the id BEFORE the
  // park call (the R2 object req/<id>.bin has to exist first), so it can
  // mint-and-reserve an id without creating an item. A crash between
  // allocate and park leaves an id gap — ids stay strictly monotonic.
  function allocate(now) {
    seq += 1;
    const actions = emptyActions();
    actions.persist.push({ key: 'seq', value: seq });
    actions.alarmAt = alarmAt();
    return { actions, id: seq };
  }

  // Oldest unclaimed = lowest id (items kept id-sorted). A claim is terminal
  // (at-most-once, §1.5): a claimed item is never re-queued.
  function claim(now) {
    const actions = emptyActions();
    const candidate = items.find((it) => !it.claimed);
    if (candidate) {
      candidate.claimed = true;
      const snapshot = { ...candidate };
      actions.persist.push({ key: itemKeyOf(candidate.id), value: snapshot });
      actions.resolve.push({ id: candidate.id, statusOrEnvelope: snapshot });
    }
    actions.alarmAt = alarmAt();
    return actions;
  }

  function respond(id, envelope, now) {
    const actions = emptyActions();
    const idx = items.findIndex((it) => it.id === id);
    if (idx >= 0) {
      const item = items[idx];
      items.splice(idx, 1);
      const record = { id, deadline: item.deadline, envelope };
      responses.set(id, record);
      actions.persist.push({ key: respKeyOf(id), value: record });
      actions.deleteKeys.push(itemKeyOf(id));
      actions.resolve.push({ id, statusOrEnvelope: envelope });
      actions.alarmAt = alarmAt();
      return actions;
    }
    // Idempotent re-delivery: the item is gone but resp:<id> exists —
    // overwrite it (same content) and report nothing new. An id that never
    // existed sets unknownId so the worker answers 410.
    const existing = responses.get(id);
    if (existing) {
      actions.persist.push({ key: respKeyOf(id), value: { id, deadline: existing.deadline, envelope } });
    } else {
      actions.unknownId = true;
    }
    actions.alarmAt = alarmAt();
    return actions;
  }

  function sweepExpired(now) {
    return sweepActions(now);
  }

  // Rehydrate from storage after a DO restart (worker.js reads the keys and
  // hands the values over; the model rebuilds its in-memory view).
  function load(state) {
    seq = typeof state.seq === 'number' ? state.seq : 0;
    items.length = 0;
    for (const it of state.items ?? []) items.push(it);
    items.sort((a, b) => a.id - b.id);
    responses.clear();
    for (const rec of state.responses ?? []) responses.set(rec.id, rec);
  }

  return { park, claim, respond, sweepExpired, allocate, load };
}
