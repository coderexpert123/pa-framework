import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock } from '../lock.js';

// Known limitation (2026-08-23): the stale-overwrite path's plain unlink+create
// is not a compare-and-swap, so two racing callers can still both observe a
// dead-PID lock and both win — deliberately NOT closed in this wave. A real
// fix would need a takeover mutex (e.g. a `wx`-created `<lock>.takeover` file
// held across the unlink+create) rather than an unconditional unlink.

process.setMaxListeners(50);

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'tgbot-lock-stale-test-'));
  process.env.PA_HOME = tempDir;
});

afterEach(async () => {
  // D15 reset-never-delete pattern: `delete process.env.PA_HOME` is the exact
  // shape that sent real Telegram alerts in production (2026-08-18) when a
  // later, unrelated module read an unset PA_HOME mid-suite.
  process.env.PA_HOME = process.env.PA_TEST_LOG_HOME ?? mkdtempSync(join(tmpdir(), 'tgbot-lock-fallback-'));
  await rm(tempDir, { recursive: true, force: true });
});

function lockPath(): string {
  return join(tempDir, 'telegram-bot.lock');
}

describe('lock.ts stale-overwrite', () => {
  it('a stale dead-PID lock is replaced, acquireLock returns true', async () => {
    await writeFile(lockPath(), '99999999', 'utf8'); // dead PID — no such process
    const result = await acquireLock();
    assert.equal(result, true);

    const content = await readFile(lockPath(), 'utf8');
    assert.equal(content, String(process.pid));
  });

  it("a live owner's lock is never overwritten", async () => {
    // This test process's own PID is, by definition, alive — simulates a
    // genuinely live other owner without needing a second real process.
    await writeFile(lockPath(), String(process.pid), 'utf8');
    const result = await acquireLock();
    assert.equal(result, false);

    const content = await readFile(lockPath(), 'utf8');
    assert.equal(content, String(process.pid), 'lock content must be unchanged for a live owner');
  });
});
