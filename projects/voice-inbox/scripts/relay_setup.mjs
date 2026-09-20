#!/usr/bin/env node
/**
 * relay_setup.mjs — one-command self-setup for the voice-inbox edge relay
 * (edge-relay wave WP-R3, spec §3 WP-R3).
 *
 * Idempotent: every step detects what already exists and reuses it, so a
 * re-run continues where the previous run stopped (the workers.dev subdomain
 * step is dashboard-only — see MSG_SUBDOMAIN).
 *
 * Auth model (spec §2i, operator addendum 2026-09-07): CF_RELAY_API_TOKEN +
 * CF_RELAY_ACCOUNT_ID (env or ~/.pa/secrets.env) take the TOKEN path — every
 * wrangler child is spawned through the ONE runWrangler helper with a minimal
 * child env carrying exactly CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, so
 * the stored OAuth of any account is never consulted and never disturbed.
 * whoami additionally asserts the relay account id (docs document no
 * env-token-over-OAuth precedence sentence, so the design does not depend on
 * precedence). Without the pair, guided `wrangler login` is the fallback for
 * single-account personal users. NO script ever runs a bare wrangler command:
 * `grep -n "spawn" scripts/relay_setup.mjs` shows every wrangler child
 * originating in runWrangler.
 *
 * Public-scrub: this file carries no personal, account, or deployment ids —
 * live values live only in gitignored runtime state.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const RELAY_DIR = join(PKG_DIR, 'relay');
const WRANGLER_PIN = 'wrangler@4.129.0'; // re-pin policy: spec §2f — a deliberate one-line bump
const DEFAULT_WORKER_NAME = 'voice-inbox-relay';
const SCHEDULER_TASK_NAME = 'PA-VoiceInbox-RelayPoller';
const LIVE_CONFIG_NAME = 'wrangler.toml';
const RELAY_SECRET_KEY = 'VOICE_INBOX_RELAY_SECRET';
const TOKEN_KEY = 'CF_RELAY_API_TOKEN';
const ACCOUNT_KEY = 'CF_RELAY_ACCOUNT_ID';

// --- Pinned human messages (spec §3 WP-R3 failure table + step 2, verbatim) --

export const MSG_NOT_LOGGED_IN =
  'Not logged in to Cloudflare. Re-run this command — it will open your browser to log in.';
export const MSG_DUAL_ACCOUNT =
  'If you use more than one Cloudflare account, create a scoped API token with exactly: ' +
  'Workers Scripts Edit, Workers R2 Storage Edit, Account Settings Read — then put ' +
  'CF_RELAY_API_TOKEN and CF_RELAY_ACCOUNT_ID in ~/.pa/secrets.env and re-run. ' +
  'Otherwise just re-run and log in with your browser.';
export const MSG_SUBDOMAIN =
  'Your Cloudflare account has no workers.dev subdomain yet (a one-time Cloudflare ' +
  'requirement). Open https://dash.cloudflare.com → Workers & Pages → Your subdomain, ' +
  'pick a name, then re-run this command — it will continue where it stopped.';
export const MSG_HEALTHZ =
  'The relay deployed but is not answering yet (free-tier deploys can lag ~30 s). ' +
  'Wait a minute and re-run — everything else is already done.';
export const MSG_OFFLINE =
  'Cannot reach the internet. Check your connection and re-run — setup continues where it stopped.';
export const MSG_TOKEN_BAD =
  'The relay API token did not authenticate. Check CF_RELAY_API_TOKEN in ' +
  '~/.pa/secrets.env, or re-create it in the Cloudflare dashboard.';
export const MSG_TOKEN_WRONG_ACCOUNT =
  "That API token belongs to a different Cloudflare account. Point CF_RELAY_ACCOUNT_ID at " +
  "the token's account, or create the token on the relay account.";
export const MSG_TOKEN_PERMS =
  'The relay API token is missing permissions. It needs exactly: Workers Scripts Edit, ' +
  'Workers R2 Storage Edit, Account Settings Read.';

const MSG_BUCKET_REUSE = 'bucket already exists — reusing';
const MSG_SECRET_REUSE = 'using the existing relay secret';
const MSG_LOGIN_BROWSER =
  'Your browser will open to log in to Cloudflare — choose the free plan account you want to use';
const MSG_NO_AUTOSTART =
  'auto-start is Windows-only; run `node scripts/relay_poller.mjs` under your own supervisor';

// --- Small pure helpers ------------------------------------------------------

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Masks a secret for display: last 4 chars only. */
export function maskSecret(value) {
  const v = String(value ?? '');
  return '…' + v.slice(-4);
}

/**
 * Parses `KEY=value` out of a secrets.env-style text (comments and blank lines
 * skipped, surrounding quotes stripped). Returns the value or null.
 */
export function parseSecretsValue(text, key) {
  const m = String(text ?? '').match(
    new RegExp(`^${escapeRegExp(key)}[ \\t]*=[ \\t]*(.*?)[ \\t]*$`, 'm')
  );
  if (!m) return null;
  let v = m[1];
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    v = v.slice(1, -1);
  }
  return v.length > 0 ? v : null;
}

/** Reads a single `key = "value"` assignment out of TOML-ish text. */
export function parseTomlStringField(text, key) {
  const m = String(text ?? '').match(
    new RegExp(`^${escapeRegExp(key)}[ \\t]*=[ \\t]*"([^"]*)"`, 'm')
  );
  return m ? m[1] : null;
}

/**
 * Generates the live wrangler config from the tracked example: fills the
 * worker name and the bucket name, leaves every other line byte-identical.
 * The character class stops before \r so CRLF example files keep their
 * line endings on the two replaced lines.
 */
export function buildLiveConfig(exampleText, { name, bucketName }) {
  const text = String(exampleText ?? '');
  if (!/^name[ \t]*=/m.test(text) || !/^bucket_name[ \t]*=/m.test(text)) {
    throw new Error(
      'relay template is unusable: relay/wrangler.toml.example is missing the name/bucket_name lines'
    );
  }
  let out = text.replace(/^name[ \t]*=[^\r\n]*/m, `name = "${name}"`);
  out = out.replace(/^bucket_name[ \t]*=[^\r\n]*/m, `bucket_name = "${bucketName}"`);
  return out;
}

/** Extracts the deployed workers.dev URL from `wrangler deploy` stdout. */
export function parseDeployUrl(stdout) {
  const m = String(stdout ?? '').match(/https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev/i);
  return m ? m[0] : null;
}

/** Spec failure table, row "deploy fails + subdomain" (lowercase substring). */
export function subdomainMissing(stderrText) {
  return /subdomain/.test(String(stderrText ?? '').toLowerCase());
}

/**
 * Generates the relay poller's watchdog launcher text (2026-09-10
 * launch-cadence wave, WP-B, spec §S1/§S2/§B2). Before this gate, the
 * per-minute Task Scheduler tick unconditionally spawned powershell.exe just
 * to have relay_start.ps1 read the lock file and exit — a liveness check
 * that cost a full PowerShell launch. `lockPath` is BAKED at generation
 * time (a Task Scheduler launch has no useful environment). CRLF-joined,
 * matching every other VBS this project writes.
 */
export function buildRelayPollerLauncherVbs(pkgDir, ps1Path, lockPath) {
  return [
    "' Voice-inbox relay poller launcher — generated by scripts/relay_setup.mjs.",
    "' Sets CurrentDirectory FIRST: Task Scheduler tasks otherwise start in",
    "' C:\\Windows\\System32 and every relative path resolves wrong.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${pkgDir}"`,
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `lockPath = "${lockPath}"`,
    'If PidIsLiveNode(ReadJsonPid(lockPath)) Then WScript.Quit 0',
    `shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""${ps1Path}""", 0, False`,
    '',
    "' Returns the digits following the first \"pid\": in the file, or 0.",
    'Function ReadJsonPid(path)',
    '  Dim text, at, i, ch, digits',
    '  ReadJsonPid = 0',
    '  If Not fso.FileExists(path) Then Exit Function',
    '  On Error Resume Next',
    '  text = fso.OpenTextFile(path, 1).ReadAll()',
    '  If Err.Number <> 0 Then Err.Clear : Exit Function',
    '  On Error GoTo 0',
    '  at = InStr(text, """pid""")',
    '  If at = 0 Then Exit Function',
    '  digits = ""',
    '  For i = at + 5 To Len(text)',
    '    ch = Mid(text, i, 1)',
    '    If ch >= "0" And ch <= "9" Then',
    '      digits = digits & ch',
    '    ElseIf Len(digits) > 0 Then',
    '      Exit For',
    '    End If',
    '  Next',
    '  If Len(digits) > 0 Then ReadJsonPid = CLng(digits)',
    'End Function',
    '',
    "' Liveness gate: true only when a live node.exe holds this PID. Anything else -",
    "' missing lock file, unparseable PID, dead process, a non-node process that",
    "' reused the PID, an unexpected tasklist result - reads as NOT live, so the",
    "' worst case is one wasted launch that exits on the real lock. Never the",
    '\' reverse: a false "alive" would leave the service down forever.',
    'Function PidIsLiveNode(pid)',
    '  Dim cmdText',
    '  PidIsLiveNode = False',
    '  If Not IsNumeric(pid) Then Exit Function',
    '  If CDbl(pid) <= 0 Then Exit Function',
    '  cmdText = "cmd /c tasklist /NH /FI ""PID eq " & CLng(pid) & """ /FI ""IMAGENAME eq node.exe"" | find /I ""node.exe"" >nul"',
    '  PidIsLiveNode = (shell.Run(cmdText, 0, True) = 0)',
    'End Function',
    '',
  ].join('\r\n');
}

const nameTakenMessage = (workerName) =>
  `The worker name "${workerName}" is taken on your account. Re-run with: ` +
  `node scripts/relay_setup.mjs --name ${workerName}-2`;

/**
 * Spec failure table: maps tool output to the pinned human message. Returns
 * null when nothing matches (the caller prints a generic cause + the output
 * tail instead of a stack dump). `hasTokenPair` selects between the whoami
 * rows (dual-account recipe when no CF_RELAY_* pair exists).
 */
export function humanizeWranglerError(
  stderrText,
  { hasTokenPair = false, workerName = DEFAULT_WORKER_NAME } = {}
) {
  const text = String(stderrText ?? '');
  const t = text.toLowerCase();
  if (/enotfound|econnrefused|econnreset|etimedout|offline|network error/.test(t)) {
    return MSG_OFFLINE;
  }
  if (hasTokenPair && /\b403\b|forbidden|missing permission|insufficient permission/.test(t)) {
    return MSG_TOKEN_PERMS;
  }
  if (subdomainMissing(text)) return MSG_SUBDOMAIN;
  if (/name.*(taken|already in use)|already assigned/.test(t)) {
    return nameTakenMessage(workerName);
  }
  if (/not authenticated/.test(t)) {
    return hasTokenPair ? MSG_NOT_LOGGED_IN : MSG_DUAL_ACCOUNT;
  }
  if (
    hasTokenPair &&
    /code:\s*(6003|6111|10000)|apiauthenticationerror|invalid request headers|invalid format for authorization/.test(t)
  ) {
    return MSG_TOKEN_BAD;
  }
  return null;
}

// Auth-failure shapes wrangler prints for a rejected API token (the machine
// proof behind this regex: a bogus CLOUDFLARE_API_TOKEN hits /user/tokens/verify
// and fails with "Invalid request headers [code: 6003]" / "Invalid format for
// Authorization header [code: 6111]" — the stored OAuth is NOT consulted).
const TOKEN_AUTH_FAIL_RE =
  /code:\s*(6003|6111|10000)|apiauthenticationerror|authentication error|invalid request headers|invalid format for authorization|not authenticated/i;

/**
 * Classifies a token-mode `wrangler whoami` run. Returns null when the token
 * authenticated AND the relay account id appears in the output (the §2i
 * account assertion); otherwise one of the three pinned messages.
 */
export function classifyTokenAuth(output, expectedAccountId) {
  const text = String(output ?? '');
  if (/enoent|econnrefused|enotfound|etimedout/i.test(text)) return MSG_OFFLINE;
  if (TOKEN_AUTH_FAIL_RE.test(text)) return MSG_TOKEN_BAD;
  if (!text.includes(String(expectedAccountId ?? ''))) return MSG_TOKEN_WRONG_ACCOUNT;
  return null;
}

/**
 * Appends `KEY=value` to a secrets.env text exactly once. Idempotent: when the
 * key is already present the text is returned unchanged (reuse, never rotate).
 */
export function appendToSecretsEnv(text, key, value) {
  if (parseSecretsValue(text, key) !== null) return String(text ?? '');
  const t = String(text ?? '');
  const head = t.length === 0 ? '' : t.endsWith('\n') ? t : t + '\n';
  return `${head}${key}=${value}\n`;
}

/**
 * Auth resolution (step 2, spec §2i). Precedence: process env over the
 * secrets.env text. Returns the token path when BOTH keys resolve; a half-set
 * pair falls back to login mode (it must never silently deploy); neither key
 * is plain login mode.
 *
 * NOTE on the spec's "no return value contains the token value": the raw
 * token rides ONLY `authEnv.CLOUDFLARE_API_TOKEN` (runWrangler needs it to
 * spawn the child). Every other field, every display string, and every
 * login-mode return never carry it, and all printed output uses maskSecret.
 */
export function resolveWranglerAuth({ env = {}, secretsEnvText = '' } = {}) {
  const envToken = typeof env[TOKEN_KEY] === 'string' ? env[TOKEN_KEY].trim() : '';
  const envAccount = typeof env[ACCOUNT_KEY] === 'string' ? env[ACCOUNT_KEY].trim() : '';
  const token = envToken || parseSecretsValue(secretsEnvText, TOKEN_KEY);
  const accountId = envAccount || parseSecretsValue(secretsEnvText, ACCOUNT_KEY);
  if (token && accountId) {
    return {
      mode: 'token',
      authEnv: { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId },
      accountId,
      tokenSource: envToken ? 'environment' : '~/.pa/secrets.env',
      maskedToken: maskSecret(token),
      halfSet: false,
      missing: [],
    };
  }
  if (token || accountId) {
    return {
      mode: 'login',
      halfSet: true,
      missing: [token ? ACCOUNT_KEY : TOKEN_KEY],
    };
  }
  return { mode: 'login', halfSet: false, missing: [] };
}

// --- Child-process plumbing --------------------------------------------------

// Minimal child env (spec §2i): never the parent's full env, so no other
// credential (a CLOUDFLARE_API_TOKEN of another project, OAuth helper vars,
// NODE_OPTIONS hooks) can leak into or override the relay's wrangler children.
// Proxy vars are forwarded: deploy must reach the Cloudflare API.
const CHILD_ENV_KEYS = [
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'HOME',
  'PA_HOME',
  'APPDATA',
  'PSModulePath',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'ALLUSERSPROFILE',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

function childEnv(authEnv) {
  const env = {};
  for (const key of CHILD_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (authEnv) Object.assign(env, authEnv);
  return env;
}

/** ONE low-level spawn primitive for this script (windowsHide always on). */
function spawnCapture(file, argv, { capture = true, stdinData = null, env = null, cwd = null } = {}) {
  return new Promise((resolve) => {
    const stdio = capture ? 'pipe' : 'inherit';
    const child = spawn(file, argv, {
      shell: false,
      windowsHide: true,
      cwd: cwd ?? undefined,
      env: env ?? undefined,
      stdio: stdinData !== null && capture ? ['pipe', 'pipe', 'pipe'] : stdio,
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
    }
    if (stdinData !== null) {
      // child.stdin is null under stdio 'inherit' — only piped children take data
      child.stdin.write(stdinData);
      child.stdin.end();
    }
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: stderr + String(err && err.message ? err.message : err) });
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

let liveConfigPathCache = null;

/**
 * THE one wrangler entry point (spec §2i structural rule): every wrangler
 * child in this script originates here. authEnv carries the two token-path
 * vars; without it the child uses wrangler's own stored login state (login
 * mode only). `capture: false` (inherited stdio) is for the interactive
 * login step; `useLiveConfig: false` for commands that need no config.
 */
export function runWrangler(
  args,
  { authEnv = null, capture = true, stdinData = null, useLiveConfig = true } = {}
) {
  const finalArgs = useLiveConfig && liveConfigPathCache ? [...args, '--config', liveConfigPathCache] : [...args];
  let file;
  let argv;
  if (process.platform === 'win32') {
    // npx is npx.cmd — spawn with shell:false rejects .cmd (EINVAL), so go
    // through cmd.exe with an argv array (no shell string, no interpolation).
    file = process.env.COMSPEC || 'cmd.exe';
    argv = ['/d', '/s', '/c', 'npx', '-y', WRANGLER_PIN, ...finalArgs];
  } else {
    file = 'npx';
    argv = ['-y', WRANGLER_PIN, ...finalArgs];
  }
  return spawnCapture(file, argv, {
    capture,
    stdinData,
    env: childEnv(authEnv),
    cwd: RELAY_DIR,
  });
}

// --- Failure plumbing (cause + next action, never a stack dump) --------------

class SetupError extends Error {
  constructor(message, { detail = '', exitCode = 1 } = {}) {
    super(message);
    this.detail = detail;
    this.exitCode = exitCode;
  }
}

function tailLines(text, max = 10) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  return lines.slice(-max).join('\n');
}

function failFromToolOutput(text, { hasTokenPair, workerName, exitCode = 1 }) {
  const human = humanizeWranglerError(text, { hasTokenPair, workerName });
  throw new SetupError(
    human ?? 'A Cloudflare command failed. Fix the cause below and re-run — setup continues where it stopped.',
    { detail: tailLines(text), exitCode }
  );
}

function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function paHome() {
  return process.env.PA_HOME || join(homedir(), '.pa');
}

const numberOr = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// --- Steps -------------------------------------------------------------------

function preflight() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 22) {
    throw new SetupError(
      `Node 22 or newer is required (found ${process.versions.node}). Update Node from https://nodejs.org and re-run.`
    );
  }
  if (!existsSync(join(PKG_DIR, 'node_modules'))) {
    throw new SetupError(
      'Dependencies are missing. Run `npm ci && npm run build` in projects/voice-inbox first, then re-run setup.'
    );
  }
  return readAppConfig();
}

// Mirrors src/config.ts resolution: env wins over the file; port defaults to
// 8787, max_upload_mb to 25. Setup only needs presence + the resolved port.
function readAppConfig() {
  const configPath = join(paHome(), 'config.yaml');
  let block = {};
  try {
    const parsed = parseYaml(readFileSync(configPath, 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.voice_inbox &&
      typeof parsed.voice_inbox === 'object'
    ) {
      block = parsed.voice_inbox;
    }
  } catch (err) {
    throw new SetupError(
      'The app itself is not configured yet — finish the README "Running it" section first, then re-run setup.',
      { detail: `could not read ${configPath}: ${err && err.message ? err.message : err}` }
    );
  }
  const envTopic = process.env.VOICE_INBOX_INBOX_TOPIC?.trim();
  const topic = envTopic || (typeof block.inbox_topic === 'string' ? block.inbox_topic.trim() : '');
  if (!topic) {
    throw new SetupError(
      'The app itself is not configured yet — finish the README "Running it" section first, then re-run setup.',
      { detail: `${configPath} has no voice_inbox.inbox_topic` }
    );
  }
  const envPort = process.env.VOICE_INBOX_PORT?.trim();
  const rawPort = envPort || (block.port !== undefined ? block.port : '');
  if (rawPort !== '' && !Number.isFinite(Number(rawPort))) {
    throw new SetupError(
      'The app itself is not configured yet — finish the README "Running it" section first, then re-run setup.',
      { detail: `voice_inbox.port is not a number (${String(rawPort)})` }
    );
  }
  return {
    port: numberOr(rawPort === '' ? undefined : rawPort, 8787),
    maxUploadMb: numberOr(block.max_upload_mb, 25),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Step 10 liveness evidence: a FRESHLY started poller must produce a new log
 * line (it writes an event:start line the moment it boots). A stale log from
 * an earlier run must not count — otherwise setup declares the relay live
 * while the poller died on startup.
 */
async function waitForLogGrowth(logPath, sizeBefore, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let size = 0;
    try {
      size = statSync(logPath).size;
    } catch {
      size = 0;
    }
    if (size > sizeBefore) return true;
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

/** Step 10: within the window assert BOTH /healthz and a poller log line. */
async function verifyRelayLive(workerBaseUrl, stateDir, timeoutMs) {
  const logPath = join(stateDir, 'logs', 'relay-poller.log');
  const deadline = Date.now() + timeoutMs;
  let healthz = false;
  let logged = false;
  while (Date.now() < deadline && !(healthz && logged)) {
    if (!healthz) {
      try {
        const res = await fetch(`${workerBaseUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
        if (res.ok && (await res.text()).includes('"ok":true')) healthz = true;
      } catch {
        // retry until the deadline
      }
    }
    if (!logged) {
      const text = readIfExists(logPath);
      if (text !== null && text.split('\n').some((l) => l.trim().length > 0)) logged = true;
    }
    if (!(healthz && logged)) await sleep(2000);
  }
  return { healthz, logged };
}

function isValidWorkerName(name) {
  return /^[a-zA-Z0-9-]{1,63}$/.test(name) && !name.startsWith('-') && !name.endsWith('-');
}

const USAGE = `voice-inbox relay — one-command self-setup (stable URL on your own Cloudflare free account).

Usage:
  node scripts/relay_setup.mjs [--name <worker-name>] [--verbose]
  node scripts/relay_setup.mjs --help

The command is idempotent — safe to re-run; it continues where it stopped.

What it does:
  1.  Preflight: Node 22+, installed dependencies, the app config in ~/.pa/config.yaml
  2.  Cloudflare auth: CF_RELAY_API_TOKEN + CF_RELAY_ACCOUNT_ID (token mode, verified
      via whoami), or guided browser login when the pair is absent
  3.  Generates relay/wrangler.toml.live from the tracked example
  4.  Creates the R2 bucket (or reuses it)
  5.  Creates (or reuses) VOICE_INBOX_RELAY_SECRET in ~/.pa/secrets.env
  6.  Deploys the worker and reads the stable workers.dev URL
  7.  Stores RELAY_SECRET on the worker
  8.  Writes ~/.pa/voice-inbox/relay.json for the poller
  9.  Registers the PA-VoiceInbox-RelayPoller scheduled task (Windows, every minute)
  10. Starts the poller now and verifies /healthz plus the poller log
  11. Prints the stable URL and the pairing instructions

Options:
  --name <worker-name>  Worker name (default: voice-inbox-relay; letters, digits,
                        dashes; no leading/trailing dash; 63 chars max)
  --verbose             Rethrow errors with full detail (debugging)
  --help                Show this help and exit (no side effects)
`;

function parseArgs(argv) {
  const out = { verbose: false, name: DEFAULT_WORKER_NAME };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verbose') {
      out.verbose = true;
    } else if (arg === '--name') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new SetupError('--name needs a worker name (letters, digits, dashes).', { exitCode: 2 });
      }
      out.name = value;
    } else {
      throw new SetupError(`Unknown option "${arg}". See: node scripts/relay_setup.mjs --help`, {
        exitCode: 2,
      });
    }
  }
  if (!isValidWorkerName(out.name)) {
    throw new SetupError(
      `"${out.name}" is not a valid worker name (letters, digits, dashes; no leading/trailing dash; 63 chars max).`,
      { exitCode: 2 }
    );
  }
  return out;
}

// --- The 11 steps ------------------------------------------------------------

async function runSetup(args) {
  const stateDir = join(paHome(), 'voice-inbox');
  const step = (n, text) => process.stdout.write(`[${n}/11] ${text}\n`);
  const note = (text) => process.stdout.write(`    ${text}\n`);

  // 1. Preflight
  step(1, 'Preflight: Node, dependencies, and the app config');
  const { port, maxUploadMb } = preflight();
  note(`app config ok (home app on port ${port}, uploads up to ${maxUploadMb} MiB)`);

  // 2. Auth — env-token first, guided login fallback (spec §2i)
  const secretsPath = join(paHome(), 'secrets.env');
  const secretsText = readIfExists(secretsPath) ?? '';
  const auth = resolveWranglerAuth({ env: process.env, secretsEnvText: secretsText });
  let authEnv = null;
  let hasTokenPair = false;
  if (auth.mode === 'token') {
    hasTokenPair = true;
    authEnv = auth.authEnv;
    step(2, `Cloudflare authentication: API-token mode (token ${auth.maskedToken} from ${auth.tokenSource})`);
    const who = await runWrangler(['whoami'], { authEnv, useLiveConfig: false });
    const problem = classifyTokenAuth(`${who.stdout}\n${who.stderr}`, auth.accountId);
    if (problem) throw new SetupError(problem, { detail: tailLines(`${who.stdout}\n${who.stderr}`) });
    note('token authenticated and the relay account id matched');
  } else {
    step(2, 'Cloudflare authentication: guided browser login');
    if (auth.halfSet) {
      note(
        `only one of CF_RELAY_API_TOKEN / CF_RELAY_ACCOUNT_ID is set (${auth.missing.join(', ')} is ` +
          'missing) — the token path needs both. Falling back to browser login; if you use more ' +
          'than one Cloudflare account, set both keys in ~/.pa/secrets.env instead.'
      );
    }
    note(MSG_LOGIN_BROWSER);
    const login = await runWrangler(['login'], { capture: false, useLiveConfig: false });
    const who = await runWrangler(['whoami'], { useLiveConfig: false });
    const whoOut = `${who.stdout}\n${who.stderr}`;
    // whoami is the authoritative success signal — a non-zero login exit with
    // a passing whoami is still a successful login.
    if (who.code !== 0 || /not authenticated/i.test(whoOut)) {
      throw new SetupError(
        humanizeWranglerError(whoOut, { hasTokenPair }) ?? MSG_NOT_LOGGED_IN,
        { detail: tailLines(`${login.stderr}\n${whoOut}`) }
      );
    }
  }

  // 3. Live config (idempotent reuse; the live file governs name + bucket).
  // The live file MUST end in .toml — wrangler ignores configs whose extension
  // it does not recognize (a `wrangler.toml.live` --config arg reads as no
  // config: "missing worker entrypoint", configFileType none). Plain
  // `wrangler.toml` is gitignored via the `relay/wrangler.toml*` wildcard.
  liveConfigPathCache = join(RELAY_DIR, LIVE_CONFIG_NAME);
  const legacyLivePath = join(RELAY_DIR, 'wrangler.toml.live');
  if (readIfExists(liveConfigPathCache) === null && existsSync(legacyLivePath)) {
    renameSync(legacyLivePath, liveConfigPathCache);
    step(3, `renamed relay/wrangler.toml.live -> relay/${LIVE_CONFIG_NAME} (wrangler requires the .toml extension)`);
  }
  let liveText = readIfExists(liveConfigPathCache);
  let workerName;
  let bucketName;
  if (liveText === null) {
    const exampleText = readFileSync(join(RELAY_DIR, 'wrangler.toml.example'), 'utf8');
    bucketName = `${args.name}-relay-bucket`;
    liveText = buildLiveConfig(exampleText, { name: args.name, bucketName });
    writeFileSync(liveConfigPathCache, liveText);
    workerName = args.name;
    step(3, `Wrote relay/${LIVE_CONFIG_NAME} (worker "${workerName}", bucket "${bucketName}")`);
  } else {
    workerName = parseTomlStringField(liveText, 'name') ?? args.name;
    bucketName = parseTomlStringField(liveText, 'bucket_name') ?? `${workerName}-relay-bucket`;
    step(3, `relay/${LIVE_CONFIG_NAME} already exists — reusing it (worker "${workerName}")`);
  }

  // 4. R2 bucket
  step(4, `R2 bucket "${bucketName}"`);
  const bucket = await runWrangler(['r2', 'bucket', 'create', bucketName], { authEnv });
  const bucketOut = `${bucket.stdout}\n${bucket.stderr}`;
  if (bucket.code !== 0) {
    if (/already exists/i.test(bucketOut)) {
      note(MSG_BUCKET_REUSE);
    } else {
      failFromToolOutput(bucketOut, { hasTokenPair, workerName });
    }
  }

  // 5. Relay secret (reuse, never rotate)
  let relaySecret = parseSecretsValue(secretsText, RELAY_SECRET_KEY);
  if (relaySecret !== null) {
    step(5, MSG_SECRET_REUSE);
  } else {
    relaySecret = randomBytes(32).toString('hex');
    writeFileSync(secretsPath, appendToSecretsEnv(secretsText, RELAY_SECRET_KEY, relaySecret));
    step(5, `Generated a new relay secret and stored it in ${secretsPath}`);
  }

  // 6. Deploy
  step(6, `Deploying the worker "${workerName}" (~30 s)`);
  const deploy = await runWrangler(['deploy'], { authEnv });
  const deployOut = `${deploy.stdout}\n${deploy.stderr}`;
  if (deploy.code !== 0) {
    if (subdomainMissing(deployOut)) {
      throw new SetupError(MSG_SUBDOMAIN, { detail: tailLines(deployOut), exitCode: 2 });
    }
    failFromToolOutput(deployOut, { hasTokenPair, workerName });
  }
  const stableUrl = parseDeployUrl(deploy.stdout);
  if (!stableUrl) {
    throw new SetupError(
      'The deploy succeeded but no workers.dev URL was printed. Re-run this command — it continues where it stopped.',
      { detail: tailLines(deploy.stdout) }
    );
  }
  note(`Stable URL: ${stableUrl}`);

  // 7. Worker secret (piped stdin — verified wrangler capability, spec §0.1)
  step(7, 'Storing RELAY_SECRET on the worker');
  const secretPut = await runWrangler(['secret', 'put', 'RELAY_SECRET'], {
    authEnv,
    stdinData: `${relaySecret}\n`,
  });
  if (secretPut.code !== 0) {
    failFromToolOutput(`${secretPut.stdout}\n${secretPut.stderr}`, { hasTokenPair, workerName });
  }

  // 8. Poller config (timing keys ride the tracked example's defaults)
  mkdirSync(stateDir, { recursive: true });
  const exampleRelayConfig = JSON.parse(
    readIfExists(join(RELAY_DIR, 'relay.config.example.json')) ?? '{}'
  );
  const relayConfig = {
    worker_base_url: stableUrl,
    home_base_url: `http://127.0.0.1:${port}`,
    poll_wait_ms: numberOr(exampleRelayConfig.poll_wait_ms, 25000),
    request_deadline_ms: numberOr(exampleRelayConfig.request_deadline_ms, 55000),
    localhost_timeout_ms: numberOr(exampleRelayConfig.localhost_timeout_ms, 50000),
  };
  const relayJsonPath = join(stateDir, 'relay.json');
  writeFileSync(relayJsonPath, `${JSON.stringify(relayConfig, null, 2)}\n`);
  step(8, `Wrote ${relayJsonPath} (home app at ${relayConfig.home_base_url})`);

  // 9. Auto-start: VBS launcher (CurrentDirectory FIRST) + scheduled task
  if (process.platform !== 'win32') {
    step(9, MSG_NO_AUTOSTART);
  } else {
    const vbsPath = join(stateDir, 'relay-poller-launcher.vbs');
    const ps1Path = join(PKG_DIR, 'scripts', 'relay_start.ps1');
    const lockPath = join(stateDir, 'relay-poller.lock');
    const vbsText = buildRelayPollerLauncherVbs(PKG_DIR, ps1Path, lockPath);
    writeFileSync(vbsPath, vbsText);
    const task = await spawnCapture(
      'schtasks',
      [
        '/Create',
        '/F',
        '/TN',
        SCHEDULER_TASK_NAME,
        '/SC',
        'MINUTE',
        '/MO',
        '1',
        '/TR',
        `wscript.exe "${vbsPath}"`,
      ],
      { env: childEnv(null), cwd: stateDir }
    );
    if (task.code !== 0) {
      throw new SetupError(
        `Could not register the auto-start task (${SCHEDULER_TASK_NAME}). Everything else is ` +
          'done — start the poller with: powershell -File scripts\\relay_start.ps1',
        { detail: tailLines(`${task.stdout}\n${task.stderr}`) }
      );
    }
    step(9, `Registered scheduled task ${SCHEDULER_TASK_NAME} (every minute, ensure-running)`);
  }

  // 10. Start now + verify (log + endpoint, never the launcher's exit code)
  if (process.platform === 'win32') {
    const logPath = join(stateDir, 'logs', 'relay-poller.log');
    let logSizeBefore = 0;
    try {
      logSizeBefore = statSync(logPath).size;
    } catch {
      logSizeBefore = 0;
    }
    const start = await spawnCapture(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(PKG_DIR, 'scripts', 'relay_start.ps1'),
      ],
      { env: childEnv(null), cwd: stateDir }
    );
    const startOut = `${start.stdout}\n${start.stderr}`;
    if (/already running/i.test(startOut)) {
      note('poller reports it is already running — continuing');
    } else if (start.code !== 0) {
      throw new SetupError(
        'The poller launcher failed to start. Check ~/.pa/voice-inbox/logs/relay-poller.err and re-run.',
        { detail: tailLines(startOut) }
      );
    } else {
      // A fresh start must prove itself: no new log line within 15 s means the
      // poller died on boot (check the .err companion).
      const grew = await waitForLogGrowth(logPath, logSizeBefore, 15000);
      if (!grew) {
        throw new SetupError(
          'The poller launcher started but the poller has not logged. Check ' +
            '~/.pa/voice-inbox/logs/relay-poller.err and re-run.',
          { detail: `no new line appeared in ${logPath} within 15 s` }
        );
      }
    }
  }
  step(10, 'Waiting for the relay to answer (up to 30 s)');
  const live = await verifyRelayLive(stableUrl, stateDir, 30000);
  if (!live.healthz) {
    throw new SetupError(MSG_HEALTHZ, { detail: `GET ${stableUrl}/healthz never returned {"ok":true}` });
  }
  if (!live.logged) {
    throw new SetupError(
      'The relay is answering but the poller has not logged yet. Check ' +
        '~/.pa/voice-inbox/logs/relay-poller.err and re-run — everything else is already done.',
      { detail: 'no line appeared in ~/.pa/voice-inbox/logs/relay-poller.log within 30 s' }
    );
  }
  note('relay answers and the poller is logging — live');

  // 11. Summary
  step(11, 'Summary');
  process.stdout.write('\n');
  process.stdout.write(`  Stable URL:  ${stableUrl}\n`);
  process.stdout.write(
    `  Limits:      uploads up to ${maxUploadMb} MiB; a request must finish within 55 s ` +
      'or the app shows a retryable error.\n'
  );
  process.stdout.write('\n');
  process.stdout.write(
    `  Pair your phone: run \`node scripts/mint_pairing.mjs --user-id <id> --chat-id <id>\` ` +
      `(or \`/pair\` in the bot), then open ${stableUrl} on the phone and enter the code\n`
  );
  process.stdout.write('\n');
  process.stdout.write('Setup complete — now pair your phone.\n');
}

// --- Entry -------------------------------------------------------------------

// main() runs ONLY on direct entry — importing this module must not spawn
// anything, read any file, or touch the network. realpathSync guards the
// Windows drive-letter/realpath variants (same pattern as relay_poller.mjs).
function isMainEntry() {
  if (!process.argv[1]) return false;
  if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`voice-inbox relay: ${err.message}\n`);
    return err.exitCode ?? 2;
  }
  try {
    await runSetup(args);
    return 0;
  } catch (err) {
    if (args.verbose) throw err;
    process.stderr.write(`voice-inbox relay: ${err.message}\n`);
    if (err.detail) {
      for (const line of String(err.detail).split('\n')) {
        process.stderr.write(`    ${line}\n`);
      }
    }
    return err.exitCode ?? 1;
  }
}

if (isMainEntry()) {
  main().then((code) => {
    process.exitCode = code ?? 0;
  });
}
