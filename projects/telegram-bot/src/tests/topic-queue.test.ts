import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerQueuedUpdate,
  dequeueUpdate,
  drainQueuedText,
  drainQueuedEntries,
  addHeldEntry,
  absorbHeldEntries,
  _clearQueueForTest,
  _clearHeldForTest,
  type QueueEntry,
  type HeldItem,
} from '../topic-queue.js';

beforeEach(() => {
  _clearQueueForTest();
  _clearHeldForTest();
});

describe('registerQueuedUpdate', () => {
  it('builds an entry with isCommand=false for plain text', () => {
    const entry = registerQueuedUpdate('1_0', 1, 'hello there');
    assert.equal(entry.updateId, 1);
    assert.equal(entry.text, 'hello there');
    assert.equal(entry.isCommand, false);
    assert.equal(entry.cancelled, false);
  });

  it('builds an entry with isCommand=true for a slash-command, even with leading/trailing whitespace', () => {
    const entry = registerQueuedUpdate('1_0', 2, '  /reset  ');
    assert.equal(entry.isCommand, true);
  });

  it('multiple registrations for the same topic accumulate in arrival order', () => {
    const e1 = registerQueuedUpdate('1_0', 1, 'first');
    const e2 = registerQueuedUpdate('1_0', 2, 'second');
    const e3 = registerQueuedUpdate('1_0', 3, 'third');
    assert.deepEqual(drainQueuedText('1_0'), ['first', 'second', 'third']);
    // Draining doesn't reorder — sanity-check the entries themselves too.
    assert.equal(e1.text, 'first');
    assert.equal(e2.text, 'second');
    assert.equal(e3.text, 'third');
  });

  it('different topics get independent queues', () => {
    registerQueuedUpdate('1_0', 1, 'topic A msg');
    registerQueuedUpdate('2_0', 2, 'topic B msg');
    assert.deepEqual(drainQueuedText('1_0'), ['topic A msg']);
    assert.deepEqual(drainQueuedText('2_0'), ['topic B msg']);
  });
});

describe('dequeueUpdate', () => {
  it('removes the given entry from the topic array', () => {
    const e1 = registerQueuedUpdate('1_0', 1, 'first');
    const e2 = registerQueuedUpdate('1_0', 2, 'second');
    dequeueUpdate('1_0', e1);
    // Only e2 remains, so draining should yield just 'second'.
    assert.deepEqual(drainQueuedText('1_0'), ['second']);
  });

  it('deletes the topic map entry once its array empties', () => {
    const e1 = registerQueuedUpdate('1_0', 1, 'only one');
    dequeueUpdate('1_0', e1);
    // Topic no longer tracked at all — draining an absent topic is a no-op.
    assert.deepEqual(drainQueuedText('1_0'), []);
  });

  it('is a no-op for an unknown topic or an entry not present', () => {
    assert.doesNotThrow(() => dequeueUpdate('nonexistent_0', { updateId: 1, text: 'x', isCommand: false, cancelled: false }));
    const e1 = registerQueuedUpdate('1_0', 1, 'first');
    dequeueUpdate('1_0', e1);
    // Dequeuing the same (already-removed) entry again must not throw.
    assert.doesNotThrow(() => dequeueUpdate('1_0', e1));
  });
});

describe('drainQueuedText', () => {
  it('returns [] and no-ops for a topic with no queued entries', () => {
    assert.deepEqual(drainQueuedText('nonexistent_0'), []);
  });

  it('cancels and collects only non-command entries, in original order', () => {
    registerQueuedUpdate('1_0', 1, 'part one');
    registerQueuedUpdate('1_0', 2, 'part two');
    const texts = drainQueuedText('1_0');
    assert.deepEqual(texts, ['part one', 'part two']);
  });

  it('leaves command entries in place, untouched (not cancelled, still in queue)', () => {
    const textEntry = registerQueuedUpdate('1_0', 1, 'fold me');
    const cmdEntry = registerQueuedUpdate('1_0', 2, '/reset');
    const texts = drainQueuedText('1_0');
    assert.deepEqual(texts, ['fold me']);
    assert.equal(textEntry.cancelled, true);
    assert.equal(cmdEntry.cancelled, false, 'command entry must never be cancelled');
    // The command entry must still be dequeueable normally afterward.
    dequeueUpdate('1_0', cmdEntry);
    assert.deepEqual(drainQueuedText('1_0'), [], 'topic should be empty after the command entry is dequeued too');
  });

  it('skips empty-text entries when collecting, but still cancels them', () => {
    const emptyEntry = registerQueuedUpdate('1_0', 1, '');
    registerQueuedUpdate('1_0', 2, 'has text');
    const texts = drainQueuedText('1_0');
    assert.deepEqual(texts, ['has text']);
    assert.equal(emptyEntry.cancelled, true, 'an empty-text entry is still cancelled even though its text is skipped');
  });

  it('deletes the map entry when every queued item was foldable (no commands left behind)', () => {
    registerQueuedUpdate('1_0', 1, 'a');
    registerQueuedUpdate('1_0', 2, 'b');
    drainQueuedText('1_0');
    // A second drain call on the now-empty/absent topic must return [].
    assert.deepEqual(drainQueuedText('1_0'), []);
  });

  it('a second drainQueuedText call after one drain only sees newly registered entries', () => {
    registerQueuedUpdate('1_0', 1, 'first batch');
    assert.deepEqual(drainQueuedText('1_0'), ['first batch']);
    registerQueuedUpdate('1_0', 2, 'second batch');
    assert.deepEqual(drainQueuedText('1_0'), ['second batch']);
  });
});

describe('drainQueuedEntries', () => {
  it('returns full QueueEntry objects, not just texts', () => {
    const e1 = registerQueuedUpdate('1_0', 1, 'first');
    const e2 = registerQueuedUpdate('1_0', 2, 'second');

    const entries = drainQueuedEntries('1_0');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].updateId, 1);
    assert.equal(entries[0].text, 'first');
    assert.equal(entries[1].updateId, 2);
    assert.equal(entries[1].text, 'second');
  });

  it('preserves voice field on QueueEntry when present', () => {
    const e1 = registerQueuedUpdate('1_0', 1, 'voice text');
    // Simulate voice field being set (would be set by enqueue block in main.ts)
    (e1 as any).voice = {
      promise: Promise.resolve({
        ok: true,
        text: 'transcript',
        engine: 'test',
        mode: 'spawn',
        audioPath: '/path.oga',
        elapsedMs: 1000,
        truncated: false,
      }),
      descriptor: { kind: 'voice', caption: 'test' },
    };

    const entries = drainQueuedEntries('1_0');
    assert.equal(entries.length, 1);
    assert.ok(entries[0].voice);
    assert.equal(entries[0].voice?.descriptor.kind, 'voice');
    assert.equal(entries[0].voice?.descriptor.caption, 'test');
  });

  it('returns [] for absent/empty topic', () => {
    assert.deepEqual(drainQueuedEntries('nonexistent_0'), []);
  });

  it('cancels and returns only non-command entries, leaves commands in place', () => {
    const textEntry = registerQueuedUpdate('1_0', 1, 'fold me');
    const cmdEntry = registerQueuedUpdate('1_0', 2, '/reset');

    const entries = drainQueuedEntries('1_0');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].updateId, 1);
    assert.equal(textEntry.cancelled, true);
    assert.equal(cmdEntry.cancelled, false);

    // Command entry should still be in queue
    const remaining = drainQueuedEntries('1_0');
    assert.equal(remaining.length, 0, 'commands are not drained by drainQueuedEntries');
  });
});

describe('registerQueuedUpdate with isCommandOverride', () => {
  it('forces isCommand=true when isCommandOverride=true', () => {
    const entry = registerQueuedUpdate('1_0', 1, 'not a command', true);
    assert.equal(entry.isCommand, true);
  });

  it('forces isCommand=false when isCommandOverride=false', () => {
    const entry = registerQueuedUpdate('1_0', 1, '/reset', false);
    assert.equal(entry.isCommand, false);
  });

  it('uses regex derivation when isCommandOverride is undefined', () => {
    const e1 = registerQueuedUpdate('1_0', 1, '/reset');
    assert.equal(e1.isCommand, true);

    const e2 = registerQueuedUpdate('1_0', 2, 'normal text');
    assert.equal(e2.isCommand, false);
  });
});

describe('held entries', () => {
  it('addHeldEntry accumulates strings for a topic', async () => {
    addHeldEntry('1_0', 'first held');
    addHeldEntry('1_0', 'second held');
    addHeldEntry('1_0', 'third held');

    const held = await absorbHeldEntries('1_0');
    assert.deepEqual(held, ['first held', 'second held', 'third held']);
  });

  it('absorbHeldEntries is async and awaits promise items', async () => {
    // HeldItem can be {promise: Promise<VoiceResult>, descriptor}
    const mockVoiceResult: import('../voice.js').VoiceResult = {
      ok: true,
      text: 'async transcript',
      engine: 'test',
      mode: 'spawn',
      audioPath: '/path.oga',
      elapsedMs: 1000,
      truncated: false,
    };

    const mockPromise = Promise.resolve(mockVoiceResult);

    addHeldEntry('1_0', 'string item');
    addHeldEntry('1_0', {
      promise: mockPromise,
      descriptor: { kind: 'voice', caption: 'test' },
    });

    const held = await absorbHeldEntries('1_0');
    assert.equal(held.length, 2);
    assert.equal(held[0], 'string item');
    assert.ok(held[1].includes('async transcript'));
  });

  it('absorbHeldEntries returns and clears the topic list', async () => {
    addHeldEntry('1_0', 'first');
    addHeldEntry('1_0', 'second');

    const first = await absorbHeldEntries('1_0');
    assert.deepEqual(first, ['first', 'second']);

    const second = await absorbHeldEntries('1_0');
    assert.deepEqual(second, []);
  });

  it('per-topic isolation: different topics have independent held lists', async () => {
    addHeldEntry('1_0', 'topic A item');
    addHeldEntry('2_0', 'topic B item');

    const heldA = await absorbHeldEntries('1_0');
    const heldB = await absorbHeldEntries('2_0');

    assert.deepEqual(heldA, ['topic A item']);
    assert.deepEqual(heldB, ['topic B item']);
  });

  it('empty topic returns []', async () => {
    const held = await absorbHeldEntries('nonexistent_0');
    assert.deepEqual(held, []);
  });

  it('_clearHeldForTest clears all held entries', async () => {
    addHeldEntry('1_0', 'topic A');
    addHeldEntry('2_0', 'topic B');

    _clearHeldForTest();

    const heldA = await absorbHeldEntries('1_0');
    const heldB = await absorbHeldEntries('2_0');

    assert.deepEqual(heldA, []);
    assert.deepEqual(heldB, []);
  });
});
