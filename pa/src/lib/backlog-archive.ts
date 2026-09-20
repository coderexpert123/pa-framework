/**
 * backlog-archive — the DONE-item OUTFLOW from BACKLOG.md (2026-09-13).
 *
 * BACKLOG.md only ever Grew before this module existed: the
 * backlog-fragments-drain merges fragments IN, and nothing moved finished
 * items OUT — the file sat ~42k chars against its 12k docs budget
 * (docs-crossref's "root BACKLOG.md stays within its size budget" gate, whose
 * own failure message says "move more DONE items to backlog/"). This module
 * is that outflow, shared by both callers:
 *
 * - `pa backlog archive [--dry-run]` (commands/backlog.ts) — the manual,
 *   operator/session-invoked full sweep; writes files, never commits.
 * - the backlog-fragments-drain's auto-archive — after a successful merge
 *   compute, when DONE-class items cross ARCHIVE_DONE_THRESHOLD or the file
 *   is over docs-lint's BACKLOG_SECTION_BUDGET, the same write+commit window that
 *   lands the merge also lands the archive (commit message names it).
 *
 * Pure half (this file): planBacklogArchive / shouldAutoArchive /
 * appendArchiveSection — content in, content out, no I/O. The I/O (read
 * BACKLOG.md, write both files) lives in the callers, under the git-workflow
 * exclusive lock, same as every other BACKLOG.md writer.
 *
 * Archivable class: an open item whose FIRST status-line paragraph starts
 * `Type / Pri / <token>`, where token is either a SHIPPED token (DONE, BUILT,
 * FIXED, COMPLETE(D) — the work happened) or, since 2026-09-18, a CLOSED
 * token (WONTFIX, DECLINED, SUPERSEDED, OBSOLETE — the question was decided
 * against, never built, and is just as done being open work). Both classes
 * are archivable; `ArchivedItem.kind` records which, and
 * `appendArchiveSection` renders closed items under their own heading so a
 * reader can tell shipped work from a question that was closed (AI-226:
 * "don't split" was decided 2026-09-14 but had no token to express "closed,
 * not shipped", so it sat stuck in the open list forever — the same failure
 * class this module exists to fix, one token short).
 *
 * The anchor is load-bearing: AI-203 (IN PROGRESS) carries "BUILT
 * 2026-09-06" MID-line for its landed increments, so a paragraph-wide or
 * unanchored match would archive a live item. NOT VALID and DEFERRED are
 * deliberate non-members (invalidated/postponed, not decided) — a NOT VALID
 * or DEFERRED item may still change; WONTFIX/DECLINED/SUPERSEDED/OBSOLETE
 * are terminal decisions. An archived item never returns: the drain merges
 * only fragments, and a status fragment targeting an archived id reads as
 * `unknown target` (parseBacklog models open items only) — it quarantines +
 * alerts, never resurrects.
 *
 * CommonJS module — no ESM meta-url forms.
 */
import { parseBacklog } from './backlog-merge.js';
import { toIST } from '../ist.js';
import { BACKLOG_SECTION_BUDGET } from './docs-lint.js';

/** Drain auto-archive trigger: archive when at least this many DONE-class
 *  items are open (the manual `pa backlog archive` ignores thresholds — it
 *  always sweeps every DONE-class item). */
export const ARCHIVE_DONE_THRESHOLD = 10;

/**
 * The archivable status line: `Type / Pri / <token>` anchored at the START
 * of the item's first paragraph line, where token is one of the SHIPPED or
 * CLOSED tokens below (capturing group — callers can classify which one
 * matched; `.test()` callers are unaffected, a capturing group doesn't
 * change match/no-match). Case-sensitive uppercase — prose like "was built"
 * never matches, and FILED/OPEN/IN PROGRESS/PENDING/DEFERRED/NOT VALID are
 * not in the vocabulary.
 *
 * Exported (2026-09-18) so `commands/backlog.ts`'s `pa backlog status`
 * archivability preflight imports this exact regex instead of re-declaring
 * it — the mover and the preflight check must never drift apart.
 */
export const DONE_STATUS_LINE_RE =
  /^[A-Za-z][A-Za-z -]*\/ P\d \/ ?(DONE|BUILT|FIXED|COMPLETED|COMPLETE|WONTFIX|DECLINED|SUPERSEDED|OBSOLETE)\b/;

/** The work happened — matches `ArchivedItem.kind === 'shipped'`. */
const SHIPPED_TOKENS = new Set(['DONE', 'BUILT', 'FIXED', 'COMPLETED', 'COMPLETE']);

/** The question was decided against and closed WITHOUT the work happening —
 *  matches `ArchivedItem.kind === 'closed'` (2026-09-18: AI-226 was exactly
 *  this case, "don't split" decided 2026-09-14, and had no token to express
 *  it, so it sat open forever). */
const CLOSED_TOKENS = new Set(['WONTFIX', 'DECLINED', 'SUPERSEDED', 'OBSOLETE']);

/** Classify a matched status token; anything DONE_STATUS_LINE_RE didn't
 *  already accept never reaches this function. Throws rather than silently
 *  defaulting to 'shipped' if the regex's alternation and this vocabulary
 *  ever drift apart — a future token added to one and not the other must
 *  fail loud, not misclassify. */
function classifyToken(token: string): 'shipped' | 'closed' {
  if (SHIPPED_TOKENS.has(token)) return 'shipped';
  if (CLOSED_TOKENS.has(token)) return 'closed';
  throw new Error(`unclassified archive status token: ${token} (add it to SHIPPED_TOKENS or CLOSED_TOKENS)`);
}

/** The docs-gate measure: chars with CRLF normalized to LF, so a CRLF file
 *  is never double-counted toward the budget. */
export function backlogBudgetChars(content: string): number {
  return content.replace(/\r\n/g, '\n').length;
}

/** brain-sweep's `istDateOf` convention (the helper there is module-private;
 *  the drain + this module's callers share THIS copy — the exact-commit-message
 *  drain test keeps it in lockstep with toIST). */
export function istDateOf(nowMs: number): string {
  const ist = toIST(new Date(nowMs));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}

export interface ArchivedItem {
  /** Numeric nnn of the `[AI-nnn]` heading id. */
  id: number;
  title: string;
  /** Verbatim record: the `#### [AI-nnn] ...` heading + its status paragraph
   *  (frag marker included), joined with the SOURCE file's line ending — the
   *  archive IS the record, nothing is re-rendered. */
  block: string;
  /** 'shipped' (DONE/BUILT/FIXED/COMPLETED/COMPLETE) or 'closed'
   *  (WONTFIX/DECLINED/SUPERSEDED/OBSOLETE — decided against, never built).
   *  Drives the visible split in `appendArchiveSection` (2026-09-18). */
  kind: 'shipped' | 'closed';
}

export interface ArchivePlan {
  /** BACKLOG.md content with the moved items (and one boundary blank per
   *  item) removed; byte-identical input when nothing moved. */
  content: string;
  moved: ArchivedItem[];
}

/**
 * Pure archive transform: parse, select DONE-class items, remove each item's
 * heading+paragraph plus exactly ONE trailing blank line (the blank BEFORE
 * the item remains as the separator — no doubled blanks, no `---` damage,
 * no whole-file blank normalization). Items below `# Archived items` are not
 * in any parsed section and can never move.
 */
export function planBacklogArchive(content: string): ArchivePlan {
  const model = parseBacklog(content);
  const eol = model.crlf ? '\r\n' : '\n';
  const moved: ArchivedItem[] = [];
  const drop = new Set<number>();
  for (const sec of model.sections) {
    for (const e of sec.entries) {
      const firstPara = e.paraEnd >= e.paraStart ? model.lines[e.paraStart] : '';
      const m = DONE_STATUS_LINE_RE.exec(firstPara);
      if (!m) continue;
      moved.push({
        id: e.id,
        title: e.title,
        block: model.lines.slice(e.headingLine, e.paraEnd + 1).join(eol),
        kind: classifyToken(m[1]),
      });
      for (let i = e.headingLine; i <= e.paraEnd; i++) drop.add(i);
      const after = e.paraEnd + 1;
      if (after < model.lines.length && model.lines[after].trim() === '') drop.add(after);
    }
  }
  if (moved.length === 0) return { content, moved };
  return { content: model.lines.filter((_, i) => !drop.has(i)).join(eol), moved };
}

/** The drain's auto-archive trigger: something to move AND (threshold crossed
 *  OR any merged section file is over its section budget). `contents` is the
 *  PRE-archive content of every merged section file — the drain decides from
 *  what it is about to write (the 2026-09-14 dead-arm lesson: post-archive
 *  always reads under budget when the movable items are the bloat). */
export function shouldAutoArchive(movedCount: number, contents: string[]): boolean {
  if (movedCount <= 0) return false;
  return (
    movedCount >= ARCHIVE_DONE_THRESHOLD ||
    contents.some((c) => backlogBudgetChars(c) >= BACKLOG_SECTION_BUDGET)
  );
}

/** Repo-relative forward-slash path of the day's archive file (the spec's
 *  exact shape; backlog/ is the established private home — completed-index.md
 *  and the archive-*.md files already live there). */
export function completedArchiveRelPath(date: string): string {
  return `backlog/completed-${date}.md`;
}

/** Heading that marks the closed-without-doing group inside a run's
 *  `## Archived <date>` section (2026-09-18) — read by a human, not parsed
 *  back by anything (an archived section is never re-read into the model). */
const CLOSED_GROUP_HEADING = '### Closed without doing (decided against, not shipped)';

/**
 * Append-only archive composition. A fresh file gets a one-line title plus
 * the run's `## Archived <date>` section; an existing file gets the section
 * appended (a same-day second run adds a second section — the file is
 * append-only, sections are never rewritten). Item blocks are verbatim.
 *
 * Shipped items render exactly as before this file's 2026-09-18 change — no
 * heading, flat list — so every run that moves only shipped items (all of
 * archive history to date) is byte-identical to the pre-change output.
 * Closed-without-doing items, only when at least one is present in this run,
 * render under `CLOSED_GROUP_HEADING` so a reader can tell shipped work from
 * a question that was decided against — the visibility AI-226's stuck-open
 * "don't split" decision was missing.
 */
export function appendArchiveSection(
  existing: string,
  date: string,
  items: ArchivedItem[],
): string {
  const shipped = items.filter((i) => i.kind === 'shipped');
  const closed = items.filter((i) => i.kind === 'closed');
  const groups: string[] = [];
  if (shipped.length > 0) groups.push(shipped.map((i) => i.block).join('\n\n'));
  if (closed.length > 0) {
    groups.push([CLOSED_GROUP_HEADING, '', closed.map((i) => i.block).join('\n\n')].join('\n'));
  }
  const section = ['## Archived ' + date, '', groups.join('\n\n')].join('\n');
  if (existing.trim() === '') {
    return ['# Backlog completed ' + date, '', section, ''].join('\n');
  }
  return existing.replace(/[\r\n]+$/, '') + '\n\n' + section + '\n';
}
