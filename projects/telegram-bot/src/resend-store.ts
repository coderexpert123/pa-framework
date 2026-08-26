/**
 * Resend store (2026-08-24 buttons program, plans/2026-08-24-buttons-program-SPEC.md P7).
 *
 * The orphan reaper's "⚠️ The bot restarted while processing your message … please
 * resend" notice now carries a `🔁 Resend` button (`rs:<chatId>:<threadId>:<updateId>`).
 * This store holds the original user text for up to RESEND_MAX_AGE_MS so the press can
 * re-dispatch it as a synthetic message instead of asking the operator to retype.
 *
 * Storage shape copied verbatim from pending-dispatches.ts (module cache + mutex +
 * tmp-then-rename persist + prune-on-load): single-writer by design (only the bot
 * process).
 */
import { readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

export interface ResendRecord {
  chatId: number;
  threadId: number;
  updateId: number;
  messageId: number;
  userText: string;
  storedAt: string;
}

export const RESEND_MAX_AGE_MS: number = 24 * 60 * 60 * 1000;

export function resendKey(chatId: number, threadId: number, updateId: number): string {
  return `${chatId}:${threadId}:${updateId}`;
}

function storePath(): string {
  const home = process.env.PA_HOME ?? join(homedir(), '.pa');
  return join(home, 'telegram-resend.json');
}

let cache: Map<string, ResendRecord> | null = null;
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

async function load(): Promise<Map<string, ResendRecord>> {
  const path = storePath();
  if (cache && cachePath === path) return cache;

  const map = new Map<string, ResendRecord>();
  try {
    const raw = await readFile(path, 'utf8');
    const obj = JSON.parse(raw) as Record<string, ResendRecord>;
    const now = Date.now();
    for (const [key, rec] of Object.entries(obj)) {
      const storedAtMs = new Date(rec.storedAt).getTime();
      if (Number.isFinite(storedAtMs) && now - storedAtMs <= RESEND_MAX_AGE_MS) map.set(key, rec);
    }
  } catch {
    /* no file yet, or corrupt — start empty */
  }
  cache = map;
  cachePath = path;
  return map;
}

async function persist(map: Map<string, ResendRecord>): Promise<void> {
  const path = storePath();
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(Object.fromEntries(map)), 'utf8');
  await rename(tmp, path);
}

export async function putResend(record: ResendRecord): Promise<void> {
  return withMutex(async () => {
    const map = await load();
    map.set(resendKey(record.chatId, record.threadId, record.updateId), record);
    await persist(map);
  });
}

/** Reads AND removes. Returns null when absent or expired. */
export async function takeResend(key: string): Promise<ResendRecord | null> {
  return withMutex(async () => {
    const map = await load();
    const rec = map.get(key);
    if (!rec) return null;
    map.delete(key);
    await persist(map);
    return rec;
  });
}

/** Test hook: drop the in-memory cache so a fresh PA_HOME is re-read. */
export function _resetResendStoreForTest(): void {
  cache = null;
  cachePath = null;
}
