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
  MAX_PENDING_INPUT_PER_THREAD,
  MAX_RUNNING_THREADS_PER_TOPIC,
} from './topic-threads.js';
import { getTopicBrainInfo } from './topic-brains.js';
import { buildTopicDescription } from './context.js';
import {
  executeTopicThread,
  activeThreadExecutions,
  THREAD_RESULT_EXCERPT_CHARS,
  type ThreadTopicContext,
} from './thread-executor.js';
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

/** §4.4 — steer_thread validation against the CURRENT store records (pure). */
export function validateSteerThreadAction(
  a: PAMetaAction,
  threads: ThreadRecord[]
): { ok: true; thread: ThreadRecord; queued: boolean } | { ok: false; reason: string } {
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
  // queued === (status === 'running') — frozen equivalence (§4.4).
  return { ok: true, thread, queued: thread.status === 'running' };
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
- spawn_thread: the thread starts a FRESH CLI conversation and does NOT see this chat. Write its prompt self-contained: the goal, relevant absolute file paths, constraints, and what "done" looks like.
- steer_thread: the message becomes that thread's next turn. If it is mid-run, delivery happens when the current run finishes. The thread keeps its own conversation context, so you can steer a finished thread to continue it.
- When you spawn or steer, your reply says so plainly with the thread id (e.g. "Spawning a thread to sweep the logs (t-3)"), and states that the result will arrive in this topic — that is true here; the system delivers it.
- Consequential work (modifying tracked files, sending email or messages, spending money, destructive operations): do NOT spawn immediately. Describe the plan in one short paragraph and arm confirm_required; when the user confirms, spawn in your next turn.
- Thread status questions: answer from the Execution threads section only. Finished threads' results appear there as excerpts; summarize them, never re-execute them.

## PA_META (optional last line, single-line JSON, nothing after it):
[PA_META]: {"actions":[{"type":"T",...}]}
Types available to you: spawn_thread{title,prompt} | steer_thread{thread_id,message} | confirm_required | question{text,options} | watch_job{description,check,deadline_minutes} | kb_note{domain,note} | run_skill{skill}
- spawn_thread: title <=80 chars; prompt <=4000 chars, self-contained.
- steer_thread: thread_id like "t-3"; message <=4000 chars.
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
export interface OrchestratorTurnResult {
  response: string; // parseMetadata-cleaned, spawn/steer stripped, rejections appended
  meta: PAMeta | null; // spawn/steer REMOVED — downstream applyMetaActions never sees them
  spawn: { title: string; prompt: string } | null; // FIRST validated spawn_thread, else null
  steer: { thread: ThreadRecord; message: string; queued: boolean } | null; // FIRST validated steer_thread
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
    return { response: '', meta: null, spawn: null, steer: null, session: outcome.session, workerError: true };
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
      spawn: null,
      steer: null,
      session: state.session,
      workerError: true,
      suggestedWorker,
    };
  }

  // Strip spawn/steer from the envelope downstream applyMetaActions sees, and
  // validate the FIRST of each; validation failures downgrade to a rejected
  // line appended to the response (§4.5).
  const meta = stripOrchestratorActions(rawMeta);
  let spawn: OrchestratorTurnResult['spawn'] = null;
  let steer: OrchestratorTurnResult['steer'] = null;
  let rejections = '';
  const spawnAction = rawMeta?.actions.find((a) => a.type === 'spawn_thread');
  if (spawnAction) {
    const v = validateSpawnThreadAction(spawnAction);
    if (v.ok) spawn = { title: v.title, prompt: v.prompt };
    else rejections += `\n\n_(thread spawn rejected: ${v.reason})_`;
  }
  const steerAction = rawMeta?.actions.find((a) => a.type === 'steer_thread');
  if (steerAction) {
    const v = validateSteerThreadAction(steerAction, await listThreads(key));
    // The validator's frozen ok-shape carries thread+queued only (§4.4); the
    // trimmed message comes from the action it just validated.
    const steerMsg = typeof steerAction.message === 'string' ? steerAction.message.trim() : '';
    if (v.ok) steer = { thread: v.thread, message: steerMsg, queued: v.queued };
    else rejections += `\n\n_(steer rejected: ${v.reason})_`;
  }

  return {
    response: buildWorkerResponse({ ...result, output: deliverable }, workerName) + rejections,
    meta,
    spawn,
    steer,
    session: capturedSession,
    dispatchedWorker: result.success ? workerName : undefined,
    workerError: result.success ? undefined : true,
    rateLimitedWorker: outcome.rateLimitedWorker,
  };
}

// ---------------------------------------------------------------------------
// §4.5 spawn/steer handlers (store write + executor fire + frozen footers)
// ---------------------------------------------------------------------------

/** ThreadTopicContext from the `<chatId>_<threadId>` store key. chatId may be
 *  NEGATIVE (supergroups: -100...) — split on the LAST underscore only, never
 *  on '-'. */
function topicCtxFromKey(topicKey: string, topicName: string): ThreadTopicContext | undefined {
  const parts = topicKey.split('_');
  const threadId = Number(parts.pop());
  const chatId = Number(parts.join('_'));
  if (!Number.isFinite(chatId) || !Number.isFinite(threadId)) return undefined;
  return { chatId, threadId, topicName };
}

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

/** Fire-and-forget executor start, tracked in activeThreadExecutions (same
 *  add/delete pattern as main.ts's task-lane wiring). */
function fireThreadExecution(
  thread: ThreadRecord,
  ctx: ThreadTopicContext,
  secrets: Record<string, string>,
  token: string,
  workdir: string
): void {
  const exec = executeTopicThread({ thread, topicCtx: ctx, secrets, token, workdir: { dir: workdir } });
  activeThreadExecutions.add(exec);
  void exec.finally(() => activeThreadExecutions.delete(exec));
}

export interface HandleSpawnArgs {
  topicKey: string;
  topicName: string;
  spawn: { title: string; prompt: string };
  secrets: Record<string, string>;
  token: string;
  workdir: string;
}

/** Perform the store write + fire the executor; RETURN the frozen footer for
 *  main.ts to append to the reply (§4.5 footer table). */
export async function handleSpawn(args: HandleSpawnArgs): Promise<string> {
  const v = validateSpawnThreadAction({ type: 'spawn_thread', title: args.spawn.title, prompt: args.spawn.prompt });
  if (!v.ok) return `\n\n_(thread spawn rejected: ${v.reason})_`;
  const created = await createThread(args.topicKey, { title: v.title, goal: v.prompt, workdir: args.workdir });
  if (!created.ok) {
    if (created.reason === `${MAX_RUNNING_THREADS_PER_TOPIC} threads already running`) {
      return `\n\n_(thread spawn rejected: ${MAX_RUNNING_THREADS_PER_TOPIC} threads already running — steer one or wait.)_`;
    }
    return `\n\n_(thread spawn rejected: ${created.reason})_`;
  }
  const ctx = topicCtxFromKey(args.topicKey, args.topicName);
  if (!ctx) {
    logger.warn('orchestrator', 'thread spawned but topic key malformed; it will not execute', {
      topicKey: args.topicKey,
      thread: created.thread.id,
    });
  } else {
    fireThreadExecution(created.thread, ctx, args.secrets, args.token, args.workdir);
  }
  await emitThreadEvent(args.topicKey, { kind: 'thread_spawned', ref: created.thread.id, detail: created.thread.title });
  return `\n\n_(Thread ${created.thread.id} spawned: ${created.thread.title} — its result arrives in this topic when it finishes.)_`;
}

export interface HandleSteerArgs {
  topicKey: string;
  topicName: string;
  steer: { thread: ThreadRecord; message: string; queued: boolean };
  secrets: Record<string, string>;
  token: string;
  workdir: string;
}

/** Fresh store read → validate → queue the input → (idle thread) fire the
 *  executor; RETURN the frozen footer (§4.5 footer table). */
export async function handleSteer(args: HandleSteerArgs): Promise<string> {
  const threads = await listThreads(args.topicKey);
  const v = validateSteerThreadAction(
    { type: 'steer_thread', thread_id: args.steer.thread.id, message: args.steer.message },
    threads
  );
  if (!v.ok) return `\n\n_(steer rejected: ${v.reason})_`;
  const queuedResult = await queueThreadInput(args.topicKey, v.thread.id, args.steer.message);
  if (!queuedResult.ok) return `\n\n_(steer rejected: ${queuedResult.reason})_`;
  if (v.queued) {
    await emitThreadEvent(args.topicKey, {
      kind: 'thread_steered',
      ref: v.thread.id,
      detail: `queued: ${v.thread.title.slice(0, 120)}`,
    });
    return `\n\n_(Queued for thread ${v.thread.id} — delivered when its current run finishes.)_`;
  }
  const ctx = topicCtxFromKey(args.topicKey, args.topicName);
  if (!ctx) {
    logger.warn('orchestrator', 'steer accepted but topic key malformed; it will not execute', {
      topicKey: args.topicKey,
      thread: v.thread.id,
    });
  } else {
    const rec = (await getThread(args.topicKey, v.thread.id)) ?? v.thread;
    fireThreadExecution(rec, ctx, args.secrets, args.token, args.workdir);
  }
  await emitThreadEvent(args.topicKey, {
    kind: 'thread_steered',
    ref: v.thread.id,
    detail: `routed: ${v.thread.title.slice(0, 120)}`,
  });
  return `\n\n_(Routed to thread ${v.thread.id} — it is running your message now.)_`;
}
