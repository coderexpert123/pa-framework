import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import { validateRegistry, isUnderRoot } from '../src/lib/maintenance/policy.js';
import type { MaintenanceJob, RetentionTarget } from '../src/lib/maintenance/types.js';

function t(overrides: Partial<RetentionTarget> = {}): RetentionTarget {
  return {
    resolve: () => join(homedir(), '.pa', 'archive'),
    match: /.*/,
    maxAgeMs: 90 * 24 * 60 * 60 * 1000,
    action: 'delete',
    ownership: 'pa-owned',
    evidence: 'test evidence (2026-08-02)',
    ...overrides,
  };
}

function job(overrides: Partial<MaintenanceJob> = {}): MaintenanceJob {
  return {
    name: 'test-job',
    host: 'pa',
    everyMs: 60_000,
    description: 'a test job',
    destructive: false,
    shedWhenDegraded: true,
    targets: [],
    run: async () => ({ touched: 0 }),
    ...overrides,
  };
}

describe('validateRegistry', () => {
  it('does not throw for an empty registry', () => {
    assert.doesNotThrow(() => validateRegistry([]));
  });

  it('destructive job without targets throws', () => {
    assert.throws(
      () => validateRegistry([job({ destructive: true, targets: [] })]),
      /at least one RetentionTarget/,
    );
  });

  it('duplicate job names throw', () => {
    assert.throws(
      () => validateRegistry([job({ name: 'dup' }), job({ name: 'dup' })]),
      /duplicate job name/,
    );
  });

  it('bad job name throws', () => {
    assert.throws(
      () => validateRegistry([job({ name: 'Session GC' })]),
      /must match/,
    );
  });

  it('non-positive or NaN cadence throws', () => {
    assert.throws(() => validateRegistry([job({ everyMs: 0 })]), /finite positive/);
    assert.throws(() => validateRegistry([job({ everyMs: -1 })]), /finite positive/);
    assert.throws(() => validateRegistry([job({ everyMs: NaN })]), /finite positive/);
    assert.throws(() => validateRegistry([job({ everyMs: () => 0 })]), /finite positive/);
  });

  it('target outside every allowed root throws', () => {
    assert.throws(
      () => validateRegistry([job({
        destructive: true,
        targets: [t({ resolve: () => resolve(tmpdir(), 'nowhere') })],
      })]),
      /outside every ALLOWED root/,
    );
  });

  it('the ~/.claude regression guard (2026-08-02 incident) throws for any subpath', () => {
    assert.throws(
      () => validateRegistry([job({
        destructive: true,
        targets: [t({ resolve: () => join(homedir(), '.claude', 'projects', 'D--Personal-Assistant') })],
      })]),
      /FORBIDDEN root/,
    );
    assert.throws(
      () => validateRegistry([job({
        destructive: true,
        targets: [t({ resolve: () => join(homedir(), '.claude') })],
      })]),
      /FORBIDDEN root/,
    );
  });

  it('the Gemini CLI session root guard throws', () => {
    assert.throws(
      () => validateRegistry([job({
        destructive: true,
        targets: [t({ resolve: () => join(homedir(), '.gemini', 'tmp', 'personal-assistant', 'chats') })],
      })]),
      /FORBIDDEN root/,
    );
  });

  it('Antigravity conversations remain reachable — proves the denylist is path-precise, not a blanket ~/.gemini', () => {
    assert.doesNotThrow(
      () => validateRegistry([job({
        destructive: true,
        targets: [t({ resolve: () => join(homedir(), '.gemini', 'antigravity-cli', 'conversations') })],
      })]),
    );
  });

  it('empty evidence throws', () => {
    assert.throws(
      () => validateRegistry([job({ destructive: true, targets: [t({ evidence: '' })] })]),
      /non-empty dated justification/,
    );
    assert.throws(
      () => validateRegistry([job({ destructive: true, targets: [t({ evidence: '   ' })] })]),
      /non-empty dated justification/,
    );
  });

  it('maxAgeMs: 0 throws', () => {
    assert.throws(
      () => validateRegistry([job({ destructive: true, targets: [t({ maxAgeMs: 0 })] })]),
      /finite positive/,
    );
  });

  it('relative resolve() throws', () => {
    assert.throws(
      () => validateRegistry([job({ destructive: true, targets: [t({ resolve: () => 'archive' })] })]),
      /absolute path/,
    );
  });

  it('bad host throws', () => {
    assert.throws(
      () => validateRegistry([job({ host: 'nope' as any })]),
      /host must be/,
    );
  });
});

describe('isUnderRoot', () => {
  it('sibling directory with a shared prefix is NOT under root', () => {
    assert.equal(
      isUnderRoot(join(homedir(), '.gemini', 'tmpfoo'), join(homedir(), '.gemini', 'tmp')),
      false,
    );
  });

  it('a root is under itself', () => {
    const r = join(homedir(), '.pa');
    assert.equal(isUnderRoot(r, r), true);
  });

  if (process.platform === 'win32') {
    it('case-differing spelling of the same path is under root on win32', () => {
      const r = join(homedir(), '.pa');
      assert.equal(isUnderRoot(r.toUpperCase(), r), true);
    });
  }
});
