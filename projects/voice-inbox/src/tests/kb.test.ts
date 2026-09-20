/**
 * Knowledge-base reader tests (vi-19787afc4b2e): the parser's chrome drops
 * and summary fallback, the caps (256 KB per file, 200 lines per section,
 * 60 topic docs / 20 domain docs), consolidated-DESC ordering with
 * missing-last, and fail-soft behavior on missing roots. Every test passes
 * fixture dirs through the `readKnowledgeBase(roots?)` seam — none ever
 * touch the operator's real topic brains or Ecosystem KB.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKnowledgeBase, type KbRoots } from '../kb.js';

/** One temp KB tree per test; rmSync in a finally (the makeLedger idiom). */
function makeKbFixture(): { dir: string; roots: KbRoots; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-kb-'));
  const topicsDir = join(dir, 'topic-brains');
  const domainsDir = join(dir, 'ecosystem-kb');
  mkdirSync(topicsDir, { recursive: true });
  mkdirSync(domainsDir, { recursive: true });
  return {
    dir,
    roots: { topicsDir, domainsDir },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Write `<topicsDir>/<id>/BRAIN.md` in one call. */
function writeTopicBrain(roots: KbRoots, id: string, raw: string): void {
  mkdirSync(join(roots.topicsDir, id), { recursive: true });
  writeFileSync(join(roots.topicsDir, id, 'BRAIN.md'), raw, 'utf8');
}

/** Every section line across a doc, flattened — the chrome-drop assertions
 * run against this so a dropped line cannot hide in a later section. */
function allLines(doc: { sections: Array<{ lines: string[] }> }): string[] {
  return doc.sections.flatMap((s) => s.lines);
}

const TOPIC_BRAIN = [
  '<!-- topic-brain: consolidated=2026-09-12T22:36:09.562323+05:30 covers=2026-09-05..2026-09-12 -->',
  '',
  '# feature-changes',
  '',
  '',
  '',
  '> Summary: Terminal layout auto-restore via WezTerm + resurrect plugin',
  '',
  '## Current state',
  '',
  '- WezTerm config live; startup restore works',
  '- GPU driver crash loses only in-flight state',
  'Restore replaces the Windows Terminal workflow.',
  '',
  '## Decisions & conventions',
  '',
  '- One pane per topic workspace',
  '> A blockquote line that must be dropped.',
  '- Panes are named, never numbered',
  '',
  '## Open threads',
  '',
  '- Scrollback capture format undecided',
  '',
  '## KB pointers',
  '',
  '- See the resurrect plugin docs',
  '',
  'Other topics: see the INDEX at D:/Personal Assistant/topic-brains/INDEX.md',
  'Central brain: D:/Personal Assistant/CLAUDE.md — framework truths and routing; this file holds only this topic\'s knowledge.',
].join('\n');

const DOMAIN_FILE = [
  '> Note: living document, consolidated nightly. Do not edit by hand.',
  '',
  'Open tasks, follow-ups, and commitments from PA conversations. Organized by urgency.',
  '',
  '> **Skill instructions**: read the Urgent section before every triage pass.',
  '',
  '## Urgent / Medical',
  '',
  '<!-- LIVING SECTION -->',
  '',
  '- [KAI-001] Book the annual physical.',
  '- [KAI-002] Refill the prescription.',
  '',
  '### Entry Name',
  '',
  'Background prose under the entry heading.',
].join('\n');

describe('kb parser (vi-19787afc4b2e)', () => {
  it('topic brain: title, summary, consolidated, sections parse; chrome drops', () => {
    const f = makeKbFixture();
    try {
      writeTopicBrain(f.roots, 'id-a', TOPIC_BRAIN);
      const kb = readKnowledgeBase(f.roots);
      assert.equal(kb.topics.length, 1);
      const doc = kb.topics[0];
      assert.equal(doc.id, 'id-a');
      assert.equal(doc.title, 'feature-changes');
      assert.equal(doc.summary, 'Terminal layout auto-restore via WezTerm + resurrect plugin');
      assert.equal(doc.consolidated, '2026-09-12T22:36:09.562323+05:30');
      assert.deepEqual(
        doc.sections.map((s) => s.heading),
        ['Current state', 'Decisions & conventions', 'Open threads', 'KB pointers']
      );
      const lines = allLines(doc);
      for (const line of lines) {
        assert.ok(!line.startsWith('>'), `blockquote survived: ${line}`);
        assert.ok(!line.startsWith('<!--'), `comment survived: ${line}`);
        assert.ok(!line.includes('Other topics:'), `footer survived: ${line}`);
        assert.ok(!line.includes('Central brain:'), `footer survived: ${line}`);
      }
      // Bullet lines preserved verbatim — markers included: the PWA's kb
      // card groups consecutive '- ' runs into lists itself (inline
      // formatting is a client concern; parseKbDoc strips only ATX hashes).
      const current = doc.sections[0].lines;
      assert.deepEqual(current, [
        '- WezTerm config live; startup restore works',
        '- GPU driver crash loses only in-flight state',
        'Restore replaces the Windows Terminal workflow.',
      ]);
    } finally {
      f.cleanup();
    }
  });

  it('domain file: preamble drops, first surviving preamble line becomes summary, ATX markers strip', () => {
    const f = makeKbFixture();
    try {
      writeFileSync(join(f.roots.domainsDir, 'Action Items.md'), DOMAIN_FILE, 'utf8');
      const kb = readKnowledgeBase(f.roots);
      assert.equal(kb.domains.length, 1);
      const doc = kb.domains[0];
      assert.equal(doc.id, 'Action Items');
      // No `> Summary: ` line: the FIRST preamble line surviving the drops
      // (the blockquoted note is dropped) becomes the summary.
      assert.equal(
        doc.summary,
        'Open tasks, follow-ups, and commitments from PA conversations. Organized by urgency.'
      );
      const lines = allLines(doc);
      for (const line of lines) {
        assert.ok(!line.includes('### '), `ATX marker survived: ${line}`);
        assert.ok(!line.startsWith('#'), `ATX marker survived: ${line}`);
        assert.ok(!line.startsWith('<!--'), `comment survived: ${line}`);
      }
      // `### Entry Name` keeps its TEXT with the hashes stripped.
      assert.ok(lines.includes('Entry Name'), 'entry heading text missing');
      assert.ok(lines.includes('- [KAI-001] Book the annual physical.'));
    } finally {
      f.cleanup();
    }
  });

  it('caps: 200 lines per section', () => {
    const f = makeKbFixture();
    try {
      const lines: string[] = [];
      for (let i = 0; i < 250; i++) lines.push(`- line ${i}`);
      writeFileSync(
        join(f.roots.domainsDir, 'big.md'),
        ['## Big', '', ...lines].join('\n'),
        'utf8'
      );
      const kb = readKnowledgeBase(f.roots);
      assert.equal(kb.domains.length, 1);
      assert.deepEqual(kb.domains[0].sections.map((s) => s.lines.length), [200]);
      assert.equal(kb.domains[0].sections[0].lines[0], '- line 0');
      assert.equal(kb.domains[0].sections[0].lines[199], '- line 199');
    } finally {
      f.cleanup();
    }
  });

  it('caps: 60 topic docs, consolidated DESC, missing-consolidated last', () => {
    const f = makeKbFixture();
    try {
      const pad = (n: number) => String(n).padStart(2, '0');
      // Dirs 0..59 carry consolidated stamps where a LARGER dir index means
      // an OLDER timestamp; dirs 60/61 carry none (sort last, then cut).
      for (let k = 0; k < 62; k++) {
        const stamp =
          k < 60
            ? `<!-- topic-brain: consolidated=2026-09-12T17:00:${pad(59 - k)}Z -->`
            : '';
        writeTopicBrain(
          f.roots,
          `topic-${pad(k)}`,
          ['# title', stamp, '> Summary: s', '', '## One', '', '- a'].filter(Boolean).join('\n')
        );
      }
      const kb = readKnowledgeBase(f.roots);
      assert.equal(kb.topics.length, 60);
      const first = kb.topics[0];
      assert.equal(first.id, 'topic-00');
      assert.equal(first.consolidated, '2026-09-12T17:00:59Z'); // newest
      for (let i = 1; i < kb.topics.length; i++) {
        const prev = kb.topics[i - 1].consolidated ?? '';
        const cur = kb.topics[i].consolidated ?? '';
        assert.ok(prev >= cur, `order broken at ${i}: ${prev} < ${cur}`);
      }
      // The two missing-consolidated docs sorted last and were cut.
      assert.ok(!kb.topics.some((d) => d.id === 'topic-60'));
      assert.ok(!kb.topics.some((d) => d.id === 'topic-61'));
      assert.ok(kb.topics.every((d) => d.consolidated !== null));
    } finally {
      f.cleanup();
    }
  });

  it('caps: 20 domain docs, title ASC', () => {
    const f = makeKbFixture();
    try {
      const pad = (n: number) => String(n).padStart(2, '0');
      for (let k = 1; k <= 21; k++) {
        writeFileSync(
          join(f.roots.domainsDir, `doc-${pad(k)}.md`),
          `# Doc ${pad(k)}\n\nIntro line ${k}.\n`,
          'utf8'
        );
      }
      const kb = readKnowledgeBase(f.roots);
      assert.equal(kb.domains.length, 20);
      assert.equal(kb.domains[0].title, 'Doc 01');
      assert.equal(kb.domains[19].title, 'Doc 20');
      assert.ok(!kb.domains.some((d) => d.title === 'Doc 21'));
    } finally {
      f.cleanup();
    }
  });

  it('missing root dirs yield empty lists, never a throw', () => {
    const f = makeKbFixture();
    try {
      const kb = readKnowledgeBase({
        topicsDir: join(f.dir, 'nope-topics'),
        domainsDir: join(f.dir, 'nope-domains'),
      });
      assert.deepEqual(kb, { topics: [], domains: [] });
    } finally {
      f.cleanup();
    }
  });

  it('skips topic dirs without BRAIN.md, non-md files, and files over 256 KB', () => {
    const f = makeKbFixture();
    try {
      // A topic dir with no BRAIN.md — skipped entirely.
      mkdirSync(join(f.roots.topicsDir, 'no-brain'), { recursive: true });
      writeFileSync(join(f.roots.topicsDir, 'no-brain', 'README.md'), 'not a brain', 'utf8');
      // A valid topic dir for the control.
      writeTopicBrain(f.roots, 'real-topic', '# real\n\n> Summary: real summary\n');
      // A non-md file in domains — skipped.
      writeFileSync(join(f.roots.domainsDir, 'notes.txt'), 'plain notes', 'utf8');
      // A 257 KB .md file — skipped (over the 256 KB cap).
      writeFileSync(join(f.roots.domainsDir, 'huge.md'), 'x'.repeat(257 * 1024), 'utf8');
      // An under-cap domain file for the control.
      writeFileSync(join(f.roots.domainsDir, 'small.md'), '# Small\n\nSmall domain note.\n', 'utf8');

      const kb = readKnowledgeBase(f.roots);
      assert.deepEqual(kb.topics.map((d) => d.id), ['real-topic']);
      assert.equal(kb.topics[0].summary, 'real summary');
      assert.deepEqual(kb.domains.map((d) => d.id), ['small']);
    } finally {
      f.cleanup();
    }
  });

  it('a doc with zero sections is kept', () => {
    const f = makeKbFixture();
    try {
      writeTopicBrain(f.roots, 'bare', '# name\n\n> Summary: nothing to section yet\n');
      const kb = readKnowledgeBase(f.roots);
      assert.equal(kb.topics.length, 1);
      assert.equal(kb.topics[0].title, 'name');
      assert.equal(kb.topics[0].summary, 'nothing to section yet');
      assert.deepEqual(kb.topics[0].sections, []);
    } finally {
      f.cleanup();
    }
  });
});
