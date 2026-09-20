/**
 * Async job watcher (AI-170).
 *
 * v1 exposes a CLOSED, read-only check vocabulary — file_exists, file_gone,
 * file_newer_than, file_contains, process_gone — and nothing else. No shell,
 * no network, no arbitrary command. This is deliberate: a `watch_job` is
 * ARMED by LLM output (the bot's `watch_job` PA_META action) and then fires
 * unattended on a recurring 60s tick with no further human review. Any
 * check richer than "read a stat/line/pid and compare" would let a single
 * prompt-injected instruction arm a PERSISTENT recurring action — the same
 * failure class as an undeclared hidden timer, but attacker-controlled
 * instead of merely undeclared. Extending the vocabulary is a deliberate,
 * reviewed change, never an LLM-supplied parameter.
 *
 * `process_gone` accepts pid recycling as a known limitation (intent D10):
 * the OS can reassign a pid to an unrelated process between checks, which
 * would read as "still running" (false not-met) or, in the rarer case,
 * "no longer running" for the wrong process. This is bounded by the watch's
 * own deadline — a stale watch terminals (expired or force-terminaled)
 * within days, not indefinitely — and is judged an acceptable v1 trade-off
 * rather than a defect to fix here.
 *
 * All time in this module arrives as an injected `now` parameter, never
 * read from the clock internally. This file sits OUTSIDE the
 * `pa/src/lib/maintenance/` timer-inventory exemption (see
 * pa/tests/timer-inventory.test.ts), so it must never contain a periodic-timer
 * primitive, a `next<X>At`-shaped identifier, or a live-clock deadline
 * comparison — the tick engine (`runWatchTick`) is driven only by the
 * declared `watch-jobs-runner` maintenance job, which supplies `now` from its
 * own context.
 */

import { randomBytes } from 'crypto';
import { open, stat } from 'fs/promises';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'path';
import fs from 'fs-extra';
import lockfile from 'proper-lockfile';
import { paHome } from '../paths.js';
import { safeLockOptions } from './safe-lock.js';
import { writeJsonAtomic } from './atomic-write.js';
import { log } from './log.js';
import { redactSecrets } from './redact.js';
import { notifyUser } from './notify.js';
import { appendTopicEvent } from './topic-events.js';
import { appendTask, TOPIC_TASK_MAX_TITLE_CHARS } from './topic-tasks.js';
import { areProcessesAlive } from '../process-tree.js';
import { withBoundedQueue } from './stall.js';

// ---------------------------------------------------------------------------
// Types (SPEC §2.1 — frozen, copied verbatim)
// ---------------------------------------------------------------------------

export type WatchCheckType =
  | 'file_exists'
  | 'file_gone'
  | 'file_newer_than'
  | 'file_contains'
  | 'process_gone';

/** Normalized check. Only the fields relevant to `type` are ever set. */
export interface WatchCheck {
  type: WatchCheckType;
  /** Absolute, path.resolve()d. file_exists | file_gone | file_newer_than | file_contains. */
  path?: string;
  /** file_contains only. Compiled with `new RegExp(pattern)` — no flags. */
  pattern?: string;
  /** file_newer_than only. Defaults to registration time at validation. */
  sinceIso?: string;
  /** process_gone only. Positive integer. */
  pid?: number;
}

export interface WatchSource {
  kind: 'pa_meta' | 'cli';
  /** Telegram chat id as a string (may be negative). Required, non-empty. */
  chatId: string;
  /** Forum thread id; 0 = the general topic. */
  threadId: number;
  /** Always null in v1 — see SPEC §1 C3. */
  refId: string | null;
}

export type WatchStatus = 'active' | 'reported' | 'expired' | 'cancelled' | 'check-failed';

export interface WatchJob {
  id: string;                    // 'w-' + 8 lowercase hex
  createdAt: string;             // ISO
  description: string;           // <= 200 chars
  source: WatchSource;
  check: WatchCheck;
  intervalMs: number;
  deadlineAt: string;            // ISO
  lastCheckedAt: string | null;
  consecutiveErrors: number;
  status: WatchStatus;
  terminalAt?: string;           // ISO, set with any terminal status
  outcome?: string;               // redacted summary of what was sent, <= 500 chars
  lastError?: string;            // C2 — <= 300 chars
  lastObservation?: string;      // C2 — last successful evaluation's observation
}

export interface WatchStore { watches: WatchJob[] }

/** Caller-facing input, pre-validation. Field names mirror the PA_META action. */
export interface WatchInput {
  description: string;
  check: {
    type: string;
    path?: string;
    pattern?: string;
    sinceIso?: string;
    pid?: number;
  };
  intervalSeconds?: number;
  deadlineMinutes?: number;
  source: WatchSource;
}

export interface WatchValidated {
  description: string;
  check: WatchCheck;
  intervalMs: number;
  deadlineAt: string;
}

export type WatchValidation =
  | { ok: true; value: WatchValidated }
  | { ok: false; error: string };

export interface WatchEvaluation {
  met: boolean;
  /** ALWAYS set. Human-readable current state; persisted as lastObservation. */
  observation: string;
  /** Extra report line when met (matched line, mtime comparison). */
  detail?: string;
}

export type AliveFn = (pids: number[]) => Promise<Map<number, boolean>>;

/** Structural subset of notifyUser — §1.10 AMENDMENT (WP-D2 B.7, 2026-09-02): widened
 *  by exactly ONE optional keyboard param. The terminal check-failed and expired
 *  reports carry the wt: re-register button
 *  (2026-09-02 topic-handover WAVE2 spec §3.4 item 7b); nothing else about
 *  the subset changes. */
export type WatchNotifyFn = (
  subject: string,
  body: string,
  opts?: {
    dedupKey?: string;
    topic?: { chat_id: string; thread_id?: number };
    severity?: 'info' | 'warn' | 'error';
    replyMarkup?: Record<string, unknown>;
  },
) => Promise<{ sent: boolean; suppressed: boolean }>;

export interface RunWatchTickOptions {
  now?: number;            // default Date.now()
  notify?: WatchNotifyFn;  // default notifyUser
  aliveFn?: AliveFn;       // default (pids) => areProcessesAlive(pids)
}

export interface WatchTickResult {
  checked: number;
  reported: number;
  expired: number;
  failed: number;   // rows terminaled as check-failed
  forced: number;   // rows force-terminaled past deadline + 3d
  pruned: number;
}

// ---------------------------------------------------------------------------
// Constants (SPEC §2.3 — frozen, exported and referenced by name elsewhere)
// ---------------------------------------------------------------------------

export const MAX_ACTIVE_WATCHES = 25;
export const MAX_CHECKS_PER_TICK = 10;
export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 3_600_000;
export const DEFAULT_INTERVAL_MS = 60_000;
export const DEFAULT_DEADLINE_MS = 24 * 3_600_000;
export const MAX_DEADLINE_MS = 7 * 24 * 3_600_000;
export const MAX_DESCRIPTION_CHARS = 200;
export const MAX_PATTERN_CHARS = 200;
export const CONTAINS_TAIL_BYTES = 262_144;          // 256 KB
export const CONTAINS_MAX_LINES = 2_000;
export const CONTAINS_MAX_LINE_CHARS = 4_000;
export const CONTAINS_SNIPPET_CHARS = 200;
export const TERMINAL_RETENTION_MS = 14 * 24 * 3_600_000;
export const FORCE_TERMINAL_GRACE_MS = 3 * 24 * 3_600_000;
export const ERROR_LADDER_LIMIT = 5;                  // consecutive errors before check-failed
export const OUTCOME_MAX_CHARS = 500;
export const LAST_ERROR_MAX_CHARS = 300;

// ---------------------------------------------------------------------------
// Store path + persistence (mirrors pa/src/lib/reservations.ts:129-199)
// ---------------------------------------------------------------------------

export function watchJobsPath(): string {
  return join(paHome(), 'watch-jobs.json');
}

async function ensureFile(path: string): Promise<void> {
  let exists = await fs.pathExists(path);
  if (exists) {
    try {
      const stats = await fs.stat(path);
      if (stats.size === 0) exists = false;
    } catch {
      exists = false;
    }
  }

  if (!exists) {
    await fs.ensureDir(dirname(path));
    try {
      await fs.writeJson(path, { watches: [] }, { flag: 'wx' });
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

async function readStore(path: string): Promise<WatchStore> {
  try {
    const data = await fs.readJson(path);
    if (!data || !Array.isArray(data.watches)) return { watches: [] };
    return data;
  } catch (err) {
    log('error', 'watch-jobs', 'store unreadable — resetting to empty', {
      refId: `s-${randomBytes(6).toString('hex')}`,
      path,
      error: String(err),
    });
    return { watches: [] };
  }
}

/**
 * Read-modify-write a fresh copy of the store under the file lock. Same
 * pattern as reservations.ts's `mutate`: an in-process bounded queue (lib/stall.ts)
 * serializes same-process callers before proper-lockfile ever gets involved
 * (its retry/backoff is built for cross-process contention, far too slow for
 * N same-process calls racing the same mkdir-based lock).
 */

function mutate<T>(fn: (store: WatchStore) => T): Promise<T> {
  const run = async (): Promise<T> => {
    const path = watchJobsPath();
    await ensureFile(path);
    const release = await lockfile.lock(path, safeLockOptions('watch-jobs', { retries: 5 }));
    try {
      const store = await readStore(path);
      const result = fn(store);
      await writeJsonAtomic(path, store, { spaces: 2 });
      return result;
    } finally {
      await release();
    }
  };

  return withBoundedQueue('watch-jobs', run, { store: 'watch-jobs', target: 'watch-jobs.json' });
}

// Built via fromCharCode rather than a Unicode NUL escape sequence written out
// literally: tool-call round-tripping of such an escape has corrupted source
// files on this machine before, arriving as an actual embedded NUL byte.
const NUL_BYTE = String.fromCharCode(0);

/**
 * Normalize a check path: null when `raw` is not a usable absolute path
 * (not a string, empty, contains a NUL byte, or not absolute); otherwise
 * `resolvePath(raw)`. On win32 `isAbsolute('/x')` is true and `resolvePath`
 * handles both slash styles — that is intended.
 */
function normalizeWatchPath(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes(NUL_BYTE) || !isAbsolute(raw)) {
    return null;
  }
  return resolvePath(raw);
}

// ---------------------------------------------------------------------------
// Validation (SPEC §2.4 — frozen error strings)
// ---------------------------------------------------------------------------

const VALID_CHECK_TYPES: WatchCheckType[] = [
  'file_exists',
  'file_gone',
  'file_newer_than',
  'file_contains',
  'process_gone',
];

export function validateWatchInput(input: WatchInput, now: number = Date.now()): WatchValidation {
  const description = typeof input?.description === 'string' ? input.description.trim() : '';
  if (!description) {
    return { ok: false, error: 'description is required' };
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, error: 'description exceeds 200 characters' };
  }

  const chatId = input?.source?.chatId;
  if (typeof chatId !== 'string' || chatId.length === 0) {
    return { ok: false, error: 'source.chatId is required' };
  }

  const rawType = input?.check?.type;
  if (!VALID_CHECK_TYPES.includes(rawType as WatchCheckType)) {
    return {
      ok: false,
      error: `unknown check type: ${rawType} (allowed: file_exists, file_gone, file_newer_than, file_contains, process_gone)`,
    };
  }
  const type = rawType as WatchCheckType;

  let check: WatchCheck;

  if (type === 'process_gone') {
    const pid = input.check?.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return { ok: false, error: 'check.pid must be a positive integer' };
    }
    check = { type, pid };
  } else {
    const rawPath = input.check?.path;
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      return { ok: false, error: `check.path is required for ${type}` };
    }
    const path = normalizeWatchPath(rawPath);
    if (path === null) {
      return { ok: false, error: 'check.path must be absolute' };
    }

    if (type === 'file_contains') {
      const pattern = input.check?.pattern;
      if (typeof pattern !== 'string' || pattern.length === 0) {
        return { ok: false, error: 'check.pattern is required for file_contains' };
      }
      if (pattern.length > MAX_PATTERN_CHARS) {
        return { ok: false, error: 'check.pattern exceeds 200 characters' };
      }
      try {
        new RegExp(pattern);
      } catch (err: any) {
        return { ok: false, error: `check.pattern is not a valid regular expression: ${err.message}` };
      }
      check = { type, path, pattern };
    } else if (type === 'file_newer_than') {
      let sinceIso: string;
      if (input.check?.sinceIso !== undefined) {
        if (typeof input.check.sinceIso !== 'string' || !Number.isFinite(Date.parse(input.check.sinceIso))) {
          return { ok: false, error: 'check.sinceIso is not a valid ISO timestamp' };
        }
        sinceIso = input.check.sinceIso;
      } else {
        sinceIso = new Date(now).toISOString();
      }
      check = { type, path, sinceIso };
    } else {
      // file_exists | file_gone
      check = { type, path };
    }
  }

  const intervalSeconds = input.intervalSeconds ?? 60;
  const intervalMs = intervalSeconds * 1000;
  if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    return { ok: false, error: 'interval_seconds must be between 60 and 3600' };
  }

  const deadlineMinutes = input.deadlineMinutes ?? 1440;
  if (deadlineMinutes < 1 || deadlineMinutes > 10080) {
    return { ok: false, error: 'deadline_minutes must be between 1 and 10080' };
  }
  const deadlineAt = new Date(now + deadlineMinutes * 60_000).toISOString();

  return { ok: true, value: { description, check, intervalMs, deadlineAt } };
}

// ---------------------------------------------------------------------------
// Check evaluation (SPEC §2.5 — frozen observation strings)
// ---------------------------------------------------------------------------

export async function evaluateCheck(
  check: WatchCheck,
  now: number,
  deps?: { aliveFn?: AliveFn },
): Promise<WatchEvaluation> {
  switch (check.type) {
    case 'file_exists':
    case 'file_gone':
    case 'file_newer_than':
    case 'file_contains': {
      let st;
      try {
        st = await stat(check.path!);
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          if (check.type === 'file_gone') {
            return { met: true, observation: 'gone' };
          }
          return { met: false, observation: 'does not exist' };
        }
        throw err;
      }

      const mtimeIso = new Date(st.mtimeMs).toISOString();

      if (check.type === 'file_exists') {
        return { met: true, observation: `exists (${st.size} bytes, mtime ${mtimeIso})` };
      }

      if (check.type === 'file_gone') {
        return { met: false, observation: `still exists (${st.size} bytes, mtime ${mtimeIso})` };
      }

      if (check.type === 'file_newer_than') {
        const sinceIso = check.sinceIso!;
        if (st.mtimeMs > Date.parse(sinceIso)) {
          return { met: true, observation: `modified at ${mtimeIso} (after ${sinceIso})` };
        }
        return { met: false, observation: `unchanged since ${sinceIso} (mtime ${mtimeIso})` };
      }

      // file_contains
      const scanned = Math.min(st.size, CONTAINS_TAIL_BYTES);
      const buf = Buffer.alloc(scanned);
      if (scanned > 0) {
        const handle = await open(check.path!, 'r');
        try {
          await handle.read(buf, 0, scanned, st.size - scanned);
        } finally {
          await handle.close();
        }
      }
      const text = buf.toString('utf8');
      const lines = text.split(/\r?\n/).slice(-CONTAINS_MAX_LINES);
      const re = new RegExp(check.pattern!);
      for (const raw of lines) {
        const candidate = raw.slice(0, CONTAINS_MAX_LINE_CHARS);
        if (re.test(candidate)) {
          const snippet = candidate.trim().slice(0, CONTAINS_SNIPPET_CHARS);
          return {
            met: true,
            observation: `matched in last ${scanned} bytes of ${st.size}`,
            detail: `Match: ${snippet}`,
          };
        }
      }
      return { met: false, observation: `no match in last ${scanned} bytes of ${st.size}` };
    }

    case 'process_gone': {
      const aliveFn = deps?.aliveFn ?? ((pids: number[]) => areProcessesAlive(pids));
      const alive = await aliveFn([check.pid!]);
      const met = alive.get(check.pid!) !== true;
      if (met) {
        return { met: true, observation: `pid ${check.pid} is no longer running` };
      }
      return { met: false, observation: `pid ${check.pid} is still running` };
    }
  }
}

// ---------------------------------------------------------------------------
// Store operations
// ---------------------------------------------------------------------------

export async function addWatchJob(
  input: WatchInput,
  now: number = Date.now(),
): Promise<{ ok: true; watch: WatchJob } | { ok: false; error: string }> {
  const validation = validateWatchInput(input, now);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  return mutate((store) => {
    const activeCount = store.watches.filter((w) => w.status === 'active').length;
    if (activeCount >= MAX_ACTIVE_WATCHES) {
      return {
        ok: false as const,
        error: 'watch limit reached (25 active) — cancel one with `pa watch rm <id>`',
      };
    }

    const watch: WatchJob = {
      id: `w-${randomBytes(4).toString('hex')}`,
      createdAt: new Date(now).toISOString(),
      description: validation.value.description,
      source: input.source,
      check: validation.value.check,
      intervalMs: validation.value.intervalMs,
      deadlineAt: validation.value.deadlineAt,
      lastCheckedAt: null,
      consecutiveErrors: 0,
      status: 'active',
    };
    store.watches.push(watch);
    log('info', 'watch-jobs', 'watch registered', {
      id: watch.id,
      type: watch.check.type,
      kind: input.source.kind,
      deadlineAt: watch.deadlineAt,
    });
    return { ok: true as const, watch };
  });
}

export async function listWatchJobs(): Promise<WatchJob[]> {
  const path = watchJobsPath();
  await ensureFile(path);
  const store = await readStore(path);
  return store.watches;
}

export async function cancelWatchJob(
  id: string,
  now: number = Date.now(),
): Promise<{ ok: boolean; error?: string }> {
  return mutate((store) => {
    const row = store.watches.find((w) => w.id === id);
    if (!row) {
      return { ok: false, error: `no watch with id ${id}` };
    }
    if (row.status !== 'active') {
      return { ok: false, error: `watch ${id} is already ${row.status}` };
    }
    row.status = 'cancelled';
    row.terminalAt = new Date(now).toISOString();
    return { ok: true };
  });
}

function updateWatch(id: string, patch: Partial<WatchJob>): Promise<void> {
  return mutate((store) => {
    const row = store.watches.find((w) => w.id === id);
    if (row) Object.assign(row, patch);
  });
}

/**
 * The wt: re-register keyboard attached to terminal check-failed/expired reports
 * (WP-D2 B.7). Watch ids are generator-controlled (`w-` + 8 lowercase hex), so the
 * data always parses against WT_RE — no emitter-side grammar guard needed (unlike
 * chains.ts, where the chain name comes from a user file).
 */
function reRegisterKeyboard(id: string): Record<string, unknown> {
  return { inline_keyboard: [[{ text: '🔁 Re-register watch', callback_data: `wt:${id}:r` }]] };
}

/**
 * Send one terminal report. The body reaches the operator's own chat UNREDACTED
 * (AI-184, 2026-09-03 — supersedes SPEC §2.6's send-side scrub for the delivered
 * body: redacting here scrubbed the operator's name out of their own chat). The
 * scrub survives on the persistence side: the stored `outcome` stays redacted.
 * Never throws — a notify rejection maps to a not-delivered result so the
 * caller's send-then-persist decision still runs.
 * replyMarkup (WP-D2 B.7) rides the send when provided.
 */
async function sendReport(
  subject: string,
  rawBody: string,
  dedupKey: string,
  severity: 'info' | 'warn' | 'error',
  topic: { chat_id: string; thread_id?: number } | undefined,
  notify: WatchNotifyFn,
  replyMarkup?: Record<string, unknown>,
): Promise<{ delivered: boolean; outcome: string }> {
  const body = rawBody;
  let result: { sent: boolean; suppressed: boolean };
  try {
    result = await notify(subject, body, { dedupKey, topic, severity, replyMarkup });
  } catch {
    result = { sent: false, suppressed: false };
  }
  const delivered = result.sent === true || result.suppressed === true;
  const outcome = (redactSecrets(`${subject}\n${body}`) as string).slice(0, OUTCOME_MAX_CHARS);
  return { delivered, outcome };
}

/**
 * WP-D2 ADDITION (operator directive, 2026-09-02): a terminal watch outcome must
 * ACT, not just report. Success ⇒ one `wave_done` event on the registering topic
 * (the report itself is the notification — no task). Failure ⇒ a `task_failed`
 * event AND an auto-filed reaction task to the registering topic, so the bot's
 * executor lane dispatches the diagnosis instead of the report dying unread, then
 * a `task_queued` event for the new task. ALL best-effort: never throws, never
 * blocks the tick, and adds NO fields to WatchTickResult (its shape is frozen —
 * the 'never throws when store path is a directory' test deepEquals it).
 */
async function actOnTerminalOutcome(w: WatchJob, failureReason: string | null): Promise<void> {
  const chatId = Number(w.source.chatId);
  const threadId = w.source.threadId;
  if (!Number.isFinite(chatId)) return; // never a valid topic target
  try {
    if (failureReason === null) {
      await appendTopicEvent(chatId, threadId, {
        kind: 'wave_done',
        ref: w.id,
        detail: w.description,
      });
      return;
    }
    await appendTopicEvent(chatId, threadId, {
      kind: 'task_failed',
      ref: w.id,
      detail: failureReason,
    });
    // Title <=80 chars single line; description is already stored single-line but
    // normalize whitespace anyway before the slice.
    const desc = w.description.replace(/\s+/g, ' ').trim();
    const title = `Watch ${w.id} failed: ${desc}`.slice(0, TOPIC_TASK_MAX_TITLE_CHARS);
    const reg = await appendTask(chatId, threadId, {
      title,
      prompt: `Your watch ${w.id} failed its check — diagnose, retry, or ask the operator`,
      createdBy: 'watch-system',
    });
    await appendTopicEvent(chatId, threadId, {
      kind: 'task_queued',
      ref: reg.id,
      detail: reg.deduped ? `auto-filed by watch ${w.id} (deduped)` : `auto-filed by watch ${w.id}`,
    });
  } catch (err: any) {
    log('warn', 'watch-jobs', 'terminal-outcome action failed (best-effort)', {
      id: w.id,
      error: String(err?.message ?? err),
    });
  }
}

// ---------------------------------------------------------------------------
// Tick engine (SPEC §4.1 — FROZEN algorithm)
// ---------------------------------------------------------------------------

export async function runWatchTick(opts: RunWatchTickOptions = {}): Promise<WatchTickResult> {
  const now = opts.now ?? Date.now();
  const notify = opts.notify ?? notifyUser;
  const result: WatchTickResult = { checked: 0, reported: 0, expired: 0, failed: 0, forced: 0, pruned: 0 };

  try {
    const path = watchJobsPath();
    await ensureFile(path);
    const store = await readStore(path);

    const due = store.watches
      .filter((w) => w.status === 'active')
      .filter((w) => w.lastCheckedAt === null || now - Date.parse(w.lastCheckedAt) >= w.intervalMs)
      .sort((a, b) => {
        if (a.lastCheckedAt === null) return b.lastCheckedAt === null ? 0 : -1;
        if (b.lastCheckedAt === null) return 1;
        return Date.parse(a.lastCheckedAt) - Date.parse(b.lastCheckedAt);
      })
      .slice(0, MAX_CHECKS_PER_TICK);

    for (const w of due) {
      // SEQUENTIALLY — D: is a 5400rpm HDD, never Promise.all.
      result.checked++;
      const nowIso = new Date(now).toISOString();
      const topic = { chat_id: w.source.chatId, thread_id: w.source.threadId };

      // (a) force-terminal — a terminal send that has never confirmed for
      // 3 days past the deadline.
      if (now >= Date.parse(w.deadlineAt) + FORCE_TERMINAL_GRACE_MS) {
        log('error', 'watch-jobs', 'watch force-terminaled', {
          id: w.id,
          description: w.description,
          deadlineAt: w.deadlineAt,
        });
        await sendReport(
          `Watch force-terminaled: ${w.id}`,
          `${w.description}\nDeadline ${w.deadlineAt} + 3 days passed with no confirmed report send.`,
          `watch-force-terminal:${w.id}`,
          'error',
          undefined,
          notify,
        );
        await updateWatch(w.id, {
          status: 'check-failed',
          terminalAt: nowIso,
          lastError: 'terminal send never confirmed within 3 days of deadline',
        });
        result.forced++;
        // ADDITION failure lane: the watch is terminaled regardless of send
        // delivery here, so the reaction task files unconditionally too.
        await actOnTerminalOutcome(w, 'terminal send never confirmed within 3 days of deadline');
        continue;
      }

      // (b) evaluate
      let ev: WatchEvaluation;
      try {
        ev = await evaluateCheck(w.check, now, { aliveFn: opts.aliveFn });
      } catch (err: any) {
        const errors = w.consecutiveErrors + 1;
        const lastError = String(err?.message ?? err).slice(0, LAST_ERROR_MAX_CHARS);
        if (errors >= ERROR_LADDER_LIMIT) {
          const { delivered, outcome } = await sendReport(
            `⚠️ Watch check failing: ${w.description}`,
            `5 consecutive check errors — giving up.\nLast error: ${lastError}\nWatch ${w.id} · registered ${w.createdAt}`,
            `watch:${w.id}:check-failed`,
            'warn',
            topic,
            notify,
            reRegisterKeyboard(w.id),
          );
          if (delivered) {
            await updateWatch(w.id, {
              status: 'check-failed',
              terminalAt: nowIso,
              lastCheckedAt: nowIso,
              consecutiveErrors: errors,
              lastError,
              outcome,
            });
            result.failed++;
            // ADDITION failure lane (WP-D2, 2026-09-02): the executor lane reacts.
            await actOnTerminalOutcome(w, `5 consecutive check errors: ${lastError}`);
          } else {
            await updateWatch(w.id, { lastCheckedAt: nowIso, consecutiveErrors: errors, lastError });
          }
        } else {
          await updateWatch(w.id, { lastCheckedAt: nowIso, consecutiveErrors: errors, lastError });
        }
        continue; // errors NEVER page per-tick (D3)
      }

      // (c) met wins over the deadline
      if (ev.met) {
        const body =
          ev.observation + (ev.detail ? `\n${ev.detail}` : '') + `\nWatch ${w.id} · registered ${w.createdAt}`;
        const { delivered, outcome } = await sendReport(
          `✅ Watch complete: ${w.description}`,
          body,
          `watch:${w.id}:reported`,
          'info',
          topic,
          notify,
        );
        if (delivered) {
          await updateWatch(w.id, {
            status: 'reported',
            terminalAt: nowIso,
            lastCheckedAt: nowIso,
            consecutiveErrors: 0,
            lastObservation: ev.observation,
            outcome,
          });
          result.reported++;
          // ADDITION success lane (WP-D2, 2026-09-02): the report IS the
          // notification — only the wave_done event is added.
          await actOnTerminalOutcome(w, null);
        } else {
          await updateWatch(w.id, {
            lastCheckedAt: nowIso,
            consecutiveErrors: 0,
            lastObservation: ev.observation,
          });
        }
        continue;
      }

      // (d) deadline reached, condition still false — the mandatory branch
      if (now >= Date.parse(w.deadlineAt)) {
        await updateWatch(w.id, { lastObservation: ev.observation }); // so the body reads current state
        const body = `Deadline ${w.deadlineAt} passed.\nLast observed: ${ev.observation}\nWatch ${w.id} · registered ${w.createdAt}`;
        const { delivered, outcome } = await sendReport(
          `⏰ Watch expired without completing: ${w.description}`,
          body,
          `watch:${w.id}:expired`,
          'warn',
          topic,
          notify,
          reRegisterKeyboard(w.id),
        );
        if (delivered) {
          await updateWatch(w.id, {
            status: 'expired',
            terminalAt: nowIso,
            lastCheckedAt: nowIso,
            consecutiveErrors: 0,
            outcome,
          });
          result.expired++;
          // ADDITION failure lane (WP-D2, 2026-09-02): expiry is a terminal
          // failure to complete — the executor lane reacts.
          await actOnTerminalOutcome(w, `deadline ${w.deadlineAt} passed without completing`);
        } else {
          await updateWatch(w.id, { lastCheckedAt: nowIso, consecutiveErrors: 0 });
        }
        continue;
      }

      // (e) still pending
      await updateWatch(w.id, { lastCheckedAt: nowIso, consecutiveErrors: 0, lastObservation: ev.observation });
    }

    // prune, one final mutate — always reads FRESH state (per-row updates
    // above happened through their own locked mutate() calls, so the `store`
    // read at the top of this function is stale by now).
    const pruned = await mutate((s) => {
      const before = s.watches.length;
      s.watches = s.watches.filter((w) => {
        if (w.status === 'active') return true;
        if (!w.terminalAt) return true;
        return Date.parse(w.terminalAt) >= now - TERMINAL_RETENTION_MS;
      });
      return before - s.watches.length;
    });
    result.pruned = pruned;

    return result;
  } catch (err: any) {
    log('error', 'watch-jobs', 'runWatchTick failed', { error: String(err?.message ?? err) });
    return { checked: 0, reported: 0, expired: 0, failed: 0, forced: 0, pruned: 0 };
  }
}
