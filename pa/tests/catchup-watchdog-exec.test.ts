import './test-env-guard.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildCatchupWatchdogVbs, buildCatchupWatchdogShScript } from '../src/scheduler.js';
import { formatLaneBreadcrumb } from '../src/lib/catchup-contract.js';

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'pa wd '));
  mkdirSync(join(home, 'catchup-lanes'), { recursive: true });
  mkdirSync(join(home, 'fake pa'), { recursive: true });
  return home;
}

function fakePaPaths(home: string): { js: string; win: string; posix: string } {
  const dir = join(home, 'fake pa');
  const js = join(dir, 'fake-pa.js');
  writeFileSync(
    js,
    `require('fs').appendFileSync(process.env.PA_FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), uv: process.env.UV_THREADPOOL_SIZE ?? null }) + '\\n');`,
    'utf8'
  );
  const win = join(dir, 'pa.cmd');
  writeFileSync(win, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`, 'utf8');
  const posix = join(dir, 'pa');
  writeFileSync(posix, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, 'utf8');
  try {
    chmodSync(posix, 0o755);
  } catch {
    // best-effort on platforms without chmod semantics
  }
  return { js, win, posix };
}

function liveNode(args: string[] = ['catchup', '--loop']) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)', ...args], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return child;
}

function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '0']);
  return result.pid!;
}

function stale(path: string): void {
  const t = new Date(Date.now() - 10 * 60_000);
  utimesSync(path, t, t);
}

function fresh(home: string, pid: number): void {
  writeFileSync(join(home, 'catchup-loop.lock'), String(pid), 'utf8');
  const now = new Date().toISOString();
  for (const lane of ['default', 'reminders', 'maintenance']) {
    writeFileSync(join(home, 'catchup-lanes', lane), formatLaneBreadcrumb(now, lane, 'tick-end'), 'utf8');
  }
}

async function waitLines(file: string, n: number, ms: number): Promise<string[]> {
  const start = Date.now();
  for (;;) {
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
      if (lines.length >= n) return lines;
    }
    if (Date.now() - start > ms) throw new Error(`waitLines: ${file} did not reach ${n} lines within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function watchdogPaths(home: string) {
  return {
    lockPath: join(home, 'catchup-loop.lock'),
    lanesDir: join(home, 'catchup-lanes'),
    stallMarkerPath: join(home, 'catchup-loop.stalled'),
    stallRecordsPath: join(home, 'stall-records.jsonl'),
    pageBodyPath: join(home, 'catchup-loop-page.txt'),
  };
}

function baseEnv(home: string, fake: { win: string; posix: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    const upper = k.toUpperCase();
    if (upper === 'PATH' || upper === 'UV_THREADPOOL_SIZE' || upper === 'PA_CATCHUP_KILL_EXIT_WAIT_S') continue;
    env[k] = v;
  }
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    env.PATH = `${systemRoot}\\System32;${dirname(process.execPath)};${process.env.PATH ?? ''}`;
  } else {
    env.PATH = process.env.PATH ?? '';
  }
  env.PA_FAKE_OUT = join(home, 'fake-pa.jsonl');
  env.PA_CATCHUP_KILL_EXIT_WAIT_S = '3';
  return env;
}

function fakeBin(home: string): string {
  const dir = join(home, 'fake bin');
  mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'taskkill.cmd'), '@exit /b 0\r\n', 'utf8');
  } else {
    const ps = join(dir, 'ps');
    writeFileSync(
      ps,
      `#!/bin/sh\ncase "$*" in\n  *stat=*) echo S ;;\n  *) echo 'node pa catchup --loop' ;;\nesac\n`,
      'utf8'
    );
    try {
      chmodSync(ps, 0o755);
    } catch {
      // best-effort
    }
  }
  return dir;
}

function isRunning(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function runLauncherWindows(vbsPath: string, env: NodeJS.ProcessEnv): { status: number | null; elapsedMs: number } {
  const start = Date.now();
  const cscript = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cscript.exe');
  const result = spawnSync(cscript, ['//NoLogo', vbsPath], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const elapsedMs = Date.now() - start;
  assert.equal(result.status, 0, `cscript failed: ${result.stderr}`);
  assert.equal(result.stderr, '');
  return { status: result.status, elapsedMs };
}

function runLauncherPosix(scriptPath: string, env: NodeJS.ProcessEnv): { status: number | null; elapsedMs: number } {
  const start = Date.now();
  const result = spawnSync('/bin/sh', [scriptPath], { env, encoding: 'utf8', timeout: 60_000 });
  const elapsedMs = Date.now() - start;
  assert.equal(result.status, 0, `sh failed: ${result.stderr}`);
  return { status: result.status, elapsedMs };
}

describe('catchup watchdog launcher (real processes)', () => {
  it('win32: a live PID with a fresh heartbeat and fresh lane files is left alone', { skip: process.platform !== 'win32', timeout: 90_000 }, async () => {
    const home = makeHome();
    const fake = fakePaPaths(home);
    const child = liveNode();
    try {
      fresh(home, child.pid!);
      const vbsPath = join(home, 'watchdog.vbs');
      const vbs = buildCatchupWatchdogVbs(fake.win.replace(/"/g, '""'), 'catchup --loop', home, watchdogPaths(home), 300_000);
      writeFileSync(vbsPath, vbs, 'utf8');
      runLauncherWindows(vbsPath, baseEnv(home, fake));
      await new Promise((r) => setTimeout(r, 3000));
      assert.ok(!existsSync(join(home, 'fake-pa.jsonl')));
      assert.ok(isRunning(child));
    } finally {
      if (isRunning(child)) child.kill();
    }
  });

  it('win32: a live PID whose reminders lane file is stale is killed, relaunched and paged with evidence', { skip: process.platform !== 'win32', timeout: 90_000 }, async () => {
    const home = makeHome();
    const fake = fakePaPaths(home);
    const child = liveNode();
    try {
      fresh(home, child.pid!);
      writeFileSync(join(home, 'catchup-lanes', 'reminders'), '2026-09-16T10:00:00.000Z|reminders|drill-wedge|', 'utf8');
      stale(join(home, 'catchup-lanes', 'reminders'));
      writeFileSync(join(home, 'catchup-loop.stalled'), 'store stall: a"b\\c', 'utf8');
      const vbsPath = join(home, 'watchdog.vbs');
      const vbs = buildCatchupWatchdogVbs(fake.win.replace(/"/g, '""'), 'catchup --loop', home, watchdogPaths(home), 300_000);
      writeFileSync(vbsPath, vbs, 'utf8');
      runLauncherWindows(vbsPath, baseEnv(home, fake));
      await new Promise((r) => setTimeout(r, 10_000));
      assert.ok(!isRunning(child));
      const recordLines = readFileSync(join(home, 'stall-records.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0);
      assert.equal(recordLines.length, 1);
      const record = JSON.parse(recordLines[0]);
      assert.equal(record.host, 'launcher');
      assert.equal(record.store, 'lane-progress');
      assert.equal(record.pid, child.pid);
      assert.equal(record.cause, 'lane reminders stale at drill-wedge; store stall: a"b\\c');
      assert.ok(!existsSync(join(home, 'catchup-loop.stalled')));
      const out = join(home, 'fake-pa.jsonl');
      const lines = await waitLines(out, 2, 15000);
      const argvs = lines.map((l) => JSON.parse(l));
      const asSets = argvs.map((r) => JSON.stringify(r.argv));
      assert.ok(asSets.includes(JSON.stringify(['catchup', '--loop'])));
      assert.ok(
        asSets.includes(
          JSON.stringify(['notify', '--subject', 'Catchup loop restarted', '--body-file', watchdogPaths(home).pageBodyPath, '--dedup-key', 'catchup-loop-stalled', '--severity', 'error'])
        )
      );
      for (const r of argvs) assert.equal(r.uv, '16');
      const body = readFileSync(watchdogPaths(home).pageBodyPath, 'utf8');
      assert.equal(body, 'Catchup loop restarted by its watchdog.\r\nCause: lane reminders stale at drill-wedge; store stall: a"b\\c');
    } finally {
      if (isRunning(child)) child.kill();
    }
  });

  it('win32: a live PID whose heartbeat is stale is killed with cause heartbeat stale', { skip: process.platform !== 'win32', timeout: 90_000 }, async () => {
    const home = makeHome();
    const fake = fakePaPaths(home);
    const child = liveNode();
    try {
      fresh(home, child.pid!);
      stale(join(home, 'catchup-loop.lock'));
      const vbsPath = join(home, 'watchdog.vbs');
      const vbs = buildCatchupWatchdogVbs(fake.win.replace(/"/g, '""'), 'catchup --loop', home, watchdogPaths(home), 300_000);
      writeFileSync(vbsPath, vbs, 'utf8');
      runLauncherWindows(vbsPath, baseEnv(home, fake));
      await new Promise((r) => setTimeout(r, 10_000));
      const recordLines = readFileSync(join(home, 'stall-records.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0);
      assert.equal(recordLines.length, 1);
      const record = JSON.parse(recordLines[0]);
      assert.equal(record.cause, 'heartbeat stale');
      const out = join(home, 'fake-pa.jsonl');
      const lines = await waitLines(out, 2, 15000);
      assert.equal(lines.length, 2);
    } finally {
      if (isRunning(child)) child.kill();
    }
  });

  it('win32: a dead PID with no marker is relaunched without a page', { skip: process.platform !== 'win32', timeout: 90_000 }, async () => {
    const home = makeHome();
    const fake = fakePaPaths(home);
    writeFileSync(join(home, 'catchup-loop.lock'), String(deadPid()), 'utf8');
    const vbsPath = join(home, 'watchdog.vbs');
    const vbs = buildCatchupWatchdogVbs(fake.win.replace(/"/g, '""'), 'catchup --loop', home, watchdogPaths(home), 300_000);
    writeFileSync(vbsPath, vbs, 'utf8');
    runLauncherWindows(vbsPath, baseEnv(home, fake));
    const out = join(home, 'fake-pa.jsonl');
    await waitLines(out, 1, 15000);
    await new Promise((r) => setTimeout(r, 2000));
    const lines = readFileSync(out, 'utf8').split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]).argv, ['catchup', '--loop']);
    assert.ok(!existsSync(join(home, 'stall-records.jsonl')));
    assert.ok(!existsSync(watchdogPaths(home).pageBodyPath));
  });

  it('win32: a dead PID with a stall marker is relaunched and paged with the marker as the cause', { skip: process.platform !== 'win32', timeout: 90_000 }, async () => {
    const home = makeHome();
    const fake = fakePaPaths(home);
    writeFileSync(join(home, 'catchup-loop.lock'), String(deadPid()), 'utf8');
    writeFileSync(join(home, 'catchup-loop.stalled'), 'store stall: maintenance-state (maintenance-state.json)', 'utf8');
    const vbsPath = join(home, 'watchdog.vbs');
    const vbs = buildCatchupWatchdogVbs(fake.win.replace(/"/g, '""'), 'catchup --loop', home, watchdogPaths(home), 300_000);
    writeFileSync(vbsPath, vbs, 'utf8');
    runLauncherWindows(vbsPath, baseEnv(home, fake));
    const out = join(home, 'fake-pa.jsonl');
    const lines = await waitLines(out, 2, 15000);
    assert.equal(lines.length, 2);
    const body = readFileSync(watchdogPaths(home).pageBodyPath, 'utf8');
    assert.equal(body, 'Catchup loop restarted by its watchdog.\r\nCause: store stall: maintenance-state (maintenance-state.json)');
    assert.ok(!existsSync(join(home, 'catchup-loop.stalled')));
    assert.ok(!existsSync(join(home, 'stall-records.jsonl')));
  });

  it('win32: a UV_THREADPOOL_SIZE already set is not overridden', { skip: process.platform !== 'win32', timeout: 90_000 }, async () => {
    const home = makeHome();
    const fake = fakePaPaths(home);
    writeFileSync(join(home, 'catchup-loop.lock'), String(deadPid()), 'utf8');
    const vbsPath = join(home, 'watchdog.vbs');
    const vbs = buildCatchupWatchdogVbs(fake.win.replace(/"/g, '""'), 'catchup --loop', home, watchdogPaths(home), 300_000);
    writeFileSync(vbsPath, vbs, 'utf8');
    const env = baseEnv(home, fake);
    env.UV_THREADPOOL_SIZE = '32';
    runLauncherWindows(vbsPath, env);
    const out = join(home, 'fake-pa.jsonl');
    const lines = await waitLines(out, 1, 15000);
    assert.equal(JSON.parse(lines[0]).uv, '32');
  });

  it('win32: a live node PID whose command line is not the catchup loop is never killed', { skip: process.platform !== 'win32', timeout: 90_000 }, async () => {
    const home = makeHome();
    const fake = fakePaPaths(home);
    const child = liveNode([]);
    try {
      fresh(home, child.pid!);
      for (const lane of ['default', 'reminders', 'maintenance']) stale(join(home, 'catchup-lanes', lane));
      const vbsPath = join(home, 'watchdog.vbs');
      const vbs = buildCatchupWatchdogVbs(fake.win.replace(/"/g, '""'), 'catchup --loop', home, watchdogPaths(home), 300_000);
      writeFileSync(vbsPath, vbs, 'utf8');
      runLauncherWindows(vbsPath, baseEnv(home, fake));
      await new Promise((r) => setTimeout(r, 3000));
      assert.ok(isRunning(child));
      const recordLines = readFileSync(join(home, 'stall-records.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0);
      assert.equal(recordLines.length, 1);
      const record = JSON.parse(recordLines[0]);
      assert.equal(record.host, 'launcher');
      assert.equal(record.store, 'pid-reused');
      assert.equal(record.pid, child.pid);
      assert.equal(record.cause, 'catchup loop was not running (recorded PID now belongs to another process); relaunched');
      const outPath = join(home, 'fake-pa.jsonl');
      const lines = await waitLines(outPath, 2, 15000);
      assert.equal(lines.length, 2);
      const argvSet = lines.map((l) => JSON.stringify(JSON.parse(l).argv));
      assert.ok(argvSet.includes(JSON.stringify(['catchup', '--loop'])));
      assert.ok(
        argvSet.includes(
          JSON.stringify(['notify', '--subject', 'Catchup loop restarted', '--body-file', watchdogPaths(home).pageBodyPath, '--dedup-key', 'catchup-loop-pid-reused', '--severity', 'warn'])
        )
      );
      const body = readFileSync(watchdogPaths(home).pageBodyPath, 'utf8');
      assert.equal(body, 'Catchup loop restarted by its watchdog.\r\nCause: catchup loop was not running (recorded PID now belongs to another process); relaunched');
    } finally {
      if (isRunning(child)) child.kill();
    }
  });

  it('win32: a killed loop that does not exit within the wait is relaunched anyway and paged with the did-not-exit cause', { skip: process.platform !== 'win32', timeout: 90_000 }, async () => {
    const home = makeHome();
    const fake = fakePaPaths(home);
    const child = liveNode();
    try {
      fresh(home, child.pid!);
      writeFileSync(join(home, 'catchup-lanes', 'reminders'), '2026-09-16T10:00:00.000Z|reminders|drill-wedge|', 'utf8');
      stale(join(home, 'catchup-lanes', 'reminders'));
      const vbsPath = join(home, 'watchdog.vbs');
      const vbs = buildCatchupWatchdogVbs(fake.win.replace(/"/g, '""'), 'catchup --loop', home, watchdogPaths(home), 300_000);
      writeFileSync(vbsPath, vbs, 'utf8');
      const env = baseEnv(home, fake);
      env.PATH = `${fakeBin(home)};${env.PATH}`;
      const { elapsedMs } = runLauncherWindows(vbsPath, env);
      assert.ok(elapsedMs >= 3000);
      assert.ok(elapsedMs < 30_000);
      assert.ok(isRunning(child));
      const recordLines = readFileSync(join(home, 'stall-records.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0);
      assert.equal(recordLines.length, 1);
      const record = JSON.parse(recordLines[0]);
      assert.equal(record.store, 'lane-progress');
      assert.equal(record.pid, child.pid);
      assert.equal(record.cause, 'lane reminders stale at drill-wedge');
      const out = join(home, 'fake-pa.jsonl');
      const lines = await waitLines(out, 2, 15000);
      assert.equal(lines.length, 2);
      const body = readFileSync(watchdogPaths(home).pageBodyPath, 'utf8');
      assert.equal(
        body,
        'Catchup loop restarted by its watchdog.\r\nCause: lane reminders stale at drill-wedge; killed catchup loop did not exit within 3 s; relaunched anyway - a stale write may land'
      );
    } finally {
      if (isRunning(child)) child.kill();
    }
  });

  it('win32: a clean exit that left no PID file is relaunched without a page or evidence', { skip: process.platform !== 'win32', timeout: 90_000 }, async () => {
    const home = makeHome();
    const fake = fakePaPaths(home);
    const vbsPath = join(home, 'watchdog.vbs');
    const vbs = buildCatchupWatchdogVbs(fake.win.replace(/"/g, '""'), 'catchup --loop', home, watchdogPaths(home), 300_000);
    writeFileSync(vbsPath, vbs, 'utf8');
    runLauncherWindows(vbsPath, baseEnv(home, fake));
    const out = join(home, 'fake-pa.jsonl');
    await waitLines(out, 1, 15000);
    await new Promise((r) => setTimeout(r, 2000));
    const lines = readFileSync(out, 'utf8').split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]).argv, ['catchup', '--loop']);
    assert.ok(!existsSync(join(home, 'stall-records.jsonl')));
    assert.ok(!existsSync(watchdogPaths(home).pageBodyPath));
  });

  // ── POSIX ────────────────────────────────────────────────────────────────

  it('posix: a live PID with a fresh heartbeat and fresh lane files is left alone', { skip: process.platform === 'win32', timeout: 90_000 }, async () => {
    const home = makeHome();
    const fake = fakePaPaths(home);
    const child = liveNode();
    try {
      fresh(home, child.pid!);
      const scriptPath = join(home, 'watchdog.sh');
      const script = buildCatchupWatchdogShScript(fake.posix, watchdogPaths(home), 5);
      writeFileSync(scriptPath, script, 'utf8');
      runLauncherPosix(scriptPath, baseEnv(home, fake));
      await new Promise((r) => setTimeout(r, 3000));
      assert.ok(!existsSync(join(home, 'fake-pa.jsonl')));
      assert.ok(isRunning(child));
    } finally {
      if (isRunning(child)) child.kill();
    }
  });

  it('posix: a live PID whose reminders lane file is stale is killed, relaunched and paged with evidence', { skip: process.platform === 'win32', timeout: 90_000 }, async () => {
    const home = makeHome();
    const fake = fakePaPaths(home);
    const child = liveNode();
    try {
      fresh(home, child.pid!);
      writeFileSync(join(home, 'catchup-lanes', 'reminders'), '2026-09-16T10:00:00.000Z|reminders|drill-wedge|', 'utf8');
      stale(join(home, 'catchup-lanes', 'reminders'));
      writeFileSync(join(home, 'catchup-loop.stalled'), 'store stall: a"b\\c', 'utf8');
      const scriptPath = join(home, 'watchdog.sh');
      const script = buildCatchupWatchdogShScript(fake.posix, watchdogPaths(home), 5);
      writeFileSync(scriptPath, script, 'utf8');
      runLauncherPosix(scriptPath, baseEnv(home, fake));
      await new Promise((r) => setTimeout(r, 10_000));
      assert.ok(!isRunning(child));
      const recordLines = readFileSync(join(home, 'stall-records.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0);
      assert.equal(recordLines.length, 1);
      const record = JSON.parse(recordLines[0]);
      assert.equal(record.host, 'launcher');
      assert.equal(record.store, 'lane-progress');
      assert.equal(record.pid, child.pid);
      assert.equal(record.cause, 'lane reminders stale at drill-wedge; store stall: a"b\\c');
      const out = join(home, 'fake-pa.jsonl');
      const lines = await waitLines(out, 2, 15000);
      const argvs = lines.map((l) => JSON.parse(l));
      for (const r of argvs) assert.equal(r.uv, '16');
      const body = readFileSync(watchdogPaths(home).pageBodyPath, 'utf8');
      assert.equal(body, 'Catchup loop restarted by its watchdog.\nCause: lane reminders stale at drill-wedge; store stall: a"b\\c\n');
    } finally {
      if (isRunning(child)) child.kill();
    }
  });

  it('posix: a dead PID with a stall marker is relaunched and paged with the marker as the cause', { skip: process.platform === 'win32', timeout: 90_000 }, async () => {
    const home = makeHome();
    const fake = fakePaPaths(home);
    writeFileSync(join(home, 'catchup-loop.lock'), String(deadPid()), 'utf8');
    writeFileSync(join(home, 'catchup-loop.stalled'), 'store stall: maintenance-state (maintenance-state.json)', 'utf8');
    const scriptPath = join(home, 'watchdog.sh');
    const script = buildCatchupWatchdogShScript(fake.posix, watchdogPaths(home), 5);
    writeFileSync(scriptPath, script, 'utf8');
    runLauncherPosix(scriptPath, baseEnv(home, fake));
    const out = join(home, 'fake-pa.jsonl');
    const lines = await waitLines(out, 2, 15000);
    assert.equal(lines.length, 2);
    const body = readFileSync(watchdogPaths(home).pageBodyPath, 'utf8');
    assert.equal(body, 'Catchup loop restarted by its watchdog.\nCause: store stall: maintenance-state (maintenance-state.json)\n');
  });

  it('posix: UV_THREADPOOL_SIZE defaults to 16 and a set value is kept', { skip: process.platform === 'win32', timeout: 90_000 }, async () => {
    const home = makeHome();
    const fake = fakePaPaths(home);
    writeFileSync(join(home, 'catchup-loop.lock'), String(deadPid()), 'utf8');
    const scriptPath = join(home, 'watchdog.sh');
    const script = buildCatchupWatchdogShScript(fake.posix, watchdogPaths(home), 5);
    writeFileSync(scriptPath, script, 'utf8');
    runLauncherPosix(scriptPath, baseEnv(home, fake));
    const out = join(home, 'fake-pa.jsonl');
    const first = await waitLines(out, 1, 15000);
    assert.equal(JSON.parse(first[0]).uv, '16');

    writeFileSync(join(home, 'catchup-loop.lock'), String(deadPid()), 'utf8');
    const env2 = baseEnv(home, fake);
    env2.UV_THREADPOOL_SIZE = '32';
    runLauncherPosix(scriptPath, env2);
    const second = await waitLines(out, 2, 15000);
    assert.equal(JSON.parse(second[1]).uv, '32');
  });

  it('posix: a live PID whose command line is not the catchup loop is never killed', { skip: process.platform === 'win32', timeout: 90_000 }, async () => {
    const home = makeHome();
    const fake = fakePaPaths(home);
    const child = liveNode([]);
    try {
      fresh(home, child.pid!);
      for (const lane of ['default', 'reminders', 'maintenance']) stale(join(home, 'catchup-lanes', lane));
      const scriptPath = join(home, 'watchdog.sh');
      const script = buildCatchupWatchdogShScript(fake.posix, watchdogPaths(home), 5);
      writeFileSync(scriptPath, script, 'utf8');
      runLauncherPosix(scriptPath, baseEnv(home, fake));
      assert.ok(isRunning(child));
      const recordLines = readFileSync(join(home, 'stall-records.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0);
      assert.equal(recordLines.length, 1);
      const record = JSON.parse(recordLines[0]);
      assert.equal(record.host, 'launcher');
      assert.equal(record.store, 'pid-reused');
      assert.equal(record.pid, child.pid);
      assert.equal(record.cause, 'catchup loop was not running (recorded PID now belongs to another process); relaunched');
      const out = join(home, 'fake-pa.jsonl');
      const lines = await waitLines(out, 2, 15000);
      assert.equal(lines.length, 2);
      const argvSet = lines.map((l) => JSON.stringify(JSON.parse(l).argv));
      assert.ok(argvSet.includes(JSON.stringify(['catchup', '--loop'])));
      assert.ok(
        argvSet.includes(
          JSON.stringify(['notify', '--subject', 'Catchup loop restarted', '--body-file', watchdogPaths(home).pageBodyPath, '--dedup-key', 'catchup-loop-pid-reused', '--severity', 'warn'])
        )
      );
      const body = readFileSync(watchdogPaths(home).pageBodyPath, 'utf8');
      assert.equal(body, 'Catchup loop restarted by its watchdog.\nCause: catchup loop was not running (recorded PID now belongs to another process); relaunched\n');
    } finally {
      if (isRunning(child)) child.kill();
    }
  });

  it('posix: a killed loop that does not exit within the wait is relaunched anyway and paged with the did-not-exit cause', { skip: process.platform === 'win32', timeout: 90_000 }, async () => {
    const home = makeHome();
    const fake = fakePaPaths(home);
    const child = liveNode();
    try {
      fresh(home, child.pid!);
      writeFileSync(join(home, 'catchup-lanes', 'reminders'), '2026-09-16T10:00:00.000Z|reminders|drill-wedge|', 'utf8');
      stale(join(home, 'catchup-lanes', 'reminders'));
      const scriptPath = join(home, 'watchdog.sh');
      const script = buildCatchupWatchdogShScript(fake.posix, watchdogPaths(home), 5);
      writeFileSync(scriptPath, script, 'utf8');
      const env = baseEnv(home, fake);
      env.PATH = `${fakeBin(home)}:${env.PATH}`;
      runLauncherPosix(scriptPath, env);
      // The real kill -9 killed the child; only the fake `ps` reports it running.
      const start = Date.now();
      while (isRunning(child) && Date.now() - start < 10_000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(!isRunning(child));
      const out = join(home, 'fake-pa.jsonl');
      const lines = await waitLines(out, 2, 15000);
      assert.equal(lines.length, 2);
      const body = readFileSync(watchdogPaths(home).pageBodyPath, 'utf8');
      assert.equal(
        body,
        'Catchup loop restarted by its watchdog.\nCause: lane reminders stale at drill-wedge; killed catchup loop did not exit within 3 s; relaunched anyway - a stale write may land\n'
      );
    } finally {
      if (isRunning(child)) child.kill();
    }
  });

  it('posix: a clean exit that left no PID file is relaunched without a page or evidence', { skip: process.platform === 'win32', timeout: 90_000 }, async () => {
    const home = makeHome();
    const fake = fakePaPaths(home);
    const scriptPath = join(home, 'watchdog.sh');
    const script = buildCatchupWatchdogShScript(fake.posix, watchdogPaths(home), 5);
    writeFileSync(scriptPath, script, 'utf8');
    runLauncherPosix(scriptPath, baseEnv(home, fake));
    const out = join(home, 'fake-pa.jsonl');
    await waitLines(out, 1, 15000);
    await new Promise((r) => setTimeout(r, 2000));
    const lines = readFileSync(out, 'utf8').split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]).argv, ['catchup', '--loop']);
    assert.ok(!existsSync(join(home, 'stall-records.jsonl')));
    assert.ok(!existsSync(watchdogPaths(home).pageBodyPath));
  });
});
