import { parseExpression } from 'cron-parser';
import { exec } from 'child_process';
import { promisify } from 'util';
import { platform, tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { writeFile, unlink } from 'fs/promises';
import { listSkills } from './skills.js';
import { getLastSuccessfulRun } from './logger.js';
import { paHome } from './paths.js';
import type { Skill, RunMeta } from './types.js';

const execAsync = promisify(exec);

export interface OverdueSkill {
  skill: Skill;
  lastRun: RunMeta | null;
  missedAt: Date;
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

// Sentinel comments that anchor PA-managed cron lines on POSIX
const PA_CRON_REMINDERS = '# PA-Catchup-Reminders (managed by pa schedules sync)';
const PA_CRON_DEFAULT   = '# PA-Catchup (managed by pa schedules sync)';

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
  if (platform() === 'win32') {
    await syncSchedulesWindows();
  } else {
    await syncSchedulesPosix();
  }

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

async function syncSchedulesWindows(): Promise<void> {
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
    return;
  }
  const paPath = resolution.paPath;

  // Write VBScript launchers to ~/.pa/
  const createVbs = (name: string, args: string) => {
    const vbsPath = join(paHome(), `run-${name}-hidden.vbs`);
    const paPathCmd = paPath.replace(/"/g, '""');
    writeFileSync(
      vbsPath,
      `Set WshShell = CreateObject("WScript.Shell")\n` +
      `WshShell.Run "cmd /c ""${paPathCmd}"" ${args}", 0, True\n`,
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

  await registerTask('PA-Catchup-Reminders', highVbs);
  await registerTask('PA-Catchup', defaultVbs);
}

async function syncSchedulesPosix(): Promise<void> {
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
    return;
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
    [PA_CRON_REMINDERS]: `* * * * * ${paPath} catchup --topic reminders`,
    [PA_CRON_DEFAULT]:   `* * * * * ${paPath} catchup`,
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
    console.log(`[+] Registered PA-Catchup-Reminders: * * * * * ${paPath} catchup --topic reminders`);
    console.log(`[+] Registered PA-Catchup:           * * * * * ${paPath} catchup`);
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

export async function listSchedules(): Promise<void> {
  // Show registered OS-level catchup tasks
  if (platform() === 'win32') {
    try {
      const { stdout } = await execAsync('schtasks /query /fo TABLE /nh', {});
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
        l.includes(PA_CRON_REMINDERS.slice(2)) || l.includes(PA_CRON_DEFAULT.slice(2)) ||
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
