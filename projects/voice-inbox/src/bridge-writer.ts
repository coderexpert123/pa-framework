/**
 * Route-queue writer (AI-201 WP-B, §7) — the app-side half of the one shared
 * cross-process channel between this server and the bot's drain (WP-D).
 *
 * `~/.pa/voice-inbox/route-queue.jsonl`, one JSON object per line, exact §7
 * shape and key order:
 *
 *   {"q_id":"rq-<12hex>","ts":"<iso-z>","task_id":"vi-<12hex>","tenant_id":"t-<userid>",
 *     "chat_id":-1001234567890,"thread_id":1040,"text":"<injection text>","ref_id":"s-<12hex>"}
 *
 * Writers: this module (task creation → inbox entry; API reroute → target
 * entry) and `route_task.py` (worker decision → target entry). Two writers,
 * one file: appends are guarded by proper-lockfile (the bot's own jsonl
 * appenders use the same guard). Consumer: the bot's drain — reads all
 * lines, injects each, then rewrites the file without the consumed lines
 * (consume-after-inject; crash window = re-injection on restart, accepted).
 */

import lockfile from 'proper-lockfile';
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

/** One route-queue line, fields in the frozen prefix order (the byte-shape
 * test pins this). The optional tail is the route-queue contract v4 (§4 of
 * the WP-5 spec): appended after `ref_id`, omitted entirely (never null)
 * when not supplied. `kind`/`worker_resource`/`worker_dispatch_id` (cancel)
 * and `steer_mode`/`steer_conversation` (steer, cancel's sibling verb) are
 * written by this module too, from `answer-resume.ts`'s `answerAndResume`
 * (the auth-broker answer-resume steer, Phase A) — `route_task.py` remains
 * the other steer writer (worker decisions). See CONTRACTS.md's "written by"
 * table (C9) for the full two-writer detail. */
export interface RouteQueueEntry {
  q_id: string; // 'rq-<12 hex>'
  ts: string; // ISO-8601 Z
  task_id: string;
  tenant_id: string;
  chat_id: number;
  thread_id: number;
  text: string;
  ref_id: string; // 's-<12 hex>' — minted by the writer
  kind?: 'cancel' | 'steer';
  worker_resource?: string;
  worker_dispatch_id?: string;
  steer_mode?: 'queue' | 'interrupt';
  steer_conversation?: string;
}

export interface TopicRef {
  key: string; // '<chatId>_<threadId>'
  label: string;
}

export function mintQueueId(): string {
  return `rq-${randomBytes(6).toString('hex')}`;
}

/**
 * Ensure the queue file exists before locking (proper-lockfile needs an
 * existing target). Plain append-mode create — a concurrent creator racing
 * here is harmless: 'a' never truncates.
 */
function ensureQueueFile(queuePath: string): void {
  if (existsSync(queuePath)) return;
  mkdirSync(dirname(queuePath), { recursive: true });
  const fd = openSync(queuePath, 'a');
  closeSync(fd);
}

/**
 * In-process promise mutex per queue path — the same fix pa/src/lib carries
 * three times (archive-files.ts's withRotationMutex, reservations.ts's
 * mutateQueue, topic-tasks.ts's withTopicTaskLock), duplicated here because
 * this package shares no module with pa. Same-process callers serialize
 * BEFORE ever touching proper-lockfile, whose mkdir + retry/backoff is built
 * for cross-process contention: N same-process racers each burn their retry
 * budget against their own siblings' holds and surface ELOCKED
 * ('Lock file is already being held') the moment the disk is slow — AI-237,
 * the full-suite 'concurrent appends' flake (3 of 5 runs 2026-09-13; scoped
 * runs never contended enough to exhaust the budget).
 */
const appendMutexes: Map<string, Promise<void>> = new Map();

async function withAppendMutex<T>(queuePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = appendMutexes.get(queuePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  appendMutexes.set(queuePath, current);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    if (appendMutexes.get(queuePath) === current) {
      appendMutexes.delete(queuePath);
    }
    release();
  }
}

/**
 * Append one route entry under a proper-lockfile mutex. Mints `q_id`, `ts`
 * and `ref_id` here so every line carries a fresh ref-ID (§5: every writer
 * mints its own).
 */
export async function appendRouteEntry(
  queuePath: string,
  input: {
    taskId: string;
    tenantId: string;
    chatId: number;
    threadId: number;
    text: string;
    kind?: 'cancel' | 'steer';
    workerResource?: string;
    workerDispatchId?: string;
    steerMode?: 'queue' | 'interrupt';
    steerConversation?: string;
  }
): Promise<RouteQueueEntry> {
  const entry: RouteQueueEntry = {
    q_id: mintQueueId(),
    ts: new Date().toISOString(),
    task_id: input.taskId,
    tenant_id: input.tenantId,
    chat_id: input.chatId,
    thread_id: input.threadId,
    text: input.text,
    ref_id: `s-${randomBytes(6).toString('hex')}`,
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.workerResource !== undefined ? { worker_resource: input.workerResource } : {}),
    ...(input.workerDispatchId !== undefined ? { worker_dispatch_id: input.workerDispatchId } : {}),
    ...(input.steerMode !== undefined ? { steer_mode: input.steerMode } : {}),
    ...(input.steerConversation !== undefined ? { steer_conversation: input.steerConversation } : {}),
  };
  return withAppendMutex(queuePath, async () => {
    ensureQueueFile(queuePath);
    const release = await lockfile.lock(queuePath, {
      stale: 5_000,
      // Cross-process budget only now — same-process contenders queue on the
      // mutex above and never race this mkdir. Raised from 5 (~1.25s of
      // backoff) so a real cross-process holder (route_task.py mid-append) on
      // a starved disk doesn't exhaust it.
      retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
      // Never throw from here: proper-lockfile invokes onCompromised inside an
      // mtime-refresh timer callback, where a throw is an uncaught exception
      // that kills this long-lived server process — pa's safe-lock.ts policy
      // (AI-096), duplicated because this package shares no module with pa.
      // The critical section is a single appendFileSync; logging and
      // continuing unsynchronized beats process death.
      onCompromised: (err: Error) => {
        console.error(
          `[bridge-writer] route-queue lock compromised, continuing unsynchronized: ${err.message}`
        );
      },
    });
    try {
      appendFileSync(queuePath, `${JSON.stringify(entry)}\n`, 'utf8');
    } finally {
      await release();
    }
    return entry;
  });
}

// --- Injection texts (§7 verbatim wording; <repo> resolved at runtime) --------

/** One recent conversation offered to the routing worker as a possible
 * continuation target: the root task id and its snippet —
 * `<60-char request> (updated <age>) [<status word>]` (ledger.ts
 * listOpenConversations, v14). */
export interface ConversationRef {
  taskId: string;
  snippet: string;
}

/** The conversation a task is KNOWN to continue (the explicit `continues`
 * create path) — the worker is told the decision, never offered a menu. */
export interface ContinuationRef {
  conversationId: string;
  topicKey: string | null;
}

export interface FeedbackRef {
  about: string; // 'vi-<12 hex>' — the stored feedback_about value
  title: string | null; // conversation_meta.title of the resolved conversation
  level: 'conversation' | 'task';
  /** t-3 (2026-09-18): the conversation `about` actually lives in — equal to
   *  `about` at 'conversation' level, the containing conversation's root id
   *  at 'task' level. The client's origin-banner link target: `about` alone
   *  is not navigable when level is 'task' (it names a non-root task). */
  conversationId: string;
}

const FEEDBACK_TITLE_MAX = 60; // mirror of ledger.ts CONVERSATION_TITLE_MAX

export function buildFeedbackFraming(ref: FeedbackRef): string {
  const target = ref.level === 'task' ? 'task' : 'conversation';
  const title = ref.title === null
    ? ''
    : ref.title.replace(/\s+/g, ' ').trim().replace(/"/g, "'").slice(0, FEEDBACK_TITLE_MAX);
  if (title.length === 0) return `(operator feedback about voice-inbox ${target} ${ref.about})`;
  return `(operator feedback about voice-inbox ${target} ${ref.about}, "${title}")`;
}

/** Character budget for the recent-conversations offer LIST — the `;`-joined
 * entries, head and instruction sentences excluded (thread lifecycle,
 * 2026-09-17). The inbox texts carry no length cap of their own (the bot
 * injects plain inbox entries verbatim; STEER_MESSAGE_MAX gates only steer
 * entries), so this bound keeps a busy day's 24-hour offer from growing the
 * routing prompt without limit. An entry is at most ~115 chars with its
 * separator, so 34 maximum-length entries fit; the busiest 24 h measured in the
 * ledger held 44 threads. */
export const OFFER_LIST_MAX_CHARS = 4000;

/** The offer segment's head — exported so tests assert its presence or
 *  absence against the real text. */
export const OFFER_SEGMENT_HEAD = 'Recent conversations (last 24 hours, newest first): ';

/** Renders the recent-conversations offer, or '' when there is nothing to
 * offer. Whole entries fill newest first under OFFER_LIST_MAX_CHARS; the first
 * entry that would cross the budget stops the fill, and the rest are counted.
 * Mutually exclusive with continuationSegment (§4 of the redesign spec): once
 * the conversation is decided the worker gets no offer. */
function conversationsSegment(open: readonly ConversationRef[]): string {
  if (open.length === 0) return '';
  let list = '';
  let included = 0;
  for (const c of open) {
    const entry = `${c.taskId}=${c.snippet}`;
    const next = list === '' ? entry : `${list};${entry}`;
    if (next.length > OFFER_LIST_MAX_CHARS) break;
    list = next;
    included += 1;
  }
  if (included === 0) return '';
  const omitted = open.length - included;
  return (
    `${OFFER_SEGMENT_HEAD}${list}. ` +
    (omitted > 0
      ? `(and ${omitted} more recent conversation${omitted === 1 ? ' is' : 's are'} not listed) `
      : '') +
    `If this request clearly continues one of them, add --continues <that conversation id> ` +
    `to the route_task.py command; otherwise omit the flag. ` +
    `A conversation marked [Cancelled] is context only: never pass --continues for it. ` +
    `When unsure, omit --continues so the request starts a new conversation. `
  );
}

/** Renders the known-continuation instruction segment, or '' when the task
 * is not an explicit continuation. */
function continuationSegment(c: ContinuationRef | undefined): string {
  if (c === undefined) return '';
  if (c.topicKey !== null) {
    return (
      `This task continues conversation ${c.conversationId}. Route it to topic ${c.topicKey} — ` +
      `pass --topic ${c.topicKey} --continues ${c.conversationId} to route_task.py and pick no other topic. `
    );
  }
  return `This task continues conversation ${c.conversationId} — pass --continues ${c.conversationId} to route_task.py. `;
}

/**
 * The inbox entry's injection text: asks the receiving worker to pick the
 * best topic for the request and route the task there. `<chatId>_<threadId>`
 * and `<one line>` are placeholders the WORKER fills; the Topics: segment is
 * the real topic list read from `~/.pa/telegram-topic-names.json`.
 */
export function buildInboxInjectionText(input: {
  taskId: string;
  requestText: string;
  topics: TopicRef[];
  repoRoot: string;
  openConversations?: ConversationRef[];
  continuation?: ContinuationRef;
  conversationBriefing?: string;
  attachments?: readonly string[];
  feedback?: FeedbackRef;
}): string {
  const topics = input.topics.map((t) => `${t.key}=${t.label}`).join(';');
  const script = joinPath(input.repoRoot, 'projects', 'voice-inbox', 'scripts', 'route_task.py');
  const feedbackFraming = input.feedback === undefined ? '' : buildFeedbackFraming(input.feedback) + ' ';
  return (
    `[Voice inbox task ${input.taskId}] ${feedbackFraming}Request: ${input.requestText}. ` +
    (input.attachments === undefined ? '' : buildAttachmentsSegment(input.attachments)) +
    `Pick the best topic for it and run: python "${script}" --task ${input.taskId} ` +
    `--topic <chatId>_<threadId> --reason "<one line>" --title "<short noun phrase naming what this is about, at most 60 characters>". Topics: ${topics}. ` +
    `Routing is mandatory before you end this turn: call route_task.py before posting any task_telemetry.py progress update, and post no progress until the task is routed. ` +
    `If you are unsure where to route, use the default topic. Never end the turn without route_task.py succeeding. ` +
    continuationSegment(input.continuation) +
    (input.continuation === undefined ? conversationsSegment(input.openConversations ?? []) : '') +
    (input.conversationBriefing ?? '') +
    `This task arrives from the voice-inbox app (our own PWA, fully ours — long-press menus, custom sheets and inline widgets all possible); design UI answers for that surface, not Telegram's Bot-API constraints. ` +
    `Do not answer the request here; do not ask the operator anything here. ` +
    `Route it and stop — do not close the asking task: never run task_complete.py for it. ` +
    `It stays open until the destination topic's work completes the same task with the real answer ` +
    `(a deterministic fallback re-routes it and pages the operator if no worker picks the route up). ` +
    `The operator's conversation must end with the answer, never a routing receipt.`
  );
}

/**
 * The inbox entry's injection text for a VOICE task. Since 2026-09-16 the
 * recording is transcribed by the deterministic path (the telegram bot's
 * poll-tick drain, backstopped by the pa fallback job), and the bot's route
 * drain holds this entry until the transcript lands. The routing worker reads
 * the transcript with task_request.py show, may tidy the displayed request with
 * task_request.py clean (cleanup, never authorship; best-effort), then routes.
 * It never transcribes. This text carries no secrets, only the audio path and
 * the commands.
 */
export function buildVoiceInboxInjectionText(input: {
  taskId: string;
  audioPath: string; // absolute; rendered with forward slashes
  topics: TopicRef[];
  repoRoot: string;
  openConversations?: ConversationRef[];
  continuation?: ContinuationRef;
  conversationBriefing?: string;
  attachments?: readonly string[];
  feedback?: FeedbackRef;
}): string {
  const topics = input.topics.map((t) => `${t.key}=${t.label}`).join(';');
  const audio = input.audioPath.replace(/\\/g, '/');
  const scripts = joinPath(input.repoRoot, 'projects', 'voice-inbox', 'scripts');
  const feedbackFraming = input.feedback === undefined ? '' : buildFeedbackFraming(input.feedback) + ' ';
  return (
    `[Voice inbox task ${input.taskId}] ${feedbackFraming}A voice recording is saved at ${audio}. ` +
    (input.attachments === undefined ? '' : buildAttachmentsSegment(input.attachments)) +
    `It is transcribed automatically before this message reaches you — never transcribe it yourself and never run task_transcribe.py. ` +
    `First read what was said: python "${joinPath(scripts, 'task_request.py')}" show --task ${input.taskId} ` +
    `(one JSON line with state, transcript and request_text). ` +
    `If state is not received, stop here — do not route it, answer it or close it; the app already handles a recording that is still transcribing, failed or already placed. ` +
    `Then tidy the request for display: python "${joinPath(scripts, 'task_request.py')}" clean --task ${input.taskId} --text "<cleaned request>" — ` +
    `cleanup, never authorship: drop filler words, false starts and repeats, fix words the transcription plainly misheard, ` +
    `and replace pronouns such as it or that with what they refer to in the conversation history in this message; ` +
    `never add intent, never answer the request, never widen or narrow its scope, and otherwise keep the operator's own words. ` +
    `The app shows the cleaned request as the operator's question and keeps their exact words one tap away. ` +
    `This step is best-effort: if clean fails, skip it and route anyway. ` +
    `Then pick the best topic for the transcript and run: python "${joinPath(scripts, 'route_task.py')}" ` +
    `--task ${input.taskId} --topic <chatId>_<threadId> --reason "<one line>" --title "<short noun phrase naming what this is about, at most 60 characters>". Topics: ${topics}. ` +
    `Routing is mandatory before you end this turn: call route_task.py before posting any task_telemetry.py progress update, and post no progress until the task is routed. ` +
    `If the cleanup step failed or was skipped, route with the raw transcript. If you are unsure where to route, use the default topic. Never end the turn without route_task.py succeeding. ` +
    continuationSegment(input.continuation) +
    (input.continuation === undefined ? conversationsSegment(input.openConversations ?? []) : '') +
    (input.conversationBriefing ?? '') +
    `Choose autonomously — never ask which topic (no choice widget, no chat question); ` +
    `if torn, route to the closest match and state the reason. ` +
    `This task arrives from the voice-inbox app (our own PWA, fully ours — long-press menus, custom sheets and inline widgets all possible); design UI answers for that surface, not Telegram's Bot-API constraints. ` +
    `Do not answer the request here; do not ask the operator anything here. ` +
    `Route it and stop — do not close the asking task: never run task_complete.py for it. ` +
    `It stays open until the destination topic's work completes the same task with the real answer ` +
    `(a deterministic fallback re-routes it and pages the operator if no worker picks the route up). ` +
    `The operator's conversation must end with the answer, never a routing receipt.`
  );
}

/**
 * The target-topic entry's injection text (§7's route_task.py shape). Built
 * TS-side for the API reroute path — the worker-decision path builds the same
 * §7 text in route_task.py (WP-C); both derive from this spec section
 * verbatim, so the two must stay word-identical.
 *
 * The briefing slot renders `''` when absent, so the text stays byte-identical
 * to its pre-2026-09-10 form. It is a `${}` interpolation inside the backtick
 * literal, never a `+`-joined segment outside it, because a segment outside
 * the backticks is invisible to `sync-twins.test.ts`'s parser.
 */
export function buildTargetInjectionText(input: {
  taskId: string;
  requestText: string;
  reason: string;
  repoRoot: string;
  conversationBriefing?: string;
  attachments?: readonly string[];
  feedback?: FeedbackRef;
}): string {
  const dir = joinPath(input.repoRoot, 'projects', 'voice-inbox', 'scripts');
  const briefing = input.conversationBriefing ?? '';
  const framing = input.feedback === undefined ? '' : buildFeedbackFraming(input.feedback) + ' ';
  const attachments = input.attachments === undefined ? '' : buildAttachmentsSegment(input.attachments);
  return (
    `[Voice task ${input.taskId} routed from inbox — reason: ${input.reason}] ${briefing}${framing}${input.requestText}. ${attachments}This task arrives from the voice-inbox app (our own PWA, fully ours — long-press menus, custom sheets and inline widgets all possible); design UI answers for that surface, not Telegram's Bot-API constraints. ` +
    `Run first: python "${joinPath(dir, 'task_telemetry.py')}" start --task ${input.taskId}. ` +
    `For operator input (secret, choice, confirm/yes-no, file, Google consent), use ` +
    `python "${joinPath(dir, 'task_input.py')}" create --help — ` +
    `a typed widget, never chat text, never HTML. ` +
    `If a tool needs authorization (a URL, code, key, password, or a yes/no you cannot answer): pa auth request with the shape, pa auth wait, then re-run non-interactively — never stall or ask in chat. ` +
    `Choose autonomously — never ask which topic (no choice widget, no chat question); ` +
    `if torn, route to the closest match and state the reason. ` +
    `Emit progress via task_telemetry.py (plan:/build:/verify: prefix optional; else plain Running); ` +
    `finish with python "${joinPath(dir, 'task_complete.py')}" ` +
    `--task ${input.taskId} --summary "<the complete answer>". ` +
    `The summary is what the operator reads — every substantive detail of the answer, ` +
    `no length trimming; strip only technical narration ` +
    `(tool names, paths, commands, steps). ` +
    `Also pass --short "<the verdict, not the reasoning>" — one or two plain sentences an average non-technical user understands, in the product's own terms. Never a truncated start; never capped. ` +
    `Never narrate internal housekeeping (brain upkeep, claims, gates, telemetry, coordination) — do it silently, or page via pa ping only if the operator must act. ` +
    `Format richly for the answer card (it renders markdown): blank line between points, ` +
    `### headings, **bold**, - or 1) lists, pipe tables with a |---| row, code fences, ` +
    `[text](url) or bare links. ` +
    `Never hard-code colours in HTML. ` +
    `Keep the conversation's three summary lines current: pass --title (a short noun phrase ` +
    `for the conversation, at most 60 characters, never a transcription of ` +
    `the request), --recap (one or two plain sentences on what is happening and ` +
    `where it stands) and --next (one line for the operator's next step, omitted ` +
    `when there is nothing) to task_complete.py, and the same three flags to task_input.py ` +
    `create whenever you ask a question. ` +
    `Phrase --prompt and choice labels in plain language — no ids, tool names, paths, or technical terms. ` +
    `Pass --suggest "<plain follow-up>" repeatable (0..4), ≤40 chars each, ` +
    `plain words only; non-plain entries dropped. Omit when nothing natural follows. ` +
    `For comparison/listing/guide/form-set/summary answers, pass --structured <json> (task_complete.py --help). `
  );
}

/**
 * The answer-pointer sentence (§3.7(b) of the auth-broker Phase A spec): the
 * resumed worker's turn is told where to read the value from, never the
 * value itself. The python twin is `task_input.py`'s `cmd_check` pointer
 * line (unchanged); `sync-twins.test.ts` pins the two byte-equal.
 */
export function buildAnswerPointerText(input: { requestId: string; answerPointer: string }): string {
  return `Answer for ${input.requestId} is at ${input.answerPointer} — read it; never repeat its value in chat.`;
}

/** Shared tail of the attachments segment — a named const on BOTH sides (TS
 * and route_task.py) so sync-twins.test.ts can pin the wording byte-equal by
 * extracting the literal from each source. */
export const ATTACHMENTS_SEGMENT_SUFFIX =
  ' Open them from disk when the task needs them; audio or video attachments can be transcribed with transcribe_voice.py. ';

/**
 * The ONE canonical attachments segment (task attachments, 2026-09-13):
 * rendered into the inbox texts at create and the target text at reroute.
 * Byte-identical to route_task.py's build_attachments_segment (sync-twins
 * pin). '' when paths is empty, so every existing pinned byte stays unchanged
 * for attachment-less tasks. Paths arrive absolute and forward-slashed.
 */
export function buildAttachmentsSegment(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  return `Attachments (${paths.length}): ${paths.join('; ')}.` + ATTACHMENTS_SEGMENT_SUFFIX;
}

/** Local path join (POSIX separators for the injected command strings — the
 * scripts are invoked through python, which accepts them on Windows too). */
function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/');
}
