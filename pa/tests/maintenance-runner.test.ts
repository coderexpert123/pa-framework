import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'fs/promises';
import lockfile from 'proper-lockfile';
import { tmpdir } from 'os';
import { join } from 'path';
import { decideJob, runDueJobs, resolveEveryMs } from '../src/lib/maintenance/runner.js';
import { readLedger, maintenanceStatePath } from '../src/lib/maintenance/state.js';
import type { MaintenanceJob } from '../src/lib/maintenance/types.js';
import { rmRetry } from './rm-retry.js';

const HOUR = 3_600_000; // 1 hour in milliseconds

let tempDir: string;
let originalPaHome: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pa-maintenance-runner-'));
  originalPaHome = process.env.PA_HOME;
  process.env.PA_HOME = tempDir;
});

afterEach(async () => {
  await rmRetry(tempDir);
  if (originalPaHome === undefined) delete process.env.PA_HOME;
  else process.env.PA_HOME = originalPaHome;
});

describe('decideJob (pure)', () => {
  const everyMs = 60_000;
  const base = 1_000_000_000;

  it('never run before (lastRunAtMs null) → run', () => {
    assert.deepEqual(
      decideJob({ everyMs, lastRunAtMs: null, nowMs: base, enabled: true, degraded: false, shedWhenDegraded: true, inFlight: false, force: false }),
      { action: 'run' },
    );
  });

  it('due (now - lastRun >= everyMs) → run', () => {
    assert.deepEqual(
      decideJob({ everyMs, lastRunAtMs: base - everyMs, nowMs: base, enabled: true, degraded: false, shedWhenDegraded: true, inFlight: false, force: false }),
      { action: 'run' },
    );
  });

  it('not due (now - lastRun < everyMs) → skip not-due', () => {
    assert.deepEqual(
      decideJob({ everyMs, lastRunAtMs: base - everyMs + 1, nowMs: base, enabled: true, degraded: false, shedWhenDegraded: true, inFlight: false, force: false }),
      { action: 'skip', skipReason: 'not-due' },
    );
  });

  it('disabled → skip disabled even when overdue', () => {
    assert.deepEqual(
      decideJob({ everyMs, lastRunAtMs: base - 10 * everyMs, nowMs: base, enabled: false, degraded: false, shedWhenDegraded: true, inFlight: false, force: false }),
      { action: 'skip', skipReason: 'disabled' },
    );
  });

  it('degraded + shedWhenDegraded → skip degraded', () => {
    assert.deepEqual(
      decideJob({ everyMs, lastRunAtMs: base - 10 * everyMs, nowMs: base, enabled: true, degraded: true, shedWhenDegraded: true, inFlight: false, force: false }),
      { action: 'skip', skipReason: 'degraded' },
    );
  });

  it('degraded + shedWhenDegraded:false → RUN — e.g. dlq-flush, which must never be shed even under DEGRADED', () => {
    assert.deepEqual(
      decideJob({ everyMs, lastRunAtMs: base - 10 * everyMs, nowMs: base, enabled: true, degraded: true, shedWhenDegraded: false, inFlight: false, force: false }),
      { action: 'run' },
    );
  });

  it('in-flight beats force', () => {
    assert.deepEqual(
      decideJob({ everyMs, lastRunAtMs: base, nowMs: base, enabled: true, degraded: false, shedWhenDegraded: true, inFlight: true, force: true }),
      { action: 'skip', skipReason: 'in-flight' },
    );
  });

  it('force overrides disabled/degraded/not-due', () => {
    assert.deepEqual(
      decideJob({ everyMs, lastRunAtMs: base, nowMs: base, enabled: false, degraded: true, shedWhenDegraded: true, inFlight: false, force: true }),
      { action: 'run' },
    );
  });

  it('1st failure retries immediately (ladder[0] === 0)', () => {
    assert.deepEqual(
      decideJob({
        everyMs, lastRunAtMs: null, nowMs: base, enabled: true, degraded: false, shedWhenDegraded: true, inFlight: false, force: false,
        lastAttemptAtMs: base - 1, consecutiveFailures: 1,
      }),
      { action: 'run' },
    );
  });

  it('2nd failure inside 30 min → skip failure-backoff', () => {
    assert.deepEqual(
      decideJob({
        everyMs, lastRunAtMs: null, nowMs: base, enabled: true, degraded: false, shedWhenDegraded: true, inFlight: false, force: false,
        lastAttemptAtMs: base - 1_000_000, consecutiveFailures: 2,
      }),
      { action: 'skip', skipReason: 'failure-backoff' },
    );
  });

  it('2nd failure after 31 min → run', () => {
    assert.deepEqual(
      decideJob({
        everyMs, lastRunAtMs: null, nowMs: base, enabled: true, degraded: false, shedWhenDegraded: true, inFlight: false, force: false,
        lastAttemptAtMs: base - 31 * 60_000, consecutiveFailures: 2,
      }),
      { action: 'run' },
    );
  });

  it('5th and 9th failure both use the 24 h rung', () => {
    const dayMs = 24 * 3_600_000;
    for (const consecutiveFailures of [5, 9]) {
      assert.deepEqual(
        decideJob({
          everyMs, lastRunAtMs: null, nowMs: base, enabled: true, degraded: false, shedWhenDegraded: true, inFlight: false, force: false,
          lastAttemptAtMs: base - (dayMs - 1), consecutiveFailures,
        }),
        { action: 'skip', skipReason: 'failure-backoff' },
        `consecutiveFailures=${consecutiveFailures} should still be inside the 24h rung`,
      );
      assert.deepEqual(
        decideJob({
          everyMs, lastRunAtMs: null, nowMs: base, enabled: true, degraded: false, shedWhenDegraded: true, inFlight: false, force: false,
          lastAttemptAtMs: base - (dayMs + 1), consecutiveFailures,
        }),
        { action: 'run' },
        `consecutiveFailures=${consecutiveFailures} should clear after 24h`,
      );
    }
  });

  it('force beats failure-backoff', () => {
    assert.deepEqual(
      decideJob({
        everyMs, lastRunAtMs: null, nowMs: base, enabled: true, degraded: false, shedWhenDegraded: true, inFlight: false, force: true,
        lastAttemptAtMs: base - 1000, consecutiveFailures: 3,
      }),
      { action: 'run' },
    );
  });

  it('consecutiveFailures 0 → ladder never consulted (omitted args behave exactly as before)', () => {
    assert.deepEqual(
      decideJob({ everyMs, lastRunAtMs: base - everyMs, nowMs: base, enabled: true, degraded: false, shedWhenDegraded: true, inFlight: false, force: false }),
      { action: 'run' },
    );
  });
});

function makeJob(overrides: Partial<MaintenanceJob> & { name: string }): MaintenanceJob {
  return {
    host: 'pa',
    everyMs: 60_000,
    description: 'test job',
    destructive: false,
    shedWhenDegraded: true,
    targets: [],
    run: async () => ({ touched: 0 }),
    ...overrides,
  };
}

interface FakeNotifyCall {
  subject: string;
  body: string;
  opts?: { dedupKey?: string; dedupWindowMs?: number; severity?: 'info' | 'warn' | 'error'; replyMarkup?: Record<string, unknown> };
}

function makeFakeNotify(): { notify: (subject: string, body: string, opts?: any) => Promise<{ sent: boolean; suppressed: boolean }>; calls: FakeNotifyCall[] } {
  const calls: FakeNotifyCall[] = [];
  const notify = async (subject: string, body: string, opts?: any) => {
    calls.push({ subject, body, opts });
    return { sent: true, suppressed: false };
  };
  return { notify, calls };
}

/**
 * Polls `predicate` until it returns true, instead of a fixed sleep. A
 * parallel pass (S8) settles its detached completion (job body + the
 * three-layer-serialized `updateJobState` write) on its own schedule; a
 * fixed `setTimeout` guess flaked under shared-tree contention (observed
 * 2026-09-11 — a ~150ms fixed wait was sometimes not enough). Fails loudly
 * (never a silent pass) if the condition never holds within the budget.
 *
 * intervalMs defaults to 50ms, not tighter: a predicate that calls
 * readLedger() is a plain unlocked readFile, and polling it too often
 * measurably raises the odds of colliding with updateJobState's own
 * lock+atomic-rename write (Windows refuses to rename over a file that is
 * open elsewhere — the exact EPERM class atomic-write.ts's renameWithRetry
 * exists for, AI-150) — observed 2026-09-11: an 8-job concurrent-completion
 * pass hit `EPERM ... rename ... maintenance-state.json` after exhausting
 * renameWithRetry's 5 attempts while this test's own poll loop was reading
 * the same file every 10ms. This is a pre-existing hazard in state.ts (out
 * of this file's ownership) between an unlocked reader and the atomic
 * rename; the fix in scope here is to not manufacture it by over-polling.
 */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000, intervalMs = 50): Promise<void> {
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!(await predicate())) {
    throw new Error(`waitUntil: condition not met within ~${timeoutMs}ms`);
  }
}

describe('runDueJobs', () => {
  it('a job that ran advances lastRunAt and resets consecutiveFailures', async () => {
    const job = makeJob({ name: 'touches-two', run: async () => ({ touched: 2 }) });
    const { notify } = makeFakeNotify();
    const records = await runDueJobs('pa', [job], { notify });
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'ran');
    assert.equal(records[0].touched, 2);
    const ledger = await readLedger();
    assert.ok(ledger.jobs['touches-two'].lastRunAt);
    assert.equal(ledger.jobs['touches-two'].consecutiveFailures, 0);
  });

  it('failure isolation: a throwing job does not stop the rest, and its lastRunAt stays unchanged', async () => {
    const throwingJob = makeJob({ name: 'throws', run: async () => { throw new Error('boom'); } });
    const okJob = makeJob({ name: 'ok', run: async () => ({ touched: 1 }) });
    const { notify } = makeFakeNotify();
    const records = await runDueJobs('pa', [throwingJob, okJob], { notify });
    assert.deepEqual(records.map((r) => r.outcome), ['failed', 'ran']);

    const ledger = await readLedger();
    assert.equal(ledger.jobs['throws'].lastRunAt, undefined, 'a failing job must stay due next pass');
    assert.equal(ledger.jobs['throws'].consecutiveFailures, 1);
    assert.ok(ledger.jobs['ok'].lastRunAt);
  });

  it('failure pages with the right dedupKey and severity', async () => {
    const throwingJob = makeJob({ name: 'pages-on-fail', run: async () => { throw new Error('boom'); } });
    const { notify, calls } = makeFakeNotify();
    await runDueJobs('pa', [throwingJob], { notify });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts?.dedupKey, 'maintenance-failed-pages-on-fail');
    assert.equal(calls[0].opts?.severity, 'error');
  });

  it('failure notify carries a "▶ Run now" replyMarkup for sk:job:<name> (WP-P2)', async () => {
    const throwingJob = makeJob({ name: 'pages-on-fail-kb', run: async () => { throw new Error('boom'); } });
    const { notify, calls } = makeFakeNotify();
    await runDueJobs('pa', [throwingJob], { notify });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].opts?.replyMarkup, {
      inline_keyboard: [[{ text: '▶ Run now', callback_data: 'sk:job:pages-on-fail-kb' }]],
    });
  });

  it('in-flight guard: concurrent runDueJobs calls for the same job — second is skipped IMMEDIATELY, run() invoked once (AI-196: skip stays wait-free)', async () => {
    let runCount = 0;
    let releaseRun!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRun = resolve; });
    const job = makeJob({
      name: 'slow-job',
      run: async () => {
        runCount++;
        await gate;
        return { touched: 0 };
      },
    });
    const { notify } = makeFakeNotify();

    const first = runDueJobs('pa', [job], { notify });
    // Give the first call's synchronous claim time to land before starting the second.
    await new Promise((r) => setTimeout(r, 20));
    const second = runDueJobs('pa', [job], { notify });

    // AI-196 (closed-by-proof 2026-09-03): the pa host makes one awaited
    // runDueJobs pass per process, so skip:in-flight can never burn a due-check
    // in production and the guard must stay WAIT-FREE. Awaiting `second` to
    // completion while the gate still holds the slot fails mechanically (test
    // timeout) if a bounded wait-and-redecide is ever reintroduced — such a
    // wait would poll for the very slot this gate keeps closed.
    const secondRecords = await second;
    assert.equal(secondRecords[0].outcome, 'skipped');
    assert.equal(secondRecords[0].skipReason, 'in-flight');

    releaseRun();
    const firstRecords = await first;
    assert.equal(firstRecords[0].outcome, 'ran');
    assert.equal(runCount, 1);
  });

  it('skipped-too-long page fires once lastRunAt is more than 3x cadence stale, degraded+shed', async () => {
    // everyMs picked so 3*everyMs (1,500,000ms) clears the 15 min floor
    // (skippedTooLongThreshold floor, 2026-08-23) — this test exercises the
    // 3x-multiplier branch specifically; the floor itself is covered by
    // describe('skippedTooLongThreshold floor') below.
    const everyMs = 500_000;
    const now = 10_000_000;
    const job = makeJob({ name: 'stale-degraded', everyMs, shedWhenDegraded: true });
    const { notify, calls } = makeFakeNotify();

    // Seed the ledger: lastRunAt = now - 4*everyMs (older than the 3x threshold).
    await runDueJobs('pa', [job], { notify, now: now - 4 * everyMs });
    calls.length = 0; // clear the seed run's own notify calls (there should be none)

    const records = await runDueJobs('pa', [job], { notify, now, degraded: true });
    assert.equal(records[0].outcome, 'skipped');
    assert.equal(records[0].skipReason, 'degraded');

    const pageCalls = calls.filter((c) => c.opts?.dedupKey === 'maintenance-skipped-stale-degraded');
    assert.equal(pageCalls.length, 1);
    assert.equal(pageCalls[0].opts?.severity, 'warn');
    assert.equal(pageCalls[0].opts?.dedupWindowMs, 86_400_000);
  });

  it('not-due never pages and never increments consecutiveSkips', async () => {
    const everyMs = 60_000;
    const now = 1_000_000;
    const job = makeJob({ name: 'freshly-run', everyMs });
    const { notify, calls } = makeFakeNotify();

    await runDueJobs('pa', [job], { notify, now });
    calls.length = 0;

    for (let i = 0; i < 5; i++) {
      const records = await runDueJobs('pa', [job], { notify, now });
      assert.equal(records[0].skipReason, 'not-due');
    }

    assert.equal(calls.length, 0);
    const ledger = await readLedger();
    assert.equal(ledger.jobs['freshly-run'].consecutiveSkips, 0);
  });

  it('disabled never pages, but consecutiveSkips increments each pass', async () => {
    const everyMs = 60_000;
    const now = 1_000_000;
    const job = makeJob({ name: 'disabled-job', everyMs });
    const { notify, calls } = makeFakeNotify();

    for (let i = 0; i < 3; i++) {
      await runDueJobs('pa', [job], {
        notify,
        now: now + i, // vary slightly, still far from being "due" in a way that matters
        overrides: { 'disabled-job': { enabled: false } },
      });
    }

    assert.equal(calls.length, 0);
    const ledger = await readLedger();
    assert.equal(ledger.jobs['disabled-job'].consecutiveSkips, 3);
  });

  it('host mismatch rejects loudly', async () => {
    const botJob = makeJob({ name: 'bot-only', host: 'bot' });
    await assert.rejects(() => runDueJobs('pa', [botJob]), /declares host 'bot'/);
  });

  it('unknown override key warns and does not throw', async () => {
    const job = makeJob({ name: 'known-job' });
    const { notify } = makeFakeNotify();
    const originalWarn = console.warn;
    let warned = false;
    console.warn = (...args: unknown[]) => { warned = true; };
    try {
      await assert.doesNotReject(() => runDueJobs('pa', [job], { notify, overrides: { 'unknown-job': { enabled: false } } }));
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warned, true);
  });

  it('a failed run records lastAttemptAt and leaves lastRunAt untouched', async () => {
    const job = makeJob({ name: 'fails-records-attempt', run: async () => { throw new Error('boom'); } });
    const { notify } = makeFakeNotify();
    const now = 5_000_000;
    await runDueJobs('pa', [job], { notify, now });
    const ledger = await readLedger();
    assert.equal(ledger.jobs['fails-records-attempt'].lastRunAt, undefined);
    assert.equal(ledger.jobs['fails-records-attempt'].lastAttemptAt, new Date(now).toISOString());
  });

  it('a successful run records both', async () => {
    const job = makeJob({ name: 'succeeds-records-both', run: async () => ({ touched: 0 }) });
    const { notify } = makeFakeNotify();
    const now = 6_000_000;
    await runDueJobs('pa', [job], { notify, now });
    const ledger = await readLedger();
    assert.equal(ledger.jobs['succeeds-records-both'].lastRunAt, new Date(now).toISOString());
    assert.equal(ledger.jobs['succeeds-records-both'].lastAttemptAt, new Date(now).toISOString());
  });

  it('a job whose ledger row is mid-backoff is skipped with skipReason failure-backoff and does not call run()', async () => {
    let runCount = 0;
    const job = makeJob({
      name: 'flaky-backoff',
      run: async () => { runCount++; throw new Error('boom'); },
    });
    const { notify } = makeFakeNotify();

    // Two failures, 60s apart, to reach consecutiveFailures = 2 (ladder[1] = 30 min).
    await runDueJobs('pa', [job], { notify, now: 1_000_000 });
    await runDueJobs('pa', [job], { notify, now: 1_000_000 + 60_000 });
    assert.equal(runCount, 2);

    // Third attempt only 5 minutes after the second failure — still inside the 30 min rung.
    const records = await runDueJobs('pa', [job], { notify, now: 1_000_000 + 60_000 + 5 * 60_000 });
    assert.equal(runCount, 2, 'run() must not be called while mid-backoff');
    assert.equal(records[0].outcome, 'skipped');
    assert.equal(records[0].skipReason, 'failure-backoff');
  });
});

describe('runDueJobs parallel option (S8, 2026-09-11)', () => {
  it('default (parallel unset) is unchanged — re-asserts the existing awaited-per-job contract verbatim', async () => {
    const job = makeJob({ name: 'touches-two-parallel-unset', run: async () => ({ touched: 2 }) });
    const { notify } = makeFakeNotify();
    const records = await runDueJobs('pa', [job], { notify });
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'ran');
    assert.equal(records[0].touched, 2);
    const ledger = await readLedger();
    assert.ok(ledger.jobs['touches-two-parallel-unset'].lastRunAt);
    assert.equal(ledger.jobs['touches-two-parallel-unset'].consecutiveFailures, 0);
  });

  it('parallel: true starts two due jobs of different durations in one pass; both records are "started" (durationMs 0) and the pass resolves before the slow job ends', async () => {
    let slowJobFinished = false;
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const slowJob = makeJob({
      name: 'slow-parallel-job',
      run: async () => { await slowGate; slowJobFinished = true; return { touched: 1 }; },
    });
    const fastJob = makeJob({
      name: 'fast-parallel-job',
      run: async () => ({ touched: 1 }),
    });
    const { notify } = makeFakeNotify();

    const records = await runDueJobs('pa', [slowJob, fastJob], { notify, parallel: true });

    assert.deepEqual(records.map((r) => r.outcome), ['started', 'started']);
    assert.deepEqual(records.map((r) => r.durationMs), [0, 0]);
    assert.equal(slowJobFinished, false, 'the pass must resolve before the slow job completes');

    releaseSlow();
    await waitUntil(() => slowJobFinished);
  });

  it('a job still running from an earlier parallel pass is skipped in-flight on the next pass, then runs on the first pass after it completes', async () => {
    let releaseRun!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRun = resolve; });
    let runCount = 0;
    const job = makeJob({
      name: 'in-flight-parallel-job',
      run: async () => { runCount++; await gate; return { touched: 0 }; },
    });
    const { notify } = makeFakeNotify();

    const firstPass = await runDueJobs('pa', [job], { notify, parallel: true });
    assert.equal(firstPass[0].outcome, 'started');

    const secondPass = await runDueJobs('pa', [job], { notify, parallel: true });
    assert.equal(secondPass[0].outcome, 'skipped');
    assert.equal(secondPass[0].skipReason, 'in-flight');
    assert.equal(runCount, 1, 'run() must not be invoked a second time while still in flight');

    releaseRun();
    // Wait for the first pass's detached completion handler to write the
    // ledger and release IN_FLIGHT.
    await waitUntil(async () => (await readLedger()).jobs['in-flight-parallel-job']?.lastOutcome === 'ran');

    // force:true bypasses cadence (everyMs) so this exercises the in-flight
    // release, not the unrelated not-due decision.
    const thirdPass = await runDueJobs('pa', [job], { notify, parallel: true, force: true });
    assert.equal(thirdPass[0].outcome, 'started');
    await waitUntil(() => runCount === 2);
    assert.equal(runCount, 2, 'run() must be invoked again once the earlier pass released the slot');
  });

  it('concurrent completions from one parallel pass leave EVERY outcome correctly recorded in the ledger (C15 — updateJobState already serializes; no runner-added mutex)', async () => {
    const N = 8;
    const jobs = Array.from({ length: N }, (_, i) => makeJob({
      name: `concurrent-job-${i}`,
      run: async () => {
        // Stagger completion order so the ledger writes race each other.
        await new Promise((r) => setTimeout(r, (N - i) % 3));
        if (i % 3 === 0) throw new Error(`boom-${i}`);
        return { touched: i };
      },
    }));
    const { notify } = makeFakeNotify();

    const records = await runDueJobs('pa', jobs, { notify, parallel: true });
    assert.equal(records.length, N);
    assert.ok(records.every((r) => r.outcome === 'started'));

    // Poll until every detached completion has written its terminal outcome.
    // N serialized real lock+atomic-rename writes (updateJobState's own
    // three-layer serialization, C15) can take longer than the default
    // budget on a contended host (observed 2026-09-11 in a many-agent
    // shared-tree wave) — generous timeout, still fails loudly if truly wedged.
    await waitUntil(async () => {
      const l = await readLedger();
      return jobs.every((j) => {
        const outcome = l.jobs[j.name]?.lastOutcome;
        return outcome !== undefined && outcome !== 'started';
      });
    }, 15_000);

    const ledger = await readLedger();
    for (let i = 0; i < N; i++) {
      const state = ledger.jobs[`concurrent-job-${i}`];
      assert.ok(state, `job ${i} missing from ledger`);
      if (i % 3 === 0) {
        assert.equal(state.lastOutcome, 'failed', `job ${i} should be failed`);
      } else {
        assert.equal(state.lastOutcome, 'ran', `job ${i} should be ran`);
        assert.ok(state.lastRunAt, `job ${i} should have lastRunAt set`);
      }
    }
  });

  it('a throwing job in a parallel pass leaves its siblings\' outcomes intact and never rejects the pass', async () => {
    const throwingJob = makeJob({ name: 'parallel-throws', run: async () => { throw new Error('boom'); } });
    const okJob = makeJob({ name: 'parallel-ok', run: async () => ({ touched: 3 }) });
    const { notify } = makeFakeNotify();

    const records = await runDueJobs('pa', [throwingJob, okJob], { notify, parallel: true });
    assert.deepEqual(records.map((r) => r.outcome), ['started', 'started']);

    await waitUntil(async () => {
      const l = await readLedger();
      return l.jobs['parallel-throws']?.lastOutcome === 'failed' && l.jobs['parallel-ok']?.lastOutcome === 'ran';
    });

    const ledger = await readLedger();
    assert.equal(ledger.jobs['parallel-throws'].lastOutcome, 'failed');
    assert.equal(ledger.jobs['parallel-ok'].lastOutcome, 'ran');
    assert.ok(ledger.jobs['parallel-ok'].lastRunAt);
  });

  it('"started" never appears as a ledger lastOutcome once a parallel pass settles', async () => {
    const jobs = [
      makeJob({ name: 'never-started-a', run: async () => ({ touched: 0 }) }),
      makeJob({ name: 'never-started-b', run: async () => { throw new Error('x'); } }),
    ];
    const { notify } = makeFakeNotify();
    await runDueJobs('pa', jobs, { notify, parallel: true });
    await waitUntil(async () => {
      const l = await readLedger();
      return jobs.every((j) => l.jobs[j.name]?.lastOutcome !== undefined);
    });

    const ledger = await readLedger();
    for (const job of jobs) {
      assert.notEqual(ledger.jobs[job.name].lastOutcome, 'started');
    }
  });
});

describe('runDueJobs skip-bookkeeping batching (AI-315)', () => {
  it('a failing ledger write does not abort the pass — every job still gets a record', async () => {
    // Hold the ledger's lockfile so every updateJobState/updateJobsState
    // acquisition ELOCKEDs. Pre-AI-315 the skip path awaited updateJobState
    // per job inside the pass loop, so the first job's write threw and the
    // whole pass aborted mid-list — the tail jobs (backlog-fragments-drain,
    // bus-drain) starved for hours on 2026-09-17. The batched write still
    // fails, but the pass must return every job's record.
    const jobs = Array.from({ length: 5 }, (_, i) => makeJob({ name: `batch-skip-${i}` }));
    const { notify } = makeFakeNotify();
    await writeFile(maintenanceStatePath(), '{"version":1,"jobs":{}}');
    const release = await lockfile.lock(maintenanceStatePath(), { realpath: false });
    try {
      const records = await runDueJobs('pa', jobs, {
        notify,
        overrides: Object.fromEntries(jobs.map((j) => [j.name, { enabled: false }])),
      });
      assert.equal(records.length, jobs.length, 'every job must produce a record even when the skip-write fails');
      assert.ok(records.every((r) => r.outcome === 'skipped' && r.skipReason === 'disabled'));
    } finally {
      await release().catch(() => {});
    }
  });

  it('skip bookkeeping lands for every skipped job in the pass', async () => {
    const jobs = Array.from({ length: 4 }, (_, i) => makeJob({ name: `batched-lands-${i}` }));
    const { notify } = makeFakeNotify();
    const records = await runDueJobs('pa', jobs, {
      notify,
      overrides: Object.fromEntries(jobs.map((j) => [j.name, { enabled: false }])),
    });
    assert.equal(records.length, jobs.length);
    await waitUntil(async () => {
      const l = await readLedger();
      return jobs.every((j) => l.jobs[j.name]?.lastSkipReason === 'disabled' && l.jobs[j.name]?.consecutiveSkips === 1);
    });
  });
});

describe('skippedTooLongThreshold floor', () => {
  it('a 60s job skipped degraded for 5 minutes does NOT page; for 20 minutes it does', async () => {
    const everyMs = 60_000; // 60s cadence — bare 3x would be 3 min; the 15 min floor applies.
    const job = makeJob({ name: 'sixty-second-job', everyMs, shedWhenDegraded: true });
    const { notify, calls } = makeFakeNotify();

    const seedNow = 100_000_000;
    await runDueJobs('pa', [job], { notify, now: seedNow });
    calls.length = 0; // clear the seed run's own notify calls (there should be none)

    // 5 minutes after the seeded run, still degraded — under the 15 min floor.
    await runDueJobs('pa', [job], { notify, now: seedNow + 5 * 60_000, degraded: true });
    assert.equal(
      calls.filter((c) => c.opts?.dedupKey === 'maintenance-skipped-sixty-second-job').length,
      0,
      'must not page before the 15 min floor',
    );

    // 20 minutes after the seeded run, still degraded — past the 15 min floor.
    await runDueJobs('pa', [job], { notify, now: seedNow + 20 * 60_000, degraded: true });
    const pageCalls = calls.filter((c) => c.opts?.dedupKey === 'maintenance-skipped-sixty-second-job');
    assert.equal(pageCalls.length, 1, 'must page once past the 15 min floor');
  });
});

describe('resolveEveryMs', () => {
  it('applies a valid override', () => {
    const job = makeJob({ name: 'x', everyMs: 1000 });
    assert.equal(resolveEveryMs(job, { everyMs: 5000 }), 5000);
  });

  it('falls back to declared cadence for 0/NaN/negative overrides', () => {
    const job = makeJob({ name: 'x', everyMs: 1000 });
    assert.equal(resolveEveryMs(job, { everyMs: 0 }), 1000);
    assert.equal(resolveEveryMs(job, { everyMs: NaN }), 1000);
    assert.equal(resolveEveryMs(job, { everyMs: -5 }), 1000);
  });

  it('no override → declared cadence, including function form', () => {
    const job = makeJob({ name: 'x', everyMs: () => 4242 });
    assert.equal(resolveEveryMs(job), 4242);
  });
});

describe('runDueJobs onJobDecision (catchup-lane-wedge wave)', () => {
  it('reports each target job once, in order, with its action, before that job runs', async () => {
    const now = 2_000_000_000_000;
    const events: string[] = [];
    const decisionA = makeJob({
      name: 'decision-a',
      everyMs: 60_000,
      run: async () => { events.push('run:decision-a'); return { touched: 0 }; },
    });
    const decisionB = makeJob({
      name: 'decision-b',
      everyMs: 3_600_000,
      run: async () => { events.push('run:decision-b'); return { touched: 0 }; },
    });

    await runDueJobs('pa', [decisionB], { now });
    events.length = 0;

    await runDueJobs('pa', [decisionA, decisionB], {
      now: now + 1000,
      onJobDecision: (n, a) => events.push(`decide:${n}:${a}`),
    });

    assert.deepEqual(events, ['decide:decision-a:run', 'run:decision-a', 'decide:decision-b:skip']);
  });

  it('a throwing onJobDecision does not break the pass', async () => {
    const decisionC = makeJob({ name: 'decision-c', run: async () => ({ touched: 0 }) });
    const records = await runDueJobs('pa', [decisionC], {
      onJobDecision: () => { throw new Error('x'); },
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'ran');
  });
});
