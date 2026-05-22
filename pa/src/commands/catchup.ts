import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import { getOverdueSkills } from '../scheduler.js';
import { runCommand } from './run.js';
import { blackboard } from '../blackboard.js';
import { paHome, logsDir } from '../paths.js';
import { learnCommand } from './learn.js';
import { rotateLogs, getLastSuccessfulRun } from '../logger.js';
import { cleanupOrphanedWorkers } from '../worker-pids.js';
import { listSkills } from '../skills.js';
import { log } from '../lib/log.js';
import { notifyUser, migrateStalenessAlertFile, gcAlertState } from '../lib/notify.js';
import { parseExpression } from 'cron-parser';

export async function catchupCommand(): Promise<void> {
  const locked = await blackboard.acquireLock('catchup', 'catchup-command', process.pid, 5000);
  if (!locked) {
    console.log('Another catchup is already running. Exiting.');
    return;
  }

  try {
    await runCatchup();
  } finally {
    await blackboard.releaseLock('catchup', 'catchup-command');
  }
}

async function runCatchup(): Promise<void> {
  // 1. Kill any orphaned workers from previous crashed runs
  await cleanupOrphanedWorkers().catch(() => {});

  // 2. Purge stale locks from blackboard
  try {
    const purged = await blackboard.purgeStaleLocks();
    if (purged > 0) {
      console.log(`[catchup] Purged ${purged} stale locks from blackboard.`);
    }
  } catch (err) {
    console.error('[catchup] Blackboard purge failed:', err);
  }

  // 3. One-time staleness migration + dedup GC
  await migrateStalenessAlertFile();
  await gcAlertState();

  console.log('Checking for missed scheduled skills...\n');
  const overdue = await getOverdueSkills();

  if (overdue.length === 0) {
    console.log('All scheduled skills are up to date.');
  } else {
    // Group by skill name to handle on_missed: 'all' correctly
    const bySkill = new Map<string, number>();
    for (const { skill } of overdue) {
      bySkill.set(skill.name, (bySkill.get(skill.name) || 0) + 1);
    }

    console.log(`Found ${overdue.length} overdue run(s) across ${bySkill.size} skill(s):\n`);
    for (const { skill, missedAt } of overdue) {
      console.log(`  ${skill.name} — missed at ${missedAt.toLocaleString()}`);
    }
    console.log('');

    // Run each overdue entry (on_missed: 'all' means multiple runs of the same skill)
    for (const { skill, missedAt } of overdue) {
      console.log(`--- Running: ${skill.name} (missed ${missedAt.toLocaleString()}) ---`);
      try {
        const result = await runCommand(skill.name);
        // Double-alert guard: on failure, handleSkillResult (or runWithFailover) already
        // emitted the appropriate alert. No additional alert needed from catchup.
        if (!result.success) {
          log('info', 'catchup', `Skill ${skill.name} returned failure (alerted by run pipeline)`, {
            skill: skill.name, alreadyAlerted: result.alreadyAlertedPaSupport,
          });
        }
      } catch (err: any) {
        // catchup-threw-*: only reachable when runCommand itself throws (misconfig, I/O failure)
        const failMsg = `[catchup] ${skill.name} threw: ${err.message}`;
        console.error(failMsg);
        log('error', 'catchup', `Skill ${skill.name} threw`, { skill: skill.name, error: err.message });
        await notifyUser(
          `Catchup exception: ${skill.name}`,
          `Skill: ${skill.name}\nMissed at: ${missedAt.toLocaleString()}\nException: ${err.message}`,
          { dedupKey: `catchup-threw-${skill.name}`, severity: 'error' },
        ).catch(() => {});
      }
      console.log('');
    }
  }

  await checkStaleness().catch(() => {});

  // Rotate old logs for all skills
  await rotateAllLogs();

  // Weekly skill learning — always runs regardless of whether skills were overdue
  await maybeRunLearn();
}

async function rotateAllLogs(): Promise<void> {
  try {
    const dir = logsDir();
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await rotateLogs(entry.name).catch(() => {});
      }
    }
  } catch {
    // Non-fatal: rotation failure should never block catchup
  }
}

async function maybeRunLearn(): Promise<void> {
  const learnStateFile = join(paHome(), 'last-learn.json');
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  let lastLearn = 0;
  try {
    const raw = await readFile(learnStateFile, 'utf8');
    lastLearn = new Date(JSON.parse(raw).last_run).getTime();
  } catch {
    // No state file yet — treat as never run
  }

  if (Date.now() - lastLearn <= sevenDays) return;

  console.log('\n--- Weekly skill learning ---');
  try {
    await learnCommand();
    await writeFile(learnStateFile, JSON.stringify({ last_run: new Date().toISOString() }), 'utf8');
  } catch (err: any) {
    console.error(`Skill learning failed: ${err.message}`);
  }
}

async function checkStaleness(): Promise<void> {
  // Dedup handled by notifyUser via dedup key 'staleness'

  const skills = await listSkills();
  const now = Date.now();
  const alerts: string[] = [];

  for (const skill of skills) {
    if (!skill.frontmatter.cron) continue;
    const lastSuccess = await getLastSuccessfulRun(skill.name);
    if (!lastSuccess) continue; // never succeeded — separate concern

    try {
      const interval = parseExpression(skill.frontmatter.cron, { tz: 'UTC' });
      const next1 = interval.next().toDate();
      const next2 = interval.next().toDate();
      const intervalMs = next2.getTime() - next1.getTime();
      // Skip sub-hourly skills (e.g. reminders at * * * * *) — their 2x threshold
      // would be only 2 minutes, firing on every catchup run.
      if (intervalMs < 60 * 60 * 1000) continue;
      const timeSinceSuccess = now - new Date(lastSuccess.timestamp).getTime();
      if (timeSinceSuccess > 2 * intervalMs) {
        const hoursAgo = Math.round(timeSinceSuccess / 3600000);
        alerts.push(`${skill.name}: last success ${hoursAgo}h ago (interval: ${Math.round(intervalMs / 3600000)}h)`);
      }
    } catch { /* skip invalid cron */ }
  }

  if (alerts.length > 0) {
    const msg = alerts.join('\n');
    log('warn', 'catchup', `${alerts.length} stale skill(s) detected`, { skills: alerts });
    await notifyUser(
      'Stale Skills Detected',
      msg,
      { dedupKey: 'staleness', severity: 'warn' },
    ).catch(() => {});
  }
}
