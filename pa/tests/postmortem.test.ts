/**
 * Tests for postmortem stub creation (WPD6).
 */

import { mkdir, mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { createPostmortemStub, type PostmortemInput, type PostmortemMetadata } from '../src/lib/postmortem.js';
import { repoRootFromModule } from '../src/lib/git-root.js';

describe('postmortem stub creation', () => {
  const testDir = join(process.cwd(), 'scratch', 'postmortem-test');

  beforeEach(async () => {
    process.env.PA_HOME = testDir;
    // Create test directory structure
    await mkdir(join(testDir, 'plans', 'postmortems'), { recursive: true });
  });

  afterEach(async () => {
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

// ---------------------------------------------------------------------------
// AI-176: appendIndexRow idempotency — a retried rollback attempt for the SAME
// postmortem file must not accumulate a second INDEX.md row. Root cause of the
// production duplicate rows: appendIndexRow appended unconditionally.
// ---------------------------------------------------------------------------
describe('postmortem INDEX.md idempotency (AI-176)', () => {
  const testDir = join(process.cwd(), 'scratch', 'postmortem-index-test');
  const indexPath = join(testDir, 'plans', 'INDEX.md');

  beforeEach(async () => {
    process.env.PA_HOME = testDir;
    await mkdir(join(testDir, 'plans', 'postmortems'), { recursive: true });
    await writeFile(
      indexPath,
      '# Plans Index\n\n| Date | Title | Status | Link |\n|------|-------|--------|------|\n',
      'utf8'
    );
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('does not duplicate the INDEX.md row when the same postmortem file is created twice', async () => {
    const input: PostmortemInput = {
      date: '2026-09-01',
      slug: 'rolled-back-dup-test',
      title: 'Rollback: dup-test',
      timelineRefs: [],
      actionItems: [],
    };
    const meta: PostmortemMetadata = {
      created: '2026-09-01T00:00:00Z',
      sourceAction: 'rolled-back',
      sourceSkill: 'dup-test',
    };

    // Simulates a retried rollback attempt for the same target — createPostmortemStub
    // overwrites the stub file itself (writeFile), so only the INDEX.md row is at risk.
    await createPostmortemStub(input, meta);
    await createPostmortemStub(input, meta);

    const indexContent = await readFile(indexPath, 'utf-8');
    const occurrences = indexContent.split('2026-09-01-rolled-back-dup-test.md').length - 1;
    assert.equal(occurrences, 1, 'the same postmortem file should be linked exactly once in INDEX.md');
  });

  it('still appends a row for a genuinely different postmortem file', async () => {
    const meta: PostmortemMetadata = {
      created: '2026-09-01T00:00:00Z',
      sourceAction: 'rolled-back',
      sourceSkill: 'distinct-test',
    };

    await createPostmortemStub(
      { date: '2026-09-01', slug: 'rolled-back-distinct-a', title: 'Rollback: distinct-a', timelineRefs: [], actionItems: [] },
      meta
    );
    await createPostmortemStub(
      { date: '2026-09-01', slug: 'rolled-back-distinct-b', title: 'Rollback: distinct-b', timelineRefs: [], actionItems: [] },
      meta
    );

    const indexContent = await readFile(indexPath, 'utf-8');
    assert.match(indexContent, /rolled-back-distinct-a\.md/);
    assert.match(indexContent, /rolled-back-distinct-b\.md/);
    const rowCount = (indexContent.match(/\| 2026-09-01 \|/g) || []).length;
    assert.equal(rowCount, 2, 'two distinct postmortem files should each get their own row');
  });
});

// ---------------------------------------------------------------------------
// Write-root independence from process.cwd() — originally the AI-176 fix
// (repoRootFromModule), superseded 2026-09-04 by the PA_HOME relocation:
// createPostmortemStub writes under paHome(), which honors PA_HOME, so cwd
// cannot decide where anything lands. (History: before AI-176 the root came
// from process.cwd() itself, and un-isolated tests wrote real stubs + INDEX
// rows into the live repo — the production duplicate rows.)
// ---------------------------------------------------------------------------
describe('postmortem write root is independent of process.cwd() (AI-176)', () => {
  const testDir = join(process.cwd(), 'scratch', 'postmortem-cwd-test');
  // Stands in for "cwd happens to point somewhere with no isolation" — the
  // exact condition that caused the historical production pollution. It
  // deliberately has no plans/ dir of its own.
  const elsewhereDir = join(process.cwd(), 'scratch', 'postmortem-cwd-elsewhere');
  const originalCwd = process.cwd();

  beforeEach(async () => {
    // Under the PA_HOME relocation (2026-09-04) the module resolves its write
    // root from the env var, so this describe must point PA_HOME at its own
    // fixture — the explicit repoRoot argument it used to rely on is gone.
    process.env.PA_HOME = testDir;
    await mkdir(join(testDir, 'plans', 'postmortems'), { recursive: true });
    await writeFile(
      join(testDir, 'plans', 'INDEX.md'),
      '# Plans Index\n\n| Date | Title | Status | Link |\n|------|-------|--------|------|\n',
      'utf8'
    );
    await mkdir(elsewhereDir, { recursive: true });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await rm(elsewhereDir, { recursive: true, force: true }).catch(() => {});
  });

  it('writes under PA_HOME even when process.cwd() points elsewhere', async () => {
    process.chdir(elsewhereDir);

    const filepath = await createPostmortemStub(
      { date: '2026-09-01', slug: 'cwd-independence-test', title: 'Rollback: cwd-independence-test', timelineRefs: [], actionItems: [] },
      { created: '2026-09-01T00:00:00Z', sourceAction: 'rolled-back', sourceSkill: 'cwd-independence-test' }
    );

    assert.ok(filepath.startsWith(testDir), `expected the stub under the PA_HOME fixture, got: ${filepath}`);
    assert.ok(existsSync(filepath), 'the stub file should exist under the PA_HOME fixture');

    const indexContent = await readFile(join(testDir, 'plans', 'INDEX.md'), 'utf-8');
    assert.match(indexContent, /cwd-independence-test/, 'the INDEX.md row should land under the PA_HOME fixture');

    // The stand-in for "wherever cwd happened to point" must receive NOTHING —
    // this is the assertion that would have failed before both fixes.
    assert.equal(existsSync(join(elsewhereDir, 'plans')), false, 'nothing should be written under process.cwd()');
  });

  // Complements the test above by proving the underlying resolution helper many
  // repo-rooted stores still share — repoRootFromModule — is itself independent
  // of process.cwd(). createPostmortemStub no longer uses it (PA_HOME since
  // 2026-09-04), but the mechanism remains cwd-independent for its other
  // consumers, and proving that costs nothing here.
  it('the default resolution mechanism (repoRootFromModule) ignores a changed process.cwd()', async () => {
    // Distinct, never-before-resolved cache keys (repoRootFromModule memoises per
    // module path) so each call below genuinely re-resolves via git instead of
    // returning a value cached from before cwd changed.
    const probeBefore = join(dirname(__filename), 'postmortem-cwd-independence-probe-before.js');
    const probeAfter = join(dirname(__filename), 'postmortem-cwd-independence-probe-after.js');

    const expected = await repoRootFromModule(probeBefore);

    const elsewhere = await mkdtemp(join(tmpdir(), 'pa-postmortem-cwd-probe-'));
    const prevCwd = process.cwd();
    try {
      process.chdir(elsewhere);
      const resolvedUnderChangedCwd = await repoRootFromModule(probeAfter);
      assert.equal(resolvedUnderChangedCwd, expected, 'the resolved repo root must not depend on process.cwd()');
    } finally {
      process.chdir(prevCwd);
      await rm(elsewhere, { recursive: true, force: true }).catch(() => {});
    }
  });
});
