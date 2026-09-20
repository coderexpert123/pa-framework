import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, rm, writeFile, mkdir, readFile, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { runBacklogFragmentsDrain } from '../src/lib/maintenance/jobs/backlog-fragments-drain.js';
import { writeFragment, type WriteFragmentInput } from '../src/lib/backlog-merge.js';
import { BACKLOG_SECTION_BUDGET } from '../src/lib/docs-lint.js';
import { toIST } from '../src/ist.js';
import type { MaintenanceJobContext } from '../src/lib/maintenance/types.js';

// Wall clock is "now": the drain compares snapshot mtimes against ctx.now,
// so a past frozen epoch would misread fresh files as recently-edited.
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const CTX: MaintenanceJobContext = { now: NOW, everyMs: 180_000 };

function istDate(nowMs: number): string {
  const ist = toIST(new Date(nowMs));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}

interface NotifyCall {
  subject: string;
  body: string;
  opts?: { dedupKey?: string; severity?: string };
}

function captureNotify(): {
  calls: NotifyCall[];
  fn: (s: string, b: string, o?: NotifyCall['opts']) => Promise<{ sent: boolean; suppressed: boolean }>;
} {
  const calls: NotifyCall[] = [];
  return {
    calls,
    fn: async (subject, body, opts) => {
      calls.push({ subject, body, opts });
      return { sent: true, suppressed: false };
    },
  };
}

/** Recording acquire/release pair standing in for blackboard's lock (the
 *  tests must never touch the real blackboard.json). WP-B widened both with
 *  an optional contextId — recorded here too, never asserted (the drain
 *  passes its own uuid). */
function lockRecorder(acquireResult = true) {
  const acquires: { resource: string; agent: string; pid: number; timeoutMs: number; contextId?: string }[] = [];
  const releaseCount = { n: 0 };
  return {
    acquires,
    releaseCount,
    acquire: async (resource: string, agent: string, pid: number, timeoutMs: number, contextId?: string) => {
      acquires.push({ resource, agent, pid, timeoutMs, contextId });
      return acquireResult;
    },
    release: async () => {
      releaseCount.n += 1;
    },
  };
}

function git(dir: string, args: string[]): string {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

// ---------------------------------------------------------------------------
// §11-tail fixtures (2026-09-18, AI-316): the BACKLOG.md ROUTER (preamble +
// pointer + the drain-maintained AUTO:BACKLOG-SECTIONS table + the archived
// block) and one file per `## ` section under backlog/open-<slug>.md
// (`# Open Items\n\n## <Section>\n\n<items>`). Max id across all fixtures is
// 101 so every merge assertion lands at 102+, same as the monolith suite.
// The pre-split monolith is kept as MONOLITH_BACKLOG — the pre-router-backlog
// negative-gate fixture.
// ---------------------------------------------------------------------------

const ROUTER = [
  '# Backlog',
  '',
  '# Open Items',
  '',
  'Open items live in the per-section files below — one file per `## ` section, written only by the backlog-fragments-drain job.',
  '',
  '<!-- AUTO:BACKLOG-SECTIONS -->',
  '| Bugs | `backlog/open-bugs.md` |',
  '| Features | `backlog/open-features.md` |',
  '| Process | `backlog/open-process.md` |',
  '<!-- /AUTO:BACKLOG-SECTIONS -->',
  '',
  '# Archived items',
  '',
  '#### [AI-50] Archived old',
  'Old body.',
  '',
].join('\n');

/** Same router with the Process row missing — a stale table the drain must
 *  regenerate on its next writing pass. */
const ROUTER_STALE_TABLE = ROUTER.replace('| Process | `backlog/open-process.md` |\n', '');

/** Same router without the AUTO marker pair — table regen must no-op with
 *  the 'skipped-no-markers' note. */
const ROUTER_NO_MARKERS = [
  '# Backlog',
  '',
  '# Open Items',
  '',
  'Open items live in the per-section files below — one file per `## ` section, written only by the backlog-fragments-drain job.',
  '',
  '| Bugs | `backlog/open-bugs.md` |',
  '| Features | `backlog/open-features.md` |',
  '| Process | `backlog/open-process.md` |',
  '',
  '# Archived items',
  '',
  '#### [AI-50] Archived old',
  'Old body.',
  '',
].join('\n');

const SECTION_BUGS = [
  '# Open Items',
  '',
  '## Bugs',
  '',
  '#### [AI-100] Existing bug',
  'Known body.',
  '',
  '---',
  '',
].join('\n');

const SECTION_FEATURES = [
  '# Open Items',
  '',
  '## Features',
  '',
  '#### [AI-101] Existing feature',
  'Feature body.',
  '',
].join('\n');

const SECTION_PROCESS = '# Open Items\n\n## Process\n';

/** The pre-split monolith — now ONLY the pre-router-backlog negative-gate
 *  fixture (its open region carries real `## ` sections). */
const MONOLITH_BACKLOG = [
  '# Backlog',
  '',
  '# Open Items',
  '',
  '## Bugs',
  '',
  '#### [AI-100] Existing bug',
  'Known body.',
  '',
  '---',
  '',
  '## Features',
  '',
  '#### [AI-101] Existing feature',
  'Feature body.',
  '',
  '## Process',
  '',
  '# Archived items',
  '',
  '#### [AI-50] Archived old',
  'Old body.',
  '',
].join('\n');

describe('backlog-fragments-drain (router + section-file layout, AI-316)', () => {
  let paDir: string;
  let repo: string;

  beforeEach(async () => {
    paDir = await createTempPaHome();
  });

  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
    repo = '';
    await cleanup(paDir);
  });

  /** Real temp git repo mirroring the production shape: tracked BACKLOG.md
   *  ROUTER, three backlog/open-*.md section files, an archive file feeding
   *  the max-id scan, and the D1 gitignore rule so fragments never dirty the
   *  snapshot. Overrides let negative tests seed a broken layout. */
  async function initRepo(opts: {
    router?: string;
    sections?: Record<string, string>;
    noRouter?: boolean;
  } = {}): Promise<string> {
    repo = await mkdtemp(join(tmpdir(), 'backlog-drain-repo-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'test']);
    await writeFile(join(repo, '.gitignore'), '/backlog/fragments/\n', 'utf8');
    if (!opts.noRouter) {
      await writeFile(join(repo, 'BACKLOG.md'), opts.router ?? ROUTER, 'utf8');
    }
    await mkdir(join(repo, 'backlog'), { recursive: true });
    const sections = opts.sections ?? {
      'open-bugs.md': SECTION_BUGS,
      'open-features.md': SECTION_FEATURES,
      'open-process.md': SECTION_PROCESS,
    };
    for (const [name, content] of Object.entries(sections)) {
      await writeFile(join(repo, 'backlog', name), content, 'utf8');
    }
    await writeFile(
      join(repo, 'backlog', 'archive-2026-09.md'),
      '# Archive\n\n#### [AI-90] Old archived entry\nBody.\n',
      'utf8',
    );
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    return repo;
  }

  /** Producer-shaped fragment filing: the REAL writeFragment path (WP-A),
   *  with deterministic now/randomHex so stems are assertable. */
  async function fileFragment(fields: WriteFragmentInput): Promise<string> {
    let n = 0;
    return writeFragment(repo, fields, 't59-test', {
      now: NOW,
      randomHex: () => (++n).toString(16).padStart(6, '0'),
    });
  }

  async function writeRawFragment(stem: string, content: string): Promise<void> {
    const dir = join(repo, 'backlog', 'fragments');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${stem}.json`), content, 'utf8');
  }

  const pendingPath = (stem: string): string => join(repo, 'backlog', 'fragments', `${stem}.json`);
  const quarantinePath = (stem: string): string =>
    join(repo, 'backlog', 'fragments', 'quarantine', `${stem}.json`);
  const openBugs = (r: string): Promise<string> => readFile(join(r, 'backlog', 'open-bugs.md'), 'utf8');
  const openFeatures = (r: string): Promise<string> => readFile(join(r, 'backlog', 'open-features.md'), 'utf8');
  const routerText = (r: string): Promise<string> => readFile(join(r, 'BACKLOG.md'), 'utf8');
  /** Paths the HEAD commit touched (the pathspec proof — a file never in the
   *  commit was never drain-written this pass). */
  const committedPaths = (r: string): string[] =>
    git(r, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort();

  it('no fragments ⇒ idle result, no lock acquired, no commit', async () => {
    const r = await initRepo();
    const headBefore = git(r, ['rev-parse', 'HEAD']).trim();
    const lock = lockRecorder(true);
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lock.acquire,
      releaseLockFn: lock.release,
      notifyFn: notify.fn,
    });

    assert.deepEqual(res, { touched: 0, detail: { merged: 0 } });
    assert.equal(lock.acquires.length, 0, 'idle cost is one readdir — no lock');
    assert.equal(lock.releaseCount.n, 0);
    assert.equal(git(r, ['rev-parse', 'HEAD']).trim(), headBefore);
    assert.equal(notify.calls.length, 0);
  });

  it('happy path: routes to the section file, commits with the EXACT message, deletes the fragment, router untouched (byte-compare no-op)', async () => {
    const r = await initRepo();
    const stem = await fileFragment({
      verb: 'add',
      section: 'bugs',
      title: 'Drain happy path',
      body: 'Filed via fragment, merged by the drain.',
    });
    const lock = lockRecorder(true);
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lock.acquire,
      releaseLockFn: lock.release,
      notifyFn: notify.fn,
    });

    // No routerTable key — the table was already correct, so the byte-compare
    // made the regen a no-op and no 'regenerated' note appears.
    assert.deepEqual(res, { touched: 1, detail: { merged: 1, ids: [102], quarantined: 0, mode: 'clean' } });
    assert.equal(lock.acquires.length, 1);
    assert.equal(lock.acquires[0].resource, 'skill-exclusive:git-workflow');
    assert.equal(lock.acquires[0].agent, 'backlog-drain');
    assert.equal(lock.acquires[0].timeoutMs, 0);
    assert.equal(lock.releaseCount.n, 1, 'lock released in finally');
    const message = git(r, ['log', '-1', '--format=%B']).replace(/\s+$/, '\n');
    assert.equal(message, `backlog-drain: merge 1 fragment(s) ${istDate(NOW)} — AI-102\n`);
    // The pathspec carries ONLY the routed section file — BACKLOG.md's table
    // was already correct, so the router is neither written nor committed.
    assert.deepEqual(committedPaths(r), ['backlog/open-bugs.md']);
    assert.equal(await routerText(r), ROUTER, 'router byte-identical (regen byte-compare no-op)');
    assert.equal(git(r, ['status', '--porcelain']).trim(), '', 'everything committed clean');
    assert.equal(existsSync(pendingPath(stem)), false, 'applied fragment deleted');
    const content = await openBugs(r);
    assert.ok(content.includes('#### [AI-102] Drain happy path'), 'item landed in backlog/open-bugs.md');
    assert.ok(content.includes(`<!-- frag:${stem} -->`), 'frag marker scoped to the routed file');
    assert.equal(await openFeatures(r), SECTION_FEATURES, 'unrelated section file untouched');
    assert.equal(notify.calls.length, 0, 'clean mode ⇒ no alerts');
  });

  it('KNOWN-BAD GATE 2 end-to-end: two same-batch fragments get DISTINCT sequential ids ACROSS different section files', async () => {
    const r = await initRepo();
    const stemA = await fileFragment({
      verb: 'add',
      section: 'features',
      title: 'First same-batch fragment',
      body: 'A.',
    });
    const stemB = await fileFragment({
      verb: 'add',
      section: 'process',
      title: 'Second same-batch fragment',
      body: 'B.',
    });
    assert.notEqual(stemA, stemB);
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.deepEqual(res.detail, { merged: 2, ids: [102, 103], quarantined: 0, mode: 'clean' });
    assert.ok((await openFeatures(r)).includes('#### [AI-102] First same-batch fragment'), 'first id in open-features.md');
    assert.ok(
      (await readFile(join(r, 'backlog', 'open-process.md'), 'utf8')).includes('#### [AI-103] Second same-batch fragment'),
      'second DISTINCT id in open-process.md — sequential ids are global across files',
    );
    const message = git(r, ['log', '-1', '--format=%B']).replace(/\s+$/, '\n');
    assert.equal(message, `backlog-drain: merge 2 fragment(s) ${istDate(NOW)} — AI-102, AI-103\n`);
    assert.deepEqual(committedPaths(r), ['backlog/open-features.md', 'backlog/open-process.md']);
    assert.equal(existsSync(pendingPath(stemA)), false);
    assert.equal(existsSync(pendingPath(stemB)), false);
    assert.equal(notify.calls.length, 0);
  });

  it('KNOWN-BAD GATE 1 end-to-end: malformed fragment quarantined + alerted, good fragment still merged', async () => {
    const r = await initRepo();
    const goodStem = await fileFragment({
      verb: 'add',
      section: 'bugs',
      title: 'Good fragment survives a bad sibling',
      body: 'Good.',
    });
    // A fragment the producer could never emit — a corrupt file on disk.
    const badStem = '20260913-000000-000bad-t59test';
    await writeRawFragment(badStem, '{"v": 1, "verb": "frobnicate"}');
    const headBefore = git(r, ['rev-parse', 'HEAD']).trim();
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.equal(res.detail!.merged, 1);
    assert.equal(res.detail!.quarantined, 1);
    assert.notEqual(git(r, ['rev-parse', 'HEAD']).trim(), headBefore, 'commit landed');
    assert.ok((await openBugs(r)).includes(`#### [AI-102] Good fragment survives a bad sibling`));
    assert.equal(existsSync(quarantinePath(badStem)), true, 'bad fragment moved to quarantine/');
    assert.equal(existsSync(pendingPath(badStem)), false);
    assert.equal(existsSync(pendingPath(goodStem)), false, 'good fragment deleted');
    assert.equal(notify.calls.length, 1, 'quarantine alerted');
    assert.equal(notify.calls[0].opts?.dedupKey, 'backlog-drain:quarantine');
    assert.equal(notify.calls[0].opts?.severity, 'warn');
    assert.ok(notify.calls[0].body.includes(badStem), 'alert names the stem');
    assert.ok(notify.calls[0].body.includes('bad-verb'), 'alert names the validation error');
  });

  // --- LAYOUT GATE (new, §4/§5): the named-skip reasons ---------------------

  it('pre-router monolith BACKLOG.md ⇒ skipped pre-router-backlog + warn, fragments preserved, no commit', async () => {
    const r = await initRepo({ router: MONOLITH_BACKLOG, sections: {} });
    const stem = await fileFragment({ verb: 'add', section: 'bugs', title: 'Waits for migration', body: 'Held.' });
    const headBefore = git(r, ['rev-parse', 'HEAD']).trim();
    const lock = lockRecorder(true);
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lock.acquire,
      releaseLockFn: lock.release,
      notifyFn: notify.fn,
    });

    assert.equal(res.touched, 0);
    assert.equal(res.detail!.skipped, 'pre-router-backlog');
    assert.ok(String(res.detail!.reason).includes("BACKLOG.md's open region"), 'detail names the violated rule');
    assert.equal(git(r, ['rev-parse', 'HEAD']).trim(), headBefore, 'no commit');
    assert.equal(await routerText(r), MONOLITH_BACKLOG, 'monolith untouched — never clobber');
    assert.equal(existsSync(pendingPath(stem)), true, 'fragment preserved pending — inflow is never quarantined for a layout problem');
    assert.equal(lock.acquires.length, 1, 'layout gate runs AFTER the lock (step order)');
    assert.equal(lock.releaseCount.n, 1, 'skip still releases the held lock');
    assert.equal(notify.calls.length, 1);
    assert.equal(notify.calls[0].subject, 'backlog-fragments-drain skipped: pre-router-backlog');
    assert.equal(notify.calls[0].opts?.dedupKey, 'backlog-drain:layout-pre-router-backlog');
    assert.equal(notify.calls[0].opts?.severity, 'warn');
  });

  it('a stray `## ` heading in the router open region ⇒ skipped pre-router-backlog (G4 gate shape)', async () => {
    const r = await initRepo({
      router: ROUTER.replace('<!-- AUTO:BACKLOG-SECTIONS -->', '## Phantom\n\n<!-- AUTO:BACKLOG-SECTIONS -->'),
    });
    const stem = await fileFragment({ verb: 'add', section: 'bugs', title: 'Held by stray heading', body: 'Held.' });
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.equal(res.touched, 0);
    assert.equal(res.detail!.skipped, 'pre-router-backlog', 'a stray section heading reads as the monolith case');
    assert.equal(existsSync(pendingPath(stem)), true, 'fragment preserved');
    assert.equal(notify.calls.length, 1);
    assert.equal(notify.calls[0].opts?.dedupKey, 'backlog-drain:layout-pre-router-backlog');
  });

  it('a section file with two `## ` headings ⇒ skipped backlog-layout-invalid + warn, fragments preserved', async () => {
    const r = await initRepo({
      sections: {
        'open-bugs.md': '# Open Items\n\n## Bugs\n\n#### [AI-100] X\nB.\n\n## Extra\n',
        'open-features.md': SECTION_FEATURES,
        'open-process.md': SECTION_PROCESS,
      },
    });
    const stem = await fileFragment({ verb: 'add', section: 'bugs', title: 'Held by broken file', body: 'Held.' });
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.equal(res.touched, 0);
    assert.equal(res.detail!.skipped, 'backlog-layout-invalid');
    assert.ok(String(res.detail!.reason).includes('backlog/open-bugs.md'), 'detail names the offending file');
    assert.equal(existsSync(pendingPath(stem)), true, 'fragment preserved');
    assert.equal(notify.calls.length, 1);
    assert.equal(notify.calls[0].subject, 'backlog-fragments-drain skipped: backlog-layout-invalid');
    assert.equal(notify.calls[0].opts?.dedupKey, 'backlog-drain:layout-backlog-layout-invalid');
    assert.equal(notify.calls[0].opts?.severity, 'warn');
  });

  it("a section file carrying '# Archived items' ⇒ skipped backlog-layout-invalid (router-only heading)", async () => {
    const r = await initRepo({
      sections: {
        'open-bugs.md': '# Open Items\n\n## Bugs\n\n#### [AI-100] X\nB.\n\n# Archived items\n',
        'open-features.md': SECTION_FEATURES,
        'open-process.md': SECTION_PROCESS,
      },
    });
    await fileFragment({ verb: 'add', section: 'bugs', title: 'Held by stray archive block', body: 'Held.' });
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.equal(res.touched, 0);
    assert.equal(res.detail!.skipped, 'backlog-layout-invalid');
    assert.ok(String(res.detail!.reason).includes('# Archived items'), 'detail names the violated rule');
    assert.equal(notify.calls.length, 1);
    assert.equal(notify.calls[0].opts?.dedupKey, 'backlog-drain:layout-backlog-layout-invalid');
  });

  // --- AUTO-CREATE (operator decision): schema-valid section, no file -------

  it('add --section with no file ⇒ auto-creates backlog/open-<slug>.md + router row + section-created notify', async () => {
    const r = await initRepo();
    const stem = await fileFragment({ verb: 'add', section: 'qa', title: 'New section by filing', body: 'Auto-created.' });
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.deepEqual(res, {
      touched: 2,
      detail: { merged: 1, ids: [102], quarantined: 0, mode: 'clean', created: ['qa'], routerTable: 'regenerated' },
    });
    const qa = await readFile(join(r, 'backlog', 'open-qa.md'), 'utf8');
    assert.ok(qa.startsWith('# Open Items\n\n## qa\n'), 'sectionSkeleton header, slug verbatim as the heading');
    assert.ok(qa.includes('#### [AI-102] New section by filing'), 'item landed in the created file');
    const router = await routerText(r);
    assert.ok(router.includes('| qa | `backlog/open-qa.md` |'), 'router table gained the row');
    assert.ok(
      router.indexOf('<!-- AUTO:BACKLOG-SECTIONS -->') < router.indexOf('| qa | `backlog/open-qa.md` |') &&
        router.indexOf('| qa | `backlog/open-qa.md` |') < router.indexOf('<!-- /AUTO:BACKLOG-SECTIONS -->'),
      'row sits INSIDE the marker pair',
    );
    const message = git(r, ['log', '-1', '--format=%B']).replace(/\s+$/, '\n');
    assert.equal(
      message,
      `backlog-drain: merge 1 fragment(s) ${istDate(NOW)} — AI-102, new section backlog/open-qa.md, regenerated router table\n`,
    );
    assert.deepEqual(committedPaths(r), ['BACKLOG.md', 'backlog/open-qa.md']);
    assert.equal(existsSync(pendingPath(stem)), false);
    assert.equal(notify.calls.length, 1);
    assert.equal(notify.calls[0].subject, 'backlog-fragments-drain created section file backlog/open-qa.md');
    assert.equal(notify.calls[0].opts?.dedupKey, 'backlog-drain:section-created:qa');
    assert.equal(notify.calls[0].opts?.severity, 'warn');
  });

  // --- ROUTER TABLE REGEN (operator decision) --------------------------------

  it('stale router table ⇒ regenerated + committed alongside the merge (detail.routerTable regenerated)', async () => {
    const r = await initRepo({ router: ROUTER_STALE_TABLE });
    await fileFragment({ verb: 'add', section: 'bugs', title: 'Merge with regen', body: 'Filed.' });
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.equal(res.detail!.merged, 1);
    assert.equal(res.detail!.routerTable, 'regenerated');
    const router = await routerText(r);
    assert.ok(router.includes('| Process | `backlog/open-process.md` |'), 'missing row restored');
    assert.deepEqual(committedPaths(r), ['BACKLOG.md', 'backlog/open-bugs.md'], 'router committed WITH the merge');
    const message = git(r, ['log', '-1', '--format=%B']).replace(/\s+$/, '\n');
    assert.equal(
      message,
      `backlog-drain: merge 1 fragment(s) ${istDate(NOW)} — AI-102, regenerated router table\n`,
    );
    assert.equal(notify.calls.length, 0, 'regen is not an alert condition');
  });

  it('router without AUTO markers ⇒ merge proceeds, detail.routerTable skipped-no-markers, router untouched', async () => {
    const r = await initRepo({ router: ROUTER_NO_MARKERS });
    await fileFragment({ verb: 'add', section: 'bugs', title: 'Merge sans markers', body: 'Filed.' });
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.equal(res.detail!.merged, 1);
    assert.equal(res.detail!.routerTable, 'skipped-no-markers', 'a cosmetic region never stalls a pass');
    assert.equal(await routerText(r), ROUTER_NO_MARKERS, 'router never written without markers');
    assert.deepEqual(committedPaths(r), ['backlog/open-bugs.md'], 'only the section file committed');
    assert.ok((await openBugs(r)).includes('#### [AI-102] Merge sans markers'));
    assert.equal(notify.calls.length, 0, 'no-markers is a warn-log, never an operator alert');
  });

  it('router absent entirely ⇒ merge proceeds, never creates BACKLOG.md', async () => {
    const r = await initRepo({ noRouter: true });
    await fileFragment({ verb: 'add', section: 'bugs', title: 'Merge with no router', body: 'Filed.' });

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: captureNotify().fn,
    });

    assert.equal(res.detail!.merged, 1);
    assert.equal('routerTable' in res.detail!, false, 'no regen note when there is no router');
    assert.equal(existsSync(join(r, 'BACKLOG.md')), false, 'the drain never creates BACKLOG.md');
    assert.ok((await openBugs(r)).includes('#### [AI-102] Merge with no router'));
  });

  it('dirty-fresh BACKLOG.md AND a pending regen ⇒ the WHOLE pass defers (no half-applies)', async () => {
    const r = await initRepo();
    const stem = await fileFragment({ verb: 'add', section: 'bugs', title: 'Deferred by router edit', body: 'Waits.' });
    // A human edit that BOTH dirties the router and breaks its table (dropped
    // Process row ⇒ regen pending ⇒ the deferred router check applies).
    await writeFile(join(r, 'BACKLOG.md'), ROUTER_STALE_TABLE, 'utf8');
    const headBefore = git(r, ['rev-parse', 'HEAD']).trim();
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.deepEqual(res, { touched: 0, detail: { skipped: 'backlog-recently-edited' } });
    assert.equal(git(r, ['rev-parse', 'HEAD']).trim(), headBefore, 'no commit');
    assert.equal(await routerText(r), ROUTER_STALE_TABLE, 'router edit preserved, never clobbered');
    assert.equal(await openBugs(r), SECTION_BUGS, 'section file never written — the defer is whole-pass');
    assert.equal(existsSync(pendingPath(stem)), true, 'fragment stays pending');
    assert.equal(notify.calls.length, 0);
  });

  it('dirty-fresh BACKLOG.md with an INTACT table ⇒ merge proceeds (router deferral is regen-pending ONLY)', async () => {
    const r = await initRepo();
    await fileFragment({ verb: 'add', section: 'bugs', title: 'Merge beside dirty router', body: 'Filed.' });
    // A human edit outside the marker region: the regen reproduces it
    // byte-identically, so routerWrite stays null and the deferred check
    // never engages — BACKLOG.md is NOT part of this pass's write set.
    const dirtyRouter = ROUTER.replace('written only by the backlog-fragments-drain job.', 'HAND-EDIT in flight.');
    await writeFile(join(r, 'BACKLOG.md'), dirtyRouter, 'utf8');

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: captureNotify().fn,
    });

    assert.equal(res.detail!.merged, 1, 'the merge is not deferred — the router was never going to be written');
    assert.deepEqual(committedPaths(r), ['backlog/open-bugs.md'], 'the dirty router stays OUT of the commit');
    assert.equal(await routerText(r), dirtyRouter, 'the in-flight edit is preserved, uncommitted');
    assert.ok((await openBugs(r)).includes('#### [AI-102] Merge beside dirty router'));
    // Trailing-trim only: porcelain's ' M' prefix is the uncommitted-modified
    // marker — a whole-string trim() would eat it.
    const porcelain = git(r, ['status', '--porcelain']).replace(/\s+$/, '');
    assert.equal(porcelain, ' M BACKLOG.md', 'only the pre-existing router edit remains dirty');
  });

  // --- DIRTY STATE per section file -----------------------------------------

  it('dirty + recently-edited SECTION file ⇒ skipped, file untouched, lock released', async () => {
    const r = await initRepo();
    await fileFragment({ verb: 'add', section: 'bugs', title: 'Deferred by recent edit', body: 'Waits.' });
    // Legacy hand-edit on the ROUTED file, fresh mtime.
    const dirtyContent = SECTION_BUGS.replace('Known body.', 'Known body. EDIT-IN-FLIGHT');
    await writeFile(join(r, 'backlog', 'open-bugs.md'), dirtyContent, 'utf8');
    const headBefore = git(r, ['rev-parse', 'HEAD']).trim();
    const lock = lockRecorder(true);
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lock.acquire,
      releaseLockFn: lock.release,
      notifyFn: notify.fn,
    });

    assert.deepEqual(res, { touched: 0, detail: { skipped: 'backlog-recently-edited' } });
    // §4 order: the git-workflow lock is taken (step 2) BEFORE the dirty-state
    // classification (step 4), so the defer RELEASES a held lock.
    assert.equal(lock.acquires.length, 1);
    assert.equal(lock.acquires[0].resource, 'skill-exclusive:git-workflow');
    assert.equal(lock.releaseCount.n, 1, 'defer path releases the held lock');
    assert.equal(await openBugs(r), dirtyContent, 'working-tree content untouched (never clobber)');
    assert.equal(git(r, ['rev-parse', 'HEAD']).trim(), headBefore);
    assert.equal(notify.calls.length, 0);
  });

  it('dirty + recently-edited file defers the WHOLE pass even when the fragment routes elsewhere', async () => {
    const r = await initRepo();
    await fileFragment({ verb: 'add', section: 'bugs', title: 'Routes to bugs but blocked by features', body: 'Waits.' });
    // The dirty file is NOT the routed one — the write surface is all files
    // (a status fragment could target any), so one fresh dirty defers all.
    const dirtyContent = SECTION_FEATURES.replace('Feature body.', 'Feature body. EDIT-IN-FLIGHT');
    await writeFile(join(r, 'backlog', 'open-features.md'), dirtyContent, 'utf8');
    const headBefore = git(r, ['rev-parse', 'HEAD']).trim();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: captureNotify().fn,
    });

    assert.deepEqual(res, { touched: 0, detail: { skipped: 'backlog-recently-edited' } });
    assert.equal(git(r, ['rev-parse', 'HEAD']).trim(), headBefore);
    assert.equal(await openBugs(r), SECTION_BUGS, 'routed file untouched too — whole-pass defer');
  });

  it('git-workflow busy ⇒ skipped git-workflow-held (normal skip, no release, no commit)', async () => {
    const r = await initRepo();
    const stem = await fileFragment({ verb: 'add', section: 'bugs', title: 'Waits for the lock', body: 'Waits.' });
    const headBefore = git(r, ['rev-parse', 'HEAD']).trim();
    const lock = lockRecorder(false);
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lock.acquire,
      releaseLockFn: lock.release,
      notifyFn: notify.fn,
    });

    assert.deepEqual(res, { touched: 0, detail: { skipped: 'git-workflow-held' } });
    assert.equal(lock.acquires.length, 1);
    assert.equal(lock.releaseCount.n, 0, 'nothing acquired ⇒ nothing released');
    assert.equal(git(r, ['rev-parse', 'HEAD']).trim(), headBefore);
    assert.equal(existsSync(pendingPath(stem)), true, 'fragment stays pending for the next pass');
    assert.equal(notify.calls.length, 0);
  });

  it('stale-dirty: merges ON TOP of the old dirty section file, warn-notifies, message carries the suffix', async () => {
    const r = await initRepo();
    await fileFragment({ verb: 'add', section: 'bugs', title: 'Merged onto a stale dirty file', body: 'On top.' });
    const dirtyContent = SECTION_BUGS.replace('Known body.', 'Known body. OPERATOR-HAND-EDIT');
    await writeFile(join(r, 'backlog', 'open-bugs.md'), dirtyContent, 'utf8');
    // Backdate past RECENT_MS so the pass proceeds instead of deferring.
    const old = new Date(NOW - 2 * HOUR);
    await utimes(join(r, 'backlog', 'open-bugs.md'), old, old);
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.equal(res.detail!.mode, 'stale-dirty');
    assert.equal(res.detail!.merged, 1);
    const content = await openBugs(r);
    assert.ok(content.includes('OPERATOR-HAND-EDIT'), 'pre-existing edit landed, never reverted');
    assert.ok(content.includes('#### [AI-102] Merged onto a stale dirty file'), 'fragment merged on top');
    assert.equal(git(r, ['status', '--porcelain']).trim(), '');
    const message = git(r, ['log', '-1', '--format=%B']).replace(/\s+$/, '\n');
    assert.equal(
      message,
      `backlog-drain: merge 1 fragment(s) ${istDate(NOW)} — AI-102 (includes pre-existing working-tree edits to backlog/open-bugs.md)\n`,
    );
    assert.equal(notify.calls.length, 1);
    assert.equal(notify.calls[0].opts?.dedupKey, 'backlog-drain:stale-dirty');
    assert.equal(notify.calls[0].opts?.severity, 'warn');
    assert.ok(notify.calls[0].body.includes('backlog/open-bugs.md'), 'alert names the bundled path');
  });

  it('stale-dirty NOT in the write set: the foreign dirty file still enters the commit (AI-334 — message/notify must never claim inclusion the pathspec skipped)', async () => {
    const r = await initRepo();
    // Fragment routes to FEATURES — open-bugs.md is NOT in the write set.
    await fileFragment({ verb: 'add', section: 'features', title: 'Features-only merge', body: 'Elsewhere.' });
    const dirtyContent = SECTION_BUGS.replace('Known body.', 'Known body. FOREIGN-EDIT-ELSEWHERE');
    await writeFile(join(r, 'backlog', 'open-bugs.md'), dirtyContent, 'utf8');
    const old = new Date(NOW - 2 * HOUR);
    await utimes(join(r, 'backlog', 'open-bugs.md'), old, old);
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.equal(res.detail!.mode, 'stale-dirty');
    assert.equal(res.detail!.merged, 1);
    const message = git(r, ['log', '-1', '--format=%B']);
    assert.ok(
      message.includes('includes pre-existing working-tree edits to backlog/open-bugs.md'),
      'suffix still names the bundled file',
    );
    // THE DEFECT THE SUFFIX ASSERTS AGAINST: the named file must be IN the
    // commit — its foreign content committed as-is, nothing left dirty.
    const committedBugs = git(r, ['show', 'HEAD:backlog/open-bugs.md']);
    assert.ok(committedBugs.includes('FOREIGN-EDIT-ELSEWHERE'), 'foreign edit landed in the commit');
    assert.equal(git(r, ['status', '--porcelain']).trim(), '', 'nothing left dirty behind');
    assert.equal(notify.calls.length, 1);
    assert.equal(notify.calls[0].opts?.dedupKey, 'backlog-drain:stale-dirty');
  });

  it('mid-pass clean of a stale-dirty file ⇒ restart RE-SHAPSHOTS: suffix/notify/pathspec drop it (AI-334 residue)', async () => {
    const r = await initRepo();
    await fileFragment({ verb: 'add', section: 'features', title: 'Restart reclassify probe', body: 'x' });
    const dirtyContent = SECTION_BUGS.replace('Known body.', 'Known body. FLIP-ME');
    await writeFile(join(r, 'backlog', 'open-bugs.md'), dirtyContent, 'utf8');
    const old = new Date(NOW - 2 * HOUR);
    await utimes(join(r, 'backlog', 'open-bugs.md'), old, old);
    const notify = captureNotify();
    // statFn: 4 initial baselines (open-bugs dirty ⇒ snapshot-mtime arm, no
    // call) → guard#1 call #5 differs ⇒ restart → 5 re-baselines → guard#2
    // equal ⇒ write. Inside call #5 the foreign action REVERTS open-bugs.md,
    // so the post-restart re-snapshot must drop it from staleDirty.
    let statCalls = 0;
    const statFn = async (): Promise<number> => {
      ++statCalls;
      if (statCalls === 5) git(r, ['checkout', '--', 'backlog/open-bugs.md']);
      return statCalls <= 4 ? 1000 : 2000;
    };

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
      statFn,
    });

    assert.equal(res.detail!.merged, 1);
    const message = git(r, ['log', '-1', '--format=%B']);
    assert.ok(
      !message.includes('includes pre-existing working-tree edits'),
      `suffix must not name a file the commit skips — got: ${message.trim()}`,
    );
    assert.equal(git(r, ['diff', 'HEAD~1', 'HEAD', '--', 'backlog/open-bugs.md']).trim(), '', 'open-bugs.md not in the commit');
    assert.equal(git(r, ['status', '--porcelain']).trim(), '', 'worktree clean after the pass');
    assert.equal(notify.calls.length, 0, 'no stale-dirty notify for a dropped file');
  });

  it('stale-dirty file deleted between classification and add ⇒ dropped from suffix + pathspec, add never throws (verifier 2a)', async () => {
    const r = await initRepo();
    await fileFragment({ verb: 'add', section: 'features', title: 'Deleted-mid-pass probe', body: 'x' });
    const dirtyContent = SECTION_BUGS.replace('Known body.', 'Known body. DELETE-ME');
    await writeFile(join(r, 'backlog', 'open-bugs.md'), dirtyContent, 'utf8');
    const old = new Date(NOW - 2 * HOUR);
    await utimes(join(r, 'backlog', 'open-bugs.md'), old, old);
    const notify = captureNotify();
    // Converging statFn (as the restart test): 4 initial baselines → guard#1
    // #5 differs ⇒ restart → 5 re-baselines → guard#2 equal ⇒ write. Inside
    // call #5 the foreign action DELETES open-bugs.md — the existsSync filter
    // must drop it from addPaths (an untracked-or-deleted pathspec would fail
    // the whole `git add`) and from the suffix.
    let statCalls = 0;
    const statFn = async (): Promise<number> => {
      ++statCalls;
      if (statCalls === 5) await rm(join(r, 'backlog', 'open-bugs.md'));
      return statCalls <= 4 ? 1000 : 2000;
    };

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
      statFn,
    });

    assert.equal(res.detail!.merged, 1, 'pass completes instead of throwing on the missing pathspec');
    const message = git(r, ['log', '-1', '--format=%B']);
    assert.ok(
      !message.includes('includes pre-existing working-tree edits'),
      `no "edits" claim over a deleted file — got: ${message.trim()}`,
    );
    assert.ok(git(r, ['show', 'HEAD:backlog/open-bugs.md']).includes('Known body.'), 'the deletion itself is NOT committed');
    assert.equal(notify.calls.length, 0);
  });

  // --- STATUS ROUTING across section files -----------------------------------

  it('status routes by target-scan across files: replaces the paragraph in the OWNING file only', async () => {
    const r = await initRepo();
    const stem = await fileFragment({
      verb: 'status',
      target: 'AI-101',
      status_line: 'Feature / P2 / IN PROGRESS — picked up.',
    });
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.equal(res.detail!.merged, 1);
    assert.deepEqual(res.detail!.ids, [], 'status mints no id');
    const feats = await openFeatures(r);
    assert.ok(feats.includes('Feature / P2 / IN PROGRESS — picked up.'), 'status line landed in open-features.md');
    assert.ok(feats.includes(`<!-- frag:${stem} -->`), 'marker scoped to the routed file');
    assert.equal(await openBugs(r), SECTION_BUGS, 'other files untouched');
    assert.equal(await routerText(r), ROUTER, 'router untouched');
    assert.equal(existsSync(pendingPath(stem)), false);
    assert.equal(notify.calls.length, 0);
  });

  it('status with an unknown target ⇒ quarantined + alerted, NO commit, files untouched', async () => {
    const r = await initRepo();
    const stem = await fileFragment({ verb: 'status', target: 'AI-999', status_line: 'New status line.' });
    const headBefore = git(r, ['rev-parse', 'HEAD']).trim();
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.deepEqual(res, { touched: 1, detail: { merged: 0, quarantined: 1 } });
    assert.equal(git(r, ['rev-parse', 'HEAD']).trim(), headBefore, 'nothing applied ⇒ no commit');
    assert.equal(existsSync(quarantinePath(stem)), true);
    assert.equal(existsSync(pendingPath(stem)), false);
    assert.equal(await openBugs(r), SECTION_BUGS);
    assert.equal(await openFeatures(r), SECTION_FEATURES);
    assert.equal(notify.calls.length, 1);
    assert.ok(notify.calls[0].body.includes('unknown target'), 'alert names the error');
  });

  it('status hitting the same id in TWO files ⇒ ambiguous target quarantine (layout allows it; routing refuses)', async () => {
    const r = await initRepo({
      sections: {
        'open-bugs.md': SECTION_BUGS,
        'open-features.md': SECTION_FEATURES,
        // Duplicate id AI-100 in a second file — file-level invariants don't
        // reject it, so the target-scan reads it as ambiguous.
        'open-process.md': '# Open Items\n\n## Process\n\n#### [AI-100] Duplicate id\nBody.\n',
      },
    });
    const stem = await fileFragment({ verb: 'status', target: 'AI-100', status_line: 'Bug / P2 / OPEN — retry.' });
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.deepEqual(res, { touched: 1, detail: { merged: 0, quarantined: 1 } });
    assert.equal(existsSync(quarantinePath(stem)), true);
    assert.ok(notify.calls[0].body.includes('ambiguous target'), 'alert names the routing failure');
    assert.equal(await openBugs(r), SECTION_BUGS, 'no file written');
  });

  it('crash idempotency: marker pre-seeded in the ROUTED file ⇒ alreadyMerged, stale fragment deleted, no commit', async () => {
    const r = await initRepo();
    const stem = await fileFragment({ verb: 'add', section: 'bugs', title: 'Crash-survivor entry', body: 'Survived.' });
    // Simulate the crash-after-commit window: the marker is already in the
    // committed ROUTED file but the fragment file was never deleted.
    await writeFile(
      join(r, 'backlog', 'open-bugs.md'),
      SECTION_BUGS.replace('---', `<!-- frag:${stem} -->\n\n---`),
      'utf8',
    );
    git(r, ['add', '--', 'backlog/open-bugs.md']);
    git(r, ['commit', '-q', '-m', 'simulated drain commit']);
    const headBefore = git(r, ['rev-parse', 'HEAD']).trim();
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.equal(res.detail!.merged, 0, 'skipped as alreadyMerged');
    assert.equal(res.touched, 1, 'the stale fragment was cleaned up');
    assert.equal(git(r, ['rev-parse', 'HEAD']).trim(), headBefore, 'no duplicate/empty commit');
    const content = await openBugs(r);
    assert.equal(content.split(`<!-- frag:${stem} -->`).length - 1, 1, 'no duplicate entry');
    assert.equal(content.includes('#### [AI-102]'), false, 'no re-applied entry');
    assert.equal(existsSync(pendingPath(stem)), false, 'stale fragment deleted');
    assert.equal(notify.calls.length, 0);
  });

  it('alreadyMerged is scoped to the ROUTED file: the same marker in a DIFFERENT file does not block the merge', async () => {
    const r = await initRepo();
    const stem = await fileFragment({ verb: 'add', section: 'bugs', title: 'Marker lives in features, not bugs', body: 'Merges anyway.' });
    // The frag marker exists — but only inside open-features.md. Routing
    // sends this fragment to open-bugs.md, where the marker is absent.
    await writeFile(
      join(r, 'backlog', 'open-features.md'),
      SECTION_FEATURES + `\n<!-- frag:${stem} -->\n`,
      'utf8',
    );
    git(r, ['add', '--', 'backlog/open-features.md']);
    git(r, ['commit', '-q', '-m', 'stray marker in features']);
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.equal(res.detail!.merged, 1, 'the marker only scopes to the file the fragment routed to');
    const bugs = await openBugs(r);
    assert.ok(bugs.includes('#### [AI-102] Marker lives in features, not bugs'), 'merged into open-bugs.md');
    assert.ok(bugs.includes(`<!-- frag:${stem} -->`), 'marker now in the routed file');
    assert.ok((await openFeatures(r)).includes(`<!-- frag:${stem} -->`), 'the stray marker in features is untouched');
    assert.equal(notify.calls.length, 0);
  });

  it('a write-surface file changing twice mid-pass ⇒ restart once (re-gate + re-baseline), then skip + warn (never clobber)', async () => {
    const r = await initRepo();
    const stem = await fileFragment({ verb: 'add', section: 'bugs', title: 'Midpass race loser', body: 'Lost.' });
    const headBefore = git(r, ['rev-parse', 'HEAD']).trim();
    const notify = captureNotify();
    // Every statFn call returns a NEW mtime: baseline (5 files) → guard#1
    // (1 write-set file) → re-baseline after the restart (5) → guard#2 (1)
    // = 12 calls, then the attempt≥1 branch skips.
    let statCalls = 0;
    const statFn = async (): Promise<number> => ++statCalls * 1000;

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
      statFn,
    });

    assert.deepEqual(res, { touched: 0, detail: { skipped: 'backlog-changed-mid-pass' } });
    assert.equal(statCalls, 12, '5 baselines + 1 guard + 5 re-baselines + 1 guard');
    assert.equal(git(r, ['rev-parse', 'HEAD']).trim(), headBefore, 'no commit');
    assert.equal(await openBugs(r), SECTION_BUGS, 'file never written');
    assert.equal(existsSync(pendingPath(stem)), true, 'fragment stays pending');
    assert.equal(notify.calls.length, 1);
    assert.equal(notify.calls[0].opts?.dedupKey, 'backlog-drain:midpass-change');
    assert.equal(notify.calls[0].opts?.severity, 'warn');
  });

  it('lost-update restart CONVERGES: one mid-pass change → re-discover + re-baseline → second guard clean → merge lands', async () => {
    const r = await initRepo();
    await fileFragment({ verb: 'add', section: 'bugs', title: 'Restart survivor', body: 'Landed after one restart.' });
    const notify = captureNotify();
    // Calls 1–5 (baselines) → 1000; call 6 (guard#1) → 2000 (changed ⇒
    // restart); calls 7–11 (re-baselines) → 2000; call 12 (guard#2) → 2000,
    // equal to the new baseline ⇒ proceed to write+commit.
    let statCalls = 0;
    const statFn = async (): Promise<number> => (++statCalls <= 5 ? 1000 : 2000);

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => r,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
      statFn,
    });

    assert.equal(statCalls, 12, 'same call count as the give-up path — the restart re-gates and re-baselines');
    assert.equal(res.detail!.merged, 1, 'the merge lands after exactly one restart');
    assert.ok((await openBugs(r)).includes('#### [AI-102] Restart survivor'));
    assert.equal(notify.calls.length, 0, 'a converged restart is silent');
  });

  // --- auto-archive (per-file plans, union into one archive section) ----------

  /** Over-budget SECTION fixture: AI-100 open, AI-101/AI-102 DONE-class,
   *  AI-103 an OPEN item padded past BACKLOG_SECTION_BUDGET. The pad is sized
   *  off docs-lint's per-section-file budget, never a literal — a hardcoded
   *  12,000 silently fell UNDER the 14k raise once and the "budget" test
   *  stopped measuring budget at all. Chars, not bytes — the budget measure
   *  is content.replace(/\r\n/g,'\n').length, and this LF fixture's char
   *  count IS its byte count. */
  function overBudgetSection(): string {
    const pad = 'x'.repeat(BACKLOG_SECTION_BUDGET);
    return [
      '# Open Items',
      '',
      '## Bugs',
      '',
      '#### [AI-100] Open bug stays',
      'Known body.',
      '',
      '#### [AI-101] Done bug one',
      'Bug / P2 / BUILT 2026-09-10 `abc1` - finished.',
      '',
      '#### [AI-102] Done bug two',
      'Bug / P2 / DONE 2026-09-11 - shipped.',
      '',
      '#### [AI-103] Padding open item',
      'Bug / P3 / FILED 2026-09-12 - ' + pad,
      '',
    ].join('\n');
  }

  async function seedSections(overrides: Record<string, string>): Promise<void> {
    for (const [name, content] of Object.entries(overrides)) {
      await writeFile(join(repo, 'backlog', name), content, 'utf8');
      git(repo, ['add', '--', `backlog/${name}`]);
    }
    git(repo, ['commit', '-q', '-m', 'seed']);
  }

  it('auto-archive (budget): over-budget section file, DONE items move in the SAME commit as the merge', async () => {
    await initRepo();
    await seedSections({ 'open-bugs.md': overBudgetSection() });
    const stem = await fileFragment({
      verb: 'add',
      section: 'bugs',
      title: 'Merged alongside archive',
      body: 'Filed.',
    });
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => repo,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.deepEqual(res, {
      touched: 3,
      detail: {
        merged: 1,
        ids: [104],
        quarantined: 0,
        mode: 'clean',
        archived: 2,
        archivedIds: [101, 102],
      },
    });
    const message = git(repo, ['log', '-1', '--format=%B']).replace(/\s+$/, '\n');
    assert.equal(
      message,
      `backlog-drain: merge 1 fragment(s) ${istDate(NOW)} — AI-104, archived 2 DONE item(s) to backlog/completed-${istDate(NOW)}.md\n`,
    );
    assert.deepEqual(committedPaths(repo), [`backlog/completed-${istDate(NOW)}.md`, 'backlog/open-bugs.md']);
    const bugs = await openBugs(repo);
    assert.ok(!bugs.includes('[AI-101] Done bug one'), 'DONE item 1 left the section file');
    assert.ok(!bugs.includes('[AI-102] Done bug two'), 'DONE item 2 left the section file');
    assert.ok(bugs.includes('[AI-100] Open bug stays'), 'open item untouched');
    assert.ok(bugs.includes('[AI-103] Padding open item'), 'padded OPEN item untouched');
    assert.ok(bugs.includes('#### [AI-104] Merged alongside archive'), 'merge still landed');
    const archive = await readFile(join(repo, `backlog/completed-${istDate(NOW)}.md`), 'utf8');
    assert.ok(archive.includes(`# Backlog completed ${istDate(NOW)}`));
    assert.ok(archive.includes(`## Archived ${istDate(NOW)}`));
    assert.ok(
      archive.includes('#### [AI-101] Done bug one\nBug / P2 / BUILT 2026-09-10 `abc1` - finished.'),
      'verbatim block preserved',
    );
    assert.equal(await routerText(repo), ROUTER, 'router untouched by the archive');
    assert.equal(git(repo, ['status', '--porcelain']).trim(), '', 'both paths committed clean');
    assert.equal(existsSync(pendingPath(stem)), false, 'fragment deleted after the combined commit');
    assert.equal(notify.calls.length, 0);
  });

  it('auto-archive (budget, pre-archive measure): a file over budget ONLY because of its DONE items still archives', async () => {
    // The 2026-09-14 dead arm: the drain passed the POST-archive content to
    // shouldAutoArchive's budget measure, so a file whose overage was exactly
    // the movable DONE items read under-budget post-archive and NEVER
    // archived — the arm fired only when archiving could not fix the budget.
    // This fixture's open content is small; the DONE items themselves carry
    // the file over BACKLOG_SECTION_BUDGET (post-archive lands under).
    // Pre-fix this fails: archivePlan stays null, nothing is written.
    await initRepo();
    const fatBody = 'y'.repeat(Math.ceil(BACKLOG_SECTION_BUDGET / 3));
    await seedSections({
      'open-bugs.md': [
        '# Open Items',
        '',
        '## Bugs',
        '',
        '#### [AI-100] Open bug stays',
        'Known body.',
        '',
        '#### [AI-101] Done bug one',
        'Bug / P2 / DONE 2026-09-10 - ' + fatBody,
        '',
        '#### [AI-102] Done bug two',
        'Bug / P2 / DONE 2026-09-11 - ' + fatBody,
        '',
        '#### [AI-103] Done bug three',
        'Bug / P2 / DONE 2026-09-12 - ' + fatBody,
        '',
      ].join('\n'),
    });
    const stem = await fileFragment({
      verb: 'add',
      section: 'bugs',
      title: 'Merged alongside archive',
      body: 'Filed.',
    });

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => repo,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: captureNotify().fn,
    });

    assert.equal((res.detail as { archived?: number }).archived, 3,
      'the budget arm must measure the pre-archive file — DONE items carrying the file over budget DO archive');
    const bugs = await openBugs(repo);
    assert.ok(!bugs.includes('[AI-101]'), 'DONE items left the section file');
    assert.ok(bugs.includes('[AI-100] Open bug stays'), 'open item untouched');
    assert.ok(bugs.includes('#### [AI-104] Merged alongside archive'), 'merge landed in the same commit');
    const archive = await readFile(join(repo, `backlog/completed-${istDate(NOW)}.md`), 'utf8');
    assert.ok(archive.includes('#### [AI-101] Done bug one'), 'verbatim block preserved');
    assert.equal(existsSync(pendingPath(stem)), false, 'fragment deleted after the combined commit');
  });

  it('auto-archive (threshold): 10 DONE items ACROSS TWO section files archive into ONE union archive section, WONTFIX under the closed heading', async () => {
    await initRepo();
    const bugLines = ['# Open Items', '', '## Bugs', '',
      '#### [AI-100] Open bug stays', 'Known body.', ''];
    for (let id = 101; id <= 106; id++) {
      bugLines.push(`#### [AI-${id}] Done bug ${id}`, 'Bug / P2 / BUILT 2026-09-10 - done.', '');
    }
    const featLines = ['# Open Items', '', '## Features', ''];
    for (let id = 107; id <= 109; id++) {
      featLines.push(`#### [AI-${id}] Done feature ${id}`, 'Feature / P2 / DONE 2026-09-10 - done.', '');
    }
    featLines.push('#### [AI-110] Decided-against feature', 'Feature / P3 / WONTFIX 2026-09-11 - decided against.', '');
    await seedSections({
      'open-bugs.md': bugLines.join('\n'),
      'open-features.md': featLines.join('\n'),
    });
    await fileFragment({ verb: 'add', section: 'features', title: 'Tenth trigger', body: 'Filed.' });

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => repo,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: captureNotify().fn,
    });

    assert.equal((res.detail as { archived: number }).archived, 10, 'Σ moved across files meets the threshold');
    assert.deepEqual(
      (res.detail as { archivedIds: number[] }).archivedIds,
      [101, 102, 103, 104, 105, 106, 107, 108, 109, 110],
      'union in layout order (bugs then features)',
    );
    const bugs = await openBugs(repo);
    assert.ok(bugs.includes('[AI-100] Open bug stays'));
    assert.ok(!bugs.includes('Done bug 105'), 'all six moved out of bugs');
    const feats = await openFeatures(repo);
    assert.ok(!feats.includes('Done feature 107'), 'all four moved out of features');
    const archive = await readFile(join(repo, `backlog/completed-${istDate(NOW)}.md`), 'utf8');
    assert.ok(archive.includes('[AI-106] Done bug 106'), 'bugs items in the union archive');
    assert.ok(archive.includes('[AI-109] Done feature 109'), 'features items in the union archive');
    assert.ok(archive.includes('### Closed without doing'), 'closed-without-doing group heading present');
    assert.ok(
      archive.indexOf('### Closed without doing') < archive.indexOf('#### [AI-110] Decided-against feature'),
      'WONTFIX item renders under the closed heading',
    );
    const message = git(repo, ['log', '-1', '--format=%B']).replace(/\s+$/, '\n');
    assert.match(message, /archived 10 DONE item\(s\)/);
    assert.deepEqual(
      committedPaths(repo),
      [`backlog/completed-${istDate(NOW)}.md`, 'backlog/open-bugs.md', 'backlog/open-features.md'],
      'ONE archive file + both touched section files',
    );
  });

  it('under budget with one DONE item ⇒ NO auto-archive (exact old shapes preserved)', async () => {
    await initRepo();
    await seedSections({
      'open-bugs.md': [
        '# Open Items', '', '## Bugs', '',
        '#### [AI-100] Open bug stays', 'Known body.', '',
        '#### [AI-101] Done bug below trigger', 'Bug / P2 / BUILT 2026-09-10 - done.', '',
      ].join('\n'),
    });
    const stem = await fileFragment({ verb: 'add', section: 'bugs', title: 'Plain merge', body: 'Filed.' });
    const notify = captureNotify();
    const headBefore = git(repo, ['rev-parse', 'HEAD']).trim();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => repo,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    // The exact pre-archive detail shape — no archived keys when it did not fire.
    assert.deepEqual(res, { touched: 1, detail: { merged: 1, ids: [102], quarantined: 0, mode: 'clean' } });
    const message = git(repo, ['log', '-1', '--format=%B']).replace(/\s+$/, '\n');
    assert.equal(message, `backlog-drain: merge 1 fragment(s) ${istDate(NOW)} — AI-102\n`);
    assert.equal(existsSync(join(repo, 'backlog', `completed-${istDate(NOW)}.md`)), false, 'no archive file');
    const bugs = await openBugs(repo);
    assert.ok(bugs.includes('[AI-101] Done bug below trigger'), 'lone DONE item stays');
    assert.notEqual(git(repo, ['rev-parse', 'HEAD']).trim(), headBefore);
    assert.equal(existsSync(pendingPath(stem)), false);
    assert.equal(notify.calls.length, 0);
  });

  it('archived items never return: a status fragment targeting an archived id quarantines as unknown target', async () => {
    await initRepo();
    // open-features' shared fixture ALSO carries AI-101 ('Existing feature') —
    // with per-file routing that is a real second id occurrence, so this test
    // seeds a non-colliding id to keep AI-101 = the archived item only.
    await seedSections({
      'open-bugs.md': overBudgetSection(),
      'open-features.md': '# Open Items\n\n## Features\n\n#### [AI-111] Existing feature\nFeature body.\n',
    });
    await fileFragment({ verb: 'add', section: 'bugs', title: 'Pass one', body: 'Filed.' });
    const notify1 = captureNotify();
    await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => repo,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify1.fn,
    });
    const archive = await readFile(join(repo, `backlog/completed-${istDate(NOW)}.md`), 'utf8');
    assert.ok(archive.includes('[AI-101] Done bug one'));

    // Pass two: a status fragment reaches for an ARCHIVED id. The target-scan
    // reads only the section files' open items — the archive file is not an
    // input — so the target reads as unknown, quarantines + alerts; the item
    // never resurrects. (Direct writeFragment with a DISTINCT timestamp:
    // fileFragment's deterministic stem would collide with pass one's marker
    // and skip as alreadyMerged.)
    const statusStem = await writeFragment(
      repo,
      { verb: 'status', target: 'AI-101', status_line: 'Bug / P2 / BUILT 2026-09-12 - resurrect attempt.' },
      't59-test',
      { now: NOW + 60_000, randomHex: () => '000abc' },
    );
    const notify2 = captureNotify();
    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => repo,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify2.fn,
    });

    assert.equal(res.detail!.merged, 0);
    assert.equal(res.detail!.quarantined, 1);
    assert.equal(existsSync(quarantinePath(statusStem)), true);
    assert.ok(notify2.calls[0].body.includes('unknown target'));
    const bugs = await openBugs(repo);
    assert.ok(!bugs.includes('[AI-101]'), 'still absent from the section file');
    assert.ok(!bugs.includes('resurrect attempt'));
    assert.ok(!(await openFeatures(repo)).includes('resurrect attempt'), 'no other file took the status');
    assert.equal(
      await readFile(join(repo, `backlog/completed-${istDate(NOW)}.md`), 'utf8'),
      archive,
      'archive file untouched',
    );
  });

  it('archive-only pass: quarantined-only batch with an over-budget file still archives (no merge commit)', async () => {
    await initRepo();
    await seedSections({ 'open-bugs.md': overBudgetSection() });
    // The only fragment is one the producer could never emit — applied stays
    // empty, the quarantine alert fires, and the auto-archive still runs.
    const badStem = '20260913-000000-000bad-t59test';
    await writeRawFragment(badStem, '{"v": 1, "verb": "frobnicate"}');
    const headBefore = git(repo, ['rev-parse', 'HEAD']).trim();
    const notify = captureNotify();

    const res = await runBacklogFragmentsDrain(CTX, {
      repoRootFn: async () => repo,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      notifyFn: notify.fn,
    });

    assert.deepEqual(res, {
      touched: 3,
      detail: {
        merged: 0,
        ids: [],
        quarantined: 1,
        mode: 'clean',
        archived: 2,
        archivedIds: [101, 102],
      },
    });
    const message = git(repo, ['log', '-1', '--format=%B']).replace(/\s+$/, '\n');
    assert.equal(
      message,
      `backlog-drain: archive 2 DONE item(s) ${istDate(NOW)} — AI-101, AI-102\n`,
    );
    assert.deepEqual(committedPaths(repo), [`backlog/completed-${istDate(NOW)}.md`, 'backlog/open-bugs.md']);
    assert.notEqual(git(repo, ['rev-parse', 'HEAD']).trim(), headBefore, 'archive commit landed');
    assert.equal(existsSync(quarantinePath(badStem)), true);
    assert.equal(notify.calls.length, 1, 'quarantine alert still sent alongside the archive');
    assert.equal(notify.calls[0].opts?.dedupKey, 'backlog-drain:quarantine');
  });
});
