import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cleanupExpiredVoiceAttachments,
  voiceAttachmentsDir,
  voiceAttachmentGcJob,
  VOICE_ATTACHMENT_FILE_RE,
} from '../src/lib/maintenance/jobs/voice-attachment-gc.js';

let tempDir: string;
let originalPaHome: string | undefined;
let attachmentsDir: string;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pa-voice-attachment-gc-'));
  originalPaHome = process.env.PA_HOME;
  process.env.PA_HOME = tempDir;
  attachmentsDir = join(tempDir, 'attachments');
  await mkdir(attachmentsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  if (originalPaHome === undefined) delete process.env.PA_HOME;
  else process.env.PA_HOME = originalPaHome;
});

async function makeAttachment(chatId: string, date: string, name: string, ageDays: number): Promise<string> {
  const dir = join(attachmentsDir, chatId, date);
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, 'audio', 'utf8');
  const t = new Date(Date.now() - ageDays * DAY);
  await utimes(p, t, t);
  return p;
}

describe('cleanupExpiredVoiceAttachments', () => {
  it('returns 0 when the attachments dir does not exist', async () => {
    await rm(attachmentsDir, { recursive: true, force: true });
    assert.equal(await cleanupExpiredVoiceAttachments(Date.now(), attachmentsDir), 0);
  });

  it('deletes .oga files older than the cutoff and keeps newer ones, across the <chat_id>/<date>/ nesting', async () => {
    await makeAttachment('123', '2026-01-01', 'old.oga', 40);
    await makeAttachment('456', '2026-07-01', 'recent.oga', 1);
    const deleted = await cleanupExpiredVoiceAttachments(Date.now() - 30 * DAY, attachmentsDir);
    assert.equal(deleted, 1);
    assert.equal(await exists(join(attachmentsDir, '123', '2026-01-01', 'old.oga')), false);
    assert.equal(await exists(join(attachmentsDir, '456', '2026-07-01', 'recent.oga')), true);
  });

  it('is fail-closed: never touches files outside the allowlist even when old', async () => {
    await makeAttachment('123', '2026-01-01', 'notes.txt', 400);
    const deleted = await cleanupExpiredVoiceAttachments(Date.now(), attachmentsDir);
    assert.equal(deleted, 0);
    assert.equal(await exists(join(attachmentsDir, '123', '2026-01-01', 'notes.txt')), true);
  });

  it('walks multiple chat_id and date directories independently', async () => {
    await makeAttachment('111', '2026-01-01', 'a.oga', 40);
    await makeAttachment('111', '2026-02-01', 'b.oga', 40);
    await makeAttachment('222', '2026-01-01', 'c.oga', 40);
    await makeAttachment('222', '2026-07-01', 'd.oga', 1);
    const deleted = await cleanupExpiredVoiceAttachments(Date.now() - 30 * DAY, attachmentsDir);
    assert.equal(deleted, 3);
    assert.equal(await exists(join(attachmentsDir, '222', '2026-07-01', 'd.oga')), true);
  });

  it('skips stray files sitting directly under the root or under a chat_id dir (not two levels deep)', async () => {
    await writeFile(join(attachmentsDir, 'stray.oga'), 'audio', 'utf8');
    await mkdir(join(attachmentsDir, '333'), { recursive: true });
    await writeFile(join(attachmentsDir, '333', 'also-stray.oga'), 'audio', 'utf8');
    const t = new Date(Date.now() - 40 * DAY);
    await utimes(join(attachmentsDir, 'stray.oga'), t, t);
    await utimes(join(attachmentsDir, '333', 'also-stray.oga'), t, t);
    const deleted = await cleanupExpiredVoiceAttachments(Date.now() - 30 * DAY, attachmentsDir);
    assert.equal(deleted, 0);
  });

  it('defaults root to voiceAttachmentsDir() (join(paHome(), "attachments"))', () => {
    assert.equal(voiceAttachmentsDir(), join(tempDir, 'attachments'));
  });
});

describe('VOICE_ATTACHMENT_FILE_RE', () => {
  it('matches the widened audio/video-note allowlist and rejects everything else (fail-closed, not .*)', () => {
    assert.ok(VOICE_ATTACHMENT_FILE_RE.test('AgADdQADq6cxG.oga'));
    assert.ok(VOICE_ATTACHMENT_FILE_RE.test('AgADdQADq6cxG.ogg'));
    assert.ok(VOICE_ATTACHMENT_FILE_RE.test('AgADdQADq6cxG.OGA'), 'case-insensitive');
    assert.equal(VOICE_ATTACHMENT_FILE_RE.test('notes.txt'), false);
    assert.equal(VOICE_ATTACHMENT_FILE_RE.test('image.png'), false);
  });
});

// Literal list of extensions WP4's voice.ts is documented (plan: WP4 item 5) to
// be able to produce once built: .oga for voice, .mp4 for video_note, plus the
// audio-file mime-map extensions the plan names alongside WP8's own regex
// widening. This deliberately does NOT import voice.ts — another agent is
// building it concurrently and its real extension-derivation table may not
// exist or export correctly yet. Follow-up: once WP4 lands, replace this
// literal list with an import of its real table.
const WP4_DOCUMENTED_EXTENSIONS = [
  'oga', // voice
  'mp4', // video_note
  'ogg', 'opus', 'mp3', 'm4a', 'wav', 'webm', 'flac', 'aac', 'amr', // audio-file mime-map
];

describe('VOICE_ATTACHMENT_FILE_RE / WP4 extension drift guard', () => {
  it('matches every extension WP4 is documented to be able to produce, so nothing leaks past retention', () => {
    for (const ext of WP4_DOCUMENTED_EXTENSIONS) {
      assert.ok(
        VOICE_ATTACHMENT_FILE_RE.test(`AgADdQADq6cxG.${ext}`),
        `expected VOICE_ATTACHMENT_FILE_RE to match .${ext} (WP4-documented extension)`,
      );
    }
  });
});

describe('voiceAttachmentGcJob', () => {
  it('declares the shape WP8 specifies', () => {
    assert.equal(voiceAttachmentGcJob.name, 'voice-attachment-gc');
    assert.equal(voiceAttachmentGcJob.host, 'pa');
    assert.equal(voiceAttachmentGcJob.everyMs, 24 * 3_600_000);
    assert.equal(voiceAttachmentGcJob.destructive, true);
    assert.equal(voiceAttachmentGcJob.shedWhenDegraded, true);
    assert.equal(voiceAttachmentGcJob.targets.length, 1);

    const target = voiceAttachmentGcJob.targets[0];
    assert.equal(target.resolve(), join(tempDir, 'attachments'));
    assert.equal(target.match, VOICE_ATTACHMENT_FILE_RE);
    assert.equal(target.maxAgeMs, 30 * 24 * 3_600_000);
    assert.equal(target.action, 'delete');
    assert.equal(target.ownership, 'pa-owned');
    assert.ok(target.evidence.length > 0);
    assert.ok(target.note && target.note.length > 0, 'note must explain the two-level nesting to the previewer');
  });

  it('run() deletes attachments past the 30-day retention using ctx.now as the clock', async () => {
    await makeAttachment('123', '2026-01-01', 'old.oga', 40);
    await makeAttachment('123', '2026-07-01', 'recent.oga', 1);
    const result = await voiceAttachmentGcJob.run({ now: Date.now(), everyMs: 24 * 3_600_000 });
    assert.equal(result.touched, 1);
  });
});

async function exists(p: string): Promise<boolean> {
  try {
    await import('fs/promises').then((fs) => fs.stat(p));
    return true;
  } catch {
    return false;
  }
}
