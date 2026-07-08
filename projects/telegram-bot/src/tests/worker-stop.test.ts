import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStopSteer,
  stopTopicWorkers,
  markTopicStopped,
  unmarkTopicStopped,
  isTopicStopped,
  consumeTopicStopped,
  STOP_MARKER_TTL_MS,
  _clearStoppedForTest,
  type StopDeps,
} from '../worker-stop.js';

beforeEach(() => _clearStoppedForTest());

describe('parseStopSteer', () => {
  it('matches /stop with and without bot suffix', () => {
    assert.deepEqual(parseStopSteer('/stop'), { kind: 'stop' });
    assert.deepEqual(parseStopSteer('/stop@Example_pa_bot'), { kind: 'stop' });
    assert.deepEqual(parseStopSteer('/STOP '), { kind: 'stop' });
  });

  it('matches /steer with a prompt', () => {
    assert.deepEqual(parseStopSteer('/steer focus on the tests only'), { kind: 'steer', prompt: 'focus on the tests only' });
    assert.deepEqual(parseStopSteer('/steer@Example_pa_bot multi\nline prompt'), { kind: 'steer', prompt: 'multi\nline prompt' });
  });

  it('/steer without a prompt degrades to /stop', () => {
    assert.deepEqual(parseStopSteer('/steer'), { kind: 'stop' });
    assert.deepEqual(parseStopSteer('/steer   '), { kind: 'stop' });
  });

  it('ignores everything else, including prefixed text', () => {
    assert.equal(parseStopSteer('please /stop it'), null);
    assert.equal(parseStopSteer('/stopwatch'), null);
    assert.equal(parseStopSteer('/steering wheel'), null);
    assert.equal(parseStopSteer('hello'), null);
  });
});

describe('stopped-topic markers', () => {
  const SINCE = 500; // update_id of the /stop command

  it('mark → peek (non-destructive) → consume (destructive)', () => {
    markTopicStopped('1_2', 'stop', SINCE);
    assert.equal(isTopicStopped('1_2', SINCE - 1), true);
    assert.equal(isTopicStopped('1_2', SINCE - 1), true, 'peek does not consume');
    assert.equal(consumeTopicStopped('1_2', SINCE - 1), 'stop');
    assert.equal(consumeTopicStopped('1_2', SINCE - 1), null, 'consumed exactly once');
    assert.equal(isTopicStopped('1_2', SINCE - 1), false);
  });

  it('only targets dispatches OLDER than the /stop (updateId gating)', () => {
    markTopicStopped('1_2', 'stop', SINCE);
    // The user's NEXT message (newer update) must be untouched…
    assert.equal(isTopicStopped('1_2', SINCE + 1), false);
    assert.equal(consumeTopicStopped('1_2', SINCE + 1), null, 'newer dispatch leaves the marker');
    // …and a /steer's own re-dispatch (same update id) is not suppressed either.
    assert.equal(consumeTopicStopped('1_2', SINCE), null);
    // The killed (older) dispatch still consumes it.
    assert.equal(consumeTopicStopped('1_2', SINCE - 1), 'stop');
  });

  it('no updateId → treated as targeted (legacy/direct callers)', () => {
    markTopicStopped('1_2', 'steer', SINCE);
    assert.equal(isTopicStopped('1_2'), true);
    assert.equal(consumeTopicStopped('1_2'), 'steer');
  });

  it('unmarkTopicStopped removes a no-op kill marker', () => {
    markTopicStopped('1_2', 'stop', SINCE);
    unmarkTopicStopped('1_2');
    assert.equal(isTopicStopped('1_2', SINCE - 1), false);
  });

  it('markers expire after the TTL', () => {
    const t0 = 1_000_000;
    markTopicStopped('1_2', 'stop', SINCE, t0);
    assert.equal(isTopicStopped('1_2', SINCE - 1, t0 + STOP_MARKER_TTL_MS + 1), false);
    markTopicStopped('3_4', 'steer', SINCE, t0);
    assert.equal(consumeTopicStopped('3_4', SINCE - 1, t0 + STOP_MARKER_TTL_MS + 1), null);
  });

  it('markers are per-topic', () => {
    markTopicStopped('1_2', 'stop', SINCE);
    assert.equal(isTopicStopped('9_9', SINCE - 1), false);
  });
});

function makeDeps(entries: Array<{ pid: number; skill: string; descendants?: number[] }>, alivePids: Set<number>) {
  const killed: number[] = [];
  const removed: number[] = [];
  const deps: StopDeps = {
    list: async () => entries.map((e) => ({ pid: e.pid, spawnedBy: 1, worker: 'claude', skill: e.skill, startedAt: '', descendants: e.descendants })),
    alive: (pid) => alivePids.has(pid),
    kill: (pid) => { killed.push(pid); alivePids.delete(pid); },
    removeEntry: async (pid) => { removed.push(pid); },
  };
  return { deps, killed, removed };
}

describe('stopTopicWorkers', () => {
  it('returns 0 when nothing is registered for the topic', async () => {
    const { deps } = makeDeps([{ pid: 10, skill: 'topic-1_99' }], new Set([10]));
    assert.equal(await stopTopicWorkers(1, 2, deps), 0);
  });

  it('kills the live wrapper and removes its registry entry', async () => {
    const { deps, killed, removed } = makeDeps([{ pid: 10, skill: 'topic-1_2' }], new Set([10]));
    assert.equal(await stopTopicWorkers(1, 2, deps), 1);
    assert.deepEqual(killed, [10]);
    assert.deepEqual(removed, [10]);
  });

  it('kills live descendants even when the wrapper is already dead (orphan case)', async () => {
    const { deps, killed } = makeDeps(
      [{ pid: 10, skill: 'topic-1_2', descendants: [11, 12] }],
      new Set([12]), // wrapper 10 and descendant 11 already dead
    );
    assert.equal(await stopTopicWorkers(1, 2, deps), 1);
    assert.deepEqual(killed, [12]);
  });

  it('worker finished between command and kill → 0 killed, entry still cleaned up', async () => {
    const { deps, killed, removed } = makeDeps([{ pid: 10, skill: 'topic-1_2', descendants: [11] }], new Set());
    assert.equal(await stopTopicWorkers(1, 2, deps), 0);
    assert.deepEqual(killed, []);
    assert.deepEqual(removed, [10]);
  });

  it('only touches the requested topic', async () => {
    const { deps, killed } = makeDeps(
      [{ pid: 10, skill: 'topic-1_2' }, { pid: 20, skill: 'topic-1_3' }],
      new Set([10, 20]),
    );
    await stopTopicWorkers(1, 2, deps);
    assert.deepEqual(killed, [10]);
  });
});
