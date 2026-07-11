import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { readRecentFailures, buildFailurePrompt, checkForRollbacks } from '../src/failure-analyzer.js';
import type { FailureRecord } from '../src/failure-analyzer.js';
import { createTempPaHome, createTempSkill, createTempDraft, cleanup } from './helpers.js';
import { appendAuditRecord } from '../src/lib/improvement-audit.js';
import type { DraftMeta, RunMeta } from '../src/types.js';

async function createTempMeta(dir: string, skillName: string, meta: RunMeta): Promise<void> {
  const logDir = join(dir, 'logs', skillName);
  await mkdir(logDir, { recursive: true });
  const ts = meta.timestamp.replace(/[:.]/g, '-').slice(0, 19);
  await writeFile(join(logDir, `${ts}-abc123.meta`), JSON.stringify(meta, null, 2), 'utf8');
}

function makeErrorMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    worker: 'gemini',
    status: 'error',
    exitCode: -1,
    duration: 300000,
    timestamp: new Date().toISOString(),
    error: 'Killed: exceeded max timeout of 600s',
    ...overrides,
  };
}

describe('failure-analyzer', () => {
  let dir: string;

  before(async () => {
    dir = await createTempPaHome();
  });

  after(async () => {
    await cleanup(dir);
  });

  describe('readRecentFailures', () => {
    it('reads meta files and filters to errors within date range', async () => {
      await createTempMeta(dir, 'my-skill', makeErrorMeta({ error: 'Timed out' }));

      const failures = await readRecentFailures(7);
      const skillFailures = failures.filter((f) => f.skillName === 'my-skill');
      assert.ok(skillFailures.length >= 1);
      assert.equal(skillFailures[0].error, 'Timed out');
    });

    it('excludes old failures outside the date window', async () => {
      const oldTimestamp = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
      await createTempMeta(dir, 'old-skill', makeErrorMeta({ timestamp: oldTimestamp, error: 'Old error' }));

      const failures = await readRecentFailures(7);
      const oldFailures = failures.filter((f) => f.skillName === 'old-skill');
      assert.equal(oldFailures.length, 0);
    });

    it('excludes successful runs', async () => {
      await createTempMeta(dir, 'success-skill', {
        worker: 'claude',
        status: 'success',
        exitCode: 0,
        duration: 1000,
        timestamp: new Date().toISOString(),
      });

      const failures = await readRecentFailures(7);
      const successRuns = failures.filter((f) => f.skillName === 'success-skill');
      assert.equal(successRuns.length, 0);
    });

    it('returns empty array when logs dir does not exist', async () => {
      const origHome = process.env.PA_HOME;
      try {
        process.env.PA_HOME = join(dir, 'no-such-subdir');
        const failures = await readRecentFailures(7);
        assert.deepEqual(failures, []);
      } finally {
        process.env.PA_HOME = origHome;
      }
    });
  });

  describe('buildFailurePrompt', () => {
    it('groups failures by skill and includes counts', () => {
      const failures: FailureRecord[] = [
        { skillName: 'my-skill', error: 'Timeout', timestamp: new Date().toISOString(), duration: 600000, worker: 'gemini' },
        { skillName: 'my-skill', error: 'Timeout', timestamp: new Date().toISOString(), duration: 600000, worker: 'gemini' },
        { skillName: 'other-skill', error: 'Auth error', timestamp: new Date().toISOString(), duration: 1000, worker: 'claude' },
        { skillName: 'other-skill', error: 'Auth error', timestamp: new Date().toISOString(), duration: 1000, worker: 'claude' },
      ];

      const prompt = buildFailurePrompt(failures, [], []);
      assert.match(prompt, /my-skill/);
      assert.match(prompt, /other-skill/);
      assert.match(prompt, /2 failures/);
      assert.match(prompt, /Timeout/);
      assert.match(prompt, /Auth error/);
    });

    it('excludes skills with only 1 failure', () => {
      const failures: FailureRecord[] = [
        { skillName: 'one-off', error: 'Fluke', timestamp: new Date().toISOString(), duration: 100, worker: 'gemini' },
      ];

      const prompt = buildFailurePrompt(failures, [], []);
      assert.doesNotMatch(prompt, /one-off/);
      assert.match(prompt, /no qualifying failures/);
    });

    it('includes existing skills in exclusion context', () => {
      const prompt = buildFailurePrompt([], ['daily-mail-brief'], []);
      assert.match(prompt, /daily-mail-brief/);
    });

    it('requests an optional code_target file-path hint (2026-07-11 code-fix capability)', () => {
      const failures: FailureRecord[] = [
        { skillName: 'daily-mail-brief', error: 'Missing BRIEFING marker', timestamp: new Date().toISOString(), duration: 5000, worker: 'gemini' },
        { skillName: 'daily-mail-brief', error: 'Missing BRIEFING marker', timestamp: new Date().toISOString(), duration: 5000, worker: 'gemini' },
      ];
      const prompt = buildFailurePrompt(failures, ['daily-mail-brief'], []);
      assert.match(prompt, /code_target/);
    });
  });

  describe('checkForRollbacks', () => {
    function draftMeta(overrides: Partial<DraftMeta> = {}): DraftMeta {
      return {
        proposed_at: new Date().toISOString(),
        reason: 'test',
        source_turns: [],
        status: 'approved',
        fingerprint: 'abc123',
        source_type: 'failure',
        reviewed_at: new Date().toISOString(),
        ...overrides,
      };
    }

    async function makeFailingSkill(skillName: string): Promise<void> {
      // 3 errors, 1 success within the last 24h → 75% failure rate, over the 50% threshold
      for (let i = 0; i < 3; i++) {
        await createTempMeta(dir, skillName, makeErrorMeta({ timestamp: new Date(Date.now() - i * 60000).toISOString() }));
      }
      await createTempMeta(dir, skillName, {
        worker: 'gemini', status: 'success', exitCode: 0, duration: 1000,
        timestamp: new Date().toISOString(),
      });
    }

    it('flags "restore" for a skill with a matching applied_in_place fix draft, most recent one wins', async () => {
      await makeFailingSkill('reminders');
      await createTempSkill(dir, 'reminders', 'Broken now.');
      await createTempDraft(dir, 'reminders-fix', 'Old fix.', draftMeta({
        target_skill: 'reminders', applied_in_place: true, approved_autonomously: true,
        reviewed_at: new Date(Date.now() - 60000).toISOString(),
      }));
      await createTempDraft(dir, 'reminders-fix-2', 'Newer fix.', draftMeta({
        target_skill: 'reminders', applied_in_place: true, approved_autonomously: true,
        reviewed_at: new Date().toISOString(),
      }));

      const flags = await checkForRollbacks();
      const flag = flags.find((f) => f.skillName === 'reminders');
      assert.ok(flag, 'expected a rollback flag for reminders');
      assert.equal(flag!.kind, 'restore');
      assert.equal(flag!.draftName, 'reminders-fix-2'); // the more recent one
    });

    it('flags "delete" for a brand-new autonomously-approved skill with no in-place-fix draft', async () => {
      await makeFailingSkill('new-diagnostic-skill');
      await createTempSkill(dir, 'new-diagnostic-skill', 'Broken now.');
      await createTempDraft(dir, 'new-diagnostic-skill', 'Original.', draftMeta({
        approved_autonomously: true,
      }));

      const flags = await checkForRollbacks();
      const flag = flags.find((f) => f.skillName === 'new-diagnostic-skill');
      assert.ok(flag, 'expected a rollback flag for new-diagnostic-skill');
      assert.equal(flag!.kind, 'delete');
      assert.equal(flag!.draftName, 'new-diagnostic-skill');
    });

    it('does not flag a manually-approved skill (no approved_autonomously)', async () => {
      await makeFailingSkill('manual-skill');
      await createTempSkill(dir, 'manual-skill', 'Broken now.');
      await createTempDraft(dir, 'manual-skill', 'Original.', draftMeta({
        approved_autonomously: undefined,
      }));

      const flags = await checkForRollbacks();
      assert.equal(flags.find((f) => f.skillName === 'manual-skill'), undefined);
    });

    it('does not flag a skill with a healthy (low) failure rate', async () => {
      await createTempSkill(dir, 'healthy-skill', 'Fine.');
      await createTempDraft(dir, 'healthy-skill', 'Original.', draftMeta({ approved_autonomously: true }));
      for (let i = 0; i < 4; i++) {
        await createTempMeta(dir, 'healthy-skill', {
          worker: 'gemini', status: 'success', exitCode: 0, duration: 1000,
          timestamp: new Date(Date.now() - i * 60000).toISOString(),
        });
      }

      const flags = await checkForRollbacks();
      assert.equal(flags.find((f) => f.skillName === 'healthy-skill'), undefined);
    });

    it('does not flag a skill with a single failed run (100% of n=1 is not a meaningful sample)', async () => {
      await createTempSkill(dir, 'sparse-skill', 'Broken now.');
      await createTempDraft(dir, 'sparse-skill', 'Original.', draftMeta({ approved_autonomously: true }));
      await createTempMeta(dir, 'sparse-skill', makeErrorMeta({ timestamp: new Date().toISOString() }));

      const flags = await checkForRollbacks();
      assert.equal(flags.find((f) => f.skillName === 'sparse-skill'), undefined,
        'a single failing run must not trigger a rollback regardless of its 100% rate');
    });

    it('flags "git-revert" with the commit hash for a failing skill with a recent applied-code-fix audit record (2026-07-11)', async () => {
      await makeFailingSkill('coding-dirs-update');
      await appendAuditRecord({
        ts: new Date().toISOString(), draft: 'coding-dirs-update-fix', source_type: 'failure',
        target_skill: 'coding-dirs-update', action: 'applied-code-fix', risk_flags: [],
        reason: 'markers missing', commit_hash: 'abc1234',
        files_changed: ['projects/coding-dirs-updater/update_coding_dirs.py'],
      });

      const flags = await checkForRollbacks();
      const flag = flags.find((f) => f.skillName === 'coding-dirs-update');
      assert.ok(flag, 'expected a rollback flag for the code-fixed failing skill');
      assert.equal(flag!.kind, 'git-revert');
      assert.equal(flag!.commitHash, 'abc1234');
      assert.equal(flag!.draftName, 'coding-dirs-update-fix');
    });

    it('does NOT flag git-revert when the applied-code-fix record is older than the lookback window', async () => {
      // NOTE: this suite shares one temp PA_HOME across tests (before, not beforeEach), so
      // the audit file accumulates — each git-revert test uses its own unique skill name.
      await makeFailingSkill('cdu-stale-skill');
      await appendAuditRecord({
        ts: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), // 8d > 7d lookback
        draft: 'cdu-stale-skill-fix', source_type: 'failure',
        target_skill: 'cdu-stale-skill', action: 'applied-code-fix', risk_flags: [],
        reason: 'markers missing', commit_hash: 'abc1234',
      });

      const flags = await checkForRollbacks();
      assert.equal(flags.find((f) => f.skillName === 'cdu-stale-skill'), undefined);
    });

    it('the most recent applied-code-fix record wins when several exist for the same skill', async () => {
      await makeFailingSkill('cdu-multi-skill');
      await appendAuditRecord({
        ts: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        draft: 'older-fix', source_type: 'failure', target_skill: 'cdu-multi-skill',
        action: 'applied-code-fix', risk_flags: [], reason: 'x', commit_hash: 'old1111',
      });
      await appendAuditRecord({
        ts: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1h ago — strictly newer
        draft: 'newer-fix', source_type: 'failure', target_skill: 'cdu-multi-skill',
        action: 'applied-code-fix', risk_flags: [], reason: 'y', commit_hash: 'new2222',
      });

      const flags = await checkForRollbacks();
      const flag = flags.find((f) => f.skillName === 'cdu-multi-skill');
      assert.equal(flag?.commitHash, 'new2222');
    });

    it('prefers "restore" (in-place prompt fix) over git-revert when both exist for the same skill', async () => {
      await makeFailingSkill('reminders');
      await createTempSkill(dir, 'reminders', 'Broken now.');
      await createTempDraft(dir, 'reminders-fix', 'Fix.', draftMeta({
        target_skill: 'reminders', applied_in_place: true, approved_autonomously: true,
      }));
      await appendAuditRecord({
        ts: new Date().toISOString(), draft: 'reminders-code-fix', source_type: 'failure',
        target_skill: 'reminders', action: 'applied-code-fix', risk_flags: [],
        reason: 'x', commit_hash: 'abc1234',
      });

      const flags = await checkForRollbacks();
      const flag = flags.find((f) => f.skillName === 'reminders');
      assert.equal(flag?.kind, 'restore', 'the in-place prompt-fix restore takes precedence');
    });

    it('never flags self-improver itself for rollback, even with a high failure rate', async () => {
      for (let i = 0; i < 3; i++) {
        await createTempMeta(dir, 'self-improver', makeErrorMeta({ timestamp: new Date(Date.now() - i * 60000).toISOString() }));
      }
      // Even in the hypothetical case where self-improver somehow had a matching draft entry:
      await createTempSkill(dir, 'self-improver', 'Broken now.');
      await createTempDraft(dir, 'self-improver', 'Original.', draftMeta({ approved_autonomously: true }));

      const flags = await checkForRollbacks();
      assert.equal(flags.find((f) => f.skillName === 'self-improver'), undefined,
        'self-improver must never be a rollback target, by explicit exclusion');
    });
  });
});
