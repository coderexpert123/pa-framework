/**
 * Persistent "delivered reply" guard for effectively-once outbound delivery.
 *
 * Records the idempotency key of every reply Telegram has confirmed delivered,
 * so that after a crash/restart the bot does not re-send a reply it already
 * delivered. Two duplicate paths this closes:
 *   1. DLQ partial-flush crash — flushDlq delivers some entries then crashes
 *      before persisting the trimmed queue; on restart those entries are still
 *      queued. The flush skips any whose key is already marked delivered.
 *   2. Update reprocessing — a reply is delivered but the poll offset isn't
 *      persisted before a crash; the update is reprocessed on restart. The
 *      reply path skips it.
 *
 * Key = `${chatId}:${threadId}:${updateId}` — one inbound update yields at most
 * one reply, and update_ids are unique and monotonic per bot, so the key never
 * collides and never produces a false positive (no risk of dropping a real
 * reply). Entries expire after 24h (matching the DLQ TTL) and the file is
 * compacted on load to bound growth.
 *
 * Single-writer by design: only the bot process writes replies/DLQ. The pa CLI
 * notify path does not use this store.
 */
import { appendFile, readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

export const DELIVERED_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

function deliveredPath(): string {
  const home = process.env.PA_HOME ?? join(homedir(), '.pa');
  return join(home, 'telegram-delivered.jsonl');
}

/** Canonical idempotency key for a reply to a given inbound update. */
export function deliveredKey(chatId: number, threadId: number, updateId: number): string {
  return `${chatId}:${threadId}:${updateId}`;
}

let cache: Map<string, number> | null = null; // key -> deliveredAt (epoch ms)
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

async function load(): Promise<Map<string, number>> {
  const path = deliveredPath();
  // Re-read if PA_HOME changed (e.g. between tests) or first use.
  if (cache && cachePath === path) return cache;

  const map = new Map<string, number>();
  let total = 0;
  try {
    const raw = await readFile(path, 'utf8');
    const now = Date.now();
    for (const line of raw.trim().split('\n')) {
      if (!line) continue;
      total++;
      try {
        const e = JSON.parse(line) as { key: string; ts: number };
        if (now - e.ts <= DELIVERED_MAX_AGE_MS) map.set(e.key, e.ts);
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* no file yet */
  }

  cache = map;
  cachePath = path;

  // Compact if we dropped expired/duplicate lines, to bound file growth.
  if (total > map.size) {
    const tmp = path + '.tmp';
    const body = [...map.entries()].map(([key, ts]) => JSON.stringify({ key, ts })).join('\n');
    try {
      await writeFile(tmp, body + (map.size ? '\n' : ''), 'utf8');
      await rename(tmp, path);
    } catch {
      /* compaction is best-effort */
    }
  }
  return map;
}

/** True if a reply with this key was already confirmed delivered (and not expired). */
export async function wasDelivered(key: string): Promise<boolean> {
  return withMutex(async () => {
    const map = await load();
    const ts = map.get(key);
    if (ts === undefined) return false;
    if (Date.now() - ts > DELIVERED_MAX_AGE_MS) {
      map.delete(key);
      return false;
    }
    return true;
  });
}

/** Record a confirmed delivery. Idempotent — repeated calls are cheap no-ops. */
export async function markDelivered(key: string): Promise<void> {
  return withMutex(async () => {
    const map = await load();
    if (map.has(key)) return;
    const ts = Date.now();
    map.set(key, ts);
    await appendFile(deliveredPath(), JSON.stringify({ key, ts }) + '\n', 'utf8');
  });
}

/** Test hook: drop the in-memory cache so a fresh PA_HOME is re-read. */
export function _resetDeliveredCacheForTest(): void {
  cache = null;
  cachePath = null;
}
