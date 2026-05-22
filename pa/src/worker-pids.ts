import { writeFile, readFile, readdir, unlink, mkdir, rename } from 'fs/promises';
import { join } from 'path';
import { paHome } from './paths.js';
import { killProcessTree } from './process-tree.js';
import { log } from './lib/log.js';

interface WorkerPidEntry {
  pid: number;
  spawnedBy: number;   // PID of the process that spawned this worker (bot or catchup)
  worker: string;
  skill: string;
  startedAt: string;
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

export async function cleanupOrphanedWorkers(): Promise<number> {
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

  if (killed > 0) {
    log('info', 'worker-pids', `Cleaned up ${killed} orphaned worker(s)`);
  }
  return killed;
}
