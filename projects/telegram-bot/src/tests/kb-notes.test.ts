import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyKbNote, appendKbNote, kbSourcesPath } from '../kb-notes.js';

// ---------------------------------------------------------------------------
// applyKbNote (pure)
// ---------------------------------------------------------------------------

const FIXED_DATE = new Date('2026-08-05T10:15:00Z'); // 15:45 IST

describe('applyKbNote', () => {
  it('appends a new domain section when no matching heading exists', () => {
    const { content, matchedExisting } = applyKbNote('# Sources\n\n---\n', 'New Domain', 'first note', FIXED_DATE);
    assert.equal(matchedExisting, false);
    assert.match(content, /## New Domain/);
    assert.match(content, /<!-- LIVING SECTION -->/);
    assert.match(content, /\*Last updated: 2026-08-05\*/);
    assert.match(content, /- \*\*Recent\*\*: first note \(auto, 2026-08-05 15:45 IST\)/);
  });

  it('updates an existing domain section\'s Recent line and Last updated date', () => {
    const original = [
      '# Sources',
      '',
      '## Ekadashi / fasting calendar',
      '',
      '<!-- LIVING SECTION -->',
      '',
      '*Last updated: 2026-07-01*',
      '',
      '- **System of record**: some/path.json',
      '- **Recent**: old note here',
      '',
      '---',
      '',
      '## Other Domain',
      '',
      '<!-- LIVING SECTION -->',
      '',
      '*Last updated: 2026-06-01*',
      '',
      '- **Recent**: unrelated note',
      '',
      '---',
      '',
    ].join('\n');

    const { content, matchedExisting } = applyKbNote(original, 'Ekadashi / fasting calendar', 'new note here', FIXED_DATE);
    assert.equal(matchedExisting, true);
    assert.match(content, /- \*\*Recent\*\*: new note here \(auto, 2026-08-05 15:45 IST\)/);
    assert.match(content, /\*Last updated: 2026-08-05\*/);
    // The System of record line and the OTHER domain's section must survive untouched.
    assert.match(content, /- \*\*System of record\*\*: some\/path\.json/);
    assert.match(content, /- \*\*Recent\*\*: unrelated note/);
    assert.match(content, /\*Last updated: 2026-06-01\*/, 'unrelated domain\'s date must not change');
    assert.ok(!content.includes('old note here'), 'the stale Recent line must be replaced, not duplicated');
  });

  it('domain match is case-insensitive', () => {
    const original = '## Ekadashi / Fasting Calendar\n\n<!-- LIVING SECTION -->\n\n*Last updated: 2026-07-01*\n\n- **Recent**: old\n\n---\n';
    const { matchedExisting } = applyKbNote(original, 'ekadashi / fasting calendar', 'new', FIXED_DATE);
    assert.equal(matchedExisting, true);
  });

  it('does not touch a similarly-named but distinct domain', () => {
    const original = '## Ekadashi\n\n<!-- LIVING SECTION -->\n\n*Last updated: 2026-07-01*\n\n- **Recent**: old\n\n---\n';
    const { matchedExisting } = applyKbNote(original, 'Ekadashi Extended', 'new', FIXED_DATE);
    assert.equal(matchedExisting, false, 'must not fuzzy-match a longer/different domain name');
  });

  it('handles a domain section with no existing Recent line by adding one', () => {
    const original = '## Bare Domain\n\n<!-- LIVING SECTION -->\n\n*Last updated: 2026-07-01*\n\n---\n';
    const { content, matchedExisting } = applyKbNote(original, 'Bare Domain', 'first ever note', FIXED_DATE);
    assert.equal(matchedExisting, true);
    assert.match(content, /- \*\*Recent\*\*: first ever note/);
  });

  it('is idempotent-shaped: applying twice replaces rather than duplicates', () => {
    let content = '## D\n\n<!-- LIVING SECTION -->\n\n*Last updated: 2026-07-01*\n\n- **Recent**: a\n\n---\n';
    content = applyKbNote(content, 'D', 'b', FIXED_DATE).content;
    content = applyKbNote(content, 'D', 'c', FIXED_DATE).content;
    const recentCount = (content.match(/- \*\*Recent\*\*:/g) || []).length;
    assert.equal(recentCount, 1, 'must not accumulate multiple Recent lines for the same domain');
    assert.match(content, /- \*\*Recent\*\*: c \(auto,/);
  });
});

// ---------------------------------------------------------------------------
// appendKbNote / kbSourcesPath (I/O)
// ---------------------------------------------------------------------------

describe('appendKbNote', () => {
  let tempDir: string;
  let sourcesPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-kb-notes-'));
    sourcesPath = join(tempDir, 'notes', 'Sources.md');
    process.env.PA_KB_SOURCES_PATH = sourcesPath;
  });

  afterEach(async () => {
    delete process.env.PA_KB_SOURCES_PATH;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('kbSourcesPath reflects PA_KB_SOURCES_PATH', () => {
    assert.equal(kbSourcesPath(), sourcesPath);
  });

  it('kbSourcesPath is undefined when unset — feature is off by default', () => {
    delete process.env.PA_KB_SOURCES_PATH;
    assert.equal(kbSourcesPath(), undefined);
  });

  it('creates the file (and parent dir) with a skeleton if it does not exist', async () => {
    const ok = await appendKbNote('New Domain', 'a fact');
    assert.equal(ok, true);
    const content = await readFile(sourcesPath, 'utf8');
    assert.match(content, /## New Domain/);
    assert.match(content, /- \*\*Recent\*\*: a fact/);
  });

  it('appends into an existing file without clobbering other domains', async () => {
    await mkdir(join(tempDir, 'notes'), { recursive: true });
    await writeFile(sourcesPath, '# Sources\n\n## Existing\n\n<!-- LIVING SECTION -->\n\n*Last updated: 2026-01-01*\n\n- **Recent**: keep me\n\n---\n', 'utf8');
    const ok = await appendKbNote('New Domain', 'fresh fact');
    assert.equal(ok, true);
    const content = await readFile(sourcesPath, 'utf8');
    assert.match(content, /- \*\*Recent\*\*: keep me/);
    assert.match(content, /- \*\*Recent\*\*: fresh fact/);
  });

  it('returns false and does not write when PA_KB_SOURCES_PATH is unset', async () => {
    delete process.env.PA_KB_SOURCES_PATH;
    const ok = await appendKbNote('Domain', 'note');
    assert.equal(ok, false);
  });

  it('returns false for an empty domain', async () => {
    assert.equal(await appendKbNote('', 'note'), false);
  });

  it('returns false for an empty note', async () => {
    assert.equal(await appendKbNote('Domain', ''), false);
  });

  it('returns false for an oversized domain', async () => {
    assert.equal(await appendKbNote('x'.repeat(101), 'note'), false);
  });

  it('returns false for an oversized note', async () => {
    assert.equal(await appendKbNote('Domain', 'x'.repeat(301)), false);
  });

  it('never throws even if the path is unwritable (e.g. points at a directory)', async () => {
    process.env.PA_KB_SOURCES_PATH = tempDir; // a directory, not a file
    const ok = await appendKbNote('Domain', 'note');
    assert.equal(ok, false);
  });
});
