/**
 * `nonpaged-pool-watch` (2026-09-10 launch-cadence wave).
 *
 * On 2026-09-10 this machine's disk pinned because Windows Terminal
 * re-opened two per-user Cascadia Mono fonts about 22,000 times a second,
 * each open allocating an NTFS file-control block (`NtFC`) in NONPAGED
 * kernel pool at roughly 6.1 GB/hour. The pool reached 11.3 GB of 15.9 GB
 * RAM, the file cache was squeezed to 105 MB, and every `node.exe` launch
 * became a cold read from a 5400 rpm HDD (33.2 s cold vs 1.2 s warm). The
 * leak ran for 78 hours with no signal beyond "the machine feels slow" —
 * this job is the detector that would have caught it hours earlier.
 *
 * An alert that reports only a total costs the next person the entire
 * investigation: knowing the leak was `NtFC` named the culprit in minutes.
 * So this job reports per-tag attribution (via `pa/scripts/pool_tags.py`,
 * a ctypes wrapper over `NtQuerySystemInformation(SystemPoolTagInformation)`
 * — RAMMap's scan never finishes on a starved machine and `poolmon` needs
 * the WDK), not just a number.
 *
 * Non-destructive: reads a kernel counter and sends an alert. Deletes and
 * archives nothing (destructive: false, targets: [] — c-disk-floor-watchdog
 * and orphan-edit-watch are the precedent for that empty array being
 * correct, not an omission).
 */

import { execFile } from 'child_process';
import { platform } from 'os';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { paHome } from '../../../paths.js';
import { notifyUser } from '../../notify.js';
import { log } from '../../log.js';
import { writeJsonAtomic } from '../../atomic-write.js';
import { resolvePythonCommand } from '../../python.js';
import { repoRootFromModule } from '../../git-root.js';
import type { MaintenanceJob, MaintenanceJobContext, MaintenanceJobResult } from '../types.js';

const execFileAsync = promisify(execFile);
const MINUTE = 60_000;

/** Absolute nonpaged-pool floor. Default 3 GiB — a deployment convention (the
 *  2026-09-10 leak crossed it from a ~1 GiB baseline inside ~20 minutes at its
 *  observed rate), not a property of Windows. Read per pass, never at import —
 *  `pa catchup` runs this job in a fresh process every tick. */
export const DEFAULT_ALERT_BYTES = 3 * 1024 * 1024 * 1024;
export const DEFAULT_EARLY_BYTES = 1.5 * 1024 * 1024 * 1024;
/** Growth trigger, measured against the stored baseline sample. Default
 *  100 MiB/h — well under the 2026-09-10 leak's observed ~6.1 GB/h, so a
 *  slower repeat of the same class of bug still crosses this rate. */
export const DEFAULT_GROWTH_BYTES_PER_HOUR = 100 * 1024 * 1024;
/** Minimum baseline age before growth is evaluated at all. Below it the
 *  baseline is carried forward so the window accumulates instead of
 *  measuring noise over seconds. */
export const DEFAULT_MIN_WINDOW_MS = 10 * MINUTE;
/** How many pool tags the alert names. Never 0 — a total with no attribution
 *  costs the next reader the whole investigation. */
export const DEFAULT_TOP_N = 3;

export function nonpagedPoolStatePath(): string {
  return join(paHome(), 'nonpaged-pool-watch.json');
}

export interface PoolTagSample {
  tag: string;
  nonpagedBytes: number;
  nonpagedAllocs: number;
  nonpagedFrees: number;
}

export interface PoolSample {
  totalNonpagedBytes: number;
  totalPagedBytes: number;
  tagCount: number;
  top: PoolTagSample[];
}

/**
 * Transition + growth state, durable across ticks (`pa catchup` runs this
 * job in a fresh process every pass, so in-memory state could never see a
 * crossing). Missing or corrupt state reads as "was not alerting" with no
 * baseline — the safe direction: at worst one extra alert after state loss,
 * never a missed one.
 *
 * `topTags` and `totalBytes`/`lastSampleAt` are updated every pass (the
 * latest sample), independent of whether the baseline advances that same
 * pass — this is a judgment call where the spec's prose ("a tag rate is
 * derived from the SAME sample pair as the total") is satisfied literally
 * by "the total" meaning the previous state's own reading, not necessarily
 * the baseline sample; flagged in the WP-D build report for the spec owner
 * to confirm or override.
 */
export interface PoolState {
  lastSampleAt: string;
  totalBytes: number;
  topTags: Record<string, number>;
  baselineAt: string;
  baselineBytes: number;
  wasAlerting: boolean;
  lastAlertedAt?: string;
  wasEarlyAlerting: boolean;
  lastEarlyAlertedAt?: string;
}

async function defaultReadState(): Promise<PoolState | null> {
  try {
    const parsed = JSON.parse(await readFile(nonpagedPoolStatePath(), 'utf8'));
    if (
      typeof parsed?.wasAlerting === 'boolean' &&
      typeof parsed?.totalBytes === 'number' &&
      typeof parsed?.baselineAt === 'string' &&
      typeof parsed?.baselineBytes === 'number' &&
      parsed?.topTags &&
      typeof parsed.topTags === 'object'
    ) {
      return parsed as PoolState;
    }
    return null;
  } catch {
    return null; // missing or corrupt — treat as "was not alerting", no baseline (safe direction)
  }
}

function gb(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

/** Signed MB/h, e.g. "+105.0 MB/h" or "-12.3 MB/h". */
function mbPerHour(bytesPerHour: number): string {
  const mb = bytesPerHour / (1024 * 1024);
  const sign = mb >= 0 ? '+' : '';
  return `${sign}${mb.toFixed(1)} MB/h`;
}

function formatWindow(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 120) return `${minutes} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/**
 * Default sampler: spawns `pa/scripts/pool_tags.py` and parses its one-line
 * JSON contract strictly. A non-zero exit, empty stdout, or unparseable JSON
 * THROWS with the first 200 characters of the output quoted — never degrades
 * to a number (the mirror of the c-disk-floor-watchdog 2026-09-03 live
 * defect, where `Number('')` silently read as "0 bytes free" and fired a
 * real alert).
 */
async function defaultSampleFn(topN: number): Promise<PoolSample> {
  const repoRoot = await repoRootFromModule(__filename);
  const script = join(repoRoot, 'pa', 'scripts', 'pool_tags.py');
  const python = resolvePythonCommand();

  let stdout: string;
  let stderr: string;
  try {
    const result = await execFileAsync(python, [script, '--top', String(topN)], {
      windowsHide: true,
      timeout: 20_000,
      killSignal: 'SIGKILL' as NodeJS.Signals,
      encoding: 'utf8',
    });
    stdout = result.stdout;
    stderr = typeof result.stderr === 'string' ? result.stderr : '';
  } catch (err: any) {
    const stderrText = typeof err?.stderr === 'string' ? err.stderr : '';
    const detail = (stderrText || err?.message || String(err)).slice(0, 200);
    throw new Error(`nonpaged-pool-watch: pool_tags.py failed (exit ${err?.code ?? 'killed/timeout'}): ${detail}`);
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(
      `nonpaged-pool-watch: pool_tags.py produced no output (exit 0, stderr ${JSON.stringify(stderr.slice(0, 200))}, stdout ${stdout.length} chars)`,
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      `nonpaged-pool-watch: unparseable pool_tags.py output (first 200 chars): ${JSON.stringify(trimmed.slice(0, 200))}; stderr ${JSON.stringify(stderr.slice(0, 200))}`,
    );
  }

  if (
    !parsed ||
    parsed.ok !== true ||
    typeof parsed.totalNonpagedBytes !== 'number' ||
    typeof parsed.totalPagedBytes !== 'number' ||
    typeof parsed.tagCount !== 'number' ||
    !Array.isArray(parsed.top)
  ) {
    throw new Error(
      `nonpaged-pool-watch: unexpected pool_tags.py output shape (first 200 chars): ${JSON.stringify(trimmed.slice(0, 200))}; stderr ${JSON.stringify(stderr.slice(0, 200))}`,
    );
  }

  return {
    totalNonpagedBytes: parsed.totalNonpagedBytes,
    totalPagedBytes: parsed.totalPagedBytes,
    tagCount: parsed.tagCount,
    top: parsed.top as PoolTagSample[],
  };
}

/** Injectable dependencies (the maintenance-jobs DI pattern — ESM module
 *  namespaces are read-only, so tests override via deps, never mocks). */
export interface NonpagedPoolDeps {
  sampleFn?: () => Promise<PoolSample>;
  notifyFn?: typeof notifyUser;
  readStateFn?: () => Promise<PoolState | null>;
  writeStateFn?: (state: PoolState) => Promise<void>;
}

export async function runNonpagedPoolWatch(
  ctx: MaintenanceJobContext,
  deps: NonpagedPoolDeps = {},
): Promise<MaintenanceJobResult> {
  const alertBytes = Number(process.env.PA_POOL_NONPAGED_ALERT_BYTES) || DEFAULT_ALERT_BYTES;
  const earlyBytes = Number(process.env.PA_POOL_NONPAGED_EARLY_BYTES) || DEFAULT_EARLY_BYTES;
  const growthPerHour = Number(process.env.PA_POOL_NONPAGED_GROWTH_BYTES_PER_HOUR) || DEFAULT_GROWTH_BYTES_PER_HOUR;
  const minWindowMs = Number(process.env.PA_POOL_NONPAGED_MIN_WINDOW_MS) || DEFAULT_MIN_WINDOW_MS;
  const topN = Number(process.env.PA_POOL_TAGS_TOP_N) || DEFAULT_TOP_N;

  // The platform gate only governs the DEFAULT sampler: an injected sampleFn
  // (every test in this suite) drives generic transition/growth logic that
  // has nothing to do with the host OS, and must behave identically on every
  // CI leg (ubuntu/windows/macos). Only when NO sampleFn is supplied do we
  // check the real host platform — a POSIX deployment must not fail this job
  // forever, and must never spawn the Windows-only script to find that out.
  let sampleFn = deps.sampleFn;
  if (!sampleFn) {
    if (platform() !== 'win32') {
      return { touched: 0, detail: { skipped: 'non-win32' } };
    }
    sampleFn = () => defaultSampleFn(topN);
  }

  const notifyFn = deps.notifyFn ?? notifyUser;
  const readStateFn = deps.readStateFn ?? defaultReadState;
  const writeStateFn =
    deps.writeStateFn ?? ((state: PoolState) => writeJsonAtomic(nonpagedPoolStatePath(), state));

  // Sample. Never degrade on failure — a failed or unparseable sample throws
  // into the AI-098 backoff ladder rather than going silently blind. This
  // shape guard is explicit rather than incidental: a malformed sample
  // (whatever produced it — the default sampler, or an injected test double)
  // must never silently read as "0 bytes, nothing to report" the way
  // `Number('')` once did for c-disk-floor-watchdog.
  const sample = await sampleFn();
  if (!sample || typeof sample.totalNonpagedBytes !== 'number' || !Array.isArray(sample.top)) {
    throw new Error('nonpaged-pool-watch: sampleFn resolved with an invalid PoolSample');
  }

  const prev = await readStateFn();
  const nowIso = new Date(ctx.now).toISOString();
  const totalBytes = sample.totalNonpagedBytes;
  const topTags: Record<string, number> = {};
  for (const t of sample.top) topTags[t.tag] = t.nonpagedBytes;

  let baselineAt: string;
  let baselineBytes: number;
  let growth: number | undefined;
  let growthWindowMs: number | undefined;

  if (prev?.baselineAt === undefined || typeof prev.baselineBytes !== 'number') {
    // No baseline (first run, or state loss): growth UNDEFINED. Only the
    // absolute threshold can fire this pass. Baseline set to this sample.
    baselineAt = nowIso;
    baselineBytes = totalBytes;
  } else if (totalBytes < prev.baselineBytes) {
    // A reboot, or a genuine release: growth is not evaluated, and the
    // baseline resets to this sample immediately — without waiting for the
    // window — so a post-reboot climb is measured from the new floor.
    baselineAt = nowIso;
    baselineBytes = totalBytes;
  } else if (ctx.now - Date.parse(prev.baselineAt) < minWindowMs) {
    // Window too short: growth UNDEFINED, baseline CARRIED FORWARD unchanged
    // so the window accumulates instead of measuring noise over seconds.
    baselineAt = prev.baselineAt;
    baselineBytes = prev.baselineBytes;
  } else {
    growthWindowMs = ctx.now - Date.parse(prev.baselineAt);
    growth = (totalBytes - prev.baselineBytes) / (growthWindowMs / 3_600_000);
    baselineAt = nowIso;
    baselineBytes = totalBytes;
  }

  const wasAlerting = prev?.wasAlerting === true;
  const wasEarlyAlerting = prev?.wasEarlyAlerting === true;
  const mainAlerting = totalBytes >= alertBytes || (growth !== undefined && growth >= growthPerHour);
  const earlyAlerting = totalBytes >= earlyBytes;

  let alerted = false;
  let earlyAlerted = false;
  const buildAlertBody = (firstLine: string): string => {
    const lines: string[] = [];
    lines.push(firstLine);
    lines.push(
      growth !== undefined
        ? `Growth: ${mbPerHour(growth)} over the last ${formatWindow(growthWindowMs!)}`
        : 'growth: no baseline yet',
    );
    // Per-tag rate: derived from THIS sample and the previous state's own
    // topTags/lastSampleAt reading (the "previous state" the spec names) —
    // omitted for a tag not present last time, and also omitted when the
    // elapsed time since that reading is non-positive (state clock skew),
    // so the line never divides by zero or shows a bogus rate.
    for (const [tag, bytes] of Object.entries(topTags)) {
      const prevBytes = prev?.topTags?.[tag];
      let rateText = '';
      if (typeof prevBytes === 'number' && prev) {
        const elapsedMs = ctx.now - Date.parse(prev.lastSampleAt);
        if (elapsedMs > 0) {
          const rate = (bytes - prevBytes) / (elapsedMs / 3_600_000);
          rateText = `  (${mbPerHour(rate)})`;
        }
      }
      lines.push(`${tag}  ${gb(bytes)} GB${rateText}`);
    }
    lines.push(
      'A steadily climbing tag is usually a driver or tracing leak; nonpaged pool cannot be paged out, so it evicts the file cache.',
    );
    return lines.join('\n');
  };
  if (mainAlerting && !wasAlerting) {
    const body = buildAlertBody(`Total: ${gb(totalBytes)} GB (floor ${gb(alertBytes)} GB)`);

    log('warn', 'maintenance', 'nonpaged-pool-watch: nonpaged pool crossed its alert threshold', {
      job: nonpagedPoolWatchJob.name,
      totalBytes,
      alertBytes,
      growth,
    });
    await notifyFn('Nonpaged kernel pool crossed its alert threshold', body, {
      dedupKey: 'nonpaged-pool',
      severity: 'warn',
      escalate: false,
    }).catch(() => {});
    alerted = true;
  } else if (!mainAlerting && earlyAlerting && !wasEarlyAlerting) {
    const body = buildAlertBody(
      `Total: ${gb(totalBytes)} GB (early-warning ${gb(earlyBytes)} GB; floor ${gb(alertBytes)} GB)`,
    );

    log('warn', 'maintenance', 'nonpaged-pool-watch: nonpaged pool crossed its early-warning threshold', {
      job: nonpagedPoolWatchJob.name,
      totalBytes,
      earlyBytes,
      alertBytes,
      growth,
    });
    await notifyFn('Nonpaged kernel pool early warning', body, {
      dedupKey: 'nonpaged-pool-early',
      severity: 'warn',
      escalate: false,
    }).catch(() => {});
    alerted = true;
    earlyAlerted = true;
  }

  const nextState: PoolState = {
    lastSampleAt: nowIso,
    totalBytes,
    topTags,
    baselineAt,
    baselineBytes,
    wasAlerting: mainAlerting,
    wasEarlyAlerting: earlyAlerting,
    ...(alerted ? { lastAlertedAt: nowIso } : prev?.lastAlertedAt ? { lastAlertedAt: prev.lastAlertedAt } : {}),
    ...(earlyAlerted
      ? { lastEarlyAlertedAt: nowIso }
      : prev?.lastEarlyAlertedAt
        ? { lastEarlyAlertedAt: prev.lastEarlyAlertedAt }
        : {}),
  };

  await writeStateFn(nextState).catch((err: any) => {
    // Non-fatal (next tick re-reads; the notify dedup key covers the gap),
    // but never silent — state loss is exactly what the transition gate
    // depends on.
    log('warn', 'maintenance', 'nonpaged-pool-watch: state write failed', {
      job: nonpagedPoolWatchJob.name,
      error: err?.message ?? String(err),
    });
  });

  return {
    touched: alerted ? 1 : 0,
    detail: { totalBytes, alertBytes, earlyBytes, growth, alerting: mainAlerting, wasAlerting, alerted, earlyAlerting, wasEarlyAlerting, earlyAlerted },
  };
}

export const nonpagedPoolWatchJob: MaintenanceJob = {
  name: 'nonpaged-pool-watch',
  host: 'pa',
  everyMs: 15 * MINUTE,
  description:
    'OBSERVE-ONLY: every 15 min reads nonpaged kernel pool and its per-tag attribution through ' +
    "NtQuerySystemInformation(SystemPoolTagInformation); alerts once per crossing on either an absolute " +
    'floor or a growth rate, both env knobs with deployment-convention defaults; names the top pool tags ' +
    'because a total alone does not locate a leak; non-destructive with no retention targets; skips cleanly ' +
    'on non-Windows; a failed or unparseable sample throws into the AI-098 backoff ladder rather than going ' +
    'silently blind. Dated evidence: 2026-09-10, a per-user font-handle loop leaked the NtFC tag at ~6.1 GB/h ' +
    'to 11.3 GB of 15.9 GB RAM over 78 hours with no signal beyond "the machine feels slow", squeezing the ' +
    'file cache to 105 MB and turning every Node.js launch into a cold 5400 rpm HDD read. Cadence rationale: ' +
    'at that rate a 3 GiB floor is crossed from a ~1 GiB baseline inside 20 minutes, so a 15-minute window ' +
    'catches it in one pass.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run(ctx: MaintenanceJobContext): Promise<MaintenanceJobResult> {
    return runNonpagedPoolWatch(ctx);
  },
};
