import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadTopicNames,
  saveTopicNames,
  updateTopicName,
  setTopicDescription,
  getTopicName,
  extractTopicEvent,
  loadBranches,
  saveBranches,
  addBranch,
  removeBranch,
  getBranchEntry,
  findBranchParent,
  type TopicNameMap,
  type BranchIndex,
} from '../topic-names.js';
import type { TelegramMessage } from '../types.js';
import { buildTopicDescription } from '../context.js';
import type { ConversationState } from '../types.js';

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    chat_id: -1001234567890,
    thread_id: 29,
    last_update_id: 0,
    turns: [],
    ...overrides,
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'tgbot-topic-names-'));
  process.env.PA_HOME = tempDir;
});

afterEach(async () => {
  delete process.env.PA_HOME;
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadTopicNames
// ---------------------------------------------------------------------------

describe('loadTopicNames', () => {
  it('returns empty map when file does not exist', async () => {
    const map = await loadTopicNames();
    assert.equal(map.size, 0);
  });

  it('returns empty map when file contains invalid JSON', async () => {
    await writeFile(join(tempDir, 'telegram-topic-names.json'), '{ bad json }', 'utf8');
    const map = await loadTopicNames();
    assert.equal(map.size, 0);
  });

  it('parses valid JSON into correct Map structure', async () => {
    await writeFile(
      join(tempDir, 'telegram-topic-names.json'),
      JSON.stringify({ '-1001234567890': { '29': 'daily-briefings', '0': 'General' } }),
      'utf8'
    );
    const map = await loadTopicNames();
    assert.equal(map.size, 1);
    const inner = map.get('-1001234567890');
    assert.ok(inner, 'inner map should exist');
    assert.equal(inner.get(29)?.name, 'daily-briefings');
    assert.equal(inner.get(0)?.name, 'General');
  });

  it('skips entries with NaN threadId', async () => {
    await writeFile(
      join(tempDir, 'telegram-topic-names.json'),
      JSON.stringify({ '-1001234567890': { 'notanumber': 'bad', '5': 'ok' } }),
      'utf8'
    );
    const map = await loadTopicNames();
    const inner = map.get('-1001234567890');
    assert.ok(inner);
    assert.equal(inner.size, 1);
    assert.equal(inner.get(5)?.name, 'ok');
  });
});

// ---------------------------------------------------------------------------
// saveTopicNames + roundtrip
// ---------------------------------------------------------------------------

describe('saveTopicNames', () => {
  it('writes file that loadTopicNames can read back', async () => {
    const map: TopicNameMap = new Map([
      ['-1001234567890', new Map([[29, { name: 'daily-briefings' }], [0, { name: 'General' }]])],
    ]);
    await saveTopicNames(map);
    const loaded = await loadTopicNames();
    assert.equal(getTopicName(loaded, -1001234567890, 29), 'daily-briefings');
    assert.equal(getTopicName(loaded, -1001234567890, 0), 'General');
  });

  it('writes atomically via .tmp rename (no partial write visible)', async () => {
    const map: TopicNameMap = new Map([['123', new Map([[1, { name: 'test' }]])]]);
    await saveTopicNames(map);
    const raw = await readFile(join(tempDir, 'telegram-topic-names.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.ok(parsed['123'], 'chatId key should exist');
    assert.equal(parsed['123']['1'].name, 'test');
  });
});

// ---------------------------------------------------------------------------
// updateTopicName
// ---------------------------------------------------------------------------

describe('updateTopicName', () => {
  it('adds a new topic entry and persists to disk', async () => {
    const map: TopicNameMap = new Map();
    await updateTopicName(map, -1001234567890, 29, 'daily-briefings');
    assert.equal(getTopicName(map, -1001234567890, 29), 'daily-briefings');
    const loaded = await loadTopicNames();
    assert.equal(getTopicName(loaded, -1001234567890, 29), 'daily-briefings');
  });

  it('overwrites an existing topic name and preserves description', async () => {
    const map: TopicNameMap = new Map([
      ['-1001234567890', new Map([[29, { name: 'old-name', description: 'old-desc' }]])],
    ]);
    await updateTopicName(map, -1001234567890, 29, 'new-name');
    assert.equal(getTopicName(map, -1001234567890, 29), 'new-name');
    // Description should be preserved
    assert.equal(map.get('-1001234567890')?.get(29)?.description, 'old-desc');
    const loaded = await loadTopicNames();
    assert.equal(getTopicName(loaded, -1001234567890, 29), 'new-name');
  });

  it('creates inner map for new chatId', async () => {
    const map: TopicNameMap = new Map();
    await updateTopicName(map, 999, 5, 'my-topic');
    assert.equal(map.get('999')?.get(5)?.name, 'my-topic');
  });
});

// ---------------------------------------------------------------------------
// getTopicName
// ---------------------------------------------------------------------------

describe('getTopicName', () => {
  it('returns the name when found', () => {
    const map: TopicNameMap = new Map([['-1001234', new Map([[29, { name: 'daily-briefings' }]])]]);
    assert.equal(getTopicName(map, -1001234, 29), 'daily-briefings');
  });

  it('returns undefined when chatId is not in map', () => {
    const map: TopicNameMap = new Map();
    assert.equal(getTopicName(map, 999, 1), undefined);
  });

  it('returns undefined when threadId is not in inner map', () => {
    const map: TopicNameMap = new Map([['-1001234', new Map([[5, { name: 'other' }]])]]);
    assert.equal(getTopicName(map, -1001234, 99), undefined);
  });
});

// ---------------------------------------------------------------------------
// extractTopicEvent
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: -1001234567890, type: 'supergroup' },
    date: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('extractTopicEvent', () => {
  it('returns null for a plain text message', () => {
    const msg = makeMsg({ text: 'hello', message_thread_id: 5 });
    assert.equal(extractTopicEvent(msg), null);
  });

  it('returns null when message_thread_id is absent', () => {
    const msg = makeMsg({ forum_topic_created: { name: 'test', icon_color: 0 } });
    assert.equal(extractTopicEvent(msg), null);
  });

  it('extracts name from forum_topic_created', () => {
    const msg = makeMsg({
      message_thread_id: 29,
      forum_topic_created: { name: 'daily-briefings', icon_color: 0xff0000 },
    });
    const result = extractTopicEvent(msg);
    assert.ok(result);
    assert.equal(result.chatId, -1001234567890);
    assert.equal(result.threadId, 29);
    assert.equal(result.name, 'daily-briefings');
  });

  it('extracts name from forum_topic_edited', () => {
    const msg = makeMsg({
      message_thread_id: 29,
      forum_topic_edited: { name: 'renamed-topic' },
    });
    const result = extractTopicEvent(msg);
    assert.ok(result);
    assert.equal(result.name, 'renamed-topic');
  });

  it('returns null when forum_topic_edited has no name (icon-only edit)', () => {
    const msg = makeMsg({
      message_thread_id: 29,
      forum_topic_edited: { icon_custom_emoji_id: '5312536423174753' },
    });
    assert.equal(extractTopicEvent(msg), null);
  });

  it('returns null when message_thread_id is 0', () => {
    // Thread 0 = General topic — should not be updated via service messages
    const msg = makeMsg({
      message_thread_id: 0,
      forum_topic_created: { name: 'General', icon_color: 0 },
    });
    assert.equal(extractTopicEvent(msg), null);
  });
});

// ---------------------------------------------------------------------------
// buildTopicDescription (from context.ts)
// ---------------------------------------------------------------------------

describe('buildTopicDescription', () => {
  it('returns empty when no topicNames', () => {
    const result = buildTopicDescription(makeState());
    assert.equal(result, '');
  });

  it('returns formatted string with name only (no description)', () => {
    const map: TopicNameMap = new Map([
      ['-1001234567890', new Map([[29, { name: 'test-topic' }]])],
    ]);
    const result = buildTopicDescription(makeState(), map);
    assert.equal(result, 'Topic: test-topic');
  });

  it('returns formatted string with name + description', () => {
    const map: TopicNameMap = new Map([
      ['-1001234567890', new Map([[29, { name: 'test-topic', description: 'Test description' }]])],
    ]);
    const result = buildTopicDescription(makeState(), map);
    assert.equal(result, 'Topic: test-topic — Test description');
  });

  it('handles unknown chat/thread IDs', () => {
    const map: TopicNameMap = new Map([
      ['-1001234567890', new Map([[99, { name: 'other' }]])],
    ]);
    const result = buildTopicDescription(makeState({ chat_id: -1001234567890, thread_id: 29 }), map);
    assert.equal(result, '');
  });

  it('handles thread 0 (General topic)', () => {
    const map: TopicNameMap = new Map([
      ['-1001234567890', new Map([[0, { name: 'General', description: 'Default topic' }]])],
    ]);
    const result = buildTopicDescription(makeState({ thread_id: 0 }), map);
    assert.equal(result, 'Topic: General — Default topic');
  });

  it('handles negative chat IDs (supergroups)', () => {
    const map: TopicNameMap = new Map([
      ['-1001234567890', new Map([[29, { name: 'daily-briefings' }]])],
    ]);
    const result = buildTopicDescription(makeState({ chat_id: -1001234567890 }), map);
    assert.equal(result, 'Topic: daily-briefings');
  });

  it('handles empty description string', () => {
    const map: TopicNameMap = new Map([
      ['-1001234567890', new Map([[29, { name: 'test-topic', description: '' }]])],
    ]);
    const result = buildTopicDescription(makeState(), map);
    assert.equal(result, 'Topic: test-topic');
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility (old string format)
// ---------------------------------------------------------------------------

describe('loadTopicNames: backward compatibility', () => {
  it('converts old string format to TopicEntry', async () => {
    await writeFile(
      join(tempDir, 'telegram-topic-names.json'),
      JSON.stringify({ '-1001234567890': { '29': 'daily-briefings', '0': 'General' } }),
      'utf8'
    );
    const map = await loadTopicNames();
    assert.equal(map.size, 1);
    const inner = map.get('-1001234567890');
    assert.ok(inner);
    assert.equal(inner.get(29)?.name, 'daily-briefings');
    assert.equal(inner.get(29)?.description, undefined);
    assert.equal(inner.get(0)?.name, 'General');
  });

  it('saves and loads new format with description', async () => {
    const map: TopicNameMap = new Map([
      ['-1001234567890', new Map([[29, { name: 'test', description: 'Test desc' }]])],
    ]);
    await saveTopicNames(map);
    const loaded = await loadTopicNames();
    assert.equal(loaded.get('-1001234567890')?.get(29)?.description, 'Test desc');
  });
});

// ---------------------------------------------------------------------------
// setTopicDescription
// ---------------------------------------------------------------------------

describe('setTopicDescription', () => {
  it('sets description on an existing entry, preserving name', async () => {
    const map: TopicNameMap = new Map([
      ['-100123', new Map([[5, { name: 'Feature Requests' }]])],
    ]);
    await setTopicDescription(map, -100123, 5, 'Tracking feature ideas');
    assert.equal(map.get('-100123')?.get(5)?.name, 'Feature Requests');
    assert.equal(map.get('-100123')?.get(5)?.description, 'Tracking feature ideas');
  });

  it('persists to disk atomically — reloads correctly', async () => {
    const map: TopicNameMap = new Map([
      ['-100123', new Map([[5, { name: 'Feature Requests' }]])],
    ]);
    await setTopicDescription(map, -100123, 5, 'Tracking feature ideas');
    const loaded = await loadTopicNames();
    assert.equal(loaded.get('-100123')?.get(5)?.description, 'Tracking feature ideas');
  });

  it('creates entry with empty name when topic not yet registered', async () => {
    const map: TopicNameMap = new Map();
    await setTopicDescription(map, -100123, 99, 'brand new topic');
    assert.equal(map.get('-100123')?.get(99)?.description, 'brand new topic');
    assert.equal(map.get('-100123')?.get(99)?.name, '');
  });

  it('overwrites an existing description', async () => {
    const map: TopicNameMap = new Map([
      ['-100123', new Map([[5, { name: 'Topic', description: 'old desc' }]])],
    ]);
    await setTopicDescription(map, -100123, 5, 'new desc');
    assert.equal(map.get('-100123')?.get(5)?.description, 'new desc');
  });
});

// ---------------------------------------------------------------------------
// loadBranches
// ---------------------------------------------------------------------------

describe('loadBranches', () => {
  it('returns empty map when file does not exist', async () => {
    const index = await loadBranches();
    assert.equal(index.size, 0);
  });

  it('returns correct entries from valid JSON', async () => {
    const data = {
      '-1001234567890': {
        '200': { parentThreadId: 100, branchName: 'feature-x', createdAt: '2026-04-20T00:00:00Z' },
      },
    };
    await writeFile(join(tempDir, 'topic-branches.json'), JSON.stringify(data), 'utf8');
    const index = await loadBranches();
    assert.equal(index.size, 1);
    const entry = index.get('-1001234567890')?.get(200);
    assert.ok(entry);
    assert.equal(entry.parentThreadId, 100);
    assert.equal(entry.branchName, 'feature-x');
  });
});

// ---------------------------------------------------------------------------
// saveBranches + loadBranches roundtrip
// ---------------------------------------------------------------------------

describe('saveBranches + loadBranches roundtrip', () => {
  it('persists and restores entries correctly', async () => {
    const index: BranchIndex = new Map([
      ['-1001234567890', new Map([[200, { parentThreadId: 100, branchName: 'feat', createdAt: '2026-04-20T00:00:00Z' }]])],
    ]);
    await saveBranches(index);
    const loaded = await loadBranches();
    assert.equal(loaded.size, 1);
    const entry = loaded.get('-1001234567890')?.get(200);
    assert.ok(entry);
    assert.equal(entry.parentThreadId, 100);
    assert.equal(entry.branchName, 'feat');
  });
});

// ---------------------------------------------------------------------------
// addBranch
// ---------------------------------------------------------------------------

describe('addBranch', () => {
  it('creates entry and persists to disk', async () => {
    const index: BranchIndex = new Map();
    await addBranch(index, -1001234567890, 200, { parentThreadId: 100, branchName: 'feat', createdAt: '2026-04-20T00:00:00Z' });
    assert.equal(index.get('-1001234567890')?.get(200)?.branchName, 'feat');
    const loaded = await loadBranches();
    assert.equal(loaded.get('-1001234567890')?.get(200)?.branchName, 'feat');
  });
});

// ---------------------------------------------------------------------------
// removeBranch
// ---------------------------------------------------------------------------

describe('removeBranch', () => {
  it('deletes entry and removes empty outer key', async () => {
    const index: BranchIndex = new Map([
      ['-1001234567890', new Map([[200, { parentThreadId: 100, branchName: 'feat', createdAt: '2026-04-20T00:00:00Z' }]])],
    ]);
    await removeBranch(index, -1001234567890, 200);
    assert.equal(index.has('-1001234567890'), false);
    const loaded = await loadBranches();
    assert.equal(loaded.size, 0);
  });
});

// ---------------------------------------------------------------------------
// getBranchEntry
// ---------------------------------------------------------------------------

describe('getBranchEntry', () => {
  it('returns entry when found', () => {
    const index: BranchIndex = new Map([
      ['-1001234567890', new Map([[200, { parentThreadId: 100, branchName: 'feat', createdAt: '2026-04-20T00:00:00Z' }]])],
    ]);
    const entry = getBranchEntry(index, -1001234567890, 200);
    assert.ok(entry);
    assert.equal(entry.branchName, 'feat');
  });

  it('returns undefined when not found', () => {
    const index: BranchIndex = new Map();
    assert.equal(getBranchEntry(index, -1001234567890, 999), undefined);
  });
});

// ---------------------------------------------------------------------------
// findBranchParent
// ---------------------------------------------------------------------------

describe('findBranchParent', () => {
  it('finds parent by name (case-insensitive)', () => {
    const topicNames: TopicNameMap = new Map([
      ['-1001234567890', new Map([[100, { name: 'General' }], [200, { name: 'Feature-X' }]])],
    ]);
    assert.equal(findBranchParent(topicNames, -1001234567890, 'general'), 100);
    assert.equal(findBranchParent(topicNames, -1001234567890, 'FEATURE-X'), 200);
  });

  it('returns undefined for unknown name', () => {
    const topicNames: TopicNameMap = new Map([
      ['-1001234567890', new Map([[100, { name: 'General' }]])],
    ]);
    assert.equal(findBranchParent(topicNames, -1001234567890, 'no-such-topic'), undefined);
  });
});
