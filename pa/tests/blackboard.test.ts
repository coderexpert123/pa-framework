import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
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

describe('startLockRenewal', () => {
  let dir: string;
  let originalStaleMs: string | undefined;

  // A dedicated temp PA_HOME (and therefore a dedicated blackboard.json +
  // lockfile) per test, not shared across the whole describe. These tests are
  // real-timer/real-fs-lock sensitive; sharing one blackboard.json let one
  // test's still-settling lockfile contention delay another's updateHeartbeat
  // calls past their observation window (real HDD-backed lockfile.lock()
  // contention observed to occasionally push timing well past generous
  // margins) — a distinct file per test removes that shared-resource
  // contention entirely.
  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
    if (originalStaleMs === undefined) delete process.env.PA_HEARTBEAT_STALE_MS;
    else process.env.PA_HEARTBEAT_STALE_MS = originalStaleMs;
    originalStaleMs = undefined;
  });

  async function lockHeartbeat(resource: string): Promise<string | undefined> {
    const data = JSON.parse(await readFile(`${process.env.PA_HOME}/blackboard.json`, 'utf8'));
    return data.active_locks.find((l: any) => l.resource === resource)?.heartbeat;
  }

  it('keeps a competing acquirer blocked past a shortened TTL, then unblocks after stop()', async () => {
    const { blackboard, startLockRenewal } = await import('../src/blackboard.js');
    const resource = 'renew-test-blocking';
    originalStaleMs = process.env.PA_HEARTBEAT_STALE_MS;
    // Generous margins throughout: this is a real fs-lock-backed system
    // (proper-lockfile), and a single slow disk op must not flake this test —
    // only a tick GAP longer than the TTL should ever cause a purge.
    process.env.PA_HEARTBEAT_STALE_MS = '2000';

    const acquired = await blackboard.acquireLock(resource, 'holder', process.pid, 2000);
    assert.equal(acquired, true);

    const renewal = startLockRenewal(resource, 'holder', undefined, { intervalMs: 50, maxMs: 60_000 });
    try {
      // Outlive the (shortened) 2s TTL while renewal is active.
      await new Promise((r) => setTimeout(r, 2500));

      const competingStart = Date.now();
      const competing = await blackboard.acquireLock(resource, 'competitor', 999999999, 800);
      const elapsed = Date.now() - competingStart;
      assert.equal(competing, false, 'row must have survived the purge — renewal kept it fresh');
      assert.ok(elapsed >= 700, `competing acquire should have waited out its timeout, took ${elapsed}ms`);
      // Defensive cleanup only — if the assertion above already threw
      // (competing acquired when it shouldn't have), remove it so it can't
      // leak into other tests. On the expected path this is a no-op.
      await blackboard.releaseLock(resource, 'competitor');
    } finally {
      renewal.stop();
    }

    // After stop(), the 'holder' entry is deliberately left in place (NOT
    // released) so the second half of this test actually exercises TTL
    // expiry, not an explicit release.
    await new Promise((r) => setTimeout(r, 2200));
    const afterStopStart = Date.now();
    // Timeout widened to 5000ms (was 2000ms): the entry is already stale by
    // the time this acquire starts, so it should resolve on the purge's
    // first retry — but that retry loop sleeps in ~1s increments
    // (acquireLock's own retry cadence) and real fs-lock I/O can push a
    // single increment well past a tight bound under full-suite disk
    // contention (observed: 1506ms against a 1500ms assertion). The wider
    // timeout gives real headroom without weakening what's being proven.
    const afterStop = await blackboard.acquireLock(resource, 'competitor2', 999999998, 5000);
    const afterStopElapsed = Date.now() - afterStopStart;
    assert.equal(afterStop, true, 'lock must be acquirable once renewal has stopped and the TTL elapsed');
    // Proves "didn't wait out the full timeout" (i.e. the entry was already
    // stale, not that we got lucky on a retry within the timeout window) —
    // generous absolute margin below the 5000ms ceiling above.
    assert.ok(afterStopElapsed < 4000, `should not need to wait out the full timeout, took ${afterStopElapsed}ms`);

    await blackboard.releaseLock(resource, 'holder');
    await blackboard.releaseLock(resource, 'competitor2');
  });

  it('maxMs cap stops renewing and fires onLost("expired") exactly once', async () => {
    const { blackboard, startLockRenewal } = await import('../src/blackboard.js');
    const resource = 'renew-test-maxms';

    const acquired = await blackboard.acquireLock(resource, 'holder', process.pid, 2000);
    assert.equal(acquired, true);

    const losses: string[] = [];
    const renewal = startLockRenewal(resource, 'holder', undefined, {
      intervalMs: 50,
      maxMs: 300,
      onLost: (reason) => losses.push(reason),
    });

    await new Promise((r) => setTimeout(r, 700));
    assert.deepEqual(losses, ['expired'], 'onLost("expired") must fire exactly once past the cap');

    // The cap check runs on every tick, but it can't abort a tick whose
    // async updateHeartbeat was already in flight (real fs-lock I/O) the
    // instant the cap fired — that straggler still lands on disk whenever
    // the lock becomes available, which under full-suite disk contention can
    // be well after this 700ms wait. Give it generous time to settle before
    // taking the "at cap" baseline (mirrors the same race handled in
    // "stop() is idempotent and halts ticks" above), then assert stability
    // over a second, longer window.
    await new Promise((r) => setTimeout(r, 500));
    const heartbeatAtCap = await lockHeartbeat(resource);
    await new Promise((r) => setTimeout(r, 600));
    const heartbeatLater = await lockHeartbeat(resource);
    assert.equal(heartbeatLater, heartbeatAtCap, 'renewal must have actually stopped ticking after the cap');

    renewal.stop(); // idempotent no-op, already self-stopped
    await blackboard.releaseLock(resource, 'holder');
  });

  it('stop() is idempotent and halts ticks', async () => {
    const { blackboard, startLockRenewal } = await import('../src/blackboard.js');
    const resource = 'renew-test-stop-idempotent';

    await blackboard.acquireLock(resource, 'holder', process.pid, 2000);
    const renewal = startLockRenewal(resource, 'holder', undefined, { intervalMs: 50, maxMs: 60_000 });

    await new Promise((r) => setTimeout(r, 200));
    renewal.stop();
    assert.doesNotThrow(() => renewal.stop()); // second stop() must be a no-op, not throw

    // stop() only prevents FUTURE ticks from being scheduled — it cannot abort
    // a tick whose async updateHeartbeat was already in flight the instant
    // stop() was called. Give that one straggler generous time to settle
    // before taking the "at stop" baseline, then assert stability over a
    // longer window (real fs-lock contention under a loaded full-suite run).
    await new Promise((r) => setTimeout(r, 400));
    const heartbeatAtStop = await lockHeartbeat(resource);
    await new Promise((r) => setTimeout(r, 500));
    const heartbeatLater = await lockHeartbeat(resource);
    assert.equal(heartbeatLater, heartbeatAtStop, 'no ticks should occur after stop()');

    await blackboard.releaseLock(resource, 'holder');
  });

  it('onLost("purged") fires once (latched) if the row is released out from under the renewer', async () => {
    const { blackboard, startLockRenewal } = await import('../src/blackboard.js');
    const resource = 'renew-test-purged';

    await blackboard.acquireLock(resource, 'holder', process.pid, 2000);

    const losses: string[] = [];
    const renewal = startLockRenewal(resource, 'holder', undefined, {
      intervalMs: 50,
      maxMs: 60_000,
      onLost: (reason) => losses.push(reason),
    });

    // Pull the row out from under the renewer, as if a legitimate new holder
    // (or an operator purge) removed it.
    await new Promise((r) => setTimeout(r, 100));
    await blackboard.releaseLock(resource, 'holder');

    // Poll rather than a fixed sleep: needs at least one more tick's full
    // async round-trip (updateHeartbeat → lockfile.lock/readData/write) to
    // observe the purge, which can take an unpredictable while under a loaded
    // machine — a fixed-duration sleep flaked intermittently even at 600ms.
    const deadline = Date.now() + 5000;
    while (losses.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.deepEqual(losses, ['purged'], 'onLost("purged") must fire exactly once, latched');

    renewal.stop();
    // stop() only prevents FUTURE ticks — it cannot abort a tick whose
    // updateHeartbeat call was already in flight. Settle before returning: an
    // unawaited straggler resolving after this test ends would call into the
    // (real, unpatched-here) blackboard.updateHeartbeat while the NEXT test
    // ('never overlaps ticks') has already monkeypatched that same singleton
    // method — inflating ITS concurrency counters with a call that has
    // nothing to do with it. Node's test runner does not wait out orphaned
    // promises a finished test spawned, so this file must self-quiesce.
    await new Promise((r) => setTimeout(r, 250));
  });

  it('never overlaps ticks under a slow updateHeartbeat', async () => {
    const bbModule = await import('../src/blackboard.js');
    const { blackboard, startLockRenewal } = bbModule;
    const resource = 'renew-test-no-overlap';

    await blackboard.acquireLock(resource, 'holder', process.pid, 2000);

    const original = blackboard.updateHeartbeat.bind(blackboard);
    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;
    (blackboard as any).updateHeartbeat = async (...args: Parameters<typeof original>) => {
      concurrent++;
      calls++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 120)); // slower than the 30ms tick interval
      concurrent--;
      return original(...args);
    };

    const renewal = startLockRenewal(resource, 'holder', undefined, { intervalMs: 30, maxMs: 60_000 });
    try {
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      renewal.stop();
      (blackboard as any).updateHeartbeat = original;
    }

    assert.ok(calls >= 1, 'expected at least one heartbeat tick');
    assert.equal(maxConcurrent, 1, `ticks must never overlap, saw ${maxConcurrent} concurrent`);

    await blackboard.releaseLock(resource, 'holder');
  });
});
