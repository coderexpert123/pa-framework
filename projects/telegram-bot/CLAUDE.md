# Agentic Brain — Telegram Bot (`projects/telegram-bot/`)

This file auto-loads whenever Claude Code reads a file under `projects/telegram-bot/`
(native directory-scoped `CLAUDE.md` — see root `CLAUDE.md`, `docs/CONVENTIONS.md`). Carries
bot-internal detail extracted to keep the root file under budget.

**Publishes to the public mirror** (`pa-framework`) — no personal data, secrets, or
private-repo-only detail belongs here. `bot-instructions.md` (static system-prompt content)
is excluded from the mirror; referencing it by name is fine.

## What this project is

Long-poll Telegram bot dispatching to pa's worker pool. Multi-topic (forum-thread) 20-turn
rolling conversation state. Per-topic model/tunable overrides. PA_META machine-readable
action envelope for cross-skill triggering.

## Bot internals

- **`bot-instructions.md`**: static system-prompt content appended to all claude/zclaude
  spawns via `--append-system-prompt-file` — **`agy`/`codex` NEVER receive this file**
  (AI-101: `agy` is the priority-1 default worker, so a rule added only here is invisible
  to most live traffic). Non-claude-family workers get a thinner inline block from
  `context.ts`'s `capabilities` string instead (`buildPrompt`, `omitStatic:false`).
  **Any standing rule that must reach every worker has to be added to BOTH places** — not
  structurally enforced, check both by hand. **Convention (2026-08-24)**: every new
  prompt-triangle bullet (`context.ts` capabilities ↔ `bot-instructions.md` ↔
  `examples/bot-instructions.example.md`) ships its verbatim-sync test in
  `context.test.ts` in the SAME commit — No-LaTeX once shipped mismatched wording,
  caught only by a deep-recheck.
- **Per-file detail**: `inventory/telegram-bot.md` (routed from `FILE_INVENTORY.md`) is the full
  index — poll loop `main.ts`; topic state `conversation.ts`; output cleaning + worker-stickiness
  `logic.ts`; prompt builder `context.ts`; `telegram.ts` (API + chunking + reactions); DLQ
  `dlq.ts`; delivered-key dedup `delivered-store.ts`; OAuth `oauth.ts`; sentinel `sentinel.ts`;
  callbacks `callbacks.ts`; see the inventory for the rest.
- **Graceful shutdown**: `pa bot stop` writes `~/.pa/telegram-bot.stop` (sentinel).
- **Agent & Model switching**: `/agent zclaude`, `/agent claude`, `/agent codex`,
  `/agent agy`, `/agent agyc` sets `preferred_worker` (session-scoped, expires at IST
  midnight; legacy `/model <agent>` still works, with a tip).
- **Dispatch failover shape**: resumed-session, preferred-worker, and default-worker attempts
  are each a single try advancing only on rate-limit classification; total failure falls
  through to the full `runWithFailover` cascade with prior-context injection. Resumed-session
  timeouts surface as errors, not silent model switches.
- **Uniform tunables & Option B descriptors** (`logic.ts`, `main.ts`): `/model <value>`/`/effort <value>`
  are CLI-agnostic session-scoped settings (`TUNABLE_COMMAND_SETTINGS` maps the uniform word to each
  CLI's real setting name); `/default` alone promotes the active session config to persistent topic
  defaults, `/default <setting> <value>`/`/default <worker>` sets one. Pinned cards use Option B
  format: `agent (model) [effort]` (e.g. `claude (opusplan) [high]`, `agy (gemini-3.7-flash-high)`).
  Switches and midnight expiry update the card in-place (`editMessageText`) and emit concise
  before → now replies. Resolution cascade: session override → topic default → worker default →
  CLI built-in (`KNOWN_CLI_DEFAULT_MODELS`, `KNOWN_CLI_DEFAULT_EFFORTS`). Per-CLI translation:
  `~/.pa/config.yaml`'s `tunables.<name>.args` (ARG TEMPLATE, `{value}` substituted); `supersedes:`
  marks mutually-exclusive knobs. Clear tokens: `clear`/`reset`/`default`/`unset`/`-`. Tested in
  `tunables-commands.test.ts`/`logic.test.ts`/`dashboard.test.ts`.
- **Deterministic command interception**: `/new`, `/code`, `/status`, `/skills`, `/help`, `/health`,
  `/ref <id>`, `/claims` intercept in `processUpdate` pre-dispatch (`/new` resets context, optionally
  seeds from replied ref-ID; `/code` validates + manages topic cwd_override). Tested in
  `logic.test.ts` + `poll-loop.test.ts`.
- **Auto Topic Descriptions (2026-08-20)**: descriptions auto-set on creation (manual via
  `forum_topic_created`, branches via `/branch`) via LLM with deterministic fallbacks (`main.ts`,
  `logic.ts`). **Registry-internal prompt metadata** — `editForumTopic` has NO description param,
  never plan a Telegram-side sync. **The bot rewrites the whole topic-names file on every change**
  — hand edits are clobbered unless made in a `pa bot stop` → edit → restart window.
- **Telegram-driven Google OAuth reauth**: `/auth <code> [state]` intercepts before archival
  (archived as `/auth [redacted]`), exchanges the code via
  `pa/scripts/finish_google_telegram_reauth.py`, deletes the code-bearing message, and can
  relaunch a saved opaque `resume_action` via `oauth.ts`.
  **Read `plans/2026-08-25-oauth-outage.md` before touching this flow or reply-send retries.**
- **`/reauth [skill]`** (AI-147): local, never LLM-inferred. Spawns
  `pa/scripts/start_google_telegram_reauth.py --reuse-pending` (override:
  `PA_OAUTH_START_SCRIPT`); delivers a link valid 12 h; `[skill]` retries via `--resume-skill`.
  Also reachable via the 🔐 inline button on every reauth notice (`reauth` prefix, see Inline
  buttons / callbacks below). Parser: `REAUTH_PATTERN`/`handleReauthCommand`/`parseReauthCallback`,
  tested in `tests/reauth-command.test.ts`.
- **Inline buttons / callbacks (2026-08-24)**: presses are typed commands routed through an
  injected synthetic message (`callbacks.ts`), so behavior can never diverge from typing.
  Every keyboard is removed or rewritten after a press.

  | prefix | what it does | gate |
  |---|---|---|
  | `reauth` | Google re-auth link | chat |
  | `cf` | confirm/cancel a pending action (also 👍/👎) | chat |
  | `cc` | control-card nav + agent/model/effort picker | chat |
  | `wf` | retry/switch/revert on worker errors | chat |
  | `pm` | self-improver HITL approve/reject/diff | operator |
  | `dr` | pending-draft approve/reject/show | operator |
  | `sk` | run a skill/job now (2-tap confirm) | operator |
  | `rm` | reminder done/snooze 1h/tomorrow | chat |
  | `mc` | memory conflict accept/keep/ignore | operator |
  | `rs` | resend an orphan-reaped dispatch | operator |
  | `dq` | DLQ replay (2-tap confirm) | operator |
- **PA_META envelope**: LLMs append `[PA_META]: {"actions":[...]}` as the last line to signal
  machine-readable actions. **`run_skill` is authorization-gated**: the git-workflow family
  (`commit`/`push`/`push-public`/`commit-and-push`/`investigate-flagged`/`update-brain`) plus
  `self-improver` can never fire from PA_META — human-typed commands only
  (`PA_META_PROTECTED_SKILLS`, mirrored by pa's `PROTECTED_SKILLS`). Replies pass through
  `redactSecrets` before sending.
- **Multi-chat support**: `TELEGRAM_CHAT_ID` in secrets.env is comma-separated
  (`"DM_ID,GROUP_ID"`) — supergroups negative, DMs positive; parse by sign, not position.
- **Output cleaning**: strip thought blocks/planning headers — two-layer: `workers.ts` trims
  Gemini stdout, `logic.ts` strips residual headers/thought-block markers.
- **Deployment**: Windows Task Scheduler with `-MultipleInstances Ignore`; if 409
  Conflict persists, rotate the token via BotFather.
- **Standalone Python scripts (Task Scheduler)**: do not inherit the bot's environment —
  include a self-contained `_load_secrets()` helper parsing `~/.pa/secrets.env` (respecting
  `os.environ` overrides). Never hardcode tokens/chat IDs — use `_secret("TELEGRAM_BOT_TOKEN")`
  and parse `TELEGRAM_CHAT_ID` by sign (negative = supergroup, positive = DM). Reference:
  `projects/coding-dirs-updater/update_coding_dirs.py`.
- **agy native resume — fleet-wide since 2026-08-17**: every agy topic resumes its native
  conversation (`--conversation <id>`, captured only on success + session-file validity, kill-drop
  on cancellation). `AGY_NATIVE_RESUME_EXCLUDED_TOPICS` in main.ts is the emergency off-switch
  (empty = all resume). Trial record: `plans/2026-08-16-agy-native-resume-trial.md`.
- **Same-turn KB notes**: on (`PA_KB_SOURCES_PATH` → `D:/My Repos/notes/Ecosystem KB/Sources.md` in secrets.env) — workers write `kb_note` facts back via PA_META (AI-101 Layer 2).
- **Voice-note transcription** (`plans/2026-08-04-telegram-voice-transcription.md`): a voice
  note downloads, transcribes, and feeds into the identical text-dispatch pipeline. Bot:
  `voice.ts` (download+dispatch, never throws), `voice-worker-client.ts` (optional
  persistent-worker IPC). Python: `pa/scripts/transcribe_voice.py` (cloud-first, never imports
  the heavy `transcription` package), `voice_worker.py` (lazily-started, self-idle-terminating;
  known self-healing start-race gap). Config split (do not merge): `transcription:` in
  config.yaml is deployment policy, `PA_VOICE_*` is env-var tuning. Job `voice-attachment-gc`
  (30d retention, `~/.pa/attachments/`). **Since 2026-08-15, transcription happens at
  ARRIVAL** (`voice-prefetch.ts` + poll-loop enqueue) — the transcript becomes the queue
  entry's text, so voice follows /stop//steer flush semantics like text; see
  `docs/bot-reliability-internals.md`'s AI-092 section.
- **Archive join fields (2026-08-24)**: assistant rows carry `session_id`+`update_id`, user rows
  carry `update_id` (`main.ts:1457`/`:2126`) via a `JoinableTurn` alias in `conversation.ts` (bot
  `types.ts` was owned by a concurrent wave that day). Trace join key for a bot turn:
  `(thread_id, update_id)`, never `run_id` — the archive row never carries one.
- **Recall (2026-08-24)**: `context.ts`'s `capabilities` block carries a standing "Recall before
  assuming" bullet (`pa recall "<terms>" --thread <id> --json`), byte-identical in
  `bot-instructions.md`/`examples/bot-instructions.example.md`, verified by the three-file sync
  test in `context.test.ts`; `buildPrompt`'s `## Topic` section also appends a per-thread
  `Recall:` pointer line.
- **Topic brains (per-topic durable context)**: `context.ts` injects a pointer line (fresh dispatches only); `topic-brains.ts` reads, fail-to-absent; standing rule in both `capabilities` and `bot-instructions.md`. Single-writer: bot only reads, nightly `finalize`/`--stamp` writes atomically. `/merge` folds via `ancestry.mergedAt` nightly; INDEX.md regenerates nightly; hand-set descriptions uncapped. **Exempt registry** `$PA_HOME/topic-brains/EXEMPT.json` (PAHOME-local): hard classes (`output-only`/`duplicate`/`one-off`/`pinned-guide`) skip nightly work + refuse `/update_brain`; `dormant` (30d stale) skips while stale. **Workdir cascade**: `cwd_override` > brain Project pointer (first absolute path in `## Project pointers`) > topic home (`{key}/`+`scratch/`) > BOT_CWD — agy/agyc/codex stay repo-root (shim cd/`-C` pin), claude/zclaude get real per-topic dirs + CLAUDE.md shim. **`/update_brain`**: deterministic interception stages `.staged/{topicKey}.md` (folded nightly by `finalize`); refuses thread-0 and hard-exempt. Specs: `plans/2026-08-21-topic-brains-SPEC.md` (+ wave1.5).

## Reliability internals

DLQ flush cadence, exactly-once inbound / effectively-once outbound dedup, `/stop`/`/steer`
cancellation (AI-092), and AI-096 lock/backpressure deviations from library defaults
(**do not "fix" those back to defaults** — both exist because of a July crash RCA): read
`docs/bot-reliability-internals.md` before touching reply delivery, the DLQ, delivered-store
dedup, pending-dispatches, orphan-reaper, `worker-stop.ts`/cancellation, or
`health.ts`/DEGRADED shedding.

Declared bot maintenance jobs (AI-100): log rotation, model sweep, compaction, proxy
refresh, grounding-check, registry-content-watch (daily content invariants),
**bot-self-restart** (2026-08-24: idle-gated stop-sentinel restart when the dist stamp is
newer than the running process; `PA_BOT_SELF_RESTART=0` disables), DLQ flush.
