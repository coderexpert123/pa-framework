import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractReplyContext,
  describeRepliedMedia,
  resolveReplyContext,
  type ReplyContextMessage,
} from '../reply-context.js';
import { addTurn } from '../conversation.js';
import { _setDegradedForTest } from '../health.js';
import type { ConversationState, ConversationTurn } from '../types.js';

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return { chat_id: 1, last_update_id: 0, thread_id: 0, turns: [], ...overrides };
}

function makeTurn(role: 'user' | 'assistant', text: string, messageId?: number): ConversationTurn {
  return { role, text, timestamp: new Date().toISOString(), ...(messageId !== undefined && { message_id: messageId }) };
}

// ---------------------------------------------------------------------------
// extractReplyContext (moved verbatim from main.ts — same behavior)
// ---------------------------------------------------------------------------

describe('extractReplyContext', () => {
  it('returns undefined when no reply or quote', () => {
    assert.equal(extractReplyContext({}), undefined);
  });

  it('returns full reply text when no quote', () => {
    assert.equal(extractReplyContext({ reply_to_message: { text: 'full message' } }), 'full message');
  });

  it('returns caption when reply has no text', () => {
    assert.equal(extractReplyContext({ reply_to_message: { caption: 'photo caption' } }), 'photo caption');
  });

  it('prefers partial quote over full reply text', () => {
    assert.equal(
      extractReplyContext({ quote: { text: 'partial selection' }, reply_to_message: { text: 'full message' } }),
      'partial selection',
    );
  });

  it('falls back to reply text when quote text is empty string', () => {
    assert.equal(
      extractReplyContext({ quote: { text: '' }, reply_to_message: { text: 'full message' } }),
      'full message',
    );
  });
});

// ---------------------------------------------------------------------------
// describeRepliedMedia
// ---------------------------------------------------------------------------

describe('describeRepliedMedia', () => {
  it('returns undefined for undefined input', () => {
    assert.equal(describeRepliedMedia(undefined), undefined);
  });

  it('returns undefined when the message carries no media', () => {
    assert.equal(describeRepliedMedia({}), undefined);
  });

  it('describes a voice reply with duration', () => {
    assert.equal(
      describeRepliedMedia({ voice: { duration: 12 } }),
      "[Voice message, 12s — transcript not available in this bot's history]",
    );
  });

  it('describes an audio reply with file name and duration', () => {
    assert.equal(
      describeRepliedMedia({ audio: { duration: 30, file_name: 'song.mp3' } }),
      "[Audio file: song.mp3, 30s — transcript not available in this bot's history]",
    );
  });

  it('describes a video_note reply', () => {
    assert.equal(
      describeRepliedMedia({ video_note: { duration: 5 } }),
      "[Video note, 5s — transcript not available in this bot's history]",
    );
  });

  it('describes a photo reply', () => {
    assert.equal(describeRepliedMedia({ photo: [{}] }), '[Photo — no caption available in this bot\'s history]');
  });

  it('describes a document reply with file name', () => {
    assert.equal(
      describeRepliedMedia({ document: { file_name: 'report.pdf' } }),
      "[Document: report.pdf — not available in this bot's history]",
    );
  });

  it('precedence: voice wins over other media fields on a malformed object', () => {
    assert.match(describeRepliedMedia({ voice: { duration: 1 }, photo: [{}] } as any) ?? '', /Voice message/);
  });
});

// ---------------------------------------------------------------------------
// resolveReplyContext — resolution order
// ---------------------------------------------------------------------------

describe('resolveReplyContext', () => {
  it('step 1: msg.quote.text wins over everything else', async () => {
    const state = makeState();
    addTurn(state, makeTurn('user', 'archived text', 10));
    const msg: ReplyContextMessage = {
      quote: { text: 'explicit selection' },
      reply_to_message: { message_id: 10, text: 'live reply text' },
    };
    assert.equal(await resolveReplyContext(msg, state, {}), 'explicit selection');
  });

  it('step 2: resolves from the in-memory topic-turn window by message_id, verbatim', async () => {
    const state = makeState();
    addTurn(state, makeTurn('user', '[Voice message] hello there', 42));
    const msg: ReplyContextMessage = {
      reply_to_message: { message_id: 42, text: 'this text differs from the archived turn' },
    };
    assert.equal(await resolveReplyContext(msg, state, {}), '[Voice message] hello there');
  });

  it('step 2 never matches an assistant turn (no message_id) — falls through to step 4', async () => {
    const state = makeState();
    const assistantTurn = makeTurn('assistant', 'bot reply text');
    state.turns.push(assistantTurn);
    const msg: ReplyContextMessage = {
      reply_to_message: { message_id: 99, text: 'live bot reply text' },
    };
    assert.equal(await resolveReplyContext(msg, state, {}), 'live bot reply text');
  });

  it('security regression: a reply to a redacted /auth turn resolves the redacted text, never the live code', async () => {
    const state = makeState();
    addTurn(state, makeTurn('user', '/auth [redacted]', 100));
    const msg: ReplyContextMessage = {
      reply_to_message: {
        message_id: 100,
        text: '/auth 4/0AY0e-g7RAW_SECRET_CODE_HERE some_state_value',
      },
    };
    const result = await resolveReplyContext(msg, state, {});
    assert.equal(result, '/auth [redacted]');
    assert.ok(!String(result).includes('RAW_SECRET_CODE_HERE'));
  });

  it('step 3: falls back to the archive when the turn is not in the in-memory window', async () => {
    const state = makeState();
    let calledWith: [number, number] | undefined;
    const msg: ReplyContextMessage = {
      reply_to_message: { message_id: 55, text: 'stale live text' },
    };
    const result = await resolveReplyContext(msg, state, {
      archiveLookup: async (threadId, messageId) => {
        calledWith = [threadId, messageId];
        return '[Voice message] archived transcript';
      },
    });
    assert.equal(result, '[Voice message] archived transcript');
    assert.deepEqual(calledWith, [state.thread_id, 55]);
  });

  it('step 3 is skipped when degraded — falls through to step 4', async () => {
    const state = makeState();
    let called = false;
    const msg: ReplyContextMessage = {
      reply_to_message: { message_id: 55, text: 'live text' },
    };
    const result = await resolveReplyContext(msg, state, {
      degraded: () => true,
      archiveLookup: async () => { called = true; return 'should never be used'; },
    });
    assert.equal(called, false);
    assert.equal(result, 'live text');
  });

  it('step 3 is only attempted when reply_to_message.message_id is present', async () => {
    const state = makeState();
    let called = false;
    const msg: ReplyContextMessage = { reply_to_message: { text: 'no message_id here' } };
    const result = await resolveReplyContext(msg, state, {
      archiveLookup: async () => { called = true; return 'unused'; },
    });
    assert.equal(called, false);
    assert.equal(result, 'no message_id here');
  });

  it('archive fault never throws — falls through to step 4', async () => {
    const state = makeState();
    const msg: ReplyContextMessage = { reply_to_message: { message_id: 7, text: 'fallback text' } };
    const result = await resolveReplyContext(msg, state, {
      archiveLookup: async () => { throw new Error('disk exploded'); },
    });
    assert.equal(result, 'fallback text');
  });

  it('step 4: reply_to_message.caption when no text', async () => {
    const state = makeState();
    const msg: ReplyContextMessage = { reply_to_message: { message_id: 8, caption: 'a caption' } };
    const result = await resolveReplyContext(msg, state, {
      archiveLookup: async () => null,
    });
    assert.equal(result, 'a caption');
  });

  it('step 5: falls to describeRepliedMedia stub when nothing else resolves', async () => {
    const state = makeState();
    const msg: ReplyContextMessage = { reply_to_message: { message_id: 9, voice: { duration: 3 } } };
    const result = await resolveReplyContext(msg, state, { archiveLookup: async () => null });
    assert.equal(result, "[Voice message, 3s — transcript not available in this bot's history]");
  });

  it('step 6: undefined when there is no reply at all', async () => {
    const state = makeState();
    assert.equal(await resolveReplyContext({}, state, {}), undefined);
  });
});

// ---------------------------------------------------------------------------
// resolveReplyContext — default deps (real conversation.ts archive lookup)
// ---------------------------------------------------------------------------

describe('resolveReplyContext with default (non-injected) archive lookup', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-reply-context-'));
    process.env.PA_HOME = tempDir;
    _setDegradedForTest(false);
  });

  afterEach(async () => {
    delete process.env.PA_HOME;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('resolves via the real conversation-history.jsonl when the turn window is empty', async () => {
    const threadId = 12;
    const archivedTurn: ConversationTurn = {
      role: 'user',
      text: '[Voice message] archived via real lookup',
      timestamp: new Date().toISOString(),
      message_id: 321,
      thread_id: threadId,
    };
    await writeFile(join(tempDir, 'conversation-history.jsonl'), JSON.stringify(archivedTurn) + '\n', 'utf8');

    const state = makeState({ thread_id: threadId });
    const msg: ReplyContextMessage = { reply_to_message: { message_id: 321, text: 'live text should lose' } };
    const result = await resolveReplyContext(msg, state, {});
    assert.equal(result, '[Voice message] archived via real lookup');
  });

  it('does not resolve via archive when degraded (real isDegraded default)', async () => {
    const threadId = 13;
    const archivedTurn: ConversationTurn = {
      role: 'user',
      text: '[Voice message] should not be used',
      timestamp: new Date().toISOString(),
      message_id: 654,
      thread_id: threadId,
    };
    await writeFile(join(tempDir, 'conversation-history.jsonl'), JSON.stringify(archivedTurn) + '\n', 'utf8');
    _setDegradedForTest(true);

    const state = makeState({ thread_id: threadId });
    const msg: ReplyContextMessage = { reply_to_message: { message_id: 654, text: 'live fallback text' } };
    const result = await resolveReplyContext(msg, state, {});
    assert.equal(result, 'live fallback text');
    _setDegradedForTest(false);
  });
});
