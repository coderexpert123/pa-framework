# Repository Conventions

> Audience: anyone working in a pa-framework deployment — substrate maintainers, project authors, and AI agents editing the codebase.

These conventions prevent the working tree from accumulating loose junk. They apply to BOTH the public framework repo and any private fork of it.

## Repository structure

### Top-level layout

```
<repo-root>/
├── README.md              ← public docs
├── LICENSE                ← public
├── CLAUDE.md              ← private brain (gitignored from public framework)
├── FILE_INVENTORY.md      ← private brain router (gitignored); real content in inventory/
├── inventory/             ← private brain sub-files, split out of FILE_INVENTORY.md for size (2026-08-07)
├── BACKLOG.md             ← private (gitignored)
├── backlog/               ← private brain sub-files, split out of BACKLOG.md for size (2026-08-07)
├── MEMORY.md              ← optional private memory index (gitignored, auto-managed when used)
├── AGENTS.md, GEMINI.md   ← private compatibility aliases; prefer filesystem links to CLAUDE.md
├── .gitignore             ← shared
├── .gitignore-public      ← private (whitelist for public repo)
├── git-public.cmd, .ps1   ← private wrapper scripts
├── pa/                    ← framework substrate (CLI, workers, scheduler, libs)
├── projects/              ← user projects + the shipped sample(s)
├── docs/                  ← public framework documentation
├── examples/              ← public sample configs, sample skills
├── plans/                 ← private design docs (gitignored)
└── scratch/               ← WIP, ad-hoc scripts (gitignored from both repos)
```

**Repo root is sparse.** Nothing besides the files above lives at root. Personal docs, exports, images, ad-hoc scripts, and conversation dumps all have proper homes elsewhere.

### Brain-file alias convention

Maintain one canonical root brain file: `CLAUDE.md`.

- `AGENTS.md` and `GEMINI.md` exist for tool compatibility, not as independent documents.
- Prefer symbolic links to `CLAUDE.md`.
- On Windows setups without symlink privilege, use hard links as the next-best aliasing fallback.
- If neither link type is available on a target machine, copied aliases are still derived artifacts and should be refreshed from `CLAUDE.md`, never edited first.

### Maintainer dual-repo topology

The maintainer deployment carries a private `.git/` repo (this working tree) plus a
public mirror at `pa-public/` — a genuinely separate, independently-cloned git
repository (own `.git/`, gitignored by the private repo), NOT a second `git-dir`
sharing this working tree's files. (Migrated to this shape 2026-08-06 after two
data-loss incidents under the old shared-tree pattern — see
[`DEPLOYMENT.md`](DEPLOYMENT.md) §3's warning for the full story if you're considering
that pattern for your own deployment.) In this setup:

- `pa public-sync` is the only mechanism that writes into `pa-public/` — it extracts
  the private repo's committed `HEAD` (never the working tree) via `git archive`, so
  uncommitted private content can never reach the public mirror by construction.
- `git-public.ps1` / `git-public.cmd` are thin aliases resolving into `pa-public/`'s
  own directory — the supported interface for public-repo status/add/commit/push.
- `.gitignore-public` is the whitelist boundary for what `pa public-sync` extracts.
- Private brain files (`CLAUDE.md`, `AGENTS.md`, `BACKLOG.md`, `plans/`, etc.) simply
  never get extracted into `pa-public/` — there's no shared filesystem for them to leak
  across.
- The private repo now tracks `docs/` and `examples/` too (a strict superset of what's
  public, as of 2026-08-06) — a brand-new file there needs a normal private commit,
  then shows up in the public mirror automatically on the next `pa public-sync`.

### Per-project structure

Every `projects/<x>/` follows the same layout:

```
projects/<x>/
├── README.md              ← what this project does
├── requirements.txt       ← Python deps (if any)
├── package.json           ← Node deps (if any)
├── scripts/               ← reusable executable code
├── tests/                 ← unit + integration tests
├── data/
│   ├── raw/               ← inputs (gitignored — external data sources)
│   ├── processed/         ← derived (gitignored by default)
│   └── exports/           ← final artifacts (gitignored)
└── scratch/               ← project-local WIP (gitignored everywhere)
```

Skills the framework ships as samples live under `examples/skills/<name>/skill.md` (public), NOT under `projects/`. User-installed skills live in `~/.pa/skills/<name>/` (outside the repo).

## Brain-file organization

This repo's brain files (`CLAUDE.md`, `FILE_INVENTORY.md`, `BACKLOG.md`, and their
extracted sub-files) had no size or split convention until 2026-08-07, despite one
already having been extracted once ("keep this file under its size budget," with no
number ever attached). This section is that convention, defined once so it doesn't need
rediscovering next time a brain file bloats.

**(a) Size budgets — char-based, not line-based.** This repo's prose is dense
single-paragraph-per-bullet, well past the ~80-100 chars/line the usual "~300-500 line
CLAUDE.md" community guidance assumes — a line budget is the wrong unit here.

| Class | Soft | Hard | Action at hard |
|---|---|---|---|
| Root `CLAUDE.md` (auto-loaded every session) | 40,000 chars | 48,000 chars | run `/shorten-brain`, extract a topic file |
| Directory-scoped `CLAUDE.md` (auto-loads on demand, stacks on root) | 8,000 chars | 12,000 chars | extract to `docs/` or a subsystem file |
| On-demand topic file (`docs/*.md`, `inventory/*.md`) — content a reader holds in mind while working | 12,000 chars | 16,000 chars | split along a natural fault line |
| Auto-managed glob-derived inventory file (an `inventory/*.md` file the `update-brain` skill rewrites wholesale from one `glob()` pattern) | 12,000 chars | 23,000 chars | see note below before splitting — raised 18k→20k 2026-08-30, 20k→23k 2026-09-03 (handover waves' new lib modules; per-module legitimate growth) |
| Router/index file (a file that replaced a monolith with pointers) | — | 4,000 chars | it stopped being a router; re-split |
| Evergreen audience-facing guide (the 9 evergreen `UPPERCASE.md` guides under `docs/`) | — | 24,000 chars | separate class from operational-detail docs |
| Knobs catalog (`docs/CONFIGURATION.md`) — one row per shipped knob, grows monotonically with the code | — | 25,000 chars | documented raise-class (same as the job catalog): raise per-knob growth, trim nothing (24k→25k 2026-09-04, `PA_CDISK_*` rows) |
| Append-only archive file (`backlog/archive-*.md`, `backlog/not-valid.md`) — looked up by ID, never read front to back | — | no hard ceiling | see note below |
| Completed-item lookup index (`backlog/completed-index.md`) — one row per archived item, grows monotonically with shipped work, never auto-loaded | 16,000 chars | 21,000 chars | raise this row rather than splitting; splitting breaks its "every item exactly once, in one place" contract |
| Open-program body file (`backlog/programs-*.md`) — bodies lifted out of `BACKLOG.md`, looked up by ID | — | no hard ceiling | same class as the archives |

**Budget-pressure doctrine (operator directive 2026-09-03, after a six-trim night):**
modularize at natural fault lines proactively; raise documented ceilings for
monotonic-growth classes; **never trim the same file twice in a day — the second trim
triggers a contract-look, and the contract picks the response** (auto-managed glob-derived
→ raise; every-item-exactly-once index → raise; genuine prose/scope growth → split at the
fault line — never a blanket split, the two raise-classes are exactly where splitting does
silent damage); and the root of any index chain must stay auto-loaded. **A trim
removes verbosity, duplication, and iteration residue — never a rule, invariant,
gotcha, or anti-pattern warning; if a trim would lose a rule, that is a split,
not a trim** (operator directive 2026-09-03). When in doubt,
index — but doubt should first trigger a look at the file's contract. Enforced mechanically
by docs-lint's same-file-trim counter (second trim in 24h fails with this clause's ref).

**Note on the auto-managed inventory row**: this class exists because its size is bounded
by *how many source files a glob pattern matches*, not by narrative verbosity — splitting
one further means either minting another `glob()` pattern + marker pair (fragmenting
`~/.pa/skills/update-brain/skill.md`'s otherwise-simple 1-glob-to-1-file mapping into
content-based routing within a single directory) or shrinking per-entry descriptions
below what a "do not regress" invariant needs. Prefer raising this specific row's ceiling
again over either of those. `inventory/telegram-bot.md` (2026-08-07, 37 entries across
`projects/telegram-bot/src/*.ts`) is the first file at this ceiling — if
`projects/telegram-bot/src/` keeps growing, the next natural fault line is pulling its
crash-recovery/delivery cluster (`orphan-reaper.ts`, `pending-dispatches.ts`,
`recovery-gate.ts`, `delivered-store.ts`, `dlq.ts`, `watermark.ts`, `health.ts`) into its
own `inventory/telegram-bot-reliability.md`, at the cost of the routing complexity above.

**Note on the archive-file row**: `backlog/archive-*.md` holds completed `BACKLOG.md`
items verbatim, by design (the 2026-08-07 dedupe pass exists specifically because a prior
half-archived state had already lost the discipline of "one full body, one place" —
shrinking these bodies to fit a budget would reintroduce that same failure mode). Their
size tracks how much work shipped in that window, not anything a reader holds in mind —
nobody reads an archive front to back, they jump to one `#### [AI-nnn]` id via
`backlog/completed-index.md`. Splitting one further is fine when it falls on a natural
date/cluster boundary (and the resulting file stays a coherent era, not an arbitrary char
count), but never split PURELY to hit a number — that would separate cross-referenced
items (e.g. the crash-survival cluster AI-095/096/097/099) that must stay findable
together. `backlog/archive-2026-06-07.md` (31.7K, dominated by 4 large incident
write-ups) is the first file to test this judgment and was deliberately left unsplit.

Anthropic's own qualitative test (`code.claude.com/docs/en/best-practices`) is the
underlying rule the numbers exist to approximate: *"For each line ask: would removing
this cause Claude to make mistakes? If not, cut it. Bloated CLAUDE.md files cause Claude
to ignore your actual instructions."* Include: bash commands Claude can't guess, code
style differing from defaults, testing instructions, repo etiquette, project-specific
architectural decisions, dev-environment quirks, non-obvious gotchas. Exclude: anything
derivable from reading code, standard conventions, detailed API docs (link instead),
information that changes frequently, long tutorials, file-by-file descriptions,
self-evident practices.

**(b) Three mechanisms, and when each applies:**
1. **Directory-scoped `CLAUDE.md`** — native to Claude Code, automatic, no code needed:
   a directory's own `CLAUDE.md` auto-loads whenever Claude reads a file in that
   directory (root `CLAUDE.md` always loads; parent-directory `CLAUDE.md` files load with
   it in a monorepo). Use for content genuinely scoped to one subsystem/directory that
   should fire *proactively* whenever anyone works there. Precedents:
   `projects/fitness-data-sync/CLAUDE.md`, `projects/travel-planner/CLAUDE.md`, and
   `projects/telegram-bot/CLAUDE.md`.
2. **A plain `docs/*.md` / `inventory/*.md` / `backlog/*.md` file plus a prose pointer**
   ("Read X before touching Y") — on-demand, manual, read only when an agent follows the
   pointer. Use for cross-cutting content, or content needed only for specific rare
   operations.
3. **`@path/to/import` syntax — almost never.** It *eagerly inlines* the target file's
   full content into every session that loads the importing file, which is the opposite
   of size reduction. Only legitimate for content that genuinely must load every session
   but is factored out purely for maintainability. Do not "optimize" a prose pointer into
   an `@import` — that silently re-bloats the auto-loaded budget the pointer exists to
   avoid.

**(c) Tree-depth rule.** Max depth 2 below repo root (`docs/<topic>.md`,
`inventory/<area>.md`, `backlog/<area>.md`). Only go to `docs/<subsystem>/<topic>.md` when
a single flat directory would exceed 8 *operational-detail* files — the 9 evergreen
`UPPERCASE.md` guides are a permanent flat exception and don't count toward that trigger.
Never create a directory solely to host a `CLAUDE.md` — only attach one to a directory
that already exists for code reasons.

**(d) Private/public constraint.** `.gitignore-public` is a whitelist (`/*` plus explicit
re-includes) and `docs/` **is** re-included — anything under `docs/` publishes to
`pa-framework`. Private-only extracted content (e.g. split out of `FILE_INVENTORY.md` or
`BACKLOG.md`) goes in a new root directory that is *not* on that whitelist — private by
omission, the same way `plans/` already is. This is why extracted private detail lives at
repo root (`inventory/`, `backlog/`), never nested under `docs/`.

**(e) Naming.** Root/auto-loaded brain files: `UPPERCASE.md`. Evergreen audience-facing
`docs/` guides: `UPPERCASE.md`. Extracted operational-detail files: `lowercase-hyphen.md`
with H1 `# <Title> — operational detail`. Split sub-files of a router: `<area>-<slug>.md`
inside the router's own new directory.

## Naming conventions

### Patterns auto-gitignored at repo root

These never live at the root and are caught by `.gitignore`:

| Pattern | Caught by | Right home |
|---|---|---|
| `/*.{pdf,jpg,jpeg,png,gif}` | external imports | `~/Documents/personal-imports/<date>/` or `<project>/data/exports/` |
| `/*.{db,csv,xlsx,docx}` | data files | `<project>/data/` |
| `/*_email_*.txt`, `/*_export_*.*` | email/data exports | `<project>/data/exports/` |
| `/*turns*.{json,jsonl,txt}` | conversation analyses | `<project>/data/exports/` or scratch |
| `/analyze_*.py`, `/check_*.py`, `/find_*.py` | ad-hoc scripts | `scratch/` or `<project>/scripts/` |
| `/fetch_*.py`, `/search_*.py`, `/extract_*.py` | ad-hoc fetchers | `scratch/` or `<project>/scripts/` |
| `/notes-actions.md`, `/notes-preferences.md`, etc. | External knowledge-base files | `<your-kb-root>/` (outside the repo) |
| `/message_to_user.md`, `/output.json`, `/output.md`, `/skill_proposals.json`, `/error_log.txt`, `/oracle_output.txt`, `**/glm-[0-9]*` | LLM worker "going agentic" — writes its response (or its error) to a file at cwd instead of returning text; `glm-*` is zclaude naming the file after its own model (glm-4.7, glm-5.2[1m]), in whatever subdir its cwd was | delete; not a real output path for any script (confirmed via full-repo grep) |

The last row keeps growing because the failure mode keeps resurfacing under new filenames — `/output.md` and `/error_log.txt` were added on 2026-07-21, `/oracle_output.txt` on 2026-08-08 (the `oracle` skill's step 1 script prints raw profile+briefing data to stdout by design for its worker to synthesize per step 6 — the worker dumped that raw stdout to a file instead of returning the synthesized text), and `**/glm-[0-9]*` on 2026-08-13 (zclaude's model-named dumps, root AND subdirs — the first instance of the class that is a glob, not a fixed filename, because the name tracks whatever model zclaude runs). When you find a new one, add it to `.gitignore`, `.gitignore-public`, this table, and the private brain's hygiene section in the same edit. A partial update is how the pattern list falls behind reality.

### Patterns auto-gitignored everywhere (any depth)

| Pattern | Caught by | Reason |
|---|---|---|
| `**/scratch/` | repo + per-project scratch | WIP — never tracked |
| `**/temp_*.{py,json,md,txt}` | temp-prefixed artifacts | one-off, should be in scratch |
| `**/debug_*.{py,log}`, `**/*-debug.log` | debug outputs | transient |
| `**/test_repro.*` | repro scripts | session-local |
| `**/data/{raw,processed,exports}/` | project data dirs | per-project external data |
| `projects/whatsapp-drafts/data/contacts.json` | contact directory cache | personal data (1200+ phone numbers), regenerable via `import_google.py`; never versioned — the private repo's no-history-rewrite policy would make one accidental commit permanent |
| `**/__pycache__/`, `**/venv/`, `**/.venv/` | Python build/env | universal |
| `**/node_modules/`, `**/dist/`, `**/*.tsbuildinfo` | Node build/env | universal |

## Generated / runtime files — decision tree

For any file the system *generates* during daily working (as opposed to files
a human or agent authors as work product), ask three questions — they fully
determine its handling:

1. **Is it regenerable?** (external source of truth exists — an API, an
   import, a re-runnable computation)
2. **Who must read it?** (only pa/Python/Bot code — which can read any path —
   vs. sandboxed worker CLIs, which effectively read only the repo tree)
3. **Is it state or cache?** (appended-to/mutated as living state, vs a
   rebuildable snapshot)

| Answers | Handling | Examples |
|---|---|---|
| regenerable + pa-only readers | `~/.pa/` (runtime home) | `worker-capabilities.json`, profile.json |
| regenerable + **worker CLI readers** | in-tree `data/` + **explicit-file** ignore in ALL FOUR ignore homes (`.gitignore`, `.gitignore-public`, this file's table, root CLAUDE.md) — same change that introduces the writer | `whatsapp-drafts/data/contacts.json` |
| living state, cross-process readers | `~/.pa/` ALWAYS — never the tree (a mutating tracked file dirties the tree on every write and trips clean-worktree floors like the code-fixer's) | `pending-dispatches.json`, `worker-pids/`, topic states, DLQ |
| per-run personal artifacts | in-repo path + explicit ignore (delivery convenience beats relocation) | `daily-mail-brief/emails.json`, `data/alerts_sent.jsonl` |
| NOT regenerable + personal (primary data) | outside the repo (`~/Documents/personal-imports/`, or `~/.pa/` + secrets-backup coverage) — the private repo MAY hold personal data, but only as a deliberate hand-made commit, never via an auto-commit sweep | contact exports, statements, ID scans |
| agent-authored judgment/work product | tracked normally (private repo; personal data acceptable) | `master-sheet.md`, plan files |

Two hard rules that close the incident class (derived 2026-08-15, the
contacts.json sweep):

- **The ignore entry ships with the writer.** Any change that introduces a
  generated file's write path adds its ignore entry in the same change — the
  `commit` skill's survey and the nightly `update-brain` sweep treat
  untracked-but-unignored files as pending work, which is exactly how an
  accidental personal-data commit happens.
- **Prefer explicit file paths over broad directory globs in ignore
  patterns.** The `**/data/{raw,processed,exports}/` convention did not cover
  files directly in `data/` — broad globs create false confidence; an exact
  path cannot drift.
- If a sweep already captured personal data and the commit is **local-only**,
  the sanctioned remedy is a surgical pre-push rebase (the repo's no-rewrite
  policy's one exception — see memory `project_session_2026_08_15_lessons`);
  after push, it is permanent by policy, so the two rules above are the real
  defense.

## The `scratch/` directory

A gitignored directory at the repo root for WIP, ad-hoc analyses, and throwaway scripts. See `scratch/README.md` for full rules.

**Promotion path**: if a scratch script proves useful and gets reused, promote it to either:
- `pa/scripts/<name>.py` — if generically useful
- `projects/<x>/scripts/<name>.py` — if domain-specific
- `examples/skills/<name>/` — if a publicly-shareable skill

If you never use it again, delete it.

## Where personal data lives

**Never at repo root.** Personal documents (medical, financial, family), photos, identity scans, and personal email exports all live outside the repo:

```
~/Documents/personal-imports/<YYYY-MM-DD>/
├── personal-docs/         ← PDFs, medical reports, payslips, etc.
├── email-exports/         ← *_email_*.txt files dumped by Gmail fetchers
├── conversation-analyses/ ← turns_*.json and similar dumps
└── kb-snapshots/          ← misplaced Ecosystem KB copies (reconcile with KB)
```

This keeps the working tree small and prevents personal data from leaking into either repo.

## How to add new content (decision tree)

When you create a new file:

1. **Is it framework code (CLI, worker, lib, bot)?** → `pa/src/` or `projects/telegram-bot/src/`
2. **Is it a project-specific feature?** → `projects/<x>/scripts/` (existing project) or `projects/<new-name>/` (new project)
3. **Is it a sample template for public users?** → `examples/skills/<name>/`
4. **Is it framework documentation?** → `docs/`
5. **Is it WIP / throwaway?** → `scratch/`
6. **Is it personal data?** → `~/Documents/personal-imports/<date>/`
7. **Is it user runtime state?** → `~/.pa/` (outside repo)
8. **Is it a one-off Ecosystem KB note?** → your KB root (outside repo)

If none of these fit, you're probably creating something that shouldn't exist. Reconsider.

## Enforcement

- **`.gitignore`** catches most patterns automatically — `git add` won't include them.
- **`pa health`** doesn't yet check for repo-root hygiene; consider a future check.
- **AI agents** editing the codebase consult `CLAUDE.md` § "Repository hygiene" for the rule set; new files land in their proper home by default.
- **AI-agent entrypoints** should converge on `CLAUDE.md`; if `AGENTS.md` or `GEMINI.md` drift from it, fix the aliasing rather than maintaining parallel prose.

## Merging to `main` (2026-07-23)

`main` is a protected branch: `required_status_checks` (all 3 CI platforms +
the PII scan) plus `enforce_admins: true`. A direct `git push origin main`
is rejected outright, for the repo owner too — every change, however small,
goes through a branch + PR that must show all checks green before it can
merge. This closes the gap where CI and the PII scan were only ever
*reporting* status after a push had already landed, not actually gating it.

## When to update these conventions

Whenever a NEW class of file recurs (e.g., a new export format starts landing at root), add it to the appropriate `.gitignore` pattern + this doc + `CLAUDE.md`. Don't accept "we'll just remember to put it in the right place" — encode it. The same applies to brain-file organization: if the § "Brain-file organization" size budgets or mechanism choices stop fitting reality, update that section rather than letting a new ad-hoc pattern grow unencoded next to it.

## See also

- `scratch/README.md` — scratch directory rules
- `CLAUDE.md` § "Repository hygiene" — agent-facing rules (private brain)
- `docs/ARCHITECTURE.md` — broader framework design
- `.gitignore` and `.gitignore-public` — actual enforcement
- § "Brain-file organization" above — size budgets and the directory-`CLAUDE.md` /
  `docs/*.md` / `@import` mechanism choice
