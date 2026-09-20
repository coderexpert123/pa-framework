# Shared helpers for the voice-inbox detached-server lifecycle (AI-254 fix,
# 2026-09-17). Used by both stop_server.ps1 and run_server.ps1 so the two
# scripts can never disagree about how to find, verify, and clear the
# server's port.
#
# Why this exists: stop_server.ps1's old EAP=Stop + `taskkill 2>&1` combo
# turned a routine "process not found" into a terminating error under
# Windows PowerShell 5.1, so the force-stop escalation never ran; separately,
# server.lock could name a dead pid while the real server sat untracked, so
# a no-arg stop reported "nothing to stop" while the live server (and its
# stale build) kept serving. Both defects caused real multi-hour outages
# (2026-09-15/16, 2026-09-17) because run_server.ps1 always wrote a fresh
# lock and always launched, even straight into EADDRINUSE. This module's
# functions resolve the true state (who, if anyone, holds the port) instead
# of trusting the lock file alone, and never touch a process that isn't
# provably ours.
#
# `$ErrorActionPreference = 'Stop'` in a *calling* script does not leak into
# these functions' own scopes unless they read it explicitly, but native
# taskkill output is special: PowerShell 5.1 promotes ANY stderr line from a
# native command into a terminating ErrorRecord under EAP=Stop, even when
# that stream is redirected to $null - only a locally-scoped
# $ErrorActionPreference = 'Continue' around the call (not just try/catch,
# though we keep both as belt-and-suspenders) reliably prevents it. Verified
# live on this box (2026-09-17): `taskkill /PID <dead>` with EAP=Stop and
# `2>$null` still threw a NativeCommandError; scoping EAP to 'Continue'
# around the call did not.

function Get-VoiceInboxPaHome {
  if ($env:PA_HOME) { return $env:PA_HOME }
  return (Join-Path $env:USERPROFILE '.pa')
}

# The dist/server.js path THIS tree's own run_server.ps1 launches, built the
# identical way (Join-Path $PSScriptRoot '..' then 'dist\server.js', leaving
# the '..' segment un-collapsed) so it is a byte-identical substring of the
# live process's real CommandLine. Confirmed live on this box: the running
# server's actual argv is `"...\scripts\..\dist\server.js"`, NOT a resolved
# path - Start-Process never normalizes it, so a canonical path built with
# [System.IO.Path]::GetFullPath() would silently stop matching the real
# server. $PSScriptRoot here is the MODULE's own directory (always the same
# scripts\ folder run_server.ps1/stop_server.ps1 live in, whichever tree this
# copy of the module was loaded from) - a worktree checkout's own copy
# resolves to ITS OWN dist/server.js, never another tree's.
function Get-VoiceInboxCanonicalServerJsPath {
  return (Join-Path (Join-Path $PSScriptRoot '..') 'dist\server.js')
}

# Port resolution mirrors src/config.ts: VOICE_INBOX_PORT env wins, else
# ~/.pa/config.yaml's voice_inbox.port, else 8787. Not a full YAML parser -
# scoped line-scan good enough for this one scalar key, same spirit as
# screencast_bridge.mjs's readConfigKey.
function Get-VoiceInboxPort {
  param([string]$PaHome = (Get-VoiceInboxPaHome))

  if ($env:VOICE_INBOX_PORT) {
    $envInt = 0
    if ([int]::TryParse($env:VOICE_INBOX_PORT.Trim(), [ref]$envInt) -and $envInt -gt 0) {
      return $envInt
    }
  }

  $configPath = Join-Path $PaHome 'config.yaml'
  if (Test-Path $configPath) {
    $inBlock = $false
    foreach ($line in (Get-Content $configPath)) {
      if ($line -match '^voice_inbox:\s*$') { $inBlock = $true; continue }
      if ($inBlock) {
        if ($line -match '^\S') { break }
        if ($line -match '^\s+port:\s*(\d+)\s*$') {
          $parsed = [int]$Matches[1]
          if ($parsed -gt 0) { return $parsed }
        }
      }
    }
  }

  return 8787
}

# BOM-safe: strips a leading UTF-8 BOM at the byte level before decoding, so
# this never depends on Get-Content's own encoding auto-detection. Returns
# $null on a missing, empty, or unparseable file - callers treat that the
# same as "no usable lock".
function Read-VoiceInboxServerLock {
  param([Parameter(Mandatory)][string]$LockPath)

  if (-not (Test-Path $LockPath)) { return $null }
  try {
    $bytes = [System.IO.File]::ReadAllBytes($LockPath)
  } catch {
    return $null
  }
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $bytes = $bytes[3..($bytes.Length - 1)]
  }
  if ($bytes.Length -eq 0) { return $null }
  $text = [System.Text.Encoding]::UTF8.GetString($bytes)
  try {
    return $text | ConvertFrom-Json
  } catch {
    return $null
  }
}

# 0 when nothing is listening (or the query itself fails - never throws).
function Get-VoiceInboxPortListenerPid {
  param([Parameter(Mandatory)][int]$Port)

  try {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  } catch {
    return 0
  }
  if (-not $conns) { return 0 }
  $first = $conns | Select-Object -First 1 -ExpandProperty OwningProcess
  if (-not $first) { return 0 }
  return [int]$first
}

# The ONLY place that decides "is this pid our server". Requires the command
# line to contain THIS tree's own resolved dist/server.js path (or an
# explicitly supplied one), not just the loose substrings "voice-inbox" and
# "dist/server.js" - a bare substring match would also accept a worktree
# checkout's own voice-inbox server (e.g. C:\wt\<hash>\projects\voice-inbox\
# dist\server.js) or a test fixture shaped to look like one, which is exactly
# the "provably ours" promise this module's header makes. Bounded
# -OperationTimeoutSec: Get-CimInstance has no default bound, and this
# machine has seen multi-minute WMI stalls under load (project brain: WMI
# snapshot storm) - an unbounded hang here would stall the caller's stop/
# relaunch decision indefinitely. A timeout (like any other failure to read
# the command line) reads as "not provably ours" -> $false, never $true.
function Test-IsVoiceInboxServerProcess {
  param(
    [Parameter(Mandatory)][int]$ProcId,
    [string]$ExpectedServerJsPath = (Get-VoiceInboxCanonicalServerJsPath)
  )

  if ($ProcId -le 0) { return $false }
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -OperationTimeoutSec 15 -ErrorAction SilentlyContinue
  } catch {
    return $false
  }
  if (-not $proc -or -not $proc.CommandLine) { return $false }
  $cmdNorm = $proc.CommandLine.Replace('/', '\').ToLowerInvariant()
  $expectedNorm = $ExpectedServerJsPath.Replace('/', '\').ToLowerInvariant()
  return $cmdNorm.Contains($expectedNorm)
}

# Graceful-then-force stop of one pid, non-terminating on either step
# regardless of the caller's $ErrorActionPreference. Returns $true only when
# the process is confirmed gone afterward.
function Stop-VoiceInboxProcessTree {
  param([Parameter(Mandatory)][int]$ProcId)

  if (-not (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)) { return $true }

  $ErrorActionPreference = 'Continue'
  try { & taskkill /PID $ProcId 2>$null | Out-Null } catch { }
  $ErrorActionPreference = 'Stop'

  Start-Sleep -Seconds 3
  if (-not (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)) { return $true }

  $ErrorActionPreference = 'Continue'
  try { & taskkill /F /T /PID $ProcId 2>$null | Out-Null } catch { }
  $ErrorActionPreference = 'Stop'

  # Poll rather than a single fixed sleep (2026-09-17 deep-recheck): a fixed
  # 1s wait here was observed to flake under this test suite's own
  # taskkill-shim indirection (an extra cmd.exe hop before the real
  # taskkill.exe runs), reporting "still running" for a process that in fact
  # cleared a few hundred ms later. Bounded at 5s, same shape as
  # Wait-VoiceInboxPortFree below, so a genuinely stuck process still fails
  # fast instead of hanging.
  $deadline = (Get-Date).AddSeconds(5)
  do {
    if (-not (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return -not (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)
}

function Wait-VoiceInboxPortFree {
  param(
    [Parameter(Mandatory)][int]$Port,
    [int]$TimeoutSeconds = 5
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if ((Get-VoiceInboxPortListenerPid -Port $Port) -eq 0) { return $true }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return (Get-VoiceInboxPortListenerPid -Port $Port) -eq 0
}

# Orchestrates a full stop: resolve the target pid, stop it, confirm both
# the process and the port are clear. Returns
# @{ Success = <bool>; Message = <string> } - never throws.
#
# Resolution order:
#   1. Explicit -ServerPid (trusted as-is - existing callers such as the
#      watchdog's own stale-build path already name a specific pid).
#   2. server.lock's pid, ONLY when it is both alive and the current port
#      owner (a lock pid that is dead, missing, or does not own the port is
#      exactly the AI-254 stale-lock failure mode - fall through).
#   3. The verified port listener (command line must match our server.js) -
#      refuses (does not touch the process) when the listener's command
#      line does not match.
function Invoke-VoiceInboxStopServer {
  param(
    [int]$ServerPid = 0,
    [int]$Port = 0,
    [string]$LockPath = '',
    [string]$ExpectedServerJsPath = (Get-VoiceInboxCanonicalServerJsPath)
  )

  if ($Port -le 0) { $Port = Get-VoiceInboxPort }
  if (-not $LockPath) { $LockPath = Join-Path (Get-VoiceInboxPaHome) 'voice-inbox\server.lock' }

  $targetPid = 0
  if ($ServerPid -gt 0) {
    $targetPid = $ServerPid
  } else {
    $lock = Read-VoiceInboxServerLock -LockPath $LockPath
    if ($lock -and $lock.pid) {
      $lockPid = [int]$lock.pid
      if (($lockPid -gt 0) -and (Get-Process -Id $lockPid -ErrorAction SilentlyContinue) -and
          ((Get-VoiceInboxPortListenerPid -Port $Port) -eq $lockPid)) {
        $targetPid = $lockPid
      }
    }

    if ($targetPid -eq 0) {
      $listenerPid = Get-VoiceInboxPortListenerPid -Port $Port
      if ($listenerPid -gt 0) {
        if (Test-IsVoiceInboxServerProcess -ProcId $listenerPid -ExpectedServerJsPath $ExpectedServerJsPath) {
          $targetPid = $listenerPid
        } else {
          return [pscustomobject]@{
            Success = $false
            Message = "voice-inbox stop: port $Port is held by pid $listenerPid whose command line does not match the voice-inbox server - refusing to touch it"
          }
        }
      }
    }
  }

  if ($targetPid -eq 0) {
    return [pscustomobject]@{
      Success = $true
      Message = "voice-inbox stop: no live server found (lock stale or missing, port $Port free) - nothing to stop"
    }
  }

  if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
    return [pscustomobject]@{
      Success = $true
      Message = "voice-inbox stop: pid $targetPid is not running - nothing to stop"
    }
  }

  $stopped = Stop-VoiceInboxProcessTree -ProcId $targetPid
  $portFree = Wait-VoiceInboxPortFree -Port $Port -TimeoutSeconds 5

  if ($stopped -and $portFree) {
    return [pscustomobject]@{ Success = $true; Message = "voice-inbox stop: pid $targetPid stopped, port $Port free" }
  }
  if (-not $stopped) {
    return [pscustomobject]@{ Success = $false; Message = "voice-inbox stop: pid $targetPid is STILL running after a force stop - investigate manually" }
  }
  return [pscustomobject]@{ Success = $false; Message = "voice-inbox stop: pid $targetPid stopped but port $Port is still held by another process - investigate manually" }
}

Export-ModuleMember -Function `
  Get-VoiceInboxPaHome, `
  Get-VoiceInboxCanonicalServerJsPath, `
  Get-VoiceInboxPort, `
  Read-VoiceInboxServerLock, `
  Get-VoiceInboxPortListenerPid, `
  Test-IsVoiceInboxServerProcess, `
  Stop-VoiceInboxProcessTree, `
  Wait-VoiceInboxPortFree, `
  Invoke-VoiceInboxStopServer
