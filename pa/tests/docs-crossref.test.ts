import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Compiled to pa/dist/tests/docs-crossref.test.js — __dirname is that file's
// dir; 3 levels up (dist/tests -> dist -> pa -> repo root), same convention
// as init-defaults.test.ts:47.
const REPO_ROOT = join(__dirname, '..', '..', '..');
const DOCS_DIR = join(REPO_ROOT, 'docs');

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** All `#{1,6} heading text` lines, full (including the `#` markers). */
function headingLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.trim());
}

/** Heading text only (marker + one space stripped). */
function headingTexts(content: string): string[] {
  return headingLines(content).map((line) => line.replace(/^#{1,6}\s+/, ''));
}

/**
 * GitHub's heading-to-anchor algorithm: lowercase, drop everything that
 * isn't a word character, space, or hyphen, then turn spaces into hyphens.
 * Verified against this repo's own pre-existing anchors while writing this
 * checker (docs/CONFIGURATION.md's "`PA_HOME` env var" -> #pa_home-env-var,
 * docs/QUICKSTART.md's "11. Schedule recurring runs" -> #11-schedule-recurring-runs).
 */
function githubSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** A quoted-symptom heading (`### "..."`) matches a bare or quoted reference string. */
function headingMatchesQuoted(texts: string[], quoted: string): boolean {
  return texts.includes(quoted) || texts.includes(`"${quoted}"`);
}

interface Ref {
  target: string; // e.g. "BOT_GUIDE.md"
  anchor?: string;
  heading?: string;
  source: string;
}

function extractRefs(filePath: string, content: string): Ref[] {
  const refs: Ref[] = [];
  const isDocsFile = filePath.startsWith(DOCS_DIR);
  let m: RegExpExecArray | null;

  // "docs/<name>.md" optionally immediately followed by "#<anchor>" — the
  // form used by non-docs sources (error messages, scaffold comments) and by
  // docs prose that spells out the "docs/" prefix.
  const prefixedRe = /docs\/([A-Za-z0-9_.-]+\.md)(#([a-z0-9_-]+))?/g;
  while ((m = prefixedRe.exec(content))) {
    refs.push({ target: m[1], anchor: m[3], source: filePath });
  }

  // "docs/<name>.md[,] \"heading text\"" — the quoted-heading pointer style
  // WP1's NO_ENGINE_HELP and WP5's Telegram bubbles use, e.g.
  // docs/TROUBLESHOOTING.md, "No transcription engine is set up yet".
  const quotedRe = /docs\/([A-Za-z0-9_.-]+\.md),?\s+"([^"]+)"/g;
  while ((m = quotedRe.exec(content))) {
    refs.push({ target: m[1], heading: m[2], source: filePath });
  }

  // Relative markdown links within docs/*.md itself, e.g. (CONFIGURATION.md#transcriptionconfig).
  if (isDocsFile) {
    const relRe = /\(([A-Za-z0-9_.-]+\.md)(#([a-z0-9_-]+))?\)/g;
    while ((m = relRe.exec(content))) {
      refs.push({ target: m[1], anchor: m[3], source: filePath });
    }
  }

  return refs;
}

// `docs/` (and examples/secrets.env.example) are gitignored in the PRIVATE repo
// by design (CLAUDE.md: "the private repo's .gitignore intentionally ignores
// /README.md, /LICENSE, /docs/, and /examples/" -- public-mirror-only paths).
// A fresh CI checkout of the private repo therefore never has docs/ at all,
// even though it exists on every real dev machine's working tree. This is not
// a flake: it reproduced identically on all 3 CI platforms the first time
// this file's tests ran (2026-08-04) because nothing had ever depended on
// reading docs/ content at test time before. Skip gracefully when the
// directory is genuinely absent rather than fail -- the public mirror (where
// docs/ IS tracked) is where this checker's real verification happens; a
// private-repo-only checkout has nothing valid to check.
const DOCS_MISSING_REASON =
  'docs/ is not present in this checkout (gitignored in the private repo -- see file header comment)';

describe('docs cross-reference checker', () => {
  it('every docs/<file>.md reference (anchor or quoted heading) resolves', (t) => {
    if (!existsSync(DOCS_DIR)) return t.skip(DOCS_MISSING_REASON);
    const scanTargets = [
      join(REPO_ROOT, 'examples', 'config.yaml.example'),
      join(REPO_ROOT, 'examples', 'secrets.env.example'),
      join(REPO_ROOT, 'pa', 'src', 'commands', 'init.ts'),
      join(REPO_ROOT, 'pa', 'scripts', 'transcribe_voice.py'),
      join(REPO_ROOT, 'projects', 'telegram-bot', 'src', 'voice.ts'),
      ...readdirSync(DOCS_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => join(DOCS_DIR, f)),
    ];

    const failures: string[] = [];

    for (const filePath of scanTargets) {
      // WP1/WP4/WP5 own some of these files and may not have landed yet in
      // this work package's own build — that's a sibling-package gap, not a
      // doc bug, so skip rather than fail on a missing file.
      const content = readIfExists(filePath);
      if (content === null) continue;

      for (const ref of extractRefs(filePath, content)) {
        const targetPath = join(DOCS_DIR, ref.target);
        if (!existsSync(targetPath)) {
          failures.push(`${filePath}: references missing doc docs/${ref.target}`);
          continue;
        }
        const targetTexts = headingTexts(readFileSync(targetPath, 'utf8'));

        if (ref.anchor) {
          const slugs = targetTexts.map(githubSlug);
          if (!slugs.includes(ref.anchor)) {
            failures.push(
              `${filePath}: anchor #${ref.anchor} not found in docs/${ref.target} (have: ${slugs.join(', ')})`
            );
          }
        }
        if (ref.heading && !headingMatchesQuoted(targetTexts, ref.heading)) {
          failures.push(`${filePath}: quoted heading "${ref.heading}" not found in docs/${ref.target}`);
        }
      }
    }

    assert.deepEqual(failures, [], failures.join('\n'));
  });

  it('the three new anchored headings exist verbatim and are ASCII-only, and QUICKSTART carries the voice rung', (t) => {
    if (!existsSync(DOCS_DIR)) return t.skip(DOCS_MISSING_REASON);
    const botGuide = readFileSync(join(DOCS_DIR, 'BOT_GUIDE.md'), 'utf8');
    const configuration = readFileSync(join(DOCS_DIR, 'CONFIGURATION.md'), 'utf8');
    const troubleshooting = readFileSync(join(DOCS_DIR, 'TROUBLESHOOTING.md'), 'utf8');
    const quickstart = readFileSync(join(DOCS_DIR, 'QUICKSTART.md'), 'utf8');

    const required: Array<[string, string]> = [
      ['## Voice messages (speech to text)', botGuide],
      ['### TranscriptionConfig', configuration],
      ['## Voice-message transcription', troubleshooting],
    ];

    for (const [heading, content] of required) {
      assert.ok(headingLines(content).includes(heading), `missing heading: ${heading}`);
      assert.ok(/^[\x00-\x7F]*$/.test(heading), `heading is not ASCII-only: ${heading}`);
    }

    assert.ok(
      quickstart.includes('For Telegram voice notes'),
      'QUICKSTART.md is missing the voice-notes rung under "## 4. Configure secrets"'
    );
  });

  it('the fresh-start essentials appear where a stranger lands', (t) => {
    if (!existsSync(DOCS_DIR)) return t.skip(DOCS_MISSING_REASON);
    const quickstart = readFileSync(join(DOCS_DIR, 'QUICKSTART.md'), 'utf8');
    const botGuide = readFileSync(join(DOCS_DIR, 'BOT_GUIDE.md'), 'utf8');

    assert.ok(quickstart.includes('console.groq.com/keys'));
    assert.ok(quickstart.includes('GROQ_API_KEY'));

    assert.ok(botGuide.includes('console.groq.com/keys'));
    assert.ok(botGuide.includes('GROQ_API_KEY'));
    assert.ok(botGuide.includes('pa bot restart'));
    assert.ok(botGuide.includes('minutes'));
  });

  it('BOT_GUIDE routing list is contiguously numbered 1..11', (t) => {
    if (!existsSync(DOCS_DIR)) return t.skip(DOCS_MISSING_REASON);
    // Normalize CRLF -> LF: GitHub's windows-latest runner checks this repo
    // out with core.autocrlf=true, converting the committed LF endings to
    // CRLF on disk. A plain string .split() on a literal '\n' then never
    // matches, even though the content is otherwise identical — this is
    // exactly the failure mode headingLines() above already guards against
    // with /\r?\n/. Found 2026-08-06: this test was the one place in the
    // file that didn't follow that pattern, and it only ever surfaced on the
    // windows-latest CI leg (ubuntu/macos check out LF as committed).
    const botGuide = readFileSync(join(DOCS_DIR, 'BOT_GUIDE.md'), 'utf8').replace(/\r\n/g, '\n');
    const afterHeading = botGuide.split('## How the bot routes messages\n')[1];
    assert.ok(afterHeading, 'could not find "## How the bot routes messages" section');
    const section = afterHeading.split(/\n##\s/)[0];
    const numbers = [...section.matchAll(/^(\d+)\.\s/gm)].map((m) => Number(m[1]));

    assert.deepEqual(
      numbers,
      Array.from({ length: numbers.length }, (_, i) => i + 1)
    );
    assert.equal(numbers.length, 11);
  });
});
