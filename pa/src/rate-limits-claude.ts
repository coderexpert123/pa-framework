import { readFile, stat, open, readdir } from 'fs/promises';
import { join } from 'path';
import { resolveStateDir, findLatestStateFile } from './state-monitor.js';
import type { RateLimitParseResult } from './rate-limits.js';
import { DEFAULT_COOLDOWN_MINUTES } from './rate-limits.js';
import { formatIST } from './ist.js';

export interface ApiErrorEvent {
  status: number;
  code?: string;
  message: string;
  retryAttempt: number;
  maxRetries: number;
  timestamp: string;
}

const SESSION_FILE_SEARCH_TIMEOUT_MS = 500;
const TAIL_READ_BYTES = 32 * 1024;
const FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

/**
 * Walk one subdirectory level under `dir` looking for a file whose name is
 * exactly `${sessionId}${ext}` (where ext is derived from `pattern`).
 * Mirrors findLatestStateFile's walk pattern but targets a specific filename.
 */
export async function findStateFileById(
  dir: string,
  sessionId: string,
  pattern: string,
): Promise<{ path: string; mtime: Date } | null> {
  try {
    const ext = pattern.replace('*', '');
    const targetName = `${sessionId}${ext}`;
    const resolved = resolveStateDir(dir);
    const entries = await readdir(resolved, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(resolved, entry.name);
      if (entry.isDirectory()) {
        try {
          const subEntries = await readdir(fullPath);
          if (subEntries.includes(targetName)) {
            const fp = join(fullPath, targetName);
            const s = await stat(fp);
            return { path: fp, mtime: s.mtime };
          }
        } catch {}
      } else if (entry.name === targetName) {
        const s = await stat(fullPath);
        return { path: fullPath, mtime: s.mtime };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function tailFile(path: string, bytes: number): Promise<string> {
  const s = await stat(path);
  const readSize = Math.min(s.size, bytes);
  if (s.size > readSize) {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, s.size - readSize);
      return buf.toString('utf8');
    } finally {
      await fh.close();
    }
  }
  return readFile(path, 'utf8');
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    p.then((v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    }).catch(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

async function readErrorsFromFile(path: string): Promise<ApiErrorEvent[]> {
  const content = await tailFile(path, TAIL_READ_BYTES);
  const lines = content.split('\n');
  const errors: ApiErrorEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);

      // Existing path: type=system, subtype=api_error, status=429
      if (ev?.type === 'system' && ev?.subtype === 'api_error' && ev?.error?.status === 429) {
        // The Zhipu sample nests as: error.error.error.{code,message}
        // The Anthropic format may differ; extract best-effort.
        const inner = ev?.error?.error?.error ?? ev?.error?.error ?? ev?.error;
        const message: string = typeof inner?.message === 'string' ? inner.message : '';
        const code: string | undefined = typeof inner?.code === 'string' ? inner.code : undefined;
        const retryAttempt = typeof ev?.retryAttempt === 'number' ? ev.retryAttempt : 999;
        const maxRetries = typeof ev?.maxRetries === 'number' ? ev.maxRetries : 10;
        const timestamp = typeof ev?.timestamp === 'string' ? ev.timestamp : new Date().toISOString();
        errors.push({ status: 429, code, message, retryAttempt, maxRetries, timestamp });
        continue;
      }

      // Synthetic assistant message: Claude Code CLI writes quota 429s as assistant envelopes
      // (type:"assistant", model:"<synthetic>") instead of system api_error events.
      if (ev?.type === 'assistant') {
        const contentBlocks = ev?.message?.content;
        const text: string = Array.isArray(contentBlocks)
          ? contentBlocks
              .filter((b: any) => b?.type === 'text')
              .map((b: any) => b.text as string)
              .join('')
          : '';

        // Strategy A: first-class structural fields (authoritative — preferred)
        const isStrategyA = ev?.isApiErrorMessage === true && ev?.apiErrorStatus === 429;
        // Strategy B: text heuristic fallback for CLI format drift
        const isStrategyB =
          !isStrategyA &&
          ev?.message?.model === '<synthetic>' &&
          (/\b429\b/.test(text) ||
            /Weekly\/Monthly Limit Exhausted/i.test(text) ||
            /Request rejected\s*\(429\)/i.test(text));

        if (isStrategyA || isStrategyB) {
          const timestamp = typeof ev?.timestamp === 'string' ? ev.timestamp : new Date().toISOString();
          errors.push({ status: 429, code: 'synthetic_assistant', message: text, retryAttempt: 999, maxRetries: 10, timestamp });
        }
      }
    } catch {
      // skip malformed line
    }
  }
  return errors;
}

/**
 * Read api_error events from the claude CLI session JSONL. Non-throwing;
 * any IO failure returns []. Bounded by a 500ms soft timeout so dispatch
 * is never blocked on file reads.
 */
export async function readClaudeSessionErrors(
  sessionId: string | undefined,
  stateDir: string,
  statePattern: string,
): Promise<ApiErrorEvent[]> {
  const inner = async (): Promise<ApiErrorEvent[]> => {
    try {
      let target: { path: string; mtime: Date } | null = null;
      if (sessionId) {
        target = await findStateFileById(stateDir, sessionId, statePattern);
      }
      if (!target) {
        const latest = await findLatestStateFile(resolveStateDir(stateDir), statePattern);
        if (!latest) return [];
        // Only trust the latest file if it's been touched recently
        if (Date.now() - latest.mtime.getTime() > FRESHNESS_WINDOW_MS) return [];
        target = latest;
      }
      return await readErrorsFromFile(target.path);
    } catch {
      return [];
    }
  };
  return withTimeout(inner(), SESSION_FILE_SEARCH_TIMEOUT_MS, []);
}

function extractMinutesFromText(text: string): { minutes: number; source: 'zhipu-text' | 'claude-text'; resetsAtIST?: string } | null {
  // 1. Zhipu "Usage limit reached for N hour" — preferred (unambiguous)
  const hourMatch = text.match(/Usage limit reached for\s+(\d+)\s+hour/i);
  if (hourMatch) {
    return {
      minutes: parseInt(hourMatch[1], 10) * 60,
      source: 'zhipu-text',
    };
  }

  // 2. "Your limit will reset at YYYY-MM-DD HH:MM:SS" — Anthropic style, treat as UTC
  const absMatch = text.match(/Your limit will reset at\s+(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}:\d{2})/);
  if (absMatch) {
    // Parse as UTC
    const iso = `${absMatch[1]}T${absMatch[2]}Z`;
    const target = new Date(iso);
    if (!isNaN(target.getTime())) {
      const diffMs = target.getTime() - Date.now();
      if (diffMs > 0) {
        return {
          minutes: Math.ceil(diffMs / 60000),
          source: 'claude-text',
          resetsAtIST: formatIST(target),
        };
      }
    }
  }

  // 3. Claude CLI "resets 10:30am" — existing logic
  const resetMatch = text.match(/resets\s+(\d+):(\d+)(am|pm)/i);
  if (resetMatch) {
    const [, hStr, mStr, ampm] = resetMatch;
    let targetH = parseInt(hStr, 10);
    const targetM = parseInt(mStr, 10);
    if (ampm.toLowerCase() === 'pm' && targetH < 12) targetH += 12;
    if (ampm.toLowerCase() === 'am' && targetH === 12) targetH = 0;
    const now = new Date();
    const target = new Date(now);
    target.setHours(targetH, targetM, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    const diffMs = target.getTime() - now.getTime();
    return {
      minutes: Math.ceil(diffMs / 60000),
      source: 'claude-text',
      resetsAtIST: formatIST(target),
    };
  }

  return null;
}

/**
 * Sync text-only classifier. Used as fallback both from classifyClaudeErrors
 * and from callers that only have the raw output string.
 */
export function classifyClaudeText(text: string): RateLimitParseResult {
  const extracted = extractMinutesFromText(text);
  if (extracted) {
    return {
      minutes: extracted.minutes,
      classification: 'usage-limit-session',
      source: extracted.source,
      resetsAtIST: extracted.resetsAtIST,
    };
  }
  return {
    minutes: DEFAULT_COOLDOWN_MINUTES,
    classification: 'unknown',
    source: 'default',
  };
}

/**
 * Classify claude/zclaude rate-limit state from api_error events read from the
 * session JSONL file.
 *
 * Returns null when there are no fresh 429 events — meaning there is no
 * confirmed rate-limit evidence and the failure should be treated normally
 * (regular execution error, not a rate limit).
 *
 * Returns { minutes: 0 } when retries are still in progress (transient).
 * Returns { minutes > 0 } when retries are exhausted and a cooldown is warranted.
 *
 * No text heuristics: session JSONL is the only authoritative mechanism.
 */
export function classifyClaudeErrors(
  errors: ApiErrorEvent[],
): RateLimitParseResult | null {
  // 1. Temporal freshness filter
  const cutoff = Date.now() - FRESHNESS_WINDOW_MS;
  const fresh = errors.filter((e) => {
    const t = new Date(e.timestamp).getTime();
    return !isNaN(t) && t >= cutoff;
  });

  // 2. No fresh session events → no confirmed rate limit (treat as regular failure)
  if (fresh.length === 0) {
    return null;
  }

  // 3. All fresh events still within retry budget → transient no-op
  const latest = fresh[fresh.length - 1];
  if (latest.retryAttempt < latest.maxRetries) {
    return {
      minutes: 0,
      classification: 'unknown',
      source: 'claude-session',
    };
  }

  // 4. Latest fresh event exhausted retries → flag
  const fromMessage = extractMinutesFromText(latest.message);
  if (fromMessage) {
    return {
      minutes: fromMessage.minutes,
      classification: 'usage-limit-session',
      source: 'claude-session',
      resetsAtIST: fromMessage.resetsAtIST,
      raw: latest.message,
    };
  }
  return {
    minutes: 60,
    classification: 'usage-limit-session',
    source: 'claude-session',
    raw: latest.message,
  };
}
