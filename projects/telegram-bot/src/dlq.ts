import { appendFile, readFile, unlink, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { sendMessage } from './telegram.js';
import { deliveredKey, wasDelivered, markDelivered } from './delivered-store.js';

export const DLQ_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface DlqEntry {
  chatId: number;
  threadId: number;
  replyToMessageId?: number;
  text: string;
  timestamp: string;
  updateId: number;
  refId?: string;        // bot reply debug handle (e.g., 's-a1b2c3d4e5f6') — preserved for `pa ref` lookups while queued
}

function dlqPath(): string {
  const home = process.env.PA_HOME ?? join(homedir(), '.pa');
  return join(home, 'telegram-dlq.jsonl');
}

let dlqMutex: Promise<void> = Promise.resolve();

async function withDlqMutex<T>(fn: () => Promise<T>): Promise<T> {
  const previous = dlqMutex;
  let release!: () => void;
  dlqMutex = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

async function appendDlqInner(entry: DlqEntry): Promise<void> {
  await appendFile(dlqPath(), JSON.stringify(entry) + '\n', 'utf8');
}

async function loadDlqInner(): Promise<DlqEntry[]> {
  try {
    const raw = await readFile(dlqPath(), 'utf8');
    const now = Date.now();
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line) as DlqEntry;
          if (now - new Date(entry.timestamp).getTime() > DLQ_MAX_AGE_MS) return [];
          return [entry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function clearDlqInner(): Promise<void> {
  try {
    await unlink(dlqPath());
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function writeDlqInner(entries: DlqEntry[]): Promise<void> {
  const path = dlqPath();
  const tmp = path + '.tmp';
  await writeFile(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
  await rename(tmp, path);
}

// flushDlq runs at startup before the poll loop begins AND on the poll loop's
// 5-minute maintenance tick (Phase 1) — i.e. concurrently with live reply-path
// appendDlq calls. The FIFO mutex is what makes that safe: flush and append
// serialize, so a reply can never be appended mid-flush and lost in the
// rewrite. The tick-side caller keeps at most one flush in flight (see
// maintFlushInFlight in main.ts) so a slow flush during an outage can't pile
// queued flushes onto this mutex ahead of live appends.
// NOTE: this mutex is per-process. If another process ever writes the DLQ,
// upgrade to proper-lockfile here.
async function flushDlqInner(token: string): Promise<{ delivered: number; remaining: number; deduped: number }> {
  const entries = await loadDlqInner();
  if (entries.length === 0) return { delivered: 0, remaining: 0, deduped: 0 };

  const remaining: DlqEntry[] = [];
  let delivered = 0;
  let deduped = 0;

  for (const entry of entries) {
    // Idempotency guard: if this reply was already confirmed delivered (e.g. a
    // prior flush delivered it but crashed before persisting the trimmed queue),
    // skip it — re-sending would duplicate. See delivered-store.ts.
    const key = deliveredKey(entry.chatId, entry.threadId, entry.updateId);
    if (await wasDelivered(key)) {
      deduped++;
      continue;
    }
    const ok = await sendMessage(token, entry.chatId, entry.text, entry.replyToMessageId, entry.threadId || undefined);
    if (ok) {
      // Mark delivered BEFORE moving on, so a crash later in this loop cannot
      // cause a re-send of this entry on the next startup flush.
      await markDelivered(key);
      delivered++;
    } else {
      remaining.push(entry);
    }
  }

  if (remaining.length === 0) {
    await clearDlqInner();
  } else {
    await writeDlqInner(remaining);
  }

  return { delivered, remaining: remaining.length, deduped };
}

export async function appendDlq(entry: DlqEntry): Promise<void> {
  return withDlqMutex(() => appendDlqInner(entry));
}

export async function loadDlq(): Promise<DlqEntry[]> {
  return withDlqMutex(() => loadDlqInner());
}

export async function clearDlq(): Promise<void> {
  return withDlqMutex(() => clearDlqInner());
}

export async function writeDlq(entries: DlqEntry[]): Promise<void> {
  return withDlqMutex(() => writeDlqInner(entries));
}

export async function flushDlq(token: string): Promise<{ delivered: number; remaining: number; deduped: number }> {
  return withDlqMutex(() => flushDlqInner(token));
}
