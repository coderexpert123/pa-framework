import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBotMaintenanceJobs, type BotMaintenanceDeps } from '../maintenance-jobs.js';
import { validateRegistry } from '../../../../pa/dist/src/lib/maintenance/policy.js';
import { RUNTIME_ARCHIVE_MAX_BYTES } from '../../../../pa/dist/src/lib/archive-files.js';

let tempDir: string;
let originalPaHome: string | undefined;

function stubDeps(overrides: Partial<BotMaintenanceDeps> = {}): BotMaintenanceDeps {
  return {
    token: 'test-token',
    chatIds: [123, -456],
    sentinelPath: join(tempDir, 'telegram-bot.stop'),
    runModelSweep: async () => 0,
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'bot-maint-jobs-'));
  originalPaHome = process.env.PA_HOME;
  process.env.PA_HOME = tempDir;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  if (originalPaHome === undefined) delete process.env.PA_HOME;
  else process.env.PA_HOME = originalPaHome;
});

describe('createBotMaintenanceJobs', () => {
  it('produces a registry that passes validateRegistry', () => {
    assert.doesNotThrow(() => validateRegistry(createBotMaintenanceJobs(stubDeps())));
  });

  it('declares exactly the 5 expected jobs, all host bot', () => {
    const jobs = createBotMaintenanceJobs(stubDeps());
    assert.equal(jobs.length, 5);
    const names = jobs.map((j) => j.name).sort();
    assert.deepEqual(names, [
      'bot-log-rotation-check',
      'delivered-store-compact',
      'dlq-flush',
      'model-override-sweep',
      'proxy-pool-refresh',
    ]);
    for (const j of jobs) assert.equal(j.host, 'bot');
  });

  it('orders bot-log-rotation-check first and dlq-flush last', () => {
    const jobs = createBotMaintenanceJobs(stubDeps());
    assert.equal(jobs[0].name, 'bot-log-rotation-check');
    assert.equal(jobs[jobs.length - 1].name, 'dlq-flush');
  });

  it('locks shedWhenDegraded per job', () => {
    const jobs = createBotMaintenanceJobs(stubDeps());
    const byName = new Map(jobs.map((j) => [j.name, j]));
    assert.equal(byName.get('dlq-flush')!.shedWhenDegraded, false);
    assert.equal(byName.get('proxy-pool-refresh')!.shedWhenDegraded, false);
    assert.equal(byName.get('bot-log-rotation-check')!.shedWhenDegraded, true);
    assert.equal(byName.get('model-override-sweep')!.shedWhenDegraded, true);
    assert.equal(byName.get('delivered-store-compact')!.shedWhenDegraded, true);
  });

  it('locks the destructive set and its targets resolve under paHome()', () => {
    const jobs = createBotMaintenanceJobs(stubDeps());
    const destructiveNames = jobs.filter((j) => j.destructive).map((j) => j.name).sort();
    assert.deepEqual(destructiveNames, ['delivered-store-compact', 'dlq-flush']);
    for (const name of destructiveNames) {
      const job = jobs.find((j) => j.name === name)!;
      assert.ok(job.targets.length >= 1);
      for (const t of job.targets) {
        assert.ok(t.resolve().startsWith(tempDir), `${name} target should resolve under paHome()`);
      }
    }
  });

  it('locks cadences', async () => {
    const jobs = createBotMaintenanceJobs(stubDeps());
    const byName = new Map(jobs.map((j) => [j.name, j]));
    assert.equal(byName.get('bot-log-rotation-check')!.everyMs, 600_000);
    assert.equal(byName.get('model-override-sweep')!.everyMs, 60_000);
    assert.equal(byName.get('delivered-store-compact')!.everyMs, 300_000);
    assert.equal(byName.get('dlq-flush')!.everyMs, 300_000);
    const proxyEveryMs = byName.get('proxy-pool-refresh')!.everyMs;
    assert.equal(typeof proxyEveryMs, 'function');
    const resolved = (proxyEveryMs as () => number)();
    assert.ok(Number.isFinite(resolved) && resolved > 0);
  });

  it('model-override-sweep.run() returns and invokes the injected sweep', async () => {
    const calls: Array<{ token: string; chatIds: number[] }> = [];
    const deps = stubDeps({
      runModelSweep: async (token, chatIds) => {
        calls.push({ token, chatIds });
        return 7;
      },
    });
    const jobs = createBotMaintenanceJobs(deps);
    const job = jobs.find((j) => j.name === 'model-override-sweep')!;
    const result = await job.run({ now: Date.now(), everyMs: 60_000 });
    assert.equal(result.touched, 7);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].token, deps.token);
    assert.deepEqual(calls[0].chatIds, deps.chatIds);
  });

  describe('bot-log-rotation-check', () => {
    it('no log file present -> touched 0, no sentinel written', async () => {
      const deps = stubDeps();
      const jobs = createBotMaintenanceJobs(deps);
      const job = jobs.find((j) => j.name === 'bot-log-rotation-check')!;
      const result = await job.run({ now: Date.now(), everyMs: 600_000 });
      assert.equal(result.touched, 0);
      assert.equal(existsSync(deps.sentinelPath!), false);
    });

    it('oversized log -> touched 1 and sentinel written', async () => {
      const deps = stubDeps();
      const jobs = createBotMaintenanceJobs(deps);
      const job = jobs.find((j) => j.name === 'bot-log-rotation-check')!;
      await mkdir(join(tempDir, 'logs'), { recursive: true });
      await writeFile(
        join(tempDir, 'logs', 'telegram-bot.log'),
        Buffer.alloc(RUNTIME_ARCHIVE_MAX_BYTES + 1, 'x')
      );
      const result = await job.run({ now: Date.now(), everyMs: 600_000 });
      assert.equal(result.touched, 1);
      assert.equal(existsSync(deps.sentinelPath!), true);
    });

    it('oversized log but sentinelPath undefined -> touched 0, nothing thrown', async () => {
      const deps = stubDeps({ sentinelPath: undefined });
      const jobs = createBotMaintenanceJobs(deps);
      const job = jobs.find((j) => j.name === 'bot-log-rotation-check')!;
      await mkdir(join(tempDir, 'logs'), { recursive: true });
      await writeFile(
        join(tempDir, 'logs', 'telegram-bot.log'),
        Buffer.alloc(RUNTIME_ARCHIVE_MAX_BYTES + 1, 'x')
      );
      await assert.doesNotReject(() => job.run({ now: Date.now(), everyMs: 600_000 }));
      const result = await job.run({ now: Date.now(), everyMs: 600_000 });
      assert.equal(result.touched, 0);
    });
  });

  describe('dlq-flush', () => {
    it('no DLQ file present -> touched 0 and no network call attempted', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(() => {
        throw new Error('fetch should not be called when the DLQ file does not exist');
      }) as unknown as typeof fetch;
      try {
        const jobs = createBotMaintenanceJobs(stubDeps());
        const job = jobs.find((j) => j.name === 'dlq-flush')!;
        const result = await job.run({ now: Date.now(), everyMs: 300_000 });
        assert.equal(result.touched, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
