import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePorcelainEntries, parsePorcelainPaths } from '../src/lib/git-status.js';

// ---------------------------------------------------------------------------
// Regression coverage for the C1 defect (plans/2026-08-23-coordination-audit.md
// finding 1): `commands/claim.ts`'s old parser trimmed each line BEFORE slicing
// off the 3-char status prefix, so a leading-space status (` M`, ` D`, ` T`)
// shifted the whole line left by one and silently ate the path's first
// character. This module is the single, correct replacement.
// ---------------------------------------------------------------------------

describe('parsePorcelainPaths', () => {
  it('the C1 regression: does not eat the first character of a leading-space status path', () => {
    const output = ' M BACKLOG.md\n M plans/INDEX.md\n?? new.md\n';
    assert.deepEqual(parsePorcelainPaths(output), ['BACKLOG.md', 'plans/INDEX.md', 'new.md']);
    // The old (buggy) parser returned this instead — documented here so a
    // future edit that reintroduces trim-before-slice is unmistakable.
    assert.notDeepEqual(parsePorcelainPaths(output), ['ACKLOG.md', 'lans/INDEX.md', 'new.md']);
  });

  it('preserves every X-is-space status code', () => {
    const output = ' M modified.ts\n D deleted.ts\n T typechange.ts\n';
    assert.deepEqual(parsePorcelainPaths(output), ['modified.ts', 'deleted.ts', 'typechange.ts']);
  });

  it('handles X-is-non-space status codes', () => {
    const output = 'M  staged-modified.ts\nA  staged-added.ts\nMM both.ts\nAM added-then-modified.ts\n?? untracked.ts\n';
    assert.deepEqual(parsePorcelainPaths(output), [
      'staged-modified.ts',
      'staged-added.ts',
      'both.ts',
      'added-then-modified.ts',
      'untracked.ts',
    ]);
  });

  it('a rename returns only the new path', () => {
    const output = 'R  old.ts -> new.ts\n';
    assert.deepEqual(parsePorcelainPaths(output), ['new.ts']);
  });

  it('strips surrounding double quotes', () => {
    const output = '?? "quoted path.md"\n';
    assert.deepEqual(parsePorcelainPaths(output), ['quoted path.md']);
  });

  it('normalizes a backslash path to forward slashes', () => {
    const output = ' M some\\windows\\path.ts\n';
    assert.deepEqual(parsePorcelainPaths(output), ['some/windows/path.ts']);
  });

  it('strips a leading ./', () => {
    const output = ' M ./x.ts\n';
    assert.deepEqual(parsePorcelainPaths(output), ['x.ts']);
  });

  it('skips blank lines and lines shorter than 4 chars', () => {
    const output = ' M a.ts\n\n \n M \n M b.ts\n';
    assert.deepEqual(parsePorcelainPaths(output), ['a.ts', 'b.ts']);
  });

  it('strips a trailing \\r', () => {
    const output = ' M a.ts\r\n M b.ts\r\n';
    assert.deepEqual(parsePorcelainPaths(output), ['a.ts', 'b.ts']);
  });
});

describe('parsePorcelainEntries', () => {
  it('returns the correct {x,y} for each status code', () => {
    const output = ' M modified.ts\nA  staged.ts\nMM both.ts\n?? untracked.ts\nR  old.ts -> new.ts\n';
    const entries = parsePorcelainEntries(output);
    assert.deepEqual(entries, [
      { x: ' ', y: 'M', path: 'modified.ts' },
      { x: 'A', y: ' ', path: 'staged.ts' },
      { x: 'M', y: 'M', path: 'both.ts' },
      { x: '?', y: '?', path: 'untracked.ts' },
      { x: 'R', y: ' ', path: 'new.ts' },
    ]);
  });
});
