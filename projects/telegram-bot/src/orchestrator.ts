/**
 * Orchestrator mode (AI-203 first increment, WP-2).
 *
 * A topic with `orchestrator_enabled === true` dispatches every non-command
 * message to the ORCHESTRATOR conversation — the topic's `state.session` CLI
 * conversation in a new role: interpret → route → report, never execute. The
 * turn dispatch runs the shared dispatch cascade in dispatch.ts (AI-173 phase
 * 3): orchestrator turns stamp the rate-limit ledger like human-lane turns, and
 * the executionMode=false parse pin and the AI-030 switch-back text are lane
 * config, not mirrors. This module also owns the §4.4 validators +
 * threads-section renderer, the §4.6 prompt builders, and the spawn/steer
 * handlers that perform the store write and fire the thread executor (WP-4).
 *
 * Nothing here imports main.ts — main.ts is the composition root (same
 * convention as task-executor.ts / thread-executor.ts).
 */

import { todayIST, nowIST } from '../../../pa/dist/src/ist.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { appendTopicEvent } from '../../../pa/dist/src/lib/topic-events.js';
import type { CommandResult, FailoverNotifyPayload, RunOptions, WorkerConfig } from '../../../pa/dist/src/types.js';
import type { ConversationState, PAMeta, PAMetaAction, SessionInfo } from './types.js';
import type { TopicNameMap } from './topic-names.js';
import type { TopicWorkdir } from './topic-workdir.js';
import type { ThreadRecord } from './topic-threads.js';
import {
  createThread,
  getThread,
  listThreads,
  queueThreadInput,
  claimThreadStarts,
  bumpRunSeq,
  updateThread,
  MAX_PENDING_INPUT_PER_THREAD,
} from './topic-threads.js';
import { getTopicBrainInfo } from './topic-brains.js';
import { buildTopicDescription } from './context.js';
// Increment 4: the fire/claim helpers and the interrupt signal live in
// thread-executor.ts (single-sourced — three callers fire, not just this
// module); the thread-scoped kill lives in worker-stop.ts.
import {
  fireThreadExecution,
  fireClaimedThreads,
  signalThreadInterrupt,
  topicCtxFromKey,
  THREAD_RESULT_EXCERPT_CHARS,
} from './thread-executor.js';
import { stopThreadWorker } from './worker-stop.js';
// The shared dispatch cascade (dispatch.ts) owns the stop probe, session
// validity, resume args, harvest windows and capture; this module keeps only
// the tail's next-worker suggestion.
import { findNextAvailableWorker } from './session-capture.js';
import { runDispatchCascade, type DispatchLane } from './dispatch.js';
// Single logic.js import direction (no cycle): logic.ts never imports this
// module — it owns ORCHESTRATOR_PATTERN's definition (beside isKnownCommand)
// and this module re-exports it for main.ts's interception import.
import {
  isPrematureAsyncReply,
  parseMetadata,
  buildWorkerResponse,
  buildWorkerErrorResponse,
} from './logic.js';

// Re-export so main.ts's interception imports the pattern from this module
// family; the DEFINITION lives in logic.ts beside isKnownCommand's
// testPatterns (spec grep obligation: every consumer imports, none restates).
export { ORCHESTRATOR_PATTERN } from './logic.js';

/** §4.1 renderer constant — max thread lines the orchestrator section renders. */
export const THREADS_SECTION_MAX_RENDERED = 8;
/** §4.4 failed-thread error excerpt cap (chars). */
const THREAD_ERROR_EXCERPT_CHARS = 80;

// Default bot working directory — same formula as main.ts's BOT_CWD (duplicated
// rather than imported: main.ts is the composition root and must not be
// imported from here; task-executor.ts's TASK_SPAWN_CWD precedent).
const BOT_CWD = process.env.BOT_CWD || process.cwd();

// ---------------------------------------------------------------------------
// §4.4 validators + section renderer
// ---------------------------------------------------------------------------

/** §4.4 — spawn_thread shape validation (pure; the running cap is the store's). */
export function validateSpawnThreadAction(
  a: PAMetaAction
): { ok: true; title: string; prompt: string } | { ok: false; reason: string } {
  const title = typeof a.title === 'string' ? a.title.trim() : '';
  if (title.length < 1 || title.length > 80) return { ok: false, reason: 'title must be 1..80 chars' };
  const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
  if (prompt.length < 1 || prompt.length > 4000) return { ok: false, reason: 'prompt must be 1..4000 chars' };
  return { ok: true, title, prompt };
}

export type SteerMode = 'queue' | 'interrupt';

/** §4.4 — steer_thread validation against the CURRENT store records (pure).
 *  Increment 4: mode is orchestrator-classified per message; absent/empty ⇒
 *  'queue'. queued now means "the input waits for delivery" — true for a
 *  RUNNING thread (waits for the run) and for a QUEUED thread (waits for a
 *  slot); false only for an immediately startable terminal thread. */
export function validateSteerThreadAction(
  a: PAMetaAction,
  threads: ThreadRecord[]
): { ok: true; thread: ThreadRecord; queued: boolean; mode: SteerMode } | { ok: false; reason: string } {
  const threadId = typeof a.thread_id === 'string' ? a.thread_id.trim() : '';
  if (!/^t-\d+$/.test(threadId)) return { ok: false, reason: 'thread_id must look like t-3' };
  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return { ok: false, reason: `unknown thread ${threadId}` };
  const message = typeof a.message === 'string' ? a.message.trim() : '';
  if (message.length < 1 || message.length > 4000) return { ok: false, reason: 'message must be 1..4000 chars' };
  if (thread.status === 'cancelled') return { ok: false, reason: `thread ${threadId} is cancelled` };
  if (thread.pendingInput.length >= MAX_PENDING_INPUT_PER_THREAD) {
    return { ok: false, reason: `pending input is full (${MAX_PENDING_INPUT_PER_THREAD} max)` };
  }
  const mode: SteerMode | null =
    a.mode === undefined || a.mode === '' ? 'queue'
    : a.mode === 'queue' ? 'queue'
    : a.mode === 'interrupt' ? 'interrupt'
    : null;
  if (mode === null) return { ok: false, reason: 'mode must be "queue" or "interrupt"' };
  return { ok: true, thread, queued: thread.status === 'running' || thread.status === 'queued', mode };
}

/** Anchored on the FIRST LINE of the four frozen thread FYIs (program SPEC
 *  §4.7: pickup/retry/done/failed — thread-executor.ts is their only producer;
 *  the ref footer follows after a blank line, so ^ holds on the sent text). A
 *  reply whose raw anchor matches steers the captured thread directly
 *  (increment 3) — no orchestrator turn. thread-executor.test.ts pins this
 *  pattern against the REAL captured FYI texts (cross-module drift guard). */
export const THREAD_FYI_ANCHOR_PATTERN =
  /^(?:🧵|⏳|✅|❌) Thread (t-\d+) (?:started:|hit a snag|done:|failed:)/;

/** Direct replies only: the RAW reply_to_message text is the one surface
 *  consulted — quote text, topic turns and archive lookups never match, so a
 *  QUOTE of an FYI stays a normal orchestrator turn. Returns the thread id or
 *  null. Existence is the caller's check (getThread): a user-crafted
 *  FYI-shaped text naming a live thread steers it — deliberate; the steer
 *  validator still applies. */
export function resolveThreadFyiAnchor(msg: {
  reply_to_message?: { text?: string; caption?: string };
}): string | null {
  const raw = msg.reply_to_message?.text || msg.reply_to_message?.caption;
  if (!raw) return null;
  const m = THREAD_FYI_ANCHOR_PATTERN.exec(raw);
  return m ? m[1] : null;
}

/** §4.2 — orchestrator mode gate. */
export function isOrchestratorMode(state: ConversationState): boolean {
  return state.orchestrator_enabled === true;
}

/** §4.4 — remove spawn/steer actions, preserve everything else (null-safe). */
export function stripOrchestratorActions(meta: PAMeta | null): PAMeta | null {
  if (!meta) return null;
  return { ...meta, actions: meta.actions.filter((a) => a.type !== 'spawn_thread' && a.type !== 'steer_thread') };
}

/** §4.4 — the `## Execution threads` section (newest first, max 8 rendered). */
export function renderThreadsSection(threads: ThreadRecord[]): string {
  const lines: string[] = ['## Execution threads'];
  if (threads.length === 0) {
    lines.push('(none yet)');
    return lines.join('\n');
  }
  const sorted = [...threads].sort((a, b) => b.n - a.n);
  const rendered = sorted.slice(0, THREADS_SECTION_MAX_RENDERED);
  for (const t of rendered) {
    if (t.status === 'done') {
      lines.push(`- ${t.id} — ${t.title} (done) ${(t.lastResult ?? '').slice(0, THREAD_RESULT_EXCERPT_CHARS)}`);
    } else if (t.status === 'failed') {
      lines.push(`- ${t.id} — ${t.title} (failed: ${(t.lastError ?? '').slice(0, THREAD_ERROR_EXCERPT_CHARS)})`);
    } else if (t.status === 'cancelled') {
      lines.push(`- ${t.id} — ${t.title} (cancelled)`);
    } else if (t.status === 'queued') {
      const queuedSuffix = t.pendingInput.length > 0 ? `, +${t.pendingInput.length} queued` : '';
      lines.push(`- ${t.id} — ${t.title} (queued${queuedSuffix})`);
    } else {
      const queuedSuffix = t.pendingInput.length > 0 ? `, +${t.pendingInput.length} queued` : '';
      lines.push(`- ${t.id} — ${t.title} (running${queuedSuffix})`);
    }
  }
  const older = sorted.length - rendered.length;
  if (older > 0) lines.push(`(+${older} older threads — pa topic-threads summary omitted)`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// §4.6 prompts
// ---------------------------------------------------------------------------

/**
 * §4.6 fresh orchestrator prompt (frozen skeleton; `<...>` are the only
 * substitutions). `opts.topicNames` feeds buildTopicDescription; without the
 * map the Topic section renders brain+recall pointers only.
 */
export async function buildOrchestratorPrompt(
  userMessage: string,
  state: ConversationState,
  threads: ThreadRecord[],
  opts?: { topicNames?: TopicNameMap }
): Promise<string> {
  const today = todayIST();
  const now = nowIST();

  // Byte-copy of context.ts buildPrompt's brain-pointer block (unexported
  // local there — do not reflow; AI-203 WP-2).
  const brainInfo = await getTopicBrainInfo(state.chat_id, state.thread_id);
  let brainPointerLine = '';
  if (brainInfo) {
    const consolidated = brainInfo.consolidated
      ? `consolidated ${brainInfo.consolidated.slice(0, 10)}`
      : 'freshness unknown';
    const covers = brainInfo.covers
      ? `covers through ${brainInfo.covers.slice(0, 10)}`
      : '';
    brainPointerLine = `\nTopic brain: ${brainInfo.path} (${consolidated}${covers ? `, ${covers}` : ''}) — durable per-topic knowledge: what was discussed, decided, and left open. Read it before assuming prior context in this topic; fresh turns override it.`;
  }

  // Byte-copy of context.ts buildPrompt's recall pointer line (unexported
  // local there — do not reflow; AI-203 WP-2).
  const recallPointerLine = `\nRecall: \`pa recall "<terms>" --thread ${state.thread_id} --json\` searches this topic's full history, worker traces, topic brains and the Ecosystem KB — use it instead of guessing about anything before the window above.`;

  const topicDesc = buildTopicDescription(state, opts?.topicNames);

  return `You are the orchestrator for a Telegram forum topic. You talk with the user and route work; you never execute work yourself.

Today is ${today}. Current time (IST): ${now}.

## Topic
${topicDesc}${brainPointerLine}${recallPointerLine}

## Execution threads
${renderThreadsSection(threads)}

## Telegram Metadata
Chat ID: ${state.chat_id}
Thread ID: ${state.thread_id}

## Your role
- You have NO tools. You cannot read files, run commands, or browse. Your only outputs are your reply text and an optional [PA_META] envelope.
- Classify every incoming message:
  - Pure conversation, questions, opinions, planning: answer directly from your own knowledge.
  - Work that needs tools (commands, files, downloads, research on disk): spawn a thread.
  - A follow-up, correction, or new instruction for work already in a thread: steer that thread.
- spawn_thread: the thread starts a FRESH CLI conversation and does NOT see this chat. Write its prompt self-contained: the goal, relevant absolute file paths, constraints, and what "done" looks like. If all threads are busy, the spawn parks and starts automatically when one finishes.
- steer_thread: pick mode per message. "interrupt" kills the thread's current run and restarts it right away with your message folded in — use it when the message redirects, corrects, or invalidates what the thread is doing. "queue" delivers your message as the thread's next turn after the current run finishes — use it when the message adds to or builds on the running work. When both readings fit, pick interrupt (redoing partial work costs less than finishing obsolete work). The thread keeps its own conversation context, so you can steer a finished thread to continue it.
- When you spawn or steer, your reply says so plainly with the thread id (e.g. "Spawning a thread to sweep the logs (t-3)"), and states that the result will arrive in this topic — that is true here; the system delivers it.
- Consequential work (modifying tracked files, sending email or messages, spending money, destructive operations): do NOT spawn immediately. Describe the plan in one short paragraph and arm confirm_required; when the user confirms, spawn in your next turn.
- Thread status questions: answer from the Execution threads section only. Finished threads' results appear there as excerpts; summarize them, never re-execute them.

## PA_META (optional last line, single-line JSON, nothing after it):
[PA_META]: {"actions":[{"type":"T",...}]}
Types available to you: spawn_thread{title,prompt} | steer_thread{thread_id,message,mode} | confirm_required | question{text,options} | watch_job{description,check,deadline_minutes} | kb_note{domain,note} | run_skill{skill}
- spawn_thread: title <=80 chars; prompt <=4000 chars, self-contained.
- steer_thread: thread_id like "t-3"; message <=4000 chars; mode "queue"|"interrupt" (optional, default "queue").
- question: you need the user to pick one of up to 4 options (each <=40 chars, text <=500 chars) — the reply renders option buttons.
- confirm_required: arms a yes/no confirmation; the user's answer arrives as your next turn.
- watch_job / kb_note / run_skill: platform-default meaning (read-only completion watch; KB Sources.md note; trigger a pa skill after your response).
Omit PA_META otherwise.`;
}

/**
 * §4.6 resumed orchestrator prompt = buildResumedPrompt's exact shape with TWO
 * deltas: the `## Execution threads` section inserted before `## Current
 * Message`, and the pending-confirmation sentence swapped for the
 * spawn_thread instruction.
 */
export async function buildOrchestratorResumedPrompt(
  userMessage: string,
  replyContext?: string,
  pendingAction?: string,
  threads: ThreadRecord[] = []
): Promise<string> {
  const today = todayIST();
  const now = nowIST();

  const replySection = replyContext
    ? `## Replying To\n${replyContext}\n\n`
    : '';

  const pendingSection = pendingAction
    ? `## Pending Confirmation\nThe user previously said "yes" to this proposed action:\n${pendingAction}\nEmit the spawn_thread action for it now (self-contained prompt).\n\n`
    : '';

  return `## Context Update
Today is ${today}. Current time (IST): ${now}.

${replySection}${pendingSection}${renderThreadsSection(threads)}

## Current Message
${userMessage}`;
}

// ---------------------------------------------------------------------------
// §4.5 dispatch
// ---------------------------------------------------------------------------

export interface OrchestratorTurnArgs {
  userText: string;
  replyContext?: string;
  pendingDesc?: string;
  topicState: ConversationState;
  secrets: Record<string, string>;
  resourceId: string;
  chatId: number;
  threadId: number;
  defaultWorker?: string;
  onNotify?: (payload: FailoverNotifyPayload) => Promise<void>;
  updateId?: number;
  workdir?: TopicWorkdir;
  contextId?: string;
  isCancelled?: () => boolean;
  /** Feeds buildTopicDescription in the fresh prompt (rendered without it). */
  topicNames?: TopicNameMap;
  /** Test seams (task-executor.ts dispatch-seam precedent). */
  execute?: (worker: WorkerConfig, prompt: string, opts: RunOptions) => Promise<CommandResult>;
  failover?: (prompt: string, opts: RunOptions) => Promise<{ worker: string; result: CommandResult }>;
  capture?: (worker: string, result: CommandResult, resource: string) => Promise<SessionInfo | undefined>;
}
/** One validated routing action from an orchestrator turn (increment 4
 *  fan-out: a single reply may carry N spawns + N steers, in envelope
 *  order, so a folded batch routes each sub-message to its right target). */
export type OrchestratorRoute =
  | { kind: 'spawn'; title: string; prompt: string }
  | { kind: 'steer'; thread: ThreadRecord; message: string; queued: boolean; mode: SteerMode };

export interface OrchestratorTurnResult {
  response: string; // parseMetadata-cleaned, spawn/steer stripped, rejections appended
  meta: PAMeta | null; // spawn/steer REMOVED — downstream applyMetaActions never sees them
  routes: OrchestratorRoute[]; // validated, in envelope order; [] when none
  session: SessionInfo | undefined;
  dispatchedWorker?: string;
  workerError?: boolean;
  rateLimitedWorker?: string;
  suggestedWorker?: string | null;
}

/**
 * The orchestrator lane over runDispatchCascade (§4.5): the shared core resumes
 * the orchestrator session if valid and its worker not cooling, else goes fresh
 * via runWithFailover — with failure classification ON, so a rate-limited
 * orchestrator attempt stamps the rate-limit ledger and fires the failover
 * notice exactly like a human-lane turn. Parses with executionMode=false ALWAYS
 * (§1 row 6: a confirmed-action turn must still emit spawn_thread; the AI-202
 * guard composes for free because it is gated on meta === null). Cancels mirror
 * dispatchMessage's exits; session capture goes through the ONE implementation.
 */
export async function dispatchOrchestratorTurn(args: OrchestratorTurnArgs): Promise<OrchestratorTurnResult> {
  const state = args.topicState;
  const resource = args.resourceId;
  const key = `${args.chatId}_${args.threadId}`;
  const resolvedWorkdir = args.workdir ?? { dir: BOT_CWD, tier: 'bot-cwd' as const };

  // The orchestrator lane is CONFIG over the shared cascade: no explicit
  // preferred/default attempts, NO session tunables (observed divergence,
  // preserved — orchestrator turns drop /model-style session tunables by
  // design here), the executionMode=false parse pin, and the byte-exact
  // orchestrator switch-back record.
  const lane: DispatchLane = {
    resumeLogModule: 'orchestrator',
    executionMode: false, // parse pin: ALWAYS false — a confirmed-action turn still emits spawn_thread
    classifyFailures: true, // the phase-3 gain: failed orchestrator attempts stamp the ledger + notify
    suppressPrematureAsync: true,
    explicitWorkerAttempts: false,
    applySessionTunables: false, // observed divergence, preserved
    failoverPreferredWorker: (laneState, defaultWorker) => laneState.preferred_worker || defaultWorker,
    switchBackLog: (currentWorker) => ({
      module: 'orchestrator',
      text: `worker switch-back (${currentWorker}); resetting session`,
    }),
    buildResumed: async (a) =>
      buildOrchestratorResumedPrompt(a.userText, a.replyContext, a.pendingDesc, await listThreads(key)),
    buildFresh: async (a) =>
      buildOrchestratorPrompt(a.userText, a.state, await listThreads(key), { topicNames: a.topicNames }),
  };

  const outcome = await runDispatchCascade({
    lane,
    state,
    secrets: args.secrets,
    resource,
    defaultWorker: args.defaultWorker,
    topicNames: args.topicNames,
    onNotify: args.onNotify,
    updateId: args.updateId,
    workdir: resolvedWorkdir,
    contextId: args.contextId,
    isCancelled: args.isCancelled,
    execute: args.execute,
    failover: args.failover,
    capture: args.capture,
    userText: args.userText,
    replyContext: args.replyContext,
    pendingDesc: args.pendingDesc,
  });
  if (outcome.kind === 'cancelled') {
    return { response: '', meta: null, routes: [], session: outcome.session, workerError: true };
  }

  const { result, worker: workerName, session: capturedSession } = outcome;
  // Parse choice (§1 row 6): executionMode=false ALWAYS — a confirmed-action
  // turn can still emit spawn_thread, and the AI-202 guard composes for free
  // because it is gated on meta === null. Both dispatch paths converge here.
  const { cleaned, meta: rawMeta } = parseMetadata(result.output, lane.executionMode);
  let deliverable = cleaned;
  if (result.success && rawMeta === null && lane.suppressPrematureAsync && isPrematureAsyncReply(cleaned)) {
    logger.warn('orchestrator', 'premature-async-reply suppressed', {
      worker: workerName,
      chars: cleaned.length,
      excerpt: cleaned.slice(0, 120),
    });
    deliverable = '';
  }
  if (result.success && deliverable.trim() === '' && rawMeta === null) {
    const suggestedWorker = await findNextAvailableWorker(workerName, args.defaultWorker, state.preferred_worker, outcome.config);
    return {
      response: buildWorkerErrorResponse({ worker: workerName, emptyResponse: true, suggestedWorker }),
      meta: null,
      routes: [],
      session: state.session,
      workerError: true,
      suggestedWorker,
    };
  }

  // Strip spawn/steer from the envelope downstream applyMetaActions sees, and
  // validate EVERY routing action into the fan-out routes list (increment 4);
  // validation failures downgrade to rejected lines appended to the response
  // (§4.5). One store read per turn — all actions validate against the SAME
  // snapshot; handleSteer re-validates fresh by contract.
  const meta = stripOrchestratorActions(rawMeta);
  const routes: OrchestratorRoute[] = [];
  let rejections = '';
  const hasRouting = (rawMeta?.actions ?? []).some((a) => a.type === 'spawn_thread' || a.type === 'steer_thread');
  const threads = hasRouting ? await listThreads(key) : [];
  for (const action of rawMeta?.actions ?? []) {
    if (action.type === 'spawn_thread') {
      const v = validateSpawnThreadAction(action);
      if (v.ok) routes.push({ kind: 'spawn', title: v.title, prompt: v.prompt });
      else rejections += `\n\n_(thread spawn rejected: ${v.reason})_`;
    } else if (action.type === 'steer_thread') {
      const v = validateSteerThreadAction(action, threads);
      const steerMsg = typeof action.message === 'string' ? action.message.trim() : '';
      if (v.ok) routes.push({ kind: 'steer', thread: v.thread, message: steerMsg, queued: v.queued, mode: v.mode });
      else rejections += `\n\n_(steer rejected: ${v.reason})_`;
    }
  }

  return {
    response: buildWorkerResponse({ ...result, output: deliverable }, workerName) + rejections,
    meta,
    routes,
    session: capturedSession,
    dispatchedWorker: result.success ? workerName : undefined,
    workerError: result.success ? undefined : true,
    rateLimitedWorker: outcome.rateLimitedWorker,
  };
}

// ---------------------------------------------------------------------------
// §4.5 spawn/steer handlers (store write + executor fire + frozen footers)
// ---------------------------------------------------------------------------

/** Best-effort topic-event emission for the spawn/steer routing surface
 *  (callbacks.ts question_answered precedent: a failed audit line never fails
 *  the load-bearing effect). Returns false when the topic key is malformed —
 *  there is no topic-events file to address. */
export async function emitThreadEvent(
  topicKey: string,
  ev: { kind: 'thread_spawned' | 'thread_steered'; ref: string; detail: string }
): Promise<boolean> {
  const parsed = /^(-?\d+)_(\d+)$/.exec(topicKey);
  if (!parsed) return false;
  try {
    await appendTopicEvent(Number(parsed[1]), Number(parsed[2]), ev);
    return true;
  } catch (err) {
    logger.warn('orchestrator', `${ev.kind} event failed: ${(err as Error).message}`, { topicKey, ref: ev.ref });
    return false;
  }
}

export interface HandleSpawnArgs {
  topicKey: string;
  topicName: string;
  spawn: { title: string; prompt: string };
  secrets: Record<string, string>;
  token: string;
  workdir: string;
}

/** Perform the store write; the FIFO claim decides fire-vs-park; RETURN the
 *  frozen footer for main.ts to append to the reply (§4.5 footer table).
 *  Increment 4: no rejections for the cap — an 11th spawn parks as 'queued'
 *  and starts automatically when a slot frees. */
export async function handleSpawn(args: HandleSpawnArgs): Promise<string> {
  const v = validateSpawnThreadAction({ type: 'spawn_thread', title: args.spawn.title, prompt: args.spawn.prompt });
  if (!v.ok) return `\n\n_(thread spawn rejected: ${v.reason})_`;
  const created = await createThread(args.topicKey, { title: v.title, goal: v.prompt, workdir: args.workdir });
  if (!created.ok) return `\n\n_(thread spawn rejected: ${created.reason})_`;
  const ctx = topicCtxFromKey(args.topicKey, args.topicName);
  if (!ctx) {
    logger.warn('orchestrator', 'thread spawned but topic key malformed; it will not execute', {
      topicKey: args.topicKey,
      thread: created.thread.id,
    });
  } else if (created.thread.status === 'running') {
    fireThreadExecution(created.thread, ctx, args.secrets, args.token);
  } else {
    const claimed = await claimThreadStarts(args.topicKey).catch(() => []);
    if (claimed.length > 0) {
      fireClaimedThreads(args.topicKey, claimed, { secrets: args.secrets, token: args.token, topicName: args.topicName });
    }
  }
  await emitThreadEvent(args.topicKey, { kind: 'thread_spawned', ref: created.thread.id, detail: created.thread.title });
  // Footer is selected by the record's state AFTER the claim attempt: a
  // free-slot create fired directly above (spawned footer); a parked create
  // either started just now via the claim (spawned footer) or is genuinely
  // waiting (queued footer).
  const after = (await getThread(args.topicKey, created.thread.id).catch(() => undefined)) ?? created.thread;
  return after.status === 'queued'
    ? `\n\n_(Thread ${created.thread.id} queued — starts when one finishes.)_`
    : `\n\n_(Thread ${created.thread.id} spawned: ${created.thread.title} — its result arrives in this topic when it finishes.)_`;
}

export interface HandleSteerArgs {
  topicKey: string;
  topicName: string;
  steer: { thread: ThreadRecord; message: string; queued: boolean; mode: SteerMode };
  secrets: Record<string, string>;
  token: string;
  workdir: string;
}

/** Fresh store read → validate → queue the input → route by mode and state;
 *  RETURN the frozen footer (§4.5 footer table). Increment 4: INTERRUPT
 *  kills the in-flight run and restarts with the message folded in; a
 *  terminal-thread wake parks as 'queued' and goes through the FIFO claim
 *  like every other start — no direct fire, so the running cap binds every
 *  entry into execution. */
export async function handleSteer(args: HandleSteerArgs): Promise<string> {
  const threads = await listThreads(args.topicKey);
  const v = validateSteerThreadAction(
    { type: 'steer_thread', thread_id: args.steer.thread.id, message: args.steer.message, mode: args.steer.mode },
    threads
  );
  if (!v.ok) return `\n\n_(steer rejected: ${v.reason})_`;
  const queuedResult = await queueThreadInput(args.topicKey, v.thread.id, args.steer.message);
  if (!queuedResult.ok) return `\n\n_(steer rejected: ${queuedResult.reason})_`;
  const ctx = topicCtxFromKey(args.topicKey, args.topicName);

  // INTERRUPT (mode=interrupt, thread running): the fold is durable (queued
  // above); orphan the in-flight run, kill-drop its session (cancel-path
  // semantics: never resume a conversation that died mid-run), signal the
  // dying cascade, kill exactly this thread's process tree, fire the restart.
  // The executor's wake path delivers the fold as the restart's first turn.
  if (v.mode === 'interrupt' && v.thread.status === 'running' && ctx) {
    const seq = await bumpRunSeq(args.topicKey, v.thread.id);
    const fresh = seq === undefined ? undefined : await getThread(args.topicKey, v.thread.id).catch(() => undefined);
    if (seq !== undefined && fresh && fresh.status === 'running') {
      await updateThread(args.topicKey, v.thread.id, { session: undefined }).catch(() => {});
      signalThreadInterrupt(`topic-${args.topicKey}-th${v.thread.n}`, seq);
      await stopThreadWorker(ctx.chatId, ctx.threadId, v.thread.n).catch(() => 0);
      const rec = (await getThread(args.topicKey, v.thread.id).catch(() => undefined)) ?? v.thread;
      fireThreadExecution(rec, ctx, args.secrets, args.token);
      await emitThreadEvent(args.topicKey, { kind: 'thread_steered', ref: v.thread.id, detail: `interrupted: ${v.thread.title.slice(0, 120)}` });
      return `\n\n_(Interrupted thread ${v.thread.id} — restarting with your message.)_`;
    }
    // The run finished on its own between validation and the bump — nothing
    // to kill; fall through and route the message normally.
  }

  // Queue-mode steer to a LIVE run: the input rides pendingInput (unchanged).
  if (v.thread.status === 'running') {
    await emitThreadEvent(args.topicKey, { kind: 'thread_steered', ref: v.thread.id, detail: `queued: ${v.thread.title.slice(0, 120)}` });
    return `\n\n_(Queued for thread ${v.thread.id} — delivered when its current run finishes.)_`;
  }

  // Wake path (terminal or already-queued thread): park terminal records as
  // 'queued' so the claim owns the start, then let the FIFO claim decide.
  const parked = await getThread(args.topicKey, v.thread.id).catch(() => undefined);
  if (parked && (parked.status === 'done' || parked.status === 'failed')) {
    await updateThread(args.topicKey, v.thread.id, { status: 'queued' }).catch(() => {});
  }
  const claimed = ctx ? await claimThreadStarts(args.topicKey).catch(() => []) : [];
  if (claimed.length > 0 && ctx) {
    fireClaimedThreads(args.topicKey, claimed, { secrets: args.secrets, token: args.token, topicName: args.topicName });
  }
  const after = (await getThread(args.topicKey, v.thread.id).catch(() => undefined)) ?? parked;
  if (after && after.status === 'running') {
    await emitThreadEvent(args.topicKey, { kind: 'thread_steered', ref: v.thread.id, detail: `routed: ${v.thread.title.slice(0, 120)}` });
    return `\n\n_(Routed to thread ${v.thread.id} — it is running your message now.)_`;
  }
  await emitThreadEvent(args.topicKey, { kind: 'thread_steered', ref: v.thread.id, detail: `queued: ${v.thread.title.slice(0, 120)}` });
  return `\n\n_(Queued for thread ${v.thread.id} — starts when a thread finishes.)_`;
}

export interface HandleAnchorSteerArgs {
  topicKey: string;
  topicName: string;
  thread: ThreadRecord;
  message: string;
  secrets: Record<string, string>;
  token: string;
  workdir: string;
}

/** Reply-to-FYI direct steer (increment 3): validate the anchor's thread
 *  FRESH, then route through handleSteer so the store write, the executor
 *  fire and the frozen footer stay single-sourced. A rejected anchor returns
 *  the frozen rejection footer ALONE — no lead line may precede a rejection.
 *  Accepted anchors return a lead naming thread id + title, then the footer:
 *  `➡️ Follow-up for thread t-<n> (<title>):` + footer. */
export async function handleAnchorSteerReply(args: HandleAnchorSteerArgs): Promise<string> {
  const threads = await listThreads(args.topicKey);
  const v = validateSteerThreadAction(
    { type: 'steer_thread', thread_id: args.thread.id, message: args.message },
    threads
  );
  if (!v.ok) return `_(steer rejected: ${v.reason})_`;
  const footer = await handleSteer({
    topicKey: args.topicKey,
    topicName: args.topicName,
    steer: { thread: v.thread, message: args.message, queued: v.queued, mode: 'queue' },
    secrets: args.secrets,
    token: args.token,
    workdir: args.workdir,
  });
  return `➡️ Follow-up for thread ${v.thread.id} (${v.thread.title}):${footer}`;
}
