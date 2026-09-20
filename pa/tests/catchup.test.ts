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
import './test-env-guard.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, createTempConfig, createTempSkill, cleanup } from './helpers.js';

describe('catchupCommand: blackboard-based locking', () => {
  let dir: string;

  before(async () => {
    // Set PA_HOME before any module-level Blackboard constructor runs
    dir = await createTempPaHome();
    // catchupCommand calls loadConfig(); seed a minimal valid config.yaml so it
    // reaches the blackboard-locking path instead of throwing "Config not found".
    await createTempConfig(dir, [
      { name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e "0"' },
    ]);
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

/**
 * WP-3 (2026-09-11 slots-commit-signal SPEC, S2/D9): catchup's per-tick
 * concurrency limit follows the dynamic worker-slot cap when
 * `concurrency_limit` is absent from config, honors an explicit config value
 * verbatim, and falls back to the legacy static 2 under the PA_DYNAMIC_SLOTS
 * kill switch. Isolated in its own describe with its own temp PA_HOME so its
 * env-var mutations (PA_DYNAMIC_SLOTS, PA_MAX_CONCURRENT_WORKERS) and
 * blackboard state never interleave with the locking suite above.
 */
describe('concurrency limit resolution (S2/D9)', () => {
  let climitDir: string;

  before(async () => {
    climitDir = await createTempPaHome();
  });

  after(async () => {
    await cleanup(climitDir);
  });

  /** Captures every console.log call made during fn(), then restores it. */
  async function captureLog(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await fn();
    } finally {
      console.log = original;
    }
    return lines;
  }

  /** One trivially-fast, always-overdue skill — just enough to make
   *  runCatchup print the "Starting execution with global concurrency
   *  limit: N" banner, which only fires when overdue.length > 0. */
  async function seedOneOverdueSkill(name: string): Promise<void> {
    await createTempSkill(climitDir, name, [
      '---',
      'cron: "0 0 1 1 *"',
      'cmd: "node -e \\"0\\""',
      '---',
      'A trivial skill used only to trigger the concurrency-limit startup banner.',
    ].join('\n'));
  }

  it('an explicit concurrency_limit is honored verbatim', async () => {
    const { catchupCommand } = await import('../src/commands/catchup.js');
    await createTempConfig(
      climitDir,
      [{ name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e "0"' }],
      { concurrency_limit: 7 },
    );
    await seedOneOverdueSkill('verbatim-limit');

    const lines = await captureLog(() => catchupCommand());
    assert.ok(
      lines.some((l) => l.includes('global concurrency limit: 7')),
      `expected the banner to report the explicit limit 7, got: ${JSON.stringify(lines)}`,
    );
  });

  it('an absent key follows the live worker-slot count', async () => {
    const { catchupCommand } = await import('../src/commands/catchup.js');
    const { workerSlotCount } = await import('../src/worker-exec.js');
    const originalKillSwitch = process.env.PA_DYNAMIC_SLOTS;
    delete process.env.PA_DYNAMIC_SLOTS; // the dynamic path must be live for this case
    try {
      await createTempConfig(climitDir, [
        { name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e "0"' },
      ]); // no concurrency_limit key at all
      await seedOneOverdueSkill('absent-key-live-count');

      // Read the live value right before the run so the assertion tracks
      // whatever the pool actually reports, rather than assuming a fixed
      // number — this is deliberately robust to ambient PA_MAX_CONCURRENT_WORKERS
      // / real machine pressure state instead of hardcoding a value.
      const expected = workerSlotCount();
      const lines = await captureLog(() => catchupCommand());
      assert.ok(
        lines.some((l) => l.includes(`global concurrency limit: ${expected}`)),
        `expected the banner to report the live worker-slot count (${expected}), got: ${JSON.stringify(lines)}`,
      );
    } finally {
      if (originalKillSwitch === undefined) delete process.env.PA_DYNAMIC_SLOTS;
      else process.env.PA_DYNAMIC_SLOTS = originalKillSwitch;
    }
  });

  it('an absent key with the kill switch on returns the legacy 2', async () => {
    const { catchupCommand } = await import('../src/commands/catchup.js');
    const originalKillSwitch = process.env.PA_DYNAMIC_SLOTS;
    process.env.PA_DYNAMIC_SLOTS = '0';
    try {
      await createTempConfig(climitDir, [
        { name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e "0"' },
      ]); // no concurrency_limit key at all
      await seedOneOverdueSkill('kill-switch-legacy-2');

      const lines = await captureLog(() => catchupCommand());
      assert.ok(
        lines.some((l) => l.includes('global concurrency limit: 2')),
        `expected the banner to report the legacy 2 under the kill switch, got: ${JSON.stringify(lines)}`,
      );
    } finally {
      if (originalKillSwitch === undefined) delete process.env.PA_DYNAMIC_SLOTS;
      else process.env.PA_DYNAMIC_SLOTS = originalKillSwitch;
    }
  });

  it('the limit is re-read while waiting, so a cap change is adopted mid-tick', async () => {
    const { catchupCommand } = await import('../src/commands/catchup.js');
    const { blackboard } = await import('../src/blackboard.js');

    const originalCeiling = process.env.PA_MAX_CONCURRENT_WORKERS;
    const originalKillSwitch = process.env.PA_DYNAMIC_SLOTS;
    delete process.env.PA_DYNAMIC_SLOTS; // the dynamic path must be live for this case
    // ceiling=1 makes floor=min(PA_SLOTS_MIN, 1)=1 too, so the resolved limit
    // is pinned to exactly 1 regardless of any unrelated pressure state.
    process.env.PA_MAX_CONCURRENT_WORKERS = '1';

    let lockAcquired = false;
    try {
      await createTempConfig(climitDir, [
        { name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e "0"' },
      ]); // no concurrency_limit key: resolveConcurrencyLimit() re-reads workerSlotCount() on every poll
      await seedOneOverdueSkill('mid-tick-cap-change');

      // Simulate one already-active skill occupying the sole slot (same
      // technique as topic-partitioning.test.ts's "respects concurrency_limit
      // across multiple topics"): with limit=1 the loop must block rather
      // than admit the overdue skill above.
      const foreignPid = process.ppid;
      lockAcquired = await blackboard.acquireLock('skill-other', 'test-agent', foreignPid, 5000);
      assert.equal(lockAcquired, true, 'setup: foreign skill lock must be acquired');

      const catchupPromise = catchupCommand();

      // Give the loop time to reach and log its first blocked poll before
      // raising the cap — proves the block actually happened at limit=1.
      await new Promise((r) => setTimeout(r, 2000));

      // Raise the cap WITHOUT releasing the foreign lock. Under the pre-fix
      // behavior (limit captured once at tick start) activeSkills(1) would
      // never fall below a limit frozen at 1, and this would hang until the
      // race below times out.
      process.env.PA_MAX_CONCURRENT_WORKERS = '2';

      // Poll cadence is 5s; two cycles of headroom.
      await Promise.race([
        catchupPromise,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('catchup did not adopt the raised cap within 12s — the limit was not re-read mid-tick')),
          12000,
        )),
      ]);
    } finally {
      if (lockAcquired) await blackboard.releaseLock('skill-other', 'test-agent').catch(() => {});
      if (originalCeiling === undefined) delete process.env.PA_MAX_CONCURRENT_WORKERS;
      else process.env.PA_MAX_CONCURRENT_WORKERS = originalCeiling;
      if (originalKillSwitch === undefined) delete process.env.PA_DYNAMIC_SLOTS;
      else process.env.PA_DYNAMIC_SLOTS = originalKillSwitch;
    }
  });
});
