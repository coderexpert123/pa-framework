import { spawn, type SpawnOptions } from 'child_process';
import { openSync, readFileSync, statSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import net from 'net';
import { resolvePythonCommand } from '../../../pa/dist/src/lib/python.js';

// Protocol version this client speaks (plan D5). A state file advertising any
// other value is treated as unreadable — never guess at wire compatibility.
const SUPPORTED_PROTOCOL = 1;

const POLL_INTERVAL_MS = 250;

// A crashed/log-flooding worker previously produced zero diagnostics — this
// caps the redirected stderr log so it self-bounds without a recurring
// maintenance job (see workerSpawnOptions).
const VOICE_WORKER_LOG_MAX_BYTES = 1 * 1024 * 1024;

export interface VoiceWorkerState {
  pid: number;
  port: number;
  token: string;
  started_at: string;
  protocol: number;
}

export interface VoiceWorkerRequest {
  audio_path: string;
  engine: string; // 'auto'
  engine_preference: string;
  cloud_order: string[];
  language?: string | null;
  // Optional, deliberately (D11 fix, post-landing): the max-chars ceiling has exactly one
  // source of truth, transcribe_voice.py's DEFAULT_MAX_CHARS constant. voice_worker.py's
  // handler already does `req.get('max_chars')` (None on omission) and forwards that
  // straight to transcribe_to_envelope, which resolves None the same way the spawn/CLI path
  // does. Callers should omit this field, not duplicate the constant into TypeScript.
  max_chars?: number;
  request_id: string;
}

export type VoiceWorkerOutcome =
  | { kind: 'envelope'; envelope: Record<string, any> } // the worker answered (ok true OR false)
  | { kind: 'timeout'; message: string } // the transcribe leg itself timed out (never the ping leg — that resolves 'busy')
  | { kind: 'unavailable'; message: string };

/** Outcome of a single ping: 'ok' requires both a truthy response AND a
 * matching protocol; 'busy' means the PID is live but didn't answer within
 * budget (must NOT be treated as dead); 'refused' covers a connection error
 * or a malformed/negative response; 'bad-protocol' means the worker answered
 * but speaks a protocol version this client doesn't support. */
export type PingOutcome = 'ok' | 'busy' | 'refused' | 'bad-protocol';

/** Thrown by defaultConnect's timeout handler (in place of a bare Error) so
 * callers can distinguish "no answer within budget" from every other
 * failure shape without string-matching a message. */
export class VoiceWorkerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceWorkerTimeoutError';
  }
}

export interface VoiceWorkerClientDeps {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  connectFn?: (port: number, payload: string, timeoutMs: number) => Promise<string>;
  spawnFn?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => void;
  isPidAliveFn?: (pid: number) => boolean;
  sleepFn?: (ms: number) => Promise<void>;
  /** Injectable clock for spawnAndWait's real-deadline loop. Defaults to Date.now. */
  nowFn?: () => number;
}

function resolvePaHome(env: NodeJS.ProcessEnv): string {
  return env.PA_HOME || join(homedir(), '.pa');
}

export function voiceWorkerStatePath(env: NodeJS.ProcessEnv): string {
  return join(resolvePaHome(env), 'voice-worker.json');
}

export function voiceWorkerScriptPath(env: NodeJS.ProcessEnv, repoRoot: string): string {
  const override = env.PA_VOICE_WORKER_SCRIPT?.trim();
  if (override) return override;
  return join(repoRoot, 'pa', 'scripts', 'voice_worker.py');
}

/** Where the persistent worker's redirected stderr lands (workerSpawnOptions). */
export function voiceWorkerLogPath(env: NodeJS.ProcessEnv): string {
  return join(resolvePaHome(env), 'voice-worker.log');
}

/** Where the worker records its own start-failure diagnostics (WP2 item 5). */
export function voiceWorkerErrorPath(env: NodeJS.ProcessEnv): string {
  return join(resolvePaHome(env), 'voice-worker.error');
}

function envIntMs(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Reads and validates the state file. Never throws — every failure mode (missing,
 * unparseable, structurally wrong, unknown protocol) resolves to null. */
export function readVoiceWorkerState(env: NodeJS.ProcessEnv): VoiceWorkerState | null {
  let raw: string;
  try {
    raw = readFileSync(voiceWorkerStatePath(env), 'utf8');
  } catch {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.pid !== 'number' ||
    typeof parsed.port !== 'number' ||
    typeof parsed.token !== 'string' ||
    typeof parsed.started_at !== 'string' ||
    parsed.protocol !== SUPPORTED_PROTOCOL
  ) {
    return null;
  }

  // Reconstruct from only the known fields — an extra property on the file
  // (e.g. a spoofed "host") can never reach the connection logic below.
  return {
    pid: parsed.pid,
    port: parsed.port,
    token: parsed.token,
    started_at: parsed.started_at,
    protocol: parsed.protocol,
  };
}

/** Surfaces the persistent worker's own crash diagnostics (WP2 item 5's
 * `voice-worker.error` file) so a "did not become ready" message can name
 * the real cause. Only returns a failure recorded at/after `sinceMs` — a
 * stale error from an earlier, unrelated spawn attempt must never be blamed
 * on the current one. */
export interface VoiceWorkerStartFailure {
  at: string;
  pid: number;
  error: string;
  error_type: string;
  traceback?: string;
}

export function readWorkerStartFailure(env: NodeJS.ProcessEnv, sinceMs: number): VoiceWorkerStartFailure | undefined {
  let raw: string;
  try {
    raw = readFileSync(voiceWorkerErrorPath(env), 'utf8');
  } catch {
    return undefined;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (
    !parsed ||
    typeof parsed.at !== 'string' ||
    typeof parsed.pid !== 'number' ||
    typeof parsed.error !== 'string' ||
    typeof parsed.error_type !== 'string'
  ) {
    return undefined;
  }

  const at = Date.parse(parsed.at);
  if (!Number.isFinite(at) || at < sinceMs) return undefined;

  return {
    at: parsed.at,
    pid: parsed.pid,
    error: parsed.error,
    error_type: parsed.error_type,
    ...(typeof parsed.traceback === 'string' ? { traceback: parsed.traceback } : {}),
  };
}

function unlinkStateFile(env: NodeJS.ProcessEnv): void {
  try {
    unlinkSync(voiceWorkerStatePath(env));
  } catch {
    // Missing/already-gone is fine — this is best-effort cleanup of a stale file.
  }
}

/** Whether a PID is alive. Safe on Windows: libuv special-cases signal 0 in
 * uv_kill to a plain existence check (no signal is actually delivered), so
 * process.kill(pid, 0) works cross-platform here — unlike Python's
 * os.kill(pid, 0), which on Windows requires OpenProcess and throws
 * differently depending on privilege, not just existence. Do not change the
 * mechanism; this comment documents why the naive-looking call is correct. */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spawn options for the persistent worker: forces PYTHONIOENCODING (this
 * machine's documented encoding-corruption history — see CLAUDE.md — today
 * only the CLI/spawn-mode exec path got this) and redirects stderr to a log
 * file instead of discarding it, so a crashed worker leaves diagnostics
 * somewhere. Self-truncates the log at open time once it exceeds 1MiB —
 * bounded by the worker's own spawn lifecycle, not a recurring job. */
export function workerSpawnOptions(env: NodeJS.ProcessEnv): SpawnOptions {
  const logPath = voiceWorkerLogPath(env);
  let existingSize = 0;
  try {
    existingSize = statSync(logPath).size;
  } catch {
    // Missing log file — nothing to measure, append/create is fine.
  }
  const fd = openSync(logPath, existingSize > VOICE_WORKER_LOG_MAX_BYTES ? 'w' : 'a');

  return {
    env: { ...env, PYTHONIOENCODING: 'utf-8' },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'ignore', fd],
  };
}

function defaultSpawn(cmd: string, args: string[], env: NodeJS.ProcessEnv): void {
  const child = spawn(cmd, args, workerSpawnOptions(env));
  child.unref();
}

/** Connects to the worker on 127.0.0.1 — a hard-coded literal, never derived from the
 * state file (SSRF-shaped guard, plan D5). Writes one NDJSON line, reads one line back. */
function defaultConnect(port: number, payload: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => finish(() => reject(new VoiceWorkerTimeoutError('voice worker connection timed out'))));
    socket.once('error', (err) => finish(() => reject(err)));
    socket.once('connect', () => socket.write(payload + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        finish(() => resolve(line));
      }
    });

    socket.connect(port, '127.0.0.1');
  });
}

/** Pings the worker and classifies the result. `budgetMs`, when given, caps
 * this probe's own timeout to whatever remains of a larger deadline (used by
 * spawnAndWait's poll loop) — a budget that has already run out resolves
 * 'busy' without attempting a connection at all (also sidesteps Node's
 * `socket.setTimeout(0)` footgun, which means "no timeout", not "immediate
 * timeout"). */
export async function probeVoiceWorker(
  state: VoiceWorkerState,
  deps: VoiceWorkerClientDeps,
  budgetMs?: number,
): Promise<PingOutcome> {
  const defaultTimeoutMs = envIntMs(deps.env, 'PA_VOICE_WORKER_PING_TIMEOUT_MS', 5000);
  let timeoutMs = defaultTimeoutMs;
  if (budgetMs !== undefined) {
    if (budgetMs <= 0) return 'busy';
    timeoutMs = Math.min(budgetMs, defaultTimeoutMs);
  }

  const connect = deps.connectFn ?? defaultConnect;
  let raw: string;
  try {
    raw = await connect(state.port, JSON.stringify({ op: 'ping', token: state.token }), timeoutMs);
  } catch (err) {
    return err instanceof VoiceWorkerTimeoutError ? 'busy' : 'refused';
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'refused';
  }

  if (!parsed || parsed.ok !== true) return 'refused';
  if (parsed.protocol !== SUPPORTED_PROTOCOL) return 'bad-protocol';
  return 'ok';
}

export async function pingVoiceWorker(state: VoiceWorkerState, deps: VoiceWorkerClientDeps): Promise<boolean> {
  return (await probeVoiceWorker(state, deps)) === 'ok';
}

async function spawnAndWait(deps: VoiceWorkerClientDeps): Promise<VoiceWorkerState | null> {
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const python = resolvePythonCommand(deps.env);
  const script = voiceWorkerScriptPath(deps.env, deps.repoRoot);
  const now = deps.nowFn ?? Date.now;
  const spawnedAtMs = now();

  try {
    spawnFn(python, [script], deps.env);
  } catch (err) {
    console.error(`[voice-worker-client] failed to spawn voice worker: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const startTimeoutMs = envIntMs(deps.env, 'PA_VOICE_WORKER_START_TIMEOUT_MS', 60000);
  const sleep = deps.sleepFn ?? defaultSleep;
  const deadline = spawnedAtMs + startTimeoutMs;

  // Readiness polling via recursive awaited sleeps, never a repeating timer
  // — a repeating timer here would need a TIMER_ALLOWLIST entry this package
  // does not own (see CLAUDE.md's AI-100 timer-inventory gate). Real-deadline fix:
  // checks state BEFORE sleeping each round — an already-ready worker costs
  // 0ms, not one wasted poll interval — and clamps every probe's own budget
  // to whatever remains of the deadline, so a slow ping can never push total
  // elapsed time past startTimeoutMs (previously an attempt-count loop where
  // each iteration cost 250ms + up to a full ping timeout, unbounded by wall
  // clock — up to ~21 minutes against a nominal 60s timeout).
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) break;

    const candidate = readVoiceWorkerState(deps.env);
    if (candidate) {
      const outcome = await probeVoiceWorker(candidate, deps, deadline - now());
      if (outcome === 'ok') {
        console.log(`[voice-worker-client] spawned worker ready (port ${candidate.port}, pid ${candidate.pid})`);
        return candidate;
      }
    }

    const sleepRemaining = deadline - now();
    if (sleepRemaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, sleepRemaining));
  }

  const startFailure = readWorkerStartFailure(deps.env, spawnedAtMs);
  if (startFailure) {
    console.error(
      `[voice-worker-client] voice worker did not become ready within the start timeout (worker crashed: ${startFailure.error_type}: ${startFailure.error})`,
    );
  } else {
    console.error('[voice-worker-client] voice worker did not become ready within the start timeout');
  }
  return null;
}

export async function ensureVoiceWorker(deps: VoiceWorkerClientDeps): Promise<VoiceWorkerState | null> {
  const isPidAlive = deps.isPidAliveFn ?? defaultIsPidAlive;
  const existing = readVoiceWorkerState(deps.env);

  if (existing) {
    if (!isPidAlive(existing.pid)) {
      // Dead PID — no ping paid for it. Unlink and fall through to spawn.
      unlinkStateFile(deps.env);
      return spawnAndWait(deps);
    }

    const outcome = await probeVoiceWorker(existing, deps);
    if (outcome === 'ok') {
      console.log(`[voice-worker-client] using existing worker (port ${existing.port}, pid ${existing.pid})`);
      return existing;
    }
    if (outcome === 'busy') {
      // The actual fix: a ping TIMEOUT against a live PID means the worker
      // is busy transcribing something else, not dead. Return the existing
      // state — no unlink, no second worker spawned on top of it.
      console.log(`[voice-worker-client] existing worker busy (port ${existing.port}, pid ${existing.pid}) — reusing`);
      return existing;
    }
    // 'bad-protocol' or 'refused' (connection error, or a live-but-reused
    // PID whose listener doesn't answer) — the file is stale either way.
    unlinkStateFile(deps.env);
    return spawnAndWait(deps);
  }

  return spawnAndWait(deps);
}

export async function requestTranscription(req: VoiceWorkerRequest, deps: VoiceWorkerClientDeps): Promise<VoiceWorkerOutcome> {
  const state = await ensureVoiceWorker(deps);
  if (!state) {
    return { kind: 'unavailable', message: 'voice worker could not be started or reached' };
  }

  const connect = deps.connectFn ?? defaultConnect;
  const timeoutMs = envIntMs(deps.env, 'PA_VOICE_TRANSCRIBE_TIMEOUT_MS', 600000);
  const payload = JSON.stringify({ op: 'transcribe', token: state.token, ...req });

  // Never log the token or the payload — only non-secret identifiers.
  console.log(`[voice-worker-client] transcribe request (port ${state.port}, pid ${state.pid}, requestId ${req.request_id})`);

  let raw: string;
  try {
    raw = await connect(state.port, payload, timeoutMs);
  } catch (err) {
    // A ping-leg timeout resolves 'busy' inside ensureVoiceWorker/probeVoiceWorker
    // above and never reaches this catch — only the transcribe leg's own
    // timeout lands here, and it gets its own outcome kind rather than being
    // folded into 'unavailable', so the caller can message it accurately.
    if (err instanceof VoiceWorkerTimeoutError) {
      console.error(
        `[voice-worker-client] transcribe request timed out (port ${state.port}, pid ${state.pid}, requestId ${req.request_id})`,
      );
      return { kind: 'timeout', message: 'voice worker transcribe request timed out' };
    }
    console.error(
      `[voice-worker-client] transcribe request failed (port ${state.port}, pid ${state.pid}, requestId ${req.request_id}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: 'unavailable', message: 'voice worker request failed' };
  }

  let envelope: any;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { kind: 'unavailable', message: 'voice worker returned an unparseable response' };
  }

  if (
    typeof envelope?.request_id === 'string' &&
    typeof req.request_id === 'string' &&
    envelope.request_id !== req.request_id
  ) {
    console.error(
      `[voice-worker-client] transcribe response request_id mismatch (expected ${req.request_id}, got ${envelope.request_id})`,
    );
    return { kind: 'unavailable', message: 'voice worker returned a mismatched request_id' };
  }

  return { kind: 'envelope', envelope };
}
