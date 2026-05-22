import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { buildAnalysisPrompt, parseProposalResponse, readRecentConversations } from '../src/analyzer.js';
import type { ConversationTurn } from '../src/analyzer.js';
import { createTempPaHome, cleanup } from './helpers.js';

function makeTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    role: 'user',
    text: 'Check my unread emails',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('analyzer', () => {
  let dir: string;

  before(async () => {
    dir = await createTempPaHome();
  });

  after(async () => {
    await cleanup(dir);
  });

  describe('buildAnalysisPrompt', () => {
    it('includes conversation content', () => {
      const turns = [
        makeTurn({ text: 'Summarize my emails', timestamp: '2026-04-01T09:00:00.000Z' }),
        makeTurn({ role: 'assistant', text: 'Here is your summary...', timestamp: '2026-04-01T09:01:00.000Z' }),
      ];
      const prompt = buildAnalysisPrompt(turns, [], []);
      assert.match(prompt, /Summarize my emails/);
      assert.match(prompt, /Here is your summary/);
    });

    it('groups turns by date', () => {
      const turns = [
        makeTurn({ timestamp: '2026-04-01T09:00:00.000Z', text: 'Day one message' }),
        makeTurn({ timestamp: '2026-04-02T09:00:00.000Z', text: 'Day two message' }),
      ];
      const prompt = buildAnalysisPrompt(turns, [], []);
      assert.match(prompt, /2026-04-01/);
      assert.match(prompt, /2026-04-02/);
      assert.match(prompt, /Day one message/);
      assert.match(prompt, /Day two message/);
    });

    it('lists existing skills in exclusion list', () => {
      const prompt = buildAnalysisPrompt([], ['daily-mail-brief', 'fitness-sync'], []);
      assert.match(prompt, /daily-mail-brief/);
      assert.match(prompt, /fitness-sync/);
    });

    it('lists existing drafts in exclusion list', () => {
      const prompt = buildAnalysisPrompt([], [], ['draft-skill-one']);
      assert.match(prompt, /draft-skill-one/);
    });

    it('instructs LLM to require 3+ occurrences across different days', () => {
      const prompt = buildAnalysisPrompt([], [], []);
      assert.match(prompt, /3 or more times/);
      assert.match(prompt, /DIFFERENT days/);
    });

    it('returns no conversations message when turns is empty', () => {
      const prompt = buildAnalysisPrompt([], [], []);
      assert.match(prompt, /no conversations in this period/);
    });
  });

  describe('parseProposalResponse', () => {
    it('parses a valid JSON array', () => {
      const raw = JSON.stringify([
        {
          name: 'email-summary',
          reason: 'User asks for email summary repeatedly',
          source_message_ids: ['1', '2'],
          frontmatter: { timeout: 300 },
          prompt: 'Summarize unread emails.',
        },
      ]);
      const proposals = parseProposalResponse(raw);
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0].name, 'email-summary');
      assert.equal(proposals[0].prompt, 'Summarize unread emails.');
    });

    it('strips markdown fences before parsing', () => {
      const raw = '```json\n[{"name":"my-skill","reason":"r","source_message_ids":[],"frontmatter":{},"prompt":"Do stuff."}]\n```';
      const proposals = parseProposalResponse(raw);
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0].name, 'my-skill');
    });

    it('returns empty array on garbage input', () => {
      assert.deepEqual(parseProposalResponse('not json at all'), []);
      assert.deepEqual(parseProposalResponse(''), []);
      assert.deepEqual(parseProposalResponse('{}'), []); // not an array
    });

    it('skips entries missing required fields', () => {
      const raw = JSON.stringify([
        { name: 'valid', reason: 'ok', source_message_ids: [], frontmatter: {}, prompt: 'Do it.' },
        { name: 'missing-prompt', reason: 'ok', source_message_ids: [] }, // no prompt
        { reason: 'no name', source_message_ids: [], frontmatter: {}, prompt: 'Do it.' }, // no name
        { name: '', reason: 'empty name', source_message_ids: [], frontmatter: {}, prompt: 'Do it.' }, // empty name
      ]);
      const proposals = parseProposalResponse(raw);
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0].name, 'valid');
    });

    it('rejects skill names with invalid characters', () => {
      const raw = JSON.stringify([
        { name: 'valid-skill', reason: 'r', source_message_ids: [], frontmatter: {}, prompt: 'p.' },
        { name: 'bad skill!', reason: 'r', source_message_ids: [], frontmatter: {}, prompt: 'p.' },
        { name: '../escape', reason: 'r', source_message_ids: [], frontmatter: {}, prompt: 'p.' },
      ]);
      const proposals = parseProposalResponse(raw);
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0].name, 'valid-skill');
    });

    it('returns empty array for empty JSON array', () => {
      assert.deepEqual(parseProposalResponse('[]'), []);
    });
  });

  describe('readRecentConversations', () => {
    it('reads and filters turns by date range', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

      const lines = [
        JSON.stringify({ role: 'user', text: 'Recent', timestamp: now.toISOString() }),
        JSON.stringify({ role: 'user', text: 'Yesterday', timestamp: yesterday.toISOString() }),
        JSON.stringify({ role: 'user', text: 'Old', timestamp: tenDaysAgo.toISOString() }),
      ].join('\n');

      await writeFile(join(dir, 'conversation-history.jsonl'), lines, 'utf8');

      const recent = await readRecentConversations(3); // last 3 days
      const texts = recent.map((t) => t.text);
      assert.ok(texts.includes('Recent'));
      assert.ok(texts.includes('Yesterday'));
      assert.ok(!texts.includes('Old'));
    });

    it('returns empty array when file does not exist', async () => {
      const origHome = process.env.PA_HOME;
      try {
        process.env.PA_HOME = join(dir, 'no-such-subdir');
        const result = await readRecentConversations(7);
        assert.deepEqual(result, []);
      } finally {
        process.env.PA_HOME = origHome;
      }
    });

    it('skips malformed lines', async () => {
      const lines = [
        'not json at all',
        JSON.stringify({ role: 'user', text: 'Valid', timestamp: new Date().toISOString() }),
      ].join('\n');

      await writeFile(join(dir, 'conversation-history.jsonl'), lines, 'utf8');

      const turns = await readRecentConversations(1);
      assert.equal(turns.length, 1);
      assert.equal(turns[0].text, 'Valid');
    });
  });
});
