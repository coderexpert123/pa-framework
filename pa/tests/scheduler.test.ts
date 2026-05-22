import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, createTempSkill, cleanup } from './helpers.js';
import { writeLog } from '../src/logger.js';
import { getOverdueSkills } from '../src/scheduler.js';
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
    // Skill runs every hour, last run was 5 minutes ago
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await setupSkill('recent', '0 * * * *', 'latest', fiveMinAgo);
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
