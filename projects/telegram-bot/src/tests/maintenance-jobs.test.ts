import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBotMaintenanceJobs, watchdogStaleJobs, checkRegistryContentInvariants, type BotMaintenanceDeps, type RegistryContentViolation } from '../maintenance-jobs.js';
import type { RegistryContentRule } from '../registry-content-rules.js';
import { validateRegistry } from '../../../../pa/dist/src/lib/maintenance/policy.js';
import { registryContentWatchJob as registryContentWatchStub } from '../../../../pa/dist/src/lib/maintenance/jobs/registry-content-watch.js';
import { RUNTIME_ARCHIVE_MAX_BYTES } from '../../../../pa/dist/src/lib/archive-files.js';
import { flushLog } from '../../../../pa/dist/src/lib/log.js';
import { loadJobState, updateJobState } from '../../../../pa/dist/src/lib/maintenance/state.js';
import type { TopicNameMap } from '../topic-names.js';

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
      'bot-log-rotation-check',
      'bot-self-restart',
      'dashboard-refresh',
      'delivered-store-compact',
      'dlq-flush',
      'grounding-check',
      'model-override-sweep',
      'proxy-pool-refresh',
      'registry-content-watch',
      'requeue-drain',
    ]);
    for (const j of jobs) assert.equal(j.host, 'bot');
  });

  it('orders bot-log-rotation-check first, dashboard-refresh after registry-content-watch, dlq-flush last', () => {
    const jobs = createBotMaintenanceJobs(stubDeps());
    assert.equal(jobs[0].name, 'bot-log-rotation-check');
    assert.equal(jobs[jobs.length - 1].name, 'dlq-flush');
    assert.equal(jobs[jobs.length - 2].name, 'bot-self-restart');
    assert.equal(jobs[jobs.length - 3].name, 'requeue-drain');
    const registryIdx = jobs.findIndex((j) => j.name === 'registry-content-watch');
    const dashboardIdx = jobs.findIndex((j) => j.name === 'dashboard-refresh');
    assert.equal(dashboardIdx, registryIdx + 1, 'dashboard-refresh immediately follows registry-content-watch');
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
    assert.equal(byName.get('registry-content-watch')!.shedWhenDegraded, true);
    assert.equal(byName.get('dashboard-refresh')!.shedWhenDegraded, true);
    assert.equal(byName.get('requeue-drain')!.shedWhenDegraded, false);
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
    assert.equal(byName.get('registry-content-watch')!.everyMs, 86_400_000);
    assert.equal(byName.get('dashboard-refresh')!.everyMs, 1_800_000);
    assert.equal(byName.get('requeue-drain')!.everyMs, 300_000);
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

  it('requeue-drain.run() invokes the injected drain and reports touched', async () => {
    let calls = 0;
    const deps = stubDeps({
      requeueDrain: async () => {
        calls++;
        return 3;
      },
    });
    const jobs = createBotMaintenanceJobs(deps);
    const job = jobs.find((j) => j.name === 'requeue-drain')!;
    const result = await job.run({ now: Date.now(), everyMs: 300_000 });
    assert.equal(result.touched, 3);
    assert.equal(calls, 1);
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
});
