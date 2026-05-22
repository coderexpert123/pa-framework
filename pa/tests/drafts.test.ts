import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import {
  saveDraft,
  loadDraft,
  listDrafts,
  approveDraft,
  rejectDraft,
  isDuplicate,
  cleanRejected,
  computeFingerprint,
} from '../src/drafts.js';
import { createTempPaHome, createTempDraft, createTempSkill, cleanup } from './helpers.js';
import type { DraftMeta, DraftProposal } from '../src/types.js';

function makeProposal(overrides: Partial<DraftProposal> = {}): DraftProposal {
  return {
    name: 'test-skill',
    reason: 'Repeated pattern detected',
    source_message_ids: ['101', '202'],
    frontmatter: { timeout: 300 },
    prompt: 'Summarize unread emails every morning.',
    ...overrides,
  };
}

function makeMeta(overrides: Partial<DraftMeta> = {}): DraftMeta {
  return {
    proposed_at: new Date().toISOString(),
    reason: 'Repeated pattern',
    source_turns: ['101'],
    status: 'pending',
    fingerprint: computeFingerprint('test-skill', 'Summarize unread emails every morning.'),
    source_type: 'conversation',
    ...overrides,
  };
}

describe('drafts', () => {
  let dir: string;

  before(async () => {
    dir = await createTempPaHome();
  });

  after(async () => {
    await cleanup(dir);
  });

  describe('saveDraft', () => {
    it('creates skill.md with frontmatter and prompt', async () => {
      const proposal = makeProposal({ frontmatter: { timeout: 300, cron: '0 8 * * *' } });
      await saveDraft(proposal, 'conversation');

      const content = await readFile(join(dir, 'skill-drafts', 'test-skill', 'skill.md'), 'utf8');
      assert.match(content, /---/);
      assert.match(content, /timeout: 300/);
      assert.match(content, /cron: 0 8 \* \* \*/);
      assert.match(content, /Summarize unread emails/);
    });

    it('creates draft.meta.json with correct fields', async () => {
      const proposal = makeProposal();
      await saveDraft(proposal, 'failure');

      const raw = await readFile(join(dir, 'skill-drafts', 'test-skill', 'draft.meta.json'), 'utf8');
      const meta: DraftMeta = JSON.parse(raw);
      assert.equal(meta.status, 'pending');
      assert.equal(meta.source_type, 'failure');
      assert.equal(meta.reason, 'Repeated pattern detected');
      assert.ok(meta.fingerprint.length > 0);
      assert.ok(meta.proposed_at);
    });

    it('creates skill.md without frontmatter block when no frontmatter fields', async () => {
      const proposal = makeProposal({ name: 'minimal-skill', frontmatter: {} });
      await saveDraft(proposal, 'conversation');

      const content = await readFile(join(dir, 'skill-drafts', 'minimal-skill', 'skill.md'), 'utf8');
      assert.doesNotMatch(content, /---/);
      assert.match(content, /Summarize unread emails/);
    });

    it('round-trips worker, inject_triggers, and telegram_output through save→load', async () => {
      const proposal = makeProposal({
        name: 'full-fm-skill',
        frontmatter: {
          worker: 'claude',
          inject_triggers: true,
          telegram_output: {
            chat_id: '-1001234567890',
            thread_id: 29,
            token_secret: 'TELEGRAM_BOT_TOKEN',
          },
        },
      });
      await saveDraft(proposal, 'conversation');
      const { skill } = await loadDraft('full-fm-skill');

      assert.equal(skill.frontmatter.worker, 'claude');
      assert.equal(skill.frontmatter.inject_triggers, true);
      assert.deepEqual(skill.frontmatter.telegram_output, {
        chat_id: '-1001234567890',
        thread_id: 29,
        token_secret: 'TELEGRAM_BOT_TOKEN',
      });
    });
  });

  describe('loadDraft', () => {
    it('parses skill.md and draft.meta.json', async () => {
      await createTempDraft(dir, 'load-test', 'Do something useful.', makeMeta({ reason: 'Test reason' }));

      const { skill, meta } = await loadDraft('load-test');
      assert.equal(skill.name, 'load-test');
      assert.equal(skill.prompt, 'Do something useful.');
      assert.equal(meta.reason, 'Test reason');
      assert.equal(meta.status, 'pending');
    });

    it('parses frontmatter from skill.md', async () => {
      const content = `---\ntimeout: 120\ncron: "0 9 * * *"\n---\n\nRun the thing.`;
      await createTempDraft(dir, 'fm-test', content, makeMeta({ reason: 'fm test' }));

      const { skill } = await loadDraft('fm-test');
      assert.equal(skill.frontmatter.timeout, 120);
      assert.equal(skill.frontmatter.cron, '0 9 * * *');
      assert.equal(skill.prompt, 'Run the thing.');
    });

    it('throws for nonexistent draft', async () => {
      await assert.rejects(() => loadDraft('does-not-exist'), /not found/);
    });
  });

  describe('listDrafts', () => {
    it('returns all drafts', async () => {
      await createTempDraft(dir, 'draft-a', 'Prompt A', makeMeta({ status: 'pending' }));
      await createTempDraft(dir, 'draft-b', 'Prompt B', makeMeta({ status: 'rejected' }));

      const drafts = await listDrafts();
      const names = drafts.map((d) => d.skill.name);
      assert.ok(names.includes('draft-a'));
      assert.ok(names.includes('draft-b'));
    });

    it('filters by status', async () => {
      await createTempDraft(dir, 'filter-pending', 'P', makeMeta({ status: 'pending' }));
      await createTempDraft(dir, 'filter-rejected', 'R', makeMeta({ status: 'rejected' }));

      const pending = await listDrafts('pending');
      assert.ok(pending.every((d) => d.meta.status === 'pending'));

      const rejected = await listDrafts('rejected');
      assert.ok(rejected.every((d) => d.meta.status === 'rejected'));
    });

    it('returns empty array when drafts dir is missing', async () => {
      const origHome = process.env.PA_HOME;
      process.env.PA_HOME = '/nonexistent-path-xyz';
      const result = await listDrafts();
      assert.deepEqual(result, []);
      process.env.PA_HOME = origHome;
    });
  });

  describe('approveDraft', () => {
    it('copies skill.md to skills dir and updates meta to approved', async () => {
      await createTempDraft(dir, 'approve-me', 'Do the thing.', makeMeta());

      await approveDraft('approve-me');

      // Skill should be in skills dir
      const skillContent = await readFile(join(dir, 'skills', 'approve-me', 'skill.md'), 'utf8');
      assert.match(skillContent, /Do the thing/);

      // Meta should be updated
      const meta: DraftMeta = JSON.parse(
        await readFile(join(dir, 'skill-drafts', 'approve-me', 'draft.meta.json'), 'utf8')
      );
      assert.equal(meta.status, 'approved');
      assert.ok(meta.reviewed_at);
    });

    it('throws if skill already exists in skills dir', async () => {
      await createTempSkill(dir, 'existing-skill', 'Already here.');
      await createTempDraft(dir, 'existing-skill', 'Duplicate.', makeMeta());

      await assert.rejects(() => approveDraft('existing-skill'), /already exists/);
    });
  });

  describe('rejectDraft', () => {
    it('sets status to rejected and keeps files', async () => {
      await createTempDraft(dir, 'reject-me', 'Prompt.', makeMeta());

      await rejectDraft('reject-me');

      const meta: DraftMeta = JSON.parse(
        await readFile(join(dir, 'skill-drafts', 'reject-me', 'draft.meta.json'), 'utf8')
      );
      assert.equal(meta.status, 'rejected');
      assert.ok(meta.reviewed_at);

      // skill.md still exists
      await assert.doesNotReject(() => stat(join(dir, 'skill-drafts', 'reject-me', 'skill.md')));
    });
  });

  describe('computeFingerprint', () => {
    it('is deterministic', () => {
      const a = computeFingerprint('my-skill', 'Some prompt text');
      const b = computeFingerprint('my-skill', 'Some prompt text');
      assert.equal(a, b);
    });

    it('same prompt with different names gives same fingerprint', () => {
      const a = computeFingerprint('skill-a', 'Some prompt text');
      const b = computeFingerprint('skill-b', 'Some prompt text');
      assert.equal(a, b);
    });

    it('differs for different inputs', () => {
      const a = computeFingerprint('skill-a', 'Prompt A');
      const b = computeFingerprint('skill-b', 'Prompt B');
      assert.notEqual(a, b);
    });
  });

  describe('isDuplicate', () => {
    it('detects duplicate by skill name in active skills', async () => {
      await createTempSkill(dir, 'active-skill', 'Active prompt.');
      const proposal = makeProposal({ name: 'active-skill', prompt: 'Different prompt.' });
      assert.ok(await isDuplicate(proposal));
    });

    it('detects duplicate by name in existing drafts (even with different prompt)', async () => {
      const fingerprint = computeFingerprint('draft-name-check', 'Original prompt.');
      await createTempDraft(dir, 'draft-name-check', 'Original prompt.', makeMeta({ fingerprint }));

      // Different prompt but same name — should be caught by name check
      const proposal = makeProposal({ name: 'draft-name-check', prompt: 'Completely different prompt.' });
      assert.ok(await isDuplicate(proposal));
    });

    it('detects duplicate by fingerprint in existing drafts', async () => {
      const prompt = 'Unique prompt for dedup test.';
      const fingerprint = computeFingerprint('dedup-skill', prompt);
      await createTempDraft(dir, 'dedup-skill', prompt, makeMeta({ fingerprint }));

      const proposal = makeProposal({ name: 'dedup-skill-2', prompt });
      assert.ok(await isDuplicate(proposal));
    });

    it('returns false for genuinely new proposal', async () => {
      const proposal = makeProposal({ name: 'brand-new-xyz', prompt: 'Never seen before prompt xyzabc.' });
      assert.equal(await isDuplicate(proposal), false);
    });
  });

  describe('cleanRejected', () => {
    it('removes only rejected drafts and returns count', async () => {
      await createTempDraft(dir, 'clean-rejected', 'R.', makeMeta({ status: 'rejected' }));
      await createTempDraft(dir, 'clean-pending', 'P.', makeMeta({ status: 'pending' }));

      const count = await cleanRejected();
      assert.ok(count >= 1);

      // Rejected draft should be gone
      await assert.rejects(() => loadDraft('clean-rejected'));

      // Pending draft should still exist
      await assert.doesNotReject(() => loadDraft('clean-pending'));
    });
  });
});
