# pa-framework

> Multi-CLI personal-assistant orchestrator with rate-limit-aware failover, Markdown-based skills, voice transcription, and Telegram bot integration.

`pa` is a substrate, not an application. You define skills as Markdown files with YAML frontmatter; the dispatcher runs them on a cron schedule, routes execution through the highest-priority available worker (Antigravity CLI / Claude Code / OpenAI Codex / zClaude), persists state, and pushes output to Telegram (or to disk, or to both). When one CLI is rate-limited, the dispatcher fails over to the next. When a skill's output contains a `[PA_META]: {"actions":[...]}` envelope, the dispatcher can trigger downstream skills automatically.

Use it to build your own personal automation: inbox triage, voice-dictated WhatsApp messaging, natural language reminders, periodic digests, and knowledge base updates.

---

## ⚡ Quickstart (3 Minutes)

Get your personal assistant running in three simple steps:

### 1. Clone & Build
```bash
# Clone the repository
git clone https://github.com/coderexpert123/pa-framework.git
cd pa-framework

# Install dependencies and build core orchestrator
cd pa && npm install && npm run build && cd ..

# Install dependencies and build Telegram bot
cd projects/telegram-bot && npm install && npm run build && cd ../..
```

### 2. Configure Credentials & Workers
```bash
# Scaffold the runtime configuration directory
mkdir -p ~/.pa

# Copy turnkey environment and worker configuration templates
cp .env.example ~/.pa/secrets.env
cp config.example.yaml ~/.pa/config.yaml
```

Edit `~/.pa/secrets.env` with your API keys:
- **`TELEGRAM_BOT_TOKEN`**: From [@BotFather](https://t.me/BotFather) on Telegram.
- **`TELEGRAM_CHAT_ID`**: Your personal chat ID from [@userinfobot](https://t.me/userinfobot) (e.g. `123456789`) or group ID (`-100...`).
- **LLM API Keys**: Provide at least one (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`).
- **`GROQ_API_KEY`** *(Recommended)*: For ultra-fast, free cloud voice transcription.

### 3. Verify & Start
```bash
# Verify worker CLIs and skill health
node pa/dist/bin/pa.js health
node pa/dist/bin/pa.js workers

# Sync scheduled skills with your OS scheduler (Task Scheduler / crontab)
node pa/dist/bin/pa.js schedules sync

# Launch the Telegram bot
node pa/dist/bin/pa.js bot start
```

---

## 🌟 Key Features

### 🔀 Multi-Worker LLM Dispatcher
- **Cascading Failover**: Dispatches tasks across Antigravity (`agy`), Claude Code (`claude`/`zclaude`), and OpenAI Codex (`codex`).
- **Rate-Limit Awareness**: Intercepts HTTP 429 and `RESOURCE_EXHAUSTED` responses in real-time, automatically failing over to the next worker in the cascade.
- **Dynamic Tunables**: Adjust model family and reasoning effort (`/model`, `/effort`) dynamically per chat topic without restarting.

### 🎙️ Voice Notes & Audio Transcription
- **Cloud & Offline Engines**: Transcribes voice messages via Groq (Whisper large-v3), OpenAI Whisper, Deepgram, or fully offline via local CPU Whisper.
- **Hands-Free Operation**: Dictate thoughts, reminders, or messages directly in Telegram voice notes.

### 💬 Voice-to-WhatsApp Drafter (`projects/whatsapp-drafts/`)
- **Dictate & Send**: Convert unstructured voice memos or text requests into clean, formatted WhatsApp messages.
- **Contact Alias Resolution**: Resolve aliases (`mom`, `john`) from `data/contacts.json` and generate one-tap `wa.me` links.

### ⏰ Natural Language Reminders (`projects/reminders/`)
- **Timezone-Aware Scheduling**: Parse natural reminder times and store them in atomic JSON state (`~/.pa/reminders.json`).
- **Automated Delivery**: Minute-cadence scheduler polling with automatic Telegram alerts and delivery receipts.

### 📬 Daily Email Briefing (`projects/daily-mail-brief/`)
- **Inbox Triage**: Authenticate via Google OAuth, fetch unseen emails, and categorize priority senders, newsletters, and receipts.
- **AI Executive Summary**: Generates concise morning/evening digests sent directly to your Telegram topic.

### 📊 Weekly Operations Digest (`pa/scripts/weekly_digest.py`)
- **System Telemetry**: Aggregates skill run metrics, failure rates, worker cost rollups, and memory consolidation audits into an executive weekly briefing.

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
- **`examples/`** — Sample skills, OAuth helpers, and topic structures.
- **`docs/`** — Detailed guides: quickstart, configuration, skills development, workers, and deployment.

---

## 💻 Platform Support

The framework runs natively on **Windows, macOS, and Linux**.

| Feature | Windows | macOS | Linux |
|---|---|---|---|
| Bot Launcher | `run-bot.ps1` + Task Scheduler | `run-bot.sh` + launchd | `run-bot.sh` + systemd |
| Scheduler Sync | Windows Task Scheduler (`pa schedules sync`) | `crontab` | `crontab` |
| Background Tasks | PowerShell + CIM | `ps` / `pgrep` | `ps` / `pgrep` |
| `/keepawake` | `SetThreadExecutionState` | `caffeinate -s` | `systemd-inhibit` |

For detailed per-OS installation instructions and troubleshooting, see [`docs/QUICKSTART.md`](docs/QUICKSTART.md) and [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

---

## 📄 License

[MIT](LICENSE).
