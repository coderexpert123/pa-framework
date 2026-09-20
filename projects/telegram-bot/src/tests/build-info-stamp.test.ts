/**
 * build-info-stamp.test.ts — pins the BUILD_INFO writer inside
 * scripts/build.mjs (2026-09-13 deploy-staleness watchdog). build.mjs is an
 * ESM entry point that runs main() (and exits) on import, so it has no
 * importable surface — the same reason the .build-stamp writer shipped with
 * no unit test and the build gate as its real check. The load-bearing parts
 * of the new writer — the exact compact serialization the launcher's
 * VBScript reader matches, and the fail-closed dirty default — are pinned
 * against the source text, the same convention launcher-vbs.test.ts uses for
 * run-bot-hidden.vbs. The live end-to-end check stays the build gate:
 * `npm run build` must leave dist/BUILD_INFO parseable with the current
 * tree's true dirty state.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_MJS = resolve(__dirname, '../../scripts/build.mjs');

describe('BUILD_INFO stamp writer (scripts/build.mjs, 2026-09-13 deploy-staleness watchdog)', () => {
  it('scripts/build.mjs exists (the writer under test)', () => {
    assert.ok(existsSync(BUILD_MJS), 'scripts/build.mjs not found');
  });

  it('writes BUILD_INFO as compact JSON.stringify({ commit, dirty }) — never pretty-printed', () => {
    const src = readFileSync(BUILD_MJS, 'utf8');
    assert.ok(
      src.includes('JSON.stringify({ commit, dirty })'),
      'BUILD_INFO must serialize { commit, dirty } compactly — the launcher matches the exact '
      + 'substring "dirty":false, so a pretty-printed body (e.g. a null/2 indent) would '
      + 'silently disarm the watchdog (fail-closed, but inert)',
    );
    assert.ok(
      !/JSON\.stringify\(\{\s*commit,\s*dirty\s*\},\s*(null|undefined),/.test(src),
      'no indent argument may reach the BUILD_INFO serialization',
    );
  });

  it('dirty defaults true and only a zero-exit git call may clear it (fail-closed)', () => {
    const src = readFileSync(BUILD_MJS, 'utf8');
    assert.ok(src.includes('let dirty = true'), 'dirty must default true');
    assert.ok(
      src.includes('if (s.status === 0) dirty = s.stdout.trim().length > 0;'),
      'only a zero-exit git status call may derive dirty from its output',
    );
  });

  it('dirty is scoped to the bot package pathspec; commit is the full HEAD sha', () => {
    const src = readFileSync(BUILD_MJS, 'utf8');
    assert.ok(
      src.includes("'git', ['status', '--porcelain', '--', 'projects/telegram-bot']"),
      'dirty must come from git status --porcelain -- projects/telegram-bot',
    );
    assert.ok(
      src.includes("'git', ['rev-parse', 'HEAD']"),
      'commit must be the full HEAD sha (git rev-parse HEAD, no --short)',
    );
  });

  it('the BUILD_INFO write is best-effort and never fails the build', () => {
    const src = readFileSync(BUILD_MJS, 'utf8');
    assert.ok(
      src.includes("console.error('build: could not write BUILD_INFO:', e?.message ?? e)"),
      'stamp-write errors must warn, never fail the build',
    );
  });
});
