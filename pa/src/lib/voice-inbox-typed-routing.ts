/**
 * Typed voice-inbox routing decision (2026-09-17) — TypeSafe judgment plus a
 * pure policy. ONE request asks two parallel Choices: `destination` over the
 * inbox chat's registered topics (criteria = name + description) plus
 * none_of_the_above, and `continues` over the open-conversation offer plus
 * none (asked only when the offer is non-empty). decideRoutingAction turns the
 * decision and the thresholds into route / create-topic / escalate. Keyword
 * pins and explicit continuations need no judgment and live in the action
 * (voice-inbox-typed-route-action.ts). Criteria are strings (the API's
 * contract). Reasons are plain language (they render on the operator's card
 * and in the destination's injected `reason:`), name the topic, and stay
 * within 300 chars.
 */
import {
  askSystemOne,
  type TypeSafeChoiceAnswer,
  type TypeSafeErrorKind,
  type TypeSafeRequest,
} from './typesafe-client.js';
import type { TopicRegistryEntry } from './topic-registry.js';
import type { VoiceInboxTypedRoutingConfig } from './voice-inbox-routing-config.js';

export const NONE_OF_THE_ABOVE = 'none_of_the_above';
export const NO_CONTINUATION = 'none';
export const TYPED_ROUTING_STATE_MAX_CHARS = 8000;
export const TYPED_ROUTING_REASON_MAX_CHARS = 300;
export const CANCELLED_SNIPPET_SUFFIX = '[Cancelled]';
const CONVERSATION_ID_RE = /^vi-[0-9a-f]{12}$/;

export interface TypedRoutingTopic {
  key: string;
  name: string;
  description?: string;
}

export interface TypedRoutingConversation {
  conversationId: string;
  snippet: string;
  /** The conversation's newest routed topic, or null when it has none. */
  topicKey: string | null;
}

export interface TypedRoutingInput {
  requestText: string;
  topics: TypedRoutingTopic[];
  openConversations: TypedRoutingConversation[];
}

export interface TypedRoutingDecided {
  kind: 'decided';
  destination: { topicKey: string | null; confidence: number; top: Array<{ id: string; p: number }> };
  continuation?: { conversationId: string | null; confidence: number };
  latencyMs: number;
}

export type TypedRoutingDecision = TypedRoutingDecided | { kind: 'unavailable'; error: TypeSafeErrorKind };

export type TypedRoutingRouteBasis =
  | 'typesafe'
  | 'typesafe-continuation'
  | 'typesafe-default-topic'
  | 'keyword'
  | 'continuation-known';

export type TypedRoutingPlacement =
  | { kind: 'route'; topicKey: string; continues?: string; reason: string; basis: TypedRoutingRouteBasis }
  | { kind: 'create-topic'; topicKey: string; reason: string; basis: 'typesafe-no-match' };

export type TypedRoutingAction = TypedRoutingPlacement | { kind: 'escalate'; why: string };

export interface TypedRoutingPolicy extends VoiceInboxTypedRoutingConfig {
  /** true = the fallback's last resort: act on the top destination at any confidence. */
  lastResort: boolean;
  /** Resolved default topic (resolveVoiceInboxDefaultTopic); also route_task.py's --topic when forming a topic. */
  defaultTopic: string;
}

/** The inbox chat's registered topics minus the inbox topic itself. */
export function candidateTopics(registry: readonly TopicRegistryEntry[], inboxTopic: string): TypedRoutingTopic[] {
  const match = /^(-?\d+)_\d+$/.exec(inboxTopic);
  if (!match) return [];
  return registry
    .filter((e) => e.chatId === match[1] && e.key !== inboxTopic)
    .map((e) => {
      const description = e.description?.trim();
      return description ? { key: e.key, name: e.name, description } : { key: e.key, name: e.name };
    });
}

/** The offer minus malformed ids and any conversation whose status word is Cancelled. */
export function offerableConversations(
  open: ReadonlyArray<{ conversationId: string; snippet: string }>,
  topicOf: (conversationId: string) => string | null
): TypedRoutingConversation[] {
  return open
    .filter((c) => CONVERSATION_ID_RE.test(c.conversationId) && !c.snippet.trimEnd().endsWith(CANCELLED_SNIPPET_SUFFIX))
    .map((c) => ({ conversationId: c.conversationId, snippet: c.snippet, topicKey: topicOf(c.conversationId) }));
}

/** First keyword-table entry contained (case-insensitively) in the request. */
export function matchKeywordPin(
  requestText: string,
  keywordTopics: Record<string, string>
): { keyword: string; topicKey: string } | undefined {
  const lower = requestText.toLowerCase();
  for (const [keyword, topicKey] of Object.entries(keywordTopics)) {
    if (keyword && lower.includes(keyword)) return { keyword, topicKey };
  }
  return undefined;
}

export function buildTypedRoutingRequest(input: TypedRoutingInput): TypeSafeRequest {
  const destinationCriteria: Record<string, string> = {};
  for (const t of input.topics) {
    destinationCriteria[t.key] = t.description ? `Topic "${t.name}": ${t.description}` : `Topic "${t.name}"`;
  }
  destinationCriteria[NONE_OF_THE_ABOVE] = 'None of the listed topics fits this request; it needs a new topic of its own.';
  const questions: TypeSafeRequest['questions'] = {
    destination: {
      type: 'choice',
      instructions:
        'The assistant keeps separate topics, each with a name and a purpose. Which topic should handle the request in `request`?',
      criteria: destinationCriteria,
    },
  };
  if (input.openConversations.length > 0) {
    const continuationCriteria: Record<string, string> = {};
    for (const c of input.openConversations) continuationCriteria[c.conversationId] = `Open conversation: ${c.snippet}`;
    continuationCriteria[NO_CONTINUATION] = 'A separate new request that does not continue any listed conversation.';
    questions.continues = {
      type: 'choice',
      instructions:
        'Each option other than "none" is a recent conversation, shown by the opening words of its first request and how long ago it was updated. Does the request in `request` continue one of those conversations, or is it a separate new request?',
      criteria: continuationCriteria,
    };
  }
  return { state: { request: input.requestText.slice(0, TYPED_ROUTING_STATE_MAX_CHARS) }, questions };
}

function top3(answer: TypeSafeChoiceAnswer): Array<{ id: string; p: number }> {
  return Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, p]) => ({ id, p }));
}

/** One TypeSafe request, both questions. Never throws (askSystemOne never throws). */
export async function askTypedRouting(
  input: TypedRoutingInput,
  opts: { ask?: typeof askSystemOne; purpose?: string } = {}
): Promise<TypedRoutingDecision> {
  const ask = opts.ask ?? askSystemOne;
  const result = await ask(buildTypedRoutingRequest(input), { purpose: opts.purpose ?? 'voice-inbox-routing' });
  if (!result.ok) return { kind: 'unavailable', error: result.error };
  const destination = result.answers.destination;
  if (!destination || destination.type !== 'choice') return { kind: 'unavailable', error: 'invalid-response' };
  const decision: TypedRoutingDecided = {
    kind: 'decided',
    destination: {
      topicKey: destination.choice === NONE_OF_THE_ABOVE ? null : destination.choice,
      confidence: destination.confidence,
      top: top3(destination),
    },
    latencyMs: result.latencyMs,
  };
  const continues = result.answers.continues;
  if (input.openConversations.length > 0 && continues && continues.type === 'choice') {
    decision.continuation = {
      conversationId: continues.choice === NO_CONTINUATION ? null : continues.choice,
      confidence: continues.confidence,
    };
  }
  return decision;
}

export function capReason(text: string): string {
  return text.length > TYPED_ROUTING_REASON_MAX_CHARS ? `${text.slice(0, TYPED_ROUTING_REASON_MAX_CHARS - 1)}…` : text;
}

function percent(confidence: number): number {
  return Math.round(confidence * 100);
}

/**
 * Pure policy. Order: a confident continuation whose conversation has a topic
 * → route there with --continues; below act_confidence (unless last resort) →
 * escalate; a named topic → route; none_of_the_above → per no_match
 * (create-topic | default-topic | escalate; the last resort turns escalate
 * into create-topic). An unavailable decision always escalates — the callers
 * decide what escalation means.
 */
export function decideRoutingAction(
  decision: TypedRoutingDecision,
  policy: TypedRoutingPolicy,
  ctx: { topicNames: ReadonlyMap<string, string>; conversationTopics: ReadonlyMap<string, string | null> }
): TypedRoutingAction {
  if (decision.kind === 'unavailable') return { kind: 'escalate', why: `typesafe-unavailable:${decision.error}` };
  const nameOf = (key: string): string => ctx.topicNames.get(key) ?? key;
  const c = decision.continuation;
  if (c && c.conversationId !== null && c.confidence >= policy.continueConfidence) {
    const topicKey = ctx.conversationTopics.get(c.conversationId) ?? null;
    if (topicKey !== null) {
      return {
        kind: 'route',
        topicKey,
        continues: c.conversationId,
        basis: 'typesafe-continuation',
        reason: capReason(`Placed in ${nameOf(topicKey)} automatically: it continues an open conversation there (${percent(c.confidence)}% sure).`),
      };
    }
  }
  const d = decision.destination;
  if (!policy.lastResort && d.confidence < policy.actConfidence) {
    return { kind: 'escalate', why: `low-confidence:${d.confidence.toFixed(3)}` };
  }
  if (d.topicKey !== null) {
    return {
      kind: 'route',
      topicKey: d.topicKey,
      basis: 'typesafe',
      reason: capReason(`Placed in ${nameOf(d.topicKey)} automatically: the request matched that topic (${percent(d.confidence)}% sure).`),
    };
  }
  const noMatch = policy.lastResort && policy.noMatch === 'escalate' ? 'create-topic' : policy.noMatch;
  if (noMatch === 'escalate') return { kind: 'escalate', why: 'no-match' };
  if (noMatch === 'default-topic') {
    return {
      kind: 'route',
      topicKey: policy.defaultTopic,
      basis: 'typesafe-default-topic',
      reason: capReason(`Placed in ${nameOf(policy.defaultTopic)} automatically: no existing topic fitted the request.`),
    };
  }
  return {
    kind: 'create-topic',
    topicKey: policy.defaultTopic,
    basis: 'typesafe-no-match',
    reason: capReason(`Placed in ${nameOf(policy.defaultTopic)} automatically: no existing topic fitted the request (${percent(d.confidence)}% sure).`),
  };
}
