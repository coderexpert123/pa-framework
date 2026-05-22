---
cron: "30 13,23 * * *"
on_missed: all
cwd: "${PA_FRAMEWORK_ROOT}/projects/daily-mail-brief"
secrets:
  - TELEGRAM_BOT_TOKEN
  - TELEGRAM_CHAT_ID
  - TELEGRAM_BRIEFING_CHAT_ID
  - TELEGRAM_DAILY_BRIEFING_THREAD_ID
  - OBSIDIAN_BRIEFS_DIR
  - GEMINI_CMD
  - PA_FRAMEWORK_ROOT
worker: gemini
telegram_output:
  chat_id: '${TELEGRAM_BRIEFING_CHAT_ID}'
  thread_id: '${TELEGRAM_DAILY_BRIEFING_THREAD_ID}'
  token_secret: TELEGRAM_BOT_TOKEN
cmd: "python scripts/run_brief.py"
---

# Daily mail brief

Twice daily (13:30 and 23:30 UTC by default — adjust to your timezone), fetch new
Gmail headers, triage them via an LLM, and post a concise briefing to Telegram.

**Setup required before this skill works:**

1. Set up Google OAuth: place `google-credentials.json` + `google-token.json` in `~/.pa/`. See `projects/daily-mail-brief/README.md` for the OAuth flow.
2. Set `PA_FRAMEWORK_ROOT` in `~/.pa/secrets.env` to the absolute path of your cloned pa-framework. This skill's `cwd` interpolates it.
3. Set `TELEGRAM_BRIEFING_CHAT_ID` and `TELEGRAM_DAILY_BRIEFING_THREAD_ID` to the destination for briefings. These flow into `telegram_output` via env interpolation.
4. Optionally set `OBSIDIAN_BRIEFS_DIR` for Obsidian archival; if unset, archival is skipped silently.

**What it does:**

1. **Preflight auth check** (`scripts/preflight.py`) — verifies Gmail OAuth still works.
2. **Fetch headers** (`scripts/fetch_headers.py`) — pulls all email headers for the 12-hour window since last run.
3. **Triage** — the gemini worker classifies each as `ACTION_REQUIRED`, `NOTEWORTHY`, or `SKIP`.
4. **Fetch bodies** (`scripts/fetch_bodies.py`) — selective full-body fetch for ambiguous entries.
5. **Compose briefing** — markdown summary with sections per category.
6. **Send to Telegram** (`scripts/send_telegram.py`) — the worker output is also routed via `telegram_output` envelope.
7. **Obsidian archival** (optional) — `scripts/write_obsidian.py` copies the briefing to `${OBSIDIAN_BRIEFS_DIR}/${date}-{morning|evening}.md` if env var set.
8. **Skill chaining** — if any email triggers a downstream skill (e.g., a portfolio statement → `portfolio-reports`), emits `[pa run <skill>]` as a trigger.

This skill demonstrates:

- **`on_missed: all`** — catch-up mode processes all missed windows (up to 10), not just the latest.
- **`worker: gemini`** — explicit worker override (default would be priority-ordered).
- **Env interpolation** — `cwd`, `telegram_output.chat_id`, and `telegram_output.thread_id` all use `${VAR}` syntax substituted at skill-load time from `~/.pa/secrets.env`.
- **`secrets: [...]`** — env vars from secrets.env are injected into the spawned worker process.
- **Assertion contract** — `scripts/send_telegram.py` verifies the briefing's `[pa assert] emails.json listed={n}` header matches the actual email count before sending.

The body above is the prompt sent to gemini, but since `cmd:` is also set, the framework runs the Python script directly without delegating to the LLM. Comment out `cmd:` to switch to LLM-delegated mode where gemini receives the body as its prompt and orchestrates the Python scripts via tool use.
