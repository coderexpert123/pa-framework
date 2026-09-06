# pa-framework — Architecture

> Developers extending the framework or building skills.

## Five intelligence layers

Each layer depends only on the ones below it:

| # | Layer | Where it lives | What it does |
|---|---|---|---|
| 5 | Communication | `projects/telegram-bot/` | Long-poll Telegram bot, forum-topic routing, conversation archive |
| 4 | Skill substrate | `~/.pa/skills/<name>/skill.md` | Markdown skills with YAML frontmatter; runtime dispatch |
| 3 | Orchestrator | `pa/src/{scheduler,blackboard,analyzer,drafts,lib/*}.ts` | Cron eval, locking, structured logs, alert dedup, learn pipeline |
| 2 | Worker pool | `pa/src/{workers,worker-exec,worker-evaluator,state-monitor,rate-limits-*}.ts` | CLI spawn, failover, rate-limit parsing, stuck-state evaluation |
| 1 | Auth substrate | `~/.pa/google_auth.py` + Telegram/mobile bridge helpers (see `examples/oauth/README.md`) | Shared Google OAuth for Gmail/Drive/Docs plus optional Telegram/mobile recovery |

Domain projects (e.g. daily-mail-brief) sit *above* layer 5: bot for delivery, skills, orchestrator via the `pa` CLI.

## Telegram/mobile OAuth recovery

Expired Google credentials: `start_google_telegram_reauth.py` sends a consent URL to Telegram (state in `~/.pa/google-telegram-auth.json`); Google redirects to `projects/google-oauth-redirect/`, the user pastes `/auth <code> <state>`, the bot runs `finish_google_telegram_reauth.py` — refreshed token + optional resume hook.

Boundary: **public** = bot `/auth` surface, auth-session format, start/finish scripts, bridge page, docs; **private** = OAuth client JSONs, token/state paths, the `~/.pa/oauth_resume_hook.py` action registry.

## Worker pool contract

External CLI processes via `child_process.spawn`, configured in `~/.pa/config.yaml` `workers:` (fields: `name`, `command`, `args`, `check`, `input_mode`, `output_format`, `secret_allowlist` (default-deny), `rate_limit_patterns`, `priority`, `state_dir`/`state_pattern`, `worker`, `no_fallback`). See `docs/WORKERS_GUIDE.md`.

**Input modes**: `arg` (prompt file, `{prompt}`→`@path`), `stdin-text`, `stdin-json`. **Output**: exit 0=success; NDJSON events parsed for session/rate-limit. **Rate-limit**: text-pattern (stdout/stderr substrings) or session-mode (state file tail, 429 events). **Process tree**: tracked and killed on timeout; Windows uses CIM, POSIX uses `ps`/`pgrep`.

## Skill YAML frontmatter schema

The YAML frontmatter (between `---` markers) declares scheduling and execution behavior; the body is the prompt sent to the worker (or, with `cmd:`, ignored).

| Field | Type | Default | Effect |
|---|---|---|---|
| `cron` | string | — | Standard 5-field cron expression. Optional — if absent, skill is manual-trigger only. |
| `on_missed` | `'latest' \| 'all' \| 'skip'` | `'latest'` | Catchup behavior. `'all'` is capped at 10 missed runs. |
| `cwd` | string | — | Working directory for the worker process. `~` expands to homedir. `${VAR}` env-interpolated. |
| `secrets` | string[] | — | Env vars to inject into the worker process from `~/.pa/secrets.env`. |
| `timeout` | number (sec) | 3600 | Max total execution time. |
| `idle_timeout` | number (sec) | 300 | Max silence (no stdout) before kill. |
| `trigger_description` | string | — | LLM-readable description for skill chaining (`run_skill` PA_META action). |
| `description` | string | — | Human-readable one-liner shown in /skills and pa surfaces. |
| `inject_triggers` | boolean | false | If true, inject all other skills' `trigger_description`s into this skill's prompt. |
| `worker` | string | — | Force a specific worker (e.g., `codex`) instead of priority-ordered failover. |
| `no_fallback` | boolean | false | When true with `worker:`, don't failover on failure. |
| `cmd` | string | — | Direct shell command (bypasses LLM). `${VAR}` env-interpolated. |
| `telegram_output` | object | — | Deliver LLM output to Telegram. See below. |
| `cost_tier` | `'off_peak' \| 'anytime'` | `'anytime'` | `off_peak` skills run only in the z.ai off-peak window (configurable `cost_tier.peak_window_utc`); periodic off_peak skills defer during peak with once-daily logging; time-pinned crons with `cost_tier` are ignored with a warning. |

### `telegram_output`

```yaml
telegram_output:
  chat_id: '-1001234567890'             # destination chat; supports ${VAR} interpolation
  thread_id: 0                          # optional forum thread; supports ${VAR}
  token_secret: TELEGRAM_BOT_TOKEN      # env var name (NOT the token value)
```

The framework posts the worker's final output to the destination; `${VAR}` interpolation applies to all three fields, and numeric strings coerce back to Number for `thread_id`.

## PA_META envelope

A skill's worker (or the bot's LLM response) can emit a metadata envelope as the LAST line of its output:

```
[PA_META]: {"actions":[{"type":"...", ...}]}
```

Action types:

- **`retry_with_worker{reason}`** — worker declares it can't complete; orchestrator routes to the next-priority worker.
- **`run_skill{skill}`** — trigger another skill automatically after this one finishes.
- **`confirm_required`** — used by the bot in place of "Reply *yes* to confirm" text; the bot tracks pending confirmations per-topic.
- **`watch_job{description,check,deadline_minutes,interval_seconds}`** — register an async watch (AI-170). `check` is `{type, path?, pattern?, since_iso?, pid?}`; `type` ∈ `file_exists`/`file_gone`/`file_newer_than`/`file_contains`/`process_gone`; read-only (no shell/network/writes). The reply always states the registered id or the rejection.

The bot strips the envelope before delivering text to the user; in execution mode (`Pending Confirmation` set) it suppresses any `[PA_META]` the model emits.

## Sequential workflow chains

Chains are YAML files in `~/.pa/chains/` that run skills sequentially, with retry and failure handling.

### Chain schema

```yaml
steps:
  - skill: <name>               # required: skill name
    args?: <string array>       # optional: args to pass to `pa run <skill>`
    retry?:                      # optional: retry configuration
      max: <number>             # default: 1
      backoff_s: <number>       # default: 0
    on_failure: stop|notify|continue  # default: stop
report: telegram|stdout         # default: stdout
```

### Execution model

- **Sequential**; each step spawns `pa run <skill>` as a subprocess (own git-workflow locks).
- **Failure**: `stop` (default) halts; `notify` pages and continues; `continue` is silent.
- **Retry**: up to `max` attempts, `backoff_s` apart.
- **Report**: `telegram` → pa-alerts summary (deduped chain-name+date); or `stdout`.
- **Validation (strict, on load)**: unknown fields/invalid values rejected; `skill` required; defaults applied.

Example — the shipped `~/.pa/chains/commit-ship.yaml`: `update-brain` (notify) → `commit` (stop) → `push` (retry 3×, backoff 5s, stop) → `push-public` (notify), `report: telegram`: stage and ship all pending work.

### CLI

```bash
pa chain run <name>    # Execute a chain
pa chain list          # List available chains
```

## Golden-task eval gate (self-improver)

The autonomous self-improvement loop (`pa/src/self-improver.ts`) gates skill prompt changes behind deterministic quality checks. When a prompt fix passes validation, golden tasks run against the change:

- **v1 (deterministic-only)**: tasks 4-6 run on static fixtures (no worker dispatch): `markdown_shape`, `pa_meta_wellformedness` (protected-skill forgery rejected), `injection_resistance`.
- **v2 (LLM-dependent, skipped unless `PA_EVAL_FULL=1`)**: tasks 1-3 require worker dispatch: `ref_id_format`, `date_arithmetic`, `grounding_citation`.

The gate is SOFT in v1: pass → change applied, eval recorded in the audit trail; fail → parked as `validation-failed-pending` for human review via `pa improvements`. The validation floor still governs: a change failing validation stays pending regardless of eval.

Each task's `scorer.py` outputs JSON `{pass, detail}`, exit 0/1; results aggregate into `~/.pa/eval-results.jsonl`, and applied changes gain an `eval` field (`{pass, fail, skipped, detail}`) reviewable via `pa improvements --show <draft>`.

## Async watch jobs (AI-170, 2026-08-31)

Store `~/.pa/watch-jobs.json` (lockfile + atomic write, same family as `reservations.json`);
engine the single declared `watch-jobs-runner` job (pa host, 60 s). `pa/src/lib/watch-jobs.ts`
holds the ONE validator (`validateWatchInput`), the store and the tick engine — every
registration path routes through it. Two paths: the `watch_job` PA_META action and
`pa watch add`. Bounds: 25 active, 10 checks/tick, 60 s-1 h intervals, 7-day max deadline,
256 KB tail reads. Terminal states `reported`/`expired`/`check-failed`/`cancelled`; all but
`cancelled` report to the registering chat/thread, redacted and `_Ref:`-stamped, and the send
precedes the status write. Spec: the AI-170 async-watch internal design record (2026-08-31).

## Blackboard & locking

`pa/src/blackboard.ts` manages a JSON file at `~/.pa/blackboard.json` containing PID + heartbeat-timestamp pairs per shared resource. Concurrent skill executions acquire/release locks via `proper-lockfile` on the JSON file.

Stale locks (heartbeat > 10 minutes old) are flagged by `pa health` and can be cleared via `pa purge-locks`. Each worker process refreshes its heartbeat periodically while running.

Lock rows are `(resource, agent, pid, heartbeat, contextId?)`. A holder that runs longer than `PA_HEARTBEAT_STALE_MS` must renew via `startLockRenewal()` and handle its `onLost` callback — a bare `setInterval(updateHeartbeat)` discards the `false` that means "your row was purged", which is silent double-occupancy. `startLockRenewal` — the only heartbeat mechanism since 2026-08-23 — accepts an optional `client` for dependency-injected callers. `releaseLock(resource, agent, contextId?, { pid })` scopes the delete: without a `contextId` and `pid` it removes every row for that `(resource, agent)` pair, so a stale holder's cleanup can delete a live same-named holder's lock. Two resources exist: `git-workflow` (the private tree, declared by the git-workflow skills — `commit`, `push`, `push-public`, `investigate-flagged`, `update-brain` — via `exclusive_resource`, taken directly by `code-fixer.ts` and `self-improver.ts`) and `git-public-workflow` (the derived `pa-public/` tree, taken by `pa public-sync`). Since AI-179 (2026-09-03) renewal is tri-state: `renewHeartbeat()` returns `'updated'`/`'row-absent'`/`'write-failed'` — a failed renewal write retries on the `PA_HEARTBEAT_WRITE_RETRY_MS` ladder (default 1 s/5 s/15 s), and a give-up is verified against the row (`peekLockRow`) before `onLost` fires, so only a verified row-absence counts as 'purged'.

## Conversation archive + DLQ

- **Archive**: `~/.pa/conversation-history.jsonl` — append-only log of every bot turn (one JSON object per line). Read nightly by memory-consolidation for KB synthesis.
- **Per-topic state**: `~/.pa/telegram-bot-topic-{chatId}_{threadId}.json` — rolling 20-turn window for the bot's context window.
- **DLQ**: `~/.pa/telegram-dlq.jsonl` — bot replies that failed to send are appended here. On bot startup, the DLQ is sequentially retried via `dlq.ts`.

## Ref-IDs

Every system-generated message carries a ref-ID — `_Ref: s-XXXXXXXXXXXX_` (12 hex chars,
stamped by pa's `sendToTelegram`, the bot's `appendRefIdAndLog`, and Python
`telegram_notify.py`) — and is logged to `app.log.jsonl` with a `refId` field, so all
system activity is queryable via `pa ref <id>`. Feedback rules carry `r-` + 12 hex
(`pa/src/lib/feedback-rules.ts`). Alert bodies embed the ref-ID so the user can drill into
the originating message.

## Turn-trace sidecar (2026-08-24)

Every `executeWorker` run (`pa/src/worker-exec.ts`) writes one JSONL line to
`~/.pa/turn-traces.jsonl` — a deterministic record of what the worker actually did,
beyond the 300-char text preview the analyzer sees. Built by `pa/src/lib/turn-trace.ts`;
never blocks or fails a dispatch (`appendTurnTrace` never throws; fired with
`void`, not awaited).

Schema v1 (`TurnTraceV1`): `v`, `run_id` (uuid, `CommandResult.runId`), `ts_start`/`ts_end`/
`duration_ms`, `origin` (`'bot'|'skill'|'self-improver'|'other'`), `chat_id`/`thread_id`/
`update_id` (bot) or `skill` (skill), `worker`/`model`/`session_id`, `exit_code`/`outcome`
(`'ok'|'error'|'timeout'|'killed'|'failover'`), `parsed` (whether the stream dialect was
recognized at all), `tool_calls[]`/`commands[]`/`files[]`/`errors[]` (capped
200/50/50/5 entries, 200/300 chars per string), `retries` (always 0 in v1 — the seam for
a future retry loop), `tokens`, `bytes_out`, `truncated`. Two dialects are parsed: agy/agyc
`step_update` stream events, and claude-family `tool_use`/`tool_result` blocks; codex
matches neither (`parsed:false`) until it comes off cooldown.

Join keys: `run_id` resolves any run directly (`pa ref <uuid>`). A bot-origin turn's archive
row does **not** carry `run_id` — `pa ref <refId>` resolves the trace via
`(thread_id, update_id)`, both written on the archive row by `main.ts`, and prints the
`--- trace (turn-traces.jsonl) ---` block after the resolved text.

Rotated `-turn-traces.jsonl` shards are derived debugging data (rebuildable from nothing)
and prune at 90 days via the existing `archive-prune` job (`PRUNABLE_ARCHIVE_SUFFIXES`,
`pa/src/lib/archive-files.ts`). The `recall-index` job refreshes `~/.pa/recall.sqlite` from
the live file every 10 minutes — traces searchable with no manual step.

## Recall (`pa recall`, 2026-08-24)

Full-text search over six sources, so workers/humans answer "did we discuss this"
without grepping raw JSONL:

| Source | What's indexed | Doc unit |
|---|---|---|
| `conversation` | `~/.pa/conversation-history.jsonl` + rotated shards | one bot turn |
| `trace` | `~/.pa/turn-traces.jsonl` + rotated shards | one worker run |
| `brain` | `~/.pa/topic-brains/*/BRAIN.md` + `INDEX.md` | one `## ` section |
| `kb` | the Ecosystem KB directory (`dirname(PA_KB_SOURCES_PATH)`) | one `## ` section per `.md` file |
| `review` | `~/.pa/review-digest-pending.jsonl` | one pending conflict |
| `decisions` | `~/.pa/decisions.sqlite` (rowid watermark) | one judgment-call row |

### Decision traces (2026-08-27)

`~/.pa/decisions.sqlite` records judgment calls with outcome (👍/👎 ⇒ approved/rejected; next turn ⇒ "replied"). Twins `decisions.ts` + `decisions.py` enforce immutable-after-insert + redact-before-insert. Writers: daily-mail-brief, travel-butler, `rm:` buttons. Contract: AI-164 SPEC §2.

Engine: `pa/src/lib/recall-store.ts` — in-process TS over `better-sqlite3` FTS5, WAL, incremental per-source cursors. Query: AND-first (`bm25`), OR-rescue under the limit (`rescue:true`), `total` never inflated; `--limit` ≤50; filters `--thread/--source/--role/--since/--until`.

Surfaces: `pa recall` CLI (`pa/src/commands/recall.ts`), the `pa_recall` MCP tool, the
non-destructive `recall-index` job, and a standing pointer line in the bot's system
prompt (`projects/telegram-bot/src/context.ts`).

## Feedback rules (AI-165, 2026-08-27)

Store: `~/.pa/feedback-rules.yaml` (add-only, supersede-by-key). Nightly triage compiles from corrections + ≥2 👎 decisions. Deterministic → active; semantic → pending until `pa rules accept`. Injection: fresh yaml per `buildPrompt` (12-rule/1500-char cap). Per-reply critic: `rules-critic.ts` in `main.ts` send seam (O(regex), never blocks/throws). Violations → `rules-violations.jsonl`; weekly digest via `pa rules weekly`. Store/critic/analyzer are code-fixer-protected. Contract: AI-165 SPEC §2.

## SLO report (`pa slo report`, 2026-08-27)

Error-budget reports per service from `~/.pa/app.log.jsonl`; config-driven (`~/.pa/slo.yaml`; examples in `pa/examples/slo.yaml.example`). **Per-skill outcome SLOs**: trailing 30d, `acted_on = approved + replied`; zero rows → `no decision data`. **`unknown`**: absent source files report `status: unknown` via `missingData`, never silent `OK`. Sources: `fetch_headers.py` writes misses; `verify_alert_sent.py` appends ok/missed receipts per run. CLI: `pa/src/commands/slo.ts`; lib: `pa/src/lib/slo.ts`.

## Topic task queue, event log + button grammar (`pa topic-*`, 2026-09-02)

Wave-1 substrate of the topic-task handover (2026-09-02, internal design record):

- **`pa/src/lib/topic-tasks.ts`** — durable per-topic task queue at `~/.pa/topic-tasks/<chatId>_<threadId>.json`. `appendTask` dedups by content hash (double-queueing cannot double-execute); pop is pop-first persist-before-inject (Wave-2's `claimNextTask` moves records into the running store under the same lock). Read-modify-writes run under proper-lockfile + in-process mutex via `writeJsonAtomic`; `validateTaskPrompt` mirrors the AI-185 topic_resume rules (non-empty, single line, ≤500 chars, no leading `/`).
- **`pa/src/lib/topic-events.ts`** — append-only per-topic event log at `~/.pa/topic-events/<chatId>_<threadId>.jsonl` (one UTF-8 JSON line per event; no retention). Closed kind enum (`task_queued`, `task_started`/`failed`/`parked`/`resumed`/`completed`, `question_asked`/`answered`, `note_added`, `wave_done`, `thread_spawned`/`steered`/`completed`/`failed`/`cancelled` — `thread_*` (2026-09-06, bot-emitted) carry thread id `t-<n>` as `ref`; ACTIVITY_KINDS excludes them from task-lane activity); the tolerant reader warn-once-skips malformed lines and returns events newest LAST; `resolveTopicKey` resolves `<chatId>_<threadId>` or a bare thread id by unique filename match across the three topic stores.
- **`pa/src/commands/topic.ts`** — the CLI shell: `pa topic-task add|list`, `pa topic-note add|list|close` (notes live in the topic store beside tasks — `~/.pa/topic-tasks/<key>.notes.json`; the prompt's `## Open items` renders tasks + notes from that one source, no derived file), and `pa topic-events <key>`; task/note writes append the `task_queued`/`note_added` events.
- **`pa/src/lib/callback-grammar.ts`** — the ONE inline-button grammar (`CallbackPrefix`, `parseCallbackData`, `gateFor`, `OPERATOR_PREFIXES`, the `q:` answer prefix, and `validateKeyboardRequest`), owned by pa and re-exported by the bot's callbacks.ts, so pa-side emitters validate `callback_data` against the same source the bot parses with (two producers of a frozen grammar = drift).
- **`[PA_KEYBOARD]:` envelope on `pa run` telegram_output** — a skill SCRIPT may end its output with one `[PA_KEYBOARD]: {"buttons":[...]}` line; run.ts strips it from the delivered text, validates it via `validateKeyboardRequest` (1..6 buttons, ≤40-char labels, grammar-valid `callback_data`), refuses keyboards for protected skills, and attaches it to the send; any failure strips the keyboard and warns, never failing the run.
- **PA_META `question` action** — `question{text, options (1..4), taskId?}` arms `state.pending_question`; the reply renders option buttons and a press is injected into the topic as a synthetic turn through the one-parser `q:` path. A question is rejected while a pending action or confirm is armed (confirm wins).

### Topic executor lane (Wave 2, 2026-09-02)

Queued tasks execute on a DEDICATED lane (2026-09-02 wave-2 internal design record). The bot's 60s `topic-task-drain` claims ≤2 tasks/tick (global) via `claimNextTask` into `~/.pa/topic-tasks/<key>.running.json`: no per-topic cap (`TOPIC_TASK_SLOTS`=100 backstop; budget = `running.length`), 3 attempts max (exhausted → remove + `task_failed`), failed dispatches defer 10 min, stale `running` (30 min) demotes to ready for EVERY enumerated topic before claims (crash recovery, no pid checks); prompts re-validated at drain (invalid → WARN + `failTask`), foreign chats skipped pre-claim. `task-executor.ts` dispatches NEVER take the topic blackboard lock, touch `state.turns`, or ride the human reply pipeline. Task prompts carry the micro-thread (last 6 turns), open items, and in-flight siblings; task-lane PA_META handles ONLY `question` (park + `qt:` keyboard) / `watch_job` / `kb_note` / `run_skill` (non-protected). Pickup/question FYI message ids are tier-1 anchors (user reply → `routeReplyToTask` → `answerTask`; `qt:` press answers the parked task directly — convergence, not injection). Status: the card's `Tasks:` line + `renderOpenItems` tier-2 in-flight lines.

## Voice inbox app (`projects/voice-inbox`, 2026-09-05)

A foreground PWA + localhost API that turns spoken/typed requests into tasks in a
tenant-scoped SQLite ledger (`~/.pa/voice-inbox/ledger.sqlite`; every query takes
`tenant_id`; a code-level transition table is the only state gate). The chain:
PWA → HTTPS API → ledger; ledger ↔ `route-queue.jsonl` ↔ bot drain → synthetic route
turn (`__synthetic: 'route'`) → worker fleet. The four Python worker scripts
(route/telemetry/input/complete) write the same ledger directly and never create schema;
`route_task.py` also writes one decisions.sqlite row per routing decision — the
explainability feed. Operator input arrives as one of six typed input-request widgets; the
answer is stored server-side as a file and delivered to the worker as a path, so secrets
never travel through chat. Config:
`docs/CONFIGURATION.md` "Voice inbox app"; project brain: `projects/voice-inbox/CLAUDE.md`.

## Logging

Structured JSON logs at `~/.pa/app.log.jsonl`. Format:

```json
{"timestamp":"2026-05-21T18:30:00+05:30","level":"info","module":"workers","message":"failover","ctx":{"from":"zclaude","to":"agy","reason":"rate-limit"}}
```

Use `pa logs <skill>` to read recent runs.

## Observability surfaces

- **`pa costs`** — usage/cost rollups by worker, model, skill. Tokens are factual; dollars are read-time estimates from built-in list prices + `model_pricing` overrides (`docs/CONFIGURATION.md` § ModelPricing). Unpriced keys show `-` (table) or `null` (JSON). Flags: `--day|--week|--month`, `--skill`, `--json`.
- **`pa slo report --json`** — machine-readable error-budget reports; both digest scripts render them generically by service name.
- **Daily digest skill** — deterministic 24h activity rollup (runs, tokens, est. cost, failover, alerts, DLQ, self-improver actions, SLO) with explicit unavailable lines; Python → stdout → `telegram_output` relay, date-scoped dedup. Script: `pa/scripts/daily_digest.py`; template: `examples/skills/daily-digest/skill.md`. Schedule and destination are per-deployment skill frontmatter.
- **Weekly digest skill** — same pattern weekly: `pa/scripts/weekly_digest.py`.

## Conventions

- **Timestamps**: IST by default (UTC+5:30). Override via `PA_TZ_OFFSET_MINUTES` env var. All log messages use ISO-8601 with the configured offset.
- **Atomic file writes**: Skills that update files should write to `<path>.tmp` then rename, avoiding partial writes if interrupted.
- **Git snapshots before destructive updates**: Skills modifying tracked files in a git repo should `git commit -am "pre-update snapshot"` before editing, then `git commit -am "<skill> auto-refresh"` after.
- **Marker-based content insertion**: Skills like `update-brain` use `<!-- AUTO:* -->` markers to identify auto-managed sections within manually-edited files. The skill validates markers exist post-update and refuses to write if any disappeared.
- **Line-count floor**: Stateful skills that rewrite files should refuse to write the new content if it's < 80% of the old size — a guard against accidental wipes.

Multi-session coordination (claims, @build, clobber detection, destructive-git ban, test isolation): docs/multi-session-protocol.md. The `@build` reservation is taken by the npm scripts themselves (`pa/scripts/build.mjs`, `pa/scripts/run-tests.mjs` and the bot's copies, all via `pa/src/lib/build-lock.ts`); a `PreToolUse` hook (`pa/scripts/hooks/reservation-guard.py`) warns on edits under a foreign reservation.

See also — the full `docs/` index (rebuilt 2026-08-07, see `docs/CONVENTIONS.md` § "Brain-file organization" for the naming/size rules behind this split):

Evergreen guides (audience-facing, read when learning or setting up a subsystem):
- `docs/QUICKSTART.md` — first-run setup, numbered walkthrough
- `docs/DEPLOYMENT.md` — deploying your own pa-framework fork
- `docs/CONFIGURATION.md` — every config file/env var reference
- `docs/CONVENTIONS.md` — repo hygiene, naming, brain-file organization
- `docs/SKILLS_GUIDE.md` — authoring skills
- `docs/WORKERS_GUIDE.md` — the worker contract, adding a worker
- `docs/BOT_GUIDE.md` — the Telegram bot end to end
- `docs/TROUBLESHOOTING.md` — `pa health` diagnosis, common failure modes

Operational-detail files (read on demand, only when touching that specific area):
- `docs/repo-topology.md` — git-workflow skill locking, the public/private mirror split, PII-guard internals
- `docs/maintenance-jobs.md` — the full declared-maintenance-job catalog (pa-host + bot-host)
- `docs/bot-reliability-internals.md` — DLQ, delivery-dedup guarantees, `/stop` cancellation, AI-096 deviations

Auto-loading (native Claude Code directory-scoped `CLAUDE.md`, not manually read):
- `projects/telegram-bot/CLAUDE.md`
