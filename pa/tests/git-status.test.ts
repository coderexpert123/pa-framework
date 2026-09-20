import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { parsePorcelainEntries, parsePorcelainPaths } from '../src/lib/git-status.js';
import { paHome } from '../src/paths.js';

// ---------------------------------------------------------------------------
// Regression coverage for the C1 defect (the 2026-08-23 coordination audit
// finding 1): `commands/claim.ts`'s old parser trimmed each line BEFORE slicing
// off the 3-char status prefix, so a leading-space status (` M`, ` D`, ` T`)
// shifted the whole line left by one and silently ate the path's first
// character. This module is the single, correct replacement.
// ---------------------------------------------------------------------------

describe('parsePorcelainPaths', () => {
  it('the C1 regression: does not eat the first character of a leading-space status path', () => {
    // The postmortem index's real production location (PA_HOME since the
    // 2026-09-04 relocation) — the parser test stays honest about what a
    // path string actually looks like instead of pinning an invented name.
    // The parser normalizes backslashes to forward slashes, so expectations
    // are stated in its normalized form.
    const pmIndex = join(paHome(), 'plans', 'INDEX.md');
    const normalized = pmIndex.replace(/\\/g, '/');
    const output = ` M BACKLOG.md\n M ${pmIndex}\n?? new.md\n`;
    assert.deepEqual(parsePorcelainPaths(output), ['BACKLOG.md', normalized, 'new.md']);
    // The old (buggy) parser returned this instead — documented here so a
    // future edit that reintroduces trim-before-slice is unmistakable.
    const eatenArtifact = pmIndex.slice(1).replace(/\\/g, '/');
    assert.notDeepEqual(parsePorcelainPaths(output), ['ACKLOG.md', eatenArtifact, 'new.md']);
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

  it('decodes C-quoted octal escapes into the real non-ASCII path — an undecoded escape string names a file that never exists on disk (2026-09-18 verifier finding)', () => {
    // git emits \NNN octal UTF-8 bytes inside C-quotes for non-ASCII names.
    // Build the escape string FROM the encoded name so the fixture can't drift
    // from its own expected value: क.txt → \340\244\225.txt.
    const name = 'क.txt';
    const quoted = Array.from(Buffer.from(name, 'utf8'))
      .map((b) => (b >= 0x80 ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b)))
      .join('');
    assert.match(quoted, /\\/); // the fixture actually exercises the escape path
    const output = ` M "${quoted}"\n`;
    assert.deepEqual(parsePorcelainPaths(output), [name]);
  });

  it('decodes named escapes inside quotes and leaves unquoted/unknown escapes literal', () => {
    const output = '?? "a\\tb.txt"\n M plain\\path.ts\n';
    // a\tb.txt decodes to a real tab; plain\path.ts is unquoted so the
    // backslash-normalization rule still applies (forward slashes).
    assert.deepEqual(parsePorcelainPaths(output), ['a\tb.txt', 'plain/path.ts']);
  });
});
