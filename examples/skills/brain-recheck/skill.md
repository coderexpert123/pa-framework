---
name: brain-recheck
description: On-demand audit of Agentic Brain integrity and consistency
cwd: "${PA_FRAMEWORK_ROOT}"
secrets:
- TELEGRAM_BOT_TOKEN
worker: agy
# agy's --add-dir is REPEATABLE (one flag per directory) — it is NOT gemini's
# single comma-separated --include-directories. See the note at the bottom of
# this file for why these two directories are widened at all.
worker_args:
- "--add-dir"
- "${PA_HOME}"
telegram_output:
  chat_id: '${TELEGRAM_CHAT_ID}'
  thread_id: 0
  token_secret: TELEGRAM_BOT_TOKEN
---

You are the Agentic Brain auditor for this Personal Assistant project.

**All of the checking is done by a committed, tested script. You do not count,
stat, or compare anything yourself — you only format its output.** Every number
in the report below comes from the script's JSON. Do not recompute, "sanity
check", or adjust any of them; do not add issues the script did not report.

## Step 1 — Run the scan (absolute path; the worker shim forces cwd to the repo root)

```
python "${PA_FRAMEWORK_ROOT}/examples/skills/brain-recheck/brain_recheck_scan.py"
```

It prints one JSON object on stdout and always exits 0. Shape:

```
{
  "index":   { "total": N, "completed": N, "pending": N, "living": N,
               "superseded": N, "unknown": N },
  "skills":  { "claimed": {...} | null, "actual": {...} },
  "backlog": { "total": N, "pending": N, "done": N },
  "summary": { "issues": N, "critical": N, "warnings": N, "info": N },
  "issues":  [ { "severity": "critical|warning|info",
                 "kind": "BROKEN LINK | COUNT MISMATCH | OVERDUE PLAN |
                          STALE PENDING | AGED BACKLOG ITEM | STALE MEMORY |
                          MISSING BRAIN FILE | UNCLASSIFIED PLAN STATUS",
                 "detail": "..." } ]
}
```

If the command fails or prints something that is not JSON, emit only:
`*Brain Recheck* — scan script failed: <first line of the error>` and stop.

## Step 2 — Format it

Emit only this block — nothing else. Map every `issues[]` entry to one bullet,
critical first, then warnings, then info, preserving the script's order within
each severity. Use the emoji for the severity: 🔴 critical, 🟡 warning,
🔵 info. Copy `kind` and `detail` verbatim.

*Brain Recheck — [today's date, IST]*

*Summary*
• {summary.issues} issues found ({summary.critical} critical, {summary.warnings} warnings, {summary.info} info)
• INDEX.md: {index.total} total, {index.completed} completed, {index.pending} pending
• Skills: {skills.actual.total} on disk ({skills.actual.scheduled} scheduled, {skills.actual.manual} manual)
• Backlog: {backlog.pending} pending of {backlog.total}

*Issues* (omit this section entirely if `issues` is empty)
🔴 KIND — detail
🟡 KIND — detail
🔵 KIND — detail

*Health* (only when `issues` is empty)
✅ All brain files healthy.

If there are more than 15 issues, list the criticals and warnings in full, then
collapse the info-level ones to a single line: `🔵 +N more info-level items (run
the scan for the list)`.

Do not include conversation content, secrets, or file contents in the report.

---

**Why the skill looks like this** (do not "improve" it back):

- The counting used to be done by the worker and was wrong in all four gemini
  runs of the 2026-07-16..21 audit window — it reported 43 completed INDEX.md
  rows against 62 actual on 2026-07-17. `CLAUDE.md` is explicit that
  deterministic decisions belong in a committed script invoked by absolute
  path; that rule exists because LLM date math silently killed a whole run of
  scheduled alerts.
- Two of the six check families (`~/.pa/skills` count) were silently dropped
  in all four runs with "Path not in workspace": the worker shim `cd`s to the
  repo root and the worker sandboxes its file tools to that tree. The script
  has no sandbox, and the `worker_args: --add-dir` above widens the worker's
  view of `~/.pa` for ad-hoc follow-up.
- `worker: agy` since 2026-07-21 (was `worker: gemini` + `no_fallback: true`).
  `worker_args` is passed to EVERY worker in the failover chain (see
  `pa/src/commands/run.ts`), so the flag it carries decides how much of the
  chain survives. `--include-directories` is understood by gemini alone, which
  is why this skill used to be pinned; `--add-dir` is understood by agy AND by
  claude/zclaude, so the pin is no longer needed and has been removed. gemini
  and codex will reject `--add-dir` and fail fast — that costs one cheap
  attempt each and the chain still lands on a worker that honours it. Do not
  re-pin this skill to restore "correctness"; the 2026-07-16 capacity event
  turned exactly that pin into ~93 failed runs with no failover.
