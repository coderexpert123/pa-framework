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

// increment 4: overflow queues (createThread parks as 'queued'); the claim is the only queued→running transition
export const MAX_RUNNING_THREADS_PER_TOPIC = 10;
export const MAX_THREADS_PER_TOPIC = 20; // prune oldest terminal at create; never prune running
export const MAX_PENDING_INPUT_PER_THREAD = 5;
export const TOPIC_THREAD_STALE_MS = 30 * 60 * 1000; // lazy demotion on read
export const THREAD_ACTIVITY_THROTTLE_MS = 10_000; // executor pump write throttle

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
  lastResult?: string; // redactSecrets'd, <=4000 chars, set on done
  pendingInput: string[]; // steer messages awaiting delivery, each 1..4000 chars
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

/**
 * Running records wedged past TOPIC_THREAD_STALE_MS demote to `failed` (lazy,
 * on read). Queued records are exempt — no executor means no pump, and a
 * healthy queued record is revived by the reconcile drain (increment 4),
 * never demoted.
 */
function demoteStale(map: Map<string, ThreadRecord>): boolean {
  const now = Date.now();
  let changed = false;
  for (const rec of map.values()) {
    if (rec.status !== 'running') continue;
    const updated = Date.parse(rec.updatedAt);
    if (!Number.isFinite(updated) || now - updated < TOPIC_THREAD_STALE_MS) continue;
    rec.status = 'failed';
    rec.lastError = `thread run interrupted: no activity for ${Math.round(TOPIC_THREAD_STALE_MS / 60000)}m (bot restart or crash)`;
    rec.updatedAt = new Date(now).toISOString();
    changed = true;
  }
  return changed;
}

export type CreateThreadResult =
  | { ok: true; thread: ThreadRecord }
  | { ok: false; reason: string };

export async function createThread(
  key: string,
  init: { title: string; goal: string; workdir: string },
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
    const status: ThreadRecord['status'] =
      running >= MAX_RUNNING_THREADS_PER_TOPIC ? 'queued' : 'running';
    let maxN = 0;
    for (const rec of map.values()) if (rec.n > maxN) maxN = rec.n;
    const n = maxN + 1;
    const now = new Date().toISOString();
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
    };
    map.set(thread.id, thread);
    // Cap total records: prune lowest-n terminal first (n is per-topic
    // monotonic, so lowest n = oldest); running and queued records are never
    // pruned (queued is waiting work — increment 4).
    while (map.size > MAX_THREADS_PER_TOPIC) {
      let victim: ThreadRecord | null = null;
      for (const rec of map.values()) {
        if (rec.status === 'running') continue;
        if (rec.status === 'queued') continue;
        if (!victim || rec.n < victim.n) victim = rec;
      }
      if (!victim) break; // no terminal victim (all running/queued) — keep the store oversize, never delete waiting work
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
 * FIFO spawn-queue claim (AI-203 increment 4). Under the per-key lock: lazy
 * stale demotion first (frees slots), then flip the lowest-n `queued`
 * records to `running` while slots remain, and return them for firing. The
 * ONLY queued→running transition in the system — every start (spawn claim,
 * steer wake, executor terminal wake, poll-tick reconcile) goes through
 * here, so the running cap binds every entry into execution, not just
 * createThread. Returns [] when nothing is startable.
 */
export async function claimThreadStarts(key: string): Promise<ThreadRecord[]> {
  return withKeyLock(key, async () => {
    const map = await load(key);
    if (demoteStale(map)) await persist(key, map);
    let running = 0;
    for (const rec of map.values()) if (rec.status === 'running') running++;
    const startable = [...map.values()]
      .filter((rec) => rec.status === 'queued')
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

/** Test hook: drop the per-key mutex chains so a test starts with no inherited serialization. */
export function _clearThreadsForTest(): void {
  chains.clear();
}

/** Test hook: point the store at a temp dir (files land directly in it), independent of PA_HOME. */
export function _setStoreDirForTest(dir: string | undefined): void {
  storeDirOverride = dir;
}
