/**
 * OAuth widget backend (AI-201 WP-B, §4/§6): mint the Google auth_url for an
 * `oauth` input request and auto-answer the request when the minted session
 * resolves.
 *
 * §4's boundary: the model can never supply `auth_url` (it is not a key of
 * the oauth param set the validator accepts). The backend mints it AFTER the
 * request row exists: spawns `pa/scripts/start_google_telegram_reauth.py
 * --no-send --chat-id <tenant chat>` — the script's argparse also REQUIRES
 * `--redirect-uri` (the reference caller google_reauth_kick.py supplies it
 * from the GOOGLE_AUTH_REDIRECT_URI secret) — and parses the JSON stdout for
 * `auth_url`, then fills the row's params_json. Until minted, the card
 * renders "preparing Google link…" (WP-E).
 *
 * Resolution signal (§2 verified substrate): the pending session lives in
 * `~/.pa/google-telegram-auth.json`; the existing Telegram `/auth` completion
 * loop (finish_google_telegram_reauth.py) reuses UNCHANGED and removes the
 * matched `auth_id` from that array. Absence of the minted `auth_id` IS the
 * resolution signal, so the app polls that file and auto-answers the request
 * (§4: oauth has no user answer — "auto-answers when the minted session
 * resolves").
 */

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { paHome } from './config.js';
import {
  answerInputRequest,
  getTask,
  listInputRequests,
  type InputRequestRow,
  type TenantRow,
} from './ledger.js';
import {
  generatePkcePair,
  getProviderConfig,
  readAuthRequestRow,
  renderArgv,
  writeAuthRequestRow,
} from './auth-providers.js';

export interface OauthMintDeps {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  /** `~/.pa/secrets.env` override (tests). */
  secretsFilePath?: string;
  /** `~/.pa/google-telegram-auth.json` override (tests). */
  pendingStatePath?: string;
  /** Answers dir override (tests); defaults to `~/.pa/voice-inbox/answers`. */
  answersDir?: string;
  spawnFn?: typeof spawn;
  now?: () => Date;
  /** B-E10/C2: when supplied, `pollOauthResolutions` calls this instead of
   * `answerInputRequest` directly, so the resume steer also fires — wired by
   * routes.ts to `answerAndResume`. Falls back to the direct ledger answer
   * when omitted, preserving today's behaviour for other callers. */
  onAnswered?: (taskId: string, requestId: string, pointer: string) => Promise<void>;
}

export class OauthMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OauthMintError';
  }
}

/**
 * Read ONE key from `~/.pa/secrets.env` (KEY=VALUE lines, optional surrounding
 * quotes, `#` comments). Local single-key reader rather than pa/dist's
 * loadSecrets — same parsing contract, but this package's gates never need a
 * built pa/dist, and only the one needed key is ever read.
 */
export function readSecretKey(secretsFilePath: string, key: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(secretsFilePath, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

interface MintStdout {
  status?: unknown;
  auth_url?: unknown;
  auth_id?: unknown;
  error?: unknown;
  [k: string]: unknown;
}

/** Last non-empty stdout line, JSON (the reference callers parse the same way). */
function parseLastJsonLine(stdout: string): MintStdout | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  try {
    const parsed = JSON.parse(lines[lines.length - 1]) as unknown;
    if (parsed !== null && typeof parsed === 'object') return parsed as MintStdout;
    return null;
  } catch {
    return null;
  }
}

/** Env-overridable python resolution (`PA_PYTHON`), defaulting to `python` —
 * every pa worker shell has python on PATH, so the POSIX `python3` case is
 * not a gate here. */
function resolvePythonCommand(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PA_PYTHON?.trim();
  if (override) return override;
  return 'python';
}

function runMint(
  deps: OauthMintDeps,
  args: string[]
): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = (deps.spawnFn ?? spawn)(resolvePythonCommand(deps.env ?? process.env), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 60_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}${err.message}`, timedOut: false });
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut });
    });
  });
}

function paramsOf(request: InputRequestRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(request.params_json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fallthrough — torn params behave like "nothing minted yet"
  }
  return {};
}

function updateParams(
  db: Database.Database,
  request: InputRequestRow,
  params: Record<string, unknown>
): void {
  db.prepare('UPDATE input_requests SET params_json = ? WHERE request_id = ? AND tenant_id = ?')
    .run(JSON.stringify(params), request.request_id, request.tenant_id);
}

/**
 * Mint `auth_url` for a pending oauth request row and fill the row's
 * params_json (`auth_url` + `auth_id`). Idempotent: returns the existing
 * `auth_url` when already minted. Returns null (never throws) when minting
 * is impossible or failed — the card keeps rendering "preparing Google
 * link…" and the next serve retries.
 */
export async function mintOauthAuthUrl(
  db: Database.Database,
  ctx: { tenant: TenantRow; request: InputRequestRow },
  deps: OauthMintDeps
): Promise<string | null> {
  if (ctx.request.kind !== 'oauth') return null;
  const params = paramsOf(ctx.request);
  if (typeof params['auth_url'] === 'string' && params['auth_url']) {
    return params['auth_url'] as string;
  }
  const provider = typeof params['provider'] === 'string' ? params['provider'] : undefined;
  const config = provider ? getProviderConfig(provider) : undefined;
  if (!config) return null; // B-E9: unknown provider

  if (config.authorize.kind === 'script') {
    // Script arm — keeps today's behaviour exactly (spawn the start script,
    // parse the last JSON line, store auth_url + auth_id); only the argv
    // construction now goes through the provider config's renderArgv.
    const secretsFile = deps.secretsFilePath ?? join(paHome(), 'secrets.env');
    const redirectUri = readSecretKey(secretsFile, 'GOOGLE_AUTH_REDIRECT_URI');
    if (!redirectUri) return null; // cannot mint without the registered redirect URI

    const scriptPath = join(deps.repoRoot, config.authorize.script);
    const args = [
      scriptPath,
      ...renderArgv(config.authorize.argv, {
        chat_id: String(ctx.tenant.telegram_chat_id),
        redirect_uri: redirectUri,
      }),
    ];
    const result = await runMint(deps, args);
    if (result.timedOut) return null;
    const parsed = parseLastJsonLine(result.stdout);
    if (!parsed) return null;
    if (typeof parsed['error'] === 'string') return null;
    if (typeof parsed['auth_url'] !== 'string' || !parsed['auth_url']) return null;
    const authUrl = parsed['auth_url'];
    const authId = typeof parsed['auth_id'] === 'string' ? parsed['auth_id'] : null;
    // Closes the §3.4/§3.5 gap: the script keeps Google's OAuth `state`
    // internal to its own pending-session file and never exposed it until
    // this fix. Persist it into the broker row so the new
    // /api/v1/auth/callback endpoint (which correlates a redirect PURELY by
    // `state`) can actually find this request — without this, a real Google
    // redirect could never match any broker row.
    const state = typeof parsed['state'] === 'string' ? parsed['state'] : null;

    const nextParams: Record<string, unknown> = { ...params, auth_url: authUrl };
    if (authId) nextParams['auth_id'] = authId;
    updateParams(db, ctx.request, nextParams);

    if (state) {
      const existingRow = readAuthRequestRow(ctx.request.request_id);
      const nowMs = (deps.now ?? (() => new Date()))().getTime();
      writeAuthRequestRow({
        request_id: ctx.request.request_id,
        task_id: ctx.request.task_id,
        tenant_id: ctx.request.tenant_id,
        // A broker row may already exist (created by `pa auth request`,
        // D3) — preserve its fields and only fill in what minting just
        // learned. A worker-created oauth widget (task_input.py, no `pa
        // auth request` involved) has no prior row; create one so the
        // callback still has somewhere to land.
        shape: existingRow?.shape ?? 'S1',
        provider: config.name,
        kind: ctx.request.kind,
        status: existingRow?.status ?? 'pending',
        created_at: existingRow?.created_at ?? new Date(nowMs).toISOString(),
        expires_at: existingRow?.expires_at ?? new Date(nowMs + 43_200_000).toISOString(),
        state,
        code_verifier: existingRow?.code_verifier ?? null,
        redirect_uri: existingRow?.redirect_uri ?? redirectUri,
        auth_id: authId ?? existingRow?.auth_id ?? null,
        answer_pointer: existingRow?.answer_pointer ?? null,
        delivered_at: existingRow?.delivered_at ?? null,
      });
    }
    return authUrl;
  }

  // http arm — Phase-A ships no `http`-kind provider (AUTH_PROVIDER_CONFIGS
  // has only google/script), so this path is untested infrastructure ahead
  // of Phase B (C12): it builds the authorize URL with a broker-side state
  // nonce + PKCE and writes the broker row the new callback (auth-callback.ts)
  // will later look the state up by.
  const authCfg = config.authorize;
  const clientId = (deps.env ?? process.env)[authCfg.client_id_key];
  if (!clientId) return null;
  const state = randomBytes(16).toString('hex');
  let codeVerifier: string | null = null;
  let codeChallenge: string | undefined;
  if (config.pkce) {
    const pair = generatePkcePair();
    codeVerifier = pair.verifier;
    codeChallenge = pair.challenge;
  }
  const url = new URL(authCfg.authorize_url);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  if (authCfg.scopes.length > 0) url.searchParams.set('scope', authCfg.scopes.join(' '));
  if (codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  writeAuthRequestRow({
    request_id: ctx.request.request_id,
    task_id: ctx.request.task_id,
    tenant_id: ctx.request.tenant_id,
    shape: 'S1',
    provider: config.name,
    kind: ctx.request.kind,
    status: 'pending',
    created_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + 43_200_000).toISOString(),
    state,
    code_verifier: codeVerifier,
    redirect_uri: null,
    auth_id: null,
    answer_pointer: null,
    delivered_at: null,
  });
  const authUrl = url.toString();
  updateParams(db, ctx.request, { ...params, auth_url: authUrl });
  return authUrl;
}

/**
 * Auto-answer every pending oauth request of one task whose minted session
 * has resolved (`auth_id` no longer present in the pending-state file).
 * Writes a small non-secret marker file as the answer pointer (the ledger
 * never stores an answer value), then records the answer through the ledger's
 * single transactional path. Returns the number answered; never throws.
 */
export async function pollOauthResolutions(
  db: Database.Database,
  ctx: { tenantId: string; taskId: string },
  deps: OauthMintDeps
): Promise<number> {
  const pending = listInputRequests(db, ctx.tenantId, ctx.taskId, { status: 'pending' })
    .filter((r) => r.kind === 'oauth');
  if (pending.length === 0) return 0;

  const statePath = deps.pendingStatePath ?? join(paHome(), 'google-telegram-auth.json');
  let pendingStates: Array<Record<string, unknown>> = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'));
    if (Array.isArray(parsed)) pendingStates = parsed as Array<Record<string, unknown>>;
  } catch {
    pendingStates = []; // absent/torn file: nothing can be proven resolved
  }
  const liveAuthIds = new Set(
    pendingStates
      .map((p) => p['auth_id'])
      .filter((v): v is string => typeof v === 'string')
  );

  let answered = 0;
  for (const request of pending) {
    const params = paramsOf(request);
    const authId = params['auth_id'];
    if (typeof authId !== 'string' || !authId) continue; // not minted yet
    if (liveAuthIds.has(authId)) continue; // still pending at Google's end

    const nowIso = (deps.now ?? (() => new Date()))().toISOString();
    const answersRoot = deps.answersDir ?? join(paHome(), 'voice-inbox', 'answers');
    const markerPath = join(answersRoot, ctx.taskId, `${request.request_id}.txt`);
    try {
      mkdirSync(dirname(markerPath), { recursive: true });
      writeFileSync(
        markerPath,
        `Google authorization completed at ${nowIso} (auth_id ${authId}).\n`,
        'utf8'
      );
      const task = getTask(db, ctx.tenantId, ctx.taskId);
      if (!task) continue;
      if (deps.onAnswered) {
        await deps.onAnswered(ctx.taskId, request.request_id, markerPath);
      } else {
        answerInputRequest(db, ctx.tenantId, ctx.taskId, request.request_id, {
          answerPointer: markerPath,
        });
      }
      answered += 1;
    } catch {
      // Task not awaiting_input (already moved), request just consumed by a
      // concurrent poll, or marker write failed — leave the row for the next
      // poll; never break the response being served.
      continue;
    }
  }
  return answered;
}
