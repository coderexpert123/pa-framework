import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { isProtected, isCriticalChange, hasRealSideEffects, applyFix, validateSkillFix, isCmdBasedTarget } from '../src/validator.js';
import { createTempPaHome, createTempSkill, createTempDraft, cleanup } from './helpers.js';
import { computeFingerprint } from '../src/drafts.js';
import type { DraftMeta, DraftProposal, RunMeta } from '../src/types.js';

/** Writes a fixture .meta file directly into logsDir()/<skillName>/ — same shape
 * readRecentFailures() (failure-analyzer.ts) reads, matching the pattern already
 * established in failure-analyzer.test.ts. */
async function createTempFailureMeta(dir: string, skillName: string, meta: RunMeta): Promise<void> {
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
    duration: 30000,
    timestamp: new Date().toISOString(),
    error: 'Killed: exceeded max timeout of 600s',
    ...overrides,
  };
}

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
    reason: 'test',
    source_message_ids: [],
    frontmatter: {},
    prompt: 'Do the thing.',
    ...overrides,
  };
}

function makeMeta(overrides: Partial<DraftMeta> = {}): DraftMeta {
  return {
    proposed_at: new Date().toISOString(),
    reason: 'test',
    source_turns: [],
    status: 'pending',
    fingerprint: computeFingerprint('x', 'Do the thing.'),
    source_type: 'failure',
    ...overrides,
  };
}

describe('isProtected (hard block — self-guard, 2026-07-11 full-autonomy regime)', () => {
  it('is protected when a new-skill proposal names the protected skill (self-improver)', () => {
    assert.equal(isProtected(makeProposal({ name: 'self-improver' })), true);
  });

  it('is protected when a fix proposal targets the protected skill (self-improver)', () => {
    assert.equal(
      isProtected(makeProposal({ name: 'self-improver-fix', target_skill: 'self-improver' })),
      true
    );
  });

  it('is NOT protected for an ordinary skill name or target', () => {
    assert.equal(isProtected(makeProposal({ name: 'weather-report' })), false);
    assert.equal(
      isProtected(makeProposal({ name: 'weather-report-fix', target_skill: 'weather-report' })),
      false
    );
  });
});

describe('isCriticalChange (risk flag only, no longer a gate — 2026-07-11)', () => {
  it('is NOT critical for the protected skill itself — protection is isProtected()\'s job now, not this one\'s', async () => {
    const critical = await isCriticalChange(makeProposal({ name: 'self-improver' }));
    assert.equal(critical, false);
  });

  it('is critical when target_skill points at a skill with critical: true', async () => {
    await createTempSkill(dir, 'reminders', '---\ncritical: true\n---\nProcess reminders.');
    const critical = await isCriticalChange(
      makeProposal({ name: 'reminders-fix', target_skill: 'reminders' })
    );
    assert.equal(critical, true);
  });

  it('is NOT critical when target_skill points at a non-critical skill', async () => {
    await createTempSkill(dir, 'weather-report', 'Prompt.');
    const critical = await isCriticalChange(
      makeProposal({ name: 'weather-report-fix', target_skill: 'weather-report' })
    );
    assert.equal(critical, false);
  });

  it('is NOT critical for a brand-new skill proposal (name does not exist yet)', async () => {
    const critical = await isCriticalChange(makeProposal({ name: 'totally-new-skill' }));
    assert.equal(critical, false);
  });
});

describe('hasRealSideEffects', () => {
  it('is true when the proposal itself declares secrets', async () => {
    const has = await hasRealSideEffects(
      makeProposal({ frontmatter: { secrets: ['TELEGRAM_BOT_TOKEN'] } })
    );
    assert.equal(has, true);
  });

  it('is true when the fix target skill declares secrets, even if the proposal does not', async () => {
    await createTempSkill(
      dir,
      'daily-mail-brief',
      '---\nsecrets:\n  - TELEGRAM_BOT_TOKEN\n---\nSend the brief.'
    );
    const has = await hasRealSideEffects(
      makeProposal({ name: 'daily-mail-brief-fix', target_skill: 'daily-mail-brief', frontmatter: {} })
    );
    assert.equal(has, true);
  });

  it('is false when neither the proposal nor its target declares any secrets', async () => {
    await createTempSkill(dir, 'log-summary', 'Summarize logs.');
    const has = await hasRealSideEffects(
      makeProposal({ name: 'log-summary-fix', target_skill: 'log-summary', frontmatter: {} })
    );
    assert.equal(has, false);
  });
});

describe('applyFix', () => {
  it('backs up the target, overwrites it in place, and marks the draft approved+applied_in_place', async () => {
    await createTempSkill(
      dir,
      'reminders',
      ['---', 'cron: "* * * * *"', 'cwd: "D:/somewhere"', '---', '', 'Old broken prompt.'].join('\n')
    );
    const proposal = makeProposal({ name: 'reminders-fix', target_skill: 'reminders', prompt: 'Fixed prompt.' });
    await createTempDraft(dir, 'reminders-fix', 'Fixed prompt.', makeMeta({ target_skill: 'reminders' }));

    await applyFix(proposal);

    // Backup preserves the exact pre-fix content
    const backup = await readFile(join(dir, 'skill-drafts', 'reminders-fix', 'target-backup.skill.md'), 'utf8');
    assert.match(backup, /Old broken prompt/);
    assert.match(backup, /cron: "\* \* \* \* \*"/);

    // Target skill.md is overwritten in place — same name, new prompt, frontmatter preserved
    const deployed = await readFile(join(dir, 'skills', 'reminders', 'skill.md'), 'utf8');
    assert.match(deployed, /Fixed prompt/);
    assert.match(deployed, /cron:\s*"?\* \* \* \* \*"?/);
    assert.doesNotMatch(deployed, /Old broken prompt/);

    // No disconnected sibling skill was created under the draft's own name
    await assert.rejects(stat(join(dir, 'skills', 'reminders-fix')));

    // Draft meta marks this as an autonomously-applied, in-place fix
    const meta: DraftMeta = JSON.parse(
      await readFile(join(dir, 'skill-drafts', 'reminders-fix', 'draft.meta.json'), 'utf8')
    );
    assert.equal(meta.status, 'approved');
    assert.equal(meta.approved_autonomously, true);
    assert.equal(meta.applied_in_place, true);
    assert.equal(meta.target_skill, 'reminders');
  });

  it('throws when called on a proposal with no target_skill', async () => {
    const proposal = makeProposal({ name: 'no-target', target_skill: undefined });
    await assert.rejects(() => applyFix(proposal), /target_skill/);
  });
});

describe('validateSkillFix', () => {
  it('fails closed immediately for a cmd-based target skill, without calling the runner', async () => {
    await createTempSkill(
      dir,
      'coding-dirs-update',
      ['---', 'cron: "*/5 * * * *"', 'cmd: "python update_coding_dirs.py"', '---', '', 'Updates the pinned directory list.'].join('\n')
    );
    const proposal = makeProposal({ name: 'coding-dirs-update-fix', target_skill: 'coding-dirs-update' });

    let runnerCalled = false;
    const runner = async (_p: string, _o: any) => {
      runnerCalled = true;
      return { result: { success: true, output: 'x', exitCode: 0 as number | null }, worker: 'mock' };
    };

    const valid = await validateSkillFix(proposal, runner as any);
    assert.equal(valid, false);
    assert.equal(runnerCalled, false, 'a cmd-based target must never reach the LLM runner — the prompt text is inert for it');
  });

  it('returns false when target_skill does not resolve to a real skill', async () => {
    const proposal = makeProposal({ name: 'ghost-fix', target_skill: 'does-not-exist' });
    const valid = await validateSkillFix(proposal);
    assert.equal(valid, false);
  });

  // Evidence-judged redesign (2026-07-11): the old "old prompt must fail, new must succeed"
  // semantics almost never passed (old prompts rarely reproduce a failure when run bare,
  // with no failure-triggering context), so fixes piled up pending forever. Now: the new
  // prompt must run successfully, then an LLM judge decides whether it plausibly addresses
  // the skill's recorded failure evidence while preserving its documented purpose.

  it('fails closed (false) when the new prompt itself fails to run, without ever calling the judge', async () => {
    await createTempSkill(dir, 'flaky-skill', 'Original prompt describing the purpose.');
    const proposal = makeProposal({ name: 'flaky-skill-fix', target_skill: 'flaky-skill', prompt: 'New prompt.' });

    let judgeCalled = false;
    const runner = async () => ({ result: { success: false, output: '', error: 'boom', exitCode: 1 as number | null }, worker: 'mock' });
    const judge = async () => { judgeCalled = true; return { result: { success: true, output: 'true', exitCode: 0 as number | null }, worker: 'mock' }; };

    const valid = await validateSkillFix(proposal, runner as any, judge as any);
    assert.equal(valid, false);
    assert.equal(judgeCalled, false, 'the judge is wasted work if the new prompt does not even run successfully');
  });

  it('applies when the new prompt succeeds and the judge says true', async () => {
    await createTempSkill(dir, 'daily-mail-brief', 'Send the daily mail brief.');
    await createTempFailureMeta(dir, 'daily-mail-brief', makeErrorMeta({ error: 'Template rendering error: missing field "subject"' }));
    const proposal = makeProposal({ name: 'daily-mail-brief-fix', target_skill: 'daily-mail-brief', prompt: 'New prompt that adds a default subject.' });

    let judgePromptSeen = '';
    const runner = async () => ({ result: { success: true, output: 'Brief sent successfully.', exitCode: 0 as number | null }, worker: 'mock' });
    const judge = async (p: string) => { judgePromptSeen = p; return { result: { success: true, output: 'true', exitCode: 0 as number | null }, worker: 'mock' }; };

    const valid = await validateSkillFix(proposal, runner as any, judge as any);
    assert.equal(valid, true);
    // The judge prompt actually carries the evidence and the candidate output — not a
    // generic "trust me" ask.
    assert.match(judgePromptSeen, /Template rendering error: missing field "subject"/);
    assert.match(judgePromptSeen, /Brief sent successfully\./);
    assert.match(judgePromptSeen, /New prompt that adds a default subject\./);
  });

  it('stays invalid when the new prompt succeeds but the judge says false', async () => {
    await createTempSkill(dir, 'daily-mail-brief', 'Send the daily mail brief.');
    const proposal = makeProposal({ name: 'daily-mail-brief-fix-2', target_skill: 'daily-mail-brief', prompt: 'An unrelated rewrite.' });

    const runner = async () => ({ result: { success: true, output: 'ok', exitCode: 0 as number | null }, worker: 'mock' });
    const judge = async () => ({ result: { success: true, output: 'false', exitCode: 0 as number | null }, worker: 'mock' });

    const valid = await validateSkillFix(proposal, runner as any, judge as any);
    assert.equal(valid, false);
  });

  it('fails closed when the judge run itself fails (no crash, no false-positive)', async () => {
    await createTempSkill(dir, 'daily-mail-brief', 'Send the daily mail brief.');
    const proposal = makeProposal({ name: 'daily-mail-brief-fix-3', target_skill: 'daily-mail-brief', prompt: 'New prompt.' });

    const runner = async () => ({ result: { success: true, output: 'ok', exitCode: 0 as number | null }, worker: 'mock' });
    const judge = async () => ({ result: { success: false, output: '', error: 'judge worker crashed', exitCode: 1 as number | null }, worker: 'mock' });

    const valid = await validateSkillFix(proposal, runner as any, judge as any);
    assert.equal(valid, false);
  });

  it('works with no recorded failure evidence — judge still gets a coherent prompt, not a crash', async () => {
    await createTempSkill(dir, 'quiet-skill', 'A skill with no logged failures yet.');
    const proposal = makeProposal({ name: 'quiet-skill-fix', target_skill: 'quiet-skill', prompt: 'New prompt.' });

    let judgePromptSeen = '';
    const runner = async () => ({ result: { success: true, output: 'ok', exitCode: 0 as number | null }, worker: 'mock' });
    const judge = async (p: string) => { judgePromptSeen = p; return { result: { success: true, output: 'true', exitCode: 0 as number | null }, worker: 'mock' }; };

    const valid = await validateSkillFix(proposal, runner as any, judge as any);
    assert.equal(valid, true);
    assert.match(judgePromptSeen, /no recorded failures/i);
  });

  describe('onDetail (audit-trail side channel — 2026-07-11)', () => {
    it('reports new_run_ok:false and nothing else when the new prompt fails to run', async () => {
      await createTempSkill(dir, 'detail-skill-1', 'Original.');
      const proposal = makeProposal({ name: 'detail-skill-1-fix', target_skill: 'detail-skill-1', prompt: 'New.' });
      const runner = async () => ({ result: { success: false, output: '', error: 'boom', exitCode: 1 as number | null }, worker: 'mock' });

      let detail: any;
      await validateSkillFix(proposal, runner as any, undefined, (d) => { detail = d; });
      assert.deepEqual(detail, { new_run_ok: false });
    });

    it('reports new_run_ok:true, judge_verdict, and a truncated judge_excerpt on a full run', async () => {
      await createTempSkill(dir, 'detail-skill-2', 'Original.');
      const proposal = makeProposal({ name: 'detail-skill-2-fix', target_skill: 'detail-skill-2', prompt: 'New.' });
      const runner = async () => ({ result: { success: true, output: 'ok', exitCode: 0 as number | null }, worker: 'mock' });
      const judge = async () => ({ result: { success: true, output: `true — ${'x'.repeat(400)}`, exitCode: 0 as number | null }, worker: 'mock' });

      let detail: any;
      await validateSkillFix(proposal, runner as any, judge as any, (d) => { detail = d; });
      assert.equal(detail.new_run_ok, true);
      assert.equal(detail.judge_verdict, true);
      assert.ok(detail.judge_excerpt.length <= 300, `expected judge_excerpt truncated to 300 chars, got ${detail.judge_excerpt.length}`);
    });

    it('is never called for a cmd-based target (validation never even starts)', async () => {
      await createTempSkill(dir, 'cmd-detail-skill', '---\ncmd: "python x.py"\n---\nDoc.');
      const proposal = makeProposal({ name: 'cmd-detail-skill-fix', target_skill: 'cmd-detail-skill' });

      let called = false;
      await validateSkillFix(proposal, undefined, undefined, () => { called = true; });
      assert.equal(called, false);
    });
  });
});

describe('isCmdBasedTarget', () => {
  it('is true for a cmd-based skill', async () => {
    await createTempSkill(dir, 'coding-dirs-update', '---\ncmd: "python update_coding_dirs.py"\n---\nUpdates the pinned directory list.');
    assert.equal(await isCmdBasedTarget('coding-dirs-update'), true);
  });

  it('is false for a prompt-based skill', async () => {
    await createTempSkill(dir, 'reminders', 'Process reminders.');
    assert.equal(await isCmdBasedTarget('reminders'), false);
  });

  it('is false (not a crash) for a skill name that does not resolve', async () => {
    assert.equal(await isCmdBasedTarget('does-not-exist'), false);
  });
});
