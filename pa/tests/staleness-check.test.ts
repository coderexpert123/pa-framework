import './test-env-guard.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { createTempPaHome, cleanup } from './helpers.js';
import { flushLog } from '../src/lib/log.js';
import { findJob } from '../src/lib/maintenance/registry.js';
import { PRUNABLE_ARCHIVE_SUFFIXES } from '../src/lib/archive-files.js';
import { STALL_RECORDS_ARCHIVE_SUFFIX, stallRecordsPath } from '../src/lib/stall.js';
import {
  stalenessCheckJob,
  stalenessDedupKey,
  findStaleLedgerJobs,
  ledgerFreshnessDedupKey,
  drainStallRecords,
} from '../src/lib/maintenance/jobs/staleness-check.js';
import type { MaintenanceLedger } from '../src/lib/maintenance/state.js';

describe('staleness-check job (WP-E, 2026-08-23)', () => {
  it('sub-hourly skill (5-min interval) fires after 30 min + 2*interval (recreated from deleted P2-16 case)', async () => {
    const everyMs = 5 * 60 * 1000;
    const now = Date.now();
    const lastSuccess = new Date(now - 35 * 60 * 1000).toISOString(); // 35 min ago (>30 min and >2*5min)

    const mockCtx = {
      now,
      everyMs,
      async listSkills() {
        return [{ name: 'test-skill', frontmatter: { cron: '*/5 * * * *' } } as any];
      },
      async getLastSuccessfulRun(skillName: string) {
        return skillName === 'test-skill' ? { timestamp: lastSuccess } : null;
      },
      async getFailureState() {
        return { consecutiveFailures: 0, lastAttemptAt: null };
      },
    };

    const result = await stalenessCheckJob.run(mockCtx as any);
    assert.equal(result.touched, 1, 'should detect stale sub-hourly skill');
    const detail = result.detail as { skills?: string[] } | undefined;
    assert.ok((detail?.skills?.length ?? 0) > 0, 'should report the stale skill');
  });

  it('sub-hourly skill NOT stale at 20 min + 2*interval (recreated from deleted P2-16 case)', async () => {
    const everyMs = 5 * 60 * 1000;
    const now = Date.now();
    const lastSuccess = new Date(now - 22 * 60 * 1000).toISOString(); // 22 min ago (<30 min floor)

    const mockCtx = {
      now,
      everyMs,
      async listSkills() {
        return [{ name: 'test-skill', frontmatter: { cron: '*/5 * * * *' } } as any];
      },
      async getLastSuccessfulRun(skillName: string) {
        return skillName === 'test-skill' ? { timestamp: lastSuccess } : null;
      },
      async getFailureState() {
        return { consecutiveFailures: 0, lastAttemptAt: null };
      },
    };

    const result = await stalenessCheckJob.run(mockCtx as any);
    assert.equal(result.touched, 0, 'should NOT fire below the 30-minute minimum threshold');
  });

  it('a parked skill (consecutiveFailures >= 5) is skipped entirely', async () => {
    const everyMs = 60 * 60 * 1000;
    const now = Date.now();
    const lastSuccess = new Date(now - 10 * 3600_000).toISOString(); // way stale

    const mockCtx = {
      now,
      everyMs,
      async listSkills() {
        return [{ name: 'parked-skill', frontmatter: { cron: '0 * * * *' } } as any];
      },
      async getLastSuccessfulRun(skillName: string) {
        return skillName === 'parked-skill' ? { timestamp: lastSuccess } : null;
      },
      async getFailureState(skillName: string) {
        return skillName === 'parked-skill'
          ? { consecutiveFailures: 5, lastAttemptAt: new Date(now).toISOString() }
          : { consecutiveFailures: 0, lastAttemptAt: null };
      },
    };

    const result = await stalenessCheckJob.run(mockCtx as any);
    assert.equal(result.touched, 0, 'parked skill must not be reported');
  });

  it('a healthy-but-stale skill still alerts when getFailureState reports 0 failures', async () => {
    const everyMs = 60 * 60 * 1000;
    const now = Date.now();
    const lastSuccess = new Date(now - 10 * 3600_000).toISOString();

    const mockCtx = {
      now,
      everyMs,
      async listSkills() {
        return [{ name: 'healthy-stale-skill', frontmatter: { cron: '0 * * * *' } } as any];
      },
      async getLastSuccessfulRun(skillName: string) {
        return skillName === 'healthy-stale-skill' ? { timestamp: lastSuccess } : null;
      },
      async getFailureState() {
        return { consecutiveFailures: 0, lastAttemptAt: null };
      },
    };

    const result = await stalenessCheckJob.run(mockCtx as any);
    assert.equal(result.touched, 1, 'a healthy but stale skill must still be reported');
  });

  it('cost_tier: off_peak periodic skill is not stale until 2*interval + 4h', async () => {
    const now = Date.now();
    // hourly cron -> intervalMs = 1h -> 2*interval = 2h; widened threshold = 2h + 4h = 6h.
    // Without the widening, a periodic (non-time-pinned) skill would already be
    // stale at 2h, so both probe points below are only "not stale" BECAUSE of it.
    async function runWithGap(hoursAgo: number) {
      const lastSuccess = new Date(now - hoursAgo * 3600_000).toISOString();
      const ctx = {
        now,
        everyMs: 3600_000,
        async listSkills() {
          return [{ name: 'off-peak-skill', frontmatter: { cron: '0 * * * *', cost_tier: 'off_peak' } } as any];
        },
        async getLastSuccessfulRun(skillName: string) {
          return skillName === 'off-peak-skill' ? { timestamp: lastSuccess } : null;
        },
        async getFailureState() {
          return { consecutiveFailures: 0, lastAttemptAt: null };
        },
      };
      return stalenessCheckJob.run(ctx as any);
    }

    const notStale = await runWithGap(5); // 5h < 6h widened threshold
    assert.equal(notStale.touched, 0, 'must not be stale before 2*interval + 4h clears');

    const stale = await runWithGap(7); // 7h > 6h widened threshold
    assert.equal(stale.touched, 1, 'must be stale once past 2*interval + 4h');
  });

  it('cost_tier: off_peak with a TIME-PINNED cron gets no widening', async () => {
    const now = Date.now();
    // A time-pinned cron (fixed minute AND hour, e.g. daily "30 23 * * *") has
    // intervalMs ~= 24h, so 2*interval = 48h with NO widening vs 52h if the (buggy)
    // code widened it anyway. A 50h gap discriminates the two: stale (touched=1)
    // proves no widening was applied; touched=0 would mean the widening leaked
    // into a time-pinned skill, contradicting partitionOverdueByCostTier's own
    // behaviour (it ignores cost_tier entirely for time-pinned crons).
    const lastSuccess = new Date(now - 50 * 3600_000).toISOString();

    const ctx = {
      now,
      everyMs: 3600_000,
      async listSkills() {
        return [{ name: 'off-peak-pinned-skill', frontmatter: { cron: '30 23 * * *', cost_tier: 'off_peak' } } as any];
      },
      async getLastSuccessfulRun(skillName: string) {
        return skillName === 'off-peak-pinned-skill' ? { timestamp: lastSuccess } : null;
      },
      async getFailureState() {
        return { consecutiveFailures: 0, lastAttemptAt: null };
      },
    };

    const result = await stalenessCheckJob.run(ctx as any);
    assert.equal(result.touched, 1, 'time-pinned cron must not get the off_peak widening');
  });

  it('dedupKey is stable for the same stale SET regardless of hours-ago, and changes when a skill joins or leaves the set', () => {
    const keyA1 = stalenessDedupKey(['skill-a', 'skill-b']);
    const keyA2 = stalenessDedupKey(['skill-b', 'skill-a']); // order-independent
    assert.equal(keyA1, keyA2, 'dedupKey must not depend on input order');

    const keyB = stalenessDedupKey(['skill-a', 'skill-b', 'skill-c']);
    assert.notEqual(keyA1, keyB, 'dedupKey must change when the stale set changes');

    const keyEmpty = stalenessDedupKey([]);
    assert.notEqual(keyEmpty, keyA1);
  });
});

describe('ledger freshness and stall drain (2026-09-16)', () => {
  let tmpHome: string;

  it('ledger freshness: a bot job 16 min without attempt or skip is stale; 14 min is not', () => {
    const now = Date.now();
    const job = findJob('model-override-sweep')!;
    const ledger16: MaintenanceLedger = {
      version: 1,
      jobs: { [job.name]: { firstSeenAt: new Date(now - 3600_000).toISOString(), lastSkipAt: new Date(now - 16 * 60_000).toISOString(), consecutiveFailures: 0, consecutiveSkips: 1 } },
    };
    const stale16 = findStaleLedgerJobs(ledger16, [job], {}, now);
    assert.equal(stale16.length, 1);
    assert.deepEqual({ name: stale16[0].name, host: stale16[0].host }, { name: job.name, host: job.host });
    assert.ok(stale16[0].ageMs > 15 * 60_000);

    const ledger14: MaintenanceLedger = {
      version: 1,
      jobs: { [job.name]: { firstSeenAt: new Date(now - 3600_000).toISOString(), lastSkipAt: new Date(now - 14 * 60_000).toISOString(), consecutiveFailures: 0, consecutiveSkips: 1 } },
    };
    const stale14 = findStaleLedgerJobs(ledger14, [job], {}, now);
    assert.equal(stale14.length, 0);
  });

  it('ledger freshness: a weekly job whose last skip is 16 min old IS stale (every pass writes a skip)', () => {
    const now = Date.now();
    const job = findJob('weekly-learn')!;
    const ledger: MaintenanceLedger = {
      version: 1,
      jobs: { [job.name]: { firstSeenAt: new Date(now - 3600_000).toISOString(), lastSkipAt: new Date(now - 16 * 60_000).toISOString(), consecutiveFailures: 0, consecutiveSkips: 1 } },
    };
    const stale = findStaleLedgerJobs(ledger, [job], {}, now);
    assert.equal(stale.length, 1);
    assert.deepEqual({ name: stale[0].name, host: stale[0].host }, { name: 'weekly-learn', host: 'pa' });
  });

  it('ledger freshness: disabled-by-override and row-less jobs are never stale; a lastRunAt-only row counts', () => {
    const now = Date.now();
    const modelOverride = findJob('model-override-sweep')!;
    const grounding = findJob('grounding-check')!;
    const alertDigest = findJob('alert-digest')!;
    const ledger: MaintenanceLedger = {
      version: 1,
      jobs: {
        [modelOverride.name]: { firstSeenAt: new Date(now - 3600_000).toISOString(), lastSkipAt: new Date(now - 60 * 60_000).toISOString(), consecutiveFailures: 0, consecutiveSkips: 1 },
        [alertDigest.name]: { firstSeenAt: new Date(now - 3600_000).toISOString(), lastRunAt: new Date(now - 20 * 60_000).toISOString(), consecutiveFailures: 0, consecutiveSkips: 0 },
      },
    };
    const overrides = { [modelOverride.name]: { enabled: false } };
    const stale = findStaleLedgerJobs(ledger, [modelOverride, grounding, alertDigest], overrides as any, now);
    assert.equal(stale.length, 1);
    assert.deepEqual({ name: stale[0].name, host: stale[0].host }, { name: alertDigest.name, host: alertDigest.host });
  });

  it('ledgerFreshnessDedupKey is stable across ages and order and changes with the set', () => {
    const setA = [{ name: 'a', host: 'bot' }, { name: 'b', host: 'pa' }];
    const setAReordered = [{ name: 'b', host: 'pa' }, { name: 'a', host: 'bot' }];
    const keyA = ledgerFreshnessDedupKey(setA);
    const keyAReordered = ledgerFreshnessDedupKey(setAReordered);
    assert.equal(keyA, keyAReordered);
    const keySmaller = ledgerFreshnessDedupKey([{ name: 'a', host: 'bot' }]);
    assert.notEqual(keyA, keySmaller);
    assert.match(keyA, /^maintenance-freshness:[0-9a-f]{16}$/);
  });

  it('run() pages Maintenance ledger stale for an injected stale bot row and reports it in detail.staleJobs', async () => {
    tmpHome = await createTempPaHome();
    try {
      const now = Date.now();
      const job = findJob('model-override-sweep')!;
      const ledger: MaintenanceLedger = {
        version: 1,
        jobs: { [job.name]: { firstSeenAt: new Date(now - 3600_000).toISOString(), lastSkipAt: new Date(now - 20 * 60_000).toISOString(), consecutiveFailures: 0, consecutiveSkips: 1 } },
      };
      const ctx = {
        now,
        everyMs: 60_000,
        async listSkills() { return []; },
        async getLastSuccessfulRun() { return null; },
        async getFailureState() { return { consecutiveFailures: 0, lastAttemptAt: null }; },
        readLedger: async () => ledger,
        declaredJobs: [job],
        maintenanceOverrides: {},
      };
      const result = await stalenessCheckJob.run(ctx as any);
      assert.equal(result.touched, 1);
      const detail = result.detail as { staleJobs?: string[] };
      assert.deepEqual(detail.staleJobs, ['bot/model-override-sweep']);
      await flushLog();
      const appLog = await readFile(join(tmpHome, 'app.log.jsonl'), 'utf8');
      assert.match(appLog, /"subject":"Maintenance ledger stale"/);
      const expectedKey = ledgerFreshnessDedupKey([{ name: 'model-override-sweep', host: 'bot' }]);
      assert.ok(appLog.includes(`"dedupKey":"${expectedKey}"`));
    } finally {
      await cleanup(tmpHome);
    }
  });

  it('drainStallRecords archives the file under the prunable suffix and logs one error line per record with its refId', async () => {
    tmpHome = await createTempPaHome();
    try {
      const recordLine = JSON.stringify({ ts: '2026-09-16T10:00:00.000Z', pid: 1234, host: 'catchup-loop', store: 'maintenance-state', target: 'maintenance-state.json', waitedMs: 180001, maxWaitMs: 180000, refId: 's-aaaaaaaaaaaa' });
      const launcherLine = '{"ts":"2026-09-16T15:30:00","pid":1234,"host":"launcher","store":"lane-progress","cause":"lane reminders stale at drill-wedge"}';
      await writeFile(stallRecordsPath(), `${recordLine}\n${launcherLine}\r\n`, 'utf8');
      const now = Date.now();
      const result = drainStallRecords(now);
      assert.equal(result.drained, 2);
      assert.equal(result.unparseable, 0);
      assert.equal(existsSync(stallRecordsPath()), false);
      assert.ok(result.archivedTo);
      assert.ok(String(result.archivedTo).split(/[\\/]/).pop()!.endsWith(STALL_RECORDS_ARCHIVE_SUFFIX));
      assert.ok(PRUNABLE_ARCHIVE_SUFFIXES.includes(STALL_RECORDS_ARCHIVE_SUFFIX));
      await flushLog();
      const appLog = await readFile(join(tmpHome, 'app.log.jsonl'), 'utf8');
      const stallLines = appLog.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.module === 'stall');
      assert.equal(stallLines.length, 2);
      assert.ok(stallLines.every((e) => e.level === 'error'));
      const byRefId = stallLines.find((e) => e.refId === 's-aaaaaaaaaaaa');
      assert.ok(byRefId);
      assert.equal(byRefId.message, 'store stall: maintenance-state (maintenance-state.json) in catchup-loop');
      const byLauncher = stallLines.find((e) => e.message === 'catchup launcher restarted a stalled loop: lane reminders stale at drill-wedge');
      assert.ok(byLauncher);
      assert.match(byLauncher.refId, /^s-[0-9a-f]{12}$/);
    } finally {
      await cleanup(tmpHome);
    }
  });

  it('drainStallRecords is a no-op without a stall-records file', async () => {
    tmpHome = await createTempPaHome();
    try {
      const result = drainStallRecords(Date.now());
      assert.deepEqual(result, { drained: 0, unparseable: 0, archivedTo: null });
    } finally {
      await cleanup(tmpHome);
    }
  });
});
