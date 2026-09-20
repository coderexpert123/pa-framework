/**
 * Voice-inbox config (AI-201 WP-B): the `voice_inbox:` block of
 * `~/.pa/config.yaml` plus env overrides (§6).
 *
 * Required: `voice_inbox.inbox_topic` — the server refuses to start without
 * it, naming the key. Defaults: port 8787, session_ttl_hours 168 (7 days),
 * pairing_ttl_minutes 10, min_audio_bytes 8192 (AI-223 — a voice upload's
 * audio part under this size is rejected at POST /tasks with 400, no task
 * row, no event). The size/count cap knobs (max_upload_mb,
 * max_task_attachments, max_attachment_total_mb, max_text_chars) are
 * OPT-IN: unset, null, empty, or 0 all mean NO LIMIT (operator direction
 * 2026-09-13 — nothing is rejected or trimmed for size by default); an
 * explicit positive integer enforces exactly. Env wins over the file:
 * VOICE_INBOX_PORT, VOICE_INBOX_INBOX_TOPIC, VOICE_INBOX_MIN_AUDIO_BYTES.
 *
 * Also owns every runtime path under `~/.pa/voice-inbox/` (§1 layout) so the
 * server, tests and dev scripts resolve state from one place. `paHome()` is a
 * local copy of pa's paths.ts resolver (same PA_HOME contract) rather than an
 * import of the compiled pa/dist — this package's gates run in fresh
 * worktrees where pa/dist is not built.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/** `~/.pa`, honoring PA_HOME — the same contract pa's paths.ts implements. */
export function paHome(): string {
  return process.env.PA_HOME || join(homedir(), '.pa');
}

// --- Runtime state paths (§1: user runtime state lives under ~/.pa) ----------

export function voiceInboxDir(): string {
  return join(paHome(), 'voice-inbox');
}

export function ledgerPath(): string {
  return join(voiceInboxDir(), 'ledger.sqlite');
}

export function routeQueuePath(): string {
  return join(voiceInboxDir(), 'route-queue.jsonl');
}

export function pairingCodesPath(): string {
  return join(voiceInboxDir(), 'pairing-codes.json');
}

export function answersDir(): string {
  return join(voiceInboxDir(), 'answers');
}

export function filesDir(): string {
  return join(voiceInboxDir(), 'files');
}

/** Web Push subscriptions — SHARED with pa/src/lib/web-push.ts, which reads
 * and writes this exact same file (`~/.pa/voice-inbox/push-subscriptions.json`).
 * See web-push-store.ts's module doc for the compatibility contract. */
export function pushSubscriptionsPath(): string {
  return join(voiceInboxDir(), 'push-subscriptions.json');
}

/** VAPID key pair — SHARED with pa/src/lib/web-push.ts's `getOrCreateVapidKeys`
 * (`~/.pa/voice-inbox/vapid.json`); see web-push-store.ts's module doc. */
export function vapidKeysPath(): string {
  return join(voiceInboxDir(), 'vapid.json');
}

/** JSONL request log (one line per HTTP request; redacted path; 5MB rotation). */
export function requestLogPath(): string {
  return join(voiceInboxDir(), 'logs', 'requests.log');
}

/** Topic-name registry is shared bot state, not voice-inbox state. */
export function topicNamesPath(): string {
  return join(paHome(), 'telegram-topic-names.json');
}

// --- Config block ------------------------------------------------------------

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface VoiceInboxConfig {
  /** TCP port; binds 127.0.0.1 only (§6). */
  port: number;
  /** REQUIRED `<chatId>_<threadId>` key of the inbox topic (§6/§7). */
  inboxTopic: string;
  /** Multipart/attachment per-file upload cap, MB. Optional cap knob:
   * unset/0 = no limit (default); an explicit value enforces (1..1024). */
  maxUploadMb?: number;
  /** Bearer session TTL, hours (§6: 168 = 7 days). */
  sessionTtlHours: number;
  /** Pairing code TTL, minutes (§6: 10). */
  pairingTtlMinutes: number;
  /** AI-223: an audio upload part under this many bytes is rejected at
   * POST /tasks (400, no task row, no event) rather than being transcribed.
   * NOT a size cap — it stays defaulted (and stays disable-able via an
   * explicit 0) while the cap knobs around it went opt-in. Optional so an
   * existing hand-built `VoiceInboxConfig` test fixture that predates this
   * field keeps compiling unmodified — `loadConfig()` always populates a
   * real value, and the one runtime reader (routes.ts) falls back to
   * `CONFIG_DEFAULTS.minAudioBytes` when a fixture omits it. */
  minAudioBytes?: number;
  /** Task attachments: max count per POST /tasks. Optional cap knob:
   * unset/0 = no limit (default); an explicit value enforces (1..100). */
  maxTaskAttachments?: number;
  /** Task attachments: max TOTAL bytes across all files parts, MB. Optional
   * cap knob: unset/0 = no limit (default); an explicit value enforces
   * (1..1024). */
  maxAttachmentTotalMb?: number;
  /** Typed text cap, chars, on POST /tasks (both JSON and multipart text
   * parts). Optional cap knob: unset/0 = no limit (default); an explicit
   * value enforces (1..1_000_000). Replaces the old hardcoded 4000. */
  maxTextChars?: number;
  /** AI-246: shared secret the screencast bridge sends as Bearer on the frame
   * ingest (POST /api/v1/live/:taskId/frame) and clear (DELETE
   * /api/v1/live/:taskId) routes — PA injects the same value into the worker
   * env as PA_SCREENCAST_INGEST_TOKEN. Optional: unset = screencast disabled
   * (the ingest/clear routes answer 503). Env override
   * VOICE_INBOX_SCREENCAST_INGEST_TOKEN. */
  screencastIngestToken?: string;
  /** AI-246: live-frame freshness window, seconds (default 30; 5..300).
   * Optional for the same fixture-compat reason as minAudioBytes —
   * loadConfig always populates it. */
  screencastFrameTtlSeconds?: number;
  /** AI-246: per-frame byte cap on ingest (default 512*1024; 64KB..2MB).
   * Same optional-for-fixtures contract as screencastFrameTtlSeconds. */
  screencastMaxFrameBytes?: number;
  /** AI-246 v2: operator input injection (the intervention half) — an
   * in-memory per-task command queue the bridge long-polls. Optional same
   * as above; `false` disables BOTH input endpoints (POST 503, GET 503)
   * while the watch-only frame path keeps working. Default true. */
  screencastInputEnabled?: boolean;
  /** AI-246 v2: per-task queued-command cap (default 64; 1..4096). Overflow
   * drops the OLDEST command — the queue never rejects for fullness. */
  screencastInputMaxQueue?: number;
  /** AI-246 v2: `type`-command text cap, chars (default 4096; 1..65536). */
  screencastInputMaxText?: number;
  /** AI-246 v2: `navigate`-command url cap, chars (default 2048; 1..65536). */
  screencastInputMaxUrl?: number;
  /** AI-246 v2: max POSTed commands per task inside a sliding 1 s window
   * (default 20; 1..1000); over-budget POSTs answer 413. */
  screencastInputRatePerSec?: number;
}

export const CONFIG_DEFAULTS: Required<
  Pick<VoiceInboxConfig, 'port' | 'sessionTtlHours' | 'pairingTtlMinutes' | 'minAudioBytes' | 'screencastFrameTtlSeconds' | 'screencastMaxFrameBytes' | 'screencastInputEnabled' | 'screencastInputMaxQueue' | 'screencastInputMaxText' | 'screencastInputMaxUrl' | 'screencastInputRatePerSec'>
> = {
  port: 8787,
  sessionTtlHours: 168,
  pairingTtlMinutes: 10,
  minAudioBytes: 8192,
  screencastFrameTtlSeconds: 30,
  screencastMaxFrameBytes: 512 * 1024,
  screencastInputEnabled: true,
  screencastInputMaxQueue: 64,
  screencastInputMaxText: 4096,
  screencastInputMaxUrl: 2048,
  screencastInputRatePerSec: 20,
};

function intField(
  block: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = block[key];
  if (raw === undefined) return fallback;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(
      `config error: voice_inbox.${key} must be an integer ${min}..${max}, got ${JSON.stringify(raw)}`
    );
  }
  return n;
}

/**
 * AI-246 v2 input knobs: DEFENSIVE variant of intField — a malformed value
 * (non-numeric) is IGNORED in favor of the fallback, and an in-shape but
 * out-of-range value is CLAMPED into min..max, rather than throwing. The
 * input endpoints must survive a hand-edited config file: a fat-fingered
 * bound can never keep the whole server down.
 */
function clampedIntField(
  block: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = block[key];
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Same defensive contract as clampedIntField, for booleans: accepts real
 * booleans plus the usual string spellings; anything else falls back. */
function boolField(
  block: Record<string, unknown>,
  key: string,
  fallback: boolean
): boolean {
  const raw = block[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return fallback;
}

/**
 * Optional cap knob (2026-09-13 uncapped-create): absent, null, an empty or
 * whitespace-only string, or an explicit 0 all resolve to undefined = NO
 * LIMIT — never a zero limit. An explicit integer in min..max enforces
 * exactly. Anything else throws ConfigError with the same message shape as
 * intField. The 0 check comes BEFORE the range check so "explicit off" works
 * even when min > 0.
 */
function capField(
  block: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number | undefined {
  const raw = block[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string' && raw.trim() === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (Number.isInteger(n) && n === 0) return undefined;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(
      `config error: voice_inbox.${key} must be an integer ${min}..${max}, got ${JSON.stringify(raw)}`
    );
  }
  return n;
}

/**
 * Load and validate the `voice_inbox:` config block. Throws ConfigError,
 * naming the key, when `inbox_topic` is missing (neither the config file nor
 * VOICE_INBOX_INBOX_TOPIC supplies it) or any value is out of range. A
 * missing config file behaves like an empty block — the required-key error is
 * the same.
 */
export function loadConfig(
  configFilePath: string = join(paHome(), 'config.yaml'),
  env: NodeJS.ProcessEnv = process.env
): VoiceInboxConfig {
  let block: Record<string, unknown> = {};
  let raw: string | undefined;
  try {
    raw = readFileSync(configFilePath, 'utf8');
  } catch {
    raw = undefined; // absent file → empty block; the required-key check below reports it
  }
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (e) {
      throw new ConfigError(
        `config error: ${configFilePath} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const candidate = (parsed as Record<string, unknown>)['voice_inbox'];
      if (candidate !== undefined && candidate !== null) {
        if (typeof candidate !== 'object' || Array.isArray(candidate)) {
          throw new ConfigError('config error: voice_inbox must be a mapping block');
        }
        block = candidate as Record<string, unknown>;
      }
    }
  }

  // Env overrides win over the file (§6).
  const envPort = env.VOICE_INBOX_PORT?.trim();
  const envTopic = env.VOICE_INBOX_INBOX_TOPIC?.trim();
  const envMinAudioBytes = env.VOICE_INBOX_MIN_AUDIO_BYTES?.trim();
  const envIngestToken = env.VOICE_INBOX_SCREENCAST_INGEST_TOKEN?.trim();
  const envInputEnabled = env.VOICE_INBOX_SCREENCAST_INPUT_ENABLED?.trim();
  const envInputMaxQueue = env.VOICE_INBOX_SCREENCAST_INPUT_MAX_QUEUE?.trim();
  const envInputMaxText = env.VOICE_INBOX_SCREENCAST_INPUT_MAX_TEXT?.trim();
  const envInputMaxUrl = env.VOICE_INBOX_SCREENCAST_INPUT_MAX_URL?.trim();
  const envInputRate = env.VOICE_INBOX_SCREENCAST_INPUT_RATE_PER_SEC?.trim();

  const port = envPort
    ? intField({ port: envPort }, 'port', CONFIG_DEFAULTS.port, 1, 65535)
    : intField(block, 'port', CONFIG_DEFAULTS.port, 1, 65535);

  const inboxTopic = envTopic || (typeof block['inbox_topic'] === 'string' ? (block['inbox_topic'] as string).trim() : '');
  if (!inboxTopic) {
    throw new ConfigError(
      'config error: voice_inbox.inbox_topic is required — set it to the inbox topic key ' +
        '"<chatId>_<threadId>" in ~/.pa/config.yaml (or env VOICE_INBOX_INBOX_TOPIC); the server refuses to start without it'
    );
  }
  if (!/^-?\d+_\d+$/.test(inboxTopic)) {
    throw new ConfigError(
      `config error: voice_inbox.inbox_topic must look like "<chatId>_<threadId>", got "${inboxTopic}"`
    );
  }

  // AI-246: the ingest token is a plain shared secret (not a cap/int knob) —
  // env wins, then the yaml key; an absent/blank/non-string value leaves it
  // unset, which disables the screencast routes (503).
  const fileIngestToken = block['screencast_ingest_token'];
  const screencastIngestToken =
    envIngestToken !== undefined && envIngestToken !== ''
      ? envIngestToken
      : typeof fileIngestToken === 'string' && fileIngestToken.trim() !== ''
        ? fileIngestToken.trim()
        : undefined;

  return {
    port,
    inboxTopic,
    maxUploadMb: capField(block, 'max_upload_mb', 1, 1024),
    sessionTtlHours: intField(block, 'session_ttl_hours', CONFIG_DEFAULTS.sessionTtlHours, 1, 24 * 365),
    pairingTtlMinutes: intField(block, 'pairing_ttl_minutes', CONFIG_DEFAULTS.pairingTtlMinutes, 1, 60 * 24),
    minAudioBytes: envMinAudioBytes
      ? intField({ min_audio_bytes: envMinAudioBytes }, 'min_audio_bytes', CONFIG_DEFAULTS.minAudioBytes, 0, 100_000_000)
      : intField(block, 'min_audio_bytes', CONFIG_DEFAULTS.minAudioBytes, 0, 100_000_000),
    maxTaskAttachments: capField(block, 'max_task_attachments', 1, 100),
    maxAttachmentTotalMb: capField(block, 'max_attachment_total_mb', 1, 1024),
    maxTextChars: capField(block, 'max_text_chars', 1, 1_000_000),
    screencastIngestToken,
    screencastFrameTtlSeconds: intField(block, 'screencast_frame_ttl_seconds', CONFIG_DEFAULTS.screencastFrameTtlSeconds, 5, 300),
    screencastMaxFrameBytes: intField(block, 'screencast_max_frame_bytes', CONFIG_DEFAULTS.screencastMaxFrameBytes, 64 * 1024, 2 * 1024 * 1024),
    // AI-246 v2 input knobs: env wins (parsed through the same tolerant
    // helpers), then the yaml key; malformed → default, out-of-range →
    // clamped. An empty-string env behaves like an absent one (the tolerant
    // parse falls back either way).
    screencastInputEnabled: boolField(
      envInputEnabled !== undefined && envInputEnabled !== '' ? { screencast_input_enabled: envInputEnabled } : block,
      'screencast_input_enabled',
      CONFIG_DEFAULTS.screencastInputEnabled
    ),
    screencastInputMaxQueue: clampedIntField(
      envInputMaxQueue !== undefined && envInputMaxQueue !== '' ? { screencast_input_max_queue: envInputMaxQueue } : block,
      'screencast_input_max_queue',
      CONFIG_DEFAULTS.screencastInputMaxQueue,
      1,
      4096
    ),
    screencastInputMaxText: clampedIntField(
      envInputMaxText !== undefined && envInputMaxText !== '' ? { screencast_input_max_text: envInputMaxText } : block,
      'screencast_input_max_text',
      CONFIG_DEFAULTS.screencastInputMaxText,
      1,
      65_536
    ),
    screencastInputMaxUrl: clampedIntField(
      envInputMaxUrl !== undefined && envInputMaxUrl !== '' ? { screencast_input_max_url: envInputMaxUrl } : block,
      'screencast_input_max_url',
      CONFIG_DEFAULTS.screencastInputMaxUrl,
      1,
      65_536
    ),
    screencastInputRatePerSec: clampedIntField(
      envInputRate !== undefined && envInputRate !== '' ? { screencast_input_rate_per_sec: envInputRate } : block,
      'screencast_input_rate_per_sec',
      CONFIG_DEFAULTS.screencastInputRatePerSec,
      1,
      1000
    ),
  };
}

/** Split a `<chatId>_<threadId>` topic key, validating both halves. */
export function splitTopicKey(key: string): { chatId: number; threadId: number } | undefined {
  const match = /^(-?\d+)_(\d+)$/.exec(key);
  if (!match) return undefined;
  return { chatId: Number(match[1]), threadId: Number(match[2]) };
}
