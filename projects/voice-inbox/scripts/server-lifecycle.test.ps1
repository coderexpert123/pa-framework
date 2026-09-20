# Test harness for server-lifecycle.psm1 / stop_server.ps1 (AI-254, 2026-09-17).
#
# No Pester on this machine - this is a self-contained assertion script in the
# same spirit ("a PowerShell test script that runs in CI-safe isolation").
# Every fixture is a throwaway Node HTTP listener on an ephemeral port under a
# per-run temp directory named so its command line contains "voice-inbox" and
# "dist/server.js" (Test-IsVoiceInboxServerProcess's own match criteria) -
# never the live server, never a real port.
#
# Usage: powershell -NoProfile -File scripts\server-lifecycle.test.ps1
# Exits 0 when every assertion passes, 1 otherwise (prints a PASS/FAIL line
# per assertion plus a final failure count).

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'server-lifecycle.psm1') -Force

$script:failures = 0
function Assert-True {
  param([bool]$Condition, [string]$Label)
  if ($Condition) { Write-Output "PASS: $Label" } else { Write-Output "FAIL: $Label"; $script:failures++ }
}

$work = Join-Path $env:TEMP ("voice-inbox-lifecycle-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path (Join-Path $work 'dist') | Out-Null
$serverJs = Join-Path $work 'dist\server.js'
@'
const http = require("http");
const port = Number(process.argv[2] || 0);
const server = http.createServer((req, res) => { res.end("ok"); });
server.listen(port, "127.0.0.1", () => {
  console.log("LISTENING " + server.address().port);
});
'@ | Set-Content -Path $serverJs -Encoding utf8

$nonMatchingJs = Join-Path $work 'plain.js'
@'
const http = require("http");
const port = Number(process.argv[2] || 0);
const server = http.createServer((req, res) => { res.end("ok"); });
server.listen(port, "127.0.0.1", () => {
  console.log("LISTENING " + server.address().port);
});
'@ | Set-Content -Path $nonMatchingJs -Encoding utf8

# Starts a throwaway node fixture, waits for it to report the port it bound,
# and returns @{ Pid; Port }. Never the live server, never a fixed/shared port.
function Start-Fixture {
  param([string]$ScriptPath)
  $outFile = Join-Path $work ("out-" + [guid]::NewGuid().ToString('N') + '.log')
  $proc = Start-Process -FilePath 'node' -ArgumentList "`"$ScriptPath`" 0" -WindowStyle Hidden -RedirectStandardOutput $outFile -PassThru
  # 25s, not 10s (2026-09-17 deep-recheck): this machine runs many concurrent
  # agent sessions, and even trivial node startups were observed missing a
  # 10s deadline under real contention (68% CPU average, ~48 node processes)
  # while this very pass was running - the same class of finding as the
  # production bind-confirm timeout below.
  $deadline = (Get-Date).AddSeconds(25)
  $port = 0
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $outFile) {
      $content = Get-Content $outFile -Raw -ErrorAction SilentlyContinue
      if ($content -match 'LISTENING (\d+)') { $port = [int]$Matches[1]; break }
    }
    Start-Sleep -Milliseconds 100
  }
  if ($port -eq 0) { throw "fixture $ScriptPath did not report a listening port within 25s" }
  return [pscustomobject]@{ Pid = $proc.Id; Port = $port }
}

# --- (d) BOM-prefixed lock parses ---------------------------------------
$bomLock = Join-Path $work 'bom.lock'
$bomBytes = [byte[]](0xEF, 0xBB, 0xBF) + [System.Text.Encoding]::UTF8.GetBytes('{"pid":4242,"ts":1000}')
[System.IO.File]::WriteAllBytes($bomLock, $bomBytes)
$parsedLock = Read-VoiceInboxServerLock -LockPath $bomLock
Assert-True ($parsedLock -and [int]$parsedLock.pid -eq 4242) "(d) BOM-prefixed server.lock parses"

# --- Get-VoiceInboxPort: env override wins -------------------------------
$prevPortEnv = $env:VOICE_INBOX_PORT
$env:VOICE_INBOX_PORT = '19191'
Assert-True ((Get-VoiceInboxPort) -eq 19191) "Get-VoiceInboxPort: VOICE_INBOX_PORT env wins over the file/default"
if ($null -eq $prevPortEnv) { Remove-Item Env:\VOICE_INBOX_PORT -ErrorAction SilentlyContinue } else { $env:VOICE_INBOX_PORT = $prevPortEnv }

# --- (c) a listener whose command line does NOT match voice-inbox is refused ---
$plainFixture = Start-Fixture $nonMatchingJs
$deadLock = Join-Path $work 'dead-for-c.lock'
Set-Content -Path $deadLock -Value '{"pid":999999,"ts":1}' -Encoding utf8 -NoNewline
$resultC = Invoke-VoiceInboxStopServer -Port $plainFixture.Port -LockPath $deadLock -ExpectedServerJsPath $serverJs
Assert-True (-not $resultC.Success) "(c) refuses a port listener whose command line does not match the voice-inbox server"
Assert-True ((Get-Process -Id $plainFixture.Pid -ErrorAction SilentlyContinue) -ne $null) "(c) the non-matching process is left untouched"
Stop-Process -Id $plainFixture.Pid -Force -ErrorAction SilentlyContinue

# --- (b) dead/stale lock + a real matching listener -> stops it ---------
$matchFixtureB = Start-Fixture $serverJs
$deadLockB = Join-Path $work 'dead-for-b.lock'
Set-Content -Path $deadLockB -Value '{"pid":999998,"ts":1}' -Encoding utf8 -NoNewline
$resultB = Invoke-VoiceInboxStopServer -Port $matchFixtureB.Port -LockPath $deadLockB -ExpectedServerJsPath $serverJs
Assert-True ($resultB.Success) "(b) stale/dead lock falls back to the verified port listener and stops it: $($resultB.Message)"
Assert-True ((Get-VoiceInboxPortListenerPid -Port $matchFixtureB.Port) -eq 0) "(b) port is free after the fallback stop"
Assert-True ((Get-Process -Id $matchFixtureB.Pid -ErrorAction SilentlyContinue) -eq $null) "(b) the matching process is actually gone"

# --- (a) known-bad proof: the ORIGINAL committed script gets stuck -------
# on a failed graceful stop, then (a) the fix escalates past it -----------
$shimDir = Join-Path $work 'shim'
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
@'
@echo off
echo %* | findstr /I /C:"/F" >nul
if %errorlevel%==0 (
  "%WINDIR%\System32\taskkill.exe" %*
) else (
  echo ERROR: simulated graceful-stop failure (test stub) 1>&2
  exit /b 1
)
'@ | Set-Content -Path (Join-Path $shimDir 'taskkill.cmd') -Encoding ascii
$savedPath = $env:PATH
$env:PATH = "$shimDir;$env:PATH"

# IMPORTANT: this must be the commit BEFORE the AI-254 fix (1928b8d^), not
# HEAD - HEAD already IS the fixed script (it imports server-lifecycle.psm1,
# which does not exist in $work, so testing HEAD here would fail at
# Import-Module before ever reaching the taskkill/EAP logic under test, and
# would report the SAME "still alive" result whether the real bug is present
# or fixed. Verified: this was the actual defect found in review 2026-09-17 -
# the committed version of this test used 'HEAD' and had never actually
# exercised the historical EAP=Stop+taskkill bug.
$originalScript = Join-Path $work 'stop_server.original.ps1'
git -C 'D:\Personal Assistant' show '1928b8d^:projects/voice-inbox/scripts/stop_server.ps1' |
  Out-File -FilePath $originalScript -Encoding utf8

$badFixture = Start-Fixture $serverJs
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$badOut = & powershell.exe -NoProfile -File $originalScript -ServerPid $badFixture.Pid 2>&1
$ErrorActionPreference = $prevEap
Start-Sleep -Milliseconds 500
$badStillAlive = (Get-Process -Id $badFixture.Pid -ErrorAction SilentlyContinue) -ne $null
$badStillListening = (Get-VoiceInboxPortListenerPid -Port $badFixture.Port) -ne 0
$badOutText = ($badOut -join ' | ')
Write-Output "  (known-bad run said: $badOutText)"
Assert-True ($badStillAlive -and $badStillListening) "(known-bad) the ORIGINAL stop_server.ps1 leaves the process running and the port held when the graceful stop fails"
# Guard against the exact failure mode above: the process staying alive must
# be because the graceful-stop escalation never ran (the real historical
# bug), not because the copied script errored out before reaching it for an
# unrelated reason (e.g. a missing dependency). The pre-fix script never
# imports a module, so its only expected output is the graceful-stop attempt
# line; anything about Import-Module or a NativeCommandError means the test
# fixture itself is broken, not that it proved the historical bug.
Assert-True (($badOutText -match 'attempting graceful stop') -and ($badOutText -notmatch 'Import-Module') -and ($badOutText -notmatch 'ModuleNotFound')) "(known-bad) the process stayed alive because the graceful-stop escalation genuinely stalled, not because the test fixture failed to run"
if ($badStillAlive) {
  $env:PATH = $savedPath  # drop the shim so a real /F can clean up the leftover fixture
  Stop-Process -Id $badFixture.Pid -Force -ErrorAction SilentlyContinue
  $env:PATH = "$shimDir;$env:PATH"
}

$goodFixture = Start-Fixture $serverJs
$resultA = Invoke-VoiceInboxStopServer -ServerPid $goodFixture.Pid -Port $goodFixture.Port
Assert-True ($resultA.Success) "(a) the fixed module escalates past a failed graceful stop: $($resultA.Message)"
Assert-True ((Get-VoiceInboxPortListenerPid -Port $goodFixture.Port) -eq 0) "(a) the port is free after the fixed stop"
Assert-True ((Get-Process -Id $goodFixture.Pid -ErrorAction SilentlyContinue) -eq $null) "(a) the process is actually gone"

$env:PATH = $savedPath

# --- (e)/(f)/(known-bad e2e): full run_server.ps1 relaunch, end to end -----
#
# Everything above tests server-lifecycle.psm1's functions directly. Nothing
# committed with the AI-254 fix exercised run_server.ps1 itself - the actual
# script the watchdog invokes, including its port-free precheck AND its own
# post-launch lock-write decision. These three blocks drive the REAL
# run_server.ps1 (not a copy) under full isolation: an ephemeral port via
# VOICE_INBOX_PORT, a per-run PA_HOME, and a throwaway -ProjectDir fixture -
# never the live server (port 8787, left completely alone throughout).

function Get-FreeEphemeralPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}

function Wait-Until {
  param([Parameter(Mandatory)][scriptblock]$Condition, [int]$TimeoutSeconds = 10, [int]$PollMs = 200)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (& $Condition) { return $true }
    Start-Sleep -Milliseconds $PollMs
  } while ((Get-Date) -lt $deadline)
  return (& $Condition)
}

# Runs run_server.ps1 and returns @{ ExitCode }. Deliberately does NOT use
# `-Wait`, and captures NO stdout/stderr (found live during this recheck,
# 2026-09-17, after THREE different invocation styles all hung on this exact
# scenario): run_server.ps1 launches a DETACHED, long-lived node.exe via
# Start-Process - and:
#   (1) `& powershell.exe ... 2>&1` plumbs the wrapper's streams through an
#       anonymous pipe; the detached node.exe grandchild inherits a handle
#       to that pipe via ordinary CreateProcess handle inheritance, so the
#       pipe never reaches EOF while the new server keeps running.
#   (2) `Start-Process -Wait -RedirectStandardOutput/-Error <file>` hits the
#       SAME inherited-pipe-handle problem even though the redirect target
#       is a file - Windows PowerShell 5.1 still plumbs it through a pipe
#       internally.
#   (3) `Start-Process -Wait` with NO redirection at all STILL hung: -Wait
#       is documented to track the launched process via a Job Object, and
#       blocks until every process ever associated with that job exits -
#       including the detached grandchild, which is the point of this
#       script and never exits on its own.
# All three were confirmed live: the process tree showed the old pid gone
# and a new pid bound to the port (the SUT logic had already succeeded)
# while the wrapper invocation itself sat hung with zero remaining children.
# The only invocation style that returns promptly is polling the SPECIFIC
# wrapper pid's own .HasExited - it queries that one process's exit status
# directly, independent of job objects or any inherited pipe handle. Every
# decision this test needs is already in watchdog.log, so there is no need
# to capture the wrapper's own stdout/stderr at all.
function Invoke-RunServerScript {
  param(
    [Parameter(Mandatory)][string]$ScriptPath,
    [Parameter(Mandatory)][string]$ProjectDir,
    [int]$TimeoutSeconds = 75   # comfortably above run_server.ps1's own worst-case internal budget (precheck + up to 45s bind-confirm + force-kill cleanup)
  )
  $p = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-File', "`"$ScriptPath`"", '-ProjectDir', "`"$ProjectDir`"") `
    -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while (-not $p.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
  if (-not $p.HasExited) { throw "run_server.ps1 wrapper (pid $($p.Id)) did not exit within ${TimeoutSeconds}s" }
  return [pscustomobject]@{ ExitCode = $p.ExitCode }
}

$realRunServer = Join-Path $PSScriptRoot 'run_server.ps1'

# A real, functioning fixture "app" (not a decoy) - reads its port from
# VOICE_INBOX_PORT exactly like run_server.ps1's own resolution, and logs
# every listen/error event (with its own pid) to a shared file so the test
# can tell an "old" instance apart from the "new" one run_server.ps1 spawns.
$e2eWork = Join-Path $work 'e2e'
New-Item -ItemType Directory -Force -Path (Join-Path $e2eWork 'fixtureA\dist') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $e2eWork 'fixtureB\dist') | Out-Null
$fixtureAServerJs = Join-Path $e2eWork 'fixtureA\dist\server.js'
$fixtureBServerJs = Join-Path $e2eWork 'fixtureB\dist\server.js'
@'
const http = require("http");
const fs = require("fs");
const port = Number(process.env.VOICE_INBOX_PORT || 8787);
const eventsLog = process.env.FIXTURE_EVENTS_LOG;
function logEvent(event) {
  if (!eventsLog) return;
  try { fs.appendFileSync(eventsLog, JSON.stringify({ pid: process.pid, port, event, ts: Date.now() }) + "\n"); } catch (e) {}
}
const server = http.createServer((req, res) => { res.end("ok"); });
server.listen(port, "127.0.0.1", () => { logEvent("listening"); });
server.on("error", (err) => { logEvent("error:" + err.code); process.exit(1); });
'@ | Set-Content -Path $fixtureAServerJs -Encoding utf8
Copy-Item -Path $fixtureAServerJs -Destination $fixtureBServerJs -Force

# --- (e) live stale listener -> run_server.ps1 stops it and relaunches -----
$portE = Get-FreeEphemeralPort
$paHomeE = Join-Path $e2eWork 'pa-home-e'
New-Item -ItemType Directory -Force -Path $paHomeE | Out-Null
$eventsLogE = Join-Path $e2eWork 'events-e.log'
$watchdogLogE = Join-Path $paHomeE 'voice-inbox\logs\watchdog.log'

# Start-Process on Windows PowerShell 5.1 has no -Environment parameter (only
# -UseNewEnvironment, which starts a BLANK env) - a spawned child inherits
# the CALLING process's environment by default, so the env vars the fixture
# needs must be set here first.
$env:VOICE_INBOX_PORT = "$portE"
$env:FIXTURE_EVENTS_LOG = $eventsLogE
$oldProc = Start-Process -FilePath 'node' -ArgumentList "`"$fixtureAServerJs`"" -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $e2eWork 'old-out.log') -RedirectStandardError (Join-Path $e2eWork 'old-err.log') `
  -PassThru
$oldBound = Wait-Until -TimeoutSeconds 25 -Condition { (Get-VoiceInboxPortListenerPid -Port $portE) -eq $oldProc.Id }
if (-not $oldBound) { throw "(e) setup: stale fixture never bound port $portE" }

$env:PA_HOME = $paHomeE
$resultE = Invoke-RunServerScript -ScriptPath $realRunServer -ProjectDir (Join-Path $e2eWork 'fixtureA')
$runExitE = $resultE.ExitCode

$oldGone = Wait-Until -TimeoutSeconds 25 -Condition { (Get-Process -Id $oldProc.Id -ErrorAction SilentlyContinue) -eq $null }
Assert-True $oldGone "(e) the stale listener pid is gone after run_server.ps1"
$newPidE = Wait-Until -TimeoutSeconds 50 -Condition { (Get-VoiceInboxPortListenerPid -Port $portE) -gt 0 -and (Get-VoiceInboxPortListenerPid -Port $portE) -ne $oldProc.Id }
$newOwnerE = Get-VoiceInboxPortListenerPid -Port $portE
Assert-True ($runExitE -eq 0) "(e) run_server.ps1 exits 0 on a successful relaunch (exit=$runExitE; see watchdog.log for detail)"
Assert-True $newPidE "(e) a NEW process now owns port $portE (was $($oldProc.Id), now $newOwnerE)"
$lockPathE = Join-Path $paHomeE 'voice-inbox\server.lock'
$lockE = if (Test-Path $lockPathE) { Read-VoiceInboxServerLock -LockPath $lockPathE } else { $null }
Assert-True ($lockE -and [int]$lockE.pid -eq $newOwnerE) "(e) server.lock holds the NEW pid ($newOwnerE), not the stale one"
$watchdogTextE = if (Test-Path $watchdogLogE) { Get-Content $watchdogLogE -Raw } else { '' }
Assert-True ($watchdogTextE -match 'stopping it before relaunch') "(e) watchdog.log records the stop-before-relaunch decision"
Assert-True ($watchdogTextE -match 'bound port .* - server.lock written') "(e) watchdog.log records the successful bind"
if ($newOwnerE -gt 0) { Stop-Process -Id $newOwnerE -Force -ErrorAction SilentlyContinue }
if (-not $oldGone) { Stop-Process -Id $oldProc.Id -Force -ErrorAction SilentlyContinue }

# --- (f) unfreeable port (non-matching listener) -> refuse, don't relaunch -
$portF = Get-FreeEphemeralPort
$paHomeF = Join-Path $e2eWork 'pa-home-f'
New-Item -ItemType Directory -Force -Path $paHomeF | Out-Null
$watchdogLogF = Join-Path $paHomeF 'voice-inbox\logs\watchdog.log'

$foreignFixture = Start-Fixture $nonMatchingJs   # note: Start-Fixture passes the port as argv, this fixture reads argv[2]
# Re-bind the foreign fixture onto our target port instead (argv-based, not env-based):
Stop-Process -Id $foreignFixture.Pid -Force -ErrorAction SilentlyContinue
Wait-Until -TimeoutSeconds 5 -Condition { (Get-Process -Id $foreignFixture.Pid -ErrorAction SilentlyContinue) -eq $null } | Out-Null
$foreignOut = Join-Path $e2eWork 'foreign-out.log'
$foreignProc = Start-Process -FilePath 'node' -ArgumentList "`"$nonMatchingJs`" $portF" -WindowStyle Hidden -RedirectStandardOutput $foreignOut -PassThru
$foreignBound = Wait-Until -TimeoutSeconds 25 -Condition { (Get-VoiceInboxPortListenerPid -Port $portF) -eq $foreignProc.Id }
if (-not $foreignBound) { throw "(f) setup: foreign fixture never bound port $portF" }

$env:PA_HOME = $paHomeF
$env:VOICE_INBOX_PORT = "$portF"
Remove-Item Env:\FIXTURE_EVENTS_LOG -ErrorAction SilentlyContinue
$resultF = Invoke-RunServerScript -ScriptPath $realRunServer -ProjectDir (Join-Path $e2eWork 'fixtureB')
$runExitF = $resultF.ExitCode

Assert-True ($runExitF -ne 0) "(f) run_server.ps1 exits non-zero when the port can't be freed"
Assert-True ((Get-VoiceInboxPortListenerPid -Port $portF) -eq $foreignProc.Id) "(f) the foreign listener is untouched (still owns the port)"
$lockPathF = Join-Path $paHomeF 'voice-inbox\server.lock'
$lockLeftDeadF = if (Test-Path $lockPathF) {
  $l = Read-VoiceInboxServerLock -LockPath $lockPathF
  (-not $l) -or (-not (Get-Process -Id ([int]$l.pid) -ErrorAction SilentlyContinue))
} else { $true }
Assert-True $lockLeftDeadF "(f) no server.lock was written pointing at a live-but-wrong or dead pid"
$watchdogTextF = if (Test-Path $watchdogLogF) { Get-Content $watchdogLogF -Raw } else { '' }
Assert-True ($watchdogTextF -match 'refusing to launch') "(f) watchdog.log records the refusal"
Stop-Process -Id $foreignProc.Id -Force -ErrorAction SilentlyContinue

# --- (known-bad e2e): the PRE-FIX run_server.ps1 fails silently -----------
# against the exact same live-stale-listener setup as (e). Proves this new
# e2e test can actually fail: the old script never stops the stale listener,
# launches straight into EADDRINUSE, and leaves the stale pid serving.
$portKB = Get-FreeEphemeralPort
$paHomeKB = Join-Path $e2eWork 'pa-home-kb'
New-Item -ItemType Directory -Force -Path $paHomeKB | Out-Null
$eventsLogKB = Join-Path $e2eWork 'events-kb.log'

$oldScriptKB = Join-Path $e2eWork 'run_server.prefix.ps1'
git -C 'D:\Personal Assistant' show '1928b8d^:projects/voice-inbox/scripts/run_server.ps1' |
  Out-File -FilePath $oldScriptKB -Encoding utf8

$env:VOICE_INBOX_PORT = "$portKB"
$env:FIXTURE_EVENTS_LOG = $eventsLogKB
$staleProcKB = Start-Process -FilePath 'node' -ArgumentList "`"$fixtureAServerJs`"" -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $e2eWork 'kb-old-out.log') -RedirectStandardError (Join-Path $e2eWork 'kb-old-err.log') `
  -PassThru
$staleBoundKB = Wait-Until -TimeoutSeconds 25 -Condition { (Get-VoiceInboxPortListenerPid -Port $portKB) -eq $staleProcKB.Id }
if (-not $staleBoundKB) { throw "(known-bad e2e) setup: stale fixture never bound port $portKB" }

$env:PA_HOME = $paHomeKB
$resultKB = Invoke-RunServerScript -ScriptPath $oldScriptKB -ProjectDir (Join-Path $e2eWork 'fixtureA')
Start-Sleep -Seconds 1   # give the crashing EADDRINUSE relaunch attempt time to fail

$staleStillAliveKB = (Get-Process -Id $staleProcKB.Id -ErrorAction SilentlyContinue) -ne $null
$staleStillOwnsPortKB = (Get-VoiceInboxPortListenerPid -Port $portKB) -eq $staleProcKB.Id
Write-Output "  (known-bad e2e run exit code: $($resultKB.ExitCode))"
Assert-True ($staleStillAliveKB -and $staleStillOwnsPortKB) "(known-bad e2e) the PRE-FIX run_server.ps1 never stops the stale listener - it stays alive and keeps the port"
$eventsTextKB = if (Test-Path $eventsLogKB) { Get-Content $eventsLogKB -Raw } else { '' }
Assert-True ($eventsTextKB -match 'error:EADDRINUSE') "(known-bad e2e) the pre-fix script's own relaunch attempt crashed into EADDRINUSE, exactly as the AI-254 root cause describes"
Stop-Process -Id $staleProcKB.Id -Force -ErrorAction SilentlyContinue

# --- (g) single-flight guard: two concurrent invocations don't race -------
# Added after a REAL collision during this recheck (2026-09-17): a manual
# recovery invocation and the next automatic 1-minute watchdog tick both
# launched a node process for the SAME production port within 15s of each
# other. Fires two run_server.ps1 invocations against the same fresh
# (no-stale-listener) port back-to-back with no wait between them, and
# proves the mutex added in response makes exactly one proceed.
$portG = Get-FreeEphemeralPort
$paHomeG = Join-Path $e2eWork 'pa-home-g'
New-Item -ItemType Directory -Force -Path $paHomeG | Out-Null
$watchdogLogG = Join-Path $paHomeG 'voice-inbox\logs\watchdog.log'

$env:PA_HOME = $paHomeG
$env:VOICE_INBOX_PORT = "$portG"
Remove-Item Env:\FIXTURE_EVENTS_LOG -ErrorAction SilentlyContinue
$g1 = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList @('-NoProfile', '-File', "`"$realRunServer`"", '-ProjectDir', "`"$(Join-Path $e2eWork 'fixtureA')`"") `
  -WindowStyle Hidden -PassThru
$g2 = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList @('-NoProfile', '-File', "`"$realRunServer`"", '-ProjectDir', "`"$(Join-Path $e2eWork 'fixtureA')`"") `
  -WindowStyle Hidden -PassThru

$bothDoneG = Wait-Until -TimeoutSeconds 75 -Condition { $g1.HasExited -and $g2.HasExited }
Assert-True $bothDoneG "(g) setup: both concurrent invocations exited within 75s"

$watchdogTextG = if (Test-Path $watchdogLogG) { Get-Content $watchdogLogG -Raw } else { '' }
$skippedCountG = ([regex]::Matches($watchdogTextG, 'already in flight for this port - skipping this tick')).Count
$boundCountG = ([regex]::Matches($watchdogTextG, 'server\.lock written')).Count
Assert-True ($skippedCountG -eq 1) "(g) exactly one of the two concurrent invocations self-skipped via the mutex (saw $skippedCountG)"
Assert-True ($boundCountG -eq 1) "(g) exactly one of the two concurrent invocations actually bound and wrote the lock (saw $boundCountG)"
$newOwnerG = Get-VoiceInboxPortListenerPid -Port $portG
Assert-True ($newOwnerG -gt 0) "(g) the port ended up owned by exactly one live process"
if ($newOwnerG -gt 0) { Stop-Process -Id $newOwnerG -Force -ErrorAction SilentlyContinue }

# --- (known-bad g): the PRE-MUTEX run_server.ps1 lets both race -----------
# Proves (g) can fail: replays the exact same two-concurrent-invocations
# setup against 2e72502 (this recheck's own pass-1 commit, the last version
# WITHOUT the mutex) and expects to see ZERO "skipping this tick" lines -
# both invocations proceed independently, exactly the collision observed
# live in production.
$portGKB = Get-FreeEphemeralPort
$paHomeGKB = Join-Path $e2eWork 'pa-home-gkb'
New-Item -ItemType Directory -Force -Path $paHomeGKB | Out-Null
$watchdogLogGKB = Join-Path $paHomeGKB 'voice-inbox\logs\watchdog.log'
$preMutexScript = Join-Path $e2eWork 'run_server.premutex.ps1'
git -C 'D:\Personal Assistant' show '2e72502:projects/voice-inbox/scripts/run_server.ps1' |
  Out-File -FilePath $preMutexScript -Encoding utf8

$env:PA_HOME = $paHomeGKB
$env:VOICE_INBOX_PORT = "$portGKB"
$gkb1 = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList @('-NoProfile', '-File', "`"$preMutexScript`"", '-ProjectDir', "`"$(Join-Path $e2eWork 'fixtureA')`"") `
  -WindowStyle Hidden -PassThru
$gkb2 = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList @('-NoProfile', '-File', "`"$preMutexScript`"", '-ProjectDir', "`"$(Join-Path $e2eWork 'fixtureA')`"") `
  -WindowStyle Hidden -PassThru
$bothDoneGKB = Wait-Until -TimeoutSeconds 75 -Condition { $gkb1.HasExited -and $gkb2.HasExited }
Assert-True $bothDoneGKB "(known-bad g) setup: both pre-mutex invocations exited within 75s"
$watchdogTextGKB = if (Test-Path $watchdogLogGKB) { Get-Content $watchdogLogGKB -Raw } else { '' }
$skippedCountGKB = ([regex]::Matches($watchdogTextGKB, 'skipping this tick')).Count
$watchdogOneLineGKB = $watchdogTextGKB -replace '\r?\n', ' | '
Write-Output "  (known-bad g watchdog.log: $watchdogOneLineGKB)"
Assert-True ($skippedCountGKB -eq 0) "(known-bad g) the PRE-MUTEX script has no single-flight guard - neither invocation skips itself"
$ownerGKB = Get-VoiceInboxPortListenerPid -Port $portGKB
if ($ownerGKB -gt 0) { Stop-Process -Id $ownerGKB -Force -ErrorAction SilentlyContinue }

Remove-Item Env:\PA_HOME -ErrorAction SilentlyContinue
Remove-Item Env:\VOICE_INBOX_PORT -ErrorAction SilentlyContinue
Remove-Item Env:\FIXTURE_EVENTS_LOG -ErrorAction SilentlyContinue

Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue

Write-Output "--- $script:failures failure(s) ---"
if ($script:failures -gt 0) { exit 1 }
exit 0
