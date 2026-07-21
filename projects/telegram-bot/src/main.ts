import { spawn, execFile } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { existsSync, unlinkSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { readdir, unlink, rename, writeFile, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { acquireLock, releaseLock } from './lock.js';
import { getUpdates, sendMessage, sendMessageWithId, pinChatMessage, unpinChatMessage, sendTyping, setMessageReaction, downloadFile, editMessageText, createForumTopic, deleteMessage } from './telegram.js';
import { loadState, saveState, loadTopicState, saveTopicState, addTurn, findHistoricalSessionTurns, findRecentTurnsByTopic, listTopicStateRefs } from './conversation.js';
import { buildPrompt, buildResumedPrompt, buildSkillStatus } from './context.js';
import {
  CONFIRMATION_YES,
  CONFIRMATION_NO,
  expirePendingAction,
  resolveConfirmation,
  buildWorkerResponse,
  buildWorkerErrorResponse,
  getModelSwitchTarget,
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
  resolveEffectiveDefaultWorker,
  buildModelStatusSnapshot,
  hydrateModelStatus,
  modelStatusNeedsRefresh,
} from './logic.js';
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
  discoverGeminiSessionId,
  discoverAgySessionId,
  buildResumeArgs,
  cleanupExpiredSessions,
  getPriorSessionPath,
} from './session.js';
import { computeBackoff, computePollOffset, LONG_POLL_TIMEOUT } from './poll.js';
import { WatermarkTracker } from './watermark.js';
import { appendDlq, flushDlq } from './dlq.js';
import { deliveredKey, wasDelivered, markDelivered, compactDelivered } from './delivered-store.js';
import { addPendingDispatch, removePendingDispatch, pendingDispatchKey, listPendingDispatches } from './pending-dispatches.js';
import { reapOrphanedDispatches } from './orphan-reaper.js';
import { isTopicRecovering } from './recovery-gate.js';
import { isDegraded, startHealthProbe } from './health.js';
import { parseStopSteer, stopTopicWorkers, markTopicStopped, unmarkTopicStopped, isTopicStopped, consumeTopicStopped } from './worker-stop.js';
import { updateDashboard } from './dashboard.js';
import type { ConversationState, SessionInfo, PAMeta, ModelStatusSnapshot, ModelStatusReasonCode } from './types.js';
import { loadTopicNames, updateTopicName, setTopicDescription, extractTopicEvent, loadBranches, addBranch, removeBranch, findBranchParent, getTopicName, type TopicNameMap, type BranchIndex } from './topic-names.js';
import { formatFailoverMessage, escapeMd } from './notify-format.js';
import { registerBotCommands } from './commands.js';
import {
  buildOAuthCompletionMessage,
  launchOAuthResumeAction,
  normalizeResumeAction,
  redactAuthCommand,
} from './oauth.js';

// Import pa modules
import { loadSecrets } from '../../../pa/dist/src/secrets.js';
import { startProxyAutoRefresh } from '../../../pa/dist/src/lib/telegram-proxy.js';
import { cleanupOrphanedWorkers } from '../../../pa/dist/src/worker-pids.js';
import { blackboard } from '../../../pa/dist/src/blackboard.js';
import { loadConfig, saveTopicDefault } from '../../../pa/dist/src/config.js';
import type { CommandResult, FailoverNotifyPayload } from '../../../pa/dist/src/types.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { formatIST } from '../../../pa/dist/src/ist.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { RUNTIME_ARCHIVE_MAX_BYTES } from '../../../pa/dist/src/lib/archive-files.js';
import { resolvePythonCommand } from '../../../pa/dist/src/lib/python.js';
import { paHome } from '../../../pa/dist/src/paths.js';

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
// GEMINI_PROJECT_DIR is derived by the Gemini CLI from cwd (lowercased,
// spaces → hyphens). Must match the on-disk slug at ~/.gemini/tmp/<slug>/chats.
// See docs/ARCHITECTURE.md ("Conventions") for the cwd ↔ slug relationship.
const GEMINI_PROJECT_DIR = 'personal-assistant';

// Workers that support --append-system-prompt-file (set globally in config.yaml).
const CLAUDE_FAMILY_WORKERS = new Set(['claude', 'zclaude']);
function workerSupportsSystemPrompt(workerName: string): boolean {
  return CLAUDE_FAMILY_WORKERS.has(workerName);
}

function effectiveCwd(state: ConversationState): string {
  return state.cwd_override || BOT_CWD;
}

const MODEL_SWEEP_INTERVAL_MS = 60_000;
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
// Periodic steady-state maintenance (the startup IIFE runs these once; the
// daemon runs for months, so they must also fire on an interval).
const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;      // DLQ flush/retry + delivered-store compaction
const SESSION_GC_INTERVAL_MS = 6 * 60 * 60 * 1000;  // worker-session TTL prune (heavier full-tree scan)

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
  const pinMsgId = await sendMessageWithId(token, chatId, appendRefIdAndLog(pinText, { kind: 'pin', chatId, threadId }), threadId || undefined);

  syncModelStatusState(state, snapshot);

  if (!pinMsgId) {
    return { delivered: false, pinned: false, messageId: null };
  }

  const pinned = await pinChatMessage(token, chatId, pinMsgId);
  if (pinned) {
    state.pinned_status_message_id = pinMsgId;
    if (oldPinId && oldPinId !== pinMsgId) await unpinChatMessage(token, chatId, oldPinId);
  }

  return { delivered: true, pinned, messageId: pinMsgId };
}

async function refreshPinnedStatusCardInPlace(
  token: string,
  chatId: number,
  threadId: number,
  state: ConversationState,
  effectiveDefault: string,
  keepAwake = getKeepAwakeStatus()
): Promise<void> {
  const snapshot = hydrateModelStatus(state, effectiveDefault);
  syncModelStatusState(state, snapshot);

  const pinText = renderStatusCard({ snapshot, keepAwake });
  if (state.pinned_status_message_id) {
    const pinOk = await editMessageText(token, chatId, state.pinned_status_message_id, appendRefIdAndLog(pinText, { kind: 'pin', chatId, threadId })).catch(() => false);
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
  failoverPayload?: FailoverNotifyPayload
): Promise<void> {
  const expectedWorker = state.preferred_worker || effectiveDefault;
  const currentSnapshot = hydrateModelStatus(state, effectiveDefault);

  if (dispatchedWorker !== expectedWorker) {
    const nextSnapshot = buildModelStatusSnapshot({
      currentWorker: dispatchedWorker,
      defaultWorker: effectiveDefault,
      reasonCode: 'failover',
      reasonText: buildFailoverReasonText(failoverPayload, expectedWorker, dispatchedWorker),
    });
    if (modelStatusNeedsRefresh(currentSnapshot, nextSnapshot) || !state.pinned_status_message_id) {
      await replacePinnedStatusCard(token, chatId, threadId, state, nextSnapshot);
    } else {
      syncModelStatusState(state, nextSnapshot);
    }
    return;
  }

  if (currentSnapshot.current_worker !== expectedWorker || currentSnapshot.reason_code === 'failover') {
    const reasonCode: ModelStatusReasonCode = currentSnapshot.reason_code === 'failover' ? 'recovery' : 'default_active';
    const nextSnapshot = buildModelStatusSnapshot({
      currentWorker: expectedWorker,
      defaultWorker: effectiveDefault,
      reasonCode,
    });
    if (modelStatusNeedsRefresh(currentSnapshot, nextSnapshot) || !state.pinned_status_message_id) {
      await replacePinnedStatusCard(token, chatId, threadId, state, nextSnapshot);
    } else {
      syncModelStatusState(state, nextSnapshot);
    }
    return;
  }

  syncModelStatusState(state, currentSnapshot);
}

export async function runExpiredModelOverrideSweep(
  token: string,
  chatIds: number[]
): Promise<void> {
  const topicRefs = await listTopicStateRefs();
  if (topicRefs.length === 0) return;

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
      const expired = expirePreferredWorker(topicState);

      if (expired) {
        const snapshot = buildModelStatusSnapshot({
          defaultWorker: effectiveDefault,
          reasonCode: 'midnight_reset',
        });
        await replacePinnedStatusCard(token, ref.chatId, ref.threadId, topicState, snapshot);
        await saveTopicState(topicState);
        continue;
      }

      const hydrated = hydrateModelStatus(topicState, effectiveDefault);
      if (modelStatusNeedsRefresh(topicState.model_status, hydrated) || topicState.pinned_worker !== hydrated.current_worker) {
        syncModelStatusState(topicState, hydrated);
        await saveTopicState(topicState);
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
}

// Exported for unit testing.
export function extractReplyContext(msg: { quote?: { text: string }; reply_to_message?: { text?: string; caption?: string } }): string | undefined {
  return msg.quote?.text || msg.reply_to_message?.text || msg.reply_to_message?.caption;
}

const NOTIFY_DEBOUNCE_MS = 10_000;
const notifyDebounce = new Map<string, number>();

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

export type DescriptionRunner = (
  cmd: string,
  args: string[],
  opts: { timeout: number; shell: boolean; stdio: ['ignore', 'pipe', 'pipe'] },
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

export async function generateDescriptionWithLLM(
  name: string,
  sampleTurns?: string,
  runner: DescriptionRunner = execFile as unknown as DescriptionRunner,
): Promise<{ description: string; confident: boolean }> {
  const safeName = name.replace(/[&|<>"^`$\\%]/g, ' ').replace(/\s+/g, ' ').trim();
  const contextPart = sampleTurns
    ? ` Context: ${sampleTurns.replace(/[&|<>"^`$\\%]/g, ' ').slice(0, 200)}`
    : '';
  const userPrompt = `Topic name: ${safeName}.${contextPart}`;

  let args = ['--system-prompt', DESCRIPTION_SYSTEM_PROMPT, '-p', userPrompt, '--output-format', 'text'];
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

      const topicState = await loadTopicState(chatId, threadId);
      if (topicState.pendingDescription) continue;

      const { description } = await generateDescriptionSuggestionWithHistory(entry.name, threadId);
      await postDescriptionSuggestion(token, chatId, threadId, description, entry.name);
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
  if (currentSession && await isSessionValid(currentSession, effectiveCwd(state))) {
    const activeSession = currentSession;
    try {
      const worker = config.workers.find((w) => w.name === activeSession.worker);
      if (worker) {
        const prompt = await buildResumedPrompt(userText, replyContext, pendingDesc, topicNames, { omitStatic: workerSupportsSystemPrompt(activeSession.worker) });
        const result = await executeWorker(worker, prompt, { cwd: effectiveCwd(state), env: secrets, extraArgs: buildResumeArgs(activeSession), resource, agentName: activeSession.worker, contextId });
        if (result.success) {
          dispatchResult = { result, worker: activeSession.worker, session: activeSession };
        } else {
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
    if (isTopicStopped(resource.replace(/^topic-/, ''), updateId)) {
      return { response: '', session: state.session, meta: null, workerError: true };
    }
    let freshResult: { result: CommandResult; worker: string } | undefined;
    if (state.preferred_worker && !failedWorkers.has(state.preferred_worker) && !(await isWorkerCoolingDown(state.preferred_worker))) {
      const preferredWorkerConfig = config.workers.find((w) => w.name === state.preferred_worker);
      if (preferredWorkerConfig) {
        const priorCtx = lastFailedSession ? { ...lastFailedSession, sessionPath: getPriorSessionPath(lastFailedSession.worker, lastFailedSession.sessionId, effectiveCwd(state)) } : undefined;
        const prompt = await buildPrompt(userText, state, topicNames, replyContext, pendingDesc, { omitStatic: workerSupportsSystemPrompt(preferredWorkerConfig.name), priorContext: priorCtx });
        const prefResult = await executeWorker(preferredWorkerConfig, prompt, { cwd: effectiveCwd(state), env: secrets, resource, agentName: state.preferred_worker, contextId });
        if (prefResult.success) freshResult = { result: prefResult, worker: preferredWorkerConfig.name };
        else {
          const co = await tryClassifyAndNotify(state.preferred_worker, prefResult, prefResult.sessionId, preferredWorkerConfig, config, state, defaultWorker, onNotify);
          if (co.outcome === 'rate-limit') rateLimitedWorker = state.preferred_worker;
          lastFailedSession = { worker: state.preferred_worker!, sessionId: prefResult.sessionId ?? '' };
          failedWorkers.add(state.preferred_worker);
        }
      }
    }

    if (!freshResult && defaultWorker && !failedWorkers.has(defaultWorker) && !(await isWorkerCoolingDown(defaultWorker))) {
      const defaultWorkerConfig = config.workers.find((w) => w.name === defaultWorker);
      if (defaultWorkerConfig) {
        const priorCtxDef = lastFailedSession ? { ...lastFailedSession, sessionPath: getPriorSessionPath(lastFailedSession.worker, lastFailedSession.sessionId, effectiveCwd(state)) } : undefined;
        const prompt = await buildPrompt(userText, state, topicNames, replyContext, pendingDesc, { omitStatic: workerSupportsSystemPrompt(defaultWorkerConfig.name), priorContext: priorCtxDef });
        const defResult = await executeWorker(defaultWorkerConfig, prompt, { cwd: effectiveCwd(state), env: secrets, resource, agentName: defaultWorker, contextId });
        if (defResult.success) freshResult = { result: defResult, worker: defaultWorkerConfig.name };
        else {
          const co = await tryClassifyAndNotify(defaultWorker, defResult, defResult.sessionId, defaultWorkerConfig, config, state, defaultWorker, onNotify);
          if (co.outcome === 'rate-limit') rateLimitedWorker = rateLimitedWorker ?? defaultWorker;
          lastFailedSession = { worker: defaultWorker!, sessionId: defResult.sessionId ?? '' };
          failedWorkers.add(defaultWorker);
        }
      }
    }

    if (!freshResult) {
      if (isTopicStopped(resource.replace(/^topic-/, ''), updateId)) {
        return { response: '', session: state.session, meta: null, workerError: true };
      }
      const priorCtxFo = lastFailedSession ? { ...lastFailedSession, sessionPath: getPriorSessionPath(lastFailedSession.worker, lastFailedSession.sessionId, effectiveCwd(state)) } : undefined;
      const failoverPrompt = await buildPrompt(userText, state, topicNames, replyContext, pendingDesc, { omitStatic: false, priorContext: priorCtxFo });
      freshResult = await runWithFailover(failoverPrompt, { cwd: effectiveCwd(state), env: secrets, resource, updateId, excludeWorkers: failedWorkers, onWorkerSwitch: async (payload) => { if (onNotify) await onNotify(payload); }, checkAvailable: async (w) => !(await isWorkerCoolingDown(w.name)), preferredWorker: state.preferred_worker, contextId });
    }

    let newSession: SessionInfo | undefined;
    let sessionId: string | undefined;
    if (freshResult.worker === 'claude' || freshResult.worker === 'zclaude' || freshResult.worker === 'codex') sessionId = freshResult.result.sessionId;
    else if (freshResult.worker === 'gemini') sessionId = freshResult.result.sessionId ?? (await discoverGeminiSessionId(GEMINI_PROJECT_DIR).catch(() => null)) ?? undefined;
    else if (freshResult.worker === 'agy') sessionId = freshResult.result.sessionId ?? (await discoverAgySessionId().catch(() => null)) ?? undefined;
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
  if (!msg.text && !msg.caption) return false;
  if (!allowedChatIds.has(msg.chat?.id)) return false;
  return true;
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
        const newTopicState = await loadTopicState(topicEvent.chatId, topicEvent.threadId);
        if (!newTopicState.pendingDescription) {
          const { description, confident } = await generateDescriptionWithLLM(topicEvent.name);
          await postDescriptionSuggestion(token, topicEvent.chatId, topicEvent.threadId, confident ? description : '', topicEvent.name);
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
  const replyContext = extractReplyContext(msg);
  const contextId = randomUUID();

  setMessageReaction(token, chatId, messageId, '👍').catch(() => {});

  const resourceId = `topic-${chatId}_${threadId}`;
  const acquired = await blackboard.acquireLock(resourceId, 'telegram-bot', process.pid, 60000, contextId);
  if (!acquired) {
    await sendMessage(token, chatId, appendRefIdAndLog('⚠️ Processing is delayed. Please try again in a moment.', { kind: 'lock_busy', chatId, threadId }), messageId, threadId);
    return;
  }

  try {
    const topicState = await loadTopicState(chatId, threadId);
    let restartBot = false;
    const topicKey = topicKeyFor(chatId, threadId);
    const runtimeEnv = { ...process.env, ...secrets };
    let config: any = { workers: [] };
    try { config = await loadConfig(); } catch {}
    let effectiveDefault = getEffectiveDefaultWorker(config, topicKey);

    
    let response = '';
    let skipWorker = false;
    let archivedUserText = userText;
    const workerExpired = expirePreferredWorker(topicState);
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
      const exchangeProc = spawn(resolvePythonCommand(runtimeEnv), exchangeArgs, { shell: true, env: runtimeEnv });
      
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
      const expirySnapshot = buildModelStatusSnapshot({ defaultWorker: effectiveDefault, reasonCode: 'midnight_reset' });
      await replacePinnedStatusCard(token, chatId, threadId, topicState, expirySnapshot);
    }

    addTurn(topicState, { role: 'user', text: archivedUserText, timestamp, message_id: messageId, worker: topicState.preferred_worker || effectiveDefault, session_id: topicState.session?.session_id });
    // AI-095 item 2: persist + archive the user turn AT RECEIPT. A crash during
    // the (possibly minutes-long) dispatch must not erase the user's message from
    // topic state / conversation-history.jsonl — 2026-07-03 lost two user turns
    // this way. Watermark dedup makes the second save at the end idempotent.
    await saveTopicState(topicState).catch((err) => logger.warn('conversation', 'early user-turn save failed', { error: String(err) }));

    
    

    const modelTarget = getModelSwitchTarget(userText);
    if (modelTarget) {
      let nextSnapshot: ModelStatusSnapshot;
      if (modelTarget === effectiveDefault) {
        topicState.preferred_worker = undefined;
        topicState.preferred_worker_set_at = undefined;
        nextSnapshot = buildModelStatusSnapshot({ defaultWorker: effectiveDefault, reasonCode: 'user_selected_default' });
      } else {
        topicState.preferred_worker = modelTarget;
        topicState.preferred_worker_set_at = new Date().toISOString();
        nextSnapshot = buildModelStatusSnapshot({ currentWorker: modelTarget, defaultWorker: effectiveDefault, reasonCode: 'user_override', changedAt: topicState.preferred_worker_set_at });
      }
      topicState.session = undefined;
      await replacePinnedStatusCard(token, chatId, threadId, topicState, nextSnapshot);
      skipWorker = true;
    }

    if (!skipWorker && KEEP_AWAKE_PATTERN.test(userText)) {
      const ka = await toggleKeepAwake();
      await refreshPinnedStatusCardInPlace(token, chatId, threadId, topicState, effectiveDefault, ka);
      updateDashboard(token, chatId).catch(() => {});
      skipWorker = true;
    }

    if (!skipWorker && RESET_PATTERN.test(userText)) {
      response = handleResetCommand(topicState).response;
      await replacePinnedStatusCard(token, chatId, threadId, topicState, buildModelStatusSnapshot({ defaultWorker: effectiveDefault, reasonCode: 'reset' }));
      skipWorker = true;
    }

    if (!skipWorker) {
      const dq = handleDefaultQuery(userText);
      if (dq.matched) {
        if (dq.worker) {
          await saveTopicDefault(topicKey, dq.worker);
          effectiveDefault = dq.worker;
        } else {
          await saveTopicDefault(topicKey, undefined);
          effectiveDefault = resolveEffectiveDefaultWorker(undefined, config?.workers ?? []);
        }
        topicState.preferred_worker = undefined;
        topicState.preferred_worker_set_at = undefined;
        topicState.session = undefined;
        const nextSnapshot = buildModelStatusSnapshot({ currentWorker: effectiveDefault, defaultWorker: effectiveDefault, reasonCode: 'default_changed' });
        await replacePinnedStatusCard(token, chatId, threadId, topicState, nextSnapshot);
        skipWorker = true;
      }
    }

    // AI-028: /branch <name> — create a child topic linked to this one.
    if (!skipWorker) {
      const br = handleBranchCommand(topicState, userText);
      if (br.matched) {
        if (br.branchName) {
          const parentName = getTopicName(topicNames, chatId, threadId) ?? 'parent';
          const newThreadId = await createForumTopic(token, chatId, br.branchName);
          await updateTopicName(topicNames, chatId, newThreadId, br.branchName);
          const branchState = await loadTopicState(chatId, newThreadId);
          branchState.ancestry = { parentChatId: chatId, parentThreadId: threadId, branchName: br.branchName };
          addTurn(branchState, { role: 'assistant', text: `[Branch of: ${parentName}]`, timestamp: new Date().toISOString(), worker: 'local' });
          await saveTopicState(branchState);
          await addBranch(branchIndex, chatId, newThreadId, { parentThreadId: threadId, branchName: br.branchName, createdAt: new Date().toISOString() });
          branchCreatedTopicKeys.add(`${chatId}_${newThreadId}`);
          await sendMessage(token, chatId, appendRefIdAndLog(`🌿 Branch *${br.branchName}* created — continue in the new topic.`, { kind: 'branch', chatId, threadId: newThreadId }), undefined, newThreadId);
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
      const pd = topicState.pendingDescription;
      const short = userText.trim().length <= 25;
      if (short && CONFIRMATION_NO.test(userText)) {
        response = 'OK, skipped.';
        topicState.pendingDescription = undefined;
        skipWorker = true;
      } else if (short && CONFIRMATION_YES.test(userText)) {
        if (pd.text && pd.text.length > 0) {
          await setTopicDescription(topicNames, chatId, threadId, pd.text);
          response = 'Description set.';
          topicState.pendingDescription = undefined;
        } else {
          response = "Okay — type the description and I'll save it.";
        }
        skipWorker = true;
      } else if (!short) {
        // user typed a substantive line instead of yes/no → treat it as the description
        await setTopicDescription(topicNames, chatId, threadId, userText.trim());
        response = 'Description set.';
        topicState.pendingDescription = undefined;
        skipWorker = true;
      }
    }

    if (!skipWorker) {
      expirePendingAction(topicState);
      if (topicState.pending_action) {
        const resolved = resolveConfirmation(topicState, userText);
        response = resolved.response; skipWorker = resolved.skipWorker;
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
      response = '⏳ Still recovering the reply to your previous message after a restart — please resend this once you receive it.';
      skipWorker = true;
    }

    let pendingKey: string | undefined;
    if (!skipWorker) {
      // AI-095: persist the in-flight dispatch so a crash mid-dispatch leaves a
      // recoverable record for the startup orphan reaper instead of a silent void.
      pendingKey = pendingDispatchKey(chatId, threadId, update.update_id);
      await addPendingDispatch({
        updateId: update.update_id, chatId, threadId, messageId,
        userText: archivedUserText, startedAt: new Date().toISOString(),
        cwd: effectiveCwd(topicState), session: topicState.session,
      }).catch((err) => logger.warn('dispatch', 'failed to persist pending dispatch', { error: String(err) }));
      if (!isDegraded()) await sendTyping(token, chatId, threadId);
      // Skip typing while DEGRADED (AI-096): under I/O starvation these calls
      // only queue more doomed work ahead of the reply send.
      const typingInterval = setInterval(() => { if (!isDegraded()) sendTyping(token, chatId, threadId).catch(() => {}); }, 4000);
      let latestFailoverPayload: FailoverNotifyPayload | undefined;
      const onNotify = async (payload: FailoverNotifyPayload) => {
        latestFailoverPayload = payload;
        const msg = formatFailoverMessage(payload);
        await sendMessage(token, chatId, appendRefIdAndLog(msg, { kind: 'failover', chatId, threadId }), messageId, threadId);
      };

      let workerErrored = false;
      try {
        const dr = await dispatchMessage(userText, replyContext, topicState.pending_action?.description, topicState, secrets, resourceId, effectiveDefault, topicNames, onNotify, update.update_id, contextId);
        response = dr.response; topicState.session = dr.session;
        workerErrored = !!dr.workerError;
        const { response: processedResponse, skillToRun, restartBot: metaRestartBot } = applyMetaActions(response, dr.meta, topicState);
        response = processedResponse; restartBot = metaRestartBot;
        if (skillToRun) {
          spawn('pa', ['run', skillToRun, '--worker', topicState.preferred_worker || effectiveDefault], { cwd: BOT_CWD, detached: true, stdio: 'ignore', shell: true }).unref();
        }
        if (dr.dispatchedWorker) await maybeUpdatePinnedStatusAfterDispatch(token, chatId, threadId, topicState, effectiveDefault, dr.dispatchedWorker, latestFailoverPayload);
      } catch (dispatchErr) {
        logger.warn('dispatch', `dispatchMessage error: ${(dispatchErr as Error).message}`);
        response = '⚠️ Service temporarily unavailable.';
        workerErrored = true;
      } finally { clearInterval(typingInterval); }

      // AI-092: a /stop or /steer killed this dispatch's worker. Swap the
      // resulting error for a clean confirmation (stop) or silence (steer —
      // the steer prompt's own dispatch is queued right behind this one). If
      // the worker actually finished before the kill landed, keep its real
      // reply — the marker is consumed either way so it can't leak forward.
      const stoppedKind = consumeTopicStopped(topicKey, update.update_id);
      if (stoppedKind && workerErrored) {
        response = stoppedKind === 'stop' ? '⏹ Stopped.' : '';
      }
    }

    if (response.trim()) {
      const refId = makeRefId();
      const textToSend = `${response.trim()}\n\n_Ref: ${refId}_`;
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
        const delivered = await sendMessage(token, chatId, textToSend, messageId, threadId);
        if (delivered) {
          if (dedupOn) await markDelivered(idemKey);
          addTurn(topicState, { role: 'assistant', text: response.trim(), timestamp: new Date().toISOString(), worker: 'worker', refId });
        } else {
          await appendDlq({ chatId, threadId, replyToMessageId: messageId, text: textToSend, timestamp: new Date().toISOString(), updateId: update.update_id, refId });
        }
      }
    }
    // Reply delivered, DLQ'd (itself persistent), or intentionally empty — the
    // in-flight record has served its purpose either way.
    if (pendingKey) await removePendingDispatch(pendingKey).catch(() => {});
    await saveTopicState(topicState);
    if (restartBot) writeFileSync(join(paHome(), 'telegram-bot.stop'), '');
  } finally { await blackboard.releaseLock(resourceId, 'telegram-bot', contextId); }
}

function getUpdateTopicKey(update: any): string {
  const chatId = update.message?.chat?.id;
  const threadId = update.message?.message_thread_id ?? 0;
  return chatId ? `${chatId}_${threadId}` : 'non-message';
}

async function checkBotLogRotation(): Promise<boolean> {
  const logPath = join(paHome(), 'logs', 'telegram-bot.log');
  try {
    const s = statSync(logPath);
    if (s.size > RUNTIME_ARCHIVE_MAX_BYTES) {
      logger.info('bot', `log file exceeded limit (${(s.size / 1024 / 1024).toFixed(1)}MB) — triggering self-restart for rotation`);
      return true;
    }
  } catch {}
  return false;
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
  let nextSweepAt = 0;
  let nextLogCheckAt = 0;
  // Seeded one interval out: the startup IIFE already ran flushDlq + session GC once.
  let nextMaintenanceAt = Date.now() + MAINTENANCE_INTERVAL_MS;
  let nextSessionGcAt = Date.now() + SESSION_GC_INTERVAL_MS;
  // In-flight guard: a flush during a sustained outage retries every queued
  // entry over the network and can outlive the 5-min interval; without this,
  // each tick would queue ANOTHER full flush behind dlq.ts's FIFO mutex —
  // starving live reply-path appendDlq calls that share it. Skipped ticks are
  // fine: the next free tick picks up the whole queue.
  let maintFlushInFlight = false;
  let consecutiveErrors = 0; // drives escalating getUpdates backoff (capped at MAX_BACKOFF_MS)

  while (!signal.aborted) {
    if (sentinelPath && existsSync(sentinelPath)) break;

    if (!isDegraded() && Date.now() >= nextLogCheckAt) {
      if (await checkBotLogRotation() && sentinelPath) {
        writeFileSync(sentinelPath, String(Date.now()));
        break;
      }
      nextLogCheckAt = Date.now() + 10 * 60 * 1000;
    }

    // Periodic steady-state maintenance. The startup IIFE runs DLQ flush and
    // session GC once, but on a months-long daemon they must re-run so failed
    // replies actually retry (fixes silent DLQ loss) and session/delivered-store
    // growth stays bounded. Fire-and-forget — never delays getUpdates.
    //
    // The DLQ flush deliberately runs even while DEGRADED: it IS reply
    // delivery, not cosmetic work — shedding it for >24h would let queued
    // replies hit the DLQ TTL and silently expire, the exact invariant
    // violation Phase 1 fixed. It's network-bound (not the disk pressure
    // DEGRADED signals) with an ENOENT fast-path when the queue is empty.
    // compactDelivered and session GC are fs-bound housekeeping and ARE shed.
    if (Date.now() >= nextMaintenanceAt) {
      nextMaintenanceAt = Date.now() + MAINTENANCE_INTERVAL_MS;
      if (!maintFlushInFlight) {
        maintFlushInFlight = true;
        void flushDlq(token)
          .then((r) => { if (r.delivered > 0) logger.info('maintenance', 'DLQ retry delivered queued replies', { delivered: r.delivered, remaining: r.remaining }); })
          .catch((err) => logger.warn('maintenance', `DLQ flush failed: ${(err as Error).message}`))
          .finally(() => { maintFlushInFlight = false; });
      }
      if (!isDegraded()) {
        void compactDelivered()
          .then((n) => { if (n > 0) logger.info('maintenance', 'delivered-store compacted', { dropped: n }); })
          .catch((err) => logger.warn('maintenance', `delivered-store compaction failed: ${(err as Error).message}`));
      }
    }
    if (!isDegraded() && Date.now() >= nextSessionGcAt) {
      nextSessionGcAt = Date.now() + SESSION_GC_INTERVAL_MS;
      void cleanupExpiredSessions()
        .then((n) => { if (n > 0) logger.info('maintenance', 'session GC pruned expired transcripts', { deleted: n }); })
        .catch((err) => logger.warn('maintenance', `session GC failed: ${(err as Error).message}`));
    }

    try {
      // Model sweep is shed while DEGRADED (AI-096) — poll + replies come first.
      if (!isDegraded() && Date.now() >= nextSweepAt) {
        await runExpiredModelOverrideSweep(token, chatIds);
        nextSweepAt = Date.now() + MODEL_SWEEP_INTERVAL_MS;
      }
      const timeout = inFlight.size > 0 ? 0 : LONG_POLL_TIMEOUT;
      const updates = await getUpdates(token, computePollOffset(pollOffset), timeout, signal);
      consecutiveErrors = 0; // successful poll — reset backoff
      if (updates.length > 0) {
        pollOffset = updates[updates.length - 1].update_id;
        state.last_update_id = pollOffset;
        for (const update of updates) {
          // AI-092: /stop and /steer act on the topic's RUNNING worker, so they
          // must bypass per-topic serialization (queuing behind the in-flight
          // dispatch would defeat them). Handled here; /steer then re-enters
          // the normal chain as a plain message carrying the steer prompt.
          const stopMsg = update.message;
          const stopReq = stopMsg && allowedChatIds.has(stopMsg.chat?.id)
            ? parseStopSteer((stopMsg.text ?? '').trim())
            : null;
          if (stopReq && stopMsg) {
            const sChatId = stopMsg.chat.id;
            const sThreadId = stopMsg.message_thread_id ?? 0;
            const sMessageId = stopMsg.message_id;
            const sUpdateId = update.update_id;
            void (async () => {
              // Mark BEFORE killing: a fast-dying worker's error path could
              // otherwise race past the consume check before the marker exists.
              markTopicStopped(`${sChatId}_${sThreadId}`, stopReq.kind, sUpdateId);
              const killed = await stopTopicWorkers(sChatId, sThreadId);
              if (killed === 0) unmarkTopicStopped(`${sChatId}_${sThreadId}`);
              if (stopReq.kind === 'stop') {
                const text = killed > 0
                  ? '⏹ Stopping the running worker…'
                  : 'Nothing is running in this topic.';
                await sendMessage(token, sChatId, appendRefIdAndLog(text, { kind: 'system', chatId: sChatId, threadId: sThreadId }), sMessageId, sThreadId);
              } else if (killed === 0) {
                // Steer with nothing running: the prompt below dispatches normally.
                await sendMessage(token, sChatId, appendRefIdAndLog('Nothing was running — dispatching your prompt as a new message.', { kind: 'system', chatId: sChatId, threadId: sThreadId }), sMessageId, sThreadId);
              }
            })().catch((err) => logger.warn('worker-stop', `stop/steer failed: ${(err as Error).message}`));
            if (stopReq.kind === 'stop') continue; // fully handled out-of-band
            stopMsg.text = stopReq.prompt!;        // steer → normal chain with the prompt
          }
          const topicKey = getUpdateTopicKey(update);
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
          if (isAcceptableUpdate(update, allowedChatIds) && update.message) {
            const m = update.message;
            const eChatId = m.chat.id;
            const eThreadId = m.message_thread_id ?? 0;
            enqKey = pendingDispatchKey(eChatId, eThreadId, update.update_id);
            await addPendingDispatch({
              updateId: update.update_id,
              chatId: eChatId,
              threadId: eThreadId,
              messageId: m.message_id,
              userText: (m.text || m.caption || '').trim(),
              startedAt: new Date().toISOString(),
              // Deliberately no cwd/session — those aren't known until
              // topicState loads inside processUpdate. The dispatch-time
              // addPendingDispatch call (same key) overwrites this with the
              // full record; if a crash strands this placeholder as the
              // only record, the reaper sends a death notice quoting the
              // user's own raw text back to them.
            }).catch((err) => logger.warn('dispatch', 'failed to persist enqueue-time placeholder', { error: String(err) }));
          }
          const prev = topicPending.get(topicKey) ?? Promise.resolve();
          const p: Promise<void> = prev
            .then(() => processUpdate(update, token, allowedChatIds, secrets, topicNames, branchIndex))
            .catch((err) => logger.warn('poll', `processUpdate rejected: ${(err as Error).message}`, { update_id: update.update_id }))
            .finally(async () => {
              inFlight.delete(p);
              if (topicPending.get(topicKey) === p) topicPending.delete(topicKey);
              // Single choke point covering every processUpdate exit path
              // (dispatch, skip-worker command, or a thrown exception) — a
              // normal dispatch already removed its own (upgraded) record at
              // :1018, making this a safe no-op; anything else that left the
              // placeholder behind gets cleaned up here.
              if (enqKey) await removePendingDispatch(enqKey).catch(() => {});
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
  if (inFlight.size > 0) await Promise.allSettled(inFlight);
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
      await cleanupExpiredSessions().catch(() => {});
      // AI-095: don't kill orphan workers still serving a crashed-instance dispatch —
      // the reaper below waits for them and harvests their reply instead.
      const pendingAtStartup = await listPendingDispatches().catch(() => [] as Awaited<ReturnType<typeof listPendingDispatches>>);
      const protectedTopics = new Set(pendingAtStartup.map((r) => `topic-${r.chatId}_${r.threadId}`));
      await cleanupOrphanedWorkers(protectedTopics).catch(() => {});
      await flushDlq(token).catch(() => {});
      // AI-095: recover replies from dispatches orphaned by a crashed prior instance.
      // May wait many minutes for an orphan to finish.
      void reapOrphanedDispatches(token).catch((err) => logger.warn('reaper', 'reap failed', { error: String(err) }));
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
