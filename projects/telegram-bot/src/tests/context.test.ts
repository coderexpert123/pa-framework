import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { buildResumedPrompt, buildPrompt, shouldIncludeSkillStatus, buildSkillStatus, _resetSkillStatusCache, _resetSkillRosterCache, renderSkillRosterSection } from '../context.js';
import { resolveReplyContext } from '../reply-context.js';
import type { ConversationState } from '../types.js';
import type { TopicNameMap } from '../topic-names.js';
import type { Reservation } from '../../../../pa/dist/src/lib/reservations.js';
import {
  appendTask,
  claimNextTask,
  TOPIC_TASK_MAX_ATTEMPTS,
  addNote,
  closeNote,
} from '../../../../pa/dist/src/lib/topic-tasks.js';
import { waitForDrain } from './test-teardown-guard.js';

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
  _resetSkillRosterCache();
});

afterEach(async () => {
  await waitForDrain();
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
  it('Grounding Sources rule matches bot-instructions.md and context.ts inline (public-brain wave WP-B4)', async () => {
    const content = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    // bot-instructions.md now has <configured PA_KB_SOURCES_PATH> instead of hardcoded path
    const GROUNDING_PREFIX = 'Systems of record:';
    assert.ok(content.includes(GROUNDING_PREFIX), 'bot-instructions.md must contain the Grounding Sources prefix');
    assert.ok(content.includes('<configured PA_KB_SOURCES_PATH>'), 'bot-instructions.md must use configured placeholder (not hardcoded path)');
    // context.ts emits the bullet ONLY when PA_KB_SOURCES_PATH is set
    const originalValue = process.env.PA_KB_SOURCES_PATH;
    process.env.PA_KB_SOURCES_PATH = 'C:/notes/Ecosystem KB/';
    try {
      const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
      assert.ok(inlinePrompt.includes(GROUNDING_PREFIX), 'context.ts inline capabilities must include the bullet when env is set');
    } finally {
      if (originalValue === undefined) {
        delete process.env.PA_KB_SOURCES_PATH;
      } else {
        process.env.PA_KB_SOURCES_PATH = originalValue;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AI-249: the PA_META template must never teach a placeholder action type.
// A live model copied the literal placeholder verbatim (twice): the envelope
// parsed, no handler matched, and the action vanished silently. Four surfaces
// teach the envelope: context.ts's inline block (agy/codex half), the
// gitignored bot-instructions.md (skip-guarded), the tracked example
// (CI-enforced half), and orchestrator.ts's fresh-prompt template.
// ---------------------------------------------------------------------------
const OLD_TEMPLATE_LITERAL = '"type":"T"';
const NEW_TEMPLATE = '{"actions":[...]}';
// The orchestrator fresh-prompt surface carries suggested_items inside the
// same envelope, so its action-less placeholder reads differently.
const NEW_TEMPLATE_ORCHESTRATOR = '{"actions":[...], "suggested_items"';
const ORCHESTRATOR_SRC_PATH = resolve(__dirname, '../../src/orchestrator.ts');

describe('AI-249: PA_META template placeholder removed from all four surfaces', () => {
  it('context.ts inline block: old literal absent, new template present', async () => {
    const prompt = await buildPrompt('hello', makeState(), undefined);
    assert.ok(!prompt.includes(OLD_TEMPLATE_LITERAL), 'the inline PA_META template must not teach a placeholder type');
    assert.ok(prompt.includes(NEW_TEMPLATE), 'the inline PA_META template must use the action-less placeholder');
  });

  it('examples/bot-instructions.example.md (tracked, CI-enforced half)', async () => {
    const content = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(!content.includes(OLD_TEMPLATE_LITERAL));
    assert.ok(content.includes(NEW_TEMPLATE));
  });

  it('bot-instructions.md (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally' }, async () => {
    const content = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(!content.includes(OLD_TEMPLATE_LITERAL));
    assert.ok(content.includes(NEW_TEMPLATE));
  });

  it('orchestrator.ts fresh-prompt template (source pin)', async () => {
    const content = await readFile(ORCHESTRATOR_SRC_PATH, 'utf8');
    assert.ok(!content.includes(OLD_TEMPLATE_LITERAL));
    assert.ok(content.includes(NEW_TEMPLATE_ORCHESTRATOR));
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
// Reminder-discipline teaching sync (AI-207 reminder-delivery wave,
// 2026-09-05): the two anchor sentences below must stay byte-identical
// across the three teaching surfaces — context.ts's inline capabilities
// block (agy/codex never receive bot-instructions.md), examples/
// bot-instructions.example.md (tracked, CI-enforced half) and the
// gitignored local bot-instructions.md (skip-guarded half). Same
// prompt-triangle pattern as the anchor sentences above.
// ---------------------------------------------------------------------------

const REMINDER_ANCHOR_1 = 'Reminder messages are operator-facing: `message` must be plain language a person can act on, never an instruction for a future assistant session.';

const REMINDER_ANCHOR_2 = 'Schedule work for a future session with `--resume-action-json` instead — it dispatches into the topic queue, and pass `--no-keyboard` for system-executed work: buttons render only when a human decision is genuinely required.';

describe('Reminder discipline sync (AI-207)', () => {
  it('matches examples/bot-instructions.example.md verbatim', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(REMINDER_ANCHOR_1),
      'examples/bot-instructions.example.md must contain the Reminder ANCHOR_1 sentence verbatim');
    assert.ok(exampleContent.includes(REMINDER_ANCHOR_2),
      'examples/bot-instructions.example.md must contain the Reminder ANCHOR_2 sentence verbatim');
  });

  it('appears in the inline capabilities block verbatim', async () => {
    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(REMINDER_ANCHOR_1),
      'context.ts inline capabilities block must contain the Reminder ANCHOR_1 sentence verbatim');
    assert.ok(inlinePrompt.includes(REMINDER_ANCHOR_2),
      'context.ts inline capabilities block must contain the Reminder ANCHOR_2 sentence verbatim');
  });

  it('matches bot-instructions.md verbatim (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(REMINDER_ANCHOR_1),
      'bot-instructions.md must contain the Reminder ANCHOR_1 sentence verbatim');
    assert.ok(botInstructionsContent.includes(REMINDER_ANCHOR_2),
      'bot-instructions.md must contain the Reminder ANCHOR_2 sentence verbatim');
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
// Cross-topic delivery / raw-send guard bullet (2026-09-04,
// plans/2026-09-04-raw-send-guard-SPEC.md WP1) — an agy worker hand-wrote a
// scratch script that called the raw Telegram /sendMessage Bot API into
// pa-support, bypassing ref-minting and logging. Same byte-identical-across-
// files sync pattern as the anchors above: examples/bot-instructions.example.md
// is the CI-enforced half; context.ts's inline capabilities block is the
// agy/codex-visible half.
// ---------------------------------------------------------------------------

const RAW_SEND_GUARD_ANCHOR_SENTENCE = 'NEVER call the Telegram Bot API directly — no api.telegram.org calls, no sendMessage, no bot-token fetches; no scratch scripts, no curl, no SDK.';

describe('Raw-send guard prompt bullet', () => {
  it('matches examples/bot-instructions.example.md verbatim', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(RAW_SEND_GUARD_ANCHOR_SENTENCE),
      'examples/bot-instructions.example.md must contain the raw-send guard anchor sentence verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(RAW_SEND_GUARD_ANCHOR_SENTENCE),
      'context.ts inline capabilities block must contain the SAME sentence verbatim — keep both in sync');
  });

  it('is absent in omitStatic (lean) mode', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: true });
    assert.ok(!result.includes(RAW_SEND_GUARD_ANCHOR_SENTENCE), 'lean mode must not include the raw-send guard bullet');
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
// watch_job standing-rule bullet (AI-170, plans/2026-08-31-ai170-async-watch-SPEC.md §2.9)
// ---------------------------------------------------------------------------
// Same byte-identical-across-three-files sync pattern as the Shared working tree
// and @build anchors above: examples/bot-instructions.example.md is the CI-enforced
// half; the local bot-instructions.md half stays skip-guarded (untracked).

const WATCH_JOB_BULLET = '- Never promise to report back later: you are a one-shot process with no timer, so "I\'ll let you know when it finishes" never fires. If the result will land in a file or a process you can name, emit a `watch_job` PA_META action and say the watch is registered; otherwise tell the user the exact command or file that will show them the answer.';

// ---------------------------------------------------------------------------
// watch_job check-shape example (AI-181, BACKLOG.md) — the first live use of
// watch_job armed NOTHING: the worker guessed the check shape (no "type") and
// validateWatchInput rejected it ("unknown check type: "), because the PA_META
// docs named `check` but never showed its object shape. All three synced
// surfaces must now carry the exact shape plus a copy-pasteable example.
// ---------------------------------------------------------------------------

const WATCH_CHECK_SHAPE_EXAMPLE = '"check":{"type":"file_newer_than","path":"';

describe('watch_job check-shape example (AI-181)', () => {
  it('appears in examples/bot-instructions.example.md and the inline capabilities', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(WATCH_CHECK_SHAPE_EXAMPLE),
      'examples/bot-instructions.example.md must show the exact check object shape');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(WATCH_CHECK_SHAPE_EXAMPLE),
      'context.ts inline PA_META docs must show the exact check object shape');
  });

  it('appears in bot-instructions.md (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(WATCH_CHECK_SHAPE_EXAMPLE),
      'bot-instructions.md must show the exact check object shape');
  });
});

describe('watch_job standing-rule bullet (AI-170)', () => {
  it('matches examples/bot-instructions.example.md verbatim', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(WATCH_JOB_BULLET),
      'examples/bot-instructions.example.md must contain the watch_job bullet verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(WATCH_JOB_BULLET),
      'context.ts inline capabilities block must contain the SAME watch_job bullet verbatim — keep both in sync');
  });

  it('matches bot-instructions.md verbatim (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(WATCH_JOB_BULLET),
      'bot-instructions.md must contain the watch_job bullet verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(WATCH_JOB_BULLET),
      'context.ts inline capabilities block must contain the SAME watch_job bullet verbatim — keep both in sync');
  });

  it('is absent in omitStatic (lean) mode', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: true });
    assert.ok(!result.includes(WATCH_JOB_BULLET), 'watch_job bullet must be absent in lean mode');
  });

  it('is absent in execution mode (pendingAction set)', async () => {
    const result = await buildPrompt('yes', makeState(), undefined, undefined, 'send email to John', { omitStatic: false });
    assert.ok(!result.includes(WATCH_JOB_BULLET), 'watch_job bullet must be absent in execution mode');
  });
});

// ---------------------------------------------------------------------------
// reauth resume guidance bullet (AI-181) — the topic_resume auto-resume
// feature arms workers blocked on Google auth with a mintable reauth link
// that, when /auth completes, injects the pending prompt as a system turn.
// All three synced prompt surfaces must carry the exact guidance.
// ---------------------------------------------------------------------------

const REAUTH_RESUME_BULLET = `- Blocked on Google auth mid-task: mint a resumable reauth link instead of exiting — run python3 <repo>/pa/scripts/start_google_telegram_reauth.py --redirect-uri <GOOGLE_AUTH_REDIRECT_URI from ~/.pa/secrets.env> --chat-id <chat> --thread-id <thread> || python <repo>/pa/scripts/start_google_telegram_reauth.py --redirect-uri <GOOGLE_AUTH_REDIRECT_URI from ~/.pa/secrets.env> --chat-id <chat> --thread-id <thread> (IDs from your Telegram Metadata section; <repo> from your Working Directory section) --resume-action-json '{"type":"topic_resume","prompt":"<the waiting work, one line, <=500 chars>"}'. The link posts to that chat/thread, and once the user completes /auth the bot re-dispatches your prompt into the topic automatically as a system turn. For a skill-shaped blockage prefer telling the user to run /reauth <skill-name>. Never mint a mid-task reauth link without a resume payload.`;

describe('reauth resume guidance bullet (AI-181)', () => {
  it('matches examples/bot-instructions.example.md verbatim', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(REAUTH_RESUME_BULLET),
      'examples/bot-instructions.example.md must contain the reauth resume bullet verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(REAUTH_RESUME_BULLET),
      'context.ts inline capabilities block must contain the SAME reauth resume bullet verbatim — keep both in sync');
  });

  it('matches bot-instructions.md verbatim (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(REAUTH_RESUME_BULLET),
      'bot-instructions.md must contain the reauth resume bullet verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(REAUTH_RESUME_BULLET),
      'context.ts inline capabilities block must contain the SAME reauth resume bullet verbatim — keep both in sync');
  });

  it('is absent in omitStatic (lean) mode', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: true });
    assert.ok(!result.includes(REAUTH_RESUME_BULLET), 'reauth resume bullet must be absent in lean mode');
  });

  it('is absent in execution mode (pendingAction set)', async () => {
    const result = await buildPrompt('yes', makeState(), undefined, undefined, 'send email to John', { omitStatic: false });
    assert.ok(!result.includes(REAUTH_RESUME_BULLET), 'reauth resume bullet must be absent in execution mode');
  });
});

// ---------------------------------------------------------------------------
// PA_META question vocabulary (2026-09-02, handover Wave 1 SPEC §3.3) — the
// closed-shape `question{text,options}` action must be taught on ALL THREE
// prompt surfaces in the same commit (prompt-triangle convention). Bullet
// text is FROZEN in the spec; the deployed bot-instructions.md is hand-synced
// (gitignored — never rides git patches).
// ---------------------------------------------------------------------------

const QUESTION_TYPES_ROW = 'question{text,options}';
const QUESTION_BULLET =
  'you need the user to pick one of up to 4 options — the reply renders option buttons; their press is injected back into the topic as your answer. text (the question, <=500 chars), options (1-4 strings, <=40 chars each), taskId (optional, <=64 chars, links the answer to a queued task).';

describe('PA_META question vocabulary present in all three surfaces', () => {
  it('context.ts carries the Types-line entry and the frozen bullet', async () => {
    // Tests run from dist/tests/ — the source file is two levels up, under src/.
    const contextSource = await readFile(resolve(__dirname, '../../src/context.ts'), 'utf8');
    assert.ok(contextSource.includes(QUESTION_TYPES_ROW),
      'context.ts PA_META Types line must include question{text,options}');
    assert.ok(contextSource.includes(`question = ${QUESTION_BULLET}`),
      'context.ts PA_META prose must carry the frozen question bullet verbatim');
  });

  it('examples/bot-instructions.example.md carries the frozen bullet', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(QUESTION_TYPES_ROW),
      'examples/bot-instructions.example.md must include question{text,options}');
    assert.ok(exampleContent.includes(QUESTION_BULLET),
      'examples/bot-instructions.example.md must contain the frozen question bullet verbatim');
  });

  it('deployed bot-instructions.md carries the frozen bullet (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(QUESTION_TYPES_ROW),
      'deployed bot-instructions.md must include question{text,options} — hand-sync on merge');
    assert.ok(botInstructionsContent.includes(QUESTION_BULLET),
      'deployed bot-instructions.md must contain the frozen question bullet verbatim — hand-sync on merge');
  });
});

// ---------------------------------------------------------------------------
// Next-actions block (2026-09-11 action-block SPEC ITEM 1) — a reply that
// leaves steps outstanding must end in a NEXT ACTIONS block. The frozen
// bullet is taught on EVERY reply-shaping surface: the context capabilities
// block, the task-lane TASK_RULES (which also feeds the thread lane), the
// orchestrator's self-contained role prompt, and the hand-synced instruction
// files (prompt-triangle convention).
// ---------------------------------------------------------------------------

const NEXT_ACTIONS_BULLET =
  'Next-actions block: when your reply leaves any step outstanding — including a finding, risk, or incomplete item your own work surfaced that nobody has acted on yet, even if you were not asked to act on it and even if your own task is otherwise done — end it with the literal line NEXT ACTIONS, then one numbered line per outstanding step in execution order, each tagged You or Assistant so the next actor is explicit. Every next step named in the reply appears in the block, and the block contains nothing that is not a real step; an Assistant step must be concretely queued or part of a confirmed plan, never a vague promise. When a write action awaits confirmation, the final numbered item is the existing yes-or-no confirmation sentence and it stays the reply\'s last line. Omit the block only for a plain answer or a task that finished with nothing left to decide. The block is the last visible text, after any Details heading and before any machine footer line.';

describe('Next-actions block bullet present in all reply-shaping surfaces', () => {
  it('context.ts carries the frozen bullet', async () => {
    // Tests run from dist/tests/ — the source file is two levels up, under src/.
    const contextSource = await readFile(resolve(__dirname, '../../src/context.ts'), 'utf8');
    assert.ok(contextSource.includes(NEXT_ACTIONS_BULLET),
      'context.ts capabilities block must contain the frozen next-actions bullet verbatim');
  });

  it('examples/bot-instructions.example.md carries the frozen bullet', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(NEXT_ACTIONS_BULLET),
      'examples/bot-instructions.example.md must contain the frozen next-actions bullet verbatim');
  });

  it('deployed bot-instructions.md carries the frozen bullet (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(NEXT_ACTIONS_BULLET),
      'deployed bot-instructions.md must contain the frozen next-actions bullet verbatim — hand-sync on merge');
  });

  it('task-executor.ts carries the frozen bullet in TASK_RULES', async () => {
    const taskExecutorSource = await readFile(resolve(__dirname, '../../src/task-executor.ts'), 'utf8');
    assert.ok(taskExecutorSource.includes(`- ${NEXT_ACTIONS_BULLET}`),
      'task-executor.ts TASK_RULES must carry the frozen next-actions bullet verbatim');
  });

  it('orchestrator.ts carries the frozen bullet as a role bullet', async () => {
    const orchestratorSource = await readFile(resolve(__dirname, '../../src/orchestrator.ts'), 'utf8');
    assert.ok(orchestratorSource.includes(`- ${NEXT_ACTIONS_BULLET}`),
      'orchestrator.ts role section must carry the frozen next-actions bullet verbatim');
  });
});

// ---------------------------------------------------------------------------
// Voice-transcript caveat (2026-09-16 evangelism wave WP-4, OD-6) — the live
// bot-instructions.md `## Voice Messages` paragraph is claude/zclaude-only via
// --append-system-prompt-file; agy/codex and the orchestrator lane never saw
// it. The two-sentence anchor below is FROZEN verbatim from the live file
// (:67-68) and pinned on every transcript-reading surface. The anchor carries
// backticks, so .ts sources are compared after unescaping `\`` template
// escapes.
// ---------------------------------------------------------------------------

const VOICE_CAVEAT_ANCHOR =
  'Messages prefixed `[Voice message]` (or `[Audio file]` / `[Video note]`) are speech-to-text transcripts, not typed text. They may contain recognition errors, especially for names and numbers — read odd or out-of-context phrasing as likely mishearing, not a literal statement.';

const unescapeTicks = (s: string) => s.replaceAll('\\`', '`');

describe('voice-transcript caveat present on every transcript-reading surface', () => {
  it('context.ts capabilities block carries the anchor verbatim', async () => {
    const contextSource = unescapeTicks(await readFile(resolve(__dirname, '../../src/context.ts'), 'utf8'));
    assert.ok(contextSource.includes(`- ${VOICE_CAVEAT_ANCHOR}`),
      'context.ts capabilities block must carry the voice caveat verbatim');
  });

  it('orchestrator.ts role bullets carry the anchor verbatim', async () => {
    const orchestratorSource = unescapeTicks(await readFile(resolve(__dirname, '../../src/orchestrator.ts'), 'utf8'));
    assert.ok(orchestratorSource.includes(`- ${VOICE_CAVEAT_ANCHOR}`),
      'orchestrator.ts role section must carry the voice caveat verbatim');
  });

  it('examples/bot-instructions.example.md carries the anchor inside ## Voice Messages', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes('## Voice Messages'),
      'example file must have a ## Voice Messages section');
    assert.ok(exampleContent.includes(VOICE_CAVEAT_ANCHOR),
      'example file must carry the voice caveat verbatim');
  });

  it('deployed bot-instructions.md carries the anchor (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(VOICE_CAVEAT_ANCHOR),
      'deployed bot-instructions.md must carry the voice caveat verbatim');
  });
});

// ---------------------------------------------------------------------------
// Operator-commands bullet (2026-09-16 evangelism wave WP-6, OD-5/OD-8) —
// pa ping/notify/watch/topic-task/ref/health/doctor existed but no worker
// prompt named them. The bullet below is FROZEN (SPEC-prescribed text) and
// pinned on all four triangle surfaces; .ts sources compare after unescaping
// template-literal `\`` escapes.
// ---------------------------------------------------------------------------

const OPERATOR_COMMANDS_BULLET =
  '- Page the operator when only they can unblock you: `pa ping`. Deliver into another topic: `pa notify --topic-thread <id>`. Register a completion watch: `pa watch add`. Queue follow-up work: `pa topic-task add <chatId>_<threadId> --title "<t>" --prompt "<p>"`. `_Ref:` lookup: `pa ref <id>`. Platform looks broken: `pa health`, then `pa doctor`.';

describe('operator-commands bullet present on all four triangle surfaces', () => {
  it('context.ts capabilities block carries the bullet verbatim', async () => {
    const contextSource = unescapeTicks(await readFile(resolve(__dirname, '../../src/context.ts'), 'utf8'));
    assert.ok(contextSource.includes(OPERATOR_COMMANDS_BULLET),
      'context.ts capabilities block must carry the operator-commands bullet verbatim');
  });

  it('task-executor.ts TASK_RULES carries the bullet verbatim', async () => {
    const taskExecutorSource = await readFile(resolve(__dirname, '../../src/task-executor.ts'), 'utf8');
    assert.ok(taskExecutorSource.includes(OPERATOR_COMMANDS_BULLET),
      'task-executor.ts TASK_RULES must carry the operator-commands bullet verbatim');
  });

  it('examples/bot-instructions.example.md carries the bullet inside ## Capabilities & Rules', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    const sectionStart = exampleContent.indexOf('## Capabilities & Rules');
    const sectionEnd = exampleContent.indexOf('\n## ', sectionStart);
    assert.ok(sectionStart !== -1 && sectionEnd !== -1, 'example file must have a ## Capabilities & Rules section');
    assert.ok(exampleContent.slice(sectionStart, sectionEnd).includes(OPERATOR_COMMANDS_BULLET),
      'example file must carry the operator-commands bullet verbatim inside ## Capabilities & Rules');
  });

  it('deployed bot-instructions.md carries the bullet (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(OPERATOR_COMMANDS_BULLET),
      'deployed bot-instructions.md must carry the operator-commands bullet verbatim');
  });

  it('the bullet is <=400 chars and apostrophe-free', () => {
    assert.ok(OPERATOR_COMMANDS_BULLET.length <= 400, 'bullet must stay within the 400-char SPEC cap');
    assert.ok(!OPERATOR_COMMANDS_BULLET.includes("'"), 'bullet must stay apostrophe-free (byte-pin surfaces)');
  });
});

// ---------------------------------------------------------------------------
// Skill roster section (2026-09-16 evangelism wave WP-5) — every lane whose
// PA_META offers run_skill must see the live roster; execution mode suppresses
// it (PA_META is stripped there). Roster data is local (~/.pa/skills), never
// tracked source.
// ---------------------------------------------------------------------------

async function writeFixtureSkill(name: string, desc: string): Promise<void> {
  const dir = join(tempDir, 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'skill.md'), ['---', `description: "${desc}"`, '---', 'Prompt body.'].join('\n'));
}

describe('buildPrompt: skill roster section', () => {
  it('renders ## Skills you can trigger with fixture skills, before ## Telegram Metadata', async () => {
    await writeFixtureSkill('fixture-skill', 'a fixture capability');
    const prompt = await buildPrompt('hello', makeState());
    const rosterIdx = prompt.indexOf('## Skills you can trigger');
    assert.ok(rosterIdx > 0, 'roster section present');
    assert.ok(prompt.includes('[fixture-skill] a fixture capability'), 'roster line present');
    assert.ok(rosterIdx < prompt.indexOf('## Telegram Metadata'), 'roster lands before Telegram Metadata');
  });

  it('omitStatic: true still renders the roster (live data, not static)', async () => {
    await writeFixtureSkill('fixture-skill', 'a fixture capability');
    const prompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: true });
    assert.ok(prompt.includes('## Skills you can trigger'), 'lean prompts carry the live roster');
    assert.ok(prompt.includes('[fixture-skill]'));
  });

  it('execution mode (pendingAction) suppresses the roster — PA_META is stripped there', async () => {
    await writeFixtureSkill('fixture-skill', 'a fixture capability');
    const prompt = await buildPrompt('hello', makeState(), undefined, undefined, 'do the thing');
    assert.ok(!prompt.includes('## Skills you can trigger'), 'execution-mode prompt must not carry the roster');
  });

  it('empty skills dir renders no section — absent, not an empty stub', async () => {
    const prompt = await buildPrompt('hello', makeState());
    assert.ok(!prompt.includes('## Skills you can trigger'), 'no skills → no section');
  });

  it('renderSkillRosterSection fails to empty string on a broken skills dir', async () => {
    // A skills PATH that is a file, not a dir — listSkills must throw, section ''.
    await writeFile(join(tempDir, 'skills'), 'not a dir');
    assert.equal(await renderSkillRosterSection(), '');
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

  it('## Topic section is byte-identical to the pinned literal (description + brain + recall + decisions)', async () => {
    const chatId = -1001234567890;
    const threadId = 8306;
    const state = makeState({ chat_id: chatId, thread_id: threadId });
    const topicNames: TopicNameMap = new Map([
      [String(chatId), new Map([[threadId, { name: 'my-topic', description: 'things' }]])],
    ]);

    const topicDir = join(tempDir, 'topic-brains', `${chatId}_${threadId}`);
    await mkdir(topicDir, { recursive: true });
    const brainContent = `# Test Topic\n\n<!-- topic-brain: consolidated=2026-08-21T21:30:00+05:30 covers=2026-08-21T18:03:11.000Z -->\n\n## Current state\n`;
    await writeFile(join(topicDir, 'BRAIN.md'), brainContent, 'utf8');
    const brainPath = join(topicDir, 'BRAIN.md');

    const result = await buildPrompt('hello', state, topicNames);

    const expected =
      `## Topic\n` +
      `Topic: my-topic — things\n` +
      `Topic brain: ${brainPath} (consolidated 2026-08-21, covers through 2026-08-21) — durable per-topic knowledge: what was discussed, decided, and left open. Read it before assuming prior context in this topic; fresh turns override it.\n` +
      `Recall: \`pa recall "<terms>" --thread ${threadId} --json\` searches this topic's full history, worker traces, topic brains and the Ecosystem KB — use it instead of guessing about anything before the window above.\n` +
      `Precedent: before proposing in this topic, run \`pa recall "<intent>" --source decisions --thread ${threadId} --json\` — past judgment calls with rationale and your reaction; honor strong precedents.\n`;
    assert.ok(result.includes(expected), 'the ## Topic block must render byte-identical to the pinned literal');
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
      // Fresh dispatches never carry turns (operator directive 2026-09-03) —
      // these turns exist only to prove they do NOT leak into the history body.
      turns: [
        { role: 'user', text: 'previous message', timestamp: new Date(Date.now() - 120_000).toISOString() },
        { role: 'assistant', text: 'previous response', timestamp: new Date(Date.now() - 60_000).toISOString() },
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
    assert.ok(result.includes('Conversation turns are not injected'), 'should have the retrieval pointer, not turn text');
    assert.ok(!result.includes('previous message'), 'turn text must not leak into the prompt');
    assert.ok(!result.includes('previous response'), 'turn text must not leak into the prompt');
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
// The reservations renderer lives in topic-pointers.ts (prompt-evangelism wave:
// shared across all lanes); exercised here through buildPrompt's injectable
// `readActiveFn` option — the same `<name>Fn?:` DI pattern used elsewhere in the
// bot (voice.ts, voice-worker-client.ts) — so these tests never touch the real
// ~/.pa reservations store.

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

describe('buildPrompt: active reservations (W-C6)', () => {
  it('stubbed readActive returning two reservations: both rows present in a standalone ## Live reservations section', async () => {
    const r1 = makeReservation({ id: 'r-11111111', paths: ['pa/src/a.ts'], session: 'sess-a', note: 'work a', expiresAt: '2026-08-23T11:00:00.000Z' });
    const r2 = makeReservation({ id: 'r-22222222', paths: ['pa/src/b.ts'], session: 'sess-b', note: 'work b', expiresAt: '2026-08-23T12:00:00.000Z' });
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, {
      readActiveFn: async () => [r1, r2],
    });
    assert.ok(result.includes('## Live reservations'), 'section header present');
    assert.ok(result.includes(RESERVATIONS_HEADER), 'header row present');
    assert.ok(result.includes('r-11111111'), 'first reservation id present');
    assert.ok(result.includes('r-22222222'), 'second reservation id present');
    assert.ok(result.includes('sess-a'), 'first session present');
    assert.ok(result.includes('sess-b'), 'second session present');

    // Standalone section now — lands between the dynamic topic blocks and
    // ## Telegram Metadata, NOT nested inside ## Capabilities & Rules.
    const sectionIdx = result.indexOf('## Live reservations');
    const metaIdx = result.indexOf('## Telegram Metadata');
    assert.ok(sectionIdx > 0, 'reservation section present');
    assert.ok(metaIdx > sectionIdx, 'reservation section must come before Telegram Metadata');
    assert.ok(
      result.indexOf(RESERVATIONS_HEADER) === sectionIdx + '## Live reservations\n'.length,
      'header row is the first line of the section'
    );
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

  it('omitStatic: true — reservations still render (lean prompts are not exempt)', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, {
      omitStatic: true,
      readActiveFn: async () => [makeReservation()],
    });
    assert.ok(result.includes('## Live reservations'), 'section present in lean mode');
    assert.ok(result.includes('r-abc12345'), 'reservation row present in lean mode');
  });

  it('pendingAction set — no reservation text at all', async () => {
    const result = await buildPrompt('yes', makeState(), undefined, undefined, 'send email to John', {
      readActiveFn: async () => [makeReservation()],
    });
    assert.ok(!result.includes('Active reservations right now'), 'no reservation text in execution mode');
    assert.ok(!result.includes('## Live reservations'), 'no section header in execution mode');
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

// ---------------------------------------------------------------------------
// Decision precedent bullet (AI-164 decision traces, WP-E / spec §3.5)
// ---------------------------------------------------------------------------
// Same three-way verbatim-sync pattern as the Recall / Grounding Sources bullets:
// examples/bot-instructions.example.md is the CI-enforced half,
// bot-instructions.md is the local (untracked) skip-guarded half, and
// context.ts's inline capabilities block is the agy/codex-visible half.

const DECISION_ANCHOR_SENTENCE = 'Precedent before proposing: before proposing a trip, a briefing change, or a deletion, run `pa recall "<intent>" --source decisions --json` — past judgment calls with their rationale and how the user reacted. A rejected alternative is a strong precedent: never re-propose it without new facts; an outcome of "replied" is weak and advisory only.';

describe('Decision precedent bullet', () => {
  it('matches examples/bot-instructions.example.md verbatim', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(DECISION_ANCHOR_SENTENCE),
      'examples/bot-instructions.example.md must contain the Decision anchor sentence verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(DECISION_ANCHOR_SENTENCE),
      'context.ts inline capabilities block must contain the SAME sentence verbatim — keep both in sync');
  });

  it('matches bot-instructions.md verbatim (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(DECISION_ANCHOR_SENTENCE),
      'bot-instructions.md must contain the Decision anchor sentence verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(DECISION_ANCHOR_SENTENCE),
      'context.ts inline capabilities block must contain the SAME sentence verbatim — keep both in sync');
  });

  it('is absent in omitStatic (lean) mode', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: true });
    assert.ok(!result.includes(DECISION_ANCHOR_SENTENCE), 'lean mode must not include the decision bullet');
  });

  it('is absent in execution mode (pendingAction set)', async () => {
    const result = await buildPrompt('yes', makeState(), undefined, undefined, 'send email to John', { omitStatic: false });
    assert.ok(!result.includes(DECISION_ANCHOR_SENTENCE), 'execution mode must not include the decision bullet');
  });

  it('buildResumedPrompt output does NOT contain it', async () => {
    const result = await buildResumedPrompt('hello');
    assert.ok(!result.includes(DECISION_ANCHOR_SENTENCE), 'buildResumedPrompt must never include the decision bullet');
  });

  it('Topic pointer line renders with thread_id when topic name exists', async () => {
    const topicState = makeState({ thread_id: 4242 });
    const topicNames: TopicNameMap = new Map([
      [String(topicState.chat_id), new Map([[topicState.thread_id, { name: 'Test Topic' }]])],
    ]);
    const result = await buildPrompt('hello', topicState, topicNames, undefined, undefined, { omitStatic: false });
    assert.ok(result.includes('--source decisions --thread 4242 --json'),
      'Topic section with a name must render the decision pointer line with the correct thread_id');
    assert.ok(result.includes('## Topic'), 'Topic section must have a heading when topic name exists');
  });

  it('Topic pointer line does NOT render when Topic section has no description or brain pointer', async () => {
    const topicState = makeState({ thread_id: 9999 });
    const topicNames: TopicNameMap = new Map();
    const result = await buildPrompt('hello', topicState, topicNames, undefined, undefined, { omitStatic: false });
    assert.ok(!result.includes('## Topic'), 'Topic section must not render when no topic name or brain pointer exists');
    assert.ok(!result.includes('--source decisions --thread 9999'),
      'Decision pointer line must not appear when Topic section does not render');
  });
});

// ---------------------------------------------------------------------------
// KB Sources conditional grounding (public-brain wave WP-B4 / spec §2.4)
// ---------------------------------------------------------------------------
// Three-way verbatim-sync pattern: context.ts inline capabilities block ↔
// bot-instructions.md (untracked, local) ↔ examples/bot-instructions.example.md
// (tracked, CI-enforced). When PA_KB_SOURCES_PATH is unset, the grounding bullet
// is OMITENT entirely from context.ts; bot-instructions.md carries it for the
// operator's env (which is set). The example file is unchanged (never had it).

const KB_SOURCES_BULLET_TEXT = '- Grounding Sources: Systems of record:';

describe('KB Sources conditional grounding (public-brain wave WP-B4)', () => {
  it('when PA_KB_SOURCES_PATH is SET, grounding bullet appears in inline capabilities', async () => {
    const originalValue = process.env.PA_KB_SOURCES_PATH;
    process.env.PA_KB_SOURCES_PATH = '/custom/kb/path';
    try {
      const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
      assert.ok(result.includes(KB_SOURCES_BULLET_TEXT), 'when PA_KB_SOURCES_PATH is set, grounding bullet must appear');
      assert.ok(result.includes('/custom/kb/path'), 'bullet must include the configured path');
    } finally {
      if (originalValue === undefined) {
        delete process.env.PA_KB_SOURCES_PATH;
      } else {
        process.env.PA_KB_SOURCES_PATH = originalValue;
      }
    }
  });

  it('when PA_KB_SOURCES_PATH is UNSET, grounding bullet is OMITTED from inline capabilities', async () => {
    const originalValue = process.env.PA_KB_SOURCES_PATH;
    delete process.env.PA_KB_SOURCES_PATH;
    try {
      const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
      assert.ok(!result.includes(KB_SOURCES_BULLET_TEXT), 'when PA_KB_SOURCES_PATH is unset, grounding bullet must NOT appear');
    } finally {
      if (originalValue !== undefined) {
        process.env.PA_KB_SOURCES_PATH = originalValue;
      }
    }
  });

  it('when PA_KB_SOURCES_PATH is SET, bullet includes full rule text', async () => {
    const originalValue = process.env.PA_KB_SOURCES_PATH;
    process.env.PA_KB_SOURCES_PATH = '/custom/kb/path';
    try {
      const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
      assert.ok(result.includes('check Sources.md and the file(s) it names, and cite them'), 'must include full rule text');
      assert.ok(result.includes('Never answer such a question from general/parametric knowledge when a named source exists'), 'must include full rule text');
      assert.ok(result.includes('Mirrors bot-instructions.md\'s Factual Integrity item 4'), 'must include mirror-note parenthetical');
    } finally {
      if (originalValue === undefined) {
        delete process.env.PA_KB_SOURCES_PATH;
      } else {
        process.env.PA_KB_SOURCES_PATH = originalValue;
      }
    }
  });

  it('matches bot-instructions.md verbatim when PA_KB_SOURCES_PATH is set (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    // bot-instructions.md has markdown-bold "**Grounding Sources first**" with placeholder (not the literal path)
    assert.ok(botInstructionsContent.includes('<configured PA_KB_SOURCES_PATH>'), 'bot-instructions.md must use configured placeholder');
  });

  it('is absent in omitStatic (lean) mode even when PA_KB_SOURCES_PATH is set', async () => {
    const originalValue = process.env.PA_KB_SOURCES_PATH;
    process.env.PA_KB_SOURCES_PATH = '/custom/kb/path';
    try {
      const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: true });
      assert.ok(!result.includes(KB_SOURCES_BULLET_TEXT), 'grounding bullet must be absent in lean mode even when env is set');
    } finally {
      if (originalValue === undefined) {
        delete process.env.PA_KB_SOURCES_PATH;
      } else {
        process.env.PA_KB_SOURCES_PATH = originalValue;
      }
    }
  });

  it('is absent in execution mode (pendingAction set) even when PA_KB_SOURCES_PATH is set', async () => {
    const originalValue = process.env.PA_KB_SOURCES_PATH;
    process.env.PA_KB_SOURCES_PATH = '/custom/kb/path';
    try {
      const result = await buildPrompt('yes', makeState(), undefined, undefined, 'send email to John', { omitStatic: false });
      assert.ok(!result.includes(KB_SOURCES_BULLET_TEXT), 'grounding bullet must be absent in execution mode even when env is set');
    } finally {
      if (originalValue === undefined) {
        delete process.env.PA_KB_SOURCES_PATH;
      } else {
        process.env.PA_KB_SOURCES_PATH = originalValue;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Infrastructure shim rule (de-pathed, public-brain wave WP-B4 / spec §2.4)
// ---------------------------------------------------------------------------
// The shim rule dropped the hardcoded D:/gemini-shim parenthetical. Sync is
// between context.ts inline capabilities ↔ bot-instructions.md (local) only;
// examples/bot-instructions.example.md does NOT carry this line (unchanged).

const SHIM_RULE_DEPATHED = 'Infrastructure outside the repo tree — worker shims, ~/.pa config, installed CLI binaries — is never to be rewritten, replaced, or worked around to fix a failure.';

describe('Infrastructure shim rule (de-pathed, public-brain wave WP-B4)', () => {
  it('matches bot-instructions.md verbatim (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(SHIM_RULE_DEPATHED),
      'bot-instructions.md must contain the de-pathed shim rule verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(SHIM_RULE_DEPATHED),
      'context.ts inline capabilities block must contain the SAME de-pathed rule verbatim — keep both in sync');
  });

  it('matches context.ts inline capabilities verbatim', async () => {
    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(SHIM_RULE_DEPATHED),
      'context.ts inline capabilities block must contain the de-pathed shim rule');
  });

  it('no longer contains the hardcoded D:/gemini-shim path', async () => {
    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(!inlinePrompt.includes('worker shims (D:/gemini-shim)'),
      'the old pathed parenthetical must be gone — the rule now names no specific path');
  });

  it('is absent in omitStatic (lean) mode', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: true });
    assert.ok(!result.includes(SHIM_RULE_DEPATHED), 'shim rule must be absent in lean mode');
  });

  it('is absent in execution mode (pendingAction set)', async () => {
    const result = await buildPrompt('yes', makeState(), undefined, undefined, 'send email to John', { omitStatic: false });
    assert.ok(!result.includes(SHIM_RULE_DEPATHED), 'shim rule must be absent in execution mode');
  });
});

// ---------------------------------------------------------------------------
// Standing rules injection (AI-165 feedback-as-rules, WP-D)
// ---------------------------------------------------------------------------

describe('buildPrompt: standing rules injection', () => {
  it('zero rules (no yaml file) ⇒ no section', async () => {
    const state = makeState({ thread_id: 4242 });
    const result = await buildPrompt('hello', state);
    assert.ok(!result.includes('## Standing rules'), 'should not have standing rules section when no rules exist');
  });

  it('seeded yaml: global + topic-scoped rules render correctly by scope', async () => {
    const state = makeState({ thread_id: 4242 });
    const rulesYaml = `version: 1
rules:
  - id: r-a1b2c3d4e5f6
    key: global-rule-1
    text: "Never use LaTeX in Telegram replies"
    scope: global
    status: active
    check: null
    origin:
      thread_id: null
      message_id: null
      refId: null
      ts: "2026-08-27T09:00:00.000Z"
      decision_ids: []
    created_at: "2026-08-27T09:00:00.000Z"
    superseded_by: null
  - id: r-b2c3d4e5f6a7
    key: global-rule-2
    text: "Always cite sources for factual claims"
    scope: global
    status: active
    check: null
    origin:
      thread_id: null
      message_id: null
      refId: null
      ts: "2026-08-27T10:00:00.000Z"
      decision_ids: []
    created_at: "2026-08-27T10:00:00.000Z"
    superseded_by: null
  - id: r-c3d4e5f6a7b8
    key: topic-4242-rule
    text: "For this topic, prefer markdown over HTML"
    scope: topic:4242
    status: active
    check: null
    origin:
      thread_id: 4242
      message_id: "12345"
      refId: null
      ts: "2026-08-27T11:00:00.000Z"
      decision_ids: []
    created_at: "2026-08-27T11:00:00.000Z"
    superseded_by: null
  - id: r-d4e5f6a7b8c9
    key: topic-9999-rule
    text: "For topic 9999 only"
    scope: topic:9999
    status: active
    check: null
    origin:
      thread_id: 9999
      message_id: "99999"
      refId: null
      ts: "2026-08-27T12:00:00.000Z"
      decision_ids: []
    created_at: "2026-08-27T12:00:00.000Z"
    superseded_by: null
  - id: r-e5f6a7b8c9d0
    key: pending-rule
    text: "This is pending"
    scope: global
    status: pending
    check: null
    origin:
      thread_id: null
      message_id: null
      refId: null
      ts: "2026-08-27T13:00:00.000Z"
      decision_ids: []
    created_at: "2026-08-27T13:00:00.000Z"
    superseded_by: null
  - id: r-f6a7b8c9d0e1
    key: superseded-rule
    text: "This is superseded"
    scope: global
    status: active
    check: null
    origin:
      thread_id: null
      message_id: null
      refId: null
      ts: "2026-08-27T14:00:00.000Z"
      decision_ids: []
    created_at: "2026-08-27T14:00:00.000Z"
    superseded_by: r-a1b2c3d4e5f6
`;
    await writeFile(join(tempDir, 'feedback-rules.yaml'), rulesYaml, 'utf8');

    const result = await buildPrompt('hello', state);
    assert.ok(result.includes('## Standing rules'), 'should have standing rules section');
    assert.ok(result.includes('Never use LaTeX in Telegram replies'), 'should include global rule 1');
    assert.ok(result.includes('Always cite sources for factual claims'), 'should include global rule 2');
    assert.ok(result.includes('For this topic, prefer markdown over HTML'), 'should include topic 4242 rule');
    assert.ok(!result.includes('For topic 9999 only'), 'should NOT include topic 9999 rule for thread 4242');
    assert.ok(!result.includes('This is pending'), 'should NOT include pending rule');
    assert.ok(!result.includes('This is superseded'), 'should NOT include superseded rule');
  });

  it('different thread_id sees only global rules', async () => {
    const state = makeState({ thread_id: 9999 });
    const rulesYaml = `version: 1
rules:
  - id: r-a1b2c3d4e5f6
    key: global-rule
    text: "Global rule text"
    scope: global
    status: active
    check: null
    origin:
      thread_id: null
      message_id: null
      refId: null
      ts: "2026-08-27T09:00:00.000Z"
      decision_ids: []
    created_at: "2026-08-27T09:00:00.000Z"
    superseded_by: null
  - id: r-b2c3d4e5f6a7
    key: topic-4242-rule
    text: "Topic 4242 only"
    scope: topic:4242
    status: active
    check: null
    origin:
      thread_id: 4242
      message_id: "12345"
      refId: null
      ts: "2026-08-27T10:00:00.000Z"
      decision_ids: []
    created_at: "2026-08-27T10:00:00.000Z"
    superseded_by: null
`;
    await writeFile(join(tempDir, 'feedback-rules.yaml'), rulesYaml, 'utf8');

    const result = await buildPrompt('hello', state);
    assert.ok(result.includes('## Standing rules'), 'should have standing rules section');
    assert.ok(result.includes('Global rule text'), 'should include global rule');
    assert.ok(!result.includes('Topic 4242 only'), 'should NOT include topic 4242 rule for thread 9999');
  });

  it('12-rule cap: 15 rules ⇒ at most 12 rendered with overflow pointer', async () => {
    const state = makeState({ thread_id: 4242 });
    const rules: string[] = [];
    for (let i = 1; i <= 15; i++) {
      rules.push(`  - id: r-${'0'.repeat(12)}${i}
    key: rule-${i}
    text: "Rule number ${i}"
    scope: global
    status: active
    check: null
    origin:
      thread_id: null
      message_id: null
      refId: null
      ts: "2026-08-27T${String(i).padStart(2, '0')}:00:00.000Z"
      decision_ids: []
    created_at: "2026-08-27T${String(i).padStart(2, '0')}:00:00.000Z"
    superseded_by: null`);
    }
    const rulesYaml = `version: 1
rules:
${rules.join('\n')}
`;
    await writeFile(join(tempDir, 'feedback-rules.yaml'), rulesYaml, 'utf8');

    const result = await buildPrompt('hello', state);
    assert.ok(result.includes('## Standing rules'), 'should have standing rules section');
    assert.ok(result.includes('(+3 older — pa rules list)'), 'should show overflow count for 3 rules dropped');

    // Count the rule bullets actually rendered
    const bulletMatches = result.match(/^- Rule number \d+/gm);
    assert.equal(bulletMatches?.length, 12, 'should render exactly 12 rule bullets');
  });

  it('1500-char cap: drops long rules to stay under budget', async () => {
    const state = makeState({ thread_id: 4242 });
    // 12 medium-length rules that exceed 1500 chars if all included
    // Each rendered line is ~150 chars ("- Rule N: " + 140 A's), so 12 rules ≈ 1815
    const rules: string[] = [];
    for (let i = 1; i <= 12; i++) {
      // Create a rule line of ~150 chars
      const mediumText = `Rule ${i}: ${'A'.repeat(140)}`;
      rules.push(`  - id: r-${'0'.repeat(12)}${i}
    key: medium-${i}
    text: "${mediumText}"
    scope: global
    status: active
    check: null
    origin: { thread_id: null, message_id: null, refId: null, ts: '2026-08-27T${String(i).padStart(2, '0')}:00:00.000Z', decision_ids: [] }
    created_at: '2026-08-27T${String(i).padStart(2, '0')}:00:00.000Z'
    superseded_by: null`);
    }
    const rulesYaml = `version: 1
rules:
${rules.join('\n')}
`;
    await writeFile(join(tempDir, 'feedback-rules.yaml'), rulesYaml, 'utf8');

    const result = await buildPrompt('hello', state);
    assert.ok(result.includes('## Standing rules'), 'should have standing rules section');

    // Should show overflow since at least the oldest rule was dropped due to char cap
    assert.ok(result.includes('(+'), 'should show overflow count due to char cap');

    // Count total bullets - should be less than 12 due to char cap
    const bulletMatches = result.match(/^- Rule \d+/gm);
    assert.ok(bulletMatches && bulletMatches.length < 12, 'should render fewer than 12 rules due to char cap');
  });

  it('buildResumedPrompt never contains standing rules section', async () => {
    const rulesYaml = `version: 1
rules:
  - id: r-a1b2c3d4e5f6
    key: test-rule
    text: "Test rule"
    scope: global
    status: active
    check: null
    origin:
      thread_id: null
      message_id: null
      refId: null
      ts: "2026-08-27T09:00:00.000Z"
      decision_ids: []
    created_at: "2026-08-27T09:00:00.000Z"
    superseded_by: null
`;
    await writeFile(join(tempDir, 'feedback-rules.yaml'), rulesYaml, 'utf8');

    const result = await buildResumedPrompt('hello');
    assert.ok(!result.includes('## Standing rules'), 'buildResumedPrompt must never include standing rules section');
  });

  it('fresh-read proof: rules are read on every call, not cached', async () => {
    const state = makeState({ thread_id: 4242 });
    const initialYaml = `version: 1
rules:
  - id: r-a1b2c3d4e5f6
    key: rule-1
    text: "First rule"
    scope: global
    status: active
    check: null
    origin:
      thread_id: null
      message_id: null
      refId: null
      ts: "2026-08-27T09:00:00.000Z"
      decision_ids: []
    created_at: "2026-08-27T09:00:00.000Z"
    superseded_by: null
`;
    await writeFile(join(tempDir, 'feedback-rules.yaml'), initialYaml, 'utf8');

    const result1 = await buildPrompt('hello', state);
    assert.ok(result1.includes('First rule'), 'first call should include first rule');
    assert.equal((result1.match(/^- First rule/gm) || []).length, 1, 'first rule should appear once');

    // Update the yaml to add a second rule
    const updatedYaml = `version: 1
rules:
  - id: r-a1b2c3d4e5f6
    key: rule-1
    text: "First rule"
    scope: global
    status: active
    check: null
    origin:
      thread_id: null
      message_id: null
      refId: null
      ts: "2026-08-27T09:00:00.000Z"
      decision_ids: []
    created_at: "2026-08-27T09:00:00.000Z"
    superseded_by: null
  - id: r-b2c3d4e5f6a7
    key: rule-2
    text: "Second rule"
    scope: global
    status: active
    check: null
    origin:
      thread_id: null
      message_id: null
      refId: null
      ts: "2026-08-27T10:00:00.000Z"
      decision_ids: []
    created_at: "2026-08-27T10:00:00.000Z"
    superseded_by: null
`;
    await writeFile(join(tempDir, 'feedback-rules.yaml'), updatedYaml, 'utf8');

    const result2 = await buildPrompt('hello', state);
    assert.ok(result2.includes('First rule'), 'second call should still include first rule');
    assert.ok(result2.includes('Second rule'), 'second call should include newly added second rule');

    const bullets2 = result2.match(/^- (First|Second) rule/gm) || [];
    assert.equal(bullets2.length, 2, 'second call should have both rules');
  });

  describe('buildSkillStatus', () => {
    it('renders scheduled skills and manual skills with descriptions', async () => {
      // Create fixture PA_HOME with 2 scheduled + 2 manual skills
      const skillsDir = join(tempDir, 'skills');
      await mkdir(skillsDir, { recursive: true });

      // Scheduled skill 1
      await mkdir(join(skillsDir, 'scheduled1'), { recursive: true });
      await writeFile(join(skillsDir, 'scheduled1', 'skill.md'), [
        '---',
        'cron: "30 8 * * *"',
        'description: "Daily morning briefing"',
        '---',
        'Prompt body.'
      ].join('\n'));

      // Scheduled skill 2
      await mkdir(join(skillsDir, 'scheduled2'), { recursive: true });
      await writeFile(join(skillsDir, 'scheduled2', 'skill.md'), [
        '---',
        'cron: "0 20 * * *"',
        '---',
        'No description.'
      ].join('\n'));

      // Manual skill 1 with description
      await mkdir(join(skillsDir, 'manual1'), { recursive: true });
      await writeFile(join(skillsDir, 'manual1', 'skill.md'), [
        '---',
        'description: "On-demand summary generator"',
        '---',
        'Manual prompt.'
      ].join('\n'));

      // Manual skill 2 with description
      await mkdir(join(skillsDir, 'manual2'), { recursive: true });
      await writeFile(join(skillsDir, 'manual2', 'skill.md'), [
        '---',
        'description: "Quick ad-hoc analysis task"',
        '---',
        'Manual task.'
      ].join('\n'));

      const result = await buildSkillStatus();

      // Should contain scheduled skills (as bullets, no header) and manual skills (with header)
      assert.ok(result.includes('*Manual Skills*'), 'should have manual skills header');

      // Scheduled skills appear as bullets without a header
      assert.ok(result.includes('- scheduled1:'), 'scheduled skill 1 should appear');
      assert.ok(result.includes('- scheduled2:'), 'scheduled skill 2 should appear');

      // Manual skills with descriptions
      assert.ok(result.includes('- manual1: On-demand summary generator'), 'manual skill 1 with description');
      assert.ok(result.includes('- manual2: Quick ad-hoc analysis task'), 'manual skill 2 with description');
    });

    it('shows no manual section when zero manual skills exist', async () => {
      const skillsDir = join(tempDir, 'skills');
      await mkdir(skillsDir, { recursive: true });

      // Only scheduled skills
      await mkdir(join(skillsDir, 'scheduled1'), { recursive: true });
      await writeFile(join(skillsDir, 'scheduled1', 'skill.md'), [
        '---',
        'cron: "30 8 * * *"',
        '---',
        'Scheduled only.'
      ].join('\n'));

      const result = await buildSkillStatus();

      // Should have scheduled skills (bullets, no header) but NO manual section
      assert.ok(result.includes('- scheduled1:'), 'scheduled skill should appear');
      assert.ok(!result.includes('*Manual Skills*'), 'should NOT have manual skills header when none exist');
    });

    it('truncates descriptions over 80 chars and shows ...and N more for large lists', async () => {
      const skillsDir = join(tempDir, 'skills');
      await mkdir(skillsDir, { recursive: true });

      // Create 17 manual skills to test truncation and overflow
      for (let i = 1; i <= 17; i++) {
        const longDesc = `This is a very long description that exceeds eighty characters and should be truncated at exactly that limit number eighty plus one more ${i}`;
        await mkdir(join(skillsDir, `manual${i}`), { recursive: true });
        await writeFile(join(skillsDir, `manual${i}`, 'skill.md'), [
          '---',
          `description: "${longDesc}"`,
          '---',
          `Manual skill ${i}.`
        ].join('\n'));
      }

      const result = await buildSkillStatus();

      assert.ok(result.includes('*Manual Skills*'), 'should have manual skills header');
      assert.ok(result.includes('…and 2 more — run `pa list`_'), 'should show overflow message for 17 skills (15 displayed + 2 more)');

      // Check truncation - find any line with manual1
      const lines = result.split('\n');
      const manual1Line = lines.find(l => l.includes('manual1:'));
      assert.ok(manual1Line, 'manual1 should be in output');
      // The description is truncated to 80 chars, so the full line is: "- manual1: " + 80-char description
      // That's 12 + 80 = 92 chars, but the description itself should be ≤80 chars
      const descPart = manual1Line!.split(': ')[1];
      assert.ok(descPart.length <= 80, 'truncated description should be ≤80 chars');
    });

    it('renders skill without description as bare name (no colon-space garbage)', async () => {
      const skillsDir = join(tempDir, 'skills');
      await mkdir(skillsDir, { recursive: true });

      // Manual skill with no description
      await mkdir(join(skillsDir, 'no-desc'), { recursive: true });
      await writeFile(join(skillsDir, 'no-desc', 'skill.md'), [
        '---',
        '---',
        'No description field.'
      ].join('\n'));

      const result = await buildSkillStatus();

      assert.ok(result.includes('*Manual Skills*'), 'should have manual skills header');
      assert.ok(result.includes('- no-desc'), 'skill without description should appear as bare name');

      // Verify no colon-space garbage
      const lines = result.split('\n');
      const noDescLine = lines.find(l => l.includes('no-desc'));
      assert.equal(noDescLine, '- no-desc', 'should render as "- name:" with no trailing colon-space');
    });
  });
});

// ---------------------------------------------------------------------------
// buildPrompt — open items (unified topic store: tasks + notes, operator
// directive 2026-09-03 — retires the per-topic SHORT-TERM.md markdown index)
// ---------------------------------------------------------------------------
// Both task and note fixtures are seeded through pa/dist's REAL store
// functions (appendTask/addNote/closeNote) — the same store `pa topic-task`,
// `pa topic-note` and the drain use — so a rendering deviation on either side
// fails here (real producer, real consumer).

const OPEN_ITEMS_HEADER = '## Open items (short-term)';
const QUEUED_TASKS_LEAD = 'Queued tasks (dispatched automatically by the system — do not re-run them yourself):';

describe('buildPrompt: open items (unified store)', () => {
  const chatId = -1001234567890;
  const threadId = 310;

  it('queued tasks render from the store', async () => {
    await appendTask(chatId, threadId, { title: 'Wave 1 dogfood', prompt: 'Report one line: drain works.', createdBy: 'test' });
    const result = await buildPrompt('hello', makeState({ chat_id: chatId, thread_id: threadId }));
    assert.ok(result.includes(OPEN_ITEMS_HEADER), 'section renders when a task is queued');
    assert.ok(result.includes(QUEUED_TASKS_LEAD), 'frozen do-not-re-run lead line present');
    assert.ok(
      /- tt-[0-9a-f]{12} — Wave 1 dogfood \(queued \d{2}:\d{2} IST\)/.test(result),
      'task line renders id, title and the queued HH:MM IST label from the store record'
    );
    assert.ok(!result.includes('Report one line'), 'the task prompt field is NOT rendered (title only)');
  });

  it('notes render from the store capped at 15', async () => {
    for (let i = 1; i <= 17; i++) {
      await addNote(chatId, threadId, { text: `Note number ${i}`, key: `note-${String(i).padStart(2, '0')}` });
    }
    const result = await buildPrompt('hello', makeState({ chat_id: chatId, thread_id: threadId }));
    assert.ok(result.includes(OPEN_ITEMS_HEADER), 'section renders when notes exist');
    const noteBullets = result.match(/^- note-\d{2} — Note number \d+$/gm) || [];
    assert.equal(noteBullets.length, 15, 'exactly 15 OPEN notes render');
    assert.ok(result.includes('(+2 more — pa topic-note list)'), 'overflow line present');
    assert.ok(!result.includes('Note number 16'), 'note 16 must not render');
    assert.ok(!result.includes('Note number 17'), 'note 17 must not render');
    assert.ok(!result.includes(QUEUED_TASKS_LEAD), 'no queued-tasks block when the task store is empty');
  });

  it('notes render key and text; DONE notes never render', async () => {
    await addNote(chatId, threadId, { text: 'Buy milk before Friday', key: 'milk-run' });
    await addNote(chatId, threadId, { text: 'Renew insurance', key: 'renew-ins', expires: '2026-09-30' });
    await addNote(chatId, threadId, { text: 'Already closed', key: 'old-note' });
    await closeNote(chatId, threadId, 'old-note');
    const result = await buildPrompt('hello', makeState({ chat_id: chatId, thread_id: threadId }));
    assert.ok(result.includes('Notes:'), 'Notes block header present');
    assert.ok(result.includes('- milk-run — Buy milk before Friday'), 'OPEN note renders as key — text');
    assert.ok(result.includes('- renew-ins — Renew insurance (expires 2026-09-30)'), 'expires suffix round-trips through render');
    assert.ok(!result.includes('Already closed'), 'DONE note must not render');
  });

  it('open-items section absent when both empty', async () => {
    const result = await buildPrompt('hello', makeState({ chat_id: chatId, thread_id: threadId }));
    assert.ok(!result.includes('Open items'), 'no section with an empty task and note store');
  });

  // Push-gate regression guard (2026-09-03): a fresh PA_HOME (mkdtemp'd in the
  // file-level beforeEach above) never creates ~/.pa/topic-tasks/ until a
  // mutating call (appendTask/addNote) does — listNotes/listTasks/listRunningTasks
  // read a directory that plain does not exist yet. Pins that renderOpenItems'
  // fail-to-absent contract (readNotesTolerant/readQueueTolerant/readRunningTolerant
  // in pa/src/lib/topic-tasks.ts catch and return [], and renderOpenItems's own
  // try/catch is belt-and-braces on top) means buildPrompt still completes and
  // renders the rest of the prompt — never throws, never aborts the dispatch —
  // when the topic store directory is entirely absent.
  it('buildPrompt with a PA_HOME that has no topic store still builds and renders an empty Open items section', async () => {
    assert.equal(
      existsSync(join(tempDir, 'topic-tasks')),
      false,
      'fixture precondition: no topic-tasks dir exists yet in this fresh PA_HOME'
    );
    const result = await buildPrompt('hello there', makeState({ chat_id: chatId, thread_id: threadId }));
    assert.ok(result.includes('hello there'), 'buildPrompt completed and rendered the user message');
    assert.ok(!result.includes('Open items'), 'no Open items section when the store directory is entirely absent');
  });

  it('open-items section absent when only DONE notes exist', async () => {
    await addNote(chatId, threadId, { text: 'Already closed', key: 'old-note' });
    await closeNote(chatId, threadId, 'old-note');
    const result = await buildPrompt('hello', makeState({ chat_id: chatId, thread_id: threadId }));
    assert.ok(!result.includes('Open items'), 'a DONE-only note store renders no section');
  });

  it('open items absent in omitStatic (lean) mode', async () => {
    await appendTask(chatId, threadId, { title: 'Lean mode task', prompt: 'p', createdBy: 'test' });
    await addNote(chatId, threadId, { text: 'Lean note', key: 'lean' });
    const result = await buildPrompt('hello', makeState({ chat_id: chatId, thread_id: threadId }), undefined, undefined, undefined, { omitStatic: true });
    assert.ok(!result.includes(OPEN_ITEMS_HEADER), 'lean mode must not include open items');
  });

  it('open items absent in execution mode (pendingAction set)', async () => {
    await appendTask(chatId, threadId, { title: 'Exec mode task', prompt: 'p', createdBy: 'test' });
    await addNote(chatId, threadId, { text: 'Exec note', key: 'exec' });
    const result = await buildPrompt('yes', makeState({ chat_id: chatId, thread_id: threadId }), undefined, undefined, 'send email to John');
    assert.ok(!result.includes(OPEN_ITEMS_HEADER), 'execution mode must not include open items');
  });

  it('buildResumedPrompt never includes open items', async () => {
    await appendTask(chatId, threadId, { title: 'Resumed task', prompt: 'p', createdBy: 'test' });
    await addNote(chatId, threadId, { text: 'Resumed note', key: 'resumed' });
    const result = await buildResumedPrompt('hello');
    assert.ok(!result.includes(OPEN_ITEMS_HEADER), 'buildResumedPrompt must never include open items');
  });

  it('in-flight siblings render in open items', async () => {
    // Wave-2 tier-2 attribution: a CLAIMED record (real store chain) renders under
    // the in-flight lead line with its live status + attempt counter.
    await appendTask(chatId, threadId, { title: 'In-flight sibling', prompt: 'p', createdBy: 'test' });
    const claimed = await claimNextTask(chatId, threadId);
    assert.ok(claimed);
    const result = await buildPrompt('hello', makeState({ chat_id: chatId, thread_id: threadId }));
    const inflightLead = 'In-flight tasks (answers to their questions route automatically when you reply to their messages):';
    assert.ok(result.includes(inflightLead), 'tier-2 lead line present for a claimed task');
    assert.ok(
      new RegExp(`- ${claimed.id} — In-flight sibling \\(running, attempt 1/${TOPIC_TASK_MAX_ATTEMPTS}\\)`).test(result),
      'sibling line renders id, title, status and attempt counter from the store record'
    );
  });
});

// ---------------------------------------------------------------------------
// Fresh dispatches never carry turns (supersedes AI-188's recency window,
// operator directive 2026-09-03)
// ---------------------------------------------------------------------------

describe('buildPrompt: fresh dispatch never carries turns (operator directive 2026-09-03)', () => {
  const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
  const H = 3_600_000;

  it('fresh dispatch carries the pointer and zero turns', async () => {
    // Whether the topic has no history at all, recent history, or hours-old
    // history, buildPrompt renders the SAME two-line retrieval pointer and
    // injects no turn text — there is no window to be inside or outside of.
    // Brain fixture present ⇒ the with-brain form ("the topic brain above").
    const recentTurns = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `turn ${i + 1}`,
      timestamp: iso((12 - i) * 60_000),
    }));
    const staleTurns = [
      { role: 'user' as const, text: 'morning question', timestamp: iso(3 * H + 60_000) },
      { role: 'assistant' as const, text: 'morning answer', timestamp: iso(3 * H) },
    ];
    const expected =
      `(Conversation turns are not injected into this prompt.)\n` +
      'Use the topic brain above and `pa recall "<terms>" --thread 29 --json` for this topic\'s history.';

    const brainDir = join(tempDir, 'topic-brains', '-1001234567890_29');
    await mkdir(brainDir, { recursive: true });
    await writeFile(join(brainDir, 'BRAIN.md'), '# T\n\n<!-- topic-brain: consolidated=2026-09-10T12:00:00+05:30 covers=2026-09-09T18:00:00.000Z -->\n', 'utf8');

    for (const turns of [[], recentTurns, staleTurns]) {
      const result = await buildPrompt('hello', makeState({ turns }));
      assert.ok(
        result.includes(`## Conversation History\n${expected}\n`),
        'history body is exactly the frozen two-line retrieval pointer regardless of turn history'
      );
    }
    const resultRecent = await buildPrompt('hello', makeState({ turns: recentTurns }));
    assert.ok(!resultRecent.includes('turn 1\n') && !resultRecent.includes('turn 12'), 'recent turn text must not render');
    const resultStale = await buildPrompt('hello', makeState({ turns: staleTurns }));
    assert.ok(!resultStale.includes('morning question') && !resultStale.includes('morning answer'), 'stale turn text must not render');
  });

  it('no topic brain → the pointer drops the "topic brain above" clause', async () => {
    // The clause was previously unconditional — a lie on topics with no brain
    // file. With no brain fixture the pointer names `pa recall` alone.
    const result = await buildPrompt('hello', makeState());
    assert.ok(
      result.includes('Use `pa recall "<terms>" --thread 29 --json` for this topic\'s history.'),
      'no-brain form renders the recall-only pointer'
    );
    assert.ok(!result.includes('Use the topic brain above'), 'no phantom brain reference');
  });

  it('buildResumedPrompt never carries turns', async () => {
    // buildResumedPrompt has no state/history section at all — structurally
    // turn-free, independent of this gate's retirement.
    const result = await buildResumedPrompt('hello', 'reply anchor text');
    assert.ok(!result.includes('## Conversation History'), 'resumed path never carries a history section');
    assert.ok(!result.includes('(no prior conversation)'), 'no empty-history placeholder on the resumed path');
    assert.ok(result.includes('reply anchor text'), 'reply-to anchors still ride the resumed path');
  });

  it('reply-to anchor still resolves mechanically, independent of the pointer', async () => {
    const state = makeState({
      turns: [
        { role: 'user', text: 'stale window turn', timestamp: iso(3 * H), message_id: 555 },
        { role: 'assistant', text: 'stale window answer', timestamp: iso(3 * H - 30_000) },
      ],
    });
    const resolved = await resolveReplyContext(
      { reply_to_message: { message_id: 999 } },
      state,
      { archiveLookup: async () => 'archived old message text' }
    );
    assert.equal(resolved, 'archived old message text', 'a replied message still resolves via the archive fallback');
    // Contrast pin: the same state's buildPrompt still renders the pointer, not
    // the turns — the anchor path and the history section are independent.
    const result = await buildPrompt('hello', state);
    assert.ok(result.includes('Conversation turns are not injected'), 'buildPrompt still renders the pointer for this state');
    assert.ok(!result.includes('stale window turn'), 'turns do not leak into the prompt');
    assert.ok(!result.includes('archived old message text'), 'buildPrompt never inlines archive content');
  });
});

// ---------------------------------------------------------------------------
// Browser MCP tools bullet (2026-09-13, WORKERS_GUIDE.md "Browser automation
// (Playwright MCP)") — Playwright MCP is the default browser tool for every
// headless worker session, but print-mode runs connect MCP asynchronously: the
// first round carries only built-ins plus WaitForMcpServers and the browser
// tools join 1-3 rounds later. A worker that is not told to wait falls back or
// reports the tools missing. Same byte-identical sync pattern as the raw-send
// guard above: context.ts's inline capabilities block (agy/codex-visible half)
// ↔ examples/bot-instructions.example.md (tracked, CI-enforced half) ↔ the
// task lane's TASK_RULES. The gitignored local bot-instructions.md is
// hand-synced (never rides git patches), so no local-half test here.
// ---------------------------------------------------------------------------

const BROWSER_MCP_BULLET = '- Browser tools (Playwright MCP) are available in this headless session but join the toolset 1-3 rounds after start: when the task needs browser interaction or visual verification, call `WaitForMcpServers` first and wait — never fall back or report the tools missing. If a `wingman_do` tool is listed, you may hand it one bounded step on the page that is already open (pick a row, fill a form from values you pass, click through a wizard); Playwright MCP stays the default, and `needs_confirmation` means ask the operator before acting.';

describe('Browser MCP tools bullet', () => {
  it('matches examples/bot-instructions.example.md verbatim', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(BROWSER_MCP_BULLET),
      'examples/bot-instructions.example.md must contain the browser MCP bullet verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(BROWSER_MCP_BULLET),
      'context.ts inline capabilities block must contain the SAME browser MCP bullet verbatim — keep both in sync');
  });

  it('task-executor.ts carries the bullet in TASK_RULES', async () => {
    const taskExecutorSource = await readFile(resolve(__dirname, '../../src/task-executor.ts'), 'utf8');
    assert.ok(taskExecutorSource.includes(BROWSER_MCP_BULLET),
      'task-executor.ts TASK_RULES must carry the browser MCP bullet verbatim');
  });

  it('is absent in omitStatic (lean) mode', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: true });
    assert.ok(!result.includes(BROWSER_MCP_BULLET), 'lean mode must not include the browser MCP bullet');
  });

  it('is absent in execution mode (pendingAction set)', async () => {
    const result = await buildPrompt('yes', makeState(), undefined, undefined, 'send email to John', { omitStatic: false });
    assert.ok(!result.includes(BROWSER_MCP_BULLET), 'execution mode must not include the browser MCP bullet');
  });
});

// ---------------------------------------------------------------------------
// Voice-task summary standard (2026-09-14): the --summary a worker passes
// task_complete.py is the operator-facing OUTCOME — never the routing
// receipt or command output (the junk-summary fix). Same sync pattern as the
// bullets above: context.ts's inline capabilities block (agy/codex half) ↔
// examples/bot-instructions.example.md (tracked, CI-enforced half) ↔ the
// task lane's TASK_RULES. The gitignored local bot-instructions.md is
// hand-synced (never rides git patches), so no local-half test here.
// ---------------------------------------------------------------------------

const SUMMARY_STANDARD_BULLET = '- Voice-inbox task closures: the --summary you pass task_complete.py to close a voice-inbox task is the OUTCOME for the operator — plain language stating what was asked and what resulted. Never the command output, a routing receipt, or a transcript re-paste (2+ sentences quoted verbatim from the request) — those are process, not the answer; the script refuses receipts and exits non-zero, so re-run with a real plain-language summary. When the answer is long, also pass --short with the plain-words standalone answer the card leads with (IN SHORT) — as long as it needs, never capped; --recap and --next each take one line saying where things stand and what the operator must do next.';

describe('Voice-task summary standard bullet', () => {
  it('context.ts carries the frozen bullet in the capabilities block', async () => {
    const contextSource = await readFile(resolve(__dirname, '../../src/context.ts'), 'utf8');
    assert.ok(contextSource.includes(SUMMARY_STANDARD_BULLET),
      'context.ts capabilities block must contain the summary-standard bullet verbatim');
  });

  it('examples/bot-instructions.example.md carries the frozen bullet', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(SUMMARY_STANDARD_BULLET),
      'examples/bot-instructions.example.md must contain the summary-standard bullet verbatim');
  });

  it('deployed bot-instructions.md carries the frozen bullet (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(SUMMARY_STANDARD_BULLET),
      'deployed bot-instructions.md must contain the summary-standard bullet verbatim — hand-sync on merge');
  });

  it('task-executor.ts carries the bullet in TASK_RULES', async () => {
    const taskExecutorSource = await readFile(resolve(__dirname, '../../src/task-executor.ts'), 'utf8');
    assert.ok(taskExecutorSource.includes(SUMMARY_STANDARD_BULLET),
      'task-executor.ts TASK_RULES must contain the summary-standard bullet verbatim');
  });
});

// ---------------------------------------------------------------------------
// Visual-answer standard (2026-09-14): when an answer benefits from structure
// (comparisons, steps, choices, small data sets, a decision the user must
// make), the worker builds the reply from the rich shapes the inbox renders
// (cards, tiered short/full answers, forms with steps, lists, tables) instead
// of a prose wall — full answer in plain product language, short version the
// readable one-liner. Completes the rich-answer stack (rendering, forms and
// the answer-register rule landed earlier). Same sync pattern as the bullets
// above: context.ts's inline capabilities block (agy/codex half) ↔
// examples/bot-instructions.example.md (tracked, CI-enforced half) ↔ the
// task lane's TASK_RULES. The gitignored local bot-instructions.md is
// hand-synced (never rides git patches), so no local-half test here.
// ---------------------------------------------------------------------------

const VISUAL_ANSWER_BULLET = '- When an answer benefits from structure — comparisons, steps, choices, small data sets, or a decision the user must make — build it from the rich shapes the inbox renders (cards, tiered short/full answers, forms with steps, lists, tables) instead of prose walls. The full answer reads in plain product language — no ids, schemas, exit codes, or technical terms (the answer register); the short version is the readable one-liner a busy person gets first. Reach for the visual form whenever a wall of text would be the alternative, and if no existing shape fits the answer, generate the raw-HTML shape freely — the inbox renders it in a sandboxed frame, so you have complete freedom over form; recurring patterns graduate into the standard components.';

describe('Visual-answer standard bullet', () => {
  it('context.ts carries the frozen bullet in the capabilities block', async () => {
    const contextSource = await readFile(resolve(__dirname, '../../src/context.ts'), 'utf8');
    assert.ok(contextSource.includes(VISUAL_ANSWER_BULLET),
      'context.ts capabilities block must contain the visual-answer bullet verbatim');
  });

  it('examples/bot-instructions.example.md carries the frozen bullet', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(VISUAL_ANSWER_BULLET),
      'examples/bot-instructions.example.md must contain the visual-answer bullet verbatim');
  });

  it('deployed bot-instructions.md carries the frozen bullet (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(VISUAL_ANSWER_BULLET),
      'deployed bot-instructions.md must contain the visual-answer bullet verbatim — hand-sync on merge');
  });

  it('task-executor.ts carries the bullet in TASK_RULES', async () => {
    const taskExecutorSource = await readFile(resolve(__dirname, '../../src/task-executor.ts'), 'utf8');
    assert.ok(taskExecutorSource.includes(VISUAL_ANSWER_BULLET),
      'task-executor.ts TASK_RULES must contain the visual-answer bullet verbatim');
  });
});

// ---------------------------------------------------------------------------
// Blocker screenshot-ask bullet (2026-09-14): a worker whose headless browser
// hits a page it cannot control (captcha, login, consent) escalates instead
// of stalling — screenshot, task_blocker_ask.py (attaches the screenshot to
// the task + creates the question card), END the turn; the operator answers
// in the inbox and the answer-and-resume steer re-dispatches with the answer
// pointer. Same byte-identical sync pattern as the browser MCP bullet above:
// context.ts's inline capabilities block ↔ examples/bot-instructions.example.md
// (tracked, CI-enforced half) ↔ the task lane's TASK_RULES. The gitignored
// local bot-instructions.md is hand-synced (adapted wording, never rides git
// patches), so no local-half test here.
// ---------------------------------------------------------------------------

const BLOCKER_ASK_BULLET = '- If a page blocks the task (captcha, login, consent wall): screenshot it, run `python3 <repo>/projects/voice-inbox/scripts/task_blocker_ask.py --task <task_id> --screenshot <path> --prompt "<plain-language question>" || python <repo>/projects/voice-inbox/scripts/task_blocker_ask.py --task <task_id> --screenshot <path> --prompt "<plain-language question>"` (add `--options "a|b|c"` for choices) and END your turn — the operator answers the question in their inbox, and your next dispatch opens with the answer pointer; read the answer from that file, continue from where you stopped, and finish with task_complete.py.';

describe('Blocker screenshot-ask bullet', () => {
  it('matches examples/bot-instructions.example.md verbatim', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(BLOCKER_ASK_BULLET),
      'examples/bot-instructions.example.md must contain the blocker-ask bullet verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(BLOCKER_ASK_BULLET),
      'context.ts inline capabilities block must contain the SAME blocker-ask bullet verbatim — keep both in sync');
  });

  it('task-executor.ts carries the bullet in TASK_RULES', async () => {
    const taskExecutorSource = await readFile(resolve(__dirname, '../../src/task-executor.ts'), 'utf8');
    assert.ok(taskExecutorSource.includes(BLOCKER_ASK_BULLET),
      'task-executor.ts TASK_RULES must carry the blocker-ask bullet verbatim');
  });

  it('is absent in omitStatic (lean) mode', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: true });
    assert.ok(!result.includes(BLOCKER_ASK_BULLET), 'lean mode must not include the blocker-ask bullet');
  });

  it('is absent in execution mode (pendingAction set)', async () => {
    const result = await buildPrompt('yes', makeState(), undefined, undefined, 'send email to John', { omitStatic: false });
    assert.ok(!result.includes(BLOCKER_ASK_BULLET), 'execution mode must not include the blocker-ask bullet');
  });
});

// ---------------------------------------------------------------------------
// Live-screencast bullet (2026-09-14, live-screencast design): the worker
// decides when the operator should watch the page it is driving (payment,
// login, OTP) and spawns screencast_bridge.mjs in the background — a zero-dep
// Node sidecar that CDP-screencasts PA's Chrome into the voice-inbox
// in-memory frame store; the PWA polls the latest frame. Stop = kill the
// process. Same byte-identical sync pattern as the blocker-ask bullet above:
// context.ts's inline capabilities block ↔ examples/bot-instructions.example.md
// (tracked, CI-enforced half) ↔ the task lane's TASK_RULES. The gitignored
// local bot-instructions.md is hand-synced (adapted wording, never rides git
// patches), so no local-half test here.
// ---------------------------------------------------------------------------

const SCREENCAST_BULLET = '- For browser work the worker drives PA’s Chrome (endpoint env is already injected): before the first browser action run `pa browser ensure --headed` when the task may need the operator (credentials, payments, posting — anything a human might have to take over) or `pa browser ensure --headless` for pure read-only work. To let the operator watch the page you are on (payment, login, OTP, or anything you want watched), run `node <repo>/projects/voice-inbox/scripts/screencast_bridge.mjs --task <task_id>` in the background and continue your turn; it streams the live screen to the inbox. Stop it (kill the process) when the operator no longer needs to watch. Use it alongside task_blocker_ask.py when you escalate a page you cannot control. The operator can also take over the page in fullscreen (tap, type, scroll, navigate) from the voice-inbox live view — input is enabled only in fullscreen. If the operator takes over the page themselves (a resume note may say so, or the page changes without your action), pause page-driving and re-read the live page state before your next action — do not race operator input.';

describe('Live-screencast bullet', () => {
  it('matches examples/bot-instructions.example.md verbatim', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(SCREENCAST_BULLET),
      'examples/bot-instructions.example.md must contain the screencast bullet verbatim');

    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(SCREENCAST_BULLET),
      'context.ts inline capabilities block must contain the SAME screencast bullet verbatim — keep both in sync');
  });

  it('task-executor.ts carries the bullet in TASK_RULES', async () => {
    const taskExecutorSource = await readFile(resolve(__dirname, '../../src/task-executor.ts'), 'utf8');
    assert.ok(taskExecutorSource.includes(SCREENCAST_BULLET),
      'task-executor.ts TASK_RULES must carry the screencast bullet verbatim');
  });

  it('is absent in omitStatic (lean) mode', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: true });
    assert.ok(!result.includes(SCREENCAST_BULLET), 'lean mode must not include the screencast bullet');
  });

  it('is absent in execution mode (pendingAction set)', async () => {
    const result = await buildPrompt('yes', makeState(), undefined, undefined, 'send email to John', { omitStatic: false });
    assert.ok(!result.includes(SCREENCAST_BULLET), 'execution mode must not include the screencast bullet');
  });
});

// ---------------------------------------------------------------------------
// Promises-need-a-mechanism bullet (2026-09-14, operator directive): threads
// habitually promise future actions in words alone and the promise never
// fires — a task closed Done on "next stage dispatches when it lands" with
// nothing scheduled. Work that must continue after the turn is registered in
// a mechanism instead: the next stage spawns NOW as a dependent thread
// (depends_on — it wakes with the current thread's result) or a watch_job
// PA_META action carries the trigger. Same sync pattern as the bullets above:
// context.ts's inline capabilities block ↔ examples/bot-instructions.example.md
// (tracked, CI-enforced half) ↔ the task lane's TASK_RULES. The gitignored
// local bot-instructions.md is hand-synced (never rides git patches), so its
// test is skip-guarded.
// ---------------------------------------------------------------------------

const PROMISE_MECHANISM_BULLET = '- Never promise future action in words alone: if work must continue after your turn, register it in a mechanism — spawn the next stage now as a dependent thread (`depends_on`, it wakes with your result), or register a `watch_job` for the trigger — a promise without a mechanism is a dropped promise.';

describe('Promises-need-a-mechanism bullet', () => {
  it('matches examples/bot-instructions.example.md verbatim', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(PROMISE_MECHANISM_BULLET),
      'examples/bot-instructions.example.md must contain the promise-mechanism bullet verbatim');
  });

  it('context.ts inline capabilities block carries the SAME bullet', async () => {
    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(PROMISE_MECHANISM_BULLET),
      'context.ts inline capabilities block must contain the SAME promise-mechanism bullet verbatim — keep both in sync');
  });

  it('deployed bot-instructions.md carries the bullet (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(PROMISE_MECHANISM_BULLET),
      'deployed bot-instructions.md must contain the promise-mechanism bullet verbatim — hand-sync on merge');
  });

  it('task-executor.ts carries the bullet in TASK_RULES', async () => {
    const taskExecutorSource = await readFile(resolve(__dirname, '../../src/task-executor.ts'), 'utf8');
    assert.ok(taskExecutorSource.includes(PROMISE_MECHANISM_BULLET),
      'task-executor.ts TASK_RULES must carry the promise-mechanism bullet verbatim');
  });

  it('is absent in omitStatic (lean) mode', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: true });
    assert.ok(!result.includes(PROMISE_MECHANISM_BULLET), 'lean mode must not include the promise-mechanism bullet');
  });

  it('is absent in execution mode (pendingAction set)', async () => {
    const result = await buildPrompt('yes', makeState(), undefined, undefined, 'send email to John', { omitStatic: false });
    assert.ok(!result.includes(PROMISE_MECHANISM_BULLET), 'execution mode must not include the promise-mechanism bullet');
  });
});

// ---------------------------------------------------------------------------
// PA_META envelope wire format for the task/thread lanes (2026-09-14 audit):
// TASK_RULES referenced PA_META actions (question, watch_job) for two waves
// but never taught the envelope syntax. claude/zclaude task dispatches get it
// via bot-instructions.md, but agy/codex (no static prompt file) and EVERY
// thread spawn (stripArgs removes --append-system-prompt-file) saw only
// TASK_RULES — so the question-park, task-lane watch_job and thread
// ask-mirroring features were unreachable for them. TASK_RULES is the shared
// prompt tail of BOTH lanes (buildTaskPrompt + buildThreadPrompt), so one
// bullet here wires all four CLIs; the per-lane Type support is stated in the
// bullet itself and DERIVED from the lane constants
// (THREAD_LANE_PA_META_TYPES/TASK_LANE_PA_META_TYPES in task-executor.ts —
// 2026-09-16: watch_job became real on the thread lane).
// ---------------------------------------------------------------------------

const PAMETA_ENVELOPE_TASK_RULES_BULLET = '- Machine actions ride the PA_META envelope: to emit one, end your reply with a single final line [PA_META]: {"actions":[...]} — single-line JSON, nothing after it. The question action above is {"type":"question","text":"...","options":["..."]}. A thread lane accepts question, confirm_required and watch_job{description,check,deadline_minutes} (check is a required object, e.g. {"type":"file_newer_than","path":"C:/abs/path"}); a task lane accepts question and watch_job plus kb_note{domain,note} and run_skill{skill} — an unsupported type comes back as a rejection notice, never a silently dropped action. Omit the envelope otherwise.';

describe('PA_META envelope bullet (task/thread lanes)', () => {
  it('task-executor.ts carries the bullet in TASK_RULES', async () => {
    const taskExecutorSource = await readFile(resolve(__dirname, '../../src/task-executor.ts'), 'utf8');
    assert.ok(taskExecutorSource.includes(PAMETA_ENVELOPE_TASK_RULES_BULLET),
      'task-executor.ts TASK_RULES must carry the PA_META envelope bullet verbatim');
  });

  it('buildTaskPrompt embeds TASK_RULES (the bullet rides both lanes)', async () => {
    const { buildTaskPrompt } = await import('../task-executor.js');
    const prompt = await buildTaskPrompt(
      { id: 'tt-test', title: 't', prompt: 'p', status: 'running', attempts: 1, created_at: new Date().toISOString(), created_by: 'test', micro_thread: [] } as never,
      { chatId: 1, threadId: 2, topicName: 'x' }
    );
    assert.ok(prompt.includes(PAMETA_ENVELOPE_TASK_RULES_BULLET),
      'buildTaskPrompt output must carry the PA_META envelope bullet');
  });

  it('lane clauses in the bullet are derived from the exported lane-type constants', async () => {
    const { THREAD_LANE_PA_META_TYPES, TASK_LANE_PA_META_TYPES } = await import('../task-executor.js');
    const [threadSeg, taskSeg] = PAMETA_ENVELOPE_TASK_RULES_BULLET.split(';');
    // Every type a lane accepts must be taught in its segment of the bullet.
    for (const t of THREAD_LANE_PA_META_TYPES) {
      assert.ok(threadSeg.includes(t), `thread segment must teach ${t}`);
    }
    for (const t of TASK_LANE_PA_META_TYPES) {
      assert.ok(taskSeg.includes(t), `task segment must teach ${t}`);
    }
    // And no lane may teach a type its constant does not list (drift catch).
    for (const t of TASK_LANE_PA_META_TYPES.filter((x) => !(THREAD_LANE_PA_META_TYPES as readonly string[]).includes(x))) {
      assert.ok(!threadSeg.includes(t), `thread segment must not teach task-only ${t}`);
    }
    for (const t of THREAD_LANE_PA_META_TYPES.filter((x) => !(TASK_LANE_PA_META_TYPES as readonly string[]).includes(x))) {
      assert.ok(!taskSeg.includes(t), `task segment must not teach thread-only ${t}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Progress-posting bullet (2026-09-14): task_telemetry.py --event task.progress
// existed and carried hundreds of events from SPEC-taught waves, but no
// general worker prompt taught it — the inbox's Running substate derives from
// the latest step, so untaught means the operator sees a bare Running state
// for the whole task. Same byte-identical sync pattern as the bullets above:
// context.ts's inline capabilities block ↔ examples/bot-instructions.example.md
// (tracked, CI-enforced half) ↔ the task lane's TASK_RULES. The gitignored
// local bot-instructions.md is hand-synced; its test is skip-guarded.
// ---------------------------------------------------------------------------

const PROGRESS_BULLET = '- Post a progress update when you complete each meaningful sub-step of a long task: run `python3 <repo>/projects/voice-inbox/scripts/task_telemetry.py --event task.progress --task <task_id> --step "<short plain-language phrase>" || python <repo>/projects/voice-inbox/scripts/task_telemetry.py --event task.progress --task <task_id> --step "<short plain-language phrase>"` — the inbox shows the operator what you are doing live while you work.';

describe('Progress-posting bullet', () => {
  it('matches examples/bot-instructions.example.md verbatim', async () => {
    const exampleContent = await readFile(BOT_INSTRUCTIONS_EXAMPLE_PATH, 'utf8');
    assert.ok(exampleContent.includes(PROGRESS_BULLET),
      'examples/bot-instructions.example.md must contain the progress-posting bullet verbatim');
  });

  it('context.ts inline capabilities block carries the SAME bullet', async () => {
    const inlinePrompt = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: false });
    assert.ok(inlinePrompt.includes(PROGRESS_BULLET),
      'context.ts inline capabilities block must contain the SAME progress-posting bullet verbatim — keep both in sync');
  });

  it('deployed bot-instructions.md carries the bullet (local, skip-guarded)', { skip: !BOT_INSTRUCTIONS_EXISTS && 'bot-instructions.md not present locally (public-clone default — see examples/bot-instructions.example.md)' }, async () => {
    const botInstructionsContent = await readFile(BOT_INSTRUCTIONS_PATH, 'utf8');
    assert.ok(botInstructionsContent.includes(PROGRESS_BULLET),
      'deployed bot-instructions.md must contain the progress-posting bullet verbatim — hand-sync on merge');
  });

  it('task-executor.ts carries the bullet in TASK_RULES', async () => {
    const taskExecutorSource = await readFile(resolve(__dirname, '../../src/task-executor.ts'), 'utf8');
    assert.ok(taskExecutorSource.includes(PROGRESS_BULLET),
      'task-executor.ts TASK_RULES must carry the progress-posting bullet verbatim');
  });

  it('is absent in omitStatic (lean) mode', async () => {
    const result = await buildPrompt('hello', makeState(), undefined, undefined, undefined, { omitStatic: true });
    assert.ok(!result.includes(PROGRESS_BULLET), 'lean mode must not include the progress-posting bullet');
  });

  it('is absent in execution mode (pendingAction set)', async () => {
    const result = await buildPrompt('yes', makeState(), undefined, undefined, 'send email to John', { omitStatic: false });
    assert.ok(!result.includes(PROGRESS_BULLET), 'execution mode must not include the progress-posting bullet');
  });
});
