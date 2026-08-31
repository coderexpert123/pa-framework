# Dependency Graph — System Connections

This reference catalog captures how components in the pa system connect and interact. For MAJOR rules embedded in these connections, see the Connections section in root CLAUDE.md.

## Core Data Flows

### CLI → Workers
`pa run` uses `workers.ts` to dispatch to workers in priority order:
1. agy (priority 1)
2. codex (priority 2)
3. zclaude (priority 3)
4. claude (priority 4)
5. agyc (priority 9, `manual_only: true` — excluded from automatic failover; runs only when explicitly picked via bot `/agent agyc`, skill `worker: agyc`, or `worker_pin`; added 2026-08-21)

Legacy gemini CLI worker sunset 2026-08-08 (AI-131).

agy and agyc are the same agy.exe binary (same stream-json dialect). Parsing is gated on `isAgyStreamWorker()` in `pa/src/worker-exec.ts` — any future agy-shim worker must be added there, or its replies are silently discarded (exit 0, empty output — the 2026-08-21 "silent no-op" failures). Skills declaring `telegram_output` set `requireNonEmptyOutput`, so an exit-0-empty worker fails over instead of a fake success.

### Scheduler → Catchup
Windows Task Scheduler runs `pa catchup` every **1 minute** (PA-Catchup + PA-Catchup-Reminders, both PT1M).

That cadence amplifies retries — dedupe by occurrence before diagnosing raw failure counts in `~/.pa/logs`.

**Failure backoff (AI-098)**: `partitionOverdueByFailureBackoff` (scheduler.ts) paces retries per consecutive failure 0/30m/2h/8h, then parks at 5 until the skill's next natural cron occurrence + a deduped pa-alerts page. A fresh cron occurrence always grants one attempt. `pa run <skill>` bypasses backoff; a success resets the counter.

**Multi-instance task naming**: `scheduledTaskName()` suffixes the Task Scheduler/crontab entry name only when the RESOLVED `PA_HOME` path differs from the default `~/.pa` — do not regress to a fixed name; a disposable test clone once silently overwrote this deployment's real scheduled tasks.

### Catchup → Maintenance Runner → Declared Jobs (AI-100)
`pa catchup`'s maintenance phase (`runDueJobs`) drives all declared jobs (30 total: 20 `pa`-host via `registry.ts`, 10 bot-host via `maintenance-jobs.ts`) against `~/.pa/maintenance-state.json`. Built after an undeclared timer deleted 248 transcripts (CI-enforced: `timer-inventory.test.ts`). Catalog: `docs/maintenance-jobs.md`. Every `pa`-host job resolves repo root via `repoRootFromModule(__filename)` (never `process.cwd()` — Task Scheduler cwd is `C:\Windows\System32`). Failed runs record `lastAttemptAt` and back off 0/30m/2h/8h/24h; `pa maintenance run <job>` bypasses.

### update-brain Nightly Sweep
The `update-brain` skill git-commits ANY pending working-tree/staged changes as `pre-update snapshot` / `commit pending brain-file changes` before refreshing (swept a 48-file staged change mid-session 2026-07-27). Never promise "staged, uncommitted until you approve" across 21:30 IST — it commits locally only.

### Bot → Task Scheduler
PA-Telegram-Bot task ensures the bot is always running (1m repeat).

### Skills → Triggers
LLM output can trigger other skills via PA_META run_skill action. PA_META `watch_job` (AI-170) writes `~/.pa/watch-jobs.json`; the 60s `watch-jobs-runner` job reports back into the registering topic. Also `pa watch add`.

### Chains → Skills
`pa chain run <name>` executes sequential chains from `~/.pa/chains/*.yaml` (steps: skill, args, retry, on_failure; report: telegram/stdout). Each step spawns `pa run <skill>` as a subprocess, inheriting git-workflow lock discipline. Validation is strict: unknown/invalid/missing fields are rejected on load.

## External Integrations

### MCP Server → CLI Exports
`pa mcp serve` runs a stdio MCP server exposing read-only tools (`pa_ref_lookup`, `pa_claims`, `pa_maintenance_status`, `pa_costs`, `pa_slo_report`, `pa_recall`) that wrap existing pa exports. Manifest at `~/.pa/mcp.json`; registration is manual per-CLI (claude/codex/agy) — no auto-sync in v1. Server: `pa/mcp/server.mjs` + tools: `pa/mcp/tools.ts`. See `docs/WORKERS_GUIDE.md` § "MCP integration".

### Worker run → Trace sidecar → `pa ref` / `recall-index`
`executeWorker` writes one JSONL line per run to `~/.pa/turn-traces.jsonl` (`pa/src/lib/turn-trace.ts`) — fire-and-forget, never fails a dispatch. `pa ref <refId>` resolves a bot turn's trace via the archive row's `(thread_id, update_id)`; `pa ref <run_id-uuid>` resolves one directly. Rotated shards prune at 90 days. Details: `docs/ARCHITECTURE.md` § "Turn-trace sidecar".

### Recall index → `recall.sqlite` → `pa recall` / `pa_recall` / bot prompt hint
`recall-index` (pa host, 10 min) incrementally indexes conversation history, worker traces, topic brains, the Ecosystem KB and pending review-digest conflicts into `~/.pa/recall.sqlite` (FTS5 via `better-sqlite3`). Consumed by `pa recall`, `pa_recall`, and a standing prompt bullet + per-thread pointer in the bot's system prompt. Details: `docs/ARCHITECTURE.md` § "Recall".

### Secrets → Workers
secrets.env injected as environment variables to all worker processes.

### Telegram → Logic → Dispatcher
Telegram bot uses `logic.ts` to filter worker outputs before sending to user.

### Telegram API Routing (DIRECT-FIRST)
ALL Telegram API calls (bot getUpdates + sends, pa CLI sender, setup-topics, Python notifier) go through `telegramFetch()` in `pa/src/lib/telegram-proxy.ts`.

It tries **direct** first and falls back to a health-checked SOCKS5 pool (`~/.pa/telegram-proxies.json`, auto-refreshed from `TELEGRAM_PROXY_SOURCE_URL`) **only when direct is blocked** (India's ban lifted 2026-06-23; the proxy path is a dormant fallback). A circuit breaker re-probes direct every 60s and switches back when the block lifts; the pool refreshes only while direct is down.

Guardrails (do NOT regress):
- TLS validation forced on (refuses if `NODE_TLS_REJECT_UNAUTHORIZED=0`)
- SSRF filter on auto-fetched hosts
- Connect-stage-only reroute/failover
- Secrets kept out of logs/pool-file

Honors `PA_NOTIFY_DISABLED` (tests never hit real proxies).

### Lock → Process
Bot instances check `telegram-bot.lock` to avoid starting if another PID is active.

### Projects → Shared Auth
Projects import the centralized `google_auth.py` from ~/.pa/.

### Auth Failure → Telegram Reauth
`start_google_telegram_reauth.py` mints the OAuth consent URL and delivers it as a plain-text Telegram message (never Markdown — a Google URL's underscores/parentheses would be mangled), valid 12 hours. Before 2026-08-23 it only printed the URL to its own log and nobody ever saw it (AI-147).

Every Google-auth consumer routes through one choke point on failure, `pa/scripts/google_reauth_kick.py`: additive marker (`~/.pa/google-auth-blocked.json`), 6h rate-limit, delegates to `start_google_telegram_reauth.py --reuse-pending` (valid session resent, not duplicated). `/reauth [skill]` spawns the same start script; `finish_google_telegram_reauth.py` clears the marker; `human-gated-blocker-watch` escalates at 3/7 days.

### Alert substrate rules (2026-08-23)
Three rules the notify/census pipeline (`notify.ts`, `alert-census.ts`) depends on:

- **One failure = one alert family.** A dedup key must identify the condition, not one occurrence — never a PID/counter/topic id. `censusFamilyKey()` normalizes older subjects (bg-leak PIDs, topic ids) into one family.
- **Dedup escalates on an unchanged body**: 1h → 2h → 4h → 8h → 16h → 24h (`ESCALATION_CAP_MS`), reset on any body change. `timeout-unknown-outcome` also writes a short 10-min dedup so a send racing Telegram's rate limit doesn't re-fire every tick.
- **`staleness-check` is THE dead-man's switch** for scheduled skills — `skill-cadence-audit` (retired) was a strictly-later duplicate. Skips parked skills, widens for `cost_tier: off_peak` (peak window configurable: `cost_tier.peak_window_utc`), dedups on the stale SKILL SET.

## Data Pipelines

### Conversation → Archive → Memory
Every bot turn is appended to `conversation-history.jsonl`; the `memory-consolidation` skill (replaced `ecosystem-kb` 2026-08-18, same 21:00 IST slot) reads it nightly — add-only fact extraction with temporal metadata, supersede-by-key, conflicts surfaced to the weekly digest (never auto-applied). (private; public: `topic-brain-distill` + `update-brain`) Spec: `plans/2026-08-18-unified-memory-consolidation-SPEC.md`.

### KB → Git Safety Net
memory-consolidation (private) commits a pre-update snapshot before modifying any KB file.

### Consolidation → Review Digest → Weekly Ops Digest
Conflicts flow into `~/.pa/review-digest-pending.jsonl` (added/superseded auto-applied; contradictions wait for manual resolution). Weekly-ops-digest reads it and surfaces unresolved conflicts; accepted ones apply on the next consolidation run, rejected ones are skipped.

**`review-conflict-buttons` (pa-host job, 24h, 2026-08-24)** also reads that file: one `notifyUser` per unresolved entry with an `mc:<id>:a|r|x` keyboard, `dedupKey: review-conflict-<id>` so it posts once. A press spawns `pa/scripts/review_digest_action.py --conflict-id <id> --action accept|reject|ignore`, atomically flipping `resolved`/`resolution`/`resolved_at` — the button path and Weekly-ops-digest's manual path write the same file.

### Buttons → Callbacks → Synthetic messages
Eleven callback prefixes (grammar + gate table in `projects/telegram-bot/CLAUDE.md`) parse through one function, `parseCallbackData` (`callbacks.ts`); a press becomes a synthetic `TelegramUpdate` injected into the next poll batch (`main.ts`), never handed to `processUpdate` directly, so button and typed behavior can never diverge.

### Decision traces (2026-08-27)
**Writers → decisions.sqlite → pa recall --source decisions:** daily-mail-brief (deterministic inner-LLM marker block), travel-butler (Python twin via `--jsonl`), and `rm:` buttons (TS helper) record judgment calls to `~/.pa/decisions.sqlite`, redacted before insert. `pa recall --source decisions` serves them as precedent. **Outcomes:** 👍⇒approved, 👎⇒rejected, next in-thread user turn ⇒ weak "replied"; strong overwrites weak; AI-168 consumes. Details: `docs/ARCHITECTURE.md` § Decision traces.

### SLO data flow (2026-08-27, AI-168)
**Skill→slo report:** fetch_headers→`~/.pa/daily-mail-brief/latest.json`. **decisions.sqlite→decisionStatsBySkill→slo/improvements/engagement-audit:** trailing-30d per-skill stats. **google_reauth_kick→reauth-kicks.jsonl→weekly digest.**

### Feedback rules (AI-165, 2026-08-27)
**conversation-history + decisions.sqlite reactions → feedback-analyzer → feedback-rules.yaml:** nightly compile ≥2 👎 via `compileReactionCandidates` + LLM triage → `addRule` (deterministic→active, semantic→pending). **feedback-rules.yaml → buildPrompt + main.ts critic → rules-violations.jsonl → weekly digest:** `activeRulesFor` injects fresh per prompt; `runRulesCritic` logs violations; `pa rules weekly` grades semantic rules.

### Archive → Analyzer → Drafts → Autonomous Apply
`analyzer.ts`/`failure-analyzer.ts`/`feedback-analyzer.ts` produce `DraftProposal` objects (`drafts.ts`).

**Alert census as a third input (2026-08-23):** `self-improver.ts`'s nightly `main()` builds a 7-day `AlertCensus` (`pa/src/lib/alert-census.ts`) in-process — the same deterministic census the daily job writes to disk, fresh so the loop never waits on its schedule. Each family routes deterministically pre-LLM: `deterministic-defect` with a healthy-now owner → code-fix proposal (`censusProposals()`); `human-gated` → never a code draft; `repeat-unchanged` → "alert hygiene" line. The report always prints the census headline, even at zero proposals.

Fully autonomous since 2026-07-11 (`plans/2026-07-11-autonomous-self-improver-full-autonomy.md`): `validator.ts`'s `isCriticalChange`/`hasRealSideEffects` no longer block — `gateAndApprove` records them as risk flags (`critical-skill`, `declares-secrets`) on the applied change instead.

Only `isProtected()` (`PROTECTED_SKILLS` — widened 2026-08-17 to the whole git-workflow family: self-improver, commit, push, push-public, investigate-flagged, update-brain; the loop must never rewrite the skills that gate its own commits) and the validation floor (a fix/new-skill that fails validation stays `pending`, never deploys broken) still gate a proposal.

Every terminal decision (applied/rejected/rolled-back) is logged to `~/.pa/self-improver-audit.jsonl` (`pa/src/lib/improvement-audit.ts`); `pa improvements [--since N]` recomputes the before/after eval.

Thrash control: duplicate-pending skip, 3-day per-target cooldown, 14-day stale-draft sweep.

**Code fixes too** (`pa/src/code-fixer.ts`): cmd-target proposals route to a coding worker under floors F1–F6 (protected-diff inspection, test-integrity guard, same-run build+suite+bot-health verification with hard revert, clean-worktree precondition, per-run bounds — one attempt per target skill, disjoint files across a run's fixes, a wall-clock budget — PRIVATE-origin-only push); each fix is one commit, `git revert`-rolled-back on regression (a conflicted revert is audited `rollback-failed`).

**Consolidation audit trail** (2026-08-18): `~/.pa/consolidation-audit.jsonl` records all memory-consolidation decisions (added/superseded/conflict/skipped) alongside the self-improver audit trail. Spec: `plans/2026-08-18-unified-memory-consolidation-SPEC.md`.

### Learn → Profile
Profile learning has two paths:

1. Manual `learn` skill (text-based, unchanged) invokes `pa/src/learn_agent.py` directly to update `~/.pa/data/profile.json` (repo-external since 2026-07-27, AI-089 — resolution is `PA_PROFILE_PATH` env override, else `${PA_HOME:-~/.pa}/data/profile.json`)

2. Autonomous `memory-consolidation` skill (key-based, 2026-08-18; private — public: `topic-brain-distill`) extracts facts from conversation-history + profile-archive, writes candidates to staging file, post-processor applies to profile.json with `valid_from`/`valid_until`/`key`/`superseded_by` fields

NOT the `pa learn` CLI command, which runs an unrelated pipeline (see File Inventory in root CLAUDE.md).

`learn_agent.py` archives evicted `history[]` entries to `profile-history-archive.jsonl` before FIFO-trimming, and writes `profile.json` atomically (tmp+`os.replace`) — added after the old pure-slice trim had destroyed durable facts. Oracle skill now does newsletter analysis + daily briefing only (profile extraction delegated to memory-consolidation).

### Rate Limits → Workers
`pa/src/rate-limits.ts` tracks per-worker rate limit state (the bot consumes it via pa/dist re-exports; no bot-side copy).

### Topic Names
`topic-names.ts` loads ~/.pa/telegram-topic-names.json at startup.

## Git and Publishing

### Private Repo → Public Mirror
`pa public-sync` extracts private `HEAD` into `pa-public/`'s working tree (never the private tree itself); `git-public.ps1`/`git-public.cmd` are thin aliases into that same independent directory, letting `push-public` stage/commit/push substrate changes to `pa-framework` without exposing private brain files.

### Public CI
`.github/workflows/ci.yml` tracked in BOTH repos (edits = private commit + git-public sync). Matrix: ubuntu + windows + macos, Node 22.

**Build step order is load-bearing — never split into parallel jobs**: the bot imports pa's compiled `pa/dist` + resolves pa's deps from `pa/node_modules` at runtime, so pa must install+build first. Real-process timing tests need ≥1500ms child lifetimes.

Also runs the Python test suite (`pa/scripts/tests/test_*.py`) across all 3 platforms — zero CI coverage before, and a Windows-only bug shipped silently as a result. `verify_pii_guard_agy_e2e.py` excluded (needs a real agy binary, manual only).

**`main` is a hard-gated branch on `pa-framework`**: `required_status_checks` (all 3 CI legs + PII scan) + `enforce_admins:true` — a direct `git push origin main` is REJECTED even for the repo owner; every change goes through a branch + PR. Private repo's default branch also renamed `master`→`main` to match (no branch protection there — private + free plan).
