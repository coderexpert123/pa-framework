import { spawn, execFile } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'fs';
import { readdir, unlink, rename, writeFile, readFile, stat, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { acquireLock, releaseLock } from './lock.js';
import { getUpdates, sendMessage, sendMessageWithId, pinChatMessage, unpinChatMessage, sendTyping, setMessageReaction, downloadFile, editMessageText, createForumTopic, deleteMessage, sendMessageWithKeyboard } from './telegram.js';
import type { InlineKeyboardMarkup } from './telegram.js';
import {
  handleCallbackQuery,
  handleMessageReaction,
  buildConfirmKeyboard,
  buildFailoverKeyboard,
  buildControlCardKeyboard,
  rememberConfirmMessage,
  currentCardKeyboard,
  clearCardKeyboard,
  type CallbackDeps,
} from './callbacks.js';
import { sendReplyText } from './rich-message.js';
import { loadState, saveState, loadTopicState, saveTopicState, addTurn, findHistoricalSessionTurns, findRecentTurnsByTopic, listTopicStateRefs, type JoinableTurn } from './conversation.js';
import { buildPrompt, buildResumedPrompt, buildSkillStatus } from './context.js';
import { stripAnsi } from './ansi.js';
import {
  expirePendingAction,
  resolveConfirmation,
  consumeConfirmation,
  resolvePendingDescription,
  buildWorkerResponse,
  buildWorkerErrorResponse,
  getAgentSwitchTarget,
  getModelSwitchTarget,
  AGENT_BARE_PATTERN,
  expirePreferredWorker,
  handleDefaultQuery,
  handleCodeCommand,
  handleResetCommand,
  handleNewCommand,
  handleHelpCommand,
  isPassThroughCommand,
  handleBranchCommand,
  handleChildOfCommand,
  handleMergeCommand,
  RESET_PATTERN,
  NEW_PATTERN,
  CODE_PATTERN,
  STATUS_PATTERN,
  KEEP_AWAKE_PATTERN,
  SKILLS_PATTERN,
  HELP_PATTERN,
  AUTH_PATTERN,
  BRANCH_PATTERN,
  CHILD_OF_PATTERN,
  MERGE_PATTERN,
  parseMetadata,
  applyMetaActions,
  renderStatusCard,
  workerReceivesStaticPromptFile,
  resolveEffectiveDefaultWorker,
  buildModelStatusSnapshot,
  hydrateModelStatus,
  modelStatusNeedsRefresh,
  handleSunsetLlmCommand,
  parseTunableCommand,
  setSessionTunable,
  setTopicTunable,
  promoteSessionToTopicDefaults,
  expireTunableOverrides,
  renderTunableReport,
  renderTunableSetResult,
  renderTunableClearResult,
  renderSessionExpiryMessage,
  handleRetranscribeCommand,
  describeForwardOrigin,
  handleHealthCommand,
  handleRefCommand,
  handleClaimsCommand,
  handleReauthCommand,
  handleUpdateBrainCommand,
  COMMIT_PATTERN,
  PUSH_PATTERN,
  PUSH_PUBLIC_PATTERN,
  INVESTIGATE_FLAGGED_PATTERN,
  UPDATE_BRAIN_PATTERN,
  HEALTH_PATTERN,
  REF_PATTERN,
  CLAIMS_PATTERN,
  REAUTH_PATTERN,
  parseReauthCallback,
  type TunableCommand,
  type UpdateBrainResult,
} from './logic.js';
import { runRulesCritic } from './rules-critic.js';
import {
  resolveTunable,
  resolveTunableArgs,
  resolveWorkerLlm,
  resolveWorkerEffort,
  formatWorkerDescriptor,
  selectWorkerTunables,
  mergeTunableArgs,
  validateTunable,
  isKnownValue,
  extractTunableValues,
  declaredValues,
  getTunableSpec,
} from '../../../pa/dist/src/lib/tunables.js';
import { readObservedTunableValues } from '../../../pa/dist/src/lib/tunables-observed.js';
import { getKeepAwakeStatus, toggleKeepAwake } from './keepawake.js';
import {
  runWithFailover,
  executeWorker,
  isRateLimited,
  isWorkerCoolingDown,
  recordRateLimit,
  classifyRateLimit,
  getWorkerCooldown,
  checkWorker,
} from '../../../pa/dist/src/workers.js';
import {
  isSessionValid,
  buildResumeArgs,
  getPriorSessionPath,
} from './session.js';
import { computeBackoff, computePollOffset, LONG_POLL_TIMEOUT } from './poll.js';
import { WatermarkTracker } from './watermark.js';
import { appendDlq, flushDlq } from './dlq.js';
import { deliveredKey, wasDelivered, markDelivered } from './delivered-store.js';
import { addPendingDispatch, removePendingDispatch, updatePendingDispatch, pendingDispatchKey, listPendingDispatches, type PendingDispatch } from './pending-dispatches.js';
import { reapOrphanedDispatches } from './orphan-reaper.js';
import { isTopicRecovering, waitForTopicRecovery } from './recovery-gate.js';
import { isDegraded, startHealthProbe } from './health.js';
import { parseStopSteer, stopTopicWorkers, markTopicStopped, isTopicStopped, consumeTopicStopped } from './worker-stop.js';
import { registerQueuedUpdate, dequeueUpdate, drainQueuedEntries, addHeldEntry, absorbHeldEntries, type QueueEntry, type HeldItem } from './topic-queue.js';
import { updateDashboard } from './dashboard.js';
import type { ConversationState, SessionInfo, PAMeta, ModelStatusSnapshot, ModelStatusReasonCode, TelegramUpdate } from './types.js';
import { loadTopicNames, updateTopicName, setTopicDescription, extractTopicEvent, loadBranches, addBranch, removeBranch, findBranchParent, getTopicName, type TopicNameMap, type BranchIndex } from './topic-names.js';
import { appendKbNote } from './kb-notes.js';
import { formatFailoverMessage, escapeMd } from './notify-format.js';
import { registerBotCommands } from './commands.js';
import { resolveTopicWorkdir, ensureTopicWorkdir, type TopicWorkdir } from './topic-workdir.js';
import { getTopicBrainInfo, getTopicExemptions } from './topic-brains.js';
import {
  buildOAuthCompletionMessage,
  launchOAuthResumeAction,
  normalizeResumeAction,
  redactAuthCommand,
} from './oauth.js';
import {
  transcribeVoiceMessage,
  formatTranscriptUserText,
  formatFailedTranscriptUserText,
  voiceErrorMessage,
  extractAudioAttachment,
  findCachedAudio,
  voiceAttachmentPath,
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
import { findSessionForRefId } from './ref-lookup.js';

// Import pa modules
import { loadSecrets } from '../../../pa/dist/src/secrets.js';
import { markRepliedForThread } from '../../../pa/dist/src/lib/decisions.js';
import { startProxyAutoRefresh } from '../../../pa/dist/src/lib/telegram-proxy.js';
import { cleanupOrphanedWorkers } from '../../../pa/dist/src/worker-pids.js';
import { blackboard, startLockRenewal } from '../../../pa/dist/src/blackboard.js';
import { loadConfig, saveTopicDefault } from '../../../pa/dist/src/config.js';
import type { CommandResult, FailoverNotifyPayload, WorkerConfig } from '../../../pa/dist/src/types.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { formatIST } from '../../../pa/dist/src/ist.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolvePythonCommand } from '../../../pa/dist/src/lib/python.js';
import { paHome } from '../../../pa/dist/src/paths.js';
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

// agy native resume: trialed 2026-08-16 on topic 310, FLEET-WIDE since
// 2026-08-17 (operator directive: feature gates don't outlive their trial —
// roll out and learn fast). EVERY agy topic resumes its native conversation.
// This set is now an emergency EXCLUSION list (empty = all topics resume);
// add a threadId here only if a resume pathology ever shows up on it.
export const AGY_NATIVE_RESUME_EXCLUDED_TOPICS = new Set<string>([]);

// threadId from a `topic-<chatId>_<threadId>` blackboard resource. chatId may be
// NEGATIVE (supergroups: -100...), so never parse it with \d+ — the obvious
// /^topic-\d+_/ regex silently fails on this deployment's own supergroup
// (orchestrator correction 2026-08-17, caught in spec review).
export function threadIdFromResource(resource: string): string {
  if (!resource.startsWith('topic-')) return '';
  const parts = resource.replace(/^topic-/, '').split('_');
  if (parts.length < 2) return ''; // malformed: no underscore, no threadId
  return parts.pop() ?? '';
}

/**
 * extraArgs for one dispatch: the caller's own args (e.g. buildResumeArgs's
 * `--resume <id>`) with this topic's resolved tunables APPENDED.
 *
 * The order is load-bearing in two independent ways, so do not flip it:
 *   1. worker-exec.ts splices extraArgs in before a trailing bare '-' stdin
 *      marker (codex's shape) whenever extraArgs is non-empty — fixed
 *      2026-07-22 to fire for ANY non-empty extraArgs there, not just a
 *      leading 'resume' token, because a fresh (non-resume) dispatch with
 *      only tunable args used to fall through to plain appending and land
 *      AFTER the '-' — a silently malformed codex command line.
 *   2. Every CLI here is last-wins on a repeated flag, and worker.args already
 *      pins `--model opusplan` for claude/zclaude. Appending is what lets an
 *      explicitly set value beat the static default.
 * Returns undefined (not []) when nothing is set, so a topic with no tunables
 * produces a byte-identical command line to before this feature existed.
 */
export function buildDispatchExtraArgs(
  state: ConversationState,
  worker: WorkerConfig | undefined,
  baseArgs?: string[],
): string[] | undefined {
  const tunableArgs = resolveTunableArgs(
    worker,
    selectWorkerTunables(state.tunable_overrides, worker?.name),
    selectWorkerTunables(state.tunable_defaults, worker?.name),
  );
  const merged = mergeTunableArgs(baseArgs, tunableArgs);
  return merged.length > 0 ? merged : undefined;
}

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
// pass. Bounded because dlq-flush can stall for minutes during a Telegram
// outage. Uses a real timer, NOT the injected sleepFn — tests inject a
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

function syncModelStatusState(state: ConversationState, snapshot: ModelStatusSnapshot): void {
  state.model_status = snapshot;
  state.pinned_worker = snapshot.current_worker;
}

async function replacePinnedStatusCard(
  token: string,
  chatId: number,
  threadId: number,
  state: ConversationState,
  snapshot: ModelStatusSnapshot,
  keepAwake = getKeepAwakeStatus()
): Promise<{ delivered: boolean; pinned: boolean; messageId: number | null }> {
  const pinText = renderStatusCard({ snapshot, keepAwake });
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

  const pinText = renderStatusCard({ snapshot, keepAwake });
  if (state.pinned_status_message_id) {
    // bp-retry (2026-08-25): this sweep used to unconditionally rewrite the card's
    // keyboard back to the top-level menu, silently stranding a user mid-navigation
    // through a cc:agent/cc:model/cc:effort submenu on the same message id. If a
    // submenu is currently displayed (recorded by callbacks.ts, fresh within its
    // 2-minute window) keep showing it — only the card TEXT changes here either way.
    const keyboard = currentCardKeyboard(chatId, state.pinned_status_message_id) ?? buildControlCardKeyboard();
    const pinOk = await editMessageText(token, chatId, state.pinned_status_message_id, appendRefIdAndLog(pinText, { kind: 'pin', chatId, threadId }), keyboard).catch(() => false);
    if (pinOk) return;
  }

  await replacePinnedStatusCard(token, chatId, threadId, state, snapshot, keepAwake);
}

function buildFailoverReasonText(
  payload: FailoverNotifyPayload | undefined,
  expectedWorker: string,
  dispatchedWorker: string
): string {
  if (!payload) return `Temporary failover from ${expectedWorker} to ${dispatchedWorker}.`;

  if (payload.kind === 'rate-limit') {
    const detail = payload.classification ? `${payload.classification} rate limit` : 'rate limit';
    return `Temporary failover from ${expectedWorker} to ${dispatchedWorker} due to ${detail}.`;
  }

  const detail = payload.reasonText?.trim();
  if (detail) {
    return `Temporary failover from ${expectedWorker} to ${dispatchedWorker}: ${detail.slice(0, 120)}.`;
  }

  return `Temporary failover from ${expectedWorker} to ${dispatchedWorker}.`;
}

async function maybeUpdatePinnedStatusAfterDispatch(
  token: string,
  chatId: number,
  threadId: number,
  state: ConversationState,
  effectiveDefault: string,
  dispatchedWorker: string,
  failoverPayload?: FailoverNotifyPayload,
  config?: { workers?: WorkerConfig[] }
): Promise<void> {
  const expectedWorker = state.preferred_worker || effectiveDefault;
  const currentSnapshot = hydrateModelStatus(state, effectiveDefault, config);
  const dispatchedWorkerConfig = config?.workers?.find((w: WorkerConfig) => w.name === dispatchedWorker);
  const dispatchedLlm = dispatchedWorkerConfig
    ? resolveWorkerLlm(dispatchedWorkerConfig, selectWorkerTunables(state.tunable_overrides, dispatchedWorker), selectWorkerTunables(state.tunable_defaults, dispatchedWorker))
    : undefined;
  const dispatchedEffort = dispatchedWorkerConfig
    ? resolveWorkerEffort(dispatchedWorkerConfig, selectWorkerTunables(state.tunable_overrides, dispatchedWorker), selectWorkerTunables(state.tunable_defaults, dispatchedWorker))
    : undefined;

  if (dispatchedWorker !== expectedWorker) {
    const nextSnapshot = buildModelStatusSnapshot({
      currentWorker: dispatchedWorker,
      defaultWorker: effectiveDefault,
      reasonCode: 'failover',
      reasonText: buildFailoverReasonText(failoverPayload, expectedWorker, dispatchedWorker),
      currentLlm: dispatchedLlm,
      currentEffort: dispatchedEffort,
    });
    syncModelStatusState(state, nextSnapshot);
    if (modelStatusNeedsRefresh(currentSnapshot, nextSnapshot) || !state.pinned_status_message_id) {
      await refreshPinnedStatusCardInPlace(token, chatId, threadId, state, effectiveDefault, getKeepAwakeStatus(), config);
    }
    return;
  }

  if (currentSnapshot.current_worker !== expectedWorker || currentSnapshot.reason_code === 'failover') {
    const reasonCode: ModelStatusReasonCode = currentSnapshot.reason_code === 'failover' ? 'recovery' : 'default_active';
    const nextSnapshot = buildModelStatusSnapshot({
      currentWorker: expectedWorker,
      defaultWorker: effectiveDefault,
      reasonCode,
      currentLlm: dispatchedLlm,
      currentEffort: dispatchedEffort,
    });
    syncModelStatusState(state, nextSnapshot);
    if (modelStatusNeedsRefresh(currentSnapshot, nextSnapshot) || !state.pinned_status_message_id) {
      await refreshPinnedStatusCardInPlace(token, chatId, threadId, state, effectiveDefault, getKeepAwakeStatus(), config);
    }
    return;
  }

  if (!state.pinned_status_message_id) {
    await refreshPinnedStatusCardInPlace(token, chatId, threadId, state, effectiveDefault, getKeepAwakeStatus(), config);
    return;
  }

  syncModelStatusState(state, currentSnapshot);
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
  await sendMessage(token, chatId, appendRefIdAndLog(msg, { kind: 'help', chatId, threadId }), undefined, threadId || undefined);
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

async function findNextAvailableWorker(
  currentWorker: string,
  defaultWorker: string | undefined,
  preferredWorker: string | undefined,
  config: { workers: any[] }
): Promise<string | null> {
  if (defaultWorker && defaultWorker !== currentWorker && !(await isWorkerCoolingDown(defaultWorker))) {
    return defaultWorker;
  }
  const excludedWorkers = [currentWorker, preferredWorker].filter(Boolean);
  for (const w of config.workers) {
    if (!excludedWorkers.includes(w.name) && !(await isWorkerCoolingDown(w.name))) {
      return w.name;
    }
  }
  return null;
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

export type ClassifyOutcome =
  | { outcome: 'rate-limit'; nextWorker: string | null }
  | { outcome: 'transient' }
  | { outcome: 'not-rate-limit' };

export async function tryClassifyAndNotify(
  workerName: string,
  result: CommandResult,
  sessionId: string | undefined,
  worker: any,
  config: { workers: any[] },
  state: ConversationState,
  defaultWorker: string | undefined,
  onNotify: ((payload: FailoverNotifyPayload) => Promise<void>) | undefined,
): Promise<ClassifyOutcome> {
  const cls = await classifyRateLimit(workerName, result.output, result.error ?? '', sessionId, worker.state_dir, worker.state_pattern);
  if (cls === null) return { outcome: 'not-rate-limit' };
  if (cls.minutes === 0) return { outcome: 'transient' };
  await recordRateLimit(workerName, cls.minutes, `[${cls.classification}] ${cls.source}`, cls.classification);
  const nextWorker = await findNextAvailableWorker(workerName, defaultWorker, state.preferred_worker, config);
  if (onNotify) {
    await onNotify({ from: workerName, to: nextWorker, kind: 'rate-limit', reasonText: cls.raw ?? cls.source, minutes: cls.minutes, classification: cls.classification, resetsAtIST: cls.resetsAtIST, raw: cls.raw, source: cls.source });
  }
  return { outcome: 'rate-limit', nextWorker };
}

/**
 * Kill-drop rule for agy native-resume trial topics.
 * Returns undefined (drop the session) if the session belongs to an agy
 * worker on a trial topic and shouldDrop is true; otherwise returns the
 * session unchanged.
 */
function maybeDropAgySession(session: SessionInfo | undefined, resource: string, shouldDrop: boolean): SessionInfo | undefined {
  if (!shouldDrop || !session || session.worker !== 'agy') return session;
  if (AGY_NATIVE_RESUME_EXCLUDED_TOPICS.has(threadIdFromResource(resource))) return session;
  return undefined;
}

export async function dispatchMessage(
  userText: string,
  replyContext: string | undefined,
  pendingDesc: string | undefined,
  state: ConversationState,
  secrets: Record<string, string>,
  resource: string,
  defaultWorker?: string,
  topicNames?: TopicNameMap,
  onNotify?: (payload: FailoverNotifyPayload) => Promise<void>,
  updateId?: number,
  workdir?: TopicWorkdir,
  contextId?: string,
): Promise<{
  response: string;
  session: SessionInfo | undefined;
  meta: PAMeta | null;
  rateLimitedWorker?: string;
  dispatchedWorker?: string;
  rateLimitTelemetry?: CommandResult['rateLimitTelemetry'];
  workerError?: boolean;
}> {
  let currentSession = state.session;
  let dispatchResult: { result: CommandResult; worker: string; session: SessionInfo | undefined } | undefined;
  let rateLimitedWorker: string | undefined;
  const failedWorkers = new Set<string>();
  let lastFailedSession: { worker: string; sessionId: string } | undefined;
  const config = await loadConfig();

  // Default workdir if not provided (should always be provided from processUpdate)
  const resolvedWorkdir = workdir ?? { dir: BOT_CWD, tier: 'bot-cwd' };

  // AI-092: /stop and /steer kill the worker running right now, so EVERY
  // attempt below has to consult the marker — the between-phase checks alone
  // left the whole failover cascade uncovered (2026-08-02: a /stop killed
  // a worker mid-chain and claude answered the cancelled message anyway).
  // Handed to pa's executor as `isCancelled`, which stops the cascade and
  // suppresses the worker-exit page for the killed process.
  const stopKey = resource.replace(/^topic-/, '');
  // Never let a marker-lookup failure propagate: this predicate is read from
  // inside a child process's close handler (pa's worker-exec), where a throw
  // would be an unhandled exception in an event handler. Fail toward "not
  // cancelled" — that is the pre-AI-092 behaviour — but say so loudly.
  const isCancelled = () => {
    try {
      return isTopicStopped(stopKey, updateId);
    } catch (err) {
      logger.warn('worker-stop', `stop-marker check failed: ${(err as Error).message}`, { resource });
      return false;
    }
  };

  if (currentSession && await isWorkerCoolingDown(currentSession.worker)) {     
    currentSession = undefined;
  }

  // AI-030: Switch-back logic. If a higher-priority worker is available, drop the current
  // session (likely from a failover worker) to trigger a fresh start on the optimal model.
  if (currentSession) {
    const preferredAvailable = state.preferred_worker && !(await isWorkerCoolingDown(state.preferred_worker));
    const defaultAvailable = defaultWorker && !(await isWorkerCoolingDown(defaultWorker));

    const isOptimal = (currentSession.worker === state.preferred_worker && preferredAvailable) ||
                      (currentSession.worker === defaultWorker && defaultAvailable && !preferredAvailable);

    if ((preferredAvailable || defaultAvailable) && !isOptimal) {
      logger.info('session', `Worker switch-back detected (${currentSession.worker} -> ${preferredAvailable ? state.preferred_worker : defaultWorker}). Resetting session.`);
      currentSession = undefined;
    }
  }
  if (currentSession && await isSessionValid(currentSession, resolvedWorkdir.dir)) {
    const activeSession = currentSession;
    try {
      const worker = config.workers.find((w) => w.name === activeSession.worker);
      if (worker) {
        const prompt = await buildResumedPrompt(userText, replyContext, pendingDesc, topicNames, { omitStatic: workerReceivesStaticPromptFile(worker) });
        const result = await executeWorker(worker, prompt, { cwd: resolvedWorkdir.dir, env: secrets, extraArgs: buildDispatchExtraArgs(state, worker, buildResumeArgs(activeSession)), resource, updateId, agentName: activeSession.worker, contextId, isCancelled, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS });
        if (result.success) {
          dispatchResult = { result, worker: activeSession.worker, session: activeSession };
        } else if (!isCancelled()) {
          const co = await tryClassifyAndNotify(activeSession.worker, result, result.sessionId ?? activeSession.session_id, worker, config, state, defaultWorker, onNotify);
          if (co.outcome === 'rate-limit') rateLimitedWorker = activeSession.worker;
          lastFailedSession = { worker: activeSession.worker, sessionId: result.sessionId ?? activeSession.session_id };
          failedWorkers.add(activeSession.worker);
        }
      }
    } catch (err) { logger.warn('session', 'resume error', { error: String(err) }); }
    if (!dispatchResult) currentSession = undefined;
  }

  if (!dispatchResult) {
    // AI-092: if the user /stop'd this topic while the (session) attempt above
    // was being killed, do NOT fail over to a fresh worker for a cancelled request.
    if (isCancelled()) {
      return { response: '', session: maybeDropAgySession(state.session, resource, true), meta: null, workerError: true };
    }
    let freshResult: { result: CommandResult; worker: string } | undefined;
    if (state.preferred_worker && !failedWorkers.has(state.preferred_worker) && !(await isWorkerCoolingDown(state.preferred_worker))) {
      const preferredWorkerConfig = config.workers.find((w) => w.name === state.preferred_worker);
      if (preferredWorkerConfig) {
        const priorCtx = lastFailedSession ? { ...lastFailedSession, sessionPath: getPriorSessionPath(lastFailedSession.worker, lastFailedSession.sessionId, resolvedWorkdir.dir) } : undefined;
        const prompt = await buildPrompt(userText, state, topicNames, replyContext, pendingDesc, { omitStatic: workerReceivesStaticPromptFile(preferredWorkerConfig), priorContext: priorCtx, workdir: resolvedWorkdir.tier === 'bot-cwd' ? undefined : { dir: resolvedWorkdir.dir, tier: resolvedWorkdir.tier } });
        const prefResult = await executeWorker(preferredWorkerConfig, prompt, { cwd: resolvedWorkdir.dir, env: secrets, extraArgs: buildDispatchExtraArgs(state, preferredWorkerConfig), resource, updateId, agentName: state.preferred_worker, contextId, isCancelled, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS });
        if (prefResult.success) freshResult = { result: prefResult, worker: preferredWorkerConfig.name };
        else if (!isCancelled()) {
          const co = await tryClassifyAndNotify(state.preferred_worker, prefResult, prefResult.sessionId, preferredWorkerConfig, config, state, defaultWorker, onNotify);
          if (co.outcome === 'rate-limit') rateLimitedWorker = state.preferred_worker;
          lastFailedSession = { worker: state.preferred_worker!, sessionId: prefResult.sessionId ?? '' };
          failedWorkers.add(state.preferred_worker);
        }
      }
    }

    // The preferred attempt above may have been the one that got killed.
    if (!freshResult && isCancelled()) {
      return { response: '', session: maybeDropAgySession(state.session, resource, true), meta: null, workerError: true };
    }

    if (!freshResult && defaultWorker && !failedWorkers.has(defaultWorker) && !(await isWorkerCoolingDown(defaultWorker))) {
      const defaultWorkerConfig = config.workers.find((w) => w.name === defaultWorker);
      if (defaultWorkerConfig) {
        const priorCtxDef = lastFailedSession ? { ...lastFailedSession, sessionPath: getPriorSessionPath(lastFailedSession.worker, lastFailedSession.sessionId, resolvedWorkdir.dir) } : undefined;
        const prompt = await buildPrompt(userText, state, topicNames, replyContext, pendingDesc, { omitStatic: workerReceivesStaticPromptFile(defaultWorkerConfig), priorContext: priorCtxDef, workdir: resolvedWorkdir.tier === 'bot-cwd' ? undefined : { dir: resolvedWorkdir.dir, tier: resolvedWorkdir.tier } });
        const defResult = await executeWorker(defaultWorkerConfig, prompt, { cwd: resolvedWorkdir.dir, env: secrets, extraArgs: buildDispatchExtraArgs(state, defaultWorkerConfig), resource, updateId, agentName: defaultWorker, contextId, isCancelled, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS });
        if (defResult.success) freshResult = { result: defResult, worker: defaultWorkerConfig.name };
        else if (!isCancelled()) {
          const co = await tryClassifyAndNotify(defaultWorker, defResult, defResult.sessionId, defaultWorkerConfig, config, state, defaultWorker, onNotify);
          if (co.outcome === 'rate-limit') rateLimitedWorker = rateLimitedWorker ?? defaultWorker;
          lastFailedSession = { worker: defaultWorker!, sessionId: defResult.sessionId ?? '' };
          failedWorkers.add(defaultWorker);
        }
      }
    }

    if (!freshResult) {
      if (isCancelled()) {
        return { response: '', session: maybeDropAgySession(state.session, resource, true), meta: null, workerError: true };
      }
      const priorCtxFo = lastFailedSession ? { ...lastFailedSession, sessionPath: getPriorSessionPath(lastFailedSession.worker, lastFailedSession.sessionId, resolvedWorkdir.dir) } : undefined;
      const failoverPrompt = await buildPrompt(userText, state, topicNames, replyContext, pendingDesc, { omitStatic: false, priorContext: priorCtxFo, workdir: resolvedWorkdir.tier === 'bot-cwd' ? undefined : { dir: resolvedWorkdir.dir, tier: resolvedWorkdir.tier } });
      freshResult = await runWithFailover(failoverPrompt, {
        cwd: resolvedWorkdir.dir,
        env: secrets,
        resource,
        updateId,
        excludeWorkers: failedWorkers,
        onWorkerSwitch: async (payload) => { if (onNotify) await onNotify(payload); },
        checkAvailable: async (w) => !(await isWorkerCoolingDown(w.name)),
        preferredWorker: state.preferred_worker,
        contextId,
        isCancelled,
        harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS,
        getExtraArgs: (w) => buildDispatchExtraArgs(state, w),
      });
      // The cascade stopped because the caller cancelled. Return the same shape
      // as the other three cancellation exits — crucially with the session
      // UNCHANGED: a killed run's session id must not become the topic's.
      //
      // Guarded on FAILURE only. A worker that finished a fraction of a second
      // before the kill landed produced a real answer, and the reply path's
      // consumeTopicStopped deliberately keeps it ("if the worker actually
      // finished before the kill landed, keep its real reply"). Bailing on a
      // successful result here would throw that answer away.
      if (!freshResult.result.success && isCancelled()) {
        return { response: '', session: maybeDropAgySession(state.session, resource, true), meta: null, workerError: true };
      }
    }

    let newSession: SessionInfo | undefined;
    let sessionId: string | undefined;
    if (freshResult.worker === 'claude' || freshResult.worker === 'zclaude' || freshResult.worker === 'codex') {
      sessionId = freshResult.result.sessionId;
    } else if (freshResult.worker === 'agy' && freshResult.result.success && freshResult.result.sessionId) {
      // agy native-resume trial (2026-08-16): capture conversation_id for
      // allowlisted topics only. worker-exec.ts extracts conversation_id from
      // agy's stream-json init/result events when output_format=stream-json.
      // Discovery-by-.db-mtime (discoverAgySessionId) stays DEAD — concurrent
      // contamination risk is unchanged.
      //
      // Kill-drop rule: cancelled dispatches return early (the four
      // maybeDropAgySession exits above), and the success gate here rejects
      // non-zero exits — a failed agy run may still carry a conversation_id
      // captured mid-stream, and resuming a conversation that died mid-run
      // risks corrupt state. So a sessionId arriving here means the dispatch
      // completed successfully. (Integrator fix 2026-08-17: the success gate
      // is load-bearing; claude/zclaude/codex keep their pre-existing
      // capture-without-success-gate behavior, unchanged on purpose.)
      if (!AGY_NATIVE_RESUME_EXCLUDED_TOPICS.has(threadIdFromResource(resource))) {
        // Session-validity check (2026-08-17): verify the session file exists
        // before capturing agy native-resume sessionId. If the .pb/.db file is
        // missing (e.g. external deletion or agy's own GC), skip capture and fall
        // through to sessionless. This prevents resuming a non-existent conversation
        // which would fail on the next dispatch with "conversation not found" errors.
        const agySessionId = freshResult.result.sessionId;
        const agyDir = join(homedir(), '.gemini', 'antigravity-cli', 'conversations');
        let sessionFileExists = false;
        try {
          await stat(join(agyDir, `${agySessionId}.pb`));
          sessionFileExists = true;
        } catch {
          try {
            await stat(join(agyDir, `${agySessionId}.db`));
            sessionFileExists = true;
          } catch {
            // Neither file exists
          }
        }
        if (sessionFileExists) {
          sessionId = agySessionId;
        } else {
          logger.warn('dispatch', 'agy native-resume: session file missing, dropping session', {
            sessionId: agySessionId,
            threadId: threadIdFromResource(resource),
          });
        }
      }
    }
    if (sessionId) newSession = { session_id: sessionId, worker: freshResult.worker, started_at: new Date().toISOString() };
    dispatchResult = { ...freshResult, session: newSession };
  }

  const { result, worker: workerName, session: capturedSession } = dispatchResult;
  const { cleaned, meta } = parseMetadata(result.output, pendingDesc !== undefined);
  if (result.success && cleaned.trim() === '' && meta === null) {
    const suggestedWorker = await findNextAvailableWorker(workerName, defaultWorker, state.preferred_worker, config);
    return { response: buildWorkerErrorResponse({ worker: workerName, emptyResponse: true, suggestedWorker }), session: state.session, meta: null, workerError: true };
  }
  // Only report a dispatchedWorker when it actually succeeded — on full cascade
  // exhaustion, `workerName` is the last worker tried, which still failed. Reporting
  // it here would make main.ts's caller pin the status card to a broken worker.
  return { response: buildWorkerResponse({ ...result, output: cleaned }, workerName), session: capturedSession, meta, rateLimitedWorker, dispatchedWorker: result.success ? workerName : undefined, rateLimitTelemetry: result.rateLimitTelemetry, workerError: result.success ? undefined : true };
}

/**
 * Shared by processUpdate's own guard AND the poll loop's enqueue-time
 * pending-dispatch placeholder write (AI-095 follow-up, deep-recheck
 * 2026-07-08, Phase 1A) — kept as ONE predicate so the two checks can't
 * silently drift apart over time (e.g. if the allowed-chat logic later
 * grows a nuance, updating only one copy would reopen the "no placeholder
 * for a disallowed chat" gap).
 */
function isAcceptableUpdate(update: any, allowedChatIds: Set<number>): boolean {
  const msg = update?.message;
  if (!msg) return false;
  // WPE3 (2026-08-18): documents and photos join the accepted set — they route
  // through the same dated-attachment substrate as voice. Disallowed TYPES are
  // accepted here then rejected with a polite local reply in the handler (the
  // placeholder/pending-dispatch record must be written at receipt for crash
  // recovery regardless of whether the type is processable).
  if (!msg.text && !msg.caption && !msg.voice && !msg.audio && !msg.video_note
      && !msg.document && !msg.photo) return false;
  if (!allowedChatIds.has(msg.chat?.id)) return false;
  return true;
}

/** Same shape isAcceptableUpdate/processUpdate agree on for the real archived
 * text (hardened plan WP6 item 3): a voice/audio/video_note marker wins over
 * a caption, matching formatTranscriptUserText's own precedence, rather than
 * the caption winning as the placeholder previously did. Kept in this file,
 * next to isAcceptableUpdate, for the same reason that predicate is — so the
 * two checks can't silently drift apart. An audio-mime document is left as a
 * plain caption dispatch here too — the "not transcribed" hint text only
 * exists on the real (post-transcription-attempt) path, not the placeholder. */
function placeholderDispatchText(msg: any): string {
  const kind: AudioAttachmentKind | undefined = msg.voice ? 'voice' : msg.audio ? 'audio' : msg.video_note ? 'video_note' : undefined;
  if (kind) {
    const label = kind === 'voice' ? '[Voice message]' : kind === 'audio' ? '[Audio file]' : '[Video note]';
    return msg.caption ? `${label} ${msg.caption}`.trim() : label;
  }
  return (msg.text || msg.caption || '').trim();
}

/** Deterministic trigger for one of this repo's git-workflow skills
 * (~/.pa/skills/<skillName>/skill.md) — spawns it fire-and-forget and returns
 * the standard ack text. All the actual git-safety logic lives in the skill
 * file itself, never here; this exists only because a git push, and possibly
 * a public-mirror auto-merge, is consequential enough that the trigger must
 * not depend on an LLM correctly inferring intent from a bare slash command
 * (unlike the PA_META run_skill dispatch below, which is LLM-inferred by
 * design for lower-stakes skills). Every skill in this family reports to the
 * fixed "My PA" general topic (thread 0) regardless of where it was
 * triggered from — the ack text says so explicitly so that's never a surprise. */
function dispatchGitWorkflowSkill(skillName: string): string {
  spawn('pa', ['run', skillName], { cwd: BOT_CWD, detached: true, stdio: 'ignore', shell: true, windowsHide: true }).unref();
  return `🚀 Kicked off \`${skillName}\` — it reports back in the main "My PA" topic when done, not necessarily here.`;
}

/** Fire-and-forget request for a fresh Google OAuth link, delivered to THIS
 *  chat/thread by the start script itself (AI-147: the script used to mint a
 *  session and print a URL nobody received). Never routed to an LLM worker.
 *  `runtimeEnv` (process.env merged with secrets.env) is a local of
 *  processUpdate, not module scope — passed explicitly so this stays a
 *  top-level function alongside dispatchGitWorkflowSkill (spec deviation,
 *  see WP-G2 report: the draft closed over `runtimeEnv` from a scope this
 *  function cannot see). */
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

/**
 * Execute a pa CLI command synchronously and return trimmed stdout.
 * Used for read-only commands like /health, /ref, and /claims.
 */
function execPaCommand(args: string[], maxChars: number = 1200): string {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const stdout = execFileSync(
      'node',
      ['pa/dist/bin/pa.js', ...args],
      { cwd: BOT_CWD, windowsHide: true, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 30000 }
    ) as string;
    const stripped = stripAnsi(stdout);
    const output = stripped.trim();
    if (output.length <= maxChars) return output;
    return output.slice(0, maxChars) + '…';
  } catch (err: any) {
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    const errorMsg = stderr || err?.message || String(err);
    return `Error: ${errorMsg.slice(0, 200)}`;
  }
}

/**
 * Execute pa ref <id> and return the lookup result, chunked if needed.
 */
function execPaRef(refId: string): string {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const stdout = execFileSync(
      'node',
      ['pa/dist/bin/pa.js', 'ref', refId],
      { cwd: BOT_CWD, windowsHide: true, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 30000 }
    ) as string;
    const output = stdout.trim();
    const chunks: string[] = [];
    const remaining = output;
    const MAX_CHUNK = 4000;
    if (output.length <= MAX_CHUNK) return output;

    let idx = 0;
    while (idx < output.length) {
      chunks.push(output.slice(idx, idx + MAX_CHUNK));
      idx += MAX_CHUNK;
    }
    return chunks[0] + '\n\n_(`' + refId + '` output truncated — full result at terminal)_';
  } catch (err: any) {
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    const errorMsg = stderr || err?.message || String(err);
    return `Error: ${errorMsg.slice(0, 200)}`;
  }
}

// AI-114: covers orphan-reaper.ts's 45-min REAP_MAX_WAIT_MS plus slack, so the
// pa-host orphan-worker-reap maintenance job (runs every minute) doesn't kill
// a worker the bot is still waiting to harvest a reply from.
const ORPHAN_HARVEST_WINDOW_MS = 50 * 60 * 1000;

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

    // Hoisted above the voice-handling block (hardened plan WP6 item 4) —
    // load-bearing: without this, a failed note's bracketed error text
    // (>25 chars) would reach the pendingDescription branch below and
    // silently rename the topic, since that branch used to be the first
    // thing to see `userText` after this block ran.
    let response = '';
    let skipWorker = false;
    // Set when userText came from a transcribed voice/audio message, not typed
    // by the user — guards the pendingDescription branch below from treating a
    // transcribed sentence as an intentional answer to "what's this topic for?".
    let voiceTranscribed = false;

    const audioAttachment = extractAudioAttachment(msg);
    // A5: __skipVoice for command-captioned media — skip transcription entirely.
    // The normalizer set this when enqueue saw a caption starting with '/'.
    if ((update as any).__skipVoice) {
      // Leave userText as-is (caption or text). No transcription.
      // Fall through to command parsing with the original caption.
    } else if (audioAttachment) {
      // A5/D2: Consume prefetched result if present; otherwise transcribe inline.
      let vr: VoiceResult;
      const prefetched = (update as any).__voiceResult as VoiceResult | undefined;
      if (prefetched) {
        vr = prefetched;
      } else {
        vr = await transcribeVoiceMessage(token, chatId, audioAttachment.media, {
          repoRoot: BOT_CWD,
          env: runtimeEnv,
          transcription: config.transcription,
          threadId,
        }, audioAttachment.kind);
      }
      const forwardedFrom = describeForwardOrigin(msg);
      if (!vr.ok) {
        // D2: If normalizer already combined held entries + transcript, don't overwrite.
        if (!(update as any).__heldAbsorbed) {
          userText = formatFailedTranscriptUserText(audioAttachment.kind, vr.reason, { caption: msg.caption });
        }
        response = voiceErrorMessage(vr);
        skipWorker = true;
      } else {
        // D2: If normalizer already set userText (held + transcript), don't overwrite.
        if ((update as any).__heldAbsorbed) {
          voiceTranscribed = true;
        } else {
          userText = formatTranscriptUserText(vr.text, {
            truncated: vr.truncated,
            caption: msg.caption,
            kind: audioAttachment.kind,
            fileName: audioAttachment.media.file_name,
            speakers: vr.speakers,
            forwardedFrom,
          });
          voiceTranscribed = true;
        }
      }
    } else if (msg.document?.mime_type && /^(audio|video)\//.test(msg.document.mime_type)) {
      // Audio/video uploaded as a generic document — deliberately not routed
      // through transcription (no `duration` field to pre-download-guard,
      // and Telegram's own 20MB getFile ceiling makes a large one fail ugly;
      // hardened plan WP6 item 1). One hint line so the caption isn't
      // dispatched with no indication the attachment was ignored.
      const hint = '[An audio file was attached as a document and was not transcribed. Re-send it as a voice note or audio message to have it transcribed.]';
      userText = userText ? `${userText}\n\n${hint}` : hint;
    } else if (msg.document || msg.photo) {
      // WPE3 (2026-08-18): document/photo attachments — download to the same
      // dated substrate as voice, allowlist the type, and inject the path into
      // userText (the format context.ts's Attachments section also uses).
      const ALLOWED_DOC_EXT = /\.(pdf|jpe?g|png|webp|txt|md|csv|xlsx|zip)$/i;
      const docName = msg.document?.file_name;
      const photo = Array.isArray(msg.photo) ? msg.photo[msg.photo.length - 1] : undefined; // largest size
      const fileName = docName ?? (photo ? `photo_${photo.file_unique_id}.jpg` : undefined);
      if (!fileName || !ALLOWED_DOC_EXT.test(fileName)) {
        userText = userText ? `${userText}\n\n[Attachment ${fileName ?? '(unnamed)'} rejected: allowed types are pdf, jpg, png, webp, txt, md, csv, xlsx, zip.]` : `[Attachment ${fileName ?? '(unnamed)'} rejected: allowed types are pdf, jpg, png, webp, txt, md, csv, xlsx, zip.]`;
      } else {
        const media = (msg.document ?? photo) as { file_id: string; file_unique_id: string };
        const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase() : 'bin';
        try {
          const destPath = voiceAttachmentPath(chatId, media.file_unique_id, new Date(), ext);
          // Create parent directory before download (downloadFile does not do this itself)
          const { dirname } = require('node:path');
          mkdirSync(dirname(destPath), { recursive: true });
          const ok = await downloadFile(token, media.file_id, destPath);
          if (!ok) throw new Error('downloadFile returned false');
          logger.info('attachments', 'downloaded attachment', { chatId, threadId, fileName, destPath });
          const line = `[Attachment: ${fileName} at ${destPath}]`;
          userText = userText ? `${userText}\n\n${line}` : line;
        } catch (err: any) {
          logger.warn('attachments', 'attachment download failed', { error: err?.message ?? String(err), fileName });
          userText = userText ? `${userText}\n\n[Attachment ${fileName} failed to download — see pa-alerts log.]` : `[Attachment ${fileName} failed to download — see pa-alerts log.]`;
        }
      }
    }

    let archivedUserText = userText;
    const workerExpired = expirePreferredWorker(topicState);
    // Session-tier tunables share preferred_worker's IST-day lifecycle, but are
    // expired per entry (see expireTunableOverrides). No status-card change:
    // they are not part of the pinned model snapshot.
    const expiredTunables = expireTunableOverrides(topicState);
    if (expiredTunables.length > 0) {
      logger.info('tunables', `expired ${expiredTunables.length} session override(s) at the IST day boundary`, { topic: topicKey, cleared: expiredTunables });
    }
    if (AUTH_PATTERN.test(userText)) {
      const match = AUTH_PATTERN.exec(userText);
      const code = match![1];
      const authState = match![2];
      logger.info('auth', `Authorization code received via Telegram (chat=${chatId})`);
      archivedUserText = redactAuthCommand();
      
      deleteMessage(token, chatId, messageId).catch(() => {});

      const exchangeScript = runtimeEnv.PA_OAUTH_FINISH_SCRIPT || join(BOT_CWD, 'pa', 'scripts', 'finish_google_telegram_reauth.py');
      const exchangeArgs = [exchangeScript, '--code', code];
      if (authState) exchangeArgs.push('--state', authState);
      if (runtimeEnv.PA_OAUTH_SECRETS_FILE) exchangeArgs.push('--secrets-file', runtimeEnv.PA_OAUTH_SECRETS_FILE);
      if (runtimeEnv.PA_OAUTH_STATE_FILE) exchangeArgs.push('--state-file', runtimeEnv.PA_OAUTH_STATE_FILE);
      if (runtimeEnv.PA_OAUTH_TOKEN_FILE) exchangeArgs.push('--token-file', runtimeEnv.PA_OAUTH_TOKEN_FILE);
      const exchangeProc = spawn(resolvePythonCommand(runtimeEnv), exchangeArgs, { shell: true, env: runtimeEnv, windowsHide: true });
      
      let exchangeOut = '';
      exchangeProc.stdout.on('data', (d) => exchangeOut += d.toString());
      
      const exchangeResult = await new Promise<any>((resolve) => {
        exchangeProc.on('close', () => {
          try { resolve(JSON.parse(exchangeOut)); }
          catch { resolve({ error: 'Failed to parse exchange output.' }); }
        });
      });

      const resumeStatus = launchOAuthResumeAction(normalizeResumeAction(exchangeResult), {
        cwd: BOT_CWD,
        env: runtimeEnv,
      });
      response = buildOAuthCompletionMessage(exchangeResult, resumeStatus);
      skipWorker = true;
    }

    if (workerExpired) {
      await refreshPinnedStatusCardInPlace(token, chatId, threadId, topicState, effectiveDefault, getKeepAwakeStatus(), config);
    }

    if (!userText && !audioAttachment && !msg.document && !msg.photo) {
      skipWorker = true;
    }

    if (userText) {
      // B5: a requeued synthetic's user turn was already archived at first receipt
      // (AI-095 item 2); re-adding would duplicate it in the rolling window.
      if ((update as any).__requeueCount === undefined) {
        const userTurn: JoinableTurn = { role: 'user', text: archivedUserText, timestamp, message_id: messageId, worker: topicState.preferred_worker || effectiveDefault, session_id: topicState.session?.session_id, update_id: update.update_id, via: (update as any).__synthetic };
        addTurn(topicState, userTurn);
        markRepliedForThread(chatId, threadId);
        // AI-095 item 2: persist + archive the user turn AT RECEIPT. A crash during
        // the (possibly minutes-long) dispatch must not erase the user's message from
        // topic state / conversation-history.jsonl — 2026-07-03 lost two user turns
        // this way. Watermark dedup makes the second save at the end idempotent.
        await saveTopicState(topicState).catch((err) => logger.warn('conversation', 'early user-turn save failed', { error: String(err) }));
      }
    }

    
    

    if (!skipWorker && userText && AGENT_BARE_PATTERN.test(userText.trim())) {
      const activeWorker = topicState.preferred_worker || effectiveDefault;
      const workerList = (config?.workers ?? []).map((w: WorkerConfig) => w.name).join(', ') || 'agy, claude, codex, zclaude';
      response = `*Agent Status*\n` +
        `Current: *${activeWorker}* (${topicState.preferred_worker ? 'session override' : 'topic default'})\n` +
        `Default: *${effectiveDefault}*\n` +
        `Available: ${workerList}\n\n` +
        `Use \`/agent <name>\` to switch agent, and \`/model <name>\` to set its model.`;
      skipWorker = true;
    }

    const agentSwitch = (!skipWorker && userText) ? getAgentSwitchTarget(userText) : undefined;
    if (agentSwitch) {
      const modelTarget = agentSwitch.target;
      const prevWorker = topicState.preferred_worker || effectiveDefault;
      const prevWorkerConfig = config?.workers?.find((w: WorkerConfig) => w.name === prevWorker);
      const prevLlm = prevWorkerConfig
        ? resolveWorkerLlm(prevWorkerConfig, selectWorkerTunables(topicState.tunable_overrides, prevWorker), selectWorkerTunables(topicState.tunable_defaults, prevWorker))
        : undefined;
      const prevEffort = prevWorkerConfig
        ? resolveWorkerEffort(prevWorkerConfig, selectWorkerTunables(topicState.tunable_overrides, prevWorker), selectWorkerTunables(topicState.tunable_defaults, prevWorker))
        : undefined;
      const prevDescriptor = formatWorkerDescriptor(prevWorker, prevLlm, prevEffort);

      const targetWorkerConfig = config?.workers?.find((w: WorkerConfig) => w.name === modelTarget);
      const targetLlm = targetWorkerConfig
        ? resolveWorkerLlm(targetWorkerConfig, selectWorkerTunables(topicState.tunable_overrides, modelTarget), selectWorkerTunables(topicState.tunable_defaults, modelTarget))
        : undefined;
      const targetEffort = targetWorkerConfig
        ? resolveWorkerEffort(targetWorkerConfig, selectWorkerTunables(topicState.tunable_overrides, modelTarget), selectWorkerTunables(topicState.tunable_defaults, modelTarget))
        : undefined;
      const nextDescriptor = formatWorkerDescriptor(modelTarget, targetLlm, targetEffort);

      if (modelTarget === effectiveDefault) {
        topicState.preferred_worker = undefined;
        topicState.preferred_worker_set_at = undefined;
      } else {
        topicState.preferred_worker = modelTarget;
        topicState.preferred_worker_set_at = new Date().toISOString();
      }
      topicState.session = undefined;
      await refreshPinnedStatusCardInPlace(token, chatId, threadId, topicState, effectiveDefault, getKeepAwakeStatus(), config);
      const lifetime = modelTarget === effectiveDefault ? 'topic default' : 'until midnight IST';
      if (agentSwitch.isLegacy) {
        response = `Switched agent: ${prevDescriptor} → ${nextDescriptor} (${lifetime}).\n💡 _Tip: use \`/agent <name>\` to pick the agent and \`/model <name>\` to set its model._`;
      } else {
        response = `Switched agent: ${prevDescriptor} → ${nextDescriptor} (${lifetime}).`;
      }
      skipWorker = true;
    }

    if (!skipWorker && KEEP_AWAKE_PATTERN.test(userText)) {
      const ka = await toggleKeepAwake();
      await refreshPinnedStatusCardInPlace(token, chatId, threadId, topicState, effectiveDefault, ka, config);
      updateDashboard(token, chatId).catch(() => {});
      skipWorker = true;
    }

    if (!skipWorker && RESET_PATTERN.test(userText)) {
      const prevWorker = topicState.preferred_worker || effectiveDefault;
      const prevWorkerConfig = config?.workers?.find((w: WorkerConfig) => w.name === prevWorker);
      const prevLlm = prevWorkerConfig
        ? resolveWorkerLlm(prevWorkerConfig, selectWorkerTunables(topicState.tunable_overrides, prevWorker), selectWorkerTunables(topicState.tunable_defaults, prevWorker))
        : undefined;
      const prevEffort = prevWorkerConfig
        ? resolveWorkerEffort(prevWorkerConfig, selectWorkerTunables(topicState.tunable_overrides, prevWorker), selectWorkerTunables(topicState.tunable_defaults, prevWorker))
        : undefined;
      const prevDescriptor = formatWorkerDescriptor(prevWorker, prevLlm, prevEffort);

      handleResetCommand(topicState);
      const defaultWorkerConfig = config?.workers?.find((w: WorkerConfig) => w.name === effectiveDefault);
      const currentLlm = defaultWorkerConfig
        ? resolveWorkerLlm(defaultWorkerConfig, selectWorkerTunables(topicState.tunable_overrides, effectiveDefault), selectWorkerTunables(topicState.tunable_defaults, effectiveDefault))
        : undefined;
      const currentEffort = defaultWorkerConfig
        ? resolveWorkerEffort(defaultWorkerConfig, selectWorkerTunables(topicState.tunable_overrides, effectiveDefault), selectWorkerTunables(topicState.tunable_defaults, effectiveDefault))
        : undefined;
      const nextDescriptor = formatWorkerDescriptor(effectiveDefault, currentLlm, currentEffort);

      await refreshPinnedStatusCardInPlace(token, chatId, threadId, topicState, effectiveDefault, getKeepAwakeStatus(), config);
      response = renderSessionExpiryMessage(prevDescriptor, nextDescriptor, 'cleared');
      skipWorker = true;
    }

    if (!skipWorker && NEW_PATTERN.test(userText)) {
      const oldSessionId = topicState.session?.session_id;
      const newCmd = handleNewCommand(topicState, userText);
      const replyText = msg.reply_to_message?.text || msg.reply_to_message?.caption;
      let seededTurnsCount = 0;
      if (replyText) {
        const refMatch = /(?:_Ref:\s*|\bRef:\s*)([a-z0-9-]+)(?:_|\b)/i.exec(replyText);
        if (refMatch) {
          const refId = refMatch[1];
          const repliedSessionId = await findSessionForRefId(refId);
          if (repliedSessionId && repliedSessionId !== oldSessionId) {
            const historicalTurns = await findHistoricalSessionTurns(repliedSessionId, threadId, 20);
            if (historicalTurns.length > 0) {
              topicState.turns = historicalTurns;
              seededTurnsCount = historicalTurns.length;
            }
          }
        }
      }
      if (newCmd.instruction) {
        userText = newCmd.instruction;
        archivedUserText = newCmd.instruction;
        addTurn(topicState, {
          role: 'user',
          text: newCmd.instruction,
          timestamp,
          message_id: messageId,
          worker: topicState.preferred_worker || effectiveDefault,
        });
        skipWorker = false;
      } else {
        response = seededTurnsCount > 0
          ? `🔄 Context reset and seeded with ${seededTurnsCount} turn(s) from previous session.`
          : '🔄 Context cleared and ready for a fresh session.';
        skipWorker = true;
      }
    }

    if (!skipWorker && CODE_PATTERN.test(userText)) {
      const codeCmd = handleCodeCommand(topicState, userText, { dir: workdir.dir, tier: workdir.tier });
      if (codeCmd.action === 'show' || codeCmd.action === 'reset') {
        response = codeCmd.response;
        skipWorker = true;
      } else if (codeCmd.action === 'set' && codeCmd.path) {
        let dirExists = false;
        try {
          const st = await stat(codeCmd.path);
          dirExists = st.isDirectory();
        } catch {
          dirExists = false;
        }
        if (!dirExists) {
          response = `⚠️ Directory not found: \`${codeCmd.path}\``;
          skipWorker = true;
        } else {
          topicState.cwd_override = codeCmd.path;
          topicState.session = undefined;
          if (codeCmd.instruction) {
            userText = codeCmd.instruction;
            archivedUserText = codeCmd.instruction;
            if (topicState.turns.length > 0 && topicState.turns[topicState.turns.length - 1].role === 'user') {
              topicState.turns[topicState.turns.length - 1].text = codeCmd.instruction;
            }
            skipWorker = false;
          } else {
            response = `📁 Working directory set to: \`${codeCmd.path}\``;
            skipWorker = true;
          }
        }
      }
    }

    if (!skipWorker) {
      const dq = handleDefaultQuery(userText);
      if (dq.matched) {
        const prevDefault = effectiveDefault;
        const prevDefaultConfig = config?.workers?.find((w: WorkerConfig) => w.name === prevDefault);
        const prevDefaultDescriptor = formatWorkerDescriptor(
          prevDefault,
          prevDefaultConfig ? resolveWorkerLlm(prevDefaultConfig, undefined, selectWorkerTunables(topicState.tunable_defaults, prevDefault)) : undefined,
          prevDefaultConfig ? resolveWorkerEffort(prevDefaultConfig, undefined, selectWorkerTunables(topicState.tunable_defaults, prevDefault)) : undefined
        );

        if (dq.worker) {
          await saveTopicDefault(topicKey, dq.worker);
          effectiveDefault = dq.worker;
          topicState.preferred_worker = undefined;
          topicState.preferred_worker_set_at = undefined;
        } else {
          // /default with no arguments: make current active configuration default at topic level
          const currentWorker = topicState.preferred_worker || effectiveDefault;
          await saveTopicDefault(topicKey, currentWorker);
          effectiveDefault = currentWorker;
          promoteSessionToTopicDefaults(topicState, currentWorker);
        }
        topicState.session = undefined;

        const nextDefaultConfig = config?.workers?.find((w: WorkerConfig) => w.name === effectiveDefault);
        const nextDefaultDescriptor = formatWorkerDescriptor(
          effectiveDefault,
          nextDefaultConfig ? resolveWorkerLlm(nextDefaultConfig, undefined, selectWorkerTunables(topicState.tunable_defaults, effectiveDefault)) : undefined,
          nextDefaultConfig ? resolveWorkerEffort(nextDefaultConfig, undefined, selectWorkerTunables(topicState.tunable_defaults, effectiveDefault)) : undefined
        );

        await refreshPinnedStatusCardInPlace(token, chatId, threadId, topicState, effectiveDefault, getKeepAwakeStatus(), config);
        if (dq.worker) {
          response = `Topic default agent set: ${prevDefaultDescriptor} → ${nextDefaultDescriptor} (persists).`;
        } else {
          response = `Topic default set to current configuration: ${prevDefaultDescriptor} → ${nextDefaultDescriptor} (persists).`;
        }
        skipWorker = true;
      }
    }

    // Sunsetted commands: /llm and /default llm
    if (!skipWorker) {
      const sunset = handleSunsetLlmCommand(userText);
      if (sunset.matched) {
        response = sunset.response;
        skipWorker = true;
      }
    }

    // Model and effort knobs: /model and /effort (session tier), plus the /default
    // <setting> <value> extension (topic tier). Checked AFTER handleDefaultQuery
    // so `/default <worker>` keeps its existing meaning — parseTunableCommand
    // also refuses the worker form itself, so the two can never both fire.
    if (!skipWorker) {
      const tunableCmd = parseTunableCommand(userText);
      if (tunableCmd) {
        response = await handleTunableCommand(tunableCmd, topicState, config, effectiveDefault);
        if (tunableCmd.action === 'set' || tunableCmd.action === 'clear') {
          await refreshPinnedStatusCardInPlace(token, chatId, threadId, topicState, effectiveDefault, getKeepAwakeStatus(), config);
        }
        skipWorker = true;
      }
    }

    // Hardened plan WP6 item 6: /retranscribe [engine], replying to a voice/
    // audio/video_note message. Always re-transcribes AND dispatches the
    // result through the normal chain (not a show-only mode) — simpler, one
    // behavior to explain, per the plan.
    if (!skipWorker) {
      const rt = handleRetranscribeCommand(userText);
      if (rt.matched) {
        const target = extractAudioAttachment(msg.reply_to_message ?? {});
        if (!target) {
          response = 'Reply to a voice note or audio message with /retranscribe to try again.';
          skipWorker = true;
        } else {
          const cachedPath = await findCachedAudio(chatId, target.media.file_unique_id).catch(() => undefined);
          const vr = await transcribeVoiceMessage(token, chatId, target.media, {
            repoRoot: BOT_CWD,
            env: runtimeEnv,
            transcription: config.transcription,
            threadId,
            engineOverride: rt.engine,
            cachedPath,
          }, target.kind);
          if (!vr.ok) {
            response = voiceErrorMessage(vr);
            skipWorker = true;
          } else {
            const engineLabel = rt.engine ?? vr.engine;
            await sendMessage(token, chatId, `🎙 Re-transcribed (${engineLabel}):\n\n${vr.text}`, messageId, threadId).catch(() => {});
            userText = formatTranscriptUserText(vr.text, {
              truncated: vr.truncated,
              kind: target.kind,
              fileName: target.media.file_name,
              speakers: vr.speakers,
            });
            archivedUserText = userText;
            voiceTranscribed = true;
          }
        }
      }
    }

    // Deterministic read-only commands: /status, /skills, /help, /health, /ref <id>, /claims
    if (!skipWorker && STATUS_PATTERN.test(userText)) {
      const ka = await getKeepAwakeStatus();
      const snapshot = hydrateModelStatus(topicState, effectiveDefault, config);
      response = appendRefIdAndLog(renderStatusCard({ snapshot, keepAwake: ka }), { kind: 'pin', chatId, threadId });
      skipWorker = true;
    }

    if (!skipWorker && SKILLS_PATTERN.test(userText)) {
      const skillStatus = await buildSkillStatus();
      response = appendRefIdAndLog(`*Scheduled Skills*\n\n${skillStatus}`, { kind: 'system', chatId, threadId });
      skipWorker = true;
    }

    if (!skipWorker && HELP_PATTERN.test(userText)) {
      response = appendRefIdAndLog(handleHelpCommand().response, { kind: 'help', chatId, threadId });
      skipWorker = true;
    }

    // These spawn pa CLI commands synchronously and return trimmed output.
    if (!skipWorker && HEALTH_PATTERN.test(userText)) {
      const healthResult = execPaCommand(['health', '--no-color'], 3500);
      response = appendRefIdAndLog(healthResult, { kind: 'system', chatId, threadId });
      skipWorker = true;
    }

    if (!skipWorker && REF_PATTERN.test(userText)) {
      const refCmd = handleRefCommand(userText);
      if (refCmd.matched && refCmd.refId) {
        const refResult = execPaRef(refCmd.refId);
        response = appendRefIdAndLog(refResult, { kind: 'system', chatId, threadId });
        skipWorker = true;
      }
    }

    if (!skipWorker && CLAIMS_PATTERN.test(userText)) {
      const claimsResult = execPaCommand(['claims'], 1200);
      response = appendRefIdAndLog(claimsResult, { kind: 'system', chatId, threadId });
      skipWorker = true;
    }

    if (!skipWorker && REAUTH_PATTERN.test(userText)) {
      const parsed = handleReauthCommand(userText);
      response = appendRefIdAndLog(spawnReauthLink(chatId, threadId, runtimeEnv, parsed.skill), { kind: 'system', chatId, threadId });
      skipWorker = true;
    }

    // The git-workflow skill family: one deterministic Telegram trigger per
    // phase (see dispatchGitWorkflowSkill's own comment for why these bypass
    // LLM inference). Order doesn't matter — the patterns are mutually
    // exclusive by construction (e.g. PUSH_PATTERN's trailing `\s*$` cannot
    // match "/push_public", so it can never shadow PUSH_PUBLIC_PATTERN).
    if (!skipWorker && COMMIT_PATTERN.test(userText)) {
      response = dispatchGitWorkflowSkill('commit');
      skipWorker = true;
    }
    if (!skipWorker && PUSH_PATTERN.test(userText)) {
      response = dispatchGitWorkflowSkill('push');
      skipWorker = true;
    }
    if (!skipWorker && PUSH_PUBLIC_PATTERN.test(userText)) {
      response = dispatchGitWorkflowSkill('push-public');
      skipWorker = true;
    }
    if (!skipWorker && INVESTIGATE_FLAGGED_PATTERN.test(userText)) {
      response = dispatchGitWorkflowSkill('investigate-flagged');
      skipWorker = true;
    }

    // /update_brain interception (§3.4) — deterministic staging or refusal
    if (!skipWorker && UPDATE_BRAIN_PATTERN.test(userText)) {
      const exemptions = await getTopicExemptions();
      const updateBrainResult = handleUpdateBrainCommand(topicState, userText, exemptions);
      if (updateBrainResult.action === 'refusal') {
        response = updateBrainResult.response;
        skipWorker = true;
      } else {
        // mkdir .staged directory (failure → refusal)
        const PA_HOME = process.env.PA_HOME ?? join(homedir(), '.pa');
        const stagedDir = join(PA_HOME, 'topic-brains', '.staged');
        try {
          await mkdir(stagedDir, { recursive: true });
        } catch {
          response = '⚠️ Could not prepare the topic staging directory. Nothing staged.';
          skipWorker = true;
        }
        if (!skipWorker) {
          // Rewrite userText to staging instruction
          userText = updateBrainResult.instruction;
          // Check if brain exists to include brain path in instruction
          const brainInfo = await getTopicBrainInfo(chatId, threadId);
          if (brainInfo) {
            userText = userText.replace('<BRAIN_PATH_ABS>', brainInfo.path);
          } else {
            userText = userText.replace(/ If the topic brain at <BRAIN_PATH_ABS> already records a fact, stage only what is new or changed\./, '');
          }
        }
      }
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

      try {
        const dr = await dispatchMessage(userText, replyContext, confirmedDescription ?? topicState.pending_action?.description, topicState, secrets, resourceId, effectiveDefault, topicNames, onNotify, update.update_id, workdir, contextId);
        response = dr.response; topicState.session = dr.session;
        workerErrored = !!dr.workerError;
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
          const { response: processedResponse, skillToRun, restartBot: metaRestartBot, kbNote } = applyMetaActions(response, dr.meta, topicState);
          response = processedResponse; restartBot = metaRestartBot;
          if (skillToRun) {
            spawn('pa', ['run', skillToRun, '--worker', topicState.preferred_worker || effectiveDefault], { cwd: BOT_CWD, detached: true, stdio: 'ignore', shell: true, windowsHide: true }).unref();
          }
          if (kbNote) {
            // AI-101 Layer 2 — fire-and-forget: a KB-write hiccup must not block
            // or fail the reply that carried the note.
            appendKbNote(kbNote.domain, kbNote.note).catch(() => {});
          }
          if (dr.dispatchedWorker) await maybeUpdatePinnedStatusAfterDispatch(token, chatId, threadId, topicState, effectiveDefault, dr.dispatchedWorker, latestFailoverPayload, config);

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
            addHeldEntry(topicKey, userText);
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
        }
      } finally { clearInterval(typingInterval); }
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
        const wantsConfirm = !!topicState.pending_action && !topicState.pending_action.message_id;
        const kb = workerErrored
          ? buildFailoverKeyboard({ previous: assistantWorker })
          : wantsConfirm
          ? buildConfirmKeyboard()
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

function getUpdateTopicKey(update: any): string {
  const chatId = update.message?.chat?.id;
  const threadId = update.message?.message_thread_id ?? 0;
  return chatId ? `${chatId}_${threadId}` : 'non-message';
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
  });
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
  };
  // Cold-start seeding (AI-100 Wave 2): dlq-flush, delivered-store-compact and
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
  // immediately on the very first pass, every restart).
  const coldStartAt = Date.now();
  for (const name of ['dlq-flush', 'delivered-store-compact', 'proxy-pool-refresh', 'requeue-drain', 'dashboard-refresh']) {
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
  // already-tested runner behavior. dlq-flush is ordered LAST in
  // maintenance-jobs.ts so a stalled flush never delays the cheap jobs
  // sharing its pass. The interval is well under the smallest declared job
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
      const pass: Promise<unknown> = runDueJobs('bot', botJobs, {
        degraded: isDegraded(),
        overrides: maintenanceOverrides,
      })
        .catch((err) => logger.warn('maintenance', `bot maintenance pass failed: ${(err as Error).message}`))
        .finally(() => { activeMaintenancePasses.delete(pass); });
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
      // Injected synthetic updates are drained AFTER the offset above is computed from
      // the real batch only (§3.1, risk R1) — see drainInjectedUpdates()'s own comment.
      const injected = drainInjectedUpdates();
      const batch = injected.length > 0 ? [...injected, ...updates] : updates;
      if (batch.length > 0) {
        // Side-map for steer context attachment in the enqueue block. Cleared each
        // batch to avoid cross-batch contamination.
        const steerContextsByUpdateId = new Map<number, { drainedEntries: QueueEntry[]; steerPrompt?: string; steerVoice?: { promise: Promise<VoiceResult>; descriptor: VoicePrefetchDescriptor } }>();
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
                await sendMessage(token, sChatId, appendRefIdAndLog(reply, { kind: 'system', chatId: sChatId, threadId: sThreadId }), sMessageId, sThreadId);
              } else if (killed === 0) {
                // Steer with nothing running: the prompt below dispatches normally.
                await sendMessage(token, sChatId, appendRefIdAndLog('Nothing was running — dispatching your prompt as a new message.', { kind: 'system', chatId: sChatId, threadId: sThreadId }), sMessageId, sThreadId);
              }
              // A9: drain-to-held and E5 own-audio blocks run ONLY for /stop, not /steer.
              // For /steer, these cause double-prefetch and race with the sync drain.
              if (stopReq.kind === 'stop') {
                // A2: Move drained non-command entries to held. Voice entries: await their
                // already-started prefetch promises and add formatted transcripts to held.
                // Text entries: add directly as strings. This runs in the background after
                // the reply, so slow transcriptions don't block the acknowledgment.
                for (const entry of drained) {
                  if (entry.isCommand) continue;
                  if (entry.voice) {
                    // Prefetch already started at enqueue time. Await it here and add to held.
                    try {
                      const vr = await entry.voice.promise;
                      const formatted = userTextFromVoiceResult(vr, entry.voice.descriptor);
                      addHeldEntry(sTopicKey, formatted);
                    } catch {
                      // If promise rejects (shouldn't happen per WP1 contract), add placeholder.
                      addHeldEntry(sTopicKey, entry.text);
                    }
                  } else {
                    addHeldEntry(sTopicKey, entry.text);
                  }
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
                    stopPrefetch.then((vr) => {
                      const formatted = userTextFromVoiceResult(vr, stopDescriptor);
                      addHeldEntry(sTopicKey, formatted);
                    }).catch(() => {
                      // Add failure placeholder on reject.
                      addHeldEntry(sTopicKey, userTextFromVoiceResult({ ok: false, reason: 'transcribe-failed', message: 'Promise rejected' }, stopDescriptor));
                    });
                  }
                }
              }
            })().catch((err) => logger.warn('worker-stop', `stop/steer failed: ${(err as Error).message}`));
            if (stopReq.kind === 'stop') continue; // fully handled out-of-band
            // /steer handler: drain queued entries and store steerContext for
            // materialization in the normalizer. Held entries are absorbed at
            // normalizer time (A7), not iteration time.
            const drainedEntries = drainQueuedEntries(topicKey);
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
            const steerContext = { drainedEntries, steerPrompt: stopReq.prompt };
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
              stopMsg.text = stopReq.prompt ?? '';
            }
            // Store in the side map for the enqueue block to attach.
            steerContextsByUpdateId.set(update.update_id, { ...steerContext, steerVoice });
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

          // AI-095 follow-up (deep-recheck 2026-07-08, Phase 1A): persist a
          // minimal placeholder record for this update BEFORE it's chained
          // into topicPending — a same-topic update queued behind a
          // still-running predecessor previously existed only in this
          // in-memory chain until its OWN processUpdate reached the
          // dispatch-time addPendingDispatch call (which can be minutes
          // later), and the poll offset covering it is confirmed to
          // Telegram (below) well before that. A crash in that window lost
          // the update with zero trace. Awaited here, synchronously within
          // the loop, so it is guaranteed on disk before saveState(state).
          let enqKey: string | undefined;
          let queueEntry: QueueEntry | undefined;
          if (isAcceptableUpdate(update, allowedChatIds) && update.message) {
            const m = update.message;
            const eChatId = m.chat.id;
            const eThreadId = m.message_thread_id ?? 0;
            const userText = placeholderDispatchText(m);
            enqKey = pendingDispatchKey(eChatId, eThreadId, update.update_id);
            // E8/A5: Compute isCommandOverride from caption for voice/audio/video notes.
            // Command-captioned media skips transcription entirely.
            const hasAudio = !!(m.voice || m.audio || m.video_note);
            let isCommandOverride: boolean | undefined = undefined;
            let skipVoice = false;
            if (hasAudio && m.caption) {
              const captionTrimmed = (m.caption ?? '').trim();
              if (/^\//.test(captionTrimmed)) {
                isCommandOverride = true;
                skipVoice = true; // A5: __skipVoice for command-captioned media
              }
            }
            // A4: Start prefetch for non-command audio-bearing messages.
            // transcription config is hoisted at poll loop level. DEFERRED to
            // after the enqueue-time placeholder write below: the AI-095
            // invariant tests gate on the first /getFile (the prefetch's
            // download) and must observe the placeholder already persisted —
            // trace-before-spawned-work is also the crash-window-safe order.
            let voiceField: { promise: Promise<VoiceResult>; descriptor: VoicePrefetchDescriptor } | undefined = undefined;
            // A5: Store __skipVoice on update for processUpdate to check.
            if (skipVoice) {
              (update as any).__skipVoice = true;
            }
            // Registered BEFORE addPendingDispatch/chaining so a /steer arriving
            // later in this same batch (processed further down this same loop)
            // can already see this update as "queued" and fold it in — see
            // topic-queue.ts.
            queueEntry = registerQueuedUpdate(topicKey, update.update_id, userText, isCommandOverride);
            // Attach steerContext from the side map if present.
            const steerCtx = steerContextsByUpdateId.get(update.update_id);
            if (steerCtx) {
              queueEntry.steerContext = steerCtx;
            }
            // B6: Hoist extractAudioAttachment for voiceFileId and reuse later.
            const eAudio = hasAudio ? extractAudioAttachment(m) : undefined;
            await addPendingDispatch({
              updateId: update.update_id,
              chatId: eChatId,
              threadId: eThreadId,
              messageId: m.message_id,
              userText,
              startedAt: new Date().toISOString(),
              ...(eAudio ? { voiceFileId: eAudio.media.file_id } : {}),
              ...((update as any).__requeueCount !== undefined
                ? { requeueCount: (update as any).__requeueCount as number } : {}),
              // Deliberately no cwd/session — those aren't known until
              // topicState loads inside processUpdate. The dispatch-time
              // addPendingDispatch call (same key) overwrites this with the
              // full record; if a crash strands this placeholder as the
              // only record, the reaper sends a death notice quoting the
              // user's own raw text back to them.
            }).catch((err) => logger.warn('dispatch', 'failed to persist enqueue-time placeholder', { error: String(err) }));
            // A4 (post-placeholder): start the prefetch and attach the voice
            // field. env must include SECRETS (cloud API keys live there) —
            // process.env alone would silently strand prefetch on the local
            // engine (loopRuntimeEnv is built once at poll-loop start).
            if (hasAudio && !skipVoice) {
              const media = eAudio;
              if (media) {
                const descriptor: VoicePrefetchDescriptor = {
                  kind: media.kind,
                  caption: m.caption,
                  forwardedFrom: describeForwardOrigin(m),
                  messageDate: new Date(m.date * 1000).toISOString(),
                };
                const deps = { repoRoot: BOT_CWD, env: loopRuntimeEnv, transcription: loopTranscriptionCfg, threadId: eThreadId };
                startPrefetch(topicKey, update.update_id, token, eChatId, media.media, deps, media.kind, descriptor);
                const prefetch = lookupPrefetch(topicKey, update.update_id);
                if (prefetch) {
                  voiceField = { promise: prefetch, descriptor };
                }
                if (voiceField) {
                  const vf = voiceField;
                  queueEntry.voice = vf;
                  // Edit A (2026-08-27 voice-transcript-backfill spec): when the
                  // arrival-time prefetch settles, merge the formatted text into
                  // the enqueue-time placeholder record. updatePendingDispatch
                  // merges (never clobbers cwd/session/teePath) and no-ops once
                  // the record is removed (turn cleanup in the .finally() below,
                  // or the reaper's finish()). Fires only post-settle, strictly
                  // AFTER the awaited placeholder write above — the AI-095
                  // placeholder-before-spawned-work order is untouched.
                  const backfillKey = enqKey;
                  vf.promise
                    .then((vr) => {
                      if (!backfillKey) return;
                      return updatePendingDispatch(backfillKey, {
                        userText: userTextFromVoiceResult(vr, vf.descriptor),
                        userTextSettled: true,
                      });
                    })
                    .catch((err) => logger.warn('dispatch', 'transcript backfill failed', { error: String(err) }));
                }
              }
            }
          }
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
              if (queueEntry?.voice) {
                try {
                  const vr = await queueEntry.voice.promise;
                  (update as any).__voiceResult = vr;
                } catch {
                  // Should never happen (startPrefetch catches), but defensive.
                }
              }
              // --- Steer fold materialization (D1, A2, A3, A7) ---
              if (queueEntry?.steerContext) {
                const ctx = queueEntry.steerContext;
                const texts: string[] = [];
                // A7: Absorb held entries at normalizer time (not iteration time).
                // These are the OLDEST context — prepend first.
                const heldTexts = await absorbHeldEntries(topicKey);
                texts.push(...heldTexts);
                // Drained entries in arrival order.
                for (const entry of ctx.drainedEntries) {
                  if (entry.voice) {
                    try {
                      const vr = await entry.voice.promise;
                      texts.push(userTextFromVoiceResult(vr, entry.voice.descriptor));
                    } catch {
                      texts.push(entry.text); // fallback to placeholder
                    }
                  } else {
                    texts.push(entry.text);
                  }
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
              }
              // --- Flush-check (step C.2, A8) ---
              if (isTopicStopped(topicKey, update.update_id)) {
                const vr = (update as any).__voiceResult as VoiceResult | undefined;
                const desc = queueEntry?.voice?.descriptor;
                if (!queueEntry?.isCommand) {
                  const text = vr && desc
                    ? userTextFromVoiceResult(vr, desc)
                    : queueEntry?.text ?? placeholderDispatchText(update.message);
                  addHeldEntry(topicKey, text);
                  if (queueEntry?.voice) clearPrefetch(topicKey, queueEntry.updateId);
                  return; // Do NOT run processUpdate
                }
                // A8: Commands never hold and always proceed to processUpdate.
                // Still clean up prefetch if any.
                if (queueEntry?.voice) clearPrefetch(topicKey, queueEntry.updateId);
              }
              // --- Held absorb (step C.3, A2) ---
              if (!queueEntry?.isCommand) {
                const held = await absorbHeldEntries(topicKey);
                if (held.length > 0) {
                  let ownText: string;
                  const vr = (update as any).__voiceResult as VoiceResult | undefined;
                  if (vr && queueEntry?.voice?.descriptor) {
                    ownText = userTextFromVoiceResult(vr, queueEntry.voice.descriptor);
                    (update as any).__heldAbsorbed = true; // D2
                  } else if (update.message) {
                    ownText = (update.message.text || update.message.caption || '').trim();
                  } else {
                    ownText = '';
                  }
                  if (update.message) {
                    update.message = { ...update.message, text: [...held, ownText].join('\n\n') };
                  }
                }
              }
              return processUpdate(update, token, allowedChatIds, secrets, topicNames, branchIndex);
            })
            .catch((err) => logger.warn('poll', `processUpdate rejected: ${(err as Error).message}`, { update_id: update.update_id }))
            .finally(async () => {
              inFlight.delete(p);
              if (topicPending.get(topicKey) === p) topicPending.delete(topicKey);
              // Single choke point covering every processUpdate exit path
              // (dispatch, skip-worker command, a cancelled/folded entry, or a
              // thrown exception) — a normal dispatch already removed its own
              // (upgraded) record at :1018, making this a safe no-op; anything
              // else that left the placeholder behind (including a cancelled
              // entry, which never reaches :1018) gets cleaned up here.
              // B9: a ladder-parked record is the drain's to re-inject — removing it
              // here would silently drop the user's request.
              if (enqKey && !(update as any).__ladderParked) await removePendingDispatch(enqKey).catch(() => {});
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
  process.exit(0);
}

async function main(): Promise<void> {
  const locked = await acquireLock();
  if (!locked) process.exit(0);
  try {
    const secrets = await loadSecrets();
    const token = secrets['TELEGRAM_BOT_TOKEN'];
    const chatIds = (secrets['TELEGRAM_CHAT_ID'] || '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    if (!token || chatIds.length === 0) process.exit(1);
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
      void reapOrphanedDispatches(token, { secrets, requeueUpdate: requeueSyntheticUpdate })
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

import { pathToFileURL } from 'url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.exit(1); });
}
