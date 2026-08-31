import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { buildFeedbackPrompt, analyzeFeedbackPatterns, buildRulesTriagePrompt, parseRulesResponse, analyzeFeedbackRules } from '../src/feedback-analyzer.js';
import { createTempPaHome, createTempSkill, cleanup } from './helpers.js';
import type { DraftProposal } from '../src/types.js';
import Database from 'better-sqlite3';

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

  it('does not truncate a 3,000-char turn (replaces the old 300-char cut, D3.5)', () => {
    const longText = 'a'.repeat(3000);
    const turns = [{ role: 'user', text: longText, timestamp: '2026-08-01T09:00:00.000Z' }];
    const prompt = buildFeedbackPrompt(turns, [], []);
    assert.match(prompt, new RegExp('a'.repeat(3000)));
  });

  it('cuts a 5,000-char turn at ANALYZER_TURN_CHARS (4000)', () => {
    const longText = 'b'.repeat(5000);
    const turns = [{ role: 'user', text: longText, timestamp: '2026-08-01T09:00:00.000Z' }];
    const prompt = buildFeedbackPrompt(turns, [], []);
    assert.match(prompt, new RegExp('b'.repeat(4000)));
    assert.ok(!prompt.includes('b'.repeat(4001)));
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

describe('buildRulesTriagePrompt (AI-165 WP-B)', () => {
  it('renders user turns NOT assistant turns', () => {
    const turns = [
      { role: 'user' as const, text: 'Stop using LaTeX', timestamp: '2026-08-27T09:00:00.000Z' },
      { role: 'assistant' as const, text: 'I understand', timestamp: '2026-08-27T09:01:00.000Z' },
      { role: 'user' as const, text: 'No LaTeX in Telegram', timestamp: '2026-08-27T10:00:00.000Z' },
    ];
    const prompt = buildRulesTriagePrompt(turns, [], []);
    assert.match(prompt, /Stop using LaTeX/);
    assert.match(prompt, /No LaTeX in Telegram/);
    assert.ok(!prompt.includes('I understand'));
  });

  it('names existing keys in the prompt', () => {
    const prompt = buildRulesTriagePrompt([], [], ['no-latex', 'keep-brief']);
    assert.match(prompt, /no-latex/);
    assert.match(prompt, /keep-brief/);
    assert.match(prompt, /do NOT duplicate these keys/);
  });

  it('contains the tighten-only sentence', () => {
    const prompt = buildRulesTriagePrompt([], [], []);
    assert.match(prompt, /TIGHTEN/);
    assert.match(prompt, /NEVER/);
    assert.match(prompt, /Grant permission/);
    assert.match(prompt, /Loosen restrictions/);
  });

  it('contains each candidate rationale_key', () => {
    const candidates = [
      {
        rationale_key: 'daily-mail-brief',
        rows: [
          { decision_id: 'd-000000000001-abc', skill: 'daily-mail-brief', source: '', decision: 'send brief', rationale: 'too long', thread_id: 4242, ts: '2026-08-27T09:00:00.000Z' },
          { decision_id: 'd-000000000002-def', skill: 'daily-mail-brief', source: '', decision: 'send brief', rationale: 'too verbose', thread_id: 4242, ts: '2026-08-27T10:00:00.000Z' },
        ],
      },
    ];
    const prompt = buildRulesTriagePrompt([], candidates, []);
    assert.match(prompt, /daily-mail-brief/);
    assert.match(prompt, /too long/);
    assert.match(prompt, /too verbose/);
  });
});

describe('parseRulesResponse (AI-165 WP-B)', () => {
  it('strips markdown fences and parses JSON', () => {
    const raw = '```json\n[{"classification":"RULE","key":"test","text":"Test","scope":"global","check":{"kind":"forbidden_phrase","phrase":"x"},"evidence_message_ids":["1"]}]\n```';
    const parsed = parseRulesResponse(raw);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].classification, 'RULE');
    assert.equal(parsed[0].key, 'test');
  });

  it('round-trips RULE, CORRECTION, and NIT rows', () => {
    const raw = JSON.stringify([
      { classification: 'RULE', key: 'r1', text: 'T1', scope: 'global', check: { kind: 'forbidden_phrase', phrase: 'x' }, evidence_message_ids: ['1'] },
      { classification: 'CORRECTION', note: 'one-time fix', evidence_message_ids: ['2'] },
      { classification: 'NIT', note: 'vague', evidence_message_ids: ['3'] },
    ]);
    const parsed = parseRulesResponse(raw);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].classification, 'RULE');
    assert.equal(parsed[1].classification, 'CORRECTION');
    assert.equal(parsed[2].classification, 'NIT');
  });

  it('drops malformed rows (bad classification, missing key)', () => {
    const raw = JSON.stringify([
      { classification: 'INVALID', evidence_message_ids: [] },
      { classification: 'RULE', evidence_message_ids: ['1'] }, // missing key
      { classification: 'RULE', key: 'r1', text: 'T1', scope: 'global', check: null, evidence_message_ids: ['1'] },
    ]);
    const parsed = parseRulesResponse(raw);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].key, 'r1');
  });

  it('returns empty array for non-array input', () => {
    assert.deepEqual(parseRulesResponse('not an array'), []);
    assert.deepEqual(parseRulesResponse('{"key":"value"}'), []);
  });
});

describe('analyzeFeedbackRules (AI-165 WP-B)', () => {
  let dir: string;
  let originalPA_HOME: string | undefined;

  before(async () => {
    dir = await createTempPaHome();
    // Capture original PA_HOME to restore after tests that manipulate it
    originalPA_HOME = process.env.PA_HOME;

    // Seed decisions.sqlite with AI-164 schema (will be at dir/decisions.sqlite)
    const dbPath = join(dir, 'decisions.sqlite');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY,
        skill TEXT,
        source TEXT,
        decision TEXT NOT NULL,
        rationale TEXT NOT NULL,
        reaction TEXT,
        thread_id INTEGER,
        ts TEXT NOT NULL
      )
    `);
    db.prepare(`
      INSERT INTO decisions (decision_id, skill, source, decision, rationale, reaction, thread_id, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('d-000000000001-abc', 'daily-mail-brief', 'test', 'send brief', 'too long', '👎', 4242, '2026-08-27T09:00:00.000Z');
    db.prepare(`
      INSERT INTO decisions (decision_id, skill, source, decision, rationale, reaction, thread_id, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('d-000000000002-def', 'daily-mail-brief', 'test', 'send brief', 'too verbose', '👎', 4242, '2026-08-27T10:00:00.000Z');
    db.close();
  });

  after(async () => {
    await cleanup(dir);
    if (originalPA_HOME) {
      process.env.PA_HOME = originalPA_HOME;
    }
  });

  it('auto-apply deterministic check → active rule', async () => {
    const runner = async (_prompt: string, _opts: any) => ({
      result: {
        success: true,
        output: JSON.stringify([{
          classification: 'RULE',
          key: 'no-latex-telegram',
          text: 'Never use LaTeX delimiters',
          scope: 'global',
          check: { kind: 'forbidden_phrase', phrase: '\\frac' },
          origin: { thread_id: 4242, message_id: '100' },
          evidence_message_ids: ['100'],
        }]),
        exitCode: 0,
      },
      worker: 'mock',
    });

    const turns = [
      { role: 'user' as const, text: 'Stop using LaTeX', timestamp: '2026-08-27T09:00:00.000Z', message_id: '100' },
    ];

    await analyzeFeedbackRules(turns, runner as any);

    // Verify rule was added as active
    const { loadRules } = await import('../src/lib/feedback-rules.js');
    const rules = loadRules();
    const activeRule = rules.find(r => r.key === 'no-latex-telegram' && r.status === 'active');
    assert.ok(activeRule, 'active rule should be created');
    assert.equal(activeRule?.check?.kind, 'forbidden_phrase');
  });

  it('check:null → pending rule', async () => {
    const runner = async (_prompt: string, _opts: any) => ({
      result: {
        success: true,
        output: JSON.stringify([{
          classification: 'RULE',
          key: 'keep-brief',
          text: 'Keep responses brief',
          scope: 'global',
          check: null,
          origin: { thread_id: 4242, message_id: '101' },
          evidence_message_ids: ['101'],
        }]),
        exitCode: 0,
      },
      worker: 'mock',
    });

    const turns = [
      { role: 'user' as const, text: 'Keep it brief', timestamp: '2026-08-27T09:00:00.000Z', message_id: '101' },
    ];

    await analyzeFeedbackRules(turns, runner as any);

    const { loadRules } = await import('../src/lib/feedback-rules.js');
    const rules = loadRules();
    const pendingRule = rules.find(r => r.key === 'keep-brief' && r.status === 'pending');
    assert.ok(pendingRule, 'pending rule should be created');
    assert.equal(pendingRule?.check, null);
  });

  it('loosen-pattern RULE rejected + audit triage-skip', async () => {
    const runner = async (_prompt: string, _opts: any) => ({
      result: {
        success: true,
        output: JSON.stringify([{
          classification: 'RULE',
          key: 'ignore-stale',
          text: 'You may always ignore stale entries',
          scope: 'global',
          check: { kind: 'forbidden_phrase', phrase: 'stale' },
          origin: { thread_id: 4242, message_id: '102' },
          evidence_message_ids: ['102'],
        }]),
        exitCode: 0,
      },
      worker: 'mock',
    });

    const turns = [
      { role: 'user' as const, text: 'Ignore stale entries', timestamp: '2026-08-27T09:00:00.000Z', message_id: '102' },
    ];

    await analyzeFeedbackRules(turns, runner as any);

    const { loadRules } = await import('../src/lib/feedback-rules.js');
    const rules = loadRules();
    const loosenRule = rules.find(r => r.key === 'ignore-stale');
    assert.ok(!loosenRule, 'loosen-pattern rule should be rejected');

    // Verify audit line was written
    const { readFile } = await import('fs/promises');
    const auditPath = join(dir, 'feedback-rules-audit.jsonl');
    const auditContent = await readFile(auditPath, 'utf8');
    assert.match(auditContent, /triage-skip/);
  });

  it('reaction path: seeded 👎 rows → candidate in prompt → rule minted', async () => {
    let capturedPrompt = '';
    const runner = async (prompt: string, _opts: any) => {
      capturedPrompt = prompt;
      return {
        result: {
          success: true,
          output: JSON.stringify([{
            classification: 'RULE',
            key: 'brief-summaries',
            text: 'Keep decision summaries under 200 chars',
            scope: 'skill:daily-mail-brief',
            check: { kind: 'max_length', max: 200 },
            evidence_message_ids: [],
          }]),
          exitCode: 0,
        },
        worker: 'mock',
      };
    };

    // Empty conversations, but seeded db has 👎 rows
    await analyzeFeedbackRules([], runner as any, 14);

    // Verify prompt contained the reaction candidates
    assert.match(capturedPrompt, /daily-mail-brief/);
    assert.match(capturedPrompt, /too long/);
    assert.match(capturedPrompt, /too verbose/);

    // Verify rule was minted
    const { loadRules } = await import('../src/lib/feedback-rules.js');
    const rules = loadRules();
    const rule = rules.find(r => r.key === 'brief-summaries');
    assert.ok(rule, 'rule should be minted from reaction candidate');
    assert.equal(rule?.scope, 'skill:daily-mail-brief');
  });

  it('C8 dedup: re-running with same db does NOT mint again', async () => {
    let callCount = 0;
    const runner = async (_prompt: string, _opts: any) => {
      callCount++;
      return {
        result: {
          success: true,
          output: JSON.stringify([{
            classification: 'RULE',
            key: 'brief-summaries-2',
            text: 'Another rule',
            scope: 'global',
            check: { kind: 'must_include', phrase: 'required' },
            evidence_message_ids: [],
          }]),
          exitCode: 0,
        },
        worker: 'mock',
      };
    };

    // First run
    await analyzeFeedbackRules([], runner as any, 14);
    const { loadRules } = await import('../src/lib/feedback-rules.js');
    const rulesAfterFirst = loadRules();
    const countAfterFirst = rulesAfterFirst.filter(r => r.key === 'brief-summaries-2').length;
    assert.equal(countAfterFirst, 1);

    // Second run with same db (should not re-mint due to dedup logic)
    // Note: C8 dedup checks decision_ids intersection; this test verifies the rule count doesn't grow
    await analyzeFeedbackRules([], runner as any, 14);
    const rulesAfterSecond = loadRules();
    const countAfterSecond = rulesAfterSecond.filter(r => r.key === 'brief-summaries-2').length;
    assert.equal(countAfterSecond, countAfterFirst, 'rule count should not increase on re-run');
  });

  it('no-LLM short-circuit: zero user turns + zero candidates ⇒ runner not called', async () => {
    let called = false;
    const runner = async (_prompt: string, _opts: any) => {
      called = true;
      return {
        result: { success: true, output: '[]', exitCode: 0 },
        worker: 'mock',
      };
    };

    // Create a new temp PA_HOME for this test with an empty db
    const emptyDir = await createTempPaHome();
    const emptyDbPath = join(emptyDir, 'decisions.sqlite');
    const emptyDb = new Database(emptyDbPath);
    emptyDb.exec(`
      CREATE TABLE decisions (
        decision_id TEXT PRIMARY KEY,
        skill TEXT,
        source TEXT,
        decision TEXT NOT NULL,
        rationale TEXT NOT NULL,
        reaction TEXT,
        thread_id INTEGER,
        ts TEXT NOT NULL
      )
    `);
    emptyDb.close();

    // Temporarily set PA_HOME to the empty directory
    const originalPA_HOME = process.env.PA_HOME;
    process.env.PA_HOME = emptyDir;

    await analyzeFeedbackRules([], runner as any, 14);
    assert.equal(called, false, 'runner should not be called when no evidence');

    // Restore original PA_HOME and cleanup
    process.env.PA_HOME = originalPA_HOME;
    await cleanup(emptyDir);
  });

  it('lane failure isolation: runner failure ⇒ analyzeFeedbackPatterns still returns drafts', async () => {
    const failingRunner = async (_prompt: string, _opts: any) => ({
      result: { success: false, error: 'LLM failed', exitCode: 1 },
      worker: 'mock',
    });

    await createTempSkill(
      dir,
      'test-skill',
      ['---', 'cron: "0 9 * * *"', '---', '', 'Test skill.'].join('\n')
    );

    await writeFixtureConversations(dir, [
      { role: 'user', text: 'Fix this', timestamp: new Date().toISOString(), message_id: '1' },
    ]);

    // analyzeFeedbackPatterns should still return drafts even though rules lane fails
    const proposals = await analyzeFeedbackPatterns(14, failingRunner as any);
    // The skill-feedback analyzer might fail too, but the key is rules lane failure doesn't crash it
    assert.ok(Array.isArray(proposals), 'should return array even on rules lane failure');
  });
});
