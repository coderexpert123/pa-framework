import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_ATTACHMENT_FILE_RE } from '../src/lib/maintenance/jobs/voice-attachment-gc.js';

// WPE3 (2026-08-18): document/photo attachments share the voice substrate, so
// the GC regex must cover their extensions. Lives in pa/tests because the
// constant is a pa module (bot-side cross-package deep imports don't resolve
// under the bot's tsc).

describe('voice-attachment-gc file regex covers document types (WPE3)', () => {
  for (const ext of ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'txt', 'md', 'csv', 'xlsx', 'zip']) {
    it(`matches .${ext}`, () => {
      assert.ok(VOICE_ATTACHMENT_FILE_RE.test(`file.${ext}`), `.${ext} should be GC'd`);
    });
  }
  it('still matches legacy audio .oga', () => {
    assert.ok(VOICE_ATTACHMENT_FILE_RE.test('note.oga'));
  });
  it('does not match an arbitrary executable', () => {
    assert.ok(!VOICE_ATTACHMENT_FILE_RE.test('tool.exe'));
  });
});
