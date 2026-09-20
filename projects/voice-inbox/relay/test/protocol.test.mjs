// Relay protocol unit tests (node:test, plain .mjs — no build step).
//
// Machine rule (§ Node tests, ~/.claude/machine-notes.md): a test file can
// pass as a dark file-shell with zero registered suites — every suite below
// is a real describe/test registration, and the package's run-tests.mjs
// dark-file detector fails the run if this file contributes nothing.
// Scope: pure protocol/model logic only — no network, no wrangler, no ports
// (the real-runtime scenarios live in scripts/relay_smoke.mjs, integration
// time). Buffer is used here as the base64 ORACLE: the production module
// avoids it because workerd has no Buffer, but tests run on Node.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HOP_BY_HOP_REQ,
  HOP_BY_HOP_RESP,
  INLINE_BODY_MAX_BYTES,
  LOCAL_REQUEST_OVERRIDES,
  REQUEST_DEADLINE_MS,
  TEST_DEADLINE_HEADER,
  base64ToBytes,
  bytesToBase64,
  classifyInboundBody,
  createMailboxModel,
  decodeRequestEnvelope,
  decodeResponseEnvelope,
  decodeResponseMeta,
  deadlineFor,
  encodeRequestEnvelope,
  encodeResponseEnvelope,
  encodeResponseMeta,
  filterRequestHeaders,
  filterResponseHeaders,
  requestBodyKind,
  timingSafeEqualHex,
  RESPONSE_META_HEADER,
} from '../protocol.js';

const textBytes = (text) => new TextEncoder().encode(text);

// Deterministic PRNG (mulberry32) — no Math.random anywhere in this file.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededBytes(size, seed) {
  const next = mulberry32(seed);
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = Math.floor(next() * 256);
  return bytes;
}

function assertBytesEqual(actual, expected, message) {
  assert.equal(actual.length, expected.length, `${message}: length`);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      assert.fail(`${message}: byte ${i} differs (${actual[i]} != ${expected[i]})`);
    }
  }
}

function actionsByKey(actions) {
  const persist = new Map();
  for (const entry of actions.persist) persist.set(entry.key, entry.value);
  return persist;
}

const KIB = 1024;
const BASE64_SIZES = [0, 1, 3, 767 * KIB, 768 * KIB, 769 * KIB];

describe('base64 codec', () => {
  test('known vectors', () => {
    const vectors = [
      ['', ''],
      ['f', 'Zg=='],
      ['fo', 'Zm8='],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg=='],
      ['fooba', 'Zm9vYmE='],
      ['foobar', 'Zm9vYmFy'],
    ];
    for (const [plain, expected] of vectors) {
      assert.equal(bytesToBase64(textBytes(plain)), expected, `encode ${JSON.stringify(plain)}`);
      assert.equal(new TextDecoder().decode(base64ToBytes(expected)), plain, `decode ${expected}`);
    }
  });

  for (const size of BASE64_SIZES) {
    test(`round-trip ${size} bytes (seeded, cross-checked against Buffer)`, () => {
      const bytes = seededBytes(size, 0x5eed + size);
      const encoded = bytesToBase64(bytes);
      // Oracle: Node's own encoder must agree exactly (incl. padding rules).
      assert.equal(encoded, Buffer.from(bytes).toString('base64'), `encode size=${size}`);
      const decoded = base64ToBytes(encoded);
      assertBytesEqual(decoded, bytes, `decode size=${size}`);
    });
  }

  test('rejects invalid characters and data after padding', () => {
    assert.throws(() => base64ToBytes('ab#c'), /invalid character/);
    assert.throws(() => base64ToBytes('a=b=c'), /data after padding/);
  });

  test('inline cap constant is 768 KiB raw', () => {
    assert.equal(INLINE_BODY_MAX_BYTES, 768 * KIB);
  });
});

describe('header filters', () => {
  test('request filter drops every §1.4 request-side header', () => {
    const headers = new Headers();
    for (const name of HOP_BY_HOP_REQ) headers.set(name, `drop-${name}`);
    headers.set('content-type', 'application/json');
    headers.set('x-custom', 'keepme');
    const out = Object.fromEntries(filterRequestHeaders(headers));
    for (const name of HOP_BY_HOP_REQ) {
      assert.equal(out[name], undefined, `${name} must be dropped from requests`);
    }
    assert.equal(out['content-type'], 'application/json');
    assert.equal(out['x-custom'], 'keepme');
  });

  test('response filter drops every §1.4 response-side header (incl. content-encoding), keeps host', () => {
    const headers = new Headers();
    for (const name of HOP_BY_HOP_RESP) headers.set(name, `drop-${name}`);
    headers.set('host', 'home.example'); // RESP keeps host (only REQ drops it)
    headers.set('x-custom', 'keepme');
    const out = Object.fromEntries(filterResponseHeaders(headers));
    for (const name of HOP_BY_HOP_RESP) {
      assert.equal(out[name], undefined, `${name} must be dropped from responses`);
    }
    assert.equal(out['host'], 'home.example');
    assert.equal(out['x-custom'], 'keepme');
  });

  test('drops include host and content-length on the request side', () => {
    const out = Object.fromEntries(filterRequestHeaders([['host', 'x'], ['content-length', '5']]));
    assert.equal(out['host'], undefined);
    assert.equal(out['content-length'], undefined);
  });

  test('case-folds header names from raw pair input', () => {
    const out = filterRequestHeaders([['Content-Type', 'text/plain'], ['X-ODD-nAmE', 'v']]);
    assert.deepEqual(out, [['content-type', 'text/plain'], ['x-odd-name', 'v']]);
  });

  test('preserves values verbatim', () => {
    const value = 'a, b; c "quoted" key=val;ue';
    const out = filterRequestHeaders([['x-weird', value]]);
    assert.equal(out[0][1], value);
  });

  // NOTE: the spec's §1.4 wording says "last-wins via Headers iteration" but
  // actual Headers iteration JOINS repeated names with ', ' — and the spec's
  // own §0.2.5 pins "repeated headers are joined" as the v1 limitation. The
  // filter forwards Headers output verbatim; the joined value is what ships.
  test('repeated names arrive joined via Headers iteration (§0.2.5 v1 limitation)', () => {
    const headers = new Headers([['a', '1'], ['a', '2']]);
    const out = filterRequestHeaders(headers);
    assert.deepEqual(out, [['a', '1, 2']]);
  });

  test('identity override pins accept-encoding for the localhost leg', () => {
    assert.deepEqual(LOCAL_REQUEST_OVERRIDES, [['accept-encoding', 'identity']]);
  });
});

describe('timingSafeEqualHex', () => {
  const A = 'a'.repeat(64);
  test('equal digests → true', () => {
    assert.equal(timingSafeEqualHex(A, A.slice()), true);
  });
  test('same length, different content → false', () => {
    assert.equal(timingSafeEqualHex(A, 'b'.repeat(64)), false);
    assert.equal(timingSafeEqualHex(A, A.slice(0, 63) + 'b'), false);
  });
  test('length mismatch → false (and scans anyway)', () => {
    assert.equal(timingSafeEqualHex(A, A.slice(0, 32)), false);
    assert.equal(timingSafeEqualHex('abc', 'abcd'), false);
  });
  test('empty inputs', () => {
    assert.equal(timingSafeEqualHex('', ''), true);
    assert.equal(timingSafeEqualHex('', 'ab'), false);
  });
});

describe('envelope codecs', () => {
  const reqInline = {
    id: 42,
    method: 'POST',
    path: '/api/v1/tasks?x=1',
    headers: [['content-type', 'application/json']],
    deadline: 1730000000000,
    claimed: false,
    body: { inline_b64: 'eyJhIjoxfQ==' },
  };
  const reqR2 = { ...reqInline, body: { r2_key: 'req/42.bin' } };
  const respInline = {
    status: 200,
    headers: [['content-type', 'application/json; charset=utf-8']],
    body: { inline_b64: 'eyJvayI6dHJ1ZX0=' },
  };

  test('request envelope round-trips with inline body', () => {
    assert.deepEqual(decodeRequestEnvelope(encodeRequestEnvelope(reqInline)), reqInline);
  });
  test('request envelope round-trips with r2 body', () => {
    assert.deepEqual(decodeRequestEnvelope(encodeRequestEnvelope(reqR2)), reqR2);
  });
  test('absent body omits the body key and round-trips', () => {
    const noBody = { ...reqInline };
    delete noBody.body;
    const encoded = encodeRequestEnvelope(noBody);
    assert.equal(encoded.includes('"body"'), false);
    const decoded = decodeRequestEnvelope(encoded);
    assert.equal('body' in decoded, false);
    assert.deepEqual(decoded, noBody);
  });
  test('encoded request envelope uses the §1.3 field names', () => {
    const keys = Object.keys(JSON.parse(encodeRequestEnvelope(reqInline)));
    assert.deepEqual(keys, ['id', 'method', 'path', 'headers', 'deadline', 'claimed', 'body']);
  });
  test('response envelope round-trips with inline body', () => {
    assert.deepEqual(decodeResponseEnvelope(encodeResponseEnvelope(respInline)), respInline);
  });
  test('response envelope round-trips with r2 body and without body', () => {
    const respR2 = { status: 201, headers: [['location', '/x']], body: { r2_key: 'resp/7.bin' } };
    assert.deepEqual(decodeResponseEnvelope(encodeResponseEnvelope(respR2)), respR2);
    const noBody = { status: 204, headers: [] };
    assert.deepEqual(decodeResponseEnvelope(encodeResponseEnvelope(noBody)), noBody);
  });
  test('body must be exactly one of inline_b64 / r2_key', () => {
    assert.throws(() => encodeRequestEnvelope({ ...reqInline, body: { inline_b64: 'aa', r2_key: 'req/1.bin' } }));
    assert.throws(() => decodeRequestEnvelope({ ...reqInline, body: { other: 'x' } }));
    assert.throws(() => decodeRequestEnvelope({ ...reqInline, body: { inline_b64: 5 } }));
    assert.throws(() => decodeResponseEnvelope({ ...respInline, body: {} }));
  });
  // §1.3 "an absent body key means no body": an EMPTY inline_b64 is NOT a
  // valid no-body encoding — the poller must OMIT the body key entirely for
  // an empty home response (204/304/HEAD/empty 200). This pin is the reason.
  test('an empty inline_b64 is rejected — empty responses must omit body', () => {
    assert.throws(() => decodeResponseEnvelope({ status: 200, headers: [], body: { inline_b64: '' } }));
    assert.throws(() => decodeResponseEnvelope({ ...respInline, body: { inline_b64: '' } }));
  });
  test('RESPONSE_META_HEADER is the wire name the meta codec rides', () => {
    assert.equal(RESPONSE_META_HEADER, 'x-relay-meta');
  });
  test('field validation rejects malformed envelopes', () => {
    assert.throws(() => decodeRequestEnvelope({ ...reqInline, id: '42' }));
    assert.throws(() => decodeRequestEnvelope({ ...reqInline, claimed: 'false' }));
    assert.throws(() => decodeRequestEnvelope({ ...reqInline, headers: [['k']] }));
    assert.throws(() => decodeRequestEnvelope({ ...reqInline, deadline: null }));
    assert.throws(() => decodeResponseEnvelope({ status: '200', headers: [] }));
  });
  test('requestBodyKind discriminates inline / r2 / none', () => {
    assert.equal(requestBodyKind(reqInline), 'inline');
    assert.equal(requestBodyKind(reqR2), 'r2');
    assert.equal(requestBodyKind({ ...reqInline, body: undefined }), 'none');
    assert.equal(requestBodyKind({}), 'none');
  });
  test('response meta round-trips through base64url', () => {
    const meta = { status: 200, headers: [['content-type', 'application/json']], to_r2: true };
    const encoded = encodeResponseMeta(meta);
    assert.equal(encoded.includes('+'), false);
    assert.equal(encoded.includes('/'), false);
    assert.equal(encoded.includes('='), false);
    assert.deepEqual(decodeResponseMeta(encoded), meta);
  });
  test('decodeResponseMeta rejects malformed payloads', () => {
    const bad = encodeResponseMeta({ status: 200, headers: [], to_r2: 'yes' });
    assert.throws(() => decodeResponseMeta(bad), /to_r2/);
    assert.throws(() => decodeResponseMeta('!!!'), /invalid character|Unexpected/i);
  });
});

describe('mailbox model', () => {
  const T0 = 1_000_000_000;
  const park = (model, opts) => model.park(opts?.now ?? T0, {
    method: opts?.method ?? 'GET',
    path: opts?.path ?? '/x',
    headers: opts?.headers ?? [],
    deadline: opts?.deadline ?? T0 + 1000,
    ...(opts?.id !== undefined ? { id: opts.id } : {}),
    ...(opts?.body !== undefined ? { body: opts.body } : {}),
  });
  const itemKeyOf = (id) => `item:${id}`;
  const respKeyOf = (id) => `resp:${id}`;

  test('ids are strictly monotonic across park and allocate', () => {
    const model = createMailboxModel();
    const idOf = (actions) => actions.persist.find((p) => p.key.startsWith('item:')).value.id;
    assert.equal(idOf(park(model)), 1);
    assert.equal(idOf(park(model)), 2);
    assert.equal(idOf(park(model)), 3);
    const allocated = model.allocate(T0);
    assert.equal(allocated.id, 4);
    assert.equal(idOf(park(model, { id: 4 })), 4);
    assert.equal(idOf(park(model)), 5);
    const keys = [...actionsByKey(park(model)).keys()];
    assert.deepEqual(keys.filter((k) => k.startsWith('item:')), ['item:6']);
  });

  test('park→claim is FIFO (oldest id first)', () => {
    const model = createMailboxModel();
    park(model, { path: '/first', deadline: T0 + 1000 });
    park(model, { path: '/second', deadline: T0 + 2000 });
    const first = model.claim(T0 + 1).resolve[0].statusOrEnvelope;
    assert.equal(first.path, '/first');
    assert.equal(first.claimed, true);
    const second = model.claim(T0 + 2).resolve[0].statusOrEnvelope;
    assert.equal(second.path, '/second');
    assert.equal(model.claim(T0 + 3).resolve.length, 0);
  });

  test('claim excludes claimed items and persists the claimed flag', () => {
    const model = createMailboxModel();
    park(model, { body: { inline_b64: 'eA==' } });
    const firstActions = model.claim(T0 + 1);
    const persist = actionsByKey(firstActions);
    assert.equal(persist.get(itemKeyOf(1)).claimed, true);
    assert.equal(model.claim(T0 + 2).resolve.length, 0);
  });

  test('respond resolves and is idempotent; unknown ids report unknownId', () => {
    const model = createMailboxModel();
    park(model, { method: 'POST', body: { r2_key: 'req/1.bin' } });
    const respEnv = { status: 200, headers: [['content-type', 'application/json']], body: { inline_b64: 'eA==' } };
    const actions = model.respond(1, respEnv, T0 + 5);
    assert.deepEqual(actions.resolve, [{ id: 1, statusOrEnvelope: respEnv }]);
    assert.ok(actions.deleteKeys.includes(itemKeyOf(1)));
    const persist = actionsByKey(actions);
    assert.deepEqual(persist.get(respKeyOf(1)), { id: 1, deadline: T0 + 1000, envelope: respEnv });
    // Idempotent re-delivery: overwrite resp:<id>, no new resolve, not unknown.
    const again = model.respond(1, respEnv, T0 + 6);
    assert.equal(again.resolve.length, 0);
    assert.equal(again.unknownId, undefined);
    assert.ok(again.persist.some((p) => p.key === respKeyOf(1)));
    // Never-existed id → unknownId (worker answers 410).
    assert.equal(model.respond(999, respEnv, T0 + 7).unknownId, true);
  });

  test('sweepExpired expires ONLY strictly past the deadline (exactly-at is NOT expired)', () => {
    const model = createMailboxModel();
    park(model, { deadline: T0 + 1000 });
    assert.equal(model.sweepExpired(T0 + 999).deleteKeys.length, 0);
    assert.equal(model.sweepExpired(T0 + 1000).deleteKeys.length, 0);
    const expired = model.sweepExpired(T0 + 1001);
    assert.ok(expired.deleteKeys.includes(itemKeyOf(1)));
    const resolution = expired.resolve[0];
    assert.equal(resolution.id, 1);
    assert.equal(resolution.statusOrEnvelope.status, 504);
    assert.equal(
      new TextDecoder().decode(base64ToBytes(resolution.statusOrEnvelope.body.inline_b64)),
      '{"ok":false,"error":"relay deadline exceeded"}'
    );
    // Cleaned keys: the expired item can no longer be claimed.
    assert.equal(model.claim(T0 + 1002).resolve.length, 0);
  });

  test('swept expired items clear paired resp:<id> records', () => {
    const model = createMailboxModel();
    // Crash-mid-deliver shape: resp:<id> persisted but the item:<id> delete
    // was lost, so the item is still live at expiry time.
    model.load({
      seq: 1,
      items: [{ id: 1, method: 'GET', path: '/x', headers: [], deadline: T0 + 1000, claimed: true }],
      responses: [{ id: 1, deadline: T0 + 1000, envelope: { status: 200, headers: [] } }],
    });
    const expired = model.sweepExpired(T0 + 1001);
    assert.ok(expired.deleteKeys.includes(itemKeyOf(1)));
    assert.ok(expired.deleteKeys.includes(respKeyOf(1)));
  });

  test('resp:<id> orphans sweep at deadline + 60 s (strictly past)', () => {
    const model = createMailboxModel();
    park(model, { deadline: T0 + 1000 });
    model.respond(1, { status: 200, headers: [], body: { inline_b64: 'eA==' } }, T0);
    const atGrace = model.sweepExpired(T0 + 1000 + 60000);
    assert.equal(atGrace.deleteKeys.includes(respKeyOf(1)), false);
    const pastGrace = model.sweepExpired(T0 + 1000 + 60001);
    assert.ok(pastGrace.deleteKeys.includes(respKeyOf(1)));
  });

  test('alarmAt is the earliest pending deadline and nulls when empty', () => {
    const model = createMailboxModel();
    park(model, { deadline: T0 + 2000 });
    park(model, { deadline: T0 + 500 });
    assert.equal(model.sweepExpired(T0).alarmAt, T0 + 500);
    assert.equal(model.sweepExpired(T0 + 2001).alarmAt, null);
  });

  test('park refuses a preallocated id that collides with a live item', () => {
    const model = createMailboxModel();
    park(model, { id: 4 });
    assert.throws(() => park(model, { id: 4 }));
  });

  test('load() rehydrates a restarted model', () => {
    const model = createMailboxModel();
    const item = { id: 9, method: 'POST', path: '/y', headers: [], deadline: T0 + 5000, claimed: false };
    model.load({
      seq: 9,
      items: [item],
      responses: [{ id: 3, deadline: T0 + 5000, envelope: { status: 200, headers: [] } }],
    });
    const claimed = model.claim(T0).resolve[0].statusOrEnvelope;
    assert.equal(claimed.id, 9);
    assert.equal(park(model).persist.find((p) => p.key === 'seq').value, 10);
  });
});

describe('test-mode deadline clamp', () => {
  const T0 = 1_000_000_000;
  const pairsHeaders = (value) => [[TEST_DEADLINE_HEADER, value]];

  test('ignored entirely when testMode is false', () => {
    assert.equal(deadlineFor(T0, pairsHeaders('1500'), false), T0 + REQUEST_DEADLINE_MS);
  });
  test('shortens the deadline when testMode is true', () => {
    assert.equal(deadlineFor(T0, pairsHeaders('1500'), true), T0 + 1500);
    const headers = new Headers({ [TEST_DEADLINE_HEADER]: '1500' });
    assert.equal(deadlineFor(T0, headers, true), T0 + 1500);
  });
  test('never extends past the default deadline', () => {
    assert.equal(deadlineFor(T0, pairsHeaders(String(REQUEST_DEADLINE_MS * 10)), true), T0 + REQUEST_DEADLINE_MS);
  });
  test('absent or invalid header values fall back to the default', () => {
    assert.equal(deadlineFor(T0, [], true), T0 + REQUEST_DEADLINE_MS);
    assert.equal(deadlineFor(T0, pairsHeaders('abc'), true), T0 + REQUEST_DEADLINE_MS);
    assert.equal(deadlineFor(T0, pairsHeaders('0'), true), T0 + REQUEST_DEADLINE_MS);
    assert.equal(deadlineFor(T0, pairsHeaders('-5'), true), T0 + REQUEST_DEADLINE_MS);
    assert.equal(deadlineFor(T0, null, true), T0 + REQUEST_DEADLINE_MS);
  });
});

describe('classifyInboundBody (§1.3 inbound body decision)', () => {
  test('GET/HEAD are bodyless regardless of any content-length', () => {
    assert.deepEqual(classifyInboundBody('GET', null), { kind: 'none' });
    assert.deepEqual(classifyInboundBody('GET', undefined), { kind: 'none' });
    assert.deepEqual(classifyInboundBody('GET', 0), { kind: 'none' });
    assert.deepEqual(classifyInboundBody('GET', 128), { kind: 'none' });
    assert.deepEqual(classifyInboundBody('HEAD', null), { kind: 'none' });
    assert.deepEqual(classifyInboundBody('HEAD', INLINE_BODY_MAX_BYTES * 10), { kind: 'none' });
  });
  test('content-length exactly 0 is bodyless for body-bearing methods', () => {
    assert.deepEqual(classifyInboundBody('POST', 0), { kind: 'none' });
    assert.deepEqual(classifyInboundBody('PUT', 0), { kind: 'none' });
    assert.deepEqual(classifyInboundBody('DELETE', 0), { kind: 'none' });
  });
  test('small known length buffers inline (inclusive at the 768 KiB cap)', () => {
    assert.deepEqual(classifyInboundBody('POST', 1), { kind: 'inline' });
    assert.deepEqual(classifyInboundBody('POST', 1024), { kind: 'inline' });
    assert.deepEqual(classifyInboundBody('POST', INLINE_BODY_MAX_BYTES), { kind: 'inline' });
  });
  test('known length over the inline cap streams to R2', () => {
    assert.deepEqual(classifyInboundBody('POST', INLINE_BODY_MAX_BYTES + 1), { kind: 'stream' });
  });
  test('unknown or malformed length (null/undefined/NaN/negative) streams', () => {
    assert.deepEqual(classifyInboundBody('POST', null), { kind: 'stream' });
    assert.deepEqual(classifyInboundBody('POST', undefined), { kind: 'stream' });
    assert.deepEqual(classifyInboundBody('POST', NaN), { kind: 'stream' });
    assert.deepEqual(classifyInboundBody('POST', -1), { kind: 'stream' });
  });
  test('method matching is case-insensitive', () => {
    assert.deepEqual(classifyInboundBody('get', null), { kind: 'none' });
    assert.deepEqual(classifyInboundBody('head', 0), { kind: 'none' });
  });
});
