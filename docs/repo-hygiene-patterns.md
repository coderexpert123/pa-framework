# Repository Hygiene — Gitignore Patterns and File Types

This reference catalog captures the exhaustive gitignore patterns and file type conventions that keep the repository clean. For the principles and decision tree, see the Repository hygiene section in root CLAUDE.md.

## Root-Level Gitignore Patterns

The root `.gitignore` is the source of truth. These patterns are auto-gitignored at repo root:

### Personal Data and Exports
- `/*.{pdf,jpg,jpeg,png,gif,db,csv,xlsx,docx}` — personal documents and exports
- `/*_email_*.txt` — email exports
- `/*_export_*.*` — any export files
- `/*turns*.{json,jsonl,txt}` — conversation turns

### Ad-Hoc Scripts and Outputs
- `/extracted_facts.md` — extraction outputs
- `/*.py` — ALL root-level Python (root is sparse, so any `.py` here is an ad-hoc/personal-data script; closes the `analysis.py`-class gap prefix patterns silently missed)

### Personal Notes and Action Items
- `/scratch_*` — scratch files
- `/notes-actions.md` — personal action items (should live in your external knowledge base)
- `/notes-preferences.md` — personal preferences (should live in your external knowledge base)
- `/notes-financial.md` — personal financial notes (should live in your external knowledge base)
- `/notes-contacts.md` — personal contacts (should live in your external knowledge base)
- `/notes-health.md` — personal health records (should live in your external knowledge base)

### Agent Outputs and Logs
- `/message_to_user.md` — agent outputs
- `/output.json` — JSON outputs
- `/output.md` — Markdown outputs
- `/skill_proposals.json` — skill proposals
- `/error_log.txt` — error logs
- `/oracle_output.txt` — oracle outputs

### LLM Worker Scratch Files
- `**/glm-[0-9]*` — an LLM worker "goes agentic" and writes its response — or its error — to a file at cwd instead of returning text. `run_brief.py` documents this failure mode inline. The `glm-*` form is zclaude naming the dump after its own model, anywhere in the tree. When a new pattern appears, add it to `.gitignore` + a `.gitignore-public` Boundary-lines registry row (then `placement_gate.py gen --gitignore`) + `docs/CONVENTIONS.md` + root CLAUDE.md in one edit.

**Note**: Personal-name patterns (e.g. medical .md reports at root) are intentionally NOT in `.gitignore` because the file ships to the public mirror — relies on agent discipline + file-type patterns instead; if one slips through, move it to `~/Documents/personal-imports/` manually.

## Everywhere Gitignore Patterns

These patterns apply recursively throughout the repository:

### Working Directories
- `**/scratch/` — scratch spaces
- `**/temp_*.{py,json,md,txt}` — temporary files
- `**/debug_*.{py,log}` — debug files
- `**/*-debug.log` — debug logs
- `**/test_repro.*` — test reproduction files

### Data Directories
- `**/data/{raw,processed,exports}/` — data pipeline directories (gitignored by default)

### Build Artifacts and Caches
- `**/__pycache__/` — Python bytecode
- `**/venv/` — Python virtual environments
- `**/dist/` — distribution builds
- `**/node_modules/` — Node.js dependencies

### Project-Specific Exclusions
- `projects/whatsapp-drafts/data/contacts.json` — personal contact cache, regenerable via `import_google.py`, never versioned. Note the `data/{raw,processed,exports}` globs do NOT cover files directly in `data/`.

### Historical Pattern
- `projects/*.py` (2026-07-27, AI-091) — no loose code directly under `projects/`; every project is a directory. Seven ad-hoc Gmail scripts had accumulated there (moved to `scratch/`), one embedding a partial insurance policy number.

## Anti-Patterns

**Do NOT use `git add -A` blindly at repo root.** Even though gitignore catches most patterns, new file types may not be covered yet. Always `git status` first; if you see unfamiliar untracked files at root, either move them to their proper home OR add a `.gitignore` rule before committing.

**Specifically: never use `git add -u` to stage "everything modified"** unless you've verified the modified set matches the commit's scope — that's how unrelated pending changes get swept into focused commits.

## When Adding New Patterns

**When a new class of file appears repeatedly** at the root (a new export format, a new agent output, a new tool's artifacts): add the pattern to `.gitignore` + a `.gitignore-public` Boundary-lines registry row (then `placement_gate.py gen --gitignore`) + `docs/CONVENTIONS.md` + root CLAUDE.md in one edit. Don't accept "we'll just remember" — encode it.

**For files the system GENERATES during daily working** (caches, state, per-run artifacts): `docs/CONVENTIONS.md` § "Generated / runtime files — decision tree" is the governing rule. The two load-bearing clauses are:
- The ignore entry ships in the same change as the writer
- Prefer explicit file paths over broad directory globs (the accidental-personal-data-commit vector + the `data/{raw,processed,exports}` hole, proven 2026-08-15)

Living state goes to `~/.pa/`, never the tree.

## Telegram Attachment Routing

Bot-downloaded attachments should land in `~/.pa/attachments/<chat_id>/<date>/` not at the bot's cwd. If you see attachments accumulating at repo root, that's a bot bug — flag for a fix (currently the bot's download path may default to cwd).

See also:
- `docs/CONVENTIONS.md` — full conventions doc (public-facing)
- `scratch/README.md` — scratch directory usage
