/**
 * Identity tests (AI-201 WP-B, §12 row B): pairing exchange happy/expired/
 * replayed/unused-user paths, hash-at-rest (codes and session tokens are
 * stored only as sha256), and bearer session verification incl. expiry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authenticateSession,
  createSession,
  exchangePairingCode,
  mintPairingCode,
  PAIRING_CODE_CHARSET,
  PAIRING_CODE_LENGTH,
  readPairingFile,
  sha256Hex,
} from '../identity.js';
import { openLedger, upsertTenant, type TenantRow } from '../ledger.js';

interface Fixture {
  db: ReturnType<typeof openLedger>;
  dir: string;
  pairingPath: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-identity-'));
  const db = openLedger(join(dir, 'ledger.sqlite'));
  const pairingPath = join(dir, 'pairing-codes.json');
  return {
    db,
    dir,
    pairingPath,
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

function writePairingEntry(
  pairingPath: string,
  code: string,
  telegramUserId: number,
  opts: { expiresInMinutes?: number; firstName?: string; chatId?: number } = {}
): void {
  const now = Date.now();
  const entry = {
    code,
    telegram_user_id: telegramUserId,
    telegram_chat_id: opts.chatId ?? -1001234567890,
    first_name: opts.firstName ?? 'Operator',
    created_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + (opts.expiresInMinutes ?? 10) * 60_000).toISOString(),
  };
  writeFileSync(pairingPath, JSON.stringify([entry]), 'utf8');
}

describe('mintPairingCode', () => {
  it('mints 8-char codes from the unambiguous charset', () => {
    for (let i = 0; i < 50; i++) {
      const code = mintPairingCode();
      assert.equal(code.length, PAIRING_CODE_LENGTH);
      for (const ch of code) {
        assert.ok(PAIRING_CODE_CHARSET.includes(ch), `unexpected char ${ch}`);
      }
    }
  });

  it('excludes ambiguous characters (0/O/1/I/L)', () => {
    for (let i = 0; i < 50; i++) {
      const code = mintPairingCode();
      assert.doesNotMatch(code, /[0O1IL]/);
    }
  });
});

describe('exchangePairingCode', () => {
  it('happy path: consumes the code, creates the tenant, returns a session token once', () => {
    const fx = makeFixture();
    try {
      writePairingEntry(fx.pairingPath, 'ABCD2345', 424242);
      const result = exchangePairingCode(fx.db, 'abcd2345', {
        pairingCodesPath: fx.pairingPath,
        sessionTtlHours: 168,
      });
      assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`);
      assert.equal(result.tenantId, 't-424242');
      assert.match(result.token, /^[A-Za-z0-9_-]{40,}$/); // 32 bytes base64url

      // Tenant created on first exchange (§6).
      const tenant = fx.db.prepare('SELECT * FROM tenants WHERE tenant_id = ?').get('t-424242') as
        | TenantRow
        | undefined;
      assert.ok(tenant);
      assert.equal(tenant.telegram_user_id, 424242);
      assert.equal(tenant.telegram_chat_id, -1001234567890);
      assert.equal(tenant.display_name, 'Operator');

      // The file entry is consumed (app removes it; bot stays sole writer of new codes).
      assert.deepEqual(readPairingFile(fx.pairingPath), []);
    } finally {
      fx.cleanup();
    }
  });

  it('unused user: a code for a brand-new telegram user still creates the tenant row', () => {
    const fx = makeFixture();
    try {
      writePairingEntry(fx.pairingPath, 'PQR56789', 999888, { chatId: -100999 });
      const before = fx.db.prepare('SELECT COUNT(*) AS n FROM tenants').get() as { n: number };
      const result = exchangePairingCode(fx.db, 'PQR56789', {
        pairingCodesPath: fx.pairingPath,
        sessionTtlHours: 168,
      });
      assert.ok(result.ok);
      assert.equal(result.tenantId, 't-999888');
      const after = fx.db.prepare('SELECT COUNT(*) AS n FROM tenants').get() as { n: number };
      assert.equal(after.n, before.n + 1);
    } finally {
      fx.cleanup();
    }
  });

  it('replayed code is rejected as used even if the file entry reappears', () => {
    const fx = makeFixture();
    try {
      writePairingEntry(fx.pairingPath, 'ABCD2345', 424242);
      const first = exchangePairingCode(fx.db, 'ABCD2345', {
        pairingCodesPath: fx.pairingPath,
        sessionTtlHours: 168,
      });
      assert.ok(first.ok);
      // Simulate the bot re-writing the same (already consumed) code.
      writePairingEntry(fx.pairingPath, 'ABCD2345', 424242);
      const second = exchangePairingCode(fx.db, 'ABCD2345', {
        pairingCodesPath: fx.pairingPath,
        sessionTtlHours: 168,
      });
      assert.deepEqual(second, { ok: false, error: 'used-code' });
    } finally {
      fx.cleanup();
    }
  });

  it('expired code is rejected and nothing is consumed', () => {
    const fx = makeFixture();
    try {
      writePairingEntry(fx.pairingPath, 'OLD23456', 424242, { expiresInMinutes: -1 });
      const result = exchangePairingCode(fx.db, 'OLD23456', {
        pairingCodesPath: fx.pairingPath,
        sessionTtlHours: 168,
      });
      assert.deepEqual(result, { ok: false, error: 'expired-code' });
      // Nothing consumed: entry stays, no tenant, no session.
      assert.equal(readPairingFile(fx.pairingPath).length, 1);
      const tenants = fx.db.prepare('SELECT COUNT(*) AS n FROM tenants').get() as { n: number };
      assert.equal(tenants.n, 0);
      const sessions = fx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
      assert.equal(sessions.n, 0);
    } finally {
      fx.cleanup();
    }
  });

  it('unknown and malformed codes are invalid, never thrown', () => {
    const fx = makeFixture();
    try {
      writePairingEntry(fx.pairingPath, 'ABCD2345', 424242);
      const opts = { pairingCodesPath: fx.pairingPath, sessionTtlHours: 168 };
      assert.deepEqual(exchangePairingCode(fx.db, 'ZZZZ9999', opts), { ok: false, error: 'invalid-code' });
      assert.deepEqual(exchangePairingCode(fx.db, 'SHORT', opts), { ok: false, error: 'invalid-code' });
      assert.deepEqual(exchangePairingCode(fx.db, undefined, opts), { ok: false, error: 'invalid-code' });
      assert.deepEqual(exchangePairingCode(fx.db, 12345, opts), { ok: false, error: 'invalid-code' });
    } finally {
      fx.cleanup();
    }
  });

  it('hashes at rest: the ledger stores only sha256 of the code and of the token', () => {
    const fx = makeFixture();
    try {
      writePairingEntry(fx.pairingPath, 'HASH1234', 555000);
      const result = exchangePairingCode(fx.db, 'HASH1234', {
        pairingCodesPath: fx.pairingPath,
        sessionTtlHours: 168,
      });
      assert.ok(result.ok);
      const consumed = fx.db
        .prepare('SELECT code_hash, consumed_at FROM pairing_codes')
        .get() as { code_hash: string; consumed_at: string };
      assert.equal(consumed.code_hash, sha256Hex('HASH1234'));
      const session = fx.db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
      assert.equal(session.token_hash, sha256Hex(result.token));
    } finally {
      fx.cleanup();
    }
  });

  it('a code whose file entry vanished after consume is rejected via the ledger row', () => {
    const fx = makeFixture();
    try {
      writePairingEntry(fx.pairingPath, 'ABCD2345', 424242);
      const first = exchangePairingCode(fx.db, 'ABCD2345', {
        pairingCodesPath: fx.pairingPath,
        sessionTtlHours: 168,
      });
      assert.ok(first.ok);
      // File entry removed by the consume; replay finds nothing in the file.
      const second = exchangePairingCode(fx.db, 'ABCD2345', {
        pairingCodesPath: fx.pairingPath,
        sessionTtlHours: 168,
      });
      assert.deepEqual(second, { ok: false, error: 'used-code' });
    } finally {
      fx.cleanup();
    }
  });
});

describe('authenticateSession', () => {
  it('accepts a valid Bearer token and returns the tenant', () => {
    const fx = makeFixture();
    try {
      upsertTenant(fx.db, { telegramUserId: 424242, telegramChatId: -1001234567890, displayName: 'Op' });
      const { token } = createSession(fx.db, 't-424242', 168);
      const tenant = authenticateSession(fx.db, `Bearer ${token}`);
      assert.ok(tenant);
      assert.equal(tenant.tenant_id, 't-424242');
    } finally {
      fx.cleanup();
    }
  });

  it('rejects missing, malformed, and unknown headers with undefined', () => {
    const fx = makeFixture();
    try {
      upsertTenant(fx.db, { telegramUserId: 1, telegramChatId: -1001 });
      createSession(fx.db, 't-1', 168);
      assert.equal(authenticateSession(fx.db, undefined), undefined);
      assert.equal(authenticateSession(fx.db, ''), undefined);
      assert.equal(authenticateSession(fx.db, 'Basic dXNlcjpwYXNz'), undefined);
      assert.equal(authenticateSession(fx.db, 'Bearer not-a-real-token'), undefined);
    } finally {
      fx.cleanup();
    }
  });

  it('rejects an expired session', () => {
    const fx = makeFixture();
    try {
      upsertTenant(fx.db, { telegramUserId: 2, telegramChatId: -1002 });
      // Negative TTL mints a session whose expires_at is already in the past.
      const { token } = createSession(fx.db, 't-2', -1);
      assert.equal(authenticateSession(fx.db, `Bearer ${token}`), undefined);
    } finally {
      fx.cleanup();
    }
  });

  it('touches last_seen_at on successful auth', () => {
    const fx = makeFixture();
    try {
      upsertTenant(fx.db, { telegramUserId: 3, telegramChatId: -1003 });
      const t0 = new Date('2026-09-05T10:00:00Z');
      const { token } = createSession(fx.db, 't-3', 168, () => t0);
      authenticateSession(fx.db, `Bearer ${token}`, () => new Date('2026-09-05T11:00:00Z'));
      const row = fx.db.prepare('SELECT last_seen_at FROM sessions').get() as { last_seen_at: string };
      assert.equal(row.last_seen_at, '2026-09-05T11:00:00.000Z');
    } finally {
      fx.cleanup();
    }
  });
});

describe('readPairingFile', () => {
  it('fails to absent: missing or corrupt file yields no pending codes', () => {
    const fx = makeFixture();
    try {
      assert.deepEqual(readPairingFile(join(fx.dir, 'missing.json')), []);
      writeFileSync(fx.pairingPath, '{not json', 'utf8');
      assert.deepEqual(readPairingFile(fx.pairingPath), []);
    } finally {
      fx.cleanup();
    }
  });

  it('reads back the canonical array shape', () => {
    const fx = makeFixture();
    try {
      writePairingEntry(fx.pairingPath, 'ABCD2345', 424242);
      const entries = readPairingFile(fx.pairingPath);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].code, 'ABCD2345');
      assert.equal(entries[0].telegram_user_id, 424242);
      assert.equal(typeof entries[0].expires_at, 'string');
    } finally {
      fx.cleanup();
    }
  });
});
