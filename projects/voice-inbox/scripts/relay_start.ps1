# Detached voice-inbox relay poller launcher (edge-relay wave WP-R2).
#
# Machine rule (mirrors scripts/run_server.ps1): a detached launcher's failure
# lands in .err — Start-Process with -WindowStyle Hidden and BOTH .log and .err
# redirects; verify liveness via the log files, never via this script's exit
# code.
#
# Usage:  powershell -File scripts\relay_start.ps1 [-ProjectDir <dir>]
#
# State and logs live under <PA_HOME>\voice-inbox (runtime state stays out of
# the repo tree). The secret is read from <PA_HOME>\secrets.env — parsed as
# KEY=value lines — and handed to the poller via its environment.
#
# Lock file (2026-09-10 pile-up fix): <PA_HOME>\voice-inbox\relay-poller.lock,
# JSON `{"pid":<n>,"ts":<ms>}` — the same shape server.lock uses (see
# run_server.ps1). Written HERE, synchronously, right after Start-Process
# returns its -PassThru PID — not left for the poller to register itself,
# because Start-Process is fire-and-forget and a slow node cold start left a
# window where the next scheduler tick saw no lock yet and launched another
# poller (confirmed mechanism behind a 10-poller pile-up, see this project's
# CLAUDE.md "Known gap" note). relay_poller.mjs's acquireLock() recognizes a
# lock already naming its own pid as this placeholder rather than a foreign
# holder to contest.

param(
  [string]$ProjectDir = (Join-Path $PSScriptRoot '..')
)

$ErrorActionPreference = 'Stop'

$pollerJs = Join-Path $ProjectDir 'scripts\relay_poller.mjs'
if (-not (Test-Path $pollerJs)) {
  Write-Error "voice-inbox relay: $pollerJs not found"
  exit 1
}

$paHome = if ($env:PA_HOME) { $env:PA_HOME } else { Join-Path $env:USERPROFILE '.pa' }

# Secret: VOICE_INBOX_RELAY_SECRET from secrets.env (KEY=value lines).
$secretsPath = Join-Path $paHome 'secrets.env'
if (-not (Test-Path $secretsPath)) {
  Write-Error "voice-inbox relay: $secretsPath not found - run 'node scripts/relay_setup.mjs' first"
  exit 1
}
$secret = $null
foreach ($line in Get-Content $secretsPath) {
  if ($line -match '^\s*VOICE_INBOX_RELAY_SECRET\s*=\s*(.+?)\s*$') {
    $secret = $Matches[1].Trim('"').Trim("'")
    break
  }
}
if (-not $secret) {
  Write-Error "voice-inbox relay: VOICE_INBOX_RELAY_SECRET not found in $secretsPath - run 'node scripts/relay_setup.mjs' first"
  exit 1
}
$env:VOICE_INBOX_RELAY_SECRET = $secret

$stateDir = Join-Path $paHome 'voice-inbox'
$logDir = Join-Path $stateDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$lockPath = Join-Path $stateDir 'relay-poller.lock'
$logOut = Join-Path $logDir 'relay-poller.log'
$logErr = Join-Path $logDir 'relay-poller.err'

# Single-instance lock check (the 1-minute Task Scheduler tick is an
# ensure-running no-op while healthy). The poller re-checks the same file and
# steals it when the holder's PID is dead, so a stale lock here never wedges
# startup.
if (Test-Path $lockPath) {
  $holder = $null
  try {
    $holder = Get-Content $lockPath -Raw | ConvertFrom-Json
  } catch {
    $holder = $null
  }
  if ($holder -and $holder.pid) {
    $proc = Get-Process -Id $holder.pid -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Output "voice-inbox relay: already running (pid $($holder.pid))"
      exit 0
    }
  }
}

$proc = Start-Process -FilePath 'node' `
  -ArgumentList "`"scripts\relay_poller.mjs`"" `
  -WorkingDirectory (Resolve-Path $ProjectDir).Path `
  -WindowStyle Hidden `
  -RedirectStandardOutput $logOut `
  -RedirectStandardError $logErr `
  -PassThru

# Write the lock SYNCHRONOUSLY, right here, using the PID Start-Process hands
# back immediately — closes the pile-up window described above before this
# script returns control to whoever invoked it (the VBS watchdog or a
# scheduler tick).
$lockJson = "{`"pid`":$($proc.Id),`"ts`":$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())}`n"
Set-Content -NoNewline -Path $lockPath -Value $lockJson -Encoding utf8

Write-Output "voice-inbox relay: poller starting detached (pid $($proc.Id)); stdout -> $logOut, stderr -> $logErr"
Write-Output 'voice-inbox relay: verify liveness via the log files, not via this launcher.'
