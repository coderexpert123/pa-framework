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

  it('declares exactly 29 jobs (19 pa + 10 bot) with the expected names', () => {
    assert.equal(MAINTENANCE_JOBS.length, 29);
    const names = MAINTENANCE_JOBS.map((j) => j.name).sort();
    assert.deepEqual(names, [
      'alert-census',
      'alert-digest',
      'alert-state-gc',
      'archive-prune',
      'blackboard-purge',
      'bot-log-rotation-check',
      'bot-self-restart',
      'clobber-sentinel',
      'dashboard-refresh',
      'delivered-store-compact',
      'dlq-flush',
      'grounding-check',
      'model-override-sweep',
      'orphan-worker-reap',
      'proxy-pool-refresh',
      'recall-index',
      'redteam-recurring',
      'registry-content-watch',
      'reservation-gc',
      'restore-drill',
      'review-conflict-buttons',
      'session-gc',
      'shared-tmp-sweep',
      'skill-engagement-audit',
      'skill-log-rotate',
      'staleness-check',
      'voice-attachment-gc',
      'weekly-learn',
      'worker-tee-gc',
    ]);
  });

  it('splits jobs correctly by host (19 pa, 10 bot)', () => {
    assert.equal(jobsForHost('pa').length, 19);
    assert.equal(jobsForHost('bot').length, 10);
    const botNames = jobsForHost('bot').map((j) => j.name).sort();
    assert.deepEqual(botNames, [
      'alert-digest',
      'bot-log-rotation-check',
      'bot-self-restart',
      'dashboard-refresh',
      'delivered-store-compact',
      'dlq-flush',
      'grounding-check',
      'model-override-sweep',
      'proxy-pool-refresh',
      'registry-content-watch',
    ]);
  });

  it('recall-index is declared for host pa with a 10-minute cadence and no targets', () => {
    const job = findJob('recall-index');
    assert.ok(job, 'recall-index should exist');
    assert.equal(job!.host, 'pa');
    assert.equal(resolveEvery(job!), 600_000);
    assert.deepEqual(job!.targets, []);
    assert.equal(job!.destructive, false);
    assert.equal(job!.shedWhenDegraded, true);
  });

  it('bot-self-restart is declared for host bot with a 60s cadence and no targets', () => {
    const job = findJob('bot-self-restart');
    assert.ok(job, 'bot-self-restart should exist');
    assert.equal(job!.host, 'bot');
    assert.equal(resolveEvery(job!), 60_000);
    assert.deepEqual(job!.targets, []);
    assert.equal(job!.destructive, false);
    assert.equal(job!.shedWhenDegraded, true);
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
    for (const name of ['skill-log-rotate', 'archive-prune', 'alert-state-gc']) {
      const job = findJob(name);
      assert.ok(job, `${name} should exist`);
      assert.equal(resolveEvery(job!), 3_600_000, `${name} cadence`);
    }
  });

  it('locks session-gc at 6h, grounding-check at 6h, and weekly-learn at 7d', () => {
    assert.equal(resolveEvery(findJob('session-gc')!), 21_600_000);
    assert.equal(resolveEvery(findJob('grounding-check')!), 21_600_000);
    assert.equal(resolveEvery(findJob('weekly-learn')!), 604_800_000);
    assert.equal(resolveEvery(findJob('alert-census')!), 86_400_000);
  });

  it('registry-content-watch is declared for host bot with a 24h cadence and no targets', () => {
    const job = findJob('registry-content-watch');
    assert.ok(job, 'registry-content-watch should exist');
    assert.equal(job!.host, 'bot');
    assert.equal(resolveEvery(job!), 86_400_000);
    assert.deepEqual(job!.targets, []);
    assert.equal(job!.destructive, false);
    assert.equal(job!.shedWhenDegraded, true);
  });

  it('alert-digest is declared for host bot with a 24h cadence and no targets', () => {
    const job = findJob('alert-digest');
    assert.ok(job, 'alert-digest should exist');
    assert.equal(job!.host, 'bot');
    assert.equal(resolveEvery(job!), 86_400_000);
    assert.deepEqual(job!.targets, []);
    assert.equal(job!.destructive, false);
    assert.equal(job!.shedWhenDegraded, true);
  });

  it('review-conflict-buttons is declared for host pa with a 24h cadence and no targets', () => {
    const job = findJob('review-conflict-buttons');
    assert.ok(job, 'review-conflict-buttons should exist');
    assert.equal(job!.host, 'pa');
    assert.equal(resolveEvery(job!), 86_400_000);
    assert.deepEqual(job!.targets, []);
    assert.equal(job!.destructive, false);
    assert.equal(job!.shedWhenDegraded, true);
  });

  it('skill-engagement-audit is declared for host pa with a 30-day cadence and no targets', () => {
    const job = findJob('skill-engagement-audit');
    assert.ok(job, 'skill-engagement-audit should exist');
    assert.equal(job!.host, 'pa');
    assert.equal(resolveEvery(job!), 2_592_000_000);
    assert.deepEqual(job!.targets, []);
    assert.equal(job!.destructive, false);
    assert.equal(job!.shedWhenDegraded, true);
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
      'shared-tmp-sweep',
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
