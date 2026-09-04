/**
 * Durable per-topic task queue — topic-task handover Wave 1 (SPEC §3.1,
 * plans/2026-09-02-topic-task-handover-WAVE1-SPEC.md).
 *
 * One JSON array file per topic: `~/.pa/topic-tasks/<chatId>_<threadId>.json`.
 * Producers are short-lived CLI processes (`pa topic-task add`); the consumer
 * is the bot's `topic-task-drain` maintenance job (Wave 1 Phase 3). This is
 * deliberately NOT a reuse of `~/.pa/pending-reminder-resume.json` — that
 * store is single-producer, reminder-specific, and AI-185-frozen; the task
 * queue needs per-topic isolation, cross-process producer locking and
 * content-hash dedup (SPEC §3.1 justification).
 *
 * Concurrency: every read-modify-write runs under the reservations.ts pattern
 * — proper-lockfile with safeLockOptions on the queue file itself, plus the
 * in-process promise mutex (pending-dispatches.ts:78-90 pattern) so
 * same-process callers don't race each other into ELOCKED backoff — and
 * persists via writeJsonAtomic.
 */
import { createHash, randomBytes } from 'crypto';
import { dirname, join } from 'path';
import fs from 'fs-extra';
import lockfile from 'proper-lockfile';
import { paHome } from '../paths.js';
import { safeLockOptions } from './safe-lock.js';
import { writeJsonAtomic } from './atomic-write.js';
import { log } from './log.js';
import { appendTopicEvent } from './topic-events.js';

/**
 * Notes now have their own store (TopicNote, below) rather than riding this
 * kind field — 'note'/'question' were reserved here but never used (unified
 * store, operator directive 2026-09-03). Kept as a union of one for the
 * isTopicTask type guard's shape check; narrows if a second task kind ever
 * ships.
 */
export type TopicTaskKind = 'task';

export interface TopicTask {
  /** "tt-" + 12 hex. */
  id: string;
  kind: TopicTaskKind;
  /** <=80 chars, single line. */
  title: string;
  /** <=500 chars, single line, must not start with '/'. */
  prompt: string;
  /** ISO 8601. */
  created_at: string;
  /** 'cli' | 'skill:<name>' | 'operator' | 'session:<label>'. */
  created_by: string;
  /** sha256(chatId|threadId|kind|title|prompt), first 16 hex. */
  content_hash: string;
  /** Optional worker pin — Wave 2 (SPEC §3.1): rides the record into the running
   *  store and reaches runWithFailover as `preferredWorker` at execution time. */
  worker?: string;
}

export const TOPIC_TASK_MAX_TITLE_CHARS = 80;
const TOPIC_TASK_MAX_PROMPT_CHARS = 500;
/** Wave 2 worker pin grammar (SPEC §3.1). */
export const TOPIC_TASK_WORKER_RE = /^[a-z0-9-]{1,16}$/;

/**
 * Pa-side twin of the AI-185 topic_resume prompt rules (deliberate-mirror
 * pattern): same rules and error wording as BOTH sibling validators —
 * `projects/reminders/add_reminder.py`'s `validate_topic_resume` and
 * `projects/telegram-bot/src/oauth.ts`'s `validateTopicResumeAction` — with
 * the field prefix naming what this validator checks. All three are pinned by
 * their own tests.
 */
export function validateTaskPrompt(prompt: string): { ok: true } | { ok: false; error: string } {
  if (!prompt.trim()) {
    return { ok: false, error: 'task.prompt must not be empty' };
  }
  if (/[\r\n]/.test(prompt)) {
    return { ok: false, error: 'task.prompt must be a single line' };
  }
  if (prompt.length > TOPIC_TASK_MAX_PROMPT_CHARS) {
    return { ok: false, error: `task.prompt exceeds ${TOPIC_TASK_MAX_PROMPT_CHARS} characters` };
  }
  if (prompt.trim().startsWith('/')) {
    return { ok: false, error: 'task.prompt must not start with "/"' };
  }
  return { ok: true };
}

/** Same rule family as the prompt, bounding the frozen record shape's title. */
export function validateTaskTitle(title: string): { ok: true } | { ok: false; error: string } {
  if (!title.trim()) {
    return { ok: false, error: 'task.title must not be empty' };
  }
  if (/[\r\n]/.test(title)) {
    return { ok: false, error: 'task.title must be a single line' };
  }
  if (title.length > TOPIC_TASK_MAX_TITLE_CHARS) {
    return { ok: false, error: `task.title exceeds ${TOPIC_TASK_MAX_TITLE_CHARS} characters` };
  }
  return { ok: true };
}

/** sha256("<chatId>|<threadId>|<kind>|<title>|<prompt>"), first 16 hex. */
function taskContentHash(
  chatId: number,
  threadId: number,
  kind: string,
  title: string,
  prompt: string,
): string {
  return createHash('sha256')
    .update(`${chatId}|${threadId}|${kind}|${title}|${prompt}`)
    .digest('hex')
    .slice(0, 16);
}

export function taskQueuePath(chatId: number, threadId: number): string {
  return join(paHome(), 'topic-tasks', `${chatId}_${threadId}.json`);
}

function isTopicTask(t: unknown): t is TopicTask {
  if (!t || typeof t !== 'object') return false;
  const r = t as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.kind === 'string' &&
    typeof r.title === 'string' &&
    typeof r.prompt === 'string' &&
    typeof r.created_at === 'string' &&
    typeof r.created_by === 'string' &&
    typeof r.content_hash === 'string'
  );
}

async function ensureQueueFile(path: string): Promise<void> {
  await fs.ensureDir(dirname(path));
  try {
    await fs.writeJson(path, [], { flag: 'wx' });
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/**
 * Read used by listTasks: fail-to-empty (absent or corrupt queue reads as no
 * tasks — the read-only path must never throw).
 */
async function readQueueTolerant(path: string): Promise<TopicTask[]> {
  try {
    const data = await fs.readJson(path);
    if (!Array.isArray(data)) return [];
    return data.filter(isTopicTask);
  } catch {
    return [];
  }
}

/**
 * Read used INSIDE a locked read-modify-write: a corrupt file throws instead
 * of silently reading as empty, so an append/pop can never wipe the queue on
 * a parse failure (fail-safe beats silent data loss).
 */
async function readQueueStrict(path: string): Promise<TopicTask[]> {
  const data = await fs.readJson(path);
  if (!Array.isArray(data)) {
    throw new Error(`topic task queue is not a JSON array: ${path}`);
  }
  return data.filter(isTopicTask);
}

// In-process promise mutex (pending-dispatches.ts pattern): same-process
// callers serialize BEFORE ever touching proper-lockfile, whose retry/backoff
// is built for cross-process contention and far too slow for N same-process
// calls racing one mkdir-based lock.
let queueMutex: Promise<unknown> = Promise.resolve();

/**
 * Wave 2 generalization of the Wave-1 queue lock: every mutating call passes
 * EVERY store file it will read-modify-write (queue + running); the FIRST
 * path is the lock resource — one lock resource per topic serializes all
 * mutators, and all seed-before-lock (proper-lockfile lstats the lock target,
 * so every listed path must exist before the lock — Wave-1 §10 lesson).
 */
async function withTopicTaskLock<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    for (const p of paths) {
      if (p.endsWith('.running.json')) await ensureRunningFile(p);
      else if (p.endsWith('.notes.json')) await ensureNotesFile(p);
      else await ensureQueueFile(p);
    }
    const release = await lockfile.lock(paths[0], safeLockOptions('topic-tasks', { retries: 5 }));
    try {
      return await fn();
    } finally {
      await release();
    }
  };
  const task = queueMutex.catch(() => {}).then(run);
  queueMutex = task.catch(() => {});
  return task;
}

/**
 * Append one task to a topic's queue. If a queued record with the same
 * content hash already exists, returns `{ id: existing.id, deduped: true }`
 * and writes nothing — double-queueing cannot cause double-execution.
 * Throws on invalid input (message = the validator's error string).
 */
export async function appendTask(
  chatId: number,
  threadId: number,
  input: { title: string; prompt: string; createdBy: string; worker?: string },
): Promise<{ id: string; deduped: boolean }> {
  const titleCheck = validateTaskTitle(input.title);
  if (!titleCheck.ok) throw new Error(titleCheck.error);
  const promptCheck = validateTaskPrompt(input.prompt);
  if (!promptCheck.ok) throw new Error(promptCheck.error);
  if (!input.createdBy.trim() || /[\r\n]/.test(input.createdBy)) {
    throw new Error('task.created_by must be a non-empty single line');
  }
  if (input.worker !== undefined && !TOPIC_TASK_WORKER_RE.test(input.worker)) {
    throw new Error('task.worker must match ^[a-z0-9-]{1,16}$');
  }

  const path = taskQueuePath(chatId, threadId);
  const contentHash = taskContentHash(chatId, threadId, 'task', input.title, input.prompt);
  return withTopicTaskLock([path], async () => {
    const tasks = await readQueueStrict(path);
    const existing = tasks.find((t) => t.content_hash === contentHash);
    if (existing) return { id: existing.id, deduped: true };
    const record: TopicTask = {
      id: `tt-${randomBytes(6).toString('hex')}`,
      kind: 'task',
      title: input.title,
      prompt: input.prompt,
      created_at: new Date().toISOString(),
      created_by: input.createdBy,
      content_hash: contentHash,
      ...(input.worker !== undefined ? { worker: input.worker } : {}),
    };
    tasks.push(record);
    await writeJsonAtomic(path, tasks, { spaces: 2 });
    return { id: record.id, deduped: false };
  });
}

/** Read-only listing of a topic's queued tasks. Absent/corrupt → []. */
export async function listTasks(chatId: number, threadId: number): Promise<TopicTask[]> {
  return readQueueTolerant(taskQueuePath(chatId, threadId));
}

/**
 * Pop the FIRST (oldest — FIFO) record and persist the remainder before
 * returning, so a crash between pop and injection can never re-run a task
 * (at-most-once; the pop-persist window is milliseconds). Returns null when
 * the queue is empty. Throws on a corrupt queue file (callers WARN + drop).
 */
export async function popTask(chatId: number, threadId: number): Promise<TopicTask | null> {
  const path = taskQueuePath(chatId, threadId);
  return withTopicTaskLock([path], async () => {
    const tasks = await readQueueStrict(path);
    const next = tasks.shift();
    if (!next) return null;
    await writeJsonAtomic(path, tasks, { spaces: 2 });
    return next;
  });
}

// ---------------------------------------------------------------------------
// Notes store — unified topic store (operator directive 2026-09-03): a
// sibling JSON array file, same directory and lock discipline as the queue
// and running stores. Replaces the per-topic `SHORT-TERM.md` markdown index
// (Wave-1 SPEC §3.5) — same fields it carried (key, text, status,
// created/expires), same OPEN/DONE lifecycle, but a store record instead of a
// hand-parsed line grammar. `pa topic-note` (pa/src/commands/topic.ts) is the
// writer; `renderOpenItems` (bot context.ts) is the reader — both import this
// module directly (no file grammar to keep in sync).
// ---------------------------------------------------------------------------

export const TOPIC_NOTE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TOPIC_NOTE_MAX_TEXT_CHARS = 200;
export const TOPIC_NOTE_RENDER_CAP = 15;

export type TopicNoteStatus = 'OPEN' | 'DONE';

export interface TopicNote {
  /** `^[a-z0-9][a-z0-9-]{0,39}$` — default minted `n-<8hex>`. */
  key: string;
  /** <=200 chars, single line (the SHORT-TERM.md grammar's cap, carried over). */
  text: string;
  status: TopicNoteStatus;
  /** ISO 8601. */
  created_at: string;
  /** `YYYY-MM-DD`, optional. */
  expires?: string;
}

export function validateNoteText(text: string): { ok: true } | { ok: false; error: string } {
  if (!text.trim()) {
    return { ok: false, error: 'note.text must not be empty' };
  }
  if (/[\r\n]/.test(text)) {
    return { ok: false, error: 'note.text must be a single line' };
  }
  if (text.length > TOPIC_NOTE_MAX_TEXT_CHARS) {
    return { ok: false, error: `note.text exceeds ${TOPIC_NOTE_MAX_TEXT_CHARS} characters` };
  }
  return { ok: true };
}

export function validateNoteExpires(value: string): { ok: true } | { ok: false; error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
    return { ok: false, error: 'note.expires must be a date like 2026-09-30' };
  }
  return { ok: true };
}

/** The rendered display text a note carries in the frozen §3.5 line grammar:
 *  the text, plus an ` (expires <date>)` suffix when set. Single source for
 *  both the CLI's `pa topic-note list` output and the bot's Notes: block. */
export function noteDisplayText(note: TopicNote): string {
  return note.expires ? `${note.text} (expires ${note.expires})` : note.text;
}

export function topicNotesPath(chatId: number, threadId: number): string {
  return join(paHome(), 'topic-tasks', `${chatId}_${threadId}.notes.json`);
}

function isTopicNote(t: unknown): t is TopicNote {
  if (!t || typeof t !== 'object') return false;
  const r = t as Record<string, unknown>;
  return (
    typeof r.key === 'string' &&
    typeof r.text === 'string' &&
    (r.status === 'OPEN' || r.status === 'DONE') &&
    typeof r.created_at === 'string'
  );
}

async function ensureNotesFile(path: string): Promise<void> {
  await fs.ensureDir(dirname(path));
  try {
    await fs.writeJson(path, [], { flag: 'wx' });
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/** Fail-to-empty — read paths must never throw (readQueueTolerant precedent). */
async function readNotesTolerant(path: string): Promise<TopicNote[]> {
  try {
    const data = await fs.readJson(path);
    if (!Array.isArray(data)) return [];
    return data.filter(isTopicNote);
  } catch {
    return [];
  }
}

/** Corrupt notes file throws inside a locked write so a mutation can never
 *  wipe the store on a parse failure (readQueueStrict precedent). */
async function readNotesStrict(path: string): Promise<TopicNote[]> {
  const data = await fs.readJson(path);
  if (!Array.isArray(data)) {
    throw new Error(`topic notes store is not a JSON array: ${path}`);
  }
  return data.filter(isTopicNote);
}

/**
 * Append an OPEN note. Mints a `n-<8hex>` key when none is given; throws when
 * a given key already exists in the store (regardless of its status) or
 * fails validation. Returns the note's key.
 */
export async function addNote(
  chatId: number,
  threadId: number,
  input: { text: string; key?: string; expires?: string },
): Promise<{ key: string }> {
  const textCheck = validateNoteText(input.text);
  if (!textCheck.ok) throw new Error(textCheck.error);
  if (input.key !== undefined && !TOPIC_NOTE_KEY_RE.test(input.key)) {
    throw new Error('note.key must match ^[a-z0-9][a-z0-9-]{0,39}$');
  }
  if (input.expires !== undefined) {
    const expiresCheck = validateNoteExpires(input.expires);
    if (!expiresCheck.ok) throw new Error(expiresCheck.error);
  }

  const path = topicNotesPath(chatId, threadId);
  return withTopicTaskLock([path], async () => {
    const notes = await readNotesStrict(path);
    const key = input.key ?? `n-${randomBytes(4).toString('hex')}`;
    if (notes.some((n) => n.key === key)) {
      throw new Error(`note key already exists: ${key}`);
    }
    const record: TopicNote = {
      key,
      text: input.text,
      status: 'OPEN',
      created_at: new Date().toISOString(),
      ...(input.expires !== undefined ? { expires: input.expires } : {}),
    };
    notes.push(record);
    await writeJsonAtomic(path, notes, { spaces: 2 });
    return { key };
  });
}

/** Read-only listing of every note (OPEN and DONE), insertion order.
 *  Absent/corrupt → []. */
export async function listNotes(chatId: number, threadId: number): Promise<TopicNote[]> {
  return readNotesTolerant(topicNotesPath(chatId, threadId));
}

/**
 * Flip an OPEN note to DONE. Throws when the key is absent or not currently
 * OPEN (already DONE is a rejection, not a no-op — mirrors the old CLI's
 * "already DONE" exit-3 behavior).
 */
export async function closeNote(chatId: number, threadId: number, key: string): Promise<void> {
  const path = topicNotesPath(chatId, threadId);
  return withTopicTaskLock([path], async () => {
    const notes = await readNotesStrict(path);
    const note = notes.find((n) => n.key === key);
    if (!note || note.status !== 'OPEN') {
      throw new Error(`no OPEN note with key ${key}`);
    }
    note.status = 'DONE';
    await writeJsonAtomic(path, notes, { spaces: 2 });
  });
}

// ---------------------------------------------------------------------------
// Running store — Wave 2 (SPEC §3.1, plans/2026-09-02-topic-handover-WAVE2-SPEC.md).
// `~/.pa/topic-tasks/<chatId>_<threadId>.running.json`, one JSON array of
// RunningTask. The executor lane claims from the queue into this store, parks
// on a PA_META question, resumes on an answer, and removes on completion or
// terminal failure. Crash recovery NEVER inspects pids: a running record
// older than TOPIC_TASK_STALE_MS is demoted to ready at claim time.
// ---------------------------------------------------------------------------

/**
 * OPERATOR DIRECTIVE 2026-09-03: no per-topic concurrency cap — every queued
 * task executes. This number is an unreachable backstop, not a governor: real
 * concurrency is paced by the GLOBAL per-tick claim cap (TOPIC_TASK_TICK_CAP in
 * the bot's task-executor.ts) and the machine-wide worker pool
 * (PA_MAX_CONCURRENT_WORKERS). A topic would need 100 simultaneously
 * non-terminal records (running/parked/ready-in-backoff) to hit it, at which
 * point claims pause exactly as before — a safe stop, not a correctness cliff.
 */
export const TOPIC_TASK_SLOTS = 100;
export const TOPIC_TASK_STALE_MS = 30 * 60_000;
export const TOPIC_TASK_MAX_ATTEMPTS = 3;
export const TOPIC_TASK_RETRY_NOT_BEFORE_MS = 10 * 60_000;
const MAX_MICRO_THREAD_TURNS = 6;
const MAX_FYI_MESSAGE_IDS = 8;

export type RunningTaskStatus = 'running' | 'parked' | 'ready';

export interface TaskMicroTurn {
  role: 'user' | 'assistant';
  text: string;
  /** ISO 8601. */
  ts: string;
}

export interface TaskQuestion {
  text: string;
  options: string[];
  /** Filled by the executor after the question FYI send (attachQuestionMessage). */
  message_id?: number;
}

/** The frozen running record (SPEC §3.1). */
export interface RunningTask {
  id: string;
  title: string;
  prompt: string;
  created_at: string;
  created_by: string;
  content_hash: string;
  worker?: string;
  status: RunningTaskStatus;
  slot: number;
  started_at: string;
  micro_thread: TaskMicroTurn[];
  fyi_message_ids: number[];
  question: TaskQuestion | null;
  attempts: number;
  /** Epoch ms — a ready record is not claimable before this (A.3.5 retry ladder). */
  retry_not_before?: number;
  /** ISO 8601 — the executor's activity heartbeat (WP-A, adjudicated 2026-09-03).
   *  Written as a PENDING-DISPATCH heartbeat (while the dispatch promise is in
   *  flight), not an output-chunk signal — the executor consumes no worker stdout
   *  chunks, and under pa semantics "dispatch pending" implies "possibly
   *  producing" (worker-exec's idle killer + maxTimer settle every promise), so
   *  the two gate the same double-run windows. The stale classifier prefers this
   *  over started_at when present, so an actively-running attempt is never
   *  demoted however long it runs; absent on legacy records (classifier falls
   *  back to started_at) and between a claim and its first heartbeat. */
  lastActivityAt?: string;
  /** Monotonic per-record claim generation: 1 on the first claim, +1 on every
   *  demotion+re-claim. The executor captures it at claim time and rechecks it
   *  before any terminal path (WP-B, adjudicated 2026-09-03) — a superseded
   *  attempt's late result is discarded, never double-reported. */
  claimGen?: number;
}

export function taskRunningPath(chatId: number, threadId: number): string {
  return join(paHome(), 'topic-tasks', `${chatId}_${threadId}.running.json`);
}

function isRunningTask(t: unknown): t is RunningTask {
  if (!t || typeof t !== 'object') return false;
  const r = t as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.status === 'string' &&
    typeof r.slot === 'number' &&
    typeof r.started_at === 'string' &&
    typeof r.attempts === 'number' &&
    Array.isArray(r.micro_thread) &&
    Array.isArray(r.fyi_message_ids)
  );
}

async function ensureRunningFile(path: string): Promise<void> {
  await fs.ensureDir(dirname(path));
  try {
    await fs.writeJson(path, [], { flag: 'wx' });
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/** Fail-to-empty — read paths must never throw (readQueueTolerant precedent). */
async function readRunningTolerant(path: string): Promise<RunningTask[]> {
  try {
    const data = await fs.readJson(path);
    if (!Array.isArray(data)) return [];
    return data.filter(isRunningTask);
  } catch {
    return [];
  }
}

/** Corrupt running file throws inside a locked write so a mutation can never
 *  wipe the store on a parse failure (readQueueStrict precedent). */
async function readRunningStrict(path: string): Promise<RunningTask[]> {
  const data = await fs.readJson(path);
  if (!Array.isArray(data)) {
    throw new Error(`topic task running store is not a JSON array: ${path}`);
  }
  return data.filter(isRunningTask);
}

function capMicroThread(turns: TaskMicroTurn[]): TaskMicroTurn[] {
  return turns.slice(-MAX_MICRO_THREAD_TURNS);
}

/** Epoch ms of the record's last observed activity: the executor's heartbeat
 *  when present and parseable, else the claim time (legacy records, and fresh
 *  claims ahead of their first heartbeat). */
function lastActivityMs(r: RunningTask): number {
  if (r.lastActivityAt !== undefined) {
    const t = Date.parse(r.lastActivityAt);
    if (Number.isFinite(t)) return t;
  }
  return Date.parse(r.started_at);
}

/**
 * THE one stale-running classifier, shared by claimNextTask's inline pass and
 * demoteStaleRunningTasks so the two demotion sites cannot disagree
 * (classifyLock precedent). Demotes only when the record has been SILENT past
 * TOPIC_TASK_STALE_MS: an actively-producing attempt (fresh heartbeat) is never
 * demoted however long it runs, because the original worker may still be alive —
 * task dispatches set no timeout and worker-exec's total timeout (60 min default)
 * exceeds this window (double-execution fix, adjudicated 2026-09-03, WP-D3
 * follow-up). A crashed bot's heartbeats stop with it, so its records age out
 * from their last real activity exactly as the 30-min recovery intends.
 */
function isStaleRunning(r: RunningTask, now: number): boolean {
  return r.status === 'running' && now - lastActivityMs(r) > TOPIC_TASK_STALE_MS;
}

function capFyiIds(ids: number[]): number[] {
  return ids.slice(-MAX_FYI_MESSAGE_IDS);
}

/**
 * Claim the next task for a topic: ONE lock covers BOTH store files.
 * Order: stale-demote running → promote the oldest ready record (attempts+1)
 * → else, when running+parked fill TOPIC_TASK_SLOTS, null → else pop the
 * first queued record and stamp it running. A ready record past
 * TOPIC_TASK_MAX_ATTEMPTS is removed here with a `task_failed`
 * ('attempts-exhausted') event — the frozen `Promise<RunningTask | null>`
 * return has no failure channel, so the store emits that one event itself
 * (every other task_* event is the bot executor's job). The removal is
 * logged; the scan continues so one dead task cannot starve the queue.
 */
export async function claimNextTask(chatId: number, threadId: number): Promise<RunningTask | null> {
  const queuePath = taskQueuePath(chatId, threadId);
  const runningPath = taskRunningPath(chatId, threadId);
  return withTopicTaskLock([queuePath, runningPath], async () => {
    const now = Date.now();
    let running = await readRunningStrict(runningPath);
    let runningDirty = false;

    for (const r of running) {
      if (isStaleRunning(r, now)) {
        r.status = 'ready';
        runningDirty = true;
        log('info', 'topic-tasks', 'stale running record demoted to ready', {
          id: r.id,
          idleMs: now - lastActivityMs(r),
          source: r.lastActivityAt !== undefined ? 'lastActivityAt' : 'started_at',
        });
      }
    }

    const ready = running
      .filter((r) => r.status === 'ready')
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const r of ready) {
      if (r.retry_not_before !== undefined && r.retry_not_before > now) continue;
      if (r.attempts >= TOPIC_TASK_MAX_ATTEMPTS) {
        running = running.filter((x) => x.id !== r.id);
        runningDirty = true;
        log('warn', 'topic-tasks', 'attempt cap reached — running record removed', { id: r.id, attempts: r.attempts });
        try {
          await appendTopicEvent(chatId, threadId, { kind: 'task_failed', ref: r.id, detail: 'attempts-exhausted' });
        } catch (err) {
          log('warn', 'topic-tasks', `task_failed event write failed: ${(err as Error).message}`, { id: r.id });
        }
        continue;
      }
      r.attempts += 1;
      r.status = 'running';
      r.started_at = new Date(now).toISOString();
      delete r.retry_not_before;
      // A new owner mints here (WP-B, adjudicated 2026-09-03): the ONLY site that
      // bumps claimGen — demotion alone does not, so both demotion sites stay
      // consistent and a late pre-re-claim terminal from the old attempt still
      // matches its captured generation (the work IS done; report it once). The
      // old attempt's heartbeat is stale by construction — drop it so the fresh
      // claim is not instantly classified stale off its predecessor's last write.
      r.claimGen = (r.claimGen ?? 0) + 1;
      delete r.lastActivityAt;
      runningDirty = true;
      await writeJsonAtomic(runningPath, running, { spaces: 2 });
      return r;
    }

    if (runningDirty) {
      await writeJsonAtomic(runningPath, running, { spaces: 2 });
    }

    // Slot budget counts EVERY stored record, ready included: a ready record in
    // retry backoff still holds its slot index, and the frozen slot rule ("lowest
    // free index in 0..TOPIC_TASK_SLOTS-1") outranks the spec count sentence's
    // "running+parked" wording (§1-correction, adjudicated 2026-09-02 — with only
    // running+parked counted, two backoff records plus a queued pop assigned
    // slot 2 and took concurrent task dispatches past the ≤2 + human-lane budget).
    // Sound because promotable ready records always RETURN above; the ready
    // records still present here are exactly the backoff-blocked ones.
    const busy = running.length;
    if (busy >= TOPIC_TASK_SLOTS) return null;

    const queue = await readQueueStrict(queuePath);
    const next = queue.shift();
    if (!next) return null;
    await writeJsonAtomic(queuePath, queue, { spaces: 2 });

    const usedSlots = new Set(running.map((r) => r.slot));
    let slot = 0;
    while (usedSlots.has(slot)) slot += 1;
    const record: RunningTask = {
      id: next.id,
      title: next.title,
      prompt: next.prompt,
      created_at: next.created_at,
      created_by: next.created_by,
      content_hash: next.content_hash,
      ...(next.worker !== undefined ? { worker: next.worker } : {}),
      status: 'running',
      slot,
      started_at: new Date(now).toISOString(),
      micro_thread: [],
      fyi_message_ids: [],
      question: null,
      attempts: 1,
      claimGen: 1,
    };
    running.push(record);
    await writeJsonAtomic(runningPath, running, { spaces: 2 });
    return record;
  });
}

/** Park a running task on a PA_META question; the question FYI's message_id is
 *  attached separately (attachQuestionMessage) once the send lands. */
export async function parkTask(
  chatId: number,
  threadId: number,
  id: string,
  question: { text: string; options: string[] },
): Promise<RunningTask | null> {
  const queuePath = taskQueuePath(chatId, threadId);
  const runningPath = taskRunningPath(chatId, threadId);
  return withTopicTaskLock([queuePath, runningPath], async () => {
    const running = await readRunningStrict(runningPath);
    const r = running.find((x) => x.id === id);
    if (!r) return null;
    r.status = 'parked';
    r.question = { text: question.text, options: [...question.options] };
    await writeJsonAtomic(runningPath, running, { spaces: 2 });
    return r;
  });
}

/** Record the question FYI's message id so reply-routing and qt: presses can
 *  find the task (findTaskByAnchorMessage). Best-effort callers only. */
export async function attachQuestionMessage(
  chatId: number,
  threadId: number,
  id: string,
  messageId: number,
): Promise<void> {
  const queuePath = taskQueuePath(chatId, threadId);
  const runningPath = taskRunningPath(chatId, threadId);
  await withTopicTaskLock([queuePath, runningPath], async () => {
    const running = await readRunningStrict(runningPath);
    const r = running.find((x) => x.id === id);
    if (!r?.question) return;
    r.question.message_id = messageId;
    await writeJsonAtomic(runningPath, running, { spaces: 2 });
  });
}

/**
 * Deliver an operator answer to a task: appends the user micro-thread turn,
 * clears the question and flips the record to ready (the next claim resumes
 * it). Returns the updated record, or null when the id is unknown.
 */
export async function answerTask(
  chatId: number,
  threadId: number,
  id: string,
  answerText: string,
): Promise<RunningTask | null> {
  const queuePath = taskQueuePath(chatId, threadId);
  const runningPath = taskRunningPath(chatId, threadId);
  return withTopicTaskLock([queuePath, runningPath], async () => {
    const running = await readRunningStrict(runningPath);
    const r = running.find((x) => x.id === id);
    if (!r) return null;
    r.micro_thread = capMicroThread([
      ...r.micro_thread,
      { role: 'user', text: answerText, ts: new Date().toISOString() },
    ]);
    // A RUNNING task is mid-dispatch: record the answer for the in-flight run but do
    // NOT flip it to ready — flipping would let the next drain tick re-claim it while
    // the first dispatch is still executing (double dispatch/spend). Only a
    // parked/question-waiting task resumes on an answer.
    if (r.status === 'parked') {
      r.question = null;
      r.status = 'ready';
    }
    await writeJsonAtomic(runningPath, running, { spaces: 2 });
    return r;
  });
}

/** Append the executor's FYI message id to the record's anchor set (last 8). */
export async function recordFyiMessage(
  chatId: number,
  threadId: number,
  id: string,
  messageId: number,
): Promise<void> {
  const queuePath = taskQueuePath(chatId, threadId);
  const runningPath = taskRunningPath(chatId, threadId);
  await withTopicTaskLock([queuePath, runningPath], async () => {
    const running = await readRunningStrict(runningPath);
    const r = running.find((x) => x.id === id);
    if (!r) return;
    r.fyi_message_ids = capFyiIds([...r.fyi_message_ids, messageId]);
    await writeJsonAtomic(runningPath, running, { spaces: 2 });
  });
}

/** Retry ladder rung (A.3.5): demote to ready and bar claims until
 *  `retryNotBeforeMs` (epoch ms). Called by the executor after a failed attempt. */
export async function deferTask(
  chatId: number,
  threadId: number,
  id: string,
  retryNotBeforeMs: number,
): Promise<RunningTask | null> {
  const queuePath = taskQueuePath(chatId, threadId);
  const runningPath = taskRunningPath(chatId, threadId);
  return withTopicTaskLock([queuePath, runningPath], async () => {
    const running = await readRunningStrict(runningPath);
    const r = running.find((x) => x.id === id);
    if (!r) return null;
    r.status = 'ready';
    r.retry_not_before = retryNotBeforeMs;
    await writeJsonAtomic(runningPath, running, { spaces: 2 });
    return r;
  });
}

/** Completion: the record leaves the running store (frees its slot); the
 *  completion is audited by the executor's task_completed event. */
export async function completeTask(chatId: number, threadId: number, id: string): Promise<void> {
  const queuePath = taskQueuePath(chatId, threadId);
  const runningPath = taskRunningPath(chatId, threadId);
  await withTopicTaskLock([queuePath, runningPath], async () => {
    const running = await readRunningStrict(runningPath);
    const next = running.filter((x) => x.id !== id);
    if (next.length === running.length) return;
    await writeJsonAtomic(runningPath, next, { spaces: 2 });
  });
}

/**
 * Terminal failure: removes the record. `reason` is for the CALLER's
 * task_failed event and this removal log — the store writes no event here
 * (the executor owns task_failed emission, except the attempts-exhausted
 * path inside claimNextTask which no caller ever observes).
 */
export async function failTask(
  chatId: number,
  threadId: number,
  id: string,
  reason: string,
): Promise<void> {
  const queuePath = taskQueuePath(chatId, threadId);
  const runningPath = taskRunningPath(chatId, threadId);
  await withTopicTaskLock([queuePath, runningPath], async () => {
    const running = await readRunningStrict(runningPath);
    const next = running.filter((x) => x.id !== id);
    if (next.length === running.length) return;
    await writeJsonAtomic(runningPath, next, { spaces: 2 });
    log('warn', 'topic-tasks', 'running record failed and removed', { id, reason });
  });
}

/** Minimum spacing between activity-heartbeat writes (WP-A, adjudicated
 *  2026-09-03): output chunk storms must not thrash the store file. The guard is
 *  ONE module-level timestamp (machine-wide rate bound, not per-task) — a skipped
 *  heartbeat only ever lets a record age FASTER, and the next admitted write
 *  corrects it. */
export const TOPIC_TASK_ACTIVITY_THROTTLE_MS = 10_000;
let lastActivityWriteAt = 0;

/**
 * Executor activity heartbeat (WP-A, adjudicated 2026-09-03): stamp the running
 * record's lastActivityAt so the stale classifier (isStaleRunning) can tell an
 * actively-producing attempt from a crashed one. Throttled to at most one store
 * write per TOPIC_TASK_ACTIVITY_THROTTLE_MS. FAIL-SAFE by contract: any error is
 * logged and swallowed — a lost heartbeat must never fail a dispatch (the caller
 * may fire-and-forget the returned promise).
 */
export async function touchTaskActivity(chatId: number, threadId: number, id: string, now = Date.now()): Promise<boolean> {
  if (now - lastActivityWriteAt < TOPIC_TASK_ACTIVITY_THROTTLE_MS) return false;
  lastActivityWriteAt = now;
  const queuePath = taskQueuePath(chatId, threadId);
  const runningPath = taskRunningPath(chatId, threadId);
  try {
    await withTopicTaskLock([queuePath, runningPath], async () => {
      const running = await readRunningStrict(runningPath);
      const r = running.find((x) => x.id === id);
      if (!r) return;
      r.lastActivityAt = new Date(now).toISOString();
      await writeJsonAtomic(runningPath, running, { spaces: 2 });
    });
    return true;
  } catch (err) {
    log('warn', 'topic-tasks', `activity heartbeat write failed: ${(err as Error).message}`, { id });
    return false;
  }
}

/**
 * Drain-start stale recovery (SPEC §3.1 A.3 step 1, pre-adjudicated 2026-09-02):
 * demote EVERY stale running record of this topic to ready (attempts unchanged),
 * not only the ones this tick will claim — the global per-tick claim cap must not
 * starve a topic that wins no claim this tick, or its crashed dispatch would sit
 * `running` forever. Stale means SILENT past TOPIC_TASK_STALE_MS (isStaleRunning,
 * the shared classifier — an actively-producing attempt with a fresh activity
 * heartbeat is never demoted; adjudicated 2026-09-03). claimNextTask keeps its own
 * inline pass (same classifier); this is the drain's belt-and-braces sweep across
 * all enumerated topics.
 */
export async function demoteStaleRunningTasks(chatId: number, threadId: number, now = Date.now()): Promise<number> {
  const queuePath = taskQueuePath(chatId, threadId);
  const runningPath = taskRunningPath(chatId, threadId);
  return withTopicTaskLock([queuePath, runningPath], async () => {
    const running = await readRunningStrict(runningPath);
    let demoted = 0;
    for (const r of running) {
      if (isStaleRunning(r, now)) {
        r.status = 'ready';
        demoted += 1;
        log('info', 'topic-tasks', 'stale running record demoted to ready', {
          id: r.id,
          idleMs: now - lastActivityMs(r),
          source: r.lastActivityAt !== undefined ? 'lastActivityAt' : 'started_at',
        });
      }
    }
    if (demoted > 0) await writeJsonAtomic(runningPath, running, { spaces: 2 });
    return demoted;
  });
}

/** Read-only listing. Absent/corrupt → []. */
export async function listRunningTasks(chatId: number, threadId: number): Promise<RunningTask[]> {
  return readRunningTolerant(taskRunningPath(chatId, threadId));
}

/**
 * Anchor lookup for the tier-1 reply hook: does this Telegram message id
 * belong to one of the topic's task FYIs (pickup/completion/retry/failure
 * notices) or carry its question keyboard? First match wins; miss → null.
 */
export async function findTaskByAnchorMessage(
  chatId: number,
  threadId: number,
  messageId: number,
): Promise<RunningTask | null> {
  const running = await readRunningTolerant(taskRunningPath(chatId, threadId));
  return (
    running.find(
      (r) => r.fyi_message_ids.includes(messageId) || r.question?.message_id === messageId,
    ) ?? null
  );
}

/**
 * Test hook (SPEC §3.1 frozen API): drop in-process caches. The store is
 * deliberately cache-free — every call reads through the lock — so this only
 * resets the in-process mutex chain, which a prior test's rejected task could
 * otherwise leave non-pristine.
 */
export function _resetTopicTasksForTest(): void {
  queueMutex = Promise.resolve();
  lastActivityWriteAt = 0;
}
