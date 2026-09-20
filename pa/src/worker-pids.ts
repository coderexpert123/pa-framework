import { writeFile, readFile, readdir, unlink, mkdir, rename, stat } from 'fs/promises';
import { join } from 'path';
import { paHome } from './paths.js';
import { killProcessTree, getProcessSnapshot } from './process-tree.js';
import type { ProcessRecord } from './process-tree.js';
import { log } from './lib/log.js';

export interface WorkerPidEntry {
  pid: number;
  spawnedBy: number;   // PID of the process that spawned this worker (bot or catchup)
  worker: string;
  skill: string;
  /** Identity of THIS dispatch, not of the lane. `skill` is a RESOURCE and a
   * bare topic resource is reused by every message in that topic, so a kill
   * that matches on `skill` alone can take down an unrelated dispatch that
   * started after the intended one ended. The worker carries the same value
   * in PA_WORKER_DISPATCH_ID, so any consumer that recorded it can prove the
   * registry still holds the dispatch it meant before acting. */
  dispatchId?: string;
  startedAt: string;
  /** Live descendant PIDs, refreshed each executeWorker heartbeat. Needed because
   * `pid` is the shell wrapper (spawn shell:true) — the wrapper can die with the
   * spawner while the real CLI child keeps running (observed 2026-07-04: cmd
   * wrapper 35304 dead, claude 27220 alive → reaper false-negatived liveness). */
  descendants?: number[];
  /** AI-114: ISO deadline (set via RunOptions.harvestWindowMs at registration
   * time) protecting this entry from cleanupOrphanedWorkers even when the
   * spawner has died, as long as a tracked pid is still alive — lets a
   * crashed-instance dispatch finish so its reply can be harvested instead of
   * being killed by the next per-minute `pa catchup` sweep. */
  harvestUntil?: string;
  /** Path to the tee-captured stdout file for this dispatch (set by
   * worker-exec for agy only; undefined for all other workers and when
   * AGY_TEE_OUT was externally set). Read by the orphan reaper to recover
   * sessionless workers' replies. */
  teePath?: string;
  /** Epoch-ms of the last executor heartbeat, stamped by listWorkerPids from
   * the entry file's mtime — NOT persisted in the JSON. The file is
   * atomically rewritten at spawn (addWorkerPid) and on every executeWorker
   * heartbeat (updateWorkerPidDescendants, 30 s cadence), so its mtime IS
   * the executor's liveness clock. Consumers deciding kill/replay semantics
   * use it to tell "alive and supervised" from "processes linger but nobody
   * is driving" (2026-09-14 AI-221 incident: a healthy streaming run was
   * killed off ledger-telemetry staleness alone). Absent on stat failure —
   * treat as stale. */
  heartbeatAt?: number;
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
  } catch (err: unknown) {
    // ENOENT (entry already removed — worker finished) is normal and silent.
    // Anything else is the write that *creates* the data /stop depends on
    // (AI-112) — a silent failure here reproduces the same bug by a different
    // route, so it must be logged, not swallowed.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log('warn', 'worker-pids', 'Failed to update worker pid descendants', { pid, error: String(err) });
    }
  }
}

export async function removeWorkerPid(pid: number): Promise<void> {
  try {
    await unlink(join(pidsDir(), `${pid}.json`));
  } catch (err: unknown) {
    // ENOENT means already deleted — normal and silent. Anything else is
    // logged rather than swallowed (AI-112); other errors are still handled
    // by startup cleanup as a backstop.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log('warn', 'worker-pids', 'Failed to remove worker pid entry', { pid, error: String(err) });
    }
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
      const entry = JSON.parse(await readFile(join(dir, file), 'utf8')) as WorkerPidEntry;
      try {
        entry.heartbeatAt = (await stat(join(dir, file))).mtimeMs;
      } catch {
        /* absent → stale */
      }
      entries.push(entry);
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
export async function cleanupOrphanedWorkers(
  excludeSkills?: Set<string>,
  opts?: { now?: number; snapshot?: ReadonlyMap<number, ProcessRecord> }
): Promise<number> {
  const dir = pidsDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return 0; // No dir = no orphans
  }

  const now = opts?.now ?? Date.now();
  // Lazily fetched on first survivors-bearing entry — one OS query for the
  // whole sweep, skipped entirely when nothing needs killing.
  let snapshot: ReadonlyMap<number, ProcessRecord> | null | undefined;
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
        // Check descendants too, not just the shell wrapper: the wrapper can die
        // while its CLI child lives (2026-07-04), and taskkill /T on a dead pid
        // reaches nothing. A dead intermediate also breaks taskkill's tree walk
        // even when the wrapper is alive, so kill each surviving pid's subtree
        // individually rather than relying on one walk from the wrapper.
        const survivors = [entry.pid, ...(entry.descendants ?? [])].filter(isProcessAlive);

        // Stale-PPID guard (AI-328): `descendants` was enumerated while the
        // worker lived, but Windows ParentProcessId is immutable — pid reuse
        // can mis-attribute foreign/system processes into the persisted list
        // (observed: svchost/services in a 211-pid descendant set). A process
        // created BEFORE this worker's startedAt cannot be its descendant —
        // exclude those from the kill set. The registry entry stays the
        // membership authority (no ancestry re-walk here): the recorded
        // descendants were verified by their own spawner's enumeration, and
        // post-hoc ancestry is ambiguous once intermediates die. Snapshot
        // unavailable/empty → kill survivors as before (degraded > blind).
        let killable = survivors;
        if (survivors.length > 0) {
          if (snapshot === undefined) {
            snapshot = opts?.snapshot ?? (await getProcessSnapshot(undefined, true).catch(() => null));
          }
          if (snapshot && snapshot.size > 0) {
            const notBefore = Date.parse(entry.startedAt) - 5_000;
            killable = survivors.filter(pid => {
              const rec = snapshot!.get(pid);
              if (rec?.createdMs !== undefined && rec.createdMs < notBefore) {
                log('warn', 'worker-pids', 'Skipping stale-PPID phantom in orphan reap (predates worker start)', {
                  pid, entryPid: entry.pid, worker: entry.worker, skill: entry.skill,
                });
                return false;
              }
              return true;
            });
          }
        }

        // AI-114: a caller may have stamped a harvest deadline (RunOptions'
        // harvestWindowMs) so a still-replying dispatch survives the periodic
        // `pa catchup` sweep (which runs every 60s with no excludeSkills of
        // its own). Corrupt/expired/no-survivors all fail closed to today's
        // behavior — only a valid future deadline with a live survivor
        // protects the entry, and only until the deadline or until every
        // known pid is confirmed dead, whichever comes first.
        const harvestDeadline = entry.harvestUntil ? Date.parse(entry.harvestUntil) : NaN;
        if (!Number.isNaN(harvestDeadline) && harvestDeadline > now && survivors.length > 0) {
          log('info', 'worker-pids', 'Skipping orphaned worker within harvest window', {
            pid: entry.pid, worker: entry.worker, skill: entry.skill,
            harvestUntil: entry.harvestUntil, survivors,
          });
          continue;
        }

        if (killable.length > 0) {
          log('warn', 'worker-pids', 'Killing orphaned worker', {
            pid: entry.pid, worker: entry.worker, skill: entry.skill,
            spawnedBy: entry.spawnedBy, survivors: killable,
          });
          for (const pid of killable) killProcessTree(pid);
          killed++;
        } else if (entry.descendants === undefined) {
          // Removing an entry that never recorded descendants, this soon
          // after spawn, is the one residual/structurally-unfixable leak
          // window (a grandchild forked and its wrapper died within the same
          // couple seconds, before the first heartbeat could persist
          // descendants). Not actionable here — just greppable.
          const ageMs = now - Date.parse(entry.startedAt);
          if (!Number.isNaN(ageMs) && ageMs >= 0 && ageMs < 30_000) {
            log('warn', 'worker-pids', 'Removing worker-pid entry with no recorded descendants — possible leaked CLI child', {
              pid: entry.pid, worker: entry.worker, skill: entry.skill, startedAt: entry.startedAt,
            });
          }
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
