import { unlinkSync } from 'fs';
import { readFile as readFileAsync, writeFile as writeFileAsync, unlink as unlinkAsync } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

function getLockPath(): string {
  return join(process.env.PA_HOME ?? join(homedir(), '.pa'), 'telegram-bot.lock');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(): Promise<boolean> {
  const lockPath = getLockPath();

  // Attempt atomic creation (O_EXCL — fails if file exists).
  try {
    await writeFileAsync(lockPath, String(process.pid), { flag: 'wx' });
    registerExitHandler(lockPath);
    console.log(`[lock] acquired at ${lockPath} (PID ${process.pid})`);
    return true;
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
    // File exists — check if owner is still alive.
  }

  // Stale lock: read owner PID.
  try {
    const existing = await readFileAsync(lockPath, 'utf8');
    const pid = parseInt(existing.trim(), 10);
    if (!isNaN(pid) && isProcessAlive(pid)) {
      return false;
    }
  } catch {
    // File disappeared between EEXIST and our read — treat as available.
  }

  // Stale lock — overwrite (last writer wins; acceptable given Task Scheduler guard).
  await writeFileAsync(lockPath, String(process.pid), 'utf8');
  registerExitHandler(lockPath);
  console.log(`[lock] acquired (stale overwrite) at ${lockPath} (PID ${process.pid})`);
  return true;
}

function registerExitHandler(lockPath: string): void {
  // Synchronous cleanup on unexpected exit (ESM-compatible).
  // Use the snapshotted path — not getLockPath() — so that if PA_HOME is
  // mutated or deleted (e.g. by test teardown) the correct file is removed.
  process.on('exit', () => {
    try { unlinkSync(lockPath); } catch {}
    console.log(`[lock] released on exit (PID ${process.pid})`);
  });
}

export async function releaseLock(): Promise<void> {
  try {
    await unlinkAsync(getLockPath()); // intentional: called from main() while env is intact
    console.log(`[lock] released (PID ${process.pid})`);
  } catch {}
}
