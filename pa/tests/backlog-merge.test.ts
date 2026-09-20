import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  FRAGMENT_SCHEMA_VERSION,
  deleteFragment,
  fragmentsDir,
  listFragments,
  mergeFragments,
  parseBacklog,
  quarantineFragment,
  scanMaxId,
  writeFragment,
} from '../src/lib/backlog-merge.js';

// Fixture mirrors the real BACKLOG.md shape (spec D3): sections end either
// with a trailing `---` + blank lines before the next `## ` heading (Bugs)
// or — Features-style — have a mid-section `---` before an older entry, and
// Process ends with a trailing `---` before the `# Archived items` bound.
const BASE = [
  '# Backlog',
  '',
  'Intro.',
  '',
  '# Open Items',
  '',
  '## Bugs',
  '',
  '#### [AI-216] /stop cancels every thread',
  'Bug / P1 / FILED 2026-09-08 - body line one.',
  '',
  '#### [AI-223] phantom rows',
  'Bug / P2 / BUILT 2026-09-10 - fixed.',
  '',
  '---',
  '',
  '## Features',
  '',
  '#### [AI-222] conversation rows',
  'Feature / P2 / BUILT 2026-09-10 - done.',
  '',
  '---',
  '',
  '## Process',
  '',
  '#### [AI-214] orphaned-edit detection',
  'Process / P2 / FILED 2026-09-08 - landed.',
  '',
  '---',
  '',
  '# Archived items',
  '',
  'Archived items live behind backlog/completed-index.md.',
  '',
].join('\n');

// Same shape minus the Bugs section's trailing `---` — the other real shape.
const NO_DASH = [
  '# Open Items',
  '',
  '## Bugs',
  '',
  '#### [AI-223] phantom rows',
  'Bug / P2 / BUILT 2026-09-10 - fixed.',
  '',
  '## Features',
  '',
  '#### [AI-222] conversation rows',
  'Feature / P2 / BUILT 2026-09-10 - done.',
  '',
  '# Archived items',
  '',
].join('\n');

const AMBIGUOUS = BASE.replace(
  '#### [AI-222] conversation rows',
  '#### [AI-216] duplicate id entry\nFeature / P2 / dup.\n\n#### [AI-222] conversation rows',
);

// 2026-09-12T15:32:04.123Z — fixed mint clock for determinism asserts.
const FIXED_NOW = Date.UTC(2026, 8, 12, 15, 32, 4, 123);

function addObj(over: {
  section?: string;
  title?: string;
  body?: string;
  session?: string;
}): Record<string, unknown> {
  return {
    v: FRAGMENT_SCHEMA_VERSION,
    verb: 'add',
    session: over.session ?? 't-test',
    created: '2026-09-12T15:32:04.123Z',
    section: over.section ?? 'process',
    title: over.title ?? 'Test entry title',
    body: over.body ?? 'Process / P2 / FILED 2026-09-12 - test body line.',
  };
}

function mergeOne(backlog: string, raw: string): ReturnType<typeof mergeFragments> {
  return mergeFragments(backlog, [{ stem: 's-x', fragment: raw }], scanMaxId(backlog, []), parseBacklog(backlog));
}

describe('backlog-merge', () => {
  let repo: string;

  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
    repo = '';
  });

  it('schema validation matrix: each field rule fails with its named error', () => {
    const cases: Array<[Record<string, unknown> | string, string]> = [
      ['{not json', 'bad-json'],
      [{ ...addObj({}), v: 2 }, 'bad-v'],
      [{ ...addObj({}), verb: 'delete' }, 'bad-verb'],
      [{ ...addObj({}), session: '-leading-dash' }, 'bad-session'],
      [{ ...addObj({}), session: 's'.repeat(65) }, 'bad-session'],
      [{ ...addObj({}), created: 'not-a-date' }, 'bad-created'],
      [{ ...addObj({ section: 'Bugs' }) }, 'bad-section'],
      [{ ...addObj({ section: '1x' }) }, 'bad-section'],
      [{ ...addObj({ title: '' }) }, 'bad-title'],
      [{ ...addObj({ title: 'two\nlines' }) }, 'bad-title'],
      [{ ...addObj({ title: 'x'.repeat(201) }) }, 'bad-title'],
      [{ ...addObj({ body: '' }) }, 'bad-body'],
      [{ ...addObj({ body: 'x'.repeat(2001) }) }, 'bad-body'],
      // status verb rules
      [{ v: 1, verb: 'status', session: 't-test', created: '2026-09-12T15:32:04.123Z', target: 'AI-23', status_line: 'x' }, 'bad-target'],
      [{ v: 1, verb: 'status', session: 't-test', created: '2026-09-12T15:32:04.123Z', target: 'AI-216', status_line: '' }, 'bad-status-line'],
      [{ v: 1, verb: 'status', session: 't-test', created: '2026-09-12T15:32:04.123Z', target: 'AI-216', status_line: 'y'.repeat(2001) }, 'bad-status-line'],
      // application rules (schema-valid, merge-level)
      [{ ...addObj({ section: 'nonsense' }) }, 'unknown section'],
      [{ v: 1, verb: 'status', session: 't-test', created: '2026-09-12T15:32:04.123Z', target: 'AI-999', status_line: 'x' }, 'unknown target'],
      [{ v: 1, verb: 'status', session: 't-test', created: '2026-09-12T15:32:04.123Z', target: 'AI-216', status_line: 'x' }, 'ambiguous target'],
    ];
    // The ambiguous case needs the duplicated-id fixture; the two generic
    // status cases run against BASE where AI-216 exists exactly once.
    for (const [raw, expected] of cases) {
      const backlog = expected === 'ambiguous target' ? AMBIGUOUS : BASE;
      const res = mergeOne(backlog, typeof raw === 'string' ? raw : JSON.stringify(raw));
      assert.deepEqual(res.failed, [{ stem: 's-x', error: expected }], `case → ${expected}`);
      assert.deepEqual(res.applied, []);
      assert.deepEqual(res.alreadyMerged, []);
    }
  });

  it('a valid add applies: section match is case-insensitive, block has one blank line around it', () => {
    const res = mergeOne(BASE, JSON.stringify(addObj({ section: 'process' })));
    assert.deepEqual(res.failed, []);
    assert.deepEqual(res.applied, [{ stem: 's-x', id: 224 }]);
    const lines = res.content.split('\n');
    const i = lines.indexOf('#### [AI-224] Test entry title');
    assert.ok(i > 0, 'new heading present');
    assert.equal(lines[i - 1], '');
    assert.equal(lines[i + 1], 'Process / P2 / FILED 2026-09-12 - test body line.');
    assert.equal(lines[i + 2], '<!-- frag:s-x -->');
    assert.equal(lines[i + 3], '');
  });

  it('a slug fragment matches a multi-word heading through the shared slugify (2026-09-18 verifier regression)', () => {
    // Post-split, --section IS a slug and headings are display names: 'Bug
    // Fixes' → file slug 'bug-fixes'. A name-compare ('bug fixes' vs
    // 'bug-fixes') routed correctly and then died 'unknown section' —
    // spec §10's "unreachable" claim falsified. slugifySection is the shared
    // transform (backlog-layout re-exports it from this module).
    const MULTI = [
      '# Open Items',
      '',
      '## Bug Fixes',
      '',
      '#### [AI-100] Existing',
      'B.',
      '',
      '# Archived items',
      '',
    ].join('\n');
    const res = mergeOne(MULTI, JSON.stringify(addObj({ section: 'bug-fixes' })));
    assert.deepEqual(res.failed, []);
    assert.deepEqual(res.applied, [{ stem: 's-x', id: 101 }]);
    assert.ok(res.content.includes('#### [AI-101] Test entry title'), 'item landed under ## Bug Fixes');
    // Single-word headings keep matching (slug == lowercase there).
    const res2 = mergeOne(BASE, JSON.stringify(addObj({ section: 'bugs' })));
    assert.deepEqual(res2.failed, []);
    // And a genuinely absent section still fails closed.
    const res3 = mergeOne(MULTI, JSON.stringify(addObj({ section: 'nonsense' })));
    assert.deepEqual(res3.failed, [{ stem: 's-x', error: 'unknown section' }]);
  });

  it('known-bad gate 1: malformed fragment fails validation with a named error and is quarantined while batch-mates still apply', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-merge-'));
    // Real producer output for the good fragments; hand-corrupted files for
    // the bad classes the drain must survive: bad JSON, unknown verb,
    // missing field, oversize body.
    // Pinned clocks a second apart make the stem sort order deterministic,
    // so the id assignments below are exact, not order-lucky.
    const good1 = await writeFragment(
      repo,
      { verb: 'add', section: 'bugs', title: 'Good one', body: 'Bug / P1 / FILED 2026-09-12 - body.' },
      't-good1',
      { now: FIXED_NOW },
    );
    const dir = fragmentsDir(repo);
    const raw = (name: string, content: string): Promise<void> =>
      writeFile(join(dir, `${name}.json`), content, 'utf8');
    await raw('bad-json', '{oops');
    await raw(
      'bad-verb',
      JSON.stringify({ v: 1, verb: 'delete', session: 't-bad', created: '2026-09-12T15:32:04.123Z' }),
    );
    await raw(
      'missing-field',
      JSON.stringify({ v: 1, verb: 'add', session: 't-bad', created: '2026-09-12T15:32:04.123Z', section: 'process', title: 'no body' }),
    );
    await raw(
      'oversize',
      JSON.stringify({ ...addObj({}), session: 't-bad', body: 'x'.repeat(2001) }),
    );
    const good2 = await writeFragment(
      repo,
      { verb: 'add', section: 'features', title: 'Good two', body: 'Feature / P2 / FILED 2026-09-12 - body.' },
      't-good2',
      { now: FIXED_NOW + 1000 },
    );

    const list = await listFragments(repo);
    assert.equal(list.pending.length, 6, 'two good + four malformed fragments on disk');
    const batch: { stem: string; fragment: string }[] = [];
    for (const stem of list.pending) {
      batch.push({ stem, fragment: await readFile(join(dir, `${stem}.json`), 'utf8') });
    }
    const res = mergeFragments(BASE, batch, scanMaxId(BASE, []), parseBacklog(BASE));

    // Every malformed fragment failed with its named error …
    const errByStem = new Map(res.failed.map((f) => [f.stem, f.error]));
    assert.deepEqual(
      [...errByStem.keys()].sort(),
      ['bad-json', 'bad-verb', 'missing-field', 'oversize'],
    );
    assert.equal(errByStem.get('bad-json'), 'bad-json');
    assert.equal(errByStem.get('bad-verb'), 'bad-verb');
    assert.equal(errByStem.get('missing-field'), 'bad-body');
    assert.equal(errByStem.get('oversize'), 'bad-body');
    // … while the batch-mates still applied with distinct sequential ids
    // (good1's stem sorts first ⇒ 224; good2 ⇒ 225).
    assert.deepEqual(res.applied, [
      { stem: good1, id: 224 },
      { stem: good2, id: 225 },
    ]);
    assert.ok(res.content.includes(`<!-- frag:${good1} -->`));
    assert.ok(res.content.includes(`<!-- frag:${good2} -->`));
    assert.ok(res.content.includes('#### [AI-224] Good one'));
    assert.ok(res.content.includes('#### [AI-225] Good two'));

    // Quarantine the failures (the drain's move) — batch-mates unaffected.
    for (const stem of errByStem.keys()) await quarantineFragment(repo, stem);
    const after = await listFragments(repo);
    assert.deepEqual(after.quarantined, ['bad-json', 'bad-verb', 'missing-field', 'oversize']);
    assert.equal(after.pending.length, 2);
  });

  it('known-bad gate 2: two add fragments in one batch get DISTINCT sequential ids (maxId+1, maxId+2) in filename order', () => {
    const res = mergeFragments(
      BASE,
      [
        { stem: 'zzz-second', fragment: JSON.stringify(addObj({ section: 'features', title: 'Second' })) },
        { stem: 'aaa-first', fragment: JSON.stringify(addObj({ section: 'bugs', title: 'First' })) },
      ],
      223,
      parseBacklog(BASE),
    );
    assert.deepEqual(res.failed, []);
    // Processed in STEM order regardless of input order — ids never collide.
    assert.deepEqual(res.applied, [
      { stem: 'aaa-first', id: 224 },
      { stem: 'zzz-second', id: 225 },
    ]);
    assert.ok(res.content.includes('#### [AI-224] First'));
    assert.ok(res.content.includes('#### [AI-225] Second'));
  });

  it('add insertion with a trailing --- separator lands before it, one blank line around (real-file shape)', () => {
    const res = mergeOne(BASE, JSON.stringify(addObj({ section: 'bugs', title: 'New bug', body: 'Bug / P2 / FILED 2026-09-12 - new.' })));
    const lines = res.content.split('\n');
    const i = lines.indexOf('#### [AI-224] New bug');
    assert.ok(i > 0);
    assert.equal(lines[i - 1], '');
    assert.equal(lines[i + 1], 'Bug / P2 / FILED 2026-09-12 - new.');
    assert.equal(lines[i + 2], '<!-- frag:s-x -->');
    assert.equal(lines[i + 3], '');
    assert.equal(lines[i + 4], '---', 'still ahead of the section separator');
    assert.equal(lines[i + 6], '## Features');
  });

  it('add insertion without a trailing --- separator ends the section cleanly', () => {
    const res = mergeOne(NO_DASH, JSON.stringify(addObj({ section: 'bugs', title: 'New bug', body: 'Bug / P2 / FILED 2026-09-12 - new.' })));
    assert.deepEqual(res.failed, []);
    const lines = res.content.split('\n');
    const i = lines.indexOf('#### [AI-224] New bug');
    assert.ok(i > 0);
    assert.equal(lines[i - 1], '');
    assert.equal(lines[i + 2], '<!-- frag:s-x -->');
    assert.equal(lines[i + 3], '');
    assert.equal(lines[i + 4], '## Features');
  });

  it('status fragment replaces the first paragraph and appends the marker; no id consumed', () => {
    const status = {
      v: 1,
      verb: 'status',
      session: 't-x',
      created: '2026-09-12T10:00:00.000Z',
      target: 'AI-216',
      status_line: 'Bug / P1 / BUILT 2026-09-12 - fixed for real.',
    };
    const res = mergeOne(BASE, JSON.stringify(status));
    assert.deepEqual(res.applied, [{ stem: 's-x', id: null }], 'status applies without minting an id');
    assert.deepEqual(res.failed, []);
    const lines = res.content.split('\n');
    const h = lines.indexOf('#### [AI-216] /stop cancels every thread');
    assert.ok(h > 0, 'heading intact');
    assert.equal(lines[h + 1], 'Bug / P1 / BUILT 2026-09-12 - fixed for real.');
    assert.equal(lines[h + 2], '<!-- frag:s-x -->');
    assert.ok(!res.content.includes('Bug / P1 / FILED 2026-09-08 - body line one.'), 'old paragraph gone');
  });

  it('unknown and ambiguous status targets fail without touching content', () => {
    const status = (target: string): string =>
      JSON.stringify({ v: 1, verb: 'status', session: 't-x', created: '2026-09-12T10:00:00.000Z', target, status_line: 'x' });
    const miss = mergeOne(BASE, status('AI-999'));
    assert.deepEqual(miss.failed, [{ stem: 's-x', error: 'unknown target' }]);
    assert.equal(miss.content, BASE);
    const amb = mergeOne(AMBIGUOUS, status('AI-216'));
    assert.deepEqual(amb.failed, [{ stem: 's-x', error: 'ambiguous target' }]);
    assert.equal(amb.content, AMBIGUOUS);
  });

  it('already-merged stem is skipped by its marker, never duplicated', () => {
    const seeded = BASE.replace(
      'Process / P2 / FILED 2026-09-08 - landed.',
      'Process / P2 / FILED 2026-09-08 - landed.\n<!-- frag:dup-1 -->',
    );
    const res = mergeFragments(
      seeded,
      [{ stem: 'dup-1', fragment: JSON.stringify(addObj({ section: 'process' })) }],
      223,
      parseBacklog(seeded),
    );
    assert.deepEqual(res.alreadyMerged, ['dup-1']);
    assert.deepEqual(res.applied, []);
    assert.deepEqual(res.failed, []);
    assert.equal(res.content, seeded, 'no duplicate entry written');
  });

  it('CRLF endings are preserved through a merge', () => {
    const crlf = BASE.replace(/\n/g, '\r\n');
    const res = mergeOne(crlf, JSON.stringify(addObj({ section: 'bugs' })));
    assert.deepEqual(res.applied, [{ stem: 's-x', id: 224 }]);
    assert.ok(res.content.includes('\r\n'));
    assert.ok(!/(?<!\r)\n/.test(res.content), 'no bare LF introduced');
  });

  it('parseBacklog models sections and first paragraphs; scanMaxId scans backlog + archive contents', () => {
    const model = parseBacklog(BASE);
    assert.deepEqual(model.sections.map((s) => s.name), ['Bugs', 'Features', 'Process']);
    assert.deepEqual(model.sections.map((s) => s.entries.length), [2, 1, 1]);
    assert.equal(model.sections[0].entries[0].id, 216);
    assert.equal(model.sections[0].entries[0].title, '/stop cancels every thread');
    assert.equal(model.sections[0].entries[0].paraEnd, model.sections[0].entries[0].paraStart);
    assert.equal(model.sections[1].entries[0].id, 222);
    assert.deepEqual(parseBacklog('no open items here').sections, []);
    assert.equal(scanMaxId(BASE, []), 223);
    assert.equal(scanMaxId(BASE, ['archived [AI-221] row', 'later [AI-235] row']), 235);
    assert.equal(scanMaxId('nothing', ['nothing']), 0);
  });

  it('writeFragment mints the exact D1 filename (determinism + session sanitization) and the schema-exact content', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-merge-'));
    const stem = await writeFragment(
      repo,
      { verb: 'add', section: 'process', title: 'T', body: 'b' },
      't-test',
      { now: FIXED_NOW, randomHex: () => 'ab12cd' },
    );
    assert.equal(stem, '20260912-153204-ab12cd-t-test');
    // Determinism: same clock + random in a fresh dir mints the same name.
    const repo2 = await mkdtemp(join(tmpdir(), 'backlog-merge-'));
    try {
      const stem2 = await writeFragment(
        repo2,
        { verb: 'add', section: 'process', title: 'T', body: 'b' },
        't-test',
        { now: FIXED_NOW, randomHex: () => 'ab12cd' },
      );
      assert.equal(stem2, stem);
    } finally {
      await rm(repo2, { recursive: true, force: true });
    }
    // Filename session label: sanitized charset, truncated to 40 chars —
    // while the JSON body keeps the raw schema-valid session.
    const long = 'a7_'.repeat(20);
    const stem3 = await writeFragment(
      repo,
      { verb: 'add', section: 'process', title: 'T', body: 'b' },
      long,
      { now: FIXED_NOW, randomHex: () => 'ab12cd' },
    );
    // First 40 chars of 'a7_'.repeat(20) = 13 full reps + a trailing 'a'.
    assert.ok(stem3.endsWith(`ab12cd-${'a7_'.repeat(13)}a`));
    assert.equal(stem3.split('-').slice(3).join('-').length, 40);
    const parsed = JSON.parse(await readFile(join(fragmentsDir(repo), `${stem}.json`), 'utf8'));
    assert.deepEqual(parsed, {
      v: 1,
      verb: 'add',
      session: 't-test',
      created: '2026-09-12T15:32:04.123Z',
      section: 'process',
      title: 'T',
      body: 'b',
    });
  });

  it('writeFragment retries an EEXIST name collision once with a fresh random suffix', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-merge-'));
    const dir = fragmentsDir(repo);
    await mkdir(dir, { recursive: true });
    // Pre-claim the exact name the first mint will produce.
    const colliding = join(dir, '20260912-153204-aaa111-t-test.json');
    await writeFile(colliding, 'pre-existing', 'utf8');
    const seq = ['aaa111', 'bbb222'];
    const stem = await writeFragment(
      repo,
      { verb: 'add', section: 'process', title: 'T', body: 'b' },
      't-test',
      { now: FIXED_NOW, randomHex: () => seq.shift()! },
    );
    assert.equal(stem, '20260912-153204-bbb222-t-test');
    assert.equal(await readFile(colliding, 'utf8'), 'pre-existing', 'never clobbers');
    assert.ok((await listFragments(repo)).pending.includes(stem));
  });

  it('writeFragment: same-second writes are unique by construction; invalid input throws its named error without touching disk', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-merge-'));
    const a = await writeFragment(repo, { verb: 'add', section: 'process', title: 'A', body: 'b' }, 't-test', { now: FIXED_NOW });
    const b = await writeFragment(repo, { verb: 'add', section: 'process', title: 'B', body: 'b' }, 't-test', { now: FIXED_NOW });
    assert.notEqual(a, b);
    assert.deepEqual((await listFragments(repo)).pending.sort(), [a, b].sort());
    await assert.rejects(
      writeFragment(repo, { verb: 'add', section: 'Bugs', title: 'T', body: 'b' }, 't-test', { now: FIXED_NOW }),
      /invalid fragment \(bad-section\)/,
    );
    assert.deepEqual((await listFragments(repo)).pending.length, 2, 'nothing written for the invalid fragment');
  });

  it('deleteFragment removes a merged fragment and tolerates an already-gone file', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-merge-'));
    const stem = await writeFragment(repo, { verb: 'add', section: 'process', title: 'T', body: 'b' }, 't-test', { now: FIXED_NOW });
    await deleteFragment(repo, stem);
    assert.deepEqual((await listFragments(repo)).pending, []);
    await deleteFragment(repo, stem, );
    assert.deepEqual((await listFragments(repo)).pending, []);
    await assert.rejects(quarantineFragment(repo, stem)); // gone is NOT ok for quarantine
  });
});
