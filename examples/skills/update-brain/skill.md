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
    {"path": "CLAUDE.md", "markers": ["<!-- AUTO:FILE-INVENTORY -->"]}
  ]
}
```

`path` is relative to `root` (env-interpolated). Add entries here to enroll
files into the auto-update pipeline.

## Execution

1. **Pre-snapshot git commit (deterministic sweep, guarded)** — first run `node "$root/pa/dist/bin/pa.js" git-guard "$root"` and note its exit code (0 = git allowed, 1 = not allowed). If it exited 0, run `node "$root/pa/dist/bin/pa.js" brain-sweep --skill-held-lock` — pass `--skill-held-lock` only when this skill's frontmatter declares `exclusive_resource: git-workflow` (the flag tells the sweep its own caller already holds the lock); a standalone run without it defers every otherwise-committable path while any lock holder is live instead of committing. The sweep commits dirty managed brain paths (`CLAUDE.md` and anything under `inventory/` — that managed set is fixed; other files enrolled in `brain-files.json` are rewritten but not swept) per owner group, and defers held paths — unattributed, reservation-held, recently-edited (last 15 minutes), or lock-held — WITHOUT committing them, so a nightly sweep can never commit another session's in-progress work; it sends one deferral alert when anything was deferred and prints one JSON object (`{committed,deferred,alertSent,refId}`). Non-zero exit means git failed: emit `⚠️ update-brain: aborted — brain-sweep failed (see stderr)` and stop. On success, derive report lines from the JSON: one `swept-owner: <label> — <n> file(s)` line per committed group and one `⚠️ Deferred: <path> — <reason>` line per deferred path. If the guard exited 1: git is not allowed for this deployment — skip this step AND step 3 entirely, proceed file-only, and add one line to your output: `git skipped: <the guard's printed reason>`.
2. **For each file** in `brain-files.json`:
   - Read current content.
   - For each marker (e.g., `<!-- AUTO:FILE-INVENTORY -->`), find the auto-managed section between the marker and the next marker / EOF.
   - Regenerate the section from live repo state (e.g., for FILE-INVENTORY: glob the source tree and format one bullet per file). Keep rosters that duplicate a CLI listing (e.g. a skill roster that `pa list` already prints) OUT of auto-loaded brain files — a pointer to the command is the budget-correct form.
   - **Safety gates**:
     - Refuse to write if any marker disappeared from the new content.
     - Refuse to write if new content is < 80% of old line count.
   - **Atomic write**: write to `<file>.tmp`, then `os.rename(<file>.tmp, <file>)`.
3. **Post-update commit (guarded)** — only when the step-1 `pa git-guard` exited 0: for each `path` in `brain-files.json` that step 2 actually rewrote, `git add <path>` UNLESS step 1's sweep JSON listed that same path under `deferred` (a path the sweep declined to commit stays declined for the rest of the run — C3 — even when its auto-managed section was also rewritten this cycle; leave it dirty for the next cycle rather than folding it into this commit). Then re-run `node "$root/pa/dist/bin/pa.js" git-guard "$root"` (AI-243: since 2026-09-14 the guard also refuses when a staged index path sits under another session's ACTIVE `pa claim` reservation — a bare `git commit` lands the whole index, so that refusal is what stands between this commit and sweeping a claimed staged file); on exit 1 do NOT commit and do NOT unstage — report the gate's reason verbatim and stop. On exit 0, `git commit -m "update-brain: auto-refresh"` if anything was staged. Never `git add -A` — a blanket add would silently commit whatever unattributed/held edit step 1 just deferred and alerted about, exactly the silent-swallow failure this skill exists to prevent. When the guard said no, this step is a no-op — the step-2 file writes are the deliverable.
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
