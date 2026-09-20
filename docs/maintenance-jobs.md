# Maintenance job catalog — operational detail

Extracted from CLAUDE.md during a 2026-08-07 `/shorten-brain` pass. The governing rule
("any recurring work that mutates durable state beyond one in-flight operation must be a
declared `MaintenanceJob`, not a bare timer") stays in CLAUDE.md's Standards &
Conventions section. This file is the full current job catalog — read it before adding,
removing, or debugging a maintenance job.

## Catchup -> Maintenance Runner -> declared jobs (AI-100, 2026-08-02)

`pa catchup`'s maintenance phase is one call — `runDueJobs('pa', jobsForHost('pa'), ...)`
— driving the 31 pa-host jobs declared in `pa/src/lib/maintenance/registry.ts` (full name
set lives there, pinned by `pa/tests/maintenance-registry.test.ts`) against the ledger
`~/.pa/maintenance-state.json`. **Registry total, both hosts: 40 (31 pa + 9 bot)** —
a monotonic-growth count; the per-join history lives in git log, and the test re-derives
the current number. The
bot-host rows are static stubs (`unbound:true` when run pa-side) so `pa maintenance
list`/`status` see every job; the real bound implementations live in the bot's
`createBotMaintenanceJobs(deps)`, built per-process because bot jobs close over runtime
token/chatIds/sentinelPath until secrets load. The `queue-drain` family job (below) is declared INLINE in the bot — no registry row.
**Since 2026-09-10 one long-lived process drives three lanes.** `pa catchup --loop` holds
`catchup:loop` on the blackboard and runs the `default`, `reminders` and `maintenance` lanes off
one internal timer, each with its own in-flight flag so a slow lane never delays another. The
`maintenance` lane drives the pa-host pass under its own lock `catchup:maintenance`; a topic-less
one-shot `pa catchup` runs it inline under the bare `catchup` lock. Job cadence is owned by each
declaration and enforced against the ledger, never by how often catchup happens. The per-minute
launcher restarts a loop whose heartbeat or lane progress files go stale, and a stalled store
queue makes the loop exit for relaunch; see `docs/catchup-watchdog.md`.

Built after an undeclared bot timer deleted 248 real Claude Code transcripts — full audit +
governing rule in the maintenance-framework internal design record (2026-08-02); enforced in CI by
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
automatically. Mechanism: `docs/bot-worker-pid-registry.md` (split from
`docs/bot-reliability-internals.md` 2026-09-14).

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
number. (Retired `skillCadenceAuditJob`.)

Since 2026-09-16 it also pages `Maintenance ledger stale` (key `maintenance-freshness:<hash>`)
when a declared job of either host has no ledger attempt or skip for 15 minutes, and it drains
`~/.pa/stall-records.jsonl` into the archive and the log (`docs/catchup-watchdog.md`).

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
  merely-missing description (separate larger pre-existing gap; alert fatigue).
  Second half (2026-09-16): stats every declared `/sources` file per topic —
  missing/unreadable/not-a-file paths page "Declared topic source missing" under
  the `grounding-check-sources` dedup family (never masked by the clobber page);
  existence/readability only, no content diff
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
  process, seeded at creation per `coldStartSeed` (the ledger has no detail store;
  stamp loss is blessed as harmless). A new
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
  `allowedChatIds` violations WARN-and-drop, no age drop (minting side: `add_reminder.py
  --resume-action-json`, or `projects/reminders/condition_resume.py` for the
  wait-for-a-condition-then-act wrapper — see `docs/ARCHITECTURE.md` §
  "Condition-gated resume"); a `voice_inbox_resume` record (2026-09-12) is exempt
  from that gate — it type-branches BEFORE it and resumes a voice-inbox
  `conversation_id` via `create_conversation_task.py`; `topic-task` claims onto the
  executor lane (≤2/tick global cap, 2 slots/topic, stale `running` >30 min demoted;
  never the topic lock, never `state.turns`); `dlq` retries `~/.pa/telegram-dlq.jsonl`
  (ENOENT fast-path; entries past the 24h TTL drop on post-flush rewrite;
  `flushDlq` behavior unchanged).

`health-probe` was deliberately EXCLUDED — its 15s cadence is incompatible with the poll
loop's 30s long-poll floor and would falsely trigger permanent DEGRADED.

The poll loop's kick is a plain time throttle (`MAINTENANCE_KICK_INTERVAL_MS`, 20s)
decoupled from whether the previous pass has settled — NOT an in-flight gate — relying on
the runner's per-job `IN_FLIGHT` guard; a settlement-gated design silently broke
re-evaluation under `poll-loop.test.ts`'s near-instant mocked `getUpdates`.

Cold-start seeding is now two-level. JOB-level, `delivered-store-compact`/
`proxy-pool-refresh`/`dashboard-refresh` are stamped "just ran" at loop entry (main.ts's
name list), preserving
the pre-Wave-2 never-fired-on-the-first-tick asymmetry, while
`model-override-sweep`/`bot-log-rotation-check`/`grounding-check` still fire immediately —
do not seed those. SOURCE-level, `queue-drain`'s `requeue` + `dlq` sources carry
`coldStartSeed: true` in the source registry (same rationale), while
`reminder-resume`/`topic-task` fire on the first tick after a restart.

## Pa-host job details

<!-- doc-lint note: this catalog is record-shaped, one paragraph per declared job.
Its per-job paragraphs are deliberately exempt from R1's five-sentence limit, per
the record-shaped-content exemption in CLAUDE.md. Do not reword a paragraph here
to dodge a finding. -->

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
in-flight dispatch, no `pending_action`, no blackboard `topic-*` lock held
by this PID). `PA_BOT_SELF_RESTART=0` disables entirely. Dist stamp newer for 30+ minutes
without the bot going idle → logs + pages a `bot-stale-code` warning instead of restarting.

**Archive-prune allowlist (2026-08-24, recall-traces wave):** rotated `-turn-traces.jsonl`
shards are in `archivePruneJob`'s target (via `PRUNABLE_ARCHIVE_SUFFIXES`,
`pa/src/lib/archive-files.ts`) and prune at the same 90 days as other rotated
log/archive shards — derived debugging data, not a permanent record like the
conversation-history shards. Drained `-stall-records.jsonl` shards (since 2026-09-16)
prune the same way.

**`watchJobsRunnerJob` (AI-170, 2026-08-31):** 60 s, pa host — the ONE runner for every
async watch (never a job per watch, never a bare timer). Read-only checks only
(`file_exists`/`file_gone`/`file_newer_than`/`file_contains`/`process_gone`) because an LLM
registers these: no shell, no network, no writes. 10 per tick, 25 active. Every terminal
state but a cancel SENDS, and the send precedes the status write.
`shedWhenDegraded:false`; row-level target on `~/.pa/watch-jobs.json`, pruned 14 d after
`terminalAt`. Mechanics per the AI-170 async-watch internal design record (2026-08-31).

**`workerEditAuditSweepJob` (2026-09-01, AI-175):** every 15 minutes, closes dispatch
edit-audit windows the bot never closed — it crashed or restarted mid-dispatch. A window
whose `botPid` is dead closes immediately; one whose PID is alive closes after
`PA_WORKER_EDIT_WINDOW_MAX_MS` (2 h). Closing takes the after-snapshot, filters findings
against active and recently-released reservations, and emits at most one `Unreserved worker
edits` alert. Windows live in `~/.pa/worker-edit-audit/`; the retention target is the 24 h
backstop for a window the sweeper could not parse. Design per the AI-175
worker-edit-enforcement internal design record (2026-09-01).

**`dailyReconJob` (2026-09-02, topic-handover wave 2 WP-C):** every 15 minutes, internally
windowed to 20:40–21:10 IST (inclusive) and once per IST day — the ONE end-of-day
reconciliation family host; future reconciliation phases join HERE as phases, never as
sibling jobs (see the admission rule above). Phase 1, the orphan sweep: runs
`git status --porcelain` read-only, skips paths under active reservations, stands the
whole tick down while a git-workflow/@build/catchup lock is held (clobber-sentinel
idiom — a stood-down tick does not stamp the once-per-day marker), attributes the
survivors via `~/.pa/orphan-ledger.jsonl` (newest record per path wins) FIRST, then
via the topic-ownership registry `~/.pa/topic-ownership-registry.json` (repo-relative
`owned` path prefixes, segment-matched) for paths the ledger leaves unattributed (no
record, or a latest record with a null owner), and files land-or-discard topic tasks to
the owning topics (Wave-1 `topic-tasks` store, ≤6 paths per prompt, ≤500 chars).
Unattributed paths route to the registry's `role: "catch-all"` row, falling back to
`topics.support` when set — otherwise they are only counted in `~/.pa/daily-recon.json`'s
`unknown_n` for the weekly ops digest. The state file records provenance: `registry_rows`
(valid registry rows loaded), `catch_all` (resolved catch-all key or null), and each
group's `source` (`ledger` | `registry`). NEVER mutates the tree (coordination Rule 9).
Producers: the orphan ledger is written by worker-edit-audit's `closeWindow` (source
`dispatch-close`). Design per the topic-handover wave-2 internal design record
(2026-09-02); registry-fed attribution per the 2026-09-05 topic-ownership wave.

**`cDiskFloorWatchdogJob` (AI-198, 2026-09-03):** every 30 min, OBSERVE-ONLY machine guard: reads C: free bytes via a `(Get-PSDrive C).Free` one-liner (process-tree exec conventions). On the crossing BELOW the configured floor it pages pa-alerts once per crossing — transition state in `~/.pa/c-disk-floor-watchdog.json` (durable; a missing/corrupt state reads as "was above" — state loss costs one extra alert, never a missed one), dedup key `c-disk-floor`, `escalate:false`. The floor, consumer-scan root and scan budget are env knobs with deployment-convention defaults (`PA_CDISK_FLOOR_BYTES` 5 GiB, `PA_CDISK_SCAN_ROOT` the deployment's conventional scratch root, `PA_CDISK_SCAN_BUDGET_MS` 2 s — see `docs/CONFIGURATION.md`). The alert names the top 3 scan-root consumers (best-effort scan, junctions skipped; budget exhausted → "sweep manually"). Above the floor: silent. A failed/unparseable query THROWS into the AI-098 backoff ladder (never silent-skip). Admission rule: nearest job is `shared-tmp-sweep` — observe-vs-act distinguishes them. Evidence: the 2026-09-03 push-gate contention investigation record (private archive). `pa/src/lib/maintenance/jobs/c-disk-floor-watchdog.ts`.

**`nonpagedPoolWatchJob` (2026-09-10):** every 15 min, OBSERVE-ONLY machine guard: reads nonpaged
kernel pool and its PER-TAG attribution through `NtQuerySystemInformation(SystemPoolTagInformation)`
via a ctypes helper (`pa/scripts/pool_tags.py`) — RAMMap's scan does not finish on a starved
machine and `poolmon` needs the WDK, so ctypes is the reliable path. Two alert families: `nonpaged-pool` (floor or growth) and the
earlier `nonpaged-pool-early` (`PA_POOL_NONPAGED_EARLY_BYTES`, 1.5 GiB, transition-gated by `wasEarlyAlerting` in the same state
file; a main crossing subsumes the early one for that pass), `escalate:false`, transition-gated in `~/.pa/nonpaged-pool-watch.json`: fires once
when EITHER the absolute floor (`PA_POOL_NONPAGED_ALERT_BYTES`, 3 GiB) or the growth rate
(`PA_POOL_NONPAGED_GROWTH_BYTES_PER_HOUR`, 100 MiB/h over a baseline at least
`PA_POOL_NONPAGED_MIN_WINDOW_MS` old) is crossed, stays silent while it persists, re-arms below
both; the early floor is `PA_POOL_NONPAGED_EARLY_BYTES`. **The alert names the top `PA_POOL_TAGS_TOP_N` tags with their per-hour deltas, not just a
total** — a total alone does not locate a leak. Non-destructive, no retention targets. Skips
cleanly with `detail.skipped: 'non-win32'` off Windows. A failed or unparseable sample THROWS into
the AI-098 backoff ladder rather than degrading to a number. Admission rule: nearest job is
`c-disk-floor-watchdog`; different resource, same observe-only shape. Dated evidence: 2026-09-10,
a font-handle loop leaked the `NtFC` tag ~6.1 GB/h to 11.3 of 15.9 GB RAM over 78 h with no
signal beyond "the machine feels slow".
`pa/src/lib/maintenance/jobs/nonpaged-pool-watch.ts`.

**`voiceInboxFallbackJob` (AI-214 follow-up F-A, 2026-09-09):** every 5 minutes,
deterministic, no LLM. Built after a live incident (2026-09-09) where six voice
notes sat stuck for hours because every inbox-topic worker was quota-exhausted,
cooling, or answered in chat — a human ran
`transcribe_voice.py`/`task_transcribe.py`/`route_task.py` by hand; this job
automates exactly that hand resolution. Selects, read-only off
`~/.pa/voice-inbox/ledger.sqlite`
(same WAL/busy_timeout convention as the python worker scripts and
`pa/src/lib/voice-inbox-ledger.ts`'s read-only accessor — never creates schema): tasks with no
`worker_resource` in `transcribing` with `created_at` older than
`PA_VOICE_INBOX_FALLBACK_TRANSCRIBING_STALE_MS` (default 2 min) or in `received` older than
`PA_VOICE_INBOX_FALLBACK_RECEIVED_STALE_MS` (default 6 min), and `routed` tasks with
`updated_at` older than `PA_VOICE_INBOX_FALLBACK_ROUTED_STALE_MS`
(default 20 min) — the routed half additionally requires that no task of the same
`conversation_id` is LIVE (a `worker_resource` AND state `running`/`awaiting_input`). Three actions, each
mutating the ledger ONLY through the same surface a
real worker or the app server would use — never a hand-built write:
- `transcribing` → BACKSTOP only (2026-09-16): the bot's poll-tick drain is the primary caller
  of the same shared action (`pa/src/lib/voice-inbox-transcribe.ts` — claim
  `voice-inbox-transcribe:<task_id>`, retries paced 2/5/10 min off the newest marker, exec
  process tree killed at its timeout). Runs `pa/scripts/transcribe_voice.py --cloud-order groq,openai,deepgram`
  (secrets injected via `loadSecrets()`, the same `{...process.env, ...secrets}` seam
  `voice.ts`'s prefetch path uses) then `task_transcribe.py --transcript`/`--fail`. Audio
  under `PA_VOICE_INBOX_FALLBACK_MIN_AUDIO_BYTES` (default 8 KB, the 2026-09-09 incident's
  sub-second-capture floor), an empty transcript, or Whisper's near-silence artefact on a
  sub-floor file (≤3 words) all fail honestly rather than routing junk. AI-239 failure
  split (2026-09-13: two recordings stranded 14h+ in terminal `transcribe_failed` behind
  an infra outage, recovered by hand): a failed envelope is classified by `error_code` —
  audio-side codes (`missing-file`, `oversize`) stay terminal immediately, while infra
  codes (`no-engine`, `cloud-auth`, `ffmpeg-missing`, `other`) record a NON-TERMINAL
  `task.failed` marker (`payload.code === 'infra'`, no state change — voice-inbox's own
  `appendEvent`) and the task stays `transcribing` for the next tick's retry.

  The bound:
  `PA_VOICE_INBOX_FALLBACK_TRANSCRIBE_INFRA_ATTEMPTS` markers (default 4), or — with at
  least one recorded marker — the task outliving
  `PA_VOICE_INBOX_FALLBACK_TRANSCRIBE_INFRA_WINDOW_MS` (default 45 min, by `created_at`).
  A task that merely sat past the window with NO recorded failure (pa down, worker never
  ran) still gets its first real attempt; when the marker channel itself is broken
  (voice-inbox dist missing), an over-age failed attempt terminalizes instead of retrying
  forever — the count bound can never engage there. Terminal:
  `task_transcribe.py --fail --code infra` plus one pa-alerts page
  (dedup `voice-inbox-transcribe-failed:<task_id>`); the `infra` code keeps it visible in
  the list/triage count (only `too_short` hides).
- `received` → runs `route_task.py` to a deterministic target: `voice_inbox_fallback.
  keyword_topics` (config.yaml, empty by default) else the inbox chat's general-knowledge
  topic (`<inboxChatId>_0`); merges into an open conversation via `--continues` when BOTH
  hold against the newest non-terminal task in the same tenant (excluding the task being
  routed): the two tasks' `created_at` are within `CONTINUES_WINDOW_MS` (3 min, not
  configurable) of each other, AND their request texts' word-set **Jaccard similarity**
  — `|intersection| / |union|` of the lowercased, punctuation-stripped token
  sets — is at least `CONTINUES_WORD_OVERLAP_MIN` (0.6). Both are hardcoded constants in
  `voice-inbox-fallback.ts` (`wordOverlap()`), not env knobs — the spec's "shares >= 60%
  of words" names no formula; Jaccard is pinned here so nobody re-derives it. Below either
  threshold the task routes standalone (self-rooted conversation, no `--continues`).
- stale `routed` → replays the SAME mechanism the operator `POST /tasks/:id/reroute`
  endpoint uses (`transitionTask` + `appendRouteEntry`, loaded from voice-inbox's own
  compiled output via a computed-specifier dynamic `import()` — voice-inbox ships no
  `.d.ts` and pa's strict tsconfig has no override for that package, so a static
  import fails to compile; **build-order coupling CI does not yet
  enforce** — `projects/voice-inbox` must be built before this job's tests or production
  path runs, and `.github/workflows/ci.yml` does not build or test that
  package at all, unlike the documented pa→bot ordering) to the SAME
  topic, so the injected line resends without a synthetic operator-shaped event. Skipped
  while a task of the same conversation is LIVE (`worker_resource` AND state
  `running`/`awaiting_input`; 2026-09-11 double-routing fix, narrowed the same day): workers claim
  one task row but work the whole conversation, and `worker_resource` survives completion
  — an unclaimed routed sibling of a claimed conversation is left to the conversation's
  worker instead of re-injected; without the guard one such sibling re-routed three times
  in an hour into a topic its worker was already delivering. Early-stage placement
  (transcribing/received) stays per-task, so a new note recorded into a busy conversation
  is still transcribed and routed.
- stale `running` whose dispatch is dead (AI-221) → replays like stale `routed`, to the same topic.
  A task with no `routed_to` was never routed: an inbox routing run progressed it and stopped
  without `route_task.py` (2026-09-16, `vi-d79c09c5eb37`). It is placed once, as a first routing
  (`running → routed`, `task.routed`), to the `received` arm's deterministic target through the
  same `transitionTask` + `appendRouteEntry` pair. `routed_to` is never cleared, so it cannot recur;
  with no target it fails with a plain-language reason and one pa-alerts page.
  A routing-retry task (`VOICE_ROUTE_RETRY_REASON`) is placed the same way.

No `task.progress` ledger event is written for any action: it is only a legal event kind
from state `routed` (where it transitions the task to `running`) or `running` itself
(`TRANSITION_EVENT_KINDS` in `projects/voice-inbox/src/ledger.ts` +
`task_telemetry.py`'s own state gate), and none of the three actions leaves a task in
`running` — forcing one would violate the state gate or falsely claim a worker picked
the task up. Every action instead names the fallback in the `--reason`/routing-
reason text the real scripts already require, and logs internally
(`log.ts`, module `voice-inbox-fallback`) with a freshly minted ref-id.
`PA_VOICE_INBOX_FALLBACK=0` disables entirely. `pa/src/lib/maintenance/jobs/voice-inbox-fallback.ts`.

**`orphanEditWatchJob` (AI-214, 2026-09-08):** daily runner-driven, non-destructive, `targets: []` — disposition ladder for working-tree paths dirty ≥6 h (stat-failed mtimes excluded, counted) with no active reservation. Attribution per path (`pa/src/lib/orphan-attribution.ts`): reservation overlap → reserved (silent defer); newest hit scanning Claude transcripts under `PA_CLAUDE_PROJECTS_DIR` (default `~/.claude/projects`, 7-day window, 5 s time box, line-streamed) → owned, alive iff that file's mtime moved within 15 min; else unattributed. Paths group into families keyed by path-set hash in `~/.pa/orphan-watch.json` (fail-to-empty reads, atomic writes, 7-day prune). Ladder: alive owners defer silently; dead/unattributed/mixed families get a completion-agent topic task (filed via `appendTask`, run by the bot's 60 s queue drain on the executor lane; the agent finishes unambiguous-and-small edits or lands them verbatim by pathspec commit, reporting to the topic) — the job claims the paths first with a 4 h TTL reservation (`session: orphan-edit-watch`) so the agent's own edits don't fire `Unreserved worker edits` alerts and daily-recon skips them; still unresolved ~48 h after first sight it alerts once per family with land-as-is / keep-dirty-24 h / show-diff buttons (`ow:`, operator-gated last resort). **The job NEVER commits; the agent and the operator button do.** Kill switch `config.maintenance["orphan-edit-watch"].enabled: false`; stands down while a git-workflow/`@build`/catchup lock is held. Admission rule: nearest job is daily-recon Phase 1 — the ≥6 h stability gate, transcript-based owner attribution and the automated completion-agent disposition distinguish them. `pa/src/lib/maintenance/jobs/orphan-edit-watch.ts`; manual surface `pa orphan list|land|keep|diff`.

**`authAnswerReapJob` (2026-09-10, auth broker Phase A):** every 15 minutes; reaps
operator-typed secret answer values on two independent retention windows. Destructive, two
RetentionTargets: `~/.pa/voice-inbox/answers/<task_id>/` entries matching
`^ir-[0-9a-f]{12}\.txt$` older than 24h — selection is actually driven by the broker
request store's `delivered_at` (1h) and the ledger's `answered_at` for `secret` requests
with no broker row (24h, the gap a broker-only pass could never see), never by top-level
mtime — and `~/.pa/auth/requests/` broker rows matching `^ir-[0-9a-f]{12}\.json$` older
than 24h past `expires_at` or `delivered_at`. Both scopes are `pa-owned`. Every deletion is
fail-closed on the row's own claimed path: a mismatched basename (e.g. `notes.txt`) is
never touched even when a row's `answer_pointer` names it. Admission rule: nearest job is
`shared-tmp-sweep` — that one sweeps a shared scratch root by filename age, this one reaps
operator-typed secrets by delivery and answer time from two owned stores. Dated evidence:
auth-broker survey + same-day refutation pass, 2026-09-10.
`pa/src/lib/maintenance/jobs/auth-answer-reap.ts`.

**`backlogFragmentsDrainJob` (2026-09-12; AI-316):** 3-min merge `backlog/fragments/*.json` → `backlog/open-<section>.md` — sole writer of those + router's `AUTO:BACKLOG-SECTIONS` region. `add` by slug (unknown schema-valid ⇒ creates file + router row + warn); `status` by id scan (0⇒`unknown target`, >1⇒`ambiguous target`); ids = max-scan over `backlog/*.md`. `git-workflow` held skip-not-wait; defers <15-min-dirty write-set files (BACKLOG.md only on regen); stale-dirty merges on top (warn names paths); unparseable ⇒ quarantine+alert; `frag:<stem>` markers idempotent. Auto-archives DONE (Σ moved ≥10 or file ≥30,000 pre-archive) → `backlog/completed-<IST-date>.md`. `pre-router-backlog`/`backlog-layout-invalid` ⇒ skip+warn; fragments preserved. No targets, never shed. `pa/src/lib/maintenance/jobs/backlog-fragments-drain.ts`.

**`busDrainJob` (2026-09-15, agent-bus wave):** every 60 s, drains pending
`~/.pa/queues/<address>.jsonl` envelopes by spawning the worker named in the
address's registry entry (`entry.worker`). Per address per pass: decode the
address from the filename ('+'→':'), skip with a warn when the registry has no
spawn profile, skip when a live arm owns the queue (cursor event is
`inbox`/`wait` less than 5 min old AND capabilities include `hooks`/`acp` — a
`spawn` event stamped by the drain itself does NOT suppress retries), peek the
oldest envelope,
stamp the cursor `spawn`, dispatch `executeWorker` with
`resource: bus-<address>` and a prompt carrying identity + reply path
(`pa bus send`) + an untrusted-input warning. Success acks the envelope
(peek+ack, never pop); failure leaves it queued for the next tick. One envelope
per address per pass. Non-destructive, `targets: []`, sheddable. Admission
rule: nearest job is `watch-jobs-runner` — that one runs read-only checks, this
one dispatches LLM workers. `pa/src/lib/maintenance/jobs/bus-drain.ts`.

**`busPruneJob` (2026-09-17, soft-read bus wave):** daily, expires
`~/.pa/queues/*.jsonl` envelopes older than 24 h (and caps each queue at 200
entries). Needed because `pa bus inbox` no longer deletes on read — it marks a
per-consumer `readBy` receipt — so this job is the only bound on queue growth
and the reaper for phantom/unregistered queues nobody reads. Selection is
per-envelope: expired JSONL lines are removed in place, the file survives.
Destructive, one target (`~/.pa/queues` `*.jsonl`, 24 h), sheddable. Admission
rule: nearest job is `bus-drain` — that one delivers mail, this one owns the
retention the soft-read semantics require. `pa/src/lib/maintenance/jobs/bus-prune.ts`.
The same run also reaps dead `registry.json` rows (`reapBusRegistry`): a row
whose host pid is dead, or superseded by a different live address on the same
pid, is removed (fresh-cursor veto; pid-less/silent-host rows kept; queue
files untouched — the envelope bound still covers them).

**`modelRouterCooldownNormalizeJob` (2026-09-18, model-router wave):** daily,
two duties over state the router wave introduced. (1) Cooldown normalize:
rate-limit cooldowns that expired more than 24 h ago are stale residue —
self-healing classifications are cleared so `rate-limit-state.json` does not
accumulate dead entries; terminal faults (`account-exhausted`) are NEVER
cleared here (only a successful dispatch overrides those) and `unknown`-class
entries are recorded as unknown and left in place — the job records, it never
probes or rewrites. (2) Shadow + telemetry prune: drops `model-router-shadow.jsonl`
AND `model-router-telemetry.jsonl` lines whose `at` is older than 90 days,
per-line, atomic tmp+rename rewrite. Destructive, two targets
(`~/.pa/model-router-shadow.jsonl` and `~/.pa/model-router-telemetry.jsonl`,
both 90 d), sheddable. The telemetry target was added 2026-09-19 by the wave
deep-recheck — the telemetry writer shipped with no retention at all.
Admission rule: nearest job is `bus-prune` — that one owns bus-queue
retention per envelope, this one owns the router wave's state files (cooldown
normalize has no sibling; the shadow prune reuses its per-line atomic
rewrite idiom). All cooldown writes go through the rate-limits module's own
exported helpers (`getCooldownStatus`/`clearWorkerCooldown`) — the job is not
a second independent writer to `rate-limit-state.json`.
`pa/src/lib/maintenance/jobs/model-router-cooldown-normalize.ts`.
