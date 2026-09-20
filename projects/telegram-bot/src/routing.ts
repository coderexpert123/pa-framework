/**
 * routing.ts — model routing policy wrapper (2026-09-11,
 * plans/2026-09-11-model-routing-policy.md).
 *
 * applyRoutingPolicy is the ONE call site main.ts needs: given the turn's
 * context it returns the effective default worker for THIS turn, overriding
 * the topic default only for code/engineering-classified turns under an
 * enabled `routing_policy` config. Fail-open — any absence,
 * explicit pin, router mutation, or error returns the incoming default
 * unchanged, so a bad policy can never break dispatch.
 *
 * WHAT is classified (2026-09-16, plans/2026-09-16-routing-judge-request-only-SPEC.md):
 * the operator's request, never injected instruction text. A turn naming
 * voice-inbox tasks classifies each task's ledger request (read-only);
 * anything unresolvable falls back to the turn text. A command turn
 * (isCommandTurn) skips classification and keeps the incoming default.
 */

import { resolveRoutingWorker } from '../../../pa/dist/src/lib/routing-policy.js';
import { routeTurn as routeTurnDefault } from '../../../pa/dist/src/lib/model-router/router.js';
import type { RouteTurnInput, RouteTurnResult } from '../../../pa/dist/src/lib/model-router/router.js';
import { voiceConversationKeyForTasks } from '../../../pa/dist/src/lib/model-router/context-reader.js';
import type { CapabilityTier, CostTierConfig, EffortScore, ModelRouterConfig, RoutingPolicyConfig } from '../../../pa/dist/src/types.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { classifiableRequestText, voiceInboxTaskRequests } from '../../../pa/dist/src/lib/voice-inbox-ledger.js';
import type { VoiceInboxTaskRequest } from '../../../pa/dist/src/lib/voice-inbox-ledger.js';
import { extractVoiceInboxTaskIds } from './voice-inbox-bridge.js';
import { isKnownCommand, isPassThroughCommand, isSingleSlashCommand, UPDATE_BRAIN_PATTERN } from './logic.js';

export interface ApplyRoutingPolicyArgs {
  config: {
    routing_policy?: RoutingPolicyConfig;
    cost_tier?: CostTierConfig;
    model_router?: ModelRouterConfig;
    workers?: Array<{ name: string }>;
  };
  topicKey: string;
  /** Topic name + description for the classifier's topic state (spec 0.1.3,
   *  decision 6 — the classifier sees the topic, not just the key). */
  topicName?: string;
  topicDescription?: string;
  userText: string;
  /** Explicit /agent pin — outranks the policy (IST-midnight expiry, existing). */
  preferredWorker?: string;
  /** RAW topic_defaults[topicKey] (what getConfiguredDefaultWorker reads). */
  configuredDefault?: string;
  /** The pre-policy baseline (getEffectiveDefaultWorker) — a command-router
   *  mutation of the default this turn is an explicit choice that outranks
   *  the policy. */
  baselineDefault: string;
  /** Injectable clock for tests; production omits it (resolution uses now). */
  now?: Date;
  /** Injectable runner for tests. */
  judgeRunner?: (text: string, model: string, timeoutMs: number) => Promise<import('../../../pa/dist/src/lib/routing-policy.js').RequestClass | undefined>;
  /** Test seam — default is the real read-only pa ledger read (voiceInboxTaskRequests). */
  readVoiceTaskRequests?: (taskIds: readonly string[]) => Map<string, VoiceInboxTaskRequest>;
  /** Injected router classifier seam (typesafe ask); default is the real askSystemOne inside routeTurn. */
  routerAsk?: Parameters<typeof routeTurnDefault>[0]['ask'];
  /** Injected availability seam; default is routeTurn's fleet/cool-down predicate. */
  routerAvailability?: (worker: string) => Promise<boolean>;
  /** Injected context-reader seam; default is routeTurn's real readTurnContext
   *  (which also yields the incumbent worker for stickiness). */
  routerReadContext?: Parameters<typeof routeTurnDefault>[0]['readContext'];
  /** Full router override (test seam) — replaces routeTurn entirely. */
  routeTurnFn?: (input: RouteTurnInput) => Promise<RouteTurnResult>;
  /** Placement candidate views (spec §3.1, decision 21) — the caller computes
   *  them (main.ts, behind the placement surface) and they are forwarded into
   *  RouteTurnInput verbatim. PRESENT-BUT-EMPTY still asks the placement
   *  question (other/split* validated away) — never collapse [] to absent. */
  candidates?: RouteTurnInput['candidates'];
  /** In-flight run views (spec §4.1, decision 24) — non-empty adds steer_wait.
   *  The reply-to FYI anchor rides here as in-flight context on live-steer
   *  turns (the caller folds it in before this call). */
  currentInflight?: RouteTurnInput['currentInflight'];
}

/** Which text the classifier saw this turn. */
export type ClassificationTextSource = 'ledger-request' | 'turn-text';

export interface ClassificationText {
  text: string;
  source: ClassificationTextSource;
  /** Voice-inbox task ids named by the turn text, first-seen order ([] for none). */
  taskIds: string[];
  /** Why a turn naming task ids fell back to its turn text. Never carries request text. */
  fallbackReason?: string;
}

/**
 * The operator's words for one ledger row. Defined once in pa's
 * voice-inbox-ledger (`pa typesafe eval --judge` samples through the same rule)
 * and re-exported for this module's callers and tests.
 */
export { classifiableRequestText };

/**
 * Choose the text to classify. No voice-inbox task id → the turn text. Ids →
 * every task's ledger request joined in first-seen order; any read failure,
 * missing row or not-yet-usable request → the whole turn text (fail open to
 * today's behaviour, with the reason). Never throws.
 */
export function resolveClassificationText(
  userText: string,
  readRequests: (taskIds: readonly string[]) => Map<string, VoiceInboxTaskRequest> = voiceInboxTaskRequests,
): ClassificationText {
  const taskIds = extractVoiceInboxTaskIds(userText);
  if (taskIds.length === 0) return { text: userText, source: 'turn-text', taskIds };
  const fallback = (fallbackReason: string): ClassificationText => ({ text: userText, source: 'turn-text', taskIds, fallbackReason });
  let rows: Map<string, VoiceInboxTaskRequest>;
  try {
    rows = readRequests(taskIds);
  } catch (err) {
    return fallback(`ledger read threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  const texts: string[] = [];
  for (const id of taskIds) {
    const row = rows.get(id);
    if (!row) return fallback(`no ledger row for ${id}`);
    const text = classifiableRequestText(row);
    if (text === undefined) return fallback(`no usable request yet for ${id}`);
    texts.push(text);
  }
  return { text: texts.join('\n\n'), source: 'ledger-request', taskIds };
}

/**
 * A command turn skips classification (operator decision 2026-09-16: a /status
 * must never wait on the judge). `text` is the command router's OUTPUT, so a
 * command that dispatches a worker has already been rewritten into plain
 * instruction text. Skill pass-through commands dispatch an LLM turn with the
 * slash text intact and are classified — except /update_brain, which the router
 * always consumes (rewrite on success, skipWorker on refusal). Reuses the
 * unknown-command guard's own matchers; no new command regex.
 */
export function isCommandTurn(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('/')) return false;
  if (isPassThroughCommand(t) && !UPDATE_BRAIN_PATTERN.test(t)) return false;
  return isKnownCommand(t) || isSingleSlashCommand(t) !== undefined;
}

/** What a routed turn hands the dispatcher: the worker plus, when the router
 *  decided (model_router.enabled), the model/effort projection for THIS turn's
 *  tunable slice. Phase 2 (2026-09-19) adds the failover chain (decision 20,
 *  worker names — dispatch.ts forwards it into RunOptions.candidateOrder only
 *  when model_router.surfaces.fallback === 'live'), the placement decision
 *  (decisions 22/23) and steer/wait (decision 24) pass-through. */
export interface TurnRoutingResult {
  worker: string;
  model?: string;
  effort?: string;
  projectionOutcome?: string;
  /** Decision 20: the FULL availability-filtered chain, chosen.worker first
   *  (entry 0 included — excludeWorkers already handles the failed default). */
  chain?: string[];
  /** The classified needs (RouteTurnResult.tier/score) — WP-5 integrator seam:
   *  rides `__placementCarry` so the DESTINATION resolve can run the
   *  capability-UP filter (§3.3). Fail-open turns carry none (absence is the
   *  '+no-carried-needs' signal, pinned by deepEqual). */
  tier?: CapabilityTier;
  score?: EffortScore;
  /** Decisions 22/23 pass-through from RouteTurnResult. */
  placement?: RouteTurnResult['placement'];
  /** Decision 24 pass-through from RouteTurnResult. */
  steerWait?: RouteTurnResult['steerWait'];
}

/**
 * Decision 25 gate: the block exists, the router is enabled, and pins are not
 * explicitly restored. Absent deprecate_pins + block present = deprecated
 * (default ON); explicit false = today's behaviour. Effective only on
 * router-decided turns (enabled true, non-command — the command-turn leg is
 * enforced by the pinnedTurn computation at the call site).
 */
export function deprecatePinsEffective(block: ModelRouterConfig | undefined): boolean {
  return block !== undefined && block.enabled === true && block.deprecate_pins !== false;
}

/** I-4 floor: with pins deprecated the fail-open baseline is the FIRST
 *  CONFIGURED worker — topic_defaults is a deprecated turn-dispatch surface
 *  and the ladder is retired on these turns (§6). No configured worker name →
 *  the incoming default (fail-open never stands on less than today). */
function deprecatePinsFloor(args: ApplyRoutingPolicyArgs, currentDefault: string): string {
  return args.config?.workers?.find((w) => Boolean(w.name))?.name ?? currentDefault;
}

/**
 * Adds the router step between 'resolve classification' and 'return decision'.
 * Shadow: block present (enabled false) -> routeTurn runs, the ladder decides,
 * and a shadow line records the would-have-chosen worker. Enabled: block
 * present AND model_router.enabled === true AND no pin AND not a command turn
 * -> the router decides. Pins (preferredWorker, topic_defaults, baseline
 * mutation) all outrank — the router fills unpinned turns only and runs
 * shadow-only on pinned turns. NEVER throws; every failure mode returns
 * the LADDER worker with a warn (decision 12 — fail open to today's
 * behaviour, and the ladder result IS today's behaviour, enabled or not).
 *
 * Phase 2 (2026-09-19, decision 25/§5-§6): under an effective deprecate-pins
 * gate the pinned turns collapse to COMMAND turns only, the ladder stops
 * running (exactly ONE TypeSafe ask per turn), and the fail-open floor is the
 * first configured worker (I-4) — never a ladder re-run.
 */
export async function resolveTurnRouting(args: ApplyRoutingPolicyArgs, currentDefault: string): Promise<TurnRoutingResult> {
  const policy = args.config?.routing_policy;
  if (!policy || policy.enabled !== true) return { worker: currentDefault };
  const block = args.config?.model_router;
  const commandTurn = isCommandTurn(args.userText);
  // Under the flag the /agent pin, topic_defaults and same-turn mutations are
  // all deprecated dispatch surfaces — a non-command turn routes regardless.
  const pinnedTurn = pinsDeprecatedTurn(args, block, currentDefault, commandTurn);
  if (pinnedTurn) {
    // Router runs shadow-only (if the block exists); the pinned/default path stands.
    if (block) {
      try {
        await (args.routeTurnFn ?? routeTurnDefault)(buildRouteTurnInput(args, block, currentDefault, true));
      } catch {
        // never throws; shadow is best-effort
      }
    }
    return { worker: currentDefault };
  }
  // The ladder runs in every remaining case UNTIL pins are deprecated (§6):
  // it is the shadow baseline when the flag is off, the fail-open floor, and
  // the disagreement signal. Under the flag the turn makes exactly ONE ask.
  const baselineWorker = deprecatePinsEffective(block)
    ? deprecatePinsFloor(args, currentDefault)
    : await resolveLadderWorker(args, currentDefault);
  if (!block) return { worker: baselineWorker };
  let routed: RouteTurnResult;
  try {
    routed = await (args.routeTurnFn ?? routeTurnDefault)(buildRouteTurnInput(args, block, baselineWorker, false));
  } catch (err) {
    logger.warn('model-router', `router step failed; keeping ${baselineWorker}: ${(err as Error).message}`, {
      topicKey: args.topicKey,
    });
    return { worker: baselineWorker };
  }
  if (routed.outcome !== 'routed' || !routed.chosen) {
    logger.warn('model-router', `router fail-open (${routed.outcome}/${routed.reason}); keeping ${baselineWorker}`, {
      topicKey: args.topicKey,
    });
    return { worker: baselineWorker };
  }
  if (block.enabled !== true) return { worker: baselineWorker }; // shadow-only: routeTurn recorded the line
  return {
    worker: routed.chosen.worker,
    model: routed.chosen.model,
    effort: routed.chosen.effort,
    projectionOutcome: routed.chosen.outcome,
    ...(routed.tier !== undefined ? { tier: routed.tier } : {}),
    ...(routed.score !== undefined ? { score: routed.score } : {}),
    ...(routed.chain ? { chain: routed.chain.map((c) => c.worker) } : {}),
    ...(routed.placement ? { placement: routed.placement } : {}),
    ...(routed.steerWait ? { steerWait: routed.steerWait } : {}),
  };
}

/** pinnedTurn under/over the deprecate-pins gate (§5): with the gate effective
 *  ONLY a command turn is pinned (shadow-only router, verbatim today's
 *  semantics); without it today's three-leg pinned definition stands. */
function pinsDeprecatedTurn(
  args: ApplyRoutingPolicyArgs,
  block: ModelRouterConfig | undefined,
  currentDefault: string,
  commandTurn: boolean,
): boolean {
  if (deprecatePinsEffective(block)) return commandTurn;
  return Boolean(args.preferredWorker) || currentDefault !== args.baselineDefault || commandTurn;
}

/** Derives the router's RouteTurnInput from the turn's already-classified
 *  text. Store is voice-inbox when the turn names ledger tasks (the context
 *  reader keys on conversation_id there); telegram otherwise. threadId is the
 *  topicKey's thread segment; for voice-inbox the conversationKey is the
 *  ledger's conversation_id resolved from the named task ids (read-only —
 *  a lookup miss falls back to the topicKey, which simply reads no rows).
 *  candidates/currentInflight are INJECTED as args — main.ts computes them
 *  (WP-5's window) and this pass-through never re-filters them. */
function buildRouteTurnInput(args: ApplyRoutingPolicyArgs, block: ModelRouterConfig, baselineWorker: string, pinPresent: boolean): RouteTurnInput {
  const classified = resolveClassificationText(args.userText, args.readVoiceTaskRequests);
  const topicKey = args.topicKey;
  const underscore = topicKey.indexOf('_');
  const threadId = underscore >= 0 ? topicKey.slice(underscore + 1) : topicKey;
  const isVoice = classified.taskIds.length > 0;
  // The voice-inbox store keys on the ledger's conversation_id — a
  // 'chatId_threadId' topicKey can never match a tasks row. Fail-open:
  // any lookup failure keeps the topicKey and the digest is just empty.
  const conversationKey = isVoice ? (voiceConversationKeyForTasks(classified.taskIds) ?? topicKey) : topicKey;
  return {
    topicKey,
    store: isVoice ? 'voice-inbox' : 'telegram',
    threadId,
    conversationKey,
    text: classified.text,
    textSource: classified.source,
    topic: { name: args.topicName, description: args.topicDescription },
    baselineWorker,
    pinPresent,
    config: block,
    costTier: args.config.cost_tier,
    workerNames: (args.config.workers ?? []).map((w) => w.name),
    now: args.now ?? new Date(),
    ask: args.routerAsk,
    availability: args.routerAvailability,
    readContext: args.routerReadContext,
    ...(args.candidates !== undefined ? { candidates: args.candidates } : {}),
    ...(args.currentInflight !== undefined ? { currentInflight: args.currentInflight } : {}),
  };
}

/**
 * The pre-router ladder (2026-09-16 behaviour, byte-for-byte): returns the
 * effective default worker for this turn from routing_policy alone. Logs one
 * info line per resolved turn — the class, the outcome, and which text source
 * was classified (textSource/taskIds/textChars, never the text) — so a wrong
 * call is diagnosable in the bot log alongside the AI-030 switch-back records.
 */
async function resolveLadderWorker(args: ApplyRoutingPolicyArgs, currentDefault: string): Promise<string> {
  const policy = args.config?.routing_policy;
  if (!policy || policy.enabled !== true) return currentDefault;
  if (args.preferredWorker) return currentDefault;                 // explicit pin wins
  if (currentDefault !== args.baselineDefault) return currentDefault; // router chose explicitly this turn
  if (isCommandTurn(args.userText)) {
    logger.info('routing-policy', `command turn; judge skipped, keeping ${currentDefault}`, {
      topicKey: args.topicKey,
      textSource: 'skipped: command',
    });
    return currentDefault;
  }
  try {
    const classified = resolveClassificationText(args.userText, args.readVoiceTaskRequests);
    if (classified.fallbackReason) {
      logger.warn('routing-policy', `voice task request unavailable; classifying the turn text: ${classified.fallbackReason}`, {
        topicKey: args.topicKey,
        taskIds: classified.taskIds,
      });
    }
    const decision = await resolveRoutingWorker(policy, {
      topicKey: args.topicKey,
      text: classified.text,
      workerNames: (args.config.workers ?? []).map((w) => w.name),
      topicDefault: args.configuredDefault,
      costTier: args.config.cost_tier,
      now: args.now,
      judgeRunner: args.judgeRunner,
    });
    const logContext = {
      topicKey: args.topicKey,
      peak: decision.peak,
      textSource: classified.source,
      taskIds: classified.taskIds,
      textChars: classified.text.length,
    };
    if (decision.worker && decision.worker !== currentDefault) {
      logger.info('routing-policy', `turn classified ${decision.requestClass}; routing to ${decision.worker} (${decision.reason})`, logContext);
    } else {
      logger.info('routing-policy', `turn classified ${decision.requestClass}; keeping ${currentDefault} (${decision.reason})`, logContext);
    }
    return decision.worker ?? currentDefault;
  } catch (err) {
    logger.warn('routing-policy', `policy resolution failed; keeping ${currentDefault}: ${(err as Error).message}`, { topicKey: args.topicKey });
    return currentDefault;
  }
}

/**
 * Returns the effective default worker for this turn — the ONE call site
 * main.ts keeps. Delegates to resolveTurnRouting and unwraps the worker;
 * signature and return type are unchanged, so callers and the existing
 * precedence tests see exactly the pre-router behaviour when no model_router
 * block is configured.
 */
export async function applyRoutingPolicy(args: ApplyRoutingPolicyArgs, currentDefault: string): Promise<string> {
  return (await resolveTurnRouting(args, currentDefault)).worker;
}
