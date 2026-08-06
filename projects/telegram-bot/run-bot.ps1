# Task Scheduler / a caller with no "Start in" set may leave PowerShell's cwd
# wrong (e.g. C:\Windows\System32). BOT_CWD's process.env fallback in main.ts
# is dead code (loadSecrets() never writes into process.env), so main.ts's
# process.cwd() must already be correct — set it explicitly here rather than
# relying on the launch chain. repoRoot is one level up from this script.
Set-Location (Join-Path $PSScriptRoot "..\..")

$paHome = if ($env:PA_HOME) { $env:PA_HOME } else { Join-Path $env:USERPROFILE ".pa" }
$logFile = Join-Path $paHome "logs\telegram-bot.log"
# Rotation threshold and destination MUST match pa/src/lib/archive-files.ts
# (RUNTIME_ARCHIVE_MAX_BYTES = 5MB; ~/.pa/archive/<stamp>-<basename>) so the
# archive-prune maintenance job governs these shards. Rotating HERE — not in the
# bot — is load-bearing: the node process holds this file open through shell
# redirection, so it can only be rotated while the bot is down. Do NOT simply
# delete this block: bot-log-rotation-check restarts the bot at 5MB, so with no
# launcher-side rotation the bot would restart every minute forever. AI-100 W2.
$maxSize = 5MB
$archiveDir = Join-Path $paHome "archive"
if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt $maxSize) {
    if (-not (Test-Path $archiveDir)) { New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null }
    $stamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
    Move-Item $logFile (Join-Path $archiveDir "$stamp-telegram-bot.log")
}
$logDir = Split-Path -Parent $logFile
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
# UV_THREADPOOL_SIZE=16 (AI-096): fs and dns.lookup share libuv's threadpool —
# raising it decouples DNS from fs pressure (the coupling that took all
# networking down on 2026-07-04). Matches run-bot-hidden.vbs.
$env:UV_THREADPOOL_SIZE = '16'
node "$PSScriptRoot\dist\main.js" >> $logFile 2>&1
