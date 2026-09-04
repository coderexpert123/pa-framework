import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, dirname, relative } from 'path';

// Compiled to pa/dist/tests/docs-crossref.test.js — __dirname is that file's
// dir; 3 levels up (dist/tests -> dist -> pa -> repo root), same convention
// as init-defaults.test.ts:47.
const REPO_ROOT = join(__dirname, '..', '..', '..');
const DOCS_DIR = join(REPO_ROOT, 'docs');

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

// Budgets measure content, not encoding: public Windows CI checks out CRLF
// (PR #34 run 33436146842 measured bot CLAUDE.md at 12,073 vs 11,923 LF).
// Single shared helper so every size-budget check below normalizes the same way.
function budgetLength(content: string): number {
  return content.replace(/\r\n/g, '\n').length;
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

  // Brain-file size budget (docs/CONVENTIONS.md § "Brain-file organization",
  // added 2026-08-07). Numbers here MUST match that section — if you're
  // changing one, change both, or this check silently drifts from the rule
  // it's supposed to enforce.
  it('root CLAUDE.md stays within its size budget (soft 40k, hard 48k chars)', () => {
    const claudeMd = readIfExists(join(REPO_ROOT, 'CLAUDE.md'));
    if (claudeMd === null) return; // absent in the public mirror
    const len = budgetLength(claudeMd);
    assert.ok(
      len <= 48000,
      `CLAUDE.md is ${len} chars, over the 48,000-char hard budget -- run /shorten-brain`
    );
  });

  it('every directory-scoped projects/*/CLAUDE.md stays within its size budget (12k chars)', () => {
    const PROJECTS_DIR = join(REPO_ROOT, 'projects');
    if (!existsSync(PROJECTS_DIR)) return;

    const failures: string[] = [];
    for (const entry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const claudeMdPath = join(PROJECTS_DIR, entry.name, 'CLAUDE.md');
      const content = readIfExists(claudeMdPath);
      if (content === null) continue;
      const len = budgetLength(content);
      if (len > 12000) {
        failures.push(`${claudeMdPath} is ${len} chars, over the 12,000-char budget`);
      }
    }
    assert.deepEqual(failures, [], failures.join('\n'));
  });

  it('docs/*.md operational-detail files stay within budget (16k); evergreen UPPERCASE guides get 24k', (t) => {
    if (!existsSync(DOCS_DIR)) return t.skip(DOCS_MISSING_REASON);
    const failures: string[] = [];
    for (const f of readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'))) {
      const content = readFileSync(join(DOCS_DIR, f), 'utf8');
      // Evergreen guides are ALL-CAPS-before-the-dot (BOT_GUIDE.md, CONFIGURATION.md);
      // extracted operational-detail files are lowercase-hyphen (repo-topology.md).
      // The job catalog (maintenance-jobs.md) grows monotonically with every declared
      // job — a documented raise-class (budget doctrine): 18k since AI-198's 32nd job.
      const isEvergreenGuide = /^[A-Z][A-Z0-9_]*\.md$/.test(f);
      const isJobCatalog = f === 'maintenance-jobs.md';
      // CONFIGURATION.md is the knobs catalog — one row per knob, the same
      // documented raise-class as the job catalog. Raised 24,000 -> 25,000
      // (2026-09-04, placement wave-1): the PA_CDISK_* rows crossed 24k on
      // legitimate per-knob growth; trimming inside a reference table rows
      // out knobs the code still ships.
      const isKnobsCatalog = f === 'CONFIGURATION.md';
      const budget = isKnobsCatalog ? 25000 : isEvergreenGuide ? 24000 : isJobCatalog ? 18000 : 16000;
      const len = budgetLength(content);
      if (len > budget) {
        failures.push(`docs/${f} is ${len} chars, over its ${budget.toLocaleString()}-char budget`);
      }
    }
    assert.deepEqual(failures, [], failures.join('\n'));
  });

  it('the FILE_INVENTORY.md router stays within its 4k budget', () => {
    const content = readIfExists(join(REPO_ROOT, 'FILE_INVENTORY.md'));
    if (content === null) return; // absent in the public mirror
    const len = budgetLength(content);
    assert.ok(
      len <= 4000,
      `FILE_INVENTORY.md is ${len} chars, over the 4,000-char router budget -- it has stopped being a router, re-split`
    );
  });

  it('inventory/*.md files stay within budget (16k manual, 20k for auto-managed glob-derived files)', () => {
    const INVENTORY_DIR = join(REPO_ROOT, 'inventory');
    if (!existsSync(INVENTORY_DIR)) return; // absent in the public mirror and pre-Phase-3 checkouts

    const failures: string[] = [];
    for (const f of readdirSync(INVENTORY_DIR).filter((f) => f.endsWith('.md'))) {
      const content = readFileSync(join(INVENTORY_DIR, f), 'utf8');
      // docs/CONVENTIONS.md § "Brain-file organization": a file the update-brain
      // skill rewrites wholesale from one glob() pattern gets the higher ceiling
      // -- its AUTO:FILE-INVENTORY-* marker pair is what makes it that class.
      const isAutoManaged = content.includes('<!-- AUTO:FILE-INVENTORY-');
      // Budget raised 18,000 -> 20,000 (2026-08-30): pa-lib.md crossed 18k on
      // legitimate growth -- one new entry per new lib module, and the lib only
      // grows. Trimming inside the AUTO markers is futile (update-brain owns it).
      // The durable fix is the split pa-lib.md's own header names (maintenance/
      // out); 20k is headroom toward that, not permission to grow unbounded.
      // Budget raised 20,000 -> 23,000 (2026-09-03): the handover waves' new lib
      // modules (topic-tasks/-events/-executor, orphan-ledger, daily-recon, grammars)
      // pushed pa-lib and telegram-bot past 20k on legitimate per-module growth.
      // Budget raised to 110,000 for placement-registry.md only (2026-09-03,
      // placement wave-1): it is an every-item-exactly-once census index — 263
      // 12-column machine-checkable rows validated by the placement completeness
      // checker (A1-A9), the raise-class per this file's own trim doctrine.
      // Splitting it would break the checker's single-file contract; growth is
      // bounded by census re-gates (~4 bytes/char per row), not prose drift.
      const isPlacementRegistry = f === 'placement-registry.md';
      const budget = isPlacementRegistry ? 110000 : isAutoManaged ? 23000 : 16000;
      const len = budgetLength(content);
      if (len > budget) {
        failures.push(`inventory/${f} is ${len} chars, over its ${budget.toLocaleString()}-char budget`);
      }
    }
    assert.deepEqual(failures, [], failures.join('\n'));
  });

  it('backlog/completed-index.md (the lookup table, not the archives) stays within its 20k budget', () => {
    // docs/CONVENTIONS.md § "Brain-file organization": archive-*.md/not-valid.md
    // are the "append-only archive" class with NO hard ceiling -- their size
    // tracks how much work shipped in a window, not anything a reader holds in
    // mind, and splitting one purely to hit a number would separate
    // cross-referenced items that must stay findable together. Only the
    // lookup-table file gets budget-checked here. Budget raised 16,000 -> 20,000
    // chars 2026-08-23 (Wave C, W-C13): the index is a monotonically growing
    // one-row-per-completed-item lookup table, never auto-loaded, so a fixed
    // ceiling is the wrong instrument -- raise this row rather than splitting.
    const content = readIfExists(join(REPO_ROOT, 'backlog', 'completed-index.md'));
    if (content === null) return; // absent in the public mirror and pre-Phase-4 checkouts
    const len = budgetLength(content);
    assert.ok(
      len <= 21000,
      `backlog/completed-index.md is ${len} chars, over the 21,000-char budget -- it's a lookup table, not an archive, and should stay scannable`
    );
  });

  it('root BACKLOG.md stays within its size budget (12k chars)', () => {
    const content = readIfExists(join(REPO_ROOT, 'BACKLOG.md'));
    if (content === null) return; // absent in the public mirror
    const len = budgetLength(content);
    assert.ok(
      len <= 12000,
      `BACKLOG.md is ${len} chars, over its 12,000-char budget -- move more DONE items to backlog/`
    );
  });
});

// ---------------------------------------------------------------------------
// Budget-pressure doctrine — same-file-trim counter (operator directive
// 2026-09-03, docs/CONVENTIONS.md § "Brain-file organization"). The doctrine
// clause: "never trim the same file twice in a day — the second trim triggers
// a contract-look, and the contract picks the response"; its last line names
// this checker as the mechanical enforcement ("docs-lint's same-file-trim
// counter"). Coverage is exactly the files the size-budget tests above cover.
//
// Discriminator: one `git log --numstat --reverse` invocation per budgeted
// file; a commit is a TRIM iff its summed deletions exceed its summed
// additions (net-negative line delta = the file got smaller). Raises
// (net-positive) and balanced mechanical moves never qualify, whatever the
// churn volume. Each trim candidate additionally gets one memoized
// `git show --name-status` probe (commitAddsDoc): a candidate that also
// CREATES a .md file is a split and resets the counter instead of counting.
//
// Window: the doctrine's own landing commit is the rule's effective date —
// the rule cannot forbid the six-trim night that motivated it, and without
// this anchor the counter's very first suite run would fail on exactly that
// pre-doctrine history. In steady state (doctrine older than 24h ago) the
// anchor is older than now-24h and the window is the plain last 24h. No file
// is exempt; this is when the rule came into force, not a carve-out. When
// the marker is absent from this checkout's history (public mirror before
// its next sync, shallow checkout) the plain 24h window applies.
//
// The named tests deliberately run against FIXTURE git repos, not this
// repository: tonight's live history is itself a (sanctioned) multi-trim
// window, so a fixture is the only way the suite stays green while the
// mechanism is proven on exactly the shape the doctrine forbids repeating.
// ---------------------------------------------------------------------------

const TRIM_DOCTRINE_REF =
  'docs/CONVENTIONS.md § "Brain-file organization" — Budget-pressure doctrine (operator directive 2026-09-03)';
const TRIM_DOCTRINE_CLAUSE =
  'never trim the same file twice in a day — the second trim triggers a contract-look, and the contract picks the response';
const TRIM_WINDOW_MS = 24 * 60 * 60 * 1000;
const TRIM_COMMIT_LIMIT = 2; // fail at >= 2 trim commits inside the window
const DOCTRINE_MARKER = 'Budget-pressure doctrine';

const execFileP = promisify(execFile);

async function gitLog(repoRoot: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd: repoRoot,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
  return String(stdout);
}

let doctrineAnchorCache: string | null | undefined;

/**
 * The doctrine's landing commit time (ISO), or null when this checkout's
 * history doesn't carry it. ONE git invocation, memoized per process.
 */
function doctrineAnchorIso(repoRoot: string): Promise<string | null> {
  if (doctrineAnchorCache !== undefined) return Promise.resolve(doctrineAnchorCache);
  return gitLog(repoRoot, [
    'log',
    `-S${DOCTRINE_MARKER}`,
    '--format=%cI',
    '-1',
    '--',
    'docs/CONVENTIONS.md',
  ])
    .then((out) => {
      const iso = out.trim().split(/\r?\n/)[0]?.trim() ?? '';
      doctrineAnchorCache = iso ? new Date(iso).toISOString() : null;
      return doctrineAnchorCache;
    })
    .catch(() => {
      // Not a repo / git missing / marker absent: the plain window applies,
      // and the per-file lookups below fail closed with a clear message.
      doctrineAnchorCache = null;
      return null;
    });
}

interface TrimScan {
  file: string;
  trimCount: number;
  trimShas: string[];
}

/**
 * Memoized per sha: does this commit CREATE any .md file (name-status `A`)?
 */
const addsDocCache = new Map<string, boolean>();

async function commitAddsDoc(repoRoot: string, sha: string): Promise<boolean> {
  // `git log --numstat` cannot see file creation: a created file shows a plain
  // `added<TAB>0<TAB>path` row, byte-identical to a modify that only adds lines
  // (the `-`-marker form is --stat's, and binary files'.) The truth is one
  // name-status probe per trim candidate: `A<TAB>path`.
  const cached = addsDocCache.get(sha);
  if (cached !== undefined) return cached;
  const out = await gitLog(repoRoot, ['show', '--name-status', '--format=', sha, '--', '*.md']);
  const adds = out.split(/\r?\n/).some((line) => /^A\t.*\.md/.test(line));
  addsDocCache.set(sha, adds);
  return adds;
}

/**
 * ONE `git log --numstat --reverse` per file: `%H` lines delimit commits;
 * numstat lines (`added<TAB>deleted<TAB>path`, `-` for binary) accumulate per
 * commit, streamed OLDEST-FIRST (--reverse) so a split's reset clears exactly
 * the trims that accumulated before it — in git log's default newest-first
 * order the reset would fire before anything accumulated and wipe the wrong
 * end (the live window's split, 48929c4, is its newest trim). A commit counts
 * as a trim iff deleted > added — except a split (see commitAddsDoc), which
 * resets the counter instead of counting.
 */
async function findTrimCommits(repoRoot: string, file: string, sinceIso: string): Promise<TrimScan> {
  const out = await gitLog(repoRoot, [
    'log',
    `--since=${sinceIso}`,
    '--reverse',
    '--numstat',
    '--format=%H',
    '--',
    file,
  ]);
  const commits: Array<{ sha: string; added: number; deleted: number }> = [];
  let currentSha: string | null = null;
  let added = 0;
  let deleted = 0;
  const flush = () => {
    if (currentSha !== null) commits.push({ sha: currentSha, added, deleted });
    currentSha = null;
  };
  for (const line of out.split(/\r?\n/)) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      flush();
      currentSha = line;
      added = 0;
      deleted = 0;
      continue;
    }
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (m && currentSha !== null) {
      added += m[1] === '-' ? 0 : Number(m[1]);
      deleted += m[2] === '-' ? 0 : Number(m[2]);
    }
  }
  flush();

  let trimCount = 0;
  const trimShas: string[] = [];
  for (const { sha, added: a, deleted: d } of commits) {
    if (d <= a) continue;
    // Split exemption (doctrine amendment 2026-09-03): a net-negative commit
    // that also CREATES a new .md file is executing the doctrine's own
    // split-or-raise remedy, not trimming — its deletions moved to the new
    // file and the file's contract changed. Reset the counter: pre-split
    // trims don't count against the post-split file.
    if (await commitAddsDoc(repoRoot, sha)) {
      trimCount = 0;
      trimShas.length = 0;
      continue;
    }
    trimCount += 1;
    trimShas.push(sha);
  }
  return { file, trimCount, trimShas };
}

function trimFailureMessage(scan: TrimScan, windowStartIso: string): string {
  return [
    `${scan.file} was trimmed in ${scan.trimCount} commits within its 24h trim window (window started ${windowStartIso}; commits: ${scan.trimShas.join(', ')}).`,
    `${TRIM_DOCTRINE_REF}: "${TRIM_DOCTRINE_CLAUSE}".`,
    'Respond per this file\'s contract, not with a third trim: an auto-managed glob-derived inventory or an every-item-exactly-once index gets its documented ceiling RAISED; genuine prose/scope growth gets a SPLIT at the natural fault line.',
  ].join('\n');
}

/** All failing files (>= TRIM_COMMIT_LIMIT trims inside the window), message per file. */
async function sameFileTrimFailures(repoRoot: string, files: string[], nowMs: number): Promise<string[]> {
  const anchor = await doctrineAnchorIso(repoRoot);
  const windowStartMs = Math.max(nowMs - TRIM_WINDOW_MS, anchor ? Date.parse(anchor) : Number.NEGATIVE_INFINITY);
  const sinceIso = new Date(windowStartMs).toISOString();
  const failures: string[] = [];
  for (const file of files) {
    let scan: TrimScan;
    try {
      scan = await findTrimCommits(repoRoot, file, sinceIso);
    } catch (err) {
      failures.push(
        `${file}: same-file-trim counter could not read git history (${String(err)}) — fix the environment; this check fails closed`
      );
      continue;
    }
    if (scan.trimCount >= TRIM_COMMIT_LIMIT) {
      failures.push(trimFailureMessage(scan, sinceIso));
    }
  }
  return failures;
}

/** The exact set the size-budget tests above cover, as repo-relative forward-slash paths. */
function budgetedDocFiles(): string[] {
  const files: string[] = [];
  const push = (abs: string) => {
    if (existsSync(abs)) files.push(relative(REPO_ROOT, abs).split('\\').join('/'));
  };
  push(join(REPO_ROOT, 'CLAUDE.md'));
  push(join(REPO_ROOT, 'FILE_INVENTORY.md'));
  push(join(REPO_ROOT, 'BACKLOG.md'));
  push(join(REPO_ROOT, 'backlog', 'completed-index.md'));
  const projectsDir = join(REPO_ROOT, 'projects');
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) push(join(projectsDir, entry.name, 'CLAUDE.md'));
    }
  }
  if (existsSync(DOCS_DIR)) {
    for (const f of readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'))) push(join(DOCS_DIR, f));
  }
  const inventoryDir = join(REPO_ROOT, 'inventory');
  if (existsSync(inventoryDir)) {
    for (const f of readdirSync(inventoryDir).filter((f) => f.endsWith('.md'))) push(join(inventoryDir, f));
  }
  return files;
}

describe('budget-pressure doctrine: same-file-trim counter', () => {
  it('no budgeted doc file was trimmed twice within its 24h trim window (enforcement)', async () => {
    const failures = await sameFileTrimFailures(REPO_ROOT, budgetedDocFiles(), Date.now());
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
  });
});
