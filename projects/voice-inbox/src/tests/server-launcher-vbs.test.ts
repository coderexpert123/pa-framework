/**
 * server-launcher-vbs.test.ts — pins the run-server-hidden.vbs liveness gate
 * (2026-09-10 launch-cadence wave, orchestrator amendment to WP-B). Before
 * this launcher existed, the voice-inbox app server had NO watchdog at all:
 * after a reboot it stayed dead until started by hand. This mirrors the
 * telegram-bot's own run-bot-hidden.vbs gate (same S1 PidIsLiveNode /
 * ReadJsonPid shapes) against the shape run_server.ps1 now writes to
 * <PA_HOME>/voice-inbox/server.lock — JSON {"pid":<n>,"ts":<ms>}, the same
 * shape the relay poller writes to relay-poller.lock.
 *
 * This file is PUBLIC and tracked (voice-inbox is a public-tracked project;
 * the launcher bakes no operator-specific path — it resolves PA_HOME/
 * USERPROFILE at run time), so it is present on public CI too.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VBS_PATH = resolve(__dirname, '../../scripts/run-server-hidden.vbs');

describe('run-server-hidden.vbs launcher gate (2026-09-10 launch-cadence wave)', () => {
  it('the WScript.Quit 0 guard line exists and precedes the powershell.exe launch', () => {
    const text = readFileSync(VBS_PATH, 'utf8');
    const quitIdx = text.indexOf('WScript.Quit 0');
    const runIdx = text.indexOf('WshShell.Run "powershell.exe');
    assert.ok(quitIdx >= 0, 'guard line not found');
    assert.ok(runIdx >= 0, 'powershell.exe launch line not found');
    assert.ok(quitIdx < runIdx, 'the guard must run before spawning powershell.exe');
  });

  it('WshShell.CurrentDirectory is set before the guard runs', () => {
    const text = readFileSync(VBS_PATH, 'utf8');
    const cwdIdx = text.indexOf('WshShell.CurrentDirectory');
    const quitIdx = text.indexOf('WScript.Quit 0');
    assert.ok(cwdIdx >= 0, 'CurrentDirectory assignment not found');
    assert.ok(quitIdx >= 0, 'guard line not found');
    assert.ok(cwdIdx < quitIdx, 'CurrentDirectory must be set before the liveness gate runs');
  });

  it('reads the server.lock path under <PA_HOME>/voice-inbox', () => {
    const text = readFileSync(VBS_PATH, 'utf8');
    assert.ok(text.includes('\\voice-inbox\\server.lock'));
  });

  it('carries ReadJsonPid and the double-filtered PidIsLiveNode', () => {
    const text = readFileSync(VBS_PATH, 'utf8');
    assert.ok(text.includes('Function ReadJsonPid(path)'));
    assert.ok(text.includes('Function PidIsLiveNode(pid)'));
    assert.ok(text.includes('/FI ""PID eq'));
    assert.ok(text.includes('/FI ""IMAGENAME eq node.exe""'));
    assert.ok(text.includes('| find /I ""node.exe""'));
  });

  it('the fail-safe direction is pinned: no localized "No tasks" check, no un-piped tasklist', () => {
    const text = readFileSync(VBS_PATH, 'utf8');
    assert.ok(!text.includes('No tasks'), 'a localized-string check would report a dead server as alive');
    for (const line of text.split('\n')) {
      if (line.trim().startsWith("'")) continue;
      if (!line.includes('tasklist')) continue;
      assert.ok(line.includes('| find'), `tasklist line without a find pipe: ${line}`);
    }
  });

  it('the file contains no CR bytes (stays LF)', () => {
    const raw = readFileSync(VBS_PATH);
    assert.ok(!raw.includes(0x0d), 'run-server-hidden.vbs must stay LF-terminated');
  });
});
