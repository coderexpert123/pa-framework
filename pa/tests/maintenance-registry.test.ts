import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAINTENANCE_JOBS, jobsForHost, findJob } from '../src/lib/maintenance/registry.js';
import { validateRegistry } from '../src/lib/maintenance/policy.js';
import { PRUNABLE_ARCHIVE_SUFFIXES } from '../src/lib/archive-files.js';
import { AGY_CONVERSATION_FILE_RE } from '../src/lib/session-gc.js';

describe('MAINTENANCE_JOBS registry', () => {
  it('validates against policy.ts without throwing', () => {
    assert.doesNotThrow(() => validateRegistry([...MAINTENANCE_JOBS]));
  });

  it('declares exactly 10 jobs with the expected names', () => {
    assert.equal(MAINTENANCE_JOBS.length, 10);
    const names = MAINTENANCE_JOBS.map((j) => j.name).sort();
    assert.deepEqual(names, [
      'alert-state-gc',
      'archive-prune',
      'blackboard-purge',
      'orphan-worker-reap',
      'reservation-gc',
      'session-gc',
      'skill-log-rotate',
      'staleness-check',
      'voice-attachment-gc',
      'weekly-learn',
    ]);
  });

  // jobsForHost('bot') is 0 BY DESIGN, not because Wave 2 is pending. Bot jobs
  // close over a runtime token/chatIds/sentinelPath that only exist after the
  // bot's main() loads secrets, and pa cannot import bot source — so they are
  // built by createBotMaintenanceJobs() in
  // projects/telegram-bot/src/maintenance-jobs.ts and handed straight to
  // runDueJobs('bot', …). See AI-100 Wave 2.
  it('every registry job is host: "pa" — bot jobs are constructed in-process, not registered here', () => {
    for (const job of MAINTENANCE_JOBS) {
      assert.equal(job.host, 'pa', `${job.name} should be host: 'pa'`);
    }
    assert.equal(jobsForHost('bot').length, 0);
    assert.equal(jobsForHost('pa').length, 10);
  });

  function resolveEvery(job: (typeof MAINTENANCE_JOBS)[number]): number {
    return typeof job.everyMs === 'function' ? job.everyMs() : job.everyMs;
  }

  it('locks the declared cadence for the three 1-minute jobs', () => {
    for (const name of ['orphan-worker-reap', 'blackboard-purge', 'staleness-check']) {
      const job = findJob(name);
      assert.ok(job, `${name} should exist`);
      assert.equal(resolveEvery(job!), 60_000, `${name} cadence`);
    }
  });

  it('locks the declared cadence for the three 1-hour jobs', () => {
    for (const name of ['skill-log-rotate', 'archive-prune', 'alert-state-gc']) {
      const job = findJob(name);
      assert.ok(job, `${name} should exist`);
      assert.equal(resolveEvery(job!), 3_600_000, `${name} cadence`);
    }
  });

  it('locks session-gc at 6h and weekly-learn at 7d', () => {
    assert.equal(resolveEvery(findJob('session-gc')!), 21_600_000);
    assert.equal(resolveEvery(findJob('weekly-learn')!), 604_800_000);
  });

  it('locks the declared destructive set', () => {
    const destructive = MAINTENANCE_JOBS.filter((j) => j.destructive).map((j) => j.name).sort();
    assert.deepEqual(destructive, [
      'alert-state-gc',
      'archive-prune',
      'orphan-worker-reap',
      'reservation-gc',
      'session-gc',
      'skill-log-rotate',
      'voice-attachment-gc',
    ]);
  });

  it("archive-prune's match mirrors the real PRUNABLE_ARCHIVE_SUFFIXES allowlist", () => {
    const job = findJob('archive-prune')!;
    const target = job.targets[0];
    for (const suffix of PRUNABLE_ARCHIVE_SUFFIXES) {
      assert.ok(target.match.test('2026-01-01-000000' + suffix), `should match ${suffix}`);
    }
    assert.equal(target.match.test('2026-01-01-000000-conversation-history.jsonl'), false);
  });

  it("session-gc's agy target match is AGY_CONVERSATION_FILE_RE", () => {
    const job = findJob('session-gc')!;
    const agyTarget = job.targets.find((t) => t.ownership === 'external-no-retention' && t.action === 'delete')!;
    assert.equal(agyTarget.match, AGY_CONVERSATION_FILE_RE);
    assert.ok(agyTarget.match.test('12345678-1234-1234-1234-123456789012.pb'));
    assert.ok(agyTarget.match.test('12345678-1234-1234-1234-123456789012.db'));
    assert.equal(agyTarget.match.test('index.pb'), false);
  });

  it('findJob resolves known names and returns undefined for unknown ones', () => {
    assert.equal(findJob('session-gc')?.name, 'session-gc');
    assert.equal(findJob('nope'), undefined);
  });
});
