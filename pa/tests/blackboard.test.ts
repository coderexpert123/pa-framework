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

  it('no .tmp survives acquire/release', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const { readdir } = await import('fs/promises');
    const resource = 'topic-no-tmp-leak';

    await blackboard.acquireLock(resource, 'agent', process.pid, 5000);
    await blackboard.releaseLock(resource, 'agent');

    const files = await readdir(process.env.PA_HOME!);
    assert.equal(
      files.some((f) => f.endsWith('.tmp')),
      false,
      `expected no .tmp file to survive acquire/release, got: ${files.join(', ')}`
    );
  });
});

// D4: releaseLock(resource, agent, contextId?, opts?: { pid?: number }) — additive. acquireLock's
// own re-entrance rule blocks a genuinely different PID from acquiring the SAME resource from
// this one test process (see spawnDummyHolder precedent in run-exclusive-lock.test.ts), so these
// two rows are seeded directly into blackboard.json rather than through the public API.
describe('releaseLock pid scoping (D4, additive)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  async function seedRows(rows: Array<{ resource: string; agent: string; pid: number; heartbeat?: string }>): Promise<void> {
    const path = `${process.env.PA_HOME}/blackboard.json`;
    let data: { active_locks: any[] };
    try {
      data = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      data = { active_locks: [] };
    }
    const { writeFile } = await import('fs/promises');
    data.active_locks.push(...rows.map((r) => ({ heartbeat: new Date().toISOString(), ...r })));
    await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
  }

  it('releaseLock with { pid } removes only the matching row', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const resource = 'topic-pid-scoped-release';
    await seedRows([
      { resource, agent: 'agent', pid: 111 },
      { resource, agent: 'agent', pid: 222 },
    ]);

    await blackboard.releaseLock(resource, 'agent', undefined, { pid: 111 });

    const data = JSON.parse(await readFile(`${process.env.PA_HOME}/blackboard.json`, 'utf8'));
    const remaining = data.active_locks.filter((l: any) => l.resource === resource);
    assert.equal(remaining.length, 1, 'expected exactly the non-matching-pid row to survive');
    assert.equal(remaining[0].pid, 222);
  });

  it('releaseLock without { pid } is unchanged (legacy): removes every matching row regardless of pid', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const resource = 'topic-legacy-release-all-pids';
    await seedRows([
      { resource, agent: 'agent', pid: 111 },
      { resource, agent: 'agent', pid: 222 },
    ]);

    await blackboard.releaseLock(resource, 'agent'); // no contextId, no opts — legacy behaviour

    const data = JSON.parse(await readFile(`${process.env.PA_HOME}/blackboard.json`, 'utf8'));
    assert.equal(
      data.active_locks.filter((l: any) => l.resource === resource).length,
      0,
      'legacy release (no opts.pid) must remove every row for the resource+agent, regardless of pid'
    );
  });
});

describe('a torn blackboard.json (D7)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it('logs at error with a refId and resets to empty instead of throwing', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const { flushLog } = await import('../src/lib/log.js');
    const { writeFile } = await import('fs/promises');
    const path = `${process.env.PA_HOME}/blackboard.json`;

    await writeFile(path, '{"active_locks":', 'utf8'); // truncated JSON

    const locks = await blackboard.getActiveLocks();
    assert.deepEqual(locks, [], 'a torn store must reset to empty, not throw');

    await flushLog();
    const raw = await readFile(`${process.env.PA_HOME}/app.log.jsonl`, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const entry = lines.find((l) => l.module === 'blackboard' && l.message === 'store unreadable — resetting to empty');
    assert.ok(entry, `expected a blackboard error log line, got: ${JSON.stringify(lines)}`);
    assert.equal(entry.level, 'error');
    assert.match(entry.refId, /^s-[0-9a-f]{12}$/);
  });
});

describe('startLockRenewal', () => {
  let dir: string;
  let originalStaleMs: string | undefined;
  let originalGraceMs: string | undefined;

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
    if (originalGraceMs === undefined) delete process.env.PA_HEARTBEAT_GRACE_MS;
    else process.env.PA_HEARTBEAT_GRACE_MS = originalGraceMs;
    originalGraceMs = undefined;
  });

  async function lockHeartbeat(resource: string): Promise<string | undefined> {
    const data = JSON.parse(await readFile(`${process.env.PA_HOME}/blackboard.json`, 'utf8'));
    return data.active_locks.find((l: any) => l.resource === resource)?.heartbeat;
  }

  it('keeps a competing acquirer blocked past a shortened TTL, then unblocks after stop()', async () => {
    const { blackboard, startLockRenewal } = await import('../src/blackboard.js');
    const resource = 'renew-test-blocking';
    originalStaleMs = process.env.PA_HEARTBEAT_STALE_MS;
    originalGraceMs = process.env.PA_HEARTBEAT_GRACE_MS;
    // Generous margins throughout: this is a real fs-lock-backed system
    // (proper-lockfile), and a single slow disk op must not flake this test —
    // only a tick GAP longer than the TTL should ever cause a purge. Grace
    // zeroed: this test proves TTL+renewal interaction, not the grace window
    // (covered separately below) — with the 3-minute default grace left in
    // place, "past its TTL" would enter grace instead of evicting, and the
    // second half of this test (unblocks once genuinely stale) would time out.
    process.env.PA_HEARTBEAT_STALE_MS = '2000';
    process.env.PA_HEARTBEAT_GRACE_MS = '0';

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

  it('renews through an injected client (C13), never touching the real singleton', async () => {
    const { blackboard, startLockRenewal } = await import('../src/blackboard.js');
    const resource = 'renew-test-injected-client';

    let singletonCalls = 0;
    const originalUpdateHeartbeat = blackboard.updateHeartbeat.bind(blackboard);
    (blackboard as any).updateHeartbeat = async (...args: Parameters<typeof originalUpdateHeartbeat>) => {
      singletonCalls++;
      return originalUpdateHeartbeat(...args);
    };

    let clientCalls = 0;
    const fakeClient = {
      updateHeartbeat: async (_resource: string, _agent: string, _contextId?: string) => {
        clientCalls++;
        return true;
      },
    };

    const renewal = startLockRenewal(resource, 'holder', undefined, {
      intervalMs: 30, maxMs: 60_000, client: fakeClient,
    });
    try {
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      renewal.stop();
      (blackboard as any).updateHeartbeat = originalUpdateHeartbeat;
    }

    assert.ok(clientCalls >= 1, `expected the injected client to receive at least one heartbeat tick, got ${clientCalls}`);
    assert.equal(singletonCalls, 0, 'the real blackboard singleton must never be touched when a client is injected');
  });
});

// Followup-defects Defect 1 (2026-09-01): purge decisions must check holder
// liveness, not staleness alone. Full decision matrix: dead PID -> evict now;
// alive + fresh -> keep; alive + stale-but-in-grace -> keep (still blocks a
// competing acquire — the double-occupancy safety property); alive +
// grace-expired -> evict. Also covers the sibling defect: an unrelated purge
// decision must be PERSISTED even when the caller's own requested resource
// stays contended (previously only written on the no-conflict success path,
// so it was recomputed and re-logged every ~1s retry without ever landing).
describe('lock purge liveness + grace (Defect 1, 2026-09-01)', () => {
  let dir: string;
  let originalStaleMs: string | undefined;
  let originalGraceMs: string | undefined;

  beforeEach(async () => {
    dir = await createTempPaHome();
    originalStaleMs = process.env.PA_HEARTBEAT_STALE_MS;
    originalGraceMs = process.env.PA_HEARTBEAT_GRACE_MS;
    // Small, deterministic thresholds: stale at 500ms, grace window another
    // 1000ms on top (evict at 1500ms total). Seeded row ages are chosen with
    // generous margin either side of both boundaries.
    process.env.PA_HEARTBEAT_STALE_MS = '500';
    process.env.PA_HEARTBEAT_GRACE_MS = '1000';
  });

  afterEach(async () => {
    await cleanup(dir);
    if (originalStaleMs === undefined) delete process.env.PA_HEARTBEAT_STALE_MS;
    else process.env.PA_HEARTBEAT_STALE_MS = originalStaleMs;
    originalStaleMs = undefined;
    if (originalGraceMs === undefined) delete process.env.PA_HEARTBEAT_GRACE_MS;
    else process.env.PA_HEARTBEAT_GRACE_MS = originalGraceMs;
    originalGraceMs = undefined;
  });

  async function seedRow(row: { resource: string; agent: string; pid: number; ageMs: number; contextId?: string }): Promise<void> {
    const path = `${process.env.PA_HOME}/blackboard.json`;
    let data: { active_locks: any[] };
    try {
      data = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      data = { active_locks: [] };
    }
    data.active_locks.push({
      resource: row.resource,
      agent: row.agent,
      pid: row.pid,
      heartbeat: new Date(Date.now() - row.ageMs).toISOString(),
      ...(row.contextId !== undefined ? { contextId: row.contextId } : {}),
    });
    const { writeFile } = await import('fs/promises');
    await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
  }

  async function readRows(): Promise<any[]> {
    const path = `${process.env.PA_HOME}/blackboard.json`;
    return JSON.parse(await readFile(path, 'utf8')).active_locks;
  }

  // Real spawn+kill (not a hardcoded PID literal) so "dead" is genuine, not
  // an assumption about which PIDs happen to be unassigned on this machine —
  // mirrors run-exclusive-lock.test.ts's spawnDummyHolder precedent.
  async function spawnAndKill(): Promise<number> {
    const { spawn } = await import('child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    await new Promise((resolve) => setTimeout(resolve, 150)); // let it actually start
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 150)); // let the OS actually reap it
    return pid;
  }

  it('alive + stale-but-in-grace row is NOT evicted and still blocks a competing acquire (no double-occupancy)', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const resource = 'grace-blocks-competitor';
    await seedRow({ resource, agent: 'holder', pid: process.pid, ageMs: 750 }); // > 500 stale, <= 1500 grace ceiling

    const start = Date.now();
    const competing = await blackboard.acquireLock(resource, 'competitor', 999999997, 800);
    const elapsed = Date.now() - start;

    assert.equal(competing, false, 'a graced row must still block a competing acquirer for a different pid');
    assert.ok(elapsed >= 700, `should have waited out its timeout, took ${elapsed}ms`);

    const rows = await readRows();
    assert.equal(rows.filter((r: any) => r.resource === resource).length, 1, 'the graced row must still be present on disk, not purged');
  });

  it('alive + grace-expired row IS evicted and a competing acquire succeeds', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const resource = 'grace-expired-evicts';
    await seedRow({ resource, agent: 'holder', pid: process.pid, ageMs: 1700 }); // past 500 stale + 1000 grace

    const start = Date.now();
    const competing = await blackboard.acquireLock(resource, 'competitor', 999999996, 2000);
    const elapsed = Date.now() - start;

    assert.equal(competing, true, 'a grace-expired row must be evicted, letting a new acquirer through');
    assert.ok(elapsed < 1500, `should not have waited out the full timeout, took ${elapsed}ms`);

    await blackboard.releaseLock(resource, 'competitor');
  });

  it('a dead PID is evicted immediately regardless of a fresh heartbeat (grace never applies to a dead holder)', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const resource = 'dead-pid-evicts-immediately';
    const deadPid = await spawnAndKill();
    await seedRow({ resource, agent: 'holder', pid: deadPid, ageMs: 0 }); // heartbeat is FRESH

    const start = Date.now();
    const competing = await blackboard.acquireLock(resource, 'competitor', 999999995, 2000);
    const elapsed = Date.now() - start;

    assert.equal(competing, true, 'a dead PID must be purged on the very next acquire, independent of heartbeat age/grace');
    assert.ok(elapsed < 1500, `should not have waited, took ${elapsed}ms`);

    await blackboard.releaseLock(resource, 'competitor');
  });

  it('getActiveLocks() includes a grace-zone row and excludes a grace-expired row', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    await seedRow({ resource: 'active-grace-zone', agent: 'holder', pid: process.pid, ageMs: 750 });
    await seedRow({ resource: 'active-grace-expired', agent: 'holder', pid: process.pid, ageMs: 1700 });

    const rows = await blackboard.getActiveLocks();
    assert.ok(rows.some((r) => r.resource === 'active-grace-zone'), 'grace-zone row must still read as active (matters for catchup.ts isLockLost())');
    assert.ok(!rows.some((r) => r.resource === 'active-grace-expired'), 'grace-expired row must not read as active');
  });

  it('purgeStaleLocks() evicts dead-PID and grace-expired rows but keeps a grace-zone row', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const deadPid = await spawnAndKill();
    await seedRow({ resource: 'sweep-dead', agent: 'a', pid: deadPid, ageMs: 0 });
    await seedRow({ resource: 'sweep-grace', agent: 'a', pid: process.pid, ageMs: 750 });
    await seedRow({ resource: 'sweep-expired', agent: 'a', pid: process.pid, ageMs: 1700 });

    const purged = await blackboard.purgeStaleLocks();
    assert.equal(purged, 2, 'expected exactly the dead-PID and grace-expired rows to be purged');

    const rows = await readRows();
    assert.deepEqual(rows.map((r: any) => r.resource).sort(), ['sweep-grace']);
  });

  it("acquireLock persists an unrelated purge even while its OWN requested resource stays contended (fixes the 1Hz purge-retry spin)", async () => {
    const { blackboard } = await import('../src/blackboard.js');
    // An unrelated resource, already past grace — eligible for eviction.
    await seedRow({ resource: 'unrelated-stale', agent: 'holder', pid: process.pid, ageMs: 1700 });

    // A real foreign process holds 'contended-target' so this call's own
    // resource stays conflicted for its whole timeout budget — before the
    // fix, that meant the purge computed above was never written to disk
    // (only the no-conflict success branch persisted it).
    const { spawn } = await import('child_process');
    const foreignHolder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 150));
      const seeded = await blackboard.acquireLock('contended-target', 'foreign-agent', foreignHolder.pid!, 2000);
      assert.equal(seeded, true, 'precondition: the foreign holder must have acquired the target resource');

      const acquired = await blackboard.acquireLock('contended-target', 'me', 999999994, 1200);
      assert.equal(acquired, false, 'precondition: the target resource must have stayed contended for this call');

      const rows = await readRows();
      assert.equal(
        rows.some((r: any) => r.resource === 'unrelated-stale'),
        false,
        'the unrelated grace-expired row must have been purged to disk even though this call never won its own resource'
      );
    } finally {
      foreignHolder.kill();
      await blackboard.releaseLock('contended-target', 'foreign-agent');
    }
  });
});
