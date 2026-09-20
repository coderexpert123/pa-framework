/**
 * backlog-merge — append-only BACKLOG.md fragment engine (2026-09-12,
 * plans/2026-09-12-brain-file-lock-contention-SPEC.md D1+D3; wave vi-842a804a3ab9).
 *
 * Why: threads that file a backlog entry must claim and hand-edit BACKLOG.md,
 * which is contended ~10x/day. Instead every thread writes a PRIVATE,
 * uniquely-named JSON fragment under gitignored `backlog/fragments/`
 * (`pa backlog add` — zero contention by construction); the
 * backlog-fragments-drain job is the backlog/open-*.md section files' SOLE
 * writer (plus the AUTO table region of the BACKLOG.md router, 2026-09-18
 * router split) and merges fragments deterministically, assigning sequential
 * AI-nnn IDs from a max-scan so two filers can never race on an ID.
 *
 * Two halves, one module (the fragment lifecycle has exactly one owner):
 * - Pure: parseBacklog / scanMaxId / applyFragment / mergeFragments — no
 *   I/O; BACKLOG.md content goes in as a string and comes out as a string.
 *   This module contains NO BACKLOG.md file I/O.
 * - I/O: fragmentsDir / listFragments / writeFragment / quarantineFragment /
 *   deleteFragment — only the gitignored fragment files are written, listed,
 *   renamed or deleted.
 *
 * Fragment naming (D1): `<YYYYMMDD>-<HHMMSS>-<6hex>-<session>.json`, UTC
 * timestamp + 3 random bytes + sanitized session label — unique per write by
 * construction. The name is claimed with flag 'wx' (never clobbers an
 * existing fragment; on EEXIST the mint is retried ONCE with a fresh random
 * suffix), then the content lands via writeFileAtomic so the drain never
 * sees a torn fragment. Filename sort order IS the merge order.
 *
 * `<!-- frag:<stem> -->` markers written with every applied fragment are the
 * crash-safe idempotency key: a drain crash between commit and fragment
 * deletion makes the re-run SKIP (alreadyMerged), never duplicate.
 *
 * CommonJS module — __filename conventions, never the ESM meta-url form.
 */
import { randomBytes } from 'crypto';
import { mkdir, open, readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { renameWithRetry, writeFileAtomic } from './atomic-write.js';

/** The only versioning of the fragment schema (D1): `v` is fixed at 1. */
export const FRAGMENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Fragment schema + validation (D1)
// ---------------------------------------------------------------------------

export interface BacklogFragment {
  v: number;
  verb: 'add' | 'status';
  session: string;
  created: string;
  section?: string;
  title?: string;
  body?: string;
  target?: string;
  status_line?: string;
}

/** What the CLI composes; `v`/`session`/`created` are added by writeFragment. */
export type WriteFragmentInput = Omit<BacklogFragment, 'v' | 'session' | 'created'>;

export type FragmentParse =
  | { ok: true; fragment: BacklogFragment }
  | { ok: false; error: string };

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function isSingleLineWithin(s: unknown, max: number): boolean {
  return (
    typeof s === 'string' &&
    !s.includes('\n') &&
    !s.includes('\r') &&
    s.trim().length > 0 &&
    s.length <= max
  );
}

/**
 * Field rules in the D1 order — each failure returns its named error so a
 * quarantined fragment's alert says WHICH rule failed.
 */
function validateFragment(obj: unknown): FragmentParse {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, error: 'bad-json' };
  }
  const f = obj as Record<string, unknown>;
  if (f.v !== FRAGMENT_SCHEMA_VERSION) return { ok: false, error: 'bad-v' };
  if (f.verb !== 'add' && f.verb !== 'status') return { ok: false, error: 'bad-verb' };
  if (typeof f.session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(f.session)) {
    return { ok: false, error: 'bad-session' };
  }
  if (typeof f.created !== 'string' || !Number.isFinite(Date.parse(f.created))) {
    return { ok: false, error: 'bad-created' };
  }
  if (f.verb === 'add') {
    if (typeof f.section !== 'string' || !/^[a-z][a-z-]{0,30}$/.test(f.section)) {
      return { ok: false, error: 'bad-section' };
    }
    // target/status_line keys are not required to be absent — ignored if present (D1).
    if (!isSingleLineWithin(f.title, 200)) return { ok: false, error: 'bad-title' };
    if (!isSingleLineWithin(f.body, 2000)) return { ok: false, error: 'bad-body' };
  } else {
    if (typeof f.target !== 'string' || !/^AI-\d{3}$/.test(f.target)) {
      return { ok: false, error: 'bad-target' };
    }
    if (!isSingleLineWithin(f.status_line, 2000)) {
      return { ok: false, error: 'bad-status-line' };
    }
  }
  return { ok: true, fragment: f as unknown as BacklogFragment };
}

/** Parse + validate one fragment's raw file content (named error on any failure). */
function parseFragmentRaw(raw: string): FragmentParse {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'bad-json' };
  }
  return validateFragment(obj);
}

/** Export of the private validator for ORCHESTRATION callers that must route on
 *  verb/section/target BEFORE applying (the multi-file drain, 2026-09-18).
 *  mergeFragments keeps its own internal call — this is a second call site,
 *  not a second parser. */
export function parseFragment(raw: string): FragmentParse {
  return parseFragmentRaw(raw);
}

// ---------------------------------------------------------------------------
// Pure half — BACKLOG.md text model (D3)
// ---------------------------------------------------------------------------

export interface BacklogEntry {
  /** Numeric nnn of the `[AI-nnn]` heading id. */
  id: number;
  title: string;
  /** Line index of the `#### [AI-nnn] ...` heading. */
  headingLine: number;
  /** First-paragraph line range, inclusive. `paraEnd < paraStart` ⇒ empty. */
  paraStart: number;
  paraEnd: number;
}

export interface BacklogSection {
  name: string;
  headingLine: number;
  /** Exclusive bound: line index of the next `## `/`# ` heading (or the
   *  `# Archived items` bound). */
  endIndex: number;
  entries: BacklogEntry[];
}

export interface BacklogModel {
  crlf: boolean;
  /** Split lines; a trailing '' (content ending in a newline) is kept so a
   *  join reproduces the input byte-for-byte when nothing changes. */
  lines: string[];
  sections: BacklogSection[];
}

/**
 * Parse the open-items half of BACKLOG.md: `# Open Items`, the `## <Section>`
 * headings between it and `# Archived items`, each section's
 * `#### [AI-nnn] <title>` entry headings and each entry's first paragraph
 * (consecutive non-blank lines after the heading). CRLF-aware: the flag is
 * remembered and write-back joins with the SAME ending, so a merge never
 * rewrites a whole file's line endings.
 */
export function parseBacklog(content: string): BacklogModel {
  const crlf = content.includes('\r\n');
  const lines = content.split(/\r?\n/);
  const openIdx = lines.findIndex((l) => l.trim() === '# Open Items');
  if (openIdx === -1) return { crlf, lines, sections: [] };
  let archIdx = lines.length;
  for (let i = openIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '# Archived items') {
      archIdx = i;
      break;
    }
  }

  const sections: BacklogSection[] = [];
  for (let i = openIdx + 1; i < archIdx; i++) {
    const m = /^## (.+)$/.exec(lines[i].trim());
    if (!m) continue;
    const headingLine = i;
    let endIndex = archIdx;
    for (let j = headingLine + 1; j < archIdx; j++) {
      if (/^## |^# /.test(lines[j].trim())) {
        endIndex = j;
        break;
      }
    }
    const entries: BacklogEntry[] = [];
    for (let j = headingLine + 1; j < endIndex; j++) {
      const e = /^#### \[AI-(\d+)\] (.*)$/.exec(lines[j]);
      if (!e) continue;
      const paraStart = j + 1;
      let paraEnd = paraStart - 1;
      while (paraEnd + 1 < endIndex && lines[paraEnd + 1].trim() !== '') paraEnd++;
      entries.push({ id: parseInt(e[1], 10), title: e[2], headingLine: j, paraStart, paraEnd });
    }
    sections.push({ name: m[1], headingLine, endIndex, entries });
  }
  return { crlf, lines, sections };
}

/**
 * Max `[AI-nnn]` id across BACKLOG.md content + every `backlog/*.md` file
 * CONTENT (archives, programs, not-valid, completed-index — passed in as
 * strings by the caller). Next merge id derives from this at merge time,
 * never from a constant. 0 when nothing matches.
 */
export function scanMaxId(backlogContent: string, backlogDirFiles: string[]): number {
  let max = 0;
  for (const text of [backlogContent, ...backlogDirFiles]) {
    for (const m of text.matchAll(/\[AI-(\d+)\]/g)) {
      max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return max;
}

function joinLines(model: { crlf: boolean; lines: string[] }): string {
  return model.lines.join(model.crlf ? '\r\n' : '\n');
}

/** Insertion region for an add: from the section's last content line to the
 *  next `^## `/`^# ` heading, the trailing blank-run plus at most ONE
 *  trailing `---` separator (the real file has both shapes — a section that
 *  ends `---`-then-heading and one that ends blank-then-heading). The region
 *  is REBUILT, not spliced beside, so the block gets exactly one blank line
 *  before and after without doubling the pre-existing blanks. */
function insertionRegion(
  lines: string[],
  endIndex: number,
): { start: number; hadDash: boolean } {
  let i = endIndex;
  while (i - 1 >= 0 && lines[i - 1].trim() === '') i--;
  let hadDash = false;
  if (i - 1 >= 0 && lines[i - 1].trim() === '---') {
    hadDash = true;
    i--;
  }
  while (i - 1 >= 0 && lines[i - 1].trim() === '') i--;
  return { start: i, hadDash };
}

/** The filename/fragment slug form of a section heading — 'Bugs R Us' →
 *  'bugs-r-us' (lowercase, whitespace runs → '-', strip to [a-z-]). The
 *  canonical definition lives HERE (the pure engine) and backlog-layout
 *  re-exports it — routing (drain fileForSection) and application (this
 *  module's applyAdd) must share the one transform or a multi-word heading
 *  ('Bug Fixes' → slug 'bug-fixes') routes correctly and then fails
 *  'unknown section' on a name compare (2026-09-18 verifier finding). */
export function slugifySection(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z-]/g, '');
}

function applyAdd(
  model: BacklogModel,
  fragment: BacklogFragment,
  stem: string,
  assignedId: number,
): { ok: true; content: string } | { ok: false; error: string } {
  // fragment.section is a SLUG per the fragment validator ([a-z][a-z-]{0,30})
  // and the drain routes by that slug — the section lookup must compare
  // through the same transform or a multi-word heading dies 'unknown section'
  // after routing correctly (2026-09-18). A heading's slug equals its
  // lowercase only for single/hyphenated words, so the old name-compare was
  // already slug-shaped for every input that could reach this line.
  const sec = model.sections.find(
    (s) => slugifySection(s.name) === String(fragment.section).toLowerCase(),
  );
  if (!sec) return { ok: false, error: 'unknown section' };
  const lines = model.lines.slice();
  const { start, hadDash } = insertionRegion(lines, sec.endIndex);
  const insert = [
    '',
    `#### [AI-${assignedId}] ${fragment.title}`,
    String(fragment.body),
    `<!-- frag:${stem} -->`,
    '',
    ...(hadDash ? ['---', ''] : []),
  ];
  lines.splice(start, sec.endIndex - start, ...insert);
  return { ok: true, content: joinLines({ crlf: model.crlf, lines }) };
}

function applyStatus(
  model: BacklogModel,
  fragment: BacklogFragment,
  stem: string,
): { ok: true; content: string } | { ok: false; error: string } {
  const targetId = parseInt(String(fragment.target).slice('AI-'.length), 10);
  const hits: BacklogEntry[] = [];
  for (const sec of model.sections) {
    for (const e of sec.entries) if (e.id === targetId) hits.push(e);
  }
  // Archived ids are out of reach by construction — parseBacklog only models
  // open items, so an archived target reads as unknown.
  if (hits.length === 0) return { ok: false, error: 'unknown target' };
  if (hits.length > 1) return { ok: false, error: 'ambiguous target' };
  const e = hits[0];
  const lines = model.lines.slice();
  const replacement = [String(fragment.status_line), `<!-- frag:${stem} -->`];
  if (e.paraEnd >= e.paraStart) {
    lines.splice(e.paraStart, e.paraEnd - e.paraStart + 1, ...replacement);
  } else {
    lines.splice(e.headingLine + 1, 0, ...replacement);
  }
  return { ok: true, content: joinLines({ crlf: model.crlf, lines }) };
}

/** Apply one parsed+validated fragment to the model. Returns the new content
 *  string — never touches a file. */
function applyFragment(
  model: BacklogModel,
  fragment: BacklogFragment,
  stem: string,
  assignedId: number,
): { ok: true; content: string } | { ok: false; error: string } {
  return fragment.verb === 'add'
    ? applyAdd(model, fragment, stem, assignedId)
    : applyStatus(model, fragment, stem);
}

export interface MergeFragmentInput {
  stem: string;
  /** Raw fragment file content (JSON text) — parsed here so bad JSON fails
   *  validation with a named error instead of throwing. */
  fragment: string;
}

export interface MergeResult {
  content: string;
  applied: { stem: string; id: number | null }[];
  failed: { stem: string; error: string }[];
  alreadyMerged: string[];
}

/**
 * Deterministic batch merge, in filename (stem) order. Skips — as
 * `alreadyMerged` — any stem whose `<!-- frag:<stem> -->` marker is already
 * present (crash between commit and fragment deletion; re-running must not
 * duplicate). Assigns AI-nnn ids sequentially from maxId+1, so two add
 * fragments in one batch get DISTINCT sequential ids — the no-claim id race
 * this engine exists to kill. One fragment's failure (validation or
 * application) never blocks the rest; the caller quarantines `failed` stems
 * and alerts — never silent-drop.
 *
 * `backlogSections` is the parseBacklog(backlogContent) result, passed
 * through by the drain to avoid a double parse; the model is re-parsed after
 * each applied fragment since the content changed. `id` is null for applied
 * `status` fragments (they replace text, they do not mint ids) — the stem is
 * what the drain needs for deletion.
 */
export function mergeFragments(
  backlogContent: string,
  fragments: MergeFragmentInput[],
  maxId: number,
  backlogSections: BacklogModel,
): MergeResult {
  let current = backlogContent;
  let model = backlogSections ?? parseBacklog(current);
  const applied: { stem: string; id: number | null }[] = [];
  const failed: { stem: string; error: string }[] = [];
  const alreadyMerged: string[] = [];
  let nextId = maxId + 1;
  const ordered = [...fragments].sort((a, b) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0));
  for (const { stem, fragment } of ordered) {
    if (current.includes(`<!-- frag:${stem} -->`)) {
      alreadyMerged.push(stem);
      continue;
    }
    const parsed = parseFragmentRaw(fragment);
    if (!parsed.ok) {
      failed.push({ stem, error: parsed.error });
      continue;
    }
    const res = applyFragment(model, parsed.fragment, stem, nextId);
    if (!res.ok) {
      failed.push({ stem, error: res.error });
      continue;
    }
    current = res.content;
    applied.push({ stem, id: parsed.fragment.verb === 'add' ? nextId : null });
    if (parsed.fragment.verb === 'add') nextId++;
    model = parseBacklog(current);
  }
  return { content: current, applied, failed, alreadyMerged };
}

// ---------------------------------------------------------------------------
// I/O half — the fragment file lifecycle (D1; sole owner of these files)
// ---------------------------------------------------------------------------

/** Gitignored per-thread fragment queue directory inside the repo. */
export function fragmentsDir(repoRoot: string): string {
  return join(repoRoot, 'backlog', 'fragments');
}

function quarantineDir(repoRoot: string): string {
  return join(fragmentsDir(repoRoot), 'quarantine');
}

function sanitizeSession(session: string): string {
  return session.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
}

function stemFor(nowMs: number, rand6: string, session: string): string {
  const d = new Date(nowMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${date}-${time}-${rand6}-${sanitizeSession(session)}`;
}

/**
 * Mint a unique fragment name (D1), claim it with 'wx' (EEXIST ⇒ retry ONCE
 * with a fresh random suffix, then throw), then land the content via
 * writeFileAtomic (tmp+rename, Windows-retried) so the drain never sees a
 * torn fragment. Validates the assembled fragment FIRST — an invalid
 * fragment never reaches disk (throws `invalid fragment (<named error>)`).
 * `opts.now` / `opts.randomHex` are test seams (determinism + EEXIST retry).
 * Returns the stem; the file is `backlog/fragments/<stem>.json`.
 */
export async function writeFragment(
  repoRoot: string,
  fragment: WriteFragmentInput,
  session: string,
  opts: { now?: number; randomHex?: () => string } = {},
): Promise<string> {
  const now = opts.now ?? Date.now();
  const rand = opts.randomHex ?? (() => randomBytes(3).toString('hex'));
  const full = {
    v: FRAGMENT_SCHEMA_VERSION,
    session,
    created: new Date(now).toISOString(),
    ...fragment,
  };
  const check = validateFragment(full);
  if (!check.ok) throw new Error(`invalid fragment (${check.error})`);

  const dir = fragmentsDir(repoRoot);
  await mkdir(dir, { recursive: true });
  let stem = stemFor(now, rand(), session);
  for (let attempt = 0; attempt < 2; attempt++) {
    const fh = await open(join(dir, `${stem}.json`), 'wx').catch((err: unknown) => {
      if (errnoCode(err) === 'EEXIST' && attempt === 0) return null;
      throw err;
    });
    if (fh === null) {
      stem = stemFor(now, rand(), session);
      continue;
    }
    await fh.close();
    await writeFileAtomic(join(dir, `${stem}.json`), `${JSON.stringify(full, null, 2)}\n`);
    return stem;
  }
  throw new Error(`fragment name collision after retry: ${stem}`);
}

/**
 * Sorted fragment stems: pending (`backlog/fragments/*.json`) + quarantined
 * (`backlog/fragments/quarantine/*.json`). Missing dirs read as empty.
 */
export async function listFragments(
  repoRoot: string,
): Promise<{ pending: string[]; quarantined: string[] }> {
  const readStems = async (dir: string): Promise<string[]> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => e.name.slice(0, -'.json'.length))
        .sort();
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return [];
      throw err;
    }
  };
  return {
    pending: await readStems(fragmentsDir(repoRoot)),
    quarantined: await readStems(quarantineDir(repoRoot)),
  };
}

/** Move a fragment that failed validation into `backlog/fragments/quarantine/`
 *  — never silent-drop, never block the rest of the batch. */
export async function quarantineFragment(repoRoot: string, stem: string): Promise<void> {
  const qdir = quarantineDir(repoRoot);
  await mkdir(qdir, { recursive: true });
  await renameWithRetry(join(fragmentsDir(repoRoot), `${stem}.json`), join(qdir, `${stem}.json`));
}

/** Delete a merged fragment. A missing file is already-gone success (the
 *  stale-file case self-heals via the frag marker on the next pass). */
export async function deleteFragment(repoRoot: string, stem: string): Promise<void> {
  try {
    await unlink(join(fragmentsDir(repoRoot), `${stem}.json`));
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
  }
}
