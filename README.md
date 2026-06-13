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

# Configure: edit ~/.pa/secrets.env (at minimum: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
# Configure: edit ~/.pa/config.yaml worker `command` paths if your CLIs aren't in PATH

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

See [`docs/QUICKSTART.md`](docs/QUICKSTART.md) for per-OS installation steps and [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) for platform-specific caveats.

## License

[MIT](LICENSE).
