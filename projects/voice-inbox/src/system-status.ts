/**
 * System/thread/queue status for the operator-facing dashboard view
 * (GET /api/v1/system/status). Reads of ~/.pa/topic-threads, worker-pids,
 * blackboard.json etc. plus psutil-derived CPU/mem/disk/uptime are ALL owned
 * by scripts/system_status.py (see that file's docstring for why: reusing
 * the already-working psutil logic beats re-implementing Windows
 * disk/process-memory reads in Node). This module just spawns it and caches
 * the result so a 2-3s UI poll from multiple tabs doesn't fork a process per
 * request.
 *
 * Serving semantics (2026-09-13, vi-2d9444e29d52 recurrence): the collector
 * can take 10-25s on a degraded machine (the ~33k-file pa-dir walk alone was
 * measured at 11.5s), far past any per-request budget — the pre-fix 8s spawn
 * timeout made every poll whose dir-size cache had lapsed return 500 and the
 * PWA showed "unavailable". So a fresh collection NEVER blocks a request that
 * already has data: serve the last good snapshot immediately (stale-while-
 * revalidate), refresh in the background, dedup concurrent callers onto one
 * in-flight spawn. Only a COLD cache (no snapshot yet, e.g. first poll after
 * a server restart) awaits the collection, up to TIMEOUT_MS. A snapshot older
 * than MAX_STALE_MS is not served — a collector that has been broken for that
 * long surfaces as an honest 500 instead of stale numbers looking live. A
 * keep-warm timer additionally refreshes the snapshot every KEEP_WARM_INTERVAL_MS
 * once any request has armed it, so a dashboard click after a long idle period
 * is served from a recently refreshed snapshot instead of gambling on a cold
 * collection.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export interface SystemStatus {
  generated_at: number;
  threads: {
    running_count: number;
    queued_count: number;
    running: Array<{ topic: string; id: string; title: string; updatedAt: string }>;
    queued: Array<{ topic: string; id: string; title: string; updatedAt: string }>;
    by_status: Record<string, number>;
    active_topic_count: number;
    total_topic_count: number;
  };
  workers: {
    processes: Array<{ pid: number | null; alive: boolean; worker: string | null; skill: string | null; startedAt: string | null; rss_bytes: number }>;
    alive_count: number;
    slot_used: number;
    slot_ceiling: number;
    slot_ceiling_derived: boolean;
  };
  health: { bot_pid: number | null; bot_alive: boolean; catchup_pid: number | null; catchup_alive: boolean };
  system: {
    cpu_percent: number;
    cpu_count: number | null;
    mem_total: number;
    mem_used: number;
    mem_percent: number;
    disks: Record<string, { total: number; used: number; free: number; percent: number } | null>;
    boot_time: number;
    uptime_secs: number;
  };
  assistant_mem_bytes: number;
  pa_dir_size: { bytes: number; files: number; computed_at: number };
}

export const CACHE_TTL_MS = 10_000;
export const MAX_STALE_MS = 10 * 60_000;
const TIMEOUT_MS = 60_000;
const KEEP_WARM_INTERVAL_MS = 30_000;

let lastGood: { data: SystemStatus; at: number } | null = null;
let inflight: Promise<SystemStatus> | null = null;
let keepWarmTimer: NodeJS.Timeout | null = null;
let keepWarmIntervalMs = KEEP_WARM_INTERVAL_MS;
let keepWarmCtx: {
  repoRoot: string;
  runFn: (repoRoot: string) => Promise<SystemStatus>;
  nowFn: () => number;
} | null = null;

/**
 * Test seam: the runner and clock are injectable and the module-level
 * snapshot/in-flight state is resettable (see src/tests/system-status.test.ts).
 */
export function __resetSystemStatusForTests(): void {
  lastGood = null;
  inflight = null;
  if (keepWarmTimer) {
    clearInterval(keepWarmTimer);
    keepWarmTimer = null;
  }
  keepWarmCtx = null;
  keepWarmIntervalMs = KEEP_WARM_INTERVAL_MS;
}

/** Test seam: shrink the keep-warm period; re-arms the timer if it is running. */
export function __setKeepWarmIntervalMsForTests(ms: number): void {
  keepWarmIntervalMs = ms;
  if (keepWarmTimer) {
    clearInterval(keepWarmTimer);
    keepWarmTimer = null;
    if (keepWarmCtx) keepWarmTimer = armKeepWarm();
  }
}

function startRefresh(
  repoRoot: string,
  runFn: (repoRoot: string) => Promise<SystemStatus>,
  nowFn: () => number,
): Promise<SystemStatus> {
  inflight = runFn(repoRoot)
    .then((data) => {
      lastGood = { data, at: nowFn() };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  // A rejected refresh must not become an unhandled rejection riding the
  // shared inflight promise: cold-cache callers await it (they handle the
  // rejection), but warm-cache and keep-warm callers only touch it fire-and-forget.
  inflight.catch(() => {});
  return inflight;
}

export function getSystemStatus(
  repoRoot: string,
  runFn: (repoRoot: string) => Promise<SystemStatus> = runScript,
  nowFn: () => number = Date.now,
): Promise<SystemStatus> {
  keepWarmCtx = { repoRoot, runFn, nowFn };
  if (!keepWarmTimer) keepWarmTimer = armKeepWarm();

  if (lastGood && nowFn() - lastGood.at < CACHE_TTL_MS) return Promise.resolve(lastGood.data);

  const pending = inflight ?? startRefresh(repoRoot, runFn, nowFn);

  if (lastGood && nowFn() - lastGood.at < MAX_STALE_MS) return Promise.resolve(lastGood.data);
  return pending;
}

function armKeepWarm(): NodeJS.Timeout {
  const timer = setInterval(() => {
    keepWarmTick();
  }, keepWarmIntervalMs);
  timer.unref(); // never hold the process (or a test run) open by itself
  return timer;
}

/**
 * One background tick: refresh when the snapshot is not fresh and nothing is
 * already in flight. Shares the request path's startRefresh/lastGood plumbing
 * (one pathway), so a concurrent cold caller that grabs this inflight still
 * receives a real SystemStatus.
 */
function keepWarmTick(): void {
  const ctx = keepWarmCtx;
  if (!ctx || inflight) return;
  if (lastGood && ctx.nowFn() - lastGood.at < CACHE_TTL_MS) return;
  startRefresh(ctx.repoRoot, ctx.runFn, ctx.nowFn);
}

function runScript(repoRoot: string): Promise<SystemStatus> {
  return new Promise((resolvePromise, reject) => {
    // repoRoot is the REPO root (repo-root.ts, AI-236 convention) — the script
    // lives at <repo>/projects/voice-inbox/scripts, not <repo>/voice-inbox.
    const scriptPath = join(repoRoot, 'projects', 'voice-inbox', 'scripts', 'system_status.py');
    let child;
    try {
      child = spawn('python', [scriptPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let stdout = '';
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* best effort */
      }
      done(() => reject(new Error('system_status.py timed out')));
    }, TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done(() => reject(err));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        done(() => reject(new Error(`system_status.py exited ${code}`)));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as SystemStatus;
        done(() => resolvePromise(parsed));
      } catch (err) {
        done(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
  });
}
