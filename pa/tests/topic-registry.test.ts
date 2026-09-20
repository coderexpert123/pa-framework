import './test-env-guard.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTopicRegistryJson, readTopicRegistry } from '../src/lib/topic-registry.js';

describe('parseTopicRegistryJson', () => {
  it('parseTopicRegistryJson reads object and legacy string entries with keys', () => {
    const input = {
      '-1': {
        '0': 'General',
        '5': { name: 'health', description: 'd', guide_message_id: 42 },
      },
    };
    assert.deepEqual(parseTopicRegistryJson(input), [
      { chatId: '-1', threadId: 0, key: '-1_0', name: 'General', legacyString: true },
      {
        chatId: '-1',
        threadId: 5,
        key: '-1_5',
        name: 'health',
        description: 'd',
        guideMessageId: 42,
        legacyString: false,
      },
    ]);
  });

  it('parseTopicRegistryJson skips NaN thread ids, empty names and non-object chats', () => {
    const input = {
      '-1': { x: 'A', '1': '', '2': { name: '' }, '3': { name: 7 } },
      '-2': 'str',
      '-3': [1],
    };
    assert.deepEqual(parseTopicRegistryJson(input), []);
  });
});

describe('readTopicRegistry', () => {
  let tempDir: string;

  it('readTopicRegistry fails to an empty list on a missing or corrupt file', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pa-topic-registry-'));
    try {
      const missingPath = join(tempDir, 'missing.json');
      assert.deepEqual(readTopicRegistry(missingPath), []);

      const corruptPath = join(tempDir, 'corrupt.json');
      writeFileSync(corruptPath, '{not json', 'utf8');
      assert.deepEqual(readTopicRegistry(corruptPath), []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
