/**
 * Notifier substrate for the PA platform.
 *
 * Single function (`notifyUser`) that all subsystems call when something goes wrong.
 * Default-routed to the PA_ALERTS_CHAT_ID / PA_ALERTS_THREAD_ID env vars
 * (falls back to the first TELEGRAM_CHAT_ID entry if PA_ALERTS_CHAT_ID is unset).
 * Dedup keeps noise bounded (1 h default window).
 *
 * Dedup state: ~/.pa/alert-state/<sha1(key).slice(0,16)>.json
 * Format: { "timestamp": "<ISO>", "key": "<raw>", "windowMs": <number> }
 *
 * GC reads the stored windowMs and only deletes if now - timestamp > windowMs.
 * Files without windowMs (legacy) fall back to GC_MAX_AGE_MS (24 h).
 */

import { createHash } from 'crypto';
import { mkdirSync, readdirSync, existsSync } from 'fs';
import { readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { sendToTelegram } from '../telegram.js';
import { loadSecrets } from '../secrets.js';
import { log } from './log.js';
import { paHome } from '../paths.js';

// The dedicated topic for automated PA alerts. NOT the human-conversation
// topic — pa-support remains separate so user replies don't get drowned
// by skill-failure / worker-exit / rate-limit notifications.
// Env-driven so the framework is portable. Falls back to TELEGRAM_CHAT_ID's
// first entry if PA_ALERTS_CHAT_ID is unset.
//
// These are RESOLVED LAZILY (read at call time, not at module-load time)
// because CLI commands (e.g. `pa notify`) may run loadSecrets() AFTER the
// module is imported. The exported `PA_ALERTS_CHAT_ID` value is a snapshot
// at module-init time and may be empty for CLI invocations — use
// `getPaAlertsChatId()` for fresh values.
export function getPaAlertsChatId(): string {
  return (
    process.env.PA_ALERTS_CHAT_ID ||
    process.env.TELEGRAM_CHAT_ID?.split(',')[0] ||
    ''
  );
}
export function getPaAlertsThreadId(): number {
  return Number(process.env.PA_ALERTS_THREAD_ID ?? 0);
}
export const PA_ALERTS_CHAT_ID = getPaAlertsChatId();   // snapshot — may be stale
export const PA_ALERTS_THREAD_ID = getPaAlertsThreadId();

export const DEFAULT_DEDUP_WINDOW_MS = 3_600_000; // 1 hour
export const GC_MAX_AGE_MS = 86_400_000; // 24 hours

interface NotifyOpts {
  dedupKey?: string;
  dedupWindowMs?: number;
  topic?: { chat_id: string; thread_id?: number };
  severity?: 'info' | 'warn' | 'error';
}

interface NotifyResult {
  sent: boolean;
  suppressed: boolean;
}

function alertStateDir(): string {
  return join(paHome(), 'alert-state');
}

function dedupFilePath(key: string): string {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 16);
  return join(alertStateDir(), `${hash}.json`);
}

// --- Staleness migration (one-time) ---
let migrated = false;

export async function migrateStalenessAlertFile(): Promise<void> {
  if (migrated) return;
  migrated = true;

  const oldPath = join(paHome(), 'last-staleness-alert.json');
  const newPath = dedupFilePath('staleness');

  try {
    if (!existsSync(oldPath)) return;

    const oldExists = existsSync(oldPath);
    const newExists = existsSync(newPath);

    if (oldExists && !newExists) {
      const raw = await readFile(oldPath, 'utf8');
      const parsed = JSON.parse(raw);
      mkdirSync(alertStateDir(), { recursive: true });
      await writeFile(newPath, JSON.stringify({ timestamp: parsed.timestamp, key: 'staleness' }), 'utf8');
    }

    // In all cases where old exists, try to delete it
    if (oldExists) {
      await unlink(oldPath).catch(() => {}); // ENOENT race is fine
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT' && err?.code !== 'EEXIST') {
      log('warn', 'notify', 'Staleness migration error', { error: err?.message });
    }
  }
}

// --- Dedup GC ---
export async function gcAlertState(): Promise<void> {
  const dir = alertStateDir();
  try {
    const files = readdirSync(dir);
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = join(dir, file);

      try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        const ts = new Date(parsed.timestamp).getTime();

        const storedWindow = typeof parsed.windowMs === 'number' ? parsed.windowMs : GC_MAX_AGE_MS;
        if (isNaN(ts) || now - ts > storedWindow) {
          await unlink(filePath).catch(() => {}); // ENOENT race is fine
        }
      } catch {
        // Malformed or corrupt file — treat as stale and delete
        await unlink(filePath).catch(() => {});
      }
    }
  } catch {
    // Directory doesn't exist yet — nothing to GC
  }
}

/**
 * Send an alert to the user. Default route: pa-alerts (chat, thread 3376).
 * Never throws. Returns { sent, suppressed } to indicate outcome.
 *
 * When dedupKey is undefined: skip dedup entirely, always attempt send.
 * This is used by callers that manage their own suppression (e.g. Phase 4's
 * per-PID lastRepeatBucket gate).
 */
export async function notifyUser(
  subject: string,
  body: string,
  opts?: NotifyOpts,
): Promise<NotifyResult> {
  const dedupKey = opts?.dedupKey;
  const dedupWindowMs = opts?.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const topic = opts?.topic ?? { chat_id: getPaAlertsChatId(), thread_id: getPaAlertsThreadId() };
  const severity = opts?.severity ?? 'warn';

  // Forensic trail: phase 1 — attempting
  log('info', 'notify', 'attempting', { subject, dedupKey, severity, topic });

  // --- Dedup check (only when dedupKey is provided) ---
  if (dedupKey !== undefined) {
    try {
      const filePath = dedupFilePath(dedupKey);
      try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        const ts = new Date(parsed.timestamp).getTime();
        if (!isNaN(ts) && Date.now() - ts < dedupWindowMs) {
          log('info', 'notify', 'result', { subject, dedupKey, sent: false, suppressed: true, reason: 'dedup-suppressed' });
          return { sent: false, suppressed: true };
        }
      } catch {
        // File doesn't exist or is corrupt — proceed to send
      }
    } catch {
      // Dedup check failure — proceed to send anyway
    }
  }

  // --- Send ---
  if (process.env.PA_NOTIFY_DISABLED === '1') {
    log('info', 'notify', 'result', { subject, dedupKey, sent: false, suppressed: false, reason: 'disabled' });
    return { sent: false, suppressed: false };
  }

  const secrets = await loadSecrets(['TELEGRAM_BOT_TOKEN']);
  const token = secrets['TELEGRAM_BOT_TOKEN'];

  if (!token) {
    log('info', 'notify', 'result', { subject, dedupKey, sent: false, suppressed: false, reason: 'missing-token' });
    return { sent: false, suppressed: false };
  }

  const fullText = body ? `${subject}\n\n${body}` : subject;

  try {
    const sendPromise = sendToTelegram(
      fullText,
      { chat_id: topic.chat_id, thread_id: topic.thread_id, token_secret: 'TELEGRAM_BOT_TOKEN' },
      token,
      'MarkdownV2', // sendToTelegram routes the body through sanitizeMdV2 — alert bodies (paths, snake_case identifiers, parens) are escaped, italic `_Ref: <id>_` trailer renders as italic.
    );

    // 5 s hard timeout
    const timeoutPromise = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 5000),
    );

    await Promise.race([sendPromise, timeoutPromise]);

    // Write dedup state (only when dedupKey is provided)
    if (dedupKey !== undefined) {
      try {
        mkdirSync(alertStateDir(), { recursive: true });
        await writeFile(dedupFilePath(dedupKey), JSON.stringify({ timestamp: new Date().toISOString(), key: dedupKey, windowMs: dedupWindowMs }), 'utf8');
      } catch {
        // Dedup write failure — non-critical
      }
    }

    log('info', 'notify', 'result', { subject, dedupKey, sent: true, suppressed: false, reason: 'sent' });
    return { sent: true, suppressed: false };
  } catch (err: any) {
    const reason = err?.message === 'timeout' ? 'timeout' : 'telegram-error';
    log('info', 'notify', 'result', { subject, dedupKey, sent: false, suppressed: false, reason });
    return { sent: false, suppressed: false };
  }
}
