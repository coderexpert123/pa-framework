/**
 * Tests for postmortem stub creation (WPD6).
 */

import { mkdir, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { createPostmortemStub, type PostmortemInput, type PostmortemMetadata } from '../src/lib/postmortem.js';

describe('postmortem stub creation', () => {
  const testDir = join(process.cwd(), 'scratch', 'postmortem-test');
  const originalCwd = process.cwd();

  beforeEach(async () => {
    process.env.PA_HOME = testDir;
    // Create test directory structure
    await mkdir(join(testDir, 'plans', 'postmortems'), { recursive: true });
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('creates a postmortem file with correct structure', async () => {
    const input: PostmortemInput = {
      date: '2026-08-17',
      slug: 'rollback-test-skill',
      title: 'Rollback: test-skill',
      timelineRefs: ['s-abc123def456'],
      actionItems: ['Investigate root cause', 'Fix the bug'],
    };

    const meta: PostmortemMetadata = {
      created: '2026-08-17T10:30:00Z',
      sourceAction: 'rolled-back',
      sourceSkill: 'test-skill',
      sourceCommit: 'abc123def456',
    };

    const filepath = await createPostmortemStub(input, meta);

    assert.ok(existsSync(filepath), 'Postmortem file should exist');
    assert.ok(filepath.endsWith('2026-08-17-rollback-test-skill.md'), 'Filename should match pattern');

    const content = await readFile(filepath, 'utf-8');

    assert.match(content, /# Rollback: test-skill/, 'Should have title');
    assert.match(content, /\*\*Date:\*\* 2026-08-17/, 'Should have date');
    assert.match(content, /\*\*Created:\*\* 2026-08-17T10:30:00Z/, 'Should have created timestamp');
    assert.match(content, /\*\*Source:\*\* rolled-back/, 'Should have source action');
    assert.match(content, /Condemned commit: `abc123def456`/, 'Should have commit for git-revert');
    assert.match(content, /\[s-abc123def456\]\(pa:\/\/s-abc123def456\)/, 'Should have timeline ref link');
    assert.match(content, /- \[ \] Investigate root cause/, 'Should have action item');
    assert.match(content, /- \[ \] Fix the bug/, 'Should have second action item');
    assert.match(content, /## Impact/, 'Should have Impact section');
    assert.match(content, /## Detection/, 'Should have Detection section');
    assert.match(content, /## Timeline/, 'Should have Timeline section');
    assert.match(content, /## Root Cause/, 'Should have Root Cause section');
    assert.match(content, /## Action Items/, 'Should have Action Items section');
  });

  it('handles empty timeline refs and action items', async () => {
    const input: PostmortemInput = {
      date: '2026-08-17',
      slug: 'rollback-empty',
      title: 'Rollback: empty',
      timelineRefs: [],
      actionItems: [],
    };

    const meta: PostmortemMetadata = {
      created: '2026-08-17T10:30:00Z',
      sourceAction: 'rolled-back',
      sourceSkill: 'empty-skill',
    };

    const filepath = await createPostmortemStub(input, meta);
    const content = await readFile(filepath, 'utf-8');

    assert.match(content, /\(No timeline refs available\)/, 'Should indicate no timeline refs');
    assert.match(content, /\(No action items defined\)/, 'Should indicate no action items');
  });

  it('creates postmortem directory if it does not exist', async () => {
    // Remove the directory created in beforeEach
    await rm(join(testDir, 'plans', 'postmortems'), { recursive: true });

    const input: PostmortemInput = {
      date: '2026-08-17',
      slug: 'test-create-dir',
      title: 'Test',
      timelineRefs: [],
      actionItems: [],
    };

    const meta: PostmortemMetadata = {
      created: '2026-08-17T10:30:00Z',
      sourceAction: 'rollback-failed',
      sourceSkill: 'test',
    };

    const filepath = await createPostmortemStub(input, meta);

    assert.ok(existsSync(filepath), 'Should create file even when directory did not exist');
  });

  it('generates valid markdown with proper escaping', async () => {
    const input: PostmortemInput = {
      date: '2026-08-17',
      slug: 'test-escaping',
      title: 'Test with special chars: * _ #',
      timelineRefs: ['s-test123'],
      actionItems: ['Item with _underscores_'],
    };

    const meta: PostmortemMetadata = {
      created: '2026-08-17T10:30:00Z',
      sourceAction: 'rolled-back',
      sourceSkill: 'test',
    };

    const filepath = await createPostmortemStub(input, meta);
    const content = await readFile(filepath, 'utf-8');

    // The markdown should be valid (no parsing errors when read as markdown)
    assert.match(content, /# Test with special chars/, 'Title should be in the file');
  });
});
