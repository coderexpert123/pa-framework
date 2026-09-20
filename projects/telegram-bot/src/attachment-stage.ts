/**
 * attachment-stage.ts — AI-173 phase 1 (2026-09-01).
 *
 * Behavior-preserving extraction of processUpdate's voice/attachment block
 * out of main.ts. Spec: the AI-173 attachment-stage design (2026-09-01, internal).
 *
 * Owns transcription, the audio index, the ref-ID'd "Heard" echo, and
 * document/photo download. Since AI-191 (2026-09-03) it also matches a
 * successful transcript against the closed registered-command set and, on a
 * confident match, replaces the queue text with the typed-equivalent slash
 * command. `main.ts` calls `runAttachmentStage` once and assigns the five
 * result fields it returns — no wiring beyond that: the existing
 * processUpdate command interception consumes the normalized text as-is.
 */
import { dirname } from 'path';
import { mkdirSync } from 'fs';
import { sendMessage, downloadFile } from './telegram.js';
import { appendRefIdAndLog } from './ref-id.js';
import { describeForwardOrigin, isKnownCommand } from './logic.js';
import { BOT_COMMANDS } from './commands.js';
import {
  transcribeVoiceMessage,
  formatTranscriptUserText,
  formatFailedTranscriptUserText,
  voiceErrorMessage,
  extractAudioAttachment,
  voiceAttachmentPath,
  type AudioAttachment,
  type AudioAttachmentKind,
  type VoiceDeps,
  type VoiceResult,
} from './voice.js';
import {
  audioIndexRoot,
  recordAudioMessage,
  markAudioResult,
} from './audio-index.js';
import type { AudioMediaIdentity } from './topic-queue.js';
import { logger } from '../../../pa/dist/src/lib/log.js';

// --- AI-191 (2026-09-03): voice-invoked commands --------------------------
//
// A transcribed note can INVOKE a command. The match runs here at the
// attachment stage, on the raw transcript, before it becomes the queue text,
// and produces typed-equivalent text (a leading slash command) that the
// EXISTING processUpdate interception consumes unchanged. Voice never grows a
// second interception path — what it produces is byte-equivalent to typing.
//
// Two layers, both conservative (the backlog entry's rule: ambiguous → NO
// invocation, falls through as conversation):
//
//   1. literal — the user SAID the slash form ("slash new", or "/status" when
//      the engine transcribes the symbol). That is explicit invocation
//      syntax, a faithful transliteration rather than inferred intent, so it
//      is the ONLY way a destructive command (/new, /reset) or the
//      git-workflow family can fire from voice.
//   2. inferred — natural speech matched against a hand-picked SAFE subset of
//      the closed registered set: bare utterances that are unambiguous
//      invocations ("status" → /status), plus two verbs whose spoken object
//      is a reference resolved by the command's own machinery ("debug that
//      last message" → /debug via reply-to/context — dormant until /debug
//      registers). Everything else — polite requests, mid-sentence mentions,
//      argument-bearing commands — passes through untouched.
//
// On a match userText is REPLACED with the normalized command (the
// "[Voice message] " wrapper is dropped): interception patterns are
// ^-anchored, so the wrapper would block them. The 🎙 Heard echo shows the
// interpretation as a "→ /command" line either way.

/** Filler words a spoken invocation may open or close with. Deliberately
 *  tight — address and politeness only. "Could you" / "can you" are NOT
 *  fillers: "could you help me" must stay conversational. */
const VOICE_FILLER_WORDS = new Set(['ok', 'okay', 'hey', 'please', 'pa', 'bot']);

/** Commands the inference layer may fire on a BARE utterance (the whole
 *  transcript, modulo filler/case/punctuation). Only argument-free,
 *  non-destructive, non-git commands whose bare spoken form is unambiguous.
 *  Absent on purpose: new/reset (destructive), commit/push_public/push/
 *  investigate_flagged (git-workflow family), stop/steer (intercepted in the
 *  poll loop on raw text, before transcription — a voice-produced "/stop"
 *  would reach the unknown-command guard, which does not know STOP_PATTERN,
 *  and answer "Unknown command"), and the free-text skill commands, whose
 *  bare form is meaningless. */
const VOICE_SAFE_BARE_COMMANDS = new Set([
  'status', 'health', 'help', 'skills', 'claims', 'agent',
  'retranscribe', 'update_brain',
]);

/** Spoken phrase → registered command name, applied to the bare core. */
const VOICE_SPOKEN_ALIASES: Record<string, string> = {
  'update brain': 'update_brain',
  'update brains': 'update_brain',
};

/** Verbs the inference layer may fire WITH a spoken object: the object is a
 *  reference ("that last message") that resolves via reply-to/context, so the
 *  normalized form is the bare command and the remainder is dropped from the
 *  queue text (it stays visible in the echo). 'debug' is AI-190's command —
 *  it is gated on registration, so this entry stays dormant (the transcript
 *  falls through as conversation) until that command exists in the live set. */
const VOICE_INFERENCE_VERBS: Array<{ re: RegExp; command: string }> = [
  { re: /^debug\b/i, command: 'debug' },
  { re: /^re-?transcribe\b/i, command: 'retranscribe' },
];

export interface VoiceCommandMatch {
  /** What userText becomes — a leading slash command, typed-equivalent. */
  normalized: string;
  /** The registered command name that fired (no slash). */
  command: string;
  /** literal = the user said the slash form; inferred = natural speech. */
  via: 'literal' | 'inferred';
}

/** Strip leading/trailing filler words: "okay pa status please" → "status".
 *  Never strips when only one word would remain. */
function voiceCommandCoreWords(text: string): string[] {
  const stripPunct = (w: string): string => w.toLowerCase().replace(/[.,!?;:]+$/g, '');
  let words = text.split(/\s+/).filter(Boolean);
  for (let guard = 0; guard < 4 && words.length > 1; guard++) {
    const before = words.length;
    if (VOICE_FILLER_WORDS.has(stripPunct(words[0]))) words = words.slice(1);
    if (words.length > 1 && VOICE_FILLER_WORDS.has(stripPunct(words[words.length - 1]))) {
      words = words.slice(0, -1);
    }
    if (words.length === before) break;
  }
  return words;
}

/** Match a raw transcript against the closed registered-command set.
 *  `isRegistered` is the closed set to match over (the stage passes the live
 *  registry; tests inject their own). Returns undefined unless the match is
 *  confident — anything else stays conversational. */
export function matchVoiceCommand(
  transcript: string,
  isRegistered: (command: string) => boolean,
): VoiceCommandMatch | undefined {
  // Trailing sentence punctuation comes off once; interior text is untouched.
  const text = transcript.trim().replace(/[.!?]+$/, '').trim();
  if (!text) return undefined;
  const stripped = voiceCommandCoreWords(text).join(' ');
  if (!stripped) return undefined;

  // Seam guarantee: voice only produces text the REAL interception pattern
  // machinery consumes. If the patterns would not recognize the exact string
  // (e.g. an argument where none fits: "slash status please"), fall through
  // as conversation rather than emit text that leaks to the worker or the
  // unknown-command guard.
  const accept = (m: VoiceCommandMatch): VoiceCommandMatch | undefined =>
    isKnownCommand(m.normalized) ? m : undefined;

  // Layer 1 — literal spoken slash form. Case-insensitive: transcripts
  // capitalize ("Slash status"). "backslash new" does NOT match (the
  // alternation anchors at the string start; "backslash" starts with 'b').
  const literal = /^(?:slash\s+|\/)([A-Za-z_]\w*)(?:\s+([\s\S]*))?$/i.exec(stripped);
  if (literal) {
    const command = literal[1].toLowerCase();
    if (isRegistered(command)) {
      const rest = (literal[2] ?? '').trim();
      return accept({
        normalized: `/${command}${rest ? ` ${rest}` : ''}`,
        command,
        via: 'literal',
      });
    }
    return undefined;
  }

  // Layer 2a — the bare utterance IS the command (modulo filler/case/punct).
  const core = stripped.toLowerCase();
  const bare = VOICE_SPOKEN_ALIASES[core] ?? core;
  if (VOICE_SAFE_BARE_COMMANDS.has(bare) && isRegistered(bare)) {
    return accept({ normalized: `/${bare}`, command: bare, via: 'inferred' });
  }

  // Layer 2b — unambiguous verb + spoken object (object → reply-to/context,
  // never text args). First verb whose pattern matches wins.
  for (const { re, command } of VOICE_INFERENCE_VERBS) {
    if (re.test(stripped) && isRegistered(command)) {
      return accept({ normalized: `/${command}`, command, via: 'inferred' });
    }
  }
  return undefined;
}

/** The live closed set: declared in commands.ts's BOT_COMMANDS AND actually
 *  consumed by the interception pattern machinery (isKnownCommand). Read at
 *  call time so a command registered later (AI-190's /debug) activates voice
 *  inference without edits here. */
export function liveRegisteredVoiceCommands(): ReadonlySet<string> {
  const known = new Set<string>();
  for (const c of BOT_COMMANDS) {
    if (isKnownCommand(c.command)) known.add(c.command);
  }
  return known;
}

/** Everything processUpdate hands the stage. `msg`/`update` are `any` on purpose:
 *  main.ts already carries them as `any`, and a behavior-preserving extraction
 *  introduces no new types. */
export interface AttachmentStageInput {
  /** update.message */
  msg: any;
  /** the raw update — read ONLY for the poll-loop normalizer's three private
   *  markers: __skipVoice, __voiceResult, __heldAbsorbed (all set in the enqueue
   *  block, phase 4 territory; this stage is a pure consumer of them). */
  update: any;
  /** userText as processUpdate has it at entry to the stage. */
  userText: string;
  token: string;
  chatId: number;
  threadId: number;
  messageId: number;
  /** BOT_CWD — becomes VoiceDeps.repoRoot. */
  repoRoot: string;
  /** runtimeEnv = { ...process.env, ...secrets } — becomes VoiceDeps.env. */
  runtimeEnv: NodeJS.ProcessEnv;
  /** config.transcription; may be undefined. */
  transcription?: VoiceDeps['transcription'];
  /** AI-208 WP-3 (2026-09-05), extended by AI-209 (2026-09-06): transcripts
   *  folded into a re-dispatch from either source — a /steer drain (WP-2 builds
   *  this as `(update as any).__foldedVoice`) or an AI-209 batch fold. Each
   *  item is one queued voice note the fold absorbed: echo it and index it so
   *  /retranscribe works. `via` names the fold source; it changes ONLY the echo
   *  label. Absent on every non-fold path — behaviour is then byte-identical
   *  to before. */
  foldedVoice?: Array<{
    text: string;
    media: AudioMediaIdentity;
    kind: AudioAttachmentKind;
    messageId?: number;
    /** Fold source: 'steer' (default) keeps the byte-identical
     *  "🎙 Heard (steered)" label; 'batch' echoes "🎙 Heard (batched)". */
    via?: 'steer' | 'batch';
  }>;
}

/** Every side effect the stage performs, injectable. Defaults bind the real
 *  implementations, so main.ts passes no deps at all. */
export interface AttachmentStageDeps {
  transcribe?: typeof transcribeVoiceMessage;
  recordAudio?: typeof recordAudioMessage;
  markAudio?: typeof markAudioResult;
  audioRoot?: typeof audioIndexRoot;
  sendMessageFn?: typeof sendMessage;
  downloadFileFn?: typeof downloadFile;
  /** default: (dir) => { mkdirSync(dir, { recursive: true }); } */
  makeDir?: (dir: string) => void;
  /** default: () => new Date() */
  now?: () => Date;
  /** AI-191: the closed registered-command set voice transcripts match over.
   *  Default: `liveRegisteredVoiceCommands()` (BOT_COMMANDS ∩ isKnownCommand,
   *  read at call time). Tests inject a fixed set. */
  registeredCommands?: () => ReadonlySet<string>;
  log?: {
    info(module: string, message: string, context?: Record<string, unknown>): void;
    warn(module: string, message: string, context?: Record<string, unknown>): void;
  };
}

/** The four values processUpdate reads back, plus the attachment handle its own
 *  downstream `!userText && !audioAttachment && !msg.document && !msg.photo`
 *  guard needs. `response` is '' and `skipWorker` false on every path except the
 *  transcription-failure branch — the caller assigns all five unconditionally. */
export interface AttachmentStageResult {
  userText: string;
  voiceTranscribed: boolean;
  response: string;
  skipWorker: boolean;
  audioAttachment: AudioAttachment | undefined;
}

export async function runAttachmentStage(
  input: AttachmentStageInput,
  deps: AttachmentStageDeps = {},
): Promise<AttachmentStageResult> {
  const transcribe = deps.transcribe ?? transcribeVoiceMessage;
  const recordAudio = deps.recordAudio ?? recordAudioMessage;
  const markAudio = deps.markAudio ?? markAudioResult;
  const audioRoot = deps.audioRoot ?? audioIndexRoot;
  const send = deps.sendMessageFn ?? sendMessage;
  const download = deps.downloadFileFn ?? downloadFile;
  const makeDir = deps.makeDir ?? ((dir: string) => { mkdirSync(dir, { recursive: true }); });
  const now = deps.now ?? (() => new Date());
  const registeredCommands = deps.registeredCommands ?? liveRegisteredVoiceCommands;
  const log = deps.log ?? logger;

  const { msg, update, token, chatId, threadId, messageId, repoRoot, runtimeEnv, transcription } = input;

  let userText = input.userText;
  let response = '';
  let skipWorker = false;
  // Set when userText came from a transcribed voice/audio message, not typed
  // by the user — guards the pendingDescription branch below from treating a
  // transcribed sentence as an intentional answer to "what's this topic for?".
  let voiceTranscribed = false;

  const audioAttachment = extractAudioAttachment(msg);
  // A5: __skipVoice for command-captioned media — skip transcription entirely.
  // The normalizer set this when enqueue saw a caption starting with '/'.
  if ((update as any).__skipVoice) {
    // Leave userText as-is (caption or text). No transcription.
    // Fall through to command parsing with the original caption.
  } else if (audioAttachment) {
    // A5/D2: Consume prefetched result if present; otherwise transcribe inline.
    // Durable audio index (2026-08-31 retranscribe-smart plan): record BEFORE
    // transcription so failed notes are recoverable by a bare /retranscribe.
    // Best-effort by contract — an index failure must never break the note.
    recordAudio(audioRoot(), chatId, {
      messageId,
      threadId: threadId || null,
      kind: audioAttachment.kind,
      media: audioAttachment.media,
      date: now().toISOString(),
    }).catch(() => {});
    let vr: VoiceResult;
    const prefetched = (update as any).__voiceResult as VoiceResult | undefined;
    if (prefetched) {
      vr = prefetched;
    } else {
      vr = await transcribe(token, chatId, audioAttachment.media, {
        repoRoot,
        env: runtimeEnv,
        transcription,
        threadId,
      }, audioAttachment.kind);
    }
    markAudio(
      audioRoot(),
      chatId,
      audioAttachment.media.file_unique_id,
      vr.ok ? 'ok' : 'failed',
      vr.ok ? { engine: vr.engine } : { reason: vr.reason }
    ).catch(() => {});
    const forwardedFrom = describeForwardOrigin(msg);
    if (!vr.ok) {
      // D2: If normalizer already combined held entries + transcript, don't overwrite.
      if (!(update as any).__heldAbsorbed) {
        userText = formatFailedTranscriptUserText(audioAttachment.kind, vr.reason, { caption: msg.caption });
      }
      response = voiceErrorMessage(vr);
      skipWorker = true;
    } else {
      // AI-191: a confident voice-command match, when one exists. Declared out
      // here so the echo below can show the interpretation.
      let voiceCommand: VoiceCommandMatch | undefined;
      // D2: If normalizer already set userText (held + transcript), don't overwrite.
      if ((update as any).__heldAbsorbed) {
        voiceTranscribed = true;
      } else {
        userText = formatTranscriptUserText(vr.text, {
          truncated: vr.truncated,
          caption: msg.caption,
          kind: audioAttachment.kind,
          fileName: audioAttachment.media.file_name,
          speakers: vr.speakers,
          forwardedFrom,
        });
        voiceTranscribed = true;
        // AI-191: match the RAW transcript (not the wrapped text) over the
        // closed registered-command set. A forwarded note is someone else's
        // audio — its words never invoke commands. Held-absorbed combined
        // text is skipped above: the transcript portion has no clean boundary
        // inside the combined string.
        if (!forwardedFrom) {
          voiceCommand = matchVoiceCommand(vr.text, (c) => registeredCommands().has(c));
          if (voiceCommand) {
            // The normalized command REPLACES the queue text — the
            // ^-anchored interception patterns run on exactly this.
            log.info('voice-commands', 'transcript matched a registered command', {
              chatId, threadId, command: voiceCommand.command, via: voiceCommand.via,
            });
            userText = voiceCommand.normalized;
          }
        }
      }

      // Transcript echo (2026-09-01, voice-transcript-echo design, internal):
      // mirror what was heard back to the topic BEFORE worker dispatch so the user
      // can verify the transcription while the reply is composed. A failed echo
      // send must never break the turn.
      const echoEngine = vr.engine ? ` (${vr.engine})` : '';
      const echoSuffix = vr.truncated ? '\n\n[transcript truncated]' : '';
      const echoInterp = voiceCommand ? `\n\n→ ${voiceCommand.normalized}` : '';
      await send(
        token,
        chatId,
        appendRefIdAndLog(`🎙 Heard${echoEngine}:\n\n${vr.text}${echoSuffix}${echoInterp}`, { kind: 'system', chatId, threadId }),
        messageId,
        threadId,
      ).catch(() => {});
    }
  } else if (msg.document?.mime_type && /^(audio|video)\//.test(msg.document.mime_type)) {
    // Audio/video uploaded as a generic document — deliberately not routed
    // through transcription (no `duration` field to pre-download-guard,
    // and Telegram's own 20MB getFile ceiling makes a large one fail ugly;
    // hardened plan WP6 item 1). One hint line so the caption isn't
    // dispatched with no indication the attachment was ignored.
    const hint = '[An audio file was attached as a document and was not transcribed. Re-send it as a voice note or audio message to have it transcribed.]';
    userText = userText ? `${userText}\n\n${hint}` : hint;
  } else if (msg.document || msg.photo) {
    // WPE3 (2026-08-18): document/photo attachments — download to the same
    // dated substrate as voice, allowlist the type, and inject the path into
    // userText (the format context.ts's Attachments section also uses).
    const ALLOWED_DOC_EXT = /\.(pdf|jpe?g|png|webp|txt|md|csv|xlsx|zip)$/i;
    const docName = msg.document?.file_name;
    const photo = Array.isArray(msg.photo) ? msg.photo[msg.photo.length - 1] : undefined; // largest size
    const fileName = docName ?? (photo ? `photo_${photo.file_unique_id}.jpg` : undefined);
    if (!fileName || !ALLOWED_DOC_EXT.test(fileName)) {
      userText = userText ? `${userText}\n\n[Attachment ${fileName ?? '(unnamed)'} rejected: allowed types are pdf, jpg, png, webp, txt, md, csv, xlsx, zip.]` : `[Attachment ${fileName ?? '(unnamed)'} rejected: allowed types are pdf, jpg, png, webp, txt, md, csv, xlsx, zip.]`;
    } else {
      const media = (msg.document ?? photo) as { file_id: string; file_unique_id: string };
      const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase() : 'bin';
      try {
        const destPath = voiceAttachmentPath(chatId, media.file_unique_id, now(), ext);
        // Create parent directory before download (downloadFile does not do this itself)
        makeDir(dirname(destPath));
        const ok = await download(token, media.file_id, destPath);
        if (!ok) throw new Error('downloadFile returned false');
        log.info('attachments', 'downloaded attachment', { chatId, threadId, fileName, destPath });
        const line = `[Attachment: ${fileName} at ${destPath}]`;
        userText = userText ? `${userText}\n\n${line}` : line;
      } catch (err: any) {
        log.warn('attachments', 'attachment download failed', { error: err?.message ?? String(err), fileName });
        userText = userText ? `${userText}\n\n[Attachment ${fileName} failed to download — see pa-alerts log.]` : `[Attachment ${fileName} failed to download — see pa-alerts log.]`;
      }
    }
  }

  // AI-208 WP-3 (2026-09-05), extended by AI-209 (2026-09-06): folded voice
  // from either fold source — a /steer re-dispatch's drain or an AI-209 batch
  // fold (the item's `via` field names which). Runs on EVERY shape of update
  // (a fold source is usually plain text, so this must not sit inside the
  // audioAttachment branch). Per item, in order:
  //   1. record into the durable audio index BEFORE the echo (same order and
  //      best-effort contract as the own-audio path above) so the folded note
  //      is /retranscribe-recoverable even if the echo send fails — req 3;
  //   2. mark it 'ok' (the transcript settled — that is what the text field IS);
  //   3. echo one "🎙 Heard (steered)" line per steered transcript or one
  //      "🎙 Heard (batched)" line per batched transcript, AFTER the own-audio
  //      echo block above — req 2. A failed send never breaks the turn.
  const foldedVoice = input.foldedVoice
    ?? ((update as any).__foldedVoice as AttachmentStageInput['foldedVoice'] | undefined);
  if (foldedVoice && foldedVoice.length > 0) {
    for (const item of foldedVoice) {
      // m4 (AI-208 fix-wave): item.media is AudioMediaIdentity, which carries
      // the required duration — the index's TelegramAudioLike input accepts it
      // structurally, so no cast.
      recordAudio(audioRoot(), chatId, {
        messageId: item.messageId ?? messageId,
        threadId: threadId || null,
        kind: item.kind,
        media: item.media,
        date: now().toISOString(),
      }).catch(() => {});
      // Engine "when known": the fixed WP-2 item shape carries no engine field,
      // so read it defensively and omit the extra when absent.
      const engine = (item as { engine?: string }).engine;
      markAudio(audioRoot(), chatId, item.media.file_unique_id, 'ok', engine ? { engine } : undefined).catch(() => {});
      // AI-209: the label names the fold source. The steer text is unchanged
      // byte-for-byte (the shipped pins depend on it); only a batch fold —
      // `via === 'batch'` — echoes the (batched) label.
      // Fix-wave A1 correction (2026-09-06): both frozen labels carry a single
      // trailing colon (SPEC §4.4; the shipped pins assert the single-colon
      // prefix). An earlier same-day edit stripped the colons on the false
      // premise that the constants already ended in one — that composed a
      // colon-less echo and reddened T6 + the unit pins. Constants carry the
      // single trailing colon for BOTH sources; the template adds none.
      const heardLabel = item.via === 'batch' ? '🎙 Heard (batched):' : '🎙 Heard (steered):';
      await send(
        token,
        chatId,
        appendRefIdAndLog(`${heardLabel}\n\n${item.text}`, { kind: 'system', chatId, threadId }),
        messageId,
        threadId,
      ).catch(() => {});
    }
  }

  return { userText, voiceTranscribed, response, skipWorker, audioAttachment };
}
