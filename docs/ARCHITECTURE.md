# pa-framework — Architecture

> Audience: developers extending the framework or building skills on top of it.

## Five intelligence layers

The framework is structured so that each layer depends only on the ones below it:

| # | Layer | Where it lives | What it does |
|---|---|---|---|
| 5 | Communication | `projects/telegram-bot/` | Long-poll Telegram bot, forum-topic routing, conversation archive |
| 4 | Skill substrate | `~/.pa/skills/<name>/skill.md` | Markdown skills with YAML frontmatter; runtime dispatch |
| 3 | Orchestrator | `pa/src/{scheduler,blackboard,analyzer,drafts,lib/*}.ts` | Cron eval, locking, structured logs, alert dedup, learn pipeline |
| 2 | Worker pool | `pa/src/{workers,worker-exec,worker-evaluator,state-monitor,rate-limits-*}.ts` | CLI spawn, failover, rate-limit parsing, stuck-state evaluation |
| 1 | Auth substrate | `~/.pa/google_auth.py` + Telegram/mobile bridge helpers (see `examples/oauth/README.md`) | Shared Google OAuth for Gmail/Drive/Docs plus optional Telegram/mobile recovery |

Domain projects (e.g., `projects/daily-mail-brief/`) sit *above* layer 5; they use the bot for delivery, register skills in `~/.pa/skills/`, and call into the orchestrator via the `pa` CLI or `pa notify`.

## Telegram/mobile OAuth recovery

The framework also supports a mobile-friendly Google OAuth recovery loop:

1. A project detects expired Google credentials and launches
   `pa/scripts/start_google_telegram_reauth.py`.
2. That script generates a consent URL, stores pending state in
   `~/.pa/google-telegram-auth.json`, and sends the URL to Telegram.
3. Google redirects the user to `projects/google-oauth-redirect/`, a static
   page that renders `/auth <code> <state>`.
4. The user pastes that command into Telegram.
5. The bot's `/auth` handler runs `finish_google_telegram_reauth.py`, writes the
   refreshed token, and optionally invokes a private resume hook.

Public/private boundary:

- **Public substrate**: the bot `/auth` surface, pending auth-session format,
  start/finish scripts, static bridge page, and docs.
- **Private deployment**: OAuth client JSONs, token/state storage paths, and the
  action registry in `~/.pa/oauth_resume_hook.py`.

## Worker pool contract

Workers are external CLI processes spawned via `child_process.spawn`. Configured in `~/.pa/config.yaml` `workers:` array with fields: `name`, `command`, `args`, `check` (availability probe), `input_mode` (arg/stdin-text/stdin-json), `output_format` (stream-json), `secret_allowlist` (default-deny per worker), `rate_limit_patterns`, `priority`, `state_dir`/`state_pattern` (session-mode rate-limit detection), `worker` (force specific), `no_fallback`. See `docs/WORKERS_GUIDE.md`.

**Input modes**: `arg` (prompt file, `{prompt}`→`@path`), `stdin-text`, `stdin-json`. **Output**: exit 0=success; NDJSON events parsed for session/rate-limit. **Rate-limit**: text-pattern (stdout/stderr substrings) or session-mode (state file tail, 429 events). **Process tree**: tracked and killed on timeout; Windows uses CIM, POSIX uses `ps`/`pgrep`.

## Skill YAML frontmatter schema

Skills live at `~/.pa/skills/<name>/skill.md`. The YAML frontmatter (between `---` markers) declares scheduling and execution behavior; the body is the prompt sent to the worker (or, with `cmd:`, ignored).

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
| `cost_tier` | `'off_peak' \| 'anytime'` | `'anytime'` | Cost tier for scheduled skills. `off_peak` skills run only during the z.ai off-peak window (19:30-11:30 IST; configurable via `cost_tier.peak_window_utc` in config.yaml, default Mon-Fri 06:00-10:00 UTC); periodic off_peak skills are deferred during peak hours with once-daily logging. Time-pinned crons with `cost_tier` are ignored with a config warning. |

### `telegram_output`

```yaml
telegram_output:
  chat_id: '-1001234567890'             # destination chat; supports ${VAR} interpolation
  thread_id: 0                          # optional forum thread; supports ${VAR}
  token_secret: TELEGRAM_BOT_TOKEN      # env var name (NOT the token value)
```

When set, the framework posts the worker's final output to the specified Telegram destination. Env interpolation (`${VAR}`) is applied to `chat_id`, `thread_id`, and `token_secret`. Numeric strings are coerced back to Number for `thread_id`.

## PA_META envelope

A skill's worker (or the bot's LLM response) can emit a metadata envelope as the LAST line of its output:

```
[PA_META]: {"actions":[{"type":"...", ...}]}
```

Action types:

- **`retry_with_worker{reason}`** — worker declares it can't complete; orchestrator routes to the next-priority worker.
- **`run_skill{skill}`** — trigger another skill automatically after this one finishes.
- **`confirm_required`** — used by the bot in place of "Reply *yes* to confirm" text; the bot tracks pending confirmations per-topic.
- **`watch_job{description,check,deadline_minutes,interval_seconds}`** — register an async watch (AI-170). `check` is `{type, path?, pattern?, since_iso?, pid?}`; `type` is one of `file_exists`, `file_gone`, `file_newer_than`, `file_contains`, `process_gone`. Read-only observations only — no shell, no network, no writes. `logic.ts` validates the shape, `main.ts` writes, and the reply always states the registered id or the rejection reason.

The bot strips the envelope before delivering text to the user. In execution mode (`Pending Confirmation` set), the bot suppresses any `[PA_META]` the model emits.

## Sequential workflow chains

Chains are defined as YAML files in `~/.pa/chains/` and execute a series of skills sequentially, with retry logic and failure handling.

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

- **Sequential only**: No parallel execution. Steps run in order.
- **Subprocess spawning**: Each step spawns `pa run <skill>` as a subprocess, inheriting git-workflow lock discipline automatically (children take their own locks).
- **Failure propagation**:
  - `on_failure: stop` (default): Chain stops immediately on step failure.
  - `on_failure: notify`: Sends a Telegram notification but continues to next step.
  - `on_failure: continue`: Continues silently to next step.
- **Retry logic**: If a step fails, it retries up to `max` attempts with `backoff_s` seconds between attempts.
- **End-of-chain report**:
  - `report: telegram`: Sends a summary to pa-alerts (deduped by chain-name+date).
  - `report: stdout`: Prints the summary to console.

### Example

The `commit-ship.yaml` chain (included as `~/.pa/chains/commit-ship.yaml`):

```yaml
steps:
  - skill: update-brain
    on_failure: notify

  - skill: commit
    on_failure: stop

  - skill: push
    retry:
      max: 3
      backoff_s: 5
    on_failure: stop

  - skill: push-public
    on_failure: notify

report: telegram
```

This chain stages and ships all pending work: update brain → commit → push → sync to public mirror.

### CLI

```bash
pa chain run <name>    # Execute a chain
pa chain list          # List available chains
```

### Validation

The chain schema is strict and validated on load:

- Unknown fields are rejected (at top level, step level, and retry level).
- Invalid values are rejected (e.g., negative `max`, unknown `on_failure` values).
- Missing required fields are rejected (`skill` is required).
- Defaults are applied automatically (`retry.max: 1`, `retry.backoff_s: 0`, `on_failure: stop`, `report: stdout`).

## Golden-task eval gate (self-improver)

The autonomous self-improvement loop (`pa/src/self-improver.ts`) includes a golden-task eval gate (Wave H WPH1) that validates skill prompt changes against a suite of deterministic quality checks.

### Gate operation

When a skill prompt fix passes validation, the eval gate runs a subset of golden tasks against the change:

- **Deterministic-only (v1)**: Tasks 4-6 run against static fixture inputs (no worker dispatch):
  - `markdown_shape`: Output parses as valid Markdown
  - `pa_meta_wellformedness`: PA_META envelope parses correctly, protected-skill forgery rejected
  - `injection_resistance`: Output refuses prompt injection attempts
- **LLM-dependent (deferred to v2)**: Tasks 1-3 require worker dispatch and are skipped unless `PA_EVAL_FULL=1`:
  - `ref_id_format`: Output includes properly formatted ref-ID (`_Ref: s-[0-9a-f]{12}_`)
  - `date_arithmetic`: Correct date arithmetic for calendar events
  - `grounding_citation`: Output cites source documents correctly

### Gate behavior (SOFT in v1)

The gate is deliberately non-blocking in v1:

- **Pass**: Change is applied, eval outcome recorded in audit trail
- **Fail**: Change is parked as `validation-failed-pending` with eval detail, human reviews via `pa improvements`

The validation floor still governs — a change that fails validation stays pending regardless of eval results.

### Scoring

Each task has a `scorer.py` that outputs JSON `{pass: bool, detail: string}` and exits 0 (pass) or 1 (fail). Results are aggregated and appended to `~/.pa/eval-results.jsonl` for audit trail inspection.

### Audit trail

Applied changes gain an `eval` field in their audit record:

```json
"eval": {
  "pass": 2,
  "fail": 1,
  "skipped": 3,
  "detail": "Eval gate: 2 passed, 1 failed, 3 skipped. Failures: ..."
}
```

This enables post-factum review via `pa improvements --show <draft>`.

## Async watch jobs (AI-170, 2026-08-31)

Store `~/.pa/watch-jobs.json` (lockfile + atomic write, same family as `reservations.json`);
engine the single declared `watch-jobs-runner` job (pa host, 60 s). `pa/src/lib/watch-jobs.ts`
holds the ONE validator (`validateWatchInput`), the store and the tick engine — every
registration path routes through it. Two paths: the `watch_job` PA_META action and
`pa watch add`. Bounds: 25 active, 10 checks/tick, 60 s-1 h intervals, 7-day max deadline,
256 KB tail reads. Terminal states `reported`/`expired`/`check-failed`/`cancelled`; all but
`cancelled` report to the registering chat/thread, redacted and `_Ref:`-stamped, and the send
precedes the status write. Spec: `plans/2026-08-31-ai170-async-watch-SPEC.md`.

## Blackboard & locking

`pa/src/blackboard.ts` manages a JSON file at `~/.pa/blackboard.json` containing PID + heartbeat-timestamp pairs per shared resource. Concurrent skill executions acquire/release locks via `proper-lockfile` on the JSON file itself.

Stale locks (heartbeat > 10 minutes old) are flagged by `pa health` and can be cleared via `pa purge-locks`. Each worker process refreshes its heartbeat periodically while running.

Lock rows are `(resource, agent, pid, heartbeat, contextId?)`. A holder that runs longer than `PA_HEARTBEAT_STALE_MS` must renew via `startLockRenewal()` and handle its `onLost` callback — a bare `setInterval(updateHeartbeat)` discards the `false` that means "your row was purged", which is silent double-occupancy. Since 2026-08-23 `startLockRenewal` is the only heartbeat mechanism in the codebase (`commands/run.ts`, `commands/catchup.ts` and `code-fixer.ts` were migrated onto it) and accepts an optional `client` for dependency-injected callers. `releaseLock(resource, agent, contextId?, { pid })` scopes the delete: without a `contextId` and `pid` it removes every row for that `(resource, agent)` pair, so a stale holder's cleanup can delete a live same-named holder's lock. Two resources exist: `git-workflow` (the private tree, declared by the git-workflow skills — `commit`, `push`, `push-public`, `investigate-flagged`, `update-brain` — via `exclusive_resource`, taken directly by `code-fixer.ts` and `self-improver.ts`) and `git-public-workflow` (the derived `pa-public/` tree, taken by `pa public-sync`).

## Conversation archive + DLQ

- **Archive**: `~/.pa/conversation-history.jsonl` — append-only log of every bot turn (one JSON object per line). Read by the `ecosystem-kb`-style skills for KB synthesis.
- **Per-topic state**: `~/.pa/telegram-bot-topic-{chatId}_{threadId}.json` — rolling 20-turn window for the bot's context window.
- **DLQ**: `~/.pa/telegram-dlq.jsonl` — bot replies that failed to send are appended here. On bot startup, the DLQ is sequentially retried via `dlq.ts`.

## Ref-IDs

Every notable message in the system gets a 4-character ref ID with a single-letter prefix:

- `c-XXXX` — Claude conversation message
- `g-XXXX` — Gemini conversation message (legacy; the Gemini CLI worker was sunset 2026-08-08, AI-131)
- `l-XXXX` — Log entry
- `z-XXXX` — zClaude message
- `s-XXXX` — Skill output

The `pa ref <id>` command resolves any ref to its source. Used in alert bodies (`_Ref: l-AB12_`) so the user can `pa ref l-AB12` to drill into the originating message.

## Turn-trace sidecar (2026-08-24)

Every `executeWorker` run (`pa/src/worker-exec.ts`) writes one JSONL line to
`~/.pa/turn-traces.jsonl` — a deterministic record of what the worker actually did,
beyond the 300-char text preview the analyzer sees. Built by `pa/src/lib/turn-trace.ts`;
never blocks or fails a dispatch (`appendTurnTrace` never throws or rejects; the write
is fired with `void`, not awaited).

Schema v1 (`TurnTraceV1`): `v`, `run_id` (uuid, `CommandResult.runId`), `ts_start`/`ts_end`/
`duration_ms`, `origin` (`'bot'|'skill'|'self-improver'|'other'`, from the dispatch's
`resource` string), `chat_id`/`thread_id`/`update_id` for bot origins, `skill` for skill
origins, `worker`/`model`/`session_id`, `exit_code`/`outcome`
(`'ok'|'error'|'timeout'|'killed'|'failover'`), `parsed` (whether the stream dialect was
recognized at all), `tool_calls[]`/`commands[]`/`files[]`/`errors[]` (each capped —
200/50/50/5 entries, 200/300 chars per string), `retries` (always 0 in v1 — the seam for
a future retry loop), `tokens`, `bytes_out`, `truncated`. Two dialects are parsed: agy/agyc
`step_update` stream events, and claude-family `tool_use`/`tool_result` blocks; codex
matches neither (`parsed:false`) until it comes off cooldown.

Join keys: `run_id` resolves any run directly (`pa ref <uuid>` — see below). A bot-origin
turn's archive row (`~/.pa/conversation-history.jsonl`) does **not** carry `run_id` —
`pa ref <refId>` instead resolves the trace via `(thread_id, update_id)`, both written on
the archive row by `main.ts`. `pa ref` prints a `--- trace (turn-traces.jsonl) ---` block
(outcome, worker, model, duration, tool-call counts by name, commands/files/errors) after
the resolved text, when a trace is found.

Rotated `-turn-traces.jsonl` shards are derived debugging data (rebuildable from
nothing) and prune at 90 days via the existing `archive-prune` maintenance job —
`PRUNABLE_ARCHIVE_SUFFIXES` (`pa/src/lib/archive-files.ts`) now includes the suffix, so
no new job or registry entry was needed (C7 in the wave spec). The `recall-index`
maintenance job (below) refreshes `~/.pa/recall.sqlite` from the live file every 10
minutes, so a trace becomes searchable without any manual step.

## Recall (`pa recall`, 2026-08-24)

Full-text search over six sources, so a worker (or human) can answer "did we discuss
this" / "what did that run do" without grepping raw JSONL:

| Source | What's indexed | Doc unit |
|---|---|---|
| `conversation` | `~/.pa/conversation-history.jsonl` + rotated shards | one bot turn |
| `trace` | `~/.pa/turn-traces.jsonl` + rotated shards | one worker run |
| `brain` | `~/.pa/topic-brains/*/BRAIN.md` + `INDEX.md` | one `## ` section |
| `kb` | the Ecosystem KB directory (`dirname(PA_KB_SOURCES_PATH)`) | one `## ` section per `.md` file |
| `review` | `~/.pa/review-digest-pending.jsonl` | one pending conflict |
| `decisions` | `~/.pa/decisions.sqlite` (rowid watermark) | one judgment-call row |

### Decision traces (2026-08-27)

`~/.pa/decisions.sqlite` records the PA's judgment calls (request, decision, rationale, alternatives) with outcome (👍/👎 ⇒ approved/rejected; next in-thread user turn ⇒ weak "replied") and reaction. Twins `pa/src/lib/decisions.ts` + `pa/scripts/decisions.py` enforce immutable-after-insert and redact before insert. Writers: daily-mail-brief (deterministic inner-LLM marker block), travel-butler, `rm:` buttons. Durable, no retention. Contract: the AI-164 SPEC §2.

Engine: `pa/src/lib/recall-store.ts` — in-process TypeScript over `better-sqlite3` FTS5, WAL, incremental per-source cursors (byte-offset for append-only JSONL; mtime+size→sha256 for whole-file sources). Query: AND-first (`bm25`), OR-rescue fills under the limit (flagged `rescue:true`), `total` never inflated; `--limit` ≤50; filters `--thread/--source/--role/--since/--until`.

Surfaces: `pa recall "<query>" [--thread <id>] [--source <s>] [--role <user|assistant>] [--since <d>] [--until <d>] [--limit <n>] [--json] [--reindex] [--rebuild]`
(`pa/src/commands/recall.ts`); the `pa_recall` MCP tool (`docs/WORKERS_GUIDE.md` §
"MCP integration"); the `recall-index` maintenance job (pa host, every 10 minutes,
non-destructive — `recall.sqlite` is fully derived and rebuildable with `pa recall
--rebuild`); and a standing prompt bullet + per-thread pointer line in the bot's system
prompt (`projects/telegram-bot/src/context.ts`, `projects/telegram-bot/CLAUDE.md`).

## Feedback rules (AI-165, 2026-08-27)

Store: `~/.pa/feedback-rules.yaml` (add-only, supersede-by-key). Nightly triage compiles from corrections + ≥2 👎 decisions. Deterministic → active; semantic → pending until `pa rules accept`. Injection: fresh yaml per `buildPrompt` (12-rule/1500-char cap). Per-reply critic: `rules-critic.ts` in `main.ts` send seam (O(regex), never blocks/throws). Violations → `rules-violations.jsonl`; weekly digest via `pa rules weekly`. Store/critic/analyzer are code-fixer-protected. Contract: AI-165 SPEC §2.

## SLO report (`pa slo report`, 2026-08-27)

Error-budget reports per service from `~/.pa/app.log.jsonl`. Services are config-driven (`~/.pa/slo.yaml` via `--config` or the default path; generic examples ship in code — a deployment names its own, see `pa/examples/slo.yaml.example`). **Per-skill outcome SLOs**: trailing 30d, `acted_on = approved + replied`, renders `no decision data` for skills with zero rows. **`unknown` status fix** (was dead code — `missingData` never filled before status computation): services whose source file is absent (e.g. `~/.pa/<skill>/latest.json`, a watchdog receipts file) now report `status: unknown` instead of silent `OK`. Sources: `fetch_headers.py` writes misses; `verify_alert_sent.py` appends ok/missed receipts per run. CLI: `pa/src/commands/slo.ts`; lib: `pa/src/lib/slo.ts`.

## Logging

Structured JSON logs at `~/.pa/app.log.jsonl`. Format:

```json
{"timestamp":"2026-05-21T18:30:00+05:30","level":"info","module":"workers","message":"failover","ctx":{"from":"zclaude","to":"agy","reason":"rate-limit"}}
```

Use `pa logs <skill>` to read recent runs.

## Observability surfaces

- **`pa costs`** — usage/cost rollups by worker, model, skill. Tokens are factual counts; dollars are read-time estimates from built-in list prices plus `model_pricing` config overrides (`docs/CONFIGURATION.md` § ModelPricing). Unpriced keys show `-` (table) or `null` (JSON). Flags: `--day|--week|--month`, `--skill`, `--json`.
- **`pa slo report --json`** — machine-readable error-budget reports; both digest scripts render them generically by service name.
- **Daily digest skill** — deterministic 24h activity rollup (runs, tokens, est. cost, failover, alerts, DLQ, self-improver actions, SLO) with explicit unavailable lines; Python → stdout → `telegram_output` relay, date-scoped dedup. Script: `pa/scripts/daily_digest.py`; template: `examples/skills/daily-digest/skill.md`. Schedule and destination are per-deployment skill frontmatter.
- **Weekly digest skill** — same pattern weekly: `pa/scripts/weekly_digest.py`.

## Conventions

- **Timestamps**: IST by default (UTC+5:30). Override via `PA_TZ_OFFSET_MINUTES` env var. All log messages use ISO-8601 with the configured offset.
- **Atomic file writes**: Skills that update files should write to `<path>.tmp` then rename to ensure no partial writes if interrupted.
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
- `projects/telegram-bot/CLAUDE.md` — loads automatically whenever a session touches that directory
