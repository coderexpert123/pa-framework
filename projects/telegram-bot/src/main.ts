import { spawn, execFile } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { readdir, unlink, rename, writeFile, readFile, stat, mkdir } from 'fs/promises';
import { join } from 'path';
import { acquireLock, releaseLock } from './lock.js';
import { getUpdates, sendMessage, sendMessageWithId, pinChatMessage, unpinChatMessage, sendTyping, setMessageReaction, editMessageText, createForumTopic, sendMessageWithKeyboard } from './telegram.js';
import type { InlineKeyboardMarkup } from './telegram.js';
import {
  handleCallbackQuery,
  handleMessageReaction,
  buildConfirmKeyboard,
  buildFailoverKeyboard,
  buildControlCardKeyboard,
  buildQuestionKeyboard,
  buildSuggestKeyboard,
  rememberConfirmMessage,
  currentCardKeyboard,
  clearCardKeyboard,
  nextSyntheticUpdateId,
  type CallbackDeps,
} from './callbacks.js';
import { sendReplyText } from './rich-message.js';
import { loadState, saveState, loadTopicState, saveTopicState, addTurn, findRecentTurnsByTopic, listTopicStateRefs, type JoinableTurn } from './conversation.js';
import {
  expirePendingAction,
  expirePendingQuestion,
  resolveConfirmation,
  resolveQuestionAnswer,
  consumeConfirmation,
  resolvePendingDescription,
  getModelSwitchTarget,
  expirePreferredWorker,
  isPassThroughCommand,
  handleBranchCommand,
  handleChildOfCommand,
  handleMergeCommand,
  BRANCH_PATTERN,
  CHILD_OF_PATTERN,
  MERGE_PATTERN,
  applyMetaActions,
  renderStatusCard,
  resolveEffectiveDefaultWorker,
  hydrateModelStatus,
  modelStatusNeedsRefresh,
  setSessionTunable,
  setTopicTunable,
  expireTunableOverrides,
  renderTunableReport,
  renderTunableSetResult,
  renderTunableClearResult,
  renderSessionExpiryMessage,
  describeForwardOrigin,
  handleHealthCommand,
  handleClaimsCommand,
  parseReauthCallback,
  handleOrchestratorCommand,
  normalizeMarkdown,
  type TunableCommand,
  type UpdateBrainResult,
} from './logic.js';
// AI-201 voice-inbox bridge: /pair mint + route-queue drain (services seam below).
import { drainVoiceInboxRoutes, extractVoiceInboxTaskIds } from './voice-inbox-bridge.js';
// Model routing policy (2026-09-11): code/general turn classification + ZAI
// peak-window worker override over the topic default.
// Model router seam (WP-G, 2026-09-18): resolveTurnRouting returns the FULL
// per-turn result (worker/model/effort) — main.ts consumes all of it below.
// WP-5 (router-as-orchestrator 2026-09-19): window B — the placement engine.
// The pure decision module (applyRouterPlacement / resolveDestinationWorker /
// canPlaceUpdate) is unit-tested in router-placement.test.ts; main.ts supplies
// the I/O around it (candidate reads, injection, announces).
import { resolveTurnRouting, deprecatePinsEffective, isCommandTurn, type TurnRoutingResult } from './routing.js';
import { applyRouterPlacement, resolveDestinationWorker, canPlaceUpdate, type PlacementCarry, type RouterPlacementCandidate } from './router-placement.js';
import { personaBranchSkipped, ORCHESTRATOR_ROUTER_NOTICE } from './orchestrator.js';
import { voiceInboxPlacementCandidates, voiceInboxTaskStates, VOICE_INBOX_PLACEMENT_INFLIGHT_STATES } from '../../../pa/dist/src/lib/voice-inbox-ledger.js';
import { readTurnContext, voiceConversationKeyForTasks } from '../../../pa/dist/src/lib/model-router/context-reader.js';
import { projectEffort } from '../../../pa/dist/src/lib/model-router/effort-projection.js';
import { appendShadowRecord } from '../../../pa/dist/src/lib/model-router/shadow.js';
import { getCachedAvailability } from '../../../pa/dist/src/lib/model-router/availability.js';
import type { ModelRouterConfig } from '../../../pa/dist/src/types.js';
import { mirrorAskAsWidget, cancelMirroredAsk, capPromptForWidget } from './voice-input-mirror.js';
import { captureTaskMessageIds } from './voice-message-id-capture.js';
import { steerIntoWork, steerConversationTaskIds, isPastSteerDeadline, STEER_PREFIX_FOLD } from './voice-inbox-steer.js';
import { runRulesCritic } from './rules-critic.js';
import {
  resolveTunable,
  resolveWorkerLlm,
  resolveWorkerEffort,
  formatWorkerDescriptor,
  selectWorkerTunables,
  validateTunable,
  isKnownValue,
  extractTunableValues,
  declaredValues,
  getTunableSpec,
} from '../../../pa/dist/src/lib/tunables.js';
import { readObservedTunableValues } from '../../../pa/dist/src/lib/tunables-observed.js';
import {
  isRateLimited,
  getWorkerCooldown,
  checkWorker,
} from '../../../pa/dist/src/workers.js';
import { openWindow, closeWindow, type DispatchWindow } from '../../../pa/dist/src/lib/worker-edit-audit.js';
import { computeBackoff, computePollOffset, LONG_POLL_TIMEOUT } from './poll.js';
import { WatermarkTracker } from './watermark.js';
import { appendDlq, flushDlq } from './dlq.js';
import { deliveredKey, wasDelivered, markDelivered } from './delivered-store.js';
import { addPendingDispatch, removePendingDispatch, updatePendingDispatch, pendingDispatchKey, listPendingDispatches, absorbHeldDispatchRecords, type PendingDispatch } from './pending-dispatches.js';
import { reapOrphanedDispatches, reapOrphanedThreads } from './orphan-reaper.js';
import { isTopicRecovering, waitForTopicRecovery } from './recovery-gate.js';
import { isDegraded, startHealthProbe } from './health.js';
import { parseStopSteer, stopTopicWorkers, stopThreadWorker, markTopicStopped, isTopicStopped, consumeTopicStopped } from './worker-stop.js';
// WP-4 (router-as-orchestrator 2026-09-19): the /steer mechanics live in
// steer-exec.ts — the /steer handler AND the router-steer surface (§4.2,
// steer: 'live') call the SAME executeSteer; §4.3's per-turn double-fire
// guard map lives there too.
import { executeSteer, materializeSteerPrompt, markRouterSteered, takeRouterSteered, STEER_ALREADY_ROUTED_FOOTER } from './steer-exec.js';
import { dequeueUpdate, drainQueuedEntries, addHeldEntry, absorbHeldEntries, type QueueEntry, type SteerFoldContext, type AudioMediaIdentity } from './topic-queue.js';
import { updateDashboard } from './dashboard.js';
import type { ConversationState, SessionInfo, PAMeta, ModelStatusSnapshot, ModelStatusReasonCode, TelegramUpdate } from './types.js';
import { loadTopicNames, updateTopicName, setTopicDescription, extractTopicEvent, loadBranches, addBranch, removeBranch, findBranchParent, getTopicName, type TopicNameMap, type BranchIndex } from './topic-names.js';
import { appendKbNote } from './kb-notes.js';
import { addWatchJob } from '../../../pa/dist/src/lib/watch-jobs.js';
import { formatFailoverMessage, escapeMd } from './notify-format.js';
import { registerBotCommands } from './commands.js';
import { resolveTopicWorkdir, ensureTopicWorkdir, topicHomeDir, type TopicWorkdir } from './topic-workdir.js';
import {
  validateTopicResumeAction,
  validateVoiceInboxResumeAction,
  type OAuthResumeAction,
} from './oauth.js';
import { promisify } from 'node:util';
import {
  extractAudioAttachment,
  type AudioAttachmentKind,
  type VoiceResult,
} from './voice.js';
import {
  startPrefetch,
  lookupPrefetch,
  userTextFromVoiceResult,
  clearPrefetch,
  type VoicePrefetchDescriptor,
} from './voice-prefetch.js';
import { resolveReplyContext } from './reply-context.js';
import { runAttachmentStage } from './attachment-stage.js';
import { compileBatchFold } from './batch-uptake.js';
import { runCommandRouter } from './command-router.js';
// AI-203 orchestrator threads (first increment): main.ts is the composition
// root — it wires the interception, the dispatch branch and the spawn/steer
// handlers, while every capability lives in its own module (same convention
// as the task lane).
import {
  isOrchestratorMode,
  dispatchOrchestratorTurn,
  handleSpawn,
  handleSteer,
  resolveThreadFyiAnchor,
  handleAnchorSteerReply,
  ORCHESTRATOR_PATTERN,
} from './orchestrator.js';
import { reconcileThreadQueues, wakeWallParkedOnCooldownExpiry, signalThreadInterrupt, fireClaimedThreads } from './thread-executor.js';
import { cancelRunningThreads, listThreads, countThreads, getThread } from './topic-threads.js';
// Session-capture consolidation (WP-4/WP-5): the definitions of the exclusion
// set, the resource parser, the post-dispatch capture block and the
// empty-response helper moved verbatim into session-capture.ts — the dispatch
// cascade (dispatch.ts) imports the ONE implementation (no silent-site drift)
// and this file re-exports the two small helpers (findNextAvailableWorker is
// imported only — import session-capture.js directly for it) so existing
// importers of main.js keep their surface.
import {
  AGY_NATIVE_RESUME_EXCLUDED_TOPICS,
  threadIdFromResource,
  findNextAvailableWorker,
} from './session-capture.js';
export { AGY_NATIVE_RESUME_EXCLUDED_TOPICS, threadIdFromResource };

// Dispatch/failover cascade (AI-173 phase 3): dispatchMessage, tryClassifyAndNotify,
// buildDispatchExtraArgs and the pin-update helper live in dispatch.ts now. The first
// three are re-exported because existing importers of main.js (four witness files)
// keep their surface — same convention as the session-capture re-export below.
export { dispatchMessage, tryClassifyAndNotify, buildDispatchExtraArgs } from './dispatch.js';
export type { ClassifyOutcome } from './dispatch.js';
import { dispatchMessage, maybeUpdatePinnedStatusAfterDispatch, syncModelStatusState } from './dispatch.js';
// Router-metadata wave (2026-09-20, decision 31): the dispatch site builds the
// turn-level PA_ROUTING_* env with the vocabulary's ONE pure producer.
import { buildRoutingProvenanceEnv, type TurnRoutingMeta } from './dispatch.js';

/**
 * WP-G per-turn tunable injection (2026-09-18, plans/2026-09-18-model-router-SPEC.md §8.1).
 *
 * When the router supplied a model/effort for THIS turn, the dispatch sees them
 * through a SHALLOW PER-TURN state view — the same slices
 * resolveWorkerLlm/resolveWorkerEffort read (session tier of tunable_overrides
 * for the routed worker) — while the caller's real topicState reference stays
 * untouched, so saveTopicState can never persist a router-sourced value (the
 * pins stay the outranking surface). Returns the original reference when the
 * router carried no tunables: zero behavior change on the shadow/baseline path.
 */
export function buildRouterTurnDispatchState(
  topicState: ConversationState,
  worker: string | undefined,
  routerTurn: TurnRoutingResult | undefined,
  bypassSessionTunables = false,
): ConversationState {
  // WP-5 (§5, decision 25): on a routed turn under an effective deprecate-pins
  // gate the session /model,/effort slice is NOT applied — the router (or the
  // worker's own defaults when it carried no tunables) wins. The caller's real
  // topicState reference stays untouched either way (the view is per-turn).
  if (bypassSessionTunables && worker) {
    const base: NonNullable<ConversationState['tunable_overrides']> = Object.fromEntries(
      Object.entries(topicState.tunable_overrides ?? {}).filter(([k]) => k !== worker),
    );
    if (!routerTurn || (!routerTurn.model && !routerTurn.effort)) {
      return { ...topicState, tunable_overrides: base };
    }
    const merged: NonNullable<ConversationState['tunable_overrides']> = { ...base };
    merged[worker] = {
      ...(merged[worker] ?? {}),
      ...(routerTurn.model !== undefined ? { model: routerTurn.model } : {}),
      ...(routerTurn.effort !== undefined ? { effort: routerTurn.effort } : {}),
    };
    return { ...topicState, tunable_overrides: merged };
  }
  if (!routerTurn || (!routerTurn.model && !routerTurn.effort)) return topicState;
  const w = worker ?? routerTurn.worker;
  const merged: NonNullable<ConversationState['tunable_overrides']> = { ...topicState.tunable_overrides };
  merged[w] = {
    ...(merged[w] ?? {}),
    ...(routerTurn.model !== undefined ? { model: routerTurn.model } : {}),
    ...(routerTurn.effort !== undefined ? { effort: routerTurn.effort } : {}),
  };
  return { ...topicState, tunable_overrides: merged };
}

/**
 * WP-5 (§3.2/§3.3, I-3): routing reuse at the placement DESTINATION. A
 * `__synthetic: 'placement'` turn never re-asks TypeSafe — the carried
 * needs/chain resolve deterministically against the DESTINATION incumbent
 * (sticky: incumbent-first when it satisfies the carried need and is
 * available; the carried chain is the fallback order), then effort projects.
 * Fail-open: nothing available → the first configured worker (the same I-4
 * floor the deprecate-pins gate uses). One shadow line records the resolve
 * for the destination topicKey (§3.3). Carried needs are OPTIONAL
 * (TurnRoutingResult.tier/score pass through when the origin ask classified —
 * fail-open turns carry none): absent needs skip the capability-UP filter and
 * the shadow reason carries '+no-carried-needs' so the flip review can count
 * them.
 */
async function resolveDestinationPlacementRouting(
  carry: PlacementCarry,
  config: any,
  topicKey: string,
  threadId: string,
  fallbackWorker: string,
): Promise<TurnRoutingResult> {
  const block: ModelRouterConfig | undefined = config?.model_router;
  const workerNames = (config?.workers ?? []).map((w: { name: string }) => w.name);
  const shadowPath = block?.shadow_path ?? join(paHome(), 'model-router-shadow.jsonl');
  const floor = workerNames[0] ?? fallbackWorker;
  const failOpen = (reason: string): TurnRoutingResult => {
    try {
      appendShadowRecord(shadowPath, {
        at: new Date().toISOString(), topicKey, store: 'telegram', textSource: 'turn-text',
        chosen: undefined, baseline: { worker: floor }, pinPresent: false,
        disagreement: false, sticky: false, reason,
      });
    } catch { /* best-effort, never blocks */ }
    return { worker: floor };
  };
  if (!block?.table || block.table.length === 0) return failOpen('no-table');
  let incumbent: string | undefined;
  try {
    incumbent = readTurnContext('telegram', threadId, { context_max_chars: block.context_max_chars ?? 2000 })?.incumbentWorker;
  } catch {
    incumbent = undefined;
  }
  const available = new Set<string>();
  for (const w of [incumbent, ...(carry.chain ?? [])]) {
    if (!w || available.has(w)) continue;
    if (await getCachedAvailability(w, workerNames).catch(() => false)) available.add(w);
  }
  const row = resolveDestinationWorker(carry, { table: block.table, incumbent, available });
  if (!row) return failOpen('nothing-available');
  const hasNeeds = carry.tier !== undefined && carry.score !== undefined;
  const proj = projectEffort(carry.score ?? 3, row.worker, block.effort_projection);
  const sticky = incumbent !== undefined && row.worker === incumbent;
  try {
    appendShadowRecord(shadowPath, {
      at: new Date().toISOString(), topicKey, store: 'telegram', textSource: 'turn-text',
      tier: carry.tier, score: carry.score,
      chosen: {
        worker: row.worker, model: row.model,
        effort: proj.applied ? proj.value : undefined,
        outcome: proj.applied ? 'applied' : proj.outcome,
      },
      baseline: { worker: floor }, pinPresent: false,
      disagreement: row.worker !== floor,
      sticky,
      ...((!sticky && incumbent !== undefined)
        ? { stickBreakReason: (hasNeeds ? 'unsatisfiable' : 'unavailable') as 'unsatisfiable' | 'unavailable' }
        : {}),
      reason: sticky ? 'sticky-keep' : `table-rank${hasNeeds ? '' : '+no-carried-needs'}`,
    });
  } catch { /* best-effort, never blocks */ }
  const chain = [incumbent, ...(carry.chain ?? [])]
    .filter((w): w is string => w !== undefined && available.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i);
  return {
    worker: row.worker,
    ...(row.model !== undefined ? { model: row.model } : {}),
    ...(proj.applied ? { effort: proj.value } : {}),
    projectionOutcome: proj.applied ? 'applied' : proj.outcome,
    chain,
  };
}

// Poll-loop enqueue normalizer (AI-173 phase 4): the enqueue block (the AI-095
// placeholder write, the A5 __skipVoice producer, queue registration, the arrival
// prefetch) and the turn-start normalize steps before processUpdate (voice-result
// settle, stop flush-check, held absorb) live in enqueue-normalizer.ts now.
// placeholderDispatchText is re-exported because an existing importer of main.js
// keeps its surface — same convention as the dispatch re-exports above.
export { placeholderDispatchText } from './enqueue-normalizer.js';
import { enqueueUpdateForDispatch, settleVoicePrefetch, flushCheckAndAbsorbHeld, isAcceptableUpdate } from './enqueue-normalizer.js';

// Import pa modules
import { loadSecrets } from '../../../pa/dist/src/secrets.js';
import { redactSecrets } from '../../../pa/dist/src/lib/redact.js';
import { startProxyAutoRefresh } from '../../../pa/dist/src/lib/telegram-proxy.js';
import { cleanupOrphanedWorkers, listWorkerPids } from '../../../pa/dist/src/worker-pids.js';
import { blackboard, startLockRenewal } from '../../../pa/dist/src/blackboard.js';
import { createVoiceInboxTranscribeDrain, voiceInboxRouteHoldStates } from '../../../pa/dist/src/lib/voice-inbox-transcribe-drain.js';
import { createVoiceInboxTypedRouteDrain } from '../../../pa/dist/src/lib/voice-inbox-typed-route-drain.js';
import { loadConfig } from '../../../pa/dist/src/config.js';
import { browserSessionEnvOverlay } from '../../../pa/dist/src/lib/browser-launcher.js';
import type { CommandResult, FailoverNotifyPayload, WorkerConfig } from '../../../pa/dist/src/types.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { formatBootIdentity } from './boot-identity.js';
import { formatIST } from '../../../pa/dist/src/ist.js';
import { appendTopicEvent } from '../../../pa/dist/src/lib/topic-events.js';
import {
  claimNextTask,
  demoteStaleRunningTasks,
  failTask,
  listRunningTasks,
  listTasks,
  recordFyiMessage,
  validateTaskPrompt,
  type RunningTask,
} from '../../../pa/dist/src/lib/topic-tasks.js';
// Wave-2 executor lane (SPEC §3.1 A.3): the drain fires these fire-and-forget and
// owns the tier-1 reply hook + card refresh wiring (task-executor.ts never imports
// main.ts — main.ts is the composition root).
import {
  TOPIC_TASK_TICK_CAP,
  executeTopicTask,
  routeReplyToTask,
  activeTaskExecutions,
  type ExecuteTopicTaskArgs,
  type TaskFyiSender,
} from './task-executor.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolvePythonCommand } from '../../../pa/dist/src/lib/python.js';
import { paHome } from '../../../pa/dist/src/paths.js';
import { writeFileAtomic } from '../../../pa/dist/src/lib/atomic-write.js';
import { runDueJobs } from '../../../pa/dist/src/lib/maintenance/runner.js';
import { updateJobState } from '../../../pa/dist/src/lib/maintenance/state.js';
import { createBotMaintenanceJobs, watchdogStaleJobs } from './maintenance-jobs.js';

/** Topic keys created by /branch — signals forum_topic_created to skip description */
const branchCreatedTopicKeys = new Set<string>();

import {
  makeRefId,
  appendRefId,
  appendRefIdAndLog,
  RefKind
} from './ref-id.js';

// Default bot working directory. Env-driven so the framework is portable.
// Set BOT_CWD in secrets.env to the absolute path of your project root.
const BOT_CWD = process.env.BOT_CWD || process.cwd();

// Skip topics idle beyond this in the sweep — avoids O(all-topics-ever) lock+
// read+hydrate work for topics nobody's using. Safe: nothing else discovers
// topics via directory scan (/branch, /child-of, /merge, ref-lookup all
// address topic-state files by explicit chatId/threadId), and
// expirePreferredWorker also runs inline on every per-message reply
// independent of the sweep, so an idle topic's override self-heals the
// moment it gets a real message. Skipping only delays a cosmetic pinned
// status-card refresh on a topic nobody is looking at. See
// plans/2026-07-08-autonomous-scale-longevity-hardening-phase2.md.
const TOPIC_SWEEP_STALE_MS = 7 * 24 * 60 * 60 * 1000;
// Cap on how long graceful shutdown waits for an in-flight bot maintenance
// pass. Bounded because queue-drain's dlq source can stall for minutes during
// a Telegram outage. Uses a real timer, NOT the injected sleepFn — tests inject a
// fast-forwarding sleep that would win the race instantly and reintroduce the
// exact ordering flake the drain exists to prevent.
const MAINTENANCE_DRAIN_MS = 10_000;

function topicKeyFor(chatId: number, threadId: number): string {
  return `${chatId}_${threadId}`;
}

function getConfiguredDefaultWorker(config: any, topicKey: string): string | undefined {
  return config?.topic_defaults?.[topicKey];
}

function getEffectiveDefaultWorker(config: any, topicKey: string): string {
  return resolveEffectiveDefaultWorker(getConfiguredDefaultWorker(config, topicKey), config?.workers ?? []);
}

/** Wave-2 status-card Tasks line source (SPEC §3.1): fail-to-zero counts. `ready`
 *  records (answered, awaiting the next claim) count under `running` — they are
 *  active work about to dispatch, and the frozen line has no fourth bucket. */
async function topicTaskCounts(
  chatId: number,
  threadId: number
): Promise<{ running: number; parked: number; queued: number }> {
  try {
    const [running, queued] = await Promise.all([listRunningTasks(chatId, threadId), listTasks(chatId, threadId)]);
    return {
      running: running.filter((r) => r.status !== 'parked').length,
      parked: running.filter((r) => r.status === 'parked').length,
      queued: queued.filter((t) => t.kind === 'task').length,
    };
  } catch {
    return { running: 0, parked: 0, queued: 0 };
  }
}

/** AI-203 increment 3: resolve an FYI anchor to a live thread and build the
 *  dispatch-result ack for it. Undefined when the thread does not exist — the
 *  update then dispatches normally. The ack carries the exact field set the
 *  downstream block reads off `dr` (dispatchedWorker INCLUDED, as undefined:
 *  the union member must declare it or dr.dispatchedWorker at the card-refresh
 *  and teePath reads is a TS2339). No worker ran: session passes through
 *  untouched, and the card/teePath/failover paths all skip on the undefined
 *  dispatchedWorker. */
async function steerFromThreadAnchor(
  topicKey: string,
  anchorThreadId: string,
  message: string,
  topicState: ConversationState,
  ctx: { topicName: string; secrets: Record<string, string>; token: string; workdir: string }
): Promise<{
  response: string;
  meta: null;
  session: ConversationState['session'];
  workerError: false;
  suggestedWorker: null;
  dispatchedWorker: undefined;
  // t-32: declared (as undefined) for the same reason dispatchedWorker is — the
  // reply-send cascade's fresh-dispatch park decision reads dr.rateLimitedWorker,
  // so every dr union member must carry the field or that read is a TS2339.
  rateLimitedWorker: undefined;
} | undefined> {
  const rec = await getThread(topicKey, anchorThreadId).catch(() => undefined);
  if (!rec) return undefined;
  return {
    response: await handleAnchorSteerReply({
      topicKey, topicName: ctx.topicName, thread: rec, message,
      secrets: ctx.secrets, token: ctx.token, workdir: ctx.workdir,
    }),
    meta: null,
    session: topicState.session,
    workerError: false,
    suggestedWorker: null,
    dispatchedWorker: undefined,
    rateLimitedWorker: undefined,
  };
}

async function replacePinnedStatusCard(
  token: string,
  chatId: number,
  threadId: number,
  state: ConversationState,
  snapshot: ModelStatusSnapshot
): Promise<{ delivered: boolean; pinned: boolean; messageId: number | null }> {
  const pinText = renderStatusCard({
    snapshot,
    tasks: await topicTaskCounts(chatId, threadId),
    threads: await countThreads(`${chatId}_${threadId}`),
  });
  const oldPinId = state.pinned_status_message_id;
  const pinMsgId = await sendMessageWithId(token, chatId, appendRefIdAndLog(pinText, { kind: 'pin', chatId, threadId }), threadId || undefined, buildControlCardKeyboard());

  syncModelStatusState(state, snapshot);

  if (!pinMsgId) {
    return { delivered: false, pinned: false, messageId: null };
  }

  const pinned = await pinChatMessage(token, chatId, pinMsgId);
  if (pinned) {
    state.pinned_status_message_id = pinMsgId;
    if (oldPinId && oldPinId !== pinMsgId) {
      // The superseded card can never be pressed again, so its recorded submenu is dead
      // weight in cardKeyboardIndex — drop it alongside the unpin.
      clearCardKeyboard(chatId, oldPinId);
      await unpinChatMessage(token, chatId, oldPinId);
    }
  }

  return { delivered: true, pinned, messageId: pinMsgId };
}

async function refreshPinnedStatusCardInPlace(
  token: string,
  chatId: number,
  threadId: number,
  state: ConversationState,
  effectiveDefault: string,
  config?: { workers?: WorkerConfig[] }
): Promise<void> {
  const snapshot = hydrateModelStatus(state, effectiveDefault, config);
  // AI-212 (pinned-card refresh latency): the status sync is PURELY LOCAL.
  // syncModelStatusState (dispatch.ts) only writes state.model_status and
  // state.pinned_worker — no network round-trip. hydrateModelStatus (logic.ts)
  // is likewise synchronous. topicTaskCounts / countThreads read local JSON
  // stores (topic-tasks / topic-threads), NOT the Telegram Bot API, so they are
  // not perceived round-trips either. The ONLY awaited network call in this
  // refresh path is editMessageText below; the pin re-assert is already
  // fire-and-forget (void, main.ts:387). The collapse to one perceived
  // round-trip is therefore already complete — the timing line below measures
  // that single remaining RTT so route-RTT variance is observable ("measure
  // first" mandate). No further batching is possible: there is no second
  // awaited network call to parallelize it with.
  syncModelStatusState(state, snapshot);

  // AI-212: batch the two independent local reads with Promise.all — they are
  // file/JSON lookups (not network), but collapsing their wall-clock keeps the
  // pre-edit section to a single await hop regardless of store latency.
  const [tasks, threads] = await Promise.all([
    topicTaskCounts(chatId, threadId),
    countThreads(`${chatId}_${threadId}`),
  ]);
  const pinText = renderStatusCard({ snapshot, tasks, threads });
  if (state.pinned_status_message_id) {
    // bp-retry (2026-08-25): this sweep used to unconditionally rewrite the card's
    // keyboard back to the top-level menu, silently stranding a user mid-navigation
    // through a cc:agent/cc:model/cc:effort submenu on the same message id. If a
    // submenu is currently displayed (recorded by callbacks.ts, fresh within its
    // 2-minute window) keep showing it — only the card TEXT changes here either way.
    const keyboard = currentCardKeyboard(chatId, state.pinned_status_message_id) ?? buildControlCardKeyboard();
    // AI-212: time the sole remaining awaited network round-trip (editMessageText).
    const editStart = Date.now();
    const pinOk = await editMessageText(token, chatId, state.pinned_status_message_id, appendRefIdAndLog(pinText, { kind: 'pin', chatId, threadId }), keyboard).catch(() => false);
    logger.info('pinned-card-refresh', `pinned-card-refresh-latency: ${Date.now() - editStart}ms`, { chatId, threadId, messageId: state.pinned_status_message_id, ok: pinOk });
    if (pinOk) {
      // Topic pins are write-only in the Bot API — editing a message never re-pins
      // it, so a card whose pin was lost (manual unpin) stayed unpinned forever.
      // Re-assert the SAME message id after every successful in-place edit;
      // idempotent and fire-and-forget (telegram.ts logs pin failures itself).
      void pinChatMessage(token, chatId, state.pinned_status_message_id).catch(() => {});
      return;
    }
  }

  await replacePinnedStatusCard(token, chatId, threadId, state, snapshot);
}

export async function runExpiredModelOverrideSweep(
  token: string,
  chatIds: number[]
): Promise<number> {
  const topicRefs = await listTopicStateRefs();
  if (topicRefs.length === 0) return 0;

  let touched = 0;
  const allowedChatIds = new Set(chatIds);
  let config: any = { workers: [] };
  try { config = await loadConfig(); } catch {}
  const agentName = 'telegram-bot-sweep';

  for (const ref of topicRefs) {
    if (!allowedChatIds.has(ref.chatId)) continue;

    try {
      const st = await stat(ref.path);
      if (Date.now() - st.mtimeMs > TOPIC_SWEEP_STALE_MS) continue; // idle topic — skip the expensive lock+read+hydrate
    } catch {
      continue; // file vanished between listTopicStateRefs() and stat() — nothing to process
    }

    const resourceId = `topic-${ref.chatId}_${ref.threadId}`;
    const contextId = `sweep-${randomUUID()}`;
    const acquired = await blackboard.acquireLock(resourceId, agentName, process.pid, 60000, contextId);
    if (!acquired) continue;

    try {
      const topicState = await loadTopicState(ref.chatId, ref.threadId);
      const topicKey = topicKeyFor(ref.chatId, ref.threadId);
      const effectiveDefault = getEffectiveDefaultWorker(config, topicKey);

      // Compute before descriptor BEFORE expiring:
      const prevWorker = topicState.preferred_worker || effectiveDefault;
      const prevWorkerConfig = config?.workers?.find((w: WorkerConfig) => w.name === prevWorker);
      const prevLlm = prevWorkerConfig
        ? resolveWorkerLlm(prevWorkerConfig, selectWorkerTunables(topicState.tunable_overrides, prevWorker), selectWorkerTunables(topicState.tunable_defaults, prevWorker))
        : undefined;
      const prevEffort = prevWorkerConfig
        ? resolveWorkerEffort(prevWorkerConfig, selectWorkerTunables(topicState.tunable_overrides, prevWorker), selectWorkerTunables(topicState.tunable_defaults, prevWorker))
        : undefined;
      const prevDescriptor = formatWorkerDescriptor(prevWorker, prevLlm, prevEffort);

      const expired = expirePreferredWorker(topicState);
      // Same IST-day lifecycle, swept for the same reason: a topic nobody has
      // messaged since yesterday must not still be running yesterday's knobs
      // the moment it wakes up.
      const expiredTunables = expireTunableOverrides(topicState);

      if (expired || expiredTunables.length > 0) {
        const defaultWorkerConfig = config?.workers?.find((w: WorkerConfig) => w.name === effectiveDefault);
        const nextLlm = defaultWorkerConfig
          ? resolveWorkerLlm(defaultWorkerConfig, undefined, selectWorkerTunables(topicState.tunable_defaults, effectiveDefault))
          : undefined;
        const nextEffort = defaultWorkerConfig
          ? resolveWorkerEffort(defaultWorkerConfig, undefined, selectWorkerTunables(topicState.tunable_defaults, effectiveDefault))
          : undefined;
        const nextDescriptor = formatWorkerDescriptor(effectiveDefault, nextLlm, nextEffort);

        await refreshPinnedStatusCardInPlace(token, ref.chatId, ref.threadId, topicState, effectiveDefault, config);
        const expiryMsg = renderSessionExpiryMessage(prevDescriptor, nextDescriptor, 'expired');
        await sendMessage(token, ref.chatId, expiryMsg, ref.threadId || undefined);
        await saveTopicState(topicState);
        touched++;
        continue;
      }

      const hydrated = hydrateModelStatus(topicState, effectiveDefault, config);
      if (modelStatusNeedsRefresh(topicState.model_status, hydrated) || topicState.pinned_worker !== hydrated.current_worker) {
        await refreshPinnedStatusCardInPlace(token, ref.chatId, ref.threadId, topicState, effectiveDefault, config);
        await saveTopicState(topicState);
        touched++;
      }
    } catch (err) {
      // Per-topic faults (corrupt JSON, transient send failure) must not abort the
      // whole sweep — other topics still need processing, and a throw here would
      // bubble to the poll-loop catch and trigger spurious backoff.
      logger.warn('sweep', `topic ${ref.chatId}_${ref.threadId} failed: ${(err as Error).message}`);
    } finally {
      await blackboard.releaseLock(resourceId, agentName, contextId);
    }
  }

  return touched;
}

// Moved to reply-context.ts (WP5/WP6, hardened voice-transcription plan) —
// re-exported here so existing importers (poll-loop.test.ts) and the
// pending-dispatch death-notice path keep working unchanged.
export { extractReplyContext } from './reply-context.js';

const NOTIFY_DEBOUNCE_MS = 10_000;
const notifyDebounce = new Map<string, number>();

// Track consecutive spawn-failed failures per topic for pinned-worker hints.
// Key: `${chatId}_${threadId}`, value: consecutive failure count.
const topicSpawnFailureCount = new Map<string, number>();
// WP-D1 (SPEC §3.4-D1 A.2/A.3): per-update kb-cascade inputs, read by the reply-send
// block which sits OUTSIDE the try/catch block scopes that produce them. Module-level
// `let`s (beside topicSpawnFailureCount, the frozen shape) are safe because the poll
// loop processes updates sequentially; both are reset at the top of the dispatch
// attempt so a value can never leak into a later update's reply.
let suggestedAlt: string | null = null;
let drSuggestedWorker: string | null = null;

// ---------------------------------------------------------------------------
// AI-029: Topic description suggestion helpers
// ---------------------------------------------------------------------------

const DESCRIPTION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Generate a description suggestion for a topic based on its name.
 * Used for B3 (creation trigger — no history available yet).
 */
export function generateDescriptionSuggestion(name: string): string {
  if (/^[^0-9]{4,}/.test(name)) {
    return `Discussions about ${name.toLowerCase()}`;
  }
  return '';
}

const CONVERSATIONAL_PATTERNS = /What can I help|got cut off|How can I assist|I'd be happy|Let me know how/i;
const MAX_DESCRIPTION_LEN = 160;

/** Check whether LLM output looks like a valid description (not conversational filler). */
export function isValidDescriptionOutput(text: string): boolean {
  return !CONVERSATIONAL_PATTERNS.test(text) && text.length <= MAX_DESCRIPTION_LEN;
}

/**
 * Parse the raw stdout (and optional error) from the claude CLI into a
 * structured result.
 */
export function parseDescriptionLLMOutput(
  stdout: string,
  err?: Error | null
): { description: string; confident: boolean } {
  if (err || !stdout.trim()) return { description: '', confident: false };
  const result = stdout.trim().replace(/^["']|["']$/g, '');
  const normalised = result.trim().replace(/[.!?]+$/, '').toLowerCase();
  if (normalised === 'unknown') return { description: '', confident: false };
  if (CONVERSATIONAL_PATTERNS.test(result) || result.length > MAX_DESCRIPTION_LEN) {
    return { description: '', confident: false };
  }
  return { description: result.trim(), confident: true };
}

export const DESCRIPTION_SYSTEM_PROMPT =
  'Generate a concise Telegram forum topic description. Output exactly 1 sentence (60-150 chars), plain text only, no quotes. Describe what conversations belong here, not what the topic is about. Exception: if the topic name is too vague or ambiguous to infer a meaningful description (e.g. a single letter, a number, a person\'s name alone, or a generic word like \'misc\'), output exactly the single word UNKNOWN and nothing else. Otherwise output only the description text.';

export const BRANCH_DESCRIPTION_SYSTEM_PROMPT =
  'Generate a concise Telegram forum topic description for a branch topic. Output exactly 1 sentence (60-150 chars), plain text only, no quotes. Describe what conversations belong in this branch. Exception: if the context is too vague or ambiguous to infer a meaningful description, output exactly the single word UNKNOWN and nothing else. Otherwise output only the description text.';

export interface DescriptionOptions {
  name: string;
  sampleTurns?: string;
  isBranch?: boolean;
  parentName?: string;
  parentDescription?: string;
  userPrompt?: string;
}

export type DescriptionRunner = (
  cmd: string,
  args: string[],
  opts: { timeout: number; shell: boolean; stdio: ['ignore', 'pipe', 'pipe'] },
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

export async function generateDescriptionWithLLM(
  nameOrOptions: string | DescriptionOptions,
  sampleTurns?: string,
  runner: DescriptionRunner = execFile as unknown as DescriptionRunner,
): Promise<{ description: string; confident: boolean }> {
  let name: string;
  let sample: string | undefined;
  let isBranch = false;
  let parentName: string | undefined;
  let parentDescription: string | undefined;
  let userPrompt: string | undefined;

  if (typeof nameOrOptions === 'string') {
    name = nameOrOptions;
    sample = sampleTurns;
  } else {
    name = nameOrOptions.name;
    sample = nameOrOptions.sampleTurns;
    isBranch = !!nameOrOptions.isBranch;
    parentName = nameOrOptions.parentName;
    parentDescription = nameOrOptions.parentDescription;
    userPrompt = nameOrOptions.userPrompt;
  }

  const safeName = name.replace(/[&|<>"^`$\\%]/g, ' ').replace(/\s+/g, ' ').trim();
  const contextPart = sample
    ? ` Context: ${sample.replace(/[&|<>"^`$\\%]/g, ' ').slice(0, 200)}`
    : '';

  let systemPrompt = DESCRIPTION_SYSTEM_PROMPT;
  let promptText = `Topic name: ${safeName}.${contextPart}`;

  if (isBranch) {
    systemPrompt = BRANCH_DESCRIPTION_SYSTEM_PROMPT;
    const safeParent = (parentName || 'parent').replace(/[&|<>"^`$\\%]/g, ' ').trim();
    const parentDescPart = parentDescription
      ? ` Parent topic description: ${parentDescription.replace(/[&|<>"^`$\\%]/g, ' ').slice(0, 200)}.`
      : '';
    const branchPromptPart = userPrompt
      ? ` Branch creation prompt: ${userPrompt.replace(/[&|<>"^`$\\%]/g, ' ').slice(0, 200)}.`
      : '';
    promptText = `Branch topic name: ${safeName}. Parent topic: ${safeParent}.${parentDescPart}${branchPromptPart}${contextPart}`;
  }

  let args = ['--system-prompt', systemPrompt, '-p', promptText, '--output-format', 'text'];
  if (process.platform === 'win32') {
    args = args.map(a => /\s/.test(a) ? `"${a}"` : a);
  }

  return new Promise((resolve) => {
    runner(
      process.env.CLAUDE_CMD || 'claude',
      args,
      { timeout: 30_000, shell: true, stdio: ['ignore', 'pipe', 'pipe'] },
      (err, stdout, stderr) => {
        const parsed = parseDescriptionLLMOutput(stdout, err);
        if (err || !stdout.trim()) {
          logger.warn('description', `LLM description generation failed for "${name}": ${err?.message ?? 'empty output'}${stderr ? ` stderr=${stderr.slice(0, 200)}` : ''}`);
        } else if (!parsed.confident) {
          logger.warn('description', `LLM returned non-description for "${name}": ${stdout.slice(0, 100)}`);
        }
        resolve(parsed);
      }
    );
  });
}

async function generateDescriptionSuggestionWithHistory(
  name: string,
  threadId: number
): Promise<{ description: string; confident: boolean }> {
  const turns = await findRecentTurnsByTopic(threadId, 5);
  const sample = turns
    .filter((t) => t.role === 'user')
    .map((t) => t.text.slice(0, 80))
    .join(' | ');

  return generateDescriptionWithLLM(name, sample || undefined);
}

export async function autoSetTopicDescription(
  token: string,
  topicNames: TopicNameMap,
  chatId: number,
  threadId: number,
  description: string,
  topicName?: string
): Promise<void> {
  await setTopicDescription(topicNames, chatId, threadId, description);
  const nameHint = topicName ? ` _${topicName}_` : '';
  const msg = `🌿 Topic${nameHint} created. Description set: _${description}_`;
  await sendMessage(token, chatId, appendRefIdAndLog(msg, { kind: 'help', chatId, threadId }), undefined, threadId || undefined);
}

export async function postDescriptionSuggestion(
  token: string,
  chatId: number,
  threadId: number,
  suggestion: string,
  topicName?: string
): Promise<void> {
  const nameHint = topicName ? ` _${topicName}_` : '';
  const msg = suggestion
    ? `Suggested description: _${suggestion}_\n\nReply *yes* to accept, *no* to skip (auto-accepts in 30 min).`
    : `New topic${nameHint} created. What's it for? Reply with a short description and I'll save it, or *no* to skip.`;
  const freshState = await loadTopicState(chatId, threadId);
  freshState.pendingDescription = {
    text: suggestion,
    proposedAt: new Date().toISOString(),
    expiresAt: Date.now() + DESCRIPTION_TIMEOUT_MS,
  };
  await saveTopicState(freshState);
  // WP-D1 (SPEC §3.4-D1 A.1): the accept/skip ask is a BUTTON ask — the cf: yes/no
  // keyboard rides this message; a press injects the typed yes/no that
  // resolvePendingDescription consumes (§1.5, zero new grammar). No message_id
  // bookkeeping: the 30-min auto-accept stays the only expiry (no reaction binding).
  await sendMessageWithKeyboard(token, chatId, appendRefIdAndLog(msg, { kind: 'help', chatId, threadId }), buildConfirmKeyboard(), undefined, threadId || undefined);
}

async function backfillTopicDescriptions(
  token: string,
  chatIds: number[],
  topicNames: TopicNameMap
): Promise<void> {
  const MAX_BACKFILL = 3;
  let count = 0;
  const activeChatIds = new Set(chatIds.map(String));

  for (const [chatIdStr, threads] of topicNames.entries()) {
    if (!activeChatIds.has(chatIdStr)) continue;
    const chatId = parseInt(chatIdStr, 10);
    if (isNaN(chatId)) continue;

    for (const [threadId, entry] of threads.entries()) {
      if (count >= MAX_BACKFILL) return;
      if (threadId === 0) continue;
      if (entry.description) continue;

      const { description, confident } = await generateDescriptionSuggestionWithHistory(entry.name, threadId);
      const finalDesc = (confident && description) ? description : `Discussions and tasks relating to ${entry.name}.`;
      await setTopicDescription(topicNames, chatId, threadId, finalDesc);
      count++;
    }
  }
}

/**
 * Execute a parsed /llm, /effort or `/default <setting> <value>` command.
 *
 * Tunables are resolved against the worker THIS TOPIC WILL ACTUALLY DISPATCH TO
 * (session override first, then the topic's default worker) — the same choice
 * dispatchMessage makes — so `/effort high` right after `/model gemini-3.7-flash-high` is
 * rejected by agy's own declaration rather than being silently stored against
 * a worker that has no such flag.
 *
 * State is mutated in place; the caller's saveTopicState at the end of
 * processMessage persists it. `observedReader` is injected for tests.
 */
export async function handleTunableCommand(
  cmd: TunableCommand,
  state: ConversationState,
  config: { workers?: WorkerConfig[] } | undefined,
  effectiveDefault: string,
  observedReader: (worker: WorkerConfig | undefined, setting: string) => Promise<string[]> =
    (worker, setting) => readObservedTunableValues(worker, setting),
): Promise<string> {
  const workerName = state.preferred_worker || effectiveDefault;
  const workerConfig = (config?.workers ?? []).find((w) => w.name === workerName);

  // STRICT ON THE KNOB. Rejecting here — not at dispatch — is deliberate: an
  // undeclared flag would fail every subsequent run in this topic and read as an
  // outage. validateTunable's error already names what this worker DOES support.
  const validation = validateTunable(workerConfig, cmd.setting);
  if (!validation.ok) return validation.error ?? `Unknown setting '${cmd.setting}'.`;

  const prevSessionSlice = selectWorkerTunables(state.tunable_overrides, workerName);
  const prevTopicSlice = selectWorkerTunables(state.tunable_defaults, workerName);
  const prevLlm = resolveWorkerLlm(workerConfig, prevSessionSlice, prevTopicSlice);
  const prevEffort = resolveWorkerEffort(workerConfig, prevSessionSlice, prevTopicSlice);
  const previousDescriptor = formatWorkerDescriptor(workerName, prevLlm, prevEffort);

  if (cmd.action === 'set') {
    if (cmd.scope === 'session') setSessionTunable(state, workerName, cmd.setting, cmd.value);
    else setTopicTunable(state, workerName, cmd.setting, cmd.value);
  } else if (cmd.action === 'clear') {
    if (cmd.scope === 'session') setSessionTunable(state, workerName, cmd.setting, undefined);
    else setTopicTunable(state, workerName, cmd.setting, undefined);
  }

  const sessionSlice = selectWorkerTunables(state.tunable_overrides, workerName);
  const topicSlice = selectWorkerTunables(state.tunable_defaults, workerName);
  const resolved = resolveTunable(workerConfig, cmd.setting, sessionSlice, topicSlice);
  const nextLlm = resolveWorkerLlm(workerConfig, sessionSlice, topicSlice);
  const nextEffort = resolveWorkerEffort(workerConfig, sessionSlice, topicSlice);
  const currentDescriptor = formatWorkerDescriptor(workerName, nextLlm, nextEffort);

  if (cmd.action === 'set') {
    // FREE ON THE VALUE — isKnownValue only decides whether to add a note.
    return renderTunableSetResult({
      worker: workerName,
      setting: cmd.setting,
      scope: cmd.scope,
      value: cmd.value!,
      known: isKnownValue(validation.spec, cmd.value!),
      args: resolved?.args ?? [],
      // Carries any `supersedes:` outcome, so a value that was stored but will
      // NOT be sent (or one that just displaced a sibling) says so right here
      // rather than only on a later bare /llm.
      resolved,
      previousDescriptor,
      currentDescriptor,
    });
  }

  if (cmd.action === 'clear') {
    return renderTunableClearResult({
      worker: workerName, setting: cmd.setting, scope: cmd.scope, resolved,
      pinned: extractTunableValues(validation.spec, workerConfig?.args),
      previousDescriptor,
      currentDescriptor,
    });
  }

  // Bare command: the discoverability reply. The observed-values read touches
  // disk and is best-effort — a help message must never fail on it.
  const observed = await observedReader(workerConfig, cmd.setting).catch(() => [] as string[]);
  return renderTunableReport({
    worker: workerName,
    label: cmd.label,
    setting: cmd.setting,
    validation,
    resolved,
    observed,
    sessionValue: sessionSlice[cmd.setting],
    topicValue: topicSlice[cmd.setting],
    // Same extractor the observed-values reader uses, pointed at the worker's
    // STATIC args — that is how `--model opusplan` (pinned in config.yaml for
    // claude/zclaude) shows up instead of being reported as "nothing passed".
    pinned: extractTunableValues(validation.spec, workerConfig?.args),
  });
}

/** Fire-and-forget request for a fresh Google OAuth link, delivered to THIS
 *  chat/thread by the start script itself (AI-147: the script used to mint a
 *  session and print a URL nobody received). Never routed to an LLM worker.
 *  `runtimeEnv` (process.env merged with secrets.env) is a local of
 *  processUpdate, not module scope — passed explicitly so this stays a
 *  top-level function (the draft closed over `runtimeEnv` from a scope this
 *  function cannot see; the git-workflow trigger helper that once sat
 *  alongside now lives in command-router.ts). */
function spawnReauthLink(chatId: number, threadId: number | undefined, runtimeEnv: NodeJS.ProcessEnv, skill?: string): string {
  const script = runtimeEnv.PA_OAUTH_START_SCRIPT || join(BOT_CWD, 'pa', 'scripts', 'start_google_telegram_reauth.py');
  const redirectUri = runtimeEnv.GOOGLE_AUTH_REDIRECT_URI?.trim();
  if (!redirectUri) return 'Cannot start reauth: GOOGLE_AUTH_REDIRECT_URI is not configured in ~/.pa/secrets.env.';
  const args = [script, '--reuse-pending', '--redirect-uri', redirectUri,
                '--chat-id', String(chatId), '--thread-id', String(threadId ?? 0)];
  if (skill) args.push('--resume-skill', skill);
  spawn(resolvePythonCommand(runtimeEnv), args, { cwd: BOT_CWD, detached: true, stdio: 'ignore', shell: false, windowsHide: true }).unref();
  return skill
    ? `🔐 Requesting a Google reauth link (will resume \`${skill}\` after success) — it arrives here shortly.`
    : '🔐 Requesting a Google reauth link — it arrives here shortly.';
}

/** How long a dispatch waits for a recovering topic before proceeding anyway
 *  (default > the reaper's 45-min REAP_MAX_WAIT_MS so the reaper always wins the
 *  race; a stale gate with no reaper must not wedge the topic forever). Read lazily
 *  so tests can pin it via env per-case. 0 = proceed immediately.
 *  (seamless-restart-recovery 2026-08-27) */
function recoveryWaitMs(): number {
  const v = Number(process.env.PA_RECOVERY_WAIT_MS);
  return Number.isFinite(v) && v >= 0 ? v : 50 * 60 * 1000;
}

async function processUpdate(
  update: any,
  token: string,
  allowedChatIds: Set<number>,
  secrets: Record<string, string>,
  topicNames: TopicNameMap,
  branchIndex: BranchIndex = new Map()
): Promise<void> {
  const msg = update.message;
  if (!msg) return;

  const topicEvent = extractTopicEvent(msg);
  if (topicEvent && allowedChatIds.has(topicEvent.chatId)) {
    await updateTopicName(topicNames, topicEvent.chatId, topicEvent.threadId, topicEvent.name);
    if (msg.forum_topic_created) {
      const topicKey = `${topicEvent.chatId}_${topicEvent.threadId}`;
      if (!branchCreatedTopicKeys.delete(topicKey)) {
        const { description, confident } = await generateDescriptionWithLLM(topicEvent.name);
        const finalDesc = (confident && description) ? description : `Discussions and tasks relating to ${topicEvent.name}.`;
        await autoSetTopicDescription(token, topicNames, topicEvent.chatId, topicEvent.threadId, finalDesc, topicEvent.name);

        // Generate and pin topic status card by default for this new topic
        try {
          let config: any = { workers: [] };
          try { config = await loadConfig(); } catch {}
          const effectiveDefault = getEffectiveDefaultWorker(config, topicKey);
          const topicState = await loadTopicState(topicEvent.chatId, topicEvent.threadId);
          const snapshot = hydrateModelStatus(topicState, effectiveDefault, config);
          await replacePinnedStatusCard(token, topicEvent.chatId, topicEvent.threadId, topicState, snapshot);
          await saveTopicState(topicState);
        } catch (pinErr) {
          logger.warn('topic', `failed to generate pinned status card for new topic ${topicKey}: ${(pinErr as Error).message}`);
        }
      }
    }
  }

  if (!isAcceptableUpdate(update, allowedChatIds)) return;
  const chatId = msg.chat.id;

  const threadId = msg.message_thread_id ?? 0;
  let userText = (msg.text || msg.caption || '').trim();
  const messageId = msg.message_id;
  const timestamp = new Date(msg.date * 1000).toISOString();
  // Resolved later, inside the !skipWorker dispatch block (hardened plan WP6
  // item 5) — needs topicState (not loaded yet) and is enrichment, not
  // delivery, so skip-worker commands never pay for it.
  let replyContext: string | undefined;
  const contextId = randomUUID();

  // Synthetic updates (button/reaction-injected, spec §3.1): the message id here belongs
  // to the card/notice that spawned the press, not to a user turn, and for the reaction
  // path the ✅ receipt is already sent by handleMessageReaction — skip the 👍 ack.
  // B5: Also skip for requeued synthetics — the user already saw the 👍 on first receipt.
  if (!(update as any).__synthetic && (update as any).__requeueCount === undefined) setMessageReaction(token, chatId, messageId, '👍').catch(() => {});

  // Wave-2 tier-1 attribution (SPEC §3.1 A.3): a reply to a task's FYI/question
  // anchor is answered straight into the task's micro_thread — no topic lock, no
  // dispatch, nothing archived to state.turns. Miss falls through to normal
  // topic processing below.
  if (userText && typeof msg.reply_to_message?.message_id === 'number') {
    const routed = await routeReplyToTask({
      chatId,
      threadId,
      replyToMessageId: msg.reply_to_message.message_id,
      text: userText,
      sendReply: (text, replyTo) => sendMessage(token, chatId, text, replyTo, threadId || undefined),
    });
    if (routed) return;
  }

  const resourceId = `topic-${chatId}_${threadId}`;
  const acquired = await blackboard.acquireLock(resourceId, 'telegram-bot', process.pid, 60000, contextId);
  if (!acquired) {
    await sendMessage(token, chatId, appendRefIdAndLog('⚠️ Processing is delayed. Please try again in a moment.', { kind: 'lock_busy', chatId, threadId }), messageId, threadId);
    return;
  }
  const lockRenewal = startLockRenewal(resourceId, 'telegram-bot', contextId, {
    onLost: (reason) => logger.warn('lock', `topic lock renewal ${reason}`, { resource: resourceId, chatId, threadId, updateId: update.update_id }),
  });

  try {
    const topicState = await loadTopicState(chatId, threadId);
    let restartBot = false;
    const topicKey = topicKeyFor(chatId, threadId);
    const runtimeEnv = { ...process.env, ...secrets };
    let config: any = { workers: [] };
    try { config = await loadConfig(); } catch {}
    let effectiveDefault = getEffectiveDefaultWorker(config, topicKey);

    // Resolve workdir once per processUpdate (§3.3)
    const workdir = await ensureTopicWorkdir(await resolveTopicWorkdir(topicState), BOT_CWD);

    // Voice/attachment stage (AI-173 phase 1, 2026-09-01):
    // projects/telegram-bot/src/attachment-stage.ts owns transcription, the audio
    // index, the 🎙 Heard echo and document/photo download. Everything it decides
    // arrives here as one result.
    //
    // `response`/`skipWorker` are load-bearing OUTPUTS, not bookkeeping (hardened
    // plan WP6 item 4): without the stage's `skipWorker`, a failed note's bracketed
    // error text (>25 chars) reaches the pendingDescription branch below and
    // silently renames the topic. `voiceTranscribed` guards that same branch from
    // treating a transcribed sentence as an intentional answer to "what's this
    // topic for?".
    const stage = await runAttachmentStage({
      msg,
      update,
      userText,
      token,
      chatId,
      threadId,
      messageId,
      repoRoot: BOT_CWD,
      runtimeEnv,
      transcription: config.transcription,
    });
    userText = stage.userText;
    let response = stage.response;
    let skipWorker = stage.skipWorker;
    let voiceTranscribed = stage.voiceTranscribed;
    const audioAttachment = stage.audioAttachment;

    let archivedUserText = userText;
    // Deterministic command router (AI-173 phase 2, 2026-09-06):
    // command-router.ts owns expiry, the unknown-command guard, /auth, the
    // agent/tunable//new//code//default//retranscribe//status command family,
    // the git-workflow triggers, /update_brain and the user-turn archive.
    // Everything it decides arrives here as one result.
    const routed = await runCommandRouter(
      {
        msg,
        update,
        userText,
        skipWorker,
        response,
        voiceTranscribed,
        audioAttachment,
        token,
        chatId,
        threadId,
        messageId,
        timestamp,
        repoRoot: BOT_CWD,
        topicState,
        config,
        effectiveDefault,
        workdir,
        runtimeEnv,
        secrets,
        allowedChatIds,
      },
      {
        refreshCard: refreshPinnedStatusCardInPlace,
        syncModelStatus: syncModelStatusState,
        spawnReauthLink,
        injectResumeUpdate: injectSystemResumeUpdate,
        handleTunables: handleTunableCommand,
      },
    );
    userText = routed.userText;
    archivedUserText = routed.archivedUserText;
    response = routed.response;
    skipWorker = routed.skipWorker;
    voiceTranscribed = routed.voiceTranscribed;
    effectiveDefault = routed.effectiveDefault;
    // Model routing policy (2026-09-11, plans/2026-09-11-model-routing-policy.md):
    // code/engineering-classified turns override the topic default with the
    // time-window worker (off-peak → routing_policy.code_worker, ZAI peak →
    // peak_code_worker, window = cost_tier.peak_window_utc). Explicit /agent
    // pins and same-turn router mutations outrank the policy; general turns
    // and a disabled/absent policy keep today's default. Covers BOTH lanes —
    // the orchestrator dispatch below reads the same effectiveDefault.
    // WP-G (2026-09-18): resolveTurnRouting now returns the FULL per-turn
    // result — worker (shadow/enabled semantics per the model-router spec) +
    // router-sourced model/effort. The worker lands in effectiveDefault as
    // before; model/effort ride a PER-TURN dispatch-only state view (below) —
    // they are never persisted to topicState, whose tunable surfaces stay the
    // outranking pins.
    // WP-4 (§4.2, router-as-orchestrator 2026-09-19): on a LIVE-steer turn the
    // reply-to FYI anchor is identified HERE — before routing — and rides the
    // router's in-flight context (decision 24); the steer/wait decision then
    // applies at the anchor site below, replacing the old short-circuit.
    // Identification only: the anchor PATTERN is unchanged (R10). The
    // pending-action outrank is evaluated against the same pre-consume state
    // the anchor site snapshots later (no pending_action writer in between).
    // A non-running (done/queued) anchor never feeds — its wake keeps today's
    // direct path.
    const steerLive = config?.model_router?.surfaces?.steer === 'live';
    let anchorThreadIdPre: string | null = null;
    let anchorInflight: Parameters<typeof resolveTurnRouting>[0]['currentInflight'];
    if (steerLive && !topicState.pending_action && userText.trim()) {
      const preAnchor = resolveThreadFyiAnchor(msg);
      if (preAnchor) {
        const anchorRec = await getThread(topicKey, preAnchor).catch(() => undefined);
        if (anchorRec && anchorRec.status === 'running') {
          anchorThreadIdPre = preAnchor;
          anchorInflight = [{ id: preAnchor, title: anchorRec.title.slice(0, 60), status: 'running' }];
        }
      }
    }
    // WP-5 (§3.1/§4.1): placement candidates + the in-flight view — computed
    // when the BLOCK exists (shadow accrual, §9.2: dark records the placement
    // and steer_wait answers, so the questions must ride the ask) for real
    // operator turns only. Empty candidates still ask the placement question
    // (other/split* validate away — never collapse [] to absent). The FYI
    // anchor's entry rides FIRST (§4.2 fold, rider (a)).
    const mrBlock: ModelRouterConfig | undefined = config?.model_router;
    const placementLive = mrBlock?.surfaces?.placement === 'live';
    const placementAskEligible = mrBlock !== undefined && canPlaceUpdate(update);
    let placementCandidates: RouterPlacementCandidate[] = [];
    let inflightViews: Parameters<typeof resolveTurnRouting>[0]['currentInflight'] = [];
    if (placementAskEligible) {
      try {
        placementCandidates = voiceInboxPlacementCandidates(
          mrBlock?.placement?.candidate_cap ?? 25,
          // m3 (§1.2, spec-recheck): the READER owns the current-conversation
          // truncation exemption. The current conversation resolves by the
          // SAME rule buildRouteTurnInput applies (named ledger tasks →
          // conversation_id); any miss stays undefined and the exemption is
          // simply inert for that turn.
          voiceConversationKeyForTasks(extractVoiceInboxTaskIds(userText)),
        );
      } catch { placementCandidates = []; }
      // §4.1 in-flight view, ≤3 entries, ids/short titles only: the anchor
      // entry (WP-4's read) first, then the human lane (an unsettled pending
      // dispatch from a DIFFERENT update), the thread lane (running threads,
      // newest first), the voice lane (carried task states — fail-open).
      if (anchorInflight) inflightViews.push(...anchorInflight);
      const pending = await listPendingDispatches().catch(() => [] as PendingDispatch[]);
      const topicPending = pending.find((p) => p.chatId === chatId && p.threadId === threadId && p.updateId !== update.update_id);
      if (topicPending && inflightViews.length < 3) {
        inflightViews.push({ id: 'topic', title: topicPending.userText.slice(0, 60), status: 'running' });
      }
      const threadRecs = await listThreads(topicKey).catch(() => []);
      for (const t of threadRecs.filter((r) => r.status === 'running').sort((a, b) => b.n - a.n)) {
        if (inflightViews.length >= 3) break;
        if (inflightViews.some((e) => e.id === t.id)) continue;
        inflightViews.push({ id: t.id, title: t.title.slice(0, 60), status: 'running' });
      }
      const voiceStates = voiceInboxTaskStates(Array.from(new Set(threadRecs.flatMap((r) => r.voiceTaskIds ?? []))));
      for (const [id, st] of voiceStates) {
        if (inflightViews.length >= 3) break;
        if (!VOICE_INBOX_PLACEMENT_INFLIGHT_STATES.has(st.state)) continue;
        if (inflightViews.some((e) => e.id === id)) continue;
        inflightViews.push({ id, title: 'voice task', status: st.state });
      }
    }
    // WP-5 (I-3): a placed turn NEVER re-asks — the carried needs/chain
    // resolve deterministically against the destination incumbent (§3.3).
    const placementCarry = (update as any).__placementCarry as (PlacementCarry & { focusDirective?: string }) | undefined;
    const routerTurn: TurnRoutingResult = (update as any).__synthetic === 'placement' && placementCarry
      ? await resolveDestinationPlacementRouting(placementCarry, config, topicKey, String(threadId), effectiveDefault)
      : await resolveTurnRouting({
          config,
          topicKey,
          topicName: getTopicName(topicNames, chatId, threadId),
          topicDescription: topicNames.get(String(chatId))?.get(threadId)?.description,
          userText,
          preferredWorker: topicState.preferred_worker,
          configuredDefault: getConfiguredDefaultWorker(config, topicKey),
          baselineDefault: getEffectiveDefaultWorker(config, topicKey),
          ...(placementAskEligible && inflightViews.length > 0
            ? { currentInflight: inflightViews }
            : anchorInflight
              ? { currentInflight: anchorInflight }
              : {}),
          ...(placementAskEligible
            ? {
                candidates: placementCandidates.map((c) => ({
                  id: c.conversationId,
                  goal: c.goal.slice(0, mrBlock?.placement?.goal_chars ?? 80),
                  status: c.status,
                  inflight: c.inflight,
                })),
              }
            : {}),
        }, effectiveDefault);
    effectiveDefault = routerTurn.worker;
    // WP-4 (§4.2 steer surface, LIVE only): the router said STEER for an
    // in-flight run — the current turn becomes the correction. The SAME
    // extracted mechanics as /steer run here (executeSteer: mark + kill +
    // drain + fold handoff), then the current turn re-dispatches below as the
    // fresh continuation with the folded prompt (voice entries ride
    // __foldedVoice into the attachment stage). Dark/shadow, wait-decisions
    // and fail-open turns fall through unchanged — wait IS today's queuing.
    if (steerLive && routerTurn.steerWait?.inflight && routerTurn.steerWait.decision === 'steer') {
      // §4.3 guard write: a steer_thread for the steered target parsed from
      // THIS turn's reply is dropped by the route-application loop.
      if (anchorThreadIdPre) markRouterSteered(topicKey, update.update_id, [anchorThreadIdPre]);
      const steerOutcome = await executeSteer({
        topicKey,
        chatId,
        threadId,
        updateId: update.update_id,
        messageId,
        steerPrompt: userText,
        prefetchDeps: { repoRoot: BOT_CWD, env: runtimeEnv, transcription: config.transcription, threadId },
        token,
      });
      const steerMat = await materializeSteerPrompt(steerOutcome.steerContext, topicKey, chatId, threadId);
      userText = steerMat.text;
      if (steerMat.foldedVoice.length > 0) (update as any).__foldedVoice = steerMat.foldedVoice;
    }
    // WP-5 (§3.2, placement surface LIVE only): the router answered the
    // placement question for a REAL operator turn — decide mechanically and,
    // for move/create/split, inject the turn into its destination through the
    // same injection seam the route drain uses and ANNOUNCE in the origin.
    // No worker runs in the origin for a placed turn (skipWorker) — the
    // announce IS the origin turn's reply. A placed turn carries
    // `__synthetic: 'placement'` and is never re-placed (placeOnce). Dark/
    // shadow falls through — today's branch dispatches (§9.2).
    if (placementLive && routerTurn.placement && canPlaceUpdate(update)) {
      const decision = applyRouterPlacement(routerTurn, topicKey, placementCandidates, {
        userText,
        originTopicName: getTopicName(topicNames, chatId, threadId) ?? `topic-${threadId}`,
      });
      if (decision.kind !== 'in-place') {
        const parts = decision.kind === 'split' ? decision.parts : [decision];
        // Router-metadata (§1.2): the ORIGIN's ledger conversation id — reverse
        // lookup over the placement candidates (the candidate whose routedTo IS
        // the origin topic key). Absent when the origin has no ledger
        // conversation (a plain Telegram turn) — the destination then stamps
        // the placement word without a target.
        const originConversationId = placementCandidates.find((c) => c.routedTo === topicKey)?.conversationId;
        const announceLines: string[] = [];
        for (const part of parts) {
          let destThreadId: number;
          let destChatId = chatId;
          let destName: string;
          if (part.kind === 'create') {
            // /branch machinery (AI-028); the race-fix ordering below is
            // LOAD-BEARING (see the /branch block): the key is registered
            // BEFORE any async work so the concurrent forum_topic_created
            // handler skips auto-description. Deterministic description —
            // no LLM call (§3.2).
            const newThreadId = await createForumTopic(token, chatId, part.name);
            const createdKey = `${chatId}_${newThreadId}`;
            branchCreatedTopicKeys.add(createdKey);
            try {
              await updateTopicName(topicNames, chatId, newThreadId, part.name);
              await setTopicDescription(topicNames, chatId, newThreadId, part.description.slice(0, MAX_DESCRIPTION_LEN));
            } catch (err) {
              branchCreatedTopicKeys.delete(createdKey);
              throw err;
            }
            destThreadId = newThreadId;
            destName = part.name;
          } else {
            const sep = part.targetTopicKey.lastIndexOf('_');
            destChatId = Number(part.targetTopicKey.slice(0, sep));
            destThreadId = Number(part.targetTopicKey.slice(sep + 1));
            destName = getTopicName(topicNames, destChatId, destThreadId) ?? `topic-${destThreadId}`;
          }
          injectPlacementTurn({
            chatId: destChatId,
            threadId: destThreadId,
            userText,
            directive: part.directive,
            carry: {
              // Needs ride the carried payload when the router exposed them
              // (TurnRoutingResult.tier/score — integrator seam 2026-09-20);
              // a fail-open origin turn carries none, so the destination
              // resolve skips the capability-UP filter and marks
              // '+no-carried-needs' (WP-3's deepEqual pins that path).
              // TurnRoutingResult.chain is already worker NAMES.
              ...(routerTurn.tier !== undefined ? { tier: routerTurn.tier } : {}),
              ...(routerTurn.score !== undefined ? { score: routerTurn.score } : {}),
              chain: routerTurn.chain ?? [],
              // Router-metadata (§1.2): ids only — the destination leg's
              // PA_ROUTING_PLACEMENT/PA_ROUTING_TARGET derive from this.
              originRouting: {
                kind: decision.kind === 'split' ? 'split' : part.kind,
                ...(originConversationId !== undefined ? { originConversationId } : {}),
              },
            },
          });
          announceLines.push(part.kind === 'create' ? `→ New topic ${destName}` : `→ Moved to ${destName}`);
        }
        response = appendRefIdAndLog(announceLines.join('\n'), { kind: 'route', chatId, threadId });
        skipWorker = true;
      }
    }
    // /orchestrator (AI-203): per-topic orchestrator-mode toggle + status. A
    // deterministic local command like the router's family — the pure handler
    // decides; this site performs the role-boundary session clear and answers
    // with a ref-ID'd reply, never a worker dispatch.
    if (!skipWorker && ORCHESTRATOR_PATTERN.test(userText)) {
      const orchCmd = handleOrchestratorCommand(userText, topicState, await listThreads(topicKey));
      if (orchCmd.clearSession) topicState.session = undefined;
      // WP-5 (§3.2/E-list 3): under the placement surface the reply carries
      // the standing deprecation notice; state writes above are unchanged.
      response = appendRefIdAndLog(
        placementLive ? `${orchCmd.response}${ORCHESTRATOR_ROUTER_NOTICE}` : orchCmd.response,
        { kind: 'system', chatId, threadId },
      );
      skipWorker = true;
    }
    // AI-028: /branch <name> [prompt] — create a child topic linked to this one.
    if (!skipWorker) {
      const br = handleBranchCommand(topicState, userText);
      if (br.matched) {
        if (br.branchName) {
          const parentName = getTopicName(topicNames, chatId, threadId) ?? 'parent';
          const parentEntry = topicNames.get(String(chatId))?.get(threadId);
          const parentDesc = parentEntry?.description;
          const sampleTurns = topicState.turns
            .filter((t) => t.role === 'user')
            .slice(-5)
            .map((t) => t.text.slice(0, 80))
            .join(' | ');

          const newThreadId = await createForumTopic(token, chatId, br.branchName);
          // Register the key BEFORE any async work so the forum_topic_created
          // handler (which arrives via a concurrent poll-loop update) sees it
          // and skips auto-description.  Previously this was at the END of the
          // block (after an LLM call that takes seconds in production), so the
          // forum_topic_created event raced ahead and overwrote the branch
          // description.  Moving it here — synchronously, before the next
          // await — closes the window: no microtask can interleave between
          // createForumTopic resolving and this .add() call.
          const branchCreatedKey = `${chatId}_${newThreadId}`;
          branchCreatedTopicKeys.add(branchCreatedKey);
          // The registration above is provisional until this topic actually
          // gets its OWN description (setTopicDescription below). If setup
          // throws before that point, undo it — otherwise forum_topic_created's
          // fallback stays suppressed on a topic that ends up with no
          // description at all, which is worse than the race being closed.
          let branchDesc = '';
          try {
            await updateTopicName(topicNames, chatId, newThreadId, br.branchName);

            const { description, confident } = await generateDescriptionWithLLM({
              name: br.branchName,
              isBranch: true,
              parentName,
              parentDescription: parentDesc,
              userPrompt: br.prompt,
              sampleTurns: sampleTurns || undefined,
            });

            branchDesc = (confident && description) ? description : '';
            if (!branchDesc) {
              branchDesc = br.prompt
                ? `Branch of ${parentName} for ${br.branchName}: ${br.prompt}`
                : `Branch of ${parentName} focused on ${br.branchName}.`;
            }
            if (branchDesc.length > MAX_DESCRIPTION_LEN) {
              branchDesc = branchDesc.slice(0, MAX_DESCRIPTION_LEN);
            }

            await setTopicDescription(topicNames, chatId, newThreadId, branchDesc);
          } catch (err) {
            branchCreatedTopicKeys.delete(branchCreatedKey);
            throw err;
          }

          const branchState = await loadTopicState(chatId, newThreadId);
          branchState.ancestry = { parentChatId: chatId, parentThreadId: threadId, branchName: br.branchName };
          addTurn(branchState, { role: 'assistant', text: `[Branch of: ${parentName}]`, timestamp: new Date().toISOString(), worker: 'local' });
          if (br.prompt) {
            addTurn(branchState, { role: 'user', text: br.prompt, timestamp: new Date().toISOString() });
          }

          // Generate and pin status card by default for the new branch topic
          try {
            const branchTopicKey = topicKeyFor(chatId, newThreadId);
            const branchEffectiveDefault = getEffectiveDefaultWorker(config, branchTopicKey);
            const branchSnapshot = hydrateModelStatus(branchState, branchEffectiveDefault, config);
            await replacePinnedStatusCard(token, chatId, newThreadId, branchState, branchSnapshot);
          } catch (pinErr) {
            logger.warn('branch', `failed to generate pinned status card for branch ${br.branchName}: ${(pinErr as Error).message}`);
          }

          await saveTopicState(branchState);
          await addBranch(branchIndex, chatId, newThreadId, { parentThreadId: threadId, branchName: br.branchName, createdAt: new Date().toISOString() });
          await sendMessage(token, chatId, appendRefIdAndLog(`🌿 Branch *${br.branchName}* created — continue in the new topic.\nDescription: _${branchDesc}_`, { kind: 'branch', chatId, threadId: newThreadId }), undefined, newThreadId);
          await sendMessage(token, chatId, appendRefIdAndLog(`🌿 Created branch *${br.branchName}* as a new topic.`, { kind: 'branch', chatId, threadId }), messageId, threadId);
        } else {
          response = br.response;
        }
        skipWorker = true;
      }
    }

    // AI-028: /child-of <parent> — link this topic as a branch of an existing one.
    if (!skipWorker) {
      const co = handleChildOfCommand(topicState, userText);
      if (co.matched) {
        if (co.parentName) {
          const parentThreadId = findBranchParent(topicNames, chatId, co.parentName);
          if (parentThreadId === undefined) {
            response = `No topic named *${co.parentName}* found in this chat.`;
          } else {
            const myName = getTopicName(topicNames, chatId, threadId) ?? `topic-${threadId}`;
            topicState.ancestry = { parentChatId: chatId, parentThreadId, branchName: myName };
            await saveTopicState(topicState);
            await addBranch(branchIndex, chatId, threadId, { parentThreadId, branchName: myName, createdAt: new Date().toISOString() });
            response = `🔗 Linked as a branch of *${co.parentName}*.`;
          }
        } else {
          response = co.response;
        }
        skipWorker = true;
      }
    }

    // AI-028: /merge — copy branch turns back to the parent and close the branch.
    if (!skipWorker) {
      const mg = handleMergeCommand(topicState, userText);
      if (mg.matched) {
        if (mg.response) {
          response = mg.response;
        } else {
          const anc = topicState.ancestry!;
          const parentState = await loadTopicState(chatId, anc.parentThreadId);
          addTurn(parentState, { role: 'assistant', text: `[Merge from: ${anc.branchName}]`, timestamp: new Date().toISOString(), worker: 'local' });
          for (const t of topicState.turns) {
            if (t.message_id === messageId) continue; // skip the /merge command itself
            if (t.text.startsWith('[Branch of:') || t.text.startsWith('[Merge from:')) continue;
            addTurn(parentState, t);
          }
          await saveTopicState(parentState);
          anc.mergedAt = new Date().toISOString();
          await saveTopicState(topicState);
          await removeBranch(branchIndex, chatId, threadId);
          const parentName = getTopicName(topicNames, chatId, anc.parentThreadId) ?? 'parent';
          response = `✅ Merged into *${parentName}*.`;
        }
        skipWorker = true;
      }
    }

    // AI-029: a pending auto-suggested description awaiting the user's approval.
    if (!skipWorker && topicState.pendingDescription) {
      const pdResult = resolvePendingDescription(topicState, userText, { voiceTranscribed });
      if (pdResult.acceptDescriptionText !== undefined) {
        await setTopicDescription(topicNames, chatId, threadId, pdResult.acceptDescriptionText);
      }
      response = pdResult.response;
      skipWorker = pdResult.skipWorker;
    }

    // Consumed by a confirmed "yes" below (spec correction 3 / WP-B1 edit 5): clears
    // pending_action so a second "yes" (typed, tapped, or 👍'd) inside the 5-minute TTL
    // cannot re-run the same confirmed action.
    let confirmedDescription: string | undefined;
    // AI-203 increment 3: resolveConfirmation clears an armed action for any
    // unrelated text and consumeConfirmation clears it for a yes — both BEFORE
    // the dispatch block — so the anchor guard below could never observe the
    // arm. Snapshot it AFTER TTL expiry but BEFORE that consume: an armed
    // pending_action outranks the thread-FYI anchor (the reply is the
    // confirmation turn, never a steer).
    let pendingActionArmed = false;
    if (!skipWorker) {
      expirePendingAction(topicState);
      pendingActionArmed = !!topicState.pending_action;
      // Ask-mirroring reverse clear (2026-09-11 spec §2d): the vi- id this armed ask was
      // mirrored to — snapshotted after TTL expiry but BEFORE resolveConfirmation/
      // consumeConfirmation, so expiry is excluded (a deliberate non-goal: the widget
      // outliving the 5-min Telegram TTL is the durable ask).
      const confirmVoiceTask = topicState.pending_action?.voice_task;
      if (topicState.pending_action) {
        const resolved = resolveConfirmation(topicState, userText);
        response = resolved.response; skipWorker = resolved.skipWorker;
        if (!skipWorker && topicState.pending_action) confirmedDescription = consumeConfirmation(topicState);
      }
      // Topic-task handover Wave 1 (SPEC §3.3, WP-F): the pending_question
      // counterparts. TTL expiry mirrors expirePendingAction (same
      // PENDING_ACTION_TTL_MS — the ONLY expiry path a stale question has),
      // and a typed answer matching one of the question's options clears the
      // question exactly like a `q:` press does. The clearing MUST happen here:
      // loadTopicState hands the q: handler a COPY, so the press itself cannot
      // mutate stored state — this mutation, persisted by saveTopicState below,
      // is the only path. The turn still flows to the worker (the worker must
      // see the chosen answer). A question and pending_action are mutually
      // exclusive at arm time (applyMetaActions), so the two blocks never
      // interact on one turn.
      expirePendingQuestion(topicState);
      // AI-234: pending_suggestions is ephemeral — cleared on the next turn
      // (and on press, which injects a synthetic turn that flows through here).
      // No TTL (the spec: "Mirrors pending_question's shape, not its semantics").
      topicState.pending_suggestions = undefined;
      const questionVoiceTask = topicState.pending_question?.voice_task;
      const questionWasArmed = !!topicState.pending_question;
      resolveQuestionAnswer(topicState, userText);
      // Ask-mirroring reverse clears (2026-09-11 spec §2d): an armed ask that this turn
      // resolved/cleared by ANY outcome — typed yes (consume), no, displacement by
      // unrelated text, or a matched question answer — cancels the mirrored voice-inbox
      // widget so the app badge cannot lie. Fire-and-forget: a failed cancel never
      // blocks the turn (the completion sweep is the backstop).
      if (pendingActionArmed && !topicState.pending_action && confirmVoiceTask) {
        const taskId = confirmVoiceTask;
        void cancelMirroredAsk(taskId)
          .then((res) => {
            if (!res.ok) logger.warn('voice-input-mirror', `mirror cancel failed: ${res.error}`, { chatId, threadId, taskId });
          })
          .catch((err) => logger.warn('voice-input-mirror', `mirror cancel failed: ${(err as Error).message}`, { chatId, threadId, taskId }));
      }
      if (questionWasArmed && !topicState.pending_question && questionVoiceTask) {
        const taskId = questionVoiceTask;
        void cancelMirroredAsk(taskId)
          .then((res) => {
            if (!res.ok) logger.warn('voice-input-mirror', `mirror cancel failed: ${res.error}`, { chatId, threadId, taskId });
          })
          .catch((err) => logger.warn('voice-input-mirror', `mirror cancel failed: ${(err as Error).message}`, { chatId, threadId, taskId }));
      }
    }

    // AI-095 follow-up (deep-recheck 2026-07-08, Phase 1B): a topic with an
    // orphan-recovery still in flight must not receive a new dispatch — it
    // would resume the SAME session the orphan may still be writing to
    // (concurrent transcript writes), and the reaper's harvest could later
    // deliver this new reply a second time, mislabeled "Recovered reply".
    // Gated on `!skipWorker` — this must never override a command guard
    // (/reset, /model, etc.) that already resolved its own response above;
    // only intervene when the update was genuinely about to dispatch.
    if (!skipWorker && isTopicRecovering(topicKey)) {
      // Queue-not-bounce (2026-08-27 seamless-restart-recovery spec): the topic is under
      // orphan-recovery; WAIT for the reaper to clear it, then dispatch normally. The
      // wait sits inside the already-acquired topic lock (AI-113 renewal keeps it fresh;
      // reaper max 45 min « renewal cap 6 h). Typing pulse mirrors the dispatch keep-alive
      // (DEGRADED-shed) but as a setTimeout chain — main.ts's setInterval count is pinned
      // by pa/tests/timer-inventory.test.ts and must stay at 2.
      let pulseTimer: NodeJS.Timeout | undefined;
      const pulse = () => {
        if (!isDegraded()) sendTyping(token, chatId, threadId).catch(() => {});
        pulseTimer = setTimeout(pulse, 4000);
        pulseTimer.unref?.();
      };
      pulse();
      let cleared = false;
      try {
        cleared = await waitForTopicRecovery(topicKey, recoveryWaitMs());
      } finally {
        if (pulseTimer) clearTimeout(pulseTimer);
      }
      if (!cleared) {
        logger.warn('recovery-gate', 'stale recovery gate — wait timed out, dispatching anyway', { chatId, threadId, updateId: update.update_id });
      }
      if (!isDegraded()) await sendTyping(token, chatId, threadId).catch(() => {});
    }

    let pendingKey: string | undefined;
    // AI-151: track the actual worker that handled this dispatch for accurate archival
    let assistantWorker: string = 'local';
    // Hoisted out of the !skipWorker block (WP-B1 edit 7, spec §3.2): the reply-send
    // block below needs to know whether the dispatch errored, to attach a
    // buildFailoverKeyboard to the reply instead of the confirm keyboard.
    let workerErrored = false;
    // AI-234: carry sanitized suggested_items out of the dispatch try-block so
    // the reply-send KB cascade (outside the try) can attach the sr: keyboard.
    let suggestedItems: string[] | undefined;
    // WP-D1 (SPEC §3.4-D1 A.2/A.3): this update's cascade inputs start clean — the
    // module lets above are per-update values, never carried across updates.
    suggestedAlt = null;
    drSuggestedWorker = null;
    if (!skipWorker) {
      // AI-095: persist the in-flight dispatch so a crash mid-dispatch leaves a
      // recoverable record for the startup orphan reaper instead of a silent void.
      pendingKey = pendingDispatchKey(chatId, threadId, update.update_id);
      await addPendingDispatch({
        updateId: update.update_id, chatId, threadId, messageId,
        userText: archivedUserText, startedAt: new Date().toISOString(),
        cwd: workdir.dir, session: topicState.session,
        ...(voiceTranscribed ? { userTextSettled: true } : {}),
        ...((update as any).__requeueCount !== undefined ? { requeueCount: (update as any).__requeueCount as number } : {}),
        ...((update as any).__batchFold ? { foldedFrom: (update as any).__batchFold.from } : {}),
      }).catch((err) => logger.warn('dispatch', 'failed to persist pending dispatch', { error: String(err) }));
      // Hardened plan WP6 item 5: resolved here (not at receipt) so a slow
      // archive scan never delays the crash-recovery record above, and so
      // skip-worker commands (the majority of reply-shaped traffic) never
      // pay for it at all.
      replyContext = await resolveReplyContext(msg, topicState).catch(() => undefined);
      if (!isDegraded()) await sendTyping(token, chatId, threadId);
      // Skip typing while DEGRADED (AI-096): under I/O starvation these calls
      // only queue more doomed work ahead of the reply send.
      const typingInterval = setInterval(() => { if (!isDegraded()) sendTyping(token, chatId, threadId).catch(() => {}); }, 4000);
      let latestFailoverPayload: FailoverNotifyPayload | undefined;
      const onNotify = async (payload: FailoverNotifyPayload) => {
        latestFailoverPayload = payload;
        const msg = formatFailoverMessage(payload);
        // Spec §3.2/WP-B1 edit 7: 🔁 Retry / ↔ Switch / ↩ Revert keyboard on the
        // failover notice, attached at the send site (buildWorkerErrorResponse /
        // formatFailoverMessage stay plain strings — spec correction 2).
        await sendMessageWithKeyboard(
          token,
          chatId,
          appendRefIdAndLog(msg, { kind: 'failover', chatId, threadId }),
          buildFailoverKeyboard({ next: payload.to ?? undefined, previous: payload.from }) as InlineKeyboardMarkup,
          messageId,
          threadId
        );
      };

      const editWindow: DispatchWindow | null = await openWindow({ resource: resourceId });
      try {
        // AI-203 increment 3: a plain message REPLYING to a thread FYI steers
        // that thread directly (tier-1 anchor — no orchestrator turn). Guard
        // order is load-bearing: (1) an armed pending_action outranks the
        // anchor (the reply is the confirmation turn) — read through the
        // pendingActionArmed snapshot taken before the confirmation consume;
        // (2) empty-text replies never steer (media-only replies keep today's
        // dispatch); (3) the thread must exist (checked inside the helper).
        // Not gated on orchestrator mode: a post-`/orchestrator off` topic may
        // still steer live threads. Batched uptake never hands this branch a
        // combined text — reply-shaped heads are gated out of the compile and
        // reply-shaped followers are withheld (E6).
        const anchorThreadId = pendingActionArmed || !userText.trim()
          ? null
          : resolveThreadFyiAnchor(msg);
        // WP-4 (§4.2): on a LIVE-steer routed turn the anchor was fed to the
        // router as in-flight context and its steer/wait decision applies —
        // the short-circuit is bypassed so the same anchor never fires twice.
        // Pinned/command turns (no steerWait) and anchors that never reached
        // the router (non-running thread, pending-action-armed, dark surface)
        // keep today's behaviour byte-for-byte.
        const routeSteeredAnchor = steerLive
          && routerTurn.steerWait !== undefined
          && anchorThreadId !== null
          && anchorThreadId === anchorThreadIdPre;
        const anchorAck = anchorThreadId && !routeSteeredAnchor
          ? await steerFromThreadAnchor(`${chatId}_${threadId}`, anchorThreadId, userText, topicState, {
              topicName: getTopicName(topicNames, chatId, threadId) ?? '',
              secrets, token, workdir: workdir.dir,
            })
          : undefined;
        // WP-5 (§3.2/E-list 3): on a routed turn under the placement surface
        // the persona branch is NOT taken — the router owns orchestration
        // there. `chain` is the routed marker: fail-open/pinned/command turns
        // return { worker } only, so they keep today's branch (flag-off
        // reversal; pins stay outranking off-flag).
        const routedTurn = routerTurn.chain !== undefined;
        const personaSkipped = personaBranchSkipped(placementLive, routedTurn);
        // WP-5 (§5, decision 25): on routed turns under an effective
        // deprecate-pins gate the session /model,/effort slice is bypassed
        // (buildRouterTurnDispatchState drops it from the per-turn view).
        const pinsDeprecatedTurnDispatch = deprecatePinsEffective(mrBlock) && routedTurn;
        // WP-5 integrator seam (rider b): the routed chain rides into the
        // dispatch cascade — candidateOrder ONLY on a live fallback surface
        // (runDispatchCascade re-applies the same gate, M2 dark-twin);
        // `routedTurn` is the marker `ignoreWorkerPin` gates on.
        const fallbackLive = mrBlock?.surfaces?.fallback === 'live';
        // Router-metadata (2026-09-20, decision 31): the turn-level provenance —
        // computed AFTER the steer and placement blocks (the facts they decided)
        // and fed into BOTH dispatch lanes. userText here is the possibly
        // steer-folded text; the optional facts fail open to absent.
        const operatorSteer = (update as any).__operatorSteer === true;
        // §1.2 steer: inflight steerWait stamps the ROUTER's word; an operator
        // /steer continuation (queue entry carried steerContext) stamps
        // 'steer' + 'operator' — the correction fact is true whoever decided.
        const steerFact: Pick<TurnRoutingMeta, 'steer' | 'steerBy'> =
          routerTurn.steerWait?.inflight && routerTurn.steerWait.decision
            ? { steer: routerTurn.steerWait.decision, steerBy: 'router' }
            : operatorSteer
              ? { steer: 'steer', steerBy: 'operator' }
              : {};
        const routingMeta: TurnRoutingMeta = {
          decision: deriveTurnRoutingDecision(userText, routerTurn),
          ...routingMetaFromOriginRouting(placementCarry?.originRouting),
          // A serving turn that answered direct/current under a LIVE placement
          // surface continued here; dark/shadow/fail-open stay absent (fail
          // open). The destination leg already stamped its word above.
          ...(!placementCarry?.originRouting && placementLive
            && (routerTurn.placement?.choice === 'direct' || routerTurn.placement?.choice === 'current')
            ? { placement: 'continued-here' as const }
            : {}),
          ...steerFact,
          ...((['applied', 'nearest', 'recategorize'] as const).includes(routerTurn.projectionOutcome as any)
            ? { effortProj: routerTurn.projectionOutcome as TurnRoutingMeta['effortProj'] }
            : {}),
        };
        const routingEnv = buildRoutingProvenanceEnv(routingMeta);
        const dr = anchorAck
          ?? (isOrchestratorMode(topicState) && !personaSkipped
            ? await dispatchOrchestratorTurn({
                userText, replyContext,
                pendingDesc: confirmedDescription ?? topicState.pending_action?.description,
                topicState, secrets, resourceId, chatId, threadId,
                defaultWorker: effectiveDefault, onNotify,
                updateId: update.update_id, workdir, contextId, topicNames,
                routingEnv,
              })
            : await dispatchMessage(userText, replyContext, confirmedDescription ?? topicState.pending_action?.description, buildRouterTurnDispatchState(topicState, effectiveDefault, routerTurn, pinsDeprecatedTurnDispatch), secrets, resourceId, effectiveDefault, topicNames, onNotify, update.update_id, workdir, contextId, fallbackLive ? routerTurn.chain : undefined, routedTurn, routingEnv));
        response = dr.response; topicState.session = dr.session;
        workerErrored = !!dr.workerError;
        // WP-D1 (A.3): carry the empty-output suggestion out of dispatchMessage's
        // scope — the reply-send cascade (outside this block) reads the module let.
        drSuggestedWorker = dr.suggestedWorker ?? null;
        // AI-234: carry sanitized suggested_items for the KB cascade below.
        suggestedItems = dr.meta?.suggested_items;
        // AI-151: capture the actual worker that handled this dispatch. The
        // anchor-ack path ran no worker — 'local' keeps the archived turn and
        // the closeWindow null sentinel truthful; it must win HERE, after the
        // fallback chain, not before it.
        assistantWorker = anchorAck
          ? 'local'
          : dr.dispatchedWorker || topicState.session?.worker || topicState.preferred_worker || effectiveDefault;
        // B9 rev 3 (a): HOIST stoppedKind consumption before applyMetaActions (V22)
        const topicKey = `${chatId}_${threadId}`;
        const stoppedKind = consumeTopicStopped(topicKey, update.update_id);

        // B9 rev 3 (b): Park decision BEFORE applyMetaActions (V22/V23)
        // 2026-09-12 self-heal gap fix (t-32): a FRESH dispatch (no __requeueCount
        // yet) seeds into the ladder at 0 when dr.rateLimitedWorker is set — i.e.
        // the cascade classified at least one attempt as rate-limited on its way to
        // total failure (the "all workers rate-limited at dispatch" case) — so it
        // gets the SAME auto-retry as an exhausted-crash-recovery continuation
        // instead of stopping dead at the manual-retry keyboard with no automatic
        // follow-up (voice-inbox's stuck-task sweep already self-heals the
        // analogous case; live-chat dispatch did not). Scoped to rate-limit
        // evidence, not every workerErrored: a non-rate-limit fresh failure (bad
        // config, broken worker script) keeps rqCount undefined — same as before —
        // so it still surfaces the immediate error/switch-keyboard reply the WP-D1
        // A.2/A.3 design deliberately gives the user on THOSE failure classes.
        const priorRqCount = (update as any).__requeueCount as number | undefined;
        const rqCount = priorRqCount ?? (dr.rateLimitedWorker ? 0 : undefined);
        const v = Number(process.env.PA_REQUEUE_MAX);
        const max = Number.isFinite(v) && v >= 0 ? v : 2; // PA_REQUEUE_* frozen in SPEC §2
        const parkedNow = rqCount !== undefined && workerErrored && !stoppedKind
          && rqCount < max && pendingKey !== undefined;
        if (parkedNow) {
          const b = Number(process.env.PA_REQUEUE_BACKOFF_MS);
          const backoffMs = Number.isFinite(b) && b >= 0 ? b : 900_000;
          (update as any).__ladderParked = true;
          await updatePendingDispatch(pendingKey!, { requeueNotBefore: Date.now() + backoffMs }).catch(() => {});
          logger.warn('requeue', 'requeued dispatch failed below cap — parked for retry',
            { chatId, threadId, updateId: update.update_id, requeueCount: rqCount, retryInMs: backoffMs });
          // V23: OUT-OF-BAND on purpose — riding the reply block would markDelivered the
          // key and silently dedup-skip the retry's real reply (lock_busy-notice pattern).
          await sendMessage(token, chatId,
            appendRefIdAndLog('⏳ Hit a temporary snag — retrying your message automatically.',
              { kind: 'requeue-deferred', chatId, threadId }),
            messageId, threadId).catch(() => {});
          response = '';
        }

        // B9 rev 3 (c): Skip post-dispatch work when parked
        if (!parkedNow) {
          const { response: processedResponse, skillToRun, restartBot: metaRestartBot, kbNote, watchJob } = applyMetaActions(response, dr.meta, topicState);
          response = processedResponse; restartBot = metaRestartBot;
          // AI-203 increment 4: the orchestrator's validated routing actions
          // (fan-out — N spawns + N steers per reply, envelope order) become
          // thread-store writes + executor fires here, so the reply that
          // promised them carries the frozen confirmation footers. ('routes'
          // in dr narrows the dispatch-result union — the human lane's
          // dispatchMessage result and the increment-3 anchor ack have no
          // routes field.)
          if ('routes' in dr && dr.routes.length > 0) {
            // §4.3 double-fire guard (WP-4): thread ids the router already
            // steered for THIS turn — a steer_thread for one of them is
            // dropped with the frozen footer. Read-and-clear, once per turn;
            // absent whenever no router steer fired, so the loop is untouched
            // otherwise.
            const routerSteered = takeRouterSteered(topicKey, update.update_id);
            for (const route of dr.routes) {
              if (route.kind === 'spawn') {
                // Ask-mirroring stamp (2026-09-11 spec §2c): voice-routed turns stamp
                // their vi- ids on the spawned thread so the thread executor can mirror
                // its asks into the voice-inbox app. Empty → undefined (not voice-routed).
                const spawnVoiceTaskIds = extractVoiceInboxTaskIds(userText);
                response += await handleSpawn({
                  topicKey, topicName: getTopicName(topicNames, chatId, threadId) ?? '',
                  spawn: route, secrets, token, workdir: workdir.dir,
                  ...(spawnVoiceTaskIds.length > 0 ? { voiceTaskIds: spawnVoiceTaskIds } : {}),
                  // Router-metadata (§1.2): the origin turn's provenance rides
                  // the record so the thread executor stamps PA_ROUTING_*.
                  routing: routingMeta,
                });
              } else if (routerSteered?.has(route.thread.id)) {
                response += STEER_ALREADY_ROUTED_FOOTER;
              } else {
                response += await handleSteer({
                  topicKey, topicName: getTopicName(topicNames, chatId, threadId) ?? '',
                  steer: route, secrets, token, workdir: workdir.dir,
                });
              }
            }
          }
          if (skillToRun) {
            // WB-304: error listener so a missing `pa` is never invisible.
            spawn('pa', ['run', skillToRun, '--worker', topicState.preferred_worker || effectiveDefault], { cwd: BOT_CWD, detached: true, stdio: 'ignore', shell: true, windowsHide: true })
              .on('error', (err) => logger.warn('main', `fire-and-forget spawn failed: ${(err as Error).message}`, { skill: skillToRun }))
              .unref();
          }
          if (kbNote) {
            // AI-101 Layer 2 — fire-and-forget: a KB-write hiccup must not block
            // or fail the reply that carried the note.
            appendKbNote(kbNote.domain, kbNote.note).catch(() => {});
          }
          if (watchJob) {
            // AWAITED on purpose — unlike appendKbNote's fire-and-forget, the registration
            // outcome must reach the reply this turn: a silent failure is exactly the empty
            // promise AI-170 exists to end (SPEC §1 C12, §5.3).
            try {
              const reg = await addWatchJob(watchJob);
              response += reg.ok
                ? `\n\n_(Watch registered: ${reg.watch.id} — I'll report here when it completes.)_`
                : `\n\n_(watch_job rejected: ${reg.error})_`;
            } catch (err) {
              response += `\n\n_(watch_job rejected: ${(err as Error).message})_`;
            }
          }
          if (dr.dispatchedWorker) await maybeUpdatePinnedStatusAfterDispatch(refreshPinnedStatusCardInPlace, token, chatId, threadId, topicState, effectiveDefault, dr.dispatchedWorker, latestFailoverPayload, config);

          // Enrich pending dispatch with teePath for crash recovery.
          // The teePath is deterministic from contextId (same formula
          // used by worker-exec.ts). This is a best-effort enrichment:
          // the worker-pids entry also carries it, but the entry may be
          // cleaned up by the worker's own done() callback before
          // the reaper reads it.
          if (pendingKey && contextId) {
            const inferredTeePath = join(paHome(), 'logs', 'worker-tee', `${contextId}.out`);
            await updatePendingDispatch(pendingKey, { teePath: inferredTeePath, workerName: dr.dispatchedWorker }).catch(() => {});
          }

          // StoppedKind handling (from rev 2, now inside !parkedNow)
          if (stoppedKind && workerErrored) {
            // A6: in-flight flush — when a stop/steer cancels a dispatch that
            // already started (locked topic, but never reached dispatchMessage),
            // the message's text becomes held context for the next dispatch.
            addHeldEntry(topicKey, { text: userText, updateId: update.update_id });
            logger.info('worker-stop', 'stopped dispatch text held for the next dispatch', { topicKey, chars: userText.length });
            response = stoppedKind === 'stop' ? '⏹ Stopped.' : '';
          }
        }
      } catch (dispatchErr) {
        logger.warn('dispatch', `dispatchMessage error: ${(dispatchErr as Error).message}`);
        response = '⚠️ Service temporarily unavailable.';
        workerErrored = true;

        // Pinned-worker failure hint (2026-08-17 zclaude incident): when the
        // effective worker is a pinned/explicit choice (preferred_worker or
        // topic_default) and this is a consecutive spawn-failed class error,
        // append a hint about switching workers. Rate-limited to after 2+
        // consecutive spawn failures for the same topic.
        const topicKey = `${chatId}_${threadId}`;
        const isPinnedWorker = !!topicState.preferred_worker || (!!effectiveDefault && effectiveDefault !== getEffectiveDefaultWorker(config, topicKey));
        // Detect spawn-failed class: timeout, ENOENT, or "not found" in error
        const errMsg = String((dispatchErr as Error).message).toLowerCase();
        const isSpawnFailed = errMsg.includes('timeout') || errMsg.includes('enoent') || errMsg.includes('not found') || errMsg.includes('spawn') || errMsg.includes('timed out');
        if (isPinnedWorker && isSpawnFailed) {
          const count = (topicSpawnFailureCount.get(topicKey) ?? 0) + 1;
          topicSpawnFailureCount.set(topicKey, count);
          if (count >= 2) {
            const pinnedName = topicState.preferred_worker || effectiveDefault;
            // WP-D1 (SPEC §3.4-D1 A.2): capture the alternate this hint proposes so the
            // reply's failover keyboard can offer wf:switch directly; the typed
            // /model <alt> advice stays in the text for the keyboard-less paths.
            suggestedAlt = await findNextAvailableWorker(pinnedName, effectiveDefault, topicState.preferred_worker, config);
            response += `\n\n💡 Pinned worker ${pinnedName} is failing — /model <alt> to switch or /default to reset.`;
            topicSpawnFailureCount.set(topicKey, 0); // reset after showing hint
          }
        }

        // B9 rev 3 (d): CATCH-PATH park
        // Unlike the try-path park above (t-32), a thrown dispatchMessage exception
        // (bad config, spawn/timeout errors — see isSpawnFailed just above) carries no
        // rate-limit signal and isn't the failure class the self-heal fix targets, so
        // a genuinely FRESH throw here keeps the pre-existing behavior: only an
        // already-in-ladder continuation (__requeueCount already set) auto-parks.
        const rqCountCatch = (update as any).__requeueCount as number | undefined;
        const vCatch = Number(process.env.PA_REQUEUE_MAX);
        const maxCatch = Number.isFinite(vCatch) && vCatch >= 0 ? vCatch : 2;
        const stoppedKindCatch = consumeTopicStopped(topicKey, update.update_id);
        const parkedCatch = rqCountCatch !== undefined && workerErrored && !stoppedKindCatch
          && rqCountCatch < maxCatch && pendingKey !== undefined;
        if (parkedCatch) {
          const bCatch = Number(process.env.PA_REQUEUE_BACKOFF_MS);
          const backoffMsCatch = Number.isFinite(bCatch) && bCatch >= 0 ? bCatch : 900_000;
          (update as any).__ladderParked = true;
          await updatePendingDispatch(pendingKey!, { requeueNotBefore: Date.now() + backoffMsCatch }).catch(() => {});
          logger.warn('requeue', 'requeued dispatch failed below cap (catch-path) — parked for retry',
            { chatId, threadId, updateId: update.update_id, requeueCount: rqCountCatch, retryInMs: backoffMsCatch });
          await sendMessage(token, chatId,
            appendRefIdAndLog('⏳ Hit a temporary snag — retrying your message automatically.',
              { kind: 'requeue-deferred', chatId, threadId }),
            messageId, threadId).catch(() => {});
          response = '';
        } else if (stoppedKindCatch) {
          addHeldEntry(topicKey, { text: userText, updateId: update.update_id });
          logger.warn('worker-stop', 'interrupted dispatch text held after thrown error', { topicKey, chars: userText.length });
          response = stoppedKindCatch === 'stop' ? '⏹ Stopped.' : '';
        }
      } finally { clearInterval(typingInterval); await closeWindow(editWindow, { worker: assistantWorker === 'local' ? null : assistantWorker, topic: { chatId, threadId } }).catch(() => {}); }
    }

    if (response.trim()) {
      const refId = makeRefId();
      // normalizeMarkdown wraps any markdown table in a ``` block before
      // sanitizeMdV2 escapes it — without this, sanitizeMdV2's step 3a escapes
      // every `|`/`-` individually and a table degrades to readable-but-ungridded
      // pipe text instead of a monospace block (same normalize-then-send order
      // task-executor.ts's completion FYI already uses).
      const textToSend = `${normalizeMarkdown(response.trim())}\n\n_Ref: ${refId}_`;
      runRulesCritic({ text: response.trim(), chatId, threadId, refId });
      // Effectively-once guard: if a reply for this update was already delivered
      // in a prior run (crash/restart before the poll offset persisted), skip it
      // rather than re-send a duplicate. See delivered-store.ts.
      // Bypass the persistent dedup under the test flag: integration tests reuse
      // update_ids across cases, so a cross-test delivered-key would wrongly skip
      // sends (the dlq/delivered-store units are tested directly elsewhere).
      const dedupOn = process.env.PA_NOTIFY_DISABLED !== '1';
      const idemKey = deliveredKey(chatId, threadId, update.update_id);
      if (dedupOn && await wasDelivered(idemKey)) {
        logger.warn('telegram', 'skipping reply for already-delivered update (dedup)', { updateId: update.update_id, chatId, threadId });
      } else {
        // Spec §3.2/WP-B1 edits 6+7: attach a keyboard to the reply when either (a) this
        // dispatch just (re)set pending_action and it has no anchor message_id yet — the
        // ✅/❌ confirm keyboard, whose press is what populates that message_id for the
        // 👍/👎 reaction path — or (b) the dispatch errored, in which case the failover
        // 🔁 Retry / ↩ Revert keyboard takes priority over the confirm keyboard.
        // Topic-task handover Wave 1 (SPEC §3.3, WP-F): (c) a freshly-armed
        // pending_question with no anchor yet renders its option buttons — priority
        // below confirm, so a question never displaces a confirm ask.
        // AI-234 (SPEC §3a): (d) sanitized suggested_items render as sr: chip buttons —
        // priority below question (chips never displace a confirm or a question ask;
        // on a confirm/question turn, suggested_items is still parsed and stored but
        // no keyboard is attached). Priority: workerErrored > confirm > question >
        // suggest > none.
        const wantsConfirm = !!topicState.pending_action && !topicState.pending_action.message_id;
        const wantsQuestion = !!topicState.pending_question && !topicState.pending_question.message_id;
        const wantsSuggest = !workerErrored && !wantsConfirm && !wantsQuestion
          && Array.isArray(suggestedItems) && suggestedItems.length > 0;
        // WP-D1 (A.2/A.3): the workerErrored keyboard now offers the switch the reply
        // text names — the empty-output suggestion (A.3) wins, else the pinned-worker
        // spawn-failure hint's alternate (A.2). Both are undefined-safe (the failover
        // notice at the onNotify send proves the shape).
        const kb = workerErrored
          ? buildFailoverKeyboard({ previous: assistantWorker, next: (drSuggestedWorker ?? suggestedAlt) ?? undefined })
          : wantsConfirm
          ? buildConfirmKeyboard()
          : wantsQuestion
          ? buildQuestionKeyboard(topicState.pending_question!.options)
          : wantsSuggest
          ? buildSuggestKeyboard(suggestedItems!)
          : undefined;
        // Ask mirroring (2026-09-11 spec §2d, voice-inbox button parity): a voice-routed
        // turn that armed a confirm/question also creates the matching typed widget in
        // the voice-inbox app (mirrorAskAsWidget → task_input.py create), so the ask is
        // answerable from either channel — Telegram-side answers cancel the mirrored
        // widget at the typed-answer blocks above and in callbacks.ts. The mirror runs
        // BEFORE the send and regardless of whether that send delivers or DLQs (the app
        // is the fallback channel); on ok the vi- id is stamped onto the pending ask and
        // persists via the existing saveTopicState. Best-effort: the helper is throw-free
        // by contract and the wrap is belt-and-braces — the send below can never break.
        if ((wantsConfirm || wantsQuestion) && !workerErrored) {
          const voiceTaskIds = extractVoiceInboxTaskIds(userText);
          if (voiceTaskIds.length > 0) {
            try {
              if (wantsConfirm) {
                const mirror = await mirrorAskAsWidget({
                  taskIds: voiceTaskIds,
                  kind: 'confirm',
                  prompt: capPromptForWidget(redactSecrets(topicState.pending_action!.description) as string),
                });
                if (mirror.ok) {
                  if (topicState.pending_action) topicState.pending_action.voice_task = mirror.taskId;
                } else {
                  logger.warn('voice-input-mirror', `confirm mirror failed: ${mirror.error}`, { chatId, threadId });
                }
              } else {
                const mirror = await mirrorAskAsWidget({
                  taskIds: voiceTaskIds,
                  kind: 'choice',
                  prompt: topicState.pending_question!.text,
                  options: topicState.pending_question!.options,
                });
                if (mirror.ok) {
                  if (topicState.pending_question) topicState.pending_question.voice_task = mirror.taskId;
                } else {
                  logger.warn('voice-input-mirror', `question mirror failed: ${mirror.error}`, { chatId, threadId });
                }
              }
            } catch (err) {
              logger.warn('voice-input-mirror', `ask mirror threw: ${(err as Error).message}`, { chatId, threadId });
            }
          }
        }
        const sent = await sendReplyText(token, chatId, textToSend, messageId, threadId, process.env, kb);
        if (sent.delivered) {
          if (dedupOn) await markDelivered(idemKey);
          // AI-151: use the actual worker name, not hardcoded 'worker'
          const assistantTurn: JoinableTurn = { role: 'assistant', text: response.trim(), timestamp: new Date().toISOString(), worker: assistantWorker, refId, session_id: topicState.session?.session_id, update_id: update.update_id };
          addTurn(topicState, assistantTurn);
          // The 👍/👎 reaction-approval path (handleMessageReaction) matches on this
          // field — a missed assignment here silently disables it with no other symptom.
          if (wantsConfirm && sent.messageId && topicState.pending_action) {
            topicState.pending_action.message_id = sent.messageId;
            // bp-fix: MessageReactionUpdated carries no thread id, so remember which
            // topic this confirm message belongs to for the reaction path to resolve.
            rememberConfirmMessage(chatId, sent.messageId, threadId);
          }
          // Handover Wave 1 (SPEC §3.3): anchor the question to the reply that
          // carried its buttons — mirrors pending_action above, but NO
          // rememberConfirmMessage (reactions are pending_action-only). Gated on
          // !workerErrored && !wantsConfirm: only set the anchor when the QUESTION
          // keyboard was the one the cascade actually attached — message_id's only
          // consumer is the wantsQuestion flip above, and anchoring a keyboard-less
          // (failover) or confirm-carrying reply would strand the question
          // unrendered until TTL. (Arm-time mutual exclusion keeps pending_action
          // and pending_question from coexisting in production; the !wantsConfirm
          // term keeps the anchor honest even for the artificial both-armed state.)
          // A failed audit line never breaks a delivered reply (q: handler precedent).
          if (wantsQuestion && !workerErrored && !wantsConfirm && sent.messageId && topicState.pending_question) {
            topicState.pending_question.message_id = sent.messageId;
            try {
              await appendTopicEvent(chatId, threadId, {
                kind: 'question_asked',
                ref: topicState.pending_question.task_id ?? null,
                detail: topicState.pending_question.text,
              });
            } catch (err) {
              logger.warn('telegram', `question_asked event failed: ${(err as Error).message}`, { chatId, threadId });
            }
          }
          // AI-234 (SPEC §3a): store the chips for sr:<idx> callback resolution.
          // Ephemeral — cleared at the top of the next turn (and on press, which
          // injects a synthetic turn that flows through the same clearing path).
          // Mirrors pending_question's anchoring: message_id ties the chips to
          // the reply that carried them (for future keyboard rewrite/strip).
          if (wantsSuggest && sent.messageId && suggestedItems) {
            topicState.pending_suggestions = { items: suggestedItems, message_id: sent.messageId };
          }
          // AI-218: capture the Telegram message_id of this FYI reply back into
          // the voice-inbox ledger's tasks.tg_message_id, so the app's deep link
          // can navigate straight to this message (/<messageId> suffix). Best-
          // effort and fire-and-forget: a lost capture loses a deep-link anchor,
          // never the delivered reply. Only the topic lane (the common one) —
          // the task lane's completion FYI is a separate path (task-executor.ts).
          if (sent.messageId) {
            const fyiTaskIds = extractVoiceInboxTaskIds(userText);
            if (fyiTaskIds.length > 0) {
              captureTaskMessageIds(fyiTaskIds, sent.messageId).catch((err) =>
                logger.warn('voice-message-id-capture', `capture threw: ${(err as Error).message}`, { chatId, threadId, messageId: sent.messageId })
              );
            }
          }
        } else {
          await appendDlq({ chatId, threadId, replyToMessageId: messageId, text: textToSend, timestamp: new Date().toISOString(), updateId: update.update_id, refId });
        }
      }
    }
    // Reply delivered, DLQ'd (itself persistent), or intentionally empty — the
    // in-flight record has served its purpose either way.
    if (pendingKey && !(update as any).__ladderParked) await removePendingDispatch(pendingKey).catch(() => {});
    await saveTopicState(topicState);
    if (restartBot) writeFileSync(join(paHome(), 'telegram-bot.stop'), '');
  } finally { lockRenewal.stop(); await blackboard.releaseLock(resourceId, 'telegram-bot', contextId); }
}

// Synthetic-message injection queue (2026-08-24 buttons program,
// plans/2026-08-24-buttons-program-SPEC.md §3.1). A button press that maps to a typed
// command pushes a synthetic TelegramUpdate here; drainInjectedUpdates() is called once
// per poll iteration, AFTER pollOffset/state.last_update_id are computed from the REAL
// getUpdates() batch (risk R1 — injecting before that computation would let a synthetic
// update_id, always far above any real one, poison the offset and silently confirm-away
// real pending Telegram updates).
const injectedUpdates: TelegramUpdate[] = [];
function injectUpdate(u: TelegramUpdate): void {
  injectedUpdates.push(u);
}
function drainInjectedUpdates(): TelegramUpdate[] {
  return injectedUpdates.splice(0);
}

// Route hand-off retry cap (2026-09-12 stale-route investigation,
// vi-508d4d7adbae/vi-be92df93d4ff): a route-queue line is already gone from
// ~/.pa/voice-inbox/route-queue.jsonl by the time drainVoiceInboxRoutes()
// calls injectUpdate() for it (consume-after-inject) — so if enqueueUpdateForDispatch
// then throws for that same update, re-injecting it via injectUpdate() (retried on
// the NEXT poll tick, seconds away) is the only remaining copy of the routing
// decision anywhere in the system. Capped so a genuinely poison update doesn't
// loop forever; the 20-minute voice-inbox-fallback stale-routed sweep is the
// last-resort net once this is exhausted, not the first one.
const ROUTE_INJECT_RETRY_LIMIT = 3;

/** Seamless-restart-recovery (2026-08-27 spec): inject the original request of an
 *  exhausted pending dispatch back into the poll loop as a synthetic update, so the
 *  FULL normal path (prompt build, failover, pin update, redaction, delivered-store,
 *  DLQ) handles it. REUSES the original update_id on purpose: delivered-store keys
 *  align, and the offset is computed from the real batch only (see drain above), so a
 *  re-used id can never confirm away real updates. Shape mirrors callbacks.ts's
 *  buildSyntheticUpdate; built here (not there) so this file carries no compile
 *  dependency on the callbacks via-union. `from` is inert on the dispatch path. */
export function requeueSyntheticUpdate(record: PendingDispatch): void {
  // Cast: WP-A owns the PendingDispatch.requeueCount field; this keeps main.ts
  // compilable even if that edit lands after this one.
  const requeueCount = (record as PendingDispatch & { requeueCount?: number }).requeueCount ?? 1;
  injectUpdate({
    update_id: record.updateId,
    message: {
      message_id: record.messageId,
      from: { id: 0, first_name: 'PA recovery' },
      chat: { id: record.chatId, type: record.threadId ? 'supergroup' : 'private' },
      date: Math.floor(Date.now() / 1000),
      text: record.userText,
      ...(record.threadId ? { message_thread_id: record.threadId } : {}),
    },
    __synthetic: 'requeue',
    __requeueCount: requeueCount,
  } as TelegramUpdate);
  logger.info('requeue', 'injected synthetic update for exhausted dispatch',
    { updateId: record.updateId, chatId: record.chatId, threadId: record.threadId, requeueCount });
}

/** AI-181 (plans/2026-09-01-ai181-reauth-resume-SPEC.md §2.4): inject the
 * topic_resume prompt into its ORIGINATING chat/thread as a system-
 * originated, dispatchable turn. Reuses the buttons-program injection queue
 * (injectUpdate above) so the turn flows through the FULL normal pipeline —
 * per-topic serialization, enqueue-time placeholder, prompt build with topic
 * context and conversation history, worker dispatch, write-action
 * confirm-gates, _Ref trailer, delivered-store, DLQ — exactly like a user
 * message. Built here (not via callbacks.ts's buildSyntheticUpdate) for the
 * same reason requeueSyntheticUpdate is: no compile dependency on the
 * callbacks via-union, and `from` is inert on the dispatch path.
 * `__synthetic: 'system_resume'` skips the 👍 receipt reaction (the guard
 * above) and is recorded as the turn's `via` in conversation history — the
 * provenance marker. The prompt was validated (closed shape, <=500 chars,
 * single line) at BOTH mint time (start_google_telegram_reauth.py) and fire
 * time (the /auth branch) before this is called. messageId stays 0: there is
 * no user message to anchor, and sendMessage's truthy replyTo check makes 0
 * a no-anchor. AI-173 phase 4 note: this function feeds the existing
 * injection-queue contract; extracting the enqueue normalizer does not move
 * it. */
export function injectSystemResumeUpdate(
  args: { chatId: number; threadId: number; prompt: string },
  injectFn: (u: TelegramUpdate) => void = injectUpdate
): number {
  return injectSystemSyntheticTurn(args, {
    prefix: '[System: auto-resumed after Google auth]',
    synthetic: 'system_resume',
    logComponent: 'system-resume',
    logMessage: 'injected topic_resume turn after Google auth',
  }, injectFn);
}

/** Shared core behind injectSystemResumeUpdate (AI-181) and
 * injectSystemReminderUpdate (AI-185): builds a system-originated synthetic
 * message and pushes it through injectUpdate so the turn flows through the
 * FULL normal pipeline — per-topic serialization, enqueue-time placeholder,
 * prompt build with topic context and conversation history, worker dispatch,
 * write-action confirm-gates, _Ref trailer, delivered-store, DLQ — exactly
 * like a user message. messageId stays 0: there is no user message to anchor,
 * and sendMessage's truthy replyTo check makes 0 a no-anchor. The
 * `__synthetic` tag skips the 👍 receipt reaction and is recorded as the
 * turn's `via` in conversation history — the provenance marker. */
function injectSystemSyntheticTurn(
  args: { chatId: number; threadId: number; prompt: string },
  opts: { prefix: string; synthetic: string; logComponent: string; logMessage: string },
  injectFn: (u: TelegramUpdate) => void
): number {
  const text = `${opts.prefix} ${args.prompt}`;
  const updateId = nextSyntheticUpdateId();
  injectFn({
    update_id: updateId,
    message: {
      message_id: 0,
      from: { id: 0, first_name: 'PA system' },
      chat: { id: args.chatId, type: args.threadId ? 'supergroup' : 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
      ...(args.threadId ? { message_thread_id: args.threadId } : {}),
    },
    __synthetic: opts.synthetic,
  } as TelegramUpdate);
  logger.info(opts.logComponent, opts.logMessage, {
    chatId: args.chatId, threadId: args.threadId, updateId,
  });
  return updateId;
}

/** AI-185 (plans/2026-09-02-ai185-executable-reminder-dispatch-SPEC.md §3.4):
 * sibling of injectSystemResumeUpdate — injects a queued executable
 * reminder's prompt as a system turn. Same core, different label + tag:
 * `__synthetic: 'system_reminder'` and a `[System: reminder-triggered
 * (queued <HH:MM IST>)]` prefix carrying the record's queued_at, so the
 * worker sees staleness when a record drained after bot downtime.
 * `queuedAtIst` is the bare 24-h HH:MM IST clock time (no suffix — the IST
 * label is added here, inside the parens, per SPEC §3.4's exact text). The
 * prompt was validated (closed shape, <=500 chars, single line) at BOTH mint
 * time (add_reminder.py) and fire time (drainDueReminderResumes below)
 * before this is called. */
export function injectSystemReminderUpdate(
  args: { chatId: number; threadId: number; prompt: string; queuedAtIst: string },
  injectFn: (u: TelegramUpdate) => void = injectUpdate
): number {
  return injectSystemSyntheticTurn(
    { chatId: args.chatId, threadId: args.threadId, prompt: args.prompt },
    {
      prefix: `[System: reminder-triggered (queued ${args.queuedAtIst} IST)]`,
      synthetic: 'system_reminder',
      logComponent: 'system-reminder',
      logMessage: 'injected reminder_resume turn',
    },
    injectFn
  );
}

// ---------------------------------------------------------------------------
// Router-metadata provenance (2026-09-20, decision 31) — the dispatch site's
// pure derivations, exported headless for routing-provenance.test.ts.
// ---------------------------------------------------------------------------

/** Ledger conversation id shape (§1.1): the ONLY string PA_ROUTING_TARGET may
 *  carry. Anything else fails open to absent — a topic name or turn text must
 *  never ride the metadata. */
const ROUTING_TARGET_RE = /^vi-[0-9a-f]{12}$/;

/** Destination-leg meta from the extended placement carry (§1.2): the part's
 *  kind maps to the placement vocabulary word; the ORIGIN's ledger conversation
 *  id rides `target` only when it matches the id shape (a plain Telegram origin
 *  carries none — a `diverted` line renders without a link downstream). */
export function routingMetaFromOriginRouting(
  originRouting: PlacementCarry['originRouting'],
): Pick<TurnRoutingMeta, 'placement' | 'target'> {
  if (!originRouting) return {};
  const placement = originRouting.kind === 'move'
    ? 'diverted'
    : originRouting.kind === 'create'
      ? 'new-conversation'
      : 'split';
  const target = originRouting.originConversationId !== undefined
    && ROUTING_TARGET_RE.test(originRouting.originConversationId)
    ? originRouting.originConversationId
    : undefined;
  return { placement, ...(target !== undefined ? { target } : {}) };
}

/** Turn-level decision derivation (spec WP-2 item 2): a command turn is the
 *  operator's instruction; a routed turn (chain present) or a turn that carried
 *  a placement answer is the router's; everything else is the ladder. */
export function deriveTurnRoutingDecision(
  userText: string,
  routerTurn: TurnRoutingResult,
): TurnRoutingMeta['decision'] {
  if (isCommandTurn(userText)) return 'command';
  if (routerTurn.chain !== undefined || routerTurn.placement !== undefined) return 'router';
  return 'ladder';
}

/** WP-5 (§3.2): inject a placed turn into its DESTINATION topic as a
 *  system-originated synthetic — the same injection seam the route drain uses
 *  (injectFn + nextSyntheticUpdateId; voice-inbox-bridge precedent). The turn
 *  carries `__synthetic: 'placement'` (placeOnce: the destination pipeline
 *  skips placement) and the carried payload `__placementCarry` (needs/chain —
 *  I-3 routing reuse, no second TypeSafe ask). A split part's focus directive
 *  rides as a labeled block prepended to the whole message. messageId stays 0:
 *  there is no user message to anchor. The destination's normal pipeline
 *  dispatches it; its worker resolves via resolveDestinationPlacementRouting
 *  (§3.3). */
export function injectPlacementTurn(
  args: { chatId: number; threadId: number; userText: string; directive?: string; carry: PlacementCarry },
  injectFn: (u: TelegramUpdate) => void = injectUpdate,
  nextId: () => number = nextSyntheticUpdateId,
): number {
  const text = args.directive
    ? `[Placement focus] ${args.directive}\n\n${args.userText}`
    : args.userText;
  const updateId = nextId();
  injectFn({
    update_id: updateId,
    message: {
      message_id: 0,
      from: { id: 0, first_name: 'PA system' },
      chat: { id: args.chatId, type: args.threadId ? 'supergroup' : 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
      ...(args.threadId ? { message_thread_id: args.threadId } : {}),
    },
    __synthetic: 'placement',
    __placementCarry: args.carry,
  } as TelegramUpdate);
  logger.info('placement', 'injected placed turn into destination topic', {
    chatId: args.chatId, threadId: args.threadId, updateId,
    carried: {
      chain: args.carry.chain?.length ?? 0,
      hasNeeds: args.carry.tier !== undefined && args.carry.score !== undefined,
    },
  });
  return updateId;
}

/** WP-C C2: the maintenance drain. Re-injects parked ladder records whose
 *  requeueNotBefore has passed: increments requeueCount (persisted BEFORE the
 *  injection — a crash in between leaves an un-parked capped-or-not record the
 *  next reaper settles, never a silent loss), clears the park, and injects the
 *  same synthetic as the original requeue. Returns the number injected. */
export async function drainDueRequeues(): Promise<number> {
  const records = await listPendingDispatches();
  const v = Number(process.env.PA_REQUEUE_MAX);
  const max = Number.isFinite(v) && v >= 0 ? v : 2; // PA_REQUEUE_* frozen in SPEC §2
  let injected = 0;
  for (const record of records) {
    const parked = (record as PendingDispatch & { requeueNotBefore?: number }).requeueNotBefore;
    const count = (record as PendingDispatch & { requeueCount?: number }).requeueCount ?? 0;
    if (parked === undefined) continue;
    // /stop during the backoff window cancels the deferred record (addendum round 2):
    // a stop's marker updateId is newer than the record's, so isTopicStopped matches
    // here. Checked BEFORE the due-check so a cancelled record never lingers to its
    // due tick. isTopicStopped is already imported in main.ts (:132).
    if (isTopicStopped(`${record.chatId}_${record.threadId}`, record.updateId)) {
      await removePendingDispatch(
        pendingDispatchKey(record.chatId, record.threadId, record.updateId)).catch(() => {});
      logger.info('requeue', 'parked record cancelled by /stop — removed', { updateId: record.updateId });
      continue;
    }
    if (Date.now() < parked) continue;
    if (count >= max) {
      // Unreachable by construction (suppression parks only below cap; the drain
      // increments before injecting) — defensive only; the 24h TTL clears it.
      logger.warn('requeue', 'parked record at cap with a due notBefore — no path claims it, TTL will clear', { updateId: record.updateId });
      continue;
    }
    const next = count + 1;
    await updatePendingDispatch(
      pendingDispatchKey(record.chatId, record.threadId, record.updateId),
      { requeueCount: next, requeueNotBefore: undefined },
    ).catch(() => {});
    requeueSyntheticUpdate({ ...record, requeueCount: next });
    injected++;
  }
  return injected;
}

const execFileAsync = promisify(execFile);
const CREATE_CONVERSATION_TASK_TIMEOUT_MS = 30_000;

/** AI-conversation-context reminder fix (2026-09-12): fires a voice_inbox_resume
 *  by shelling out to create_conversation_task.py, the same "never hand-build a
 *  ledger write" discipline pa/src/lib/maintenance/jobs/voice-inbox-fallback.ts
 *  uses for its own replays. Fail-open: any spawn/parse/non-zero-exit failure is
 *  logged and swallowed — a lost resume must never crash the drain (the record
 *  was already popped, so this is a best-effort delivery like every other path
 *  here). Env override mirrors spawnReauthLink's PA_OAUTH_START_SCRIPT. */
/** The script's contract is "one JSON line on stdout either way" — an
 *  ok:false result still exits 1 (so a caller shelling out sees failure from
 *  the exit code alone), which makes execFile REJECT the promise even though
 *  real, parseable JSON rode on stdout. Empty/missing/unparseable stdout
 *  (ENOENT, a crash before any print) returns undefined, the signal that this
 *  was a genuine execution failure rather than a reported one. */
function tryParseScriptResult(stdout: string): any {
  const line = stdout.trim().split('\n').pop();
  if (!line) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

async function resumeVoiceInboxConversation(
  conversationId: string,
  prompt: string,
  runner: typeof execFileAsync = execFileAsync
): Promise<boolean> {
  const script = process.env.PA_VOICE_INBOX_RESUME_SCRIPT ||
    join(BOT_CWD, 'projects', 'voice-inbox', 'scripts', 'create_conversation_task.py');
  let result: any;
  try {
    const { stdout } = await runner(
      resolvePythonCommand(process.env),
      [script, '--conversation-id', conversationId, '--text', prompt],
      { cwd: BOT_CWD, timeout: CREATE_CONVERSATION_TASK_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }
    );
    result = tryParseScriptResult(stdout);
  } catch (err) {
    // voice-inbox-fallback.ts's runScript precedent: never trust the exit
    // code alone when the script's own JSON line is the real contract.
    const errStdout = typeof (err as any)?.stdout === 'string' ? (err as any).stdout : '';
    result = tryParseScriptResult(errStdout);
    if (result === undefined) {
      logger.warn('reminder-resume', 'voice_inbox_resume script failed', {
        conversationId, error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
  if (!result || result.ok !== true || typeof result.task_id !== 'string') {
    logger.warn('reminder-resume', 'voice_inbox_resume script reported failure', { conversationId, result });
    return false;
  }
  logger.info('reminder-resume', 'injected voice_inbox_resume turn', {
    conversationId, taskId: result.task_id, routedTo: result.routed_to ?? null,
  });
  return true;
}

/** One record in PA_HOME/pending-reminder-resume.json, queued by
 * process_reminders.py at fire time (AI-185 SPEC §3.2). chat_id/thread_id
 * are JSON round-trips of the reminder's stored values, so they arrive as
 * unknown and are coerced here (Number(), thread 0 = no-thread sentinel). */
export interface PendingReminderResumeRecord {
  id?: string;
  queued_at?: string;
  chat_id?: unknown;
  thread_id?: unknown;
  resume_action?: OAuthResumeAction;
}

/** AI-185 (SPEC §3.3): the reminder-resume-drain maintenance job's run fn.
 * Pops each record off PA_HOME/pending-reminder-resume.json and injects it
 * as a system-originated, dispatchable turn (injectSystemReminderUpdate).
 * POP-FIRST: the remaining records are written back BEFORE the injection
 * (persist-before-injection, requeue-drain precedent) — at-most-once, crash
 * window is milliseconds. An absent/empty/invalid queue file is a no-op
 * (returns 0). validateTopicResumeAction and the allowedChatIds guard both
 * reject-and-drop with a WARN — never crash the job (/auth branch
 * precedent). NO age-based dropping: stale records (bot was down) drain on
 * restart; the injected label carries the queued time so the worker sees
 * staleness. Lossless. */
export async function drainDueReminderResumes(
  allowedChatIds: ReadonlySet<number>,
  injectFn?: (u: TelegramUpdate) => void
): Promise<number> {
  const queuePath = join(paHome(), 'pending-reminder-resume.json');
  let records: PendingReminderResumeRecord[];
  try {
    const parsed = JSON.parse(await readFile(queuePath, 'utf8'));
    records = Array.isArray(parsed) ? (parsed as PendingReminderResumeRecord[]) : [];
  } catch {
    return 0; // absent or invalid queue file — nothing to drain
  }
  let injected = 0;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const threadId = Number(record.thread_id ?? 0);
    // POP-FIRST: persist the remaining records BEFORE injecting (at-most-once).
    await writeFileAtomic(queuePath, JSON.stringify(records.slice(i + 1), null, 2));
    logger.info('reminder-resume', 'popped record for injection', { id: record.id, chatId: record.chat_id, threadId: threadId || null });
    // AI-conversation-context reminder fix (2026-09-12): a voice_inbox_resume
    // record targets a conversation_id, not a chat/topic — branch on the
    // declared type BEFORE the chat_id/allowedChatIds gate below, which only
    // applies to topic_resume's delivery target.
    if (record.resume_action?.type === 'voice_inbox_resume') {
      const voiceInboxCheck = validateVoiceInboxResumeAction(record.resume_action);
      if (!voiceInboxCheck.ok) {
        logger.warn('reminder-resume', `reminder_resume rejected at fire time: ${voiceInboxCheck.error}`, { id: record.id });
        continue;
      }
      const resumed = await resumeVoiceInboxConversation(voiceInboxCheck.conversationId, voiceInboxCheck.prompt);
      if (resumed) injected++;
      continue;
    }
    const check = validateTopicResumeAction(record.resume_action);
    if (!check.ok) {
      logger.warn('reminder-resume', `reminder_resume rejected at fire time: ${check.error}`, { id: record.id });
      continue;
    }
    const chatId = Number(record.chat_id);
    if (!record.chat_id || !Number.isFinite(chatId)) {
      logger.warn('reminder-resume', 'reminder_resume rejected: record carries no chat_id', { id: record.id });
      continue;
    }
    if (!allowedChatIds.has(chatId)) {
      logger.warn('reminder-resume', `reminder_resume rejected: target chat ${chatId} is not an allowed chat`, { id: record.id });
      continue;
    }
    const queuedMs = Date.parse(String(record.queued_at ?? ''));
    const queuedAtIst = formatIST(new Date(Number.isFinite(queuedMs) ? queuedMs : Date.now())).slice(11, 16);
    injectSystemReminderUpdate({ chatId, threadId, prompt: check.prompt, queuedAtIst }, injectFn);
    injected++;
  }
  return injected;
}

/** Best-effort pinned-card refresh after a task terminal state (SPEC §3.1 status-card
 *  bullet): the Tasks line counts change when a task completes/fails/defers/parks.
 *  Loads topic state fresh and deliberately does NOT saveTopicState — the poll loop's
 *  own saves own the state file; a lost pinned_status_message_id update just means the
 *  card is replaced again on the next refresh. */
async function refreshTaskCardFor(token: string, chatId: number, threadId: number): Promise<void> {
  try {
    const config = await loadConfig().catch(() => ({ workers: [] as WorkerConfig[] }));
    const state = await loadTopicState(chatId, threadId);
    await refreshPinnedStatusCardInPlace(
      token,
      chatId,
      threadId,
      state,
      getEffectiveDefaultWorker(config, topicKeyFor(chatId, threadId)),
      config
    );
  } catch (err) {
    logger.warn('topic-task', `card refresh failed: ${(err as Error).message}`, { chatId, threadId: threadId || null });
  }
}

/** FYI sender seam for the drain — `(chatId, threadId, text, refKind, keyboard?)`.
 *  Default impl is the real sendMessageWithId send with the ref-id footer. */
type TopicTaskFyiSender = (
  chatId: number,
  threadId: number,
  text: string,
  kind: Parameters<TaskFyiSender>[1],
  keyboard?: Parameters<TaskFyiSender>[2]
) => Promise<number | null>;

export interface TopicTaskDrainOpts {
  token?: string;
  secrets?: Record<string, string>;
  topicNames?: TopicNameMap;
  /** Test seams — default impls are the real FYI send and the real executor. */
  sendFyi?: TopicTaskFyiSender;
  execute?: (args: ExecuteTopicTaskArgs) => Promise<void>;
}

/** Topic-task handover Wave 2 (SPEC §3.1 A.3): the topic-task-drain maintenance
 *  job's run fn — REWRITTEN from Wave 1's inject-a-system-turn body into the
 *  executor lane. Task dispatches NEVER take the topic blackboard lock and NEVER
 *  touch state.turns; the running store is the sole authority.
 *
 *  Enumerates queue AND running-store files under PA_HOME/topic-tasks/
 *  (`<chatId>_<threadId>.json` / `.running.json`); per topic, in order:
 *  (1) stale-demotion of every >TOPIC_TASK_STALE_MS `running` record (crash
 *  recovery — runs for EVERY enumerated topic, not only the ones this tick
 *  claims, pre-adjudicated 2026-09-02); (2) up to the GLOBAL TOPIC_TASK_TICK_CAP:
 *  claimNextTask → pickup FYI → fire-and-forget executeTopicTask (tracked in
 *  activeTaskExecutions, never awaited on the tick). Claim-first semantics live
 *  inside claimNextTask (queue+running persist atomically under one lock BEFORE
 *  anything is dispatched — at-most-once, same crash window as Wave 1).
 *  task_started (fresh claim) / task_resumed (promoted ready record — attempts>1)
 *  events; invalid prompts are WARN + failTask (the record must not linger
 *  holding a slot); foreign chats are skipped BEFORE claiming (records stay
 *  queued, never consumed). Absent store dir → 0; unreadable stores WARN + skip. */
export async function drainDueTopicTasks(
  allowedChatIds: ReadonlySet<number>,
  opts: TopicTaskDrainOpts = {}
): Promise<number> {
  let entries: string[];
  try {
    entries = readdirSync(join(paHome(), 'topic-tasks'));
  } catch {
    return 0; // absent store — nothing queued anywhere
  }
  const topics = new Set<string>();
  for (const entry of entries) {
    const m = /^(-?\d+)_(\d+)\.json$/.exec(entry) ?? /^(-?\d+)_(\d+)\.running\.json$/.exec(entry);
    if (!m) continue;
    topics.add(`${m[1]}_${m[2]}`);
  }

  const token = opts.token;
  const secrets = opts.secrets ?? {};
  const topicNames = opts.topicNames ?? new Map();
  const sendFyi: TopicTaskFyiSender = opts.sendFyi ?? ((chatId, threadId, text, kind, keyboard) =>
    token === undefined
      ? Promise.resolve(null)
      : sendMessageWithId(token, chatId, appendRefIdAndLog(text, { kind, chatId, threadId }), threadId || undefined, keyboard));

  let claimedTotal = 0;
  for (const topicKey of topics) {
    const [chatId, threadId] = topicKey.split('_').map(Number);
    try {
      // (1) Stale-demotion FIRST, for EVERY enumerated topic (2026-09-02
      // adjudication): the global tick cap must not starve a topic that wins no
      // claim this tick, or its crashed dispatch would sit `running` forever.
      await demoteStaleRunningTasks(chatId, threadId);
      if (!allowedChatIds.has(chatId)) {
        // Foreign chat: never claim/consume — but only warn when something is
        // actually parked there, so an empty stray file cannot warn every tick.
        const pending = await listRunningTasks(chatId, threadId);
        if (pending.length > 0 || (await listTasks(chatId, threadId)).length > 0) {
          logger.warn('topic-task', `topic_task rejected: target chat ${chatId} is not an allowed chat`, { chatId, threadId: threadId || null });
        }
        continue;
      }
      while (claimedTotal < TOPIC_TASK_TICK_CAP) {
        const task: RunningTask | null = await claimNextTask(chatId, threadId);
        if (!task) break;
        const check = validateTaskPrompt(task.prompt);
        if (!check.ok) {
          logger.warn('topic-task', `topic_task rejected at drain time: ${check.error}`, { id: task.id, chatId });
          await failTask(chatId, threadId, task.id, `invalid-prompt: ${check.error}`);
          continue;
        }
        claimedTotal += 1;
        const resumed = task.attempts > 1;
        logger.info('topic-task', resumed ? 'resumed task for execution' : 'claimed task for execution', { id: task.id, chatId, threadId: threadId || null, attempt: task.attempts });
        try {
          await appendTopicEvent(chatId, threadId, {
            kind: resumed ? 'task_resumed' : 'task_started',
            ref: task.id,
            detail: task.title,
          });
        } catch (err) {
          // The claim is the load-bearing effect; a failed audit line must not
          // uncount it (Wave-1 precedent).
          logger.warn('topic-task', `task_${resumed ? 'resumed' : 'started'} event failed: ${(err as Error).message}`, { id: task.id, chatId });
        }
        // Pickup FYI (exact, A.3): `📌 Picked up: <title>` + queue-depth line; its
        // message id becomes a tier-1 reply anchor. Retry/failed FYIs are NOT
        // recorded — the frozen anchor set is pickup/completion/question only.
        const queuedCount = (await listTasks(chatId, threadId)).filter((t) => t.kind === 'task').length;
        const messageId = await sendFyi(
          chatId,
          threadId,
          `📌 Picked up: ${task.title}${queuedCount > 0 ? ` (+${queuedCount} queued)` : ''}`,
          'task-pickup'
        ).catch(() => null);
        if (messageId !== null) {
          await recordFyiMessage(chatId, threadId, task.id, messageId).catch((err) => {
            logger.warn('topic-task', `recordFyiMessage failed: ${(err as Error).message}`, { id: task.id, chatId });
          });
        }
        // (2) Fire-and-forget dispatch: the tick returns immediately. The pinned-card
        // refresh rides the executor's refreshCard seam (ONE call per terminal state
        // inside executeTopicTask); task workdir is the topic home (stateless,
        // topic-scoped — resolveTopicWorkdir needs ConversationState, which task
        // turns must never read).
        const workdir = { dir: topicHomeDir(chatId, threadId) };
        await mkdir(workdir.dir, { recursive: true }).catch(() => {});
        const execArgs: ExecuteTopicTaskArgs = {
          task,
          topicCtx: {
            chatId,
            threadId,
            topicName: getTopicName(topicNames, chatId, threadId) ?? `${chatId}_${threadId}`,
          },
          secrets,
          token: token ?? '',
          workdir,
          sendFyi: (text, kind, keyboard) => sendFyi(chatId, threadId, text, kind, keyboard),
          refreshCard: token === undefined ? undefined : () => refreshTaskCardFor(token, chatId, threadId),
        };
        const exec = (opts.execute ? opts.execute(execArgs) : executeTopicTask(execArgs)).catch((err) => {
          logger.warn('topic-task', `task execution failed: ${(err as Error).message}`, { id: task.id, chatId });
        });
        activeTaskExecutions.add(exec);
        void exec.finally(() => activeTaskExecutions.delete(exec));
      }
    } catch (err) {
      // Corrupt/unreadable stores — WARN + skip, never crash the job (R6).
      logger.warn('topic-task', `topic task stores unreadable — skipped: ${(err as Error).message}`, { chatId, threadId: threadId || null });
      continue;
    }
  }
  return claimedTotal;
}

function getUpdateTopicKey(update: any): string {
  const chatId = update.message?.chat?.id;
  const threadId = update.message?.message_thread_id ?? 0;
  return chatId ? `${chatId}_${threadId}` : 'non-message';
}

// Injectable exit hook for runPollLoop's end-of-loop process.exit(0) (see the
// comment at that call site). Root cause of the 2026-08-28/31 "bot dark test
// files" defect (poll-loop / integration / poll-loop-integration-extra /
// poll-loop-maintenance / voice-poll-loop, fixed 2026-09-01): `node --test`
// isolates each test file into its own subprocess, and any test that awaits
// runPollLoop() to completion (dozens of them, across all five files) drove
// the loop to its natural exit and hit the real process.exit(0) — killing
// that file's subprocess before node:test's own TAP output for it reached the
// parent, so the file read back as an empty shell with zero suites. This was
// misdiagnosed for months as a `node:test` registration bug (see historical
// note in scripts/run-tests.mjs). Production behavior is unchanged (default
// is real process.exit); tests inject a no-op via `_setExitForTest` so
// runPollLoop's promise resolves normally instead of taking the subprocess
// down with it.
const defaultExitFn = (code?: number) => process.exit(code);
let exitFn: (code?: number) => void = defaultExitFn;

/** Test hook: replace runPollLoop's terminal process.exit with a no-op (or a spy). Pass null to restore the real exit. */
export function _setExitForTest(fn: ((code?: number) => void) | null): void {
  exitFn = fn ?? defaultExitFn;
}

export async function runPollLoop(
  token: string,
  chatIds: number[],
  state: any,
  secrets: any,
  signal: AbortSignal,
  sleepFn: any = (ms: number) => new Promise(r => setTimeout(r, ms)),
  sentinelPath?: string,
  topicNames: TopicNameMap = new Map(),
  branchIndex: BranchIndex = new Map()
): Promise<void> {
  const allowedChatIds = new Set(chatIds);
  let pollOffset = state.last_update_id;
  const inFlight = new Set<Promise<void>>();
  const topicPending = new Map<string, Promise<void>>();
  let consecutiveErrors = 0; // drives escalating getUpdates backoff (capped at MAX_BACKOFF_MS)

  // Declared bot-host maintenance (AI-100 Wave 2). Replaces the four hand-rolled
  // next*At timers that used to live in this loop — DLQ flush, delivered-store
  // compaction, model-override sweep, bot-log rotation check — plus the session
  // GC tick, which is gone entirely (it is the pa-host `session-gc` job now).
  // Cadences, retention targets and shed policy: ./maintenance-jobs.ts.
  const botJobs = createBotMaintenanceJobs({
    token,
    chatIds,
    sentinelPath,
    runModelSweep: runExpiredModelOverrideSweep,
    topicNames,
    requeueDrain: drainDueRequeues,
    // AI-185: allowedChatIds is local to runPollLoop, so the drain takes it
    // here rather than reaching config again (mirrors the /auth branch guard).
    reminderResumeDrain: () => drainDueReminderResumes(allowedChatIds),
    // Topic-task handover Wave 2 (SPEC §3.1 A.3): same shape — allowedChatIds is
    // local to runPollLoop, so the topic-task drain takes it here too, plus the
    // token/secrets/topicNames the executor lane needs for its FYI sends and prompts.
    topicTaskDrain: () => drainDueTopicTasks(allowedChatIds, { token, secrets, topicNames }),
    // Self-restart busy check (2026-09-16 incident): a turn picked up by this
    // loop is added to `inFlight` before classification and removed only in
    // its .finally() on settle — the exact window listPendingDispatches()/
    // topicLocksHeld miss between classification and dispatch registration.
    // The Set also holds the callback/reaction handlers and the detached /stop
    // and steer-fold recovery blocks for their whole lifetimes (2026-09-17).
    pollLoopInFlight: () => inFlight.size,
  });
  // TypeSafe typed routing (2026-09-17): the route drain's gate for inbox
  // entries. gate() is synchronous and never throws; attempts run
  // fire-and-forget with a hard deadline (pa voice-inbox-typed-route-drain.ts).
  // Inert unless voice_inbox_routing.enabled and TYPESAFE_API_KEY are set.
  const voiceTypedRouteDrain = createVoiceInboxTypedRouteDrain();
  // Voice-inbox route drain (AI-201): registered beside the maintenance drains
  // above but invoked once per poll tick below — the route queue promises
  // one-poll-tick latency, not the queue-drain family's per-source cadence.
  // WP-5: the thread lane is wired HERE, at the composition root, because
  // voice-inbox-bridge.ts cannot import it (that edge closes a cycle through
  // logic.ts). topicNameFromKey mirrors threadQueueDrain's closure below.
  const routeQueueDrain = () => drainVoiceInboxRoutes({
    injectFn: injectUpdate,
    nextId: nextSyntheticUpdateId,
    steerFn: (entry) => steerIntoWork(entry, {
      secrets,
      token,
      topicNameFromKey: (key) => {
        const i = key.lastIndexOf('_');
        return i > 0 ? getTopicName(topicNames, Number(key.slice(0, i)), Number(key.slice(i + 1))) ?? '' : '';
      },
      injectFn: (chatId, threadId, text) => injectUpdate({
        update_id: nextSyntheticUpdateId(),
        message: {
          message_id: 0,
          from: { id: 0, first_name: 'PA system' },
          chat: { id: chatId, type: threadId ? 'supergroup' : 'private' },
          date: Math.floor(Date.now() / 1000),
          text,
          ...(threadId ? { message_thread_id: threadId } : {}),
        },
        __synthetic: 'route',
      } as TelegramUpdate),
    }, { listWorkerPids }),
    conversationTaskIdsFn: steerConversationTaskIds,
    foldPrefix: STEER_PREFIX_FOLD,
    isPastDeadline: (ts) => isPastSteerDeadline(ts),
    // 2026-09-16: hold a voice task's route entry while it is still transcribing.
    taskStatesFn: voiceInboxRouteHoldStates,
    // 2026-09-17: hold / inject / drop an inbox entry while typed routing places its task.
    typedRouteFn: (taskId, state) => voiceTypedRouteDrain.gate(taskId, state),
  });
  // Voice-inbox transcription drain (2026-09-16): transcribes voice-inbox
  // recordings in THIS process through pa's shared transcription action.
  // kick() is synchronous, never awaited and never throws — attempts run
  // fire-and-forget with a hard per-attempt deadline, so a hung
  // transcription cannot stall this loop (pa voice-inbox-transcribe-drain.ts).
  const voiceTranscribeDrain = createVoiceInboxTranscribeDrain();
  // AI-203 increment 4: queued-thread reconcile drain — the FIFO spawn
  // queue's restart/missed-wake backstop. Primary wakes are in-band
  // (executor terminals, spawn/steer handlers); this poll-tick closure
  // revives a queue a restart left parked while slots are free (route-queue
  // precedent: one-poll-tick family, internal 60 s throttle, no store read
  // beyond the dir listing while throttled).
  const threadQueueDrain = async () => {
    // Cooldown-expiry event (2026-09-13) runs BEFORE the reconcile: a pa
    // ledger entry whose cooldown end has passed is "model back" — the entry
    // is evicted (unblocking the cascade) and every wall-parked parkedUntil
    // rewinds to now, so THIS closure's reconcile re-claims in the same tick.
    // Rides the existing poll tick — no new timer; eviction is the once-only
    // fired marker.
    await wakeWallParkedOnCooldownExpiry().catch((err: unknown) =>
      logger.warn('main', `cooldown-expiry wake failed: ${err instanceof Error ? err.message : String(err)}`));
    return reconcileThreadQueues({
      secrets, token,
      topicNameFromKey: (key) => {
        const i = key.lastIndexOf('_');
        return i > 0 ? getTopicName(topicNames, Number(key.slice(0, i)), Number(key.slice(i + 1))) ?? '' : '';
      },
    });
  };
  // Read ONCE: a config.yaml read on every <=30s iteration is not free on this
  // disk. Changing config.maintenance for a bot job needs a bot restart.
  let maintenanceOverrides: Record<string, { enabled?: boolean; everyMs?: number }> | undefined;
  try { maintenanceOverrides = (await loadConfig()).maintenance; } catch {}
  // A4: Hoist transcription config for prefetch use in /stop, /steer, and enqueue.
  // Stale until bot restart is acceptable (same as maintenance overrides).
  let loopTranscriptionCfg: any = undefined;
  try { loopTranscriptionCfg = (await loadConfig()).transcription; } catch {}
  // Prefetch deps env: process.env PLUS secrets — the cloud transcription
  // API keys (GROQ_API_KEY etc.) live in secrets, and process.env alone
  // would silently strand prefetch on the local engine. Mirrors
  // processUpdate's runtimeEnv construction.
  const loopRuntimeEnv: NodeJS.ProcessEnv = { ...process.env, ...secrets };
  // Buttons & interactivity program (2026-08-24, spec §3.1/WP-B1 edit 3): built once,
  // above the poll loop, and reused by both the callback_query and message_reaction
  // branches below.
  const callbackDeps: CallbackDeps = {
    token,
    secrets,
    runtimeEnv: loopRuntimeEnv,
    botCwd: BOT_CWD,
    injectUpdate,
    spawnReauthLink,
    loadTopicState,
    listWorkerNames: async () => ((await loadConfig().catch(() => ({ workers: [] }))).workers ?? []).map((w: WorkerConfig) => w.name),
    observedValues: async (w, s) => readObservedTunableValues((await loadConfig().catch(() => ({ workers: [] }))).workers?.find((x: WorkerConfig) => x.name === w), s),
    declaredValues: async (w, s) => declaredValues(getTunableSpec((await loadConfig().catch(() => ({ workers: [] }))).workers?.find((x: WorkerConfig) => x.name === w), s)),
    // bp-retry (2026-08-25): same cascade as getEffectiveDefaultWorker/handleTunableCommand
    // (config.topic_defaults[topicKey], falling back to the first configured worker) — the
    // picker's FINAL fallback so it never collapses to '' for a fresh/never-hydrated topic.
    effectiveDefaultWorker: async (cid, tid) => getEffectiveDefaultWorker(await loadConfig().catch(() => ({})), topicKeyFor(cid, tid)),
    // Wave-2 `qt:` presses resolve the task id against the RUNNING store (SPEC §3.1).
    loadRunningTasks: (cid, tid) => listRunningTasks(cid, tid),
    // AI-203 WP-3 (item 2): `rq:` thread-question presses wake the executor
    // (claimThreadStarts + fireClaimedThreads, the same terminal-wake path
    // handleSteer uses). fireClaimedThreads fires real execution, so it is
    // injected here (not imported into callbacks.ts) — the production wiring.
    fireClaimedThreads,
    topicNameFor: (cid, tid) => getTopicName(topicNames, cid, tid) ?? '',
  };
  // Cold-start seeding (AI-100 Wave 2): delivered-store-compact and
  // proxy-pool-refresh mirror the OLD setInterval-based timers, none of which
  // fired on their very first tick (setInterval always waits one full interval
  // before its first call; nextMaintenanceAt was seeded to now+interval on
  // EVERY runPollLoop entry, not just once ever). A freshly-created ledger
  // entry is otherwise ALWAYS due on its first decideJob check
  // (lastRunAtMs === null) — so without this, these three would fire on every
  // single bot restart instead of waiting one interval, changing production
  // behavior and breaking poll-loop.test.ts's protected "does not fire the
  // tick before the interval elapses" test. model-override-sweep and
  // bot-log-rotation-check are DELIBERATELY excluded — they mirror
  // nextSweepAt/nextLogCheckAt, both seeded to 0 in the old code (due
  // immediately on the very first pass, every restart). The drain names
  // (dlq-flush, requeue-drain) LEFT this list with the AI-189 queue-drain
  // consolidation — their successors seed per-SOURCE via the registry's
  // coldStartSeed flag (maintenance-jobs.ts).
  const coldStartAt = Date.now();
  for (const name of ['delivered-store-compact', 'proxy-pool-refresh', 'dashboard-refresh']) {
    await updateJobState(name, (prev) => ({ ...prev, lastRunAt: new Date(coldStartAt).toISOString() })).catch(() => {});
  }
  // Throttle the KICK, not the pass-in-flight state — deliberately NOT a
  // "skip if a previous pass hasn't settled yet" guard. `maintenanceKickDueAt`
  // only advances on an actual kick, so the due-check survives an unsettled
  // prior pass and keeps re-firing every iteration once due — the OLD
  // per-timer gates (`Date.now() >= nextXAt`) worked the same way, and this
  // is required to satisfy poll-loop.test.ts's protected maintenance-tick
  // tests, whose mocked getUpdates resolves near-instantly (no real 30s
  // long-poll gap for a settling pass to hide inside, so a settlement-gated
  // kick can miss a job's only due-check window entirely — verified 2026-08-03
  // by trying the settlement-gated version against those exact tests).
  // Safety against duplicate concurrent execution of the SAME job is Wave 1's
  // existing per-job IN_FLIGHT guard in runner.ts, not a pass-level lock
  // here; any overlap between two kicks just means some jobs report
  // skipReason:'in-flight' on the later call, which is harmless and
  // already-tested runner behavior. queue-drain's dlq SOURCE is ordered last
  // inside the job's pass so a stalled flush never delays the cheap injector
  // sources sharing it. The interval is well under the smallest declared job
  // cadence (model-override-sweep, 60s) so responsiveness is unaffected;
  // it's there to bound ledger-write frequency when timeout=0 makes
  // iterations rapid-fire during a message burst.
  const MAINTENANCE_KICK_INTERVAL_MS = 20_000;
  let maintenanceKickDueAt = 0; // due on the very first iteration
  const activeMaintenancePasses = new Set<Promise<unknown>>();
  // Watchdog runs less frequently (every 5 minutes) to clear stale in-flight markers.
  const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
  let watchdogDueAt = Date.now() + WATCHDOG_INTERVAL_MS;

  while (!signal.aborted) {
    if (sentinelPath && existsSync(sentinelPath)) break;

    // Fire-and-forget so it never delays getUpdates. Drained (bounded) at loop
    // exit below so a shutdown never abandons a pass mid-flight — and so tests
    // that abort inside the first getUpdates still observe the sweep's effects.
    if (Date.now() >= maintenanceKickDueAt) {
      maintenanceKickDueAt = Date.now() + MAINTENANCE_KICK_INTERVAL_MS;
      // A kick whose predecessor pass hasn't settled yet QUEUES behind it
      // (allSettled) instead of overlapping. runDueJobs captures `now` ONCE per
      // pass, so an overlapping pass decides every job's due-ness against the
      // kicker's clock while the older pass still holds its per-job IN_FLIGHT
      // slot — the newer pass's decisions all land as skip:in-flight, wasting
      // the only pass that saw the advanced clock. Proven by trace (2026-09-03,
      // dlq drain stall): with the test clock jumping 6 min between two
      // back-to-back kicks, pass 2 decided queue-drain in the gap between
      // pass 1's ran-settled and slot-released — one decision slot too late —
      // so the cold-start-seeded dlq source (5-min cadence, seeded at job
      // creation) never ran in ANY pass and both DLQ delivery pins failed.
      // Queueing keeps the kick's due-check (the 2026-08-03 constraint above:
      // due kicks are never dropped, only ordered) and the runner's IN_FLIGHT
      // guard stays as the backstop for the other host. isDegraded() is
      // deliberately evaluated at pass-execution time (fresher than the kick).
      const runPass = (): Promise<unknown> =>
        runDueJobs('bot', botJobs, {
          degraded: isDegraded(),
          overrides: maintenanceOverrides,
        }).catch((err) => logger.warn('maintenance', `bot maintenance pass failed: ${(err as Error).message}`));
      const pass: Promise<unknown> = (activeMaintenancePasses.size === 0
        ? runPass()
        : Promise.allSettled([...activeMaintenancePasses]).then(runPass)
      ).finally(() => { activeMaintenancePasses.delete(pass); });
      activeMaintenancePasses.add(pass);
    }

    // Watchdog for stuck maintenance jobs (P2-3 fix). Runs independently to
    // clear stale in-flight markers that would otherwise block jobs forever.
    if (Date.now() >= watchdogDueAt) {
      watchdogDueAt = Date.now() + WATCHDOG_INTERVAL_MS;
      watchdogStaleJobs(botJobs).catch((err) => logger.warn('maintenance', `watchdog failed: ${(err as Error).message}`));
    }

    try {
      const timeout = inFlight.size > 0 ? 0 : LONG_POLL_TIMEOUT;
      const updates = await getUpdates(token, computePollOffset(pollOffset), timeout, signal);
      consecutiveErrors = 0; // successful poll — reset backoff
      if (updates.length > 0) {
        pollOffset = updates[updates.length - 1].update_id;
        state.last_update_id = pollOffset;
      }
      // Voice transcription kick: synchronous and NOT awaited (see
      // voiceTranscribeDrain above). It runs before the route drain so a
      // recording starts transcribing in the same iteration its entry is
      // first held.
      try {
        voiceTranscribeDrain.kick();
      } catch (err: unknown) {
        logger.warn('voice-inbox', `transcription drain kick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Voice-inbox route queue drains BEFORE the synthetic splice below, still
      // after the real-batch offset was computed above — route entries drained
      // this tick ride this same batch through the shared injection queue.
      await routeQueueDrain().catch((err: unknown) =>
        logger.warn('voice-inbox', `route drain failed: ${(err as Error).message}`));
      await threadQueueDrain().catch((err: unknown) =>
        logger.warn('main', `thread queue drain failed: ${err instanceof Error ? err.message : String(err)}`));
      // Injected synthetic updates are drained AFTER the offset above is computed from
      // the real batch only (§3.1, risk R1) — see drainInjectedUpdates()'s own comment.
      const injected = drainInjectedUpdates();
      const batch = injected.length > 0 ? [...injected, ...updates] : updates;
      if (batch.length > 0) {
        // Side-map for steer context attachment in the enqueue block. Cleared each
        // batch to avoid cross-batch contamination. Typed by the shared
        // SteerFoldContext (topic-queue.ts) — fix-wave M3 removed the restated
        // local type, so the compiler checks the fold/safety-net preconditions.
        const steerContextsByUpdateId = new Map<number, SteerFoldContext>();
        for (const update of batch) {
          // AI-092: /stop and /steer act on the topic's RUNNING worker, so they
          // must bypass per-topic serialization (queuing behind the in-flight
          // dispatch would defeat them). Handled here; /steer then re-enters
          // the normal chain as a plain message carrying the steer prompt.
          const stopMsg = update.message;
          const stopReq = stopMsg && allowedChatIds.has(stopMsg.chat?.id)
            ? parseStopSteer((stopMsg.text ?? stopMsg.caption ?? '').trim(), !!extractAudioAttachment(stopMsg))
            : null;
          // Computed once, up front, and reused for the stop/steer marker key,
          // the topic-queue key, and the topicPending key below — all three
          // MUST agree (2026-08-04 steer-queue-context-fold: verified the
          // pre-existing `${chatId}_${threadId}` marker key already matches
          // this helper's output exactly, so there's no format drift to
          // reconcile; this hoist just removes the duplicate computation).
          const topicKey = getUpdateTopicKey(update);
          if (stopReq && stopMsg) {
            const sChatId = stopMsg.chat.id;
            const sThreadId = stopMsg.message_thread_id ?? 0;
            const sMessageId = stopMsg.message_id;
            const sUpdateId = update.update_id;
            if (stopReq.kind === 'stop') {
            // Tracked in `inFlight` (2026-09-17, self-restart race follow-up): this
            // block marks the topic stopped, kills workers, cancels threads, drains
            // queued entries and sends the reply — a restart landing mid-way could
            // leave the marker without the kill or the /stop unanswered. Detached
            // from the batch loop (never awaited here); added synchronously at
            // creation, removed on settle — the callback/reaction pattern below.
            const stopP: Promise<void> = (async () => {
              // Mark BEFORE killing: a fast-dying worker's error path could
              // otherwise race past the consume check before the marker exists.
              const sTopicKey = `${sChatId}_${sThreadId}`;
              markTopicStopped(sTopicKey, stopReq.kind, sUpdateId);
              const killed = await stopTopicWorkers(sChatId, sThreadId);
              // AI-216: a bare /stop is the ONE call site where the topic-wide
              // cancel is genuinely meant — and it must now STOP the threads,
              // not merely mark them (the cancelled-but-executing defect:
              // siblings ran to completion while marked cancelled and their
              // results were discarded). Snapshot the live records BEFORE the
              // flip so each still yields its resource key, flip every
              // running/queued record unconditionally (a kill that finds no
              // live pid must not strand a `running` record holding a
              // concurrency slot), then pair each with an exact-resource kill.
              // /steer does NOT cancel threads (unchanged).
              let cancelledThreads = 0;
              let killedThreads = 0;
              if (stopReq.kind === 'stop') {
                // Snapshot failure must not skip the flip: a failed list
                // forfeits only the kills, never the record cancellation.
                const threadSnapshot = await listThreads(sTopicKey).catch(() => []);
                const threadTargets = threadSnapshot.filter((t) => t.status === 'running' || t.status === 'queued');
                cancelledThreads = await cancelRunningThreads(sTopicKey);
                for (const t of threadTargets) {
                  // signalThreadInterrupt tells the dying run's failover
                  // cascade to ABORT instead of respawning on the next worker
                  // (the same mechanism steer_thread interrupt uses); runSeq
                  // is re-read post-flip so a retry-ladder bump landing
                  // between snapshot and now still matches the captured seq.
                  const fresh = await getThread(sTopicKey, t.id).catch(() => undefined);
                  signalThreadInterrupt(`topic-${sTopicKey}-th${t.n}`, fresh?.runSeq ?? t.runSeq);
                  killedThreads += await stopThreadWorker(sChatId, sThreadId, t.n).catch(() => 0);
                }
              }
              // A9: the IIFE resumes at the loop's next await (addPendingDispatch),
              // which is AFTER the steer's own entry has been registered — a drain
              // here would cancel the steer's own entry (observed: 0 dispatches).
              // /steer drains synchronously in its own handler below; only /stop
              // drains here, inside the stop-only block.
              let heldCount = 0;
              let drained: QueueEntry[] = [];
              // A10: /stop reply's held count includes the stop message's own audio (+1 when present).
              const stopAudio = extractAudioAttachment(stopMsg);
              if (stopAudio) {
                heldCount += 1;
              }
              if (stopReq.kind === 'stop') {
                // A1: Drain ONCE — reuse the result for both counting and held-entry processing.
                drained = drainQueuedEntries(sTopicKey);
                heldCount += drained.filter(e => !e.isCommand).length;
              }
              // A2: Reply IMMEDIATELY with truthful counts (heldCount is synchronous).
              if (stopReq.kind === 'stop') {
                let reply: string;
                if (killed > 0 && heldCount > 0) {
                  reply = `⏹ Stopped the running worker and held ${heldCount} queued message(s).`;
                } else if (killed > 0) {
                  reply = '⏹ Stopping…';
                } else if (heldCount > 0) {
                  reply = `⏹ Held ${heldCount} queued message(s).`;
                } else if (cancelledThreads > 0 || killedThreads > 0) {
                  // Thread work existed (records flipped and/or pids killed)
                  // even though the bare topic resource held nothing.
                  reply = '⏹ Stopping…';
                } else {
                  reply = 'Nothing is running in this topic.';
                }
                if (cancelledThreads > 0) {
                  reply += `, cancelled ${cancelledThreads} thread(s) — their results will be discarded`;
                }
                await sendMessage(token, sChatId, appendRefIdAndLog(reply, { kind: 'system', chatId: sChatId, threadId: sThreadId }), sMessageId, sThreadId);
              }
              // A9: drain-to-held and E5 own-audio blocks run ONLY for /stop, not /steer.
              // For /steer, these cause double-prefetch and race with the sync drain.
              if (stopReq.kind === 'stop') {
                // S1: Move drained non-command entries to held in arrival order without
                // inline awaits. absorbHeldEntries will await promises in list order.
                // M1: promise holds carry the source updateId so the next dispatch's
                // coveredIds can dedup the durable absorbHeldDispatchRecords half.
                // Text holds cannot carry it yet — HeldItem has no {text, updateId}
                // variant (FX-A contract gap, see SPEC fix-wave execution notes).
                for (const entry of drained) {
                  if (entry.isCommand) continue;
                  addHeldEntry(sTopicKey, entry.voice ? { promise: entry.voice.promise, descriptor: entry.voice.descriptor, updateId: entry.updateId } : { text: entry.text, updateId: entry.updateId });
                }
                // E5: /stop message itself is a voice note — start prefetch and add to held.
                if (stopAudio) {
                  const stopDescriptor: VoicePrefetchDescriptor = {
                    kind: stopAudio.kind,
                    caption: stopMsg.caption,
                    forwardedFrom: describeForwardOrigin(stopMsg),
                    messageDate: new Date(stopMsg.date * 1000).toISOString(),
                  };
                  // A4: Use hoisted transcription config from poll loop.
                  const deps = { repoRoot: BOT_CWD, env: loopRuntimeEnv, transcription: loopTranscriptionCfg, threadId: sThreadId };
                  startPrefetch(sTopicKey, sUpdateId, token, sChatId, stopAudio.media, deps, stopAudio.kind, stopDescriptor);
                  const stopPrefetch = lookupPrefetch(sTopicKey, sUpdateId);
                  if (stopPrefetch) {
                    addHeldEntry(sTopicKey, { promise: stopPrefetch, descriptor: stopDescriptor, updateId: sUpdateId });
                  }
                }
              }
            })()
              .catch((err) => logger.warn('worker-stop', `stop/steer failed: ${(err as Error).message}`))
              .finally(() => { inFlight.delete(stopP); });
            inFlight.add(stopP);
            continue; // fully handled out-of-band (stop leg)
            }
            // /steer handler — WP-4 (router-as-orchestrator, 2026-09-19): the
            // inline mechanics moved VERBATIM into steer-exec.ts
            // executeSteer(...) — mark + PID-captured kill + queued-entry
            // drain + M2 no-source recovery + E6/E7 own-audio prefetch +
            // steerContext handoff — the SAME function the router-steer call
            // site in processUpdate runs (spec §4.2, one owner, no fork).
            // The fold stays deferred: the side map feeds the enqueue
            // normalizer exactly as before.
            await executeSteer({
              topicKey,
              chatId: sChatId,
              threadId: sThreadId,
              updateId: sUpdateId,
              messageId: sMessageId,
              steerPrompt: stopReq.prompt,
              msg: stopMsg,
              inFlight,
              steerContexts: steerContextsByUpdateId,
              // A4: Use hoisted transcription config from poll loop.
              prefetchDeps: { repoRoot: BOT_CWD, env: loopRuntimeEnv, transcription: loopTranscriptionCfg, threadId: sThreadId },
              token,
            });
            // NO continue: the /steer update falls through to the enqueue
            // block below (AI-092 — it re-enters the normal chain as a plain
            // message carrying the steer prompt; the side map above attaches
            // its fold).
          }

          // Buttons & interactivity program (2026-08-24, plans/2026-08-24-buttons-program-SPEC.md
          // §3.1, WP-B1 edit 3). Routes through callbacks.ts's handleCallbackQuery /
          // handleMessageReaction — including the pm: HITL approve/reject/diff flow this
          // block used to implement inline (verbatim behavioural move, spec correction 16).
          // Tracked in `inFlight` (2026-09-16 self-restart race, follow-up): both
          // handlers do real Telegram round-trips (answerCallbackQuery, ackSelection,
          // sendMessage) and can read/write pending_action or topic state — the
          // pollLoopInFlight busy check self-restart reads must see this window too,
          // not just processUpdate turns.
          if (update.callback_query && allowedChatIds.has(update.callback_query.message?.chat?.id ?? 0)) {
            const cb = update.callback_query;
            const cbP: Promise<void> = handleCallbackQuery(cb, callbackDeps)
              .then((outcome) => logger.info('callback', outcome, { chatId: cb.message?.chat.id, threadId: cb.message?.message_thread_id ?? 0 }))
              .catch((err) => logger.warn('callback', `handler threw: ${(err as Error).message}`))
              .finally(() => { inFlight.delete(cbP); });
            inFlight.add(cbP);
            continue;
          }
          if (update.message_reaction && allowedChatIds.has(update.message_reaction.chat.id)) {
            const mr = update.message_reaction;
            const mrP: Promise<void> = handleMessageReaction(mr, callbackDeps)
              .then((outcome) => logger.info('reaction', outcome, { chatId: mr.chat.id }))
              .catch((err) => logger.warn('reaction', `handler threw: ${(err as Error).message}`))
              .finally(() => { inFlight.delete(mrP); });
            inFlight.add(mrP);
            continue;
          }

          // Enqueue-time normalization (AI-173 phase 4): AI-095 placeholder, A5 __skipVoice,
          // queue registration and the arrival prefetch moved to enqueue-normalizer.ts.
          //
          // Per-update isolation (2026-09-12 stale-route investigation,
          // vi-508d4d7adbae/vi-be92df93d4ff): this call used to be unguarded, so a throw
          // here escaped the whole `for (const update of batch)` loop uncaught — abandoning
          // every update still left in this tick's batch (including any real Telegram
          // messages queued after this one) — and landed in this function's outer catch,
          // which logs nothing at all. For a voice-inbox route hand-off (`__synthetic:
          // 'route'`) that is a true silent drop: drainVoiceInboxRoutes() already rewrote
          // ~/.pa/voice-inbox/route-queue.jsonl to remove this entry before the batch loop
          // ever ran, so nothing else in the system holds a copy of the routing decision —
          // the task then sat unworked until the 20-minute voice-inbox-fallback sweep
          // eventually noticed and re-routed it under a different, watchdog-authored reason.
          // Catching here, logging loudly, and — for a route hand-off specifically —
          // re-injecting for a retry on the NEXT poll tick (seconds away, bounded by
          // ROUTE_INJECT_RETRY_LIMIT) closes that gap without waiting on the sweep.
          let enqueued: Awaited<ReturnType<typeof enqueueUpdateForDispatch>>;
          try {
            enqueued = await enqueueUpdateForDispatch(
              { update, allowedChatIds, topicKey, steerContexts: steerContextsByUpdateId },
              { token, repoRoot: BOT_CWD, env: loopRuntimeEnv, transcription: loopTranscriptionCfg },
            );
          } catch (err) {
            const isRoute = (update as any).__synthetic === 'route';
            const taskIds = isRoute ? extractVoiceInboxTaskIds(update.message?.text ?? '') : [];
            logger.warn('poll', `enqueueUpdateForDispatch threw — update dropped from this batch: ${(err as Error).message}`, {
              update_id: update.update_id, topicKey, synthetic: (update as any).__synthetic, taskIds,
            });
            if (isRoute) {
              const retryCount = ((update as any).__routeRetryCount ?? 0) + 1;
              if (retryCount <= ROUTE_INJECT_RETRY_LIMIT) {
                injectUpdate({ ...update, update_id: nextSyntheticUpdateId(), __routeRetryCount: retryCount } as TelegramUpdate);
                logger.warn('voice-inbox', 'route hand-off failed to enqueue — requeued for the next poll tick', { taskIds, retryCount });
              } else {
                logger.error('voice-inbox', 'route hand-off exhausted its retries — leaving it to the stale-route fallback', { taskIds, retryCount });
              }
            }
            continue;
          }
          const { enqKey, queueEntry } = enqueued;
          let folded = false;
          const prev = topicPending.get(topicKey) ?? Promise.resolve();
          const p: Promise<void> = prev
            .then(async () => {
              // Cancelled-entry cleanup.
              if (queueEntry) {
                dequeueUpdate(topicKey, queueEntry);
                if (queueEntry.cancelled) {
                  if (queueEntry.voice) clearPrefetch(topicKey, queueEntry.updateId);
                  return;
                }
              }
              // --- Voice prefetch await (step C.1) ---
              await settleVoicePrefetch(update, queueEntry);
              // --- Steer fold materialization (D1, A2, A3, A7) ---
              if (queueEntry?.steerContext) {
                folded = true;
                // Router-metadata (§1.2): this dispatch is the continuation of
                // an operator /steer — the dispatch site stamps
                // PA_ROUTING_STEER_BY='operator' from this marker. The ROUTER
                // steer path materializes inline instead (never reaches the
                // queue) and stamps 'router' from routerTurn.steerWait.
                (update as any).__operatorSteer = true;
                // M3: ctx is the shared SteerFoldContext — no cast.
                const ctx = queueEntry.steerContext;
                const texts: string[] = [];
                // A7: Absorb held entries at normalizer time (not iteration time).
                // These are the OLDEST context — prepend first.
                const heldTexts = await absorbHeldEntries(topicKey);
                texts.push(...heldTexts.map(h => h.text));
                const sChatId = update.message?.chat.id;
                const sThreadId = update.message?.message_thread_id ?? 0;
                if (sChatId !== undefined) {
                  // M1 rule 1/2: the drained loop below pushes those transcripts
                  // into THIS prompt, so records already covered by ctx.drained are
                  // consumed WITHOUT emitting — each transcript folds exactly once.
                  const coveredIds = new Set(ctx.drained.map(d => d.updateId));
                  const durableHeldTexts = await absorbHeldDispatchRecords(sChatId, sThreadId, coveredIds);
                  texts.push(...durableHeldTexts);
                }
                const allPending = await listPendingDispatches().catch(() => []);
                const foldedVoice: Array<{ text: string; media: AudioMediaIdentity; kind: AudioAttachmentKind; messageId?: number }> = [];
                // Drained entries in arrival order.
                // B1: no placeholder-regex gate — the snapshot formats success AND
                // rejection itself, so every resolved text is pushed as-is (a failure
                // line echoes too: visible, not silent).
                for (const d of ctx.drained) {
                  const text = await d.textPromise;
                  const origEntry = ctx.drainedEntries.find(e => e.updateId === d.updateId);
                  if (origEntry?.voice) {
                    const pendingRec = allPending.find(p => p.chatId === sChatId && p.threadId === sThreadId && p.updateId === d.updateId);
                    foldedVoice.push({
                      text,
                      media: origEntry.voice.media,
                      kind: origEntry.voice.kind,
                      ...(pendingRec?.messageId !== undefined ? { messageId: pendingRec.messageId } : {}),
                    });
                  }
                  texts.push(text);
                }
                if (foldedVoice.length > 0) {
                  (update as any).__foldedVoice = foldedVoice;
                }
                // Own transcript (steer message itself was media — E6/E7).
                let ownTranscript: string | undefined = undefined;
                if (queueEntry.voice) {
                  const vr = (update as any).__voiceResult as VoiceResult | undefined;
                  if (vr) ownTranscript = userTextFromVoiceResult(vr, queueEntry.voice.descriptor);
                }
                // When steerPrompt is provided, push it. If steer message was voice/audio, ownTranscript is pushed.
                if (ctx.steerPrompt !== undefined && ctx.steerPrompt.trim().length > 0) {
                  texts.push(ctx.steerPrompt);
                } else if (ownTranscript !== undefined) {
                  texts.push(ownTranscript);
                }
                // If ownTranscript exists and steerPrompt is defined, push ownTranscript before the prompt.
                if (ownTranscript !== undefined && ctx.steerPrompt !== undefined && ctx.steerPrompt.trim().length > 0) {
                  texts.splice(-1, 0, ownTranscript);
                }
                const combinedText = texts.filter(t => t.trim().length > 0).join('\n\n');
                (update as any).message = { ...update.message, text: combinedText };
                logger.info('steer-fold', 'materialized steer prompt', {
                  topicKey,
                  steerUpdateId: update.update_id,
                  drainedCount: ctx.drained.length,
                  heldCount: heldTexts.length,
                  chars: combinedText.length,
                });
                // M1 rule 3 — consume at proven delivery: the drained transcripts
                // reached THIS steer prompt, so their records must not be re-absorbed
                // by the next dispatch. Best-effort; a crash before this point leaves
                // the record flagged and the next dispatch absorbs it (correct).
                if (sChatId !== undefined) {
                  for (const d of ctx.drained) {
                    removePendingDispatch(pendingDispatchKey(sChatId, sThreadId, d.updateId)).catch(() => {});
                  }
                }
              }
              // --- Flush-check (step C.2, A8) + held absorb (step C.3, A2) — enqueue-normalizer.ts;
              // false = the update was stop-held and processUpdate must NOT run (__heldAbsorbed producer).
              if (!(await flushCheckAndAbsorbHeld({ update, queueEntry, topicKey }))) return;
              // --- Batched uptake compile (AI-209, natural drain) ---
              // Runs AFTER held-absorb (so the head's text already contains any
              // held context) and BEFORE processUpdate. Gated to no-op unless a
              // batch is genuinely available (G1-G6); every other shape is
              // byte-identical to today. Statement order inside `if (plan)` is
              // LOAD-BEARING: the message rewrite + markers must land BEFORE the
              // follower-record removals (M1 rule 3 - proven materialization).
              // W4 counterpart (AI-203 inc 3): a reply-shaped HEAD never compiles a batch — its anchor must reach processUpdate with its OWN text.
              if (queueEntry && !queueEntry.isCommand && !queueEntry.steerContext
                  && queueEntry.replyToMessageId === undefined
                  && update.message && !extractAudioAttachment(update.message)) {
                try {
                  const bChatId = update.message?.chat.id;
                  const bThreadId = update.message?.message_thread_id ?? 0;
                  if (bChatId !== undefined) {
                    const headText = String(update.message?.text ?? update.message?.caption ?? '').trim();
                    const plan = await compileBatchFold({
                      topicKey, chatId: bChatId, threadId: bThreadId,
                      head: { updateId: update.update_id, messageId: update.message?.message_id, text: headText },
                    });
                    if (plan) {
                      (update as any).message = { ...update.message, text: plan.combinedText };
                      (update as any).__batchFold = { from: plan.foldedFrom };
                      if (plan.foldedVoice.length > 0) (update as any).__foldedVoice = plan.foldedVoice;
                      for (const f of plan.foldedFrom) {
                        await removePendingDispatch(pendingDispatchKey(bChatId, bThreadId, f.updateId)).catch(() => {});
                      }
                    }
                  }
                } catch (err) {
                  logger.warn('batch-uptake', `batch compile failed — dispatching head alone: ${(err as Error).message}`, { topicKey, updateId: update.update_id });
                }
              }
              return processUpdate(update, token, allowedChatIds, secrets, topicNames, branchIndex);
            })
            .catch((err) => logger.warn('poll', `processUpdate rejected: ${(err as Error).message}`, { update_id: update.update_id }))
            .finally(async () => {
              inFlight.delete(p);
              if (topicPending.get(topicKey) === p) topicPending.delete(topicKey);
              if (queueEntry?.steerContext && !folded) {
                // M3: typed SteerFoldContext — `drained` is required, so the compiler
                // (not a cast) checks this safety net's precondition.
                const ctx = queueEntry.steerContext;
                for (const d of ctx.drained) {
                  // Text holds carry updateId (FX-A addendum) so the seam dedup
                  // covers the fold-miss path too.
                  addHeldEntry(topicKey, { text: await d.textPromise, updateId: d.updateId });
                }
                logger.warn('steer-fold', 'fold did not run — drained transcripts held for the next dispatch', {
                  topicKey,
                  count: ctx.drained.length,
                });
              }
              // Single choke point covering every processUpdate exit path
              // (dispatch, skip-worker command, a cancelled/folded entry, or a
              // thrown exception) — a normal dispatch already removed its own
              // (upgraded) record at :1018, making this a safe no-op; anything
              // else that left the placeholder behind (including a cancelled
              // entry, which never reaches :1018) gets cleaned up here.
              // B9: a ladder-parked record is the drain's to re-inject — removing it
              // here would silently drop the user's request.
              if (enqKey && !(update as any).__ladderParked) {
                if (queueEntry?.cancelled) {
                  await updatePendingDispatch(enqKey, { heldForTopic: true, heldAt: new Date().toISOString() }).catch(() => {});
                } else {
                  await removePendingDispatch(enqKey).catch(() => {});
                }
              }
            });
          topicPending.set(topicKey, p);
          inFlight.add(p);
        }
        await saveState(state);
      } else if (inFlight.size > 0) { await sleepFn(500); }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') break;
      // This used to be completely silent — the 2026-09-12 stale-route investigation
      // (vi-508d4d7adbae/vi-be92df93d4ff) found routed voice-inbox tasks going missing
      // for 20+ minutes with "no attempt, no skip, no failure logged" anywhere in the bot
      // log, traced to an uncaught throw from this tick's batch loop landing HERE with
      // nothing recorded. The batch loop now isolates its own per-update throws (see the
      // enqueueUpdateForDispatch try/catch above), but a tick-level failure (e.g. getUpdates
      // or a drain rejecting) still lands here — log it so a future instance of this shape
      // of bug is visible within one poll cycle, not just to the 20-minute fallback sweep.
      logger.warn('poll', `poll iteration failed: ${(err as Error).message}`, { consecutiveErrors: consecutiveErrors + 1 });
      consecutiveErrors++;
      await sleepFn(computeBackoff(consecutiveErrors));
    }
  }
  // Non-blocking shutdown: workers are independent processes that
  // keep running after the bot exits. Pending-dispatch records
  // persist to disk; the orphan reaper recovers their replies on the
  // next startup. process.exit() skips pending promise callbacks
  // (the .finally() chains on detached processUpdate promises
  // won't fire), which is intentional — markDelivered and
  // removePendingDispatch stay on disk for recovery.
  if (inFlight.size > 0) {
    logger.info('shutdown', `detaching ${inFlight.size} in-flight dispatch(es) — workers continue independently`);
    // Test-mode only (2026-09-01 dark-file recheck): when the terminal exit
    // has been neutered via _setExitForTest, drain in-flight dispatches
    // before returning. Many revived tests `await runPollLoop(...)` and then
    // immediately assert on state a dispatch was writing (a local command's
    // pin-card refresh, a turn write) — an assumption production's real
    // process.exit() never had to honor (the whole process dies before any of
    // this code, including this branch, can run), but that plenty of these
    // tests were written against anyway. See poll-loop.test.ts's "same-topic
    // updates" test for the one case this trade-off breaks (an extra send
    // that used to be silently abandoned now completes) — skipped there with
    // the same dated note. Never runs outside test mode.
    if (exitFn !== defaultExitFn) {
      await Promise.allSettled(inFlight);
    }
  }
  // Bounded drain: waits for every currently in-flight maintenance pass (there
  // can be more than one — kicks are throttled by time, not by whether a prior
  // pass has settled, see above), not just the most recently kicked one.
  if (activeMaintenancePasses.size > 0) {
    let drainTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(activeMaintenancePasses),
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, MAINTENANCE_DRAIN_MS);
        drainTimer.unref?.();
      }),
    ]);
    if (drainTimer) clearTimeout(drainTimer);
  }
  exitFn(0);
}

/**
 * AI-246 v4 (WP-B): preemptively merge pa's browserSessionEnvOverlay into the
 * secrets record every worker dispatch inherits, so the CDP endpoint vars are
 * present before a worker decides to use a browser. The vars are inert for
 * non-browser tasks — the worker calls `pa browser ensure` to actually
 * launch/attach Chrome. Additive-only: a real secrets.env key with the same
 * name always wins. A config-load failure must never break the bot, so it is
 * swallowed here. This single merge point covers ALL lanes — dispatchMessage,
 * executeTopicTask and dispatchOrchestratorTurn each receive this same
 * `secrets` object. Exported as the test seam.
 */
export async function applyBrowserSessionEnvOverlay(secrets: Record<string, string>): Promise<void> {
  try {
    const config = await loadConfig();
    const overlay = browserSessionEnvOverlay(config);
    for (const [k, v] of Object.entries(overlay)) {
      if (secrets[k] === undefined) secrets[k] = v;
    }
  } catch { /* config load failure must never break the bot */ }
}

async function main(): Promise<void> {
  const locked = await acquireLock();
  if (!locked) process.exit(0);
  try {
    const secrets = await loadSecrets();
    // AI-246 v4: preemptive browser-session CDP env for every worker dispatch
    // — see applyBrowserSessionEnvOverlay.
    await applyBrowserSessionEnvOverlay(secrets);
    const token = secrets['TELEGRAM_BOT_TOKEN'];
    const chatIds = (secrets['TELEGRAM_CHAT_ID'] || '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    if (!token || chatIds.length === 0) process.exit(1);

    // Log dist identity banner at startup
    logger.info('boot', formatBootIdentity(fileURLToPath(import.meta.url)));

    // AI-096 item 5: only what the poll loop NEEDS runs before it starts. All
    // fs-heavy / network-heavy maintenance is a background chain — on a starved
    // disk the old sequential startup kept the bot deaf for 15-25 minutes.
    const state = await loadState(chatIds[0]);
    const topicNames = await loadTopicNames();
    const branchIndex = await loadBranches();
    const sentinelPath = join(paHome(), 'telegram-bot.stop');
    try { unlinkSync(sentinelPath); } catch {}
    startHealthProbe();
    void (async () => {
      // Ensure a working Telegram proxy pool is loaded, then keep it refreshed.
      // No-op unless TELEGRAM_PROXY_SOURCE_URL is set. Direct-first fetches work
      // without it, so this need not gate the poll loop.
      await startProxyAutoRefresh(token).catch(() => {});
      // Session GC is the pa-host `session-gc` maintenance job (AI-100 Wave 1);
      // the bot's own poll-loop tick was removed in Wave 2.
      // AI-095: don't kill orphan workers still serving a crashed-instance dispatch —
      // the reaper below waits for them and harvests their reply instead.
      const pendingAtStartup = await listPendingDispatches().catch(() => [] as Awaited<ReturnType<typeof listPendingDispatches>>);
      const protectedTopics = new Set(pendingAtStartup.map((r) => `topic-${r.chatId}_${r.threadId}`));
      await cleanupOrphanedWorkers(protectedTopics).catch(() => {});
      await flushDlq(token).catch(() => {});
      // AI-095: recover replies from dispatches orphaned by a crashed prior instance.
      // May wait many minutes for an orphan to finish.
      void reapOrphanedDispatches(token, { secrets, requeueUpdate: requeueSyntheticUpdate, allowedChatIds: new Set(chatIds) })
        .catch((err) => logger.warn('reaper', 'reap failed', { error: String(err) }));
      // AI-228: settle thread records left `running` by the crash. Sibling
      // pass — AFTER the cleanupOrphanedWorkers kill pass above (a live
      // orphan inside its harvest window keeps its registry entry, a dead
      // one's entry is already gone; registry+OS truth is reliable exactly
      // because we run second). No recovery-gate involvement — a thread
      // orphan writes its own session on its own `...-th<n>` resource.
      void reapOrphanedThreads({ token, secrets })
        .catch((err) => logger.warn('thread-reaper', 'reap failed', { error: String(err) }));
      await backfillTopicDescriptions(token, chatIds, topicNames).catch(() => {});
      await registerBotCommands(token).catch(() => {});
      await updateDashboard(token, chatIds[0]).catch(() => {});
    })();
    const controller = new AbortController();
    // Abort an in-flight (possibly slow, proxied) getUpdates promptly when the
    // stop sentinel appears — otherwise graceful shutdown must wait out a full
    // long-poll + proxy-failover cycle. The poll loop's AbortError handler then
    // breaks. Checked every 1s; unref'd so it never keeps the process alive.
    const stopWatcher = setInterval(() => {
      try { if (existsSync(sentinelPath) && !controller.signal.aborted) controller.abort(); } catch {}
    }, 1000);
    stopWatcher.unref?.();
    try {
      await runPollLoop(token, chatIds, state, secrets, controller.signal, (ms: number) => new Promise(r => setTimeout(r, ms)), sentinelPath, topicNames, branchIndex);
    } finally {
      clearInterval(stopWatcher);
    }
  } finally { await releaseLock().catch(() => {}); }
}

import { fileURLToPath, pathToFileURL } from 'url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('[boot] fatal:', err); process.exit(1); });
}
