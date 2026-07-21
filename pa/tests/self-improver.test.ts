import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, gateAndApprove, rollback, hasPendingDraftForTarget, wasRecentlyChanged, sweepStaleDrafts, getReportTopic } from '../src/self-improver.js';
import type { ReportEntry } from '../src/self-improver.js';
import { createTempPaHome, createTempSkill, createTempDraft, createTempSecrets, cleanup } from './helpers.js';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { computeFingerprint } from '../src/drafts.js';
import { appendAuditRecord } from '../src/lib/improvement-audit.js';
import type { DraftMeta, DraftProposal, RunMeta } from '../src/types.js';

async function readAuditRecords(dir: string): Promise<any[]> {
  try {
    const raw = await readFile(join(dir, 'self-improver-audit.jsonl'), 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function createTempRunMeta(dir: string, skillName: string, meta: RunMeta, nonce = 'abc'): Promise<void> {
  const logDir = join(dir, 'logs', skillName);
  await mkdir(logDir, { recursive: true });
  const ts = meta.timestamp.replace(/[:.]/g, '-').slice(0, 19);
  await writeFile(join(logDir, `${ts}-${nonce}.meta`), JSON.stringify(meta, null, 2), 'utf8');
}

function makeEntry(overrides: Partial<ReportEntry> = {}): ReportEntry {
  return {
    name: 'test-entry',
    sourceType: 'failure',
    outcome: 'validation-failed-pending',
    reason: 'This is the stated reason the pattern was proposed.',
    ...overrides,
  };
}

describe('buildReport', () => {
  it('reports nothing-to-report when there are no entries and no rollbacks', () => {
    const report = buildReport([], []);
    assert.match(report, /Nothing to report/);
  });

  it('includes the reason line under every pending (validation-failed) entry — not just a category label', () => {
    const entries: ReportEntry[] = [
      makeEntry({ name: 'daily-mail-brief-fix-3', outcome: 'validation-failed-pending', targetSkill: 'daily-mail-brief', reason: 'daily-mail-brief failed 3 times with a template error.' }),
    ];
    const report = buildReport([], entries);
    assert.match(report, /daily-mail-brief-fix-3/);
    assert.match(report, /proposed fix for `daily-mail-brief`/);
    assert.match(report, /daily-mail-brief failed 3 times with a template error\./);
  });

  it('distinguishes fix-validation-failure from new-skill-validation-failure in the reason label', () => {
    const entries: ReportEntry[] = [
      makeEntry({ name: 'some-fix', outcome: 'validation-failed-pending', targetSkill: 'some-skill' }),
      makeEntry({ name: 'some-new-skill', outcome: 'validation-failed-pending', targetSkill: undefined }),
    ];
    const report = buildReport([], entries);
    assert.match(report, /proposed fix for `some-skill`/);
    assert.match(report, /proposed new skill/);
  });

  it('includes the reason line and risk flags under every autonomously-applied entry', () => {
    const entries: ReportEntry[] = [
      makeEntry({ name: 'explain-agent-status', outcome: 'approved-new-skill', reason: 'User asked this 4 times.' }),
      makeEntry({ name: 'reminders-fix', outcome: 'applied-fix', targetSkill: 'reminders', detail: 'overwrote `reminders`', reason: 'reminders failed twice with a timezone bug.', riskFlags: ['declares-secrets'] }),
    ];
    const report = buildReport([], entries);
    assert.match(report, /explain-agent-status.*— new skill/);
    assert.match(report, /User asked this 4 times\./);
    assert.match(report, /reminders-fix.*— fix to `reminders`.*\[risk: declares-secrets\].*: overwrote `reminders`/);
    assert.match(report, /reminders failed twice with a timezone bug\./);
  });

  it('points to the audit trail file under every applied entry (2026-07-11)', () => {
    const entries: ReportEntry[] = [
      makeEntry({ name: 'reminders-fix', outcome: 'applied-fix', targetSkill: 'reminders', detail: 'overwrote `reminders`' }),
    ];
    const report = buildReport([], entries);
    assert.match(report, /audit: self-improver-audit\.jsonl/);
  });

  it('includes a stale-drafts-reaped count line when staleCount > 0, omits it otherwise (2026-07-11)', () => {
    const withStale = buildReport([], [], 3);
    assert.match(withStale, /Stale drafts reaped \(3\)/);

    const withoutStale = buildReport([], [], 0);
    assert.doesNotMatch(withoutStale, /Stale drafts reaped/);

    const defaultedNoStale = buildReport([], []);
    assert.doesNotMatch(defaultedNoStale, /Stale drafts reaped/);
  });

  it('applied entries with no risk flags show no [risk: ...] suffix', () => {
    const entries: ReportEntry[] = [
      makeEntry({ name: 'clean-fix', outcome: 'applied-fix', targetSkill: 'clean-skill', detail: 'overwrote `clean-skill`', riskFlags: [] }),
    ];
    const report = buildReport([], entries);
    assert.doesNotMatch(report, /\[risk:/);
  });

  it('lists an applied-code-fix entry in the Autonomously applied section, labeled as a code fix (2026-07-11)', () => {
    const entries: ReportEntry[] = [
      makeEntry({ name: 'coding-dirs-update-fix', outcome: 'applied-code-fix', targetSkill: 'coding-dirs-update', detail: 'Applied and pushed (commit abc1234).', reason: 'coding-dirs-update failed twice.' }),
    ];
    const report = buildReport([], entries);
    assert.match(report, /Autonomously applied \(1\)/);
    assert.match(report, /coding-dirs-update-fix.*— code fix to `coding-dirs-update`/);
    assert.match(report, /Applied and pushed \(commit abc1234\)\./);
  });

  it('lists a code-fix-reverted entry in its own section (2026-07-11)', () => {
    const entries: ReportEntry[] = [
      makeEntry({ name: 'coding-dirs-update-fix', outcome: 'code-fix-reverted', targetSkill: 'coding-dirs-update', detail: 'Verification failed: pa test suite failed — reverted.' }),
    ];
    const report = buildReport([], entries);
    assert.match(report, /Code fixes reverted \(1\)/);
    assert.match(report, /coding-dirs-update-fix/);
    assert.match(report, /pa test suite failed/);
  });

  it('lists code-fix-skipped-* entries (any reason suffix) in a shared section (2026-07-11)', () => {
    const entries: ReportEntry[] = [
      makeEntry({ name: 'a-fix', outcome: 'code-fix-skipped-dirty-worktree', targetSkill: 'a', detail: 'Working tree has 2 uncommitted change(s).' }),
      makeEntry({ name: 'b-fix', outcome: 'code-fix-skipped-limit-reached', targetSkill: 'b' }),
    ];
    const report = buildReport([], entries);
    assert.match(report, /Code fixes skipped \(2\)/);
    assert.match(report, /a-fix.*dirty worktree/);
    assert.match(report, /b-fix.*limit reached/);
  });

  it('lists skipped-duplicate-pending and skipped-cooldown entries in a shared skipped section', () => {
    const entries: ReportEntry[] = [
      makeEntry({ name: 'dup-fix', outcome: 'skipped-duplicate-pending', targetSkill: 'some-skill' }),
      makeEntry({ name: 'cooldown-fix', outcome: 'skipped-cooldown', targetSkill: 'other-skill' }),
    ];
    const report = buildReport([], entries);
    assert.match(report, /Skipped \(2\)/);
    assert.match(report, /dup-fix.*duplicate pending draft/);
    assert.match(report, /cooldown-fix.*within the last 3 days/);
  });

  it('lists blocked-protected entries distinctly', () => {
    const entries: ReportEntry[] = [
      makeEntry({ name: 'self-improver-fix', outcome: 'blocked-protected', targetSkill: 'self-improver' }),
    ];
    const report = buildReport([], entries);
    assert.match(report, /Blocked.*protected/);
    assert.match(report, /self-improver-fix/);
  });

  it('includes rollback lines in their own section, separate from proposals', () => {
    const report = buildReport(['- **Restored** `reminders` to its pre-fix version (fix draft: `reminders-fix`) — elevated failure rate since the fix was applied.'], []);
    assert.match(report, /\*Rollbacks \(1\)\*/);
    assert.match(report, /Restored.*reminders/);
  });

  it('counts and analysis-window line always appears, regardless of content', () => {
    const report = buildReport([], [makeEntry()]);
    assert.match(report, /Analyzed the last 14 days\. 1 proposal\(s\) generated\./);
  });
});

describe('gateAndApprove', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  function makeProposal(overrides: Partial<DraftProposal> = {}): DraftProposal {
    return {
      name: 'test-proposal',
      reason: 'test reason',
      source_message_ids: [],
      frontmatter: {},
      prompt: 'Do the thing.',
      ...overrides,
    };
  }

  it('hard-blocks a proposal targeting the protected skill, without computing risk flags or validating', async () => {
    let validateCalled = false;
    const entries = await gateAndApprove(
      [{ proposal: makeProposal({ name: 'self-improver-fix', target_skill: 'self-improver' }), sourceType: 'failure' }],
      { validateSkillFixFn: async () => { validateCalled = true; return true; } }
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, 'blocked-protected');
    assert.equal(entries[0].riskFlags, undefined);
    assert.equal(validateCalled, false, 'a protected-skill proposal must never reach validation');
  });

  it('APPLIES a fix targeting a critical-flagged skill, recording critical-skill as a risk flag (no longer blocks)', async () => {
    await createTempSkill(dir, 'important-skill', '---\ncritical: true\n---\nOriginal prompt.');
    let appliedWith: string[] | undefined;
    const entries = await gateAndApprove(
      [{ proposal: makeProposal({ name: 'important-skill-fix', target_skill: 'important-skill' }), sourceType: 'failure' }],
      {
        validateSkillFixFn: async () => true,
        applyFixFn: async (_p, riskFlags) => { appliedWith = riskFlags; },
      }
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, 'applied-fix');
    assert.deepEqual(entries[0].riskFlags, ['critical-skill']);
    assert.deepEqual(appliedWith, ['critical-skill'], 'applyFixFn must receive the computed risk flags');
  });

  it('APPLIES a fix targeting a secrets-declaring skill, recording declares-secrets as a risk flag (no longer blocks)', async () => {
    await createTempSkill(dir, 'notifier', '---\nsecrets:\n  - TELEGRAM_BOT_TOKEN\n---\nOriginal prompt.');
    const entries = await gateAndApprove(
      [{ proposal: makeProposal({ name: 'notifier-fix', target_skill: 'notifier' }), sourceType: 'failure' }],
      { validateSkillFixFn: async () => true, applyFixFn: async () => {} }
    );
    assert.equal(entries[0].outcome, 'applied-fix');
    assert.deepEqual(entries[0].riskFlags, ['declares-secrets']);
  });

  it('records both risk flags when a target is both critical AND declares secrets', async () => {
    await createTempSkill(dir, 'both-flags', '---\ncritical: true\nsecrets:\n  - TELEGRAM_BOT_TOKEN\n---\nOriginal.');
    const entries = await gateAndApprove(
      [{ proposal: makeProposal({ name: 'both-flags-fix', target_skill: 'both-flags' }), sourceType: 'failure' }],
      { validateSkillFixFn: async () => true, applyFixFn: async () => {} }
    );
    assert.deepEqual(entries[0].riskFlags, ['critical-skill', 'declares-secrets']);
  });

  it('leaves a fix pending (validation-failed-pending) when validation fails, without applying', async () => {
    await createTempSkill(dir, 'plain-skill', 'Original prompt.');
    let applyCalled = false;
    const entries = await gateAndApprove(
      [{ proposal: makeProposal({ name: 'plain-skill-fix', target_skill: 'plain-skill' }), sourceType: 'failure' }],
      { validateSkillFixFn: async () => false, applyFixFn: async () => { applyCalled = true; } }
    );
    assert.equal(entries[0].outcome, 'validation-failed-pending');
    assert.equal(applyCalled, false);
  });

  it('approves a validated new-skill proposal (no target_skill) with risk flags recorded', async () => {
    let approvedWith: any;
    const entries = await gateAndApprove(
      [{ proposal: makeProposal({ name: 'brand-new-skill', target_skill: undefined }), sourceType: 'conversation' }],
      {
        validateNewSkillFn: async () => true,
        approveDraftFn: async (_name, extra) => { approvedWith = extra; },
      }
    );
    assert.equal(entries[0].outcome, 'approved-new-skill');
    assert.deepEqual(entries[0].riskFlags, []);
    assert.equal(approvedWith?.approved_autonomously, true);
    assert.deepEqual(approvedWith?.risk_flags, []);
  });

  describe('cmd-based target routing (2026-07-11 code-fix capability)', () => {
    async function seedCmdTargetDraft(): Promise<void> {
      await createTempSkill(dir, 'coding-dirs-update', '---\ncmd: "python update_coding_dirs.py"\n---\nUpdates the pinned directory list.');
      await createTempDraft(dir, 'coding-dirs-update-fix', 'New prompt (inert for a cmd-based skill).', {
        proposed_at: new Date().toISOString(),
        reason: 'coding-dirs-update failed twice.',
        source_turns: [],
        status: 'pending',
        fingerprint: computeFingerprint('coding-dirs-update-fix', 'New prompt.'),
        source_type: 'failure',
        target_skill: 'coding-dirs-update',
      });
    }

    it('routes a fix targeting a cmd-based skill to attemptCodeFix instead of auto-rejecting — never reaches validateSkillFix', async () => {
      await seedCmdTargetDraft();

      let validateSkillFixCalled = false;
      let codeFixArgs: any;
      const entries = await gateAndApprove(
        [{ proposal: makeProposal({ name: 'coding-dirs-update-fix', target_skill: 'coding-dirs-update', reason: 'coding-dirs-update failed twice.' }), sourceType: 'failure' }],
        {
          validateSkillFixFn: async () => { validateSkillFixCalled = true; return true; },
          attemptCodeFixFn: async (proposal, evidence) => { codeFixArgs = { proposal, evidence }; return { outcome: 'applied-code-fix', reason: 'Applied and pushed (commit abc1234).', commitHash: 'abc1234', filesChanged: ['projects/coding-dirs-updater/update_coding_dirs.py'] }; },
        }
      );

      assert.equal(entries.length, 1);
      assert.equal(entries[0].outcome, 'applied-code-fix');
      assert.equal(entries[0].detail, 'Applied and pushed (commit abc1234).');
      assert.equal(validateSkillFixCalled, false, 'a cmd-based target must route to code-fixing before ever reaching validateSkillFix');
      assert.equal(codeFixArgs.proposal.name, 'coding-dirs-update-fix');

      const meta: DraftMeta = JSON.parse(
        await readFile(join(dir, 'skill-drafts', 'coding-dirs-update-fix', 'draft.meta.json'), 'utf8')
      );
      assert.equal(meta.status, 'rejected_auto', 'the prompt-fix draft itself is never deployed — code-fixer commits directly to the project');
    });

    it('passes readRecentFailures results filtered to the target skill as evidence', async () => {
      await seedCmdTargetDraft();

      let receivedEvidence: any[] = [];
      await gateAndApprove(
        [{ proposal: makeProposal({ name: 'coding-dirs-update-fix', target_skill: 'coding-dirs-update' }), sourceType: 'failure' }],
        {
          readRecentFailuresFn: async () => [
            { skillName: 'coding-dirs-update', error: 'boom A', timestamp: new Date().toISOString(), duration: 1000, worker: 'gemini' },
            { skillName: 'unrelated-skill', error: 'boom B', timestamp: new Date().toISOString(), duration: 1000, worker: 'gemini' },
          ],
          attemptCodeFixFn: async (_proposal, evidence) => { receivedEvidence = evidence; return { outcome: 'code-fix-skipped-worker-failed', reason: 'x' }; },
        }
      );

      assert.equal(receivedEvidence.length, 1);
      assert.equal(receivedEvidence[0].error, 'boom A');
    });

    it('enforces one code-fix attempt per gateAndApprove call (F5) — a second cmd-target proposal is skipped without calling attemptCodeFix again', async () => {
      await seedCmdTargetDraft();
      await createTempSkill(dir, 'other-cmd-skill', '---\ncmd: "python other.py"\n---\nOther.');
      await createTempDraft(dir, 'other-cmd-skill-fix', 'New prompt.', {
        proposed_at: new Date().toISOString(), reason: 'other-cmd-skill failed twice.', source_turns: [],
        status: 'pending', fingerprint: computeFingerprint('other-cmd-skill-fix', 'New prompt.'),
        source_type: 'failure', target_skill: 'other-cmd-skill',
      });

      let callCount = 0;
      const entries = await gateAndApprove(
        [
          { proposal: makeProposal({ name: 'coding-dirs-update-fix', target_skill: 'coding-dirs-update' }), sourceType: 'failure' },
          { proposal: makeProposal({ name: 'other-cmd-skill-fix', target_skill: 'other-cmd-skill' }), sourceType: 'failure' },
        ],
        { attemptCodeFixFn: async () => { callCount++; return { outcome: 'code-fix-reverted', reason: 'reverted' }; } }
      );

      assert.equal(callCount, 1, 'attemptCodeFix must be called at most once per nightly run');
      assert.equal(entries[0].outcome, 'code-fix-reverted');
      assert.equal(entries[1].outcome, 'code-fix-skipped-limit-reached');
    });
  });

  describe('audit trail (2026-07-11) — every terminal decision appends a record', () => {
    it('appends an applied-fix record with the diff, backup_path, and baseline populated', async () => {
      await createTempSkill(dir, 'baseline-skill', 'Old prompt.');
      await createTempRunMeta(dir, 'baseline-skill', {
        worker: 'gemini', status: 'error', exitCode: 1, duration: 1000, timestamp: new Date().toISOString(), error: 'boom',
      });

      const entries = await gateAndApprove(
        [{ proposal: makeProposal({ name: 'baseline-skill-fix', target_skill: 'baseline-skill', prompt: 'New prompt.', reason: 'It kept failing.' }), sourceType: 'failure' }],
        { validateSkillFixFn: async () => true, applyFixFn: async () => {} }
      );
      assert.equal(entries[0].outcome, 'applied-fix');

      const records = await readAuditRecords(dir);
      assert.equal(records.length, 1);
      const r = records[0];
      assert.equal(r.draft, 'baseline-skill-fix');
      assert.equal(r.action, 'applied-fix');
      assert.equal(r.target_skill, 'baseline-skill');
      assert.equal(r.reason, 'It kept failing.');
      assert.match(r.diff, /- Old prompt\./);
      assert.match(r.diff, /\+ New prompt\./);
      assert.match(r.backup_path, /baseline-skill-fix/);
      assert.deepEqual(r.baseline, { window_days: 14, runs: 1, successes: 0, failures: 1 });
    });

    it('appends an approved-new-skill record with the full new prompt as the diff', async () => {
      const entries = await gateAndApprove(
        [{ proposal: makeProposal({ name: 'brand-new', target_skill: undefined, prompt: 'The full new skill prompt.' }), sourceType: 'conversation' }],
        { validateNewSkillFn: async () => true, approveDraftFn: async () => {} }
      );
      assert.equal(entries[0].outcome, 'approved-new-skill');

      const records = await readAuditRecords(dir);
      assert.equal(records.length, 1);
      assert.equal(records[0].action, 'approved-new-skill');
      assert.equal(records[0].target_skill, undefined);
      assert.match(records[0].diff, /The full new skill prompt\./);
    });

    it('appends a validation-failed record (not validation-failed-pending — that\'s the report vocabulary, not the audit action)', async () => {
      await createTempSkill(dir, 'still-broken', 'Old.');
      await gateAndApprove(
        [{ proposal: makeProposal({ name: 'still-broken-fix', target_skill: 'still-broken' }), sourceType: 'failure' }],
        { validateSkillFixFn: async () => false }
      );

      const records = await readAuditRecords(dir);
      assert.equal(records[0].action, 'validation-failed');
    });

    it('appends a rejected_auto record for a cmd-target auto-reject', async () => {
      await createTempSkill(dir, 'cmd-skill', '---\ncmd: "python x.py"\n---\nDoc.');
      await createTempDraft(dir, 'cmd-skill-fix', 'New prompt (inert).', {
        proposed_at: new Date().toISOString(),
        reason: 'test',
        source_turns: [],
        status: 'pending',
        fingerprint: computeFingerprint('cmd-skill-fix', 'New prompt.'),
        source_type: 'failure',
        target_skill: 'cmd-skill',
      });
      await gateAndApprove(
        [{ proposal: makeProposal({ name: 'cmd-skill-fix', target_skill: 'cmd-skill' }), sourceType: 'failure' }]
      );

      const records = await readAuditRecords(dir);
      assert.equal(records[0].action, 'rejected_auto');
      assert.equal(records[0].target_skill, 'cmd-skill');
    });

    it('does NOT append a record for a blocked-protected proposal (outside the audit action vocabulary)', async () => {
      await gateAndApprove(
        [{ proposal: makeProposal({ name: 'self-improver-fix', target_skill: 'self-improver' }), sourceType: 'failure' }]
      );
      const records = await readAuditRecords(dir);
      assert.equal(records.length, 0);
    });

    it('records risk flags on the audit entry too, not just the ReportEntry', async () => {
      await createTempSkill(dir, 'risky-skill', '---\ncritical: true\n---\nOld.');
      await gateAndApprove(
        [{ proposal: makeProposal({ name: 'risky-skill-fix', target_skill: 'risky-skill' }), sourceType: 'failure' }],
        { validateSkillFixFn: async () => true, applyFixFn: async () => {} }
      );
      const records = await readAuditRecords(dir);
      assert.deepEqual(records[0].risk_flags, ['critical-skill']);
    });
  });
});

describe('rollback', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it('appends a rolled-back audit record when restoring an in-place fix', async () => {
    // 3 errors, 1 success within the last 24h -> 75% failure rate, over the 50% threshold
    for (let i = 0; i < 3; i++) {
      await createTempRunMeta(dir, 'reminders', {
        worker: 'gemini', status: 'error', exitCode: 1, duration: 1000,
        timestamp: new Date(Date.now() - i * 60000).toISOString(), error: 'boom',
      }, `err${i}`);
    }
    await createTempRunMeta(dir, 'reminders', {
      worker: 'gemini', status: 'success', exitCode: 0, duration: 1000, timestamp: new Date().toISOString(),
    }, 'ok');

    await createTempSkill(dir, 'reminders', 'Broken fixed version.');
    await createTempDraft(dir, 'reminders-fix', 'Broken fixed version.', {
      proposed_at: new Date().toISOString(),
      reason: 'reminders kept failing.',
      source_turns: [],
      status: 'approved',
      fingerprint: computeFingerprint('reminders-fix', 'x'),
      source_type: 'failure',
      target_skill: 'reminders',
      approved_autonomously: true,
      applied_in_place: true,
      reviewed_at: new Date().toISOString(),
      risk_flags: ['declares-secrets'],
    });
    // applyFix's own backup file — rollback() copies this back over the target
    await import('fs/promises').then(({ mkdir: mk, copyFile }) =>
      copyFile(join(dir, 'skills', 'reminders', 'skill.md'), join(dir, 'skill-drafts', 'reminders-fix', 'target-backup.skill.md'))
    );

    const lines = await rollback();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Restored.*reminders/);

    const records = await readAuditRecords(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, 'rolled-back');
    assert.equal(records[0].draft, 'reminders-fix');
    assert.equal(records[0].target_skill, 'reminders');
    assert.deepEqual(records[0].risk_flags, ['declares-secrets']);
    assert.equal(records[0].baseline.runs, 4);
  });

  it('returns an empty array and writes no audit records when nothing needs rolling back', async () => {
    const lines = await rollback();
    assert.deepEqual(lines, []);
    const records = await readAuditRecords(dir);
    assert.equal(records.length, 0);
  });
});

describe('hasPendingDraftForTarget (thrash control — 2026-07-11)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  function pendingMeta(overrides: Partial<DraftMeta> = {}): DraftMeta {
    return {
      proposed_at: new Date().toISOString(),
      reason: 'test',
      source_turns: [],
      status: 'pending',
      fingerprint: computeFingerprint('x', 'x'),
      source_type: 'failure',
      ...overrides,
    };
  }

  it('is true when a pending draft already targets the same skill', async () => {
    await createTempDraft(dir, 'reminders-fix', 'Prompt.', pendingMeta({ target_skill: 'reminders' }));
    assert.equal(await hasPendingDraftForTarget('reminders'), true);
  });

  it('is false when the only draft targeting that skill is already approved/rejected (not pending)', async () => {
    await createTempDraft(dir, 'reminders-fix', 'Prompt.', pendingMeta({ target_skill: 'reminders', status: 'approved' }));
    assert.equal(await hasPendingDraftForTarget('reminders'), false);
  });

  it('is false when no draft targets that skill at all', async () => {
    assert.equal(await hasPendingDraftForTarget('never-touched'), false);
  });
});

describe('wasRecentlyChanged (thrash control — 2026-07-11)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it('is true when an applied-fix audit record for the target exists within the cooldown window', async () => {
    await appendAuditRecord({
      ts: new Date().toISOString(), draft: 'reminders-fix', source_type: 'failure',
      target_skill: 'reminders', action: 'applied-fix', risk_flags: [], reason: 'r',
    });
    assert.equal(await wasRecentlyChanged('reminders', 3), true);
  });

  it('is false when the applied-fix record is older than the cooldown window', async () => {
    const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    await appendAuditRecord({
      ts: old, draft: 'reminders-fix', source_type: 'failure',
      target_skill: 'reminders', action: 'applied-fix', risk_flags: [], reason: 'r',
    });
    assert.equal(await wasRecentlyChanged('reminders', 3), false);
  });

  it('is false for a target with no recorded applied-fix at all', async () => {
    assert.equal(await wasRecentlyChanged('untouched-skill', 3), false);
  });

  it('ignores records for other target skills', async () => {
    await appendAuditRecord({
      ts: new Date().toISOString(), draft: 'other-fix', source_type: 'failure',
      target_skill: 'other-skill', action: 'applied-fix', risk_flags: [], reason: 'r',
    });
    assert.equal(await wasRecentlyChanged('reminders', 3), false);
  });

  it('ignores non-applied-fix actions (e.g. rejected_auto) for the same target', async () => {
    await appendAuditRecord({
      ts: new Date().toISOString(), draft: 'reminders-fix', source_type: 'failure',
      target_skill: 'reminders', action: 'rejected_auto', risk_flags: [], reason: 'r',
    });
    assert.equal(await wasRecentlyChanged('reminders', 3), false);
  });
});

describe('sweepStaleDrafts (thrash control — 2026-07-11)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  function pendingMeta(overrides: Partial<DraftMeta> = {}): DraftMeta {
    return {
      proposed_at: new Date().toISOString(),
      reason: 'test reason',
      source_turns: [],
      status: 'pending',
      fingerprint: computeFingerprint('x', 'x'),
      source_type: 'failure',
      ...overrides,
    };
  }

  it('marks a pending draft older than the threshold rejected_stale and appends an audit record', async () => {
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await createTempDraft(dir, 'stale-fix', 'Prompt.', pendingMeta({ proposed_at: old, target_skill: 'stale-skill', risk_flags: ['declares-secrets'] }));

    const count = await sweepStaleDrafts(14);
    assert.equal(count, 1);

    const meta: DraftMeta = JSON.parse(await readFile(join(dir, 'skill-drafts', 'stale-fix', 'draft.meta.json'), 'utf8'));
    assert.equal(meta.status, 'rejected_stale');

    const records = await readAuditRecords(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, 'rejected_stale');
    assert.equal(records[0].draft, 'stale-fix');
    assert.equal(records[0].target_skill, 'stale-skill');
    assert.deepEqual(records[0].risk_flags, ['declares-secrets']);
  });

  it('leaves a pending draft younger than the threshold untouched', async () => {
    await createTempDraft(dir, 'fresh-fix', 'Prompt.', pendingMeta({ proposed_at: new Date().toISOString() }));

    const count = await sweepStaleDrafts(14);
    assert.equal(count, 0);

    const meta: DraftMeta = JSON.parse(await readFile(join(dir, 'skill-drafts', 'fresh-fix', 'draft.meta.json'), 'utf8'));
    assert.equal(meta.status, 'pending');
  });

  it('never touches an already-approved or already-rejected draft, even if old', async () => {
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await createTempDraft(dir, 'old-approved', 'Prompt.', pendingMeta({ proposed_at: old, status: 'approved' }));

    const count = await sweepStaleDrafts(14);
    assert.equal(count, 0);
  });

  it('returns 0 and writes nothing when there are no pending drafts', async () => {
    assert.equal(await sweepStaleDrafts(14), 0);
    const records = await readAuditRecords(dir);
    assert.equal(records.length, 0);
  });
});

describe('rollback: git-revert kind (2026-07-11 code-fix capability)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  function gitRevertFlag() {
    return {
      kind: 'git-revert' as const,
      skillName: 'coding-dirs-update',
      draftName: 'coding-dirs-update-fix',
      commitHash: 'abc1234',
    };
  }

  async function seedDraft(): Promise<void> {
    await createTempDraft(dir, 'coding-dirs-update-fix', 'Trigger record.', {
      proposed_at: new Date().toISOString(),
      reason: 'coding-dirs-update failing.',
      source_turns: [],
      status: 'rejected_auto',
      fingerprint: computeFingerprint('coding-dirs-update-fix', 'x'),
      source_type: 'failure',
      target_skill: 'coding-dirs-update',
    });
  }

  it('executes git revert + push, audits rolled-back with both hashes, marks the draft', async () => {
    await seedDraft();
    const cmds: string[] = [];
    const lines = await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => {
        cmds.push(cmd);
        return { stdout: cmd.includes('rev-parse') ? 'def5678\n' : '', stderr: '' };
      },
    });

    // `-n` (staged, not committed) since 2026-07-21 so the pa/data/profile* churn can be
    // dropped from the revert before it becomes a commit — see gitRevertPreservingChurn.
    assert.ok(cmds.some((c) => c.includes('git revert -n abc1234')), `expected a git revert, got: ${cmds.join(' | ')}`);
    assert.ok(cmds.some((c) => c.includes('commit --no-edit')), 'expected the staged revert to be committed');
    // Nothing was dirty here, so nothing should have been stashed.
    assert.equal(cmds.some((c) => c.startsWith('git stash push')), false);
    assert.ok(cmds.some((c) => c.includes('git push')), 'expected the revert to be pushed (offsite recoverability)');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Reverted/);
    assert.match(lines[0], /abc1234/);

    const records = await readAuditRecords(dir);
    const rec = records.find((r) => r.action === 'rolled-back');
    assert.ok(rec, 'expected a rolled-back audit record');
    assert.equal(rec.commit_hash, 'abc1234');
    assert.equal(rec.revert_commit_hash, 'def5678');

    const meta: DraftMeta = JSON.parse(
      await readFile(join(dir, 'skill-drafts', 'coding-dirs-update-fix', 'draft.meta.json'), 'utf8')
    );
    assert.equal(meta.status, 'rejected_post_rollback');
  });

  it('reports and audits rollback-failed when the git revert command fails (e.g. conflict)', async () => {
    await seedDraft();
    const lines = await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => {
        if (cmd.includes('git revert')) throw new Error('could not revert: merge conflict in update_coding_dirs.py');
        return { stdout: '', stderr: '' };
      },
    });

    assert.equal(lines.length, 1);
    assert.match(lines[0], /Rollback FAILED/);
    assert.match(lines[0], /merge conflict/);

    const records = await readAuditRecords(dir);
    const rec = records.find((r) => r.action === 'rollback-failed');
    assert.ok(rec, 'expected a rollback-failed audit record');
    assert.equal(rec.commit_hash, 'abc1234');
  });

  it('flags bot-restart necessity in the report line when the reverted fix touched bot code', async () => {
    await seedDraft();
    // The audit record for the original fix carries files_changed — rollback reads it to
    // decide whether to warn (no git calls needed).
    await appendAuditRecord({
      ts: new Date().toISOString(), draft: 'coding-dirs-update-fix', source_type: 'failure',
      target_skill: 'coding-dirs-update', action: 'applied-code-fix', risk_flags: [],
      reason: 'x', commit_hash: 'abc1234',
      files_changed: ['projects/telegram-bot/src/logic.ts'],
    });
    const lines = await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => ({ stdout: cmd.includes('rev-parse') ? 'def5678\n' : '', stderr: '' }),
    });

    assert.match(lines[0], /bot restart|rebuild/i);
  });

  it('refuses to revert (and audits rollback-failed) when the tree carries human WIP', async () => {
    // Precondition mirroring code-fixer's F4 — an autonomous `git revert` must never be
    // mixed with, or run destructive cleanup over, a human's uncommitted work. Churn in
    // pa/data/profile* alone does NOT count as WIP (that's the whole point of the carve-out).
    await seedDraft();
    const cmds: string[] = [];
    const lines = await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => {
        cmds.push(cmd);
        if (cmd === 'git status --porcelain') {
          return { stdout: ' M pa/src/workers.ts\n M pa/data/profile.json\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    });

    assert.match(lines[0], /Rollback FAILED/);
    assert.match(lines[0], /pa\/src\/workers\.ts/);
    assert.equal(cmds.some((c) => c.startsWith('git revert')), false);
    assert.equal(cmds.some((c) => c.startsWith('git reset --hard')), false);

    const rec = (await readAuditRecords(dir)).find((r) => r.action === 'rollback-failed');
    assert.ok(rec, 'expected a rollback-failed audit record');
    assert.equal(rec.commit_hash, 'abc1234');
  });
});

// ---------------------------------------------------------------------------
// Real-git-repo fixture: the 2026-07-21 un-revertable-fix-commit fix, end to end.
// A bare `git revert` aborted on "Your local changes to the following files would be
// overwritten by merge: pa/data/profile.json" every night the learn_agent/oracle churn was
// present — ~/.pa/self-improver-audit.jsonl recorded 'rollback-failed' for commit 7b82c88 on
// both 2026-07-13 and 2026-07-16, and 7b82c88 stayed an ancestor of HEAD. Faked exec can't
// prove the git semantics here, so this one drives real git in a throwaway repo.
// ---------------------------------------------------------------------------
describe('rollback: git-revert survives (and preserves) nightly pa/data/profile churn', () => {
  let paHome: string;
  let repo: string;
  const runShell = promisify(execCb);
  const CHURN = '{"v":3,"learned":"today"}\n';
  let badFix: string;

  const git = async (cmd: string): Promise<{ stdout: string; stderr: string }> => {
    const { stdout, stderr } = await runShell(cmd, { cwd: repo });
    return { stdout: String(stdout), stderr: String(stderr) };
  };

  beforeEach(async () => {
    paHome = await createTempPaHome();
    repo = await mkdtemp(join(tmpdir(), 'pa-revert-repo-'));

    await git('git init -q');
    await git('git config user.email pa-test@example.com');
    await git('git config user.name "pa test"');
    await git('git config commit.gpgsign false');
    await git('git config core.autocrlf false'); // byte-for-byte assertions below

    await mkdir(join(repo, 'pa', 'data'), { recursive: true });
    await mkdir(join(repo, 'projects', 'x'), { recursive: true });
    await writeFile(join(repo, 'pa', 'data', 'profile.json'), '{"v":1}\n', 'utf8');
    await writeFile(join(repo, 'projects', 'x', 'script.py'), 'original\n', 'utf8');
    await git('git add -A');
    await git('git commit -q -m base');

    // A legacy-shaped autonomous fix commit: code change PLUS the profile churn baked in —
    // exactly what made 7b82c88 un-revertable. The revert path must cope with it.
    await writeFile(join(repo, 'projects', 'x', 'script.py'), 'fixed\n', 'utf8');
    await writeFile(join(repo, 'pa', 'data', 'profile.json'), '{"v":2}\n', 'utf8');
    await git('git add -A');
    await git('git commit -q -m "autonomous-code-fix: x-fix"');
    badFix = (await git('git rev-parse HEAD')).stdout.trim();

    // Tonight's learn_agent/oracle write — uncommitted, and irreplaceable.
    await writeFile(join(repo, 'pa', 'data', 'profile.json'), CHURN, 'utf8');
  });

  afterEach(async () => {
    await cleanup(paHome);
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  async function runRollback(): Promise<string[]> {
    return rollback({
      checkForRollbacksFn: async () => [
        { kind: 'git-revert' as const, skillName: 'x', draftName: 'x-fix', commitHash: badFix },
      ],
      execFn: async (cmd: string) => {
        if (cmd.startsWith('git push')) return { stdout: '', stderr: '' }; // no remote in the fixture
        return git(cmd);
      },
    });
  }

  it('reverts the fix even though pa/data/profile.json is dirty', async () => {
    const lines = await runRollback();

    assert.equal(lines.length, 1);
    assert.match(lines[0], /Reverted/, `expected a successful revert, got: ${lines[0]}`);
    assert.equal(await readFile(join(repo, 'projects', 'x', 'script.py'), 'utf8'), 'original\n');

    const records = await readAuditRecords(paHome);
    assert.equal(records.some((r) => r.action === 'rollback-failed'), false);
    const rec = records.find((r) => r.action === 'rolled-back');
    assert.ok(rec, 'expected a rolled-back audit record');
    assert.equal(rec.commit_hash, badFix);
    assert.equal(rec.revert_commit_hash, (await git('git rev-parse HEAD')).stdout.trim());
  });

  it('leaves the uncommitted profile data byte-for-byte intact, with nothing stranded in the stash', async () => {
    await runRollback();

    assert.equal(await readFile(join(repo, 'pa', 'data', 'profile.json'), 'utf8'), CHURN);
    assert.equal((await git('git stash list')).stdout.trim(), '');
  });

  it('produces a revert commit that touches only code — never pa/data/profile*', async () => {
    await runRollback();

    const { stdout: names } = await git('git show --name-only --format= HEAD');
    assert.match(names, /projects\/x\/script\.py/);
    assert.doesNotMatch(names, /pa\/data\/profile/, 'a revert commit carrying the churn would itself be un-revertable');
  });
});

// The nightly report's own routing. self-improver runs as a `cmd:` skill with no
// `secrets:` frontmatter, so its process gets NONE of ~/.pa/secrets.env in the
// environment — and PA_SELF_IMPROVER_THREAD_ID lives only there. The env-only
// read resolved thread 0 and the report landed in pa-alerts.
describe('getReportTopic (report routing)', () => {
  const KEYS = [
    'PA_SELF_IMPROVER_CHAT_ID',
    'PA_SELF_IMPROVER_THREAD_ID',
    'PA_ALERTS_CHAT_ID',
    'PA_ALERTS_THREAD_ID',
    'TELEGRAM_CHAT_ID',
  ];
  let dir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    dir = await createTempPaHome();
    savedEnv = {};
    for (const key of KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
    await cleanup(dir);
  });

  it('resolves the report thread from secrets.env when process.env has nothing', async () => {
    await createTempSecrets(dir, 'PA_ALERTS_CHAT_ID=-100777\nPA_ALERTS_THREAD_ID=42\nPA_SELF_IMPROVER_THREAD_ID=1234\n');

    assert.deepEqual(await getReportTopic(), { chat_id: '-100777', thread_id: 1234 });
  });

  it('lets process.env win over the secrets record', async () => {
    await createTempSecrets(dir, 'PA_ALERTS_CHAT_ID=-100777\nPA_SELF_IMPROVER_THREAD_ID=1234\n');
    process.env.PA_SELF_IMPROVER_THREAD_ID = '77';

    assert.equal((await getReportTopic()).thread_id, 77);
  });

  it('falls back to the pa-alerts topic only when no self-improver key is set anywhere', async () => {
    await createTempSecrets(dir, 'PA_ALERTS_CHAT_ID=-100777\nPA_ALERTS_THREAD_ID=42\n');

    assert.deepEqual(await getReportTopic(), { chat_id: '-100777', thread_id: 42 });
  });

  it('honors a dedicated self-improver chat id when one is configured', async () => {
    await createTempSecrets(dir, 'PA_ALERTS_CHAT_ID=-100777\nPA_SELF_IMPROVER_CHAT_ID=-100222\nPA_SELF_IMPROVER_THREAD_ID=1234\n');

    assert.deepEqual(await getReportTopic(), { chat_id: '-100222', thread_id: 1234 });
  });
});
