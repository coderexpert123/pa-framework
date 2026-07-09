import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { isCriticalChange, hasRealSideEffects, applyFix, validateSkillFix } from '../src/validator.js';
import { createTempPaHome, createTempSkill, createTempDraft, cleanup } from './helpers.js';
import { computeFingerprint } from '../src/drafts.js';
import type { DraftMeta, DraftProposal } from '../src/types.js';

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

describe('isCriticalChange', () => {
  it('is critical when a new-skill proposal names a protected skill (self-improver)', async () => {
    const critical = await isCriticalChange(makeProposal({ name: 'self-improver' }));
    assert.equal(critical, true);
  });

  it('is critical when a fix proposal targets the protected skill (self-improver)', async () => {
    const critical = await isCriticalChange(
      makeProposal({ name: 'self-improver-fix', target_skill: 'self-improver' })
    );
    assert.equal(critical, true);
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
});
