---
cron: "0 16 * * *"
on_missed: latest
cwd: "${PA_FRAMEWORK_ROOT}"
secrets:
  - TELEGRAM_BOT_TOKEN
  - PA_FRAMEWORK_ROOT
  - TELEGRAM_CHAT_ID
worker: claude
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

1. **Pre-snapshot git commit (guarded)** — first run `node "$root/pa/dist/bin/pa.js" git-guard "$root"` and note its exit code (0 = git allowed, 1 = not allowed). If it exited 0: `cd "$root" && git add <the files from brain-files.json> && git commit -m "update-brain: pre-update snapshot"`. Allows post-hoc inspection of changes. Name the managed files explicitly; a blanket -A sweeps unrelated work into the snapshot. **Per-owner attribution:** when the deployment keeps an orphan ledger (JSONL, default `$pa_home/orphan-ledger.jsonl`, newest record per path wins), group the dirty managed paths by their latest owner (`owner_session`, else `owner_topic`; else unattributed) and commit one group per owner as `update-brain: pre-update snapshot — <owner|unattributed>` before the remainder. If it exited 1: git is not allowed for this deployment — skip this step AND step 3 entirely, proceed file-only, and add one line to your output: `git skipped: <the guard's printed reason>`.
   - **Coordination:** if the project provides a reservation command, list active reservations first and skip the pre-snapshot commit for any managed file another session currently holds — defer that file, do not abort the refresh. A nightly sweep-commit that stages whatever happens to be dirty will eventually commit an operator's in-progress work.
2. **For each file** in `brain-files.json`:
   - Read current content.
   - For each marker (e.g., `<!-- AUTO:SKILL-INVENTORY -->`), find the auto-managed section between the marker and the next marker / EOF.
   - Regenerate the section from live repo state (e.g., for SKILL-INVENTORY: run `pa list` and format the output).
   - **Safety gates**:
     - Refuse to write if any marker disappeared from the new content.
     - Refuse to write if new content is < 80% of old line count.
   - **Atomic write**: write to `<file>.tmp`, then `os.rename(<file>.tmp, <file>)`.
3. **Post-update commit (guarded)** — only when the step-1 `pa git-guard` exited 0: `git add -A && git commit -m "update-brain: auto-refresh"` if `git diff --quiet` returns non-zero (i.e., there were actual changes). When the guard said no, this step is a no-op — the step-2 file writes are the deliverable.
4. **Silent success** — if no files changed, exit without sending to Telegram.

If any step fails, emit a clear error message — the worker output is routed
to Telegram via `telegram_output`, so failures surface as alerts.

## What this skill demonstrates

- **`worker: claude` + `no_fallback: true`** — force a specific LLM with no
  failover. Use when only one LLM has the necessary tool access or training
  for the task.
- **Marker-based content insertion** — `<!-- AUTO:* -->` markers identify
  auto-managed sections within manually-edited files. The skill writes ONLY
  between markers, leaving the rest untouched.
- **Safety gates** — marker preservation + line-count floor catch broken
  regeneration before it overwrites good content.
- **Atomic file writes** — `.tmp` + rename ensures no partial writes.
- **Git integration (opt-in)** — when the guard allows it, pre/post snapshots make rollback trivial via `git revert HEAD`; run-only deployments (the `pa init` default, `git_workflow.enabled: false`) skip both commits and stay file-only.
- **Configurable file list** — `~/.pa/brain-files.json` keeps project-specific
  paths out of the skill body, so the same skill works for any project.

## Required setup

1. Set `PA_FRAMEWORK_ROOT` in `~/.pa/secrets.env` to your project root (a git work tree if you want snapshot commits — see `git_workflow.enabled` in docs/CONFIGURATION.md).
2. Edit `~/.pa/brain-files.json` (scaffolded as `{"root": "${PA_FRAMEWORK_ROOT}", "files": []}` by `pa init`) to opt into specific files.
3. The target files must contain matching `<!-- AUTO:* -->` markers — the skill won't insert markers automatically.
