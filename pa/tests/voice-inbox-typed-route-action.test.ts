import './test-env-guard.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TypeSafeResult } from '../src/lib/typesafe-client.js';
import type { TopicRegistryEntry } from '../src/lib/topic-registry.js';
import {
  routeVoiceInboxTaskTyped,
  type RouteClaim,
  type TypedRouteContext,
  type TypedRouteTaskRow,
} from '../src/lib/voice-inbox-typed-route-action.js';

const REGISTRY: TopicRegistryEntry[] = [
  {
    chatId: '-100123',
    threadId: 0,
    key: '-100123_0',
    name: 'general-knowledge',
    description: 'Anything that fits nowhere else',
    legacyString: false,
  },
  {
    chatId: '-100123',
    threadId: 5,
    key: '-100123_5',
    name: 'health',
    description: 'Doctor visits and medicines',
    legacyString: false,
  },
  { chatId: '-100123', threadId: 900, key: '-100123_900', name: 'voice-inbox', legacyString: false },
  { chatId: '-100999', threadId: 7, key: '-100999_7', name: 'other-chat', legacyString: false },
];

const CTX: TypedRouteContext = {
  caller: 'test',
  repoRoot: 'R',
  ledgerPath: 'L',
  fileConfig: {
    keywordTopics: { invoice: '-100123_5' },
    inboxTopic: '-100123_900',
    typedRouting: { actConfidence: 0.9, continueConfidence: 0.9, noMatch: 'create-topic', escalation: 'llm-turn' },
  },
  lastResort: false,
};

const ROW: TypedRouteTaskRow = {
  task_id: 'vi-111111111111',
  tenant_id: 't-1',
  state: 'received',
  source: 'text',
  request_text: 'book a doctor visit',
  transcript: null,
  conversation_id: 'vi-111111111111',
  feedback_about: null,
};

function claimRecorder(onRelease?: () => void): () => Promise<RouteClaim | null> {
  return async () => ({
    release: async () => {
      onRelease?.();
    },
  });
}

function confidentAsk(choice: string, confidence: number): () => Promise<TypeSafeResult> {
  return async () => ({
    ok: true,
    answers: { destination: { type: 'choice', choice, probabilities: { [choice]: confidence }, confidence } },
    usage: { inputTokens: 1, outputTokens: 1 },
    latencyMs: 5,
    status: 200,
    retries: 0,
  });
}

describe('voice-inbox-typed-route-action', () => {
  it('without TypeSafe configured the action escalates before claiming', async () => {
    let claimCalls = 0;
    const outcome = await routeVoiceInboxTaskTyped('vi-111111111111', CTX, {
      isConfiguredFn: () => false,
      claimFn: async () => {
        claimCalls += 1;
        return null;
      },
    });
    assert.deepEqual(outcome, { kind: 'escalated', why: 'typesafe-unavailable:not-configured' });
    assert.equal(claimCalls, 0);
  });

  it('a busy claim returns claim-busy and never reads the task', async () => {
    let readCalls = 0;
    const outcome = await routeVoiceInboxTaskTyped('vi-111111111111', CTX, {
      isConfiguredFn: () => true,
      claimFn: async () => null,
      readTaskFn: () => {
        readCalls += 1;
        return ROW;
      },
    });
    assert.deepEqual(outcome, { kind: 'claim-busy' });
    assert.equal(readCalls, 0);
  });

  it('a task no longer received is raced and route_task never runs', async () => {
    let releaseCalls = 0;
    let runCalls = 0;
    const outcome = await routeVoiceInboxTaskTyped('vi-111111111111', CTX, {
      isConfiguredFn: () => true,
      claimFn: claimRecorder(() => {
        releaseCalls += 1;
      }),
      readTaskFn: () => ({ ...ROW, state: 'routed' }),
      runScript: async () => {
        runCalls += 1;
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    assert.deepEqual(outcome, { kind: 'raced' });
    assert.equal(runCalls, 0);
    assert.equal(releaseCalls, 1);
  });

  it('an explicit continuation routes to the conversation topic with continues and no TypeSafe call', async () => {
    let askCalls = 0;
    let runArgs: string[] | undefined;
    const row: TypedRouteTaskRow = { ...ROW, conversation_id: 'vi-222222222222' };
    const outcome = await routeVoiceInboxTaskTyped('vi-111111111111', CTX, {
      isConfiguredFn: () => true,
      claimFn: claimRecorder(),
      readTaskFn: () => row,
      readRegistryFn: () => REGISTRY,
      conversationTopicFn: () => '-100123_5',
      askFn: async () => {
        askCalls += 1;
        throw new Error('should not be called');
      },
      runScript: async (_script, args) => {
        runArgs = args;
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    assert.deepEqual(runArgs, [
      '--task',
      'vi-111111111111',
      '--topic',
      '-100123_5',
      '--reason',
      'Placed in health automatically: it continues the conversation it was sent from.',
      '--continues',
      'vi-222222222222',
    ]);
    assert.equal(askCalls, 0);
    assert.equal(outcome.kind, 'placed');
  });

  it('a keyword pin routes without a TypeSafe call', async () => {
    let askCalls = 0;
    let runArgs: string[] | undefined;
    const row: TypedRouteTaskRow = { ...ROW, request_text: 'pay the invoice' };
    await routeVoiceInboxTaskTyped('vi-111111111111', CTX, {
      isConfiguredFn: () => true,
      claimFn: claimRecorder(),
      readTaskFn: () => row,
      readRegistryFn: () => REGISTRY,
      askFn: async () => {
        askCalls += 1;
        throw new Error('should not be called');
      },
      runScript: async (_script, args) => {
        runArgs = args;
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    assert.deepEqual(runArgs, [
      '--task',
      'vi-111111111111',
      '--topic',
      '-100123_5',
      '--reason',
      'Placed in health automatically by the keyword rule for "invoice".',
    ]);
    assert.equal(askCalls, 0);
  });

  it('a confident typed decision runs route_task with topic and reason and no title', async () => {
    let runArgs: string[] | undefined;
    let scriptPath: string | undefined;
    let timeoutArg: number | undefined;
    await routeVoiceInboxTaskTyped('vi-111111111111', CTX, {
      isConfiguredFn: () => true,
      claimFn: claimRecorder(),
      readTaskFn: () => ROW,
      readRegistryFn: () => REGISTRY,
      askFn: confidentAsk('-100123_5', 0.93),
      runScript: async (script, args, _env, timeoutMs) => {
        scriptPath = script;
        runArgs = args;
        timeoutArg = timeoutMs;
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    assert.deepEqual(runArgs, [
      '--task',
      'vi-111111111111',
      '--topic',
      '-100123_5',
      '--reason',
      'Placed in health automatically: the request matched that topic (93% sure).',
    ]);
    assert.equal(runArgs!.includes('--title'), false);
    assert.equal(scriptPath!.endsWith('route_task.py'), true);
    assert.equal(timeoutArg, 30000);
  });

  it('a low-confidence decision escalates and never runs route_task', async () => {
    let runCalls = 0;
    const outcome = await routeVoiceInboxTaskTyped('vi-111111111111', CTX, {
      isConfiguredFn: () => true,
      claimFn: claimRecorder(),
      readTaskFn: () => ROW,
      readRegistryFn: () => REGISTRY,
      askFn: confidentAsk('-100123_5', 0.5),
      runScript: async () => {
        runCalls += 1;
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    assert.equal(outcome.kind, 'escalated');
    assert.equal((outcome as { why: string }).why, 'low-confidence:0.500');
    assert.equal((outcome as { decision?: { kind: string } }).decision?.kind, 'decided');
    assert.equal(runCalls, 0);
  });

  it('a confident none_of_the_above runs route_task with create-topic and the default topic', async () => {
    let runArgs: string[] | undefined;
    await routeVoiceInboxTaskTyped('vi-111111111111', CTX, {
      isConfiguredFn: () => true,
      claimFn: claimRecorder(),
      readTaskFn: () => ROW,
      readRegistryFn: () => REGISTRY,
      askFn: confidentAsk('none_of_the_above', 0.95),
      runScript: async (_script, args) => {
        runArgs = args;
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    const topicIndex = runArgs!.indexOf('--topic');
    assert.equal(runArgs![topicIndex + 1], '-100123_0');
    assert.equal(runArgs![runArgs!.length - 1], '--create-topic');
  });

  it('a task routed by someone else between the decision and the act is raced', async () => {
    let readCalls = 0;
    let runCalls = 0;
    const outcome = await routeVoiceInboxTaskTyped('vi-111111111111', CTX, {
      isConfiguredFn: () => true,
      claimFn: claimRecorder(),
      readTaskFn: () => {
        readCalls += 1;
        return readCalls === 1 ? ROW : { ...ROW, state: 'routed' };
      },
      readRegistryFn: () => REGISTRY,
      askFn: confidentAsk('-100123_5', 0.95),
      runScript: async () => {
        runCalls += 1;
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    assert.deepEqual(outcome, { kind: 'raced' });
    assert.equal(runCalls, 0);
  });

  it('a nonzero route_task exit is script-failed', async () => {
    const outcome = await routeVoiceInboxTaskTyped('vi-111111111111', CTX, {
      isConfiguredFn: () => true,
      claimFn: claimRecorder(),
      readTaskFn: () => ROW,
      readRegistryFn: () => REGISTRY,
      askFn: confidentAsk('-100123_5', 0.95),
      runScript: async () => ({ stdout: '', stderr: '', code: 1 }),
    });
    assert.equal(outcome.kind, 'script-failed');
    assert.equal((outcome as { scriptExit: number }).scriptExit, 1);
  });

  it('the claim is released on every path including a throw', async () => {
    let releaseCalls = 0;
    const claimFn = claimRecorder(() => {
      releaseCalls += 1;
    });
    const throwOutcome = await routeVoiceInboxTaskTyped('vi-111111111111', CTX, {
      isConfiguredFn: () => true,
      claimFn,
      readTaskFn: () => ROW,
      readRegistryFn: () => REGISTRY,
      askFn: async () => {
        throw new Error('boom');
      },
    });
    assert.deepEqual(throwOutcome, { kind: 'escalated', why: 'threw' });
    assert.equal(releaseCalls, 1);

    releaseCalls = 0;
    const placedOutcome = await routeVoiceInboxTaskTyped('vi-111111111111', CTX, {
      isConfiguredFn: () => true,
      claimFn,
      readTaskFn: () => ROW,
      readRegistryFn: () => REGISTRY,
      askFn: confidentAsk('-100123_5', 0.93),
      runScript: async () => ({ stdout: '', stderr: '', code: 0 }),
    });
    assert.equal(placedOutcome.kind, 'placed');
    assert.equal(releaseCalls, 1);
  });

  it('a feedback task is never offered open conversations', async () => {
    let listCalls = 0;
    let requestSeen: { questions: Record<string, unknown> } | undefined;
    const row: TypedRouteTaskRow = { ...ROW, feedback_about: 'vi-333333333333' };
    await routeVoiceInboxTaskTyped('vi-111111111111', CTX, {
      isConfiguredFn: () => true,
      claimFn: claimRecorder(),
      readTaskFn: () => row,
      readRegistryFn: () => REGISTRY,
      listOpenConversationsFn: async () => {
        listCalls += 1;
        return [];
      },
      askFn: async (request) => {
        requestSeen = request as unknown as { questions: Record<string, unknown> };
        return {
          ok: true,
          answers: { destination: { type: 'choice', choice: '-100123_5', probabilities: { '-100123_5': 0.95 }, confidence: 0.95 } },
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 5,
          status: 200,
          retries: 0,
        };
      },
      runScript: async () => ({ stdout: '', stderr: '', code: 0 }),
    });
    assert.equal(listCalls, 0);
    assert.equal('continues' in requestSeen!.questions, false);
  });

  it('an unavailable offer is asked without the continuation question', async () => {
    let requestSeen: { questions: Record<string, unknown> } | undefined;
    const outcome = await routeVoiceInboxTaskTyped('vi-111111111111', CTX, {
      isConfiguredFn: () => true,
      claimFn: claimRecorder(),
      readTaskFn: () => ROW,
      readRegistryFn: () => REGISTRY,
      listOpenConversationsFn: async () => {
        throw new Error('no voice-inbox build');
      },
      askFn: async (request) => {
        requestSeen = request as unknown as { questions: Record<string, unknown> };
        return {
          ok: true,
          answers: { destination: { type: 'choice', choice: '-100123_5', probabilities: { '-100123_5': 0.95 }, confidence: 0.95 } },
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 5,
          status: 200,
          retries: 0,
        };
      },
      runScript: async () => ({ stdout: '', stderr: '', code: 0 }),
    });
    assert.equal(outcome.kind, 'placed');
    assert.equal('continues' in requestSeen!.questions, false);
  });

  it('the last-resort reason carries the suffix', async () => {
    let runArgs: string[] | undefined;
    const ctx: TypedRouteContext = { ...CTX, lastResort: true, reasonSuffix: ' It waited 7 minutes for a worker first.' };
    await routeVoiceInboxTaskTyped('vi-111111111111', ctx, {
      isConfiguredFn: () => true,
      claimFn: claimRecorder(),
      readTaskFn: () => ROW,
      readRegistryFn: () => REGISTRY,
      askFn: confidentAsk('-100123_5', 0.2),
      runScript: async (_script, args) => {
        runArgs = args;
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    const reason = runArgs![runArgs!.indexOf('--reason') + 1];
    assert.equal(reason.endsWith('(20% sure). It waited 7 minutes for a worker first.'), true);
  });

  it('a cancelled token escalates without ever spawning route_task.py', async () => {
    let releaseCalls = 0;
    let runCalls = 0;
    const claimFn = claimRecorder(() => {
      releaseCalls += 1;
    });
    const cancelledCtx: TypedRouteContext = { ...CTX, cancelToken: { cancelled: true } };
    const outcome = await routeVoiceInboxTaskTyped('vi-111111111111', cancelledCtx, {
      isConfiguredFn: () => true,
      claimFn,
      readTaskFn: () => ROW,
      readRegistryFn: () => REGISTRY,
      askFn: confidentAsk('-100123_5', 0.95),
      runScript: async () => {
        runCalls += 1;
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    assert.equal(outcome.kind, 'escalated');
    assert.equal((outcome as { why: string }).why, 'cancelled-by-drain-deadline');
    assert.equal((outcome as { decision?: { kind: string } }).decision?.kind, 'decided');
    assert.equal(runCalls, 0);
    assert.equal(releaseCalls, 1);

    releaseCalls = 0;
    runCalls = 0;
    const notCancelledCtx: TypedRouteContext = { ...CTX, cancelToken: { cancelled: false } };
    const outcome2 = await routeVoiceInboxTaskTyped('vi-111111111111', notCancelledCtx, {
      isConfiguredFn: () => true,
      claimFn,
      readTaskFn: () => ROW,
      readRegistryFn: () => REGISTRY,
      askFn: confidentAsk('-100123_5', 0.95),
      runScript: async () => {
        runCalls += 1;
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    assert.equal(outcome2.kind, 'placed');
    assert.equal(runCalls, 1);
  });
});
