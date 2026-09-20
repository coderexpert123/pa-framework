/** Deterministic command router (AI-173 phase 2, 2026-09-06): the
 * command-interception cascade of processUpdate, extracted from main.ts as a
 * behavior-preserving move. runCommandRouter(input, deps) runs — in order,
 * which is load-bearing — tunables expiry, the unknown-command guard, /auth,
 * the workerExpired card refresh, the no-content guard, the user-turn
 * archive, the agent/tunable/command family, the git-workflow triggers and
 * /update_brain, then returns everything main.ts reads back. topicState is
 * MUTATED IN PLACE; bodies and their comments moved unchanged.
 * ESM only — this module must stay require-free. */

import { spawn, execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { stat, mkdir } from 'fs/promises';
import { sendMessage, deleteMessage } from './telegram.js';
import { appendRefIdAndLog } from './ref-id.js';
import { addTurn, saveTopicState, findHistoricalSessionTurns, type JoinableTurn } from './conversation.js';
import { stripAnsi } from './ansi.js';
import {
  expirePreferredWorker, expireTunableOverrides, guardUnknownCommand, handleDefaultQuery,
  handleCodeCommand, handleResetCommand, handleNewCommand, handleHelpCommand,
  getAgentSwitchTarget, handleSunsetLlmCommand, parseTunableCommand, promoteSessionToTopicDefaults,
  renderSessionExpiryMessage, handleRetranscribeCommand, handleRefCommand, handleReauthCommand,
  handleUpdateBrainCommand, AUTH_PATTERN, SECRET_PATTERN, AGENT_BARE_PATTERN, RESET_PATTERN,
  NEW_PATTERN, CODE_PATTERN, STATUS_PATTERN, SKILLS_PATTERN, HELP_PATTERN, HEALTH_PATTERN,
  REF_PATTERN, CLAIMS_PATTERN, REAUTH_PATTERN, COMMIT_PATTERN, PUSH_PATTERN, PUSH_PUBLIC_PATTERN,
  INVESTIGATE_FLAGGED_PATTERN, UPDATE_BRAIN_PATTERN, SOURCES_PATTERN, handleSourcesCommand,
  resolveCodePath,
  renderStatusCard, hydrateModelStatus, buildModelStatusSnapshot,
  type TunableCommand,
} from './logic.js';
import { addTopicSource, TOPIC_SOURCES_MAX } from './sources.js';
import { buildSkillStatus } from './context.js';
import { DEBUG_PATTERN, handleDebugCommand, parseSupportTopicKey, resolveDebugTarget } from './debug-command.js';
import { PAIR_PATTERN, handlePairCommand } from './voice-inbox-bridge.js';
import {
  buildOAuthCompletionMessage, launchOAuthResumeAction, normalizeResumeAction,
  redactAuthCommand, redactSecretCommand, validateTopicResumeAction, type OAuthResumeStatus,
} from './oauth.js';
// WP-5 (§5, decision 25): the /agent standing notice gates on the same
// deprecate-pins predicate routing.ts owns — one source of truth for the gate.
import { deprecatePinsEffective } from './routing.js';
import { getTopicBrainInfo, getTopicExemptions } from './topic-brains.js';
import {
  transcribeVoiceMessage, formatTranscriptUserText, voiceErrorMessage,
  extractAudioAttachment, findCachedAudio, type AudioAttachment, type VoiceResult,
} from './voice.js';
import {
  audioIndexRoot, markAudioResult, loadAudioIndex, selectRetranscribeTarget,
  describeAudioTarget, type AudioIndexEntry,
} from './audio-index.js';
import { findSessionForRefId } from './ref-lookup.js';
import { markRepliedForThread } from '../../../pa/dist/src/lib/decisions.js';
import { saveTopicDefault } from '../../../pa/dist/src/config.js'; // saveTopicDefault ONLY — never loadConfig (the caller resolves config)
import type { WorkerConfig } from '../../../pa/dist/src/types.js';
import { resolveWorkerLlm, resolveWorkerEffort, formatWorkerDescriptor, selectWorkerTunables } from '../../../pa/dist/src/lib/tunables.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { loadSupportTopic } from '../../../pa/dist/src/lib/maintenance/jobs/daily-recon.js';
import { appendTask } from '../../../pa/dist/src/lib/topic-tasks.js';
import { resolvePythonCommand } from '../../../pa/dist/src/lib/python.js';
import type { ConversationState } from './types.js';
import type { TopicWorkdir } from './topic-workdir.js';

// Set BOT_CWD in secrets.env to the absolute path of your project root.
const BOT_CWD = process.env.BOT_CWD || process.cwd();

/** WP-5 (§5, decision 25): the standing notice the /agent reply carries while
 *  an effective deprecate-pins gate is live — the spec's frozen phrase. The
 *  pin still writes; it no longer steers dispatch on routed turns. */
export const ROUTER_OWNS_DISPATCH_NOTICE = '\n\n_(routing owns worker+model now)_';

/** Injectable exec seam for the pa CLI helpers: no unit test ever spawns the
 *  real `node pa/dist/bin/pa.js` against the live checkout. */
export type ExecFn = (
  file: string,
  args: string[],
  opts: { cwd: string; windowsHide: boolean; encoding: 'utf8'; maxBuffer: number; timeout: number },
) => string | Buffer;

/** Everything processUpdate hands the router. `msg`/`update` are `any` on purpose:
 *  main.ts already carries them as `any`, and a behavior-preserving extraction
 *  introduces no new types. topicState is MUTATED IN PLACE — the router is its
 *  only writer for the duration of the call. */
export interface CommandRouterInput {
  /** update.message */
  msg: any;
  /** the raw update — read for __requeueCount (archival skip) and
   *  update_id (log contexts) only. */
  update: any;
  /** userText as the attachment stage left it. */
  userText: string;
  /** skipWorker as the attachment stage set it (a failed transcription). The
   *  unknown-command guard gates on it; /auth deliberately does not. */
  skipWorker: boolean;
  /** the attachment stage's response (the voice-failure notice). Same input
   *  class as skipWorker: the router holds it unchanged unless a command
   *  overwrites it — main.ts sends whatever the router returns. */
  response: string;
  /** the attachment stage's voiceTranscribed — the stage is that flag's
   *  first writer; /retranscribe below is the second. */
  voiceTranscribed: boolean;
  /** the attachment handle from runAttachmentStage — the no-content guard
   *  reads it. */
  audioAttachment: AudioAttachment | undefined;
  token: string;
  chatId: number;
  threadId: number;
  messageId: number;
  /** ISO timestamp built once in processUpdate from msg.date. */
  timestamp: string;
  /** BOT_CWD. */
  repoRoot: string;
  topicState: ConversationState;
  config: any;
  effectiveDefault: string;
  /** from resolveTopicWorkdir/ensureTopicWorkdir — /code reads dir + tier. */
  workdir: TopicWorkdir;
  /** { ...process.env, ...secrets } — /auth exchange spawn and /reauth. */
  runtimeEnv: NodeJS.ProcessEnv;
  /** /debug reads PA_OPERATOR_USER_ID. */
  secrets: Record<string, string>;
  /** /auth topic_resume target-chat guard. */
  allowedChatIds: Set<number>;
}

/** main.ts-local capabilities the router cannot import without a circular
 *  import (main.ts imports the router). REQUIRED — no defaults; passing
 *  nothing is a compile error by design. The five required members are typed
 *  structurally (their implementations live in main.ts); the shapes match
 *  those functions exactly. */
export interface CommandRouterDeps {
  refreshCard: (
    token: string,
    chatId: number,
    threadId: number,
    state: ConversationState,
    effectiveDefault: string,
    config?: { workers?: WorkerConfig[] },
  ) => Promise<void>;
  syncModelStatus: (state: ConversationState, snapshot: ReturnType<typeof buildModelStatusSnapshot>) => void;
  spawnReauthLink: (chatId: number, threadId: number | undefined, runtimeEnv: NodeJS.ProcessEnv, skill?: string) => string;
  injectResumeUpdate: (args: { chatId: number; threadId: number; prompt: string }) => number;
  handleTunables: (
    cmd: TunableCommand,
    state: ConversationState,
    config: { workers?: WorkerConfig[] } | undefined,
    effectiveDefault: string,
  ) => Promise<string>;
  /** Everything below is injectable for tests; defaults bind the real
   *  implementations, so production main.ts passes only the five above. */
  send?: typeof sendMessage;
  deleteMessageFn?: typeof deleteMessage;
  addTurnFn?: typeof addTurn;
  saveTopicStateFn?: typeof saveTopicState;
  markRepliedFn?: typeof markRepliedForThread;
  spawnFn?: typeof spawn;
  statFn?: typeof stat;
  mkdirFn?: typeof mkdir;
  execPaCommandFn?: typeof execPaCommand;
  execPaRefFn?: typeof execPaRef;
  appendTaskFn?: typeof appendTask;
  loadSupportTopicFn?: typeof loadSupportTopic;
  getTopicExemptionsFn?: typeof getTopicExemptions;
  getTopicBrainInfoFn?: typeof getTopicBrainInfo;
  findSessionForRefIdFn?: typeof findSessionForRefId;
  findHistoricalTurnsFn?: typeof findHistoricalSessionTurns;
  /** /retranscribe seams: recording stubs for the audio-index write and the
   *  transcription call (defaults bind the real implementations). */
  transcribeFn?: typeof transcribeVoiceMessage;
  markAudioFn?: typeof markAudioResult;
  log?: {
    info(module: string, message: string, context?: Record<string, unknown>): void;
    warn(module: string, message: string, context?: Record<string, unknown>): void;
  };
}

/** Every value main.ts reads back. The caller assigns all six unconditionally;
 *  `effectiveDefault` is reassigned because /default changes it. */
export interface CommandRouterResult {
  userText: string;
  archivedUserText: string;
  response: string;
  skipWorker: boolean;
  voiceTranscribed: boolean;
  effectiveDefault: string;
}

/**
 * Execute a pa CLI command synchronously and return trimmed stdout.
 * Used for read-only commands like /health, /ref, and /claims.
 */
export function execPaCommand(args: string[], maxChars: number = 1200, exec: ExecFn = execFileSync): string {
  try {
    const stdout = exec(
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
export function execPaRef(refId: string, exec: ExecFn = execFileSync): string {
  try {
    const stdout = exec(
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
function dispatchGitWorkflowSkill(skillName: string, repoRoot: string, spawnFn: typeof spawn): string {
  // WB-304: error listener so a missing `pa` is never invisible.
  spawnFn('pa', ['run', skillName], { cwd: repoRoot, detached: true, stdio: 'ignore', shell: true, windowsHide: true })
    .on('error', (err) => {
      logger.warn('command-router', `git-workflow skill spawn failed: ${(err as Error).message}`, { skill: skillName });
    })
    .unref();
  return `🚀 Kicked off \`${skillName}\` — it reports back in the main "My PA" topic when done, not necessarily here.`;
}

export async function runCommandRouter(
  input: CommandRouterInput,
  deps: CommandRouterDeps,
): Promise<CommandRouterResult> {
  const {
    msg, update, token, chatId, threadId, messageId, timestamp,
    repoRoot, topicState, config, effectiveDefault: _initialDefault,
    workdir, runtimeEnv, secrets, allowedChatIds, audioAttachment,
  } = input;

  // Optional deps resolve to the real implementations (phase-1 style).
  const send = deps.send ?? sendMessage;
  const deleteMessageFn = deps.deleteMessageFn ?? deleteMessage;
  const addTurnFn = deps.addTurnFn ?? addTurn;
  const saveTopicStateFn = deps.saveTopicStateFn ?? saveTopicState;
  const markRepliedFn = deps.markRepliedFn ?? markRepliedForThread;
  const spawnFn = deps.spawnFn ?? spawn;
  const statFn = deps.statFn ?? stat;
  const mkdirFn = deps.mkdirFn ?? mkdir;
  const execPaCommandFn = deps.execPaCommandFn ?? execPaCommand;
  const execPaRefFn = deps.execPaRefFn ?? execPaRef;
  const loadSupportTopicFn = deps.loadSupportTopicFn ?? loadSupportTopic;
  const getTopicExemptionsFn = deps.getTopicExemptionsFn ?? getTopicExemptions;
  const getTopicBrainInfoFn = deps.getTopicBrainInfoFn ?? getTopicBrainInfo;
  const findSessionForRefIdFn = deps.findSessionForRefIdFn ?? findSessionForRefId;
  const findHistoricalTurnsFn = deps.findHistoricalTurnsFn ?? findHistoricalSessionTurns;
  const transcribeFn = deps.transcribeFn ?? transcribeVoiceMessage;
  const markAudioFn = deps.markAudioFn ?? markAudioResult;
  const log = deps.log ?? logger;

  let userText = input.userText;
  let archivedUserText = input.userText;
  let response = input.response;
  let skipWorker = input.skipWorker;
  let voiceTranscribed = input.voiceTranscribed;
  let effectiveDefault = input.effectiveDefault;
  void _initialDefault;

  const workerExpired = expirePreferredWorker(topicState);
  // Session-tier tunables share preferred_worker's IST-day lifecycle, but are
  // expired per entry (see expireTunableOverrides). No status-card change:
  // they are not part of the pinned model snapshot.
  const expiredTunables = expireTunableOverrides(topicState);
  if (expiredTunables.length > 0) {
    log.info('tunables', `expired ${expiredTunables.length} session override(s) at the IST day boundary`, { topic: `${chatId}_${threadId}`, cleared: expiredTunables });
  }

  // Unknown-command guard: catch single-token slash commands that don't match any known pattern
  if (!skipWorker && userText) {
    const guardResult = guardUnknownCommand(userText);
    if (guardResult) {
      response = guardResult.response;
      skipWorker = true;
    }
  }

  if (AUTH_PATTERN.test(userText)) {
    const match = AUTH_PATTERN.exec(userText);
    const code = match![1];
    const authState = match![2];
    log.info('auth', `Authorization code received via Telegram (chat=${chatId})`);
    archivedUserText = redactAuthCommand();

    deleteMessageFn(token, chatId, messageId).catch(() => {});

    const exchangeScript = runtimeEnv.PA_OAUTH_FINISH_SCRIPT || join(repoRoot, 'pa', 'scripts', 'finish_google_telegram_reauth.py');
    const exchangeArgs = [exchangeScript, '--code', code];
    if (authState) exchangeArgs.push('--state', authState);
    if (runtimeEnv.PA_OAUTH_SECRETS_FILE) exchangeArgs.push('--secrets-file', runtimeEnv.PA_OAUTH_SECRETS_FILE);
    if (runtimeEnv.PA_OAUTH_STATE_FILE) exchangeArgs.push('--state-file', runtimeEnv.PA_OAUTH_STATE_FILE);
    if (runtimeEnv.PA_OAUTH_TOKEN_FILE) exchangeArgs.push('--token-file', runtimeEnv.PA_OAUTH_TOKEN_FILE);
    const exchangeProc = spawnFn(resolvePythonCommand(runtimeEnv), exchangeArgs, { shell: true, env: runtimeEnv, windowsHide: true });

    let exchangeOut = '';
    exchangeProc.stdout.on('data', (d) => exchangeOut += d.toString());

    const exchangeResult = await new Promise<any>((resolve) => {
      exchangeProc.on('close', () => {
        try { resolve(JSON.parse(exchangeOut)); }
        catch { resolve({ error: 'Failed to parse exchange output.' }); }
      });
    });

    const resumeAction = normalizeResumeAction(exchangeResult);
    let resumeStatus: OAuthResumeStatus;
    if (resumeAction && resumeAction.type === 'topic_resume') {
      // Conversation-shaped resume. oauth_resume_hook.py has no
      // dispatch path into a topic (it only runs `pa run <skill>`), so the
      // bot itself injects the turn — closed-shape-validated again here at
      // fire time, target chat guarded by allowedChatIds, and every
      // failure degrades to a completion-message line, never a crash of
      // the /auth handler.
      resumeStatus = 'topic_resume_failed';
      try {
        const check = validateTopicResumeAction(resumeAction);
        const targetChatId = Number(exchangeResult.chat_id);
        const targetThreadId = Number(exchangeResult.thread_id ?? 0);
        if (!check.ok) {
          log.warn('auth', `topic_resume rejected at fire time: ${check.error}`, { chatId, threadId });
        } else if (!exchangeResult.chat_id || !Number.isFinite(targetChatId)) {
          log.warn('auth', 'topic_resume rejected: exchange result carries no chat_id', { chatId, threadId });
        } else if (!allowedChatIds.has(targetChatId)) {
          log.warn('auth', `topic_resume rejected: target chat ${targetChatId} is not an allowed chat`, { chatId, threadId });
        } else {
          deps.injectResumeUpdate({ chatId: targetChatId, threadId: targetThreadId, prompt: check.prompt });
          resumeStatus = 'topic_resumed';
        }
      } catch (err) {
        log.warn('auth', `topic_resume injection failed: ${(err as Error).message}`, { chatId, threadId });
      }
    } else {
      resumeStatus = launchOAuthResumeAction(resumeAction, {
        cwd: repoRoot,
        env: runtimeEnv,
      });
    }
    response = buildOAuthCompletionMessage(exchangeResult, resumeStatus, { chatId, threadId });
    skipWorker = true;
  }

  if (SECRET_PATTERN.test(userText)) {
    const secretMatch = SECRET_PATTERN.exec(userText);
    const requestId = secretMatch![1];
    const value = secretMatch![2];
    log.info('auth', `Secret value received via Telegram (chat=${chatId})`);
    archivedUserText = redactSecretCommand();

    deleteMessageFn(token, chatId, messageId).catch(() => {});

    const secretChild = spawnFn(
      process.execPath,
      [join(repoRoot, 'pa', 'dist', 'bin', 'pa.js'), 'auth', 'answer', '--request', requestId],
      { env: runtimeEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    secretChild.stdin.write(value);
    secretChild.stdin.end();

    let secretOut = '';
    secretChild.stdout.on('data', (d) => secretOut += d.toString());

    const secretResult = await new Promise<any>((resolve) => {
      secretChild.on('close', () => {
        const lastLine = secretOut.trim().split('\n').filter(Boolean).pop();
        try { resolve(lastLine ? JSON.parse(lastLine) : {}); }
        catch { resolve({}); }
      });
    });

    response = secretResult && secretResult.ok === true
      ? 'Sent. The task continues.'
      : 'That request is no longer pending, or the id is unknown.';
    skipWorker = true;
  }

  if (workerExpired) {
    await deps.refreshCard(token, chatId, threadId, topicState, effectiveDefault, config);
  }

  if (!userText && !audioAttachment && !msg.document && !msg.photo) {
    skipWorker = true;
  }

  if (userText) {
    // A requeued synthetic's user turn was already archived at first receipt;
    // re-adding would duplicate it in the rolling window.
    if ((update as any).__requeueCount === undefined) {
      const userTurn: JoinableTurn = { role: 'user', text: archivedUserText, timestamp, message_id: messageId, worker: topicState.preferred_worker || effectiveDefault, session_id: topicState.session?.session_id, update_id: update.update_id, via: (update as any).__synthetic };
      addTurnFn(topicState, userTurn);
      markRepliedFn(chatId, threadId);
      // Persist + archive the user turn AT RECEIPT. A crash during
      // the (possibly minutes-long) dispatch must not erase the user's message from
      // topic state / conversation-history.jsonl — 2026-07-03 lost two user turns
      // this way. Watermark dedup makes the second save at the end idempotent.
      await saveTopicStateFn(topicState).catch((err) => log.warn('conversation', 'early user-turn save failed', { error: String(err) }));
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
      // Explicitly set model_status here (not just clear preferred_worker)
      // because hydrateModelStatus treats a previously-set model_status as sticky — once
      // ANY prior action (reset, midnight expiry, failover) has stamped a reason_code, the
      // generic inferLegacyReasonCode() fallback is never consulted again, so switching back
      // to the default agent here needs its own explicit stamp or it inherits a stale reason.
      deps.syncModelStatus(topicState, buildModelStatusSnapshot({
        currentWorker: modelTarget,
        defaultWorker: effectiveDefault,
        reasonCode: 'user_selected_default',
        currentLlm: targetLlm,
        currentEffort: targetEffort,
      }));
    } else {
      topicState.preferred_worker = modelTarget;
      topicState.preferred_worker_set_at = new Date().toISOString();
      // Same stickiness reasoning as above, for the override branch.
      deps.syncModelStatus(topicState, buildModelStatusSnapshot({
        currentWorker: modelTarget,
        defaultWorker: effectiveDefault,
        reasonCode: 'user_override',
        currentLlm: targetLlm,
        currentEffort: targetEffort,
      }));
    }
    topicState.session = undefined;
    await deps.refreshCard(token, chatId, threadId, topicState, effectiveDefault, config);
    const lifetime = modelTarget === effectiveDefault ? 'topic default' : 'until midnight IST';
    // WP-5 (§5, decision 25): under an effective deprecate-pins gate the pin
    // still WRITES (flag-off reversal is exact) but no longer steers dispatch
    // on routed turns — the reply carries the standing notice. State writes
    // above are unchanged.
    const pinsNotice = deprecatePinsEffective(config?.model_router) ? ROUTER_OWNS_DISPATCH_NOTICE : '';
    if (agentSwitch.isLegacy) {
      response = `Switched agent: ${prevDescriptor} → ${nextDescriptor} (${lifetime}).\n💡 _Tip: use \`/agent <name>\` to pick the agent and \`/model <name>\` to set its model._${pinsNotice}`;
    } else {
      response = `Switched agent: ${prevDescriptor} → ${nextDescriptor} (${lifetime}).${pinsNotice}`;
    }
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

    await deps.refreshCard(token, chatId, threadId, topicState, effectiveDefault, config);
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
        const repliedSessionId = await findSessionForRefIdFn(refId);
        if (repliedSessionId && repliedSessionId !== oldSessionId) {
          const historicalTurns = await findHistoricalTurnsFn(repliedSessionId, threadId, 20);
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
      addTurnFn(topicState, {
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
        const st = await statFn(codeCmd.path);
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

  // Per-topic grounding sources (grounding v2, 2026-09-06, internal design):
  // the same interaction split as /code — the pure handler decides show/reset/
  // remove locally; an add is returned UNAPPLIED and validated here (stat gate:
  // a source is a specific FILE, not a directory) before addTopicSource applies
  // it (dedup + cap enforced there; responses are the frozen §3 strings).
  if (!skipWorker && SOURCES_PATTERN.test(userText)) {
    const srcCmd = handleSourcesCommand(topicState, userText);
    if (srcCmd.action !== 'add') {
      response = srcCmd.response;
      skipWorker = true;
    } else {
      const srcPath = resolveCodePath(srcCmd.path!);
      let isFile = false;
      try {
        const st = await statFn(srcPath);
        isFile = st.isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) {
        response = `⚠️ Not a readable file: \`${srcPath}\`. Declare a specific file, not a directory.`;
        skipWorker = true;
      } else {
        const added = addTopicSource(topicState, { path: srcPath, label: srcCmd.label });
        response = added.ok
          ? `📚 Source declared: \`${srcPath}\` — ${topicState.sources!.length} total. It will be injected (or pointed at) in every fresh dispatch from now on.`
          : added.reason === 'duplicate'
            ? `📚 Already declared: \`${srcPath}\`.`
            : `⚠️ Source cap reached (${TOPIC_SOURCES_MAX} per topic). Remove one first: /sources remove <n>.`;
        skipWorker = true;
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
        await saveTopicDefault(`${chatId}_${threadId}`, dq.worker);
        effectiveDefault = dq.worker;
        topicState.preferred_worker = undefined;
        topicState.preferred_worker_set_at = undefined;
      } else {
        // /default with no arguments: make current active configuration default at topic level
        const currentWorker = topicState.preferred_worker || effectiveDefault;
        await saveTopicDefault(`${chatId}_${threadId}`, currentWorker);
        effectiveDefault = currentWorker;
        promoteSessionToTopicDefaults(topicState, currentWorker);
      }
      topicState.session = undefined;

      const nextDefaultConfig = config?.workers?.find((w: WorkerConfig) => w.name === effectiveDefault);
      const nextDefaultLlm = nextDefaultConfig ? resolveWorkerLlm(nextDefaultConfig, undefined, selectWorkerTunables(topicState.tunable_defaults, effectiveDefault)) : undefined;
      const nextDefaultEffort = nextDefaultConfig ? resolveWorkerEffort(nextDefaultConfig, undefined, selectWorkerTunables(topicState.tunable_defaults, effectiveDefault)) : undefined;
      const nextDefaultDescriptor = formatWorkerDescriptor(effectiveDefault, nextDefaultLlm, nextDefaultEffort);

      // Same stickiness reasoning as the /agent-switch block — /default
      // changes the topic's default agent, so it needs its own explicit model_status
      // stamp or hydrateModelStatus's sticky prior-reason_code path leaves it stale.
      deps.syncModelStatus(topicState, buildModelStatusSnapshot({
        currentWorker: effectiveDefault,
        defaultWorker: effectiveDefault,
        reasonCode: 'default_changed',
        currentLlm: nextDefaultLlm,
        currentEffort: nextDefaultEffort,
      }));

      await deps.refreshCard(token, chatId, threadId, topicState, effectiveDefault, config);
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
      response = await deps.handleTunables(tunableCmd, topicState, config, effectiveDefault);
      if (tunableCmd.action === 'set' || tunableCmd.action === 'clear') {
        await deps.refreshCard(token, chatId, threadId, topicState, effectiveDefault, config);
      }
      skipWorker = true;
    }
  }

  // /retranscribe [engine]. A replied-to note always wins; with no reply, the
  // target is picked from the durable audio index — newest not-yet-succeeded
  // note in this thread, else the newest note. Always re-transcribes AND
  // dispatches the result through the normal chain (not a show-only mode).
  if (!skipWorker) {
    const rt = handleRetranscribeCommand(userText);
    if (rt.matched) {
      const replyTarget = extractAudioAttachment(msg.reply_to_message ?? {});
      let indexedEntry: AudioIndexEntry | undefined;
      if (!replyTarget) {
        const index = await loadAudioIndex(audioIndexRoot(), chatId);
        indexedEntry = selectRetranscribeTarget(index.entries, threadId || null);
      }
      const target = replyTarget ?? (indexedEntry ? { kind: indexedEntry.kind, media: indexedEntry.media } : undefined);
      if (!target) {
        response = '🎙 No recent voice or audio messages from this topic to re-transcribe — reply to the note you want, or send a new one.';
        skipWorker = true;
      } else {
        const cachedPath = await findCachedAudio(chatId, target.media.file_unique_id).catch(() => undefined);
        const vr = await transcribeFn(token, chatId, target.media, {
          repoRoot,
          env: runtimeEnv,
          transcription: config.transcription,
          threadId,
          engineOverride: rt.engine,
          cachedPath,
        }, target.kind);
        markAudioFn(
          audioIndexRoot(),
          chatId,
          target.media.file_unique_id,
          vr.ok ? 'ok' : 'failed',
          vr.ok ? { engine: vr.engine } : { reason: vr.reason }
        ).catch(() => {});
        if (!vr.ok) {
          response = voiceErrorMessage(vr);
          skipWorker = true;
        } else {
          const engineLabel = rt.engine ?? vr.engine;
          const targetLabel = indexedEntry ? ` — ${describeAudioTarget(indexedEntry)}` : '';
          await send(token, chatId, `🎙 Re-transcribed (${engineLabel})${targetLabel}:\n\n${vr.text}`, messageId, threadId).catch((err) => {
            log.warn('retranscribe', `Failed to send re-transcription success message for chat ${chatId} thread ${threadId}${targetLabel}`, { error: (err as Error).message, updateId: update.update_id });
          });
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
    const snapshot = hydrateModelStatus(topicState, effectiveDefault, config);
    response = appendRefIdAndLog(renderStatusCard({ snapshot }), { kind: 'pin', chatId, threadId });
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
    const healthResult = execPaCommandFn(['health', '--no-color'], 3500);
    response = appendRefIdAndLog(healthResult, { kind: 'system', chatId, threadId });
    skipWorker = true;
  }

  if (!skipWorker && REF_PATTERN.test(userText)) {
    const refCmd = handleRefCommand(userText);
    if (refCmd.matched && refCmd.refId) {
      const refResult = execPaRefFn(refCmd.refId);
      response = appendRefIdAndLog(refResult, { kind: 'system', chatId, threadId });
      skipWorker = true;
    }
  }

  if (!skipWorker && CLAIMS_PATTERN.test(userText)) {
    const claimsResult = execPaCommandFn(['claims'], 1200);
    response = appendRefIdAndLog(claimsResult, { kind: 'system', chatId, threadId });
    skipWorker = true;
  }

  if (!skipWorker && DEBUG_PATTERN.test(userText)) {
    // Operator-only. Files a topic-task to pa-support
    // with the target message's ref-ID as the debug handle; never dispatches
    // a worker in the asking topic. The support key is config.yaml
    // `topics.support` (parsed pa-side via loadSupportTopic()); when unset
    // or malformed, /debug is unavailable and reports a configuration
    // error — there is no frozen fallback topic.
    const operatorId = secrets['PA_OPERATOR_USER_ID'];
    const supportKey = await loadSupportTopicFn().catch(() => undefined);
    const support = parseSupportTopicKey(supportKey ?? '');
    if (!support) {
      response = appendRefIdAndLog(
        '/debug unavailable: config.yaml topics.support is not set or malformed.',
        { kind: 'system', chatId, threadId }
      );
      skipWorker = true;
    } else {
      const result = await handleDebugCommand({
        userId: msg.from?.id?.toString(),
        operatorId,
        target: resolveDebugTarget(
          msg.reply_to_message as { text?: string; caption?: string; message_id?: number } | undefined,
          topicState.turns,
          messageId
        ),
        chatId,
        threadId,
        support,
        appendTaskFn: deps.appendTaskFn ?? appendTask,
      });
      response = appendRefIdAndLog(result.response, { kind: 'system', chatId, threadId });
      skipWorker = true;
    }
  }

  if (!skipWorker && REAUTH_PATTERN.test(userText)) {
    const parsed = handleReauthCommand(userText);
    response = appendRefIdAndLog(deps.spawnReauthLink(chatId, threadId, runtimeEnv, parsed.skill), { kind: 'system', chatId, threadId });
    skipWorker = true;
  }

  // Voice-inbox pairing: mint a one-time code for the app's exchange
  // flow. Local and deterministic like /reauth; the allowed-chats guard lives
  // inside handlePairCommand.
  if (!skipWorker && PAIR_PATTERN.test(userText)) {
    response = appendRefIdAndLog(
      handlePairCommand({ chatId, userId: msg.from?.id ?? 0, firstName: msg.from?.first_name ?? null, allowedChatIds }),
      { kind: 'system', chatId, threadId }
    );
    skipWorker = true;
  }

  // The git-workflow skill family: one deterministic Telegram trigger per
  // phase (see dispatchGitWorkflowSkill's own comment for why these bypass
  // LLM inference). Order doesn't matter — the patterns are mutually
  // exclusive by construction (e.g. PUSH_PATTERN's trailing `\s*$` cannot
  // match "/push_public", so it can never shadow PUSH_PUBLIC_PATTERN).
  if (!skipWorker && COMMIT_PATTERN.test(userText)) {
    response = dispatchGitWorkflowSkill('commit', repoRoot, spawnFn);
    skipWorker = true;
  }
  if (!skipWorker && PUSH_PATTERN.test(userText)) {
    response = dispatchGitWorkflowSkill('push', repoRoot, spawnFn);
    skipWorker = true;
  }
  if (!skipWorker && PUSH_PUBLIC_PATTERN.test(userText)) {
    response = dispatchGitWorkflowSkill('push-public', repoRoot, spawnFn);
    skipWorker = true;
  }
  if (!skipWorker && INVESTIGATE_FLAGGED_PATTERN.test(userText)) {
    response = dispatchGitWorkflowSkill('investigate-flagged', repoRoot, spawnFn);
    skipWorker = true;
  }

  // /update_brain interception — deterministic staging or refusal
  if (!skipWorker && UPDATE_BRAIN_PATTERN.test(userText)) {
    const exemptions = await getTopicExemptionsFn();
    const updateBrainResult = handleUpdateBrainCommand(topicState, userText, exemptions);
    if (updateBrainResult.action === 'refusal') {
      response = updateBrainResult.response;
      skipWorker = true;
    } else {
      // mkdir .staged directory (failure → refusal)
      const PA_HOME = process.env.PA_HOME ?? join(homedir(), '.pa');
      const stagedDir = join(PA_HOME, 'topic-brains', '.staged');
      try {
        await mkdirFn(stagedDir, { recursive: true });
      } catch {
        response = '⚠️ Could not prepare the topic staging directory. Nothing staged.';
        skipWorker = true;
      }
      if (!skipWorker) {
        // Rewrite userText to staging instruction
        userText = updateBrainResult.instruction;
        // Check if brain exists to include brain path in instruction
        const brainInfo = await getTopicBrainInfoFn(chatId, threadId);
        if (brainInfo) {
          userText = userText.replace('<BRAIN_PATH_ABS>', brainInfo.path);
        } else {
          userText = userText.replace(/ If the topic brain at <BRAIN_PATH_ABS> already records a fact, stage only what is new or changed\./, '');
        }
      }
    }
  }

  return { userText, archivedUserText, response, skipWorker, voiceTranscribed, effectiveDefault };
}
