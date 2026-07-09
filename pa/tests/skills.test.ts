import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'os';
import { join } from 'path';
import { createTempPaHome, createTempSkill, cleanup } from './helpers.js';
import { loadSkill, listSkills } from '../src/skills.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

describe('loadSkill', () => {
  it('parses skill with frontmatter and body', async () => {
    await createTempSkill(tempDir, 'test-skill', [
      '---',
      'cron: "0 8 * * *"',
      'timeout: 60',
      'idle_timeout: 30',
      'on_missed: all',
      'trigger_description: "Fire on monday"',
      'inject_triggers: true',
      'secrets:',
      '  - API_KEY',
      '---',
      '',
      'Do the thing.',
    ].join('\n'));
    const skill = await loadSkill('test-skill');
    assert.equal(skill.name, 'test-skill');
    assert.equal(skill.frontmatter.cron, '0 8 * * *');
    assert.equal(skill.frontmatter.timeout, 60);
    assert.equal(skill.frontmatter.idle_timeout, 30);
    assert.equal(skill.frontmatter.on_missed, 'all');
    assert.equal(skill.frontmatter.trigger_description, 'Fire on monday');
    assert.equal(skill.frontmatter.inject_triggers, true);
    assert.deepEqual(skill.frontmatter.secrets, ['API_KEY']);
    assert.equal(skill.prompt, 'Do the thing.');
  });

  it('parses critical: true from frontmatter', async () => {
    await createTempSkill(tempDir, 'critical-skill', '---\ncritical: true\n---\nPrompt.');
    const skill = await loadSkill('critical-skill');
    assert.equal(skill.frontmatter.critical, true);
  });

  it('defaults critical to false when absent', async () => {
    await createTempSkill(tempDir, 'non-critical-skill', '---\ncron: "0 8 * * *"\n---\nPrompt.');
    const skill = await loadSkill('non-critical-skill');
    assert.equal(skill.frontmatter.critical, false);
  });

  it('parses skill with no frontmatter', async () => {
    await createTempSkill(tempDir, 'bare', 'Just a prompt.');
    const skill = await loadSkill('bare');
    assert.equal(skill.prompt, 'Just a prompt.');
    assert.equal(skill.frontmatter.timeout, 3600);
    assert.equal(skill.frontmatter.idle_timeout, 300);
    assert.equal(skill.frontmatter.on_missed, 'latest');
  });

  it('applies default values', async () => {
    await createTempSkill(tempDir, 'defaults', '---\n---\nPrompt.');
    const skill = await loadSkill('defaults');
    assert.equal(skill.frontmatter.timeout, 3600);
    assert.equal(skill.frontmatter.idle_timeout, 300);
    assert.equal(skill.frontmatter.on_missed, 'latest');
    assert.equal(skill.frontmatter.cron, undefined);
    assert.equal(skill.frontmatter.cwd, undefined);
    assert.equal(skill.frontmatter.secrets, undefined);
    assert.equal(skill.frontmatter.trigger_description, undefined);
    assert.equal(skill.frontmatter.inject_triggers, false);
  });

  it('resolves ~ in cwd path', async () => {
    await createTempSkill(tempDir, 'tilde', '---\ncwd: ~/projects/foo\n---\nPrompt.');
    const skill = await loadSkill('tilde');
    assert.equal(skill.frontmatter.cwd, join(homedir(), 'projects/foo'));
  });

  it('rejects path traversal (../)', async () => {
    await assert.rejects(loadSkill('../etc'), /Invalid skill name/);
  });

  it('rejects backslash in name', async () => {
    await assert.rejects(loadSkill('foo\\bar'), /Invalid skill name/);
  });

  it('rejects forward slash in name', async () => {
    await assert.rejects(loadSkill('foo/bar'), /Invalid skill name/);
  });

  it('rejects empty name', async () => {
    await assert.rejects(loadSkill(''), /Invalid skill name/);
  });

  it('handles empty body after frontmatter', async () => {
    await createTempSkill(tempDir, 'empty-body', '---\ntimeout: 10\n---\n');
    const skill = await loadSkill('empty-body');
    assert.equal(skill.prompt, '');
  });

  it('throws for nonexistent skill', async () => {
    await assert.rejects(loadSkill('nonexistent'), /not found/);
  });

  it('parses telegram_output with string chat_id', async () => {
    await createTempSkill(tempDir, 'tg-skill', [
      '---',
      'telegram_output:',
      '  chat_id: "123456789"',
      '  thread_id: 5',
      '  token_secret: TELEGRAM_BOT_TOKEN',
      '---',
      'Do the thing.',
    ].join('\n'));
    const skill = await loadSkill('tg-skill');
    assert.deepEqual(skill.frontmatter.telegram_output, {
      chat_id: '123456789',
      thread_id: 5,
      token_secret: 'TELEGRAM_BOT_TOKEN',
    });
  });

  it('coerces numeric chat_id to string', async () => {
    await createTempSkill(tempDir, 'tg-numeric', [
      '---',
      'telegram_output:',
      '  chat_id: -1001234567890',
      '  token_secret: TELEGRAM_BOT_TOKEN',
      '---',
      'Do the thing.',
    ].join('\n'));
    const skill = await loadSkill('tg-numeric');
    assert.equal(skill.frontmatter.telegram_output?.chat_id, '-1001234567890');
    assert.equal(typeof skill.frontmatter.telegram_output?.chat_id, 'string');
  });

  it('parses worker field', async () => {
    await createTempSkill(tempDir, 'worker-skill', '---\nworker: gemini\n---\nDo things.');
    const skill = await loadSkill('worker-skill');
    assert.equal(skill.frontmatter.worker, 'gemini');
  });

  it('leaves telegram_output undefined when not set', async () => {
    await createTempSkill(tempDir, 'no-tg', '---\ntimeout: 10\n---\nPrompt.');
    const skill = await loadSkill('no-tg');
    assert.equal(skill.frontmatter.telegram_output, undefined);
  });
});

describe('listSkills', () => {
  it('returns all valid skills', async () => {
    await createTempSkill(tempDir, 'alpha', 'Prompt A');
    await createTempSkill(tempDir, 'beta', 'Prompt B');
    const skills = await listSkills();
    assert.equal(skills.length, 2);
    const names = skills.map((s) => s.name).sort();
    assert.deepEqual(names, ['alpha', 'beta']);
  });

  it('skips non-directory entries', async () => {
    await createTempSkill(tempDir, 'valid', 'Prompt');
    // Create a file (not directory) in skills/
    const { writeFile } = await import('fs/promises');
    await writeFile(join(tempDir, 'skills', 'stray-file.txt'), 'not a skill', 'utf8');
    const skills = await listSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'valid');
  });

  it('returns empty for missing skills directory', async () => {
    const { rm } = await import('fs/promises');
    await rm(join(tempDir, 'skills'), { recursive: true });
    const skills = await listSkills();
    assert.deepEqual(skills, []);
  });
});
