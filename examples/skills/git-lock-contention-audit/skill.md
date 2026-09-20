---
timeout: 900
idle_timeout: 300
worker: claude
---

# Git-workflow lock contention audit (read-only)

When the `commit` skill is repeatedly skipped on `git-workflow` lock contention, this audit determines who holds the lock and why. READ-ONLY: acquire no locks, edit no files, run no git mutations. If a step needs a write to proceed, report the limitation instead of working around it.

## Step 1 — Skip census (last 14 days)

Scan `$PA_HOME/app.log.jsonl` (fallback `~/.pa/app.log.jsonl`) plus any rotated `-app.log.jsonl` shards under `$PA_HOME/archive/` (fallback `~/.pa/archive/`) for `git-workflow` lock events and `Skipped` / `lock busy` outcomes. Use python3 (Windows: `python`) with explicit `encoding='utf-8'` on every open. Extract per skip event: timestamp (UTC and IST), the skill that was skipped, wait seconds, and refId.

## Step 2 — Holder attribution

For each skip, find the surrounding acquire and release (or lost/purged) events for `skill-exclusive:git-workflow` and record the holder skill name, PID, and hold duration (release minus acquire). A skip with no resolvable holder must be reported as unattributed — do not guess an identity.

## Step 3 — Hold-duration profile

Per holder skill: hold count, median hold duration, max hold duration, and how many holds exceeded 450s. This answers the core question: is the wait window simply too short for legitimate holders (push build+test gates, update-brain nightly sweep), or is a holder stuck/stale past its expected duration?

## Step 4 — Schedule correlation

Overlay each blocking interval on the git-workflow family schedule (update-brain 21:30 IST, push-public 23:00 IST, typical manual /push and /commit windows) and on self-improver code-fix gate runs visible in the logs. Classify each block as one of: scheduled-cron overlap, manual run, or anomalous (holder alive far past expected duration, heartbeat gaps).

## Step 5 — Report

Produce a Telegram-ready report: (a) the skip events with attributed holder; (b) per-holder duration stats; (c) at most 3 ranked recommendations — stagger the colliding cron, widen the lock wait window, or queue-and-retry instead of skip — each citing the exact log timestamps/refIds that justify it and noting where it would be implemented (skill frontmatter/config vs pa/src lock handling). State plainly if the evidence is insufficient for any recommendation.
