# pa-framework

> Multi-CLI personal-assistant orchestrator with rate-limit-aware failover, Markdown-based skills, voice transcription, and Telegram bot integration.

`pa` is a substrate, not an application. You define skills as Markdown files with YAML frontmatter; the dispatcher runs them on a cron schedule, routes execution through the highest-priority available worker (Antigravity CLI / Claude Code / OpenAI Codex / zClaude), persists state, and pushes output to Telegram (or to disk, or to both). When one CLI is rate-limited, the dispatcher fails over to the next. When a skill's output contains a `[PA_META]: {"actions":[...]}` envelope, the dispatcher can trigger downstream skills automatically.

Use it to build your own personal automation: inbox triage, voice-dictated WhatsApp messaging, natural language reminders, periodic digests, and knowledge base updates.

---

## ⚡ Quickstart

From `git clone` to a running skill with Telegram delivery in about 30 minutes.

```bash
git clone https://github.com/coderexpert123/pa-framework.git
cd pa-framework
```

Then follow [`docs/QUICKSTART.md`](docs/QUICKSTART.md) — the one canonical setup path (build, `pa init`, secrets, workers, first skill, scheduling, bot).

Short on time, or want the computer to do the setup? Hand [`docs/INSTALL.md`](docs/INSTALL.md) to your AI assistant — its first section explains the install in plain language and the rest is a checked, step-by-step runbook the assistant follows and verifies itself.

---

## 🌟 Key Features

**Multi-worker dispatcher** — cascading failover across Antigravity/Claude/OpenAI Codex/zClaude with rate-limit awareness. **Voice transcription** — cloud (Groq/Deepgram/OpenAI) or fully offline Whisper. **WhatsApp drafter** — voice/text dictation to polished messages with `wa.me` links. **Reminders** — natural-language parsing with timezone-aware scheduling. **Daily mail brief** — Gmail triage → AI executive summary. **Per-topic brains** — nightly memory consolidation per Telegram conversation. **Project brains** — `CLAUDE.md` sweeps keep architecture fresh. **Self-improver** — autonomous analysis loop proposes and validates fixes. **Weekly digest** — executive summary of metrics, failures, and costs. **Ops watchdogs** — worker capability, rate-limit retrospective, human-gated blocker alerts. **pa status** — one-screen overview of health, git, skills, claims, DLQ, maintenance.

Full inventory with per-feature guides: [`docs/FEATURES.md`](docs/FEATURES.md).

---

## 🏗️ Architecture (5 Layers)

```
┌─────────────────────────────────────────────────────────────┐
│  1. Communication    projects/telegram-bot/                 │
│  (Telegram bot, forum topics, voice STT, DLQ, archive)      │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│  2. Skill Substrate  ~/.pa/skills/<name>/skill.md           │
│  (YAML frontmatter + Markdown body, PA_META action chain)   │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│  3. Orchestrator     pa/src/{scheduler,blackboard,...}      │
│  (cron eval, locking, structured logging, dedup notify)     │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│  4. Worker Pool      pa/src/{workers,worker-exec,...}       │
│  (agy / claude / codex / zclaude failover, rate limits)     │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│  5. Auth Substrate   ~/.pa/google_auth.py + OAuth bridge    │
│  (desktop + Telegram/mobile Google OAuth recovery)          │
└─────────────────────────────────────────────────────────────┘
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for complete technical architecture documentation.

---

## 📁 Repository Structure

- **`pa/`** — Core CLI dispatcher and orchestrator: `pa run`, `pa list`, `pa schedules`, `pa health`, `pa notify`, `pa bot`.
- **`projects/telegram-bot/`** — Long-poll Telegram bot with forum-topic support, voice note processing, DLQ, and graceful shutdown.
- **`projects/whatsapp-drafts/`** — Voice/text dictation to polished WhatsApp drafts with `wa.me` action links.
- **`projects/reminders/`** — Scheduled natural-language reminder system with atomic storage.
- **`projects/daily-mail-brief/`** — Gmail triage → LLM summary → Telegram executive briefing.
- **`projects/google-oauth-redirect/`** — Static bridge page for Telegram and mobile Google OAuth recovery.
- **`.env.example`** & **`config.example.yaml`** — Root-level turnkey configuration templates for environment and workers.
- **`examples/`** — Sample skills, OAuth helpers, and topic structures + ops watchdogs, injection redteam, brain audit.
- **`docs/`** — Detailed guides: quickstart, development, configuration, skills development, workers, and deployment.

---

## 💻 Platform Support

The framework runs natively on **Windows, macOS, and Linux**.

| Feature | Windows | macOS | Linux |
|---|---|---|---|
| Bot Launcher | `run-bot.ps1` + Task Scheduler | `run-bot.sh` + launchd | `run-bot.sh` + systemd |
| Scheduler Sync | Windows Task Scheduler (`pa schedules sync`) | `crontab` | `crontab` |
| Background Tasks | PowerShell + CIM | `ps` / `pgrep` | `ps` / `pgrep` |

For detailed per-OS installation instructions and troubleshooting, see [`docs/QUICKSTART.md`](docs/QUICKSTART.md) and [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

---

## 🧑‍💻 Development

```bash
cd pa && npm install && npm run build && npm test
```

Working on the framework? Both packages' `npm run build` and `npm test` take a shared `@build` reservation automatically. When several terminals or AI agents share one checkout, builds and test suites serialize instead of rewriting `dist/` under each other. A `waiting for @build` line is that coordination working; the run continues on its own.

Build, test, and scoped-run workflow: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). Full multi-session protocol: [`docs/multi-session-protocol.md`](docs/multi-session-protocol.md).

---

## 📄 License

[MIT](LICENSE).
