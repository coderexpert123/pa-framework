$paHome = if ($env:PA_HOME) { $env:PA_HOME } else { Join-Path $env:USERPROFILE ".pa" }
$logFile = Join-Path $paHome "logs\telegram-bot.log"
$maxSize = 2MB
if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt $maxSize) {
    $rotated = "$logFile.1"
    if (Test-Path $rotated) { Remove-Item $rotated -Force }
    Rename-Item $logFile $rotated
}
$logDir = Split-Path -Parent $logFile
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
# UV_THREADPOOL_SIZE=16 (AI-096): fs and dns.lookup share libuv's threadpool —
# raising it decouples DNS from fs pressure (the coupling that took all
# networking down on 2026-07-04). Matches run-bot-hidden.vbs.
$env:UV_THREADPOOL_SIZE = '16'
node "$PSScriptRoot\dist\main.js" >> $logFile 2>&1
