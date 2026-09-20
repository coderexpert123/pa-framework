import { mkdir, readFile, rename, stat, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import lockfile from 'proper-lockfile';
import { safeLockOptions } from './lib/safe-lock.js';
import { log } from './lib/log.js';
import { noteQuotaBurst } from './lib/dynamic-slots.js';
import { withBoundedQueue } from './lib/stall.js';
import type { WorkerConfig } from './types.js';

export type RateLimitClassification =
  | 'quota-daily'
  | 'quota-per-minute'
  | 'quota-exhausted'
  | 'server-overload'
  | 'usage-limit-session'
  | 'auth-error'
  // Terminal provider-side BILLING fault (e.g. Zhipu 1113 "Insufficient balance
  // or no resource package") delivered over HTTP 429. Not a rate limit: it never
  // self-heals, so it earns a long cooldown plus a user alert, not a 2-minute rest.
  | 'account-exhausted'
  | 'unknown';

export type RateLimitSource =
  | 'claude-session'
  | 'claude-text'
  | 'zhipu-text'
  | 'gemini-stderr'
  // agy's own CLI-level text ("Individual quota reached...") — a terminal
  // subscription fault, distinct from the JSON API 429 blobs 'gemini-stderr'
  // covers (some of which, e.g. Rule 4's server-granted retryDelay, ARE
  // self-healing and must not trigger the terminal-fault alert below).
  | 'gemini-cli-text'
  | 'codex-telemetry'
  | 'codex-stderr'
  // Devin CLI / Codeium cloud quota and rate-limit text on stderr/stdout.
  | 'devin-text'
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

/**
 * Cooldown for a BURST-shaped rate limit (operator ruling 2026-09-13,
 * superseding the same-day 30m quota-window cap it replaced). Two classes of
 * 429, two correct responses:
 * - The message CLEARLY states an end time ("resets 6pm", "until <datetime>",
 *   "rate limited till X"): TRUST it — the parsed duration is recorded
 *   verbatim, no cap. Waiting until the stated reset is the correct response.
 * - The limit is burst-shaped ('quota-per-minute': per-request-rate /
 *   too-many-requests limits with no parseable end): retrying shortly IS the
 *   correct response, so the event records this short cooldown instead of its
 *   nominal minutes, and the slot governor sheds capacity (noteQuotaBurst) —
 *   the concurrency causing the burst is reduced there, not by parking the
 *   worker.
 */
export const BURST_RETRY_COOLDOWN_S = 90;

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
 * A dead priority-1 worker is exactly the class of thing the user must be told
 * about — failover keeps the fleet working, which is precisely why nobody
 * noticed zclaude was dead for eight days. Alerts once per cooldown window via a
 * stable dedupKey (so a genuinely dead account nags at the cooldown cadence, not
 * on every dispatch) and never throws: notification failure must not change
 * dispatch behaviour.
 */
async function alertAccountExhausted(worker: string, result: RateLimitParseResult): Promise<void> {
  log('warn', 'rate-limits', `terminal account fault: ${worker} benched`, {
    worker,
    classification: result.classification,
    minutes: result.minutes,
    source: result.source,
    raw: result.raw?.slice(0, 300),
  });
  try {
    const { notifyUser } = await import('./lib/notify.js');
    await notifyUser(
      `Worker ${worker} disabled — account balance exhausted`,
      [
        `${worker} is returning a terminal billing fault (HTTP 429 carrying Zhipu code 1113, "Insufficient balance or no resource package"). This is NOT a rate limit and will not clear on its own.`,
        '',
        `Action required: recharge the Zhipu (z.ai) account. Until then ${worker} is benched for ${result.minutes} minutes and every dispatch fails over to the next worker.`,
        '',
        `Raw: ${(result.raw ?? '').slice(0, 300)}`,
      ].join('\n'),
      {
        dedupKey: `worker-account-exhausted:${worker}`,
        dedupWindowMs: result.minutes * 60 * 1000,
        severity: 'error',
        runbook: 'runbooks/machine-hang.md',
      },
    );
  } catch (err: any) {
    log('warn', 'rate-limits', 'account-exhausted alert failed', { worker, error: err?.message });
  }
}

/**
 * Worker-aware rate-limit classifier. Dispatches to per-worker sub-classifiers
 * that live in rate-limits-{google,codex,claude}.ts (rate-limits-google.ts is the file
 * rate-limits-gemini.ts; name kept for git-history continuity — it classifies the
 * Google-API error family agy emits).
 *
 * Returns null when there is no evidence of a rate limit — the caller should
 * treat the failure as a regular (non-rate-limit) error and stop, not failover.
 *
 * Returns { minutes: 0 } when a rate limit is confirmed but the worker is still
 * within its internal retry budget — caller should skip to the next worker.
 *
 * Returns { minutes > 0 } for a confirmed, exhausted rate limit — caller should
 * record the cooldown and failover. 'account-exhausted' is the terminal variant:
 * same shape, long cooldown, and the user has already been alerted here.
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
    // (Dynamic import kept: rate-limits-claude.ts statically imports this
    // module's constants, so a static edge back would close a require cycle.)
    const { readClaudeSessionErrors, classifyClaudeErrors, classifyZhipuAccountExhausted, isProxyBannerNoise, hasTimeHint } = await import('./rate-limits-claude.js');

    // Terminal billing faults are checked on the RAW output first, ahead of the
    // session-JSONL path. The 2026-07 zclaude incident produced no session
    // evidence at all — the 1113 error landed in stdout only, so the session
    // classifier returned null, the failure was logged as 'no-session-evidence'
    // and NO cooldown was ever written. Text heuristics stay banned for ordinary
    // rate limits; this narrow, unambiguous signature is the sole exception,
    // because the cost of missing it is an unbounded per-dispatch retry loop.
    const terminal = classifyZhipuAccountExhausted(`${stdout}\n${stderr}`);
    if (terminal) {
      await alertAccountExhausted(worker, terminal);
      return terminal;
    }

    const errors = stateDir && statePattern
      ? await readClaudeSessionErrors(sessionId, stateDir, statePattern)
      : [];
    const result = classifyClaudeErrors(errors);
    if (result?.classification === 'account-exhausted') {
      await alertAccountExhausted(worker, result);
      return result;
    }
    if (result === null && isProxyBannerNoise(`${stdout}\n${stderr}`)) {
      // Proxy-banner noise rode along in the worker stream — not rate-limit
      // evidence, and not digest material either (2026-09-13).
      return null;
    }
    if (result === null && /429|rate limit|quota/i.test(stdout + stderr)) {
      const { appendUnparseableRateLimit } = await import('./rate-limit-unparseable-log.js');
      const combined = (stdout + stderr).slice(0, 100);
      await appendUnparseableRateLimit({ timestamp: new Date().toISOString(), worker, raw: combined, session_id: sessionId, reason: 'no-session-evidence' });
    }
    if (result && result.minutes > 0 && result.classification === 'unknown' && result.source === 'claude-session') {
      // Absence-ladder loud-failure row (2026-09-13): the probe cooldown is
      // recorded, but the miss must also reach the hourly retrospective
      // digest — time-hinted raws feed the parser self-heal, timeless raws
      // are plain unknown-pattern misses. Transient (minutes 0) no-ops,
      // stated-time and burst classifications never land here.
      const { appendUnparseableRateLimit } = await import('./rate-limit-unparseable-log.js');
      await appendUnparseableRateLimit({
        timestamp: new Date().toISOString(),
        worker,
        raw: (result.raw ?? '').slice(0, 100),
        session_id: sessionId,
        classification: result.classification,
        reason: hasTimeHint(result.raw ?? '') ? 'time-hint-unparsed' : 'unknown-pattern',
      });
    }
    return result;
  }

  if (worker === 'agy' || worker === 'agyc') {
    // Google API 429 / RESOURCE_EXHAUSTED in stderr, or agy/agyc's own CLI-level
    // terminal quota-exhaustion text (source 'gemini-cli-text' — see
    // rate-limits-gemini.ts). Returns null for non-rate-limit stderr.
    const { classifyGeminiError } = await import('./rate-limits-gemini.js');
    const result = classifyGeminiError(stderr) ?? null;
    if (result?.source === 'gemini-cli-text') {
      // Terminal, subscription-level fault — same alert path as zclaude's
      // Zhipu 1113 balance fault above. Unlike the JSON API 429 shapes
      // 'gemini-stderr' covers, this does not self-heal on a schedule the
      // server already told us, so the operator needs to be told.
      await alertAccountExhausted(worker, result);
      return result;
    }
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

  if (worker === 'devin') {
    // Devin prints Codeium cloud quota/rate-limit text on stderr. Only the
    // error channel is authoritative; do not scan agent output text.
    const { classifyDevinError } = await import('./rate-limits-devin.js');
    const result = classifyDevinError(stderr) ?? null;
    if (result?.classification === 'account-exhausted') {
      await alertAccountExhausted(worker, result);
      return result;
    }
    if (result === null && /rate limit|quota|credits/i.test(stderr)) {
      const { appendUnparseableRateLimit } = await import('./rate-limit-unparseable-log.js');
      await appendUnparseableRateLimit({ timestamp: new Date().toISOString(), worker, raw: stderr.slice(0, 100), session_id: sessionId, reason: 'no-session-evidence' });
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

// In-process bounded queue (lib/stall.ts, key 'rate-limits'): serialize same-process callers BEFORE the cross-process
// file lock. Without this, many concurrent same-process calls stampede the file
// lock — proper-lockfile's synchronized retry backoff then lets only ~1 acquirer
// through per round, so high concurrency exhausts retries ("Lock file is already
// being held"). Queuing in-process means only one file-lock acquisition is ever
// in flight per process; the file lock still guards against OTHER processes.

async function withRateLimitLock<T>(fn: () => Promise<T>): Promise<T> {
  // withBoundedQueue records this caller as the queue tail synchronously
  // (before any await), so callers still serialize in call order (FIFO) and
  // back-to-back records of the same worker keep last-write-wins.
  return withBoundedQueue('rate-limits', async () => {
    const path = statePath();
    await ensureStateFile();
    const release = await lockfile.lock(path, safeLockOptions('rate-limits', { retries: 10, realpath: false }));
    try {
      return await fn();
    } finally {
      await release();
    }
  }, { store: 'rate-limits', target: basename(statePath()) });
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
  let effectiveMinutes = durationMinutes;
  let burst = false;
  if (classification === 'quota-per-minute') {
    burst = true;
    effectiveMinutes = BURST_RETRY_COOLDOWN_S / 60;
    log('info', 'rate-limits', `burst 429: ${worker} records a ${BURST_RETRY_COOLDOWN_S}s retry cooldown (${durationMinutes} min parsed, overridden)`, {
      worker,
      classification,
      parsed_minutes: durationMinutes,
      burst_cooldown_s: BURST_RETRY_COOLDOWN_S,
    });
  }
  await withRateLimitLock(async () => {
    const state = await loadState();
    const cooldownUntil = new Date(Date.now() + effectiveMinutes * 60 * 1000).toISOString();
    state[worker] = {
      cooldown_until: cooldownUntil,
      last_event: new Date().toISOString(),
      reason,
      ...(classification ? { classification } : {}),
    };
    console.log(`[rate-limit] ${worker} cooling down until ${cooldownUntil} (${reason})`);
    await saveState(state);
  });
  if (burst) {
    // Fired only after the cooldown is actually recorded. A burst 429 is
    // evidence of over-concurrency, so the governor sheds capacity; a
    // stated-end-time quota event (usage-limit-session, quota-daily, …)
    // never sheds — waiting is the correct response there, not shedding.
    noteQuotaBurst();
  }
}

/**
 * Drop a worker's cooldown outright. A successful run is the strongest possible
 * evidence that the fault is gone, and it must be able to override a cooldown
 * that outlives it — notably 'account-exhausted', whose deliberately long window
 * would otherwise keep a freshly recharged account benched for hours.
 * Returns true when an entry was actually removed.
 */
export async function clearWorkerCooldown(worker: string): Promise<boolean> {
  return withRateLimitLock(async () => {
    const state = await loadState();
    if (!state[worker]) return false;
    const previous = state[worker];
    delete state[worker];
    await saveState(state);
    log('info', 'rate-limits', `cooldown cleared: ${worker}`, {
      worker,
      classification: previous.classification,
      cleared_cooldown_until: previous.cooldown_until,
    });
    return true;
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

export type AutoDispatchIneligibility = 'manual_only' | 'excluded' | 'cooling';

export interface AutoDispatchEligibilityOpts {
  preferredWorker?: string;
  workerPin?: string;
  excludeWorkers?: Set<string>;
}

/**
 * Single automatic-dispatch eligibility predicate shared by the failover
 * cascade and the evaluator chain. Pure reader of cooldown state — never
 * writes it. Returns the ineligibility reason so callers can log the same
 * skip strings the inline filters historically emitted.
 */
export async function autoDispatchEligibility(
  worker: WorkerConfig,
  opts: AutoDispatchEligibilityOpts = {},
): Promise<{ eligible: true } | { eligible: false; reason: AutoDispatchIneligibility }> {
  if (worker.manual_only && opts.preferredWorker !== worker.name && opts.workerPin !== worker.name) {
    return { eligible: false, reason: 'manual_only' };
  }
  if (opts.excludeWorkers?.has(worker.name)) {
    return { eligible: false, reason: 'excluded' };
  }
  if (await isWorkerCoolingDown(worker.name)) {
    return { eligible: false, reason: 'cooling' };
  }
  return { eligible: true };
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

/**
 * Compute a health score for each worker based on rate-limit state and recent failures.
 * Returns a map from worker name to health info.
 *
 * Health demotion criteria (proposal #17):
 * - cooling-down → demote to tail
 * - 3+ consecutive recent failures → demote to tail
 * - stable ordering otherwise (priority order preserved among healthy workers)
 */
export async function getWorkerHealthSnapshot(workerNames: string[]): Promise<Map<string, { isCoolingDown: boolean; consecutiveFailures: number }>> {
  const result = new Map<string, { isCoolingDown: boolean; consecutiveFailures: number }>();
  const cooldownStatus = await getCooldownStatus();

  for (const name of workerNames) {
    const isCoolingDown = cooldownStatus[name] !== undefined && new Date(cooldownStatus[name].cooldown_until) > new Date();

    // Read consecutive failures from logs/latest.json (skill runner state)
    // Note: Worker failures are not tracked in latest.json (that's for skills),
    // so we default to 0. A future enhancement could track worker-specific failures.
    const consecutiveFailures = 0;

    result.set(name, { isCoolingDown, consecutiveFailures });
  }

  return result;
}
