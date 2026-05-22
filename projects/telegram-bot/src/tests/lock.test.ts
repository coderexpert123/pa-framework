import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock } from '../lock.js';

// Multiple acquireLock calls register multiple exit handlers — raise the limit
// to suppress the MaxListenersExceededWarning during test runs.
process.setMaxListeners(50);

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'tgbot-lock-test-'));
  process.env.PA_HOME = tempDir;
});

afterEach(async () => {
  delete process.env.PA_HOME;
  await rm(tempDir, { recursive: true, force: true });
});

function lockPath(): string {
  return join(tempDir, 'telegram-bot.lock');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// acquireLock
// ---------------------------------------------------------------------------

describe('acquireLock', () => {
  it('returns true when no lock file exists', async () => {
    const result = await acquireLock();
    assert.equal(result, true);
  });

  it('creates a lock file containing the current PID', async () => {
    await acquireLock();
    const content = await readFile(lockPath(), 'utf8');
    assert.equal(content, String(process.pid));
  });

  it('returns false when an existing lock file has a live PID', async () => {
    // Write the current process's PID — it is definitely alive
    await writeFile(lockPath(), String(process.pid), 'utf8');
    const result = await acquireLock();
    assert.equal(result, false);
  });

  it('does not overwrite the lock file when returning false', async () => {
    await writeFile(lockPath(), String(process.pid), 'utf8');
    await acquireLock(); // returns false
    // Lock file must still contain the original PID, not be deleted
    const content = await readFile(lockPath(), 'utf8');
    assert.equal(content, String(process.pid));
  });

  it('takes over a stale lock file with a dead PID', async () => {
    // PID 99999999 will not exist on any normal system
    await writeFile(lockPath(), '99999999', 'utf8');
    const result = await acquireLock();
    assert.equal(result, true);
  });

  it('overwrites stale lock file with current PID', async () => {
    await writeFile(lockPath(), '99999999', 'utf8');
    await acquireLock();
    const content = await readFile(lockPath(), 'utf8');
    assert.equal(content, String(process.pid));
  });

  it('takes over a lock file with non-numeric (invalid) content', async () => {
    await writeFile(lockPath(), 'not-a-pid', 'utf8');
    const result = await acquireLock();
    assert.equal(result, true);
  });

  it('takes over a lock file with empty content', async () => {
    await writeFile(lockPath(), '', 'utf8');
    const result = await acquireLock();
    assert.equal(result, true);
  });

  it('does not throw when lock file has zero PID', async () => {
    // isNaN(0) = false, so isProcessAlive(0) is called.
    // Unix: process.kill(0, 0) sends to process group → succeeds → isProcessAlive returns true
    //   → acquireLock returns false (treated as live process).
    // Windows: process.kill(0, 0) throws ESRCH → isProcessAlive returns false
    //   → stale lock taken over → acquireLock returns true.
    // Return value is platform-dependent; just assert no exception is thrown.
    await writeFile(lockPath(), '0', 'utf8');
    let threw = false;
    try {
      await acquireLock();
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'acquireLock must not throw for PID 0');
  });
});

// ---------------------------------------------------------------------------
// releaseLock
// ---------------------------------------------------------------------------

describe('releaseLock', () => {
  it('deletes the lock file after acquiring', async () => {
    await acquireLock();
    assert.ok(await fileExists(lockPath()), 'lock file must exist after acquire');
    await releaseLock();
    assert.ok(!(await fileExists(lockPath())), 'lock file must be deleted after release');
  });

  it('does not throw when no lock file exists', async () => {
    await assert.doesNotReject(() => releaseLock());
  });

  it('does not throw when called twice', async () => {
    await acquireLock();
    await releaseLock();
    await assert.doesNotReject(() => releaseLock()); // second release — file already gone
  });
});

// ---------------------------------------------------------------------------
// acquireLock → releaseLock → acquireLock round-trip
// ---------------------------------------------------------------------------

describe('lock round-trip', () => {
  it('can re-acquire a released lock', async () => {
    const first = await acquireLock();
    assert.equal(first, true);

    await releaseLock();

    const second = await acquireLock();
    assert.equal(second, true);
  });
});
