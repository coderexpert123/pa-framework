# Skills Guide

> Audience: anyone writing a custom skill.

## What a skill is

A skill is a Markdown file at `~/.pa/skills/<name>/skill.md` with two parts:

1. **YAML frontmatter** between `---` markers — declares when and how the skill runs.
2. **Markdown body** after the second `---` — the prompt sent to the worker LLM (or, if `cmd:` is set, ignored).

The skill's directory (`~/.pa/skills/<name>/`) can hold additional files (scripts, state JSON, fixtures). Set `cwd` to this dir for self-contained skills.

## Frontmatter schema

See [`docs/ARCHITECTURE.md`](ARCHITECTURE.md#skill-yaml-frontmatter-schema) for the full field list. Key fields:

```yaml
---
cron: "30 13,23 * * *"        # 5-field cron. Omit for manual-trigger only.
on_missed: latest             # 'latest' | 'all' | 'skip'
cwd: ${PA_HOME}/skills/myskill # ~ expands (to the OS home dir); ${VAR} env-interpolates.
                               # Use ${PA_HOME}, not ~/.pa, to reference the pa home — ~ always
                               # means the OS home directory, which is NOT the same thing if
                               # PA_HOME is overridden. ${PA_HOME} resolves correctly either way.
secrets:                       # env vars to inject from secrets.env
  - TELEGRAM_BOT_TOKEN
worker: codex                 # force a specific worker
no_fallback: true             # don't failover (use with worker:)
cmd: "python run.py"          # direct command — bypasses LLM
timeout: 1800                 # seconds; default 3600
idle_timeout: 120             # seconds without stdout before kill; default 300
inject_triggers: false        # inject other skills' trigger_descriptions
trigger_description: "Run when X..."  # used by other skills for chaining
telegram_output:              # optional — deliver output to Telegram
  chat_id: '${TELEGRAM_CHAT_ID}'
  thread_id: 0
  token_secret: TELEGRAM_BOT_TOKEN
---
```

## Body patterns

### Pure subprocess (cmd set)

```yaml
---
cron: "* * * * *"
cmd: "python reminders.py"
---

Process due reminders. (Body is ignored; cmd runs the script directly.)
```

The body becomes a comment for human readers. The skill is identical to running `python reminders.py` on a cron, except the framework provides:

- Lock acquisition (no concurrent runs of the same skill)
- Log capture (`~/.pa/logs/reminders/<timestamp>.json`)
- Timeout enforcement
- Catchup behavior
- Telegram output routing

### LLM-delegated (no cmd)

```yaml
---
cron: "0 9 * * *"
worker: codex
telegram_output:
  chat_id: '${TELEGRAM_CHAT_ID}'
  token_secret: TELEGRAM_BOT_TOKEN
---

Check the weather forecast for Bangalore for the next 7 days.
Output a Markdown summary with a single recommendation: "good week for outdoor", "mixed", or "stay in".
```

The worker (codex) receives the body as its prompt. Its output is captured and routed to Telegram via the `telegram_output` envelope. No script involved.

### Hybrid (subprocess + LLM)

```yaml
---
cron: "0 9 1 * *"
cwd: ${PA_HOME}/skills/expense-report
secrets:
  - TELEGRAM_BOT_TOKEN
worker: codex
---

# Monthly expense report

1. Run `python scripts/fetch_statements.py` to download statement PDFs.
2. Extract spending categories via `python scripts/extract.py`.
3. Summarize the month's spending in Markdown.
4. Send the summary to Telegram via `[pa notify --subject "Expenses" --body-stdin]`.

If any step fails, emit `[PA_META]: {"actions":[{"type":"retry_with_worker","reason":"..."}]}`.
```

The LLM runs each step using its tool-use capability (shell access), inserting decisions between steps.

## PA_META envelope — full reference

A skill's output can end with a single-line JSON envelope:

```
[PA_META]: {"actions":[{"type":"...", ...}]}
```

The framework parses + strips this line before delivering output to Telegram.

### Action types

#### `retry_with_worker`

```json
{"type": "retry_with_worker", "reason": "claude can't read PDFs"}
```

Tells the orchestrator: this worker can't complete the task. Failover to the next-priority worker.

#### `run_skill`

```json
{"type": "run_skill", "skill": "portfolio-reports"}
```

Trigger another skill automatically after this one finishes. The skill name is validated against the registered skills list. Recursion depth is capped at 3 to prevent loops.

#### `confirm_required`

```json
{"type": "confirm_required"}
```

Used by the bot's LLM responses (not scheduled skills). Replaces the explicit "Reply *yes* to confirm" text. The bot tracks a `pending_action` per topic; the user's next "yes"/"no" resolves it.

## Common patterns

### Telegram output routing

Pre-set the destination in `telegram_output:`. The output (or the LLM's final response) is sent there automatically.

```yaml
telegram_output:
  chat_id: '${TELEGRAM_BRIEFING_CHAT_ID}'
  thread_id: '${TELEGRAM_DAILY_BRIEFING_THREAD_ID}'
  token_secret: TELEGRAM_BOT_TOKEN
```

`${VAR}` is interpolated at skill-load time. `thread_id` accepts both literal numbers (`thread_id: 0`) and interpolated strings (`thread_id: '${THREAD_ID}'`) — the framework coerces back to Number.

### Worker override + no_fallback

```yaml
worker: codex
no_fallback: true
```

Use when only one worker can do the task (e.g., claude for long-context reasoning). Without `no_fallback`, the framework will try other workers if it fails.

### Secrets injection

```yaml
secrets:
  - TELEGRAM_BOT_TOKEN
  - STRAVA_REFRESH_TOKEN
  - OBSIDIAN_BRIEFS_DIR
```

Each named secret is read from `~/.pa/secrets.env` and exported as an env var into the worker's process. Skill body and `cmd` can reference them via `$VAR` (shell) or `process.env.VAR` (Node) or `os.environ['VAR']` (Python).

### Idempotent state

Skills that maintain state should use a JSON file in `cwd` and write atomically:

```python
# inside the skill's Python script
tmp = STATE_FILE + ".tmp"
with open(tmp, "w") as f:
    json.dump(new_state, f)
os.replace(tmp, STATE_FILE)
```

This guarantees no partial writes if the skill is killed mid-update.

### Multi-step pipeline with validation

```markdown
Step 1: python scripts/fetch.py
  Exit non-zero? STOP, emit [PA_META] retry_with_worker.
  Output JSON missing expected keys? STOP.

Step 2: python scripts/analyze.py
  ...
```

The LLM enforces inter-step validation. Combined with `[pa assert]` headers in script output (e.g., `[pa assert] emails.json listed=42`), the LLM can verify each step's output before proceeding.

### Calendar-based trigger

```yaml
cron: "0 6 * * *"  # check every morning
cwd: ${PA_HOME}/skills/holiday-alert
cmd: "python check_calendar.py"
```

The script reads a static calendar JSON file, fires only if today matches a configured date.

### Profile-driven filtering

```yaml
---
cron: "0 8 * * *"
worker: codex
secrets:
  - PA_PROFILE_PATH
---

Read the user profile at $PA_PROFILE_PATH. For each newsletter received
overnight, score by alignment with the user's interests. Emit only items
scoring > 7.
```

### Multi-destination delivery (Telegram + Obsidian + Drive)

```markdown
After generating the Markdown summary:
1. Send to Telegram via telegram_output (handled by framework).
2. Copy to Obsidian: `python scripts/write_obsidian.py "${OBSIDIAN_DIR}/today.md"`.
3. Upload to Drive: `python scripts/upload_to_drive.py today.md`.
```

### Git safety net

```markdown
Before modifying any tracked file:
  git -C "${PA_FRAMEWORK_ROOT}" add -A
  git -C "${PA_FRAMEWORK_ROOT}" commit -m "pre-skill snapshot"
```

Lets you `git revert HEAD` if the skill goes wrong.

## Skill chaining

Two mechanisms:

1. **`[pa run X]` text pattern** — if the worker's output contains a line matching `[pa run <skill-name>]`, the framework runs that skill after the current one finishes. Use for soft chaining.

2. **`run_skill` PA_META action** — declarative. Use for guaranteed chaining.

Both respect a 3-level recursion cap.

## Worker selection precedence

When the framework needs to choose a worker for a skill, it tries in this order:

1. **Explicit `--worker <name>`** on the `pa run` command line
2. **`skill.frontmatter.worker`** (if set)
3. **`topic_defaults` map** in config.yaml (if the bot is the caller and the topic matches)
4. **Priority-ordered list** of available workers (lowest priority number wins)

Within each step, unavailable workers (check failure, in cooldown) are skipped.

## Testing a skill

```powershell
# Dry-run once (ignoring schedule)
node pa/dist/bin/pa.js run my-skill

# Force a specific worker
node pa/dist/bin/pa.js run my-skill --worker codex

# Inject per-run operator arguments into the skill prompt (LLM skills only)
node pa/dist/bin/pa.js run my-skill --prompt-args "Focus on section 3 only"

# Pass extra args (after --)
node pa/dist/bin/pa.js run my-skill -- some additional context
```

Logs land at `~/.pa/logs/my-skill/<timestamp>.json`. Use `pa logs my-skill` to view recent runs.

For unit-test-style testing of skill-loading logic, see `pa/tests/skills.test.ts`.

## The self-improvement loop

The framework includes an autonomous self-improvement system that analyzes logs, proposes fixes, and applies changes through safety-gated validation.

### What it does

The self-improvement loop (`pa/src/self-improver.ts`) runs nightly and when triggered manually:

1. **Analyzes conversation patterns** — reads `~/.pa/conversation-history.jsonl` to extract user feedback and decision patterns
2. **Scans run logs** — runs `analyzer.ts`, `failure-analyzer.ts`, and `feedback-analyzer.ts` against `~/.pa/app.log.jsonl` to identify failures, anti-patterns, and improvement opportunities
3. **Routes alert census** — the 7-day alert census feeds deterministic proposals (defect fixes, human-gated alerts, repeat-unchanged hygiene)
4. **Drafts proposals** — `drafts.ts` consolidates findings into concrete `DraftProposal` objects with diffs and validation detail
5. **Floor-gated application** — `validator.ts` checks each proposal against safety floors before applying:
   - **Validation floor** — every change must pass its validation gate (broken fixes stay `pending`, never deploy)
   - **Protected-skills floor** — changes to git-workflow skills (commit, push, push-public, investigate-flagged) require explicit approval
6. **Commits fixes** — one pathspec commit per applied fix (roll back via `git revert` if needed)
7. **Audit trail** — every terminal decision logged to `~/.pa/self-improver-audit.jsonl` with diff, validation, and run-stats
8. **Evaluates impact** — `pa improvements [--since N]` recomputes before/after state from the audit trail

### Safety floors

The two safety floors are product features that ensure autonomous changes are safe and reversible:

- **Validation floor** — changes that fail validation (compilation errors, test failures) are never applied. They remain `pending` for manual review.
- **Protected-skills floor** — changes to critical workflow skills (commit, push, push-public, investigate-flagged) are flagged for approval rather than auto-applied.

### Evaluation and rollback

Run `pa improvements` to view the audit trail and assess impact. Each entry shows:

- The proposal (diff, rationale, validation result)
- Whether it was applied, rejected, or rolled back
- Run-stats baseline for before/after comparison

If a change causes issues, roll it back via `git revert <commit>` — the self-improver records the commit SHA in the audit trail.

### Example skill

The framework ships an example skill at `examples/skills/self-improver/skill.md` that demonstrates the loop's configuration and behavior. Copy it to `~/.pa/skills/` to adopt autonomous improvement into your deployment, or trigger it manually via:

```bash
pa run self-improver
```

The example skill runs at 22:20 UTC nightly and can also be triggered on-demand after skill changes or repeated failures.
