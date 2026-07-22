import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { appendAuditRecord, readAuditRecords } from '../src/lib/improvement-audit.js';
import type { AuditRecord } from '../src/lib/improvement-audit.js';
import type { RunMeta } from '../src/types.js';
import { acceptRollbackCommand, buildAcceptedRollbackBanner, buildEvalReport, buildFailedRollbackBanner, improvementsCommand } from '../src/commands/improvements.js';
import type { EvalEntry } from '../src/commands/improvements.js';

let dir: string;
const originalLog = console.log;
let output: string[] = [];

beforeEach(async () => {
  dir = await createTempPaHome();
  output = [];
  console.log = (...args: any[]) => output.push(args.join(' '));
});

afterEach(async () => {
  console.log = originalLog;
  await cleanup(dir);
});

async function createTempMeta(skillName: string, meta: RunMeta, nonce: string): Promise<void> {
  const logDir = join(dir, 'logs', skillName);
  await mkdir(logDir, { recursive: true });
  const ts = meta.timestamp.replace(/[:.]/g, '-').slice(0, 19);
  await writeFile(join(logDir, `${ts}-${nonce}.meta`), JSON.stringify(meta, null, 2), 'utf8');
}

function makeMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return { worker: 'gemini', status: 'success', exitCode: 0, duration: 1000, timestamp: new Date().toISOString(), ...overrides };
}

function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    ts: new Date().toISOString(),
    draft: 'x-fix',
    source_type: 'failure',
    action: 'applied-fix',
    risk_flags: [],
    reason: 'x failed twice.',
    ...overrides,
  };
}

describe('buildEvalReport', () => {
  it('reports a no-op message when there are no entries', () => {
    const report = buildEvalReport([], 30);
    assert.match(report, /No applied or rolled-back changes/);
  });

  it('shows baseline, current, and delta for a fix with a recorded baseline', () => {
    const entries: EvalEntry[] = [{
      record: makeRecord({
        draft: 'reminders-fix', action: 'applied-fix', target_skill: 'reminders',
        risk_flags: ['declares-secrets'],
        baseline: { window_days: 14, runs: 10, successes: 3, failures: 7 },
      }),
      current: { windowDays: 14, runs: 10, successes: 9, failures: 1 },
    }];
    const report = buildEvalReport(entries, 30);
    assert.match(report, /reminders-fix/);
    assert.match(report, /applied-fix/);
    assert.match(report, /risk: declares-secrets/);
    assert.match(report, /target: reminders/);
    assert.match(report, /baseline.*10 runs, 3 success, 7 fail/);
    assert.match(report, /current.*10 runs, 9 success, 1 fail/);
    assert.match(report, /delta: \+6 success, -6 fail/);
  });

  it('shows current-only (no baseline, no delta) for a brand-new skill with no baseline recorded', () => {
    const entries: EvalEntry[] = [{
      record: makeRecord({ draft: 'new-thing', action: 'approved-new-skill', target_skill: undefined, baseline: undefined }),
      current: { windowDays: 30, runs: 5, successes: 5, failures: 0 },
    }];
    const report = buildEvalReport(entries, 30);
    assert.match(report, /new-thing/);
    assert.match(report, /approved-new-skill/);
    assert.match(report, /target: new-thing \(new\)/);
    assert.match(report, /5 runs, 5 success, 0 fail/);
    assert.match(report, /no baseline recorded/);
    assert.doesNotMatch(report, /delta:/);
  });

  it('shows a zero delta when current matches baseline exactly (rolled-back, no recovery yet)', () => {
    const entries: EvalEntry[] = [{
      record: makeRecord({
        draft: 'flaky-fix', action: 'rolled-back', target_skill: 'flaky',
        baseline: { window_days: 14, runs: 8, successes: 2, failures: 6 },
      }),
      current: { windowDays: 14, runs: 8, successes: 2, failures: 6 },
    }];
    const report = buildEvalReport(entries, 30);
    assert.match(report, /delta: \+0 success, \+0 fail/);
  });

  it('leads with a FAILED ROLLBACK banner and does not gloss a rollback-failed as "newly created"', () => {
    const entries: EvalEntry[] = [{
      record: makeRecord({
        draft: 'pii-audit-fix', action: 'rollback-failed', target_skill: 'pii-audit',
        commit_hash: '7b82c88', baseline: undefined,
        reason: 'git revert 7b82c88 failed: Your local changes to pa/data/profile.json would be overwritten by merge',
      }),
      current: { windowDays: 30, runs: 3, successes: 0, failures: 3 },
    }];
    const report = buildEvalReport(entries, 30);

    // The banner must come before the per-entry listing — a live+condemned commit outranks
    // every delta in the report.
    const bannerIdx = report.indexOf('FAILED ROLLBACKS');
    assert.ok(bannerIdx >= 0, `expected a FAILED ROLLBACKS banner, got:\n${report}`);
    assert.ok(bannerIdx < report.indexOf('pii-audit-fix  [rollback-failed]'));
    assert.match(report, /STILL LIVE/);
    assert.match(report, /7b82c88/);
    assert.doesNotMatch(report, /newly created/);
  });

  it('groups repeated failed reverts of the SAME commit and counts the attempts', () => {
    // 7b82c88's revert failed on both 2026-07-13 and 2026-07-16 — a perma-failing revert is
    // retried nightly, so the attempt count is the signal that it is stuck, not transient.
    const mk = (ts: string) => ({
      record: makeRecord({ draft: 'pii-audit-fix', action: 'rollback-failed' as const, target_skill: 'pii-audit', ts, commit_hash: '7b82c88', baseline: undefined }),
      current: { windowDays: 30, runs: 0, successes: 0, failures: 0 },
    });
    const report = buildEvalReport([mk('2026-07-16T05:22:56.000Z'), mk('2026-07-13T03:49:38.000Z')], 30);

    assert.match(report, /1 commit\(s\), 2 failed attempt\(s\)/);
    assert.match(report, /2 failed attempt\(s\), last 2026-07-16/);
  });

  it('emits no banner at all when nothing failed to roll back', () => {
    const entries: EvalEntry[] = [{
      record: makeRecord({ draft: 'ok-fix', action: 'applied-fix', target_skill: 'ok', baseline: { window_days: 14, runs: 2, successes: 2, failures: 0 } }),
      current: { windowDays: 14, runs: 2, successes: 2, failures: 0 },
    }];
    assert.doesNotMatch(buildEvalReport(entries, 30), /FAILED ROLLBACK/);
  });

  it('includes the record date and omits the risk-flag suffix when there are none', () => {
    const entries: EvalEntry[] = [{
      record: makeRecord({ ts: '2026-07-01T12:00:00.000Z', draft: 'plain-fix', target_skill: 'plain', risk_flags: [], baseline: { window_days: 14, runs: 1, successes: 1, failures: 0 } }),
      current: { windowDays: 14, runs: 1, successes: 1, failures: 0 },
    }];
    const report = buildEvalReport(entries, 30);
    assert.match(report, /2026-07-01/);
    assert.doesNotMatch(report, /risk:/);
  });
});

// ---------------------------------------------------------------------------
// Human acceptance of a failed rollback (2026-07-22). Commit 7b82c88 was condemned by the
// loop, its `git revert` failed on 2026-07-13 and again on 2026-07-16 (the commit also
// carried pa/data/profile*.json, which the learn/oracle skills rewrite nightly), and
// checkForRollbacks() only looks back 7 days — so the loop will never retry it. A human
// reviewed it and decided to KEEP it. These tests pin the safety property: suppression is
// per-commit, never global.
// ---------------------------------------------------------------------------
describe('accepted failed rollbacks', () => {
  const failedFor = (commit: string, ts = '2026-07-16T05:22:56.000Z') => makeRecord({
    ts, draft: 'daily-mail-brief-fix-10', action: 'rollback-failed' as const,
    target_skill: 'daily-mail-brief', commit_hash: commit, baseline: undefined,
    reason: `git revert ${commit} failed: local changes to pa/data/profile.json would be overwritten`,
  });

  const acceptanceFor = (commit: string, reason = 'Reviewed by hand: diff is purely additive.') => makeRecord({
    ts: '2026-07-22T09:00:00.000Z', draft: 'daily-mail-brief-fix-10',
    action: 'rollback-accepted' as const, target_skill: 'daily-mail-brief',
    commit_hash: commit, accepted_at: '2026-07-22T09:00:00.000Z', accepted_by: 'human',
    reason, baseline: undefined,
  });

  const zero = { windowDays: 30, runs: 0, successes: 0, failures: 0 };

  it('suppresses the warning banner for a commit that has a matching acceptance', () => {
    const banner = buildFailedRollbackBanner([failedFor('7b82c88'), acceptanceFor('7b82c88')]);
    assert.deepEqual(banner, []);
  });

  it('still warns for a commit with NO acceptance', () => {
    const banner = buildFailedRollbackBanner([failedFor('7b82c88')]);
    assert.match(banner.join('\n'), /FAILED ROLLBACKS/);
    assert.match(banner.join('\n'), /7b82c88/);
  });

  it('an acceptance for a DIFFERENT commit does not suppress — the whole safety property', () => {
    // This is the regression that would turn a per-commit ack into a global mute.
    const banner = buildFailedRollbackBanner([failedFor('deadbee'), acceptanceFor('7b82c88')]).join('\n');
    assert.match(banner, /FAILED ROLLBACKS/);
    assert.match(banner, /1 commit\(s\), 1 failed attempt\(s\)/);
    assert.match(banner, /deadbee/);
    assert.doesNotMatch(banner, /7b82c88/);
  });

  it('warns about only the un-accepted commit when both are present', () => {
    const banner = buildFailedRollbackBanner([
      failedFor('7b82c88'), failedFor('deadbee'), acceptanceFor('7b82c88'),
    ]).join('\n');
    assert.match(banner, /1 commit\(s\), 1 failed attempt\(s\)/);
    assert.match(banner, /deadbee/);
    assert.doesNotMatch(banner, /7b82c88/);
  });

  it('accepts an acceptance passed separately from the in-window records (outside --since)', () => {
    // improvementsCommand hands over the UNFILTERED trail as `acceptances`, so an acceptance
    // older than the report window still silences its commit.
    assert.deepEqual(buildFailedRollbackBanner([failedFor('7b82c88')], [acceptanceFor('7b82c88')]), []);
  });

  it('renders the accepted commit as a KEPT decision instead of dropping it silently', () => {
    const report = buildEvalReport([
      { record: failedFor('7b82c88'), current: zero },
      { record: acceptanceFor('7b82c88'), current: zero },
    ], 30);

    // The alarm banner (its wording is unique to buildFailedRollbackBanner) is gone...
    assert.doesNotMatch(report, /CONDEMNED by the loop, the revert did NOT succeed/);
    // ...but the history survives: condemned + un-revertable + deliberately kept, with the reason.
    assert.match(report, /ACCEPTED FAILED ROLLBACKS/);
    assert.match(report, /7b82c88/);
    assert.match(report, /KEPT BY HUMAN DECISION/);
    assert.match(report, /revert of commit 7b82c88 FAILED/);
    assert.match(report, /rollback-accepted/);
    assert.match(report, /purely additive/);
    assert.match(report, /accepted 2026-07-22 by human/);
    // Neither record applied anything, so the "newly created" gloss must not appear.
    assert.doesNotMatch(report, /newly created/);
  });

  it('emits no ACCEPTED section when there are no acceptances', () => {
    const report = buildEvalReport([{ record: failedFor('7b82c88'), current: zero }], 30);
    assert.doesNotMatch(report, /ACCEPTED FAILED ROLLBACKS/);
    assert.match(report, /STILL LIVE/);
  });

  // Regression for the case-sensitivity mismatch: suppression (acceptedRollbackCommits/
  // findAcceptance) is deliberately case-insensitive, but the attempts count shown in the
  // ACCEPTED banner used to look up `failedByCommit` with the RAW (un-normalized) commit_hash,
  // so a case mismatch between the acceptance record and the rollback-failed record it covers
  // silently produced 0 attempts instead of the real count.
  it('reports the correct attempt count even when the acceptance record\'s commit hash differs in case from the rollback-failed record', () => {
    const banner = buildAcceptedRollbackBanner([
      failedFor('7b82c88'),
      failedFor('7b82c88'),
      acceptanceFor('7B82C88'), // human hand-typed uppercase
    ]).join('\n');
    assert.match(banner, /after 2 failed revert attempt\(s\)/);
  });

  it('reports the correct attempt count when the rollback-failed record\'s commit hash differs in case from the acceptance', () => {
    const banner = buildAcceptedRollbackBanner([
      { ...failedFor('7b82c88'), commit_hash: '7B82C88' },
      acceptanceFor('7b82c88'),
    ]).join('\n');
    assert.match(banner, /after 1 failed revert attempt\(s\)/);
  });
});

describe('acceptRollbackCommand', () => {
  it('writes a rollback-accepted record when a matching rollback-failed record exists', async () => {
    await appendAuditRecord(makeRecord({
      draft: 'daily-mail-brief-fix-10', action: 'rollback-failed', target_skill: 'daily-mail-brief',
      commit_hash: '7b82c88', reason: 'git revert 7b82c88 failed: local changes to pa/data/profile.json',
    }));

    await acceptRollbackCommand('7b82c88', 'Reviewed by hand: diff is purely additive.');

    const records = await readAuditRecords();
    const accepted = records.find((r) => r.action === 'rollback-accepted');
    assert.ok(accepted, 'expected a rollback-accepted record to have been written');
    assert.equal(accepted!.commit_hash, '7b82c88');
    assert.equal(accepted!.target_skill, 'daily-mail-brief');
    assert.equal(accepted!.draft, 'daily-mail-brief-fix-10');
    assert.equal(accepted!.accepted_by, 'human');
    assert.equal(accepted!.reason, 'Reviewed by hand: diff is purely additive.');
    assert.ok(accepted!.accepted_at);
    assert.ok(accepted!.ts);
  });

  it('matches the rollback-failed record case-insensitively', async () => {
    await appendAuditRecord(makeRecord({
      draft: 'x-fix', action: 'rollback-failed', target_skill: 'x', commit_hash: '7B82C88', reason: 'failed',
    }));

    await acceptRollbackCommand('7b82c88', 'ok');

    const records = await readAuditRecords();
    assert.ok(records.some((r) => r.action === 'rollback-accepted' && r.target_skill === 'x'));
  });

  it('fails loudly (throws, writes nothing) when there is no matching rollback-failed record', async () => {
    await appendAuditRecord(makeRecord({
      draft: 'unrelated-fix', action: 'rollback-failed', target_skill: 'unrelated', commit_hash: 'deadbee', reason: 'failed',
    }));

    await assert.rejects(() => acceptRollbackCommand('7b82c88', 'typo attempt'), /no rollback-failed record found/);

    const records = await readAuditRecords();
    assert.equal(records.filter((r) => r.action === 'rollback-accepted').length, 0);
  });

  it('fails loudly when no commit hash is given at all', async () => {
    await assert.rejects(() => acceptRollbackCommand(undefined, undefined), /Usage: pa improvements accept/);
  });

  it('defaults the reason when none is given, rather than writing an empty/undefined reason', async () => {
    await appendAuditRecord(makeRecord({
      draft: 'y-fix', action: 'rollback-failed', target_skill: 'y', commit_hash: 'cafef00d', reason: 'failed',
    }));

    await acceptRollbackCommand('cafef00d', undefined);

    const records = await readAuditRecords();
    const accepted = records.find((r) => r.action === 'rollback-accepted');
    assert.ok(accepted!.reason.length > 0);
  });
});

describe('improvementsCommand', () => {
  it('prints applied-fix, approved-new-skill, and rolled-back records with computed current stats', async () => {
    await appendAuditRecord(makeRecord({
      draft: 'a-fix', action: 'applied-fix', target_skill: 'skill-a',
      baseline: { window_days: 14, runs: 3, successes: 0, failures: 3 },
    }));
    await createTempMeta('skill-a', makeMeta({ status: 'success' }), 'n1');
    await createTempMeta('skill-a', makeMeta({ status: 'success' }), 'n2');

    await improvementsCommand(30);

    const text = output.join('\n');
    assert.match(text, /a-fix/);
    assert.match(text, /skill-a/);
    assert.match(text, /2 runs, 2 success, 0 fail/); // current
    assert.match(text, /3 runs, 0 success, 3 fail/); // baseline
  });

  it('excludes non-applied/rolled-back actions (rejected_auto, rejected_stale, validation-failed)', async () => {
    await appendAuditRecord(makeRecord({ draft: 'skip-1', action: 'rejected_auto' }));
    await appendAuditRecord(makeRecord({ draft: 'skip-2', action: 'rejected_stale' }));
    await appendAuditRecord(makeRecord({ draft: 'skip-3', action: 'validation-failed' }));

    await improvementsCommand(30);

    const text = output.join('\n');
    assert.doesNotMatch(text, /skip-1/);
    assert.doesNotMatch(text, /skip-2/);
    assert.doesNotMatch(text, /skip-3/);
    assert.match(text, /No applied or rolled-back changes/);
  });

  it('respects the --since window, excluding records older than it', async () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await appendAuditRecord(makeRecord({ draft: 'old-fix', action: 'applied-fix', target_skill: 'old-skill', ts: old, baseline: { window_days: 14, runs: 1, successes: 1, failures: 0 } }));
    await appendAuditRecord(makeRecord({ draft: 'recent-fix', action: 'applied-fix', target_skill: 'recent-skill', baseline: { window_days: 14, runs: 1, successes: 1, failures: 0 } }));

    await improvementsCommand(30);

    const text = output.join('\n');
    assert.doesNotMatch(text, /old-fix/);
    assert.match(text, /recent-fix/);
  });

  it('handles an approved-new-skill record by using the draft name as the eval target', async () => {
    await appendAuditRecord(makeRecord({ draft: 'brand-new-skill', action: 'approved-new-skill', target_skill: undefined, baseline: undefined }));
    await createTempMeta('brand-new-skill', makeMeta({ status: 'success' }), 'n1');

    await improvementsCommand(30);

    const text = output.join('\n');
    assert.match(text, /brand-new-skill/);
    assert.match(text, /1 runs, 1 success, 0 fail/);
  });

  it('includes applied-code-fix records with commit hash and files-changed count (2026-07-11)', async () => {
    await appendAuditRecord(makeRecord({
      draft: 'cdu-code-fix', action: 'applied-code-fix', target_skill: 'coding-dirs-update',
      commit_hash: 'abc1234',
      files_changed: ['projects/coding-dirs-updater/update_coding_dirs.py', 'projects/coding-dirs-updater/tests/test_update.py'],
      baseline: { window_days: 14, runs: 4, successes: 1, failures: 3 },
    }));
    await createTempMeta('coding-dirs-update', makeMeta({ status: 'success' }), 'n1');

    await improvementsCommand(30);

    const text = output.join('\n');
    assert.match(text, /cdu-code-fix/);
    assert.match(text, /applied-code-fix/);
    assert.match(text, /commit abc1234/);
    assert.match(text, /2 file\(s\) changed/);
    assert.match(text, /4 runs, 1 success, 3 fail/); // baseline still shown
  });

  it('counts and displays rollback-failed records alongside the fix they failed to undo (2026-07-21)', async () => {
    // The exact production shape this fixes: 7b82c88 was applied, condemned, and its revert
    // failed twice — yet the report used to render only the applied-code-fix line, reading as
    // a clean win while the condemned commit was still live.
    await appendAuditRecord(makeRecord({
      draft: 'pii-audit-fix', action: 'applied-code-fix', target_skill: 'pii-audit',
      commit_hash: '7b82c88', files_changed: ['pa/scripts/pii_guard.py'],
      baseline: { window_days: 14, runs: 24, successes: 0, failures: 23 },
    }));
    await appendAuditRecord(makeRecord({
      draft: 'pii-audit-fix', action: 'rollback-failed', target_skill: 'pii-audit',
      commit_hash: '7b82c88',
      reason: 'git revert 7b82c88 failed: Your local changes to the following files would be overwritten by merge: pa/data/profile.json',
    }));
    await appendAuditRecord(makeRecord({
      draft: 'pii-audit-fix', action: 'rollback-failed', target_skill: 'pii-audit',
      commit_hash: '7b82c88',
      reason: 'git revert 7b82c88 failed: Your local changes to the following files would be overwritten by merge: pa/data/profile.json',
    }));
    await createTempMeta('pii-audit', makeMeta({ status: 'success' }), 'n1');

    await improvementsCommand(30);

    const text = output.join('\n');
    assert.match(text, /FAILED ROLLBACKS/);
    assert.match(text, /1 commit\(s\), 2 failed attempt\(s\)/);
    assert.match(text, /STILL LIVE/);
    assert.match(text, /7b82c88/);
    // The applied-code-fix line is still there — the point is that it is no longer the ONLY
    // thing the reader sees.
    assert.match(text, /applied-code-fix/);
  });

  it('suppresses the banner for a human-ACCEPTED failed rollback but still reports it (2026-07-22)', async () => {
    // End-to-end shape of the 7b82c88 decision: applied, condemned, revert failed twice, then
    // accepted by a human. The alarm goes quiet; the history does not.
    await appendAuditRecord(makeRecord({
      draft: 'daily-mail-brief-fix-10', action: 'applied-code-fix', target_skill: 'daily-mail-brief',
      commit_hash: '7b82c88', files_changed: ['projects/daily-mail-brief/scripts/run_brief.py'],
      baseline: { window_days: 14, runs: 39, successes: 13, failures: 26 },
    }));
    await appendAuditRecord(makeRecord({
      draft: 'daily-mail-brief-fix-10', action: 'rollback-failed', target_skill: 'daily-mail-brief',
      commit_hash: '7b82c88', reason: 'git revert 7b82c88 failed: local changes to pa/data/profile.json',
    }));
    await appendAuditRecord(makeRecord({
      draft: 'daily-mail-brief-fix-10', action: 'rollback-accepted', target_skill: 'daily-mail-brief',
      commit_hash: '7b82c88', accepted_at: '2026-07-22T09:00:00.000Z', accepted_by: 'human',
      reason: 'Human decision: keep the commit. Diff is purely additive.',
    }));
    await createTempMeta('daily-mail-brief', makeMeta({ status: 'success' }), 'n1');

    await improvementsCommand(30);

    const text = output.join('\n');
    assert.doesNotMatch(text, /CONDEMNED by the loop, the revert did NOT succeed/);
    assert.match(text, /ACCEPTED FAILED ROLLBACKS/);
    assert.match(text, /rollback-accepted/);
    assert.match(text, /7b82c88/);
    assert.match(text, /purely additive/);
  });

  it('a different commit failing to revert still raises the banner despite an existing acceptance', async () => {
    await appendAuditRecord(makeRecord({
      draft: 'daily-mail-brief-fix-10', action: 'rollback-accepted', target_skill: 'daily-mail-brief',
      commit_hash: '7b82c88', accepted_at: '2026-07-22T09:00:00.000Z', accepted_by: 'human',
      reason: 'Accepted.',
    }));
    await appendAuditRecord(makeRecord({
      draft: 'other-fix', action: 'rollback-failed', target_skill: 'other-skill',
      commit_hash: 'deadbee', reason: 'git revert deadbee failed: conflict',
    }));

    await improvementsCommand(30);

    const text = output.join('\n');
    assert.match(text, /CONDEMNED by the loop, the revert did NOT succeed/);
    assert.match(text, /deadbee/);
    assert.match(text, /1 commit\(s\), 1 failed attempt\(s\)/);
  });

  it('honours an acceptance recorded OUTSIDE the --since window (2026-07-22)', async () => {
    // The acceptance is 60 days old; the failed revert it closes out is recent. Filtering the
    // acceptance by the report window would resurrect an alarm a human already answered.
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await appendAuditRecord(makeRecord({
      ts: old, draft: 'daily-mail-brief-fix-10', action: 'rollback-accepted',
      target_skill: 'daily-mail-brief', commit_hash: '7b82c88', accepted_at: old,
      accepted_by: 'human', reason: 'Accepted long ago.',
    }));
    await appendAuditRecord(makeRecord({
      draft: 'daily-mail-brief-fix-10', action: 'rollback-failed',
      target_skill: 'daily-mail-brief', commit_hash: '7b82c88', reason: 'git revert 7b82c88 failed',
    }));

    await improvementsCommand(30);

    const text = output.join('\n');
    assert.doesNotMatch(text, /CONDEMNED by the loop, the revert did NOT succeed/);
    assert.match(text, /KEPT BY HUMAN DECISION/);
  });

  it('shows the revert commit hash on a rolled-back code-fix record (2026-07-11)', async () => {
    await appendAuditRecord(makeRecord({
      draft: 'cdu-code-fix', action: 'rolled-back', target_skill: 'coding-dirs-update',
      commit_hash: 'abc1234', revert_commit_hash: 'def5678',
      baseline: { window_days: 14, runs: 4, successes: 1, failures: 3 },
    }));

    await improvementsCommand(30);

    const text = output.join('\n');
    assert.match(text, /rolled-back/);
    assert.match(text, /reverted commit abc1234/);
    assert.match(text, /revert: def5678/);
  });
});
