/**
 * Tests for the catchup completion-race + live-run dispatch guards
 * (2026-09-13 oracle double-run, vi-6ab06170497f).
 *
 * The defect: the loop's two existing guards are non-atomic across a run's
 * completion. Guard 1 (disk) reads getOverdueSkills/getLastSuccessfulRun at
 * tick start; Guard 2 (memory) checks activeSkillRuns at dispatch time. A run
 * that COMPLETES between those two reads is invisible to both — its success
 * pointer wasn't written when the tick computed overdue, and it is no longer
 * in activeSkillRuns when the dispatch decision fires — so the tick
 * re-dispatches it and the skill's output is served twice.
 *
 * Uses dynamic imports (not static) so that the Blackboard singleton is
 * initialised AFTER createTempPaHome() sets PA_HOME, mirroring
 * catchup.test.ts.
 *
 * Every tick below is TOPIC-SCOPED (`catchupCommand({ topic: 'default' })`):
 * a topic tick is skills-only — the topic-less one-shot also drives the full
 * declared-maintenance pass (real python jobs, tens of seconds under machine
 * load), which both blows these cases' backstops and is unrelated to the
 * dispatch-loop guards under test. The fixture skills carry no `topic:`
 * frontmatter, so they default to the 'default' topic the tick filters on.
 */
import './test-env-guard.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, createTempConfig, createTempSkill, cleanup } from './helpers.js';

/** Pointer seeding helper: writes logs/<skill>/latest.json the same shape
 *  writeLog() produces (logger.ts LatestPointer). */
async function seedSuccessPointer(dir: string, skill: string, iso: string): Promise<void> {
  const meta = { worker: 'zclaude', status: 'success', exitCode: 0, duration: 1000, timestamp: iso };
  await mkdir(join(dir, 'logs', skill), { recursive: true });
  await writeFile(join(dir, 'logs', skill, 'latest.json'), JSON.stringify({
    latest: meta, latestSuccess: meta, consecutiveFailures: 0,
  }), 'utf8');
}
async function countMetas(dir: string, skill: string): Promise<number> {
  return ((await readdir(join(dir, 'logs', skill)).catch(() => [])) as string[])
    .filter(f => f.endsWith('.meta')).length;
}

/** Captures every console.log call made during fn(), then restores it. */
async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

/** Skill frontmatter for the fixtures: cron every minute → always overdue;
 *  `cmd: "node -e \"0\""` → fast shell dispatch whose .meta is the observable. */
function skillMd(onMissed: 'latest' | 'all' = 'latest'): string {
  return [
    '---',
    'cron: "* * * * *"',
    `on_missed: ${onMissed}`,
    'cmd: "node -e \\"0\\""',
    '---',
    'body',
  ].join('\n');
}

const DUMMY_WORKER = [{ name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e "0"' }];

// ---------------------------------------------------------------------------
// T1 — pure helper matrix (unit, no PA_HOME needed)
// ---------------------------------------------------------------------------
describe('completionRaceSkip (pure decision)', () => {
  it('skips only when a success newer than the tick-start snapshot has landed', async () => {
    const { completionRaceSkip } = await import('../src/commands/catchup.js');

    // (a) the EXACT 2026-09-13 oracle incident values: the tick planned
    // against the 2026-09-12 success; run A completed 08:19:19.453Z on
    // 2026-09-13; run B was dispatched ~1-2s later. This assertion is what
    // proves the guard would have blocked run B.
    assert.equal(
      completionRaceSkip(
        { worker: 'zclaude', status: 'success', exitCode: 0, duration: 1029700, timestamp: '2026-09-12T08:00:05.000Z' },
        { worker: 'zclaude', status: 'success', exitCode: 0, duration: 1029700, timestamp: '2026-09-13T08:19:19.453Z' },
      ),
      true,
      'a success newer than the snapshot must skip',
    );

    const snap = { worker: 'zclaude', status: 'success' as const, exitCode: 0, duration: 1, timestamp: '2026-09-12T08:00:05.000Z' };
    // (b) fresh === snapshot — the same run the snapshot already saw → not a skip
    assert.equal(completionRaceSkip(snap, snap), false);
    // (c) fresh older than snapshot → not a skip
    assert.equal(
      completionRaceSkip(
        snap,
        { worker: 'zclaude', status: 'success', exitCode: 0, duration: 1, timestamp: '2026-09-11T08:00:05.000Z' },
      ),
      false,
    );
    // (d) fresh null → not a skip
    assert.equal(completionRaceSkip(snap, null), false);
    // (e) snapshot null, fresh set — first-ever success landed mid-tick → skip
    assert.equal(
      completionRaceSkip(null, { worker: 'zclaude', status: 'success', exitCode: 0, duration: 1, timestamp: '2026-09-13T08:19:19.453Z' }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// T2 — integration: completion race via the occupied-slot seam
// ---------------------------------------------------------------------------
describe('completion-race guard: mid-tick success is not re-dispatched', () => {
  let dir: string;

  before(async () => {
    dir = await createTempPaHome();
    await createTempConfig(dir, DUMMY_WORKER);
  });

  after(async () => {
    await cleanup(dir);
  });

  it('skips race-oracle when a success lands while the tick is blocked on a slot', async () => {
    const { catchupCommand } = await import('../src/commands/catchup.js');
    const { blackboard } = await import('../src/blackboard.js');

    const originalCeiling = process.env.PA_MAX_CONCURRENT_WORKERS;
    const originalKillSwitch = process.env.PA_DYNAMIC_SLOTS;
    process.env.PA_MAX_CONCURRENT_WORKERS = '1';
    delete process.env.PA_DYNAMIC_SLOTS;

    let lockAcquired = false;
    try {
      await createTempSkill(dir, 'race-oracle', skillMd('latest'));
      await seedSuccessPointer(dir, 'race-oracle', '2026-09-12T08:00:05.000Z');

      // Occupy the sole concurrency slot with a foreign skill lock so the
      // tick blocks INSIDE its dispatch loop — the seam where the incident's
      // stale snapshot decision happened.
      const foreignPid = process.ppid;
      lockAcquired = await blackboard.acquireLock('skill-other', 'test-agent', foreignPid, 5000);
      assert.equal(lockAcquired, true, 'setup: foreign skill lock must be acquired');

      let lines: string[] = [];
      lines = await captureLog(async () => {
        const catchupPromise = catchupCommand({ topic: 'default' });
        // Mid-tick: run A "completes" — its success pointer lands — then the
        // slot frees. The dispatch decision for race-oracle now happens AFTER
        // a success newer than the snapshot exists.
        await new Promise((r) => setTimeout(r, 2500));
        await seedSuccessPointer(dir, 'race-oracle', new Date().toISOString());
        await blackboard.releaseLock('skill-other', 'test-agent');
        lockAcquired = false;
        await Promise.race([
          catchupPromise,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error('catchup did not complete within 12s — completion-race guard did not fire')),
            12000,
          )),
        ]);
      });

      const metas = await countMetas(dir, 'race-oracle');
      assert.equal(metas, 0, `expected 0 metas (skill must be skipped), found ${metas}`);
      assert.ok(
        lines.some((l) => l.includes('skipped (completion-race guard)')),
        `expected the completion-race guard line in console output, got: ${JSON.stringify(lines)}`,
      );
    } finally {
      if (lockAcquired) await blackboard.releaseLock('skill-other', 'test-agent').catch(() => {});
      if (originalCeiling === undefined) delete process.env.PA_MAX_CONCURRENT_WORKERS;
      else process.env.PA_MAX_CONCURRENT_WORKERS = originalCeiling;
      if (originalKillSwitch === undefined) delete process.env.PA_DYNAMIC_SLOTS;
      else process.env.PA_DYNAMIC_SLOTS = originalKillSwitch;
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — control for T2: proves the check can FAIL on the good→bad axis
// ---------------------------------------------------------------------------
describe('completion-race guard control: no mid-tick success still dispatches', () => {
  let dir: string;

  before(async () => {
    dir = await createTempPaHome();
    await createTempConfig(dir, DUMMY_WORKER);
  });

  after(async () => {
    await cleanup(dir);
  });

  it('dispatches race-oracle when no success lands mid-tick', async () => {
    const { catchupCommand } = await import('../src/commands/catchup.js');
    const { blackboard } = await import('../src/blackboard.js');

    const originalCeiling = process.env.PA_MAX_CONCURRENT_WORKERS;
    const originalKillSwitch = process.env.PA_DYNAMIC_SLOTS;
    process.env.PA_MAX_CONCURRENT_WORKERS = '1';
    delete process.env.PA_DYNAMIC_SLOTS;

    let lockAcquired = false;
    try {
      await createTempSkill(dir, 'race-oracle', skillMd('latest'));
      await seedSuccessPointer(dir, 'race-oracle', '2026-09-12T08:00:05.000Z');

      const foreignPid = process.ppid;
      lockAcquired = await blackboard.acquireLock('skill-other', 'test-agent', foreignPid, 5000);
      assert.equal(lockAcquired, true, 'setup: foreign skill lock must be acquired');

      const lines: string[] = await captureLog(async () => {
        const catchupPromise = catchupCommand({ topic: 'default' });
        // Mid-tick: write NOTHING — the pointer stays yesterday's, exactly
        // the good case the guard must not suppress.
        await new Promise((r) => setTimeout(r, 2500));
        await blackboard.releaseLock('skill-other', 'test-agent');
        lockAcquired = false;
        await Promise.race([
          catchupPromise,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error('catchup did not complete within 12s')),
            12000,
          )),
        ]);
      });

      const metas = await countMetas(dir, 'race-oracle');
      assert.ok(metas >= 1, `expected the skill to dispatch (>=1 meta), found ${metas}`);
      assert.ok(
        !lines.some((l) => l.includes('skipped (completion-race guard)')),
        `guard line must NOT appear in the control case, got: ${JSON.stringify(lines)}`,
      );
    } finally {
      if (lockAcquired) await blackboard.releaseLock('skill-other', 'test-agent').catch(() => {});
      if (originalCeiling === undefined) delete process.env.PA_MAX_CONCURRENT_WORKERS;
      else process.env.PA_MAX_CONCURRENT_WORKERS = originalCeiling;
      if (originalKillSwitch === undefined) delete process.env.PA_DYNAMIC_SLOTS;
      else process.env.PA_DYNAMIC_SLOTS = originalKillSwitch;
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — integration: live-run guard (cross-process blackboard lock)
// ---------------------------------------------------------------------------
describe('live-run guard: a live foreign lock on skill-<name> is not re-dispatched', () => {
  let dir: string;

  before(async () => {
    dir = await createTempPaHome();
    await createTempConfig(dir, DUMMY_WORKER);
  });

  after(async () => {
    await cleanup(dir);
  });

  it('skips live-racer while another process holds its skill lock', async () => {
    const { catchupCommand } = await import('../src/commands/catchup.js');
    const { blackboard } = await import('../src/blackboard.js');

    let lockAcquired = false;
    let lines: string[] = [];
    try {
      await createTempSkill(dir, 'live-racer', skillMd('latest'));
      await seedSuccessPointer(dir, 'live-racer', '2026-09-12T08:00:05.000Z');

      const foreignPid = process.ppid;
      lockAcquired = await blackboard.acquireLock('skill-live-racer', 'test-agent', foreignPid, 5000);
      assert.equal(lockAcquired, true, 'setup: foreign live-racer lock must be acquired');

      lines = await captureLog(() => catchupCommand({ topic: 'default' }));

      const metas = await countMetas(dir, 'live-racer');
      assert.equal(metas, 0, `expected 0 metas (live run in another process), found ${metas}`);
      assert.ok(
        lines.some((l) => l.includes('skipped (live-run guard)')),
        `expected the live-run guard line in console output, got: ${JSON.stringify(lines)}`,
      );
    } finally {
      if (lockAcquired) await blackboard.releaseLock('skill-live-racer', 'test-agent').catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// T5 — integration: 'all' non-interference
// ---------------------------------------------------------------------------
describe("completion-race guard does not suppress on_missed 'all'", () => {
  let dir: string;

  before(async () => {
    dir = await createTempPaHome();
    await createTempConfig(dir, DUMMY_WORKER);
  });

  after(async () => {
    await cleanup(dir);
  });

  it("dispatches all-racer entries despite a stale snapshot", async () => {
    const { catchupCommand } = await import('../src/commands/catchup.js');

    let lines: string[] = [];
    try {
      await createTempSkill(dir, 'all-racer', skillMd('all'));
      await seedSuccessPointer(dir, 'all-racer', '2026-09-12T08:00:05.000Z');

      lines = await captureLog(() => catchupCommand({ topic: 'default' }));

      const metas = await countMetas(dir, 'all-racer');
      assert.ok(metas >= 1, `expected 'all' dispatches to proceed (>=1 meta), found ${metas}`);
      assert.ok(
        !lines.some((l) => l.includes('all-racer') && l.includes('completion-race guard')),
        `'all' skill must not be suppressed by the completion-race guard, got: ${JSON.stringify(lines)}`,
      );
      assert.ok(
        !lines.some((l) => l.includes('all-racer') && l.includes('live-run guard')),
        `'all' skill must not be suppressed by the live-run guard, got: ${JSON.stringify(lines)}`,
      );
    } finally {
      // nothing held
    }
  });
});
