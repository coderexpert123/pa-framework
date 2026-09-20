// Detached poll-loop blocks are tracked in runPollLoop's `inFlight` Set (2026-09-17,
// follow-up to the self-restart in-flight-turn race). The self-restart busy signal
// `pollLoopInFlight` is `() => inFlight.size` and has no outside seam; the getUpdates
// `timeout=` query reads the SAME expression (`inFlight.size > 0 ? 0 : LONG_POLL_TIMEOUT`),
// so it is the observable twin used below. The steer-fold recovery block has no
// behavioural probe (the steer's own turn promise shares the Set, and its only await
// is an ungateable disk read) — it is pinned by the source invariant instead.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'fs/promises';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { runPollLoop, _setExitForTest } from '../main.js';
import { _resetDlqMutexForTest } from '../dlq.js';
import type { ConversationState } from '../types.js';
import { rmRetry } from './rm-retry.js';
import { waitForDrain } from './test-teardown-guard.js';

// runPollLoop's natural exit calls process.exit(0) otherwise — the file would go dark.
_setExitForTest(() => {});

const CHAT_ID = -1001234567890;
const THREAD_ID = 5001;

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
}

describe('runPollLoop: the detached /stop block is tracked in inFlight', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-detached-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await waitForDrain();
    _resetDlqMutexForTest();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('a pending /stop reply keeps inFlight non-empty (next getUpdates short-polls) and lands before runPollLoop returns', async () => {
    const controller = new AbortController();
    const state: ConversationState = { chat_id: CHAT_ID, last_update_id: -1, thread_id: THREAD_ID, turns: [] };
    const stopUpdate = {
      update_id: 1,
      message: {
        message_id: 101,
        chat: { id: CHAT_ID, type: 'supergroup' },
        message_thread_id: THREAD_ID,
        date: Math.floor(Date.now() / 1000),
        text: '/stop',
      },
    };
    // Holds the stop block's reply send open until the SECOND getUpdates, so the
    // block is provably still pending when that poll computes its timeout.
    let releaseStopReply!: () => void;
    const stopReplyGate = new Promise<void>((resolve) => { releaseStopReply = resolve; });
    const getUpdatesUrls: string[] = [];
    let stopReplyDelivered = false;

    (globalThis as Record<string, unknown>).fetch = async (url: string, init?: { body?: string }) => {
      const u = String(url);
      if (u.includes('getUpdates')) {
        getUpdatesUrls.push(u);
        if (getUpdatesUrls.length === 1) return jsonResponse({ ok: true, result: [stopUpdate] });
        controller.abort();
        releaseStopReply();
        return jsonResponse({ ok: true, result: [] });
      }
      if (u.includes('sendMessage') && String(init?.body ?? '').includes('Nothing is running in this topic')) {
        await stopReplyGate;
        stopReplyDelivered = true;
      }
      return jsonResponse({ ok: true, result: { message_id: 999 } });
    };

    await runPollLoop('token', [CHAT_ID], state, {}, controller.signal, async () => {});

    assert.ok(getUpdatesUrls.length >= 2, `expected 2+ getUpdates calls, got ${getUpdatesUrls.length}`);
    assert.ok(getUpdatesUrls[0].includes('timeout=30'), `first getUpdates (idle) must long-poll; got: ${getUpdatesUrls[0]}`);
    assert.ok(
      getUpdatesUrls[1].includes('timeout=0'),
      `the /stop block must be in inFlight while its reply is pending (second getUpdates must short-poll); got: ${getUpdatesUrls[1]}`,
    );
    assert.equal(stopReplyDelivered, true, 'the test-mode shutdown drain must await the tracked /stop block, so its reply has landed');
  });
});

describe('runPollLoop source invariant: no untracked detached block', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/tests -> dist -> projects/telegram-bot -> src/main.ts
  const mainSrc = readFileSync(join(here, '..', '..', 'src', 'main.ts'), 'utf8');
  // WP-4 moved the steer-recovery tracking to steer-exec.ts (the injected
  // inFlight set — same 2026-09-17 invariant, one implementation): the
  // steerRecoveryP pins below read THAT source now, plus a pin that
  // runPollLoop actually hands the set to executeSteer.
  const steerExecSrc = readFileSync(join(here, '..', '..', 'src', 'steer-exec.ts'), 'utf8');

  it('runPollLoop has no `void (async` block and tracks the stop promise', () => {
    const start = mainSrc.indexOf('export async function runPollLoop(');
    assert.notEqual(start, -1, 'runPollLoop must exist in main.ts');
    const next = mainSrc.indexOf('\nexport ', start + 1);
    assert.notEqual(next, -1, 'an export must follow runPollLoop (body slice end)');
    const body = mainSrc.slice(start, next);
    assert.doesNotMatch(body, /void \(async/, 'a detached `void (async` block in runPollLoop is invisible to pollLoopInFlight — track it in inFlight');
    for (const name of ['stopP', 'cbP', 'mrP']) {
      assert.ok(body.includes(`inFlight.add(${name});`), `runPollLoop must add ${name} to inFlight`);
      assert.ok(body.includes(`.finally(() => { inFlight.delete(${name}); });`), `runPollLoop must remove ${name} from inFlight on settle`);
    }
    assert.ok(body.includes('executeSteer({'), 'runPollLoop must route /steer through the shared executeSteer mechanics');
    assert.ok(body.includes('inFlight,'), 'runPollLoop must pass the inFlight set into executeSteer for the detached kill/recovery tracking');
  });

  it('executeSteer tracks its detached kill and steer-recovery promises in the injected inFlight set', () => {
    assert.ok(
      steerExecSrc.includes('if (inFlight) inFlight.add(killP);'),
      'executeSteer must add the detached kill promise to the injected inFlight set',
    );
    assert.ok(
      steerExecSrc.includes('if (inFlight) inFlight.add(steerRecoveryP);'),
      'executeSteer must add steerRecoveryP to the injected inFlight set (moved from runPollLoop, WP-4)',
    );
    assert.ok(
      steerExecSrc.includes('if (inFlight) inFlight.delete(steerRecoveryP);'),
      'executeSteer must remove steerRecoveryP from the injected inFlight set on settle',
    );
  });
});
