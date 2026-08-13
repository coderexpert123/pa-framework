# Agentic Brain — Telegram Bot (`projects/telegram-bot/`)

This file auto-loads whenever Claude Code reads a file under `projects/telegram-bot/`
(native Claude Code directory-scoped `CLAUDE.md` behavior — see the root `CLAUDE.md`'s
Communication Layer bullet and `docs/CONVENTIONS.md` § "Brain-file organization" for why
this file exists as a separate directory-scoped file rather than living inline in the
root brain). It carries the bot-internal detail that used to sit in root `CLAUDE.md`'s
Communication Layer bullet, extracted 2026-08-07 to keep the root file under its size
budget while still firing unprompted for anyone actually touching this directory.

**This file publishes to the public mirror** (`pa-framework`) — no personal data,
secrets, or private-repo-only detail belongs here. `bot-instructions.md` (the static
system-prompt content appended to claude/zclaude spawns) is itself excluded from the
mirror; referencing it by name is fine.

## What this project is

Long-poll Telegram bot dispatching to pa's worker pool. Multi-topic (forum-thread) 20-turn
rolling conversation state. Per-topic model/tunable overrides. PA_META machine-readable
action envelope for cross-skill triggering.

## Bot internals

- **`bot-instructions.md`**: static system-prompt content appended to all claude/zclaude
  spawns via `--append-system-prompt-file` — **`agy`/`codex` NEVER receive this file**
  (found 2026-08-05, AI-101: `agy` is the priority-1 default worker, so a standing rule
  added only here is invisible to most live traffic). Non-claude-family workers instead
  get a separate, thinner inline block built by `context.ts`'s `capabilities` string
  (`buildPrompt`, `omitStatic:false` path). **Any new standing rule that must reach every
  worker (not just claude/zclaude) has to be added to BOTH places** — enforced for the
  Grounding Sources rule specifically by a cross-referencing test in `context.test.ts`,
  but the general contract isn't structurally enforced, so check both files by hand for
  any other new global rule.
- **Per-file detail** (in `FILE_INVENTORY.md`): long-poll loop `main.ts`; multi-topic
  20-turn state `conversation.ts`; worker-output cleaning + topic worker-stickiness
  `logic.ts`; context/prompt builder `context.ts` (IST timestamps, Grounding Sources
  section); DLQ `dlq.ts`; delivered-key dedup `delivered-store.ts`; ack watermark
  `watermark.ts`; OAuth helpers `oauth.ts`; dashboard `dashboard.ts`; ref-IDs `ref-id.ts`
  + `ref-lookup.ts`; topic-names registry `topic-names.ts`; PID lock `lock.ts`; sentinel
  `sentinel.ts`; keep-awake `keepawake.ts`; `telegram.ts` (API + chunking + reactions);
  same-turn Ecosystem KB write path `kb-notes.ts` (AI-101 Layer 2, PA_META `kb_note`
  action, off unless `PA_KB_SOURCES_PATH` set); clobbered-description detector
  `grounding-check.ts` (AI-101, backs the `grounding-check` maintenance job).
- **Graceful shutdown**: `pa bot stop` writes `~/.pa/telegram-bot.stop` (sentinel file).
- **Model switching**: `/model zclaude`, `/model claude`, `/model codex`,
  `/model agy` sets `preferred_worker` for the topic (session-scoped, expires at IST
  midnight).
- **Uniform tunables** (`logic.ts`): `/llm <value>` and `/effort <value>` are
  CLI-agnostic session-scoped counterparts to `/model` (`TUNABLE_COMMAND_SETTINGS` maps
  the uniform word to each CLI's real setting name); `/default <setting> <value>` sets
  the same setting as a PERSISTENT topic default — extends the pre-existing `/default
  <worker>` syntax (the worker-name form, `DEFAULT_SWITCH_PATTERN`, is checked first and
  always wins). Resolution cascade: session override → topic default → worker's own
  default → CLI built-in. Per-CLI translation lives in `~/.pa/config.yaml`'s
  `tunables.<name>.args` as an ARG TEMPLATE (`{value}` substituted, not flag+value — some
  CLIs need a different shape, e.g. codex: `-c model_reasoning_effort={value}`); a
  `supersedes:` field marks mutually-exclusive knobs (agy's `model` supersedes `effort`).
  Clear/reset tokens: `clear`, `reset`, `default`, `unset`, `-`. Tested in
  `tunables-commands.test.ts` + `dashboard.test.ts`.
- **Telegram-driven Google OAuth reauth**: `/auth <code> [state]` is intercepted before
  archival, archived as `/auth [redacted]`, exchanges the auth code via
  `pa/scripts/finish_google_telegram_reauth.py`, deletes the code-bearing message, and
  can relaunch a saved opaque `resume_action` through `projects/telegram-bot/src/oauth.ts`.
- **PA_META envelope**: LLMs append `[PA_META]: {"actions":[...]}` as the last line to
  signal machine-readable actions.
- **Multi-chat support**: `TELEGRAM_CHAT_ID` in secrets.env is comma-separated
  (`"DM_ID,GROUP_ID"`). Supergroup IDs are negative (start with `-`); DM IDs are
  positive. Any new code reading `TELEGRAM_CHAT_ID` must parse by sign, not by position.
- **Standards**: Telegram output must be stripped of thought blocks and planning headers.
- **Output cleaning is two-layer**: `workers.ts` trims Gemini stdout; `logic.ts` strips
  residual headers and thought-block markers.
- **Deployment**: must use Windows Task Scheduler with `-MultipleInstances Ignore`.
- **Token Rotation**: if 409 Conflict persists, rotate the token via BotFather.
- **Standalone Python scripts (Task Scheduler)**: scripts run via Windows Task Scheduler
  do not inherit the bot's environment. Must include a self-contained `_load_secrets()`
  helper that parses `~/.pa/secrets.env` and respects `os.environ` overrides. Never
  hardcode bot tokens or chat IDs — use `_secret("TELEGRAM_BOT_TOKEN")` and parse
  `TELEGRAM_CHAT_ID` by sign (negative = supergroup, positive = DM). See
  `projects/coding-dirs-updater/update_coding_dirs.py` for the reference implementation.
- **Voice-note transcription** (`plans/2026-08-04-telegram-voice-transcription.md`): a
  Telegram voice note is downloaded, transcribed, and fed into the identical
  text-dispatch pipeline. Bot side: `voice.ts` (download+dispatch, never throws),
  `voice-worker-client.ts` (optional persistent-worker IPC). Python side:
  `pa/scripts/transcribe_voice.py` (cloud-first — never imports the heavy
  `transcription` package) and `voice_worker.py` (lazily-started, self-idle-terminating;
  its start-race protection is a known, documented, self-healing gap — see the file's
  own comment before "fixing" it). Config split (do not merge): `transcription:` in
  config.yaml is deployment policy, `PA_VOICE_*` is env-var operational tuning.
  Maintenance job `voice-attachment-gc` (30d retention on `~/.pa/attachments/*.oga`).
  Full design + error-code vocabulary in the plan file.

## Reliability internals

DLQ flush cadence, exactly-once inbound / effectively-once outbound delivery-dedup
guarantees, `/stop`/`/steer` request-level cancellation (AI-092), and the AI-096
lock/backpressure deviations from library defaults (**do not "fix" those back to
library defaults** — both exist because of a real July crash RCA): read
`docs/bot-reliability-internals.md` before touching reply delivery, the DLQ,
delivered-store dedup, pending-dispatches, orphan-reaper, `worker-stop.ts`/cancellation,
or `health.ts`/DEGRADED shedding.
