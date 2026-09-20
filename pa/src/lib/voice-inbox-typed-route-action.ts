/**
 * Typed voice-inbox routing action (2026-09-17) — the ONE typed placement
 * path, shared by the telegram bot's poll-tick drain
 * (voice-inbox-typed-route-drain.ts, decides above the thresholds) and the pa
 * fallback job's received arm (last resort, any confidence) — the
 * voice-inbox-transcribe.ts precedent. It acts ONLY through route_task.py's
 * existing argv (--task --topic --reason [--continues] [--create-topic]); no
 * --title (the destination's task_complete.py sets it) and no request
 * cleanup (operator decision D7).
 *
 * Every attempt: TypeSafe configured and voice_inbox_routing enabled →
 * blackboard claim voice-inbox-route:<task_id> (both callers take it, so they
 * never place one task twice) → live row read (state received) → an explicit
 * continuation routes to its conversation's topic, a keyword pin routes to its
 * topic, otherwise ONE TypeSafe request and the pure policy → cancel-token
 * check → live-state recheck → route_task.py. Escalation is returned, never
 * acted on here. Never throws; the claim is released on every path.
 *
 * Cancel token (2026-09-17, R18): ctx.cancelToken is a plain {cancelled}
 * object the CALLER may share across an attempt's whole lifetime. It is
 * checked once, immediately before route_task.py would be spawned (after the
 * TypeSafe call and every DB read) — a cancelled token escalates instead of
 * spawning. The bot-tick drain (voice-inbox-typed-route-drain.ts) is the one
 * caller that sets one, flipping it when TYPED_ROUTE_ATTEMPT_DEADLINE_MS
 * elapses so it can never inject the LLM inbox turn for a task while THIS
 * attempt might still spawn route_task.py for it. The fallback's received arm
 * (WP-D) passes no cancelToken — it has no deadline-vs-escalation race to
 * guard against (a single synchronous await per maintenance tick, not a
 * fire-and-forget attempt racing an independent injection path).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { blackboard } from '../blackboard.js';
import { log } from './log.js';
import { askSystemOne, isTypeSafeConfigured } from './typesafe-client.js';
import { readTopicRegistry, type TopicRegistryEntry } from './topic-registry.js';
import {
  TOPIC_KEY_RE,
  resolveVoiceInboxDefaultTopic,
  type VoiceInboxRoutingFileConfig,
} from './voice-inbox-routing-config.js';
import {
  askTypedRouting,
  candidateTopics,
  capReason,
  decideRoutingAction,
  matchKeywordPin,
  offerableConversations,
  type TypedRoutingDecision,
  type TypedRoutingPlacement,
} from './voice-inbox-typed-routing.js';
import {
  WORKER_SCRIPT_TIMEOUT_MS,
  defaultLoadVoiceInboxModules,
  defaultRunScript,
  openReadonly,
  type RunScriptFn,
  type VoiceInboxModules,
} from './voice-inbox-transcribe.js';

const MODULE = 'voice-inbox-typed-route';
export const ROUTE_CLAIM_AGENT = 'voice-inbox-typed-route';

export function routeClaimResource(taskId: string): string {
  return `voice-inbox-route:${taskId}`;
}

export interface RouteClaim {
  release(): Promise<void>;
}

/** Try-once blackboard claim on one task's routing (the transcription-claim shape). */
export async function acquireRouteClaim(taskId: string): Promise<RouteClaim | null> {
  const resource = routeClaimResource(taskId);
  const contextId = randomUUID();
  const ok = await blackboard.acquireLock(resource, ROUTE_CLAIM_AGENT, process.pid, 0, contextId);
  if (!ok) return null;
  return {
    release: () => blackboard.releaseLock(resource, ROUTE_CLAIM_AGENT, contextId, { pid: process.pid }),
  };
}

export interface TypedRouteTaskRow {
  task_id: string;
  tenant_id: string;
  state: string;
  source: string;
  request_text: string | null;
  transcript: string | null;
  conversation_id: string;
  feedback_about: string | null;
}

export type TypedRouteOutcome =
  | { kind: 'placed'; action: TypedRoutingPlacement; scriptExit: 0 }
  | { kind: 'escalated'; why: string; decision?: TypedRoutingDecision }
  | { kind: 'raced' }
  | { kind: 'claim-busy' }
  | { kind: 'script-failed'; action: TypedRoutingPlacement; scriptExit: number };

export interface TypedRouteContext {
  /** Log label of the calling module. */
  caller: string;
  repoRoot: string;
  ledgerPath: string;
  fileConfig: VoiceInboxRoutingFileConfig;
  /** true = the fallback's last resort (and the drain under escalation: place). */
  lastResort: boolean;
  /** Appended to the reason, e.g. how long the task waited. */
  reasonSuffix?: string;
  /** Set by the caller's deadline (drain only; R18). Checked once, right
   *  before route_task.py would be spawned. */
  cancelToken?: { cancelled: boolean };
}

export interface TypedRouteDeps {
  isConfiguredFn?: () => boolean;
  claimFn?: (taskId: string) => Promise<RouteClaim | null>;
  readTaskFn?: (ledgerPath: string, taskId: string) => TypedRouteTaskRow | undefined;
  conversationTopicFn?: (ledgerPath: string, tenantId: string, conversationId: string, excludeTaskId: string) => string | null;
  listOpenConversationsFn?: (
    ctx: TypedRouteContext,
    row: TypedRouteTaskRow
  ) => Promise<Array<{ conversationId: string; snippet: string }>>;
  readRegistryFn?: () => TopicRegistryEntry[];
  askFn?: typeof askSystemOne;
  runScript?: RunScriptFn;
  loadVoiceInboxModules?: (repoRoot: string) => Promise<VoiceInboxModules>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Same ref-id convention as the fallback job's logAction. */
export function logTypedRouteAction(
  level: 'info' | 'warn',
  caller: string,
  taskId: string,
  action: string,
  detail: Record<string, unknown>
): void {
  const refId = `s-${randomBytes(6).toString('hex')}`;
  log(level, MODULE, `typed routing: ${action}`, { refId, caller, taskId, action, ...detail });
}

/** The routing columns of one task, read-only. undefined on any failure. */
export function readTypedRouteTask(ledgerPath: string, taskId: string): TypedRouteTaskRow | undefined {
  let db: Database.Database | undefined;
  try {
    db = openReadonly(ledgerPath);
    return db
      .prepare(
        'SELECT task_id, tenant_id, state, source, request_text, transcript, conversation_id, feedback_about FROM tasks WHERE task_id = ?'
      )
      .get(taskId) as TypedRouteTaskRow | undefined;
  } catch (err) {
    log('warn', MODULE, 'task read failed; not routing it', { taskId, error: errText(err) });
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }
}

/** A conversation's newest non-empty routed_to, excluding one task. null on none or failure. */
export function readConversationTopic(
  ledgerPath: string,
  tenantId: string,
  conversationId: string,
  excludeTaskId: string
): string | null {
  let db: Database.Database | undefined;
  try {
    db = openReadonly(ledgerPath);
    const row = db
      .prepare(
        `SELECT routed_to FROM tasks
         WHERE tenant_id = ? AND conversation_id = ? AND task_id != ? AND routed_to IS NOT NULL AND routed_to != ''
         ORDER BY created_at DESC, task_id DESC LIMIT 1`
      )
      .get(tenantId, conversationId, excludeTaskId) as { routed_to: string } | undefined;
    return row && TOPIC_KEY_RE.test(row.routed_to) ? row.routed_to : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }
}

/** The words to judge: a voice task's transcript, a text task's request. */
export function typedRoutingText(row: TypedRouteTaskRow): string {
  if (row.source === 'voice') return (row.transcript ?? '').trim();
  return (row.request_text ?? '').trim();
}

async function defaultListOpenConversations(
  ctx: TypedRouteContext,
  row: TypedRouteTaskRow,
  loadModules: (repoRoot: string) => Promise<VoiceInboxModules>
): Promise<Array<{ conversationId: string; snippet: string }>> {
  const modules = await loadModules(ctx.repoRoot);
  const list = modules.ledger.listOpenConversations;
  if (typeof list !== 'function') return [];
  let db: Database.Database | undefined;
  try {
    db = openReadonly(ctx.ledgerPath);
    return list.call(modules.ledger, db, row.tenant_id, { excludeConversationId: row.conversation_id });
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }
}

/** Place one received task by typed routing, or say why not. Never throws. */
export async function routeVoiceInboxTaskTyped(
  taskId: string,
  ctx: TypedRouteContext,
  deps: TypedRouteDeps = {}
): Promise<TypedRouteOutcome> {
  const isConfiguredFn = deps.isConfiguredFn ?? (() => isTypeSafeConfigured());
  if (!ctx.fileConfig.typedRouting) return { kind: 'escalated', why: 'typed-routing-disabled' };
  if (!isConfiguredFn()) return { kind: 'escalated', why: 'typesafe-unavailable:not-configured' };
  const claimFn = deps.claimFn ?? acquireRouteClaim;
  let claim: RouteClaim | null;
  try {
    claim = await claimFn(taskId);
  } catch (err) {
    log('warn', MODULE, 'route claim failed; leaving the task for the next attempt', { taskId, error: errText(err) });
    return { kind: 'claim-busy' };
  }
  if (!claim) return { kind: 'claim-busy' };
  try {
    return await routeClaimed(taskId, ctx, deps);
  } catch (err) {
    log('warn', MODULE, 'typed routing attempt threw; escalating', { taskId, caller: ctx.caller, error: errText(err) });
    return { kind: 'escalated', why: 'threw' };
  } finally {
    try {
      await claim.release();
    } catch {
      /* already released or purged */
    }
  }
}

async function routeClaimed(taskId: string, ctx: TypedRouteContext, deps: TypedRouteDeps): Promise<TypedRouteOutcome> {
  const typed = ctx.fileConfig.typedRouting;
  if (!typed) return { kind: 'escalated', why: 'typed-routing-disabled' };
  const readTaskFn = deps.readTaskFn ?? readTypedRouteTask;
  const row = readTaskFn(ctx.ledgerPath, taskId);
  if (!row || row.state !== 'received') return { kind: 'raced' };
  const text = typedRoutingText(row);
  if (text === '') return { kind: 'escalated', why: 'no-request-text' };
  const inboxTopic = ctx.fileConfig.inboxTopic;
  const resolvedDefault = resolveVoiceInboxDefaultTopic({ inboxTopic, configDefault: ctx.fileConfig.defaultTopic });
  if (!inboxTopic || !resolvedDefault) return { kind: 'escalated', why: 'no-inbox-topic' };
  const registry = (deps.readRegistryFn ?? (() => readTopicRegistry()))();
  const topicNames = new Map(registry.map((e) => [e.key, e.name] as const));
  const nameOf = (key: string): string => topicNames.get(key) ?? key;
  const suffix = ctx.reasonSuffix ?? '';
  const conversationTopicFn = deps.conversationTopicFn ?? readConversationTopic;

  let action: TypedRoutingPlacement;
  let decision: TypedRoutingDecision | undefined;
  if (row.conversation_id !== row.task_id) {
    // Explicit continuation (created with `continues`): no judgment needed.
    const known = conversationTopicFn(ctx.ledgerPath, row.tenant_id, row.conversation_id, row.task_id);
    const topicKey = known ?? (ctx.lastResort ? resolvedDefault.topic : null);
    if (topicKey === null) return { kind: 'escalated', why: 'continuation-without-topic' };
    action = {
      kind: 'route',
      topicKey,
      continues: row.conversation_id,
      basis: 'continuation-known',
      reason: capReason(`Placed in ${nameOf(topicKey)} automatically: it continues the conversation it was sent from.${suffix}`),
    };
  } else {
    const pin = matchKeywordPin(text, ctx.fileConfig.keywordTopics);
    if (pin) {
      action = {
        kind: 'route',
        topicKey: pin.topicKey,
        basis: 'keyword',
        reason: capReason(`Placed in ${nameOf(pin.topicKey)} automatically by the keyword rule for "${pin.keyword}".${suffix}`),
      };
    } else {
      const topics = candidateTopics(registry, inboxTopic);
      if (topics.length === 0) return { kind: 'escalated', why: 'no-topics' };
      const listOpen =
        deps.listOpenConversationsFn ??
        ((c: TypedRouteContext, r: TypedRouteTaskRow) =>
          defaultListOpenConversations(c, r, deps.loadVoiceInboxModules ?? defaultLoadVoiceInboxModules));
      let offer: Array<{ conversationId: string; snippet: string }> = [];
      if (!row.feedback_about) {
        try {
          offer = await listOpen(ctx, row);
        } catch (err) {
          // A missing voice-inbox build or a ledger read error must not block
          // placement: ask the destination question without an offer.
          log('warn', MODULE, 'open-conversation offer unavailable; asking without it', { taskId, error: errText(err) });
          offer = [];
        }
      }
      const open = offerableConversations(offer, (id) => conversationTopicFn(ctx.ledgerPath, row.tenant_id, id, row.task_id));
      decision = await askTypedRouting({ requestText: text, topics, openConversations: open }, { ask: deps.askFn });
      const decided = decideRoutingAction(
        decision,
        { ...typed, lastResort: ctx.lastResort, defaultTopic: resolvedDefault.topic },
        { topicNames, conversationTopics: new Map(open.map((c) => [c.conversationId, c.topicKey] as const)) }
      );
      if (decided.kind === 'escalate') return { kind: 'escalated', why: decided.why, decision };
      action = suffix ? { ...decided, reason: capReason(`${decided.reason}${suffix}`) } : decided;
    }
  }

  // Cancel-token check (R18): the drain's deadline may have fired while the
  // TypeSafe call and the DB reads above were running. Escalate instead of
  // spawning — the deadline inequality (voice-inbox-typed-route-drain.ts)
  // guarantees this check runs, and route_task.py is never spawned, before
  // that same deadline could otherwise fire and inject the LLM inbox turn.
  if (ctx.cancelToken?.cancelled) return { kind: 'escalated', why: 'cancelled-by-drain-deadline', decision };

  // Re-check as late as possible (the fallback's isStillReceived idiom): a live
  // worker or the other caller may have routed the task meanwhile.
  if (readTaskFn(ctx.ledgerPath, taskId)?.state !== 'received') return { kind: 'raced' };
  const args = ['--task', taskId, '--topic', action.topicKey, '--reason', action.reason];
  if (action.kind === 'route' && action.continues !== undefined) args.push('--continues', action.continues);
  if (action.kind === 'create-topic') args.push('--create-topic');
  const runScript = deps.runScript ?? defaultRunScript;
  const script = join(ctx.repoRoot, 'projects', 'voice-inbox', 'scripts', 'route_task.py');
  const result = await runScript(script, args, process.env, WORKER_SCRIPT_TIMEOUT_MS);
  const detail = {
    target: action.topicKey,
    placement: action.kind,
    basis: action.basis,
    continues: action.kind === 'route' ? (action.continues ?? null) : null,
    confidence: decision?.kind === 'decided' ? decision.destination.confidence : null,
    scriptExit: result.code,
  };
  if (result.code === 0) {
    logTypedRouteAction('info', ctx.caller, taskId, 'typed-route', detail);
    return { kind: 'placed', action, scriptExit: 0 };
  }
  logTypedRouteAction('warn', ctx.caller, taskId, 'typed-route-script-failed', detail);
  return { kind: 'script-failed', action, scriptExit: result.code };
}
