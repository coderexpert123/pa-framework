import { randomUUID, randomBytes } from 'crypto';
import { join } from 'path';
import { writeFileSync, renameSync, statSync, readFileSync, unlinkSync, utimesSync, existsSync } from 'fs';
import { getOverdueSkills, partitionOverdueByFailureBackoff, partitionOverdueByCostTier } from '../scheduler.js';
import { runCommand } from './run.js';
import { blackboard, startLockRenewal, type Blackboard } from '../blackboard.js';
import { log, flushLog } from '../lib/log.js';
import { notifyUser } from '../lib/notify.js';
import { loadConfig } from '../config.js';
import { paHome } from '../paths.js';
import { runDueJobs } from '../lib/maintenance/runner.js';
import { jobsForHost } from '../lib/maintenance/registry.js';
import { workerSlotCount } from '../worker-exec.js';
import type { RunMeta } from '../types.js';
import { getLastSuccessfulRun } from '../logger.js';
import { onStall, setStallHost, type StallRecord } from '../lib/stall.js';
import {
  CATCHUP_LOOP_LANES,
  CATCHUP_STALL_EXIT_CODE,
  catchupDrillWedgePath,
  catchupLanesDir,
  catchupStallMarkerPath,
  formatStallMarker,
  writeLaneProgress,
  type LaneProgressFn,
} from '../lib/catchup-contract.js';

export { CATCHUP_LOOP_LANES, CATCHUP_STALL_EXIT_CODE };
export type { LaneProgressFn };

export interface CatchupOptions {
  topic?: string;
  loop?: boolean;
}

// `pa/src/validator.ts`'s PROTECTED_SKILLS is module-private (verified 2026-08-24,
// not exported) — per the 2026-08-24 buttons-program spec WP-P2 edit 1, this is
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

// ---------------------------------------------------------------------------
// Wall-clock run budget (2026-09-10 incident fix)
// ---------------------------------------------------------------------------
//
// A skill's own timeout/idle_timeout ALREADY exists and bounds THAT skill's
// own process (run.ts's shell-skill timeoutTimer at line ~745; workers.ts's
// executeWorker timeout+idleTimeout for LLM-worker skills). It does nothing
// for the `pa catchup` PROCESS awaiting that skill — if the skill's own
// timeout machinery fails to fire, catchup can be wedged indefinitely. That
// happened 2026-09-10: an agy worker looped on its own error step forever
// (its idle timer kept resetting on partial output — a separate fix), and
// `pa catchup --topic default` sat alive 38+ minutes holding the
// `catchup:topic:default` blackboard lock. Task Scheduler's "do not start a
// new instance" policy then refused every subsequent once-a-minute trigger,
// so the whole declared-maintenance framework silently stopped running
// underneath it (voice-inbox-fallback — the safety net for stuck voice
// tasks — hadn't run in 4 hours).
//
// PA_CATCHUP_BUDGET_MS bounds the WHOLE run (maintenance phase + skill
// dispatch together) against exactly that wedge, regardless of which phase
// or which single await it happens in — catchupCommand races the entire
// runCatchup() call against this wall clock rather than trying to interrupt
// one specific await. Past budget: catchup stops starting new skills,
// releases its own lock, logs a warn with a ref-id (and pages the operator),
// and exits — it never force-kills a dispatch it didn't itself decide to
// abort; an abandoned dispatch keeps running under its own timeout/
// idle_timeout (or gets reaped by the `orphan-worker-reap` maintenance job
// once this process's PID is gone).
export const DEFAULT_CATCHUP_BUDGET_MS = 15 * 60_000; // 15 minutes

export function readCatchupBudgetMs(): number {
  const n = Number(process.env.PA_CATCHUP_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CATCHUP_BUDGET_MS;
}

/** Distinct, greppable process exit code for a budget-exceeded abort (never
 *  0) — the accompanying warn log (see handleBudgetExceeded below) is the
 *  actual diagnostic; this just lets a caller/monitor tell "aborted on
 *  budget" apart from "aborted with a real error" without parsing logs. */
export const CATCHUP_BUDGET_EXCEEDED_EXIT_CODE = 3;

// Test-only exit-function injection, mirroring
// projects/telegram-bot/src/main.ts's _setExitForTest: production really
// calls process.exit() — the whole point is to force-terminate this process
// even though it cannot itself unstick the await it's wedged on (the
// abandoned dispatch's child process keeps the event loop alive; see the
// comment block above). Tests inject a no-op/spy so a deliberately-wedged
// run resolves the awaited catchupCommand() call instead of tearing down the
// test worker.
const defaultExitFn = (code?: number): void => { process.exit(code); };
let exitFn: (code?: number) => void = defaultExitFn;
export function _setExitForTest(fn: ((code?: number) => void) | null): void {
  exitFn = fn ?? defaultExitFn;
}

/** Production exit for the LOOP's store-stall path (D3, 2026-09-16). Defined
 *  above the loop section on purpose: the loop receives it through
 *  CatchupLoopDeps.exit, tests inject a spy, and catchup-loop.test.ts pins that
 *  the loop section itself never calls process.exit. */
const defaultLoopExit = (code: number): void => { process.exit(code); };

/** What the run was doing when its budget fired — surfaced in the warn log
 *  and the operator notify (requirement: the next person sees the cause in
 *  one `pa ref`, not a blackboard dump) rather than the next person
 *  reconstructing it from a blackboard dump. */
interface RunProgress {
  phase: 'maintenance' | 'lock-acquired' | 'overdue-scan' | 'dispatch-loop' | 'awaiting-concurrency-slot' | 'skill-dispatch' | 'awaiting-active-completions' | 'idle';
  detail?: string;
}

/** Checkpoints threaded into runCatchup so it can cooperatively stop
 *  starting new work. isLockLost mirrors the pre-existing D2/D3/D4
 *  (2026-08-23) checkpoints; isBudgetExceeded/setProgress are new for the
 *  wall-clock budget above. Bundled into one object (rather than positional
 *  params) so a future guard doesn't turn this into an unreadable arg list. */
interface RunGuards {
  isLockLost: () => boolean | Promise<boolean>;
  isBudgetExceeded: () => boolean;
  setProgress: (phase: RunProgress['phase'], detail?: string) => void;
}

/** `pa catchup` — one-shot entry point. `opts.loop === true` delegates to the
 *  long-lived `runCatchupLoop()` (2026-09-10 launch-cadence wave); anything
 *  else takes the pre-existing one-shot path via `runCatchupTick`. */
export async function catchupCommand(opts: CatchupOptions = {}): Promise<void> {
  if (opts.loop === true) {
    await runCatchupLoop();
    return;
  }
  return runCatchupTick(opts.topic);
}

/** The pre-2026-09-10 body of `catchupCommand`, extracted verbatim so both
 *  the one-shot CLI path and each lane of `pa catchup --loop` can call it —
 *  behaviour (every console line, every notify call) is unchanged from the
 *  pre-extraction `catchupCommand(opts)`. `tickOpts.dispatchOnly` (S7,
 *  2026-09-11) defaults to false, so every existing caller — the one-shot
 *  CLI path included — keeps today's behaviour of awaiting every dispatched
 *  skill to completion before resolving. */
export async function runCatchupTick(topic: string | undefined, tickOpts: { dispatchOnly?: boolean; onProgress?: LaneProgressFn } = {}): Promise<void> {
  const dispatchOnly = tickOpts.dispatchOnly ?? false;
  const opts: CatchupOptions = { topic };
  const lockKey = topic ? `catchup:topic:${topic}` : 'catchup';
  const contextId = randomUUID();

  const locked = await blackboard.acquireLock(lockKey, 'catchup-command', process.pid, 5000, contextId);
  if (!locked) {
    console.log(`Another catchup (${lockKey}) is already running. Exiting.`);
    return;
  }
  tickOpts.onProgress?.('lock-acquired', lockKey);

  // Heartbeat the lock while the run is in flight: acquireLock evicts a lock
  // whose heartbeat is older than HEARTBEAT_STALE_MS (10 min) plus a bounded
  // grace window when the holder's PID is dead — an alive holder gets that
  // grace before eviction (blackboard.ts's classifyLock, 2026-09-01
  // followup-defects Defect 1), and catchup runs can exceed the stale
  // threshold (skill execution + rotation + prune). Without this heartbeat,
  // Task Scheduler's next invocation would eventually steal the lock mid-run
  // (once even the grace window elapsed) and two catchups would overlap.
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
  let notifiedLockLost = false;
  const notifyLockLost = (reason: 'expired' | 'purged') => {
    if (notifiedLockLost) return;
    notifiedLockLost = true;
    const refId = `s-${randomBytes(6).toString('hex')}`;
    log('error', 'catchup', `Lock lost mid-tick (${lockKey})`, { lockKey, reason, refId });
    void notifyUser(
      'Catchup aborted (lock lost)',
      `Lock: ${lockKey}\nReason: ${reason}\n\n_Ref: ${refId}_`,
      { dedupKey: `catchup-lock-lost:${lockKey}`, severity: 'error' },
    ).catch(() => {});
  };

  const renewal = startLockRenewal(lockKey, 'catchup-command', contextId, {
    onLost: (reason) => {
      lockLost = reason;
      notifyLockLost(reason);
    },
  });

  // --- Wall-clock run budget (2026-09-10 incident) — see the block comment
  // above readCatchupBudgetMs() for the full rationale. Driven off ONE timer
  // so there is exactly one authoritative "budget exceeded" moment: the
  // cooperative isBudgetExceeded() checks inside runCatchup only ever
  // OBSERVE budgetExceeded going true (set synchronously, before anything
  // else, in the timer callback below) — they never independently compute
  // elapsed time, so there is never a second, racing detector of the same
  // condition.
  const budgetMs = readCatchupBudgetMs();
  const runStartedAt = Date.now();
  const progress: RunProgress = { phase: 'idle' };
  let budgetExceeded = false;
  let budgetHandledPromise: Promise<void> | undefined;

  const handleBudgetExceeded = async (): Promise<void> => {
    const refId = `s-${randomBytes(6).toString('hex')}`;
    const elapsedMs = Date.now() - runStartedAt;
    log('warn', 'catchup', `Catchup run exceeded its wall-clock budget (${lockKey})`, {
      lockKey, budgetMs, elapsedMs, waitingOnPhase: progress.phase,
      ...(progress.detail ? { waitingOnDetail: progress.detail } : {}),
      refId,
    });
    await notifyUser(
      'Catchup aborted (budget exceeded)',
      `Lock: ${lockKey}\nBudget: ${Math.round(budgetMs / 1000)}s\nElapsed: ${Math.round(elapsedMs / 1000)}s\n` +
      `Waiting on: ${progress.phase}${progress.detail ? ` — ${progress.detail}` : ''}\n\n_Ref: ${refId}_`,
      { dedupKey: `catchup-budget-exceeded:${lockKey}`, severity: 'warn' },
    ).catch(() => {});
    renewal.stop();
    await blackboard.releaseLock(lockKey, 'catchup-command', contextId, { pid: process.pid }).catch(() => {});
    // Flush before exiting — log()/notifyUser() enqueue onto an async batched
    // writer (lib/log.ts), so an immediate process.exit() right after them
    // can drop the very diagnostic this whole mechanism exists to leave
    // behind. See lib/log.ts's flushLog() doc comment.
    await flushLog();
    exitFn(CATCHUP_BUDGET_EXCEEDED_EXIT_CODE);
  };

  let resolveBudgetFired: () => void = () => {};
  const budgetFiredPromise = new Promise<void>((resolve) => { resolveBudgetFired = resolve; });
  const budgetTimer = setTimeout(() => {
    budgetExceeded = true;
    budgetHandledPromise = handleBudgetExceeded();
    resolveBudgetFired();
  }, budgetMs);
  budgetTimer.unref?.();

  try {
    await Promise.race([
      runCatchup(opts, {
        isLockLost: async () => {
          if (lockLost !== undefined) {
            notifyLockLost(lockLost);
            return true;
          }
          // Timer-starvation guard (2026-08-28 push-gate incident): a starved
          // renewal interval leaves `lockLost` unset even after the row was purged
          // mid-tick, so the checkpoints also verify the row directly —
          // deterministic under load. A heartbeat too stale to appear in
          // getActiveLocks() also reads as lost (we cannot prove we still hold it).
          const rows = await blackboard.getActiveLocks();
          const lost = !rows.some((l) => l.resource === lockKey && l.agent === 'catchup-command' && l.contextId === contextId);
          if (lost) {
            lockLost = 'purged';
            notifyLockLost('purged');
          }
          return lost;
        },
        isBudgetExceeded: () => budgetExceeded,
        setProgress: (phase, detail) => { progress.phase = phase; progress.detail = detail; tickOpts.onProgress?.(phase, detail); },
      }, dispatchOnly),
      // Bounds the ENTIRE runCatchup() call, not just the skill-dispatch tail
      // — a hang anywhere (a stuck maintenance job, the concurrency busy-wait,
      // or the final Promise.all(active) on an already-dispatched skill) is
      // abandoned the same way once the budget fires. runCatchup's own
      // promise is never cancelled (JS has no such thing); it is simply left
      // unawaited from here on, matching "never kill a dispatch it didn't
      // decide to abort".
      budgetFiredPromise,
    ]);
  } finally {
    clearTimeout(budgetTimer);
    if (budgetHandledPromise) {
      // Budget fired — handleBudgetExceeded() already does log + notify +
      // renewal.stop() + releaseLock() + flush + exitFn (a no-op in tests);
      // await it so callers (and tests) never observe catchupCommand()
      // resolving before that sequence has actually finished.
      await budgetHandledPromise;
    } else {
      renewal.stop();
      await blackboard.releaseLock(lockKey, 'catchup-command', contextId, { pid: process.pid });
    }
  }
}

/** Pure decision for the completion-race guard (2026-09-13 oracle double-run,
 *  vi-6ab06170497f): true when a SUCCESS newer than the snapshot this tick
 *  planned against has landed since getOverdueSkills() ran. `snapshot` is the
 *  entry.lastRun captured at tick start; `fresh` is a dispatch-time re-read of
 *  getLastSuccessfulRun(). Equal timestamps = the same run the snapshot
 *  already saw → not a skip. Any success landing mid-tick has timestamp ≈ now,
 *  which is after every missedAt by construction of overdue, so it served the
 *  occurrence this entry was going to serve. */
export function completionRaceSkip(
  snapshot: RunMeta | null,
  fresh: RunMeta | null,
): boolean {
  if (!fresh) return false;
  if (!snapshot) return true; // first-ever success landed mid-tick
  return new Date(fresh.timestamp).getTime() > new Date(snapshot.timestamp).getTime();
}

/** `dispatchOnly` (S7, 2026-09-11): loop path only. When true, each skill is
 *  still dispatched fire-and-forget (registered in `activeSkillRuns`) but the
 *  tick RETURNS as soon as the dispatch loop ends — it never waits on
 *  `Promise.all(active)`. A skill still running from an earlier tick is
 *  skipped rather than re-dispatched. The one-shot path (`dispatchOnly`
 *  false, the default) is unchanged: it still awaits every dispatch to
 *  completion, which `topic-partitioning.test.ts` relies on. */
async function runCatchup(opts: CatchupOptions, guards: RunGuards, dispatchOnly = false): Promise<void> {
  const lockKey = opts.topic ? `catchup:topic:${opts.topic}` : 'catchup';
  const config = await loadConfig();
  // S2: an explicit operator number wins; absent means the dynamic worker-slot
  // cap IS the limit; the kill switch restores the legacy static 2.
  const resolveConcurrencyLimit = (): number => {
    if (config.concurrency_limit !== undefined) return config.concurrency_limit;
    if (process.env.PA_DYNAMIC_SLOTS === '0') return 2;
    return workerSlotCount();
  };
  const concurrencyLimit = resolveConcurrencyLimit();

  // Declared maintenance (AI-100) runs here ONLY for a topic-less one-shot
  // `pa catchup`. Since 2026-09-11 the pass has its own lane in the loop
  // (runMaintenanceTick, lock `catchup:maintenance`): a topic-scoped tick —
  // every lane of `pa catchup --loop` included — does skill dispatch only, so
  // a 20-minute skill in the `default` lane can no longer starve every
  // declared job for its whole duration (observed live 22:29-22:50 IST
  // 2026-09-11: voice-inbox-fallback, cadence 5 min, did not run for 20+ min).
  //
  // The 2026-08-23 topic gate (`opts.topic === 'default'`) is retired with the
  // two per-minute topic tasks it served: the Windows launcher and the posix
  // cron line both register `catchup --loop` now (scheduler.ts). Its history is
  // still worth knowing — the pre-AI-100 code gated the pass on `!opts.topic`
  // while BOTH registered tasks passed a topic, so alert-state GC and the
  // staleness migration had never once executed in production.
  if (!opts.topic) {
    guards.setProgress('maintenance');
    await runDueJobs('pa', jobsForHost('pa'), { overrides: config.maintenance })
      .catch((err) => { console.error('[catchup] Maintenance runner failed:', err); });
  }

  // Checkpoint 1/2 (D2, 2026-08-23): the lock may have been purged out from
  // under this tick while the maintenance pass ran. Abort before touching
  // any skill rather than proceeding on a lock this process may no longer
  // exclusively hold.
  if (await guards.isLockLost()) {
    log('warn', 'catchup', 'tick aborted — lock lost', { lockKey });
    return;
  }
  // Budget checkpoint mirroring the lock-lost one above (2026-09-10): if the
  // maintenance pass alone already ate the whole run budget (a hung
  // maintenance job, or just an overloaded host), don't start the skill
  // phase at all — the outer race in catchupCommand() is the actual
  // backstop for a wedge mid-phase, this just avoids starting NEW work in
  // the common (not-stuck, just late) case.
  if (guards.isBudgetExceeded()) {
    log('info', 'catchup', 'tick aborted — budget exceeded before skill dispatch', { lockKey });
    return;
  }

  guards.setProgress('overdue-scan');
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
  guards.setProgress('dispatch-loop', String(overdue.length));

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
    const activeNames = new Set<string>();
    let budgetAbort = false;
    for (const { skill, missedAt, lastRun } of overdue) {
      guards.setProgress('dispatch-loop', skill.name);
      // Checkpoint 2/2 (D2, 2026-08-23): re-checked before every dispatch, not
      // just once before the loop — a tick that has already been running for
      // a while (many skills, concurrency waits) can lose the lock partway
      // through. `break`, not `return` — stop dispatching any FURTHER skill,
      // but still fall through to `await Promise.all(active)` below so
      // already-dispatched promises are awaited to completion, never
      // abandoned mid-flight.
      if (await guards.isLockLost()) {
        log('warn', 'catchup', 'tick aborted — lock lost', { lockKey });
        break;
      }
      // Budget companion to the lock-lost checkpoint above (2026-09-10):
      // stop STARTING new skills once the run's wall-clock budget is spent —
      // same "break, still await what's already dispatched" contract.
      if (guards.isBudgetExceeded()) {
        log('info', 'catchup', 'tick aborted — budget exceeded, no further skills dispatched', { lockKey, skill: skill.name });
        break;
      }
      // S7 (2026-09-11), loop path only: a skill still running from an
      // earlier fire-and-forget dispatch is skipped rather than re-dispatched
      // — the lane tick itself never waits for it.
      if (dispatchOnly && activeSkillRuns.has(skill.name)) {
        // C22: ageMs is what makes `startedAt` load-bearing — past the existing budget a
        // permanently-hung skill escalates instead of being skipped silently forever.
        const ageMs = Date.now() - (activeSkillRuns.get(skill.name)?.startedAt ?? Date.now());
        const stuck = ageMs > readCatchupBudgetMs();
        log(stuck ? 'warn' : 'info', 'catchup',
            `catchup loop: skill '${skill.name}' still running — skipped this tick`,
            { skill: skill.name, ageMs });
        if (stuck) {
          void notifyUser(
            `Skill still running past its catchup budget: ${skill.name}`,
            `${skill.name} has been running ${Math.round(ageMs / 60_000)} min and is being skipped every ` +
            `tick. It is not being killed — check its own timeout/idle_timeout.`,
            { dedupKey: `catchup-skill-stuck-${skill.name}`, severity: 'warn', dedupWindowMs: 6 * 3_600_000 },
          ).catch(() => {});
        }
        continue;
      }
      // Wait for global concurrency slot
      guards.setProgress('awaiting-concurrency-slot', skill.name);
      while (true) {
        const activeLocks = await blackboard.getActiveLocks();
        const activeSkills = activeLocks.filter(l => l.resource.startsWith('skill-')).length;
        if (activeSkills < resolveConcurrencyLimit()) break;

        // A concurrency wait can itself run past budget (two long-running
        // skills already occupying both slots) — checked every poll, not
        // just once per skill, for the same reason checkpoint 2/2 re-checks
        // every dispatch rather than once before the loop.
        if (guards.isBudgetExceeded()) {
          log('info', 'catchup', 'tick aborted — budget exceeded while waiting for a concurrency slot', { lockKey, skill: skill.name });
          budgetAbort = true;
          break;
        }
        console.log(`[catchup] Global concurrency limit reached (${activeSkills}/${resolveConcurrencyLimit()}). Waiting...`);
        guards.setProgress('awaiting-concurrency-slot', skill.name);
        await new Promise(r => setTimeout(r, 5000));
      }
      if (budgetAbort) break;

      // Completion-race + live-run guards (2026-09-13 oracle double-run,
      // vi-6ab06170497f). The overdue list was computed at tick start; a run
      // that COMPLETED between that read and this dispatch decision is
      // invisible to both existing guards — its success pointer
      // (logs/<skill>/latest.json) was not yet written when getOverdueSkills()
      // read it, and it is no longer in activeSkillRuns. Re-validate fresh at
      // dispatch time — i.e. AFTER the concurrency-slot wait above, whose own
      // latency is part of the race window (the 2026-09-14 gate run proved a
      // pre-wait re-read misses a success seeded mid-wait). Scoped to
      // on_missed 'latest' (the default): 'all' mode legitimately dispatches
      // several entries per tick and its sibling runs cannot be told apart by
      // completion timestamps.
      if ((skill.frontmatter.on_missed || 'latest') !== 'all') {
        const freshSuccess = await getLastSuccessfulRun(skill.name);
        if (completionRaceSkip(lastRun, freshSuccess)) {
          console.log(`[catchup] ${skill.name}: completed successfully since this tick computed overdue — skipped (completion-race guard)`);
          log('info', 'catchup', `skill '${skill.name}' completed since overdue snapshot — skipped (completion-race guard)`, {
            skill: skill.name,
            snapshotLastSuccessAt: lastRun?.timestamp ?? null,
            freshSuccessAt: freshSuccess?.timestamp ?? null,
          });
          continue;
        }
        // Live-run guard (cross-process): a live blackboard row on
        // skill-<name> means another process is running this skill right now
        // (manual `pa run`, a concurrent one-shot `pa catchup`, the bot's
        // Run-now). In-process runs are already skipped by activeSkillRuns
        // above. getActiveLocks() only returns alive/grace rows, so a dead
        // holder cannot cause a false skip. Without this guard the dispatch
        // queues on the resource lock (LLM skills: wait-then-failover-cascade)
        // or runs unserialized (shell skills) once the live run finishes —
        // re-serving an occurrence the live run is already serving.
        const liveRunLock = (await blackboard.getActiveLocks())
          .some(l => l.resource === `skill-${skill.name}`);
        if (liveRunLock) {
          console.log(`[catchup] ${skill.name}: live run in another process — skipped (live-run guard)`);
          log('info', 'catchup', `skill '${skill.name}' live run in another process — skipped (live-run guard)`, {
            skill: skill.name,
          });
          continue;
        }
      }
      guards.setProgress('skill-dispatch', skill.name);
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
      activeNames.add(skill.name);
      // S7 (2026-09-11): the one-shot path never writes to activeSkillRuns —
      // it always awaits its own dispatches below, so there is nothing for a
      // later tick (there is no later tick, it's one-shot) to skip.
      if (dispatchOnly) activeSkillRuns.set(skill.name, { promise, startedAt: Date.now() });
      promise.finally(() => {
        active.delete(promise);
        activeNames.delete(skill.name);
        if (dispatchOnly) activeSkillRuns.delete(skill.name);
      });

      // Small stagger to allow lock acquisition to reflect in blackboard
      await new Promise(r => setTimeout(r, 1000));
    }

    // S7 (2026-09-11), loop path only: return as soon as dispatch is done —
    // never set the 'awaiting-active-completions' phase (C21: it has exactly
    // one reader, handleBudgetExceeded, and that reader only matters on the
    // one-shot path, which is the only path that can still wedge on a
    // completion) and never await the dispatched skills.
    if (dispatchOnly) return;

    guards.setProgress('awaiting-active-completions', activeNames.size > 0 ? [...activeNames].join(', ') : undefined);
    await Promise.all(active);
  }
}

// ---------------------------------------------------------------------------
// pa catchup --loop (2026-09-10 launch-cadence wave)
// ---------------------------------------------------------------------------
//
// One long-lived process replacing the two per-minute Task Scheduler tasks
// (`catchup --topic default`, `catchup --topic reminders`). The invariant it
// must preserve (A0): `default`, `reminders` and `maintenance` (added
// 2026-09-11) are THREE INDEPENDENT lanes, each with its own in-flight flag,
// driven off one timer — a slow lane must never delay another, and in
// particular a long-running skill in `default` or `reminders` must never
// delay the declared-maintenance pass. A single serial tick that ran the
// lanes one after another would NOT preserve that. The `maintenance` lane
// exists for exactly this reason: before it, the pass ran inline inside the
// `default` lane's tick, so a long-running skill there starved every
// declared job for the skill's whole duration (observed live 22:29-22:50 IST
// 2026-09-11 — voice-inbox-fallback, cadence 5 min, did not run for 20+ min).
// One sentence that must always hold: maintenance never waits for a skill.
//
// The lane timer below is deliberately NOT unref()'d: startLockRenewal's own
// interval already is (blackboard.ts), so this timer is the loop's ONLY
// reason to stay alive. unref()-ing it would make the loop exit right after
// its first tick — the exact per-minute-cold-launch defect this package
// exists to remove, made invisible (a watchdog would just restart it every
// minute, silently).
//
// loadConfig()/listSkills()/getFailureState() all re-read from disk on every
// call (no module-level cache anywhere in that chain), so this loop needs no
// cache-busting to pick up config/skill edits between ticks — and must add
// none, or the AI-098 failure-backoff ladder's behaviour would drift from
// the one-shot-process semantics it must exactly reproduce.

export const CATCHUP_LOOP_LOCK = 'catchup:loop';
export const CATCHUP_LOOP_AGENT = 'catchup-loop';
export const CATCHUP_MAINTENANCE_LANE = 'maintenance';
export const CATCHUP_MAINTENANCE_LOCK = 'catchup:maintenance';
export const CATCHUP_MAINTENANCE_AGENT = 'catchup-maintenance';

/** Loop path only (S7, 2026-09-11): skills dispatched fire-and-forget by a lane tick,
 *  keyed by skill name, so the NEXT tick can skip one that is still running. The
 *  one-shot path never writes here — it still awaits its own dispatches. */
const activeSkillRuns = new Map<string, { promise: Promise<void>; startedAt: number }>();

/** The `maintenance` lane's tick body (2026-09-11): the declared-maintenance
 *  pass (AI-100), moved out of the `default` lane's inline gate so a
 *  long-running skill can never delay it (see the A0 comment above). Bounded
 *  acquire of its OWN blackboard lock (`catchup:maintenance`, never a
 *  per-job scheme) — held by another holder, log and return; races the same
 *  wall-clock budget as the one-shot path (PA_CATCHUP_BUDGET_MS), but on
 *  expiry it logs, notifies, releases its lock and RETURNS — it never calls
 *  exitFn/process.exit, unlike the one-shot budget-exceeded path, because
 *  killing this process would tear down the other two lanes' in-flight
 *  dispatches too. The abandoned pass is left to run to completion
 *  unawaited (the same "never cancel, only abandon" contract the one-shot
 *  path already uses for a dispatch it didn't itself decide to abort).
 *
 *  Three different stops (2026-09-16), kept side by side on purpose: budget
 *  exceeded ABANDONS this pass and keeps the process; a store-queue stall
 *  (lib/stall.ts) EXITS the loop with code 4 for relaunch; a stale heartbeat or
 *  lane progress file is KILLED from outside by the per-minute launcher. */
export async function runMaintenanceTick(onProgress?: LaneProgressFn): Promise<void> {
  const contextId = randomUUID();
  const acquired = await blackboard.acquireLock(
    CATCHUP_MAINTENANCE_LOCK, CATCHUP_MAINTENANCE_AGENT, process.pid, 5000, contextId,
  );
  if (!acquired) {
    const holder = (await blackboard.getActiveLocks()).find((l) => l.resource === CATCHUP_MAINTENANCE_LOCK);
    const holderDesc = holder ? `${holder.agent} (pid ${holder.pid})` : 'another process';
    log('info', 'catchup', 'maintenance lane: pass lock held by another holder — tick skipped',
        { lockKey: CATCHUP_MAINTENANCE_LOCK, holder: holderDesc });
    return;
  }
  onProgress?.('lock-acquired', CATCHUP_MAINTENANCE_LOCK);

  const renewal = startLockRenewal(CATCHUP_MAINTENANCE_LOCK, CATCHUP_MAINTENANCE_AGENT, contextId, {
    onLost: (reason) => {
      const refId = `s-${randomBytes(6).toString('hex')}`;
      log('error', 'catchup', 'Maintenance pass lock lost mid-pass (catchup:maintenance)',
          { lockKey: CATCHUP_MAINTENANCE_LOCK, reason, refId });
      void notifyUser(
        'Maintenance pass aborted (lock lost)',
        `Lock: ${CATCHUP_MAINTENANCE_LOCK}\nReason: ${reason}\n\n_Ref: ${refId}_`,
        { dedupKey: 'catchup-maintenance-lock-lost', severity: 'error' },
      ).catch(() => {});
    },
  });

  const budgetMs = readCatchupBudgetMs();
  const runStartedAt = Date.now();
  let budgetExceeded = false;
  let resolveBudgetFired: () => void = () => {};
  const budgetFiredPromise = new Promise<void>((resolve) => { resolveBudgetFired = resolve; });
  const budgetTimer = setTimeout(() => {
    budgetExceeded = true;
    resolveBudgetFired();
  }, budgetMs);
  budgetTimer.unref?.();

  try {
    const pass = (async () => {
      const config = await loadConfig();
      onProgress?.('maintenance');
      // S8 switch-on (E15, 2026-09-11): due jobs start in parallel on this
      // lane — the option is pa-host opt-in (RunDueJobsOptions.parallel),
      // built and owned by the maintenance-runner package, not this file.
      await runDueJobs('pa', jobsForHost('pa'), { overrides: config.maintenance, parallel: true, onJobDecision: (jobName) => onProgress?.('job-decision', jobName) })
        .catch((err) => { console.error('[catchup] Maintenance runner failed:', err); });
    })();
    await Promise.race([pass, budgetFiredPromise]);
  } finally {
    clearTimeout(budgetTimer);
    if (budgetExceeded) {
      const refId = `s-${randomBytes(6).toString('hex')}`;
      const elapsedMs = Date.now() - runStartedAt;
      log('warn', 'catchup', 'Maintenance pass exceeded its wall-clock budget (catchup:maintenance)',
          { lockKey: CATCHUP_MAINTENANCE_LOCK, budgetMs, elapsedMs, refId });
      await notifyUser(
        'Maintenance pass aborted (budget exceeded)',
        `Lock: ${CATCHUP_MAINTENANCE_LOCK}\nBudget: ${Math.round(budgetMs / 1000)}s\nElapsed: ${Math.round(elapsedMs / 1000)}s\n\n_Ref: ${refId}_`,
        { dedupKey: 'catchup-maintenance-budget-exceeded', severity: 'warn' },
      ).catch(() => {});
    }
    renewal.stop();
    await blackboard.releaseLock(CATCHUP_MAINTENANCE_LOCK, CATCHUP_MAINTENANCE_AGENT, contextId, { pid: process.pid }).catch(() => {});
  }
}

export function catchupLoopLockPath(): string {
  return join(paHome(), 'catchup-loop.lock');
}

export type CatchupLoopExit = 'not-acquired' | 'signal' | 'lock-lost-purged' | 'lock-lost-expired' | 'store-stall';

export interface CatchupLoopDeps {
  /** Per-lane tick body. Receives the lane's progress stamper. Default:
   *  runMaintenanceTick(onProgress) for 'maintenance', else
   *  runCatchupTick(lane, { dispatchOnly: true, onProgress }). */
  tickFn?: (lane: string, onProgress: LaneProgressFn) => Promise<void>;
  /** Lane cadence. Default: PA_CATCHUP_LOOP_INTERVAL_MS, else 60_000. */
  intervalMs?: number;
  /** Lifetime cap handed to startLockRenewal. Default: PA_CATCHUP_LOOP_MAX_MS, else 6h. */
  maxMs?: number;
  /** Blackboard client. Default: the module singleton. */
  blackboardClient?: Pick<Blackboard, 'acquireLock' | 'releaseLock' | 'renewHeartbeat' | 'peekLockRow'>;
  /** Signal registration surface. Default: the real process. Tests pass a no-op pair. */
  signals?: {
    on: (sig: NodeJS.Signals, handler: () => void) => void;
    off: (sig: NodeJS.Signals, handler: () => void) => void;
  };
  /** Exit used by the store-stall path. Default: process.exit. Tests pass a spy. */
  exit?: (code: number) => void;
}

export interface CatchupLoopHandle {
  /** Resolves once the loop has released its lock and removed its PID file. */
  done: Promise<CatchupLoopExit>;
  /** Idempotent clean shutdown. */
  stop: () => void;
  /** Test-only introspection: the live lane timer. */
  timer: NodeJS.Timeout | null;
}

function readCatchupLoopIntervalMs(): number {
  const n = Number(process.env.PA_CATCHUP_LOOP_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

function readCatchupLoopMaxMs(): number {
  const n = Number(process.env.PA_CATCHUP_LOOP_MAX_MS);
  return Number.isFinite(n) && n > 0 ? n : 6 * 3_600_000;
}

// ---------------------------------------------------------------------------
// Heartbeat-based stall detection (2026-09-12 stuck-loop incident)
// ---------------------------------------------------------------------------
//
// Incident: `pa catchup --loop` went silent for 7.5h and self-recovered with
// no operator action. Thread/memory exhaustion were ruled out (the worker
// cap is a fixed, deliberate ceiling, not a leak). What actually happened:
// PidIsLiveNode (S1, scheduler.ts) only proves the PID still belongs to a
// live node.exe — it says nothing about whether that process's EVENT LOOP is
// still turning. Every existing safety net in this file (the wall-clock
// budget, lock-heartbeat renewal, the lane setInterval itself) is ALSO a
// timer running on that same event loop, so a frozen loop — e.g. a
// synchronous fs call blocked on this machine's known D:-drive stalls (see
// machine-notes § Disk) — silently disables every one of them at once. The
// process never crashes (nothing to make the PID disappear) and never logs
// (nothing runs), so the watchdog's liveness check reads "healthy" for as
// long as the freeze lasts. It "self-recovers" only because whatever froze
// the event loop eventually unblocks on its own.
//
// Fix: the loop's PID file doubles as a heartbeat. touchLoopHeartbeat bumps
// its mtime every tick (onTick runs synchronously off the lane setInterval,
// independent of any single lane's completion), so mtime freshness is a
// signal external processes (the VBS watchdog / POSIX cron line) can read
// without asking the process anything. A frozen event loop stops advancing
// it; a live one keeps it within one tick interval. The threshold is read
// fresh at `pa schedules sync` time and baked into the generated
// watchdog/cron artifact — see buildCatchupWatchdogVbs (scheduler.ts) and
// buildCatchupWatchdogCronLine (scheduler.ts).
export const DEFAULT_CATCHUP_LOOP_HEARTBEAT_STALE_MS = 5 * 60_000; // 5x the 60s tick cadence

export function readCatchupLoopHeartbeatStaleMs(): number {
  const n = Number(process.env.PA_CATCHUP_LOOP_HEARTBEAT_STALE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CATCHUP_LOOP_HEARTBEAT_STALE_MS;
}

/** How long each store-stall shutdown step (lock release, log flush) may take. */
export const CATCHUP_STALL_SHUTDOWN_STEP_MS = 5_000;

function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.then(
      () => { clearTimeout(timer); resolve(); },
      () => { clearTimeout(timer); resolve(); },
    );
  });
}

const laneProgressWriteWarned = new Set<string>();

/** Lane progress stamp (C1, 2026-09-16): synchronous, never throws, warns once per lane. */
function stampLane(lane: string, phase: string, detail?: string): void {
  if (writeLaneProgress(lane, phase, detail)) return;
  if (laneProgressWriteWarned.has(lane)) return;
  laneProgressWriteWarned.add(lane);
  log('warn', 'catchup', 'catchup loop: failed to write lane progress file', { lane, dir: catchupLanesDir() });
}

/** Operator drill (D6): the lane named in ~/.pa/catchup-drill-wedge, or undefined.
 *  A file naming no known lane is removed with a warn so it cannot warn every tick. */
function readDrillWedgeLane(): string | undefined {
  const path = catchupDrillWedgePath();
  try {
    if (!existsSync(path)) return undefined;
    const lane = readFileSync(path, 'utf8').trim();
    if (CATCHUP_LOOP_LANES.includes(lane)) return lane;
    unlinkSync(path);
    log('warn', 'catchup', 'catchup loop: removed a drill-wedge file that names no known lane', { lane: lane.slice(0, 40) });
  } catch {
    /* an unreadable drill file is ignored */
  }
  return undefined;
}

/** True only when the drill file was removed: a drill that cannot be consumed never wedges
 *  (otherwise the relaunched loop would wedge again). */
function consumeDrillWedge(): boolean {
  try {
    unlinkSync(catchupDrillWedgePath());
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_LOOP_SIGNALS: NonNullable<CatchupLoopDeps['signals']> = {
  on: (sig, handler) => { process.on(sig, handler); },
  off: (sig, handler) => { process.off(sig, handler); },
};

/** Write-temp-then-rename, synchronous (the PID file is a cheap hint for the
 *  watchdog launcher, not the source of truth — the blackboard lock is), so
 *  a startup or per-tick write can happen without threading an extra await
 *  through onTick(). */
function writeLoopPidFileSync(path: string, pid: number): void {
  const tmp = `${path}.tmp.${pid}`;
  writeFileSync(tmp, String(pid), 'utf8');
  renameSync(tmp, path);
}

/** True when the PID file is missing or its contents differ from `pid` — the
 *  two conditions onTick() re-asserts against. */
function loopPidFileStale(path: string, pid: number): boolean {
  try {
    statSync(path);
  } catch {
    return true;
  }
  try {
    return readFileSync(path, 'utf8') !== String(pid);
  } catch {
    return true;
  }
}

/** Bumps the PID file's mtime without touching its bytes — the tick
 *  heartbeat an external watchdog reads (see the stuck-loop block comment
 *  above). Deliberately does NOT rewrite the content: a byte-identical
 *  rewrite would work too, but a bare mtime touch is cheaper and cannot
 *  race a concurrent reader into observing a half-written file. Falls back
 *  to a full rewrite only if the file was deleted out from under us (e.g. an
 *  operator manually clearing `catchup-loop.lock` mid-run). */
function touchLoopHeartbeat(path: string, pid: number): void {
  const now = new Date();
  try {
    utimesSync(path, now, now);
  } catch {
    try {
      writeLoopPidFileSync(path, pid);
    } catch (err: any) {
      log('warn', 'catchup', 'catchup loop: failed to touch heartbeat', { path, error: err?.message });
    }
  }
}

/** `runCatchupLoop` is `(await startCatchupLoop(deps)).done`. */
export async function runCatchupLoop(deps?: CatchupLoopDeps): Promise<CatchupLoopExit> {
  const handle = await startCatchupLoop(deps);
  return handle.done;
}

export async function startCatchupLoop(deps: CatchupLoopDeps = {}): Promise<CatchupLoopHandle> {
  const intervalMs = deps.intervalMs ?? readCatchupLoopIntervalMs();
  const maxMs = deps.maxMs ?? readCatchupLoopMaxMs();
  const tickFn = deps.tickFn ?? ((lane: string, onProgress: LaneProgressFn) => (
    lane === CATCHUP_MAINTENANCE_LANE ? runMaintenanceTick(onProgress) : runCatchupTick(lane, { dispatchOnly: true, onProgress })
  ));
  const loopExit = deps.exit ?? defaultLoopExit;
  const client = deps.blackboardClient ?? blackboard;
  const signals = deps.signals ?? DEFAULT_LOOP_SIGNALS;

  const contextId = randomUUID();
  const acquired = await client.acquireLock(CATCHUP_LOOP_LOCK, CATCHUP_LOOP_AGENT, process.pid, 5000, contextId);
  if (!acquired) {
    console.log('Another catchup loop is already running. Exiting.');
    return { done: Promise.resolve<CatchupLoopExit>('not-acquired'), stop: () => {}, timer: null };
  }

  const lockPath = catchupLoopLockPath();
  try {
    writeLoopPidFileSync(lockPath, process.pid);
  } catch (err: any) {
    log('warn', 'catchup', 'catchup loop: failed to write PID file', { lockPath, error: err?.message });
  }
  setStallHost('catchup-loop');
  for (const lane of CATCHUP_LOOP_LANES) stampLane(lane, 'loop-start');

  let resolveDone!: (exit: CatchupLoopExit) => void;
  const done = new Promise<CatchupLoopExit>((resolve) => { resolveDone = resolve; });

  let shuttingDown = false;
  let shutdownStarted = false;
  let timer: NodeJS.Timeout | null = null;
  let renewalHandle: { stop: () => void } | null = null;
  const laneInFlight = new Map<string, boolean>(CATCHUP_LOOP_LANES.map((lane): [string, boolean] => [lane, false]));
  const lanePromises = new Map<string, Promise<void>>();
  const laneGeneration = new Map<string, number>();
  let offStall: () => void = () => {};

  const onSigint = () => { void shutdown('signal'); };
  const onSigterm = () => { void shutdown('signal'); };
  const onSigbreak = () => { void shutdown('signal'); };

  const shutdown = async (exit: CatchupLoopExit): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    shuttingDown = true;
    if (timer) { clearInterval(timer); timer = null; }
    renewalHandle?.stop();
    offStall();
    signals.off('SIGINT', onSigint);
    signals.off('SIGTERM', onSigterm);
    signals.off('SIGBREAK', onSigbreak);

    const pending = [...lanePromises.values()];
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => { setTimeout(resolve, 30_000); }),
    ]);

    await client.releaseLock(CATCHUP_LOOP_LOCK, CATCHUP_LOOP_AGENT, contextId, { pid: process.pid }).catch(() => {});
    try {
      unlinkSync(lockPath);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        log('warn', 'catchup', 'catchup loop: failed to remove PID file', { lockPath, error: err?.message });
      }
    }
    resolveDone(exit);
  };

  const onLost = (reason: 'expired' | 'purged'): void => {
    if (reason === 'purged') {
      const refId = `s-${randomBytes(6).toString('hex')}`;
      log('error', 'catchup', 'Catchup loop lock lost', { reason, refId });
      void notifyUser(
        'Catchup loop lock lost',
        `Lock: ${CATCHUP_LOOP_LOCK}\nReason: ${reason}\n\n_Ref: ${refId}_`,
        { dedupKey: 'catchup-loop-lock-lost', severity: 'error' },
      ).catch(() => {});
      void shutdown('lock-lost-purged');
    } else {
      // A planned exit (the lifetime cap) — info, not error, and no notify.
      log('info', 'catchup', 'Catchup loop lock lost', { reason });
      void shutdown('lock-lost-expired');
    }
  };

  // Store stall (D3, 2026-09-16): the first stall record from ANY bounded store
  // queue in this process means async I/O here is poisoned. Leave the evidence
  // for the launcher (the marker names the cause it pages), release what can be
  // released within bounds, and exit — never wait on the lanes.
  const stallShutdown = async (record: StallRecord): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    shuttingDown = true;
    try {
      writeFileSync(catchupStallMarkerPath(), formatStallMarker(record.store, record.target), 'utf8');
    } catch (err: any) {
      console.error(`[catchup] loop: failed to write stall marker: ${err?.message ?? String(err)}`);
    }
    if (timer) { clearInterval(timer); timer = null; }
    renewalHandle?.stop();
    offStall();
    signals.off('SIGINT', onSigint);
    signals.off('SIGTERM', onSigterm);
    signals.off('SIGBREAK', onSigbreak);
    log('error', 'catchup', 'catchup loop: store stall, exiting for relaunch', {
      store: record.store, target: record.target, waitedMs: record.waitedMs,
      refId: record.refId, exitCode: CATCHUP_STALL_EXIT_CODE,
    });
    await settleWithin(
      client.releaseLock(CATCHUP_LOOP_LOCK, CATCHUP_LOOP_AGENT, contextId, { pid: process.pid }),
      CATCHUP_STALL_SHUTDOWN_STEP_MS,
    );
    try {
      unlinkSync(lockPath);
    } catch {
      /* a missing PID file reads as "not running" to the launcher */
    }
    await settleWithin(flushLog(), CATCHUP_STALL_SHUTDOWN_STEP_MS);
    resolveDone('store-stall');
    loopExit(CATCHUP_STALL_EXIT_CODE);
  };

  renewalHandle = startLockRenewal(CATCHUP_LOOP_LOCK, CATCHUP_LOOP_AGENT, contextId, { maxMs, client, onLost });
  offStall = onStall((record) => { void stallShutdown(record); });

  signals.on('SIGINT', onSigint);
  signals.on('SIGTERM', onSigterm);
  signals.on('SIGBREAK', onSigbreak);

  const onTick = (): void => {
    if (shuttingDown) return;
    if (loopPidFileStale(lockPath, process.pid)) {
      try {
        writeLoopPidFileSync(lockPath, process.pid);
      } catch (err: any) {
        log('warn', 'catchup', 'catchup loop: failed to re-assert PID file', { lockPath, error: err?.message });
      }
    } else {
      // Heartbeat (2026-09-12): content already matches, so just bump mtime —
      // this is the freshness signal the watchdog checks (see the stuck-loop
      // block comment above readCatchupLoopHeartbeatStaleMs()).
      touchLoopHeartbeat(lockPath, process.pid);
    }
    const drillLane = readDrillWedgeLane();
    for (const lane of CATCHUP_LOOP_LANES) {
      if (laneInFlight.get(lane)) {
        // No stamp here: a lane whose tick never settles must go stale (C1).
        log('info', 'catchup', `catchup loop: lane '${lane}' still in flight — tick skipped`);
        continue;
      }
      laneInFlight.set(lane, true);
      const generation = (laneGeneration.get(lane) ?? 0) + 1;
      laneGeneration.set(lane, generation);
      // A callback from a superseded tick (e.g. a maintenance pass abandoned on
      // budget that keeps running) must never refresh the lane's file.
      const onProgress: LaneProgressFn = (phase, detail) => {
        if (shuttingDown || laneGeneration.get(lane) !== generation) return;
        stampLane(lane, phase, detail);
      };
      onProgress('tick-start');
      let tick: Promise<void>;
      if (drillLane === lane && consumeDrillWedge()) {
        onProgress('drill-wedge');
        log('warn', 'catchup', `catchup loop: drill wedge injected into lane '${lane}' — it stays in flight until the watchdog restarts the loop`, { lane });
        tick = new Promise<void>(() => {});
      } else {
        tick = tickFn(lane, onProgress);
      }
      const p = tick
        .catch((err: any) => {
          log('error', 'catchup', `catchup loop: lane '${lane}' tick threw`, { lane, error: err?.message });
        })
        .finally(() => {
          onProgress('tick-end');
          laneInFlight.set(lane, false);
          lanePromises.delete(lane);
        });
      lanePromises.set(lane, p);
    }
  };

  // No unref(): this timer is the loop's ONLY reason to stay alive.
  timer = setInterval(onTick, intervalMs);
  onTick();

  return { done, stop: () => { void shutdown('signal'); }, timer };
}
