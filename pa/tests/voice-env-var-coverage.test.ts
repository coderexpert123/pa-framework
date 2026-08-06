import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Compiled to pa/dist/tests/voice-env-var-coverage.test.js — __dirname is
// that file's dir; 3 levels up (dist/tests -> dist -> pa -> repo root)
// reaches docs/, same convention as transcription-scaffold-drift.test.ts.
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CONFIGURATION_MD = join(REPO_ROOT, 'docs', 'CONFIGURATION.md');

// docs/ is gitignored in the PRIVATE repo (public-mirror-only path, per
// CLAUDE.md) so a fresh CI checkout of the private repo never has it, even
// though every real dev machine does — same guard as docs-crossref.test.ts
// and transcription-scaffold-drift.test.ts use for the same reason.
const DOCS_MISSING_REASON = 'docs/CONFIGURATION.md is not present in this checkout (gitignored in the private repo)';

/** Collect files with the given extension under `dir`. `recursive: false`
 *  stops at the top level — deliberately, so test/tooling subdirectories
 *  (projects/telegram-bot/src/tests, pa/scripts/tests, pa/scripts/git-hooks)
 *  can't produce a false "it's read somewhere" by merely asserting on the
 *  name in a test file. */
function collectFiles(dir: string, ext: string, recursive: boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) out.push(...collectFiles(full, ext, recursive));
      continue;
    }
    if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

function isCommentLine(line: string, lang: 'ts' | 'py'): boolean {
  const t = line.trim();
  if (t === '') return true;
  if (lang === 'py') return t.startsWith('#');
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** True iff `name` appears as a substring on at least one non-comment,
 *  non-blank line of `filePath`. A name mentioned only in a comment (e.g. a
 *  doc-comment cross-reference) doesn't count as "read". */
function nameAppearsInNonCommentLine(name: string, filePath: string, lang: 'ts' | 'py'): boolean {
  const content = readFileSync(filePath, 'utf8');
  return content.split(/\r?\n/).some((line) => line.includes(name) && !isCommentLine(line, lang));
}

describe('voice env-var documentation is executable, not aspirational', () => {
  it('every PA_VOICE_* name documented in docs/CONFIGURATION.md is actually read by some non-comment code line', (t) => {
    if (!existsSync(CONFIGURATION_MD)) return t.skip(DOCS_MISSING_REASON);

    const text = readFileSync(CONFIGURATION_MD, 'utf8');
    const names = [...new Set(text.match(/PA_VOICE_[A-Z0-9_]+/g) ?? [])].sort();
    assert.ok(names.length > 0, 'no PA_VOICE_* names found in docs/CONFIGURATION.md — extraction regex is likely broken');

    const tsFiles = [
      ...collectFiles(join(REPO_ROOT, 'projects', 'telegram-bot', 'src'), '.ts', false),
      ...collectFiles(join(REPO_ROOT, 'pa', 'src'), '.ts', true),
    ];
    const pyFiles = collectFiles(join(REPO_ROOT, 'pa', 'scripts'), '.py', false);

    const unread = names.filter(
      (name) =>
        !tsFiles.some((f) => nameAppearsInNonCommentLine(name, f, 'ts')) &&
        !pyFiles.some((f) => nameAppearsInNonCommentLine(name, f, 'py')),
    );

    assert.deepEqual(
      unread,
      [],
      `documented but never read: ${unread.join(', ')}. docs/CONFIGURATION.md documents these PA_VOICE_* ` +
        'vars, but no non-comment line in projects/telegram-bot/src/*.ts, pa/src/**/*.ts, or pa/scripts/*.py ' +
        "references them — this is exactly the class of bug PA_VOICE_WORKER_IDLE_MS shipped as (documented in " +
        'four places, read by zero). If this fails only because a sibling work package that owns the reading ' +
        'code has not landed in this build yet, that is a known temporary cross-package gap, not a bug in this test.',
    );
  });
});
