# Maintenance job catalog — operational detail

Extracted from CLAUDE.md during a 2026-08-07 `/shorten-brain` pass. The governing rule
("any recurring work that mutates durable state beyond one in-flight operation must be a
declared `MaintenanceJob`, not a bare timer") stays in CLAUDE.md's Standards &
Conventions section. This file is the full current job catalog — read it before adding,
removing, or debugging a maintenance job.

## Catchup -> Maintenance Runner -> declared jobs (AI-100, 2026-08-02)

`pa catchup`'s maintenance phase is one call — `runDueJobs('pa', jobsForHost('pa'), ...)`
— driving 11 declared jobs (`pa/src/lib/maintenance/registry.ts`: `orphanWorkerReapJob`,
`blackboardPurgeJob`, `stalenessCheckJob`, `skillCadenceAuditJob`, `skillLogRotateJob`,
`archivePruneJob`, `alertStateGcJob`, `weeklyLearnJob`, `sessionGcJob`,
`voiceAttachmentGcJob`, and `reservationGcJob` — the last added 2026-08-06 as part of the
multi-session coordination protocol, GC'ing expired rows in `~/.pa/reservations.json`) against
the ledger `~/.pa/maintenance-state.json`, un-gated by topic (fixed a live bug:
`alert-state-gc`/staleness migration had never run in production because it was gated on
`!opts.topic` while both registered scheduled tasks pass `--topic`).

**`orphanWorkerReapJob` harvest-window carve-out (AI-114, 2026-08-08):** this job calls
`cleanupOrphanedWorkers()` with no `excludeSkills` — it runs every 60 seconds from a
separate process (`pa catchup`) with no access to the bot's own startup-time protection
set, so it used to silently defeat AI-095's 45-minute harvest window for a
crashed-spawner's still-replying worker. Protection is now intrinsic to the registry row
itself (`WorkerPidEntry.harvestUntil`, stamped by dispatch callers that pass
`RunOptions.harvestWindowMs`) rather than caller-supplied, so this job automatically
honors it without needing its own `excludeSkills` set. See
`docs/bot-reliability-internals.md`'s "Worker-pid registry & topic-lock invariants"
section for the full mechanism.

**`skillCadenceAuditJob` dead-man's-switch (2026-08-17, Wave C):** runs hourly (1h cadence,
`shedWhenDegraded:true`) and audits every scheduled skill's last successful run against
max(2× interval, 26h). Skills whose last success is older than the threshold trigger a
pa-alerts notification with the skill name, interval, hours-since-success, and threshold.
Parked skills (AI-098: consecutive failures ≥5) have their parked status and failure count
included in the alert message to avoid double-reporting. Deduped via `notifyUser`'s
dedup key `'skill-cadence-audit'`.

Built after an undeclared bot timer deleted 248 real Claude Code transcripts — full
audit + governing rule in `plans/2026-08-02-maintenance-framework.md`; enforced in CI by
`pa/tests/timer-inventory.test.ts`, which fails the build on a new undeclared timer.
Wave 1 is `pa`-host only.

**Wave 2 (2026-08-02, DONE)** migrated the bot's remaining poll-loop timers onto the same
runner via a new `projects/telegram-bot/src/maintenance-jobs.ts`
(`createBotMaintenanceJobs(deps)`, constructed per-process since bot jobs close over a
runtime token/chatIds/sentinelPath that don't exist until secrets load — `pa`'s static
registry can't express that, so `jobsForHost('bot')` staying empty is by design, not a
gap):

- `dlq-flush` (5m, `shedWhenDegraded:false` — it IS reply delivery)
- `delivered-store-compact` (5m)
- `model-override-sweep` (60s, injected not imported — avoids a `main.ts` import cycle)
- `bot-log-rotation-check` (10m, replaces the old magic-literal self-restart check)
- `proxy-pool-refresh` (env-driven, `shedWhenDegraded:false`)
- `grounding-check` (2026-08-05, AI-101, 6h, pattern-matches every topic's `description`
  for clobber-shaped text — ends in `?`, leaked bot-reply phrases,
  `[Voice message]`/`[ATTACHMENT:` artifacts — and pages pa-alerts deduped; deliberately
  does NOT flag a merely-missing description, a separate larger pre-existing gap, to
  avoid alert fatigue)

`health-probe` was deliberately EXCLUDED — its 15s cadence is incompatible with the poll
loop's 30s long-poll floor and would falsely trigger permanent DEGRADED.
`pa/tests/timer-inventory.test.ts`'s scan now also covers `projects/telegram-bot/src`
(105 files total).

The poll loop's kick is a plain time throttle (`MAINTENANCE_KICK_INTERVAL_MS`, 20s)
decoupled from whether the previous pass has settled — NOT a `!maintenancePass` in-flight
gate — relying on the runner's existing per-job `IN_FLIGHT` guard for correctness; a
settlement-gated design silently broke re-evaluation under `poll-loop.test.ts`'s
near-instant mocked `getUpdates` (found and fixed during Wave 2 integration).

Cold-start seeding (`dlq-flush`/`delivered-store-compact`/`proxy-pool-refresh` stamped as
"just ran" at loop entry) preserves the pre-Wave-2 asymmetry where those three never
fired on the very first tick, while `model-override-sweep`/`bot-log-rotation-check` still
fire immediately — do not seed those two. `grounding-check` (added 2026-08-05) is also
NOT cold-start-seeded — same reasoning as `model-override-sweep`/`bot-log-rotation-check`.

**`restoreDrillJob` (2026-08-17, Wave D):** runs monthly (30d cadence, `shedWhenDegraded:true`)
and performs a verify-only restore drill. Downloads the newest `pa-secrets-*.pab` from Drive,
decrypts to a C: temp directory (never touches live `~/.pa`), validates file formats
(env files parse as KEY=VALUE, JSON files parse, SQLite files have magic header), and
reports pass/fail + duration to the ledger. Also checks the newest `pa-fitness-*.fab`
blob age and header; reports stale (>90 days) or invalid. All deterministic, no LLM.
Implementation: `pa/scripts/run_restore_drill.py` reuses Drive client and decrypt functions
from `backup_secrets.py` by import.

**`clobberSentinelJob` (2026-08-17, Wave D):** runs every 30 minutes (30m cadence, `shedWhenDegraded:true`)
and detects working-tree files reverted to an ancestor of HEAD. Imports the same detection function
as `pa reconcile --check` directly (no CLI shelling). Pages pa-alerts deduped per-file when drift
is found. Skips while `@build` or git-workflow locks are held (mid-commit reconcile reads are racy).
Never mutates anything — pure detection + notification only.

**`redteamRecurringJob` (2026-08-18, Wave G):** runs monthly (30d cadence, `shedWhenDegraded:true`)
and executes prompt-injection redteam regression tests against deterministic defense layers only
(no LLM). The script `pa/scripts/redteam_injection.py` tests three layers: (1) credential redaction
(`pa/src/lib/redact.ts`) verifies sk-/Bearer/ghp_/AIza/xoxb token patterns are redacted,
(2) PA_META protected-skill gate (`bot PA_META_PROTECTED_SKILLS`) rejects git-workflow skill
forgeries (commit/push/push-public/commit-and-push/investigate-flagged/update-brain), and
(3) legitimate PA_META envelopes (positive controls) pass unharmed. Fixture corpus contains
~25 adversarial inputs across all classes. On failure, pages pa-alerts deduped. Deterministic,
no LLM calls.
