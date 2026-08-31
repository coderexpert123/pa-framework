---
cron: "0 4 * * *"
cost_tier: off_peak
on_missed: latest
cwd: "${PA_HOME}/skills/worker-capability-watch"
secrets:
  - TELEGRAM_BOT_TOKEN
  - TELEGRAM_CHAT_ID
cmd: "python worker_capability_scan.py"
# Worst-case sequential probing across today's 5 workers: 5 x (90s --version +
# 90s --help) + one 150s subcommand probe (agy models) = 5*180 + 150 = 1050s.
# 1200s left only ~12.5% headroom against a script whose own comments already
# document real >60s CLI hangs. 1800s keeps ~40% headroom at 5 workers.
# RE-CHECK THE ARITHMETIC before adding a 6th worker: +180s worst case per
# worker (or +150-270s more if it also needs a subcommand value source).
timeout: 1800
telegram_output:
  chat_id: '${TELEGRAM_CHAT_ID}'
  thread_id: 0
  token_secret: TELEGRAM_BOT_TOKEN
trigger_description: Watchdog - runs every worker CLI's --version/--help daily and
  diffs the real flags against what ~/.pa/config.yaml declares; pages Telegram when
  config declares a flag the CLI does not have.
---

Deterministic daily drift watchdog for the worker-tunables surface (no LLM, no
gemini spawn). Runs at 04:00 UTC (09:30 IST).

## What it guards

`~/.pa/config.yaml` declares, per worker, which knobs exist — `tunables.<name>.args`
is an ARG TEMPLATE — and the Telegram bot exposes `/llm` and `/effort` against
those declarations. The whole design rests on config accurately describing what
each CLI actually accepts, and when it does not the failure is nasty: **a flag a
CLI does not have fails EVERY dispatch to that worker and presents as an outage,
not as a settings error.** Four real drifts landed inside a few days:

* the scaffolded `agy` worker declared `--yolo` and `--output-format`; agy has
  NEITHER, so a fresh `pa init` produced a worker that could not run at all —
  and nothing asserted it, so it went unnoticed;
* agy's `state_pattern` was `*.pb` while the directory holds only `*.db`;
* agy self-updated 1.0.13 → 1.1.5 mid-session and its model moved Gemini 3.5
  Flash → 3.6 Flash;
* a written brief asserted claude/zclaude have no `--effort` flag. They do. Only
  reading `--help` caught it.

These keep changing, so the primary job is **drift detection**; refreshing the
value catalogue is the by-product.

## Why `cmd:` and not an LLM skill

Diffing flag lists is deterministic, and CLAUDE.md is explicit that
deterministic decisions belong in a committed script invoked by absolute path,
never in LLM reasoning — the rule exists because LLM date arithmetic once
silently killed a whole run of scheduled alerts. There is a second reason specific
to this skill: **a script cannot hallucinate a flag into existence.** An LLM asked
"does agy accept `--yolo`?" will happily answer from priors; the script can only
report what `--help` printed.

## Classification

| | meaning | action |
|---|---|---|
| **BREAKING** | a flag declared in a worker's `args:` or in any tunable's `args:` template appears nowhere in `--help` | pages **Telegram** with a ref ID |
| **INFO** | CLI version changed, new flags appeared, or the CLI offers values config does not list | reported here, never paged |

A CLI that will not answer `--help` is **INFO (`probe-failed`), never BREAKING** —
an unverifiable worker is a different problem from one that lost a flag, and
conflating them would page on every transient hang.

## Two invariants

1. **The script never writes `~/.pa/config.yaml`.** config.yaml is hand-maintained
   human INTENT — its comments carry live-verified evidence, `supersedes:`
   relationships, and why-not rationale. The script writes
   `~/.pa/worker-capabilities.json` instead: OBSERVED REALITY, additive, merged
   with config only at display time (the bot already merges declared + observed).
   A cron job that silently rewrites a hand-edited config is how intent gets lost.
2. **A declared flag is never auto-removed.** Detecting that one vanished is a
   PAGE, not a fix: auto-removal would silently disable a setting the user
   depends on and turn a loud, diagnosable outage into a quiet behaviour change.

## Operational notes

* **Hard per-CLI timeout with process-tree kill.** One hung CLI must not stall
  the run. `subprocess.run(timeout=)` kills only the `cmd /c` wrapper and orphans
  the real grandchild, which busy-spins a core forever (2026-07-20: six orphans,
  six cores), so every call is `taskkill /F /T` / `killpg`-ed. `agy --version`
  was observed hanging past 60s on 2026-07-22, so this is not theoretical.
* **`agy models` is invoked through PowerShell.** It HANGS FOREVER from Git Bash
  (242s, rc=124, zero bytes on both stdout and stderr) but answers in 13-27s from
  PowerShell — verified 2026-07-22. It is not a TTY gate:
  `Console.IsOutputRedirected` was True in the working case. A non-response is a
  soft failure, never a wedge.
* Every subprocess call site passes `encoding="utf-8", errors="replace"`; without
  it Windows decodes help text with cp1252 and one box-drawing byte or emoji
  raises mid-read (the 2026-07-12 silent-empty-scan regression).
* The script prints `NO_OUTPUT` when nothing drifted, which `run.ts`'s sentinel
  suppresses. That is mandatory, not cosmetic: empty stdout from a skill
  declaring `telegram_output` is a HARD FAILURE since 2026-07-21, so without the
  sentinel this watchdog would fail every quiet day and eventually be parked by
  the AI-098 failure-backoff ladder — i.e. the drift watchdog would silently stop
  watching.
* First run records a baseline silently: with no cache yet, the cache-relative
  checks (version changed, new flag appeared) emit nothing.

## Manual use

```
python worker_capability_scan.py
python worker_capability_scan.py --worker agy --json --no-write --no-send
```

Live verification 2026-07-22: full scan of all five workers in 13.6s → `NO_OUTPUT`
(config and reality agree). A synthetic config re-declaring the historical
`--yolo` / `--output-format` on the real agy CLI produced both BREAKING findings
plus the `effort` new-value INFO.
