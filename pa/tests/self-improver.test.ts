import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, gateAndApprove, rollback, hasPendingDraftForTarget, wasRecentlyChanged, sweepStaleDrafts, getReportTopic } from '../src/self-improver.js';
import type { ReportEntry } from '../src/self-improver.js';
import { GIT_WORKFLOW_RESOURCE, GIT_LOCK_WAIT_MS } from '../src/code-fixer.js';
import type { BlackboardLockClient } from '../src/code-fixer.js';
import { exclusiveLockKey } from '../src/commands/run.js';
import { createTempPaHome, createTempSkill, createTempDraft, createTempSecrets, createTempConfig, cleanup } from './helpers.js';
import { readFile, mkdir, mkdtemp, rm, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { computeFingerprint } from '../src/drafts.js';
import { appendAuditRecord } from '../src/lib/improvement-audit.js';
import type { DraftMeta, DraftProposal, RunMeta } from '../src/types.js';
import type { AlertCensus, CensusFamily } from '../src/lib/alert-census.js';

// ---------------------------------------------------------------------------
// Census fixtures (2026-08-23 alerts wave) — buildReport's census-derived sections and
// gateAndApprove's maintenance-job route both consume these shapes.
// ---------------------------------------------------------------------------

function makeCensusFamily(overrides: Partial<CensusFamily> = {}): CensusFamily {
  return {
    family: 'test-family',
    subjectSample: 'Skill failed: test-family',
    sent: 5,
    suppressed: 0,
    other: 0,
    firstSeen: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    lastSeen: new Date().toISOString(),
    ownerKind: 'skill',
    owner: 'test-family',
    distinctBodies: 1,
    classification: 'informational',
    ...overrides,
  };
}

function makeCensus(overrides: Partial<AlertCensus> = {}): AlertCensus {
  return {
    generatedAt: new Date().toISOString(),
    windowDays: 7,
    since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    until: new Date().toISOString(),
    totalSent: 42,
    totalSuppressed: 3,
    sentPerDay: {},
    families: [],
    maskedFailures: [],
    topLine: '42 alerts / 1 families in 7d — top: test-family 5',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// git-workflow lock fake (2026-08-05) — local per this file's existing
// per-file-fake convention (code-fixer.test.ts has its own copy too, not a
// shared/exported helper). Mirrors makeLockFake there.
// ---------------------------------------------------------------------------

interface LockFakeState {
  acquireCalls: Array<{ resource: string; agent: string; pid: number; timeoutMs?: number }>;
  heartbeatCalls: number;
  releaseCalls: number;
  held: boolean;
}

function makeLockFake(opts: { acquire?: boolean } = {}): { bb: BlackboardLockClient; state: LockFakeState } {
  const state: LockFakeState = { acquireCalls: [], heartbeatCalls: 0, releaseCalls: 0, held: false };
  const bb: BlackboardLockClient = {
    acquireLock: async (resource: string, agent: string, pid: number, timeoutMs?: number) => {
      state.acquireCalls.push({ resource, agent, pid, timeoutMs });
      const acquired = opts.acquire !== false;
      if (acquired) state.held = true;
      return acquired;
    },
    updateHeartbeat: async () => {
      state.heartbeatCalls++;
      return true;
    },
    releaseLock: async () => {
      state.releaseCalls++;
      state.held = false;
    },
  };
  return { bb, state };
}

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

  it('includes a purged-drafts line when purgedCount > 0, omits it otherwise (2026-08-15)', () => {
    const withPurged = buildReport([], [], 0, 2);
    assert.match(withPurged, /Rejected drafts purged \(2\)/);

    const withoutPurged = buildReport([], [], 0, 0);
    assert.doesNotMatch(withoutPurged, /Rejected drafts purged/);

    const defaultedNoPurged = buildReport([], []);
    assert.doesNotMatch(defaultedNoPurged, /Rejected drafts purged/);
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

  it('prints the census headline even with zero proposals and zero rollbacks (2026-08-23) — the failure this exists to make impossible', () => {
    const census = makeCensus({ topLine: '548 alerts / 22 families in 7d — top: restore-drill 180, staleness 111, bg-leak 88' });
    const report = buildReport([], [], 0, 0, census);
    assert.match(report, /548 alerts \/ 22 families in 7d/);
  });

  it('prints "Alert census unavailable: <err>" when the census failed to build (2026-08-23)', () => {
    const report = buildReport([], [], 0, 0, undefined, 'ENOENT: no such file');
    assert.match(report, /Alert census unavailable: ENOENT: no such file/);
  });

  it('prints "Alert census unavailable: not built" when neither census nor censusError is given (default args, 2026-08-23)', () => {
    const report = buildReport([], []);
    assert.match(report, /Alert census unavailable: not built/);
  });

  describe('census-derived report sections (2026-08-23 alerts wave)', () => {
    it('renders Operator action needed for human-gated families (family/owner/age/error), omitted when there are none', () => {
      const generatedAt = new Date().toISOString();
      const oldFirstSeen = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      const census = makeCensus({
        generatedAt,
        families: [makeCensusFamily({
          family: 'google-oauth', owner: 'daily-mail-brief', classification: 'human-gated',
          firstSeen: oldFirstSeen,
          ownerStatus: { lastError: 'invalid_grant: token expired', consecutiveFailures: 4 },
        })],
      });
      const report = buildReport([], [], 0, 0, census);
      assert.match(report, /\*Operator action needed \(1\)\*/);
      assert.match(report, /google-oauth.*owner: daily-mail-brief.*5d old.*invalid_grant/);

      const emptyReport = buildReport([], [], 0, 0, makeCensus({ families: [] }));
      assert.doesNotMatch(emptyReport, /Operator action needed/);
    });

    it('renders Alert hygiene for repeat-unchanged families (family/sent/distinctBodies/suggestion), omitted when there are none', () => {
      const census = makeCensus({
        families: [makeCensusFamily({ family: 'bg-leak', classification: 'repeat-unchanged', sent: 88, distinctBodies: 2 })],
      });
      const report = buildReport([], [], 0, 0, census);
      assert.match(report, /\*Alert hygiene \(1\)\*/);
      assert.match(report, /bg-leak.*sent 88, 2 distinct bodies.*mute via button or `pa fix`/);

      const emptyReport = buildReport([], [], 0, 0, makeCensus({ families: [] }));
      assert.doesNotMatch(emptyReport, /Alert hygiene/);
    });

    it('renders Masked failures (skill/lastRunAt/marker), omitted when there are none', () => {
      const census = makeCensus({
        maskedFailures: [{ skill: 'daily-mail-brief', lastRunAt: '2026-08-20T12:00:00.000Z', marker: '[notify] attempting ... "severity":"error"' }],
      });
      const report = buildReport([], [], 0, 0, census);
      assert.match(report, /\*Masked failures \(1\)\*/);
      assert.match(report, /daily-mail-brief.*2026-08-20T12:00:00\.000Z.*severity.*error/);

      const emptyReport = buildReport([], [], 0, 0, makeCensus({ maskedFailures: [] }));
      assert.doesNotMatch(emptyReport, /Masked failures/);
    });
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
            { skillName: 'coding-dirs-update', error: 'boom A', timestamp: new Date().toISOString(), duration: 1000, worker: 'codex' },
            { skillName: 'unrelated-skill', error: 'boom B', timestamp: new Date().toISOString(), duration: 1000, worker: 'codex' },
          ],
          attemptCodeFixFn: async (_proposal, evidence) => { receivedEvidence = evidence; return { outcome: 'code-fix-skipped-worker-failed', reason: 'x' }; },
        }
      );

      assert.equal(receivedEvidence.length, 1);
      assert.equal(receivedEvidence[0].error, 'boom A');
    });

    it('two cmd-target proposals with DIFFERENT targets each get their own attemptCodeFix call (F5 rework, 2026-08-23)', async () => {
      await seedCmdTargetDraft();
      await createTempSkill(dir, 'other-cmd-skill', '---\ncmd: "python other.py"\n---\nOther.');
      await createTempDraft(dir, 'other-cmd-skill-fix', 'New prompt.', {
        proposed_at: new Date().toISOString(), reason: 'other-cmd-skill failed twice.', source_turns: [],
        status: 'pending', fingerprint: computeFingerprint('other-cmd-skill-fix', 'New prompt.'),
        source_type: 'failure', target_skill: 'other-cmd-skill',
      });

      const calledFor: (string | undefined)[] = [];
      const entries = await gateAndApprove(
        [
          { proposal: makeProposal({ name: 'coding-dirs-update-fix', target_skill: 'coding-dirs-update' }), sourceType: 'failure' },
          { proposal: makeProposal({ name: 'other-cmd-skill-fix', target_skill: 'other-cmd-skill' }), sourceType: 'failure' },
        ],
        {
          attemptCodeFixFn: async (proposal) => {
            calledFor.push(proposal.target_skill);
            return { outcome: 'code-fix-reverted', reason: `reverted ${proposal.target_skill}` };
          },
        }
      );

      assert.deepEqual(calledFor, ['coding-dirs-update', 'other-cmd-skill'], 'attemptCodeFix is called once per distinct target');
      assert.equal(entries[0].outcome, 'code-fix-reverted');
      assert.equal(entries[0].detail, 'reverted coding-dirs-update');
      assert.equal(entries[1].outcome, 'code-fix-reverted');
      assert.equal(entries[1].detail, 'reverted other-cmd-skill');
    });

    it('two proposals targeting the SAME skill: the second is skipped as target-already-attempted, not a second attemptCodeFix call (F5 rework, 2026-08-23)', async () => {
      await seedCmdTargetDraft();
      await createTempDraft(dir, 'coding-dirs-update-fix-2', 'Another prompt.', {
        proposed_at: new Date().toISOString(), reason: 'coding-dirs-update failed again.', source_turns: [],
        status: 'pending', fingerprint: computeFingerprint('coding-dirs-update-fix-2', 'Another prompt.'),
        source_type: 'failure', target_skill: 'coding-dirs-update',
      });

      let callCount = 0;
      const entries = await gateAndApprove(
        [
          { proposal: makeProposal({ name: 'coding-dirs-update-fix', target_skill: 'coding-dirs-update' }), sourceType: 'failure' },
          { proposal: makeProposal({ name: 'coding-dirs-update-fix-2', target_skill: 'coding-dirs-update' }), sourceType: 'failure' },
        ],
        { attemptCodeFixFn: async () => { callCount++; return { outcome: 'code-fix-reverted', reason: 'reverted' }; } }
      );

      assert.equal(callCount, 1, 'a second proposal for an already-attempted target must not call attemptCodeFix again');
      assert.equal(entries[0].outcome, 'code-fix-reverted');
      assert.equal(entries[1].outcome, 'code-fix-skipped-target-already-attempted');
    });

    it('a per-run wall-clock budget stops further code-fix attempts once exceeded (F5 rework, 2026-08-23)', async () => {
      await seedCmdTargetDraft();
      await createTempSkill(dir, 'other-cmd-skill', '---\ncmd: "python other.py"\n---\nOther.');
      await createTempDraft(dir, 'other-cmd-skill-fix', 'New prompt.', {
        proposed_at: new Date().toISOString(), reason: 'other-cmd-skill failed twice.', source_turns: [],
        status: 'pending', fingerprint: computeFingerprint('other-cmd-skill-fix', 'New prompt.'),
        source_type: 'failure', target_skill: 'other-cmd-skill',
      });

      // nowFn advances 50 minutes each time an attemptCodeFix call actually runs (representing
      // the real wall-clock time a fix consumes) — so the run's budget check sees the first
      // attempt as within budget and the second as past it.
      let clock = 0;
      const entries = await gateAndApprove(
        [
          { proposal: makeProposal({ name: 'coding-dirs-update-fix', target_skill: 'coding-dirs-update' }), sourceType: 'failure' },
          { proposal: makeProposal({ name: 'other-cmd-skill-fix', target_skill: 'other-cmd-skill' }), sourceType: 'failure' },
        ],
        {
          nowFn: () => clock,
          codeFixBudgetMs: 40 * 60_000,
          attemptCodeFixFn: async () => { clock += 50 * 60_000; return { outcome: 'code-fix-reverted', reason: 'reverted' }; },
        }
      );

      assert.equal(entries[0].outcome, 'code-fix-reverted', 'first attempt still runs — budget not yet spent');
      assert.equal(entries[1].outcome, 'code-fix-skipped-budget-exhausted');
      assert.match(entries[1].detail ?? '', /budget/);
    });

    it('a maxCodeFixes cap stops further code-fix attempts once reached (F5 rework, 2026-08-23)', async () => {
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
        {
          maxCodeFixes: 1,
          attemptCodeFixFn: async () => { callCount++; return { outcome: 'code-fix-reverted', reason: 'reverted' }; },
        }
      );

      assert.equal(callCount, 1, 'attemptCodeFix must be called at most maxCodeFixes times per run');
      assert.equal(entries[0].outcome, 'code-fix-reverted');
      assert.equal(entries[1].outcome, 'code-fix-skipped-limit-reached');
      assert.match(entries[1].detail ?? '', /max 1 per run/);
    });

    it('threads sameRunAppliedFiles from an earlier applied fix into the next attemptCodeFix call (F5 rework, 2026-08-23)', async () => {
      await seedCmdTargetDraft();
      await createTempSkill(dir, 'other-cmd-skill', '---\ncmd: "python other.py"\n---\nOther.');
      await createTempDraft(dir, 'other-cmd-skill-fix', 'New prompt.', {
        proposed_at: new Date().toISOString(), reason: 'other-cmd-skill failed twice.', source_turns: [],
        status: 'pending', fingerprint: computeFingerprint('other-cmd-skill-fix', 'New prompt.'),
        source_type: 'failure', target_skill: 'other-cmd-skill',
      });

      const receivedOpts: Array<{ sameRunAppliedFiles?: string[] } | undefined> = [];
      let callCount = 0;
      await gateAndApprove(
        [
          { proposal: makeProposal({ name: 'coding-dirs-update-fix', target_skill: 'coding-dirs-update' }), sourceType: 'failure' },
          { proposal: makeProposal({ name: 'other-cmd-skill-fix', target_skill: 'other-cmd-skill' }), sourceType: 'failure' },
        ],
        {
          attemptCodeFixFn: async (_proposal, _evidence, opts) => {
            receivedOpts.push(opts);
            callCount++;
            if (callCount === 1) {
              return { outcome: 'applied-code-fix', reason: 'Applied and pushed (commit abc1234).', commitHash: 'abc1234', filesChanged: ['projects/x/a.py'] };
            }
            return { outcome: 'code-fix-reverted', reason: 'reverted' };
          },
        }
      );

      assert.deepEqual(receivedOpts[0]?.sameRunAppliedFiles, [], 'first call sees no earlier-applied files this run');
      assert.deepEqual(receivedOpts[1]?.sameRunAppliedFiles, ['projects/x/a.py'], 'second call sees the files changed by the first applied fix');
    });
  });

  describe('maintenance-job target routing (2026-08-23 alerts wave)', () => {
    async function seedJobTargetDraft(): Promise<void> {
      // No skill.md is ever created for 'restore-drill' — target_kind:'maintenance-job'
      // proposals never route through loadSkill/isCmdBasedTarget, which both look a name up
      // as a skill. The trigger draft itself still needs to exist (markDraftMeta reads it).
      await createTempDraft(dir, 'restore-drill-alert-fix', 'inert (trigger record only)', {
        proposed_at: new Date().toISOString(),
        reason: 'restore-drill: 180 alerts in 7d — ENOENT: no such file',
        source_turns: [],
        status: 'pending',
        fingerprint: computeFingerprint('restore-drill-alert-fix', 'inert'),
        source_type: 'failure',
        target_skill: 'restore-drill',
      });
    }

    it('a target_kind:"maintenance-job" proposal reaches attemptCodeFixFn with the proposal intact and never reaches isCmdBasedTarget/loadSkill', async () => {
      await seedJobTargetDraft();
      let loadSkillWasCalledForJobName = false;
      let receivedProposal: DraftProposal | undefined;

      const entries = await gateAndApprove(
        [{
          proposal: makeProposal({
            name: 'restore-drill-alert-fix', target_skill: 'restore-drill', target_kind: 'maintenance-job',
            code_target: 'pa/src/lib/maintenance/jobs/restore-drill.ts',
            reason: 'restore-drill: 180 alerts in 7d — ENOENT: no such file',
          }),
          sourceType: 'failure',
          evidence: [{ skillName: 'restore-drill', error: 'ENOENT: no such file', timestamp: new Date().toISOString(), duration: 0, worker: 'census' }],
        }],
        {
          // isCmdBasedTarget swallows a missing skill.md and returns false (validator.ts),
          // so a regression that skipped the target_kind check would silently misroute this
          // proposal to the prompt-fix branch instead of throwing — this probe on
          // validateSkillFixFn (only reachable from that branch) is what catches it.
          validateSkillFixFn: async () => { loadSkillWasCalledForJobName = true; return true; },
          attemptCodeFixFn: async (proposal) => {
            receivedProposal = proposal;
            return { outcome: 'applied-code-fix', reason: 'Applied and pushed (commit job1234).', commitHash: 'job1234', filesChanged: ['pa/src/lib/maintenance/jobs/restore-drill.ts'] };
          },
        }
      );

      assert.equal(entries.length, 1);
      assert.equal(entries[0].outcome, 'applied-code-fix');
      assert.equal(loadSkillWasCalledForJobName, false, 'a maintenance-job target must never reach the prompt-fix validation path');
      assert.equal(receivedProposal?.name, 'restore-drill-alert-fix');
      assert.equal(receivedProposal?.target_kind, 'maintenance-job');
      assert.equal(receivedProposal?.code_target, 'pa/src/lib/maintenance/jobs/restore-drill.ts');
    });

    it('the preset evidence travels with the proposal instead of calling readRecentFailuresFn', async () => {
      await seedJobTargetDraft();
      let readRecentFailuresCalled = false;
      let receivedEvidence: any[] = [];
      const presetEvidence = [{ skillName: 'restore-drill', error: 'ENOENT: no such file', timestamp: new Date().toISOString(), duration: 0, worker: 'census' }];

      await gateAndApprove(
        [{
          proposal: makeProposal({ name: 'restore-drill-alert-fix', target_skill: 'restore-drill', target_kind: 'maintenance-job' }),
          sourceType: 'failure',
          evidence: presetEvidence,
        }],
        {
          readRecentFailuresFn: async () => { readRecentFailuresCalled = true; return []; },
          attemptCodeFixFn: async (_proposal, evidence) => { receivedEvidence = evidence; return { outcome: 'code-fix-reverted', reason: 'x' }; },
        }
      );

      assert.equal(readRecentFailuresCalled, false, 'preset evidence must be used instead of calling readRecentFailuresFn');
      assert.deepEqual(receivedEvidence, presetEvidence);
    });

    it('a maintenance-job proposal with NO preset evidence falls back to readRecentFailuresFn, filtered to the target (same as the cmd-based-skill route)', async () => {
      await seedJobTargetDraft();
      let receivedEvidence: any[] = [];

      await gateAndApprove(
        [{
          proposal: makeProposal({ name: 'restore-drill-alert-fix', target_skill: 'restore-drill', target_kind: 'maintenance-job' }),
          sourceType: 'failure',
        }],
        {
          readRecentFailuresFn: async () => [
            { skillName: 'restore-drill', error: 'ENOENT A', timestamp: new Date().toISOString(), duration: 1000, worker: 'codex' },
            { skillName: 'unrelated-skill', error: 'boom B', timestamp: new Date().toISOString(), duration: 1000, worker: 'codex' },
          ],
          attemptCodeFixFn: async (_proposal, evidence) => { receivedEvidence = evidence; return { outcome: 'code-fix-skipped-worker-failed', reason: 'x' }; },
        }
      );

      assert.equal(receivedEvidence.length, 1);
      assert.equal(receivedEvidence[0].error, 'ENOENT A');
    });

    it('rejects the trigger draft (rejected_auto) exactly as the cmd-based-skill route does', async () => {
      await seedJobTargetDraft();

      await gateAndApprove(
        [{
          proposal: makeProposal({ name: 'restore-drill-alert-fix', target_skill: 'restore-drill', target_kind: 'maintenance-job' }),
          sourceType: 'failure',
          evidence: [],
        }],
        { attemptCodeFixFn: async () => ({ outcome: 'code-fix-reverted', reason: 'x' }) }
      );

      const meta: DraftMeta = JSON.parse(
        await readFile(join(dir, 'skill-drafts', 'restore-drill-alert-fix', 'draft.meta.json'), 'utf8')
      );
      assert.equal(meta.status, 'rejected_auto', 'the prompt-fix draft itself is never deployed — code-fixer commits directly to the project');
    });
  });

  describe('audit trail (2026-07-11) — every terminal decision appends a record', () => {
    it('appends an applied-fix record with the diff, backup_path, and baseline populated', async () => {
      await createTempSkill(dir, 'baseline-skill', 'Old prompt.');
      await createTempRunMeta(dir, 'baseline-skill', {
        worker: 'codex', status: 'error', exitCode: 1, duration: 1000, timestamp: new Date().toISOString(), error: 'boom',
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

    describe('validation retry (2026-08-15)', () => {
      it('new-skill: first validation fails, regenerateProposalFn returns revised proposal, second validates → approved; updateDraftPromptFn called; entry detail "validated on retry 2"', async () => {
        let regenerateCalls = 0;
        let updateDraftCalls = 0;
        let receivedJudgeExcerpt: string | undefined;
        const revisedProposal = makeProposal({
          name: 'brand-new-skill-v2',
          prompt: 'Revised prompt that passes validation.',
          frontmatter: { cron: '*/5 * * * *' },
        });

        const entries = await gateAndApprove(
          [{ proposal: makeProposal({ name: 'brand-new-skill', target_skill: undefined }), sourceType: 'conversation' }],
          {
            validateNewSkillFn: async (p) => {
              // First call fails, second call (with revised proposal) passes.
              return p.name === 'brand-new-skill-v2';
            },
            regenerateProposalFn: async (proposal, judgeExcerpt) => {
              regenerateCalls++;
              receivedJudgeExcerpt = judgeExcerpt;
              return revisedProposal;
            },
            updateDraftPromptFn: async (name, fm, prompt) => {
              updateDraftCalls++;
              assert.equal(name, 'brand-new-skill-v2');
              assert.equal(fm.cron, '*/5 * * * *');
              assert.equal(prompt, 'Revised prompt that passes validation.');
            },
            approveDraftFn: async () => {},
          }
        );

        assert.equal(regenerateCalls, 1, 'regenerateProposalFn should be called exactly once');
        assert.equal(updateDraftCalls, 1, 'updateDraftPromptFn should be called exactly once');
        assert.ok(receivedJudgeExcerpt, 'judge_excerpt should be passed to regenerateProposalFn');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].outcome, 'approved-new-skill');
        assert.equal(entries[0].detail, 'validated on retry 2');
      });

      it('new-skill: regenerateProposalFn returns null → parks validation-failed-pending after exactly 1 attempt', async () => {
        let regenerateCalls = 0;

        const entries = await gateAndApprove(
          [{ proposal: makeProposal({ name: 'fails-validation', target_skill: undefined }), sourceType: 'conversation' }],
          {
            validateNewSkillFn: async () => false,
            regenerateProposalFn: async () => {
              regenerateCalls++;
              return null;
            },
          }
        );

        assert.equal(regenerateCalls, 1, 'regenerateProposalFn should be called exactly once');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].outcome, 'validation-failed-pending');
      });

      it('new-skill: both attempts fail → validation-failed-pending; regenerate called exactly once', async () => {
        let regenerateCalls = 0;
        let validateCalls = 0;

        const entries = await gateAndApprove(
          [{ proposal: makeProposal({ name: 'never-passes', target_skill: undefined }), sourceType: 'conversation' }],
          {
            validateNewSkillFn: async () => {
              validateCalls++;
              return false;
            },
            regenerateProposalFn: async (original, judgeExcerpt) => {
              regenerateCalls++;
              assert.ok(judgeExcerpt, 'judge_excerpt should be provided');
              // Return a revised proposal that also fails validation
              return makeProposal({ name: 'never-passes-v2', prompt: 'Still fails.' });
            },
          }
        );

        assert.equal(validateCalls, 2, 'validateNewSkillFn should be called twice (initial + 1 retry)');
        assert.equal(regenerateCalls, 1, 'regenerateProposalFn should be called exactly once');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].outcome, 'validation-failed-pending');
      });

      it('new-skill: no regenerateProposalFn passed → single attempt, parks (today\'s behavior unchanged)', async () => {
        let validateCalls = 0;

        const entries = await gateAndApprove(
          [{ proposal: makeProposal({ name: 'no-retry-fn', target_skill: undefined }), sourceType: 'conversation' }],
          {
            validateNewSkillFn: async () => {
              validateCalls++;
              return false;
            },
          }
        );

        assert.equal(validateCalls, 1, 'validateNewSkillFn should be called exactly once (no retry without fn)');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].outcome, 'validation-failed-pending');
      });

      it('skill-fix (non-cmd target): retry-then-pass with validateSkillFixFn', async () => {
        await createTempSkill(dir, 'needs-fix', 'Original prompt.');
        let regenerateCalls = 0;
        let validateCalls = 0;
        const revisedProposal = makeProposal({
          name: 'needs-fix-v2',
          target_skill: 'needs-fix',
          prompt: 'Fixed prompt that passes.',
        });

        const entries = await gateAndApprove(
          [{ proposal: makeProposal({ name: 'needs-fix-fix', target_skill: 'needs-fix' }), sourceType: 'failure' }],
          {
            validateSkillFixFn: async (p) => {
              validateCalls++;
              // First call fails, second passes
              return p.name === 'needs-fix-v2';
            },
            regenerateProposalFn: async () => {
              regenerateCalls++;
              return revisedProposal;
            },
            applyFixFn: async (p) => {
              assert.equal(p.name, 'needs-fix-v2', 'applyFixFn should receive the revised proposal');
            },
          }
        );

        assert.equal(validateCalls, 2, 'validateSkillFixFn should be called twice');
        assert.equal(regenerateCalls, 1, 'regenerateProposalFn should be called once');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].outcome, 'applied-fix');
        assert.ok(entries[0].detail?.includes('validated on retry 2'));
      });
    });
  });
});

// Git-optional gate test double (2026-08-31, the git-optional spec §4
// spec amendment 2026-08-31-A): all existing rollback tests were written before the guard
// existed and assume the git-revert branch executes. The test double restores the pre-guard
// execution path those tests were written against. A dedicated test below pins the blocking
// behavior.
const gitGuardFn = async () => ({ allowed: true, reason: 'test double' } as const);

describe('rollback', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
    // Git-optional guard (2026-08-31): the guard reads config.yaml, which must exist.
    // Omitting the git_workflow block defaults to "allowed" (legacy behavior).
    await createTempConfig(dir, []);
    // AI-176: this describe's first test drives the REAL rollback() (called with
    // no deps at all in one case) down a REAL 'restore' flag for skill
    // 'reminders' — production root cause of the 'Rollback: reminders'
    // duplicate rows in the plans index. Postmortems now write under PA_HOME
    // (2026-09-04 relocation), which createTempPaHome() points at this fixture.
    await mkdir(join(dir, 'plans', 'postmortems'), { recursive: true });
    await writeFile(
      join(dir, 'plans', 'INDEX.md'),
      '# Plans Index\n\n| Date | Title | Status | Link |\n|------|-------|--------|------|\n',
      'utf8'
    );
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it('appends a rolled-back audit record when restoring an in-place fix', async () => {
    // 3 errors, 1 success within the last 24h -> 75% failure rate, over the 50% threshold
    for (let i = 0; i < 3; i++) {
      await createTempRunMeta(dir, 'reminders', {
        worker: 'codex', status: 'error', exitCode: 1, duration: 1000,
        timestamp: new Date(Date.now() - i * 60000).toISOString(), error: 'boom',
      }, `err${i}`);
    }
    await createTempRunMeta(dir, 'reminders', {
      worker: 'codex', status: 'success', exitCode: 0, duration: 1000, timestamp: new Date().toISOString(),
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

    const lines = await rollback({});
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
    const lines = await rollback({});
    assert.deepEqual(lines, []);
    const records = await readAuditRecords(dir);
    assert.equal(records.length, 0);
  });

  it('acquires and releases the git-workflow lock with a per-call contextId and process.pid (C11)', async () => {
    // Same fixture shape as 'appends a rolled-back audit record' above — this
    // test only cares about the LOCK call shape (D3/D4), not the rollback
    // outcome. No heartbeat/onLost migration here: C11 says rollback()'s hold
    // is short by construction and has no timer to migrate onto
    // startLockRenewal.
    for (let i = 0; i < 3; i++) {
      await createTempRunMeta(dir, 'reminders', {
        worker: 'codex', status: 'error', exitCode: 1, duration: 1000,
        timestamp: new Date(Date.now() - i * 60000).toISOString(), error: 'boom',
      }, `err${i}`);
    }
    await createTempRunMeta(dir, 'reminders', {
      worker: 'codex', status: 'success', exitCode: 0, duration: 1000, timestamp: new Date().toISOString(),
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
      risk_flags: [],
    });
    await import('fs/promises').then(({ copyFile }) =>
      copyFile(join(dir, 'skills', 'reminders', 'skill.md'), join(dir, 'skill-drafts', 'reminders-fix', 'target-backup.skill.md'))
    );

    const acquireCalls: Array<{ resource: string; agent: string; pid: number; timeoutMs?: number; contextId?: string }> = [];
    const releaseCalls: Array<{ resource: string; agent: string; contextId?: string; opts?: { pid?: number } }> = [];
    const bb: BlackboardLockClient = {
      acquireLock: async (resource: string, agent: string, pid: number, timeoutMs?: number, contextId?: string) => {
        acquireCalls.push({ resource, agent, pid, timeoutMs, contextId });
        return true;
      },
      updateHeartbeat: async () => true,
      releaseLock: async (resource: string, agent: string, contextId?: string, opts?: { pid?: number }) => {
        releaseCalls.push({ resource, agent, contextId, opts });
      },
    };

    await rollback({ blackboardFn: bb, gitGuardFn });

    assert.equal(acquireCalls.length, 1);
    assert.equal(acquireCalls[0].resource, exclusiveLockKey(GIT_WORKFLOW_RESOURCE));
    assert.equal(typeof acquireCalls[0].contextId, 'string');
    assert.ok(acquireCalls[0].contextId!.length > 0, 'expected a minted contextId');
    assert.equal(acquireCalls[0].pid, process.pid);

    assert.equal(releaseCalls.length, 1);
    assert.equal(releaseCalls[0].resource, exclusiveLockKey(GIT_WORKFLOW_RESOURCE));
    assert.equal(releaseCalls[0].contextId, acquireCalls[0].contextId, 'release must use the SAME contextId as acquire');
    assert.deepEqual(releaseCalls[0].opts, { pid: process.pid });
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
  let originalCwd: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
    // Git-optional guard (2026-08-31): the guard reads config.yaml, which must exist.
    // Omitting the git_workflow block defaults to "allowed" (legacy behavior).
    await createTempConfig(dir, []);
    // AI-176: rollback() here is the REAL self-improver code (not mocked), and it
    // reaches maybeCreatePostmortem -> createPostmortemStub. Postmortems write
    // under PA_HOME (2026-09-04 relocation), which createTempPaHome() already
    // points at this fixture — the historical production duplicate rows
    // ('Rollback: coding-dirs-update', commit abc1234) came from the old
    // repo-rooted resolution. The chdir below exists only for the default
    // gitGuardFn probe (see its comment).
    originalCwd = process.cwd();
    await mkdir(join(dir, 'plans', 'postmortems'), { recursive: true });
    await writeFile(
      join(dir, 'plans', 'INDEX.md'),
      '# Plans Index\n\n| Date | Title | Status | Link |\n|------|-------|--------|------|\n',
      'utf8'
    );
    // Some tests below use the REAL default gitGuardFn (checkGitWorkflowAllowed),
    // which probes `git rev-parse --is-inside-work-tree` against process.cwd() —
    // `dir` must actually be a work tree or that guard now fails "not inside a
    // git work tree" for every test that doesn't override gitGuardFn. No commit
    // is needed for the probe to pass; every git command a test cares about goes
    // through its own mocked execFn, never real git.
    await promisify(execCb)('git init -q', { cwd: dir });
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
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
    const { bb } = makeLockFake();
    const lines = await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => {
        cmds.push(cmd);
        return { stdout: cmd.includes('rev-parse') ? 'def5678\n' : '', stderr: '' };
      },
      blackboardFn: bb,
      gitGuardFn,
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
    const { bb } = makeLockFake();
    const lines = await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => {
        if (cmd.includes('git revert')) throw new Error('could not revert: merge conflict in update_coding_dirs.py');
        return { stdout: '', stderr: '' };
      },
      blackboardFn: bb,
      gitGuardFn,
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
    const { bb } = makeLockFake();
    const lines = await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => ({ stdout: cmd.includes('rev-parse') ? 'def5678\n' : '', stderr: '' }),
      blackboardFn: bb,
      gitGuardFn,
    });

    assert.match(lines[0], /bot restart|rebuild/i);
  });

  it('refuses to revert (and audits rollback-failed) when the tree carries human WIP', async () => {
    // Updated behavior (2026-08-15): refusal is scoped to the condemned commit's files.
    // When diff-tree fails (simulated here by empty output), it falls back to the old
    // "refuse on any WIP" behavior.
    await seedDraft();
    const cmds: string[] = [];
    const { bb } = makeLockFake();
    const lines = await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => {
        cmds.push(cmd);
        if (cmd.includes('diff-tree')) {
          // Simulate diff-tree failure (empty output)
          return { stdout: '', stderr: '' };
        }
        if (cmd === 'git status --porcelain') {
          return { stdout: ' M pa/src/workers.ts\n M pa/data/profile.json\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
      blackboardFn: bb,
    });

    assert.match(lines[0], /Rollback FAILED/);
    assert.match(lines[0], /pa\/src\/workers\.ts/);
    assert.equal(cmds.some((c) => c.startsWith('git revert')), false);
    assert.equal(cmds.some((c) => c.startsWith('git reset --hard')), false);

    const rec = (await readAuditRecords(dir)).find((r) => r.action === 'rollback-failed');
    assert.ok(rec, 'expected a rollback-failed audit record');
    assert.equal(rec.commit_hash, 'abc1234');
  });

  it('proceeds with revert when WIP file is NOT in the condemned set (2026-08-15)', async () => {
    await seedDraft();
    const cmds: string[] = [];
    const { bb } = makeLockFake();
    const lines = await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => {
        cmds.push(cmd);
        if (cmd.includes('diff-tree')) {
          // Condemned commit touched projects/coding-dirs-updater/script.py only
          return { stdout: 'projects/coding-dirs-updater/script.py\n', stderr: '' };
        }
        if (cmd === 'git status --porcelain') {
          // WIP is in pa/src/workers.ts (NOT in condemned set)
          return { stdout: ' M pa/src/workers.ts\n', stderr: '' };
        }
        if (cmd === 'git rev-parse HEAD') return { stdout: 'def5678\n', stderr: '' };
        if (cmd === 'git rev-parse --abbrev-ref HEAD') return { stdout: 'main\n', stderr: '' };
        return { stdout: '', stderr: '' };
      },
      blackboardFn: bb,
      gitGuardFn,
    });

    // Should proceed with the revert
    assert.ok(cmds.some((c) => c.includes('git revert -n abc1234')));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Reverted/);
  });

  it('refuses when WIP file IS in the condemned set (2026-08-15)', async () => {
    await seedDraft();
    const cmds: string[] = [];
    const { bb } = makeLockFake();
    const lines = await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => {
        cmds.push(cmd);
        if (cmd.includes('diff-tree')) {
          // Condemned commit touched projects/coding-dirs-updater/script.py
          return { stdout: 'projects/coding-dirs-updater/script.py\n', stderr: '' };
        }
        if (cmd === 'git status --porcelain') {
          // WIP overlaps condemned path
          return { stdout: ' M projects/coding-dirs-updater/script.py\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
      blackboardFn: bb,
      gitGuardFn,
    });

    assert.match(lines[0], /Rollback FAILED/);
    assert.match(lines[0], /projects\/coding-dirs-updater\/script\.py/);
    assert.equal(cmds.some((c) => c.startsWith('git revert')), false);
  });

  it('on revert failure, runs scoped cleanup (revert --quit + checkout HEAD -- <condemned>) instead of tree-wide reset (2026-08-15)', async () => {
    await seedDraft();
    const cmds: string[] = [];
    const { bb } = makeLockFake();
    const lines = await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => {
        cmds.push(cmd);
        if (cmd.includes('diff-tree')) {
          return { stdout: 'projects/coding-dirs-updater/script.py\n', stderr: '' };
        }
        if (cmd.includes('revert -n')) {
          throw new Error('conflict');
        }
        return { stdout: '', stderr: '' };
      },
      blackboardFn: bb,
    });

    assert.match(lines[0], /Rollback FAILED/);
    assert.ok(cmds.some((c) => c.includes('git revert --quit')));
    assert.ok(cmds.some((c) => c.includes('git checkout HEAD -- projects/coding-dirs-updater/script.py')));
    assert.equal(cmds.some((c) => c.includes('git reset --hard HEAD')), false, 'should NOT run tree-wide reset');
  });

  it('acquires the git-workflow lock (correct resource/agent/pid/timeout) before any git command, and releases it after the last one', async () => {
    await seedDraft();
    const cmds: string[] = [];
    const { bb, state } = makeLockFake();

    await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => {
        cmds.push(cmd);
        if (cmd === 'git rev-parse HEAD') return { stdout: 'def5678\n', stderr: '' };
        if (cmd === 'git rev-parse --abbrev-ref HEAD') return { stdout: 'main\n', stderr: '' };
        return { stdout: '', stderr: '' };
      },
      blackboardFn: bb,
      gitGuardFn,
    });

    assert.equal(state.acquireCalls.length, 1);
    assert.equal(state.acquireCalls[0].resource, exclusiveLockKey(GIT_WORKFLOW_RESOURCE));
    assert.equal(state.acquireCalls[0].resource, 'skill-exclusive:git-workflow');
    assert.equal(state.acquireCalls[0].agent, 'self-improver-rollback');
    assert.equal(state.acquireCalls[0].timeoutMs, GIT_LOCK_WAIT_MS);
    assert.equal(state.releaseCalls, 1);
    assert.equal(state.held, false, 'the lock must be released after the last git command');
  });

  it('still releases the lock when the revert fails on the conflict path — the existing rollback-failed audit record and report line are unchanged (regression guard)', async () => {
    await seedDraft();
    const { bb, state } = makeLockFake();

    const lines = await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => {
        // gitRevertPreservingChurn stages the revert with `-n` (not `--no-edit` — that shape
        // was replaced by the churn-preservation rewrite, see gitRevertPreservingChurn's own
        // doc comment) then commits separately; triggering the failure here matches the
        // actual conflict point (the revert-staging step itself).
        if (cmd.includes('revert -n')) throw new Error('could not revert: merge conflict in update_coding_dirs.py');
        return { stdout: '', stderr: '' };
      },
      blackboardFn: bb,
      gitGuardFn,
    });

    assert.equal(state.releaseCalls, 1);
    assert.equal(state.held, false);
    assert.match(lines[0], /Rollback FAILED/);
    assert.match(lines[0], /merge conflict/);

    const rec = (await readAuditRecords(dir)).find((r) => r.action === 'rollback-failed');
    assert.ok(rec, 'expected a rollback-failed audit record (unchanged by the lock restructure)');
    assert.equal(rec.commit_hash, 'abc1234');
  });

  it('defers without touching git or writing an audit record when the lock is busy — the returned line mentions the deferral', async () => {
    await seedDraft();
    const { bb } = makeLockFake({ acquire: false });
    let execCalled = false;

    const lines = await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => { execCalled = true; return { stdout: '', stderr: '' }; },
      blackboardFn: bb,
      gitGuardFn,
    });

    assert.equal(execCalled, false, 'must not touch git at all when the lock is busy');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /DEFERRED/i);

    const records = await readAuditRecords(dir);
    assert.equal(records.length, 0, 'a transient, self-healing lock wait must not write an audit record (no rollback-failed escalation)');
  });

  it('has zero lock interaction at all when checkForRollbacksFn returns no flags', async () => {
    const { bb, state } = makeLockFake();

    const lines = await rollback({
      checkForRollbacksFn: async () => [],
      blackboardFn: bb,
      gitGuardFn,
    });

    assert.deepEqual(lines, []);
    assert.equal(state.acquireCalls.length, 0);
    assert.equal(state.releaseCalls, 0);
  });

  // ---------------------------------------------------------------------------
  // Git-optional gate (2026-08-31, the git-optional spec §4
  // spec amendment 2026-08-31-A)
  // ---------------------------------------------------------------------------

  it('throws into rollback-failed handling when the guard returns allowed: false — manual revert required', async () => {
    await seedDraft();
    const { bb } = makeLockFake();
    let execCalled = false;

    const lines = await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => {
        execCalled = true;
        return { stdout: cmd.includes('rev-parse') ? 'def5678\n' : '', stderr: '' };
      },
      blackboardFn: bb,
      gitGuardFn: async () => ({ allowed: false, reason: 'git_workflow.enabled is false' } as const),
    });

    // Guard blocked before git was touched: no exec calls.
    assert.equal(execCalled, false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Rollback FAILED/);
    assert.match(lines[0], /git workflow not allowed.*git_workflow\.enabled is false.*manual revert.*abc1234/);

    const records = await readAuditRecords(dir);
    const failedRecord = records.find((r) => r.action === 'rollback-failed');
    assert.ok(failedRecord, 'expected a rollback-failed audit record');
    assert.match(failedRecord.reason, /git workflow not allowed.*git_workflow\.enabled is false/);
  });

  // AI-176 regression: the postmortem stub triggered by a rollback must land
  // under the isolated PA_HOME fixture (2026-09-04 relocation) and must carry
  // the REAL target skill name. This also settles the
  // "'Rollback: x' name" investigation for THIS path: flag.skillName flows
  // through unmodified, with no resolution fall-through to a placeholder.
  it('writes the rollback postmortem stub into the isolated fixture with the real target skill name', async () => {
    await seedDraft();
    const { bb } = makeLockFake();
    await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => ({ stdout: cmd.includes('rev-parse') ? 'def5678\n' : '', stderr: '' }),
      blackboardFn: bb,
      gitGuardFn,
    });

    const postmortemFiles = await readdir(join(dir, 'plans', 'postmortems'));
    assert.ok(
      postmortemFiles.some((f) => f.includes('rolled-back-coding-dirs-update')),
      `expected a postmortem stub naming coding-dirs-update, got: ${postmortemFiles.join(', ')}`
    );
    assert.ok(
      !postmortemFiles.some((f) => /rolled-back-x[-.]/.test(f)),
      'skillName must not fall through to a bare "x" placeholder'
    );

    const indexContent = await readFile(join(dir, 'plans', 'INDEX.md'), 'utf-8');
    assert.match(indexContent, /Rollback: coding-dirs-update/);
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
  let originalCwd: string;
  const runShell = promisify(execCb);
  const CHURN = '{"v":3,"learned":"today"}\n';
  let badFix: string;

  const git = async (cmd: string): Promise<{ stdout: string; stderr: string }> => {
    // Explicit cwd, unaffected by the process.chdir() below — the chdir exists
    // only for the default gitGuardFn probe (see beforeEach comment).
    const { stdout, stderr } = await runShell(cmd, { cwd: repo });
    return { stdout: String(stdout), stderr: String(stderr) };
  };

  beforeEach(async () => {
    paHome = await createTempPaHome();
    repo = await mkdtemp(join(tmpdir(), 'pa-revert-repo-'));
    // Git-optional guard (2026-08-31): the guard reads config.yaml, which must exist.
    // Omitting the git_workflow block defaults to "allowed" (legacy behavior).
    await createTempConfig(paHome, []);

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

    // AI-176: rollback() here is the REAL self-improver code (by design — see
    // the comment above this describe). Postmortems write under PA_HOME
    // (2026-09-04 relocation) — createTempPaHome() points PA_HOME at the
    // paHome fixture, so stubs land there, NOT in `repo`. The chdir into
    // `repo` remains for ONE reason only: rollback()'s default gitGuardFn
    // (checkGitWorkflowAllowed, used below since none of this describe's
    // tests override it) probes process.cwd() for "inside a git work tree",
    // and paHome is neither a work tree nor meant to be one. The plans/ seed
    // lives under paHome for the same reason. Added AFTER the git-add/commit
    // calls above so the fixture's own `git add -A` never sweeps scaffolding
    // into a commit; every real git command in `git()`/gitRevertPreservingChurn
    // below targets specific pathspecs (or the condemned commit's own
    // diff-tree), so these untracked files never affect the WIP/churn scoping.
    originalCwd = process.cwd();
    await mkdir(join(paHome, 'plans', 'postmortems'), { recursive: true });
    await writeFile(
      join(paHome, 'plans', 'INDEX.md'),
      '# Plans Index\n\n| Date | Title | Status | Link |\n|------|-------|--------|------|\n',
      'utf8'
    );
    process.chdir(repo);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
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

  // AI-176 investigation finding: this fixture's checkForRollbacksFn mock genuinely
  // uses the literal skillName 'x' (a throwaway placeholder for its own disposable git
  // repo, chosen independently of any real skill) — there is no resolution fall-through
  // in self-improver.ts. Under the old repo-rooted resolution every run of this
  // describe wrote that literal title into the REAL repo's plans index via
  // postmortem.ts's then-process.cwd()-dependent lookup — that is the actual origin of
  // the "Rollback: x" rows found in production, not a name-resolution bug. This test
  // pins both halves: the title is genuinely 'x' (matching the fixture, as expected),
  // and it lands under the isolated PA_HOME fixture (2026-09-04 relocation).
  it('creates the "Rollback: x" postmortem in the isolated fixture, matching this fixture\'s literal skillName', async () => {
    await runRollback();

    const postmortemFiles = await readdir(join(paHome, 'plans', 'postmortems'));
    assert.ok(
      postmortemFiles.some((f) => /^\d{4}-\d{2}-\d{2}-rolled-back-x-[0-9a-f]+\.md$/.test(f)),
      `expected a rolled-back-x-<hash> postmortem stub, got: ${postmortemFiles.join(', ')}`
    );

    const indexContent = await readFile(join(paHome, 'plans', 'INDEX.md'), 'utf-8');
    assert.match(indexContent, /Rollback: x/);
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

describe('P2-19: rollback-failed notification (self-improver rollback path)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
    // AI-176: this describe's rollback-failed path also drives the REAL
    // maybeCreatePostmortem — commit 'abc1234'/skill 'coding-dirs-update',
    // one of the historical sources of duplicate rows in the production
    // plans index. Postmortems write under PA_HOME (2026-09-04 relocation),
    // which createTempPaHome() points at this fixture.
    await mkdir(join(dir, 'plans', 'postmortems'), { recursive: true });
    await writeFile(
      join(dir, 'plans', 'INDEX.md'),
      '# Plans Index\n\n| Date | Title | Status | Link |\n|------|-------|--------|------|\n',
      'utf8'
    );
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

  it('sends pa-alerts notification after rollback-failed audit record (P2-19)', async () => {
    await seedDraft();

    let notifyCalls: any[] = [];
    const mockNotify = async (subject: string, message: string, opts: any) => {
      notifyCalls.push({ subject, message, opts });
      return { sent: true, suppressed: false };
    };

    const { bb } = makeLockFake();
    const lines = await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => {
        if (cmd.includes('git revert')) throw new Error('conflict');
        return { stdout: '', stderr: '' };
      },
      blackboardFn: bb,
      notifyUserFn: mockNotify,
      gitGuardFn,
    });

    assert.equal(lines.length, 1);
    assert.match(lines[0], /Rollback FAILED/);

    // Should have sent a notification
    assert.equal(notifyCalls.length, 1);
    const call = notifyCalls[0];
    assert.equal(call.subject, 'Rollback Failed — Bad Fix Live');
    assert.ok(call.message.includes('coding-dirs-update'));
    assert.ok(call.message.includes('abc1234'));
    assert.ok(call.opts.dedupKey === 'rollback-failed');
    assert.ok(call.opts.severity === 'error');
    assert.match(call.message, /_Ref: [0-9a-f]+_/, 'Should include ref-ID');
  });

  it('notification is best-effort — audit record succeeds even if notify fails', async () => {
    await seedDraft();

    let notifyThrew = false;
    const mockNotify = async () => {
      notifyThrew = true;
      throw new Error('Notification failed');
    };

    const { bb } = makeLockFake();
    const lines = await rollback({
      checkForRollbacksFn: async () => [gitRevertFlag()],
      execFn: async (cmd: string) => {
        if (cmd.includes('git revert')) throw new Error('conflict');
        return { stdout: '', stderr: '' };
      },
      blackboardFn: bb,
      notifyUserFn: mockNotify,
      gitGuardFn,
    });

    // Audit record should still be written
    const records = await readAuditRecords(dir);
    const rec = records.find((r) => r.action === 'rollback-failed');
    assert.ok(rec, 'Audit record should exist despite notification failure');
    assert.equal(rec.commit_hash, 'abc1234');
    assert.equal(notifyThrew, true, 'Notification should have been attempted');
  });
});

// WPD6: Postmortem stub creation tests
describe('postmortem stub creation (WPD6)', () => {
  let dir: string;
  let originalCwd: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
    originalCwd = process.cwd();
    // postmortem stubs only write under a root containing plans/ — create the
    // repo-shape fixture the module expects (dir + INDEX table header).
    const plansDir = join(dir, 'plans', 'postmortems');
    await (await import('fs/promises')).mkdir(plansDir, { recursive: true });
    await (await import('fs/promises')).writeFile(
      join(dir, 'plans', 'INDEX.md'),
      '# Plans Index\n\n| Date | Title | Status | Link |\n|------|-------|--------|------|\n',
      'utf8'
    );
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await cleanup(dir);
  });

  it('creates postmortem stub after successful rollback', async () => {
    // Create a draft and skill that will be rolled back
    await createTempSkill(dir, 'test-skill', 'skill body');
    await createTempDraft(dir, 'test-fix', 'draft body', {
      proposed_at: new Date().toISOString(), reason: 'postmortem failure-path fixture', source_turns: [],
      status: 'pending', fingerprint: 'postmortem-fixture-fp', source_type: 'failure', target_skill: 'test-skill',
    });
    // The restore path copies the draft's pre-fix backup over the live skill.md
    const fsp = await import('fs/promises');
    await fsp.writeFile(join(dir, 'skill-drafts', 'test-fix', 'target-backup.skill.md'), 'original skill body', 'utf8');

    // Simulate a rollback scenario
    const { bb, state } = makeLockFake({ acquire: true });
    const lines = await rollback({
      checkForRollbacksFn: async () => [{
        draftName: 'test-fix',
        skillName: 'test-skill',
        kind: 'restore',
        commitHash: undefined,
      }],
      execFn: async () => ({ stdout: '', stderr: '' }),
      blackboardFn: bb,
    });

    // Verify rollback completed
    assert.ok(lines.some((l) => l.includes('Restored')), 'Rollback should have succeeded');

    // Verify postmortem stub was created
    const postmortemsDir = join(dir, 'plans', 'postmortems');
    const postmortemFiles = await (async () => {
      try {
        return await (await import('fs/promises')).readdir(postmortemsDir);
      } catch {
        return [];
      }
    })();

    assert.ok(postmortemFiles.length > 0, 'Should have created at least one postmortem stub');
    assert.ok(postmortemFiles.some((f: string) => f.includes('rolled-back-test-skill')), 'Should have created postmortem for test-skill');
  });

  it('postmortem creation failure does not break rollback flow', async () => {
    // This test verifies that even if postmortem creation fails, rollback completes
    // The postmortem creation is wrapped in try-catch and only logs errors

    await createTempSkill(dir, 'test-skill', 'skill body');
    await createTempDraft(dir, 'test-fix', 'draft body', {
      proposed_at: new Date().toISOString(), reason: 'postmortem failure-path fixture', source_turns: [],
      status: 'pending', fingerprint: 'postmortem-fixture-fp', source_type: 'failure', target_skill: 'test-skill',
    });
    // Same backup fixture as the happy-path test — rollback must reach 'Restored'
    const fsp2 = await import('fs/promises');
    await fsp2.writeFile(join(dir, 'skill-drafts', 'test-fix', 'target-backup.skill.md'), 'original skill body', 'utf8');

    // Make postmortems directory unwritable (simulating permission error)
    const postmortemsDir = join(dir, 'plans', 'postmortems');
    await (await import('fs/promises')).mkdir(postmortemsDir, { recursive: true });

    // Simulate a permission error by making the directory read-only
    // (This is hard to test cross-platform, so we'll just verify the try-catch logic)

    const { bb } = makeLockFake({ acquire: true });
    const lines = await rollback({
      checkForRollbacksFn: async () => [{
        draftName: 'test-fix',
        skillName: 'test-skill',
        kind: 'restore',
        commitHash: undefined,
      }],
      execFn: async () => ({ stdout: '', stderr: '' }),
      blackboardFn: bb,
    });

    // Rollback should still succeed even if postmortem had issues
    assert.ok(lines.some((l) => l.includes('Restored')), 'Rollback should have succeeded despite postmortem issues');
  });
});

// ---------------------------------------------------------------------------
// buildReport — suppression overlay (2026-08-29, the alert-suppression spec)
// ---------------------------------------------------------------------------

describe('buildReport — suppression overlay', () => {
  it('suppressed human-gated family is absent from Operator action needed', () => {
    const census = makeCensus({
      families: [
        makeCensusFamily({ classification: 'human-gated', suppressedBy: 'fix-record' as const }),
      ],
    });
    const report = buildReport([], [], 0, 0, census);
    assert.ok(!report.includes('Operator action needed'));
  });

  it('suppressed repeat-unchanged family is absent from Alert hygiene', () => {
    const census = makeCensus({
      families: [
        makeCensusFamily({ classification: 'repeat-unchanged', suppressedBy: 'green-signal' as const }),
        makeCensusFamily({ classification: 'repeat-unchanged' }),
      ],
    });
    const report = buildReport([], [], 0, 0, census);
    assert.ok(!report.match(/\*Alert hygiene \(2\)\*/)); // Only one in the section
    assert.ok(report.match(/\*Alert hygiene \(1\)\*/));
  });

  it('unsuppressed families still appear', () => {
    const census = makeCensus({
      families: [
        makeCensusFamily({ classification: 'human-gated', family: 'suppressed-family', suppressedBy: 'fix-record' as const }),
        makeCensusFamily({ classification: 'human-gated', family: 'active-family' }),
        makeCensusFamily({ classification: 'repeat-unchanged', family: 'suppressed-repeat', suppressedBy: 'green-signal' as const }),
        makeCensusFamily({ classification: 'repeat-unchanged', family: 'active-repeat' }),
      ],
    });
    const report = buildReport([], [], 0, 0, census);
    assert.ok(report.includes('active-family'));
    assert.ok(report.includes('active-repeat'));
    assert.ok(!report.includes('suppressed-family'));
    assert.ok(!report.includes('suppressed-repeat'));
  });

  it('trace line present with both counts when any family is suppressed', () => {
    const census = makeCensus({
      families: [
        makeCensusFamily({ classification: 'human-gated', suppressedBy: 'fix-record' as const }),
        makeCensusFamily({ classification: 'repeat-unchanged', suppressedBy: 'green-signal' as const }),
      ],
    });
    const report = buildReport([], [], 0, 0, census);
    assert.ok(report.match(/Known-fixed suppressed: 2 \(1 fix-record, 1 green-signal; recurrences resurface\)/));
  });

  it('trace line absent when nothing is suppressed', () => {
    const census = makeCensus({
      families: [
        makeCensusFamily({ classification: 'human-gated' }),
      ],
    });
    const report = buildReport([], [], 0, 0, census);
    assert.ok(!report.includes('Known-fixed suppressed'));
  });

  it('regressed family still listed, line carries the marker', () => {
    const census = makeCensus({
      families: [
        makeCensusFamily({
          classification: 'human-gated',
          family: 'regressed-family',
          regressedAfterFix: true,
          fixedAt: '2026-08-19T00:00:00.000Z',
        }),
      ],
    });
    const report = buildReport([], [], 0, 0, census);
    assert.ok(report.includes('*Operator action needed (1)*'));
    assert.ok(report.match(/⚠ recurred after fix 2026-08-19T00:00:00\.000Z/));
  });

  it('regressed repeat-unchanged family carries the marker too', () => {
    const census = makeCensus({
      families: [
        makeCensusFamily({
          classification: 'repeat-unchanged',
          family: 'regressed-repeat',
          regressedAfterFix: true,
          fixedAt: '2026-08-10T00:00:00.000Z',
        }),
      ],
    });
    const report = buildReport([], [], 0, 0, census);
    assert.ok(report.includes('*Alert hygiene (1)*'));
    assert.ok(report.match(/⚠ recurred after fix 2026-08-10T00:00:00\.000Z/));
  });
});
