/**
 * Tests for catchupCommand blackboard-based locking.
 *
 * Uses dynamic imports (not static) so that the Blackboard singleton is
 * initialised AFTER createTempPaHome() sets PA_HOME. If we used static
 * imports the singleton would bake in the real ~/.pa path at module load
 * time, causing tests to write to production state.
 *
 * Mirrors the pattern in blackboard.test.ts.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';

describe('catchupCommand: blackboard-based locking', () => {
  let dir: string;

  before(async () => {
    // Set PA_HOME before any module-level Blackboard constructor runs
    dir = await createTempPaHome();
  });

  after(async () => {
    await cleanup(dir);
  });

  it('acquires and releases the blackboard lock on a normal run', async () => {
    const { catchupCommand } = await import('../src/commands/catchup.js');

    // skills/ dir is empty → getOverdueSkills returns nothing → exits cleanly
    await catchupCommand();

    const raw = await readFile(join(dir, 'blackboard.json'), 'utf8').catch(() => '{"active_locks":[]}');
    const data = JSON.parse(raw);
    const locks = data.active_locks.filter((l: { resource: string }) => l.resource === 'catchup');
    assert.equal(locks.length, 0, 'catchup lock must be released after normal completion');
  });

  it('can be called a second time — proves lock was released after the first run', async () => {
    const { catchupCommand } = await import('../src/commands/catchup.js');

    // If the finally block failed to release the lock, the second call
    // would either re-enter (same PID, idempotent) or block forever.
    // A clean second completion verifies the lock was properly released.
    await assert.doesNotReject(() => catchupCommand());

    const raw = await readFile(join(dir, 'blackboard.json'), 'utf8').catch(() => '{"active_locks":[]}');
    const data = JSON.parse(raw);
    const locks = data.active_locks.filter((l: { resource: string }) => l.resource === 'catchup');
    assert.equal(locks.length, 0, 'catchup lock must be released after second run too');
  });

  it('exits immediately when a different PID holds the catchup lock', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const { catchupCommand } = await import('../src/commands/catchup.js');

    // process.ppid is always alive and always ≠ process.pid — Windows-safe
    const foreignPid = process.ppid;
    const acquired = await blackboard.acquireLock('catchup', 'catchup-command', foreignPid, 1000);
    assert.equal(acquired, true, 'setup: foreign PID must acquire the lock');

    // catchupCommand should print "Another catchup is already running" and return
    await assert.doesNotReject(() => catchupCommand());

    // The foreign PID lock must still be present (catchupCommand did not overwrite it)
    const raw = await readFile(join(dir, 'blackboard.json'), 'utf8');
    const data = JSON.parse(raw);
    const foreignLocks = data.active_locks.filter(
      (l: { resource: string; pid: number }) => l.resource === 'catchup' && l.pid === foreignPid
    );
    assert.equal(foreignLocks.length, 1, 'foreign PID lock must still be present — catchupCommand must not have taken it');

    await blackboard.releaseLock('catchup', 'catchup-command');
  });
});
