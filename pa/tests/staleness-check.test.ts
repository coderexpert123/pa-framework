import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stalenessCheckJob, stalenessDedupKey } from '../src/lib/maintenance/jobs/staleness-check.js';

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
