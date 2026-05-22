import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { buildResumedPrompt, buildPrompt, shouldIncludeSkillStatus, _resetSkillStatusCache } from '../context.js';
import type { ConversationState } from '../types.js';
import type { TopicNameMap } from '../topic-names.js';

// Resolve path to bot-instructions.md relative to compiled test location.
// Tests run from dist/tests/ so dist/../../bot-instructions.md = projects/telegram-bot/bot-instructions.md
const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_INSTRUCTIONS_PATH = resolve(__dirname, '../../bot-instructions.md');

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

  it('returns true when skill names are referenced', () => {
    assert.equal(shouldIncludeSkillStatus('portfolio report please'), true);
    assert.equal(shouldIncludeSkillStatus('how is fitness tracking going?'), true);
    assert.equal(shouldIncludeSkillStatus('update the ecosystem notes'), true);
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
