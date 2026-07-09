import { writeFile, readFile, readdir, unlink, mkdir, rename, stat } from 'fs/promises';
import { join } from 'path';
import { paHome } from './paths.js';
import { killProcessTree } from './process-tree.js';
import { log } from './lib/log.js';

export interface WorkerPidEntry {
  pid: number;
  spawnedBy: number;   // PID of the process that spawned this worker (bot or catchup)
  worker: string;
  skill: string;
  startedAt: string;
  /** Live descendant PIDs, refreshed each executeWorker heartbeat. Needed because
   * `pid` is the shell wrapper (spawn shell:true) — the wrapper can die with the
   * spawner while the real CLI child keeps running (observed 2026-07-04: cmd
   * wrapper 35304 dead, claude 27220 alive → reaper false-negatived liveness). */
  descendants?: number[];
}

function pidsDir(): string {
  return join(paHome(), 'worker-pids');
}

export async function addWorkerPid(entry: WorkerPidEntry): Promise<void> {
  const dir = pidsDir();
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${entry.pid}.json.tmp`);
  const target = join(dir, `${entry.pid}.json`);
  await writeFile(tmp, JSON.stringify(entry), 'utf8');
  await rename(tmp, target);
  // Note: `.json.tmp` files left on crash are ignored by cleanupOrphanedWorkers
  // because the filter `file.endsWith('.json')` skips files ending in `.tmp`.
}

/**
 * Refresh the live-descendants list on a registered worker's pid file.
 * Best-effort: called from executeWorker's heartbeat so a crash leaves the
 * last-known worker tree on disk for the orphan reaper's liveness check.
 */
export async function updateWorkerPidDescendants(pid: number, descendants: number[]): Promise<void> {
  const target = join(pidsDir(), `${pid}.json`);
  try {
    const entry: WorkerPidEntry = JSON.parse(await readFile(target, 'utf8'));
    entry.descendants = descendants;
    const tmp = join(pidsDir(), `${pid}.json.tmp`);
    await writeFile(tmp, JSON.stringify(entry), 'utf8');
    await rename(tmp, target);
  } catch {
    // Entry already removed (worker finished) or unreadable — nothing to update.
  }
}

export async function removeWorkerPid(pid: number): Promise<void> {
  try {
    await unlink(join(pidsDir(), `${pid}.json`));
  } catch {
    // Non-critical — ENOENT means already deleted; other errors handled by startup cleanup
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM = process exists but we lack permission → treat as alive
    // ESRCH = process does not exist → treat as dead
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** All currently registered worker PID entries (corrupt files skipped). */
export async function listWorkerPids(): Promise<WorkerPidEntry[]> {
  const dir = pidsDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const entries: WorkerPidEntry[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      entries.push(JSON.parse(await readFile(join(dir, file), 'utf8')) as WorkerPidEntry);
    } catch {
      /* corrupt file — cleanupOrphanedWorkers handles removal */
    }
  }
  return entries;
}

/** How long a `.json.tmp` may linger before it's treated as a crash artifact.
 * A live write→rename replaces it in ~1ms, so anything older is orphaned. */
const TMP_STALE_MS = 5 * 60 * 1000;

/**
 * Reap orphaned `<pid>.json.tmp` files left when a spawner crashed between the
 * write and the rename in addWorkerPid/updateWorkerPidDescendants. These are
 * structurally invisible to the `.json` reaping paths (the `endsWith('.json')`
 * filter skips them), so without this they accumulate forever. Returns count removed.
 */
export async function reapStaleWorkerPidTmps(): Promise<number> {
  const dir = pidsDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const file of files) {
    if (!file.endsWith('.json.tmp')) continue;
    const fp = join(dir, file);
    try {
      const s = await stat(fp);
      if (now - s.mtimeMs > TMP_STALE_MS) {
        await unlink(fp);
        removed++; // count only files actually removed
      }
    } catch {
      /* already gone or undeletable — either way, not removed by us */
    }
  }
  return removed;
}

/**
 * Kill workers whose spawner died. `excludeSkills` protects entries (by their
 * `skill`/resource key) from both the kill and the registry removal — used by
 * the bot's orphan-dispatch reaper (AI-095), which wants crashed-instance
 * dispatch workers to finish so their reply can be harvested, not killed.
 */
export async function cleanupOrphanedWorkers(excludeSkills?: Set<string>): Promise<number> {
  const dir = pidsDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return 0; // No dir = no orphans
  }

  let killed = 0;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;  // skips .json.tmp crash artifacts
    try {
      const raw = await readFile(join(dir, file), 'utf8');
      const entry: WorkerPidEntry = JSON.parse(raw);
      if (excludeSkills?.has(entry.skill)) continue; // reaper-protected (AI-095)
      // Only act if the spawning process is dead. If the spawner is alive, the
      // worker is still actively managed — leave the file alone so it can be
      // cleaned up when the spawner eventually exits normally or crashes.
      if (!isProcessAlive(entry.spawnedBy)) {
        if (isProcessAlive(entry.pid)) {
          log('warn', 'worker-pids', 'Killing orphaned worker', {
            pid: entry.pid, worker: entry.worker, skill: entry.skill,
            spawnedBy: entry.spawnedBy,
          });
          killProcessTree(entry.pid);
          killed++;
        }
        // Spawner is dead — remove the file whether or not the worker was alive
        await unlink(join(dir, file)).catch(() => {});
      }
      // If spawner is alive: skip this file entirely (worker is still managed)
    } catch {
      // Corrupt file — remove it unconditionally
      await unlink(join(dir, file)).catch(() => {});
    }
  }

  const tmpReaped = await reapStaleWorkerPidTmps();

  if (killed > 0 || tmpReaped > 0) {
    log('info', 'worker-pids', `Cleaned up ${killed} orphaned worker(s), ${tmpReaped} stale tmp file(s)`);
  }
  return killed;
}
