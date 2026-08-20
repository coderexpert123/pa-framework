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

  it('declares exactly 21 jobs (15 pa + 6 bot) with the expected names', () => {
    assert.equal(MAINTENANCE_JOBS.length, 21);
    const names = MAINTENANCE_JOBS.map((j) => j.name).sort();
    assert.deepEqual(names, [
      'alert-state-gc',
      'archive-prune',
      'blackboard-purge',
      'bot-log-rotation-check',
      'clobber-sentinel',
      'delivered-store-compact',
      'dlq-flush',
      'grounding-check',
      'model-override-sweep',
      'orphan-worker-reap',
      'proxy-pool-refresh',
      'redteam-recurring',
      'reservation-gc',
      'restore-drill',
      'session-gc',
      'skill-cadence-audit',
      'skill-log-rotate',
      'staleness-check',
      'voice-attachment-gc',
      'weekly-learn',
      'worker-tee-gc',
    ]);
  });

  it('splits jobs correctly by host (15 pa, 6 bot)', () => {
    assert.equal(jobsForHost('pa').length, 15);
    assert.equal(jobsForHost('bot').length, 6);
    const botNames = jobsForHost('bot').map((j) => j.name).sort();
    assert.deepEqual(botNames, [
      'bot-log-rotation-check',
      'delivered-store-compact',
      'dlq-flush',
      'grounding-check',
      'model-override-sweep',
      'proxy-pool-refresh',
    ]);
  });

  function resolveEvery(job: (typeof MAINTENANCE_JOBS)[number]): number {
    return typeof job.everyMs === 'function' ? job.everyMs() : job.everyMs;
  }

  it('locks the declared cadence for the 1-minute jobs', () => {
    for (const name of ['orphan-worker-reap', 'blackboard-purge', 'staleness-check', 'model-override-sweep']) {
      const job = findJob(name);
      assert.ok(job, `${name} should exist`);
      assert.equal(resolveEvery(job!), 60_000, `${name} cadence`);
    }
  });

  it('locks the declared cadence for the 1-hour jobs', () => {
    for (const name of ['skill-cadence-audit', 'skill-log-rotate', 'archive-prune', 'alert-state-gc']) {
      const job = findJob(name);
      assert.ok(job, `${name} should exist`);
      assert.equal(resolveEvery(job!), 3_600_000, `${name} cadence`);
    }
  });

  it('locks session-gc at 6h, grounding-check at 6h, and weekly-learn at 7d', () => {
    assert.equal(resolveEvery(findJob('session-gc')!), 21_600_000);
    assert.equal(resolveEvery(findJob('grounding-check')!), 21_600_000);
    assert.equal(resolveEvery(findJob('weekly-learn')!), 604_800_000);
  });

  it('locks the declared destructive set across both hosts', () => {
    const destructive = MAINTENANCE_JOBS.filter((j) => j.destructive).map((j) => j.name).sort();
    assert.deepEqual(destructive, [
      'alert-state-gc',
      'archive-prune',
      'delivered-store-compact',
      'dlq-flush',
      'orphan-worker-reap',
      'reservation-gc',
      'session-gc',
      'skill-log-rotate',
      'voice-attachment-gc',
      'worker-tee-gc',
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

  it('findJob resolves known names across both hosts and returns undefined for unknown ones', () => {
    assert.equal(findJob('session-gc')?.name, 'session-gc');
    assert.equal(findJob('dlq-flush')?.name, 'dlq-flush');
    assert.equal(findJob('nope'), undefined);
  });
});
