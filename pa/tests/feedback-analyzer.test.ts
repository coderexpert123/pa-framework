import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { buildFeedbackPrompt, analyzeFeedbackPatterns } from '../src/feedback-analyzer.js';
import { createTempPaHome, createTempSkill, cleanup } from './helpers.js';
import type { DraftProposal } from '../src/types.js';

function makeRunner(proposals: Array<Record<string, unknown>>) {
  return async (_prompt: string, _opts: any) => ({
    result: { success: true, output: JSON.stringify(proposals), exitCode: 0 as number | null },
    worker: 'mock',
  });
}

async function writeFixtureConversations(dir: string, turns: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(
    join(dir, 'conversation-history.jsonl'),
    turns.map((t) => JSON.stringify(t)).join('\n'),
    'utf8'
  );
}

describe('buildFeedbackPrompt', () => {
  it('lists existing skills and instructs the LLM to require an exact target_skill match', () => {
    const prompt = buildFeedbackPrompt([], ['daily-mail-brief', 'reminders'], []);
    assert.match(prompt, /daily-mail-brief/);
    assert.match(prompt, /reminders/);
    assert.match(prompt, /target_skill/);
    assert.match(prompt, /out of scope/i);
  });
});

describe('analyzeFeedbackPatterns', () => {
  let dir: string;

  before(async () => {
    dir = await createTempPaHome();
    await createTempSkill(
      dir,
      'daily-mail-brief',
      ['---', 'cron: "30 13 * * *"', '---', '', 'Send the daily brief every morning.'].join('\n')
    );
    await writeFixtureConversations(dir, [
      { role: 'user', text: 'the brief keeps including stale entries, stop that', timestamp: new Date().toISOString(), message_id: '1' },
      { role: 'user', text: 'again — stale entries in the brief, please fix', timestamp: new Date().toISOString(), message_id: '2' },
    ]);
  });

  after(async () => {
    await cleanup(dir);
  });

  it('reconstructs the full prompt from the target skill\'s real content, not the LLM-authored body', async () => {
    const runner = makeRunner([
      {
        name: 'daily-mail-brief-fix',
        reason: 'User repeatedly asked to exclude stale entries',
        source_message_ids: ['1', '2'],
        target_skill: 'daily-mail-brief',
        frontmatter: {},
        prompt: 'Always exclude entries older than the current day.',
      },
    ]);

    const proposals = await analyzeFeedbackPatterns(14, runner as any);
    assert.equal(proposals.length, 1);
    const [proposal] = proposals;
    assert.equal(proposal.target_skill, 'daily-mail-brief');
    // The reconstructed prompt contains the TARGET's real original content...
    assert.match(proposal.prompt, /Send the daily brief every morning/);
    // ...plus the short instruction, appended in code.
    assert.match(proposal.prompt, /Always exclude entries older than the current day/);
  });

  it('drops a proposal whose target_skill does not resolve to a real skill', async () => {
    const runner = makeRunner([
      {
        name: 'typo-d-skill-fix',
        reason: 'r',
        source_message_ids: [],
        target_skill: 'this-skill-does-not-exist',
        frontmatter: {},
        prompt: 'Some instruction.',
      },
    ]);

    const proposals = await analyzeFeedbackPatterns(14, runner as any);
    assert.equal(proposals.length, 0);
  });

  it('drops a proposal with no target_skill at all (this analyzer never produces new-skill proposals)', async () => {
    const runner = makeRunner([
      { name: 'no-target', reason: 'r', source_message_ids: [], frontmatter: {}, prompt: 'Some instruction.' },
    ]);

    const proposals = await analyzeFeedbackPatterns(14, runner as any);
    assert.equal(proposals.length, 0);
  });

  it('returns [] without calling the LLM when there are no conversation turns', async () => {
    // Reuses the same temp PA_HOME but points at a conversation-history.jsonl-free window
    // by asking for 0 days back — readRecentConversations still reads the file but the
    // cutoff excludes everything, so turns.length is 0 and the short-circuit fires.
    let called = false;
    const runner = async (_p: string, _o: any) => {
      called = true;
      return { result: { success: true, output: '[]', exitCode: 0 as number | null }, worker: 'mock' };
    };
    const proposals = await analyzeFeedbackPatterns(0, runner as any);
    assert.deepEqual(proposals, []);
    assert.equal(called, false);
  });
});
