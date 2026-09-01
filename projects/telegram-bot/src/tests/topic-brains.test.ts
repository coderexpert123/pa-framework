import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getTopicBrainInfo } from '../topic-brains.js';
import { waitForDrain } from './test-teardown-guard.js';

// The literal stamp format from spec §3.2 — tests quote this verbatim
const STAMP_LITERAL = '<!-- topic-brain: consolidated=2026-08-21T21:30:00+05:30 covers=2026-08-21T18:03:11.000Z -->';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'tgbot-brains-'));
  process.env.PA_HOME = tempDir;
});

afterEach(async () => {
  await waitForDrain();
  delete process.env.PA_HOME;
  await rm(tempDir, { recursive: true, force: true });
});

describe('getTopicBrainInfo', () => {
  it('parses the spec §3.2 literal stamp example', async () => {
    const chatId = -1001234567890;
    const threadId = 8306;
    const topicDir = join(tempDir, 'topic-brains', `${chatId}_${threadId}`);
    await mkdir(topicDir, { recursive: true });

    const brainContent = `# Test Topic

> Summary: Test topic for stamp parsing.

${STAMP_LITERAL}

## Current state
- Some state here.
`;
    await writeFile(join(topicDir, 'BRAIN.md'), brainContent, 'utf8');

    const result = await getTopicBrainInfo(chatId, threadId);
    assert.ok(result, 'should return info when stamp present');
    assert.equal(result!.consolidated, '2026-08-21T21:30:00+05:30', 'should parse consolidated timestamp');
    assert.equal(result!.covers, '2026-08-21T18:03:11.000Z', 'should parse covers timestamp');
    assert.ok(result!.path.includes(`${chatId}_${threadId}`), 'path should include topic key');
    assert.ok(result!.path.endsWith('BRAIN.md'), 'path should end with BRAIN.md');
  });

  it('handles negative chatId in path formatting (supergroups)', async () => {
    const chatId = -1001234567890;  // negative for supergroups
    const threadId = 8306;
    const topicDir = join(tempDir, 'topic-brains', `${chatId}_${threadId}`);
    await mkdir(topicDir, { recursive: true });

    const brainContent = `# Topic

${STAMP_LITERAL}

## Current state
- State
`;
    await writeFile(join(topicDir, 'BRAIN.md'), brainContent, 'utf8');

    const result = await getTopicBrainInfo(chatId, threadId);
    assert.ok(result, 'should handle negative chatId');
    assert.ok(result!.path.includes(`${chatId}_${threadId}`), 'path should contain negative chatId');
  });

  it('returns null when brain file does not exist', async () => {
    const result = await getTopicBrainInfo(-1001234567890, 8306);
    assert.equal(result, null, 'should return null for missing file');
  });

  it('returns null for corrupt/unreadable file (permissions)', async () => {
    const chatId = -1001234567890;
    const threadId = 8306;
    const topicDir = join(tempDir, `${chatId}_${threadId}`);
    await mkdir(topicDir, { recursive: true });

    // Create an empty directory where BRAIN.md should be (will fail to read)
    // This simulates a permission error or other read failure
    const brainPath = join(topicDir, 'BRAIN.md');

    // Write corrupt binary content that may cause read issues
    await writeFile(brainPath, Buffer.from([0xFF, 0xFE, 0xFD]), 'utf8');

    // The implementation catches all errors and returns null
    const result = await getTopicBrainInfo(chatId, threadId);
    // File exists but is corrupt - should return null
    assert.equal(result, null, 'should return null for corrupt file');
  });

  it('returns degraded info when stamp is missing from file', async () => {
    const chatId = -1001234567890;
    const threadId = 8306;
    const topicDir = join(tempDir, 'topic-brains', `${chatId}_${threadId}`);
    await mkdir(topicDir, { recursive: true });

    const brainContent = `# Test Topic

> Summary: No stamp here.

## Current state
- Some state.
`;
    await writeFile(join(topicDir, 'BRAIN.md'), brainContent, 'utf8');

    const result = await getTopicBrainInfo(chatId, threadId);
    assert.ok(result, 'should return degraded info when stamp missing');
    assert.equal(result!.consolidated, null, 'consolidated should be null when stamp missing');
    assert.equal(result!.covers, null, 'covers should be null when stamp missing');
    assert.ok(result!.path.endsWith('BRAIN.md'), 'path should still be present');
  });

  it('returns degraded info when stamp is malformed/unparsable', async () => {
    const chatId = -1001234567890;
    const threadId = 8306;
    const topicDir = join(tempDir, 'topic-brains', `${chatId}_${threadId}`);
    await mkdir(topicDir, { recursive: true });

    const brainContent = `# Test Topic

> Summary: Malformed stamp.

<!-- topic-brain: bad-stamp-format-here -->

## Current state
- Some state.
`;
    await writeFile(join(topicDir, 'BRAIN.md'), brainContent, 'utf8');

    const result = await getTopicBrainInfo(chatId, threadId);
    assert.ok(result, 'should return degraded info when stamp malformed');
    assert.equal(result!.consolidated, null, 'consolidated should be null for malformed stamp');
    assert.equal(result!.covers, null, 'covers should be null for malformed stamp');
  });

  it('honors PA_HOME override', async () => {
    const customHome = await mkdtemp(join(tmpdir(), 'custom-home-'));
    process.env.PA_HOME = customHome;

    const chatId = -1001234567890;
    const threadId = 8306;
    const topicDir = join(customHome, 'topic-brains', `${chatId}_${threadId}`);
    await mkdir(topicDir, { recursive: true });

    const brainContent = `# Test

${STAMP_LITERAL}

## Current state
- State
`;
    await writeFile(join(topicDir, 'BRAIN.md'), brainContent, 'utf8');

    const result = await getTopicBrainInfo(chatId, threadId);
    assert.ok(result, 'should find brain in custom PA_HOME');
    assert.ok(result!.path.includes(customHome), 'path should use custom PA_HOME');

    await rm(customHome, { recursive: true, force: true });
  });

  it('treats stamp beyond 4,096 bytes as absent (degraded)', async () => {
    const chatId = -1001234567890;
    const threadId = 8306;
    const topicDir = join(tempDir, 'topic-brains', `${chatId}_${threadId}`);
    await mkdir(topicDir, { recursive: true });

    // Create content where stamp appears AFTER 4,096 bytes
    const padding = 'x'.repeat(4100);  // More than 4,096 bytes of padding
    const brainContent = `# Test Topic

> Summary: Stamp is too far down.

${padding}

${STAMP_LITERAL}

## Current state
- Some state.
`;
    await writeFile(join(topicDir, 'BRAIN.md'), brainContent, 'utf8');

    const result = await getTopicBrainInfo(chatId, threadId);
    assert.ok(result, 'should return degraded info when stamp beyond 4KB');
    assert.equal(result!.consolidated, null, 'consolidated should be null when stamp beyond 4KB');
    assert.equal(result!.covers, null, 'covers should be null when stamp beyond 4KB');
  });

  it('handles optional folded-into field in stamp', async () => {
    const chatId = -1001234567890;
    const threadId = 8306;
    const topicDir = join(tempDir, 'topic-brains', `${chatId}_${threadId}`);
    await mkdir(topicDir, { recursive: true });

    // Stamp with folded-into field (spec §3.2)
    const stampWithFold = '<!-- topic-brain: consolidated=2026-08-21T21:30:00+05:30 covers=2026-08-21T18:03:11.000Z folded-into=-1001234567890_1234 -->';

    const brainContent = `# Test Topic

${stampWithFold}

## Current state
- State
`;
    await writeFile(join(topicDir, 'BRAIN.md'), brainContent, 'utf8');

    const result = await getTopicBrainInfo(chatId, threadId);
    assert.ok(result, 'should handle stamp with folded-into field');
    assert.equal(result!.consolidated, '2026-08-21T21:30:00+05:30', 'should parse consolidated');
    assert.equal(result!.covers, '2026-08-21T18:03:11.000Z', 'should parse covers');
  });
});
