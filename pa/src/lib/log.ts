/**
 * Structured logger for the PA platform.
 *
 * - Writes JSON lines to ~/.pa/app.log.jsonl for queryability
 * - Also writes human-readable output to stdout/stderr for terminal visibility
 * - Use: import { log } from '../lib/log.js'
 *        log('info', 'workers', 'starting run', { skill: 'daily-mail-brief' })
 */

import { appendFile, mkdir, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import lockfile from 'proper-lockfile';
import { safeLockOptions } from './safe-lock.js';
import { paHome } from '../paths.js';
import { rotateFileIfNeeded } from './archive-files.js';
import { redactSecrets } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  [key: string]: unknown;
}

function getLogFile(): string {
  // Recompute on every call so PA_HOME changes (notably in tests with tmpdir
  // PA_HOME) take effect. The join() cost is negligible compared to the
  // appendFile syscall.
  const resolved = join(paHome(), 'app.log.jsonl');

  // DO NOT REGRESS: test-suite backstop. PA_TEST_LOG_HOME is set ONLY by the
  // two suite preloads (pa/tests/test-env-setup.ts, the bot's
  // projects/telegram-bot/src/tests/test-env-setup.ts) and never by any
  // production path, so this branch is unreachable outside a test run — it is
  // an explicit opt-in signal, deliberately NOT a heuristic like NODE_ENV or
  // "am I running under node --test".
  //
  // Why it exists: enqueue-time pinning (below) only guarantees that an entry
  // follows the PA_HOME that was in effect when it was CREATED. It cannot help
  // an entry created while PA_HOME is UNSET — and the suites do that
  // constantly: files that never set PA_HOME at all, the gap between a
  // helper's `delete process.env.PA_HOME` and the next beforeEach, and
  // fire-and-forget work that outlives its test (worker-exec's exit alert, the
  // bg-task orphan sweep, a killed worker's late 'close' event). Measured
  // 2026-07-21 AFTER the pinning fix: a single workers.test.js run still put 5
  // synthetic rows (spawn-failed worker-under-test, fake exhaustion notifies)
  // into the real ~/.pa/app.log.jsonl. Redirecting here makes production
  // pollution structurally impossible for the whole run instead of relying on
  // every test file to remember.
  const testLogHome = process.env.PA_TEST_LOG_HOME;
  // The resolve() pair only runs under a test preload, so production keeps the
  // single join() it has always had.
  if (testLogHome && resolve(resolved) === resolve(homedir(), '.pa', 'app.log.jsonl')) {
    return join(testLogHome, 'app.log.jsonl');
  }

  return resolved;
}

let appendQueue: Promise<void> = Promise.resolve();

// Count of primary (locked) write failures — incremented whenever
// appendLogInner rejects (lock-retry exhaustion, ensureLogFile failure,
// rotate failure, etc.), regardless of whether the unlocked fallback below
// then succeeds. Exported so tests can assert the fallback path actually ran
// without scraping stderr. See getLogWriteFailureCount/
// resetLogWriteFailureCountForTests below.
let logWriteFailureCount = 0;

async function ensureLogFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '', { flag: 'wx' }).catch((err: any) => {
    if (err.code !== 'EEXIST') throw err;
  });
}

async function appendLogInner(logFile: string, line: string): Promise<void> {
  await ensureLogFile(logFile);
  const release = await lockfile.lock(logFile, safeLockOptions('app-log', { retries: 5, realpath: false }));
  try {
    await rotateFileIfNeeded(logFile, Buffer.byteLength(line, 'utf8'));
    await appendFile(logFile, line, 'utf8');
  } finally {
    await release();
  }
}

/**
 * Last-resort UNLOCKED write, used only when the locked path
 * (appendLogInner) has already failed — e.g. lock-retry exhaustion under
 * contention from the bot + per-minute scheduled-task children hammering the
 * same app.log.jsonl (AI-111: two voice-transcription log lines vanished with
 * zero trace in production on 2026-08-08, traced to exactly this swallowed
 * failure). Accepts a small risk of interleaved writes under rare contention
 * — strictly better than losing the line entirely, since this is a
 * forensic/diagnostic log, not a source of truth requiring strict ordering.
 *
 * If even this fails, the entry is genuinely unrecoverable — surface it
 * loudly via a direct console.error (NEVER logger/log() here: logging
 * through this same module would recurse, exactly as safe-lock.ts's
 * onCompromised handler already documents for the same reason). Only a
 * bounded slice of the entry (timestamp/module/message) is printed, not
 * arbitrary context, to keep stderr output bounded.
 */
async function appendLogFallback(logFile: string, line: string, entry: LogEntry): Promise<void> {
  logWriteFailureCount++;
  try {
    await mkdir(dirname(logFile), { recursive: true });
    await appendFile(logFile, line, 'utf8');
  } catch (fallbackErr: any) {
    const reason = fallbackErr?.message ?? String(fallbackErr);
    console.error(
      `[log] DROPPED log entry — locked write failed and unlocked fallback also failed (${reason}): ` +
      `${entry.timestamp} [${entry.module}] ${entry.message}`
    );
  }
}

// Non-blocking fire-and-forget append to log file
function appendLog(entry: LogEntry): void {
  const line = JSON.stringify(entry) + '\n';
  // DO NOT REGRESS: resolve the destination HERE, synchronously at ENQUEUE
  // time, and carry it through the queue. Resolving it inside the async drain
  // instead (the pre-2026-07-21 behavior) reads PA_HOME whenever the queue
  // happens to get to this entry — so a test that sets PA_HOME to a tmpdir,
  // logs, and then clears PA_HOME in afterEach had its queued entries drain
  // against the fallback ~/.pa and wrote ~196 synthetic records (fake worker
  // failures, fake telegram sends with resolvable refIds) into the real
  // production forensic log. An entry belongs to the PA_HOME that was in
  // effect when it was created.
  const logFile = getLogFile();
  appendQueue = appendQueue
    .catch(() => {})
    .then(() => appendLogInner(logFile, line))
    .catch(() => appendLogFallback(logFile, line, entry));
  // appendLogFallback never rejects (it wraps its own try/catch), so this
  // chain — and therefore flushLog() — still never rejects and never throws
  // back to the caller, matching the pre-existing swallow contract.
}

/**
 * Resolves once all log appends queued so far have flushed to disk. log() is
 * fire-and-forget, so callers that need to READ the log right after writing
 * (notably tests) must await this — a fixed sleep races the async lock-based
 * append and flakes under load.
 *
 * Tests must also await it before removing a temp PA_HOME: queued entries are
 * pinned to the PA_HOME captured at enqueue time (see appendLog), so draining
 * after the directory is gone just loses them to a swallowed ENOENT.
 */
export function flushLog(): Promise<void> {
  return appendQueue.catch(() => {});
}

/**
 * Number of times the primary locked write (appendLogInner) has failed since
 * process start (or the last resetLogWriteFailureCountForTests() call),
 * regardless of whether the unlocked fallback then recovered the entry.
 * AI-111: makes the fallback path observable/testable without scraping
 * stderr for the console.error diagnostic.
 */
export function getLogWriteFailureCount(): number {
  return logWriteFailureCount;
}

/** Test-only reset for getLogWriteFailureCount(). */
export function resetLogWriteFailureCountForTests(): void {
  logWriteFailureCount = 0;
}

const LEVEL_PREFIX: Record<LogLevel, string> = {
  debug: '[DEBUG]',
  info:  '[INFO] ',
  warn:  '[WARN] ',
  error: '[ERROR]',
};

export function log(
  level: LogLevel,
  module: string,
  message: string,
  context?: Record<string, unknown>
): void {
  // Redact secrets from context values before logging
  const redactedContext = context ? redactSecrets(context) as Record<string, unknown> : context;
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
    ...redactedContext,
  };

  appendLog(entry);

  // Human-readable terminal output
  const prefix = LEVEL_PREFIX[level];
  const contextStr = context ? ' ' + JSON.stringify(context) : '';
  const line = `${prefix} [${module}] ${message}${contextStr}`;

  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

// Convenience shorthands
export const logger = {
  debug: (module: string, message: string, ctx?: Record<string, unknown>) => log('debug', module, message, ctx),
  info:  (module: string, message: string, ctx?: Record<string, unknown>) => log('info', module, message, ctx),
  warn:  (module: string, message: string, ctx?: Record<string, unknown>) => log('warn', module, message, ctx),
  error: (module: string, message: string, ctx?: Record<string, unknown>) => log('error', module, message, ctx),
};
