import { readFile, stat, open, readdir } from 'fs/promises';
import { join } from 'path';
import { resolveStateDir, findLatestStateFile } from './state-monitor.js';
import type { RateLimitParseResult } from './rate-limits.js';
import { DEFAULT_COOLDOWN_MINUTES, BURST_RETRY_COOLDOWN_S } from './rate-limits.js';
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

// ---------------------------------------------------------------------------
// Zhipu terminal billing fault (account balance exhausted)
// ---------------------------------------------------------------------------

/**
 * How long to bench a worker whose ACCOUNT is exhausted (as opposed to a
 * transient rate limit). Six hours is the deliberate middle of two failure
 * modes: too short and we are back to re-probing a dead worker on every
 * dispatch (2026-07-11..19: zclaude never got a cooldown at all — 150
 * `spawn-failed` rows and ~2.1h of wall clock burned on doomed attempts, all
 * silently absorbed by failover); too long and a recharge that the user
 * performs quietly goes unnoticed for a whole day. At 6h the worst case is
 * ~4 wasted probes/day, and a recharge is picked up automatically within a
 * quarter of a day even if nobody clears the cooldown by hand.
 */
export const ACCOUNT_EXHAUSTED_COOLDOWN_MINUTES = 6 * 60;

/**
 * Absence-ladder probe cooldown (operator ruling 2026-09-13): a fresh 429
 * whose message states NEITHER an end time NOR a recognizable class gets this
 * short probe rest plus a loud unparseable-log row — never a fabricated long
 * "usage-limit-session" window again (the ghost-cooldown factory that parked
 * threads against workers which were not actually windowed). The park-cycle
 * retry IS the probe: it either recovers or re-records with fresh evidence.
 */
export const RATE_LIMIT_PROBE_COOLDOWN_MIN = 15;

/**
 * Proxy-banner noise (2026-09-13): zclaude output carrying these CLI banners
 * is not rate-limit evidence at all — it is auth/config noise riding in the
 * worker stream that, treated as 429 evidence, fed the transient gate, the
 * cooldown fallback and the unparseable log (4 rows on its first day).
 * Contains-check on the two exact CLI literals suffices; both are fixed
 * strings the CLI itself prints.
 */
const PROXY_BANNER_NOISE = /claude\.ai connectors are disabled|unrecognized_model/;

export function isProxyBannerNoise(text: string): boolean {
  return !!text && PROXY_BANNER_NOISE.test(text);
}

/**
 * Time-hint heuristic (2026-09-13): the message LOOKS like it carries timing
 * information the parser failed to read. Its unparseable-log rows (reason
 * 'time-hint-unparsed') feed the hourly retrospective digest, so a new
 * provider phrasing surfaces within the hour — and feeds the parser
 * self-heal — instead of silently falling to the probe cooldown forever.
 */
const TIME_HINT_RE =
  /\bresets?\b|\b(?:am|pm)\b|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}|\b\d+\s*(?:minute|hour|day)s?\b/i;

export function hasTimeHint(text: string): boolean {
  return !!text && TIME_HINT_RE.test(text);
}

/**
 * Burst phrasing (2026-09-13): a 429 with NO stated end whose text is still
 * recognizably a per-request-rate limit ("[1302] Rate limit reached for
 * requests", "too many requests") is burst-class — retrying shortly is the
 * correct response. recordRateLimit maps this classification to the 90s
 * retry cooldown plus a slot-governor shed; the classifier returns that same
 * duration directly so the value is right even when read without recording.
 */
const BURST_PHRASING_RE = /\[\s*1302\s*\]|rate limit|too many requests/i;

// Zhipu (GLM) returns `[1113][Insufficient balance or no resource package...]`
// for an exhausted account balance. Either half of the signature is sufficient
// evidence ONCE we already know we are looking at a 429 error payload.
const ZHIPU_BALANCE_SIGNATURE = /\[\s*1113\s*\]|Insufficient balance or no resource package/i;

// The error framing that must accompany the signature ON THE SAME LINE when we
// are scanning raw worker output (as opposed to a parsed api_error event).
// Without this second half, the phrase appearing in ordinary prose — a user
// asking what the error means, a doc snippet quoting it, a transcript that also
// happens to mention a 429 elsewhere — would classify a healthy worker as dead.
const ZHIPU_ERROR_FRAME = /(?:API\s*Error|Request\s+rejected|status)[^\n]{0,80}\b429\b/i;

/**
 * True when `text` (already known to be a 429 error payload, e.g. the message of
 * a session api_error event) carries Zhipu's balance-exhausted signature.
 */
export function hasZhipuBalanceSignature(text: string): boolean {
  return !!text && ZHIPU_BALANCE_SIGNATURE.test(text);
}

/**
 * Classify raw zclaude/claude output as a TERMINAL account-balance fault.
 *
 * zclaude is a Zhipu GLM wrapper (ANTHROPIC_BASE_URL → api.z.ai). Zhipu reports
 * an exhausted account balance as error 1113 over HTTP **429** — the same status
 * a transient rate limit uses — so the generic path treats a permanent billing
 * fault as something that will heal in two minutes. It never heals: only a human
 * recharge clears it. Returns null when the signature is absent or when it
 * appears without the accompanying 429 error framing.
 */
export function classifyZhipuAccountExhausted(text: string): RateLimitParseResult | null {
  if (!text) return null;
  const idx = text.search(ZHIPU_BALANCE_SIGNATURE);
  if (idx < 0) return null;

  // Both halves must sit on the same line — a worker's error output emits the
  // whole payload as one line, whereas prose that merely mentions the phrase
  // does not carry the 429 framing alongside it.
  const lineStart = text.lastIndexOf('\n', idx) + 1;
  const nextNewline = text.indexOf('\n', idx);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;
  const line = text.slice(lineStart, lineEnd);
  if (!ZHIPU_ERROR_FRAME.test(line)) return null;

  return {
    minutes: ACCOUNT_EXHAUSTED_COOLDOWN_MINUTES,
    classification: 'account-exhausted',
    source: 'zhipu-text',
    raw: line.slice(0, 300).replace(/\s+/g, ' ').trim(),
  };
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

  // 4. Weekly/monthly limits state a full date: "resets Sep 15, 5:30pm
  // (Asia/Kolkata)". Case 3 cannot match the "Sep 15," prefix (it wants
  // digits straight after "resets"), so this clearly-stated end time used to
  // fall through to the no-time fallback and got fabricated into a cooldown
  // (2026-09-13 ghost-cooldown incident). Parsed in LOCAL time — the trailing
  // "(Asia/Kolkata)" annotation is informational and this machine runs IST;
  // an unparseable month/day or a target still in the past after the yearly
  // rollover falls through to null (the probe ladder handles it loudly).
  const datedResetMatch = text.match(
    /resets\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})\s*(am|pm)/i,
  );
  if (datedResetMatch) {
    const [, monStr, dStr, hStr, mStr, ampm] = datedResetMatch;
    const monthIdx = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
      .indexOf(monStr.toLowerCase());
    if (monthIdx >= 0) {
      let targetH = parseInt(hStr, 10);
      const targetM = parseInt(mStr, 10);
      if (ampm.toLowerCase() === 'pm' && targetH < 12) targetH += 12;
      if (ampm.toLowerCase() === 'am' && targetH === 12) targetH = 0;
      const now = new Date();
      const target = new Date(now.getFullYear(), monthIdx, parseInt(dStr, 10), targetH, targetM, 0, 0);
      if (target <= now) target.setFullYear(target.getFullYear() + 1);
      const diffMs = target.getTime() - now.getTime();
      if (diffMs > 0) {
        return {
          minutes: Math.ceil(diffMs / 60000),
          source: 'claude-text',
          resetsAtIST: formatIST(target),
        };
      }
    }
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

  const latest = fresh[fresh.length - 1];

  // 2b. Proxy-banner noise is not rate-limit evidence (2026-09-13): a latest
  // event dominated by the CLI's auth/config banners is treated as absent —
  // no transient no-op, no cooldown, no fallback, nothing logged.
  if (isProxyBannerNoise(latest.message)) {
    return null;
  }

  // 3. Terminal account-balance fault — checked BEFORE the retry-budget gate.
  // Retrying an exhausted balance is pointless: it is not a window that reopens,
  // it is a bill that has to be paid. Returning the transient no-op here would
  // leave the worker un-cooled and re-probed on every dispatch.
  if (latest.code === '1113' || hasZhipuBalanceSignature(latest.message)) {
    return {
      minutes: ACCOUNT_EXHAUSTED_COOLDOWN_MINUTES,
      classification: 'account-exhausted',
      source: 'claude-session',
      raw: latest.message,
    };
  }

  // 4. All fresh events still within retry budget → transient no-op
  if (latest.retryAttempt < latest.maxRetries) {
    return {
      minutes: 0,
      classification: 'unknown',
      source: 'claude-session',
    };
  }

  // 5. Latest fresh event exhausted retries → flag
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

  // 6. No stated end — the absence ladder (operator ruling 2026-09-13; the
  // fabricated 60-minute 'usage-limit-session' fallback is deleted):
  //    - burst phrasing, no time → burst class; recordRateLimit turns this
  //      classification into the 90s retry cooldown plus a slot-governor shed;
  //    - anything else → the short probe cooldown, and the caller's claude
  //      branch writes the loud unparseable-log row ('time-hint-unparsed'
  //      when the text looks like it carried timing the parser missed, else
  //      'unknown-pattern').
  if (BURST_PHRASING_RE.test(latest.message)) {
    return {
      minutes: BURST_RETRY_COOLDOWN_S / 60,
      classification: 'quota-per-minute',
      source: 'claude-session',
      raw: latest.message,
    };
  }
  return {
    minutes: RATE_LIMIT_PROBE_COOLDOWN_MIN,
    classification: 'unknown',
    source: 'claude-session',
    raw: latest.message,
  };
}
