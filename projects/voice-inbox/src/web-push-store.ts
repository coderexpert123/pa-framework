/**
 * Web Push subscription storage + VAPID public-key vending for the
 * voice-inbox HTTP API (WP2 of the 2026-09-11 web-push notifications spec).
 *
 * This package does NOT duplicate the RFC 8291/8292 encryption + dispatch
 * engine — that lives in pa/src/lib/web-push.ts (WP1) and is the only writer
 * of actual push deliveries. This module only owns:
 *   - reading/writing `~/.pa/voice-inbox/push-subscriptions.json` (the
 *     browser's PushSubscription objects, upserted by endpoint), and
 *   - getting-or-creating `~/.pa/voice-inbox/vapid.json` (the VAPID key pair)
 *     so the browser can request a subscription even before pa's side has
 *     ever run.
 *
 * COMPATIBILITY CONTRACT (the one correctness-critical point in this file):
 * both files are read AND written by both this process and the pa process.
 * `getOrCreateVapidPublicKey` below reuses pa/src/lib/web-push.ts's
 * `getOrCreateVapidKeys` algorithm verbatim — same `crypto.generateKeyPairSync('ec',
 * {namedCurve:'prime256v1'})`, same JWK export, same 65-byte uncompressed
 * public key / 32-byte private scalar raw encoding, same `{publicKey,
 * privateKey, subject}` JSON shape, same `PA_VAPID_SUBJECT` env fallback —
 * so whichever side runs first creates a file the other reads as-is, with
 * no format drift. Do not change this shape without updating
 * pa/src/lib/web-push.ts (out of this file's ownership) in lockstep.
 *
 * Every exported function takes an optional trailing `storageDir` — the same
 * test seam pa/src/lib/web-push.ts's functions already use — so tests never
 * touch the operator's real `~/.pa`.
 */

import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pushSubscriptionsPath, vapidKeysPath, voiceInboxDir } from './config.js';

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface StoredSubscription {
  endpoint: string;
  keys: PushSubscriptionKeys;
  tenantId?: string;
  userAgent?: string;
  createdAt?: string;
  lastUsedAt?: string;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

function subsPath(storageDir?: string): string {
  return storageDir ? join(storageDir, 'push-subscriptions.json') : pushSubscriptionsPath();
}

function vapidPath(storageDir?: string): string {
  return storageDir ? join(storageDir, 'vapid.json') : vapidKeysPath();
}

function readSubscriptionsRaw(storageDir?: string): StoredSubscription[] {
  const filePath = subsPath(storageDir);
  if (!existsSync(filePath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s: any): s is StoredSubscription =>
        s &&
        typeof s.endpoint === 'string' &&
        s.keys &&
        typeof s.keys.p256dh === 'string' &&
        typeof s.keys.auth === 'string'
    );
  } catch {
    return [];
  }
}

function writeSubscriptionsRaw(subs: StoredSubscription[], storageDir?: string): void {
  const dir = storageDir ?? voiceInboxDir();
  const filePath = subsPath(storageDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(subs, null, 2), { mode: 0o600 });
}

/** Read stored subscriptions, optionally filtered by tenantId. Never throws —
 * a missing or corrupt file reads as []. */
export function getSubscriptions(tenantId?: string, storageDir?: string): StoredSubscription[] {
  const subs = readSubscriptionsRaw(storageDir);
  return tenantId === undefined ? subs : subs.filter((s) => s.tenantId === tenantId);
}

/** Upsert a subscription by endpoint: updates `lastUsedAt` to now, preserves
 * the original `createdAt` on update, sets `createdAt` on insert. */
export function saveSubscription(sub: StoredSubscription, storageDir?: string): void {
  const subs = readSubscriptionsRaw(storageDir);
  const idx = subs.findIndex((s) => s.endpoint === sub.endpoint);
  const nowIso = new Date().toISOString();
  const entry: StoredSubscription = {
    ...sub,
    lastUsedAt: nowIso,
    createdAt: idx >= 0 ? (subs[idx].createdAt ?? sub.createdAt ?? nowIso) : (sub.createdAt ?? nowIso),
  };
  if (idx >= 0) {
    subs[idx] = entry;
  } else {
    subs.push(entry);
  }
  writeSubscriptionsRaw(subs, storageDir);
}

/** Remove a subscription by endpoint. No-op if not found. */
export function removeSubscription(endpoint: string, storageDir?: string): void {
  const subs = readSubscriptionsRaw(storageDir);
  const next = subs.filter((s) => s.endpoint !== endpoint);
  if (next.length !== subs.length) {
    writeSubscriptionsRaw(next, storageDir);
  }
}

/** Remove all subscriptions whose endpoint appears in `endpoints`. No-op on
 * an empty list or when none match. */
export function pruneSubscriptions(endpoints: string[], storageDir?: string): void {
  if (endpoints.length === 0) return;
  const set = new Set(endpoints);
  const subs = readSubscriptionsRaw(storageDir);
  const next = subs.filter((s) => !set.has(s.endpoint));
  if (next.length !== subs.length) {
    writeSubscriptionsRaw(next, storageDir);
  }
}

/**
 * Get-or-create the VAPID key pair and return just the public key (the only
 * thing the browser needs to call `pushManager.subscribe`). Mirrors
 * pa/src/lib/web-push.ts's `getOrCreateVapidKeys` byte-for-byte (see module
 * doc above) so the SAME vapid.json round-trips identically on both sides.
 */
export function getOrCreateVapidPublicKey(storageDir?: string): string {
  const filePath = vapidPath(storageDir);

  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<VapidKeys>;
      if (
        typeof parsed.publicKey === 'string' &&
        typeof parsed.privateKey === 'string' &&
        typeof parsed.subject === 'string'
      ) {
        return parsed.publicKey;
      }
    } catch {
      // Falls through to regeneration, same as the pa-side implementation.
    }
  }

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

  const dir = storageDir ?? voiceInboxDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(vapidKeys, null, 2), { mode: 0o600 });
  return vapidKeys.publicKey;
}
