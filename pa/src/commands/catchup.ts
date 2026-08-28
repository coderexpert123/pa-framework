import { randomUUID, randomBytes } from 'crypto';
import { getOverdueSkills, partitionOverdueByFailureBackoff, partitionOverdueByCostTier } from '../scheduler.js';
import { runCommand } from './run.js';
import { blackboard, startLockRenewal } from '../blackboard.js';
import { log } from '../lib/log.js';
import { notifyUser } from '../lib/notify.js';
import { loadConfig } from '../config.js';
import { runDueJobs } from '../lib/maintenance/runner.js';
import { jobsForHost } from '../lib/maintenance/registry.js';

export interface CatchupOptions {
  topic?: string;
}

// `pa/src/validator.ts`'s PROTECTED_SKILLS is module-private (verified 2026-08-24,
// not exported) — per plans/2026-08-24-buttons-program-SPEC.md WP-P2 edit 1, this is
// the local fallback: exactly the seven names PA_META_PROTECTED_SKILLS declares in
// projects/telegram-bot/src/logic.ts:100-108. A "▶ Run now" button must never let an
// operator dispatch these from a tap — pa cannot import bot code across the package
// boundary (spec correction 15), and validator.ts does not export its own copy.
const RUN_NOW_BLOCKED = new Set([
  'self-improver',
  'commit',
  'push',
  'push-public',
  'investigate-flagged',
  'update-brain',
]);

// 64-byte callback_data budget: `sk:run:` / `sk:job:` is 7 bytes, leaving 57; capped
// at 40 to match §3.2's `<skill≤40>` / `<job≤40>` field caps with room to spare.
const RUN_NOW_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Pure. Builds the "▶ Run now" keyboard for a parked skill (`kind:'run'`) or a
 *  failed maintenance job (`kind:'job'`). Returns undefined when `name` fails the
 *  shape/length guard, or — `kind:'run'` only — is a member of RUN_NOW_BLOCKED
 *  (maintenance jobs have no protected-set concept; see spec §3.3). */
export function runNowKeyboard(
  kind: 'run' | 'job',
  name: string,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined {
  if (!RUN_NOW_NAME_PATTERN.test(name)) return undefined;
  if (kind === 'run' && RUN_NOW_BLOCKED.has(name)) return undefined;
  return { inline_keyboard: [[{ text: '▶ Run now', callback_data: `sk:${kind}:${name}` }]] };
}

export async function catchupCommand(opts: CatchupOptions = {}): Promise<void> {
  const lockKey = opts.topic ? `catchup:topic:${opts.topic}` : 'catchup';
  const contextId = randomUUID();

  const locked = await blackboard.acquireLock(lockKey, 'catchup-command', process.pid, 5000, contextId);
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
  //
  // startLockRenewal (2026-08-23) replaces the hand-rolled setInterval above —
  // it additionally detects a PURGED row via onLost, so a purge mid-tick
  // aborts the run instead of renewing a lock that is no longer this tick's
  // to hold (D2/D3/D4).
  let lockLost: 'expired' | 'purged' | undefined;
  const renewal = startLockRenewal(lockKey, 'catchup-command', contextId, {
    onLost: (reason) => {
      lockLost = reason;
      const refId = `s-${randomBytes(6).toString('hex')}`;
      log('error', 'catchup', `Lock lost mid-tick (${lockKey})`, { lockKey, reason, refId });
      void notifyUser(
        'Catchup aborted (lock lost)',
        `Lock: ${lockKey}\nReason: ${reason}\n\n_Ref: ${refId}_`,
        { dedupKey: `catchup-lock-lost:${lockKey}`, severity: 'error' },
      ).catch(() => {});
    },
  });

  try {
    await runCatchup(opts, () => lockLost !== undefined);
  } finally {
    renewal.stop();
    await blackboard.releaseLock(lockKey, 'catchup-command', contextId, { pid: process.pid });
  }
}

async function runCatchup(opts: CatchupOptions, isLockLost: () => boolean): Promise<void> {
  const lockKey = opts.topic ? `catchup:topic:${opts.topic}` : 'catchup';
  const config = await loadConfig();
  const concurrencyLimit = config.concurrency_limit || 2;

  // Declared maintenance (AI-100). Replaces the four hand-rolled call sites
  // that used to live here and at the tail of this function: orphan-worker
  // reaping, blackboard purge, alert-state GC + staleness migration, skill-log
  // rotation, archive prune, staleness check and weekly learn.
  //
  // ONE tick per minute, not two (2026-08-23). Both registered Task Scheduler
  // tasks fire every minute — `catchup --topic default` and
  // `catchup --topic reminders` — and each used to run the whole pa-host
  // maintenance pass, roughly doubling every job's due-check rate (restore-drill
  // logged 11,244 failures in ~7,975 minutes, review §5.2). The original
  // "DELIBERATELY UN-GATED BY TOPIC" note below is still the reason this block
  // is not gated on `!opts.topic`: the pre-AI-100 code ran only when NO topic
  // was passed, so alert-state GC and the staleness migration had never once
  // executed in production. Cadence is owned by each job's own declaration and
  // enforced against the ledger; the gate here only picks WHICH of the two
  // per-minute invocations drives it.
  //
  // DELIBERATELY UN-GATED BY TOPIC. The old code ran migrateStalenessAlertFile
  // and gcAlertState only when `!opts.topic` — but BOTH registered Task
  // Scheduler tasks pass a topic (`--topic default` / `--topic reminders`),
  // so neither had ever executed in production and ~/.pa/alert-state/ grew
  // unbounded from the day it was written. Cadence is now owned by each job's
  // own declaration and enforced against the ledger, not by how often catchup
  // happens or which topic invoked it.
  const MAINTENANCE_TOPIC = 'default';
  if (!opts.topic || opts.topic === MAINTENANCE_TOPIC) {
    await runDueJobs('pa', jobsForHost('pa'), { overrides: config.maintenance })
      .catch((err) => { console.error('[catchup] Maintenance runner failed:', err); });
  }

  // Checkpoint 1/2 (D2, 2026-08-23): the lock may have been purged out from
  // under this tick while the maintenance pass ran. Abort before touching
  // any skill rather than proceeding on a lock this process may no longer
  // exclusively hold.
  if (isLockLost()) {
    log('warn', 'catchup', 'tick aborted — lock lost', { lockKey });
    return;
  }

  console.log(`Checking for missed scheduled skills${opts.topic ? ` (topic: ${opts.topic})` : ''}...\n`);
  let overdue = await getOverdueSkills();

  // Filter by topic
  if (opts.topic) {
    overdue = overdue.filter(o => (o.skill.frontmatter.topic || 'default') === opts.topic);
  }

  // cost_tier (2026-08-17): partition out off_peak periodic skills during the
  // z.ai peak billing window (Mon-Fri 11:30-15:30 IST) FIRST — the failure
  // backoff below then operates only on what is actually allowed to run.
  const costPartition = await partitionOverdueByCostTier(overdue);
  for (const { entry, reason } of costPartition.deferred) {
    log('info', 'catchup', `${entry.skill.name}: deferred by cost_tier`, { reason });
  }
  overdue = costPartition.runnable;

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
      {
        dedupKey: `skill-parked-${name}`,
        severity: 'error',
        dedupWindowMs: 24 * 3_600_000,
        replyMarkup: runNowKeyboard('run', name),
      },
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
      // Checkpoint 2/2 (D2, 2026-08-23): re-checked before every dispatch, not
      // just once before the loop — a tick that has already been running for
      // a while (many skills, concurrency waits) can lose the lock partway
      // through. `break`, not `return` — stop dispatching any FURTHER skill,
      // but still fall through to `await Promise.all(active)` below so
      // already-dispatched promises are awaited to completion, never
      // abandoned mid-flight.
      if (isLockLost()) {
        log('warn', 'catchup', 'tick aborted — lock lost', { lockKey });
        break;
      }
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
