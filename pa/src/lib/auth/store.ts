/**
 * The auth broker's own store — `~/.pa/auth/` (auth broker Phase A, 2026-09-10
 * build spec §3.3, decision D2). Deliberately independent of the voice-inbox
 * ledger: everything here is broker-private, short-lived handoff state (a
 * pending oauth exchange's state nonce and PKCE verifier, a standing
 * conversation's id, delivered-once bookkeeping). `pa` (this file) and the
 * voice-inbox server each read/write this on-disk JSON shape directly — no
 * shared code between the two packages, just a frozen file format, exactly
 * as `~/.pa/worker-pids/` and other cross-process JSON stores already work
 * in this repo.
 *
 * Every write is atomic: `<file>.tmp` written with mode 0600, then
 * `renameSync` into place — rename preserves the tmp file's mode, so the
 * final file is 0600 too. On Windows, `mode` only toggles the read-only bit
 * (there is no POSIX permission bit to set); that limitation is stated
 * honestly here rather than hidden.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { paHome } from '../../paths.js';
import type { AuthShape } from './shapes.js';

export function authDir(): string {
  return join(paHome(), 'auth');
}

export function requestsDir(): string {
  return join(authDir(), 'requests');
}

export function standingPath(): string {
  return join(authDir(), 'standing.json');
}

function requestPath(requestId: string): string {
  return join(requestsDir(), `${requestId}.json`);
}

export type AuthRequestStatus =
  | 'pending'
  | 'exchanging'
  | 'answered'
  | 'delivered'
  | 'expired'
  | 'cancelled';

/** The §3.3 broker row. Keys are always present (`null` when not applicable). */
export interface AuthRequestRow {
  request_id: string;
  task_id: string;
  tenant_id: string;
  shape: AuthShape;
  provider: string | null;
  kind: string;
  status: AuthRequestStatus;
  created_at: string;
  expires_at: string;
  state: string | null;
  code_verifier: string | null;
  redirect_uri: string | null;
  auth_id: string | null;
  answer_pointer: string | null;
  delivered_at: string | null;
}

/** The §3.3 key order, pinned by a test. Never spreads an unknown key. */
function orderRow(row: AuthRequestRow): AuthRequestRow {
  return {
    request_id: row.request_id,
    task_id: row.task_id,
    tenant_id: row.tenant_id,
    shape: row.shape,
    provider: row.provider,
    kind: row.kind,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    state: row.state,
    code_verifier: row.code_verifier,
    redirect_uri: row.redirect_uri,
    auth_id: row.auth_id,
    answer_pointer: row.answer_pointer,
    delivered_at: row.delivered_at,
  };
}

/** Shared tmp+rename, mode 0600, sync — reused by profiles.ts (same package). */
export function atomicWriteSync(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

export function writeRow(row: AuthRequestRow): void {
  mkdirSync(requestsDir(), { recursive: true });
  atomicWriteSync(requestPath(row.request_id), JSON.stringify(orderRow(row)));
}

/** Missing file or torn JSON both return `undefined` — never throws. */
export function readRow(requestId: string): AuthRequestRow | undefined {
  const path = requestPath(requestId);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AuthRequestRow;
  } catch {
    return undefined;
  }
}

export function listRows(): AuthRequestRow[] {
  if (!existsSync(requestsDir())) return [];
  const rows: AuthRequestRow[] = [];
  for (const name of readdirSync(requestsDir())) {
    if (!name.endsWith('.json')) continue;
    const row = readRow(name.slice(0, -'.json'.length));
    if (row) rows.push(row);
  }
  return rows;
}

export function deleteRow(requestId: string): void {
  const path = requestPath(requestId);
  if (existsSync(path)) unlinkSync(path);
}

/** `{ "<tenant_id>": { "conversation_id": "vi-<12hex>" } }` (§3.3). */
export type StandingStore = Record<string, { conversation_id: string }>;

export function readStanding(): StandingStore {
  const path = standingPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as StandingStore;
    }
    return {};
  } catch {
    return {};
  }
}

export function writeStanding(store: StandingStore): void {
  mkdirSync(authDir(), { recursive: true });
  atomicWriteSync(standingPath(), JSON.stringify(store));
}

/** Stamp `delivered_at`; every other key stays byte-identical. Returns
 * `undefined` when the row does not exist (never throws). */
export function markDelivered(requestId: string, nowIso: string): AuthRequestRow | undefined {
  const row = readRow(requestId);
  if (!row) return undefined;
  const updated: AuthRequestRow = { ...row, delivered_at: nowIso };
  writeRow(updated);
  return updated;
}
