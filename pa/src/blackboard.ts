import { join } from 'path';
import fs from 'fs-extra';
import lockfile from 'proper-lockfile';
import { paHome } from './paths.js';
import { safeLockOptions } from './lib/safe-lock.js';

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

const HEARTBEAT_STALE_MS = 10 * 60 * 1000; // 10 minutes

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
  private path: string;

  constructor() {
    this.path = getBlackboardPath();
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
      console.warn('[blackboard] Failed to read blackboard.json, resetting:', err);
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
          const isStale = heartbeatAge > HEARTBEAT_STALE_MS;

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

        await fs.writeJson(this.path, { active_locks: nextLocks }, { spaces: 2 });
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
   */
  async releaseLock(resource: string, agent: string, contextId?: string): Promise<void> {
    await this.ensureFile();
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.path, safeLockOptions('blackboard', { retries: 5 }));
      const data = await this.readData();
      const activeLocks = data.active_locks.filter(
        (l) => !(l.resource === resource && l.agent === agent && (!contextId || l.contextId === contextId))
      );
      await fs.writeJson(this.path, { active_locks: activeLocks }, { spaces: 2 });
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
  async updateHeartbeat(resource: string, agent: string, contextId?: string): Promise<void> {
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
        await fs.writeJson(this.path, data, { spaces: 2 });
      }
    } catch {
      // Non-fatal
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
      return isPidAlive(lock.pid) && (now.getTime() - new Date(lock.heartbeat).getTime() < HEARTBEAT_STALE_MS);
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
        return isPidAlive(lock.pid) && (now.getTime() - new Date(lock.heartbeat).getTime() < HEARTBEAT_STALE_MS);
      });
      await fs.writeJson(this.path, { active_locks: activeLocks }, { spaces: 2 });
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
