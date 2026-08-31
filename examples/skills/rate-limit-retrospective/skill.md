---
cron: "0 * * * *"
cost_tier: off_peak
on_missed: latest
cwd: "${PA_HOME}/skills/rate-limit-retrospective"
cmd: "python rate_limit_digest.py"
timeout: 120
secrets:
  - TELEGRAM_BOT_TOKEN
  - TELEGRAM_CHAT_ID
telegram_output:
  chat_id: '${TELEGRAM_CHAT_ID}'
  thread_id: 0
  token_secret: TELEGRAM_BOT_TOKEN
---

Deterministic hourly digest of `<PA_HOME>/rate-limit-unparseable.jsonl`
(no LLM). The script prints `NO_OUTPUT` when nothing new has landed since the
last run, which `run.ts`'s NO_OUTPUT sentinel suppresses; otherwise it prints a
grouped report under 1500 chars.

Why this is `cmd:` and not a gemini skill any more — three verified defects in
the 2026-07-16..21 audit window, all structural rather than promptable:

1. **Sandbox blindness.** The LLM worker's shim `cd`s to the repo root
   and sandboxes its file tools to that tree, so the worker could not read
   a file under `~/.pa` at all: 9 runs failed the read outright and 7 delivered
   raw sandbox-error text to the user as if it were content. A plain Python
   process has no sandbox, so the widening (per-worker directory flags)
   is not needed here — the sandbox is gone entirely.
2. **LLM arithmetic.** "Entries within the last 65 minutes" was evaluated by the
   model and triple-reported the window's single real event. "Have I already
   reported this line?" is a cursor, not a time window:
   `~/.pa/rate-limit-retrospective-cursor.json` stores a line index, so every
   entry is reported exactly once regardless of run cadence or clock drift.
   A shorter file than the cursor means rotation → replay everything, loudly.
3. **Cost.** 100+ LLM runs for ONE real input line. The
   input file has accumulated 10 lines total since 2026-05. Grouping, counting
   and cause classification are all deterministic, so the LLM is now invoked on
   zero runs instead of all of them.

The one thing lost is a free-form "hypothesis" sentence; `HYPOTHESES` in the
script is an ordered pattern table instead, and anything it does not recognise
is labelled **NOVEL — no known pattern; file as a backlog item**, which is
exactly the case that warrants a human look.

Adoption note: on the very first run (no cursor file yet) only entries from the
last 24 hours are reported, so the backlog of historical lines is absorbed
silently while the cursor advances past all of it.
