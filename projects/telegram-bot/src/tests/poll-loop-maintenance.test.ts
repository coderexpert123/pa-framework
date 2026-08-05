import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { mkdtemp, writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { runPollLoop } from '../main.js';
import { _setDegradedForTest } from '../health.js';
import { rmRetry } from './rm-retry.js';
import type { ConversationState } from '../types.js';

// ---------------------------------------------------------------------------
// AI-100 Wave 2: bot poll-loop collapse onto the declared maintenance
// framework (./maintenance-jobs.ts, pa/src/lib/maintenance/runner.ts). These
// tests cover the NEW wiring only — the pre-existing behavioral contracts
// (model-expiry sweep, DLQ handling, graceful shutdown, restart sentinel) are
// covered by poll-loop.test.ts and poll-loop-integration-extra.test.ts, which
// this change must not require editing (verified separately).
// ---------------------------------------------------------------------------

function makeState(chatId = 123, lastUpdateId = -1): ConversationState {
  return { chat_id: chatId, last_update_id: lastUpdateId, thread_id: 0, turns: [] };
}

// Instant sleep for tests — no real waiting.
const fastSleep = async (_ms: number): Promise<void> => {};

const ALL_JOB_NAMES = [
  'bot-log-rotation-check',
  'model-override-sweep',
  'delivered-store-compact',
  'proxy-pool-refresh',
  'dlq-flush',
];

async function readMaintenanceLedger(tempDir: string): Promise<any> {
  const raw = await readFile(join(tempDir, 'maintenance-state.json'), 'utf8');
  return JSON.parse(raw);
}

function okEmptyUpdates(): { ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> } {
  return {
    ok: true, status: 200,
    text: async () => JSON.stringify({ ok: true, result: [] }),
    json: async () => ({ ok: true, result: [] }),
  };
}

function okTrue(): { ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> } {
  return {
    ok: true, status: 200,
    text: async () => JSON.stringify({ ok: true, result: true }),
    json: async () => ({ ok: true, result: true }),
  };
}

// ---------------------------------------------------------------------------
// Ledger wiring: the fire-and-forget pass writes all 5 declared jobs
// ---------------------------------------------------------------------------

describe('runPollLoop: maintenance ledger wiring (AI-100 Wave 2)', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-maint-ledger-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('writes ledger entries for all 5 declared jobs on the very first pass', async () => {
    const controller = new AbortController();
    const state = makeState(123, -1);

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        controller.abort();
        return okEmptyUpdates();
      }
      return okTrue();
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const ledger = await readMaintenanceLedger(tempDir);
    for (const name of ALL_JOB_NAMES) {
      const entry = ledger.jobs[name];
      assert.ok(entry, `expected a ledger entry for '${name}'`);
      assert.ok(
        entry.lastOutcome === 'ran' || entry.lastOutcome === 'skipped',
        `'${name}': unexpected lastOutcome ${entry.lastOutcome}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// DEGRADED shedding: shedWhenDegraded:true jobs skip; false jobs still run
// once they are actually due (isolating "is it due" from "is it shed").
// ---------------------------------------------------------------------------

describe('runPollLoop: maintenance DEGRADED shedding (AI-100 Wave 2)', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;
  const originalDateNow = Date.now;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-maint-degraded-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    Date.now = originalDateNow;
    _setDegradedForTest(false);
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('sheds shedWhenDegraded jobs but still runs dlq-flush/proxy-pool-refresh once due', async () => {
    // dlq-flush, delivered-store-compact and proxy-pool-refresh are cold-start
    // seeded as "just ran" at loop entry (mirrors the old setInterval timers —
    // see runPollLoop's cold-start seeding comment), so on the VERY FIRST pass
    // they read as 'not-due', not proof of anything about shedding. Advance the
    // clock past all of their cadences (proxy-pool-refresh's 30-min default is
    // the long pole) between getUpdates calls so a LATER pass, while still
    // DEGRADED, is the one that actually proves dlq-flush/proxy-pool-refresh
    // run despite DEGRADED (shedWhenDegraded: false) while the other three are
    // shed (shedWhenDegraded: true, which short-circuits before the due check).
    //
    // The kick is a plain time throttle (main.ts's maintenanceKickDueAt) —
    // deliberately NOT gated on whether a previous pass has settled (see
    // that file's comment for why a settlement-gated kick is wrong). A real
    // maintenance pass still takes real wall-clock time even though every fs
    // call in it resolves quickly in isolation (measured ~40ms unloaded on
    // this dev machine for a full 5-job pass) — a getUpdates mock with too
    // little real delay lets loop iterations complete faster than a pass can
    // settle, so runPollLoop's end-of-loop drain (which awaits every
    // in-flight pass via activeMaintenancePasses) has more still-running
    // passes to wait out than intended, and the ledger read below can race
    // ahead of the LAST kicked pass actually writing 'ran'. A real
    // getUpdates call always takes real network time, so this never happens
    // in production.
    //
    // 500ms per iteration, not a smaller value: under full-suite load
    // (many tests' real subprocess/fs work contending for the same CPU/disk)
    // a pass measured at ~40ms in isolation was observed taking long enough
    // that a 50ms delay was NOT sufficient — this is the exact
    // real-process-timing-under-load class already documented elsewhere in
    // this repo (CLAUDE.md: "real-process timing tests need ≥1500ms child
    // lifetimes... shorter children race heartbeat async chains on starved
    // runners"). 5 iterations × 500ms gives >2s of real spacing — several
    // independent chances for a pass to settle and a fresh, correctly-clocked
    // kick to fire, not just one.
    let now = originalDateNow();
    Date.now = () => now;

    const controller = new AbortController();
    const state = makeState(123, -1);
    let getUpdatesCount = 0;

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        await new Promise((r) => setTimeout(r, 500)); // real delay — see comment above
        getUpdatesCount++;
        now += 35 * 60 * 1000;
        if (getUpdatesCount >= 5) controller.abort();
        return okEmptyUpdates();
      }
      return okTrue();
    };

    try {
      _setDegradedForTest(true);
      await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);
    } finally {
      Date.now = originalDateNow;
    }

    // runPollLoop's own bounded drain should already have settled every pass
    // before it returns, but poll briefly anyway for margin on a loaded CI
    // runner (100 * 50ms = 5s).
    let ledger: any;
    for (let i = 0; i < 100; i++) {
      ledger = await readMaintenanceLedger(tempDir).catch(() => null);
      if (ledger?.jobs?.['dlq-flush']?.lastOutcome === 'ran') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(ledger, 'maintenance-state.json must exist');
    assert.equal(ledger.jobs['dlq-flush'].lastOutcome, 'ran', 'dlq-flush must run despite DEGRADED once due (shedWhenDegraded: false)');
    assert.equal(ledger.jobs['proxy-pool-refresh'].lastOutcome, 'ran', 'proxy-pool-refresh must run despite DEGRADED once due (shedWhenDegraded: false)');
    for (const name of ['model-override-sweep', 'delivered-store-compact', 'bot-log-rotation-check']) {
      assert.equal(ledger.jobs[name].lastOutcome, 'skipped', `'${name}' must be shed under DEGRADED`);
      assert.equal(ledger.jobs[name].lastSkipReason, 'degraded', `'${name}' must record 'degraded' as the skip reason`);
    }
  });
});

// ---------------------------------------------------------------------------
// The bounded drain preserves the model-expiry sweep's observable effect
// across the fire-and-forget redesign — the critical regression guard.
// ---------------------------------------------------------------------------

describe('runPollLoop: maintenance drain ordering (AI-100 Wave 2)', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-maint-drain-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('the fire-and-forget model-override sweep still clears an expired preferred_worker by the time runPollLoop resolves', async () => {
    const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const topicState = {
      chat_id: 123,
      thread_id: 0,
      turns: [],
      preferred_worker: 'gemini',
      preferred_worker_set_at: yesterday,
      pinned_status_message_id: 42,
    };
    await writeFile(topicStateFile, JSON.stringify(topicState), 'utf8');

    const controller = new AbortController();
    const state = makeState(123, -1);

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        controller.abort();
        return okEmptyUpdates();
      }
      if ((url as string).includes('sendMessage')) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: true, result: { message_id: 99 } }),
          json: async () => ({ ok: true, result: { message_id: 99 } }),
        };
      }
      return okTrue();
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const saved = JSON.parse(await readFile(topicStateFile, 'utf8')) as ConversationState;
    assert.equal(saved.preferred_worker, undefined, 'the bounded drain must let the fire-and-forget sweep complete before runPollLoop returns');
    assert.equal(saved.model_status?.reason_code, 'midnight_reset');
  });
});

// ---------------------------------------------------------------------------
// Log rotation drives the stop sentinel through the declared job, same as the
// old inline checkBotLogRotation used to.
// ---------------------------------------------------------------------------

describe('runPollLoop: maintenance log rotation (AI-100 Wave 2)', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-maint-rotate-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('an oversized log file drives the loop to write the stop sentinel', async () => {
    await mkdir(join(tempDir, 'logs'), { recursive: true });
    await writeFile(join(tempDir, 'logs', 'telegram-bot.log'), Buffer.alloc(5 * 1024 * 1024 + 1, 'x'));

    const controller = new AbortController();
    const state = makeState(123, -1);
    const sentinelPath = join(tempDir, 'telegram-bot.stop');

    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if ((url as string).includes('getUpdates')) {
        controller.abort();
        return okEmptyUpdates();
      }
      return okTrue();
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep, sentinelPath);

    assert.ok(existsSync(sentinelPath), 'bot-log-rotation-check must have written the stop sentinel');
  });
});

// ---------------------------------------------------------------------------
// Source regression guard: catches a partial/reverted edit even if the
// runtime tests above happen to still pass.
// ---------------------------------------------------------------------------

describe('runPollLoop source regression guard (AI-100 Wave 2)', () => {
  it('main.ts no longer contains the removed inline timer machinery', async () => {
    const here = fileURLToPath(import.meta.url);
    // Compiled test runs from dist/tests/*.test.js (see package.json's "test"
    // script) — three levels up from the compiled file reaches the package
    // root, then back down into the real TypeScript source (not dist).
    const mainTsPath = join(here, '..', '..', '..', 'src', 'main.ts');
    const src = await readFile(mainTsPath, 'utf8');

    for (const needle of ['cleanupExpiredSessions', 'MAINTENANCE_INTERVAL_MS', 'SESSION_GC_INTERVAL_MS', 'checkBotLogRotation']) {
      assert.ok(!src.includes(needle), `main.ts must no longer reference '${needle}'`);
    }
  });
});
