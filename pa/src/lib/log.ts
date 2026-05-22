/**
 * Structured logger for the PA platform.
 *
 * - Writes JSON lines to ~/.pa/app.log.jsonl for queryability
 * - Also writes human-readable output to stdout/stderr for terminal visibility
 * - Use: import { log } from '../lib/log.js'
 *        log('info', 'workers', 'starting run', { skill: 'daily-mail-brief' })
 */

import { appendFile, mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import lockfile from 'proper-lockfile';
import { paHome } from '../paths.js';
import { rotateFileIfNeeded } from './archive-files.js';

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
  return join(paHome(), 'app.log.jsonl');
}

let appendQueue: Promise<void> = Promise.resolve();

async function ensureLogFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '', { flag: 'wx' }).catch((err: any) => {
    if (err.code !== 'EEXIST') throw err;
  });
}

async function appendLogInner(line: string): Promise<void> {
  const logFile = getLogFile();
  await ensureLogFile(logFile);
  const release = await lockfile.lock(logFile, { retries: 5, realpath: false });
  try {
    await rotateFileIfNeeded(logFile, Buffer.byteLength(line, 'utf8'));
    await appendFile(logFile, line, 'utf8');
  } finally {
    await release();
  }
}

// Non-blocking fire-and-forget append to log file
function appendLog(entry: LogEntry): void {
  const line = JSON.stringify(entry) + '\n';
  appendQueue = appendQueue
    .catch(() => {})
    .then(() => appendLogInner(line))
    .catch(() => {
      // Swallow write errors — logging must never crash the caller
    });
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
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
    ...context,
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
