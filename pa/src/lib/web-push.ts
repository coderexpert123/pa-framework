/**
 * Web Push Engine (RFC 8291, RFC 8292) using Node 22 native crypto.
 *
 * Implements:
 *   - P-256 VAPID key generation and storage in ~/.pa/voice-inbox/vapid.json.
 *   - RFC 8291 Section 3.2 aes128gcm payload encryption:
 *       * P-256 ECDH key agreement
 *       * HKDF SHA-256 derivation with subscriber auth secret
 *       * AES-128-GCM encryption with 16-byte salt, 4-byte BE rs=4096, 1-byte idlen=65, ephemeral pubkey, delimiter 0x02
 *   - RFC 8292 VAPID ES256 JWT signing and Authorization: vapid t=<jwt>, k=<pubkey> header generation.
 *   - sendWebPush with HTTP POST, auto-pruning on HTTP 404/410.
 *   - dispatchWebPushToAll reading subscriptions from ~/.pa/voice-inbox/push-subscriptions.json.
 */

import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paHome } from '../paths.js';
import { log } from './log.js';

export interface VapidKeys {
  publicKey: string;  // base64url uncompressed 65-byte EC P-256 public key (starts with 0x04)
  privateKey: string; // base64url 32-byte EC P-256 private scalar d
  subject: string;    // e.g. mailto:operator@personal-assistant.local
}

export interface PushSubscriptionKeys {
  p256dh: string; // base64url uncompressed 65-byte public key
  auth: string;   // base64url 16-byte authentication secret
}

export interface StoredSubscription {
  endpoint: string;
  keys: PushSubscriptionKeys;
  tenantId?: string;
  userAgent?: string;
  createdAt?: string;
  lastUsedAt?: string;
}

export interface WebPushPayload {
  title: string;
  body?: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

export interface SendResult {
  ok: boolean;
  status: number;
  pruned?: boolean;
  error?: string;
}

export interface WebPushDispatchResult {
  ok: boolean;
  sent: number;
  failed: number;
  pruned: number;
  reason?: 'disabled' | 'no-subscriptions' | 'error';
}

export function defaultStorageDir(): string {
  return join(paHome(), 'voice-inbox');
}

/**
 * Clean base64url string: remove spaces/newlines, URL-safe decoding helper.
 */
function cleanB64(str: string): string {
  return str.replace(/\s+/g, '');
}

/**
 * Import raw uncompressed 65-byte public key buffer into crypto.KeyObject.
 */
export function createPublicKeyFromRaw(rawPub: Buffer): crypto.KeyObject {
  if (rawPub.length !== 65 || rawPub[0] !== 0x04) {
    throw new Error(`Invalid uncompressed P-256 public key (length=${rawPub.length}, first byte=${rawPub[0]})`);
  }
  const x = rawPub.subarray(1, 33).toString('base64url');
  const y = rawPub.subarray(33, 65).toString('base64url');
  return crypto.createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x, y },
  });
}

/**
 * Import raw 32-byte private scalar d and 65-byte public key into crypto.KeyObject.
 */
export function createPrivateKeyFromRaw(rawPub: Buffer, rawPriv: Buffer): crypto.KeyObject {
  if (rawPub.length !== 65 || rawPub[0] !== 0x04) {
    throw new Error(`Invalid uncompressed P-256 public key (length=${rawPub.length})`);
  }
  if (rawPriv.length !== 32) {
    throw new Error(`Invalid P-256 private key scalar (length=${rawPriv.length})`);
  }
  const x = rawPub.subarray(1, 33).toString('base64url');
  const y = rawPub.subarray(33, 65).toString('base64url');
  const d = rawPriv.toString('base64url');
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x, y, d },
  });
}

/**
 * Get or create VAPID key pair in ~/.pa/voice-inbox/vapid.json (or storageDir/vapid.json).
 */
export function getOrCreateVapidKeys(storageDir?: string): VapidKeys {
  const dir = storageDir ?? defaultStorageDir();
  const vapidPath = join(dir, 'vapid.json');

  if (existsSync(vapidPath)) {
    try {
      const parsed = JSON.parse(readFileSync(vapidPath, 'utf8')) as Partial<VapidKeys>;
      if (
        typeof parsed.publicKey === 'string' &&
        typeof parsed.privateKey === 'string' &&
        typeof parsed.subject === 'string'
      ) {
        return {
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey,
          subject: parsed.subject,
        };
      }
    } catch (err: any) {
      log('warn', 'webpush', 'failed to parse vapid.json, regenerating', { error: err?.message });
    }
  }

  // Generate new P-256 EC key pair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });

  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });

  const rawPub = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(pubJwk.x!, 'base64url'),
    Buffer.from(pubJwk.y!, 'base64url'),
  ]);
  const rawPriv = Buffer.from(privJwk.d!, 'base64url');

  const subject = process.env.PA_VAPID_SUBJECT || 'mailto:operator@personal-assistant.local';

  const vapidKeys: VapidKeys = {
    publicKey: rawPub.toString('base64url'),
    privateKey: rawPriv.toString('base64url'),
    subject,
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(vapidPath, JSON.stringify(vapidKeys, null, 2), { mode: 0o600 });
  return vapidKeys;
}

/**
 * Encrypt a Web Push payload following RFC 8291 Section 3.2 (aes128gcm).
 */
export function encryptWebPushPayload(
  subKeys: PushSubscriptionKeys,
  payload: Buffer | string,
  testSalt?: Buffer,
  testAsPair?: { publicKey: Buffer; privateKey: Buffer }
): { body: Buffer; headers: Record<string, string> } {
  const payloadBuf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;

  const uaPubBuf = Buffer.from(cleanB64(subKeys.p256dh), 'base64url');
  const authSecret = Buffer.from(cleanB64(subKeys.auth), 'base64url');

  if (uaPubBuf.length !== 65 || uaPubBuf[0] !== 0x04) {
    throw new Error(`Invalid subscriber public key (length=${uaPubBuf.length})`);
  }
  if (authSecret.length !== 16) {
    throw new Error(`Invalid subscriber auth secret (length=${authSecret.length}, expected 16)`);
  }

  const uaPubKey = createPublicKeyFromRaw(uaPubBuf);

  // Application server ephemeral key pair
  let asPubBuf: Buffer;
  let asPrivKey: crypto.KeyObject;

  if (testAsPair) {
    asPubBuf = testAsPair.publicKey;
    asPrivKey = createPrivateKeyFromRaw(testAsPair.publicKey, testAsPair.privateKey);
  } else {
    const asPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const asPubJwk = asPair.publicKey.export({ format: 'jwk' });
    asPubBuf = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(asPubJwk.x!, 'base64url'),
      Buffer.from(asPubJwk.y!, 'base64url'),
    ]);
    asPrivKey = asPair.privateKey;
  }

  const salt = testSalt ?? crypto.randomBytes(16);
  if (salt.length !== 16) {
    throw new Error(`Salt must be 16 bytes (got ${salt.length})`);
  }

  // RFC 8291 Section 3.1 & 3.4
  const ecdhSecret = crypto.diffieHellman({ privateKey: asPrivKey, publicKey: uaPubKey });

  // key_info = "WebPush: info" || 0x00 || ua_public || as_public
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    uaPubBuf,
    asPubBuf,
  ]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));

  // RFC 8188 key and nonce derivation
  const cekInfo = Buffer.from('Content-Encoding: aes128gcm\0', 'utf8');
  const nonceInfo = Buffer.from('Content-Encoding: nonce\0', 'utf8');
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, cekInfo, 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, nonceInfo, 12));

  // Plaintext + delimiter (0x02 for the final/only record)
  const padded = Buffer.concat([payloadBuf, Buffer.from([0x02])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  const tag = cipher.getAuthTag();

  // 86-byte header: salt (16) + rs=4096 (4 BE) + idlen=65 (1) + as_public (65)
  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(4096, 0);
  const idlenBuf = Buffer.from([asPubBuf.length]);
  const header = Buffer.concat([salt, rsBuf, idlenBuf, asPubBuf]);

  const body = Buffer.concat([header, ciphertext, tag]);

  return {
    body,
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
    },
  };
}

/**
 * Decrypt an RFC 8291 aes128gcm Web Push payload. Used for unit tests and verification.
 */
export function decryptWebPushPayload(
  subKeys: { p256dh: string; auth: string; privateKey: string },
  body: Buffer
): Buffer {
  if (body.length < 86 + 16) {
    throw new Error(`Ciphertext too short: ${body.length} bytes`);
  }

  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  if (rs < 18) {
    throw new Error(`Invalid record size: ${rs}`);
  }
  const idlen = body.readUInt8(20);
  if (idlen !== 65) {
    throw new Error(`Unexpected idlen: ${idlen}`);
  }
  const asPubBuf = body.subarray(21, 21 + idlen);
  const encryptedAndTag = body.subarray(21 + idlen);

  const uaPubBuf = Buffer.from(cleanB64(subKeys.p256dh), 'base64url');
  const uaPrivBuf = Buffer.from(cleanB64(subKeys.privateKey), 'base64url');
  const authSecret = Buffer.from(cleanB64(subKeys.auth), 'base64url');

  const uaPrivKey = createPrivateKeyFromRaw(uaPubBuf, uaPrivBuf);
  const asPubKey = createPublicKeyFromRaw(asPubBuf);

  const ecdhSecret = crypto.diffieHellman({ privateKey: uaPrivKey, publicKey: asPubKey });
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    uaPubBuf,
    asPubBuf,
  ]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));

  const cekInfo = Buffer.from('Content-Encoding: aes128gcm\0', 'utf8');
  const nonceInfo = Buffer.from('Content-Encoding: nonce\0', 'utf8');
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, cekInfo, 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, nonceInfo, 12));

  const tag = encryptedAndTag.subarray(encryptedAndTag.length - 16);
  const ciphertext = encryptedAndTag.subarray(0, encryptedAndTag.length - 16);

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const decryptedPadded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  if (decryptedPadded.length === 0) {
    throw new Error('Empty decrypted payload');
  }
  const delimiter = decryptedPadded[decryptedPadded.length - 1];
  if (delimiter !== 0x02) {
    throw new Error(`Invalid padding delimiter: 0x${delimiter.toString(16)}, expected 0x02`);
  }
  return decryptedPadded.subarray(0, decryptedPadded.length - 1);
}

/**
 * Generate RFC 8292 VAPID Authorization header (ES256 JWT):
 * `vapid t=<jwt>, k=<vapidPublicKeyBase64Url>`
 */
export function createVapidAuthHeader(
  endpoint: string,
  vapidKeys: VapidKeys,
  expirationSeconds = 12 * 3600
): string {
  const url = new URL(endpoint);
  const aud = url.origin;

  const headerJson = JSON.stringify({ typ: 'JWT', alg: 'ES256' });
  const headerB64 = Buffer.from(headerJson).toString('base64url');

  const nowSec = Math.floor(Date.now() / 1000);
  const payloadJson = JSON.stringify({
    aud,
    exp: nowSec + expirationSeconds,
    sub: vapidKeys.subject,
  });
  const payloadB64 = Buffer.from(payloadJson).toString('base64url');

  const unsignedToken = `${headerB64}.${payloadB64}`;

  const rawPub = Buffer.from(cleanB64(vapidKeys.publicKey), 'base64url');
  const rawPriv = Buffer.from(cleanB64(vapidKeys.privateKey), 'base64url');
  const privKey = createPrivateKeyFromRaw(rawPub, rawPriv);

  const sig = crypto
    .sign('SHA256', Buffer.from(unsignedToken, 'utf8'), {
      key: privKey,
      dsaEncoding: 'ieee-p1363',
    })
    .toString('base64url');

  const jwt = `${unsignedToken}.${sig}`;
  return `vapid t=${jwt}, k=${vapidKeys.publicKey}`;
}

/**
 * Read subscriptions from ~/.pa/voice-inbox/push-subscriptions.json (or storageDir).
 */
export function readSubscriptions(storageDir?: string): StoredSubscription[] {
  const dir = storageDir ?? defaultStorageDir();
  const filePath = join(dir, 'push-subscriptions.json');
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s: any): s is StoredSubscription =>
        s &&
        typeof s.endpoint === 'string' &&
        s.keys &&
        typeof s.keys.p256dh === 'string' &&
        typeof s.keys.auth === 'string'
    );
  } catch (err: any) {
    log('warn', 'webpush', 'failed to read push-subscriptions.json', { error: err?.message });
    return [];
  }
}

/**
 * Write subscriptions to ~/.pa/voice-inbox/push-subscriptions.json (or storageDir).
 */
export function writeSubscriptions(subs: StoredSubscription[], storageDir?: string): void {
  const dir = storageDir ?? defaultStorageDir();
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'push-subscriptions.json');
  writeFileSync(filePath, JSON.stringify(subs, null, 2), { mode: 0o600 });
}

/**
 * Save or update a subscription in push-subscriptions.json.
 */
export function saveSubscription(sub: StoredSubscription, storageDir?: string): void {
  const subs = readSubscriptions(storageDir);
  const idx = subs.findIndex((s) => s.endpoint === sub.endpoint);
  const entry: StoredSubscription = {
    ...sub,
    lastUsedAt: new Date().toISOString(),
    createdAt: idx >= 0 ? (subs[idx].createdAt ?? sub.createdAt ?? new Date().toISOString()) : (sub.createdAt ?? new Date().toISOString()),
  };
  if (idx >= 0) {
    subs[idx] = entry;
  } else {
    subs.push(entry);
  }
  writeSubscriptions(subs, storageDir);
}

/**
 * Remove a subscription by endpoint.
 */
export function removeSubscription(endpoint: string, storageDir?: string): void {
  const subs = readSubscriptions(storageDir);
  const next = subs.filter((s) => s.endpoint !== endpoint);
  if (next.length !== subs.length) {
    writeSubscriptions(next, storageDir);
  }
}

/**
 * Prune subscriptions whose endpoints match the provided list.
 */
export function pruneSubscriptions(endpoints: string[], storageDir?: string): void {
  if (endpoints.length === 0) return;
  const set = new Set(endpoints);
  const subs = readSubscriptions(storageDir);
  const next = subs.filter((s) => !set.has(s.endpoint));
  if (next.length !== subs.length) {
    writeSubscriptions(next, storageDir);
  }
}

/**
 * Send one Web Push notification to a subscription.
 * Auto-prunes subscription if push service returns HTTP 404 or 410.
 */
export async function sendWebPush(
  subscription: StoredSubscription,
  payload: WebPushPayload | string,
  vapidKeys?: VapidKeys,
  opts?: { storageDir?: string; fetchFn?: typeof fetch }
): Promise<SendResult> {
  const keys = vapidKeys ?? getOrCreateVapidKeys(opts?.storageDir);
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

  let encrypted;
  try {
    encrypted = encryptWebPushPayload(subscription.keys, payloadStr);
  } catch (err: any) {
    log('warn', 'webpush', 'payload encryption failed', { error: err?.message, endpoint: subscription.endpoint });
    return { ok: false, status: 0, error: err?.message };
  }

  let authHeader;
  try {
    authHeader = createVapidAuthHeader(subscription.endpoint, keys);
  } catch (err: any) {
    log('warn', 'webpush', 'VAPID auth header generation failed', { error: err?.message, endpoint: subscription.endpoint });
    return { ok: false, status: 0, error: err?.message };
  }

  const headers: Record<string, string> = {
    ...encrypted.headers,
    Authorization: authHeader,
    TTL: '86400',
    Urgency: 'high',
  };

  const fetchFn = opts?.fetchFn ?? globalThis.fetch;
  try {
    const res = await fetchFn(subscription.endpoint, {
      method: 'POST',
      headers,
      body: new Uint8Array(encrypted.body),
    });

    if (res.status === 404 || res.status === 410) {
      log('info', 'webpush', 'push subscription expired, pruning', {
        status: res.status,
        endpoint: subscription.endpoint,
      });
      removeSubscription(subscription.endpoint, opts?.storageDir);
      return { ok: false, status: res.status, pruned: true };
    }

    if (res.ok) {
      return { ok: true, status: res.status };
    }

    log('warn', 'webpush', 'push service returned error', {
      status: res.status,
      endpoint: subscription.endpoint,
    });
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err: any) {
    log('warn', 'webpush', 'push fetch network error', {
      error: err?.message,
      endpoint: subscription.endpoint,
    });
    return { ok: false, status: 0, error: err?.message };
  }
}

/**
 * OS notification body preview cap (vi-77c9ccd3865e, 2026-09-14): push
 * payloads carry a short preview only — a word-boundary cut plus an
 * ellipsis. The full text stays in the ledger/app. Mirrored as a literal in
 * voice-inbox's src/contracts.ts, public/app.js and public/sw.js.
 */
export const NOTIF_BODY_MAX = 140;

/** Word-boundary cut to NOTIF_BODY_MAX with an ellipsis; short text passes through. */
export function clipNotificationBody(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > NOTIF_BODY_MAX
    ? t.slice(0, NOTIF_BODY_MAX - 1).replace(/\s+\S*$/, '') + '…'
    : t;
}

/**
 * Dispatch a notification to all stored push subscriptions concurrently.
 */
export async function dispatchWebPushToAll(
  subject: string,
  body: string,
  opts?: {
    tag?: string;
    url?: string;
    data?: Record<string, unknown>;
    storageDir?: string;
    fetchFn?: typeof fetch;
  }
): Promise<WebPushDispatchResult> {
  const subs = readSubscriptions(opts?.storageDir);
  if (subs.length === 0) {
    return { ok: true, sent: 0, failed: 0, pruned: 0, reason: 'no-subscriptions' };
  }

  const vapidKeys = getOrCreateVapidKeys(opts?.storageDir);
  const payload: WebPushPayload = {
    title: subject,
    body: clipNotificationBody(body),
    tag: opts?.tag || 'pa-attention',
    icon: './icons/icon-192.png',
    // Monochrome status-bar glyph (2026-09-17): Android renders `badge`
    // alpha-only, so the colour launcher icon painted as a solid block and
    // Chrome's own badge showed instead.
    badge: './icons/badge-96.png',
    data: {
      url: opts?.url || './',
      ...(opts?.data || {}),
    },
  };

  const results = await Promise.allSettled(
    subs.map((sub) => sendWebPush(sub, payload, vapidKeys, opts))
  );

  let sent = 0;
  let failed = 0;
  let pruned = 0;

  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value.ok) sent++;
      else {
        failed++;
        if (r.value.pruned) pruned++;
      }
    } else {
      failed++;
    }
  }

  const ok = sent > 0 || (failed === 0 && pruned === 0);
  return { ok, sent, failed, pruned };
}
