/**
 * Pressure sampler for the dynamic slot governor (2026-09-11; RAM/CPU moved
 * off WMI 2026-09-13). Free physical memory and CPU busy % come straight
 * from Node (`os.freemem()`, `os.cpus()` tick deltas) — no spawn, no
 * timeout, always live. Only disk-queue length still goes through a Win32
 * CIM query, ONE spawn per 60s per process, never per-PID. Why the split:
 * under a WMI backlog (exactly the condition this sampler exists to detect)
 * a single combined query hits its timeout and the WHOLE sample went null,
 * which read as "no evidence ⇒ not pressured" and let the governor hold the
 * pool at the ceiling while the machine was being crushed — the signal
 * starved in the condition it was built to catch. Node-sourced fields can't
 * starve that way. The read API (readPressureSampleCached) is SYNCHRONOUS
 * and returns the cached sample while firing a fire-and-forget disk-queue
 * refresh in the background; the first-ever call returns null for cpuPct
 * only (no prior tick snapshot to diff against) while physFreeMb is live
 * immediately. ZERO timers of any kind. All three fields are individually
 * optional — a missing or unparseable reading is null, never a false zero.
 * Exec conventions for the remaining WMI call follow
 * c-disk-floor-watchdog.ts's defaultExec (windowsHide, a hard timeout +
 * SIGKILL), NOT process-tree.ts's cached default path, which omits
 * windowsHide.
 *
 * Memory is NOT a sizing input here — free physical is only a pressure
 * sensor, which is how swap/pagefile capacity is "counted" by construction.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, freemem, cpus, type CpuInfo } from 'node:os';

export type ExecFn = (cmd: string) => Promise<{ stdout: string; stderr: string }>;

export interface PressureSample {
  physFreeMb: number | null;
  cpuPct: number | null;
  diskQueue: number | null;
  sampledAtMs: number;
}

// Frozen command (SPEC §1.4), disk queue only now — RAM/CPU moved to Node.
// One line, no inner double quotes.
export const PRESSURE_SAMPLE_CMD =
  'powershell -NoProfile -Command "$d=Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | ' +
  "Where-Object Name -eq '_Total'; " +
  '[pscustomobject]@{CurrentDiskQueueLength=$d.CurrentDiskQueueLength} | ConvertTo-Json -Compress"';

const SAMPLE_TTL_MS = 60_000; // constant, not a knob (S3)

function defaultExec(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return promisify(exec)(cmd, {
    windowsHide: true,
    timeout: 10_000,
    killSignal: 'SIGKILL' as NodeJS.Signals,
  });
}

// Injected deps — production defaults; tests override via _setDepsForTest.
let cached: PressureSample | null = null;
let refreshInFlight = false;
let clock: () => number = Date.now;
let execFn: ExecFn = defaultExec;
let platformFn: () => string = platform;
let freememFn: () => number = freemem;
let cpusFn: () => CpuInfo[] = cpus;

// Previous tick-total snapshot for the CPU busy-% delta (F2). Reset
// alongside the rest of the module state so a test's second sample starts
// from a known baseline.
let prevCpuTicks: { idle: number; total: number } | null = null;

// Strict: a JSON number must be finite and non-negative; a digits-only
// STRING is accepted (ConvertTo-Json can widen a UInt64); everything else --
// null, undefined, a non-digit string -- is rejected. Number('') is 0, so a
// bare Number() call would turn a missing property into a reading of "0
// free" and fire a brake that has no evidence behind it
// (c-disk-floor-watchdog.ts:77-86, live defect 2026-09-03).
function strictNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

// Parses the WMI leg's output. Only CurrentDiskQueueLength is sourced from
// here now (F3) -- physFreeMb/cpuPct are always null on a value parsed by
// this function; the merged sample built in readPressureSampleCached fills
// them in live from Node.
export function parsePressureSample(stdout: string, sampledAtMs: number): PressureSample | null {
  const trimmed = String(stdout).trim();
  if (trimmed === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) parsed = parsed[0];
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const diskQueue = strictNum(obj.CurrentDiskQueueLength);
  return { physFreeMb: null, cpuPct: null, diskQueue, sampledAtMs };
}

// os.freemem() is bytes; the rest of the module (and the governor's env
// knobs) work in MB, matching the old WMI leg's KB->MB rounding.
function readPhysFreeMb(): number {
  return Math.round(freememFn() / 1024 / 1024);
}

// Busy % from the delta between this call's cpu tick totals and the
// previous call's (F2). The first-ever call has no prior snapshot to diff
// against, so it returns null -- exactly how a missing WMI field was
// treated before (never a false zero).
function computeCpuPct(): number | null {
  const infos = cpusFn();
  let idle = 0;
  let total = 0;
  for (const c of infos) {
    idle += c.times.idle;
    total += c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq;
  }
  const prev = prevCpuTicks;
  prevCpuTicks = { idle, total };
  if (prev === null) return null;
  const totalDelta = total - prev.total;
  if (totalDelta <= 0) return null; // guard a zero/negative delta (no time elapsed)
  const idleDelta = idle - prev.idle;
  return Math.round((1 - idleDelta / totalDelta) * 100);
}

// Disk-queue leg only: async, WMI-sourced, win32-only, at most one spawn
// outstanding. A failed parse or exec keeps the PREVIOUS diskQueue value in
// the currently-cached sample rather than clearing it; the TTL alone
// decides when to try again.
function fireRefresh(): void {
  if (refreshInFlight) return; // in-flight guard: at most ONE spawn outstanding
  refreshInFlight = true;
  execFn(PRESSURE_SAMPLE_CMD)
    .then(({ stdout }) => {
      const parsed = parsePressureSample(stdout, clock());
      if (parsed !== null && parsed.diskQueue !== null && cached !== null) {
        cached = { ...cached, diskQueue: parsed.diskQueue };
      }
    })
    .catch(() => { /* exec failure: same policy as a failed parse */ })
    .finally(() => { refreshInFlight = false; });
}

// SYNCHRONOUS. physFreeMb/cpuPct are Node-native reads with no spawn and no
// timeout, so they are recomputed every TTL tick regardless of whether the
// WMI disk-queue leg below ever completes -- a WMI backlog can no longer
// blind the whole sample the way it did when all three fields shared one
// query. diskQueue is carried forward from the previous cached sample (or
// null if there is none yet) until fireRefresh's async result lands.
export function readPressureSampleCached(): PressureSample | null {
  const now = clock();
  if (cached === null || now - cached.sampledAtMs >= SAMPLE_TTL_MS) {
    const physFreeMb = readPhysFreeMb();
    const cpuPct = computeCpuPct();
    const diskQueue = cached !== null ? cached.diskQueue : null;
    cached = { physFreeMb, cpuPct, diskQueue, sampledAtMs: now };
    if (platformFn() === 'win32') fireRefresh(); // no spawn off win32 (F4)
  }
  return cached;
}

export function _setDepsForTest(deps: {
  clock?: () => number;
  exec?: ExecFn;
  platform?: () => string;
  freemem?: () => number;
  cpus?: () => CpuInfo[];
}): void {
  if (deps.clock !== undefined) clock = deps.clock;
  if (deps.exec !== undefined) execFn = deps.exec;
  if (deps.platform !== undefined) platformFn = deps.platform;
  if (deps.freemem !== undefined) freememFn = deps.freemem;
  if (deps.cpus !== undefined) cpusFn = deps.cpus;
}

export function _resetForTest(): void {
  cached = null;
  refreshInFlight = false;
  clock = Date.now;
  execFn = defaultExec;
  platformFn = platform;
  freememFn = freemem;
  cpusFn = cpus;
  prevCpuTicks = null;
}

export function _cacheForTest(): PressureSample | null {
  return cached;
}
