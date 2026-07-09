import { mkdir, readFile, rename, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import lockfile from 'proper-lockfile';
import { safeLockOptions } from './lib/safe-lock.js';

export type RateLimitClassification =
  | 'quota-daily'
  | 'quota-per-minute'
  | 'quota-exhausted'
  | 'server-overload'
  | 'usage-limit-session'
  | 'auth-error'
  | 'unknown';

export type RateLimitSource =
  | 'claude-session'
  | 'claude-text'
  | 'zhipu-text'
  | 'gemini-stderr'
  | 'codex-telemetry'
  | 'codex-stderr'
  | 'generic-retry'
  | 'default';

export interface RateLimitParseResult {
  minutes: number;
  classification: RateLimitClassification;
  source: RateLimitSource;
  resetsAtIST?: string;
  raw?: string;
}

export interface WorkerCooldown {
  cooldown_until: string;
  last_event: string;
  reason: string;
  classification?: RateLimitClassification;
}

type RateLimitState = Record<string, WorkerCooldown>;

export const DEFAULT_COOLDOWN_MINUTES = 2;

export function parseRateLimitDuration(output: string, worker?: string): number {
  const now = new Date();

  if (worker === 'claude' || worker === 'zclaude') {
    const resetMatch = output.match(/resets\s+(\d+):(\d+)(am|pm)/i);
    if (resetMatch) {
      const [_, hStr, mStr, ampm] = resetMatch;
      let targetH = parseInt(hStr, 10);
      const targetM = parseInt(mStr, 10);

      if (ampm.toLowerCase() === 'pm' && targetH < 12) targetH += 12;
      if (ampm.toLowerCase() === 'am' && targetH === 12) targetH = 0;

      const target = new Date(now);
      target.setHours(targetH, targetM, 0, 0);

      if (target <= now) {
        target.setDate(target.getDate() + 1);
      }

      const diffMs = target.getTime() - now.getTime();
      return Math.ceil(diffMs / (60 * 1000));
    }
  }

  const hourMatch = output.match(/for\s+(\d+)\s+hour/i);
  if (hourMatch) return parseInt(hourMatch[1], 10) * 60;

  const minMatch = output.match(/retry.{0,20}after\s+(\d+)\s+min/i);
  if (minMatch) return parseInt(minMatch[1], 10);

  return DEFAULT_COOLDOWN_MINUTES;
}

/**
 * Worker-aware rate-limit classifier. Dispatches to per-worker sub-classifiers
 * that live in rate-limits-{gemini,codex,claude}.ts. Phases 2-4 extend each
 * branch; until wired, returns an unknown/default result.
 */
/**
 * Worker-aware rate-limit classifier.
 *
 * Returns null when there is no evidence of a rate limit — the caller should
 * treat the failure as a regular (non-rate-limit) error and stop, not failover.
 *
 * Returns { minutes: 0 } when a rate limit is confirmed but the worker is still
 * within its internal retry budget — caller should skip to the next worker.
 *
 * Returns { minutes > 0 } for a confirmed, exhausted rate limit — caller should
 * record the cooldown and failover.
 */
export async function classifyRateLimit(
  worker: string,
  stdout: string,
  stderr: string,
  sessionId?: string,
  stateDir?: string,
  statePattern?: string,
): Promise<RateLimitParseResult | null> {
  if (worker === 'claude' || worker === 'zclaude') {
    // Session JSONL is the authoritative mechanism: exact 429 api_error events written by the CLI.
    // No text heuristics. Returns null when no session evidence (= not a rate limit).
    const { readClaudeSessionErrors, classifyClaudeErrors } = await import('./rate-limits-claude.js');
    const errors = stateDir && statePattern
      ? await readClaudeSessionErrors(sessionId, stateDir, statePattern)
      : [];
    const result = classifyClaudeErrors(errors);
    if (result === null && /429|rate limit|quota/i.test(stdout + stderr)) {
      const { appendUnparseableRateLimit } = await import('./rate-limit-unparseable-log.js');
      const combined = (stdout + stderr).slice(0, 100);
      await appendUnparseableRateLimit({ timestamp: new Date().toISOString(), worker, raw: combined, session_id: sessionId, reason: 'no-session-evidence' });
    }
    return result;
  }

  if (worker === 'gemini' || worker === 'agy') {
    // Google API 429 / RESOURCE_EXHAUSTED in stderr. Returns null for non-rate-limit stderr.
    const { classifyGeminiError } = await import('./rate-limits-gemini.js');
    const result = classifyGeminiError(stderr) ?? null;
    if (result === null && /rate limit|quota/i.test(stderr)) {
      const { appendUnparseableRateLimit } = await import('./rate-limit-unparseable-log.js');
      await appendUnparseableRateLimit({ timestamp: new Date().toISOString(), worker, raw: stderr.slice(0, 100), session_id: sessionId, reason: 'no-session-evidence' });
    }
    return result;
  }

  if (worker === 'codex') {
    // Exact usage-limit message captured from NDJSON error events into result.error.
    // Returns null for unrecognized errors.
    const { classifyCodexError } = await import('./rate-limits-codex.js');
    const result = classifyCodexError(stdout, stderr) ?? null;
    if (result === null && /rate limit|quota|usage limit/i.test(stdout + stderr)) {
      const { appendUnparseableRateLimit } = await import('./rate-limit-unparseable-log.js');
      const combined = (stdout + stderr).slice(0, 100);
      await appendUnparseableRateLimit({ timestamp: new Date().toISOString(), worker, raw: combined, session_id: sessionId, reason: 'no-session-evidence' });
    }
    return result;
  }

  // Unknown/custom worker: isRateLimited already confirmed a pattern match before
  // classifyRateLimit is called for these workers. Return a default short cooldown
  // so the worker gets a brief rest and we fail over to the next one.
  return { minutes: DEFAULT_COOLDOWN_MINUTES, classification: 'unknown', source: 'default' };
}

function statePath(): string {
  const paHome = process.env.PA_HOME ?? join(homedir(), '.pa');
  return join(paHome, 'rate-limit-state.json');
}

let cache: RateLimitState | null = null;
let cacheMtimeMs = 0;

async function ensureStateFile(): Promise<void> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '{}', { flag: 'wx' }).catch((err: any) => {
    if (err.code !== 'EEXIST') throw err;
  });
}

// In-process mutex: serialize same-process callers BEFORE the cross-process
// file lock. Without this, many concurrent same-process calls stampede the file
// lock — proper-lockfile's synchronized retry backoff then lets only ~1 acquirer
// through per round, so high concurrency exhausts retries ("Lock file is already
// being held"). Queuing in-process means only one file-lock acquisition is ever
// in flight per process; the file lock still guards against OTHER processes.
let rlMutex: Promise<void> = Promise.resolve();

async function withRateLimitLock<T>(fn: () => Promise<T>): Promise<T> {
  // Chain the mutex SYNCHRONOUSLY (before any await) so callers serialize in
  // call order (FIFO) — this preserves last-write-wins for back-to-back records
  // of the same worker. Doing it after an await would order by await-resume
  // timing instead, which is non-deterministic.
  const prev = rlMutex;
  let releaseMutex!: () => void;
  rlMutex = new Promise<void>((resolve) => { releaseMutex = resolve; });
  await prev.catch(() => {});
  try {
    const path = statePath();
    await ensureStateFile();
    const release = await lockfile.lock(path, safeLockOptions('rate-limits', { retries: 10, realpath: false }));
    try {
      return await fn();
    } finally {
      await release();
    }
  } finally {
    releaseMutex();
  }
}

async function loadState(): Promise<RateLimitState> {
  const path = statePath();

  if (cache !== null) {
    try {
      const info = await stat(path);
      if (info.mtimeMs === cacheMtimeMs) return cache;
    } catch {
      // Fall through to a disk read.
    }
  }

  try {
    const raw = await readFile(path, 'utf8');
    cache = JSON.parse(raw) as RateLimitState;
  } catch {
    cache = {};
  }
  try {
    cacheMtimeMs = (await stat(path)).mtimeMs;
  } catch {
    cacheMtimeMs = 0;
  }
  return cache;
}

async function saveState(state: RateLimitState): Promise<void> {
  const path = statePath();
  // Unique per-write tmp name: a FIXED tmp path races under concurrent
  // writers (writer A renames while writer B is mid-writeFile into the same
  // tmp → EPERM on Windows). Same fix class as logger.ts's pointer writes.
  const tmp = `${path}.${process.pid.toString(36)}-${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, path);
  cache = state;
  try {
    cacheMtimeMs = (await stat(path)).mtimeMs;
  } catch {
    cacheMtimeMs = 0;
  }
}

export async function recordRateLimit(
  worker: string,
  durationMinutes: number = DEFAULT_COOLDOWN_MINUTES,
  reason: string = 'rate limit detected',
  classification?: RateLimitClassification,
): Promise<void> {
  if (durationMinutes <= 0) {
    console.log(`[rate-limit] skip: ${worker} transient retry in progress`);
    return;
  }
  await withRateLimitLock(async () => {
    const state = await loadState();
    const cooldownUntil = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
    state[worker] = {
      cooldown_until: cooldownUntil,
      last_event: new Date().toISOString(),
      reason,
      ...(classification ? { classification } : {}),
    };
    console.log(`[rate-limit] ${worker} cooling down until ${cooldownUntil} (${reason})`);
    await saveState(state);
  });
}

export async function isWorkerCoolingDown(worker: string): Promise<boolean> {
  return withRateLimitLock(async () => {
    const state = await loadState();
    const entry = state[worker];
    if (!entry) return false;
    if (new Date(entry.cooldown_until) > new Date()) return true;
    delete state[worker];
    await saveState(state);
    return false;
  });
}

export async function getCooldownStatus(): Promise<RateLimitState> {
  return withRateLimitLock(async () => structuredClone(await loadState()));
}

/**
 * Return the cooldown entry for a single worker (or null). Does not mutate state.
 */
export async function getWorkerCooldown(worker: string): Promise<WorkerCooldown | null> {
  return withRateLimitLock(async () => {
    const state = await loadState();
    const entry = state[worker];
    if (!entry) return null;
    if (new Date(entry.cooldown_until) <= new Date()) return null;
    return structuredClone(entry);
  });
}

/** Clear the in-memory cache — for testing only. */
export function clearRateLimitCache(): void {
  cache = null;
  cacheMtimeMs = 0;
}
