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
import { notifyAttention } from '../../../pa/dist/src/lib/attention.js';
import { runWithFailover } from '../../../pa/dist/src/workers.js';
import type { CommandResult, RunOptions, WorkerConfig } from '../../../pa/dist/src/types.js';
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
import { release as releaseTaskReservations } from '../../../pa/dist/src/lib/reservations.js';
import { appendKbNote } from './kb-notes.js';
import { renderOpenItems, renderSkillRosterSection } from './context.js';
import { PA_META_PROTECTED_SKILLS, isPrematureAsyncReply, normalizeMarkdown, parseMetadata } from './logic.js';
import { buildTaskQuestionKeyboard } from './callbacks.js';
import { appendRefIdAndLog, type RefKind } from './ref-id.js';
import { sendMessageWithId, type InlineKeyboardMarkup } from './telegram.js';
import { topicHomeDir } from './topic-workdir.js';
import { loadTopicState } from './conversation.js';
import type { ConversationState } from './types.js';
import { renderTopicSourcesSection } from './sources.js';
import { renderTopicPointerLines, renderReservationsBlock } from './topic-pointers.js';
// WP-7: task-executor → dispatch → task-executor (ORPHAN_HARVEST_WINDOW_MS) is a
// deferred-read cycle — every cross-use happens inside function bodies, never at
// module top level (the scheduler↔catchup invariant from the root brain).
import { buildTopicTierExtraArgs, buildWorkerProvenanceEnv } from './dispatch.js';

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
  '- Browser tools (Playwright MCP) are available in this headless session but join the toolset 1-3 rounds after start: when the task needs browser interaction or visual verification, call `WaitForMcpServers` first and wait — never fall back or report the tools missing. If a `wingman_do` tool is listed, you may hand it one bounded step on the page that is already open (pick a row, fill a form from values you pass, click through a wizard); Playwright MCP stays the default, and `needs_confirmation` means ask the operator before acting.',
  '- If a page blocks the task (captcha, login, consent wall): screenshot it, run `python3 <repo>/projects/voice-inbox/scripts/task_blocker_ask.py --task <task_id> --screenshot <path> --prompt "<plain-language question>" || python <repo>/projects/voice-inbox/scripts/task_blocker_ask.py --task <task_id> --screenshot <path> --prompt "<plain-language question>"` (add `--options "a|b|c"` for choices) and END your turn — the operator answers the question in their inbox, and your next dispatch opens with the answer pointer; read the answer from that file, continue from where you stopped, and finish with task_complete.py.',
  '- For browser work the worker drives PA’s Chrome (endpoint env is already injected): before the first browser action run `pa browser ensure --headed` when the task may need the operator (credentials, payments, posting — anything a human might have to take over) or `pa browser ensure --headless` for pure read-only work. To let the operator watch the page you are on (payment, login, OTP, or anything you want watched), run `node <repo>/projects/voice-inbox/scripts/screencast_bridge.mjs --task <task_id>` in the background and continue your turn; it streams the live screen to the inbox. Stop it (kill the process) when the operator no longer needs to watch. Use it alongside task_blocker_ask.py when you escalate a page you cannot control. The operator can also take over the page in fullscreen (tap, type, scroll, navigate) from the voice-inbox live view — input is enabled only in fullscreen. If the operator takes over the page themselves (a resume note may say so, or the page changes without your action), pause page-driving and re-read the live page state before your next action — do not race operator input.',
  "- Do NOT ask the user to confirm before write actions that are INSIDE this task's scope — execute and report. If you need the operator to CHOOSE, use the question action.",
  "- question = you need the user to pick one of up to 4 options — the reply renders option buttons; their press is routed back to THIS task and your run resumes with the answer. text (the question, <=500 chars), options (1-4 strings, <=40 chars each).",
  "- Next-actions block: when your reply leaves any step outstanding — including a finding, risk, or incomplete item your own work surfaced that nobody has acted on yet, even if you were not asked to act on it and even if your own task is otherwise done — end it with the literal line NEXT ACTIONS, then one numbered line per outstanding step in execution order, each tagged You or Assistant so the next actor is explicit. Every next step named in the reply appears in the block, and the block contains nothing that is not a real step; an Assistant step must be concretely queued or part of a confirmed plan, never a vague promise. When a write action awaits confirmation, the final numbered item is the existing yes-or-no confirmation sentence and it stays the reply's last line. Omit the block only for a plain answer or a task that finished with nothing left to decide. The block is the last visible text, after any Details heading and before any machine footer line.",
  '- Post a progress update when you complete each meaningful sub-step of a long task: run `python3 <repo>/projects/voice-inbox/scripts/task_telemetry.py --event task.progress --task <task_id> --step "<short plain-language phrase>" || python <repo>/projects/voice-inbox/scripts/task_telemetry.py --event task.progress --task <task_id> --step "<short plain-language phrase>"` — the inbox shows the operator what you are doing live while you work.',
  '- Voice-inbox task closures: the --summary you pass task_complete.py to close a voice-inbox task is the OUTCOME for the operator — plain language stating what was asked and what resulted. Never the command output, a routing receipt, or a transcript re-paste (2+ sentences quoted verbatim from the request) — those are process, not the answer; the script refuses receipts and exits non-zero, so re-run with a real plain-language summary. When the answer is long, also pass --short with the plain-words standalone answer the card leads with (IN SHORT) — as long as it needs, never capped; --recap and --next each take one line saying where things stand and what the operator must do next.',
  '- When an answer benefits from structure — comparisons, steps, choices, small data sets, or a decision the user must make — build it from the rich shapes the inbox renders (cards, tiered short/full answers, forms with steps, lists, tables) instead of prose walls. The full answer reads in plain product language — no ids, schemas, exit codes, or technical terms (the answer register); the short version is the readable one-liner a busy person gets first. Reach for the visual form whenever a wall of text would be the alternative, and if no existing shape fits the answer, generate the raw-HTML shape freely — the inbox renders it in a sandboxed frame, so you have complete freedom over form; recurring patterns graduate into the standard components.',
  '- Never promise to report back later: you are a one-shot process with no timer, so "I\'ll let you know when it finishes" never fires. If the result will land in a file or a process you can name, emit a `watch_job` PA_META action and say the watch is registered; otherwise tell the user the exact command or file that will show them the answer.',
  '- Never promise future action in words alone: if work must continue after your turn, register it in a mechanism — spawn the next stage now as a dependent thread (`depends_on`, it wakes with your result), or register a `watch_job` for the trigger — a promise without a mechanism is a dropped promise.',
  '- Machine actions ride the PA_META envelope: to emit one, end your reply with a single final line [PA_META]: {"actions":[...]} — single-line JSON, nothing after it. The question action above is {"type":"question","text":"...","options":["..."]}. A thread lane accepts question, confirm_required and watch_job{description,check,deadline_minutes} (check is a required object, e.g. {"type":"file_newer_than","path":"C:/abs/path"}); a task lane accepts question and watch_job plus kb_note{domain,note} and run_skill{skill} — an unsupported type comes back as a rejection notice, never a silently dropped action. Omit the envelope otherwise.',
  '- Cross-topic delivery goes through the sanctioned path only: run `pa notify --topic-thread <id>` and file the topic note it asks for. NEVER call the Telegram Bot API directly — no api.telegram.org calls, no sendMessage, no bot-token fetches; no scratch scripts, no curl, no SDK. Raw sends bypass ref-minting, app logging, and the target topic\'s queue/history (the target never sees them as updates).',
  '- Page the operator when only they can unblock you: `pa ping`. Deliver into another topic: `pa notify --topic-thread <id>`. Register a completion watch: `pa watch add`. Queue follow-up work: `pa topic-task add <chatId>_<threadId> --title "<t>" --prompt "<p>"`. `_Ref:` lookup: `pa ref <id>`. Platform looks broken: `pa health`, then `pa doctor`.',
  '- Shared working tree: other sessions, skills and agents write this repo at the same time you do.',
  '- Before editing a tracked file, run `pa claims`; if your path appears under an active reservation or in the recently-modified list, say so and pick different work rather than editing over it.',
  '- For work spanning more than one file, claim first: `pa claim <paths> --session <label> --note "<what you are doing>"`, and `pa release <id>` when you are done.',
  '- Never run `git commit`, `git push`, `git stash`, `git checkout --`, `git reset` or `git clean` yourself — commits and pushes go through the commit/push skill family, and stashing or checking out a file you do not own destroys another session\'s uncommitted work.',
  '- Never run a build or test in the repo while another one is running: `npm run build` and `npm test` take the `@build` reservation themselves and release it when they finish, so a "waiting for @build" line means another build is in flight and yours will start when it ends — that is expected, not stuck. Do not claim `@build` by hand; a manual claim collides with the one the npm script takes and stalls your own build for 15 minutes.',
].join('\n');

/** The PA_META action types each executor lane accepts — the single source the
 *  envelope bullet's lane clause is derived from AND the invariant test's
 *  oracle (context.test.ts rebuilds the clause from these arrays; adding a type
 *  to a lane without teaching the bullet fails the invariant). */
export const THREAD_LANE_PA_META_TYPES = ['question', 'confirm_required', 'watch_job'] as const;
export const TASK_LANE_PA_META_TYPES = ['question', 'watch_job', 'kb_note', 'run_skill'] as const;

/**
 * The task prompt (SPEC §3.1 A.3 frozen skeleton). renderOpenItems returns a full
 * section carrying its own `## Open items (short-term)` header (or '') — embedded
 * directly so the prompt never carries a double header; when the topic has no open
 * items the section is omitted entirely. `## In-flight sibling tasks` is absent when
 * there are none.
 */
export async function buildTaskPrompt(
  task: RunningTask,
  ctx: TaskTopicContext,
  preloadedState?: ConversationState | null,
): Promise<string> {
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

  // Dynamic per-topic sections (topic-pointers.ts: brain/recall/decisions
  // pointers + sources.ts ## Topic sources + ## Live reservations + the live
  // skill roster — this lane's envelope offers run_skill) land after open
  // items/siblings with one blank line of separation, before ## Your task —
  // the task lane must see the same coordination/retrieval hints the human
  // lane gets. Fail-silent; absent ⇒ byte-identical skeleton.
  // WP-7: the caller may preload the topic state (one load per dispatch shared
  // with the executor's tunable wiring); absent ⇒ load here as before.
  const topicState = preloadedState !== undefined
    ? preloadedState
    : await loadTopicState(ctx.chatId, ctx.threadId).catch(() => null);
  const [pointers, reservations, sourcesSection, skillRosterSection] = await Promise.all([
    renderTopicPointerLines({ chatId: ctx.chatId, threadId: ctx.threadId }, 'task').catch(() => null),
    renderReservationsBlock().catch(() => ''),
    topicState ? renderTopicSourcesSection(topicState).catch(() => '') : Promise.resolve(''),
    renderSkillRosterSection().catch(() => ''),
  ]);
  const pointersBlock = pointers
    ? `${pointers.brain}${pointers.recall}${pointers.decisions}`.replace(/^\n/, '')
    : '';
  const insertSection = [pointersBlock, sourcesSection.replace(/^\n+/, '').replace(/\n+$/, ''), reservations.replace(/^\n/, ''), skillRosterSection.replace(/^\n+/, '').replace(/\n+$/, '')]
    .filter(Boolean)
    .join('\n\n');

  return `You are executing a queued task in topic "${ctx.topicName}" (${ctx.chatId}_${ctx.threadId}).
Today is ${today}. Current time (IST): ${clock}.
Task: ${task.title}
Queued ${queuedAt} IST by ${task.created_by}. Attempt ${task.attempts}/${TOPIC_TASK_MAX_ATTEMPTS}.

## Task thread so far
${threadLines}
${openItemsSection}${siblingsSection}${insertSection ? `\n${insertSection}\n` : ''}
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
  token: string;
  workdir: { dir: string };
  /** Test seam — default is the real sendMessageWithId send. */
  sendFyi?: TaskFyiSender;
  /** Test seam — default is the real runWithFailover cascade. */
  dispatch?: (prompt: string, task: RunningTask) => Promise<{ worker: string; result: CommandResult }>;
  /** Test seam (WP-7): observe the real RunOptions the executor would hand
   *  runWithFailover — the (prompt, task) dispatch seam never sees them, so
   *  tunable/model wiring is otherwise invisible to tests. */
  captureOpts?: (opts: RunOptions) => void;
  /** Best-effort pinned-card refresh chained after every terminal state (SPEC §3.1
   *  status-card bullet: "add ONE refreshPinnedStatusCardInPlace call at the end of
   *  executeTopicTask"). Injected because task-executor must not import main.ts. */
  refreshCard?: () => Promise<void>;
  /** Attention seam (2026-09-11, vi-6018671b5f37): fired on question-park,
   *  completion and terminal failure. Default is pa's notifyAttention (Windows
   *  toast + operator private-chat mirror — the group is muted, the FYI alone
   *  never reached anyone). Tests inject a recorder; the default gates itself
   *  off under PA_NOTIFY_DISABLED=1 (the bot test suite's global default). */
  attention?: (subject: string, body: string) => Promise<void>;
}

/** Default attention impl — a question/completion/failure is exactly the
 *  "action needed" / "response ready" event the attention channel exists for. */
function defaultAttention(subject: string, body: string): Promise<void> {
  return notifyAttention(subject, body).then(() => undefined);
}

/** Best-effort attention — never throws into the terminal-state path; a lost
 *  page loses a notification, not the terminal transition itself. */
async function attentionBestEffort(
  attention: (subject: string, body: string) => Promise<void>,
  task: RunningTask,
  chatId: number,
  subject: string,
  body: string,
): Promise<void> {
  try {
    await attention(subject, body);
  } catch (err) {
    logger.warn('task-executor', `attention failed: ${(err as Error).message}`, { id: task.id, chatId });
  }
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
  // The task cannot proceed without the operator — page them (2026-09-11).
  await attentionBestEffort(
    args.attention ?? defaultAttention,
    task, chatId,
    `Question — ${task.title}`,
    question.text,
  );
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

  // WP-7 (OD-4): one topic-state load per dispatch — serves buildTaskPrompt's
  // sources section AND the topic-tier tunables on the dispatch below.
  const topicState = await loadTopicState(chatId, threadId).catch(() => null);
  const topicDefaults = topicState?.tunable_defaults;

  // 1. Build the task prompt.
  const prompt = await buildTaskPrompt(task, topicCtx, topicState);

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
    const dispatchOpts: RunOptions = {
      cwd: workdirSafe(args),
      // env carries ONLY the secrets bag — runWithFailover replaces it with
      // the hop's secret_allowlist-filtered subset, which drops every
      // non-allowlisted key. Every worker in production is allowlisted, so a
      // non-secret key placed here (PA_TASK_ID was, until 2026-09-18) never
      // reaches the child; non-secret dispatch env must ride getEnv instead.
      env: { ...args.secrets },
      // AI-255 B4 + WS3 provenance (2026-09-18, per-hop): getEnv is evaluated
      // by worker-exec with EACH failover hop's own WorkerConfig and merges
      // AFTER the allowlist filter, so these keys reach allowlisted workers.
      // PA_TASK_ID lets a worker's `pa claim` auto-tag taskId — terminal
      // transitions below then release those reservations even if the
      // dispatch-level release never ran; the PA_WORKER_* provenance keys
      // stamp the worker that actually answered into the ledger.
      getEnv: (w: WorkerConfig) => ({
        PA_TASK_ID: task.id,
        ...buildWorkerProvenanceEnv({ worker: w, topicDefaults, recordModel: task.model }),
      }),
      resource: 'task-' + task.id,
      preferredWorker: task.worker,
      requireNonEmptyOutput: true,
      harvestWindowMs: ORPHAN_HARVEST_WINDOW_MS,
      // WP-7 (OD-4): topic-tier tunable_defaults + the record's model pin
      // compose per-hop via getExtraArgs (per-worker slice — the 2026-09-11
      // exhaustion class). Nothing set ⇒ key absent ⇒ byte-identical opts.
      ...(topicDefaults || task.model ? {
        getExtraArgs: (w: WorkerConfig) => buildTopicTierExtraArgs(topicDefaults, task.model, w),
      } : {}),
    };
    args.captureOpts?.(dispatchOpts);
    run = args.dispatch
      ? await args.dispatch(prompt, task)
      : await runWithFailover(prompt, dispatchOpts);
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
  // AI-202 sixth delivery site (2026-09-04 deep-recheck finding 1): parse BEFORE
  // the failure check so a contentless "launched, waiting" promise — a task
  // worker that backgrounded its work and exited 0 — rides the SAME retry/fail
  // ladder as an empty output instead of shipping as the completion FYI. Gate
  // mirrors main.ts's isPrematureAsyncReply wiring on meta === null (the
  // sanctioned promise + watch_job PA_META shape is never suppressed); the task
  // lane has no pendingDesc, so that half of main.ts's gate does not apply.
  const { cleaned, meta } = parseMetadata(run.result.output);
  const premature = meta === null && isPrematureAsyncReply(cleaned);
  if (!run.result.success || run.result.output.trim() === '' || premature) {
    if (premature) {
      logger.warn('task-executor', 'premature-async-reply suppressed into retry ladder', { id: task.id, chatId, chars: cleaned.length, excerpt: cleaned.slice(0, 120) });
    }
    // Worker stderr can echo env secrets; the reason lands in the task_failed
    // event detail (at rest, rendered by `pa topic-events`) — same redaction
    // pass the completion response gets below (secret-egress rule, 2026-09-03
    // wave deep-recheck; the human lane redacts in formatWorkerReply — this
    // lane never reuses it, so it must redact here).
    const rawReason = run.result.error
      || (!run.result.success ? `worker ${run.worker} failed`
        : premature ? 'premature async reply (contentless launched/waiting promise)'
        : 'empty output');
    const reason = redactSecrets(rawReason) as string;
    if (task.attempts < TOPIC_TASK_MAX_ATTEMPTS) {
      await deferTask(chatId, threadId, task.id, Date.now() + TOPIC_TASK_RETRY_NOT_BEFORE_MS);
      await sendFyiBestEffort(sendFyi, task, chatId, `⏳ Task hit a snag — retrying automatically: ${task.title}`, 'task-retry');
    } else {
      await failTask(chatId, threadId, task.id, reason);
      // AI-255 B4: terminal — release this task's reservations. Awaited but
      // .catch-swallowed: a ~10ms store write, so the FYI ladder isn't
      // stalled, and a fire-and-forget write would race callers that tear
      // down PA_HOME right after this returns.
      await releaseTaskReservations({ taskId: task.id }).catch((err) =>
        logger.warn('task-executor', `taskId reservation release failed: ${(err as Error).message}`, { id: task.id, chatId }));
      await sendFyiBestEffort(sendFyi, task, chatId, `❌ Task failed after ${TOPIC_TASK_MAX_ATTEMPTS} attempts: ${task.title}`, 'task-failed');
      try {
        await appendTopicEvent(chatId, threadId, { kind: 'task_failed', ref: task.id, detail: reason });
      } catch (err) {
        logger.warn('task-executor', `task_failed event failed: ${(err as Error).message}`, { id: task.id, chatId });
      }
      // Terminal failure needs operator attention (retry or requeue decision).
      await attentionBestEffort(
        args.attention ?? defaultAttention,
        task, chatId,
        `Task failed — ${task.title}`,
        reason,
      );
    }
    await refreshCardBestEffort(args);
    return;
  }

  // 3. PA_META post-dispatch — the task lane handles ONLY question / watch_job /
  //    kb_note / run_skill; everything else becomes one unavailable-action line.
  // (parseMetadata ran above the failure check so the AI-202 premature-reply
  // guard can gate on meta — see the sixth-site comment there.)
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
        // THIS dispatch. WB-304: error listener so a missing `pa` is never invisible.
        spawn('pa', ['run', skillName], {
          cwd: TASK_SPAWN_CWD,
          detached: true,
          stdio: 'ignore',
          shell: true,
          windowsHide: true,
        })
          .on('error', (err) => {
            logger.warn('task-executor', `fire-and-forget spawn failed: ${(err as Error).message}`, { skill: skillName });
          })
          .unref();
      } else {
        notices.push(`_(action 'run_skill' is not available on the task lane)_`);
      }
      continue;
    }
    notices.push(`_(action '${action.type}' is not available on the task lane)_`);
  }

  // 4. Completion FYI: `✅ Task done: <title>\n\n<response>` — parseMetadata-cleaned
  //    output run through `normalizeMarkdown` first (same pipeline as the human
  //    lane's `buildWorkerResponse`; topic 310 / 2026-09-04) then capped at 3500
  //    chars with a `…`; unavailable-action lines appended.
  const normalized = normalizeMarkdown(response);
  const capped = normalized.length > TASK_RESPONSE_CAP_CHARS
    ? normalized.slice(0, TASK_RESPONSE_CAP_CHARS) + '…'
    : normalized;
  const fyiText = `✅ Task done: ${task.title}\n\n${capped}${notices.length > 0 ? `\n\n${notices.join('\n')}` : ''}`;
  const messageId = await sendFyiBestEffort(sendFyi, task, chatId, fyiText, 'task-done');
  if (messageId !== null) {
    await recordFyiMessage(chatId, threadId, task.id, messageId).catch((err) => {
      logger.warn('task-executor', `recordFyiMessage failed: ${(err as Error).message}`, { id: task.id, chatId });
    });
  }
  await completeTask(chatId, threadId, task.id);
  // AI-255 B4: terminal — release this task's reservations (same contract as
  // the fail path above: awaited, failure-swallowed, ~10ms).
  await releaseTaskReservations({ taskId: task.id }).catch((err) =>
    logger.warn('task-executor', `taskId reservation release failed: ${(err as Error).message}`, { id: task.id, chatId }));
  try {
    await appendTopicEvent(chatId, threadId, { kind: 'task_completed', ref: task.id, detail: task.title });
  } catch (err) {
    logger.warn('task-executor', `task_completed event failed: ${(err as Error).message}`, { id: task.id, chatId });
  }
  // Response-ready page (2026-09-11): the FYI above sits in a muted group —
  // the mirror is what actually reaches the operator.
  await attentionBestEffort(
    args.attention ?? defaultAttention,
    task, chatId,
    `Task done — ${task.title}`,
    capped,
  );
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
