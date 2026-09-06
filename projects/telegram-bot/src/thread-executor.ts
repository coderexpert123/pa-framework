/**
 * Orchestrator execution-thread executor (AI-203 WP-4).
 *
 * The fire-and-forget lane that runs one spawned CLI conversation per thread
 * record (`~/.pa/topic-threads/<chatId>_<threadId>.json`, store: topic-threads.ts).
 * Modeled on the task lane's proven patterns (task-executor.ts): fire-and-forget
 * promise tracking, a per-dispatch activity pump, an ownership gate that discards
 * superseded runs silently, a 2-attempt ladder with the AI-202 premature-reply
 * guard feeding it, and best-effort FYI delivery (no DLQ — a lost FYI loses a
 * notification, not work).
 *
 * Dispatches take a NON-topic blackboard resource (`topic-<key>-th<n>`) — pa's
 * worker-exec takes its lock ON the resource, so reusing the topic resource would
 * serialize thread runs against orchestrator turns. The price (accepted, made
 * truthful by the record): `stopTopicWorkers` matches `entry.skill` and therefore
 * does NOT kill thread processes; `/stop` cancels the RECORD, the runSeq gate
 * discards the late result silently, and the /stop reply states the count.
 *
 * Consumed by orchestrator.ts (handleSpawn/handleSteer) and main.ts. Nothing in
 * this file imports main.ts — main.ts is the composition root.
 */

import { formatIST } from '../../../pa/dist/src/ist.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { redactSecrets } from '../../../pa/dist/src/lib/redact.js';
import { appendTopicEvent } from '../../../pa/dist/src/lib/topic-events.js';
import { runWithFailover } from '../../../pa/dist/src/workers.js';
import type { CommandResult, RunOptions } from '../../../pa/dist/src/types.js';
import {
  bumpRunSeq,
  getThread,
  takePendingInput,
  updateThread,
  touchThread,
  THREAD_ACTIVITY_THROTTLE_MS,
  type ThreadRecord,
} from './topic-threads.js';
import { ORPHAN_HARVEST_WINDOW_MS, TASK_RULES } from './task-executor.js';
import { captureSessionForResult } from './session-capture.js';
import { buildResumeArgs, isSessionValid } from './session.js';
import { isPrematureAsyncReply, normalizeMarkdown, parseMetadata } from './logic.js';
import { appendRefIdAndLog, type RefKind } from './ref-id.js';
import { sendMessageWithId } from './telegram.js';

/** Best-effort FYI sender — `(text, refKind)` pinned to one thread's topic. */
export type ThreadFyiSender = (text: string, kind: RefKind) => Promise<number | null>;

/** Test seam — default is the real runWithFailover cascade. The opts object is
 *  the exact RunOptions the executor built, so tests observe the resume args
 *  (`extraArgs`) and the prompt in one place. */
export type ThreadDispatchFn = (
  prompt: string,
  opts: RunOptions
) => Promise<{ worker: string; result: CommandResult }>;

export interface ExecuteTopicThreadArgs {
  thread: ThreadRecord;
  topicCtx: { chatId: number; threadId: number; topicName: string };
  secrets: Record<string, string>;
  token: string;
  workdir: { dir: string };
  /** Test seam — default is the real Telegram send with the ref-id footer. */
  sendFyi?: ThreadFyiSender;
  /** Test seam — default is the real runWithFailover cascade. */
  dispatch?: ThreadDispatchFn;
}

/** Executor-owned constants (AI-203 spec §4.1; store-side constants live in
 *  topic-threads.ts). */
export const MAX_AUTO_RESUMES_PER_CHAIN = 5;
export const THREAD_RESPONSE_CAP_CHARS = 3_500;
export const THREAD_RESULT_EXCERPT_CHARS = 400;
export const TOPIC_THREAD_MAX_ATTEMPTS = 2;

/** Topic context for one thread (mirrors the task lane's context shape; kept
 *  local rather than imported so the two lanes stay decoupled). */
export interface ThreadTopicContext {
  chatId: number;
  threadId: number;
  topicName: string;
}

/**
 * The thread prompt (AI-203 spec §4.6 frozen skeleton). `TASK_RULES` is imported
 * verbatim from task-executor.ts, never restated.
 */
export function buildThreadPrompt(thread: ThreadRecord, ctx: ThreadTopicContext): string {
  const nowIst = formatIST(new Date());
  const today = nowIst.slice(0, 10);
  const clock = nowIst.slice(11, 16);
  return `You are executing a spawned thread for topic "${ctx.topicName}" (${ctx.chatId}_${ctx.threadId}).
Today is ${today}. Current time (IST): ${clock}.
Thread: ${thread.id} — ${thread.title}
Attempt ${thread.attempts + 1}/${TOPIC_THREAD_MAX_ATTEMPTS}. This conversation is your own; later messages in this thread resume it.

## Your task
${thread.goal}

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
  drainedInput: string
): string {
  const prior = thread.lastResult
    ? `\n\n## Prior result\n${thread.lastResult.slice(0, THREAD_RESULT_EXCERPT_CHARS)}`
    : '';
  return `${buildThreadPrompt(thread, ctx)}${prior}\n\n## Current Message\n${drainedInput}`;
}

/** In-flight executor promises (the drain fires executeTopicThread NOT awaited;
 *  this Set keeps them referenced and gives tests/WP-5 a drain point). */
export const activeThreadExecutions = new Set<Promise<unknown>>();

/** Test seam (injectable-timer pattern, `_setActivityPumpIntervalForTest`
 *  precedent from the task lane): the activity pump's interval period.
 *  Production never calls this. */
let activityPumpIntervalMs = THREAD_ACTIVITY_THROTTLE_MS;
export function _setActivityPumpIntervalForTest(ms: number): void {
  activityPumpIntervalMs = ms;
}

/** Test drain point: resolves once every in-flight execution has settled. */
export async function _waitForThreadExecutionsForTest(): Promise<void> {
  while (activeThreadExecutions.size > 0) {
    await Promise.allSettled([...activeThreadExecutions]);
  }
}

function threadKey(chatId: number, threadId: number): string {
  return `${chatId}_${threadId}`;
}

// Pending inputs are taken atomically via the store's takePendingInput (see the
// increment-1 SPEC's execution-notes tail).

/**
 * Execute one thread end-to-end (AI-203 spec §2.2 lifecycle). Fire-and-forget —
 * callers track the returned promise in activeThreadExecutions and never await
 * it on the dispatch path.
 */
export async function executeTopicThread(args: ExecuteTopicThreadArgs): Promise<void> {
  const { chatId, threadId, topicName } = args.topicCtx;
  const key = threadKey(chatId, threadId);
  const id = args.thread.id;
  const sendFyi: ThreadFyiSender = args.sendFyi ?? ((text, kind) =>
    sendMessageWithId(
      args.token,
      chatId,
      appendRefIdAndLog(text, { kind, chatId, threadId }),
      threadId || undefined
    ));

  async function sendFyiBestEffort(text: string, kind: RefKind): Promise<void> {
    try {
      await sendFyi(text, kind);
    } catch (err) {
      logger.warn('thread-executor', `${kind} FYI failed: ${(err as Error).message}`, { id, key });
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
    rec = (await getThread(key, id).catch(() => undefined)) ?? rec;

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
        prompt = buildThreadFreshFallbackPrompt(rec, ctxOf(rec), drainedText);
      }
    } else {
      prompt = buildThreadPrompt(rec, ctxOf(rec));
    }

    // Activity pump (task-lane pattern): heartbeat the running record while
    // THIS dispatch is in flight so the stale classifier never demotes an
    // owned, possibly-still-producing attempt. Each tick also refreshes the
    // status mirror that isCancelled reads (the probe is synchronous by
    // contract; the store is async). Cleared when the dispatch settles — a
    // pump that outlived its attempt would keep stamping the store.
    let mirrorStatus: ThreadRecord['status'] = rec.status;
    const activityPump = setInterval(() => {
      void touchThread(key, id)
        .then(() => getThread(key, id))
        .then((cur) => {
          if (cur) mirrorStatus = cur.status;
        })
        .catch(() => {});
    }, activityPumpIntervalMs);

    const dispatchOpts: RunOptions = {
      cwd: rec.workdir,
      env: args.secrets,
      resource,
      // preferredWorker deliberately absent: cascade default this increment
      // (AI-203 spec, frozen dispatch shape). stripArgs is part of the frozen
      // shape too (increment 2): every thread dispatch suppresses the static
      // prompt file, so a spawned thread runs the prompt it was given.
      requireNonEmptyOutput: true,
      harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS,
      isCancelled: () => mirrorStatus !== 'running',
      // Suppression (increment-2 roadmap item, now built): strip the operator's
      // static bot-instructions file from claude/zclaude thread spawns — a
      // spawned thread must run the prompt it was given, not a static "run
      // tools" appendix. agy/codex configured args lack the flag, so this is a
      // no-op for them (stripConfiguredArgs only drops what matches).
      stripArgs: ['--append-system-prompt-file'],
      ...(resumeArgs ? { extraArgs: resumeArgs, agentName } : {}),
    };

    let run: { worker: string; result: CommandResult };
    try {
      run = args.dispatch
        ? await args.dispatch(prompt, dispatchOpts)
        : await runWithFailover(prompt, dispatchOpts);
    } catch (err) {
      run = { worker: 'unknown', result: { success: false, output: '', error: (err as Error).message, exitCode: null } };
    } finally {
      clearInterval(activityPump);
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
      const rawReason = run.result.error
        || (!run.result.success ? `worker ${run.worker} failed`
          : premature ? 'premature async reply (contentless launched/waiting promise)'
          : 'empty output');
      const reason = (redactSecrets(rawReason) as string).slice(0, 300);
      const newAttempts = after.attempts + 1;
      if (newAttempts < TOPIC_THREAD_MAX_ATTEMPTS) {
        await updateThread(key, id, { attempts: newAttempts, lastError: reason }).catch(() => {});
        await sendFyiBestEffort(`⏳ Thread ${id} hit a snag — retrying automatically: ${after.title}`, 'thread-retry');
        continue; // same turn, rebuilt prompt (now Attempt 2/2)
      }
      await updateThread(key, id, { attempts: newAttempts, lastError: reason, status: 'failed' }).catch(() => {});
      try {
        await appendTopicEvent(chatId, threadId, { kind: 'thread_failed', ref: id, detail: reason });
      } catch (err) {
        logger.warn('thread-executor', `thread_failed event failed: ${(err as Error).message}`, { id, key });
      }
      await sendFyiBestEffort(`❌ Thread ${id} failed: ${after.title}\n\n${reason}`, 'thread-failed');
      return;
    }

    // Success: capture session → record done + lastResult → completion FYI
    // (redactSecrets → normalizeMarkdown → cap; unavailable-action notices
    // appended — task-lane pipeline order).
    const captured = await captureSessionForResult(run.worker, run.result, resource);
    const lastResult = (redactSecrets(cleaned) as string).slice(0, 4000);
    await updateThread(key, id, {
      status: 'done',
      lastResult,
      ...(captured ? { session: captured } : {}),
    }).catch(() => {});
    try {
      await appendTopicEvent(chatId, threadId, { kind: 'thread_completed', ref: id, detail: after.title });
    } catch (err) {
      logger.warn('thread-executor', `thread_completed event failed: ${(err as Error).message}`, { id, key });
    }

    let response = lastResult;
    const notices = (meta?.actions ?? []).map((a) => `_(action '${a.type}' is not available on the thread lane)_`);
    const normalized = normalizeMarkdown(response);
    const capped = normalized.length > THREAD_RESPONSE_CAP_CHARS
      ? normalized.slice(0, THREAD_RESPONSE_CAP_CHARS) + '…'
      : normalized;
    await sendFyiBestEffort(
      `✅ Thread ${id} done: ${after.title}\n\n${capped}${notices.length > 0 ? `\n\n${notices.join('\n')}` : ''}`,
      'thread-done'
    );

    // Pending-input drain: after a completed run, deliver queued steer(s) as
    // the thread's next turn. Over MAX_AUTO_RESUMES_PER_CHAIN: stop, log,
    // leave the inputs queued (the next steer after the operator reads the
    // topic resumes them).
    const afterRun = await getThread(key, id).catch(() => undefined);
    if (!afterRun || afterRun.status === 'cancelled') return;
    // Cap guard FIRST: a take after the cap check would silently destroy inputs.
    if (afterRun.pendingInput.length > 0 && autoResumes < MAX_AUTO_RESUMES_PER_CHAIN) {
      autoResumes++;
      drainedText = (await takePendingInput(key, id)).join('\n\n');
      if (!drainedText) return; // a concurrent take raced us empty
      mode = 'resumed';
      await updateThread(key, id, { status: 'running' }).catch(() => {});
      continue;
    }
    if (afterRun.pendingInput.length > 0) {
      logger.warn('thread-executor', 'auto-resume cap reached; steer inputs left queued', {
        id,
        key,
        queued: afterRun.pendingInput.length,
        cap: MAX_AUTO_RESUMES_PER_CHAIN,
      });
    }
    return;
  }

  function ctxOf(rec: ThreadRecord): ThreadTopicContext {
    return { chatId, threadId, topicName };
  }
}
