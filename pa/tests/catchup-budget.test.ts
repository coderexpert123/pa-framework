/**
 * Tests for pa catchup's wall-clock run budget (PA_CATCHUP_BUDGET_MS) — the
 * 2026-09-10 incident fix.
 *
 * Incident: an agy worker looped on its own error step forever (a separate
 * fix), and `pa catchup --topic default` sat alive 38+ minutes holding the
 * `catchup:topic:default` blackboard lock. Task Scheduler's "do not start a
 * new instance" policy then refused every subsequent once-a-minute trigger,
 * so the whole declared-maintenance framework silently stopped running.
 *
 * Fixture pattern mirrors catchup-lock.test.ts / catchup-backoff-integration.test.ts:
 * real skills dir, real getOverdueSkills, real runCommand, real shell spawn —
 * no mocking of the dispatch path. The "hung" skill spawns a real child
 * process that never exits on its own (`setInterval(() => {}, 1000)`), with
 * its OWN skill-level `timeout:` set well past this file's assertions, so a
 * pass/fail here is genuinely about catchup's OUTER budget racing ahead of
 * that per-skill timeout — never the skill's own timeout quietly reaching
 * the same result for an unrelated reason (a check that can't fail is worse
 * than no check at all).
 *
 * `_setExitForTest` (mirrors projects/telegram-bot/src/main.ts's
 * `_setExitForTest`) replaces the real `process.exit()` catchup calls on
 * budget-exceeded with a no-op spy — production really force-exits (the
 * whole point: the abandoned dispatch's child process keeps the event loop
 * alive, so nothing short of process.exit() actually frees this PID), but a
 * real exit here would tear down the test worker running this file.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, createTempConfig, createTempSkill, cleanup } from './helpers.js';
import { flushLog } from '../src/lib/log.js';

let dir: string;

/** Skill YAML uses forward slashes (project convention) and so must the
 * paths baked into a skill's `cmd:` — node accepts them on Windows too. */
const fwd = (p: string) => p.replace(/\\/g, '/');

interface AppLogEntry {
  level?: string;
  module?: string;
  message?: string;
  [key: string]: unknown;
}

async function readAppLog(): Promise<AppLogEntry[]> {
  await flushLog();
  const raw = await readFile(join(dir, 'app.log.jsonl'), 'utf8').catch(() => '');
  const entries: AppLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line) as AppLogEntry); } catch { /* skip torn line */ }
  }
  return entries;
}

// Budget comfortably clears a fresh-temp-home maintenance pass (all ~30
// declared jobs run once, sequentially, on an empty ledger) while staying
// well under the hang skill's own timeout below — the gap between the two
// is what makes this test able to fail: reverting the fix makes catchup wait
// for the ~10s skill timeout instead of the ~3s budget, which the elapsed-time
// assertion below would catch.
const BUDGET_MS = 3000;
const HANG_SKILL_TIMEOUT_SEC = 10;

before(async () => {
  // PA_HOME must be set before any module-level Blackboard constructor runs.
  dir = await createTempPaHome();
  await createTempConfig(dir, [
    { name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e "0"' },
  ]);
  await mkdir(join(dir, 'markers'), { recursive: true });

  // Never exits on its own — proves catchup's own budget, not this skill's
  // own (generously long) timeout, is what ends the tick.
  await writeFile(join(dir, 'hang.cjs'), 'setInterval(() => {}, 1000);\n', 'utf8');

  await createTempSkill(dir, 'budget-hang', [
    '---',
    'cron: "0 0 1 1 *"',
    `cmd: "node \\"${fwd(join(dir, 'hang.cjs'))}\\""`,
    `timeout: ${HANG_SKILL_TIMEOUT_SEC}`,
    '---',
    'A skill that never exits on its own, used only to prove the outer catchup budget (not this skill\'s own timeout) ends the tick.',
  ].join('\n'));
});

after(async () => {
  // The hang skill's own timeout (comfortably past this file's budget
  // assertions) still needs to fire and kill its spawned child before we
  // delete the temp PA_HOME out from under it: the Promise.race in
  // catchupCommand only stops AWAITING the abandoned dispatch, it does not
  // cancel it (JS has no such thing) — see catchup.ts's budget-exceeded
  // design note. Comfortably longer than HANG_SKILL_TIMEOUT_SEC.
  await new Promise((r) => setTimeout(r, (HANG_SKILL_TIMEOUT_SEC + 5) * 1000));
  await cleanup(dir);
});

describe('pa catchup: wall-clock run budget (2026-09-10 incident fix)', () => {
  it('a run whose skill phase blocks past the budget still runs maintenance, exits via exitFn, and releases its lock', async () => {
    const { catchupCommand, _setExitForTest, CATCHUP_BUDGET_EXCEEDED_EXIT_CODE } = await import('../src/commands/catchup.js');
    const originalBudget = process.env.PA_CATCHUP_BUDGET_MS;
    process.env.PA_CATCHUP_BUDGET_MS = String(BUDGET_MS);

    const exitCalls: Array<number | undefined> = [];
    _setExitForTest((code) => { exitCalls.push(code); });

    try {
      const startedAt = Date.now();
      await catchupCommand();
      const elapsedMs = Date.now() - startedAt;

      // (a) does not wait on the wedged dispatch: returns near its own
      // budget, nowhere near the hang skill's own timeout. This is the line
      // that fails against the pre-fix code — reverting the Promise.race in
      // catchupCommand (or just deleting the budget wiring) makes this ~10s
      // instead of ~3s.
      assert.ok(
        elapsedMs < (BUDGET_MS + (HANG_SKILL_TIMEOUT_SEC * 1000)) / 2,
        `catchupCommand should return near its ${BUDGET_MS}ms budget, not wait for the ${HANG_SKILL_TIMEOUT_SEC}s skill timeout — took ${elapsedMs}ms`,
      );

      // (b) exits via the injected exitFn with the distinct budget-exceeded code
      assert.deepEqual(exitCalls, [CATCHUP_BUDGET_EXCEEDED_EXIT_CODE]);

      // (c) still ran declared maintenance (maintenance runs before skill
      // dispatch in the existing structure; this proves that ordering
      // survived the budget wiring — the maintenance ledger only ever gets
      // written from inside that phase).
      const statePath = join(dir, 'maintenance-state.json');
      const maintenanceRan = await readFile(statePath, 'utf8').catch(() => null);
      assert.ok(maintenanceRan, 'maintenance ledger must exist — the maintenance phase must still have run');

      // (d) releases its own lock — nothing must be left holding `catchup`
      const raw = await readFile(join(dir, 'blackboard.json'), 'utf8').catch(() => '{"active_locks":[]}');
      const data = JSON.parse(raw);
      const locks = data.active_locks.filter((l: { resource: string }) => l.resource === 'catchup');
      assert.equal(locks.length, 0, 'the catchup lock must be released after a budget-exceeded abort');

      // (e) makes the failure legible: one warn log naming a ref-id and what
      // it was waiting on, greppable via `pa ref`.
      const entries = await readAppLog();
      const budgetLogs = entries.filter((e) =>
        e.module === 'catchup' && e.level === 'warn' && String(e.message).includes('exceeded its wall-clock budget'));
      assert.equal(
        budgetLogs.length, 1,
        `expected exactly one budget-exceeded warn log, got: ${JSON.stringify(entries.filter((e) => e.module === 'catchup'))}`,
      );
      assert.equal(budgetLogs[0].lockKey, 'catchup');
      assert.ok(typeof budgetLogs[0].refId === 'string' && (budgetLogs[0].refId as string).length > 0);
      assert.ok(typeof budgetLogs[0].waitingOnPhase === 'string' && (budgetLogs[0].waitingOnPhase as string).length > 0);
    } finally {
      _setExitForTest(null);
      if (originalBudget === undefined) delete process.env.PA_CATCHUP_BUDGET_MS;
      else process.env.PA_CATCHUP_BUDGET_MS = originalBudget;
    }
  });

  it('a second tick right after the first can still acquire the same lock — the wedged first tick does not starve future ticks', async () => {
    const { catchupCommand, _setExitForTest, CATCHUP_BUDGET_EXCEEDED_EXIT_CODE } = await import('../src/commands/catchup.js');
    const originalBudget = process.env.PA_CATCHUP_BUDGET_MS;
    process.env.PA_CATCHUP_BUDGET_MS = String(BUDGET_MS);

    const exitCalls: Array<number | undefined> = [];
    _setExitForTest((code) => { exitCalls.push(code); });

    try {
      const startedAt = Date.now();
      // Same (untopic'd) lock key as the previous test's run — if that run's
      // release had failed, this would print "Another catchup is already
      // running" and return near-instantly WITHOUT ever calling exitFn.
      await catchupCommand();
      const elapsedMs = Date.now() - startedAt;

      assert.ok(
        elapsedMs > BUDGET_MS / 2,
        `second tick returned in ${elapsedMs}ms — too fast to have actually run; it likely bailed out on "already running" instead of acquiring the released lock`,
      );
      assert.deepEqual(
        exitCalls, [CATCHUP_BUDGET_EXCEEDED_EXIT_CODE],
        'second tick must genuinely acquire the lock, run, and hit its own budget again — not be refused as already-running',
      );
    } finally {
      _setExitForTest(null);
      if (originalBudget === undefined) delete process.env.PA_CATCHUP_BUDGET_MS;
      else process.env.PA_CATCHUP_BUDGET_MS = originalBudget;
    }
  });
});
