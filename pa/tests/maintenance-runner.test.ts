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
  opts?: { dedupKey?: string; dedupWindowMs?: number; severity?: 'info' | 'warn' | 'error' };
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

  it('in-flight guard: concurrent runDueJobs calls for the same job — second is skipped, run() invoked once', async () => {
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

    const [, secondRecords] = await Promise.all([
      (async () => { releaseRun(); return first; })(),
      second,
    ]);

    assert.equal(runCount, 1);
    assert.equal(secondRecords[0].outcome, 'skipped');
    assert.equal(secondRecords[0].skipReason, 'in-flight');
  });

  it('skipped-too-long page fires once lastRunAt is more than 3x cadence stale, degraded+shed', async () => {
    const everyMs = 10_000;
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
});

describe('P2-16: staleness sub-hourly blind spot fix', () => {
  it('sub-hourly skill (e.g., 5-min interval) fires staleness alert after 30 min + 2*interval', async () => {
    const { stalenessCheckJob } = await import('../src/lib/maintenance/jobs/staleness-check.js');
    const everyMs = 5 * 60 * 1000; // 5-minute cron
    const now = Date.now();
    const lastSuccess = new Date(now - 35 * 60 * 1000).toISOString(); // 35 minutes ago (>30 min and >2*5min)

    const mockCtx = {
      now,
      everyMs,
      async listSkills() {
        return [{
          name: 'test-skill',
          frontmatter: { cron: '*/5 * * * *' }, // 5-minute interval
        } as any];
      },
      async getLastSuccessfulRun(skillName: string) {
        if (skillName === 'test-skill') {
          return { timestamp: lastSuccess };
        }
        return null;
      },
    };

    const result = await stalenessCheckJob.run(mockCtx);
    assert.equal(result.touched, 1, 'Should detect stale sub-hourly skill');
    const detail = result.detail as { skills?: string[] } | undefined;
    assert.ok((detail?.skills?.length ?? 0) > 0, 'Should report the stale skill');
  });

  it('sub-hourly skill NOT stale when only 20 min + 2*interval (P2-16 fix: requires >30 min minimum)', async () => {
    const { stalenessCheckJob } = await import('../src/lib/maintenance/jobs/staleness-check.js');
    const everyMs = 5 * 60 * 1000;
    const now = Date.now();
    const lastSuccess = new Date(now - 22 * 60 * 1000).toISOString(); // 22 min ago (<30 min floor)

    const mockCtx = {
      now,
      everyMs,
      async listSkills() {
        return [{
          name: 'test-skill',
          frontmatter: { cron: '*/5 * * * *' },
        } as any];
      },
      async getLastSuccessfulRun(skillName: string) {
        if (skillName === 'test-skill') {
          return { timestamp: lastSuccess };
        }
        return null;
      },
    };

    const result = await stalenessCheckJob.run(mockCtx);
    assert.equal(result.touched, 0, 'Should NOT fire - below 30-minute minimum threshold');
  });
});

describe('Wave C WPC1: skill-cadence-audit dead-man\'s-switch', () => {
  it('stale skill fires once (dedupe handled by notifyUser)', async () => {
    const { skillCadenceAuditJob } = await import('../src/lib/maintenance/jobs/skill-cadence-audit.js');
    const now = Date.now();
    const lastSuccess = new Date(now - 50 * HOUR).toISOString(); // 50 hours ago (>2× daily = 48h and >26h)

    const mockCtx = {
      now,
      everyMs: 3_600_000, // 1 hour
      async listSkills() {
        return [{
          name: 'daily-skill',
          frontmatter: { cron: '0 0 * * *' }, // daily
        } as any];
      },
      async getLastSuccessfulRun(skillName: string) {
        if (skillName === 'daily-skill') {
          return { timestamp: lastSuccess };
        }
        return null;
      },
      async getFailureState(skillName: string) {
        return { consecutiveFailures: 0, lastAttemptAt: null };
      },
    };

    const result = await skillCadenceAuditJob.run(mockCtx);
    assert.equal(result.touched, 1, 'Should detect stale daily skill');
    const detail = result.detail as { skills?: string[] } | undefined;
    assert.ok((detail?.skills?.length ?? 0) > 0, 'Should report the stale skill');
    assert.ok(detail?.skills?.[0]?.includes('daily-skill'), 'Alert should name the skill');
    assert.ok(detail?.skills?.[0]?.includes('50h ago'), 'Alert should show hours since success');
  });

  it('healthy skill (within threshold) is silent', async () => {
    const { skillCadenceAuditJob } = await import('../src/lib/maintenance/jobs/skill-cadence-audit.js');
    const now = Date.now();
    const lastSuccess = new Date(now - 12 * 60 * 60 * 1000).toISOString(); // 12 hours ago (<2× daily, <26h)

    const mockCtx = {
      now,
      everyMs: 3_600_000,
      async listSkills() {
        return [{
          name: 'daily-skill',
          frontmatter: { cron: '0 0 * * *' },
        } as any];
      },
      async getLastSuccessfulRun(skillName: string) {
        if (skillName === 'daily-skill') {
          return { timestamp: lastSuccess };
        }
        return null;
      },
      async getFailureState(skillName: string) {
        return { consecutiveFailures: 0, lastAttemptAt: null };
      },
    };

    const result = await skillCadenceAuditJob.run(mockCtx);
    assert.equal(result.touched, 0, 'Should NOT fire - healthy skill within threshold');
  });

  it('parked skill message references park status', async () => {
    const { skillCadenceAuditJob } = await import('../src/lib/maintenance/jobs/skill-cadence-audit.js');
    const now = Date.now();
    const lastSuccess = new Date(now - 50 * HOUR).toISOString(); // 50 hours ago (>2× daily = 48h)

    const mockCtx = {
      now,
      everyMs: 3_600_000,
      async listSkills() {
        return [{
          name: 'failing-skill',
          frontmatter: { cron: '0 0 * * *' },
        } as any];
      },
      async getLastSuccessfulRun(skillName: string) {
        if (skillName === 'failing-skill') {
          return { timestamp: lastSuccess };
        }
        return null;
      },
      async getFailureState(skillName: string) {
        // Simulate parked state (5+ consecutive failures)
        return { consecutiveFailures: 7, lastAttemptAt: new Date(now - 2 * 60 * 60 * 1000).toISOString() };
      },
    };

    const result = await skillCadenceAuditJob.run(mockCtx);
    assert.equal(result.touched, 1, 'Should detect stale parked skill');
    const detail = result.detail as { skills?: string[] } | undefined;
    assert.ok((detail?.skills?.length ?? 0) > 0, 'Should report the stale skill');
    assert.ok(detail?.skills?.[0]?.includes('[PARKED'), 'Alert should mention parked status');
    assert.ok(detail?.skills?.[0]?.includes('7 consecutive failures'), 'Alert should show failure count');
  });

  it('respects max(2× interval, 26h) threshold', async () => {
    const { skillCadenceAuditJob } = await import('../src/lib/maintenance/jobs/skill-cadence-audit.js');
    const now = Date.now();
    // Hourly skill: 2× interval = 2h, so 26h threshold applies
    const lastSuccess = new Date(now - 28 * 60 * 60 * 1000).toISOString(); // 28 hours ago (>26h)

    const mockCtx = {
      now,
      everyMs: 3_600_000,
      async listSkills() {
        return [{
          name: 'hourly-skill',
          frontmatter: { cron: '0 * * * *' }, // hourly
        } as any];
      },
      async getLastSuccessfulRun(skillName: string) {
        if (skillName === 'hourly-skill') {
          return { timestamp: lastSuccess };
        }
        return null;
      },
      async getFailureState(skillName: string) {
        return { consecutiveFailures: 0, lastAttemptAt: null };
      },
    };

    const result = await skillCadenceAuditJob.run(mockCtx);
    assert.equal(result.touched, 1, 'Should detect stale hourly skill (exceeds 26h threshold)');
    const detail = result.detail as { skills?: string[] } | undefined;
    assert.ok(detail?.skills?.[0]?.includes('threshold: 26h'), 'Alert should show 26h threshold for hourly skill');
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
