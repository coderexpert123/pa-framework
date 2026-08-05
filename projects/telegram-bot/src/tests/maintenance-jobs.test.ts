import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBotMaintenanceJobs, type BotMaintenanceDeps } from '../maintenance-jobs.js';
import { validateRegistry } from '../../../../pa/dist/src/lib/maintenance/policy.js';
import { RUNTIME_ARCHIVE_MAX_BYTES } from '../../../../pa/dist/src/lib/archive-files.js';
import type { TopicNameMap } from '../topic-names.js';

let tempDir: string;
let originalPaHome: string | undefined;

function stubDeps(overrides: Partial<BotMaintenanceDeps> = {}): BotMaintenanceDeps {
  return {
    token: 'test-token',
    chatIds: [123, -456],
    sentinelPath: join(tempDir, 'telegram-bot.stop'),
    runModelSweep: async () => 0,
    topicNames: new Map(),
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

  it('declares exactly the 6 expected jobs, all host bot', () => {
    const jobs = createBotMaintenanceJobs(stubDeps());
    assert.equal(jobs.length, 6);
    const names = jobs.map((j) => j.name).sort();
    assert.deepEqual(names, [
      'bot-log-rotation-check',
      'delivered-store-compact',
      'dlq-flush',
      'grounding-check',
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
    assert.equal(byName.get('grounding-check')!.shedWhenDegraded, true);
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
    assert.equal(byName.get('grounding-check')!.everyMs, 21_600_000);
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

  describe('grounding-check', () => {
    function mapWith(entries: Array<{ chatId: string; threadId: number; name: string; description?: string }>): TopicNameMap {
      const map: TopicNameMap = new Map();
      for (const e of entries) {
        let inner = map.get(e.chatId);
        if (!inner) { inner = new Map(); map.set(e.chatId, inner); }
        inner.set(e.threadId, { name: e.name, description: e.description });
      }
      return map;
    }

    it('empty topicNames -> touched 0', async () => {
      const jobs = createBotMaintenanceJobs(stubDeps({ topicNames: new Map() }));
      const job = jobs.find((j) => j.name === 'grounding-check')!;
      const result = await job.run({ now: Date.now(), everyMs: 21_600_000 });
      assert.equal(result.touched, 0);
    });

    it('all clean descriptions -> touched 0', async () => {
      const topicNames = mapWith([
        { chatId: '-100', threadId: 1, name: 'a', description: 'A normal, curated description.' },
        { chatId: '-100', threadId: 2, name: 'b' }, // no description — not flagged, separate gap
      ]);
      const jobs = createBotMaintenanceJobs(stubDeps({ topicNames }));
      const job = jobs.find((j) => j.name === 'grounding-check')!;
      const result = await job.run({ now: Date.now(), everyMs: 21_600_000 });
      assert.equal(result.touched, 0);
    });

    it('flags a description ending in "?"', async () => {
      const topicNames = mapWith([
        { chatId: '-100', threadId: 1, name: 'a', description: 'What were you trying to say?' },
      ]);
      const jobs = createBotMaintenanceJobs(stubDeps({ topicNames }));
      const job = jobs.find((j) => j.name === 'grounding-check')!;
      const result = await job.run({ now: Date.now(), everyMs: 21_600_000 });
      assert.equal(result.touched, 1);
      assert.equal((result.detail!.suspicious as unknown[]).length, 1);
    });

    it('flags a voice-message-clobbered description', async () => {
      const topicNames = mapWith([
        { chatId: '-100', threadId: 1, name: 'a', description: '[Voice message] So, what do I need to do for today?' },
      ]);
      const jobs = createBotMaintenanceJobs(stubDeps({ topicNames }));
      const job = jobs.find((j) => j.name === 'grounding-check')!;
      const result = await job.run({ now: Date.now(), everyMs: 21_600_000 });
      assert.equal(result.touched, 1);
    });

    it('flags multiple suspicious topics across multiple chats', async () => {
      const topicNames = mapWith([
        { chatId: '-100', threadId: 1, name: 'a', description: 'It looks like your message was cut short.' },
        { chatId: '-200', threadId: 5, name: 'b', description: 'Description set.' },
        { chatId: '-100', threadId: 9, name: 'c', description: 'A fine description.' },
      ]);
      const jobs = createBotMaintenanceJobs(stubDeps({ topicNames }));
      const job = jobs.find((j) => j.name === 'grounding-check')!;
      const result = await job.run({ now: Date.now(), everyMs: 21_600_000 });
      assert.equal(result.touched, 2);
    });

    it('runs without throwing when notifyUser has nowhere to send (PA_NOTIFY_DISABLED set globally in tests)', async () => {
      const topicNames = mapWith([{ chatId: '-100', threadId: 1, name: 'a', description: 'Bad description?' }]);
      const jobs = createBotMaintenanceJobs(stubDeps({ topicNames }));
      const job = jobs.find((j) => j.name === 'grounding-check')!;
      await assert.doesNotReject(() => job.run({ now: Date.now(), everyMs: 21_600_000 }));
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
