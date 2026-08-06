import { randomBytes } from 'crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import lockfile from 'proper-lockfile';
import { safeLockOptions } from '../safe-lock.js';
import { paHome } from '../../paths.js';
import type { JobOutcome, SkipReason } from './types.js';

export interface MaintenanceJobState {
  /** ISO. First time this job was ever recorded — lets the too-long page fire
   *  for a job that has never successfully run. */
  firstSeenAt: string;
  lastRunAt?: string;          // ISO — last successful `ran` outcome
  lastOutcome?: JobOutcome;
  lastTouched?: number;
  lastError?: string;
  lastSkipAt?: string;         // ISO
  lastSkipReason?: SkipReason;
  /** Last skip reason actually emitted to app.log.jsonl — drives log-on-change. */
  lastLoggedSkipReason?: SkipReason;
  consecutiveFailures: number;
  /** Consecutive SUPPRESSING skips (disabled/degraded/in-flight). 'not-due'
   *  skips do NOT increment it — a job that isn't due isn't being suppressed. */
  consecutiveSkips: number;
}

export interface MaintenanceLedger {
  version: 1;
  jobs: Record<string, MaintenanceJobState>;
}

const LEDGER_VERSION = 1 as const;

export function maintenanceStatePath(): string {
  return join(paHome(), 'maintenance-state.json');
}

function emptyLedger(): MaintenanceLedger {
  return { version: LEDGER_VERSION, jobs: {} };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures the target file is created so proper-lockfile has something to lock
 * on. Mirrors archive-files.ts's ensureFile pattern.
 */
async function ensureFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (!(await pathExists(path))) {
    await writeFile(path, JSON.stringify(emptyLedger()), { flag: 'wx' }).catch((err: any) => {
      if (err.code !== 'EEXIST') throw err;
    });
  }
}

/** Missing / corrupt / wrong-version file yields a fresh empty ledger. Never throws. */
export async function readLedger(): Promise<MaintenanceLedger> {
  const path = maintenanceStatePath();
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === LEDGER_VERSION && parsed.jobs && typeof parsed.jobs === 'object') {
      return parsed as MaintenanceLedger;
    }
    return emptyLedger();
  } catch {
    return emptyLedger();
  }
}

async function writeLedgerAtomic(path: string, ledger: MaintenanceLedger): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid.toString(36)}-${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmpPath, JSON.stringify(ledger, null, 2), 'utf8');
  await rename(tmpPath, path);
}

const stateMutexes: Map<string, Promise<void>> = new Map();

/**
 * In-process FIFO mutex per file, mirroring archive-files.ts's
 * withRotationMutex. Two updateJobState calls in the same process would
 * otherwise collide on proper-lockfile with ELOCKED.
 */
async function withStateMutex<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = stateMutexes.get(filePath) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  stateMutexes.set(filePath, current);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    if (stateMutexes.get(filePath) === current) {
      stateMutexes.delete(filePath);
    }
    release();
  }
}

function defaultJobState(nowMs: number): MaintenanceJobState {
  return {
    firstSeenAt: new Date(nowMs).toISOString(),
    consecutiveFailures: 0,
    consecutiveSkips: 0,
  };
}

/**
 * Read-modify-write one job's entry under the file lock. Returns the entry
 * actually persisted. `mutate` receives the CURRENT entry (a fresh default
 * with firstSeenAt=nowISO when absent) and returns the replacement.
 */
export async function updateJobState(
  name: string,
  mutate: (prev: MaintenanceJobState) => MaintenanceJobState,
  nowMs: number = Date.now(),
): Promise<MaintenanceJobState> {
  const path = maintenanceStatePath();
  await ensureFile(path);

  return withStateMutex(path, async () => {
    const release = await lockfile.lock(path, safeLockOptions('maintenance-state', { retries: 5, realpath: false }));
    try {
      const ledger = await readLedger();
      const prev = ledger.jobs[name] ?? defaultJobState(nowMs);
      const next = mutate(prev);
      ledger.jobs[name] = next;
      await writeLedgerAtomic(path, ledger);
      return next;
    } finally {
      await release();
    }
  });
}

/**
 * One-time migration off ~/.pa/last-learn.json onto the ledger, so the 7-day
 * clock is not reset by the cutover. No-op when the ledger already has a
 * `weekly-learn` entry with a lastRunAt, or when the legacy file is absent.
 * On success, seeds weekly-learn.lastRunAt from the file's `last_run`, then
 * best-effort unlinks the file. Returns true iff it migrated.
 */
export async function migrateLastLearnState(jobName: string = 'weekly-learn'): Promise<boolean> {
  const legacyPath = join(paHome(), 'last-learn.json');

  const ledger = await readLedger();
  const existing = ledger.jobs[jobName];
  if (existing && existing.lastRunAt) return false;

  let legacyRaw: string;
  try {
    legacyRaw = await readFile(legacyPath, 'utf8');
  } catch {
    return false;
  }

  let lastRun: string | undefined;
  try {
    const parsed = JSON.parse(legacyRaw);
    lastRun = parsed?.last_run;
  } catch {
    return false;
  }
  if (!lastRun) return false;

  await updateJobState(jobName, (prev) => ({
    ...prev,
    lastRunAt: lastRun,
  }));

  await unlink(legacyPath).catch(() => {});
  return true;
}
