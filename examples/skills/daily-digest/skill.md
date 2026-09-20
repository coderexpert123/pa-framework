---
name: daily-digest
description: Daily activity digest — runs, tokens, est. cost, failover, alerts, DLQ and SLO for the last 24h
cron: "15 16 * * *"
cwd: "${PA_FRAMEWORK_ROOT}"
cmd: python3 "${PA_FRAMEWORK_ROOT}/pa/scripts/daily_digest.py" || python "${PA_FRAMEWORK_ROOT}/pa/scripts/daily_digest.py"
timeout: 300
telegram_output:
  chat_id: '${TELEGRAM_CHAT_ID}'
  thread_id: 0
  token_secret: TELEGRAM_BOT_TOKEN
trigger_description: >-
  Scheduled daily (21:45 IST). Also trigger manually when the user asks what the
  assistant did today or in the last day.
---

You are the daily-digest skill — a deterministic cmd-based skill that composes a
daily activity digest. The daily_digest.py script does all the work: it reads the
last 24h of run logs, cost rollup, failover events, DLQ entries, alert census,
self-improver audit, and SLO report, then sends a markdown digest to pa-alerts.

You do NOT need to compose any output or make any decisions. The script handles
everything deterministically. Just run it and relay its stdout to Telegram.

## What this skill demonstrates

- **Deterministic cmd skill pattern** — Pure Python script with no LLM worker.
  All logic lives in `daily_digest.py` (stdlib-only, no yaml, no external deps).
  The skill just runs the script and relays stdout via `telegram_output`.

- **Stdout relay via `telegram_output`** — The script prints markdown to stdout;
  the pa runner captures it and sends to Telegram with `TELEGRAM_BOT_TOKEN`.
  The script NEVER imports `telegram_notify` (a 2026-08-17 failure class).

- **Dedup key pattern** — Script ends with `_Dedup: daily-digest-<IST date>_`
  footer. The pa runner hashes this and suppresses duplicate posts within the day.
  Manual re-runs are suppressed; automated cron posts once daily.

- **Injectable-runner testability** — Every subprocess call (`pa costs --day
  --json`, `pa slo report --json`) goes through a `runner=` argument (default:
  real subprocess). Tests inject a fake runner that return canned JSON without
  spawning pa, making the test hermetic and fast.

- **Explicit unavailable sections** — When a data source is missing/failed, the
  digest renders an explicit "_unavailable (`<cmd>`) failed_" line instead of
  silence. Operators can distinguish "zero data" from "source broken" at a glance.
