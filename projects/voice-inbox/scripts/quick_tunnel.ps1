# quick_tunnel.ps1 — relaunch the ephemeral trycloudflare.com quick tunnel and
# print/save the new URL (it changes on every start; that is the quick tunnel's
# one property). Recovery path when the machine restarts: run this, then open
# the printed URL on the phone (the PWA session cookie dies with the old URL's
# origin — re-enter a pairing code after switching).
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\quick_tunnel.ps1
# Logs:   ~/.pa/voice-inbox/quick-tunnel.log/.err   URL saved to ~/.pa/voice-inbox/quick-tunnel-url.txt

$ErrorActionPreference = 'Stop'
$cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
if (-not (Test-Path $cloudflared)) { $cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source }
if (-not $cloudflared) { Write-Error 'cloudflared not found'; exit 1 }

$stateDir = Join-Path $env:USERPROFILE '.pa\voice-inbox'
New-Item -ItemType Directory -Force $stateDir | Out-Null

# Kill any existing quick tunnel (its URL is dead the moment it stops)
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
  Where-Object { $_.CommandLine -match 'trycloudflare|--url' } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

$log = Join-Path $stateDir 'quick-tunnel.log'
$err = Join-Path $stateDir 'quick-tunnel.err'
$p = Start-Process -WindowStyle Hidden -FilePath $cloudflared `
  -ArgumentList 'tunnel','--url','http://127.0.0.1:8787','--no-autoupdate' `
  -RedirectStandardOutput $log -RedirectStandardError $err -PassThru

$url = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  $m = Select-String -Path $err -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($m) { $url = $m.Matches[0].Value; break }
}
if ($url) {
  Set-Content -Path (Join-Path $stateDir 'quick-tunnel-url.txt') -Value $url
  Write-Output "quick tunnel up: $url (saved to quick-tunnel-url.txt)"
} else {
  Write-Output "no URL found in $err after 20s - check the log"
  exit 1
}
