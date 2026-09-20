// voice-inbox-steer.ts (WP-5 E-C3/E-C6): drives steerIntoWork entirely through
// its `deps` seam — no process table, no real topic-threads store, no real
// voice-inbox ledger is touched by any test in this file.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  steerIntoWork,
  isPastSteerDeadline,
  taskIdsInText,
  STEER_PREFIX_INTERRUPT,
  STEER_PREFIX_QUEUE,
  VOICE_INBOX_STEER_DEADLINE_MS,
  type VoiceInboxSteerEntry,
  type VoiceInboxSteerRuntime,
} from '../voice-inbox-steer.js';
import type { ThreadRecord } from '../topic-threads.js';
import type { PendingDispatch } from '../pending-dispatches.js';
import { pendingDispatchKey } from '../pending-dispatches.js';

// Realistic ids: the real task-id shape is vi-<12 hex chars> — matters
// because taskIdsInText/VOICE_INBOX_TASK_RE only match that exact shape.
const ORIGIN_TASK_ID = 'vi-aaaa11112222';
const FOLLOWUP_TASK_ID = 'vi-bbbb33334444';
const CONVERSATION_ID = 'vi-cccc55556666';

interface FakeConversationState {
  workerResource: string | null;
  workerDispatchId: string | null;
  originTaskId: string | null;
  taskIds: string[];
}

function makeState(overrides: Partial<FakeConversationState> = {}): FakeConversationState {
  return {
    workerResource: null,
    workerDispatchId: null,
    originTaskId: null,
    taskIds: [],
    ...overrides,
  };
}

function makeEntry(overrides: Partial<VoiceInboxSteerEntry> = {}): VoiceInboxSteerEntry {
  return {
    task_id: FOLLOWUP_TASK_ID,
    text: 'Add a header row too.',
    steer_conversation: CONVERSATION_ID,
    ref_id: 's-refid0000001',
    ...overrides,
  };
}

function makeRuntime() {
  const injected: Array<{ chatId: number; threadId: number; text: string }> = [];
  const runtime: VoiceInboxSteerRuntime = {
    secrets: {},
    token: 'tok',
    topicNameFromKey: () => 'Test Topic',
    injectFn: (chatId, threadId, text) => { injected.push({ chatId, threadId, text }); },
  };
  return { runtime, injected };
}

let threadSeq = 0;
function makeThread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  threadSeq += 1;
  const now = new Date().toISOString();
  return {
    id: `t-${threadSeq}`,
    n: threadSeq,
    title: 'Fixture thread',
    goal: 'do the fixture thing',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    workdir: 'C:/pa-test-workdir',
    runSeq: 0,
    attempts: 0,
    pendingInput: [],
    ...overrides,
  };
}

function makePendingRec(overrides: Partial<PendingDispatch> = {}): PendingDispatch {
  return {
    updateId: 1,
    chatId: 1,
    threadId: 2,
    messageId: 1,
    userText: `[Voice inbox task ${ORIGIN_TASK_ID}] do the thing`,
    startedAt: '2026-09-08T18:00:00.000Z',
    ...overrides,
  };
}

describe('steerIntoWork — THREAD lane (cases 1-5)', () => {
  function threadDeps(rec: ThreadRecord, resource: string, steerImpl: (args: any) => Promise<string>) {
    return {
      conversationState: () => makeState({ workerResource: resource }),
      getThread: async (key: string, id: string) => (key === '1_2' && id === `t-${rec.n}` ? rec : undefined),
      steer: steerImpl,
    };
  }

  it('running + interrupt: message carries the interrupt prefix, queued=true, mode=interrupt, workdir=""; outcome interrupted-thread', async () => {
    const rec = makeThread({ status: 'running' });
    const resource = `topic-1_2-th${rec.n}`;
    const calls: any[] = [];
    const { runtime } = makeRuntime();
    const result = await steerIntoWork(
      makeEntry({ steer_mode: 'interrupt' }),
      runtime,
      threadDeps(rec, resource, async (args) => {
        calls.push(args);
        return '\n\n_(Interrupted thread t-1 — restarting with your message.)_';
      }),
    );
    assert.equal(result.settled, true);
    assert.equal(result.outcome, 'interrupted-thread');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].steer.message, STEER_PREFIX_INTERRUPT + 'Add a header row too.');
    assert.equal(calls[0].steer.mode, 'interrupt');
    assert.equal(calls[0].steer.queued, true);
    assert.equal(calls[0].workdir, '');
  });

  it('running + queue: uses the queue prefix and yields queued-into-thread', async () => {
    const rec = makeThread({ status: 'running' });
    const resource = `topic-1_2-th${rec.n}`;
    const calls: any[] = [];
    const { runtime } = makeRuntime();
    const result = await steerIntoWork(
      makeEntry({ steer_mode: 'queue' }),
      runtime,
      threadDeps(rec, resource, async (args) => {
        calls.push(args);
        return '\n\n_(Queued for thread t-1 — delivered when its current run finishes.)_';
      }),
    );
    assert.equal(result.outcome, 'queued-into-thread');
    assert.equal(calls[0].steer.message, STEER_PREFIX_QUEUE + 'Add a header row too.');
    assert.equal(calls[0].steer.mode, 'queue');
  });

  it('an absent steer_mode defaults to queue', async () => {
    const rec = makeThread({ status: 'running' });
    const resource = `topic-1_2-th${rec.n}`;
    const calls: any[] = [];
    const { runtime } = makeRuntime();
    const result = await steerIntoWork(
      makeEntry({ steer_mode: undefined }),
      runtime,
      threadDeps(rec, resource, async (args) => {
        calls.push(args);
        return '\n\n_(Queued for thread t-1 — delivered when its current run finishes.)_';
      }),
    );
    assert.equal(result.mode, 'queue');
    assert.equal(result.outcome, 'queued-into-thread');
    assert.equal(calls[0].steer.mode, 'queue');
  });

  it('a queued (never-run) record yields folded-before-start for BOTH modes', async () => {
    for (const mode of ['queue', 'interrupt'] as const) {
      const rec = makeThread({ status: 'queued' });
      const resource = `topic-1_2-th${rec.n}`;
      const { runtime } = makeRuntime();
      const result = await steerIntoWork(
        makeEntry({ steer_mode: mode }),
        runtime,
        threadDeps(rec, resource, async () => '\n\n_(Queued for thread t-1 — starts when a thread finishes.)_'),
      );
      assert.equal(result.outcome, 'folded-before-start', `mode=${mode}`);
    }
  });

  it('a done record yields woke-terminal-thread', async () => {
    const rec = makeThread({ status: 'done' });
    const resource = `topic-1_2-th${rec.n}`;
    const { runtime } = makeRuntime();
    const result = await steerIntoWork(
      makeEntry({ steer_mode: 'queue' }),
      runtime,
      threadDeps(rec, resource, async () => '\n\n_(Routed to thread t-1 — it is running your message now.)_'),
    );
    assert.equal(result.outcome, 'woke-terminal-thread');
  });
});

describe('steerIntoWork — THREAD lane refusals (cases 6-9)', () => {
  it('missing steer_conversation never calls steer', async () => {
    const { runtime } = makeRuntime();
    let steerCalled = false;
    const result = await steerIntoWork(
      makeEntry({ steer_conversation: undefined }),
      runtime,
      { steer: async () => { steerCalled = true; return ''; } },
    );
    assert.equal(result.settled, false);
    assert.equal(steerCalled, false);
  });

  it('an empty workerResource never calls steer', async () => {
    const { runtime } = makeRuntime();
    let steerCalled = false;
    const result = await steerIntoWork(
      makeEntry(),
      runtime,
      {
        conversationState: () => makeState({ workerResource: null }),
        steer: async () => { steerCalled = true; return ''; },
      },
    );
    assert.equal(result.settled, false);
    assert.equal(steerCalled, false);
  });

  it('an unknown thread id never calls steer', async () => {
    const { runtime } = makeRuntime();
    let steerCalled = false;
    const result = await steerIntoWork(
      makeEntry(),
      runtime,
      {
        conversationState: () => makeState({ workerResource: 'topic-1_2-th99' }),
        getThread: async () => undefined,
        steer: async () => { steerCalled = true; return ''; },
      },
    );
    assert.equal(result.settled, false);
    assert.equal(steerCalled, false);
  });

  it('a cancelled record never calls steer', async () => {
    const rec = makeThread({ status: 'cancelled' });
    const resource = `topic-1_2-th${rec.n}`;
    const { runtime } = makeRuntime();
    let steerCalled = false;
    const result = await steerIntoWork(
      makeEntry(),
      runtime,
      {
        conversationState: () => makeState({ workerResource: resource }),
        getThread: async () => rec,
        steer: async () => { steerCalled = true; return ''; },
      },
    );
    assert.equal(result.settled, false);
    assert.equal(steerCalled, false);
  });

  it("a record whose n disagrees with the resource's -th<n> never calls steer (D7 safety pin)", async () => {
    const rec = makeThread({ status: 'running', n: 3 });
    const resource = 'topic-1_2-th4'; // deliberately mismatched against rec.n === 3
    const { runtime } = makeRuntime();
    let steerCalled = false;
    const result = await steerIntoWork(
      makeEntry(),
      runtime,
      {
        conversationState: () => makeState({ workerResource: resource }),
        getThread: async () => rec,
        steer: async () => { steerCalled = true; return ''; },
      },
    );
    assert.equal(result.settled, false);
    assert.equal(steerCalled, false);
  });
});

describe('steerIntoWork — THREAD lane footer parsing (case 10)', () => {
  it('a rejection footer yields settled:false', async () => {
    const rec = makeThread({ status: 'running' });
    const resource = `topic-1_2-th${rec.n}`;
    const { runtime } = makeRuntime();
    const result = await steerIntoWork(
      makeEntry(),
      runtime,
      {
        conversationState: () => makeState({ workerResource: resource }),
        getThread: async () => rec,
        steer: async () => '\n\n_(steer rejected: thread not found)_',
      },
    );
    assert.equal(result.settled, false);
  });

  it('each of the four non-rejection footers handleSteer can return is settled:true', async () => {
    const footers = [
      '\n\n_(Interrupted thread t-1 — restarting with your message.)_',
      '\n\n_(Queued for thread t-1 — delivered when its current run finishes.)_',
      '\n\n_(Routed to thread t-1 — it is running your message now.)_',
      '\n\n_(Queued for thread t-1 — starts when a thread finishes.)_',
    ];
    for (const footer of footers) {
      const rec = makeThread({ status: 'running' });
      const resource = `topic-1_2-th${rec.n}`;
      const { runtime } = makeRuntime();
      const result = await steerIntoWork(
        makeEntry(),
        runtime,
        {
          conversationState: () => makeState({ workerResource: resource }),
          getThread: async () => rec,
          steer: async () => footer,
        },
      );
      assert.equal(result.settled, true, footer);
    }
  });
});

describe('steerIntoWork — TOPIC lane (cases 11-15)', () => {
  it('interrupt, happy path: kills the identified dispatch, purges its pending record, injects the combined turn once', async () => {
    const originRec = makePendingRec();
    const removedKeys: string[] = [];
    const stopArgs: unknown[][] = [];
    const { runtime, injected } = makeRuntime();
    const result = await steerIntoWork(
      makeEntry({ steer_mode: 'interrupt' }),
      runtime,
      {
        conversationState: () => makeState({ workerResource: 'topic-1_2', workerDispatchId: 'dispatch001', originTaskId: ORIGIN_TASK_ID }),
        listPending: async () => [originRec],
        stop: async (r, d, id) => { stopArgs.push([r, d, id]); return 1; },
        removePending: async (key) => { removedKeys.push(key); },
      },
    );
    assert.equal(result.settled, true);
    assert.equal(result.outcome, 'interrupted-dispatch');
    assert.deepEqual(stopArgs, [['topic-1_2', undefined, 'dispatch001']]);
    assert.deepEqual(removedKeys, [pendingDispatchKey(1, 2, originRec.updateId)]);
    assert.equal(injected.length, 1);
    assert.equal(injected[0].text, `${originRec.userText}\n\n${STEER_PREFIX_INTERRUPT}Add a header row too.`);
  });

  it('interrupt, stop returns 0 (stale identity): never purges, injects the steer text ALONE, outcome queued-into-topic', async () => {
    const originRec = makePendingRec();
    let removeCalled = false;
    const { runtime, injected } = makeRuntime();
    const result = await steerIntoWork(
      makeEntry({ steer_mode: 'interrupt' }),
      runtime,
      {
        conversationState: () => makeState({ workerResource: 'topic-1_2', workerDispatchId: 'dispatch001', originTaskId: ORIGIN_TASK_ID }),
        listPending: async () => [originRec],
        stop: async () => 0,
        removePending: async () => { removeCalled = true; },
      },
    );
    assert.equal(result.outcome, 'queued-into-topic');
    assert.equal(removeCalled, false, 'K14: a stale identity never purges');
    assert.equal(injected.length, 1);
    assert.equal(injected[0].text, STEER_PREFIX_INTERRUPT + 'Add a header row too.');
  });

  it('interrupt with no workerDispatchId recorded: never calls stop; settled:false naming the missing id', async () => {
    const originRec = makePendingRec();
    let stopCalled = false;
    const { runtime } = makeRuntime();
    const result = await steerIntoWork(
      makeEntry({ steer_mode: 'interrupt' }),
      runtime,
      {
        conversationState: () => makeState({ workerResource: 'topic-1_2', workerDispatchId: null, originTaskId: ORIGIN_TASK_ID }),
        listPending: async () => [originRec],
        stop: async () => { stopCalled = true; return 1; },
      },
    );
    assert.equal(result.settled, false);
    assert.equal(stopCalled, false);
    assert.match(result.reason ?? '', /dispatch id/i);
  });

  it('queue mode: never calls stop, injects the queue-prefixed text alone', async () => {
    const originRec = makePendingRec();
    let stopCalled = false;
    const { runtime, injected } = makeRuntime();
    const result = await steerIntoWork(
      makeEntry({ steer_mode: 'queue' }),
      runtime,
      {
        conversationState: () => makeState({ workerResource: 'topic-1_2', workerDispatchId: 'dispatch001', originTaskId: ORIGIN_TASK_ID }),
        listPending: async () => [originRec],
        stop: async () => { stopCalled = true; return 1; },
      },
    );
    assert.equal(result.outcome, 'queued-into-topic');
    assert.equal(stopCalled, false);
    assert.equal(injected.length, 1);
    assert.equal(injected[0].text, STEER_PREFIX_QUEUE + 'Add a header row too.');
  });

  it('mid-hand-off (5(d) exception): no originRec but the origin dispatch is still registered in worker-pids holds rather than injecting', async () => {
    let injectCalled = false;
    const { runtime } = makeRuntime();
    const result = await steerIntoWork(
      makeEntry({ steer_mode: 'queue' }),
      { ...runtime, injectFn: () => { injectCalled = true; } },
      {
        conversationState: () => makeState({ workerResource: 'topic-1_2', workerDispatchId: 'dispatch001', originTaskId: ORIGIN_TASK_ID }),
        listPending: async () => [], // no pending record names the origin task — originRec absent
        listWorkerPids: async () => [{ dispatchId: 'dispatch001' }],
      },
    );
    assert.equal(result.settled, false);
    assert.equal(injectCalled, false, '5(d) exception must hold, never inject, while the worker is still registered');
    assert.match(result.reason ?? '', /worker is still registered/);
  });

  it('mid-hand-off negative twin: no matching worker-pids entry (or no listWorkerPids at all) still injects as before', async () => {
    const { runtime: runtimeA, injected: injectedA } = makeRuntime();
    const resultA = await steerIntoWork(
      makeEntry({ steer_mode: 'queue' }),
      runtimeA,
      {
        conversationState: () => makeState({ workerResource: 'topic-1_2', workerDispatchId: 'dispatch001', originTaskId: ORIGIN_TASK_ID }),
        listPending: async () => [],
        listWorkerPids: async () => [{ dispatchId: 'some-other-dispatch' }],
      },
    );
    assert.equal(resultA.settled, true);
    assert.equal(resultA.outcome, 'queued-into-topic');
    assert.equal(injectedA.length, 1);

    const { runtime: runtimeB, injected: injectedB } = makeRuntime();
    const resultB = await steerIntoWork(
      makeEntry({ steer_mode: 'queue' }),
      runtimeB,
      {
        conversationState: () => makeState({ workerResource: 'topic-1_2', workerDispatchId: 'dispatch001', originTaskId: ORIGIN_TASK_ID }),
        listPending: async () => [],
        // no listWorkerPids supplied at all — cannot verify, safe default is inject
      },
    );
    assert.equal(resultB.settled, true);
    assert.equal(resultB.outcome, 'queued-into-topic');
    assert.equal(injectedB.length, 1);
  });

  it('idempotency: a pending record already naming BOTH the origin and this steer\'s own task id is treated as already injected', async () => {
    const already = makePendingRec({
      userText: `[Voice inbox task ${ORIGIN_TASK_ID}] do the thing\n\n${STEER_PREFIX_INTERRUPT}[Voice inbox task ${FOLLOWUP_TASK_ID}] add a header`,
    });
    let stopCalled = false;
    const { runtime, injected } = makeRuntime();
    const result = await steerIntoWork(
      makeEntry({ task_id: FOLLOWUP_TASK_ID, steer_mode: 'interrupt' }),
      runtime,
      {
        conversationState: () => makeState({ workerResource: 'topic-1_2', workerDispatchId: 'dispatch001', originTaskId: ORIGIN_TASK_ID }),
        listPending: async () => [already],
        stop: async () => { stopCalled = true; return 1; },
      },
    );
    assert.equal(result.settled, true);
    assert.equal(result.outcome, 'interrupted-dispatch');
    assert.equal(stopCalled, false);
    assert.equal(injected.length, 0);
  });
});

describe('steerIntoWork — misc robustness (case 16)', () => {
  it('a resource matching neither regex returns settled:false', async () => {
    const { runtime } = makeRuntime();
    const result = await steerIntoWork(
      makeEntry(),
      runtime,
      { conversationState: () => makeState({ workerResource: 'task-vi-abc123' }) },
    );
    assert.equal(result.settled, false);
  });

  it('a conversationState that throws is treated as an empty state (never propagates)', async () => {
    const { runtime } = makeRuntime();
    const result = await steerIntoWork(
      makeEntry(),
      runtime,
      { conversationState: () => { throw new Error('ledger unreadable'); } },
    );
    assert.equal(result.settled, false);
  });

  it('a stop that throws returns settled:false without propagating', async () => {
    const originRec = makePendingRec();
    const { runtime } = makeRuntime();
    const result = await steerIntoWork(
      makeEntry({ steer_mode: 'interrupt' }),
      runtime,
      {
        conversationState: () => makeState({ workerResource: 'topic-1_2', workerDispatchId: 'dispatch001', originTaskId: ORIGIN_TASK_ID }),
        listPending: async () => [originRec],
        stop: async () => { throw new Error('kill failed'); },
      },
    );
    assert.equal(result.settled, false);
  });
});

describe('isPastSteerDeadline (case 17)', () => {
  it('false just inside the window, true just outside', () => {
    const now = 1_760_000_000_000;
    const inside = new Date(now - VOICE_INBOX_STEER_DEADLINE_MS + 1000).toISOString();
    assert.equal(isPastSteerDeadline(inside, now), false);
    const outside = new Date(now - VOICE_INBOX_STEER_DEADLINE_MS - 1000).toISOString();
    assert.equal(isPastSteerDeadline(outside, now), true);
  });

  it('true for an absent or unparseable ts', () => {
    assert.equal(isPastSteerDeadline(undefined), true);
    assert.equal(isPastSteerDeadline('not-a-date'), true);
  });
});

describe('taskIdsInText (case 17)', () => {
  it('de-duplicates and matches all three real injection-text openings', () => {
    assert.deepEqual(
      taskIdsInText(`[Voice inbox task ${ORIGIN_TASK_ID}] Errands: water the plants.`),
      [ORIGIN_TASK_ID],
    );
    assert.deepEqual(
      taskIdsInText(`[Voice task ${FOLLOWUP_TASK_ID} routed from inbox — reason: matched Errands] Do the thing.`),
      [FOLLOWUP_TASK_ID],
    );
    assert.deepEqual(
      taskIdsInText(`[Voice inbox task ${CONVERSATION_ID} cancelled by the operator]`),
      [CONVERSATION_ID],
    );
    assert.deepEqual(
      taskIdsInText(
        `Batch: [Voice inbox task ${ORIGIN_TASK_ID}] then [Voice task ${FOLLOWUP_TASK_ID} routed] go, ` +
        `again [Voice inbox task ${ORIGIN_TASK_ID}] repeated`,
      ),
      [ORIGIN_TASK_ID, FOLLOWUP_TASK_ID],
    );
  });
});

describe('source-invariant pins (case 18)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const orchestratorSrc = readFileSync(join(here, '..', '..', 'src', 'orchestrator.ts'), 'utf8');
  const bridgeSrc = readFileSync(join(here, '..', '..', 'src', 'voice-inbox-bridge.ts'), 'utf8');
  const steerSrc = readFileSync(join(here, '..', '..', 'src', 'voice-inbox-steer.ts'), 'utf8');
  const mainSrc = readFileSync(join(here, '..', '..', 'src', 'main.ts'), 'utf8');

  it('orchestrator.ts contains the literal rejection prefix', () => {
    assert.match(orchestratorSrc, /_\(steer rejected: /);
  });

  it("handleSteer's body does not read args.workdir (K11)", () => {
    const start = orchestratorSrc.indexOf('export async function handleSteer(');
    assert.notEqual(start, -1, 'handleSteer must exist in orchestrator.ts');
    const nextExportIdx = orchestratorSrc.indexOf('\nexport ', start + 1);
    const body = nextExportIdx === -1 ? orchestratorSrc.slice(start) : orchestratorSrc.slice(start, nextExportIdx);
    assert.doesNotMatch(body, /args\.workdir/);
  });

  it("voice-inbox-steer.ts's VOICE_INBOX_TASK_RE is byte-equal to voice-inbox-bridge.ts's", () => {
    const steerMatch = /export const VOICE_INBOX_TASK_RE = (.+);/.exec(steerSrc);
    const bridgeMatch = /export const VOICE_INBOX_TASK_RE = (.+);/.exec(bridgeSrc);
    assert.ok(steerMatch && bridgeMatch, 'both files must define VOICE_INBOX_TASK_RE');
    assert.equal(steerMatch![1], bridgeMatch![1]);
  });

  it('main.ts wires all four steer seams', () => {
    assert.match(mainSrc, /steerFn:/);
    assert.match(mainSrc, /conversationTaskIdsFn:/);
    assert.match(mainSrc, /foldPrefix:/);
    assert.match(mainSrc, /isPastDeadline:/);
  });

  it('voice-inbox-steer.ts never calls the topic-wide cancelRunningThreads', () => {
    assert.doesNotMatch(steerSrc, /cancelRunningThreads/);
  });
});
