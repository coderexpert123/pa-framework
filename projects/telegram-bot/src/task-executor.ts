/**
 * Wave-2 executor core (topic-task handover,
 * plans/2026-09-02-topic-handover-WAVE2-SPEC.md §3.1 A.3, WP-A 2026-09-02).
 *
 * The task lane is a DEDICATED executor: dispatches never take the topic blackboard
 * lock, never touch state.turns, and never ride the human reply pipeline (no typing
 * indicator, no session resume, no delivered-store/DLQ). The running store
 * (`~/.pa/topic-tasks/<chatId>_<threadId>.running.json`) is the sole authority — the
 * FYI sends here are best-effort notifications (`sendMessageWithId` already fails to
 * `null` instead of throwing); a lost FYI loses a notification, not work.
 *
 * Consumed by main.ts (the drain rewrite + the tier-1 reply hook) and callbacks.ts
 * (the `qt:` press). Nothing in this file imports main.ts — main.ts is the composition
 * root, so every main.ts-owned behavior (card refresh) arrives as an injected callback.
 */

import { spawn } from 'child_process';
import { formatIST } from '../../../pa/dist/src/ist.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { appendTopicEvent } from '../../../pa/dist/src/lib/topic-events.js';
import { addWatchJob, type WatchInput } from '../../../pa/dist/src/lib/watch-jobs.js';
import { runWithFailover } from '../../../pa/dist/src/workers.js';
import type { CommandResult } from '../../../pa/dist/src/types.js';
import {
  TOPIC_TASK_ACTIVITY_THROTTLE_MS,
  TOPIC_TASK_MAX_ATTEMPTS,
  TOPIC_TASK_RETRY_NOT_BEFORE_MS,
  answerTask,
  attachQuestionMessage,
  completeTask,
  deferTask,
  failTask,
  findTaskByAnchorMessage,
  listRunningTasks,
  parkTask,
  recordFyiMessage,
  touchTaskActivity,
  type RunningTask,
} from '../../../pa/dist/src/lib/topic-tasks.js';
import { redactSecrets } from '../../../pa/dist/src/lib/redact.js';
import { appendKbNote } from './kb-notes.js';
import { renderOpenItems } from './context.js';
import { PA_META_PROTECTED_SKILLS, parseMetadata } from './logic.js';
import { buildTaskQuestionKeyboard } from './callbacks.js';
import { appendRefIdAndLog, type RefKind } from './ref-id.js';
import { sendMessageWithId, type InlineKeyboardMarkup } from './telegram.js';
import { topicHomeDir } from './topic-workdir.js';

/** Global claims per drain tick (SPEC §3.1 A.3) — the cold-start burst bound that
 *  paces worker spend on top of the per-topic TOPIC_TASK_SLOTS budget. */
export const TOPIC_TASK_TICK_CAP = 2;

// AI-114 (moved 2026-09-02 from main.ts — the executor lane dispatches through the
// same failover cascade): covers orphan-reaper.ts's 45-min REAP_MAX_WAIT_MS plus
// slack, so the pa-host orphan-worker-reap maintenance job (runs every minute) doesn't
// kill a worker the bot is still waiting to harvest a reply from.
export const ORPHAN_HARVEST_WINDOW_MS = 50 * 60 * 1000;

/** `<response>` cap in the completion FYI (A.3.4: trimmed to 3500 chars with a `…`). */
export const TASK_RESPONSE_CAP_CHARS = 3500;

/** Spec gap disposition (reported 2026-09-02): `TaskTopicContext` appears exactly once
 *  in the spec (line 243) and is never defined. This minimal shape is exactly what the
 *  frozen buildTaskPrompt skeleton references. */
export interface TaskTopicContext {
  chatId: number;
  threadId: number;
  topicName: string;
}

/** Default spawn cwd for `run_skill` — same formula as main.ts's BOT_CWD (duplicated
 *  rather than imported: main.ts is the composition root and must not be imported
 *  from here). */
const TASK_SPAWN_CWD = process.env.BOT_CWD || process.cwd();

/**
 * Frozen rule block for task prompts (SPEC §3.1 A.3 buildTaskPrompt skeleton):
 * markdown rules verbatim (the human-lane telegram-output bullet, split in two),
 * the task-lane confirmation override, the question-action doc (ONE adapted clause —
 * the human lane injects a press back into the topic, the task lane routes it into
 * THIS task; the verbatim human-lane sentence would ship a lying prompt), the
 * watch_job sentence and the shared-tree/claims/never-git/never-build rules verbatim
 * from context.ts's capabilities block.
 */
export const TASK_RULES = [
  '- Telegram output: write standard Markdown — **bold**, _italic_, ~~strikethrough~~, # Heading, - bullets, `code`, [text](url). The system converts to Telegram format automatically. Do NOT use raw Telegram MarkdownV2 syntax. Never add backslash escapes like \\. or \\( — the system handles all escaping.',
  '- Never use LaTeX/math syntax or delimiters (`$...$`, `$$...$$`, `\\text{}`, `\\frac{}{}`, `\\cdot`, `\\mathbf{}`, etc.) — Telegram has no LaTeX renderer. Write formulas and math using plain text or standard Unicode symbols (e.g. "P = power", "×", "Δ", "≈", "→", "²").',
  "- Do NOT ask the user to confirm before write actions that are INSIDE this task's scope — execute and report. If you need the operator to CHOOSE, use the question action.",
  "- question = you need the user to pick one of up to 4 options — the reply renders option buttons; their press is routed back to THIS task and your run resumes with the answer. text (the question, <=500 chars), options (1-4 strings, <=40 chars each).",
  '- Never promise to report back later: you are a one-shot process with no timer, so "I\'ll let you know when it finishes" never fires. If the result will land in a file or a process you can name, emit a `watch_job` PA_META action and say the watch is registered; otherwise tell the user the exact command or file that will show them the answer.',
  '- Shared working tree: other sessions, skills and agents write this repo at the same time you do.',
  '- Before editing a tracked file, run `pa claims`; if your path appears under an active reservation or in the recently-modified list, say so and pick different work rather than editing over it.',
  '- For work spanning more than one file, claim first: `pa claim <paths> --session <label> --note "<what you are doing>"`, and `pa release <id>` when you are done.',
  '- Never run `git commit`, `git push`, `git stash`, `git checkout --`, `git reset` or `git clean` yourself — commits and pushes go through the commit/push skill family, and stashing or checking out a file you do not own destroys another session\'s uncommitted work.',
  '- Never run a build or test in the repo while another one is running: `npm run build` and `npm test` take the `@build` reservation themselves and release it when they finish, so a "waiting for @build" line means another build is in flight and yours will start when it ends — that is expected, not stuck. Do not claim `@build` by hand; a manual claim collides with the one the npm script takes and stalls your own build for 15 minutes.',
].join('\n');

/**
 * The task prompt (SPEC §3.1 A.3 frozen skeleton). renderOpenItems returns a full
 * section carrying its own `## Open items (short-term)` header (or '') — embedded
 * directly so the prompt never carries a double header; when the topic has no open
 * items the section is omitted entirely. `## In-flight sibling tasks` is absent when
 * there are none.
 */
export async function buildTaskPrompt(task: RunningTask, ctx: TaskTopicContext): Promise<string> {
  const nowIst = formatIST(new Date());
  const today = nowIst.slice(0, 10);
  const clock = nowIst.slice(11, 16);
  const queuedMs = Date.parse(task.created_at);
  const queuedAt = formatIST(new Date(Number.isFinite(queuedMs) ? queuedMs : Date.now())).slice(11, 16);

  const threadLines = task.micro_thread.length > 0
    ? task.micro_thread.map((t) => `- ${t.role}: ${t.text}`).join('\n')
    : '(fresh task)';

  const openItems = await renderOpenItems(ctx.chatId, ctx.threadId).catch(() => '');

  const siblings = (await listRunningTasks(ctx.chatId, ctx.threadId).catch(() => [] as RunningTask[]))
    .filter((r) => r.id !== task.id)
    .map((r) => `- ${r.id} — ${r.title} (${r.status})`);
  const siblingsSection = siblings.length > 0
    ? `\n## In-flight sibling tasks\n${siblings.join('\n')}\n`
    : '';
  const openItemsSection = openItems ? `${openItems}\n` : '';

  return `You are executing a queued task in topic "${ctx.topicName}" (${ctx.chatId}_${ctx.threadId}).
Today is ${today}. Current time (IST): ${clock}.
Task: ${task.title}
Queued ${queuedAt} IST by ${task.created_by}. Attempt ${task.attempts}/${TOPIC_TASK_MAX_ATTEMPTS}.

## Task thread so far
${threadLines}
${openItemsSection}${siblingsSection}
## Your task
${task.prompt}

## Rules
${TASK_RULES}`;
}

/** Best-effort FYI sender — `(text, refKind, keyboard?)` pinned to one task's topic.
 *  Default impl is the real Telegram send with the ref-id footer appended. */
export type TaskFyiSender = (
  text: string,
  kind: RefKind,
  keyboard?: InlineKeyboardMarkup
) => Promise<number | null>;

export interface ExecuteTopicTaskArgs {
  task: RunningTask;
  topicCtx: TaskTopicContext;
  secrets: Record<string, string>;
  /** Accepted per the frozen signature; unused this wave — runWithFailover loads its
   *  own config (per-task model overrides are not wired). */
  config?: unknown;
  token: string;
  workdir: { dir: string };
  /** Test seam — default is the real sendMessageWithId send. */
  sendFyi?: TaskFyiSender;
  /** Test seam — default is the real runWithFailover cascade. */
  dispatch?: (prompt: string, task: RunningTask) => Promise<{ worker: string; result: CommandResult }>;
  /** Best-effort pinned-card refresh chained after every terminal state (SPEC §3.1
   *  status-card bullet: "add ONE refreshPinnedStatusCardInPlace call at the end of
   *  executeTopicTask"). Injected because task-executor must not import main.ts. */
  refreshCard?: () => Promise<void>;
}

async function refreshCardBestEffort(args: ExecuteTopicTaskArgs): Promise<void> {
  if (!args.refreshCard) return;
  try {
    await args.refreshCard();
  } catch (err) {
    logger.warn('task-executor', `card refresh failed: ${(err as Error).message}`, { id: args.task.id, chatId: args.topicCtx.chatId });
  }
}

/**
 * WP-B claim-ownership recheck (adjudicated 2026-09-03, WP-D3 follow-up): confirm
 * THIS attempt still owns the claim before anything downstream acts on the result.
 * The 30-min stale demotion can fire while the ORIGINAL worker is still alive and
 * producing (task dispatches set no timeout; worker-exec's total timeout exceeds
 * the stale window), so the record may have been re-claimed by a second attempt.
 * The superseded attempt owns nothing anymore — its late result is discarded
 * silently: no defer/fail ladder, no park, no watch_job/kb_note/run_skill side
 * effects, no duplicate completion/retry/fail FYI; the re-claimed attempt owns
 * the outcome. An ABSENT record is superseded too — something else (the
 * attempts-exhausted sweep or the current owner) already terminal-handled it.
 */
async function attemptSuperseded(args: ExecuteTopicTaskArgs, capturedClaimGen: number): Promise<boolean> {
  const { chatId, threadId } = args.topicCtx;
  const current = (await listRunningTasks(chatId, threadId).catch(() => [] as RunningTask[]))
    .find((r) => r.id === args.task.id);
  if (current !== undefined && (current.claimGen ?? 0) === capturedClaimGen) return false;
  logger.warn('task-executor', 'task-attempt-superseded', {
    id: args.task.id,
    chatId,
    capturedClaimGen,
    currentClaimGen: current?.claimGen ?? null,
  });
  return true;
}

async function sendFyiBestEffort(sendFyi: TaskFyiSender, task: RunningTask, chatId: number, text: string, kind: RefKind, keyboard?: InlineKeyboardMarkup): Promise<number | null> {
  try {
    return await sendFyi(text, kind, keyboard);
  } catch (err) {
    logger.warn('task-executor', `${kind} FYI failed: ${(err as Error).message}`, { id: task.id, chatId });
    return null;
  }
}

/** Park on a PA_META question (A.3.3): send the question FYI with the `qt:` keyboard,
 *  park the record, attach the FYI's message id as BOTH a fyi anchor and the
 *  question's anchor, emit task_parked, RETURN — no completion FYI, the record waits
 *  parked until a `qt:` press or a tier-1 reply answers it. */
async function parkOnQuestion(
  args: ExecuteTopicTaskArgs,
  sendFyi: TaskFyiSender,
  question: { text: string; options: string[] }
): Promise<void> {
  const { task, topicCtx } = args;
  const chatId = topicCtx.chatId;
  const threadId = topicCtx.threadId;
  const messageId = await sendFyiBestEffort(
    sendFyi, task, chatId,
    `❓ ${question.text}`,
    'task-question',
    buildTaskQuestionKeyboard(task.id, question.options)
  );
  await parkTask(chatId, threadId, task.id, question);
  if (messageId !== null) {
    await attachQuestionMessage(chatId, threadId, task.id, messageId).catch((err) => {
      logger.warn('task-executor', `attachQuestionMessage failed: ${(err as Error).message}`, { id: task.id, chatId });
    });
    await recordFyiMessage(chatId, threadId, task.id, messageId).catch((err) => {
      logger.warn('task-executor', `recordFyiMessage failed: ${(err as Error).message}`, { id: task.id, chatId });
    });
  }
  try {
    await appendTopicEvent(chatId, threadId, {
      kind: 'task_parked',
      ref: task.id,
      detail: question.text.slice(0, 200),
    });
  } catch (err) {
    logger.warn('task-executor', `task_parked event failed: ${(err as Error).message}`, { id: task.id, chatId });
  }
}

/**
 * Execute one claimed task end-to-end (A.3 steps 1-6). Fire-and-forget from the
 * drain — callers track the returned promise (activeTaskExecutions in main.ts) and
 * never await it on the maintenance tick.
 */
export async function executeTopicTask(args: ExecuteTopicTaskArgs): Promise<void> {
  const { task, topicCtx } = args;
  const chatId = topicCtx.chatId;
  const threadId = topicCtx.threadId;
  const sendFyi: TaskFyiSender = args.sendFyi ?? ((text, kind, keyboard) =>
    sendMessageWithId(
      args.token,
      chatId,
      appendRefIdAndLog(text, { kind, chatId, threadId }),
      threadId || undefined,
      keyboard
    ));

  // 1. Build the task prompt.
  const prompt = await buildTaskPrompt(task, topicCtx);

  // Claim identity, captured at claim time (WP-B): claimNextTask stamps
  // claimGen=1 on a fresh claim and +1 on every demotion+re-claim, so this
  // generation pins THIS attempt's ownership of the record.
  const capturedClaimGen = task.claimGen ?? 0;

  // 2. Dispatch through pa's public cascade; a worker pin rides preferredWorker.
  // WP-A activity pump (adjudicated option B, 2026-09-03): heartbeat the running
  // record while THIS dispatch is in flight, so the stale classifier sees an
  // owned, possibly-still-producing attempt and never demotes it mid-run. This
  // is a PENDING-DISPATCH heartbeat, not an output-chunk signal — executeTopicTask
  // consumes no worker stdout chunks (runWithFailover returns only the final
  // result), and under pa semantics the two are equivalent: worker-exec's idle
  // killer + maxTimer settle every dispatch promise, so "bot alive + dispatch
  // pending" implies the attempt is owned and will terminal-handle it, while a
  // dead bot's heartbeats stop and its records age out from their last real
  // activity. Strictly fewer double-run windows than chunk-gating: a
  // zero-stdout worker never re-qualifies for demotion mid-flight either.
  // Throttled inside touchTaskActivity (~10s); cleared when the dispatch
  // settles — a pump that outlived its attempt would keep stamping the store.
  const activityPump = setInterval(() => {
    void touchTaskActivity(chatId, threadId, task.id);
  }, activityPumpIntervalMs);
  let run: { worker: string; result: CommandResult };
  try {
    run = args.dispatch
      ? await args.dispatch(prompt, task)
      : await runWithFailover(prompt, {
          cwd: workdirSafe(args),
          env: args.secrets,
          resource: 'task-' + task.id,
          preferredWorker: task.worker,
          requireNonEmptyOutput: true,
          harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS,
        });
  } catch (err) {
    run = { worker: 'unknown', result: { success: false, output: '', error: (err as Error).message, exitCode: null } };
  } finally {
    clearInterval(activityPump);
  }

  // WP-B choke point (adjudicated 2026-09-03): BEFORE the failure ladder and
  // before every success-path branch — one gate covers each terminal path
  // (retry FYI, fail FYI, question park, watch_job/kb_note/run_skill side
  // effects, completion FYI) because they are all downstream of here. A
  // superseded attempt returns without error and without touching the store.
  if (await attemptSuperseded(args, capturedClaimGen)) return;

  // 5. Failure ladder (worker error / empty output).
  if (!run.result.success || run.result.output.trim() === '') {
    // Worker stderr can echo env secrets; the reason lands in the task_failed
    // event detail (at rest, rendered by `pa topic-events`) — same redaction
    // pass the completion response gets below (secret-egress rule, 2026-09-03
    // wave deep-recheck; the human lane redacts in formatWorkerReply — this
    // lane never reuses it, so it must redact here).
    const rawReason = run.result.error || (run.result.success ? 'empty output' : `worker ${run.worker} failed`);
    const reason = redactSecrets(rawReason) as string;
    if (task.attempts < TOPIC_TASK_MAX_ATTEMPTS) {
      await deferTask(chatId, threadId, task.id, Date.now() + TOPIC_TASK_RETRY_NOT_BEFORE_MS);
      await sendFyiBestEffort(sendFyi, task, chatId, `⏳ Task hit a snag — retrying automatically: ${task.title}`, 'task-retry');
    } else {
      await failTask(chatId, threadId, task.id, reason);
      await sendFyiBestEffort(sendFyi, task, chatId, `❌ Task failed after ${TOPIC_TASK_MAX_ATTEMPTS} attempts: ${task.title}`, 'task-failed');
      try {
        await appendTopicEvent(chatId, threadId, { kind: 'task_failed', ref: task.id, detail: reason });
      } catch (err) {
        logger.warn('task-executor', `task_failed event failed: ${(err as Error).message}`, { id: task.id, chatId });
      }
    }
    await refreshCardBestEffort(args);
    return;
  }

  // 3. PA_META post-dispatch — the task lane handles ONLY question / watch_job /
  //    kb_note / run_skill; everything else becomes one unavailable-action line.
  const { cleaned, meta } = parseMetadata(run.result.output);
  // Redact BEFORE the cap and the FYI build: the completion body is raw worker
  // output and this lane's only egress scrub (formatWorkerReply is deliberately
  // not reused — secret-egress rule; wave deep-recheck 2026-09-03).
  let response = redactSecrets(cleaned) as string;
  const notices: string[] = [];

  for (const action of meta?.actions ?? []) {
    if (action.type === 'question') {
      // With or without taskId; a present taskId must equal THIS task's id, else the
      // action is ignored (SPEC §3.1 A.3.3). Shape validation mirrors logic.ts's
      // human-lane rules minus its attach-competition precedence — the task lane
      // renders exactly one keyboard (the question FYI's), so confirm_required
      // cannot strand it.
      const taskId = typeof action.task_id === 'string' ? action.task_id : undefined;
      if (taskId !== undefined && taskId !== task.id) continue;
      const qText = typeof action.text === 'string' ? action.text.trim() : '';
      const rawOptions = Array.isArray(action.options) ? action.options : [];
      const options = rawOptions.filter((o): o is string => typeof o === 'string').map((o) => o.trim());
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
      // Redact the worker-authored question BEFORE it reaches the FYI, the qt:
      // keyboard labels and the running store (presses echo stored labels back).
      await parkOnQuestion(args, sendFyi, {
        text: redactSecrets(qText) as string,
        options: options.map((o) => redactSecrets(o) as string),
      });
      await refreshCardBestEffort(args);
      return;
    }
    if (action.type === 'watch_job') {
      // Same candidate shape + awaited addWatchJob wording as main.ts:2175-2187;
      // addWatchJob itself validates (main.ts has no separate pre-validation either).
      const candidate: WatchInput = {
        description: (action.description ?? '').trim(),
        check: {
          type: action.check?.type ?? '',
          path: action.check?.path,
          pattern: action.check?.pattern,
          sinceIso: action.check?.since_iso,
          pid: action.check?.pid,
        },
        intervalSeconds: action.interval_seconds,
        deadlineMinutes: action.deadline_minutes,
        source: {
          kind: 'pa_meta',
          chatId: String(chatId),
          threadId,
          refId: null,
        },
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
    if (action.type === 'kb_note') {
      // AI-101 Layer 2 — fire-and-forget (main.ts:2170-2174 precedent).
      const domain = action.domain?.trim();
      const note = action.note?.trim();
      if (domain && note && domain.length <= 100 && note.length <= 300) {
        appendKbNote(domain, note).catch(() => {});
      }
      continue;
    }
    if (action.type === 'run_skill') {
      const skillName = action.skill ?? '';
      const nameOk = /^[a-zA-Z0-9_-]+$/.test(skillName);
      if (nameOk && !PA_META_PROTECTED_SKILLS.has(skillName)) {
        // Mirror main.ts:2168's spawn shape. No --worker pin: a spawned skill is a
        // fresh dispatch on the default cascade — the task's own pin already rode
        // THIS dispatch.
        spawn('pa', ['run', skillName], {
          cwd: TASK_SPAWN_CWD,
          detached: true,
          stdio: 'ignore',
          shell: true,
          windowsHide: true,
        }).unref();
      } else {
        notices.push(`_(action 'run_skill' is not available on the task lane)_`);
      }
      continue;
    }
    notices.push(`_(action '${action.type}' is not available on the task lane)_`);
  }

  // 4. Completion FYI: `✅ Task done: <title>\n\n<response>` — parseMetadata-cleaned
  //    output capped at 3500 chars with a `…`; unavailable-action lines appended.
  const capped = response.length > TASK_RESPONSE_CAP_CHARS
    ? response.slice(0, TASK_RESPONSE_CAP_CHARS) + '…'
    : response;
  const fyiText = `✅ Task done: ${task.title}\n\n${capped}${notices.length > 0 ? `\n\n${notices.join('\n')}` : ''}`;
  const messageId = await sendFyiBestEffort(sendFyi, task, chatId, fyiText, 'task-done');
  if (messageId !== null) {
    await recordFyiMessage(chatId, threadId, task.id, messageId).catch((err) => {
      logger.warn('task-executor', `recordFyiMessage failed: ${(err as Error).message}`, { id: task.id, chatId });
    });
  }
  await completeTask(chatId, threadId, task.id);
  try {
    await appendTopicEvent(chatId, threadId, { kind: 'task_completed', ref: task.id, detail: task.title });
  } catch (err) {
    logger.warn('task-executor', `task_completed event failed: ${(err as Error).message}`, { id: task.id, chatId });
  }
  await refreshCardBestEffort(args);
}

function workdirSafe(args: ExecuteTopicTaskArgs): string {
  return args.workdir?.dir || topicHomeDir(args.topicCtx.chatId, args.topicCtx.threadId);
}

/**
 * Tier-1 reply attribution (SPEC §3.1 A.3, inserted in processUpdate BEFORE the topic
 * lock): a user reply whose `reply_to_message_id` anchors one of the topic's task FYIs
 * or its question keyboard is answered straight into the task's micro_thread — no
 * topic lock, no dispatch, nothing archived to state.turns. Returns the routed task,
 * or null when the message is not a task reply (caller falls through to normal
 * processing).
 */
export async function routeReplyToTask(args: {
  chatId: number;
  threadId: number;
  replyToMessageId?: number;
  text: string;
  sendReply: (text: string, replyToMessageId: number) => Promise<unknown>;
}): Promise<{ id: string; title: string } | null> {
  const { chatId, threadId } = args;
  if (args.text === '' || typeof args.replyToMessageId !== 'number') return null;
  const task = await findTaskByAnchorMessage(chatId, threadId, args.replyToMessageId);
  if (!task) return null;
  // A reply to a RUNNING task (pickup-FYI anchor) only feeds the in-flight run's
  // micro-thread — answerTask no longer flips it to ready (double-dispatch guard),
  // so the question_answered audit event is written only when there WAS a question.
  const wasParked = task.status === 'parked';
  await answerTask(chatId, threadId, task.id, args.text);
  await args.sendReply(
    appendRefIdAndLog(`↩️ Sent to task: ${task.title}`, { kind: 'task-route', chatId, threadId }),
    args.replyToMessageId
  );
  if (!wasParked) return { id: task.id, title: task.title };
  try {
    await appendTopicEvent(chatId, threadId, {
      kind: 'question_answered',
      ref: task.id,
      detail: args.text.slice(0, 100),
    });
  } catch (err) {
    logger.warn('task-executor', `question_answered event failed: ${(err as Error).message}`, { id: task.id, chatId });
  }
  return { id: task.id, title: task.title };
}

/** In-flight executor promises (A.3: the drain fires executeTopicTask NOT awaited;
 *  this Set keeps them referenced and gives tests a drain point). */
export const activeTaskExecutions = new Set<Promise<unknown>>();

/** Test seam (injectable-timer pattern, `_setExitForTest` precedent): the activity
 *  pump's interval period. Tests shorten it to observe heartbeats in real time —
 *  the store's ~10s write throttle cannot be shortened, so mock timers cannot see
 *  a leaked pump through it. Production never calls this. */
let activityPumpIntervalMs = TOPIC_TASK_ACTIVITY_THROTTLE_MS;
export function _setActivityPumpIntervalForTest(ms: number): void {
  activityPumpIntervalMs = ms;
}

/** Test drain point: resolves once every in-flight execution has settled. */
export async function _waitForTaskExecutionsForTest(): Promise<void> {
  while (activeTaskExecutions.size > 0) {
    await Promise.allSettled([...activeTaskExecutions]);
  }
}
