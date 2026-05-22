import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, cleanup } from './helpers.js';

describe('Blackboard lock re-entrance', () => {
  let dir: string;

  before(async () => {
    dir = await createTempPaHome();
  });

  after(async () => {
    await cleanup(dir);
  });

  it('same PID + different agent on the same resource does NOT block', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const resource = 'topic-test-reentrance';
    const pid = process.pid;

    // Outer: the bot acquiring a topic-level lock as 'telegram-bot'.
    const outer = await blackboard.acquireLock(resource, 'telegram-bot', pid, 2000);
    assert.equal(outer, true, 'outer acquire must succeed');

    // Inner: executeWorker acquiring the same resource as 'claude'.
    // Before the fix, this blocked for ~10 minutes waiting for the outer lock
    // to go stale. After the fix, it should return immediately.
    const start = Date.now();
    const inner = await blackboard.acquireLock(resource, 'claude', pid, 2000);
    const elapsedMs = Date.now() - start;

    assert.equal(inner, true, 'inner acquire (same PID, different agent) must succeed');
    assert.ok(
      elapsedMs < 500,
      `inner acquire should be near-instant, took ${elapsedMs}ms`
    );

    // Cleanup
    await blackboard.releaseLock(resource, 'claude');
    await blackboard.releaseLock(resource, 'telegram-bot');
  });

  it('different PID on the same resource DOES block (then fails at timeout)', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const resource = 'topic-test-foreign-pid';

    // Hold the real lock, then try to acquire with a different PID.
    // The foreign PID's liveness is irrelevant — only the existing
    // holder's PID is checked for liveness during the purge. Since our
    // entry stays, the new re-entrance rule (`l.pid !== pid`) matches
    // and the foreign-PID acquirer blocks until timeout.
    const mine = await blackboard.acquireLock(resource, 'telegram-bot', process.pid, 2000);
    assert.equal(mine, true);

    const foreignPid = 1; // any PID != process.pid — liveness irrelevant
    const start = Date.now();
    const acquired = await blackboard.acquireLock(resource, 'claude', foreignPid, 2500);
    const elapsedMs = Date.now() - start;

    assert.equal(acquired, false, 'foreign-PID acquire must fail within timeout');
    assert.ok(
      elapsedMs >= 2000,
      `foreign-PID acquire should wait the full timeout, took ${elapsedMs}ms`
    );

    await blackboard.releaseLock(resource, 'telegram-bot');
  });

  it('re-acquiring same (resource, agent, pid) is idempotent', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const resource = 'topic-test-idempotent';

    const first = await blackboard.acquireLock(resource, 'telegram-bot', process.pid, 1000);
    const second = await blackboard.acquireLock(resource, 'telegram-bot', process.pid, 1000);
    assert.equal(first, true);
    assert.equal(second, true);

    // The state file should only contain one entry for this (resource, agent, pid) tuple.
    const data = await import('fs/promises').then(fs => fs.readFile(`${process.env.PA_HOME}/blackboard.json`, 'utf8'));
    const parsed = JSON.parse(data);
    const matching = parsed.active_locks.filter(
      (l: { resource: string; agent: string; pid: number }) =>
        l.resource === resource && l.agent === 'telegram-bot' && l.pid === process.pid
    );
    assert.equal(matching.length, 1, 'should not accumulate duplicate entries on re-acquire');

    await blackboard.releaseLock(resource, 'telegram-bot');
  });

  it('same PID, different contextId, same resource DOES block (times out)', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const resource = 'topic-ctx-blocking';

    const acquired1 = await blackboard.acquireLock(resource, 'agent', process.pid, 5000, 'ctx-A');
    assert.equal(acquired1, true, 'first acquire with ctx-A must succeed');

    const start = Date.now();
    // ctx-B has same PID but different contextId — must block and time out
    const acquired2 = await blackboard.acquireLock(resource, 'agent', process.pid, 2000, 'ctx-B');
    const elapsedMs = Date.now() - start;

    assert.equal(acquired2, false, 'ctx-B acquire (same PID, different contextId) must fail');
    assert.ok(elapsedMs >= 1900, `should wait the full 2s timeout, took ${elapsedMs}ms`);

    await blackboard.releaseLock(resource, 'agent', 'ctx-A');
  });

  it('releaseLock with contextId removes only matching entry', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const { readFile } = await import('fs/promises');
    const resource = 'topic-scoped-release';

    await blackboard.acquireLock(resource, 'agent', process.pid, 5000, 'ctx-A');

    // Release with the WRONG contextId — must NOT remove the ctx-A entry
    await blackboard.releaseLock(resource, 'agent', 'ctx-WRONG');
    const data1 = JSON.parse(await readFile(`${process.env.PA_HOME}/blackboard.json`, 'utf8'));
    assert.equal(
      data1.active_locks.filter((l: any) => l.resource === resource && l.contextId === 'ctx-A').length,
      1,
      'ctx-A entry must still be present after wrong-contextId release'
    );

    // Release with the CORRECT contextId — must remove it
    await blackboard.releaseLock(resource, 'agent', 'ctx-A');
    const data2 = JSON.parse(await readFile(`${process.env.PA_HOME}/blackboard.json`, 'utf8'));
    assert.equal(
      data2.active_locks.filter((l: any) => l.resource === resource).length,
      0,
      'ctx-A entry must be removed after correct-contextId release'
    );
  });

  it('legacy callers without contextId acquire and release correctly', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const { readFile } = await import('fs/promises');
    const resource = 'topic-legacy-caller';

    const acquired = await blackboard.acquireLock(resource, 'agent2', process.pid, 5000);
    assert.equal(acquired, true, 'legacy acquire (no contextId) must succeed');

    await blackboard.releaseLock(resource, 'agent2');  // no contextId — legacy form
    const data = JSON.parse(await readFile(`${process.env.PA_HOME}/blackboard.json`, 'utf8'));
    assert.equal(
      data.active_locks.filter((l: any) => l.resource === resource).length,
      0,
      'legacy release must remove the entry'
    );
  });
});
