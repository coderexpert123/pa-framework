# Features — pa-framework

Canonical inventory of what the framework does, with each feature linked to the guide section that shows it working.

## Core dispatcher

| Feature | What it does | Try it | Go deeper |
|---|---|---|---|
| **Multi-worker failover** | Dispatches across Agnostic/Anthropic/OpenAI Codex/zClaude, auto-failing over on rate limits. | [§6](QUICKSTART.md#6-configure-workers) | [WORKERS_GUIDE](WORKERS_GUIDE.md) |
| **Dynamic tunables** | Adjust model and reasoning effort per topic via `/model`, `/effort` — no restarts. | [§10](QUICKSTART.md#10-start-the-telegram-bot) | [CONFIGURATION.md](CONFIGURATION.md) |
| **pa status** | One-screen overview: health, git, skills, next-due, claims, DLQ, maintenance. | Run `pa status` | — |
| **pa health** | 11 checks covering bot, logs, workers, skills, secrets, catchup, disk logs, ref IDs. | [§9](QUICKSTART.md#9-health-check) | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **pa recall / pa ref** | Search conversation-history and decision traces by query or ref-ID. | — | [ARCHITECTURE.md](ARCHITECTURE.md#decision-traces-2026-08-27) |
| **pa costs** | Worker cost rollups by CLI/model/day. | — | — |
| **Git-optional personas** | Run-only default (no commits/pushes) vs full git-optional with code-fix lane. | [§12](QUICKSTART.md#12-going-further-deploying-your-own-version) | [CONFIGURATION.md](CONFIGURATION.md#gitworkflowconfig) |

## Bot

| Feature | What it does | Try it | Go deeper |
|---|---|---|---|
| **Forum topics** | Long-poll bot with multi-topic conversation state and per-topic tunables. | [§10](QUICKSTART.md#10-start-the-telegram-bot) | [BOT_GUIDE.md](BOT_GUIDE.md) |
| **Voice transcription** | Cloud (Groq/Deepgram/OpenAI) or fully offline Whisper — hands-free dictation. | [§10](QUICKSTART.md#10-start-the-telegram-bot) | [BOT_GUIDE.md](BOT_GUIDE.md#voice-messages-speech-to-text) |
| **Auto topic setup** | One-shot canonical topic creation (alerts, support, briefings, etc.). | [§10](QUICKSTART.md#10-start-the-telegram-bot) | [BOT_GUIDE.md](BOT_GUIDE.md) |

## Example skills

| Feature | What it does | Try it | Go deeper |
|---|---|---|---|
| **whatsapp-drafts** | Voice/text dictation → polished WhatsApp messages with `wa.me` links. | — | [README](../README.md#-voice-to-whatsapp-drafter) |
| **reminders** | Natural-language reminders with timezone-aware scheduling and delivery receipts. | [§7](QUICKSTART.md#7-register-your-first-skill) | [README](../README.md#-natural-language-reminders-projectsreminders) |
| **daily-mail-brief** | Gmail triage → AI executive briefing sent to Telegram. | [§5](QUICKSTART.md#5-oauth-setup-if-using-gmail-based-skills) | [README](../README.md#-daily-email-briefing-projectsdaily-mail-brief) |
| **daily-digest** | End-of-day summary of bot activity, skill runs, and system state. | — | [skill](../examples/skills/daily-digest/skill.md) |
| **update-brain** | Nightly sweeps of enrolled `CLAUDE.md` files to keep architecture fresh. | [§13](QUICKSTART.md#13-your-assistant-has-a-brain) | [SKILLS_GUIDE.md](SKILLS_GUIDE.md) |
| **topic-brain-distill** | Per-topic memory consolidation — distills facts and decisions into topic brains. | [§13](QUICKSTART.md#13-your-assistant-has-a-brain) | [SKILLS_GUIDE.md](SKILLS_GUIDE.md) |
| **self-improver** | Autonomous analysis loop: proposes and applies fixes with validation floors. | — | [SKILLS_GUIDE.md](SKILLS_GUIDE.md#the-self-improvement-loop) |
| **worker-capability-watch** | Ops watchdog — pages when worker CLIs disappear or version-drift. | — | [skill](../examples/skills/worker-capability-watch/skill.md) |
| **rate-limit-retrospective** | Ops watchdog — summarizes rate-limit patterns and worker health. | — | [skill](../examples/skills/rate-limit-retrospective/skill.md) |
| **human-gated-blocker-watch** | Ops watchdog — escalates human-gated faults (OAuth, billing) before they stale. | — | [skill](../examples/skills/human-gated-blocker-watch/skill.md) |
| **injection-redteam** | Regression test — validates prompt-injection defenses across workers. | — | [skill](../examples/skills/injection-redteam/skill.md) |
| **brain-recheck** | Brain audit — scans project CLAUDE.md files for outdated claims. | — | [skill](../examples/skills/brain-recheck/skill.md) |

## Ops & safety

| Feature | What it does | Try it | Go deeper |
|---|---|---|---|
| **Weekly digest** | Executive weekly: skill metrics, failures, worker costs, memory audits. | — | [README](../README.md#-weekly-operations-digest-pascriptsweekly_digestpy) |
| **Dead letter queue** | Unsent bot replies persisted on failure — replay via `pa dlq replay`. | — | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Secret redaction** | Automatic redaction of secrets from logs and bot replies. | — | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Maintenance framework** | Declared jobs with failover ladders, evidence tracking, and ownership. | — | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **docs/DEBUGGING.md** | Per-CLI transcript locations, file formats, resume semantics. | — | [DEBUGGING.md](DEBUGGING.md) |

## Knowledge & self-improvement

| Feature | What it does | Try it | Go deeper |
|---|---|---|---|
| **Per-topic brains** | Nightly distill of each conversation into its own `BRAIN.md` with pointer injection. | [§13](QUICKSTART.md#13-your-assistant-has-a-brain) | [ARCHITECTURE.md](ARCHITECTURE.md#five-intelligence-layers) |
| **Project brains** | Enroll any `CLAUDE.md` for nightly sweeps — architecture decisions stay fresh. | [§13](QUICKSTART.md#13-your-assistant-has-a-brain) | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Self-improver loop** | Analyzes logs, failures, alert census → proposes and validates fixes. | — | [SKILLS_GUIDE.md](SKILLS_GUIDE.md#the-self-improvement-loop) |
| **Memory consolidation** | Add-only fact extraction from conversation-history with temporal metadata. | — | [ARCHITECTURE.md](ARCHITECTURE.md) |
