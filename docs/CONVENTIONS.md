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
├── BACKLOG.md             ← private (gitignored)
├── MEMORY.md              ← optional private memory index (gitignored, auto-managed when used)
├── DEBUGGING.md           ← private (gitignored)
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

The maintainer deployment uses the advanced dual-`.git` pattern described in [`DEPLOYMENT.md`](DEPLOYMENT.md): the same working tree carries a private `.git/` repo and a public `.git-public/` mirror. In that setup:

- `git-public.ps1` / `git-public.cmd` are the supported interface for public-repo operations.
- `.gitignore-public` is the whitelist boundary for what can ship to the public framework.
- Private brain files (`CLAUDE.md`, `AGENTS.md`, `BACKLOG.md`, `plans/`, etc.) remain outside the public mirror even though they share the same filesystem tree.
- Because the private repo's `.gitignore` deliberately ignores public-only paths like `/docs/` and `/examples/`, brand-new files there may need `git-public add -f <path>` before they show up in the public mirror.

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
| `/Action Items.md`, `/Preferences.md`, etc. | Ecosystem KB files | `<KB-root>/Ecosystem KB/` (outside the repo) |

### Patterns auto-gitignored everywhere (any depth)

| Pattern | Caught by | Reason |
|---|---|---|
| `**/scratch/` | repo + per-project scratch | WIP — never tracked |
| `**/temp_*.{py,json,md,txt}` | temp-prefixed artifacts | one-off, should be in scratch |
| `**/debug_*.{py,log}`, `**/*-debug.log` | debug outputs | transient |
| `**/test_repro.*` | repro scripts | session-local |
| `**/data/{raw,processed,exports}/` | project data dirs | per-project external data |
| `**/__pycache__/`, `**/venv/`, `**/.venv/` | Python build/env | universal |
| `**/node_modules/`, `**/dist/`, `**/*.tsbuildinfo` | Node build/env | universal |

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

## When to update these conventions

Whenever a NEW class of file recurs (e.g., a new export format starts landing at root), add it to the appropriate `.gitignore` pattern + this doc + `CLAUDE.md`. Don't accept "we'll just remember to put it in the right place" — encode it.

## See also

- `scratch/README.md` — scratch directory rules
- `CLAUDE.md` § "Repository hygiene" — agent-facing rules (private brain)
- `docs/ARCHITECTURE.md` — broader framework design
- `.gitignore` and `.gitignore-public` — actual enforcement
