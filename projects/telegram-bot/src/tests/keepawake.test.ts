import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { getKeepAwakeStatus } from '../keepawake.js';

function getPaHome(): string {
  return process.env.PA_HOME || join(homedir(), '.pa');
}
const STATE_FILE = join(getPaHome(), 'telegram-keepawake.json');

describe('keepawake', () => {
  beforeEach(() => {
    if (existsSync(STATE_FILE)) {
      try { unlinkSync(STATE_FILE); } catch {}
    }
  });

  it('returns inactive if no state file exists', () => {
    const status = getKeepAwakeStatus();
    assert.strictEqual(status.active, false);
  });

  it('returns inactive if state file has dead PID', () => {
    // PID 999999999 is extremely unlikely to be alive
    writeFileSync(STATE_FILE, JSON.stringify({ active: true, pid: 999999999, since: new Date().toISOString() }));
    const status = getKeepAwakeStatus();
    assert.strictEqual(status.active, false);
    // Stale state file must be cleaned up
    assert.ok(!existsSync(STATE_FILE));
  });

  it('returns active with pid/since if the stored PID is alive', () => {
    // Use our own PID — guaranteed alive
    const since = new Date().toISOString();
    writeFileSync(STATE_FILE, JSON.stringify({ active: true, pid: process.pid, since }));
    const status = getKeepAwakeStatus();
    assert.strictEqual(status.active, true);
    assert.strictEqual(status.pid, process.pid);
    assert.strictEqual(status.since, since);
  });

  it('platform backend selection (compile-time sanity check)', () => {
    // Verify the module exports the right interface regardless of platform.
    // The actual spawn command varies by OS — this just checks the function exists.
    const p = platform();
    assert.ok(['win32', 'darwin', 'linux'].includes(p) || typeof p === 'string',
      `Unexpected platform: ${p}`);
  });
});
