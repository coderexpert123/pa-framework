import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'stream';
import { existsSync } from 'fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { backlogCommand, CANDIDATE_REPORT_CAVEAT } from '../src/commands/backlog.js';
import { fragmentsDir, listFragments, quarantineFragment, writeFragment } from '../src/lib/backlog-merge.js';
import type { GitRunResult } from '../src/lib/tree-drift.js';

/**
 * WP-B CLI tests (2026-09-12 brain-file-lock-contention SPEC D2; router split
 * 2026-09-18, AI-316). The repo root is INJECTED (BacklogCommandDeps.repoRootFn)
 * so nothing here ever writes into the real repo's backlog/fragments.
 * process.exit is stubbed to throw so exit codes are assertable in-process;
 * console output is captured.
 *
 * Post-split read-path contract (spec §3 E16/E17): `pending`'s candidate scan
 * and `archive` read the backlog/open-*.md section files when ≥1 exists, and
 * fall back to the monolith BACKLOG.md while none exists (the pre-migration
 * window). `migrate` is the one-time monolith → router+sections cutover.
 */

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

interface CliResult {
  logs: string[];
  errs: string[];
  exit: number | null;
}

async function runCli(args: string[], repoRoot: string): Promise<CliResult> {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(' ')); };
  process.exit = ((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as unknown as typeof process.exit;
  let exit: number | null = null;
  try {
    await backlogCommand(args, { repoRootFn: async () => repoRoot });
  } catch (err) {
    if (!(err instanceof ExitError)) throw err;
    exit = err.code;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { logs, errs, exit };
}

/** runCli with the full dep surface — migrate/archive need the lock, clock,
 *  loop-probe and gitRunner seams. */
async function runCliDeps(
  args: string[],
  deps: Parameters<typeof backlogCommand>[1],
): Promise<CliResult> {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(' ')); };
  process.exit = ((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as unknown as typeof process.exit;
  let exit: number | null = null;
  try {
    await backlogCommand(args, deps);
  } catch (err) {
    if (!(err instanceof ExitError)) throw err;
    exit = err.code;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { logs, errs, exit };
}

async function withStdin(text: string, fn: () => Promise<void>): Promise<void> {
  const orig = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', {
    value: Readable.from([Buffer.from(text, 'utf8')]),
    configurable: true,
  });
  try {
    await fn();
  } finally {
    if (orig) Object.defineProperty(process, 'stdin', orig);
  }
}

describe('pa backlog CLI', () => {
  let repo: string;

  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
    repo = '';
  });

  it('add writes a fragment with the exact D1 fields and prints the rel path', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
    const res = await runCli(
      [
        'add',
        '--section', 'Process',
        '--title', 'BACKLOG.md lock contention — fragments + drain',
        '--type', 'Process',
        '--pri', '2',
        '--body', 'filed via the CLI.',
        '--session', 't59-backlog-wpb',
      ],
      repo,
    );
    assert.equal(res.exit, null, `unexpected exit: ${res.exit} (${res.errs.join('\n')})`);
    assert.equal(res.logs.length, 1, 'exactly one stdout line');
    const out = JSON.parse(res.logs[0]) as { ok: boolean; fragment: string };
    assert.equal(out.ok, true);
    const stem = out.fragment.replace(/^backlog\/fragments\//, '').replace(/\.json$/, '');
    assert.equal(out.fragment, `backlog/fragments/${stem}.json`);
    assert.match(stem, /^\d{8}-\d{6}-[0-9a-f]{6}-t59-backlog-wpb$/, 'D1 filename shape');

    const raw = await readFile(join(fragmentsDir(repo), `${stem}.json`), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(parsed, {
      v: 1,
      verb: 'add',
      session: 't59-backlog-wpb',
      created: parsed.created,
      section: 'process', // normalized lowercase from --section Process
      title: 'BACKLOG.md lock contention — fragments + drain',
      // --type/--pri compose the archivable-shape OPEN prefix onto the body.
      body: 'Process / P2 / OPEN — filed via the CLI.',
    });
    assert.match(String(parsed.created), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'ISO created');
    assert.equal(Number.isFinite(Date.parse(String(parsed.created))), true);
  });

  it('add --body-file reads the file, strips its trailing newline, and composes the DEFAULT type/pri prefix when neither flag is given', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
    const bodyPath = join(repo, 'body.txt');
    await writeFile(bodyPath, 'from a file.\n', 'utf8');
    const res = await runCli(
      [
        'add',
        '--section', 'bugs',
        '--title', 'From file',
        '--body-file', bodyPath,
        '--session', 't-wpb',
      ],
      repo,
    );
    assert.equal(res.exit, null);
    const stem = (JSON.parse(res.logs[0]) as { fragment: string }).fragment
      .replace(/^backlog\/fragments\//, '')
      .replace(/\.json$/, '');
    const parsed = JSON.parse(
      await readFile(join(fragmentsDir(repo), `${stem}.json`), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(
      parsed.body,
      'Task / P2 / OPEN — from a file.',
      'trailing newline stripped; default type "Task" / default pri "2" prefix composed',
    );
  });

  it('add --body-file - reads the body from stdin and composes the given --type/--pri', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
    let res: CliResult | null = null;
    await withStdin('from stdin.\n', async () => {
      res = await runCli(
        [
          'add',
          '--section', 'features',
          '--title', 'From stdin',
          '--type', 'Feature',
          '--pri', '3',
          '--body-file', '-',
          '--session', 't-wpb',
        ],
        repo,
      );
    });
    assert.equal(res!.exit, null);
    const stem = (JSON.parse(res!.logs[0]) as { fragment: string }).fragment
      .replace(/^backlog\/fragments\//, '')
      .replace(/\.json$/, '');
    const parsed = JSON.parse(
      await readFile(join(fragmentsDir(repo), `${stem}.json`), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(parsed.body, 'Feature / P3 / OPEN — from stdin.');
  });

  it('add rejects a --type outside the archiver\'s Type character class (exit 2)', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
    const res = await runCli(
      ['add', '--section', 'bugs', '--title', 't', '--body', 'b', '--type', 'Bug1', '--session', 't-wpb'],
      repo,
    );
    assert.equal(res.exit, 2);
    assert.ok(res.errs.join('\n').includes('--type must be letters/spaces/hyphens'));
    assert.equal((await listFragments(repo)).pending.length, 0, 'nothing written');
  });

  it('add rejects a --pri that is not a single digit (exit 2)', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
    const res = await runCli(
      ['add', '--section', 'bugs', '--title', 't', '--body', 'b', '--pri', '10', '--session', 't-wpb'],
      repo,
    );
    assert.equal(res.exit, 2);
    assert.ok(res.errs.join('\n').includes('--pri must be a single digit 0-9'));
    assert.equal((await listFragments(repo)).pending.length, 0, 'nothing written');
  });

  it('status writes a verb=status fragment with target + status_line (no add fields)', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
    const res = await runCli(
      [
        'status',
        '--target', 'AI-216',
        '--status-line', 'Bug / P1 / BUILT 2026-09-12 - fixed for real.',
        '--session', 't-wpb',
      ],
      repo,
    );
    assert.equal(res.exit, null);
    assert.equal((JSON.parse(res.logs[0]) as { ok: boolean }).ok, true);
    const stems = (await listFragments(repo)).pending;
    assert.equal(stems.length, 1);
    const parsed = JSON.parse(
      await readFile(join(fragmentsDir(repo), `${stems[0]}.json`), 'utf8'),
    ) as Record<string, unknown>;
    assert.deepEqual(parsed, {
      v: 1,
      verb: 'status',
      session: 't-wpb',
      created: parsed.created,
      target: 'AI-216',
      status_line: 'Bug / P1 / BUILT 2026-09-12 - fixed for real.',
    });
    assert.ok(!('section' in parsed) && !('title' in parsed) && !('body' in parsed));
  });

  /**
   * The archivability preflight (2026-09-18): `status` must reject a
   * `--status-line` that claims completion in prose without matching the
   * archiver's anchored shape. Per the "a check must be able to FAIL" rule,
   * both the failing and the passing case are proven here against the REAL
   * CLI path (not a unit test of the unexported checker).
   */
  it('status rejects a --status-line that claims completion but is not archiver-shaped (KNOWN-BAD CASE — proves the check can fail)', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
    const res = await runCli(
      [
        'status',
        '--target', 'AI-216',
        '--status-line', 'Bug / P2 / RESOLVED - fixed it.',
        '--session', 't-wpb',
      ],
      repo,
    );
    assert.equal(res.exit, 2, 'RESOLVED + "fixed" claim completion but RESOLVED is not an archiver token');
    const errText = res.errs.join('\n');
    assert.ok(errText.includes('claims closure but is not in the archivable shape'));
    assert.ok(errText.includes('Bug / P2 / RESOLVED - fixed it.'), 'the line as given is echoed back');
    assert.equal((await listFragments(repo)).pending.length, 0, 'nothing written on rejection');
  });

  it('status accepts a --status-line that claims completion AND is archiver-shaped (KNOWN-GOOD CASE)', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
    const res = await runCli(
      [
        'status',
        '--target', 'AI-216',
        '--status-line', 'Bug / P2 / DONE 2026-09-18 - fixed it.',
        '--session', 't-wpb',
      ],
      repo,
    );
    assert.equal(res.exit, null, `unexpected exit: ${res.exit} (${res.errs.join('\n')})`);
    assert.equal((await listFragments(repo)).pending.length, 1);
  });

  it('status accepts a --status-line that claims nothing (OPEN/IN PROGRESS) regardless of shape', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
    const res = await runCli(
      [
        'status',
        '--target', 'AI-216',
        '--status-line', 'Bug / P2 / IN PROGRESS - still working on it.',
        '--session', 't-wpb',
      ],
      repo,
    );
    assert.equal(res.exit, null);
    assert.equal((await listFragments(repo)).pending.length, 1);
  });

  /**
   * Closed-without-doing tokens (2026-09-18, operator follow-up on AI-226:
   * "don't split" was decided 2026-09-14 but the archiver had no token for
   * "closed, not shipped", so it sat open forever). WONTFIX/DECLINED/
   * SUPERSEDED/OBSOLETE join the shipped tokens in the SAME imported
   * DONE_STATUS_LINE_RE — proven here at the `status` CLI layer (a
   * well-shaped line is accepted, a malformed one is rejected); the archive
   * TRANSFORM itself is proven separately below, since a token the regex
   * accepts but the transform ignores is the same dead outflow in a new
   * costume.
   */
  it('status accepts a well-shaped WONTFIX line (a new closed-without-doing token)', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
    const res = await runCli(
      [
        'status',
        '--target', 'AI-216',
        '--status-line', 'Feature / P3 / WONTFIX 2026-09-18 - decided against, see plans/2026-09-14-x.md.',
        '--session', 't-wpb',
      ],
      repo,
    );
    assert.equal(res.exit, null, `unexpected exit: ${res.exit} (${res.errs.join('\n')})`);
    assert.equal((await listFragments(repo)).pending.length, 1);
  });

  it('status rejects a malformed WONTFIX line — lowercase claims closure but is not archiver-shaped (KNOWN-BAD CASE)', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
    const res = await runCli(
      [
        'status',
        '--target', 'AI-216',
        '--status-line', 'Feature / P3 / wontfix - lowercase, wrong case for the archiver token.',
        '--session', 't-wpb',
      ],
      repo,
    );
    assert.equal(res.exit, 2, 'lowercase "wontfix" claims closure in prose but DONE_STATUS_LINE_RE is case-sensitive');
    assert.ok(res.errs.join('\n').includes('claims closure but is not in the archivable shape'));
    assert.equal((await listFragments(repo)).pending.length, 0, 'nothing written on rejection');
  });

  it('pending prints human lines for pending + quarantined fragments', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
    // Real producer output for the pending fragment…
    const stem = await writeFragment(
      repo,
      { verb: 'add', section: 'features', title: 'Real pending entry', body: 'Feature / P2 / body.' },
      't-wpb',
    );
    // …and a malformed fragment moved to quarantine by the REAL quarantine path.
    const badStem = 'bad-frag';
    await writeFile(join(fragmentsDir(repo), `${badStem}.json`), '{oops', 'utf8');
    await quarantineFragment(repo, badStem);

    const res = await runCli(['pending'], repo);
    assert.equal(res.exit, null);
    assert.equal(res.logs.length, 1);
    const lines = res.logs[0].split('\n');
    assert.equal(lines.length, 2);
    assert.match(
      lines[0],
      new RegExp(`^PENDING   ${stem}  add→features  "Real pending entry"  \\(t-wpb, \\d+s old\\)$`),
    );
    assert.equal(lines[1], `QUARANTINE ${badStem}  bad-json`);
  });

  it('pending --json prints the exact pending/quarantined shapes', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
    const stem = await writeFragment(
      repo,
      { verb: 'add', section: 'features', title: 'Real pending entry', body: 'Feature / P2 / body.' },
      't-wpb',
    );
    const statusStem = await writeFragment(
      repo,
      { verb: 'status', target: 'AI-216', status_line: 'Bug / P1 / BUILT 2026-09-12 - x.' },
      't-wpb',
    );
    const badStem = 'bad-frag';
    await writeFile(join(fragmentsDir(repo), `${badStem}.json`), 'not json at all', 'utf8');
    await quarantineFragment(repo, badStem);

    const res = await runCli(['pending', '--json'], repo);
    assert.equal(res.exit, null);
    const out = JSON.parse(res.logs[0]) as {
      pending: Array<Record<string, unknown>>;
      quarantined: Array<{ file: string; error: string }>;
      candidates: Array<{ id: string; title: string; line: string }>;
      candidatesNote: string;
    };
    // Both fragments may land in the same second (stem order then decided by
    // the random hex, which need not match write order) — compare SORTED.
    assert.deepEqual(
      out.pending.map((p) => p.file).sort(),
      [`backlog/fragments/${stem}.json`, `backlog/fragments/${statusStem}.json`].sort(),
      'sorted, repo-relative, forward slashes',
    );
    // Same-second stems may sort either way — select entries by verb, not index.
    const add0 = out.pending.find((p) => p.verb === 'add');
    const st1 = out.pending.find((p) => p.verb === 'status');
    assert.ok(add0 && st1, 'one add and one status entry present');
    assert.deepEqual(
      Object.keys(add0).sort(),
      ['ageMs', 'created', 'file', 'section', 'session', 'title', 'verb'],
    );
    assert.equal(add0.section, 'features');
    assert.equal(add0.title, 'Real pending entry');
    assert.equal(add0.session, 't-wpb');
    assert.equal(typeof add0.ageMs, 'number');
    assert.equal((add0.ageMs as number) >= 0, true);
    assert.equal(st1.target, 'AI-216');
    assert.ok(!('section' in st1) && !('title' in st1), 'status entries carry target, not add fields');
    assert.deepEqual(out.quarantined, [
      { file: `backlog/fragments/quarantine/${badStem}.json`, error: 'bad-json' },
    ]);
    assert.deepEqual(out.candidates, [], 'no backlog surfaces in this temp repo — nothing to report');
    assert.equal(out.candidatesNote, CANDIDATE_REPORT_CAVEAT, 'the caveat rides even an empty candidates array');
  });

  it('pending --json with zero fragments prints valid empty JSON', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
    const res = await runCli(['pending', '--json'], repo);
    assert.equal(res.exit, null);
    assert.deepEqual(JSON.parse(res.logs[0]), {
      pending: [],
      quarantined: [],
      candidates: [],
      candidatesNote: CANDIDATE_REPORT_CAVEAT,
    });
  });

  /**
   * The CANDIDATE report (2026-09-18): `pending` scans the open items on the
   * backlog surfaces and surfaces entries whose first-paragraph line contains
   * a completion/closure word in prose but does not match the archiver's
   * anchored regex — the exact class that sat invisible in the live file
   * before this fix (0 of 67 items matched despite 14 saying
   * DONE/Fixed/landed/shipped in prose).
   *
   * Post-split (AI-316, spec §3 E16): the surfaces are the backlog/open-*.md
   * section files when ≥1 exists; the monolith BACKLOG.md is the fallback
   * while no section file exists (the pre-migration window). Both fixture
   * shapes are covered below.
   *
   * Operator correction (2026-09-18, read after the first version of this
   * report shipped): of those 14 live matches, only 2 were genuinely done —
   * the other 12 were keyword false positives (a quoted UI button label
   * reading "Done", "landed" describing phase 1 of a 6-phase item still
   * open). A keyword match is NEVER evidence of completion — the report is
   * a list of CANDIDATES for a human to check, never a verdict, and the
   * output says so in words (`CANDIDATE_REPORT_CAVEAT`), not just via label
   * naming. These tests assert the caveat text is actually present, not
   * just that matching/non-matching items are separated correctly.
   */
  describe('pending CANDIDATE report (backlog surfaces read-only scan, never a verdict)', () => {
    // The candidate items' own content, split per file shape below.
    const CANDIDATE_ITEMS = [
      '#### [AI-700] Claims completion in prose but never marked archivable',
      'Bug / P2 / OPEN — already fixed manually, no automation needed.',
      '',
      '#### [AI-701] Clean open item, no completion language',
      'Bug / P1 / OPEN — implementation still pending, nothing to report yet.',
      '',
      '#### [AI-702] Properly archivable DONE item (not a candidate — the archiver sees this one)',
      'Bug / P3 / DONE 2026-09-18 - shipped and verified.',
      '',
      '#### [AI-703] Claims closure via a closed-without-doing word, wrong case/shape',
      'Bug / P2 / OPEN — operator declined this idea, wontfix, no further action.',
      '',
    ].join('\n');

    const CANDIDATE_MONOLITH = [
      '# Backlog',
      '',
      '# Open Items',
      '',
      '## Bugs',
      '',
      CANDIDATE_ITEMS,
      '# Archived items',
      '',
    ].join('\n');

    const CANDIDATE_SECTION = ['# Open Items', '', '## Bugs', '', CANDIDATE_ITEMS].join('\n');

    /** Seed a repo with the section-file layout + a monolith BACKLOG.md that
     *  ALSO carries candidates — the section files must win (the router is
     *  not a scan surface once any open-*.md exists). */
    async function seedSectionLayout(): Promise<void> {
      await mkdir(join(repo, 'backlog'), { recursive: true });
      await writeFile(join(repo, 'backlog', 'open-bugs.md'), CANDIDATE_SECTION, 'utf8');
      // A decoy monolith carrying a DIFFERENT candidate — must NOT be reported.
      await writeFile(
        join(repo, 'BACKLOG.md'),
        [
          '# Backlog',
          '',
          '# Open Items',
          '',
          '## Phantom',
          '',
          '#### [AI-999] Decoy candidate in the ignored monolith',
          'Bug / P2 / OPEN — fixed already, trust me.',
          '',
          '# Archived items',
          '',
        ].join('\n'),
        'utf8',
      );
    }

    it('human output lists the caveat once, then both section-file candidates, and excludes the clean/DONE items + the ignored monolith', async () => {
      repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
      await seedSectionLayout();
      const res = await runCli(['pending'], repo);
      assert.equal(res.exit, null);
      assert.equal(res.logs.length, 1);
      const lines = res.logs[0].split('\n');
      assert.equal(lines.length, 3, 'one caveat line + AI-700 + AI-703 -- AI-701/AI-702 correctly excluded, monolith AI-999 never scanned');
      assert.equal(lines[0], `CANDIDATES (${CANDIDATE_REPORT_CAVEAT})`, 'the caveat text is literally in the output');
      assert.match(lines[1], /^CANDIDATE AI-700 {2}"Claims completion in prose but never marked archivable" {2}keyword match, needs human check: "Bug \/ P2 \/ OPEN — already fixed manually, no automation needed\."$/);
      assert.match(lines[2], /^CANDIDATE AI-703 {2}"Claims closure via a closed-without-doing word, wrong case\/shape" {2}keyword match, needs human check: "Bug \/ P2 \/ OPEN — operator declined this idea, wontfix, no further action\."$/);
    });

    it('--json reports exactly the two section-file candidates (id/title/line shape) plus the caveat note', async () => {
      repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
      await seedSectionLayout();
      const res = await runCli(['pending', '--json'], repo);
      assert.equal(res.exit, null);
      const out = JSON.parse(res.logs[0]) as {
        pending: unknown[];
        quarantined: unknown[];
        candidates: Array<{ id: string; title: string; line: string }>;
        candidatesNote: string;
      };
      assert.deepEqual(out.pending, []);
      assert.deepEqual(out.quarantined, []);
      assert.deepEqual(out.candidates, [
        {
          id: 'AI-700',
          title: 'Claims completion in prose but never marked archivable',
          line: 'Bug / P2 / OPEN — already fixed manually, no automation needed.',
        },
        {
          id: 'AI-703',
          title: 'Claims closure via a closed-without-doing word, wrong case/shape',
          line: 'Bug / P2 / OPEN — operator declined this idea, wontfix, no further action.',
        },
      ]);
      assert.equal(out.candidatesNote, CANDIDATE_REPORT_CAVEAT);
    });

    it('monolith fallback: no section files ⇒ BACKLOG.md is still the scan surface (pre-migration window)', async () => {
      repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
      await writeFile(join(repo, 'BACKLOG.md'), CANDIDATE_MONOLITH, 'utf8');
      const res = await runCli(['pending', '--json'], repo);
      assert.equal(res.exit, null);
      const out = JSON.parse(res.logs[0]) as {
        candidates: Array<{ id: string }>;
        candidatesNote: string;
      };
      assert.deepEqual(
        out.candidates.map((c) => c.id),
        ['AI-700', 'AI-703'],
        'the monolith read path keeps working while zero open-*.md exist',
      );
      assert.equal(out.candidatesNote, CANDIDATE_REPORT_CAVEAT);
    });

    it('a repo with no backlog surfaces reports zero candidates, never an error, and still carries the caveat', async () => {
      repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
      const res = await runCli(['pending', '--json'], repo);
      assert.equal(res.exit, null);
      const out = JSON.parse(res.logs[0]) as { candidates: unknown[]; candidatesNote: string };
      assert.deepEqual(out.candidates, []);
      assert.equal(out.candidatesNote, CANDIDATE_REPORT_CAVEAT);
    });
  });

  it('unknown flag ⇒ exit 2 + usage on stderr (add and pending)', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
    const add = await runCli(['add', '--section', 'bugs', '--wat', 'x', '--session', 't-wpb'], repo);
    assert.equal(add.exit, 2);
    assert.ok(add.errs.join('\n').includes('Usage:'), 'usage on stderr');
    assert.ok(add.errs.join('\n').includes('--wat'));
    assert.equal(add.logs.length, 0);

    const pending = await runCli(['pending', '--fancy'], repo);
    assert.equal(pending.exit, 2);
    assert.ok(pending.errs.join('\n').includes('Usage: pa backlog pending [--json]'));

    const nosub = await runCli([], repo);
    assert.equal(nosub.exit, 2);
    assert.ok(nosub.errs.join('\n').includes('pa backlog add'));
  });

  it('missing required flag and impossible body source are usage errors (exit 2); an invalid fragment value is a failure (exit 1)', async () => {
    repo = await mkdtemp(join(tmpdir(), 'backlog-cli-'));
    const noTitle = await runCli(['add', '--section', 'bugs', '--body', 'b', '--session', 't-wpb'], repo);
    assert.equal(noTitle.exit, 2);
    const bothBodies = await runCli(
      ['add', '--section', 'bugs', '--title', 't', '--body', 'b', '--body-file', 'x', '--session', 't-wpb'],
      repo,
    );
    assert.equal(bothBodies.exit, 2);
    // Uppercase --section normalizes to lowercase and writes fine…
    const mixedCase = await runCli(
      ['add', '--section', 'Bugs', '--title', 't', '--body', 'b', '--session', 't-wpb'],
      repo,
    );
    assert.equal(mixedCase.exit, null);
    // …while a section that is invalid even after normalization reaches
    // writeFragment and comes back as a write failure, not a usage error.
    const invalid = await runCli(
      ['add', '--section', '1bad', '--title', 't', '--body', 'b', '--session', 't-wpb'],
      repo,
    );
    assert.equal(invalid.exit, 1);
    assert.ok(invalid.errs.join('\n').includes('invalid fragment (bad-section)'));
    assert.equal(((await listFragments(repo)).pending.length), 1, 'only the valid fragment landed');
  });
});

/**
 * The archive verb (2026-09-13; section-file surfaces 2026-09-18, AI-316):
 * DONE-class items (anchored `Type / Pri / DONE|BUILT|FIXED|COMPLETE` first
 * status line) move out of the backlog/open-*.md section files into
 * backlog/completed-<IST-date>.md — append-only, verbatim blocks. Fixture
 * mirrors the real layout's load-bearing shapes: an IN PROGRESS item carrying
 * "BUILT <date>" MID-line (the anchored match must NOT archive it), a NOT
 * VALID item, a DEFERRED item, and a frag marker line inside a moved item's
 * paragraph — spread across TWO section files so the UNION + the `files`
 * result key are exercised.
 */
describe('pa backlog archive (section-file surfaces)', () => {
  let repo: string;

  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
    repo = '';
  });

  // A UTC instant whose IST date is unambiguously 2026-09-13 (04:00Z = 09:30 IST).
  const NOW_IST_13 = Date.UTC(2026, 8, 13, 4, 0, 0);
  const ARCHIVE_REL = 'backlog/completed-2026-09-13.md';

  const SECTION_BUGS = [
    '# Open Items',
    '',
    '## Bugs',
    '',
    '#### [AI-900] Open bug stays put',
    'Bug / P1 / FILED 2026-09-12 - not done yet.',
    '',
    '#### [AI-901] Built bug moves',
    'Bug / P2 / BUILT 2026-09-10 `abc1234` - finished and verified.',
    '',
    '---',
    '',
  ].join('\n');

  const SECTION_FEATURES = [
    '# Open Items',
    '',
    '## Features',
    '',
    '#### [AI-902] In-progress feature stays',
    'Feature / P2 / IN PROGRESS (inc 1-3 BUILT 2026-09-06 — mid-line mention must NOT trigger).',
    '',
    '#### [AI-903] Deferred feature stays',
    'Feature / P3 / DEFERRED. Body: programs file.',
    '',
    '#### [AI-904] Done feature moves with a frag marker',
    'Feature / P2 / DONE 2026-09-11 - shipped.',
    '<!-- frag:20260911-000000-000001-t-wpb -->',
    '',
  ].join('\n');

  const SECTION_PROCESS = [
    '# Open Items',
    '',
    '## Process',
    '',
    '#### [AI-905] Not-valid item stays',
    'Process / P2 / NOT VALID 2026-09-10 - operator declined.',
    '',
  ].join('\n');

  /** Minimal valid router — present so the layout reads like production; the
   *  archive read path never touches it once section files exist. */
  const ROUTER = [
    '# Backlog',
    '',
    '# Open Items',
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

  const SECTION_BUGS_AFTER = [
    '# Open Items',
    '',
    '## Bugs',
    '',
    '#### [AI-900] Open bug stays put',
    'Bug / P1 / FILED 2026-09-12 - not done yet.',
    '',
    '---',
    '',
  ].join('\n');

  const SECTION_FEATURES_AFTER = [
    '# Open Items',
    '',
    '## Features',
    '',
    '#### [AI-902] In-progress feature stays',
    'Feature / P2 / IN PROGRESS (inc 1-3 BUILT 2026-09-06 — mid-line mention must NOT trigger).',
    '',
    '#### [AI-903] Deferred feature stays',
    'Feature / P3 / DEFERRED. Body: programs file.',
    '',
  ].join('\n');

  async function initRepo(): Promise<void> {
    repo = await mkdtemp(join(tmpdir(), 'backlog-archive-'));
    await mkdir(join(repo, 'backlog'), { recursive: true });
    await writeFile(join(repo, 'BACKLOG.md'), ROUTER, 'utf8');
    await writeFile(join(repo, 'backlog', 'open-bugs.md'), SECTION_BUGS, 'utf8');
    await writeFile(join(repo, 'backlog', 'open-features.md'), SECTION_FEATURES, 'utf8');
    await writeFile(join(repo, 'backlog', 'open-process.md'), SECTION_PROCESS, 'utf8');
  }

  function lockRecorder(acquireResult = true) {
    const acquires: { resource: string; agent: string; timeoutMs: number }[] = [];
    let releases = 0;
    return {
      acquires,
      get releases(): number {
        return releases;
      },
      acquire: async (resource: string, agent: string, _pid: number, timeoutMs: number) => {
        acquires.push({ resource, agent, timeoutMs });
        return acquireResult;
      },
      release: async () => {
        releases += 1;
      },
    };
  }

  it('dry-run prints what would move, writes nothing, takes no lock — and names the touched files', async () => {
    await initRepo();
    const bugsBefore = await readFile(join(repo, 'backlog', 'open-bugs.md'), 'utf8');
    const featsBefore = await readFile(join(repo, 'backlog', 'open-features.md'), 'utf8');
    const res = await runCli(['archive', '--dry-run'], repo);
    assert.equal(res.exit, null, `unexpected exit: ${res.exit} (${res.errs.join('\n')})`);
    const out = JSON.parse(res.logs[0]) as {
      dryRun: boolean;
      archived: number;
      ids: string[];
      archiveFile: string;
      files: string[];
    };
    assert.equal(out.dryRun, true);
    assert.equal(out.archived, 2, 'AI-901 (BUILT) + AI-904 (DONE) — and nothing else');
    assert.deepEqual(out.ids, ['AI-901', 'AI-904']);
    assert.match(out.archiveFile, /^backlog\/completed-\d{4}-\d{2}-\d{2}\.md$/);
    assert.deepEqual(out.files, ['backlog/open-bugs.md', 'backlog/open-features.md'],
      'the files key lists every surface that had ≥1 moved item, layout order');
    assert.equal(await readFile(join(repo, 'backlog', 'open-bugs.md'), 'utf8'), bugsBefore, 'bugs file byte-identical');
    assert.equal(await readFile(join(repo, 'backlog', 'open-features.md'), 'utf8'), featsBefore, 'features file byte-identical');
    assert.equal(existsSync(join(repo, out.archiveFile)), false, 'no archive file created');
  });

  it('dry-run with full deps takes no lock and names the deterministic IST file', async () => {
    await initRepo();
    const lock = lockRecorder(true);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try {
      await backlogCommand(['archive', '--dry-run'], {
        repoRootFn: async () => repo,
        acquireLockFn: lock.acquire,
        releaseLockFn: lock.release,
        nowFn: () => NOW_IST_13,
      });
    } finally {
      console.log = origLog;
    }
    assert.deepEqual(JSON.parse(logs[0]), {
      dryRun: true,
      archived: 2,
      ids: ['AI-901', 'AI-904'],
      archiveFile: ARCHIVE_REL,
      files: ['backlog/open-bugs.md', 'backlog/open-features.md'],
    });
    assert.equal(lock.acquires.length, 0, 'read-only pass — the git-workflow lock is never taken');
  });

  it('real run moves DONE-class items verbatim out of their OWN section files into ONE union archive section, holds + releases the lock', async () => {
    await initRepo();
    const lock = lockRecorder(true);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try {
      await backlogCommand(['archive'], {
        repoRootFn: async () => repo,
        acquireLockFn: lock.acquire,
        releaseLockFn: lock.release,
        nowFn: () => NOW_IST_13,
      });
    } finally {
      console.log = origLog;
    }
    assert.deepEqual(JSON.parse(logs[0]), {
      ok: true,
      archived: 2,
      ids: ['AI-901', 'AI-904'],
      archiveFile: ARCHIVE_REL,
      files: ['backlog/open-bugs.md', 'backlog/open-features.md'],
    });
    assert.equal(lock.acquires.length, 1);
    assert.equal(lock.acquires[0].resource, 'skill-exclusive:git-workflow');
    assert.equal(lock.acquires[0].agent, 'backlog-archive-cli');
    assert.equal(lock.acquires[0].timeoutMs, 0, 'waitMs 0 — busy is exit 1, never a wait');
    assert.equal(lock.releases, 1, 'released exactly once');

    assert.equal(await readFile(join(repo, 'backlog', 'open-bugs.md'), 'utf8'), SECTION_BUGS_AFTER);
    assert.equal(await readFile(join(repo, 'backlog', 'open-features.md'), 'utf8'), SECTION_FEATURES_AFTER);
    // The untouched surface is never rewritten (its plan was a no-op).
    assert.equal(await readFile(join(repo, 'backlog', 'open-process.md'), 'utf8'), SECTION_PROCESS);
    // The ROUTER is not an archive surface — byte-identical throughout.
    assert.equal(await readFile(join(repo, 'BACKLOG.md'), 'utf8'), ROUTER);
    const archive = await readFile(join(repo, ARCHIVE_REL), 'utf8');
    assert.equal(
      archive,
      [
        '# Backlog completed 2026-09-13',
        '',
        '## Archived 2026-09-13',
        '',
        '#### [AI-901] Built bug moves',
        'Bug / P2 / BUILT 2026-09-10 `abc1234` - finished and verified.',
        '',
        '#### [AI-904] Done feature moves with a frag marker',
        'Feature / P2 / DONE 2026-09-11 - shipped.',
        '<!-- frag:20260911-000000-000001-t-wpb -->',
        '',
      ].join('\n'),
      'ONE archive section for the UNION of moved items across the section files, layout order',
    );
  });

  it('real run with nothing DONE is a zero no-op (files untouched, lock still held+released)', async () => {
    await initRepo();
    // Pre-move everything archivable by hand: seeds the AFTER state.
    await writeFile(join(repo, 'backlog', 'open-bugs.md'), SECTION_BUGS_AFTER, 'utf8');
    await writeFile(join(repo, 'backlog', 'open-features.md'), SECTION_FEATURES_AFTER, 'utf8');
    const lock = lockRecorder(true);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try {
      await backlogCommand(['archive'], {
        repoRootFn: async () => repo,
        acquireLockFn: lock.acquire,
        releaseLockFn: lock.release,
        nowFn: () => NOW_IST_13,
      });
    } finally {
      console.log = origLog;
    }
    assert.deepEqual(JSON.parse(logs[0]), {
      ok: true,
      archived: 0,
      ids: [],
      archiveFile: ARCHIVE_REL,
      files: [],
    });
    assert.equal(await readFile(join(repo, 'backlog', 'open-bugs.md'), 'utf8'), SECTION_BUGS_AFTER);
    assert.equal(existsSync(join(repo, ARCHIVE_REL)), false, 'no empty archive file was created');
    assert.equal(lock.releases, 1);
  });

  it('second run after an archive moves zero and never rewrites the archive file', async () => {
    await initRepo();
    const deps = {
      repoRootFn: async () => repo,
      acquireLockFn: lockRecorder(true).acquire,
      releaseLockFn: lockRecorder(true).release,
      nowFn: () => NOW_IST_13,
    };
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try {
      await backlogCommand(['archive'], deps);
      const afterFirst = await readFile(join(repo, ARCHIVE_REL), 'utf8');
      const bugsAfterFirst = await readFile(join(repo, 'backlog', 'open-bugs.md'), 'utf8');
      await backlogCommand(['archive'], deps);
      assert.deepEqual(JSON.parse(logs[1]), {
        ok: true,
        archived: 0,
        ids: [],
        archiveFile: ARCHIVE_REL,
        files: [],
      });
      assert.equal(await readFile(join(repo, ARCHIVE_REL), 'utf8'), afterFirst, 'append-only');
      assert.equal(await readFile(join(repo, 'backlog', 'open-bugs.md'), 'utf8'), bugsAfterFirst);
    } finally {
      console.log = origLog;
    }
  });

  it('git-workflow busy ⇒ exit 1, nothing written', async () => {
    await initRepo();
    // Driven through the deps only — the default lock path is the REAL
    // blackboard and a test must never touch it.
    const lock = lockRecorder(false);
    const logs: string[] = [];
    const errs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExit = process.exit;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    console.error = (...a: unknown[]) => { errs.push(a.map(String).join(' ')); };
    process.exit = ((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as unknown as typeof process.exit;
    let exit: number | null = null;
    try {
      await backlogCommand(['archive'], {
        repoRootFn: async () => repo,
        acquireLockFn: lock.acquire,
        releaseLockFn: lock.release,
        nowFn: () => NOW_IST_13,
      });
    } catch (err) {
      if (!(err instanceof ExitError)) throw err;
      exit = err.code;
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exit = origExit;
    }
    assert.equal(exit, 1);
    assert.ok(errs.join('\n').includes('git-workflow lock is held'));
    assert.equal(logs.length, 0, 'no result JSON on the busy path');
    assert.equal(await readFile(join(repo, 'backlog', 'open-bugs.md'), 'utf8'), SECTION_BUGS, 'file untouched');
    assert.equal(existsSync(join(repo, ARCHIVE_REL)), false);
  });

  it('monolith fallback: zero section files ⇒ the pre-migration BACKLOG.md is still the archive surface', async () => {
    // The pre-split fixture verbatim — proves the read path works through the
    // window between code-land and `pa backlog migrate`.
    repo = await mkdtemp(join(tmpdir(), 'backlog-archive-'));
    const MONOLITH = [
      '# Backlog',
      '',
      '# Open Items',
      '',
      '## Bugs',
      '',
      '#### [AI-900] Open bug stays put',
      'Bug / P1 / FILED 2026-09-12 - not done yet.',
      '',
      '#### [AI-901] Built bug moves',
      'Bug / P2 / BUILT 2026-09-10 `abc1234` - finished and verified.',
      '',
      '# Archived items',
      '',
    ].join('\n');
    await writeFile(join(repo, 'BACKLOG.md'), MONOLITH, 'utf8');
    const lock = lockRecorder(true);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try {
      await backlogCommand(['archive'], {
        repoRootFn: async () => repo,
        acquireLockFn: lock.acquire,
        releaseLockFn: lock.release,
        nowFn: () => NOW_IST_13,
      });
    } finally {
      console.log = origLog;
    }
    assert.deepEqual(JSON.parse(logs[0]), {
      ok: true,
      archived: 1,
      ids: ['AI-901'],
      archiveFile: ARCHIVE_REL,
      files: ['BACKLOG.md'],
    });
    const backlog = await readFile(join(repo, 'BACKLOG.md'), 'utf8');
    assert.ok(!backlog.includes('[AI-901]'), 'DONE item left the monolith');
    assert.ok(backlog.includes('[AI-900]'), 'open item stayed');
    const archive = await readFile(join(repo, ARCHIVE_REL), 'utf8');
    assert.ok(archive.includes('#### [AI-901] Built bug moves'));
  });

  it('unknown flag ⇒ exit 2 + usage', async () => {
    await initRepo();
    const res = await runCli(['archive', '--wat'], repo);
    assert.equal(res.exit, 2);
    assert.ok(res.errs.join('\n').includes('Usage: pa backlog archive [--dry-run]'));
    assert.ok(res.errs.join('\n').includes('--wat'));
  });
});

/**
 * Closed-without-doing tokens actually move (2026-09-18). The regex-level
 * acceptance is proven in the "pa backlog CLI" describe block above; this
 * proves the ARCHIVE TRANSFORM itself — a token DONE_STATUS_LINE_RE accepts
 * but planBacklogArchive/appendArchiveSection ignore would be the same dead
 * outflow in a new costume, so the assertions here are against the real
 * move (dry-run ids, the rewritten section file, and the archive file's
 * "### Closed without doing" heading), never just the regex.
 */
describe('pa backlog archive — closed-without-doing tokens (section file)', () => {
  let repo: string;

  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
    repo = '';
  });

  const NOW_IST_18 = Date.UTC(2026, 8, 18, 4, 0, 0); // 09:30 IST, unambiguously 2026-09-18
  const ARCHIVE_REL = 'backlog/completed-2026-09-18.md';

  const SECTION = [
    '# Open Items',
    '',
    '## Features',
    '',
    '#### [AI-800] Shipped feature moves (control — no heading, flat as before this change)',
    'Feature / P2 / DONE 2026-09-18 - shipped and verified.',
    '',
    '#### [AI-801] Decided-against design question moves under the closed heading',
    "Process / P3 / WONTFIX 2026-09-18 - design decision, don't split (AI-226 class).",
    '',
    '#### [AI-802] Malformed lowercase wontfix stays put — precision check',
    'Bug / P2 / wontfix - lowercase, not an archiver token, must not move.',
    '',
  ].join('\n');

  async function initRepo(): Promise<void> {
    repo = await mkdtemp(join(tmpdir(), 'backlog-archive-closed-'));
    await mkdir(join(repo, 'backlog'), { recursive: true });
    await writeFile(join(repo, 'backlog', 'open-features.md'), SECTION, 'utf8');
  }

  it('dry-run picks up both the shipped AND the well-shaped WONTFIX item, never the malformed one', async () => {
    await initRepo();
    const res = await runCli(['archive', '--dry-run'], repo);
    assert.equal(res.exit, null, `unexpected exit: ${res.exit} (${res.errs.join('\n')})`);
    const out = JSON.parse(res.logs[0]) as { archived: number; ids: string[]; files: string[] };
    assert.equal(out.archived, 2);
    assert.deepEqual(out.ids, ['AI-800', 'AI-801'], 'AI-802 (malformed) is correctly excluded');
    assert.deepEqual(out.files, ['backlog/open-features.md']);
  });

  it('real run moves both, groups WONTFIX under "Closed without doing", and leaves the malformed item open', async () => {
    await initRepo();
    const lock = { acquire: async () => true, release: async () => {} };
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try {
      await backlogCommand(['archive'], {
        repoRootFn: async () => repo,
        acquireLockFn: lock.acquire,
        releaseLockFn: lock.release,
        nowFn: () => NOW_IST_18,
      });
    } finally {
      console.log = origLog;
    }
    assert.deepEqual(JSON.parse(logs[0]), {
      ok: true,
      archived: 2,
      ids: ['AI-800', 'AI-801'],
      archiveFile: ARCHIVE_REL,
      files: ['backlog/open-features.md'],
    });

    // The malformed item is the ONLY thing left open.
    const remaining = await readFile(join(repo, 'backlog', 'open-features.md'), 'utf8');
    assert.ok(remaining.includes('[AI-802] Malformed lowercase wontfix stays put'), 'malformed item still open');
    assert.ok(!remaining.includes('[AI-800]'), 'shipped item moved out');
    assert.ok(!remaining.includes('[AI-801]'), 'WONTFIX item moved out');

    // The archive file shows the shipped item flat (no heading, same shape as
    // every archive to date) and the WONTFIX item under its own heading.
    const archive = await readFile(join(repo, ARCHIVE_REL), 'utf8');
    assert.equal(
      archive,
      [
        '# Backlog completed 2026-09-18',
        '',
        '## Archived 2026-09-18',
        '',
        '#### [AI-800] Shipped feature moves (control — no heading, flat as before this change)',
        'Feature / P2 / DONE 2026-09-18 - shipped and verified.',
        '',
        '### Closed without doing (decided against, not shipped)',
        '',
        '#### [AI-801] Decided-against design question moves under the closed heading',
        "Process / P3 / WONTFIX 2026-09-18 - design decision, don't split (AI-226 class).",
        '',
      ].join('\n'),
      'shipped item flat, WONTFIX grouped under the closed-without-doing heading',
    );
  });
});

/**
 * `pa backlog migrate` — the one-time monolith → router + section-files
 * cutover (spec §6, WP-B). Every refusal is exit 1 with a named stderr line
 * BEFORE any write; the git-workflow lock is taken WITH wait (300s) and
 * released in finally; the commit goes through the injected gitRunner.
 */
describe('pa backlog migrate', () => {
  let repo: string;

  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
    repo = '';
  });

  const MONOLITH = [
    '# Backlog',
    '',
    '> IDs here are `[AI-nnn]`.',
    '',
    '# Open Items',
    '',
    '## Bugs',
    '',
    '#### [AI-100] Bug one',
    'Bug / P1 / OPEN — first.',
    '',
    '#### [AI-101] Bug two',
    'Bug / P2 / OPEN — second.',
    '',
    '## Features',
    '',
    '#### [AI-102] Feature one',
    'Feature / P2 / OPEN — feat.',
    '',
    '# Archived items',
    '',
    'Archived items live behind `backlog/completed-index.md`.',
    '',
  ].join('\n');

  /** Seed the monolith + the dist probe file pre-flight (a) requires. */
  async function initRepo(backlog: string = MONOLITH, opts: { withDist?: boolean } = {}): Promise<void> {
    repo = await mkdtemp(join(tmpdir(), 'backlog-migrate-'));
    await writeFile(join(repo, 'BACKLOG.md'), backlog, 'utf8');
    if (opts.withDist !== false) {
      await mkdir(join(repo, 'pa', 'dist', 'src', 'lib'), { recursive: true });
      await writeFile(join(repo, 'pa', 'dist', 'src', 'lib', 'backlog-layout.js'), '// built\n', 'utf8');
    }
  }

  function lockRecorder(acquireResult = true) {
    const acquires: { resource: string; agent: string; pid: number; timeoutMs: number; contextId?: string }[] = [];
    let releases = 0;
    return {
      acquires,
      get releases(): number {
        return releases;
      },
      acquire: async (
        resource: string,
        agent: string,
        pid: number,
        timeoutMs: number,
        contextId?: string,
      ) => {
        acquires.push({ resource, agent, pid, timeoutMs, contextId });
        return acquireResult;
      },
      release: async () => {
        releases += 1;
      },
    };
  }

  function gitRecorder(): {
    calls: string[][];
    runner: (repoRoot: string, args: string[]) => Promise<GitRunResult>;
  } {
    const calls: string[][] = [];
    return {
      calls,
      runner: async (_root: string, args: string[]) => {
        calls.push(args);
        const stdout = args[0] === 'rev-parse' ? 'deadbeefcafe\n' : '';
        return { stdout: Buffer.from(stdout), stderr: Buffer.from(''), code: 0 };
      },
    };
  }

  const okLoop = async () => ({ ok: true as const });

  it('refuses with exit 2 on any argument (the verb takes no flags)', async () => {
    await initRepo();
    const res = await runCliDeps(['migrate', '--dry-run'], { repoRootFn: async () => repo });
    assert.equal(res.exit, 2);
    assert.ok(res.errs.join('\n').includes('Usage: pa backlog migrate'));
  });

  it('pre-flight (a): dist layout code absent ⇒ exit 1, named refusal, nothing touched', async () => {
    await initRepo(MONOLITH, { withDist: false });
    const res = await runCliDeps(['migrate'], { repoRootFn: async () => repo });
    assert.equal(res.exit, 1);
    assert.ok(res.errs.join('\n').includes('new code not built: run the pa build first'));
    assert.equal(existsSync(join(repo, 'backlog')), false, 'no writes on refusal');
  });

  it('pre-flight (b): loop on the pre-wave build ⇒ exit 1 with the loopCheck detail', async () => {
    await initRepo();
    const res = await runCliDeps(['migrate'], {
      repoRootFn: async () => repo,
      loopCheckFn: async () => ({ ok: false, detail: 'catchup loop 999 is still on the pre-wave build — restart it first' }),
    });
    assert.equal(res.exit, 1);
    assert.ok(res.errs.join('\n').includes('catchup loop 999 is still on the pre-wave build'));
    assert.equal(existsSync(join(repo, 'backlog')), false);
  });

  it('pre-flight (c): already a router (no ## sections) ⇒ exit 1, named refusal', async () => {
    await initRepo('# Backlog\n\n# Open Items\n\nPointer.\n\n# Archived items\n');
    const res = await runCliDeps(['migrate'], { repoRootFn: async () => repo, loopCheckFn: okLoop });
    assert.equal(res.exit, 1);
    assert.ok(res.errs.join('\n').includes('nothing to migrate: BACKLOG.md has no ## sections (already a router?)'));
  });

  it('pre-flight (d): a pre-existing backlog/open-*.md ⇒ exit 1, named refusal', async () => {
    await initRepo();
    await mkdir(join(repo, 'backlog'), { recursive: true });
    await writeFile(join(repo, 'backlog', 'open-stray.md'), '# Open Items\n\n## stray\n', 'utf8');
    const res = await runCliDeps(['migrate'], { repoRootFn: async () => repo, loopCheckFn: okLoop });
    assert.equal(res.exit, 1);
    assert.ok(res.errs.join('\n').includes('backlog/open-*.md already exists — refusing rather than merging unknown content'));
  });

  it('pre-flight (e): a section heading slugifying outside the schema ⇒ exit 1 naming the heading', async () => {
    // '## 123' slugifies to '' — outside /^[a-z][a-z-]{0,30}$/.
    await initRepo('# Backlog\n\n# Open Items\n\n## 123\n\n#### [AI-1] X\nB.\n\n# Archived items\n');
    const res = await runCliDeps(['migrate'], { repoRootFn: async () => repo, loopCheckFn: okLoop });
    assert.equal(res.exit, 1);
    const errText = res.errs.join('\n');
    assert.ok(errText.includes("section heading '123' slugifies to ''"), errText);
    assert.ok(errText.includes('/^[a-z][a-z-]{0,30}$/'));
  });

  it('pre-flight (e): two headings slugifying to the same slug ⇒ exit 1 naming the collision', async () => {
    await initRepo(
      [
        '# Backlog', '', '# Open Items', '',
        '## Bug Fixes', '',
        '#### [AI-1] X', 'B.', '',
        '## bug  fixes', '',
        '#### [AI-2] Y', 'C.', '',
        '# Archived items', '',
      ].join('\n'),
    );
    const res = await runCliDeps(['migrate'], { repoRootFn: async () => repo, loopCheckFn: okLoop });
    assert.equal(res.exit, 1);
    const errText = res.errs.join('\n');
    assert.ok(errText.includes("collides with 'Bug Fixes'"), errText);
    assert.ok(errText.includes("slugifies to 'bug-fixes'"), errText);
  });

  it('git-workflow lock busy after wait ⇒ exit 1, named refusal, nothing written', async () => {
    await initRepo();
    const lock = lockRecorder(false);
    const res = await runCliDeps(['migrate'], {
      repoRootFn: async () => repo,
      loopCheckFn: okLoop,
      acquireLockFn: lock.acquire,
      releaseLockFn: lock.release,
    });
    assert.equal(res.exit, 1);
    assert.ok(res.errs.join('\n').includes('git-workflow lock held — retry'));
    assert.equal(lock.acquires.length, 1);
    assert.equal(lock.acquires[0].resource, 'skill-exclusive:git-workflow');
    assert.equal(lock.acquires[0].agent, 'backlog-migrate');
    assert.equal(lock.acquires[0].timeoutMs, 300_000, 'migrate waits (unlike the drain\'s waitMs 0)');
    assert.equal(lock.releases, 0, 'nothing acquired ⇒ nothing released');
    assert.equal(existsSync(join(repo, 'backlog')), false);
  });

  it('zero-loss abort: BACKLOG.md changed between pre-flight and the lock ⇒ exit 1, no writes', async () => {
    await initRepo();
    const lock = lockRecorder(true);
    const res = await runCliDeps(['migrate'], {
      repoRootFn: async () => repo,
      loopCheckFn: okLoop,
      // The mid-migration write, injected INSIDE the acquire seam: step 3's
      // re-verify reads a different file than pre-flight read.
      acquireLockFn: async (resource, agent, pid, timeoutMs, contextId) => {
        const ok = await lock.acquire(resource, agent, pid, timeoutMs, contextId);
        await writeFile(join(repo, 'BACKLOG.md'), MONOLITH + '\n#### [AI-103] Sneaked in\nBody.\n', 'utf8');
        return ok;
      },
      releaseLockFn: lock.release,
    });
    assert.equal(res.exit, 1);
    assert.ok(res.errs.join('\n').includes('BACKLOG.md changed mid-migration'));
    assert.equal(lock.releases, 1, 'lock released in finally even on abort');
    assert.equal(existsSync(join(repo, 'backlog')), false, 'zero-loss abort happens before any write');
  });

  it('happy path: extracts sections, composes the router, writes + commits via gitRunner, prints the result JSON', async () => {
    await initRepo();
    const lock = lockRecorder(true);
    const git = gitRecorder();
    const res = await runCliDeps(['migrate'], {
      repoRootFn: async () => repo,
      loopCheckFn: okLoop,
      acquireLockFn: lock.acquire,
      releaseLockFn: lock.release,
      gitRunner: git.runner,
    });
    assert.equal(res.exit, null, `unexpected exit: ${res.exit} (${res.errs.join('\n')})`);
    assert.equal(res.logs.length, 1);
    assert.deepEqual(JSON.parse(res.logs[0]), {
      ok: true,
      sections: [
        { section: 'Bugs', file: 'backlog/open-bugs.md', items: 2 },
        { section: 'Features', file: 'backlog/open-features.md', items: 1 },
      ],
      items: 3,
      commit: 'deadbeefcafe',
    });

    // Section files: '# Open Items' + '' + '## <name>' + verbatim body.
    assert.equal(
      await readFile(join(repo, 'backlog', 'open-bugs.md'), 'utf8'),
      [
        '# Open Items', '', '## Bugs', '',
        '#### [AI-100] Bug one', 'Bug / P1 / OPEN — first.', '',
        '#### [AI-101] Bug two', 'Bug / P2 / OPEN — second.', '',
      ].join('\n'),
    );
    assert.equal(
      await readFile(join(repo, 'backlog', 'open-features.md'), 'utf8'),
      ['# Open Items', '', '## Features', '', '#### [AI-102] Feature one', 'Feature / P2 / OPEN — feat.', ''].join('\n'),
    );

    // Router: verbatim preamble + pointer + AUTO table + verbatim archived block.
    const router = await readFile(join(repo, 'BACKLOG.md'), 'utf8');
    assert.ok(router.startsWith('# Backlog\n\n> IDs here are `[AI-nnn]`.\n\n# Open Items\n'), 'verbatim preamble slice');
    assert.ok(router.includes('Open items live in the per-section files below'), 'pointer line');
    assert.ok(router.includes('<!-- AUTO:BACKLOG-SECTIONS -->'));
    assert.ok(router.includes('| Bugs | `backlog/open-bugs.md` |'));
    assert.ok(router.includes('| Features | `backlog/open-features.md` |'));
    assert.ok(
      router.endsWith('# Archived items\n\nArchived items live behind `backlog/completed-index.md`.\n'),
      'verbatim archived block',
    );
    assert.equal(router.includes('## Bugs'), false, 'no section headings left in the router open region');

    // Commit shape: ONE add + ONE commit with the spec'd pathspec + message,
    // then rev-parse for the sha.
    assert.deepEqual(git.calls, [
      ['add', '--', 'BACKLOG.md', 'backlog/open-bugs.md', 'backlog/open-features.md'],
      [
        'commit', '-m',
        'backlog-migrate: split BACKLOG.md into router + 2 backlog/open-*.md section files (AI-316)',
        '--', 'BACKLOG.md', 'backlog/open-bugs.md', 'backlog/open-features.md',
      ],
      ['rev-parse', 'HEAD'],
    ]);
    assert.equal(lock.releases, 1, 'lock released after the commit');
  });
});
