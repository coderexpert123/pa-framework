import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBotMaintenanceJobs, watchdogStaleJobs, checkRegistryContentInvariants, sweepExpiredPendingActions, DRAIN_SOURCE_SPECS, type BotMaintenanceDeps, type RegistryContentViolation } from '../maintenance-jobs.js';
import { PENDING_ACTION_TTL_MS } from '../logic.js';
import type { RegistryContentRule } from '../registry-content-rules.js';
import { validateRegistry } from '../../../../pa/dist/src/lib/maintenance/policy.js';
import { registryContentWatchJob as registryContentWatchStub } from '../../../../pa/dist/src/lib/maintenance/jobs/registry-content-watch.js';
import { RUNTIME_ARCHIVE_MAX_BYTES } from '../../../../pa/dist/src/lib/archive-files.js';
import { flushLog } from '../../../../pa/dist/src/lib/log.js';
import { loadJobState, updateJobState } from '../../../../pa/dist/src/lib/maintenance/state.js';
import type { TopicNameMap } from '../topic-names.js';
import { waitForDrain } from './test-teardown-guard.js';

/**
 * Config-shaped rule fixtures matching ~/.pa/registry-content-rules.json format.
 * These test fixtures reflect the deployed rules (whatsapp-drafts, pa-alerts, ekadashi).
 */
const TEST_RULES: RegistryContentRule[] = [
  {
    topic_key: 'whatsapp-drafts',
    thread_id: 9855,
    require_contains: 'INSTRUCTIONS.md',
    label: 'Path-0 pointer',
  },
  {
    topic_key: 'pa-alerts',
    thread_id: 3376,
    forbid_contains: 'Palo Alto',
    label: 'no hallucinated gloss',
  },
  {
    topic_key: 'ekadashi',
    thread_id: 7822,
    require_contains: 'Sources.md',
    label: 'deterministic routing gate',
  },
];

let tempDir: string;
let originalPaHome: string | undefined;

function stubDeps(overrides: Partial<BotMaintenanceDeps> = {}): BotMaintenanceDeps {
  return {
    token: 'test-token',
    chatIds: [123, -456],
    sentinelPath: join(tempDir, 'telegram-bot.stop'),
    runModelSweep: async () => 0,
    topicNames: new Map(),
    requeueDrain: async () => 0,
    reminderResumeDrain: async () => 0,
    topicTaskDrain: async () => 0,
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'bot-maint-jobs-'));
  originalPaHome = process.env.PA_HOME;
  process.env.PA_HOME = tempDir;
});

afterEach(async () => {
  // Drain the pa logger's fire-and-forget append queue BEFORE removing the
  // temp PA_HOME — the jobs under test call logger.info/warn, whose queued
  // appends target ${PA_HOME}/app.log.jsonl and would otherwise race this
  // rm (late ensureLogFile mkdir / append recreating entries mid-delete →
  // ENOTEMPTY, observed deterministically 2026-08-13). Same contract as
  // pa/tests/helpers.ts's cleanup().
  await flushLog();
  await rm(tempDir, { recursive: true, force: true });
  await waitForDrain();
  if (originalPaHome === undefined) delete process.env.PA_HOME;
  else process.env.PA_HOME = originalPaHome;
});

describe('createBotMaintenanceJobs', () => {
  it('produces a registry that passes validateRegistry', () => {
    assert.doesNotThrow(() => validateRegistry(createBotMaintenanceJobs(stubDeps())));
  });

  it('declares exactly the 10 expected jobs, all host bot', () => {
    const jobs = createBotMaintenanceJobs(stubDeps());
    assert.equal(jobs.length, 10);
    const names = jobs.map((j) => j.name).sort();
    assert.deepEqual(names, [
      'alert-digest',
      'bot-log-rotation-check',
      'bot-self-restart',
      'dashboard-refresh',
      'delivered-store-compact',
      'grounding-check',
      'model-override-sweep',
      'proxy-pool-refresh',
      'queue-drain',
      'registry-content-watch',
    ]);
    for (const j of jobs) assert.equal(j.host, 'bot');
  });

  it('queue-drain replaces four jobs with one', () => {
    const jobs = createBotMaintenanceJobs(stubDeps());
    assert.ok(jobs.some((j) => j.name === 'queue-drain'), 'queue-drain must be registered');
    for (const gone of ['requeue-drain', 'reminder-resume-drain', 'topic-task-drain', 'dlq-flush']) {
      assert.equal(jobs.some((j) => j.name === gone), false, `'${gone}' must be gone from the bot job array`);
    }
    const drains = jobs.filter((j) => j.name.includes('drain') || j.name.includes('flush'));
    assert.equal(drains.length, 1, 'exactly ONE drain-family job may remain');
    assert.equal(drains[0].name, 'queue-drain');
  });

  it('orders bot-log-rotation-check first, queue-drain after dashboard-refresh, alert-digest is last', () => {
    const jobs = createBotMaintenanceJobs(stubDeps());
    assert.equal(jobs[0].name, 'bot-log-rotation-check');
    assert.equal(jobs[jobs.length - 1].name, 'alert-digest');
    assert.equal(jobs[jobs.length - 2].name, 'bot-self-restart');
    assert.equal(jobs[jobs.length - 3].name, 'queue-drain');
    const registryIdx = jobs.findIndex((j) => j.name === 'registry-content-watch');
    const dashboardIdx = jobs.findIndex((j) => j.name === 'dashboard-refresh');
    const queueIdx = jobs.findIndex((j) => j.name === 'queue-drain');
    assert.equal(dashboardIdx, registryIdx + 1, 'dashboard-refresh immediately follows registry-content-watch');
    assert.equal(queueIdx, dashboardIdx + 1, 'queue-drain sits where topic-task-drain sat (right after dashboard-refresh)');
  });

  it('locks shedWhenDegraded per job', () => {
    const jobs = createBotMaintenanceJobs(stubDeps());
    const byName = new Map(jobs.map((j) => [j.name, j]));
    assert.equal(byName.get('proxy-pool-refresh')!.shedWhenDegraded, false);
    assert.equal(byName.get('bot-log-rotation-check')!.shedWhenDegraded, true);
    assert.equal(byName.get('model-override-sweep')!.shedWhenDegraded, true);
    assert.equal(byName.get('delivered-store-compact')!.shedWhenDegraded, true);
    assert.equal(byName.get('grounding-check')!.shedWhenDegraded, true);
    assert.equal(byName.get('registry-content-watch')!.shedWhenDegraded, true);
    assert.equal(byName.get('dashboard-refresh')!.shedWhenDegraded, true);
    assert.equal(byName.get('alert-digest')!.shedWhenDegraded, true);
    assert.equal(byName.get('queue-drain')!.shedWhenDegraded, false);
  });

  it('locks the destructive set and its targets resolve under paHome()', () => {
    const jobs = createBotMaintenanceJobs(stubDeps());
    const destructiveNames = jobs.filter((j) => j.destructive).map((j) => j.name).sort();
    assert.deepEqual(destructiveNames, ['delivered-store-compact']);
    for (const name of destructiveNames) {
      const job = jobs.find((j) => j.name === name)!;
      assert.ok(job.targets.length >= 1);
      for (const t of job.targets) {
        assert.ok(t.resolve().startsWith(tempDir), `${name} target should resolve under paHome()`);
      }
    }
    // The DLQ TTL-drop declaration went away WITH the dlq-flush stub (frozen
    // spec §3.2: queue-drain is non-destructive, no targets) — the BEHAVIOR
    // (expired-entry dropping on flush) lives in dlq.ts's flushDlq and is
    // unchanged; only the preview/audit declaration was consolidated away.
  });

  it('locks cadences', async () => {
    const jobs = createBotMaintenanceJobs(stubDeps());
    const byName = new Map(jobs.map((j) => [j.name, j]));
    assert.equal(byName.get('bot-log-rotation-check')!.everyMs, 600_000);
    assert.equal(byName.get('model-override-sweep')!.everyMs, 60_000);
    assert.equal(byName.get('delivered-store-compact')!.everyMs, 300_000);
    assert.equal(byName.get('grounding-check')!.everyMs, 21_600_000);
    assert.equal(byName.get('registry-content-watch')!.everyMs, 86_400_000);
    assert.equal(byName.get('dashboard-refresh')!.everyMs, 1_800_000);
    assert.equal(byName.get('alert-digest')!.everyMs, 86_400_000);
    assert.equal(byName.get('queue-drain')!.everyMs, 60_000, 'the family minimum');
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

  describe('queue-drain (consolidated family, SPEC §3.2)', () => {
    /** The injected deps are only DUE for a source when the job's synthetic
     *  clock says so — seeded sources (requeue/dlq) need now past creation+5m,
     *  unseeded ones (reminder-resume/topic-task) fire on the first tick. */
    function queueJob(deps: BotMaintenanceDeps): MaintenanceJobLike {
      return createBotMaintenanceJobs(deps).find((j) => j.name === 'queue-drain')!;
    }
    type MaintenanceJobLike = ReturnType<typeof createBotMaintenanceJobs>[number];

    it('queue-drain requeue source invokes the injected drain and reports touched', async () => {
      let calls = 0;
      const deps = stubDeps({
        requeueDrain: async () => {
          calls++;
          return 3;
        },
      });
      const result = await queueJob(deps).run({ now: Date.now() + 301_000, everyMs: 60_000 });
      assert.equal(result.touched, 3);
      assert.equal(calls, 1);
      assert.equal((result.detail!.sources as Record<string, number>).requeue, 3);
    });

    it('queue-drain reminder-resume source invokes the injected drain and reports touched', async () => {
      let calls = 0;
      const deps = stubDeps({
        reminderResumeDrain: async () => {
          calls++;
          return 2;
        },
      });
      const result = await queueJob(deps).run({ now: Date.now() + 1_000, everyMs: 60_000 });
      assert.equal(result.touched, 2);
      assert.equal(calls, 1);
      assert.equal((result.detail!.sources as Record<string, number>)['reminder-resume'], 2);
    });

    it('queue-drain topic-task source invokes the injected drain and reports touched', async () => {
      let calls = 0;
      const deps = stubDeps({
        topicTaskDrain: async () => {
          calls++;
          return 5;
        },
      });
      const result = await queueJob(deps).run({ now: Date.now() + 1_000, everyMs: 60_000 });
      assert.equal(result.touched, 5);
      assert.equal(calls, 1);
      assert.equal((result.detail!.sources as Record<string, number>)['topic-task'], 5);
    });

    it('queue-drain dlq source touches 0 with no DLQ file and never attempts a send', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(() => {
        throw new Error('fetch should not be called when the DLQ file does not exist');
      }) as unknown as typeof fetch;
      try {
        const deps = stubDeps();
        const result = await queueJob(deps).run({ now: Date.now() + 301_000, everyMs: 60_000 });
        assert.equal(result.touched, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('sources declare cadence seed and semantics', () => {
      assert.deepEqual(DRAIN_SOURCE_SPECS.map((s) => s.name), ['requeue', 'reminder-resume', 'topic-task', 'dlq']);
      assert.deepEqual(DRAIN_SOURCE_SPECS.map((s) => s.everyMs), [300_000, 60_000, 60_000, 300_000]);
      assert.deepEqual(DRAIN_SOURCE_SPECS.map((s) => s.coldStartSeed), [true, false, false, true]);
      assert.deepEqual(DRAIN_SOURCE_SPECS.map((s) => [...s.semantics]), [
        ['pop-first', 'persist-before-inject', 'no-age-drop'],
        ['pop-first', 'persist-before-inject', 'no-age-drop'],
        ['pop-first', 'persist-before-inject', 'no-age-drop'],
        ['entry-idempotent', 'send-before-mark'],
      ]);
    });

    it('semantics assertions match source implementations', () => {
      // The per-source SEMANTIC behavior itself (pop-first, persist-before-
      // inject, no age drop; dlq's send-before-mark) is pinned where the
      // implementations live: the reminder-resume/system-resume canaries and
      // the topic-tasks-drain suite. This pin keeps the REGISTRY's declaration
      // honest: the three injectors share the identical pipeline triple, and
      // dlq's contract is a different shape (mark-after-send, idempotent
      // entries), never silently edited to look like the others.
      const injector = ['pop-first', 'persist-before-inject', 'no-age-drop'];
      const byName = new Map(DRAIN_SOURCE_SPECS.map((s) => [s.name, s]));
      for (const name of ['requeue', 'reminder-resume', 'topic-task'] as const) {
        assert.deepEqual([...byName.get(name)!.semantics], injector, `${name} must declare the injector triple`);
      }
      const dlqSem = [...byName.get('dlq')!.semantics];
      assert.ok(!dlqSem.includes('pop-first'), 'dlq is a mark-after-send retry loop, not an injector');
      assert.deepEqual(dlqSem, ['entry-idempotent', 'send-before-mark']);
    });

    it('per-source due gating honors everyMs', async () => {
      const counts = { requeue: 0, reminder: 0, topic: 0 };
      const deps = stubDeps({
        requeueDrain: async () => {
          counts.requeue++;
          return 0;
        },
        reminderResumeDrain: async () => {
          counts.reminder++;
          return 0;
        },
        topicTaskDrain: async () => {
          counts.topic++;
          return 0;
        },
      });
      const job = queueJob(deps);
      const t0 = Date.now(); // ≥ the creation-time seed stamp (microseconds earlier)

      // Tick 1 (+1s): the UNSEEDED 60s sources fire; requeue/dlq were seeded
      // "just ran" at creation and are not due.
      await job.run({ now: t0 + 1_000, everyMs: 60_000 });
      assert.equal(counts.reminder, 1);
      assert.equal(counts.topic, 1);
      assert.equal(counts.requeue, 0, 'requeue is cold-start-seeded');

      // Tick 2 (+30s): inside the 60s window stamped at tick 1 — nothing due.
      await job.run({ now: t0 + 30_000, everyMs: 60_000 });
      assert.equal(counts.reminder, 1);

      // Tick 3 (+70s): past the 60s sources' stamps — due again.
      await job.run({ now: t0 + 70_000, everyMs: 60_000 });
      assert.equal(counts.reminder, 2);
      assert.equal(counts.topic, 2);
      assert.equal(counts.requeue, 0, 'requeue still inside its 5m cold-start window');

      // Tick 4 (+320s): past the seeded 5m — requeue finally due.
      await job.run({ now: t0 + 320_000, everyMs: 60_000 });
      assert.equal(counts.requeue, 1);
    });

    it('one failing source does not fail the job', async () => {
      // reminder-resume is the thrower: UNSEEDED (coldStartSeed false), so it
      // actually fires on the first tick — the seeded requeue/dlq would
      // silently skip and the throw would never happen (first version of this
      // test used requeue and its counter stayed 0 — the gate caught it).
      let reminderAttempts = 0;
      let topicRan = 0;
      const deps = stubDeps({
        reminderResumeDrain: async () => {
          reminderAttempts++;
          throw new Error('reminder source exploded');
        },
        topicTaskDrain: async () => {
          topicRan++;
          return 4;
        },
      });
      const job = queueJob(deps);
      const t0 = Date.now();

      // The throw is contained: the job resolves, the survivor counts.
      const result = await job.run({ now: t0 + 1_000, everyMs: 60_000 });
      assert.equal(result.touched, 4, 'the surviving source still counts');
      assert.equal(topicRan, 1);
      assert.equal(reminderAttempts, 1);
      assert.equal((result.detail!.sources as Record<string, number>)['reminder-resume'], undefined, 'the failed source contributes nothing');

      // Stamp-before-run holds FOR FAILURES TOO: the failed source waits out
      // its own cadence instead of re-failing every 60s tick (per-source
      // failures are invisible to the runner's job-level backoff ladder).
      await job.run({ now: t0 + 30_000, everyMs: 60_000 });
      assert.equal(reminderAttempts, 1, 'the failed source did NOT re-fire inside its 60s');
      assert.equal(topicRan, 1, 'the healthy source is due-gated the same way');
      await job.run({ now: t0 + 70_000, everyMs: 60_000 });
      assert.equal(reminderAttempts, 2, 'it retries after its own cadence');
      assert.equal(topicRan, 2);
    });

    it('cold start seeds requeue and dlq sources only', async () => {
      // The flags: exactly requeue + dlq carry coldStartSeed.
      assert.deepEqual(
        DRAIN_SOURCE_SPECS.filter((s) => s.coldStartSeed).map((s) => s.name).sort(),
        ['dlq', 'requeue'],
      );
      // The behavior: on the first tick after creation only the UNSEEDED
      // sources run. dlq's skip is proven by its flag above (its runner is
      // the imported flushDlq, not an injectable spy — the moved dlq source
      // test covers its run path).
      const ran: string[] = [];
      const deps = stubDeps({
        requeueDrain: async () => {
          ran.push('requeue');
          return 0;
        },
        reminderResumeDrain: async () => {
          ran.push('reminder-resume');
          return 0;
        },
        topicTaskDrain: async () => {
          ran.push('topic-task');
          return 0;
        },
      });
      const job = queueJob(deps);
      await job.run({ now: Date.now() + 1_000, everyMs: 60_000 });
      assert.deepEqual(ran.sort(), ['reminder-resume', 'topic-task']);
    });
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

  describe('watchdogStaleJobs (P2-3)', () => {
    it('does nothing when no jobs have in-flight markers', async () => {
      const jobs = createBotMaintenanceJobs(stubDeps());
      await assert.doesNotReject(() => watchdogStaleJobs(jobs));
    });

    it('clears an in-flight marker older than 10x everyMs', async () => {
      const jobs = createBotMaintenanceJobs(stubDeps());
      const job = jobs.find((j) => j.name === 'model-override-sweep')!;
      // Set in-flight marker 15 minutes ago (10x 60s everyMs = 10min)
      const oldTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      await updateJobState(job.name, (prev) => ({ ...prev, inFlight: true, inFlightSince: oldTime, lastRunAt: oldTime, lastSkipReason: undefined }));
      const beforeState = await loadJobState(job.name);
      assert.equal(beforeState.inFlight, true);

      await watchdogStaleJobs(jobs);

      const afterState = await loadJobState(job.name);
      assert.equal(afterState.inFlight, false);
      assert.equal(afterState.inFlightSince, null);
    });

    it('does not clear an in-flight marker younger than 10x everyMs', async () => {
      const jobs = createBotMaintenanceJobs(stubDeps());
      const job = jobs.find((j) => j.name === 'model-override-sweep')!;
      // Set in-flight marker 2 minutes ago (well under 10x 60s everyMs = 10min)
      const recentTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      await updateJobState(job.name, (prev) => ({ ...prev, inFlight: true, inFlightSince: recentTime, lastRunAt: recentTime, lastSkipReason: undefined }));
      const beforeState = await loadJobState(job.name);
      assert.equal(beforeState.inFlight, true);

      await watchdogStaleJobs(jobs);

      const afterState = await loadJobState(job.name);
      assert.equal(afterState.inFlight, true);
      assert.equal(afterState.inFlightSince, recentTime);
    });

    it('skips jobs without everyMs defined', async () => {
      const jobs = createBotMaintenanceJobs(stubDeps());
      const jobWithNoEveryMs = { ...jobs[0], everyMs: 0 };
      await assert.doesNotReject(() => watchdogStaleJobs([jobWithNoEveryMs]));
    });

    it('continues after one job fails to load state', async () => {
      const jobs = createBotMaintenanceJobs(stubDeps());
      // Manually corrupt one job's state file
      const job = jobs[0];
      await updateJobState(job.name, (prev) => ({ ...prev, inFlight: true, inFlightSince: new Date().toISOString(), lastRunAt: new Date().toISOString(), lastSkipReason: undefined }));
      // Then delete the PA_HOME to make loadJobState fail for subsequent jobs
      const originalPaHome = process.env.PA_HOME;
      process.env.PA_HOME = '/nonexistent/path';
      try {
        await assert.doesNotReject(() => watchdogStaleJobs(jobs));
      } finally {
        process.env.PA_HOME = originalPaHome;
      }
    });
  });

  describe('bot-self-restart', () => {
    it('bound job stays in parity with the frozen pa-side stub contract (name/host/everyMs/destructive/shedWhenDegraded)', () => {
      // pa/src/lib/maintenance/jobs/bot-self-restart.ts (WP-D's stub) is
      // frozen byte-for-byte in
      // plans/2026-08-24-recall-traces-wave-SPEC.md §3.4 step 10. WP-D lands
      // in a later batch than WP-G (§4 batch 1 vs batch 2), so at WP-G build
      // time that module does not exist in pa/dist and cannot be imported
      // here (unlike the registry-content-watch parity case above). These
      // five literals are copied byte-for-byte from that frozen contract —
      // see the INTEGRATOR note above botSelfRestartJobStub in
      // ../maintenance-jobs.ts once WP-D's real stub lands.
      const jobs = createBotMaintenanceJobs(stubDeps());
      const bound = jobs.find((j) => j.name === 'bot-self-restart')!;
      assert.equal(bound.name, 'bot-self-restart');
      assert.equal(bound.host, 'bot');
      assert.equal(bound.everyMs, 60_000);
      assert.equal(bound.destructive, false);
      assert.equal(bound.shedWhenDegraded, true);
    });

    it('run() with sentinelPath undefined returns touched:0 and writes nothing (early return before any I/O)', async () => {
      const deps = stubDeps({ sentinelPath: undefined });
      const jobs = createBotMaintenanceJobs(deps);
      const job = jobs.find((j) => j.name === 'bot-self-restart')!;
      const before = await readdir(tempDir);
      const result = await job.run({ now: Date.now(), everyMs: 60_000 });
      assert.equal(result.touched, 0);
      assert.equal(result.detail?.reason, 'no-sentinel');
      const after = await readdir(tempDir);
      assert.deepEqual(after, before);
    });
  });

  describe('registry-content-watch', () => {
    function mapWith(entries: Array<{ chatId: string; threadId: number; name: string; description?: string }>): TopicNameMap {
      const map: TopicNameMap = new Map();
      for (const e of entries) {
        let inner = map.get(e.chatId);
        if (!inner) { inner = new Map(); map.set(e.chatId, inner); }
        inner.set(e.threadId, { name: e.name, description: e.description });
      }
      return map;
    }

    it('pure check function: green on current-shaped fixtures (all invariants pass)', () => {
      const topicNames = mapWith([
        { chatId: '-100', threadId: 9855, name: 'whatsapp-drafts', description: 'WhatsApp drafting topic — first read projects/whatsapp-drafts/INSTRUCTIONS.md and follow it exactly' },
        { chatId: '-100', threadId: 3376, name: 'pa-alerts', description: 'PA system alerts and notifications' },
        { chatId: '-100', threadId: 7822, name: 'ekadashi', description: 'Ekadashi alerts — see Sources.md for schedule' },
      ]);
      const violations = checkRegistryContentInvariants(TEST_RULES, topicNames);
      assert.deepEqual(violations, []);
    });

    it('pure check function: red when whatsapp-drafts (9855) lacks INSTRUCTIONS.md pointer', () => {
      const topicNames = mapWith([
        { chatId: '-100', threadId: 9855, name: 'whatsapp-drafts', description: 'WhatsApp drafting topic' },
      ]);
      const violations = checkRegistryContentInvariants(TEST_RULES, topicNames);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].topicKey, 'whatsapp-drafts');
      assert.equal(violations[0].invariantLabel, 'Path-0 pointer');
    });

    it('pure check function: red when pa-alerts (3376) contains Palo Alto hallucination', () => {
      const topicNames = mapWith([
        { chatId: '-100', threadId: 3376, name: 'pa-alerts', description: 'PA alerts — Palo Alto system notifications' },
      ]);
      const violations = checkRegistryContentInvariants(TEST_RULES, topicNames);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].topicKey, 'pa-alerts');
      assert.equal(violations[0].invariantLabel, 'no hallucinated gloss');
    });

    it('pure check function: red when ekadashi (7822) lacks Sources.md pointer', () => {
      const topicNames = mapWith([
        { chatId: '-100', threadId: 7822, name: 'ekadashi', description: 'Ekadashi fasting alerts' },
      ]);
      const violations = checkRegistryContentInvariants(TEST_RULES, topicNames);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].topicKey, 'ekadashi');
      assert.equal(violations[0].invariantLabel, 'deterministic routing gate');
    });

    it('pure check function: reports multiple violations in one pass', () => {
      const topicNames = mapWith([
        { chatId: '-100', threadId: 9855, name: 'whatsapp-drafts', description: 'Broken description' },
        { chatId: '-100', threadId: 3376, name: 'pa-alerts', description: 'Contains Palo Alto' },
        { chatId: '-100', threadId: 7822, name: 'ekadashi', description: 'No Sources pointer' },
      ]);
      const violations = checkRegistryContentInvariants(TEST_RULES, topicNames);
      assert.equal(violations.length, 3);
      const labels = violations.map((v) => v.invariantLabel).sort();
      assert.deepEqual(labels, ['Path-0 pointer', 'deterministic routing gate', 'no hallucinated gloss']);
    });

    it('job integration: touched 0 when all invariants pass', async () => {
      const topicNames = mapWith([
        { chatId: '-100', threadId: 9855, name: 'whatsapp-drafts', description: 'See INSTRUCTIONS.md for details' },
        { chatId: '-100', threadId: 3376, name: 'pa-alerts', description: 'Alerts topic' },
        { chatId: '-100', threadId: 7822, name: 'ekadashi', description: 'Read Sources.md' },
      ]);
      const jobs = createBotMaintenanceJobs(stubDeps({ topicNames }));
      const job = jobs.find((j) => j.name === 'registry-content-watch')!;
      const result = await job.run({ now: Date.now(), everyMs: 86_400_000 });
      assert.equal(result.touched, 0);
      assert.deepEqual(result.detail!.violations, []);
    });

    it('job integration: touched equals violation count', async () => {
      // The job loads rules from $PA_HOME/registry-content-rules.json — write
      // fixture rules matching the stub topics before running.
      const rulesPath = join(process.env.PA_HOME!, 'registry-content-rules.json');
      const prevRules = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf-8') : undefined;
      writeFileSync(rulesPath, JSON.stringify([
        { topic_key: 'whatsapp-drafts', thread_id: 9855, require_contains: 'INSTRUCTIONS.md', label: 'Path-0 pointer' },
        { topic_key: 'pa-alerts', thread_id: 3376, forbid_contains: 'Palo Alto', label: 'no hallucinated gloss' },
      ]), 'utf-8');
      try {
        const topicNames = mapWith([
          { chatId: '-100', threadId: 9855, name: 'whatsapp-drafts', description: 'Missing pointer' },
          { chatId: '-100', threadId: 3376, name: 'pa-alerts', description: 'Has Palo Alto text' },
        ]);
        const jobs = createBotMaintenanceJobs(stubDeps({ topicNames }));
        const job = jobs.find((j) => j.name === 'registry-content-watch')!;
        const result = await job.run({ now: Date.now(), everyMs: 86_400_000 });
        assert.equal(result.touched, 2);
        assert.equal((result.detail!.violations as RegistryContentViolation[]).length, 2);
      } finally {
        if (prevRules !== undefined) writeFileSync(rulesPath, prevRules, 'utf-8');
        else rmSync(rulesPath, { force: true });
      }
    });

    it('job integration: alerts via notifyUser with correct dedup key', async () => {
      const topicNames = mapWith([
        { chatId: '-100', threadId: 9855, name: 'whatsapp-drafts', description: 'Missing INSTRUCTIONS.md' },
      ]);
      const jobs = createBotMaintenanceJobs(stubDeps({ topicNames }));
      const job = jobs.find((j) => j.name === 'registry-content-watch')!;
      await assert.doesNotReject(() => job.run({ now: Date.now(), everyMs: 86_400_000 }));
    });

    it('pure check function: skips missing topics (no false violations)', () => {
      const topicNames = mapWith([
        { chatId: '-100', threadId: 1234, name: 'some-other-topic', description: 'Anything' },
      ]);
      const violations = checkRegistryContentInvariants(TEST_RULES, topicNames);
      assert.deepEqual(violations, []);
    });

    it('bound job stays in parity with the pa-side static stub (name/everyMs/host/destructive/shedWhenDegraded)', () => {
      const jobs = createBotMaintenanceJobs(stubDeps());
      const bound = jobs.find((j) => j.name === 'registry-content-watch')!;
      assert.equal(bound.name, registryContentWatchStub.name);
      assert.equal(bound.everyMs, registryContentWatchStub.everyMs);
      assert.equal(bound.host, registryContentWatchStub.host);
      assert.equal(bound.destructive, registryContentWatchStub.destructive);
      assert.equal(bound.shedWhenDegraded, registryContentWatchStub.shedWhenDegraded);
    });
  });

  describe('sweepExpiredPendingActions', () => {
    async function writeTopicFile(name: string, obj: unknown): Promise<void> {
      const path = join(tempDir, name);
      await writeFile(path, JSON.stringify(obj, null, 2), 'utf-8');
    }

    it('expired pending_action is removed from disk; rest of the JSON preserved in saveTopicState format', async () => {
      const turns = [{ role: 'user' as const, content: 'test' }, { role: 'assistant' as const, content: 'response' }];
      const obj = {
        chat_id: 100,
        thread_id: 200,
        turns,
        pending_action: {
          description: 'd',
          proposed_at: new Date(Date.now() - PENDING_ACTION_TTL_MS - 1000).toISOString(),
        },
      };
      await writeTopicFile('telegram-bot-topic-100_200.json', obj);

      const result = await sweepExpiredPendingActions(Date.now());

      const { pending_action: _pa, ...objMinusPa } = obj;
      const raw = await readFile(join(tempDir, 'telegram-bot-topic-100_200.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      assert.deepEqual(parsed, objMinusPa);
      assert.equal(raw, JSON.stringify(objMinusPa, null, 2), 'on-disk format matches saveTopicState spacing');
      assert.equal(result.fresh, 0, 'expired records are not counted');
    });

    it('fresh pending_action (within TTL) is left untouched and counted', async () => {
      const turns = [{ role: 'user' as const, content: 'test' }];
      const obj = {
        chat_id: 100,
        thread_id: 200,
        turns,
        pending_action: {
          description: 'fresh',
          proposed_at: new Date(Date.now() - PENDING_ACTION_TTL_MS + 60_000).toISOString(),
        },
      };
      await writeTopicFile('telegram-bot-topic-100_200.json', obj);

      const result = await sweepExpiredPendingActions(Date.now());

      const raw = await readFile(join(tempDir, 'telegram-bot-topic-100_200.json'), 'utf-8');
      assert.deepEqual(JSON.parse(raw), obj, 'file byte-identical');
      assert.equal(result.fresh, 1, 'fresh record is counted');
    });

    it('pending_action exactly at the TTL boundary is swept (>= semantics, matching expirePendingAction)', async () => {
      const obj = {
        chat_id: 100,
        thread_id: 200,
        turns: [],
        pending_action: {
          description: 'boundary',
          proposed_at: new Date(Date.now() - PENDING_ACTION_TTL_MS).toISOString(),
        },
      };
      await writeTopicFile('telegram-bot-topic-100_200.json', obj);

      const result = await sweepExpiredPendingActions(Date.now());

      const raw = await readFile(join(tempDir, 'telegram-bot-topic-100_200.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.pending_action, undefined, 'expired at boundary is removed');
      assert.equal(result.fresh, 0);
    });

    it('malformed proposed_at is treated as expired: swept and not counted', async () => {
      const obj = {
        chat_id: 100,
        thread_id: 200,
        turns: [],
        pending_action: {
          description: 'malformed',
          proposed_at: 'not-a-date',
        },
      };
      await writeTopicFile('telegram-bot-topic-100_200.json', obj);

      const result = await sweepExpiredPendingActions(Date.now());

      const raw = await readFile(join(tempDir, 'telegram-bot-topic-100_200.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.pending_action, undefined, 'malformed proposed_at is treated as expired');
      assert.equal(result.fresh, 0);
    });

    it('missing proposed_at is treated as expired: swept and not counted', async () => {
      const obj = {
        chat_id: 100,
        thread_id: 200,
        turns: [],
        pending_action: {
          description: 'x',
        },
      };
      await writeTopicFile('telegram-bot-topic-100_200.json', obj);

      const result = await sweepExpiredPendingActions(Date.now());

      const raw = await readFile(join(tempDir, 'telegram-bot-topic-100_200.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.pending_action, undefined, 'missing proposed_at is treated as expired');
      assert.equal(result.fresh, 0);
    });

    it('invalid JSON file is skipped without throwing and counts as 0', async () => {
      await writeFile(join(tempDir, 'telegram-bot-topic-100_200.json'), '{not json', 'utf-8');

      const result = await sweepExpiredPendingActions(Date.now());

      const raw = await readFile(join(tempDir, 'telegram-bot-topic-100_200.json'), 'utf-8');
      assert.equal(raw, '{not json', 'invalid file untouched');
      assert.equal(result.fresh, 0);
    });

    it('file without pending_action is untouched and counts 0', async () => {
      const obj = {
        chat_id: 100,
        thread_id: 200,
        turns: [],
      };
      await writeTopicFile('telegram-bot-topic-100_200.json', obj);

      const result = await sweepExpiredPendingActions(Date.now());

      const raw = await readFile(join(tempDir, 'telegram-bot-topic-100_200.json'), 'utf-8');
      assert.deepEqual(JSON.parse(raw), obj, 'file untouched');
      assert.equal(result.fresh, 0);
    });

    it('mixed population: only fresh records are counted', async () => {
      const freshObj = {
        chat_id: 100,
        thread_id: 200,
        turns: [],
        pending_action: {
          description: 'fresh',
          proposed_at: new Date(Date.now() - PENDING_ACTION_TTL_MS + 60_000).toISOString(),
        },
      };
      await writeTopicFile('telegram-bot-topic-100_200.json', freshObj);

      const expiredObj = {
        chat_id: 100,
        thread_id: 201,
        turns: [],
        pending_action: {
          description: 'expired1',
          proposed_at: new Date(Date.now() - PENDING_ACTION_TTL_MS - 1000).toISOString(),
        },
      };
      await writeTopicFile('telegram-bot-topic-100_201.json', expiredObj);

      const expiredObj2 = {
        chat_id: 100,
        thread_id: 202,
        turns: [],
        pending_action: {
          description: 'expired2',
          proposed_at: new Date(Date.now() - PENDING_ACTION_TTL_MS - 2000).toISOString(),
        },
      };
      await writeTopicFile('telegram-bot-topic-100_202.json', expiredObj2);

      const noneObj = {
        chat_id: 100,
        thread_id: 203,
        turns: [],
      };
      await writeTopicFile('telegram-bot-topic-100_203.json', noneObj);

      const result = await sweepExpiredPendingActions(Date.now());

      const raw1 = await readFile(join(tempDir, 'telegram-bot-topic-100_200.json'), 'utf-8');
      assert.deepEqual(JSON.parse(raw1), freshObj, 'fresh file untouched');

      const raw2 = await readFile(join(tempDir, 'telegram-bot-topic-100_201.json'), 'utf-8');
      const parsed2 = JSON.parse(raw2);
      assert.equal(parsed2.pending_action, undefined, 'expired file 1 swept');

      const raw3 = await readFile(join(tempDir, 'telegram-bot-topic-100_202.json'), 'utf-8');
      const parsed3 = JSON.parse(raw3);
      assert.equal(parsed3.pending_action, undefined, 'expired file 2 swept');

      const raw4 = await readFile(join(tempDir, 'telegram-bot-topic-100_203.json'), 'utf-8');
      assert.deepEqual(JSON.parse(raw4), noneObj, 'no-pending_action file untouched');

      assert.equal(result.fresh, 1, 'only the fresh record is counted');
    });

    it('future-dated proposed_at counts as fresh (negative age, clock-skew stance)', async () => {
      const obj = {
        chat_id: 100,
        thread_id: 200,
        turns: [],
        pending_action: {
          description: 'future',
          proposed_at: new Date(Date.now() + 30_000).toISOString(),
        },
      };
      await writeTopicFile('telegram-bot-topic-100_200.json', obj);

      const result = await sweepExpiredPendingActions(Date.now());

      const raw = await readFile(join(tempDir, 'telegram-bot-topic-100_200.json'), 'utf-8');
      assert.deepEqual(JSON.parse(raw), obj, 'future-dated file untouched');
      assert.equal(result.fresh, 1, 'future-dated record is counted as fresh');
    });

    it('oldestFreshAgeMs is the age of the oldest FRESH record; null when none', async () => {
      const now = Date.now();
      const obj1 = {
        chat_id: 100,
        thread_id: 200,
        turns: [],
        pending_action: {
          description: 'fresh-60s',
          proposed_at: new Date(now - 60_000).toISOString(),
        },
      };
      await writeTopicFile('telegram-bot-topic-100_200.json', obj1);

      const obj2 = {
        chat_id: 100,
        thread_id: 201,
        turns: [],
        pending_action: {
          description: 'fresh-4min',
          proposed_at: new Date(now - 4 * 60_000).toISOString(),
        },
      };
      await writeTopicFile('telegram-bot-topic-100_201.json', obj2);

      const obj3 = {
        chat_id: 100,
        thread_id: 202,
        turns: [],
        pending_action: {
          description: 'expired',
          proposed_at: new Date(now - PENDING_ACTION_TTL_MS - 1000).toISOString(),
        },
      };
      await writeTopicFile('telegram-bot-topic-100_202.json', obj3);

      const result = await sweepExpiredPendingActions(now);
      assert.equal(result.fresh, 2);
      assert.ok(result.oldestFreshAgeMs !== null);
      assert.ok(result.oldestFreshAgeMs! >= 4 * 60_000 - 1000 && result.oldestFreshAgeMs! <= 4 * 60_000 + 1000, 'oldest fresh is ~4min old');

      // Fresh-only file-less case
      await rm(join(tempDir, 'telegram-bot-topic-100_200.json'), { force: true });
      await rm(join(tempDir, 'telegram-bot-topic-100_201.json'), { force: true });
      await rm(join(tempDir, 'telegram-bot-topic-100_202.json'), { force: true });
      const result2 = await sweepExpiredPendingActions(now);
      assert.equal(result2.fresh, 0);
      assert.equal(result2.oldestFreshAgeMs, null);
    });

    it('alert-digest: no digest dir -> touched 0, no throw', async () => {
      const deps = stubDeps();
      const jobs = createBotMaintenanceJobs(deps);
      const job = jobs.find((j) => j.name === 'alert-digest')!;
      const result = await job.run({ now: Date.now(), everyMs: 86_400_000 });
      assert.equal(result.touched, 0);
    });

    it('alert-digest: flushes strictly-before-today files with ONE confirmed send and marks flushedAt', async () => {
      const deps = stubDeps();
      const jobs = createBotMaintenanceJobs(deps);
      const job = jobs.find((j) => j.name === 'alert-digest')!;

      // Setup: delete PA_NOTIFY_DISABLED, write secrets, mock fetch
      const savedDisabled = process.env.PA_NOTIFY_DISABLED;
      delete process.env.PA_NOTIFY_DISABLED;
      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls++;
        return { ok: true } as any;
      };

      try {
        // Write secrets.env
        await writeFile(join(tempDir, 'secrets.env'), 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n', 'utf8');

        // Write yesterday's digest file
        const yesterday = new Date(Date.now() - 24 * 3600_000);
        const yesterdayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
        const digestDir = join(tempDir, 'alert-digest');
        await mkdir(digestDir, { recursive: true });
        await writeFile(join(digestDir, `${yesterdayKey}.json`), JSON.stringify({
          date: yesterdayKey,
          families: {
            'test-family': { count: 2, subject: 'Test alert', firstAt: '2024-01-01T00:00:00.000Z', lastAt: '2024-01-01T01:00:00.000Z' },
          },
        }), 'utf8');

        const result = await job.run({ now: Date.now(), everyMs: 86_400_000 });
        assert.equal(result.touched, 1);
        assert.equal(fetchCalls, 1, 'exactly one fetch call');

        // Verify flushedAt was written
        const digest = JSON.parse(await readFile(join(digestDir, `${yesterdayKey}.json`), 'utf8'));
        assert.ok(typeof digest.flushedAt === 'string');
      } finally {
        if (savedDisabled !== undefined) process.env.PA_NOTIFY_DISABLED = savedDisabled;
        else delete process.env.PA_NOTIFY_DISABLED;
        globalThis.fetch = originalFetch;
      }
    });

    it("alert-digest: today's file is not collected (strictly before today)", async () => {
      const deps = stubDeps();
      const jobs = createBotMaintenanceJobs(deps);
      const job = jobs.find((j) => j.name === 'alert-digest')!;

      const savedDisabled = process.env.PA_NOTIFY_DISABLED;
      delete process.env.PA_NOTIFY_DISABLED;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({ ok: true } as any);

      try {
        await writeFile(join(tempDir, 'secrets.env'), 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n', 'utf8');

        const today = new Date();
        const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const digestDir = join(tempDir, 'alert-digest');
        await mkdir(digestDir, { recursive: true });
        await writeFile(join(digestDir, `${todayKey}.json`), JSON.stringify({
          date: todayKey,
          families: { 'test-family': { count: 1, subject: 'Test', firstAt: '2024-01-01T00:00:00.000Z', lastAt: '2024-01-01T00:00:00.000Z' } },
        }), 'utf8');

        const result = await job.run({ now: Date.now(), everyMs: 86_400_000 });
        assert.equal(result.touched, 0, 'today file not flushed');

        const digest = JSON.parse(await readFile(join(digestDir, `${todayKey}.json`), 'utf8'));
        assert.equal(digest.flushedAt, undefined, 'no flushedAt written for today');
      } finally {
        if (savedDisabled !== undefined) process.env.PA_NOTIFY_DISABLED = savedDisabled;
        else delete process.env.PA_NOTIFY_DISABLED;
        globalThis.fetch = originalFetch;
      }
    });

    it('alert-digest: a failed/short-circuited send does NOT mark flushed (retries next run)', async () => {
      const deps = stubDeps();
      const jobs = createBotMaintenanceJobs(deps);
      const job = jobs.find((j) => j.name === 'alert-digest')!;

      // Default test env has PA_NOTIFY_DISABLED=1
      const yesterday = new Date(Date.now() - 24 * 3600_000);
      const yesterdayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
      const digestDir = join(tempDir, 'alert-digest');
      await mkdir(digestDir, { recursive: true });
      await writeFile(join(digestDir, `${yesterdayKey}.json`), JSON.stringify({
        date: yesterdayKey,
        families: { 'test-family': { count: 1, subject: 'Test', firstAt: '2024-01-01T00:00:00.000Z', lastAt: '2024-01-01T00:00:00.000Z' } },
      }), 'utf8');

      const result = await job.run({ now: Date.now(), everyMs: 86_400_000 });
      assert.equal(result.touched, 0, 'disabled -> no flush');

      const digest = JSON.parse(await readFile(join(digestDir, `${yesterdayKey}.json`), 'utf8'));
      assert.equal(digest.flushedAt, undefined, 'SPEC §1.14: not marked flushed on failed send');
    });

    it('alert-digest: already-flushed file is skipped', async () => {
      const deps = stubDeps();
      const jobs = createBotMaintenanceJobs(deps);
      const job = jobs.find((j) => j.name === 'alert-digest')!;

      const savedDisabled = process.env.PA_NOTIFY_DISABLED;
      delete process.env.PA_NOTIFY_DISABLED;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({ ok: true } as any);

      try {
        await writeFile(join(tempDir, 'secrets.env'), 'TELEGRAM_BOT_TOKEN=tok\nPA_ALERTS_CHAT_ID=-100777\n', 'utf8');

        const yesterday = new Date(Date.now() - 24 * 3600_000);
        const yesterdayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
        const digestDir = join(tempDir, 'alert-digest');
        await mkdir(digestDir, { recursive: true });
        await writeFile(join(digestDir, `${yesterdayKey}.json`), JSON.stringify({
          date: yesterdayKey,
          families: { 'test-family': { count: 1, subject: 'Test', firstAt: '2024-01-01T00:00:00.000Z', lastAt: '2024-01-01T00:00:00.000Z' } },
          flushedAt: '2024-01-01T02:00:00.000Z',
        }), 'utf8');

        const result = await job.run({ now: Date.now(), everyMs: 86_400_000 });
        assert.equal(result.touched, 0, 'already flushed -> skipped');
      } finally {
        if (savedDisabled !== undefined) process.env.PA_NOTIFY_DISABLED = savedDisabled;
        else delete process.env.PA_NOTIFY_DISABLED;
        globalThis.fetch = originalFetch;
      }
    });

    it('alert-digest bound job stays in parity with the pa-side static stub', async () => {
      const jobs = createBotMaintenanceJobs(stubDeps());
      const job = jobs.find((j) => j.name === 'alert-digest')!;
      const { alertDigestJob: stub } = await import('../../../../pa/dist/src/lib/maintenance/jobs/alert-digest.js');
      assert.equal(job.name, stub.name);
      assert.equal(job.host, stub.host);
      assert.equal(job.everyMs, stub.everyMs);
      assert.equal(job.destructive, stub.destructive);
      assert.equal(job.shedWhenDegraded, stub.shedWhenDegraded);
      assert.deepEqual(job.targets, stub.targets);
    });
  });
});
