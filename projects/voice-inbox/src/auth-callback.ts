/**
 * The generalized auth callback endpoint (AI-220 auth broker Phase A, §3.5):
 * `GET /api/v1/auth/callback` — the un-authenticated landing page a provider
 * redirects the phone back to after an authorize step. Looks up the pending
 * broker row (`~/.pa/auth/requests/<id>.json`, §3.3, auth-providers.ts) by
 * the opaque `state` value carried on the redirect, enforces single-use +
 * expiry, runs the provider's configured `exchange` (never a second Google
 * exchanger — C12), stores the resulting token file, and resumes the worker
 * (`answerFn`, wired to `answerAndResume` in routes.ts) so a real worker
 * waiting on the request continues instead of hitting the AI-221 silent-
 * answer bug.
 *
 * Every external effect — reading/writing the broker row, running the
 * provider's exchange, the generic HTTP token POST, writing the token file,
 * and answering the ledger — is an injected dependency, so this module is
 * fully unit-testable without touching the filesystem, a real provider, or a
 * real ledger. `spawnFn` is a HIGH-LEVEL "run this provider script and hand
 * back its parsed last JSON line" abstraction (not raw `child_process.spawn`)
 * — the production implementation (`makeScriptRunner`, below) is the only
 * place that needs the repo root, which routes.ts already has in its
 * `createRouter` closure (B-E8) and folds in when building the real deps.
 *
 * Google's `state`: `pa/scripts/start_google_telegram_reauth.py` now surfaces
 * the Flow's own OAuth `state` in its JSON stdout (`"state": ...`, alongside
 * `auth_url`/`auth_id`), and `oauth-mint.ts`'s `mintOauthAuthUrl` copies that
 * value into the broker row it writes/updates — never a second, independently
 * generated state. That is what lets this endpoint's "read the broker row by
 * state" lookup match a real Google redirect (ruling closing the earlier
 * §3.4/§3.5 gap, 2026-09-10).
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { paHome } from './config.js';
import { getProviderConfig, renderArgv, type AuthRequestRow } from './auth-providers.js';

export const AUTH_CALLBACK_PATH = '/api/v1/auth/callback';

export const AUTH_PAGE_OK =
  '<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Authorized</title><body style="font:16px system-ui;padding:2rem">Authorized. Go back to the app — the task continues automatically.</body>';

export const AUTH_PAGE_FAIL =
  '<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Authorization failed</title><body style="font:16px system-ui;padding:2rem">That authorization link is no longer valid. Ask again from the app.</body>';

const RELAY_RESERVED_EXACT = new Set(['/healthz', '/work', '/resp']);

/** Mirrors `relay/worker.js:287-301`'s exact matching — the callback path
 * must never collide with the edge relay's own reserved surface. */
export function collidesWithRelayReserved(path: string): boolean {
  return RELAY_RESERVED_EXACT.has(path) || path.startsWith('/body/');
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** Run one provider script (repo-relative path + rendered argv) and hand
 * back its parsed last JSON stdout line. `ok` is false on a timeout, a
 * non-JSON tail line, or a parsed `{"error": "..."}` line. */
export type ScriptRunner = (
  script: string,
  argv: string[]
) => Promise<{ ok: boolean; parsed: Record<string, unknown> | null }>;

export type WriteTokenFile = (path: string, contents: string, opts: { mode: number }) => void;

export interface AuthCallbackDeps {
  readRow: (state: string) => AuthRequestRow | undefined;
  writeRow: (row: AuthRequestRow) => void;
  spawnFn: ScriptRunner;
  fetchFn: typeof fetch;
  writeTokenFile: WriteTokenFile;
  answerFn: (tenantId: string, taskId: string, requestId: string, pointer: string) => Promise<void>;
  now: () => Date;
}

export interface AuthCallbackArgs {
  state: string | null;
  code: string | null;
  error: string | null;
}

export interface AuthCallbackResult {
  status: number;
  html: string;
}

function fail(): AuthCallbackResult {
  return { status: 400, html: AUTH_PAGE_FAIL };
}

/**
 * Default `writeTokenFile`: tmp + rename, mode 0600. Node's `mode` on
 * Windows only toggles the read-only bit; on win32 this also best-effort
 * runs `icacls` to restrict the ACL, through an injectable `execFn` so the
 * (frequent, expected) failure to find `icacls` in a test sandbox never
 * throws — the absence of that hardening is documented, not hidden (B-E3).
 */
export function defaultWriteTokenFile(
  path: string,
  contents: string,
  opts: { mode: number },
  execFn: (command: string) => void = (command: string) => {
    execSync(command, { windowsHide: true, stdio: 'ignore' });
  }
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents, { encoding: 'utf8', mode: opts.mode });
  renameSync(tmp, path);
  if (process.platform === 'win32') {
    try {
      execFn(`icacls "${path}" /inheritance:r /grant:r "%USERNAME%":F`);
    } catch {
      // Best-effort only — swallow every failure (B-E3).
    }
  }
}

/** Production `ScriptRunner`: spawns `<repoRoot>/<script>` with the rendered
 * argv and parses its last non-empty stdout line as JSON — the same idiom
 * `oauth-mint.ts`'s local `runMint`/`parseLastJsonLine` pair already uses,
 * duplicated here because those helpers are not exported from that module. */
export function makeScriptRunner(repoRoot: string): ScriptRunner {
  return (script, argv) =>
    new Promise((resolvePromise) => {
      const pythonCmd = process.env.PA_PYTHON?.trim() || 'python';
      const child = spawn(pythonCmd, [join(repoRoot, script), ...argv], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill();
        resolvePromise({ ok: false, parsed: null });
      }, 60_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolvePromise({ ok: false, parsed: null });
      });
      child.on('close', () => {
        clearTimeout(timer);
        const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
        if (lines.length === 0) {
          resolvePromise({ ok: false, parsed: null });
          return;
        }
        try {
          const parsed = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
          resolvePromise({ ok: typeof parsed['error'] !== 'string', parsed });
        } catch {
          resolvePromise({ ok: false, parsed: null });
        }
      });
    });
}

// ---------------------------------------------------------------------------
// The handler (§3.5 "Ordered behaviour", steps 1-7)
// ---------------------------------------------------------------------------

export async function handleAuthCallback(
  args: AuthCallbackArgs,
  deps: AuthCallbackDeps
): Promise<AuthCallbackResult> {
  // Step 1: provider error — mark the row cancelled when one is findable,
  // but always answer with 200 + the failure page (not 400: the phone did
  // reach us, the provider just declined).
  if (args.error) {
    if (args.state) {
      const row = deps.readRow(args.state);
      if (row && row.status === 'pending') {
        deps.writeRow({ ...row, status: 'cancelled' });
      }
    }
    return { status: 200, html: AUTH_PAGE_FAIL };
  }

  // Step 2: no broker row matches state — 400, nothing else happens, no
  // network call is made.
  if (!args.state) return fail();
  const row = deps.readRow(args.state);
  if (!row) return fail();

  // Step 3: expired.
  if (Date.parse(row.expires_at) < deps.now().getTime()) {
    deps.writeRow({ ...row, status: 'expired' });
    return fail();
  }

  // Step 4: single use.
  if (row.status !== 'pending') return fail();

  // Defensive: a row naming an unconfigured provider can only arise from a
  // corrupted/torn file (creation already validates against OAUTH_PROVIDERS)
  // — fail closed rather than dereference an undefined config.
  const config = getProviderConfig(row.provider);
  if (!config) return fail();

  // Step 5: write `exchanging` before the exchange.
  deps.writeRow({ ...row, status: 'exchanging' });

  // Step 6: run the provider's exchange.
  let tokens: Record<string, unknown>;
  if (config.exchange.kind === 'script') {
    const argv = renderArgv(config.exchange.argv, {
      code: args.code ?? '',
      state: args.state,
      chat_id: '',
      redirect_uri: '',
    });
    const { ok, parsed } = await deps.spawnFn(config.exchange.script, argv);
    if (!ok || !parsed) {
      deps.writeRow({ ...row, status: 'cancelled' });
      return fail();
    }
    tokens = parsed;
  } else {
    const clientId = process.env[config.exchange.client_id_key] ?? '';
    const clientSecret = config.exchange.client_secret_key
      ? process.env[config.exchange.client_secret_key]
      : undefined;
    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', args.code ?? '');
    body.set('redirect_uri', row.redirect_uri ?? '');
    body.set('client_id', clientId);
    if (clientSecret) body.set('client_secret', clientSecret);
    if (config.pkce && row.code_verifier) body.set('code_verifier', row.code_verifier);

    let resp: Response;
    try {
      resp = await deps.fetchFn(config.exchange.token_url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch {
      deps.writeRow({ ...row, status: 'cancelled' });
      return fail();
    }
    if (!resp.ok) {
      deps.writeRow({ ...row, status: 'cancelled' });
      return fail();
    }
    try {
      tokens = (await resp.json()) as Record<string, unknown>;
    } catch {
      deps.writeRow({ ...row, status: 'cancelled' });
      return fail();
    }
  }

  // Step 7: success — mark the row answered, and resume the worker with a
  // pointer to a non-secret marker file (never the tokens themselves — the
  // ledger/route-queue must never see them, C7).
  //
  // The token file write is exchange-kind-specific (fix, deep-recheck
  // 2026-09-10): for a `script` exchange (Google), the spawned script is the
  // ONLY writer of `config.token_file` — it already wrote the real
  // credentials (with its own refresh-token-preserving logic, C12) before
  // returning. `tokens` here is that script's STATUS-ONLY stdout line
  // (`{"status":"success","expiry":...,"missing_scopes":...,...}`), not the
  // credentials — writing it over `config.token_file` a second time replaced
  // the just-saved refresh token with an unrelated status object on every
  // real Google callback, breaking every Gmail/Drive/Calendar consumer that
  // reads that file (the exact failure class C12 exists to prevent, and the
  // P1 live-proof's "the refresh token surviving is the load-bearing check").
  // Only the generic `http` arm has no other writer, so it is the only arm
  // that writes the token file itself here.
  if (config.exchange.kind === 'http') {
    const tokenPath = join(paHome(), config.token_file);
    deps.writeTokenFile(tokenPath, JSON.stringify(tokens), { mode: 0o600 });
  }

  const markerPath = join(paHome(), 'auth', 'markers', `${row.request_id}.txt`);
  deps.writeTokenFile(
    markerPath,
    `${config.name} authorization completed at ${deps.now().toISOString()}.\n`,
    { mode: 0o600 }
  );

  deps.writeRow({ ...row, status: 'answered', answer_pointer: markerPath });
  await deps.answerFn(row.tenant_id, row.task_id, row.request_id, markerPath);

  return { status: 200, html: AUTH_PAGE_OK };
}
