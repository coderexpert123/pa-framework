# Multi-Session Coordination Protocol — Rules 13-14

Companion to `docs/multi-session-protocol.md` (split out 2026-09-13, budget pressure — the main
doc was already over its 16,000-char budget before Rule 14 landed; see that file's own
same-file-trim doctrine for why a split beat a third same-day trim). Rule numbering is shared
with the main doc — read both as one sequence.

## Rule 13: backlog/open-*.md Are Written Only by the Drain

**Never edit or claim a `backlog/open-*.md` section file** — file with `pa backlog add` (or `pa backlog status` for an existing entry's status line); fragments land under gitignored `backlog/fragments/`, merged into the routed file every ~3 minutes by `backlog-fragments-drain`, its sole writer. A new section is made by filing `pa backlog add --section <new-slug>` — the drain auto-creates the file and its router row, then notifies; it also owns the `AUTO:BACKLOG-SECTIONS` table region of the `BACKLOG.md` router (preamble, Standard and archived-pointer regions stay human-editable). Run `pa backlog pending` before filing to dedup against recent filings (a few minutes' numbering lag is the accepted tradeoff). A legacy hand-edit is tolerated, never destroyed: the drain defers a 15-minute recent-edit window on a write-set file and merges over an older dirty one with a warning; the nightly brain-sweep covers the section files (attribute or defer+alert, AI-214 semantics). (2026-09-12; spec `plans/2026-09-12-brain-file-lock-contention-SPEC.md`; per-section split 2026-09-18, AI-316 — `plans/2026-09-18-backlog-router-split-SPEC.md`.)

An item is archivable once its status line matches `Type / P<digit> / <token> ...` (see `lib/backlog-archive.ts`), where token is a SHIPPED status (DONE, BUILT, FIXED, COMPLETED, COMPLETE) or a CLOSED status (WONTFIX, DECLINED, SUPERSEDED, OBSOLETE — decided against, never built). `pa backlog add`'s `--type`/`--pri` flags (defaults `Task`/`P2`) compose the OPEN-status shape automatically as `<Type> / P<pri> / OPEN — <body>`, one `pa backlog status` call away from archivable. `pa backlog status` rejects a `--status-line` that claims closure in prose (any of the above, plus RESOLVED, SHIPPED, LANDED) without matching that exact shape. (2026-09-18; AI backlog-archiver-outflow fix — before it, 0 of 67 live items matched the archiver's regex.)

Closed-without-doing tokens (2026-09-18) exist because a decided-against design question had no way to say so — AI-226 was settled 2026-09-14 ("don't split") but sat open forever for lack of a token. The archive file marks WONTFIX/DECLINED/SUPERSEDED/OBSOLETE items under a `### Closed without doing` heading, distinct from shipped work. Run `pa backlog pending` to see open items whose body claims closure but isn't archivable-shaped. Treat that list as CANDIDATES for a human to check, never a verdict — most matches are false positives (a quoted UI label, or partial-phase language).

## Rule 14: Interleaved Same-File Edits Land Whole

When two waves have uncommitted edits in the same file region, neither hunk-filters around the other's lines to stage only its own. The owners agree an order, then ONE lands the file WHOLE with BOTH waves named in the commit message — never split a shared file by hunk.

**Never audit a diff with `grep '^[+-][^+-]'`** to spot what changed. A markdown bullet line (`- foo`) becomes an added/removed line whose second character is also `-`, so the pattern excludes it — two false "data loss" alarms in one session traced back to exactly this. Before claiming content was dropped, count the marker (a heading, a row, a stub) both in the working tree and in `git show HEAD:<file>` — a real loss shows fewer in the tree; a grep-pattern artifact does not.
