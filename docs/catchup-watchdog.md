# Catchup watchdog: lane progress, bounded store queues and restarts

`pa catchup --loop` is the long-lived process that runs scheduled skills and declared maintenance jobs. This page explains how a stuck loop is detected, restarted and reported. Read it before changing `pa/src/commands/catchup.ts`, the watchdog generators in `pa/src/scheduler.ts`, or `pa/src/lib/stall.ts`.

## What can go wrong

The loop drives three lanes from one timer. The `default` and `reminders` lanes dispatch skills, and the `maintenance` lane runs the declared jobs. Each lane skips its tick while its previous tick is still running, so a slow lane never delays another. The same independence lets one lane stop making progress while the process, its timer and its heartbeat all look healthy.

## Lane progress files

Every lane writes a one-line breadcrumb to `~/.pa/catchup-lanes/<lane>` at each checkpoint of its tick. The file's modification time is the time of the last checkpoint. Its content is an ISO time, the lane, the phase and an optional detail, separated by the pipe character. The writes are synchronous, so they keep working when asynchronous file I/O inside the process is stuck.

| Phase | Written | When |
|---|---|---|
| `loop-start` | by the loop | once per lane at startup |
| `tick-start`, `tick-end` | by the loop | around every lane tick; a tick skipped while in flight writes nothing |
| `lock-acquired` | by a lane tick | after the lane's own blackboard lock is held |
| `overdue-scan`, `dispatch-loop` | by the skill lanes | before reading overdue skills; before each dispatch decision |
| `awaiting-concurrency-slot` | by the skill lanes | on every 5-second poll of the worker-slot wait |
| `skill-dispatch` | by the skill lanes | when a skill is handed off |
| `maintenance`, `job-decision` | by the maintenance lane | before the pass; before each job's run-or-skip write |
| `drill-wedge` | by the loop | when an operator drill wedges the lane |

A healthy loop keeps every lane file younger than one tick interval. A slow but working tick still writes a checkpoint every few tens of seconds, well inside the staleness threshold.

## The per-minute launcher

The operating system runs a small launcher every minute: a hidden VBScript under Windows Task Scheduler, or a generated shell script under cron. Only `pa schedules sync` writes it; a build never does. `pa schedules list` prints whether the launcher on disk matches the current build.

| The launcher finds | It does |
|---|---|
| No live `node` process holding the PID in `~/.pa/catchup-loop.lock` | Starts `pa catchup --loop` without waiting for it |
| A live PID whose heartbeat and lane files are all fresher than `PA_CATCHUP_LOOP_HEARTBEAT_STALE_MS` | Nothing |
| A live PID whose heartbeat or any lane file is older than that threshold, running the catchup loop's command line | Appends kill evidence, kills that PID only, waits for it to exit, starts a new loop and pages |
| The same stale files, but the PID now belongs to another process | Appends evidence, starts a new loop, kills nothing and pages once under its own key |
| A dead PID and the loop's store-stall marker | Starts a new loop and pages |

Before any kill the launcher reads the process's command line, so a process that merely reused the loop's old PID is never killed. After a kill the launcher waits for the process to exit before it starts a new loop, because a process with unfinished disk writes stays alive until they complete. It checks every 2 seconds, for up to `PA_CATCHUP_KILL_EXIT_WAIT_S` seconds (120 by default). If the process is still running after that, the launcher starts a new loop anyway and says so on the page.

The wait keeps the launcher running, so Windows skips the next trigger; under cron a second run can overlap, and its extra launch exits on the loop's lock. The launch is never awaited. An awaited launch keeps the launcher running for the loop's whole life, and the task's one-instance policy then refuses every later trigger. The only awaited children are the sub-second `tasklist` liveness check and the `taskkill` of a proven-stuck PID.

While a killed loop waits to exit, it still holds the files it had open. Other sessions writing those stores, such as `~/.pa/reservations.json`, can see `EPERM` for up to that wait. Those failures clear once the old loop exits, so retry them rather than treating the store as corrupt.

## Bounded store queues and the stall exit

The in-process queues in `pa/src/lib` all go through `withBoundedQueue` in `lib/stall.ts`. They cover the log appender, the maintenance ledger, archive rotation, reservations, topic tasks, watch jobs, the agent bus and worker rate-limit state. A caller waits for its predecessor only while that predecessor's operation has run for less than `PA_STORE_WAIT_MAX_MS`, which defaults to 180 seconds. Past that bound the caller detaches and proceeds, and a stall record is appended synchronously to `~/.pa/stall-records.jsonl`. The stuck operation is never cancelled and never awaited again.

The catchup loop listens for stall records. On the first one it writes the marker `~/.pa/catchup-loop.stalled`, releases its lock, removes its PID file, flushes the log for at most five seconds and exits with code 4. The launcher starts a new loop within a minute and pages. Other processes record the stall and carry on.

## Three different stops

| Condition | Detected by | Response |
|---|---|---|
| A maintenance pass runs past `PA_CATCHUP_BUDGET_MS` | the maintenance lane's wall-clock budget | Abandon the pass, release the lane lock, keep the process |
| A store queue predecessor runs past `PA_STORE_WAIT_MAX_MS` | `lib/stall.ts` inside the process | Exit with code 4 for relaunch |
| The heartbeat or a lane file goes stale | the per-minute launcher, outside the process | Kill the PID and relaunch |

A skill-lane tick that runs past `PA_CATCHUP_BUDGET_MS` still exits with code 3, as before. The in-process bound is shorter than the launcher threshold. A process that can still see its own stall therefore exits before the launcher has to kill it.

## Paging and evidence

The launcher pages through a fresh `pa notify` process with the subject `Catchup loop restarted` and the dedup key `catchup-loop-stalled`. The body names only the cause, for example `lane reminders stale at skill-dispatch: reminders`. Because it carries no ages or process IDs, a repeating cause escalates its dedup window instead of paging on every restart. Restarts are never capped.

A process that exits too slowly adds `killed catchup loop did not exit within 120 s; relaunched anyway - a stale write may land` to the cause, with the configured number of seconds. A PID file that names another process means the loop died without its clean shutdown, which removes that file. The launcher then appends a `pid-reused` record, starts a new loop and pages once at warning severity under `catchup-loop-pid-reused`. That page's cause is `catchup loop was not running (recorded PID now belongs to another process); relaunched`. A loop that stops at its lifetime cap leaves no PID file and pages nothing.

Every minute the `staleness-check` job moves `~/.pa/stall-records.jsonl` into `~/.pa/archive/`. It writes one error line per record to the application log, each with a ref-id. The `archive-prune` job deletes archived stall-record shards after 90 days.

## Worst-case delay for a due reminder

Reminders ride the loop's `reminders` lane. If that lane gets stuck, a reminder that falls due is sent after at most the staleness threshold, plus one launcher period, plus the relaunch time. With the defaults that is 300 plus 60 seconds plus a relaunch that normally takes a few seconds, about six minutes. The operator drill allows 60 seconds for the relaunch, a bound of seven minutes.

The reminder stays in `~/.pa/reminders.json` until a processor claims it under the store's lock file, so it is neither lost nor sent twice. A killed loop that does not exit promptly adds up to `PA_CATCHUP_KILL_EXIT_WAIT_S` seconds, 120 by default, before the new loop starts.

## Operator drill

Writing a lane name to `~/.pa/catchup-drill-wedge` wedges that lane once. On its next tick the loop deletes the file, stamps the lane with `drill-wedge`, and leaves that lane in flight. The launcher should then kill and relaunch the loop, page once, and append a `launcher` record to the stall log. A drill abandons any skill that is mid-run, so run it when none is.

## Retiring the legacy reminders task

Older installs register a second per-minute task, `PA-Catchup-Reminders`, which runs `pa catchup --topic reminders` as a one-shot process. `pa schedules sync` never removes it. Retire it in the order below and keep every step reversible until the last.

| Step | Proof before the next step | Rollback |
|---|---|---|
| 1. Sync the new launcher and restart the loop | lane files advance and the task reports a result of 0 every minute | none needed; the legacy task still delivers |
| 2. Disable the legacy task | a test reminder is delivered exactly once by the loop alone | re-enable the task |
| 3. Run the operator drill with a test reminder due during the wedge | the reminder is delivered once, within seven minutes of falling due | re-enable the task |
| 4. Soak for at least 72 hours | real reminders are delivered once each and none is left past due | re-enable the task |
| 5. Export the task definition, then delete the task and its launcher | the task no longer exists | re-register it from the exported definition |

On Windows, disable with `schtasks /change /tn "PA-Catchup-Reminders" /disable` and roll back with `/enable` in place of `/disable`. On macOS and Linux, comment out the line under the `PA-Catchup-Reminders` sentinel with `crontab -e`, and uncomment it to roll back.

## Knobs

| Variable | Default | Effect |
|---|---|---|
| `PA_CATCHUP_LOOP_HEARTBEAT_STALE_MS` | `300000` | Staleness threshold for the heartbeat and every lane file, baked into the launcher at sync time |
| `PA_STORE_WAIT_MAX_MS` | `180000` | How long a queued caller waits on a predecessor's running operation before detaching |
| `PA_CATCHUP_KILL_EXIT_WAIT_S` | `120` | Seconds the launcher waits for a killed loop to exit before starting a new one anyway; read on every launcher run from the launcher's own environment; whole seconds 1 to 9999 |
| `PA_CATCHUP_LOOP_INTERVAL_MS` | `60000` | Lane tick cadence |
| `PA_CATCHUP_BUDGET_MS` | `900000` | Wall-clock budget for one maintenance pass or one-shot run |
