# Robust stop for the detached voice-inbox server.
#
# History:
#
# 2026-09-11 stale-server incident: a session stopped the server with plain
# `taskkill /PID <pid>` (no /F, a graceful stop request rather than a forced
# TerminateProcess). Windows returned "ERROR: The process ... could not be
# terminated. Reason: Access is denied." That reads like a real permission
# problem but was not one: the same non-elevated user force-stopped the
# identical pid a short time later without any issue. The fix: try graceful
# first, then escalate to a force stop automatically.
#
# AI-254 (2026-09-16/17, two multi-hour outages): that fix never actually ran.
# `$ErrorActionPreference = 'Stop'` plus `& taskkill ... 2>&1 | Out-Null`
# turns ANY native stderr line from taskkill into a terminating ErrorRecord
# under Windows PowerShell 5.1 — confirmed live on this box: even
# `2>$null` alone does not suppress it, only a locally-scoped
# `$ErrorActionPreference = 'Continue'` around the native call does. So a
# graceful stop that failed ("process not found" or "access denied") aborted
# the whole script before the /F escalation at the old line 66 ever ran.
# Separately, `server.lock` could point at a dead pid while the real server
# sat untracked, so a no-arg stop reported "nothing to stop" while the actual
# server (and its stale build) kept serving for hours. Both are fixed by
# routing everything through server-lifecycle.psm1's
# Invoke-VoiceInboxStopServer, which never trusts the lock alone: it falls
# back to the real port-8787 listener (verified by command line) whenever the
# lock is dead, missing, or does not own the port, and never converts a
# taskkill "not found" into a terminating error.
#
# Usage: powershell -File scripts\stop_server.ps1 [-ServerPid <n>]
# With no -ServerPid, resolves the target from server.lock, falling back to
# the verified port listener when the lock is unusable.
# (Named ServerPid, not Pid - $PID is a read-only PowerShell automatic variable.)

param(
  [int]$ServerPid = 0
)

$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'server-lifecycle.psm1') -Force

$result = Invoke-VoiceInboxStopServer -ServerPid $ServerPid

Write-Output $result.Message
if ($result.Success) { exit 0 }
exit 1
