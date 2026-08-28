import { join } from 'path';
import { randomBytes } from 'crypto';
import fs from 'fs-extra';
import lockfile from 'proper-lockfile';
import { paHome } from './paths.js';
import { safeLockOptions } from './lib/safe-lock.js';
import { log } from './lib/log.js';
import { writeJsonAtomic } from './lib/atomic-write.js';

export interface LockEntry {
  resource: string;
  agent: string;
  pid: number;
  heartbeat: string;
  contextId?: string;  // per-call execution context UUID; allows same-context nested re-entrancy
}

export interface BlackboardData {
  active_locks: LockEntry[];
}

const HEARTBEAT_STALE_MS = 10 * 60 * 1000; // 10 minutes (default)

/**
 * Reads the stale-lock TTL fresh on every call from PA_HEARTBEAT_STALE_MS
 * (falls back to the 10-minute default) — so tests can shrink it instead of
 * waiting 10 real minutes, and an operator can tune it without a rebuild.
 */
function heartbeatStaleMs(): number {
  const raw = process.env.PA_HEARTBEAT_STALE_MS;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return HEARTBEAT_STALE_MS;
}

function envMs(varName: string): number | undefined {
  const raw = process.env[varName];
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function getBlackboardPath(): string {
  return join(paHome(), 'blackboard.json');
}

/**
 * Check if a PID is still alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // ESRCH means the process doesn't exist
    return err.code === 'EPERM'; // If we don't have permission, it's alive
  }
}

export class Blackboard {
  // Resolved fresh on every access rather than cached at construction: PA_HOME
  // can change within a single process (test suites with multiple temp-home
  // cycles; PA_HOME env overrides), and a cached path would silently keep
  // operating against a stale, possibly-deleted directory.
  private get path(): string {
    return getBlackboardPath();
  }

  private async ensureFile(): Promise<void> {
    let exists = await fs.pathExists(this.path);
    if (exists) {
      try {
        const stats = await fs.stat(this.path);
        if (stats.size === 0) exists = false;
      } catch {
        exists = false;
      }
    }

    if (!exists) {
      await fs.ensureDir(paHome());
      try {
        await fs.writeJson(this.path, { active_locks: [] }, { flag: 'wx' });
      } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  }

  private async readData(): Promise<BlackboardData> {
    try {
      return await fs.readJson(this.path);
    } catch (err) {
      const refId = `s-${randomBytes(6).toString('hex')}`;
      log('error', 'blackboard', 'store unreadable — resetting to empty', { refId, path: this.path, error: String(err) });
      return { active_locks: [] };
    }
  }

  /**
   * Acquire a lock on a resource.
   * If the resource is already locked, it waits unless the lock is stale.
   *
   * contextId (5th param, optional): a UUID generated per processUpdate call.
   * When provided, re-entrancy is only allowed for the same contextId (same
   * execution flow). Two concurrent same-topic handlers with different contextIds
   * and the same PID will correctly block each other.
   * Legacy callers that omit contextId preserve existing same-PID re-entrancy.
   */
  async acquireLock(
    resource: string,
    agent: string,
    pid: number,
    timeoutMs: number = 60000,
    contextId?: string
  ): Promise<boolean> {
    await this.ensureFile();
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      // Use proper-lockfile to ensure atomic access to blackboard.json
      let release: (() => Promise<void>) | undefined;
      try {
        release = await lockfile.lock(this.path, safeLockOptions('blackboard', { retries: 5 }));

        const data = await this.readData();
        const now = new Date();

        // Purge stale locks first
        const activeLocks = data.active_locks.filter((lock) => {
          const isAlive = isPidAlive(lock.pid);
          const heartbeatAge = now.getTime() - new Date(lock.heartbeat).getTime();
          const isStale = heartbeatAge > heartbeatStaleMs();

          if (!isAlive) {
            console.log(`[blackboard] Purging dead PID lock: ${lock.resource} (pid:${lock.pid})`);
            return false;
          }
          if (isStale) {
            console.log(`[blackboard] Purging stale heartbeat lock: ${lock.resource} (age:${Math.round(heartbeatAge/1000)}s)`);
            return false;
          }
          return true;
        });

        // Re-entrance check:
        // - Different PID → always block (another process holds the lock)
        // - Same PID, no contextId on either side → allow (legacy callers)
        // - Same PID, same contextId → allow (nested re-entrancy within the same flow)
        // - Same PID, different contextId → block (two concurrent same-topic handlers)
        const existing = activeLocks.find((l) => {
          if (l.resource !== resource) return false;
          if (l.pid !== pid) return true;                      // different process → block
          if (!contextId || !l.contextId) return false;        // no contextId on either side → allow (legacy)
          return l.contextId !== contextId;                    // same PID, different context → block
        });
        if (existing) {
          // Already locked by a conflicting holder
          await release();
          release = undefined;
          // Wait and retry
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        // Drop any same-PID, same-resource, same-agent, same-contextId duplicate
        // so we don't accumulate rows on re-acquisition.
        const nextLocks = activeLocks.filter(
          (l) => !(l.resource === resource && l.pid === pid && l.agent === agent && l.contextId === contextId)
        );

        nextLocks.push({
          resource,
          agent,
          pid,
          heartbeat: now.toISOString(),
          ...(contextId !== undefined ? { contextId } : {}),
        });

        await writeJsonAtomic(this.path, { active_locks: nextLocks }, { spaces: 2 });
        return true;
      } catch (err) {
        console.error('[blackboard] acquireLock error:', err);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } finally {
        if (release) await release();
      }
    }

    return false;
  }

  /**
   * Release a lock.
   *
   * contextId (3rd param, optional):
   * - Omitted → remove ALL entries for resource+agent (legacy behaviour; correct
   *   for `pa catchup` / `pa purge-locks` which don't use contextId).
   * - Provided → remove only the entry whose contextId matches, leaving any
   *   other concurrent entries untouched.
   *
   * opts.pid (4th param, optional, D4 — additive): when given, only rows whose
   * pid matches are removed too. Omitting it preserves every existing caller's
   * behaviour unchanged (matches on resource+agent+contextId only).
   */
  async releaseLock(resource: string, agent: string, contextId?: string, opts?: { pid?: number }): Promise<void> {
    await this.ensureFile();
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.path, safeLockOptions('blackboard', { retries: 5 }));
      const data = await this.readData();
      const activeLocks = data.active_locks.filter(
        (l) => !(
          l.resource === resource &&
          l.agent === agent &&
          (!contextId || l.contextId === contextId) &&
          (opts?.pid === undefined || l.pid === opts.pid)
        )
      );
      await writeJsonAtomic(this.path, { active_locks: activeLocks }, { spaces: 2 });
    } catch (err) {
      console.error('[blackboard] releaseLock error:', err);
    } finally {
      if (release) await release();
    }
  }

  /**
   * Update the heartbeat for an existing lock.
   *
   * contextId (3rd param, optional): when provided, updates only the matching
   * entry. When omitted, updates the first matching resource+agent entry
   * (legacy behaviour — safe once the concurrent-hold bug is fixed).
   */
  async updateHeartbeat(resource: string, agent: string, contextId?: string): Promise<boolean> {
    await this.ensureFile();
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.path, safeLockOptions('blackboard', { retries: 3 }));
      const data = await this.readData();
      const entry = data.active_locks.find(
        (l) => l.resource === resource && l.agent === agent && (!contextId || l.contextId === contextId)
      );
      if (entry) {
        entry.heartbeat = new Date().toISOString();
        await writeJsonAtomic(this.path, data, { spaces: 2 });
        return true;
      }
      return false;
    } catch {
      // Non-fatal
      return false;
    } finally {
      if (release) await release();
    }
  }

  /**
   * Return all active (non-stale, alive-PID) locks without modifying the file.
   */
  async getActiveLocks(): Promise<LockEntry[]> {
    await this.ensureFile();
    const data = await this.readData();
    const now = new Date();
    return data.active_locks.filter((lock) => {
      return isPidAlive(lock.pid) && (now.getTime() - new Date(lock.heartbeat).getTime() < heartbeatStaleMs());
    });
  }

  /**
   * Purge all dead or stale locks.
   */
  async purgeStaleLocks(): Promise<number> {
    await this.ensureFile();
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.path, safeLockOptions('blackboard', { retries: 5 }));
      const data = await this.readData();
      const before = data.active_locks.length;
      const now = new Date();
      const activeLocks = data.active_locks.filter((lock) => {
        return isPidAlive(lock.pid) && (now.getTime() - new Date(lock.heartbeat).getTime() < heartbeatStaleMs());
      });
      await writeJsonAtomic(this.path, { active_locks: activeLocks }, { spaces: 2 });
      return before - activeLocks.length;
    } catch (err) {
      console.error('[blackboard] purgeStaleLocks error:', err);
      return 0;
    } finally {
      if (release) await release();
    }
  }
}

export const blackboard = new Blackboard();

export interface LockRenewalOptions {
  /** Renewal tick cadence. Default 60s, or PA_LOCK_RENEW_INTERVAL_MS. */
  intervalMs?: number;
  /** Cap on total renewal lifetime — after this, stop renewing and fire
   * onLost('expired') once. Default 6h, or PA_LOCK_RENEW_MAX_MS. This is what
   * keeps a truly-hung dispatch from holding the lock forever: an async hang
   * with a healthy event loop would otherwise renew indefinitely (a
   * wedged/dead event loop already stops renewing on its own, since
   * setInterval can't fire). */
  maxMs?: number;
  onLost?: (reason: 'expired' | 'purged') => void;
  /** Renew through this client instead of the module-singleton `blackboard`
   * (C13) — callers that inject a fake/BlackboardLockClient for their own
   * acquire/release (code-fixer.ts, self-improver.ts) must renew through the
   * SAME client, or their tests' fakes silently start hitting the real
   * blackboard singleton the moment they migrate onto this helper. */
  client?: Pick<Blackboard, 'updateHeartbeat'>;
}

/**
 * Keeps a single (resource, agent, contextId) lock row's heartbeat fresh for
 * the lifetime of a long-running holder, via setInterval → updateHeartbeat —
 * the same hand-rolled pattern already used twice in this codebase
 * (pa/src/commands/catchup.ts, pa/src/code-fixer.ts), generalized into a
 * reusable helper. AI-113: without this, any single dispatch running past
 * HEARTBEAT_STALE_MS (10 min default) has its lock purged out from under it by
 * the next acquireLock call, even though the holder is alive and working.
 */
export function startLockRenewal(
  resource: string,
  agent: string,
  contextId: string | undefined,
  opts?: LockRenewalOptions
): { stop: () => void } {
  const intervalMs = opts?.intervalMs ?? envMs('PA_LOCK_RENEW_INTERVAL_MS') ?? 60_000;
  const maxMs = opts?.maxMs ?? envMs('PA_LOCK_RENEW_MAX_MS') ?? 6 * 60 * 60 * 1000;
  const onLost = opts?.onLost;
  const client = opts?.client ?? blackboard;
  const start = Date.now();
  let stopped = false;
  let inFlight = false;
  let lostFired = false;

  const fireLostOnce = (reason: 'expired' | 'purged') => {
    if (lostFired) return;
    lostFired = true;
    onLost?.(reason);
  };

  const tick = () => {
    if (stopped) return;
    // The maxMs cap must be checked on EVERY tick, unconditionally — never
    // gated behind the overlap guard below. A slow updateHeartbeat (real fs
    // lock contention) could otherwise leave inFlight true across several
    // tick callbacks, silently delaying the cap past its deadline and
    // defeating the one thing it exists for: freeing a truly-hung holder.
    if (Date.now() - start >= maxMs) {
      stopped = true;
      clearInterval(timer);
      fireLostOnce('expired');
      return;
    }
    if (inFlight) return; // overlap guard: skip the UPDATE if the previous hasn't settled
    inFlight = true;
    client.updateHeartbeat(resource, agent, contextId)
      .then((refreshed) => {
        // Row already purged (e.g. a competing holder acquired it, or it went
        // stale before this renewer's first tick) — latched, never re-acquire,
        // a legitimate new holder may already exist. Keep ticking harmlessly.
        if (!refreshed && !stopped) fireLostOnce('purged');
      })
      .catch(() => {})
      .finally(() => { inFlight = false; });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
