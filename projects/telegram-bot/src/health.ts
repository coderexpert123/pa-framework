/**
 * Self-health probe + degraded mode (AI-096 item 4).
 *
 * Samples two starvation signals every PROBE_INTERVAL_MS:
 *   - event-loop lag: how late the probe timer itself fires;
 *   - fs latency: a small write+delete to PA_HOME, timed.
 *
 * When either crosses the ENTER threshold the bot goes DEGRADED: non-essential
 * work (typing keep-alive, model sweep, log-rotation check) is shed so the poll
 * loop and reply sends get whatever I/O capacity remains. Hysteresis on the
 * EXIT thresholds prevents flapping. Transitions are logged once each.
 *
 * The decision function is pure and exported for tests; the probe wiring is a
 * thin shell around it.
 */
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../../../pa/dist/src/lib/log.js';

export const PROBE_INTERVAL_MS = 15_000;
export const ENTER_LAG_MS = 2_000;      // timer fired ≥2s late → starved
export const ENTER_FS_MS = 3_000;       // small write took ≥3s → disk stalled
export const EXIT_LAG_MS = 500;         // both must recover before leaving
export const EXIT_FS_MS = 1_000;

let degraded = false;

/** Pure transition rule with hysteresis. Exported for tests. */
export function computeDegraded(current: boolean, lagMs: number, fsMs: number): boolean {
  if (!current) return lagMs >= ENTER_LAG_MS || fsMs >= ENTER_FS_MS;
  return !(lagMs <= EXIT_LAG_MS && fsMs <= EXIT_FS_MS);
}

/** True while the machine is too starved for non-essential work. */
export function isDegraded(): boolean {
  return degraded;
}

/** Test hook. */
export function _setDegradedForTest(v: boolean): void {
  degraded = v;
}

async function measureFsLatency(): Promise<number> {
  const probe = join(process.env.PA_HOME ?? join(homedir(), '.pa'), '.health-probe');
  const t0 = Date.now();
  try {
    await writeFile(probe, String(t0), 'utf8');
    await unlink(probe).catch(() => {});
  } catch {
    return Number.MAX_SAFE_INTEGER; // can't even write → treat as fully stalled
  }
  return Date.now() - t0;
}

/** Start the background probe. Unref'd — never keeps the process alive. */
export function startHealthProbe(intervalMs: number = PROBE_INTERVAL_MS): NodeJS.Timeout {
  let expectedAt = Date.now() + intervalMs;
  const timer = setInterval(async () => {
    const lagMs = Math.max(0, Date.now() - expectedAt);
    expectedAt = Date.now() + intervalMs;
    const fsMs = await measureFsLatency();
    const next = computeDegraded(degraded, lagMs, fsMs);
    if (next !== degraded) {
      degraded = next;
      logger.warn('health', degraded
        ? `entering DEGRADED mode (lag=${lagMs}ms fs=${fsMs}ms) — shedding typing/sweeps`
        : `leaving degraded mode (lag=${lagMs}ms fs=${fsMs}ms)`);
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}
