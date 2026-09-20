/**
 * launcher-vbs.test.ts — pins the run-bot-hidden.vbs liveness gate
 * (2026-09-10 launch-cadence wave, WP-B). The gate makes a healthy per-minute
 * Task Scheduler tick cost a `tasklist` call instead of a cold node.exe
 * launch; see run-bot-hidden.vbs's own comments for the incident this fixes.
 *
 * run-bot-hidden.vbs is PRIVATE (inventory/placement-registry.md row L83:
 * private-excluded) — it is absent in the public mirror and on public CI.
 * Every case that reads the file skips via t.skip when it is missing, so the
 * public suite still registers real tests and never reads as a dark file:
 * case 4 below asserts unconditionally against the S1 function text this
 * spec fixes, independent of the file's presence.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VBS_PATH = resolve(__dirname, '../../run-bot-hidden.vbs');

// The S1 canonical PidIsLiveNode text (plans/2026-09-10-launch-cadence-SPEC.md)
// — asserted unconditionally so this file can never register zero real tests.
const S1_PID_IS_LIVE_NODE = [
  'Function PidIsLiveNode(pid)',
  '  Dim cmdText',
  '  PidIsLiveNode = False',
  '  If Not IsNumeric(pid) Then Exit Function',
  '  If CDbl(pid) <= 0 Then Exit Function',
  '  cmdText = "cmd /c tasklist /NH /FI ""PID eq " & CLng(pid) & """ /FI ""IMAGENAME eq node.exe"" | find /I ""node.exe"" >nul"',
  '  PidIsLiveNode = (WshShell.Run(cmdText, 0, True) = 0)',
  'End Function',
].join('\n');

describe('run-bot-hidden.vbs launcher gate (2026-09-10 launch-cadence wave)', () => {
  it('the S1 PidIsLiveNode text carries both tasklist filters and the find pipe (unconditional)', () => {
    assert.ok(S1_PID_IS_LIVE_NODE.includes('/FI ""PID eq'));
    assert.ok(S1_PID_IS_LIVE_NODE.includes('/FI ""IMAGENAME eq node.exe""'));
    assert.ok(S1_PID_IS_LIVE_NODE.includes('| find /I ""node.exe""'));
  });

  it('the WScript.Quit 0 guard line exists and precedes WshShell.Run cmdLine', (t) => {
    if (!existsSync(VBS_PATH)) {
      t.skip('run-bot-hidden.vbs is private-excluded; absent in the public mirror');
      return;
    }
    const text = readFileSync(VBS_PATH, 'utf8');
    const quitIdx = text.indexOf('WScript.Quit 0');
    const runIdx = text.indexOf('WshShell.Run cmdLine');
    assert.ok(quitIdx >= 0, 'guard line not found');
    assert.ok(runIdx >= 0, 'WshShell.Run cmdLine not found');
    assert.ok(quitIdx < runIdx, 'the guard must run before the node launch');
  });

  it('WshShell.CurrentDirectory = repoRoot appears before the guard (System32 fix stays first)', (t) => {
    if (!existsSync(VBS_PATH)) {
      t.skip('run-bot-hidden.vbs is private-excluded; absent in the public mirror');
      return;
    }
    const text = readFileSync(VBS_PATH, 'utf8');
    const cwdIdx = text.indexOf('WshShell.CurrentDirectory = repoRoot');
    const quitIdx = text.indexOf('WScript.Quit 0');
    assert.ok(cwdIdx >= 0, 'CurrentDirectory assignment not found');
    assert.ok(quitIdx >= 0, 'guard line not found');
    assert.ok(cwdIdx < quitIdx, 'CurrentDirectory must be set before the liveness gate runs');
  });

  it('the guard is above the rotation block', (t) => {
    if (!existsSync(VBS_PATH)) {
      t.skip('run-bot-hidden.vbs is private-excluded; absent in the public mirror');
      return;
    }
    const text = readFileSync(VBS_PATH, 'utf8');
    const quitIdx = text.indexOf('WScript.Quit 0');
    const moveIdx = text.indexOf('fso.MoveFile logFile');
    assert.ok(quitIdx >= 0, 'guard line not found');
    assert.ok(moveIdx >= 0, 'rotation MoveFile call not found');
    assert.ok(quitIdx < moveIdx, 'a healthy tick must exit before reaching the rotation block');
  });

  it('PidIsLiveNode is present with both filters and the find pipe', (t) => {
    if (!existsSync(VBS_PATH)) {
      t.skip('run-bot-hidden.vbs is private-excluded; absent in the public mirror');
      return;
    }
    const text = readFileSync(VBS_PATH, 'utf8');
    assert.ok(text.includes('Function PidIsLiveNode(pid)'));
    assert.ok(text.includes('/FI ""PID eq'));
    assert.ok(text.includes('/FI ""IMAGENAME eq node.exe""'));
    assert.ok(text.includes('| find /I ""node.exe""'));
  });

  it('the fail-safe direction is pinned: no localized "No tasks" check, no un-piped tasklist', (t) => {
    if (!existsSync(VBS_PATH)) {
      t.skip('run-bot-hidden.vbs is private-excluded; absent in the public mirror');
      return;
    }
    const text = readFileSync(VBS_PATH, 'utf8');
    assert.ok(!text.includes('No tasks'), 'a localized-string check would report a dead bot as alive');
    // Every tasklist INVOCATION must be piped through find — a bare tasklist
    // call whose result feeds the guard would be inert (constant exit code).
    // Comment lines (leading ') are prose, not invocations, and are skipped —
    // this file's own header prose mentions "tasklist" without a pipe.
    for (const line of text.split('\n')) {
      if (line.trim().startsWith("'")) continue;
      if (!line.includes('tasklist')) continue;
      assert.ok(line.includes('| find'), `tasklist line without a find pipe: ${line}`);
    }
  });

  it('set UV_THREADPOOL_SIZE=16&& survives in cmdLine', (t) => {
    if (!existsSync(VBS_PATH)) {
      t.skip('run-bot-hidden.vbs is private-excluded; absent in the public mirror');
      return;
    }
    const text = readFileSync(VBS_PATH, 'utf8');
    assert.ok(text.includes('set UV_THREADPOOL_SIZE=16&&'));
  });

  it('the file contains no CR bytes (stays LF)', (t) => {
    if (!existsSync(VBS_PATH)) {
      t.skip('run-bot-hidden.vbs is private-excluded; absent in the public mirror');
      return;
    }
    const raw = readFileSync(VBS_PATH);
    assert.ok(!raw.includes(0x0d), 'run-bot-hidden.vbs must stay LF-terminated');
  });
});

// The D1 deploy-staleness watchdog canonical lines (2026-09-13 deploy-staleness
// wave; probe bounded by the 2026-09-13 starvation fix) — asserted
// unconditionally, same pattern as S1_PID_IS_LIVE_NODE above, so the watchdog
// can never register zero real tests. The frozen design: a CLEAN BUILD_INFO
// build newer than the bot process start gets the graceful `pa bot restart`;
// anything else — dirty tree, missing/unparsable stamp, any probe error or a
// probe that never returns a verdict — keeps the old launch-only behavior.
const D1_WATCHDOG_LINES = [
  // fail-closed clean check: ONLY the exact compact "dirty":false marker passes
  String.raw`BuildInfoIsClean = (InStr(text, """dirty"":false") > 0)`,
  // the alive-tick decision sequence: clean gate, probe, restart last
  String.raw`If Not BuildInfoIsClean(buildInfoPath) Then Exit Sub`,
  // probe bound 2 of 2: the probe powershell self-terminates (verdict-less =
  // probe error) 15s in, so a wedged probe never lingers as an orphan
  String.raw`$t=New-Object System.Threading.Timer({param($s)[Environment]::Exit(2)},$null,15000,-1);`,
  String.raw`$m=(Get-Item '" & mainJsPath & "').LastWriteTimeUtc; `,
  // verdict file contract: 0 stale / 1 fresh / 2 error, written by the probe itself
  String.raw`if($m.ToUniversalTime() -gt $p.StartTime.ToUniversalTime()){Set-Content -Path '" & verdictPath & "' -Value 0 -NoNewline}else{Set-Content -Path '" & verdictPath & "' -Value 1 -NoNewline} }catch{Set-Content -Path '" & verdictPath & "' -Value 2 -NoNewline}`,
  // probe bound 1 of 2: the spawn is UNAWAITED — the launcher polls the verdict
  String.raw`WshShell.Run "powershell.exe -NoProfile -Command """ & ps & """", 0, False`,
  String.raw`deadline = DateAdd("s", 20, Now)`,
  String.raw`LogWatchdogLine "deploy-staleness probe gave no verdict in 20s - no restart"`,
  String.raw`If rc <> 1 Then LogWatchdogLine "deploy-staleness probe failed (exit " & rc & ") - no restart"`,
  String.raw`LogWatchdogLine "stale deploy detected (dist/main.js newer than bot start, BUILD_INFO clean) - issuing pa bot restart"`,
  // restart is the graceful sentinel path — node + the compiled pa entry, never a force kill
  String.raw`WshShell.Run "cmd /c node """ & repoRoot & "\pa\dist\bin\pa.js"" bot restart", 0, False`,
];

describe('run-bot-hidden.vbs deploy-staleness watchdog (2026-09-13)', () => {
  it('carries the canonical D1 watchdog lines (unconditional)', () => {
    const text = existsSync(VBS_PATH) ? readFileSync(VBS_PATH, 'utf8') : D1_WATCHDOG_LINES.join('\n');
    for (const line of D1_WATCHDOG_LINES) {
      assert.ok(text.includes(line), `canonical watchdog line missing: ${line}`);
    }
  });

  it('the staleness decision sits inside the alive branch, before the quit and the node launch', (t) => {
    if (!existsSync(VBS_PATH)) {
      t.skip('run-bot-hidden.vbs is private-excluded; absent in the public mirror');
      return;
    }
    const text = readFileSync(VBS_PATH, 'utf8');
    const gateIdx = text.indexOf('If PidIsLiveNode(botPid) Then');
    const decisionIdx = text.indexOf('RestartIfStaleDeploy botPid');
    const quitIdx = text.indexOf('WScript.Quit 0');
    const runIdx = text.indexOf('WshShell.Run cmdLine');
    assert.ok(gateIdx >= 0, 'alive gate not found');
    assert.ok(decisionIdx >= 0, 'staleness decision call not found');
    assert.ok(quitIdx >= 0, 'guard line not found');
    assert.ok(runIdx >= 0, 'WshShell.Run cmdLine not found');
    assert.ok(gateIdx < decisionIdx, 'the staleness decision must run only after the liveness gate passes');
    assert.ok(decisionIdx < quitIdx, 'the quit must follow the staleness decision');
    assert.ok(quitIdx < runIdx, 'the quit must precede the node launch');
  });

  it('the restart is the graceful sentinel path — this launcher never force-kills the bot', (t) => {
    if (!existsSync(VBS_PATH)) {
      t.skip('run-bot-hidden.vbs is private-excluded; absent in the public mirror');
      return;
    }
    const text = readFileSync(VBS_PATH, 'utf8');
    assert.ok(text.includes('bot restart'), 'the restart must go through `pa bot restart`');
    assert.ok(
      !text.includes('taskkill'),
      'the bot must never be force-killed by this watchdog (contrast the catchup watchdog, which kills its own proven-wedged loop)',
    );
  });

  it('no git runs at runtime (BUILD_INFO was stamped at build time)', (t) => {
    if (!existsSync(VBS_PATH)) {
      t.skip('run-bot-hidden.vbs is private-excluded; absent in the public mirror');
      return;
    }
    const text = readFileSync(VBS_PATH, 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim().startsWith("'")) continue;
      assert.ok(!/\bgit\b/.test(line), `git invocation found on a runtime line: ${line}`);
    }
  });

  it('probe failures are logged and never restart; the restart line follows the failure gate', (t) => {
    if (!existsSync(VBS_PATH)) {
      t.skip('run-bot-hidden.vbs is private-excluded; absent in the public mirror');
      return;
    }
    const text = readFileSync(VBS_PATH, 'utf8');
    const failGateIdx = text.indexOf('If rc <> 0 Then');
    const failLogIdx = text.indexOf('probe failed (exit ');
    const restartIdx = text.indexOf('issuing pa bot restart');
    assert.ok(failGateIdx >= 0, 'non-zero exit gate not found');
    assert.ok(failLogIdx >= 0, 'probe-failure log line not found');
    assert.ok(restartIdx >= 0, 'restart decision line not found');
    assert.ok(failGateIdx < failLogIdx && failLogIdx < restartIdx, 'a failed probe must be logged and must precede any restart');
  });

  it('decisions append timestamped lines to the launcher bot log', (t) => {
    if (!existsSync(VBS_PATH)) {
      t.skip('run-bot-hidden.vbs is private-excluded; absent in the public mirror');
      return;
    }
    const text = readFileSync(VBS_PATH, 'utf8');
    assert.ok(
      text.includes(String.raw`OpenTextFile(paHomeDir & "\logs\telegram-bot.log", 8, True)`),
      'decision lines must append to the launcher bot log',
    );
    assert.ok(text.includes(String.raw`f.WriteLine Now & " " & msg`), 'decision lines must carry a timestamp');
  });

  it('the probe is bounded: unawaited spawn, poll deadline, and the deadline precedes any restart', (t) => {
    if (!existsSync(VBS_PATH)) {
      t.skip('run-bot-hidden.vbs is private-excluded; absent in the public mirror');
      return;
    }
    const text = readFileSync(VBS_PATH, 'utf8');
    const spawnIdx = text.indexOf('WshShell.Run "powershell.exe -NoProfile -Command');
    const deadlineIdx = text.indexOf('deadline = DateAdd("s", 20, Now)');
    const timeoutIdx = text.indexOf('gave no verdict in 20s');
    const restartIdx = text.indexOf('issuing pa bot restart');
    assert.ok(spawnIdx >= 0, 'probe spawn not found');
    assert.ok(deadlineIdx >= 0, 'poll deadline not found');
    assert.ok(timeoutIdx >= 0, 'probe-timeout log line not found');
    assert.ok(restartIdx >= 0, 'restart decision line not found');
    assert.ok(
      spawnIdx < deadlineIdx && deadlineIdx < timeoutIdx && timeoutIdx < restartIdx,
      'the probe must be spawned unawaited, polled to a deadline, and only then may a restart follow',
    );
  });

  it('the launcher never awaits a child except the sub-second tasklist gate (starvation pin)', (t) => {
    if (!existsSync(VBS_PATH)) {
      t.skip('run-bot-hidden.vbs is private-excluded; absent in the public mirror');
      return;
    }
    const text = readFileSync(VBS_PATH, 'utf8');
    // The 2026-09-13 production incident: `WshShell.Run cmdLine, 0, True` kept
    // each launcher instance alive for the bot's whole lifetime, and the task's
    // IgnoreNew policy refused every later tick (0x800710E0) — the gate and the
    // watchdog never executed. Only the tasklist gate may await (sub-second,
    // exits on its own).
    for (const line of text.split('\n')) {
      if (line.trim().startsWith("'")) continue;
      if (!line.includes('WshShell.Run')) continue;
      if (line.includes(', 0, True')) {
        assert.ok(line.includes('cmdText'), `awaited spawn outside the tasklist gate (starvation): ${line}`);
      }
    }
    assert.ok(text.includes('WshShell.Run cmdLine, 0, False'), 'the node launch must be unawaited');
    assert.ok(!text.includes('WshShell.Run cmdLine, 0, True'), 'the node launch must never be awaited');
  });
});
