---
cron: "0 16 * * *"
on_missed: latest
cwd: "${PA_FRAMEWORK_ROOT}"
secrets:
  - TELEGRAM_BOT_TOKEN
  - PA_FRAMEWORK_ROOT
  - TELEGRAM_CHAT_ID
worker: gemini
no_fallback: true
telegram_output:
  chat_id: '${TELEGRAM_CHAT_ID}'
  thread_id: 0
  token_secret: TELEGRAM_BOT_TOKEN
---

# Update brain — auto-refresh project documentation

Daily at 16:00 (your timezone), rewrite auto-managed sections of project
documentation files (e.g., `CLAUDE.md`) from current repo state. Files to
update are configured in `~/.pa/brain-files.json`:

```json
{
  "root": "${PA_FRAMEWORK_ROOT}",
  "files": [
    {"path": "CLAUDE.md", "markers": ["<!-- AUTO:SKILL-INVENTORY -->", "<!-- AUTO:FILE-INVENTORY -->"]}
  ]
}
```

`path` is relative to `root` (env-interpolated). Add entries here to enroll
files into the auto-update pipeline.

## Execution

1. **Pre-snapshot git commit** — `cd "$root" && git add -A && git commit -m "update-brain: pre-update snapshot"`. Allows post-hoc inspection of changes.
2. **For each file** in `brain-files.json`:
   - Read current content.
   - For each marker (e.g., `<!-- AUTO:SKILL-INVENTORY -->`), find the auto-managed section between the marker and the next marker / EOF.
   - Regenerate the section from live repo state (e.g., for SKILL-INVENTORY: run `pa list` and format the output).
   - **Safety gates**:
     - Refuse to write if any marker disappeared from the new content.
     - Refuse to write if new content is < 80% of old line count.
   - **Atomic write**: write to `<file>.tmp`, then `os.rename(<file>.tmp, <file>)`.
3. **Post-update commit** — `git add -A && git commit -m "update-brain: auto-refresh"` only if `git diff --quiet` returns non-zero (i.e., there were actual changes).
4. **Silent success** — if no files changed, exit without sending to Telegram.

If any step fails, emit a clear error message — the worker output is routed
to Telegram via `telegram_output`, so failures surface as alerts.

## What this skill demonstrates

- **`worker: gemini` + `no_fallback: true`** — force a specific LLM with no
  failover. Use when only one LLM has the necessary tool access or training
  for the task.
- **Marker-based content insertion** — `<!-- AUTO:* -->` markers identify
  auto-managed sections within manually-edited files. The skill writes ONLY
  between markers, leaving the rest untouched.
- **Safety gates** — marker preservation + line-count floor catch broken
  regeneration before it overwrites good content.
- **Atomic file writes** — `.tmp` + rename ensures no partial writes.
- **Git integration** — pre/post snapshots make rollback trivial via
  `git revert HEAD`.
- **Configurable file list** — `~/.pa/brain-files.json` keeps project-specific
  paths out of the skill body, so the same skill works for any project.

## Required setup

1. Set `PA_FRAMEWORK_ROOT` in `~/.pa/secrets.env` to a git repo root.
2. Edit `~/.pa/brain-files.json` (scaffolded as `{"root": "${PA_FRAMEWORK_ROOT}", "files": []}` by `pa init`) to opt into specific files.
3. The target files must contain matching `<!-- AUTO:* -->` markers — the skill won't insert markers automatically.
