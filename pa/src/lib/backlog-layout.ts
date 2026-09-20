/**
 * backlog-layout — the backlog/open-*.md section-file layout over which
 * BACKLOG.md routes (2026-09-18, AI-316;
 * plans/2026-09-18-backlog-router-split-SPEC.md §1).
 *
 * BACKLOG.md stopped being the open-items monolith on 2026-09-18: open items
 * live one-file-per-`## `-section under `backlog/open-<slug>.md`, written
 * ONLY by the backlog-fragments-drain job, and BACKLOG.md keeps the preamble,
 * the normative Standard, the archived-items pointer, and a drain-maintained
 * section table inside its AUTO:BACKLOG-SECTIONS marker pair. This module is
 * the layout's single definition — filename↔section mapping, discovery,
 * invariants, and the router table splice — so the drain and `pa backlog`
 * never re-derive it.
 *
 * Pure/IO split mirrors backlog-merge.ts: every helper is pure (strings in,
 * values out); `discoverLayout` is the ONLY fs function (readdir + readFile
 * + parseBacklog). A section file's model is a plain parseBacklog of its
 * content — `# Open Items` + one `## ` heading + `#### [AI-nnn]` items —
 * and `### `/`#### ` headings inside it are safe by construction (`^## `
 * requires exactly two hashes + space).
 *
 * CommonJS module — __filename/__dirname, never the ESM meta-url form.
 */
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { parseBacklog, slugifySection, type BacklogModel } from './backlog-merge.js';

/** 'Bugs R Us' -> 'bugs-r-us' — canonical definition in backlog-merge.ts (the
 *  pure engine's applyAdd compares section headings through the same transform);
 *  re-exported here so the §1 contract surface keeps its single import point. */
export { slugifySection };

export interface SectionFile {
  /** repo-relative forward-slash path, always `backlog/open-<slug>.md` */
  rel: string;
  /** absolute path for writeFileAtomic/stat */
  abs: string;
  /** filename-derived slug — `open-<slug>` */
  slug: string;
  /** verbatim text of the file's single `## ` heading (e.g. 'Bugs') */
  sectionName: string;
  /** file content as read (write-back compares against this) */
  content: string;
  /** parseBacklog(content) — the per-file model, reparsed after every apply */
  model: BacklogModel;
}

export interface Layout {
  /** sorted by rel (glob/readdir order = deterministic) */
  files: SectionFile[];
  /** BACKLOG.md content, or null when absent */
  routerContent: string | null;
  /** router carries exactly one open+close AUTO marker pair */
  routerHasMarkers: boolean;
}

export function sectionFileRel(slug: string): string {
  return `backlog/open-${slug}.md`;
}

export function sectionSkeleton(sectionName: string): string {
  return `# Open Items\n\n## ${sectionName}\n`;
}

/** `add` routing: the fragment's `section` field IS already a slug per the
 *  fragment validator (`[a-z][a-z-]{0,30}`) — match is `file.slug ===
 *  fragment.section`, NOT a name compare. */
export function fileForSection(files: SectionFile[], sectionSlug: string): SectionFile | null {
  return files.find((f) => f.slug === sectionSlug) ?? null;
}

/** `status` routing across all parsed models: the file whose model contains
 *  the target id. 0 hits ⇒ 'none' (archived ids are out of reach by
 *  construction — parseBacklog models open items only); >1 ⇒ 'ambiguous'. */
export function fileForTargetId(
  files: SectionFile[],
  targetId: number
):
  | { kind: 'file'; file: SectionFile }
  | { kind: 'none' }
  | { kind: 'ambiguous'; files: SectionFile[] } {
  const hits = files.filter((f) =>
    f.model.sections.some((s) => s.entries.some((e) => e.id === targetId))
  );
  if (hits.length === 0) return { kind: 'none' };
  if (hits.length > 1) return { kind: 'ambiguous', files: hits };
  return { kind: 'file', file: hits[0] };
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** The ONLY fs function in the module. Globs `backlog/open-*.md` (readdir,
 *  `/^open-(.+)\.md$/` filter, sorted), reads each + BACKLOG.md (absent ⇒
 *  routerContent null), parses each through parseBacklog, and detects the
 *  AUTO marker pair (exactly one open + one close marker line, open before
 *  close). A file that vanishes between readdir and readFile is skipped like
 *  a missing one; other read errors throw (never silently mis-layout). */
export async function discoverLayout(repoRoot: string): Promise<Layout> {
  const dir = join(repoRoot, 'backlog');
  let names: string[];
  try {
    names = (await readdir(dir))
      .filter((n) => /^open-.+\.md$/.test(n))
      .sort();
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') names = [];
    else throw err;
  }
  const files: SectionFile[] = [];
  for (const name of names) {
    const rel = `backlog/${name}`;
    const abs = join(repoRoot, rel);
    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') continue;
      throw err;
    }
    const h2 = content.split(/\r?\n/).find((l) => l.trim().startsWith('## '));
    const sectionName = h2 === undefined ? '' : /^## (.+)$/.exec(h2.trim())![1];
    files.push({
      rel,
      abs,
      slug: /^open-(.+)\.md$/.exec(name)![1],
      sectionName,
      content,
      model: parseBacklog(content),
    });
  }
  let routerContent: string | null = null;
  try {
    routerContent = await readFile(join(repoRoot, 'BACKLOG.md'), 'utf8');
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
  }
  return {
    files,
    routerContent,
    routerHasMarkers: routerContent !== null && markerRange(routerContent) !== null,
  };
}

export interface LayoutProblem {
  reason: 'pre-router-backlog' | 'backlog-layout-invalid';
  detail: string;
}

/**
 * The 4 invariants (§5's table — the drain's named-skip reasons come from
 * `problem.reason`; `detail` names WHICH rule failed):
 *  - per file: exactly one `## ` heading; the only `# ` heading is
 *    `# Open Items`; zero `# Archived items`; filename slug ===
 *    slugifySection(heading text)
 *  - across files: no two files with equal slugifySection(sectionName)
 *  - router: parseBacklog(routerContent).sections.length === 0 — the ONLY
 *    'pre-router-backlog' violation (the monolith case — also the
 *    pre-migration guard); every other violation is 'backlog-layout-invalid'.
 */
export function validateLayout(
  layout: Layout
): { ok: true } | { ok: false; problem: LayoutProblem } {
  const invalid = (detail: string) => ({
    ok: false as const,
    problem: { reason: 'backlog-layout-invalid' as const, detail },
  });
  const seenSectionSlugs = new Map<string, string>();
  for (const f of layout.files) {
    const lines = f.content.split(/\r?\n/);
    const h2 = lines.filter((l) => l.trim().startsWith('## '));
    if (h2.length !== 1) {
      return invalid(`${f.rel}: expected exactly one '## ' heading, found ${h2.length}`);
    }
    if (lines.some((l) => l.trim() === '# Archived items')) {
      return invalid(`${f.rel}: '# Archived items' is router-only — a section file never carries it`);
    }
    const h1 = lines.filter((l) => l.trim().startsWith('# '));
    if (h1.length !== 1 || h1[0].trim() !== '# Open Items') {
      return invalid(
        `${f.rel}: the only '# ' heading must be '# Open Items'` +
          (h1.length > 0 ? `, found '${h1[0].trim()}'` : ', found none')
      );
    }
    const sectionName = /^## (.+)$/.exec(h2[0].trim())![1];
    const nameSlug = slugifySection(sectionName);
    if (nameSlug !== f.slug) {
      return invalid(
        `${f.rel}: filename slug '${f.slug}' does not match slugifySection('${sectionName}') = '${nameSlug}'`
      );
    }
    const prior = seenSectionSlugs.get(nameSlug);
    if (prior !== undefined) {
      return invalid(`two section files slug-collide on '${nameSlug}': ${prior} and ${f.rel}`);
    }
    seenSectionSlugs.set(nameSlug, f.rel);
  }
  if (layout.routerContent !== null) {
    const sectionCount = parseBacklog(layout.routerContent).sections.length;
    if (sectionCount > 0) {
      return {
        ok: false,
        problem: {
          reason: 'pre-router-backlog',
          detail:
            `BACKLOG.md's open region still carries ${sectionCount} '## ' section(s) — ` +
            'it is a monolith (pre-migration) or a stray section heading landed in the router ' +
            'open region; run `pa backlog migrate` or remove the stray heading',
        },
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Router table — the drain-maintained region (operator decision 2026-09-18)
// ---------------------------------------------------------------------------

export const ROUTER_TABLE_OPEN = '<!-- AUTO:BACKLOG-SECTIONS -->';
export const ROUTER_TABLE_CLOSE = '<!-- /AUTO:BACKLOG-SECTIONS -->';

/** The inclusive [openIdx, closeIdx] line range of the marker pair, or null
 *  when the pair is absent, duplicated, or out of order. A marker is a line
 *  whose trimmed content IS the marker — prose mentioning it never counts. */
function markerRange(content: string): { open: number; close: number; lines: string[] } | null {
  const lines = content.split(/\r?\n/);
  const openIdxs = lines.map((l, i) => (l.trim() === ROUTER_TABLE_OPEN ? i : -1)).filter((i) => i >= 0);
  const closeIdxs = lines.map((l, i) => (l.trim() === ROUTER_TABLE_CLOSE ? i : -1)).filter((i) => i >= 0);
  if (openIdxs.length !== 1 || closeIdxs.length !== 1 || openIdxs[0] > closeIdxs[0]) return null;
  return { open: openIdxs[0], close: closeIdxs[0], lines };
}

/** Full marker-delimited block as a line array — rows =
 *  `| ${sectionName} | \`${rel}\` |`, files sorted by rel (deterministic;
 *  an auto-created file sorts in by its slug). */
export function renderSectionTable(files: { sectionName: string; rel: string }[]): string[] {
  const sorted = [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return [
    ROUTER_TABLE_OPEN,
    ...sorted.map((f) => `| ${f.sectionName} | \`${f.rel}\` |`),
    ROUTER_TABLE_CLOSE,
  ];
}

/** Replace the lines between the markers (inclusive) with
 *  renderSectionTable(files). Returns routerContent UNCHANGED when the
 *  marker pair is absent or duplicated (the caller logs
 *  'router-no-markers' — a cosmetic region never stalls a pass). Line
 *  endings follow the input (CRLF-aware, same convention as joinLines). */
export function spliceSectionTable(
  routerContent: string,
  files: { sectionName: string; rel: string }[]
): string {
  const range = markerRange(routerContent);
  if (range === null) return routerContent;
  const block = renderSectionTable(files);
  const lines = range.lines.slice();
  lines.splice(range.open, range.close - range.open + 1, ...block);
  return lines.join(routerContent.includes('\r\n') ? '\r\n' : '\n');
}
