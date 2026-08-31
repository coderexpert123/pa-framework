/**
 * End-to-end test for the skill learning pipeline.
 * Uses fixture data and a mocked LLM runner — no real AI calls.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import {
  analyzeConversationPatterns,
  analyzeConversationWindow,
  _resetAnalyzerStateForTest,
} from '../src/analyzer.js';
import { analyzeFailurePatterns } from '../src/failure-analyzer.js';
import { saveDraft, loadDraft, approveDraft, rejectDraft, isDuplicate } from '../src/drafts.js';
import { loadAnalyzerState, skillCandidatesPath } from '../src/lib/skill-candidates.js';
import type { DraftProposal } from '../src/types.js';
import type { RunMeta } from '../src/types.js';
import { createTempPaHome, cleanup } from './helpers.js';

// Fake runner that returns a canned JSON response — used only for the
// analyzeFailurePatterns cases (a single-pass analyzer, unaffected by this
// wave's two-pass rewrite of analyzeConversationPatterns/analyzeConversationWindow).
function makeRunner(proposals: DraftProposal[]) {
  return async (_prompt: string, _opts: any) => {
    return {
      result: { success: true, output: JSON.stringify(proposals), exitCode: 0 as number | null },
      worker: 'mock',
    };
  };
}

/**
 * Fake runner for the two-pass conversation analyzer. Pass 1 (keying) and
 * Pass 2 (proposal) are distinguished via the `resource` tag analyzer.ts sets
 * on each runner call ('skill-learner-keying' / 'skill-learner-proposal').
 * Pass 1 keys every turn id found in the prompt (bracketed `[id]` lines,
 * matching buildKeyingPrompt's rendering) to `opts.key`; Pass 2 returns
 * `opts.proposals` verbatim. `key` must be UNIQUE per test that expects a
 * Pass-2 call to fire — a key already proposed earlier in this file is
 * suppressed for 14 days (SKILL_CANDIDATE_REPROPOSE_MS), so reusing one
 * would silently make eligibleCandidates skip it.
 */
function makeTwoPassRunner(opts: { key: string; proposals: DraftProposal[] }) {
  return async (prompt: string, callOpts: any) => {
    if (callOpts?.resource === 'skill-learner-proposal') {
      return {
        result: { success: true, output: JSON.stringify(opts.proposals), exitCode: 0 as number | null },
        worker: 'mock',
      };
    }
    const ids = [...prompt.matchAll(/^\[([^\]]*)\]/gm)].map((m) => m[1]);
    const results = ids.map((id) => ({ message_id: id, key: opts.key, intent: 'test intent' }));
    return {
      result: { success: true, output: JSON.stringify(results), exitCode: 0 as number | null },
      worker: 'mock',
    };
  };
}

async function writeFixtureConversations(dir: string): Promise<void> {
  // Create a clear repeated pattern: email summary asked 5 times over different
  // days. Timestamps are RELATIVE (1-5 days ago) so the fixture never ages out
  // of analyzeConversationPatterns' lookback window (was hardcoded Apr-2026,
  // which silently fell outside the 30-day window over time).
  const day = 24 * 60 * 60 * 1000;
  const ago = (d: number) => new Date(Date.now() - d * day).toISOString();
  const turns = [
    { role: 'user', text: 'summarize my unread emails', timestamp: ago(5), message_id: '1' },
    { role: 'assistant', text: 'Here are your unread emails...', timestamp: ago(5) },
    { role: 'user', text: 'check my unread emails please', timestamp: ago(4), message_id: '2' },
    { role: 'assistant', text: 'You have 5 unread emails.', timestamp: ago(4) },
    { role: 'user', text: 'any unread emails today?', timestamp: ago(3), message_id: '3' },
    { role: 'assistant', text: '3 unread emails.', timestamp: ago(3) },
    { role: 'user', text: 'summarize emails', timestamp: ago(2), message_id: '4' },
    { role: 'assistant', text: 'Email summary: ...', timestamp: ago(2) },
    { role: 'user', text: 'what emails do I have', timestamp: ago(1), message_id: '5' },
    { role: 'assistant', text: 'You have 2 emails.', timestamp: ago(1) },
  ];

  await writeFile(
    join(dir, 'conversation-history.jsonl'),
    turns.map((t) => JSON.stringify(t)).join('\n'),
    'utf8'
  );
}

async function writeFixtureFailures(dir: string): Promise<void> {
  const logDir = join(dir, 'logs', 'ecosystem-kb');
  await mkdir(logDir, { recursive: true });

  const makeErrorMeta = (i: number): RunMeta => ({
    worker: 'codex',
    status: 'error',
    exitCode: -1,
    duration: 600000,
    timestamp: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
    error: 'Killed: exceeded max timeout of 600s',
  });

  for (let i = 0; i < 3; i++) {
    const meta = makeErrorMeta(i);
    const ts = meta.timestamp.replace(/[:.]/g, '-').slice(0, 19);
    await writeFile(join(logDir, `${ts}-abc${i}.meta`), JSON.stringify(meta, null, 2), 'utf8');
  }
}

describe('learn end-to-end pipeline', () => {
  let dir: string;

  before(async () => {
    dir = await createTempPaHome();
    await writeFixtureConversations(dir);
    await writeFixtureFailures(dir);
  });

  after(async () => {
    await cleanup(dir);
  });

  const emailSummaryProposal: DraftProposal = {
    name: 'email-summary',
    reason: 'User requests email summaries 5 times across different days',
    source_message_ids: ['1', '2', '3', '4', '5'],
    frontmatter: { trigger_description: 'When user asks about emails', timeout: 300 },
    prompt: 'Summarize unread emails and highlight anything urgent.',
  };

  const ecosystemFixProposal: DraftProposal = {
    name: 'ecosystem-kb-fix',
    reason: 'ecosystem-kb has timed out 3 times in the last week',
    source_message_ids: [],
    frontmatter: { timeout: 1200 },
    prompt: 'Run the ecosystem-kb update with extended timeout and smaller batches.',
  };

  it('analyzeConversationPatterns returns proposals from mocked LLM', async () => {
    await _resetAnalyzerStateForTest();
    const runner = makeTwoPassRunner({ key: 'email-summary', proposals: [emailSummaryProposal] });
    const proposals = await analyzeConversationPatterns(30, runner);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].name, 'email-summary');
  });

  it('analyzeFailurePatterns returns proposals from mocked LLM', async () => {
    const runner = makeRunner([ecosystemFixProposal]);
    const proposals = await analyzeFailurePatterns(7, runner);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].name, 'ecosystem-kb-fix');
  });

  it('saveDraft writes correct files for conversation proposal', async () => {
    await saveDraft(emailSummaryProposal, 'conversation');

    const { skill, meta } = await loadDraft('email-summary');
    assert.equal(skill.name, 'email-summary');
    assert.match(skill.prompt, /Summarize unread emails/);
    assert.equal(meta.status, 'pending');
    assert.equal(meta.source_type, 'conversation');
    assert.equal(meta.reason, emailSummaryProposal.reason);
  });

  it('saveDraft writes correct files for failure proposal', async () => {
    await saveDraft(ecosystemFixProposal, 'failure');

    const { skill, meta } = await loadDraft('ecosystem-kb-fix');
    assert.equal(skill.name, 'ecosystem-kb-fix');
    assert.equal(meta.source_type, 'failure');
    assert.equal(meta.status, 'pending');
  });

  it('approveDraft installs skill to skills dir', async () => {
    await approveDraft('email-summary');

    const skillPath = join(dir, 'skills', 'email-summary', 'skill.md');
    const content = await readFile(skillPath, 'utf8');
    assert.match(content, /Summarize unread emails/);

    const { meta } = await loadDraft('email-summary');
    assert.equal(meta.status, 'approved');
    assert.ok(meta.reviewed_at);
  });

  it('isDuplicate prevents re-proposal after approval', async () => {
    // email-summary was approved above, so it should now be a duplicate
    assert.ok(await isDuplicate(emailSummaryProposal));
  });

  it('rejectDraft marks draft as rejected and keeps files', async () => {
    await rejectDraft('ecosystem-kb-fix');

    const { meta } = await loadDraft('ecosystem-kb-fix');
    assert.equal(meta.status, 'rejected');
    assert.ok(meta.reviewed_at);

    // skill.md still exists
    await assert.doesNotReject(() => stat(join(dir, 'skill-drafts', 'ecosystem-kb-fix', 'skill.md')));
  });

  it('isDuplicate prevents re-proposal after rejection (keeps rejected as dedup reference)', async () => {
    assert.ok(await isDuplicate(ecosystemFixProposal));
  });

  it('mocked runner returning empty array produces no proposals', async () => {
    await _resetAnalyzerStateForTest();
    const runner = makeRunner([]); // shared canned '[]' response for every pass
    const proposals = await analyzeConversationPatterns(7, runner);
    assert.deepEqual(proposals, []);
  });

  it('analyzeConversationPatterns short-circuits and returns [] without LLM call when no turns', async () => {
    await _resetAnalyzerStateForTest();
    let runnerCalled = false;
    const runner = async (_p: string, _o: any) => {
      runnerCalled = true;
      return { result: { success: true, output: '[]', exitCode: 0 as number | null }, worker: 'mock' };
    };

    // Point PA_HOME to a dir with no conversation-history.jsonl
    const origHome = process.env.PA_HOME;
    try {
      const emptyDir = dir + '-empty';
      const { mkdir } = await import('fs/promises');
      await mkdir(emptyDir + '/skills', { recursive: true });
      await mkdir(emptyDir + '/skill-drafts', { recursive: true });
      await mkdir(emptyDir + '/logs', { recursive: true });
      process.env.PA_HOME = emptyDir;

      const proposals = await analyzeConversationPatterns(7, runner);
      assert.deepEqual(proposals, []);
      assert.equal(runnerCalled, false, 'LLM runner should not be called when no turns');
    } finally {
      process.env.PA_HOME = origHome;
    }
  });

  it('analyzeFailurePatterns short-circuits and returns [] without LLM call when no qualifying failures', async () => {
    let runnerCalled = false;
    const runner = async (_p: string, _o: any) => {
      runnerCalled = true;
      return { result: { success: true, output: '[]', exitCode: 0 as number | null }, worker: 'mock' };
    };

    // dir has only 1 failure per skill (not 2+), so should short-circuit
    const origHome = process.env.PA_HOME;
    try {
      const singleFailDir = dir + '-single-fail';
      const { mkdir: mkdirFn, writeFile: writeFn } = await import('fs/promises');
      await mkdirFn(singleFailDir + '/skills', { recursive: true });
      await mkdirFn(singleFailDir + '/skill-drafts', { recursive: true });
      const logDir = singleFailDir + '/logs/some-skill';
      await mkdirFn(logDir, { recursive: true });
      const singleMeta = { worker: 'codex', status: 'error', exitCode: -1, duration: 1000, timestamp: new Date().toISOString(), error: 'One-off error' };
      await writeFn(logDir + '/20260101-000000-aaa111.meta', JSON.stringify(singleMeta), 'utf8');
      process.env.PA_HOME = singleFailDir;

      const proposals = await analyzeFailurePatterns(7, runner);
      assert.deepEqual(proposals, []);
      assert.equal(runnerCalled, false, 'LLM runner should not be called when no qualifying failures');
    } finally {
      process.env.PA_HOME = origHome;
    }
  });

  it('batch dedup prevents same-name proposals from overwriting each other', async () => {
    await _resetAnalyzerStateForTest();
    // LLM returns two proposals with the same name but different prompts
    const dupProposal1: DraftProposal = {
      name: 'dup-skill',
      reason: 'First version',
      source_message_ids: [],
      frontmatter: {},
      prompt: 'First prompt for dup skill.',
    };
    const dupProposal2: DraftProposal = {
      name: 'dup-skill', // same name!
      reason: 'Second version',
      source_message_ids: [],
      frontmatter: {},
      prompt: 'Second completely different prompt.',
    };

    const runner = makeTwoPassRunner({ key: 'dup-test-key', proposals: [dupProposal1, dupProposal2] });
    const proposals = await analyzeConversationPatterns(30, runner);

    // Only one proposal should survive
    const dupProposals = proposals.filter((p) => p.name === 'dup-skill');
    assert.equal(dupProposals.length, 1);
    // It should be the first one
    assert.equal(dupProposals[0].prompt, dupProposal1.prompt);
  });

  // --- C26: watermark isolation cases (this wave's two-pass rewrite) --------

  it('a first advancing call writes analyzer-state.json and skill-candidates.json', async () => {
    await _resetAnalyzerStateForTest();
    const runner = makeTwoPassRunner({ key: 'watermark-write-test', proposals: [] });
    await analyzeConversationPatterns(30, runner);

    const state = await loadAnalyzerState();
    assert.ok(state.covers_through, 'covers_through should be set after a successful advancing run');
    assert.ok(state.last_run_at);

    await assert.doesNotReject(() => stat(skillCandidatesPath()));
  });

  it('an immediate second call without a reset returns [] and makes no runner call (watermark honoured)', async () => {
    await _resetAnalyzerStateForTest();
    const firstRunner = makeTwoPassRunner({ key: 'immediate-second-call-test', proposals: [] });
    await analyzeConversationPatterns(30, firstRunner);

    let callCount = 0;
    const spyRunner = async (_p: string, _o: any) => {
      callCount++;
      return { result: { success: true, output: '[]', exitCode: 0 as number | null }, worker: 'mock' };
    };

    const proposals = await analyzeConversationPatterns(30, spyRunner);
    assert.deepEqual(proposals, []);
    assert.equal(callCount, 0, 'the watermark already covers every fixture turn, so no runner call should happen');
  });

  it('analyzeConversationWindow after an advancing call still re-processes and leaves covers_through unchanged', async () => {
    await _resetAnalyzerStateForTest();
    const advancingRunner = makeTwoPassRunner({ key: 'window-rerun-test', proposals: [] });
    await analyzeConversationPatterns(30, advancingRunner);
    const stateAfterAdvance = await loadAnalyzerState();
    assert.ok(stateAfterAdvance.covers_through);

    const windowProposal: DraftProposal = {
      name: 'window-test-skill',
      reason: 'produced by the window (non-advancing) path',
      source_message_ids: [],
      frontmatter: {},
      prompt: 'p.',
    };

    let callCount = 0;
    const windowRunner = async (prompt: string, callOpts: any) => {
      callCount++;
      return makeTwoPassRunner({ key: 'window-rerun-test', proposals: [windowProposal] })(prompt, callOpts);
    };

    const proposals = await analyzeConversationWindow(30, windowRunner);
    assert.ok(callCount > 0, 'analyzeConversationWindow must re-process the window, ignoring the watermark');
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].name, 'window-test-skill');

    const stateAfterWindow = await loadAnalyzerState();
    assert.deepEqual(stateAfterWindow, stateAfterAdvance, 'analyzeConversationWindow must never touch analyzer-state.json');
  });
});
