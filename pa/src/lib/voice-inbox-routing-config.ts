/**
 * Voice-inbox routing config (2026-09-17) — pa's raw reader of the three
 * config.yaml blocks routing reads: voice_inbox.inbox_topic / default_topic,
 * voice_inbox_fallback.keyword_topics and voice_inbox_routing (TypeSafe typed
 * routing). No PaConfig schema: the fallback job has read these blocks raw
 * since AI-214, and the bot's typed route drain reads them the same way.
 * voice_inbox_routing is OFF unless `enabled: true`; absent or disabled yields
 * no typedRouting at all, so every caller keeps today's behaviour. Also the
 * ONE default-topic resolver: env PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC, then
 * voice_inbox.default_topic, then thread 0 of the inbox chat.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { configPath } from '../paths.js';

export const TOPIC_KEY_RE = /^-?\d+_\d+$/;
export const DEFAULT_TYPED_ACT_CONFIDENCE = 0.9;
export const DEFAULT_TYPED_CONTINUE_CONFIDENCE = 0.9;

export type TypedRoutingNoMatch = 'create-topic' | 'default-topic' | 'escalate';
export type TypedRoutingEscalation = 'llm-turn' | 'place';

export interface VoiceInboxTypedRoutingConfig {
  actConfidence: number;
  continueConfidence: number;
  noMatch: TypedRoutingNoMatch;
  escalation: TypedRoutingEscalation;
}

export interface VoiceInboxRoutingFileConfig {
  inboxTopic?: string;
  keywordTopics: Record<string, string>;
  defaultTopic?: string;
  typedRouting?: VoiceInboxTypedRoutingConfig;
}

function unitInterval(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : fallback;
}

/** The voice_inbox_routing block, or undefined unless `enabled: true`. */
export function parseVoiceInboxTypedRouting(raw: unknown): VoiceInboxTypedRoutingConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.enabled !== true) return undefined;
  return {
    actConfidence: unitInterval(r.act_confidence, DEFAULT_TYPED_ACT_CONFIDENCE),
    continueConfidence: unitInterval(r.continue_confidence, DEFAULT_TYPED_CONTINUE_CONFIDENCE),
    noMatch: r.no_match === 'default-topic' || r.no_match === 'escalate' ? r.no_match : 'create-topic',
    escalation: r.escalation === 'place' ? 'place' : 'llm-turn',
  };
}

/** Fail-soft: a missing or unparsable file yields `{ keywordTopics: {} }`.
 *  Unset fields are OMITTED (never undefined-valued). */
export function readVoiceInboxRoutingFileConfig(path: string = configPath()): VoiceInboxRoutingFileConfig {
  try {
    const parsed = parseYaml(readFileSync(path, 'utf8')) ?? {};
    const out: VoiceInboxRoutingFileConfig = { keywordTopics: {} };
    const inboxTopic = parsed?.voice_inbox?.inbox_topic;
    if (typeof inboxTopic === 'string') out.inboxTopic = inboxTopic;
    const defaultTopic = parsed?.voice_inbox?.default_topic;
    if (typeof defaultTopic === 'string' && TOPIC_KEY_RE.test(defaultTopic.trim())) out.defaultTopic = defaultTopic.trim();
    const rawTable = parsed?.voice_inbox_fallback?.keyword_topics;
    if (rawTable && typeof rawTable === 'object') {
      for (const [keyword, topic] of Object.entries(rawTable as Record<string, unknown>)) {
        if (typeof topic === 'string' && TOPIC_KEY_RE.test(topic)) {
          out.keywordTopics[String(keyword).toLowerCase()] = topic;
        }
      }
    }
    const typedRouting = parseVoiceInboxTypedRouting(parsed?.voice_inbox_routing);
    if (typedRouting) out.typedRouting = typedRouting;
    return out;
  } catch {
    return { keywordTopics: {} };
  }
}

export type DefaultTopicSource = 'env' | 'config' | 'inbox-chat';

/** The one default-topic resolver. undefined only when nothing resolves. */
export function resolveVoiceInboxDefaultTopic(input: {
  inboxTopic?: string;
  configDefault?: string;
  env?: NodeJS.ProcessEnv;
}): { topic: string; source: DefaultTopicSource } | undefined {
  const env = input.env ?? process.env;
  const fromEnv = env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC?.trim();
  if (fromEnv && TOPIC_KEY_RE.test(fromEnv)) return { topic: fromEnv, source: 'env' };
  const fromConfig = input.configDefault?.trim();
  if (fromConfig && TOPIC_KEY_RE.test(fromConfig)) return { topic: fromConfig, source: 'config' };
  const match = input.inboxTopic ? /^(-?\d+)_\d+$/.exec(input.inboxTopic) : null;
  if (match) return { topic: `${match[1]}_0`, source: 'inbox-chat' };
  return undefined;
}
