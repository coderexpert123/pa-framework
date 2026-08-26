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
import type { Skill, RunMeta } from './types.js';

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

/** True while inside the z.ai peak billing window (Mon-Fri 06:00-10:00 UTC). */
export function isPeakWindow(now: Date = new Date()): boolean {
  const d = now.getUTCDay();
  const h = now.getUTCHours();
  return d >= 1 && d <= 5 && h >= 6 && h < 10;
}

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
// 24+ timeouts over 34 hours — see plans/2026-07-20-autonomous-pii-audit-retry-storm-fix.md).
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
 * @returns true if within off-peak window
 */
function isOffPeakWindow(now: Date = new Date()): boolean {
  // The billing truth: z.ai peak = Mon-Fri 06:00-10:00 UTC (11:30-15:30 IST).
  // Everything else — evenings, nights, weekends, AND 15:30-19:30 IST weekdays —
  // is off-peak. (The earlier 14:00/06:00 hour-only form misclassified
  // 15:30-19:30 IST as peak and ignored weekends.)
  return !isPeakWindow(now);
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

  const isInOffPeak = isOffPeakWindow(now);

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
function cronSentinelReminders(): string {
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

/** Pure, unit-tested (same pattern as resolveWindowsPaPath/resolvePosixPaPath).
 *  The CurrentDirectory line is load-bearing: without it wscript inherits Task
 *  Scheduler's cwd (C:\Windows\System32) and every cwd-relative path inside
 *  `pa catchup` resolves there. The bot's launcher had this exact bug fixed in
 *  303f439; the generator never got the fix (alerts-week-review §5.2). */
export function buildLauncherVbs(paPathCmd: string, args: string, repoRoot: string): string {
  const rootVbs = repoRoot.replace(/"/g, '""');
  return `Set WshShell = CreateObject("WScript.Shell")\n` +
    `WshShell.CurrentDirectory = "${rootVbs}"\n` +
    `WshShell.Run "cmd /c ""${paPathCmd}"" ${args}", 0, True\n`;
}

async function syncSchedulesWindows(): Promise<boolean> {
  // Find pa executable path and sanitize for shell safety
  let whereStdout: string | null;
  try {
    const { stdout } = await execAsync('where pa', {});
    whereStdout = stdout;
  } catch {
    whereStdout = null;
  }
  const resolution = resolveWindowsPaPath(whereStdout);
  if (!resolution.ok) {
    console.error(`Error: ${resolution.errorMessage}`);
    process.exitCode = 1;
    return false;
  }
  const paPath = resolution.paPath;
  const repoRoot = await repoRootFromModule(__filename);

  // Write VBScript launchers to ~/.pa/
  const createVbs = (name: string, args: string) => {
    const vbsPath = join(paHome(), `run-${name}-hidden.vbs`);
    const paPathCmd = paPath.replace(/"/g, '""');
    writeFileSync(
      vbsPath,
      buildLauncherVbs(paPathCmd, args, repoRoot),
      'utf8'
    );
    return vbsPath.replace(/'/g, "''");
  };

  const highVbs = join(paHome(), 'run-catchup-reminders-hidden.vbs');
  createVbs('catchup-reminders', 'catchup --topic reminders');
  const defaultVbs = join(paHome(), 'run-catchup-hidden.vbs');
  createVbs('catchup', 'catchup --topic default');

  const registerTask = async (name: string, vbsPath: string) => {
    try {
      await execAsync(`schtasks /delete /tn "${name}" /f`).catch(() => {});
      const { stdout } = await execAsync(`schtasks /create /tn "${name}" /tr "wscript.exe \\"${vbsPath}\\"" /sc minute /mo 1 /f`);
      console.log(`[+] Registered '${name}': ${stdout.trim()}`);
    } catch (err: any) {
      console.error(`[-] Failed to register '${name}': ${err.message}`);
    }
  };

  await registerTask(scheduledTaskName('PA-Catchup-Reminders'), highVbs);
  await registerTask(scheduledTaskName('PA-Catchup'), defaultVbs);
  return true;
}

async function syncSchedulesPosix(): Promise<boolean> {
  // Find pa on PATH
  let whichStdout: string | null;
  try {
    const { stdout } = await execAsync('which pa');
    whichStdout = stdout;
  } catch {
    whichStdout = null;
  }
  const resolution = resolvePosixPaPath(whichStdout);
  if (!resolution.ok) {
    console.error(`Error: ${resolution.errorMessage}`);
    process.exitCode = 1;
    return false;
  }
  const paPath = resolution.paPath;

  // Read existing crontab (empty string if none set)
  let existing = '';
  try {
    const { stdout } = await execAsync('crontab -l');
    existing = stdout;
  } catch {
    // No crontab yet — start fresh
  }

  // Desired cron lines — both fire every minute (matches Windows Task
  // Scheduler's cadence; catchup is lock-guarded so the tighter interval
  // just means overdue skills get caught sooner, not duplicated).
  const lines: Record<string, string> = {
    [cronSentinelReminders()]: `* * * * * ${paPath} catchup --topic reminders`,
    [cronSentinelDefault()]:   `* * * * * ${paPath} catchup`,
  };

  // Upsert: replace any existing PA-managed block, or append
  let updated = existing;
  for (const [sentinel, cronLine] of Object.entries(lines)) {
    const escapedSentinel = sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escapedSentinel}\\n[^\\n]*\\n?`, 'g');
    const block = `${sentinel}\n${cronLine}\n`;
    if (pattern.test(updated)) {
      updated = updated.replace(pattern, block);
    } else {
      if (!updated.endsWith('\n') && updated.length > 0) updated += '\n';
      updated += block;
    }
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
    console.log(`[+] Registered ${scheduledTaskName('PA-Catchup-Reminders')}: * * * * * ${paPath} catchup --topic reminders`);
    console.log(`[+] Registered ${scheduledTaskName('PA-Catchup')}:           * * * * * ${paPath} catchup`);
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
