import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerQueuedUpdate,
  dequeueUpdate,
  drainQueuedText,
  _clearQueueForTest,
  type QueueEntry,
} from '../topic-queue.js';

beforeEach(() => _clearQueueForTest());

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
