# Dependency Graph — System Connections

This reference catalog captures how pa's components connect and interact. For MAJOR rules embedded in these connections, see root CLAUDE.md's Connections section.

## Core Data Flows

### CLI → Workers
`pa run` (`workers.ts`) dispatches in priority order: agy(1) → codex(2) → zclaude(3) → claude(4) → devin(5). Agyc(9, `manual_only: true`) is excluded from automatic failover — picked only via bot `/agent agyc`, skill `worker: agyc`, or `worker_pin`.

agy and agyc are the same agy.exe binary (same stream-json dialect); parsing is gated on `isAgyStreamWorker()` (`pa/src/worker-exec.ts`) — a future agy-shim worker must be added there or its replies are silently discarded (the 2026-08-21 silent no-ops). Skills declaring `telegram_output` set `requireNonEmptyOutput`, so an exit-0-empty worker fails over instead of a fake success.

### CLI config → Coexistence engine
Any pa surface editing an existing CLI's user config (MCP registration, hook wiring — per-CLI surfaces: `docs/cli-onboarding.md` § D2) routes through `pa/src/lib/coexistence.ts`: snapshot → additive-only apply (`KeyCollisionError` on any existing key) → row in `~/.pa/coexistence-registry.json`. Consumers: `pa coexistence list|restore`, `pa doctor`'s `coexistence` block, `pa init --provision` (collisions → ask flow).

### Scheduler → Catchup
`pa catchup --loop` holds `catchup:loop` and drives three lanes (`default`, `reminders`, `maintenance`) off one timer, each with its own in-flight flag — a slow lane must never block another (a stuck 20-min skill once froze the voice fallback). Task Scheduler keeps the loop alive via a PID-liveness launcher, not fresh nodes each minute. Launcher, lane progress and the legacy reminders task: `docs/catchup-watchdog.md`.

That cadence amplifies retries — dedupe by occurrence, not raw failure counts, when diagnosing logs.

**Failure backoff (AI-098)**: `partitionOverdueByFailureBackoff` (scheduler.ts) paces retries per consecutive failure 0/30m/2h/8h, then parks at 5 until the next natural cron occurrence + a deduped pa-alerts page; a fresh occurrence always grants one attempt. `pa run <skill>` bypasses backoff; a success resets the counter.

**Multi-instance task naming**: `scheduledTaskName()` suffixes the Task Scheduler/crontab entry name only when RESOLVED `PA_HOME` differs from the default `~/.pa` — never regress to a fixed name; a disposable test clone once overwrote this deployment's real scheduled tasks.

### Catchup → Maintenance Runner → Declared Jobs (AI-100)
The loop's `maintenance` lane, or one-shot `pa catchup`, drives all declared jobs (36: 27 `pa`-host via `registry.ts`, 9 bot-host) against `~/.pa/maintenance-state.json` — built after an undeclared timer deleted 248 transcripts (CI-enforced: `timer-inventory.test.ts`); catalog: `docs/maintenance-jobs.md`. Every `pa`-host job resolves repo root via `repoRootFromModule(__filename)`, never `process.cwd()` (Task Scheduler cwd is `C:\Windows\System32`). Failed runs back off 0/30m/2h/8h/24h; `pa maintenance run <job>` bypasses.

### update-brain Nightly Sweep
The `update-brain` skill git-commits ANY pending working-tree/staged changes as `pre-update snapshot` / `commit pending brain-file changes` before refreshing (swept a 48-file staged change 2026-07-27). Never promise "staged, uncommitted until you approve" across 21:30 IST.

### Bot → Task Scheduler
PA-Telegram-Bot task ensures the bot is always running (1m repeat).

### Skills → Triggers
LLM output can trigger other skills via PA_META run_skill action. PA_META `watch_job` (AI-170) writes `~/.pa/watch-jobs.json`; the 60s `watch-jobs-runner` job reports back into the registering topic. Also `pa watch add`.

### Reminders → resume_action → Topic turn or voice-inbox conversation turn
`add_reminder.py --resume-action-json '{"type":"topic_resume","prompt":...}'` mints a reminder whose `reminder-resume` drain runs a fresh system turn in the topic at fire time (AI-185) — "wait until T, run this prompt", distinct from `watch_job`'s fixed-action polling. `condition_resume.py` (`arm`/`check`/`rearm`/`resolve`, 2026-09-12) wraps it into a reusable capability; the `voice_inbox_resume` sibling resumes into a voice-inbox conversation_id, not a Telegram topic. Details: `docs/ARCHITECTURE.md` § "Condition-gated resume".

### Chains → Skills
`pa chain run <name>` executes sequential chains from `~/.pa/chains/*.yaml` (steps: skill, args, retry, on_failure; report: telegram/stdout). Each step spawns `pa run <skill>` as a subprocess, inheriting git-workflow lock discipline. Validation is strict — unknown/invalid/missing fields reject on load.

## External Integrations

### MCP Server → CLI Exports
`pa mcp serve` runs a stdio MCP server exposing read-only tools (`pa_ref_lookup`, `pa_claims`, `pa_maintenance_status`, `pa_costs`, `pa_slo_report`, `pa_recall`) plus agent-bus tools (`bus_send`, `bus_inbox`, `bus_wait`, `bus_list`, `bus_whoami`), wrapping pa exports. Manifest: `~/.pa/mcp.json`; registration is manual per-CLI (claude/codex/agy) — no auto-sync in v1. Register only via `pa mcp serve`, never `server.mjs` directly — it imports `./tools.js`, built only under `dist/`. See `docs/WORKERS_GUIDE.md` § "MCP integration".

### Worker run → Trace sidecar → `pa ref` / `recall-index`
`executeWorker` writes one JSONL line per run to `~/.pa/turn-traces.jsonl` (`pa/src/lib/turn-trace.ts`) — fire-and-forget, never fails a dispatch. `pa ref <refId>` resolves a bot turn's trace via the archive row's `(thread_id, update_id)`; `pa ref <run_id-uuid>` resolves directly. Rotated shards prune at 90 days. Details: `docs/ARCHITECTURE.md` § "Turn-trace sidecar".

### Recall index → `recall.sqlite` → `pa recall` / `pa_recall` / bot prompt hint
`recall-index` (pa host, 10 min) incrementally indexes conversation history, worker traces, topic brains, the Ecosystem KB and pending review-digest conflicts into `~/.pa/recall.sqlite` (FTS5, `better-sqlite3`). Consumed by `pa recall`, `pa_recall`, and a standing prompt bullet + per-thread pointer in the bot's system prompt. Details: `docs/ARCHITECTURE.md` § "Recall".

### Secrets → Workers
secrets.env is injected as env vars to all worker processes.

### Telegram → Logic → Dispatcher
Telegram bot filters worker outputs via `logic.ts` before sending.

### Telegram API Routing (DIRECT-FIRST)
ALL Telegram API calls (bot getUpdates + sends, pa CLI sender, setup-topics, Python notifier) go through `telegramFetch()` (`pa/src/lib/telegram-proxy.ts`). Direct first, falling back to a health-checked SOCKS5 pool (`~/.pa/telegram-proxies.json`, auto-refreshed from `TELEGRAM_PROXY_SOURCE_URL`) only when direct is blocked (dormant fallback; India's ban lifted 2026-06-23). A circuit breaker re-probes direct every 60s and reverts when the block lifts.

Guardrails (do NOT regress): TLS validation forced on (refuses `NODE_TLS_REJECT_UNAUTHORIZED=0`); SSRF filter on auto-fetched hosts; connect-stage-only reroute/failover; secrets kept out of logs/pool-file. Honors `PA_NOTIFY_DISABLED` (tests never hit real proxies).

### Lock → Process
Bot instances check `telegram-bot.lock` before starting, to avoid a duplicate PID.

### Projects → Shared Auth
Projects import the centralized `google_auth.py` from ~/.pa/.

### Auth Failure → Telegram Reauth
`start_google_telegram_reauth.py` mints the OAuth consent URL and delivers it as a plain-text Telegram message (Markdown mangles the URL) valid 12 hours.

Every Google-auth consumer routes through one choke point on failure, `pa/scripts/google_reauth_kick.py`: a marker (`~/.pa/google-auth-blocked.json`), a 6h rate-limit, then delegates to `start_google_telegram_reauth.py --reuse-pending` (resends the pending session). `/reauth [skill]` spawns the same script; `finish_google_telegram_reauth.py` clears the marker; `human-gated-blocker-watch` escalates at 3 and 7 days.

### Alert substrate rules (2026-08-23)
Three rules the notify/census pipeline (`notify.ts`, `alert-census.ts`) depends on:

- **One failure = one alert family.** A dedup key must identify the condition, not one occurrence — never a PID/counter/topic id. `censusFamilyKey()` normalizes older subjects (bg-leak PIDs, topic ids) into one family.
- **Dedup escalates on an unchanged body**: 1h → 2h → 4h → 8h → 16h → 24h (`ESCALATION_CAP_MS`), reset on any body change. `timeout-unknown-outcome` also writes a short 10-min dedup so a send racing Telegram's rate limit doesn't re-fire every tick.
- **`staleness-check` is THE dead-man's switch** for scheduled skills — `skill-cadence-audit` (retired) was a strictly-later duplicate. Skips parked skills, widens for `cost_tier: off_peak` (peak window: `cost_tier.peak_window_utc`), dedups on the stale SKILL SET.

## Data Pipelines

### Conversation → Archive → Memory
Every bot turn is appended to `conversation-history.jsonl`; `memory-consolidation` (replaced `ecosystem-kb` 2026-08-18, same 21:00 IST slot) reads it nightly — add-only fact extraction with temporal metadata, supersede-by-key, conflicts surfaced to the weekly digest (never auto-applied). (private; public: `topic-brain-distill` + `update-brain`.)

### KB → Git Safety Net
memory-consolidation (private) commits a pre-update snapshot before modifying any KB file.

### Consolidation → Review Digest → Weekly Ops Digest
Conflicts flow into `~/.pa/review-digest-pending.jsonl` (added/superseded auto-applied; contradictions wait for manual resolution). Weekly-ops-digest surfaces unresolved conflicts; accepted ones apply on the next consolidation run, rejected ones skip.

**`review-conflict-buttons`** (pa-host job, 24h, 2026-08-24) also reads that file: one `notifyUser` per unresolved entry, `mc:<id>:a|r|x` keyboard, `dedupKey: review-conflict-<id>` (posts once). A press spawns `pa/scripts/review_digest_action.py --conflict-id <id> --action accept|reject|ignore`, flipping `resolved`/`resolution`/`resolved_at` atomically — button and manual paths write the same file.

### Buttons → Callbacks → Synthetic messages
Eleven callback prefixes (grammar + gate table in `projects/telegram-bot/CLAUDE.md`) parse through one function, `parseCallbackData` (`callbacks.ts`); a press becomes a synthetic `TelegramUpdate` injected into the next poll batch, never handed to `processUpdate` directly, so button and typed behavior can never diverge.

### Decision traces (2026-08-27)
**Writers → decisions.sqlite → pa recall --source decisions:** daily-mail-brief (deterministic marker block), travel-butler (Python twin, `--jsonl`), and `rm:` buttons (TS helper) record judgment calls to `~/.pa/decisions.sqlite`, redacted before insert, served as precedent. **Outcomes:** 👍⇒approved, 👎⇒rejected, next in-thread user turn⇒weak "replied"; strong overwrites weak. Details: `docs/ARCHITECTURE.md` § Decision traces.

### SLO data flow (2026-08-27, AI-168)
**Skill→slo report:** fetch_headers→`~/.pa/daily-mail-brief/latest.json`. **decisions.sqlite→decisionStatsBySkill→slo/improvements/engagement-audit:** trailing-30d stats. **google_reauth_kick→reauth-kicks.jsonl→weekly digest.**

### Feedback rules (AI-165, 2026-08-27)
**conversation-history + decisions.sqlite reactions → feedback-analyzer → feedback-rules.yaml:** nightly compiles ≥2 👎 via `compileReactionCandidates` + LLM triage → `addRule` (deterministic→active, semantic→pending). **feedback-rules.yaml → buildPrompt + main.ts critic → rules-violations.jsonl → weekly digest:** `activeRulesFor` injects per prompt; `runRulesCritic` logs violations; `pa rules weekly` grades them.

### Archive → Analyzer → Drafts → Autonomous Apply
`analyzer.ts`/`failure-analyzer.ts`/`feedback-analyzer.ts` produce `DraftProposal` objects (`drafts.ts`). **Read `docs/self-improver-pipeline.md` before touching this chain** — full gates, budgets, audit trail.

**Alert census as a third input (2026-08-23):** the nightly `main()` builds a 7-day `AlertCensus` (`pa/src/lib/alert-census.ts`) in-process — fresh, so the loop never waits on its schedule. Each family routes pre-LLM: `deterministic-defect` with a healthy-now owner → code-fix proposal; `human-gated` → never a code draft; `repeat-unchanged` → "alert hygiene" line. The report always prints the census headline, even at zero proposals.

Only `isProtected()` (`PROTECTED_SKILLS`, the git-workflow family — the loop must never rewrite skills gating its own commits) and the validation floor (a failing fix stays `pending`, never deploys broken) gate a proposal; pushes are PRIVATE-origin-only, each fix one commit, `git revert`-rolled-back on regression. Terminal decisions log to `~/.pa/self-improver-audit.jsonl` (`pa improvements [--since N]` recomputes before/after eval). Full floors (F1–F6), thrash control and audit detail: `docs/self-improver-pipeline.md`.

**Consolidation audit trail** (2026-08-18): `~/.pa/consolidation-audit.jsonl` records all memory-consolidation decisions (added/superseded/conflict/skipped) alongside the self-improver audit trail.

### Learn → Profile
Two paths: (1) the manual `learn` skill invokes `pa/src/learn_agent.py` on `~/.pa/data/profile.json` (repo-external, `PA_PROFILE_PATH` override); (2) `memory-consolidation` (key-based, autonomous) extracts facts to a staging file a post-processor applies with `valid_from`/`valid_until`/`key`/`superseded_by`. NOT the `pa learn` CLI (unrelated). `learn_agent.py` archives evicted `history[]` to `profile-history-archive.jsonl` before FIFO-trimming. Oracle skill does newsletter analysis + daily briefing only.

### Rate Limits → Workers
`pa/src/rate-limits.ts` tracks per-worker rate-limit state (bot consumes it via pa/dist re-exports; no bot-side copy).

### Bot turn → Model router (2026-09-18; surfaces live 2026-09-20)
`applyRoutingPolicy`/`resolveTurnRouting` → `routeTurn` (`lib/model-router`) ← availability TTL cache (rate-limits); one ask: tier+score+placement+steer_wait+probability chain; chain → `runWithFailover` `candidateOrder` (surface-gated); routing decision → `PA_ROUTING_*` env → ledger v16 `router_*` columns → PWA "How this was answered"; shadow JSONL → `model-router-cooldown-normalize`. `deprecate_pins` default-ON outranks pins; knobs: `docs/model-router.md`.

### Topic Names
`topic-names.ts` loads ~/.pa/telegram-topic-names.json at startup.

## Git and Publishing

### Private Repo → Public Mirror
`pa public-sync` extracts private `HEAD` into `pa-public/`'s working tree (never the private tree); `git-public.ps1`/`git-public.cmd` are thin aliases into that same directory, letting `push-public` stage/commit/push substrate changes to `pa-framework` without exposing private brain files.

### Public CI
`.github/workflows/ci.yml` tracked in BOTH repos (edits = private commit + git-public sync). Matrix: ubuntu + windows + macos, Node 22.

**Build step order is load-bearing — never split into parallel jobs**: the bot imports pa's compiled `pa/dist` + resolves pa's deps from `pa/node_modules` at runtime, so pa must install+build first. Real-process timing tests need ≥1500ms child lifetimes.

Also runs the Python test suite (`pa/scripts/tests/test_*.py`) across all 3 platforms — zero CI coverage before, so a Windows-only bug once shipped silently. `verify_pii_guard_agy_e2e.py` excluded (needs a real agy binary, manual only). **`projects/daily-mail-brief/scripts/tests/` is NOT covered by CI** (the discover filter names only `pa/scripts/tests`) — a regression there ships silently between gates.

**`main` is a hard-gated branch on `pa-framework`**: `required_status_checks` (all 3 CI legs + PII scan) + `enforce_admins:true` — a direct `git push origin main` is REJECTED even for the repo owner; every change goes through a branch + PR. Private repo's default branch also renamed `master`→`main` to match (no branch protection there — private + free plan).
