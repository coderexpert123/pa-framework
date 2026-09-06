import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { decideJob, runDueJobs, resolveEveryMs } from '../src/lib/maintenance/runner.js';
import { readLedger } from '../src/lib/maintenance/state.js';
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
