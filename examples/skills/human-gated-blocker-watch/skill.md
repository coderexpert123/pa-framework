---
cron: "30 4 * * *"
cost_tier: off_peak
on_missed: latest
cwd: "${PA_HOME}/skills/human-gated-blocker-watch"
secrets:
  - TELEGRAM_BOT_TOKEN
  - TELEGRAM_CHAT_ID
cmd: "python3 human_gated_blocker_watch.py || python human_gated_blocker_watch.py"
# Reads two small local JSON files and one YAML config — no CLI subprocess
# probing, so a low timeout is generous (worker-capability-watch needs 1800s
# only because it launches every worker CLI's --version/--help).
timeout: 120
telegram_output:
  chat_id: '${TELEGRAM_CHAT_ID}'
  thread_id: 0
  token_secret: TELEGRAM_BOT_TOKEN
trigger_description: Watchdog - tracks how long each worker has been stuck in a
  terminal human-gated fault (account-exhausted / auth-error) and escalates the
  alert from warning (3-6 days) to error (7+ days, naming the worker's config
  priority) until a human recharges or reprioritises.
---

Deterministic daily escalation watchdog for human-gated worker blockers (no LLM,
no worker spawn). Runs at 04:30 UTC (10:00 IST), right after
`worker-capability-watch`'s 04:00 slot, same quiet-hours convention.

## What it guards

A worker that hits a terminal, human-action-required fault gets **one** alert
from `pa/src/rate-limits.ts`'s `alertAccountExhausted()` and then goes quiet at a
fixed ~6h dedup cadence forever — it never gets louder, and nothing tracks **how
long** the outage has actually persisted. `~/.pa/rate-limit-state.json`'s
`last_event` / `cooldown_until` are REWRITTEN on every failed retry, so the
system's own state has no memory of "this has been broken for a week", only
"this failed again just now". Meanwhile a dead worker keeps sitting at its old
`priority:` in `config.yaml` with no signal recommending a human look.

A worker stuck at `account-exhausted` — a billing-class fault rate-limits.ts documents as one that "never self-heals" — can sit at its old `priority:` in `config.yaml` for weeks, and the only signal was a dedup-suppressed one-shot that never escalated. This watchdog closes that "one alert then silence forever" gap.

## What it escalates

Only `account-exhausted` and `auth-error` are treated as **human-gated**. The
other `RateLimitClassification` values (`quota-daily`, `quota-per-minute`,
`quota-exhausted`, `server-overload`, `usage-limit-session`) self-heal on a
timer and are deliberately NOT escalated — crying wolf on a fault that fixes
itself trains the user to ignore the alert.

| age | severity | action |
|---|---|---|
| **days 0-2** | *(none)* | already covered by the existing `alertAccountExhausted()` one-shot — not duplicated here |
| **days 3-6** | **warn** | once per calendar day, naming worker + day count |
| **day 7+** | **error** | once per calendar day, ALSO naming the worker's current `priority:` from config.yaml so a dead worker still at priority 1 is visible |

## Why `cmd:` and not an LLM skill

Age arithmetic and threshold comparisons are deterministic, and CLAUDE.md is
explicit that deterministic decisions belong in a committed script invoked by
absolute path, never LLM reasoning — the rule exists because LLM date arithmetic
silently killed a whole run of scheduled alerts.

## Two invariants

1. **The script never writes `~/.pa/config.yaml`.** It READS a worker's
   `priority:` only to name it in an escalated alert. It never reprioritises a
   dead worker — the alert RECOMMENDS recharging/reauthing or manually
   reprioritising; a human decides. Auto-editing hand-maintained intent is how
   priorities and their evidence comments get lost.
2. **Age lives in its own ledger** (`~/.pa/human-gated-blockers.json`), additive
   and separate, because `rate-limit-state.json`'s timestamps can't be trusted
   for duration. A currently-present blocker keeps its original
   `first_detected_at`; one that disappears is cleared (with a one-line resolved
   note if it had ever escalated).

## Operational notes

* **Per-calendar-day dedup.** Each tracked blocker carries `last_alerted_on`; an
  alert fires only if it hasn't already fired today, so the daily cron (and any
  catchup retries) escalate at most once per calendar day without fighting the
  unrelated per-dispatch alert's own dedup window.
* Prints `NO_OUTPUT` when there is nothing to escalate (including quiet day-0-2
  tracking) — mandatory, not cosmetic: empty stdout from a skill declaring
  `telegram_output` is a HARD FAILURE since 2026-07-21, so without the sentinel
  this watchdog would fail every quiet day and eventually be parked by the
  AI-098 failure-backoff ladder — i.e. the blocker watchdog would silently stop
  watching.
* **Honest limitation:** age tracking starts at first run, not retroactively. On
  first deployment a blocker that silently existed for days shows as day 0 — the
  script cannot know how long it was broken before it began watching.

## Manual use

```
python3 human_gated_blocker_watch.py || python human_gated_blocker_watch.py
python3 human_gated_blocker_watch.py --no-send --no-write || python human_gated_blocker_watch.py --no-send --no-write
```
