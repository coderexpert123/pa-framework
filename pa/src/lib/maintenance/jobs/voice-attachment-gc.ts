import { readdir, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { paHome } from '../../../paths.js';
import type { MaintenanceJob } from '../types.js';

const DAY = 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * DAY;

/** Fail-closed allowlist — nothing else under attachments/ is ever touched.
 *  Widened 2026-08-04 (voice-transcription hardening plan, WP8) from plain
 *  .oga to cover WP4's new audio-file/video_note support (audio, video_note,
 *  and cloud-transcoded formats) — must stay in lockstep with WP4 item 5's
 *  extension derivation, or new-format attachments leak past 30d retention. */
export const VOICE_ATTACHMENT_FILE_RE = /\.(oga|ogg|opus|mp3|m4a|mp4|wav|webm|flac|aac|amr)$/i;

export function voiceAttachmentsDir(): string {
  return join(paHome(), 'attachments');
}

/**
 * Delete voice-note audio older than cutoffMs. The tree is nested
 * <chat_id>/<date>/<id>.oga (two levels deep), unlike every other GC target
 * in this framework, so this walks it explicitly rather than relying on the
 * generic single-level readdir the dry-run previewer uses — see the target's
 * `note` in voiceAttachmentGcJob. Exported for testing.
 */
export async function cleanupExpiredVoiceAttachments(
  cutoffMs: number,
  root: string = voiceAttachmentsDir(),
): Promise<number> {
  let deleted = 0;
  let chatDirs: string[];
  try {
    chatDirs = await readdir(root);
  } catch {
    return 0;
  }

  for (const chatDir of chatDirs) {
    const chatPath = join(root, chatDir);
    let dateDirs: string[];
    try {
      if (!(await stat(chatPath)).isDirectory()) continue;
      dateDirs = await readdir(chatPath);
    } catch {
      continue;
    }

    for (const dateDir of dateDirs) {
      const datePath = join(chatPath, dateDir);
      let files: string[];
      try {
        if (!(await stat(datePath)).isDirectory()) continue;
        files = await readdir(datePath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!VOICE_ATTACHMENT_FILE_RE.test(file)) continue;
        const filePath = join(datePath, file);
        try {
          const fileStat = await stat(filePath);
          if (fileStat.mtimeMs < cutoffMs) {
            await unlink(filePath);
            deleted++;
          }
        } catch {
          // vanished between readdir and stat/unlink — skip
        }
      }
    }
  }

  return deleted;
}

export const voiceAttachmentGcJob: MaintenanceJob = {
  name: 'voice-attachment-gc',
  host: 'pa',
  everyMs: 24 * 3_600_000,
  description: 'Delete Telegram voice/audio/video-note attachments older than 30 days. The transcript is preserved in conversation-history.jsonl, so the audio is debug-only after that.',
  destructive: true,
  shedWhenDegraded: true,
  targets: [
    {
      resolve: voiceAttachmentsDir,
      match: VOICE_ATTACHMENT_FILE_RE,
      maxAgeMs: RETENTION_MS,
      action: 'delete',
      ownership: 'pa-owned',
      evidence: 'PA writes these itself from Telegram voice notes (plans/2026-08-04-telegram-voice-transcription.md); widened 2026-08-04 to the full audio/video-note allowlist for WP4\'s audio-file and video_note support (voice-transcription hardening plan, WP8) — the transcript is archived in conversation-history.jsonl, so the audio is debug-only after 30d.',
      note: 'Files live two levels deep under <chat_id>/<date>/<id>.oga; the generic dry-run previewer only readdir()s one level, so it will report 0 candidates here even when deletions are pending — the job\'s own run() walks the nesting.',
    },
  ],
  async run(ctx) {
    return { touched: await cleanupExpiredVoiceAttachments(ctx.now - RETENTION_MS) };
  },
};
