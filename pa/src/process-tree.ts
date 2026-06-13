import { exec } from 'child_process';
import { platform } from 'os';
import { promisify } from 'util';

const execAsync = promisify(exec);

export type ExecFn = (cmd: string) => Promise<{ stdout: string; stderr: string }>;

const BATCH_SIZE = 50;

// Emit at most one warning per process lifetime when process-listing tools are absent
let _warnedProcessTree = false;
function warnProcessTreeUnavailable(tool: string, fn: string): void {
  if (_warnedProcessTree) return;
  _warnedProcessTree = true;
  console.warn(
    `[pa/process-tree] ${tool} not found. Child-process tracking disabled. ` +
    `To add support for this system, implement the POSIX branch in pa/src/process-tree.ts:${fn}() ` +
    `using your platform's process-listing tool.`
  );
}

export async function getChildPids(pid: number): Promise<number[]> {
  try {
    if (platform() === 'win32') {
      // Use PowerShell Get-CimInstance instead of deprecated wmic
      const { stdout } = await execAsync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Select-Object -ExpandProperty ProcessId"`
      );
      return stdout.trim().split('\n').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    } else {
      const { stdout } = await execAsync(`pgrep -P ${pid}`);
      return stdout.trim().split('\n').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') warnProcessTreeUnavailable('pgrep', 'getChildPids');
    return [];
  }
}

export async function hasChildProcesses(pid: number, isShell: boolean = false): Promise<boolean> {
  const children = await getChildPids(pid);
  if (children.length === 0) return false;

  if (isShell) {
    // If we are spawning via a shell, the direct child is the worker agent.
    // We only count it as "having active children" if the agent itself has children (e.g. running a tool).
    for (const childPid of children) {
      const grandchildren = await getChildPids(childPid);
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
  execFn: ExecFn = execAsync
): Promise<Array<{ pid: number; parentPid: number }>> {
  try {
    let pairs: Array<{ pid: number; parentPid: number }>;

    if (platform() === 'win32') {
      const { stdout } = await execFn(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"`
      );
      const raw = stdout.trim();
      if (!raw) return [];
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : [data];
      pairs = arr
        .filter((p: any) => typeof p.ProcessId === 'number')
        .map((p: any) => ({ pid: p.ProcessId as number, parentPid: p.ParentProcessId as number }));
    } else {
      const { stdout } = await execFn('ps -eo pid=,ppid= --no-headers 2>/dev/null || ps -eo pid,ppid');
      pairs = stdout.trim().split('\n')
        .filter(l => l.trim())
        .map(l => {
          const [p, pp] = l.trim().split(/\s+/).map(Number);
          return { pid: p, parentPid: pp };
        })
        .filter(p => !isNaN(p.pid) && !isNaN(p.parentPid));
    }

    // Build parent→children adjacency map
    const childMap = new Map<number, number[]>();
    for (const { pid, parentPid } of pairs) {
      if (!childMap.has(parentPid)) childMap.set(parentPid, []);
      childMap.get(parentPid)!.push(pid);
    }

    // BFS from workerPid — collect all descendants
    const result: Array<{ pid: number; parentPid: number }> = [];
    const queue: Array<{ pid: number; parent: number }> = [{ pid: workerPid, parent: 0 }];
    const visited = new Set<number>([workerPid]);

    while (queue.length > 0) {
      const { pid: current } = queue.shift()!;
      for (const childPid of childMap.get(current) ?? []) {
        if (!visited.has(childPid)) {
          visited.add(childPid);
          result.push({ pid: childPid, parentPid: current });
          queue.push({ pid: childPid, parent: current });
        }
      }
    }

    return result;
  } catch (err: any) {
    if (err.code === 'ENOENT') warnProcessTreeUnavailable('ps', 'getDescendantPids');
    return [];
  }
}

/**
 * Fetch command-lines for a list of PIDs. Batched at 50 PIDs per OS call.
 */
export async function getCommandLines(
  pids: number[],
  execFn: ExecFn = execAsync
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pids.length === 0) return result;

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
 * POSIX: uses process.kill(pid, 0) — no subprocess spawn.
 * Windows: batched Get-Process call (≤50 PIDs per call).
 */
export async function areProcessesAlive(
  pids: number[],
  execFn: ExecFn = execAsync
): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>();
  if (pids.length === 0) return result;

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

  // Windows: batched Get-Process with -ErrorAction SilentlyContinue
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
    exec(`taskkill /T /F /PID ${pid}`, () => {});
  } else if (platform() === 'linux' || platform() === 'darwin') {
    try { process.kill(-pid, 'SIGTERM'); } catch {} // negative PID = process group
  } else {
    warnProcessTreeUnavailable('process group kill', 'killProcessTree');
    try { process.kill(pid, 'SIGTERM'); } catch {} // best-effort single-PID kill
  }
}
