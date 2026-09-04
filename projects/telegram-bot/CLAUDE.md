# Agentic Brain — Telegram Bot (`projects/telegram-bot/`)

Auto-loads on any read under `projects/telegram-bot/`; carries bot-internal detail.
**Publishes to the public mirror** — no personal data/secrets/private-only detail
(`bot-instructions.md` excluded; naming it is fine).

## Bot internals

- **`bot-instructions.md`**: appended to claude/zclaude spawns; **agy/codex NEVER receive
  it**; non-claude workers get `context.ts`'s thinner inline block. A rule that
  must reach every worker goes in BOTH places — check by hand. Prompt-triangle bullets
  ship their verbatim-sync test in the SAME commit.
- Per-file detail: indexed in the repo's file inventory (router at the repo root); graceful
  shutdown = `pa bot stop` (`~/.pa/telegram-bot.stop` sentinel).
- **Agent/model switching**: `/agent zclaude|claude|codex|agy|agyc` sets
  `preferred_worker` (session-scoped, expires IST midnight; legacy `/model` works).
- **Dispatch failover**: tries advance on rate-limit classification; total failure falls to `runWithFailover`; timeouts surface as errors.
- **Uniform tunables**: `/model`/`/effort` session-scoped; `/default` promotes to topic
  defaults; resolution session → topic → worker → CLI. Per-CLI: `tunables.<name>.args`
  (`{value}` substituted); `supersedes:` exclusive; clear tokens
  `clear`/`reset`/`default`/`unset`/`-`.
- **Deterministic command interception**: `/new`, `/code`, `/status`, `/skills`, `/help`,
  `/health`, `/ref <id>`, `/claims`, `/debug` intercept in `processUpdate` pre-dispatch
  (`/new` resets context, optionally seeding from a replied ref-ID; `/code` validates +
  manages topic cwd_override; `/debug` (AI-190, operator-gated) files a `topics.support`
  task keyed on the target's ref-ID). **Unknown-command guard**: a
  single-token slash command matching nothing gets a local `Unknown command` reply, never
  a worker (`guardUnknownCommand`, `logic.ts`) — new commands must join `isKnownCommand`
  or the guard eats them before any handler runs.
- **Auto topic descriptions**: LLM-set on creation/branch; registry-internal; names
  rewritten every change — hand edits survive only stop-edit-restart.
- **Google OAuth reauth**: `/auth <code> [state]` intercepts pre-archival (archived
  `/auth [redacted]`), exchanges via `finish_google_telegram_reauth.py`, deletes the code
  message, relaunches the saved `resume_action` via `oauth.ts`; **read the
  OAuth outage incident record before touching this flow**. `/reauth [skill]`
 : local, never LLM-inferred — spawns `start_google_telegram_reauth.py
  --reuse-pending`; link 12 h; `[skill]` retries via `--resume-skill`.
- **Inline buttons / callbacks**: a press is a typed command injected as a
  synthetic message (`callbacks.ts`) — button and typing can't diverge; keyboards are
  removed/rewritten after a press (AI-192: ackSelection re-attaches a fresh recorded
  cc: submenu — `editMessageText` strips keyboards otherwise; cc: presses toast only,
  the card refresh writes the new state into the pin).

  | prefix | action | gate |
  |---|---|---|
  | `reauth` | Google re-auth link | chat |
  | `cf` | confirm/cancel pending (also 👍/👎) | chat |
  | `cc` | control card + agent/model/effort picker | chat |
  | `wf` | retry/switch/revert on worker errors | chat |
  | `q` | answer a PA_META question option (injects option text) | chat |
  | `qt` | answer a task-lane question into the task micro-thread | chat |
  | `rm` | reminder done/snooze 1h/tomorrow | chat |
  | `pm` | self-improver HITL approve/reject/diff | operator |
  | `dr` | draft approve/reject/show | operator |
  | `sk` | run skill/job now (2-tap) | operator |
  | `mc` | memory conflict accept/keep/ignore | operator |
  | `rs` | resend orphan-reaped dispatch | operator |
  | `dq` | DLQ replay (2-tap) | operator |
  | `ru` | feedback-rule accept/reject (`pa rules accept`/`supersede`; weekly-digest `[PA_KEYBOARD]`) | operator |
  | `si` | mute an alert-census family via fix-record (`pa fix <family>`; 2-tap; nightly report) | operator |
  | `ch` | re-run a chain (2-tap; existence-checked; chain failure report) | operator |
  | `wt` | re-register a terminal watch (`pa watch re-register`; check-failed/expired reports) | operator |

- **PA_META envelope**: LLMs append `[PA_META]: {"actions":[...]}` as the last line.
  **`run_skill` is authorization-gated**: the git-workflow family + `self-improver`
  never fire from PA_META — human-typed only (`PA_META_PROTECTED_SKILLS`, mirrors pa's
  `PROTECTED_SKILLS`). **Replies are delivered UNREDACTED (AI-184, 2026-09-03)** — the
  operator's own chat keeps real text (names, wa.me/email drafts); the scrub lives on the
  persistence/worker-read paths (`conversation.ts addTurn` assistant turns → turn store +
  archive, `dlq.ts appendDlq`, logger contexts, rules-critic excerpts). **`watch_job`**: `logic.ts`
  shape-validates via pa's single `validateWatchInput`; `main.ts` AWAITS `addWatchJob`,
  appending the id or rejection — never silent. Read-only, no shell; read the
  async-watch design record before touching this path.
- **Multi-chat**: `TELEGRAM_CHAT_ID` comma-separate — supergroups negative, DMs positive; parse by sign.
- **Test rule**: send bodies MdV2-escaped (strip `\`); gates fail-closed on stale dist — build first (`PA_ALLOW_STALE_DIST=1` escape). Do NOT latch
  (trackPendingWork) a test-side fire-and-forget in a file that lets the REAL `process.exit` fire (poll-loop-callbacks) — a held latch turns its
  no-op drain into a real wait and hands the exit the window to darken the file; latch only spawns in exit-neutered files (AI-172 fix#1 correction, c4ad5dd).
- Test fixtures use the synthetic id family (-1001234567890, threads 5001/5002), never real chat/thread ids or repo paths — the public mirror tracks src/tests.
- **Output cleaning**: `workers.ts` trims Gemini stdout; `logic.ts` strips residual
  thought-block/planning-header markers.
- **Deployment**: Task Scheduler, `-MultipleInstances Ignore`; persistent 409 → rotate via BotFather.
- **Standalone Python (Task Scheduler)**: no inherited bot env — self-contained
  `_load_secrets()` parsing `~/.pa/secrets.env` (`os.environ` wins); never hardcode
  tokens/chat IDs; parse `TELEGRAM_CHAT_ID` by sign
  (`projects/coding-dirs-updater/update_coding_dirs.py`).
- **agy native resume**: agy topics resume native conversations (`--conversation <id>`,
  captured on success, kill-drop on cancel); `AGY_NATIVE_RESUME_EXCLUDED_TOPICS` = off.
- **Same-turn KB notes**: on `PA_KB_SOURCES_PATH` — workers write `kb_note` facts via PA_META.
- **Voice transcription**: voice → transcribe → same text pipeline (`voice.ts` never
  throws; optional IPC client; Python cloud-first; gc 30d). Transcription at ARRIVAL —
  the transcript becomes the queue entry's text (/stop//steer semantics, AI-092). `attachment-stage.ts`
  owns transcription/audio-index/echo/downloads; `main.ts` assigns.
  **AI-191 voice commands**: a confident transcript match becomes the typed command
  at the stage (registry-gated — new commands get voice free; echo "→ /cmd");
  inference = safe allowlist only; voice never reaches /stop//steer.
- **Archive joins**: join bot turns on `(thread_id, update_id)`, never `run_id`.
- **Recall + decisions**: the recall/precedent bullets are byte-identical across the
  prompt triangle (sync test, `context.test.ts`). `rm:` presses write decisions.sqlite
  rows; reactions fill outcome. The gitignored `bot-instructions.md` never rides git —
  hand-sync on merge.
- **Topic brains**: bot READS only (`topic-brains.ts`, fail-to-absent; pointer line on
  fresh dispatches only); nightly consolidation is the single writer. Exempt registry
  `$PA_HOME/topic-brains/EXEMPT.json`: hard classes (`output-only`/`duplicate`/`one-off`/
  `pinned-guide`) skip nightly work + refuse `/update_brain`; `dormant` (30d) skips while
  stale. Workdir cascade `cwd_override` > brain Project pointer > topic home > BOT_CWD
  (agy/agyc/codex stay repo-root via shim pins; claude/zclaude get per-topic dirs).
  `/update_brain` stages `.staged/{topicKey}.md`; refuses thread-0 + hard-exempt.
Resolved incident records (harvest-vs-stale verdict, the AI-199 env-leak root cause, teardown-guard wiring map, renderOpenItems fail-to-absent proof, DLQ terminal drop): `docs/bot-incident-records.md` — read before re-litigating any covered behavior.
- **Feedback Rules**: `context.ts` injects `## Standing rules`
- **Feedback Rules**: `context.ts` injects `## Standing rules` (12-rule/1500-char
  cap); `rules-critic.ts` logs violations to `rules-violations.jsonl` per reply. CLI:
  `pa rules`.

## Reliability internals

Drains/queue/maintenance: `docs/bot-drains-queue.md` (extracted 2026-09-03). Reliability/DLQ/reaper/DEGRADED: `docs/bot-reliability-internals.md`.


