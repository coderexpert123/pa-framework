import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, access } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { pollForRestart, botStopCommand } from '../src/commands/bot.js';

// Fast poll/deadline values for unit tests — avoids 2s/90s production defaults
const POLL_MS = 10;
const TIMEOUT_MS = 300;

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

describe('pollForRestart', () => {
  it('returns {pid, started} when a new live PID appears in the lock file', async () => {
    // Write lock file with the current test process PID — guaranteed alive
    const lockPath = join(tempDir, 'telegram-bot.lock');
    await writeFile(lockPath, String(process.pid), 'utf8');

    // oldPid = 0 so any PID ≠ 0 and alive qualifies
    const result = await pollForRestart(tempDir, 0, POLL_MS, TIMEOUT_MS);

    assert.ok(result !== null, 'expected a result, got null (timeout)');
    assert.equal(result!.pid, process.pid);
    assert.ok(result!.started instanceof Date);
  });

  it('returns null when lock file contains the same PID (stale — not a new restart)', async () => {
    // Write lock file with current PID as the "old" PID
    const lockPath = join(tempDir, 'telegram-bot.lock');
    await writeFile(lockPath, String(process.pid), 'utf8');

    // oldPid matches the file — must be rejected, poll until timeout
    const result = await pollForRestart(tempDir, process.pid, POLL_MS, TIMEOUT_MS);

    assert.equal(result, null);
  });

  it('returns null when lock file is absent for the entire polling window (ENOENT)', async () => {
    // No lock file written — ENOENT on every poll iteration
    const result = await pollForRestart(tempDir, 0, POLL_MS, TIMEOUT_MS);

    assert.equal(result, null);
  });

  it('returns null when deadline expires before any valid PID appears', async () => {
    // Write a lock file with an invalid (non-numeric) PID so parse produces NaN
    const lockPath = join(tempDir, 'telegram-bot.lock');
    await writeFile(lockPath, 'not-a-pid', 'utf8');

    const result = await pollForRestart(tempDir, 0, POLL_MS, TIMEOUT_MS);

    assert.equal(result, null);
  });
});

describe('botStopCommand — self-stop', () => {
  let tempDir2: string;
  let savedPid: string | undefined;
  beforeEach(async () => {
    tempDir2 = await createTempPaHome();
    savedPid = process.env.PA_BOT_PID;
  });
  afterEach(async () => {
    if (savedPid === undefined) delete process.env.PA_BOT_PID;
    else process.env.PA_BOT_PID = savedPid;
    await cleanup(tempDir2);
  });

  it('returns false and writes sentinel when PA_BOT_PID matches lock PID', async () => {
    const myPid = process.pid;
    await writeFile(join(tempDir2, 'telegram-bot.lock'), String(myPid), 'utf8');
    process.env.PA_BOT_PID = String(myPid);

    const result = await botStopCommand();

    assert.equal(result, false);
    await assert.doesNotReject(access(join(tempDir2, 'telegram-bot.stop')));
  });

  it('uses normal path when PA_BOT_PID differs from lock PID', async () => {
    await writeFile(join(tempDir2, 'telegram-bot.lock'), '99999999', 'utf8');
    process.env.PA_BOT_PID = String(process.pid);

    const result = await botStopCommand();

    assert.equal(result, true);
    await assert.rejects(access(join(tempDir2, 'telegram-bot.stop')));
  });

  it('uses normal path when PA_BOT_PID is unset', async () => {
    delete process.env.PA_BOT_PID;
    await writeFile(join(tempDir2, 'telegram-bot.lock'), '99999999', 'utf8');

    const result = await botStopCommand();
    assert.equal(result, true);
  });
});
