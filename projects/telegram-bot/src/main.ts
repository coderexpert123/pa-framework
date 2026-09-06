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
  type TunableCommand,
  type UpdateBrainResult,
} from './logic.js';
// AI-201 voice-inbox bridge: /pair mint + route-queue drain (services seam below).
import { drainVoiceInboxRoutes } from './voice-inbox-bridge.js';
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
import { getKeepAwakeStatus } from './keepawake.js';
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
import { reapOrphanedDispatches } from './orphan-reaper.js';
import { isTopicRecovering, waitForTopicRecovery } from './recovery-gate.js';
import { isDegraded, startHealthProbe } from './health.js';
import { parseStopSteer, stopTopicWorkers, markTopicStopped, isTopicStopped, consumeTopicStopped } from './worker-stop.js';
import { dequeueUpdate, drainQueuedEntries, addHeldEntry, absorbHeldEntries, snapshotDrained, type QueueEntry, type SteerFoldContext, type AudioMediaIdentity } from './topic-queue.js';
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
  type OAuthResumeAction,
} from './oauth.js';
import {
  extractAudioAttachment,
  isBarePlaceholderUserText,
  type AudioAttachmentKind,
  type VoiceResult,
} from './voice.js';
import {
  startPrefetch,
  lookupPrefetch,
  lookupPrefetchDescriptor,
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
  ORCHESTRATOR_PATTERN,
} from './orchestrator.js';
import { cancelRunningThreads, listThreads } from './topic-threads.js';
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
import { startProxyAutoRefresh } from '../../../pa/dist/src/lib/telegram-proxy.js';
import { cleanupOrphanedWorkers } from '../../../pa/dist/src/worker-pids.js';
import { blackboard, startLockRenewal } from '../../../pa/dist/src/blackboard.js';
import { loadConfig } from '../../../pa/dist/src/config.js';
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

async function replacePinnedStatusCard(
  token: string,
  chatId: number,
  threadId: number,
  state: ConversationState,
  snapshot: ModelStatusSnapshot,
  keepAwake = getKeepAwakeStatus()
): Promise<{ delivered: boolean; pinned: boolean; messageId: number | null }> {
  const pinText = renderStatusCard({ snapshot, keepAwake, tasks: await topicTaskCounts(chatId, threadId) });
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
  keepAwake = getKeepAwakeStatus(),
  config?: { workers?: WorkerConfig[] }
): Promise<void> {
  const snapshot = hydrateModelStatus(state, effectiveDefault, config);
  syncModelStatusState(state, snapshot);

  const pinText = renderStatusCard({ snapshot, keepAwake, tasks: await topicTaskCounts(chatId, threadId) });
  if (state.pinned_status_message_id) {
    // bp-retry (2026-08-25): this sweep used to unconditionally rewrite the card's
    // keyboard back to the top-level menu, silently stranding a user mid-navigation
    // through a cc:agent/cc:model/cc:effort submenu on the same message id. If a
    // submenu is currently displayed (recorded by callbacks.ts, fresh within its
    // 2-minute window) keep showing it — only the card TEXT changes here either way.
    const keyboard = currentCardKeyboard(chatId, state.pinned_status_message_id) ?? buildControlCardKeyboard();
    const pinOk = await editMessageText(token, chatId, state.pinned_status_message_id, appendRefIdAndLog(pinText, { kind: 'pin', chatId, threadId }), keyboard).catch(() => false);
    if (pinOk) {
      // Topic pins are write-only in the Bot API — editing a message never re-pins
      // it, so a card whose pin was lost (manual unpin) stayed unpinned forever.
      // Re-assert the SAME message id after every successful in-place edit;
      // idempotent and fire-and-forget (telegram.ts logs pin failures itself).
      void pinChatMessage(token, chatId, state.pinned_status_message_id).catch(() => {});
      return;
    }
  }

  await replacePinnedStatusCard(token, chatId, threadId, state, snapshot, keepAwake);
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

        await refreshPinnedStatusCardInPlace(token, ref.chatId, ref.threadId, topicState, effectiveDefault, getKeepAwakeStatus(), config);
        const expiryMsg = renderSessionExpiryMessage(prevDescriptor, nextDescriptor, 'expired');
        await sendMessage(token, ref.chatId, expiryMsg, ref.threadId || undefined);
        await saveTopicState(topicState);
        touched++;
        continue;
      }

      const hydrated = hydrateModelStatus(topicState, effectiveDefault, config);
      if (modelStatusNeedsRefresh(topicState.model_status, hydrated) || topicState.pinned_worker !== hydrated.current_worker) {
        await refreshPinnedStatusCardInPlace(token, ref.chatId, ref.threadId, topicState, effectiveDefault, getKeepAwakeStatus(), config);
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
    // /orchestrator (AI-203): per-topic orchestrator-mode toggle + status. A
    // deterministic local command like the router's family — the pure handler
    // decides; this site performs the role-boundary session clear and answers
    // with a ref-ID'd reply, never a worker dispatch.
    if (!skipWorker && ORCHESTRATOR_PATTERN.test(userText)) {
      const orchCmd = handleOrchestratorCommand(userText, topicState, await listThreads(topicKey));
      if (orchCmd.clearSession) topicState.session = undefined;
      response = appendRefIdAndLog(orchCmd.response, { kind: 'system', chatId, threadId });
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
          await updateTopicName(topicNames, chatId, newThreadId, br.branchName);

          const { description, confident } = await generateDescriptionWithLLM({
            name: br.branchName,
            isBranch: true,
            parentName,
            parentDescription: parentDesc,
            userPrompt: br.prompt,
            sampleTurns: sampleTurns || undefined,
          });

          let branchDesc = (confident && description) ? description : '';
          if (!branchDesc) {
            branchDesc = br.prompt
              ? `Branch of ${parentName} for ${br.branchName}: ${br.prompt}`
              : `Branch of ${parentName} focused on ${br.branchName}.`;
          }
          if (branchDesc.length > MAX_DESCRIPTION_LEN) {
            branchDesc = branchDesc.slice(0, MAX_DESCRIPTION_LEN);
          }

          await setTopicDescription(topicNames, chatId, newThreadId, branchDesc);

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
          branchCreatedTopicKeys.add(`${chatId}_${newThreadId}`);
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
    if (!skipWorker) {
      expirePendingAction(topicState);
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
      resolveQuestionAnswer(topicState, userText);
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
        // AI-203: an orchestrator-mode topic routes every non-command message
        // through the orchestrator conversation (interpret → route → report);
        // everything downstream reads the superset result shape unchanged.
        // isCancelled is NOT passed — the orchestrator cascade derives the
        // byte-identical stop-marker predicate from (resource, updateId)
        // internally, exactly like dispatchMessage does.
        const dr = isOrchestratorMode(topicState)
          ? await dispatchOrchestratorTurn({
              userText, replyContext,
              pendingDesc: confirmedDescription ?? topicState.pending_action?.description,
              topicState, secrets, resourceId, chatId, threadId,
              defaultWorker: effectiveDefault, onNotify,
              updateId: update.update_id, workdir, contextId, topicNames,
            })
          : await dispatchMessage(userText, replyContext, confirmedDescription ?? topicState.pending_action?.description, topicState, secrets, resourceId, effectiveDefault, topicNames, onNotify, update.update_id, workdir, contextId);
        response = dr.response; topicState.session = dr.session;
        workerErrored = !!dr.workerError;
        // WP-D1 (A.3): carry the empty-output suggestion out of dispatchMessage's
        // scope — the reply-send cascade (outside this block) reads the module let.
        drSuggestedWorker = dr.suggestedWorker ?? null;
        // AI-151: capture the actual worker that handled this dispatch
        assistantWorker = dr.dispatchedWorker || topicState.session?.worker || topicState.preferred_worker || effectiveDefault;
        // B9 rev 3 (a): HOIST stoppedKind consumption before applyMetaActions (V22)
        const topicKey = `${chatId}_${threadId}`;
        const stoppedKind = consumeTopicStopped(topicKey, update.update_id);

        // B9 rev 3 (b): Park decision BEFORE applyMetaActions (V22/V23)
        const rqCount = (update as any).__requeueCount as number | undefined;
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
          // AI-203: the orchestrator's validated routing actions become
          // thread-store writes + executor fires here, so the reply that
          // promised the spawn/steer carries the frozen confirmation footer.
          // ('x' in dr narrows the dispatch-result union — the human lane's
          // dispatchMessage result has neither field.)
          if ('spawn' in dr && dr.spawn) {
            response += await handleSpawn({
              topicKey, topicName: getTopicName(topicNames, chatId, threadId) ?? '',
              spawn: dr.spawn, secrets, token, workdir: workdir.dir,
            });
          }
          if ('steer' in dr && dr.steer) {
            response += await handleSteer({
              topicKey, topicName: getTopicName(topicNames, chatId, threadId) ?? '',
              steer: dr.steer, secrets, token, workdir: workdir.dir,
            });
          }
          if (skillToRun) {
            spawn('pa', ['run', skillToRun, '--worker', topicState.preferred_worker || effectiveDefault], { cwd: BOT_CWD, detached: true, stdio: 'ignore', shell: true, windowsHide: true }).unref();
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
      const textToSend = `${response.trim()}\n\n_Ref: ${refId}_`;
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
        const wantsConfirm = !!topicState.pending_action && !topicState.pending_action.message_id;
        const wantsQuestion = !!topicState.pending_question && !topicState.pending_question.message_id;
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
          : undefined;
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
      getKeepAwakeStatus(),
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
  });
  // Voice-inbox route drain (AI-201): registered beside the maintenance drains
  // above but invoked once per poll tick below — the route queue promises
  // one-poll-tick latency, not the queue-drain family's per-source cadence.
  const routeQueueDrain = () => drainVoiceInboxRoutes({ injectFn: injectUpdate, nextId: nextSyntheticUpdateId });
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
      // Voice-inbox route queue drains BEFORE the synthetic splice below, still
      // after the real-batch offset was computed above — route entries drained
      // this tick ride this same batch through the shared injection queue.
      await routeQueueDrain().catch((err: unknown) =>
        logger.warn('voice-inbox', `route drain failed: ${(err as Error).message}`));
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
            void (async () => {
              // Mark BEFORE killing: a fast-dying worker's error path could
              // otherwise race past the consume check before the marker exists.
              const sTopicKey = `${sChatId}_${sThreadId}`;
              markTopicStopped(sTopicKey, stopReq.kind, sUpdateId);
              const killed = await stopTopicWorkers(sChatId, sThreadId);
              // AI-203: /stop also cancels the topic's RUNNING threads (their
              // dispatches carry a non-topic resource, so stopTopicWorkers
              // does not match them) — the executor's ownership gate then
              // discards their results silently when they settle, and the
              // reply below states the count truthfully. /steer does NOT
              // cancel threads.
              const cancelledThreads = await cancelRunningThreads(sTopicKey);
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
                } else {
                  reply = 'Nothing is running in this topic.';
                }
                if (cancelledThreads > 0) {
                  reply += `, cancelled ${cancelledThreads} thread(s) — their results will be discarded`;
                }
                await sendMessage(token, sChatId, appendRefIdAndLog(reply, { kind: 'system', chatId: sChatId, threadId: sThreadId }), sMessageId, sThreadId);
              } else if (killed === 0) {
                // Steer with nothing running: the prompt below dispatches normally.
                await sendMessage(token, sChatId, appendRefIdAndLog('Nothing was running — dispatching your prompt as a new message.', { kind: 'system', chatId: sChatId, threadId: sThreadId }), sMessageId, sThreadId);
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
            })().catch((err) => logger.warn('worker-stop', `stop/steer failed: ${(err as Error).message}`));
            if (stopReq.kind === 'stop') continue; // fully handled out-of-band
            // /steer handler: drain queued entries and store steerContext for
            // materialization in the normalizer. Held entries are absorbed at
            // normalizer time (A7), not iteration time.
            const drainedEntries = drainQueuedEntries(topicKey, 'steer');
            const drained = snapshotDrained(drainedEntries);
            // M2 (fix-wave): no-source recovery for drained entries whose voice
            // attach never landed. In order: (a) the durable record's SETTLED
            // transcript, (b) the prefetch map's own promise + descriptor (none is
            // fabricated — M2 deleted the old `{ kind: 'voice' }` stub), (c) the
            // entry's placeholder text, warned. Holds carry the entry's updateId
            // where the HeldItem contract allows it (M1 seam dedup). Detached: the
            // batch loop must not block on a disk read; a hold that lands after the
            // fold's absorb is picked up by the topic's NEXT dispatch instead (still
            // delivered — never dropped).
            void (async () => {
              for (const entry of drainedEntries) {
                if (entry.voice || entry.isCommand) continue;
                const rec = (await listPendingDispatches().catch(() => []))
                  .find(r => r.chatId === sChatId && r.threadId === sThreadId && r.updateId === entry.updateId);
                if (rec?.userTextSettled) {
                  // (a) — recovered from the settled record WITH updateId, so the
                  // seam dedup (M1 rule 1) covers it against the durable half.
                  addHeldEntry(topicKey, { text: rec.userText, updateId: entry.updateId });
                  logger.warn('steer-fold', 'drained entry lost its voice attach — recovered settled transcript from its pending-dispatch record', { topicKey, updateId: entry.updateId });
                  continue;
                }
                const descriptor = lookupPrefetchDescriptor(topicKey, entry.updateId);
                const promise = descriptor ? lookupPrefetch(topicKey, entry.updateId) : undefined;
                if (descriptor && promise) {
                  // (b) — held as a promise item with updateId; absorbHeldEntries
                  // formats it with the SAME descriptor, byte-identical to
                  // userTextFromVoiceResult(await promise, descriptor).
                  addHeldEntry(topicKey, { promise, descriptor, updateId: entry.updateId });
                  logger.warn('steer-fold', 'drained entry lost its voice attach — recovered from prefetch map', { topicKey, updateId: entry.updateId });
                  continue;
                }
                // (c) — nothing better exists. Gated on the placeholder shape so a
                // drained plain-TEXT entry is not held here: its snapshot already
                // reaches this same steer prompt via ctx.drained, and the in-memory
                // absorb has no exclusion set, so an unconditional hold would fold
                // it twice (deviation from M2(c)'s letter, see SPEC notes).
                if (isBarePlaceholderUserText(entry.text)) {
                  addHeldEntry(topicKey, { text: entry.text, updateId: entry.updateId });
                  logger.warn('steer-fold', 'drained entry had no transcript source — held instead', { topicKey, updateId: entry.updateId });
                }
              }
            })().catch((err) => logger.warn('steer-fold', `drain recovery failed: ${(err as Error).message}`));
            // E6/E7: /steer message itself has audio — start prefetch.
            const steerAudio = extractAudioAttachment(stopMsg);
            let steerVoice: { promise: Promise<VoiceResult>; descriptor: VoicePrefetchDescriptor } | undefined = undefined;
            if (steerAudio) {
              const steerDescriptor: VoicePrefetchDescriptor = {
                kind: steerAudio.kind,
                caption: stopMsg.caption,
                forwardedFrom: describeForwardOrigin(stopMsg),
                messageDate: new Date(stopMsg.date * 1000).toISOString(),
              };
              // A4: Use hoisted transcription config from poll loop.
              const deps = { repoRoot: BOT_CWD, env: loopRuntimeEnv, transcription: loopTranscriptionCfg, threadId: sThreadId };
              startPrefetch(topicKey, sUpdateId, token, sChatId, steerAudio.media, deps, steerAudio.kind, steerDescriptor);
              const prefetch = lookupPrefetch(topicKey, sUpdateId);
              if (prefetch) {
                steerVoice = { promise: prefetch, descriptor: steerDescriptor };
              }
            }
            // Store steerContext on the queue entry. The enqueue block below will
            // attach it after registerQueuedUpdate returns.
            const steerContext = { drainedEntries, drained, steerPrompt: stopReq.prompt };
            // For text-only steer (no audio anywhere), use the old combined-text path.
            // For voice steer (drainedEntries has voice OR steerVoice is set), store
            // steerContext and set just the prompt.
            const hasVoiceInDrain = drainedEntries.some(e => e.voice !== undefined);
            const hasVoice = hasVoiceInDrain || steerVoice !== undefined;
            if (!hasVoice) {
              // Text-only steer: combine drained texts + prompt immediately.
              const drainedTexts = drainedEntries.map(e => e.text).filter(t => t !== '');
              const parts = stopReq.prompt ? [...drainedTexts, stopReq.prompt] : drainedTexts;
              stopMsg.text = parts.join('\n\n');
            } else {
              // Voice steer: store steerContext and set just the prompt. The normalizer
              // will materialize the full prompt with transcripts (including held entries).
              // FIX (AI-208 fix-wave): a BARE /steer has no prompt — overwriting the
              // message text with '' made isAcceptableUpdate reject the steer update
              // outright (empty text, no attachment), silently dropping the whole fold.
              // Keep the original '/steer' text: the fold replaces
              // update.message.text with the materialized prompt before dispatch.
              stopMsg.text = stopReq.prompt ?? stopMsg.text;
            }
            // Store in the side map for the enqueue block to attach. (steerVoice
            // stays a local: it feeds hasVoice below and was never read off the
            // stored context — fix-wave M3 typed the map as SteerFoldContext.)
            steerContextsByUpdateId.set(update.update_id, steerContext);
          }

          // Buttons & interactivity program (2026-08-24, plans/2026-08-24-buttons-program-SPEC.md
          // §3.1, WP-B1 edit 3). Routes through callbacks.ts's handleCallbackQuery /
          // handleMessageReaction — including the pm: HITL approve/reject/diff flow this
          // block used to implement inline (verbatim behavioural move, spec correction 16).
          if (update.callback_query && allowedChatIds.has(update.callback_query.message?.chat?.id ?? 0)) {
            const cb = update.callback_query;
            void handleCallbackQuery(cb, callbackDeps)
              .then((outcome) => logger.info('callback', outcome, { chatId: cb.message?.chat.id, threadId: cb.message?.message_thread_id ?? 0 }))
              .catch((err) => logger.warn('callback', `handler threw: ${(err as Error).message}`));
            continue;
          }
          if (update.message_reaction && allowedChatIds.has(update.message_reaction.chat.id)) {
            void handleMessageReaction(update.message_reaction, callbackDeps)
              .then((outcome) => logger.info('reaction', outcome, { chatId: update.message_reaction!.chat.id }))
              .catch((err) => logger.warn('reaction', `handler threw: ${(err as Error).message}`));
            continue;
          }

          // Enqueue-time normalization (AI-173 phase 4): AI-095 placeholder, A5 __skipVoice,
          // queue registration and the arrival prefetch moved to enqueue-normalizer.ts.
          const { enqKey, queueEntry } = await enqueueUpdateForDispatch(
            { update, allowedChatIds, topicKey, steerContexts: steerContextsByUpdateId },
            { token, repoRoot: BOT_CWD, env: loopRuntimeEnv, transcription: loopTranscriptionCfg },
          );
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
              if (queueEntry && !queueEntry.isCommand && !queueEntry.steerContext
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

async function main(): Promise<void> {
  const locked = await acquireLock();
  if (!locked) process.exit(0);
  try {
    const secrets = await loadSecrets();
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
