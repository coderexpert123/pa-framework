/**
 * voice-prefetch.test.ts
 *
 * Tests for voice-prefetch.ts — the fire-and-forget prefetch map that stores
 * transcription promises keyed by topicKey|updateId, enabling /stop and /steer
 * to hold formatted transcripts without blocking the poll loop.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'assert';
import {
  startPrefetch,
  lookupPrefetch,
  consumePrefetch,
  clearPrefetch,
  userTextFromVoiceResult,
  _clearPrefetchForTest,
} from '../voice-prefetch.js';
import type { VoiceResult, AudioAttachmentKind } from '../voice.js';

describe('voice-prefetch', () => {
  beforeEach(() => _clearPrefetchForTest());

  describe('userTextFromVoiceResult', () => {
    it('delegates to formatTranscriptUserText for ok result', () => {
      const vr: VoiceResult = {
        ok: true,
        text: 'test transcript',
        engine: 'whisper',
        mode: 'spawn',
        audioPath: '/path/to/file.oga',
        elapsedMs: 1000,
        truncated: false,
      };

      const descriptor = {
        kind: 'voice' as AudioAttachmentKind,
        caption: 'test caption',
        forwardedFrom: 'John Doe',
        messageDate: '2026-08-15T10:00:00Z',
      };

      const result = userTextFromVoiceResult(vr, descriptor);

      assert.ok(result.includes('test transcript'), `Result should include transcript text. Got: ${result}`);
      assert.ok(result.includes('Voice message'), `Result should include kind label. Got: ${result}`);
      assert.ok(result.includes('test caption'), `Result should include caption. Got: ${result}`);
    });

    it('delegates to formatFailedTranscriptUserText for !ok result', () => {
      const vr: VoiceResult = {
        ok: false,
        reason: 'download-failed',
        message: 'Failed to download audio file',
      };

      const descriptor = {
        kind: 'voice' as AudioAttachmentKind,
        caption: 'test caption',
        forwardedFrom: 'John Doe',
        messageDate: '2026-08-15T10:00:00Z',
      };

      const result = userTextFromVoiceResult(vr, descriptor);

      assert.ok(result.includes('transcription failed'), `Result should include "transcription failed". Got: ${result}`);
      assert.ok(result.includes('could not be downloaded'), `Result should include human-readable failure message. Got: ${result}`);
    });

    it('propagates descriptor fields correctly', () => {
      const vr: VoiceResult = {
        ok: true,
        text: 'forwarded content',
        engine: 'whisper',
        mode: 'spawn',
        audioPath: '/path/to/file.oga',
        elapsedMs: 1000,
        truncated: false,
      };

      const descriptor = {
        kind: 'voice' as AudioAttachmentKind,
        caption: 'my caption',
        forwardedFrom: 'Alice',
        messageDate: '2026-08-15',
      };

      const result = userTextFromVoiceResult(vr, descriptor);

      assert.ok(result.includes('forwarded from Alice'), `Result should include forwarded-from. Got: ${result}`);
      assert.ok(result.includes('my caption'), `Result should include caption. Got: ${result}`);
    });
  });

  describe('prefetch map lifecycle', () => {
    it('lookupPrefetch returns undefined for nonexistent key', () => {
      const result = lookupPrefetch('nonexistent', 999);
      assert.equal(result, undefined);
    });

    it('consumePrefetch returns undefined for nonexistent key', () => {
      const result = consumePrefetch('nonexistent', 999);
      assert.equal(result, undefined);
    });

    it('clearPrefetch is a no-op for nonexistent key', () => {
      assert.doesNotThrow(() => clearPrefetch('nonexistent', 999));
    });

    it('startPrefetch stores a promise, lookupPrefetch retrieves it', async () => {
      const mockDeps = {
        repoRoot: 'D:/test',
        env: { ...process.env, PA_VOICE_TRANSCRIBE_TIMEOUT_MS: '50' },
        transcription: undefined,
      };
      const mockMedia = {
        file_id: 'test123',
        file_unique_id: 'uniq123',
        duration: 10,
      };

      startPrefetch('1_0', 100, 'invalid-token', 123, mockMedia, mockDeps, 'voice', {
        kind: 'voice',
      });

      const stored = lookupPrefetch('1_0', 100);
      assert.ok(stored);
      assert.equal(typeof stored?.then, 'function');

      clearPrefetch('1_0', 100);
    });

    it('consumePrefetch deletes the entry', async () => {
      const mockDeps = {
        repoRoot: 'D:/test',
        env: { ...process.env, PA_VOICE_TRANSCRIBE_TIMEOUT_MS: '50' },
        transcription: undefined,
      };
      const mockMedia = {
        file_id: 'test123',
        file_unique_id: 'uniq123',
        duration: 10,
      };

      startPrefetch('1_0', 100, 'invalid-token', 123, mockMedia, mockDeps, 'voice', {
        kind: 'voice',
      });

      const consumed = consumePrefetch('1_0', 100);
      assert.ok(consumed);

      const afterConsume = lookupPrefetch('1_0', 100);
      assert.equal(afterConsume, undefined);
    });

    it('clearPrefetch deletes without awaiting', async () => {
      const mockDeps = {
        repoRoot: 'D:/test',
        env: { ...process.env, PA_VOICE_TRANSCRIBE_TIMEOUT_MS: '50' },
        transcription: undefined,
      };
      const mockMedia = {
        file_id: 'test123',
        file_unique_id: 'uniq123',
        duration: 10,
      };

      startPrefetch('1_0', 100, 'invalid-token', 123, mockMedia, mockDeps, 'voice', {
        kind: 'voice',
      });

      const beforeClear = lookupPrefetch('1_0', 100);
      assert.ok(beforeClear);

      clearPrefetch('1_0', 100);

      const afterClear = lookupPrefetch('1_0', 100);
      assert.equal(afterClear, undefined);
    });

    it('_clearPrefetchForTest clears all entries', async () => {
      const mockDeps = {
        repoRoot: 'D:/test',
        env: { ...process.env, PA_VOICE_TRANSCRIBE_TIMEOUT_MS: '50' },
        transcription: undefined,
      };
      const mockMedia = {
        file_id: 'test123',
        file_unique_id: 'uniq123',
        duration: 10,
      };

      startPrefetch('1_0', 100, 'invalid-token', 123, mockMedia, mockDeps, 'voice', {
        kind: 'voice',
      });
      startPrefetch('2_0', 200, 'invalid-token', 456, mockMedia, mockDeps, 'audio', {
        kind: 'audio',
      });

      assert.ok(lookupPrefetch('1_0', 100));
      assert.ok(lookupPrefetch('2_0', 200));

      _clearPrefetchForTest();

      assert.equal(lookupPrefetch('1_0', 100), undefined);
      assert.equal(lookupPrefetch('2_0', 200), undefined);
    });

    it('startPrefetch is idempotent: same key overwrites', async () => {
      const mockDeps = {
        repoRoot: 'D:/test',
        env: { ...process.env, PA_VOICE_TRANSCRIBE_TIMEOUT_MS: '50' },
        transcription: undefined,
      };
      const mockMedia = {
        file_id: 'test123',
        file_unique_id: 'uniq123',
        duration: 10,
      };

      startPrefetch('1_0', 100, 'invalid-token', 123, mockMedia, mockDeps, 'voice', {
        kind: 'voice',
      });
      const first = lookupPrefetch('1_0', 100);

      startPrefetch('1_0', 100, 'invalid-token', 123, mockMedia, mockDeps, 'voice', {
        kind: 'voice',
      });
      const second = lookupPrefetch('1_0', 100);

      assert.ok(first);
      assert.ok(second);
      assert.notEqual(first, second);

      clearPrefetch('1_0', 100);
    });

    it('startPrefetch never throws', async () => {
      const mockDeps = {
        repoRoot: 'D:/test',
        env: { ...process.env, PA_VOICE_TRANSCRIBE_TIMEOUT_MS: '50' },
        transcription: undefined,
      };
      const mockMedia = {
        file_id: 'test123',
        file_unique_id: 'uniq123',
        duration: 10,
      };

      assert.doesNotThrow(() => {
        startPrefetch('1_0', 100, 'invalid-token', 123, mockMedia, mockDeps, 'voice', {
          kind: 'voice',
        });
      });

      const stored = lookupPrefetch('1_0', 100);
      assert.ok(stored);

      clearPrefetch('1_0', 100);
    });
  });
});
