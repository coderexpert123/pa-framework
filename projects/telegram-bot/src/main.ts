import { spawn, execFile } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { existsSync, unlinkSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { readdir, unlink, rename, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { acquireLock, releaseLock } from './lock.js';
import { getUpdates, sendMessage, sendMessageWithId, pinChatMessage, unpinChatMessage, sendTyping, setMessageReaction, downloadFile, editMessageText, createForumTopic } from './telegram.js';
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
import { findSessionForRefId } from './ref-lookup.js';
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
  buildResumeArgs,
  cleanupExpiredSessions,
  getPriorSessionPath,
} from './session.js';
import { computeBackoff, computePollOffset, LONG_POLL_TIMEOUT } from './poll.js';
import { WatermarkTracker } from './watermark.js';
import { appendDlq, flushDlq } from './dlq.js';
import { updateDashboard } from './dashboard.js';
import type { ConversationState, SessionInfo, PAMeta, ModelStatusSnapshot, ModelStatusReasonCode } from './types.js';
import { loadTopicNames, updateTopicName, setTopicDescription, extractTopicEvent, loadBranches, addBranch, removeBranch, findBranchParent, getTopicName, type TopicNameMap, type BranchIndex } from './topic-names.js';
import { formatFailoverMessage, escapeMd } from './notify-format.js';
import { registerBotCommands } from './commands.js';

// Import pa modules
import { loadSecrets } from '../../../pa/dist/src/secrets.js';
import { cleanupOrphanedWorkers } from '../../../pa/dist/src/worker-pids.js';
import { blackboard } from '../../../pa/dist/src/blackboard.js';
import { loadConfig } from '../../../pa/dist/src/config.js';
import type { CommandResult, FailoverNotifyPayload } from '../../../pa/dist/src/types.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { formatIST } from '../../../pa/dist/src/ist.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { RUNTIME_ARCHIVE_MAX_BYTES } from '../../../pa/dist/src/lib/archive-files.js';

/** Topic keys created by /branch — signals forum_topic_created to skip description */
const branchCreatedTopicKeys = new Set<string>();

export function makeRefId(prefix: string = 's'): string {
  return `${prefix}-${randomBytes(2).toString('hex')}`;
}
export function appendRefId(text: string, prefix: string = 's'): string {
  return `${text.trim()}\n\n_Ref: ${makeRefId(prefix)}_`;
}

export type RefKind = 'pin' | 'help' | 'branch' | 'lock_busy' | 'failover' | 'system';

// Mints a refId, logs a 'system message sent' entry for queryability via `pa ref`,
// and returns the message text with the ref appended. Use for bot-system messages
// (pins, help, branch notifications, failover banners, lock-busy notices) — anything
// that's not a worker reply (which has its own 'message sent' log call).
export function appendRefIdAndLog(
  text: string,
  ctx: { kind: RefKind; chatId: number; threadId?: number },
  prefix: string = 's',
): string {
  const refId = makeRefId(prefix);
  logger.info('bot', 'system message sent', {
    refId,
    kind: ctx.kind,
    chatId: ctx.chatId,
    threadId: ctx.threadId,
    textPreview: text.slice(0, 500),
  });
  return `${text.trim()}\n\n_Ref: ${refId}_`;
}

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
    const pinOk = await editMessageText(token, chatId, state.pinned_status_message_id, pinText).catch(() => false);
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
          if (co.outcome === 'not-rate-limit') {
            const suggestedWorker = await findNextAvailableWorker(activeSession.worker, defaultWorker, state.preferred_worker, config);
            const errorText = buildWorkerErrorResponse({ worker: activeSession.worker, exitCode: result.exitCode, stderr: result.error, suggestedWorker });
            return { response: errorText, session: state.session, meta: null, workerError: true };
          }
          if (co.outcome === 'rate-limit') rateLimitedWorker = activeSession.worker;
          lastFailedSession = { worker: activeSession.worker, sessionId: result.sessionId ?? activeSession.session_id };
          failedWorkers.add(activeSession.worker);
        }
      }
    } catch (err) { logger.warn('session', 'resume error', { error: String(err) }); }
    if (!dispatchResult) currentSession = undefined;
  }

  if (!dispatchResult) {
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
          if (co.outcome === 'not-rate-limit') {
            const suggestedWorker = await findNextAvailableWorker(state.preferred_worker, defaultWorker, state.preferred_worker, config);
            const errorText = buildWorkerErrorResponse({ worker: state.preferred_worker, exitCode: prefResult.exitCode, stderr: prefResult.error, suggestedWorker });
            return { response: errorText, session: state.session, meta: null, workerError: true };
          }
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
          if (co.outcome === 'not-rate-limit') {
            const suggestedWorker = await findNextAvailableWorker(defaultWorker, defaultWorker, state.preferred_worker, config);
            const errorText = buildWorkerErrorResponse({ worker: defaultWorker, exitCode: defResult.exitCode, stderr: defResult.error, suggestedWorker });
            return { response: errorText, session: state.session, meta: null, workerError: true };
          }
          if (co.outcome === 'rate-limit') rateLimitedWorker = rateLimitedWorker ?? defaultWorker;
          lastFailedSession = { worker: defaultWorker!, sessionId: defResult.sessionId ?? '' };
          failedWorkers.add(defaultWorker);
        }
      }
    }

    if (!freshResult) {
      const priorCtxFo = lastFailedSession ? { ...lastFailedSession, sessionPath: getPriorSessionPath(lastFailedSession.worker, lastFailedSession.sessionId, effectiveCwd(state)) } : undefined;
      const failoverPrompt = await buildPrompt(userText, state, topicNames, replyContext, pendingDesc, { omitStatic: false, priorContext: priorCtxFo });
      freshResult = await runWithFailover(failoverPrompt, { cwd: effectiveCwd(state), env: secrets, resource, updateId, excludeWorkers: failedWorkers, onWorkerSwitch: async (payload) => { if (onNotify) await onNotify(payload); }, checkAvailable: async (w) => !(await isWorkerCoolingDown(w.name)), preferredWorker: state.preferred_worker, contextId });
    }

    let newSession: SessionInfo | undefined;
    let sessionId: string | undefined;
    if (freshResult.worker === 'claude' || freshResult.worker === 'zclaude' || freshResult.worker === 'codex') sessionId = freshResult.result.sessionId;
    else if (freshResult.worker === 'gemini') sessionId = freshResult.result.sessionId ?? (await discoverGeminiSessionId(GEMINI_PROJECT_DIR).catch(() => null)) ?? undefined;
    if (sessionId) newSession = { session_id: sessionId, worker: freshResult.worker, started_at: new Date().toISOString() };
    dispatchResult = { ...freshResult, session: newSession };
  }

  const { result, worker: workerName, session: capturedSession } = dispatchResult;
  const { cleaned, meta } = parseMetadata(result.output, pendingDesc !== undefined);
  if (result.success && cleaned.trim() === '' && meta === null) {
    const suggestedWorker = await findNextAvailableWorker(workerName, defaultWorker, state.preferred_worker, config);
    return { response: buildWorkerErrorResponse({ worker: workerName, emptyResponse: true, suggestedWorker }), session: state.session, meta: null, workerError: true };
  }
  return { response: buildWorkerResponse({ ...result, output: cleaned }, workerName), session: capturedSession, meta, rateLimitedWorker, dispatchedWorker: workerName, rateLimitTelemetry: result.rateLimitTelemetry };
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

  if (!msg.text && !msg.caption) return;
  const chatId = msg.chat.id;
  if (!allowedChatIds.has(chatId)) return;

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
    let config: any = { workers: [] };
    try { config = await loadConfig(); } catch {}
    let effectiveDefault = getEffectiveDefaultWorker(config, topicKey);

    const workerExpired = expirePreferredWorker(topicState);
    if (workerExpired) {
      const expirySnapshot = buildModelStatusSnapshot({ defaultWorker: effectiveDefault, reasonCode: 'midnight_reset' });
      await replacePinnedStatusCard(token, chatId, threadId, topicState, expirySnapshot);
    }

    addTurn(topicState, { role: 'user', text: userText, timestamp, message_id: messageId, worker: topicState.preferred_worker || effectiveDefault, session_id: topicState.session?.session_id });

    let response = '';
    let skipWorker = false;

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
      expirePendingAction(topicState);
      if (topicState.pending_action) {
        const resolved = resolveConfirmation(topicState, userText);
        response = resolved.response; skipWorker = resolved.skipWorker;
      }
    }

    if (!skipWorker) {
      await sendTyping(token, chatId, threadId);
      const typingInterval = setInterval(() => { sendTyping(token, chatId, threadId).catch(() => {}); }, 4000);
      let latestFailoverPayload: FailoverNotifyPayload | undefined;
      const onNotify = async (payload: FailoverNotifyPayload) => {
        latestFailoverPayload = payload;
        const msg = formatFailoverMessage(payload);
        await sendMessage(token, chatId, appendRefIdAndLog(msg, { kind: 'failover', chatId, threadId }), messageId, threadId);
      };

      try {
        const dr = await dispatchMessage(userText, replyContext, topicState.pending_action?.description, topicState, secrets, resourceId, effectiveDefault, topicNames, onNotify, update.update_id, contextId);
        response = dr.response; topicState.session = dr.session;
        const { response: processedResponse, skillToRun, restartBot: metaRestartBot } = applyMetaActions(response, dr.meta, topicState);
        response = processedResponse; restartBot = metaRestartBot;
        if (skillToRun) {
          spawn('pa', ['run', skillToRun, '--worker', topicState.preferred_worker || effectiveDefault], { cwd: BOT_CWD, detached: true, stdio: 'ignore', shell: true }).unref();
        }
        if (dr.dispatchedWorker) await maybeUpdatePinnedStatusAfterDispatch(token, chatId, threadId, topicState, effectiveDefault, dr.dispatchedWorker, latestFailoverPayload);
      } catch (dispatchErr) {
        logger.warn('dispatch', `dispatchMessage error: ${(dispatchErr as Error).message}`);
        response = '⚠️ Service temporarily unavailable.';
      } finally { clearInterval(typingInterval); }
    }

    if (response.trim()) {
      const refId = makeRefId();
      const textToSend = `${response.trim()}\n\n_Ref: ${refId}_`;
      const delivered = await sendMessage(token, chatId, textToSend, messageId, threadId);
      if (delivered) addTurn(topicState, { role: 'assistant', text: response.trim(), timestamp: new Date().toISOString(), worker: 'worker', refId });
      else await appendDlq({ chatId, threadId, replyToMessageId: messageId, text: textToSend, timestamp: new Date().toISOString(), updateId: update.update_id, refId });
    }
    await saveTopicState(topicState);
    if (restartBot) writeFileSync(join(homedir(), '.pa', 'telegram-bot.stop'), '');
  } finally { await blackboard.releaseLock(resourceId, 'telegram-bot', contextId); }
}

function getUpdateTopicKey(update: any): string {
  const chatId = update.message?.chat?.id;
  const threadId = update.message?.message_thread_id ?? 0;
  return chatId ? `${chatId}_${threadId}` : 'non-message';
}

async function checkBotLogRotation(): Promise<boolean> {
  const logPath = join(homedir(), '.pa', 'logs', 'telegram-bot.log');
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

  while (!signal.aborted) {
    if (sentinelPath && existsSync(sentinelPath)) break;

    if (Date.now() >= nextLogCheckAt) {
      if (await checkBotLogRotation() && sentinelPath) {
        writeFileSync(sentinelPath, String(Date.now()));
        break;
      }
      nextLogCheckAt = Date.now() + 10 * 60 * 1000;
    }

    try {
      if (Date.now() >= nextSweepAt) {
        await runExpiredModelOverrideSweep(token, chatIds);
        nextSweepAt = Date.now() + MODEL_SWEEP_INTERVAL_MS;
      }
      const timeout = inFlight.size > 0 ? 0 : LONG_POLL_TIMEOUT;
      const updates = await getUpdates(token, computePollOffset(pollOffset), timeout, signal);
      if (updates.length > 0) {
        pollOffset = updates[updates.length - 1].update_id;
        state.last_update_id = pollOffset;
        for (const update of updates) {
          const topicKey = getUpdateTopicKey(update);
          const prev = topicPending.get(topicKey) ?? Promise.resolve();
          const p: Promise<void> = prev
            .then(() => processUpdate(update, token, allowedChatIds, secrets, topicNames, branchIndex))
            .catch((err) => logger.warn('poll', `processUpdate rejected: ${(err as Error).message}`, { update_id: update.update_id }))
            .finally(() => {
              inFlight.delete(p);
              if (topicPending.get(topicKey) === p) topicPending.delete(topicKey);
            });
          topicPending.set(topicKey, p);
          inFlight.add(p);
        }
        await saveState(state);
      } else if (inFlight.size > 0) { await sleepFn(500); }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') break;
      await sleepFn(computeBackoff(1));
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
    await cleanupExpiredSessions();
    await cleanupOrphanedWorkers().catch(() => {});
    const state = await loadState(chatIds[0]);
    const topicNames = await loadTopicNames();
    const branchIndex = await loadBranches();
    const sentinelPath = join(homedir(), '.pa', 'telegram-bot.stop');
    try { unlinkSync(sentinelPath); } catch {}
    await flushDlq(token).catch(() => {});
    await backfillTopicDescriptions(token, chatIds, topicNames).catch(() => {});
    await registerBotCommands(token).catch(() => {});
    await updateDashboard(token, chatIds[0]).catch(() => {});
    const controller = new AbortController();
    await runPollLoop(token, chatIds, state, secrets, controller.signal, (ms: number) => new Promise(r => setTimeout(r, ms)), sentinelPath, topicNames, branchIndex);
  } finally { await releaseLock().catch(() => {}); }
}

import { pathToFileURL } from 'url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.exit(1); });
}
