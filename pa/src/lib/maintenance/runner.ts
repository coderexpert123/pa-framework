import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { log } from '../log.js';
import { notifyUser } from '../notify.js';
import { validateRegistry } from './policy.js';
import { readLedger, updateJobState, migrateLastLearnState } from './state.js';
import type {
  JobOutcome,
  JobRunRecord,
  MaintenanceHost,
  MaintenanceJob,
  MaintenanceOverrides,
  RetentionPreview,
  SkipReason,
} from './types.js';

type NotifyFn = (
  subject: string,
  body: string,
  opts?: { dedupKey?: string; dedupWindowMs?: number; severity?: 'info' | 'warn' | 'error' },
) => Promise<{ sent: boolean; suppressed: boolean }>;

/** PURE decision function — no I/O, unit-tested directly. */
export function decideJob(args: {
  everyMs: number;
  lastRunAtMs: number | null;
  nowMs: number;
  enabled: boolean;
  degraded: boolean;
  shedWhenDegraded: boolean;
  inFlight: boolean;
  force: boolean;
}): { action: 'run' } | { action: 'skip'; skipReason: SkipReason } {
  const { everyMs, lastRunAtMs, nowMs, enabled, degraded, shedWhenDegraded, inFlight, force } = args;

  if (inFlight) return { action: 'skip', skipReason: 'in-flight' };
  if (force) return { action: 'run' };
  if (!enabled) return { action: 'skip', skipReason: 'disabled' };
  if (degraded && shedWhenDegraded) return { action: 'skip', skipReason: 'degraded' };
  if (lastRunAtMs === null) return { action: 'run' };
  if (nowMs - lastRunAtMs >= everyMs) return { action: 'run' };
  return { action: 'skip', skipReason: 'not-due' };
}

/**
 * Resolved cadence after applying an override. A bad override (non-positive,
 * NaN) warns and falls back to the declared cadence rather than throwing —
 * a malformed config.yaml entry must not take the job out of rotation.
 */
export function resolveEveryMs(job: MaintenanceJob, override?: { everyMs?: number }): number {
  const declared = typeof job.everyMs === 'function' ? job.everyMs() : job.everyMs;
  const o = override?.everyMs;
  if (o === undefined) return declared;
  if (!Number.isFinite(o) || o <= 0) {
    console.warn(`[maintenance] config.maintenance.${job.name}.every is not a positive duration; using the declared cadence (${declared}ms)`);
    return declared;
  }
  return o;
}

// Per-process in-flight guard. The `pa` host is additionally serialised by
// catchup's blackboard lock, so this mainly matters for concurrent
// `pa maintenance run` invocations and the future bot host (which shares this
// module but runs in a different, always-on process).
const IN_FLIGHT = new Set<string>();

export interface RunDueJobsOptions {
  now?: number;                     // default Date.now()
  degraded?: boolean;               // default false (the `pa` host has no DEGRADED signal)
  overrides?: MaintenanceOverrides; // from config.maintenance
  onlyJob?: string;                 // `pa maintenance run <job>`
  force?: boolean;                  // set by `pa maintenance run` — see decideJob
  /** Injectable for tests; defaults to lib/notify.js's notifyUser. */
  notify?: NotifyFn;
}

function skippedTooLongThreshold(everyMs: number): number {
  return 3 * everyMs;
}

async function maybePageSkippedTooLong(
  job: MaintenanceJob,
  host: MaintenanceHost,
  everyMs: number,
  skipReason: SkipReason,
  nowMs: number,
  lastRunAt: string | undefined,
  firstSeenAt: string,
  consecutiveSkips: number,
  notify: NotifyFn,
): Promise<void> {
  if (skipReason !== 'degraded' && skipReason !== 'in-flight') return;

  const sinceMs = lastRunAt ? nowMs - new Date(lastRunAt).getTime() : nowMs - new Date(firstSeenAt).getTime();
  if (sinceMs <= skippedTooLongThreshold(everyMs)) return;

  const hoursSince = (sinceMs / 3_600_000).toFixed(1);
  const body =
    `Job: ${job.name}\nHost: ${host}\nReason: ${skipReason}\n` +
    `Resolved cadence: ${everyMs}ms\nHours since last run: ${hoursSince}\n` +
    `Consecutive suppressing skips: ${consecutiveSkips}`;

  await notify(`Maintenance job suppressed: ${job.name}`, body, {
    dedupKey: `maintenance-skipped-${job.name}`,
    severity: 'warn',
    dedupWindowMs: 24 * 3_600_000,
  }).catch(() => {});
}

/**
 * Runs every due job for `host`, SEQUENTIALLY (D: is a 5400rpm HDD; parallel
 * fs sweeps starve each other). Never throws: a job that throws is recorded
 * as `failed` and the remaining jobs still run.
 */
export async function runDueJobs(
  host: MaintenanceHost,
  jobs: MaintenanceJob[],
  opts: RunDueJobsOptions = {},
): Promise<JobRunRecord[]> {
  validateRegistry(jobs);

  for (const job of jobs) {
    if (job.host !== host) {
      throw new Error(`[maintenance] job '${job.name}' declares host '${job.host}' but was passed to the '${host}' runner`);
    }
  }

  const now = opts.now ?? Date.now();
  const degraded = opts.degraded ?? false;
  const overrides = opts.overrides ?? {};
  const notify: NotifyFn = opts.notify ?? notifyUser;

  if (jobs.some((j) => j.name === 'weekly-learn')) {
    await migrateLastLearnState();
  }

  const jobNames = new Set(jobs.map((j) => j.name));
  for (const key of Object.keys(overrides)) {
    if (!jobNames.has(key)) {
      console.warn(`[maintenance] config.maintenance: unknown job '${key}'; ignoring`);
    }
  }

  // Single snapshot for the whole pass — each job's decision is made against
  // the same read, not re-read per job.
  const ledger = await readLedger();

  const records: JobRunRecord[] = [];
  const targetJobs = opts.onlyJob ? jobs.filter((j) => j.name === opts.onlyJob) : jobs;

  for (const job of targetJobs) {
    const everyMs = resolveEveryMs(job, overrides[job.name]);
    const override = overrides[job.name];
    const enabled = override?.enabled ?? true;

    const state = ledger.jobs[job.name];
    const lastRunAtMs = state?.lastRunAt ? new Date(state.lastRunAt).getTime() : null;

    // The inFlight check and the IN_FLIGHT claim below must happen with no
    // `await` between them — otherwise a concurrent runDueJobs() call for the
    // same job can interleave in the gap and both decide 'run' before either
    // claims the slot (JS only guarantees atomicity across synchronous spans).
    const inFlight = IN_FLIGHT.has(job.name);
    const decision = decideJob({
      everyMs,
      lastRunAtMs,
      nowMs: now,
      enabled,
      degraded,
      shedWhenDegraded: job.shedWhenDegraded,
      inFlight,
      force: opts.force ?? false,
    });
    if (decision.action === 'run') {
      IN_FLIGHT.add(job.name);
    }

    const t0 = Date.now();

    if (decision.action === 'skip') {
      const skipReason = decision.skipReason;
      const nowIso = new Date(now).toISOString();

      let shouldLog = false;
      const persisted = await updateJobState(job.name, (prev) => {
        shouldLog = prev.lastLoggedSkipReason !== skipReason;
        return {
          ...prev,
          lastSkipAt: nowIso,
          lastSkipReason: skipReason,
          lastOutcome: 'skipped' as JobOutcome,
          consecutiveSkips: skipReason === 'not-due' ? 0 : prev.consecutiveSkips + 1,
          lastLoggedSkipReason: shouldLog ? skipReason : prev.lastLoggedSkipReason,
        };
      }, now);

      if (shouldLog) {
        const level = skipReason === 'not-due' ? 'info' : 'warn';
        log(level, 'maintenance', `${job.name}: skipped (${skipReason})`, { job: job.name, host, skipReason });
      }

      await maybePageSkippedTooLong(
        job,
        host,
        everyMs,
        skipReason,
        now,
        persisted.lastRunAt,
        persisted.firstSeenAt,
        persisted.consecutiveSkips,
        notify,
      );

      records.push({
        name: job.name,
        outcome: 'skipped',
        skipReason,
        durationMs: Date.now() - t0,
      });
      continue;
    }

    // action === 'run' — the slot was already claimed above, synchronously
    // with the decision.
    try {
      const result = await job.run({ now, everyMs });
      const nowIso = new Date(now).toISOString();

      await updateJobState(job.name, (prev) => ({
        ...prev,
        lastRunAt: nowIso,
        lastOutcome: 'ran' as JobOutcome,
        lastTouched: result.touched,
        consecutiveFailures: 0,
        consecutiveSkips: 0,
        lastError: undefined,
        // A run resets the "first skip after a run" clock so the next skip
        // (even with the same reason as before this run) is logged once.
        lastLoggedSkipReason: undefined,
      }), now);

      if (result.touched > 0) {
        log('info', 'maintenance', `${job.name}: ${result.touched} item(s)`, {
          job: job.name,
          host,
          touched: result.touched,
          durationMs: Date.now() - t0,
          ...result.detail,
        });
      }

      records.push({
        name: job.name,
        outcome: 'ran',
        touched: result.touched,
        durationMs: Date.now() - t0,
        ...(result.detail ? { detail: result.detail } : {}),
      });
    } catch (err: any) {
      const errorMessage = err?.message ?? String(err);
      const persisted = await updateJobState(job.name, (prev) => ({
        ...prev,
        lastOutcome: 'failed' as JobOutcome,
        lastError: errorMessage,
        consecutiveFailures: prev.consecutiveFailures + 1,
      }), now);

      log('error', 'maintenance', `${job.name} failed`, {
        job: job.name,
        host,
        error: errorMessage,
        consecutiveFailures: persisted.consecutiveFailures,
      });

      await notify(`Maintenance job failed: ${job.name}`, errorMessage, {
        dedupKey: `maintenance-failed-${job.name}`,
        severity: 'error',
      }).catch(() => {});

      records.push({
        name: job.name,
        outcome: 'failed',
        error: errorMessage,
        durationMs: Date.now() - t0,
      });
    } finally {
      IN_FLIGHT.delete(job.name);
    }
  }

  return records;
}

/** Read-only dry run. NEVER invokes job.run(). */
export async function previewJob(job: MaintenanceJob, nowMs: number = Date.now()): Promise<RetentionPreview[]> {
  const previews: RetentionPreview[] = [];

  for (const target of job.targets) {
    const resolvedPath = target.resolve();

    let dirStat;
    try {
      dirStat = await stat(resolvedPath);
    } catch {
      previews.push({ target, resolvedPath, exists: false, candidates: [] });
      continue;
    }

    if (!dirStat.isDirectory()) {
      previews.push({
        target,
        resolvedPath,
        exists: true,
        candidates: [],
        note: 'target is a file; contents are not enumerable by readdir (e.g. SQLite rows) — the job archives in place',
      });
      continue;
    }

    let entries: string[];
    try {
      entries = await readdir(resolvedPath);
    } catch (err: any) {
      previews.push({
        target,
        resolvedPath,
        exists: true,
        candidates: [],
        note: `unreadable: ${err?.code ?? 'unknown'}`,
      });
      continue;
    }

    const cutoff = nowMs - target.maxAgeMs;
    const matched = entries.filter((name) => target.match.test(name));
    const candidates: { path: string; mtimeMs: number }[] = [];
    for (const name of matched) {
      const fullPath = join(resolvedPath, name);
      try {
        const s = await stat(fullPath);
        if (s.mtimeMs < cutoff) {
          candidates.push({ path: fullPath, mtimeMs: s.mtimeMs });
        }
      } catch {
        // vanished between readdir and stat — skip
      }
    }
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);

    previews.push({
      target,
      resolvedPath,
      exists: true,
      candidates: candidates.map((c) => c.path),
    });
  }

  return previews;
}
