import { parseExpression } from 'cron-parser';
import { exec } from 'child_process';
import { promisify } from 'util';
import { platform, tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
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

export async function syncSchedules(): Promise<void> {
  if (platform() !== 'win32') {
    console.log('Schedule sync currently supports Windows only.');
    console.log('On Linux/Mac, add to crontab: */15 * * * * pa catchup');
    return;
  }

  // Find pa executable path and sanitize for shell safety
  let paPath: string;
  try {
    const { stdout } = await execAsync('where pa', {});
    const candidates = stdout.trim().split('\n').map((p) => p.trim());
    // On Windows prefer the .cmd wrapper over the bash shim
    paPath = candidates.find((p) => p.toLowerCase().endsWith('.cmd')) ?? candidates[0];
  } catch {
    paPath = 'pa';
  }

  // Validate paPath doesn't contain shell metacharacters (prevents command injection)
  if (/[&|<>^%!]/.test(paPath)) {
    console.error(`Error: pa path contains unsafe characters: ${paPath}`);
    console.log('Install pa to a path without special characters (& | < > ^ % !).');
    return;
  }

  const taskName = 'PA-Catchup';
  const logonTaskName = 'PA-Catchup-OnLogon';

  // Write a VBScript launcher to ~/.pa/ — wscript.exe + windowStyle=0 is the only
  // truly flash-free approach on Windows (powershell -WindowStyle Hidden still flickers)
  const vbsPath = join(paHome(), 'run-catchup-hidden.vbs');
  const paPathCmd = paPath.replace(/"/g, '""'); // escape double quotes for cmd embed
  writeFileSync(
    vbsPath,
    `Set WshShell = CreateObject("WScript.Shell")\n` +
    `WshShell.Run "cmd /c ""${paPathCmd}"" catchup", 0, True\n`,
    'utf8'
  );

  const vbsPathPs = vbsPath.replace(/'/g, "''");

  const psScript = `
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${vbsPathPs}"'
$settings = New-ScheduledTaskSettingsSet \`
  -Hidden \`
  -StartWhenAvailable \`
  -ExecutionTimeLimit (New-TimeSpan -Hours 72) \`
  -DontStopIfGoingOnBatteries
$settings.DisallowStartIfOnBatteries = $false

# Every 1 minute
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Settings $settings | Out-Null
Write-Host "[+] Registered '${taskName}' - runs every 1 minute (hidden)"

# On logon
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
Unregister-ScheduledTask -TaskName '${logonTaskName}' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName '${logonTaskName}' -Action $action -Trigger $logonTrigger -Settings $settings | Out-Null
Write-Host "[+] Registered '${logonTaskName}' - runs on logon (hidden)"
`.trim();

  const tmpFile = join(tmpdir(), `pa-sync-${Date.now()}.ps1`);
  writeFileSync(tmpFile, psScript, 'utf8');

  try {
    const { stdout } = await execAsync(
      `powershell -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`,
      {}
    );
    console.log(stdout.trim());
  } catch (err: any) {
    console.error(`Failed to register scheduled tasks: ${err.message}`);
    console.log('You may need to run this command as administrator.');
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }

  // Show scheduled skills
  const skills = await listSkills();
  const scheduled = skills.filter((s) => s.frontmatter.cron);
  if (scheduled.length > 0) {
    console.log(`\nSkills with schedules (evaluated by catchup):`);
    for (const s of scheduled) {
      console.log(`  ${s.name}: ${s.frontmatter.cron}`);
    }
  }
}

export async function listSchedules(): Promise<void> {
  // Show registered PA tasks from Windows Task Scheduler
  if (platform() === 'win32') {
    try {
      const { stdout } = await execAsync(
        'schtasks /query /fo LIST /tn "PA-Catchup"',
        {}
      );
      console.log('Registered OS tasks:\n');
      console.log(stdout);
    } catch {
      console.log('No PA tasks registered in Windows Task Scheduler.');
      console.log('Run `pa schedules sync` to register them.');
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
  console.log('Skill'.padEnd(nameWidth) + '  ' + 'Cron'.padEnd(20) + '  ' + 'On Missed');
  console.log('-'.repeat(nameWidth + 35));

  for (const s of scheduled) {
    const onMissed = s.frontmatter.on_missed || 'latest';
    console.log(
      `${s.name.padEnd(nameWidth)}  ${(s.frontmatter.cron || '').padEnd(20)}  ${onMissed}`
    );
  }
}
