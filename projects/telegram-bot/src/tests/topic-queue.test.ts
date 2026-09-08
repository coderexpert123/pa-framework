import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerQueuedUpdate,
  dequeueUpdate,
  drainQueuedText,
  drainQueuedEntries,
  peekQueuedBatch,
  confirmQueuedBatch,
  snapshotDrained,
  addHeldEntry,
  absorbHeldEntries,
  _clearQueueForTest,
  _clearHeldForTest,
  _setLoggerForTest,
  type QueueEntry,
  type HeldItem,
} from '../topic-queue.js';

beforeEach(() => {
  _clearQueueForTest();
  _clearHeldForTest();
});

const VOICE_RESULT: import('../voice.js').VoiceResult = {
  ok: true,
  text: 'transcript text',
  engine: 'test',
  mode: 'spawn',
  audioPath: '/path.oga',
  elapsedMs: 1000,
  truncated: false,
};

/** Sets the full (AI-208 E1) voice field on an entry the way main.ts's enqueue block would. */
function setVoice(
  entry: QueueEntry,
  promise: Promise<import('../voice.js').VoiceResult>,
  media: import('../topic-queue.js').AudioMediaIdentity = { file_id: 'fid', file_unique_id: 'fuid', duration: 3 },
  kind: 'voice' | 'audio' | 'video_note' = 'voice',
): void {
  entry.voice = { promise, descriptor: { kind: 'voice' }, media, kind };
}

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
    assert.deepEqual(held, [
      { text: 'first held' },
      { text: 'second held' },
      { text: 'third held' },
    ]);
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
    assert.equal(held[0].text, 'string item');
    assert.ok(held[1].text.includes('async transcript'));
  });

  it('absorbHeldEntries carries updateId when the hold site provided one (fix-wave M1)', async () => {
    addHeldEntry('1_0', 'plain');
    addHeldEntry('1_0', {
      promise: Promise.resolve(VOICE_RESULT),
      descriptor: { kind: 'voice' },
      updateId: 42,
    });
    addHeldEntry('1_0', {
      promise: Promise.resolve(VOICE_RESULT),
      descriptor: { kind: 'voice' },
    });

    const held = await absorbHeldEntries('1_0');
    assert.deepEqual(held, [
      { text: 'plain' },
      { text: '[Voice message] transcript text', updateId: 42 },
      { text: '[Voice message] transcript text' },
    ]);
    assert.equal(held[0].updateId, undefined);
    assert.equal(held[2].updateId, undefined);
  });

  it('absorbHeldEntries carries updateId on text-object holds (FX-A addendum)', async () => {
    addHeldEntry('1_0', { text: 'held text', updateId: 7 });
    addHeldEntry('1_0', { text: 'no id' });

    const held = await absorbHeldEntries('1_0');
    assert.deepEqual(held, [
      { text: 'held text', updateId: 7 },
      { text: 'no id' },
    ]);
  });

  it('absorbHeldEntries returns and clears the topic list', async () => {
    addHeldEntry('1_0', 'first');
    addHeldEntry('1_0', 'second');

    const first = await absorbHeldEntries('1_0');
    assert.deepEqual(first, [{ text: 'first' }, { text: 'second' }]);

    const second = await absorbHeldEntries('1_0');
    assert.deepEqual(second, []);
  });

  it('per-topic isolation: different topics have independent held lists', async () => {
    addHeldEntry('1_0', 'topic A item');
    addHeldEntry('2_0', 'topic B item');

    const heldA = await absorbHeldEntries('1_0');
    const heldB = await absorbHeldEntries('2_0');

    assert.deepEqual(heldA, [{ text: 'topic A item' }]);
    assert.deepEqual(heldB, [{ text: 'topic B item' }]);
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

  it('addHeldEntry logs each hold with its length and promise-ness (AI-208 E4)', () => {
    const calls: Array<{ module: string; message: string; ctx?: Record<string, unknown> }> = [];
    _setLoggerForTest({ info: (module, message, ctx) => calls.push({ module, message, ctx }) });
    try {
      addHeldEntry('1_0', 'plain text');
      addHeldEntry('1_0', { promise: Promise.resolve(VOICE_RESULT), descriptor: { kind: 'voice' } });

      assert.equal(calls.length, 2);
      assert.equal(calls[0].module, 'steer-hold');
      assert.equal(calls[0].message, 'held entry');
      assert.equal(calls[0].ctx?.chars, 10);
      assert.equal(calls[0].ctx?.isPromise, false);
      assert.equal(calls[1].ctx?.isPromise, true);
      assert.equal(calls[1].ctx?.topicKey, '1_0');
    } finally {
      _setLoggerForTest(null);
    }
  });
});

describe('snapshotDrained', () => {
  it('resolves a voice entry to its transcript', async () => {
    const e1 = registerQueuedUpdate('1_0', 1, '[Voice message]');
    setVoice(e1, Promise.resolve(VOICE_RESULT));

    const [snap] = snapshotDrained([e1]);
    assert.equal(snap.updateId, 1);
    // Through the shared formatter: the success shape is "[Voice message] <text>",
    // byte-identical to what the turn path produces (voice.test.ts pins it).
    assert.equal(await snap.textPromise, '[Voice message] transcript text');
  });

  it('falls back to the failure-formatted placeholder, never the bare literal', async () => {
    const e1 = registerQueuedUpdate('1_0', 1, '[Voice message]');
    setVoice(e1, Promise.reject(new Error('transcribe failed')));

    const [snap] = snapshotDrained([e1]);
    const text = await snap.textPromise;
    // Fix-wave B1: the snapshot formats the rejection itself through the same
    // formatter the success path uses — the fold never sees the bare
    // `[Voice message]` literal (WP-2 case 4 forbids it) and never sees the
    // enqueue-time placeholder text either.
    assert.ok(text.startsWith('[Voice message — transcription failed'), `got: ${text}`);
    assert.notEqual(text, '[Voice message]');
  });

  it('resolves a text entry verbatim', async () => {
    const e1 = registerQueuedUpdate('1_0', 1, 'plain queued text');
    const [snap] = snapshotDrained([e1]);
    assert.equal(await snap.textPromise, 'plain queued text');
  });
});

describe('drainQueuedEntries logging (AI-208 E2)', () => {
  it('logs one line per drained entry and a zero-drain line', () => {
    const calls: Array<{ module: string; message: string; ctx?: Record<string, unknown> }> = [];
    _setLoggerForTest({ info: (module, message, ctx) => calls.push({ module, message, ctx }) });
    try {
      registerQueuedUpdate('1_0', 1, 'first');
      registerQueuedUpdate('1_0', 2, '/reset');
      registerQueuedUpdate('1_0', 3, 'second');

      calls.length = 0;
      const entries = drainQueuedEntries('1_0', 'steer');
      assert.equal(entries.length, 2);

      // One INFO line per collected entry, with the spec'd fields.
      const perEntry = calls.filter(c => c.message === 'drained queued entry');
      assert.equal(perEntry.length, 2);
      assert.deepEqual(
        perEntry.map(c => c.ctx?.updateId),
        [1, 3],
      );
      assert.deepEqual(
        perEntry.map(c => c.ctx?.textLen),
        [5, 6],
      );
      for (const c of perEntry) {
        assert.equal(c.module, 'steer-drain');
        assert.equal(c.ctx?.topicKey, '1_0');
        assert.equal(c.ctx?.reason, 'steer');
        assert.equal(c.ctx?.hasVoice, false);
        assert.equal(c.ctx?.cancelled, true);
      }

      // Summary line for the non-empty drain.
      const summary = calls.filter(c => c.message === 'drained 2 entry(ies)');
      assert.equal(summary.length, 1);
      assert.equal(summary[0].ctx?.count, 2);

      // Zero-drain must log too — this is the S1-vs-S2 decider.
      calls.length = 0;
      drainQueuedEntries('1_0', 'steer');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].message, 'drained 0 entry(ies)');
      assert.equal(calls[0].ctx?.count, 0);
      assert.equal(calls[0].ctx?.topicKey, '1_0');
    } finally {
      _setLoggerForTest(null);
    }
  });
});

describe('QueueEntry.voice media identity (AI-208 E1)', () => {
  it('drained entry keeps media/kind on the voice field', () => {
    const e1 = registerQueuedUpdate('1_0', 1, 'voice text');
    setVoice(
      e1,
      Promise.resolve(VOICE_RESULT),
      { file_id: 'FID', file_unique_id: 'UID', duration: 7 },
      'audio',
    );

    const entries = drainQueuedEntries('1_0');
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].voice?.media, { file_id: 'FID', file_unique_id: 'UID', duration: 7 });
    assert.equal(entries[0].voice?.kind, 'audio');
  });
});

describe('peekQueuedBatch (AI-209 WP-1)', () => {
  it('T1: returns the leading non-command run in arrival order, stops at the first command, and mutates nothing', () => {
    const e1 = registerQueuedUpdate('1_0', 1, 'a');
    const e2 = registerQueuedUpdate('1_0', 2, 'b');
    registerQueuedUpdate('1_0', 3, '/status');
    registerQueuedUpdate('1_0', 4, 'after command');

    const peeked = peekQueuedBatch('1_0');
    assert.equal(peeked.length, 2);
    assert.deepEqual(peeked.map(e => e.updateId), [1, 2]);
    assert.equal(peeked[0], e1, 'peek returns the queue\'s own entry objects (identity)');
    assert.equal(peeked[1], e2);

    // Nothing was cancelled by the peek.
    assert.equal(e1.cancelled, false);
    assert.equal(e2.cancelled, false);

    // Re-peek sees the same set — the peek left the queue intact.
    const again = peekQueuedBatch('1_0');
    assert.deepEqual(again.map(e => e.updateId), [1, 2]);
    // And the queue still drains its non-command texts unchanged (commands
    // are never returned by a drain — existing convention).
    assert.deepEqual(drainQueuedText('1_0'), ['a', 'b', 'after command']);
  });

  it('T2: returns [] for an absent topic, an empty array, and a queue whose head is a command', () => {
    assert.deepEqual(peekQueuedBatch('nonexistent_0'), []);

    const only = registerQueuedUpdate('1_0', 1, 'only');
    dequeueUpdate('1_0', only);
    assert.deepEqual(peekQueuedBatch('1_0'), []);

    registerQueuedUpdate('2_0', 2, '/reset');
    registerQueuedUpdate('2_0', 3, 'behind the command');
    assert.deepEqual(peekQueuedBatch('2_0'), []);
  });

  it('T5: logs count: 0 on an empty queue (AI-208 E2 evidence convention)', () => {
    const calls: Array<{ module: string; message: string; ctx?: Record<string, unknown> }> = [];
    _setLoggerForTest({ info: (module, message, ctx) => calls.push({ module, message, ctx }) });
    try {
      const peeked = peekQueuedBatch('1_0');
      assert.deepEqual(peeked, []);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].module, 'batch-uptake');
      assert.equal(calls[0].message, 'peeked batch');
      assert.equal(calls[0].ctx?.topicKey, '1_0');
      assert.equal(calls[0].ctx?.count, 0);
    } finally {
      _setLoggerForTest(null);
    }
  });
});

describe('confirmQueuedBatch (AI-209 WP-1)', () => {
  it('T3: removes exactly the given entries (identity), marks them cancelled, leaves the rest in place', () => {
    const e1 = registerQueuedUpdate('1_0', 1, 'head');
    const e2 = registerQueuedUpdate('1_0', 2, 'folded follower');
    const cmd = registerQueuedUpdate('1_0', 3, '/status');
    const e4 = registerQueuedUpdate('1_0', 4, 'after command');

    confirmQueuedBatch('1_0', [e1, e2]);

    assert.equal(e1.cancelled, true);
    assert.equal(e2.cancelled, true);
    assert.equal(cmd.cancelled, false, 'command entry must never be cancelled');
    assert.equal(e4.cancelled, false, 'post-command entry is not in the fold set');

    // What remains: the post-command entry is still queued (and the command
    // is never returned by a drain — existing convention).
    const remaining = drainQueuedEntries('1_0');
    assert.deepEqual(remaining.map(e => e.updateId), [4]);
    // The command entry must still be dequeueable normally afterward.
    dequeueUpdate('1_0', cmd);
    assert.deepEqual(drainQueuedEntries('1_0'), [], 'topic should be empty after the command entry is dequeued too');
  });

  it('T3b: deletes the topic key when confirmation empties the array', () => {
    const e1 = registerQueuedUpdate('1_0', 1, 'a');
    const e2 = registerQueuedUpdate('1_0', 2, 'b');
    confirmQueuedBatch('1_0', [e1, e2]);
    // Array emptied and key deleted — the topic is untracked again.
    assert.deepEqual(peekQueuedBatch('1_0'), []);
    assert.deepEqual(drainQueuedEntries('1_0'), []);
  });

  it('T3c: confirm logs one line per confirmed entry with updateId and hasVoice', () => {
    const e1 = registerQueuedUpdate('1_0', 1, 'plain');
    const e2 = registerQueuedUpdate('1_0', 2, 'voice text');
    setVoice(e2, Promise.resolve(VOICE_RESULT));

    const calls: Array<{ module: string; message: string; ctx?: Record<string, unknown> }> = [];
    _setLoggerForTest({ info: (module, message, ctx) => calls.push({ module, message, ctx }) });
    try {
      confirmQueuedBatch('1_0', [e1, e2]);
      const confirmed = calls.filter(c => c.message === 'confirmed batch entry');
      assert.equal(confirmed.length, 2);
      assert.deepEqual(confirmed.map(c => c.ctx?.updateId), [1, 2]);
      assert.deepEqual(confirmed.map(c => c.ctx?.hasVoice), [false, true]);
      for (const c of confirmed) {
        assert.equal(c.module, 'batch-uptake');
        assert.equal(c.ctx?.topicKey, '1_0');
      }
    } finally {
      _setLoggerForTest(null);
    }
  });
});

describe('registerQueuedUpdate messageId (AI-209 WP-1)', () => {
  it('T4: carries messageId when provided; omitting it leaves the field undefined; isCommandOverride still wins', () => {
    const withId = registerQueuedUpdate('1_0', 1, 'hello', undefined, 501);
    assert.equal(withId.messageId, 501);

    const withoutId = registerQueuedUpdate('1_0', 2, 'plain');
    assert.equal(withoutId.messageId, undefined);

    const override = registerQueuedUpdate('1_0', 3, '/reset', false, 503);
    assert.equal(override.isCommand, false, 'isCommandOverride still wins with messageId present');
    assert.equal(override.messageId, 503);
  });
});

describe('registerQueuedUpdate replyToMessageId (AI-203 increment 3)', () => {
  it('T-Q1: carries replyToMessageId when provided; omitting the sixth arg leaves it undefined', () => {
    const reply = registerQueuedUpdate('1_0', 7, 'hi', undefined, 42, 41);
    assert.equal(reply.replyToMessageId, 41);
    assert.equal(reply.messageId, 42);

    const nonReply = registerQueuedUpdate('1_0', 8, 'plain');
    assert.equal(nonReply.replyToMessageId, undefined);
  });
});

describe('dequeueUpdate with the additive messageId field (AI-209 WP-1 T6)', () => {
  it('T6: still no-ops on a foreign entry object carrying messageId', () => {
    assert.doesNotThrow(() =>
      dequeueUpdate('nonexistent_0', { updateId: 1, text: 'x', isCommand: false, cancelled: false, messageId: 10 }),
    );
    const e1 = registerQueuedUpdate('1_0', 1, 'first');
    dequeueUpdate('1_0', e1);
    // Dequeuing the same (already-removed) entry again must not throw.
    assert.doesNotThrow(() => dequeueUpdate('1_0', e1));
  });
});
