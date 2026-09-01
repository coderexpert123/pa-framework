/**
 * attachment-stage.ts — AI-173 phase 1 (2026-09-01).
 *
 * Behavior-preserving extraction of processUpdate's voice/attachment block
 * out of main.ts. Spec: plans/2026-09-01-ai173-phase1-attachment-stage-SPEC.md.
 *
 * Owns transcription, the audio index, the ref-ID'd "Heard" echo, and
 * document/photo download. `main.ts` calls `runAttachmentStage` once and
 * assigns the five result fields it returns.
 */
import { dirname } from 'path';
import { mkdirSync } from 'fs';
import { sendMessage, downloadFile } from './telegram.js';
import { appendRefIdAndLog } from './ref-id.js';
import { describeForwardOrigin } from './logic.js';
import {
  transcribeVoiceMessage,
  formatTranscriptUserText,
  formatFailedTranscriptUserText,
  voiceErrorMessage,
  extractAudioAttachment,
  voiceAttachmentPath,
  type AudioAttachment,
  type VoiceDeps,
  type VoiceResult,
} from './voice.js';
import {
  audioIndexRoot,
  recordAudioMessage,
  markAudioResult,
} from './audio-index.js';
import { logger } from '../../../pa/dist/src/lib/log.js';

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
      }

      // Transcript echo (2026-09-01, plans/2026-09-01-voice-transcript-echo-SPEC.md):
      // mirror what was heard back to the topic BEFORE worker dispatch so the user
      // can verify the transcription while the reply is composed. A failed echo
      // send must never break the turn.
      const echoEngine = vr.engine ? ` (${vr.engine})` : '';
      const echoSuffix = vr.truncated ? '\n\n[transcript truncated]' : '';
      await send(
        token,
        chatId,
        appendRefIdAndLog(`🎙 Heard${echoEngine}:\n\n${vr.text}${echoSuffix}`, { kind: 'system', chatId, threadId }),
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

  return { userText, voiceTranscribed, response, skipWorker, audioAttachment };
}
