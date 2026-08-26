import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { buildResumedPrompt, buildPrompt, shouldIncludeSkillStatus, _resetSkillStatusCache } from '../context.js';
import type { ConversationState } from '../types.js';
import type { TopicNameMap } from '../topic-names.js';
import type { Reservation } from '../../../../pa/dist/src/lib/reservations.js';

// Resolve path to bot-instructions.md relative to compiled test location.
// Tests run from dist/tests/ so dist/../../bot-instructions.md = projects/telegram-bot/bot-instructions.md
const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_INSTRUCTIONS_PATH = resolve(__dirname, '../../bot-instructions.md');
// examples/bot-instructions.example.md is tracked (unlike bot-instructions.md), so it is
// the CI-enforced half of any prompt-triangle sync assertion (C5, coordination-remediation
// spec 2026-08-23): dist/tests/ -> ../../../../ = repo root, then into examples/.
const BOT_INSTRUCTIONS_EXAMPLE_PATH = resolve(__dirname, '../../../../examples/bot-instructions.example.md');

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'tgbot-ctx-'));
  process.env.PA_HOME = tempDir;
  _resetSkillStatusCache();
});

afterEach(async () => {
  delete process.env.PA_HOME;
  await rm(tempDir, { recursive: true, force: true });
});

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    chat_id: -1001234567890,
    last_update_id: -1,
    thread_id: 29,
    turns: [],
    ...overrides,
  };
}

describe('buildResumedPrompt', () => {
  it('includes today date and current IST time', async () => {
    const result = await buildResumedPrompt('hello');
    assert.ok(result.includes('Today is'), 'should include date');
    assert.ok(result.includes('Current time (IST)'), 'should include IST time');
    assert.ok(result.includes('+05:30'), 'should include IST offset');
  });

  it('includes the user message', async () => {
    const result = await buildResumedPrompt('what is the weather?');
    assert.ok(result.includes('what is the weather?'), 'should contain user message');
  });

  it('does NOT include briefs, identity, capabilities, or history', async () => {
    const result = await buildResumedPrompt('hi');
    assert.ok(!result.includes('Morning Brief'), 'should not have morning brief');
    assert.ok(!result.includes('Evening Brief'), 'should not have evening brief');
    assert.ok(!result.includes('You are a personal assistant'), 'should not have identity block');
    assert.ok(!result.includes('Capabilities & Rules'), 'should not have capabilities block');
    assert.ok(!result.includes('Conversation History'), 'should not have history block');
    assert.ok(!result.includes('PA Skill Status'), 'should not have skill status');
  });

  it('includes reply section when replyContext provided', async () => {
    const result = await buildResumedPrompt('tell me more', 'the OFS deal closed today');
    assert.ok(result.includes('Replying To'), 'should have reply section');
    assert.ok(result.includes('the OFS deal closed today'), 'should include reply text');
  });

  it('omits reply section when replyContext is undefined', async () => {
    const result = await buildResumedPrompt('hello');
    assert.ok(!result.includes('Replying To'), 'should not have reply section');
  });

  it('includes pending confirmation section when pendingAction provided', async () => {
    const pending = 'Send email to John about meeting';
    const result = await buildResumedPrompt('yes', undefined, pending);
    assert.ok(result.includes('Pending Confirmation'), 'should have pending section');
    assert.ok(result.includes(pending), 'should include pending description');
  });

  it('omits pending section when pendingAction is undefined', async () => {
    const result = await buildResumedPrompt('hello');
    assert.ok(!result.includes('Pending Confirmation'), 'should not have pending section');
  });

  it('has Context Update header', async () => {
    const result = await buildResumedPrompt('hello');
    assert.ok(result.includes('Context Update'), 'should start with Context Update header');
  });

  it('returns a string (does not throw)', async () => {
    const result = await buildResumedPrompt('test message', 'reply ctx', 'some action');
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });
});

// ---------------------------------------------------------------------------
// buildPrompt — PA_META and capabilities section
// ---------------------------------------------------------------------------

describe('buildPrompt: capabilities block', () => {
  it('includes PA_META instructions in capabilities', async () => {
    const result = await buildPrompt('hello', makeState(), undefined);
    assert.ok(result.includes('[PA_META]'), 'should include PA_META marker');
    assert.ok(result.includes('retry_with_worker'), 'should describe retry_with_worker action');
    assert.ok(result.includes('run_skill'), 'should describe run_skill action');
    assert.ok(result.includes('confirm_required'), 'should describe confirm_required action');
  });

  it('includes identity and conversation history (distinguishing it from resumed prompt)', async () => {
    const result = await buildPrompt('hello', makeState(), undefined);
    assert.ok(result.includes('You are a personal assistant'), 'should have identity block');
    assert.ok(result.includes('Capabilities & Rules'), 'should have capabilities block');
    assert.ok(result.includes('Conversation History'), 'should have history block');
  });

  it('includes today date and IST time', async () => {
    const result = await buildPrompt('hello', makeState(), undefined);
    assert.ok(result.includes('Today is'), 'should include date');
    assert.ok(result.includes('+05:30'), 'should include IST offset');
  });

  it('PA_META instructions absent when pendingAction provided (execution mode)', async () => {
    const result = await buildPrompt('yes', makeState(), undefined, undefined, 'send email to John');
    // In execution mode capabilities block is stripped down — PA_META is not injected
    assert.ok(!result.includes('[PA_META]'), 'PA_META must not appear in execution-mode prompt');
  });

  it('omitStatic=true drops identity, capabilities, and PA_META from user message', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: true });
    assert.ok(!result.includes('You are a personal assistant'), 'identity must be absent in lean mode');
    assert.ok(!result.includes('Capabilities & Rules'), 'capabilities must be absent in lean mode');
    assert.ok(!result.includes('[PA_META]'), 'PA_META spec must be absent in lean mode');
    assert.ok(result.includes('Conversation History'), 'history must still be present in lean mode');
    assert.ok(result.includes('Today is'), 'date must still be present in lean mode');
    assert.ok(result.includes('hello'), 'user message must still be present in lean mode');
  });

  it('omitStatic=true execution mode still includes Pending Confirmation section', async () => {
    const result = await buildPrompt('yes', makeState(), undefined, undefined, 'send email to John', { omitStatic: true });
    assert.ok(!result.includes('[PA_META]'), 'PA_META must not appear in lean execution mode');
    assert.ok(result.includes('## Pending Confirmation'), 'pending confirmation section must be present');
    assert.ok(result.includes('send email to John'), 'pending action description must be present');
  });

  it('bot-instructions.md instructs model to omit PA_META in execution mode', { skip: !existsSync(BOT_INSTRUCTIONS_PATH) && 'bot-instructions.md not present locally' }, async () => {
    const content = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(content.includes('Execution mode'), 'must have Execution mode section');
    assert.ok(content.includes('do NOT emit `[PA_META]`'), 'must instruct no PA_META in execution mode');
  });

  it('omits PA Skill Status for unrelated user messages', async () => {
    const result = await buildPrompt('hello', makeState(), undefined);
    assert.ok(!result.includes('PA Skill Status'), 'skill status should be omitted on unrelated messages');
  });

  it('includes PA Skill Status when user message references skills/schedules', async () => {
    const result = await buildPrompt('did the daily-mail brief run today?', makeState());
    assert.ok(result.includes('PA Skill Status'), 'skill status should appear when user asks about it');
  });
});

// ---------------------------------------------------------------------------
// shouldIncludeSkillStatus — pure trigger logic
// ---------------------------------------------------------------------------

describe('shouldIncludeSkillStatus', () => {
  it('returns false for neutral small-talk', () => {
    assert.equal(shouldIncludeSkillStatus('hello'), false);
    assert.equal(shouldIncludeSkillStatus('what time is it?'), false);
    assert.equal(shouldIncludeSkillStatus('thanks'), false);
  });

  it('returns true for skill-status queries', () => {
    assert.equal(shouldIncludeSkillStatus('did anything fail?'), true);
    assert.equal(shouldIncludeSkillStatus('what\'s the status of the briefing?'), true);
    assert.equal(shouldIncludeSkillStatus('show me the cron schedule'), true);
  });

  it('returns true when a skill-status keyword is referenced', () => {
    // shouldIncludeSkillStatus is a sync keyword-trigger regex (status/run/fail/
    // brief/catchup/schedule/...), not a skill-name matcher.
    assert.equal(shouldIncludeSkillStatus('what is the status of my skills?'), true);
    assert.equal(shouldIncludeSkillStatus('did the daily brief run?'), true);
    assert.equal(shouldIncludeSkillStatus('any failed skills?'), true);
    assert.equal(shouldIncludeSkillStatus('ran the oracle yet?'), true);
  });

  it('is case-insensitive', () => {
    assert.equal(shouldIncludeSkillStatus('STATUS'), true);
    assert.equal(shouldIncludeSkillStatus('Brief'), true);
  });

  it('respects word boundaries', () => {
    // "brunch" contains no word-boundary match for "brief" → should not trigger
    assert.equal(shouldIncludeSkillStatus('brunch plans'), false);
    // "runner" should not match "run" as a word
    assert.equal(shouldIncludeSkillStatus('my runner app'), false);
  });
});

// ---------------------------------------------------------------------------
// buildPrompt — removed sections must NOT appear
// ---------------------------------------------------------------------------

describe('buildPrompt: removed sections', () => {
  it('does NOT include briefs or cross-topic activity', async () => {
    const result = await buildPrompt('hello', makeState(), undefined);
    assert.ok(!result.includes('Morning Brief'), 'should not have morning brief');
    assert.ok(!result.includes('Evening Brief'), 'should not have evening brief');
    assert.ok(!result.includes('Today\'s Email Briefs'), 'should not have briefs header');
    assert.ok(!result.includes('Cross-Topic Activity'), 'should not have cross-topic section');
  });
});

// ---------------------------------------------------------------------------
// bot-instructions.md content
// ---------------------------------------------------------------------------
// These tests validate the LOCAL bot-instructions.md file (the user's personalized
// static system prompt). The file is gitignored from public clones; in a fresh
// public install, the user copies examples/bot-instructions.example.md to
// projects/telegram-bot/bot-instructions.md and customizes. If the file doesn't
// exist at test time, these tests are skipped — they exist to lint the LOCAL
// content for required structural elements, not to enforce its presence.

const BOT_INSTRUCTIONS_EXISTS = existsSync(BOT_INSTRUCTIONS_PATH);

describe('bot-instructions.md content', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, () => {
  it('file exists at the expected path', async () => {
    const content = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(content.length > 0, 'bot-instructions.md must not be empty');
  });

  it('contains personal assistant identity phrase', async () => {
    const content = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.match(content, /you are a personal assistant for/i,
      'must contain identity phrase ("you are a personal assistant for <name>")');
  });

  it('contains Capabilities & Rules section', async () => {
    const content = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(content.includes('Capabilities & Rules'), 'must have Capabilities & Rules');
  });

  it('contains PA_META envelope section', async () => {
    const content = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(content.includes('PA_META envelope'), 'must have PA_META envelope section');
  });

  it('contains Execution mode section', async () => {
    const content = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(content.includes('Execution mode'), 'must have Execution mode section');
  });

  it('contains all three PA_META action types', async () => {
    const content = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(content.includes('retry_with_worker'), 'must describe retry_with_worker');
    assert.ok(content.includes('run_skill'), 'must describe run_skill');
    assert.ok(content.includes('confirm_required'), 'must describe confirm_required');
  });

  it('contains verbatim confirmation phrase (must match CONFIRMATION_PATTERN in logic.ts)', async () => {
    const content = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(content.includes('Reply *yes* to confirm or *no* to cancel.'),
      'confirmation phrase must be verbatim — changing it breaks logic.ts CONFIRMATION_PATTERN');
  });

  // AI-101: bot-instructions.md is only delivered to claude/zclaude
  // (--append-system-prompt-file); agy/codex — including agy, the priority-1
  // default worker, and the one that actually answered wrong in the incident
  // this rule exists to prevent — only ever see context.ts's inline
  // capabilities block (buildPrompt with omitStatic:false). A grounding rule
  // added to only one of the two is silently inert for the other worker
  // family. This test fails if the two drift apart.
  it('Grounding Sources rule matches context.ts inline capabilities block verbatim', async () => {
    const content = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    const GROUNDING_SENTENCE = 'Systems of record: D:/My Repos/notes/Ecosystem KB/ (start with Sources.md). Before answering a date-sensitive or domain-deterministic factual question, check Sources.md and the file(s) it names, and cite them. Never answer such a question from general/parametric knowledge when a named source exists.';
    assert.ok(content.includes(GROUNDING_SENTENCE), 'bot-instructions.md must contain the Grounding Sources sentence verbatim');
    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(GROUNDING_SENTENCE), 'context.ts inline capabilities block must contain the SAME sentence verbatim — keep both in sync');
  });
});

// ---------------------------------------------------------------------------
// Shared working tree protocol block (coordination-remediation, 2026-08-23)
// ---------------------------------------------------------------------------
// The anchor sentence below is the verbatim-sync key (§7.1 of the coordination-
// remediation spec): it appears in projects/telegram-bot/bot-instructions.md,
// examples/bot-instructions.example.md, AND context.ts's inline capabilities
// block. Unlike the Grounding Sources sync test above, the example file is
// TRACKED, so it is the CI-enforced half — the bot-instructions.md half stays
// skip-guarded (C5: that file is gitignored/untracked and never present in CI).

const SHARED_TREE_ANCHOR_SENTENCE = 'Before editing a tracked file, run `pa claims`; if your path appears under an active reservation or in the recently-modified list, say so and pick different work rather than editing over it.';

describe('Shared working tree protocol block', () => {
  it('matches examples/bot-instructions.example.md verbatim', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(SHARED_TREE_ANCHOR_SENTENCE),
      'examples/bot-instructions.example.md must contain the Shared working tree anchor sentence verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(SHARED_TREE_ANCHOR_SENTENCE),
      'context.ts inline capabilities block must contain the SAME sentence verbatim — keep both in sync');
  });

  it('matches bot-instructions.md verbatim (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(SHARED_TREE_ANCHOR_SENTENCE),
      'bot-instructions.md must contain the Shared working tree anchor sentence verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(SHARED_TREE_ANCHOR_SENTENCE),
      'context.ts inline capabilities block must contain the SAME sentence verbatim — keep both in sync');
  });

  it('is absent in omitStatic (lean) mode', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: true });
    assert.ok(!result.includes(SHARED_TREE_ANCHOR_SENTENCE), 'Shared working tree block must be absent in lean mode');
  });

  it('is absent in execution mode (pendingAction set)', async () => {
    const result = await buildPrompt('yes', makeState(), undefined, undefined, 'send email to John', { omitStatic: false });
    assert.ok(!result.includes(SHARED_TREE_ANCHOR_SENTENCE), 'Shared working tree block must be absent in execution mode');
  });
});

// ---------------------------------------------------------------------------
// No-LaTeX rule (added 2026-08-24, commit 55c2d2c) — Telegram has no LaTeX
// renderer, so raw delimiters/formulas render unformatted. This is the same
// byte-identical-across-three-files sync pattern as the Shared working tree
// anchor above: examples/bot-instructions.example.md is the CI-enforced half;
// the local bot-instructions.md half stays skip-guarded (untracked, C5). Added
// after a hotfix-recheck audit found context.ts and examples/bot-instructions.
// example.md carrying two DIFFERENT wordings of "the same" rule (one used a
// semicolon and dropped "formulas and") with no test to catch the drift —
// unlike the two anchor sentences above, which already had one.
// ---------------------------------------------------------------------------

const NO_LATEX_ANCHOR_SENTENCE = '— Telegram has no LaTeX renderer. Write formulas and math using plain text or standard Unicode symbols (e.g. "P = power", "×", "Δ", "≈", "→", "²").';

describe('No-LaTeX rule', () => {
  it('matches examples/bot-instructions.example.md verbatim', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(NO_LATEX_ANCHOR_SENTENCE),
      'examples/bot-instructions.example.md must contain the No-LaTeX anchor sentence verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(NO_LATEX_ANCHOR_SENTENCE),
      'context.ts inline capabilities block must contain the SAME sentence verbatim — keep both in sync');
  });

  it('matches bot-instructions.md verbatim (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(NO_LATEX_ANCHOR_SENTENCE),
      'bot-instructions.md must contain the No-LaTeX anchor sentence verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(NO_LATEX_ANCHOR_SENTENCE),
      'context.ts inline capabilities block must contain the SAME sentence verbatim — keep both in sync');
  });
});

// ---------------------------------------------------------------------------
// Recall prompt bullet (recall-traces wave, WP-B / spec §3.2 step 5)
// ---------------------------------------------------------------------------
// Same three-way verbatim-sync pattern as the Grounding Sources / No-LaTeX
// bullets above: examples/bot-instructions.example.md is the CI-enforced half,
// bot-instructions.md is the local (untracked) skip-guarded half, and
// context.ts's inline capabilities block is the agy/codex-visible half.

const RECALL_ANCHOR_SENTENCE = 'Run `pa recall "<terms>" --thread <id> --json` before answering "I don\'t know", before asking the user to repeat something, and before assuming a past decision was never made.';

describe('Recall prompt bullet', () => {
  it('matches examples/bot-instructions.example.md verbatim', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(RECALL_ANCHOR_SENTENCE),
      'examples/bot-instructions.example.md must contain the Recall anchor sentence verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(RECALL_ANCHOR_SENTENCE),
      'context.ts inline capabilities block must contain the SAME sentence verbatim — keep both in sync');
  });

  it('matches bot-instructions.md verbatim (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(RECALL_ANCHOR_SENTENCE),
      'bot-instructions.md must contain the Recall anchor sentence verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(RECALL_ANCHOR_SENTENCE),
      'context.ts inline capabilities block must contain the SAME sentence verbatim — keep both in sync');
  });

  it('is absent in omitStatic (lean) mode', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: true });
    assert.ok(!result.includes(RECALL_ANCHOR_SENTENCE), 'lean mode must not include the recall bullet');
  });

  it('is absent in execution mode (pendingAction set)', async () => {
    const result = await buildPrompt('yes', makeState(), undefined, undefined, 'send email to John', { omitStatic: false });
    assert.ok(!result.includes(RECALL_ANCHOR_SENTENCE), 'execution mode must not include the recall bullet');
  });
});

// ---------------------------------------------------------------------------
// @build reservation bullet (coordination-remediation Wave C, W-C6 §7.3)
// ---------------------------------------------------------------------------
// C2a (Wave C) makes `npm run build`/`npm test` take the `@build` reservation
// themselves, so the pre-Wave-C "claim @build by hand" text became actively wrong
// (a manual claim now collides with the npm script's own and deadlocks for 15 min).
// Same byte-identical-across-three-files sync pattern as the Shared working tree
// anchor above: examples/bot-instructions.example.md is the CI-enforced half;
// the local bot-instructions.md half stays skip-guarded (untracked, C5).

const BUILD_RESERVATION_BULLET = '- Never run a build or test in the repo while another one is running: `npm run build` and `npm test` take the `@build` reservation themselves and release it when they finish, so a "waiting for @build" line means another build is in flight and yours will start when it ends — that is expected, not stuck. Do not claim `@build` by hand; a manual claim collides with the one the npm script takes and stalls your own build for 15 minutes.';

describe('@build reservation bullet (W-C6 §7.3)', () => {
  it('matches examples/bot-instructions.example.md verbatim', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(BUILD_RESERVATION_BULLET),
      'examples/bot-instructions.example.md must contain the @build bullet verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(BUILD_RESERVATION_BULLET),
      'context.ts inline capabilities block must contain the SAME @build bullet verbatim — keep both in sync');
  });

  it('matches bot-instructions.md verbatim (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(BUILD_RESERVATION_BULLET),
      'bot-instructions.md must contain the @build bullet verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(BUILD_RESERVATION_BULLET),
      'context.ts inline capabilities block must contain the SAME @build bullet verbatim — keep both in sync');
  });

  it('no longer contains the retired manual-claim instruction', async () => {
    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(!inlinePrompt.includes("pa claim '@build' --session <label> --ttl 15 --wait 300"),
      'the old manual-claim instruction must be gone — a manual claim now deadlocks against the npm scripts own claim (C2a)');
  });
});

// ---------------------------------------------------------------------------
// buildPrompt — topic description injection
// ---------------------------------------------------------------------------

describe('buildPrompt: topic description', () => {
  it('includes topic description when topicNames is provided', async () => {
    const topicNames: TopicNameMap = new Map([
      ['-1001234567890', new Map([[29, { name: 'test-topic', description: 'Test description' }]])],
    ]);
    const result = await buildPrompt('hello', makeState(), topicNames);
    assert.ok(result.includes('## Topic'), 'should have topic section header');
    assert.ok(result.includes('Topic: test-topic — Test description'), 'should include topic name and description');
  });

  it('includes topic with name only when description is missing', async () => {
    const topicNames: TopicNameMap = new Map([
      ['-1001234567890', new Map([[29, { name: 'test-topic' }]])],
    ]);
    const result = await buildPrompt('hello', makeState(), topicNames);
    assert.ok(result.includes('Topic: test-topic'), 'should include topic name only');
    assert.ok(!result.includes('Topic: test-topic —'), 'should not have description separator');
  });

  it('does NOT include topic description when topicNames is undefined', async () => {
    const result = await buildPrompt('hello', makeState(), undefined);
    assert.ok(!result.includes('## Topic'), 'should not have topic section');
  });

  it('topic description appears before conversation history', async () => {
    const topicNames: TopicNameMap = new Map([
      ['-1001234567890', new Map([[29, { name: 'test-topic' }]])],
    ]);
    const result = await buildPrompt('hello', makeState(), topicNames);
    const topicIdx = result.indexOf('## Topic');
    const historyIdx = result.indexOf('## Conversation History');
    assert.ok(topicIdx >= 0, 'should have topic section');
    assert.ok(historyIdx >= 0, 'should have history section');
    assert.ok(topicIdx < historyIdx, 'topic should appear before history');
  });
});

// ---------------------------------------------------------------------------
// buildPrompt — topic brain pointer (WP1)
// ---------------------------------------------------------------------------

describe('buildPrompt: topic brain pointer', () => {
  // The literal standing-rule sentence from spec §3.5
  const STANDING_RULE_SENTENCE = 'Topic brains: when the Topic section names a topic brain file, read it before assuming prior context for this topic — it records durable facts, decisions, and open threads; fresh turns override it.';

  it('includes pointer line in Topic section when brain exists with stamp', async () => {
    const chatId = -1001234567890;
    const threadId = 8306;
    const state = makeState({ chat_id: chatId, thread_id: threadId });

    // Create a brain file with the spec §3.2 stamp
    const topicDir = join(tempDir, 'topic-brains', `${chatId}_${threadId}`);
    await mkdir(topicDir, { recursive: true });
    const brainContent = `# Test Topic

> Summary: Test topic.

<!-- topic-brain: consolidated=2026-08-21T21:30:00+05:30 covers=2026-08-21T18:03:11.000Z -->

## Current state
- Some state.
`;
    await writeFile(join(topicDir, 'BRAIN.md'), brainContent, 'utf8');

    const result = await buildPrompt('hello', state);
    assert.ok(result.includes('## Topic'), 'should have topic section');
    assert.ok(result.includes('Topic brain:'), 'should include pointer line prefix');
    assert.ok(result.includes('consolidated 2026-08-21'), 'should include consolidated date');
    assert.ok(result.includes('covers through 2026-08-21'), 'should include covers date');
    assert.ok(result.includes('durable per-topic knowledge'), 'should include pointer description');
  });

  it('includes degraded pointer when stamp is missing', async () => {
    const chatId = -1001234567890;
    const threadId = 8306;
    const state = makeState({ chat_id: chatId, thread_id: threadId });

    const topicDir = join(tempDir, 'topic-brains', `${chatId}_${threadId}`);
    await mkdir(topicDir, { recursive: true });
    const brainContent = `# Test Topic\n\n> Summary: No stamp.\n\n## Current state\n- State\n`;
    await writeFile(join(topicDir, 'BRAIN.md'), brainContent, 'utf8');

    const result = await buildPrompt('hello', state);
    assert.ok(result.includes('Topic brain:'), 'should include pointer');
    assert.ok(result.includes('freshness unknown'), 'should show degraded when stamp missing');
  });

  it('does NOT include pointer line when no brain exists', async () => {
    const state = makeState({ chat_id: -1001234567890, thread_id: 8306 });
    const result = await buildPrompt('hello', state);
    assert.ok(!result.includes('Topic brain:'), 'should not have pointer without brain file');
  });

  it('Topic section renders from pointer alone when topicNames has no entry', async () => {
    const chatId = -1001234567890;
    const threadId = 8306;
    const state = makeState({ chat_id: chatId, thread_id: threadId });

    const topicDir = join(tempDir, 'topic-brains', `${chatId}_${threadId}`);
    await mkdir(topicDir, { recursive: true });
    const brainContent = `# Test Topic\n\n<!-- topic-brain: consolidated=2026-08-21T21:30:00+05:30 covers=2026-08-21T18:03:11.000Z -->\n\n## Current state\n`;
    await writeFile(join(topicDir, 'BRAIN.md'), brainContent, 'utf8');

    const result = await buildPrompt('hello', state, undefined); // No topicNames
    assert.ok(result.includes('## Topic'), 'should have topic section from pointer alone');
    assert.ok(!result.includes('Topic:'), 'should not have topic description line');
    assert.ok(result.includes('Topic brain:'), 'should have pointer');
  });

  it('pointer survives omitStatic: true (dynamic content)', async () => {
    const chatId = -1001234567890;
    const threadId = 8306;
    const state = makeState({ chat_id: chatId, thread_id: threadId });

    const topicDir = join(tempDir, 'topic-brains', `${chatId}_${threadId}`);
    await mkdir(topicDir, { recursive: true });
    const brainContent = `# Test Topic\n\n<!-- topic-brain: consolidated=2026-08-21T21:30:00+05:30 covers=2026-08-21T18:03:11.000Z -->\n\n## Current state\n`;
    await writeFile(join(topicDir, 'BRAIN.md'), brainContent, 'utf8');

    const result = await buildPrompt('hello', state, undefined, undefined, undefined, { omitStatic: true });
    assert.ok(!result.includes('You are a personal assistant'), 'identity should be omitted');
    assert.ok(!result.includes('Capabilities & Rules'), 'static capabilities should be omitted');
    assert.ok(result.includes('Topic brain:'), 'pointer should survive omitStatic');
    assert.ok(result.includes('## Topic'), 'topic section should survive omitStatic');
  });

  it('buildResumedPrompt does NOT include Topic brain: line (regression guard for decision-7)', async () => {
    const result = await buildResumedPrompt('hello');
    assert.ok(!result.includes('Topic brain:'), 'buildResumedPrompt must not include topic brain pointer');
  });

  it('long-description interim (§3.11): 400+ char hand-set description renders IN FULL alongside pointer line', async () => {
    const chatId = -1001234567890;
    const threadId = 8306;
    const state = makeState({ chat_id: chatId, thread_id: threadId });

    // Create a 400+ char hand-set description
    const longDescription = 'This is a very long topic description that exceeds four hundred characters in length. It contains detailed information about what this topic covers, including historical context, ongoing discussions, and important decisions made. The description continues with even more details about the domain specifics, technical constraints, and architectural considerations. It goes on to explain the various aspects of the system being discussed, including edge cases, performance considerations, and future plans. This description is meant to test that the system properly preserves long-form hand-authored content without truncation. Additional context paragraphs are included here to ensure we comfortably exceed the four hundred character threshold and verify that the full description renders correctly in the prompt output.';

    assert.ok(longDescription.length > 400, 'test description must be 400+ chars');

    const topicNames: TopicNameMap = new Map([
      [String(chatId), new Map([[threadId, { name: 'long-desc-topic', description: longDescription }]])],
    ]);

    // Create a brain file with stamp
    const topicDir = join(tempDir, 'topic-brains', `${chatId}_${threadId}`);
    await mkdir(topicDir, { recursive: true });
    const brainContent = `# Test Topic\n\n<!-- topic-brain: consolidated=2026-08-21T21:30:00+05:30 covers=2026-08-21T18:03:11.000Z -->\n\n## Current state\n`;
    await writeFile(join(topicDir, 'BRAIN.md'), brainContent, 'utf8');

    const result = await buildPrompt('hello', state, topicNames);

    // Both description and pointer must appear in the same prompt
    assert.ok(result.includes(longDescription), 'full 400+ char description must render un-truncated');
    assert.ok(result.includes('Topic brain:'), 'pointer line must also appear');
    assert.ok(result.includes('Topic: long-desc-topic —'), 'topic name line must appear');

    // Verify the description appears in full, not truncated or restated
    const descCount = (result.match(new RegExp(longDescription.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    assert.equal(descCount, 1, 'description must appear exactly once, not restated or duplicated');
  });

  it('both-places test: standing-rule sentence appears in bot-instructions.md and inline capabilities', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally' }, async () => {
    // Check bot-instructions.md contains the sentence
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(STANDING_RULE_SENTENCE), 'bot-instructions.md must contain the standing-rule sentence verbatim');

    // Check buildPrompt inline capabilities contains the same sentence
    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(STANDING_RULE_SENTENCE), 'context.ts inline capabilities block must contain the SAME sentence verbatim — keep both in sync');
  });
});

// ---------------------------------------------------------------------------
// buildPrompt — recall pointer line (recall-traces wave, WP-B / spec §3.2 step 6)
// ---------------------------------------------------------------------------

describe('buildPrompt: recall pointer line', () => {
  it('includes thread-scoped recall pointer in Topic section when a topic name renders it', async () => {
    const chatId = -1001234567890;
    const threadId = 7822;
    const state = makeState({ chat_id: chatId, thread_id: threadId });
    const topicNames: TopicNameMap = new Map([
      [String(chatId), new Map([[threadId, { name: 'test-topic' }]])],
    ]);

    const result = await buildPrompt('hello', state, topicNames);
    assert.ok(result.includes('## Topic'), 'should have topic section');
    assert.ok(result.includes('--thread 7822 --json'), 'recall pointer should be scoped to this state\'s thread_id');
    assert.ok(result.includes('Recall:'), 'should include the recall pointer prefix');
  });

  it('does NOT create a Topic section on its own (no name, no brain)', async () => {
    const chatId = -1001234567890;
    const threadId = 9999;
    const state = makeState({ chat_id: chatId, thread_id: threadId });

    const result = await buildPrompt('hello', state, undefined);
    assert.ok(!result.includes('## Topic'), 'recall pointer alone must not render a Topic section');
  });
});

// ---------------------------------------------------------------------------
// Integration test — full prompt building flow
// ---------------------------------------------------------------------------

describe('integration: full prompt building flow', () => {
  it('builds complete prompt with all sections', async () => {
    const state = makeState({
      turns: [
        { role: 'user', text: 'previous message', timestamp: '2026-04-16T10:00:00+05:30' },
        { role: 'assistant', text: 'previous response', timestamp: '2026-04-16T10:01:00+05:30' },
      ],
    });
    const topicNames: TopicNameMap = new Map([
      ['-1001234567890', new Map([[29, { name: 'test-topic', description: 'Test description' }]])],
    ]);
    const result = await buildPrompt('did the skill run?', state, topicNames);
    // Verify all major sections are present
    assert.ok(result.includes('You are a personal assistant'), 'should have identity');
    assert.ok(result.includes('Today is'), 'should have date');
    assert.ok(result.includes('+05:30'), 'should have IST offset');
    assert.ok(result.includes('## Topic'), 'should have topic section');
    assert.ok(result.includes('Topic: test-topic — Test description'), 'should have topic with description');
    assert.ok(result.includes('PA Skill Status'), 'should have skill status (triggered by keyword)');
    assert.ok(result.includes('## Conversation History'), 'should have history');
    assert.ok(result.includes('previous message'), 'should have user turn in history');
    assert.ok(result.includes('previous response'), 'should have assistant turn in history');
    assert.ok(result.includes('did the skill run?'), 'should have current message');
    assert.ok(result.includes('Capabilities & Rules'), 'should have capabilities');
    assert.ok(result.includes('[PA_META]'), 'should have PA_META');
    // Verify order: topic before history
    const topicIdx = result.indexOf('## Topic');
    const historyIdx = result.indexOf('## Conversation History');
    assert.ok(topicIdx < historyIdx, 'topic should appear before history');
  });
});

// ---------------------------------------------------------------------------
// buildPrompt — priorContext injection
// ---------------------------------------------------------------------------

describe('buildPrompt: priorContext', () => {
  it('does NOT include Prior Worker Context section when omitted', async () => {
    const result = await buildPrompt('hello', makeState());
    assert.ok(!result.includes('## Prior Worker Context'), 'should not have prior worker section');
  });

  it('includes worker name and session path when priorContext is given with a path', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, {
      priorContext: { worker: 'zclaude', sessionId: 'abc-123', sessionPath: '/home/user/.claude/projects/D--PA/abc-123.jsonl' },
    });
    assert.ok(result.includes('## Prior Worker Context'), 'should have prior worker section');
    assert.ok(result.includes('zclaude'), 'should mention the worker name');
    assert.ok(result.includes('/home/user/.claude/projects/D--PA/abc-123.jsonl'), 'should include the session path');
    assert.ok(result.includes('Session transcript:'), 'should have session transcript label');
  });

  it('includes session ID fallback text when sessionPath is null', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, {
      priorContext: { worker: 'codex', sessionId: 'some-uuid-here', sessionPath: null },
    });
    assert.ok(result.includes('## Prior Worker Context'), 'should have prior worker section');
    assert.ok(result.includes('codex'), 'should mention the worker name');
    assert.ok(result.includes('some-uuid-here'), 'should include the session ID');
    assert.ok(result.includes('no transcript file available'), 'should include fallback text');
    assert.ok(!result.includes('Session transcript:'), 'should NOT have session transcript label');
  });
});

// ---------------------------------------------------------------------------
// buildPrompt: cwd sections (WP1)
// ---------------------------------------------------------------------------

describe('buildPrompt: cwd sections', () => {
  it('renders no cwd section when workdir option not provided', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined);
    assert.ok(!result.includes('## Working Directory'), 'should NOT have cwd section');
  });

  it('renders override tier text for cwd_override', async () => {
    const state = makeState({ cwd_override: 'D:/Custom/path' });
    const result = await buildPrompt('hello', state, undefined, undefined, undefined, {
      workdir: { dir: 'D:/Custom/path', tier: 'override' }
    });
    assert.ok(result.includes('## Working Directory'), 'should have cwd section');
    assert.ok(result.includes('You are operating in: \`D:/Custom/path\`'), 'should show the path');
    assert.ok(result.includes('This is the project root for all file operations'), 'should have override tier text');
    assert.ok(!result.includes('scratch space'), 'should NOT have topic-home text');
  });

  it('renders project tier text for project pointer', async () => {
    const state = makeState();
    const result = await buildPrompt('hello', state, undefined, undefined, undefined, {
      workdir: { dir: 'D:/Project/path', tier: 'project' }
    });
    assert.ok(result.includes('## Working Directory'), 'should have cwd section');
    assert.ok(result.includes('You are operating in: \`D:/Project/path\`'), 'should show the path');
    assert.ok(result.includes('This is the project root for all file operations'), 'should have project tier text');
    assert.ok(!result.includes('scratch space'), 'should NOT have topic-home text');
  });

  it('renders topic-home tier text with repo hint', async () => {
    const state = makeState();
    const result = await buildPrompt('hello', state, undefined, undefined, undefined, {
      workdir: { dir: '/tmp/topic-brains/-1001234567890_8306', tier: 'topic-home' }
    });
    assert.ok(result.includes('## Working Directory'), 'should have cwd section');
    assert.ok(result.includes('You are operating in the topic workspace:'), 'should have topic workspace label');
    assert.ok(result.includes('use \`scratch/\` for files you create'), 'should mention scratch directory');
    assert.ok(result.includes('It is not a code repository: for repo work use absolute paths'), 'should have repo hint');
    assert.ok(result.includes('the main repository is at'), 'should name the repo location');
  });

  it('renders no cwd section when workdir option not provided (fallback)', async () => {
    const state = makeState();
    const result = await buildPrompt('hello', state, undefined, undefined, undefined, {
      // no workdir option - fallback tier produces byte-identical prompts
    });
    assert.ok(!result.includes('## Working Directory'), 'should NOT have cwd section (fallback tier produces byte-identical prompts)');
  });
});

// ---------------------------------------------------------------------------
// buildPrompt — active reservations injection (C1b, coordination-remediation Wave C, W-C6)
// ---------------------------------------------------------------------------
// buildReservationLines is not exported; exercised only through buildPrompt's
// injectable `readActiveFn` option — the same `<name>Fn?:` DI pattern used
// elsewhere in the bot (voice.ts, voice-worker-client.ts) — so these tests never
// touch the real ~/.pa reservations store.

function makeReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 'r-abc12345',
    paths: ['pa/src/foo.ts'],
    session: 'builder-x',
    note: 'doing a thing',
    claimedAt: '2026-08-23T10:00:00.000Z',
    expiresAt: '2026-08-23T10:30:00.000Z',
    ...overrides,
  };
}

const RESERVATIONS_HEADER = '- Active reservations right now (do not edit these paths unless the reservation is yours):';
const RESERVATIONS_MIRROR_ANCHOR = '(Mirrors the Shared working tree block in bot-instructions.md and examples/bot-instructions.example.md';

describe('buildPrompt: active reservations (W-C6)', () => {
  it('stubbed readActive returning two reservations: both rows present, directly after the mirror-note line', async () => {
    const r1 = makeReservation({ id: 'r-11111111', paths: ['pa/src/a.ts'], session: 'sess-a', note: 'work a', expiresAt: '2026-08-23T11:00:00.000Z' });
    const r2 = makeReservation({ id: 'r-22222222', paths: ['pa/src/b.ts'], session: 'sess-b', note: 'work b', expiresAt: '2026-08-23T12:00:00.000Z' });
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, {
      readActiveFn: async () => [r1, r2],
    });
    assert.ok(result.includes(RESERVATIONS_HEADER), 'header row present');
    assert.ok(result.includes('r-11111111'), 'first reservation id present');
    assert.ok(result.includes('r-22222222'), 'second reservation id present');
    assert.ok(result.includes('sess-a'), 'first session present');
    assert.ok(result.includes('sess-b'), 'second session present');

    const mirrorIdx = result.indexOf(RESERVATIONS_MIRROR_ANCHOR);
    const headerIdx = result.indexOf(RESERVATIONS_HEADER);
    const topicBrainsIdx = result.indexOf('- Topic brains:');
    assert.ok(mirrorIdx >= 0, 'mirror-note line present');
    assert.ok(headerIdx > mirrorIdx, 'reservation block must come directly after the mirror-note line');
    assert.ok(headerIdx < topicBrainsIdx, 'reservation block must come before the Topic brains bullet');
  });

  it('zero reservations: "Active reservations right now: none." present', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, {
      readActiveFn: async () => [],
    });
    assert.ok(result.includes('- Active reservations right now: none.'), 'should show the none line');
  });

  it('readActive rejects: neither string present, prompt still complete', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, {
      readActiveFn: async () => { throw new Error('reservation store unavailable'); },
    });
    assert.ok(!result.includes('Active reservations right now'), 'no reservation text on throw');
    assert.ok(result.includes('## Capabilities & Rules'), 'prompt still complete on throw');
  });

  it('omitStatic: true — no reservation text at all', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, {
      omitStatic: true,
      readActiveFn: async () => [makeReservation()],
    });
    assert.ok(!result.includes('Active reservations right now'), 'no reservation text in lean mode');
  });

  it('pendingAction set — no reservation text at all', async () => {
    const result = await buildPrompt('yes', makeState(), undefined, undefined, 'send email to John', {
      readActiveFn: async () => [makeReservation()],
    });
    assert.ok(!result.includes('Active reservations right now'), 'no reservation text in execution mode');
  });

  it('12 active reservations: exactly 10 rows plus a "(+2 more" line', async () => {
    const reservations = Array.from({ length: 12 }, (_, i) =>
      makeReservation({ id: `r-${String(i).padStart(8, '0')}`, session: `sess-${i}` })
    );
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, {
      readActiveFn: async () => reservations,
    });
    const rowLines = result.split('\n').filter((l) => /^ {2}- r-\d{8} /.test(l));
    assert.equal(rowLines.length, 10, 'exactly 10 reservation rows rendered');
    assert.ok(result.includes('(+2 more'), 'overflow line present');
  });

  it('a reservation with 5 paths: 3 paths plus "(+2 more)"', async () => {
    const r = makeReservation({ paths: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] });
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, {
      readActiveFn: async () => [r],
    });
    assert.ok(result.includes('a.ts, b.ts, c.ts (+2 more)'), 'first 3 paths plus overflow marker');
    assert.ok(!result.includes('d.ts'), 'path 4 must not appear');
    assert.ok(!result.includes('e.ts'), 'path 5 must not appear');
  });

  it('buildResumedPrompt output contains no reservation text', async () => {
    const result = await buildResumedPrompt('hello');
    assert.ok(!result.includes('Active reservations right now'), 'buildResumedPrompt must never include reservation text');
  });
});
