# Voice-inbox server lifecycle (watchdog, stop, build-staleness)

Split out of `docs/voice-inbox-operations.md` under the brain-file size budget
doctrine (`docs/CONVENTIONS.md`, "Brain-file organization") on 2026-09-17. This
file covers how the voice-inbox HTTP server's `server.lock` watchdog launches
and relaunches the process, how it is stopped, and how it detects a stale
build; the parent file keeps edge-relay launch cadence and the request/
response and answer-formatting contracts.

## Server watchdog (`server.lock`)

The voice-inbox HTTP server used to have no watchdog at all. After a reboot it stayed
dead until someone started it by hand.

`scripts/run_server.ps1` writes `server.lock` (`~/.pa/voice-inbox/server.lock`) itself,
rather than the app registering its own PID after it starts. The file is JSON,
`{"pid": <n>, "ts": <ms>}`, the same shape as the relay poller's own
`relay-poller.lock`.

**Not written immediately after `Start-Process` returns.** That was the original design.
The AI-254 incidents below are exactly why it changed. The launcher now polls for up to
45 seconds for the new process to actually own the port before writing the lock, and
logs the outcome either way to `watchdog.log`.

A prior version wrote the lock the instant `Start-Process` returned. That let a process
which then died immediately (EADDRINUSE, a startup exception, a corrupt build) leave the
lock pointing at a dead pid with no trace anywhere — the 2026-09-17 outages below.

45 seconds is not a guess. An initial 15-second bind-confirm timeout was verified clean
against isolated test fixtures, landed, and immediately killed the real production
launch twice in the field before it could bind. A directly-timed invocation against the
real port took 24.5 seconds — an interactive `node dist/server.js` from a shell bound in
~2s. The gap is specific to the `Start-Process`-launched, detached path and was not
root-caused.

If this trips again, that observation belongs in `run_server.ps1`'s own header comment
before the number is raised further. Check `watchdog.log` first — it now says *why* a
launch failed instead of nothing.

A **single-flight mutex** (`Global\VoiceInboxRunServer_<md5 of PA_HOME+port>`) guards the
whole script. The watchdog fires every 1 minute, and this launch's own worst case
(precheck, up to 45s bind-confirm, force-kill cleanup) can approach that interval. A
second concurrent invocation could otherwise launch its own competing node process for
the same port. A losing invocation logs "already in flight for this port - skipping this
tick" and exits 0 without touching anything. This was not theoretical: it reproduced live
during the same 2026-09-17 incident (a manual recovery invocation and the next automatic
tick both launched a node process for the same port ~15s apart).

`scripts/run-server-hidden.vbs` reads that PID and checks it is still alive (the
2026-09-10 launch-cadence wave's PID-liveness gate) before spawning a new node process.
A live PID skips the spawn entirely, so a healthy per-minute tick costs one `tasklist`
call, not a cold node launch. The scheduled task `PA-VoiceInbox-Server` runs on a
1-minute cadence, the same family as `PA-VoiceInbox-RelayPoller`. The Telegram bot's own
launcher uses the same gate pattern.

## Stopping the server (and the 2026-09-11 stale-server incident)

Do not stop this process with a plain `taskkill /PID <pid>`. Use
`scripts/stop_server.ps1` (reads the pid from `server.lock` when called with no
argument), which tries the graceful stop first and automatically escalates to a force
stop if the graceful one does not clear the pid within a few seconds. Equivalently,
`Stop-Process -Id <pid> -Force` or PowerShell's `(Get-Process -Id <pid>).Kill()`.

Why this matters: on 2026-09-11 a session tried to pick up newly-built push-notification
code by stopping the running server with plain `taskkill /PID 33064`. Windows returned
`ERROR: The process with PID 33064 could not be terminated. Reason: Access is denied.`
That reads like a real permission problem but was not one — the same non-elevated user
force-stopped the identical pid a short while later without any issue
(`Stop-Process`/`.Kill()`, which call `TerminateProcess` directly, rather than taskkill's
default non-forceful path). Two direct reproduction attempts against freshly-launched
windowless node processes (matching this server's `Start-Process -WindowStyle Hidden`
shape, including one launched through the exact same wscript→powershell→node chain
Task Scheduler uses) both had the graceful `taskkill` succeed, so headlessness alone
does not reliably reproduce the failure on demand — Windows Defender's operational log
showed no scan or detection event in the failure window either. The precise trigger for
that specific attempt's graceful-path failure was not pinned down, but it does not need
to be: the fix does not depend on knowing why the graceful path can fail, only on never
getting stuck on it. Because the standing watchdog only relaunches a *dead* pid and never
retries a stalled stop, that one non-forceful failure was enough to leave yesterday's
build silently serving for the rest of the day. `scripts/stop_server.ps1` is what closes
that gap — see its header comment for the full mechanism.

## Watchdog build-staleness self-heal (added 2026-09-11, same incident)

Liveness alone cannot detect that a *running* process is serving a stale build — that is
exactly what let the 2026-09-11 incident above persist silently for ~24h once the manual
stop attempt failed. `run-server-hidden.vbs` now also compares `dist/.build-stamp`'s
mtime (written by `scripts/build.mjs` on every successful compile — the same convention
the telegram bot's `src/self-restart.ts` already uses to detect its own staleness)
against `server.lock`'s own mtime (which is the moment the new process was CONFIRMED to
have bound the port — see above — not the moment `Start-Process` returned). If
the build stamp is newer than the lock by more than a 60-second grace period, the
watchdog force-stops the stale pid, logs one line to
`~/.pa/voice-inbox/logs/watchdog.log`, and falls through to the normal relaunch — no
epoch/timezone math needed, since both timestamps come from the same local-clock
`FileSystemObject.DateLastModified` API. A missing lock or missing build stamp is never
treated as stale, so a fresh checkout with no build yet cannot block the ordinary
liveness path. Check `watchdog.log` first when investigating anything that looks like
stale-code behavior — it will show whether the watchdog already self-healed before you
started looking.
