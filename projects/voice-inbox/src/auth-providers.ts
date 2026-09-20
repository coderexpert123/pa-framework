/**
 * Auth provider registry (AI-220 auth broker Phase A, §3.4/C12): describes,
 * for each provider name the generalized `oauth` widget can carry, how to
 * produce an authorize URL and how to exchange a returned code for tokens.
 *
 * Google is the only Phase-A registration and both its `authorize` and
 * `exchange` reuse the existing `pa/scripts/*_google_telegram_reauth.py`
 * pair rather than forking a second exchanger (C12) — Phase B adds providers
 * as config rows here, never a second dispatcher.
 *
 * This module also owns the small `~/.pa/auth/requests/<id>.json` broker-row
 * reader/writer (§3.3) shared by the callback (auth-callback.ts) and the
 * `http`-kind authorize arm (oauth-mint.ts). It is a local, dependency-free
 * re-implementation of the shape `pa/src/lib/auth/store.ts` (a separate
 * package, WP-D) also writes — the same "no compiled-dist import across
 * packages" convention `config.ts`'s `paHome()` doc-comment already states
 * for this package.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paHome } from './config.js';

// ---------------------------------------------------------------------------
// Provider config (§3.4)
// ---------------------------------------------------------------------------

export interface AuthProviderConfig {
  /** Must equal the key it is registered under, and be a member of OAUTH_PROVIDERS. */
  name: string;
  /** How the authorize URL is produced. */
  authorize:
    | { kind: 'script'; script: string; argv: string[] }
    | { kind: 'http'; authorize_url: string; scopes: string[]; client_id_key: string };
  /** How the code is exchanged for tokens. */
  exchange:
    | { kind: 'script'; script: string; argv: string[] }
    | { kind: 'http'; token_url: string; client_id_key: string; client_secret_key?: string };
  /** PKCE S256 when true. Ignored for the script kinds (the script owns it). */
  pkce: boolean;
  /** Absolute-ish token destination, resolved under paHome() at runtime. */
  token_file: string;
}

/** The single Phase-A registration (§3.4, exact). */
export const AUTH_PROVIDER_CONFIGS: Readonly<Record<string, AuthProviderConfig>> = {
  google: {
    name: 'google',
    authorize: {
      kind: 'script',
      script: 'pa/scripts/start_google_telegram_reauth.py',
      argv: ['--no-send', '--chat-id', '{chat_id}', '--redirect-uri', '{redirect_uri}'],
    },
    exchange: {
      kind: 'script',
      script: 'pa/scripts/finish_google_telegram_reauth.py',
      argv: ['--code', '{code}', '--state', '{state}'],
    },
    pkce: true,
    token_file: 'google-token.json',
  },
};

export function getProviderConfig(name: string): AuthProviderConfig | undefined {
  return AUTH_PROVIDER_CONFIGS[name];
}

const KNOWN_PLACEHOLDERS = new Set(['chat_id', 'redirect_uri', 'code', 'state']);

/**
 * Substitute the four frozen placeholders (`{chat_id}`, `{redirect_uri}`,
 * `{code}`, `{state}`) in an argv template. Any other `{...}` token throws —
 * a provider config typo must never silently pass an unrendered literal to a
 * spawned process.
 */
export function renderArgv(argv: string[], vars: Record<string, string>): string[] {
  return argv.map((token) =>
    token.replace(/\{([^{}]*)\}/g, (whole, name: string) => {
      if (!KNOWN_PLACEHOLDERS.has(name)) {
        throw new Error(`unknown placeholder in provider argv: ${whole}`);
      }
      return vars[name] ?? '';
    })
  );
}

/** RFC 7636 S256 PKCE pair — a 32-byte random verifier and its SHA-256
 * base64url challenge. Used only by the (Phase-A-dead) `http` authorize arm. */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// The broker store — `~/.pa/auth/requests/<request_id>.json` (§3.3)
// ---------------------------------------------------------------------------

export type AuthRequestStatus =
  | 'pending'
  | 'exchanging'
  | 'answered'
  | 'delivered'
  | 'expired'
  | 'cancelled';

/** Key order pinned by §3.3 — `writeAuthRequestRow` always emits this order. */
export interface AuthRequestRow {
  request_id: string;
  task_id: string;
  tenant_id: string;
  shape: string;
  provider: string;
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

function authRequestsDir(): string {
  return join(paHome(), 'auth', 'requests');
}

function authRequestPath(requestId: string): string {
  return join(authRequestsDir(), `${requestId}.json`);
}

/** Read one broker row by request_id — undefined on missing or torn file. */
export function readAuthRequestRow(requestId: string): AuthRequestRow | undefined {
  try {
    return JSON.parse(readFileSync(authRequestPath(requestId), 'utf8')) as AuthRequestRow;
  } catch {
    return undefined;
  }
}

/**
 * Find the one broker row whose `state` field equals the given value (the
 * callback's only correlating value from the redirect URL). Scans the small
 * requests directory rather than indexing by state — Phase A never has more
 * than a handful of concurrently pending auth requests. Undefined on a
 * missing directory or no match; a torn row file is skipped, never thrown.
 */
export function readAuthRequestRowByState(state: string): AuthRequestRow | undefined {
  let names: string[];
  try {
    names = readdirSync(authRequestsDir());
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const row = JSON.parse(readFileSync(join(authRequestsDir(), name), 'utf8')) as AuthRequestRow;
      if (row.state === state) return row;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Write one broker row, key order pinned by §3.3, atomically (tmp + rename), mode 0600. */
export function writeAuthRequestRow(row: AuthRequestRow): void {
  const dir = authRequestsDir();
  mkdirSync(dir, { recursive: true });
  const ordered: AuthRequestRow = {
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
  const target = authRequestPath(row.request_id);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(ordered), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, target);
}
