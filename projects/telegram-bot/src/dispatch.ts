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
  modelStatusNeedsRefresh, sanitizeSuggestedItems,
} from './logic.js';
import { parseSupportTopicKey } from './debug-command.js';
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
import { runWithFailover, executeWorker, isWorkerCoolingDown, classifyRateLimit, recordRateLimit, getCooldownStatus, NO_WORKERS_AVAILABLE_ERROR } from '../../../pa/dist/src/workers.js';
import { loadConfig } from '../../../pa/dist/src/config.js';
import type { CommandResult, FailoverNotifyPayload, RunOptions, WorkerConfig } from '../../../pa/dist/src/types.js';
import { resolveTunableArgs, mergeTunableArgs, resolveWorkerLlm, resolveWorkerEffort, selectWorkerTunables } from '../../../pa/dist/src/lib/tunables.js';
import type { TunableStore, TunableOverrides } from '../../../pa/dist/src/lib/tunables.js';
import { loadSupportTopic } from '../../../pa/dist/src/lib/maintenance/jobs/daily-recon.js';
import { redactSecrets } from '../../../pa/dist/src/lib/redact.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { parseBotResource } from '../../../pa/dist/src/lib/turn-trace.js';
import { listRows as listAuthRequestRows } from '../../../pa/dist/src/lib/auth/store.js';

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

/** Topic-tier-only extraArgs: tunable_defaults + an optional per-record model pin —
 *  session tunable_overrides are deliberately excluded (executor lanes own no /llm
 *  session). recordModel sits in the overrides slot = highest precedence, last-wins.
 *  Evangelism WP-7 (OD-4): thread/task lanes honor TOPIC-tier tunable_defaults plus
 *  a per-record `model`; the orchestrator's applySessionTunables:false divergence
 *  is untouched — this helper is for the executor lanes only. */
export function buildTopicTierExtraArgs(
  topicDefaults: TunableStore | undefined,
  recordModel: string | undefined,
  worker: WorkerConfig | undefined,
  baseArgs?: string[],
): string[] | undefined {
  const overrides: TunableOverrides | undefined = recordModel ? { model: recordModel } : undefined;
  const tunableArgs = resolveTunableArgs(
    worker,
    overrides,
    selectWorkerTunables(topicDefaults, worker?.name),
  );
  const merged = mergeTunableArgs(baseArgs, tunableArgs);
  return merged.length > 0 ? merged : undefined;
}

/**
 * Answer-provenance env (WS3, ledger schema v15, 2026-09-18): what the worker
 * records about this dispatch via task_telemetry.py — PA_WORKER_CLI /
 * PA_WORKER_MODEL / PA_WORKER_EFFORT become tasks.worker_cli/worker_model/
 * worker_effort. Resolution mirrors buildTopicTierExtraArgs exactly: the
 * record's model pin sits in the overrides slot (last-wins), topic
 * tunable_defaults supply the rest.
 *
 * PER-HOP resolution (2026-09-18, per-hop env hook): the caller hands us the
 * failover hop's own WorkerConfig via RunOptions.getEnv, so the recorded
 * worker is the one that ACTUALLY ran — a failover stamps the hop's identity,
 * not the first-chosen worker's. The CLI key always stamps (the hop's name is
 * always known); model/effort resolve from the hop's real config and may stay
 * absent → ledger NULL → the PWA chip fails open. Bonus correctness: getEnv
 * lands in worker-exec AFTER runWithFailover's secret_allowlist filtering, so
 * these keys survive workers whose static env is allowlist-stripped.
 */
export function buildWorkerProvenanceEnv(opts: {
  worker: WorkerConfig;
  topicDefaults: TunableStore | undefined;
  recordModel: string | undefined;
}): Record<string, string> {
  const env: Record<string, string> = { PA_WORKER_CLI: opts.worker.name };
  const slice = selectWorkerTunables(opts.topicDefaults, opts.worker.name);
  const model = resolveWorkerLlm(opts.worker, opts.recordModel ? { model: opts.recordModel } : undefined, slice);
  const effort = resolveWorkerEffort(opts.worker, undefined, slice);
  if (model) env.PA_WORKER_MODEL = String(model);
  if (effort) env.PA_WORKER_EFFORT = String(effort);
  return env;
}

/**
 * Turn-level routing provenance (router-metadata wave, 2026-09-20, decision 31):
 * what a serving turn knows about HOW it was routed. `buildRoutingProvenanceEnv`
 * is the vocabulary's ONE producer — the seven PA_ROUTING_* env keys the ledger's
 * router_* columns read via task_telemetry.py (schema v16). Closed vocabulary per
 * key; an optional fact is simply absent when it doesn't apply. NO turn text may
 * ride any field — ids only in `target` (a ledger conversation id), enum words
 * everywhere else (the mapping test guards this structurally).
 */
export interface TurnRoutingMeta {
  decision: 'router' | 'ladder' | 'command';
  placement?: 'continued-here' | 'diverted' | 'new-conversation' | 'split';
  /** A ledger conversation id (vi-<12 hex>) — never a topic name, never text. */
  target?: string;
  steer?: 'steer' | 'wait';
  /** Who decided the steer/wait (decision 30). Together-or-absent with `steer`:
   *  the builder emits the steer keys ONLY when BOTH are set. */
  steerBy?: 'router' | 'operator';
  effortProj?: 'applied' | 'nearest' | 'recategorize';
}

/** The seven-key env bag (§1.1). Pure: optional facts omit their key; never an
 *  empty string, never an out-of-vocabulary value. `PA_ROUTING_FAILOVERS` is
 *  NOT produced here — the dispatch cascade appends it per hop (§1.3). */
export function buildRoutingProvenanceEnv(m: TurnRoutingMeta): Record<string, string> {
  const env: Record<string, string> = { PA_ROUTING_DECISION: m.decision };
  if (m.placement) env.PA_ROUTING_PLACEMENT = m.placement;
  if (m.target) env.PA_ROUTING_TARGET = m.target;
  // Together-or-absent (§1.1): a steer fact is stamped only when BOTH the
  // steer word and its decider are present.
  if (m.steer && m.steerBy) {
    env.PA_ROUTING_STEER = m.steer;
    env.PA_ROUTING_STEER_BY = m.steerBy;
  }
  if (m.effortProj) env.PA_ROUTING_EFFORT_PROJ = m.effortProj;
  return env;
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
      await refreshCard(token, chatId, threadId, state, effectiveDefault, config);
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
      await refreshCard(token, chatId, threadId, state, effectiveDefault, config);
    }
    return;
  }

  if (!state.pinned_status_message_id) {
    await refreshCard(token, chatId, threadId, state, effectiveDefault, config);
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
  /** Decision 20: the router's full chain (chosen.worker first, entry 0
   *  included — excludeWorkers already handles the failed default attempt).
   *  Forwarded into runWithFailover ONLY when model_router.surfaces.fallback
   *  === 'live' (spec-recheck M2: dark = the shadow line records the chain,
   *  the failover seam receives NO candidateOrder, dispatch byte-identical). */
  candidateOrder?: string[];
  /** Decision 25: true when this is a router-decided (non-command) turn under
   *  an effective deprecate_pins gate — the failover opts carry ignoreWorkerPin
   *  so config.worker_pin reordering is skipped on this dispatch (spec §5). */
  routedTurn?: boolean;
  /** Router-metadata wave (2026-09-20, decision 31): the turn-level PA_ROUTING_*
   *  env bag (buildRoutingProvenanceEnv's output) merged into every attempt
   *  site's getEnv AFTER the per-hop worker provenance. Absent ⇒ only the
   *  PA_WORKER_* keys stamp (fail-open; correction 1 closes the human-lane
   *  PA_WORKER_* gap on every path regardless). */
  routingEnv?: Record<string, string>;
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
  // Auth-prompt sentinel (auth broker Phase A, 2026-09-10, C6/D8): a broker
  // row created at or after this instant means the worker raised a proper
  // `pa auth request` sometime during this dispatch — snapshotted before any
  // worker runs so the later "was a request minted?" check has a fixed start.
  const dispatchStartedAt = new Date().toISOString();
  // (1) One config load, returned in the done outcome for the lane tails.
  const config = await loadConfig();
  // Router-as-orchestrator gates (2026-09-19, spec §2.3/§5): the chain
  // pass-through is SURFACE-gated (fallback 'live' — dark forwards nothing);
  // ignoreWorkerPin rides the deprecate-pins gate (block present + enabled +
  // not explicitly false) on routed turns — the two gates are independent.
  const routerBlock = config.model_router;
  const fallbackLive = routerBlock?.surfaces?.fallback === 'live';
  const pinsDeprecated =
    routerBlock !== undefined && routerBlock.enabled === true && routerBlock.deprecate_pins !== false;
  const candidateOrder = fallbackLive ? args.candidateOrder : undefined;
  const ignoreWorkerPin = pinsDeprecated && args.routedTurn === true ? true : undefined;

  // Router-metadata wave (2026-09-20, correction 1): EVERY attempt site
  // evaluates getEnv — the per-hop PA_WORKER_* provenance with the turn-level
  // PA_ROUTING_* bag merged after it. Present even when routingEnv is
  // undefined: the human lane previously stamped NO provenance at all (NULL
  // ledger columns on the primary serving lane).
  const hopEnv = (w: WorkerConfig): Record<string, string> => ({
    ...buildWorkerProvenanceEnv({ worker: w, topicDefaults: state.tunable_defaults, recordModel: undefined }),
    ...(args.routingEnv ?? {}),
  });
  // §1.3 failover count: failedWorkers (explicit resume/preferred/default
  // attempts that failed) + onWorkerSwitch invocations (ladder attempts that
  // failed before the hop that succeeded). The failover arm's getEnv appends
  // PA_ROUTING_FAILOVERS so the SURVIVING hop records the count — incremented
  // inside onWorkerSwitch, which runWithFailover awaits BEFORE the next hop's
  // getEnv evaluates.
  let failoverSwitches = 0;

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
          ? await args.execute(worker, prompt, { cwd: args.workdir.dir, env: secrets, extraArgs: lane.applySessionTunables ? buildDispatchExtraArgs(state, worker, buildResumeArgs(activeSession)) : buildResumeArgs(activeSession), resource, updateId: args.updateId, agentName: activeSession.worker, contextId: args.contextId, isCancelled: isCancelledFn, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS, getEnv: hopEnv })
          : await executeWorker(worker, prompt, { cwd: args.workdir.dir, env: secrets, extraArgs: lane.applySessionTunables ? buildDispatchExtraArgs(state, worker, buildResumeArgs(activeSession)) : buildResumeArgs(activeSession), resource, updateId: args.updateId, agentName: activeSession.worker, contextId: args.contextId, isCancelled: isCancelledFn, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS, getEnv: hopEnv });
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
            ? await args.execute(preferredWorkerConfig, prompt, { cwd: args.workdir.dir, env: secrets, extraArgs: buildDispatchExtraArgs(state, preferredWorkerConfig), resource, updateId: args.updateId, agentName: state.preferred_worker, contextId: args.contextId, isCancelled: isCancelledFn, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS, getEnv: hopEnv })
            : await executeWorker(preferredWorkerConfig, prompt, { cwd: args.workdir.dir, env: secrets, extraArgs: buildDispatchExtraArgs(state, preferredWorkerConfig), resource, updateId: args.updateId, agentName: state.preferred_worker, contextId: args.contextId, isCancelled: isCancelledFn, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS, getEnv: hopEnv });
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
            ? await args.execute(defaultWorkerConfig, prompt, { cwd: args.workdir.dir, env: secrets, extraArgs: buildDispatchExtraArgs(state, defaultWorkerConfig), resource, updateId: args.updateId, agentName: defaultWorker, contextId: args.contextId, isCancelled: isCancelledFn, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS, getEnv: hopEnv })
            : await executeWorker(defaultWorkerConfig, prompt, { cwd: args.workdir.dir, env: secrets, extraArgs: buildDispatchExtraArgs(state, defaultWorkerConfig), resource, updateId: args.updateId, agentName: defaultWorker, contextId: args.contextId, isCancelled: isCancelledFn, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS, getEnv: hopEnv });
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
        onWorkerSwitch: async (payload) => {
          failoverSwitches++;
          if (lane.classifyFailures && payload.kind === 'rate-limit') {
            rateLimitedWorker = rateLimitedWorker ?? payload.from;
          }
          if (args.onNotify) await args.onNotify(payload);
        },
        checkAvailable: async (w) => !(await isWorkerCoolingDown(w.name)),
        preferredWorker: lane.failoverPreferredWorker(state, defaultWorker),
        ...(candidateOrder ? { candidateOrder } : {}),
        ...(ignoreWorkerPin ? { ignoreWorkerPin } : {}),
        contextId: args.contextId,
        isCancelled: isCancelledFn,
        harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS,
        ...(lane.applySessionTunables ? { getExtraArgs: (w: WorkerConfig) => buildDispatchExtraArgs(state, w) } : {}),
        getEnv: (w: WorkerConfig) => ({ ...hopEnv(w), PA_ROUTING_FAILOVERS: String(failedWorkers.size + failoverSwitches) }),
      };
      freshResult = args.failover
        ? await args.failover(failoverPrompt, failoverOpts)
        : await runWithFailover(failoverPrompt, { cwd: args.workdir.dir, env: secrets, resource, updateId: args.updateId, excludeWorkers: failedWorkers, onWorkerSwitch: failoverOpts.onWorkerSwitch, checkAvailable: failoverOpts.checkAvailable, preferredWorker: failoverOpts.preferredWorker, ...(candidateOrder ? { candidateOrder } : {}), ...(ignoreWorkerPin ? { ignoreWorkerPin } : {}), contextId: args.contextId, isCancelled: isCancelledFn, harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS, ...(lane.applySessionTunables ? { getExtraArgs: (w: WorkerConfig) => buildDispatchExtraArgs(state, w) } : {}), getEnv: (w: WorkerConfig) => ({ ...hopEnv(w), PA_ROUTING_FAILOVERS: String(failedWorkers.size + failoverSwitches) }) });
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
      // AI-251: the failover made ZERO attempts because every candidate was
      // cooling — nothing ran, so nothing was classified, but an all-cooling
      // candidate set IS rate-limit evidence (the "all workers rate-limited"
      // dead-end). Seed the requeue ladder's evidence flag from the cooldown
      // state; a no-workers-available failure with any non-cooling candidate
      // (a broken binary, a bad config) keeps today's immediate error reply.
      if (!freshResult.result.success
          && freshResult.result.error === NO_WORKERS_AVAILABLE_ERROR
          && lane.classifyFailures) {
        const cooling = await getCooldownStatus().catch(() => ({} as Record<string, { cooldown_until: string }>));
        const nowMs = Date.now();
        const coolingNow = new Set(
          Object.entries(cooling)
            .filter(([, e]) => {
              const t = new Date(e.cooldown_until).getTime();
              return Number.isFinite(t) && t > nowMs;
            })
            .map(([name]) => name)
        );
        const allCooling = config.workers.length > 0
          && config.workers.every((w) => failedWorkers.has(w.name) || coolingNow.has(w.name) || w.manual_only);
        const firstCooling = config.workers.find((w) => coolingNow.has(w.name));
        if (allCooling && firstCooling) rateLimitedWorker = rateLimitedWorker ?? firstCooling.name;
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
    // Auth-prompt sentinel (auth broker Phase A, 2026-09-10, C6/D8): after the
    // fresh result is fully settled, fire ONE best-effort nudge into the same
    // topic if this run's output looked auth-shaped but no broker request was
    // minted. Never awaited into the reply path.
    if (freshResult.result.authPrompts?.length) {
      const bot = parseBotResource(resource);
      if (bot) {
        nudgeAuthPrompt({ secrets, sinceIso: dispatchStartedAt }, freshResult.result, bot.chatId, bot.threadId)
          .catch((err) => logger.warn('dispatch', `auth nudge failed: ${(err as Error).message}`, { worker: freshResult.worker }));
      }
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

/**
 * The auth-prompt nudge's exact user-facing text (auth broker Phase A,
 * 2026-09-10 build spec §5 WP-G, G-E4). Byte-identical to the spec — do not
 * edit without a spec change.
 */
export const AUTH_PROMPT_NUDGE_TEXT =
  'Your last turn printed something that looks like an authorization step (a link, a code to enter, or a paste prompt), but no auth request was raised. Do not stall and do not ask here: run pa auth request with the shape, then pa auth wait, and re-run the tool non-interactively with the value.';

export interface NudgeAuthPromptDeps {
  secrets: Record<string, string>;
  /** ISO timestamp marking the start of this dispatch (before any worker
   *  ran). A broker row created at or after this instant means the worker
   *  already raised a `pa auth request` during this turn. */
  sinceIso: string;
  /** Injected for tests. Real default: pa/src/lib/auth/store.ts's listRows()
   *  (the WP-D broker store's own exported reader — never a second parser),
   *  filtered to rows created at/after sinceIso. */
  recentAuthRequestsFn?: (sinceIso: string) => number;
  /** Injected for tests. Real default: telegram.js's sendMessage. */
  sendFn?: typeof sendMessage;
}

function defaultRecentAuthRequests(sinceIso: string): number {
  return listAuthRequestRows().filter((row) => row.created_at >= sinceIso).length;
}

/**
 * One best-effort nudge into the same topic when a worker turn's raw stdout
 * looked auth-shaped (auth broker Phase A, 2026-09-10, C6/D8) but no broker
 * request was minted during this dispatch. Fail-silent by contract, same as
 * alertRawTelegramSends: a failed nudge must never block or alter the
 * delivered reply. Fires at most once per dispatch. Never logs the matched
 * line's full text — only the kind (`authPrompts`) and a count, never the
 * content, which could carry a device code or URL token.
 */
export async function nudgeAuthPrompt(
  deps: NudgeAuthPromptDeps,
  result: CommandResult,
  chatId: number,
  threadId: number
): Promise<void> {
  if (!result.authPrompts?.length) return;
  const recentFn = deps.recentAuthRequestsFn ?? defaultRecentAuthRequests;
  if (recentFn(deps.sinceIso) > 0) return;
  const token = deps.secrets['TELEGRAM_BOT_TOKEN'];
  if (!token) return;
  const send = deps.sendFn ?? sendMessage;
  await send(token, chatId, AUTH_PROMPT_NUDGE_TEXT, undefined, threadId || undefined);
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
  /** Decision 20: the routed turn's full chain — forwarded into CascadeArgs
   *  verbatim (runDispatchCascade applies the fallback-surface gate itself).
   *  WP-5 integrator seam: dispatchMessage was the missing producer leg. */
  candidateOrder?: string[],
  /** Decision 25: true on a router-decided turn under an effective
   *  deprecate-pins gate — forwarded into CascadeArgs unchanged. */
  routedTurn?: boolean,
  /** Router-metadata wave (2026-09-20): the turn-level PA_ROUTING_* env bag —
   *  forwarded into CascadeArgs.routingEnv verbatim. */
  routingEnv?: Record<string, string>,
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
    ...(candidateOrder !== undefined ? { candidateOrder } : {}),
    ...(routedTurn !== undefined ? { routedTurn } : {}),
    ...(routingEnv !== undefined ? { routingEnv } : {}),
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
  // AI-234: sanitize suggested_items (fail-open drops non-plain chips) — one
  // more pure pass on the envelope before returning, mirroring the orchestrator.
  if (meta) {
    const sanitizedItems = sanitizeSuggestedItems(meta.suggested_items);
    meta.suggested_items = sanitizedItems.length > 0 ? sanitizedItems : undefined;
  }
  return { response: buildWorkerResponse({ ...result, output: deliverable }, workerName), session: capturedSession, meta, rateLimitedWorker: outcome.rateLimitedWorker, dispatchedWorker: result.success ? workerName : undefined, rateLimitTelemetry: result.rateLimitTelemetry, workerError: result.success ? undefined : true };
}
