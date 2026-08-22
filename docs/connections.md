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

agy and agyc are the same agy.exe binary (same stream-json dialect). Parsing is gated on `isAgyStreamWorker()` in `pa/src/worker-exec.ts` — any future worker routed through the agy shim must be added there, or its replies are silently discarded (exit 0, empty output — the 2026-08-21 "silent no-op" commit failures). Skills declaring `telegram_output` set `requireNonEmptyOutput`, so a worker that exits 0 with empty output fails over instead of ending the cascade as a fake success.

### Scheduler → Catchup
Windows Task Scheduler runs `pa catchup` every **1 minute** (PA-Catchup + PA-Catchup-Reminders, both PT1M).

That cadence amplifies retries — dedupe by occurrence before diagnosing raw failure counts in `~/.pa/logs`.

**Failure backoff (AI-098)**: `partitionOverdueByFailureBackoff` (scheduler.ts) paces retries per consecutive failure 0/30m/2h/8h, then parks at 5 until the skill's next natural cron occurrence + a deduped pa-alerts page. A fresh cron occurrence always grants one attempt, so backoff never throttles a skill below its own schedule, it only kills the retry-storm class. `pa run <skill>` bypasses backoff; a successful run resets the counter.

**Multi-instance task naming**: `scheduledTaskName()` suffixes the Task Scheduler/crontab entry name only when the RESOLVED `PA_HOME` path differs from the default `~/.pa` (comparison by resolved path, never env-var presence) — do not regress to a fixed name; a disposable test clone once silently overwrote this deployment's real scheduled tasks. Full incident: memory file `project_bugs_found.md`.

### Catchup → Maintenance Runner → Declared Jobs (AI-100)
`pa catchup`'s maintenance phase (`runDueJobs`) drives all declared jobs:
- `pa/src/lib/maintenance/registry.ts` for `pa`-host jobs
- `projects/telegram-bot/src/maintenance-jobs.ts`'s `createBotMaintenanceJobs(deps)` for bot-host jobs (constructed per-process since bot jobs close over runtime state that doesn't exist until secrets load)

Jobs run against the ledger `~/.pa/maintenance-state.json`.

Built after an undeclared bot timer deleted 248 real Claude Code transcripts; enforced in CI by `pa/tests/timer-inventory.test.ts` (fails the build on a new undeclared timer). Full job catalog (all 11 `pa`-host jobs + all 6 bot-host jobs incl. `grounding-check`'s clobber-detection pattern list and the cold-start-seeding exceptions): `docs/maintenance-jobs.md`. Governing rule: `plans/2026-08-02-maintenance-framework.md`.

### update-brain Nightly Sweep
The `update-brain` skill git-commits ANY pending working-tree/staged changes as `pre-update snapshot` / `commit pending brain-file changes` commits before refreshing (verified 2026-07-27: it swept an interactive session's staged 48-file change into `7190cda` mid-session). Never promise the user "staged, uncommitted until you approve" for work left pending across 21:30 IST — it will be committed (locally only; it does not push).

### Bot → Task Scheduler
PA-Telegram-Bot task ensures the bot is always running (1m repeat).

### Skills → Triggers
LLM output can trigger other skills via PA_META run_skill action.

### Chains → Skills
`pa chain run <name>` executes sequential workflow chains defined in `~/.pa/chains/*.yaml` (steps: skill, args, retry, on_failure; report: telegram/stdout). Each step spawns `pa run <skill>` as a subprocess, inheriting git-workflow lock discipline automatically. Validation is strict: unknown fields, invalid values, and missing required fields are rejected on load.

## External Integrations

### MCP Server → CLI Exports
`pa mcp serve` runs a stdio MCP server exposing read-only tools (`pa_ref_lookup`, `pa_claims`, `pa_maintenance_status`, `pa_costs`, `pa_slo_report`) that wrap existing pa exports. The manifest lives at `~/.pa/mcp.json`; registration is manual per-CLI (claude/codex/agy) — no auto-sync in v1. Tools return structured text; no mutating operations. Server: `pa/mcp/server.mjs` + tools: `pa/mcp/tools.ts`. See `docs/WORKERS_GUIDE.md` § "MCP integration".

### Secrets → Workers
secrets.env injected as environment variables to all worker processes.

### Telegram → Logic → Dispatcher
Telegram bot uses `logic.ts` to filter worker outputs before sending to user.

### Telegram API Routing (DIRECT-FIRST)
ALL Telegram API calls (bot getUpdates + sends, pa CLI sender, setup-topics, Python notifier) go through `telegramFetch()` in `pa/src/lib/telegram-proxy.ts`.

It tries the **direct** connection first and falls back to a health-checked SOCKS5 pool (`~/.pa/telegram-proxies.json`, auto-refreshed from `TELEGRAM_PROXY_SOURCE_URL`; optional seed `TELEGRAM_PROXY_URLS`) **only when direct is blocked** (India's Telegram ban — lifted 2026-06-23; the proxy path is now a dormant fallback). A circuit breaker re-probes direct every 60s and auto-switches back when the block lifts; the pool is refreshed only while direct is down (zero proxy scans when direct works).

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
`projects/daily-mail-brief/scripts/preflight.py` launches `pa/scripts/start_google_telegram_reauth.py`, which sends the user to the bridge page at `projects/google-oauth-redirect/`; the bot's `/auth` path then calls `finish_google_telegram_reauth.py` and can relaunch the stored retry action.

## Data Pipelines

### Conversation → Archive → Memory
Every bot turn is appended to `conversation-history.jsonl`; the `memory-consolidation` skill (replaced `ecosystem-kb` 2026-08-18, same 21:00 IST slot) reads it nightly — add-only fact extraction with temporal metadata, supersede-by-key, conflicts surfaced to the weekly digest (never auto-applied). Spec: `plans/2026-08-18-unified-memory-consolidation-SPEC.md`.

### KB → Git Safety Net
memory-consolidation commits a pre-update snapshot before modifying any KB file.

### Consolidation → Review Digest → Weekly Ops Digest
Conflicts detected by memory-consolidation flow into `~/.pa/review-digest-pending.jsonl` (added/superseded auto-applied; contradictions wait for manual resolution). Weekly-ops-digest reads this file and surfaces unresolved conflicts for review. Accepted conflicts are applied on the next consolidation run; rejected conflicts are skipped.

### Archive → Analyzer → Drafts → Autonomous Apply
`analyzer.ts`/`failure-analyzer.ts`/`feedback-analyzer.ts` produce `DraftProposal` objects (`drafts.ts`).

Fully autonomous since 2026-07-11 (`plans/2026-07-11-autonomous-self-improver-full-autonomy.md`): `validator.ts`'s `isCriticalChange`/`hasRealSideEffects` no longer block — `gateAndApprove` records them as risk flags (`critical-skill`, `declares-secrets`) on the applied change instead.

Only `isProtected()` (`PROTECTED_SKILLS` — widened 2026-08-17 to the whole git-workflow family: self-improver, commit, push, push-public, commit-and-push, investigate-flagged, update-brain; the loop must never rewrite the skills that gate its own commits) and the validation floor (a fix/new-skill that fails validation stays `pending`, never deploys broken) still gate a proposal.

Every terminal decision (applied/rejected/rolled-back) is logged to `~/.pa/self-improver-audit.jsonl` (`pa/src/lib/improvement-audit.ts`); `pa improvements [--since N]` recomputes the before/after eval.

Thrash control: duplicate-pending skip, 3-day per-target cooldown, 14-day stale-draft sweep.

**Code fixes too** (`pa/src/code-fixer.ts`, `plans/2026-07-11-autonomous-code-fix-capability.md`): cmd-target proposals route to a coding worker under floors F1–F6 (protected-diff inspection, test-integrity guard, same-run build+suite+bot-health verification with hard revert, clean-worktree precondition, one fix/night, PRIVATE-origin-only push); each fix is one commit, rolled back via `git revert` on regression (a conflicted revert is audited as `rollback-failed`, bad fix stays live until handled).

**Consolidation audit trail** (2026-08-18): `~/.pa/consolidation-audit.jsonl` records all memory-consolidation decisions (added/superseded/conflict/skipped) alongside the self-improver audit trail. Spec: `plans/2026-08-18-unified-memory-consolidation-SPEC.md`.

### Learn → Profile
Profile learning has two paths:

1. Manual `learn` skill (text-based, unchanged) invokes `pa/src/learn_agent.py` directly to update `~/.pa/data/profile.json` (repo-external since 2026-07-27, AI-089 — resolution is `PA_PROFILE_PATH` env override, else `${PA_HOME:-~/.pa}/data/profile.json`)

2. Autonomous `memory-consolidation` skill (key-based with temporal metadata, 2026-08-18) extracts facts from conversation-history + profile-archive, writes candidates to staging file, post-processor applies to profile.json with `valid_from`/`valid_until`/`key`/`superseded_by` fields

NOT the `pa learn` CLI command, which runs an unrelated pipeline (see File Inventory in root CLAUDE.md).

`learn_agent.py` archives evicted `history[]` entries to `profile-history-archive.jsonl` before FIFO-trimming, and writes `profile.json` atomically (tmp+`os.replace`) — added after the old pure-slice trim had destroyed durable facts (`plans/2026-07-08-autonomous-scale-longevity-hardening-phase3.md`). Oracle skill now does newsletter analysis + daily briefing only (profile extraction delegated to memory-consolidation).

### Rate Limits → Workers
`pa/src/rate-limits.ts` tracks per-worker rate limit state (the bot consumes it via pa/dist re-exports; there is no bot-side copy).

### Topic Names
`topic-names.ts` loads ~/.pa/telegram-topic-names.json at startup.

## Git and Publishing

### Private Repo → Public Mirror
`pa public-sync` extracts private `HEAD` into `pa-public/`'s working tree (never the private working tree itself); `git-public.ps1` / `git-public.cmd` are thin aliases resolving into that same independent directory, letting `push-public` stage/commit/push reusable substrate changes to `pa-framework` without exposing private brain files.

### Public CI
`.github/workflows/ci.yml` tracked in BOTH repos (edits = private commit + git-public sync). Matrix: ubuntu + windows + macos, Node 22.

**Build step order is load-bearing — never split into parallel jobs**: the bot imports pa's compiled `pa/dist` + resolves pa's deps from `pa/node_modules` at runtime, so pa must install+build first. Real-process timing tests need ≥1500ms child lifetimes (shorter children race heartbeat async chains on starved 2-core runners).

Also runs the Python test suite (`pa/scripts/tests/test_*.py`, needs `pip install cryptography google-auth-oauthlib`) across all 3 platforms in the same job — it had zero CI coverage before and a Windows-only bug (`os.environ["TEMP"]`) shipped silently as a result. `verify_pii_guard_agy_e2e.py` is excluded (needs a real agy binary, manual only).

**`main` is a hard-gated branch on `pa-framework`**: `required_status_checks` (all 3 CI legs + PII scan) + `enforce_admins:true` — a direct `git push origin main` is REJECTED even for the repo owner; every change goes through a branch + PR (no required-review count — GitHub blocks self-approval on a solo-maintainer repo). The private repo's default branch was also renamed `master`→`main` to match (no branch protection available there — private + free plan).
