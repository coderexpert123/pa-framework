/**
 * web-push-store tests (WP2, 2026-09-11 web-push notifications spec):
 * subscription save/get/remove/prune round-trips, and the
 * get-or-create-VAPID-key compatibility contract with
 * pa/src/lib/web-push.ts's `getOrCreateVapidKeys` (same file shape, same
 * storageDir test seam).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getOrCreateVapidPublicKey,
  getSubscriptions,
  pruneSubscriptions,
  removeSubscription,
  saveSubscription,
  type StoredSubscription,
} from '../web-push-store.js';

interface Fixture {
  dir: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'webpush-store-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sub(endpoint: string, tenantId = 't-1'): StoredSubscription {
  return {
    endpoint,
    keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
    tenantId,
  };
}

describe('subscription store', () => {
  it('save+get round-trips', () => {
    const fx = makeFixture();
    try {
      saveSubscription(sub('https://push.example/a'), fx.dir);
      const subs = getSubscriptions(undefined, fx.dir);
      assert.equal(subs.length, 1);
      assert.equal(subs[0].endpoint, 'https://push.example/a');
      assert.deepEqual(subs[0].keys, { p256dh: 'p256dh-value', auth: 'auth-value' });
    } finally {
      fx.cleanup();
    }
  });

  it('getSubscriptions filters by tenantId', () => {
    const fx = makeFixture();
    try {
      saveSubscription(sub('https://push.example/a', 't-1'), fx.dir);
      saveSubscription(sub('https://push.example/b', 't-2'), fx.dir);
      const t1 = getSubscriptions('t-1', fx.dir);
      assert.equal(t1.length, 1);
      assert.equal(t1[0].endpoint, 'https://push.example/a');
      const all = getSubscriptions(undefined, fx.dir);
      assert.equal(all.length, 2);
    } finally {
      fx.cleanup();
    }
  });

  it('upsert preserves createdAt and updates lastUsedAt', async () => {
    const fx = makeFixture();
    try {
      saveSubscription(sub('https://push.example/a'), fx.dir);
      const first = getSubscriptions(undefined, fx.dir)[0];
      assert.ok(first.createdAt);
      assert.ok(first.lastUsedAt);

      // Ensure a distinguishable timestamp on the second save.
      await new Promise((r) => setTimeout(r, 5));
      saveSubscription(sub('https://push.example/a'), fx.dir);
      const second = getSubscriptions(undefined, fx.dir)[0];
      assert.equal(second.createdAt, first.createdAt);
      assert.notEqual(second.lastUsedAt, first.lastUsedAt);
    } finally {
      fx.cleanup();
    }
  });

  it('remove deletes by endpoint', () => {
    const fx = makeFixture();
    try {
      saveSubscription(sub('https://push.example/a'), fx.dir);
      saveSubscription(sub('https://push.example/b'), fx.dir);
      removeSubscription('https://push.example/a', fx.dir);
      const subs = getSubscriptions(undefined, fx.dir);
      assert.equal(subs.length, 1);
      assert.equal(subs[0].endpoint, 'https://push.example/b');
    } finally {
      fx.cleanup();
    }
  });

  it('prune removes multiple endpoints', () => {
    const fx = makeFixture();
    try {
      saveSubscription(sub('https://push.example/a'), fx.dir);
      saveSubscription(sub('https://push.example/b'), fx.dir);
      saveSubscription(sub('https://push.example/c'), fx.dir);
      pruneSubscriptions(['https://push.example/a', 'https://push.example/c'], fx.dir);
      const subs = getSubscriptions(undefined, fx.dir);
      assert.equal(subs.length, 1);
      assert.equal(subs[0].endpoint, 'https://push.example/b');
    } finally {
      fx.cleanup();
    }
  });

  it('prune is a no-op on an empty list', () => {
    const fx = makeFixture();
    try {
      saveSubscription(sub('https://push.example/a'), fx.dir);
      pruneSubscriptions([], fx.dir);
      assert.equal(getSubscriptions(undefined, fx.dir).length, 1);
    } finally {
      fx.cleanup();
    }
  });

  it('prune is a no-op when no endpoint matches', () => {
    const fx = makeFixture();
    try {
      saveSubscription(sub('https://push.example/a'), fx.dir);
      pruneSubscriptions(['https://push.example/nonexistent'], fx.dir);
      assert.equal(getSubscriptions(undefined, fx.dir).length, 1);
    } finally {
      fx.cleanup();
    }
  });

  it('getSubscriptions never throws on a missing or corrupt file', () => {
    const fx = makeFixture();
    try {
      assert.deepEqual(getSubscriptions(undefined, fx.dir), []);
      writeFileSync(join(fx.dir, 'push-subscriptions.json'), 'not json', 'utf8');
      assert.deepEqual(getSubscriptions(undefined, fx.dir), []);
    } finally {
      fx.cleanup();
    }
  });
});

describe('VAPID key vending', () => {
  it('generates once and is stable on a second call', () => {
    const fx = makeFixture();
    try {
      const first = getOrCreateVapidPublicKey(fx.dir);
      const second = getOrCreateVapidPublicKey(fx.dir);
      assert.equal(first, second);
      // Uncompressed P-256 point: 65 bytes, base64url-encoded (no padding).
      const raw = Buffer.from(first, 'base64url');
      assert.equal(raw.length, 65);
      assert.equal(raw[0], 0x04);
    } finally {
      fx.cleanup();
    }
  });

  it('returns the same key an externally pre-written vapid.json already contains', () => {
    const fx = makeFixture();
    try {
      const preExisting = {
        publicKey: 'BJ-example-pre-existing-public-key-value-not-regenerated-000000',
        privateKey: 'placeholder-private-key-value',
        subject: 'mailto:pre-existing@example.com',
      };
      writeFileSync(join(fx.dir, 'vapid.json'), JSON.stringify(preExisting), 'utf8');
      const key = getOrCreateVapidPublicKey(fx.dir);
      assert.equal(key, preExisting.publicKey);
      // The file must not have been rewritten/regenerated.
      const onDisk = JSON.parse(readFileSync(join(fx.dir, 'vapid.json'), 'utf8'));
      assert.deepEqual(onDisk, preExisting);
    } finally {
      fx.cleanup();
    }
  });
});
