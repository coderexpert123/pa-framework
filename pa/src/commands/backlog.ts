import { mkdir, readFile } from 'fs/promises';
import { existsSync, readdirSync, statSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import {
  listFragments,
  mergeFragments,
  parseBacklog,
  writeFragment,
  type WriteFragmentInput,
} from '../lib/backlog-merge.js';
import {
  appendArchiveSection,
  completedArchiveRelPath,
  DONE_STATUS_LINE_RE,
  istDateOf,
  planBacklogArchive,
} from '../lib/backlog-archive.js';
import { writeFileAtomic } from '../lib/atomic-write.js';
import { blackboard } from '../blackboard.js';
import { exclusiveLockKey } from './run.js';
import { repoRootFromModule } from '../lib/git-root.js';
import { defaultGitRunner, type GitRunner } from '../lib/tree-drift.js';
import { paHome } from '../paths.js';
import {
  discoverLayout, renderSectionTable, sectionFileRel, sectionSkeleton,
  slugifySection, spliceSectionTable, validateLayout, type SectionFile,
} from '../lib/backlog-layout.js';

/**
 * `pa backlog` — the filing surface for backlog open items (2026-09-12,
 * plans/2026-09-12-brain-file-lock-contention-SPEC.md D2; WP-B).
 *
 * Threads NEVER hand-edit the backlog/open-*.md section files: `add`/`status`
 * write a private JSON fragment under gitignored `backlog/fragments/` via
 * backlog-merge's writeFragment (unique name by construction, validated
 * before it touches disk, atomic write — the drain never sees a torn
 * fragment), and the backlog-fragments-drain job merges them into the
 * backlog/open-*.md section files. `add`/`status` never read or write the
 * section files themselves; `pending` reads them read-only (2026-09-18) for
 * the CANDIDATE report below — it never writes them.
 *
 * `archive` is the ONE sanctioned exception (2026-09-13): the DONE-item
 * outflow the section files otherwise never had. It moves every archivable
 * item — status line `Type / Pri / DONE|BUILT|FIXED|COMPLETED|COMPLETE`
 * (shipped: the work happened) or, since 2026-09-18,
 * `WONTFIX|DECLINED|SUPERSEDED|OBSOLETE` (closed without doing: the question
 * was decided against — see lib/backlog-archive.ts) — out of the
 * backlog/open-*.md section files into the day's
 * `backlog/completed-<IST-date>.md` under a `## Archived <date>` heading,
 * with closed-without-doing items grouped under their own sub-heading so a
 * reader can tell the two apart. Append-only, verbatim blocks, the archive
 * IS the record. It takes the git-workflow exclusive lock (waitMs 0 — the
 * drain mid-pass ⇒ exit 1, retry) and writes files only; committing goes
 * through the normal commit flow, which picks up the changed section files +
 * the archive file together. `--dry-run` prints what would move and touches
 * nothing (not even the lock).
 *
 * `pending` is the dedup surface: run it before filing to see unmerged
 * fragments (a few minutes' numbering lag until the drain runs is the
 * accepted tradeoff). It also reports CANDIDATES read-only (2026-09-18):
 * open items across the backlog/open-*.md section files (the pre-migration
 * monolith BACKLOG.md read path stands until `migrate` runs) whose body
 * contains a completion/closure word in
 * prose but whose status line does not match `DONE_STATUS_LINE_RE`, so the
 * archiver can never see them. A keyword match is NEVER treated as evidence
 * of completion here (measured: 12 of 14 live matches were false positives)
 * — the report is explicitly framed as candidates for a human to check, not
 * a verdict; see `CANDIDATE_REPORT_CAVEAT`.
 *
 * The archivable-shape contract (2026-09-18, AI backlog-archiver-outflow fix):
 * `add`'s `--type`/`--pri` flags (default `Task`/`P2`) compose the fragment
 * body as `<Type> / P<pri> / OPEN — <body>` — the exact shape
 * `lib/backlog-archive.ts`'s `DONE_STATUS_LINE_RE` anchors on, just with an
 * OPEN status instead of a DONE-class one. Every item filed this way is one
 * `pa backlog status --status-line "<Type> / P<pri> / DONE ..."` call away
 * from archivable. `status` rejects (usage error, exit 2) a `--status-line`
 * that claims closure in prose (DONE, FIXED, RESOLVED, COMPLETE(D), BUILT,
 * SHIPPED, LANDED, WONTFIX, DECLINED, SUPERSEDED, OBSOLETE, any case) without
 * matching that anchored shape — the regex is imported from
 * backlog-archive.ts, never re-declared, so mover and preflight can't drift
 * apart.
 *
 * Shape follows commands/brain-sweep.ts: ONE JSON object on stdout for the
 * write verbs, usage + exit 2 on unknown flags, exit 1 on failure.
 */

const USAGE = [
  'Usage:',
  '  pa backlog add --section <bugs|features|process> --title "<t>" (--body "<text>" | --body-file <path>) --session <label>',
  '                 [--type <Type>] [--pri <0-9>]',
  '      body is stored as "<Type> / P<pri> / OPEN -- <body>" (default type "Task", default pri "2") --',
  '      the archivable shape lib/backlog-archive.ts matches once a later `status` call marks it',
  '      DONE|BUILT|FIXED|COMPLETED|COMPLETE (shipped) or WONTFIX|DECLINED|SUPERSEDED|OBSOLETE (closed).',
  '  pa backlog status --target <AI-nnn> --status-line "<full replacement paragraph>" --session <label>',
  '      rejected if --status-line claims closure in prose without matching that archivable shape.',
  '  pa backlog pending [--json]    List unmerged fragments + open items that claim closure but are not archivable',
  '      (candidates for a human to check, never a verdict -- see CANDIDATE_REPORT_CAVEAT)',
  '  pa backlog archive [--dry-run]    Move archivable items out of the backlog/open-*.md section files into backlog/completed-<date>.md',
  '  pa backlog migrate    One-time cutover: split monolith BACKLOG.md into the router + backlog/open-*.md section files (§6 of the wave spec; idempotently refuses when already migrated)',
].join('\n');

/** Test seam: inject the repo-root resolution (never write into the real repo). */
export interface BacklogCommandDeps {
  repoRootFn?: () => Promise<string>;
  /** archive/migrate seams: the git-workflow lock (recording fakes in tests)
   *  and a frozen clock for the IST archive-file date. migrate passes a
   *  contextId (blackboard's optional 5th/3rd params) so the wait-and-release
   *  pair pins the same lock row. */
  acquireLockFn?: (
    resource: string,
    agent: string,
    pid: number,
    timeoutMs: number,
    contextId?: string,
  ) => Promise<boolean>;
  releaseLockFn?: (resource: string, agent: string, contextId?: string) => Promise<void>;
  nowFn?: () => number;
  /** migrate seams: git commits via injectable runner; the loop-restart
   *  probe is injectable so tests never touch a real PID. */
  gitRunner?: GitRunner;
  loopCheckFn?: () => Promise<{ ok: true } | { ok: false; detail: string }>;
}

/** The lock agent recorded on the git-workflow lock row by the archive verb. */
const ARCHIVE_LOCK_AGENT = 'backlog-archive-cli';

class UsageError extends Error {}

interface FlagValues {
  [flag: string]: string | undefined;
}

/** Known flags per verb — anything else is a usage error (spec D2: unknown
 *  flag ⇒ exit 2 + usage), not a silently-ignored token. */
const KNOWN_FLAGS: Record<'add' | 'status', Set<string>> = {
  add: new Set(['--section', '--title', '--body', '--body-file', '--session', '--type', '--pri']),
  status: new Set(['--target', '--status-line', '--session']),
};

/** Sensible defaults when `add` is filed without `--type`/`--pri` (documented
 *  in USAGE + the module docstring above) — a generic type and the priority
 *  most existing BACKLOG.md items already carry (measured 2026-09-18: 4 of 6
 *  status-line-shaped items are P2). */
const DEFAULT_TYPE = 'Task';
const DEFAULT_PRI = '2';

/** Same character class as the Type component of `DONE_STATUS_LINE_RE`
 *  (`[A-Za-z][A-Za-z -]*`) — a `--type` outside this shape would compose a
 *  body the archiver can never anchor on, silently breaking the "one status
 *  call away from archivable" guarantee for that item. */
const TYPE_RE = /^[A-Za-z][A-Za-z -]*$/;

/** `DONE_STATUS_LINE_RE` requires exactly one digit after `P` — reject
 *  anything else at filing time rather than composing an unarchivable body. */
const PRI_RE = /^[0-9]$/;

/** Resolve + validate `--type`/`--pri`, falling back to the documented
 *  defaults. Throws UsageError (exit 2) on a value that would never match
 *  the archiver's anchored regex, since that's a mistake in what the caller
 *  typed, not a write failure. */
function resolveTypeAndPri(flags: FlagValues): { type: string; pri: string } {
  const type = flags['--type'] ?? DEFAULT_TYPE;
  const pri = flags['--pri'] ?? DEFAULT_PRI;
  if (!TYPE_RE.test(type)) {
    throw new UsageError(
      `--type must be letters/spaces/hyphens starting with a letter (e.g. "Bug" or "Process-infra"). Got: "${type}"`,
    );
  }
  if (!PRI_RE.test(pri)) {
    throw new UsageError(`--pri must be a single digit 0-9 (the archiver matches "P<digit>"). Got: "${pri}"`);
  }
  return { type, pri };
}

/** Words that read as "this is closed" in ordinary prose — a broader set
 *  than the archiver's own token vocabulary (RESOLVED/SHIPPED/LANDED read as
 *  done to a human but are not archiver tokens; case is not enforced here
 *  the way it is in DONE_STATUS_LINE_RE, so a lowercase or mis-cased archiver
 *  token also trips this). Case-insensitive, word-bounded scan of the WHOLE
 *  line — not anchored, since prose can put the claim anywhere. Covers both
 *  archiver classes (shipped AND closed-without-doing) since both read as
 *  "this is no longer open work" to a human. */
const COMPLETION_CLAIM_RE =
  /\b(?:DONE|FIXED|RESOLVED|COMPLETE|COMPLETED|BUILT|SHIPPED|LANDED|WONTFIX|DECLINED|SUPERSEDED|OBSOLETE)\b/i;

/** null when `--status-line` is fine; otherwise the rejection message
 *  (required shape + the line as given). A line that claims closure in
 *  prose but doesn't match the archiver's anchored regex would sit open
 *  forever — the exact class `pa backlog pending`'s candidate report
 *  surfaces read-only for lines that are ALREADY in BACKLOG.md; this refuses
 *  a new one before it's ever filed. A line that doesn't claim closure at
 *  all (OPEN, IN PROGRESS, DEFERRED, ...) is never touched by this check. */
function archivabilityError(statusLine: string): string | null {
  if (!COMPLETION_CLAIM_RE.test(statusLine)) return null;
  if (DONE_STATUS_LINE_RE.test(statusLine)) return null;
  return [
    '--status-line claims closure but is not in the archivable shape.',
    'Required: "<Type> / P<digit> / DONE|BUILT|FIXED|COMPLETED|COMPLETE|WONTFIX|DECLINED|SUPERSEDED|OBSOLETE ..."',
    '(e.g. "Bug / P2 / DONE 2026-09-18 - fixed." or "Feature / P3 / WONTFIX 2026-09-18 - decided against.").',
    `Got: "${statusLine}"`,
  ].join(' ');
}

/** Parse `--flag <value>` pairs; any bare/unknown token is a usage error. */
function parseFlags(args: string[], verb: 'add' | 'status'): FlagValues {
  const flags: FlagValues = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument: ${arg}`);
    if (!KNOWN_FLAGS[verb].has(arg)) throw new UsageError(`unknown argument: ${arg}`);
    const value = args[i + 1];
    if (value === undefined) throw new UsageError(`missing value for ${arg}`);
    flags[arg] = value;
    i++;
  }
  return flags;
}

function requireFlag(flags: FlagValues, name: string): string {
  const v = flags[name];
  if (v === undefined) throw new UsageError(`missing required flag ${name}`);
  return v;
}

/** Strip only the trailing newline a file/stdin body naturally carries —
 *  interior newlines stay and fail validation (bodies are single lines). */
function stripTrailingNewline(s: string): string {
  return s.replace(/[\r\n]+$/, '');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Exactly one of --body / --body-file; `--body-file -` reads stdin. */
async function bodyText(flags: FlagValues): Promise<string> {
  const hasBody = flags['--body'] !== undefined;
  const hasFile = flags['--body-file'] !== undefined;
  if (hasBody === hasFile) {
    throw new UsageError('add needs exactly one of --body "<text>" or --body-file <path>');
  }
  if (hasBody) return flags['--body'] as string;
  const path = flags['--body-file'] as string;
  if (path === '-') return stripTrailingNewline(await readStdin());
  return stripTrailingNewline(await readFile(path, 'utf8'));
}

/**
 * Deterministic error text for a quarantined fragment: re-run its content
 * through the REAL merge engine's validation (never a second validator) and
 * read the named failure back. A minimal sectionless backlog means a
 * schema-valid fragment can only fail at the same named rules the drain saw.
 */
function quarantinedError(raw: string): string {
  const empty = '# Open Items\n\n# Archived items\n';
  const res = mergeFragments(empty, [{ stem: 'probe', fragment: raw }], 0, parseBacklog(empty));
  return res.failed[0]?.error ?? 'unreadable';
}

/** Fixed caveat attached to every `pending` CANDIDATE report (human and
 *  JSON) — a KEYWORD MATCH is NOT evidence of completion. Measured live
 *  2026-09-18: of 14 open items whose body matched a completion/closure
 *  word, only 2 were genuinely done; the other 12 were false positives (a
 *  quoted UI button label reading "✅ Done", "landed" describing phase 1 of
 *  a 6-phase item still open, and similar). This module never treats a
 *  keyword match as a verdict — only a human reading the line can decide
 *  that — so this text is carried on the output itself, not just in a code
 *  comment nobody filing a backlog item will ever read. */
export const CANDIDATE_REPORT_CAVEAT =
  'Keyword match only -- NOT a verdict of completion. Verify each line by hand: false positives are ' +
  'common (a quoted UI label, "landed" describing one phase of several still open, a negation like ' +
  '"not done yet").';

/** Read-only scan of the open items across every backlog surface
 *  (2026-09-18): entries whose first-paragraph line contains a
 *  completion/closure word (`COMPLETION_CLAIM_RE`) but does not match the
 *  archiver's anchored `DONE_STATUS_LINE_RE` — items the archiver can never
 *  see and the drain will never move. These are CANDIDATES for a human to
 *  check, never a verdict (see `CANDIDATE_REPORT_CAVEAT`) — a keyword match
 *  proves nothing about whether the item is actually done. The surfaces are
 *  the `backlog/open-*.md` section files, falling back to the monolith
 *  BACKLOG.md while no section file exists (the pre-migration window —
 *  decision, spec §3 E16); a missing BACKLOG.md (e.g. an empty test repo)
 *  reads as "no candidates", never an error — `pending` is diagnostic, not a
 *  hard dependency on any file existing. Never writes anything.
 */
async function findCompletionClaimCandidates(
  repoRoot: string,
): Promise<{ id: number; title: string; line: string }[]> {
  const layout = await discoverLayout(repoRoot);
  const surfaces = layout.files.length > 0
    ? layout.files.map((f) => f.content)
    : (layout.routerContent !== null ? [layout.routerContent] : []);
  // zero open-*.md ⇒ monolith fallback — the pending/archive read paths
  // keep working through the pre-migration window (decision, this spec).
  const candidates: { id: number; title: string; line: string }[] = [];
  for (const content of surfaces) {
    const model = parseBacklog(content);
    for (const sec of model.sections) {
      for (const e of sec.entries) {
        const firstPara = e.paraEnd >= e.paraStart ? model.lines[e.paraStart] : '';
        if (COMPLETION_CLAIM_RE.test(firstPara) && !DONE_STATUS_LINE_RE.test(firstPara)) {
          candidates.push({ id: e.id, title: e.title, line: firstPara });
        }
      }
    }
  }
  return candidates;
}

function ageLabel(ageMs: number): string {
  const min = 60_000;
  if (ageMs < min) return `${Math.max(1, Math.round(ageMs / 1000))}s`;
  if (ageMs < 60 * min) return `${Math.round(ageMs / min)}m`;
  if (ageMs < 24 * 60 * min) return `${Math.round(ageMs / (60 * min))}h`;
  return `${Math.round(ageMs / (24 * 60 * min))}d`;
}

/** Repo-relative forward-slash path (spec output shapes use this exact form);
 *  the fs variants below are only ever handed to readFile. */
function relFragmentPath(stem: string, quarantined: boolean): string {
  return quarantined
    ? 'backlog/fragments/quarantine/' + stem + '.json'
    : 'backlog/fragments/' + stem + '.json';
}

function fsFragmentPath(repoRoot: string, stem: string, quarantined: boolean): string {
  return quarantined
    ? `${repoRoot}/backlog/fragments/quarantine/${stem}.json`
    : `${repoRoot}/backlog/fragments/${stem}.json`;
}

/** Flag parsing + body sourcing + the fragment write for add/status. Usage
 *  problems surface as UsageError; write failures as ordinary errors — the
 *  caller maps the two to exit 2 / exit 1. */
async function writeVerb(
  sub: 'add' | 'status',
  rest: string[],
  repoRootFn: () => Promise<string>,
): Promise<void> {
  const flags = parseFlags(rest, sub);
  const session = requireFlag(flags, '--session');
  let fragment: WriteFragmentInput;
  if (sub === 'add') {
    const { type, pri } = resolveTypeAndPri(flags);
    const rawBody = await bodyText(flags);
    fragment = {
      verb: 'add',
      section: requireFlag(flags, '--section').toLowerCase(),
      title: requireFlag(flags, '--title'),
      body: `${type} / P${pri} / OPEN — ${rawBody}`,
    };
  } else {
    const statusLine = requireFlag(flags, '--status-line');
    const archErr = archivabilityError(statusLine);
    if (archErr) throw new UsageError(archErr);
    fragment = {
      verb: 'status',
      target: requireFlag(flags, '--target'),
      status_line: statusLine,
    };
  }
  const repoRoot = await repoRootFn();
  const stem = await writeFragment(repoRoot, fragment, session);
  console.log(JSON.stringify({ ok: true, fragment: relFragmentPath(stem, false) }));
}

export async function backlogCommand(args: string[] = [], deps: BacklogCommandDeps = {}): Promise<void> {
  const repoRootFn = deps.repoRootFn ?? (() => repoRootFromModule(__filename));
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === 'add' || sub === 'status') {
    try {
      await writeVerb(sub, rest, repoRootFn);
    } catch (err) {
      if (err instanceof UsageError) {
        console.error(`${(err as Error).message}\n${USAGE}`);
        process.exit(2);
      }
      console.error(`pa backlog ${sub}: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === 'pending') {
    const unknown = rest.filter((a) => a !== '--json');
    if (unknown.length > 0) {
      console.error(`Usage: pa backlog pending [--json] (unknown argument(s): ${unknown.join(' ')})\n${USAGE}`);
      process.exit(2);
    }
    const repoRoot = await repoRootFn();
    const list = await listFragments(repoRoot);
    const now = Date.now();
    const pending: Array<Record<string, unknown>> = [];
    const human: string[] = [];
    for (const stem of list.pending) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(await readFile(fsFragmentPath(repoRoot, stem, false), 'utf8')) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      const ageMs = Math.max(0, now - Date.parse(String(parsed.created ?? '')) || 0);
      const verb = String(parsed.verb ?? '?');
      const arrow = verb === 'add' ? `add→${parsed.section ?? '?'}` : `status→${parsed.target ?? '?'}`;
      const quoted = `"${String(parsed.title ?? parsed.status_line ?? '')}"`;
      pending.push({
        file: relFragmentPath(stem, false),
        verb: parsed.verb,
        ...(parsed.section !== undefined ? { section: parsed.section } : {}),
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
        ...(parsed.target !== undefined ? { target: parsed.target } : {}),
        session: parsed.session,
        created: parsed.created,
        ageMs,
      });
      human.push(`PENDING   ${stem}  ${arrow}  ${quoted}  (${parsed.session}, ${ageLabel(ageMs)} old)`);
    }
    const quarantined: Array<{ file: string; error: string }> = [];
    for (const stem of list.quarantined) {
      let error: string;
      try {
        error = quarantinedError(await readFile(fsFragmentPath(repoRoot, stem, true), 'utf8'));
      } catch (err) {
        error = `unreadable (${(err as Error).message})`;
      }
      quarantined.push({ file: relFragmentPath(stem, true), error });
      human.push(`QUARANTINE ${stem}  ${error}`);
    }
    const candidateItems = await findCompletionClaimCandidates(repoRoot);
    const candidates = candidateItems.map((c) => ({ id: `AI-${c.id}`, title: c.title, line: c.line }));
    if (candidates.length > 0) {
      human.push(`CANDIDATES (${CANDIDATE_REPORT_CAVEAT})`);
      for (const c of candidates) {
        human.push(`CANDIDATE ${c.id}  "${c.title}"  keyword match, needs human check: "${c.line}"`);
      }
    }
    if (rest.includes('--json')) {
      console.log(JSON.stringify({ pending, quarantined, candidates, candidatesNote: CANDIDATE_REPORT_CAVEAT }));
    } else if (human.length === 0) {
      console.log('No pending fragments.');
    } else {
      console.log(human.join('\n'));
    }
    return;
  }

  if (sub === 'archive') {
    const unknown = rest.filter((a) => a !== '--dry-run');
    if (unknown.length > 0) {
      console.error(
        `Usage: pa backlog archive [--dry-run] (unknown argument(s): ${unknown.join(' ')})\n${USAGE}`,
      );
      process.exit(2);
    }
    const dryRun = rest.includes('--dry-run');
    const repoRoot = await repoRootFn();
    const nowMs = (deps.nowFn ?? Date.now)();
    const date = istDateOf(nowMs);
    const archiveRel = completedArchiveRelPath(date);
    try {
      if (!dryRun) {
        // The drain (or a commit/push skill) may be mid-pass on the same
        // files: git-workflow, waitMs 0. Busy is a normal failure — exit 1,
        // retry later; the drain's auto-archive is the no-operator fallback.
        const acquire =
          deps.acquireLockFn ??
          ((resource: string, agent: string, pid: number, timeoutMs: number) =>
            blackboard.acquireLock(resource, agent, pid, timeoutMs));
        const release =
          deps.releaseLockFn ??
          ((resource: string, agent: string) =>
            blackboard.releaseLock(resource, agent, undefined, { pid: process.pid }));
        const held = await acquire(exclusiveLockKey('git-workflow'), ARCHIVE_LOCK_AGENT, process.pid, 0);
        if (!held) {
          console.error(
            'pa backlog archive: the git-workflow lock is held (drain or commit in flight); retry in a few minutes.',
          );
          process.exit(1);
        }
        try {
          await archiveWrite(repoRoot, date, archiveRel);
        } finally {
          await release(exclusiveLockKey('git-workflow'), ARCHIVE_LOCK_AGENT).catch(() => {});
        }
        return;
      }
      await archiveDryRun(repoRoot, date, archiveRel);
    } catch (err) {
      console.error(`pa backlog archive: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === 'migrate') {
    // NO flags (spec §6): any argument is a usage error, exit 2.
    if (rest.length > 0) {
      console.error(
        `Usage: pa backlog migrate (unknown argument(s): ${rest.join(' ')})\n${USAGE}`,
      );
      process.exit(2);
    }
    try {
      await migrateBacklog(await repoRootFn(), deps);
    } catch (err) {
      // Named refusals (MigrateRefusal) and hard failures alike: exit 1 with
      // the named stderr line — the verb is never reachable in a broken
      // state because every refusal precedes any write.
      console.error(`pa backlog migrate: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  console.error(`${USAGE}`);
  process.exit(2);
}

/** The archive surfaces + per-surface plans (spec §3 E17): every
 *  `backlog/open-*.md` section file, falling back to the monolith BACKLOG.md
 *  while no section file exists (the pre-migration window — same decision as
 *  the candidates scan). A BACKLOG.md that can't be read in fallback reads as
 *  '' (zero items, never an error). */
async function archiveSurfaces(
  repoRoot: string,
): Promise<{ s: Pick<SectionFile, 'rel' | 'abs' | 'content'>; plan: ReturnType<typeof planBacklogArchive> }[]> {
  const layout = await discoverLayout(repoRoot);
  const surfaces: Pick<SectionFile, 'rel' | 'abs' | 'content'>[] =
    layout.files.length > 0
      ? layout.files.map((f) => ({ rel: f.rel, abs: f.abs, content: f.content }))
      : [{ rel: 'BACKLOG.md', abs: join(repoRoot, 'BACKLOG.md'), content: await readFile(join(repoRoot, 'BACKLOG.md'), 'utf8').catch(() => '') }];
  return surfaces.map((s) => ({ s, plan: planBacklogArchive(s.content) }));
}

/** Repo-rel paths of the surfaces whose plan moves ≥1 item — the `files`
 *  key the result JSON gains (dry-run and real run alike). */
function archiveTouchedFiles(
  plans: { s: Pick<SectionFile, 'rel'>; plan: ReturnType<typeof planBacklogArchive> }[],
): string[] {
  return plans.filter((p) => p.plan.moved.length > 0).map((p) => p.s.rel);
}

/** Read the surfaces and print the dry-run JSON; no lock, no writes. */
async function archiveDryRun(repoRoot: string, date: string, archiveRel: string): Promise<void> {
  const plans = await archiveSurfaces(repoRoot);
  const moved = plans.flatMap((p) => p.plan.moved);
  console.log(
    JSON.stringify({
      dryRun: true,
      archived: moved.length,
      ids: moved.map((m) => `AI-${m.id}`),
      archiveFile: archiveRel,
      files: archiveTouchedFiles(plans),
    }),
  );
}

/** The real move: re-read the surfaces under the held lock, append the
 *  day's archive section for the UNION of moved items (layout order),
 *  writeFileAtomic ONLY the surfaces whose plan content differs, print the
 *  result JSON. Files only — the commit is the caller's normal flow (the
 *  changed section files + archive file together). */
async function archiveWrite(repoRoot: string, date: string, archiveRel: string): Promise<void> {
  const plans = await archiveSurfaces(repoRoot);
  const moved = plans.flatMap((p) => p.plan.moved);
  if (moved.length > 0) {
    const archiveAbs = join(repoRoot, ...archiveRel.split('/'));
    await mkdir(dirname(archiveAbs), { recursive: true });
    let existing = '';
    try {
      existing = await readFile(archiveAbs, 'utf8');
    } catch {
      existing = '';
    }
    await writeFileAtomic(archiveAbs, appendArchiveSection(existing, date, moved));
    for (const p of plans) {
      if (p.plan.content !== p.s.content) {
        await writeFileAtomic(p.s.abs, p.plan.content);
      }
    }
  }
  console.log(
    JSON.stringify({
      ok: true,
      archived: moved.length,
      ids: moved.map((m) => `AI-${m.id}`),
      archiveFile: archiveRel,
      files: archiveTouchedFiles(plans),
    }),
  );
}

// ---------------------------------------------------------------------------
// `pa backlog migrate` — the one-time monolith → router cutover (spec §6)
// ---------------------------------------------------------------------------

/** A named pre-flight/verification refusal: exits 1 via the caller's catch,
 *  with this message as the named stderr line. Thrown BEFORE any write
 *  (pre-flight, re-verify, zero-loss checks) — the verb is never reachable
 *  in a broken state. */
class MigrateRefusal extends Error {}

const MIGRATE_LOCK_AGENT = 'backlog-migrate';
/** Layout file the migrate verb needs already emitted — pre-flight (a). */
const MIGRATE_LAYOUT_DIST_REL = join('pa', 'dist', 'src', 'lib', 'backlog-layout.js');

const execFileAsync = promisify(execFile);

/** The loop's StartTime via powershell (spec §6 step 1b: execFile, args
 *  array — never shell-joined, windowsHide:true). Returns {iso, ms} or null
 *  on any probe failure (spawn error, empty output, unparseable date). */
async function probeStartTimeIso(pid: number): Promise<{ iso: string; ms: number } | null> {
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString('o')`,
    ], { windowsHide: true });
    const raw = String(stdout).trim();
    if (!raw) return null;
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) return null;
    return { iso: raw, ms };
  } catch {
    return null;
  }
}

/** PID existence without a subprocess (same convention as blackboard's
 *  isPidAlive): signal-0 probe; EPERM means the process exists but is
 *  inaccessible — still alive, so the StartTime probe decides. */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

/** §6 step 1b default probe: ~/.pa/catchup-loop.lock → first line = loop
 *  PID. Absent/empty/unparseable or dead ⇒ {ok:true} — nothing live to
 *  restart. Live ⇒ compare its StartTime against the built layout file's
 *  mtime; a loop started at-or-before the build is still on the pre-wave
 *  code and must be restarted first (runbook §7 R1). Probe failure ⇒ refuse
 *  with the manual verification commands printed — never guess. */
async function defaultLoopCheck(
  repoRoot: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const lockPath = join(paHome(), 'catchup-loop.lock');
  let pidRaw = '';
  try {
    pidRaw = (await readFile(lockPath, 'utf8')).split(/\r?\n/, 1)[0].trim();
  } catch {
    return { ok: true };
  }
  const pid = Number(pidRaw);
  if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: true };
  if (!pidExists(pid)) return { ok: true };
  const distAbs = join(repoRoot, MIGRATE_LAYOUT_DIST_REL);
  const distMtime = statSync(distAbs).mtimeMs;
  const start = await probeStartTimeIso(pid);
  if (start === null) {
    return {
      ok: false,
      detail:
        `could not determine the catchup loop's start time (pid ${pid}) — refusing rather than guessing. ` +
        'Verify the loop postdates the build manually:\n' +
        `  (Get-Process -Id ${pid}).StartTime\n` +
        `  (Get-Item "${distAbs}").LastWriteTime\n` +
        'then restart the loop (spec §7 step R1) and re-run `pa backlog migrate`.',
    };
  }
  if (start.ms <= distMtime) {
    return {
      ok: false,
      detail:
        `catchup loop ${pid} is still on the pre-wave build (started ${start.iso} ≤ dist mtime ` +
        `${new Date(distMtime).toISOString()}) — restart it first (see spec §7 step R)`,
    };
  }
  return { ok: true };
}

/** §6 step 6 zero-loss verification over COMPOSED (or re-read disk)
 *  contents — pure, throws MigrateRefusal naming the failed check:
 *   (a) multiset of `#### [AI-nnn] ...` heading lines: pre-migration
 *       BACKLOG.md vs union of composed section contents — exact equality;
 *   (b) per section: lines[headingLine+1..endIndex) appears verbatim, same
 *       order, inside its file's composed content;
 *   (c) router preamble slice and archived-block slice byte-identical to
 *       the pre-migration lines. */
function assertZeroLoss(args: {
  preLines: string[];
  extracted: { name: string; body: string[]; content: string }[];
  routerContent: string;
}): void {
  const { preLines, extracted, routerContent } = args;
  const headingRe = /^#### \[AI-\d+\] .*$/;

  // (a) heading-line multiset equality.
  const pre = preLines.filter((l) => headingRe.test(l)).sort();
  const post = extracted
    .flatMap((x) => x.content.split(/\r?\n/).filter((l) => headingRe.test(l)))
    .sort();
  if (pre.length !== post.length || pre.some((l, i) => l !== post[i])) {
    throw new MigrateRefusal(
      `zero-loss check (a) failed: ${pre.length} item heading(s) pre-migration vs ${post.length} composed — refusing before any write`,
    );
  }

  // (b) per-section verbatim body: header '# Open Items' / '' / '## <name>'
  // then the section's own extracted lines in order. Joined comparison:
  // an empty body and the file's single trailing '' are the same bytes.
  for (const x of extracted) {
    const fileLines = x.content.split(/\r?\n/);
    const head = fileLines.slice(0, 3);
    if (head[0] !== '# Open Items' || head[1] !== '' || head[2] !== `## ${x.name}`) {
      throw new MigrateRefusal(
        `zero-loss check (b) failed: composed file for section '${x.name}' has a malformed header`,
      );
    }
    if (fileLines.slice(3).join('\n') !== x.body.join('\n')) {
      throw new MigrateRefusal(
        `zero-loss check (b) failed: section '${x.name}' body does not appear verbatim in its composed file`,
      );
    }
  }

  // (c) router preamble + archived-block slices byte-identical (modulo the
  // shared EOL — both sides joined with '\n' for the compare).
  const openIdx = preLines.findIndex((l) => l.trim() === '# Open Items');
  let archIdx = preLines.length;
  for (let i = openIdx + 1; i < preLines.length; i++) {
    if (preLines[i].trim() === '# Archived items') {
      archIdx = i;
      break;
    }
  }
  if (openIdx === -1 || archIdx <= openIdx) {
    throw new MigrateRefusal('zero-loss check (c) failed: internal error locating router bounds');
  }
  const routerLines = routerContent.split(/\r?\n/);
  if (routerLines.slice(0, openIdx).join('\n') !== preLines.slice(0, openIdx).join('\n')) {
    throw new MigrateRefusal('zero-loss check (c) failed: router preamble slice differs from pre-migration');
  }
  const tailLen = preLines.length - archIdx;
  const postArchived = tailLen === 0 ? '' : routerLines.slice(-tailLen).join('\n');
  if (postArchived !== preLines.slice(archIdx).join('\n')) {
    throw new MigrateRefusal('zero-loss check (c) failed: router archived-items block differs from pre-migration');
  }
}

/** §6 — the full migrate semantics. Every refusal throws MigrateRefusal
 *  (exit 1, named stderr line) BEFORE any write; the git-workflow lock is
 *  released in a finally. No flags (the caller rejects args with exit 2). */
async function migrateBacklog(repoRoot: string, deps: BacklogCommandDeps): Promise<void> {
  // ---- 1. PRE-FLIGHT (no lock yet) ----
  // (a) the layout code must already be built into dist.
  const distAbs = join(repoRoot, MIGRATE_LAYOUT_DIST_REL);
  if (!existsSync(distAbs)) {
    throw new MigrateRefusal('new code not built: run the pa build first');
  }
  // (b) the catchup loop must not still be running the pre-wave build.
  const loopCheck = deps.loopCheckFn ?? (() => defaultLoopCheck(repoRoot));
  const loop = await loopCheck();
  if (!loop.ok) throw new MigrateRefusal(loop.detail);
  // (c) BACKLOG.md must still be a monolith — ≥1 `## ` section.
  const backlogAbs = join(repoRoot, 'BACKLOG.md');
  const preContent = await readFile(backlogAbs, 'utf8');
  const model = parseBacklog(preContent);
  if (model.sections.length < 1) {
    throw new MigrateRefusal('nothing to migrate: BACKLOG.md has no ## sections (already a router?)');
  }
  // (d) no pre-existing section files — refuse rather than merge unknown
  // content.
  const backlogDir = join(repoRoot, 'backlog');
  let existingOpen: string[] = [];
  try {
    existingOpen = readdirSync(backlogDir).filter((n) => /^open-.+\.md$/.test(n));
  } catch {
    existingOpen = [];
  }
  if (existingOpen.length > 0) {
    throw new MigrateRefusal('backlog/open-*.md already exists — refusing rather than merging unknown content');
  }
  // (e) every section must slugify schema-validly and uniquely.
  const seen = new Map<string, string>();
  for (const s of model.sections) {
    const slug = slugifySection(s.name);
    if (!/^[a-z][a-z-]{0,30}$/.test(slug)) {
      throw new MigrateRefusal(
        `section heading '${s.name}' slugifies to '${slug}' — outside /^[a-z][a-z-]{0,30}$/; rename the section first`,
      );
    }
    const prior = seen.get(slug);
    if (prior !== undefined) {
      throw new MigrateRefusal(
        `section heading '${s.name}' slugifies to '${slug}' — collides with '${prior}'; rename one section first`,
      );
    }
    seen.set(slug, s.name);
  }

  // ---- 2. LOCK — git-workflow WITH wait (300s): the migration waits out an
  // in-flight drain/commit (unlike the drain's waitMs-0 skip). `pa backlog
  // add`/`status` are NOT blocked — fragments queue in gitignored
  // backlog/fragments/ across the cutover; the post-migration drain merges
  // them.
  const acquire =
    deps.acquireLockFn ??
    ((resource: string, agent: string, pid: number, timeoutMs: number, contextId?: string) =>
      blackboard.acquireLock(resource, agent, pid, timeoutMs, contextId));
  const release =
    deps.releaseLockFn ??
    ((resource: string, agent: string, contextId?: string) =>
      blackboard.releaseLock(resource, agent, contextId, { pid: process.pid }));
  const contextId = randomUUID();
  const held = await acquire(exclusiveLockKey('git-workflow'), MIGRATE_LOCK_AGENT, process.pid, 300_000, contextId);
  if (!held) {
    throw new MigrateRefusal('git-workflow lock held — retry');
  }

  try {
    // ---- 3. RE-VERIFY under lock: the monolith must not have moved since
    // pre-flight.
    const underLock = await readFile(backlogAbs, 'utf8');
    if (underLock !== preContent) {
      throw new MigrateRefusal('BACKLOG.md changed mid-migration');
    }

    // ---- 4. EXTRACT (parse-derived, never line numbers — robust to growth
    // between spec and run). Section file =
    //   '# Open Items' + eol + eol + '## <name>' + eol + body.join(eol)
    // ending with the source's trailing blank.
    const eol = model.crlf ? '\r\n' : '\n';
    const lines = model.lines;
    const extracted = model.sections.map((s) => {
      const body = lines.slice(s.headingLine + 1, s.endIndex);
      return {
        name: s.name,
        slug: slugifySection(s.name),
        rel: sectionFileRel(slugifySection(s.name)),
        items: s.entries.length,
        body,
        content: '# Open Items' + eol + eol + `## ${s.name}` + eol + body.join(eol),
      };
    });

    // ---- 5. ROUTER — verbatim preamble + pointer line + the AUTO table +
    // the verbatim '# Archived items' block. Stated deviation (spec §6): the
    // monolith's 'Everything below is genuinely open.' line is replaced by
    // the pointer — it described a file layout that no longer exists.
    const openIdx = lines.findIndex((l) => l.trim() === '# Open Items');
    let archIdx = lines.length;
    for (let i = openIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === '# Archived items') {
        archIdx = i;
        break;
      }
    }
    const routerLines = [
      ...lines.slice(0, openIdx),
      '# Open Items',
      '',
      'Open items live in the per-section files below — one file per `## ` section, written only by the backlog-fragments-drain job.',
      '',
      ...renderSectionTable(extracted.map((x) => ({ sectionName: x.name, rel: x.rel }))),
      '',
      ...lines.slice(archIdx),
    ];
    const routerContent = routerLines.join(eol);

    // ---- 6. ZERO-LOSS VERIFICATION — BEFORE writing anything.
    assertZeroLoss({ preLines: lines, extracted, routerContent });

    // ---- 7. WRITE each section file + BACKLOG.md, then re-read each and
    // re-run (a)+(b)+(c) against disk content (a corrupt write aborts before
    // commit, files left for diagnosis).
    await mkdir(backlogDir, { recursive: true });
    for (const x of extracted) {
      await writeFileAtomic(join(repoRoot, x.rel), x.content);
    }
    await writeFileAtomic(backlogAbs, routerContent);
    const diskExtracted = [] as { name: string; body: string[]; content: string }[];
    for (const x of extracted) {
      diskExtracted.push({
        name: x.name,
        body: x.body,
        content: await readFile(join(repoRoot, x.rel), 'utf8'),
      });
    }
    const diskRouter = await readFile(backlogAbs, 'utf8');
    assertZeroLoss({ preLines: lines, extracted: diskExtracted, routerContent: diskRouter });

    // ---- 8. COMMIT via the injected gitRunner — same add/commit pathspec
    // pattern the drain uses.
    const git = deps.gitRunner ?? defaultGitRunner;
    const addPaths = ['BACKLOG.md', ...extracted.map((x) => x.rel)];
    const add = await git(repoRoot, ['add', '--', ...addPaths]);
    if (add.code !== 0) {
      throw new Error(`git add failed (exit ${add.code}): ${add.stderr.toString('utf8').trim()}`);
    }
    const commitMsg = `backlog-migrate: split BACKLOG.md into router + ${extracted.length} backlog/open-*.md section files (AI-316)`;
    const commit = await git(repoRoot, ['commit', '-m', commitMsg, '--', ...addPaths]);
    if (commit.code !== 0) {
      throw new Error(`git commit failed (exit ${commit.code}): ${commit.stderr.toString('utf8').trim()}`);
    }
    const rev = await git(repoRoot, ['rev-parse', 'HEAD']);
    if (rev.code !== 0) {
      throw new Error(`git rev-parse HEAD failed (exit ${rev.code}): ${rev.stderr.toString('utf8').trim()}`);
    }

    // ---- 9. RELEASE (finally) + print the result JSON.
    console.log(
      JSON.stringify({
        ok: true,
        sections: extracted.map((x) => ({ section: x.name, file: x.rel, items: x.items })),
        items: extracted.reduce((n, x) => n + x.items, 0),
        commit: rev.stdout.toString('utf8').trim(),
      }),
    );
  } finally {
    await release(exclusiveLockKey('git-workflow'), MIGRATE_LOCK_AGENT, contextId).catch(() => {});
  }
}
