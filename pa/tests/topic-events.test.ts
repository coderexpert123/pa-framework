import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { paHome } from '../src/paths.js';
import { appendTask } from '../src/lib/topic-tasks.js';
import {
  appendTopicEvent,
  readTopicEvents,
  resolveTopicKey,
  TOPIC_EVENT_MAX_DETAIL_CHARS,
  type TopicEvent,
  type TopicEventKind,
} from '../src/lib/topic-events.js';

describe('topic-events', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  describe('appendTopicEvent', () => {
    it('event append and read round-trip UTF-8', async () => {
      const detail = 'Queue — नमस्ते ✓ <title & "quotes">';
      await appendTopicEvent(123, 310, { kind: 'task_queued', ref: 'tt-abc123', detail });

      const events = await readTopicEvents(123, 310);
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, 'task_queued');
      assert.equal(events[0].ref, 'tt-abc123');
      assert.equal(events[0].detail, detail);
      assert.match(events[0].ts, /^\d{4}-\d{2}-\d{2}T/);

      // The file itself is UTF-8 JSONL: one line, newline-terminated.
      const raw = await readFile(join(paHome(), 'topic-events', '123_310.jsonl'), 'utf8');
      assert.ok(raw.endsWith('\n'));
      const lines = raw.split('\n').filter((l) => l.trim());
      assert.equal(lines.length, 1);
      const parsed = JSON.parse(lines[0]) as TopicEvent;
      assert.equal(parsed.detail, detail);
    });

    it('rejects an unknown kind', async () => {
      await assert.rejects(
        appendTopicEvent(1, 0, { kind: 'not_a_kind' as never }),
        /unknown topic event kind/,
      );
    });

    it('defaults ref to null and truncates detail to 200 chars', async () => {
      await appendTopicEvent(1, 0, { kind: 'wave_done', detail: 'x'.repeat(300) });
      const events = await readTopicEvents(1, 0);
      assert.equal(events[0].ref, null);
      assert.equal(events[0].detail.length, TOPIC_EVENT_MAX_DETAIL_CHARS);
    });
  });

  describe('readTopicEvents', () => {
    it('reads an absent file as empty', async () => {
      assert.deepEqual(await readTopicEvents(1, 0), []);
    });

    it('returns at most the newest `limit` events, newest LAST', async () => {
      for (let i = 1; i <= 5; i++) {
        await appendTopicEvent(1, 0, { kind: 'note_added', ref: `k${i}`, detail: `d${i}` });
      }
      const last3 = await readTopicEvents(1, 0, 3);
      assert.deepEqual(last3.map((e) => e.ref), ['k3', 'k4', 'k5']);
      // Default limit is 20.
      assert.equal((await readTopicEvents(1, 0)).length, 5);
    });

    it('tolerant reader skips blank and malformed lines without throwing', async () => {
      await appendTopicEvent(1, 0, { kind: 'task_queued', ref: 'a', detail: 'first' });
      const path = join(paHome(), 'topic-events', '1_0.jsonl');
      // Corrupt the file by hand: valid line, blank line, garbage line, valid line.
      await appendTopicEvent(1, 0, { kind: 'note_added', ref: 'b', detail: 'second' });
      const raw = await readFile(path, 'utf8');
      await rm(path);
      await appendFile(path, `${raw}\n\n{garbage\n`, 'utf8');
      await appendTopicEvent(1, 0, { kind: 'note_added', ref: 'c', detail: 'third' });

      const events = await readTopicEvents(1, 0);
      assert.deepEqual(events.map((e) => e.ref), ['a', 'b', 'c']);
    });
  });

  describe('resolveTopicKey', () => {
    it('resolves <chatId>_<threadId> directly, even with no stores on disk', async () => {
      assert.deepEqual(await resolveTopicKey('123_310'), { chatId: 123, threadId: 310 });
      assert.deepEqual(await resolveTopicKey('-100123_310'), { chatId: -100123, threadId: 310 });
      assert.deepEqual(await resolveTopicKey(' 123_310 '), { chatId: 123, threadId: 310 });
    });

    it('resolveTopicKey bare thread id unique match', async () => {
      // Unique match via the topic-tasks store.
      await appendTask(123, 310, { title: 'T', prompt: 'P', createdBy: 'cli' });
      assert.deepEqual(await resolveTopicKey('310'), { chatId: 123, threadId: 310 });

      // Unique match via the topic-events store alone.
      await appendTopicEvent(456, 777, { kind: 'wave_done' });
      assert.deepEqual(await resolveTopicKey('777'), { chatId: 456, threadId: 777 });

      // Unique match via a topic-brains DIRECTORY alone.
      await mkdir(join(paHome(), 'topic-brains', '789_888'), { recursive: true });
      assert.deepEqual(await resolveTopicKey('888'), { chatId: 789, threadId: 888 });

      // Ambiguous across stores → null.
      await appendTopicEvent(456, 310, { kind: 'wave_done' });
      assert.equal(await resolveTopicKey('310'), null);

      // Absent → null. Non-thread input → null.
      assert.equal(await resolveTopicKey('999'), null);
      assert.equal(await resolveTopicKey('hello'), null);
    });
  });

  describe('Wave 2 executor-lane kinds (SPEC §3.1 A.2)', () => {
    it('task_parked / task_resumed / task_completed round-trip', async () => {
      await appendTopicEvent(123, 310, { kind: 'task_parked', ref: 'tt-abc123def456', detail: 'Prefer A or B?' });
      await appendTopicEvent(123, 310, { kind: 'task_resumed', ref: 'tt-abc123def456', detail: 'second try' });
      await appendTopicEvent(123, 310, { kind: 'task_completed', ref: 'tt-abc123def456', detail: 'the title' });
      const events = await readTopicEvents(123, 310);
      assert.deepEqual(events.map((e) => e.kind), ['task_parked', 'task_resumed', 'task_completed']);
    });

    it('unknown kinds still throw (closed enum)', async () => {
      await assert.rejects(
        appendTopicEvent(123, 310, { kind: 'task_exorcised' as TopicEventKind }),
        /unknown topic event kind/,
      );
    });
  });
});
