import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, createTempSkill, cleanup } from './helpers.js';
import { writeLog } from '../src/logger.js';
import {
  failureBackoffDecision,
  partitionOverdueByFailureBackoff,
  FAILURE_BACKOFF_LADDER_MS,
  PARK_AFTER_CONSECUTIVE_FAILURES,
} from '../src/scheduler.js';
import { getFailureState } from '../src/logger.js';
import type { RunMeta, Skill } from '../src/types.js';
import type { OverdueSkill } from '../src/scheduler.js';
import { paHome } from '../src/paths.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

function meta(status: RunMeta['status'], timestamp: string): RunMeta {
  return { worker: 'test', status, exitCode: status === 'success' ? 0 : 1, duration: 1000, timestamp };
}

function makeSkill(name: string): Skill {
  return {
    name,
    path: join(tempDir, 'skills', name, 'skill.md'),
    frontmatter: { cron: '0 * * * *' },
    prompt: 'Test prompt.',
  };
}

function overdueEntry(name: string, missedAt: Date): OverdueSkill {
  return { skill: makeSkill(name), lastRun: null, missedAt };
}

async function latestPointerPath(name: string): Promise<string> {
  return join(paHome(), 'logs', name, 'latest.json');
}

describe('failureBackoffDecision', () => {
  const base = Date.now();

  it('0 failures → run', () => {
    const decision = failureBackoffDecision({
      consecutiveFailures: 0, lastAttemptAtMs: base - 1000, missedAtMs: base - 500, nowMs: base,
    });
    assert.equal(decision, 'run');
  });

  it('fresh occurrence (missedAt > lastAttempt) → run even with many failures', () => {
    const decision = failureBackoffDecision({
      consecutiveFailures: 10, lastAttemptAtMs: base - 10_000, missedAtMs: base - 1_000, nowMs: base,
    });
    assert.equal(decision, 'run');
  });

  it('1 failure → run immediately (ladder[0] = 0)', () => {
    const decision = failureBackoffDecision({
      consecutiveFailures: 1, lastAttemptAtMs: base - 1000, missedAtMs: base - 2000, nowMs: base,
    });
    assert.equal(decision, 'run');
  });

  it('2 failures, 29 min later → defer; 31 min later → run', () => {
    const lastAttemptAtMs = base;
    const missedAtMs = base - 1000; // before last attempt — within same occurrence
    const defer = failureBackoffDecision({
      consecutiveFailures: 2, lastAttemptAtMs, missedAtMs, nowMs: base + 29 * 60_000,
    });
    assert.equal(defer, 'defer');
    const run = failureBackoffDecision({
      consecutiveFailures: 2, lastAttemptAtMs, missedAtMs, nowMs: base + 31 * 60_000,
    });
    assert.equal(run, 'run');
  });

  it('3 failures → 2h boundary', () => {
    const lastAttemptAtMs = base;
    const missedAtMs = base - 1000;
    assert.equal(failureBackoffDecision({
      consecutiveFailures: 3, lastAttemptAtMs, missedAtMs, nowMs: base + 119 * 60_000,
    }), 'defer');
    assert.equal(failureBackoffDecision({
      consecutiveFailures: 3, lastAttemptAtMs, missedAtMs, nowMs: base + 121 * 60_000,
    }), 'run');
  });

  it('4 failures → 8h boundary', () => {
    const lastAttemptAtMs = base;
    const missedAtMs = base - 1000;
    assert.equal(failureBackoffDecision({
      consecutiveFailures: 4, lastAttemptAtMs, missedAtMs, nowMs: base + (8 * 60 - 1) * 60_000,
    }), 'defer');
    assert.equal(failureBackoffDecision({
      consecutiveFailures: 4, lastAttemptAtMs, missedAtMs, nowMs: base + (8 * 60 + 1) * 60_000,
    }), 'run');
  });

  it('5 (and 50) failures → park when missedAt <= lastAttempt', () => {
    const lastAttemptAtMs = base;
    const missedAtMs = base - 1000;
    assert.equal(failureBackoffDecision({
      consecutiveFailures: 5, lastAttemptAtMs, missedAtMs, nowMs: base + 100 * 3_600_000,
    }), 'park');
    assert.equal(failureBackoffDecision({
      consecutiveFailures: 50, lastAttemptAtMs, missedAtMs, nowMs: base + 100 * 3_600_000,
    }), 'park');
  });

  it('sanity: ladder and park threshold constants match spec', () => {
    assert.deepEqual(FAILURE_BACKOFF_LADDER_MS, [0, 30 * 60_000, 2 * 3_600_000, 8 * 3_600_000]);
    assert.equal(PARK_AFTER_CONSECUTIVE_FAILURES, 5);
  });
});

describe('getFailureState', () => {
  it('success then 3 errors → consecutiveFailures 3, lastAttemptAt = last error timestamp', async () => {
    const t0 = new Date(Date.now() - 4 * 60_000).toISOString();
    const t1 = new Date(Date.now() - 3 * 60_000).toISOString();
    const t2 = new Date(Date.now() - 2 * 60_000).toISOString();
    const t3 = new Date(Date.now() - 1 * 60_000).toISOString();
    await writeLog('flaky', 'out', meta('success', t0));
    await writeLog('flaky', 'out', meta('error', t1));
    await writeLog('flaky', 'out', meta('error', t2));
    await writeLog('flaky', 'out', meta('error', t3));

    const state = await getFailureState('flaky');
    assert.equal(state.consecutiveFailures, 3);
    assert.equal(state.lastAttemptAt, t3);
  });

  it('errors then a success → 0', async () => {
    const t0 = new Date(Date.now() - 3 * 60_000).toISOString();
    const t1 = new Date(Date.now() - 2 * 60_000).toISOString();
    const t2 = new Date(Date.now() - 1 * 60_000).toISOString();
    await writeLog('recovers', 'out', meta('error', t0));
    await writeLog('recovers', 'out', meta('error', t1));
    await writeLog('recovers', 'out', meta('success', t2));

    const state = await getFailureState('recovers');
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.lastAttemptAt, t2);
  });

  it('no runs at all → { 0, null }', async () => {
    const state = await getFailureState('never-ran');
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.lastAttemptAt, null);
  });

  it('pre-migration pointer without the field falls back to degraded count of 1', async () => {
    const t0 = new Date(Date.now() - 2 * 60_000).toISOString();
    const t1 = new Date(Date.now() - 1 * 60_000).toISOString();
    await writeLog('legacy-pointer', 'out', meta('error', t0));
    await writeLog('legacy-pointer', 'out', meta('error', t1));

    const pointerPath = await latestPointerPath('legacy-pointer');
    const raw = JSON.parse(await readFile(pointerPath, 'utf8'));
    delete raw.consecutiveFailures;
    await writeFile(pointerPath, JSON.stringify(raw), 'utf8');

    const state = await getFailureState('legacy-pointer');
    assert.equal(state.consecutiveFailures, 1);
    assert.equal(state.lastAttemptAt, t1);
  });

  it('no pointer file at all → bounded-scan fallback counts correctly', async () => {
    const t0 = new Date(Date.now() - 3 * 60_000).toISOString();
    const t1 = new Date(Date.now() - 2 * 60_000).toISOString();
    const t2 = new Date(Date.now() - 1 * 60_000).toISOString();
    await writeLog('no-pointer', 'out', meta('success', t0));
    await writeLog('no-pointer', 'out', meta('error', t1));
    await writeLog('no-pointer', 'out', meta('error', t2));

    const pointerPath = await latestPointerPath('no-pointer');
    await unlink(pointerPath).catch(() => {});

    const state = await getFailureState('no-pointer');
    assert.equal(state.consecutiveFailures, 2);
    assert.equal(state.lastAttemptAt, t2);
  });
});

describe('partitionOverdueByFailureBackoff', () => {
  it('5 consecutive failed runs, missedAt before last failure → parked', async () => {
    const t0 = new Date(Date.now() - 50 * 60_000).toISOString();
    const t1 = new Date(Date.now() - 40 * 60_000).toISOString();
    const t2 = new Date(Date.now() - 30 * 60_000).toISOString();
    const t3 = new Date(Date.now() - 20 * 60_000).toISOString();
    const t4 = new Date(Date.now() - 10 * 60_000).toISOString();
    for (const t of [t0, t1, t2, t3, t4]) {
      await writeLog('parked-skill', 'out', meta('error', t));
    }
    const missedAt = new Date(Date.now() - 45 * 60_000); // before t1..t4
    const overdue = [overdueEntry('parked-skill', missedAt)];

    const partition = await partitionOverdueByFailureBackoff(overdue);
    assert.equal(partition.runnable.length, 0);
    assert.equal(partition.deferred.length, 0);
    assert.equal(partition.parked.length, 1);
    assert.equal(partition.parked[0].consecutiveFailures, 5);
  });

  it('5 consecutive failed runs, missedAt after last failure → runnable', async () => {
    const t0 = new Date(Date.now() - 50 * 60_000).toISOString();
    const t1 = new Date(Date.now() - 40 * 60_000).toISOString();
    const t2 = new Date(Date.now() - 30 * 60_000).toISOString();
    const t3 = new Date(Date.now() - 20 * 60_000).toISOString();
    const t4 = new Date(Date.now() - 10 * 60_000).toISOString();
    for (const t of [t0, t1, t2, t3, t4]) {
      await writeLog('fresh-occurrence-skill', 'out', meta('error', t));
    }
    const missedAt = new Date(Date.now() - 5 * 60_000); // after t4
    const overdue = [overdueEntry('fresh-occurrence-skill', missedAt)];

    const partition = await partitionOverdueByFailureBackoff(overdue);
    assert.equal(partition.runnable.length, 1);
    assert.equal(partition.parked.length, 0);
    assert.equal(partition.deferred.length, 0);
  });

  it('2 failures, last one 5 min ago, missedAt before it → deferred with retryAtMs ≈ +30min', async () => {
    const t0 = new Date(Date.now() - 15 * 60_000).toISOString();
    const t1 = new Date(Date.now() - 5 * 60_000).toISOString();
    await writeLog('deferred-skill', 'out', meta('error', t0));
    await writeLog('deferred-skill', 'out', meta('error', t1));
    const missedAt = new Date(Date.now() - 10 * 60_000); // before t1
    const overdue = [overdueEntry('deferred-skill', missedAt)];

    const partition = await partitionOverdueByFailureBackoff(overdue);
    assert.equal(partition.runnable.length, 0);
    assert.equal(partition.parked.length, 0);
    assert.equal(partition.deferred.length, 1);
    const expectedRetryAtMs = new Date(t1).getTime() + 30 * 60_000;
    assert.ok(
      Math.abs(partition.deferred[0].retryAtMs - expectedRetryAtMs) < 1000,
      `retryAtMs ${partition.deferred[0].retryAtMs} should be close to ${expectedRetryAtMs}`
    );
    assert.equal(partition.deferred[0].consecutiveFailures, 2);
  });

  it('on_missed all: two entries for same skill, one old missedAt + one fresh → mixed decisions', async () => {
    const t0 = new Date(Date.now() - 15 * 60_000).toISOString();
    const t1 = new Date(Date.now() - 5 * 60_000).toISOString();
    await writeLog('mixed-skill', 'out', meta('error', t0));
    await writeLog('mixed-skill', 'out', meta('error', t1));

    const oldMissedAt = new Date(Date.now() - 20 * 60_000); // before t0 and t1
    const freshMissedAt = new Date(Date.now() - 1 * 60_000); // after t1
    const overdue = [
      overdueEntry('mixed-skill', oldMissedAt),
      overdueEntry('mixed-skill', freshMissedAt),
    ];

    const partition = await partitionOverdueByFailureBackoff(overdue);
    assert.equal(partition.runnable.length, 1, 'the fresh-occurrence entry should be runnable');
    assert.equal(partition.deferred.length, 1, 'the old-occurrence entry should be deferred (2 failures, within 30m ladder)');
    assert.equal(partition.parked.length, 0);
  });

  it('healthy skill (last run success) → runnable', async () => {
    const t0 = new Date(Date.now() - 60 * 60_000).toISOString();
    await writeLog('healthy-skill', 'out', meta('success', t0));
    const missedAt = new Date(Date.now() - 5 * 60_000);
    const overdue = [overdueEntry('healthy-skill', missedAt)];

    const partition = await partitionOverdueByFailureBackoff(overdue);
    assert.equal(partition.runnable.length, 1);
    assert.equal(partition.deferred.length, 0);
    assert.equal(partition.parked.length, 0);
  });

  it('never-run skill (no logs at all) → runnable', async () => {
    const missedAt = new Date(Date.now() - 5 * 60_000);
    const overdue = [overdueEntry('never-run-skill', missedAt)];

    const partition = await partitionOverdueByFailureBackoff(overdue);
    assert.equal(partition.runnable.length, 1);
  });
});

/**
 * The pacing contract as DOCUMENTED (CLAUDE.md "Scheduler -> Catchup", and
 * scheduler.ts's own comment on FAILURE_BACKOFF_LADDER_MS): 0 / 30m / 2h / 8h,
 * then park at 5. The per-rung tests above check the rungs individually; these
 * pin the sequence as a whole plus the invariant that makes backoff safe to
 * ship — so a future edit to the ladder has to come here and change the
 * documented numbers deliberately rather than drift silently.
 */
describe('AI-098 documented pacing contract', () => {
  const base = Date.now();
  // missedAt BEFORE the last attempt = a retry within the same missed
  // occurrence, which is the only situation backoff is allowed to suppress.
  const missedAtMs = base - 1000;

  const DOCUMENTED: Array<number | 'park'> = [
    0,             // 1 consecutive failure — immediate retry
    30 * 60_000,   // 2
    2 * 3_600_000, // 3
    8 * 3_600_000, // 4
    'park',        // 5 and beyond
  ];

  it('each rung defers until exactly its delay has elapsed, then runs', () => {
    for (let failures = 1; failures <= DOCUMENTED.length; failures++) {
      const expected = DOCUMENTED[failures - 1];
      if (expected === 'park') {
        assert.equal(
          failureBackoffDecision({
            consecutiveFailures: failures, lastAttemptAtMs: base, missedAtMs,
            nowMs: base + 365 * 24 * 3_600_000,
          }),
          'park',
          `${failures} consecutive failures must park, not merely defer`,
        );
        continue;
      }
      if (expected > 0) {
        assert.equal(
          failureBackoffDecision({
            consecutiveFailures: failures, lastAttemptAtMs: base, missedAtMs,
            nowMs: base + expected - 1000,
          }),
          'defer',
          `${failures} failures: must still be deferred 1s before the ${expected}ms rung`,
        );
      }
      assert.equal(
        failureBackoffDecision({
          consecutiveFailures: failures, lastAttemptAtMs: base, missedAtMs,
          nowMs: base + expected,
        }),
        'run',
        `${failures} failures: must run once ${expected}ms has elapsed`,
      );
    }
  });

  it('ladder length and park threshold stay in lockstep', () => {
    assert.deepEqual(FAILURE_BACKOFF_LADDER_MS, DOCUMENTED.slice(0, -1));
    assert.equal(
      FAILURE_BACKOFF_LADDER_MS.length + 1,
      PARK_AFTER_CONSECUTIVE_FAILURES,
      'park must kick in exactly one step past the last ladder rung — otherwise a rung is unreachable or a gap opens',
    );
  });

  it('backoff never throttles a skill below its own cron schedule', () => {
    // A minutely skill that fails every single attempt: each catchup pass sees
    // a FRESH occurrence (the minute boundary that fired after the previous
    // attempt), so the decision must stay 'run' no matter how high the failure
    // count climbs. This is the guardrail that keeps AI-098 from turning a
    // storm fix into a silent outage.
    let lastAttemptAtMs = base;
    for (let failures = 1; failures <= 120; failures++) {
      const freshMissedAtMs = lastAttemptAtMs + 60_000; // next minute boundary
      const nowMs = freshMissedAtMs + 5_000;            // catchup notices it 5s later
      assert.equal(
        failureBackoffDecision({ consecutiveFailures: failures, lastAttemptAtMs, missedAtMs: freshMissedAtMs, nowMs }),
        'run',
        `failure #${failures}: a fresh cron occurrence must always grant one attempt`,
      );
      lastAttemptAtMs = nowMs; // that attempt fails too
    }
  });
});
