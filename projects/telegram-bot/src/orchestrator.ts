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

import { basename } from 'node:path';
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
import { renderTopicPointerLines } from './topic-pointers.js';
import { buildTopicDescription, renderOpenItems, renderSkillRosterSection } from './context.js';
// AI-203 WP-1 (item 6): the orchestrator routes WITHOUT seeing operator-confirmed
// behavioral rules or the topic's queued task list — a correctness gap (it may
// spawn duplicate work or route against a standing rule). activeRulesFor is the
// same fail-to-absent, 12-rule/1500-char-capped helper context.ts's buildPrompt
// uses for the human lane; renderOpenItems is the same shared open-items helper
// (queued tasks + in-flight siblings + notes). Both render '' when empty ⇒ the
// section is omitted (grounding v2: fresh-prompt-only, matching buildPrompt).
import { activeRulesFor } from '../../../pa/dist/src/lib/feedback-rules.js';
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
import { makeRefId } from './ref-id.js';
import { findDuplicateGoal } from './thread-dedup.js';
// The shared dispatch cascade (dispatch.ts) owns the stop probe, session
// validity, resume args, harvest windows and capture; this module keeps only
// the tail's next-worker suggestion.
import { findNextAvailableWorker } from './session-capture.js';
import { runDispatchCascade, type DispatchLane } from './dispatch.js';
// Router-metadata wave (2026-09-20): HandleSpawnArgs.routing's shape — the
// origin turn's provenance, persisted on the thread record for the executor's
// getEnv (type-only re-use of the vocabulary's single producer).
import type { TurnRoutingMeta } from './dispatch.js';
// Single logic.js import direction (no cycle): logic.ts never imports this
// module — it owns ORCHESTRATOR_PATTERN's definition (beside isKnownCommand)
// and this module re-exports it for main.ts's interception import.
import {
  isPrematureAsyncReply,
  parseMetadata,
  buildWorkerResponse,
  buildWorkerErrorResponse,
  sanitizeSpawnDependsOn,
  sanitizeSuggestedItems,
  PA_META_DOWNSTREAM_TYPES,
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

/** Cap decision (2026-09-09 incident, topic 13052): kept at 4000, NOT raised.
 *  `topic-threads.ts`'s `createThread` enforces its own, independent
 *  `goal.length > 4000` check on this same string (topic-threads.ts is a
 *  different owner/file) — raising only this cap would let a >4000-char
 *  prompt clear validateSpawnThreadAction and then still die downstream in
 *  createThread with a confusingly different "goal must be 1..4000 chars"
 *  rejection, which is worse than today (a two-tier cap that silently keeps
 *  rejecting while claiming to have been raised). Instead the per-action loop
 *  in dispatchOrchestratorTurn truncates an oversized prompt to this exact
 *  cap BEFORE validation, so it never hits the length rejection, and appends
 *  an explicit `_(spawn prompt truncated to 4000 chars)_` footer so a
 *  truncated instruction is visible to the operator, never silent. */
export const SPAWN_PROMPT_MAX_CHARS = 4000;

/** §4.4 — spawn_thread shape validation (pure; the running cap is the store's).
 *  AI-203 WP-1 (item 4): an optional `worker` field pins the thread to a specific
 *  worker (claude/zclaude/agy/codex). If present it must be a non-empty string ≤16
 *  chars matching `/^[a-z0-9_-]+$/i`; absent ⇒ undefined (cascade default, unchanged).
 *  The validated `worker` rides the OrchestratorRoute spawn struct into handleSpawn,
 *  which passes it to createThread's init.worker (WP-2 wires it into dispatchOpts).
 *  WP-7 (OD-4): an optional `model` field pins the thread's dispatches to a model
 *  id — grammar `/^[a-zA-Z0-9._-]{1,64}$/` (deliberately wider than worker: model
 *  ids carry dots). Same reject-not-coerce rule; rides the same route struct into
 *  createThread's init.model, then the executor's buildTopicTierExtraArgs. */
export function validateSpawnThreadAction(
  a: PAMetaAction
): { ok: true; title: string; prompt: string; worker?: string; model?: string } | { ok: false; reason: string } {
  const title = typeof a.title === 'string' ? a.title.trim() : '';
  if (title.length < 1 || title.length > 80) return { ok: false, reason: 'title must be 1..80 chars' };
  const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
  if (prompt.length < 1 || prompt.length > SPAWN_PROMPT_MAX_CHARS) {
    return { ok: false, reason: `prompt must be 1..${SPAWN_PROMPT_MAX_CHARS} chars` };
  }
  // Optional per-thread worker pin. A non-string, empty, >16-char, or
  // non-`[a-z0-9_-]` value is rejected (never silently coerced) so a malformed
  // pin degrades to a rejected spawn with a visible reason rather than a
  // thread pinned to a nonexistent worker. Absent ⇒ no `worker` key (cascade).
  let worker: string | undefined;
  if (a.worker !== undefined && a.worker !== null) {
    const w = typeof a.worker === 'string' ? a.worker.trim() : '';
    if (w.length < 1 || w.length > 16) {
      return { ok: false, reason: 'worker must be 1..16 chars when present' };
    }
    if (!/^[a-z0-9_-]+$/i.test(w)) {
      return { ok: false, reason: 'worker must match /^[a-z0-9_-]+$/i when present' };
    }
    worker = w;
  }
  // WP-7: optional per-thread model pin — wider grammar (dots, ≤64) since model
  // ids carry dots; absent ⇒ no `model` key.
  let model: string | undefined;
  if (a.model !== undefined && a.model !== null) {
    const m = typeof a.model === 'string' ? a.model.trim() : '';
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(m)) {
      return { ok: false, reason: 'model must match /^[a-zA-Z0-9._-]{1,64}$/ when present' };
    }
    model = m;
  }
  return { ok: true, title, prompt, ...(worker ? { worker } : {}), ...(model ? { model } : {}) };
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

/** §4.2 — orchestrator mode gate. AI-215 (2026-09-14): default-on with an
 * explicit-false opt-out. A keyless topic state (a brand-new branch, a topic
 * that never had `/orchestrator` on) is an orchestrator; only
 * `orchestrator_enabled === false` (set by `/orchestrator off`) opts out. No
 * state migration is needed — the predicate inversion covers every existing
 * topic in one line. */
export function isOrchestratorMode(state: ConversationState): boolean {
  return state.orchestrator_enabled !== false;
}

/** WP-5 (§3.2/E-list 3, 2026-09-19): under the placement surface a ROUTED
 *  turn is not dispatched through the persona branch — the router owns
 *  orchestration on those turns. The persona prompt/builders STAY untouched
 *  so flag-off reversal is exact (§5). Fail-open turns, pinned turns and
 *  command turns keep today's branch. */
export function personaBranchSkipped(placementSurfaceLive: boolean, routedTurn: boolean): boolean {
  return placementSurfaceLive && routedTurn;
}

/** WP-5 (§3.2/E-list 3): the standing deprecation notice appended to the
 *  /orchestrator reply while the placement surface is live. State writes in
 *  handleOrchestratorCommand are unchanged (flag-off reversal, §5). */
export const ORCHESTRATOR_ROUTER_NOTICE =
  '\n\n_(routing owns placement on routed turns now — this persona stays armed for flag-off)_';

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
      const waitingSuffix = t.dependsOn && t.dependsOn.length > 0 ? `, waiting on ${t.dependsOn.join(', ')}` : '';
      const queuedSuffix = t.pendingInput.length > 0 ? `, +${t.pendingInput.length} queued` : '';
      lines.push(`- ${t.id} — ${t.title} (queued${waitingSuffix}${queuedSuffix})`);
    } else {
      const queuedSuffix = t.pendingInput.length > 0 ? `, +${t.pendingInput.length} queued` : '';
      lines.push(`- ${t.id} — ${t.title} (running${queuedSuffix})`);
    }
  }
  const older = sorted.length - rendered.length;
  if (older > 0) lines.push(`(+${older} older threads omitted)`);
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

  // Topic pointer lines — shared renderer (topic-pointers.ts), orchestrator
  // lane: brain identical to the human lane; recall/decisions speak in
  // spawn-to-run voice because this lane has no tools (AI-203 WP-2 byte-copies
  // retired — the module is the single owner now).
  const pointers = await renderTopicPointerLines(
    { chatId: state.chat_id, threadId: state.thread_id },
    'orchestrator'
  );

  // Names-only sources pointer: this lane has no tools, so it must never see
  // the full ## Topic sources section (executor lanes render it). Names keep
  // the router aware the grounding files exist without paying their bytes.
  const sourceNames = (state.sources ?? [])
    .slice(0, 8)
    .map((s) => s.label?.trim() || basename(s.path));
  const sourcesPointer = sourceNames.length
    ? `\nTopic sources: ${sourceNames.join(', ')}${state.sources!.length > 8 ? ` (+${state.sources!.length - 8} more)` : ''} — declared grounding files; grounded questions on them go to a thread.`
    : '';

  const topicDesc = buildTopicDescription(state, opts?.topicNames);

  // AI-203 WP-1 (item 6): the orchestrator routes WITHOUT seeing operator-confirmed
  // behavioral rules or the topic's queued task list — a correctness gap (it may
  // spawn duplicate work or route against a standing rule). Inject the same two
  // sections context.ts's buildPrompt injects for the human lane, between
  // `## Execution threads` and `## Telegram Metadata`. Both are fail-to-absent
  // (empty ⇒ '' ⇒ section omitted) and additive — no behavior change to existing
  // paths. Grounding v2: fresh-prompt-only (buildOrchestratorResumedPrompt is
  // UNCHANGED, matching buildPrompt vs buildResumedPrompt).
  //
  // renderOpenItems is the shared helper (returns the full
  // `\n## Open items (short-term)\n…\n` block, or '' when empty). The standing
  // rules block is replicated inline from context.ts:382-401 (same 12-rule /
  // 1500-char cap and overflow line) because context.ts keeps it as an
  // unexported local — this module cannot import it, and context.ts is not in
  // WP-1's file ownership so it is not refactored here.
  const openItemsSection = await renderOpenItems(state.chat_id, state.thread_id);
  let standingRulesSection = '';
  try {
    const rules = activeRulesFor({ threadId: state.thread_id });
    if (rules.length > 0) {
      const sectionLines: string[] = [];
      let included = 0;
      for (const rule of rules) {           // recency-first: activeRulesFor orders created_at DESC
        if (included >= 12) break;
        const candidate = [...sectionLines, `- ${rule.text}`];
        const candidateLen = candidate.reduce((n, l) => n + l.length + 1, 0);
        if (candidateLen > 1500) break;
        sectionLines.push(`- ${rule.text}`);
        included++;
      }
      const overflow = rules.length - included;
      standingRulesSection = `\n## Standing rules\nOperator-confirmed behavioral rules from past feedback. Obey them exactly.\n${sectionLines.join('\n')}${overflow > 0 ? `\n(+${overflow} older — pa rules list)` : ''}\n`;
    }
  } catch { /* no section on any failure */ }

  // Live skill roster — this lane's PA_META offers run_skill, so the router
  // must see the names it may invoke. Fail-silent; '' renders nothing.
  const skillRosterSection = await renderSkillRosterSection().catch(() => '');

  return `You are the orchestrator for a Telegram forum topic. You talk with the user and route work; you never execute work yourself.

Today is ${today}. Current time (IST): ${now}.

## Topic
${topicDesc}${pointers.brain}${pointers.recall}${pointers.decisions}${sourcesPointer}

${renderThreadsSection(threads)}${openItemsSection}${standingRulesSection}

## Telegram Metadata
Chat ID: ${state.chat_id}
Thread ID: ${state.thread_id}

## Current Message
${userMessage}

## Your role
- Reply in plain product language: no internal ids (thread ids like t-3, task ids, request ids), no tool or script names, no file paths, no event or field names, no exit codes, no JSON. Telegram and the route queue are backing infrastructure, never named — where something arrived or will arrive, say "this conversation" or "your inbox". Technical detail appears only when the operator explicitly asks for it.
- You have NO tools. You cannot read files, run commands, or browse. Your only outputs are your reply text and an optional [PA_META] envelope.
- Messages prefixed \`[Voice message]\` (or \`[Audio file]\` / \`[Video note]\`) are speech-to-text transcripts, not typed text. They may contain recognition errors, especially for names and numbers — read odd or out-of-context phrasing as likely mishearing, not a literal statement.
- Classify every incoming message:
  - Pure conversation, questions, opinions, planning: answer directly from your own knowledge.
  - Work that needs tools (commands, files, downloads, research on disk): spawn a thread.
  - A follow-up, correction, or new instruction for work already in a thread: steer that thread.
- spawn_thread: the thread starts a FRESH CLI conversation and does NOT see this chat. Write its prompt self-contained: the goal, relevant absolute file paths, constraints, and what "done" looks like. If all threads are busy, the spawn parks and starts automatically when one finishes.
- steer_thread: pick mode per message. "interrupt" kills the thread's current run and restarts it right away with your message folded in — use it when the message redirects, corrects, or invalidates what the thread is doing. "queue" delivers your message as the thread's next turn after the current run finishes — use it when the message adds to or builds on the running work. When both readings fit, pick interrupt (redoing partial work costs less than finishing obsolete work). The thread keeps its own conversation context, so you can steer a finished thread to continue it.
- When you spawn or steer, say so in plain words without citing the thread id (e.g. "Starting a separate thread to sweep the logs — the result will come back here when it finishes"). The system delivers the result into this conversation; the thread id stays internal.
- Consequential work (modifying tracked files, sending email or messages, spending money, destructive operations): do NOT spawn immediately. Describe the plan in one short paragraph and arm confirm_required; when the user confirms, spawn in your next turn.
- Next-actions block: when your reply leaves any step outstanding — including a finding, risk, or incomplete item your own work surfaced that nobody has acted on yet, even if you were not asked to act on it and even if your own task is otherwise done — end it with the literal line NEXT ACTIONS, then one numbered line per outstanding step in execution order, each tagged You or Assistant so the next actor is explicit. Every next step named in the reply appears in the block, and the block contains nothing that is not a real step; an Assistant step must be concretely queued or part of a confirmed plan, never a vague promise. When a write action awaits confirmation, the final numbered item is the existing yes-or-no confirmation sentence and it stays the reply's last line. Omit the block only for a plain answer or a task that finished with nothing left to decide. The block is the last visible text, after any Details heading and before any machine footer line.
- Thread status questions: answer from the Execution threads section only. Finished threads' results appear there as excerpts; summarize them, never re-execute them.
${skillRosterSection}
## PA_META (optional last line, single-line JSON, nothing after it):
[PA_META]: {"actions":[...], "suggested_items":["…","…"]}
Types available to you: spawn_thread{title,prompt,worker?,depends_on?,model?} | steer_thread{thread_id,message,mode} | confirm_required | question{text,options} | watch_job{description,check,deadline_minutes} | kb_note{domain,note} | run_skill{skill}
- spawn_thread: title <=80 chars; prompt <=${SPAWN_PROMPT_MAX_CHARS} chars, self-contained. Copy any file paths, commands, and instructions given to you VERBATIM into the prompt — never retype, "clean up", or paraphrase an absolute path (a rewritten path is a nonexistent path to the spawned thread). Prefer forward slashes when you write a NEW path yourself. An oversized prompt gets truncated, so keep it under the cap rather than relying on that.
- spawn_thread.depends_on: optional ["t-3", ...] — up to 3 ids from the Execution threads section above; unknown ids are ignored. When several requests need the same prerequisite work (a shared subproblem of this message or of the live threads), spawn the shared work once and give each dependent spawn depends_on: [<that thread's id>]; dependents wait automatically and receive its result when it completes.
- spawn_thread.worker: optional, the worker to pin this thread to (claude, zclaude, agy, codex). Omit to let the cascade pick. A pinned thread's session resumes only on the same worker (or its resume-compatible sibling); a failover hop starts fresh.
- spawn_thread.model: optional model id for this thread's dispatches (e.g. a cheaper model for sweep work); invalid values are rejected like worker.
- steer_thread: thread_id like "t-3"; message <=4000 chars; mode "queue"|"interrupt" (optional, default "queue").
- question: you need the user to pick one of up to 4 options (each <=40 chars, text <=500 chars) — the reply renders option buttons.
- suggested_items: optional array of 0..4 short plain-language replies the user could tap as a follow-up instead of typing. Emit it in THIS same [PA_META] envelope as {"suggested_items":["…","…"]} alongside your answer text — never a separate call. Each entry: plain product words only, no code, symbols, paths, or jargon; <=40 chars; a real thing the user might say next, not a label for an action you will take. Omit when the answer leaves nothing natural to follow with (a closed yes/no, a final result).
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
  /** Router-metadata wave (2026-09-20): the turn-level PA_ROUTING_* env bag —
   *  forwarded into CascadeArgs.routingEnv verbatim. */
  routingEnv?: Record<string, string>;
  /** Test seams (task-executor.ts dispatch-seam precedent). */
  execute?: (worker: WorkerConfig, prompt: string, opts: RunOptions) => Promise<CommandResult>;
  failover?: (prompt: string, opts: RunOptions) => Promise<{ worker: string; result: CommandResult }>;
  capture?: (worker: string, result: CommandResult, resource: string) => Promise<SessionInfo | undefined>;
}
/** One validated routing action from an orchestrator turn (increment 4
 *  fan-out: a single reply may carry N spawns + N steers, in envelope
 *  order, so a folded batch routes each sub-message to its right target). */
export type OrchestratorRoute =
  | { kind: 'spawn'; title: string; prompt: string; worker?: string; model?: string; dependsOn?: string[] }
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
    ...(args.routingEnv !== undefined ? { routingEnv: args.routingEnv } : {}),
  });
  if (outcome.kind === 'cancelled') {
    return { response: '', meta: null, routes: [], session: outcome.session, workerError: true };
  }

  const { result, worker: workerName, session: capturedSession } = outcome;
  // Parse choice (§1 row 6): executionMode=false ALWAYS — a confirmed-action
  // turn can still emit spawn_thread, and the AI-202 guard composes for free
  // because it is gated on meta === null. Both dispatch paths converge here.
  const { cleaned, meta: rawMeta, parseError, rawExcerpt, repaired } = parseMetadata(result.output, lane.executionMode);
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
  // AI-234: one more pure pass — sanitize suggested_items (fail-open drops
  // non-plain chips) beside stripOrchestratorActions on the same envelope.
  const meta = stripOrchestratorActions(rawMeta);
  if (meta) {
    const sanitizedItems = sanitizeSuggestedItems(meta.suggested_items);
    meta.suggested_items = sanitizedItems.length > 0 ? sanitizedItems : undefined;
  }
  const routes: OrchestratorRoute[] = [];
  let rejections = '';

  // 2026-09-09 incident (topic 13052): a `[PA_META]:` envelope was present in
  // the worker's output but never parsed into actions — not even after the
  // repair attempt in parseMetadata — and the failure just vanished: no
  // route, no rejection line, no log line anywhere. Fail LOUDLY instead: a
  // footer on the delivered reply, a warn log carrying a fresh ref-id +
  // excerpt (queryable via `pa ref`), and a topic event (closest existing
  // kind: thread_failed — no thread was ever created to fail, so `ref` is
  // the same minted refId rather than a thread id).
  if (result.success && rawMeta === null && parseError) {
    const refId = makeRefId('s');
    logger.warn('orchestrator', 'PA_META envelope present but could not be parsed', {
      refId,
      reason: parseError,
      excerpt: rawExcerpt,
    });
    rejections += `\n\n_(action envelope could not be parsed: ${parseError})_`;
    await emitThreadEvent(key, {
      kind: 'thread_failed',
      ref: refId,
      detail: `envelope parse failed: ${parseError}`,
    });
  } else if (repaired) {
    // Envelope parsed only after the lone-backslash repair — note it rather
    // than silently accepting a worker output JSON.parse originally rejected.
    rejections += `\n\n_(action envelope repaired: escaped stray backslashes)_`;
  }

  const hasRouting = (rawMeta?.actions ?? []).some((a) => a.type === 'spawn_thread' || a.type === 'steer_thread');
  const threads = hasRouting ? await listThreads(key) : [];
  for (const action of rawMeta?.actions ?? []) {
    if (action.type === 'spawn_thread') {
      // Item 4 (2026-09-09 incident): an oversized prompt is truncated to the
      // cap BEFORE validation instead of being silently rejected — the
      // operator sees an explicit truncation footer, never a vanished spawn.
      const rawPrompt = typeof action.prompt === 'string' ? action.prompt.trim() : '';
      const truncated = rawPrompt.length > SPAWN_PROMPT_MAX_CHARS;
      const candidateAction = truncated
        ? { ...action, prompt: rawPrompt.slice(0, SPAWN_PROMPT_MAX_CHARS) }
        : action;
      const v = validateSpawnThreadAction(candidateAction);
      if (v.ok) {
        // Model-requestable deps (2026-09-13): shape-gate the envelope field
        // fail-open (sanitizeSpawnDependsOn) and carry what survived on the
        // route; existence against the store is createThread's check.
        const declaredDeps = sanitizeSpawnDependsOn(candidateAction.depends_on);
        routes.push({ kind: 'spawn', title: v.title, prompt: v.prompt, ...(v.worker ? { worker: v.worker } : {}), ...(v.model ? { model: v.model } : {}), ...(declaredDeps ? { dependsOn: declaredDeps } : {}) });
        if (truncated) rejections += `\n\n_(spawn prompt truncated to ${SPAWN_PROMPT_MAX_CHARS} chars)_`;
      } else {
        logger.warn('orchestrator', 'thread spawn rejected', {
          reason: v.reason,
          title: typeof action.title === 'string' ? action.title.slice(0, 80) : '',
        });
        rejections += `\n\n_(thread spawn rejected: ${v.reason})_`;
      }
    } else if (action.type === 'steer_thread') {
      const v = validateSteerThreadAction(action, threads);
      const steerMsg = typeof action.message === 'string' ? action.message.trim() : '';
      if (v.ok) {
        routes.push({ kind: 'steer', thread: v.thread, message: steerMsg, queued: v.queued, mode: v.mode });
      } else {
        logger.warn('orchestrator', 'thread steer rejected', {
          reason: v.reason,
          threadId: typeof action.thread_id === 'string' ? action.thread_id : '',
        });
        rejections += `\n\n_(steer rejected: ${v.reason})_`;
      }
    } else if (!PA_META_DOWNSTREAM_TYPES.has(action.type)) {
      // Unknown-to-every-handler types used to vanish with no warn, no footer
      // and no log line — a model copied a template placeholder type verbatim,
      // twice. Fail loudly; known downstream types ride through untouched.
      const t = typeof action.type === 'string' ? action.type.slice(0, 40) : '';
      logger.warn('orchestrator', 'unknown PA_META action type', { type: t });
      rejections += `\n\n_(action dropped: unknown type '${t}')_`;
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
 *  there is no topic-events file to address. `thread_failed` (2026-09-09
 *  incident) is the closest existing kind for an envelope that never made it
 *  to a route at all — no thread was created, so `ref` carries the minted
 *  refId from the accompanying warn log instead of a thread id. */
export async function emitThreadEvent(
  topicKey: string,
  ev: { kind: 'thread_spawned' | 'thread_steered' | 'thread_failed'; ref: string; detail: string }
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
  /** Model-declared `depends_on` rides the validated route structurally
   *  (main.ts passes the route object whole); sanitized by logic.ts's
   *  `sanitizeSpawnDependsOn`, intersected with the store by createThread.
   *  AI-203 WP-1 (item 4): `worker` is the optional per-thread worker pin,
   *  validated by validateSpawnThreadAction and forwarded to createThread's
   *  init.worker (WP-2 wires it into dispatchOpts.preferredWorker). WP-7:
   *  `model` is the optional per-thread model pin, same route. */
  spawn: { title: string; prompt: string; worker?: string; model?: string; dependsOn?: string[] };
  secrets: Record<string, string>;
  token: string;
  workdir: string;
  /** Voice-inbox task ids the dispatch is routed from (ask-mirroring stamp;
   *  extractVoiceInboxTaskIds output). Sanitized fail-open by the store. */
  voiceTaskIds?: string[];
  /** Router-metadata wave (2026-09-20, §1.2): the ORIGIN turn's routing
   *  provenance — persisted on the ThreadRecord (ids/enum words only) so the
   *  thread executor stamps PA_ROUTING_* into every dispatch's getEnv. */
  routing?: TurnRoutingMeta;
}

/** Perform the store write; the FIFO claim decides fire-vs-park; RETURN the
 *  frozen footer for main.ts to append to the reply (§4.5 footer table).
 *  Increment 4: no rejections for the cap — an 11th spawn parks as 'queued'
 *  and starts automatically when a slot frees. */
export async function handleSpawn(args: HandleSpawnArgs): Promise<string> {
  const v = validateSpawnThreadAction({
    type: 'spawn_thread',
    title: args.spawn.title,
    prompt: args.spawn.prompt,
    // AI-203 WP-1 (item 4): forward the optional per-thread worker pin so
    // validateSpawnThreadAction re-checks it (a route built by
    // dispatchOrchestratorTurn already passed validation, but handleSpawn is
    // also called directly from main.ts's anchor/voice paths — re-validate
    // always, never trust the caller).
    ...(args.spawn.worker ? { worker: args.spawn.worker } : {}),
    ...(args.spawn.model ? { model: args.spawn.model } : {}),
  });
  if (!v.ok) return `\n\n_(thread spawn rejected: ${v.reason})_`;
  // AI-232 Layer 2: the deterministic, non-LLM default. A near-identical live goal
  // serializes the new thread behind its twin instead of racing it (the AI-230 failure
  // mode). Nothing is dropped and nothing is merged; the footer names the decision.
  const twin = findDuplicateGoal(v.prompt, await listThreads(args.topicKey));
  // Model-requestable deps (2026-09-13): union the declared ids with the
  // auto-dedup twin (twin first — the frozen footer names it); declaring the
  // twin's own id must not duplicate it. createThread's store sanitizer then
  // intersects with real ids at spawn time, so an id that matched nothing
  // degrades to a plain spawn rather than a rejection.
  const declared = args.spawn.dependsOn ?? [];
  const depIds = twin && !declared.includes(twin.id) ? [twin.id, ...declared] : declared;
  const created = await createThread(args.topicKey, {
    title: v.title,
    goal: v.prompt,
    workdir: args.workdir,
    voiceTaskIds: args.voiceTaskIds,
    ...(args.routing ? { routing: args.routing } : {}),
    ...(depIds.length > 0 ? { dependsOn: depIds } : {}),
    // AI-203 WP-1 (item 4): forward the validated worker pin to the store.
    // createThread's init type gains `worker?: string` in WP-2; until then the
    // conditional spread is type-tolerant (a spread is exempt from excess
    // property checks, the same pattern used for dependsOn above), so this
    // compiles against the current init shape and WP-2's alike. WP-2 stores
    // it on the ThreadRecord and wires it into dispatchOpts.preferredWorker.
    ...(v.worker ? { worker: v.worker } : {}),
    ...(v.model ? { model: v.model } : {}),
  });
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
  if (twin) {
    await emitThreadEvent(args.topicKey, {
      kind: 'thread_spawned',
      ref: created.thread.id,
      detail: `queued behind ${twin.id} (${twin.reason} goal match)`,
    });
    return `\n\n_(Thread ${created.thread.id} queued behind ${twin.id} (${twin.reason} goal match) — it starts automatically when ${twin.id} finishes and receives its result. Steer or /stop it if that is wrong.)_`;
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
  //
  // The interrupt signal must name the DYING run's runSeq — the value it
  // captured at its own dispatch start, i.e. the record's runSeq BEFORE our
  // bump. isCancelled is `interruptSignals.get(resource) === capturedRunSeq`
  // (T-SIG1): a signal carrying the post-bump value can never equal the dying
  // run's capture, so the cascade reads not-cancelled and RESPAWNS the killed
  // prompt on the next worker — the exact outcome the signal exists to prevent.
  if (v.mode === 'interrupt' && v.thread.status === 'running' && ctx) {
    // Fresh read, not v.thread.runSeq: a queued drain or a superseding
    // executor could have bumped since validation; the run we are killing is
    // whichever runSeq is current NOW.
    const dyingRunSeq =
      (await getThread(args.topicKey, v.thread.id).catch(() => undefined))?.runSeq ?? v.thread.runSeq;
    const seq = await bumpRunSeq(args.topicKey, v.thread.id);
    const fresh = seq === undefined ? undefined : await getThread(args.topicKey, v.thread.id).catch(() => undefined);
    if (seq !== undefined && fresh && fresh.status === 'running') {
      await updateThread(args.topicKey, v.thread.id, { session: undefined }).catch(() => {});
      signalThreadInterrupt(`topic-${args.topicKey}-th${v.thread.n}`, dyingRunSeq);
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
