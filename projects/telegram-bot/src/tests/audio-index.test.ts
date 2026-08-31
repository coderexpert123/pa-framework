import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { rmRetry } from './rm-retry.js';

let tempDir: string;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'audio-index-test-'));
});

after(async () => {
  await rmRetry(tempDir);
});

// Dynamic import after tempDir is set — functions inject the root explicitly,
// but the module itself imports voice.ts which uses paHome().
const {
  audioIndexRoot,
  recordAudioMessage,
  markAudioResult,
  loadAudioIndex,
  selectRetranscribeTarget,
  describeAudioTarget,
} = await import('../audio-index.js');
type AudioIndexEntry = import('../audio-index.js').AudioIndexEntry;

const { KIND_LABEL } = await import('../voice.js');
type TelegramAudioLike = import('../voice.js').TelegramAudioLike;
type AudioAttachmentKind = import('../voice.js').AudioAttachmentKind;

const CHAT_ID = -1001234;

describe('recordAudioMessage', () => {
  it('creates the index with version 1 and the entry as pending', async () => {
    const root = join(tempDir, 'attachments-1');
    const media: TelegramAudioLike = {
      file_id: 'fake-file-id',
      file_unique_id: 'unique-1',
      file_size: 12345,
      duration: 5,
    };
    await recordAudioMessage(root, CHAT_ID, {
      messageId: 101,
      threadId: null,
      kind: 'voice',
      media,
      date: '2026-08-31T12:00:00Z',
    });

    const indexPath = join(root, String(CHAT_ID), 'audio-index.json');
    assert.ok(existsSync(indexPath));
    const raw = await readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.version, 1);
    assert.strictEqual(parsed.entries.length, 1);
    assert.strictEqual(parsed.entries[0].status, 'pending');
    assert.strictEqual(parsed.entries[0].messageId, 101);
    assert.strictEqual(parsed.entries[0].threadId, null);
    assert.strictEqual(parsed.entries[0].kind, 'voice');
    assert.deepStrictEqual(parsed.entries[0].media, media);
    assert.strictEqual(parsed.entries[0].date, '2026-08-31T12:00:00Z');
  });

  it('upserts by file_unique_id: a re-sent note replaces, keeps the newest date, resets status', async () => {
    const root = join(tempDir, 'attachments-2');
    const media: TelegramAudioLike = {
      file_id: 'fake-file-id',
      file_unique_id: 'unique-2',
      file_size: 12345,
      duration: 5,
    };

    await recordAudioMessage(root, CHAT_ID, {
      messageId: 102,
      threadId: null,
      kind: 'voice',
      media,
      date: '2026-08-31T10:00:00Z',
    });

    await markAudioResult(root, CHAT_ID, 'unique-2', 'ok', { engine: 'groq' });

    await recordAudioMessage(root, CHAT_ID, {
      messageId: 103,
      threadId: null,
      kind: 'voice',
      media,
      date: '2026-08-31T12:00:00Z',
    });

    const index = await loadAudioIndex(root, CHAT_ID);
    assert.strictEqual(index.entries.length, 1);
    assert.strictEqual(index.entries[0].date, '2026-08-31T12:00:00Z');
    assert.strictEqual(index.entries[0].status, 'pending');
    assert.strictEqual(index.entries[0].engine, undefined);
  });

  it('prunes to the 25 newest by date', async () => {
    const root = join(tempDir, 'attachments-3');
    for (let i = 0; i < 27; i++) {
      const media: TelegramAudioLike = {
        file_id: `file-${i}`,
        file_unique_id: `unique-${i}`,
        file_size: 1000 + i,
        duration: 5,
      };
      await recordAudioMessage(root, CHAT_ID, {
        messageId: 200 + i,
        threadId: null,
        kind: 'voice',
        media,
        date: `2026-08-31T${String(i).padStart(2, '0')}:00:00Z`,
      });
    }

    const index = await loadAudioIndex(root, CHAT_ID);
    assert.strictEqual(index.entries.length, 25);
    // The two oldest dates (00 and 01) should be gone
    const dates = index.entries.map((e) => e.date).sort();
    assert.ok(!dates.includes('2026-08-31T00:00:00Z'));
    assert.ok(!dates.includes('2026-08-31T01:00:00Z'));
    assert.ok(dates.includes('2026-08-31T02:00:00Z'));
  });

  it('prune tie-break: equal dates keep the highest messageIds', async () => {
    const root = join(tempDir, 'attachments-3b');
    for (let i = 0; i < 27; i++) {
      const media: TelegramAudioLike = {
        file_id: `file-tie-${i}`,
        file_unique_id: `unique-tie-${i}`,
        file_size: 1000 + i,
        duration: 5,
      };
      await recordAudioMessage(root, CHAT_ID, {
        messageId: 500 + i,
        threadId: null,
        kind: 'voice',
        media,
        date: '2026-08-31T12:00:00Z',
      });
    }

    const index = await loadAudioIndex(root, CHAT_ID);
    assert.strictEqual(index.entries.length, 25);
    const ids = index.entries.map((e) => e.messageId);
    // All dates equal → prune order is messageId DESC: the two LOWEST ids go.
    assert.ok(!ids.includes(500));
    assert.ok(!ids.includes(501));
    assert.ok(ids.includes(502));
    assert.ok(ids.includes(526));
  });

  it('survives an unwritable root without throwing', async () => {
    const root = join(tempDir, 'attachments-4');
    // Make root a file instead of a directory
    await writeFile(root, 'not a directory');
    const media: TelegramAudioLike = {
      file_id: 'fake-file-id',
      file_unique_id: 'unique-5',
      file_size: 12345,
      duration: 5,
    };
    await assert.doesNotReject(
      recordAudioMessage(root, CHAT_ID, {
        messageId: 105,
        threadId: null,
        kind: 'voice',
        media,
        date: '2026-08-31T12:00:00Z',
      })
    );
  });

  it('recovers on the next write after a failed one (chain not poisoned)', async () => {
    const root = join(tempDir, 'attachments-4b');
    await writeFile(root, 'not a directory'); // mkdir inside fails while root is a file
    await recordAudioMessage(root, CHAT_ID, {
      messageId: 108,
      threadId: null,
      kind: 'voice',
      media: { file_id: 'f', file_unique_id: 'unique-recover', file_size: 1, duration: 5 },
      date: '2026-08-31T12:00:00Z',
    });

    await rm(root); // unblock the same root|chatId write chain
    await recordAudioMessage(root, CHAT_ID, {
      messageId: 109,
      threadId: null,
      kind: 'voice',
      media: { file_id: 'f2', file_unique_id: 'unique-recover-2', file_size: 1, duration: 5 },
      date: '2026-08-31T12:01:00Z',
    });

    const index = await loadAudioIndex(root, CHAT_ID);
    assert.strictEqual(index.entries.length, 1); // the failed attempt wrote nothing
    assert.strictEqual(index.entries[0].messageId, 109);
  });

  it('serializes concurrent records without losing writes', async () => {
    const root = join(tempDir, 'attachments-5');
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      const media: TelegramAudioLike = {
        file_id: `file-${i}`,
        file_unique_id: `unique-concurrent-${i}`,
        file_size: 1000 + i,
        duration: 5,
      };
      promises.push(
        recordAudioMessage(root, CHAT_ID, {
          messageId: 300 + i,
          threadId: null,
          kind: 'voice',
          media,
          date: `2026-08-31T12:00:00Z`,
        })
      );
    }
    await Promise.all(promises);

    const index = await loadAudioIndex(root, CHAT_ID);
    assert.strictEqual(index.entries.length, 10);
  });
});

describe('markAudioResult', () => {
  it('ok sets engine and clears reason', async () => {
    const root = join(tempDir, 'attachments-6');
    const media: TelegramAudioLike = {
      file_id: 'fake-file-id',
      file_unique_id: 'unique-6',
      file_size: 12345,
      duration: 5,
    };
    await recordAudioMessage(root, CHAT_ID, {
      messageId: 106,
      threadId: null,
      kind: 'voice',
      media,
      date: '2026-08-31T12:00:00Z',
    });

    await markAudioResult(root, CHAT_ID, 'unique-6', 'ok', { engine: 'groq' });

    const index = await loadAudioIndex(root, CHAT_ID);
    assert.strictEqual(index.entries[0].status, 'ok');
    assert.strictEqual(index.entries[0].engine, 'groq');
    assert.strictEqual(index.entries[0].reason, undefined);
  });

  it('failed sets reason and clears engine', async () => {
    const root = join(tempDir, 'attachments-7');
    const media: TelegramAudioLike = {
      file_id: 'fake-file-id',
      file_unique_id: 'unique-7',
      file_size: 12345,
      duration: 5,
    };
    await recordAudioMessage(root, CHAT_ID, {
      messageId: 107,
      threadId: null,
      kind: 'voice',
      media,
      date: '2026-08-31T12:00:00Z',
    });

    await markAudioResult(root, CHAT_ID, 'unique-7', 'failed', { reason: 'timeout' });

    const index = await loadAudioIndex(root, CHAT_ID);
    assert.strictEqual(index.entries[0].status, 'failed');
    assert.strictEqual(index.entries[0].reason, 'timeout');
    assert.strictEqual(index.entries[0].engine, undefined);
  });

  it('is a no-op, not an error, when the entry or file is missing', async () => {
    const root = join(tempDir, 'attachments-8');
    // Unknown fileUniqueId - should resolve without error
    await assert.doesNotReject(markAudioResult(root, CHAT_ID, 'unknown-unique', 'ok', { engine: 'groq' }));

    // Never-recorded chat - should resolve without error and create no file
    const unknownChat = -9999999;
    await assert.doesNotReject(markAudioResult(root, unknownChat, 'unknown-unique', 'ok', { engine: 'groq' }));
    assert.ok(!existsSync(join(root, String(unknownChat), 'audio-index.json')));
  });
});

describe('loadAudioIndex', () => {
  it('missing file → {version:1, entries:[]}', async () => {
    const root = join(tempDir, 'attachments-9');
    const index = await loadAudioIndex(root, CHAT_ID);
    assert.strictEqual(index.version, 1);
    assert.deepStrictEqual(index.entries, []);
  });

  it('corrupt JSON → {version:1, entries:[]}', async () => {
    const root = join(tempDir, 'attachments-10');
    const indexPath = join(root, String(CHAT_ID), 'audio-index.json');
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, 'not json', 'utf-8');

    const index = await loadAudioIndex(root, CHAT_ID);
    assert.strictEqual(index.version, 1);
    assert.deepStrictEqual(index.entries, []);
  });

  it('wrong-version shape → empty', async () => {
    const root = join(tempDir, 'attachments-11');
    const indexPath = join(root, String(CHAT_ID), 'audio-index.json');
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, JSON.stringify({ version: 2, entries: [] }), 'utf-8');

    const index = await loadAudioIndex(root, CHAT_ID);
    assert.strictEqual(index.version, 1);
    assert.deepStrictEqual(index.entries, []);
  });

  it('round-trips what recordAudioMessage wrote', async () => {
    const root = join(tempDir, 'attachments-12');
    const media: TelegramAudioLike = {
      file_id: 'fake-file-id',
      file_unique_id: 'unique-12',
      file_size: 12345,
      duration: 5,
    };
    await recordAudioMessage(root, CHAT_ID, {
      messageId: 112,
      threadId: 5,
      kind: 'audio',
      media,
      date: '2026-08-31T12:00:00Z',
    });

    const index = await loadAudioIndex(root, CHAT_ID);
    assert.strictEqual(index.version, 1);
    assert.strictEqual(index.entries.length, 1);
    const entry = index.entries[0];
    assert.strictEqual(entry.messageId, 112);
    assert.strictEqual(entry.threadId, 5);
    assert.strictEqual(entry.kind, 'audio');
    assert.deepStrictEqual(entry.media, media);
    assert.strictEqual(entry.date, '2026-08-31T12:00:00Z');
  });
});

describe('selectRetranscribeTarget', () => {
  it('empty entries → undefined', () => {
    const result = selectRetranscribeTarget([], null);
    assert.strictEqual(result, undefined);
  });

  it('thread scoping: null matches null, a number matches only itself', () => {
    const entries: AudioIndexEntry[] = [
      {
        messageId: 201,
        threadId: 5,
        kind: 'voice',
        media: { file_id: 'f1', file_unique_id: 'u1', file_size: 1000, duration: 5 },
        date: '2026-08-31T12:00:00Z',
        status: 'ok',
      },
      {
        messageId: 202,
        threadId: null,
        kind: 'voice',
        media: { file_id: 'f2', file_unique_id: 'u2', file_size: 1000, duration: 5 },
        date: '2026-08-31T11:00:00Z',
        status: 'ok',
      },
    ];
    assert.strictEqual(selectRetranscribeTarget(entries, null)?.messageId, 202);
    assert.strictEqual(selectRetranscribeTarget(entries, 5)?.messageId, 201);
    assert.strictEqual(selectRetranscribeTarget(entries, 9), undefined);
  });

  it('prefers the newest non-ok entry over a newer ok one in the same thread', () => {
    const entries: AudioIndexEntry[] = [
      {
        messageId: 203,
        threadId: null,
        kind: 'voice',
        media: { file_id: 'f1', file_unique_id: 'u1', file_size: 1000, duration: 5 },
        date: '2026-08-31T12:00:00Z',
        status: 'ok',
      },
      {
        messageId: 204,
        threadId: null,
        kind: 'voice',
        media: { file_id: 'f2', file_unique_id: 'u2', file_size: 1000, duration: 5 },
        date: '2026-08-31T11:00:00Z',
        status: 'failed',
      },
    ];
    const result = selectRetranscribeTarget(entries, null);
    assert.strictEqual(result?.messageId, 204);
  });

  it('falls back to the newest ok entry when every entry is ok', () => {
    const entries: AudioIndexEntry[] = [
      {
        messageId: 205,
        threadId: null,
        kind: 'voice',
        media: { file_id: 'f1', file_unique_id: 'u1', file_size: 1000, duration: 5 },
        date: '2026-08-31T12:00:00Z',
        status: 'ok',
      },
      {
        messageId: 206,
        threadId: null,
        kind: 'voice',
        media: { file_id: 'f2', file_unique_id: 'u2', file_size: 1000, duration: 5 },
        date: '2026-08-31T11:00:00Z',
        status: 'ok',
      },
    ];
    const result = selectRetranscribeTarget(entries, null);
    assert.strictEqual(result?.messageId, 205);
  });

  it('among non-ok entries, newest by date wins', () => {
    const entries: AudioIndexEntry[] = [
      {
        messageId: 207,
        threadId: null,
        kind: 'voice',
        media: { file_id: 'f1', file_unique_id: 'u1', file_size: 1000, duration: 5 },
        date: '2026-08-31T10:00:00Z',
        status: 'failed',
      },
      {
        messageId: 208,
        threadId: null,
        kind: 'voice',
        media: { file_id: 'f2', file_unique_id: 'u2', file_size: 1000, duration: 5 },
        date: '2026-08-31T11:00:00Z',
        status: 'pending',
      },
      {
        messageId: 209,
        threadId: null,
        kind: 'voice',
        media: { file_id: 'f3', file_unique_id: 'u3', file_size: 1000, duration: 5 },
        date: '2026-08-31T12:00:00Z',
        status: 'ok',
      },
    ];
    const result = selectRetranscribeTarget(entries, null);
    assert.strictEqual(result?.messageId, 208);
  });

  it('pending and failed both count as non-ok', () => {
    const entries: AudioIndexEntry[] = [
      {
        messageId: 210,
        threadId: null,
        kind: 'voice',
        media: { file_id: 'f1', file_unique_id: 'u1', file_size: 1000, duration: 5 },
        date: '2026-08-31T11:00:00Z',
        status: 'failed',
      },
      {
        messageId: 211,
        threadId: null,
        kind: 'voice',
        media: { file_id: 'f2', file_unique_id: 'u2', file_size: 1000, duration: 5 },
        date: '2026-08-31T10:00:00Z',
        status: 'pending',
      },
    ];
    const result = selectRetranscribeTarget(entries, null);
    assert.strictEqual(result?.messageId, 210);
  });
});

describe('describeAudioTarget', () => {
  it('labels come from voice.ts KIND_LABEL (no duplicate table)', () => {
    const kinds: AudioAttachmentKind[] = ['voice', 'audio', 'video_note'];
    for (const kind of kinds) {
      const entry: AudioIndexEntry = {
        messageId: 1,
        threadId: null,
        kind,
        media: { file_id: 'f', file_unique_id: 'u', file_size: 1000, duration: 5 },
        date: '2026-08-31T12:00:00Z',
        status: 'pending',
      };
      const label = KIND_LABEL[kind];
      assert.ok(describeAudioTarget(entry).startsWith(`${label}, `));
    }
  });

  it('age buckets: just now / N min ago / N h ago / N d ago', () => {
    const now = new Date('2026-08-31T12:00:00Z');
    const entry: AudioIndexEntry = {
      messageId: 1,
      threadId: null,
      kind: 'voice',
      media: { file_id: 'f', file_unique_id: 'u', file_size: 1000, duration: 5 },
      date: '',
      status: 'pending',
    };

    entry.date = '2026-08-31T11:59:30Z'; // -30s
    assert.strictEqual(describeAudioTarget(entry, now), 'Voice message, just now');

    entry.date = '2026-08-31T11:55:00Z'; // -5m
    assert.strictEqual(describeAudioTarget(entry, now), 'Voice message, 5 min ago');

    entry.date = '2026-08-31T09:00:00Z'; // -3h
    assert.strictEqual(describeAudioTarget(entry, now), 'Voice message, 3 h ago');

    entry.date = '2026-08-29T12:00:00Z'; // -2d
    assert.strictEqual(describeAudioTarget(entry, now), 'Voice message, 2 d ago');

    entry.date = '2026-09-01T12:00:00Z'; // future date
    assert.strictEqual(describeAudioTarget(entry, now), 'Voice message, just now');
  });

  it('exact composed string', () => {
    const entry: AudioIndexEntry = {
      messageId: 1,
      threadId: null,
      kind: 'voice',
      media: { file_id: 'f', file_unique_id: 'u', file_size: 1000, duration: 5 },
      date: '2026-08-31T11:57:00Z', // 3 min before now
      status: 'pending',
    };
    const now = new Date('2026-08-31T12:00:00Z');
    assert.strictEqual(describeAudioTarget(entry, now), 'Voice message, 3 min ago');
  });
});
