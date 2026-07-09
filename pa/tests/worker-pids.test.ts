import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, mkdir, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';

describe('worker-pids', () => {
  let dir: string;

  before(async () => {
    dir = await createTempPaHome();
  });

  after(async () => {
    await cleanup(dir);
  });

  it('addWorkerPid writes file, removeWorkerPid deletes it', async () => {
    const { addWorkerPid, removeWorkerPid } = await import('../src/worker-pids.js');

    await addWorkerPid({
      pid: 1234,
      spawnedBy: 5678,
      worker: 'zclaude',
      skill: 'test',
      startedAt: new Date().toISOString(),
    });

    const pidFile = join(dir, 'worker-pids', '1234.json');
    await assert.doesNotReject(access(pidFile), 'PID file should exist after addWorkerPid');

    const raw = await readFile(pidFile, 'utf8');
    const entry = JSON.parse(raw);
    assert.equal(entry.pid, 1234);
    assert.equal(entry.spawnedBy, 5678);
    assert.equal(entry.worker, 'zclaude');

    await removeWorkerPid(1234);
    await assert.rejects(access(pidFile), 'PID file should be gone after removeWorkerPid');
  });

  it('cleanupOrphanedWorkers removes file when spawner is dead, skips kill when worker is already dead', async () => {
    const { cleanupOrphanedWorkers } = await import('../src/worker-pids.js');

    // Write a PID file with two dead PIDs (both 999998 and 999999 are virtually guaranteed not to exist)
    const pidsDir = join(dir, 'worker-pids');
    await mkdir(pidsDir, { recursive: true });
    await writeFile(
      join(pidsDir, '999998.json'),
      JSON.stringify({ pid: 999998, spawnedBy: 999999, worker: 'zclaude', skill: 'test', startedAt: new Date().toISOString() }),
      'utf8'
    );

    const killed = await cleanupOrphanedWorkers();
    // Worker (999998) was already dead, so no kill — count is 0
    assert.equal(killed, 0);
    // File should be removed (spawner 999999 is dead)
    await assert.rejects(access(join(pidsDir, '999998.json')), 'PID file should be removed when spawner is dead');
  });

  it('cleanupOrphanedWorkers leaves file untouched when spawner is alive', async () => {
    const { cleanupOrphanedWorkers } = await import('../src/worker-pids.js');

    const pidsDir = join(dir, 'worker-pids');
    await mkdir(pidsDir, { recursive: true });
    await writeFile(
      join(pidsDir, '999997.json'),
      JSON.stringify({ pid: 999997, spawnedBy: process.pid, worker: 'zclaude', skill: 'test', startedAt: new Date().toISOString() }),
      'utf8'
    );

    const killed = await cleanupOrphanedWorkers();
    assert.equal(killed, 0);
    // File must still exist — spawner (current process) is alive, so cleanup must not touch it
    await assert.doesNotReject(access(join(pidsDir, '999997.json')), 'PID file must remain when spawner is alive');

    // Cleanup manually
    const { removeWorkerPid } = await import('../src/worker-pids.js');
    await removeWorkerPid(999997);
  });

  it('cleanupOrphanedWorkers returns 0 when no directory exists', async () => {
    const { cleanupOrphanedWorkers } = await import('../src/worker-pids.js');
    // pids dir does not exist (we have a fresh temp PA_HOME for this suite but no worker-pids subdir
    // might exist from previous tests — that's fine, cleanup still returns 0 for an empty/missing dir)
    const killed = await cleanupOrphanedWorkers();
    assert.equal(killed, 0);
  });

  it('isProcessAlive returns true for current process, false for dead PID', async () => {
    const { isProcessAlive } = await import('../src/worker-pids.js');
    assert.equal(isProcessAlive(process.pid), true, 'current process should be alive');
    assert.equal(isProcessAlive(999999), false, 'PID 999999 should not exist');
  });

  it('cleanupOrphanedWorkers skips entries whose skill is excluded (AI-095 reaper protection)', async () => {
    const { cleanupOrphanedWorkers, removeWorkerPid } = await import('../src/worker-pids.js');

    const pidsDir = join(dir, 'worker-pids');
    await mkdir(pidsDir, { recursive: true });
    // Dead spawner + dead worker → normally the file would be removed.
    await writeFile(
      join(pidsDir, '999996.json'),
      JSON.stringify({ pid: 999996, spawnedBy: 999999, worker: 'claude', skill: 'topic--100_5', startedAt: new Date().toISOString() }),
      'utf8'
    );

    await cleanupOrphanedWorkers(new Set(['topic--100_5']));
    await assert.doesNotReject(access(join(pidsDir, '999996.json')), 'excluded entry must be left for the reaper');

    // Without the exclusion it is cleaned up as before.
    await cleanupOrphanedWorkers();
    await assert.rejects(access(join(pidsDir, '999996.json')), 'entry removed once no longer excluded');
    await removeWorkerPid(999996);
  });

  it('updateWorkerPidDescendants persists the live tree; no-op for unknown pid', async () => {
    const { addWorkerPid, updateWorkerPidDescendants, listWorkerPids, removeWorkerPid } = await import('../src/worker-pids.js');

    await addWorkerPid({ pid: 999994, spawnedBy: process.pid, worker: 'claude', skill: 'topic--100_7', startedAt: new Date().toISOString() });
    await updateWorkerPidDescendants(999994, [111, 222]);
    const entry = (await listWorkerPids()).find((e) => e.pid === 999994);
    assert.deepEqual(entry?.descendants, [111, 222]);
    // preserves original fields
    assert.equal(entry?.skill, 'topic--100_7');

    await assert.doesNotReject(updateWorkerPidDescendants(123456789, [1])); // unknown pid — silent no-op
    await removeWorkerPid(999994);
  });

  it('listWorkerPids returns registered entries and skips corrupt files', async () => {
    const { addWorkerPid, listWorkerPids, removeWorkerPid } = await import('../src/worker-pids.js');

    const pidsDir = join(dir, 'worker-pids');
    await mkdir(pidsDir, { recursive: true });
    await addWorkerPid({ pid: 999995, spawnedBy: process.pid, worker: 'claude', skill: 'topic--100_9', startedAt: new Date().toISOString() });
    await writeFile(join(pidsDir, 'corrupt.json'), 'not-json{{{', 'utf8');

    const entries = await listWorkerPids();
    const mine = entries.find((e) => e.pid === 999995);
    assert.ok(mine, 'registered entry listed');
    assert.equal(mine!.skill, 'topic--100_9');

    await removeWorkerPid(999995);
    await unlink(join(pidsDir, 'corrupt.json')).catch(() => {});
  });
});
