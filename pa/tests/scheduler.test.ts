import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTempPaHome, createTempSkill, cleanup } from './helpers.js';
import { writeLog } from '../src/logger.js';
import {
  getOverdueSkills,
  partitionOverdueByCostTier,
  buildCatchupWatchdogVbs,
  launcherDrift,
  formatLauncherDriftLine,
  CATCHUP_KILL_EXIT_WAIT_ENV,
  DEFAULT_CATCHUP_KILL_EXIT_WAIT_SECS,
  CATCHUP_LOOP_PID_REUSED_DEDUP_KEY,
  CATCHUP_LOOP_PID_REUSED_CAUSE,
} from '../src/scheduler.js';
import { repoRootFromModule } from '../src/lib/git-root.js';
import type { RunMeta } from '../src/types.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

function makeMeta(timestamp: string): RunMeta {
  return {
    worker: 'test',
    status: 'success',
    exitCode: 0,
    duration: 1000,
    timestamp,
  };
}

// Helper: create a skill with cron and optionally a last-run log
async function setupSkill(
  name: string,
  cron: string,
  onMissed: string = 'latest',
  lastRunISO?: string
): Promise<void> {
  await createTempSkill(tempDir, name, [
    '---',
    `cron: "${cron}"`,
    `on_missed: ${onMissed}`,
    '---',
    'Test prompt.',
  ].join('\n'));

  if (lastRunISO) {
    await writeLog(name, 'output', makeMeta(lastRunISO));
  }
}

describe('getOverdueSkills', () => {
  it('returns empty when skill ran recently', async () => {
    // Skill runs hourly; setting lastRun to current time guarantees nextExpected
    // is the top of the next hour (up to 59 minutes in the future), ensuring
    // overdue stays 0 regardless of load or minute/hour boundary crossings.
    const lastRun = new Date().toISOString();
    await setupSkill('recent', '0 * * * *', 'latest', lastRun);
    const overdue = await getOverdueSkills();
    assert.equal(overdue.length, 0);
  });

  it('detects overdue skill in latest mode', async () => {
    // Skill runs every hour, last run was 3 hours ago
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkill('overdue', '0 * * * *', 'latest', threeHoursAgo);
    const overdue = await getOverdueSkills();
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0].skill.name, 'overdue');
  });

  it('latest mode returns most recent missed occurrence', async () => {
    // Skill runs every hour, last run 3 hours ago
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkill('latest-check', '0 * * * *', 'latest', threeHoursAgo);
    const overdue = await getOverdueSkills();
    assert.equal(overdue.length, 1);
    // missedAt should be the most recent past hour mark, not 3 hours ago
    const missedAt = overdue[0].missedAt;
    const now = new Date();
    const hoursSinceMissed = (now.getTime() - missedAt.getTime()) / (60 * 60 * 1000);
    assert.ok(hoursSinceMissed < 1.1, `missedAt should be within the last hour, was ${hoursSinceMissed.toFixed(1)}h ago`);
  });

  it('all mode returns multiple missed runs', async () => {
    // Skill runs every hour, last run 5 hours ago
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await setupSkill('multi', '0 * * * *', 'all', fiveHoursAgo);
    const overdue = await getOverdueSkills();
    // Should have 4-5 missed hourly runs (depends on exact minute)
    assert.ok(overdue.length >= 3, `Expected at least 3 missed runs, got ${overdue.length}`);
    assert.ok(overdue.length <= 6, `Expected at most 6 missed runs, got ${overdue.length}`);
  });

  it('all mode caps at 10', async () => {
    // Skill runs every minute, last run 1 day ago — hundreds of missed runs
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await setupSkill('capped', '* * * * *', 'all', dayAgo);
    const overdue = await getOverdueSkills();
    assert.ok(overdue.length <= 10, `Expected max 10, got ${overdue.length}`);
  });

  it('skip mode returns nothing for overdue skill', async () => {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await setupSkill('skipped', '0 * * * *', 'skip', dayAgo);
    const overdue = await getOverdueSkills();
    assert.equal(overdue.length, 0);
  });

  it('never-run skill returns one entry', async () => {
    // Skill with cron but no logs — never ran
    await setupSkill('fresh', '0 * * * *', 'all');
    const overdue = await getOverdueSkills();
    // Should return exactly 1 (special case for never-run)
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0].skill.name, 'fresh');
    assert.equal(overdue[0].lastRun, null);
  });

  it('treats failed runs as if they never happened (only success resets clock)', async () => {
    // AI-024: getOverdueSkills uses getLastSuccessfulRun — a failed run must NOT
    // reset the overdue clock. Skill runs every hour; the most recent run failed
    // (5 minutes ago) but the last successful run was 3 hours ago → still overdue.
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await createTempSkill(tempDir, 'failed-run', [
      '---',
      'cron: "0 * * * *"',
      'on_missed: latest',
      '---',
      'Test prompt.',
    ].join('\n'));
    // Write a successful run 3 hours ago
    await writeLog('failed-run', 'output', { worker: 'test', status: 'success', exitCode: 0, duration: 1000, timestamp: threeHoursAgo });
    // Write a failed run 5 minutes ago (more recent, but should be ignored)
    await writeLog('failed-run', 'output', { worker: 'test', status: 'error', exitCode: 1, duration: 500, timestamp: fiveMinAgo });
    const overdue = await getOverdueSkills();
    assert.equal(overdue.length, 1, 'skill should be overdue because the failed run does not reset the clock');
    assert.equal(overdue[0].skill.name, 'failed-run');
  });

  it('skills without cron are ignored', async () => {
    await createTempSkill(tempDir, 'no-cron', 'Just a prompt, no schedule.');
    const overdue = await getOverdueSkills();
    assert.equal(overdue.length, 0);
  });

  it('invalid cron expression warns but continues', async () => {
    await createTempSkill(tempDir, 'bad-cron', '---\ncron: "not a cron"\n---\nPrompt.');
    await createTempSkill(tempDir, 'good-cron', '---\ncron: "0 * * * *"\n---\nPrompt.');
    // good-cron has never run so it should be overdue
    const overdue = await getOverdueSkills();
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0].skill.name, 'good-cron');
  });
});

describe('partitionOverdueByCostTier', () => {
  let tempDir2: string;

  beforeEach(async () => {
    tempDir2 = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(tempDir2);
  });

  async function setupSkillWithCostTier(
    name: string,
    cron: string,
    costTier: string = 'anytime',
    lastRunISO?: string
  ): Promise<void> {
    const frontmatter = [
      '---',
      `cron: "${cron}"`,
      `cost_tier: ${costTier}`,
      'on_missed: latest',
      '---',
      'Test prompt.',
    ].join('\n');

    await createTempSkill(tempDir2, name, frontmatter);

    if (lastRunISO) {
      await writeLog(name, 'output', makeMeta(lastRunISO));
    }
  }

  it('anytime skills always run regardless of time window', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('anytime-skill', '0 * * * *', 'anytime', threeHoursAgo);
    const overdue = await getOverdueSkills();

    // Test during peak hours (11:30-19:30 IST = 06:00-14:00 UTC)
    const peakHour = new Date();
    peakHour.setUTCHours(10, 0, 0, 0); // 10:00 UTC = 15:30 IST (peak)

    const partition = await partitionOverdueByCostTier(overdue, peakHour);
    assert.equal(partition.runnable.length, 1, 'anytime skill should run during peak hours');
    assert.equal(partition.deferred.length, 0, 'anytime skill should not be deferred');
  });

  it('off_peak skills run during off-peak window', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('offpeak-skill', '0 * * * *', 'off_peak', threeHoursAgo);
    const overdue = await getOverdueSkills();

    // Test during off-peak hours (19:30-11:30 IST = 14:00-06:00 UTC)
    const offPeakHour = new Date();
    offPeakHour.setUTCHours(15, 0, 0, 0); // 15:00 UTC = 20:30 IST (off-peak)

    const partition = await partitionOverdueByCostTier(overdue, offPeakHour);
    assert.equal(partition.runnable.length, 1, 'off_peak skill should run during off-peak hours');
    assert.equal(partition.deferred.length, 0, 'off_peak skill should not be deferred during off-peak');
  });

  it('off_peak skills are deferred during peak hours', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('offpeak-skill', '0 * * * *', 'off_peak', threeHoursAgo);
    const overdue = await getOverdueSkills();

    // Wednesday 08:00 UTC = 13:30 IST — inside z.ai peak (Mon-Fri 11:30-15:30 IST)
    const peakHour = new Date('2026-08-19T08:00:00Z');

    const partition = await partitionOverdueByCostTier(overdue, peakHour);
    assert.equal(partition.runnable.length, 0, 'off_peak skill should not run during peak hours');
    assert.equal(partition.deferred.length, 1, 'off_peak skill should be deferred during peak');
    assert.ok(
      partition.deferred[0].reason.includes('off_peak skill deferred during peak hours'),
      'deferred reason should mention peak hours'
    );
  });

  it('off_peak skills run at boundary times (peak end)', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('offpeak-skill', '0 * * * *', 'off_peak', threeHoursAgo);
    const overdue = await getOverdueSkills();

    // Wednesday 10:00 UTC = 15:30 IST — peak ends (half-open interval)
    const boundaryTime = new Date('2026-08-19T10:00:00Z');

    const partition = await partitionOverdueByCostTier(overdue, boundaryTime);
    assert.equal(partition.runnable.length, 1, 'off_peak skill should run at 15:30 IST (peak end)');
    assert.equal(partition.deferred.length, 0, 'should not be deferred at boundary');
  });

  it('off_peak skills deferred at peak start boundary', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('offpeak-skill', '0 * * * *', 'off_peak', threeHoursAgo);
    const overdue = await getOverdueSkills();

    // Wednesday 06:00 UTC = 11:30 IST — peak STARTS (deferral begins here)
    const boundaryTime = new Date('2026-08-19T06:00:00Z');

    const partition = await partitionOverdueByCostTier(overdue, boundaryTime);
    assert.equal(partition.runnable.length, 0, 'off_peak skill should be deferred at 11:30 IST (peak start)');
    assert.equal(partition.deferred.length, 1, 'should be deferred at peak start boundary');
  });

  it('off_peak skills are deferred just before off-peak starts', async () => {
    // Fully fixed clock — wall-clock-relative fixtures made this test pass at
    // night and fail when the suite ran during peak hours (found 2026-08-22).
    const justBefore = new Date('2026-08-19T05:59:00Z'); // 11:29 IST
    const threeHoursBeforeBoundary = new Date(justBefore.getTime() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('offpeak-skill', '0 * * * *', 'off_peak', threeHoursBeforeBoundary);
    const overdue = await getOverdueSkills();

    const partition = await partitionOverdueByCostTier(overdue, justBefore);
    assert.equal(partition.runnable.length, 1, 'off_peak skill should run at 11:29 IST (still off-peak)');
    assert.equal(partition.deferred.length, 0, 'should not be deferred just before boundary');
  });

  it('off_peak skills are deferred just after peak starts', async () => {
    // Same fixed-clock discipline (wall-clock independence).
    const justAfter = new Date('2026-08-19T06:01:00Z'); // 11:31 IST
    const threeHoursBeforeBoundary = new Date(justAfter.getTime() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('offpeak-skill', '0 * * * *', 'off_peak', threeHoursBeforeBoundary);
    const overdue = await getOverdueSkills();

    const partition = await partitionOverdueByCostTier(overdue, justAfter);
    assert.equal(partition.runnable.length, 0, 'off_peak skill should not run at 11:31 IST (peak started)');
    assert.equal(partition.deferred.length, 1, 'off_peak skill should be deferred just after peak starts');
  });

  it('mixed skills: anytime runs, off_peak deferred during peak', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('anytime-skill', '0 * * * *', 'anytime', threeHoursAgo);
    await setupSkillWithCostTier('offpeak-skill', '0 * * * *', 'off_peak', threeHoursAgo);
    const overdue = await getOverdueSkills();

    // Wednesday 08:00 UTC = 13:30 IST - inside z.ai peak
    const peakHour = new Date('2026-08-19T08:00:00Z');

    const partition = await partitionOverdueByCostTier(overdue, peakHour);
    assert.equal(partition.runnable.length, 1, 'only anytime skill should run during peak');
    assert.equal(partition.deferred.length, 1, 'off_peak skill should be deferred during peak');
  });

  it('mixed skills: both run during off-peak', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await setupSkillWithCostTier('anytime-skill', '0 * * * *', 'anytime', threeHoursAgo);
    await setupSkillWithCostTier('offpeak-skill', '0 * * * *', 'off_peak', threeHoursAgo);
    const overdue = await getOverdueSkills();

    // Test during off-peak hours
    const offPeakHour = new Date();
    offPeakHour.setUTCHours(15, 0, 0, 0); // 20:30 IST

    const partition = await partitionOverdueByCostTier(overdue, offPeakHour);
    assert.equal(partition.runnable.length, 2, 'both skills should run during off-peak');
    assert.equal(partition.deferred.length, 0, 'no skills should be deferred during off-peak');
  });

  it('skills without cost_tier default to anytime', async () => {
    // Create skill without cost_tier field
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await createTempSkill(tempDir2, 'default-skill', [
      '---',
      'cron: "0 * * * *"',
      'on_missed: latest',
      '---',
      'Test prompt.',
    ].join('\n'));
    await writeLog('default-skill', 'output', makeMeta(threeHoursAgo));

    const overdue = await getOverdueSkills();

    // Wednesday 08:00 UTC = 13:30 IST - inside z.ai peak
    const peakHour = new Date('2026-08-19T08:00:00Z');

    const partition = await partitionOverdueByCostTier(overdue, peakHour);
    assert.equal(partition.runnable.length, 1, 'skill without cost_tier should default to anytime');
    assert.equal(partition.deferred.length, 0, 'should not be deferred');
  });
});

describe('buildCatchupWatchdogVbs (lane-progress launcher)', () => {
  const paPathCmd = 'C:\\Program Files\\pa\\pa.cmd';
  const args = 'catchup --loop';
  const root = 'D:\\Personal Assistant';
  const paths = {
    lockPath: 'C:\\Users\\me\\.pa\\catchup-loop.lock',
    lanesDir: 'C:\\Users\\me\\.pa\\catchup-lanes',
    stallMarkerPath: 'C:\\Users\\me\\.pa\\catchup-loop.stalled',
    stallRecordsPath: 'C:\\Users\\me\\.pa\\stall-records.jsonl',
    pageBodyPath: 'C:\\Users\\me\\.pa\\catchup-loop-page.txt',
  };

  it('matches the golden launcher text', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    const EXPECTED = [
      `Set WshShell = CreateObject("WScript.Shell")`,
      `Set fso = CreateObject("Scripting.FileSystemObject")`,
      `WshShell.CurrentDirectory = "${root}"`,
      `lockPath = "${paths.lockPath}"`,
      `lanesDir = "${paths.lanesDir}"`,
      `laneNames = Array("default", "reminders", "maintenance")`,
      `stallMarkerPath = "${paths.stallMarkerPath}"`,
      `stallRecordsPath = "${paths.stallRecordsPath}"`,
      `pageBodyPath = "${paths.pageBodyPath}"`,
      `heartbeatStaleSecs = 300`,
      `Set procEnv = WshShell.Environment("Process")`,
      `If procEnv("UV_THREADPOOL_SIZE") = "" Then procEnv("UV_THREADPOOL_SIZE") = "16"`,
      `killExitWaitSecs = ReadWaitSecs(procEnv("${CATCHUP_KILL_EXIT_WAIT_ENV}"), ${DEFAULT_CATCHUP_KILL_EXIT_WAIT_SECS})`,
      `cause = ""`,
      `pageSeverity = "error"`,
      `pageDedupKey = "catchup-loop-stalled"`,
      `pid = ReadPidFile(lockPath)`,
      `If PidIsLiveNode(pid) Then`,
      `  cause = StaleCause(lockPath, lanesDir, laneNames, heartbeatStaleSecs)`,
      `  If cause = "" Then WScript.Quit 0`,
      `  If CommandLineIsOtherProcess(pid) Then`,
      `    cause = "${CATCHUP_LOOP_PID_REUSED_CAUSE}"`,
      `    marker = ConsumeStallMarker(stallMarkerPath)`,
      `    If marker <> "" Then cause = cause & "; " & marker`,
      `    AppendLauncherRecord stallRecordsPath, pid, "pid-reused", cause`,
      `    pageSeverity = "warn"`,
      `    pageDedupKey = "${CATCHUP_LOOP_PID_REUSED_DEDUP_KEY}"`,
      `  Else`,
      `    marker = ConsumeStallMarker(stallMarkerPath)`,
      `    If marker <> "" Then cause = cause & "; " & marker`,
      `    AppendLauncherRecord stallRecordsPath, pid, "lane-progress", cause`,
      `    WshShell.Run "cmd /c taskkill /F /PID " & pid, 0, True`,
      `    If Not LoopExitedWithin(pid, killExitWaitSecs) Then cause = cause & "; killed catchup loop did not exit within " & killExitWaitSecs & " s; relaunched anyway - a stale write may land"`,
      `  End If`,
      `Else`,
      `  cause = ConsumeStallMarker(stallMarkerPath)`,
      `End If`,
      `WshShell.Run "cmd /c """"${paPathCmd}"" ${args}""", 0, False`,
      `If cause <> "" Then`,
      `  WriteText pageBodyPath, "Catchup loop restarted by its watchdog." & vbCrLf & "Cause: " & cause`,
      `  WshShell.Run "cmd /c """"${paPathCmd}"" notify --subject ""Catchup loop restarted"" --body-file ""${paths.pageBodyPath}"" --dedup-key " & pageDedupKey & " --severity " & pageSeverity & """", 0, False`,
      `End If`,
      ``,
      `' Reads the loop's PID from its lock file; 0 when missing or unparseable.`,
      `Function ReadPidFile(path)`,
      `  Dim text`,
      `  ReadPidFile = 0`,
      `  If Not fso.FileExists(path) Then Exit Function`,
      `  On Error Resume Next`,
      `  text = Trim(fso.OpenTextFile(path, 1).ReadAll())`,
      `  If Err.Number <> 0 Then Err.Clear : Exit Function`,
      `  On Error GoTo 0`,
      `  If IsNumeric(text) Then ReadPidFile = CLng(text)`,
      `End Function`,
      ``,
      `' Seconds to wait for a killed loop to exit: the environment value when it is a`,
      `' whole number from 1 to 9999, otherwise the default baked in at sync time.`,
      `Function ReadWaitSecs(text, defaultSecs)`,
      `  Dim re`,
      `  ReadWaitSecs = defaultSecs`,
      `  Set re = New RegExp`,
      `  re.Pattern = "^[1-9][0-9]{0,3}$"`,
      `  If re.Test(text) Then ReadWaitSecs = CLng(text)`,
      `End Function`,
      ``,
      `' Liveness gate: true only when a live node.exe holds this PID. Anything else -`,
      `' missing lock file, unparseable PID, dead process, a non-node process that`,
      `' reused the PID, an unexpected tasklist result - reads as NOT live, so the`,
      `' worst case is one wasted launch that exits on the real lock. Never the`,
      `' reverse: a false "alive" would leave the service down forever.`,
      `Function PidIsLiveNode(pid)`,
      `  Dim cmdText`,
      `  PidIsLiveNode = False`,
      `  If Not IsNumeric(pid) Then Exit Function`,
      `  If CDbl(pid) <= 0 Then Exit Function`,
      `  cmdText = "cmd /c tasklist /NH /FI ""PID eq " & CLng(pid) & """ /FI ""IMAGENAME eq node.exe"" | find /I ""node.exe"" >nul"`,
      `  PidIsLiveNode = (WshShell.Run(cmdText, 0, True) = 0)`,
      `End Function`,
      ``,
      `' True only when WMI positively reports a command line for this PID that is not`,
      `' the catchup loop's - the dead loop's PID was reused by another process, which`,
      `' must never be killed. Any WMI error or an empty command line reads as False,`,
      `' so the worst case stays one extra kill and relaunch, never a silent skip.`,
      `Function CommandLineIsOtherProcess(pid)`,
      `  Dim procs, proc, cmdLine`,
      `  CommandLineIsOtherProcess = False`,
      `  cmdLine = ""`,
      `  On Error Resume Next`,
      `  Set procs = GetObject("winmgmts:\\\\.\\root\\cimv2").ExecQuery("SELECT CommandLine FROM Win32_Process WHERE ProcessId = " & CLng(pid))`,
      `  If Err.Number <> 0 Then Err.Clear : Exit Function`,
      `  For Each proc In procs`,
      `    cmdLine = proc.CommandLine`,
      `  Next`,
      `  If Err.Number <> 0 Then Err.Clear : Exit Function`,
      `  On Error GoTo 0`,
      `  If IsNull(cmdLine) Then Exit Function`,
      `  If Len(cmdLine) = 0 Then Exit Function`,
      `  CommandLineIsOtherProcess = Not (InStr(1, cmdLine, "catchup", vbTextCompare) > 0 And InStr(1, cmdLine, "--loop", vbTextCompare) > 0)`,
      `End Function`,
      ``,
      `' Polls every 2 s until the killed loop is gone: its PID is no longer a live`,
      `' node.exe, or it now runs another command line. False when it is still the`,
      `' loop after waitSecs. It polls before sleeping, so a loop that has already`,
      `' exited costs no wait. Timer counts seconds since midnight, hence the wrap.`,
      `Function LoopExitedWithin(pid, waitSecs)`,
      `  Dim started, elapsed`,
      `  LoopExitedWithin = True`,
      `  started = Timer`,
      `  Do While PidIsLiveNode(pid)`,
      `    If CommandLineIsOtherProcess(pid) Then Exit Function`,
      `    elapsed = Timer - started`,
      `    If elapsed < 0 Then elapsed = elapsed + 86400`,
      `    If elapsed >= waitSecs Then`,
      `      LoopExitedWithin = False`,
      `      Exit Function`,
      `    End If`,
      `    WScript.Sleep 2000`,
      `  Loop`,
      `End Function`,
      ``,
      `' Seconds since the file was last written. A missing file or any FSO error`,
      `' reads as infinitely old, so the worst case is one extra kill and relaunch.`,
      `Function FileAgeSecs(path)`,
      `  Dim modified`,
      `  FileAgeSecs = 2147483647`,
      `  If Not fso.FileExists(path) Then Exit Function`,
      `  On Error Resume Next`,
      `  modified = fso.GetFile(path).DateLastModified`,
      `  If Err.Number <> 0 Then Err.Clear : Exit Function`,
      `  On Error GoTo 0`,
      `  FileAgeSecs = DateDiff("s", modified, Now())`,
      `End Function`,
      ``,
      `' First line of a small text file, trimmed; empty on any error.`,
      `Function ReadFirstLine(path)`,
      `  Dim text`,
      `  ReadFirstLine = ""`,
      `  If Not fso.FileExists(path) Then Exit Function`,
      `  On Error Resume Next`,
      `  text = fso.OpenTextFile(path, 1).ReadAll()`,
      `  If Err.Number <> 0 Then Err.Clear : Exit Function`,
      `  On Error GoTo 0`,
      `  text = Replace(text, vbCr, "")`,
      `  If InStr(text, vbLf) > 0 Then text = Left(text, InStr(text, vbLf) - 1)`,
      `  ReadFirstLine = Trim(text)`,
      `End Function`,
      ``,
      `' Empty when the heartbeat and every lane progress file are fresh; otherwise`,
      `' names the first stale file in lane order, with that lane's last breadcrumb.`,
      `Function StaleCause(lock, dir, lanes, staleSecs)`,
      `  Dim lane, laneFile`,
      `  StaleCause = ""`,
      `  If FileAgeSecs(lock) > staleSecs Then`,
      `    StaleCause = "heartbeat stale"`,
      `    Exit Function`,
      `  End If`,
      `  For Each lane In lanes`,
      `    laneFile = dir & "\\" & lane`,
      `    If FileAgeSecs(laneFile) > staleSecs Then`,
      `      StaleCause = "lane " & lane & " stale" & CrumbSuffix(ReadFirstLine(laneFile))`,
      `      Exit Function`,
      `    End If`,
      `  Next`,
      `End Function`,
      ``,
      `' " at <phase>[: <detail>]" from a "<ts>|<lane>|<phase>|<detail>" breadcrumb.`,
      `Function CrumbSuffix(crumb)`,
      `  Dim parts`,
      `  CrumbSuffix = ""`,
      `  parts = Split(crumb, "|")`,
      `  If UBound(parts) < 2 Then Exit Function`,
      `  CrumbSuffix = " at " & parts(2)`,
      `  If UBound(parts) >= 3 Then`,
      `    If Len(parts(3)) > 0 Then CrumbSuffix = CrumbSuffix & ": " & parts(3)`,
      `  End If`,
      `End Function`,
      ``,
      `' Reads and deletes the loop's store-stall marker; empty when absent.`,
      `Function ConsumeStallMarker(path)`,
      `  ConsumeStallMarker = ""`,
      `  If Not fso.FileExists(path) Then Exit Function`,
      `  ConsumeStallMarker = ReadFirstLine(path)`,
      `  If ConsumeStallMarker = "" Then ConsumeStallMarker = "store stall"`,
      `  On Error Resume Next`,
      `  fso.DeleteFile path, True`,
      `  Err.Clear`,
      `  On Error GoTo 0`,
      `End Function`,
      ``,
      `' Appends one JSON line of launcher evidence; best-effort.`,
      `Sub AppendLauncherRecord(path, pid, store, cause)`,
      `  Dim f`,
      `  On Error Resume Next`,
      `  Set f = fso.OpenTextFile(path, 8, True)`,
      `  If Err.Number <> 0 Then Err.Clear : Exit Sub`,
      `  f.WriteLine "{""ts"":""" & IsoNow() & """,""pid"":" & CLng(pid) & ",""host"":""launcher"",""store"":""" & store & """,""cause"":""" & JsonSafe(cause) & """}"`,
      `  f.Close`,
      `  Err.Clear`,
      `  On Error GoTo 0`,
      `End Sub`,
      ``,
      `' Escapes backslash, then double quote, for a JSON string value.`,
      `Function JsonSafe(text)`,
      `  JsonSafe = Replace(Replace(text, "\\", "\\\\"), """", "\\""")`,
      `End Function`,
      ``,
      `' Local time as yyyy-mm-ddThh:nn:ss (no zone suffix).`,
      `Function IsoNow()`,
      `  Dim t`,
      `  t = Now()`,
      `  IsoNow = Year(t) & "-" & Right("0" & Month(t), 2) & "-" & Right("0" & Day(t), 2) & "T" & Right("0" & Hour(t), 2) & ":" & Right("0" & Minute(t), 2) & ":" & Right("0" & Second(t), 2)`,
      `End Function`,
      ``,
      `' Overwrites a small text file; best-effort.`,
      `Sub WriteText(path, text)`,
      `  Dim f`,
      `  On Error Resume Next`,
      `  Set f = fso.CreateTextFile(path, True)`,
      `  If Err.Number <> 0 Then Err.Clear : Exit Sub`,
      `  f.Write text`,
      `  f.Close`,
      `  Err.Clear`,
      `  On Error GoTo 0`,
      `End Sub`,
    ].join('\n') + '\n';
    assert.equal(vbs, EXPECTED);
  });

  it('sets CurrentDirectory to the repo root before any Run', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    const currentDirIndex = vbs.indexOf(`WshShell.CurrentDirectory = "${root}"`);
    const runIndex = vbs.indexOf('WshShell.Run');
    assert.ok(currentDirIndex >= 0 && runIndex >= 0 && currentDirIndex < runIndex);
  });

  it('doubles embedded double-quotes in repoRoot, lockPath and pageBodyPath', () => {
    const weirdPaths = { ...paths, lockPath: 'D:\\Weird"Lock.txt', pageBodyPath: 'D:\\Weird"Body.txt' };
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, 'D:\\Weird"Path', weirdPaths);
    assert.ok(vbs.includes('WshShell.CurrentDirectory = "D:\\Weird""Path"'));
    assert.ok(vbs.includes('lockPath = "D:\\Weird""Lock.txt"'));
    assert.ok(vbs.includes('pageBodyPath = "D:\\Weird""Body.txt"'));
    assert.ok(vbs.includes('--body-file ""D:\\Weird""Body.txt""'));
  });

  it('relaunches without waiting through a fully wrapped cmd line', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    assert.ok(vbs.includes(`WshShell.Run "cmd /c """"${paPathCmd}"" catchup --loop""", 0, False`));
  });

  it('the only awaited Runs are the tasklist gate and the taskkill', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    const awaited = vbs.split('\n').filter((l) => l.includes(', 0, True'));
    assert.equal(awaited.length, 2);
    for (const l of awaited) assert.ok(l.includes('cmdText') || l.includes('taskkill /F /PID'));
  });

  it('keeps the PidIsLiveNode gate with both filters and the find pipe', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    assert.ok(vbs.includes('Function PidIsLiveNode(pid)'));
    assert.ok(vbs.includes('/FI ""PID eq " & CLng(pid)'));
    assert.ok(vbs.includes('/FI ""IMAGENAME eq node.exe""'));
    assert.ok(vbs.includes('| find /I ""node.exe""'));
  });

  it('quits only when the PID is live and StaleCause is empty, before anything is killed or launched', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    const iLive = vbs.indexOf('If PidIsLiveNode(pid) Then');
    const iStale = vbs.indexOf('cause = StaleCause(lockPath, lanesDir, laneNames, heartbeatStaleSecs)');
    const iQuit = vbs.indexOf('If cause = "" Then WScript.Quit 0');
    const iKill = vbs.indexOf('WshShell.Run "cmd /c taskkill');
    const iRelaunch = vbs.indexOf(`WshShell.Run "cmd /c """"${paPathCmd}"" catchup --loop`);
    assert.ok(iLive >= 0 && iLive < iStale);
    assert.ok(iStale < iQuit);
    assert.ok(iQuit < iKill);
    assert.ok(iKill < iRelaunch);
  });

  it('records kill evidence before the taskkill and relaunches after it', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    const iRecord = vbs.indexOf('AppendLauncherRecord stallRecordsPath, pid, "lane-progress", cause');
    const iKill = vbs.indexOf('WshShell.Run "cmd /c taskkill /F /PID " & pid');
    const iRelaunch = vbs.indexOf(`WshShell.Run "cmd /c """"${paPathCmd}"" catchup --loop`);
    assert.ok(iRecord >= 0 && iRecord < iKill && iKill < iRelaunch);
  });

  it('checks the lanes in CATCHUP_LOOP_LANES order', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    assert.ok(vbs.includes('laneNames = Array("default", "reminders", "maintenance")'));
    const vbsAlt = buildCatchupWatchdogVbs(paPathCmd, args, root, paths, undefined, ['alpha', 'beta']);
    assert.ok(vbsAlt.includes('laneNames = Array("alpha", "beta")'));
    assert.throws(() => buildCatchupWatchdogVbs(paPathCmd, args, root, paths, undefined, ['Bad Lane']));
  });

  it('bakes the staleness threshold in seconds (default 300, custom 90)', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    assert.ok(vbs.includes('heartbeatStaleSecs = 300'));
    const vbs90 = buildCatchupWatchdogVbs(paPathCmd, args, root, paths, 90_000);
    assert.ok(vbs90.includes('heartbeatStaleSecs = 90'));
  });

  it('pages through pa notify only when a cause exists', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    const notifyLine = `  WshShell.Run "cmd /c """"${paPathCmd}"" notify --subject ""Catchup loop restarted"" --body-file ""${paths.pageBodyPath}"" --dedup-key " & pageDedupKey & " --severity " & pageSeverity & """", 0, False`;
    assert.ok(vbs.includes(notifyLine));
    const iIf = vbs.indexOf('If cause <> "" Then');
    const iRelaunch = vbs.indexOf(`WshShell.Run "cmd /c """"${paPathCmd}"" catchup --loop`);
    const iNotify = vbs.indexOf(notifyLine);
    assert.ok(iIf > iRelaunch);
    assert.ok(iNotify > iIf);
  });

  it('sets UV_THREADPOOL_SIZE only when the process environment lacks it', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    assert.ok(vbs.includes('If procEnv("UV_THREADPOOL_SIZE") = "" Then procEnv("UV_THREADPOOL_SIZE") = "16"'));
  });

  it('a missing or unreadable file reads as infinitely old', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    const fnStart = vbs.indexOf('Function FileAgeSecs');
    const fnBody = vbs.slice(fnStart);
    const iDefault = fnBody.indexOf('FileAgeSecs = 2147483647');
    const iGuard = fnBody.indexOf('If Not fso.FileExists(path) Then Exit Function');
    assert.ok(iDefault >= 0 && iGuard >= 0 && iDefault < iGuard);
  });

  it('JsonSafe escapes backslash before double quote', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    assert.ok(vbs.includes('JsonSafe = Replace(Replace(text, "\\", "\\\\"), """", "\\""")'));
  });

  it('never kills a live PID whose command line is not the catchup loop', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    assert.ok(vbs.includes('Function CommandLineIsOtherProcess(pid)'));
    assert.ok(vbs.includes('CommandLineIsOtherProcess = Not (InStr(1, cmdLine, "catchup", vbTextCompare) > 0 And InStr(1, cmdLine, "--loop", vbTextCompare) > 0)'));
    const iCheck = vbs.indexOf('If CommandLineIsOtherProcess(pid) Then');
    const iRecord = vbs.indexOf('AppendLauncherRecord stallRecordsPath, pid, "lane-progress", cause');
    assert.ok(iCheck >= 0 && iCheck < iRecord);
  });

  it('waits for the killed PID to exit before relaunching, bounded by PA_CATCHUP_KILL_EXIT_WAIT_S', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    assert.equal(CATCHUP_KILL_EXIT_WAIT_ENV, 'PA_CATCHUP_KILL_EXIT_WAIT_S');
    assert.equal(DEFAULT_CATCHUP_KILL_EXIT_WAIT_SECS, 120);
    assert.ok(vbs.includes('killExitWaitSecs = ReadWaitSecs(procEnv("PA_CATCHUP_KILL_EXIT_WAIT_S"), 120)'));
    assert.ok(vbs.includes('  re.Pattern = "^[1-9][0-9]{0,3}$"'));
    const iKill = vbs.indexOf('WshShell.Run "cmd /c taskkill /F /PID " & pid, 0, True');
    const iWait = vbs.indexOf('If Not LoopExitedWithin(pid, killExitWaitSecs) Then cause = cause & "; killed catchup loop did not exit within " & killExitWaitSecs & " s; relaunched anyway - a stale write may land"');
    const iRelaunch = vbs.indexOf(`WshShell.Run "cmd /c """"${paPathCmd}"" catchup --loop""", 0, False`);
    assert.ok(iKill >= 0 && iKill < iWait);
    assert.ok(iWait < iRelaunch);
  });

  it('polls before sleeping, every 2 s, and treats a reused PID as exited', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    const start = vbs.indexOf('Function LoopExitedWithin(pid, waitSecs)');
    const end = vbs.indexOf('End Function', start);
    const body = vbs.slice(start, end);
    const iDo = body.indexOf('  Do While PidIsLiveNode(pid)');
    const iOther = body.indexOf('    If CommandLineIsOtherProcess(pid) Then Exit Function');
    const iElapsed = body.indexOf('    If elapsed >= waitSecs Then');
    const iSleep = body.indexOf('    WScript.Sleep 2000');
    assert.ok(iDo >= 0 && iDo < iOther && iOther < iElapsed && iElapsed < iSleep);
    assert.equal((vbs.match(/WScript\.Sleep/g) ?? []).length, 1);
  });

  it('a reused PID records evidence and pages once as catchup-loop-pid-reused at warn without any kill', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    const start = vbs.indexOf('  If CommandLineIsOtherProcess(pid) Then\n');
    const end = vbs.indexOf('\n  Else\n', start);
    const body = vbs.slice(start, end);
    assert.ok(body.includes(`    cause = "${CATCHUP_LOOP_PID_REUSED_CAUSE}"`));
    assert.ok(body.includes('    AppendLauncherRecord stallRecordsPath, pid, "pid-reused", cause'));
    assert.ok(body.includes('    pageSeverity = "warn"'));
    assert.ok(body.includes('    pageDedupKey = "catchup-loop-pid-reused"'));
    assert.ok(!body.includes('taskkill'));
    assert.equal(CATCHUP_LOOP_PID_REUSED_DEDUP_KEY, 'catchup-loop-pid-reused');
    assert.equal(CATCHUP_LOOP_PID_REUSED_CAUSE, 'catchup loop was not running (recorded PID now belongs to another process); relaunched');
  });

  it('every page goes through one notify tail whose severity and dedup key default to the stall family', () => {
    const vbs = buildCatchupWatchdogVbs(paPathCmd, args, root, paths);
    const iSeverity = vbs.indexOf('pageSeverity = "error"');
    const iDedup = vbs.indexOf('pageDedupKey = "catchup-loop-stalled"');
    const iPid = vbs.indexOf('pid = ReadPidFile(lockPath)');
    assert.ok(iSeverity >= 0 && iSeverity < iPid);
    assert.ok(iDedup >= 0 && iDedup < iPid);
    const notifyLines = vbs.split('\n').filter((l) => l.includes(' notify --subject '));
    assert.equal(notifyLines.length, 1);
    assert.ok(notifyLines[0].includes('--dedup-key " & pageDedupKey & " --severity " & pageSeverity & """", 0, False'));
  });
});

describe('launcher drift (pa schedules list)', () => {
  it('launcherDrift distinguishes missing, in-sync and out-of-sync', () => {
    assert.equal(launcherDrift(null, 'x'), 'missing');
    assert.equal(launcherDrift('x', 'x'), 'in-sync');
    assert.equal(launcherDrift('y', 'x'), 'out-of-sync');
  });

  it('formatLauncherDriftLine renders the three states exactly', () => {
    assert.equal(formatLauncherDriftLine('P', 'in-sync'), 'Launcher P: in sync with this build');
    assert.equal(formatLauncherDriftLine('P', 'out-of-sync'), 'Launcher P: OUT OF SYNC with this build — run `pa schedules sync`');
    assert.equal(formatLauncherDriftLine('P', 'missing'), 'Launcher P: MISSING — run `pa schedules sync`');
  });
});

describe('pa schedules sync and the legacy reminders task', () => {
  it('sync never retires the legacy reminders task and prints the proof-gated advisory', async () => {
    const repoRoot = await repoRootFromModule(__filename);
    const src = readFileSync(`${repoRoot}/pa/src/scheduler.ts`, 'utf8');
    assert.ok(!src.includes('schtasks /delete /tn "${remindersName}"'));
    assert.ok(!src.includes("Retired '"));
    assert.ok(!src.includes('remindersPattern'));
    const count = src.split('Retiring the legacy reminders task').length - 1;
    assert.equal(count, 2);
  });
});
