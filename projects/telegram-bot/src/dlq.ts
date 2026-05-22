import { appendFile, readFile, unlink, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { sendMessage } from './telegram.js';

export const DLQ_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface DlqEntry {
  chatId: number;
  threadId: number;
  replyToMessageId?: number;
  text: string;
  timestamp: string;
  updateId: number;
  refId?: string;        // bot reply debug handle (e.g., 'c-a59a') — preserved for `pa ref` lookups while queued
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

// flushDlq runs at startup before the poll loop begins, so appendDlq callers
// should not exist yet. The mutex still protects against future overlap.
// NOTE: this mutex is per-process. If another process ever writes the DLQ,
// upgrade to proper-lockfile here.
async function flushDlqInner(token: string): Promise<{ delivered: number; remaining: number }> {
  const entries = await loadDlqInner();
  if (entries.length === 0) return { delivered: 0, remaining: 0 };

  const remaining: DlqEntry[] = [];
  let delivered = 0;

  for (const entry of entries) {
    const ok = await sendMessage(token, entry.chatId, entry.text, entry.replyToMessageId, entry.threadId || undefined);
    if (ok) {
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

  return { delivered, remaining: remaining.length };
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

export async function flushDlq(token: string): Promise<{ delivered: number; remaining: number }> {
  return withDlqMutex(() => flushDlqInner(token));
}
