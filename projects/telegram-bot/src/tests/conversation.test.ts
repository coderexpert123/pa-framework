import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { addTurn, formatHistory, loadState, saveState, loadTopicState, saveTopicState, findHistoricalSessionTurns, findRecentTurnsByTopic, listTopicStateRefs } from '../conversation.js';
import type { ConversationState, ConversationTurn } from '../types.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'tgbot-test-'));
  process.env.PA_HOME = tempDir;
});

afterEach(async () => {
  delete process.env.PA_HOME;
  await rm(tempDir, { recursive: true, force: true });
});

function makeState(chatId = 123): ConversationState {
  return { chat_id: chatId, last_update_id: 0, thread_id: 0, turns: [] };
}

function makeTurn(role: 'user' | 'assistant', text: string, messageId?: number): ConversationTurn {
  return { role, text, timestamp: new Date().toISOString(), ...(messageId !== undefined && { message_id: messageId }) };
}

// ---------------------------------------------------------------------------
// formatHistory
// ---------------------------------------------------------------------------

describe('formatHistory', () => {
  it('returns placeholder for empty history', () => {
    assert.equal(formatHistory([]), '(no prior conversation)');
  });

  it('formats a single user turn', () => {
    assert.equal(formatHistory([makeTurn('user', 'hello')]), 'User: hello');
  });

  it('formats a single assistant turn', () => {
    assert.equal(formatHistory([makeTurn('assistant', 'hi there')]), 'Assistant: hi there');
  });

  it('separates turns with double newline', () => {
    const turns = [makeTurn('user', 'ping'), makeTurn('assistant', 'pong')];
    assert.equal(formatHistory(turns), 'User: ping\n\nAssistant: pong');
  });

  it('handles multiple turns in correct order', () => {
    const turns = [
      makeTurn('user', 'a'),
      makeTurn('assistant', 'b'),
      makeTurn('user', 'c'),
    ];
    assert.equal(formatHistory(turns), 'User: a\n\nAssistant: b\n\nUser: c');
  });

  it('preserves multiline text within a turn', () => {
    const turns = [makeTurn('user', 'line1\nline2')];
    assert.equal(formatHistory(turns), 'User: line1\nline2');
  });

  it('ignores optional message_id field in output', () => {
    const turns = [makeTurn('user', 'hello', 42)];
    assert.equal(formatHistory(turns), 'User: hello');
  });
});

// ---------------------------------------------------------------------------
// addTurn
// ---------------------------------------------------------------------------

describe('addTurn', () => {
  it('appends a turn to state', () => {
    const state = makeState();
    addTurn(state, makeTurn('user', 'test'));
    assert.equal(state.turns.length, 1);
    assert.equal(state.turns[0].text, 'test');
    assert.equal(state.turns[0].role, 'user');
  });

  it('appends multiple turns in insertion order', () => {
    const state = makeState();
    addTurn(state, makeTurn('user', 'first'));
    addTurn(state, makeTurn('assistant', 'second'));
    assert.equal(state.turns.length, 2);
    assert.equal(state.turns[0].role, 'user');
    assert.equal(state.turns[1].role, 'assistant');
  });

  it('does not mutate other state fields', () => {
    const state = makeState();
    state.last_update_id = 99;
    addTurn(state, makeTurn('user', 'hi'));
    assert.equal(state.last_update_id, 99);
    assert.equal(state.chat_id, 123);
  });

  it('preserves optional message_id on the turn', () => {
    const state = makeState();
    addTurn(state, makeTurn('user', 'msg', 77));
    assert.equal(state.turns[0].message_id, 77);
  });

  it('does not require message_id', () => {
    const state = makeState();
    addTurn(state, makeTurn('user', 'no id'));
    assert.equal(state.turns[0].message_id, undefined);
  });
});

// ---------------------------------------------------------------------------
// loadState
// ---------------------------------------------------------------------------

describe('loadState', () => {
  it('returns default state when no file exists', async () => {
    const state = await loadState(42);
    assert.equal(state.chat_id, 42);
    assert.equal(state.last_update_id, 0);
    assert.deepEqual(state.turns, []);
    assert.equal(state.pending_action, undefined);
  });

  it('returns saved state for matching chat_id', async () => {
    const state = makeState(99);
    state.last_update_id = 5;
    addTurn(state, makeTurn('user', 'hello'));
    await saveState(state);

    const loaded = await loadState(99);
    assert.equal(loaded.chat_id, 99);
    assert.equal(loaded.last_update_id, 5);
    assert.equal(loaded.turns.length, 1);
    assert.equal(loaded.turns[0].text, 'hello');
  });

  it('returns fresh turns but preserves last_update_id when chat_id differs', async () => {
    const state = makeState(10);
    state.last_update_id = 100;
    addTurn(state, makeTurn('user', 'old message'));
    await saveState(state);

    const loaded = await loadState(20);
    assert.equal(loaded.chat_id, 20);
    assert.equal(loaded.last_update_id, 100, 'Telegram offset should be preserved across chat_id change');
    assert.deepEqual(loaded.turns, [], 'conversation history should be cleared');
  });

  it('returns default state for corrupted JSON', async () => {
    const statePath = join(tempDir, 'telegram-bot-state.json');
    await writeFile(statePath, '{ not valid json }', 'utf8');
    const state = await loadState(123);
    assert.equal(state.chat_id, 123);
    assert.equal(state.last_update_id, 0);
    assert.deepEqual(state.turns, []);
  });

  it('returns default state for empty file', async () => {
    const statePath = join(tempDir, 'telegram-bot-state.json');
    await writeFile(statePath, '', 'utf8');
    const state = await loadState(123);
    assert.equal(state.chat_id, 123);
    assert.deepEqual(state.turns, []);
  });

  it('returns default state for valid JSON with wrong shape', async () => {
    const statePath = join(tempDir, 'telegram-bot-state.json');
    await writeFile(statePath, JSON.stringify({ foo: 'bar' }), 'utf8');
    // chat_id undefined !== 123, so returns fresh state
    const state = await loadState(123);
    assert.equal(state.chat_id, 123);
    assert.equal(state.last_update_id, 0, 'last_update_id must default to 0 when field is absent');
    assert.deepEqual(state.turns, []);
  });

  it('returns 0 for last_update_id when chat_id differs and saved state has no last_update_id', async () => {
    const statePath = join(tempDir, 'telegram-bot-state.json');
    await writeFile(statePath, JSON.stringify({ chat_id: 99 }), 'utf8'); // no last_update_id field
    const state = await loadState(123);
    assert.equal(state.last_update_id, 0, 'should not set last_update_id to undefined');
  });
});

// ---------------------------------------------------------------------------
// saveState / loadState round-trip
// ---------------------------------------------------------------------------

describe('saveState round-trip', () => {
  it('persists last_update_id correctly', async () => {
    const state = makeState();
    state.last_update_id = 9999;
    await saveState(state);
    const loaded = await loadState(123);
    assert.equal(loaded.last_update_id, 9999);
  });

  it('persists pending_action with all fields', async () => {
    const state = makeState();
    const proposed_at = new Date().toISOString();
    state.pending_action = { description: 'send invoice email', proposed_at };
    await saveState(state);

    const loaded = await loadState(123);
    assert.ok(loaded.pending_action);
    assert.equal(loaded.pending_action!.description, 'send invoice email');
    assert.equal(loaded.pending_action!.proposed_at, proposed_at);
  });

  it('persists turn message_id', async () => {
    const state = makeState();
    addTurn(state, makeTurn('user', 'hi', 42));
    await saveState(state);

    const loaded = await loadState(123);
    assert.equal(loaded.turns[0].message_id, 42);
  });

  it('round-trips empty turns array', async () => {
    const state = makeState();
    state.last_update_id = 5;
    await saveState(state);

    const loaded = await loadState(123);
    assert.deepEqual(loaded.turns, []);
    assert.equal(loaded.last_update_id, 5);
  });

  it('persists last_update_id = -1 sentinel correctly (drain complete, no prior messages)', async () => {
    const state = makeState();
    state.last_update_id = -1;
    await saveState(state);
    const loaded = await loadState(123);
    assert.equal(loaded.last_update_id, -1);
  });

  it('overwrites previous save on second saveState call', async () => {
    const state = makeState();
    addTurn(state, makeTurn('user', 'first'));
    await saveState(state);

    addTurn(state, makeTurn('assistant', 'reply'));
    await saveState(state);

    const loaded = await loadState(123);
    assert.equal(loaded.turns.length, 2);
  });

  it('persists session info through save/load', async () => {
    const state = makeState();
    const started_at = new Date().toISOString();
    state.session = { session_id: 'aaaa-bbbb-cccc', worker: 'gemini', started_at };
    await saveState(state);

    const loaded = await loadState(123);
    assert.deepEqual(loaded.session, state.session);
  });

  it('clears session when saved as undefined', async () => {
    const state = makeState();
    state.session = { session_id: 'some-id', worker: 'claude', started_at: new Date().toISOString() };
    await saveState(state);

    state.session = undefined;
    await saveState(state);

    const loaded = await loadState(123);
    assert.equal(loaded.session, undefined);
  });
});

// ---------------------------------------------------------------------------
// session backward compatibility — loading pre-session state files
// ---------------------------------------------------------------------------

describe('session backward compatibility', () => {
  it('loads pre-session state file with session undefined', async () => {
    // Simulate an old state file written before the session field was added
    await writeFile(
      join(tempDir, 'telegram-bot-state.json'),
      JSON.stringify({ chat_id: 123, last_update_id: 5, turns: [] }),
      'utf8'
    );
    const state = await loadState(123);
    assert.equal(state.session, undefined);
    assert.equal(state.last_update_id, 5);
  });
});

// ---------------------------------------------------------------------------
// saveState trimming — MAX_TURNS (20)
// ---------------------------------------------------------------------------

describe('saveState MAX_TURNS trimming', () => {
  it('drops oldest turns when count exceeds 20', async () => {
    const state = makeState();
    for (let i = 0; i < 25; i++) {
      addTurn(state, makeTurn('user', `message ${i}`));
    }
    await saveState(state);

    const loaded = await loadState(123);
    assert.equal(loaded.turns.length, 20);
    assert.equal(loaded.turns[0].text, 'message 5');
    assert.equal(loaded.turns[19].text, 'message 24');
  });

  it('does not trim when turn count is exactly 20', async () => {
    const state = makeState();
    for (let i = 0; i < 20; i++) {
      addTurn(state, makeTurn('user', `msg ${i}`));
    }
    await saveState(state);

    const loaded = await loadState(123);
    assert.equal(loaded.turns.length, 20);
    assert.equal(loaded.turns[0].text, 'msg 0');
  });

  it('does not trim when turn count is under 20', async () => {
    const state = makeState();
    for (let i = 0; i < 5; i++) {
      addTurn(state, makeTurn('user', `msg ${i}`));
    }
    await saveState(state);

    const loaded = await loadState(123);
    assert.equal(loaded.turns.length, 5);
  });
});

// ---------------------------------------------------------------------------
// saveState trimming — char budget (8000)
// ---------------------------------------------------------------------------

describe('saveState char budget trimming', () => {
  it('drops oldest turns when total chars exceed 8000', async () => {
    const state = makeState();
    // 5 × 2000 = 10000 chars, over budget
    for (let i = 0; i < 5; i++) {
      addTurn(state, makeTurn('user', 'x'.repeat(2000)));
    }
    await saveState(state);

    const loaded = await loadState(123);
    assert.ok(loaded.turns.length >= 2, 'must keep at least 2 turns');
    const total = loaded.turns.reduce((s, t) => s + t.text.length, 0);
    assert.ok(
      total <= 8000 || loaded.turns.length === 2,
      `char budget violated: ${total} chars, ${loaded.turns.length} turns`,
    );
  });

  it('does not drop turns when total chars are exactly 8000', async () => {
    const state = makeState();
    // 4 × 2000 = 8000 chars — exactly at limit, should not drop
    for (let i = 0; i < 4; i++) {
      addTurn(state, makeTurn('user', 'y'.repeat(2000)));
    }
    await saveState(state);

    const loaded = await loadState(123);
    assert.equal(loaded.turns.length, 4);
  });

  it('keeps minimum 2 turns even when both exceed char budget', async () => {
    const state = makeState();
    // 2 × 6000 = 12000 chars — over budget but cannot drop below 2
    addTurn(state, makeTurn('user', 'a'.repeat(6000)));
    addTurn(state, makeTurn('assistant', 'b'.repeat(6000)));
    await saveState(state);

    const loaded = await loadState(123);
    assert.equal(loaded.turns.length, 2);
  });

  it('keeps single turn even if it exceeds char budget (floor at 2 only applies when > 2)', async () => {
    const state = makeState();
    // Only 1 turn, very long — loop condition `turns.length > 2` is false so nothing drops
    addTurn(state, makeTurn('user', 'z'.repeat(9000)));
    await saveState(state);

    const loaded = await loadState(123);
    assert.equal(loaded.turns.length, 1);
  });

  it('drops exactly enough to bring total under 8000 (not more)', async () => {
    const state = makeState();
    // 4 turns × 2001 = 8004 chars — only need to drop 1 turn to get to 6003
    for (let i = 0; i < 4; i++) {
      addTurn(state, makeTurn('user', 'q'.repeat(2001)));
    }
    await saveState(state);

    const loaded = await loadState(123);
    // After dropping 1 oldest turn: 3 × 2001 = 6003 ≤ 8000
    assert.equal(loaded.turns.length, 3);
  });

  it('applies MAX_TURNS trim before char budget trim (oldest are already gone)', async () => {
    const state = makeState();
    // 25 turns of 400 chars = 10000 chars but MAX_TURNS=20 applies first → 8000 chars exactly
    for (let i = 0; i < 25; i++) {
      addTurn(state, makeTurn('user', 'r'.repeat(400)));
    }
    await saveState(state);

    const loaded = await loadState(123);
    // After MAX_TURNS trim: 20 turns × 400 = 8000 chars — at limit, no char drop
    assert.equal(loaded.turns.length, 20);
  });
});

// ---------------------------------------------------------------------------
// conversation archival — conversation-history.jsonl
// ---------------------------------------------------------------------------

describe('conversation archival', () => {
  function archivePath(): string {
    return join(tempDir, 'conversation-history.jsonl');
  }

  function readArchive(): Promise<ConversationTurn[]> {
    return readFile(archivePath(), 'utf8').then((raw) =>
      raw
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as ConversationTurn),
    );
  }

  it('archives all turns on first save', async () => {
    const state = makeState();
    addTurn(state, makeTurn('user', 'hello'));
    addTurn(state, makeTurn('assistant', 'hi'));
    await saveState(state);

    const archived = await readArchive();
    assert.equal(archived.length, 2);
    assert.equal(archived[0].text, 'hello');
    assert.equal(archived[1].text, 'hi');
  });

  it('does not duplicate turns on subsequent saves', async () => {
    const state = makeState();
    addTurn(state, makeTurn('user', 'first'));
    await saveState(state);

    addTurn(state, makeTurn('assistant', 'reply'));
    await saveState(state);

    const archived = await readArchive();
    assert.equal(archived.length, 2);
    assert.equal(archived[0].text, 'first');
    assert.equal(archived[1].text, 'reply');
  });

  it('archives turns that are trimmed from the rolling window', async () => {
    const state = makeState();
    // Fill beyond MAX_TURNS (20) so oldest get dropped from state
    for (let i = 0; i < 22; i++) {
      addTurn(state, makeTurn('user', `msg ${i}`));
    }
    await saveState(state);

    // State file should only have 20 turns
    const loaded = await loadState(123);
    assert.equal(loaded.turns.length, 20);

    // Archive should have all 22
    const archived = await readArchive();
    assert.equal(archived.length, 22);
    assert.equal(archived[0].text, 'msg 0');
    assert.equal(archived[21].text, 'msg 21');
  });

  it('creates archive file when it does not exist', async () => {
    const state = makeState();
    addTurn(state, makeTurn('user', 'new'));
    await saveState(state);

    const archived = await readArchive();
    assert.equal(archived.length, 1);
  });

  it('archive path respects PA_HOME env var', async () => {
    const state = makeState();
    addTurn(state, makeTurn('user', 'test'));
    await saveState(state);

    // Archive should be in tempDir (set as PA_HOME in beforeEach)
    const exists = await readFile(join(tempDir, 'conversation-history.jsonl'), 'utf8');
    assert.ok(exists.length > 0);
  });

  it('deduplicates user turns by message_id when timestamps collide (same-second Telegram timestamps)', async () => {
    const sameTs = '2026-04-06T05:00:01.000Z'; // Telegram second-precision — both messages same second
    const state = makeState();

    // First exchange
    addTurn(state, { role: 'user', text: 'msg A', timestamp: sameTs, message_id: 100 });
    addTurn(state, { role: 'assistant', text: 'reply A', timestamp: '2026-04-06T05:00:01.123Z' });
    await saveState(state);

    // Second exchange — same second, different message_id (simulates bot restart between messages)
    addTurn(state, { role: 'user', text: 'msg B', timestamp: sameTs, message_id: 101 });
    addTurn(state, { role: 'assistant', text: 'reply B', timestamp: '2026-04-06T05:00:01.456Z' });
    await saveState(state);

    const archived = await readArchive();
    assert.equal(archived.length, 4, 'all 4 turns must be archived');
    assert.equal(archived[2].text, 'msg B', 'second user turn must be in archive');
    assert.equal(archived[3].text, 'reply B', 'second assistant turn must be in archive');
  });

  it('state is still saved when archive write fails', async () => {
    // Place a directory at the archive path so appendFile throws EISDIR,
    // while the state file path (same tempDir) remains writable.
    await mkdir(join(tempDir, 'conversation-history.jsonl'));

    const state = makeState();
    addTurn(state, makeTurn('user', 'survive'));

    await assert.doesNotReject(saveState(state), 'saveState must not throw even when archive write fails');

    // State file must still have been written successfully
    const loaded = await loadState(123);
    assert.equal(loaded.turns.length, 1);
    assert.equal(loaded.turns[0].text, 'survive');
  });

  it('handles archive files larger than the tailRead buffer', async () => {
    // Pre-populate with 30 turns (~150 bytes each = ~4500 bytes total, exceeds 4096)
    const archivePath = join(tempDir, 'conversation-history.jsonl');
    const existing: string[] = [];
    for (let i = 0; i < 30; i++) {
      existing.push(JSON.stringify({
        role: 'user',
        text: `filler ${i} ${'x'.repeat(100)}`,
        timestamp: `2026-04-06T05:00:${String(i % 60).padStart(2, '0')}.000Z`,
        message_id: 1000 + i,
      }));
    }
    await writeFile(archivePath, existing.join('\n') + '\n', 'utf8');

    // Save new turns — should not throw SyntaxError
    const state = makeState();
    addTurn(state, makeTurn('user', 'new turn A', 2000));
    addTurn(state, makeTurn('assistant', 'new turn B'));
    await saveState(state);

    // Verify all turns archived
    const archived = await readArchive();
    assert.equal(archived.length, 32);
    assert.equal(archived[30].text, 'new turn A');
    assert.equal(archived[31].text, 'new turn B');
  });

  it('round-trips refId field on assistant turns through addTurn → archive', async () => {
    const state = makeState();
    addTurn(state, makeTurn('user', 'question', 100));
    addTurn(state, {
      role: 'assistant',
      text: 'answer',
      timestamp: new Date().toISOString(),
      worker: 'claude',
      session_id: 'sess-123',
      refId: 'c-a59a',
    });
    await saveState(state);

    const archived = await readArchive();
    const assistantTurn = archived.find((t) => t.role === 'assistant');
    assert.ok(assistantTurn, 'assistant turn must be archived');
    assert.equal(assistantTurn.refId, 'c-a59a');
  });
});

describe('preferred_worker persistence', () => {
  it('persists preferred_worker through save/load', async () => {
    const state = makeState();
    state.preferred_worker = 'claude';
    await saveState(state);
    const loaded = await loadState(123);
    assert.equal(loaded.preferred_worker, 'claude');
  });

  it('loads pre-preferred_worker state file with preferred_worker undefined', async () => {
    await writeFile(
      join(tempDir, 'telegram-bot-state.json'),
      JSON.stringify({ chat_id: 123, last_update_id: 5, turns: [] }),
      'utf8',
    );
    const loaded = await loadState(123);
    assert.equal(loaded.preferred_worker, undefined);
  });

  it('clears preferred_worker when saved as undefined', async () => {
    const state = makeState();
    state.preferred_worker = 'gemini';
    await saveState(state);
    state.preferred_worker = undefined;
    await saveState(state);
    const loaded = await loadState(123);
    assert.equal(loaded.preferred_worker, undefined);
  });
});

// ---------------------------------------------------------------------------
// loadTopicState / saveTopicState
// ---------------------------------------------------------------------------

describe('loadTopicState', () => {
  it('returns default state with correct thread_id when file absent', async () => {
    const state = await loadTopicState(123, 5);
    assert.equal(state.chat_id, 123);
    assert.equal(state.thread_id, 5);
    assert.deepEqual(state.turns, []);
    assert.equal(state.last_update_id, 0);
  });

  it('loads from telegram-bot-topic-{chatId}_{threadId}.json', async () => {
    const state = await loadTopicState(123, 7);
    addTurn(state, { role: 'user', text: 'hello topic 7', timestamp: new Date().toISOString() });
    await saveTopicState(state);

    const loaded = await loadTopicState(123, 7);
    assert.equal(loaded.thread_id, 7);
    assert.equal(loaded.turns.length, 1);
    assert.equal(loaded.turns[0].text, 'hello topic 7');
  });

  it('returns default state when chat_id does not match', async () => {
    const state = await loadTopicState(100, 5);
    await saveTopicState(state);
    // Load with different chat_id — should reset
    const loaded = await loadTopicState(999, 5);
    assert.equal(loaded.chat_id, 999);
    assert.deepEqual(loaded.turns, []);
  });

  it('coerces missing thread_id field from file to the requested threadId', async () => {
    // Hand-crafted file without thread_id
    await writeFile(
      join(tempDir, 'telegram-bot-topic-123_3.json'),
      JSON.stringify({ chat_id: 123, last_update_id: 0, turns: [] }),
      'utf8'
    );
    const loaded = await loadTopicState(123, 3);
    assert.equal(loaded.thread_id, 3);
  });

  it('returns default state for corrupt file', async () => {
    await writeFile(join(tempDir, 'telegram-bot-topic-123_9.json'), '{ bad json', 'utf8');
    const loaded = await loadTopicState(123, 9);
    assert.equal(loaded.thread_id, 9);
    assert.deepEqual(loaded.turns, []);
  });
});

describe('listTopicStateRefs', () => {
  it('enumerates valid topic-state filenames and ignores unrelated files', async () => {
    await writeFile(join(tempDir, 'telegram-bot-topic-123_5.json'), '{}', 'utf8');
    await writeFile(join(tempDir, 'telegram-bot-topic--1001234567890_310.json'), '{}', 'utf8');
    await writeFile(join(tempDir, 'telegram-bot-state.json'), '{}', 'utf8');
    await mkdir(join(tempDir, 'subdir'));

    const refs = await listTopicStateRefs();
    const keys = refs.map((ref) => `${ref.chatId}_${ref.threadId}`).sort();

    assert.deepEqual(keys, ['-1001234567890_310', '123_5']);
  });
});

describe('saveTopicState', () => {
  it('writes to telegram-bot-topic-{chatId}_{threadId}.json', async () => {
    const state = await loadTopicState(123, 42);
    addTurn(state, { role: 'user', text: 'test', timestamp: new Date().toISOString() });
    await saveTopicState(state);

    const raw = await readFile(join(tempDir, 'telegram-bot-topic-123_42.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.thread_id, 42);
    assert.equal(parsed.turns.length, 1);
  });

  it('two topics save independently without interfering', async () => {
    const stateA = await loadTopicState(123, 1);
    addTurn(stateA, { role: 'user', text: 'topic A', timestamp: new Date().toISOString() });
    await saveTopicState(stateA);

    const stateB = await loadTopicState(123, 2);
    addTurn(stateB, { role: 'user', text: 'topic B', timestamp: new Date().toISOString() });
    await saveTopicState(stateB);

    const loadedA = await loadTopicState(123, 1);
    const loadedB = await loadTopicState(123, 2);
    assert.equal(loadedA.turns[0].text, 'topic A');
    assert.equal(loadedB.turns[0].text, 'topic B');
  });

  it('archives turns with thread_id field stamped', async () => {
    const state = await loadTopicState(123, 11);
    addTurn(state, { role: 'user', text: 'archived', timestamp: new Date().toISOString() });
    await saveTopicState(state);

    const raw = await readFile(join(tempDir, 'conversation-history.jsonl'), 'utf8');
    const turn = JSON.parse(raw.trim().split('\n')[0]);
    assert.equal(turn.thread_id, 11);
  });

  it('does not touch telegram-bot-state.json', async () => {
    const state = await loadTopicState(123, 55);
    await saveTopicState(state);

    // telegram-bot-state.json must not exist (we never wrote it)
    try {
      await readFile(join(tempDir, 'telegram-bot-state.json'), 'utf8');
      assert.fail('global state file should not have been created');
    } catch (err: unknown) {
      assert.ok((err as NodeJS.ErrnoException).code === 'ENOENT', 'file must not exist');
    }
  });

  it('session survives intermediate and final double-save pattern', async () => {
    // Verifies the crash carry-off building block: processUpdate calls saveTopicState
    // twice — once immediately after dispatch (session only), once at the end (turns +
    // pending_action). Both the session and the assistant turn must survive.
    const session = { session_id: 'abc-123', worker: 'gemini', started_at: new Date().toISOString() };
    const state = await loadTopicState(123, 5);
    state.session = session;

    // Intermediate save (session persisted, no assistant turn yet)
    await saveTopicState(state);

    // Final save (assistant turn added on top)
    addTurn(state, { role: 'assistant', text: 'response text', timestamp: new Date().toISOString() });
    await saveTopicState(state);

    // Reload and verify both session AND turn survived the double-save
    const loaded = await loadTopicState(123, 5);
    assert.equal(loaded.session?.session_id, 'abc-123', 'session_id must survive double-save');
    assert.equal(loaded.session?.worker, 'gemini', 'session worker must survive double-save');
    assert.equal(loaded.turns.length, 1, 'assistant turn must be present after final save');
    assert.equal(loaded.turns[0].text, 'response text', 'assistant turn text must match');
  });

  it('does not duplicate turns when archive tail is dominated by a different thread', async () => {
    // Reproduce the cross-topic dedup bug: archive tail full of entries from thread 99.
    // Thread 29 turns must not be re-archived on subsequent saveTopicState calls.
    const archivePath = join(tempDir, 'conversation-history.jsonl');

    // Write 30 entries from thread 99 — enough to fill the old 4096-byte window
    const otherLines: string[] = [];
    for (let i = 0; i < 30; i++) {
      otherLines.push(JSON.stringify({
        role: 'user',
        text: `other topic filler ${i} ${'x'.repeat(80)}`,
        timestamp: `2026-04-16T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
        message_id: 5000 + i,
        thread_id: 99,
      }));
    }
    await writeFile(archivePath, otherLines.join('\n') + '\n', 'utf8');

    // Save thread 29's state once
    const state = await loadTopicState(123, 29);
    addTurn(state, { role: 'user', text: 'synthetic data question', timestamp: '2026-04-16T12:16:10.000Z', message_id: 1000 });
    addTurn(state, { role: 'assistant', text: 'answer about synthetic data', timestamp: '2026-04-16T12:17:00.000Z' });
    await saveTopicState(state);

    // Save again — simulates bot restart re-saving state; should not re-archive
    await saveTopicState(state);

    // Thread 29 turns must appear exactly once each
    const raw = await readFile(archivePath, 'utf8');
    const allLines = raw.trim().split('\n').filter(Boolean);
    const thread29Lines = allLines
      .map((l: string) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((t: any) => t && t.thread_id === 29);

    assert.equal(thread29Lines.length, 2, `expected 2 thread-29 entries, got ${thread29Lines.length}`);
  });
});

// ---------------------------------------------------------------------------
// Watermark dedup — per-thread persistent watermarks
// ---------------------------------------------------------------------------

describe('saveTopicState watermark dedup', () => {
  function watermarkPath(): string {
    return join(tempDir, 'conversation-archive-watermarks.json');
  }

  async function readWatermarks(): Promise<Record<string, { lastUserMsgId: number; lastTimestamp: string }>> {
    const raw = await readFile(watermarkPath(), 'utf8');
    return JSON.parse(raw);
  }

  it('creates watermark file on first saveTopicState', async () => {
    const state = await loadTopicState(123, 29);
    const ts = '2026-04-19T10:00:00.000Z';
    addTurn(state, { role: 'user', text: 'hello', timestamp: ts, message_id: 100 });
    await saveTopicState(state);

    const wm = await readWatermarks();
    assert.ok(wm['29'], 'watermark entry for thread 29 must exist');
    assert.equal(wm['29'].lastUserMsgId, 100);
    assert.equal(wm['29'].lastTimestamp, ts);
  });

  it('watermark prevents cross-topic message_id contamination', async () => {
    const archivePath = join(tempDir, 'conversation-history.jsonl');

    // Save turns for thread 29 with a high message_id
    const state29 = await loadTopicState(123, 29);
    addTurn(state29, { role: 'user', text: 'thread29 msg', timestamp: '2026-04-19T10:00:00.000Z', message_id: 1000 });
    await saveTopicState(state29);

    // Save turns for thread 310 with a lower message_id — must NOT be filtered by thread 29's watermark
    const state310 = await loadTopicState(123, 310);
    addTurn(state310, { role: 'user', text: 'thread310 msg', timestamp: '2026-04-19T11:00:00.000Z', message_id: 50 });
    await saveTopicState(state310);

    // Second save of thread 310 — simulates restart re-save; must not re-archive
    await saveTopicState(state310);

    const raw = await readFile(archivePath, 'utf8');
    const allLines = raw.trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l));
    const thread310Lines = allLines.filter((t: any) => t.thread_id === 310);

    assert.equal(thread310Lines.length, 1, `thread 310 turn must appear exactly once, got ${thread310Lines.length}`);
  });

  it('watermark persists correct values after multiple saves to same thread', async () => {
    const archivePath = join(tempDir, 'conversation-history.jsonl');

    const state = await loadTopicState(123, 55);
    addTurn(state, { role: 'user', text: 'msg A', timestamp: '2026-04-19T10:00:00.000Z', message_id: 100 });
    await saveTopicState(state);

    addTurn(state, { role: 'user', text: 'msg B', timestamp: '2026-04-19T10:01:00.000Z', message_id: 101 });
    await saveTopicState(state);

    const raw = await readFile(archivePath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l));
    const thread55Lines = lines.filter((t: any) => t.thread_id === 55);
    assert.equal(thread55Lines.length, 2, 'both turns must be archived exactly once');

    const wm = await readWatermarks();
    assert.equal(wm['55'].lastUserMsgId, 101);
  });

  it('watermark persists after saving with only an assistant turn (no message_id)', async () => {
    const state = await loadTopicState(123, 77);
    const ts = '2026-04-19T10:00:00.000Z';
    addTurn(state, { role: 'assistant', text: 'hi there', timestamp: ts });
    await saveTopicState(state);

    const wm = await readWatermarks();
    assert.ok(wm['77'], 'watermark entry for thread 77 must exist');
    assert.equal(wm['77'].lastUserMsgId, -1, 'no user turn means lastUserMsgId stays -1');
    assert.equal(wm['77'].lastTimestamp, ts);
  });
});

// ---------------------------------------------------------------------------
// findHistoricalSessionTurns
// ---------------------------------------------------------------------------

describe('findHistoricalSessionTurns', () => {
  async function writeArchive(turns: ConversationTurn[]): Promise<void> {
    const archivePath = join(tempDir, 'conversation-history.jsonl');
    const lines = turns.map((t) => JSON.stringify(t)).join('\n') + '\n';
    await writeFile(archivePath, lines, 'utf8');
  }

  it('returns empty array when archive does not exist', async () => {
    const result = await findHistoricalSessionTurns('sess1', 5, 20);
    assert.deepEqual(result, []);
  });

  it('returns turns matching sessionId and threadId', async () => {
    const turns: ConversationTurn[] = [
      { role: 'user',      text: 'q1', timestamp: '2026-01-01T00:00:00Z', thread_id: 5, session_id: 'sess1' },
      { role: 'assistant', text: 'a1', timestamp: '2026-01-01T00:00:01Z', thread_id: 5, session_id: 'sess1' },
      { role: 'user',      text: 'q2', timestamp: '2026-01-01T01:00:00Z', thread_id: 5, session_id: 'sess2' },
    ];
    await writeArchive(turns);
    const result = await findHistoricalSessionTurns('sess1', 5, 20);
    assert.equal(result.length, 2);
    assert.equal(result[0].text, 'q1');
    assert.equal(result[1].text, 'a1');
  });

  it('ignores turns from a different threadId', async () => {
    const turns: ConversationTurn[] = [
      { role: 'user', text: 'wrong topic', timestamp: '2026-01-01T00:00:00Z', thread_id: 99, session_id: 'sess1' },
      { role: 'user', text: 'right topic', timestamp: '2026-01-01T00:00:01Z', thread_id: 5,  session_id: 'sess1' },
    ];
    await writeArchive(turns);
    const result = await findHistoricalSessionTurns('sess1', 5, 20);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'right topic');
  });

  it('respects maxTurns cap', async () => {
    const turns: ConversationTurn[] = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const,
      text: `msg ${i}`,
      timestamp: `2026-01-01T00:0${i}:00Z`,
      thread_id: 5,
      session_id: 'sess1',
    }));
    await writeArchive(turns);
    const result = await findHistoricalSessionTurns('sess1', 5, 3);
    assert.equal(result.length, 3);
    assert.equal(result[0].text, 'msg 7');
    assert.equal(result[2].text, 'msg 9');
  });

  it('returns empty array when sessionId not found', async () => {
    const turns: ConversationTurn[] = [
      { role: 'user', text: 'hello', timestamp: '2026-01-01T00:00:00Z', thread_id: 5, session_id: 'other' },
    ];
    await writeArchive(turns);
    const result = await findHistoricalSessionTurns('sess1', 5, 20);
    assert.deepEqual(result, []);
  });

  it('handles malformed JSON lines gracefully', async () => {
    const archivePath = join(tempDir, 'conversation-history.jsonl');
    const good = JSON.stringify({ role: 'user', text: 'ok', timestamp: '2026-01-01T00:00:00Z', thread_id: 5, session_id: 'sess1' });
    await writeFile(archivePath, `{bad json}\n${good}\n`, 'utf8');
    const result = await findHistoricalSessionTurns('sess1', 5, 20);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'ok');
  });
});

// ---------------------------------------------------------------------------
// findRecentTurnsByTopic
// ---------------------------------------------------------------------------

describe('findRecentTurnsByTopic', () => {
  async function writeArchive(turns: ConversationTurn[]): Promise<void> {
    const archivePath = join(tempDir, 'conversation-history.jsonl');
    const lines = turns.map((t) => JSON.stringify(t)).join('\n') + '\n';
    await writeFile(archivePath, lines, 'utf8');
  }

  it('returns empty when archive does not exist', async () => {
    const result = await findRecentTurnsByTopic(5, 10);
    assert.deepEqual(result, []);
  });

  it('returns only turns from the given threadId', async () => {
    const turns: ConversationTurn[] = [
      { role: 'user', text: 'topic5',  timestamp: '2026-01-01T00:00:00Z', thread_id: 5 },
      { role: 'user', text: 'topic99', timestamp: '2026-01-01T00:00:01Z', thread_id: 99 },
    ];
    await writeArchive(turns);
    const result = await findRecentTurnsByTopic(5, 10);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'topic5');
  });

  it('respects maxTurns cap, returning the most recent', async () => {
    const turns: ConversationTurn[] = Array.from({ length: 8 }, (_, i) => ({
      role: 'user' as const,
      text: `msg ${i}`,
      timestamp: `2026-01-01T00:0${i}:00Z`,
      thread_id: 5,
    }));
    await writeArchive(turns);
    const result = await findRecentTurnsByTopic(5, 3);
    assert.equal(result.length, 3);
    assert.equal(result[0].text, 'msg 5');
    assert.equal(result[2].text, 'msg 7');
  });
});
