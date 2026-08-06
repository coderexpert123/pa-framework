/**
 * Bot-side voice module (plan: plans/2026-08-04-telegram-voice-transcription.md, WP5;
 * hardened plan: "federated-booping-hammock" (Claude Code plan-mode session), WP4).
 *
 * Downloads a Telegram voice/audio/video-note attachment, hands it to the Python
 * transcription bridge (spawn mode) or the persistent voice worker (persistent
 * mode, via voice-worker-client.ts), and returns a VoiceResult the caller (WP6's
 * main.ts wiring) turns into either dispatched text or a user-facing error
 * message. Fully injectable and never throws — see transcribeVoiceMessage.
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { readdir } from 'fs/promises';
import { dirname, join } from 'path';
import { downloadFile, sendTyping } from './telegram.js';
import {
  requestTranscription,
  type VoiceWorkerRequest,
  type VoiceWorkerClientDeps,
  type VoiceWorkerOutcome,
} from './voice-worker-client.js';
import { resolvePythonCommand } from '../../../pa/dist/src/lib/python.js';
import { paHome } from '../../../pa/dist/src/paths.js';
import { toIST, todayIST } from '../../../pa/dist/src/ist.js';
import { resolveTranscriptionConfig } from '../../../pa/dist/src/config.js';
import type { TranscriptionConfig } from '../../../pa/dist/src/types.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { VOICE_ATTACHMENT_FILE_RE } from '../../../pa/dist/src/lib/maintenance/jobs/voice-attachment-gc.js';

export type AudioAttachmentKind = 'voice' | 'audio' | 'video_note';

export interface TelegramAudioLike {
  file_id: string;
  file_unique_id: string;
  duration: number; // seconds, per Bot API
  mime_type?: string;
  file_size?: number;
  file_name?: string; // present on Telegram's `audio` attachments only
}

// Rename-free: existing call sites/tests keep using TelegramVoice, which is
// now just the generic media shape under a legacy name.
export type TelegramVoice = TelegramAudioLike;

/** Duck-typed subset of TelegramMessage — deliberately NOT imported from
 * types.ts (owned by WP6, which adds `audio`/`video_note` there). A real
 * TelegramMessage satisfies this structurally once those fields land. */
export interface TelegramAudioMessageLike {
  voice?: TelegramAudioLike;
  audio?: TelegramAudioLike;
  video_note?: TelegramAudioLike;
}

export interface AudioAttachment {
  kind: AudioAttachmentKind;
  media: TelegramAudioLike;
}

/** Precedence: voice > audio > video_note (a message can only carry one of
 * these per the Bot API, but the precedence keeps this well-defined even
 * against a hand-built/fuzzed update). */
export function extractAudioAttachment(msg: TelegramAudioMessageLike): AudioAttachment | undefined {
  if (msg.voice) return { kind: 'voice', media: msg.voice };
  if (msg.audio) return { kind: 'audio', media: msg.audio };
  if (msg.video_note) return { kind: 'video_note', media: msg.video_note };
  return undefined;
}

export type VoiceFailureReason =
  | 'too-long'
  | 'too-large'
  | 'download-failed'
  | 'transcribe-failed'
  | 'empty-transcript'
  | 'timeout'
  | 'no-engine'
  | 'cloud-auth'
  | 'ffmpeg-missing';

export type VoiceResult =
  | {
      ok: true;
      text: string;
      engine: string;
      mode: 'spawn' | 'persistent';
      fallback?: string;
      audioPath: string;
      elapsedMs: number;
      truncated: boolean;
      speakers?: number;
    }
  | { ok: false; reason: VoiceFailureReason; message: string; audioPath?: string };

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export interface VoiceDeps {
  repoRoot: string; // BOT_CWD from main.ts
  env: NodeJS.ProcessEnv; // runtimeEnv = { ...process.env, ...secrets }
  transcription?: Partial<TranscriptionConfig>; // config.transcription from main.ts
  downloadFileFn?: typeof downloadFile;
  sendTypingFn?: (token: string, chatId: number, threadId?: number) => Promise<void>;
  execFn?: (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecResult>;
  persistentFn?: (req: VoiceWorkerRequest, deps: VoiceWorkerClientDeps) => Promise<VoiceWorkerOutcome>;
  now?: () => Date;
  threadId?: number;
  /** Overrides the engine passed to the bridge/worker (`--engine` / the
   * persistent request's `engine` field) instead of 'auto'. Used by
   * `/retranscribe <engine>` (WP5). */
  engineOverride?: string;
  /** When set, skip download entirely and transcribe this on-disk file
   * directly — the re-transcribe path (WP5's findCachedAudio hit). */
  cachedPath?: string;
}

export const VOICE_TYPING_INTERVAL_MS = 4000;

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function voiceMaxDurationS(env: NodeJS.ProcessEnv): number {
  return envInt(env, 'PA_VOICE_MAX_DURATION_S', 1800);
}

export function voiceTimeoutMs(env: NodeJS.ProcessEnv): number {
  return envInt(env, 'PA_VOICE_TRANSCRIBE_TIMEOUT_MS', 600000);
}

/** Refuse an attachment above this many bytes before downloading it — default
 * 20 MiB matches Telegram's own bot-download ceiling. */
export function voiceMaxFileBytes(env: NodeJS.ProcessEnv): number {
  return envInt(env, 'PA_VOICE_MAX_FILE_BYTES', 20 * 1024 * 1024);
}

export function voiceScriptPath(env: NodeJS.ProcessEnv, repoRoot: string): string {
  const override = env.PA_VOICE_TRANSCRIBE_SCRIPT?.trim();
  if (override) return override;
  return join(repoRoot, 'pa', 'scripts', 'transcribe_voice.py');
}

function istDateString(date: Date): string {
  const ist = toIST(date);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function voiceAttachmentPath(chatId: number, fileUniqueId: string, now?: Date, ext: string = 'oga'): string {
  // Defensive path-traversal guard on an API-supplied string — cheap and
  // non-negotiable, even though Telegram file_unique_ids are not attacker
  // chosen in the ordinary sense.
  const sanitized = fileUniqueId.replace(/[^A-Za-z0-9_-]/g, '_');
  const dateStr = now ? istDateString(now) : todayIST();
  // Negative chatId (supergroups) is fine as a directory name — do not strip
  // the sign, it distinguishes chats (CLAUDE.md's multi-chat note).
  return join(paHome(), 'attachments', String(chatId), dateStr, `${sanitized}.${ext}`);
}

// Kind-fixed extensions come straight from the Bot API shape (a voice note is
// always Ogg/Opus, a video note is always mp4); only `audio` attachments need
// derivation. Must stay in lockstep with voice-attachment-gc.ts's
// VOICE_ATTACHMENT_FILE_RE (WP8) — the drift-guard test below asserts this.
const AUDIO_MIME_EXT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
};

const KNOWN_AUDIO_FILE_EXTS = new Set(Object.values(AUDIO_MIME_EXT));

/** Derives the on-disk extension for an attachment: fixed for voice/video_note,
 * derived from file_name (preferred) or mime_type (fallback) for audio, else
 * the generic 'bin' escape hatch — which deliberately does NOT match WP8's
 * retention regex (an attachment of a genuinely unrecognized type is rare
 * enough that leaving it out of automatic GC is an acceptable trade for never
 * mis-typing a real format). */
export function extensionForAttachment(kind: AudioAttachmentKind, media: TelegramAudioLike): string {
  if (kind === 'voice') return 'oga';
  if (kind === 'video_note') return 'mp4';

  const fileName = media.file_name;
  if (fileName) {
    const match = /\.([A-Za-z0-9]+)$/.exec(fileName);
    if (match) {
      const candidate = match[1].toLowerCase();
      if (KNOWN_AUDIO_FILE_EXTS.has(candidate)) return candidate;
    }
  }

  const mime = media.mime_type?.toLowerCase();
  if (mime && AUDIO_MIME_EXT[mime]) return AUDIO_MIME_EXT[mime];

  return 'bin';
}

/** Scans the existing attachment cache (bounded to the ~31 most recent dated
 * directories under this chat) for a file whose sanitized stem matches
 * fileUniqueId — works for both successful AND failed notes, since a failed
 * note's audio is still written to disk before transcription is attempted.
 * Used by `/retranscribe` (WP5) to skip re-downloading. */
export async function findCachedAudio(chatId: number, fileUniqueId: string): Promise<string | undefined> {
  const sanitized = fileUniqueId.replace(/[^A-Za-z0-9_-]/g, '_');
  const root = join(paHome(), 'attachments', String(chatId));

  let dateDirs: string[];
  try {
    dateDirs = await readdir(root);
  } catch {
    return undefined;
  }

  const sorted = dateDirs.sort().reverse().slice(0, 31);

  for (const dateDir of sorted) {
    const datePath = join(root, dateDir);
    let files: string[];
    try {
      files = await readdir(datePath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!VOICE_ATTACHMENT_FILE_RE.test(file)) continue;
      const dot = file.lastIndexOf('.');
      const stem = dot === -1 ? file : file.slice(0, dot);
      if (stem === sanitized) {
        return join(datePath, file);
      }
    }
  }

  return undefined;
}

export function buildBridgeArgs(
  scriptPath: string,
  audioPath: string,
  cfg: TranscriptionConfig,
  maxChars?: number,
  engineOverride?: string
): string[] {
  const args = [
    scriptPath,
    audioPath,
    '--engine',
    engineOverride ?? 'auto',
    '--engine-preference',
    cfg.engine_preference,
    '--cloud-order',
    cfg.cloud_order.join(','),
  ];
  if (cfg.language) {
    args.push('--language', cfg.language);
  }
  if (maxChars !== undefined) {
    args.push('--max-chars', String(maxChars));
  }
  return args;
}

export function parseVoiceEnvelope(stdout: string): { ok: boolean; [k: string]: any } | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  try {
    const parsed = JSON.parse(last);
    if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function reasonForErrorCode(code: string | undefined): VoiceFailureReason {
  switch (code) {
    case 'no-engine':
      return 'no-engine';
    case 'cloud-auth':
      return 'cloud-auth';
    case 'ffmpeg-missing':
      return 'ffmpeg-missing';
    default:
      return 'transcribe-failed';
  }
}

const TRUNCATION_SUFFIX =
  '\n\n[Note: this transcript was cut off at the length limit. If you said more, please continue in a follow-up message.]';

const KIND_LABEL: Record<AudioAttachmentKind, string> = {
  voice: 'Voice message',
  audio: 'Audio file',
  video_note: 'Video note',
};

function sanitizeCaption(caption: string): string {
  return caption.replace(/\s+/g, ' ').trim().replace(/"/g, "'");
}

export interface FormatTranscriptOptions {
  truncated?: boolean;
  caption?: string;
  kind?: AudioAttachmentKind;
  fileName?: string;
  speakers?: number;
  forwardedFrom?: string;
}

/** Replaces formatVoiceUserText (deleted, not shimmed). With no options set
 * the output is BYTE-IDENTICAL to the historical "[Voice message] <text>" —
 * docs/BOT_GUIDE.md documents that exact string to users; see the dedicated
 * hard-gate test in voice.test.ts. */
export function formatTranscriptUserText(transcript: string, opts: FormatTranscriptOptions = {}): string {
  const kind = opts.kind ?? 'voice';
  let descriptor = kind === 'audio' && opts.fileName ? `${KIND_LABEL.audio}: ${opts.fileName}` : KIND_LABEL[kind];

  if (opts.forwardedFrom) {
    descriptor += `, forwarded from ${opts.forwardedFrom}`;
  }
  if (opts.speakers !== undefined && opts.speakers > 1) {
    descriptor += `, ${opts.speakers} speakers`;
  }
  if (opts.caption) {
    const sanitized = sanitizeCaption(opts.caption);
    if (sanitized) {
      descriptor += `, caption: "${sanitized}"`;
    }
  }

  const base = `[${descriptor}] ${transcript.trim()}`;
  return opts.truncated === true ? base + TRUNCATION_SUFFIX : base;
}

const FAILURE_PHRASE: Record<VoiceFailureReason, string> = {
  'too-long': 'the note was longer than the length limit',
  'too-large': 'the file was larger than the size limit',
  'download-failed': 'the file could not be downloaded from Telegram',
  'transcribe-failed': 'transcription failed',
  'empty-transcript': 'no speech was detected',
  timeout: 'timed out while transcribing',
  'no-engine': 'no transcription engine is configured',
  'cloud-auth': 'the transcription service rejected the API key',
  'ffmpeg-missing': 'ffmpeg is not installed',
};

/** New export for WP6's failed-note archival: a fixed phrase per reason, with
 * no free-form provider text in the archived turn. */
export function formatFailedTranscriptUserText(
  kind: AudioAttachmentKind,
  reason: VoiceFailureReason,
  opts: { caption?: string } = {}
): string {
  let descriptor = `${KIND_LABEL[kind]} — transcription failed: ${FAILURE_PHRASE[reason]}`;
  if (opts.caption) {
    const sanitized = sanitizeCaption(opts.caption);
    if (sanitized) {
      descriptor += `, caption: "${sanitized}"`;
    }
  }
  return `[${descriptor}]`;
}

// User-facing messages, fixed verbatim (plan D10). Plain Markdown only —
// lib/mdv2.ts does the escaping (CLAUDE.md forbids manual backslashes). These
// three are purpose-built and never truncated; only `transcribe-failed`
// truncates its forwarded diagnostic text.
const NO_ENGINE_MESSAGE = `🎙 I got your voice note, but no transcription engine is set up yet.

Quickest fix, about a minute: get a free key at https://console.groq.com/keys, add \`GROQ_API_KEY=<your key>\` to \`~/.pa/secrets.env\`, then run \`pa bot restart\`. Voice notes then transcribe in a few seconds.

Prefer fully offline? See docs/TROUBLESHOOTING.md, "No transcription engine is set up yet".`;

const CLOUD_AUTH_MESSAGE =
  '🎙 The transcription service rejected the API key. Check the matching `*_API_KEY` line in `~/.pa/secrets.env` — it may be mistyped, expired, or out of quota — then run `pa bot restart`.';

const FFMPEG_MISSING_MESSAGE =
  '🎙 Local transcription needs `ffmpeg` on PATH and I could not find it. Install it (`choco install ffmpeg`, `brew install ffmpeg`, or `apt install ffmpeg`), or set `GROQ_API_KEY` in `~/.pa/secrets.env` to use the cloud engine, which needs no ffmpeg.';

const DOWNLOAD_FAILED_MESSAGE = `🎙 I couldn't download that voice note from Telegram. Please try sending it again.`;

const TIMEOUT_MESSAGE =
  '🎙 Transcribing that voice note took too long and was cancelled. Local transcription can take several minutes per note. Setting `GROQ_API_KEY` in `~/.pa/secrets.env`, or `transcription.worker_mode: persistent` in `~/.pa/config.yaml`, makes this much faster — see docs/TROUBLESHOOTING.md.';

const EMPTY_TRANSCRIPT_MESSAGE = `🎙 I couldn't make out any speech in that voice note. Please try again, or type your message.`;

// Only meaningful when a retry could plausibly succeed: transcribe-failed,
// timeout, and empty-transcript are all "try the same audio again" failures.
// no-engine/cloud-auth/ffmpeg-missing need a config change first, and
// too-long/too-large/download-failed have no cached audio worth retrying.
const RETRANSCRIBE_HINT = ' Reply with `/retranscribe` to try again.';

export function voiceErrorMessage(result: Extract<VoiceResult, { ok: false }>): string {
  const hint = result.audioPath ? RETRANSCRIBE_HINT : '';
  switch (result.reason) {
    case 'no-engine':
      return NO_ENGINE_MESSAGE;
    case 'cloud-auth':
      return CLOUD_AUTH_MESSAGE;
    case 'ffmpeg-missing':
      return FFMPEG_MISSING_MESSAGE;
    case 'download-failed':
      return DOWNLOAD_FAILED_MESSAGE;
    case 'timeout':
      return TIMEOUT_MESSAGE + hint;
    case 'empty-transcript':
      return EMPTY_TRANSCRIPT_MESSAGE + hint;
    case 'too-long':
    case 'too-large':
      // The builder (transcribeVoiceMessage) already composed the full
      // sentence with the real duration/size/cap numbers baked in.
      return result.message;
    case 'transcribe-failed':
    default: {
      const truncated = result.message.length > 300 ? result.message.slice(0, 300) : result.message;
      return `🎙 Transcription failed: ${truncated}` + hint;
    }
  }
}

const execFileAsync = promisify(execFileCb);

async function defaultExec(
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<ExecResult> {
  // This machine has a documented history of encoding corruption — force
  // PYTHONIOENCODING regardless of what the caller's env already has.
  const env = { ...opts.env, PYTHONIOENCODING: 'utf-8' };
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      env,
      timeout: opts.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { stdout, stderr, code: 0, timedOut: false };
  } catch (err: any) {
    const timedOut = err?.killed === true || err?.signal === 'SIGTERM';
    return {
      stdout: typeof err?.stdout === 'string' ? err.stdout : '',
      stderr: typeof err?.stderr === 'string' ? err.stderr : String(err?.message ?? err),
      code: typeof err?.code === 'number' ? err.code : null,
      timedOut,
    };
  }
}

function fail(reason: VoiceFailureReason, message: string, audioPath: string | undefined, errorCode?: string): VoiceResult {
  logger.warn('voice', 'voice transcription failed', { reason, errorCode, audioPath });
  return { ok: false, reason, message, audioPath };
}

// Logged once per process, not per note — a persistent worker skipped in
// favor of a cloud engine is a standing deployment fact, not a per-message
// event worth repeating on every voice note.
let loggedPersistentSkip = false;

const ENGLISH_LANGUAGE_PATTERN = /^en(-|$)/i;

/** Stripped, non-blank API key check for `provider` — mirrors
 * transcribe_voice.py's `_key_for` (WP1) so both sides agree on what counts
 * as "configured". */
const CLOUD_KEY_ENV_VAR: Record<string, string> = {
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
};

export function configuredCloudProviders(env: NodeJS.ProcessEnv, cloudOrder: string[]): string[] {
  return cloudOrder.filter((provider) => {
    const varName = CLOUD_KEY_ENV_VAR[provider];
    if (!varName) return false;
    const raw = env[varName];
    return typeof raw === 'string' && raw.trim().length > 0;
  });
}

/** True iff `whisper_local` leads the resolved plan — the ONLY case where
 * persistent mode is worth its worker-spawn cost, since cloud calls have no
 * model to load and nothing for a resident process to amortise
 * (pa/src/types.ts's TranscriptionConfig doc comment). 5-row table:
 *   engine_preference='local'          -> always true
 *   engine_preference='auto', no key   -> true  (local leads)
 *   engine_preference='auto', has key  -> false (cloud leads)
 *   engine_preference='cloud', no key  -> false (never uses local either way)
 *   engine_preference='cloud', has key -> false
 */
export function persistentModeApplies(cfg: TranscriptionConfig, env: NodeJS.ProcessEnv): boolean {
  if (cfg.engine_preference === 'cloud') return false;
  if (cfg.engine_preference === 'local') return true;
  return configuredCloudProviders(env, cfg.cloud_order).length === 0;
}

export async function transcribeVoiceMessage(
  token: string,
  chatId: number,
  media: TelegramAudioLike,
  deps: VoiceDeps,
  kind: AudioAttachmentKind = 'voice'
): Promise<VoiceResult> {
  try {
    const cfg = resolveTranscriptionConfig(deps.transcription);

    // b. Duration guard — before any download.
    const cap = voiceMaxDurationS(deps.env);
    if (media.duration > cap) {
      return fail(
        'too-long',
        `🎙 That voice note is ${media.duration}s — longer than the ${cap}s limit for transcription. Please send a shorter one or type your message.`,
        undefined
      );
    }

    // Size guard — also before any download, using the Bot API's own
    // declared file_size (never trusted beyond this comparison).
    const maxBytes = voiceMaxFileBytes(deps.env);
    if (media.file_size !== undefined && media.file_size > maxBytes) {
      return fail(
        'too-large',
        `🎙 That file is ${media.file_size} bytes — larger than the ${maxBytes}-byte limit for transcription. Please send a smaller one or type your message.`,
        undefined
      );
    }

    let dest: string;
    if (deps.cachedPath) {
      dest = deps.cachedPath;
    } else {
      const ext = extensionForAttachment(kind, media);
      dest = voiceAttachmentPath(chatId, media.file_unique_id, deps.now ? deps.now() : undefined, ext);
      // downloadFile does not create the parent directory itself — required.
      mkdirSync(dirname(dest), { recursive: true });

      const downloadFileFn = deps.downloadFileFn ?? downloadFile;
      const downloaded = await downloadFileFn(token, media.file_id, dest);
      if (!downloaded) {
        return fail('download-failed', 'downloadFile returned false', dest);
      }
    }

    const sendTypingFn = deps.sendTypingFn ?? sendTyping;
    const startedAt = Date.now();
    let typingTimer: ReturnType<typeof setInterval> | undefined;

    try {
      sendTypingFn(token, chatId, deps.threadId).catch(() => {});
      typingTimer = setInterval(() => {
        sendTypingFn(token, chatId, deps.threadId).catch(() => {});
      }, VOICE_TYPING_INTERVAL_MS);

      const timeoutMs = voiceTimeoutMs(deps.env);

      let envelope: Record<string, any> | null = null;
      let mode: 'spawn' | 'persistent' = 'spawn';
      let fallback: string | undefined;

      if (cfg.worker_mode === 'persistent' && persistentModeApplies(cfg, deps.env)) {
        const persistentFn = deps.persistentFn ?? requestTranscription;
        const req: VoiceWorkerRequest = {
          audio_path: dest,
          engine: deps.engineOverride ?? 'auto',
          engine_preference: cfg.engine_preference,
          cloud_order: cfg.cloud_order,
          language: cfg.language ?? null,
          // max_chars deliberately omitted — see VoiceWorkerRequest's own
          // comment (voice-worker-client.ts, D11): the Python-side
          // DEFAULT_MAX_CHARS constant is the single source of truth.
          request_id: randomUUID(),
        };

        let outcome: VoiceWorkerOutcome;
        try {
          outcome = await persistentFn(req, { repoRoot: deps.repoRoot, env: deps.env });
        } catch (err) {
          // voice-worker-client.ts's own internals were hardened to never
          // throw, but a throw here (an injected persistentFn in tests, or
          // an unforeseen failure mode) must still fall through to spawn
          // rather than failing the note outright.
          outcome = { kind: 'unavailable', message: err instanceof Error ? err.message : String(err) };
        }

        if (outcome.kind === 'envelope') {
          envelope = outcome.envelope;
          mode = 'persistent';
        } else if (outcome.kind === 'timeout') {
          // The transcribe leg itself timed out — this already cost the full
          // timeout budget; falling through to a spawned re-attempt would
          // double the wait for a note that's already unlikely to succeed.
          logger.warn('voice', 'persistent worker transcribe request timed out', { chatId, message: outcome.message });
          return fail('timeout', outcome.message, dest);
        } else {
          // D4's one permitted, one-directional error fallback: the worker
          // could not be reached or started. This note falls back to a
          // spawned subprocess; a genuine transcription failure (an
          // 'envelope' outcome with ok:false) is NOT retried here.
          logger.warn('voice', 'persistent worker unavailable, falling back to spawn', {
            chatId,
            message: outcome.message,
          });
          fallback = 'persistent-unavailable';
        }
      } else if (cfg.worker_mode === 'persistent' && !loggedPersistentSkip) {
        loggedPersistentSkip = true;
        logger.info(
          'voice',
          'persistent worker_mode configured but skipped: a cloud engine leads the resolved plan, so there is no local model to keep resident',
          { enginePreference: cfg.engine_preference }
        );
      }

      if (envelope === null) {
        const execFn = deps.execFn ?? defaultExec;
        const scriptPath = voiceScriptPath(deps.env, deps.repoRoot);
        const args = buildBridgeArgs(scriptPath, dest, cfg, undefined, deps.engineOverride);
        const execResult = await execFn(resolvePythonCommand(deps.env), args, { env: deps.env, timeoutMs });

        if (execResult.timedOut) {
          return fail('timeout', 'transcription child process timed out', dest);
        }

        const parsed = parseVoiceEnvelope(execResult.stdout);
        if (parsed === null) {
          return fail('transcribe-failed', execResult.stderr.slice(-500), dest);
        }
        envelope = parsed;
        mode = 'spawn';
      }

      if (envelope.ok !== true) {
        const reason = reasonForErrorCode(envelope.error_code);
        return fail(reason, String(envelope.error ?? ''), dest, envelope.error_code);
      }

      const text = String(envelope.text ?? '');
      if (text.trim() === '') {
        return fail('empty-transcript', 'transcript was empty', dest);
      }

      if (envelope.engine === 'whisper_local' && cfg.language && !ENGLISH_LANGUAGE_PATTERN.test(cfg.language)) {
        logger.warn('voice', 'whisper_local served a non-English language request; the local model is English-only and may mistranscribe or transliterate', {
          language: cfg.language,
        });
      }

      const elapsedMs = Date.now() - startedAt;
      const truncated = envelope.truncated === true;
      const speakers = typeof envelope.speakers === 'number' ? envelope.speakers : undefined;

      logger.info('voice', 'transcription succeeded', {
        chatId,
        durationS: media.duration,
        engine: envelope.engine,
        mode,
        fallback,
        chars: text.length,
        elapsedMs,
        speakers,
      });

      return {
        ok: true,
        text,
        engine: String(envelope.engine ?? ''),
        mode,
        fallback,
        audioPath: dest,
        elapsedMs,
        truncated,
        speakers,
      };
    } finally {
      if (typingTimer) clearInterval(typingTimer);
    }
  } catch (err) {
    return fail('transcribe-failed', err instanceof Error ? err.message : String(err), undefined);
  }
}
