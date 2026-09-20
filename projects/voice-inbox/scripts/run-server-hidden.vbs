Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
' Task Scheduler launches wscript.exe with no "Start in" directory, so its
' default cwd is C:\Windows\System32 (same class of bug fixed in
' run-bot-hidden.vbs). pkgDir is one level up: scripts -> voice-inbox.
pkgDir = fso.GetParentFolderName(scriptDir)
WshShell.CurrentDirectory = pkgDir

' Liveness gate (2026-09-10 launch-cadence wave): before this gate existed,
' the voice-inbox app server had NO watchdog at all — after a reboot it
' stayed dead until started by hand. The lock file is the narrowest one that
' matches the relay poller's own shape (JSON {"pid":<n>,"ts":<ms>}), written
' by run_server.ps1 itself right after Start-Process returns.
paHomeDir = WshShell.ExpandEnvironmentStrings("%PA_HOME%")
If paHomeDir = "%PA_HOME%" Or Len(Trim(paHomeDir)) = 0 Then
  paHomeDir = WshShell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.pa"
End If
lockPath = paHomeDir & "\voice-inbox\server.lock"
watchdogLogPath = paHomeDir & "\voice-inbox\logs\watchdog.log"

' Build-staleness gate (2026-09-11 stale-server incident): liveness alone let
' a healthy-but-day-old process serve yesterday's code silently for ~24h,
' because a manual stop attempt hit a misleading "Access is denied" (see
' scripts/stop_server.ps1's header) and nothing ever retried it. This reuses
' the SAME dist/.build-stamp convention scripts/build.mjs already writes on
' every successful compile and the telegram-bot's self-restart job already
' compares against a running process — see src/self-restart.ts there. The
' comparison here uses plain file-mtime-vs-file-mtime (server.lock's own
' mtime as the process's start time, set it wrote the lock the instant
' Start-Process returned a pid) so there is no epoch/timezone arithmetic to
' get wrong in VBScript — both timestamps come from the same local clock via
' the same FileSystemObject API.
buildStampPath = pkgDir & "\dist\.build-stamp"
staleGraceSeconds = 60

If PidIsLiveNode(ReadJsonPid(lockPath)) Then
  If IsStaleBuild(lockPath, buildStampPath, staleGraceSeconds) Then
    stalePid = ReadJsonPid(lockPath)
    LogWatchdog watchdogLogPath, "stale build detected (dist/.build-stamp newer than server.lock by >" & staleGraceSeconds & "s) - force-stopping pid " & stalePid & " and relaunching"
    WshShell.Run "taskkill /F /PID " & stalePid, 0, True
    WScript.Sleep 500
  Else
    WScript.Quit 0
  End If
End If

WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\run_server.ps1""", 0, False

' True when buildStampPath's mtime is newer than lockPath's mtime by more
' than graceSeconds. False (never stale) when either file is missing, so a
' fresh checkout with no build yet — or a build.mjs run that predates this
' watchdog change — never blocks the ordinary liveness path above.
Function IsStaleBuild(lockPath, buildStampPath, graceSeconds)
  IsStaleBuild = False
  If Not fso.FileExists(lockPath) Then Exit Function
  If Not fso.FileExists(buildStampPath) Then Exit Function
  On Error Resume Next
  lockTime = fso.GetFile(lockPath).DateLastModified
  stampTime = fso.GetFile(buildStampPath).DateLastModified
  If Err.Number <> 0 Then Err.Clear : Exit Function
  On Error GoTo 0
  IsStaleBuild = (DateDiff("s", lockTime, stampTime) > graceSeconds)
End Function

Sub LogWatchdog(path, msg)
  On Error Resume Next
  Dim f
  Set f = fso.OpenTextFile(path, 8, True)
  f.WriteLine Now & " " & msg
  f.Close
  On Error GoTo 0
End Sub

' Returns the digits following the first "pid": in the file, or 0.
Function ReadJsonPid(path)
  Dim text, at, i, ch, digits
  ReadJsonPid = 0
  If Not fso.FileExists(path) Then Exit Function
  On Error Resume Next
  text = fso.OpenTextFile(path, 1).ReadAll()
  If Err.Number <> 0 Then Err.Clear : Exit Function
  On Error GoTo 0
  at = InStr(text, """pid""")
  If at = 0 Then Exit Function
  digits = ""
  For i = at + 5 To Len(text)
    ch = Mid(text, i, 1)
    If ch >= "0" And ch <= "9" Then
      digits = digits & ch
    ElseIf Len(digits) > 0 Then
      Exit For
    End If
  Next
  If Len(digits) > 0 Then ReadJsonPid = CLng(digits)
End Function

' Liveness gate: true only when a live node.exe holds this PID. Anything else -
' missing lock file, unparseable PID, dead process, a non-node process that
' reused the PID, an unexpected tasklist result - reads as NOT live, so the
' worst case is one wasted launch that exits on the real lock. Never the
' reverse: a false "alive" would leave the service down forever.
Function PidIsLiveNode(pid)
  Dim cmdText
  PidIsLiveNode = False
  If Not IsNumeric(pid) Then Exit Function
  If CDbl(pid) <= 0 Then Exit Function
  cmdText = "cmd /c tasklist /NH /FI ""PID eq " & CLng(pid) & """ /FI ""IMAGENAME eq node.exe"" | find /I ""node.exe"" >nul"
  PidIsLiveNode = (WshShell.Run(cmdText, 0, True) = 0)
End Function
