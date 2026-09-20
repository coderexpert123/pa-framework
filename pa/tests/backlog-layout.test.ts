import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseBacklog } from '../src/lib/backlog-merge.js';
import {
  discoverLayout,
  fileForSection,
  fileForTargetId,
  renderSectionTable,
  sectionFileRel,
  sectionSkeleton,
  slugifySection,
  spliceSectionTable,
  validateLayout,
  ROUTER_TABLE_OPEN,
  ROUTER_TABLE_CLOSE,
  type Layout,
  type SectionFile,
} from '../src/lib/backlog-layout.js';

/**
 * Unit tests for the §1 module contract (2026-09-18 router split, AI-316 —
 * plans/2026-09-18-backlog-router-split-SPEC.md §1). Pure helpers are tested
 * as pure functions (strings/values in); discoverLayout gets a temp-dir repo,
 * never the real one. The drain-level behavior built on these (named-skip
 * reasons, auto-create, routed merge) is proven in
 * backlog-fragments-drain.test.ts — this file pins the contract itself.
 */

/** A hand-built SectionFile for pure-function tests (no fs). */
function fakeFile(rel: string, sectionName: string, content?: string): SectionFile {
  const slug = /^open-(.+)\.md$/.exec(rel.split('/').pop()!)![1];
  const c = content ?? `# Open Items\n\n## ${sectionName}\n`;
  return { rel, abs: `/tmp/${rel}`, slug, sectionName, content: c, model: parseBacklog(c) };
}

function fakeLayout(files: SectionFile[], routerContent: string | null, routerHasMarkers = false): Layout {
  return { files, routerContent, routerHasMarkers };
}

describe('backlog-layout pure helpers', () => {
  it('slugifySection: lowercase, whitespace runs collapse to single hyphens, strip to [a-z-]', () => {
    assert.equal(slugifySection('Bugs'), 'bugs');
    assert.equal(slugifySection('Bugs R Us'), 'bugs-r-us', 'the documented case');
    assert.equal(slugifySection('Bug   Fixes'), 'bug-fixes', 'multi-space run -> ONE hyphen');
    assert.equal(slugifySection('Bug\tFixes\nNow'), 'bug-fixes-now', 'all whitespace runs -> -');
    assert.equal(slugifySection('Features 2.0'), 'features-', 'digits and dots strip to [a-z-]');
    assert.equal(slugifySection('Process-infra'), 'process-infra', 'existing hyphen survives');
    assert.equal(slugifySection('Café & Résumé'), 'caf--rsum', 'non-ascii strips, & becomes -');
    assert.equal(slugifySection(''), '', 'empty stays empty (rejected upstream by the schema regex)');
  });

  it('sectionFileRel: the canonical backlog/open-<slug>.md spelling', () => {
    assert.equal(sectionFileRel('bugs'), 'backlog/open-bugs.md');
    assert.equal(sectionFileRel('bugs-r-us'), 'backlog/open-bugs-r-us.md');
  });

  it('sectionSkeleton: the exact auto-create shape (# Open Items + one ## heading + trailing newline)', () => {
    assert.equal(sectionSkeleton('qa'), '# Open Items\n\n## qa\n');
    const model = parseBacklog(sectionSkeleton('qa'));
    assert.equal(model.sections.length, 1, 'a skeleton parses to exactly one section');
    assert.equal(model.sections[0].name, 'qa');
    assert.equal(model.sections[0].entries.length, 0);
  });

  it('fileForSection: slug-vs-slug identity — case-sensitive, never a name compare', () => {
    const files = [fakeFile('backlog/open-bugs.md', 'Bugs'), fakeFile('backlog/open-features.md', 'Features')];
    assert.equal(fileForSection(files, 'bugs')?.rel, 'backlog/open-bugs.md');
    assert.equal(fileForSection(files, 'features')?.rel, 'backlog/open-features.md');
    // The fragment validator already constrains section to [a-z][a-z-]{0,30},
    // so routing is an EXACT slug match — 'Bugs' (the heading's verbatim
    // casing) must NOT match: the slug, not the display name, is the key.
    assert.equal(fileForSection(files, 'Bugs'), null, 'case-sensitive slug identity, not a name compare');
    assert.equal(fileForSection(files, 'qa'), null, 'unknown slug -> null (auto-create path)');
    assert.equal(fileForSection([], 'bugs'), null);
  });

  it('fileForTargetId: none / one file / ambiguous across files', () => {
    const bugs = fakeFile(
      'backlog/open-bugs.md',
      'Bugs',
      '# Open Items\n\n## Bugs\n\n#### [AI-100] One\nBody.\n',
    );
    const feats = fakeFile(
      'backlog/open-features.md',
      'Features',
      '# Open Items\n\n## Features\n\n#### [AI-101] Two\nBody.\n',
    );
    const files = [bugs, feats];
    const hit = fileForTargetId(files, 100);
    assert.equal(hit.kind, 'file');
    assert.equal((hit as { file: SectionFile }).file.rel, 'backlog/open-bugs.md');
    assert.equal(fileForTargetId(files, 101).kind, 'file');
    assert.deepEqual(fileForTargetId(files, 999), { kind: 'none' }, 'archived/absent ids are unreachable');

    // The same id present in two files (a layout the validator does NOT
    // reject — per-file invariants only) routes as ambiguous.
    const dup = fakeFile(
      'backlog/open-other.md',
      'Other',
      '# Open Items\n\n## Other\n\n#### [AI-100] Dup\nBody.\n',
    );
    const amb = fileForTargetId([bugs, feats, dup], 100);
    assert.equal(amb.kind, 'ambiguous');
    assert.deepEqual(
      (amb as { files: SectionFile[] }).files.map((f) => f.rel),
      ['backlog/open-bugs.md', 'backlog/open-other.md'],
    );
  });
});

describe('backlog-layout router table', () => {
  it('renderSectionTable: marker pair + one row per file, sorted by rel', () => {
    const rows = renderSectionTable([
      { sectionName: 'Process', rel: 'backlog/open-process.md' },
      { sectionName: 'Bugs', rel: 'backlog/open-bugs.md' },
      { sectionName: 'Features', rel: 'backlog/open-features.md' },
    ]);
    assert.deepEqual(rows, [
      ROUTER_TABLE_OPEN,
      '| Bugs | `backlog/open-bugs.md` |',
      '| Features | `backlog/open-features.md` |',
      '| Process | `backlog/open-process.md` |',
      ROUTER_TABLE_CLOSE,
    ]);
  });

  it('renderSectionTable: an auto-created file sorts in by its slug', () => {
    const rows = renderSectionTable([
      { sectionName: 'Bugs', rel: 'backlog/open-bugs.md' },
      { sectionName: 'qa', rel: 'backlog/open-qa.md' },
      { sectionName: 'Features', rel: 'backlog/open-features.md' },
    ]);
    assert.deepEqual(rows, [
      ROUTER_TABLE_OPEN,
      '| Bugs | `backlog/open-bugs.md` |',
      '| Features | `backlog/open-features.md` |',
      '| qa | `backlog/open-qa.md` |',
      ROUTER_TABLE_CLOSE,
    ]);
  });

  const ROUTER = [
    '# Backlog',
    '',
    '# Open Items',
    '',
    'Pointer line.',
    '',
    ROUTER_TABLE_OPEN,
    '| Bugs | `backlog/open-bugs.md` |',
    '| Features | `backlog/open-features.md` |',
    ROUTER_TABLE_CLOSE,
    '',
    '# Archived items',
    '',
  ].join('\n');

  it('spliceSectionTable: replaces only the marker region, preserving content outside it', () => {
    const next = spliceSectionTable(ROUTER, [
      { sectionName: 'Bugs', rel: 'backlog/open-bugs.md' },
      { sectionName: 'qa', rel: 'backlog/open-qa.md' },
      { sectionName: 'Features', rel: 'backlog/open-features.md' },
    ]);
    assert.equal(
      next,
      [
        '# Backlog',
        '',
        '# Open Items',
        '',
        'Pointer line.',
        '',
        ROUTER_TABLE_OPEN,
        '| Bugs | `backlog/open-bugs.md` |',
        '| Features | `backlog/open-features.md` |',
        '| qa | `backlog/open-qa.md` |',
        ROUTER_TABLE_CLOSE,
        '',
        '# Archived items',
        '',
      ].join('\n'),
    );
  });

  it('spliceSectionTable: identical rows return the input byte-identically (the no-op byte-compare)', () => {
    const same = spliceSectionTable(ROUTER, [
      { sectionName: 'Bugs', rel: 'backlog/open-bugs.md' },
      { sectionName: 'Features', rel: 'backlog/open-features.md' },
    ]);
    assert.equal(same, ROUTER);
  });

  it('spliceSectionTable: absent marker pair returns the input unchanged', () => {
    const noMarkers = '# Backlog\n\n# Open Items\n\nNo markers here.\n\n# Archived items\n';
    assert.equal(spliceSectionTable(noMarkers, [{ sectionName: 'Bugs', rel: 'backlog/open-bugs.md' }]), noMarkers);
  });

  it('spliceSectionTable: duplicated open marker returns the input unchanged', () => {
    const dup = [
      ROUTER_TABLE_OPEN,
      '| Bugs | `backlog/open-bugs.md` |',
      ROUTER_TABLE_OPEN,
      '| Features | `backlog/open-features.md` |',
      ROUTER_TABLE_CLOSE,
    ].join('\n');
    assert.equal(spliceSectionTable(dup, [{ sectionName: 'Bugs', rel: 'backlog/open-bugs.md' }]), dup);
  });

  it('spliceSectionTable: duplicated close marker returns the input unchanged', () => {
    const dup = [
      ROUTER_TABLE_OPEN,
      '| Bugs | `backlog/open-bugs.md` |',
      ROUTER_TABLE_CLOSE,
      'prose',
      ROUTER_TABLE_CLOSE,
    ].join('\n');
    assert.equal(spliceSectionTable(dup, []), dup);
  });

  it('spliceSectionTable: out-of-order markers return the input unchanged', () => {
    const inverted = [
      ROUTER_TABLE_CLOSE,
      '| Bugs | `backlog/open-bugs.md` |',
      ROUTER_TABLE_OPEN,
    ].join('\n');
    assert.equal(spliceSectionTable(inverted, []), inverted);
  });

  it('spliceSectionTable: prose mentioning a marker is not a marker (trimmed-line identity)', () => {
    const mention = `# Backlog\n\nsee ${ROUTER_TABLE_OPEN} for details\n\n# Archived items\n`;
    assert.equal(spliceSectionTable(mention, []), mention);
  });

  it('spliceSectionTable: CRLF input splices and rejoins with CRLF', () => {
    const crlf = ROUTER.replace(/\n/g, '\r\n');
    const next = spliceSectionTable(crlf, [
      { sectionName: 'Bugs', rel: 'backlog/open-bugs.md' },
      { sectionName: 'qa', rel: 'backlog/open-qa.md' },
      { sectionName: 'Features', rel: 'backlog/open-features.md' },
    ]);
    assert.ok(next.includes('\r\n'), 'CRLF preserved');
    assert.ok(next.includes('| qa | `backlog/open-qa.md` |'));
    assert.equal(next.includes('\n\n'), false, 'no LF-only joins leaked in');
  });
});

describe('validateLayout — the four invariants and their named reasons', () => {
  const goodFile = () =>
    fakeFile('backlog/open-bugs.md', 'Bugs', '# Open Items\n\n## Bugs\n\n#### [AI-100] X\nBody.\n');

  it('a valid layout passes (files ok + router with no ## sections)', () => {
    const layout = fakeLayout([goodFile()], '# Backlog\n\n# Open Items\n\nPointer.\n\n# Archived items\n');
    assert.deepEqual(validateLayout(layout), { ok: true });
  });

  it('router absent is NOT a violation (regen just skips — never creates BACKLOG.md)', () => {
    const layout = fakeLayout([goodFile()], null);
    assert.deepEqual(validateLayout(layout), { ok: true });
  });

  it('invariant (router): a ## section in the open region names pre-router-backlog — the monolith case', () => {
    const monolith = '# Backlog\n\n# Open Items\n\n## Bugs\n\n#### [AI-1] X\nB.\n\n# Archived items\n';
    const res = validateLayout(fakeLayout([], monolith));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.problem.reason, 'pre-router-backlog');
      assert.ok(res.problem.detail.includes("BACKLOG.md's open region"), res.problem.detail);
    }
  });

  it('invariant (router): a stray ## heading in the open region is also pre-router-backlog, not layout-invalid', () => {
    const stray = '# Backlog\n\n# Open Items\n\nPointer.\n\n## Phantom\n\n# Archived items\n';
    const res = validateLayout(fakeLayout([goodFile()], stray));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.problem.reason, 'pre-router-backlog');
  });

  it('invariant (file): zero ## headings -> backlog-layout-invalid', () => {
    const bad = fakeFile('backlog/open-bugs.md', 'Bugs', '# Open Items\n\nno heading here\n');
    const res = validateLayout(fakeLayout([bad], null));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.problem.reason, 'backlog-layout-invalid');
      assert.ok(res.problem.detail.includes('backlog/open-bugs.md'), res.problem.detail);
      assert.ok(res.problem.detail.includes("expected exactly one '## ' heading"), res.problem.detail);
    }
  });

  it('invariant (file): two ## headings -> backlog-layout-invalid', () => {
    const bad = fakeFile('backlog/open-bugs.md', 'Bugs', '# Open Items\n\n## Bugs\n\n## Extra\n');
    const res = validateLayout(fakeLayout([bad], null));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.problem.reason, 'backlog-layout-invalid');
      assert.ok(res.problem.detail.includes('found 2'), res.problem.detail);
    }
  });

  it('invariant (file): a stray # Archived items -> backlog-layout-invalid (router-only heading)', () => {
    const bad = fakeFile(
      'backlog/open-bugs.md',
      'Bugs',
      '# Open Items\n\n## Bugs\n\n#### [AI-1] X\nB.\n\n# Archived items\n',
    );
    const res = validateLayout(fakeLayout([bad], null));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.problem.reason, 'backlog-layout-invalid');
      assert.ok(res.problem.detail.includes('# Archived items'), res.problem.detail);
    }
  });

  it("invariant (file): a # heading that isn't '# Open Items' -> backlog-layout-invalid", () => {
    const bad = fakeFile('backlog/open-bugs.md', 'Bugs', '# Wrong Title\n\n## Bugs\n');
    const res = validateLayout(fakeLayout([bad], null));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.problem.reason, 'backlog-layout-invalid');
      assert.ok(res.problem.detail.includes("'# Open Items'"), res.problem.detail);
    }
  });

  it('invariant (file): filename slug !== slugifySection(heading) -> backlog-layout-invalid naming both', () => {
    // open-wrong.md whose heading is '## Bugs': file slug 'wrong' != 'bugs'.
    const bad = fakeFile('backlog/open-wrong.md', 'Bugs', '# Open Items\n\n## Bugs\n');
    const res = validateLayout(fakeLayout([bad], null));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.problem.reason, 'backlog-layout-invalid');
      assert.ok(res.problem.detail.includes("'wrong'"), res.problem.detail);
      assert.ok(res.problem.detail.includes("'bugs'"), res.problem.detail);
    }
  });

  it('invariant (cross-file): two files slug-colliding on the same section slug -> backlog-layout-invalid', () => {
    // NOTE: unreachable on disk — the collision arm sits AFTER the per-file
    // slug rule (filename slug === slugifySection(heading)), so a real file
    // pair that could collide fails the earlier check first. The invariant is
    // still part of the contract, so it is proven on a hand-constructed Layout
    // where both files pass the per-file rules yet share a section slug.
    const mk = (rel: string): SectionFile => ({
      rel,
      abs: `/tmp/${rel}`,
      slug: 'same',
      sectionName: 'same',
      content: '# Open Items\n\n## same\n',
      model: parseBacklog('# Open Items\n\n## same\n'),
    });
    const res = validateLayout(fakeLayout([mk('backlog/open-same.md'), mk('backlog/open-same-2.md')], null));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.problem.reason, 'backlog-layout-invalid');
      assert.ok(res.problem.detail.includes('slug-collide'), res.problem.detail);
      assert.ok(res.problem.detail.includes("'same'"), res.problem.detail);
    }
  });

  it('precedence: a file-level violation outranks a monolith router (file checks run first)', () => {
    const bad = fakeFile('backlog/open-wrong.md', 'Bugs', '# Open Items\n\n## Bugs\n');
    const monolith = '# Backlog\n\n# Open Items\n\n## Bugs\n\n#### [AI-1] X\nB.\n\n# Archived items\n';
    const res = validateLayout(fakeLayout([bad], monolith));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.problem.reason, 'backlog-layout-invalid', 'file checks precede the router check');
  });

  it('#### and ### headings inside a section file are safe (^## requires exactly two hashes + space)', () => {
    const content = [
      '# Open Items',
      '',
      '## Bugs',
      '',
      '#### [AI-100] Item heading',
      'Body.',
      '',
      '### A subsection note',
      '',
    ].join('\n');
    const f = fakeFile('backlog/open-bugs.md', 'Bugs', content);
    assert.deepEqual(validateLayout(fakeLayout([f], null)), { ok: true });
  });
});

describe('discoverLayout (the only fs function)', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  async function seed(files: Record<string, string>): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'backlog-layout-'));
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, ...rel.split('/'));
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, content, 'utf8');
    }
    return dir;
  }

  it('globs backlog/open-*.md sorted, reads BACKLOG.md, detects the marker pair', async () => {
    const r = await seed({
      'BACKLOG.md': [
        '# Backlog',
        '',
        '# Open Items',
        '',
        'Pointer.',
        '',
        ROUTER_TABLE_OPEN,
        '| Bugs | `backlog/open-bugs.md` |',
        ROUTER_TABLE_CLOSE,
        '',
        '# Archived items',
        '',
      ].join('\n'),
      'backlog/open-bugs.md': '# Open Items\n\n## Bugs\n\n#### [AI-100] X\nBody.\n',
      'backlog/open-alpha.md': '# Open Items\n\n## Alpha\n',
      'backlog/completed-2026-09-18.md': '# Backlog completed\n',
      'backlog/programs-2026-08.md': '# Programs\n',
    });
    const layout = await discoverLayout(r);
    assert.deepEqual(
      layout.files.map((f) => f.rel),
      ['backlog/open-alpha.md', 'backlog/open-bugs.md'],
      'open-*.md only, sorted by rel — completed/programs are not section files',
    );
    assert.equal(layout.files[0].slug, 'alpha');
    assert.equal(layout.files[1].slug, 'bugs');
    assert.equal(layout.files[1].sectionName, 'Bugs');
    assert.equal(layout.files[1].model.sections[0].entries[0].id, 100, 'model is parsed');
    assert.equal(layout.routerHasMarkers, true);
    assert.ok(layout.routerContent !== null && layout.routerContent.includes('# Backlog'));
  });

  it('missing BACKLOG.md -> routerContent null, routerHasMarkers false (never an error)', async () => {
    const r = await seed({ 'backlog/open-bugs.md': '# Open Items\n\n## Bugs\n' });
    const layout = await discoverLayout(r);
    assert.equal(layout.routerContent, null);
    assert.equal(layout.routerHasMarkers, false);
    assert.equal(layout.files.length, 1);
  });

  it('missing backlog/ dir -> zero files, never an error', async () => {
    const r = await seed({ 'BACKLOG.md': '# Backlog\n' });
    const layout = await discoverLayout(r);
    assert.deepEqual(layout.files, []);
    assert.equal(layout.routerHasMarkers, false);
  });

  it('router without the marker pair -> routerHasMarkers false', async () => {
    const r = await seed({
      'BACKLOG.md': '# Backlog\n\n# Open Items\n\nNo markers.\n\n# Archived items\n',
      'backlog/open-bugs.md': '# Open Items\n\n## Bugs\n',
    });
    const layout = await discoverLayout(r);
    assert.equal(layout.routerHasMarkers, false);
  });

  it('a duplicated marker pair -> routerHasMarkers false', async () => {
    const r = await seed({
      'BACKLOG.md': [
        ROUTER_TABLE_OPEN,
        '| Bugs | `backlog/open-bugs.md` |',
        ROUTER_TABLE_OPEN,
        '| Features | `backlog/open-features.md` |',
        ROUTER_TABLE_CLOSE,
      ].join('\n'),
      'backlog/open-bugs.md': '# Open Items\n\n## Bugs\n',
    });
    const layout = await discoverLayout(r);
    assert.equal(layout.routerHasMarkers, false);
  });
});
