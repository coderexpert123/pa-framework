import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, createTempSkill, createTempConfig, cleanup } from './helpers.js';
import { runCommand, exclusiveLockKey, lockWaitBudgetMs } from '../src/commands/run.js';
import { blackboard } from '../src/blackboard.js';
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

  it('reserves half the skill timeout for waiting, floored at a small minimum', () => {
    assert.equal(lockWaitBudgetMs(600), 300_000);
    assert.equal(lockWaitBudgetMs(3600), 1_800_000);
    assert.equal(lockWaitBudgetMs(1), 2_000); // floor engages
    assert.equal(lockWaitBudgetMs(undefined), 150_000); // default 300s timeout
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
