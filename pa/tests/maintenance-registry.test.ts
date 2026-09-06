import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MAINTENANCE_JOBS, jobsForHost, findJob } from '../src/lib/maintenance/registry.js';
import { validateRegistry } from '../src/lib/maintenance/policy.js';
import { PRUNABLE_ARCHIVE_SUFFIXES } from '../src/lib/archive-files.js';
import { AGY_CONVERSATION_FILE_RE } from '../src/lib/session-gc.js';

describe('MAINTENANCE_JOBS registry', () => {
  it('validates against policy.ts without throwing', () => {
    assert.doesNotThrow(() => validateRegistry([...MAINTENANCE_JOBS]));
  });

  it('registry declares 32 jobs (23 pa + 9 bot) with the expected names', () => {
    assert.equal(MAINTENANCE_JOBS.length, 32);
    const names = MAINTENANCE_JOBS.map((j) => j.name).sort();
    assert.deepEqual(names, [
      'alert-census',
      'alert-digest',
      'alert-state-gc',
      'archive-prune',
      'blackboard-purge',
      'bot-log-rotation-check',
      'bot-self-restart',
      'c-disk-floor-watchdog',
      'clobber-sentinel',
      'daily-recon',
      'dashboard-refresh',
      'delivered-store-compact',
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
      'watch-jobs-runner',
      'weekly-learn',
      'worker-edit-audit-sweep',
      'worker-tee-gc',
    ]);
  });

  it('splits jobs correctly by host (23 pa, 9 bot)', () => {
    assert.equal(jobsForHost('pa').length, 23);
    assert.equal(jobsForHost('bot').length, 9);
    const botNames = jobsForHost('bot').map((j) => j.name).sort();
    assert.deepEqual(botNames, [
      'alert-digest',
      'bot-log-rotation-check',
      'bot-self-restart',
      'dashboard-refresh',
      'delivered-store-compact',
      'grounding-check',
      'model-override-sweep',
      'proxy-pool-refresh',
      'registry-content-watch',
    ]);
  });

  it('daily-recon registered for pa with 15m cadence', () => {
    const job = findJob('daily-recon');
    assert.ok(job, 'daily-recon should exist');
    assert.equal(job!.host, 'pa');
    assert.equal(resolveEvery(job!), 900_000);
    assert.deepEqual(job!.targets, [], 'phase 1 is a read-only sweep — no retention targets');
    assert.equal(job!.destructive, false);
    assert.equal(job!.shedWhenDegraded, true);
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

  it('watch-jobs-runner is declared for host pa, 60s cadence, one row-level target, never shed', () => {
    const job = findJob('watch-jobs-runner');
    assert.ok(job, 'watch-jobs-runner should exist');
    assert.equal(job!.host, 'pa');
    assert.equal(resolveEvery(job!), 60_000);
    assert.equal(job!.destructive, true);
    assert.equal(job!.shedWhenDegraded, false);
    assert.equal(job!.targets.length, 1);
    assert.ok(job!.targets[0].match.test('watch-jobs.json'));
    assert.equal(job!.targets[0].match.test('watch-jobs.json.bak'), false);
    assert.ok(job!.targets[0].note, 'row-level expiry must be declared in the target note');
  });

  it('locks the declared destructive set across both hosts', () => {
    const destructive = MAINTENANCE_JOBS.filter((j) => j.destructive).map((j) => j.name).sort();
    assert.deepEqual(destructive, [
      'alert-state-gc',
      'archive-prune',
      'delivered-store-compact',
      'orphan-worker-reap',
      'reservation-gc',
      'session-gc',
      'shared-tmp-sweep',
      'skill-log-rotate',
      'voice-attachment-gc',
      'watch-jobs-runner',
      'worker-edit-audit-sweep',
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
    assert.equal(findJob('alert-digest')?.name, 'alert-digest');
    assert.equal(findJob('nope'), undefined);
  });

  it('docs admission rule present in maintenance-jobs doc', () => {
    // __dirname there is pa/dist/tests — walk back up to the repo root (the
    // timer-inventory.test.ts pattern; pa tests run compiled from dist).
    const docPath = join(__dirname, '..', '..', '..', 'docs', 'maintenance-jobs.md');
    // Prose is line-wrapped — match against whitespace-normalized text so the
    // needles survive re-wrapping.
    const doc = readFileSync(docPath, 'utf8').replace(/\s+/g, ' ');
    // The frozen admission rule (Wave-2 SPEC §3.2, landed by WP-C) — the doc
    // is the rule's single home; this pin keeps it from silently drifting.
    assert.ok(
      doc.includes('extending a registry entry (a drain source, a recon phase) beats adding a job'),
      'the admission rule sentence must stay in docs/maintenance-jobs.md',
    );
    // The counts line states the numbers' history in one line (SPEC §5,
    // named edge 4): the current total plus what each growth step replaced.
    assert.ok(
      doc.includes('32 (23 pa + 9 bot)') && doc.includes('31 (22 pa + 9 bot)') && doc.includes('32 (22 pa + 10 bot)'),
      'the counts line must carry the current total AND the replaced ones',
    );
    // The consolidated family has its own section naming every source.
    for (const needle of ['`queue-drain`', '`requeue`', '`reminder-resume`', '`topic-task`', '`dlq`']) {
      assert.ok(doc.includes(needle), `the queue-drain section must name '${needle}'`);
    }
  });
});
