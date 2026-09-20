# Detached voice-inbox server launcher (AI-201 WP-B).
#
# Machine rule: a detached launcher's failure lands in .err — Start-Process
# with -WindowStyle Hidden and BOTH .log and .err redirects; verify liveness
# via the log files, never via this script's exit code.
#
# Usage:  powershell -File scripts\run_server.ps1 [-ProjectDir <dir>] [-LogDir <dir>]
#
# Logs default to <PA_HOME>\voice-inbox\logs (runtime state lives under
# ~/.pa, never the repo tree).
#
# Lock file (2026-09-10 launch-cadence wave, orchestrator amendment: the
# server previously had no watchdog at all — after a reboot it stayed dead
# until started by hand). Narrowest lock that matches the relay poller's own
# shape (relay_poller.mjs writeLock): <PA_HOME>\voice-inbox\server.lock, JSON
# `{"pid":<n>,"ts":<ms>}` — no self-registration inside the app: Start-Process
# hands back the real OS pid immediately, before node has read a single byte
# off disk, so writing it here is both simpler and race-free compared to
# waiting for the server to register itself once it is up.
#
# Port-free precheck (AI-254, 2026-09-17): this script used to write the lock
# and launch unconditionally, even when the port was still held by a server
# from a previous launch that a watchdog force-stop had failed to actually
# clear. The new process then died immediately with EADDRINUSE, but the lock
# already named its (now-dead) pid, so the next watchdog tick saw a dead pid
# and silently relaunched again - forever, with no log line anywhere, while
# the real old server kept serving stale code (the 2026-09-17 00:10-11:14
# outage). This script is invoked hidden and unwaited by run-server-hidden.vbs
# (no stdout/stderr capture at all), so its own decisions are logged straight
# into watchdog.log - the one file every caller already watches - not just
# written to a console nobody sees.
#
# Post-launch bind confirmation (AI-254 deep-recheck pass 2, 2026-09-17): the
# precheck above only prevents ONE trigger for the original bug (a stale
# server still holding the port). Node can still exit immediately for any
# OTHER reason after Start-Process returns (a startup exception, a missing
# module, a corrupt build) - writing the lock unconditionally right after
# Start-Process, with no confirmation the new process actually bound the
# port, is the SAME defect class via a different trigger. The launch below
# now polls (bounded) for the new pid to own the port before writing
# server.lock, and always logs the outcome either way.
#
# The bound was live-tuned, not guessed: an initial 15s timeout was verified
# clean against isolated test fixtures, then landed and IMMEDIATELY caused a
# real outage the same day - a manually-timed direct invocation of this exact
# script against the real production port took 24.5s to bind (interactive
# `node dist/server.js` from a shell bound in ~2s; the difference is specific
# to the Start-Process-launched, detached path and was not root-caused before
# the incident needed stopping - see the deep-recheck report for the leading
# theory). 45s gives comfortable headroom above the worst observed value;
# if this still trips in the field, that observation belongs in this comment
# before the number is raised again.

param(
  [string]$ProjectDir = (Join-Path $PSScriptRoot '..'),
  [string]$LogDir = ''
)

$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'server-lifecycle.psm1') -Force

$paHome = if ($env:PA_HOME) { $env:PA_HOME } else { Join-Path $env:USERPROFILE '.pa' }
$port = Get-VoiceInboxPort

if (-not $LogDir) {
  $LogDir = Join-Path $paHome 'voice-inbox\logs'
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$watchdogLogPath = Join-Path $LogDir 'watchdog.log'
function Write-RunServerLog([string]$Message) {
  try { Add-Content -Path $watchdogLogPath -Value ("$(Get-Date) $Message") -Encoding utf8 } catch { }
}

# Single-flight guard (deep-recheck pass 2, 2026-09-17, added after a REAL
# collision): the watchdog fires every 1 minute (PT1M), and a single
# invocation's own worst case (precheck + up to 45s bind-confirm + force-kill
# cleanup) can now approach that interval. Observed live during this
# incident: a manual recovery invocation (pid 3332) and the next automatic
# watchdog tick (pid 10900) both launched a node process for the SAME port
# within 15 seconds of each other - one won the bind race, the other crashed
# with EADDRINUSE. Nothing before this guard stopped two invocations from
# racing. A named, machine-wide Mutex scoped to this PA_HOME+port pair makes
# a second concurrent invocation skip itself instead of piling on; a process
# that never calls ReleaseMutex (any `exit` below, or a hard crash) still
# releases it automatically when the process terminates - Windows abandons
# process-owned mutex handles on exit, so no try/finally is needed here.
# A proper hash, not string.GetHashCode(): .NET randomizes GetHashCode() per
# PROCESS by default on some CLR versions (hash-flooding mitigation) - two
# separate powershell.exe invocations could derive two DIFFERENT mutex names
# for the identical paHome+port pair, silently defeating the whole guard.
# MD5 is deterministic across processes and runtimes; it also sidesteps
# backslash (a reserved NT Object Manager namespace separator) ever landing
# raw in a kernel object name, since $paHome is a filesystem path.
$md5 = [System.Security.Cryptography.MD5]::Create()
try {
  $mutexKey = [System.BitConverter]::ToString($md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("$paHome|$port"))).Replace('-', '')
} finally { $md5.Dispose() }
$mutexName = "Global\VoiceInboxRunServer_$mutexKey"
$runMutex = New-Object System.Threading.Mutex($false, $mutexName)
if (-not $runMutex.WaitOne(0)) {
  Write-RunServerLog "voice-inbox run: another run_server.ps1 is already in flight for this port - skipping this tick"
  exit 0
}

$serverJs = Join-Path $ProjectDir 'dist\server.js'
if (-not (Test-Path $serverJs)) {
  Write-Error "voice-inbox: $serverJs not found - run 'npm run build' first"
  exit 1
}

$listenerPid = Get-VoiceInboxPortListenerPid -Port $port
if ($listenerPid -gt 0) {
  if (-not (Test-IsVoiceInboxServerProcess -ProcId $listenerPid -ExpectedServerJsPath $serverJs)) {
    $msg = "voice-inbox run: port $port is held by pid $listenerPid whose command line does not match the voice-inbox server - refusing to launch"
    Write-RunServerLog $msg
    Write-Error $msg
    exit 1
  }
  Write-RunServerLog "voice-inbox run: port $port is still held by our own stale server pid $listenerPid - stopping it before relaunch"
  $stopResult = Invoke-VoiceInboxStopServer -ServerPid $listenerPid -Port $port -ExpectedServerJsPath $serverJs
  Write-RunServerLog $stopResult.Message
  if (-not $stopResult.Success) {
    Write-RunServerLog "voice-inbox run: could not free port $port - aborting launch instead of racing into EADDRINUSE"
    Write-Error "voice-inbox: could not free port $port before launch (see watchdog.log)"
    exit 1
  }
}

$stateDir = Join-Path $paHome 'voice-inbox'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$lockPath = Join-Path $stateDir 'server.lock'

$logOut = Join-Path $LogDir 'server.log'
$logErr = Join-Path $LogDir 'server.err'

$proc = Start-Process -FilePath 'node' `
  -ArgumentList "`"$serverJs`"" `
  -WorkingDirectory (Resolve-Path $ProjectDir).Path `
  -WindowStyle Hidden `
  -RedirectStandardOutput $logOut `
  -RedirectStandardError $logErr `
  -PassThru

# See "Post-launch bind confirmation" in the file header. Write-Output below
# is silently dropped by run-server-hidden.vbs's fire-and-forget call, so
# every branch here logs through Write-RunServerLog too.
$bound = $false
$bindConfirmSeconds = 45
$bindDeadline = (Get-Date).AddSeconds($bindConfirmSeconds)
do {
  if ($proc.HasExited) { break }
  if ((Get-VoiceInboxPortListenerPid -Port $port) -eq $proc.Id) { $bound = $true; break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $bindDeadline)

if (-not $bound) {
  if ($proc.HasExited) {
    # .ExitCode can read back blank immediately after .HasExited first turns
    # true (observed live, 2026-09-17: a watchdog.log line read "exited with
    # code" with nothing after it) - WaitForExit() with no argument is an
    # instant no-op once the process has already exited, but it forces the
    # exit code to be fully synchronized before it's read.
    $proc.WaitForExit()
    $why = "exited with code $($proc.ExitCode)"
  } else {
    $why = "did not bind port $port within ${bindConfirmSeconds}s - stopping it"
    Stop-VoiceInboxProcessTree -ProcId $proc.Id | Out-Null
  }
  $msg = "voice-inbox run: launched node pid $($proc.Id) but it $why - not writing server.lock (see $logErr)"
  Write-RunServerLog $msg
  Write-Error $msg
  exit 1
}

$lockJson = "{`"pid`":$($proc.Id),`"ts`":$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())}`n"
Set-Content -NoNewline -Path $lockPath -Value $lockJson -Encoding utf8

Write-RunServerLog "voice-inbox run: pid $($proc.Id) bound port $port - server.lock written"
Write-Output "voice-inbox: server starting detached (pid $($proc.Id)); stdout -> $logOut, stderr -> $logErr"
Write-Output 'voice-inbox: verify liveness via the log files (GET /api/v1/health), not via this launcher.'
