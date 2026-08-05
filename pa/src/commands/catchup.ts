import { getOverdueSkills, partitionOverdueByFailureBackoff } from '../scheduler.js';
import { runCommand } from './run.js';
import { blackboard } from '../blackboard.js';
import { log } from '../lib/log.js';
import { notifyUser } from '../lib/notify.js';
import { loadConfig } from '../config.js';
import { runDueJobs } from '../lib/maintenance/runner.js';
import { jobsForHost } from '../lib/maintenance/registry.js';

export interface CatchupOptions {
  topic?: string;
}

export async function catchupCommand(opts: CatchupOptions = {}): Promise<void> {
  const lockKey = opts.topic ? `catchup:topic:${opts.topic}` : 'catchup';

  const locked = await blackboard.acquireLock(lockKey, 'catchup-command', process.pid, 5000);
  if (!locked) {
    console.log(`Another catchup (${lockKey}) is already running. Exiting.`);
    return;
  }

  // Heartbeat the lock while the run is in flight: acquireLock purges any
  // lock whose heartbeat is older than HEARTBEAT_STALE_MS (10 min) even when
  // the holder is alive, and catchup runs can exceed that (skill execution +
  // rotation + prune). Without this, Task Scheduler's next invocation would
  // steal the lock mid-run and two catchups would overlap.
  //
  // Catchup's cadence is EVERY MINUTE, not every 15 minutes (this comment
  // claimed 15m until 2026-07-21 — wrong by 15x). Both registrations say so:
  // syncSchedulesWindows() uses `/sc minute /mo 1` and syncSchedulesPosix()
  // uses `* * * * *`, and the live PA-Catchup / PA-Catchup-Reminders triggers
  // repeat at PT1M. That 1-minute cadence is the AMPLIFIER behind the retry
  // storms AI-098 exists to stop: a perma-failing skill is relaunched ~60x/h,
  // so the 2026-07-16 gemini capacity outage turned 5 scheduled occurrences
  // into ~93 relaunches. Anything reasoning about catchup's blast radius (lock
  // hold time, worker admission slots, retry pacing) must budget for 1 minute.
  const heartbeat = setInterval(() => {
    void blackboard.updateHeartbeat(lockKey, 'catchup-command').catch(() => {});
  }, 60_000);
  heartbeat.unref?.();

  try {
    await runCatchup(opts);
  } finally {
    clearInterval(heartbeat);
    await blackboard.releaseLock(lockKey, 'catchup-command');
  }
}

async function runCatchup(opts: CatchupOptions): Promise<void> {
  const config = await loadConfig();
  const concurrencyLimit = config.concurrency_limit || 2;

  // Declared maintenance (AI-100). Replaces the four hand-rolled call sites
  // that used to live here and at the tail of this function: orphan-worker
  // reaping, blackboard purge, alert-state GC + staleness migration, skill-log
  // rotation, archive prune, staleness check and weekly learn.
  //
  // DELIBERATELY UN-GATED BY TOPIC. The old code ran migrateStalenessAlertFile
  // and gcAlertState only when `!opts.topic` — but BOTH registered Task
  // Scheduler tasks pass a topic (`--topic default` / `--topic reminders`),
  // so neither had ever executed in production and ~/.pa/alert-state/ grew
  // unbounded from the day it was written. Cadence is now owned by each job's
  // own declaration and enforced against the ledger, not by how often catchup
  // happens or which topic invoked it.
  await runDueJobs('pa', jobsForHost('pa'), { overrides: config.maintenance })
    .catch((err) => { console.error('[catchup] Maintenance runner failed:', err); });

  console.log(`Checking for missed scheduled skills${opts.topic ? ` (topic: ${opts.topic})` : ''}...\n`);
  let overdue = await getOverdueSkills();

  // Filter by topic
  if (opts.topic) {
    overdue = overdue.filter(o => (o.skill.frontmatter.topic || 'default') === opts.topic);
  }

  // AI-098: partition out skills mid-backoff or parked after repeated
  // failures, BEFORE the "no overdue skills" check so an all-deferred/parked
  // pass still reports cleanly instead of relaunching every failing skill.
  const partition = await partitionOverdueByFailureBackoff(overdue);

  for (const { entry, retryAtMs, consecutiveFailures } of partition.deferred) {
    const retryAtISO = new Date(retryAtMs).toISOString();
    console.log(`[catchup] ${entry.skill.name}: deferred by failure backoff (${consecutiveFailures} consecutive failures, retry after ${retryAtISO})`);
    log('info', 'catchup', `${entry.skill.name}: deferred by failure backoff`, {
      skill: entry.skill.name, consecutiveFailures, retryAt: retryAtISO,
    });
  }

  const parkedSkillNames = new Set<string>();
  for (const { entry, consecutiveFailures, lastAttemptAt } of partition.parked) {
    if (parkedSkillNames.has(entry.skill.name)) continue;
    parkedSkillNames.add(entry.skill.name);

    const name = entry.skill.name;
    console.warn(`[catchup] ${name}: parked after ${consecutiveFailures} consecutive failures (last attempt: ${lastAttemptAt})`);
    log('warn', 'catchup', `${name}: parked after repeated failures`, {
      skill: name, consecutiveFailures, lastAttemptAt,
    });
    await notifyUser(
      `Skill parked after repeated failures: ${name}`,
      `${name} has failed ${consecutiveFailures} consecutive runs (last attempt: ${lastAttemptAt}).\n` +
      `Catchup retries are parked until its next scheduled cron occurrence.\n` +
      `Run manually with: pa run ${name} (a successful run resets the backoff).`,
      { dedupKey: `skill-parked-${name}`, severity: 'error', dedupWindowMs: 24 * 3_600_000 },
    ).catch(() => {});
  }

  overdue = partition.runnable;

  if (overdue.length === 0) {
    console.log('No overdue skills matching the filter.');
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
    console.log(`\nStarting execution with global concurrency limit: ${concurrencyLimit}...\n`);

    // Concurrency-limited execution (respects global blackboard lock count)
    const active = new Set<Promise<void>>();
    for (const { skill, missedAt } of overdue) {
      // Wait for global concurrency slot
      while (true) {
        const activeLocks = await blackboard.getActiveLocks();
        const activeSkills = activeLocks.filter(l => l.resource.startsWith('skill-')).length;
        if (activeSkills < concurrencyLimit) break;
        
        console.log(`[catchup] Global concurrency limit reached (${activeSkills}/${concurrencyLimit}). Waiting...`);
        await new Promise(r => setTimeout(r, 5000));
      }

      const promise = (async () => {
        console.log(`--- Running: ${skill.name} (missed ${missedAt.toLocaleString()}) ---`);
        try {
          const result = await runCommand(skill.name);
          if (!result.success) {
            log('info', 'catchup', `Skill ${skill.name} returned failure (alerted by run pipeline)`, {
              skill: skill.name, alreadyAlerted: result.alreadyAlertedPaSupport,
            });
          }
        } catch (err: any) {
          const failMsg = `[catchup] ${skill.name} threw: ${err.message}`;
          console.error(failMsg);
          log('error', 'catchup', `Skill ${skill.name} threw`, { skill: skill.name, error: err.message });
          await notifyUser(
            `Catchup exception: ${skill.name}`,
            `Skill: ${skill.name}\nMissed at: ${missedAt.toLocaleString()}\nException: ${err.message}`,
            { dedupKey: `catchup-threw-${skill.name}`, severity: 'error' },
          ).catch(() => {});
        }
      })();

      active.add(promise);
      promise.finally(() => active.delete(promise));
      
      // Small stagger to allow lock acquisition to reflect in blackboard
      await new Promise(r => setTimeout(r, 1000));
    }

    await Promise.all(active);
  }
}
