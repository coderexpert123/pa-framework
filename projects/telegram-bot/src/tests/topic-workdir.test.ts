import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { topicHomeDir, parseProjectPointer, resolveTopicWorkdir, ensureTopicWorkdir, type TopicWorkdir } from '../topic-workdir.js';
import type { ConversationState } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let tempDir: string;
let tempPAHome: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'tgbot-workdir-'));
  tempPAHome = await mkdtemp(join(tmpdir(), 'tgbot-pahome-'));
  process.env.PA_HOME = tempPAHome;
});

afterEach(async () => {
  delete process.env.PA_HOME;
  await rm(tempDir, { recursive: true, force: true });
  await rm(tempPAHome, { recursive: true, force: true });
});

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    chat_id: -1001234567890,
    last_update_id: -1,
    thread_id: 8306,
    turns: [],
    ...overrides,
  };
}

describe('topic-workdir', () => {
  describe('topicHomeDir', () => {
    it('returns PA_HOME topic-brains path', () => {
      const result = topicHomeDir(-1001234567890, 8306);
      assert.ok(result.includes('topic-brains'));
      assert.ok(result.includes('-1001234567890_8306'));
      assert.ok(!result.includes('undefined'));
    });

    it('uses PA_HOME from env when set', () => {
      const result = topicHomeDir(-1001234567890, 8306);
      assert.ok(result.startsWith(tempPAHome));
    });
  });

  describe('parseProjectPointer', () => {
    it('returns null when no Project pointers section exists', () => {
      const markdown = '# Topic brain\n\nSome content';
      const result = parseProjectPointer(markdown);
      assert.strictEqual(result, null);
    });

    it('returns null when section exists but no bullets', () => {
      const markdown = '## Project pointers\n\nNo bullets here.';
      const result = parseProjectPointer(markdown);
      assert.strictEqual(result, null);
    });

    it('extracts first absolute CLAUDE.md path with forward slashes', () => {
      const markdown = `## Project pointers
- D:/Personal Assistant/projects/fitness-data-sync/CLAUDE.md
- D:/Other/CLAUDE.md`;
      const result = parseProjectPointer(markdown);
      assert.strictEqual(result, 'D:/Personal Assistant/projects/fitness-data-sync');
    });

    it('normalizes backslashes to forward slashes', () => {
      const markdown = `## Project pointers
- D:\\Personal Assistant\\projects\\fitness-data-sync\\CLAUDE.md`;
      const result = parseProjectPointer(markdown);
      assert.strictEqual(result, 'D:/Personal Assistant/projects/fitness-data-sync');
    });

    it('returns null for relative paths', () => {
      const markdown = `## Project pointers
- ../../projects/something/CLAUDE.md`;
      const result = parseProjectPointer(markdown);
      assert.strictEqual(result, null);
    });

    it('returns null for paths not ending in CLAUDE.md', () => {
      const markdown = `## Project pointers
- D:/Personal Assistant/projects/fitness-data-sync/README.md`;
      const result = parseProjectPointer(markdown);
      assert.strictEqual(result, null);
    });

    it('first-wins when multiple bullets exist', () => {
      const markdown = `## Project pointers
- D:/Primary/CLAUDE.md
- D:/Secondary/CLAUDE.md`;
      const result = parseProjectPointer(markdown);
      assert.strictEqual(result, 'D:/Primary');
    });

    it('handles section after Project pointers', () => {
      const markdown = `## Project pointers
- D:/Project/CLAUDE.md

## Other topics
See INDEX.md`;
      const result = parseProjectPointer(markdown);
      assert.strictEqual(result, 'D:/Project');
    });
  });

  describe('resolveTopicWorkdir', () => {
    it('returns override tier when cwd_override is set', async () => {
      const state = makeState({ cwd_override: 'D:/Custom/path' });
      const result = await resolveTopicWorkdir(state);
      assert.strictEqual(result.tier, 'override');
      assert.strictEqual(result.dir, 'D:/Custom/path');
    });

    it('returns project tier when brain has valid Project pointer', async () => {
      const topicKey = '-1001234567890_8306';
      const brainDir = join(tempPAHome, 'topic-brains', topicKey);
      await mkdir(brainDir, { recursive: true });
      await writeFile(join(brainDir, 'BRAIN.md'), `## Project pointers
- D:/TestProject/CLAUDE.md`);

      const state = makeState();
      const result = await resolveTopicWorkdir(state);
      assert.strictEqual(result.tier, 'project');
      assert.strictEqual(result.dir, 'D:/TestProject');
    });

    it('returns topic-home tier when brain has no Project pointer', async () => {
      const topicKey = '-1001234567890_8306';
      const brainDir = join(tempPAHome, 'topic-brains', topicKey);
      await mkdir(brainDir, { recursive: true });
      await writeFile(join(brainDir, 'BRAIN.md'), '# Topic brain');

      const state = makeState();
      const result = await resolveTopicWorkdir(state);
      assert.strictEqual(result.tier, 'topic-home');
      assert.ok(result.dir.includes('topic-brains'));
      assert.ok(result.dir.includes(topicKey));
    });

    it('returns topic-home tier when brain file does not exist', async () => {
      const state = makeState();
      const result = await resolveTopicWorkdir(state);
      assert.strictEqual(result.tier, 'topic-home');
      assert.ok(result.dir.includes('topic-brains'));
    });

    it('respects PA_HOME from env', async () => {
      const state = makeState();
      const result = await resolveTopicWorkdir(state);
      assert.ok(result.dir.startsWith(tempPAHome));
    });
  });

  describe('ensureTopicWorkdir', () => {
    it('creates scratch directory for topic-home tier', async () => {
      const workdir: TopicWorkdir = {
        dir: join(tempPAHome, 'topic-brains', '-1001234567890_8306'),
        tier: 'topic-home',
      };

      const result = await ensureTopicWorkdir(workdir, 'D:/Fallback');
      assert.strictEqual(result.tier, 'topic-home');
      assert.strictEqual(result.dir, workdir.dir);

      const scratchDir = join(workdir.dir, 'scratch');
      assert.ok(existsSync(scratchDir), 'scratch directory should be created');
    });

    it('falls back to BOT_CWD tier on mkdir failure', async () => {
      // Create a file at the target location to force mkdir failure
      const blockDir = join(tempDir, 'block-this-file');
      await writeFile(blockDir, 'block');

      const workdir: TopicWorkdir = {
        dir: join(blockDir, 'subdir'),
        tier: 'topic-home',
      };

      const fallbackCwd = 'D:/Fallback';
      const result = await ensureTopicWorkdir(workdir, fallbackCwd);
      assert.strictEqual(result.tier, 'bot-cwd');
      assert.strictEqual(result.dir, fallbackCwd);
    });

    it('passes through override tier unchanged', async () => {
      const workdir: TopicWorkdir = {
        dir: 'D:/Custom/path',
        tier: 'override',
      };

      const result = await ensureTopicWorkdir(workdir, 'D:/Fallback');
      assert.strictEqual(result.tier, 'override');
      assert.strictEqual(result.dir, 'D:/Custom/path');
    });

    it('passes through project tier unchanged', async () => {
      const workdir: TopicWorkdir = {
        dir: 'D:/Project/path',
        tier: 'project',
      };

      const result = await ensureTopicWorkdir(workdir, 'D:/Fallback');
      assert.strictEqual(result.tier, 'project');
      assert.strictEqual(result.dir, 'D:/Project/path');
    });
  });
});
