import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, createTempSkill, cleanup } from './helpers.js';
import { writeLog } from '../src/logger.js';
import { getOverdueSkills, partitionOverdueByCostTier, buildLauncherVbs } from '../src/scheduler.js';
import type { RunMeta } from '../src/types.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

function makeMeta(timestamp: string): RunMeta {
  return {
    worker: 'test',
    status: 'success',
    exitCode: 0,
    duration: 1000,
    timestamp,
  };
}

// Helper: create a skill with cron and optionally a last-run log
async function setupSkill(
  name: string,
  cron: string,
  onMissed: string = 'latest',
  lastRunISO?: string
): Promise<void> {
  await createTempSkill(tempDir, name, [
    '---',
    `cron: "${cron}"`,
    `on_missed: ${onMissed}`,
    '---',
    'Test prompt.',
  ].join('\n'));

  if (lastRunISO) {
    await writeLog(name, 'output', makeMeta(lastRunISO));
  }
}

describe('getOverdueSkills', () => {
  it('returns empty when skill ran recently', async () => {
    // Skill runs hourly; setting lastRun to current time guarantees nextExpected
    // is the top of the next hour (up to 59 minutes in the future), ensuring
    // overdue stays 0 regardless of load or minute/hour boundary crossings.
    const lastRun = new Date().toISOString();
    await setupSkill('recent', '0 * * * *', 'latest', lastRun);
    const overdue = await getOverdueSkills();
    assert.equal(overdue.length, 0);
  });

  it('detects overdue skill in latest mode', async () => {
    // Skill runs every hour, last run was 3 hours ago
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkill('overdue', '0 * * * *', 'latest', threeHoursAgo);
    const overdue = await getOverdueSkills();
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0].skill.name, 'overdue');
  });

  it('latest mode returns most recent missed occurrence', async () => {
    // Skill runs every hour, last run 3 hours ago
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkill('latest-check', '0 * * * *', 'latest', threeHoursAgo);
    const overdue = await getOverdueSkills();
    assert.equal(overdue.length, 1);
    // missedAt should be the most recent past hour mark, not 3 hours ago
    const missedAt = overdue[0].missedAt;
    const now = new Date();
    const hoursSinceMissed = (now.getTime() - missedAt.getTime()) / (60 * 60 * 1000);
    assert.ok(hoursSinceMissed < 1.1, `missedAt should be within the last hour, was ${hoursSinceMissed.toFixed(1)}h ago`);
  });

  it('all mode returns multiple missed runs', async () => {
    // Skill runs every hour, last run 5 hours ago
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await setupSkill('multi', '0 * * * *', 'all', fiveHoursAgo);
    const overdue = await getOverdueSkills();
    // Should have 4-5 missed hourly runs (depends on exact minute)
    assert.ok(overdue.length >= 3, `Expected at least 3 missed runs, got ${overdue.length}`);
    assert.ok(overdue.length <= 6, `Expected at most 6 missed runs, got ${overdue.length}`);
  });

  it('all mode caps at 10', async () => {
    // Skill runs every minute, last run 1 day ago — hundreds of missed runs
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await setupSkill('capped', '* * * * *', 'all', dayAgo);
    const overdue = await getOverdueSkills();
    assert.ok(overdue.length <= 10, `Expected max 10, got ${overdue.length}`);
  });

  it('skip mode returns nothing for overdue skill', async () => {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await setupSkill('skipped', '0 * * * *', 'skip', dayAgo);
    const overdue = await getOverdueSkills();
    assert.equal(overdue.length, 0);
  });

  it('never-run skill returns one entry', async () => {
    // Skill with cron but no logs — never ran
    await setupSkill('fresh', '0 * * * *', 'all');
    const overdue = await getOverdueSkills();
    // Should return exactly 1 (special case for never-run)
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0].skill.name, 'fresh');
    assert.equal(overdue[0].lastRun, null);
  });

  it('treats failed runs as if they never happened (only success resets clock)', async () => {
    // AI-024: getOverdueSkills uses getLastSuccessfulRun — a failed run must NOT
    // reset the overdue clock. Skill runs every hour; the most recent run failed
    // (5 minutes ago) but the last successful run was 3 hours ago → still overdue.
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await createTempSkill(tempDir, 'failed-run', [
      '---',
      'cron: "0 * * * *"',
      'on_missed: latest',
      '---',
      'Test prompt.',
    ].join('\n'));
    // Write a successful run 3 hours ago
    await writeLog('failed-run', 'output', { worker: 'test', status: 'success', exitCode: 0, duration: 1000, timestamp: threeHoursAgo });
    // Write a failed run 5 minutes ago (more recent, but should be ignored)
    await writeLog('failed-run', 'output', { worker: 'test', status: 'error', exitCode: 1, duration: 500, timestamp: fiveMinAgo });
    const overdue = await getOverdueSkills();
    assert.equal(overdue.length, 1, 'skill should be overdue because the failed run does not reset the clock');
    assert.equal(overdue[0].skill.name, 'failed-run');
  });

  it('skills without cron are ignored', async () => {
    await createTempSkill(tempDir, 'no-cron', 'Just a prompt, no schedule.');
    const overdue = await getOverdueSkills();
    assert.equal(overdue.length, 0);
  });

  it('invalid cron expression warns but continues', async () => {
    await createTempSkill(tempDir, 'bad-cron', '---\ncron: "not a cron"\n---\nPrompt.');
    await createTempSkill(tempDir, 'good-cron', '---\ncron: "0 * * * *"\n---\nPrompt.');
    // good-cron has never run so it should be overdue
    const overdue = await getOverdueSkills();
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0].skill.name, 'good-cron');
  });
});

describe('partitionOverdueByCostTier', () => {
  let tempDir2: string;

  beforeEach(async () => {
    tempDir2 = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(tempDir2);
  });

  async function setupSkillWithCostTier(
    name: string,
    cron: string,
    costTier: string = 'anytime',
    lastRunISO?: string
  ): Promise<void> {
    const frontmatter = [
      '---',
      `cron: "${cron}"`,
      `cost_tier: ${costTier}`,
      'on_missed: latest',
      '---',
      'Test prompt.',
    ].join('\n');

    await createTempSkill(tempDir2, name, frontmatter);

    if (lastRunISO) {
      await writeLog(name, 'output', makeMeta(lastRunISO));
    }
  }

  it('anytime skills always run regardless of time window', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('anytime-skill', '0 * * * *', 'anytime', threeHoursAgo);
    const overdue = await getOverdueSkills();

    // Test during peak hours (11:30-19:30 IST = 06:00-14:00 UTC)
    const peakHour = new Date();
    peakHour.setUTCHours(10, 0, 0, 0); // 10:00 UTC = 15:30 IST (peak)

    const partition = await partitionOverdueByCostTier(overdue, peakHour);
    assert.equal(partition.runnable.length, 1, 'anytime skill should run during peak hours');
    assert.equal(partition.deferred.length, 0, 'anytime skill should not be deferred');
  });

  it('off_peak skills run during off-peak window', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('offpeak-skill', '0 * * * *', 'off_peak', threeHoursAgo);
    const overdue = await getOverdueSkills();

    // Test during off-peak hours (19:30-11:30 IST = 14:00-06:00 UTC)
    const offPeakHour = new Date();
    offPeakHour.setUTCHours(15, 0, 0, 0); // 15:00 UTC = 20:30 IST (off-peak)

    const partition = await partitionOverdueByCostTier(overdue, offPeakHour);
    assert.equal(partition.runnable.length, 1, 'off_peak skill should run during off-peak hours');
    assert.equal(partition.deferred.length, 0, 'off_peak skill should not be deferred during off-peak');
  });

  it('off_peak skills are deferred during peak hours', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('offpeak-skill', '0 * * * *', 'off_peak', threeHoursAgo);
    const overdue = await getOverdueSkills();

    // Wednesday 08:00 UTC = 13:30 IST — inside z.ai peak (Mon-Fri 11:30-15:30 IST)
    const peakHour = new Date('2026-08-19T08:00:00Z');

    const partition = await partitionOverdueByCostTier(overdue, peakHour);
    assert.equal(partition.runnable.length, 0, 'off_peak skill should not run during peak hours');
    assert.equal(partition.deferred.length, 1, 'off_peak skill should be deferred during peak');
    assert.ok(
      partition.deferred[0].reason.includes('off_peak skill deferred during peak hours'),
      'deferred reason should mention peak hours'
    );
  });

  it('off_peak skills run at boundary times (peak end)', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('offpeak-skill', '0 * * * *', 'off_peak', threeHoursAgo);
    const overdue = await getOverdueSkills();

    // Wednesday 10:00 UTC = 15:30 IST — peak ends (half-open interval)
    const boundaryTime = new Date('2026-08-19T10:00:00Z');

    const partition = await partitionOverdueByCostTier(overdue, boundaryTime);
    assert.equal(partition.runnable.length, 1, 'off_peak skill should run at 15:30 IST (peak end)');
    assert.equal(partition.deferred.length, 0, 'should not be deferred at boundary');
  });

  it('off_peak skills deferred at peak start boundary', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('offpeak-skill', '0 * * * *', 'off_peak', threeHoursAgo);
    const overdue = await getOverdueSkills();

    // Wednesday 06:00 UTC = 11:30 IST — peak STARTS (deferral begins here)
    const boundaryTime = new Date('2026-08-19T06:00:00Z');

    const partition = await partitionOverdueByCostTier(overdue, boundaryTime);
    assert.equal(partition.runnable.length, 0, 'off_peak skill should be deferred at 11:30 IST (peak start)');
    assert.equal(partition.deferred.length, 1, 'should be deferred at peak start boundary');
  });

  it('off_peak skills are deferred just before off-peak starts', async () => {
    // Fully fixed clock — wall-clock-relative fixtures made this test pass at
    // night and fail when the suite ran during peak hours (found 2026-08-22).
    const justBefore = new Date('2026-08-19T05:59:00Z'); // 11:29 IST
    const threeHoursBeforeBoundary = new Date(justBefore.getTime() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('offpeak-skill', '0 * * * *', 'off_peak', threeHoursBeforeBoundary);
    const overdue = await getOverdueSkills();

    const partition = await partitionOverdueByCostTier(overdue, justBefore);
    assert.equal(partition.runnable.length, 1, 'off_peak skill should run at 11:29 IST (still off-peak)');
    assert.equal(partition.deferred.length, 0, 'should not be deferred just before boundary');
  });

  it('off_peak skills are deferred just after peak starts', async () => {
    // Same fixed-clock discipline (wall-clock independence).
    const justAfter = new Date('2026-08-19T06:01:00Z'); // 11:31 IST
    const threeHoursBeforeBoundary = new Date(justAfter.getTime() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('offpeak-skill', '0 * * * *', 'off_peak', threeHoursBeforeBoundary);
    const overdue = await getOverdueSkills();

    const partition = await partitionOverdueByCostTier(overdue, justAfter);
    assert.equal(partition.runnable.length, 0, 'off_peak skill should not run at 11:31 IST (peak started)');
    assert.equal(partition.deferred.length, 1, 'off_peak skill should be deferred just after peak starts');
  });

  it('mixed skills: anytime runs, off_peak deferred during peak', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('anytime-skill', '0 * * * *', 'anytime', threeHoursAgo);
    await setupSkillWithCostTier('offpeak-skill', '0 * * * *', 'off_peak', threeHoursAgo);
    const overdue = await getOverdueSkills();

    // Wednesday 08:00 UTC = 13:30 IST - inside z.ai peak
    const peakHour = new Date('2026-08-19T08:00:00Z');

    const partition = await partitionOverdueByCostTier(overdue, peakHour);
    assert.equal(partition.runnable.length, 1, 'only anytime skill should run during peak');
    assert.equal(partition.deferred.length, 1, 'off_peak skill should be deferred during peak');
  });

  it('mixed skills: both run during off-peak', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('anytime-skill', '0 * * * *', 'anytime', threeHoursAgo);
    await setupSkillWithCostTier('offpeak-skill', '0 * * * *', 'off_peak', threeHoursAgo);
    const overdue = await getOverdueSkills();

    // Test during off-peak hours
    const offPeakHour = new Date();
    offPeakHour.setUTCHours(15, 0, 0, 0); // 20:30 IST

    const partition = await partitionOverdueByCostTier(overdue, offPeakHour);
    assert.equal(partition.runnable.length, 2, 'both skills should run during off-peak');
    assert.equal(partition.deferred.length, 0, 'no skills should be deferred during off-peak');
  });

  it('skills without cost_tier default to anytime', async () => {
    // Create skill without cost_tier field
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await createTempSkill(tempDir2, 'default-skill', [
      '---',
      'cron: "0 * * * *"',
      'on_missed: latest',
      '---',
      'Test prompt.',
    ].join('\n'));
    await writeLog('default-skill', 'output', makeMeta(threeHoursAgo));

    const overdue = await getOverdueSkills();

    // Wednesday 08:00 UTC = 13:30 IST - inside z.ai peak
    const peakHour = new Date('2026-08-19T08:00:00Z');

    const partition = await partitionOverdueByCostTier(overdue, peakHour);
    assert.equal(partition.runnable.length, 1, 'skill without cost_tier should default to anytime');
    assert.equal(partition.deferred.length, 0, 'should not be deferred');
  });
});

describe('buildLauncherVbs', () => {
  const paPathCmd = 'C:\\Program Files\\pa\\pa.cmd';
  const args = 'catchup --topic default';

  it('sets CurrentDirectory to the repo root, appearing before the Run line', () => {
    const vbs = buildLauncherVbs(paPathCmd, args, 'D:\\Personal Assistant');
    const currentDirLine = 'WshShell.CurrentDirectory = "D:\\Personal Assistant"';
    assert.ok(vbs.includes(currentDirLine), 'must set CurrentDirectory to the repo root');

    const currentDirIndex = vbs.indexOf(currentDirLine);
    const runIndex = vbs.indexOf('WshShell.Run');
    assert.ok(currentDirIndex >= 0, 'CurrentDirectory line must be present');
    assert.ok(runIndex >= 0, 'Run line must be present');
    assert.ok(currentDirIndex < runIndex, 'CurrentDirectory line must appear before the Run line');
  });

  it('doubles an embedded double-quote in repoRoot', () => {
    const vbs = buildLauncherVbs(paPathCmd, args, 'D:\\Weird"Path');
    assert.ok(
      vbs.includes('WshShell.CurrentDirectory = "D:\\Weird""Path"'),
      'embedded quote in repoRoot must be doubled per VBScript string-literal escaping'
    );
  });

  it('the WshShell.Run line is byte-identical to the pre-fix format for the same paPathCmd/args (regression pin)', () => {
    const vbs = buildLauncherVbs(paPathCmd, args, 'D:\\Personal Assistant');
    const runLine = `WshShell.Run "cmd /c ""${paPathCmd}"" ${args}", 0, True\n`;
    assert.ok(vbs.includes(runLine), 'Run line must not change shape when CurrentDirectory was added');
  });
});
