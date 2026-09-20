/**
 * AI-236 repo-root layout contract: repoRootFromModule must resolve TWO levels
 * above the package (…/<repo>/projects/voice-inbox), never one. The
 * discrimination proof asserts the KNOWN-BAD pre-fix shape (<root>/projects)
 * fails the same layout predicate, so the assertions above can actually
 * distinguish good from bad on this machine.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { repoRootFromModule } from '../repo-root.js';

describe('repoRootFromModule layout contract', () => {
  // Tests execute from dist/tests/ — TWO levels below the package, one deeper
  // than the production modules (dist/*.js) this helper's path arithmetic
  // targets, so feeding the test's own URL resolves one level short
  // (<repo>/projects). Derive the root from a production-shaped module URL
  // (dist/server.js, one level below the package) so the assertions test the
  // helper, not the test's own location.
  const root = repoRootFromModule(new URL('../server.js', import.meta.url).href);

  it('resolves two levels above the voice-inbox package', () => {
    assert.equal(existsSync(join(root, 'projects', 'voice-inbox', 'package.json')), true);
    assert.equal(existsSync(join(root, 'pa')), true);
    assert.notEqual(basename(root), 'projects');
  });

  it('known-bad one-level-short shape (<root>/projects) fails the layout predicate', () => {
    const badRoot = resolve(root, 'projects');
    assert.equal(existsSync(join(badRoot, 'projects', 'voice-inbox', 'package.json')), false);
  });
});
