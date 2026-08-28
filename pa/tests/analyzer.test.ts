import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import {
  buildKeyingPrompt,
  parseKeyingResponse,
  buildProposalPrompt,
  parseProposalResponse,
  readRecentConversations,
  readTurnsSince,
} from '../src/analyzer.js';
import type { ConversationTurn, EvidenceTurn } from '../src/analyzer.js';
import { ANALYZER_TURN_CHARS } from '../src/lib/skill-candidates.js';
import type { SkillCandidate } from '../src/lib/skill-candidates.js';
import { createTempPaHome, cleanup } from './helpers.js';

function makeTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    role: 'user',
    text: 'Check my unread emails',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeEvidenceTurn(overrides: Partial<EvidenceTurn> = {}): EvidenceTurn {
  return {
    role: 'user',
    text: 'Check my unread emails',
    timestamp: '2026-08-01T09:00:00.000Z',
    message_id: '1',
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    key: 'email-summary',
    intent: 'summarize unread emails',
    count: 3,
    days: ['2026-07-30', '2026-07-31', '2026-08-01'],
    turn_refs: [],
    first_seen: '2026-07-30T09:00:00.000Z',
    last_seen: '2026-08-01T09:00:00.000Z',
    origin: 'analyzer',
    proposed_at: null,
    draft_id: null,
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

  describe('buildKeyingPrompt', () => {
    it('renders full turn text, NOT cut at 300 chars', () => {
      const longText = 'x'.repeat(1200);
      const turns = [makeEvidenceTurn({ text: longText })];
      const prompt = buildKeyingPrompt(turns, [], []);
      assert.match(prompt, new RegExp('x'.repeat(1200)));
    });

    it('cuts a turn over ANALYZER_TURN_CHARS at exactly that cap', () => {
      const longText = 'y'.repeat(5000);
      const turns = [makeEvidenceTurn({ text: longText })];
      const prompt = buildKeyingPrompt(turns, [], []);
      assert.match(prompt, new RegExp('y'.repeat(ANALYZER_TURN_CHARS)));
      assert.ok(!prompt.includes('y'.repeat(ANALYZER_TURN_CHARS + 1)));
    });

    it('omits assistant turns from the prompt even when handed a mixed-role list', () => {
      const turns = [
        makeEvidenceTurn({ role: 'user', text: 'user text marker', message_id: '1' }),
        makeEvidenceTurn({ role: 'assistant', text: 'assistant text marker', message_id: '2' }),
      ];
      const prompt = buildKeyingPrompt(turns, [], []);
      assert.match(prompt, /user text marker/);
      assert.ok(!prompt.includes('assistant text marker'));
    });

    it('lists existing keys and intents', () => {
      const prompt = buildKeyingPrompt([], [{ key: 'daily-mail-brief', intent: 'send the daily brief' }], []);
      assert.match(prompt, /daily-mail-brief/);
      assert.match(prompt, /send the daily brief/);
    });

    it('lists existing skill names and descriptions', () => {
      const prompt = buildKeyingPrompt([], [], [{ name: 'fitness-sync', description: 'syncs COROS workouts' }]);
      assert.match(prompt, /fitness-sync/);
      assert.match(prompt, /syncs COROS workouts/);
    });

    it('states the verbatim key-reuse-is-default sentence', () => {
      const prompt = buildKeyingPrompt([], [], []);
      assert.match(prompt, /Reusing an existing key is the default\. Only mint a new key when no existing key describes the same intent\./);
    });
  });

  describe('parseKeyingResponse', () => {
    it('parses a valid JSON array', () => {
      const raw = JSON.stringify([{ message_id: '1', key: 'email-summary', intent: 'summarize emails' }]);
      const results = parseKeyingResponse(raw);
      assert.equal(results.length, 1);
      assert.equal(results[0].message_id, '1');
      assert.equal(results[0].key, 'email-summary');
      assert.equal(results[0].intent, 'summarize emails');
    });

    it('strips markdown fences before parsing', () => {
      const raw = '```json\n[{"message_id":"1","key":"k","intent":"i"}]\n```';
      const results = parseKeyingResponse(raw);
      assert.equal(results.length, 1);
      assert.equal(results[0].key, 'k');
    });

    it('returns empty array on garbage input', () => {
      assert.deepEqual(parseKeyingResponse('not json at all'), []);
      assert.deepEqual(parseKeyingResponse(''), []);
      assert.deepEqual(parseKeyingResponse('{}'), []); // not an array
    });

    it('preserves an explicit null key', () => {
      const raw = JSON.stringify([{ message_id: '1', key: null, intent: 'not actionable' }]);
      const results = parseKeyingResponse(raw);
      assert.equal(results.length, 1);
      assert.equal(results[0].key, null);
    });

    it('coerces a missing or empty key to null', () => {
      const raw = JSON.stringify([
        { message_id: '1', intent: 'no key field' },
        { message_id: '2', key: '', intent: 'empty key' },
      ]);
      const results = parseKeyingResponse(raw);
      assert.equal(results.length, 2);
      assert.equal(results[0].key, null);
      assert.equal(results[1].key, null);
    });

    it('drops entries with a non-string message_id', () => {
      const raw = JSON.stringify([
        { message_id: '1', key: 'k', intent: 'i' },
        { message_id: 2, key: 'k', intent: 'i' }, // number, not string
        { key: 'k', intent: 'i' }, // missing entirely
      ]);
      const results = parseKeyingResponse(raw);
      assert.equal(results.length, 1);
      assert.equal(results[0].message_id, '1');
    });
  });

  describe('buildProposalPrompt', () => {
    it('renders "no trace recorded" when the occurrence has no trace', () => {
      const candidate = makeCandidate();
      const prompt = buildProposalPrompt(candidate, [{ turn: makeEvidenceTurn() }], [], []);
      assert.match(prompt, /no trace recorded/);
    });

    it('renders the tool/command summary from WP-A\'s real trace shape (tool_calls[], not tools)', () => {
      const candidate = makeCandidate();
      // Real TurnTraceToolCall[] shape (spec §3.1/A5, corrected 2026-08-24):
      // { n, name, arg, ok, ms? } — optional fields omitted when absent.
      const trace = {
        v: 1,
        run_id: 'abc-123',
        tool_calls: [
          { n: 1, name: 'view_file', arg: 'a.ts', ok: true },
          { n: 2, name: 'run_command', arg: 'echo ok', ok: true, ms: 12 },
        ],
        commands: ['echo ok'],
        files: ['a.ts'],
        errors: [],
        outcome: 'ok',
        worker: 'agy',
        parsed: true,
        truncated: false,
      };
      const prompt = buildProposalPrompt(candidate, [{ turn: makeEvidenceTurn(), trace }], [], []);
      assert.match(prompt, /Trace for this run \(run_id abc-123\):/);
      assert.match(prompt, /tools=run_command×1, view_file×1/); // count desc, then name asc — both count 1 so alphabetical
      assert.match(prompt, /commands=echo ok/);
      assert.match(prompt, /files=a\.ts/);
      assert.match(prompt, /outcome=ok/);
    });

    it('aggregates repeated tool_calls by name, ordered count desc then name asc', () => {
      const candidate = makeCandidate();
      const trace = {
        v: 1,
        run_id: 'agg-run',
        tool_calls: [
          { n: 1, name: 'view_file', arg: 'a.ts', ok: true },
          { n: 2, name: 'run_command', arg: 'echo a', ok: true },
          { n: 3, name: 'view_file', arg: 'b.ts', ok: true },
          { n: 4, name: 'run_command', arg: 'echo b', ok: true },
          { n: 5, name: 'view_file', arg: 'c.ts', ok: false },
          { n: 6, name: 'edit_file', arg: 'd.ts', ok: true },
        ],
        commands: [],
        files: [],
        outcome: 'ok',
      };
      const prompt = buildProposalPrompt(candidate, [{ turn: makeEvidenceTurn(), trace }], [], []);
      // view_file×3 (highest count) first, then run_command×2, then edit_file×1 (name asc among count-1 ties would apply, but only one here)
      assert.match(prompt, /tools=view_file×3, run_command×2, edit_file×1/);
    });

    it('degrades gracefully when the trace object is present but missing/wrong-shaped fields (never throws, never crashes on unknown WP-A payloads)', () => {
      const candidate = makeCandidate();
      // Degenerate trace: no tool_calls at all, non-array commands/files, no
      // outcome, no run_id — lookupTraceByUpdate never throws per contract,
      // but a returned TraceLine can still be missing everything but run_id.
      const trace = { run_id: 'bare-run' } as Record<string, unknown>;
      const prompt = buildProposalPrompt(candidate, [{ turn: makeEvidenceTurn(), trace }], [], []);
      assert.match(prompt, /Trace for this run \(run_id bare-run\):/);
      assert.match(prompt, /tools=none/);
      assert.match(prompt, /commands=none/);
      assert.match(prompt, /files=none/);
      assert.match(prompt, /outcome=unknown/);
    });

    it('falls back to the occurrence turn\'s run_id when the trace object omits run_id', () => {
      const candidate = makeCandidate();
      const trace = { tool_calls: [{ n: 1, name: 'view_file', arg: 'a.ts', ok: true }] };
      const prompt = buildProposalPrompt(candidate, [{ turn: makeEvidenceTurn({ run_id: 'turn-run-id' }), trace }], [], []);
      assert.match(prompt, /Trace for this run \(run_id turn-run-id\):/);
    });

    it('labels the assistant reply as context only, NOT evidence', () => {
      const candidate = makeCandidate();
      const prompt = buildProposalPrompt(candidate, [{ turn: makeEvidenceTurn(), assistantReply: 'Here are your emails.' }], [], []);
      assert.match(prompt, /Assistant reply \(context only, NOT evidence\): Here are your emails\./);
    });

    it('caps occurrences at 5', () => {
      const candidate = makeCandidate();
      const occurrences = Array.from({ length: 8 }, (_, i) =>
        ({ turn: makeEvidenceTurn({ text: `occurrence-marker-${i}`, message_id: String(i) }) }));
      const prompt = buildProposalPrompt(candidate, occurrences, [], []);
      for (let i = 0; i < 5; i++) assert.match(prompt, new RegExp(`occurrence-marker-${i}`));
      for (let i = 5; i < 8; i++) assert.ok(!prompt.includes(`occurrence-marker-${i}`));
    });

    it('renders today\'s DraftProposal JSON response contract', () => {
      const candidate = makeCandidate();
      const prompt = buildProposalPrompt(candidate, [{ turn: makeEvidenceTurn() }], ['existing-skill'], ['existing-draft']);
      assert.match(prompt, /"source_message_ids": \["id1", "id2"\]/);
      assert.match(prompt, /"trigger_description": "When to fire this skill automatically"/);
      assert.match(prompt, /existing-skill/);
      assert.match(prompt, /existing-draft/);
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

    it('parses target_skill as a top-level field, not nested under frontmatter', () => {
      const raw = JSON.stringify([
        {
          name: 'reminders-fix',
          reason: 'r',
          source_message_ids: [],
          target_skill: 'reminders',
          frontmatter: { timeout: 300 },
          prompt: 'Fixed prompt.',
        },
      ]);
      const proposals = parseProposalResponse(raw);
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0].target_skill, 'reminders');
      assert.equal((proposals[0].frontmatter as any).target_skill, undefined);
    });

    it('omits target_skill (undefined, not empty string) when absent', () => {
      const raw = JSON.stringify([
        { name: 'new-skill', reason: 'r', source_message_ids: [], frontmatter: {}, prompt: 'p.' },
      ]);
      const proposals = parseProposalResponse(raw);
      assert.equal(proposals[0].target_skill, undefined);
    });

    it('treats an explicit null target_skill the same as omitted (valid, no target)', () => {
      const raw = JSON.stringify([
        { name: 'diagnostic-skill', reason: 'r', source_message_ids: [], target_skill: null, frontmatter: {}, prompt: 'p.' },
      ]);
      const proposals = parseProposalResponse(raw);
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0].target_skill, undefined);
    });

    it('drops the whole proposal when target_skill is present but malformed', () => {
      const raw = JSON.stringify([
        { name: 'valid', reason: 'r', source_message_ids: [], target_skill: 'bad name!', frontmatter: {}, prompt: 'p.' },
      ]);
      const proposals = parseProposalResponse(raw);
      assert.equal(proposals.length, 0);
    });

    it('returns empty array for empty JSON array', () => {
      assert.deepEqual(parseProposalResponse('[]'), []);
    });

    it('parses code_target as a top-level field when it is a safe relative path', () => {
      const raw = JSON.stringify([
        {
          name: 'daily-mail-brief-fix', reason: 'r', source_message_ids: [],
          target_skill: 'daily-mail-brief', code_target: 'projects/daily-mail-brief/scripts/run_brief.py',
          frontmatter: {}, prompt: 'p.',
        },
      ]);
      const proposals = parseProposalResponse(raw);
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0].code_target, 'projects/daily-mail-brief/scripts/run_brief.py');
    });

    it('omits code_target (undefined) when absent or null', () => {
      const raw = JSON.stringify([
        { name: 'a', reason: 'r', source_message_ids: [], frontmatter: {}, prompt: 'p.' },
        { name: 'b', reason: 'r', source_message_ids: [], code_target: null, frontmatter: {}, prompt: 'p.' },
      ]);
      const proposals = parseProposalResponse(raw);
      assert.equal(proposals.length, 2);
      assert.equal(proposals[0].code_target, undefined);
      assert.equal(proposals[1].code_target, undefined);
    });

    it('drops the whole proposal when code_target attempts path traversal or an absolute path', () => {
      const raw = JSON.stringify([
        { name: 'a', reason: 'r', source_message_ids: [], code_target: '../../etc/passwd', frontmatter: {}, prompt: 'p.' },
        { name: 'b', reason: 'r', source_message_ids: [], code_target: '/etc/passwd', frontmatter: {}, prompt: 'p.' },
        { name: 'c', reason: 'r', source_message_ids: [], code_target: 'C:/Windows/System32/x', frontmatter: {}, prompt: 'p.' },
        { name: 'd', reason: 'r', source_message_ids: [], code_target: 'projects/ok/file.py', frontmatter: {}, prompt: 'p.' },
      ]);
      const proposals = parseProposalResponse(raw);
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0].name, 'd');
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

  describe('readTurnsSince', () => {
    it('returns only user turns', async () => {
      const rtsDir = dir + '-rts-roles';
      const origHome = process.env.PA_HOME;
      try {
        const { mkdir } = await import('fs/promises');
        await mkdir(rtsDir + '/skills', { recursive: true });
        await mkdir(rtsDir + '/skill-drafts', { recursive: true });
        await mkdir(rtsDir + '/logs', { recursive: true });
        process.env.PA_HOME = rtsDir;

        const lines = [
          JSON.stringify({ role: 'user', text: 'User turn', timestamp: new Date().toISOString() }),
          JSON.stringify({ role: 'assistant', text: 'Assistant turn', timestamp: new Date().toISOString() }),
        ].join('\n');
        await writeFile(join(rtsDir, 'conversation-history.jsonl'), lines, 'utf8');

        const turns = await readTurnsSince(null, 7);
        assert.equal(turns.length, 1);
        assert.equal(turns[0].role, 'user');
      } finally {
        process.env.PA_HOME = origHome;
      }
    });

    it('respects the watermark strictly (> not >=)', async () => {
      const rtsDir = dir + '-rts-watermark';
      const origHome = process.env.PA_HOME;
      try {
        const { mkdir } = await import('fs/promises');
        await mkdir(rtsDir + '/skills', { recursive: true });
        await mkdir(rtsDir + '/skill-drafts', { recursive: true });
        await mkdir(rtsDir + '/logs', { recursive: true });
        process.env.PA_HOME = rtsDir;

        const watermark = '2026-08-01T12:00:00.000Z';
        const lines = [
          JSON.stringify({ role: 'user', text: 'At watermark', timestamp: watermark }),
          JSON.stringify({ role: 'user', text: 'After watermark', timestamp: '2026-08-01T12:00:00.001Z' }),
          JSON.stringify({ role: 'user', text: 'Before watermark', timestamp: '2026-08-01T11:59:59.999Z' }),
        ].join('\n');
        await writeFile(join(rtsDir, 'conversation-history.jsonl'), lines, 'utf8');

        const turns = await readTurnsSince(watermark, 30);
        const texts = turns.map((t) => t.text);
        assert.deepEqual(texts, ['After watermark']);
      } finally {
        process.env.PA_HOME = origHome;
      }
    });

    it('falls back to the day window when the watermark is null', async () => {
      const rtsDir = dir + '-rts-window';
      const origHome = process.env.PA_HOME;
      try {
        const { mkdir } = await import('fs/promises');
        await mkdir(rtsDir + '/skills', { recursive: true });
        await mkdir(rtsDir + '/skill-drafts', { recursive: true });
        await mkdir(rtsDir + '/logs', { recursive: true });
        process.env.PA_HOME = rtsDir;

        const now = new Date();
        const recent = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const old = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
        const lines = [
          JSON.stringify({ role: 'user', text: 'Recent', timestamp: recent.toISOString() }),
          JSON.stringify({ role: 'user', text: 'Old', timestamp: old.toISOString() }),
        ].join('\n');
        await writeFile(join(rtsDir, 'conversation-history.jsonl'), lines, 'utf8');

        const turns = await readTurnsSince(null, 3);
        const texts = turns.map((t) => t.text);
        assert.ok(texts.includes('Recent'));
        assert.ok(!texts.includes('Old'));
      } finally {
        process.env.PA_HOME = origHome;
      }
    });
  });
});
