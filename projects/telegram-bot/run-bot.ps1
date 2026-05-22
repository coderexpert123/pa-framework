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
node "$PSScriptRoot\dist\main.js" >> $logFile 2>&1
