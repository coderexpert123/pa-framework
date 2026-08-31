import { exec } from 'child_process';
import { platform } from 'os';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Hidden exec wrapper for Windows — prevents console window flash on every spawn
const execHidden = (cmd: string) => execAsync(cmd, { windowsHide: true, timeout: 15_000, killSignal: 'SIGKILL' });
// timeout (2026-08-31): a saturated WMI makes Get-CimInstance hang forever, and
// exec's default timeout is NONE — stuck snapshot queries then accumulate one
// wedged powershell per pa process and hold WMI hostage machine-wide (third
// storm variant, 19:30 IST: 120 zombie shells, WMI dead, both lock-heartbeat
// timers stalled). 15s hard cap → stuck child killed, empty snapshot returned,
// next heartbeat retries; degradation instead of deadlock.

export type ExecFn = (cmd: string) => Promise<{ stdout: string; stderr: string }>;

const BATCH_SIZE = 50;

// Snapshot cache to avoid per-PID OS queries on hot paths (heartbeat, idle checks)
const SNAPSHOT_TTL_MS = 300;
interface ProcessRecord {
  parentPid: number;
  cmdline: string;
}
let _cachedSnapshot: Map<number, ProcessRecord> | null = null;
let _snapshotExpiresAt = 0;

/**
 * Get a process-tree snapshot in ONE OS query. Returns a map of PID→{parentPid,cmdline}.
 * Results are cached for 300ms to make consecutive heartbeats/idle checks essentially free.
 * When a custom execFn is injected (tests), bypass the cache to preserve call-count semantics.
 * `fresh: true` forces a new query AND refreshes the cache — for DECISION points
 * (kill/extend, idle-kill) where a ≤300ms-stale read can see a just-exited child
 * as still present and wrongly extend instead of killing (2026-08-31).
 */
async function getProcessSnapshot(execFn?: ExecFn, fresh = false): Promise<Map<number, ProcessRecord>> {
  const now = Date.now();

  // If injected execFn, bypass cache entirely (tests need exact call counts)
  if (execFn) {
    return buildSnapshotFromQuery(execFn);
  }

  // Check cache for default path
  if (!fresh && _cachedSnapshot && now < _snapshotExpiresAt) {
    return _cachedSnapshot;
  }

  // Cache miss, expired, or fresh — fetch and cache
  const snapshot = await buildSnapshotFromQuery(execAsync);
  _cachedSnapshot = snapshot;
  _snapshotExpiresAt = now + SNAPSHOT_TTL_MS;
  return snapshot;
}

async function buildSnapshotFromQuery(execFn: ExecFn): Promise<Map<number, ProcessRecord>> {
  try {
    let records: Map<number, ProcessRecord>;

    if (platform() === 'win32') {
      const { stdout } = await execFn(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"`
      );
      const raw = stdout.trim();
      if (!raw) return new Map();
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : [data];
      records = new Map();
      for (const p of arr) {
        if (typeof p.ProcessId === 'number') {
          records.set(p.ProcessId, {
            parentPid: p.ParentProcessId as number,
            cmdline: p.CommandLine ?? '',
          });
        }
      }
    } else {
      const { stdout } = await execFn('ps -eo pid=,ppid= --no-headers 2>/dev/null || ps -eo pid,ppid');
      records = new Map();
      for (const line of stdout.trim().split('\n')) {
        if (!line.trim()) continue;
        const [pidStr, ppidStr] = line.trim().split(/\s+/);
        const pid = parseInt(pidStr, 10);
        const ppid = parseInt(ppidStr, 10);
        if (!isNaN(pid) && !isNaN(ppid)) {
          records.set(pid, { parentPid: ppid, cmdline: '' });
        }
      }
    }

    return records;
  } catch (err: any) {
    if (err.code === 'ENOENT') warnProcessTreeUnavailable(platform() === 'win32' ? 'powershell' : 'ps', 'getProcessSnapshot');
    return new Map();
  }
}

/**
 * Build parent→children adjacency map from the snapshot cache.
 * Used by getDescendantPids, getChildPids, hasChildProcesses.
 */
function buildAdjacencyMap(snapshot: Map<number, ProcessRecord>): Map<number, number[]> {
  const childMap = new Map<number, number[]>();
  for (const [pid, record] of snapshot) {
    if (!childMap.has(record.parentPid)) childMap.set(record.parentPid, []);
    childMap.get(record.parentPid)!.push(pid);
  }
  return childMap;
}

// Emit at most one warning per process lifetime when process-listing tools are absent
let _warnedProcessTree = false;
function warnProcessTreeUnavailable(tool: string, fn: string): void {
  if (_warnedProcessTree) return;
  _warnedProcessTree = true;
  console.warn(
    `[pa/process-tree] ${tool} not found. Child-process tracking disabled. ` +
    `To add support for this system, implement a new branch in pa/src/process-tree.ts:${fn}() ` +
    `using your platform's process-listing tool.`
  );
}

export async function getChildPids(pid: number, execFn?: ExecFn): Promise<number[]> {
  const snapshot = await getProcessSnapshot(execFn);
  const adjacency = buildAdjacencyMap(snapshot);
  return adjacency.get(pid) ?? [];
}

export async function hasChildProcesses(pid: number, isShell: boolean = false, execFn?: ExecFn, fresh = false): Promise<boolean> {
  const snapshot = await getProcessSnapshot(execFn, fresh);
  const adjacency = buildAdjacencyMap(snapshot);
  const children = adjacency.get(pid) ?? [];

  if (children.length === 0) return false;

  if (isShell) {
    // If we are spawning via a shell, the direct child is the worker agent.
    // We only count it as "having active children" if the agent itself has children (e.g. running a tool).
    for (const childPid of children) {
      const grandchildren = adjacency.get(childPid) ?? [];
      if (grandchildren.length > 0) return true;
    }
    return false;
  }

  return true;
}

/**
 * Return ALL descendants (grandchildren, great-grandchildren, etc.) of a process.
 * Issues ONE OS-level query and BFS in memory — O(total processes), not O(tree depth).
 */
export async function getDescendantPids(
  workerPid: number,
  execFn: ExecFn = execHidden
): Promise<Array<{ pid: number; parentPid: number }>> {
  const snapshot = await getProcessSnapshot(execFn);
  const adjacency = buildAdjacencyMap(snapshot);

  // BFS from workerPid — collect all descendants
  const result: Array<{ pid: number; parentPid: number }> = [];
  const queue: Array<{ pid: number; parent: number }> = [{ pid: workerPid, parent: 0 }];
  const visited = new Set<number>([workerPid]);

  while (queue.length > 0) {
    const { pid: current } = queue.shift()!;
    for (const childPid of adjacency.get(current) ?? []) {
      if (!visited.has(childPid)) {
        visited.add(childPid);
        result.push({ pid: childPid, parentPid: current });
        queue.push({ pid: childPid, parent: current });
      }
    }
  }

  return result;
}

/**
 * Fetch command-lines for a list of PIDs.
 * - win32: filters from cached snapshot (one OS query per 300ms refresh)
 * - POSIX: uses ps (no CommandLine available in snapshot)
 * - Injected execFn: bypasses cache and queries directly (preserves test call-count semantics)
 */
export async function getCommandLines(
  pids: number[],
  execFn: ExecFn = execHidden
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pids.length === 0) return result;

  // Injected execFn: bypass cache (tests need exact call counts)
  if (execFn !== execHidden) {
    return getCommandLinesDirect(pids, execFn);
  }

  if (platform() === 'win32') {
    // Use cached snapshot — filter for requested PIDs
    const snapshot = await getProcessSnapshot();
    for (const pid of pids) {
      const record = snapshot.get(pid);
      result.set(pid, record?.cmdline ?? '');
    }
    return result;
  }

  // POSIX: use ps (no CommandLine in snapshot)
  return getCommandLinesDirect(pids, execFn);
}

/**
 * Direct query path (bypasses cache). Used by injected execFn (tests) and POSIX.
 */
async function getCommandLinesDirect(
  pids: number[],
  execFn: ExecFn
): Promise<Map<number, string>> {
  const result = new Map<number, string>();

  for (let i = 0; i < pids.length; i += BATCH_SIZE) {
    const batch = pids.slice(i, i + BATCH_SIZE);
    try {
      if (platform() === 'win32') {
        const filter = batch.map(p => `ProcessId = ${p}`).join(' OR ');
        const { stdout } = await execFn(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"`
        );
        const raw = stdout.trim();
        if (!raw) continue;
        const data = JSON.parse(raw);
        const arr = Array.isArray(data) ? data : [data];
        for (const p of arr) {
          if (typeof p.ProcessId === 'number') {
            result.set(p.ProcessId, p.CommandLine ?? '');
          }
        }
      } else {
        const pidList = batch.join(',');
        const { stdout } = await execFn(`ps -o pid=,command= -p ${pidList}`);
        for (const line of stdout.trim().split('\n')) {
          if (!line.trim()) continue;
          const [pidStr, ...rest] = line.trim().split(/\s+/);
          const pid = parseInt(pidStr, 10);
          if (!isNaN(pid)) result.set(pid, rest.join(' '));
        }
      }
    } catch {
      // Batch failed — continue with next
    }
  }

  return result;
}

/**
 * Check which PIDs from a list are still alive.
 * - POSIX: uses process.kill(pid, 0) — no subprocess spawn.
 * - win32: checks cached snapshot (pid enumerated ≤300ms ago = alive; absent = dead).
 * - Injected execFn: bypasses cache and queries directly (preserves test call-count semantics).
 *
 * NOTE: killProcessTree does NOT use this function (it taskkills directly).
 * Any caller using areProcessesAlive for kill decisions should consider the 300ms staleness acceptable.
 */
export async function areProcessesAlive(
  pids: number[],
  execFn: ExecFn = execHidden
): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>();
  if (pids.length === 0) return result;

  // Injected execFn: bypass cache (tests need exact call counts)
  if (execFn !== execHidden && platform() === 'win32') {
    return areProcessesAliveDirect(pids, execFn);
  }

  if (platform() !== 'win32') {
    // POSIX: process.kill(pid, 0) is free — no spawn
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        result.set(pid, true);
      } catch (err: any) {
        result.set(pid, err.code === 'EPERM'); // EPERM → alive but not ours; ESRCH → dead
      }
    }
    return result;
  }

  // win32: use cached snapshot — presence check
  const snapshot = await getProcessSnapshot();
  for (const pid of pids) {
    result.set(pid, snapshot.has(pid));
  }
  return result;
}

/**
 * Direct query path for win32 (bypasses cache). Used by injected execFn (tests).
 */
async function areProcessesAliveDirect(
  pids: number[],
  execFn: ExecFn
): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>();

  for (let i = 0; i < pids.length; i += BATCH_SIZE) {
    const batch = pids.slice(i, i + BATCH_SIZE);
    try {
      const idList = batch.join(',');
      const { stdout } = await execFn(
        `powershell -NoProfile -Command "Get-Process -Id ${idList} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"`
      );
      const alivePids = new Set(
        stdout.trim().split('\n').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
      );
      for (const pid of batch) {
        result.set(pid, alivePids.has(pid));
      }
    } catch {
      for (const pid of batch) result.set(pid, false);
    }
  }

  return result;
}

/** Kill a process and its entire child tree. */
export function killProcessTree(pid: number): void {
  if (platform() === 'win32') {
    // taskkill /T kills the tree, /F forces it
    exec(`taskkill /T /F /PID ${pid}`, { windowsHide: true }, () => {});
  } else if (platform() === 'linux' || platform() === 'darwin') {
    try {
      process.kill(-pid, 'SIGTERM'); // negative PID = process group
    } catch {
      // process.kill(-pid) throws when pid isn't a process-group leader —
      // i.e. it was spawned without `detached: true` (setsid). That's the
      // common case for anything spawned with shell:true and no detached
      // flag, so silently swallowing this (the old behavior) meant /stop,
      // /steer, idle-kill, and orphan-reap all silently did nothing on
      // Linux/macOS. Fall back to walking the descendant tree and killing
      // each PID individually — void/fire-and-forget, so this runs as an
      // un-awaited async IIFE (all callers of killProcessTree expect sync).
      (async () => {
        // Capture descendants BEFORE killing the parent: a dead parent can
        // get its children reparented/reaped before we get to look them up.
        const descendants = await getDescendantPids(pid);
        try { process.kill(pid, 'SIGTERM'); } catch {}
        for (const { pid: childPid } of descendants) {
          try { process.kill(childPid, 'SIGTERM'); } catch {}
        }
      })();
    }
  } else {
    warnProcessTreeUnavailable('process group kill', 'killProcessTree');
    try { process.kill(pid, 'SIGTERM'); } catch {} // best-effort single-PID kill
  }
}
