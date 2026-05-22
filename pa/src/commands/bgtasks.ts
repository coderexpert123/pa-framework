import { readFile } from 'fs/promises';
import { join } from 'path';
import type { BlackboardData } from '../blackboard.js';
import type { ExecFn } from '../process-tree.js';
import { getDescendantPids, getCommandLines, killProcessTree } from '../process-tree.js';
import { paHome } from '../paths.js';

interface BgtasksHooks {
  getDescendantPids?: (pid: number) => Promise<Array<{ pid: number; parentPid: number }>>;
  getCommandLines?: (pids: number[]) => Promise<Map<number, string>>;
  execFn?: ExecFn;
}

export async function bgtasksCommand(argv: string[], hooks?: BgtasksHooks): Promise<void> {
  const jsonMode = argv.includes('--json');
  const killIdx = argv.indexOf('--kill');
  let killPid: number | undefined;
  if (killIdx !== -1) {
    const rawKill = argv[killIdx + 1];
    if (!rawKill || isNaN(parseInt(rawKill, 10))) {
      console.error('--kill requires a numeric PID argument');
      process.exit(2);
    }
    killPid = parseInt(rawKill, 10);
  }

  const bbPath = join(paHome(), 'blackboard.json');
  let data: BlackboardData = { active_locks: [] };
  try {
    const raw = await readFile(bbPath, 'utf8');
    data = JSON.parse(raw);
  } catch {
    // No blackboard or unreadable — treat as empty
  }

  const activeLocks = data.active_locks.filter(l => l.pid > 0);
  if (activeLocks.length === 0) {
    console.log('no active workers');
    return;
  }

  const bgGetDescendants = hooks?.getDescendantPids
    ?? ((pid: number) => getDescendantPids(pid, hooks?.execFn));
  const bgGetCmdlines = hooks?.getCommandLines
    ?? ((pids: number[]) => getCommandLines(pids, hooks?.execFn));

  // Fetch descendants for all active locks (one pass)
  const workerDescendants = new Map<number, Array<{ pid: number; parentPid: number }>>();
  for (const lock of activeLocks) {
    workerDescendants.set(lock.pid, await bgGetDescendants(lock.pid));
  }

  // Map desc PID → worker PID for kill validation
  const descToWorker = new Map<number, number>();
  for (const [workerPid, descendants] of workerDescendants) {
    for (const { pid } of descendants) {
      descToWorker.set(pid, workerPid);
    }
  }

  // Batch-fetch all cmdlines
  const allDescPids = [...descToWorker.keys()];
  const cmdlines = await bgGetCmdlines(allDescPids);

  // Handle --kill
  if (killPid !== undefined && !isNaN(killPid)) {
    if (!descToWorker.has(killPid)) {
      console.error(`PID ${killPid} is not a tracked descendant of any active worker`);
      process.exit(2);
    }
    // TOCTOU re-check
    const parentWorkerPid = descToWorker.get(killPid)!;
    const current = await bgGetDescendants(parentWorkerPid);
    if (!current.some(d => d.pid === killPid)) {
      console.error(`PID ${killPid} is no longer a descendant of worker ${parentWorkerPid} (TOCTOU check failed)`);
      process.exit(2);
    }
    killProcessTree(killPid);
    console.log(`Killed PID ${killPid}`);
    return;
  }

  // Build rows
  const rows: Array<{ workerPid: number; resource: string; descPid: number; cmd: string }> = [];
  for (const lock of activeLocks) {
    for (const { pid } of workerDescendants.get(lock.pid) ?? []) {
      rows.push({
        workerPid: lock.pid,
        resource: lock.resource,
        descPid: pid,
        cmd: (cmdlines.get(pid) ?? '(unknown)').slice(0, 80),
      });
    }
  }

  if (rows.length === 0) {
    console.log('no active workers');
    return;
  }

  if (jsonMode) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log('WORKER-PID  RESOURCE                          DESC-PID  CMD');
  console.log('-'.repeat(80));
  for (const r of rows) {
    const res = r.resource.length > 32 ? r.resource.slice(0, 31) + '…' : r.resource;
    console.log(`${String(r.workerPid).padEnd(10)}  ${res.padEnd(32)}  ${String(r.descPid).padEnd(8)}  ${r.cmd}`);
  }
}
