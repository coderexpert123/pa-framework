import './test-env-guard.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TypeSafeResult } from '../src/lib/typesafe-client.js';
import type { TopicRegistryEntry } from '../src/lib/topic-registry.js';
import {
  askTypedRouting,
  buildTypedRoutingRequest,
  candidateTopics,
  decideRoutingAction,
  matchKeywordPin,
  offerableConversations,
  type TypedRoutingDecided,
  type TypedRoutingPolicy,
} from '../src/lib/voice-inbox-typed-routing.js';

const INBOX = '-100123_900';

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

const POLICY: TypedRoutingPolicy = {
  actConfidence: 0.9,
  continueConfidence: 0.9,
  noMatch: 'create-topic',
  escalation: 'llm-turn',
  lastResort: false,
  defaultTopic: '-100123_0',
};

describe('candidateTopics', () => {
  it('candidateTopics keeps the inbox chat topics minus the inbox topic itself', () => {
    const topics = candidateTopics(REGISTRY, INBOX);
    assert.deepEqual(
      topics.map((t) => t.key),
      ['-100123_0', '-100123_5']
    );
    const general = topics.find((t) => t.key === '-100123_0');
    assert.equal(general?.description, 'Anything that fits nowhere else');
  });
});

describe('offerableConversations', () => {
  it('offerableConversations drops a Cancelled conversation and malformed ids', () => {
    const open = [
      { conversationId: 'vi-aaaaaaaaaaaa', snippet: 'x (updated 2m) [Cancelled]' },
      { conversationId: 'vi-bbbbbbbbbbbb', snippet: 'y (updated 5m) [Running]' },
      { conversationId: 'bad-id', snippet: 'z (updated 1m)' },
    ];
    const topicOf = (id: string): string | null => (id === 'vi-bbbbbbbbbbbb' ? '-100123_5' : null);
    assert.deepEqual(offerableConversations(open, topicOf), [
      { conversationId: 'vi-bbbbbbbbbbbb', snippet: 'y (updated 5m) [Running]', topicKey: '-100123_5' },
    ]);
  });
});

describe('buildTypedRoutingRequest', () => {
  it('buildTypedRoutingRequest adds none_of_the_above and asks continues only with an offer', () => {
    const topics = candidateTopics(REGISTRY, INBOX);
    const noOffer = buildTypedRoutingRequest({ requestText: 'hi', topics, openConversations: [] });
    assert.deepEqual(Object.keys(noOffer.questions), ['destination']);
    const destinationCriteria = noOffer.questions.destination.criteria as Record<string, string>;
    assert.equal(
      destinationCriteria.none_of_the_above,
      'None of the listed topics fits this request; it needs a new topic of its own.'
    );
    assert.equal(destinationCriteria['-100123_5'], 'Topic "health": Doctor visits and medicines');

    const offer = [{ conversationId: 'vi-bbbbbbbbbbbb', snippet: 'y (updated 5m) [Running]', topicKey: '-100123_5' }];
    const withOffer = buildTypedRoutingRequest({ requestText: 'hi', topics, openConversations: offer });
    assert.deepEqual(Object.keys(withOffer.questions), ['destination', 'continues']);
    const continuesCriteria = withOffer.questions.continues?.criteria as Record<string, string>;
    assert.deepEqual(Object.keys(continuesCriteria), ['vi-bbbbbbbbbbbb', 'none']);

    const longText = 'a'.repeat(9000);
    const capped = buildTypedRoutingRequest({ requestText: longText, topics: [], openConversations: [] });
    assert.equal((capped.state as { request: string }).request.length, 8000);
  });
});

describe('askTypedRouting', () => {
  it('askTypedRouting maps none_of_the_above to a null topic and a failure to unavailable', async () => {
    const okAsk = async (): Promise<TypeSafeResult> => ({
      ok: true,
      answers: {
        destination: {
          type: 'choice',
          choice: 'none_of_the_above',
          probabilities: { none_of_the_above: 0.9 },
          confidence: 0.9,
        },
      },
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 5,
      status: 200,
      retries: 0,
    });
    const decision = await askTypedRouting({ requestText: 'x', topics: [], openConversations: [] }, { ask: okAsk });
    assert.equal(decision.kind, 'decided');
    assert.equal((decision as TypedRoutingDecided).destination.topicKey, null);

    const failAsk = async (): Promise<TypeSafeResult> => ({ ok: false, error: 'timeout', latencyMs: 5, retries: 0 });
    const decision2 = await askTypedRouting({ requestText: 'x', topics: [], openConversations: [] }, { ask: failAsk });
    assert.deepEqual(decision2, { kind: 'unavailable', error: 'timeout' });
  });
});

describe('decideRoutingAction', () => {
  it('decideRoutingAction escalates below act_confidence when not last resort', () => {
    const decision: TypedRoutingDecided = {
      kind: 'decided',
      destination: { topicKey: '-100123_5', confidence: 0.89, top: [] },
      latencyMs: 5,
    };
    const ctx = { topicNames: new Map<string, string>(), conversationTopics: new Map<string, string | null>() };
    assert.deepEqual(decideRoutingAction(decision, POLICY, ctx), { kind: 'escalate', why: 'low-confidence:0.890' });
  });

  it('decideRoutingAction routes at act_confidence and names the topic in the reason', () => {
    const decision: TypedRoutingDecided = {
      kind: 'decided',
      destination: { topicKey: '-100123_5', confidence: 0.9, top: [] },
      latencyMs: 5,
    };
    const ctx = {
      topicNames: new Map([['-100123_5', 'health']]),
      conversationTopics: new Map<string, string | null>(),
    };
    const result = decideRoutingAction(decision, POLICY, ctx);
    assert.equal(result.kind, 'route');
    assert.equal((result as { topicKey: string }).topicKey, '-100123_5');
    assert.equal((result as { basis: string }).basis, 'typesafe');
    assert.equal(
      (result as { reason: string }).reason,
      'Placed in health automatically: the request matched that topic (90% sure).'
    );
  });

  it('a confident continuation routes to that conversation topic with continues', () => {
    const decision: TypedRoutingDecided = {
      kind: 'decided',
      destination: { topicKey: null, confidence: 0.2, top: [] },
      continuation: { conversationId: 'vi-bbbbbbbbbbbb', confidence: 0.95 },
      latencyMs: 5,
    };
    const ctx = {
      topicNames: new Map([['-100123_5', 'health']]),
      conversationTopics: new Map<string, string | null>([['vi-bbbbbbbbbbbb', '-100123_5']]),
    };
    const result = decideRoutingAction(decision, POLICY, ctx);
    assert.equal(result.kind, 'route');
    assert.equal((result as { topicKey: string }).topicKey, '-100123_5');
    assert.equal((result as { continues?: string }).continues, 'vi-bbbbbbbbbbbb');
    assert.equal((result as { basis: string }).basis, 'typesafe-continuation');
  });

  it('a continuation below continue_confidence is ignored', () => {
    const decision: TypedRoutingDecided = {
      kind: 'decided',
      destination: { topicKey: '-100123_0', confidence: 0.95, top: [] },
      continuation: { conversationId: 'vi-bbbbbbbbbbbb', confidence: 0.89 },
      latencyMs: 5,
    };
    const ctx = {
      topicNames: new Map<string, string>(),
      conversationTopics: new Map<string, string | null>([['vi-bbbbbbbbbbbb', '-100123_5']]),
    };
    const result = decideRoutingAction(decision, POLICY, ctx);
    assert.equal(result.kind, 'route');
    assert.equal((result as { topicKey: string }).topicKey, '-100123_0');
    assert.equal('continues' in result, false);
  });

  it('a confident none_of_the_above follows no_match', () => {
    const decision: TypedRoutingDecided = {
      kind: 'decided',
      destination: { topicKey: null, confidence: 0.95, top: [] },
      latencyMs: 5,
    };
    const ctx = { topicNames: new Map<string, string>(), conversationTopics: new Map<string, string | null>() };

    const createTopicResult = decideRoutingAction(decision, { ...POLICY, noMatch: 'create-topic' }, ctx);
    assert.equal(createTopicResult.kind, 'create-topic');
    assert.equal((createTopicResult as { topicKey: string }).topicKey, '-100123_0');
    assert.equal((createTopicResult as { basis: string }).basis, 'typesafe-no-match');

    const defaultTopicResult = decideRoutingAction(decision, { ...POLICY, noMatch: 'default-topic' }, ctx);
    assert.equal(defaultTopicResult.kind, 'route');
    assert.equal((defaultTopicResult as { topicKey: string }).topicKey, '-100123_0');
    assert.equal((defaultTopicResult as { basis: string }).basis, 'typesafe-default-topic');

    const escalateResult = decideRoutingAction(decision, { ...POLICY, noMatch: 'escalate' }, ctx);
    assert.deepEqual(escalateResult, { kind: 'escalate', why: 'no-match' });
  });

  it('last resort acts on the top destination at any confidence and never escalates on an available decision', () => {
    const ctx = { topicNames: new Map<string, string>(), conversationTopics: new Map<string, string | null>() };
    const lastResortPolicy: TypedRoutingPolicy = { ...POLICY, lastResort: true };

    const routeDecision: TypedRoutingDecided = {
      kind: 'decided',
      destination: { topicKey: '-100123_5', confidence: 0.1, top: [] },
      latencyMs: 5,
    };
    assert.equal(decideRoutingAction(routeDecision, lastResortPolicy, ctx).kind, 'route');

    const noMatchDecision: TypedRoutingDecided = {
      kind: 'decided',
      destination: { topicKey: null, confidence: 0.1, top: [] },
      latencyMs: 5,
    };
    const lastResortEscalatePolicy: TypedRoutingPolicy = { ...POLICY, lastResort: true, noMatch: 'escalate' };
    assert.equal(decideRoutingAction(noMatchDecision, lastResortEscalatePolicy, ctx).kind, 'create-topic');

    assert.deepEqual(decideRoutingAction({ kind: 'unavailable', error: 'no-key' }, lastResortPolicy, ctx), {
      kind: 'escalate',
      why: 'typesafe-unavailable:no-key',
    });
  });

  it('reasons are capped at 300 chars', () => {
    const decision: TypedRoutingDecided = {
      kind: 'decided',
      destination: { topicKey: '-100123_5', confidence: 0.95, top: [] },
      latencyMs: 5,
    };
    const ctx = {
      topicNames: new Map([['-100123_5', 'n'.repeat(400)]]),
      conversationTopics: new Map<string, string | null>(),
    };
    const result = decideRoutingAction(decision, POLICY, ctx);
    assert.equal(result.kind, 'route');
    const reason = (result as { reason: string }).reason;
    assert.equal(reason.length, 300);
    assert.ok(reason.endsWith('…'));
  });
});

describe('matchKeywordPin', () => {
  it('matchKeywordPin returns the first keyword contained in the request', () => {
    const table = { invoice: '-1_5', bill: '-1_6' };
    assert.deepEqual(matchKeywordPin('Pay the BILL and the invoice', table), { keyword: 'invoice', topicKey: '-1_5' });
    assert.equal(matchKeywordPin('nothing', table), undefined);
  });
});
