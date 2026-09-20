import { parseExpression } from 'cron-parser';
import { exec } from 'child_process';
import { promisify } from 'util';
import { platform, tmpdir, homedir } from 'os';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { writeFileSync, readFileSync } from 'fs';
import { writeFile, unlink } from 'fs/promises';
import { listSkills } from './skills.js';
import { getLastSuccessfulRun, getFailureState } from './logger.js';
import { paHome } from './paths.js';
import { repoRootFromModule } from './lib/git-root.js';
import { catchupLoopLockPath, readCatchupLoopHeartbeatStaleMs, DEFAULT_CATCHUP_LOOP_HEARTBEAT_STALE_MS } from './commands/catchup.js';
import { stallRecordsPath } from './lib/stall.js';
import {
  CATCHUP_LAUNCHER_UV_THREADPOOL_SIZE,
  CATCHUP_LOOP_LANES,
  CATCHUP_LOOP_PAGE_FIRST_LINE,
  CATCHUP_LOOP_PAGE_SUBJECT,
  CATCHUP_LOOP_STALLED_DEDUP_KEY,
  catchupLanesDir,
  catchupPageBodyPath,
  catchupStallMarkerPath,
  catchupWatchdogScriptPath,
} from './lib/catchup-contract.js';
import type { Skill, RunMeta, CostTierPeakWindowUtc } from './types.js';

const execAsync = promisify(exec);

export interface OverdueSkill {
  skill: Skill;
  lastRun: RunMeta | null;
  missedAt: Date;
}

// --- cost_tier: off_peak (2026-08-17, audit Tier-1 #8) -----------------------
// z.ai peak = Mon-Fri 06:00-10:00 UTC (11:30-15:30 IST, 2x credits). Periodic
// (non-time-pinned) skills marked cost_tier: off_peak defer during that window;
// they catch up at the next evaluation inside the cheap window (19:30-11:30 IST).
//
// The window primitives moved to lib/peak-window.ts (2026-09-11 — the model
// routing policy consumes them without this module's import chain); re-exported
// here so every existing importer (pa/tests/cost-tier.test.ts, docs) keeps
// resolving from scheduler.
export { DEFAULT_PEAK_WINDOW_UTC, isPeakWindow } from './lib/peak-window.js';
export type { PeakWindowUtc } from './lib/peak-window.js';
import { DEFAULT_PEAK_WINDOW_UTC, isPeakWindow, resolvePeakWindowUtc } from './lib/peak-window.js';
import type { PeakWindowUtc } from './lib/peak-window.js';

/** Log-once-per-day-per-skill deferral marker (catchup is a fresh process each
 *  minute; a module map would re-log every evaluation). Best-effort: failures
 *  to read/write the marker never block scheduling. */
function deferralMarkerPath(): string {
  return join(paHome(), 'cost-tier-deferrals.json');
}

function readDeferralMarkers(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(deferralMarkerPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeDeferralMarker(skillName: string, dateISO: string): void {
  try {
    const markers = readDeferralMarkers();
    markers[skillName] = dateISO;
    writeFileSync(deferralMarkerPath(), JSON.stringify(markers, null, 1), 'utf8');
  } catch {
    // Best-effort only
  }
}

export async function getOverdueSkills(): Promise<OverdueSkill[]> {
  const skills = await listSkills();
  const overdue: OverdueSkill[] = [];
  const now = new Date();

  for (const skill of skills) {
    if (!skill.frontmatter.cron) continue;

    const onMissed = skill.frontmatter.on_missed || 'latest';
    if (onMissed === 'skip') continue;

    const lastRun = await getLastSuccessfulRun(skill.name);

    // If skill has never run, treat it as overdue once (regardless of on_missed mode)
    // to avoid enumerating phantom runs from epoch
    if (!lastRun) {
      try {
        const prevParse = parseExpression(skill.frontmatter.cron, { currentDate: now, tz: 'UTC' });
        const latest = prevParse.prev().toDate();
        overdue.push({ skill, lastRun, missedAt: latest });
      } catch (err: any) {
        console.warn(`Invalid cron expression for '${skill.name}': ${err.message}`);
      }
      continue;
    }

    const lastRunTime = new Date(lastRun.timestamp);

    try {
      const interval = parseExpression(skill.frontmatter.cron, {
        currentDate: lastRunTime, tz: 'UTC',
      });

      // Check if the next expected run after the last run is in the past
      const nextExpected = interval.next().toDate();
      if (nextExpected < now) {
        if (onMissed === 'all') {
          // Find all missed instances starting from the first one after last run
          const reparse = parseExpression(skill.frontmatter.cron, {
            currentDate: nextExpected, tz: 'UTC',
          });
          // Add each missed run, but cap at 10 to prevent excessive runs
          let count = 0;
          overdue.push({ skill, lastRun, missedAt: nextExpected });
          while (count < 9) {
            const next = reparse.next().toDate();
            if (next >= now) break;
            overdue.push({ skill, lastRun, missedAt: next });
            count++;
          }
        } else {
          // 'latest' — find the most recent missed time
          // Use .prev() from now to jump directly to the latest missed occurrence
          // instead of iterating forward from lastRun (which could be millions of iterations)
          const prevParse = parseExpression(skill.frontmatter.cron, {
            currentDate: now, tz: 'UTC',
          });
          const latest = prevParse.prev().toDate();
          overdue.push({ skill, lastRun, missedAt: latest });
        }
      }
    } catch (err: any) {
      console.warn(`Invalid cron expression for '${skill.name}': ${err.message}`);
    }
  }

  return overdue;
}

// ---------------------------------------------------------------------------
// AI-098: consecutive-failure-aware retry backoff. getOverdueSkills() (above)
// is unchanged — a failed run still never resets the overdue clock (AI-024).
// This layer sits ON TOP of that result and decides, per overdue entry,
// whether catchup should retry now, wait, or give up until the skill's own
// cron fires again. Without it, a skill failing every attempt gets relaunched
// on every catchup pass forever (real incident: pii-audit, 2026-07-19/20,
// 24+ timeouts over 34 hours — see the 2026-07-20 pii-audit retry-storm fix plan).
// ---------------------------------------------------------------------------

/** Retry-pacing ladder for consecutive failures. Index = failures-1.
 * failures=1 → immediate retry (transient blips recover fast), 2 → 30m,
 * 3 → 2h, 4 → 8h, ≥PARK_AFTER_CONSECUTIVE_FAILURES → parked until the next
 * natural cron occurrence. */
export const FAILURE_BACKOFF_LADDER_MS = [0, 30 * 60_000, 2 * 3_600_000, 8 * 3_600_000];
export const PARK_AFTER_CONSECUTIVE_FAILURES = 5;

export type BackoffDecision = 'run' | 'defer' | 'park';

export function failureBackoffDecision(args: {
  consecutiveFailures: number;
  lastAttemptAtMs: number | null;
  missedAtMs: number;
  nowMs: number;
}): BackoffDecision {
  const { consecutiveFailures, lastAttemptAtMs, missedAtMs, nowMs } = args;

  if (consecutiveFailures === 0 || lastAttemptAtMs === null) return 'run';

  // A NEW cron occurrence that fired after the last attempt always grants one
  // fresh attempt — this also means skills whose cron is more frequent than
  // their failure cadence (e.g. every-minute reminders) are never throttled
  // below their natural schedule; backoff only suppresses retries WITHIN one
  // missed occurrence, which is exactly the storm class.
  if (missedAtMs > lastAttemptAtMs) return 'run';

  if (consecutiveFailures >= PARK_AFTER_CONSECUTIVE_FAILURES) return 'park';

  const delay = FAILURE_BACKOFF_LADDER_MS[Math.min(consecutiveFailures - 1, FAILURE_BACKOFF_LADDER_MS.length - 1)];
  return nowMs >= lastAttemptAtMs + delay ? 'run' : 'defer';
}

export interface BackoffPartition {
  runnable: OverdueSkill[];
  deferred: Array<{ entry: OverdueSkill; retryAtMs: number; consecutiveFailures: number }>;
  parked: Array<{ entry: OverdueSkill; consecutiveFailures: number; lastAttemptAt: string }>;
}

export async function partitionOverdueByFailureBackoff(
  overdue: OverdueSkill[],
  now: Date = new Date()
): Promise<BackoffPartition> {
  const nowMs = now.getTime();
  const partition: BackoffPartition = { runnable: [], deferred: [], parked: [] };

  // One getFailureState() call per unique skill name — on_missed: 'all' can
  // hold multiple entries for the same skill.
  const stateCache = new Map<string, Awaited<ReturnType<typeof getFailureState>>>();

  for (const entry of overdue) {
    let state = stateCache.get(entry.skill.name);
    if (!state) {
      state = await getFailureState(entry.skill.name);
      stateCache.set(entry.skill.name, state);
    }

    const lastAttemptAtMs = state.lastAttemptAt !== null ? new Date(state.lastAttemptAt).getTime() : null;
    const decision = failureBackoffDecision({
      consecutiveFailures: state.consecutiveFailures,
      lastAttemptAtMs,
      missedAtMs: entry.missedAt.getTime(),
      nowMs,
    });

    if (decision === 'run') {
      partition.runnable.push(entry);
    } else if (decision === 'defer') {
      // lastAttemptAtMs is non-null whenever decision !== 'run' can be reached
      // via the ladder branch (failureBackoffDecision returns 'run' early for
      // consecutiveFailures === 0 || lastAttemptAtMs === null).
      const delay = FAILURE_BACKOFF_LADDER_MS[Math.min(state.consecutiveFailures - 1, FAILURE_BACKOFF_LADDER_MS.length - 1)];
      partition.deferred.push({ entry, retryAtMs: lastAttemptAtMs! + delay, consecutiveFailures: state.consecutiveFailures });
    } else {
      // parked entries only arise when consecutiveFailures > 0 (same reasoning).
      partition.parked.push({ entry, consecutiveFailures: state.consecutiveFailures, lastAttemptAt: state.lastAttemptAt! });
    }
  }

  return partition;
}

// ---------------------------------------------------------------------------
// WPD5: off-peak cost_tier filtering
// Skills with cost_tier: off_peak run only during z.ai off-peak window
// (19:30-11:30 IST). During peak hours (11:30-19:30 IST), they are
// deferred with once-daily logging.
// ---------------------------------------------------------------------------

/**
 * Check if a cron expression is time-pinned (no wildcards in hour/minute fields).
 * A time-pinned cron specifies exact times, e.g., "30 23 * * *" (11:00 PM IST).
 * A periodic cron has wildcards, e.g., "* slash-5 star star star star" (every 5 minutes).
 * @param cron - Cron expression (5 fields)
 * @returns true if cron is time-pinned (hour and minute are both specific numbers)
 */
export function isTimePinnedCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false; // Invalid cron, treat as periodic

  // Minute (field 0) and hour (field 1) must both be specific numbers (no *, */n, ?)
  const minute = parts[0];
  const hour = parts[1];

  // Check if both are pure numbers (no wildcards, ranges, or step values)
  const isSpecificNumber = (field: string) => /^\d+$/.test(field);

  return isSpecificNumber(minute) && isSpecificNumber(hour);
}

/**
 * Check if current time is within off-peak window (19:30-11:30 IST).
 * IST is UTC+5:30, so:
 * - 19:30 IST = 14:00 UTC
 * - 11:30 IST = 06:00 UTC
 *
 * The off-peak window spans from 19:30 IST to 11:30 IST the next day.
 * This means in UTC:
 * - From 14:00 UTC to 24:00 UTC (same day)
 * - From 00:00 UTC to 06:00 UTC (next day)
 *
 * @param now - Current date/time
 * @param window - Peak window configuration (defaults to Mon-Fri 06:00-10:00 UTC)
 * @returns true if within off-peak window
 */
function isOffPeakWindow(now: Date = new Date(), window: PeakWindowUtc = DEFAULT_PEAK_WINDOW_UTC): boolean {
  // The billing truth: z.ai peak = Mon-Fri 06:00-10:00 UTC (11:30-15:30 IST).
  // Everything else — evenings, nights, weekends, AND 15:30-19:30 IST weekdays —
  // is off-peak. (The earlier 14:00/06:00 hour-only form misclassified
  // 15:30-19:30 IST as peak and ignored weekends.)
  return !isPeakWindow(now, window);
}

/**
 * Partition overdue skills by cost_tier and time window.
 * - off_peak skills during peak hours are deferred
 * - time-pinned crons with cost_tier are warned and deferred
 * - anytime skills are always passed through
 *
 * @param overdue - List of overdue skills to filter
 * @param now - Current time for window check
 * @returns Partition with runnable and deferred skills
 */
export async function partitionOverdueByCostTier(
  overdue: OverdueSkill[],
  now: Date = new Date()
): Promise<{ runnable: OverdueSkill[]; deferred: Array<{ entry: OverdueSkill; reason: string }> }> {
  const partition: { runnable: OverdueSkill[]; deferred: Array<{ entry: OverdueSkill; reason: string }> } = {
    runnable: [],
    deferred: [],
  };

  // Load the configured peak window (if any) from config.yaml
  let configuredWindow: CostTierPeakWindowUtc | undefined;
  try {
    const { loadConfig } = await import('./config.js');
    const config = await loadConfig();
    configuredWindow = config.cost_tier?.peak_window_utc;
  } catch {
    // Config missing or invalid — use default window
  }

  const window = resolvePeakWindowUtc(configuredWindow);

  const isInOffPeak = isOffPeakWindow(now, window);

  for (const entry of overdue) {
    const skill = entry.skill;
    const costTier = skill.frontmatter.cost_tier || 'anytime';

    // anytime skills always run
    if (costTier === 'anytime') {
      partition.runnable.push(entry);
      continue;
    }

    // off_peak skill
    if (costTier === 'off_peak') {
      const cron = skill.frontmatter.cron;

      // Check if cron is time-pinned (invalid configuration)
      if (cron && isTimePinnedCron(cron)) {
        console.warn(
          `[cost_tier] Ignoring cost_tier on time-pinned cron for skill '${skill.name}': ${cron}. ` +
              `cost_tier applies only to periodic crons (with wildcards in hour/minute fields).`
        );
        // Treat as anytime (allow it to run)
        partition.runnable.push(entry);
        continue;
      }

      // During peak hours, defer off_peak skills
      if (!isInOffPeak) {
        // Log once per day per skill (catchup is a fresh process each minute —
        // a module map would re-log every pass, so a marker file dedupes).
        const today = now.toISOString().slice(0, 10);
        if (readDeferralMarkers()[skill.name] !== today) {
          console.warn(
            `[cost_tier] Deferring off_peak skill '${skill.name}' during peak hours ` +
              `(z.ai peak: Mon-Fri 11:30-15:30 IST; runs resume after 15:30 IST)`
          );
          writeDeferralMarker(skill.name, today);
        }
        partition.deferred.push({
          entry,
          reason: 'off_peak skill deferred during peak hours (Mon-Fri 11:30-15:30 IST)',
        });
        continue;
      }

      // During off-peak hours, allow to run
      partition.runnable.push(entry);
      continue;
    }

    // Unknown cost_tier value - treat as anytime (fail open)
    partition.runnable.push(entry);
  }

  return partition;
}

/**
 * resolve() is relative to process.cwd() when its input isn't already
 * absolute. Every documented PA_HOME example (docs/CONFIGURATION.md:
 * $tmpdir, a second install's own directory, a container path) is
 * absolute, so a relative PA_HOME is a narrow, undocumented-usage edge
 * case — but if someone DID set one and ran `pa schedules sync` from two
 * different working directories, they'd get two different hashes for what
 * they intended as one install. Failure mode is safe-direction (an extra
 * orphaned task, not a silent collision — the actual bug scheduledTaskName()
 * below exists to prevent), so this is a documented limitation, not a
 * guard: a relative PA_HOME is already an unsupported configuration.
 *
 * Windows paths are case-insensitive and accept both separators; fold both
 * away so two spellings of the same real directory hash identically. POSIX
 * paths are case-sensitive — no folding there.
 */
function canonicalizeForHash(dir: string): string {
  return platform() === 'win32'
    ? resolve(dir).replace(/\\/g, '/').toLowerCase()
    : resolve(dir);
}

/**
 * 2026-07-23: `PA_HOME` is documented (docs/CONFIGURATION.md) as supporting
 * "multi-instance: run two pa installs side-by-side" — but the OS-level
 * scheduler (Windows Task Scheduler task names, POSIX crontab sentinel
 * comments) is a GLOBAL namespace per OS user account, not scoped to any one
 * install. Registering both installs under the same fixed literal name
 * ("PA-Catchup") means the second `pa schedules sync` silently deletes and
 * overwrites the first install's task/cron entry, reporting SUCCESS with no
 * warning either time. Reproduced live: a disposable test clone's `pa
 * schedules sync` overwrote this deployment's real production scheduled
 * tasks. This resolves the collision by deriving the name from PA_HOME.
 *
 * Deliberately NOT a hardcoded check for any specific machine's path: the
 * rule is that PA_HOME resolving to the default `~/.pa` — whether left
 * unset, or explicitly set to that same path — keeps the unchanged legacy
 * name; any OTHER resolved path gets hash-suffixed, unique per path. A real
 * production deployment that never sets PA_HOME (or explicitly sets it to
 * that same default) keeps producing exactly
 * "PA-Catchup"/"PA-Catchup-Reminders" (zero disruption, zero migration),
 * while every other install (testing, a second personal/work instance,
 * containers — the exact scenarios CONFIGURATION.md already documents) gets
 * its own name and can never collide with another. Pure function, no I/O —
 * unit-tested directly, same pattern as resolveWindowsPaPath/resolvePosixPaPath
 * above.
 */
export function scheduledTaskName(baseLabel: string): string {
  // Compare RESOLVED PATHS, not env-var presence: PA_HOME unset is the
  // common case, but if it were ever explicitly exported with a value that
  // happens to equal the default (a future "be explicit" config change,
  // for instance), the unchanged-name guarantee must still hold — checking
  // `!process.env.PA_HOME` alone would miss that and silently start
  // producing a second, differently-named task alongside an orphaned old
  // one under the same real install.
  const canonical = canonicalizeForHash(paHome());
  const defaultCanonical = canonicalizeForHash(join(homedir(), '.pa'));
  if (canonical === defaultCanonical) return baseLabel;
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 8);
  return `${baseLabel}-${hash}`;
}

/** Sentinel comments that anchor PA-managed cron lines on POSIX. Computed at
 * call time (not a module-level constant) so each call reflects whatever
 * PA_HOME is set to right now — tests can set process.env.PA_HOME per case
 * without needing to re-import the module. */
/** Exported (2026-09-10 launch-cadence wave): syncSchedulesPosix() uses this
 *  both to remove the legacy reminders block on migration and, unchanged, as
 *  listSchedules()'s filter. */
export function cronSentinelReminders(): string {
  return `# ${scheduledTaskName('PA-Catchup-Reminders')} (managed by pa schedules sync)`;
}
function cronSentinelDefault(): string {
  return `# ${scheduledTaskName('PA-Catchup')} (managed by pa schedules sync)`;
}

export interface PaPathResolution {
  ok: boolean;
  paPath: string;
  errorMessage?: string;
}

const PA_NOT_FOUND_MESSAGE =
  'pa is not on PATH — run "npm install -g ." inside pa/ then re-run "pa schedules sync".';

/**
 * Resolves the pa executable path from `where pa`'s stdout (Windows),
 * applying the .cmd-wrapper preference and the shell-metacharacter safety
 * check. `whereStdout` is null when the `where pa` command itself failed
 * (pa not found on PATH) — this used to silently fall back to a bare 'pa',
 * registering a scheduled task that could never actually run (a silent-
 * failure machine running every minute). Now fails loud instead: caller
 * must check `.ok` and register nothing when false (D4).
 *
 * Pure function so this is unit-testable without mocking child_process.exec.
 */
export function resolveWindowsPaPath(whereStdout: string | null): PaPathResolution {
  if (whereStdout === null) {
    return { ok: false, paPath: '', errorMessage: PA_NOT_FOUND_MESSAGE };
  }
  const candidates = whereStdout.trim().split('\n').map((p) => p.trim()).filter(Boolean);
  const paPath = candidates.find((p) => p.toLowerCase().endsWith('.cmd')) ?? candidates[0];
  if (!paPath) {
    return { ok: false, paPath: '', errorMessage: PA_NOT_FOUND_MESSAGE };
  }
  if (/[&|<>^%!]/.test(paPath)) {
    return {
      ok: false,
      paPath: '',
      errorMessage: `pa path contains unsafe characters: ${paPath}. Install pa to a path without special characters (& | < > ^ % !).`,
    };
  }
  return { ok: true, paPath };
}

/** Same idea as resolveWindowsPaPath, for POSIX `which pa` output (D4). */
export function resolvePosixPaPath(whichStdout: string | null): PaPathResolution {
  if (whichStdout === null) {
    return { ok: false, paPath: '', errorMessage: PA_NOT_FOUND_MESSAGE };
  }
  const paPath = whichStdout.trim();
  if (!paPath) {
    return { ok: false, paPath: '', errorMessage: PA_NOT_FOUND_MESSAGE };
  }
  if (/[;&|<>`$'"\\]/.test(paPath)) {
    return {
      ok: false,
      paPath: '',
      errorMessage: `pa path contains unsafe characters: ${paPath}. Install pa to a path without special characters.`,
    };
  }
  return { ok: true, paPath };
}

export async function syncSchedules(): Promise<void> {
  const ok = platform() === 'win32'
    ? await syncSchedulesWindows()
    : await syncSchedulesPosix();

  // D4 fail-loud already printed its own error and set exitCode — nothing
  // was registered, so don't follow it with a "Skills with schedules"
  // listing that could read as if the sync partially succeeded.
  if (!ok) return;

  // Show scheduled skills (shared by both paths)
  const skills = await listSkills();
  const scheduled = skills.filter((s) => s.frontmatter.cron);
  if (scheduled.length > 0) {
    console.log('\nSkills with schedules (evaluated by catchup):');
    for (const s of scheduled) {
      console.log(`  ${s.name}: ${s.frontmatter.cron} (topic: ${s.frontmatter.topic || 'default'})`);
    }
  }
}

/** R-A (2026-09-17): env var both launchers read at run time from their own
 *  environment (never secrets.env) - seconds to wait for a killed loop's PID
 *  to exit before relaunching anyway. Whole seconds 1-9999; else the default. */
export const CATCHUP_KILL_EXIT_WAIT_ENV = 'PA_CATCHUP_KILL_EXIT_WAIT_S';
export const DEFAULT_CATCHUP_KILL_EXIT_WAIT_SECS = 120;
/** R-B (2026-09-17): the page a launcher sends when the recorded PID now runs
 *  another command line - the loop died without its clean shutdown. */
export const CATCHUP_LOOP_PID_REUSED_DEDUP_KEY = 'catchup-loop-pid-reused';
export const CATCHUP_LOOP_PID_REUSED_CAUSE = 'catchup loop was not running (recorded PID now belongs to another process); relaunched';

export interface CatchupWatchdogPaths {
  lockPath: string;
  lanesDir: string;
  stallMarkerPath: string;
  stallRecordsPath: string;
  pageBodyPath: string;
}

/** Paths baked into both launchers at sync time (a scheduler launch has no useful environment). */
export function catchupWatchdogPaths(): CatchupWatchdogPaths {
  return {
    lockPath: catchupLoopLockPath(),
    lanesDir: catchupLanesDir(),
    stallMarkerPath: catchupStallMarkerPath(),
    stallRecordsPath: stallRecordsPath(),
    pageBodyPath: catchupPageBodyPath(),
  };
}

function assertLaneNames(lanes: readonly string[]): void {
  for (const lane of lanes) {
    if (!/^[a-z][a-z0-9-]*$/.test(lane)) throw new Error(`invalid catchup lane name: ${lane}`);
  }
}

/** Pure, unit-tested (same pattern as resolveWindowsPaPath/resolvePosixPaPath).
 *  The CurrentDirectory line is load-bearing: without it wscript inherits Task
 *  Scheduler's cwd (C:\Windows\System32) and every cwd-relative path inside
 *  `pa catchup` resolves there. The bot's launcher had this exact bug fixed in
 *  303f439; the generator never got the fix (alerts-week-review §5.2).
 *
 *  2026-09-16 lane-wedge work: (1) the gate reads the heartbeat AND every lane
 *  progress file — a live PID whose lane hasn't ticked is wedged even though
 *  the loop-wide heartbeat still looks fresh. (2) The launch is UNAWAITED
 *  because an awaited launch keeps the launcher alive for the loop's whole
 *  life, and the task's one-instance policy then refuses every later
 *  trigger. (3) The only awaited children are the tasklist gate and the
 *  taskkill of a proven PID. (4) It pages through a fresh `pa notify` with a
 *  cause-only body. (5) Before any kill it confirms the PID's command line
 *  is the loop's, because a dead loop's PID can be reused (C17).
 *
 *  2026-09-17 (R-A/R-B): (6) after the kill it waits up to
 *  `PA_CATCHUP_KILL_EXIT_WAIT_S` seconds (default 120), polling every 2 s.
 *  When the PID outlives the wait it relaunches anyway and pages the
 *  did-not-exit cause. (7) A recorded PID that now runs another command
 *  line is never killed; the launcher appends a `pid-reused` record and
 *  pages once under `catchup-loop-pid-reused` at `warn`. */
export function buildCatchupWatchdogVbs(
  paPathCmd: string,
  args: string,
  repoRoot: string,
  paths: CatchupWatchdogPaths,
  heartbeatStaleMs: number = DEFAULT_CATCHUP_LOOP_HEARTBEAT_STALE_MS,
  lanes: readonly string[] = CATCHUP_LOOP_LANES,
): string {
  assertLaneNames(lanes);
  const rootVbs = repoRoot.replace(/"/g, '""');
  const lockVbs = paths.lockPath.replace(/"/g, '""');
  const lanesDirVbs = paths.lanesDir.replace(/"/g, '""');
  const markerVbs = paths.stallMarkerPath.replace(/"/g, '""');
  const recordsVbs = paths.stallRecordsPath.replace(/"/g, '""');
  const bodyVbs = paths.pageBodyPath.replace(/"/g, '""');
  const staleSecs = Math.max(1, Math.round(heartbeatStaleMs / 1000));
  const laneList = lanes.map((l) => `"${l}"`).join(', ');
  const lines = [
    `Set WshShell = CreateObject("WScript.Shell")`,
    `Set fso = CreateObject("Scripting.FileSystemObject")`,
    `WshShell.CurrentDirectory = "${rootVbs}"`,
    `lockPath = "${lockVbs}"`,
    `lanesDir = "${lanesDirVbs}"`,
    `laneNames = Array(${laneList})`,
    `stallMarkerPath = "${markerVbs}"`,
    `stallRecordsPath = "${recordsVbs}"`,
    `pageBodyPath = "${bodyVbs}"`,
    `heartbeatStaleSecs = ${staleSecs}`,
    `Set procEnv = WshShell.Environment("Process")`,
    `If procEnv("UV_THREADPOOL_SIZE") = "" Then procEnv("UV_THREADPOOL_SIZE") = "${CATCHUP_LAUNCHER_UV_THREADPOOL_SIZE}"`,
    `killExitWaitSecs = ReadWaitSecs(procEnv("${CATCHUP_KILL_EXIT_WAIT_ENV}"), ${DEFAULT_CATCHUP_KILL_EXIT_WAIT_SECS})`,
    `cause = ""`,
    `pageSeverity = "error"`,
    `pageDedupKey = "${CATCHUP_LOOP_STALLED_DEDUP_KEY}"`,
    `pid = ReadPidFile(lockPath)`,
    `If PidIsLiveNode(pid) Then`,
    `  cause = StaleCause(lockPath, lanesDir, laneNames, heartbeatStaleSecs)`,
    `  If cause = "" Then WScript.Quit 0`,
    `  If CommandLineIsOtherProcess(pid) Then`,
    `    cause = "${CATCHUP_LOOP_PID_REUSED_CAUSE}"`,
    `    marker = ConsumeStallMarker(stallMarkerPath)`,
    `    If marker <> "" Then cause = cause & "; " & marker`,
    `    AppendLauncherRecord stallRecordsPath, pid, "pid-reused", cause`,
    `    pageSeverity = "warn"`,
    `    pageDedupKey = "${CATCHUP_LOOP_PID_REUSED_DEDUP_KEY}"`,
    `  Else`,
    `    marker = ConsumeStallMarker(stallMarkerPath)`,
    `    If marker <> "" Then cause = cause & "; " & marker`,
    `    AppendLauncherRecord stallRecordsPath, pid, "lane-progress", cause`,
    `    WshShell.Run "cmd /c taskkill /F /PID " & pid, 0, True`,
    `    If Not LoopExitedWithin(pid, killExitWaitSecs) Then cause = cause & "; killed catchup loop did not exit within " & killExitWaitSecs & " s; relaunched anyway - a stale write may land"`,
    `  End If`,
    `Else`,
    `  cause = ConsumeStallMarker(stallMarkerPath)`,
    `End If`,
    `WshShell.Run "cmd /c """"${paPathCmd}"" ${args}""", 0, False`,
    `If cause <> "" Then`,
    `  WriteText pageBodyPath, "${CATCHUP_LOOP_PAGE_FIRST_LINE}" & vbCrLf & "Cause: " & cause`,
    `  WshShell.Run "cmd /c """"${paPathCmd}"" notify --subject ""${CATCHUP_LOOP_PAGE_SUBJECT}"" --body-file ""${bodyVbs}"" --dedup-key " & pageDedupKey & " --severity " & pageSeverity & """", 0, False`,
    `End If`,
    ``,
    `' Reads the loop's PID from its lock file; 0 when missing or unparseable.`,
    `Function ReadPidFile(path)`,
    `  Dim text`,
    `  ReadPidFile = 0`,
    `  If Not fso.FileExists(path) Then Exit Function`,
    `  On Error Resume Next`,
    `  text = Trim(fso.OpenTextFile(path, 1).ReadAll())`,
    `  If Err.Number <> 0 Then Err.Clear : Exit Function`,
    `  On Error GoTo 0`,
    `  If IsNumeric(text) Then ReadPidFile = CLng(text)`,
    `End Function`,
    ``,
    `' Seconds to wait for a killed loop to exit: the environment value when it is a`,
    `' whole number from 1 to 9999, otherwise the default baked in at sync time.`,
    `Function ReadWaitSecs(text, defaultSecs)`,
    `  Dim re`,
    `  ReadWaitSecs = defaultSecs`,
    `  Set re = New RegExp`,
    `  re.Pattern = "^[1-9][0-9]{0,3}$"`,
    `  If re.Test(text) Then ReadWaitSecs = CLng(text)`,
    `End Function`,
    ``,
    `' Liveness gate: true only when a live node.exe holds this PID. Anything else -`,
    `' missing lock file, unparseable PID, dead process, a non-node process that`,
    `' reused the PID, an unexpected tasklist result - reads as NOT live, so the`,
    `' worst case is one wasted launch that exits on the real lock. Never the`,
    `' reverse: a false "alive" would leave the service down forever.`,
    `Function PidIsLiveNode(pid)`,
    `  Dim cmdText`,
    `  PidIsLiveNode = False`,
    `  If Not IsNumeric(pid) Then Exit Function`,
    `  If CDbl(pid) <= 0 Then Exit Function`,
    `  cmdText = "cmd /c tasklist /NH /FI ""PID eq " & CLng(pid) & """ /FI ""IMAGENAME eq node.exe"" | find /I ""node.exe"" >nul"`,
    `  PidIsLiveNode = (WshShell.Run(cmdText, 0, True) = 0)`,
    `End Function`,
    ``,
    `' True only when WMI positively reports a command line for this PID that is not`,
    `' the catchup loop's - the dead loop's PID was reused by another process, which`,
    `' must never be killed. Any WMI error or an empty command line reads as False,`,
    `' so the worst case stays one extra kill and relaunch, never a silent skip.`,
    `Function CommandLineIsOtherProcess(pid)`,
    `  Dim procs, proc, cmdLine`,
    `  CommandLineIsOtherProcess = False`,
    `  cmdLine = ""`,
    `  On Error Resume Next`,
    `  Set procs = GetObject("winmgmts:\\\\.\\root\\cimv2").ExecQuery("SELECT CommandLine FROM Win32_Process WHERE ProcessId = " & CLng(pid))`,
    `  If Err.Number <> 0 Then Err.Clear : Exit Function`,
    `  For Each proc In procs`,
    `    cmdLine = proc.CommandLine`,
    `  Next`,
    `  If Err.Number <> 0 Then Err.Clear : Exit Function`,
    `  On Error GoTo 0`,
    `  If IsNull(cmdLine) Then Exit Function`,
    `  If Len(cmdLine) = 0 Then Exit Function`,
    `  CommandLineIsOtherProcess = Not (InStr(1, cmdLine, "catchup", vbTextCompare) > 0 And InStr(1, cmdLine, "--loop", vbTextCompare) > 0)`,
    `End Function`,
    ``,
    `' Polls every 2 s until the killed loop is gone: its PID is no longer a live`,
    `' node.exe, or it now runs another command line. False when it is still the`,
    `' loop after waitSecs. It polls before sleeping, so a loop that has already`,
    `' exited costs no wait. Timer counts seconds since midnight, hence the wrap.`,
    `Function LoopExitedWithin(pid, waitSecs)`,
    `  Dim started, elapsed`,
    `  LoopExitedWithin = True`,
    `  started = Timer`,
    `  Do While PidIsLiveNode(pid)`,
    `    If CommandLineIsOtherProcess(pid) Then Exit Function`,
    `    elapsed = Timer - started`,
    `    If elapsed < 0 Then elapsed = elapsed + 86400`,
    `    If elapsed >= waitSecs Then`,
    `      LoopExitedWithin = False`,
    `      Exit Function`,
    `    End If`,
    `    WScript.Sleep 2000`,
    `  Loop`,
    `End Function`,
    ``,
    `' Seconds since the file was last written. A missing file or any FSO error`,
    `' reads as infinitely old, so the worst case is one extra kill and relaunch.`,
    `Function FileAgeSecs(path)`,
    `  Dim modified`,
    `  FileAgeSecs = 2147483647`,
    `  If Not fso.FileExists(path) Then Exit Function`,
    `  On Error Resume Next`,
    `  modified = fso.GetFile(path).DateLastModified`,
    `  If Err.Number <> 0 Then Err.Clear : Exit Function`,
    `  On Error GoTo 0`,
    `  FileAgeSecs = DateDiff("s", modified, Now())`,
    `End Function`,
    ``,
    `' First line of a small text file, trimmed; empty on any error.`,
    `Function ReadFirstLine(path)`,
    `  Dim text`,
    `  ReadFirstLine = ""`,
    `  If Not fso.FileExists(path) Then Exit Function`,
    `  On Error Resume Next`,
    `  text = fso.OpenTextFile(path, 1).ReadAll()`,
    `  If Err.Number <> 0 Then Err.Clear : Exit Function`,
    `  On Error GoTo 0`,
    `  text = Replace(text, vbCr, "")`,
    `  If InStr(text, vbLf) > 0 Then text = Left(text, InStr(text, vbLf) - 1)`,
    `  ReadFirstLine = Trim(text)`,
    `End Function`,
    ``,
    `' Empty when the heartbeat and every lane progress file are fresh; otherwise`,
    `' names the first stale file in lane order, with that lane's last breadcrumb.`,
    `Function StaleCause(lock, dir, lanes, staleSecs)`,
    `  Dim lane, laneFile`,
    `  StaleCause = ""`,
    `  If FileAgeSecs(lock) > staleSecs Then`,
    `    StaleCause = "heartbeat stale"`,
    `    Exit Function`,
    `  End If`,
    `  For Each lane In lanes`,
    `    laneFile = dir & "\\" & lane`,
    `    If FileAgeSecs(laneFile) > staleSecs Then`,
    `      StaleCause = "lane " & lane & " stale" & CrumbSuffix(ReadFirstLine(laneFile))`,
    `      Exit Function`,
    `    End If`,
    `  Next`,
    `End Function`,
    ``,
    `' " at <phase>[: <detail>]" from a "<ts>|<lane>|<phase>|<detail>" breadcrumb.`,
    `Function CrumbSuffix(crumb)`,
    `  Dim parts`,
    `  CrumbSuffix = ""`,
    `  parts = Split(crumb, "|")`,
    `  If UBound(parts) < 2 Then Exit Function`,
    `  CrumbSuffix = " at " & parts(2)`,
    `  If UBound(parts) >= 3 Then`,
    `    If Len(parts(3)) > 0 Then CrumbSuffix = CrumbSuffix & ": " & parts(3)`,
    `  End If`,
    `End Function`,
    ``,
    `' Reads and deletes the loop's store-stall marker; empty when absent.`,
    `Function ConsumeStallMarker(path)`,
    `  ConsumeStallMarker = ""`,
    `  If Not fso.FileExists(path) Then Exit Function`,
    `  ConsumeStallMarker = ReadFirstLine(path)`,
    `  If ConsumeStallMarker = "" Then ConsumeStallMarker = "store stall"`,
    `  On Error Resume Next`,
    `  fso.DeleteFile path, True`,
    `  Err.Clear`,
    `  On Error GoTo 0`,
    `End Function`,
    ``,
    `' Appends one JSON line of launcher evidence; best-effort.`,
    `Sub AppendLauncherRecord(path, pid, store, cause)`,
    `  Dim f`,
    `  On Error Resume Next`,
    `  Set f = fso.OpenTextFile(path, 8, True)`,
    `  If Err.Number <> 0 Then Err.Clear : Exit Sub`,
    `  f.WriteLine "{""ts"":""" & IsoNow() & """,""pid"":" & CLng(pid) & ",""host"":""launcher"",""store"":""" & store & """,""cause"":""" & JsonSafe(cause) & """}"`,
    `  f.Close`,
    `  Err.Clear`,
    `  On Error GoTo 0`,
    `End Sub`,
    ``,
    `' Escapes backslash, then double quote, for a JSON string value.`,
    `Function JsonSafe(text)`,
    `  JsonSafe = Replace(Replace(text, "\\", "\\\\"), """", "\\""")`,
    `End Function`,
    ``,
    `' Local time as yyyy-mm-ddThh:nn:ss (no zone suffix).`,
    `Function IsoNow()`,
    `  Dim t`,
    `  t = Now()`,
    `  IsoNow = Year(t) & "-" & Right("0" & Month(t), 2) & "-" & Right("0" & Day(t), 2) & "T" & Right("0" & Hour(t), 2) & ":" & Right("0" & Minute(t), 2) & ":" & Right("0" & Second(t), 2)`,
    `End Function`,
    ``,
    `' Overwrites a small text file; best-effort.`,
    `Sub WriteText(path, text)`,
    `  Dim f`,
    `  On Error Resume Next`,
    `  Set f = fso.CreateTextFile(path, True)`,
    `  If Err.Number <> 0 Then Err.Clear : Exit Sub`,
    `  f.Write text`,
    `  f.Close`,
    `  Err.Clear`,
    `  On Error GoTo 0`,
    `End Sub`,
  ];
  return lines.join('\n') + '\n';
}

export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Pure. POSIX twin of buildCatchupWatchdogVbs; produces the same
 *  lane-progress + kill-exit-wait + PID-reuse behaviour via `sh`, `ps`,
 *  `find` and `kill`. Unit-tested directly, same pattern as
 *  resolveWindowsPaPath/resolvePosixPaPath above. */
export function buildCatchupWatchdogShScript(
  paPath: string,
  paths: CatchupWatchdogPaths,
  heartbeatStaleMinutes: number,
  lanes: readonly string[] = CATCHUP_LOOP_LANES,
): string {
  assertLaneNames(lanes);
  const lines = [
    `#!/bin/sh`,
    `# Generated by pa schedules sync; edits are overwritten on the next sync.`,
    `L=${shSingleQuote(paths.lockPath)}`,
    `D=${shSingleQuote(paths.lanesDir)}`,
    `M=${shSingleQuote(paths.stallMarkerPath)}`,
    `R=${shSingleQuote(paths.stallRecordsPath)}`,
    `B=${shSingleQuote(paths.pageBodyPath)}`,
    `PA=${shSingleQuote(paPath)}`,
    `N=${heartbeatStaleMinutes}`,
    `W=$${CATCHUP_KILL_EXIT_WAIT_ENV}`,
    `case "$W" in`,
    `  ''|*[!0-9]*|0*|?????*) W=${DEFAULT_CATCHUP_KILL_EXIT_WAIT_SECS} ;;`,
    `esac`,
    `: "\${UV_THREADPOOL_SIZE:=${CATCHUP_LAUNCHER_UV_THREADPOOL_SIZE}}"`,
    `export UV_THREADPOOL_SIZE`,
    ``,
    `# Appends "; <marker>" to C and deletes the loop's store-stall marker, if any.`,
    `append_marker() {`,
    `  if [ -f "$M" ]; then`,
    `    MK=$(head -n 1 "$M" 2>/dev/null)`,
    `    rm -f "$M"`,
    `    C="$C; \${MK:-store stall}"`,
    `  fi`,
    `}`,
    ``,
    `# Appends one JSON line of launcher evidence for PID $1 with store label $2.`,
    `record() {`,
    `  J=$(printf '%s' "$C" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')`,
    `  printf '{"ts":"%s","pid":%s,"host":"launcher","store":"%s","cause":"%s"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$J" >> "$R"`,
    `}`,
    ``,
    `# True while PID $1 is still the catchup loop. A zombie, or a PID that now runs`,
    `# another command line, reads as exited; when ps reports nothing, kill -0 decides.`,
    `loop_alive() {`,
    `  Z=$(ps -p "$1" -o stat= 2>/dev/null)`,
    `  if [ -z "$Z" ]; then`,
    `    kill -0 "$1" 2>/dev/null && return 0`,
    `    return 1`,
    `  fi`,
    `  case "$Z" in`,
    `    *Z*) return 1 ;;`,
    `  esac`,
    `  case "$(ps -p "$1" -o args= 2>/dev/null)" in`,
    `    ''|*catchup*--loop*) return 0 ;;`,
    `  esac`,
    `  return 1`,
    `}`,
    ``,
    `C=`,
    `O=`,
    `V=error`,
    `K=${CATCHUP_LOOP_STALLED_DEDUP_KEY}`,
    `P=$(cat "$L" 2>/dev/null)`,
    `if [ -n "$P" ]; then`,
    `  A=$(ps -p "$P" -o args= 2>/dev/null)`,
    `  case "$A" in`,
    `    ''|*catchup*--loop*) ;;`,
    `    *) O=$P; P= ;;`,
    `  esac`,
    `fi`,
    `if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then`,
    `  if [ -n "$(find "$L" -mmin +"$N" 2>/dev/null)" ]; then`,
    `    C='heartbeat stale'`,
    `  else`,
    `    for lane in ${lanes.join(' ')}; do`,
    `      f="$D/$lane"`,
    `      if [ ! -f "$f" ] || [ -n "$(find "$f" -mmin +"$N" 2>/dev/null)" ]; then`,
    `        S=$(awk -F'|' 'NR==1 && NF>=3 { s=" at " $3; if (NF>=4 && $4 != "") s=s ": " $4; printf "%s", s }' "$f" 2>/dev/null)`,
    `        C="lane $lane stale$S"`,
    `        break`,
    `      fi`,
    `    done`,
    `  fi`,
    `  [ -z "$C" ] && exit 0`,
    `  append_marker`,
    `  record "$P" lane-progress`,
    `  kill -9 "$P" 2>/dev/null`,
    `  T=0`,
    `  while loop_alive "$P"; do`,
    `    if [ "$T" -ge "$W" ]; then`,
    `      C="$C; killed catchup loop did not exit within $W s; relaunched anyway - a stale write may land"`,
    `      break`,
    `    fi`,
    `    sleep 2`,
    `    T=$((T + 2))`,
    `  done`,
    `elif [ -n "$O" ]; then`,
    `  C='${CATCHUP_LOOP_PID_REUSED_CAUSE}'`,
    `  append_marker`,
    `  record "$O" pid-reused`,
    `  V=warn`,
    `  K=${CATCHUP_LOOP_PID_REUSED_DEDUP_KEY}`,
    `elif [ -f "$M" ]; then`,
    `  MK=$(head -n 1 "$M" 2>/dev/null)`,
    `  rm -f "$M"`,
    `  C="\${MK:-store stall}"`,
    `fi`,
    `if [ -n "$C" ]; then`,
    `  printf '%s\\nCause: %s\\n' '${CATCHUP_LOOP_PAGE_FIRST_LINE}' "$C" > "$B"`,
    `  "$PA" notify --subject '${CATCHUP_LOOP_PAGE_SUBJECT}' --body-file "$B" --dedup-key "$K" --severity "$V" >/dev/null 2>&1 &`,
    `fi`,
    `exec "$PA" catchup --loop`,
  ];
  return lines.join('\n') + '\n';
}

export function buildCatchupWatchdogCronLine(scriptPath: string): string {
  return `* * * * * /bin/sh ${shSingleQuote(scriptPath)}`;
}

export type WatchdogArtifact =
  | { ok: true; platform: 'win32'; path: string; text: string }
  | { ok: true; platform: 'posix'; path: string; text: string; cronLine: string }
  | { ok: false; errorMessage: string };

/** Exactly what `pa schedules sync` writes on this platform — also what
 *  `pa schedules list` compares the on-disk launcher against (a build never
 *  deploys the launcher; only sync does). */
export async function expectedCatchupWatchdogArtifact(): Promise<WatchdogArtifact> {
  const paths = catchupWatchdogPaths();
  if (platform() === 'win32') {
    let whereStdout: string | null;
    try {
      whereStdout = (await execAsync('where pa', {})).stdout;
    } catch {
      whereStdout = null;
    }
    const resolution = resolveWindowsPaPath(whereStdout);
    if (!resolution.ok) return { ok: false, errorMessage: resolution.errorMessage ?? PA_NOT_FOUND_MESSAGE };
    const repoRoot = await repoRootFromModule(__filename);
    return {
      ok: true,
      platform: 'win32',
      path: join(paHome(), 'run-catchup-hidden.vbs'),
      text: buildCatchupWatchdogVbs(resolution.paPath.replace(/"/g, '""'), 'catchup --loop', repoRoot, paths, readCatchupLoopHeartbeatStaleMs()),
    };
  }
  let whichStdout: string | null;
  try {
    whichStdout = (await execAsync('which pa')).stdout;
  } catch {
    whichStdout = null;
  }
  const resolution = resolvePosixPaPath(whichStdout);
  if (!resolution.ok) return { ok: false, errorMessage: resolution.errorMessage ?? PA_NOT_FOUND_MESSAGE };
  const scriptPath = catchupWatchdogScriptPath();
  if (/[%\r\n]/.test(scriptPath)) {
    return { ok: false, errorMessage: `the watchdog script path contains a character cron cannot carry (% or a line break): ${scriptPath}` };
  }
  const minutes = Math.max(1, Math.round(readCatchupLoopHeartbeatStaleMs() / 60_000));
  return {
    ok: true,
    platform: 'posix',
    path: scriptPath,
    text: buildCatchupWatchdogShScript(resolution.paPath, paths, minutes),
    cronLine: buildCatchupWatchdogCronLine(scriptPath),
  };
}

export type LauncherDrift = 'in-sync' | 'out-of-sync' | 'missing';

export function launcherDrift(onDisk: string | null, expected: string): LauncherDrift {
  if (onDisk === null) return 'missing';
  return onDisk === expected ? 'in-sync' : 'out-of-sync';
}

export function formatLauncherDriftLine(path: string, drift: LauncherDrift): string {
  if (drift === 'in-sync') return `Launcher ${path}: in sync with this build`;
  if (drift === 'out-of-sync') return `Launcher ${path}: OUT OF SYNC with this build — run \`pa schedules sync\``;
  return `Launcher ${path}: MISSING — run \`pa schedules sync\``;
}

/**
 * 2026-09-10 launch-cadence wave: registers ONE watchdog task over the
 * long-lived `pa catchup --loop`. 2026-09-16 lane-wedge work: retirement of
 * the legacy `PA-Catchup-Reminders` task is proof-gated (see
 * docs/catchup-watchdog.md) — this function never disables or deletes it.
 */
async function syncSchedulesWindows(): Promise<boolean> {
  const artifact = await expectedCatchupWatchdogArtifact();
  if (!artifact.ok || artifact.platform !== 'win32') {
    console.error(`Error: ${artifact.ok ? 'unexpected platform artifact' : artifact.errorMessage}`);
    process.exitCode = 1;
    return false;
  }
  const vbsPath = artifact.path;
  writeFileSync(vbsPath, artifact.text, 'utf8');

  const registerTask = async (name: string, path: string): Promise<boolean> => {
    try {
      await execAsync(`schtasks /delete /tn "${name}" /f`).catch(() => {});
      const { stdout } = await execAsync(`schtasks /create /tn "${name}" /tr "wscript.exe \\"${path}\\"" /sc minute /mo 1 /f`);
      console.log(`[+] Registered '${name}': ${stdout.trim()}`);
      return true;
    } catch (err: any) {
      console.error(`[-] Failed to register '${name}': ${err.message}`);
      return false;
    }
  };

  const taskExists = async (name: string): Promise<boolean> => {
    try {
      await execAsync(`schtasks /query /tn "${name}"`);
      return true;
    } catch {
      return false;
    }
  };

  const taskName = scheduledTaskName('PA-Catchup');
  const registered = await registerTask(taskName, vbsPath);
  if (!registered) {
    console.error(`Error: failed to register '${taskName}'. Nothing was retired.`);
    process.exitCode = 1;
    return false;
  }

  const verified = await taskExists(taskName);
  if (!verified) {
    console.error(`Error: '${taskName}' did not verify after registration — leaving the existing tasks in place. Nothing was retired.`);
    process.exitCode = 1;
    return false;
  }

  // Retirement of the legacy reminders task is proof-gated (2026-09-16): sync
  // never disables or deletes it. See docs/catchup-watchdog.md.
  const remindersName = scheduledTaskName('PA-Catchup-Reminders');
  if (await taskExists(remindersName)) {
    console.log(`[!] Left '${remindersName}' untouched: retire it only through docs/catchup-watchdog.md, "Retiring the legacy reminders task".`);
  }

  return true;
}

async function syncSchedulesPosix(): Promise<boolean> {
  const artifact = await expectedCatchupWatchdogArtifact();
  if (!artifact.ok || artifact.platform !== 'posix') {
    console.error(`Error: ${artifact.ok ? 'unexpected platform artifact' : artifact.errorMessage}`);
    process.exitCode = 1;
    return false;
  }
  writeFileSync(artifact.path, artifact.text, { encoding: 'utf8', mode: 0o755 });

  // Read existing crontab (empty string if none set)
  let existing = '';
  try {
    const { stdout } = await execAsync('crontab -l');
    existing = stdout;
  } catch {
    // No crontab yet — start fresh
  }

  const hasLegacyReminders = existing.includes(cronSentinelReminders());
  let updated = existing;

  // Single managed line: the POSIX twin of the Windows launcher. Retirement
  // of the legacy reminders sentinel is proof-gated (2026-09-16) — see
  // docs/catchup-watchdog.md.
  const cronLine = artifact.cronLine;
  const sentinel = cronSentinelDefault();
  const escapedSentinel = sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escapedSentinel}\\n[^\\n]*\\n?`, 'g');
  const block = `${sentinel}\n${cronLine}\n`;
  if (pattern.test(updated)) {
    updated = updated.replace(pattern, block);
  } else {
    if (!updated.endsWith('\n') && updated.length > 0) updated += '\n';
    updated += block;
  }

  // Write back via `crontab -`
  const tmpPath = join(tmpdir(), `pa-crontab-${process.pid}.tmp`);
  try {
    await writeFile(tmpPath, updated, 'utf8');
    try {
      await execAsync(`crontab "${tmpPath}"`);
    } catch (err: any) {
      const notFound = err.code === 'ENOENT' || String(err.stderr ?? '').toLowerCase().includes('not found');
      if (notFound) {
        throw new Error(
          `pa schedules sync: crontab not found on this system. ` +
          `To add scheduling support, implement a new branch in pa/src/scheduler.ts:syncSchedules() ` +
          `that registers "pa catchup" on your platform's scheduler ` +
          `(systemd timers, fcron, launchd, Task Scheduler, etc.). ` +
          `See syncSchedulesWindows() and syncSchedulesPosix() as reference implementations.`
        );
      }
      throw err;
    }
    console.log(`[+] Registered ${scheduledTaskName('PA-Catchup')}: ${cronLine}`);
    if (hasLegacyReminders) {
      console.log(`[!] Left the '${scheduledTaskName('PA-Catchup-Reminders')}' crontab entry untouched: retire it only through docs/catchup-watchdog.md, "Retiring the legacy reminders task".`);
    }
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
  return true;
}

export async function listSchedules(): Promise<void> {
  // Show registered OS-level catchup tasks
  if (platform() === 'win32') {
    try {
      const { stdout } = await execAsync('schtasks /query /fo TABLE /nh', {});
      // This substring filter relies on an invariant scheduledTaskName() must
      // preserve: its output always CONTAINS the base label, hash-suffixed
      // or not (asserted directly in scheduler-posix.test.ts). A future
      // change to the naming scheme (different separator, prefix instead of
      // suffix, etc.) that breaks this would make listSchedules() silently
      // stop finding non-default installs' tasks — update this filter too.
      const lines = stdout.split('\n').filter(l => l.includes('PA-Catchup'));
      console.log('Registered OS tasks:\n');
      console.log('TaskName'.padEnd(25) + '  ' + 'Next Run Time'.padEnd(20) + '  ' + 'Status');
      console.log('-'.repeat(60));
      if (lines.length > 0) {
        console.log(lines.join('\n').trim());
      } else {
        console.log('No PA-Catchup tasks found.');
      }
    } catch {
      console.log('No PA tasks registered in Windows Task Scheduler.');
      console.log('Run `pa schedules sync` to register them.');
    }
  } else {
    try {
      const { stdout } = await execAsync('crontab -l');
      const lines = stdout.split('\n').filter(l =>
        l.includes(cronSentinelReminders().slice(2)) || l.includes(cronSentinelDefault().slice(2)) ||
        l.includes('pa catchup')
      );
      console.log('Registered crontab entries:\n');
      if (lines.length > 0) {
        console.log(lines.join('\n').trim());
      } else {
        console.log('No PA-Catchup crontab entries found.');
        console.log('Run `pa schedules sync` to register them.');
      }
    } catch (err: any) {
      const notFound = err.code === 'ENOENT' || String(err.stderr ?? '').toLowerCase().includes('not found');
      if (notFound) {
        console.log('crontab not available on this system.');
        console.log('See pa/src/scheduler.ts:syncSchedules() and docs/TROUBLESHOOTING.md §"Unsupported OS" to add scheduling support.');
      } else {
        console.log('No crontab set. Run `pa schedules sync` to register PA entries.');
      }
    }
  }

  const artifact = await expectedCatchupWatchdogArtifact();
  if (artifact.ok) {
    let onDisk: string | null = null;
    try {
      onDisk = readFileSync(artifact.path, 'utf8');
    } catch {
      onDisk = null;
    }
    console.log(`\n${formatLauncherDriftLine(artifact.path, launcherDrift(onDisk, artifact.text))}`);
  } else {
    console.log(`\nLauncher: cannot verify — ${artifact.errorMessage}`);
  }

  // Show skills with cron schedules
  const skills = await listSkills();
  const scheduled = skills.filter((s) => s.frontmatter.cron);

  if (scheduled.length === 0) {
    console.log('\nNo skills with cron schedules found.');
    return;
  }

  console.log('\nSkill schedules:');
  const nameWidth = Math.max(10, ...scheduled.map((s) => s.name.length));
  console.log('Skill'.padEnd(nameWidth) + '  ' + 'Cron'.padEnd(20) + '  ' + 'Topic'.padEnd(12) + '  ' + 'On Missed');
  console.log('-'.repeat(nameWidth + 45));

  for (const s of scheduled) {
    const onMissed = s.frontmatter.on_missed || 'latest';
    const topic = s.frontmatter.topic || 'default';
    console.log(
      `${s.name.padEnd(nameWidth)}  ${(s.frontmatter.cron || '').padEnd(20)}  ${topic.padEnd(12)}  ${onMissed}`
    );
  }
}
