# Maintenance job catalog — operational detail

Extracted from CLAUDE.md during a 2026-08-07 `/shorten-brain` pass. The governing rule
("any recurring work that mutates durable state beyond one in-flight operation must be a
declared `MaintenanceJob`, not a bare timer") stays in CLAUDE.md's Standards &
Conventions section. This file is the full current job catalog — read it before adding,
removing, or debugging a maintenance job.

## Catchup -> Maintenance Runner -> declared jobs (AI-100, 2026-08-02)

`pa catchup`'s maintenance phase is one call — `runDueJobs('pa', jobsForHost('pa'), ...)`
— driving the 22 pa-host jobs declared in `pa/src/lib/maintenance/registry.ts` (full name
set lives there, pinned by `pa/tests/maintenance-registry.test.ts`) against the ledger
`~/.pa/maintenance-state.json`. **Registry total, both hosts: 32 (23 pa + 9 bot)** — 31 (22 pa + 9 bot) before
the `c-disk-floor-watchdog` joined (2026-09-03); 32 (22 pa + 10 bot) before
Wave-2's queue-drain absorbed the `dlq-flush` stub. The
bot-host rows are static stubs (`unbound:true` when run pa-side) so `pa maintenance
list`/`status` see every job; the real bound implementations live in the bot's
`createBotMaintenanceJobs(deps)`, built per-process because bot jobs close over runtime
token/chatIds/sentinelPath that don't exist until secrets load. The `queue-drain` family job (below) is declared INLINE in the bot only — no registry row. The pass is deliberately not
gated on `!opts.topic`: both scheduled tasks pass `--topic`, and gating on it once silently
skipped `alert-state-gc`/staleness in production. **Single-tick gate (2026-08-23):** only
`--topic default` runs the pa-host pass (both per-minute tasks used to run it, doubling
every due-check); job cadence is owned by each declaration, enforced against the ledger.

Built after an undeclared bot timer deleted 248 real Claude Code transcripts — full audit +
governing rule in `plans/2026-08-02-maintenance-framework.md`; enforced in CI by
`pa/tests/timer-inventory.test.ts`, which fails the build on a new undeclared timer (its
scan covers `projects/telegram-bot/src` too).

**Admission rule (frozen, 2026-09-02 handover wave 2):** a new-job proposal must first
prove no existing job's shape covers it — extending a registry entry (a drain source, a
recon phase) beats adding a job. The proof is one sentence in the proposal naming the
nearest existing job and the attribute that distinguishes the new work.

**`orphanWorkerReapJob` (AI-114 carve-out):** calls `cleanupOrphanedWorkers()` with no
`excludeSkills` — it runs every 60 s from `pa catchup`, with no access to the bot's
startup-time protection set. Protection is intrinsic to the registry row
(`WorkerPidEntry.harvestUntil`, stamped by dispatch callers passing
`RunOptions.harvestWindowMs`), so the job honors AI-095's 45-min harvest window
automatically. Mechanism: `docs/bot-reliability-internals.md` § "Worker-pid registry &
topic-lock invariants".

**`stalenessCheckJob` is THE dead-man's switch (2026-08-23):** every minute
(`shedWhenDegraded:true`), alerts when a scheduled skill's last success is older than
max(2× its cron interval, 30 min). Parked skills (AI-098: consecutive failures ≥5) are
skipped — `catchup.ts` already pages a separate "Skill parked" alert for them.
`cost_tier: off_peak` periodic skills (cron not time-pinned) get the threshold widened by
the 4h z.ai peak-billing window (`isPeakWindow`, `scheduler.ts:28`), matching
`partitionOverdueByCostTier`'s deferral of exactly those skills (default Mon-Fri 06:00-10:00
UTC, overridable via `cost_tier.peak_window_utc`); time-pinned crons get no widening. The
dedup key is transition-keyed (`stalenessDedupKey`, sha1 of the sorted stale-skill set) —
the alert fires on a CHANGE of the stale set, never a per-tick resend with a new hours-ago
number. (Retired `skillCadenceAuditJob` is root-CLAUDE-recorded.)

## Bot-host jobs (Wave 2, 2026-08-02, DONE)

Migrated the bot's poll-loop timers onto the same runner via
`projects/telegram-bot/src/maintenance-jobs.ts`:

- `delivered-store-compact` (5m)
- `model-override-sweep` (60s, injected not imported — avoids a `main.ts` import cycle)
- `bot-log-rotation-check` (10m, replaced the old magic-literal self-restart check)
- `proxy-pool-refresh` (env-driven, `shedWhenDegraded:false`)
- `grounding-check` (AI-101, 6h): pattern-matches every topic's `description` for
  clobber-shaped text — ends in `?`, leaked bot-reply phrases, `[Voice message]`/
  `[ATTACHMENT:` artifacts — pages pa-alerts deduped; deliberately does NOT flag a
  merely-missing description (separate larger pre-existing gap; alert fatigue)
- `registry-content-watch` (R10, 24h): asserts topic-description invariants — Path-0
  pointer in 9855, no Palo Alto hallucination in 3376, routing gate in 7822; pages
  pa-alerts deduped on violation
- `alert-digest` (daily): flushes the alert circuit-breaker digest
  (`~/.pa/alert-digest/<date>.json`) as one combined message per day for
  breaker-suppressed alerts. Non-destructive; bot-host stub pattern twin of
  `registry-content-watch`
- `dashboard-refresh` (30m): re-renders the system-dashboard pinned message, updates
  `~/.pa/telegram-dashboard.json`; skips when never bootstrapped
- `bot-self-restart` (60s — see its own entry below)
- `queue-drain` (AI-189 unification, 2026-09-03; 60s — the family minimum,
  `shedWhenDegraded:false`): ONE job for the four queue drains (the former
  `requeue-drain`, `reminder-resume-drain`, `topic-task-drain`, `dlq-flush`), with
  registered SOURCES keeping their own cadence, cold-start flag and semantics
  (`DRAIN_SOURCE_SPECS` in the bot's `maintenance-jobs.ts`). Sources run in registry
  order (dlq LAST — it can block minutes in a Telegram outage), each due-gated by its
  own `everyMs`; a source that throws is logged and skipped, never failing the job
  (per-source isolation — no job-level failure alert or AI-098 backoff; the failed
  source waits out its own cadence). Per-source stamps are in-memory per bot
  process, seeded at creation per `coldStartSeed` (the ledger has no detail store —
  same defect WP-C hit for daily-recon; the spec blesses stamp loss as harmless). A new
  queue-shaped drain joins HERE as a source (see the admission rule above).

  | source | everyMs | cold-start seed | semantics |
  |---|---|---|---|
  | `requeue` | 5m | yes | `pop-first`, `persist-before-inject`, `no-age-drop` |
  | `reminder-resume` | 60s | no | `pop-first`, `persist-before-inject`, `no-age-drop` |
  | `topic-task` | 60s | no | `pop-first`, `persist-before-inject`, `no-age-drop` |
  | `dlq` | 5m | yes | `entry-idempotent`, `send-before-mark` |

  Source detail: `requeue` re-injects parked requeue-ladder entries past their
  `requeueNotBefore` backoff (the `requeueCount` increment persists BEFORE
  injecting; a `/stop` in the window cancels); `reminder-resume` pops
  `~/.pa/pending-reminder-resume.json` (producer: `process_reminders.py`) into system
  synthetic turns (`injectSystemReminderUpdate`) — pop-first at-most-once,
  `allowedChatIds` violations WARN-and-drop, no age drop; `topic-task` claims onto the
  executor lane (≤2/tick global cap, 2 slots/topic, stale `running` >30 min demoted;
  never the topic lock, never `state.turns`); `dlq` retries `~/.pa/telegram-dlq.jsonl`
  (ENOENT fast-path; entries past the 24h TTL drop on post-flush rewrite — the pa-side
  stub's RetentionTarget went with the consolidation; behavior in `flushDlq` unchanged).

`health-probe` was deliberately EXCLUDED — its 15s cadence is incompatible with the poll
loop's 30s long-poll floor and would falsely trigger permanent DEGRADED.

The poll loop's kick is a plain time throttle (`MAINTENANCE_KICK_INTERVAL_MS`, 20s)
decoupled from whether the previous pass has settled — NOT an in-flight gate — relying on
the runner's per-job `IN_FLIGHT` guard; a settlement-gated design silently broke
re-evaluation under `poll-loop.test.ts`'s near-instant mocked `getUpdates` (found during
Wave 2 integration).

Cold-start seeding is now two-level. JOB-level, `delivered-store-compact`/
`proxy-pool-refresh`/`dashboard-refresh` are stamped "just ran" at loop entry (main.ts's
name list — `dlq-flush` and `requeue-drain` left it with the consolidation), preserving
the pre-Wave-2 never-fired-on-the-first-tick asymmetry, while
`model-override-sweep`/`bot-log-rotation-check`/`grounding-check` still fire immediately —
do not seed those. SOURCE-level, `queue-drain`'s `requeue` + `dlq` sources carry
`coldStartSeed: true` in the source registry (same rationale), while
`reminder-resume`/`topic-task` fire on the first tick after a restart.

## Pa-host job details

**`restoreDrillJob` (2026-08-17, Wave D):** monthly, verify-only restore drill. Downloads
the newest `pa-secrets-*.pab` from Drive, decrypts to a C: temp directory (never touches
live `~/.pa`), validates file formats (env files parse as KEY=VALUE, JSON parses, SQLite
magic header), reports pass/fail + duration to the ledger. Also checks the newest
`pa-fitness-*.fab` blob age/header; reports stale (>90 days) or invalid. Deterministic, no
LLM. `pa/scripts/run_restore_drill.py` reuses Drive/decrypt helpers from
`backup_secrets.py` by import.

**`clobberSentinelJob` (2026-08-17, Wave D):** every 30 minutes, detects working-tree files
reverted to an ancestor of HEAD (imports `pa reconcile --check`'s detection directly, no
CLI shelling). Pages pa-alerts deduped per-file. Skips while `@build` or git-workflow locks
are held (mid-commit reconcile reads are racy). Never mutates — detection + notification
only.

**`redteamRecurringJob` (2026-08-18, Wave G):** monthly prompt-injection redteam against
deterministic defense layers only (`pa/scripts/redteam_injection.py`): (1) credential
redaction (`pa/src/lib/redact.ts` — sk-/Bearer/ghp_/AIza/xoxb patterns), (2) the PA_META
protected-skill gate rejects git-workflow skill forgeries, (3) legitimate PA_META envelopes
pass unharmed (positive controls). ~25 adversarial fixtures. Pages pa-alerts deduped on
failure. No LLM calls.

**`alertCensusJob` (2026-08-23, Wave J1):** daily 7-day census of alerts sent/suppressed
per family, joined with owner health, written to `~/.pa/alert-census.json` for the
self-improver and weekly digest. Non-destructive. Pages pa-alerts at most once/day, only
when volume is at/above `PA_ALERT_CENSUS_NOTIFY_PER_DAY` (default 50 sends/day).

**`reviewConflictButtonsJob` (2026-08-24, buttons WP-P4):** daily; for every unresolved
conflict in `~/.pa/review-digest-pending.jsonl` not yet posted, sends one message with an
`Accept A | Accept B | Ignore` keyboard (`mc:<conflictId>:a|r|x`, operator-gated), then
marks it posted so the daily tick never re-sends. Non-destructive. Button presses spawn
`pa/scripts/review_digest_action.py --conflict-id <id> --action accept|reject|ignore`, the
single writer of that file.

**`sharedTmpSweepJob` (2026-08-28, wave-4):** hourly; sweeps stale leak artifacts from the
shared test scratch directory — `PA_TEST_TMP_DIR` when set, else the job's built-in default,
the deployment's conventional fast-drive scratch directory (`C:/wt/tmp` on this deployment).
Destructive, one RetentionTarget: deletes entries older than 1 hour matching
`^(replay_lock_|render_lock_|pytest-of-)/` — pattern precision + age floor protect
in-flight runs; durable session baselines live beside the swept directory (per-session and
backup subdirectories), outside the match set. Ownership: `external-no-retention`. Dated
evidence: 2026-08-28 disk-full incident. `pa/src/lib/maintenance/jobs/shared-tmp-sweep.ts`.

**`recallIndexJob` (2026-08-24, recall-traces wave):** every 10 minutes, incrementally
refreshes `~/.pa/recall.sqlite` (FTS5 via `better-sqlite3` in-process — no Python, no
spawn) from `conversation-history.jsonl` + shards, `turn-traces.jsonl` + shards, per-topic
brains, the Ecosystem KB directory, `review-digest-pending.jsonl`, and
`~/.pa/decisions.sqlite` (rowid watermark). Non-destructive — fully derived, rebuildable with
`pa recall --rebuild`. Throws on `ok:false` so a broken index retries on the AI-098 backoff
ladder instead of hammering every tick. `recall-store.ts` opens a fresh connection per
operation (WAL) — seeing `recall.sqlite-wal` mid-operation is expected, not a leaked
handle. Design: `docs/ARCHITECTURE.md` § "Recall (`pa recall`, 2026-08-24)".

**`skillEngagementAuditJob` (2026-08-27, AI-168):** monthly census of skills with zero
user-facing engagement ≥90 days (no successful run, no decision rows) to
`~/.pa/skill-engagement.json` for the weekly digest's Retire? section. Report-only — never
deletes, disables, or unschedules anything.

**`botSelfRestartJob` (2026-08-24, recall-traces wave):** the pa-side registry entry is a
metadata-only stub (running it pa-side returns `{touched:0, detail:{unbound:true}}`); the
real bound implementation (bot's `maintenance-jobs.ts`, `boundBotSelfRestart`, 60s) writes
the same `~/.pa/telegram-bot.stop` sentinel `pa bot stop` uses — never in-process — only
when ALL of: the newer of `pa/dist/.build-stamp` and
`projects/telegram-bot/dist/.build-stamp` is newer than this process's start time, past a
60-second grace window, the `@build` reservation is not held, and the bot is idle (no
in-flight dispatch, no topic carrying a `pending_action`, no blackboard `topic-*` lock held
by this PID). `PA_BOT_SELF_RESTART=0` disables entirely. Dist stamp newer for 30+ minutes
without the bot going idle → logs + pages a `bot-stale-code` warning instead of restarting.

**Archive-prune allowlist (2026-08-24, recall-traces wave):** rotated `-turn-traces.jsonl`
shards are in `archivePruneJob`'s target (via `PRUNABLE_ARCHIVE_SUFFIXES`,
`pa/src/lib/archive-files.ts`) and prune at the same 90 days as other rotated
log/archive shards — derived debugging data, not a permanent record like the
conversation-history shards.

**`watchJobsRunnerJob` (AI-170, 2026-08-31):** 60 s, pa host — the ONE runner for every
async watch (never a job per watch, never a bare timer). Read-only checks only
(`file_exists`/`file_gone`/`file_newer_than`/`file_contains`/`process_gone`) because an LLM
registers these: no shell, no network, no writes. 10 per tick, 25 active. Every terminal
state but a cancel SENDS, and the send precedes the status write.
`shedWhenDegraded:false`; row-level target on `~/.pa/watch-jobs.json`, pruned 14 d after
`terminalAt`. Mechanics: `plans/2026-08-31-ai170-async-watch-SPEC.md`.

**`workerEditAuditSweepJob` (2026-09-01, AI-175):** every 15 minutes, closes dispatch
edit-audit windows the bot never closed — it crashed or restarted mid-dispatch. A window
whose `botPid` is dead closes immediately; one whose PID is alive closes after
`PA_WORKER_EDIT_WINDOW_MAX_MS` (2 h). Closing takes the after-snapshot, filters findings
against active and recently-released reservations, and emits at most one `Unreserved worker
edits` alert. Windows live in `~/.pa/worker-edit-audit/`; the retention target is the 24 h
backstop for a window the sweeper could not parse. Design:
`plans/2026-09-01-ai175-worker-edit-enforcement-SPEC.md`.

**`dailyReconJob` (2026-09-02, topic-handover wave 2 WP-C):** every 15 minutes, internally
windowed to 20:40–21:10 IST (inclusive) and once per IST day — the ONE end-of-day
reconciliation family host; future reconciliation phases join HERE as phases, never as
sibling jobs (see the admission rule above). Phase 1, the orphan sweep: runs
`git status --porcelain` read-only, skips paths under active reservations, stands the
whole tick down while a git-workflow/@build/catchup lock is held (clobber-sentinel
idiom — a stood-down tick does not stamp the once-per-day marker), attributes the
survivors via `~/.pa/orphan-ledger.jsonl` (newest record per path wins) and files
land-or-discard topic tasks to the owning topics (Wave-1 `topic-tasks` store, ≤6 paths
per prompt, ≤500 chars). Unattributed paths route to `topics.support` when set —
otherwise they are only counted in `~/.pa/daily-recon.json`'s `unknown_n` for the
weekly ops digest. NEVER mutates the tree (coordination Rule 9). Producers: the orphan
ledger is written by worker-edit-audit's `closeWindow` (source `dispatch-close`).
Design: `plans/2026-09-02-topic-handover-WAVE2-SPEC.md` §3.3.

**`cDiskFloorWatchdogJob` (AI-198, 2026-09-03):** every 30 min, OBSERVE-ONLY machine guard: reads C: free bytes via a `(Get-PSDrive C).Free` one-liner (process-tree exec conventions). On the crossing BELOW the configured floor it pages pa-alerts once per crossing — transition state in `~/.pa/c-disk-floor-watchdog.json` (durable; a missing/corrupt state reads as "was above" — state loss costs one extra alert, never a missed one), dedup key `c-disk-floor`, `escalate:false`. The floor, consumer-scan root and scan budget are env knobs with deployment-convention defaults (`PA_CDISK_FLOOR_BYTES` 5 GiB, `PA_CDISK_SCAN_ROOT` the deployment's conventional scratch root, `PA_CDISK_SCAN_BUDGET_MS` 2 s — see `docs/CONFIGURATION.md`). The alert names the top 3 scan-root consumers (best-effort scan, junctions skipped; budget exhausted → "sweep manually"). Above the floor: silent. A failed/unparseable query THROWS into the AI-098 backoff ladder (never silent-skip). Admission rule: nearest job is `shared-tmp-sweep` — observe-vs-act distinguishes them. Evidence: the 2026-09-03 push-gate contention investigation record (private archive). `pa/src/lib/maintenance/jobs/c-disk-floor-watchdog.ts`.
