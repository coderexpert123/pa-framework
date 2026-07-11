import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, gateAndApprove, rollback, hasPendingDraftForTarget, wasRecentlyChanged, sweepStaleDrafts } from '../src/self-improver.js';
import type { ReportEntry } from '../src/self-improver.js';
import { createTempPaHome, createTempSkill, createTempDraft, cleanup } from './helpers.js';
import { readFile, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
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

  it('lists auto-rejected cmd-target entries in their own section', () => {
    const entries: ReportEntry[] = [
      makeEntry({ name: 'coding-dirs-update-fix', outcome: 'auto-rejected-cmd-target', targetSkill: 'coding-dirs-update', reason: 'coding-dirs-update failed twice.' }),
    ];
    const report = buildReport([], entries);
    assert.match(report, /Auto-rejected.*cmd-based target/);
    assert.match(report, /coding-dirs-update-fix/);
    assert.match(report, /coding-dirs-update/);
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

  it('auto-rejects a fix targeting a cmd-based skill — rejected_auto status, never reaches validateSkillFix', async () => {
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

    let validateSkillFixCalled = false;
    const entries = await gateAndApprove(
      [{ proposal: makeProposal({ name: 'coding-dirs-update-fix', target_skill: 'coding-dirs-update', reason: 'coding-dirs-update failed twice.' }), sourceType: 'failure' }],
      { validateSkillFixFn: async () => { validateSkillFixCalled = true; return true; } }
    );

    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, 'auto-rejected-cmd-target');
    assert.equal(validateSkillFixCalled, false, 'a cmd-based target must be rejected before ever reaching validateSkillFix');

    const meta: DraftMeta = JSON.parse(
      await readFile(join(dir, 'skill-drafts', 'coding-dirs-update-fix', 'draft.meta.json'), 'utf8')
    );
    assert.equal(meta.status, 'rejected_auto');
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
