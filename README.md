# pa-framework

> Multi-CLI personal-assistant orchestrator with rate-limit-aware failover, Markdown-based skills, and a Telegram bot.

`pa` is a substrate, not an application. You define skills as Markdown files with YAML frontmatter; the dispatcher runs them on a cron schedule, routes execution through the highest-priority available worker (Claude Code / Gemini CLI / OpenAI Codex / zClaude), persists state, and pushes output to Telegram (or to disk, or to both). When one CLI is rate-limited, the dispatcher fails over to the next. When a skill's output contains a `[PA_META]: {"actions":[...]}` envelope, the dispatcher can trigger downstream skills automatically.

Use it to build your own personal automation: inbox triage, periodic reports, reminders, calendar checks, KB updates. One sample project is included as a reference (`projects/daily-mail-brief/`).

## Architecture (5 layers)

```
┌─────────────────────────────────────────────────────────────┐
│  Communication       projects/telegram-bot/                 │
│  (Telegram bot, forum topics, DLQ, conversation archive)    │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│  Skill substrate     ~/.pa/skills/<name>/skill.md           │
│  (YAML frontmatter + Markdown body, PA_META action chain)   │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│  Orchestrator        pa/src/{scheduler,blackboard,...}      │
│  (cron eval, locking, structured logging, dedup notify)     │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│  Worker pool         pa/src/{workers,worker-exec,...}       │
│  (claude/gemini/codex/zclaude failover, rate-limit parsing) │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│  Auth substrate      ~/.pa/google_auth.py + OAuth bridge    │
│  (desktop + Telegram/mobile Google OAuth recovery)          │
└─────────────────────────────────────────────────────────────┘

Domain projects (built on top): projects/daily-mail-brief/ — sample
```

Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quickstart (abbreviated)

```bash
# Build (same on all platforms)
cd pa && npm install && npm run build && cd ..
cd projects/telegram-bot && npm install && npm run build && cd ../..

# Scaffold ~/.pa/
node pa/dist/bin/pa.js init

# ── Telegram setup (do this in the Telegram app first) ─────────────────────
#
# Option A — DM mode (simplest, no group needed):
#   1. Message @BotFather → /newbot → follow prompts → copy the token
#   2. Message @userinfobot → it replies with your numeric chat ID (positive number)
#   3. Add both to ~/.pa/secrets.env:
#        TELEGRAM_BOT_TOKEN=<token>
#        TELEGRAM_CHAT_ID=<your personal chat id>
#
# Option B — Forum/topic mode (recommended: separate topics per skill/alert):
#   1. Same as A step 1 — create a bot via @BotFather, copy the token
#   2. Create a Telegram group → Settings → Group type → enable "Topics"
#   3. Add your bot to the group as an admin (allow "Manage topics" permission)
#   4. Get the group's chat ID: forward any group message to @userinfobot
#      (it will be a negative number, e.g. -1001234567890)
#   5. Add to ~/.pa/secrets.env:
#        TELEGRAM_BOT_TOKEN=<token>
#        TELEGRAM_CHAT_ID=<negative group id>
#   6. After the bot is running (see below), run:
#        node pa/dist/bin/pa.js bot setup-topics
#      This auto-creates the topic structure (skills, alerts, coding, etc.)
#      from examples/topics-template.json — no manual topic creation needed.
#
# ── LLM CLI config ──────────────────────────────────────────────────────────
#
# If your LLM CLIs (claude / gemini / codex) aren't in PATH, edit
# ~/.pa/config.yaml and set the `command:` field to each CLI's absolute path.

# ── Choose your default LLM worker ──────────────────────────────────────────
#
# Run this to see which CLIs were found:
node pa/dist/bin/pa.js workers
#
# If more than one shows as available, ask the user which they prefer.
# Then open ~/.pa/config.yaml and move the preferred worker to the TOP of the
# `workers:` list — the dispatcher always tries workers in order, so first = default.
# (You can change the active model per Telegram topic later with /model <name>.)

# Copy a sample skill
cp -r examples/skills/reminders ~/.pa/skills/          # macOS / Linux
# Copy-Item -Recurse examples/skills/reminders ~/.pa/skills/   # Windows PowerShell

# Verify
node pa/dist/bin/pa.js list
node pa/dist/bin/pa.js health

# Register the catchup scheduler (all platforms)
node pa/dist/bin/pa.js schedules sync

# Run the bot
bash projects/telegram-bot/run-bot.sh &               # macOS / Linux
# pwsh projects/telegram-bot/run-bot.ps1              # Windows PowerShell
```

Detailed walkthrough: [`docs/QUICKSTART.md`](docs/QUICKSTART.md). For deployment patterns (simple fork vs dual-`.git`), see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## What's included

- **`pa/`** — CLI dispatcher: `pa run`, `pa list`, `pa schedules`, `pa health`, `pa notify`, `pa bot restart`, `pa learn`, ...
- **`projects/telegram-bot/`** — Long-poll Telegram bot with forum-topic support, conversation archive, DLQ, sentinel-based graceful shutdown.
- **`projects/daily-mail-brief/`** — Reference sample: Gmail triage → LLM summary → Telegram + optional Obsidian archival.
- **`projects/google-oauth-redirect/`** — Static bridge page for Telegram/mobile Google OAuth recovery.
- **`examples/skills/`** — Three sample skills (`reminders`, `daily-mail-brief`, `update-brain`) demonstrating the full feature surface.
- **`examples/oauth/`** — Google OAuth helpers (`google_auth.py`, `reauth_google.py`, resume-hook example, requirements, walkthrough README) for skills that need Gmail/Drive/Docs access.
- **`examples/config.yaml.example`** + **`examples/secrets.env.example`** + **`examples/topics-template.json`** — annotated config templates.
- **`docs/`** — Architecture, quickstart, configuration, skills guide, workers guide, bot guide, deployment, conventions, troubleshooting.

## Status

Substrate extracted from a working personal deployment. Conventions are stable; expect breakage if you build on top of internal/unstable APIs not documented in `docs/`.

## Platform support

The framework runs on **Windows, macOS, and Linux**. Platform-specific notes:

| Feature | Windows | macOS | Linux |
|---------|---------|-------|-------|
| Bot launcher | `run-bot.ps1` + Task Scheduler | `run-bot.sh` + launchd | `run-bot.sh` + systemd |
| `pa schedules sync` | Windows Task Scheduler | crontab | crontab |
| Process tree / bgtasks | PowerShell + CIM | `ps` / `pgrep` | `ps` / `pgrep` |
| `/keepawake` | `SetThreadExecutionState` | `caffeinate -s` (built-in) | `systemd-inhibit` (requires systemd) |

**Other POSIX (FreeBSD, Alpine, musl, etc.):** every OS-specific feature is self-describing when its underlying tool is absent. `pa schedules sync` throws an error naming `scheduler.ts:syncSchedules()` if `crontab` isn't installed. `pa bgtasks` warns once naming `process-tree.ts:getChildPids()` if `pgrep`/`ps` aren't found. `/keepawake` throws naming `keepawake.ts:startKeepAwake()` with the exact implementation contract. All three messages include reference implementations in the same file.

See [`docs/QUICKSTART.md`](docs/QUICKSTART.md) for per-OS installation steps and [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) for platform-specific caveats (including the adaptation guide for unsupported OSes).

## License

[MIT](LICENSE).
