import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, cleanup } from './helpers.js';
import { appendTopicEvent } from '../src/lib/topic-events.js';
import { listTasks, listNotes, _resetTopicTasksForTest } from '../src/lib/topic-tasks.js';
import { topicTaskCommand, topicNoteCommand, topicEventsCommand } from '../src/commands/topic.js';

/** Capture console.log/console.error while a command function runs. */
function captureConsole(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  return { out, err, restore: () => { console.log = origLog; console.error = origError; } };
}

describe('topic CLI', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
    _resetTopicTasksForTest();
  });

  afterEach(async () => {
    _resetTopicTasksForTest();
    await cleanup(dir);
  });

  describe('pa topic-task', () => {
    it('topic-task add prints queued id', async () => {
      const cap = captureConsole();
      let code: number;
      try {
        code = await topicTaskCommand(['add', '123_310', '--title', 'Wave 1 dogfood', '--prompt', 'Report one line: done.']);
      } finally {
        cap.restore();
      }
      assert.equal(code, 0);
      assert.equal(cap.out.length, 1);
      const m = /^Queued (tt-[0-9a-f]{12})$/.exec(cap.out[0]);
      assert.ok(m, `expected a Queued <id> line, got: ${cap.out[0]}`);

      // The queue holds the task and the task_queued event carries its id.
      const tasks = await listTasks(123, 310);
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].id, m![1]);
    });

    it('topic-task add dedupes a repeated queue', async () => {
      const args = ['add', '123_310', '--title', 'T', '--prompt', 'P'];
      let cap = captureConsole();
      try {
        assert.equal(await topicTaskCommand(args), 0);
      } finally {
        cap.restore();
      }
      cap = captureConsole();
      try {
        assert.equal(await topicTaskCommand(args), 0);
      } finally {
        cap.restore();
      }
      assert.equal(cap.out.length, 1);
      assert.match(cap.out[0], /^Already queued tt-[0-9a-f]{12} \(deduped\)$/);
      assert.equal((await listTasks(123, 310)).length, 1);
    });

    it('rejects an invalid prompt with exit 3', async () => {
      const cap = captureConsole();
      let code: number;
      try {
        code = await topicTaskCommand(['add', '123_310', '--title', 'T', '--prompt', 'a\nb']);
      } finally {
        cap.restore();
      }
      assert.equal(code, 3);
      assert.match(cap.err.join('\n'), /task\.prompt must be a single line/);
      assert.deepEqual(await listTasks(123, 310), []);
    });

    it('lists queued tasks', async () => {
      await topicTaskCommand(['add', '123_310', '--title', 'Feed the cat', '--prompt', 'P']);
      const cap = captureConsole();
      let code: number;
      try {
        code = await topicTaskCommand(['list', '123_310']);
      } finally {
        cap.restore();
      }
      assert.equal(code, 0);
      assert.equal(cap.out.length, 1);
      assert.match(cap.out[0], /^tt-[0-9a-f]{12}  Feed the cat/);
    });

    it('usage errors exit 2', async () => {
      let cap = captureConsole();
      try {
        assert.equal(await topicTaskCommand([]), 2);
        assert.equal(await topicTaskCommand(['add']), 2);
        assert.equal(await topicTaskCommand(['add', '123_310', '--bogus', 'x', '--title', 'T', '--prompt', 'P']), 2);
      } finally {
        cap.restore();
      }
      cap = captureConsole();
      try {
        assert.equal(await topicNoteCommand(['wat']), 2);
        assert.equal(await topicEventsCommand([]), 2);
      } finally {
        cap.restore();
      }
    });

    it('unknown or ambiguous topic key exits 3', async () => {
      let cap = captureConsole();
      let code: number;
      try {
        code = await topicEventsCommand(['999']);
      } finally {
        cap.restore();
      }
      assert.equal(code, 3);
      assert.match(cap.err.join('\n'), /unknown or ambiguous topic key/);

      // Ambiguous bare thread: two chat ids claim thread 310.
      await appendTopicEvent(456, 310, { kind: 'wave_done' });
      await appendTopicEvent(123, 310, { kind: 'wave_done' });
      cap = captureConsole();
      try {
        code = await topicTaskCommand(['list', '310']);
      } finally {
        cap.restore();
      }
      assert.equal(code, 3);
    });
  });

  describe('pa topic-note', () => {
    it('topic-note add writes an OPEN note to the store', async () => {
      const cap = captureConsole();
      let code: number;
      try {
        code = await topicNoteCommand(['add', '123_310', 'Buy milk']);
      } finally {
        cap.restore();
      }
      assert.equal(code, 0);
      assert.match(cap.out[0], /^Added n-[0-9a-f]{8} \(OPEN\)$/);

      const notes = await listNotes(123, 310);
      assert.equal(notes.length, 1);
      assert.match(notes[0].key, /^n-[0-9a-f]{8}$/);
      assert.equal(notes[0].text, 'Buy milk');
      assert.equal(notes[0].status, 'OPEN');
    });

    it('respects --key and --expires', async () => {
      let cap = captureConsole();
      try {
        assert.equal(await topicNoteCommand(['add', '123_310', 'feed the cat', '--key', 'feed-cat', '--expires', '2026-09-30']), 0);
      } finally {
        cap.restore();
      }
      const notes = await listNotes(123, 310);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].key, 'feed-cat');
      assert.equal(notes[0].text, 'feed the cat');
      assert.equal(notes[0].expires, '2026-09-30');

      // Key grammar and expiry-format validation are usage errors (exit 2).
      cap = captureConsole();
      let code: number;
      try {
        code = await topicNoteCommand(['add', '123_310', 'x', '--key', 'Bad_Key']);
      } finally {
        cap.restore();
      }
      assert.equal(code, 2);
      cap = captureConsole();
      try {
        code = await topicNoteCommand(['add', '123_310', 'x', '--expires', '09/30/2026']);
      } finally {
        cap.restore();
      }
      assert.equal(code, 2);
    });

    it('rejects a duplicate key with exit 3', async () => {
      const cap = captureConsole();
      try {
        assert.equal(await topicNoteCommand(['add', '123_310', 'one', '--key', 'dup']), 0);
        assert.equal(await topicNoteCommand(['add', '123_310', 'two', '--key', 'dup']), 3);
      } finally {
        cap.restore();
      }
      assert.match(cap.err.join('\n'), /note key already exists: dup/);
    });

    it('topic-note close flips OPEN to DONE', async () => {
      let cap = captureConsole();
      try {
        assert.equal(await topicNoteCommand(['add', '123_310', 'water the plants', '--key', 'plants']), 0);
      } finally {
        cap.restore();
      }

      cap = captureConsole();
      let code: number;
      try {
        code = await topicNoteCommand(['close', '123_310', 'plants']);
      } finally {
        cap.restore();
      }
      assert.equal(code, 0);
      let notes = await listNotes(123, 310);
      assert.equal(notes[0].status, 'DONE');

      // Closing again (already DONE) is a store rejection, exit 3.
      cap = captureConsole();
      try {
        code = await topicNoteCommand(['close', '123_310', 'plants']);
      } finally {
        cap.restore();
      }
      assert.equal(code, 3);
      assert.match(cap.err.join('\n'), /no OPEN note with key plants/);
      notes = await listNotes(123, 310);
      assert.equal(notes[0].status, 'DONE', 'still DONE after the rejected re-close');
    });

    it('topic-note list prints OPEN and DONE notes', async () => {
      let cap = captureConsole();
      try {
        assert.equal(await topicNoteCommand(['add', '123_310', 'first note', '--key', 'first']), 0);
        assert.equal(await topicNoteCommand(['add', '123_310', 'second note', '--key', 'second']), 0);
        assert.equal(await topicNoteCommand(['close', '123_310', 'first']), 0);
      } finally {
        cap.restore();
      }
      cap = captureConsole();
      let code: number;
      try {
        code = await topicNoteCommand(['list', '123_310']);
      } finally {
        cap.restore();
      }
      assert.equal(code, 0);
      assert.equal(cap.out.length, 2);
      assert.equal(cap.out[0], 'DONE first — first note');
      assert.equal(cap.out[1], 'OPEN second — second note');
    });

    it('resolves a bare thread id through the CLI', async () => {
      await appendTopicEvent(123, 310, { kind: 'wave_done' });
      const cap = captureConsole();
      let code: number;
      try {
        code = await topicNoteCommand(['add', '310', 'via bare thread']);
      } finally {
        cap.restore();
      }
      assert.equal(code, 0);
      const notes = await listNotes(123, 310);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].text, 'via bare thread');
    });
  });

  describe('pa topic-events', () => {
    it('topic-events renders newest last', async () => {
      await topicTaskCommand(['add', '123_310', '--title', 'T', '--prompt', 'P']);
      await topicNoteCommand(['add', '123_310', 'a note']);

      const cap = captureConsole();
      let code: number;
      try {
        code = await topicEventsCommand(['123_310']);
      } finally {
        cap.restore();
      }
      assert.equal(code, 0);
      // Chronological order: the task was queued before the note was added.
      assert.equal(cap.out.length, 2);
      assert.match(cap.out[0], /task_queued/);
      assert.match(cap.out[1], /note_added/);
    });

    it('prints a no-events line for a fresh topic', async () => {
      const cap = captureConsole();
      let code: number;
      try {
        code = await topicEventsCommand(['123_310']);
      } finally {
        cap.restore();
      }
      assert.equal(code, 0);
      assert.match(cap.out.join('\n'), /No events/);
    });
  });
});
