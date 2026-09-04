import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, createTempSkill, createTempConfig, cleanup } from './helpers.js';
import { runCommand, exclusiveLockKey, lockWaitBudgetMs, lockSkipAlertFields } from '../src/commands/run.js';
import { blackboard } from '../src/blackboard.js';
import { flushLog } from '../src/lib/log.js';
import { readFile, readdir, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn, type ChildProcess } from 'child_process';

// blackboard's re-entrance rule treats a second acquireLock from the SAME pid
// as a legacy reentrant caller and lets it through (needed so runCommand's
// own trigger-recursion, which calls back into runCommand in-process, can't
// self-deadlock). That means simulating "another process holds this lock"
// requires a REAL other process — process.pid alone won't block anything
// acquired from this same test process. Mirrors worker-pids.test.ts's
// stand-in-process pattern.
async function spawnDummyHolder(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 100)); // let it actually start
  return child;
}

// See run.test.ts for why this must be set before any notifyUser call fires
// in a bare `node --test` run (not needed under real `npm test`, which sets
// it via --require, but harmless and required for direct invocation).
process.env.PA_NOTIFY_DISABLED = '1';

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  scriptDir = join(tmpdir(), `pa-test-lock-scripts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(scriptDir, { recursive: true });
});

afterEach(async () => {
  await cleanup(tempDir);
  const { rm } = await import('fs/promises');
  try { await rm(scriptDir, { recursive: true, force: true }); } catch {}
});

async function latestLogMeta(dir: string, skillName: string): Promise<any> {
  const logDir = join(dir, 'logs', skillName);
  const files = await readdir(logDir);
  const metaFile = files.find((f) => f.endsWith('.meta'));
  assert.ok(metaFile, `expected a .meta file for ${skillName}`);
  return JSON.parse(await readFile(join(logDir, metaFile!), 'utf8'));
}

describe('exclusiveLockKey / lockWaitBudgetMs (pure)', () => {
  it('namespaces the blackboard resource so it cannot collide with other lock users', () => {
    assert.equal(exclusiveLockKey('git-workflow'), 'skill-exclusive:git-workflow');
  });

  it('namespaces the public-mirror resource the same way (D5)', () => {
    assert.equal(exclusiveLockKey('git-public-workflow'), 'skill-exclusive:git-public-workflow');
  });

  it('reserves half the skill timeout for waiting, floored at a small minimum', () => {
    assert.equal(lockWaitBudgetMs(600), 300_000);
    assert.equal(lockWaitBudgetMs(3600), 1_800_000);
    assert.equal(lockWaitBudgetMs(1), 2_000); // floor engages
    assert.equal(lockWaitBudgetMs(undefined), 150_000); // default 300s timeout
  });
});

// 2026-08-23: lock contention (worker === 'lock', the sentinel runCommand
// passes when the exclusive_resource wait times out — see runSkillBody)
// used to alert its skill's own telegram_output topic with the same
// "Skill failed: <name>" subject/severity/dedupKey as a real failure, reading
// to the operator as "Skill failed: commit" three times in one week
// (the 2026-08-23 alerts-week review §5.5). run.ts now discriminates via
// lockSkipAlertFields(worker, skillName), tested directly here since this
// file has no existing mechanism for observing a fired notifyUser call.
describe('lockSkipAlertFields (pure)', () => {
  it('a lock-skip result gets a low-severity, distinctly-keyed subject', () => {
    const fields = lockSkipAlertFields('lock', 'blocked-skill');
    assert.equal(fields.subject, 'Skill skipped (lock busy): blocked-skill');
    assert.equal(fields.severity, 'info');
    assert.equal(fields.dedupKey, 'skill-lock-busy-blocked-skill');
    assert.equal(fields.topicDedupKey, 'skill-lock-busy-topic-blocked-skill');
  });

  it('a real worker failure keeps the original "Skill failed:" subject/severity/dedupKey', () => {
    for (const worker of ['claude', 'agy', 'codex', 'zclaude']) {
      const fields = lockSkipAlertFields(worker, 'some-skill');
      assert.equal(fields.subject, 'Skill failed: some-skill');
      assert.equal(fields.severity, 'error');
      assert.equal(fields.dedupKey, 'skill-failed-some-skill');
      assert.equal(fields.topicDedupKey, 'skill-fail-topic-some-skill');
    }
  });
});

describe('runCommand exclusive_resource locking', () => {
  it('waits for a lock held by another process before proceeding, then succeeds', async () => {
    const echoScript = join(scriptDir, 'echo.js');
    await writeFile(echoScript, `process.stdout.write('ran-after-wait');`, 'utf8');
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [echoScript], check: 'echo ok', priority: 1 },
    ]);
    await createTempSkill(tempDir, 'waits-for-lock', [
      '---',
      'cmd: node ' + JSON.stringify(echoScript),
      'exclusive_resource: test-git-workflow',
      'timeout: 30', // lockWaitBudgetMs(30) = 15_000ms, comfortably above the ~300ms release below
      '---',
      'unused',
    ].join('\n'));

    const holder = await spawnDummyHolder();
    try {
      const held = await blackboard.acquireLock('skill-exclusive:test-git-workflow', 'other-process', holder.pid!, 5000);
      assert.ok(held, 'precondition: the other-process lock must be acquired');

      const releaseDelayMs = 300;
      setTimeout(() => {
        void blackboard.releaseLock('skill-exclusive:test-git-workflow', 'other-process');
      }, releaseDelayMs);

      const start = Date.now();
      const result = await runCommand('waits-for-lock');
      const elapsed = Date.now() - start;

      assert.equal(result.success, true);
      assert.equal(result.output, 'ran-after-wait');
      // Proves it genuinely waited for the release rather than sailing through
      // via same-pid re-entrance (the bug this test exists to catch).
      assert.ok(elapsed >= releaseDelayMs - 50, `expected to wait ~${releaseDelayMs}ms, only waited ${elapsed}ms`);
    } finally {
      holder.kill();
    }
  });

  it('a skill without exclusive_resource is unaffected by another skill holding an unrelated lock', async () => {
    const echoScript = join(scriptDir, 'echo.js');
    await writeFile(echoScript, `process.stdout.write('unlocked-ran');`, 'utf8');
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [echoScript], check: 'echo ok', priority: 1 },
    ]);
    await createTempSkill(tempDir, 'no-lock-skill', [
      '---',
      'cmd: node ' + JSON.stringify(echoScript),
      'timeout: 10',
      '---',
      'unused',
    ].join('\n'));

    // Hold an unrelated exclusive_resource lock for the whole test — a skill
    // that doesn't declare exclusive_resource must never even look at it.
    const held = await blackboard.acquireLock('skill-exclusive:some-other-resource', 'holder', process.pid, 5000);
    assert.ok(held);
    try {
      const result = await runCommand('no-lock-skill');
      assert.equal(result.success, true);
      assert.equal(result.output, 'unlocked-ran');
    } finally {
      await blackboard.releaseLock('skill-exclusive:some-other-resource', 'holder');
    }
  });

  it('gives up after the lock-wait budget and reports a clear, non-pa-alerts failure', async () => {
    const echoScript = join(scriptDir, 'echo.js');
    await writeFile(echoScript, `process.stdout.write('should-not-run');`, 'utf8');
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [echoScript], check: 'echo ok', priority: 1 },
    ]);
    // timeout: 4 -> lockWaitBudgetMs floors to 2000ms, so this resolves fast.
    await createTempSkill(tempDir, 'blocked-skill', [
      '---',
      'cmd: node ' + JSON.stringify(echoScript),
      'exclusive_resource: contested',
      'timeout: 4',
      '---',
      'unused',
    ].join('\n'));

    // A live, un-purgeable holder in a REAL other process (no heartbeat
    // refresh needed since the wait window is well under HEARTBEAT_STALE_MS)
    // that never releases. Must be a genuinely different pid — see
    // spawnDummyHolder's comment for why process.pid would not block.
    const holder = await spawnDummyHolder();
    try {
      const held = await blackboard.acquireLock('skill-exclusive:contested', 'other-run', holder.pid!, 5000);
      assert.ok(held);

      const result = await runCommand('blocked-skill');
      assert.equal(result.success, false);
      assert.equal(result.alreadyAlertedPaSupport, true);
      assert.match(result.error ?? '', /Skipped: another skill holding exclusive_resource "contested"/);

      const meta = await latestLogMeta(tempDir, 'blocked-skill');
      assert.equal(meta.status, 'error');
      assert.match(meta.error, /Skipped: another skill holding exclusive_resource "contested"/);
    } finally {
      await blackboard.releaseLock('skill-exclusive:contested', 'other-run');
      holder.kill();
    }
  });

  it('releases the lock on failure too, so a subsequent run is not blocked forever', async () => {
    const failScript = join(scriptDir, 'fail.js');
    await writeFile(failScript, `process.exit(1);`, 'utf8');
    const okScript = join(scriptDir, 'ok.js');
    await writeFile(okScript, `process.stdout.write('ok');`, 'utf8');
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: ['{prompt}'], check: 'echo ok', priority: 1 },
    ]);
    await createTempSkill(tempDir, 'failing-skill', [
      '---',
      'cmd: node ' + JSON.stringify(failScript),
      'exclusive_resource: release-on-fail',
      'timeout: 5',
      '---',
      'unused',
    ].join('\n'));
    await createTempSkill(tempDir, 'follow-up-skill', [
      '---',
      'cmd: node ' + JSON.stringify(okScript),
      'exclusive_resource: release-on-fail',
      'timeout: 5',
      '---',
      'unused',
    ].join('\n'));

    const failResult = await runCommand('failing-skill');
    assert.equal(failResult.success, false);

    // If the lock leaked, this would hang until lockWaitBudgetMs(5) = 2500ms
    // and come back failed — assert it succeeds immediately instead.
    const followUpResult = await runCommand('follow-up-skill');
    assert.equal(followUpResult.success, true);
    assert.equal(followUpResult.output, 'ok');
  });
});

// D2/D3/D4 (2026-08-23): run.ts migrated its lock heartbeat onto
// startLockRenewal, which detects a purged row mid-run instead of silently
// renewing a lock that is no longer this run's to hold.
describe('lock-loss detection (D2/D3/D4)', () => {
  it('a purged lock row mid-run fails the skill with the "lock lost" family, alreadyAlertedPaSupport, and exactly one notify attempt', async () => {
    const sleepScript = join(scriptDir, 'sleep.js');
    // 3000ms: proper-lockfile's `retries: 5` (safeLockOptions) falls back to
    // the `retry` package's default minTimeout of 1000ms whenever a renewal
    // tick's lockfile.lock() loses the very first race against this test's
    // own releaseLock call (measured empirically: a consistent ~1000-1100ms
    // detection delay in that case, 8/8 samples) — a shorter script sleep
    // made this fail deterministically, not flakily, every time.
    await writeFile(sleepScript, `setTimeout(() => { process.stdout.write('done'); }, 3000);`, 'utf8');
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [sleepScript], check: 'echo ok', priority: 1 },
    ]);
    await createTempSkill(tempDir, 'lock-lost-skill', [
      '---',
      'cmd: node ' + JSON.stringify(sleepScript),
      'exclusive_resource: lock-lost-resource',
      'timeout: 30',
      '---',
      'unused',
    ].join('\n'));

    const originalRenewMs = process.env.PA_LOCK_RENEW_INTERVAL_MS;
    const originalStaleMs = process.env.PA_HEARTBEAT_STALE_MS;
    process.env.PA_LOCK_RENEW_INTERVAL_MS = '50';
    process.env.PA_HEARTBEAT_STALE_MS = '10000';

    try {
      const runPromise = runCommand('lock-lost-skill');

      // Poll for the row rather than guessing a fixed delay — acquireLock's
      // own completion time is not guaranteed to beat a fixed sleep under fs
      // contention (this raced and flaked at a fixed 150ms wait). Once
      // confirmed present, purge it — mirrors blackboard.test.ts's own
      // onLost("purged") case — leaving the fixed 500ms script sleep as ample
      // margin for the next 30ms renewal tick to observe the purge.
      const deadline = Date.now() + 5000;
      let rowSeen = false;
      while (Date.now() < deadline) {
        const active = await blackboard.getActiveLocks();
        if (active.some((l) => l.resource === 'skill-exclusive:lock-lost-resource')) { rowSeen = true; break; }
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(rowSeen, 'precondition: the run must have acquired the lock before it can be purged');
      await blackboard.releaseLock('skill-exclusive:lock-lost-resource', 'lock-lost-skill');

      const result = await runPromise;

      assert.equal(result.success, false);
      assert.equal(result.alreadyAlertedPaSupport, true);
      assert.match(result.error ?? '', /Lock lost \(purged\) mid-run/);
      assert.match(result.error ?? '', /skill-exclusive:lock-lost-resource/);

      await flushLog();
      const raw = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

      // notifyUser always logs 'attempting' first, regardless of PA_NOTIFY_DISABLED
      // or dedup — the one reliable observation point for "did it fire" in this
      // suite (ESM export reassignment is not a workable spy here — see
      // public-sync.test.ts's RA-1 comment for the same conclusion reached
      // independently).
      const attempts = lines.filter((l) => l.module === 'notify' && l.message === 'attempting' && l.subject === 'Skill failed (lock lost)');
      assert.equal(attempts.length, 1, `expected exactly one notify attempt, got ${attempts.length}: ${JSON.stringify(attempts)}`);
      assert.equal(attempts[0].dedupKey, 'skill-lock-lost:lock-lost-skill');
      assert.equal(attempts[0].severity, 'error');

      const runErrorLine = lines.find((l) => l.module === 'run' && l.level === 'error' && /Lock lost mid-run/.test(l.message));
      assert.ok(runErrorLine, `expected a run error log line, got: ${JSON.stringify(lines.filter((l) => l.module === 'run'))}`);
      assert.match(runErrorLine.refId, /^s-[0-9a-f]{12}$/);
    } finally {
      if (originalRenewMs === undefined) delete process.env.PA_LOCK_RENEW_INTERVAL_MS;
      else process.env.PA_LOCK_RENEW_INTERVAL_MS = originalRenewMs;
      if (originalStaleMs === undefined) delete process.env.PA_HEARTBEAT_STALE_MS;
      else process.env.PA_HEARTBEAT_STALE_MS = originalStaleMs;
    }
  });

  it("a stale same-skill holder's release does not delete a live holder's row", async () => {
    const resource = 'skill-exclusive:double-acquire-resource';
    const path = `${tempDir}/blackboard.json`;

    // Two contextIds on the same (resource, agent) can never coexist as two
    // simultaneously LIVE rows through acquireLock itself — its own
    // re-entrance rule blocks a same-pid different-context acquire outright
    // (see blackboard.test.ts's "same PID, different contextId... DOES
    // block"), and a different-pid acquire blocks too. Seeded directly to
    // exercise the state a genuinely stale holder's late release call can
    // still observe if it fires after a newer run has already replaced its
    // row on the same resource key.
    await writeFile(path, JSON.stringify({
      active_locks: [
        { resource, agent: 'some-skill', pid: process.pid, heartbeat: new Date().toISOString(), contextId: 'ctx-stale' },
        { resource, agent: 'some-skill', pid: process.pid, heartbeat: new Date().toISOString(), contextId: 'ctx-live' },
      ],
    }, null, 2), 'utf8');

    await blackboard.releaseLock(resource, 'some-skill', 'ctx-stale', { pid: process.pid });

    const data = JSON.parse(await readFile(path, 'utf8'));
    const rows = data.active_locks.filter((l: any) => l.resource === resource);
    assert.equal(rows.length, 1, `expected only ctx-live's row to survive, got: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].contextId, 'ctx-live');
  });
});

// D5: the public-mirror sync acquires its OWN resource (`git-public-workflow`),
// separate from `git-workflow`, in the CLI layer (commands/public-sync.ts) —
// lib/public-sync.ts (syncPublicMirror, covered by public-sync.test.ts) stays
// lock-free.
describe('publicSyncCommand git-public-workflow lock (D5)', () => {
  it('returns exit code 5 and never reaches syncPublicMirror when another process holds skill-exclusive:git-public-workflow', async () => {
    const { publicSyncCommand } = await import('../src/commands/public-sync.js');
    const originalWaitMs = process.env.PA_PUBLIC_SYNC_LOCK_WAIT_MS;
    process.env.PA_PUBLIC_SYNC_LOCK_WAIT_MS = '500'; // real default is 300_000ms — far too slow for a test
    // A REAL other process, not this test's own pid — blackboard's re-entrance
    // rule treats a same-pid row with no contextId as legacy-reentrant and lets
    // a same-pid acquire straight through, which would make this test pass for
    // the wrong reason. Mirrors this file's own spawnDummyHolder precedent.
    const holder = await spawnDummyHolder();
    try {
      const held = await blackboard.acquireLock('skill-exclusive:git-public-workflow', 'other-holder', holder.pid!, 5000);
      assert.ok(held, 'precondition: the other-holder lock must be acquired');
      const code = await publicSyncCommand([]);
      assert.equal(code, 5);
    } finally {
      await blackboard.releaseLock('skill-exclusive:git-public-workflow', 'other-holder');
      if (originalWaitMs === undefined) delete process.env.PA_PUBLIC_SYNC_LOCK_WAIT_MS;
      else process.env.PA_PUBLIC_SYNC_LOCK_WAIT_MS = originalWaitMs;
      holder.kill();
    }
  });

  it('--dry-run skips the lock entirely, even while another process holds it', async () => {
    const { mkdtemp, rm } = await import('fs/promises');
    const { publicSyncCommand } = await import('../src/commands/public-sync.js');
    const scratchPublicDir = await mkdtemp(join(tmpdir(), 'pa-pubsync-dryrun-'));

    const originalWaitMs = process.env.PA_PUBLIC_SYNC_LOCK_WAIT_MS;
    process.env.PA_PUBLIC_SYNC_LOCK_WAIT_MS = '500';
    const holder = await spawnDummyHolder();
    try {
      const held = await blackboard.acquireLock('skill-exclusive:git-public-workflow', 'other-holder', holder.pid!, 5000);
      assert.ok(held, 'precondition: the other-holder lock must be acquired');
      const code = await publicSyncCommand(['--public-dir', scratchPublicDir, '--dry-run']);
      assert.notEqual(code, 5, 'dry-run must reach syncPublicMirror rather than being blocked by the lock');
    } finally {
      await blackboard.releaseLock('skill-exclusive:git-public-workflow', 'other-holder');
      await rm(scratchPublicDir, { recursive: true, force: true }).catch(() => {});
      if (originalWaitMs === undefined) delete process.env.PA_PUBLIC_SYNC_LOCK_WAIT_MS;
      else process.env.PA_PUBLIC_SYNC_LOCK_WAIT_MS = originalWaitMs;
      holder.kill();
    }
  });
});
