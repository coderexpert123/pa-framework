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
  (AI-101: `agy` is the priority-1 default, so rules added only here are invisible to most
  traffic). Non-claude-family workers get a thinner inline block from
  `context.ts`'s `capabilities` string instead (`buildPrompt`, `omitStatic:false`).
  **Any standing rule that must reach every worker has to be added to BOTH places** — not
  structurally enforced, check both by hand. **Convention (2026-08-24)**: every new
  prompt-triangle bullet (`context.ts` ↔ `bot-instructions.md` ↔ the example) ships its
  verbatim-sync test in `context.test.ts` in the SAME commit.
- **Per-file detail**: `inventory/telegram-bot.md` (routed from `FILE_INVENTORY.md`) is the full
  index (poll loop `main.ts`, topic state `conversation.ts`, output cleaning `logic.ts`, prompt
  `context.ts`, API `telegram.ts`, DLQ `dlq.ts`, dedup `delivered-store.ts`, OAuth `oauth.ts`,
  sentinel `sentinel.ts`, callbacks `callbacks.ts`; rest in the inventory).
- **Graceful shutdown**: `pa bot stop` writes `~/.pa/telegram-bot.stop` (sentinel).
- **Agent & Model switching**: `/agent zclaude`, `/agent claude`, `/agent codex`,
  `/agent agy`, `/agent agyc` sets `preferred_worker` (session-scoped, expires at IST
  midnight; legacy `/model <agent>` still works).
- **Dispatch failover shape**: resumed-session, preferred-worker, and default-worker attempts
  are one try each, advancing only on rate-limit classification; total failure falls to the full
  `runWithFailover` cascade with prior context. Resumed-session timeouts surface as errors,
  never silent model switches.
- **Uniform tunables** (`logic.ts`, `main.ts`): `/model`/`/effort` are CLI-agnostic
  session-scoped settings; `/default` promotes session config to topic defaults. Switches +
  midnight expiry update the pinned card in-place. Resolution: session → topic default →
  worker default → CLI built-in. Per-CLI translation: config.yaml `tunables.<name>.args`
  (`{value}` substituted); `supersedes:` = exclusive knobs. Clear tokens:
  `clear`/`reset`/`default`/`unset`/`-`.
- **Deterministic command interception**: `/new`, `/code`, `/status`, `/skills`, `/help`, `/health`,
  `/ref <id>`, `/claims` intercept in `processUpdate` pre-dispatch (`/new` resets context, optionally
  seeds from replied ref-ID; `/code` validates + manages topic cwd_override).
- **Auto Topic Descriptions (2026-08-20)**: set on creation//branch via LLM with deterministic
  fallbacks; registry-internal (`editForumTopic` has NO description param). The bot rewrites the
  topic-names file on every change — hand edits survive only stop-edit-restart.
- **Telegram-driven Google OAuth reauth**: `/auth <code> [state]` intercepts before archival
  (archived as `/auth [redacted]`), exchanges the code via
  `pa/scripts/finish_google_telegram_reauth.py`, deletes the code-bearing message, and can
  relaunch a saved opaque `resume_action` via `oauth.ts`.
  **Read `plans/2026-08-25-oauth-outage.md` before touching this flow or reply-send retries.**
- **`/reauth [skill]`** (AI-147): local, never LLM-inferred. Spawns
  `pa/scripts/start_google_telegram_reauth.py --reuse-pending` (override:
  `PA_OAUTH_START_SCRIPT`); link valid 12 h; `[skill]` retries via `--resume-skill`.
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
- **PA_META envelope**: LLMs append `[PA_META]: {"actions":[...]}` as the last line.
  **`run_skill` is authorization-gated**: the git-workflow family
  (`commit`/`push`/`push-public`/`investigate-flagged`/`update-brain`) plus
  `self-improver` can never fire from PA_META — human-typed commands only
  (`PA_META_PROTECTED_SKILLS`, mirrored by pa's `PROTECTED_SKILLS`). Replies pass through
  `redactSecrets` before sending. **`watch_job` (AI-170)**: `logic.ts` shape-validates via pa's single
  `validateWatchInput`; `main.ts` AWAITS `addWatchJob` and appends the registered id or the
  rejection — never silent. Read-only checks, no shell. `plans/2026-08-31-ai170-async-watch-SPEC.md`.
- **Multi-chat support**: `TELEGRAM_CHAT_ID` is comma-separated (`"DM_ID,GROUP_ID"`) — supergroups
  negative, DMs positive; parse by sign, not position.
- **Test rule (2026-09-01)**: captured send bodies are MdV2-escaped — strip `\` before substring asserts (bit 4 tests).
- **Output cleaning**: strip thought blocks/planning headers — two-layer: `workers.ts` trims
  Gemini stdout, `logic.ts` strips residual headers/thought-block markers.
- **Deployment**: Windows Task Scheduler with `-MultipleInstances Ignore`; if 409
  Conflict persists, rotate the token via BotFather.
- **Standalone Python scripts (Task Scheduler)**: they don't inherit the bot's env — include a
  self-contained `_load_secrets()` parsing `~/.pa/secrets.env` (`os.environ` wins); never
  hardcode tokens/chat IDs; parse `TELEGRAM_CHAT_ID` by sign. Reference:
  `projects/coding-dirs-updater/update_coding_dirs.py`.
- **agy native resume (fleet-wide since 2026-08-17)**: agy topics resume native conversations
  (`--conversation <id>`, captured only on success, kill-drop on cancellation).
  `AGY_NATIVE_RESUME_EXCLUDED_TOPICS` in main.ts = emergency off-switch (empty = all resume).
- **Same-turn KB notes**: on (`PA_KB_SOURCES_PATH` → `D:/My Repos/notes/Ecosystem KB/Sources.md` in secrets.env) — workers write `kb_note` facts back via PA_META (AI-101 Layer 2).
- **Voice-note transcription** (`plans/2026-08-04-telegram-voice-transcription.md`): a voice
  note downloads, transcribes, and feeds the identical text pipeline. Bot: `voice.ts`
  (never throws), `voice-worker-client.ts` (optional worker IPC). Python:
  `pa/scripts/transcribe_voice.py` (cloud-first), `voice_worker.py` (self-idle; known
  start-race gap, self-healing). Config: `transcription:` = deployment policy,
  `PA_VOICE_*` = env tuning (do not merge). Job `voice-attachment-gc`
  (30d retention, `~/.pa/attachments/`). **Since 2026-08-15, transcription happens at
  ARRIVAL** (`voice-prefetch.ts` + poll-loop enqueue) — the transcript becomes the queue
  entry's text, so voice follows /stop//steer flush semantics like text; see
  `docs/bot-reliability-internals.md`'s AI-092 section. **Since 2026-09-01 the whole stage
  lives in `attachment-stage.ts`** (AI-173 phase 1): `runAttachmentStage` owns transcription,
  the audio index, the ref-ID'd `🎙 Heard` echo (best-effort) and document/photo download;
  `main.ts` only assigns the result. Field shape + ordering + the ESM require-free constraint:
  `inventory/telegram-bot.md`.
- **Archive join fields (2026-08-24)**: assistant rows carry `session_id`+`update_id`, user
  rows `update_id` (`JoinableTurn` in `conversation.ts`). Join key for a bot turn:
  `(thread_id, update_id)`, never `run_id` — the archive row never carries one.
- **Recall + decisions (2026-08-24/27)**: "Recall before assuming" + "Precedent before
  proposing" bullets are byte-identical across `context.ts`/`bot-instructions.md`/
  `examples/bot-instructions.example.md` (sync test in `context.test.ts`); `buildPrompt`
  appends `Recall:`/`Precedent:` pointer lines. `rm:` presses write decisions.sqlite rows;
  reactions fill outcome. The gitignored deployed `bot-instructions.md` never rides git
  patches — hand-sync on merge.
- **Topic brains**: bot READS only (`topic-brains.ts`, fail-to-absent; `context.ts` injects a pointer line on fresh dispatches only); nightly consolidation is the single writer. **Exempt registry** `$PA_HOME/topic-brains/EXEMPT.json`: hard classes (`output-only`/`duplicate`/`one-off`/`pinned-guide`) skip nightly work + refuse `/update_brain`; `dormant` (30d) skips while stale. **Workdir cascade**: `cwd_override` > brain Project pointer > topic home > BOT_CWD (agy/agyc/codex stay repo-root via shim pins; claude/zclaude get per-topic dirs). **`/update_brain`** stages `.staged/{topicKey}.md`, refuses thread-0 + hard-exempt. Full internals: `plans/2026-08-21-topic-brains-SPEC.md`.
- **Feedback Rules (2026-08-28, AI-165)**: `context.ts` injects `## Standing rules` (12-rule/1500-char cap); `rules-critic.ts` logs rule violations to `rules-violations.jsonl` per reply. CLI: `pa rules`.

## Reliability internals

DLQ cadence, exactly-once/effectively-once dedup, `/stop`/`/steer` cancellation (AI-092),
AI-096 lock/backpressure deviations from library defaults
(**do not "fix" those back to defaults** — both exist because of a July crash RCA): read
`docs/bot-reliability-internals.md` before touching reply delivery, the DLQ, delivered-store
dedup, pending-dispatches, orphan-reaper, `worker-stop.ts`/cancellation, or
`health.ts`/DEGRADED shedding. **Restarts are invisible to the user (2026-08-27)**:
recovery QUEUES follow-ups (never a "please resend" bounce), recovered replies ride the
normal `formatWorkerReply` pipeline, exhausted recovery auto-requeues on a durable ladder
(`requeue-drain`), and no user-visible string narrates a restart — hard rules in the
doc's AI-095 section.

**Test-mode exit hook (AI-171, 2026-09-01)**: `runPollLoop()` ends via injectable `exitFn`
(default `process.exit`); any test that `await`s `runPollLoop(...)` to completion MUST call
`_setExitForTest(() => {})` first or its file reads back dark — the actual root cause of the
five months-dark integration files. The test no-op path also drains `inFlight` dispatches
(`Promise.allSettled`) before returning; production never reaches it. 7 revived tests stay
skipped with dated TODOs (phases A/B disposed the rest) — full bit-rot catalog + skip reasons:
`plans/2026-09-01-revived-bot-tests-bitrot-findings.md`.

**Test teardown guard (AI-172, 2026-09-01)**: `src/tests/test-teardown-guard.ts` provides
`waitForDrain()` (called in test `afterEach` hooks across all test suites) and `trackPendingWork()`
to ensure in-flight async dispatches and timers drain before `process.env.PA_HOME` is deleted,
preventing late worker tasks from falling back to and leaking fixtures into the live `~/.pa`.

Declared bot maintenance jobs (AI-100): log rotation, model sweep, compaction, proxy refresh,
grounding-check, registry-content-watch, **bot-self-restart** (2026-08-24: idle-gated restart when
dist is newer than the process; `PA_BOT_SELF_RESTART=0` disables), DLQ flush.
