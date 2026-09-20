import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import {
  getOrCreateVapidKeys,
  encryptWebPushPayload,
  decryptWebPushPayload,
  createVapidAuthHeader,
  createPublicKeyFromRaw,
  readSubscriptions,
  saveSubscription,
  removeSubscription,
  pruneSubscriptions,
  sendWebPush,
  dispatchWebPushToAll,
  clipNotificationBody,
  NOTIF_BODY_MAX,
  type StoredSubscription,
} from '../src/lib/web-push.js';

describe('VAPID key generation and storage', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pa-vapid-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('generates new P-256 keys on first run and reads them back on subsequent runs', () => {
    const keys1 = getOrCreateVapidKeys(tempDir);
    assert.ok(keys1.publicKey, 'must have public key');
    assert.ok(keys1.privateKey, 'must have private key');
    assert.ok(keys1.subject, 'must have subject');

    // Public key should be 65 bytes in base64url (uncompressed point starts with 0x04)
    const pubBuf = Buffer.from(keys1.publicKey, 'base64url');
    assert.equal(pubBuf.length, 65);
    assert.equal(pubBuf[0], 0x04);

    // Private key should be 32 bytes in base64url
    const privBuf = Buffer.from(keys1.privateKey, 'base64url');
    assert.equal(privBuf.length, 32);

    // Second call reads existing file
    const keys2 = getOrCreateVapidKeys(tempDir);
    assert.deepEqual(keys1, keys2);
  });
});

describe('RFC 8291 test vectors (Appendix A)', () => {
  it('matches RFC 8291 Appendix A intermediate values and ciphertext bit-for-bit', () => {
    const clean = (s: string) => s.replace(/\s+/g, '');
    const authSecret = Buffer.from(clean('BTBZMqHH6r4Tts7J_aSIgg'), 'base64url');
    const salt = Buffer.from(clean('DGv6ra1nlYgDCS1FRnbzlw'), 'base64url');
    const uaPubBuf = Buffer.from(clean('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'), 'base64url');
    const uaPrivBuf = Buffer.from(clean('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), 'base64url');
    const asPubBuf = Buffer.from(clean('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'), 'base64url');
    const asPrivBuf = Buffer.from(clean('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), 'base64url');

    const plaintext = 'When I grow up, I want to be a watermelon';

    const subKeys = {
      p256dh: uaPubBuf.toString('base64url'),
      auth: authSecret.toString('base64url'),
    };

    const encrypted = encryptWebPushPayload(
      subKeys,
      plaintext,
      salt,
      { publicKey: asPubBuf, privateKey: asPrivBuf }
    );

    // RFC 8291 section 5 encrypted body:
    const expectedBodyB64 = clean(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
      'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
      'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
    );
    assert.equal(encrypted.body.toString('base64url'), expectedBodyB64);
    assert.equal(encrypted.headers['Content-Encoding'], 'aes128gcm');

    // Verify decryption of the RFC test vector
    const decrypted = decryptWebPushPayload(
      {
        p256dh: subKeys.p256dh,
        auth: subKeys.auth,
        privateKey: uaPrivBuf.toString('base64url'),
      },
      encrypted.body
    );
    assert.equal(decrypted.toString('utf8'), plaintext);
  });
});

describe('RFC 8291 encryption and decryption roundtrip', () => {
  it('encrypts and decrypts arbitrary payloads with randomly generated subscriber keys', () => {
    // Generate dummy subscriber keys
    const uaPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const uaPubJwk = uaPair.publicKey.export({ format: 'jwk' });
    const uaPrivJwk = uaPair.privateKey.export({ format: 'jwk' });
    const uaPubBuf = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(uaPubJwk.x!, 'base64url'),
      Buffer.from(uaPubJwk.y!, 'base64url'),
    ]);
    const uaPrivBuf = Buffer.from(uaPrivJwk.d!, 'base64url');
    const authSecret = crypto.randomBytes(16);

    const subKeys = {
      p256dh: uaPubBuf.toString('base64url'),
      auth: authSecret.toString('base64url'),
    };

    const messages = [
      'Short test',
      JSON.stringify({ title: 'Task Completed', body: 'Result is ready', data: { url: './' } }),
      'UTF-8 test: 🚀 ✨ 🔔 日本語 accented characters áéíóú',
    ];

    for (const msg of messages) {
      const encrypted = encryptWebPushPayload(subKeys, msg);
      assert.equal(encrypted.headers['Content-Encoding'], 'aes128gcm');
      assert.equal(encrypted.headers['Content-Type'], 'application/octet-stream');

      const decrypted = decryptWebPushPayload(
        {
          p256dh: subKeys.p256dh,
          auth: subKeys.auth,
          privateKey: uaPrivBuf.toString('base64url'),
        },
        encrypted.body
      );
      assert.equal(decrypted.toString('utf8'), msg);
    }
  });
});

describe('RFC 8292 VAPID JWT auth header', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pa-vapid-jwt-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('generates valid ES256 VAPID Authorization header verifiable with public key', () => {
    const vapidKeys = getOrCreateVapidKeys(tempDir);
    const endpoint = 'https://fcm.googleapis.com/fcm/send/test-sub-12345';
    const authHeader = createVapidAuthHeader(endpoint, vapidKeys);

    assert.ok(authHeader.startsWith('vapid t='), 'must start with vapid t=');
    assert.ok(authHeader.includes(', k='), 'must include , k=');

    const match = /^vapid t=([^,]+), k=(.+)$/.exec(authHeader);
    assert.ok(match, 'header must match vapid regex');
    const jwt = match[1];
    const pubKeyParam = match[2];

    assert.equal(pubKeyParam, vapidKeys.publicKey);

    // Verify JWT structure: header.payload.signature
    const parts = jwt.split('.');
    assert.equal(parts.length, 3);

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    assert.equal(header.typ, 'JWT');
    assert.equal(header.alg, 'ES256');

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    assert.equal(payload.aud, 'https://fcm.googleapis.com');
    assert.equal(payload.sub, vapidKeys.subject);
    assert.ok(payload.exp > Math.floor(Date.now() / 1000));

    // Verify signature with VAPID public key
    const rawPub = Buffer.from(vapidKeys.publicKey, 'base64url');
    const pubKey = createPublicKeyFromRaw(rawPub);
    const data = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
    const signature = Buffer.from(parts[2], 'base64url');

    const verified = crypto.verify('SHA256', data, { key: pubKey, dsaEncoding: 'ieee-p1363' }, signature);
    assert.equal(verified, true, 'signature must be valid');
  });
});

describe('sendWebPush & dispatchWebPushToAll', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pa-dispatch-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeMockSub(id: string): StoredSubscription {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pubJwk = pair.publicKey.export({ format: 'jwk' });
    const pubBuf = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(pubJwk.x!, 'base64url'),
      Buffer.from(pubJwk.y!, 'base64url'),
    ]);
    return {
      endpoint: `https://push.example.com/sub/${id}`,
      keys: {
        p256dh: pubBuf.toString('base64url'),
        auth: crypto.randomBytes(16).toString('base64url'),
      },
    };
  }

  it('sendWebPush sends HTTP POST with encryption and VAPID headers', async () => {
    const vapidKeys = getOrCreateVapidKeys(tempDir);
    const sub = makeMockSub('client-1');

    const captured: { url: string; headers: Record<string, string>; body: any } = {
      url: '',
      headers: {},
      body: null,
    };

    const mockFetch = (async (url: any, init: any) => {
      captured.url = String(url);
      captured.headers = init.headers;
      captured.body = init.body;
      return new Response('', { status: 201 });
    }) as typeof fetch;

    const res = await sendWebPush(sub, { title: 'Test Title' }, vapidKeys, {
      storageDir: tempDir,
      fetchFn: mockFetch,
    });

    assert.equal(res.ok, true);
    assert.equal(res.status, 201);
    assert.equal(captured.url, sub.endpoint);
    assert.equal(captured.headers['Content-Encoding'], 'aes128gcm');
    assert.ok(captured.headers['Authorization'].startsWith('vapid t='));
    assert.ok(captured.body && captured.body.length > 86);
  });

  it('sendWebPush automatically prunes expired subscriptions on 404 or 410', async () => {
    const vapidKeys = getOrCreateVapidKeys(tempDir);
    const sub = makeMockSub('client-dead');
    saveSubscription(sub, tempDir);
    assert.equal(readSubscriptions(tempDir).length, 1);

    const mockFetch = (async () => new Response('', { status: 410 })) as typeof fetch;

    const res = await sendWebPush(sub, { title: 'Test' }, vapidKeys, {
      storageDir: tempDir,
      fetchFn: mockFetch,
    });

    assert.equal(res.ok, false);
    assert.equal(res.status, 410);
    assert.equal(res.pruned, true);
    // Verified pruned from disk
    assert.equal(readSubscriptions(tempDir).length, 0);
  });

  it('dispatchWebPushToAll returns reason no-subscriptions when store is empty', async () => {
    const res = await dispatchWebPushToAll('Title', 'Body', { storageDir: tempDir });
    assert.equal(res.ok, true);
    assert.equal(res.sent, 0);
    assert.equal(res.reason, 'no-subscriptions');
  });

  it('dispatchWebPushToAll dispatches concurrently and prunes failing 404/410 subscriptions', async () => {
    const subLive = makeMockSub('live');
    const subDead = makeMockSub('dead');
    saveSubscription(subLive, tempDir);
    saveSubscription(subDead, tempDir);
    assert.equal(readSubscriptions(tempDir).length, 2);

    const mockFetch = (async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('live')) {
        return new Response('', { status: 201 });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const res = await dispatchWebPushToAll('New Task', 'Details here', {
      storageDir: tempDir,
      fetchFn: mockFetch,
    });

    assert.equal(res.ok, true);
    assert.equal(res.sent, 1);
    assert.equal(res.failed, 1);
    assert.equal(res.pruned, 1);

    const remaining = readSubscriptions(tempDir);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].endpoint, subLive.endpoint);
  });
});

describe('notification body preview cap (vi-77c9ccd3865e)', () => {
  it('clipNotificationBody passes short bodies through unchanged', () => {
    assert.equal(clipNotificationBody('Ready.'), 'Ready.');
    assert.equal(clipNotificationBody(''), '');
    assert.equal(clipNotificationBody(undefined as any), '');
    const exact = 'x'.repeat(NOTIF_BODY_MAX);
    assert.equal(clipNotificationBody(exact), exact);
  });

  it('clipNotificationBody cuts long bodies at the cap on a word boundary with an ellipsis', () => {
    const long = ('preview text '.repeat(30)).trim(); // ~390 chars
    const out = clipNotificationBody(long);
    assert.ok(out.length <= NOTIF_BODY_MAX, `clipped body ${out.length} exceeds cap`);
    assert.ok(out.endsWith('…'), 'clipped body must end with an ellipsis');
    assert.ok(!/\s…$/.test(out), 'no dangling space before the ellipsis');
    // Collapses whitespace runs first — no mid-notification newlines.
    assert.equal(clipNotificationBody('line one\n\nline   two'), 'line one line two');
  });

  it('dispatchWebPushToAll sends the clipped preview, not the full body', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'pa-clip-test-'));
    try {
      const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const pubJwk = pair.publicKey.export({ format: 'jwk' });
      const privJwk = pair.privateKey.export({ format: 'jwk' });
      const pubBuf = Buffer.concat([
        Buffer.from([0x04]),
        Buffer.from(pubJwk.x!, 'base64url'),
        Buffer.from(pubJwk.y!, 'base64url'),
      ]);
      const privB64 = Buffer.from(privJwk.d!, 'base64url').toString('base64url');
      const sub: StoredSubscription = {
        endpoint: 'https://push.example.com/sub/clip',
        keys: { p256dh: pubBuf.toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
      };
      saveSubscription(sub, tempDir);

      let capturedBody: any = null;
      const mockFetch = (async (_url: any, init: any) => {
        capturedBody = init.body;
        return new Response('', { status: 201 });
      }) as typeof fetch;

      const longBody = 'The answer '.repeat(80); // ~880 chars
      const res = await dispatchWebPushToAll('Task done', longBody, {
        storageDir: tempDir,
        fetchFn: mockFetch,
      });
      assert.equal(res.sent, 1);

      const decrypted = decryptWebPushPayload(
        { p256dh: sub.keys.p256dh, auth: sub.keys.auth, privateKey: privB64 },
        Buffer.from(capturedBody)
      );
      const payload = JSON.parse(decrypted.toString('utf8'));
      assert.ok(payload.body.length <= NOTIF_BODY_MAX);
      assert.ok(payload.body.endsWith('…'));
      assert.equal(payload.title, 'Task done');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
