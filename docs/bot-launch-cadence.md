# Telegram bot launch cadence

Auto-load pointer: `projects/telegram-bot/CLAUDE.md` links here. Extracted under the
brain-file size budget doctrine (`docs/CONVENTIONS.md`, "Brain-file organization") on
2026-09-10. Audience: anyone debugging why the bot did not restart after a crash, or
changing how often Task Scheduler checks it.

## Task Scheduler cadence

Task Scheduler runs the bot's launcher on a repeating schedule with
`-MultipleInstances Ignore`, so an already-running instance blocks a new one from
starting. A persistent HTTP 409 from Telegram (another process already polling the same
bot token) is resolved by rotating the token through BotFather, not by restarting the
process.

## PID-liveness gate

`run-bot-hidden.vbs` checks whether the process recorded in `telegram-bot.lock` is still
alive before it does anything else. The check reads the lock's PID through a hidden
`tasklist` pipeline, filtered on both PID and image name and piped through `find`,
described fully in the 2026-09-10 launch-cadence wave's design record, section S1.

That check runs before the 409-rotation block and before spawning node. A healthy
per-minute tick therefore costs one `tasklist` call rather than a full cold node launch —
the voice-inbox app's own launcher uses the same pattern.

Gotcha when testing the launcher by hand (found 2026-09-13): the gate's `find` resolves
through the inherited PATH. From a Claude/git-bash session, Git's `/usr/bin` shadows
System32, so `find /I` is GNU find, the pipeline exits 1, and the gate reads the live bot
as dead. Task Scheduler's own environment has the system PATH and is unaffected. To drive
the launcher from a dev shell, prefix the invocation with a cleaned PATH (System32 +
nodejs first).

The gate is pinned by `src/tests/launcher-vbs.test.ts`. That file is excluded from the
public mirror and skips gracefully when it is absent.

## Deploy-staleness watchdog

A live bot still serves the code it started with — Node does not hot-reload — so when the
liveness gate finds the bot ALIVE, the tick now also checks deployment freshness before
quitting. `scripts/build.mjs` writes `dist/BUILD_INFO` (`{"commit":"<full sha>","dirty":<bool>}`,
compact, best-effort — a write error only warns) as the last step of every successful build,
beside the existing `.build-stamp` whose mtime the in-process self-restart job compares.
`dirty` comes from `git status --porcelain -- projects/telegram-bot` and fails closed
(defaults true, cleared only by a zero-exit git call), so a broken git never arms the
watchdog.

On each alive tick the launcher reads BUILD_INFO and, only when it says `"dirty":false`
(exact compact substring — the VBScript has no JSON parser), runs one hidden PowerShell
probe comparing `dist/main.js`'s mtime against the bot process's start time, both as UTC.
The probe writes its verdict to a temp file — 0 = stale deploy, 1 = fresh, 2 = probe
error — and the launcher polls for it, giving up after 20 seconds; a wedged probe is
additionally self-terminated by an in-process 15s timer so no orphan accumulates.
Verdict 0 = stale deploy: the launcher appends a timestamped decision line to
`~/.pa/logs/telegram-bot.log` and runs `pa bot restart` — the graceful sentinel path; the
bot finishes in-flight work, exits, and the next tick relaunches it on the new dist.
Verdict 1 = fresh (the normal tick). Verdict 2, a spawn failure, or no verdict within the
deadline = logged, no restart.

Starvation incident (fixed 2026-09-13): the original launcher awaited the node it spawned
(`WshShell.Run …, 0, True`), so a launcher instance lived exactly as long as the bot it
had started. With the task's IgnoreNew policy, every later tick was then refused
(0x800710E0 — "instance refused/already running") and the liveness gate plus this
watchdog never executed at all in production, however correct the script on disk was.
The node launch is now unawaited — the launcher always terminates promptly (sub-second
on the launch path, at most ~20s on an alive tick) — and awaiting a child is allowed
only for the sub-second tasklist gate. Both properties are pinned by the launcher tests.

Fail-safe direction, pinned by the tests: a dirty build (mid-wave tree), a missing or
unparsable stamp, or any probe failure (including a probe that never returns a verdict)
never restarts — worst case is the old launch-only behavior. This watchdog never
force-kills the bot (contrast the catchup watchdog, which may kill its own proven-wedged
loop).
