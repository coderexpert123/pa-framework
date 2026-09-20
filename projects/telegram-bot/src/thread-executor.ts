/**
 * Orchestrator execution-thread executor (AI-203 WP-4).
 *
 * The fire-and-forget lane that runs one spawned CLI conversation per thread
 * record (`~/.pa/topic-threads/<chatId>_<threadId>.json`, store: topic-threads.ts).
 * Modeled on the task lane's proven patterns (task-executor.ts): fire-and-forget
 * promise tracking, an executor-lifetime activity pump (WP-H: the interval
 * spans spawn/wake entry through the final settle, not just the dispatch
 * await), an ownership gate that discards
 * superseded runs silently, a 2-attempt ladder with the AI-202 premature-reply
 * guard feeding it, and best-effort FYI delivery (no DLQ — a lost FYI loses a
 * notification, not work).
 *
 * Dispatches take a NON-topic blackboard resource (`topic-<key>-th<n>`) — pa's
 * worker-exec takes its lock ON the resource, so reusing the topic resource would
 * serialize thread runs against orchestrator turns. The per-thread identity is
 * also what makes a thread precisely stoppable (AI-216, 2026-09-14): a bare
 * /stop flips every running/queued record AND kills each one's `...-th<n>`
 * resource, signalling the dying run's cascade to abort rather than respawn;
 * the runSeq/status gate then discards any late result silently.
 *
 * Consumed by orchestrator.ts (handleSpawn/handleSteer) and main.ts. Nothing in
 * this file imports main.ts — main.ts is the composition root.
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { formatIST } from '../../../pa/dist/src/ist.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { resolvePythonCommand } from '../../../pa/dist/src/lib/python.js';
import { redactSecrets } from '../../../pa/dist/src/lib/redact.js';
import { appendTopicEvent } from '../../../pa/dist/src/lib/topic-events.js';
import { clearWorkerCooldown } from '../../../pa/dist/src/rate-limits.js';
import { runWithFailover, NO_WORKERS_AVAILABLE_ERROR, getCooldownStatus } from '../../../pa/dist/src/workers.js';
import { blackboard } from '../../../pa/dist/src/blackboard.js';
import { release as releaseThreadReservations } from '../../../pa/dist/src/lib/reservations.js';
import type { CommandResult, RunOptions, WorkerConfig } from '../../../pa/dist/src/types.js';
import { voiceInboxTaskStates, voiceInboxTerminalTaskIds } from '../../../pa/dist/src/lib/voice-inbox-ledger.js';
import type { VoiceInboxTaskState } from '../../../pa/dist/src/lib/voice-inbox-ledger.js';
import {
  returnVoiceTaskForRouting,
  voiceInboxRouteRetryPendingIds,
  type VoiceRouteRetryResult,
} from '../../../pa/dist/src/lib/voice-inbox-route-retry.js';
import {
  bumpRunSeq,
  claimThreadStarts,
  getThread,
  listStoreKeys,
  listThreads,
  queueThreadInput,
  setPendingQuestion,
  takePendingInput,
  updateThread,
  touchThread,
  wakeWallParked,
  THREAD_ACTIVITY_THROTTLE_MS,
  type ThreadRecord,
} from './topic-threads.js';
import { ORPHAN_HARVEST_WINDOW_MS, TASK_RULES } from './task-executor.js';
import { captureSessionForResult } from './session-capture.js';
import { buildResumeArgs, isSessionValid } from './session.js';
import { isPrematureAsyncReply, normalizeMarkdown, parseMetadata, sanitizeSuggestedItems } from './logic.js';
import { appendRefIdAndLog, type RefKind } from './ref-id.js';
import { sendMessageWithId, type InlineKeyboardMarkup } from './telegram.js';
import { loadTopicState, saveTopicState, addTurn } from './conversation.js';
import { renderTopicSourcesSection } from './sources.js';
import type { ConversationState, ConversationTurn } from './types.js';
import { capPromptForWidget, mirrorAskAsWidget, voiceInboxScriptPath, type AskMirrorInput, type AskMirrorResult, type MirrorDeps, type MirrorSpawnFn } from './voice-input-mirror.js';
import { renderTopicPointerLines, renderReservationsBlock } from './topic-pointers.js';
import { buildTopicTierExtraArgs, buildWorkerProvenanceEnv, buildRoutingProvenanceEnv } from './dispatch.js';
import { addWatchJob, type WatchInput } from '../../../pa/dist/src/lib/watch-jobs.js';

/** Best-effort FYI sender — `(text, refKind, replyMarkup?)` pinned to one
 *  thread's topic. The optional `replyMarkup` carries an inline keyboard
 *  (AI-203 WP-2: the non-voice thread question's `rq:` option buttons). */
export type ThreadFyiSender = (text: string, kind: RefKind, replyMarkup?: InlineKeyboardMarkup) => Promise<number | null>;

/**
 * AI-203 WP-2 (item 2): the inline keyboard for a non-voice thread question.
 * One button per option, `callback_data: rq:<threadN>:<idx>` — the `rq:` prefix
 * is WP-3's callback grammar (pa/src/lib/callback-grammar.ts); the `<threadN>`
 * is the record's numeric `n` (WP-3's handler converts `t-<n>` → threadId and
 * calls `takePendingQuestion`). ≤64 bytes by construction (same pattern as
 * `buildTaskQuestionKeyboard`). Built inline here per SPEC §5.1.5/§6: WP-3
 * exports the same builder from `callbacks.ts` for any future non-executor use,
 * but no cross-WP import is needed during the build.
 */
export function buildThreadQuestionKeyboard(threadN: number, options: string[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: options.map((optionText, idx) => [{ text: optionText, callback_data: `rq:${threadN}:${idx}` }]),
  };
}

/** AI-234 (SPEC §5): the inline keyboard for quick-reply chips on a thread done
 *  FYI — one button per row, label = chip text verbatim, callback_data `sr:<idx>`.
 *  Built inline here per the buildThreadQuestionKeyboard precedent (SPEC §6: no
 *  cross-WP import needed during the build; callbacks.ts exports the same builder). */
export function buildSuggestKeyboardInline(items: string[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: items.map((label, idx) => [{ text: label, callback_data: `sr:${idx}` }]),
  };
}

/** Test seams for `archiveThreadResult`: inject the blackboard lock and the
 *  conversation reads/writes. Production wires the real pa/dist modules;
 *  tests inject recorders/mocks (also exposed via `ExecuteTopicThreadArgs`
 *  for integration tests that drive the full executor lifecycle). */
export interface ArchiveThreadSeams {
  bbAcquire?: (resource: string, agent: string, pid: number, timeoutMs: number, contextId: string) => Promise<boolean>;
  bbRelease?: (resource: string, agent: string, contextId: string) => Promise<void>;
  loadState?: (chatId: number, threadId: number) => Promise<ConversationState>;
  saveState?: (state: ConversationState) => Promise<void>;
}

/** Archive a terminal thread's result into the topic's `state.turns` under the
 *  topic blackboard lock. Best-effort: a lock-acquire failure or save error is
 *  logged and swallowed — the result is already in the thread store + Telegram
 *  FYI; this is the secondary persistence layer (makes it searchable via
 *  `pa recall` and puts it in the rolling 20-turn window).
 *
 *  Acquires the SAME `topic-<chatId>_<threadId>` resource the orchestrator turn
 *  uses, with a distinct `'thread-executor'` agent name + unique contextId, so
 *  it blocks until the orchestrator releases — no lost update, no deadlock
 *  (the executor holds no resource the orchestrator wants at archive time).
 *
 *  Test seams: `bbAcquire` / `bbRelease` inject the blackboard lock; `loadState`
 *  / `saveState` inject the conversation reads/writes. Production wires the
 *  real pa/dist modules. */
export async function archiveThreadResult(
  chatId: number,
  threadId: number,
  turn: ConversationTurn,
  seams?: ArchiveThreadSeams
): Promise<void> {
  const resourceId = `topic-${chatId}_${threadId}`;
  const contextId = `thread-archive-${randomUUID()}`;
  const acquired = await (seams?.bbAcquire ?? blackboard.acquireLock)(
    resourceId, THREAD_ARCHIVE_LOCK_AGENT, process.pid, THREAD_ARCHIVE_LOCK_TIMEOUT_MS, contextId
  );
  if (!acquired) {
    logger.warn('thread-executor', 'could not acquire topic lock for archiving; result stays in thread store', { chatId, threadId });
    return;
  }
  try {
    const state = await (seams?.loadState ?? loadTopicState)(chatId, threadId);
    addTurn(state, turn);
    await (seams?.saveState ?? saveTopicState)(state);
  } catch (err) {
    logger.warn('thread-executor', `archive save failed (non-fatal): ${(err as Error).message}`, { chatId, threadId });
  } finally {
    await (seams?.bbRelease ?? blackboard.releaseLock)(resourceId, THREAD_ARCHIVE_LOCK_AGENT, contextId).catch(() => {});
  }
}

/** Test seam — default is the real runWithFailover cascade. The opts object is
 *  the exact RunOptions the executor built, so tests observe the resume args
 *  (`extraArgs`) and the prompt in one place. */
export type ThreadDispatchFn = (
  prompt: string,
  opts: RunOptions
) => Promise<{ worker: string; result: CommandResult }>;

/** Ask-mirroring seam (button parity): default is the real voice-inbox widget
 *  creator; tests inject a recorder. */
export type AskMirrorFn = (input: AskMirrorInput) => Promise<AskMirrorResult>;

/** Voice-ledger seams (2026-09-13): one voice task per call, best-effort, never
 *  throws. Both mirror the AskMirrorFn shape so tests inject a recorder the
 *  same way. */
export interface VoiceLedgerResult {
  ok: boolean;
  taskId: string;
  error?: string;
}
/** Terminal-failure surfacing: mark the task failed in the ledger. */
export type VoiceFailFn = (taskId: string, reason: string) => Promise<VoiceLedgerResult>;
/** Success-path closure: complete the task in the ledger. */
export type VoiceCompleteFn = (taskId: string, summary: string) => Promise<VoiceLedgerResult>;
/** Routing retry (2026-09-16): return one never-routed carried task for
 *  routing to the settling thread's topic, once; a `returned` result carries
 *  the retry turn's message. Never throws (pa's returnVoiceTaskForRouting). */
export type VoiceRouteRetryFn = (taskId: string, topicKey: string) => Promise<VoiceRouteRetryResult>;
export type { VoiceRouteRetryResult };
const defaultRetryVoiceRouting: VoiceRouteRetryFn = (taskId, topicKey) => returnVoiceTaskForRouting(taskId, topicKey);

/** Routing retry (2026-09-16): the reconcile sweep only revives a record that
 *  settled within this window. Past it the pa fallback's placement (≈20-25
 *  min) has acted, and resuming a long-idle routing session is wrong. */
export const THREAD_ROUTE_RETRY_SWEEP_MAX_AGE_MS = 60 * 60_000;

/** Grace before the late voice-task sweep may close a settled thread's
 *  still-open voice tasks (2026-09-13 race fix): the worker's own
 *  task_complete call is the richer closure (it also passes --short), so
 *  the sweep waits this long past the thread's settle
 *  time — the done record's `updatedAt`, which the done write is the last
 *  thing to bump — before closing. Auto-closure is the fallback, not the
 *  preemptor. */
export const THREAD_VOICE_CLOSE_GRACE_MS = 180_000;

/**
 * The honest closure the late sweep writes when a thread settled `done` with
 * NO usable reply text (routed-ask loopback wave, 2026-09-14): without it the
 * carried task hangs open forever — the exact "delivery receipt instead of an
 * answer" class the loopback invariant forbids, just quieter. Plain-language
 * per the answer register, and shaped to pass task_complete.py's guards
 * (never starts "Routed"/"Done.", no command-output markers, no request
 * re-paste, no duplicate-close phrasing).
 */
export const THREAD_VOICE_EMPTY_RESULT_NOTE =
  'This request came back without an answer — the work finished empty, and no answer was recorded. Ask again to retry it.';

/**
 * The honest closure the late sweep writes when a thread settled `done` with
 * a reply that task_complete.py's summary guards REFUSE (2026-09-15, ai246
 * WP-E): every parser.error path exits 2 — the receipt-shape refusal
 * (Command output / exit 0 / {"ok" markers), the NEXT-ACTIONS-without---next
 * refusal, the request-repaste refusal — so a verbatim `lastResult` carrying
 * one of those loops the sweep forever: vi-7cc698aca65a and vi-5255fad01127
 * (routing receipts as results) warned every reconcile for ~40 minutes
 * without ever closing. The sweep retries once with this note, which is
 * shaped to pass every guard (no receipt markers or prefixes, no NEXT
 * ACTIONS line, not a request re-paste, no duplicate-close phrasing).
 */
export const THREAD_VOICE_REFUSED_RESULT_NOTE =
  'This request was handled, but the reply it left behind was a process receipt rather than a plain-language answer, so no real answer was recorded. Ask again to retry it.';

/** task_complete.py validation refusals (parser.error / argparse) exit 2 —
 *  surfaced by runVoiceLedgerScript as `<script> exited 2: usage: …`. Distinct
 *  from the JSON-emitting fail() refusals (task not found, illegal transition)
 *  which exit 1 and never carry this signature. */
const VOICE_COMPLETE_REFUSED_RE = /\bexited 2\b/;

/** Marker error a routed-refusal defer returns from closeOne (2026-09-15): a
 *  deliberate defer must never ride back to the caller's failure loop as the
 *  refusal's own error text — that text matches neither already-closed
 *  signature and would be mislogged as a reach failure. */
const VOICE_CLOSE_DEFERRED_ROUTED = 'deferred: task still routed elsewhere';

/** One-JSON-line scan (the mirror module's emit-contract parser is private to
 *  it; this is the local twin). */
function firstJsonObject(text: string): Record<string, unknown> | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Not JSON — keep scanning; the emit contract is one JSON line.
    }
  }
  return undefined;
}

/** Repo-rooted path to one of the voice-inbox worker scripts — a sibling of
 *  the mirror module's probed task_input.py (they all ship in the same
 *  directory). */
function voiceInboxWorkerScriptPath(fileName: string): string | undefined {
  const askScript = voiceInboxScriptPath();
  if (!askScript) return undefined;
  const script = join(dirname(askScript), fileName);
  return existsSync(script) ? script : undefined;
}

/** Shared spawn runner for the voice-ledger worker verbs — the mirror module's
 *  runTaskInput shape: collect stdout (8 KiB cap) + stderr, resolve on
 *  close/error or the 5 s timeout (kill + `timeout`), NEVER throw. The
 *  scripts' fail() prints their JSON error on stdout and exits 1, so the close
 *  handler prefers the parsed error text over the bare exit-code shape — that
 *  keeps the `task …` rejection classification reachable in production. */
async function runVoiceLedgerScript(
  scriptArgs: string[],
  deps: MirrorDeps | undefined,
  scriptLabel: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cmd = deps?.pythonCmd ?? resolvePythonCommand(process.env);
  const timeoutMs = deps?.timeoutMs ?? 5_000;
  const spawnFn: MirrorSpawnFn = deps?.spawnFn ?? ((command, cArgs, options) => spawn(command, cArgs, options));
  return new Promise((resolve) => {
    let child: ReturnType<MirrorSpawnFn>;
    try {
      child = spawnFn(cmd, scriptArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (err) {
      resolve({ ok: false, error: (err as Error).message });
      return;
    }
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (result: { ok: true } | { ok: false; error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best-effort kill; the timeout result stands either way.
      }
      finish({ ok: false, error: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (settled || stdout.length >= 8 * 1024) return;
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (stdout.length > 8 * 1024) stdout = stdout.slice(0, 8 * 1024);
    });
    child.stderr.on('data', (chunk) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.on('error', (err) => {
      finish({ ok: false, error: (err as Error).message });
    });
    child.on('close', (code) => {
      const parsed = firstJsonObject(stdout);
      if (parsed && typeof parsed.error === 'string') {
        finish({ ok: false, error: parsed.error });
        return;
      }
      if (parsed && parsed.ok === true) {
        finish({ ok: true });
        return;
      }
      if (code !== 0) {
        const tail = stderr.trim().slice(0, 200);
        finish({ ok: false, error: `${scriptLabel} exited ${code ?? 'null'}${tail ? `: ${tail}` : ''}` });
        return;
      }
      finish({ ok: false, error: `unparseable ${scriptLabel} output` });
    });
  });
}

/** Default VoiceFailFn: `task_telemetry.py --event task.failed --task <id>
 *  --reason <reason>` — the ledger's sanctioned worker-side failure verb. It
 *  writes the task.failed event the app renders (payload.reason) AND moves the
 *  task to `failed` through the mirrored transition table. Best-effort by
 *  contract: resolves `{ ok: false, error }` on every failure, never throws. */
export async function failVoiceTaskInLedger(taskId: string, reason: string, deps?: MirrorDeps): Promise<VoiceLedgerResult> {
  try {
    if (!taskId) return { ok: false, taskId, error: 'no voice task id' };
    const script = deps?.scriptPath ?? voiceInboxWorkerScriptPath('task_telemetry.py');
    if (!script) return { ok: false, taskId, error: 'task_telemetry.py not found' };
    const run = await runVoiceLedgerScript([script, '--event', 'task.failed', '--task', taskId, '--reason', reason], deps, 'task_telemetry.py');
    if (!run.ok) return { ok: false, taskId, error: run.error };
    return { ok: true, taskId };
  } catch (err) {
    return { ok: false, taskId, error: (err as Error).message };
  }
}

/** Default VoiceCompleteFn: `task_complete.py --task <id> --summary <summary>`
 *  — the ledger's sanctioned completion verb (fills result_summary, moves the
 *  task to `done` from any non-terminal state, and sweeps the conversation's
 *  still-pending asks). Best-effort by contract, never throws. */
export async function completeVoiceTaskInLedger(taskId: string, summary: string, deps?: MirrorDeps): Promise<VoiceLedgerResult> {
  try {
    if (!taskId) return { ok: false, taskId, error: 'no voice task id' };
    const script = deps?.scriptPath ?? voiceInboxWorkerScriptPath('task_complete.py');
    if (!script) return { ok: false, taskId, error: 'task_complete.py not found' };
    const run = await runVoiceLedgerScript([script, '--task', taskId, '--summary', summary], deps, 'task_complete.py');
    if (!run.ok) return { ok: false, taskId, error: run.error };
    return { ok: true, taskId };
  } catch (err) {
    return { ok: false, taskId, error: (err as Error).message };
  }
}

export interface ExecuteTopicThreadArgs {
  thread: ThreadRecord;
  topicCtx: { chatId: number; threadId: number; topicName: string };
  secrets: Record<string, string>;
  token: string;
  /** Test seam — default is the real Telegram send with the ref-id footer. */
  sendFyi?: ThreadFyiSender;
  /** Test seam — default is the real runWithFailover cascade. */
  dispatch?: ThreadDispatchFn;
  /** Test seam — default is the real voice-inbox ask mirror. */
  mirrorAsk?: AskMirrorFn;
  /** Test seam — default is the real voice-inbox ledger failure mark
   *  (failVoiceTaskInLedger). */
  failVoiceTask?: VoiceFailFn;
  /** Test seam — default is the real pa routing retry
   *  (returnVoiceTaskForRouting). */
  retryVoiceRouting?: VoiceRouteRetryFn;
  /** Test seam — default is the real blackboard lock + conversation
   *  load/save for `archiveThreadResult`. Tests inject recorders/mocks to
   *  observe archive behavior without touching the real blackboard. */
  archiveSeams?: ArchiveThreadSeams;
}

/** Executor-owned constants (AI-203 spec §4.1; store-side constants live in
 *  topic-threads.ts). */
// per-chain chunk bound — an over-cap backlog parks the record as 'queued'; the next wake restarts a fresh chain, so spend stays proportional to queued input
export const MAX_AUTO_RESUMES_PER_CHAIN = 5;
export const THREAD_RESPONSE_CAP_CHARS = 3_500;
export const THREAD_RESULT_EXCERPT_CHARS = 400;
export const TOPIC_THREAD_MAX_ATTEMPTS = 2;

/** AI-203 turns archiving: cap on the result portion of the archived turn text.
 *  The `✅ Thread t-<n> done: <title>\n\n` header is prepended AFTER the slice,
 *  so `pa recall` sees the full 1000-char excerpt while the rolling 20-turn /
 *  8000-char window keeps a ~12% budget footprint. The full uncapped result
 *  remains in the thread store (`lastResult`) and the Telegram FYI (capped at
 *  THREAD_RESPONSE_CAP_CHARS). */
export const THREAD_ARCHIVE_TEXT_CHARS = 1000;
/** Topic-lock acquire timeout for archiving (same 60 s as main.ts's dispatch
 *  lock). Best-effort: a timeout skips the archive (the result stays in the
 *  thread store + Telegram FYI). */
const THREAD_ARCHIVE_LOCK_TIMEOUT_MS = 60_000;
/** Blackboard agent name for the archive's lock acquisition — distinct from
 *  the orchestrator's `'telegram-bot'` so the two never collide on the same
 *  resource identity. */
const THREAD_ARCHIVE_LOCK_AGENT = 'thread-executor';

/** Wall-park (2026-09-12) backoff ladder, MINUTES, indexed by parks-so-far
 *  BEFORE the current park: 0→5, 1→15, 2→30, 3+→60 (cap). Availability is not a
 *  goal failure: a park never increments `attempts`. */
export const THREAD_PARK_LADDER_MINUTES: readonly number[] = [5, 15, 30, 60];
/** Wall-park terminal valve: once this many availability parks have accumulated
 *  in the episode, the NEXT wall outcome falls through to the normal failed path
 *  (≈ 3h50m of backoff at the 60-min cap before giving up; operator directive
 *  2026-09-13: surface sooner — lowered from 24, ≈ a day). */
export const THREAD_PARK_VALVE = 6;

/** Resume-compatible worker pairs (2026-09-12): claude and zclaude share one
 *  session store and one resume format (verified live by probe, 2026-09-12), so
 *  a captured session may hand its `--resume` args to its sibling worker;
 *  agy/codex stay strictly own-worker (their flags are foreign to every other
 *  CLI — the 2026-09-11 static-extraArgs exhaustion incident). */
export const RESUME_COMPATIBLE: Record<string, string> = { claude: 'zclaude', zclaude: 'claude' };

/** Topic context for one thread (mirrors the task lane's context shape; kept
 *  local rather than imported so the two lanes stay decoupled). `pointers`/
 *  `sources`/`reservations` are the precomputed dynamic sections from
 *  buildThreadDynamicSections — absent ⇒ byte-identical frozen skeleton. */
export interface ThreadTopicContext {
  chatId: number;
  threadId: number;
  topicName: string;
  pointers?: string;
  sources?: string;
  reservations?: string;
}

/**
 * The thread prompt (AI-203 spec §4.6 frozen skeleton). `TASK_RULES` is imported
 * verbatim from task-executor.ts, never restated.
 */
export function buildThreadPrompt(thread: ThreadRecord, ctx: ThreadTopicContext, upstream?: string): string {
  const nowIst = formatIST(new Date());
  const today = nowIst.slice(0, 10);
  const clock = nowIst.slice(11, 16);
  // AI-232: the upstream-results section (when present) sits between the task
  // block and ## Rules, separated by one blank line on each side. Empty/absent
  // upstream must produce a byte-identical skeleton to before this change.
  const upstreamSection = upstream ? `\n\n${upstream}` : '';
  // Dynamic per-topic sections (topic-pointers.ts: brain/recall/decisions
  // pointers + sources.ts ## Topic sources + ## Live reservations) sit between
  // the task block and ## Rules — executor lanes must see the same
  // coordination/retrieval hints the human lane gets. Absent fields render
  // nothing (byte-identical skeleton).
  const insertSection = [ctx.pointers, ctx.sources, ctx.reservations]
    .filter(Boolean).length
    ? `\n\n${[ctx.pointers, ctx.sources, ctx.reservations].filter(Boolean).join('\n\n')}`
    : '';
  return `You are executing a spawned thread for topic "${ctx.topicName}" (${ctx.chatId}_${ctx.threadId}).
Today is ${today}. Current time (IST): ${clock}.
Thread: ${thread.id} — ${thread.title}
Attempt ${thread.attempts + 1}/${TOPIC_THREAD_MAX_ATTEMPTS}. This conversation is your own; later messages in this thread resume it.

## Your task
${thread.goal}${upstreamSection}${insertSection}

## Rules
${TASK_RULES}`;
}

/**
 * Thread resumed turns: the `## Context Update` shape (byte-same as
 * context.ts's buildResumedPrompt body) with a one-line header
 * `## Thread <id> — <title>` and the queued input(s) as `## Current Message`
 * (joined `\n\n` when several drain together).
 */
export function buildThreadResumedTurnPrompt(thread: ThreadRecord, drainedInput: string): string {
  const nowIst = formatIST(new Date());
  const today = nowIst.slice(0, 10);
  const clock = nowIst.slice(11, 16);
  return `## Context Update
Today is ${today}. Current time (IST): ${clock}.

## Thread ${thread.id} — ${thread.title}

## Current Message
${drainedInput}`;
}

/**
 * Session-expired/invalid fallback for a resumed turn: fresh `buildThreadPrompt`
 * on `goal` + a `## Prior result` line carrying the ≤400-char `lastResult`
 * excerpt, then the drained input(s) as `## Current Message` (the message the
 * turn exists to deliver — without it the steer would be silently dropped).
 */
export function buildThreadFreshFallbackPrompt(
  thread: ThreadRecord,
  ctx: ThreadTopicContext,
  drainedInput: string,
  upstream?: string
): string {
  const prior = thread.lastResult
    ? `\n\n## Prior result\n${thread.lastResult.slice(0, THREAD_RESULT_EXCERPT_CHARS)}`
    : '';
  return `${buildThreadPrompt(thread, ctx, upstream)}${prior}\n\n## Current Message\n${drainedInput}`;
}

/** AI-232: the dependency handoff. One line per dependency, in `dependsOn` order,
 *  each `lastResult` clamped to THREAD_RESULT_EXCERPT_CHARS. '' when there is
 *  nothing to say, which renders no section at all. Pure. */
export function renderUpstreamResults(
  deps: Array<{ id: string; title: string; status: ThreadRecord['status']; lastResult?: string }>
): string {
  if (deps.length === 0) return '';
  const lines = deps.map((d) => {
    const result = d.lastResult ? d.lastResult.slice(0, THREAD_RESULT_EXCERPT_CHARS) : '(no result recorded)';
    return `${d.id} — ${d.title} (${d.status}): ${result}`;
  });
  return `## Upstream results\n${lines.join('\n')}`;
}

/** In-flight executor promises (the drain fires executeTopicThread NOT awaited;
 *  this Set keeps them referenced and gives tests/WP-5 a drain point). */
export const activeThreadExecutions = new Set<Promise<unknown>>();

/** Executors in flight per record (`<key>/<id>` → count): in-process truth
 *  for the reconcile sweep's routing retry (2026-09-16) — a `done` record whose
 *  executor is still running its post-settle steps must not be woken a second
 *  time. A restart empties it, which is correct: no executor survives one. */
const inFlightThreadExecutions = new Map<string, number>();
function isThreadExecutionInFlight(key: string, id: string): boolean {
  return (inFlightThreadExecutions.get(`${key}/${id}`) ?? 0) > 0;
}

/** Test seam (injectable-timer pattern, `_setActivityPumpIntervalForTest`
 *  precedent from the task lane): the activity pump's interval period.
 *  Production never calls this. */
let activityPumpIntervalMs = THREAD_ACTIVITY_THROTTLE_MS;
export function _setActivityPumpIntervalForTest(ms: number): void {
  activityPumpIntervalMs = ms;
}

/** WP-H: the consecutive pump-tick failures that trip ONE warn (real logger,
 *  no alert, no record state). Any successful tick resets the counter. */
const THREAD_PUMP_FAILURE_WARN_AT = 5;

/** Test seam (WP-H): the pump tick's touch target — default is the REAL
 *  touchThread. The real store cannot produce a deterministic cross-platform
 *  touch failure (load() is fail-to-empty and shields the tick chain), so
 *  tests inject one. Production never calls the setter. */
let pumpTouchFn: (key: string, id: string) => Promise<void> = touchThread;
export function _setPumpTouchFnForTest(fn: (key: string, id: string) => Promise<void>): void {
  pumpTouchFn = fn;
}

/** Test drain point: resolves once every in-flight execution has settled. */
export async function _waitForThreadExecutionsForTest(): Promise<void> {
  while (activeThreadExecutions.size > 0) {
    await Promise.allSettled([...activeThreadExecutions]);
  }
}

/** ThreadTopicContext from the `<chatId>_<threadId>` store key. chatId may be
 *  NEGATIVE (supergroups: -100...) — split on the LAST underscore only, never
 *  on '-'. */
export function topicCtxFromKey(topicKey: string, topicName: string): ThreadTopicContext | undefined {
  const parts = topicKey.split('_');
  const threadId = Number(parts.pop());
  const chatId = Number(parts.join('_'));
  if (!Number.isFinite(chatId) || !Number.isFinite(threadId)) return undefined;
  return { chatId, threadId, topicName };
}

/** Fresh/fallback dispatches get the dynamic per-topic sections (pointer lines
 *  + topic sources + live reservations) once per dispatch — resumed turns get none (they are
 *  `## Context Update` continuations, not fresh prompts). Renderers are
 *  fail-silent already; the outer catch is belt-and-braces — a pointer must
 *  never break a dispatch. */
async function buildThreadDynamicSections(
  chatId: number,
  threadId: number,
  state: ConversationState | null
): Promise<Pick<ThreadTopicContext, 'pointers' | 'sources' | 'reservations'>> {
  try {
    const [p, reservations] = await Promise.all([
      renderTopicPointerLines({ chatId, threadId }, 'thread'),
      renderReservationsBlock(),
    ]);
    const sources = state
      ? await renderTopicSourcesSection(state).catch(() => '')
      : '';
    const pointers = [p.brain, p.recall, p.decisions]
      .filter(Boolean)
      .join('\n')
      .replace(/^\n/, '');
    return {
      ...(pointers ? { pointers } : {}),
      ...(sources ? { sources: sources.replace(/^\n+/, '').replace(/\n+$/, '') } : {}),
      ...(reservations ? { reservations: reservations.replace(/^\n/, '') } : {}),
    };
  } catch {
    return {};
  }
}

/** Fire-and-forget executor start for ONE record, tracked in
 *  activeThreadExecutions (moved from orchestrator.ts, increment 4 — the
 *  claim-based wake needs it from three callers). */
export function fireThreadExecution(
  thread: ThreadRecord,
  ctx: ThreadTopicContext,
  secrets: Record<string, string>,
  token: string
): void {
  // workdir rides the RECORD (executeTopicThread reads rec.workdir for cwd).
  const exec = executeTopicThread({ thread, topicCtx: ctx, secrets, token });
  activeThreadExecutions.add(exec);
  void exec.finally(() => activeThreadExecutions.delete(exec));
}

/** Fire every claimed record of one topic (claimThreadStarts callers). The
 *  key is parsed with the LAST-underscore rule (chatId may be negative).
 *  topicName may be '' (unresolvable) — the prompt header tolerates it. */
export function fireClaimedThreads(
  topicKey: string,
  claimed: ThreadRecord[],
  deps: { secrets: Record<string, string>; token: string; topicName: string }
): void {
  const ctx = topicCtxFromKey(topicKey, deps.topicName);
  if (!ctx) {
    logger.warn('thread-executor', 'claimed threads but topic key malformed; they will not execute', { topicKey, count: claimed.length });
    return;
  }
  for (const rec of claimed) fireThreadExecution(rec, ctx, deps.secrets, deps.token);
}

function threadKey(chatId: number, threadId: number): string {
  return `${chatId}_${threadId}`;
}

/**
 * Resource-keyed interrupt signals (increment 4): resource → the runSeq that
 * was current when the interrupt fired. The killed run's own dispatch closure
 * ORs this into isCancelled so its cascade ABORTS instead of respawning the
 * next worker on a dead prompt (pa/src/workers.ts polls per candidate and
 * after a failed attempt). The value-scoped comparison means a LATER run on
 * the same resource — a new capturedRunSeq — is never cancelled by a stale
 * signal; the entry is deleted lazily when a newer run captures ownership.
 * In-process only: the kill is the durable act, the signal only steers the
 * dying cascade.
 */
const interruptSignals = new Map<string, number>();
export function signalThreadInterrupt(resource: string, runSeq: number): void {
  interruptSignals.set(resource, runSeq);
  _interruptHook?.(resource, runSeq);
}

/** Test seam: observe signals AT CALL TIME. A post-hoc peek at the map races
 *  the restart's capture (a newer runSeq deletes the entry lazily), so the
 *  only deterministic observation point is inside the call itself. */
let _interruptHook: ((resource: string, runSeq: number) => void) | undefined;
export function _setThreadInterruptHookForTest(
  fn: ((resource: string, runSeq: number) => void) | undefined
): void {
  _interruptHook = fn;
}

/** Test hook: clear all interrupt signals (the map is module-level and keyed
 *  by the tests' shared fixture resource; without a reset one test's signal
 *  cancels the next test's first run). */
export function _resetThreadInterruptsForTest(): void {
  interruptSignals.clear();
}

// Pending inputs are taken atomically via the store's takePendingInput (see the
// increment-1 SPEC's execution-notes tail).

/**
 * Execute one thread end-to-end (AI-203 spec §2.2 lifecycle). Fire-and-forget —
 * callers track the returned promise in activeThreadExecutions and never await
 * it on the dispatch path.
 *
 * WP-H (t-3, 2026-09-13): this function is a thin wrapper owning the
 * EXECUTOR-LIFETIME activity pump — the interval runs from spawn/wake entry to
 * the final settle, and the try/finally clears it on EVERY terminal path
 * (return or throw). The per-dispatch pump could go heartbeat-silent across
 * the post-dispatch awaits (session capture, store writes, FYI sends): a live
 * executor once sat ~50 min silent that way and was stale-demoted. The
 * lifecycle body below re-derives its own locals and never manages the
 * interval; the dispatch's isCancelled reads the executor-scoped `mirror`
 * status ref, re-seeded per iteration from the freshly-read record.
 */
export async function executeTopicThread(args: ExecuteTopicThreadArgs): Promise<void> {
  const key = threadKey(args.topicCtx.chatId, args.topicCtx.threadId);
  const id = args.thread.id;
  // Status mirror: the pump tick refreshes it from the store; each lifecycle
  // iteration re-seeds it from the freshly-read record before building
  // dispatchOpts. Read only via isCancelled during the dispatch — refresh
  // semantics are unchanged from the per-dispatch pump.
  const mirror: { status: ThreadRecord['status'] } = { status: args.thread.status };
  let pumpFailures = 0;
  const activityPump = setInterval(() => {
    void pumpTouchFn(key, id)
      .then(() => getThread(key, id))
      .then((cur) => {
        if (cur) mirror.status = cur.status;
        pumpFailures = 0;
      })
      .catch(() => {
        pumpFailures++;
        if (pumpFailures === THREAD_PUMP_FAILURE_WARN_AT) {
          logger.warn('thread-executor', 'activity pump failing', { id, key, failures: pumpFailures });
        }
      });
  }, activityPumpIntervalMs);
  // A keep-alive pump must never hold the process open: an executor that never
  // settles (a test's stalled FYI send, or a hung dispatch awaiting nothing)
  // would otherwise keep the runner alive past its last test. unref'd timers
  // still fire while the process lives; they only stop BLOCKING exit.
  activityPump.unref();
  const flightKey = `${key}/${id}`;
  inFlightThreadExecutions.set(flightKey, (inFlightThreadExecutions.get(flightKey) ?? 0) + 1);
  try {
    return await executeTopicThreadLifecycle(args, mirror);
  } finally {
    clearInterval(activityPump);
    const left = (inFlightThreadExecutions.get(flightKey) ?? 1) - 1;
    if (left > 0) inFlightThreadExecutions.set(flightKey, left);
    else inFlightThreadExecutions.delete(flightKey);
    // AI-255 B4: release this thread's reservations — but only when the record
    // is actually terminal. Gating on the stored status (not on executor exit)
    // is the supersede guard: a stale executor discarded by a newer runSeq
    // must not drop the claims its replacement is still running under.
    // Awaited: a fire-and-forget write would race callers that tear down
    // PA_HOME right after this executor returns.
    await getThread(key, id)
      .then((rec) => {
        if (rec && (rec.status === 'done' || rec.status === 'failed' || rec.status === 'cancelled')) {
          return releaseThreadReservations({ taskId: id });
        }
      })
      .catch((err) =>
        logger.warn('thread-executor', `taskId reservation release failed: ${(err as Error).message}`, { id, key }));
  }
}

/** The lifecycle body — pickup FYI through the last terminal return. Split
 *  from executeTopicThread (WP-H) so the pump's try/finally has exactly one
 *  owner; `mirror` is the executor-scoped status the dispatch's isCancelled
 *  reads. */
async function executeTopicThreadLifecycle(args: ExecuteTopicThreadArgs, mirror: { status: ThreadRecord['status'] }): Promise<void> {
  const { chatId, threadId, topicName } = args.topicCtx;
  const key = threadKey(chatId, threadId);
  const id = args.thread.id;
  const sendFyi: ThreadFyiSender = args.sendFyi ?? ((text, kind, replyMarkup) =>
    sendMessageWithId(
      args.token,
      chatId,
      appendRefIdAndLog(text, { kind, chatId, threadId }),
      threadId || undefined,
      replyMarkup,
    ));
  const mirrorAsk: AskMirrorFn = args.mirrorAsk ?? mirrorAskAsWidget;
  const failVoiceTask: VoiceFailFn = args.failVoiceTask ?? failVoiceTaskInLedger;
  const retryVoiceRouting: VoiceRouteRetryFn = args.retryVoiceRouting ?? defaultRetryVoiceRouting;

  // WP-H heartbeat bracket: one fire-and-forget touchThread before + after an
  // await-heavy phase, bounding the heartbeat gap to the phase itself even if
  // a pump-tick window is missed. Never adds latency or a failure mode — the
  // touches are unawaited and swallow errors (the pump-tick precedent).
  async function withHeartbeat<T>(phase: Promise<T>): Promise<T> {
    void touchThread(key, id).catch(() => {}); // fire-and-forget
    const out = await phase;
    void touchThread(key, id).catch(() => {}); // fire-and-forget
    return out;
  }

  async function sendFyiBestEffort(text: string, kind: RefKind, replyMarkup?: InlineKeyboardMarkup): Promise<void> {
    try {
      await withHeartbeat(sendFyi(text, kind, replyMarkup));
    } catch (err) {
      logger.warn('thread-executor', `${kind} FYI failed: ${(err as Error).message}`, { id, key });
    }
  }

  // Queue wake (increment 4): a terminal settle freed a slot — start the
  // FIFO queue's next record(s). Awaited so the fired executors register in
  // activeThreadExecutions before this one settles (test-drain determinism);
  // the fires themselves stay fire-and-forget.
  async function wakeQueue(): Promise<void> {
    try {
      const claimed = await withHeartbeat(claimThreadStarts(key));
      if (claimed.length > 0) {
        fireClaimedThreads(key, claimed, { secrets: args.secrets, token: args.token, topicName });
      }
    } catch (err) {
      logger.warn('thread-executor', `queue wake failed: ${(err as Error).message}`, { id, key });
    }
  }

  // Pickup FYI (spec §4.7) — once per executor invocation (spawn or wake).
  await sendFyiBestEffort(`🧵 Thread ${id} started: ${args.thread.title}`, 'thread-spawned');

  // Wake entry: a steer to an idle/done/failed thread arrives as pendingInput
  // (handleSteer queues it, then fires the executor when it is not running), so
  // the FIRST turn is the drained message, not the goal again.
  let mode: 'fresh' | 'resumed' = 'fresh';
  let drainedText = '';
  const initial = await takePendingInput(key, id);
  if (initial.length > 0) {
    drainedText = initial.join('\n\n');
    mode = 'resumed';
    await updateThread(key, id, { status: 'running' }).catch(() => {});
  }

  // AI-232: a dependency-parked record starts FRESH (never 'resumed'), so the
  // handoff attaches to the fresh prompt. Read once, outside the retry loop.
  let upstream = '';
  if (args.thread.dependsOn?.length) {
    const deps = await Promise.all(args.thread.dependsOn.map((depId) => getThread(key, depId).catch(() => undefined)));
    upstream = renderUpstreamResults(
      deps.flatMap((d) => (d ? [{ id: d.id, title: d.title, status: d.status, lastResult: d.lastResult }] : [])),
    );
  }

  let autoResumes = 0;
  const resource = `topic-${key}-th${args.thread.n}`;

  for (;;) {
    let rec = await getThread(key, id).catch(() => undefined);
    if (!rec || rec.status === 'cancelled') {
      logger.warn('thread-executor', 'stale run discarded', { id, key, phase: 'pre-dispatch', status: rec?.status ?? 'absent' });
      return;
    }

    // Ownership capture: bumpRunSeq returns the new value atomically with the
    // bump (capture-then-dispatch).
    const capturedRunSeq = await bumpRunSeq(key, id).catch(() => undefined);
    if (capturedRunSeq === undefined) {
      logger.warn('thread-executor', 'stale run discarded', { id, key, phase: 'bump' });
      return;
    }
    // A stale interrupt signal (for a runSeq this run has superseded) is
    // garbage — drop it so the map never outlives the interrupt.
    const pending = interruptSignals.get(resource);
    if (pending !== undefined && pending !== capturedRunSeq) interruptSignals.delete(resource);
    rec = (await getThread(key, id).catch(() => undefined)) ?? rec;

    // WP-7 (OD-4): ONE topic-state load per dispatch — it serves BOTH the
    // fresh-prompt sources section (buildThreadDynamicSections) and the
    // topic-tier tunables below. Resumed turns get no prompt sections but
    // tunables still apply per-hop, so the load lives outside the branches.
    const topicState = await loadTopicState(chatId, threadId).catch(() => null);
    const topicDefaults = topicState?.tunable_defaults;

    // Build the prompt for THIS dispatch.
    let prompt: string;
    let resumeArgs: string[] | undefined;
    let agentName: string | undefined;
    if (mode === 'resumed') {
      const sessionOk = rec.session
        ? await isSessionValid(rec.session, rec.workdir).catch(() => false)
        : false;
      if (sessionOk && rec.session) {
        resumeArgs = buildResumeArgs(rec.session);
        agentName = rec.session.worker;
        prompt = buildThreadResumedTurnPrompt(rec, drainedText);
      } else {
        const dyn = await buildThreadDynamicSections(chatId, threadId, topicState);
        prompt = buildThreadFreshFallbackPrompt(rec, ctxOf(rec, dyn), drainedText, upstream);
      }
    } else {
      const dyn = await buildThreadDynamicSections(chatId, threadId, topicState);
      prompt = buildThreadPrompt(rec, ctxOf(rec, dyn), upstream);
    }

    // Re-seed the executor-lifetime pump's status mirror (WP-H) from the
    // freshly-read record: isCancelled reads mirror.status for THIS dispatch,
    // and the interval keeps refreshing it (and heartbeating the store) until
    // the executor's final settle — no per-dispatch clear, so the
    // post-dispatch awaits stay heartbeated (the t-3 gap).
    mirror.status = rec.status;

    const dispatchOpts: RunOptions = {
      cwd: rec.workdir,
      // env carries ONLY the secrets bag — runWithFailover replaces it with
      // the hop's secret_allowlist-filtered subset, which drops every
      // non-allowlisted key. Every worker in production is allowlisted, so a
      // non-secret key placed here (PA_TASK_ID was, until 2026-09-18) never
      // reaches the child; non-secret dispatch env must ride getEnv instead.
      env: { ...args.secrets },
      // AI-255 B4 + WS3 provenance (2026-09-18, per-hop): getEnv is evaluated
      // by worker-exec with EACH failover hop's own WorkerConfig and merges
      // AFTER the allowlist filter, so these keys reach allowlisted workers.
      // PA_TASK_ID lets a worker's `pa claim` auto-tag taskId=t-<n> — the
      // executor's terminal settle releases them; the PA_WORKER_* provenance
      // keys stamp the worker that actually answered into the ledger.
      getEnv: (w: WorkerConfig) => ({
        PA_TASK_ID: id,
        ...buildWorkerProvenanceEnv({ worker: w, topicDefaults, recordModel: rec.model }),
        // Router-metadata wave (2026-09-20): the ORIGIN turn's routing
        // provenance, persisted on the record at spawn time (a queued/parked
        // thread may start minutes later — never a closure). Old records lack
        // the field ⇒ no PA_ROUTING_* keys (fail-open).
        ...(rec.routing ? buildRoutingProvenanceEnv(rec.routing) : {}),
      }),
      resource,
      // AI-203 WP-2 (item 4): a pinned thread uses its worker instead of the
      // cascade default. The "preferredWorker deliberately absent" of the
      // frozen dispatch shape is relaxed for pinned threads ONLY — an absent
      // worker ⇒ no key (cascade default, unchanged). stripArgs is part of the
      // frozen shape too (increment 2): every thread dispatch suppresses the
      // static prompt file, so a spawned thread runs the prompt it was given.
      ...(rec.worker ? { preferredWorker: rec.worker } : {}),
      requireNonEmptyOutput: true,
      harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS,
      isCancelled: () => mirror.status !== 'running' || interruptSignals.get(resource) === capturedRunSeq,
      // Suppression (increment-2 roadmap item, now built): strip the operator's
      // static bot-instructions file from claude/zclaude thread spawns — a
      // spawned thread must run the prompt it was given, not a static "run
      // tools" appendix. agy/codex configured args lack the flag, so this is a
      // no-op for them (stripConfiguredArgs only drops what matches).
      stripArgs: ['--append-system-prompt-file'],
      // 2026-09-11 dynamic-slots wave: voice-routed threads are short-lived routing
      // work — they wait on a freed worker slot at the 250ms cadence, not 5s.
      // Non-voice spawned threads stay normal priority (unset).
      ...(rec.voiceTaskIds?.length ? { slotPriority: 'routing' as const } : {}),
      // vi-2638f25056ba (2026-09-11): resume args ride getExtraArgs, so ONLY the
      // session's own worker receives them. A static extraArgs is applied to
      // EVERY hop of the failover chain by runWithFailover — an agy-captured
      // session handed its `--conversation <id>` to codex/zclaude/claude, all
      // three spawn-failed ("unknown option '--conversation'"), and the whole
      // chain exhausted (8 chain exhaustions / 15 re-routes on 2026-09-11).
      // A failed-over hop now starts fresh; the prompt already carries the
      // turn text, so the handoff stays clean.
      // 2026-09-12 cross-resume: claude↔zclaude share one session store and one
      // resume format (live-probed), so the session's own worker OR its
      // RESUME_COMPATIBLE sibling receives the args; agy/codex stay strictly
      // own-worker.
      // WP-7 (OD-4): the same getExtraArgs slot now also carries TOPIC-tier
      // tunable_defaults + the record's optional model pin — per-worker slicing
      // (selectWorkerTunables) keeps a claude default off the codex hop (the
      // 2026-09-11 exhaustion class). Resume args stay baseArgs (first);
      // tunables append last-wins. Nothing set ⇒ key absent ⇒ byte-identical
      // RunOptions.
      ...(resumeArgs || topicDefaults || rec.model ? {
        agentName,
        getExtraArgs: (w: WorkerConfig) =>
          buildTopicTierExtraArgs(topicDefaults, rec.model, w,
            (w.name === agentName || RESUME_COMPATIBLE[agentName ?? ''] === w.name ? resumeArgs : undefined)),
      } : {}),
    };

    let run: { worker: string; result: CommandResult };
    try {
      run = args.dispatch
        ? await args.dispatch(prompt, dispatchOpts)
        : await runWithFailover(prompt, dispatchOpts);
    } catch (err) {
      run = { worker: 'unknown', result: { success: false, output: '', error: (err as Error).message, exitCode: null } };
    }

    // Ownership gate BEFORE any FYI or store write: a /stop-cancelled record
    // or a superseded runSeq means another attempt owns the outcome now.
    const after = await getThread(key, id).catch(() => undefined);
    if (!after || after.runSeq !== capturedRunSeq || after.status === 'cancelled') {
      logger.warn('thread-executor', 'stale run discarded', {
        id,
        key,
        capturedRunSeq,
        currentRunSeq: after?.runSeq ?? null,
        status: after?.status ?? 'absent',
      });
      return;
    }

    // AI-202 guard composes: parse BEFORE the failure check so a contentless
    // "launched, waiting" promise rides the SAME ladder as an empty output
    // instead of shipping as the completion FYI. Gate mirrors main.ts's wiring
    // on meta === null (a promise + registered watch_job is never suppressed).
    const { cleaned, meta } = parseMetadata(run.result.output);
    const premature = meta === null && isPrematureAsyncReply(cleaned);
    if (!run.result.success || run.result.output.trim() === '' || premature) {
      if (premature) {
        logger.warn('thread-executor', 'premature-async-reply suppressed into retry ladder', { id, key, chars: cleaned.length, excerpt: cleaned.slice(0, 120) });
      }
      const wallUnavailable = !run.result.success
        && run.result.error === NO_WORKERS_AVAILABLE_ERROR;
      if (wallUnavailable) {
        const parksSoFar = after.unavailableParks ?? 0;
        if (parksSoFar < THREAD_PARK_VALVE) {
          const delayMin = THREAD_PARK_LADDER_MINUTES[Math.min(parksSoFar, THREAD_PARK_LADDER_MINUTES.length - 1)];
          const parkedUntil = new Date(Date.now() + delayMin * 60_000).toISOString();
          await withHeartbeat(updateThread(key, id, {
            status: 'queued',
            parkedUntil,
            unavailableParks: parksSoFar + 1,
            lastError: (redactSecrets(run.result.error as string) as string).slice(0, 300),
          }).catch(() => {}));
          if (parksSoFar === 0) {
            await sendFyiBestEffort(
              `⏸ Thread ${id} parked — all workers rate-limited/unavailable; auto-retry ~${formatIST(new Date(parkedUntil))}`,
              'thread-parked',
            );
          }
          logger.info('thread-executor', `wall-park: all workers unavailable; revival no earlier than ${parkedUntil}`, { id, key, parksSoFar, delayMinutes: delayMin });
          return;
        }
        logger.warn('thread-executor', `wall-park valve: giving up after ${parksSoFar} availability parks`, { id, key });
      }
      const rawReason = wallUnavailable
        ? `all workers unavailable — auto-retry parked ${after.unavailableParks ?? 0} times; giving up (${NO_WORKERS_AVAILABLE_ERROR})`
        : run.result.error
          || (!run.result.success ? `worker ${run.worker} failed`
            : premature ? 'premature async reply (contentless launched/waiting promise)'
            : 'empty output');
      const reason = (redactSecrets(rawReason) as string).slice(0, 300);
      const newAttempts = after.attempts + 1;
      // A wall outcome never rides the attempt ladder: below the valve it parked
      // (returned above); reaching this ladder with wallUnavailable set IS the
      // valve terminal — it fails directly (ruling A, 2026-09-13) and preserves
      // the episode's park count (only a real attempt resets unavailableParks).
      if (newAttempts < TOPIC_THREAD_MAX_ATTEMPTS && !wallUnavailable) {
        await withHeartbeat(updateThread(key, id, { attempts: newAttempts, lastError: reason, unavailableParks: 0 }).catch(() => {}));
        await sendFyiBestEffort(`⏳ Thread ${id} hit a snag — retrying automatically: ${after.title}`, 'thread-retry');
        continue; // same turn, rebuilt prompt (now Attempt 2/2)
      }
      await withHeartbeat(updateThread(key, id, { attempts: newAttempts, lastError: reason, status: 'failed', ...(wallUnavailable ? {} : { unavailableParks: 0 }) }).catch(() => {}));
      try {
        await withHeartbeat(appendTopicEvent(chatId, threadId, { kind: 'thread_failed', ref: id, detail: reason }));
      } catch (err) {
        logger.warn('thread-executor', `thread_failed event failed: ${(err as Error).message}`, { id, key });
      }
      // Terminal-failure surfacing (2026-09-13, operator: no message loss): a
      // voice-stamped record's tasks must not keep promising work in the app
      // after the thread is dead. EVERY carried task is marked failed through
      // the ledger's telemetry verb — awaited BEFORE the FYI so the footer
      // rides the same text (the ask-mirror precedent), best-effort (5 s spawn
      // cap, every error path resolves) and never re-blocking the failed write
      // above. `reason` is already redacted and ≤300 chars (the script's own
      // reason cap).
      const failedNotices: string[] = [];
      let voiceFailedFooter = '';
      if (after.voiceTaskIds?.length) {
        const surfaced = await withHeartbeat(Promise.all(after.voiceTaskIds.map((vt) =>
          failVoiceTask(vt, reason).catch((err) => ({ ok: false as const, taskId: vt, error: (err as Error).message })))));
        const marked = surfaced.filter((r) => r.ok).map((r) => r.taskId);
        if (marked.length > 0) {
          voiceFailedFooter = `\n\n_(Marked failed in your Voice Inbox app: ${marked.join(', ')}.)_`;
        }
        for (const r of surfaced) {
          if (r.ok) continue;
          if (r.error?.startsWith('task ')) {
            // Ledger rejection (task not found, already terminal, …): the app
            // was reached and refused — not a reach failure.
            failedNotices.push(`_(the Voice Inbox app declined the failure mark for ${r.taskId}: ${r.error})_`);
          } else {
            failedNotices.push(`_(could not reach the Voice Inbox app to mark ${r.taskId} failed: ${r.error})_`);
          }
        }
        logger.info('thread-executor', 'terminal failure surfaced to the voice-inbox ledger', { id, key, voiceTaskIds: after.voiceTaskIds, marked: marked.length, declined: surfaced.length - marked.length });
      }
      await sendFyiBestEffort(`❌ Thread ${id} failed: ${after.title}\n\n${reason}${voiceFailedFooter}${failedNotices.length > 0 ? `\n\n${failedNotices.join('\n')}` : ''}`, 'thread-failed');
      // AI-203 turns archiving: archive the failed result into state.turns
      // (best-effort — the result is already in the thread store + FYI).
      await archiveThreadResult(chatId, threadId, {
        role: 'assistant',
        text: `❌ Thread ${id} failed: ${after.title}\n\n${reason}`,
        timestamp: new Date().toISOString(),
        worker: run.worker,
        thread_id: threadId,
        thread_ref: id,
      }, args.archiveSeams).catch(() => {});
      await wakeQueue();
      return;
    }

    // Success: capture session → record done + lastResult → completion FYI
    // (redactSecrets → normalizeMarkdown → no cap; unavailable-action notices
    // appended — task-lane pipeline order).
    const captured = await withHeartbeat(captureSessionForResult(run.worker, run.result, resource));
    // Uncapped since 2026-09-13 (vi-d935e5e13537): lastResult feeds the
    // voice-task completion verbatim; send-side surfaces cap at their own
    // limits (Telegram 3_500, prompt excerpts 400).
    const lastResult = redactSecrets(cleaned) as string;
    await withHeartbeat(updateThread(key, id, {
      status: 'done',
      lastResult,
      unavailableParks: 0,
      ...(captured ? { session: captured } : {}),
    }).catch(() => {}));
    try {
      await withHeartbeat(appendTopicEvent(chatId, threadId, { kind: 'thread_completed', ref: id, detail: after.title }));
    } catch (err) {
      logger.warn('thread-executor', `thread_completed event failed: ${(err as Error).message}`, { id, key });
    }

    let response = lastResult;
    // Ask mirroring (button parity): a question/confirm_required on a
    // VOICE-STAMPED record also arms the matching widget in the voice-inbox
    // app via task_input.py — awaited BEFORE the FYI send so the footer can
    // ride the same text. The mirror is best-effort: ok → footer;
    // `awaiting_input` → the worker already asked there itself (info log, no
    // notice); a `task …` error is a ledger rejection (app reached, ask
    // refused) → a declined notice; anything else → a reach-failure notice.
    //
    // AI-203 WP-2 (item 2): a `question` on a NON-voice record no longer gets
    // the unavailable notice — it sets a pendingQuestion on the record and
    // sends a question FYI with `rq:` option buttons into the topic. The
    // thread is NOT blocked (it continues to done); the question is passive
    // state WP-3's `rq:` callback handler resolves. `confirm_required` (non-
    // voice), `kb_note`, `run_skill` stay unavailable; `watch_job` became real
    // on this lane 2026-09-16 (the rules promised it — an unhandled emit was a
    // silently dropped promise).
    const notices: string[] = [];
    let mirrorFooter = '';
    let questionKeyboard: InlineKeyboardMarkup | undefined;
    const mirrorFooterFor = (mirrored: AskMirrorResult): string | null => {
      if (mirrored.ok) return '\n\n_(Also asked in your Voice Inbox app.)_';
      if (mirrored.error?.includes('awaiting_input')) {
        logger.info('thread-executor', 'task already awaiting_input — the worker asked in the app itself; mirror skipped', { id, key, taskId: mirrored.taskId });
        return null;
      }
      if (mirrored.error?.startsWith('task ')) {
        // Ledger REJECTION from task_input.py (task done, task-not-found, …):
        // the app was reached and refused — not a reach failure.
        notices.push(`_(the Voice Inbox app declined the ask: ${mirrored.error})_`);
        return null;
      }
      notices.push(`_(could not reach the Voice Inbox app: ${mirrored.error})_`);
      return null;
    };
    for (const a of meta?.actions ?? []) {
      const voiceTaskIds = after.voiceTaskIds && after.voiceTaskIds.length > 0 ? after.voiceTaskIds : undefined;
      const isVoice = !!voiceTaskIds;
      if (a.type === 'question') {
        // Shape validation mirrors task-executor.ts's question rules minus its
        // attach-competition precedence (shared by both the voice and non-voice
        // branches).
        const qText = typeof a.text === 'string' ? a.text.trim() : '';
        const rawOptions = Array.isArray(a.options) ? a.options : [];
        if (qText.length < 1 || qText.length > 500) {
          notices.push("_(question rejected: text must be 1..500 chars)_");
          continue;
        }
        const optionsOk =
          rawOptions.length >= 1 &&
          rawOptions.length <= 4 &&
          rawOptions.every((o) => typeof o === 'string' && o.trim().length >= 1 && o.trim().length <= 40);
        if (!optionsOk) {
          notices.push("_(question rejected: options must be 1..4 strings of 1..40 chars)_");
          continue;
        }
        if (isVoice) {
          // Voice-stamped record: mirror the ask into the voice-inbox app
          // (unchanged). Redact the worker-authored copy BEFORE it becomes
          // widget text (the task lane's redact-before-egress precedent).
          const footer = mirrorFooterFor(await mirrorAsk({
            taskIds: voiceTaskIds,
            kind: 'choice',
            prompt: redactSecrets(qText) as string,
            options: rawOptions.map((o) => redactSecrets(o.trim()) as string),
          }));
          if (footer) mirrorFooter = footer;
          continue;
        }
        // AI-203 WP-2 (item 2): NON-voice record — set a pendingQuestion on
        // the store and send a question FYI with `rq:` option buttons. The
        // thread continues to done regardless (passive state); WP-3's callback
        // handler calls takePendingQuestion to resolve the answer.
        const question = {
          text: redactSecrets(qText) as string,
          options: rawOptions.map((o) => redactSecrets(o.trim()) as string),
        };
        const set = await setPendingQuestion(key, id, question).catch(() => false);
        if (!set) {
          notices.push("_(question could not be set on the thread)_");
          continue;
        }
        questionKeyboard = buildThreadQuestionKeyboard(after.n, question.options);
        await sendFyiBestEffort(
          `❓ Thread ${id} asks: ${question.text}`,
          'thread-question',
          questionKeyboard,
        );
        continue;
      }
      if (a.type === 'confirm_required' && isVoice) {
        // confirm_required: `response` is the redacted `cleaned` text (the
        // lastResult region above); capPromptForWidget strips the Telegram-side
        // confirm sentence and clamps to the widget's 500-char prompt max.
        const footer = mirrorFooterFor(await mirrorAsk({
          taskIds: voiceTaskIds,
          kind: 'confirm',
          prompt: capPromptForWidget(response),
        }));
        if (footer) mirrorFooter = footer;
        continue;
      }
      if (a.type === 'watch_job') {
        // Same candidate shape + awaited addWatchJob wording as the task lane —
        // addWatchJob itself validates (no separate pre-validation).
        const candidate: WatchInput = {
          description: (a.description ?? '').trim(),
          check: {
            type: a.check?.type ?? '',
            path: a.check?.path,
            pattern: a.check?.pattern,
            sinceIso: a.check?.since_iso,
            pid: a.check?.pid,
          },
          intervalSeconds: a.interval_seconds,
          deadlineMinutes: a.deadline_minutes,
          source: { kind: 'pa_meta', chatId: String(chatId), threadId, refId: null },
        };
        try {
          const reg = await addWatchJob(candidate);
          response += reg.ok
            ? `\n\n_(Watch registered: ${reg.watch.id} — I'll report here when it completes.)_`
            : `\n\n_(watch_job rejected: ${reg.error})_`;
        } catch (err) {
          response += `\n\n_(watch_job rejected: ${(err as Error).message})_`;
        }
        continue;
      }
      // confirm_required (non-voice), kb_note, run_skill: unavailable.
      notices.push(`_(action '${a.type}' is not available on the thread lane)_`);
    }
    // AI-234 (SPEC §5): extract + sanitize suggested_items from the thread's
    // PA_META, build the sr: keyboard, and store pending_suggestions on the
    // topic's ConversationState so the sr: handler resolves identically to the
    // orchestrator lane. Best-effort topic-state write (ephemeral data — a
    // lost write degrades to sr:gone, never a correctness issue).
    const sanitizedChips = sanitizeSuggestedItems(meta?.suggested_items);
    let suggestKeyboard: InlineKeyboardMarkup | undefined;
    if (sanitizedChips.length > 0) {
      suggestKeyboard = buildSuggestKeyboardInline(sanitizedChips);
      try {
        const ts = await loadTopicState(chatId, threadId);
        ts.pending_suggestions = { items: sanitizedChips };
        await saveTopicState(ts);
      } catch (err) {
        logger.warn('thread-executor', `pending_suggestions save failed (non-fatal): ${(err as Error).message}`, { id, key });
      }
    }
    // Merge: question buttons first (they demand an answer), then chip buttons.
    const doneKeyboard: InlineKeyboardMarkup | undefined = questionKeyboard && suggestKeyboard
      ? { inline_keyboard: [...questionKeyboard.inline_keyboard, ...suggestKeyboard.inline_keyboard] }
      : questionKeyboard ?? suggestKeyboard;
    // Routing retry (2026-09-16, vi-d79c09c5eb37): a carried task this run
    // left never routed (no routed_to, still `received`/`running`) goes back
    // to THIS thread once — pa repairs the ledger (-> `routed` to this topic,
    // which route_task.py accepts again) and the retry message rides
    // pendingInput, so the drain below runs it as the next resumed turn. Runs
    // after the ask mirror (a task this run asked about is `awaiting_input`,
    // never retried) and before the FYI/archive awaits that can stall. A task
    // another live record of this topic carries is left to that record.
    if (after.voiceTaskIds?.length) {
      const siblings = await listThreads(key).catch(() => [] as ThreadRecord[]);
      const liveElsewhere = new Set(
        siblings
          .filter((r) => r.id !== id && (r.status === 'queued' || r.status === 'running'))
          .flatMap((r) => r.voiceTaskIds ?? []),
      );
      const candidates = after.voiceTaskIds.filter((vt) => !liveElsewhere.has(vt));
      if (candidates.length > 0) {
        await withHeartbeat(queueRoutingRetries(key, id, candidates, retryVoiceRouting));
      }
    }
    // Voice-task closure does NOT happen here anymore (2026-09-13 race fix):
    // an executor closure fired at settle races the worker's own richer
    // task_complete call, and the loser's write bounces off the terminal
    // guard — four live tasks were locked to 200-char stubs that way. The
    // closure now lives in the reconcile's late sweep
    // (sweepSettledVoiceTaskClosures): THREAD_VOICE_CLOSE_GRACE_MS after the
    // done write, only for tasks the worker still left open.
    const normalized = normalizeMarkdown(response);
    const capped = normalized.length > THREAD_RESPONSE_CAP_CHARS
      ? normalized.slice(0, THREAD_RESPONSE_CAP_CHARS) + '…'
      : normalized;
    await sendFyiBestEffort(
      `✅ Thread ${id} done: ${after.title}\n\n${capped}${mirrorFooter}${notices.length > 0 ? `\n\n${notices.join('\n')}` : ''}\n\n_(Reply to this message to continue the thread.)_`,
      'thread-done',
      // AI-203 WP-2 (item 2): when a non-voice question co-occurs with done,
      // the done FYI carries the question buttons too — the operator may
      // answer from either the question FYI or the done FYI. The first `rq:`
      // press wins (takePendingQuestion clears the state).
      // AI-234 (SPEC §5): the done FYI also carries sr: chip buttons when the
      // thread's PA_META included suggested_items — merged after the question
      // buttons (chips are a convenience, questions demand an answer).
      doneKeyboard,
    );

    // AI-203 turns archiving: archive the done result into state.turns
    // (best-effort — the result is already in the thread store + FYI). The
    // result excerpt is capped at THREAD_ARCHIVE_TEXT_CHARS; the header is
    // prepended after the slice so `pa recall` sees the full excerpt.
    await archiveThreadResult(chatId, threadId, {
      role: 'assistant',
      text: `✅ Thread ${id} done: ${after.title}\n\n${lastResult.slice(0, THREAD_ARCHIVE_TEXT_CHARS)}`,
      timestamp: new Date().toISOString(),
      worker: run.worker,
      thread_id: threadId,
      thread_ref: id,
    }, args.archiveSeams).catch(() => {});

    // Pending-input drain: after a completed run, deliver queued steer(s) as
    // the thread's next turn. Over MAX_AUTO_RESUMES_PER_CHAIN: park the
    // record as 'queued' and wake the queue (a fresh chain drains the rest).
    const afterRun = await getThread(key, id).catch(() => undefined);
    if (!afterRun || afterRun.status === 'cancelled') return;
    // Cap guard FIRST: a take after the cap check would silently destroy inputs.
    if (afterRun.pendingInput.length > 0 && autoResumes < MAX_AUTO_RESUMES_PER_CHAIN) {
      autoResumes++;
      drainedText = (await takePendingInput(key, id)).join('\n\n');
      if (!drainedText) return; // a concurrent take raced us empty
      mode = 'resumed';
      await withHeartbeat(updateThread(key, id, { status: 'running' }).catch(() => {}));
      continue;
    }
    if (afterRun.pendingInput.length > 0) {
      await withHeartbeat(updateThread(key, id, { status: 'queued' }).catch(() => {}));
      logger.warn('thread-executor', 'auto-resume cap reached; steer inputs left queued; record parked as queued for the next wake', {
        id,
        key,
        queued: afterRun.pendingInput.length,
        cap: MAX_AUTO_RESUMES_PER_CHAIN,
      });
      await wakeQueue();
      return;
    }
    await wakeQueue();
    return;
  }

  function ctxOf(
    rec: ThreadRecord,
    dyn?: Pick<ThreadTopicContext, 'pointers' | 'reservations'>
  ): ThreadTopicContext {
    return { chatId, threadId, topicName, ...(dyn ?? {}) };
  }
}

/** Minimal structural view of pa's cooldown ledger: worker → cooldown end.
 *  The pa entry carries more fields; they pass through untouched. */
export type ThreadReadCooldownFn = () => Promise<Record<string, { cooldown_until: string }>>;

export interface CooldownExpiryDeps {
  /** Test seam — default is the real pa cooldown read (getCooldownStatus;
   *  returns the raw ledger INCLUDING already-expired entries). */
  readCooldownStatus?: ThreadReadCooldownFn;
  /** Test seam — default is the real pa eviction (clearWorkerCooldown). */
  evictCooldown?: (worker: string) => Promise<boolean>;
}

/**
 * Cooldown-expiry event (operator directive 2026-09-13) — the poll-tick
 * sibling that runs BEFORE reconcileThreadQueues in the same drain. Cooldown
 * end times come from the worker error messages themselves — exact knowledge,
 * not estimates — so an entry whose `cooldown_until` has passed IS the "model
 * X is back" event. On it the entry is evicted from pa's ledger (which
 * unblocks the dispatch cascade for that model) and every wall-parked thread's
 * `parkedUntil` rewinds to now (wakeWallParked), so the same tick's reconcile
 * re-claims immediately. Once-only by construction: eviction IS the fired
 * marker — an evicted entry cannot re-fire, and a still-limited retry records
 * a NEW cooldown with a NEW end (the next event). Ghosts self-correct: a wrong
 * end survives one retry-probe-repark cycle. Rides the existing poll-tick
 * cadence — no new timer. Returns the number of threads woken (0 = no event).
 */
export async function wakeWallParkedOnCooldownExpiry(deps: CooldownExpiryDeps = {}): Promise<number> {
  const read = deps.readCooldownStatus ?? getCooldownStatus;
  const evict = deps.evictCooldown ?? clearWorkerCooldown;
  const snapshot = await read().catch(() => ({} as Record<string, { cooldown_until: string }>));
  const nowMs = Date.now();
  const expiredBack = Object.entries(snapshot ?? {})
    .filter(([, entry]) => {
      const t = new Date(entry.cooldown_until).getTime();
      return Number.isFinite(t) && t <= nowMs;
    })
    .map(([worker]) => worker);
  if (expiredBack.length === 0) return 0;
  // Eviction IS the fired marker. A re-record between this read and the evict
  // (a fresh 429 writes a new future end) is evicted with the expired one —
  // a millisecond-wide race that self-corrects on the next 429 re-record.
  for (const worker of expiredBack) {
    try {
      await evict(worker);
    } catch { /* entry persists → re-fires next tick; the wake is idempotent */ }
  }
  const woken = await wakeWallParked();
  logger.info('thread-executor', `cooldown expiry: ${expiredBack.join(', ')} back — woke ${woken} wall-parked thread(s)`, { workers: expiredBack, woken });
  return woken;
}

/** Minimum interval between reconcile passes (AI-203 increment 4). The
 *  primary wakes are in-band (executor terminals, spawn/steer handlers);
 *  this throttle only paces the poll-tick backstop that revives a queue a
 *  restart or a missed wake left parked while slots are free. */
export const THREAD_QUEUE_RECONCILE_MIN_INTERVAL_MS = 60_000;
/** WP-H: a pass this much later than the cadence logs ONE starvation warn —
 *  observability only, no behavior change. */
const RECONCILE_STARVED_WARN_MS = 5 * 60_000;
let lastReconcileAt = 0;

export interface ThreadQueueReconcileDeps {
  secrets: Record<string, string>;
  token: string;
  topicNameFromKey: (key: string) => string;
  /** Test seam — default is the real voice-inbox ledger completion
   *  (completeVoiceTaskInLedger); backs the late voice-task closure sweep. */
  completeVoiceTask?: VoiceCompleteFn;
  /** Test seam — default is the real pa ledger read
   *  (voiceInboxTerminalTaskIds, fail-open); tells the sweep which carried
   *  tasks are already terminal. */
  readTerminalVoiceTaskIds?: (taskIds: readonly string[]) => Set<string>;
  /** Test seam — default is the real pa ledger read (voiceInboxTaskStates,
   *  fail-open); supplies state + routed_to for the carried tasks the terminal
   *  read left open. A missing row = no routing knowledge = close proceeds. */
  readVoiceTaskStates?: (taskIds: readonly string[]) => Map<string, VoiceInboxTaskState>;
  /** Test seam — default is the real pa routing retry
   *  (returnVoiceTaskForRouting); backs the sweep twin of the settle retry. */
  retryVoiceRouting?: VoiceRouteRetryFn;
  /** Test seam — default is the real pa read (voiceInboxRouteRetryPendingIds,
   *  fail-open): carried tasks a routing retry returned that nobody has routed
   *  since. */
  readRouteRetryPending?: (taskIds: readonly string[]) => Set<string>;
}

/**
 * Routing retry (2026-09-16, vi-d79c09c5eb37): for each carried task, ask pa to
 * return it for routing (a legal ledger repair that succeeds only for a task
 * with no routed_to in `received`/`running`), then queue the retry message on
 * THIS record's pendingInput so its next turn routes it. Returns how many
 * messages were queued. Skips are silent — almost every settle carries a task
 * that is already routed or terminal. Never throws.
 */
async function queueRoutingRetries(
  key: string,
  id: string,
  taskIds: readonly string[],
  retry: VoiceRouteRetryFn,
): Promise<number> {
  let queued = 0;
  for (const vt of taskIds) {
    const r = await Promise.resolve()
      .then(() => retry(vt, key))
      .catch((err): VoiceRouteRetryResult => ({ outcome: 'error', taskId: vt, error: (err as Error).message }));
    if (r.outcome === 'skipped') continue;
    if (r.outcome === 'error') {
      logger.warn('thread-executor', `routing retry could not return ${vt} for routing: ${r.error}`, { key, id, taskId: vt });
      continue;
    }
    const q = await queueThreadInput(key, id, r.message)
      .catch((err): { ok: false; reason: string } => ({ ok: false, reason: (err as Error).message }));
    if (!q.ok) {
      logger.warn('thread-executor', `routing retry returned ${vt} but could not queue the retry message: ${q.reason}`, { key, id, taskId: vt });
      continue;
    }
    logger.info('thread-executor', 'voice task settled without routing — sent back to its routing thread once', { key, id, taskId: vt });
    queued += 1;
  }
  return queued;
}

/** Sweep twin of the executor's pending-input drain (handleSteer's wake
 *  path): park a `done` record as `queued` so the FIFO claim owns the start,
 *  then claim and fire. A full topic leaves it queued for the next claim. */
async function wakeRoutingRetryThread(key: string, id: string, deps: ThreadQueueReconcileDeps): Promise<void> {
  const cur = await getThread(key, id).catch(() => undefined);
  if (cur?.status === 'done') await updateThread(key, id, { status: 'queued' }).catch(() => {});
  const claimed = await claimThreadStarts(key).catch(() => [] as ThreadRecord[]);
  if (claimed.length > 0) {
    fireClaimedThreads(key, claimed, { secrets: deps.secrets, token: deps.token, topicName: deps.topicNameFromKey(key) });
  }
}

/**
 * Late voice-task closure sweep (2026-09-13 race fix): for every `done`
 * record whose settle time is at least THREAD_VOICE_CLOSE_GRACE_MS past,
 * close the voice tasks the worker still left open. The settle time is the
 * record's own `updatedAt` — the done write is the last thing that bumps it
 * (the activity pump touches running records only). The grace exists so the
 * worker's own richer task_complete wins the race; auto-closure is the
 * fallback, not the preemptor. Same refusal semantics as the executor's
 * other ledger surfaces: an already-closed rejection is a silent logged
 * skip, a reach failure is one logged notice attempt, and nothing here ever
 * blocks the reconcile pass (resolves on every error path, never throws).
 *
 * Routed-ask loopback (2026-09-14): this sweep is also the honest backstop
 * of the no-early-close routing contract — the inbox route stage now leaves
 * a routed task open (bridge-writer.ts's inbox texts teach it), so the
 * closure that reaches the operator's card is the DESTINATION's completion
 * (worker task_complete.py, or this sweep closing carried tasks with the
 * thread's verbatim reply). A thread that settled `done` with no usable
 * reply text closes its still-open carried tasks with
 * THREAD_VOICE_EMPTY_RESULT_NOTE instead of hanging them open forever.
 * Never-injected routes (task still `routed`, no thread anywhere) stay the
 * pa-side voice-inbox-fallback job's business — its replay re-routes with
 * the honest "without a worker picking up the route" reason and pages the
 * operator; this sweep must not close what the fallback is still trying to
 * place.
 *
 * Never-routed and awaiting-input defers (2026-09-16): a carried task whose
 * ledger row has no `routed_to` was never routed — an inbox routing run
 * progressed it and settled without route_task.py (vi-d79c09c5eb37) — so
 * the record's reply is not its answer; the pa fallback's dead-dispatch arm
 * places it. A task in `awaiting_input` is waiting on the operator's answer,
 * and task_complete.py would cancel every pending ask in its conversation.
 * Both defer on every pass; neither ever closes with the record's reply.
 *
 * Routing retry (2026-09-16): before deciding closures, a record no executor
 * is running, with nothing queued and settled within
 * THREAD_ROUTE_RETRY_SWEEP_MAX_AGE_MS, sends each never-routed carried task
 * back once (queueRoutingRetries) and is woken — the restart/late twin of the
 * executor's settle-time retry. A task the retry returned to THIS key that is
 * still unrouted defers: the pa fallback places it.
 */
async function sweepSettledVoiceTaskClosures(deps: ThreadQueueReconcileDeps): Promise<void> {
  const completeVoiceTask = deps.completeVoiceTask ?? completeVoiceTaskInLedger;
  const readTerminal = deps.readTerminalVoiceTaskIds ?? voiceInboxTerminalTaskIds;
  const readStates = deps.readVoiceTaskStates ?? voiceInboxTaskStates;
  const retryRouting = deps.retryVoiceRouting ?? defaultRetryVoiceRouting;
  const readRetryPending = deps.readRouteRetryPending ?? ((ids: readonly string[]) => voiceInboxRouteRetryPendingIds(ids));
  const keys = await listStoreKeys().catch(() => [] as string[]);
  // Phase 1 (2026-09-15 routed-state rule): collect every store's records
  // BEFORE deciding any close — the routing knowledge and the live carriers
  // a done record competes with can live in another topic's store.
  // `queued`/`running` are the only non-terminal ThreadRecord statuses; a
  // record in either still owns its carried tasks' eventual closure.
  const all: Array<{ key: string; rec: ThreadRecord }> = [];
  const liveCarriers = new Set<string>();
  for (const key of keys) {
    const records = await listThreads(key).catch(() => [] as ThreadRecord[]);
    for (const rec of records) {
      all.push({ key, rec });
      if (rec.status === 'queued' || rec.status === 'running') {
        for (const vt of rec.voiceTaskIds ?? []) liveCarriers.add(vt);
      }
    }
  }
  for (const { key, rec } of all) {
    if (rec.status !== 'done' || !rec.voiceTaskIds?.length) continue;
    const settledAt = Date.parse(rec.updatedAt);
    if (!Number.isFinite(settledAt) || Date.now() - settledAt < THREAD_VOICE_CLOSE_GRACE_MS) continue;
    const terminal = readTerminal(rec.voiceTaskIds);
    const open = rec.voiceTaskIds.filter((vt) => !terminal.has(vt));
    if (open.length === 0) continue;
    const stateMap = readStates(open);
    // Routing retry, restart/late twin (2026-09-16): the executor sends a
    // never-routed carried task back at settle; this covers a settle it could
    // not act on (a bot restart, or a task still transcribing at settle that
    // is `received` now). Only a record no executor is running, with nothing
    // queued, settled within THREAD_ROUTE_RETRY_SWEEP_MAX_AGE_MS.
    if (
      !isThreadExecutionInFlight(key, rec.id)
      && rec.pendingInput.length === 0
      && Date.now() - settledAt <= THREAD_ROUTE_RETRY_SWEEP_MAX_AGE_MS
    ) {
      const unrouted = open.filter((vt) => {
        const st = stateMap.get(vt);
        return !!st && !st.routedTo && (st.state === 'received' || st.state === 'running') && !liveCarriers.has(vt);
      });
      if (unrouted.length > 0 && (await queueRoutingRetries(key, rec.id, unrouted, retryRouting)) > 0) {
        await wakeRoutingRetryThread(key, rec.id, deps);
        continue; // this pass's state snapshot is stale for the returned tasks
      }
    }
    // A task the routing retry returned to THIS topic that is still unrouted
    // (the retry run settled without routing it too) is the pa fallback's to
    // place; this record's reply is never its answer.
    const retryPending = open.some((vt) => stateMap.get(vt)?.routedTo === key)
      ? readRetryPending(open)
      : new Set<string>();
    // Phase 2 (2026-09-16 routed-ownership fix): a still-open task is not
    // automatically THIS record's to close. Routing ownership is set by
    // WHERE the task went (`routedTo`), not by the task's current (transient)
    // state — a routing thread that handed a task off must defer for as long
    // as the destination hasn't reached a terminal state, whatever that
    // non-terminal state is (`routed`, `running`, `awaiting_input`, or any
    // other). The earlier `state === 'routed'` check stopped deferring the
    // instant the destination worker started (state flipped to `running`),
    // so the routing thread's own record raced ahead and closed the task
    // with its routing-receipt reply — task_complete.py refused that receipt
    // and the sweep wrote THREAD_VOICE_REFUSED_RESULT_NOTE over the real
    // answer the destination worker was still producing (live evidence:
    // vi-bb7593055c37, started 08:35:26Z, closed with the note at 08:35:51Z
    // by thread t-344 while the destination was still writing; 6 of 10
    // ledger tasks carrying that note were closed this way). A row absent
    // from the map = no routing knowledge = close proceeds (fail-open).
    const closable = open.filter((vt) => {
      const st = stateMap.get(vt);
      // Never routed (2026-09-16, vi-d79c09c5eb37): a present row with no
      // routed_to means no routing ever happened (routed_to is only ever set,
      // never cleared). This record's reply is a routing thread's process
      // text, not the answer — the pa fallback places the task instead.
      if (st && !st.routedTo) {
        logger.info('thread-executor', 'voice task never routed — closure deferred to the placement fallback', { key, id: rec.id, taskId: vt, state: st.state });
        return false;
      }
      if (st?.routedTo && st.routedTo !== key) {
        logger.info('thread-executor', 'voice task routed to another topic — closure deferred', { key, id: rec.id, taskId: vt, routedTo: st.routedTo, state: st.state });
        return false;
      }
      if (retryPending.has(vt)) {
        logger.info('thread-executor', 'voice task routing retry ended unrouted — closure deferred to the placement fallback', { key, id: rec.id, taskId: vt });
        return false;
      }
      // Awaiting the operator (2026-09-16): the done write precedes the ask
      // mirror, so a destination record settles while its task waits on an
      // answer; closing it would cancel every pending ask in the conversation.
      if (st?.state === 'awaiting_input') {
        logger.info('thread-executor', 'voice task awaiting the operator answer — closure deferred', { key, id: rec.id, taskId: vt });
        return false;
      }
      if (liveCarriers.has(vt)) {
        logger.info('thread-executor', 'voice task carried by a live thread — closure deferred', { key, id: rec.id, taskId: vt });
        return false;
      }
      return true;
    });
    if (closable.length === 0) continue;
    // Verbatim, never capped (2026-09-13, vi-d935e5e13537): this summary
    // becomes the operator's answer card. The 200-char cap that lived here
    // silently cut sweep-closed answers mid-sentence with a trailing '…';
    // the card already tiers long answers (IN SHORT + Show full answer),
    // and nothing from task_complete.py to the ledger caps. A thread with
    // no usable reply closes with the honest empty-result note instead —
    // the asker's card ends truthfully rather than hanging open forever.
    const voiceSummary = rec.lastResult?.trim()
      ? rec.lastResult
      : THREAD_VOICE_EMPTY_RESULT_NOTE;
    // One retry per task (2026-09-15, ai246 WP-E): a verbatim reply the
    // summary guards refuse (exit 2 — receipt markers, a bare NEXT ACTIONS
    // line, a request re-paste) is NOT a reach failure; re-sending the same
    // string every pass looped forever. The refused-result note is
    // guard-safe, so the second call either lands or is a real failure.
    const closeOne = async (vt: string): Promise<VoiceLedgerResult> => {
      const attempt = (summary: string): Promise<VoiceLedgerResult> =>
        completeVoiceTask(vt, summary)
          .catch((err) => ({ ok: false as const, taskId: vt, error: (err as Error).message }));
      const first = await attempt(voiceSummary);
      if (first.ok || !VOICE_COMPLETE_REFUSED_RE.test(first.error ?? '')) return first;
      // A refused summary on a still-`routed` task defers instead of taking
      // the honest-note retry — the task has no answer yet, so the note
      // would lie. Non-routed refusals keep the retry (the receipt wedge).
      if (stateMap.get(vt)?.state === 'routed') {
        logger.info('thread-executor', 'refused summary on a routed task — deferring instead of the honest note', { key, id: rec.id, taskId: vt });
        return { ok: false as const, taskId: vt, error: VOICE_CLOSE_DEFERRED_ROUTED };
      }
      const second = await attempt(THREAD_VOICE_REFUSED_RESULT_NOTE);
      if (second.ok) {
        logger.info('thread-executor', 'verbatim reply refused as a voice-task summary — closed with the honest note instead', { key, id: rec.id, taskId: vt });
      }
      return second;
    };
    const closed = await Promise.all(closable.map(closeOne));
    const marked = closed.filter((r) => r.ok).map((r) => r.taskId);
    for (const r of closed) {
      if (r.ok) continue;
      if (r.error === VOICE_CLOSE_DEFERRED_ROUTED) continue; // deliberate defer — already logged in closeOne
      if (r.error?.startsWith('task ') || r.error?.startsWith('illegal task state transition:')) {
        // The worker closed this task in the meantime — the normal path.
        logger.info('thread-executor', 'voice task already closed in the ledger — late sweep skipped', { key, id: rec.id, taskId: r.taskId });
      } else {
        logger.warn('thread-executor', `could not reach the Voice Inbox app to close ${r.taskId} (late sweep): ${r.error}`, { key, id: rec.id, taskId: r.taskId });
      }
    }
    if (marked.length > 0) {
      logger.info('thread-executor', 'late voice-task closure surfaced to the ledger', { key, id: rec.id, voiceTaskIds: open, marked: marked.length });
    }
  }
}

/**
 * Reconcile pass over EVERY topic's store: claim startable queued records
 * and fire them. No-op (and no store read beyond the dir listing) while the
 * throttle holds. Returns the number of records fired. Never throws.
 */
export async function reconcileThreadQueues(deps: ThreadQueueReconcileDeps): Promise<number> {
  const now = Date.now();
  const lateMs = now - lastReconcileAt; // measured BEFORE the stamp update (WP-H)
  if (now - lastReconcileAt < THREAD_QUEUE_RECONCILE_MIN_INTERVAL_MS) return 0;
  // WP-H observability: a pass running far past the 60s cadence means the
  // poll-tick backstop was starved. One warn, no behavior change.
  // lastReconcileAt > 0 excludes the never-ran case (process start / test
  // reset) — "never ran" is not "starved".
  if (lastReconcileAt > 0 && lateMs > RECONCILE_STARVED_WARN_MS) {
    logger.warn('thread-executor', 'reconcile pass starved', { lateMs });
  }
  lastReconcileAt = now;
  let fired = 0;
  const keys = await listStoreKeys().catch(() => [] as string[]);
  for (const key of keys) {
    const claimed = await claimThreadStarts(key).catch(() => []);
    if (claimed.length > 0) {
      fireClaimedThreads(key, claimed, { secrets: deps.secrets, token: deps.token, topicName: deps.topicNameFromKey(key) });
      fired += claimed.length;
    }
  }
  // Late voice-task closure sweep (2026-09-13 race fix): rides the same 60 s
  // cadence — a settled thread's still-open voice tasks close here only once
  // THREAD_VOICE_CLOSE_GRACE_MS has passed and the worker's own task_complete
  // never did. Never blocks the pass.
  await sweepSettledVoiceTaskClosures(deps).catch(() => {});
  return fired;
}

/** Test hook: reset the reconcile throttle. */
export function _resetThreadQueueReconcileForTest(): void {
  lastReconcileAt = 0;
}

/** Test seam (WP-H): backdate lastReconcileAt to force a starving pass.
 *  Production never calls this. */
export function _setLastReconcileAtForTest(ms: number): void {
  lastReconcileAt = ms;
}
