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

Expired Google credentials: `start_google_telegram_reauth.py` sends a consent URL to Telegram (state in `~/.pa/google-telegram-auth.json`); Google redirects to `projects/google-oauth-redirect/`, the user pastes `/auth <code> <state>`, the bot runs `finish_google_telegram_reauth.py` — token refreshed + optional resume hook.

Boundary: **public** = bot `/auth` surface, auth-session format, start/finish scripts, bridge page, docs; **private** = OAuth client JSONs, token/state paths, the `~/.pa/oauth_resume_hook.py` action registry.

## Worker pool contract

External CLI processes via `child_process.spawn`, configured in `~/.pa/config.yaml` `workers:` (full field table: `docs/CONFIGURATION.md`; the worker contract: `docs/WORKERS_GUIDE.md`).

**Turn routing (optional `routing_policy:`)**: the bot classifies each turn code/general via deterministic regex signals; code turns override the topic default with `code_worker` outside / `peak_code_worker` inside `cost_tier.peak_window_utc` (the same window `off_peak` skills defer on). Precedence: `/agent` pin → same-turn router choice → policy → `topic_defaults` → failover chain; absent/disabled block = unchanged behavior. Field table: `docs/CONFIGURATION.md` § RoutingPolicyConfig.

**Input modes**: `arg` (prompt file, `{prompt}`→`@path`), `stdin-text`, `stdin-json`. **Output**: exit 0=success; NDJSON events parsed for session/rate-limit. **Rate-limit**: text-pattern (stdout/stderr substrings), session-mode (state file tail, 429 events), or per-worker parser (e.g. `rate-limits-devin.ts` for the Devin CLI). **Process tree**: tracked and killed on timeout; Windows uses CIM, POSIX uses `ps`/`pgrep`.

## Skill YAML frontmatter schema

The YAML frontmatter (between `---` markers) declares scheduling and execution behavior; the body is the prompt sent to the worker (or, with `cmd:`, ignored).

| Field | Type | Default | Effect |
|---|---|---|---|
| `cron` | string | — | Standard 5-field cron expression. Optional — if absent, skill is manual-trigger only. |
| `on_missed` | `'latest' \| 'all' \| 'skip'` | `'latest'` | Catchup behavior. `'all'` is capped at 10 missed runs. |
| `cwd` | string | — | Working directory for the worker process. `~` expands to homedir. `${VAR}` env-interpolated. |
| `worktree_cwd` | boolean | false | Linked-worktree `pa run` callers spawn the worker in their own toplevel (equal `--git-common-dir`; `resolveWorkerTreeRoot`); foreign/nested/non-repo callers keep `cwd`. Off by default — push/ref-inspecting skills must stay pinned to the declared checkout. |
| `secrets` | string[] | — | Env vars to inject into the worker process from `~/.pa/secrets.env`. |
| `timeout` | number (sec) | 3600 | Max total execution time. |
| `idle_timeout` | number (sec) | 300 | Max silence (no stdout) before kill. |
| `trigger_description` | string | — | LLM-readable description for skill chaining (`run_skill` PA_META action); doubles as roster text on every `run_skill`-bearing lane (`renderSkillRoster`). |
| `description` | string | — | Human-readable one-liner shown in /skills and pa surfaces; roster fallback when no `trigger_description`. |
| `inject_triggers` | boolean | false | If true, inject all other skills' `trigger_description`s into this skill's prompt. No shipped skill sets it — kept as the `pa run` catalog switch. |
| `worker` | string | — | Force a specific worker (e.g., `codex`) instead of priority-ordered failover. |
| `no_fallback` | boolean | false | When true with `worker:`, don't failover on failure. |
| `cmd` | string | — | Direct shell command (bypasses LLM). `${VAR}` env-interpolated. |
| `telegram_output` | object | — | Deliver LLM output to Telegram. See below. |
| `cost_tier` | `'off_peak' \| 'anytime'` | `'anytime'` | `off_peak` skills run only in the z.ai off-peak window (`cost_tier.peak_window_utc`); periodic off_peak skills defer during peak (once-daily log); time-pinned crons with `cost_tier` are ignored with a warning. |

### `telegram_output`

```yaml
telegram_output:
  chat_id: '-1001234567890'             # destination chat; supports ${VAR} interpolation
  thread_id: 0                          # optional forum thread; supports ${VAR}
  token_secret: TELEGRAM_BOT_TOKEN      # env var name (NOT the token value)
```

The framework posts the worker's final output there; `${VAR}` interpolation applies to all three fields, and numeric strings coerce back to Number for `thread_id`.

## PA_META envelope

A skill's worker (or the bot's LLM response) can emit a metadata envelope as the LAST line of its output:

```
[PA_META]: {"actions":[{"type":"...", ...}]}
```

Action types (each bot lane accepts a subset — an unsupported type comes back as a loud rejection notice in the reply, never a silent drop):

- **`question{text,options}`** — ask the operator to pick 1-4 options; buttons render, the press routes back. Lanes: human, task, thread, orchestrator.
- **`confirm_required`** — used by the bot in place of "Reply *yes* to confirm" text; the bot tracks pending confirmations per-topic. Lanes: human, orchestrator; thread lane accepts it only for voice-stamped records (ask-mirroring).
- **`watch_job{description,check,deadline_minutes,interval_seconds}`** — register an async watch (AI-170). `check` is `{type, path?, pattern?, since_iso?, pid?}`; `type` ∈ `file_exists`/`file_gone`/`file_newer_than`/`file_contains`/`process_gone`; read-only (no shell/network/writes). The reply states the registered id or the rejection. Lanes: human, task, thread, orchestrator.
- **`kb_note{domain,note}`** — record a dated note into Ecosystem KB Sources.md. Lanes: human, task, orchestrator.
- **`run_skill{skill}`** — trigger another skill automatically after this one finishes (never the protected git-workflow skills). Lanes: human, task, orchestrator.
- **`retry_with_worker{reason}`** — worker declares it can't complete; the dispatcher routes to the next-priority worker. Human lane.
- **`restart_bot`** — request a bot restart. Human lane.
- **`spawn_thread{title,prompt,worker?,depends_on?}`** / **`steer_thread{thread_id,message,mode}`** — orchestrator-lane only; create/steer execution threads.
- **`suggested_items`** — not an action: an optional top-level envelope field (`"suggested_items":["…"]`) carrying 0-4 reply chips; the orchestrator and thread lanes persist them as `sr:` buttons on the topic.

The bot strips the envelope before delivering text to the user; in execution mode (`Pending Confirmation` set) it suppresses any `[PA_META]` the model emits. Lane enforcement lives in `worker-reply.ts` (`PA_META_DOWNSTREAM_TYPES`) and the per-executor action loops.

## Sequential workflow chains

Chains are YAML files in `~/.pa/chains/` that run skills sequentially, with retry and failure handling.

### Chain schema

```yaml
steps:
  - skill: <name>
    args?: <string array>       # passed to `pa run <skill>`
    retry?: { max: <n>, backoff_s: <n> }
    on_failure: stop|notify|continue
report: telegram|stdout
```

### Execution model

- **Sequential**; each step spawns `pa run <skill>` as a subprocess (own git-workflow locks).
- **Failure**: `stop` (default) halts; `notify` pages and continues; `continue` is silent.
- **Retry**: up to `max` attempts, `backoff_s` apart.
- **Report**: `telegram` → pa-alerts summary (deduped chain-name+date); or `stdout`.
- **Validation (strict, on load)**: unknown fields/invalid values rejected; `skill` required; defaults applied.

Example — the shipped `~/.pa/chains/commit-ship.yaml`: `update-brain` (notify) → `commit` (stop) → `push` (retry 3×, backoff 5s, stop) → `push-public` (notify), `report: telegram`: stage and ship all pending work.

### CLI

Commands: `pa chain run <name>`, `pa chain list`.

## Golden-task eval gate (self-improver)

The self-improvement loop (`pa/src/self-improver.ts`) gates skill prompt changes behind deterministic quality checks; a validated fix runs golden tasks:

- **v1 (deterministic-only)**: tasks 4-6 on static fixtures (no worker dispatch): `markdown_shape`, `pa_meta_wellformedness` (protected-skill forgery rejected), `injection_resistance`.
- **v2 (LLM-dependent, skipped unless `PA_EVAL_FULL=1`)**: tasks 1-3 need worker dispatch: `ref_id_format`, `date_arithmetic`, `grounding_citation`.

The gate is SOFT in v1: pass applies the change; fail parks it as `validation-failed-pending` for review via `pa improvements`. The validation floor still governs: a change failing validation stays pending regardless of eval. Each task's `scorer.py` outputs JSON `{pass, detail}`, exit 0/1; results aggregate into `~/.pa/eval-results.jsonl`; applied changes gain an `eval` field (`pa improvements --show <draft>`).

## Async watch jobs (AI-170, 2026-08-31)

Store `~/.pa/watch-jobs.json` (lockfile + atomic write); the declared `watch-jobs-runner`
job (pa host, 60 s) ticks it. `pa/src/lib/watch-jobs.ts` holds the ONE validator
(`validateWatchInput`), the store and the tick engine — every registration path routes
through it (`watch_job` PA_META action, `pa watch add`). Bounds: 25 active, 10
checks/tick, 60 s-1 h intervals, 7-day max deadline, 256 KB tail reads. Terminal states
`reported`/`expired`/`check-failed`/`cancelled`; all but `cancelled` report to the
registering chat/thread, redacted, `_Ref:`-stamped, sent before the status write.

## Condition-gated resume (`projects/reminders/condition_resume.py`, 2026-09-12)

A reminder can carry `resume_action: {type: "topic_resume", prompt}` (AI-185,
`add_reminder.py --resume-action-json`); at fire time the `reminder-resume` drain source
queues it and `injectSystemReminderUpdate` runs `prompt` as a fresh system turn in the
topic — the mechanism by which a reminder can autonomously DO something, not just notify.
Unlike `watch_job`, the condition is anything the fired turn can evaluate with its own
tools, and the completion action is caller-composed free text at the same trust level as
any other tool call the minting session already makes.

`voice_inbox_resume: {type, conversation_id, prompt}` (2026-09-12) is the sibling for a
reminder whose pending decision originated in a voice-inbox UI conversation:
`topic_resume` captures only a chat/thread at mint time and cannot follow a conversation
whose routing moves between Telegram topics over its lifetime. At fire time the drain
type-branches on `resume_action.type` BEFORE the `chat_id`/`allowedChatIds` gate (that
gate covers only `topic_resume`'s Telegram delivery target) and shells out to
`projects/voice-inbox/scripts/create_conversation_task.py --conversation-id <id> --text
<prompt>`, which resolves the conversation's CURRENT routing at fire time and appends a
new task into that `conversation_id`. Fail-open like every drain path here:
spawn/parse/non-zero-exit failures are logged and swallowed, never crashing the drain.
Same byte-identical-mirror validation as `topic_resume`: `validate_voice_inbox_resume`
at mint time, `validateVoiceInboxResumeAction` at fire time, both test-pinned. Operating
rule: any reminder about a pending decision carries one of the two resume payloads,
scoped to where the request originated — a plain-text-only reminder for that case is a
mistake, not a valid shortcut.

`condition_resume.py arm/check/rearm/resolve/list` wraps this so "wait for a condition,
then run an action" needs no hand-composed reminder JSON and freehand self-rearm prompt
per use. `arm` writes state to `~/.pa/condition-resume/<id>.json` (condition, action,
chat/thread, attempt count, max attempts) and mints a reminder whose prompt is always
the short, fixed `condition_resume.py check --id <id>` — caller text lives in the state
file, rendered by `check`, so the reminder payload never grows with caller input and can
never itself trip the 500-char/single-line `topic_resume` validator. `check` prints what
to do next (perform the action then `resolve --outcome met`, or `rearm`, or once
attempts are exhausted `resolve --outcome exhausted`) without evaluating anything itself
— evaluation needs tools/judgment the reminder-resume drain doesn't have.

Pick `watch_job` when the condition is one of its five read-only file/process checks and
a plain notification is enough — cheaper (one 60s deterministic tick, no LLM turn per
check) and its completion action is fixed by design (widening `watch_job`'s unattended,
LLM-armable completion action to an arbitrary prompt would reopen the prompt-injection
surface the AI-170 spec deliberately closed). Pick `condition_resume.py` when the
condition needs interpretation or the completion action must itself act, not just report.

## Blackboard & locking

`pa/src/blackboard.ts` manages `~/.pa/blackboard.json` — PID + heartbeat-timestamp pairs per shared resource. Concurrent skill executions acquire/release locks via `proper-lockfile` on the file.

Stale locks (heartbeat > 10 minutes old) are flagged by `pa health` and clearable via `pa purge-locks`; each worker process refreshes its heartbeat while running.

Lock rows are `(resource, agent, pid, heartbeat, contextId?)`. A holder running longer than `PA_HEARTBEAT_STALE_MS` must renew via `startLockRenewal()` and handle its `onLost` callback — a bare `setInterval(updateHeartbeat)` discards the `false` meaning "your row was purged": silent double-occupancy. `startLockRenewal` (the only heartbeat mechanism since 2026-08-23) accepts an optional `client` for dependency-injected callers. `releaseLock(resource, agent, contextId?, { pid })` scopes the delete: without `contextId` and `pid` it removes every row for the `(resource, agent)` pair, so a stale holder's cleanup can delete a live same-named holder's lock. Two resources: `git-workflow` (the private tree; declared via `exclusive_resource` by the git-workflow skills and taken directly by `code-fixer.ts`/`self-improver.ts`) and `git-public-workflow` (the derived `pa-public/` tree, taken by `pa public-sync`). Renewal is tri-state (AI-179, 2026-09-03): `renewHeartbeat()` returns `'updated'`/`'row-absent'`/`'write-failed'` — a failed write retries on the `PA_HEARTBEAT_WRITE_RETRY_MS` ladder (default 1 s/5 s/15 s), and a give-up is verified against the row (`peekLockRow`) before `onLost` fires, so only a verified row-absence counts as 'purged'.

## Conversation archive + DLQ

- **Archive**: `~/.pa/conversation-history.jsonl` — append-only log of every bot turn (one JSON object per line). Read nightly by memory-consolidation for KB synthesis.
- **Per-topic state**: `~/.pa/telegram-bot-topic-{chatId}_{threadId}.json` — rolling 20-turn window for the bot's context window.
- **DLQ**: `~/.pa/telegram-dlq.jsonl` — bot replies that failed to send are appended here. On bot startup, the DLQ is sequentially retried via `dlq.ts`.

## Ref-IDs

Every system-generated message carries a ref-ID — `_Ref: s-XXXXXXXXXXXX_` (12 hex chars,
stamped by pa's `sendToTelegram`, the bot's `appendRefIdAndLog`, Python
`telegram_notify.py`) — logged to `app.log.jsonl` with a `refId` field, so all
system activity is queryable via `pa ref <id>`. Feedback rules carry `r-` + 12 hex
(`pa/src/lib/feedback-rules.ts`). Alert bodies embed the ref-ID so the user can drill into
the originating message.

## Turn-trace sidecar (2026-08-24)

Every `executeWorker` run (`pa/src/worker-exec.ts`) writes one JSONL line to
`~/.pa/turn-traces.jsonl` — what the worker actually did, beyond the 300-char preview
the analyzer sees. Built by `pa/src/lib/turn-trace.ts`; never blocks or fails a
dispatch (`appendTurnTrace` never throws).

Schema v1 (`TurnTraceV1` in `pa/src/lib/turn-trace.ts`): run identity (`run_id` uuid,
`ts_start`/`ts_end`/`duration_ms`), `origin` (`bot|skill|self-improver|other`),
`chat_id`/`thread_id`/`update_id` (bot) or `skill`, `worker`/`model`/`session_id`,
`exit_code`/`outcome` (`ok|error|timeout|killed|failover`), `parsed` (dialect
recognized), capped arrays `tool_calls[]`/`commands[]`/`files[]`/`errors[]`, `retries`
(0 in v1 — the future retry-loop seam), `tokens`, `bytes_out`, `truncated`. Two
dialects parse: agy/agyc `step_update` stream events and claude-family
`tool_use`/`tool_result` blocks; codex matches neither (`parsed:false`) until it comes
off cooldown.

Join keys: `run_id` resolves any run directly (`pa ref <uuid>`). A bot-origin turn's archive
row does **not** carry `run_id` — `pa ref <refId>` resolves the trace via
`(thread_id, update_id)`, both written on the archive row by `main.ts`, then prints the
`--- trace (turn-traces.jsonl) ---` block after the resolved text.

Rotated `-turn-traces.jsonl` shards are derived debugging data (rebuildable from nothing);
the `archive-prune` job prunes them at 90 days (`PRUNABLE_ARCHIVE_SUFFIXES`,
`pa/src/lib/archive-files.ts`). The `recall-index` job refreshes `~/.pa/recall.sqlite`
from the live file every 10 minutes — traces searchable with no manual step.

## Recall (`pa recall`, 2026-08-24)

Full-text search over seven sources — answers "did we discuss this" without grepping raw
JSONL:

| Source | What's indexed | Doc unit |
|---|---|---|
| `conversation` | `~/.pa/conversation-history.jsonl` + rotated shards | one bot turn |
| `trace` | `~/.pa/turn-traces.jsonl` + rotated shards | one worker run |
| `brain` | `~/.pa/topic-brains/*/BRAIN.md` + `INDEX.md` | one `## ` section |
| `kb` | the Ecosystem KB directory (`dirname(PA_KB_SOURCES_PATH)`) | one `## ` section per `.md` file |
| `review` | `~/.pa/review-digest-pending.jsonl` | one pending conflict |
| `decisions` | `~/.pa/decisions.sqlite` (rowid watermark) | one judgment-call row |
| `profile` | `PA_PROFILE_PATH` else `~/.pa/data/profile.json` — interests, top-level preferences, live (non-superseded) history rows | one interest / preference key / history row (2026-09-16, WP-8/OD-3) |

### Decision traces (2026-08-27)

`~/.pa/decisions.sqlite` records judgment calls with outcome (👍/👎 ⇒ approved/rejected; next turn ⇒ "replied"). Twins `decisions.ts` + `decisions.py` enforce immutable-after-insert + redact-before-insert. Writers: daily-mail-brief, travel-butler, `rm:` buttons.

Engine: `pa/src/lib/recall-store.ts` — in-process TS over `better-sqlite3` FTS5, WAL, incremental per-source cursors. Query: AND-first (`bm25`), OR-rescue under the limit, `total` never inflated; `--limit` ≤50; filters `--thread/--source/--role/--since/--until`.

Surfaces: `pa recall` CLI (`pa/src/commands/recall.ts`), the `pa_recall` MCP tool, the
non-destructive `recall-index` job, and a standing pointer line in the bot's system
prompt (`projects/telegram-bot/src/context.ts`).

## Feedback rules (AI-165, 2026-08-27)

Store: `~/.pa/feedback-rules.yaml` (add-only, supersede-by-key). Nightly triage compiles from corrections + ≥2 👎 decisions. Deterministic → active; semantic → pending until `pa rules accept`. Injection: fresh yaml per `buildPrompt` (12-rule/1500-char cap). Per-reply critic: `rules-critic.ts` at the `main.ts` send seam (O(regex), never blocks/throws); violations → `rules-violations.jsonl`; weekly digest via `pa rules weekly`. Store/critic/analyzer are code-fixer-protected.

## SLO report (`pa slo report`, 2026-08-27)

Error-budget reports per service from `~/.pa/app.log.jsonl`; config-driven (`~/.pa/slo.yaml`; examples in `pa/examples/slo.yaml.example`). **Per-skill outcome SLOs**: trailing 30d, `acted_on = approved + replied`; zero rows → `no decision data`. **`unknown`**: absent source files report `status: unknown` via `missingData`, never silent `OK`. Sources: `fetch_headers.py` writes misses; `verify_alert_sent.py` appends ok/missed receipts per run. Code: `pa/src/commands/slo.ts`, `pa/src/lib/slo.ts`.

## Topic task queue + button grammar (`pa topic-*`, 2026-09-02)

The topic-task handover substrate — the durable task queue, the append-only event log,
the one inline-button grammar (`callback-grammar.ts`), the `[PA_KEYBOARD]:` envelope,
and the dedicated task executor lane (`pa topic-task add` accepts `--worker`/`--model`
pins; the record's `model` field composes into dispatch args per WP-7):
**`docs/topic-task-substrate.md` (read before touching any of it)**.

## Voice inbox app (`projects/voice-inbox`, 2026-09-05)

A foreground PWA + localhost API that turns spoken/typed requests into tasks in a
tenant-scoped SQLite ledger (`~/.pa/voice-inbox/ledger.sqlite`; every query takes
`tenant_id`; a code-level transition table is the only state gate). Chain:
PWA → HTTPS API → ledger; ledger ↔ `route-queue.jsonl` ↔ bot drain → synthetic route
turn (`__synthetic: 'route'`) → worker fleet. The five Python worker scripts
(route/telemetry/input/complete/transcribe) write the same ledger directly, never
create schema. Voice recordings live under files/<task_id>/, transcribed by the topic
worker (Groq-first) — the API server carries no transcription secrets; `route_task.py`
also writes one decisions.sqlite row per routing decision. Operator input arrives as
one of six typed input-request widgets; answers are stored server-side as a file and
delivered to the worker as a path, so secrets never travel through chat. Config:
`docs/voice-inbox-config.md`; brain: `projects/voice-inbox/CLAUDE.md`.
Schema v3 adds `conversation_id` (self-rooted by default, the grouping key behind the
conversation endpoints) and `worker_resource`; cancel writes a `kind:"cancel"`
route-queue entry and the bot kills exactly that resource.

Remote access rides the edge relay (`projects/voice-inbox/relay/`): a Workers worker +
SQLite-backed Durable Object mailbox + R2 bucket on the user's own Cloudflare free
account, fronting the localhost app with a stable workers.dev URL. The home machine
makes outbound connections only — its poller long-polls, executes claimed requests
against the localhost API, returns responses. Free-tier caps set the shape: long-poll
waits ≤25 s, a parked request dies at 55 s, bodies over 768 KiB stream through R2. The
relay is generic: any localhost HTTP service can front through it. Detail, auth model,
gates: `projects/voice-inbox/relay/README.md`.

## Auth broker (2026-09-10)

Generalizes the Google-reauth-over-Telegram pattern into one phone-approval path any
provider can use: `pa auth request|wait|answer|learn` mints and resolves one of five
shapes (S1 URL+approve, S2 URL+code, S3/S4 secret entry, S5 confirm/choice) against the
voice-inbox ledger's typed-widget system. `GET /api/v1/auth/callback` on the voice-inbox
server is the un-authenticated, single-use landing page an OAuth code-flow provider
redirects the phone back to; it runs the provider's configured token exchange and resumes
the waiting worker, closing the AI-221 gap where an answered widget never woke its
worker. Provider config (`projects/voice-inbox/src/auth-providers.ts`) is a registry,
not a dispatcher — Google is the only Phase-A row and reuses the existing reauth script
pair. The broker's short-lived state (pending exchanges, the standing per-tenant
conversation, delivered-once bookkeeping) lives under `~/.pa/auth/`, independent of the
ledger; the declared `auth-answer-reap` job reaps answered secret values on two
retention windows plus the broker's own rows. A Telegram fallback (`auth:` button,
`/secret <id> <value>`) covers operators without the PWA open — detail in `docs/auth-broker.md`.

## Logging

Structured JSON logs at `~/.pa/app.log.jsonl`. Format:

```json
{"timestamp":"2026-05-21T18:30:00+05:30","level":"info","module":"workers","message":"failover","ctx":{"from":"zclaude","to":"agy","reason":"rate-limit"}}
```

Use `pa logs <skill>` to read recent runs.

## Observability surfaces

- **`pa costs`** — usage/cost rollups by worker, model, skill. Tokens are factual; dollars are read-time estimates from built-in list prices + `model_pricing` overrides (`docs/CONFIGURATION.md` § ModelPricing); unpriced keys show `-` (table) or `null` (JSON). Flags: `--day|--week|--month`, `--skill`, `--json`.
- **`pa slo report --json`** — machine-readable error-budget reports; both digest scripts render them generically by service name.
- **Daily digest skill** — deterministic 24h activity rollup (runs, tokens, est. cost, failover, alerts, DLQ, self-improver actions, SLO) with explicit unavailable lines; Python → stdout → `telegram_output` relay, date-scoped dedup. Script: `pa/scripts/daily_digest.py`; template: `examples/skills/daily-digest/skill.md`.
- **Weekly digest skill** — same pattern weekly: `pa/scripts/weekly_digest.py`.

## Conventions

- **Timestamps**: IST by default (UTC+5:30); override via `PA_TZ_OFFSET_MINUTES`. Log messages are ISO-8601 with the configured offset.
- **Atomic file writes**: write to `<path>.tmp` then rename, avoiding partial writes if interrupted.
- **Git snapshots before destructive updates**: skills modifying tracked files `git commit -am "pre-update snapshot"` before editing and `git commit -am "<skill> auto-refresh"` after.
- **Marker-based content insertion**: skills like `update-brain` use `<!-- AUTO:* -->` markers for auto-managed sections within hand-edited files, validate the markers exist post-update, and refuse to write if any disappeared.
- **Line-count floor**: stateful skills that rewrite files refuse the write when new content is < 80% of the old size — a guard against accidental wipes.

Multi-session coordination (claims, @build, clobber detection, destructive-git ban, test isolation): docs/multi-session-protocol.md. The `@build` reservation is taken by the npm scripts themselves (`pa/scripts/build.mjs`, `pa/scripts/run-tests.mjs`, the bot's copies — all via `pa/src/lib/build-lock.ts`); a `PreToolUse` hook (`pa/scripts/hooks/reservation-guard.py`) warns on edits under a foreign reservation.

See also — the full `docs/` index (`docs/CONVENTIONS.md` § "Brain-file organization" has the naming/size rules behind this split):

Evergreen guides (read when learning or setting up a subsystem):
- `docs/QUICKSTART.md` — first-run walkthrough
- `docs/DEPLOYMENT.md` — deploying your own pa-framework fork
- `docs/CONFIGURATION.md` — config file/env var reference
- `docs/CONVENTIONS.md` — repo hygiene, naming, brain-file organization
- `docs/SKILLS_GUIDE.md` — authoring skills
- `docs/WORKERS_GUIDE.md` — the worker contract, adding a worker
- `docs/BOT_GUIDE.md` — the Telegram bot end to end
- `docs/TROUBLESHOOTING.md` — `pa health` diagnosis, common failure modes

Operational-detail files (read on demand, when touching that specific area):
- `docs/repo-topology.md` — git-workflow skill locking, the public/private mirror split, PII-guard internals
- `docs/maintenance-jobs.md` — the full declared-maintenance-job catalog (pa-host + bot-host)
- `docs/bot-reliability-internals.md` — DLQ, delivery-dedup guarantees, `/stop` cancellation, AI-096 deviations
- `docs/topic-task-substrate.md` — topic task queue, event log, button grammar, task executor lane

Auto-loading (native Claude Code directory-scoped `CLAUDE.md`, not manually read):
- `projects/telegram-bot/CLAUDE.md`
