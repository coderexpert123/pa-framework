/**
 * dispatch.ts — AI-173 phase 3 (2026-09-06).
 *
 * Behavior-preserving extraction of the dispatch/failover cascade out of
 * main.ts: buildDispatchExtraArgs, the model-status sync + pin-update helpers,
 * tryClassifyAndNotify, the agy kill-drop rule, the raw-send alert, and
 * dispatchMessage itself. dispatchMessage and the orchestrator's turn dispatch
 * are two DispatchLane configs over ONE shared core (runDispatchCascade) —
 * a lane is config, not a copy. main.ts re-exports the moved symbols its
 * existing importers consume (witness surface) and stays the composition
 * root — nothing imports main.ts from here, and the import direction is
 * one-way: orchestrator.ts → dispatch.ts, main.ts → both.
 * Spec: the AI-173 phase 3 design (2026-09-06, internal).
 */

import { sendMessage } from './telegram.js';
import { buildPrompt, buildResumedPrompt } from './context.js';
import {
  parseMetadata, isPrematureAsyncReply, buildWorkerResponse, buildWorkerErrorResponse,
  workerReceivesStaticPromptFile, hydrateModelStatus, buildModelStatusSnapshot,
  modelStatusNeedsRefresh,
} from './logic.js';
import { parseSupportTopicKey } from './debug-command.js';
import { getKeepAwakeStatus, type KeepAwakeStatus } from './keepawake.js';
import { isTopicStopped } from './worker-stop.js';
import { isSessionValid, buildResumeArgs, getPriorSessionPath } from './session.js';
// maybeDropAgySession's moved body reads the exclusion set + resource parser too.
import {
  AGY_NATIVE_RESUME_EXCLUDED_TOPICS,
  threadIdFromResource,
  captureSessionForResult,
  findNextAvailableWorker,
} from './session-capture.js';
// Single source stays task-executor.ts (never duplicated).
import { ORPHAN_HARVEST_WINDOW_MS } from './task-executor.js';
// ORPHAN_HARVEST_WINDOW_MS moved 2026-09-02 to task-executor.ts (WP-A executor lane —
// task dispatches share the bot's harvest budget), imported at the top; the human-lane
// dispatch sites below keep referencing the same value.
import type { ConversationState, SessionInfo, PAMeta, ModelStatusSnapshot, ModelStatusReasonCode } from './types.js';
import type { TopicNameMap } from './topic-names.js';
import type { TopicWorkdir } from './topic-workdir.js';
import { runWithFailover, executeWorker, isWorkerCoolingDown, classifyRateLimit, recordRateLimit } from '../../../pa/dist/src/workers.js';
import { loadConfig } from '../../../pa/dist/src/config.js';
import type { CommandResult, FailoverNotifyPayload, RunOptions, WorkerConfig } from '../../../pa/dist/src/types.js';
import { resolveTunableArgs, mergeTunableArgs, resolveWorkerLlm, resolveWorkerEffort, selectWorkerTunables } from '../../../pa/dist/src/lib/tunables.js';
import { loadSupportTopic } from '../../../pa/dist/src/lib/maintenance/jobs/daily-recon.js';
import { redactSecrets } from '../../../pa/dist/src/lib/redact.js';
import { logger } from '../../../pa/dist/src/lib/log.js';

// Default bot working directory — same formula as main.ts's BOT_CWD (duplicated
// rather than imported: main.ts is the composition root and must not be
// imported from here; task-executor.ts's TASK_SPAWN_CWD precedent).
const BOT_CWD = process.env.BOT_CWD || process.cwd();

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

export function syncModelStatusState(state: ConversationState, snapshot: ModelStatusSnapshot): void {
  state.model_status = snapshot;
  state.pinned_worker = snapshot.current_worker;
}

/** Exported for the unit pin (dispatch.test.ts) — no other consumer. */
export function buildFailoverReasonText(
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

/** Structural copy of main.ts's refreshPinnedStatusCardInPlace signature —
 *  injected as maybeUpdatePinnedStatusAfterDispatch's first parameter rather
 *  than imported, because the pinned-status-card cluster stayed in main.ts
 *  (importing it from here would be a cycle: main.ts imports this module). */
type RefreshCardFn = (
  token: string,
  chatId: number,
  threadId: number,
  state: ConversationState,
  effectiveDefault: string,
  keepAwake?: KeepAwakeStatus,
  config?: { workers?: WorkerConfig[] }
) => Promise<void>;

export async function maybeUpdatePinnedStatusAfterDispatch(
  refreshCard: RefreshCardFn,
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
      await refreshCard(token, chatId, threadId, state, effectiveDefault, getKeepAwakeStatus(), config);
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
      await refreshCard(token, chatId, threadId, state, effectiveDefault, getKeepAwakeStatus(), config);
    }
    return;
  }

  if (!state.pinned_status_message_id) {
    await refreshCard(token, chatId, threadId, state, effectiveDefault, getKeepAwakeStatus(), config);
    return;
  }

  syncModelStatusState(state, currentSnapshot);
}

/** Test-seam function shapes (orchestrator.ts's existing seams, generalized). */
export type ExecuteSeam  = (worker: WorkerConfig, prompt: string, opts: RunOptions) => Promise<CommandResult>;
export type FailoverSeam = (prompt: string, opts: RunOptions) => Promise<{ worker: string; result: CommandResult }>;
export type CaptureSeam  = (worker: string, result: CommandResult, resource: string) => Promise<SessionInfo | undefined>;

export interface CascadeArgs {
  lane: DispatchLane;
  state: ConversationState;
  secrets: Record<string, string>;
  resource: string;
  defaultWorker?: string;
  topicNames?: TopicNameMap;      // forwarded to buildFresh
  onNotify?: (payload: FailoverNotifyPayload) => Promise<void>;
  updateId?: number;
  /** Already resolved by the caller: workdir ?? { dir: BOT_CWD, tier: 'bot-cwd' }. */
  workdir: TopicWorkdir;
  contextId?: string;
  /** The turn's prompt inputs — forwarded into the lane's buildResumed/buildFresh. */
  userText: string;
  replyContext?: string;
  pendingDesc?: string;
  isCancelled?: () => boolean;    // default: the stop-marker probe below
  execute?: ExecuteSeam;
  failover?: FailoverSeam;
  capture?: CaptureSeam;
}

export type CascadeOutcome =
  | { kind: 'cancelled'; session: SessionInfo | undefined }
  | { kind: 'done'; result: CommandResult; worker: string; session: SessionInfo | undefined;
      rateLimitedWorker?: string; config: Awaited<ReturnType<typeof loadConfig>> };

export interface DispatchLane {
  /** Logger module for the resume-error warn. */
  resumeLogModule: string;                    // main: 'session'   orchestrator: 'orchestrator'
  /** parseMetadata's executionMode argument. */
  executionMode: boolean;                     // main: pendingDesc !== undefined   orchestrator: false ALWAYS
  /** tryClassifyAndNotify on failed attempts (rate-limit ledger stamp + onNotify). */
  classifyFailures: boolean;                  // main: true   orchestrator: true  ← THE phase-3 gain
  /** Arm the AI-202 premature-async-reply suppression in the lane tail. */
  suppressPrematureAsync: boolean;            // main: pendingDesc === undefined   orchestrator: true
  /** Run the explicit preferred/default attempts before runWithFailover. */
  explicitWorkerAttempts: boolean;            // main: true   orchestrator: false
  /** Apply session tunables (resume extraArgs + failover getExtraArgs). */
  applySessionTunables: boolean;              // main: true   orchestrator: false (observed divergence, preserved)
  /** runWithFailover's preferredWorker. */
  failoverPreferredWorker(state: ConversationState, defaultWorker: string | undefined): string | undefined;
  /** AI-030 switch-back info log — lanes keep byte-exact records (maintenance
   *  parsers watch the bot log; loose-superset silence bias — never unify). */
  switchBackLog(currentWorker: string, target: string | undefined): { module: string; text: string };
  buildResumed(a: { userText: string; replyContext?: string; pendingDesc?: string; worker: WorkerConfig }): Promise<string>;
  buildFresh(a: { userText: string; state: ConversationState; topicNames?: TopicNameMap;
                  replyContext?: string; pendingDesc?: string; worker: WorkerConfig | undefined;
                  priorContext?: { worker: string; sessionId: string; sessionPath: string | null };
                  workdir?: { dir: string; tier: 'override' | 'project' | 'topic-home' } }): Promise<string>;
}

/**
 * Kill-drop rule for agy native-resume trial topics.
 * Returns undefined (drop the session) if the session belongs to an agy
 * worker on a trial topic and shouldDrop is true; otherwise returns the
 * session unchanged.
 */
export function maybeDropAgySession(session: SessionInfo | undefined, resource: string, shouldDrop: boolean): SessionInfo | undefined {
  if (!shouldDrop || !session || session.worker !== 'agy') return session;
  if (AGY_NATIVE_RESUME_EXCLUDED_TOPICS.has(threadIdFromResource(resource))) return session;
  return undefined;
}

/** dispatchMessage's AI-092 stop-marker probe — the ONE copy (main.ts's inline
 *  probe and the orchestrator's defaultIsCancelled mirror both died here).
 *  Bypassed when the caller hands isCancelled in. */
function defaultStopProbe(resource: string, updateId?: number): () => boolean {
  const stopKey = resource.replace(/^topic-/, '');
  // Never let a marker-lookup failure propagate: this predicate is read from
  // inside a child process's close handler (pa's worker-exec), where a throw
  // would be an unhandled exception in an event handler. Fail toward "not
  // cancelled" — that is the pre-AI-092 behaviour — but say so loudly.
  return () => {
    try {
      return isTopicStopped(stopKey, updateId);
    } catch (err) {
      logger.warn('worker-stop', `stop-marker check failed: ${(err as Error).message}`, { resource });
      return false;
    }
  };
}

/**
 * The ONE dispatch cascade: resume → (explicit lanes) preferred → default →
 * runWithFailover, with the AI-092 stop-marker probe, the AI-030 switch-back
 * drop, failure classification, session capture and the raw-send alert. The
 * human lane (dispatchMessage) and the orchestrator lane differ only through
 * their DispatchLane config. The step order is load-bearing — do not rearrange.
 */
export async function runDispatchCascade(args: CascadeArgs): Promise<CascadeOutcome> {
  const { lane, state, secrets, resource } = args;
  const defaultWorker = args.defaultWorker;
  let currentSession = state.session;
  let dispatchResult: { result: CommandResult; worker: string; session: SessionInfo | undefined } | undefined;
  let rateLimitedWorker: string | undefined;
  const failedWorkers = new Set<string>();
  let lastFailedSession: { worker: string; sessionId: string } | undefined;
  // (1) One config load, returned in the done outcome for the lane tails.
  const config = await loadConfig();

  // (2) AI-092: /stop and /steer kill the worker running right now, so EVERY
  // attempt below has to consult the marker — the between-phase checks alone
  // left the whole failover cascade uncovered (2026-08-02: a /stop killed
  // a worker mid-chain and claude answered the cancelled message anyway).
  // Handed to pa's executor as `isCancelled`, which stops the cascade and
  // suppresses the worker-exit page for the killed process.
  const isCancelledFn = args.isCancelled ?? defaultStopProbe(resource, args.updateId);

  // (3) Cooling gate before the resume attempt.
  if (currentSession && await isWorkerCoolingDown(currentSession.worker)) {
    currentSession = undefined;
  }

  // (4) AI-030: Switch-back logic. If a higher-priority worker is available, drop the current
  // session (likely from a failover worker) to trigger a fresh start on the optimal model.
  if (currentSession) {
    const preferredAvailable = state.preferred_worker && !(await isWorkerCoolingDown(state.preferred_worker));
    const defaultAvailable = defaultWorker && !(await isWorkerCoolingDown(defaultWorker));

    const isOptimal = (currentSession.worker === state.preferred_worker && preferredAvailable) ||
                      (currentSession.worker === defaultWorker && defaultAvailable && !preferredAvailable);

    if ((preferredAvailable || defaultAvailable) && !isOptimal) {
      const rec = lane.switchBackLog(currentSession.worker, preferredAvailable ? state.preferred_worker : defaultWorker);
      logger.info(rec.module, rec.text);
      currentSession = undefined;
    }
  }

  // (5) Resume attempt.
  if (currentSession && await isSessionValid(currentSession, args.workdir.dir)) {
    const activeSession = currentSession;
    try {
      const worker = config.workers.find((w) => w.name === activeSession.worker);
      if (worker) {
        const prompt = await lane.buildResumed({ userText: args.userText, replyContext: args.replyContext, pendingDesc: args.pendingDesc, worker });
        const result = args.execute
          ? await args.execute(worker, prompt, { cwd: args.workdir.dir, env: secrets, extraArgs: lane.applySessionTunables ? buildDispatchExtraArgs(state, worker, buildResumeArgs(activeSession)) : buildResumeArgs(activeSession), resource, updateId: args.updateId, agentName: activeSession.worker, contextId: args.contextId, isCancelled: isCancelledFn, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS })
          : await executeWorker(worker, prompt, { cwd: args.workdir.dir, env: secrets, extraArgs: lane.applySessionTunables ? buildDispatchExtraArgs(state, worker, buildResumeArgs(activeSession)) : buildResumeArgs(activeSession), resource, updateId: args.updateId, agentName: activeSession.worker, contextId: args.contextId, isCancelled: isCancelledFn, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS });
        if (result.success) {
          dispatchResult = { result, worker: activeSession.worker, session: activeSession };
        } else if (!isCancelledFn()) {
          if (lane.classifyFailures) {
            const co = await tryClassifyAndNotify(activeSession.worker, result, result.sessionId ?? activeSession.session_id, worker, config, state, defaultWorker, args.onNotify);
            if (co.outcome === 'rate-limit') rateLimitedWorker = activeSession.worker;
          }
          lastFailedSession = { worker: activeSession.worker, sessionId: result.sessionId ?? activeSession.session_id };
          failedWorkers.add(activeSession.worker);
        }
      }
    } catch (err) { logger.warn(lane.resumeLogModule, 'resume error', { error: String(err) }); }
    if (!dispatchResult) currentSession = undefined;
  }

  if (!dispatchResult) {
    // (6) exit 1 — AI-092: if the user /stop'd this topic while the (session) attempt above
    // was being killed, do NOT fail over to a fresh worker for a cancelled request.
    if (isCancelledFn()) {
      return { kind: 'cancelled', session: maybeDropAgySession(state.session, resource, true) };
    }

    let freshResult: { result: CommandResult; worker: string } | undefined;

    if (lane.explicitWorkerAttempts) {
      // (7) Preferred attempt.
      if (state.preferred_worker && !failedWorkers.has(state.preferred_worker) && !(await isWorkerCoolingDown(state.preferred_worker))) {
        const preferredWorkerConfig = config.workers.find((w) => w.name === state.preferred_worker);
        if (preferredWorkerConfig) {
          const priorCtx = lastFailedSession ? { ...lastFailedSession, sessionPath: getPriorSessionPath(lastFailedSession.worker, lastFailedSession.sessionId, args.workdir.dir) } : undefined;
          const prompt = await lane.buildFresh({ userText: args.userText, state, topicNames: args.topicNames, replyContext: args.replyContext, pendingDesc: args.pendingDesc, worker: preferredWorkerConfig, priorContext: priorCtx, workdir: args.workdir.tier === 'bot-cwd' ? undefined : { dir: args.workdir.dir, tier: args.workdir.tier } });
          const prefResult = args.execute
            ? await args.execute(preferredWorkerConfig, prompt, { cwd: args.workdir.dir, env: secrets, extraArgs: buildDispatchExtraArgs(state, preferredWorkerConfig), resource, updateId: args.updateId, agentName: state.preferred_worker, contextId: args.contextId, isCancelled: isCancelledFn, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS })
            : await executeWorker(preferredWorkerConfig, prompt, { cwd: args.workdir.dir, env: secrets, extraArgs: buildDispatchExtraArgs(state, preferredWorkerConfig), resource, updateId: args.updateId, agentName: state.preferred_worker, contextId: args.contextId, isCancelled: isCancelledFn, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS });
          if (prefResult.success) freshResult = { result: prefResult, worker: preferredWorkerConfig.name };
          else if (!isCancelledFn()) {
            if (lane.classifyFailures) {
              const co = await tryClassifyAndNotify(state.preferred_worker, prefResult, prefResult.sessionId, preferredWorkerConfig, config, state, defaultWorker, args.onNotify);
              if (co.outcome === 'rate-limit') rateLimitedWorker = state.preferred_worker;
            }
            lastFailedSession = { worker: state.preferred_worker!, sessionId: prefResult.sessionId ?? '' };
            failedWorkers.add(state.preferred_worker);
          }
        }
      }

      // (8) exit 2 — the preferred attempt above may have been the one that got killed.
      if (!freshResult && isCancelledFn()) {
        return { kind: 'cancelled', session: maybeDropAgySession(state.session, resource, true) };
      }

      // (9) Default attempt.
      if (!freshResult && defaultWorker && !failedWorkers.has(defaultWorker) && !(await isWorkerCoolingDown(defaultWorker))) {
        const defaultWorkerConfig = config.workers.find((w) => w.name === defaultWorker);
        if (defaultWorkerConfig) {
          const priorCtxDef = lastFailedSession ? { ...lastFailedSession, sessionPath: getPriorSessionPath(lastFailedSession.worker, lastFailedSession.sessionId, args.workdir.dir) } : undefined;
          const prompt = await lane.buildFresh({ userText: args.userText, state, topicNames: args.topicNames, replyContext: args.replyContext, pendingDesc: args.pendingDesc, worker: defaultWorkerConfig, priorContext: priorCtxDef, workdir: args.workdir.tier === 'bot-cwd' ? undefined : { dir: args.workdir.dir, tier: args.workdir.tier } });
          const defResult = args.execute
            ? await args.execute(defaultWorkerConfig, prompt, { cwd: args.workdir.dir, env: secrets, extraArgs: buildDispatchExtraArgs(state, defaultWorkerConfig), resource, updateId: args.updateId, agentName: defaultWorker, contextId: args.contextId, isCancelled: isCancelledFn, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS })
            : await executeWorker(defaultWorkerConfig, prompt, { cwd: args.workdir.dir, env: secrets, extraArgs: buildDispatchExtraArgs(state, defaultWorkerConfig), resource, updateId: args.updateId, agentName: defaultWorker, contextId: args.contextId, isCancelled: isCancelledFn, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS });
          if (defResult.success) freshResult = { result: defResult, worker: defaultWorkerConfig.name };
          else if (!isCancelledFn()) {
            if (lane.classifyFailures) {
              const co = await tryClassifyAndNotify(defaultWorker, defResult, defResult.sessionId, defaultWorkerConfig, config, state, defaultWorker, args.onNotify);
              if (co.outcome === 'rate-limit') rateLimitedWorker = rateLimitedWorker ?? defaultWorker;
            }
            lastFailedSession = { worker: defaultWorker!, sessionId: defResult.sessionId ?? '' };
            failedWorkers.add(defaultWorker);
          }
        }
      }
    }

    if (!freshResult) {
      // (10) exit 3 — explicit lanes re-check here because cancellation may have
      // landed during the preferred/default attempts; the orchestrator lane's
      // single pre-failover check was exit 1.
      if (lane.explicitWorkerAttempts && isCancelledFn()) {
        return { kind: 'cancelled', session: maybeDropAgySession(state.session, resource, true) };
      }
      const priorCtxFo = lastFailedSession ? { ...lastFailedSession, sessionPath: getPriorSessionPath(lastFailedSession.worker, lastFailedSession.sessionId, args.workdir.dir) } : undefined;
      const failoverPrompt = await lane.buildFresh({ userText: args.userText, state, topicNames: args.topicNames, replyContext: args.replyContext, pendingDesc: args.pendingDesc, worker: undefined, priorContext: priorCtxFo, workdir: args.workdir.tier === 'bot-cwd' ? undefined : { dir: args.workdir.dir, tier: args.workdir.tier } });
      const failoverOpts = {
        cwd: args.workdir.dir,
        env: secrets,
        resource,
        updateId: args.updateId,
        excludeWorkers: failedWorkers,
        onWorkerSwitch: async (payload) => { if (args.onNotify) await args.onNotify(payload); },
        checkAvailable: async (w) => !(await isWorkerCoolingDown(w.name)),
        preferredWorker: lane.failoverPreferredWorker(state, defaultWorker),
        contextId: args.contextId,
        isCancelled: isCancelledFn,
        harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS,
        ...(lane.applySessionTunables ? { getExtraArgs: (w: WorkerConfig) => buildDispatchExtraArgs(state, w) } : {}),
      };
      freshResult = args.failover
        ? await args.failover(failoverPrompt, failoverOpts)
        : await runWithFailover(failoverPrompt, { cwd: args.workdir.dir, env: secrets, resource, updateId: args.updateId, excludeWorkers: failedWorkers, onWorkerSwitch: failoverOpts.onWorkerSwitch, checkAvailable: failoverOpts.checkAvailable, preferredWorker: failoverOpts.preferredWorker, contextId: args.contextId, isCancelled: isCancelledFn, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS, ...(lane.applySessionTunables ? { getExtraArgs: (w: WorkerConfig) => buildDispatchExtraArgs(state, w) } : {}) });
      // The cascade stopped because the caller cancelled. Return the same shape
      // as the other three cancellation exits — crucially with the session
      // UNCHANGED: a killed run's session id must not become the topic's.
      //
      // Guarded on FAILURE only. A worker that finished a fraction of a second
      // before the kill landed produced a real answer, and the reply path's
      // consumeTopicStopped deliberately keeps it ("if the worker actually
      // finished before the kill landed, keep its real reply"). Bailing on a
      // successful result here would throw that answer away.
      if (!freshResult.result.success && isCancelledFn()) {
        return { kind: 'cancelled', session: maybeDropAgySession(state.session, resource, true) };
      }
    }

    // (11) Session capture through the ONE implementation (session-capture.ts —
    // WP-4/WP-5 consolidation): claude/zclaude/codex capture straight from the
    // result; agy keeps its success gate + .pb/.db file-exists check +
    // warn-and-drop, byte-same behavior as the inline block this call replaced.
    const newSession = await (args.capture ?? captureSessionForResult)(freshResult.worker, freshResult.result, resource);
    // (12) Raw-send guard (2026-09-04): after the fresh result is fully settled,
    // fire ONE best-effort pa-support alert if this run's tool commands hit
    // the Telegram Bot API directly. Never awaited into the reply path.
    if (freshResult.result.rawTelegramSends?.length) {
      alertRawTelegramSends(secrets, freshResult.worker, freshResult.result.sessionId, freshResult.result.rawTelegramSends)
        .catch((err) => logger.warn('dispatch', `raw-send alert failed: ${(err as Error).message}`, { worker: freshResult.worker }));
    }
    dispatchResult = { ...freshResult, session: newSession };
  }

  // (13)
  return { kind: 'done', result: dispatchResult.result, worker: dispatchResult.worker, session: dispatchResult.session, rateLimitedWorker, config };
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
 * One best-effort alert to pa-support when a worker turn's collected tool
 * commands hit the Telegram Bot API directly. Fail-silent by contract: a
 * failed alert must never block or corrupt the user's reply. Accepted
 * false-positive class (alert text already says so): dev commands that grep or
 * edit source containing these strings. The target is config.yaml
 * `topics.support` (resolved per-alert); when unset the alert skips — there is
 * no frozen fallback target (2026-09-04 raw-send guard record).
 */
async function alertRawTelegramSends(
  secrets: Record<string, string>,
  workerName: string,
  sessionId: string | undefined,
  sends: string[]
): Promise<void> {
  const token = secrets['TELEGRAM_BOT_TOKEN'];
  if (!token) return;
  const supportKey = await loadSupportTopic().catch(() => undefined);
  const support = parseSupportTopicKey(supportKey ?? '');
  if (!support) return;
  const excerpt = redactSecrets(sends[0].slice(0, 120)) as string;
  const text = `⚠️ Raw Telegram Bot API send detected in a worker turn (worker ${workerName}, session ${sessionId ?? 'unknown'}): ${excerpt}… — bypasses refs + logging + the target topic's queue. Contract: use pa notify --topic-thread. Review; may be benign (e.g. dev grep). (raw-send detector)`;
  await sendMessage(token, support.chatId, text, undefined, support.threadId);
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
  /** WP-D1 (A.3): the alternate findNextAvailableWorker proposed on the empty-output
   *  return — the caller's reply-send kb cascade offers it as wf:switch. */
  suggestedWorker?: string | null;
}> {
  // The human lane: explicit preferred/default attempts + session tunables +
  // executionMode tied to pendingDesc (a description turn parses as execution).
  const lane: DispatchLane = {
    resumeLogModule: 'session',
    executionMode: pendingDesc !== undefined,
    classifyFailures: true,
    suppressPrematureAsync: pendingDesc === undefined,
    explicitWorkerAttempts: true,
    applySessionTunables: true,
    failoverPreferredWorker: (state) => state.preferred_worker,
    switchBackLog: (currentWorker, target) => ({ module: 'session',
      text: `Worker switch-back detected (${currentWorker} -> ${target}). Resetting session.` }),
    buildResumed: async (a) => buildResumedPrompt(a.userText, a.replyContext, a.pendingDesc, topicNames, { omitStatic: workerReceivesStaticPromptFile(a.worker) }),
    buildFresh: async (a) => buildPrompt(a.userText, a.state, topicNames, a.replyContext, a.pendingDesc, { omitStatic: a.worker ? workerReceivesStaticPromptFile(a.worker) : false, priorContext: a.priorContext, workdir: a.workdir }),
  };

  // Default workdir if not provided (should always be provided from processUpdate)
  const outcome = await runDispatchCascade({
    lane, state, secrets, resource, defaultWorker, topicNames, onNotify, updateId,
    workdir: workdir ?? { dir: BOT_CWD, tier: 'bot-cwd' },
    contextId, userText, replyContext, pendingDesc,
  });
  if (outcome.kind === 'cancelled') {
    return { response: '', session: outcome.session, meta: null, workerError: true };
  }

  const { result, worker: workerName, session: capturedSession } = outcome;
  const { cleaned, meta } = parseMetadata(result.output, lane.executionMode);
  let deliverable = cleaned;
  if (result.success && meta === null && lane.suppressPrematureAsync && isPrematureAsyncReply(cleaned)) {
    logger.warn('dispatch', 'premature-async-reply suppressed', { worker: workerName, chars: cleaned.length, excerpt: cleaned.slice(0, 120) });
    deliverable = '';
  }
  if (result.success && deliverable.trim() === '' && meta === null) {
    const suggestedWorker = await findNextAvailableWorker(workerName, defaultWorker, state.preferred_worker, outcome.config);
    return { response: buildWorkerErrorResponse({ worker: workerName, emptyResponse: true, suggestedWorker }), session: state.session, meta: null, workerError: true, suggestedWorker };
  }
  // Only report a dispatchedWorker when it actually succeeded — on full cascade
  // exhaustion, `workerName` is the last worker tried, which still failed. Reporting
  // it here would make main.ts's caller pin the status card to a broken worker.
  return { response: buildWorkerResponse({ ...result, output: deliverable }, workerName), session: capturedSession, meta, rateLimitedWorker: outcome.rateLimitedWorker, dispatchedWorker: result.success ? workerName : undefined, rateLimitTelemetry: result.rateLimitTelemetry, workerError: result.success ? undefined : true };
}
