import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
// The budgeted-doc gate (size budgets + the same-file-trim counter) lives in
// pa/src/lib/docs-lint.ts — implemented there exactly once so `pa docs-lint`
// (the commit-time/post-wave arm, AI-242) and this suite (the push-gate arm)
// can never drift into two similar mechanisms.
import {
  budgetedDocFiles,
  docBudgetFailures,
  gitLog,
  sameFileTrimFailures,
  TRIM_DOCTRINE_REF,
  BACKLOG_SECTION_BUDGET,
} from '../src/lib/docs-lint.js';

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

// `docs/` and `examples/` are TRACKED in the private repo -- `git ls-files`
// confirms it (verified 2026-08-31, AI-170 SPEC C11; only
// projects/telegram-bot/bot-instructions.md is actually gitignored,
// .gitignore:266). The claim this comment used to make -- that docs/+examples/
// were gitignored by design -- was false. A fresh CI checkout can still
// genuinely lack docs/ for some other reason: it reproduced identically on
// all 3 CI platforms the first time this file's tests ran (2026-08-04), root
// cause not gitignore. Skip gracefully when the directory is genuinely absent
// rather than fail -- the public mirror (where docs/ IS also tracked) is
// where this checker's real verification happens; a checkout missing docs/
// has nothing valid to check.
const DOCS_MISSING_REASON =
  'docs/ is not present in this checkout (see file header comment -- not a gitignore, see AI-170 SPEC C11)';

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

  // Brain-file size budgets (docs/CONVENTIONS.md § "Brain-file organization",
  // added 2026-08-07). The numbers, the raise-class justifications, and the
  // CRLF-normalized measure live in pa/src/lib/docs-lint.ts — these tests are
  // the push-gate arm of the same gate `pa docs-lint` runs at commit time
  // (AI-242). Numbers there MUST match the CONVENTIONS section — if you're
  // changing one, change both.
  const budgetFailuresFor = (prefix: (f: string) => boolean): string[] =>
    docBudgetFailures(REPO_ROOT)
      .filter((f) => prefix(f.file))
      .map((f) => f.message);

  it('root CLAUDE.md stays within its size budget (soft 40k, hard 48k chars)', () => {
    assert.deepEqual(budgetFailuresFor((f) => f === 'CLAUDE.md'), []);
  });

  it('pa/CLAUDE.md stays within its size budget (12k chars, directory-scoped class)', () => {
    assert.deepEqual(budgetFailuresFor((f) => f === 'pa/CLAUDE.md'), []);
  });

  it('every directory-scoped projects/*/CLAUDE.md stays within its size budget (12k chars)', () => {
    assert.deepEqual(budgetFailuresFor((f) => f.startsWith('projects/')), []);
  });

  it('docs/*.md operational-detail files stay within budget (16k); evergreen UPPERCASE guides get 24k', (t) => {
    if (!existsSync(DOCS_DIR)) return t.skip(DOCS_MISSING_REASON);
    assert.deepEqual(budgetFailuresFor((f) => f.startsWith('docs/')), []);
  });

  it('the FILE_INVENTORY.md router stays within its 4k budget', () => {
    assert.deepEqual(budgetFailuresFor((f) => f === 'FILE_INVENTORY.md'), []);
  });

  it('inventory/*.md files stay within budget (16k manual, 33k for auto-managed glob-derived files)', () => {
    assert.deepEqual(budgetFailuresFor((f) => f.startsWith('inventory/')), []);
  });

  it('backlog/completed-index.md (the lookup table, not the archives) stays within its 27k budget', () => {
    // docs/CONVENTIONS.md § "Brain-file organization": archive-*.md/not-valid.md
    // are the "append-only archive" class with NO hard ceiling -- their size
    // tracks how much work shipped in a window, not anything a reader holds in
    // mind, and splitting one purely to hit a number would separate
    // cross-referenced items that must stay findable together. Only the
    // lookup-table file gets budget-checked here. Raise history and the
    // never-trim rationale live with COMPLETED_INDEX_BUDGET in docs-lint.ts.
    assert.deepEqual(budgetFailuresFor((f) => f === 'backlog/completed-index.md'), []);
  });

  it('root BACKLOG.md stays within its 4k ROUTER budget (2026-09-18, AI-316)', () => {
    // BACKLOG.md became a router over backlog/open-*.md: the open items moved
    // to per-section files and the root file keeps preamble + Standard + the
    // drain-maintained section table. The whole 12k→17k raise history is moot
    // — a router is a different budget class. EXPECTED RED between code-land
    // and `pa backlog migrate` (the 32k+ monolith exceeds 4k by design; spec
    // §8: do not run the full suite inside that window and expect green).
    assert.deepEqual(budgetFailuresFor((f) => f === 'BACKLOG.md'), []);
  });

  it('every backlog/open-*.md section file stays within its 24k glob-class budget', () => {
    // One glob-class budget covers present AND future section files — a new
    // section auto-created by the drain is covered without a table edit.
    // Vacuously true before the migration writes the first file.
    assert.deepEqual(budgetFailuresFor((f) => f.startsWith('backlog/open-')), []);
  });

  it('layout-violation fixture: an over-budget open-*.md fails the section budget, and an open-*.md in a fixture repo is enumerated', async () => {
    // The fixture arm of the glob class (the live assertion above is vacuous
    // pre-migration): seed a temp repo whose backlog/open-bugs.md exceeds
    // BACKLOG_SECTION_BUDGET and prove the glob arm catches it — the class
    // must be able to FAIL, not just pass on an absent set.
    const root = await mkdtemp(join(tmpdir(), 'pa-docs-crossref-backlog-'));
    try {
      await mkdir(join(root, 'backlog'), { recursive: true });
      await writeFile(join(root, 'backlog', 'open-bugs.md'), 'x'.repeat(BACKLOG_SECTION_BUDGET + 1), 'utf8');
      await writeFile(join(root, 'backlog', 'open-features.md'), 'small\n', 'utf8');
      await writeFile(join(root, 'backlog', 'completed-index.md'), 'small\n', 'utf8');
      const failures = docBudgetFailures(root).filter((f) => f.file.startsWith('backlog/'));
      assert.deepEqual(
        failures.map((f) => f.file),
        ['backlog/open-bugs.md'],
        'only the over-budget section file fails — other backlog/*.md files are not in the glob class',
      );
      assert.ok(failures[0].message.includes('section budget'), failures[0].message);
      assert.equal(failures[0].budget, BACKLOG_SECTION_BUDGET);
      // Enumeration arm: both open-*.md files are budgeted docs.
      const covered = budgetedDocFiles(root);
      assert.ok(covered.includes('backlog/open-bugs.md'));
      assert.ok(covered.includes('backlog/open-features.md'));
      assert.ok(!covered.includes('backlog/completed-2026-09-18.md'), 'dated archives are not budgeted docs');
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Budget-pressure doctrine — same-file-trim counter (operator directive
// 2026-09-03, docs/CONVENTIONS.md § "Brain-file organization"). The full
// mechanism — numstat discriminator, split-recognition arms, doctrine-anchor
// window — is implemented once in pa/src/lib/docs-lint.ts (see its header for
// the design notes that used to live here); this file keeps the suite-level
// enforcement test and the fixture-repo instrument.
//
// The named tests deliberately run against FIXTURE git repos, not this
// repository: tonight's live history is itself a (sanctioned) multi-trim
// window, so a fixture is the only way the suite stays green while the
// mechanism is proven on exactly the shape the doctrine forbids repeating.
// ---------------------------------------------------------------------------

describe('budget-pressure doctrine: same-file-trim counter', () => {
  it('no budgeted doc file was trimmed twice within its 24h trim window (enforcement)', async () => {
    const failures = await sameFileTrimFailures(REPO_ROOT, budgetedDocFiles(REPO_ROOT), Date.now());
    assert.deepEqual(failures, [], failures.join('\n'));
  });

  // The test-infra pattern from claim-command.test.ts's recentActivity block:
  // a REAL temp git repo, because only real `git log --numstat` output proves
  // the discriminator actually discriminates.
  describe('fixture repo instrument', () => {
    let repo: string;
    const git = async (args: string[], extraEnv: Record<string, string> = {}): Promise<void> => {
      await gitLog(repo, args, extraEnv);
    };

    beforeEach(async () => {
      repo = await mkdtemp(join(tmpdir(), 'pa-docs-trim-counter-'));
      await git(['init', '-q']);
      await git(['config', 'user.email', 'pa-test@example.com']);
      await git(['config', 'user.name', 'pa test']);
      await git(['config', 'commit.gpgsign', 'false']);
      await git(['config', 'core.autocrlf', 'false']);
    });

    afterEach(async () => {
      await rm(repo, { recursive: true, force: true }).catch(() => {});
    });

    const lines = (n: number, tag: string): string =>
      Array.from({ length: n }, (_, i) => `${tag} line ${i}\n`).join('');

    async function commitFiles(
      entries: Array<{ relPath: string; content: string }>,
      when?: Date
    ): Promise<void> {
      for (const { relPath, content } of entries) {
        await mkdir(dirname(join(repo, relPath)), { recursive: true });
        await writeFile(join(repo, relPath), content, 'utf8');
        await git(['add', '--', relPath]);
      }
      const iso = (when ?? new Date()).toISOString();
      await git(
        ['commit', '-q', '--date', iso, '-m', `fixture: ${entries.map((e) => e.relPath).join(', ')}`],
        {
          GIT_AUTHOR_DATE: iso,
          GIT_COMMITTER_DATE: iso,
        }
      );
    }

    async function commitFile(relPath: string, content: string, when?: Date): Promise<void> {
      await commitFiles([{ relPath, content }], when);
    }

    it('two trims in the window fail with the doctrine clause, the file, the count and the shas', async () => {
      await commitFile('BACKLOG.md', lines(120, 'a'));
      await commitFile('BACKLOG.md', lines(60, 'a')); // trim #1: -60 lines
      await commitFile('BACKLOG.md', lines(35, 'a')); // trim #2: -25 lines
      const failures = await sameFileTrimFailures(repo, ['BACKLOG.md'], Date.now());
      assert.equal(failures.length, 1, `expected exactly one failure, got:\n${failures.join('\n')}`);
      const msg = failures[0];
      assert.ok(msg.includes('BACKLOG.md'), `message must name the file, got: ${msg}`);
      assert.ok(msg.includes('2 commits'), `message must state the trim count, got: ${msg}`);
      const shas = (await gitLog(repo, ['log', '--format=%H', '--', 'BACKLOG.md']))
        .trim()
        .split(/\r?\n/);
      assert.ok(
        msg.includes(shas[0]) && msg.includes(shas[1]),
        `message must name both trim-commit shas (${shas[0]}, ${shas[1]}), got: ${msg}`
      );
      assert.ok(msg.includes(TRIM_DOCTRINE_REF), `message must quote the clause ref, got: ${msg}`);
      assert.ok(msg.includes('contract-look'), `message must carry the clause text, got: ${msg}`);
      assert.ok(
        msg.includes('third trim'),
        'message must instruct: respond per the file contract, not a third trim'
      );
    });

    it('one trim in the window passes; a later net-positive raise does not count as a second trim', async () => {
      await commitFile('BACKLOG.md', lines(120, 'a'));
      await commitFile('BACKLOG.md', lines(60, 'a')); // trim: -60 lines
      await commitFile('BACKLOG.md', lines(150, 'a')); // raise: +90 — must NOT count
      const failures = await sameFileTrimFailures(repo, ['BACKLOG.md'], Date.now());
      assert.deepEqual(failures, [], `one trim + one raise must pass, got:\n${failures.join('\n')}`);
    });

    it('raise-only history (net-positive commits) produces zero trims', async () => {
      await commitFile('BACKLOG.md', lines(40, 'a'));
      await commitFile('BACKLOG.md', lines(100, 'a')); // +60
      await commitFile('BACKLOG.md', lines(180, 'a')); // +80
      const failures = await sameFileTrimFailures(repo, ['BACKLOG.md'], Date.now());
      assert.deepEqual(failures, [], `raise-only history must pass, got:\n${failures.join('\n')}`);
    });

    it('a trim older than the 24h window does not count', async () => {
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await commitFile('BACKLOG.md', lines(120, 'a'), old);
      await commitFile('BACKLOG.md', lines(50, 'a'), new Date(old.getTime() + 60_000)); // trim, 25h old
      await commitFile('BACKLOG.md', lines(80, 'a')); // in-window, but net-positive (+30)
      const failures = await sameFileTrimFailures(repo, ['BACKLOG.md'], Date.now());
      assert.deepEqual(failures, [], `the only net-negative commit is outside the window, got:\n${failures.join('\n')}`);
    });

    it('a trim commit that also creates a new .md file is a split: the counter resets, no failure', async () => {
      await commitFile('BACKLOG.md', lines(120, 'a'));
      await commitFile('BACKLOG.md', lines(60, 'a')); // trim #1: -60 lines
      // The split: ONE commit trims BACKLOG.md again AND creates a new doc —
      // the doctrine's own remedy, so the counter resets instead of this
      // being trim #2. Real-world shape (commit 48929c4): numstat reports the
      // created file as a plain `61<TAB>0<TAB>docs/....md` row — a modify
      // that only adds lines is byte-identical there, so detection must read
      // --name-status's `A` status instead.
      await commitFiles([
        { relPath: 'BACKLOG.md', content: lines(35, 'a') },
        { relPath: 'docs/split-out.md', content: lines(40, 'b') },
      ]);
      // A trim AFTER the split starts a fresh count (1, not 3): proves the
      // reset resolved the pre-split trims without exempting later ones.
      await commitFile('BACKLOG.md', lines(20, 'a'));
      const failures = await sameFileTrimFailures(repo, ['BACKLOG.md'], Date.now());
      assert.deepEqual(
        failures,
        [],
        `trim + split-trim + one post-split trim = 1 counted trim, must pass, got:\n${failures.join('\n')}`
      );
    });

    it('a net-negative trim relocating content into an EXISTING companion doc is a split too (no A row to see): the counter resets', async () => {
      // The live shape the companion arm exists for (2026-09-14 regrowth trim
      // 5d8d039): bot CLAUDE.md went net-negative in the SAME commit that
      // carried M rows on docs/bot-test-rules.md + docs/bot-incident-records.md
      // — the 8th test rule and the mutation-pass detail relocated into
      // companions that already existed, so the A-status probe sees nothing.
      await commitFile('docs/bot-test-rules.md', lines(40, 'b'));
      await commitFile('projects/telegram-bot/CLAUDE.md', lines(120, 'a'));
      await commitFile('projects/telegram-bot/CLAUDE.md', lines(60, 'a')); // trim #1: plain
      // The split: ONE commit trims the file again AND modifies the existing
      // companion — a relocation no other arm can see.
      await commitFiles([
        { relPath: 'projects/telegram-bot/CLAUDE.md', content: lines(35, 'a') },
        { relPath: 'docs/bot-test-rules.md', content: lines(50, 'b') },
      ]);
      const failures = await sameFileTrimFailures(repo, ['projects/telegram-bot/CLAUDE.md'], Date.now());
      assert.deepEqual(
        failures,
        [],
        `plain trim + companion-relocation trim must pass (1 counted trim, then reset), got:\n${failures.join('\n')}`
      );
    });

    it('the same history with a hypothetical PLAIN second trim — no companion row — still fails', async () => {
      // The check-can-fail direction, pinned on the documented scenario's own
      // file: had the live second trim NOT carried the relocations, the
      // counter would read 2 and red-gate. Also proves a file with a
      // COMPANION_DOCS row is not blanket-exempt from the counter.
      await commitFile('projects/telegram-bot/CLAUDE.md', lines(120, 'a'));
      await commitFile('projects/telegram-bot/CLAUDE.md', lines(60, 'a')); // trim #1
      await commitFile('projects/telegram-bot/CLAUDE.md', lines(35, 'a')); // trim #2: PLAIN
      const failures = await sameFileTrimFailures(repo, ['projects/telegram-bot/CLAUDE.md'], Date.now());
      assert.equal(
        failures.length,
        1,
        `two plain trims on a companion-mapped file must still fail, got:\n${failures.join('\n')}`
      );
    });

    it('a trim commit touching an UNRELATED .md is not a companion relocation: the trim counts', async () => {
      // The companion set is exact paths, not "any other .md": an unrelated
      // doc edit riding the trim commit must not buy the reset.
      await commitFile('docs/unrelated-notes.md', lines(40, 'x'));
      await commitFile('projects/telegram-bot/CLAUDE.md', lines(120, 'a'));
      await commitFile('projects/telegram-bot/CLAUDE.md', lines(60, 'a')); // trim #1
      await commitFiles([
        { relPath: 'projects/telegram-bot/CLAUDE.md', content: lines(35, 'a') },
        { relPath: 'docs/unrelated-notes.md', content: lines(60, 'x') }, // touched, but not a companion
      ]);
      const failures = await sameFileTrimFailures(repo, ['projects/telegram-bot/CLAUDE.md'], Date.now());
      assert.equal(
        failures.length,
        1,
        `trim + unrelated-doc touch must count as 2 trims and fail, got:\n${failures.join('\n')}`
      );
    });
  });
});
