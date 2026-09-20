/**
 * Pairing + session identity (AI-201 WP-B, §6).
 *
 * One-time pairing-code flow: the bot (or scripts/mint_pairing.mjs for
 * dev/emergency) writes `~/.pa/voice-inbox/pairing-codes.json`; the app is
 * only ever a reader/consumer of that file — the bot is its single writer of
 * new codes. An exchange hashes the presented code, consumes the matching
 * file entry (removing it from the file AND recording its sha256 in the
 * ledger's `pairing_codes` table, so a replayed code is rejected even if the
 * file write lost the race), creates the tenant row on first exchange, and
 * mints a bearer session whose sha256 is the identity.ts-hash-at-rest rule.
 *
 * CANONICAL pairing-codes.json shape (written by mint_pairing.mjs; the bot's
 * /pair handler must write the same — the spec leaves the file shape
 * unpinned, so this constant is the pin WP-D copies):
 *
 *   [ { "code": "ABCD2345",              // raw 8-char code, unambiguous charset
 *       "telegram_user_id": 123456789,
 *       "telegram_chat_id": -1001234567890,
 *       "first_name": "…",               // nullable
 *       "created_at": "<iso-8601 Z>",
 *       "expires_at": "<iso-8601 Z>" } ] // bare JSON array of pending codes
 */

import Database from 'better-sqlite3';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { TenantRow } from './ledger.js';

export const PAIRING_CODE_LENGTH = 8;
/** Unambiguous charset — no 0/O/1/I/L (bot /pair must mint from the same set). */
export const PAIRING_CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 8-char pairing code from the unambiguous charset. */
export function mintPairingCode(random: (bytes: number) => Buffer = (n) => randomBytes(n)): string {
  let out = '';
  while (out.length < PAIRING_CODE_LENGTH) {
    const buf = random(4);
    for (const byte of buf) {
      if (out.length >= PAIRING_CODE_LENGTH) break;
      // Rejection-sample above 248 so 256 % 31 skew cannot bias the charset.
      if (byte < 248) out += PAIRING_CODE_CHARSET[byte % PAIRING_CODE_CHARSET.length];
    }
  }
  return out;
}

/** Bearer session token: 32 random bytes, base64url (§6). Only its sha256 is stored. */
export function mintSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

// --- pairing-codes.json -------------------------------------------------------

export interface PairingFileEntry {
  code: string;
  telegram_user_id: number;
  telegram_chat_id: number;
  first_name: string | null;
  created_at: string;
  expires_at: string;
}

export function readPairingFile(path: string): PairingFileEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e !== null && typeof e === 'object') as PairingFileEntry[];
  } catch {
    return []; // torn/corrupt file behaves like "no pending codes" — fail to absent
  }
}

function writePairingFile(path: string, entries: PairingFileEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

// --- Pairing exchange ----------------------------------------------------------

export type ExchangeErrorCode = 'invalid-code' | 'expired-code' | 'used-code';

export type ExchangeResult =
  | { ok: true; tenantId: string; token: string }
  | { ok: false; error: ExchangeErrorCode };

export interface ExchangeOptions {
  pairingCodesPath: string;
  sessionTtlHours: number;
  now?: () => Date;
}

/**
 * Consume a pairing code: single-use (ledger row + file-entry removal),
 * TTL-checked, hashed at rest. Tenant row is created on first exchange
 * (§6: "creates tenant row on first exchange"); a later exchange for the
 * same user updates the chat id and keeps the existing display name.
 */
export function exchangePairingCode(
  db: Database.Database,
  rawCode: unknown,
  opts: ExchangeOptions
): ExchangeResult {
  const now = opts.now ?? (() => new Date());
  const nowIso = now().toISOString();
  if (typeof rawCode !== 'string') return { ok: false, error: 'invalid-code' };
  const code = rawCode.trim().toUpperCase();
  if (code.length !== PAIRING_CODE_LENGTH) return { ok: false, error: 'invalid-code' };
  const codeHash = sha256Hex(code);

  // Replay guard first: a consumed code is already in the ledger even if the
  // file still carries the entry (torn consume), so replay always rejects.
  const consumed = db
    .prepare('SELECT code_hash FROM pairing_codes WHERE code_hash = ?')
    .get(codeHash);
  if (consumed) return { ok: false, error: 'used-code' };

  const entries = readPairingFile(opts.pairingCodesPath);
  const idx = entries.findIndex((e) => {
    if (typeof e.code !== 'string') return false;
    try {
      return timingSafeEqual(Buffer.from(sha256Hex(e.code)), Buffer.from(codeHash));
    } catch {
      return false;
    }
  });
  if (idx === -1) return { ok: false, error: 'invalid-code' };

  const entry = entries[idx];
  const expiresAt = typeof entry.expires_at === 'string' ? entry.expires_at : '';
  let expired = true;
  const parsedExpiry = Date.parse(expiresAt);
  if (!Number.isNaN(parsedExpiry)) {
    expired = parsedExpiry <= now().getTime();
  }
  if (expired) return { ok: false, error: 'expired-code' };

  // Single-use consume: the hashed row is the durable consume record.
  db.prepare(
    `INSERT INTO pairing_codes
       (code_hash, telegram_user_id, telegram_chat_id, first_name, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    codeHash,
    entry.telegram_user_id,
    entry.telegram_chat_id,
    entry.first_name ?? null,
    typeof entry.created_at === 'string' ? entry.created_at : nowIso,
    expiresAt,
    nowIso
  );

  // Tenant row created on first exchange; later exchanges refresh the chat id
  // but keep the operator's existing display name (COALESCE semantics).
  const tenantId = `t-${entry.telegram_user_id}`;
  db.prepare(
    `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       telegram_chat_id = excluded.telegram_chat_id,
       display_name = COALESCE(display_name, excluded.display_name)`
  ).run(tenantId, entry.telegram_user_id, entry.telegram_chat_id, entry.first_name ?? null, nowIso);

  removePairingEntry(opts.pairingCodesPath, codeHash);
  // One token minted once: the response carries it, the ledger stores only
  // its hash — they cannot diverge (the exact-wire-it-once rule).
  const { token } = createSession(db, tenantId, opts.sessionTtlHours, now);
  return { ok: true, tenantId, token };
}

function removePairingEntry(path: string, codeHash: string): void {
  const entries = readPairingFile(path);
  const remaining = entries.filter((e) => {
    try {
      return sha256Hex(String(e.code)) !== codeHash;
    } catch {
      return true; // unparseable entry: keep it rather than silently drop data
    }
  });
  if (remaining.length === entries.length) return;
  writePairingFile(path, remaining);
}

// --- Sessions -------------------------------------------------------------------

export interface SessionRow {
  token_hash: string;
  tenant_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
}

/**
 * Mint + persist a session (only the sha256 of the token is stored) and
 * return the token + row. `existingToken` lets the pairing exchange mint the
 * operator-facing token ONCE and store its hash — the response token and the
 * stored hash can never diverge. The raw token never appears in any stored
 * value — callers keep it in the exchange response only.
 */
export function createSession(
  db: Database.Database,
  tenantId: string,
  sessionTtlHours: number,
  now: () => Date = () => new Date(),
  existingToken?: string
): { token: string; row: SessionRow } {
  const token = existingToken ?? mintSessionToken();
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + sessionTtlHours * 3_600_000);
  const row: SessionRow = {
    token_hash: sha256Hex(token),
    tenant_id: tenantId,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    last_seen_at: createdAt.toISOString(),
  };
  db.prepare(
    `INSERT INTO sessions (token_hash, tenant_id, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(row.token_hash, row.tenant_id, row.created_at, row.expires_at, row.last_seen_at);
  return { token, row };
}

/**
 * Bearer-token authentication: hash the presented token, look up the session,
 * require an unexpired one, and touch `last_seen_at`. Returns the session's
 * tenant row, or undefined for anything malformed/expired/unknown — the
 * server maps undefined to the spec's exact 401 body.
 */
export function authenticateSession(
  db: Database.Database,
  authHeader: string | undefined,
  now: () => Date = () => new Date()
): TenantRow | undefined {
  if (typeof authHeader !== 'string' || authHeader.length === 0) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return undefined;
  const tokenHash = sha256Hex(match[1].trim());
  const row = db
    .prepare('SELECT * FROM sessions WHERE token_hash = ?')
    .get(tokenHash) as SessionRow | undefined;
  if (!row) return undefined;
  if (new Date(row.expires_at).getTime() <= now().getTime()) return undefined;
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
    .run(now().toISOString(), tokenHash);
  return db.prepare('SELECT * FROM tenants WHERE tenant_id = ?').get(row.tenant_id) as
    | TenantRow
    | undefined;
}
