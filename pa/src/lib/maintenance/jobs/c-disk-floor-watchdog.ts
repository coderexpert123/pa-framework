import { exec } from 'child_process';
import { promisify } from 'util';
import { platform } from 'os';
import { lstat, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { paHome } from '../../../paths.js';
import { notifyUser } from '../../notify.js';
import { log } from '../../log.js';
import { writeJsonAtomic } from '../../atomic-write.js';
import type { MaintenanceJob, MaintenanceJobContext, MaintenanceJobResult } from '../types.js';

const MINUTE = 60_000;
/** Alert when C: free space drops below this. Default 5 GiB, matching the push
 *  skill's manual Step-0 precondition ("<~5GB") and df -h's GiB convention
 *  (origin: the 2026-09-03 push-gate contention investigation — two push gates ran
 *  with C: at 99% used / 1.9 GB free). The defaults here are deployment
 *  conventions, not laws of nature — the env knobs (PA_CDISK_FLOOR_BYTES bytes,
 *  PA_CDISK_SCAN_ROOT, PA_CDISK_SCAN_BUDGET_MS) override them per environment,
 *  and they are read per pass, not at import (pa catchup runs this job in a
 *  fresh process every tick, so the two are equivalent in production; per-pass
 *  reads keep the knobs testable without a module re-import). */
export const FLOOR_BYTES = 5 * 1024 * 1024 * 1024;
const DRIVE = 'C';
/** du-style top-consumer scan budget. The scan is best-effort garnish on an
 *  already-actionable alert; when the budget runs out the alert says to sweep
 *  the scan root manually instead of stalling a maintenance tick. */
const SCAN_BUDGET_MS = 2_000;
const SCAN_ROOT_WIN32 = 'C:/wt';
const SCAN_DEPTH_MAX = 8;
const TOP_N = 3;

export function cDiskFloorStatePath(): string {
  return join(paHome(), 'c-disk-floor-watchdog.json');
}

interface FloorState {
  /** Observation from the PREVIOUS pass — the transition gate. Durable because
   *  `pa catchup` runs jobs in a fresh process every minute; in-memory state
   *  could never see a crossing. Defaults to false when missing/corrupt, which
   *  can only ever cause ONE extra alert after state loss, never a missed one. */
  wasBelow: boolean;
  lastCheckedAt: string;
  freeBytes?: number;
  lastAlertedAt?: string;
}

async function defaultReadState(): Promise<FloorState | null> {
  try {
    const parsed = JSON.parse(await readFile(cDiskFloorStatePath(), 'utf8'));
    if (typeof parsed?.wasBelow === 'boolean') return parsed as FloorState;
    return null;
  } catch {
    return null; // missing or corrupt — treat as "was above" (safe direction)
  }
}

/** PowerShell one-liner through the process-tree exec conventions
 *  (windowsHide:true, hard timeout + SIGKILL — a wedged shell must degrade the
 *  tick, not hold it; see pa/src/process-tree.ts's execHidden note). */
export type ExecFn = (cmd: string) => Promise<{ stdout: string; stderr: string }>;

/** The full command execFn runs. `exec` routes through cmd.exe, so the
 *  PowerShell expression must be wrapped in `powershell -NoProfile -Command "..."`
 *  (the process-tree.ts:94 convention); a bare `(Get-PSDrive C).Free` reaches
 *  cmd and fails with ".Free was unexpected at this time." (live CLI smoke,
 *  2026-09-03). */
export const FREE_SPACE_CMD = `powershell -NoProfile -Command "(Get-PSDrive ${DRIVE}).Free"`;

function defaultExec(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return promisify(exec)(cmd, {
    windowsHide: true,
    timeout: 10_000,
    killSignal: 'SIGKILL' as NodeJS.Signals,
  });
}

export function parseFreeBytes(stdout: string): number {
  // Strict digits only: Number('') is 0, so a bare Number() call maps an EMPTY
  // stdout to "0 bytes free" — a false below-floor reading that fires a real
  // alert (live-run defect 2026-09-03). An unparseable output must THROW, not
  // degrade to a number.
  const s = String(stdout).trim();
  if (!/^\d+$/.test(s)) return NaN;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

export interface WtConsumer {
  path: string;
  bytes: number;
}

export interface WtScan {
  top: WtConsumer[];
  /** True when the budget ran out before every top-level child was sized —
   *  the alert then defers to a manual sweep. */
  incomplete: boolean;
}

/** Sum one directory tree, iteratively (no recursion depth blowups), skipping
 *  symlinks/junctions (worktrees junction node_modules to the live D: checkout
 *  — following them would double-count D: content and stall the scan). */
async function sizeDir(dir: string, deadline: number, depth: number): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return 0; // unreadable/vanished — contributes 0, never fails the scan
  for (const entry of entries) {
    if (Date.now() > deadline) throw new ScanBudgetExceeded();
    const full = join(dir, entry.name);
    try {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth >= SCAN_DEPTH_MAX) continue;
        total += await sizeDir(full, deadline, depth + 1);
      } else {
        const st = await lstat(full);
        total += st.size;
      }
    } catch {
      // vanished between readdir and stat — skip
    }
  }
  return total;
}

class ScanBudgetExceeded extends Error {}

/** Top `TOP_N` consumers under the scratch root, best-effort within the budget. */
export async function scanWtConsumers(root: string, budgetMs: number): Promise<WtScan> {
  const deadline = Date.now() + budgetMs;
  const top: WtConsumer[] = [];
  let incomplete = false;
  const children = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (children === null) return { top, incomplete: true }; // no scratch root — nothing local to name
  for (const child of children) {
    if (!child.isDirectory() || child.isSymbolicLink()) continue;
    try {
      const bytes = await sizeDir(join(root, child.name), deadline, 1);
      top.push({ path: join(root, child.name), bytes });
    } catch (err) {
      if (err instanceof ScanBudgetExceeded) {
        incomplete = true;
        break;
      }
      throw err;
    }
  }
  top.sort((a, b) => b.bytes - a.bytes);
  return { top: top.slice(0, TOP_N), incomplete };
}

function gb(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

/** Injectable dependencies (the DI pattern the maintenance jobs use — ESM
 *  module namespaces are read-only, so tests override via deps, not mocks). */
export interface CDiskFloorDeps {
  execFn?: ExecFn;
  notifyFn?: typeof notifyUser;
  readStateFn?: () => Promise<FloorState | null>;
  writeStateFn?: (state: FloorState) => Promise<void>;
  scanRoot?: string;
  scanBudgetMs?: number;
}

/** The real pass, deps-injectable (the daily-recon pattern: the registry entry
 *  stays a 1-param MaintenanceJob.run wrapper; tests drive this directly). */
export async function runCDiskFloorWatchdog(
  ctx: MaintenanceJobContext,
  deps: CDiskFloorDeps = {},
): Promise<MaintenanceJobResult> {
  const execFn = deps.execFn ?? defaultExec;
  const notifyFn = deps.notifyFn ?? notifyUser;
  const readStateFn = deps.readStateFn ?? defaultReadState;
  const writeStateFn =
    deps.writeStateFn ?? ((state: FloorState) => writeJsonAtomic(cDiskFloorStatePath(), state));
  const scanRoot =
    deps.scanRoot ??
    (process.env.PA_CDISK_SCAN_ROOT ||
      (platform() === 'win32' ? SCAN_ROOT_WIN32 : '/nonexistent-pa-wt-scan'));
  const scanBudgetMs =
    deps.scanBudgetMs ?? (Number(process.env.PA_CDISK_SCAN_BUDGET_MS) || SCAN_BUDGET_MS);
  const floorBytes = Number(process.env.PA_CDISK_FLOOR_BYTES) || FLOOR_BYTES;

  let freeBytes: number;
  let rawOutput = '';
  try {
    const { stdout } = await execFn(FREE_SPACE_CMD);
    rawOutput = stdout;
    freeBytes = parseFreeBytes(stdout);
  } catch (err: any) {
    // Throw, don't swallow: an observation this job cannot make is a job
    // failure — the runner records it and the AI-098 backoff ladder paces the
    // retry (recall-index idiom), instead of silently going blind forever.
    throw new Error(`c-disk-floor-watchdog: free-space query failed: ${err?.message ?? err}`);
  }
  if (Number.isNaN(freeBytes)) {
    // Raw output (bounded) in the error: the one live run that returned an
    // empty/zero reading would otherwise be undiagnosable from the ledger.
    throw new Error(
      `c-disk-floor-watchdog: unparseable free-space output (expected bytes, got ${JSON.stringify(String(rawOutput).slice(0, 80))})`,
    );
  }

  const below = freeBytes < floorBytes;
  const prev = await readStateFn();
  const wasBelow = prev?.wasBelow === true;
  const nowIso = new Date(ctx.now).toISOString();
  const nextState: FloorState = {
    wasBelow: below,
    lastCheckedAt: nowIso,
    freeBytes,
    ...(wasBelow && below && prev?.lastAlertedAt ? { lastAlertedAt: prev.lastAlertedAt } : {}),
  };

  // The transition IS the alert condition: fire once on the above→below
  // crossing, stay silent while it persists, re-arm above the floor. The
  // notify dedup key is only the second layer (e.g. a send confirmed but the
  // state write failed must not re-page within the flat window).
  let alerted = false;
  if (below && !wasBelow) {
    const scan = await scanWtConsumers(scanRoot, scanBudgetMs);
    const consumers = scan.top.length
      ? scan.top.map((c) => `${c.path} ${gb(c.bytes)} GB`).join('\n')
      : '';
    const body =
      `Free: ${gb(freeBytes)} GB (floor ${gb(floorBytes)} GB)\n` +
      (consumers ? `Top ${scanRoot} consumers:\n${consumers}\n` : '') +
      (scan.incomplete
        ? `Consumer scan hit its ${Math.round(scanBudgetMs / 100) / 10}s budget — sweep ${scanRoot} manually.\n`
        : '') +
      'Push gates and test runs are unreliable below this floor (AI-198, 2026-09-03).';

    log('warn', 'maintenance', 'c-disk-floor-watchdog: C: free space below floor', {
      job: cDiskFloorWatchdogJob.name,
      freeBytes,
      floorBytes,
    });
    await notifyFn(`C: free space below ${gb(floorBytes)} GB floor`, body, {
      dedupKey: 'c-disk-floor',
      severity: 'warn',
      escalate: false,
    }).catch(() => {});
    alerted = true;
    nextState.lastAlertedAt = nowIso;
  }

  await writeStateFn(nextState).catch((err) => {
    // Non-fatal (next tick re-reads; the notify dedup key covers the gap),
    // but never silent — state loss is exactly what the transition gate
    // depends on.
    log('warn', 'maintenance', 'c-disk-floor-watchdog: state write failed', {
      job: cDiskFloorWatchdogJob.name,
      error: err?.message ?? String(err),
    });
  });

  return {
    touched: alerted ? 1 : 0,
    detail: { freeBytes, floorBytes, below, wasBelow, alerted },
  };
}

export const cDiskFloorWatchdogJob: MaintenanceJob = {
  name: 'c-disk-floor-watchdog',
  host: 'pa',
  everyMs: 30 * MINUTE,
  description:
    'OBSERVE-ONLY machine guard: every 30 min reads C: free bytes; when it crosses BELOW the configured ' +
    'floor (default 5 GiB, a deployment convention overridable via env knobs), ' +
    'pages pa-alerts once per crossing (transition state in ~/.pa/c-disk-floor-watchdog.json, notify dedup ' +
    "key 'c-disk-floor', escalate:false) naming the top scan-root consumers, best-effort within the " +
    'configured scan budget. ' +
    'Above the floor it does nothing — no recovery alert, no deletion (deletion stays with shared-tmp-sweep). ' +
    'Dated evidence: 2026-09-03, C: sat at 99% used / 1.9 GB free while two push gates failed 12-13 unrelated ' +
    'subtests that a quiet-machine rerun passed ' +
    '(origin: the 2026-09-03 push-gate contention and env-investigation records) — ' +
    'the push skill got a manual Step-0 precondition; this job is the automated machine-level twin.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run(ctx: MaintenanceJobContext): Promise<MaintenanceJobResult> {
    return runCDiskFloorWatchdog(ctx);
  },
};
