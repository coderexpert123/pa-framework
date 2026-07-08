/**
 * Persistent registry of in-flight worker dispatches (AI-095).
 *
 * The bot holds each dispatch only in memory: if the process dies mid-dispatch
 * (e.g. the 2026-07-03 proper-lockfile ECOMPROMISED crash), the orphaned worker
 * finishes with nowhere to send its reply and the restarted instance has no idea
 * the request ever existed. This store closes that gap: a record is written just
 * before the worker is dispatched and removed once the reply is delivered (or
 * DLQ'd, which is itself persistent). Whatever is left on disk at startup is a
 * crashed-in-flight dispatch for the orphan reaper to recover.
 *
 * Single-writer by design (only the bot process), same as delivered-store.
 */
import { readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { SessionInfo } from './types.js';

export const PENDING_DISPATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — matches DLQ/delivered TTL

export interface PendingDispatch {
  updateId: number;
  chatId: number;
  threadId: number;
  messageId: number;
  userText: string;
  startedAt: string; // ISO
  /** Optional ONLY for the enqueue-time placeholder (AI-095 follow-up,
   * deep-recheck 2026-07-08): a record written the moment an update is
   * accepted into the poll loop, before topicState/session are ever loaded,
   * so a crash mid-dispatch can't lose the update silently. In practice a
   * record with `session` set always has `cwd` set too — the pairing is
   * never relaxed; only a session-less placeholder omits both. */
  cwd?: string;
  /** Session the dispatch will try to resume, if one existed. Recovery is only
   * possible for claude-family sessions (transcript path is deterministic). */
  session?: SessionInfo;
}

function storePath(): string {
  const home = process.env.PA_HOME ?? join(homedir(), '.pa');
  return join(home, 'telegram-pending-dispatches.json');
}

/** Same shape as deliveredKey — one inbound update yields at most one dispatch. */
export function pendingDispatchKey(chatId: number, threadId: number, updateId: number): string {
  return `${chatId}:${threadId}:${updateId}`;
}

let cache: Map<string, PendingDispatch> | null = null;
let cachePath: string | null = null;
let mutex: Promise<void> = Promise.resolve();

async function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const previous = mutex;
  let release!: () => void;
  mutex = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

async function load(): Promise<Map<string, PendingDispatch>> {
  const path = storePath();
  if (cache && cachePath === path) return cache;

  const map = new Map<string, PendingDispatch>();
  try {
    const raw = await readFile(path, 'utf8');
    const obj = JSON.parse(raw) as Record<string, PendingDispatch>;
    const now = Date.now();
    for (const [key, rec] of Object.entries(obj)) {
      const started = new Date(rec.startedAt).getTime();
      if (Number.isFinite(started) && now - started <= PENDING_DISPATCH_MAX_AGE_MS) map.set(key, rec);
    }
  } catch {
    /* no file yet, or corrupt — start empty */
  }
  cache = map;
  cachePath = path;
  return map;
}

async function persist(map: Map<string, PendingDispatch>): Promise<void> {
  const path = storePath();
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(Object.fromEntries(map)), 'utf8');
  await rename(tmp, path);
}

export async function addPendingDispatch(record: PendingDispatch): Promise<void> {
  return withMutex(async () => {
    const map = await load();
    map.set(pendingDispatchKey(record.chatId, record.threadId, record.updateId), record);
    await persist(map);
  });
}

export async function removePendingDispatch(key: string): Promise<void> {
  return withMutex(async () => {
    const map = await load();
    if (map.delete(key)) await persist(map);
  });
}

/** All live (non-expired) records — what the startup reaper works through. */
export async function listPendingDispatches(): Promise<PendingDispatch[]> {
  return withMutex(async () => [...(await load()).values()]);
}

/** Test hook: drop the in-memory cache so a fresh PA_HOME is re-read. */
export function _resetPendingDispatchesForTest(): void {
  cache = null;
  cachePath = null;
}
