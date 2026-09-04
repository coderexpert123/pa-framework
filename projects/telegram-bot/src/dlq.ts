import { appendFile, readFile, unlink, writeFile, rename, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { sendMessageWithDetails, sendMessageWithId, isTerminalChatError } from './telegram.js';
import { buildDlqReplayKeyboard } from './callbacks.js';
import { deliveredKey, wasDelivered, markDelivered } from './delivered-store.js';
import { log } from '../../../pa/dist/src/lib/log.js';
import { redactSecrets } from '../../../pa/dist/src/lib/redact.js';
import { loadSecrets } from '../../../pa/dist/src/secrets.js';

export const DLQ_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const QUARANTINE_THRESHOLD = 5; // attempts before quarantine

// Dedup state for quarantine alerts (one per entry, by refId or text hash).
// Resolved at CALL time (not module load) so PA_HOME set by tests/other
// deployments is honored — the module-load constant silently pointed at the
// real ~/.pa in tests and raced PA_HOME overrides.
function quarantineAlertDir(): string {
  return join(process.env.PA_HOME ?? join(homedir(), '.pa'), 'quarantine-alerts');
}

async function sendQuarantineAlert(entry: DlqEntry, index: number): Promise<void> {
  try {
    const secrets = await loadSecrets();
    // env-first, secrets fallback — the standalone-scripts convention
    const token = process.env.TELEGRAM_BOT_TOKEN || secrets['TELEGRAM_BOT_TOKEN'];
    if (!token) return;

    const alertsChatId = process.env.PA_ALERTS_CHAT_ID || secrets['PA_ALERTS_CHAT_ID'] || '';
    const alertsThreadId = Number(process.env.PA_ALERTS_THREAD_ID || secrets['PA_ALERTS_THREAD_ID'] || '0');

    if (!alertsChatId) return;

    // Dedup: alert already sent for this entry
    const alertDir = quarantineAlertDir();
    await mkdir(alertDir, { recursive: true });
    const alertKey = entry.refId || `${entry.chatId}:${entry.threadId}:${entry.updateId}`;
    const alertFile = join(alertDir, `${alertKey}.json`);
    try {
      await readFile(alertFile, 'utf8');
      return; // already alerted
    } catch {
      // file doesn't exist, proceed with alert
    }

    const preview = entry.text.slice(0, 80);
    const subject = `DLQ entry quarantined after ${QUARANTINE_THRESHOLD} failed attempts`;
    const body = `Ref: ${entry.refId || '(none)'}\nDLQ index: ${index}\nPreview: ${preview}${entry.text.length > 80 ? '...' : ''}\n\nThis entry will not be retried. Use "pa dlq list" to see all quarantined entries and "pa dlq replay <index>" to retry manually.\n\nRunbook: runbooks/dlq-poison.md`;

    await sendMessageWithId(token, Number(alertsChatId), body, alertsThreadId || undefined, buildDlqReplayKeyboard(index, false));

    // Mark alert as sent
    await writeFile(alertFile, JSON.stringify({ timestamp: new Date().toISOString() }), 'utf8');

    log('warn', 'dlq', 'quarantine alert sent', { refId: entry.refId, chatId: entry.chatId, threadId: entry.threadId, updateId: entry.updateId });
  } catch (err: any) {
    log('error', 'dlq', 'failed to send quarantine alert', { error: err?.message, entry });
  }
}

export interface DlqEntry {
  chatId: number;
  threadId: number;
  replyToMessageId?: number;
  text: string;
  timestamp: string;
  updateId: number;
  refId?: string;        // bot reply debug handle (e.g., 's-a1b2c3d4e5f6') — preserved for `pa ref` lookups while queued
  attempts?: number;     // number of failed flush attempts (quarantined at 5)
  quarantined?: boolean; // true when attempts >= 5 — stops retry, persists for operator action
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
          // Quarantined entries persist for operator action (no TTL purge)
          if (entry.quarantined) return [entry];
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
    // Quarantined entries are never retried
    if (entry.quarantined) {
      remaining.push(entry);
      continue;
    }

    // Idempotency guard: if this reply was already confirmed delivered (e.g. a
    // prior flush delivered it but crashed before persisting the trimmed queue),
    // skip it — re-sending would duplicate. See delivered-store.ts.
    const key = deliveredKey(entry.chatId, entry.threadId, entry.updateId);
    if (await wasDelivered(key)) {
      deduped++;
      continue;
    }

    const result = await sendMessageWithDetails(token, entry.chatId, entry.text, entry.replyToMessageId, entry.threadId || undefined);
    if (result.ok) {
      // Mark delivered BEFORE moving on, so a crash later in this loop cannot
      // cause a re-send of this entry on the next startup flush.
      await markDelivered(key);
      delivered++;
    } else if (result.lastStatus !== undefined && isTerminalChatError(result.lastStatus, result.lastErrorText ?? '')) {
      // Terminal error (isTerminalChatError): chat gone, blocked/deactivated
      // recipient, bot kicked, or an invalid peer — the recipient can never
      // receive, so retrying can never succeed. Drop the entry instead of
      // quarantine-cycling it (AI-172 fix#2; set widened 2026-09-03). It is
      // NOT pushed to `remaining`, so the persist below drops it permanently
      // and it never burns an attempts slot or a quarantine alert.
      log('warn', 'dlq', 'dropping unroutable DLQ entry (terminal chat error)', {
        chatId: entry.chatId,
        threadId: entry.threadId,
        updateId: entry.updateId,
        status: result.lastStatus,
        error: result.lastErrorText,
      });
      continue;
    } else {
      // Increment attempts counter
      const attempts = (entry.attempts || 0) + 1;
      if (attempts >= QUARANTINE_THRESHOLD) {
        // Quarantine the entry and alert once. `remaining` (in this same order)
        // is what gets persisted to the DLQ file below, and `pa dlq replay <idx>`
        // indexes into that same persisted array — so the position this entry
        // is about to occupy IS the index the alert's keyboard must carry.
        const quarantinedEntry: DlqEntry = { ...entry, attempts, quarantined: true };
        const index = remaining.length;
        remaining.push(quarantinedEntry);
        await sendQuarantineAlert(quarantinedEntry, index);
      } else {
        remaining.push({ ...entry, attempts });
      }
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
  // AI-184 (2026-09-03): the DLQ is persistence, not delivery. Pre-fix the reply
  // text arrived here already scrubbed by the send path (logic.ts
  // formatWorkerReply); post-fix it arrives raw and this at-rest copy keeps that
  // redaction coverage. Replay (flushDlq / pa dlq replay) sends the stored —
  // i.e. redacted — text, matching pre-AI-184 replay behavior. Double redaction
  // is a safe no-op.
  const redacted: DlqEntry = { ...entry, text: redactSecrets(entry.text) as string };
  return withDlqMutex(() => appendDlqInner(redacted));
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

/**
 * Test-only: reset the module-level DLQ mutex. An aborted poll loop can leave a
 * mid-flight send inside flushDlqInner holding the mutex forever; without this,
 * every subsequent describe's queue-drain pass blocks at its first mutex-taking
 * source (observed 2026-09-03: poll-loop DLQ pins failing 'in-flight' after an
 * earlier describe's abort). Same pattern as _resetCardKeyboardIndexForTest.
 */
export function _resetDlqMutexForTest(): void {
  dlqMutex = Promise.resolve();
}
