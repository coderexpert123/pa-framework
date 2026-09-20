/**
 * Orchestrator execution-thread store (AI-203).
 *
 * One spawned CLI conversation per thread, tracked per topic under
 * `<paHome>/topic-threads/<chatId>_<threadId>.json`. The orchestrator mode's
 * spawned threads are interactive session-bearing executors — unlike the task
 * lane they carry a session, accept steering, and report back into the topic —
 * so they get their own store rather than reusing topic-tasks machinery.
 *
 * Single-writer by design (only the bot process, single-instance via
 * telegram-bot.lock). Every write for a topic serializes through a per-key
 * promise chain; reads see whole files only (writeFileAtomic renames are
 * atomic, never torn). Corrupt/unreadable files fail to empty with a logged
 * warning — a wedged store must never take the topic down with it.
 */
import { mkdir, readdir, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { appendTopicEvent } from '../../../pa/dist/src/lib/topic-events.js';
import { writeFileAtomic } from '../../../pa/dist/src/lib/atomic-write.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import type { SessionInfo } from './types.js';
// Router-metadata wave (2026-09-20): ThreadRecord.routing's shape. TYPE-ONLY
// import — dispatch.ts never imports this module, so no cycle exists even at
// type level (dispatch.ts is the vocabulary's single producer; this store only
// persists and the executor re-emits it into getEnv).
import type { TurnRoutingMeta } from './dispatch.js';

// Machine-profile tunables (big machines raise; see pa doctor): parsed once at
// module load; a missing, non-numeric, or < 1 value falls back to the default.
function intEnv(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

// increment 4: overflow queues (createThread parks as 'queued'); the claim is the only queued→running transition
export const MAX_RUNNING_THREADS_PER_TOPIC = intEnv('PA_MAX_RUNNING_THREADS_PER_TOPIC', 10);
export const MAX_THREADS_PER_TOPIC = intEnv('PA_MAX_THREADS_PER_TOPIC', 20); // prune oldest terminal at create; never prune running
export const MAX_PENDING_INPUT_PER_THREAD = 5;
export const TOPIC_THREAD_STALE_MS = 30 * 60 * 1000; // lazy demotion on read
export const THREAD_ACTIVITY_THROTTLE_MS = 10_000; // executor pump write throttle
// AI-232: cap on how many dependencies a single record may name at creation.
export const MAX_DEPENDS_ON_PER_THREAD = 5;

/** Frozen record shape (AI-203 spec §4.3). */
export interface ThreadRecord {
  id: string; // `t-<n>`; n is per-topic, monotonically increasing, never reused
  n: number;
  title: string; // 1..80 chars
  goal: string; // the original spawn prompt, 1..4000 chars (re-spawn after session expiry/restart)
  status: 'running' | 'queued' | 'done' | 'failed' | 'cancelled'; // queued = record exists, executor not fired, waiting for a free slot (FIFO by n)
  createdAt: string; // ISO
  updatedAt: string; // ISO — bumped by the activity pump; drives lazy stale demotion
  workdir: string; // absolute; resolved topic workdir captured at spawn
  session?: SessionInfo; // captured on first successful run
  runSeq: number; // bumped at every dispatch start; executor's ownership gate
  attempts: number; // failed attempts on the current goal
  lastError?: string; // redactSecrets'd, <=300 chars
  lastResult?: string; // redactSecrets'd, uncapped (since 2026-09-13), set on done
  pendingInput: string[]; // steer messages awaiting delivery, each 1..4000 chars
  voiceTaskIds?: string[]; // voice-inbox task ids (vi-...) this spawn is routed from — the ask-mirroring stamp; best-effort, additive (old stores load fine)
  /** AI-232: ids of threads in THIS topic that must reach 'done' before this record
   *  may start. Optional and additive (old stores load fine). Written only at
   *  createThread time and never mutated. Shaped for generalization: the predicate
   *  below takes a lookup function, not this store's Map, so a future
   *  backlog-item-keyed scheduler reuses it verbatim with a different lookup. */
  dependsOn?: string[];
  /** Parked-wait stamp (ISO): a queued record waits out a future stamp before
   *  it may claim. Writers: the wall-park (worker-unavailability backoff ladder,
   *  2026-09-12) and demoteStale's restart-requeue (5-minute grace, 2026-09-13).
   *  claimThreadStarts skips a queued record whose stamp is in the future.
   *  Absent/past/unparseable = claimable. Additive (old stores load fine). Never
   *  cleared by code — a terminal record's stamp is always past by construction
   *  (a terminal outcome requires a claim, which requires the stamp to have
   *  passed); the claim filter is its only reader. */
  parkedUntil?: string;
  /** Wall-park (2026-09-12): consecutive availability parks in the CURRENT
   *  episode; reset to 0 by every outcome write in the executor (done/retry/
   *  failed patches). Drives the executor's backoff ladder and its terminal
   *  valve. Additive. */
  unavailableParks?: number;
  /** AI-203 WP-2 (item 4): optional per-thread worker pin (claude/zclaude/agy/
   *  codex). Set at createThread time from the orchestrator's validated
   *  spawn_thread.worker. The executor passes it as dispatchOpts.preferredWorker
   *  so the thread runs on the pinned worker instead of the cascade default.
   *  Additive (old stores load fine — absent = cascade default). */
  worker?: string;
  /** Evangelism WP-7 (OD-4, 2026-09-16): optional per-thread MODEL pin. Set at
   *  createThread time from the orchestrator's validated spawn_thread.model
   *  (grammar /^[a-zA-Z0-9._-]{1,64}$/). The executor folds it into
   *  buildTopicTierExtraArgs' overrides slot — highest precedence, last-wins
   *  over topic tunable_defaults and the worker's static model arg. Additive
   *  (old stores load fine — absent = no pin). */
  model?: string;
  /** AI-203 WP-2 (item 2): a pending clarifying question a NON-voice thread
   *  emitted via a PA_META `question` action. Set by setPendingQuestion (only
   *  while status is running/done), cleared by takePendingQuestion when the
   *  operator presses an `rq:` option button (WP-3's callback handler). The
   *  thread is NOT blocked by a pending question — it continues to done; this
   *  is passive state the callback resolves. Additive (old stores load fine). */
  pendingQuestion?: { text: string; options: string[] };
  /** Router-metadata wave (2026-09-20, §1.2): the ORIGIN turn's routing
   *  provenance (TurnRoutingMeta), stamped into every dispatch's env by the
   *  executor's getEnv (buildRoutingProvenanceEnv). Persisted — NOT a closure —
   *  because a queued/parked thread may start minutes after the origin turn.
   *  Set at createThread time from the spawn's HandleSpawnArgs.routing;
   *  old stores load fine (additive — the dependsOn precedent), absent = no
   *  PA_ROUTING_* keys on the thread's dispatches. */
  routing?: TurnRoutingMeta;
}

let storeDirOverride: string | undefined;

function paHome(): string {
  return process.env.PA_HOME ?? join(homedir(), '.pa');
}

function storeDir(): string {
  return storeDirOverride ?? join(paHome(), 'topic-threads');
}

function storePath(key: string): string {
  return join(storeDir(), `${key}.json`);
}

/** Per-key promise chain — all read-modify-write cycles for one topic serialize. */
const chains = new Map<string, Promise<void>>();

function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  chains.set(key, gate);
  return (async () => {
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (chains.get(key) === gate) chains.delete(key);
    }
  })();
}

/**
 * Load one topic's records. Absent file ⇒ empty (normal). Corrupt/unreadable
 * ⇒ fail-to-empty + warn — never a throw into the dispatch path.
 */
async function load(key: string): Promise<Map<string, ThreadRecord>> {
  const map = new Map<string, ThreadRecord>();
  let raw: string;
  try {
    raw = await readFile(storePath(key), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.warn('topic-threads', 'store unreadable, treating as empty', {
        key,
        error: (err as Error).message,
      });
    }
    return map;
  }
  try {
    const obj = JSON.parse(raw) as Record<string, ThreadRecord>;
    for (const [id, rec] of Object.entries(obj)) map.set(id, rec);
  } catch (err) {
    logger.warn('topic-threads', 'store corrupt, treating as empty', {
      key,
      error: (err as Error).message,
    });
  }
  return map;
}

async function persist(key: string, map: Map<string, ThreadRecord>): Promise<void> {
  const dir = storeDir();
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(storePath(key), JSON.stringify(Object.fromEntries(map), null, 2));
}

/** Restart-requeue grace: a record demoted back to `queued` waits this long
 *  before the claim funnel may pick it up — one gentle cycle of separation
 *  between the demotion and the re-dispatch (2026-09-13). */
export const RESTART_PARK_GRACE_MS = 5 * 60 * 1000;

/**
 * The restart-park field shape — SINGLE SOURCE for every writer that requeues
 * a crashed/restarted run (`demoteStale`'s lazy sweep and the orphan-reaper's
 * settleOrphanedThread demote, AI-228). A crash is not an attempt outcome:
 * `attempts`/`unavailableParks`/`pendingInput` are deliberately NOT in this
 * shape — callers must not add them (the requeue preserves queued steer input
 * and the wall-park episode counters verbatim). `reason` is the only
 * writer-specific part: name the evidence, never a duration you did not
 * measure.
 */
export function restartParkFields(
  nowMs: number,
  reason: string,
): Pick<ThreadRecord, 'status' | 'lastError' | 'parkedUntil' | 'updatedAt'> {
  return {
    status: 'queued',
    lastError: `restart-parked: ${reason} — auto-requeued`.slice(0, 300),
    parkedUntil: new Date(nowMs + RESTART_PARK_GRACE_MS).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Running records wedged past TOPIC_THREAD_STALE_MS REQUEUE instead of failing
 * (lazy, on read). The executor lives in this process, so a 30-min-silent run
 * means the bot restarted or crashed under it — the work itself is still
 * wanted. The record goes back to `queued` with a restart-parked lastError and
 * a 5-minute parkedUntil, so the claim pass that did the demotion skips it for
 * one gentle cycle before re-claiming; the re-claim's own thread FYI is the
 * visibility (no separate notification). Queued records are exempt — no
 * executor means no pump, and a healthy queued record is revived by the
 * reconcile drain (increment 4), never demoted.
 */
function demoteStale(map: Map<string, ThreadRecord>): boolean {
  const now = Date.now();
  let changed = false;
  for (const rec of map.values()) {
    if (rec.status !== 'running') continue;
    const updated = Date.parse(rec.updatedAt);
    if (!Number.isFinite(updated) || now - updated < TOPIC_THREAD_STALE_MS) continue;
    // The park stamp and gate already exist (wall-park); unavailableParks is
    // the worker-unavailability counter and is deliberately untouched here.
    Object.assign(rec, restartParkFields(
      now,
      `no activity for ${Math.round(TOPIC_THREAD_STALE_MS / 60000)}m (bot restart or crash)`,
    ));
    changed = true;
  }
  return changed;
}

export type CreateThreadResult =
  | { ok: true; thread: ThreadRecord }
  | { ok: false; reason: string };

export type DependencyState = 'satisfied' | 'blocked' | 'unsatisfiable';

/** Pure. 'satisfied' when every id resolves to status 'done' (or the list is
 *  empty); 'unsatisfiable' when any id resolves to 'failed'/'cancelled' or does
 *  not resolve at all (a dependency referenced by a live record is prune-protected,
 *  so an unresolvable id means a corrupt/hand-edited store — never an infinite wait);
 *  'blocked' otherwise. 'unsatisfiable' outranks 'blocked'. */
export function resolveDependencyState(
  dependsOn: string[] | undefined,
  lookup: (id: string) => { status: ThreadRecord['status'] } | undefined,
): DependencyState {
  if (!dependsOn || dependsOn.length === 0) return 'satisfied';
  let blocked = false;
  for (const id of dependsOn) {
    const resolved = lookup(id);
    if (!resolved || resolved.status === 'failed' || resolved.status === 'cancelled') {
      return 'unsatisfiable';
    }
    if (resolved.status !== 'done') blocked = true;
  }
  return blocked ? 'blocked' : 'satisfied';
}

/** The first id whose resolution made the state 'unsatisfiable', with the status it
 *  resolved to ('missing' when it did not resolve). Used for the cancel reason. */
export function firstUnsatisfiableDependency(
  dependsOn: string[] | undefined,
  lookup: (id: string) => { status: ThreadRecord['status'] } | undefined,
): { id: string; status: ThreadRecord['status'] | 'missing' } | null {
  if (!dependsOn) return null;
  for (const id of dependsOn) {
    const resolved = lookup(id);
    if (!resolved) return { id, status: 'missing' };
    if (resolved.status === 'failed' || resolved.status === 'cancelled') {
      return { id, status: resolved.status };
    }
  }
  return null;
}

/** The vi- id shape the voice-inbox bridge stamps into injection texts. */
export const VOICE_TASK_ID_RE = /^vi-[0-9a-f]{12}$/;
/** Mirror stamp cap: a batched spawn names at most this many voice tasks. */
export const MAX_VOICE_TASK_IDS = 5;

/**
 * Fail-open sanitation of the ask-mirroring stamp: keep only well-formed,
 * de-duplicated ids (cap 5); drop everything else silently with a logged
 * count. The mirror is best-effort — a malformed stamp must never reject a
 * spawn that would otherwise run.
 */
function sanitizeVoiceTaskIds(raw: string[] | undefined): string[] | undefined {
  if (!raw) return undefined;
  const seen = new Set<string>();
  for (const id of raw) {
    if (typeof id === 'string' && VOICE_TASK_ID_RE.test(id) && !seen.has(id)) {
      seen.add(id);
      if (seen.size >= MAX_VOICE_TASK_IDS) break;
    }
  }
  const dropped = raw.length - seen.size;
  if (dropped > 0) {
    logger.info('topic-threads', `dropped ${dropped} invalid/duplicate voice task id(s) from the spawn stamp; ask mirroring is best-effort`);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

/**
 * Fail-open sanitation of a spawn's `dependsOn`: keep only well-formed
 * `t-<n>` ids that EXIST in the loaded map, de-duplicated, capped at
 * MAX_DEPENDS_ON_PER_THREAD; drop the rest with one logged count. Modelled
 * line-for-line on sanitizeVoiceTaskIds — a bad dependsOn must never reject a
 * spawn that would otherwise run, it degrades to no dependsOn instead.
 */
function sanitizeDependsOn(raw: string[] | undefined, map: Map<string, ThreadRecord>): string[] | undefined {
  if (!raw) return undefined;
  const seen = new Set<string>();
  for (const id of raw) {
    if (typeof id === 'string' && /^t-\d+$/.test(id) && map.has(id) && !seen.has(id)) {
      seen.add(id);
      if (seen.size >= MAX_DEPENDS_ON_PER_THREAD) break;
    }
  }
  const dropped = raw.length - seen.size;
  if (dropped > 0) {
    logger.info('topic-threads', `dropped ${dropped} invalid/duplicate/unknown dependsOn id(s) from the spawn`);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

export async function createThread(
  key: string,
  init: { title: string; goal: string; workdir: string; voiceTaskIds?: string[]; dependsOn?: string[]; worker?: string; model?: string; routing?: TurnRoutingMeta },
): Promise<CreateThreadResult> {
  const title = init.title.trim();
  const goal = init.goal.trim();
  if (title.length < 1 || title.length > 80) return { ok: false, reason: 'title must be 1..80 chars' };
  if (goal.length < 1 || goal.length > 4000) return { ok: false, reason: 'goal must be 1..4000 chars' };
  if (!init.workdir.trim()) return { ok: false, reason: 'workdir is required' };
  return withKeyLock(key, async () => {
    const map = await load(key);
    let running = 0;
    for (const rec of map.values()) if (rec.status === 'running') running++;
    // increment 4: the cap parks instead of rejecting ("no rejections, ever") —
    // claimThreadStarts is the only path that flips a parked record to running.
    // AI-232: an unmet dependency parks the record too, via the same funnel.
    const deps = sanitizeDependsOn(init.dependsOn, map);
    const depState = resolveDependencyState(deps, (id) => map.get(id));
    const status: ThreadRecord['status'] =
      running >= MAX_RUNNING_THREADS_PER_TOPIC || depState !== 'satisfied' ? 'queued' : 'running';
    let maxN = 0;
    for (const rec of map.values()) if (rec.n > maxN) maxN = rec.n;
    const n = maxN + 1;
    const now = new Date().toISOString();
    const voiceTaskIds = sanitizeVoiceTaskIds(init.voiceTaskIds);
    // AI-203 WP-2 (item 4): store the validated worker pin on the record.
    // The orchestrator's validateSpawnThreadAction already checked the shape
    // (≤16 chars, /^[a-z0-9_-]+$/i); a non-string/empty value degrades to no
    // pin (cascade default) rather than rejecting an otherwise-valid spawn.
    const worker = typeof init.worker === 'string' && init.worker.trim().length >= 1
      ? init.worker.trim()
      : undefined;
    // WP-7: same degrade-to-absent treatment for the model pin — the
    // orchestrator already grammar-checked it; a non-string/empty value just
    // means no pin.
    const model = typeof init.model === 'string' && init.model.trim().length >= 1
      ? init.model.trim()
      : undefined;
    const thread: ThreadRecord = {
      id: `t-${n}`,
      n,
      title,
      goal,
      status,
      createdAt: now,
      updatedAt: now,
      workdir: init.workdir,
      runSeq: 0,
      attempts: 0,
      pendingInput: [],
      ...(voiceTaskIds ? { voiceTaskIds } : {}),
      ...(deps ? { dependsOn: deps } : {}),
      ...(worker ? { worker } : {}),
      ...(model ? { model } : {}),
      ...(init.routing ? { routing: init.routing } : {}),
    };
    map.set(thread.id, thread);
    // Cap total records: prune lowest-n terminal first (n is per-topic
    // monotonic, so lowest n = oldest); running and queued records are never
    // pruned (queued is waiting work — increment 4).
    // AI-232 (C-4): also protect any terminal record still referenced by a
    // live (running/queued) record's dependsOn — pruning it would leave the
    // dependent parked forever (or, under a naive rule, wrongly cancelled).
    while (map.size > MAX_THREADS_PER_TOPIC) {
      const referenced = new Set<string>();
      for (const rec of map.values()) {
        if (rec.status !== 'running' && rec.status !== 'queued') continue;
        for (const dep of rec.dependsOn ?? []) referenced.add(dep);
      }
      let victim: ThreadRecord | null = null;
      for (const rec of map.values()) {
        if (rec.status === 'running') continue;
        if (rec.status === 'queued') continue;
        if (referenced.has(rec.id)) continue;
        if (!victim || rec.n < victim.n) victim = rec;
      }
      if (!victim) break; // no terminal victim (all running/queued/referenced) — keep the store oversize, never delete waiting work
      map.delete(victim.id);
    }
    await persist(key, map);
    return { ok: true, thread };
  });
}

/** All records for the topic, after lazy stale demotion (persisted so the running cap frees up). */
export async function listThreads(key: string): Promise<ThreadRecord[]> {
  return withKeyLock(key, async () => {
    const map = await load(key);
    if (demoteStale(map)) await persist(key, map);
    return [...map.values()];
  });
}

/** Single record, as stored (no demotion — lifecycle transitions belong to the executor). */
export async function getThread(key: string, id: string): Promise<ThreadRecord | undefined> {
  return (await load(key)).get(id);
}

export type QueueInputResult = { ok: true } | { ok: false; reason: string };

/**
 * Queue a steer message for delivery by the executor. Does NOT flip a
 * terminal thread back to running — the executor owns status transitions.
 */
export async function queueThreadInput(key: string, id: string, text: string): Promise<QueueInputResult> {
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > 4000) {
    return { ok: false, reason: 'message must be 1..4000 chars' };
  }
  return withKeyLock(key, async () => {
    const map = await load(key);
    const rec = map.get(id);
    if (!rec) return { ok: false, reason: `unknown thread ${id}` };
    if (rec.pendingInput.length >= MAX_PENDING_INPUT_PER_THREAD) {
      return { ok: false, reason: `pending input is full (${MAX_PENDING_INPUT_PER_THREAD} max)` };
    }
    rec.pendingInput.push(trimmed);
    rec.updatedAt = new Date().toISOString();
    await persist(key, map);
    return { ok: true };
  });
}

/**
 * ATOMIC take: read + clear one thread's pendingInput under the same per-key
 * lock queueThreadInput writes under, and return the cleared array (order
 * preserved). [] when the thread is unknown or has nothing queued. Stamps
 * updatedAt when it took ≥1 input (a thread receiving steer input is alive —
 * keeps the stale-demotion clock honest); no write when it took none. Never
 * throws. Closes the lost-input window the executor's 3-pass re-read loop
 * could only narrow.
 */
export async function takePendingInput(key: string, id: string): Promise<string[]> {
  return withKeyLock(key, async () => {
    const map = await load(key);
    const rec = map.get(id);
    if (!rec || rec.pendingInput.length === 0) return [];
    const taken = rec.pendingInput;
    rec.pendingInput = [];
    rec.updatedAt = new Date().toISOString();
    try {
      await persist(key, map);
    } catch (err) {
      // The clear did not land — the inputs are still durably queued, so the
      // honest answer is "nothing was taken" (load()'s fail-to-empty
      // precedent); the next take picks them up.
      logger.warn('topic-threads', `takePendingInput persist failed; inputs stay queued: ${(err as Error).message}`, { key, id });
      return [];
    }
    return taken;
  });
}

/**
 * AI-203 WP-2 (item 2): set a pending clarifying question on a NON-voice
 * thread's record. Under the per-key lock: only when the record exists AND
 * its status is `running` or `done` (a question on a queued/cancelled/failed
 * record has no live executor to receive the answer); stamps `updatedAt`.
 * Returns false when the record is absent or not in a question-accepting
 * state. Never throws. The question is passive state — the thread continues
 * to `done` regardless; `takePendingQuestion` (WP-3's callback handler) is
 * the only reader that clears it.
 */
export async function setPendingQuestion(
  key: string,
  id: string,
  question: { text: string; options: string[] },
): Promise<boolean> {
  return withKeyLock(key, async () => {
    const map = await load(key);
    const rec = map.get(id);
    if (!rec) return false;
    if (rec.status !== 'running' && rec.status !== 'done') return false;
    rec.pendingQuestion = question;
    rec.updatedAt = new Date().toISOString();
    try {
      await persist(key, map);
    } catch (err) {
      logger.warn('topic-threads', `setPendingQuestion persist failed: ${(err as Error).message}`, { key, id });
      return false;
    }
    return true;
  });
}

/**
 * AI-203 WP-2 (item 2): atomic read-and-clear of a thread's pendingQuestion
 * under the same per-key lock setPendingQuestion writes under. Returns the
 * question when one was set, undefined when absent or already answered (the
 * idempotent no-op that makes a stale `rq:` button press graceful). Stamps
 * `updatedAt` when it took a question (the record is alive — an answer is
 * steer input). Never throws.
 */
export async function takePendingQuestion(
  key: string,
  id: string,
): Promise<{ text: string; options: string[] } | undefined> {
  return withKeyLock(key, async () => {
    const map = await load(key);
    const rec = map.get(id);
    if (!rec || !rec.pendingQuestion) return undefined;
    const taken = rec.pendingQuestion;
    rec.pendingQuestion = undefined;
    rec.updatedAt = new Date().toISOString();
    try {
      await persist(key, map);
    } catch (err) {
      // The clear did not land — the question is still set, so the honest
      // answer is "nothing was taken" (takePendingInput's precedent); the
      // next take picks it up.
      logger.warn('topic-threads', `takePendingQuestion persist failed; question stays set: ${(err as Error).message}`, { key, id });
      return undefined;
    }
    return taken;
  });
}

/**
 * Bump the ownership gate and return the new value so the executor can
 * capture it atomically with the bump (capture-then-dispatch ownership).
 * Undefined when the record is gone.
 */
export async function bumpRunSeq(key: string, id: string): Promise<number | undefined> {
  return withKeyLock(key, async () => {
    const map = await load(key);
    const rec = map.get(id);
    if (!rec) return undefined;
    rec.runSeq += 1;
    rec.updatedAt = new Date().toISOString();
    await persist(key, map);
    return rec.runSeq;
  });
}

/** Shallow-merge a patch onto the record and stamp updatedAt. No-op when absent. */
export async function updateThread(key: string, id: string, patch: Partial<ThreadRecord>): Promise<void> {
  await withKeyLock(key, async () => {
    const map = await load(key);
    const rec = map.get(id);
    if (!rec) return;
    Object.assign(rec, patch);
    rec.updatedAt = new Date().toISOString();
    await persist(key, map);
  });
}

/** Throttled activity pump target: bump updatedAt only when it has aged past the throttle. */
export async function touchThread(key: string, id: string): Promise<void> {
  await withKeyLock(key, async () => {
    const map = await load(key);
    const rec = map.get(id);
    if (!rec) return;
    const updated = Date.parse(rec.updatedAt);
    if (Number.isFinite(updated) && Date.now() - updated < THREAD_ACTIVITY_THROTTLE_MS) return;
    rec.updatedAt = new Date().toISOString();
    await persist(key, map);
  });
}

/**
 * Conditional settle for the startup orphan-thread reaper (AI-228). Under the
 * per-key lock the record is re-loaded fresh (bumpRunSeq's pattern, not the
 * caller's stale copy) and the patch is applied ONLY while the record is still
 * `running` AND still on the runSeq the reaper adopted — the idempotency
 * primitive: a settle racing a claim, a /stop cancel, a demoteStale requeue or
 * a terminal settle is a clean no-op, and a second reaper pass over an
 * already-settled store writes nothing. Returns whether it wrote. Stamps
 * updatedAt on a write (last like updateThread — the settle time feeds the
 * late voice-closure sweep's grace clock). Does NOT emit topic events — the
 * caller owns visibility, matching cancelOneThread's split.
 */
export async function settleOrphanedThread(
  key: string,
  id: string,
  expectedRunSeq: number,
  patch: Partial<ThreadRecord>,
): Promise<boolean> {
  return withKeyLock(key, async () => {
    const map = await load(key);
    const rec = map.get(id);
    if (!rec) return false;
    if (rec.status !== 'running' || rec.runSeq !== expectedRunSeq) return false;
    Object.assign(rec, patch);
    rec.updatedAt = new Date().toISOString();
    await persist(key, map);
    return true;
  });
}

/**
 * AI-232 cascade: cancel every live record whose dependencies can never be met.
 * Ascending `n` in ONE pass is transitively complete: `dependsOn` is written only at
 * creation and a new record has no dependents, so every edge points to a lower `n`.
 * Returns the records it flipped (for event emission by the caller). Mutates `map`;
 * the caller persists.
 */
function cascadeUnsatisfiable(map: Map<string, ThreadRecord>): Array<{ rec: ThreadRecord; dep: { id: string; status: string } }> {
  const flipped: Array<{ rec: ThreadRecord; dep: { id: string; status: string } }> = [];
  const now = new Date().toISOString();
  for (const rec of [...map.values()].sort((a, b) => a.n - b.n)) {
    if (rec.status !== 'queued') continue;
    if (!rec.dependsOn || rec.dependsOn.length === 0) continue;
    const state = resolveDependencyState(rec.dependsOn, (id) => map.get(id));
    if (state !== 'unsatisfiable') continue;
    const dep = firstUnsatisfiableDependency(rec.dependsOn, (id) => map.get(id));
    if (!dep) continue; // unreachable given state === 'unsatisfiable', kept defensive
    rec.status = 'cancelled';
    rec.lastError = `dependency ${dep.id} ended ${dep.status}; cancelled instead of waiting (AI-232)`.slice(0, 300);
    rec.updatedAt = now;
    flipped.push({ rec, dep });
  }
  return flipped;
}

/**
 * FIFO spawn-queue claim (AI-203 increment 4). Under the per-key lock: lazy
 * stale demotion first (frees slots), then flip the lowest-n `queued`
 * records to `running` while slots remain, and return them for firing. The
 * ONLY queued→running transition in the system — every start (spawn claim,
 * steer wake, executor terminal wake, poll-tick reconcile) goes through
 * here, so the running cap binds every entry into execution, not just
 * createThread. Returns [] when nothing is startable.
 *
 * AI-232: the running cap and the dependency gate are the only two claim
 * predicates. This function is the single scheduler funnel — the cascade
 * above and the dependency-satisfied filter below are what every one of
 * claimThreadStarts's four call sites (spawn park, steer wake, executor
 * terminal wake, poll-tick reconcile) rides for free.
 */
export async function claimThreadStarts(key: string): Promise<ThreadRecord[]> {
  return withKeyLock(key, async () => {
    const map = await load(key);
    if (demoteStale(map)) await persist(key, map);
    const cascaded = cascadeUnsatisfiable(map);
    if (cascaded.length > 0) {
      const parsed = /^(-?\d+)_(\d+)$/.exec(key);
      for (const { rec, dep } of cascaded) {
        if (!parsed) continue;
        try {
          await appendTopicEvent(Number(parsed[1]), Number(parsed[2]), {
            kind: 'thread_cancelled',
            ref: rec.id,
            detail: `dependency ${dep.id} ${dep.status}`,
          });
        } catch (err) {
          logger.warn('topic-threads', `thread_cancelled event failed: ${(err as Error).message}`, {
            key,
            id: rec.id,
          });
        }
      }
      await persist(key, map);
    }
    let running = 0;
    for (const rec of map.values()) if (rec.status === 'running') running++;
    const nowMs = Date.now();
    const startable = [...map.values()]
      .filter((rec) => rec.status === 'queued'
        && resolveDependencyState(rec.dependsOn, (id) => map.get(id)) === 'satisfied'
        && !(rec.parkedUntil !== undefined && Date.parse(rec.parkedUntil) > nowMs))
      .sort((a, b) => a.n - b.n);
    const claimed: ThreadRecord[] = [];
    const now = new Date().toISOString();
    for (const rec of startable) {
      if (running >= MAX_RUNNING_THREADS_PER_TOPIC) break;
      rec.status = 'running';
      rec.updatedAt = now;
      running++;
      claimed.push(rec);
    }
    if (claimed.length > 0) await persist(key, map);
    return claimed;
  });
}

/**
 * Mark every running or queued thread `cancelled`; returns how many flipped.
 * Queued records cancel too — they never started, so no topic event is
 * emitted for them.
 */
export async function cancelRunningThreads(key: string): Promise<number> {
  return withKeyLock(key, async () => {
    const map = await load(key);
    let count = 0;
    const now = new Date().toISOString();
    // Parsed ONCE: some test store dirs use keys the topic-events path cannot
    // address — a non-matching key skips emission silently (the flip and the
    // count are unaffected).
    const parsed = /^(-?\d+)_(\d+)$/.exec(key);
    for (const rec of map.values()) {
      if (rec.status !== 'running' && rec.status !== 'queued') continue;
      const wasRunning = rec.status === 'running';
      rec.status = 'cancelled';
      rec.updatedAt = now;
      count++;
      if (!parsed || !wasRunning) continue;
      try {
        await appendTopicEvent(Number(parsed[1]), Number(parsed[2]), {
          kind: 'thread_cancelled',
          ref: rec.id,
          detail: rec.title,
        });
      } catch (err) {
        logger.warn('topic-threads', `thread_cancelled event failed: ${(err as Error).message}`, {
          key,
          id: rec.id,
        });
      }
    }
    if (count > 0) await persist(key, map);
    return count;
  });
}

/**
 * Mark ONE thread `cancelled` — the per-task cancel path. Unlike
 * cancelRunningThreads (which flips every running/queued record in the topic
 * and is the blast radius a per-task button must not have), this touches only
 * the named record, and only when it is running or queued. Returns true when
 * it flipped. Emits thread_cancelled only for a record that was running.
 */
export async function cancelOneThread(key: string, id: string): Promise<boolean> {
  return withKeyLock(key, async () => {
    const map = await load(key);
    const rec = map.get(id);
    if (!rec) return false;
    if (rec.status !== 'running' && rec.status !== 'queued') return false;
    const wasRunning = rec.status === 'running';
    rec.status = 'cancelled';
    rec.updatedAt = new Date().toISOString();
    // AI-232: a /stop on a dependency must cascade its dependents right away —
    // otherwise they park until the 60s reconcile backstop, which is correct
    // but defeats the point of event-driven resumption.
    const cascaded = cascadeUnsatisfiable(map);
    await persist(key, map);
    const parsed = /^(-?\d+)_(\d+)$/.exec(key);
    if (parsed && wasRunning) {
      try {
        await appendTopicEvent(Number(parsed[1]), Number(parsed[2]), {
          kind: 'thread_cancelled',
          ref: rec.id,
          detail: rec.title,
        });
      } catch (err) {
        logger.warn('topic-threads', `thread_cancelled event failed: ${(err as Error).message}`, {
          key,
          id: rec.id,
        });
      }
    }
    for (const { rec: depRec, dep } of cascaded) {
      if (!parsed) continue;
      try {
        await appendTopicEvent(Number(parsed[1]), Number(parsed[2]), {
          kind: 'thread_cancelled',
          ref: depRec.id,
          detail: `dependency ${dep.id} ${dep.status}`,
        });
      } catch (err) {
        logger.warn('topic-threads', `thread_cancelled event failed: ${(err as Error).message}`, {
          key,
          id: depRec.id,
        });
      }
    }
    return true;
  });
}

/** How many threads are currently `running` for the topic. */
export async function activeThreadCount(key: string): Promise<number> {
  const map = await load(key);
  let count = 0;
  for (const rec of map.values()) if (rec.status === 'running') count++;
  return count;
}

export interface ThreadCounts {
  running: number;
  queued: number;
  done: number;
  failed: number;
  cancelled: number;
}

/**
 * Tally one topic's thread records by status. Reads through listThreads, so
 * the lazy stale-demotion side effect runs first — a count is also a keep-alive
 * for the demotion clock. Fail-to-empty (unknown key, unreadable file) via the
 * same path listThreads uses; never throws.
 */
export async function countThreads(key: string): Promise<ThreadCounts> {
  const threads = await listThreads(key);
  const counts: ThreadCounts = { running: 0, queued: 0, done: 0, failed: 0, cancelled: 0 };
  for (const t of threads) counts[t.status]++;
  return counts;
}

/**
 * Every topic key with a store file (`.json` stripped), for the poll-tick
 * reconcile drain. Absent dir ⇒ []. Never throws.
 */
export async function listStoreKeys(): Promise<string[]> {
  try {
    const files = await readdir(storeDir());
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.warn('topic-threads', `listStoreKeys failed: ${(err as Error).message}`);
    }
    return [];
  }
}

/**
 * Cooldown-expiry wake (2026-09-13): rewind every wall-parked record's
 * `parkedUntil` to now so the same tick's reconcile drain re-claims it
 * immediately. A record is wall-parked when it is `queued` with
 * `unavailableParks > 0` and a future stamp — exactly what the wall-park write
 * produces; past/absent stamps are already claimable and are left untouched.
 * One store pass per key under that key's lock; returns the count rewound.
 */
export async function wakeWallParked(): Promise<number> {
  const keys = await listStoreKeys();
  let woken = 0;
  for (const key of keys) {
    woken += await withKeyLock(key, async () => {
      const map = await load(key);
      const now = Date.now();
      let changed = 0;
      for (const rec of map.values()) {
        if (rec.status !== 'queued') continue;
        if ((rec.unavailableParks ?? 0) <= 0) continue;
        const until = Date.parse(rec.parkedUntil ?? '');
        if (!Number.isFinite(until) || until <= now) continue;
        rec.parkedUntil = new Date(now).toISOString();
        rec.updatedAt = new Date().toISOString();
        changed++;
      }
      if (changed > 0) await persist(key, map);
      return changed;
    });
  }
  return woken;
}

/** Test hook: drop the per-key mutex chains so a test starts with no inherited serialization. */
export function _clearThreadsForTest(): void {
  chains.clear();
}

/** Test hook: point the store at a temp dir (files land directly in it), independent of PA_HOME. */
export function _setStoreDirForTest(dir: string | undefined): void {
  storeDirOverride = dir;
}
